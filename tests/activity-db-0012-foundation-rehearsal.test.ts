import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { backupDatabase, databaseLogicalManifest } from "../src/storage/databaseGovernance.js";
import { DATABASE_MIGRATIONS, migrationChecksum } from "../src/storage/migrations.js";
import { getWorkbenchDeliveryState } from "../src/tools/workbenchDeliveryState.js";

interface SchemaSummary {
  object_count: number;
  sha256: string;
  names: string[];
}

interface BusinessSummary {
  table_names: string[];
  row_counts: Record<string, number>;
  sha256: string;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai-video-0012-foundation-rehearsal-"));
}

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

function projectJson(projectId: string, status: "draft" | "final_approved", finalArtifactId = ""): string {
  return JSON.stringify({
    project_id: projectId,
    title: projectId,
    project_type: "fixture",
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
    storage: { uri: "fixture.mp4", mime_type: "video/mp4", filename: "fixture.mp4" },
    metadata: { width: 1080, height: 1920, duration_seconds: 2, aspect_ratio: "9:16", sha256: "a".repeat(64) },
    linked_objects: { project_id: projectId, shot_id: "" },
    source: { kind: "synthetic_fixture", provider: "", provider_job_id: "", sha256: "a".repeat(64), external_url_host: "" }
  };
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, NULL, 'final_video', 'video', 'active', ?)`)
    .run(artifactId, projectId, JSON.stringify(artifact));
}

function create0011Fixture(sqlitePath: string, kind: "normal" | "pointerless" | "malformed"): void {
  const db = new DatabaseSync(sqlitePath);
  try {
    migrateThrough0011(db);
    if (kind === "normal") {
      db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('normal', ?)")
        .run(projectJson("normal", "final_approved", "final_a"));
      insertFinalArtifact(db, "normal", "final_a");
      insertFinalArtifact(db, "normal", "final_b");
    } else if (kind === "pointerless") {
      db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('pointerless', ?)")
        .run(projectJson("pointerless", "final_approved"));
    } else {
      db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('malformed', ?)")
        .run(projectJson("malformed", "final_approved", "missing_final"));
    }
  } finally {
    db.close();
  }
}

function migrateFixture(sqlitePath: string): void {
  const db = new DatabaseSync(sqlitePath);
  const migration = DATABASE_MIGRATIONS.find((item) => item.id === "0012");
  assert.ok(migration, "migration 0012 must remain registered");
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; BEGIN EXCLUSIVE;");
  try {
    const applied = (db.prepare("SELECT migration_id, name, checksum FROM schema_migrations ORDER BY migration_id").all() as Array<Record<string, unknown>>)
      .map((row) => ({
        migration_id: String(row.migration_id),
        name: String(row.name),
        checksum: String(row.checksum)
      }));
    assert.deepEqual(applied, expectedLedger("0011"));
    migration.apply(db);
    db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
      .run(migration.id, migration.name, migrationChecksum(migration));
    assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-7");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function migrationLedger(sqlitePath: string): Array<{ migration_id: string; name: string; checksum: string }> {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON;");
    const rows = db.prepare("SELECT migration_id, name, checksum FROM schema_migrations ORDER BY migration_id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      migration_id: String(row.migration_id),
      name: String(row.name),
      checksum: String(row.checksum)
    }));
  } finally {
    db.close();
  }
}

function expectedLedger(maxMigrationId: "0011" | "0012"): Array<{ migration_id: string; name: string; checksum: string }> {
  return DATABASE_MIGRATIONS.filter((migration) => migration.id <= maxMigrationId).map((migration) => ({
    migration_id: migration.id,
    name: migration.name,
    checksum: migrationChecksum(migration)
  }));
}

function schemaSummary(sqlitePath: string): SchemaSummary {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON;");
    const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Array<Record<string, unknown>>;
    return {
      object_count: objects.length,
      sha256: createHash("sha256").update(JSON.stringify(objects)).digest("hex"),
      names: objects.map((object) => String(object.name))
    };
  } finally {
    db.close();
  }
}

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function businessSummary(sqlitePath: string, expectedTables?: readonly string[]): BusinessSummary {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON;");
    const tableNames = expectedTables ? [...expectedTables] : (db.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('m0_meta', 'schema_migrations')
      ORDER BY name`).all() as Array<{ name: string }>).map(({ name }) => name);
    const payload = tableNames.map((table) => {
      const rows = db.prepare(`SELECT * FROM ${quotedIdentifier(table)} ORDER BY rowid`).all() as unknown[];
      return { table, rows };
    });
    return {
      table_names: tableNames,
      row_counts: Object.fromEntries(payload.map(({ table, rows }) => [table, rows.length])),
      sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    };
  } finally {
    db.close();
  }
}

