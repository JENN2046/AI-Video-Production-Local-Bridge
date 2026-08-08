import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getM0Paths, type M0Paths } from "../paths.js";
import { assertSchemaCurrent } from "../storage/migrations.js";
import { openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import {
  T2_SNAPSHOT_ROWSET_NAMES,
  type T2DatabaseRow,
  type T2RawSnapshot,
  type T2RawRowsetMap,
  type T2RowsetEvidenceMap,
  type GovernedMediaEvidence
} from "./s3bT2Types.js";

export type T2SnapshotPaths = Pick<M0Paths, "dataRoot" | "sqlitePath">;

export class T2SnapshotError extends Error {
  constructor(readonly code: string, message = "T2 snapshot acquisition failed.") {
    super(message);
  }
}

type DatabaseIdentity = {
  real_path: string;
  dev: number;
  ino: number;
  nlink: number;
};

function inside(child: string, parent: string): boolean {
  const relation = relative(resolve(parent), resolve(child));
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return { __bigint__: value.toString() };
  if (Buffer.isBuffer(value)) {
    return { __buffer_sha256__: createHash("sha256").update(value).digest("hex"), byte_length: value.byteLength };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0`).update(canonicalJson(value)).digest("hex");
}

function assertNoSymlinkPath(root: string, target: string): void {
  const relation = relative(root, target);
  let current = root;
  for (const segment of relation.split(/[\\/]+/u)) {
    if (!segment) continue;
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new T2SnapshotError("T2_DATABASE_AUTHORITY_INVALID");
  }
}

function inspectDatabaseAuthority(input: T2SnapshotPaths): DatabaseIdentity {
  try {
    const dataRoot = resolve(input.dataRoot);
    const sqlitePath = resolve(input.sqlitePath);
    if (!inside(sqlitePath, dataRoot)) throw new T2SnapshotError("T2_DATABASE_AUTHORITY_INVALID");

    const rootEntry = lstatSync(dataRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new T2SnapshotError("T2_DATABASE_AUTHORITY_INVALID");
    }
    assertNoSymlinkPath(dataRoot, sqlitePath);

    const entry = lstatSync(sqlitePath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new T2SnapshotError("T2_DATABASE_AUTHORITY_INVALID");
    }
    const realRoot = realpathSync(dataRoot);
    const realPath = realpathSync(sqlitePath);
    if (!inside(realPath, realRoot)) throw new T2SnapshotError("T2_DATABASE_AUTHORITY_INVALID");
    const stats = statSync(sqlitePath);
    if (!stats.isFile() || stats.nlink !== 1) throw new T2SnapshotError("T2_DATABASE_AUTHORITY_INVALID");
    return { real_path: realPath, dev: stats.dev, ino: stats.ino, nlink: stats.nlink };
  } catch (error) {
    if (error instanceof T2SnapshotError) throw error;
    throw new T2SnapshotError("T2_DATABASE_AUTHORITY_INVALID");
  }
}

function assertIdentityStable(input: T2SnapshotPaths, expected: DatabaseIdentity): void {
  const current = inspectDatabaseAuthority(input);
  if (current.real_path !== expected.real_path
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.nlink !== expected.nlink) {
    throw new T2SnapshotError("T2_DATABASE_IDENTITY_DRIFT");
  }
}

function totalChanges(db: M0Database): number {
  const row = db.prepare("SELECT total_changes() AS value").get() as { value: number | bigint };
  return Number(row.value);
}

function readRowsets(db: M0Database): { rows: T2RawRowsetMap; evidence: T2RowsetEvidenceMap } {
  const rows = {} as T2RawRowsetMap;
  const evidence = {} as T2RowsetEvidenceMap;
  for (const table of T2_SNAPSHOT_ROWSET_NAMES) {
    const escapedTable = `"${table.replaceAll('"', '""')}"`;
    const tableRows = db.prepare(`SELECT * FROM ${escapedTable} ORDER BY rowid`).all() as T2DatabaseRow[];
    rows[table] = tableRows;
    evidence[table] = { row_count: tableRows.length, digest: digest(`t2-rowset-${table}-v1`, tableRows) };
  }
  return { rows, evidence };
}

function databaseEvidenceDigest(
  database: T2RawSnapshot["database"],
  evidence: T2RowsetEvidenceMap
): string {
  return digest("t2-database-evidence-v1", {
    database,
    rowsets: Object.fromEntries(T2_SNAPSHOT_ROWSET_NAMES.map((name) => [name, evidence[name]]))
  });
}

/** The single construction point for the internal canonical snapshot evidence. */
export function fingerprintT2SnapshotEvidence(input: {
  database_evidence_digest: string;
  media_root_evidence_digest: string;
  referenced_media_evidence: readonly Pick<GovernedMediaEvidence, "fingerprint_digest">[];
}): string {
  return digest("t2-snapshot-evidence-v2", {
    database_evidence_digest: input.database_evidence_digest,
    media_root_evidence_digest: input.media_root_evidence_digest,
    referenced_media_evidence: [...input.referenced_media_evidence]
      .map((evidence) => evidence.fingerprint_digest)
      .sort()
  });
}

export function captureT2RawSnapshot(input: T2SnapshotPaths = getM0Paths()): T2RawSnapshot {
  const identity = inspectDatabaseAuthority(input);
  const identityDigest = digest("t2-database-identity-v1", {
    dev: identity.dev,
    ino: identity.ino,
    nlink: identity.nlink
  });
  const assertPathCurrent = (): void => assertIdentityStable(input, identity);
  let db: M0Database | undefined;
  try {
    db = openM0DatabaseConnection(input.sqlitePath, { readOnly: true, assertPathCurrent });
    const queryOnly = Number((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only);
    if (queryOnly !== 1) throw new T2SnapshotError("T2_DATABASE_WRITE_DETECTED");
    try {
      assertSchemaCurrent(db);
    } catch {
      throw new T2SnapshotError("T2_DATABASE_SCHEMA_INVALID");
    }
    const before = totalChanges(db);
    const activeIntentCount = Number((db.prepare(
      "SELECT COUNT(*) AS count FROM generation_intents WHERE status IN ('queued', 'running')"
    ).get() as { count: number | bigint }).count);
    const rowsets = readRowsets(db);
    const after = totalChanges(db);
    if (before !== 0 || after !== 0) throw new T2SnapshotError("T2_DATABASE_WRITE_DETECTED");
    assertPathCurrent();
    const database = {
      identity_digest: identityDigest,
      total_changes_before: before,
      total_changes_after: after,
      active_intent_count: activeIntentCount,
      query_only: 1 as const,
      schema_current: true as const
    };
    return {
      database,
      rowsets: rowsets.rows,
      rowset_evidence: rowsets.evidence,
      database_evidence_digest: databaseEvidenceDigest(database, rowsets.evidence)
    };
  } catch (error) {
    if (error instanceof T2SnapshotError) throw error;
    throw new T2SnapshotError("T2_DATABASE_SNAPSHOT_FAILED");
  } finally {
    db?.close();
  }
}
