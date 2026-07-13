import assert from "node:assert/strict";
import test from "node:test";

import { auditTestSelection, REQUIRED_REMEDIATION_SUITES, type TestSelectionAuditInput, type TestSuiteCatalog } from "../scripts/testSelectionGate.js";

const baseCatalog: TestSuiteCatalog = {
  version: 2,
  groups: [
    { id: "selection", classification: "mandatory", paths: ["tests/test-selection-gate.test.ts"], npm_script: "test:selection-gate", ci_step: "Test selection gate" },
    { id: "provider", classification: "mandatory", paths: ["tests/provider.test.ts"], npm_script: "test:provider", ci_step: "Provider tests" }
  ],
  remediation_suites: REQUIRED_REMEDIATION_SUITES.map((suite) => ({
    ...suite,
    path: "tests/provider.test.ts",
    npm_script: "test:provider",
    ci_step: "Provider tests",
    case_name: "provider remediation case"
  }))
};

function fixture(overrides: Partial<TestSelectionAuditInput> = {}): TestSelectionAuditInput {
  return {
    catalog: structuredClone(baseCatalog),
    source_files: ["tests/test-selection-gate.test.ts", "tests/provider.test.ts"],
    source_texts: {
      "tests/test-selection-gate.test.ts": 'test("selection gate case", () => {})',
      "tests/provider.test.ts": 'test("provider remediation case", () => {})'
    },
    package_scripts: {
      "test:selection-gate": "node dist/tests/test-selection-gate.test.js",
      "test:provider": "node dist/tests/provider.test.js",
      test: "npm run test:selection-gate && npm run test:provider"
    },
    workflow_text: [
      "- name: Test selection gate",
      "  run: npm run test:selection-gate",
      "- name: Provider tests",
      "  run: npm run test:provider"
    ].join("\n"),
    ...overrides
  };
}

test("selection catalog accepts complete independent local and CI gates", () => {
  assert.deepEqual(auditTestSelection(fixture()), []);
});

test("selection catalog rejects a suite missing from the canonical local gate", () => {
  const input = fixture();
  input.package_scripts.test = "npm run test:selection-gate";
  assert.ok(auditTestSelection(input).includes("LOCAL_GATE_MISSING: test:provider"));
});

test("selection catalog rejects a mandatory suite omitted by its selected npm lane", () => {
  const input = fixture();
  input.package_scripts["test:provider"] = "node dist/tests/different-provider.test.js";
  assert.ok(auditTestSelection(input).includes("PACKAGE_SUITE_PATH_MISSING: test:provider -> tests/provider.test.ts"));
});

test("selection catalog accepts a compiled test glob that selects the registered suite", () => {
  const input = fixture();
  input.package_scripts["test:provider"] = "node dist/scripts/run-isolated-tests.js dist/tests/provider*.test.js";
  assert.deepEqual(auditTestSelection(input), []);
});

test("selection catalog does not accept a test path that is only echoed", () => {
  const input = fixture();
  input.package_scripts["test:provider"] = "echo dist/tests/provider.test.js";
  assert.ok(auditTestSelection(input).includes("PACKAGE_SUITE_PATH_MISSING: test:provider -> tests/provider.test.ts"));
});

test("selection catalog rejects mandatory runners whose failure is masked by shell control operators", () => {
  for (const suffix of ["|| true", "; exit 0", "| Out-Null", "& echo masked"]) {
    const input = fixture();
    input.package_scripts["test:provider"] = `node dist/tests/provider.test.js ${suffix}`;
    assert.ok(
      auditTestSelection(input).includes("PACKAGE_SUITE_PATH_MISSING: test:provider -> tests/provider.test.ts"),
      suffix
    );
  }
});

test("selection catalog does not accept an echoed npm command as local execution", () => {
  const input = fixture();
  input.package_scripts.test = "npm run test:selection-gate && echo npm run test:provider";
  assert.ok(auditTestSelection(input).includes("LOCAL_GATE_MISSING: test:provider"));
});

