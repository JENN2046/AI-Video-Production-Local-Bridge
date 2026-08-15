import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { assertSchemaCurrent, DATABASE_MIGRATIONS, migrationChecksum, runDatabaseMigrations } from "../src/storage/migrations.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { WORKBENCH_V2_SCHEMA_VERSION } from "../src/storage/workbenchV2Schema.js";
import { projectSummaryDeliveryState } from "../src/tools/workbenchDeliveryState.js";
import { assertWorkbenchProjectWritable } from "../src/tools/workbenchV2.js";

function applyThrough0011(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of DATABASE_MIGRATIONS.slice(0, 11)) migration.apply(db);
  db.exec(`CREATE TABLE schema_migrations (
    migration_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const insert = db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
  for (const migration of DATABASE_MIGRATIONS.slice(0, 11)) {
    insert.run(migration.id, migration.name, migrationChecksum(migration));
  }
}

function projectJson(projectId: string, status: string, finalArtifactId = ""): string {
  return JSON.stringify({
    project_id: projectId,
    title: projectId,
    project_type: "delivery-fixture",
    status,
    brief: {},
    video_spec: { duration_seconds: 5, aspect_ratio: "9:16", resolution: "1080x1920" },
    shot_ids: [],
    active_storyboard_package_id: "",
    generation_batch_ids: [],
    exports: { final_video_artifact_id: finalArtifactId }
  });
}

function insertFinalArtifact(db: DatabaseSync, projectId: string, artifactId: string): void {
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, '', 'final_video', 'video', 'active', ?)`)
    .run(artifactId, projectId, JSON.stringify({
      artifact_id: artifactId,
      artifact_type: "video",
      role: "final_video",
      status: "active",
      linked_objects: { project_id: projectId, shot_id: "" }
    }));
}

test("migration 0012 backfills delivery state without inventing approval, export, or closeout evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough0011(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run("project_not_ready", projectJson("project_not_ready", "draft"));
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run("project_final_review", projectJson("project_final_review", "video_review", "artifact_final_review"));
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run("project_legacy", projectJson("project_legacy", "final_approved", "artifact_legacy"));
    insertFinalArtifact(db, "project_final_review", "artifact_final_review");
    insertFinalArtifact(db, "project_legacy", "artifact_legacy");

    assert.deepEqual(runDatabaseMigrations(db).applied, ["0012"]);
    assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-7");
    assert.equal(WORKBENCH_V2_SCHEMA_VERSION, "workbench-v2-7");
    assert.doesNotThrow(() => assertSchemaCurrent(db));

    const states = (db.prepare(`SELECT project_id, workflow_state, current_final_artifact_id,
      approved_artifact_id, latest_export_id, closed_at
      FROM workbench_delivery_state ORDER BY project_id`).all() as Array<Record<string, unknown>>)
      .map((row) => ({ ...row }));
    assert.deepEqual(states, [
      { project_id: "project_final_review", workflow_state: "final_review", current_final_artifact_id: "artifact_final_review", approved_artifact_id: null, latest_export_id: null, closed_at: null },
      { project_id: "project_legacy", workflow_state: "legacy_review_required", current_final_artifact_id: "artifact_legacy", approved_artifact_id: null, latest_export_id: null, closed_at: null },
      { project_id: "project_not_ready", workflow_state: "not_ready", current_final_artifact_id: null, approved_artifact_id: null, latest_export_id: null, closed_at: null }
    ]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_exports").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_events").get() as { count: number }).count, 0);
    assert.equal(JSON.parse((db.prepare("SELECT data_json FROM projects WHERE project_id = 'project_legacy'").get() as { data_json: string }).data_json).status, "final_approved");

    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run("project_new", projectJson("project_new", "draft"));
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = 'project_new'").get() as { workflow_state: string }).workflow_state, "not_ready");
  } finally {
    db.close();
  }
});

test("migration 0012 fails atomically when an existing final pointer is not a valid active final Artifact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough0011(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run("project_invalid_pointer", projectJson("project_invalid_pointer", "video_review", "artifact_missing"));

    assert.throws(() => runDatabaseMigrations(db), /WORKBENCH_DELIVERY_FINAL_ARTIFACT_INVALID:project_invalid_pointer/);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_id = '0012'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workbench_delivery_state'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-6");
  } finally {
    db.close();
  }
});

