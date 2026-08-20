import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createProject, openM0Database } from "../src/index.js";
import { DATABASE_MIGRATIONS, migrationChecksum, runDatabaseMigrations } from "../src/storage/migrations.js";
import { getWorkbenchDeliveryState } from "../src/tools/workbenchDeliveryState.js";

function migrateThrough0011(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    BEGIN EXCLUSIVE;
  `);
  try {
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.id <= "0011")) {
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

function projectJson(projectId: string, status = "draft", finalArtifactId = ""): string {
  return JSON.stringify({
    project_id: projectId,
    title: projectId,
    project_type: "test",
    status,
    brief: {},
    video_spec: { duration_seconds: 2, aspect_ratio: "9:16", resolution: "1080x1920" },
    shot_ids: [],
    active_storyboard_package_id: "",
    generation_batch_ids: [],
    exports: { final_video_artifact_id: finalArtifactId }
  });
}

function insertFinalArtifact(db: DatabaseSync, projectId: string, artifactId: string): void {
  const artifact = {
    artifact_id: artifactId,
    artifact_type: "video",
    role: "final_video",
    status: "active",
    storage: { uri: "synthetic.mp4", mime_type: "video/mp4", filename: "synthetic.mp4" },
    metadata: { width: 1080, height: 1920, duration_seconds: 2, aspect_ratio: "9:16", sha256: "a".repeat(64) },
    linked_objects: { project_id: projectId, shot_id: "" },
    source: { kind: "synthetic_fixture", provider: "", provider_job_id: "", sha256: "a".repeat(64), external_url_host: "" }
  };
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, NULL, 'final_video', 'video', 'active', ?)`)
    .run(artifactId, projectId, JSON.stringify(artifact));
}

function createCurrentProject(db: DatabaseSync, title: string): string {
  const created = createProject({ title }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROJECT_CREATE_FAILED");
  return created.project_id;
}

test("delivery ledger rejects a duplicate lifecycle Event for one Job", () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = createCurrentProject(db, "duplicate lifecycle");
    db.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
      VALUES ('job_duplicate', ?, 'assembly', 'queued')`).run(projectId);
    db.prepare(`INSERT INTO workbench_delivery_events (event_id, project_id, event_type, job_id)
      VALUES ('event_queued_1', ?, 'assembly_queued', 'job_duplicate')`).run(projectId);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_events (event_id, project_id, event_type, job_id)
      VALUES ('event_queued_2', ?, 'assembly_queued', 'job_duplicate')`).run(projectId), /UNIQUE constraint failed/);
  } finally {
    db.close();
  }
});

test("legacy backfill preserves the bound final Artifact identity", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateThrough0011(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('legacy_bound', ?)")
      .run(projectJson("legacy_bound", "final_approved", "artifact_legacy_a"));
    insertFinalArtifact(db, "legacy_bound", "artifact_legacy_a");
    insertFinalArtifact(db, "legacy_bound", "artifact_legacy_b");
    assert.deepEqual(runDatabaseMigrations(db).applied, ["0012"]);
    const state = getWorkbenchDeliveryState(db, "legacy_bound");
    assert.equal(state?.workflow_state, "legacy_review_required");
    assert.equal(state?.current_final_artifact_id, "artifact_legacy_a");
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET current_final_artifact_id = 'artifact_legacy_b' WHERE project_id = 'legacy_bound'`).run(), /WORKBENCH_LEGACY_FINAL_ARTIFACT_IMMUTABLE/);
  } finally {
    db.close();
  }
});

test("terminal Job state requires matching terminal Event evidence", () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = createCurrentProject(db, "terminal evidence");
    db.exec("BEGIN");
    try {
      db.prepare(`INSERT INTO workbench_delivery_jobs
        (job_id, project_id, job_type, state, terminal_event_id)
        VALUES ('job_terminal_match', ?, 'assembly', 'succeeded', 'event_terminal_match')`).run(projectId);
      assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, event_type, job_id)
        VALUES ('event_terminal_match', ?, 'assembly_failed', 'job_terminal_match')`).run(projectId), /WORKBENCH_DELIVERY_TERMINAL_EVIDENCE_INVALID/);
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
});

