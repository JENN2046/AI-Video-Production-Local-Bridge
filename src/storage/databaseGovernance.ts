import { existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { paths } from "../paths.js";
import {
  validateDirectorArtifactImportReceipt,
  DIRECTOR_FOCUS_SCHEMA,
  validateDirectorAutomationGrant,
  validateDirectorProposal,
  validateStoryboardPackageV2
} from "../director/domain.js";
import { assertSchemaCurrent, runDatabaseMigrations } from "./migrations.js";
import { workbenchAssemblyInputFingerprintFromJson } from "./workbenchAssemblyFingerprint.js";
import { verifyWorkbenchExportFile, verifyWorkbenchExportFileIdentity } from "./workbenchExportIntegrity.js";
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

    const importReceipts = db.prepare(`SELECT receipt_id, proposal_id, project_id, shot_id, artifact_id,
      blob_sha256, role, mime_type, created_at FROM director_artifact_import_receipts`).all() as Array<Record<string, unknown>>;
    for (const receipt of importReceipts) {
      try {
        validateDirectorArtifactImportReceipt(receipt);
        const bound = db.prepare(`SELECT 1
          FROM director_proposals p
          JOIN media_artifacts a ON a.artifact_id = ?
          JOIN media_artifact_blobs link ON link.artifact_id = a.artifact_id
          JOIN media_blobs b ON b.blob_id = link.blob_id
          WHERE p.proposal_id = ? AND p.project_id = ?
            AND p.kind = 'artifact_import' AND p.target_type = 'shot' AND p.target_id = ?
            AND json_valid(p.payload_json) = 1
            AND json_extract(p.payload_json, '$.shot_id') = ?
            AND json_extract(p.payload_json, '$.target_role') = ?
            AND json_extract(p.payload_json, '$.expected_mime_type') = ?
            AND a.project_id = ? AND a.shot_id = ? AND a.role = ?
            AND a.artifact_type = CASE WHEN ? = 'storyboard_image' THEN 'image' ELSE 'video' END
            AND json_valid(a.data_json) = 1
            AND json_extract(a.data_json, '$.artifact_id') = a.artifact_id
            AND json_extract(a.data_json, '$.linked_objects.project_id') = a.project_id
            AND json_extract(a.data_json, '$.linked_objects.shot_id') = a.shot_id
            AND json_extract(a.data_json, '$.role') = a.role
            AND json_extract(a.data_json, '$.artifact_type') = a.artifact_type
            AND json_extract(a.data_json, '$.blob_id') = b.blob_id
            AND json_extract(a.data_json, '$.storage.mime_type') = ?
            AND json_extract(a.data_json, '$.metadata.sha256') = ?
            AND json_extract(a.data_json, '$.source.sha256') = ?
            AND b.sha256 = ? AND b.detected_mime = ?`).get(
          receipt.artifact_id, receipt.proposal_id, receipt.project_id, receipt.shot_id,
          receipt.shot_id, receipt.role, receipt.mime_type, receipt.project_id, receipt.shot_id,
          receipt.role, receipt.role, receipt.mime_type, receipt.blob_sha256,
          receipt.blob_sha256, receipt.blob_sha256, receipt.mime_type
        );
        if (!bound) drift += 1;
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
      ["director_proposals", "payload_json"], ["director_automation_grants", "allowed_actions_json"], ["storyboard_package_versions", "payload_json"],
      ["workbench_delivery_jobs", "input_json"], ["workbench_delivery_events", "data_json"]
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
      + scalarCount(db, `SELECT COUNT(*) AS count
          FROM projects p JOIN workbench_delivery_state d ON d.project_id = p.project_id
          WHERE COALESCE(NULLIF(TRIM(json_extract(p.data_json, '$.exports.final_video_artifact_id')), ''), '')
            IS NOT COALESCE(d.current_final_artifact_id, '')`, errors)
      + directorContractDriftRows(db, errors);
    const orphanQueries = [
      "SELECT COUNT(*) AS count FROM shots s LEFT JOIN projects p ON p.project_id = s.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN projects p ON p.project_id = r.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN shots s ON s.shot_id = r.shot_id WHERE r.shot_id IS NOT NULL AND r.shot_id <> '' AND s.shot_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN generation_batches b ON b.batch_id = r.batch_id WHERE r.batch_id <> '' AND b.batch_id IS NULL",
      "SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN projects p ON p.project_id = a.project_id WHERE a.project_id IS NOT NULL AND a.project_id <> '' AND p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN shots s ON s.shot_id = a.shot_id WHERE a.shot_id IS NOT NULL AND a.shot_id <> '' AND s.shot_id IS NULL",
      "SELECT COUNT(*) AS count FROM storyboard_packages s LEFT JOIN projects p ON p.project_id = s.project_id WHERE p.project_id IS NULL",
      `SELECT COUNT(*) AS count FROM projects p
        LEFT JOIN storyboard_packages s
          ON s.storyboard_package_id = json_extract(p.data_json, '$.active_storyboard_package_id')
          AND s.project_id = p.project_id
        WHERE COALESCE(json_extract(p.data_json, '$.active_storyboard_package_id'), '') <> ''
          AND s.storyboard_package_id IS NULL`,
      "SELECT COUNT(*) AS count FROM generation_batches b LEFT JOIN projects p ON p.project_id = b.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM generation_batches b LEFT JOIN storyboard_packages s ON s.storyboard_package_id = b.storyboard_package_id WHERE b.storyboard_package_id <> '' AND s.storyboard_package_id IS NULL",
      `SELECT COUNT(*) AS count FROM generation_batches b
        JOIN storyboard_packages s ON s.storyboard_package_id = b.storyboard_package_id
        WHERE b.storyboard_package_id <> '' AND b.project_id IS NOT s.project_id`,
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
        WHERE v.created_from_proposal_id IS NOT NULL AND p.proposal_id IS NULL`,
      `SELECT COUNT(*) AS count FROM director_artifact_import_receipts r
        LEFT JOIN director_proposals p ON p.proposal_id = r.proposal_id AND p.project_id = r.project_id
        LEFT JOIN projects project ON project.project_id = r.project_id
        LEFT JOIN shots shot ON shot.shot_id = r.shot_id AND shot.project_id = r.project_id
        LEFT JOIN media_artifacts artifact ON artifact.artifact_id = r.artifact_id
          AND artifact.project_id = r.project_id AND artifact.shot_id = r.shot_id
        WHERE p.proposal_id IS NULL OR project.project_id IS NULL OR shot.shot_id IS NULL OR artifact.artifact_id IS NULL`,
      "SELECT COUNT(*) AS count FROM projects p LEFT JOIN workbench_delivery_state d ON d.project_id = p.project_id WHERE d.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_delivery_state d LEFT JOIN projects p ON p.project_id = d.project_id WHERE p.project_id IS NULL",
      `SELECT COUNT(*) AS count FROM workbench_delivery_state d
        LEFT JOIN media_artifacts current_artifact
          ON current_artifact.artifact_id = d.current_final_artifact_id
          AND current_artifact.project_id = d.project_id AND COALESCE(current_artifact.shot_id, '') = ''
          AND current_artifact.role = 'final_video' AND current_artifact.artifact_type = 'video'
          AND current_artifact.status = 'active'
        LEFT JOIN media_artifacts approved_artifact
          ON approved_artifact.artifact_id = d.approved_artifact_id
          AND approved_artifact.project_id = d.project_id AND COALESCE(approved_artifact.shot_id, '') = ''
          AND approved_artifact.role = 'final_video' AND approved_artifact.artifact_type = 'video'
          AND approved_artifact.status = 'active'
        WHERE (d.current_final_artifact_id IS NOT NULL AND current_artifact.artifact_id IS NULL)
          OR (d.approved_artifact_id IS NOT NULL AND approved_artifact.artifact_id IS NULL)`,
      "SELECT COUNT(*) AS count FROM workbench_delivery_jobs j LEFT JOIN projects p ON p.project_id = j.project_id WHERE p.project_id IS NULL",
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs j
        LEFT JOIN workbench_delivery_jobs parent ON parent.job_id = j.retry_of_job_id
          AND parent.project_id = j.project_id AND parent.job_type = j.job_type
        WHERE j.retry_of_job_id IS NOT NULL AND parent.job_id IS NULL`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs j
        LEFT JOIN media_artifacts a ON a.artifact_id = j.output_artifact_id
          AND j.job_type = 'assembly' AND a.project_id = j.project_id
          AND COALESCE(a.shot_id, '') = '' AND a.role = 'final_video'
          AND a.artifact_type = 'video' AND a.status = 'active'
        WHERE j.output_artifact_id IS NOT NULL AND a.artifact_id IS NULL`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        WHERE job.job_type = 'assembly' AND job.state IN ('queued','running','succeeded') AND (
          json_type(job.input_json, '$.source_clip_artifact_ids') IS NOT 'array'
          OR NOT EXISTS (
            SELECT 1 FROM shots project_shot WHERE project_shot.project_id = job.project_id
          )
          OR json_array_length(job.input_json, '$.source_clip_artifact_ids') <> (
            SELECT COUNT(*) FROM shots project_shot WHERE project_shot.project_id = job.project_id
          )
          OR json_array_length(job.input_json, '$.source_clip_artifact_ids') <> (
            SELECT COUNT(DISTINCT source_clip.value)
            FROM json_each(job.input_json, '$.source_clip_artifact_ids') source_clip
            WHERE source_clip.type = 'text'
          )
          OR EXISTS (
            SELECT 1 FROM json_each(job.input_json, '$.source_clip_artifact_ids') source_clip
            LEFT JOIN (
              SELECT ranked_shot.shot_id, ranked_shot.project_id,
                ROW_NUMBER() OVER (
                  PARTITION BY ranked_shot.project_id
                  ORDER BY json_extract(ranked_shot.data_json, '$.order'), ranked_shot.shot_id
                ) - 1 AS input_index
              FROM shots ranked_shot
            ) source_shot ON source_shot.project_id = job.project_id
              AND source_shot.input_index = CAST(source_clip.key AS INTEGER)
            LEFT JOIN media_artifacts artifact ON artifact.artifact_id = source_clip.value
              AND artifact.project_id = job.project_id AND artifact.role = 'generated_clip'
              AND artifact.artifact_type = 'video' AND artifact.status = 'active'
              AND artifact.shot_id = source_shot.shot_id
            WHERE source_clip.type <> 'text' OR source_shot.shot_id IS NULL
              OR artifact.artifact_id IS NULL
          )
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        WHERE job.job_type = 'assembly' AND job.state IN ('queued','running')
          AND EXISTS (
            SELECT 1 FROM json_each(job.input_json, '$.source_clip_artifact_ids') source_clip
            LEFT JOIN media_artifacts artifact ON artifact.artifact_id = source_clip.value
              AND artifact.project_id = job.project_id AND artifact.role = 'generated_clip'
              AND artifact.artifact_type = 'video' AND artifact.status = 'active'
            LEFT JOIN shots shot ON shot.shot_id = artifact.shot_id
              AND shot.project_id = job.project_id
            WHERE source_clip.type <> 'text' OR artifact.artifact_id IS NULL OR shot.shot_id IS NULL
              OR json_extract(shot.data_json, '$.accepted_clip_artifact_id') IS NOT artifact.artifact_id
              OR COALESCE(json_extract(shot.data_json, '$.status'), '') <> 'approved'
              OR COALESCE(json_extract(shot.data_json, '$.review.approval_status'), '') <> 'approved'
              OR NOT EXISTS (
                SELECT 1 FROM json_each(shot.data_json, '$.clip_versions') clip_version
                WHERE json_extract(clip_version.value, '$.artifact_id') IS artifact.artifact_id
                  AND json_extract(clip_version.value, '$.review_status') = 'approved'
              )
          )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        JOIN workbench_delivery_events success_event
          ON success_event.job_id = job.job_id AND success_event.project_id = job.project_id
          AND success_event.event_type = 'assembly_succeeded'
        WHERE job.job_type = 'assembly' AND job.state = 'succeeded'
          AND NOT EXISTS (
            SELECT 1 FROM workbench_delivery_events later_rework
            WHERE later_rework.project_id = job.project_id
              AND later_rework.event_type IN ('final_review_reassemble','final_review_regenerate_shots')
              AND (later_rework.created_at > success_event.created_at
                OR (later_rework.created_at = success_event.created_at
                  AND later_rework.rowid > success_event.rowid))
          )
          AND EXISTS (
            SELECT 1 FROM json_each(job.input_json, '$.source_clip_artifact_ids') source_clip
            LEFT JOIN media_artifacts artifact ON artifact.artifact_id = source_clip.value
              AND artifact.project_id = job.project_id AND artifact.role = 'generated_clip'
              AND artifact.artifact_type = 'video' AND artifact.status = 'active'
            LEFT JOIN shots shot ON shot.shot_id = artifact.shot_id
              AND shot.project_id = job.project_id
            WHERE source_clip.type <> 'text' OR artifact.artifact_id IS NULL OR shot.shot_id IS NULL
              OR json_extract(shot.data_json, '$.accepted_clip_artifact_id') IS NOT artifact.artifact_id
              OR COALESCE(json_extract(shot.data_json, '$.status'), '') <> 'approved'
              OR COALESCE(json_extract(shot.data_json, '$.review.approval_status'), '') <> 'approved'
              OR NOT EXISTS (
                SELECT 1 FROM json_each(shot.data_json, '$.clip_versions') clip_version
                WHERE json_extract(clip_version.value, '$.artifact_id') IS artifact.artifact_id
                  AND json_extract(clip_version.value, '$.review_status') = 'approved'
              )
          )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs j
        LEFT JOIN workbench_exports e ON e.export_id = j.export_id
          AND j.job_type = 'export' AND e.project_id = j.project_id
        WHERE j.export_id IS NOT NULL AND (
          e.export_id IS NULL OR e.artifact_id IS NOT json_extract(j.input_json, '$.artifact_id')
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        LEFT JOIN workbench_delivery_state state ON state.project_id = job.project_id
          AND state.workflow_state IN ('approved','exported')
          AND state.current_final_artifact_id IS json_extract(job.input_json, '$.artifact_id')
          AND state.approved_artifact_id IS json_extract(job.input_json, '$.artifact_id')
        WHERE job.job_type = 'export' AND job.state IN ('queued','running')
          AND state.project_id IS NULL`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        LEFT JOIN workbench_delivery_events event
          ON event.active_export_binding_key = job.active_export_binding_key
        WHERE job.job_type = 'export' AND job.state IN ('queued','running')
          AND event.event_id IS NULL`,
      "SELECT COUNT(*) AS count FROM workbench_delivery_events e LEFT JOIN projects p ON p.project_id = e.project_id WHERE p.project_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_delivery_events e LEFT JOIN workbench_delivery_jobs j ON j.job_id = e.job_id AND j.project_id = e.project_id WHERE e.job_id IS NOT NULL AND j.job_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_delivery_events e LEFT JOIN media_artifacts a ON a.artifact_id = e.artifact_id AND a.project_id = e.project_id WHERE e.artifact_id IS NOT NULL AND a.artifact_id IS NULL",
      "SELECT COUNT(*) AS count FROM workbench_delivery_events e LEFT JOIN workbench_exports x ON x.export_id = e.export_id AND x.project_id = e.project_id WHERE e.export_id IS NOT NULL AND x.export_id IS NULL",
      `SELECT COUNT(*) AS count FROM workbench_delivery_events event WHERE NOT (
        (event.event_type = 'assembly_queued'
          AND event.from_state IN ('not_ready','ready_to_assemble','revision_requested')
          AND event.to_state = 'assembling')
        OR (event.event_type = 'assembly_started'
          AND event.from_state = 'assembling' AND event.to_state = 'assembling')
        OR (event.event_type = 'assembly_succeeded'
          AND event.from_state = 'assembling' AND event.to_state = 'final_review')
        OR (event.event_type IN ('assembly_failed','assembly_interrupted')
          AND event.from_state = 'assembling' AND event.to_state = 'ready_to_assemble')
        OR (event.event_type = 'final_review_accepted'
          AND event.from_state IN ('final_review','legacy_review_required')
          AND event.to_state = 'approved')
        OR (event.event_type = 'final_review_reassemble'
          AND event.from_state IN ('final_review','approved','exported','legacy_review_required')
          AND event.to_state = 'ready_to_assemble')
        OR (event.event_type = 'final_review_regenerate_shots'
          AND event.from_state IN ('final_review','approved','exported','legacy_review_required')
          AND event.to_state = 'revision_requested')
        OR (event.event_type IN ('export_queued','export_started','export_failed','export_interrupted')
          AND event.from_state IN ('approved','exported') AND event.to_state = event.from_state)
        OR (event.event_type = 'export_succeeded'
          AND event.from_state IN ('approved','exported') AND event.to_state = 'exported')
        OR (event.event_type = 'closeout'
          AND event.from_state = 'exported' AND event.to_state = 'closed')
      )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_events event
        WHERE event.event_type = 'final_review_regenerate_shots' AND (
          json_type(event.data_json, '$.shot_ids') IS NOT 'array'
          OR json_array_length(event.data_json, '$.shot_ids') < 1
          OR (SELECT COUNT(DISTINCT CAST(target.value AS TEXT))
              FROM json_each(event.data_json, '$.shot_ids') target
              WHERE target.type = 'text' AND CAST(target.value AS TEXT) <> '')
            <> json_array_length(event.data_json, '$.shot_ids')
          OR EXISTS (
            SELECT 1 FROM json_each(event.data_json, '$.shot_ids') target
            LEFT JOIN shots shot ON shot.shot_id = CAST(target.value AS TEXT)
              AND shot.project_id = event.project_id
            WHERE target.type <> 'text' OR CAST(target.value AS TEXT) = '' OR shot.shot_id IS NULL
          )
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state = 'revision_requested' AND NOT EXISTS (
          SELECT 1 FROM workbench_delivery_events event
          JOIN json_each(event.data_json, '$.shot_ids') target
          JOIN shots shot ON shot.shot_id = CAST(target.value AS TEXT)
            AND shot.project_id = event.project_id
          WHERE event.project_id = state.project_id
            AND event.event_type = 'final_review_regenerate_shots'
            AND event.to_state = 'revision_requested'
            AND json_extract(shot.data_json, '$.status') = 'revision_needed'
            AND json_extract(shot.data_json, '$.review.approval_status') = 'revision_needed'
            AND COALESCE(json_extract(shot.data_json, '$.accepted_clip_artifact_id'), '') = ''
            AND EXISTS (
              SELECT 1 FROM json_each(shot.data_json, '$.clip_versions') clip_version
              WHERE json_extract(clip_version.value, '$.review_status') = 'rejected'
            )
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_events event
        LEFT JOIN media_artifacts artifact ON artifact.artifact_id = event.artifact_id
          AND artifact.project_id = event.project_id AND COALESCE(artifact.shot_id, '') = ''
          AND artifact.role = 'final_video' AND artifact.artifact_type = 'video'
          AND artifact.status = 'active'
        WHERE event.event_type IN (
          'final_review_accepted','final_review_reassemble','final_review_regenerate_shots'
        ) AND NOT (
          event.job_id IS NULL AND event.export_id IS NULL
          AND event.artifact_id IS NOT NULL AND artifact.artifact_id IS NOT NULL
          AND (
            NOT EXISTS (
              SELECT 1 FROM workbench_delivery_events prior
              WHERE prior.project_id = event.project_id AND prior.event_type = 'assembly_succeeded'
                AND (prior.created_at < event.created_at
                  OR (prior.created_at = event.created_at AND prior.rowid < event.rowid))
            )
            OR (
              (SELECT prior.artifact_id FROM workbench_delivery_events prior
                WHERE prior.project_id = event.project_id AND prior.event_type = 'assembly_succeeded'
                  AND (prior.created_at < event.created_at
                    OR (prior.created_at = event.created_at AND prior.rowid < event.rowid))
                ORDER BY prior.created_at DESC, prior.rowid DESC LIMIT 1) IS event.artifact_id
              AND (SELECT prior.input_fingerprint FROM workbench_delivery_events prior
                WHERE prior.project_id = event.project_id AND prior.event_type = 'assembly_succeeded'
                  AND (prior.created_at < event.created_at
                    OR (prior.created_at = event.created_at AND prior.rowid < event.rowid))
                ORDER BY prior.created_at DESC, prior.rowid DESC LIMIT 1) IS event.input_fingerprint
            )
          )
          AND (
            (
              NOT EXISTS (
                SELECT 1 FROM workbench_delivery_events later
                WHERE later.project_id = event.project_id
                  AND (later.created_at > event.created_at
                    OR (later.created_at = event.created_at AND later.rowid > event.rowid))
              )
              AND EXISTS (
                SELECT 1 FROM workbench_delivery_state state
                WHERE state.project_id = event.project_id
                  AND state.current_final_artifact_id IS event.artifact_id
                  AND state.assembly_input_fingerprint IS event.input_fingerprint
                  AND (
                    (event.event_type = 'final_review_accepted'
                      AND state.workflow_state = 'approved'
                      AND state.approved_artifact_id IS event.artifact_id
                      AND state.latest_export_id IS NULL)
                    OR (event.event_type = 'final_review_reassemble'
                      AND state.workflow_state IN ('ready_to_assemble','not_ready')
                      AND state.approved_artifact_id IS NULL AND state.latest_export_id IS NULL)
                    OR (event.event_type = 'final_review_regenerate_shots'
                      AND state.workflow_state IN ('revision_requested','ready_to_assemble','not_ready')
                      AND state.approved_artifact_id IS NULL AND state.latest_export_id IS NULL)
                  )
              )
            )
            OR (
              EXISTS (
                SELECT 1 FROM workbench_delivery_events later
                WHERE later.project_id = event.project_id
                  AND (later.created_at > event.created_at
                    OR (later.created_at = event.created_at AND later.rowid > event.rowid))
              )
              AND (
                (event.event_type = 'final_review_accepted' AND
                  (SELECT later.from_state FROM workbench_delivery_events later
                    WHERE later.project_id = event.project_id
                      AND (later.created_at > event.created_at
                        OR (later.created_at = event.created_at AND later.rowid > event.rowid))
                    ORDER BY later.created_at, later.rowid LIMIT 1) = 'approved')
                OR (event.event_type = 'final_review_reassemble' AND
                  (SELECT later.from_state FROM workbench_delivery_events later
                    WHERE later.project_id = event.project_id
                      AND (later.created_at > event.created_at
                        OR (later.created_at = event.created_at AND later.rowid > event.rowid))
                    ORDER BY later.created_at, later.rowid LIMIT 1)
                    IN ('ready_to_assemble','not_ready','assembling'))
                OR (event.event_type = 'final_review_regenerate_shots' AND
                  (SELECT later.from_state FROM workbench_delivery_events later
                    WHERE later.project_id = event.project_id
                      AND (later.created_at > event.created_at
                        OR (later.created_at = event.created_at AND later.rowid > event.rowid))
                    ORDER BY later.created_at, later.rowid LIMIT 1)
                    IN ('revision_requested','ready_to_assemble','not_ready','assembling'))
              )
            )
          )
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_events event
        WHERE event.event_type IN (
          'assembly_queued','assembly_started','assembly_succeeded','assembly_failed','assembly_interrupted',
          'export_queued','export_started','export_succeeded','export_failed','export_interrupted'
        ) AND NOT (
          (event.event_type = 'export_succeeded' AND event.job_id IS NULL
            AND event.reason_code = 'EXPORT_REUSED' AND EXISTS (
              SELECT 1 FROM workbench_exports reused
              WHERE reused.export_id = event.export_id AND reused.project_id = event.project_id
                AND reused.artifact_id = event.artifact_id
            ))
          OR EXISTS (
            SELECT 1 FROM workbench_delivery_jobs job
            LEFT JOIN workbench_exports bound_export ON bound_export.export_id = job.export_id
              AND bound_export.project_id = job.project_id
            WHERE job.job_id = event.job_id AND job.project_id = event.project_id
              AND (
                (event.event_type = 'assembly_queued' AND job.job_type = 'assembly'
                  AND event.artifact_id IS NULL AND event.export_id IS NULL)
                OR (event.event_type = 'assembly_started' AND job.job_type = 'assembly'
                  AND job.state IN ('running','succeeded','failed','interrupted')
                  AND job.started_at IS NOT NULL AND event.artifact_id IS NULL AND event.export_id IS NULL)
                OR (event.event_type = 'assembly_succeeded' AND job.job_type = 'assembly'
                  AND job.state = 'succeeded' AND event.artifact_id IS job.output_artifact_id
                  AND event.export_id IS NULL)
                OR (event.event_type = 'assembly_failed' AND job.job_type = 'assembly'
                  AND job.state = 'failed' AND event.artifact_id IS NULL AND event.export_id IS NULL)
                OR (event.event_type = 'assembly_interrupted' AND job.job_type = 'assembly'
                  AND job.state = 'interrupted' AND event.artifact_id IS NULL AND event.export_id IS NULL)
                OR (event.event_type = 'export_queued' AND job.job_type = 'export'
                  AND event.artifact_id IS json_extract(job.input_json, '$.artifact_id')
                  AND event.export_id IS NULL)
                OR (event.event_type = 'export_started' AND job.job_type = 'export'
                  AND job.state IN ('running','succeeded','failed','interrupted')
                  AND job.started_at IS NOT NULL
                  AND event.artifact_id IS json_extract(job.input_json, '$.artifact_id')
                  AND event.export_id IS NULL)
                OR (event.event_type = 'export_succeeded' AND job.job_type = 'export'
                  AND job.state = 'succeeded' AND event.export_id IS job.export_id
                  AND event.artifact_id IS bound_export.artifact_id
                  AND event.artifact_id IS json_extract(job.input_json, '$.artifact_id'))
                OR (event.event_type = 'export_failed' AND job.job_type = 'export'
                  AND job.state = 'failed' AND event.export_id IS job.export_id
                  AND event.artifact_id IS json_extract(job.input_json, '$.artifact_id'))
                OR (event.event_type = 'export_interrupted' AND job.job_type = 'export'
                  AND job.state = 'interrupted' AND event.export_id IS job.export_id
                  AND event.artifact_id IS json_extract(job.input_json, '$.artifact_id'))
              )
          )
        )`,
      `SELECT COALESCE(SUM(event_count - 1), 0) AS count FROM (
        SELECT COUNT(*) AS event_count FROM workbench_delivery_events
        WHERE job_id IS NOT NULL GROUP BY job_id, event_type HAVING COUNT(*) > 1
      )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        LEFT JOIN workbench_delivery_events event
          ON event.event_id = job.terminal_event_id AND event.project_id = job.project_id
            AND event.job_id = job.job_id AND event.event_type = job.terminal_event_type
        WHERE job.state IN ('succeeded','failed','interrupted')
          AND event.event_id IS NULL`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_events event
        LEFT JOIN workbench_delivery_jobs job
          ON job.terminal_event_id = event.event_id AND job.project_id = event.project_id
            AND job.job_id = event.job_id AND job.terminal_event_type = event.event_type
        WHERE event.job_id IS NOT NULL AND event.event_type IN (
          'assembly_succeeded','assembly_failed','assembly_interrupted',
          'export_succeeded','export_failed','export_interrupted'
        )
          AND job.job_id IS NULL`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        WHERE job.state = 'succeeded' AND NOT EXISTS (
          SELECT 1 FROM workbench_delivery_events event
          LEFT JOIN workbench_exports bound_export ON bound_export.export_id = job.export_id
            AND bound_export.project_id = job.project_id
          WHERE event.job_id = job.job_id AND event.project_id = job.project_id
            AND (
              (job.job_type = 'assembly' AND event.event_type = 'assembly_succeeded'
                AND event.from_state = 'assembling' AND event.to_state = 'final_review'
                AND event.artifact_id IS job.output_artifact_id AND event.export_id IS NULL
                AND event.input_fingerprint IS job.input_fingerprint)
              OR (job.job_type = 'export' AND event.event_type = 'export_succeeded'
                AND event.from_state = 'approved' AND event.to_state = 'exported'
                AND event.artifact_id IS json_extract(job.input_json, '$.artifact_id')
                AND event.artifact_id IS bound_export.artifact_id
                AND event.export_id IS job.export_id)
            )
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state = 'final_review' AND 1 <> (
          SELECT COUNT(*) FROM workbench_delivery_events event
          JOIN workbench_delivery_jobs job ON job.job_id = event.job_id
            AND job.project_id = event.project_id
          WHERE event.project_id = state.project_id
            AND event.event_type = 'assembly_succeeded'
            AND event.from_state = 'assembling' AND event.to_state = 'final_review'
            AND job.job_type = 'assembly' AND job.state = 'succeeded'
            AND job.output_artifact_id IS state.current_final_artifact_id
            AND job.input_fingerprint IS state.assembly_input_fingerprint
            AND event.artifact_id IS state.current_final_artifact_id
            AND event.input_fingerprint IS state.assembly_input_fingerprint
            AND event.export_id IS NULL AND event.created_at IS state.updated_at
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state IN ('exported','closed') AND 1 <> (
          SELECT COUNT(*) FROM workbench_delivery_events event
          JOIN workbench_delivery_jobs job ON job.job_id = event.job_id
            AND job.project_id = event.project_id
          JOIN workbench_exports bound_export ON bound_export.export_id = event.export_id
            AND bound_export.project_id = event.project_id
          WHERE event.project_id = state.project_id
            AND event.event_type = 'export_succeeded'
            AND event.from_state = 'approved' AND event.to_state = 'exported'
            AND job.job_type = 'export' AND job.state = 'succeeded'
            AND job.export_id IS state.latest_export_id
            AND json_extract(job.input_json, '$.artifact_id') IS state.current_final_artifact_id
            AND event.artifact_id IS state.current_final_artifact_id
            AND event.artifact_id IS state.approved_artifact_id
            AND event.export_id IS state.latest_export_id
            AND bound_export.artifact_id IS state.current_final_artifact_id
            AND event.created_at IS state.latest_exported_at
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state IN ('approved','exported','closed') AND NOT EXISTS (
          SELECT 1 FROM workbench_delivery_events event
          WHERE event.project_id = state.project_id
            AND event.event_type = 'final_review_accepted'
            AND event.from_state IN ('final_review','legacy_review_required')
            AND event.to_state = 'approved'
            AND event.job_id IS NULL AND event.export_id IS NULL
            AND event.artifact_id IS state.current_final_artifact_id
            AND event.artifact_id IS state.approved_artifact_id
            AND event.input_fingerprint IS state.assembly_input_fingerprint
            AND (state.workflow_state <> 'approved' OR event.created_at IS state.updated_at)
        )`,
      `SELECT COALESCE(SUM(approval_count - 1), 0) AS count FROM (
        SELECT COUNT(*) AS approval_count FROM workbench_delivery_events
        WHERE event_type = 'final_review_accepted'
        GROUP BY project_id, artifact_id, input_fingerprint HAVING COUNT(*) > 1
      )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_events approval
        WHERE approval.event_type = 'final_review_accepted'
          AND approval.from_state IN ('final_review','legacy_review_required')
          AND (
            (approval.from_state = 'legacy_review_required' AND approval.input_fingerprint IS NOT NULL)
            OR (SELECT COUNT(*) FROM workbench_delivery_events assembly_event
              JOIN workbench_delivery_jobs assembly_job
                ON assembly_job.job_id = assembly_event.job_id
                AND assembly_job.project_id = assembly_event.project_id
              WHERE assembly_event.project_id = approval.project_id
                AND assembly_event.event_type = 'assembly_succeeded'
                AND assembly_event.from_state = 'assembling'
                AND assembly_event.to_state = 'final_review'
                AND assembly_job.job_type = 'assembly'
                AND assembly_job.state = 'succeeded'
                AND assembly_job.output_artifact_id IS approval.artifact_id
                AND assembly_job.input_fingerprint IS approval.input_fingerprint
                AND assembly_event.artifact_id IS approval.artifact_id
                AND assembly_event.input_fingerprint IS approval.input_fingerprint
                AND assembly_event.export_id IS NULL
            ) <> CASE approval.from_state WHEN 'final_review' THEN 1 ELSE 0 END
          )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state = 'ready_to_assemble' AND (
          NOT EXISTS (SELECT 1 FROM shots shot WHERE shot.project_id = state.project_id)
          OR EXISTS (
            SELECT 1 FROM shots shot
            LEFT JOIN media_artifacts artifact
              ON artifact.artifact_id = json_extract(shot.data_json, '$.accepted_clip_artifact_id')
              AND artifact.project_id = state.project_id AND artifact.shot_id = shot.shot_id
              AND artifact.role = 'generated_clip' AND artifact.artifact_type = 'video'
              AND artifact.status = 'active'
            LEFT JOIN media_artifact_blobs artifact_blob ON artifact_blob.artifact_id = artifact.artifact_id
            LEFT JOIN media_blobs blob ON blob.blob_id = artifact_blob.blob_id AND blob.integrity_state = 'verified'
            WHERE shot.project_id = state.project_id AND (
              COALESCE(json_extract(shot.data_json, '$.accepted_clip_artifact_id'), '') = ''
              OR COALESCE(json_extract(shot.data_json, '$.status'), '') <> 'approved'
              OR COALESCE(json_extract(shot.data_json, '$.review.approval_status'), '') <> 'approved'
              OR artifact.artifact_id IS NULL OR blob.blob_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM json_each(shot.data_json, '$.clip_versions') clip_version
                WHERE json_extract(clip_version.value, '$.artifact_id') IS artifact.artifact_id
                  AND json_extract(clip_version.value, '$.review_status') = 'approved'
              )
            )
          )
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state IN ('ready_to_assemble','revision_requested')
          AND state.current_final_artifact_id IS NOT NULL
          AND (EXISTS (
            SELECT 1 FROM workbench_delivery_events assembly_event
            JOIN workbench_delivery_jobs assembly_job ON assembly_job.job_id = assembly_event.job_id
              AND assembly_job.project_id = assembly_event.project_id
            WHERE assembly_event.project_id = state.project_id
              AND assembly_event.event_type = 'assembly_succeeded'
              AND assembly_event.artifact_id IS state.current_final_artifact_id
              AND assembly_event.input_fingerprint IS state.assembly_input_fingerprint
              AND assembly_job.job_type = 'assembly' AND assembly_job.state = 'succeeded'
              AND assembly_job.output_artifact_id IS state.current_final_artifact_id
              AND assembly_job.input_fingerprint IS state.assembly_input_fingerprint
          ) OR EXISTS (
            SELECT 1 FROM workbench_delivery_events approval
            WHERE approval.project_id = state.project_id
              AND approval.event_type = 'final_review_accepted'
              AND approval.artifact_id IS state.current_final_artifact_id
              AND approval.input_fingerprint IS state.assembly_input_fingerprint
          ))
          AND NOT EXISTS (
            SELECT 1 FROM workbench_delivery_events rework
            WHERE rework.project_id = state.project_id
              AND rework.event_type IN ('final_review_reassemble','final_review_regenerate_shots')
              AND rework.from_state IN ('final_review','approved','exported')
              AND rework.artifact_id IS state.current_final_artifact_id
              AND rework.input_fingerprint IS state.assembly_input_fingerprint
              AND ((rework.event_type = 'final_review_reassemble' AND rework.to_state = 'ready_to_assemble')
                OR (rework.event_type = 'final_review_regenerate_shots' AND rework.to_state = 'revision_requested'))
          )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state = 'ready_to_assemble'
          AND state.current_final_artifact_id IS NOT NULL
          AND state.assembly_input_fingerprint IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM workbench_delivery_events rework
            WHERE rework.project_id = state.project_id
              AND rework.event_type = 'final_review_reassemble'
              AND rework.from_state = 'legacy_review_required'
              AND rework.to_state = 'ready_to_assemble'
              AND rework.job_id IS NULL AND rework.export_id IS NULL
              AND rework.artifact_id IS state.current_final_artifact_id
              AND rework.input_fingerprint IS NULL
          )`,
      `SELECT COALESCE(SUM(rework_count - 1), 0) AS count FROM (
        SELECT COUNT(*) AS rework_count FROM workbench_delivery_events
        WHERE event_type IN ('final_review_reassemble','final_review_regenerate_shots')
        GROUP BY project_id, event_type, from_state, to_state, artifact_id, input_fingerprint
        HAVING COUNT(*) > 1
      )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_events event
        WHERE event.event_type = 'closeout' AND NOT EXISTS (
          SELECT 1 FROM workbench_delivery_state state
          JOIN workbench_exports bound_export ON bound_export.export_id = state.latest_export_id
            AND bound_export.project_id = state.project_id AND bound_export.artifact_id = state.current_final_artifact_id
          WHERE state.project_id = event.project_id AND state.workflow_state = 'closed'
            AND event.job_id IS NULL AND event.input_fingerprint IS NULL
            AND state.current_final_artifact_id = event.artifact_id
            AND state.approved_artifact_id = event.artifact_id
            AND state.latest_export_id = event.export_id
            AND state.closed_at IS event.created_at
        )`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        WHERE state.workflow_state = 'closed' AND NOT EXISTS (
          SELECT 1 FROM workbench_delivery_events event
          JOIN workbench_exports bound_export ON bound_export.export_id = state.latest_export_id
            AND bound_export.project_id = state.project_id
            AND bound_export.artifact_id = state.current_final_artifact_id
          WHERE event.project_id = state.project_id AND event.event_type = 'closeout'
            AND event.from_state = 'exported' AND event.to_state = 'closed'
            AND event.job_id IS NULL AND event.input_fingerprint IS NULL
            AND event.artifact_id IS state.current_final_artifact_id
            AND event.artifact_id IS state.approved_artifact_id
            AND event.export_id IS state.latest_export_id
            AND event.created_at IS state.closed_at
        )`,
      `SELECT COALESCE(SUM(closeout_count - 1), 0) AS count FROM (
        SELECT COUNT(*) AS closeout_count FROM workbench_delivery_events
        WHERE event_type = 'closeout' GROUP BY project_id HAVING COUNT(*) > 1
      )`,
      "SELECT COUNT(*) AS count FROM workbench_exports e LEFT JOIN projects p ON p.project_id = e.project_id WHERE p.project_id IS NULL",
      `SELECT COUNT(*) AS count FROM workbench_exports e
        LEFT JOIN media_artifacts a ON a.artifact_id = e.artifact_id AND a.project_id = e.project_id
          AND COALESCE(a.shot_id, '') = '' AND a.role = 'final_video'
          AND a.artifact_type = 'video' AND a.status = 'active'
        LEFT JOIN media_artifact_blobs ab ON ab.artifact_id = a.artifact_id
        LEFT JOIN media_blobs b ON b.blob_id = ab.blob_id AND b.integrity_state = 'verified'
          AND b.sha256 = e.sha256 AND b.size_bytes = e.size_bytes
        WHERE a.artifact_id IS NULL OR b.blob_id IS NULL`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_state state
        LEFT JOIN workbench_delivery_jobs job
          ON job.active_assembly_binding_key = state.active_assembly_binding_key
        LEFT JOIN workbench_delivery_events event
          ON event.assembly_queue_binding_key = state.active_assembly_binding_key
        WHERE state.workflow_state = 'assembling'
          AND (state.active_assembly_job_id IS NULL OR state.assembly_input_fingerprint IS NULL
            OR job.job_id IS NULL OR event.event_id IS NULL
            OR job.job_id IS NOT state.active_assembly_job_id)`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_jobs job
        LEFT JOIN workbench_delivery_state state
          ON state.active_assembly_binding_key = job.active_assembly_binding_key
        LEFT JOIN workbench_delivery_events event
          ON event.assembly_queue_binding_key = job.active_assembly_binding_key
        WHERE job.job_type = 'assembly' AND job.state IN ('queued','running')
          AND (state.project_id IS NULL OR event.event_id IS NULL)`,
      `SELECT COUNT(*) AS count FROM workbench_delivery_events event
        JOIN workbench_delivery_jobs job ON job.job_id = event.job_id
        WHERE event.event_type = 'assembly_queued' AND job.state IN ('queued','running')
          AND NOT EXISTS (
            SELECT 1 FROM workbench_delivery_state state
            WHERE state.active_assembly_binding_key = event.assembly_queue_binding_key
          )`
    ];
    let assemblyFingerprintDriftRows = 0;
    try {
      const assemblyJobs = db.prepare(`SELECT project_id, input_fingerprint, input_json
        FROM workbench_delivery_jobs WHERE job_type = 'assembly' ORDER BY job_id`).all() as Array<{
          project_id: string; input_fingerprint: string | null; input_json: string;
        }>;
      assemblyFingerprintDriftRows = assemblyJobs.reduce((count, job) => {
        const expected = workbenchAssemblyInputFingerprintFromJson(db, job.project_id, job.input_json);
        return count + (expected !== null && expected === job.input_fingerprint ? 0 : 1);
      }, 0);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "ASSEMBLY_FINGERPRINT_CHECK_FAILED");
    }
    const orphanRows = orphanQueries.reduce((sum, sql) => sum + scalarCount(db, sql, errors), 0)
      + assemblyFingerprintDriftRows;
    let mediaRows: Array<{ data_json: string }> = [];
    try { mediaRows = db.prepare("SELECT data_json FROM media_artifacts").all() as Array<{ data_json: string }>; } catch (error) { errors.push(error instanceof Error ? error.message : "MEDIA_FILE_CHECK_FAILED"); }
    let missingMediaFiles = mediaRows.reduce((count, row) => {
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
    try {
      const exportRows = db.prepare(`SELECT project_id, relative_path, sha256, size_bytes,
          file_identity_sha256
        FROM workbench_exports ORDER BY export_id`).all() as Array<{
          project_id: string; relative_path: string; sha256: string; size_bytes: number;
          file_identity_sha256: string;
        }>;
      for (const row of exportRows) {
        const verified = verifyWorkbenchExportFile(row);
        if (!verified.ok && verified.reason === "missing") missingMediaFiles += 1;
        else if (!verified.ok) mediaIntegrityErrors += 1;
        else if (!verifyWorkbenchExportFileIdentity(row).ok) mediaIntegrityErrors += 1;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "EXPORT_INTEGRITY_CHECK_FAILED");
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
