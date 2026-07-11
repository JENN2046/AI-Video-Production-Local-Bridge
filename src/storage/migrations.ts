import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { M0Database } from "./sqlite.js";
import { applyWorkbenchV24Baseline, WORKBENCH_V2_SCHEMA_VERSION } from "./workbenchV2Schema.js";

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

const V24_EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  m0_meta: ["key", "value", "updated_at"],
  projects: ["project_id", "data_json", "created_at", "updated_at"],
  shots: ["shot_id", "project_id", "data_json", "created_at", "updated_at"],
  storyboard_packages: ["storyboard_package_id", "project_id", "data_json", "created_at", "updated_at"],
  media_artifacts: ["artifact_id", "project_id", "shot_id", "role", "artifact_type", "status", "data_json", "created_at", "updated_at"],
  generation_batches: ["batch_id", "project_id", "storyboard_package_id", "data_json", "created_at", "updated_at"],
  generation_runs: ["run_id", "batch_id", "project_id", "shot_id", "run_type", "status", "data_json", "created_at", "updated_at"],
  workbench_project_meta: ["project_id", "classification", "lifecycle", "pinned", "last_opened_at", "next_action_override", "next_action_priority", "next_action_expires_at", "next_action_project_status", "next_action_updated_at", "created_at", "updated_at"],
  import_index: ["relative_path", "filename", "size_bytes", "mtime_ms", "checksum", "metadata_json", "scanned_at"],
  import_decisions: ["checksum", "filename", "decision", "target_project_id", "artifact_id", "reason", "created_at", "updated_at"],
  regeneration_requests: ["request_id", "project_id", "shot_id", "artifact_id", "previous_run_id", "status", "data_json", "created_at", "updated_at"],
  generation_intents: ["intent_id", "run_id", "project_id", "shot_id", "provider", "account_label", "model", "input_artifact_id", "duration_seconds", "resolution", "estimated_cost_value", "budget_limit_value", "currency", "confirmed", "expires_at", "provider_task_id", "status", "upload_attempts", "submit_attempts", "output_artifact_id", "sanitized_error_json", "data_json", "created_at", "updated_at"],
  workbench_drafts: ["draft_id", "tool", "status", "source", "parent_draft_id", "target_project_id", "target_shot_id", "promoted_object_type", "promoted_object_id", "revision_note", "data_json", "created_at", "updated_at"],
  workbench_pending_actions: ["action_id", "tool", "status", "source", "project_id", "data_json", "result_json", "created_at", "updated_at"],
  workbench_inbox_events: ["event_id", "object_type", "object_id", "event_type", "from_status", "to_status", "data_json", "created_at"],
  workbench_governance_runs: ["run_id", "snapshot_hash", "rule_groups_json", "affected_count", "result", "created_at"],
  workbench_review_notes: ["note_id", "project_id", "shot_id", "artifact_id", "author_hash", "note", "source", "created_at", "updated_at"],
  webgpt_audit_events: ["event_id", "request_id", "idempotency_key", "request_hash", "actor_hash", "tool", "project_id", "object_type", "object_id", "changed_fields_json", "before_hash", "after_hash", "result", "error_code", "result_json", "created_at"],
  webgpt_media_grants: ["grant_id", "token_hash", "actor_hash", "project_id", "artifact_id", "expires_at", "revoked_at", "created_at"],
  webgpt_provider_price_cache: ["provider", "model", "duration_seconds", "resolution", "estimated_cost_value", "currency", "source", "fetched_at", "expires_at"]
};

const V24_EXPECTED_INDEXES = [
  "idx_projects_updated", "idx_projects_status_updated", "idx_shots_project_order", "idx_media_updated",
  "idx_media_project_updated", "idx_media_type_role_status", "idx_runs_updated", "idx_runs_project_shot",
  "idx_project_meta_lifecycle", "idx_regeneration_project", "idx_generation_intents_active",
  "idx_import_decisions_project", "idx_workbench_drafts_status", "idx_workbench_pending_status",
  "idx_workbench_inbox_events_object", "idx_workbench_review_notes_shot", "idx_webgpt_audit_idempotency",
  "idx_webgpt_audit_project", "idx_webgpt_media_grants_expiry"
] as const;

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
    apply: (db) => applyWorkbenchV24Baseline(db, { manage_transaction: false })
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

