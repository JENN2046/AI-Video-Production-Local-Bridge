import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { M0Database } from "./sqlite.js";
import {
  applyWorkbenchV24Baseline,
  WORKBENCH_V2_4_SCHEMA_VERSION,
  WORKBENCH_V2_5_SCHEMA_VERSION,
  WORKBENCH_V2_SCHEMA_VERSION
} from "./workbenchV2Schema.js";

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

// Migration 0002 is the immutable v2-4 baseline. Future schema work must add a new migration.
const WORKBENCH_V2_4_CANONICAL = [
  WORKBENCH_V2_4_SCHEMA_VERSION,
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

const GENERATION_JOBS_SQL = `
  CREATE TABLE IF NOT EXISTS generation_jobs (
    job_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL UNIQUE REFERENCES generation_intents(intent_id),
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
  CREATE TABLE IF NOT EXISTS generation_job_events (
    event_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES generation_jobs(job_id),
    from_state TEXT NOT NULL DEFAULT '',
    to_state TEXT NOT NULL,
    reason_code TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_generation_jobs_due ON generation_jobs(state, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_generation_job_events_job ON generation_job_events(job_id, created_at);
  CREATE TRIGGER IF NOT EXISTS generation_job_events_no_update
    BEFORE UPDATE ON generation_job_events BEGIN
      SELECT RAISE(ABORT, 'GENERATION_JOB_EVENTS_APPEND_ONLY');
    END;
  CREATE TRIGGER IF NOT EXISTS generation_job_events_no_delete
    BEFORE DELETE ON generation_job_events BEGIN
      SELECT RAISE(ABORT, 'GENERATION_JOB_EVENTS_APPEND_ONLY');
    END;
  INSERT OR IGNORE INTO generation_jobs (job_id, intent_id, state, reconciliation_reason)
  SELECT 'job_' || intent_id, intent_id,
    CASE WHEN provider_task_id <> '' THEN 'polling' ELSE 'manual_reconciliation' END,
    CASE WHEN provider_task_id <> '' THEN '' ELSE 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN' END
  FROM generation_intents WHERE confirmed = 1 AND status IN ('queued', 'running');
`;

const GENERATION_JOBS_STABILIZATION_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_media_provider_task_unique
    ON media_artifacts(json_extract(data_json, '$.source.provider'), json_extract(data_json, '$.source.provider_job_id'))
    WHERE json_valid(data_json) = 1 AND json_extract(data_json, '$.source.provider_job_id') <> '';
  INSERT OR IGNORE INTO generation_job_events (event_id, job_id, from_state, to_state, reason_code, data_json)
  SELECT 'job_event_backfill_' || job_id, job_id, '', state,
    CASE WHEN state = 'manual_reconciliation' THEN 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN' ELSE 'MIGRATION_BACKFILL' END,
    '{"source":"migration_0004"}'
  FROM generation_jobs
  WHERE NOT EXISTS (SELECT 1 FROM generation_job_events events WHERE events.job_id = generation_jobs.job_id);
`;

const MEDIA_BLOBS_NO_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS media_blobs_no_update
    BEFORE UPDATE ON media_blobs BEGIN
      SELECT RAISE(ABORT, 'MEDIA_BLOB_IMMUTABLE');
    END;
`;

const ARTIFACT_BLOBS_SQL = `
  CREATE TABLE IF NOT EXISTS media_blobs (
    blob_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    detected_mime TEXT NOT NULL DEFAULT '',
    storage_uri TEXT NOT NULL DEFAULT '',
    integrity_state TEXT NOT NULL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (size_bytes >= 0),
    CHECK (integrity_state IN ('verified','unverified','missing','quarantined')),
    CHECK (json_valid(provenance_json) = 1),
    CHECK (integrity_state <> 'verified' OR (length(sha256) = 64 AND size_bytes > 0 AND detected_mime <> '' AND storage_uri <> ''))
  );
  CREATE TABLE IF NOT EXISTS media_artifact_blobs (
    artifact_id TEXT PRIMARY KEY REFERENCES media_artifacts(artifact_id) ON DELETE RESTRICT,
    blob_id TEXT NOT NULL REFERENCES media_blobs(blob_id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_media_blobs_verified_sha256
    ON media_blobs(sha256) WHERE integrity_state = 'verified';
  CREATE INDEX IF NOT EXISTS idx_media_artifact_blobs_blob ON media_artifact_blobs(blob_id, artifact_id);
  CREATE TRIGGER IF NOT EXISTS media_blobs_no_update
    BEFORE UPDATE ON media_blobs BEGIN
      SELECT RAISE(ABORT, 'MEDIA_BLOB_IMMUTABLE');
    END;
  CREATE TRIGGER IF NOT EXISTS media_blobs_no_delete
    BEFORE DELETE ON media_blobs BEGIN
      SELECT RAISE(ABORT, 'MEDIA_BLOB_IMMUTABLE');
    END;
  CREATE TRIGGER IF NOT EXISTS media_artifact_identity_immutable
    BEFORE UPDATE OF project_id, shot_id, role, artifact_type ON media_artifacts
    WHEN OLD.project_id IS NOT NEW.project_id
      OR OLD.shot_id IS NOT NEW.shot_id
      OR OLD.role IS NOT NEW.role
      OR OLD.artifact_type IS NOT NEW.artifact_type
    BEGIN
      SELECT RAISE(ABORT, 'MEDIA_ARTIFACT_IDENTITY_IMMUTABLE');
    END;
  CREATE TRIGGER IF NOT EXISTS media_artifact_status_transition
    BEFORE UPDATE OF status ON media_artifacts
    WHEN OLD.status IS NOT NEW.status AND NOT (
      (OLD.status = 'pending_upload' AND NEW.status IN ('active','inaccessible','archived'))
      OR (OLD.status = 'active' AND NEW.status IN ('inaccessible','expired','archived'))
      OR (OLD.status = 'inaccessible' AND NEW.status IN ('active','expired','archived'))
      OR (OLD.status = 'expired' AND NEW.status = 'archived')
    )
    BEGIN
      SELECT RAISE(ABORT, 'INVALID_ARTIFACT_STATUS_TRANSITION');
    END;
  CREATE TRIGGER IF NOT EXISTS media_artifact_blob_transition
    BEFORE UPDATE OF blob_id ON media_artifact_blobs
    WHEN OLD.blob_id IS NOT NEW.blob_id AND NOT (
      (SELECT integrity_state FROM media_blobs WHERE blob_id = OLD.blob_id) <> 'verified'
      AND (SELECT integrity_state FROM media_blobs WHERE blob_id = NEW.blob_id) = 'verified'
    )
    BEGIN
      SELECT RAISE(ABORT, 'MEDIA_ARTIFACT_BLOB_IMMUTABLE');
    END;
  CREATE TRIGGER IF NOT EXISTS media_artifact_blobs_no_delete
    BEFORE DELETE ON media_artifact_blobs BEGIN
      SELECT RAISE(ABORT, 'MEDIA_ARTIFACT_BLOB_IMMUTABLE');
    END;
`;

const MEDIA_ACTIVATION_JOURNAL_SQL = `
  CREATE TABLE IF NOT EXISTS media_activation_journal (
    activation_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    state TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    role TEXT NOT NULL,
    expected_sha256 TEXT NOT NULL,
    expected_size_bytes INTEGER NOT NULL,
    detected_mime TEXT NOT NULL,
    staging_path TEXT NOT NULL,
    pending_path TEXT NOT NULL,
    final_path TEXT NOT NULL,
    artifact_json TEXT NOT NULL,
    error_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (state IN ('staged','file_placed','committed','failed')),
    CHECK (artifact_type IN ('image','video')),
    CHECK (role IN ('storyboard_image','generated_clip','final_video')),
    CHECK (expected_size_bytes > 0),
    CHECK (length(expected_sha256) = 64),
    CHECK (json_valid(artifact_json) = 1)
  );
  CREATE INDEX IF NOT EXISTS idx_media_activation_journal_state
    ON media_activation_journal(state, updated_at, activation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_media_activation_journal_active_artifact
    ON media_activation_journal(artifact_id)
    WHERE state IN ('staged','file_placed');
`;

function applyMediaActivationMigration(db: M0Database): void {
  db.exec(MEDIA_ACTIVATION_JOURNAL_SQL);
  const rows = db.prepare(`SELECT a.artifact_id, a.data_json, m.blob_id, b.sha256, b.detected_mime, b.storage_uri, b.provenance_json
    FROM media_artifacts a
    JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id
    JOIN media_blobs b ON b.blob_id = m.blob_id
    WHERE a.status = 'active' AND b.integrity_state = 'verified'
    ORDER BY a.artifact_id`).all() as unknown as Array<{
      artifact_id: string; data_json: string; blob_id: string; sha256: string; detected_mime: string; storage_uri: string; provenance_json: string;
    }>;
  const update = db.prepare("UPDATE media_artifacts SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE artifact_id = ?");
  const updateBlobRoot = db.prepare("UPDATE media_blobs SET storage_uri = ?, provenance_json = ? WHERE blob_id = ?");
  db.exec("DROP TRIGGER IF EXISTS media_blobs_no_update");
  try {
    for (const row of rows) {
      let storageUri = row.storage_uri;
      let provenance = JSON.parse(row.provenance_json) as Record<string, unknown>;
      if (typeof provenance.media_root !== "string") {
        try {
          storageUri = resolve(realpathSync(resolve(row.storage_uri)));
          provenance = { ...provenance, media_root: dirname(storageUri) };
          updateBlobRoot.run(storageUri, JSON.stringify(provenance), row.blob_id);
        } catch {
          throw new SchemaMigrationRequiredError(`MEDIA_BLOB_PATH_RECONCILIATION_REQUIRED: ${row.blob_id} has no verifiable local root.`);
        }
      }
      const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
      const storage = { ...((artifact.storage ?? {}) as Record<string, unknown>) };
      const metadata = { ...((artifact.metadata ?? {}) as Record<string, unknown>) };
      const source = { ...((artifact.source ?? {}) as Record<string, unknown>) };
      storage.uri = storageUri;
      storage.mime_type = row.detected_mime;
      storage.filename = basename(storageUri);
      metadata.sha256 = row.sha256;
      source.sha256 = row.sha256;
      update.run(JSON.stringify({ ...artifact, blob_id: row.blob_id, storage, metadata, source }), row.artifact_id);
    }
  } finally {
    db.exec(MEDIA_BLOBS_NO_UPDATE_TRIGGER_SQL);
  }
}

interface Migration {
  id: string;
  name: string;
  canonical: string;
  apply: (db: M0Database) => void;
}

function assertNoDuplicateProviderTasks(db: M0Database): void {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT provider, provider_task_id FROM (
      SELECT
        json_extract(CASE WHEN json_valid(data_json) = 1 THEN data_json ELSE '{}' END, '$.source.provider') AS provider,
        json_extract(CASE WHEN json_valid(data_json) = 1 THEN data_json ELSE '{}' END, '$.source.provider_job_id') AS provider_task_id
      FROM media_artifacts
    ) WHERE provider_task_id IS NOT NULL AND provider_task_id <> ''
    GROUP BY provider, provider_task_id HAVING COUNT(*) > 1
  )`).get() as { count: number };
  if (Number(row.count) > 0) {
    throw new SchemaMigrationRequiredError(`PROVIDER_TASK_DUPLICATES_REQUIRE_RECONCILIATION: ${Number(row.count)} duplicate provider task group(s) must be reconciled before migration 0004.`);
  }
}

interface LegacyArtifactRow {
  artifact_id: string;
  project_id: string | null;
  shot_id: string | null;
  role: string;
  artifact_type: string;
  status: string;
  data_json: string;
}

function detectedMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return "";
}

function assertArtifactStructuredRows(rows: LegacyArtifactRow[]): void {
  for (const row of rows) {
    let artifact: Record<string, unknown>;
    try {
      artifact = JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      throw new SchemaMigrationRequiredError(`ARTIFACT_STRUCTURED_DRIFT: ${row.artifact_id} contains invalid JSON.`);
    }
    const links = (artifact.linked_objects ?? {}) as Record<string, unknown>;
    if (
      artifact.artifact_id !== row.artifact_id
      || links.project_id !== (row.project_id ?? "")
      || links.shot_id !== (row.shot_id ?? "")
      || artifact.role !== row.role
      || artifact.artifact_type !== row.artifact_type
      || artifact.status !== row.status
    ) {
      throw new SchemaMigrationRequiredError(`ARTIFACT_STRUCTURED_DRIFT: ${row.artifact_id} relational and JSON bindings differ.`);
    }
    const validRoleType = (row.role === "storyboard_image" && row.artifact_type === "image")
      || ((row.role === "generated_clip" || row.role === "final_video") && row.artifact_type === "video");
    if (!validRoleType) {
      throw new SchemaMigrationRequiredError(`ARTIFACT_ROLE_UNSUPPORTED: ${row.artifact_id} must be reconciled before migration 0005.`);
    }
  }
}

function applyArtifactBlobMigration(db: M0Database): void {
  const rows = db.prepare(`
    SELECT artifact_id, project_id, shot_id, role, artifact_type, status, data_json
    FROM media_artifacts ORDER BY artifact_id
  `).all() as unknown as LegacyArtifactRow[];
  assertArtifactStructuredRows(rows);
  db.exec(ARTIFACT_BLOBS_SQL);

  const findVerified = db.prepare("SELECT blob_id FROM media_blobs WHERE sha256 = ? AND integrity_state = 'verified'");
  const insertBlob = db.prepare(`
    INSERT INTO media_blobs (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const mapArtifact = db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)");
  const updateArtifact = db.prepare("UPDATE media_artifacts SET status = ?, data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE artifact_id = ?");

  for (const row of rows) {
    const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
    const storage = (artifact.storage ?? {}) as Record<string, unknown>;
    const uri = typeof storage.uri === "string" ? storage.uri : "";
    let sha256 = "";
    let sizeBytes = 0;
    let mime = "";
    let integrityState: "verified" | "unverified" | "missing" = "unverified";
    if (uri && !/^https?:\/\//i.test(uri)) {
      const localPath = resolve(uri);
      if (existsSync(localPath) && !lstatSync(localPath).isSymbolicLink() && statSync(localPath).isFile()) {
        const bytes = readFileSync(localPath);
        mime = detectedMime(bytes);
        const typeMatches = row.artifact_type === "image" ? mime.startsWith("image/") : row.artifact_type === "video" ? mime === "video/mp4" : false;
        if (bytes.length > 0 && typeMatches) {
          sha256 = createHash("sha256").update(bytes).digest("hex");
          sizeBytes = bytes.length;
          integrityState = "verified";
        }
      } else if (!existsSync(localPath)) {
        integrityState = "missing";
      }
    }

    let blobId = "";
    if (integrityState === "verified") {
      const existing = findVerified.get(sha256) as { blob_id: string } | undefined;
      blobId = existing?.blob_id ?? `blob_sha256_${sha256}`;
      if (!existing) insertBlob.run(blobId, sha256, sizeBytes, mime, resolve(uri), integrityState, JSON.stringify({ source: "migration_0005", immutable: true }));
    } else {
      blobId = `blob_unverified_${createHash("sha256").update(row.artifact_id).digest("hex")}`;
      insertBlob.run(blobId, "", 0, "", uri, integrityState, JSON.stringify({ source: "migration_0005", immutable: true, reason: integrityState === "missing" ? "LOCAL_FILE_MISSING" : "CONTENT_NOT_LOCALLY_VERIFIABLE" }));
    }
    mapArtifact.run(row.artifact_id, blobId);

    const nextStatus = row.status === "active" && integrityState !== "verified" ? "inaccessible" : row.status;
    const nextArtifact = { ...artifact, blob_id: blobId, status: nextStatus };
    updateArtifact.run(nextStatus, JSON.stringify(nextArtifact), row.artifact_id);
  }
  db.prepare("UPDATE m0_meta SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'schema_version'").run(WORKBENCH_V2_5_SCHEMA_VERSION);
}