test("delivery tables enforce one active job, legal transitions, append-only evidence, and terminal closeout", () => {
  const db = openM0Database(":memory:");
  try {
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run("project_delivery", projectJson("project_delivery", "video_review"));
    insertFinalArtifact(db, "project_delivery", "artifact_delivery");
    insertFinalArtifact(db, "project_delivery", "artifact_delivery_old");
    const now = "2026-08-13T00:00:00.000Z";

    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, "project_delivery");
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_fingerprint, input_json, created_at, updated_at)
      VALUES ('job_assembly', 'project_delivery', 'assembly', 'queued', ?, '{}', ?, ?)`)
      .run("a".repeat(64), now, now);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, created_at, updated_at)
      VALUES ('job_assembly_conflict', 'project_delivery', 'assembly', 'queued', '{}', ?, ?)`)
      .run(now, now), /UNIQUE constraint failed/);

    db.prepare("UPDATE workbench_delivery_jobs SET state = 'running', started_at = ?, updated_at = ? WHERE job_id = 'job_assembly'")
      .run(now, now);
    assert.throws(() => db.prepare("UPDATE workbench_delivery_jobs SET state = 'queued' WHERE job_id = 'job_assembly'").run(), /WORKBENCH_DELIVERY_JOB_STATE_INVALID/);
    db.prepare("UPDATE workbench_delivery_jobs SET state = 'failed', error_code = 'ASSEMBLY_OUTPUT_INVALID', finished_at = ?, updated_at = ? WHERE job_id = 'job_assembly'")
      .run(now, now);
    assert.throws(() => db.prepare("UPDATE workbench_delivery_jobs SET error_code = 'CHANGED' WHERE job_id = 'job_assembly'").run(), /WORKBENCH_DELIVERY_JOB_TERMINAL_IMMUTABLE/);
    assert.throws(() => db.prepare("DELETE FROM workbench_delivery_jobs WHERE job_id = 'job_assembly'").run(), /WORKBENCH_DELIVERY_JOB_IMMUTABLE/);

    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', assembly_input_fingerprint = ?, updated_at = ? WHERE project_id = 'project_delivery'")
      .run("a".repeat(64), now);
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'final_review', current_final_artifact_id = 'artifact_delivery', updated_at = ?
      WHERE project_id = 'project_delivery'`).run(now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id,
        created_at, started_at, finished_at, updated_at)
      VALUES ('job_assembly_historical', 'project_delivery', 'assembly', 'succeeded', '{}',
        'artifact_delivery_old', ?, ?, ?, ?)`).run(now, now, now, now);
    assert.throws(() => db.prepare("UPDATE media_artifacts SET status = 'archived' WHERE artifact_id = 'artifact_delivery'").run(),
      /WORKBENCH_DELIVERY_ARTIFACT_ACTIVE_REQUIRED/);
    assert.throws(() => db.prepare("UPDATE media_artifacts SET status = 'archived' WHERE artifact_id = 'artifact_delivery_old'").run(),
      /WORKBENCH_DELIVERY_ARTIFACT_ACTIVE_REQUIRED/);
    assert.equal((db.prepare("SELECT status FROM media_artifacts WHERE artifact_id = 'artifact_delivery'").get() as { status: string }).status, "active");
    assert.equal((db.prepare("SELECT status FROM media_artifacts WHERE artifact_id = 'artifact_delivery_old'").get() as { status: string }).status, "active");
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'approved', approved_artifact_id = NULL, updated_at = ?
      WHERE project_id = 'project_delivery'`).run(now), /CHECK constraint failed/);
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = 'project_delivery'").get() as { workflow_state: string }).workflow_state, "final_review");
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
      VALUES ('event_assembly_failed', 'project_delivery', 'job_assembly', 'assembly_failed', 'assembling', 'ready_to_assemble',
        NULL, ?, 'ASSEMBLY_OUTPUT_INVALID', '{}', ?)`)
      .run("a".repeat(64), now);
    assert.throws(() => db.prepare("UPDATE workbench_delivery_events SET reason_code = 'CHANGED' WHERE event_id = 'event_assembly_failed'").run(), /WORKBENCH_DELIVERY_EVENTS_APPEND_ONLY/);
    assert.throws(() => db.prepare("DELETE FROM workbench_delivery_events WHERE event_id = 'event_assembly_failed'").run(), /WORKBENCH_DELIVERY_EVENTS_APPEND_ONLY/);

    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'approved', approved_artifact_id = 'artifact_delivery', updated_at = ? WHERE project_id = 'project_delivery'")
      .run(now);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET current_final_artifact_id = 'artifact_delivery_old', approved_artifact_id = 'artifact_delivery_old', updated_at = ?
      WHERE project_id = 'project_delivery'`).run(now), /WORKBENCH_DELIVERY_STATE_TRANSITION_INVALID/);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_delivery', 'project_delivery', 'artifact_delivery', 'data/exports/project_delivery/final.mp4', ?, 123, ?)`)
      .run("b".repeat(64), now);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_delivery_old', 'project_delivery', 'artifact_delivery_old',
        'data/exports/project_delivery/old.mp4', ?, 123, ?)`)
      .run("c".repeat(64), now);
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'exported', latest_export_id = 'export_delivery', latest_exported_at = ?, updated_at = ?
      WHERE project_id = 'project_delivery'`).run(now, now);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id,
        created_at, started_at, finished_at, updated_at)
      VALUES ('job_export_mismatched_input', 'project_delivery', 'export', 'succeeded',
        '{"artifact_id":"artifact_delivery_old"}', 'export_delivery', ?, ?, ?, ?)`)
      .run(now, now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id,
        created_at, started_at, finished_at, updated_at)
      VALUES ('job_export_delivery', 'project_delivery', 'export', 'succeeded', '{"artifact_id":"artifact_delivery"}',
        'export_delivery', ?, ?, ?, ?)`).run(now, now, now, now);
    const insertSucceededEvent = db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES (?, 'project_delivery', ?, ?, 'approved', 'exported', ?, ?, 'SYNTHETIC_SUCCEEDED', '{}', ?)`);
    assert.throws(() => insertSucceededEvent.run("event_export_wrong_job_type", "job_assembly_historical",
      "export_succeeded", "artifact_delivery", "export_delivery", now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertSucceededEvent.run("event_export_wrong_artifact", "job_export_delivery",
      "export_succeeded", "artifact_delivery_old", "export_delivery", now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertSucceededEvent.run("event_export_wrong_export", "job_export_delivery",
      "export_succeeded", "artifact_delivery_old", "export_delivery_old", now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.doesNotThrow(() => insertSucceededEvent.run("event_export_succeeded", "job_export_delivery",
      "export_succeeded", "artifact_delivery", "export_delivery", now));
    assert.throws(() => db.prepare("UPDATE workbench_exports SET size_bytes = 456 WHERE export_id = 'export_delivery'").run(), /WORKBENCH_EXPORT_IMMUTABLE/);
    assert.throws(() => db.prepare("DELETE FROM workbench_exports WHERE export_id = 'export_delivery'").run(), /WORKBENCH_EXPORT_IMMUTABLE/);

    const insertCloseout = db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES (?, 'project_delivery', 'closeout', 'exported', 'closed', ?, ?, 'CLOSEOUT_CONFIRMED', '{}', ?)`);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'closed', closed_at = ?, updated_at = ? WHERE project_id = 'project_delivery'`).run(now, now),
    /WORKBENCH_DELIVERY_STATE_TRANSITION_INVALID/);
    assert.throws(() => insertCloseout.run("event_closeout_stale", "artifact_delivery_old", "export_delivery_old", now),
      /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertCloseout.run("event_closeout_stale_export", "artifact_delivery", "export_delivery_old", now),
      /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertCloseout.run("event_closeout_stale_artifact", "artifact_delivery_old", "export_delivery", now),
      /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.deepEqual({ ...(db.prepare(`SELECT workflow_state, closed_at FROM workbench_delivery_state
      WHERE project_id = 'project_delivery'`).get() as Record<string, unknown>) },
    { workflow_state: "exported", closed_at: null });
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM workbench_delivery_events
      WHERE project_id = 'project_delivery' AND event_type = 'closeout'`).get() as { count: number }).count, 0);
    assert.doesNotThrow(() => insertCloseout.run("event_closeout", "artifact_delivery", "export_delivery", now));
    assert.deepEqual({ ...(db.prepare(`SELECT workflow_state, closed_at FROM workbench_delivery_state
      WHERE project_id = 'project_delivery'`).get() as Record<string, unknown>) },
    { workflow_state: "closed", closed_at: now });
    assert.throws(() => insertCloseout.run("event_closeout_duplicate", "artifact_delivery", "export_delivery", "2026-08-13T00:01:00.000Z"),
      /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    const writable = assertWorkbenchProjectWritable(db, "project_delivery");
    assert.equal(writable.ok ? null : writable.error.code, "PROJECT_CLOSED");
    assert.throws(() => db.prepare("UPDATE workbench_delivery_state SET updated_at = updated_at WHERE project_id = 'project_delivery'").run(), /PROJECT_CLOSED/);
    assert.throws(() => db.prepare("DELETE FROM workbench_delivery_state WHERE project_id = 'project_delivery'").run(), /WORKBENCH_DELIVERY_STATE_IMMUTABLE/);
  } finally {
    db.close();
  }
});