test("direct terminal Job insertion fails closed without evidence", () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = createCurrentProject(db, "direct terminal");
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, terminal_event_id)
      VALUES ('job_direct_terminal', ?, 'export', 'failed', 'event_missing')`).run(projectId), /FOREIGN KEY constraint failed/);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM workbench_delivery_jobs WHERE job_id = 'job_direct_terminal'").get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test("terminal Job cannot bind a nonterminal lifecycle Event", () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = createCurrentProject(db, "wrong terminal evidence");
    db.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
      VALUES ('job_wrong_terminal', ?, 'assembly', 'queued')`).run(projectId);
    db.prepare(`INSERT INTO workbench_delivery_events (event_id, project_id, event_type, job_id)
      VALUES ('event_not_terminal', ?, 'assembly_queued', 'job_wrong_terminal')`).run(projectId);
    db.exec("BEGIN");
    try {
      db.prepare(`UPDATE workbench_delivery_jobs
        SET state = 'succeeded', terminal_event_id = 'event_not_terminal'
        WHERE job_id = 'job_wrong_terminal'`).run();
      assert.throws(() => db.exec("COMMIT"), /FOREIGN KEY constraint failed/);
    } finally {
      db.exec("ROLLBACK");
    }
    assert.equal((db.prepare("SELECT state FROM workbench_delivery_jobs WHERE job_id = 'job_wrong_terminal'").get() as { state: string }).state, "queued");
  } finally {
    db.close();
  }
});

test("new Project initialization rejects a terminal delivery projection", () => {
  const db = openM0Database(":memory:");
  try {
    const canonicalProject = createCurrentProject(db, "canonical initial state");
    assert.equal(getWorkbenchDeliveryState(db, canonicalProject)?.workflow_state, "not_ready");
    assert.throws(() => db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('new_terminal', ?)")
      .run(projectJson("new_terminal", "final_approved")), /WORKBENCH_NEW_PROJECT_DELIVERY_STATE_INVALID/);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM projects WHERE project_id = 'new_terminal'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM workbench_delivery_state WHERE project_id = 'new_terminal'").get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test("pointerless legacy final approval backfills to not_ready", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateThrough0011(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('legacy_pointerless', ?)")
      .run(projectJson("legacy_pointerless", "final_approved"));
    assert.deepEqual(runDatabaseMigrations(db).applied, ["0012"]);
    const state = getWorkbenchDeliveryState(db, "legacy_pointerless");
    assert.equal(state?.workflow_state, "not_ready");
    assert.equal(state?.current_final_artifact_id, null);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'legacy_review_required'
      WHERE project_id = 'legacy_pointerless'`).run(), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test("legacy backfill aborts before schema changes when the final Artifact binding is invalid", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateThrough0011(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('legacy_invalid', ?)")
      .run(projectJson("legacy_invalid", "final_approved", "artifact_missing"));
    assert.throws(() => runDatabaseMigrations(db), /WORKBENCH_LEGACY_FINAL_ARTIFACT_INVALID/);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE migration_id = '0012'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = 'workbench_delivery_state'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-6");
  } finally {
    db.close();
  }
});

test("generic terminal evidence and global single-active Job constraints admit only structural validity", () => {
  const db = openM0Database(":memory:");
  try {
    const firstProject = createCurrentProject(db, "first active");
    const secondProject = createCurrentProject(db, "second active");
    db.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
      VALUES ('job_active', ?, 'assembly', 'queued')`).run(firstProject);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
      VALUES ('job_other_active', ?, 'export', 'running')`).run(secondProject), /UNIQUE constraint failed/);

    db.exec("BEGIN");
    try {
      db.prepare(`UPDATE workbench_delivery_jobs
        SET state = 'interrupted', terminal_event_id = 'event_interrupted', error_code = 'TEST', updated_at = CURRENT_TIMESTAMP
        WHERE job_id = 'job_active'`).run();
      db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, event_type, job_id, reason_code)
        VALUES ('event_interrupted', ?, 'assembly_interrupted', 'job_active', 'TEST')`).run(firstProject);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    assert.equal((db.prepare("SELECT state FROM workbench_delivery_jobs WHERE job_id = 'job_active'").get() as { state: string }).state, "interrupted");
  } finally {
    db.close();
  }
});
