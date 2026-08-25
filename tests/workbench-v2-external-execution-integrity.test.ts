import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const EXPECTED_THREADS = [
  "PRRT_kwDOTTDtUM6ZfJwv",
  "PRRT_kwDOTTDtUM6ZfJww",
  "PRRT_kwDOTTDtUM6ZfjJd",
  "PRRT_kwDOTTDtUM6Z9w6i",
  "PRRT_kwDOTTDtUM6Z_11q",
  "PRRT_kwDOTTDtUM6aAoJM",
  "PRRT_kwDOTTDtUM6aDPTh",
  "PRRT_kwDOTTDtUM6aD6D_",
  "PRRT_kwDOTTDtUM6aEawF",
  "PRRT_kwDOTTDtUM6acFef",
  "PRRT_kwDOTTDtUM6asFkl"
] as const;

test("External Execution Integrity ledger covers all 11 deferred review threads with selected tests", () => {
  const ledgerPath = resolve("docs/evidence/external-execution-integrity-thread-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
    migration: string;
    workbench_schema: string;
    status: string;
    threads: Array<{
      thread_id: string;
      semantics: string;
      tests: Array<{ file: string; name: string }>;
    }>;
  };
  assert.equal(ledger.migration, "0016");
  assert.equal(ledger.workbench_schema, "workbench-v2-11");
  assert.equal(ledger.status, "LOCAL_FIXTURE_COVERED");
  assert.deepEqual(ledger.threads.map((entry) => entry.thread_id), [...EXPECTED_THREADS]);
  for (const entry of ledger.threads) {
    assert.ok(entry.semantics.length > 20, entry.thread_id);
    assert.ok(entry.tests.length > 0, entry.thread_id);
    for (const selected of entry.tests) {
      const testPath = resolve(selected.file);
      assert.equal(existsSync(testPath), true, `${entry.thread_id}: ${selected.file}`);
      const source = readFileSync(testPath, "utf8");
      assert.equal(source.includes(`test("${selected.name}"`), true, `${entry.thread_id}: ${selected.name}`);
    }
  }
});