export const WEBGPT_AUTHORIZATION_WORKSPACE_ID = "jenn-ai-video-workspace";

const WEBGPT_MULTI_USER_AUTHORIZATION_SQL = `
  CREATE TABLE webgpt_auth_principals (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, principal_id),
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (length(principal_id) = 64 AND principal_id NOT GLOB '*[^0-9a-f]*'),
    CHECK (status IN ('active','disabled'))
  );
  CREATE TABLE webgpt_project_memberships (
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, project_id, principal_id),
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES webgpt_auth_principals(workspace_id, principal_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (role IN ('owner','viewer')),
    CHECK (status IN ('active','revoked'))
  );
  CREATE TABLE webgpt_auth_events (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    project_id TEXT,
    event_type TEXT NOT NULL,
    role TEXT,
    reason_code TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES webgpt_auth_principals(workspace_id, principal_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (length(principal_id) = 64 AND principal_id NOT GLOB '*[^0-9a-f]*'),
    CHECK (event_type IN ('principal_registered','membership_granted','membership_revoked')),
    CHECK (role IS NULL OR role IN ('owner','viewer')),
    CHECK (length(reason_code) BETWEEN 1 AND 64)
  );
  CREATE INDEX idx_webgpt_memberships_principal
    ON webgpt_project_memberships(workspace_id, principal_id, status, project_id);
  CREATE INDEX idx_webgpt_auth_events_principal
    ON webgpt_auth_events(workspace_id, principal_id, created_at);
  CREATE TRIGGER webgpt_auth_events_no_update
    BEFORE UPDATE ON webgpt_auth_events BEGIN
      SELECT RAISE(ABORT, 'WEBGPT_AUTH_EVENTS_APPEND_ONLY');
    END;
  CREATE TRIGGER webgpt_auth_events_no_delete
    BEFORE DELETE ON webgpt_auth_events BEGIN
      SELECT RAISE(ABORT, 'WEBGPT_AUTH_EVENTS_APPEND_ONLY');
    END;
`;