test("delivery evidence pointers change only through legal assembly, review, rework, and export transitions", () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = "project_pointer_transitions";
    const now = "2026-08-14T01:00:00.000Z";
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run(projectId, projectJson(projectId, "video_review"));
    insertFinalArtifact(db, projectId, "artifact_pointer_a");
    insertFinalArtifact(db, projectId, "artifact_pointer_b");

    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review',
      current_final_artifact_id = 'artifact_pointer_a', updated_at = ? WHERE project_id = ?`).run(now, projectId);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET current_final_artifact_id = 'artifact_pointer_b', updated_at = ? WHERE project_id = ?`).run(now, projectId),
      /WORKBENCH_DELIVERY_STATE_TRANSITION_INVALID/);

    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
      approved_artifact_id = 'artifact_pointer_a', updated_at = ? WHERE project_id = ?`).run(now, projectId);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state SET
      current_final_artifact_id = 'artifact_pointer_b', approved_artifact_id = 'artifact_pointer_b', updated_at = ?
      WHERE project_id = ?`).run(now, projectId), /WORKBENCH_DELIVERY_STATE_TRANSITION_INVALID/);

    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'revision_requested',
      approved_artifact_id = NULL, updated_at = ? WHERE project_id = ?`).run(now, projectId);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review',
      current_final_artifact_id = 'artifact_pointer_b', approved_artifact_id = NULL, updated_at = ? WHERE project_id = ?`)
      .run(now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
      approved_artifact_id = 'artifact_pointer_b', updated_at = ? WHERE project_id = ?`).run(now, projectId);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_pointer_b', ?, 'artifact_pointer_b', 'data/exports/project_pointer_transitions/final.mp4', ?, 123, ?)`)
      .run(projectId, "d".repeat(64), now);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_pointer_b_old', ?, 'artifact_pointer_b', 'data/exports/project_pointer_transitions/older.mp4', ?, 123, ?)`)
      .run(projectId, "b".repeat(64), now);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_pointer_a', ?, 'artifact_pointer_a', 'data/exports/project_pointer_transitions/old.mp4', ?, 123, ?)`)
      .run(projectId, "c".repeat(64), now);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET latest_export_id = 'export_pointer_b', latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
      .run(now, now, projectId), /WORKBENCH_DELIVERY_STATE_TRANSITION_INVALID/);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported',
      latest_export_id = 'export_pointer_b', latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
      .run(now, now, projectId);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET latest_export_id = 'export_pointer_b_old', latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
      .run(now, now, projectId), /WORKBENCH_DELIVERY_STATE_TRANSITION_INVALID/);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_state
      SET latest_exported_at = '2026-08-14T01:01:00.000Z', updated_at = ? WHERE project_id = ?`)
      .run(now, projectId), /WORKBENCH_DELIVERY_STATE_TRANSITION_INVALID/);
    const insertReused = db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES (?, ?, 'export_succeeded', 'approved', 'exported', ?, ?, 'EXPORT_REUSED', '{"reused":true}', ?)`);
    assert.throws(() => insertReused.run("event_pointer_reused_stale", projectId,
      "artifact_pointer_a", "export_pointer_a", now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.doesNotThrow(() => insertReused.run("event_pointer_reused", projectId,
      "artifact_pointer_b", "export_pointer_b", now));
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble',
      approved_artifact_id = NULL, latest_export_id = NULL, latest_exported_at = NULL, updated_at = ?
      WHERE project_id = ?`).run(now, projectId);
    assert.deepEqual({ ...(db.prepare(`SELECT workflow_state, current_final_artifact_id,
      approved_artifact_id, latest_export_id FROM workbench_delivery_state WHERE project_id = ?`)
      .get(projectId) as Record<string, unknown>) }, {
      workflow_state: "ready_to_assemble",
      current_final_artifact_id: "artifact_pointer_b",
      approved_artifact_id: null,
      latest_export_id: null
    });
  } finally {
    db.close();
  }
});

test("delivery lifecycle events bind to the matching Job type, state, Artifact, and Export", () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = "project_event_semantics";
    const now = "2026-08-14T02:00:00.000Z";
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run(projectId, projectJson(projectId, "video_review"));
    insertFinalArtifact(db, projectId, "artifact_event_final");
    insertFinalArtifact(db, projectId, "artifact_event_other");
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_event_final', ?, 'artifact_event_final', 'data/exports/project_event_semantics/final.mp4', ?, 123, ?),
        ('export_event_other', ?, 'artifact_event_other', 'data/exports/project_event_semantics/other.mp4', ?, 123, ?)`)
      .run(projectId, "e".repeat(64), now, projectId, "f".repeat(64), now);
    const insertEvent = db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SYNTHETIC_EVENT', '{}', ?)`);

    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, created_at, updated_at)
      VALUES ('job_event_assembly', ?, 'assembly', 'queued', '{}', ?, ?)`)
      .run(projectId, now, now);
    assert.doesNotThrow(() => insertEvent.run("event_assembly_queued", projectId, "job_event_assembly",
      "assembly_queued", "ready_to_assemble", "assembling", null, null, now));
    assert.throws(() => insertEvent.run("event_assembly_started_early", projectId, "job_event_assembly",
      "assembly_started", "assembling", "assembling", null, null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    db.prepare(`UPDATE workbench_delivery_jobs SET state = 'running', started_at = ?, updated_at = ?
      WHERE job_id = 'job_event_assembly'`).run(now, now);
    assert.doesNotThrow(() => insertEvent.run("event_assembly_started", projectId, "job_event_assembly",
      "assembly_started", "assembling", "assembling", null, null, now));
    db.prepare(`UPDATE workbench_delivery_jobs SET state = 'succeeded', output_artifact_id = 'artifact_event_final',
      finished_at = ?, updated_at = ? WHERE job_id = 'job_event_assembly'`).run(now, now);
    assert.throws(() => insertEvent.run("event_assembly_succeeded_wrong_artifact", projectId, "job_event_assembly",
      "assembly_succeeded", "assembling", "final_review", "artifact_event_other", null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertEvent.run("event_assembly_succeeded_wrong_state", projectId, "job_event_assembly",
      "assembly_succeeded", "closed", "not_ready", "artifact_event_final", null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.doesNotThrow(() => insertEvent.run("event_assembly_succeeded", projectId, "job_event_assembly",
      "assembly_succeeded", "assembling", "final_review", "artifact_event_final", null, now));

    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, error_code, created_at, finished_at, updated_at)
      VALUES ('job_event_assembly_failed', ?, 'assembly', 'failed', '{}', 'SYNTHETIC_FAILURE', ?, ?, ?),
        ('job_event_assembly_interrupted', ?, 'assembly', 'interrupted', '{}', 'SYNTHETIC_INTERRUPTION', ?, ?, ?)`)
      .run(projectId, now, now, now, projectId, now, now, now);
    assert.doesNotThrow(() => insertEvent.run("event_assembly_failed", projectId, "job_event_assembly_failed",
      "assembly_failed", "assembling", "ready_to_assemble", null, null, now));
    assert.doesNotThrow(() => insertEvent.run("event_assembly_interrupted", projectId, "job_event_assembly_interrupted",
      "assembly_interrupted", "assembling", "ready_to_assemble", null, null, now));
    assert.throws(() => insertEvent.run("event_assembly_wrong_terminal", projectId, "job_event_assembly_failed",
      "assembly_interrupted", "assembling", "ready_to_assemble", null, null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);

    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review',
      current_final_artifact_id = 'artifact_event_final', updated_at = ? WHERE project_id = ?`).run(now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
      approved_artifact_id = 'artifact_event_final', updated_at = ? WHERE project_id = ?`).run(now, projectId);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, created_at, updated_at)
      VALUES ('job_event_export_wrong_input', ?, 'export', 'queued', '{"artifact_id":"artifact_event_other"}', ?, ?)`)
      .run(projectId, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, created_at, updated_at)
      VALUES ('job_event_export', ?, 'export', 'queued', '{"artifact_id":"artifact_event_final"}', ?, ?)`)
      .run(projectId, now, now);
    assert.doesNotThrow(() => insertEvent.run("event_export_queued", projectId, "job_event_export",
      "export_queued", "approved", "approved", "artifact_event_final", null, now));
    assert.throws(() => insertEvent.run("event_export_queued_wrong_artifact", projectId, "job_event_export",
      "export_queued", "approved", "approved", "artifact_event_other", null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertEvent.run("event_export_started_early", projectId, "job_event_export",
      "export_started", "approved", "approved", "artifact_event_final", null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    db.prepare(`UPDATE workbench_delivery_jobs SET state = 'running', started_at = ?, updated_at = ?
      WHERE job_id = 'job_event_export'`).run(now, now);
    assert.doesNotThrow(() => insertEvent.run("event_export_started", projectId, "job_event_export",
      "export_started", "approved", "approved", "artifact_event_final", null, now));
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported',
      latest_export_id = 'export_event_final', latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
      .run(now, now, projectId);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_jobs SET state = 'succeeded', export_id = 'export_event_other',
      finished_at = ?, updated_at = ? WHERE job_id = 'job_event_export'`).run(now, now),
    /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    db.prepare(`UPDATE workbench_delivery_jobs SET state = 'succeeded', export_id = 'export_event_final',
      finished_at = ?, updated_at = ? WHERE job_id = 'job_event_export'`).run(now, now);
    assert.throws(() => insertEvent.run("event_export_succeeded_wrong_artifact", projectId, "job_event_export",
      "export_succeeded", "approved", "exported", "artifact_event_other", "export_event_final", now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertEvent.run("event_export_succeeded_wrong_export", projectId, "job_event_export",
      "export_succeeded", "approved", "exported", "artifact_event_other", "export_event_other", now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.doesNotThrow(() => insertEvent.run("event_export_succeeded", projectId, "job_event_export",
      "export_succeeded", "approved", "exported", "artifact_event_final", "export_event_final", now));
    assert.throws(() => insertEvent.run("event_export_with_assembly_job", projectId, "job_event_assembly",
      "export_succeeded", "approved", "exported", "artifact_event_final", "export_event_final", now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertEvent.run("event_assembly_with_export_job", projectId, "job_event_export",
      "assembly_succeeded", "assembling", "final_review", "artifact_event_final", null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);

    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, error_code, created_at, finished_at, updated_at)
      VALUES ('job_event_export_failed', ?, 'export', 'failed', '{"artifact_id":"artifact_event_final"}', 'SYNTHETIC_FAILURE', ?, ?, ?),
        ('job_event_export_interrupted', ?, 'export', 'interrupted', '{"artifact_id":"artifact_event_final"}', 'SYNTHETIC_INTERRUPTION', ?, ?, ?)`)
      .run(projectId, now, now, now, projectId, now, now, now);
    assert.doesNotThrow(() => insertEvent.run("event_export_failed", projectId, "job_event_export_failed",
      "export_failed", "approved", "approved", "artifact_event_final", null, now));
    assert.doesNotThrow(() => insertEvent.run("event_export_interrupted", projectId, "job_event_export_interrupted",
      "export_interrupted", "approved", "approved", "artifact_event_final", null, now));
    assert.throws(() => insertEvent.run("event_export_wrong_terminal", projectId, "job_event_export_failed",
      "export_interrupted", "approved", "approved", "artifact_event_final", null, now), /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
  } finally {
    db.close();
  }
});

