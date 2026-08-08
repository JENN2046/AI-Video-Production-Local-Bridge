import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateDatabase } from "../src/storage/databaseGovernance.js";
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
    db.exec("PRAGMA foreign_keys = ON");
    callback(db);
  } finally {
    db.close();
  }
}

function insertProject(db: DatabaseSync, projectId = "project_t2_fixture"): void {
  db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
    .run(projectId, JSON.stringify({ project_id: projectId, title: "fixture" }));
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