const WEBGPT_ISSUER_BINDINGS_SQL = `
  CREATE TABLE webgpt_auth_principal_bindings (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    issuer_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, principal_id),
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES webgpt_auth_principals(workspace_id, principal_id) ON DELETE RESTRICT,
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (length(principal_id) = 64 AND principal_id NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(issuer_hash) = 64 AND issuer_hash NOT GLOB '*[^0-9a-f]*')
  );
  CREATE INDEX idx_webgpt_auth_bindings_issuer
    ON webgpt_auth_principal_bindings(workspace_id, issuer_hash, principal_id);
  CREATE TRIGGER webgpt_auth_principal_bindings_no_update
    BEFORE UPDATE ON webgpt_auth_principal_bindings BEGIN
      SELECT RAISE(ABORT, 'WEBGPT_AUTH_PRINCIPAL_BINDINGS_IMMUTABLE');
    END;
  CREATE TRIGGER webgpt_auth_principal_bindings_no_delete
    BEFORE DELETE ON webgpt_auth_principal_bindings BEGIN
      SELECT RAISE(ABORT, 'WEBGPT_AUTH_PRINCIPAL_BINDINGS_IMMUTABLE');
    END;
`;

const DIRECTOR_DOMAIN_SQL = `
  CREATE TABLE director_focuses (
    focus_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    supersedes_focus_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES webgpt_auth_principals(workspace_id, principal_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
    UNIQUE (workspace_id, principal_id, generation),
    UNIQUE (focus_id, workspace_id, principal_id, project_id),
    UNIQUE (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation),
    FOREIGN KEY (supersedes_focus_id, workspace_id, principal_id, project_id)
      REFERENCES director_focuses(focus_id, workspace_id, principal_id, project_id) ON DELETE RESTRICT,
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (length(principal_id) = 64 AND principal_id NOT GLOB '*[^0-9a-f]*'),
    CHECK (target_type IN ('project','shot','artifact','storyboard_package','generation_run','delivery','memory')),
    CHECK (generation > 0),
    CHECK (expires_at > created_at)
  );
  CREATE TABLE director_focus_events (
    event_id TEXT PRIMARY KEY,
    focus_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (focus_id) REFERENCES director_focuses(focus_id) ON DELETE RESTRICT,
    CHECK (event_type IN ('created','revoked','superseded')),
    CHECK (length(reason_code) BETWEEN 1 AND 64)
  );
  CREATE TABLE director_proposals (
    proposal_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    focus_id TEXT NOT NULL,
    focus_generation INTEGER NOT NULL,
    schema_version TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_state_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    parent_proposal_id TEXT,
    idempotency_key TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES webgpt_auth_principals(workspace_id, principal_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
    FOREIGN KEY (focus_id, workspace_id, principal_id, project_id, target_type, target_id, focus_generation)
      REFERENCES director_focuses(focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation) ON DELETE RESTRICT,
    FOREIGN KEY (parent_proposal_id, workspace_id, principal_id, project_id)
      REFERENCES director_proposals(proposal_id, workspace_id, principal_id, project_id) ON DELETE RESTRICT,
    UNIQUE (workspace_id, principal_id, idempotency_key),
    UNIQUE (proposal_id, project_id),
    UNIQUE (proposal_id, workspace_id, principal_id, project_id),
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (length(principal_id) = 64 AND principal_id NOT GLOB '*[^0-9a-f]*'),
    CHECK (target_type IN ('project','shot','artifact','storyboard_package','generation_run','delivery','memory')),
    CHECK (focus_generation > 0),
    CHECK (schema_version = 'director-domain-v1'),
    CHECK (kind IN ('creative_brief','script','shot_plan','storyboard_revision','generation_plan','clip_regeneration','review_assessment','assembly_plan','delivery_plan','memory_saveback')),
    CHECK (length(base_state_hash) = 64 AND base_state_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (json_valid(payload_json) = 1),
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(idempotency_key) BETWEEN 16 AND 160),
    CHECK (source IN ('native','untrusted_manual_import'))
  );
  CREATE TABLE director_proposal_events (
    event_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    receipt_type TEXT NOT NULL DEFAULT '',
    receipt_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES director_proposals(proposal_id) ON DELETE RESTRICT,
    CHECK (event_type IN ('submitted','imported','withdrawn','accepted','rejected','compiled')),
    CHECK (length(reason_code) BETWEEN 1 AND 64)
  );
  CREATE TABLE director_automation_grants (
    grant_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    allowed_actions_json TEXT NOT NULL,
    currency TEXT NOT NULL,
    max_total_minor INTEGER NOT NULL,
    max_per_run_minor INTEGER NOT NULL,
    max_versions_per_shot INTEGER NOT NULL,
    max_automatic_retries INTEGER NOT NULL,
    pricing_contract_version TEXT NOT NULL,
    capability_contract_version TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES webgpt_auth_principals(workspace_id, principal_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (length(principal_id) = 64 AND principal_id NOT GLOB '*[^0-9a-f]*'),
    CHECK (provider = 'runninghub'),
    CHECK (json_valid(allowed_actions_json) = 1),
    CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
    CHECK (max_total_minor > 0),
    CHECK (max_per_run_minor > 0 AND max_per_run_minor <= max_total_minor),
    CHECK (max_versions_per_shot BETWEEN 1 AND 20),
    CHECK (max_automatic_retries BETWEEN 0 AND 5),
    CHECK (expires_at > starts_at),
    CHECK (length(policy_hash) = 64 AND policy_hash NOT GLOB '*[^0-9a-f]*')
  );
  CREATE TABLE director_automation_grant_events (
    event_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    reservation_id TEXT NOT NULL DEFAULT '',
    amount_minor INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    intent_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    reason_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (grant_id) REFERENCES director_automation_grants(grant_id) ON DELETE RESTRICT,
    CHECK (event_type IN ('reserve','release','consume','revoke','expire')),
    CHECK (amount_minor >= 0),
    CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
    CHECK (length(reason_code) BETWEEN 1 AND 64)
  );
  CREATE TABLE storyboard_package_versions (
    package_version_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    supersedes_package_version_id TEXT,
    schema_version TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_from_proposal_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
    FOREIGN KEY (supersedes_package_version_id, project_id)
      REFERENCES storyboard_package_versions(package_version_id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_from_proposal_id, project_id)
      REFERENCES director_proposals(proposal_id, project_id) ON DELETE RESTRICT,
    UNIQUE (project_id, version),
    UNIQUE (package_version_id, project_id),
    CHECK (version > 0),
    CHECK (schema_version = 'storyboard-package-v2'),
    CHECK (json_valid(payload_json) = 1),
    CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
  );
  CREATE TABLE storyboard_package_version_events (
    event_id TEXT PRIMARY KEY,
    package_version_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (package_version_id) REFERENCES storyboard_package_versions(package_version_id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES webgpt_auth_principals(workspace_id, principal_id) ON DELETE RESTRICT,
    CHECK (workspace_id = 'jenn-ai-video-workspace'),
    CHECK (length(principal_id) = 64 AND principal_id NOT GLOB '*[^0-9a-f]*'),
    CHECK (event_type IN ('created','frozen','superseded')),
    CHECK (length(reason_code) BETWEEN 1 AND 64)
  );

  CREATE INDEX idx_director_focus_principal_generation
    ON director_focuses(workspace_id, principal_id, generation DESC);
  CREATE INDEX idx_director_focus_project_expiry
    ON director_focuses(project_id, expires_at);
  CREATE INDEX idx_director_focus_events_focus
    ON director_focus_events(focus_id, created_at);
  CREATE INDEX idx_director_proposals_project
    ON director_proposals(project_id, created_at DESC, proposal_id DESC);
  CREATE INDEX idx_director_proposal_events_proposal
    ON director_proposal_events(proposal_id, created_at);
  CREATE INDEX idx_director_grants_project_expiry
    ON director_automation_grants(project_id, expires_at);
  CREATE INDEX idx_director_grant_events_grant
    ON director_automation_grant_events(grant_id, created_at);
  CREATE INDEX idx_storyboard_package_versions_project
    ON storyboard_package_versions(project_id, version DESC);
  CREATE INDEX idx_storyboard_package_version_events_package
    ON storyboard_package_version_events(package_version_id, created_at);

  CREATE TRIGGER director_focuses_no_update BEFORE UPDATE ON director_focuses BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_FOCUS_IMMUTABLE');
  END;
  CREATE TRIGGER director_focuses_no_delete BEFORE DELETE ON director_focuses BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_FOCUS_IMMUTABLE');
  END;
  CREATE TRIGGER director_focus_events_no_update BEFORE UPDATE ON director_focus_events BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_FOCUS_EVENTS_APPEND_ONLY');
  END;
  CREATE TRIGGER director_focus_events_no_delete BEFORE DELETE ON director_focus_events BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_FOCUS_EVENTS_APPEND_ONLY');
  END;
  CREATE TRIGGER director_proposals_no_update BEFORE UPDATE ON director_proposals BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_PROPOSAL_IMMUTABLE');
  END;
  CREATE TRIGGER director_proposals_no_delete BEFORE DELETE ON director_proposals BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_PROPOSAL_IMMUTABLE');
  END;
  CREATE TRIGGER director_proposal_events_no_update BEFORE UPDATE ON director_proposal_events BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_PROPOSAL_EVENTS_APPEND_ONLY');
  END;
  CREATE TRIGGER director_proposal_events_no_delete BEFORE DELETE ON director_proposal_events BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_PROPOSAL_EVENTS_APPEND_ONLY');
  END;
  CREATE TRIGGER director_automation_grants_no_update BEFORE UPDATE ON director_automation_grants BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_AUTOMATION_GRANT_IMMUTABLE');
  END;
  CREATE TRIGGER director_automation_grants_validate_actions BEFORE INSERT ON director_automation_grants
  WHEN json_type(NEW.allowed_actions_json) <> 'array'
    OR json_array_length(NEW.allowed_actions_json) NOT BETWEEN 1 AND 4
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.allowed_actions_json)
      WHERE type <> 'text' OR value NOT IN ('generation.submit','generation.retry','generation.download','artifact.activate')
    )
    OR (SELECT COUNT(*) FROM json_each(NEW.allowed_actions_json))
      <> (SELECT COUNT(DISTINCT value) FROM json_each(NEW.allowed_actions_json))
  BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_AUTOMATION_GRANT_ACTIONS_INVALID');
  END;
  CREATE TRIGGER director_automation_grants_no_delete BEFORE DELETE ON director_automation_grants BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_AUTOMATION_GRANT_IMMUTABLE');
  END;
  CREATE TRIGGER director_automation_grant_events_no_update BEFORE UPDATE ON director_automation_grant_events BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_AUTOMATION_GRANT_EVENTS_APPEND_ONLY');
  END;
  CREATE TRIGGER director_automation_grant_events_no_delete BEFORE DELETE ON director_automation_grant_events BEGIN
    SELECT RAISE(ABORT, 'DIRECTOR_AUTOMATION_GRANT_EVENTS_APPEND_ONLY');
  END;
  CREATE TRIGGER storyboard_package_versions_no_update BEFORE UPDATE ON storyboard_package_versions BEGIN
    SELECT RAISE(ABORT, 'STORYBOARD_PACKAGE_V2_IMMUTABLE');
  END;
  CREATE TRIGGER storyboard_package_versions_no_delete BEFORE DELETE ON storyboard_package_versions BEGIN
    SELECT RAISE(ABORT, 'STORYBOARD_PACKAGE_V2_IMMUTABLE');
  END;
  CREATE TRIGGER storyboard_package_version_events_no_update BEFORE UPDATE ON storyboard_package_version_events BEGIN
    SELECT RAISE(ABORT, 'STORYBOARD_PACKAGE_V2_EVENTS_APPEND_ONLY');
  END;
  CREATE TRIGGER storyboard_package_version_events_no_delete BEFORE DELETE ON storyboard_package_version_events BEGIN
    SELECT RAISE(ABORT, 'STORYBOARD_PACKAGE_V2_EVENTS_APPEND_ONLY');
  END;

  UPDATE m0_meta SET value = 'workbench-v2-6', updated_at = CURRENT_TIMESTAMP WHERE key = 'schema_version';
`;

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
  },
  {
    id: "0003",
    name: "persistent_generation_jobs",
    canonical: GENERATION_JOBS_SQL,
    apply: (db) => db.exec(GENERATION_JOBS_SQL)
  },
  {
    id: "0004",
    name: "generation_jobs_stabilization",
    canonical: `${GENERATION_JOBS_STABILIZATION_SQL}\nPRECONDITION provider_task_duplicates_require_reconciliation_v1`,
    apply: (db) => {
      assertNoDuplicateProviderTasks(db);
      db.exec(GENERATION_JOBS_STABILIZATION_SQL);
    }
  },
  {
    id: "0005",
    name: "immutable_media_blobs",
    canonical: `${ARTIFACT_BLOBS_SQL}\nBACKFILL verified_local_bytes_v1\nPRECONDITION artifact_structured_drift_v1\nSCHEMA ${WORKBENCH_V2_5_SCHEMA_VERSION}`,
    apply: applyArtifactBlobMigration
  },
  {
    id: "0006",
    name: "media_activation_journal",
    canonical: `${MEDIA_ACTIVATION_JOURNAL_SQL}\nBACKFILL active_artifact_blob_facts_and_roots_v2\nRECOVERY deterministic_file_activation_v1\nSCHEMA ${WORKBENCH_V2_5_SCHEMA_VERSION}`,
    apply: applyMediaActivationMigration
  },
  {
    id: "0007",
    name: "webgpt_multi_user_authorization",
    canonical: WEBGPT_MULTI_USER_AUTHORIZATION_SQL,
    apply: (db) => db.exec(WEBGPT_MULTI_USER_AUTHORIZATION_SQL)
  },
  {
    id: "0008",
    name: "webgpt_issuer_bound_principals",
    canonical: WEBGPT_ISSUER_BINDINGS_SQL,
    apply: (db) => db.exec(WEBGPT_ISSUER_BINDINGS_SQL)
  },
  {
    id: "0009",
    name: "chatgpt_director_domain",
    canonical: DIRECTOR_DOMAIN_SQL,
    apply: (db) => db.exec(DIRECTOR_DOMAIN_SQL)
  }
];

