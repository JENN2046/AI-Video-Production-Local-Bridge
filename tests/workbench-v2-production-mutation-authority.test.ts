import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DATABASE_MIGRATIONS, migrationChecksum } from "../src/storage/migrations.js";
import {
  installWorkbenchProductionMutationAuthority,
  withWorkbenchProductionMutationAuthority,
  type WorkbenchProductionMutationCapability
} from "../src/storage/productionMutationAuthority.js";
import { openM0Database, openM0DatabaseConnection, type M0Database } from "../src/storage/sqlite.js";
import { g0ProjectRoot, prepareG0ArtifactWrite, readG0Artifact, saveG0Artifact } from "../src/tools/g0Pregen.js";
import {
  attachArtifactToShot,
  persistMediaArtifact,
  registerMediaArtifact,
  transitionMediaArtifactStatus,
  type MediaArtifact
} from "../src/tools/mediaArtifacts.js";
import {
  buildStoryboardApprovedShot,
  createProject,
  getProject,
  getShot,
  saveProject,
  saveShot,
  type Project,
  type Shot
} from "../src/tools/projects.js";
import { saveStoryboardPackage, type StoryboardPackage } from "../src/tools/storyboardPackages.js";
import { decideWorkbenchPendingAction } from "../src/tools/workbenchInbox.js";
import { getWorkbenchPendingActionRecord, saveWorkbenchPendingActionRecord } from "../src/tools/workbenchInboxStore.js";
import { saveGenerationRun, type GenerationRun } from "../src/tools/generation.js";
import {
  getWorkbenchDeliveryState,
  refreshWorkbenchAssemblyReadiness,
  WorkbenchProductionMutationError,
  workbenchProductionMutationError
} from "../src/tools/workbenchDeliveryState.js";
import { createWorkbenchProject, updateWorkbenchProject, type WorkbenchProjectClassification } from "../src/tools/workbenchV2.js";
import { updateProductionShotCopy } from "../src/webgpt-v4/domain.js";
import { actorFromSubject } from "../src/webgpt-v4/types.js";

type SeededState = "not_ready" | "assembling" | "final_review" | "revision_requested" | "approved" | "exported" | "closed" | "legacy_review_required";

interface AuthorityFixture {
  db: M0Database;
  project: Project;
  shot: Shot;
  artifact?: MediaArtifact;
}

