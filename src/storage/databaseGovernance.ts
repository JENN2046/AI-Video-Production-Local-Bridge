import { existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { paths } from "../paths.js";
import {
  DIRECTOR_FOCUS_SCHEMA,
  validateDirectorAutomationGrant,
  validateDirectorProposal,
  validateStoryboardPackageV2
} from "../director/domain.js";
import { assertSchemaCurrent, runDatabaseMigrations } from "./migrations.js";
import { getMediaArtifact, recoverMediaActivations, verifyMediaArtifactBytes } from "../tools/mediaArtifacts.js";

export interface DatabaseCheckResult {
  result: "PASS" | "FAIL";
  quick_check: string;
  schema_current: boolean;
  invalid_json_rows: number;
  structured_drift_rows: number;
  orphan_rows: number;
  missing_media_files: number;
  media_integrity_errors: number;
  pending_media_activations: number;
  quarantined_media_activations: number;
  unbound_webgpt_authorization_rows: number;
  check_errors: number;
}

export interface DatabaseLogicalManifest {
  table_count: number;
  row_count: number;
  sha256: string;
}

export interface DatabaseCheckOptions {
  recover_media_activations?: boolean;
}

export function databaseLogicalManifest(sqlitePath = paths.sqlitePath): DatabaseLogicalManifest {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const tables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    const payload: Array<{ table: string; rows: unknown[] }> = [];
    let rowCount = 0;
    for (const table of tables) {
      const escaped = `"${table.replaceAll('"', '""')}"`;
      const rows = db.prepare(`SELECT * FROM ${escaped} ORDER BY rowid`).all() as unknown[];
      rowCount += rows.length;
      payload.push({ table, rows });
    }
    return {
      table_count: tables.length,
      row_count: rowCount,
      sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    };
  } finally {
    db.close();
  }
}

function scalarCount(db: DatabaseSync, sql: string, errors: string[]): number {
  try {
    return Number((db.prepare(sql).get() as { count: number }).count);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "DATABASE_CHECK_QUERY_FAILED");
    return 0;
  }
}