interface ColumnDefinition {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ExpectedSchemaDefinitions {
  columns: Map<string, Map<string, string>>;
  objects: Map<string, string>;
}

let expectedDefinitionCache: ExpectedSchemaDefinitions | null = null;

function normalizeDefinition(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/if\s+not\s+exists/g, "").replace(/["`\[\]]/g, "").replace(/\s+/g, "");
}

function columnSignature(column: ColumnDefinition): string {
  return [normalizeDefinition(column.type), Number(column.notnull), normalizeDefinition(column.dflt_value), Number(column.pk)].join("|");
}

function expectedSchemaDefinitions(): ExpectedSchemaDefinitions {
  if (expectedDefinitionCache) return expectedDefinitionCache;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(M0_BASE_SCHEMA_SQL);
    applyWorkbenchV24Baseline(reference);
    const columns = new Map<string, Map<string, string>>();
    for (const table of Object.keys(V24_EXPECTED_COLUMNS)) {
      const tableColumns = reference.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnDefinition[];
      columns.set(table, new Map(tableColumns.map((column) => [column.name, columnSignature(column)])));
    }
    const objects = new Map<string, string>();
    for (const name of [...V24_EXPECTED_INDEXES, "trg_workbench_project_meta_after_insert"]) {
      const row = reference.prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('index', 'trigger')").get(name) as { sql: string | null } | undefined;
      objects.set(name, normalizeDefinition(row?.sql));
    }
    expectedDefinitionCache = { columns, objects };
    return expectedDefinitionCache;
  } finally {
    reference.close();
  }
}

function schemaObjects(db: M0Database): string[] {
  const issues: string[] = [];
  const definitions = expectedSchemaDefinitions();
  for (const [table, expected] of Object.entries(V24_EXPECTED_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnDefinition[];
    const columns = new Map(rows.map((row) => [row.name, row]));
    if (columns.size === 0) issues.push(`missing_table:${table}`);
    else for (const column of expected) {
      const actual = columns.get(column);
      if (!actual) issues.push(`missing_column:${table}.${column}`);
      else if (columnSignature(actual) !== definitions.columns.get(table)?.get(column)) issues.push(`column_definition:${table}.${column}`);
    }
  }
  for (const [kind, names] of [["index", V24_EXPECTED_INDEXES], ["trigger", ["trg_workbench_project_meta_after_insert"]]] as const) {
    for (const name of names) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(kind, name) as { sql: string | null } | undefined;
      if (!row) issues.push(`missing_${kind}:${name}`);
      else if (normalizeDefinition(row.sql) !== definitions.objects.get(name)) issues.push(`${kind}_definition:${name}`);
    }
  }
  return issues;
}

function isCurrentUnledgeredDatabase(db: M0Database): boolean {
  const tables = tableNames(db);
  const required = ["m0_meta", "projects", "shots", "media_artifacts", "generation_runs", "workbench_project_meta", "generation_intents", "webgpt_audit_events"];
  if (!required.every((name) => tables.has(name)) || tables.has("schema_migrations")) return false;
  const row = db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row?.value === WORKBENCH_V2_SCHEMA_VERSION && schemaObjects(db).length === 0;
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
  const issues = schemaObjects(db);
  if (issues.length > 0) throw new SchemaMigrationRequiredError(`Database schema structure mismatch: ${issues.join(", ")}.`);
}

export function runDatabaseMigrations(db: M0Database): { applied: string[]; baselined: boolean } {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  let baselined = false;
  const appliedIds: string[] = [];
  db.exec("BEGIN EXCLUSIVE");
  try {
    const initialTables = tableNames(db);
    if (initialTables.has("schema_migrations")) {
      const rows = db.prepare("SELECT migration_id, name, checksum FROM schema_migrations ORDER BY migration_id").all() as Array<{ migration_id: string; name: string; checksum: string }>;
      const known = new Map(DATABASE_MIGRATIONS.map((migration) => [migration.id, migration]));
      const unsupported = rows.find((row) => !known.has(row.migration_id));
      if (unsupported) throw new SchemaMigrationRequiredError(`Database contains unsupported migration ${unsupported.migration_id}.`);
      for (const row of rows) {
        const migration = known.get(row.migration_id) as Migration;
        if (row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
          throw new SchemaMigrationRequiredError(`Database migration checksum mismatch for ${row.migration_id}.`);
        }
      }
    } else if (initialTables.has("m0_meta")) {
      const row = db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (row?.value === WORKBENCH_V2_SCHEMA_VERSION) {
        const issues = schemaObjects(db);
        if (issues.length > 0) throw new SchemaMigrationRequiredError(`Existing v2-4 baseline validation failed: ${issues.join(", ")}.`);
      }
    }

    if (isCurrentUnledgeredDatabase(db)) {
      ensureLedger(db);
      for (const migration of DATABASE_MIGRATIONS) insertMigration(db, migration);
      appliedIds.push(...DATABASE_MIGRATIONS.map((migration) => migration.id));
      baselined = true;
    }

    for (const migration of DATABASE_MIGRATIONS) {
      const tables = tableNames(db);
      const existing = tables.has("schema_migrations")
        ? db.prepare("SELECT name, checksum FROM schema_migrations WHERE migration_id = ?").get(migration.id) as { name: string; checksum: string } | undefined
        : undefined;
      if (existing) continue;
      ensureLedger(db);
      migration.apply(db);
      insertMigration(db, migration);
      appliedIds.push(migration.id);
    }
    assertSchemaCurrent(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { applied: appliedIds, baselined };
}
