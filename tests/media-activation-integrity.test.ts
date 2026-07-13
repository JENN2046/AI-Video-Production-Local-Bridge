import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const checked = checkDatabase(sqlitePath);
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
