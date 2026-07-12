import { existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { paths } from "../paths.js";
import { assertSchemaCurrent, runDatabaseMigrations } from "./migrations.js";

export interface DatabaseCheckResult {
  result: "PASS" | "FAIL";
  quick_check: string;
  schema_current: boolean;
  invalid_json_rows: number;
  structured_drift_rows: number;
  orphan_rows: number;
  missing_media_files: number;
  check_errors: number;
}

export interface DatabaseLogicalManifest {
  table_count: number;
  row_count: number;
  sha256: string;
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

export function checkDatabase(sqlitePath = paths.sqlitePath): DatabaseCheckResult {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    let quickCheck = "error";
    try { quickCheck = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check; } catch { /* reported as FAIL */ }
    let schemaCurrent = true;
    try { assertSchemaCurrent(db); } catch { schemaCurrent = false; }
    const errors: string[] = [];
    const jsonColumns = [
      ["projects", "data_json"], ["shots", "data_json"], ["storyboard_packages", "data_json"], ["media_artifacts", "data_json"],
      ["generation_batches", "data_json"], ["generation_runs", "data_json"], ["import_index", "metadata_json"],
      ["regeneration_requests", "data_json"], ["generation_intents", "sanitized_error_json"], ["generation_intents", "data_json"],
      ["workbench_drafts", "data_json"], ["workbench_pending_actions", "data_json"], ["workbench_pending_actions", "result_json"],
      ["workbench_inbox_events", "data_json"], ["workbench_governance_runs", "rule_groups_json"],
      ["webgpt_audit_events", "changed_fields_json"], ["webgpt_audit_events", "result_json"], ["generation_job_events", "data_json"],
      ["media_blobs", "provenance_json"]
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
      + scalarCount(db, "SELECT COUNT(*) AS count FROM regeneration_requests WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.request_id') IS NOT request_id OR json_extract(data_json, '$.project_id') IS NOT project_id OR json_extract(data_json, '$.shot_id') IS NOT shot_id OR json_extract(data_json, '$.artifact_id') IS NOT artifact_id OR json_extract(data_json, '$.previous_run_id') IS NOT previous_run_id OR json_extract(data_json, '$.status') IS NOT status)", errors);
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
      "SELECT COUNT(*) AS count FROM generation_job_events e LEFT JOIN generation_jobs j ON j.job_id = e.job_id WHERE j.job_id IS NULL"
      ,"SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id WHERE m.artifact_id IS NULL"
      ,"SELECT COUNT(*) AS count FROM media_artifact_blobs m LEFT JOIN media_artifacts a ON a.artifact_id = m.artifact_id WHERE a.artifact_id IS NULL"
      ,"SELECT COUNT(*) AS count FROM media_artifact_blobs m LEFT JOIN media_blobs b ON b.blob_id = m.blob_id WHERE b.blob_id IS NULL"
      ,`SELECT COUNT(*) AS count FROM media_artifacts a
        JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id
        JOIN media_blobs b ON b.blob_id = m.blob_id
        WHERE a.status = 'active' AND b.integrity_state <> 'verified'`
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
    const pass = quickCheck === "ok" && schemaCurrent && errors.length === 0 && invalidJsonRows === 0 && structuredDriftRows === 0 && orphanRows === 0 && missingMediaFiles === 0;
    return { result: pass ? "PASS" : "FAIL", quick_check: quickCheck, schema_current: schemaCurrent, invalid_json_rows: invalidJsonRows, structured_drift_rows: structuredDriftRows, orphan_rows: orphanRows, missing_media_files: missingMediaFiles, check_errors: errors.length };
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