function assertQuickCheck(sqlitePath: string): void {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.equal((db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
  } finally {
    db.close();
  }
}

test("RA-003 backup precedes isolated 0012 migration and restores into an independent target", () => {
  const root = tempRoot();
  try {
    const original0011Path = join(root, "original-0011.sqlite");
    const migrationCopyPath = join(root, "migration-copy.sqlite");
    const restoredTargetPath = join(root, "restored-independent.sqlite");
    create0011Fixture(original0011Path, "normal");

    const originalManifest = databaseLogicalManifest(original0011Path);
    const originalSchema = schemaSummary(original0011Path);
    const originalBusiness = businessSummary(original0011Path);
    const originalLedger = migrationLedger(original0011Path);
    assert.deepEqual(originalLedger, expectedLedger("0011"));

    const backup = backupDatabase({
      sqlite_path: original0011Path,
      backup_root: join(root, "backups"),
      timestamp: new Date("2026-08-24T00:00:00.000Z")
    });
    assert.equal(existsSync(backup.backup_path), true);
    assert.deepEqual(databaseLogicalManifest(original0011Path), originalManifest);

    assert.equal(existsSync(migrationCopyPath), false);
    assert.equal(existsSync(restoredTargetPath), false);
    copyFileSync(backup.backup_path, migrationCopyPath);
    migrateFixture(migrationCopyPath);
    assert.equal(existsSync(restoredTargetPath), false);
    copyFileSync(backup.backup_path, restoredTargetPath);
    assert.equal(existsSync(restoredTargetPath), true);

    assert.deepEqual(migrationLedger(original0011Path), originalLedger);
    assert.deepEqual(schemaSummary(original0011Path), originalSchema);
    assert.deepEqual(databaseLogicalManifest(original0011Path), originalManifest);
    assert.deepEqual(businessSummary(original0011Path), originalBusiness);

    for (const restored0011Path of [backup.backup_path, restoredTargetPath]) {
      assertQuickCheck(restored0011Path);
      assert.deepEqual(migrationLedger(restored0011Path), originalLedger);
      assert.deepEqual(schemaSummary(restored0011Path), originalSchema);
      assert.deepEqual(databaseLogicalManifest(restored0011Path), originalManifest);
      assert.deepEqual(businessSummary(restored0011Path), originalBusiness);
    }

    assertQuickCheck(migrationCopyPath);
    assert.deepEqual(migrationLedger(migrationCopyPath), expectedLedger("0012"));
    assert.deepEqual(businessSummary(migrationCopyPath, originalBusiness.table_names), originalBusiness);
    assert.notDeepEqual(schemaSummary(migrationCopyPath), originalSchema);
    assert.notDeepEqual(databaseLogicalManifest(migrationCopyPath), originalManifest);
    const migratedSchema = schemaSummary(migrationCopyPath);
    for (const table of ["workbench_exports", "workbench_delivery_jobs", "workbench_delivery_events", "workbench_delivery_state"]) {
      assert.equal(migratedSchema.names.includes(table), true);
    }

    const migrated = new DatabaseSync(migrationCopyPath);
    try {
      const state = getWorkbenchDeliveryState(migrated, "normal");
      assert.equal(state?.workflow_state, "legacy_review_required");
      assert.equal(state?.current_final_artifact_id, "final_a");
      assert.equal((migrated.prepare(`SELECT legacy_final_artifact_id FROM workbench_delivery_state
        WHERE project_id = 'normal'`).get() as { legacy_final_artifact_id: string }).legacy_final_artifact_id, "final_a");

      assert.throws(() => migrated.prepare(`UPDATE workbench_delivery_state
        SET current_final_artifact_id = 'final_b' WHERE project_id = 'normal'`).run(), /WORKBENCH_LEGACY_FINAL_ARTIFACT_IMMUTABLE/);

      migrated.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
        VALUES ('assembly_queued', 'normal', 'assembly', 'queued')`).run();
      assert.throws(() => migrated.prepare(`INSERT INTO workbench_delivery_jobs (job_id, project_id, job_type, state)
        VALUES ('export_queued', 'normal', 'export', 'queued')`).run(), /UNIQUE constraint failed/);
      assert.throws(() => migrated.prepare(`INSERT INTO workbench_delivery_jobs
        (job_id, project_id, job_type, state, terminal_event_id)
        VALUES ('assembly_terminal', 'normal', 'assembly', 'succeeded', 'missing_event')`).run(), /FOREIGN KEY constraint failed|CHECK constraint failed/);

      migrated.prepare(`INSERT INTO workbench_delivery_events (event_id, project_id, event_type, job_id)
        VALUES ('assembly_queued_event', 'normal', 'assembly_queued', 'assembly_queued')`).run();
      assert.throws(() => migrated.prepare("UPDATE workbench_delivery_events SET reason_code = 'rewrite' WHERE event_id = 'assembly_queued_event'").run(), /WORKBENCH_DELIVERY_EVENTS_APPEND_ONLY/);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RA-002 pointerless legacy fixture remains recoverable after 0012", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "pointerless.sqlite");
    create0011Fixture(sqlitePath, "pointerless");
    migrateFixture(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    try {
      const state = getWorkbenchDeliveryState(db, "pointerless");
      assert.equal(state?.workflow_state, "not_ready");
      assert.equal(state?.current_final_artifact_id, null);
      assert.equal((db.prepare(`SELECT legacy_final_artifact_id FROM workbench_delivery_state
        WHERE project_id = 'pointerless'`).get() as { legacy_final_artifact_id: null }).legacy_final_artifact_id, null);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_events").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RA-002 malformed legacy fixture blocks 0012 without fabricating delivery state", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "malformed.sqlite");
    create0011Fixture(sqlitePath, "malformed");
    const beforeManifest = databaseLogicalManifest(sqlitePath);
    const beforeBusiness = businessSummary(sqlitePath);
    assert.throws(() => migrateFixture(sqlitePath), /WORKBENCH_LEGACY_FINAL_ARTIFACT_INVALID/);
    const db = new DatabaseSync(sqlitePath);
    try {
      assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-6");
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_id = '0012'").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'workbench_delivery_state'").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
    assert.deepEqual(databaseLogicalManifest(sqlitePath), beforeManifest);
    assert.deepEqual(businessSummary(sqlitePath), beforeBusiness);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
