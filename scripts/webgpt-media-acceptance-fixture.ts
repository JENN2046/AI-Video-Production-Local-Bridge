import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const FIXTURE_VERSION = "readonly-media-acceptance-fixture-v1";
const RUN_ID = /^run_[0-9a-f]{32}$/;

class FixtureError extends Error {
  constructor(readonly code: string) { super(code); }
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value || value.startsWith("--")) throw new FixtureError("MEDIA_ACCEPTANCE_ARGUMENT_REQUIRED");
  return value;
}

function safeHttps(value: string, expectedPath?: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new FixtureError("MEDIA_ACCEPTANCE_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (expectedPath && url.pathname !== expectedPath)) {
    throw new FixtureError("MEDIA_ACCEPTANCE_URL_INVALID");
  }
  return url.toString();
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function assertRegularSource(path: string): Promise<{ sha256: string; size: number; mtimeMs: number }> {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new FixtureError("MEDIA_ACCEPTANCE_SOURCE_UNSAFE");
  const before = statSync(path);
  if (!before.isFile() || before.size <= 0 || before.size > 2 * 1024 * 1024 * 1024) throw new FixtureError("MEDIA_ACCEPTANCE_SOURCE_INVALID");
  if (!path.toLowerCase().endsWith(".mp4")) throw new FixtureError("MEDIA_ACCEPTANCE_SOURCE_INVALID");
  const sha256 = await sha256File(path);
  const after = statSync(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new FixtureError("MEDIA_ACCEPTANCE_SOURCE_CHANGED");
  }
  return { sha256, size: before.size, mtimeMs: before.mtimeMs };
}

async function assertSourceUnchanged(path: string, before: { sha256: string; size: number; mtimeMs: number }): Promise<void> {
  const after = await assertRegularSource(path);
  if (after.sha256 !== before.sha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new FixtureError("MEDIA_ACCEPTANCE_SOURCE_CHANGED");
  }
}

function acceptanceRoot(): string {
  const workspace = resolve(process.cwd());
  const root = resolve(workspace, "data", "webgpt", "media-acceptance");
  const rel = relative(workspace, root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  const workspaceReal = realpathSync(workspace);
  let cursor = dirname(root);
  while (!existsSync(cursor)) cursor = dirname(cursor);
  const cursorReal = realpathSync(cursor);
  const realRel = relative(workspaceReal, cursorReal);
  if (realRel.startsWith("..") || isAbsolute(realRel) || lstatSync(cursor).isSymbolicLink()) {
    throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  let component = workspace;
  for (const part of rel.split(/[\\/]+/)) {
    component = join(component, part);
    if (existsSync(component) && lstatSync(component).isSymbolicLink()) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", root], { cwd: workspace, windowsHide: true });
  if (ignored.status !== 0) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_NOT_IGNORED");
  return root;
}

function runRoot(runId: string): string {
  if (!RUN_ID.test(runId)) throw new FixtureError("MEDIA_ACCEPTANCE_RUN_ID_INVALID");
  const root = acceptanceRoot();
  const target = resolve(root, runId);
  if (relative(root, target).startsWith("..")) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  if (existsSync(target)) assertSafeExistingPath(root, target, "directory");
  return target;
}

function assertSafeExistingPath(root: string, target: string, kind: "directory" | "file"): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if ((rel && rel.startsWith("..")) || isAbsolute(rel) || !existsSync(resolvedRoot) || !existsSync(resolvedTarget)) {
    throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  let cursor = resolvedRoot;
  const components = rel ? rel.split(/[\\/]+/) : [];
  for (const part of ["", ...components]) {
    if (part) cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  const rootReal = realpathSync(resolvedRoot);
  const targetReal = realpathSync(resolvedTarget);
  const realRel = relative(rootReal, targetReal);
  if ((realRel && realRel.startsWith("..")) || isAbsolute(realRel)) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  const targetStat = lstatSync(resolvedTarget);
  if ((kind === "directory" && !targetStat.isDirectory()) || (kind === "file" && !targetStat.isFile())) {
    throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  return resolvedTarget;
}

function logicalManifest(db: import("../src/storage/sqlite.js").M0Database): string {
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  const payload = tables.map((name) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new FixtureError("MEDIA_ACCEPTANCE_DATABASE_INVALID");
    const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    return { name, rows: rows.map((row) => JSON.parse(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

type Manifest = {
  fixture_version: typeof FIXTURE_VERSION;
  run_id: string;
  database_file: "app.sqlite";
  project_id: string;
  shot_id: string;
  artifact_id: string;
  blob_id: string;
  issuer_hash: string;
  resource_url: string;
  media_relative_path: string;
  media_sha256: string;
  database_manifest: string;
};

type JsonObject = Record<string, unknown>;

type GatewayProfile = {
  profile_version: "readonly-media-operations-profile-v1";
  database_path: string;
  issuer_hash: string;
  allowed_origin: string;
  gateway_port: 2092;
  media_roots: string[];
  capability_key: {
    kid: string;
    protected_path: string;
    previous?: {
      kid: string;
      protected_path: string;
      accepted_from: string;
      accepted_until: string;
    } | null;
  };
  cloudflared: {
    executable_path: string;
    manifest_path: string;
    protected_token_path: string;
    public_health_url: "https://media.skmt617.top/healthz";
  };
  runtime_directory: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function workspaceRelative(path: string): string {
  const value = relative(resolve(process.cwd()), resolve(path));
  if (!value || value.startsWith("..") || isAbsolute(value)) throw new FixtureError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  return value.replaceAll("\\", "/");
}

function readJsonObject(path: string, code: string): JsonObject {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new FixtureError(code);
  }
}

function readManifest(root: string, runId: string): Manifest {
  const manifestPath = join(root, "fixture.json");
  if (!existsSync(manifestPath)) throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_NOT_FOUND");
  const value = readJsonObject(assertSafeExistingPath(root, manifestPath, "file"), "MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  const expectedKeys = ["artifact_id", "blob_id", "database_file", "database_manifest", "fixture_version", "issuer_hash", "media_relative_path", "media_sha256", "project_id", "resource_url", "run_id", "shot_id"];
  if (!hasExactKeys(value, expectedKeys) || value.fixture_version !== FIXTURE_VERSION || value.run_id !== runId || value.database_file !== "app.sqlite") {
    throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  for (const key of ["project_id", "shot_id", "artifact_id", "blob_id", "media_relative_path"] as const) {
    if (typeof value[key] !== "string" || value[key].length < 1) throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  for (const key of ["issuer_hash", "media_sha256", "database_manifest"] as const) {
    if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/.test(value[key])) throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  if (typeof value.resource_url !== "string") throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  safeHttps(value.resource_url, "/mcp");
  return value as Manifest;
}

function parseGatewayProfile(value: JsonObject, manifest: Manifest): GatewayProfile {
  const rootKeys = ["profile_version", "database_path", "issuer_hash", "allowed_origin", "gateway_port", "media_roots", "capability_key", "cloudflared", "runtime_directory"];
  if (!hasExactKeys(value, rootKeys) || value.profile_version !== "readonly-media-operations-profile-v1" || value.gateway_port !== 2092 || value.issuer_hash !== manifest.issuer_hash) {
    throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
  }
  if (typeof value.allowed_origin !== "string" || value.allowed_origin !== new URL(manifest.resource_url).origin || typeof value.database_path !== "string" || typeof value.runtime_directory !== "string") {
    throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
  }
  if (!Array.isArray(value.media_roots) || value.media_roots.length < 1 || value.media_roots.some((item) => typeof item !== "string" || !item)) {
    throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
  }
  if (!isObject(value.capability_key) || !isObject(value.cloudflared)) throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
  const capabilityKeys = value.capability_key.previous === undefined ? ["kid", "protected_path"] : ["kid", "protected_path", "previous"];
  if (!hasExactKeys(value.capability_key, capabilityKeys) || typeof value.capability_key.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.capability_key.kid) || typeof value.capability_key.protected_path !== "string" || !value.capability_key.protected_path) {
    throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
  }
  if (value.capability_key.previous !== undefined && value.capability_key.previous !== null) {
    if (!isObject(value.capability_key.previous) || !hasExactKeys(value.capability_key.previous, ["kid", "protected_path", "accepted_from", "accepted_until"])) {
      throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
    }
    const previous = value.capability_key.previous;
    if (typeof previous.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(previous.kid) || previous.kid === value.capability_key.kid || typeof previous.protected_path !== "string" || !previous.protected_path || typeof previous.accepted_from !== "string" || typeof previous.accepted_until !== "string") {
      throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
    }
    const from = new Date(previous.accepted_from);
    const until = new Date(previous.accepted_until);
    if (!Number.isFinite(from.valueOf()) || !Number.isFinite(until.valueOf()) || from.toISOString() !== previous.accepted_from || until.toISOString() !== previous.accepted_until || until <= from || until.valueOf() - from.valueOf() > 10 * 60_000) {
      throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
    }
  }
  if (!hasExactKeys(value.cloudflared, ["executable_path", "manifest_path", "protected_token_path", "public_health_url"]) || value.cloudflared.public_health_url !== "https://media.skmt617.top/healthz") {
    throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
  }
  for (const key of ["executable_path", "manifest_path", "protected_token_path"] as const) {
    if (typeof value.cloudflared[key] !== "string" || !value.cloudflared[key]) throw new FixtureError("MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID");
  }
  return value as GatewayProfile;
}

async function createProfiles(): Promise<void> {
  const runId = arg("--run");
  const root = runRoot(runId);
  if (!existsSync(root)) throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_NOT_FOUND");
  const manifest = readManifest(root, runId);
  const workspace = resolve(process.cwd());
  const publisherTemplatePath = assertSafeExistingPath(workspace, resolve(arg("--publisher-template")), "file");
  const gatewayTemplatePath = assertSafeExistingPath(workspace, resolve(arg("--gateway-template")), "file");
  const publisherTemplate = readJsonObject(publisherTemplatePath, "MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID");
  const gatewayTemplate = parseGatewayProfile(readJsonObject(gatewayTemplatePath, "MEDIA_ACCEPTANCE_GATEWAY_TEMPLATE_INVALID"), manifest);
  const [{ parseReadonlyPublisherProfile }, { issuerHash }] = await Promise.all([
    import("../src/webgpt-cloud/publisher.js"),
    import("../src/webgpt-v4/types.js")
  ]);
  let publisher: ReturnType<typeof parseReadonlyPublisherProfile>;
  try {
    publisher = parseReadonlyPublisherProfile(publisherTemplate);
  } catch {
    throw new FixtureError("MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID");
  }
  if (publisher.resource_url !== manifest.resource_url || issuerHash(publisher.issuer) !== manifest.issuer_hash) {
    throw new FixtureError("MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID");
  }
  const databasePath = assertSafeExistingPath(root, join(root, manifest.database_file), "file");
  const mediaPath = assertSafeExistingPath(root, resolve(root, manifest.media_relative_path), "file");
  const publisherPath = join(root, "publisher-profile.json");
  const gatewayPath = join(root, "gateway-profile.json");
  if (existsSync(publisherPath) || existsSync(gatewayPath)) throw new FixtureError("MEDIA_ACCEPTANCE_PROFILE_EXISTS");
  const generatedPublisher = {
    ...publisher,
    database_path: workspaceRelative(databasePath),
    receipts_directory: workspaceRelative(join(root, "publisher-receipts"))
  };
  try {
    parseReadonlyPublisherProfile(generatedPublisher);
  } catch {
    throw new FixtureError("MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID");
  }
  const generatedGateway: GatewayProfile = {
    ...gatewayTemplate,
    database_path: workspaceRelative(databasePath),
    media_roots: [workspaceRelative(dirname(mediaPath))],
    runtime_directory: workspaceRelative(join(root, "gateway-runtime"))
  };
  parseGatewayProfile(generatedGateway as unknown as JsonObject, manifest);
  let publisherWritten = false;
  try {
    writeFileSync(publisherPath, `${JSON.stringify(generatedPublisher, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    publisherWritten = true;
    writeFileSync(gatewayPath, `${JSON.stringify(generatedGateway, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    if (publisherWritten) rmSync(publisherPath, { force: true });
    throw new FixtureError("MEDIA_ACCEPTANCE_PROFILE_WRITE_FAILED");
  }
  console.log(JSON.stringify({ result: "PASS", action: "profiles", run_id: runId, checks: { publisher_profile: true, gateway_profile: true, git_ignored: true, secret_values_copied: false } }));
}

async function createFixture(): Promise<void> {
  const sourcePath = resolve(arg("--input"));
  const issuer = safeHttps(arg("--issuer"));
  const resourceUrl = safeHttps(arg("--resource"), "/mcp");
  const subject = readFileSync(0, "utf8").trim();
  if (!subject || subject.length > 1024) throw new FixtureError("MEDIA_ACCEPTANCE_SUBJECT_INVALID");
  const sourceBefore = await assertRegularSource(sourcePath);
  const runId = `run_${randomUUID().replaceAll("-", "")}`;
  const root = runRoot(runId);
  if (existsSync(root)) throw new FixtureError("MEDIA_ACCEPTANCE_RUN_EXISTS");
  mkdirSync(root, { recursive: true });
  process.env.AI_VIDEO_WORKSPACE_DATA_ROOT = root;
  process.env.AI_VIDEO_WORKSPACE_DB_PATH = join(root, "app.sqlite");
  let complete = false;
  let phase = "INITIALIZE";
  try {
    const [{ openM0DatabaseConnection }, { runDatabaseMigrations }, projects, artifacts, authorization, authTypes, projection, validity, pathModule] = await Promise.all([
      import("../src/storage/sqlite.js"), import("../src/storage/migrations.js"), import("../src/tools/projects.js"),
      import("../src/tools/mediaArtifacts.js"), import("../src/webgpt-v4/authorizationAdmin.js"), import("../src/webgpt-v4/types.js"),
      import("../src/webgpt-cloud/dataSource.js"), import("../src/tools/mediaValidity.js"), import("../src/paths.js")
    ]);
    phase = "DIRECTORIES";
    pathModule.ensureM0Directories();
    const incomingDir = join(pathModule.paths.mediaRoot, "acceptance-input");
    mkdirSync(incomingDir, { recursive: true });
    const incoming = join(incomingDir, "fixture.mp4");
    copyFileSync(sourcePath, incoming, constants.COPYFILE_EXCL);
    phase = "MP4_VALIDATION";
    const validation = validity.validateMp4File(incoming);
    if (validation.status !== "PASS" || !validation.has_video_stream) throw new FixtureError("MEDIA_ACCEPTANCE_MP4_INVALID");
    const db = openM0DatabaseConnection(process.env.AI_VIDEO_WORKSPACE_DB_PATH);
    let manifest: Manifest;
    try {
      phase = "MIGRATION";
      runDatabaseMigrations(db);
      phase = "PROJECT";
      const created = projects.createProject({
        title: "Readonly media acceptance fixture",
        project_type: "acceptance_fixture",
        brief: { purpose: "readonly_media_acceptance" },
        video_spec: { duration_seconds: Math.max(1, Math.round(validation.duration_seconds ?? 1)), aspect_ratio: "16:9", resolution: "fixture" }
      }, db);
      if (!created.ok) throw new FixtureError("MEDIA_ACCEPTANCE_PROJECT_FAILED");
      db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
      const shotId = `shot_${randomUUID()}`;
      const shot: import("../src/tools/projects.js").Shot = {
        shot_id: shotId, project_id: created.project_id, order: 1, status: "video_generated",
        duration_seconds: Math.max(1, Math.round(validation.duration_seconds ?? 1)), description: "Readonly media playback acceptance",
        storyboard_image_artifact_id: "", video_prompt: "Fixture only", negative_prompt: "", generation_run_ids: [], accepted_clip_artifact_id: "",
        clip_versions: [], review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
      };
      projects.saveShot(db, shot);
      created.project.shot_ids = [shotId];
      created.project.status = "video_review";
      projects.saveProject(db, created.project);
      const storyboard = artifacts.registerMediaArtifact({
        artifact_type: "image", role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
        linked_objects: { project_id: created.project_id, shot_id: shotId }
      }, db);
      if (!storyboard.ok) throw new FixtureError(storyboard.error.code);
      const storyboardAttached = artifacts.attachArtifactToShot({
        project_id: created.project_id, shot_id: shotId, artifact_id: storyboard.artifact.artifact_id,
        reference: "storyboard_image_artifact_id", expected_current_artifact_id: ""
      }, db);
      if (!storyboardAttached.ok) throw new FixtureError(storyboardAttached.error.code);
      phase = "ARTIFACT";
      const registered = artifacts.registerMediaArtifact({
        artifact_type: "video", role: "generated_clip", source: { kind: "provider_output_file", path: incoming, mime_type: "video/mp4" },
        linked_objects: { project_id: created.project_id, shot_id: shotId },
        metadata: { duration_seconds: validation.duration_seconds }
      }, db);
      if (!registered.ok) throw new FixtureError(registered.error.code);
      phase = "SHOT_BINDING";
      const attached = artifacts.attachArtifactToShot({ project_id: created.project_id, shot_id: shotId, artifact_id: registered.artifact.artifact_id, reference: "accepted_clip_artifact_id", expected_current_artifact_id: "" }, db);
      if (!attached.ok) throw new FixtureError(attached.error.code);
      attached.shot.status = "approved";
      attached.shot.clip_versions = [{ artifact_id: registered.artifact.artifact_id, run_id: "run_acceptance_fixture", attempt_number: 1, review_status: "approved" }];
      attached.shot.review = { approval_status: "approved", rejection_reasons: [], latest_revision_instruction: null };
      projects.saveShot(db, attached.shot);
      phase = "AUTHORIZATION";
      const actor = authTypes.actorFromFederatedSubject(issuer, subject, ["projects.read"]);
      authorization.bootstrapWebGptProjectOwner(db, actor.principal_id, created.project_id, "MEDIA_ACCEPTANCE_FIXTURE", actor.issuer_hash!);
      phase = "SNAPSHOT";
      const snapshot = projection.exportReadonlySnapshotFromDatabase({ database_path: process.env.AI_VIDEO_WORKSPACE_DB_PATH, issuer_hash: actor.issuer_hash!, resource_url: resourceUrl });
      const binding = snapshot.projects[0]?.media_bindings.find((item) => item.artifact_id === registered.artifact.artifact_id);
      if (snapshot.projects.length !== 1 || snapshot.schema_version !== "readonly-snapshot-v4" || snapshot.projects[0]?.media_bindings.length !== 2 || !binding) {
        throw new FixtureError("MEDIA_ACCEPTANCE_SNAPSHOT_INVALID");
      }
      const blob = artifacts.getMediaBlob(db, registered.artifact.blob_id);
      if (!blob || blob.integrity_state !== "verified" || blob.detected_mime !== "video/mp4") throw new FixtureError("MEDIA_ACCEPTANCE_BLOB_INVALID");
      manifest = {
        fixture_version: FIXTURE_VERSION, run_id: runId, database_file: "app.sqlite", project_id: created.project_id, shot_id: shotId,
        artifact_id: registered.artifact.artifact_id, blob_id: blob.blob_id, issuer_hash: actor.issuer_hash!, resource_url: resourceUrl,
        media_relative_path: relative(root, blob.storage_uri), media_sha256: blob.sha256, database_manifest: logicalManifest(db)
      };
    } finally { db.close(); }
    rmSync(incomingDir, { recursive: true, force: true });
    phase = "MANIFEST";
    writeFileSync(join(root, "fixture.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await assertSourceUnchanged(sourcePath, sourceBefore);
    complete = true;
    console.log(JSON.stringify({ result: "PASS", action: "create", run_id: runId, checks: { source_unchanged: true, ledger_0008: true, mp4_valid: true, snapshot_v4: true, media_binding: true } }));
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    const stableCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (/^[A-Z][A-Z0-9_]{2,100}$/.test(stableCode)) throw new FixtureError(stableCode);
    throw new FixtureError(`MEDIA_ACCEPTANCE_CREATE_${phase}_FAILED`);
  } finally {
    if (!complete) rmSync(root, { recursive: true, force: true });
  }
}

async function verifyFixture(): Promise<void> {
  const runId = arg("--run");
  const issuer = safeHttps(arg("--issuer"));
  const resourceUrl = safeHttps(arg("--resource"), "/mcp");
  const root = runRoot(runId);
  const manifest = readManifest(root, runId);
  if (manifest.resource_url !== resourceUrl) throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  const databasePath = resolve(root, manifest.database_file);
  const mediaPath = resolve(root, manifest.media_relative_path);
  if (!existsSync(databasePath) || !existsSync(mediaPath)) throw new FixtureError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  const safeDatabasePath = assertSafeExistingPath(root, databasePath, "file");
  const safeMediaPath = assertSafeExistingPath(root, mediaPath, "file");
  process.env.AI_VIDEO_WORKSPACE_DATA_ROOT = root;
  process.env.AI_VIDEO_WORKSPACE_DB_PATH = safeDatabasePath;
  const [{ openM0DatabaseConnection }, migrations, projection, authTypes] = await Promise.all([
    import("../src/storage/sqlite.js"), import("../src/storage/migrations.js"), import("../src/webgpt-cloud/dataSource.js"), import("../src/webgpt-v4/types.js")
  ]);
  const issuerHash = authTypes.issuerHash(issuer);
  if (issuerHash !== manifest.issuer_hash || await sha256File(safeMediaPath) !== manifest.media_sha256) throw new FixtureError("MEDIA_ACCEPTANCE_INTEGRITY_FAILED");
  const db = openM0DatabaseConnection(safeDatabasePath, { readOnly: true });
  try {
    migrations.assertSchemaCurrent(db);
    if (logicalManifest(db) !== manifest.database_manifest) throw new FixtureError("MEDIA_ACCEPTANCE_DATABASE_DRIFT");
  } finally { db.close(); }
  const snapshot = projection.exportReadonlySnapshotFromDatabase({ database_path: safeDatabasePath, issuer_hash: issuerHash, resource_url: resourceUrl });
  const binding = snapshot.projects[0]?.media_bindings.find((item) => item.artifact_id === manifest.artifact_id);
  if (snapshot.projects.length !== 1 || snapshot.authorization.principals.length !== 1 || snapshot.schema_version !== "readonly-snapshot-v4" || snapshot.projects[0]?.media_bindings.length !== 2 || binding?.artifact_id !== manifest.artifact_id || binding.sha256 !== manifest.media_sha256) {
    throw new FixtureError("MEDIA_ACCEPTANCE_SNAPSHOT_INVALID");
  }
  console.log(JSON.stringify({ result: "PASS", action: "verify", run_id: runId, checks: { schema: true, database_manifest: true, media_digest: true, snapshot_v4: true, media_binding: true }, project_count: 1, media_binding_count: 2 }));
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "create") return createFixture();
  if (action === "verify") return verifyFixture();
  if (action === "profiles") return createProfiles();
  throw new FixtureError("MEDIA_ACCEPTANCE_ACTION_INVALID");
}

main().catch((error) => {
  const code = error instanceof FixtureError ? error.code : "MEDIA_ACCEPTANCE_FAILED";
  console.error(JSON.stringify({ result: "FAIL", stable_error_code: code }));
  process.exit(1);
});