export function migrationChecksum(migration: Pick<Migration, "id" | "name" | "canonical">): string {
  const normalized = `${migration.id}\n${migration.name}\n${migration.canonical.replace(/\r\n/g, "\n").trim()}\n`;
  return createHash("sha256").update(normalized).digest("hex");
}

const INTERIM_MIGRATION_0005_CHECKSUM = "6e929ae3b8db4387891d664cd22dc5299dab689eab0d6c1dd07dc70afbabbe73";

function acceptsMigrationChecksum(migration: Migration, checksum: string): boolean {
  return checksum === migrationChecksum(migration)
    || (migration.id === "0005" && checksum === INTERIM_MIGRATION_0005_CHECKSUM);
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
  checks: Map<string, string[]>;
  uniqueConstraints: Map<string, string[]>;
  foreignKeys: Map<string, string[]>;
}

const expectedDefinitionCache = new Map<boolean, ExpectedSchemaDefinitions>();

function normalizeDefinition(value: unknown): string {
  const source = String(value ?? "").trim();
  let normalized = "";
  let inStringLiteral = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'") {
      normalized += character;
      if (inStringLiteral && source[index + 1] === "'") {
        normalized += source[index + 1];
        index += 1;
      } else {
        inStringLiteral = !inStringLiteral;
      }
      continue;
    }
    if (inStringLiteral) {
      normalized += character;
      continue;
    }
    const optionalClause = source.slice(index).match(/^if\s+not\s+exists\b/i);
    if (optionalClause && (index === 0 || !/[A-Za-z0-9_]/.test(source[index - 1]))) {
      index += optionalClause[0].length - 1;
      continue;
    }
    if (/\s/.test(character) || /["`\[\]]/.test(character)) continue;
    normalized += character.toLowerCase();
  }
  return normalized;
}