function applyMigrationsThrough(db: DatabaseSync, through: string): void {
  installWorkbenchProductionMutationAuthority(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    BEGIN EXCLUSIVE;
  `);
  try {
    for (const migration of DATABASE_MIGRATIONS.filter((candidate) => candidate.id <= through)) {
      const applied = db.prepare("SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?")
        .get(migration.id) as { present: number } | undefined;
      if (applied) continue;
      migration.apply(db);
      db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
        .run(migration.id, migration.name, migrationChecksum(migration));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertVerifiedBlob(db: M0Database, blobId: string, digestCharacter: string): void {
  db.prepare(`
    INSERT INTO media_blobs
      (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, 16, 'video/mp4', ?, 'verified', '{}')
  `).run(blobId, digestCharacter.repeat(64), `fixture://${blobId}.mp4`);
}

function persistAcceptedClip(db: M0Database, projectId: string, shotId: string, suffix = "a"): MediaArtifact {
  const blobId = `blob_clip_${suffix}`;
  const artifactId = `artifact_clip_${suffix}`;
  insertVerifiedBlob(db, blobId, suffix.slice(0, 1));
  const artifact: MediaArtifact = {
    artifact_id: artifactId,
    blob_id: blobId,
    artifact_type: "video",
    role: "generated_clip",
    status: "active",
    storage: { uri: `fixture://${artifactId}.mp4`, mime_type: "video/mp4", filename: `${artifactId}.mp4` },
    metadata: { width: 1080, height: 1920, duration_seconds: 2, aspect_ratio: "9:16", sha256: suffix.slice(0, 1).repeat(64) },
    linked_objects: { project_id: projectId, shot_id: shotId },
    source: { kind: "synthetic_fixture", provider: "", provider_job_id: "", sha256: suffix.slice(0, 1).repeat(64), external_url_host: "" }
  };
  persistMediaArtifact(db, artifact);
  return artifact;
}

function seedAuthorityFixture(state: SeededState = "not_ready", includeArtifact = false): AuthorityFixture {
  const db = new DatabaseSync(":memory:");
  applyMigrationsThrough(db, "0012");
  const created = createProject({ title: `Authority ${state}` }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROJECT_FIXTURE_FAILED");
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?")
    .run(created.project_id);
  let shot = buildStoryboardApprovedShot({
    shot_id: `shot_${state}`,
    project_id: created.project_id,
    order: 1,
    duration_seconds: 2,
    storyboard_image_artifact_id: "",
    video_prompt: "A governed production SHOT"
  });
  db.prepare("INSERT INTO shots (shot_id, project_id, data_json) VALUES (?, ?, ?)")
    .run(shot.shot_id, shot.project_id, JSON.stringify(shot));
  created.project.shot_ids = [shot.shot_id];
  db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?")
    .run(JSON.stringify(created.project), created.project_id);
  const artifact = includeArtifact ? persistAcceptedClip(db, created.project_id, shot.shot_id, state.slice(0, 1)) : undefined;
  if (artifact) {
    shot = {
      ...shot,
      status: "video_review",
      clip_versions: [{ artifact_id: artifact.artifact_id, run_id: "run_seeded", attempt_number: 1, review_status: "pending" }]
    };
    saveShot(db, shot);
  }
  if (state !== "not_ready") {
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = ? WHERE project_id = ?")
      .run(state, created.project_id);
  }
  applyMigrationsThrough(db, "0013");
  return { db, project: created.project, shot, artifact };
}

function currentFixture(includeAcceptedClip = false): AuthorityFixture {
  const db = openM0Database(":memory:");
  const created = createProject({ title: "Current authority" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROJECT_FIXTURE_FAILED");
  let shot = buildStoryboardApprovedShot({
    shot_id: "shot_current_authority",
    project_id: created.project_id,
    order: 1,
    duration_seconds: 2,
    storyboard_image_artifact_id: "",
    video_prompt: "Current governed SHOT"
  });
  saveShot(db, shot);
  created.project.shot_ids = [shot.shot_id];
  saveProject(db, created.project);
  const artifact = includeAcceptedClip ? persistAcceptedClip(db, created.project_id, shot.shot_id, "a") : undefined;
  if (artifact) {
    shot = {
      ...shot,
      status: "approved",
      accepted_clip_artifact_id: artifact.artifact_id,
      clip_versions: [{ artifact_id: artifact.artifact_id, run_id: "run_fixture", attempt_number: 1, review_status: "approved" }],
      review: { approval_status: "approved", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
  }
  return { db, project: created.project, shot, artifact };
}

function readyFixtureWithFingerprint(): AuthorityFixture {
  const db = new DatabaseSync(":memory:");
  applyMigrationsThrough(db, "0012");
  const created = createProject({ title: "Ready fingerprint authority" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROJECT_FIXTURE_FAILED");
  let shot = buildStoryboardApprovedShot({
    shot_id: "shot_ready_fingerprint",
    project_id: created.project_id,
    order: 1,
    duration_seconds: 2,
    storyboard_image_artifact_id: "",
    video_prompt: "Fingerprint drift fixture"
  });
  saveShot(db, shot);
  const artifact = persistAcceptedClip(db, created.project_id, shot.shot_id, "b");
  shot = {
    ...shot,
    status: "approved",
    accepted_clip_artifact_id: artifact.artifact_id,
    clip_versions: [{ artifact_id: artifact.artifact_id, run_id: "run_fingerprint", attempt_number: 1, review_status: "approved" }],
    review: { approval_status: "approved", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  created.project.shot_ids = [shot.shot_id];
  saveProject(db, created.project);
  db.prepare(`UPDATE workbench_delivery_state
    SET workflow_state = 'ready_to_assemble', assembly_input_fingerprint = ?
    WHERE project_id = ?`).run("c".repeat(64), created.project_id);
  applyMigrationsThrough(db, "0013");
  return { db, project: created.project, shot, artifact };
}

function protectedFinalFixture(state: "final_review" | "approved" | "exported" | "legacy_review_required"): AuthorityFixture {
  const db = new DatabaseSync(":memory:");
  applyMigrationsThrough(db, "0011");
  const created = createProject({ title: `Protected final ${state}` }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROJECT_FIXTURE_FAILED");
  const shot = buildStoryboardApprovedShot({
    shot_id: `shot_final_${state}`,
    project_id: created.project_id,
    order: 1,
    duration_seconds: 2,
    storyboard_image_artifact_id: "",
    video_prompt: "Protected final fixture"
  });
  db.prepare("INSERT INTO shots (shot_id, project_id, data_json) VALUES (?, ?, ?)")
    .run(shot.shot_id, shot.project_id, JSON.stringify(shot));
  created.project.shot_ids = [shot.shot_id];
  const blobId = `blob_final_${state}`;
  insertVerifiedBlob(db, blobId, "d");
  const artifact: MediaArtifact = {
    artifact_id: `artifact_final_${state}`,
    blob_id: blobId,
    artifact_type: "video",
    role: "final_video",
    status: "active",
    storage: { uri: `fixture://${blobId}.mp4`, mime_type: "video/mp4", filename: `${blobId}.mp4` },
    metadata: { width: 1080, height: 1920, duration_seconds: 2, aspect_ratio: "9:16", sha256: "d".repeat(64) },
    linked_objects: { project_id: created.project_id, shot_id: "" },
    source: { kind: "synthetic_fixture", provider: "", provider_job_id: "", sha256: "d".repeat(64), external_url_host: "" }
  };
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, NULL, 'final_video', 'video', 'active', ?)`)
    .run(artifact.artifact_id, created.project_id, JSON.stringify(artifact));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)")
    .run(artifact.artifact_id, blobId);
  created.project.status = "final_approved";
  created.project.exports.final_video_artifact_id = artifact.artifact_id;
  db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?")
    .run(JSON.stringify(created.project), created.project_id);
  applyMigrationsThrough(db, "0012");
  db.prepare(`UPDATE workbench_delivery_state
    SET workflow_state = ?, current_final_artifact_id = ?, approved_artifact_id = ?
    WHERE project_id = ?`).run(
      state,
      artifact.artifact_id,
      state === "approved" || state === "exported" ? artifact.artifact_id : null,
      created.project_id
    );
  applyMigrationsThrough(db, "0013");
  return { db, project: created.project, shot, artifact };
}

function assertMutationError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.equal(error instanceof WorkbenchProductionMutationError, true);
    assert.equal((error as WorkbenchProductionMutationError).code, code);
    assert.equal((error as Error).message.includes("SELECT "), false);
    assert.equal((error as Error).message.includes(".sqlite"), false);
    return true;
  });
}

test("Production Mutation Authority ledger covers all 11 deferred review threads", () => {
  const ledgerPath = join(process.cwd(), "docs", "evidence", "production-mutation-authority-thread-ledger.json");
  const sourcePath = join(process.cwd(), "tests", "workbench-v2-production-mutation-authority.test.ts");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
    schema: string;
    migration: string;
    schema_version: string;
    test_file: string;
    threads: Array<{ thread: string; test_name: string; result: string }>;
  };
  const source = readFileSync(sourcePath, "utf8");
  assert.equal(ledger.schema, "production-mutation-authority-thread-ledger-v1");
  assert.equal(ledger.migration, "0013");
  assert.equal(ledger.schema_version, "workbench-v2-8");
  assert.equal(ledger.test_file, "tests/workbench-v2-production-mutation-authority.test.ts");
  const canonicalThreads = [
    "PRRT_kwDOTTDtUM6Zdye2",
    "PRRT_kwDOTTDtUM6ZeDuS",
    "PRRT_kwDOTTDtUM6Zf_Hn",
    "PRRT_kwDOTTDtUM6Zr-uA",
    "PRRT_kwDOTTDtUM6Zr-uB",
    "PRRT_kwDOTTDtUM6ZtiA7",
    "PRRT_kwDOTTDtUM6ZtiA_",
    "PRRT_kwDOTTDtUM6ZwKci",
    "PRRT_kwDOTTDtUM6Z-Tig",
    "PRRT_kwDOTTDtUM6acFed",
    "PRRT_kwDOTTDtUM6atOiW"
  ].sort();
  assert.deepEqual(ledger.threads.map((entry) => entry.thread).sort(), canonicalThreads);
  for (const entry of ledger.threads) {
    assert.equal(entry.result, "COVERED");
    assert.match(entry.thread, /^PRRT_[A-Za-z0-9_-]+$/);
    assert.equal(source.includes(`test(\"${entry.test_name}\"`), true, entry.thread);
  }
});

test("production authority capability is connection-local, object-bound, nested, synchronous, and leak-free", () => {
  const first = openM0Database(":memory:");
  const second = openM0Database(":memory:");
  const outer: WorkbenchProductionMutationCapability = { kind: "shot", project_id: "project_a", object_id: "shot_a" };
  const inner: WorkbenchProductionMutationCapability = { kind: "artifact", project_id: "project_a", object_id: "artifact_a" };
  const authorized = (db: M0Database, capability: WorkbenchProductionMutationCapability): number => Number((db.prepare(
    "SELECT workbench_production_mutation_authorized(?, ?, ?) AS allowed"
  ).get(capability.kind, capability.project_id, capability.object_id) as { allowed: number }).allowed);
  try {
    assert.equal(authorized(first, outer), 0);
    withWorkbenchProductionMutationAuthority(first, outer, () => {
      assert.equal(authorized(first, outer), 1);
      assert.equal(authorized(second, outer), 0);
      assert.equal(authorized(first, { ...outer, object_id: "shot_b" }), 0);
      withWorkbenchProductionMutationAuthority(first, inner, () => {
        assert.equal(authorized(first, outer), 0);
        assert.equal(authorized(first, inner), 1);
      });
      assert.equal(authorized(first, outer), 1);
    });
    assert.equal(authorized(first, outer), 0);
    const proxy = new Proxy(first, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as M0Database;
    withWorkbenchProductionMutationAuthority(proxy, outer, () => {
      assert.equal(authorized(first, outer), 1);
    });
    assert.equal(authorized(first, outer), 0);
    const unsafeCall = withWorkbenchProductionMutationAuthority as unknown as (
      db: M0Database, capability: WorkbenchProductionMutationCapability, action: () => unknown
    ) => unknown;
    assert.throws(() => unsafeCall(first, outer, () => Promise.resolve()), /WORKBENCH_PRODUCTION_AUTHORITY_ASYNC_FORBIDDEN/);
    assert.equal(authorized(first, outer), 0);
  } finally {
    first.close();
    second.close();
  }
});

test("migration 0013 fails atomically before freezing inconsistent 0012 production rows", () => {
  for (const drift of ["project", "shot", "package", "artifact"] as const) {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, "0012");
      const created = createProject({ title: `Migration drift ${drift}` }, db);
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error("PROJECT_FIXTURE_FAILED");
      const shot = buildStoryboardApprovedShot({
        shot_id: `shot_migration_${drift}`,
        project_id: created.project_id,
        order: 1,
        duration_seconds: 2,
        storyboard_image_artifact_id: "",
        video_prompt: "Migration precondition"
      });
      saveShot(db, shot);
      const artifact = persistAcceptedClip(db, created.project_id, shot.shot_id, "e");
      const storyboardPackage: StoryboardPackage = {
        storyboard_package_id: `package_migration_${drift}`,
        project_id: created.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [{
          shot_id: shot.shot_id,
          order: 1,
          duration_seconds: 2,
          storyboard_image_artifact_id: artifact.artifact_id,
          video_prompt: "Migration precondition"
        }],
        user_approval: { storyboard_approved: true }
      };
      saveStoryboardPackage(db, storyboardPackage);
      if (drift === "project") db.prepare("UPDATE projects SET data_json = json_set(data_json, '$.project_id', 'wrong') WHERE project_id = ?").run(created.project_id);
      if (drift === "shot") db.prepare("UPDATE shots SET data_json = json_set(data_json, '$.shot_id', 'wrong') WHERE shot_id = ?").run(shot.shot_id);
      if (drift === "package") db.prepare("UPDATE storyboard_packages SET data_json = json_set(data_json, '$.project_id', 'wrong') WHERE storyboard_package_id = ?").run(storyboardPackage.storyboard_package_id);
      if (drift === "artifact") db.prepare("UPDATE media_artifacts SET data_json = json_set(data_json, '$.status', 'inaccessible') WHERE artifact_id = ?").run(artifact.artifact_id);
      const migration = DATABASE_MIGRATIONS.find((candidate) => candidate.id === "0013");
      assert.ok(migration);
      db.exec("BEGIN EXCLUSIVE");
      assert.throws(() => migration?.apply(db), /WORKBENCH_0013_FOUNDATION_INVALID/);
      db.exec("ROLLBACK");
      assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-7");
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'workbench_projects_insert_owner'").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  }
});

test("migration 0013 clears a stale 0012 not-ready fingerprint before installing owner guards", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrationsThrough(db, "0012");
    const created = createProject({ title: "Stale 0012 fingerprint" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("PROJECT_FIXTURE_FAILED");
    db.prepare(`UPDATE workbench_delivery_state
      SET assembly_input_fingerprint = ? WHERE project_id = ?`)
      .run("f".repeat(64), created.project_id);
    applyMigrationsThrough(db, "0013");
    const migrated = getWorkbenchDeliveryState(db, created.project_id);
    assert.equal(migrated?.workflow_state, "not_ready");
    assert.equal(migrated?.assembly_input_fingerprint, null);
    assert.doesNotThrow(() => refreshWorkbenchAssemblyReadiness(db, created.project_id));
    assert.equal(getWorkbenchDeliveryState(db, created.project_id)?.assembly_input_fingerprint, null);
  } finally {
    db.close();
  }
});

test("PRRT_kwDOTTDtUM6Zdye2 WebGPT content writers require the same rework authority", () => {
  const fixture = seedAuthorityFixture("final_review");
  try {
    const row = fixture.db.prepare("SELECT updated_at FROM shots WHERE shot_id = ?").get(fixture.shot.shot_id) as { updated_at: string };
    const result = updateProductionShotCopy({
      project_id: fixture.project.project_id,
      shot_id: fixture.shot.shot_id,
      expected_updated_at: row.updated_at,
      description: "Attempted post-review rewrite"
    }, {
      actor: actorFromSubject("auth0|authority-test", ["projects.read", "shots.write"]),
      idempotency_key: "authority-webgpt-final-review"
    }, fixture.db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DELIVERY_REWORK_REQUIRED");
    assert.equal(getShot(fixture.db, fixture.shot.shot_id)?.description, fixture.shot.description);
  } finally {
    fixture.db.close();
  }
});

test("WebGPT regeneration actions cannot bypass final, closed, or active-job production authority", () => {
  for (const state of ["final_review", "closed"] as const) {
    const fixture = seedAuthorityFixture(state, true);
    try {
      const actionId = `action_regeneration_${state}`;
      saveWorkbenchPendingActionRecord({
        action_id: actionId,
        tool: "request_webgpt_regeneration",
        status: "pending",
        source: "test",
        project_id: fixture.project.project_id,
        payload: {
          project_id: fixture.project.project_id,
          shot_id: fixture.shot.shot_id,
          artifact_id: fixture.artifact?.artifact_id ?? ""
        }
      }, fixture.db);
      const result = decideWorkbenchPendingAction(actionId, { decision: "execute" }, fixture.db);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, state === "closed" ? "PROJECT_CLOSED" : "DELIVERY_REWORK_REQUIRED");
      assert.equal(getWorkbenchPendingActionRecord(actionId, fixture.db)?.status, "pending");
      assert.equal((fixture.db.prepare("SELECT COUNT(*) AS count FROM regeneration_requests WHERE project_id = ?")
        .get(fixture.project.project_id) as { count: number }).count, 0);
    } finally {
      fixture.db.close();
    }
  }

  const active = currentFixture(true);
  try {
    active.db.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
      VALUES ('job_regeneration_active', ?, 'assembly', 'queued')`).run(active.project.project_id);
    saveWorkbenchPendingActionRecord({
      action_id: "action_regeneration_active",
      tool: "request_webgpt_regeneration",
      status: "pending",
      source: "test",
      project_id: active.project.project_id,
      payload: {
        project_id: active.project.project_id,
        shot_id: active.shot.shot_id,
        artifact_id: active.artifact?.artifact_id ?? ""
      }
    }, active.db);
    const result = decideWorkbenchPendingAction("action_regeneration_active", { decision: "execute" }, active.db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DELIVERY_JOB_ACTIVE");
    assert.equal(getWorkbenchPendingActionRecord("action_regeneration_active", active.db)?.status, "pending");
    assert.equal((active.db.prepare("SELECT COUNT(*) AS count FROM regeneration_requests WHERE project_id = ?")
      .get(active.project.project_id) as { count: number }).count, 0);
  } finally {
    active.db.close();
  }
});

test("WebGPT regeneration normalizes an omitted previous run id under the owner transaction", () => {
  const fixture = currentFixture();
  try {
    const storyboard = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: fixture.project.project_id, shot_id: fixture.shot.shot_id }
    }, fixture.db);
    assert.equal(storyboard.ok, true);
    if (!storyboard.ok) throw new Error("STORYBOARD_FIXTURE_FAILED");
    const clip = registerMediaArtifact({
      artifact_type: "video",
      role: "generated_clip",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: fixture.project.project_id, shot_id: fixture.shot.shot_id }
    }, fixture.db);
    assert.equal(clip.ok, true);
    if (!clip.ok) throw new Error("CLIP_FIXTURE_FAILED");
    fixture.shot.status = "video_review";
    fixture.shot.storyboard_image_artifact_id = storyboard.artifact.artifact_id;
    fixture.shot.accepted_clip_artifact_id = "";
    fixture.shot.review.approval_status = "revision_needed";
    fixture.shot.clip_versions = [{
      artifact_id: clip.artifact.artifact_id,
      run_id: "run_current_regeneration",
      attempt_number: 1,
      review_status: "rejected"
    }];
    saveShot(fixture.db, fixture.shot);
    const run: GenerationRun = {
      run_id: "run_current_regeneration",
      batch_id: "",
      project_id: fixture.project.project_id,
      shot_id: fixture.shot.shot_id,
      run_type: "image_to_video",
      status: "succeeded",
      input: {
        storyboard_image_artifact_id: storyboard.artifact.artifact_id,
        video_prompt: fixture.shot.video_prompt,
        negative_prompt: fixture.shot.negative_prompt,
        duration_seconds: fixture.shot.duration_seconds,
        aspect_ratio: "9:16",
        resolution: "1080x1920"
      },
      output: { artifact_ids: [clip.artifact.artifact_id] },
      provider: { provider: "mock", provider_name: "mock", model_name: "mock", provider_job_id: "mock-regeneration", provider_status: "succeeded" },
      versioning: { attempt_number: 1, parent_run_id: "" },
      error: { code: "", message: "", retryable: false }
    };
    saveGenerationRun(fixture.db, run);
    saveWorkbenchPendingActionRecord({
      action_id: "action_regeneration_current",
      tool: "request_webgpt_regeneration",
      status: "pending",
      source: "test",
      project_id: fixture.project.project_id,
      payload: {
        project_id: fixture.project.project_id,
        shot_id: fixture.shot.shot_id,
        artifact_id: clip.artifact.artifact_id
      }
    }, fixture.db);
    const result = decideWorkbenchPendingAction("action_regeneration_current", { decision: "execute" }, fixture.db);
    assert.equal(result.ok, true, JSON.stringify(result));
    const request = fixture.db.prepare("SELECT previous_run_id, data_json FROM regeneration_requests WHERE project_id = ?")
      .get(fixture.project.project_id) as { previous_run_id: string; data_json: string };
    assert.equal(request.previous_run_id, "");
    assert.equal((JSON.parse(request.data_json) as { previous_run_id: string }).previous_run_id, "");
  } finally {
    fixture.db.close();
  }
});

test("PRRT_kwDOTTDtUM6ZeDuS G0 writes fail before filesystem or database effects", () => {
  const fixture = seedAuthorityFixture("closed");
  const root = g0ProjectRoot(fixture.project.project_id);
  try {
    assert.equal(existsSync(root), false);
    const result = saveG0Artifact({
      project_id: fixture.project.project_id,
      kind: "creative_brief",
      payload: { objective: "must not be written" }
    }, fixture.db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PROJECT_CLOSED");
    assert.equal(existsSync(root), false);
    assert.deepEqual(getProject(fixture.db, fixture.project.project_id)?.brief, {});
  } finally {
    fixture.db.close();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

test("G0 prepared writes require a live owned transaction before creating filesystem state", () => {
  const fixture = currentFixture();
  const root = g0ProjectRoot(fixture.project.project_id);
  try {
    assert.equal(existsSync(root), false);
    assert.throws(() => prepareG0ArtifactWrite({
      project_id: fixture.project.project_id,
      kind: "creative_brief",
      payload: { objective: "unsafe deferred placement" }
    }, fixture.db), /G0_TRANSACTION_UNSAFE/);
    assert.equal(existsSync(root), false);
  } finally {
    fixture.db.close();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

test("G0 retains target and backup evidence when commit outcome or database rollback is uncertain", () => {
  for (const mode of ["commit_after_apply", "rollback_failed"] as const) {
    const fixture = currentFixture();
    const root = g0ProjectRoot(fixture.project.project_id);
    try {
      const seeded = saveG0Artifact({
        project_id: fixture.project.project_id,
        kind: "creative_brief",
        payload: { revision: "before" }
      }, fixture.db);
      assert.equal(seeded.ok, true, mode);

      const faulting = new Proxy(fixture.db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string): void => {
              if (sql === "COMMIT") {
                if (mode === "commit_after_apply") target.exec(sql);
                throw Object.assign(new Error("injected commit failure"), { code: "SQLITE_IOERR" });
              }
              if (sql === "ROLLBACK" && mode === "rollback_failed") {
                throw Object.assign(new Error("injected rollback failure"), { code: "SQLITE_IOERR" });
              }
              target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as M0Database;
      const result = saveG0Artifact({
        project_id: fixture.project.project_id,
        kind: "creative_brief",
        payload: { revision: "after" }
      }, faulting);
      assert.equal(result.ok, false, mode);
      if (!result.ok) assert.equal(result.error.code, "G0_ARTIFACT_RECOVERY_REQUIRED", mode);
      assert.deepEqual(readG0Artifact(fixture.project.project_id, "creative_brief")?.payload, { revision: "after" }, mode);
      assert.equal(readdirSync(root).some((entry) => entry.startsWith(".creative_brief.json.") && entry.endsWith(".backup")), true, mode);

      if (mode === "commit_after_apply") {
        assert.equal((fixture.db as unknown as { isTransaction?: boolean }).isTransaction, false);
        assert.deepEqual(getProject(fixture.db, fixture.project.project_id)?.brief, { revision: "after" });
      } else {
        assert.equal((fixture.db as unknown as { isTransaction?: boolean }).isTransaction, true);
        fixture.db.exec("ROLLBACK");
        assert.deepEqual(getProject(fixture.db, fixture.project.project_id)?.brief, { revision: "before" });
      }
    } finally {
      if ((fixture.db as unknown as { isTransaction?: boolean }).isTransaction) fixture.db.exec("ROLLBACK");
      fixture.db.close();
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  }
});

test("PRRT_kwDOTTDtUM6Zf_Hn shared Project and SHOT persistence cannot bypass closed state", () => {
  const fixture = seedAuthorityFixture("closed");
  try {
    assertMutationError(() => saveProject(fixture.db, { ...fixture.project, title: "Closed rewrite" }), "PROJECT_CLOSED");
    assertMutationError(() => saveShot(fixture.db, { ...fixture.shot, description: "Closed SHOT rewrite" }), "PROJECT_CLOSED");
    assert.equal(getProject(fixture.db, fixture.project.project_id)?.title, fixture.project.title);
    assert.equal(getShot(fixture.db, fixture.shot.shot_id)?.description, fixture.shot.description);
  } finally {
    fixture.db.close();
  }
});

test("PRRT_kwDOTTDtUM6Zr-uA public SHOT persistence requires explicit rework after review", () => {
  for (const state of ["final_review", "approved", "exported"] as const) {
    const fixture = seedAuthorityFixture(state);
    try {
      assertMutationError(() => saveShot(fixture.db, { ...fixture.shot, video_prompt: `rewrite in ${state}` }), "DELIVERY_REWORK_REQUIRED");
      assert.equal(getShot(fixture.db, fixture.shot.shot_id)?.video_prompt, fixture.shot.video_prompt);
    } finally {
      fixture.db.close();
    }
  }
});

test("PRRT_kwDOTTDtUM6Zr-uB delivery Artifact content and Blob bindings require authority", () => {
  const fixture = currentFixture(true);
  try {
    assert.ok(fixture.artifact);
    assert.throws(() => fixture.db.prepare("UPDATE media_artifacts SET data_json = data_json WHERE artifact_id = ?")
      .run(fixture.artifact?.artifact_id), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    assert.throws(() => fixture.db.prepare("UPDATE media_artifact_blobs SET blob_id = blob_id WHERE artifact_id = ?")
      .run(fixture.artifact?.artifact_id), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    assert.throws(() => fixture.db.prepare("UPDATE media_artifact_blobs SET artifact_id = 'artifact_relocated' WHERE artifact_id = ?")
      .run(fixture.artifact?.artifact_id), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    const state = refreshWorkbenchAssemblyReadiness(fixture.db, fixture.project.project_id);
    assert.equal(state.workflow_state, "ready_to_assemble");
    const transitioned = transitionMediaArtifactStatus(fixture.artifact?.artifact_id ?? "", "inaccessible", fixture.db);
    assert.equal(transitioned.ok, true);
    assert.equal(getWorkbenchDeliveryState(fixture.db, fixture.project.project_id)?.workflow_state, "not_ready");
  } finally {
    fixture.db.close();
  }
});

test("current, approved, and exported final Artifacts and Blob bindings remain immutable", () => {
  for (const state of ["final_review", "approved", "exported"] as const) {
    const fixture = protectedFinalFixture(state);
    try {
      assert.ok(fixture.artifact);
      assert.throws(() => withWorkbenchProductionMutationAuthority(fixture.db, {
        kind: "artifact", project_id: fixture.project.project_id, object_id: fixture.artifact?.artifact_id ?? ""
      }, () => fixture.db.prepare("UPDATE media_artifacts SET data_json = data_json WHERE artifact_id = ?")
        .run(fixture.artifact?.artifact_id)), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
      assert.throws(() => withWorkbenchProductionMutationAuthority(fixture.db, {
        kind: "artifact", project_id: fixture.project.project_id, object_id: fixture.artifact?.artifact_id ?? ""
      }, () => fixture.db.prepare("UPDATE media_artifact_blobs SET blob_id = blob_id WHERE artifact_id = ?")
        .run(fixture.artifact?.artifact_id)), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    } finally {
      fixture.db.close();
    }
  }
});

test("PRRT_kwDOTTDtUM6ZtiA7 public Project persistence cannot mutate reviewed production content", () => {
  const fixture = seedAuthorityFixture("final_review");
  try {
    assertMutationError(() => saveProject(fixture.db, {
      ...fixture.project,
      brief: { attempted: "post-review mutation" }
    }), "DELIVERY_REWORK_REQUIRED");
    assert.deepEqual(getProject(fixture.db, fixture.project.project_id)?.brief, {});
  } finally {
    fixture.db.close();
  }
});

test("PRRT_kwDOTTDtUM6ZtiA_ Artifact-to-SHOT attachment is delivery-aware", () => {
  const fixture = seedAuthorityFixture("final_review", true);
  try {
    assert.ok(fixture.artifact);
    const result = attachArtifactToShot({
      project_id: fixture.project.project_id,
      shot_id: fixture.shot.shot_id,
      artifact_id: fixture.artifact?.artifact_id ?? "",
      reference: "accepted_clip_artifact_id",
      expected_current_artifact_id: ""
    }, fixture.db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DELIVERY_REWORK_REQUIRED");
    assert.equal(getShot(fixture.db, fixture.shot.shot_id)?.accepted_clip_artifact_id, "");
  } finally {
    fixture.db.close();
  }
});

test("PRRT_kwDOTTDtUM6ZwKci title updates use a narrow authority path with stable errors", () => {
  const reviewed = seedAuthorityFixture("final_review");
  const active = currentFixture();
  const closed = seedAuthorityFixture("closed");
  try {
    const renamed = updateWorkbenchProject(reviewed.project.project_id, { title: "Reviewed title only" }, reviewed.db);
    assert.equal(renamed.ok, true);
    assert.equal(getProject(reviewed.db, reviewed.project.project_id)?.title, "Reviewed title only");
    const invalidOverride = updateWorkbenchProject(reviewed.project.project_id, {
      title: "Must roll back",
      next_action_override: { label: "", priority: "normal" }
    }, reviewed.db);
    assert.equal(invalidOverride.ok, false);
    if (!invalidOverride.ok) assert.equal(invalidOverride.error.code, "NEXT_ACTION_OVERRIDE_INVALID");
    assert.equal(getProject(reviewed.db, reviewed.project.project_id)?.title, "Reviewed title only");
    const invalidClassification = updateWorkbenchProject(reviewed.project.project_id, {
      title: "Must also roll back",
      classification: "external" as WorkbenchProjectClassification
    }, reviewed.db);
    assert.equal(invalidClassification.ok, false);
    if (!invalidClassification.ok) assert.equal(invalidClassification.error.code, "CLASSIFICATION_INVALID");
    assert.equal(getProject(reviewed.db, reviewed.project.project_id)?.title, "Reviewed title only");

    active.db.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
      VALUES ('job_active_title', ?, 'export', 'queued')`).run(active.project.project_id);
    const frozen = updateWorkbenchProject(active.project.project_id, { title: "Must stay frozen" }, active.db);
    assert.equal(frozen.ok, false);
    if (!frozen.ok) {
      assert.equal(frozen.error.code, "DELIVERY_JOB_ACTIVE");
      assert.equal(frozen.error.message, "Production content cannot change while a Delivery Job is active.");
    }
    const terminal = updateWorkbenchProject(closed.project.project_id, { title: "Must stay closed" }, closed.db);
    assert.equal(terminal.ok, false);
    if (!terminal.ok) assert.equal(terminal.error.code, "PROJECT_CLOSED");
  } finally {
    reviewed.db.close();
    active.db.close();
    closed.db.close();
  }
});

test("Workbench Project creation rolls back the Project when metadata persistence fails", () => {
  const fixture = currentFixture();
  try {
    const before = (fixture.db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    const faulting = new Proxy(fixture.db, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("UPDATE workbench_project_meta SET classification")) {
              return {
                run(): never {
                  throw Object.assign(new Error("injected metadata write failure"), { code: "SQLITE_IOERR" });
                }
              };
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as M0Database;
    const result = createWorkbenchProject({
      title: "Metadata failure must be atomic",
      classification: "production"
    }, faulting);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "PRODUCTION_MUTATION_REJECTED");
      assert.equal(result.error.message.includes("SQLITE"), false);
    }
    assert.equal((fixture.db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count, before);
    assert.equal((fixture.db as unknown as { isTransaction?: boolean }).isTransaction, false);
  } finally {
    fixture.db.close();
  }
});

test("PRRT_kwDOTTDtUM6Z-Tig public Project writes cannot manufacture delivery projection fields", () => {
  const fixture = currentFixture();
  try {
    assertMutationError(() => saveProject(fixture.db, {
      ...fixture.project,
      status: "final_approved",
      exports: { final_video_artifact_id: "artifact_forged" }
    }), "PRODUCTION_MUTATION_REJECTED");
    assert.throws(() => withWorkbenchProductionMutationAuthority(fixture.db, {
      kind: "project_content", project_id: fixture.project.project_id, object_id: fixture.project.project_id
    }, () => fixture.db.prepare(`UPDATE projects
      SET data_json = json_set(data_json, '$.status', 'final_approved')
      WHERE project_id = ?`).run(fixture.project.project_id)), /WORKBENCH_DELIVERY_PROJECTION_OWNER_REQUIRED/);
    assert.equal(getProject(fixture.db, fixture.project.project_id)?.status, "draft");
  } finally {
    fixture.db.close();
  }
});

test("PRRT_kwDOTTDtUM6acFed direct Project and SHOT table writes require database authority", () => {
  const fixture = currentFixture();
  const closed = seedAuthorityFixture("closed");
  try {
    assert.throws(() => fixture.db.prepare("UPDATE projects SET data_json = data_json WHERE project_id = ?")
      .run(fixture.project.project_id), /WORKBENCH_PRODUCTION_OWNER_REQUIRED/);
    assert.throws(() => fixture.db.prepare("UPDATE shots SET data_json = data_json WHERE shot_id = ?")
      .run(fixture.shot.shot_id), /WORKBENCH_SHOT_PRODUCTION_AUTHORITY_REQUIRED/);
    assert.throws(() => fixture.db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_direct', ?)")
      .run(JSON.stringify({ ...fixture.project, project_id: "project_direct", title: "Direct bypass" })), /WORKBENCH_PRODUCTION_OWNER_REQUIRED/);
    assert.throws(() => fixture.db.prepare("UPDATE projects SET project_id = 'project_rebound' WHERE project_id = ?")
      .run(fixture.project.project_id), /WORKBENCH_PROJECT_IDENTITY_IMMUTABLE/);
    assert.throws(() => fixture.db.prepare("DELETE FROM projects WHERE project_id = ?")
      .run(fixture.project.project_id), /WORKBENCH_PROJECT_IMMUTABLE/);
    assert.throws(() => closed.db.prepare("UPDATE projects SET project_id = 'project_closed_rebound' WHERE project_id = ?")
      .run(closed.project.project_id), /PROJECT_CLOSED/);
    assert.throws(() => closed.db.prepare("DELETE FROM projects WHERE project_id = ?")
      .run(closed.project.project_id), /PROJECT_CLOSED/);
    assert.equal(getProject(fixture.db, fixture.project.project_id)?.project_id, fixture.project.project_id);
    assert.equal(getProject(closed.db, closed.project.project_id)?.project_id, closed.project.project_id);
  } finally {
    fixture.db.close();
    closed.db.close();
  }
});

test("PRRT_kwDOTTDtUM6atOiW Storyboard Package content is owner-created and immutable", () => {
  const fixture = currentFixture();
  const storyboardImage = registerMediaArtifact({
    artifact_type: "image",
    role: "storyboard_image",
    source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
    linked_objects: { project_id: fixture.project.project_id, shot_id: fixture.shot.shot_id }
  }, fixture.db);
  assert.equal(storyboardImage.ok, true);
  if (!storyboardImage.ok) throw new Error("STORYBOARD_FIXTURE_FAILED");
  fixture.shot.storyboard_image_artifact_id = storyboardImage.artifact.artifact_id;
  saveShot(fixture.db, fixture.shot);
  const storyboardPackage: StoryboardPackage = {
    storyboard_package_id: "storyboard_package_authority",
    project_id: fixture.project.project_id,
    status: "approved_for_video_generation",
    approved_shot_snapshots: [{
      shot_id: fixture.shot.shot_id,
      order: fixture.shot.order,
      duration_seconds: fixture.shot.duration_seconds,
      storyboard_image_artifact_id: storyboardImage.artifact.artifact_id,
      video_prompt: fixture.shot.video_prompt
    }],
    user_approval: { storyboard_approved: true }
  };
  try {
    saveStoryboardPackage(fixture.db, storyboardPackage);
    saveStoryboardPackage(fixture.db, structuredClone(storyboardPackage));
    fixture.project.active_storyboard_package_id = storyboardPackage.storyboard_package_id;
    saveProject(fixture.db, fixture.project);
    assert.throws(() => saveStoryboardPackage(fixture.db, {
      ...storyboardPackage,
      approved_shot_snapshots: [{
        order: 1,
        duration_seconds: 2,
        storyboard_image_artifact_id: "artifact_changed",
        video_prompt: "changed"
      }]
    }), /STORYBOARD_PACKAGE_IMMUTABLE/);
    assert.throws(() => fixture.db.prepare("UPDATE storyboard_packages SET data_json = data_json WHERE storyboard_package_id = ?")
      .run(storyboardPackage.storyboard_package_id), /STORYBOARD_PACKAGE_IMMUTABLE/);
    assert.throws(() => fixture.db.prepare("DELETE FROM storyboard_packages WHERE storyboard_package_id = ?")
      .run(storyboardPackage.storyboard_package_id), /STORYBOARD_PACKAGE_IMMUTABLE/);
    assert.throws(() => fixture.db.prepare(`INSERT INTO storyboard_packages
      (storyboard_package_id, project_id, data_json) VALUES ('storyboard_package_direct', ?, ?)`)
      .run(fixture.project.project_id, JSON.stringify({ ...storyboardPackage, storyboard_package_id: "storyboard_package_direct" })),
    /WORKBENCH_STORYBOARD_PACKAGE_AUTHORITY_REQUIRED/);
  } finally {
    fixture.db.close();
  }
});

test("ready_to_assemble is truthful and any Project, SHOT, or accepted Artifact drift revokes it atomically", () => {
  for (const drift of ["project", "shot", "artifact"] as const) {
    const fixture = readyFixtureWithFingerprint();
    try {
      const before = getWorkbenchDeliveryState(fixture.db, fixture.project.project_id);
      assert.equal(before?.workflow_state, "ready_to_assemble");
      assert.equal(before?.assembly_input_fingerprint, "c".repeat(64));
      if (drift === "project") saveProject(fixture.db, { ...fixture.project, brief: { drift: true } });
      if (drift === "shot") saveShot(fixture.db, { ...fixture.shot, description: "drift" });
      if (drift === "artifact") {
        const result = transitionMediaArtifactStatus(fixture.artifact?.artifact_id ?? "", "inaccessible", fixture.db);
        assert.equal(result.ok, true);
      }
      const after = getWorkbenchDeliveryState(fixture.db, fixture.project.project_id);
      assert.equal(after?.workflow_state, "not_ready");
      assert.equal(after?.assembly_input_fingerprint, null);
    } finally {
      fixture.db.close();
    }
  }
});

test("direct readiness downgrade cannot retain a stale Assembly fingerprint", () => {
  const fixture = readyFixtureWithFingerprint();
  try {
    assert.throws(() => fixture.db.prepare(`
      UPDATE workbench_delivery_state
      SET workflow_state = 'not_ready'
      WHERE project_id = ?
    `).run(fixture.project.project_id), /WORKBENCH_DELIVERY_PROJECTION_OWNER_REQUIRED/);
    const unchanged = getWorkbenchDeliveryState(fixture.db, fixture.project.project_id);
    assert.equal(unchanged?.workflow_state, "ready_to_assemble");
    assert.equal(unchanged?.assembly_input_fingerprint, "c".repeat(64));

    assert.doesNotThrow(() => fixture.db.prepare(`
      UPDATE workbench_delivery_state
      SET workflow_state = 'not_ready', assembly_input_fingerprint = NULL
      WHERE project_id = ?
    `).run(fixture.project.project_id));
    const downgraded = getWorkbenchDeliveryState(fixture.db, fixture.project.project_id);
    assert.equal(downgraded?.workflow_state, "not_ready");
    assert.equal(downgraded?.assembly_input_fingerprint, null);
  } finally {
    fixture.db.close();
  }
});

test("any queued or running Delivery Job freezes Project, SHOT, Package, and Artifact mutation", () => {
  for (const jobType of ["assembly", "export"] as const) {
    for (const jobState of ["queued", "running"] as const) {
      const fixture = currentFixture(true);
      try {
        fixture.db.prepare(`INSERT INTO workbench_delivery_jobs
          (job_id, project_id, job_type, state, started_at)
          VALUES (?, ?, ?, ?, ?)`)
          .run(`job_freeze_${jobType}_${jobState}`, fixture.project.project_id, jobType, jobState,
            jobState === "running" ? new Date().toISOString() : null);
        assertMutationError(() => saveProject(fixture.db, { ...fixture.project, brief: { blocked: jobType } }), "DELIVERY_JOB_ACTIVE");
        assertMutationError(() => saveShot(fixture.db, { ...fixture.shot, description: `blocked ${jobType}` }), "DELIVERY_JOB_ACTIVE");
        assert.throws(() => saveStoryboardPackage(fixture.db, {
          storyboard_package_id: `package_blocked_${jobType}_${jobState}`,
          project_id: fixture.project.project_id,
          status: "approved_for_video_generation",
          approved_shot_snapshots: [],
          user_approval: { storyboard_approved: true }
        }), (error: unknown) => error instanceof WorkbenchProductionMutationError && error.code === "DELIVERY_JOB_ACTIVE");
        const transition = transitionMediaArtifactStatus(fixture.artifact?.artifact_id ?? "", "inaccessible", fixture.db);
        assert.equal(transition.ok, false);
        if (!transition.ok) assert.equal(transition.error.code, "DELIVERY_JOB_ACTIVE");

        const outputId = `artifact_final_${jobType}_${jobState}`;
        const outputBlobId = `blob_final_${jobType}_${jobState}`;
        insertVerifiedBlob(fixture.db, outputBlobId, "f");
        const output: MediaArtifact = {
          artifact_id: outputId,
          blob_id: outputBlobId,
          artifact_type: "video",
          role: "final_video",
          status: "active",
          storage: { uri: `fixture://${outputId}.mp4`, mime_type: "video/mp4", filename: `${outputId}.mp4` },
          metadata: { width: 1080, height: 1920, duration_seconds: 2, aspect_ratio: "9:16", sha256: "f".repeat(64) },
          linked_objects: { project_id: fixture.project.project_id, shot_id: "" },
          source: { kind: "synthetic_fixture", provider: "", provider_job_id: "", sha256: "f".repeat(64), external_url_host: "" }
        };
        withWorkbenchProductionMutationAuthority(fixture.db, {
          kind: "artifact", project_id: fixture.project.project_id, object_id: outputId
        }, () => {
          fixture.db.prepare(`INSERT INTO media_artifacts
            (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
            VALUES (?, ?, NULL, 'final_video', 'video', 'active', ?)`)
            .run(outputId, fixture.project.project_id, JSON.stringify(output));
          fixture.db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)")
            .run(outputId, outputBlobId);
        });
        assert.equal((fixture.db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE artifact_id = ?")
          .get(outputId) as { count: number }).count, 1);
      } finally {
        fixture.db.close();
      }
    }
  }
});

test("assembling and legacy review remain frozen while revision_requested is the explicit rework lane", () => {
  const assembling = seedAuthorityFixture("assembling");
  const legacy = protectedFinalFixture("legacy_review_required");
  const revision = seedAuthorityFixture("revision_requested");
  try {
    assertMutationError(() => saveShot(assembling.db, { ...assembling.shot, description: "blocked assembling" }), "DELIVERY_JOB_ACTIVE");
    assertMutationError(() => saveShot(legacy.db, { ...legacy.shot, description: "blocked legacy" }), "DELIVERY_REWORK_REQUIRED");
    assert.doesNotThrow(() => saveShot(revision.db, { ...revision.shot, description: "allowed explicit rework" }));
  } finally {
    assembling.db.close();
    legacy.db.close();
    revision.db.close();
  }
});

test("SQLite busy and locked failures map to one low-disclosure domain conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "production-authority-busy-"));
  const sqlitePath = join(root, "authority.sqlite");
  const first = openM0DatabaseConnection(sqlitePath);
  applyMigrationsThrough(first, "0013");
  const created = createProject({ title: "Busy authority" }, first);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROJECT_FIXTURE_FAILED");
  const second = openM0DatabaseConnection(sqlitePath);
  try {
    second.exec("PRAGMA busy_timeout = 20");
    first.exec("BEGIN IMMEDIATE");
    const update = updateWorkbenchProject(created.project_id, { title: "Busy title must not persist" }, second);
    assert.equal(update.ok, false);
    if (!update.ok) assert.deepEqual(update.error, {
      code: "PRODUCTION_MUTATION_CONFLICT",
      message: "Production mutation failed closed because the database is busy.",
      field: "project_id"
    });
    const create = createWorkbenchProject({ title: "Busy create must not persist", classification: "production" }, second);
    assert.equal(create.ok, false);
    if (!create.ok) assert.deepEqual(create.error, {
      code: "PRODUCTION_MUTATION_CONFLICT",
      message: "Production mutation failed closed because the database is busy."
    });
    assertMutationError(() => saveProject(second, { ...created.project, brief: { blocked: true } }), "PRODUCTION_MUTATION_CONFLICT");
    const locked = workbenchProductionMutationError(Object.assign(new Error("database schema is locked"), { code: "SQLITE_LOCKED" }));
    assert.deepEqual(locked, {
      code: "PRODUCTION_MUTATION_CONFLICT",
      message: "Production mutation failed closed because the database is busy."
    });
    assert.equal(getProject(first, created.project_id)?.title, created.project.title);
    assert.equal((first.prepare("SELECT COUNT(*) AS count FROM projects WHERE json_extract(data_json, '$.title') = ?")
      .get("Busy create must not persist") as { count: number }).count, 0);
    assert.deepEqual(getProject(first, created.project_id)?.brief, {});
    first.exec("ROLLBACK");
  } finally {
    if ((first as unknown as { isTransaction?: boolean }).isTransaction) first.exec("ROLLBACK");
    second.close();
    first.close();
    rmSync(root, { recursive: true, force: true });
  }
});