test("selection catalog rejects a suite missing from the Windows CI gate", () => {
  const input = fixture({ workflow_text: "- name: Test selection gate\n  run: npm run test:selection-gate" });
  assert.ok(auditTestSelection(input).includes("CI_GATE_MISSING: test:provider"));
});

test("selection catalog rejects unclassified, duplicate, and missing files", () => {
  const input = fixture({ source_files: ["tests/test-selection-gate.test.ts", "tests/unclassified.test.ts"] });
  input.catalog.groups.push({
    id: "duplicate",
    classification: "mandatory",
    paths: ["tests/test-selection-gate.test.ts", "tests/missing.test.ts"],
    npm_script: "test:selection-gate",
    ci_step: "Test selection gate"
  });
  const errors = auditTestSelection(input);
  assert.ok(errors.some((error) => error.startsWith("CATALOG_DUPLICATE:")));
  assert.ok(errors.includes("CATALOG_UNCLASSIFIED: tests/unclassified.test.ts"));
  assert.ok(errors.includes("CATALOG_FILE_MISSING: tests/provider.test.ts"));
  assert.ok(errors.includes("CATALOG_FILE_MISSING: tests/missing.test.ts"));
});

test("historical classification requires a rationale and cannot claim active gates", () => {
  const catalog = structuredClone(baseCatalog);
  catalog.groups[1] = {
    id: "history",
    classification: "historical_non_runtime",
    paths: ["tests/provider.test.ts"],
    npm_script: "test:provider",
    ci_step: "Provider tests",
    rationale: "short"
  };
  const errors = auditTestSelection(fixture({ catalog }));
  assert.ok(errors.includes("CATALOG_HISTORICAL_RATIONALE_REQUIRED: history"));
  assert.ok(errors.includes("CATALOG_HISTORICAL_ACTIVE_ENTRYPOINT_REQUIRED: history"));
  assert.ok(errors.includes("CATALOG_HISTORICAL_EVIDENCE_REQUIRED: history"));
  assert.ok(errors.includes("CATALOG_HISTORICAL_GATE_FORBIDDEN: history"));
});

test("selection catalog rejects conflicting CI mappings for one npm script", () => {
  const input = fixture();
  input.catalog.required_commands = [{ npm_script: "test:provider", ci_step: "Different provider step" }];
  assert.ok(auditTestSelection(input).some((error) => error.startsWith("CATALOG_REQUIREMENT_CONFLICT: test:provider")));
});

test("selection catalog requires every remediation stage and a valid mandatory lane", () => {
  const input = fixture();
  input.catalog.remediation_suites = input.catalog.remediation_suites.filter((suite) => suite.stage !== "SR4");
  assert.ok(auditTestSelection(input).includes("REMEDIATION_STAGE_MISSING: SR4"));

  const mismatch = fixture();
  mismatch.catalog.remediation_suites[0].ci_step = "Wrong provider step";
  assert.ok(auditTestSelection(mismatch).includes("REMEDIATION_LANE_MISMATCH: sr1-artifact-blob-faults"));
});

test("selection catalog rejects a remediation row whose named regression case disappeared", () => {
  const input = fixture();
  input.source_texts["tests/provider.test.ts"] = 'test("different case", () => {})';
  assert.ok(auditTestSelection(input).includes("REMEDIATION_CASE_MISSING: sr1-artifact-blob-faults -> provider remediation case"));
});

test("selection catalog rejects removal or signature drift of a concrete remediation suite", () => {
  const missing = fixture();
  missing.catalog.remediation_suites = missing.catalog.remediation_suites.filter((suite) => suite.id !== "sr4-reference-readiness-faults");
  assert.ok(auditTestSelection(missing).includes("REMEDIATION_SUITE_MISSING: sr4-reference-readiness-faults"));

  const drift = fixture();
  const suite = drift.catalog.remediation_suites.find((item) => item.id === "sr3-integrity-migration-copy");
  assert.ok(suite);
  if (suite) suite.kind = "boundary";
  assert.ok(auditTestSelection(drift).includes("REMEDIATION_SUITE_SIGNATURE_MISMATCH: sr3-integrity-migration-copy"));
});
