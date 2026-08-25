import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateDatabase } from "../src/storage/databaseGovernance.js";
import {
  installWorkbenchProductionMutationAuthority,
  withWorkbenchProductionMutationAuthority
} from "../src/storage/productionMutationAuthority.js";
import { captureT2Core } from "../src/tools/s3bT2Eligibility.js";

function fixture(): { root: string; dataRoot: string; sqlitePath: string; mediaRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "t2-core-"));
  const dataRoot = join(root, "data");
  const mediaRoot = join(dataRoot, "media");
  mkdirSync(mediaRoot, { recursive: true });
  const sqlitePath = join(dataRoot, "app.sqlite");
  migrateDatabase(sqlitePath);
  return { root, dataRoot, sqlitePath, mediaRoot };
}

test("two-snapshot core detects database drift without retrying", () => {
  const f = fixture();
  let hookCalls = 0;
  try {
    const result = captureT2Core({ snapshotPaths: { dataRoot: f.dataRoot, sqlitePath: f.sqlitePath }, mediaRoot: f.mediaRoot, betweenSnapshots: () => {
      hookCalls += 1;
      const db = new DatabaseSync(f.sqlitePath);
      try {
        installWorkbenchProductionMutationAuthority(db);
        withWorkbenchProductionMutationAuthority(db, {
          kind: "project_content", project_id: "drift", object_id: "drift"
        }, () => db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
          .run("drift", JSON.stringify({ project_id: "drift" })));
      } finally { db.close(); }
    } });
    assert.equal(hookCalls, 1);
    assert.equal(result.decision.state, "INELIGIBLE");
    assert.equal(result.decision.reason_code_counts.INTERNAL_STATE_CHANGED, 1);
    assert.notEqual(result.first_fingerprint, result.second_fingerprint);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unchanged invalid media remains a stable internal decision", () => {
  const f = fixture();
  try {
    const result = captureT2Core({ snapshotPaths: { dataRoot: f.dataRoot, sqlitePath: f.sqlitePath }, mediaRoot: f.mediaRoot });
    assert.equal(result.first_fingerprint, result.second_fingerprint);
    assert.equal(result.decision.state, "INELIGIBLE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy snapshot evaluator is bypassed when generation history is unassignable", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.sqlitePath);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
        .run("job_core_orphan", "intent_core_missing");
    } finally {
      db.close();
    }
    const result = captureT2Core({ snapshotPaths: { dataRoot: f.dataRoot, sqlitePath: f.sqlitePath }, mediaRoot: f.mediaRoot });
    assert.equal(result.decision.state, "INELIGIBLE");
    assert.deepEqual(result.decision.candidates, []);
    assert.deepEqual(result.decision.reason_code_counts, { GENERATION_ADMISSION_FACTS_UNAVAILABLE: 1 });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
