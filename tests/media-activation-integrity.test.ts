import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { paths } from "../src/paths.js";
import {
  activateLocalMediaArtifact,
  discardMediaActivationMarkers,
  getMediaArtifact,
  getMediaBlob,
  recoverMediaActivations,
  recoverVerifiedBlobStorage,
  registerMediaArtifact,
  verifyMediaArtifactBytes,
  type MediaArtifact,
  type VerifiedBlobStorageRecoveryFaults
} from "../src/tools/mediaArtifacts.js";
import { buildStoryboardApprovedShot, createProject, saveShot } from "../src/tools/projects.js";
import { buildRunningHubMediaUploadRequest } from "../src/tools/videoProviderAdapters.js";

const IMAGE_FIXTURE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");
const VIDEO_FIXTURE = resolve(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4");

function preparedArtifact(artifactId = `artifact_${randomUUID()}`): MediaArtifact {
  return {
    artifact_id: artifactId,
    blob_id: "",
    artifact_type: "image",
    role: "storyboard_image",
    status: "active",
    storage: { uri: resolve(paths.imageArtifactsRoot, `${artifactId}.png`), mime_type: "image/png", filename: `${artifactId}.png` },
    metadata: { width: 0, height: 0, duration_seconds: null, aspect_ratio: "", sha256: "" },
    linked_objects: { project_id: "", shot_id: "" },
    source: { kind: "synthetic_fixture", provider: "", provider_job_id: "", sha256: "", external_url_host: "" }
  };
}

function createRecoveryProjectShot(db: M0Database): { project_id: string; shot_id: string } {
  const created = createProject({ title: `Blob recovery ${randomUUID()}` }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("RECOVERY_PROJECT_SETUP_FAILED");
  const shot = buildStoryboardApprovedShot({
    project_id: created.project_id,
    order: 1,
    duration_seconds: 6,
    storyboard_image_artifact_id: "",
    video_prompt: "Recovery fixture"
  });
  saveShot(db, shot);
  return { project_id: created.project_id, shot_id: shot.shot_id };
}

function createRecoverableVideo(
  db: M0Database,
  mediaRoot: string
): { artifact: MediaArtifact; source_path: string; project_id: string; shot_id: string } {
  const scope = createRecoveryProjectShot(db);
  const artifactId = `artifact_${randomUUID()}`;
  const artifact: MediaArtifact = {
    artifact_id: artifactId,
    blob_id: "",
    artifact_type: "video",
    role: "generated_clip",
    status: "active",
    storage: {
      uri: resolve(mediaRoot, "artifacts", "videos", `${artifactId}.mp4`),
      mime_type: "video/mp4",
      filename: `${artifactId}.mp4`
    },
    metadata: {
      width: 1080,
      height: 1920,
      duration_seconds: 6,
      aspect_ratio: "9:16",
      sha256: ""
    },
    linked_objects: scope,
    source: {
      kind: "provider_output_file",
      provider: "runninghub",
      provider_job_id: `task_${randomUUID()}`,
      sha256: "",
      external_url_host: "fixture.invalid"
    }
  };
  const activated = activateLocalMediaArtifact({
    artifact,
    source_path: VIDEO_FIXTURE,
    media_root: mediaRoot
  }, db);
  assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
  if (!activated.ok) throw new Error("RECOVERY_ARTIFACT_SETUP_FAILED");
  const sourcePath = resolve(mediaRoot, "downloads", `download-${randomUUID()}.mp4`);
  mkdirSync(resolve(sourcePath, ".."), { recursive: true });
  copyFileSync(VIDEO_FIXTURE, sourcePath);
  return { artifact: activated.artifact, source_path: sourcePath, ...scope };
}

function immutableBlobSnapshot(db: M0Database, artifactId: string): {
  blob: Record<string, unknown>;
  links: Array<Record<string, unknown>>;
} {
  const blob = db.prepare(`SELECT blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json
    FROM media_blobs WHERE blob_id = (SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?)`)
    .get(artifactId) as Record<string, unknown>;
  const links = db.prepare("SELECT artifact_id, blob_id FROM media_artifact_blobs WHERE blob_id = ? ORDER BY artifact_id")
    .all(String(blob.blob_id)) as Array<Record<string, unknown>>;
  return { blob: { ...blob }, links: links.map((row) => ({ ...row })) };
}

function verifiedBlobRecoveryStagePath(
  mediaRoot: string,
  blob: { blob_id: string; storage_uri: string }
): string {
  const physicalTargetPath = existsSync(blob.storage_uri)
    ? resolve(realpathSync(blob.storage_uri))
    : resolve(realpathSync(dirname(blob.storage_uri)), basename(blob.storage_uri));
  const storageIdentity = process.platform === "win32"
    ? physicalTargetPath.toLowerCase()
    : physicalTargetPath;
  const digest = createHash("sha256")
    .update(storageIdentity)
    .digest("hex");
  return resolve(mediaRoot, ".activation", "staging", `blob-recovery-${digest}.staged`);
}

function verifiedBlobRecoveryMutexPath(mediaRoot: string, storageUri: string): string {
  const mutexIdentityPath = (value: string): string => {
    const resolvedPath = resolve(value);
    return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  };
  const physicalTargetPath = existsSync(storageUri)
    ? resolve(realpathSync(storageUri))
    : resolve(realpathSync(dirname(storageUri)), basename(storageUri));
  const digest = createHash("sha256")
    .update(mutexIdentityPath(realpathSync(mediaRoot)))
    .update("\0")
    .update(mutexIdentityPath(physicalTargetPath))
    .digest("hex");
  return resolve(mediaRoot, ".activation", "journal", `blob-recovery-target-${digest}.lock.sqlite`);
}

function verifiedBlobRecoveryAuthorityPath(storageUri: string): string {
  const physicalTargetPath = existsSync(storageUri)
    ? resolve(realpathSync(storageUri))
    : resolve(realpathSync(dirname(storageUri)), basename(storageUri));
  const targetIdentity = process.platform === "win32"
    ? physicalTargetPath.toLowerCase()
    : physicalTargetPath;
  const digest = createHash("sha256").update(targetIdentity).digest("hex");
  return resolve(dirname(physicalTargetPath), `.blob-recovery-target-${digest}.authority.json`);
}

function windowsShortPath(filePath: string): string | null {
  if (process.platform !== "win32" || filePath.includes('"')) return null;
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", `for %I in ("${filePath}") do @echo %~sI`],
    { encoding: "utf8", windowsHide: true }
  );
  const candidate = result.status === 0 ? result.stdout.trim() : "";
  return candidate
    && candidate.includes("~")
    && resolve(candidate).toLowerCase() !== resolve(filePath).toLowerCase()
    ? resolve(candidate)
    : null;
}

function hardCrashVerifiedBlobRecovery(input: {
  sqlite_path: string;
  artifact_id: string;
  project_id: string;
  shot_id: string;
  source_path: string;
  crash_at?: "after_staged_copy" | "after_target_authority_temp_created";
}): void {
  const childScript = `
    const { openM0Database } = await import(process.env.RECOVERY_SQLITE_MODULE);
    const { recoverVerifiedBlobStorage } = await import(process.env.RECOVERY_MEDIA_MODULE);
    const db = openM0Database(process.env.RECOVERY_SQLITE_PATH);
    const crashAt = process.env.RECOVERY_CRASH_AT;
    recoverVerifiedBlobStorage({
      invalid_artifact_id: process.env.RECOVERY_ARTIFACT_ID,
      project_id: process.env.RECOVERY_PROJECT_ID,
      shot_id: process.env.RECOVERY_SHOT_ID,
      source_path: process.env.RECOVERY_SOURCE_PATH
    }, db, crashAt === "after_target_authority_temp_created"
      ? { after_target_authority_temp_created: () => process.exit(93) }
      : { after_staged_copy: () => process.exit(91) });
    db.close();
    process.exit(92);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: paths.workspaceRoot,
    env: {
      ...process.env,
      AI_VIDEO_WORKSPACE_DB_PATH: input.sqlite_path,
      RECOVERY_SQLITE_MODULE: pathToFileURL(resolve(paths.workspaceRoot, "dist", "src", "storage", "sqlite.js")).href,
      RECOVERY_MEDIA_MODULE: pathToFileURL(resolve(paths.workspaceRoot, "dist", "src", "tools", "mediaArtifacts.js")).href,
      RECOVERY_SQLITE_PATH: input.sqlite_path,
      RECOVERY_ARTIFACT_ID: input.artifact_id,
      RECOVERY_PROJECT_ID: input.project_id,
      RECOVERY_SHOT_ID: input.shot_id,
      RECOVERY_SOURCE_PATH: input.source_path,
      RECOVERY_CRASH_AT: input.crash_at ?? "after_staged_copy"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  assert.equal(child.error, undefined);
  const expectedStatus = input.crash_at === "after_target_authority_temp_created" ? 93 : 91;
  assert.equal(child.status, expectedStatus, child.stderr || child.stdout || "child did not stop at the requested recovery crash boundary");
}

type ChildRecoveryResult = {
  committed: string[];
  failed: Array<{ activation_id: string; code: string }>;
};

const RECOVERY_SQLITE_MODULE = pathToFileURL(resolve(paths.workspaceRoot, "dist", "src", "storage", "sqlite.js")).href;
const RECOVERY_MEDIA_MODULE = pathToFileURL(resolve(paths.workspaceRoot, "dist", "src", "tools", "mediaArtifacts.js")).href;

function recoveryChildEnvironment(input: {
  configured_path: string;
  in_memory?: boolean;
  started_signal?: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AI_VIDEO_TEST_AUTO_MIGRATE: "true",
    AI_VIDEO_WORKSPACE_DB_PATH: input.configured_path,
    RECOVERY_SQLITE_MODULE,
    RECOVERY_MEDIA_MODULE,
    RECOVERY_IN_MEMORY: input.in_memory ? "true" : "false",
    RECOVERY_STARTED_SIGNAL: input.started_signal ?? ""
  };
}

const STARTUP_RECOVERY_CHILD_SCRIPT = `
  const { writeFileSync } = await import("node:fs");
  const { openM0Database } = await import(process.env.RECOVERY_SQLITE_MODULE);
  const { recoverMediaActivations } = await import(process.env.RECOVERY_MEDIA_MODULE);
  if (process.env.RECOVERY_STARTED_SIGNAL) {
    writeFileSync(process.env.RECOVERY_STARTED_SIGNAL, "started", "utf8");
  }
  const db = process.env.RECOVERY_IN_MEMORY === "true"
    ? openM0Database(":memory:")
    : openM0Database();
  try {
    const result = recoverMediaActivations(db);
    process.stdout.write(JSON.stringify(result));
  } finally {
    db.close();
  }
`;

function runStartupRecoveryChild(input: {
  cwd: string;
  configured_path: string;
  in_memory?: boolean;
}): ChildRecoveryResult {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", STARTUP_RECOVERY_CHILD_SCRIPT], {
    cwd: input.cwd,
    env: recoveryChildEnvironment({
      configured_path: input.configured_path,
      in_memory: input.in_memory
    }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout || "startup recovery child failed");
  return JSON.parse(child.stdout) as ChildRecoveryResult;
}

function startStartupRecoveryChild(input: {
  cwd: string;
  configured_path: string;
  started_signal: string;
}): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "--eval", STARTUP_RECOVERY_CHILD_SCRIPT], {
    cwd: input.cwd,
    env: recoveryChildEnvironment({
      configured_path: input.configured_path,
      started_signal: input.started_signal
    }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function startPausedVerifiedBlobRecovery(input: {
  cwd: string;
  sqlite_path: string;
  artifact_id: string;
  project_id: string;
  shot_id: string;
  source_path: string;
  ready_signal: string;
  release_signal: string;
  pause_at?: "after_staged_copy" | "after_target_mutex_acquired";
}): ChildProcess {
  const childScript = `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { openM0Database } = await import(process.env.RECOVERY_SQLITE_MODULE);
    const { recoverVerifiedBlobStorage } = await import(process.env.RECOVERY_MEDIA_MODULE);
    const db = openM0Database();
    try {
      const pause = () => {
        writeFileSync(process.env.RECOVERY_READY_SIGNAL, "ready", "utf8");
        const deadline = Date.now() + 30000;
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(process.env.RECOVERY_RELEASE_SIGNAL)) {
          if (Date.now() >= deadline) throw new Error("RECOVERY_RELEASE_TIMEOUT");
          Atomics.wait(sleeper, 0, 0, 25);
        }
      };
      const pauseAt = process.env.RECOVERY_PAUSE_AT;
      const result = recoverVerifiedBlobStorage({
        invalid_artifact_id: process.env.RECOVERY_ARTIFACT_ID,
        project_id: process.env.RECOVERY_PROJECT_ID,
        shot_id: process.env.RECOVERY_SHOT_ID,
        source_path: process.env.RECOVERY_SOURCE_PATH
      }, db, pauseAt === "after_target_mutex_acquired"
        ? { after_target_mutex_acquired: pause }
        : { after_staged_copy: pause });
      process.stdout.write(JSON.stringify(result));
    } finally {
      db.close();
    }
  `;
  return spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: input.cwd,
    env: {
      ...process.env,
      AI_VIDEO_WORKSPACE_DB_PATH: input.sqlite_path,
      RECOVERY_SQLITE_MODULE,
      RECOVERY_MEDIA_MODULE,
      RECOVERY_ARTIFACT_ID: input.artifact_id,
      RECOVERY_PROJECT_ID: input.project_id,
      RECOVERY_SHOT_ID: input.shot_id,
      RECOVERY_SOURCE_PATH: input.source_path,
      RECOVERY_READY_SIGNAL: input.ready_signal,
      RECOVERY_RELEASE_SIGNAL: input.release_signal,
      RECOVERY_PAUSE_AT: input.pause_at ?? "after_staged_copy"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function startVerifiedBlobRecovery(input: {
  cwd: string;
  sqlite_path: string;
  artifact_id: string;
  project_id: string;
  shot_id: string;
  source_path: string;
  busy_timeout_ms?: number;
}): ChildProcess {
  const childScript = `
    const { openM0Database } = await import(process.env.RECOVERY_SQLITE_MODULE);
    const { recoverVerifiedBlobStorage } = await import(process.env.RECOVERY_MEDIA_MODULE);
    const db = openM0Database();
    try {
      const result = recoverVerifiedBlobStorage({
        invalid_artifact_id: process.env.RECOVERY_ARTIFACT_ID,
        project_id: process.env.RECOVERY_PROJECT_ID,
        shot_id: process.env.RECOVERY_SHOT_ID,
        source_path: process.env.RECOVERY_SOURCE_PATH
      }, db, process.env.RECOVERY_BUSY_TIMEOUT_MS
        ? { target_mutex_busy_timeout_ms: Number(process.env.RECOVERY_BUSY_TIMEOUT_MS) }
        : {});
      process.stdout.write(JSON.stringify(result));
    } finally {
      db.close();
    }
  `;
  return spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: input.cwd,
    env: {
      ...process.env,
      AI_VIDEO_WORKSPACE_DB_PATH: input.sqlite_path,
      RECOVERY_SQLITE_MODULE,
      RECOVERY_MEDIA_MODULE,
      RECOVERY_ARTIFACT_ID: input.artifact_id,
      RECOVERY_PROJECT_ID: input.project_id,
      RECOVERY_SHOT_ID: input.shot_id,
      RECOVERY_SOURCE_PATH: input.source_path,
      RECOVERY_BUSY_TIMEOUT_MS: input.busy_timeout_ms ? String(input.busy_timeout_ms) : ""
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForSignal(signalPath: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(signalPath)) {
    if (Date.now() >= deadline) throw new Error(`SIGNAL_TIMEOUT: ${basename(signalPath)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function waitForChild(child: ChildProcess, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  return await new Promise((resolveChild, rejectChild) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectChild(new Error("CHILD_PROCESS_TIMEOUT"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveChild({ code, stdout, stderr });
    });
  });
}

function insertUnsafeRecoveryFixture(
  db: M0Database,
  registeredRoot: string,
  targetPath: string,
  sourcePath: string,
  blobId = `blob_recovery_${randomUUID()}`,
  blobBytesPath = VIDEO_FIXTURE
): { artifact: MediaArtifact; source_path: string } {
  const scope = createRecoveryProjectShot(db);
  const bytes = readFileSync(blobBytesPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = `artifact_${randomUUID()}`;
  const artifact: MediaArtifact = {
    artifact_id: artifactId,
    blob_id: blobId,
    artifact_type: "video",
    role: "generated_clip",
    status: "active",
    storage: { uri: resolve(targetPath), mime_type: "video/mp4", filename: "unsafe.mp4" },
    metadata: {
      width: 1080,
      height: 1920,
      duration_seconds: 6,
      aspect_ratio: "9:16",
      sha256
    },
    linked_objects: scope,
    source: {
      kind: "provider_output_file",
      provider: "runninghub",
      provider_job_id: `task_${randomUUID()}`,
      sha256,
      external_url_host: "fixture.invalid"
    }
  };
  db.prepare(`INSERT INTO media_blobs
    (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, 'video/mp4', ?, 'verified', ?)`)
    .run(blobId, sha256, bytes.length, resolve(targetPath), JSON.stringify({
      source: "provider_output_file",
      immutable: true,
      media_root: resolve(registeredRoot)
    }));
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'generated_clip', 'video', 'active', ?)`)
    .run(artifactId, scope.project_id, scope.shot_id, JSON.stringify(artifact));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)")
    .run(artifactId, blobId);
  return { artifact, source_path: sourcePath };
}

test("media activation commits a decoded image through the persistent journal", () => {
  const db = openM0Database(":memory:");
  let finalPath = "";
  try {
    const result = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "app_upload", filename: "declared-wrong.jpg", mime_type: "image/jpeg", bytes_base64: readFileSync(IMAGE_FIXTURE).toString("base64") }
    }, db);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.code);
    if (!result.ok) return;
    finalPath = result.artifact.storage.uri;
    assert.equal(result.artifact.storage.mime_type, "image/png");
    assert.equal(result.artifact.storage.filename.endsWith(".png"), true);
    assert.equal(verifyMediaArtifactBytes(db, result.artifact).ok, true);
    const providerDryRun = buildRunningHubMediaUploadRequest({ storyboard_artifact: result.artifact });
    assert.equal(providerDryRun.ok, true, providerDryRun.ok ? undefined : providerDryRun.error.code);
    const journal = db.prepare("SELECT state, error_code FROM media_activation_journal WHERE artifact_id = ?").get(result.artifact.artifact_id) as { state: string; error_code: string };
    assert.deepEqual({ ...journal }, { state: "committed", error_code: "" });
  } finally {
    db.close();
    if (finalPath) rmSync(finalPath, { force: true });
  }
});

test("activation never overwrites or quarantines a pre-existing final path", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-existing-final-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  try {
    mkdirSync(resolve(artifact.storage.uri, ".."), { recursive: true });
    const existingBytes = Buffer.from("bytes-owned-by-another-artifact", "utf8");
    writeFileSync(artifact.storage.uri, existingBytes, { flag: "wx" });

    const result = activateLocalMediaArtifact({ artifact, source_path: IMAGE_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "MEDIA_ACTIVATION_FINAL_PATH_EXISTS");
    assert.equal(readFileSync(artifact.storage.uri).equals(existingBytes), true);
    const journal = db.prepare("SELECT state, error_code FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { state: string; error_code: string };
    assert.deepEqual({ ...journal }, { state: "failed", error_code: "MEDIA_ACTIVATION_FINAL_PATH_EXISTS" });
    const failedBeforeCheck = db.prepare("SELECT COUNT(*) AS count FROM media_activation_journal WHERE state = 'failed'").get() as { count: number };
    assert.equal(failedBeforeCheck.count, 1);
    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.quarantined_media_activations, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("blob dedupe keeps committed journal paths aligned with the authoritative Blob", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-dedupe-"));
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  let storagePath = "";
  try {
    const first = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    const second = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    storagePath = first.artifact.storage.uri;
    assert.equal(second.artifact.blob_id, first.artifact.blob_id);
    assert.equal(second.artifact.storage.uri, first.artifact.storage.uri);
    const journal = db.prepare("SELECT final_path, artifact_json FROM media_activation_journal WHERE artifact_id = ? AND state = 'committed'").get(second.artifact.artifact_id) as { final_path: string; artifact_json: string };
    assert.equal(journal.final_path, second.artifact.storage.uri);
    assert.equal((JSON.parse(journal.artifact_json) as MediaArtifact).storage.uri, second.artifact.storage.uri);
  } finally {
    db.close();
  }
  try {
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "PASS");
    assert.equal(checked.structured_drift_rows, 0);
  } finally {
    if (storagePath) rmSync(storagePath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("dedupe fails closed and retains new bytes when the existing Blob is invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-invalid-dedupe-"));
  const mediaRoot = join(root, "custom-media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  let existingBlobPath = "";
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  const quarantinePath = join(mediaRoot, ".activation", "quarantine", `${artifact.artifact_id}.png.failed`);
  try {
    const first = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    existingBlobPath = first.artifact.storage.uri;
    writeFileSync(existingBlobPath, Buffer.from("tampered-existing-blob", "utf8"));

    const activated = activateLocalMediaArtifact({ artifact, source_path: IMAGE_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(activated.ok, false);
    if (!activated.ok) assert.equal(activated.error.code, "MEDIA_BLOB_EXISTING_BYTES_INVALID");
    assert.equal(readFileSync(existingBlobPath).toString("utf8"), "tampered-existing-blob");
    assert.equal(existsSync(quarantinePath), true);
    assert.equal(readFileSync(quarantinePath).equals(readFileSync(IMAGE_FIXTURE)), true);
    assert.equal(getMediaArtifact(db, artifact.artifact_id), null);
  } finally {
    db.close();
    if (existingBlobPath) rmSync(existingBlobPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-commit dedupe cleanup failure preserves activation success and recovers later", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-post-commit-cleanup-"));
  const mediaRoot = join(root, "custom-media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  let sharedPath = "";
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  const activationOwnedFinal = artifact.storage.uri;
  try {
    const first = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    sharedPath = first.artifact.storage.uri;

    const activated = activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      remove_post_commit_file: () => { throw new Error("INJECTED_POST_COMMIT_CLEANUP_FAILURE"); }
    }, db);
    assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
    if (!activated.ok) return;
    assert.equal(activated.artifact.storage.uri, sharedPath);
    assert.equal(existsSync(activationOwnedFinal), true);
    const row = db.prepare("SELECT activation_id, state FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string; state: string };
    assert.equal(row.state, "committed");

    const recovered = recoverMediaActivations(db);
    assert.deepEqual(recovered.failed, []);
    assert.equal(existsSync(activationOwnedFinal), false);
    assert.equal(existsSync(sharedPath), true);
    const stored = getMediaArtifact(db, artifact.artifact_id);
    assert.equal(stored ? verifyMediaArtifactBytes(db, stored).ok : false, true);
  } finally {
    db.close();
    if (sharedPath) rmSync(sharedPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery removes an activation-owned duplicate final after Blob dedupe", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-recovery-dedupe-"));
  const mediaRoot = join(root, "custom-media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  let sharedPath = "";
  let activationId = "";
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  const activationOwnedFinal = artifact.storage.uri;
  try {
    const first = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    sharedPath = first.artifact.storage.uri;

    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      after_file_placed: () => { throw new Error("INJECTED_DUPLICATE_ACTIVATION_CRASH"); }
    }, db), /INJECTED_DUPLICATE_ACTIVATION_CRASH/);
    const row = db.prepare("SELECT activation_id, state FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string; state: string };
    activationId = row.activation_id;
    assert.equal(row.state, "file_placed");
    assert.equal(existsSync(activationOwnedFinal), true);
    assert.equal(existsSync(sharedPath), true);

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.committed.includes(activationId), true);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === activationId), false);
    assert.equal(existsSync(activationOwnedFinal), false);
    assert.equal(existsSync(sharedPath), true);
    const stored = getMediaArtifact(db, artifact.artifact_id);
    assert.equal(stored?.storage.uri, sharedPath);
    assert.equal(stored ? verifyMediaArtifactBytes(db, stored).ok : false, true);
  } finally {
    if (activationId) discardMediaActivationMarkers([artifact.artifact_id]);
    db.close();
    if (sharedPath) rmSync(sharedPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("only one non-terminal activation may own an Artifact id", () => {
  const db = openM0Database();
  const artifact = preparedArtifact();
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      after_file_placed: () => { throw new Error("INJECTED_MEDIA_ACTIVATION_CRASH"); }
    }, db), /INJECTED_MEDIA_ACTIVATION_CRASH/);
    const duplicate = activateLocalMediaArtifact({ artifact: structuredClone(artifact), source_path: IMAGE_FIXTURE }, db);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "MEDIA_ACTIVATION_ALREADY_PENDING");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_activation_journal WHERE artifact_id = ? AND state IN ('staged','file_placed')").get(artifact.artifact_id) as { count: number }).count, 1);
    assert.equal(existsSync(artifact.storage.uri), true);
  } finally {
    try { recoverMediaActivations(db); } catch { /* assertions above retain the primary failure */ }
    discardMediaActivationMarkers([artifact.artifact_id]);
    db.close();
  }
});

test("a retry cannot overwrite bytes owned by a staged journal", () => {
  const db = openM0Database();
  const artifact = preparedArtifact();
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      after_journal_staged: () => { throw new Error("INJECTED_AFTER_JOURNAL_STAGED"); }
    }, db), /INJECTED_AFTER_JOURNAL_STAGED/);
    const row = db.prepare("SELECT activation_id, staging_path, state FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string; staging_path: string; state: string };
    assert.equal(row.state, "staged");
    const originalBytes = readFileSync(row.staging_path);

    const retry = activateLocalMediaArtifact({ artifact: structuredClone(artifact), source_path: IMAGE_FIXTURE }, db);
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.error.code, "MEDIA_ACTIVATION_ALREADY_PENDING");
    assert.equal(readFileSync(row.staging_path).equals(originalBytes), true);

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.committed.includes(row.activation_id), true);
    const stored = getMediaArtifact(db, artifact.artifact_id);
    assert.equal(stored ? verifyMediaArtifactBytes(db, stored).ok : false, true);
  } finally {
    db.close();
  }
});

test("recovery removes staging bytes that crashed before journal creation", () => {
  const db = openM0Database();
  const artifact = preparedArtifact();
  const stagingOwnerNamesBefore = new Set(existsSync(paths.mediaActivationJournalRoot)
    ? readdirSync(paths.mediaActivationJournalRoot).filter((name) => name.startsWith("staging-owner-"))
    : []);
  let stagingPath = "";
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      after_staging_written: (path) => {
        stagingPath = path;
        throw new Error("INJECTED_BEFORE_JOURNAL_CREATION");
      }
    }, db), /INJECTED_BEFORE_JOURNAL_CREATION/);
    assert.equal(existsSync(stagingPath), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { count: number }).count, 0);

    const blocked = activateLocalMediaArtifact({ artifact: structuredClone(artifact), source_path: IMAGE_FIXTURE }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_ACTIVATION_ALREADY_PENDING");

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.code === "MEDIA_ACTIVATION_DB_RECORD_MISSING"), true);
    assert.equal(existsSync(stagingPath), false);
    const remainingOwners = existsSync(paths.mediaActivationJournalRoot)
      ? readdirSync(paths.mediaActivationJournalRoot).filter((name) => name.startsWith("staging-owner-") && !stagingOwnerNamesBefore.has(name))
      : [];
    assert.deepEqual(remainingOwners, []);

    const retry = activateLocalMediaArtifact({ artifact: structuredClone(artifact), source_path: IMAGE_FIXTURE }, db);
    assert.equal(retry.ok, true, retry.ok ? undefined : retry.error.code);
    if (retry.ok) assert.equal(verifyMediaArtifactBytes(db, retry.artifact).ok, true);
  } finally {
    db.close();
    rmSync(artifact.storage.uri, { force: true });
    if (stagingPath) rmSync(stagingPath, { force: true });
  }
});

test("a partial staging file keeps its owner until recovery clears both", () => {
  const db = openM0Database();
  const artifact = preparedArtifact();
  const stagingPath = resolve(paths.mediaActivationStagingRoot, `${artifact.artifact_id}.png.stage`);
  try {
    mkdirSync(paths.mediaActivationStagingRoot, { recursive: true });
    writeFileSync(stagingPath, Buffer.from("partial-staging-write", "utf8"), { flag: "wx" });
    const blocked = activateLocalMediaArtifact({ artifact, source_path: IMAGE_FIXTURE }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_ACTIVATION_ALREADY_PENDING");
    assert.equal(existsSync(stagingPath), true);

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.code === "MEDIA_ACTIVATION_DB_RECORD_MISSING"), true);
    assert.equal(existsSync(stagingPath), false);

    const retry = activateLocalMediaArtifact({ artifact: structuredClone(artifact), source_path: IMAGE_FIXTURE }, db);
    assert.equal(retry.ok, true, retry.ok ? undefined : retry.error.code);
  } finally {
    db.close();
    rmSync(stagingPath, { force: true });
    rmSync(artifact.storage.uri, { force: true });
  }
});

test("interrupted file placement is recovered without creating a second Artifact", () => {
  const db = openM0Database();
  const artifact = preparedArtifact();
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      after_file_placed: () => { throw new Error("INJECTED_MEDIA_ACTIVATION_CRASH"); }
    }, db), /INJECTED_MEDIA_ACTIVATION_CRASH/);
    assert.equal(getMediaArtifact(db, artifact.artifact_id), null);
    assert.equal((db.prepare("SELECT state FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { state: string }).state, "file_placed");
    const activationId = (db.prepare("SELECT activation_id FROM media_activation_journal WHERE artifact_id = ? AND state = 'file_placed'").get(artifact.artifact_id) as { activation_id: string }).activation_id;
    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === activationId), false);
    assert.equal(recovered.committed.includes(activationId), true);
    const stored = getMediaArtifact(db, artifact.artifact_id);
    assert.equal(stored?.status, "active");
    assert.equal(stored ? verifyMediaArtifactBytes(db, stored).ok : false, true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE artifact_id = ?").get(artifact.artifact_id) as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test("recovery advances a staged journal when the file already reached pending", () => {
  const db = openM0Database();
  const artifact = preparedArtifact();
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      after_pending_placed: () => { throw new Error("INJECTED_AFTER_PENDING_RENAME"); }
    }, db), /INJECTED_AFTER_PENDING_RENAME/);
    const row = db.prepare("SELECT activation_id, state, pending_path FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string; state: string; pending_path: string };
    assert.equal(row.state, "staged");
    assert.equal(existsSync(row.pending_path), true);

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === row.activation_id), false);
    assert.equal(recovered.committed.includes(row.activation_id), true);
    const stored = getMediaArtifact(db, artifact.artifact_id);
    assert.equal(stored ? verifyMediaArtifactBytes(db, stored).ok : false, true);
  } finally {
    db.close();
  }
});

test("verified Blob provenance preserves a caller-controlled custom media root", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-custom-root-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  try {
    const activated = activateLocalMediaArtifact({ artifact, source_path: IMAGE_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
    if (!activated.ok) return;
    const verified = verifyMediaArtifactBytes(db, activated.artifact);
    assert.equal(verified.ok, true, verified.ok ? undefined : verified.error.code);
    if (verified.ok) assert.equal(verified.blob.provenance.media_root, resolve(mediaRoot));
  } finally {
    db.close();
  }
  try {
    assert.equal(checkDatabase(sqlitePath).result, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation rejects symlinked activation roots and immediate subdirectories", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-symlink-root-"));
  const outside = join(root, "outside");
  const mediaRoot = join(root, "media");
  const activationPath = join(mediaRoot, ".activation");
  const stagingPath = join(activationPath, "staging");
  const db = openM0Database(":memory:");
  mkdirSync(outside, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  try {
    try { symlinkSync(outside, activationPath, "junction"); }
    catch (error) {
      context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    const rootResult = activateLocalMediaArtifact({ artifact: structuredClone(artifact), source_path: IMAGE_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(rootResult.ok, false);
    if (!rootResult.ok) assert.equal(rootResult.error.code, "MEDIA_ACTIVATION_PATH_UNSAFE");
    assert.equal(readdirSync(outside).length, 0);

    rmSync(activationPath, { force: true });
    mkdirSync(activationPath);
    symlinkSync(outside, stagingPath, "junction");
    const childResult = activateLocalMediaArtifact({ artifact: structuredClone(artifact), source_path: IMAGE_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(childResult.ok, false);
    if (!childResult.ok) assert.equal(childResult.error.code, "MEDIA_ACTIVATION_PATH_UNSAFE");
    assert.equal(readdirSync(outside).length, 0);
  } finally {
    db.close();
    if (existsSync(stagingPath)) rmSync(stagingPath, { force: true });
    if (existsSync(activationPath)) rmSync(activationPath, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging-owner recovery rejects a custom media root replaced by a junction", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-owner-root-swap-"));
  const mediaRoot = join(root, "media");
  const outsideRoot = join(root, "outside-media");
  const db = openM0Database(":memory:");
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  let stagingPath = "";
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      after_staging_written: (path) => {
        stagingPath = path;
        throw new Error("INJECTED_OWNER_ROOT_SWAP");
      }
    }, db), /INJECTED_OWNER_ROOT_SWAP/);
    renameSync(mediaRoot, outsideRoot);
    try { symlinkSync(outsideRoot, mediaRoot, "junction"); }
    catch (error) {
      context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    const externalStaging = stagingPath.replace(resolve(mediaRoot), resolve(outsideRoot));
    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.code === "MEDIA_STAGING_OWNER_INVALID"), true);
    assert.equal(existsSync(externalStaging), true);
  } finally {
    db.close();
    if (existsSync(mediaRoot)) rmSync(mediaRoot, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal recovery rejects a custom media root replaced by a junction", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-journal-root-swap-"));
  const mediaRoot = join(root, "media");
  const outsideRoot = join(root, "outside-media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  let activationId = "";
  let stagingPath = "";
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      after_journal_staged: (path) => {
        stagingPath = path;
        throw new Error("INJECTED_JOURNAL_ROOT_SWAP");
      }
    }, db), /INJECTED_JOURNAL_ROOT_SWAP/);
    activationId = (db.prepare("SELECT activation_id FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string }).activation_id;
    renameSync(mediaRoot, outsideRoot);
    try { symlinkSync(outsideRoot, mediaRoot, "junction"); }
    catch (error) {
      context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    const externalStaging = stagingPath.replace(resolve(mediaRoot), resolve(outsideRoot));
    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === activationId && failure.code === "MEDIA_ACTIVATION_PATH_UNSAFE"), true);
    assert.equal(existsSync(externalStaging), true);
    assert.equal((db.prepare("SELECT state, error_code FROM media_activation_journal WHERE activation_id = ?").get(activationId) as { state: string; error_code: string }).state, "failed");
  } finally {
    db.close();
    if (activationId) rmSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`), { force: true });
    if (existsSync(mediaRoot)) rmSync(mediaRoot, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery rejects marker paths whose media ancestor became a symlink", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-marker-symlink-swap-"));
  const mediaRoot = join(root, "media");
  const outsideRoot = join(root, "outside");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  let activationId = "";
  try {
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      after_file_placed: () => { throw new Error("INJECTED_BEFORE_SYMLINK_SWAP"); }
    }, db), /INJECTED_BEFORE_SYMLINK_SWAP/);
    activationId = (db.prepare("SELECT activation_id FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string }).activation_id;
    db.exec("ROLLBACK");

    mkdirSync(outsideRoot, { recursive: true });
    const originalArtifacts = join(mediaRoot, "artifacts");
    const outsideArtifacts = join(outsideRoot, "artifacts");
    renameSync(originalArtifacts, outsideArtifacts);
    try { symlinkSync(outsideArtifacts, originalArtifacts, "junction"); }
    catch (error) {
      context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    const externalFile = join(outsideArtifacts, "images", `${artifact.artifact_id}.png`);
    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === activationId && failure.code === "MEDIA_ACTIVATION_MARKER_INVALID"), true);
    assert.equal(existsSync(externalFile), true);
  } finally {
    db.close();
    if (activationId) rmSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("default recovery discovers an orphan marker for a custom media root", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-custom-orphan-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  let activationId = "";
  try {
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      after_file_placed: () => { throw new Error("INJECTED_CUSTOM_ROOT_OUTER_ROLLBACK"); }
    }, db), /INJECTED_CUSTOM_ROOT_OUTER_ROLLBACK/);
    activationId = (db.prepare("SELECT activation_id FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string }).activation_id;
    assert.equal(existsSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`)), true);
    db.exec("ROLLBACK");

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === activationId && failure.code === "MEDIA_ACTIVATION_DB_RECORD_MISSING"), true);
    assert.equal(existsSync(artifact.storage.uri), false);
    assert.equal((db.prepare("SELECT state FROM media_activation_journal WHERE activation_id = ?").get(activationId) as { state: string }).state, "failed");
  } finally {
    db.close();
    if (activationId) rmSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery never quarantines a pre-existing final that the activation did not own", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-unowned-final-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  const preExistingBytes = Buffer.from("pre-existing-final-owned-by-another-operation", "utf8");
  let activationId = "";
  try {
    mkdirSync(resolve(artifact.storage.uri, ".."), { recursive: true });
    writeFileSync(artifact.storage.uri, preExistingBytes, { flag: "wx" });
    db.exec("BEGIN IMMEDIATE");
    const activated = activateLocalMediaArtifact({ artifact, source_path: IMAGE_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(activated.ok, false);
    if (!activated.ok) assert.equal(activated.error.code, "MEDIA_ACTIVATION_FINAL_PATH_EXISTS");
    activationId = (db.prepare("SELECT activation_id FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string }).activation_id;
    const marker = JSON.parse(readFileSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`), "utf8")) as { final_path_owned: boolean };
    assert.equal(marker.final_path_owned, false);
    db.exec("ROLLBACK");

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === activationId && failure.code === "MEDIA_ACTIVATION_DB_RECORD_MISSING"), true);
    assert.equal(readFileSync(artifact.storage.uri).equals(preExistingBytes), true);
  } finally {
    db.close();
    if (activationId) rmSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("an outer transaction rollback cannot leave an unrecorded active file", () => {
  const db = openM0Database();
  const artifact = preparedArtifact();
  let activationId = "";
  try {
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      after_file_placed: () => { throw new Error("INJECTED_OUTER_TRANSACTION_CRASH"); }
    }, db), /INJECTED_OUTER_TRANSACTION_CRASH/);
    activationId = (db.prepare("SELECT activation_id FROM media_activation_journal WHERE artifact_id = ?").get(artifact.artifact_id) as { activation_id: string }).activation_id;
    assert.equal(existsSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`)), true);
    assert.equal(existsSync(artifact.storage.uri), true);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT activation_id FROM media_activation_journal WHERE activation_id = ?").get(activationId), undefined);

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.activation_id === activationId && failure.code === "MEDIA_ACTIVATION_DB_RECORD_MISSING"), true);
    assert.equal(existsSync(artifact.storage.uri), false);
    assert.equal(getMediaArtifact(db, artifact.artifact_id), null);
    assert.deepEqual({ ...(db.prepare("SELECT state, error_code FROM media_activation_journal WHERE activation_id = ?").get(activationId) as { state: string; error_code: string }) }, {
      state: "failed",
      error_code: "MEDIA_ACTIVATION_DB_RECORD_MISSING"
    });
  } finally {
    db.close();
    rmSync(artifact.storage.uri, { force: true });
    if (activationId) rmSync(join(paths.mediaActivationJournalRoot, `${activationId}.json`), { force: true });
    if (existsSync(paths.mediaActivationQuarantineRoot)) {
      for (const name of readdirSync(paths.mediaActivationQuarantineRoot).filter((entry) => entry.startsWith(artifact.artifact_id))) {
        rmSync(join(paths.mediaActivationQuarantineRoot, name), { force: true });
      }
    }
  }
});

test("activation rejects bytes whose media type does not match the Artifact", () => {
  const db = openM0Database(":memory:");
  const artifact = preparedArtifact();
  artifact.artifact_type = "video";
  artifact.role = "generated_clip";
  artifact.storage = { uri: resolve(paths.videoArtifactsRoot, `${artifact.artifact_id}.mp4`), mime_type: "video/mp4", filename: `${artifact.artifact_id}.mp4` };
  artifact.metadata = { width: 1080, height: 1920, duration_seconds: 2, aspect_ratio: "9:16", sha256: "" };
  try {
    const result = activateLocalMediaArtifact({ artifact, source_path: IMAGE_FIXTURE }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(new Set(["VIDEO_FILE_INVALID", "MEDIA_MIME_MISMATCH"]).has(result.error.code), true);
    assert.equal(getMediaArtifact(db, artifact.artifact_id), null);
  } finally {
    db.close();
    rmSync(artifact.storage.uri, { force: true });
  }
});

test("db:check detects tampered and missing active media bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "media-integrity-db-check-"));
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  let finalPath = "";
  try {
    const result = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    finalPath = result.artifact.storage.uri;
  } finally {
    db.close();
  }
  try {
    writeFileSync(finalPath, Buffer.from("tampered-media-bytes", "utf8"));
    const tampered = checkDatabase(sqlitePath);
    assert.equal(tampered.result, "FAIL");
    assert.equal(tampered.media_integrity_errors, 1);
    rmSync(finalPath, { force: true });
    const missing = checkDatabase(sqlitePath);
    assert.equal(missing.result, "FAIL");
    assert.equal(missing.missing_media_files, 1);
    assert.equal(missing.media_integrity_errors, 1);
  } finally {
    if (finalPath && existsSync(finalPath)) rmSync(finalPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("db:check rejects Artifact storage URI drift from its authoritative Blob", () => {
  const root = mkdtempSync(join(tmpdir(), "media-integrity-uri-drift-"));
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  let finalPath = "";
  try {
    const result = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    finalPath = result.artifact.storage.uri;
    const drifted = structuredClone(result.artifact);
    drifted.storage.uri = resolve(paths.imageArtifactsRoot, `${drifted.artifact_id}-drifted.png`);
    const verified = verifyMediaArtifactBytes(db, drifted);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.error.code, "MEDIA_BLOB_CONTENT_DRIFT");
    db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(drifted), drifted.artifact_id);
  } finally {
    db.close();
  }
  try {
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.media_integrity_errors, 1);
  } finally {
    if (finalPath) rmSync(finalPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("db:check rejects a symlink substituted for active media", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-integrity-symlink-"));
  const sqlitePath = join(root, "app.sqlite");
  const externalPath = join(root, "external.png");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  let finalPath = "";
  try {
    const result = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" } }, db);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    finalPath = result.artifact.storage.uri;
  } finally {
    db.close();
  }
  try {
    copyFileSync(IMAGE_FIXTURE, externalPath);
    rmSync(finalPath, { force: true });
    try { symlinkSync(externalPath, finalPath, "file"); }
    catch (error) {
      context.skip(`File symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.media_integrity_errors, 1);
  } finally {
    if (finalPath) rmSync(finalPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery restores missing bytes without changing immutable rows or shared links", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-missing-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const sharedArtifact: MediaArtifact = {
      ...structuredClone(fixture.artifact),
      artifact_id: `artifact_${randomUUID()}`,
      source: {
        ...fixture.artifact.source,
        kind: "scoped_blob_reference",
        provider_job_id: ""
      }
    };
    db.prepare(`INSERT INTO media_artifacts
      (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
      VALUES (?, ?, ?, 'generated_clip', 'video', 'active', ?)`)
      .run(sharedArtifact.artifact_id, fixture.project_id, fixture.shot_id, JSON.stringify(sharedArtifact));
    db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)")
      .run(sharedArtifact.artifact_id, sharedArtifact.blob_id);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const blobCountBefore = (db.prepare("SELECT COUNT(*) AS count FROM media_blobs").get() as { count: number }).count;

    rmSync(fixture.artifact.storage.uri);
    const recovered = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);

    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
    if (!recovered.ok) return;
    assert.equal(recovered.outcome, "MISSING_BYTES");
    assert.equal(recovered.corrupt_bytes_quarantined, false);
    assert.equal(readFileSync(fixture.artifact.storage.uri).equals(readFileSync(VIDEO_FIXTURE)), true);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.equal(verifyMediaArtifactBytes(db, sharedArtifact).ok, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_blobs").get() as { count: number }).count, blobCountBefore);
    assert.throws(
      () => db.prepare("UPDATE media_blobs SET storage_uri = storage_uri WHERE blob_id = ?").run(fixture.artifact.blob_id),
      /MEDIA_BLOB_IMMUTABLE/
    );
    assert.throws(
      () => db.prepare("DELETE FROM media_blobs WHERE blob_id = ?").run(fixture.artifact.blob_id),
      /MEDIA_BLOB_IMMUTABLE/
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery closes only its interrupted exclusive-placement hard-link pair", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-linked-placement-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const targetPath = fixture.artifact.storage.uri;
    const stagedPath = join(
      dirname(targetPath),
      `blob-recovery-${randomUUID()}.staged`
    );
    rmSync(targetPath);
    copyFileSync(fixture.source_path, stagedPath);
    linkSync(stagedPath, targetPath);
    assert.equal(lstatSync(stagedPath).nlink, 2);
    assert.equal(lstatSync(targetPath).nlink, 2);

    const recovered = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
    if (!recovered.ok) return;
    assert.equal(recovered.outcome, "ALREADY_REUSABLE");
    assert.equal(existsSync(stagedPath), false);
    assert.equal(lstatSync(targetPath).nlink, 1);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);

    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const deterministicStagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    rmSync(targetPath);
    copyFileSync(fixture.source_path, deterministicStagedPath);
    linkSync(deterministicStagedPath, targetPath);
    assert.equal(lstatSync(deterministicStagedPath).nlink, 2);
    assert.equal(lstatSync(targetPath).nlink, 2);
    const deterministicRecovered = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(deterministicRecovered.ok, true, deterministicRecovered.ok ? undefined : deterministicRecovered.error.code);
    assert.equal(existsSync(deterministicStagedPath), false);
    assert.equal(lstatSync(targetPath).nlink, 1);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);

    const unrelatedLink = join(root, "unrelated-hard-link.mp4");
    linkSync(targetPath, unrelatedLink);
    const rejectedUnownedLink = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(rejectedUnownedLink.ok, false);
    if (!rejectedUnownedLink.ok) {
      assert.equal(rejectedUnownedLink.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assert.equal(existsSync(unrelatedLink), true);
    assert.equal(lstatSync(targetPath).nlink, 2);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery quarantines drifted bytes and treats a reusable target as a no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-drift-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const corruptBytes = Buffer.from("drifted-provider-output", "utf8");
    writeFileSync(fixture.artifact.storage.uri, corruptBytes);

    const recovered = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
    if (!recovered.ok) return;
    assert.equal(recovered.outcome, "CONTENT_DRIFT");
    assert.equal(recovered.corrupt_bytes_quarantined, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);

    const quarantineDirectory = join(mediaRoot, ".activation", "quarantine");
    const quarantineFiles = readdirSync(quarantineDirectory).filter((name) => name.endsWith(".corrupt"));
    assert.equal(quarantineFiles.length, 1);
    assert.match(quarantineFiles[0], /^blob-recovery-[0-9a-f-]+\.corrupt$/i);
    assert.equal(readFileSync(join(quarantineDirectory, quarantineFiles[0])).equals(corruptBytes), true);
    assert.equal(quarantineFiles[0].includes(fixture.artifact.artifact_id), false);
    assert.equal(quarantineFiles[0].includes(fixture.artifact.blob_id), false);

    let replacementAttempted = false;
    const noOp = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db, {
      after_staged_copy: () => {
        replacementAttempted = true;
        throw new Error("NO_OP_MUST_NOT_STAGE");
      }
    });
    assert.equal(noOp.ok, true, noOp.ok ? undefined : noOp.error.code);
    if (noOp.ok) assert.equal(noOp.outcome, "ALREADY_REUSABLE");
    assert.equal(replacementAttempted, false);
    assert.equal(readdirSync(quarantineDirectory).filter((name) => name.endsWith(".corrupt")).length, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery rejects SHA, size, and MIME mismatches without changing ledger facts", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-mismatch-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const original = readFileSync(VIDEO_FIXTURE);
    writeFileSync(fixture.artifact.storage.uri, Buffer.from("existing-content-drift", "utf8"));

    const sameSizeDifferentSha = Buffer.from(original);
    sameSizeDifferentSha[sameSizeDifferentSha.length - 1] ^= 0x01;
    const shaMismatchPath = join(mediaRoot, "downloads", "sha-mismatch.mp4");
    writeFileSync(shaMismatchPath, sameSizeDifferentSha);
    assert.equal(sameSizeDifferentSha.length, original.length);

    const sizeMismatchPath = join(mediaRoot, "downloads", "size-mismatch.mp4");
    writeFileSync(sizeMismatchPath, Buffer.concat([original, Buffer.from("size-drift", "utf8")]));
    const mimeMismatchPath = join(mediaRoot, "downloads", "mime-mismatch.png");
    copyFileSync(IMAGE_FIXTURE, mimeMismatchPath);

    for (const sourcePath of [shaMismatchPath, sizeMismatchPath, mimeMismatchPath]) {
      const result = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: sourcePath
      }, db);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH");
      assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
      assert.equal(readFileSync(fixture.artifact.storage.uri).toString("utf8"), "existing-content-drift");
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery rejects paths outside the registered root and directory targets", () => {
  for (const scenario of ["outside", "directory"] as const) {
    const root = mkdtempSync(join(tmpdir(), `verified-blob-recovery-${scenario}-`));
    const mediaRoot = join(root, "media");
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      mkdirSync(mediaRoot, { recursive: true });
      const sourcePath = join(mediaRoot, "source.mp4");
      copyFileSync(VIDEO_FIXTURE, sourcePath);
      const targetPath = scenario === "outside"
        ? join(root, "outside.mp4")
        : join(mediaRoot, "directory-target");
      if (scenario === "outside") writeFileSync(targetPath, "drifted", "utf8");
      else mkdirSync(targetPath);
      const fixture = insertUnsafeRecoveryFixture(db, mediaRoot, targetPath, sourcePath);
      const result = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.artifact.linked_objects.project_id,
        shot_id: fixture.artifact.linked_objects.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verified Blob recovery rejects symlink roots, ancestors, and targets", (context) => {
  for (const scenario of ["root", "ancestor", "target"] as const) {
    const root = mkdtempSync(join(tmpdir(), `verified-blob-recovery-symlink-${scenario}-`));
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const mediaRoot = join(root, "media");
      const actualRoot = scenario === "root" ? join(root, "actual-media") : mediaRoot;
      mkdirSync(actualRoot, { recursive: true });
      if (scenario === "root") {
        try { symlinkSync(actualRoot, mediaRoot, "junction"); }
        catch (error) {
          context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
          return;
        }
      }
      const sourcePath = join(actualRoot, "source.mp4");
      copyFileSync(VIDEO_FIXTURE, sourcePath);
      let targetPath = join(mediaRoot, "target.mp4");
      if (scenario === "ancestor") {
        const actualDirectory = join(root, "actual-videos");
        const linkedDirectory = join(mediaRoot, "videos");
        mkdirSync(actualDirectory);
        try { symlinkSync(actualDirectory, linkedDirectory, "junction"); }
        catch (error) {
          context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
          return;
        }
        targetPath = join(linkedDirectory, "target.mp4");
        writeFileSync(join(actualDirectory, "target.mp4"), "drifted", "utf8");
      } else if (scenario === "target") {
        const actualTarget = join(mediaRoot, "actual-target.mp4");
        writeFileSync(actualTarget, "drifted", "utf8");
        try { symlinkSync(actualTarget, targetPath, "file"); }
        catch (error) {
          context.skip(`File symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
          return;
        }
      } else {
        writeFileSync(join(actualRoot, "target.mp4"), "drifted", "utf8");
      }
      const fixture = insertUnsafeRecoveryFixture(db, mediaRoot, targetPath, sourcePath);
      const result = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.artifact.linked_objects.project_id,
        shot_id: fixture.artifact.linked_objects.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verified Blob recovery fault seams never report success and remain explicitly retryable", () => {
  const seams: Array<keyof VerifiedBlobStorageRecoveryFaults> = [
    "after_staged_copy",
    "after_corrupt_quarantined",
    "after_replacement_placed",
    "before_final_verification"
  ];
  for (const seam of seams) {
    const root = mkdtempSync(join(tmpdir(), `verified-blob-recovery-fault-${seam}-`));
    const mediaRoot = join(root, "media");
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const fixture = createRecoverableVideo(db, mediaRoot);
      const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
      writeFileSync(fixture.artifact.storage.uri, `drift-${seam}`, "utf8");
      const faults = {
        [seam]: () => {
          throw new Error(`INJECTED_${seam.toUpperCase()}`);
        }
      } as VerifiedBlobStorageRecoveryFaults;
      const failed = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, db, faults);
      assert.equal(failed.ok, false, seam);
      if (!failed.ok) assert.equal(failed.error.code, "MEDIA_BLOB_RECOVERY_FAILED", seam);
      assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, false, seam);
      assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before, seam);

      const retried = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(retried.ok, true, retried.ok ? seam : retried.error.code);
      assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true, seam);
      assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before, seam);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verified Blob recovery serializes competing repairs with BEGIN IMMEDIATE", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-serialized-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const contenderDb = openM0Database(sqlitePath);
  contenderDb.exec("PRAGMA busy_timeout = 1");
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    writeFileSync(fixture.artifact.storage.uri, "serialized-drift", "utf8");
    const contenderResults: Array<ReturnType<typeof recoverVerifiedBlobStorage>> = [];
    const first = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db, {
      after_staged_copy: () => {
        contenderResults.push(recoverVerifiedBlobStorage({
          invalid_artifact_id: fixture.artifact.artifact_id,
          project_id: fixture.project_id,
          shot_id: fixture.shot_id,
          source_path: fixture.source_path
        }, contenderDb, { target_mutex_busy_timeout_ms: 25 }));
      }
    });
    assert.equal(first.ok, true, first.ok ? undefined : first.error.code);
    assert.equal(contenderResults.length, 1);
    const contender = contenderResults[0];
    assert.equal(contender.ok, false);
    if (!contender.ok) assert.equal(contender.error.code, "MEDIA_BLOB_RECOVERY_BUSY");

    const retry = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, contenderDb);
    assert.equal(retry.ok, true, retry.ok ? undefined : retry.error.code);
    if (retry.ok) assert.equal(retry.outcome, "ALREADY_REUSABLE");
  } finally {
    contenderDb.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent databases serialize explicit recovery for the same Blob target", async () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-cross-database-"));
  const mediaRoot = join(root, "media");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  const readyA = join(root, "ready-a");
  const releaseA = join(root, "release-a");
  let processA: ChildProcess | null = null;
  let processB: ChildProcess | null = null;
  migrateDatabase(databaseA);
  migrateDatabase(databaseB);
  const db = openM0Database(databaseA);
  const dbB = openM0Database(databaseB);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    const mutexPath = verifiedBlobRecoveryMutexPath(mediaRoot, blob.storage_uri);
    const storageVariant = process.platform === "win32"
      ? blob.storage_uri.toUpperCase()
      : blob.storage_uri;
    const fixtureB = insertUnsafeRecoveryFixture(
      dbB,
      mediaRoot,
      storageVariant,
      fixture.source_path,
      blob.blob_id
    );
    assert.equal(
      verifiedBlobRecoveryStagePath(mediaRoot, blob),
      verifiedBlobRecoveryStagePath(mediaRoot, { ...blob, storage_uri: storageVariant })
    );
    db.close();
    dbB.close();
    rmSync(fixture.artifact.storage.uri);

    processA = startPausedVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseA,
      artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path,
      ready_signal: readyA,
      release_signal: releaseA
    });
    await waitForSignal(readyA);
    const stagedBytes = readFileSync(stagedPath);
    processB = startVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseB,
      artifact_id: fixtureB.artifact.artifact_id,
      project_id: fixtureB.artifact.linked_objects.project_id,
      shot_id: fixtureB.artifact.linked_objects.shot_id,
      source_path: fixtureB.source_path
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.equal(processB.exitCode, null);
    assert.deepEqual(readFileSync(stagedPath), stagedBytes);
    assert.equal(existsSync(fixture.artifact.storage.uri), false);

    writeFileSync(releaseA, "release", "utf8");
    const completedA = await waitForChild(processA);
    const completedB = await waitForChild(processB);
    assert.equal(completedA.code, 0, completedA.stderr);
    assert.equal(completedB.code, 0, completedB.stderr);
    const resultA = JSON.parse(completedA.stdout) as ReturnType<typeof recoverVerifiedBlobStorage>;
    const resultB = JSON.parse(completedB.stdout) as ReturnType<typeof recoverVerifiedBlobStorage>;
    assert.equal(resultA.ok, true, resultA.ok ? undefined : resultA.error.code);
    assert.equal(resultB.ok, true, resultB.ok ? undefined : resultB.error.code);
    if (resultB.ok) assert.equal(resultB.outcome, "ALREADY_REUSABLE");
    assert.equal(existsSync(stagedPath), false);
    assert.equal(existsSync(mutexPath), true);
    assert.equal(readdirSync(dirname(mutexPath)).filter((name) => /^blob-recovery-target-.*\.lock\.sqlite$/.test(name)).length, 1);
  } finally {
    if (processA?.exitCode === null) processA.kill();
    if (processB?.exitCode === null) processB.kill();
    try { db.close(); } catch { /* closed before child processes */ }
    try { dbB.close(); } catch { /* closed before child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("different Blob ids sharing one storage target use the same mutex and stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-shared-target-"));
  const mediaRoot = join(root, "media");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  const readyA = join(root, "ready-a");
  const releaseA = join(root, "release-a");
  let processA: ChildProcess | null = null;
  let processB: ChildProcess | null = null;
  migrateDatabase(databaseA);
  migrateDatabase(databaseB);
  const dbA = openM0Database(databaseA);
  const dbB = openM0Database(databaseB);
  try {
    const fixtureA = createRecoverableVideo(dbA, mediaRoot);
    const targetVariant = process.platform === "win32"
      ? fixtureA.artifact.storage.uri.toUpperCase()
      : fixtureA.artifact.storage.uri;
    const fixtureB = insertUnsafeRecoveryFixture(
      dbB,
      mediaRoot,
      targetVariant,
      fixtureA.source_path,
      `blob_distinct_${randomUUID()}`
    );
    assert.notEqual(fixtureA.artifact.blob_id, fixtureB.artifact.blob_id);
    if (process.platform === "win32") {
      assert.notEqual(fixtureA.artifact.storage.uri, fixtureB.artifact.storage.uri);
      assert.equal(fixtureA.artifact.storage.uri.toLowerCase(), fixtureB.artifact.storage.uri.toLowerCase());
    }
    const blobA = getMediaBlob(dbA, fixtureA.artifact.blob_id);
    const blobB = getMediaBlob(dbB, fixtureB.artifact.blob_id);
    assert.ok(blobA);
    assert.ok(blobB);
    assert.equal(
      verifiedBlobRecoveryMutexPath(mediaRoot, blobA.storage_uri),
      verifiedBlobRecoveryMutexPath(mediaRoot, blobB.storage_uri)
    );
    const stageA = verifiedBlobRecoveryStagePath(mediaRoot, blobA);
    const stageB = verifiedBlobRecoveryStagePath(mediaRoot, blobB);
    assert.equal(stageA, stageB);
    dbA.close();
    dbB.close();
    rmSync(fixtureA.artifact.storage.uri);

    processA = startPausedVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseA,
      artifact_id: fixtureA.artifact.artifact_id,
      project_id: fixtureA.project_id,
      shot_id: fixtureA.shot_id,
      source_path: fixtureA.source_path,
      ready_signal: readyA,
      release_signal: releaseA
    });
    await waitForSignal(readyA);
    const stagedBytes = readFileSync(stageA);
    assert.equal(processA.kill(), true);
    const crashedA = await waitForChild(processA);
    assert.notEqual(crashedA.code, 0);
    processA = null;
    processB = startVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseB,
      artifact_id: fixtureB.artifact.artifact_id,
      project_id: fixtureB.artifact.linked_objects.project_id,
      shot_id: fixtureB.artifact.linked_objects.shot_id,
      source_path: fixtureB.source_path
    });
    const completedB = await waitForChild(processB);
    assert.equal(completedB.code, 0, completedB.stderr);
    const resultB = JSON.parse(completedB.stdout) as ReturnType<typeof recoverVerifiedBlobStorage>;
    assert.equal(resultB.ok, true, resultB.ok ? undefined : resultB.error.code);
    if (resultB.ok) assert.equal(resultB.outcome, "MISSING_BYTES");
    assert.equal(existsSync(stageA), false);
    assert.deepEqual(readFileSync(fixtureA.artifact.storage.uri), stagedBytes);
  } finally {
    if (processA?.exitCode === null) processA.kill();
    if (processB?.exitCode === null) processB.kill();
    try { dbA.close(); } catch { /* closed before child processes */ }
    try { dbB.close(); } catch { /* closed before child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows long and DOS-short target aliases share recovery identities", (context) => {
  if (process.platform !== "win32") {
    context.skip("DOS short-path aliases are Windows-only");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-short-alias-"));
  const mediaRoot = join(root, "media-directory-with-long-name");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  migrateDatabase(databaseA);
  migrateDatabase(databaseB);
  const dbA = openM0Database(databaseA);
  const dbB = openM0Database(databaseB);
  try {
    const fixtureA = createRecoverableVideo(dbA, mediaRoot);
    const shortTarget = windowsShortPath(fixtureA.artifact.storage.uri);
    if (!shortTarget) {
      context.skip("The test volume does not expose a distinct DOS short-path alias");
      return;
    }
    const fixtureB = insertUnsafeRecoveryFixture(
      dbB,
      mediaRoot,
      shortTarget,
      fixtureA.source_path,
      `blob_short_alias_${randomUUID()}`
    );
    const blobA = getMediaBlob(dbA, fixtureA.artifact.blob_id);
    const blobB = getMediaBlob(dbB, fixtureB.artifact.blob_id);
    assert.ok(blobA);
    assert.ok(blobB);
    assert.equal(
      verifiedBlobRecoveryMutexPath(mediaRoot, blobA.storage_uri),
      verifiedBlobRecoveryMutexPath(mediaRoot, blobB.storage_uri)
    );
    assert.equal(
      verifiedBlobRecoveryStagePath(mediaRoot, blobA),
      verifiedBlobRecoveryStagePath(mediaRoot, blobB)
    );
    assert.equal(
      verifiedBlobRecoveryAuthorityPath(blobA.storage_uri),
      verifiedBlobRecoveryAuthorityPath(blobB.storage_uri)
    );

    for (const [fixture, database] of [[fixtureA, dbA], [fixtureB, dbB]] as const) {
      const recovered = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.artifact.linked_objects.project_id,
        shot_id: fixture.artifact.linked_objects.shot_id,
        source_path: fixture.source_path
      }, database);
      assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
      if (recovered.ok) assert.equal(recovered.outcome, "ALREADY_REUSABLE");
    }
    rmSync(fixtureA.artifact.storage.uri);
    const unprovableMissingAlias = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixtureB.artifact.artifact_id,
      project_id: fixtureB.artifact.linked_objects.project_id,
      shot_id: fixtureB.artifact.linked_objects.shot_id,
      source_path: fixtureB.source_path
    }, dbB);
    assert.equal(unprovableMissingAlias.ok, false);
    if (!unprovableMissingAlias.ok) {
      assert.equal(unprovableMissingAlias.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    const recoveredLongPath = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixtureA.artifact.artifact_id,
      project_id: fixtureA.project_id,
      shot_id: fixtureA.shot_id,
      source_path: fixtureA.source_path
    }, dbA);
    assert.equal(recoveredLongPath.ok, true, recoveredLongPath.ok ? undefined : recoveredLongPath.error.code);
  } finally {
    dbB.close();
    dbA.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one physical target rejects a different registered media-root authority", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-root-authority-"));
  const mediaRoot = join(root, "media");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  migrateDatabase(databaseA);
  migrateDatabase(databaseB);
  const dbA = openM0Database(databaseA);
  const dbB = openM0Database(databaseB);
  try {
    const fixtureA = createRecoverableVideo(dbA, mediaRoot);
    const targetPath = fixtureA.artifact.storage.uri;
    const targetDirectory = dirname(targetPath);
    rmSync(targetPath);
    const recoveredA = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixtureA.artifact.artifact_id,
      project_id: fixtureA.project_id,
      shot_id: fixtureA.shot_id,
      source_path: fixtureA.source_path
    }, dbA);
    assert.equal(recoveredA.ok, true, recoveredA.ok ? undefined : recoveredA.error.code);
    const acceptedBytes = readFileSync(targetPath);
    const authorityPath = verifiedBlobRecoveryAuthorityPath(targetPath);
    const authorityBytes = readFileSync(authorityPath);

    const sourceB = join(targetDirectory, `source-${randomUUID()}.mp4`);
    copyFileSync(VIDEO_FIXTURE, sourceB);
    const fixtureB = insertUnsafeRecoveryFixture(
      dbB,
      targetDirectory,
      targetPath,
      sourceB,
      `blob_distinct_${randomUUID()}`
    );
    const blockedB = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixtureB.artifact.artifact_id,
      project_id: fixtureB.artifact.linked_objects.project_id,
      shot_id: fixtureB.artifact.linked_objects.shot_id,
      source_path: fixtureB.source_path
    }, dbB);
    assert.equal(blockedB.ok, false);
    if (!blockedB.ok) assert.equal(blockedB.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.deepEqual(readFileSync(targetPath), acceptedBytes);
    assert.deepEqual(readFileSync(authorityPath), authorityBytes);
  } finally {
    dbB.close();
    dbA.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one storage target rejects a conflicting immutable Blob digest", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-target-digest-authority-"));
  const mediaRoot = join(root, "media");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  migrateDatabase(databaseA);
  migrateDatabase(databaseB);
  const dbA = openM0Database(databaseA);
  const dbB = openM0Database(databaseB);
  try {
    const fixtureA = createRecoverableVideo(dbA, mediaRoot);
    const targetPath = fixtureA.artifact.storage.uri;
    rmSync(targetPath);
    const recoveredA = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixtureA.artifact.artifact_id,
      project_id: fixtureA.project_id,
      shot_id: fixtureA.shot_id,
      source_path: fixtureA.source_path
    }, dbA);
    assert.equal(recoveredA.ok, true, recoveredA.ok ? undefined : recoveredA.error.code);
    const acceptedBytes = readFileSync(targetPath);

    const sourceB = join(mediaRoot, "downloads", `conflict-${randomUUID()}.mp4`);
    const conflictingBytes = Buffer.concat([readFileSync(VIDEO_FIXTURE), Buffer.from("conflicting-blob")]);
    writeFileSync(sourceB, conflictingBytes);
    const fixtureB = insertUnsafeRecoveryFixture(
      dbB,
      mediaRoot,
      targetPath,
      sourceB,
      `blob_conflict_${randomUUID()}`,
      sourceB
    );
    const conflictingSha = createHash("sha256").update(conflictingBytes).digest("hex");
    assert.equal(fixtureB.artifact.metadata.sha256, conflictingSha);

    const blockedB = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixtureB.artifact.artifact_id,
      project_id: fixtureB.artifact.linked_objects.project_id,
      shot_id: fixtureB.artifact.linked_objects.shot_id,
      source_path: fixtureB.source_path
    }, dbB);
    assert.equal(blockedB.ok, false);
    if (!blockedB.ok) assert.equal(blockedB.error.code, "MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
    assert.deepEqual(readFileSync(targetPath), acceptedBytes);
    assert.equal(readdirSync(join(mediaRoot, ".activation", "quarantine")).length, 0);
  } finally {
    dbB.close();
    dbA.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("target mutex busy timeout is bounded and does not disturb the active recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-busy-"));
  const mediaRoot = join(root, "media");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  const readyA = join(root, "ready-a");
  const releaseA = join(root, "release-a");
  let processA: ChildProcess | null = null;
  let processB: ChildProcess | null = null;
  migrateDatabase(databaseA);
  const db = openM0Database(databaseA);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    db.close();
    copyFileSync(databaseA, databaseB);
    rmSync(fixture.artifact.storage.uri);
    processA = startPausedVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseA,
      artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path,
      ready_signal: readyA,
      release_signal: releaseA
    });
    await waitForSignal(readyA);
    const stagedBytes = readFileSync(stagedPath);
    processB = startVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseB,
      artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path,
      busy_timeout_ms: 25
    });
    const completedB = await waitForChild(processB);
    assert.equal(completedB.code, 0, completedB.stderr);
    const resultB = JSON.parse(completedB.stdout) as ReturnType<typeof recoverVerifiedBlobStorage>;
    assert.equal(resultB.ok, false);
    if (!resultB.ok) assert.equal(resultB.error.code, "MEDIA_BLOB_RECOVERY_BUSY");
    assert.deepEqual(readFileSync(stagedPath), stagedBytes);
    assert.equal(existsSync(fixture.artifact.storage.uri), false);

    writeFileSync(releaseA, "release", "utf8");
    const completedA = await waitForChild(processA);
    assert.equal(completedA.code, 0, completedA.stderr);
    const resultA = JSON.parse(completedA.stdout) as ReturnType<typeof recoverVerifiedBlobStorage>;
    assert.equal(resultA.ok, true, resultA.ok ? undefined : resultA.error.code);
  } finally {
    if (processA?.exitCode === null) processA.kill();
    if (processB?.exitCode === null) processB.kill();
    try { db.close(); } catch { /* closed before child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("different storage targets under one media root acquire mutexes concurrently", async () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-parallel-targets-"));
  const mediaRoot = join(root, "media");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  const readyA = join(root, "ready-a");
  const readyB = join(root, "ready-b");
  const releaseA = join(root, "release-a");
  const releaseB = join(root, "release-b");
  let processA: ChildProcess | null = null;
  let processB: ChildProcess | null = null;
  migrateDatabase(databaseA);
  migrateDatabase(databaseB);
  const dbA = openM0Database(databaseA);
  const dbB = openM0Database(databaseB);
  try {
    const fixtureA = createRecoverableVideo(dbA, mediaRoot);
    const fixtureB = createRecoverableVideo(dbB, mediaRoot);
    assert.notEqual(fixtureA.artifact.storage.uri, fixtureB.artifact.storage.uri);
    dbA.close();
    dbB.close();
    rmSync(fixtureA.artifact.storage.uri);
    rmSync(fixtureB.artifact.storage.uri);
    processA = startPausedVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseA,
      artifact_id: fixtureA.artifact.artifact_id,
      project_id: fixtureA.project_id,
      shot_id: fixtureA.shot_id,
      source_path: fixtureA.source_path,
      ready_signal: readyA,
      release_signal: releaseA,
      pause_at: "after_target_mutex_acquired"
    });
    processB = startPausedVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: databaseB,
      artifact_id: fixtureB.artifact.artifact_id,
      project_id: fixtureB.project_id,
      shot_id: fixtureB.shot_id,
      source_path: fixtureB.source_path,
      ready_signal: readyB,
      release_signal: releaseB,
      pause_at: "after_target_mutex_acquired"
    });
    await Promise.all([waitForSignal(readyA, 5_000), waitForSignal(readyB, 5_000)]);
    writeFileSync(releaseA, "release", "utf8");
    writeFileSync(releaseB, "release", "utf8");
    const [completedA, completedB] = await Promise.all([waitForChild(processA), waitForChild(processB)]);
    assert.equal(completedA.code, 0, completedA.stderr);
    assert.equal(completedB.code, 0, completedB.stderr);
  } finally {
    if (processA?.exitCode === null) processA.kill();
    if (processB?.exitCode === null) processB.kill();
    try { dbA.close(); } catch { /* closed before child processes */ }
    try { dbB.close(); } catch { /* closed before child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery rejects unsafe persistent target mutex entries", () => {
  for (const scenario of ["directory", "hard-link", "malformed"] as const) {
    const root = mkdtempSync(join(tmpdir(), `verified-blob-recovery-unsafe-mutex-${scenario}-`));
    const mediaRoot = join(root, "media");
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const fixture = createRecoverableVideo(db, mediaRoot);
      const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
      const blob = getMediaBlob(db, fixture.artifact.blob_id);
      assert.ok(blob);
      const mutexPath = verifiedBlobRecoveryMutexPath(mediaRoot, blob.storage_uri);
      rmSync(fixture.artifact.storage.uri);
      if (scenario === "directory") {
        mkdirSync(mutexPath);
      } else if (scenario === "hard-link") {
        const unownedPath = join(dirname(mutexPath), "unowned-lock.sqlite");
        writeFileSync(unownedPath, "preserve", "utf8");
        linkSync(unownedPath, mutexPath);
      } else {
        writeFileSync(mutexPath, "not-a-sqlite-database", "utf8");
      }

      const blocked = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      assert.equal(existsSync(mutexPath), true);
      assert.equal(existsSync(fixture.artifact.storage.uri), false);
      assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verified Blob recovery rejects a symlink target mutex without deleting it", (context) => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-symlink-mutex-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const mutexPath = verifiedBlobRecoveryMutexPath(mediaRoot, blob.storage_uri);
    const externalPath = join(root, "external-lock.sqlite");
    writeFileSync(externalPath, "preserve", "utf8");
    rmSync(fixture.artifact.storage.uri);
    try { symlinkSync(externalPath, mutexPath, "file"); }
    catch (error) {
      context.skip(`File symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    const blocked = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.equal(lstatSync(mutexPath).isSymbolicLink(), true);
    assert.equal(readFileSync(externalPath, "utf8"), "preserve");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery rejects a redirected activation journal root", (context) => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-redirected-journal-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const journalRoot = join(mediaRoot, ".activation", "journal");
    const externalRoot = join(root, "external-journal");
    mkdirSync(externalRoot);
    const sentinel = join(externalRoot, "sentinel.txt");
    writeFileSync(sentinel, "preserve", "utf8");
    rmSync(journalRoot, { recursive: true });
    try { symlinkSync(externalRoot, journalRoot, "junction"); }
    catch (error) {
      context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    rmSync(fixture.artifact.storage.uri);
    const blocked = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.equal(readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery rejects pre-existing SQLite mutex sidecars", () => {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-mutex-sidecar-"));
    const mediaRoot = join(root, "media");
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const fixture = createRecoverableVideo(db, mediaRoot);
      const blob = getMediaBlob(db, fixture.artifact.blob_id);
      assert.ok(blob);
      const mutexPath = verifiedBlobRecoveryMutexPath(mediaRoot, blob.storage_uri);
      const reusable = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(reusable.ok, true, reusable.ok ? undefined : reusable.error.code);
      assert.equal(existsSync(`${mutexPath}-journal`), false);
      assert.equal(existsSync(`${mutexPath}-wal`), false);
      assert.equal(existsSync(`${mutexPath}-shm`), false);

      rmSync(fixture.artifact.storage.uri);
      const sidecarPath = `${mutexPath}${suffix}`;
      writeFileSync(sidecarPath, "preserve", "utf8");
      const blocked = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      assert.equal(readFileSync(sidecarPath, "utf8"), "preserve");
      assert.equal(existsSync(fixture.artifact.storage.uri), false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verified Blob recovery rejects unowned target authority entries", () => {
  for (const scenario of ["malformed", "hard-link"] as const) {
    const root = mkdtempSync(join(tmpdir(), `verified-blob-recovery-authority-${scenario}-`));
    const mediaRoot = join(root, "media");
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const fixture = createRecoverableVideo(db, mediaRoot);
      const authorityPath = verifiedBlobRecoveryAuthorityPath(fixture.artifact.storage.uri);
      rmSync(fixture.artifact.storage.uri);
      if (scenario === "malformed") {
        writeFileSync(authorityPath, "not-authority-json", "utf8");
      } else {
        const unownedPath = join(dirname(authorityPath), "unowned-authority.json");
        writeFileSync(unownedPath, "preserve", "utf8");
        linkSync(unownedPath, authorityPath);
      }
      const blocked = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      assert.equal(existsSync(authorityPath), true);
      assert.equal(existsSync(fixture.artifact.storage.uri), false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a hard crash before target authority publication does not block retry", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-authority-crash-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const targetPath = fixture.artifact.storage.uri;
    const authorityPath = verifiedBlobRecoveryAuthorityPath(targetPath);
    const targetDirectory = dirname(targetPath);
    rmSync(targetPath);
    db.close();
    hardCrashVerifiedBlobRecovery({
      sqlite_path: sqlitePath,
      artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path,
      crash_at: "after_target_authority_temp_created"
    });
    assert.equal(existsSync(authorityPath), false);
    const orphanTemps = readdirSync(targetDirectory)
      .filter((name) => /^\.blob-recovery-target-[a-f0-9]{64}\.authority-[0-9a-f-]{36}\.tmp$/i.test(name));
    assert.equal(orphanTemps.length, 1);

    const retryDb = openM0Database(sqlitePath);
    try {
      const recovered = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, retryDb);
      assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
      assert.equal(existsSync(authorityPath), true);
      assert.equal(existsSync(targetPath), true);
      const reused = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, retryDb);
      assert.equal(reused.ok, true, reused.ok ? undefined : reused.error.code);
      if (reused.ok) assert.equal(reused.outcome, "ALREADY_REUSABLE");
    } finally {
      retryDb.close();
    }
  } finally {
    try { db.close(); } catch { /* closed before hard-crash child */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent target mutex is reused and released after application commit failure", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-mutex-reuse-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const mutexPath = verifiedBlobRecoveryMutexPath(mediaRoot, blob.storage_uri);
    rmSync(fixture.artifact.storage.uri);
    const originalExec = db.exec.bind(db);
    let rejectCommit = true;
    db.exec = ((sql: string) => {
      if (rejectCommit && sql.trim().toUpperCase() === "COMMIT") {
        rejectCommit = false;
        throw new Error("INJECTED_APPLICATION_COMMIT_FAILURE");
      }
      return originalExec(sql);
    }) as typeof db.exec;
    const failed = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "MEDIA_BLOB_RECOVERY_FAILED");
    db.exec = originalExec as typeof db.exec;

    const retried = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(retried.ok, true, retried.ok ? undefined : retried.error.code);
    const reused = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(reused.ok, true, reused.ok ? undefined : reused.error.code);
    if (reused.ok) assert.equal(reused.outcome, "ALREADY_REUSABLE");
    assert.deepEqual(recoverMediaActivations(db).failed, []);
    assert.equal(existsSync(mutexPath), true);
    assert.equal(readdirSync(dirname(mutexPath)).filter((name) => /^blob-recovery-target-[a-f0-9]{64}\.lock\.sqlite$/i.test(name)).length, 1);
    const blobRegistration = db.prepare("SELECT COUNT(*) AS count FROM media_blobs WHERE storage_uri = ?").get(mutexPath) as { count: number };
    const artifactRegistration = db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE json_extract(data_json, '$.storage.uri') = ?").get(mutexPath) as { count: number };
    const authorityPath = verifiedBlobRecoveryAuthorityPath(fixture.artifact.storage.uri);
    const authorityBlobRegistration = db.prepare("SELECT COUNT(*) AS count FROM media_blobs WHERE storage_uri = ?").get(authorityPath) as { count: number };
    const authorityArtifactRegistration = db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE json_extract(data_json, '$.storage.uri') = ?").get(authorityPath) as { count: number };
    assert.equal(blobRegistration.count, 0);
    assert.equal(artifactRegistration.count, 0);
    assert.equal(authorityBlobRegistration.count, 0);
    assert.equal(authorityArtifactRegistration.count, 0);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery revalidates the Artifact binding after acquiring the target mutex", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-binding-recheck-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const targetBytes = readFileSync(fixture.artifact.storage.uri);
    let driftBinding = false;
    const recoveryDb = new Proxy(db as unknown as object, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = db.prepare(sql);
            if (driftBinding && sql.includes("SELECT blob_id FROM media_artifact_blobs")) {
              return new Proxy(statement as unknown as object, {
                get(statementTarget, statementProperty) {
                  if (statementProperty === "all") return () => [];
                  const statementValue = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof statementValue === "function" ? statementValue.bind(statementTarget) : statementValue;
                }
              });
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as M0Database;
    const blocked = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, recoveryDb, {
      after_target_mutex_acquired: () => {
        driftBinding = true;
      }
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
    assert.deepEqual(readFileSync(fixture.artifact.storage.uri), targetBytes);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery bounds deterministic staging across repeated hard process exits", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-hard-crash-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  const copyPath = join(root, "recovery-copy.sqlite");
  const backupPath = join(root, "backup.sqlite");
  migrateDatabase(sqlitePath);
  let db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    const stagingRoot = dirname(stagedPath);
    const sourceSize = statSync(fixture.source_path).size;
    rmSync(fixture.artifact.storage.uri);
    db.close();
    copyFileSync(sqlitePath, copyPath);
    copyFileSync(sqlitePath, backupPath);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      hardCrashVerifiedBlobRecovery({
        sqlite_path: sqlitePath,
        artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      });
      const stagedFiles = readdirSync(stagingRoot)
        .filter((name) => /^blob-recovery-[a-f0-9]{64}\.staged$/i.test(name));
      assert.deepEqual(stagedFiles, [basename(stagedPath)]);
      assert.equal(statSync(stagedPath).size, sourceSize);
      const stagedBytes = readFileSync(stagedPath);
      for (const independentlyConfiguredPath of [sqlitePath, copyPath, backupPath]) {
        const startup = runStartupRecoveryChild({
          cwd: root,
          configured_path: independentlyConfiguredPath
        });
        assert.deepEqual(startup.failed, []);
        assert.deepEqual(readFileSync(stagedPath), stagedBytes);
      }
      const stagesAfterStartup = readdirSync(stagingRoot)
        .filter((name) => /^blob-recovery-[a-f0-9]{64}\.staged$/i.test(name));
      assert.deepEqual(stagesAfterStartup, [basename(stagedPath)]);
    }

    db = openM0Database(sqlitePath);
    const retried = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(retried.ok, true, retried.ok ? undefined : retried.error.code);
    assert.equal(existsSync(stagedPath), false);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
  } finally {
    try { db.close(); } catch { /* child-process setup may already have closed the first handle */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery removes a stale deterministic stage for reusable targets and recopies partial stages", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-deterministic-stage-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);

    copyFileSync(fixture.source_path, stagedPath);
    const startupWithReusableTarget = runStartupRecoveryChild({ cwd: root, configured_path: sqlitePath });
    assert.deepEqual(startupWithReusableTarget.failed, []);
    assert.equal(existsSync(stagedPath), true);
    const noOp = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(noOp.ok, true, noOp.ok ? undefined : noOp.error.code);
    if (noOp.ok) assert.equal(noOp.outcome, "ALREADY_REUSABLE");
    assert.equal(existsSync(stagedPath), false);

    rmSync(fixture.artifact.storage.uri);
    const partialBytes = readFileSync(fixture.source_path).subarray(0, 32);
    writeFileSync(stagedPath, partialBytes);
    const startupWithPartialStage = runStartupRecoveryChild({ cwd: root, configured_path: sqlitePath });
    assert.deepEqual(startupWithPartialStage.failed, []);
    assert.deepEqual(readFileSync(stagedPath), partialBytes);
    const recovered = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
    assert.equal(existsSync(stagedPath), false);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic startup preserves deterministic stages and explicit recovery converges only the exact Blob stage", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-unknown-stage-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const expectedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    const unknownPath = resolve(mediaRoot, ".activation", "staging", `blob-recovery-${"a".repeat(64)}.staged`);
    assert.notEqual(unknownPath, expectedPath);
    copyFileSync(fixture.source_path, expectedPath);
    copyFileSync(fixture.source_path, unknownPath);
    const expectedBytes = readFileSync(expectedPath);
    const unknownBytes = readFileSync(unknownPath);

    const recovered = runStartupRecoveryChild({ cwd: root, configured_path: sqlitePath });
    assert.deepEqual(recovered.failed, []);
    assert.deepEqual(readFileSync(expectedPath), expectedBytes);
    assert.deepEqual(readFileSync(unknownPath), unknownBytes);

    const explicit = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(explicit.ok, true, explicit.ok ? undefined : explicit.error.code);
    if (explicit.ok) assert.equal(explicit.outcome, "ALREADY_REUSABLE");
    assert.equal(existsSync(expectedPath), false);
    assert.equal(existsSync(unknownPath), true);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic startup preserves an unsafe exact stage for explicit recovery to reject", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-startup-unsafe-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    mkdirSync(stagedPath);

    const recovered = runStartupRecoveryChild({ cwd: root, configured_path: sqlitePath });
    assert.deepEqual(recovered.failed, []);
    assert.equal(lstatSync(stagedPath).isDirectory(), true);
    const blocked = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.equal(lstatSync(stagedPath).isDirectory(), true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple independently configured databases preserve the same deterministic Blob stage", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-independent-databases-"));
  const mediaRoot = join(root, "media");
  const databaseA = join(root, "database-a.sqlite");
  const databaseB = join(root, "database-b.sqlite");
  const databaseC = join(root, "database-c.sqlite");
  migrateDatabase(databaseA);
  const db = openM0Database(databaseA);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    db.close();
    copyFileSync(databaseA, databaseB);
    copyFileSync(databaseA, databaseC);
    copyFileSync(fixture.source_path, stagedPath);
    const stagedBytes = readFileSync(stagedPath);
    const stagingRoot = dirname(stagedPath);

    for (const independentlyConfiguredPath of [databaseA, databaseB, databaseC]) {
      const recovered = runStartupRecoveryChild({
        cwd: root,
        configured_path: independentlyConfiguredPath
      });
      assert.deepEqual(recovered.failed, []);
      assert.deepEqual(readFileSync(stagedPath), stagedBytes);
      const deterministicStages = readdirSync(stagingRoot)
        .filter((name) => /^blob-recovery-[a-f0-9]{64}\.staged$/i.test(name));
      assert.deepEqual(deterministicStages, [basename(stagedPath)]);
    }
  } finally {
    try { db.close(); } catch { /* already closed before the independent child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("an independently configured database continues its local activation journal recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "media-recovery-copy-local-journal-"));
  const mediaRoot = join(root, "media");
  const canonicalPath = join(root, "canonical.sqlite");
  const copyPath = join(root, "recovery-copy.sqlite");
  migrateDatabase(canonicalPath);
  const db = openM0Database(canonicalPath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  let activationId = "";
  try {
    assert.throws(() => activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      after_pending_placed: () => { throw new Error("INJECTED_COPY_LOCAL_JOURNAL_PAUSE"); }
    }, db), /INJECTED_COPY_LOCAL_JOURNAL_PAUSE/);
    const row = db.prepare("SELECT activation_id, state FROM media_activation_journal WHERE artifact_id = ?")
      .get(artifact.artifact_id) as { activation_id: string; state: string };
    activationId = row.activation_id;
    assert.equal(row.state, "staged");
    db.close();
    copyFileSync(canonicalPath, copyPath);

    const recovered = runStartupRecoveryChild({
      cwd: root,
      configured_path: copyPath
    });
    assert.equal(recovered.committed.includes(activationId), true);
    assert.equal(existsSync(artifact.storage.uri), true);
  } finally {
    try { db.close(); } catch { /* already closed before copying */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("in-memory startup recovery preserves deterministic Blob stages", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-memory-db-"));
  const mediaRoot = join(root, "media");
  const identity = {
    blob_id: `blob_recovery_${randomUUID()}`,
    storage_uri: join(mediaRoot, "artifacts", "videos", "memory.mp4"),
    media_root: mediaRoot
  };
  try {
    mkdirSync(join(mediaRoot, ".activation", "staging"), { recursive: true });
    mkdirSync(dirname(identity.storage_uri), { recursive: true });
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, identity);
    writeFileSync(stagedPath, "preserve-memory-stage", "utf8");
    const recovered = runStartupRecoveryChild({
      cwd: root,
      configured_path: join(root, "unused-configured.sqlite"),
      in_memory: true
    });
    assert.deepEqual(recovered.failed, []);
    assert.equal(readFileSync(stagedPath, "utf8"), "preserve-memory-stage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an independently configured database startup cannot delete an active recovery stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-active-vs-copy-"));
  const mediaRoot = join(root, "media");
  const canonicalPath = join(root, "canonical.sqlite");
  const copyPath = join(root, "recovery-copy.sqlite");
  const readySignal = join(root, "active-ready.signal");
  const releaseSignal = join(root, "active-release.signal");
  migrateDatabase(canonicalPath);
  const db = openM0Database(canonicalPath);
  let processA: ChildProcess | null = null;
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    db.close();
    copyFileSync(canonicalPath, copyPath);
    rmSync(fixture.artifact.storage.uri);

    processA = startPausedVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: canonicalPath,
      artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path,
      ready_signal: readySignal,
      release_signal: releaseSignal
    });
    const processAResult = waitForChild(processA, 35_000);
    await waitForSignal(readySignal);
    assert.equal(existsSync(stagedPath), true);
    const stagedBytes = readFileSync(stagedPath);

    const copied = runStartupRecoveryChild({
      cwd: root,
      configured_path: copyPath
    });
    assert.deepEqual(copied.failed, []);
    assert.deepEqual(readFileSync(stagedPath), stagedBytes);

    writeFileSync(releaseSignal, "release", "utf8");
    const completed = await processAResult;
    assert.equal(completed.code, 0, completed.stderr || completed.stdout);
    const recovery = JSON.parse(completed.stdout) as { ok: boolean; error?: { code: string } };
    assert.equal(recovery.ok, true, recovery.error?.code);
    assert.equal(existsSync(stagedPath), false);
    assert.equal(existsSync(fixture.artifact.storage.uri), true);
  } finally {
    if (processA?.exitCode === null) processA.kill();
    try { db.close(); } catch { /* already closed before child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("two processes opening the same database serialize recovery transactions", async () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-same-db-lock-"));
  const mediaRoot = join(root, "media");
  const canonicalPath = join(root, "canonical.sqlite");
  const readySignal = join(root, "active-ready.signal");
  const releaseSignal = join(root, "active-release.signal");
  const contenderSignal = join(root, "contender-started.signal");
  migrateDatabase(canonicalPath);
  const db = openM0Database(canonicalPath);
  let processA: ChildProcess | null = null;
  let processB: ChildProcess | null = null;
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    db.close();
    rmSync(fixture.artifact.storage.uri);

    processA = startPausedVerifiedBlobRecovery({
      cwd: root,
      sqlite_path: canonicalPath,
      artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path,
      ready_signal: readySignal,
      release_signal: releaseSignal
    });
    const processAResult = waitForChild(processA, 35_000);
    await waitForSignal(readySignal);
    assert.equal(existsSync(stagedPath), true);

    processB = startStartupRecoveryChild({
      cwd: root,
      configured_path: canonicalPath,
      started_signal: contenderSignal
    });
    const processBResult = waitForChild(processB, 35_000);
    await waitForSignal(contenderSignal);
    assert.equal(existsSync(stagedPath), true);

    writeFileSync(releaseSignal, "release", "utf8");
    const [completedA, completedB] = await Promise.all([processAResult, processBResult]);
    assert.equal(completedA.code, 0, completedA.stderr || completedA.stdout);
    assert.equal(completedB.code, 0, completedB.stderr || completedB.stdout);
    assert.equal((JSON.parse(completedA.stdout) as { ok: boolean }).ok, true);
    assert.deepEqual((JSON.parse(completedB.stdout) as ChildRecoveryResult).failed, []);
    assert.equal(existsSync(stagedPath), false);
    assert.equal(existsSync(fixture.artifact.storage.uri), true);
  } finally {
    if (processA?.exitCode === null) processA.kill();
    if (processB?.exitCode === null) processB.kill();
    try { db.close(); } catch { /* already closed before child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hard-crash releases the target mutex for explicit retry from another database", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-crash-explicit-retry-"));
  const mediaRoot = join(root, "media");
  const canonicalPath = join(root, "canonical.sqlite");
  const copyPath = join(root, "recovery-copy.sqlite");
  migrateDatabase(canonicalPath);
  let db = openM0Database(canonicalPath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    db.close();
    copyFileSync(canonicalPath, copyPath);
    rmSync(fixture.artifact.storage.uri);

    hardCrashVerifiedBlobRecovery({
      sqlite_path: canonicalPath,
      artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    });
    assert.equal(existsSync(stagedPath), true);

    const copied = runStartupRecoveryChild({
      cwd: root,
      configured_path: copyPath
    });
    assert.deepEqual(copied.failed, []);
    assert.equal(existsSync(stagedPath), true);

    const canonical = runStartupRecoveryChild({ cwd: root, configured_path: canonicalPath });
    assert.deepEqual(canonical.failed, []);
    assert.equal(existsSync(stagedPath), true);

    db = openM0Database(copyPath);
    const retried = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(retried.ok, true, retried.ok ? undefined : retried.error.code);
    assert.equal(existsSync(stagedPath), false);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
  } finally {
    try { db.close(); } catch { /* already closed before child processes */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery rejects deterministic staging directories and unowned hard links", () => {
  for (const scenario of ["directory", "hard-link"] as const) {
    const root = mkdtempSync(join(tmpdir(), `verified-blob-recovery-unsafe-stage-${scenario}-`));
    const mediaRoot = join(root, "media");
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const fixture = createRecoverableVideo(db, mediaRoot);
      const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
      const blob = getMediaBlob(db, fixture.artifact.blob_id);
      assert.ok(blob);
      const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
      rmSync(fixture.artifact.storage.uri);
      if (scenario === "directory") {
        mkdirSync(stagedPath);
      } else {
        const unownedPath = join(mediaRoot, "unowned-recovery-stage.mp4");
        copyFileSync(fixture.source_path, unownedPath);
        linkSync(unownedPath, stagedPath);
      }

      const blocked = recoverVerifiedBlobStorage({
        invalid_artifact_id: fixture.artifact.artifact_id,
        project_id: fixture.project_id,
        shot_id: fixture.shot_id,
        source_path: fixture.source_path
      }, db);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      assert.equal(existsSync(stagedPath), true);
      assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verified Blob recovery rejects a symlink staging entry without deleting its target", (context) => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-symlink-stage-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const blob = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blob);
    const stagedPath = verifiedBlobRecoveryStagePath(mediaRoot, blob);
    const externalPath = join(mediaRoot, "unowned-symlink-target.mp4");
    copyFileSync(fixture.source_path, externalPath);
    rmSync(fixture.artifact.storage.uri);
    try { symlinkSync(externalPath, stagedPath, "file"); }
    catch (error) {
      context.skip(`File symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }

    const blocked = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.equal(lstatSync(stagedPath).isSymbolicLink(), true);
    assert.equal(existsSync(externalPath), true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery hashes traversal-like Blob ids into the activation staging root", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-traversal-id-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    mkdirSync(join(mediaRoot, "artifacts", "videos"), { recursive: true });
    const sourcePath = join(mediaRoot, "source.mp4");
    const targetPath = join(mediaRoot, "artifacts", "videos", "target.mp4");
    copyFileSync(VIDEO_FIXTURE, sourcePath);
    const fixture = insertUnsafeRecoveryFixture(db, mediaRoot, targetPath, sourcePath, "../../outside/stage-name");
    let observedStage = "";
    const recovered = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.artifact.linked_objects.project_id,
      shot_id: fixture.artifact.linked_objects.shot_id,
      source_path: fixture.source_path
    }, db, {
      after_staged_copy: () => {
        const stagingRoot = resolve(mediaRoot, ".activation", "staging");
        const entries = readdirSync(stagingRoot).filter((name) => /^blob-recovery-[a-f0-9]{64}\.staged$/i.test(name));
        assert.equal(entries.length, 1);
        observedStage = resolve(stagingRoot, entries[0]);
        assert.equal(dirname(observedStage), stagingRoot);
      }
    });
    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
    assert.match(basename(observedStage), /^blob-recovery-[a-f0-9]{64}\.staged$/i);
    assert.equal(existsSync(resolve(root, "outside")), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery rejects an activation staging root redirected outside its media root", (context) => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-outside-stage-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const stagingRoot = join(mediaRoot, ".activation", "staging");
    const externalRoot = join(root, "external-staging");
    mkdirSync(externalRoot);
    const sentinel = join(externalRoot, "sentinel.txt");
    writeFileSync(sentinel, "preserve", "utf8");
    rmSync(stagingRoot, { recursive: true });
    try { symlinkSync(externalRoot, stagingRoot, "junction"); }
    catch (error) {
      context.skip(`Directory symlinks are unavailable: ${error instanceof Error ? error.message : "SYMLINK_UNAVAILABLE"}`);
      return;
    }
    rmSync(fixture.artifact.storage.uri);

    const blocked = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.equal(readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Blob recovery narrows legacy random staging cleanup to safe generated files", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-blob-recovery-legacy-stage-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = createRecoverableVideo(db, mediaRoot);
    const before = immutableBlobSnapshot(db, fixture.artifact.artifact_id);
    const targetDirectory = dirname(fixture.artifact.storage.uri);
    const legacyPath = join(targetDirectory, `blob-recovery-${randomUUID()}.staged`);
    const unmatchedPath = join(targetDirectory, "blob-recovery-not-a-uuid.staged");
    const nonCanonicalPath = join(targetDirectory, `blob-recovery-${"a".repeat(36)}.staged`);
    const mismatchedPath = join(targetDirectory, `blob-recovery-${randomUUID()}.staged`);
    rmSync(fixture.artifact.storage.uri);
    linkSync(fixture.source_path, legacyPath);

    const blocked = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.equal(existsSync(legacyPath), true);

    rmSync(legacyPath);
    writeFileSync(nonCanonicalPath, "preserve-noncanonical", "utf8");
    writeFileSync(mismatchedPath, "preserve-mismatched", "utf8");
    const mismatched = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.error.code, "MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    assert.equal(readFileSync(mismatchedPath, "utf8"), "preserve-mismatched");
    assert.equal(readFileSync(nonCanonicalPath, "utf8"), "preserve-noncanonical");

    rmSync(mismatchedPath);
    copyFileSync(fixture.source_path, legacyPath);
    writeFileSync(unmatchedPath, "preserve", "utf8");
    const recovered = recoverVerifiedBlobStorage({
      invalid_artifact_id: fixture.artifact.artifact_id,
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      source_path: fixture.source_path
    }, db);
    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error.code);
    assert.equal(existsSync(legacyPath), false);
    assert.equal(readFileSync(unmatchedPath, "utf8"), "preserve");
    assert.equal(readFileSync(nonCanonicalPath, "utf8"), "preserve-noncanonical");
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.deepEqual(immutableBlobSnapshot(db, fixture.artifact.artifact_id), before);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
