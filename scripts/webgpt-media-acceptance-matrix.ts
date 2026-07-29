import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createReadonlyMediaCapabilityRequest, parseReadonlyMediaCapabilityKey } from "../src/webgpt-cloud/mediaCapability.js";
import { exportReadonlySnapshotFromDatabase } from "../src/webgpt-cloud/dataSource.js";
import { openM0DatabaseConnection } from "../src/storage/sqlite.js";
import { revokeWebGptProjectMembership } from "../src/webgpt-v4/authorizationAdmin.js";

const RUN_ID = /^run_[0-9a-f]{32}$/;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const FIXTURE_VERSION = "readonly-media-acceptance-fixture-v2";
const ALLOWED_ORIGIN = "https://aivideo.skmt617.top";
function testTimeout(name: string, fallback: number): number {
  if (process.env.NODE_ENV !== "test") return fallback;
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 50 && value <= 5_000 ? value : fallback;
}

const REQUEST_TIMEOUT_MS = testTimeout("MEDIA_ACCEPTANCE_TEST_REQUEST_TIMEOUT_MS", 15_000);
const MATRIX_TIMEOUT_MS = testTimeout("MEDIA_ACCEPTANCE_TEST_MATRIX_TIMEOUT_MS", 2 * 60_000);

class MatrixError extends Error {
  constructor(readonly code: string) { super(code); }
}

type ManifestMedia = {
  artifact_id: string;
  media_sha256: string;
  mime_type: "image/png" | "image/jpeg" | "video/mp4";
  role: "storyboard_image" | "generated_clip";
};

type ManifestProject = {
  project_id: string;
  media: ManifestMedia[];
};

type Manifest = {
  fixture_version: typeof FIXTURE_VERSION;
  run_id: string;
  database_file: "app.sqlite";
  issuer_hash: string;
  resource_url: string;
  projects: ManifestProject[];
};

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value || value.startsWith("--")) throw new MatrixError("MEDIA_ACCEPTANCE_ARGUMENT_REQUIRED");
  return value;
}

function fixtureRoot(runId: string): string {
  if (!RUN_ID.test(runId)) throw new MatrixError("MEDIA_ACCEPTANCE_RUN_ID_INVALID");
  const workspace = realpathSync(resolve(process.cwd()));
  const root = resolve(workspace, "data", "webgpt", "media-acceptance", runId);
  const rel = relative(workspace, root);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(root) || lstatSync(root).isSymbolicLink()) {
    throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  let cursor = workspace;
  for (const part of rel.split(/[\\/]+/)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  const real = realpathSync(root);
  const realRel = relative(workspace, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  return real;
}

function readManifest(root: string, runId: string): Manifest {
  const manifestPath = resolve(root, "fixture.json");
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) {
    throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  const manifestReal = realpathSync(manifestPath);
  const manifestRel = relative(realpathSync(root), manifestReal);
  if (!manifestRel || manifestRel.startsWith("..") || isAbsolute(manifestRel)) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  let value: unknown;
  try { value = JSON.parse(readFileSync(manifestReal, "utf8")); } catch {
    throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  const manifest = value as Partial<Manifest>;
  if (manifest.fixture_version !== FIXTURE_VERSION || manifest.run_id !== runId || manifest.database_file !== "app.sqlite"
    || !/^[0-9a-f]{64}$/.test(manifest.issuer_hash ?? "") || typeof manifest.resource_url !== "string"
    || !Array.isArray(manifest.projects) || manifest.projects.length !== 2
    || manifest.projects.some((project) => !project || typeof project.project_id !== "string" || !Array.isArray(project.media)
      || project.media.length !== 2 || project.media.some((media) => !media || typeof media.artifact_id !== "string"
        || !/^[0-9a-f]{64}$/.test(media.media_sha256 ?? "") || !["image/png", "image/jpeg", "video/mp4"].includes(media.mime_type)
        || !["storyboard_image", "generated_clip"].includes(media.role))
      || project.media.filter((media) => media.role === "storyboard_image" && ["image/png", "image/jpeg"].includes(media.mime_type)).length !== 1
      || project.media.filter((media) => media.role === "generated_clip" && media.mime_type === "video/mp4").length !== 1)) {
    throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  const media = manifest.projects.flatMap((project) => project.media);
  if (new Set(media.map((item) => item.artifact_id)).size !== 4 || new Set(media.map((item) => item.media_sha256)).size !== 4) {
    throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  return manifest as Manifest;
}

function gatewayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new MatrixError("MEDIA_ACCEPTANCE_URL_INVALID"); }
  const approvedPublicOrigin = url.origin === "https://media.skmt617.top";
  const approvedLoopbackOrigin = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!approvedPublicOrigin && !approvedLoopbackOrigin) {
    throw new MatrixError("MEDIA_ACCEPTANCE_URL_INVALID");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new MatrixError("MEDIA_ACCEPTANCE_URL_INVALID");
  return url.origin;
}

async function stdinKey(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 128) throw new MatrixError("MEDIA_CAPABILITY_KEY_INVALID");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new MatrixError("MEDIA_CAPABILITY_KEY_INVALID");
  return value;
}

type BoundedResponse = {
  response: Response;
  json?: Record<string, unknown>;
  byte_length?: number;
};

async function request(
  overallSignal: AbortSignal,
  input: string,
  init: RequestInit = {},
  bodyMode: "none" | "json" | "bytes" = "none"
): Promise<BoundedResponse> {
  const requestSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: AbortSignal.any([overallSignal, requestSignal]) });
    if (bodyMode === "json") {
      let value: unknown;
      try {
        value = await response.json();
      } catch (error) {
        if (overallSignal.aborted || requestSignal.aborted) throw error;
        throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
      return { response, json: value as Record<string, unknown> };
    }
    if (bodyMode === "bytes") return { response, byte_length: (await response.arrayBuffer()).byteLength };
    return { response };
  } catch (error) {
    if (overallSignal.aborted) throw new MatrixError("MEDIA_ACCEPTANCE_MATRIX_TIMEOUT");
    if (requestSignal.aborted) throw new MatrixError("MEDIA_ACCEPTANCE_REQUEST_TIMEOUT");
    if (error instanceof MatrixError) throw error;
    throw new MatrixError("MEDIA_ACCEPTANCE_REQUEST_FAILED");
  }
}

