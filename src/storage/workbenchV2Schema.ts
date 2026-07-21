import type { M0Database } from "./sqlite.js";

export const WORKBENCH_V2_4_SCHEMA_VERSION = "workbench-v2-4";
export const WORKBENCH_V2_5_SCHEMA_VERSION = "workbench-v2-5";
export const WORKBENCH_V2_SCHEMA_VERSION = "workbench-v2-6";

// Frozen implementation for migration 0002. Future schema work must add a new migration.
export function applyWorkbenchV24Baseline(db: M0Database, options: { manage_transaction?: boolean } = {}): void {
  const manageTransaction = options.manage_transaction !== false;
  const current = db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (current && !["m0-a", "workbench-v2-1", "workbench-v2-2", "workbench-v2-3", WORKBENCH_V2_4_SCHEMA_VERSION].includes(current.value)) {
    throw new Error(`Unsupported schema version: ${current.value}`);
  }

  if (manageTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_project_meta (
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
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (classification IN ('unclassified', 'production', 'test')),
        CHECK (lifecycle IN ('active', 'archived')),
        CHECK (pinned IN (0, 1)),
        CHECK (next_action_priority IS NULL OR next_action_priority IN ('urgent', 'high', 'normal'))
      );

      CREATE TABLE IF NOT EXISTS import_index (
        relative_path TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS import_decisions (
        checksum TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        decision TEXT NOT NULL,
        target_project_id TEXT,
        artifact_id TEXT,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (decision IN ('quarantined', 'excluded', 'registered'))
      );

      CREATE TABLE IF NOT EXISTS regeneration_requests (
        request_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        shot_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        previous_run_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (status IN ('draft', 'prepared', 'submitted', 'cancelled'))
      );

      CREATE TABLE IF NOT EXISTS generation_intents (
        intent_id TEXT PRIMARY KEY,
        run_id TEXT,
        project_id TEXT NOT NULL,
        shot_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_label TEXT NOT NULL,
        model TEXT NOT NULL,
        input_artifact_id TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        resolution TEXT NOT NULL,
        estimated_cost_value REAL NOT NULL,
        budget_limit_value REAL NOT NULL,
        currency TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        provider_task_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        upload_attempts INTEGER NOT NULL DEFAULT 0,
        submit_attempts INTEGER NOT NULL DEFAULT 0,
        output_artifact_id TEXT NOT NULL DEFAULT '',
        sanitized_error_json TEXT NOT NULL DEFAULT '{}',
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (confirmed IN (0, 1)),
        CHECK (status IN ('prepared', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout')),
        CHECK (upload_attempts BETWEEN 0 AND 1),
        CHECK (submit_attempts BETWEEN 0 AND 1)
      );

      CREATE TABLE IF NOT EXISTS workbench_drafts (
        draft_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL,
        parent_draft_id TEXT,
        target_project_id TEXT,
        target_shot_id TEXT,
        promoted_object_type TEXT,
        promoted_object_id TEXT,
        revision_note TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('pending', 'revision_needed', 'promoted', 'closed'))
      );

      CREATE TABLE IF NOT EXISTS workbench_pending_actions (
        action_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL,
        project_id TEXT,
        data_json TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('pending', 'executed', 'rejected', 'failed'))
      );

      CREATE TABLE IF NOT EXISTS workbench_inbox_events (
        event_id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (object_type IN ('draft', 'pending_action'))
      );

      CREATE TABLE IF NOT EXISTS workbench_governance_runs (
        run_id TEXT PRIMARY KEY,
        snapshot_hash TEXT NOT NULL,
        rule_groups_json TEXT NOT NULL,
        affected_count INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS workbench_review_notes (
        note_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        shot_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL DEFAULT '',
        author_hash TEXT NOT NULL,
        note TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'webgpt_v4',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webgpt_audit_events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL DEFAULT '',
        request_hash TEXT NOT NULL DEFAULT '',
        actor_hash TEXT NOT NULL,
        tool TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        object_type TEXT NOT NULL DEFAULT '',
        object_id TEXT NOT NULL DEFAULT '',
        changed_fields_json TEXT NOT NULL DEFAULT '[]',
        before_hash TEXT NOT NULL DEFAULT '',
        after_hash TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL,
        error_code TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webgpt_media_grants (
        grant_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        actor_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webgpt_provider_price_cache (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        resolution TEXT NOT NULL,
        estimated_cost_value REAL NOT NULL,
        currency TEXT NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (provider, model, duration_seconds, resolution)
      );

      CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC, project_id DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_status_updated ON projects(json_extract(data_json, '$.status'), updated_at DESC, project_id DESC);
      CREATE INDEX IF NOT EXISTS idx_shots_project_order ON shots(project_id, json_extract(data_json, '$.order'), shot_id);
      CREATE INDEX IF NOT EXISTS idx_media_updated ON media_artifacts(updated_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS idx_media_project_updated ON media_artifacts(project_id, updated_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS idx_media_type_role_status ON media_artifacts(role, artifact_type, status, updated_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_updated ON generation_runs(updated_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_project_shot ON generation_runs(project_id, shot_id, updated_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_project_meta_lifecycle ON workbench_project_meta(lifecycle, pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_regeneration_project ON regeneration_requests(project_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generation_intents_active ON generation_intents(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_import_decisions_project ON import_decisions(target_project_id, decision, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workbench_drafts_status ON workbench_drafts(status, updated_at DESC, draft_id DESC);
      CREATE INDEX IF NOT EXISTS idx_workbench_pending_status ON workbench_pending_actions(status, updated_at DESC, action_id DESC);
      CREATE INDEX IF NOT EXISTS idx_workbench_inbox_events_object ON workbench_inbox_events(object_type, object_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workbench_review_notes_shot ON workbench_review_notes(project_id, shot_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_webgpt_audit_idempotency
        ON webgpt_audit_events(tool, idempotency_key) WHERE idempotency_key <> '';
      CREATE INDEX IF NOT EXISTS idx_webgpt_audit_project ON webgpt_audit_events(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_webgpt_media_grants_expiry ON webgpt_media_grants(expires_at, revoked_at);

      CREATE TRIGGER IF NOT EXISTS trg_workbench_project_meta_after_insert
      AFTER INSERT ON projects
      BEGIN
        INSERT OR IGNORE INTO workbench_project_meta (project_id) VALUES (NEW.project_id);
      END;

      INSERT OR IGNORE INTO workbench_project_meta (project_id)
      SELECT project_id FROM projects;
    `);

    ensureColumn(db, "workbench_project_meta", "next_action_override", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "workbench_project_meta", "next_action_priority", "TEXT");
    ensureColumn(db, "workbench_project_meta", "next_action_expires_at", "TEXT");
    ensureColumn(db, "workbench_project_meta", "next_action_project_status", "TEXT");
    ensureColumn(db, "workbench_project_meta", "next_action_updated_at", "TEXT");

    if (current?.value === "workbench-v2-3") {
      const rows = db.prepare("SELECT event_id, result_json FROM webgpt_audit_events WHERE result = 'succeeded'").all() as Array<{ event_id: string; result_json: string }>;
      const update = db.prepare("UPDATE webgpt_audit_events SET result_json = ? WHERE event_id = ?");
      for (const row of rows) {
        let meta: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.result_json) as { meta?: Record<string, unknown> };
          meta = parsed.meta ?? {};
        } catch {
          meta = {};
        }
        update.run(JSON.stringify({ ok: true, meta }), row.event_id);
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO m0_meta (key, value, updated_at)
      VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
    `).run(WORKBENCH_V2_4_SCHEMA_VERSION);
    if (manageTransaction) db.exec("COMMIT");
  } catch (error) {
    if (manageTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function initializeWorkbenchV2Schema(db: M0Database, options: { manage_transaction?: boolean } = {}): void {
  applyWorkbenchV24Baseline(db, options);
}

function ensureColumn(db: M0Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