function columnSignature(column: ColumnDefinition): string {
  return [normalizeDefinition(column.type), Number(column.notnull), normalizeDefinition(column.dflt_value), Number(column.pk)].join("|");
}

function checkConstraints(sql: unknown): string[] {
  const normalized = normalizeDefinition(sql);
  const checks: string[] = [];
  let cursor = 0;
  while ((cursor = normalized.indexOf("check(", cursor)) >= 0) {
    const start = cursor + "check(".length;
    let depth = 1;
    let end = start;
    while (end < normalized.length && depth > 0) {
      if (normalized[end] === "(") depth += 1;
      else if (normalized[end] === ")") depth -= 1;
      end += 1;
    }
    if (depth !== 0) break;
    checks.push(normalized.slice(start, end - 1));
    cursor = end;
  }
  return checks.sort();
}

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function uniqueConstraintSignatures(db: M0Database, table: string): string[] {
  const indexes = db.prepare(`PRAGMA index_list(${quotedIdentifier(table)})`).all() as unknown as Array<{ name: string; unique: number; origin: string }>;
  return indexes
    .filter((index) => Number(index.unique) === 1 && index.origin === "u")
    .map((index) => {
      const columns = db.prepare(`PRAGMA index_info(${quotedIdentifier(index.name)})`).all() as unknown as Array<{ seqno: number; name: string | null }>;
      return columns
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => normalizeDefinition(column.name))
        .join(",");
    })
    .sort();
}

