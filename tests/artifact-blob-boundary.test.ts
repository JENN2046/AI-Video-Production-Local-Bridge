import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { M0_BASE_SCHEMA_SQL, runDatabaseMigrations, SchemaMigrationRequiredError } from "../src/storage/migrations.js";
import { migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { applyWorkbenchV24Baseline } from "../src/storage/workbenchV2Schema.js";
import {
  attachArtifactToShot,
  createScopedArtifactFromBlob,
  getMediaArtifact,
  getMediaBlob,
  registerMediaArtifact
} from "../src/tools/mediaArtifacts.js";
import { createProject, getShot, saveProject, saveShot, type Project, type Shot } from "../src/tools/projects.js";
import { getWorkbenchProjectWorkspace, updateWorkbenchShot } from "../src/tools/workbenchV2.js";
import { getProductionProjectContext } from "../src/webgpt-v4/domain.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai-video-artifact-blob-"));
}

function createProjectShot(db: M0Database, suffix: string): { project: Project; shot: Shot } {
  const created = createProject({ title: `Project ${suffix}` }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROJECT_SETUP_FAILED");
  const shot: Shot = {
    shot_id: `shot_${suffix}`,
    project_id: created.project_id,
    order: 1,
    status: "draft",
    duration_seconds: 6,
    description: suffix,
    storyboard_image_artifact_id: "",
    video_prompt: "Move gently",
    negative_prompt: "",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  created.project.shot_ids = [shot.shot_id];
  saveProject(db, created.project);
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
  return { project: created.project, shot };
}

function registerSource(db: M0Database) {
  const registered = registerMediaArtifact({
    artifact_type: "image",
    role: "storyboard_image",
    source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
    metadata: { aspect_ratio: "9:16" }
  }, db);
  if (!registered.ok) throw new Error(registered.error.code);
  assert.equal(registered.ok, true);
  return registered.artifact;
}

test("identical bytes deduplicate blobs while project and SHOT Artifacts remain immutable", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    const first = createProjectShot(db, "a");
    const second = createProjectShot(db, "b");
    const source = registerSource(db);
    const scopedA = createScopedArtifactFromBlob({ source_artifact_id: source.artifact_id, project_id: first.project.project_id, shot_id: first.shot.shot_id }, db);
    const scopedB = createScopedArtifactFromBlob({ source_artifact_id: source.artifact_id, project_id: second.project.project_id, shot_id: second.shot.shot_id }, db);
    assert.equal(scopedA.ok, true);
    assert.equal(scopedB.ok, true);
    if (!scopedA.ok || !scopedB.ok) throw new Error("SCOPE_SETUP_FAILED");
    assert.notEqual(scopedA.artifact.artifact_id, scopedB.artifact.artifact_id);
    assert.equal(scopedA.artifact.blob_id, scopedB.artifact.blob_id);
    assert.equal(getMediaBlob(db, scopedA.artifact.blob_id)?.integrity_state, "verified");

    const attachA = attachArtifactToShot({ project_id: first.project.project_id, shot_id: first.shot.shot_id, artifact_id: scopedA.artifact.artifact_id, reference: "storyboard_image_artifact_id", expected_current_artifact_id: "" }, db);
    const attachB = attachArtifactToShot({ project_id: second.project.project_id, shot_id: second.shot.shot_id, artifact_id: scopedB.artifact.artifact_id, reference: "storyboard_image_artifact_id", expected_current_artifact_id: "" }, db);
    assert.equal(attachA.ok, true);
    assert.equal(attachB.ok, true);

    assert.throws(() => db.prepare("UPDATE media_artifacts SET project_id = ? WHERE artifact_id = ?").run(second.project.project_id, scopedA.artifact.artifact_id), /MEDIA_ARTIFACT_IDENTITY_IMMUTABLE/);
    assert.throws(() => db.prepare("UPDATE media_artifacts SET role = 'generated_clip', artifact_type = 'video' WHERE artifact_id = ?").run(scopedA.artifact.artifact_id), /MEDIA_ARTIFACT_IDENTITY_IMMUTABLE/);
    assert.throws(() => db.prepare("UPDATE media_blobs SET size_bytes = size_bytes + 1 WHERE blob_id = ?").run(scopedA.artifact.blob_id), /MEDIA_BLOB_IMMUTABLE/);
    db.prepare(`INSERT INTO media_blobs
      (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
      VALUES ('blob_alternate_verified', ?, 1, 'image/png', 'synthetic-test-only', 'verified', '{}')`).run("f".repeat(64));
    assert.throws(() => db.prepare("UPDATE media_artifact_blobs SET blob_id = 'blob_alternate_verified' WHERE artifact_id = ?").run(scopedA.artifact.artifact_id), /MEDIA_ARTIFACT_BLOB_IMMUTABLE/);
    assert.throws(() => db.prepare("DELETE FROM media_artifact_blobs WHERE artifact_id = ?").run(scopedA.artifact.artifact_id), /MEDIA_ARTIFACT_BLOB_IMMUTABLE/);
    assert.throws(() => db.prepare("UPDATE media_artifacts SET status = 'pending_upload' WHERE artifact_id = ?").run(scopedA.artifact.artifact_id), /INVALID_ARTIFACT_STATUS_TRANSITION/);

    const workbench = getWorkbenchProjectWorkspace(first.project.project_id, "storyboard", db, { touch_last_opened: false });
    assert.equal(workbench.ok, true);
    const webgpt = getProductionProjectContext({ project_id: first.project.project_id, workspace: "storyboard" }, db);
    assert.equal(webgpt.ok, true);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-SHOT reuse and stale concurrent binding attempts fail closed", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    const first = createProjectShot(db, "one");
    const secondShot: Shot = { ...first.shot, shot_id: "shot_two", order: 2 };
    saveShot(db, secondShot);
    const source = registerSource(db);
    const firstScoped = createScopedArtifactFromBlob({ source_artifact_id: source.artifact_id, project_id: first.project.project_id, shot_id: first.shot.shot_id }, db);
    const alternateScoped = createScopedArtifactFromBlob({ source_artifact_id: source.artifact_id, project_id: first.project.project_id, shot_id: first.shot.shot_id }, db);
    assert.equal(firstScoped.ok, true);
    assert.equal(alternateScoped.ok, true);
    if (!firstScoped.ok || !alternateScoped.ok) throw new Error("SCOPE_SETUP_FAILED");

    const crossShot = attachArtifactToShot({ project_id: first.project.project_id, shot_id: secondShot.shot_id, artifact_id: firstScoped.artifact.artifact_id, reference: "storyboard_image_artifact_id", expected_current_artifact_id: "" }, db);
    assert.equal(crossShot.ok, false);
    if (!crossShot.ok) assert.equal(crossShot.error.code, "INVALID_ARTIFACT_BINDING");

    const winner = attachArtifactToShot({ project_id: first.project.project_id, shot_id: first.shot.shot_id, artifact_id: firstScoped.artifact.artifact_id, reference: "storyboard_image_artifact_id", expected_current_artifact_id: "" }, db);
    const stale = attachArtifactToShot({ project_id: first.project.project_id, shot_id: first.shot.shot_id, artifact_id: alternateScoped.artifact.artifact_id, reference: "storyboard_image_artifact_id", expected_current_artifact_id: "" }, db);
    assert.equal(winner.ok, true);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "CONFLICT_STALE_ARTIFACT_REFERENCE");
    assert.equal(getShot(db, first.shot.shot_id)?.storyboard_image_artifact_id, firstScoped.artifact.artifact_id);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Workbench preserves copy changes when it atomically scopes and attaches an Artifact", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    const target = createProjectShot(db, "combined");
    const source = registerSource(db);
    const result = updateWorkbenchShot(target.project.project_id, target.shot.shot_id, {
      storyboard_image_artifact_id: source.artifact_id,
      description: "Updated description",
      video_prompt: "Updated prompt",
      negative_prompt: "Updated negative",
      duration_seconds: 8
    }, db);
    if (!result.ok) throw new Error(result.error.code);
    assert.equal(result.ok, true);
    assert.notEqual(result.data.shot.storyboard_image_artifact_id, source.artifact_id);
    assert.equal(result.data.shot.description, "Updated description");
    assert.equal(result.data.shot.video_prompt, "Updated prompt");
    assert.equal(result.data.shot.negative_prompt, "Updated negative");
    assert.equal(result.data.shot.duration_seconds, 8);
    assert.deepEqual(getShot(db, target.shot.shot_id), result.data.shot);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed SHOT binding rolls back without changing the reference", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    const target = createProjectShot(db, "rollback");
    const source = registerSource(db);
    const scoped = createScopedArtifactFromBlob({ source_artifact_id: source.artifact_id, project_id: target.project.project_id, shot_id: target.shot.shot_id }, db);
    assert.equal(scoped.ok, true);
    if (!scoped.ok) throw new Error("SCOPE_SETUP_FAILED");
    db.exec(`CREATE TRIGGER fail_test_artifact_attach BEFORE UPDATE ON shots
      WHEN NEW.shot_id = 'shot_rollback' BEGIN SELECT RAISE(ABORT, 'FAULT_INJECTED_ATTACH'); END`);
    const result = attachArtifactToShot({ project_id: target.project.project_id, shot_id: target.shot.shot_id, artifact_id: scoped.artifact.artifact_id, reference: "storyboard_image_artifact_id", expected_current_artifact_id: "" }, db);
    assert.equal(result.ok, false);
    assert.equal(getShot(db, target.shot.shot_id)?.storyboard_image_artifact_id, "");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifact_blobs WHERE artifact_id = ?").get(scoped.artifact.artifact_id) as { count: number }).count, 1);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped Artifact creation and SHOT attachment roll back as one transaction", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    const target = createProjectShot(db, "atomic");
    const source = registerSource(db);
    const before = Number((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count);
    db.exec(`CREATE TRIGGER fail_atomic_artifact_attach BEFORE UPDATE ON shots
      WHEN NEW.shot_id = 'shot_atomic' BEGIN SELECT RAISE(ABORT, 'FAULT_INJECTED_ATOMIC_ATTACH'); END`);
    const result = updateWorkbenchShot(target.project.project_id, target.shot.shot_id, { storyboard_image_artifact_id: source.artifact_id }, db);
    assert.equal(result.ok, false);
    assert.equal(getShot(db, target.shot.shot_id)?.storyboard_image_artifact_id, "");
    const after = Number((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count);
    assert.equal(after, before);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2-4 migration derives Blob facts from local bytes and fails closed on structured drift", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "legacy.sqlite");
    const mediaPath = join(root, "legacy.png");
    copyFileSync(resolve("fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png"), mediaPath);
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    applyWorkbenchV24Baseline(db);
    const artifact = {
      artifact_id: "artifact_legacy",
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: mediaPath, mime_type: "application/octet-stream", filename: "legacy.png" },
      metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256: "legacy-json-value" },
      linked_objects: { project_id: "", shot_id: "" },
      source: { kind: "local_file_import", provider: "", provider_job_id: "", sha256: "legacy-json-value", external_url_host: "" }
    };
    db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, ?, ?, ?, ?)")
      .run(artifact.artifact_id, artifact.role, artifact.artifact_type, artifact.status, JSON.stringify(artifact));
    const remoteArtifact = {
      ...artifact,
      artifact_id: "artifact_remote_legacy",
      storage: { ...artifact.storage, uri: "https://media.example.test/legacy.png" }
    };
    const missingArtifact = {
      ...artifact,
      artifact_id: "artifact_missing_legacy",
      storage: { ...artifact.storage, uri: join(root, "missing.png") }
    };
    const duplicateArtifact = { ...artifact, artifact_id: "artifact_legacy_duplicate" };
    for (const candidate of [remoteArtifact, missingArtifact, duplicateArtifact]) {
      db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, ?, ?, ?, ?)")
        .run(candidate.artifact_id, candidate.role, candidate.artifact_type, candidate.status, JSON.stringify(candidate));
    }
    const result = runDatabaseMigrations(db);
    assert.deepEqual(result.applied, ["0001", "0002", "0003", "0004", "0005", "0006"]);
    const migrated = getMediaArtifact(db, artifact.artifact_id);
    assert.equal(migrated?.status, "active");
    assert.equal(migrated?.metadata.sha256, "legacy-json-value");
    const blob = migrated ? getMediaBlob(db, migrated.blob_id) : null;
    assert.equal(blob?.integrity_state, "verified");
    assert.equal(blob?.sha256.length, 64);
    assert.equal(blob?.size_bytes > 0, true);
    const duplicate = getMediaArtifact(db, duplicateArtifact.artifact_id);
    assert.equal(duplicate?.blob_id, migrated?.blob_id);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_blobs WHERE integrity_state = 'verified'").get() as { count: number }).count, 1);
    const remote = getMediaArtifact(db, remoteArtifact.artifact_id);
    const missing = getMediaArtifact(db, missingArtifact.artifact_id);
    assert.equal(remote?.status, "inaccessible");
    assert.equal(missing?.status, "inaccessible");
    assert.equal(remote ? getMediaBlob(db, remote.blob_id)?.integrity_state : null, "unverified");
    assert.equal(missing ? getMediaBlob(db, missing.blob_id)?.integrity_state : null, "missing");
    db.close();

    const driftPath = join(root, "drift.sqlite");
    const drift = new DatabaseSync(driftPath);
    drift.exec(M0_BASE_SCHEMA_SQL);
    applyWorkbenchV24Baseline(drift);
    drift.prepare("INSERT INTO media_artifacts (artifact_id, project_id, role, artifact_type, status, data_json) VALUES ('artifact_drift', 'project_row', 'storyboard_image', 'image', 'active', ?)")
      .run(JSON.stringify({ ...artifact, artifact_id: "artifact_drift", linked_objects: { project_id: "project_json", shot_id: "" } }));
    assert.throws(() => runDatabaseMigrations(drift), (error) => error instanceof SchemaMigrationRequiredError && /ARTIFACT_STRUCTURED_DRIFT/.test(error.message));
    drift.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
