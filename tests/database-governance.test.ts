import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { backupDatabase, checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { assertSchemaCurrent, DATABASE_MIGRATIONS, M0_BASE_SCHEMA_SQL, migrationChecksum, runDatabaseMigrations, SchemaMigrationRequiredError } from "../src/storage/migrations.js";
import { initializeWorkbenchV2Schema } from "../src/storage/workbenchV2Schema.js";
import { openM0Database } from "../src/storage/sqlite.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai-video-db-governance-"));
}

test("fresh database migrates explicitly and remains idempotent", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const first = migrateDatabase(sqlitePath);
    assert.deepEqual(first.applied, ["0001", "0002"]);
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
    assert.deepEqual(result.applied, ["0001", "0002"]);
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
    db.exec("COMMIT");
    const before = db.prepare("SELECT data_json FROM projects WHERE project_id = 'project_existing'").get() as { data_json: string };
    const result = runDatabaseMigrations(db);
    const after = db.prepare("SELECT data_json FROM projects WHERE project_id = 'project_existing'").get() as { data_json: string };
    assert.equal(result.baselined, true);
    assert.equal(after.data_json, before.data_json);
    assertSchemaCurrent(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing v2-4 baseline rejects incomplete schema instead of stamping the ledger", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "incomplete.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    db.exec("DROP TABLE webgpt_media_grants");
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /missing_table:webgpt_media_grants/.test(error.message));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as { count: number }).count, 0);
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

test("runtime open cannot use an environment flag to migrate persistent data", () => {
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

test("schema validation rejects migration rows from a newer runtime", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "future.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES ('9999', 'future_schema', 'future-checksum')").run();
    db.prepare("DELETE FROM schema_migrations WHERE migration_id = '0002'").run();
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_id = '0002'").get() as { count: number }).count, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check fails on malformed and orphaned generation intent state", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "orphan-intent.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
       estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, status, data_json)
      VALUES ('intent_orphan', 'project_missing', 'shot_missing', 'runninghub', 'personal', 'model', 'artifact_missing', 6,
        '1080x1920', 0.1, 1, 'CNY', 0, '2099-01-01T00:00:00.000Z', 'prepared', 'not-json')`).run();
    db.close();
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.invalid_json_rows, 1);
    assert.equal(checked.orphan_rows >= 3, true);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration lock conflict rolls back without creating a ledger", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "locked.sqlite");
    const owner = new DatabaseSync(sqlitePath);
    owner.exec(M0_BASE_SCHEMA_SQL);
    owner.exec("BEGIN EXCLUSIVE");
    assert.throws(() => migrateDatabase(sqlitePath), /locked/i);
    owner.exec("ROLLBACK");
    assert.equal((owner.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as { count: number }).count, 0);
    owner.close();
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
