import { DatabaseSync } from "node:sqlite";

import { ensureM0Directories, paths } from "../paths.js";

export type M0Database = DatabaseSync;

export function openM0Database(sqlitePath = paths.sqlitePath): M0Database {
  ensureM0Directories();
  const db = new DatabaseSync(sqlitePath);
  initializeM0Schema(db);
  return db;
}

export function initializeM0Schema(db: M0Database): void {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;

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
  `);

  db.prepare(`
    INSERT OR REPLACE INTO m0_meta (key, value, updated_at)
    VALUES ('schema_version', 'm0-a', CURRENT_TIMESTAMP)
  `).run();
}

export function listTables(db: M0Database): string[] {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;

  return rows.map((row) => row.name);
}
