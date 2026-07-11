import { existsSync, mkdirSync, statSync } from "node:fs";
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
      ["webgpt_audit_events", "changed_fields_json"], ["webgpt_audit_events", "result_json"], ["generation_job_events", "data_json"]
    ] as const;
    const invalidJsonRows = jsonColumns.reduce((sum, [table, column]) => sum + scalarCount(db, `SELECT COUNT(*) AS count FROM ${table} WHERE json_valid(${column}) = 0`, errors), 0);
    const structuredDriftRows = scalarCount(db, "SELECT COUNT(*) AS count FROM projects WHERE json_valid(data_json) = 1 AND json_extract(data_json, '$.project_id') IS NOT project_id", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM shots WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.shot_id') IS NOT shot_id OR json_extract(data_json, '$.project_id') IS NOT project_id)", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM storyboard_packages WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.storyboard_package_id') IS NOT storyboard_package_id OR json_extract(data_json, '$.project_id') IS NOT project_id)", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_batches WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.batch_id') IS NOT batch_id OR json_extract(data_json, '$.project_id') IS NOT project_id OR json_extract(data_json, '$.storyboard_package_id') IS NOT storyboard_package_id)", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_runs WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.run_id') IS NOT run_id OR json_extract(data_json, '$.batch_id') IS NOT batch_id OR json_extract(data_json, '$.project_id') IS NOT project_id OR json_extract(data_json, '$.shot_id') IS NOT shot_id)", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM media_artifacts WHERE json_valid(data_json) = 1 AND (json_extract(data_json, '$.artifact_id') IS NOT artifact_id OR json_extract(data_json, '$.linked_objects.project_id') IS NOT COALESCE(project_id, '') OR json_extract(data_json, '$.linked_objects.shot_id') IS NOT COALESCE(shot_id, ''))", errors);
    const orphanRows = scalarCount(db, "SELECT COUNT(*) AS count FROM shots s LEFT JOIN projects p ON p.project_id = s.project_id WHERE p.project_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN projects p ON p.project_id = r.project_id WHERE p.project_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN shots s ON s.shot_id = r.shot_id WHERE r.shot_id IS NOT NULL AND r.shot_id <> '' AND s.shot_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN projects p ON p.project_id = a.project_id WHERE a.project_id IS NOT NULL AND a.project_id <> '' AND p.project_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM media_artifacts a LEFT JOIN shots s ON s.shot_id = a.shot_id WHERE a.shot_id IS NOT NULL AND a.shot_id <> '' AND s.shot_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM storyboard_packages s LEFT JOIN projects p ON p.project_id = s.project_id WHERE p.project_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_batches b LEFT JOIN projects p ON p.project_id = b.project_id WHERE p.project_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_batches b LEFT JOIN storyboard_packages s ON s.storyboard_package_id = b.storyboard_package_id WHERE b.storyboard_package_id <> '' AND s.storyboard_package_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_runs r LEFT JOIN generation_batches b ON b.batch_id = r.batch_id WHERE r.batch_id <> '' AND b.batch_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_intents i LEFT JOIN projects p ON p.project_id = i.project_id WHERE p.project_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_intents i LEFT JOIN shots s ON s.shot_id = i.shot_id WHERE s.shot_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_jobs j LEFT JOIN generation_intents i ON i.intent_id = j.intent_id WHERE i.intent_id IS NULL", errors)
      + scalarCount(db, "SELECT COUNT(*) AS count FROM generation_job_events e LEFT JOIN generation_jobs j ON j.job_id = e.job_id WHERE j.job_id IS NULL", errors);
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