test("final review events bind to the current final evidence and target delivery state", () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = "project_final_review_events";
    const now = "2026-08-14T02:30:00.000Z";
    const fingerprint = "9".repeat(64);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run(projectId, projectJson(projectId, "video_review"));
    insertFinalArtifact(db, projectId, "artifact_review_current");
    insertFinalArtifact(db, projectId, "artifact_review_other");
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_review_current', ?, 'artifact_review_current',
        'data/exports/project_final_review_events/final.mp4', ?, 123, ?)`)
      .run(projectId, "8".repeat(64), now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, error_code, created_at, finished_at, updated_at)
      VALUES ('job_review_unrelated', ?, 'assembly', 'failed', '{}', 'SYNTHETIC_FAILURE', ?, ?, ?)`)
      .run(projectId, now, now, now);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'assembling',
      assembly_input_fingerprint = ?, updated_at = ? WHERE project_id = ?`)
      .run(fingerprint, now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review',
      current_final_artifact_id = 'artifact_review_current', updated_at = ? WHERE project_id = ?`)
      .run(now, projectId);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
      approved_artifact_id = 'artifact_review_current', updated_at = ? WHERE project_id = ?`)
      .run(now, projectId);

    const insertReviewEvent = db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id,
        export_id, input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNTHETIC_REVIEW', '{}', ?)`);
    assert.throws(() => insertReviewEvent.run("event_review_missing_artifact", projectId, null,
      "final_review_accepted", "final_review", "approved", null, null, fingerprint, now),
    /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertReviewEvent.run("event_review_wrong_artifact", projectId, null,
      "final_review_accepted", "final_review", "approved", "artifact_review_other", null, fingerprint, now),
    /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertReviewEvent.run("event_review_wrong_job", projectId, "job_review_unrelated",
      "final_review_accepted", "final_review", "approved", "artifact_review_current", null, fingerprint, now),
    /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertReviewEvent.run("event_review_wrong_export", projectId, null,
      "final_review_accepted", "final_review", "approved", "artifact_review_current", "export_review_current", fingerprint, now),
    /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertReviewEvent.run("event_review_wrong_fingerprint", projectId, null,
      "final_review_accepted", "final_review", "approved", "artifact_review_current", null, "7".repeat(64), now),
    /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.throws(() => insertReviewEvent.run("event_review_wrong_pair", projectId, null,
      "final_review_accepted", "closed", "approved", "artifact_review_current", null, fingerprint, now),
    /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    assert.doesNotThrow(() => insertReviewEvent.run("event_review_accepted", projectId, null,
      "final_review_accepted", "final_review", "approved", "artifact_review_current", null, fingerprint, now));

    assert.throws(() => insertReviewEvent.run("event_review_reassemble_before_state", projectId, null,
      "final_review_reassemble", "approved", "ready_to_assemble", "artifact_review_current", null, fingerprint, now),
    /WORKBENCH_DELIVERY_EVENT_BINDING_INVALID/);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble',
      approved_artifact_id = NULL, updated_at = ? WHERE project_id = ?`).run(now, projectId);
    assert.doesNotThrow(() => insertReviewEvent.run("event_review_reassemble", projectId, null,
      "final_review_reassemble", "approved", "ready_to_assemble", "artifact_review_current", null, fingerprint, now));

    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'final_review', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'revision_requested', updated_at = ? WHERE project_id = ?")
      .run(now, projectId);
    assert.doesNotThrow(() => insertReviewEvent.run("event_review_regenerate", projectId, null,
      "final_review_regenerate_shots", "final_review", "revision_requested", "artifact_review_current", null, fingerprint, now));
  } finally {
    db.close();
  }
});

test("delivery jobs bind retries and terminal outputs to the same project and job type", () => {
  const db = openM0Database(":memory:");
  try {
    const now = "2026-08-14T00:00:00.000Z";
    for (const projectId of ["project_a", "project_b"]) {
      db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
        .run(projectId, projectJson(projectId, "video_review"));
      insertFinalArtifact(db, projectId, `artifact_${projectId}`);
      db.prepare(`INSERT INTO workbench_exports
        (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, 123, ?)`)
        .run(`export_${projectId}`, projectId, `artifact_${projectId}`,
          `data/exports/${projectId}/final.mp4`, "c".repeat(64), now);
    }
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = 'project_a'").run(now);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = 'project_a'").run(now);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review',
      current_final_artifact_id = 'artifact_project_a', updated_at = ? WHERE project_id = 'project_a'`).run(now);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
      approved_artifact_id = 'artifact_project_a', updated_at = ? WHERE project_id = 'project_a'`).run(now);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported', latest_export_id = 'export_project_a',
      latest_exported_at = ?, updated_at = ? WHERE project_id = 'project_a'`).run(now, now);
    db.prepare(`INSERT INTO media_artifacts
      (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
      VALUES ('artifact_wrong_role', 'project_a', '', 'generated_clip', 'video', 'active', ?)`)
      .run(JSON.stringify({
        artifact_id: "artifact_wrong_role",
        artifact_type: "video",
        role: "generated_clip",
        status: "active",
        linked_objects: { project_id: "project_a", shot_id: "" }
      }));

    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, error_code, created_at, finished_at, updated_at)
      VALUES ('parent_assembly_a', 'project_a', 'assembly', 'failed', '{}', 'SYNTHETIC_FAILURE', ?, ?, ?),
        ('parent_export_a', 'project_a', 'export', 'failed', '{}', 'SYNTHETIC_FAILURE', ?, ?, ?),
        ('parent_assembly_b', 'project_b', 'assembly', 'failed', '{}', 'SYNTHETIC_FAILURE', ?, ?, ?)`)
      .run(now, now, now, now, now, now, now, now, now);
    assert.doesNotThrow(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, retry_of_job_id, error_code, created_at, finished_at, updated_at)
      VALUES ('retry_assembly_a', 'project_a', 'assembly', 'failed', '{}', 'parent_assembly_a', 'SYNTHETIC_FAILURE', ?, ?, ?),
        ('retry_export_a', 'project_a', 'export', 'failed', '{}', 'parent_export_a', 'SYNTHETIC_FAILURE', ?, ?, ?)`)
      .run(now, now, now, now, now, now));
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, retry_of_job_id, error_code, created_at, finished_at, updated_at)
      VALUES ('retry_cross_project', 'project_a', 'assembly', 'failed', '{}', 'parent_assembly_b', 'SYNTHETIC_FAILURE', ?, ?, ?)`)
      .run(now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, retry_of_job_id, error_code, created_at, finished_at, updated_at)
      VALUES ('retry_wrong_type', 'project_a', 'export', 'failed', '{}', 'parent_assembly_a', 'SYNTHETIC_FAILURE', ?, ?, ?)`)
      .run(now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);

    assert.doesNotThrow(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, created_at, finished_at, updated_at)
      VALUES ('assembly_valid', 'project_a', 'assembly', 'succeeded', '{}', 'artifact_project_a', ?, ?, ?)`)
      .run(now, now, now));
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, created_at, finished_at, updated_at)
      VALUES ('assembly_cross_project', 'project_a', 'assembly', 'succeeded', '{}', 'artifact_project_b', ?, ?, ?)`)
      .run(now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, created_at, finished_at, updated_at)
      VALUES ('assembly_wrong_role', 'project_a', 'assembly', 'succeeded', '{}', 'artifact_wrong_role', ?, ?, ?)`)
      .run(now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, export_id, created_at, finished_at, updated_at)
      VALUES ('export_with_output', 'project_a', 'export', 'succeeded', '{"artifact_id":"artifact_project_a"}',
        'artifact_project_a', 'export_project_a', ?, ?, ?)`)
      .run(now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);

    assert.doesNotThrow(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id, created_at, finished_at, updated_at)
      VALUES ('export_valid', 'project_a', 'export', 'succeeded', '{"artifact_id":"artifact_project_a"}',
        'export_project_a', ?, ?, ?)`)
      .run(now, now, now));
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id, created_at, finished_at, updated_at)
      VALUES ('export_cross_project', 'project_a', 'export', 'succeeded', '{"artifact_id":"artifact_project_a"}',
        'export_project_b', ?, ?, ?)`)
      .run(now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    assert.throws(() => db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, export_id, created_at, finished_at, updated_at)
      VALUES ('assembly_with_export', 'project_a', 'assembly', 'succeeded', '{}', 'artifact_project_a', 'export_project_a', ?, ?, ?)`)
      .run(now, now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);

    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, created_at, started_at, updated_at)
      VALUES ('assembly_running', 'project_a', 'assembly', 'running', '{}', ?, ?, ?)`)
      .run(now, now, now);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'succeeded', output_artifact_id = 'artifact_project_b', finished_at = ?, updated_at = ?
      WHERE job_id = 'assembly_running'`).run(now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    assert.equal((db.prepare("SELECT state, output_artifact_id FROM workbench_delivery_jobs WHERE job_id = 'assembly_running'").get() as { state: string; output_artifact_id: string | null }).state, "running");
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'succeeded', output_artifact_id = 'artifact_project_a', finished_at = ?, updated_at = ?
      WHERE job_id = 'assembly_running'`).run(now, now);

    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, created_at, started_at, updated_at)
      VALUES ('export_running', 'project_a', 'export', 'running', '{"artifact_id":"artifact_project_a"}', ?, ?, ?)`)
      .run(now, now, now);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'succeeded', export_id = 'export_project_b', finished_at = ?, updated_at = ?
      WHERE job_id = 'export_running'`).run(now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    assert.equal((db.prepare("SELECT state, export_id FROM workbench_delivery_jobs WHERE job_id = 'export_running'").get() as { state: string; export_id: string | null }).state, "running");
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'succeeded', export_id = 'export_project_a', finished_at = ?, updated_at = ?
      WHERE job_id = 'export_running'`).run(now, now);

    const insertValidation = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'workbench_delivery_jobs_validate_insert'`).get() as { sql: string };
    db.exec("DROP TRIGGER workbench_delivery_jobs_validate_insert");
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, retry_of_job_id, created_at, updated_at)
      VALUES ('retry_queued_cross_project', 'project_a', 'assembly', 'queued', '{}', 'parent_assembly_b', ?, ?)`)
      .run(now, now);
    db.exec(insertValidation.sql);
    assert.throws(() => db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'failed', error_code = 'SYNTHETIC_FAILURE', finished_at = ?, updated_at = ?
      WHERE job_id = 'retry_queued_cross_project'`).run(now, now), /WORKBENCH_DELIVERY_JOB_BINDING_INVALID/);
    assert.equal((db.prepare("SELECT state FROM workbench_delivery_jobs WHERE job_id = 'retry_queued_cross_project'").get() as { state: string }).state, "queued");
  } finally {
    db.close();
  }
});

test("legacy four-state summaries reserve delivered exclusively for closed projects", () => {
  assert.equal(projectSummaryDeliveryState("not_ready"), "not_ready");
  assert.equal(projectSummaryDeliveryState("revision_requested"), "not_ready");
  assert.equal(projectSummaryDeliveryState("ready_to_assemble"), "ready_to_assemble");
  assert.equal(projectSummaryDeliveryState("assembling"), "ready_to_assemble");
  assert.equal(projectSummaryDeliveryState("final_review"), "final_review");
  assert.equal(projectSummaryDeliveryState("approved"), "final_review");
  assert.equal(projectSummaryDeliveryState("exported"), "final_review");
  assert.equal(projectSummaryDeliveryState("legacy_review_required"), "final_review");
  assert.equal(projectSummaryDeliveryState("closed"), "delivered");
});
