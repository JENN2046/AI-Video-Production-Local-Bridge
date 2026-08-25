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

test("[EEI-LEDGER-01] External Execution Integrity ledger binds all 11 deferred review threads to stable mandatory test IDs", () => {
  const ledgerPath = resolve("docs/evidence/external-execution-integrity-thread-ledger.json");
  const catalog = JSON.parse(readFileSync(resolve("tests/test-suite-catalog.json"), "utf8")) as {
    groups: Array<{
      classification: string;
      npm_script: string;
      ci_step: string;
      paths: string[];
    }>;
  };
  const packageManifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    scripts: { test: string };
  };
  const windowsCi = readFileSync(resolve(".github/workflows/windows-ci.yml"), "utf8");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
    migration: string;
    workbench_schema: string;
    status: string;
    threads: Array<{
      thread_id: string;
      semantics: string;
      tests: Array<{ test_id: string; file: string; name: string }>;
    }>;
  };
  assert.equal(ledger.migration, "0016");
  assert.equal(ledger.workbench_schema, "workbench-v2-11");
  assert.equal(ledger.status, "LOCAL_FIXTURE_COVERED");
  assert.deepEqual(ledger.threads.map((entry) => entry.thread_id), [...EXPECTED_THREADS]);
  const stableTests = new Map<string, { file: string; name: string }>();
  for (const entry of ledger.threads) {
    assert.ok(entry.semantics.length > 20, entry.thread_id);
    assert.ok(entry.tests.length > 0, entry.thread_id);
    for (const selected of entry.tests) {
      assert.match(selected.test_id, /^EEI-[A-Z0-9]+-[0-9]{2}$/);
      assert.equal(selected.name.startsWith(`[${selected.test_id}] `), true, `${entry.thread_id}: ${selected.test_id}`);
      const prior = stableTests.get(selected.test_id);
      if (prior) assert.deepEqual(prior, { file: selected.file, name: selected.name }, selected.test_id);
      else stableTests.set(selected.test_id, { file: selected.file, name: selected.name });
      const testPath = resolve(selected.file);
      assert.equal(existsSync(testPath), true, `${entry.thread_id}: ${selected.file}`);
      const source = readFileSync(testPath, "utf8");
      const escapedName = selected.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(source, new RegExp(`^test\\("${escapedName}"`, "m"), `${entry.thread_id}: ${selected.name}`);
      const lanes = catalog.groups.filter((group) => group.classification === "mandatory" && group.paths.includes(selected.file));
      assert.equal(lanes.length, 1, `${entry.thread_id}: ${selected.file} must belong to one mandatory lane`);
      const [lane] = lanes;
      assert.match(packageManifest.scripts.test, new RegExp(`(?:^|&& )npm run ${lane.npm_script.replaceAll(":", "\\:")}(?: |$)`));
      assert.equal(windowsCi.includes(`- name: ${lane.ci_step}`), true, lane.ci_step);
      assert.equal(windowsCi.includes(`run: npm run ${lane.npm_script}`), true, lane.npm_script);
    }
  }
  assert.ok(stableTests.size >= 18);
});
