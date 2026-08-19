import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { paths } from "../src/paths.js";
import {
  activateLocalMediaArtifact,
  discardMediaActivationMarkers,
  getMediaArtifact,
  getMediaBlob,
  persistMediaArtifact,
  recoverMediaActivations,
  recoverVerifiedBlobStorage,
  registerMediaArtifact,
  verifyMediaArtifactBytes,
  type MediaArtifact,
  type VerifiedBlobStorageRecoveryFaults
} from "../src/tools/mediaArtifacts.js";
import { buildStoryboardApprovedShot, createProject, saveShot } from "../src/tools/projects.js";
import { buildRunningHubMediaUploadRequest } from "../src/tools/videoProviderAdapters.js";
import {
  completeWorkbenchAssemblyFixture,
  ensureAcceptedAssemblyClipsFixture
} from "./workbench-delivery-test-helpers.js";

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

function recursiveEntries(root: string): string[] {
  return existsSync(root) ? readdirSync(root, { recursive: true }).map(String).sort() : [];
}

function insertUnsafeRecoveryFixture(
  db: M0Database,
  registeredRoot: string,
  targetPath: string,
  sourcePath: string
): { artifact: MediaArtifact; source_path: string } {
  const scope = createRecoveryProjectShot(db);
  const bytes = readFileSync(VIDEO_FIXTURE);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = `artifact_${randomUUID()}`;
  const blobId = `blob_recovery_${randomUUID()}`;
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
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.quarantined_media_activations, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation rollback persists a failed Journal after dependent persistence rejects the Artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "media-activation-dependent-rollback-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  const artifact = preparedArtifact();
  artifact.storage.uri = join(mediaRoot, "artifacts", "images", `${artifact.artifact_id}.png`);
  artifact.storage.filename = `${artifact.artifact_id}.png`;
  try {
    const result = activateLocalMediaArtifact({
      artifact,
      source_path: IMAGE_FIXTURE,
      media_root: mediaRoot,
      after_artifact_persist: () => ({
        code: "DELIVERY_REWORK_REQUIRED",
        message: "Synthetic dependent persistence rejection."
      })
    }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DELIVERY_REWORK_REQUIRED");
    assert.equal(getMediaArtifact(db, artifact.artifact_id), null);
    const journal = db.prepare(`SELECT activation_id, state, error_code FROM media_activation_journal
      WHERE artifact_id = ?`).get(artifact.artifact_id) as {
        activation_id: string;
        state: string;
        error_code: string;
      };
    assert.deepEqual({ state: journal.state, error_code: journal.error_code }, {
      state: "failed",
      error_code: "DELIVERY_REWORK_REQUIRED"
    });
    assert.equal(existsSync(join(paths.mediaActivationJournalRoot, `${journal.activation_id}.json`)), false);
    const quarantinePath = join(mediaRoot, ".activation", "quarantine", `${artifact.artifact_id}.png.failed`);
    assert.equal(readFileSync(quarantinePath).equals(readFileSync(IMAGE_FIXTURE)), true);
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.quarantined_media_activations, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery-referenced final Artifact content and Blob binding fail closed before activation side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "media-delivery-evidence-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const project = createProject({ title: "Immutable delivery evidence" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("DELIVERY_EVIDENCE_PROJECT_SETUP_FAILED");
    const artifactId = `artifact_${randomUUID()}`;
    const prepared: MediaArtifact = {
      artifact_id: artifactId,
      blob_id: "",
      artifact_type: "video",
      role: "final_video",
      status: "active",
      storage: {
        uri: join(mediaRoot, "artifacts", "videos", `${artifactId}.mp4`),
        mime_type: "video/mp4",
        filename: `${artifactId}.mp4`
      },
      metadata: { width: 1080, height: 1920, duration_seconds: 2, aspect_ratio: "9:16", sha256: "" },
      linked_objects: { project_id: project.project_id, shot_id: "" },
      source: {
        kind: "synthetic_fixture",
        provider: "",
        provider_job_id: "",
        sha256: "",
        external_url_host: ""
      }
    };
    const activated = activateLocalMediaArtifact({ artifact: prepared, source_path: VIDEO_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
    if (!activated.ok) throw new Error("DELIVERY_EVIDENCE_ACTIVATION_SETUP_FAILED");

    const now = "2026-08-17T00:00:00.000Z";
    ensureAcceptedAssemblyClipsFixture(db, project.project_id);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, project.project_id);
    completeWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      artifact_id: artifactId,
      job_id: "job_immutable_delivery_assembly",
      event_id: "event_immutable_delivery_assembly",
      created_at: now
    });

    const artifactBefore = { ...(db.prepare("SELECT data_json, status FROM media_artifacts WHERE artifact_id = ?").get(artifactId) as Record<string, unknown>) };
    const bindingBefore = { ...(db.prepare("SELECT artifact_id, blob_id FROM media_artifact_blobs WHERE artifact_id = ?").get(artifactId) as Record<string, unknown>) };
    const journalCountBefore = Number((db.prepare("SELECT COUNT(*) AS count FROM media_activation_journal").get() as { count: number }).count);
    const blobCountBefore = Number((db.prepare("SELECT COUNT(*) AS count FROM media_blobs").get() as { count: number }).count);
    const entriesBefore = recursiveEntries(mediaRoot);
    const mutated = structuredClone(activated.artifact);
    mutated.metadata.aspect_ratio = "1:1";
    mutated.storage.uri = join(mediaRoot, "artifacts", "videos", `${artifactId}-replacement.mp4`);

    const blockedActivation = activateLocalMediaArtifact({ artifact: mutated, source_path: VIDEO_FIXTURE, media_root: mediaRoot }, db);
    assert.equal(blockedActivation.ok, false);
    if (!blockedActivation.ok) assert.equal(blockedActivation.error.code, "WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE");
    assert.deepEqual(recursiveEntries(mediaRoot), entriesBefore);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM media_activation_journal").get() as { count: number }).count), journalCountBefore);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM media_blobs").get() as { count: number }).count), blobCountBefore);

    assert.throws(() => persistMediaArtifact(db, mutated), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    assert.throws(() => db.prepare(`UPDATE media_artifacts SET data_json = json_set(data_json, '$.metadata.aspect_ratio', '1:1')
      WHERE artifact_id = ?`).run(artifactId), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    assert.deepEqual({ ...(db.prepare("SELECT data_json, status FROM media_artifacts WHERE artifact_id = ?").get(artifactId) as Record<string, unknown>) }, artifactBefore);

    db.prepare(`INSERT INTO media_blobs
      (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
      VALUES ('blob_delivery_replacement', ?, 1, 'video/mp4', 'synthetic-test-only', 'verified', '{}')`)
      .run("f".repeat(64));
    const genericBlobGuard = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'media_artifact_blob_transition'")
      .get() as { sql: string };
    db.exec("DROP TRIGGER media_artifact_blob_transition");
    try {
      assert.throws(() => db.prepare(`UPDATE media_artifact_blobs SET blob_id = 'blob_delivery_replacement'
        WHERE artifact_id = ?`).run(artifactId), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    } finally {
      db.exec(genericBlobGuard.sql);
    }
    assert.deepEqual({ ...(db.prepare("SELECT artifact_id, blob_id FROM media_artifact_blobs WHERE artifact_id = ?").get(artifactId) as Record<string, unknown>) }, bindingBefore);
    assert.deepEqual(recursiveEntries(mediaRoot), entriesBefore);
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
        }, contenderDb));
      }
    });
    assert.equal(first.ok, true, first.ok ? undefined : first.error.code);
    assert.equal(contenderResults.length, 1);
    const contender = contenderResults[0];
    assert.equal(contender.ok, false);
    if (!contender.ok) assert.equal(contender.error.code, "MEDIA_BLOB_RECOVERY_FAILED");

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