function stableErrorCode(value: Record<string, unknown>): string | null {
  const error = value.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return typeof (error as Record<string, unknown>).code === "string" ? String((error as Record<string, unknown>).code) : null;
}

async function main(): Promise<void> {
  const matrixController = new AbortController();
  const matrixTimer = setTimeout(() => matrixController.abort(), MATRIX_TIMEOUT_MS);
  try {
  const runId = arg("--run");
  const origin = gatewayOrigin(arg("--origin"));
  const kid = arg("--kid");
  const root = fixtureRoot(runId);
  const manifest = readManifest(root, runId);
  const databasePath = resolve(root, manifest.database_file);
  if (!existsSync(databasePath) || lstatSync(databasePath).isSymbolicLink()) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  const encodedKey = await stdinKey();
  const keyring = { active: parseReadonlyMediaCapabilityKey(kid, encodedKey) };
  const snapshot = exportReadonlySnapshotFromDatabase({
    database_path: databasePath,
    issuer_hash: manifest.issuer_hash,
    resource_url: manifest.resource_url
  });
  const principal = snapshot.authorization.principals.find((item) =>
    manifest.projects.every((project) => item.project_ids.includes(project.project_id))
  );
  if (!principal) throw new MatrixError("MEDIA_ACCEPTANCE_AUTHORIZATION_INVALID");

  const requestEnvelope = (project: ManifestProject, media: ManifestMedia, now?: Date) =>
    createReadonlyMediaCapabilityRequest({
      principal_id: principal.principal_id,
      issuer_hash: manifest.issuer_hash,
      project_id: project.project_id,
      artifact_id: media.artifact_id,
      artifact_sha256: media.media_sha256,
      snapshot_fingerprint: snapshot.snapshot_fingerprint
    }, keyring, now ? { now: () => now } : {});

  const issue = async (project: ManifestProject, media: ManifestMedia, now?: Date): Promise<string> => {
    const result = await request(matrixController.signal, `${origin}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(requestEnvelope(project, media, now))
    }, "json");
    const response = result.response;
    if (response.status !== 201) throw new MatrixError("MEDIA_ACCEPTANCE_CAPABILITY_FAILED");
    const handle = result.json?.capability_handle;
    if (typeof handle !== "string" || !HANDLE.test(handle)) throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
    return handle;
  };

  const activate = async (handle: string): Promise<{ capabilityUrl: string; sessionUrl: string }> => {
    const capabilityUrl = `${origin}/media/v1/c/${handle}`;
    const response = (await request(matrixController.signal, capabilityUrl, { headers: { origin: ALLOWED_ORIGIN }, redirect: "manual" })).response;
    const location = response.headers.get("location");
    if (response.status === 403) throw new MatrixError("MEDIA_ACCEPTANCE_ORIGIN_DENIED");
    if (response.status === 404) throw new MatrixError("MEDIA_ACCEPTANCE_CAPABILITY_REJECTED");
    if (response.status === 429) throw new MatrixError("MEDIA_ACCEPTANCE_CAPACITY_EXCEEDED");
    if (response.status !== 302) throw new MatrixError("MEDIA_ACCEPTANCE_ACTIVATION_FAILED");
    if (!location || !/^\/media\/v1\/s\/[A-Za-z0-9_-]{43}$/.test(location)) throw new MatrixError("MEDIA_ACCEPTANCE_REDIRECT_INVALID");
    return { capabilityUrl, sessionUrl: `${origin}${location}` };
  };

  const health = (await request(matrixController.signal, `${origin}/healthz`)).response;
  const ready = (await request(matrixController.signal, `${origin}/readyz`)).response;
  if (health.status !== 200 || ready.status !== 200) throw new MatrixError("MEDIA_ACCEPTANCE_GATEWAY_UNAVAILABLE");

  let revocationSession: string | null = null;
  for (const [projectIndex, project] of manifest.projects.entries()) {
    for (const media of project.media) {
      const activated = await activate(await issue(project, media));
      if (projectIndex === 1 && revocationSession === null) revocationSession = activated.sessionUrl;
      const result = await request(matrixController.signal, activated.sessionUrl, {
        headers: media.mime_type === "video/mp4"
          ? { origin: ALLOWED_ORIGIN, range: "bytes=0-15" }
          : { origin: ALLOWED_ORIGIN }
      }, "bytes");
      const response = result.response;
      if (media.mime_type === "video/mp4") {
        if (response.status !== 206 || response.headers.get("accept-ranges") !== "bytes"
          || !/^bytes 0-15\/\d+$/.test(response.headers.get("content-range") ?? "")
          || response.headers.get("content-type") !== "video/mp4"
          || result.byte_length !== 16) {
          throw new MatrixError("MEDIA_ACCEPTANCE_RANGE_FAILED");
        }
      } else if (response.status !== 200 || response.headers.get("content-type") !== media.mime_type
        || (result.byte_length ?? 0) < 1) {
        throw new MatrixError("MEDIA_ACCEPTANCE_IMAGE_FAILED");
      }
      const replay = await request(matrixController.signal, activated.capabilityUrl, { headers: { origin: ALLOWED_ORIGIN }, redirect: "manual" }, "json");
      if (replay.response.status !== 409 || stableErrorCode(replay.json!) !== "MEDIA_CAPABILITY_REPLAYED") {
        throw new MatrixError("MEDIA_ACCEPTANCE_REPLAY_FAILED");
      }
    }
  }

  const expiredAt = new Date(Date.now() - 10 * 60 * 1000);
  const expired = await request(matrixController.signal, `${origin}/internal/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(requestEnvelope(manifest.projects[0]!, manifest.projects[0]!.media[0]!, expiredAt))
  }, "json");
  if (expired.response.status !== 404 || stableErrorCode(expired.json!) !== "MEDIA_CAPABILITY_INVALID") {
    throw new MatrixError("MEDIA_ACCEPTANCE_EXPIRY_FAILED");
  }

  const revokedProject = manifest.projects[1]!;
  if (!revocationSession) throw new MatrixError("MEDIA_ACCEPTANCE_REVOCATION_FAILED");
  const db = openM0DatabaseConnection(databasePath);
  try {
    if (!revokeWebGptProjectMembership(db, principal.principal_id, revokedProject.project_id, "MEDIA_ACCEPTANCE_REVOCATION").changed) {
      throw new MatrixError("MEDIA_ACCEPTANCE_REVOCATION_FAILED");
    }
  } finally { db.close(); }
  const revoked = await request(matrixController.signal, revocationSession, { headers: { origin: ALLOWED_ORIGIN } }, "json");
  if (revoked.response.status !== 404) throw new MatrixError("MEDIA_ACCEPTANCE_REVOCATION_FAILED");

  const retainedProject = manifest.projects[0]!;
  const retainedMedia = retainedProject.media.find((media) => media.mime_type === "video/mp4")!;
  const retainedSession = await activate(await issue(retainedProject, retainedMedia));
  const retained = await request(matrixController.signal, retainedSession.sessionUrl, { headers: { origin: ALLOWED_ORIGIN, range: "bytes=0-15" } }, "bytes");
  if (retained.response.status !== 206 || retained.byte_length !== 16) throw new MatrixError("MEDIA_ACCEPTANCE_PROJECT_ISOLATION_FAILED");

  console.log(JSON.stringify({
    result: "PASS",
    action: "matrix",
    run_id: runId,
    checks: {
      gateway_ready: true,
      image_200: true,
      mp4_range_206: true,
      project_switch: true,
      capability_replay: true,
      capability_expiry: true,
      membership_revocation: true,
      unaffected_project_retained: true,
      webm_support: false
    }
  }));
  } finally {
    clearTimeout(matrixTimer);
  }
}

main().catch((error) => {
  const code = error instanceof MatrixError ? error.code : "MEDIA_ACCEPTANCE_MATRIX_FAILED";
  console.error(JSON.stringify({ result: "FAIL", stable_error_code: code }));
  process.exit(1);
});
