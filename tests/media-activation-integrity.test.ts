import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { paths } from "../src/paths.js";
import {
  activateLocalMediaArtifact,
  discardMediaActivationMarkers,
  getMediaArtifact,
  recoverMediaActivations,
  registerMediaArtifact,
  verifyMediaArtifactBytes,
  type MediaArtifact
} from "../src/tools/mediaArtifacts.js";
import { buildRunningHubMediaUploadRequest } from "../src/tools/videoProviderAdapters.js";

const IMAGE_FIXTURE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");

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