function directorContractDriftRows(db: DatabaseSync, errors: string[]): number {
  let drift = 0;
  try {
    const focuses = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
      generation, supersedes_focus_id, created_at, expires_at FROM director_focuses`).all() as Array<Record<string, unknown>>;
    for (const focus of focuses) if (!DIRECTOR_FOCUS_SCHEMA.safeParse(focus).success) drift += 1;

    const proposals = db.prepare(`SELECT proposal_id, schema_version, workspace_id, principal_id, project_id,
      target_type, target_id, focus_id, focus_generation, base_state_hash, payload_json, payload_hash,
      parent_proposal_id, idempotency_key, source, created_at, kind FROM director_proposals`).all() as Array<Record<string, unknown>>;
    for (const row of proposals) {
      try {
        const { payload_json: payloadJson, ...proposal } = row;
        validateDirectorProposal({ ...proposal, payload: JSON.parse(String(payloadJson)) });
      } catch { drift += 1; }
    }

    const grants = db.prepare(`SELECT grant_id, workspace_id, principal_id, project_id, provider,
      allowed_actions_json, currency, max_total_minor, max_per_run_minor, max_versions_per_shot,
      max_automatic_retries, pricing_contract_version, capability_contract_version, starts_at, expires_at,
      policy_hash, created_at FROM director_automation_grants`).all() as Array<Record<string, unknown>>;
    for (const row of grants) {
      try {
        const { allowed_actions_json: actionsJson, ...grant } = row;
        validateDirectorAutomationGrant({ ...grant, allowed_actions: JSON.parse(String(actionsJson)) });
      } catch { drift += 1; }
    }

    const packageVersions = db.prepare(`SELECT package_version_id, project_id, version,
      supersedes_package_version_id, schema_version, payload_json, content_hash,
      created_from_proposal_id, created_at FROM storyboard_package_versions`).all() as Array<Record<string, unknown>>;
    for (const row of packageVersions) {
      try {
        const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        const parsed = validateStoryboardPackageV2(payload);
        if (parsed.package_version_id !== row.package_version_id
          || parsed.project_id !== row.project_id
          || parsed.version !== row.version
          || parsed.supersedes_package_version_id !== row.supersedes_package_version_id
          || parsed.schema_version !== row.schema_version
          || parsed.content_hash !== row.content_hash
          || parsed.created_from_proposal_id !== row.created_from_proposal_id
          || parsed.created_at !== row.created_at) drift += 1;
      } catch { drift += 1; }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "DIRECTOR_CONTRACT_CHECK_FAILED");
  }
  return drift;
}

export function checkDatabase(sqlitePath = paths.sqlitePath, options: DatabaseCheckOptions = {}): DatabaseCheckResult {
  let recoveryErrors = 0;
  if (options.recover_media_activations !== false) {
    const recoveryDb = new DatabaseSync(sqlitePath);
    try {
      recoveryDb.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      assertSchemaCurrent(recoveryDb);
      const recovery = recoverMediaActivations(recoveryDb);
      recoveryErrors = recovery.failed.length;
    } catch {
      recoveryErrors = 1;
    } finally {
      recoveryDb.close();
    }
  }
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    let quickCheck = "error";
    try { quickCheck = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check; } catch { /* reported as FAIL */ }
    let schemaCurrent = true;
    try { assertSchemaCurrent(db); } catch { schemaCurrent = false; }
    const errors: string[] = recoveryErrors > 0 ? ["MEDIA_ACTIVATION_RECOVERY_FAILED"] : [];
    const jsonColumns = [
      ["projects", "data_json"], ["shots", "data_json"], ["storyboard_packages", "data_json"], ["media_artifacts", "data_json"],
      ["generation_batches", "data_json"], ["generation_runs", "data_json"], ["import_index", "metadata_json"],
      ["regeneration_requests", "data_json"], ["generation_intents", "sanitized_error_json"], ["generation_intents", "data_json"],
      ["workbench_drafts", "data_json"], ["workbench_pending_actions", "data_json"], ["workbench_pending_actions", "result_json"],
      ["workbench_inbox_events", "data_json"], ["workbench_governance_runs", "rule_groups_json"],
      ["webgpt_audit_events", "changed_fields_json"], ["webgpt_audit_events", "result_json"], ["generation_job_events", "data_json"],
      ["media_blobs", "provenance_json"], ["media_activation_journal", "artifact_json"],
      ["director_proposals", "payload_json"], ["director_automation_grants", "allowed_actions_json"], ["storyboard_package_versions", "payload_json"]
    ] as const;
    const invalidJsonRows = jsonColumns.reduce((sum, [table, column]) => sum + scalarCount(db, `SELECT COUNT(*) AS count FROM ${table} WHERE json_valid(${column}) = 0`, errors), 0);
    const structuredDriftRows = scalarCount(db, "SELECT COUNT(*) AS count FROM projects WHERE json_valid(data_json) = 1 AND json_extract(data_json, '$.project_id') IS NOT project_id", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM shots WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.shot_id') IS NOT shot_id OR json_extract(data_json, '$.project_id') IS NOT project_id)", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM storyboard_packages WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.storyboard_package_id') IS NOT storyboard_package_id OR json_extract(data_json, '$.project_id') IS NOT project_id)", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_batches WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.batch_id') IS NOT batch_id OR json_extract(data_json, '$.project_id') IS NOT project_id OR json_extract(data_json, '$.storyboard_package_id') IS NOT storyboard_package_id)", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_runs WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.run_id') IS NOT run_id OR json_extract(data_json, '$.batch_id') IS NOT batch_id OR json_extract(data_json, '$.project_id') IS NOT project_id OR json_extract(data_json, '$.shot_id') IS NOT shot_id)", errors)
      + scalarCount(db, `SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id
          WHERE json_valid(a.data_json) = 1 AND (
            json_extract(a.data_json, '$.artifact_id') IS NOT a.artifact_id
            OR json_extract(a.data_json, '$.linked_objects.project_id') IS NOT COALESCE(a.project_id, '')
            OR json_extract(a.data_json, '$.linked_objects.shot_id') IS NOT COALESCE(a.shot_id, '')
            OR json_extract(a.data_json, '$.role') IS NOT a.role
            OR json_extract(a.data_json, '$.artifact_type') IS NOT a.artifact_type
            OR json_extract(a.data_json, '$.status') IS NOT a.status
            OR json_extract(a.data_json, '$.blob_id') IS NOT m.blob_id
          )`, errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM regeneration_requests WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.request_id') IS NOT request_id OR json_extract(data_json, '$.project_id') IS NOT project_id OR json_extract(data_json, '$.shot_id') IS NOT shot_id OR json_extract(data_json, '$.artifact_id') IS NOT artifact_id OR json_extract(data_json, '$.previous_run_id') IS NOT previous_run_id OR json_extract(data_json, '$.status') IS NOT status)", errors)
      + scalarCount(db, `SELECT COUNT(*) AS count FROM media_activation_journal
          WHERE json_valid(artifact_json) = 1 AND (
            json_extract(artifact_json, '$.artifact_id') IS NOT artifact_id
            OR json_extract(artifact_json, '$.artifact_type') IS NOT artifact_type
            OR json_extract(artifact_json, '$.role') IS NOT role
            OR json_extract(artifact_json, '$.storage.uri') IS NOT final_path
            OR json_extract(artifact_json, '$.storage.mime_type') IS NOT detected_mime
            OR json_extract(artifact_json, '$.metadata.sha256') IS NOT expected_sha256
            OR json_extract(artifact_json, '$.source.sha256') IS NOT expected_sha256
          )`, errors)
      + directorContractDriftRows(db, errors);
    const orphanQueries = [
      "SELECT COUNT(*) AS count FROM shots s LEFT JOIN projects p ON p.project_id = s.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN projects p ON p.project_id = r.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN shots s ON s.shot_id = r.shot_id WHERE r.shot_id IS NOT NULL AND r.shot_id <> '' AND s.shot_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN generation_batches b ON b.batch_id = r.batch_id WHERE r.batch_id <> '' AND b.batch_id IS NULL",
      "SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN projects p ON p.project_id = a.project_id WHERE a.project_id IS NOT NULL AND a.project_id <> '' AND p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN shots s ON s.shot_id = a.shot_id WHERE a.shot_id IS NOT NULL AND a.shot_id <> '' AND s.shot_id IS NULL",
      "SELECT COUNT(*) AS count FROM storyboard_packages s LEFT JOIN projects p ON p.project_id = s.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_batches b LEFT JOIN projects p ON p.project_id = b.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_batches b LEFT JOIN storyboard_packages s ON s.storyboard_package_id = b.storyboard_package_id WHERE b.storyboard_package_id <> '' AND s.storyboard_package_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_project_meta m LEFT JOIN projects p ON p.project_id = m.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM regeneration_requests r LEFT JOIN projects p ON p.project_id = r.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM regeneration_requests r LEFT JOIN shots s ON s.shot_id = r.shot_id WHERE s.shot_id IS NULL",
      "SELECT COUNT(*) AS count FROM regeneration_requests r LEFT JOIN media_artifacts a ON a.artifact_id = r.artifact_id WHERE a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_intents i LEFT JOIN projects p ON p.project_id = i.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_intents i LEFT JOIN shots s ON s.shot_id = i.shot_id WHERE s.shot_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_intents i LEFT JOIN media_artifacts a ON a.artifact_id = i.input_artifact_id WHERE a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_intents i LEFT JOIN generation_runs r ON r.run_id = i.run_id WHERE i.run_id IS NOT NULL AND i.run_id <> '' AND r.run_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_intents i LEFT JOIN media_artifacts a ON a.artifact_id = i.output_artifact_id WHERE i.output_artifact_id <> '' AND a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_review_notes n LEFT JOIN projects p ON p.project_id = n.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_review_notes n LEFT JOIN shots s ON s.shot_id = n.shot_id WHERE s.shot_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_review_notes n LEFT JOIN media_artifacts a ON a.artifact_id = n.artifact_id WHERE n.artifact_id IS NOT NULL AND n.artifact_id <> '' AND a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM webgpt_media_grants g LEFT JOIN projects p ON p.project_id = g.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM webgpt_media_grants g LEFT JOIN media_artifacts a ON a.artifact_id = g.artifact_id WHERE a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_jobs j LEFT JOIN generation_intents i ON i.intent_id = j.intent_id WHERE i.intent_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_job_events e LEFT JOIN generation_jobs j ON j.job_id = e.job_id WHERE j.job_id IS NULL",
      "SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id WHERE m.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM media_artifact_blobs m LEFT JOIN media_artifacts a ON a.artifact_id = m.artifact_id WHERE a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM media_artifact_blobs m LEFT JOIN media_blobs b ON b.blob_id = m.blob_id WHERE b.blob_id IS NULL",
      `SELECT COUNT(*) AS count FROM media_artifacts a
        JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id
        JOIN media_blobs b ON b.blob_id = m.blob_id
        WHERE a.status = 'active' AND b.integrity_state <> 'verified'`,
      "SELECT COUNT(*) AS count FROM media_activation_journal j LEFT JOIN media_artifacts a ON a.artifact_id = j.artifact_id WHERE j.state = 'committed' AND a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM webgpt_project_memberships m LEFT JOIN webgpt_auth_principals p ON p.workspace_id = m.workspace_id AND p.principal_id = m.principal_id WHERE p.principal_id IS NULL",
      "SELECT COUNT(*) AS count FROM webgpt_auth_principal_bindings b LEFT JOIN webgpt_auth_principals p ON p.workspace_id = b.workspace_id AND p.principal_id = b.principal_id WHERE p.principal_id IS NULL",
      "SELECT COUNT(*) AS count FROM webgpt_project_memberships m LEFT JOIN projects p ON p.project_id = m.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM webgpt_auth_events e LEFT JOIN webgpt_auth_principals p ON p.workspace_id = e.workspace_id AND p.principal_id = e.principal_id WHERE p.principal_id IS NULL",
      "SELECT COUNT(*) AS count FROM webgpt_auth_events e LEFT JOIN projects p ON p.project_id = e.project_id WHERE e.project_id IS NOT NULL AND p.project_id IS NULL",
      `SELECT COUNT(*) AS count FROM director_focuses f LEFT JOIN shots s ON f.target_type = 'shot' AND s.shot_id = f.target_id AND s.project_id = f.project_id
        WHERE f.target_type = 'shot' AND s.shot_id IS NULL`,
      `SELECT COUNT(*) AS count FROM director_focuses f LEFT JOIN media_artifacts a ON f.target_type = 'artifact' AND a.artifact_id = f.target_id AND a.project_id = f.project_id
        WHERE f.target_type = 'artifact' AND a.artifact_id IS NULL`,
      `SELECT COUNT(*) AS count FROM director_focuses f
        LEFT JOIN storyboard_packages p ON f.target_type = 'storyboard_package' AND p.storyboard_package_id = f.target_id AND p.project_id = f.project_id
        LEFT JOIN storyboard_package_versions v ON f.target_type = 'storyboard_package' AND v.package_version_id = f.target_id AND v.project_id = f.project_id
        WHERE f.target_type = 'storyboard_package' AND p.storyboard_package_id IS NULL AND v.package_version_id IS NULL`,
      `SELECT COUNT(*) AS count FROM director_focuses f LEFT JOIN generation_runs r ON f.target_type = 'generation_run' AND r.run_id = f.target_id AND r.project_id = f.project_id
        WHERE f.target_type = 'generation_run' AND r.run_id IS NULL`,
      "SELECT COUNT(*) AS count FROM director_focuses WHERE target_type IN ('project','delivery','memory') AND target_id IS NOT project_id",
      `SELECT COUNT(*) AS count FROM director_focuses f
        LEFT JOIN director_focuses parent ON parent.focus_id = f.supersedes_focus_id
          AND parent.workspace_id = f.workspace_id AND parent.principal_id = f.principal_id AND parent.project_id = f.project_id
        WHERE f.supersedes_focus_id IS NOT NULL AND parent.focus_id IS NULL`,
      `SELECT COUNT(*) AS count FROM director_proposals p
        LEFT JOIN director_focuses f ON f.focus_id = p.focus_id AND f.workspace_id = p.workspace_id
          AND f.principal_id = p.principal_id AND f.project_id = p.project_id AND f.target_type = p.target_type
          AND f.target_id = p.target_id AND f.generation = p.focus_generation
        WHERE f.focus_id IS NULL`,
      `SELECT COUNT(*) AS count FROM director_proposals p
        LEFT JOIN director_proposals parent ON parent.proposal_id = p.parent_proposal_id
          AND parent.workspace_id = p.workspace_id AND parent.principal_id = p.principal_id AND parent.project_id = p.project_id
        WHERE p.parent_proposal_id IS NOT NULL AND parent.proposal_id IS NULL`,
      `SELECT COUNT(*) AS count FROM storyboard_package_versions v
        LEFT JOIN storyboard_package_versions parent ON parent.package_version_id = v.supersedes_package_version_id
          AND parent.project_id = v.project_id
        WHERE v.supersedes_package_version_id IS NOT NULL AND parent.package_version_id IS NULL`,
      `SELECT COUNT(*) AS count FROM storyboard_package_versions v
        LEFT JOIN director_proposals p ON p.proposal_id = v.created_from_proposal_id AND p.project_id = v.project_id
        WHERE v.created_from_proposal_id IS NOT NULL AND p.proposal_id IS NULL`
    ];
    const orphanRows = orphanQueries.reduce((sum, sql) => sum + scalarCount(db, sql, errors), 0);
    let mediaRows: Array<{ data_json: string }> = [];
    try { mediaRows = db.prepare("SELECT data_json FROM media_artifacts").all() as Array<{ data_json: string }>; } catch (error) { errors.push(error instanceof Error ? error.message : "MEDIA_FILE_CHECK_FAILED"); }
    const missingMediaFiles = mediaRows.reduce((count, row) => {
      try {
        const parsed = JSON.parse(row.data_json) as { storage?: { uri?: string } };
        const uri = parsed.storage?.uri;
        if (!uri || /^https?:\/\//i.test(uri)) return count;
        return !existsSync(uri) ? count + 1 : count;
      } catch {
        return count;
      }
    }, 0);
    let mediaIntegrityErrors = 0;
    try {
      const activeRows = db.prepare("SELECT artifact_id FROM media_artifacts WHERE status = 'active' ORDER BY artifact_id").all() as Array<{ artifact_id: string }>;
      for (const row of activeRows) {
        try {
          const artifact = getMediaArtifact(db, row.artifact_id);
          if (!artifact || !verifyMediaArtifactBytes(db, artifact).ok) mediaIntegrityErrors += 1;
        } catch { mediaIntegrityErrors += 1; }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "MEDIA_INTEGRITY_CHECK_FAILED");
    }
    const pendingMediaActivations = scalarCount(db, "SELECT COUNT(*) AS count FROM media_activation_journal WHERE state IN ('staged','file_placed')", errors);
    const quarantinedMediaActivations = scalarCount(db, "SELECT COUNT(*) AS count FROM media_activation_journal WHERE state = 'failed'", errors);
    const unboundWebGptAuthorizationRows = scalarCount(db, `SELECT COUNT(*) AS count FROM webgpt_auth_principals p
      LEFT JOIN webgpt_auth_principal_bindings b ON b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id
      WHERE p.status = 'active' AND b.principal_id IS NULL`, errors)
      + scalarCount(db, `SELECT COUNT(*) AS count FROM webgpt_project_memberships m
        LEFT JOIN webgpt_auth_principal_bindings b ON b.workspace_id = m.workspace_id AND b.principal_id = m.principal_id
        WHERE m.status = 'active' AND b.principal_id IS NULL`, errors);
    const pass = quickCheck === "ok" && schemaCurrent && errors.length === 0 && invalidJsonRows === 0 && structuredDriftRows === 0 && orphanRows === 0 && missingMediaFiles === 0 && mediaIntegrityErrors === 0 && pendingMediaActivations === 0 && quarantinedMediaActivations === 0 && unboundWebGptAuthorizationRows === 0;
    return { result: pass ? "PASS" : "FAIL", quick_check: quickCheck, schema_current: schemaCurrent, invalid_json_rows: invalidJsonRows, structured_drift_rows: structuredDriftRows, orphan_rows: orphanRows, missing_media_files: missingMediaFiles, media_integrity_errors: mediaIntegrityErrors, pending_media_activations: pendingMediaActivations, quarantined_media_activations: quarantinedMediaActivations, unbound_webgpt_authorization_rows: unboundWebGptAuthorizationRows, check_errors: errors.length };
  } finally {
    db.close();
  }
}

export function backupDatabase(input: { sqlite_path?: string; backup_root?: string; timestamp?: Date } = {}): { backup_path: string; filename: string } {
  const sqlitePath = resolve(input.sqlite_path ?? paths.sqlitePath);
  if (!existsSync(sqlitePath) || statSync(sqlitePath).size === 0) throw new Error("DATABASE_NOT_FOUND");
  const backupRoot = resolve(input.backup_root ?? join(paths.workspaceRoot, "ops", "backups"));
  mkdirSync(backupRoot, { recursive: true });
  const stamp = (input.timestamp ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const target = resolve(backupRoot, `app-${stamp}.sqlite`);
  if (existsSync(target)) throw new Error("DATABASE_BACKUP_EXISTS");
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  return { backup_path: target, filename: basename(target) };
}

export function migrateDatabase(sqlitePath = paths.sqlitePath): { applied: string[]; baselined: boolean } {
  const resolvedPath = resolve(sqlitePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  try {
    return runDatabaseMigrations(db);
  } finally {
    db.close();
  }
}
