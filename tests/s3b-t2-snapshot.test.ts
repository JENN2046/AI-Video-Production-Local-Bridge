import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateDatabase } from "../src/storage/databaseGovernance.js";
import {
  installWorkbenchProductionMutationAuthority,
  withWorkbenchProductionMutationAuthority
} from "../src/storage/productionMutationAuthority.js";
import { parseCanonicalClipVersion } from "../src/tools/s3bT2Normalize.js";
import { createInvalidGovernedMediaEvidence, createValidGovernedMediaEvidence } from "../src/tools/s3bT2MediaEvidence.js";
import { captureT2RawSnapshot, T2SnapshotError } from "../src/tools/s3bT2Snapshot.js";
import { evaluateT2Snapshot } from "../src/tools/s3bT2Evaluate.js";
import { T2_SNAPSHOT_ROWSET_NAMES } from "../src/tools/s3bT2Types.js";

type Fixture = { root: string; dataRoot: string; sqlitePath: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "t2-is1-snapshot-"));
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { recursive: true });
  const sqlitePath = join(dataRoot, "app.sqlite");
  migrateDatabase(sqlitePath);
  return { root, dataRoot, sqlitePath };
}

function withWritableDatabase(sqlitePath: string, callback: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(sqlitePath);
  try {
    installWorkbenchProductionMutationAuthority(db);
    db.exec("PRAGMA foreign_keys = ON");
    callback(db);
  } finally {
    db.close();
  }
}

function insertProject(db: DatabaseSync, projectId = "project_t2_fixture"): void {
  withWorkbenchProductionMutationAuthority(db, {
    kind: "project_content", project_id: projectId, object_id: projectId
  }, () => db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
    .run(projectId, JSON.stringify({ project_id: projectId, title: "fixture" })));
}

function insertGenerationIntent(db: DatabaseSync): void {
  db.prepare(`INSERT INTO generation_intents
    (intent_id, run_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
     duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency, confirmed,
     expires_at, provider_task_id, status, upload_attempts, submit_attempts, output_artifact_id,
     sanitized_error_json, data_json)
    VALUES (?, NULL, ?, ?, 'runninghub', 'fixture', 'fixture-model', 'artifact_fixture',
      5, '1080x1920', 0, 1, 'USD', 1, '2099-01-01T00:00:00.000Z', '', 'queued', 0, 0, '', '{}', '{}')`)
    .run("intent_t2_fixture", "project_t2_fixture", "shot_t2_fixture");
}

