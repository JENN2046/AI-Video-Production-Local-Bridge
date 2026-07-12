import assert from "node:assert/strict";
import test from "node:test";

import { auditTestSelection, type TestSelectionAuditInput, type TestSuiteCatalog } from "../scripts/testSelectionGate.js";

const baseCatalog: TestSuiteCatalog = {
  version: 1,
  groups: [
    { id: "selection", classification: "mandatory", paths: ["tests/test-selection-gate.test.ts"], npm_script: "test:selection-gate", ci_step: "Test selection gate" },
    { id: "provider", classification: "mandatory", paths: ["tests/provider.test.ts"], npm_script: "test:provider", ci_step: "Provider tests" }
  ]
};

function fixture(overrides: Partial<TestSelectionAuditInput> = {}): TestSelectionAuditInput {
  return {
    catalog: structuredClone(baseCatalog),
    source_files: ["tests/test-selection-gate.test.ts", "tests/provider.test.ts"],
    package_scripts: {
      "test:selection-gate": "node gate.js",
      "test:provider": "node provider.js",
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
