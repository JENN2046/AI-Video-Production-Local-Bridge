import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { backupDatabase, checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { assertSchemaCurrent, DATABASE_MIGRATIONS, M0_BASE_SCHEMA_SQL, migrationChecksum, runDatabaseMigrations, SchemaMigrationRequiredError } from "../src/storage/migrations.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { initializeWorkbenchV2Schema } from "../src/storage/workbenchV2Schema.js";
import { persistMediaArtifact, type MediaArtifact } from "../src/tools/mediaArtifacts.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai-video-db-governance-"));
}

test("fresh database migrates explicitly and remains idempotent", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const first = migrateDatabase(sqlitePath);
    assert.deepEqual(first.applied, ["0001", "0002", "0003", "0004"]);
    assert.equal(first.baselined, false);
    const second = migrateDatabase(sqlitePath);
    assert.deepEqual(second.applied, []);
    assert.equal(checkDatabase(sqlitePath).result, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh database migration creates a missing parent directory", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "new", "nested", "app.sqlite");
    const result = migrateDatabase(sqlitePath);
    assert.deepEqual(result.applied, DATABASE_MIGRATIONS.map((migration) => migration.id));
    assert.equal(checkDatabase(sqlitePath).result, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing workbench-v2-4 database is baselined without rewriting business rows", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec("BEGIN IMMEDIATE");
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db, { manage_transaction: false });
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_existing', ?)").run(JSON.stringify({ project_id: "project_existing", title: "Existing" }));
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
       estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id, status)
      VALUES ('intent_existing', 'project_existing', 'shot_existing', 'runninghub', 'personal', 'model', 'artifact_existing', 6,
        '1080x1920', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', 'task_existing', 'running')`).run();
    db.exec("COMMIT");
    const before = db.prepare("SELECT data_json FROM projects WHERE project_id = 'project_existing'").get() as { data_json: string };
    const result = runDatabaseMigrations(db);
    const after = db.prepare("SELECT data_json FROM projects WHERE project_id = 'project_existing'").get() as { data_json: string };
    assert.equal(result.baselined, true);
    assert.equal(after.data_json, before.data_json);
    const backfilled = db.prepare(`SELECT j.state, e.to_state, e.reason_code FROM generation_jobs j
      JOIN generation_job_events e ON e.job_id = j.job_id WHERE j.intent_id = 'intent_existing'`).get() as { state: string; to_state: string; reason_code: string };
    assert.deepEqual({ ...backfilled }, { state: "polling", to_state: "polling", reason_code: "MIGRATION_BACKFILL" });
    assertSchemaCurrent(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration checksum drift fails closed", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("UPDATE schema_migrations SET checksum = 'changed' WHERE migration_id = '0002'").run();
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && error.code === "SCHEMA_MIGRATION_REQUIRED");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing v2-4 baseline rejects weakened table CHECK constraints", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    db.exec("ALTER TABLE workbench_project_meta RENAME TO workbench_project_meta_canonical");
    db.exec(`CREATE TABLE workbench_project_meta (
      project_id TEXT PRIMARY KEY,
      classification TEXT NOT NULL DEFAULT 'unclassified',
      lifecycle TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      last_opened_at TEXT,
      next_action_override TEXT NOT NULL DEFAULT '',
      next_action_priority TEXT,
      next_action_expires_at TEXT,
      next_action_project_status TEXT,
      next_action_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec("DROP TABLE workbench_project_meta_canonical");
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /check_constraints:workbench_project_meta/.test(error.message));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test("schema validation rejects weakened UNIQUE and REFERENCES constraints", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "weakened-non-check-constraints.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE generation_job_events;
      DROP TABLE generation_jobs;
      CREATE TABLE generation_jobs (
        job_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_token TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT,
        next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        reconciliation_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (state IN ('queued','submitting','polling','downloading','finalizing','manual_reconciliation','succeeded','failed','cancelled'))
      );
      CREATE TABLE generation_job_events (
        event_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        from_state TEXT NOT NULL DEFAULT '',
        to_state TEXT NOT NULL,
        reason_code TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_generation_jobs_due ON generation_jobs(state, next_attempt_at, created_at);
      CREATE INDEX idx_generation_job_events_job ON generation_job_events(job_id, created_at);
      CREATE TRIGGER generation_job_events_no_update
        BEFORE UPDATE ON generation_job_events BEGIN
          SELECT RAISE(ABORT, 'GENERATION_JOB_EVENTS_APPEND_ONLY');
        END;
      CREATE TRIGGER generation_job_events_no_delete
        BEFORE DELETE ON generation_job_events BEGIN
          SELECT RAISE(ABORT, 'GENERATION_JOB_EVENTS_APPEND_ONLY');
        END;
    `);
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError
      && /unique_constraints:generation_jobs/.test(error.message)
      && /foreign_keys:generation_jobs/.test(error.message)
      && /foreign_keys:generation_job_events/.test(error.message));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema validation preserves case-sensitive CHECK and default string literals", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "case-sensitive-schema-literals.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    const jobTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'generation_jobs'").get() as { sql: string };
    const jobIndexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'generation_jobs' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
    const driftedJobSql = jobTable.sql.replace("'queued'", "'QUEUED'");
    assert.notEqual(driftedJobSql, jobTable.sql);

    const metaTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workbench_project_meta'").get() as { sql: string };
    const metaIndexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workbench_project_meta' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
    const driftedMetaSql = metaTable.sql.replace("DEFAULT 'active'", "DEFAULT 'ACTIVE'");
    assert.notEqual(driftedMetaSql, metaTable.sql);

    db.exec("PRAGMA foreign_keys = OFF; DROP TABLE generation_jobs;");
    db.exec(driftedJobSql);
    for (const index of jobIndexes) db.exec(index.sql);
    db.exec("DROP TABLE workbench_project_meta;");
    db.exec(driftedMetaSql);
    for (const index of metaIndexes) db.exec(index.sql);
    db.exec("PRAGMA foreign_keys = ON;");

    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError
      && /check_constraints:generation_jobs/.test(error.message)
      && /column_definition:workbench_project_meta.lifecycle/.test(error.message));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime open cannot use a production environment flag to migrate persistent data", () => {
  const root = tempRoot();
  const previous = process.env.AI_VIDEO_AUTO_MIGRATE;
  const previousTestAutoMigrate = process.env.AI_VIDEO_TEST_AUTO_MIGRATE;
  try {
    const sqlitePath = join(root, "runtime.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    db.close();
    process.env.AI_VIDEO_AUTO_MIGRATE = "true";
    delete process.env.AI_VIDEO_TEST_AUTO_MIGRATE;
    assert.throws(() => openM0Database(sqlitePath), (error) => error instanceof SchemaMigrationRequiredError);
  } finally {
    if (previous === undefined) delete process.env.AI_VIDEO_AUTO_MIGRATE;
    else process.env.AI_VIDEO_AUTO_MIGRATE = previous;
    if (previousTestAutoMigrate === undefined) delete process.env.AI_VIDEO_TEST_AUTO_MIGRATE;
    else process.env.AI_VIDEO_TEST_AUTO_MIGRATE = previousTestAutoMigrate;
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema validation rejects migration rows from a newer runtime", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "future.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES ('9999', 'future_schema', 'future-checksum')").run();
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database migrated through 0003 keeps its historical checksums and upgrades through 0004", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "legacy-0003.sqlite");
    const db = new DatabaseSync(sqlitePath);
    for (const migration of DATABASE_MIGRATIONS.slice(0, 2)) migration.apply(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_legacy', ?)")
      .run(JSON.stringify({ project_id: "project_legacy", title: "Legacy 0003" }));
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
       estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id, status)
      VALUES ('intent_legacy', 'project_legacy', 'shot_legacy', 'runninghub', 'personal', 'model', 'artifact_legacy', 6,
        '1080x1920', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', 'task_legacy', 'running')`).run();
    DATABASE_MIGRATIONS[2].apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const migration of DATABASE_MIGRATIONS.slice(0, 3)) {
      db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
        .run(migration.id, migration.name, migrationChecksum(migration));
    }

    assert.equal(migrationChecksum(DATABASE_MIGRATIONS[1]), "52dc1311414cd88468542159d215adce443717b087e65d73d3f60859e5727c75");
    assert.equal(migrationChecksum(DATABASE_MIGRATIONS[2]), "161aa27dec915827c0ab6d46bc768ca2734c2efdf4bc45ae2fa1b2f4b564fef8");
    const result = runDatabaseMigrations(db);
    assert.deepEqual(result.applied, ["0004"]);
    const event = db.prepare("SELECT to_state, reason_code FROM generation_job_events WHERE job_id = 'job_intent_legacy'").get() as { to_state: string; reason_code: string };
    assert.deepEqual({ ...event }, { to_state: "polling", reason_code: "MIGRATION_BACKFILL" });
    assertSchemaCurrent(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing v2-4 baseline rejects missing columns and indexes", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    db.exec("ALTER TABLE generation_intents DROP COLUMN provider_task_id");
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /missing_column:generation_intents\.provider_task_id/.test(error.message));
    db.close();

    const indexPath = join(root, "missing-index.sqlite");
    migrateDatabase(indexPath);
    const indexed = new DatabaseSync(indexPath);
    indexed.exec("DROP INDEX idx_generation_intents_active");
    assert.throws(() => assertSchemaCurrent(indexed), (error) => error instanceof SchemaMigrationRequiredError && /missing_index:idx_generation_intents_active/.test(error.message));
    indexed.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema validation rejects index and trigger definitions with the expected names", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.exec("DROP INDEX idx_generation_intents_active; CREATE INDEX idx_generation_intents_active ON generation_intents(intent_id)");
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /index_definition:idx_generation_intents_active/.test(error.message));
    db.exec("DROP INDEX idx_generation_intents_active; CREATE INDEX idx_generation_intents_active ON generation_intents(status, updated_at DESC)");
    db.exec("DROP TRIGGER generation_job_events_no_delete; CREATE TRIGGER generation_job_events_no_delete BEFORE DELETE ON generation_job_events BEGIN SELECT 1; END");
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /trigger_definition:generation_job_events_no_delete/.test(error.message));
    db.close();

    const projectTriggerPath = join(root, "project-trigger.sqlite");
    migrateDatabase(projectTriggerPath);
    const projectTrigger = new DatabaseSync(projectTriggerPath);
    projectTrigger.exec("DROP TRIGGER trg_workbench_project_meta_after_insert; CREATE TRIGGER trg_workbench_project_meta_after_insert AFTER INSERT ON projects BEGIN SELECT 1; END");
    assert.throws(() => assertSchemaCurrent(projectTrigger), (error) => error instanceof SchemaMigrationRequiredError && /trigger_definition:trg_workbench_project_meta_after_insert/.test(error.message));
    projectTrigger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects missing structured identifiers and accepts external media URLs", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_missing_json_id', ?)")
      .run(JSON.stringify({ title: "Missing JSON identifier" }));
    db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES ('artifact_external', 'source', 'image', 'active', ?)")
      .run(JSON.stringify({ artifact_id: "artifact_external", storage: { uri: "https://example.test/media/storyboard.png" }, linked_objects: { project_id: "", shot_id: "" } }));
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, 1);
    assert.equal(checked.missing_media_files, 0);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check returns a structured failure for malformed JSON and missing schema", () => {
  const root = tempRoot();
  try {
    const malformedPath = join(root, "malformed.sqlite");
    migrateDatabase(malformedPath);
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec("DROP INDEX idx_projects_status_updated");
    malformed.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_bad_json', '{')").run();
    malformed.close();
    const malformedResult = checkDatabase(malformedPath);
    assert.equal(malformedResult.result, "FAIL");
    assert.equal(malformedResult.invalid_json_rows, 1);

    const missingPath = join(root, "missing.sqlite");
    migrateDatabase(missingPath);
    const missing = new DatabaseSync(missingPath);
    missing.exec("DROP TABLE generation_job_events");
    missing.close();
    const missingResult = checkDatabase(missingPath);
    assert.equal(missingResult.result, "FAIL");
    assert.equal(missingResult.schema_current, false);
    assert.equal(missingResult.check_errors > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check reports orphan rows", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO shots (shot_id, project_id, data_json) VALUES ('shot_orphan', 'project_missing', ?)")
      .run(JSON.stringify({ shot_id: "shot_orphan", project_id: "project_missing" }));
    db.close();
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.orphan_rows > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects package and batch drift plus missing batch links", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "links.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_links', ?)")
      .run(JSON.stringify({ project_id: "project_links" }));
    db.prepare("INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json) VALUES ('package_drift', 'project_links', ?)")
      .run(JSON.stringify({ storyboard_package_id: "package_other", project_id: "project_links" }));
    db.prepare("INSERT INTO generation_batches (batch_id, project_id, storyboard_package_id, data_json) VALUES ('batch_orphan_package', 'project_links', 'package_missing', ?)")
      .run(JSON.stringify({ batch_id: "batch_orphan_package", project_id: "project_links", storyboard_package_id: "package_missing" }));
    db.prepare("INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json) VALUES ('run_orphan_batch', 'batch_missing', 'project_links', '', 'image_to_video', 'queued', ?)")
      .run(JSON.stringify({ run_id: "run_orphan_batch", batch_id: "batch_missing", project_id: "project_links", shot_id: "" }));
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, 1);
    assert.equal(checked.orphan_rows, 2);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects run and artifact link drift", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "link-drift.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_link_drift', ?)")
      .run(JSON.stringify({ project_id: "project_link_drift" }));
    db.prepare("INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json) VALUES ('run_link_drift', '', 'project_link_drift', '', 'image_to_video', 'queued', ?)")
      .run(JSON.stringify({ run_id: "run_link_drift", batch_id: "batch_wrong", project_id: "project_link_drift", shot_id: "shot_wrong" }));
    db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES ('artifact_link_drift', 'project_link_drift', NULL, 'source', 'image', 'active', ?)")
      .run(JSON.stringify({ artifact_id: "artifact_link_drift", linked_objects: { project_id: "project_wrong", shot_id: "shot_wrong" } }));
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, 2);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects every regeneration request mirror-field drift", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "regeneration-request-drift.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_regen_drift', ?)")
      .run(JSON.stringify({ project_id: "project_regen_drift" }));
    db.prepare("INSERT INTO shots (shot_id, project_id, data_json) VALUES ('shot_regen_drift', 'project_regen_drift', ?)")
      .run(JSON.stringify({ shot_id: "shot_regen_drift", project_id: "project_regen_drift" }));
    db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES ('artifact_regen_drift', 'project_regen_drift', 'shot_regen_drift', 'source', 'image', 'active', ?)")
      .run(JSON.stringify({
        artifact_id: "artifact_regen_drift",
        storage: { uri: "https://media.example.test/artifact_regen_drift.png" },
        linked_objects: { project_id: "project_regen_drift", shot_id: "shot_regen_drift" }
      }));

    const mirroredFields = ["request_id", "project_id", "shot_id", "artifact_id", "previous_run_id", "status"] as const;
    const insertRequest = db.prepare("INSERT INTO regeneration_requests (request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json) VALUES (?, 'project_regen_drift', 'shot_regen_drift', 'artifact_regen_drift', 'run_regen_drift', 'draft', ?)");
    for (const field of mirroredFields) {
      const requestId = `request_${field}_drift`;
      const data = {
        request_id: requestId,
        project_id: "project_regen_drift",
        shot_id: "shot_regen_drift",
        artifact_id: "artifact_regen_drift",
        previous_run_id: "run_regen_drift",
        status: "draft"
      };
      data[field] = field === "status" ? "submitted" : `${data[field]}_wrong`;
      insertRequest.run(requestId, JSON.stringify(data));
    }
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, mirroredFields.length);
    assert.equal(checked.orphan_rows, 0);
    assert.equal(checked.missing_media_files, 0);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider task IDs are unique per provider at the database boundary", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    const artifact = (artifactId: string) => JSON.stringify({ artifact_id: artifactId, source: { provider: "runninghub", provider_job_id: "task_unique" } });
    db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, 'generated_clip', 'video', 'active', ?)")
      .run("artifact_unique_1", artifact("artifact_unique_1"));
    assert.throws(() => db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, 'generated_clip', 'video', 'active', ?)")
      .run("artifact_unique_2", artifact("artifact_unique_2")), /UNIQUE constraint failed/);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact persistence preserves the existing row on provider task conflicts", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "artifact-provider-task-conflict.sqlite");
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    const artifact = (artifactId: string, status: MediaArtifact["status"] = "active"): MediaArtifact => ({
      artifact_id: artifactId,
      artifact_type: "video",
      role: "generated_clip",
      status,
      storage: { uri: join(root, `${artifactId}.mp4`), mime_type: "video/mp4", filename: `${artifactId}.mp4` },
      metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: `sha-${artifactId}` },
      linked_objects: { project_id: "project_artifact_conflict", shot_id: "shot_artifact_conflict" },
      source: { kind: "provider_output_file", provider: "runninghub", provider_job_id: "task_artifact_conflict", sha256: `sha-${artifactId}`, external_url_host: "cdn.example.test" }
    });

    persistMediaArtifact(db, artifact("artifact_original"));
    db.prepare("INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json) VALUES ('run_artifact_reference', '', 'project_artifact_conflict', 'shot_artifact_conflict', 'image_to_video', 'succeeded', ?)")
      .run(JSON.stringify({ run_id: "run_artifact_reference", output: { artifact_ids: ["artifact_original"] } }));

    assert.throws(() => persistMediaArtifact(db, artifact("artifact_conflicting")), /UNIQUE constraint failed/);
    const rowsAfterConflict = db.prepare("SELECT artifact_id FROM media_artifacts WHERE json_extract(data_json, '$.source.provider_job_id') = 'task_artifact_conflict'").all() as Array<{ artifact_id: string }>;
    assert.deepEqual(rowsAfterConflict.map((row) => row.artifact_id), ["artifact_original"]);
    const referencedRun = db.prepare("SELECT data_json FROM generation_runs WHERE run_id = 'run_artifact_reference'").get() as { data_json: string };
    assert.deepEqual((JSON.parse(referencedRun.data_json) as { output: { artifact_ids: string[] } }).output.artifact_ids, ["artifact_original"]);

    persistMediaArtifact(db, artifact("artifact_original", "archived"));
    const updated = db.prepare("SELECT status, data_json FROM media_artifacts WHERE artifact_id = 'artifact_original'").get() as { status: string; data_json: string };
    assert.equal(updated.status, "archived");
    assert.equal((JSON.parse(updated.data_json) as MediaArtifact).status, "archived");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing v2-4 database fails with a stable reconciliation gate for duplicate provider tasks", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "duplicate-provider-task.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    const artifact = (artifactId: string) => JSON.stringify({ artifact_id: artifactId, source: { provider: "runninghub", provider_job_id: "legacy_duplicate_task" } });
    for (const artifactId of ["artifact_legacy_dup_1", "artifact_legacy_dup_2"]) {
      db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, 'generated_clip', 'video', 'active', ?)")
        .run(artifactId, artifact(artifactId));
    }
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError
      && error.code === "SCHEMA_MIGRATION_REQUIRED"
      && /PROVIDER_TASK_DUPLICATES_REQUIRE_RECONCILIATION: 1 duplicate provider task group/.test(error.message));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    assert.equal(tables.some((row) => row.name === "generation_jobs"), false);
    assert.equal(tables.some((row) => row.name === "schema_migrations"), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count, 2);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration fails cleanly when another connection owns the migration lock", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const owner = new DatabaseSync(sqlitePath);
    owner.exec(M0_BASE_SCHEMA_SQL);
    owner.exec("BEGIN EXCLUSIVE");
    assert.throws(() => migrateDatabase(sqlitePath), /locked/i);
    owner.exec("ROLLBACK");
    owner.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup and isolated restore preserve a valid database", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const backup = backupDatabase({ sqlite_path: sqlitePath, backup_root: join(root, "backups"), timestamp: new Date("2026-07-11T00:00:00.000Z") });
    const restoredPath = join(root, "restored.sqlite");
    copyFileSync(backup.backup_path, restoredPath);
    assert.equal(checkDatabase(restoredPath).result, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration checksum is deterministic", () => {
  assert.equal(migrationChecksum(DATABASE_MIGRATIONS[0]), migrationChecksum(DATABASE_MIGRATIONS[0]));
  assert.notEqual(migrationChecksum(DATABASE_MIGRATIONS[0]), migrationChecksum(DATABASE_MIGRATIONS[1]));
  assert.doesNotMatch(DATABASE_MIGRATIONS[1].canonical, /function\s+initializeWorkbenchV2Schema/);
});