function captureWithConcurrentCommit(
  f: Fixture,
  trigger: "after_active_intent_count" | "after_projects_rowset"
): { snapshot: ReturnType<typeof captureT2RawSnapshot>; writerCommitted: boolean } {
  const writer = new DatabaseSync(f.sqlitePath);
  installWorkbenchProductionMutationAuthority(writer);
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF");
  const mode = writer.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(mode.journal_mode.toLowerCase(), "wal");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let writerCommitted = false;
  const commitWriter = (): void => {
    if (writerCommitted) return;
    writerCommitted = true;
    writer.exec("BEGIN IMMEDIATE");
    try {
      insertProject(writer);
      insertGenerationIntent(writer);
      writer.exec("COMMIT");
    } catch (error) {
      writer.exec("ROLLBACK");
      throw error;
    }
  };
  DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
    const statement = originalPrepare.call(this, sql);
    const normalized = sql.replace(/\s+/gu, " ").trim();
    const triggerGet = trigger === "after_active_intent_count"
      && normalized === "SELECT COUNT(*) AS count FROM generation_intents WHERE status IN ('queued', 'running')";
    const triggerAll = trigger === "after_projects_rowset"
      && normalized === 'SELECT * FROM "projects" ORDER BY rowid';
    if (!triggerGet && !triggerAll) return statement;
    const originalGet = statement.get.bind(statement);
    const originalAll = statement.all.bind(statement);
    return new Proxy(statement, {
      get(target, property) {
        if (triggerGet && property === "get") {
          return (...args: unknown[]) => {
            const result = originalGet(...args);
            commitWriter();
            return result;
          };
        }
        if (triggerAll && property === "all") {
          return (...args: unknown[]) => {
            const result = originalAll(...args);
            commitWriter();
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };
  try {
    return { snapshot: captureT2RawSnapshot(f), writerCommitted };
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    writer.close();
  }
}

function assertSnapshotError(error: unknown, code: string): void {
  assert.ok(error instanceof T2SnapshotError);
  assert.equal(error.code, code);
}

test("read-only open enables query_only and leaves total_changes at zero", () => {
  const f = fixture();
  try {
    const snapshot = captureT2RawSnapshot(f);
    assert.equal(snapshot.database.query_only, 1);
    assert.equal(snapshot.database.total_changes_before, 0);
    assert.equal(snapshot.database.total_changes_after, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("snapshot contains every allowlisted rowset exactly once", () => {
  const f = fixture();
  try {
    const snapshot = captureT2RawSnapshot(f);
    assert.deepEqual(Object.keys(snapshot.rowsets), [...T2_SNAPSHOT_ROWSET_NAMES]);
    assert.deepEqual(Object.keys(snapshot.rowset_evidence), [...T2_SNAPSHOT_ROWSET_NAMES]);
    assert.equal(Object.keys(snapshot.rowsets).length, 10);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the same temporary database has a stable evidence digest", () => {
  const f = fixture();
  try {
    const first = captureT2RawSnapshot(f);
    const second = captureT2RawSnapshot(f);
    assert.equal(first.database_evidence_digest, second.database_evidence_digest);
    assert.deepEqual(first.rowset_evidence, second.rowset_evidence);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a row change changes the rowset and database evidence digest", () => {
  const f = fixture();
  try {
    const before = captureT2RawSnapshot(f);
    withWritableDatabase(f.sqlitePath, (db) => insertProject(db));
    const after = captureT2RawSnapshot(f);
    assert.notEqual(before.rowset_evidence.projects.digest, after.rowset_evidence.projects.digest);
    assert.notEqual(before.database_evidence_digest, after.database_evidence_digest);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a timestamp-only change is included in the full rowset digest", () => {
  const f = fixture();
  try {
    withWritableDatabase(f.sqlitePath, (db) => insertProject(db));
    const before = captureT2RawSnapshot(f);
    withWritableDatabase(f.sqlitePath, (db) => {
      db.prepare("UPDATE projects SET updated_at = ? WHERE project_id = ?")
        .run("2099-01-01T00:00:00.000Z", "project_t2_fixture");
    });
    const after = captureT2RawSnapshot(f);
    assert.notEqual(before.rowset_evidence.projects.digest, after.rowset_evidence.projects.digest);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("generation intent rows are captured and active intent count changes", () => {
  const f = fixture();
  try {
    const before = captureT2RawSnapshot(f);
    withWritableDatabase(f.sqlitePath, (db) => insertGenerationIntent(db));
    const after = captureT2RawSnapshot(f);
    assert.equal(before.database.active_intent_count, 0);
    assert.equal(after.database.active_intent_count, 1);
    assert.notEqual(before.rowset_evidence.generation_intents.digest, after.rowset_evidence.generation_intents.digest);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const trigger of ["after_active_intent_count", "after_projects_rowset"] as const) {
  test(`external commit ${trigger.replaceAll("_", " ")} cannot create a mixed raw snapshot`, () => {
    const f = fixture();
    try {
      const { snapshot, writerCommitted } = captureWithConcurrentCommit(f, trigger);
      assert.equal(writerCommitted, true);
      assert.equal(snapshot.database.active_intent_count, 0);
      assert.equal(snapshot.rowsets.projects.some((row) => row.project_id === "project_t2_fixture"), false);
      assert.equal(snapshot.rowsets.generation_intents.some((row) => row.intent_id === "intent_t2_fixture"), false);

      const after = captureT2RawSnapshot(f);
      assert.equal(after.database.active_intent_count, 1);
      assert.equal(after.rowsets.projects.some((row) => row.project_id === "project_t2_fixture"), true);
      assert.equal(after.rowsets.generation_intents.some((row) => row.intent_id === "intent_t2_fixture"), true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("active intent count and every rowset read share one deferred transaction", () => {
  const f = fixture();
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let transactionOpen = false;
  let beginCount = 0;
  let commitCount = 0;
  let rollbackCount = 0;
  let activeCountInside = false;
  const rowsetsInside = new Set<string>();
  DatabaseSync.prototype.exec = function patchedExec(sql: string): void {
    const normalized = sql.trim().replace(/;$/u, "").toUpperCase();
    if (normalized === "BEGIN DEFERRED") {
      assert.equal(transactionOpen, false);
      beginCount += 1;
      originalExec.call(this, sql);
      transactionOpen = true;
      return;
    }
    if (normalized === "COMMIT") {
      assert.equal(transactionOpen, true);
      commitCount += 1;
      originalExec.call(this, sql);
      transactionOpen = false;
      return;
    }
    if (normalized === "ROLLBACK") rollbackCount += 1;
    originalExec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (normalized === "SELECT COUNT(*) AS count FROM generation_intents WHERE status IN ('queued', 'running')") {
      assert.equal(transactionOpen, true);
      activeCountInside = true;
    }
    const rowset = /^SELECT \* FROM "([^"]+)" ORDER BY rowid$/u.exec(normalized)?.[1];
    if (rowset) {
      assert.equal(transactionOpen, true, `${rowset} escaped the read snapshot`);
      rowsetsInside.add(rowset);
    }
    return originalPrepare.call(this, sql);
  };
  try {
    const snapshot = captureT2RawSnapshot(f);
    assert.equal(snapshot.database.total_changes_before, 0);
    assert.equal(snapshot.database.total_changes_after, 0);
    assert.equal(beginCount, 1);
    assert.equal(commitCount, 1);
    assert.equal(rollbackCount, 0);
    assert.equal(transactionOpen, false);
    assert.equal(activeCountInside, true);
    assert.deepEqual([...rowsetsInside], [...T2_SNAPSHOT_ROWSET_NAMES]);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rowset read failure rolls back the deferred transaction and preserves error semantics", () => {
  const f = fixture();
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let transactionOpen = false;
  let rollbackCount = 0;
  DatabaseSync.prototype.exec = function patchedExec(sql: string): void {
    const normalized = sql.trim().replace(/;$/u, "").toUpperCase();
    if (normalized === "BEGIN DEFERRED") transactionOpen = true;
    if (normalized === "COMMIT" || normalized === "ROLLBACK") {
      if (normalized === "ROLLBACK") rollbackCount += 1;
      transactionOpen = false;
    }
    originalExec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (transactionOpen && normalized === 'SELECT * FROM "shots" ORDER BY rowid') {
      throw new Error("INJECTED_T2_ROWSET_READ_FAILURE");
    }
    return originalPrepare.call(this, sql);
  };
  try {
    assert.throws(() => captureT2RawSnapshot(f), (error: unknown) => {
      assertSnapshotError(error, "T2_DATABASE_SNAPSHOT_FAILED");
      return true;
    });
    assert.equal(rollbackCount, 1);
    assert.equal(transactionOpen, false);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.prepare = originalPrepare;
  }
  try {
    const recovered = captureT2RawSnapshot(f);
    assert.equal(recovered.database.total_changes_after, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("database identity is represented without exposing a path", () => {
  const f = fixture();
  try {
    const snapshot = captureT2RawSnapshot(f);
    assert.match(snapshot.database.identity_digest, /^[0-9a-f]{64}$/);
    assert.equal("real_path" in snapshot.database, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("database paths outside the authoritative data root fail closed", () => {
  const f = fixture();
  const outsidePath = join(f.root, "outside.sqlite");
  try {
    writeFileSync(outsidePath, Buffer.from("not a database"));
    assert.throws(() => captureT2RawSnapshot({ dataRoot: f.dataRoot, sqlitePath: outsidePath }), (error: unknown) => {
      assertSnapshotError(error, "T2_DATABASE_AUTHORITY_INVALID");
      return true;
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a symlink database path fails closed", (t) => {
  const f = fixture();
  const externalPath = join(f.root, "external.sqlite");
  const symlinkPath = join(f.dataRoot, "linked.sqlite");
  try {
    migrateDatabase(externalPath);
    try {
      symlinkSync(externalPath, symlinkPath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "EPERM" || code === "EACCES") return t.skip("symlink creation is unavailable in this test environment");
      throw error;
    }
    assert.throws(() => captureT2RawSnapshot({ dataRoot: f.dataRoot, sqlitePath: symlinkPath }), (error: unknown) => {
      assertSnapshotError(error, "T2_DATABASE_AUTHORITY_INVALID");
      return true;
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("canonical ClipVersion schema is reused and remains strict", () => {
  assert.equal(parseCanonicalClipVersion({ artifact_id: "a", run_id: "r", attempt_number: 1, review_status: "pending" }).success, true);
  assert.equal(parseCanonicalClipVersion({ artifact_id: "a", run_id: "r", attempt_number: 1, review_status: "pending", extra: true }).success, false);
});

test("media evidence boundary always carries an internal fingerprint", () => {
  const valid = createValidGovernedMediaEvidence("fixture");
  const invalid = createInvalidGovernedMediaEvidence("MEDIA_NOT_READ_IN_IS1");
  assert.match(valid.fingerprint_digest, /^[0-9a-f]{64}$/);
  assert.match(invalid.fingerprint_digest, /^[0-9a-f]{64}$/);
  assert.equal(valid.status, "VALID");
  assert.equal(invalid.status, "INVALID");
});

test("evaluator is a pure foundation placeholder and does not claim eligibility", () => {
  const f = fixture();
  try {
    const decision = evaluateT2Snapshot({
      database: { identity_digest: "a".repeat(64), total_changes_before: 0, total_changes_after: 0, active_intent_count: 0, query_only: 1, schema_current: true },
      rowsets: Object.fromEntries(T2_SNAPSHOT_ROWSET_NAMES.map((name) => [name, { row_count: 0, digest: "b".repeat(64) }])) as never,
      database_evidence_digest: "c".repeat(64),
      business_evaluation: "not_started"
    });
    assert.deepEqual(decision, { result: "FOUNDATION_ONLY", eligible: false, reason_code: "T2_EVALUATION_NOT_STARTED" });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
