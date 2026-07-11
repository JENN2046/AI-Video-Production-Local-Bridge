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
    assert.deepEqual(first.applied, ["0001", "0002"]);
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
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    db.close();
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
