import { createHash } from "node:crypto";

import type { M0Database } from "./sqlite.js";
import { initializeWorkbenchV2Schema, WORKBENCH_V2_SCHEMA_VERSION } from "./workbenchV2Schema.js";

export const M0_BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS m0_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS shots (
    shot_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS storyboard_packages (
    storyboard_package_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS media_artifacts (
    artifact_id TEXT PRIMARY KEY,
    project_id TEXT,
    shot_id TEXT,
    role TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS generation_batches (
    batch_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_package_id TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS generation_runs (
    run_id TEXT PRIMARY KEY,
    batch_id TEXT,
    project_id TEXT NOT NULL,
    shot_id TEXT,
    run_type TEXT NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO m0_meta (key, value, updated_at)
  VALUES ('schema_version', 'm0-a', CURRENT_TIMESTAMP);
`;

const WORKBENCH_V2_4_CANONICAL = [
  WORKBENCH_V2_SCHEMA_VERSION,
  "workbench_project_meta", "import_index", "import_decisions", "regeneration_requests",
  "generation_intents", "workbench_drafts", "workbench_pending_actions", "workbench_inbox_events",
  "workbench_governance_runs", "workbench_review_notes", "webgpt_audit_events",
  "webgpt_media_grants", "webgpt_provider_price_cache"
].join("\n");

interface Migration {
  id: string;
  name: string;
  canonical: string;
  apply: (db: M0Database) => void;
}

export const DATABASE_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001",
    name: "m0_baseline",
    canonical: M0_BASE_SCHEMA_SQL,
    apply: (db) => db.exec(M0_BASE_SCHEMA_SQL)
  },
  {
    id: "0002",
    name: "workbench_v2_4_baseline",
    canonical: WORKBENCH_V2_4_CANONICAL,
    apply: (db) => initializeWorkbenchV2Schema(db, { manage_transaction: false })
  }
];

export function migrationChecksum(migration: Pick<Migration, "id" | "name" | "canonical">): string {
  const normalized = `${migration.id}\n${migration.name}\n${migration.canonical.replace(/\r\n/g, "\n").trim()}\n`;
  return createHash("sha256").update(normalized).digest("hex");
}

function ensureLedger(db: M0Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function tableNames(db: M0Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function isCurrentUnledgeredDatabase(db: M0Database): boolean {
  const tables = tableNames(db);
  const required = ["m0_meta", "projects", "shots", "media_artifacts", "generation_runs", "workbench_project_meta", "generation_intents", "webgpt_audit_events"];
  if (!required.every((name) => tables.has(name)) || tables.has("schema_migrations")) return false;
  const row = db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row?.value === WORKBENCH_V2_SCHEMA_VERSION;
}

function insertMigration(db: M0Database, migration: Migration): void {
  db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
    .run(migration.id, migration.name, migrationChecksum(migration));
}

export class SchemaMigrationRequiredError extends Error {
  readonly code = "SCHEMA_MIGRATION_REQUIRED";

  constructor(message = "Database schema migration is required.") {
    super(message);
  }
}

export function assertSchemaCurrent(db: M0Database): void {
  const tables = tableNames(db);
  if (!tables.has("schema_migrations")) throw new SchemaMigrationRequiredError();
  const applied = db.prepare("SELECT migration_id, name, checksum FROM schema_migrations ORDER BY migration_id").all() as Array<{ migration_id: string; name: string; checksum: string }>;
  const knownIds = new Set(DATABASE_MIGRATIONS.map((migration) => migration.id));
  const futureRows = applied.filter((row) => !knownIds.has(row.migration_id));
  if (futureRows.length > 0) {
    throw new SchemaMigrationRequiredError(`Database contains unsupported migration ${futureRows[0].migration_id}.`);
  }
  for (const migration of DATABASE_MIGRATIONS) {
    const row = applied.find((candidate) => candidate.migration_id === migration.id);
    if (!row) throw new SchemaMigrationRequiredError(`Missing database migration ${migration.id}.`);
    if (row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
      throw new SchemaMigrationRequiredError(`Database migration checksum mismatch for ${migration.id}.`);
    }
  }
}

export function runDatabaseMigrations(db: M0Database): { applied: string[]; baselined: boolean } {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  if (isCurrentUnledgeredDatabase(db)) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      ensureLedger(db);
      for (const migration of DATABASE_MIGRATIONS) insertMigration(db, migration);
      db.exec("COMMIT");
      return { applied: DATABASE_MIGRATIONS.map((migration) => migration.id), baselined: true };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const appliedIds: string[] = [];
  for (const migration of DATABASE_MIGRATIONS) {
    const tables = tableNames(db);
    const existing = tables.has("schema_migrations")
      ? db.prepare("SELECT name, checksum FROM schema_migrations WHERE migration_id = ?").get(migration.id) as { name: string; checksum: string } | undefined
      : undefined;
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== migrationChecksum(migration)) {
        throw new SchemaMigrationRequiredError(`Database migration checksum mismatch for ${migration.id}.`);
      }
      continue;
    }
    db.exec("BEGIN EXCLUSIVE");
    try {
      ensureLedger(db);
      migration.apply(db);
      insertMigration(db, migration);
      db.exec("COMMIT");
      appliedIds.push(migration.id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  assertSchemaCurrent(db);
  return { applied: appliedIds, baselined: false };
}