function foreignKeySignatures(db: M0Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${quotedIdentifier(table)})`).all() as unknown as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }>;
  const groups = new Map<number, typeof rows>();
  for (const row of rows) groups.set(Number(row.id), [...(groups.get(Number(row.id)) ?? []), row]);
  return [...groups.values()]
    .map((group) => group
      .sort((left, right) => Number(left.seq) - Number(right.seq))
      .map((row) => [row.table, row.from, row.to, row.on_update, row.on_delete, row.match].map(normalizeDefinition).join("|"))
      .join("&"))
    .sort();
}

function expectedSchemaDefinitions(includeJobs: boolean, expectedColumns: Record<string, readonly string[]>, expectedObjects: readonly string[]): ExpectedSchemaDefinitions {
  const cached = expectedDefinitionCache.get(includeJobs);
  if (cached) return cached;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(M0_BASE_SCHEMA_SQL);
    applyWorkbenchV24Baseline(reference);
    if (includeJobs) {
      reference.exec(`${GENERATION_JOBS_SQL}\n${GENERATION_JOBS_STABILIZATION_SQL}`);
      applyArtifactBlobMigration(reference);
      reference.exec(MEDIA_ACTIVATION_JOURNAL_SQL);
      reference.exec(WEBGPT_MULTI_USER_AUTHORIZATION_SQL);
      reference.exec(WEBGPT_ISSUER_BINDINGS_SQL);
      reference.exec(DIRECTOR_DOMAIN_SQL);
    }
    const columns = new Map<string, Map<string, string>>();
    const checks = new Map<string, string[]>();
    const uniqueConstraints = new Map<string, string[]>();
    const foreignKeys = new Map<string, string[]>();
    for (const table of Object.keys(expectedColumns)) {
      const tableColumns = reference.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnDefinition[];
      columns.set(table, new Map(tableColumns.map((column) => [column.name, columnSignature(column)])));
      const row = reference.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null } | undefined;
      checks.set(table, checkConstraints(row?.sql));
      uniqueConstraints.set(table, uniqueConstraintSignatures(reference, table));
      foreignKeys.set(table, foreignKeySignatures(reference, table));
    }
    const objects = new Map<string, string>();
    for (const name of expectedObjects) {
      const row = reference.prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('index', 'trigger')").get(name) as { sql: string | null } | undefined;
      objects.set(name, normalizeDefinition(row?.sql));
    }
    const definitions = { columns, objects, checks, uniqueConstraints, foreignKeys };
    expectedDefinitionCache.set(includeJobs, definitions);
    return definitions;
  } finally {
    reference.close();
  }
}

function schemaObjects(db: M0Database, includeJobs: boolean): string[] {
  const issues: string[] = [];
  const expectedColumns: Record<string, readonly string[]> = includeJobs ? {
    ...V24_EXPECTED_COLUMNS,
    generation_jobs: ["job_id", "intent_id", "state", "lease_owner", "lease_token", "lease_expires_at", "next_attempt_at", "attempt_count", "reconciliation_reason", "created_at", "updated_at"],
    generation_job_events: ["event_id", "job_id", "from_state", "to_state", "reason_code", "data_json", "created_at"],
    media_blobs: ["blob_id", "sha256", "size_bytes", "detected_mime", "storage_uri", "integrity_state", "provenance_json", "created_at"],
    media_artifact_blobs: ["artifact_id", "blob_id", "created_at"],
    media_activation_journal: ["activation_id", "artifact_id", "state", "artifact_type", "role", "expected_sha256", "expected_size_bytes", "detected_mime", "staging_path", "pending_path", "final_path", "artifact_json", "error_code", "created_at", "updated_at"],
    webgpt_auth_principals: ["workspace_id", "principal_id", "status", "created_at", "updated_at"],
    webgpt_auth_principal_bindings: ["workspace_id", "principal_id", "issuer_hash", "created_at"],
    webgpt_project_memberships: ["workspace_id", "project_id", "principal_id", "role", "status", "created_at", "updated_at"],
    webgpt_auth_events: ["event_id", "workspace_id", "principal_id", "project_id", "event_type", "role", "reason_code", "created_at"],
    director_focuses: ["focus_id", "workspace_id", "principal_id", "project_id", "target_type", "target_id", "generation", "supersedes_focus_id", "created_at", "expires_at"],
    director_focus_events: ["event_id", "focus_id", "event_type", "reason_code", "created_at"],
    director_proposals: ["proposal_id", "workspace_id", "principal_id", "project_id", "target_type", "target_id", "focus_id", "focus_generation", "schema_version", "kind", "base_state_hash", "payload_json", "payload_hash", "parent_proposal_id", "idempotency_key", "source", "created_at"],
    director_proposal_events: ["event_id", "proposal_id", "event_type", "reason_code", "receipt_type", "receipt_id", "created_at"],
    director_automation_grants: ["grant_id", "workspace_id", "principal_id", "project_id", "provider", "allowed_actions_json", "currency", "max_total_minor", "max_per_run_minor", "max_versions_per_shot", "max_automatic_retries", "pricing_contract_version", "capability_contract_version", "starts_at", "expires_at", "policy_hash", "created_at"],
    director_automation_grant_events: ["event_id", "grant_id", "event_type", "reservation_id", "amount_minor", "currency", "intent_id", "run_id", "reason_code", "created_at"],
    storyboard_package_versions: ["package_version_id", "project_id", "version", "supersedes_package_version_id", "schema_version", "payload_json", "content_hash", "created_from_proposal_id", "created_at"],
    storyboard_package_version_events: ["event_id", "package_version_id", "workspace_id", "principal_id", "event_type", "reason_code", "created_at"]
  } : V24_EXPECTED_COLUMNS;
  const expectedIndexes = includeJobs ? [
    ...V24_EXPECTED_INDEXES,
    "idx_generation_jobs_due",
    "idx_generation_job_events_job",
    "idx_media_provider_task_unique",
    "idx_media_blobs_verified_sha256",
    "idx_media_artifact_blobs_blob",
    "idx_media_activation_journal_state",
    "idx_media_activation_journal_active_artifact",
    "idx_webgpt_memberships_principal",
    "idx_webgpt_auth_bindings_issuer",
    "idx_webgpt_auth_events_principal",
    "idx_director_focus_principal_generation",
    "idx_director_focus_project_expiry",
    "idx_director_focus_events_focus",
    "idx_director_proposals_project",
    "idx_director_proposal_events_proposal",
    "idx_director_grants_project_expiry",
    "idx_director_grant_events_grant",
    "idx_storyboard_package_versions_project",
    "idx_storyboard_package_version_events_package"
  ] : [...V24_EXPECTED_INDEXES];
  const expectedTriggers = includeJobs
    ? [
        "trg_workbench_project_meta_after_insert",
        "generation_job_events_no_update",
        "generation_job_events_no_delete",
        "media_blobs_no_update",
        "media_blobs_no_delete",
        "media_artifact_identity_immutable",
        "media_artifact_status_transition",
        "media_artifact_blob_transition",
        "media_artifact_blobs_no_delete",
        "webgpt_auth_events_no_update",
        "webgpt_auth_events_no_delete",
        "webgpt_auth_principal_bindings_no_update",
        "webgpt_auth_principal_bindings_no_delete",
        "director_focuses_no_update",
        "director_focuses_no_delete",
        "director_focus_events_no_update",
        "director_focus_events_no_delete",
        "director_proposals_no_update",
        "director_proposals_no_delete",
        "director_proposal_events_no_update",
        "director_proposal_events_no_delete",
        "director_automation_grants_validate_actions",
        "director_automation_grants_no_update",
        "director_automation_grants_no_delete",
        "director_automation_grant_events_no_update",
        "director_automation_grant_events_no_delete",
        "storyboard_package_versions_no_update",
        "storyboard_package_versions_no_delete",
        "storyboard_package_version_events_no_update",
        "storyboard_package_version_events_no_delete"
      ]
    : ["trg_workbench_project_meta_after_insert"];
  const definitions = expectedSchemaDefinitions(includeJobs, expectedColumns, [...expectedIndexes, ...expectedTriggers]);
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnDefinition[];
    const columns = new Map(rows.map((row) => [row.name, row]));
    if (columns.size === 0) issues.push(`missing_table:${table}`);
    else for (const column of expected) {
      const actual = columns.get(column);
      if (!actual) issues.push(`missing_column:${table}.${column}`);
      else if (columnSignature(actual) !== definitions.columns.get(table)?.get(column)) issues.push(`column_definition:${table}.${column}`);
    }
    if (columns.size > 0) {
      const tableRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null } | undefined;
      if (JSON.stringify(checkConstraints(tableRow?.sql)) !== JSON.stringify(definitions.checks.get(table) ?? [])) issues.push(`check_constraints:${table}`);
      if (JSON.stringify(uniqueConstraintSignatures(db, table)) !== JSON.stringify(definitions.uniqueConstraints.get(table) ?? [])) issues.push(`unique_constraints:${table}`);
      if (JSON.stringify(foreignKeySignatures(db, table)) !== JSON.stringify(definitions.foreignKeys.get(table) ?? [])) issues.push(`foreign_keys:${table}`);
    }
  }
  for (const [kind, names] of [["index", expectedIndexes], ["trigger", expectedTriggers]] as const) {
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
  return row?.value === WORKBENCH_V2_4_SCHEMA_VERSION && schemaObjects(db, false).length === 0;
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
  const schemaVersion = db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (schemaVersion?.value !== WORKBENCH_V2_SCHEMA_VERSION) {
    throw new SchemaMigrationRequiredError(`Database schema version is ${schemaVersion?.value ?? "missing"}; expected ${WORKBENCH_V2_SCHEMA_VERSION}.`);
  }
  const applied = db.prepare("SELECT migration_id, name, checksum FROM schema_migrations ORDER BY migration_id").all() as Array<{ migration_id: string; name: string; checksum: string }>;
  const knownIds = new Set(DATABASE_MIGRATIONS.map((migration) => migration.id));
  const futureRows = applied.filter((row) => !knownIds.has(row.migration_id));
  if (futureRows.length > 0) {
    throw new SchemaMigrationRequiredError(`Database contains unsupported migration ${futureRows[0].migration_id}.`);
  }
  for (const migration of DATABASE_MIGRATIONS) {
    const row = applied.find((candidate) => candidate.migration_id === migration.id);
    if (!row) throw new SchemaMigrationRequiredError(`Missing database migration ${migration.id}.`);
    if (row.name !== migration.name || !acceptsMigrationChecksum(migration, row.checksum)) {
      throw new SchemaMigrationRequiredError(`Database migration checksum mismatch for ${migration.id}.`);
    }
  }
  const issues = schemaObjects(db, true);
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
        if (row.name !== migration.name || !acceptsMigrationChecksum(migration, row.checksum)) {
          throw new SchemaMigrationRequiredError(`Database migration checksum mismatch for ${row.migration_id}.`);
        }
      }
    } else if (initialTables.has("m0_meta")) {
      const row = db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (row?.value === WORKBENCH_V2_4_SCHEMA_VERSION) {
        const issues = schemaObjects(db, false);
        if (issues.length > 0) throw new SchemaMigrationRequiredError(`Existing v2-4 baseline validation failed: ${issues.join(", ")}.`);
      }
    }
    if (isCurrentUnledgeredDatabase(db)) {
      ensureLedger(db);
      for (const migration of DATABASE_MIGRATIONS.slice(0, 2)) insertMigration(db, migration);
      appliedIds.push(...DATABASE_MIGRATIONS.slice(0, 2).map((migration) => migration.id));
      baselined = true;
    }

    for (const migration of DATABASE_MIGRATIONS) {
      const tables = tableNames(db);
      const existing = tables.has("schema_migrations")
        ? db.prepare("SELECT name, checksum FROM schema_migrations WHERE migration_id = ?").get(migration.id) as { name: string; checksum: string } | undefined
        : undefined;
      if (existing) {
        if (existing.name !== migration.name || !acceptsMigrationChecksum(migration, existing.checksum)) {
          throw new SchemaMigrationRequiredError(`Database migration checksum mismatch for ${migration.id}.`);
        }
        const canonicalChecksum = migrationChecksum(migration);
        if (existing.checksum !== canonicalChecksum) {
          db.prepare("UPDATE schema_migrations SET checksum = ? WHERE migration_id = ? AND checksum = ?")
            .run(canonicalChecksum, migration.id, existing.checksum);
        }
        continue;
      }
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
