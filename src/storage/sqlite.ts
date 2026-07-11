import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { ensureM0Directories, paths } from "../paths.js";
import { assertSchemaCurrent, runDatabaseMigrations } from "./migrations.js";

export type M0Database = DatabaseSync;

function isEphemeralTestDatabase(sqlitePath: string): boolean {
  if (process.env.AI_VIDEO_TEST_AUTO_MIGRATE !== "true") return false;
  const rel = relative(resolve(tmpdir()), resolve(sqlitePath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function openM0DatabaseConnection(sqlitePath = paths.sqlitePath, options: { readOnly?: boolean } = {}): M0Database {
  const readOnly = options.readOnly === true;
  if (!readOnly) ensureM0Directories();
  const db = new DatabaseSync(sqlitePath, { readOnly });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  if (readOnly) db.exec("PRAGMA query_only = ON;");
  return db;
}

export function openM0Database(sqlitePath = paths.sqlitePath): M0Database {
  const db = openM0DatabaseConnection(sqlitePath);
  try {
    if (sqlitePath === ":memory:" || isEphemeralTestDatabase(sqlitePath)) runDatabaseMigrations(db);
    else assertSchemaCurrent(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function initializeM0Schema(db: M0Database): void {
  runDatabaseMigrations(db);
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
