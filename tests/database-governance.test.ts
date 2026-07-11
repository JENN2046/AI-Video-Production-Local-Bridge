import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { backupDatabase, checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { assertSchemaCurrent, DATABASE_MIGRATIONS, M0_BASE_SCHEMA_SQL, migrationChecksum, runDatabaseMigrations, SchemaMigrationRequiredError } from "../src/storage/migrations.js";
import { initializeWorkbenchV2Schema } from "../src/storage/workbenchV2Schema.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai-video-db-governance-"));
}

test("fresh database migrates explicitly and remains idempotent", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const first = migrateDatabase(sqlitePath);
    assert.deepEqual(first.applied, ["0001", "0002", "0003"]);
    assert.equal(first.baselined, false);
    const second = migrateDatabase(sqlitePath);
    assert.deepEqual(second.applied, []);
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
});
