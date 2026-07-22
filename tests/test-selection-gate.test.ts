import assert from "node:assert/strict";
import test from "node:test";

import { auditTestSelection, type DirectorSuite, type OAuthPortabilitySuite, type ReadonlyAppSuite, type RemediationSuite, type TestSelectionAuditInput, type TestSuiteCatalog } from "../scripts/testSelectionGate.js";

const baseRequiredRemediation: RemediationSuite[] = [
  { id: "sr1-provider", stage: "SR1", kind: "fault_injection", path: "tests/provider.test.ts", npm_script: "test:provider", ci_step: "Provider tests", case_name: "provider remediation case" },
  { id: "sr2-provider", stage: "SR2", kind: "boundary", path: "tests/provider.test.ts", npm_script: "test:provider", ci_step: "Provider tests", case_name: "provider remediation case" },
  { id: "sr3-provider", stage: "SR3", kind: "migration_copy", path: "tests/provider.test.ts", npm_script: "test:provider", ci_step: "Provider tests", case_name: "provider remediation case" },
  { id: "sr4-provider", stage: "SR4", kind: "boundary", path: "tests/provider.test.ts", npm_script: "test:provider", ci_step: "Provider tests", case_name: "provider remediation case" }
];

const baseCatalog: TestSuiteCatalog = {
  version: 2,
  groups: [
    { id: "selection", classification: "mandatory", paths: ["tests/test-selection-gate.test.ts"], npm_script: "test:selection-gate", ci_step: "Test selection gate" },
    { id: "provider", classification: "mandatory", paths: ["tests/provider.test.ts"], npm_script: "test:provider", ci_step: "Provider tests" }
  ],
  remediation_suites: structuredClone(baseRequiredRemediation),
  oauth_portability_suites: [],
  director_suites: [],
  readonly_app_suites: []
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
    required_remediation_suites: structuredClone(baseRequiredRemediation),
    required_oauth_portability_suites: [],
    required_director_suites: [],
    required_readonly_app_suites: [],
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

test("selection catalog accepts a Vitest configuration that selects a registered UI suite", () => {
  const input = fixture({
    source_files: ["tests/test-selection-gate.test.ts", "tests/provider.test.ts", "src/workbench-ui/App.test.tsx"],
    source_texts: {
      "tests/test-selection-gate.test.ts": 'test("selection gate case", () => {})',
      "tests/provider.test.ts": 'test("provider remediation case", () => {})',
      "src/workbench-ui/App.test.tsx": 'test("UI case", () => {})'
    },
    runner_config_texts: {
      "vitest.config.ts": 'export default { test: { include: ["src/workbench-ui/**/*.test.{ts,tsx}"] } }'
    },
    package_scripts: {
      "test:selection-gate": "node dist/tests/test-selection-gate.test.js",
      "test:provider": "node dist/tests/provider.test.js",
      "test:ui": "vitest run --config vitest.config.ts",
      test: "npm run test:selection-gate && npm run test:provider && npm run test:ui"
    },
    workflow_text: [
      "- name: Test selection gate",
      "  run: npm run test:selection-gate",
      "- name: Provider tests",
      "  run: npm run test:provider",
      "- name: UI tests",
      "  run: npm run test:ui"
    ].join("\n")
  });
  input.catalog.groups.push({
    id: "ui",
    classification: "mandatory",
    paths: ["src/workbench-ui/App.test.tsx"],
    npm_script: "test:ui",
    ci_step: "UI tests"
  });
  assert.deepEqual(auditTestSelection(input), []);
});

test("selection catalog rejects a Vitest configuration that omits a registered UI suite", () => {
  const input = fixture({
    source_files: ["tests/test-selection-gate.test.ts", "tests/provider.test.ts", "src/workbench-ui/App.test.tsx"],
    source_texts: {
      "tests/test-selection-gate.test.ts": 'test("selection gate case", () => {})',
      "tests/provider.test.ts": 'test("provider remediation case", () => {})',
      "src/workbench-ui/App.test.tsx": 'test("UI case", () => {})'
    },
    runner_config_texts: {
      "vitest.config.ts": 'export default { test: { include: ["src/other/**/*.test.ts"] } }'
    },
    package_scripts: {
      "test:selection-gate": "node dist/tests/test-selection-gate.test.js",
      "test:provider": "node dist/tests/provider.test.js",
      "test:ui": "vitest run --config vitest.config.ts",
      test: "npm run test:selection-gate && npm run test:provider && npm run test:ui"
    },
    workflow_text: [
      "- name: Test selection gate",
      "  run: npm run test:selection-gate",
      "- name: Provider tests",
      "  run: npm run test:provider",
      "- name: UI tests",
      "  run: npm run test:ui"
    ].join("\n")
  });
  input.catalog.groups.push({
    id: "ui",
    classification: "mandatory",
    paths: ["src/workbench-ui/App.test.tsx"],
    npm_script: "test:ui",
    ci_step: "UI tests"
  });
  assert.ok(auditTestSelection(input).includes("PACKAGE_SUITE_PATH_MISSING: test:ui -> src/workbench-ui/App.test.tsx"));
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

test("selection catalog requires declared readonly App security cases in their exact local and CI lane", () => {
  const suite: ReadonlyAppSuite = {
    id: "readonly-app-case",
    path: "tests/provider.test.ts",
    npm_script: "test:provider",
    ci_step: "Provider tests",
    case_name: "provider remediation case"
  };
  const valid = fixture({
    catalog: { ...structuredClone(baseCatalog), readonly_app_suites: [structuredClone(suite)] },
    required_readonly_app_suites: [suite]
  });
  assert.deepEqual(auditTestSelection(valid), []);
  valid.catalog.readonly_app_suites[0].case_name = "missing readonly app case";
  const errors = auditTestSelection(valid);
  assert.ok(errors.includes("READONLY_APP_SUITE_SIGNATURE_MISMATCH: readonly-app-case"));
  assert.ok(errors.includes("READONLY_APP_CASE_MISSING: readonly-app-case -> missing readonly app case"));
});

test("selection catalog rejects missing and non-array readonly App suite catalogs with a stable diagnostic", () => {
  const missing = fixture();
  delete (missing.catalog as unknown as { readonly_app_suites?: ReadonlyAppSuite[] }).readonly_app_suites;
  assert.deepEqual(auditTestSelection(missing), ["CATALOG_READONLY_APP_SUITES_INVALID"]);

  const malformed = fixture();
  (malformed.catalog as unknown as { readonly_app_suites: unknown }).readonly_app_suites = {};
  assert.deepEqual(auditTestSelection(malformed), ["CATALOG_READONLY_APP_SUITES_INVALID"]);
});

test("selection catalog requires declared Director security cases in their exact local and CI lane", () => {
  const suite: DirectorSuite = {
    id: "director-case",
    path: "tests/provider.test.ts",
    npm_script: "test:provider",
    ci_step: "Provider tests",
    case_name: "provider remediation case"
  };
  const valid = fixture({
    catalog: { ...structuredClone(baseCatalog), director_suites: [structuredClone(suite)] },
    required_director_suites: [suite]
  });
  assert.deepEqual(auditTestSelection(valid), []);
  valid.catalog.director_suites[0].case_name = "missing Director case";
  const errors = auditTestSelection(valid);
  assert.ok(errors.includes("DIRECTOR_SUITE_SIGNATURE_MISMATCH: director-case"));
  assert.ok(errors.includes("DIRECTOR_CASE_MISSING: director-case -> missing Director case"));
});

test("selection catalog rejects missing and non-array Director suite catalogs with a stable diagnostic", () => {
  const missing = fixture();
  delete (missing.catalog as unknown as { director_suites?: DirectorSuite[] }).director_suites;
  assert.deepEqual(auditTestSelection(missing), ["CATALOG_DIRECTOR_SUITES_INVALID"]);

  const malformed = fixture();
  (malformed.catalog as unknown as { director_suites: unknown }).director_suites = {};
  assert.deepEqual(auditTestSelection(malformed), ["CATALOG_DIRECTOR_SUITES_INVALID"]);
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
  assert.ok(auditTestSelection(mismatch).includes("REMEDIATION_LANE_MISMATCH: sr1-provider"));
});

test("selection catalog rejects a remediation row whose named regression case disappeared", () => {
  const input = fixture();
  input.source_texts["tests/provider.test.ts"] = 'test("different case", () => {})';
  assert.ok(auditTestSelection(input).includes("REMEDIATION_CASE_MISSING: sr1-provider -> provider remediation case"));
});

test("selection catalog rejects removal or signature drift of a concrete remediation suite", () => {
  const missing = fixture();
  missing.catalog.remediation_suites = missing.catalog.remediation_suites.filter((suite) => suite.id !== "sr4-provider");
  assert.ok(auditTestSelection(missing).includes("REMEDIATION_SUITE_MISSING: sr4-provider"));

  const drift = fixture();
  const suite = drift.catalog.remediation_suites.find((item) => item.id === "sr3-provider");
  assert.ok(suite);
  if (suite) suite.kind = "boundary";
  assert.ok(auditTestSelection(drift).includes("REMEDIATION_SUITE_SIGNATURE_MISMATCH: sr3-provider"));
});

test("selection catalog freezes the full remediation path, lane, and case signature", () => {
  for (const field of ["path", "npm_script", "ci_step", "case_name"] as const) {
    const input = fixture();
    input.catalog.remediation_suites[0][field] = `drifted-${field}`;
    assert.ok(auditTestSelection(input).includes("REMEDIATION_SUITE_SIGNATURE_MISMATCH: sr1-provider"), field);
  }
});

test("selection catalog treats commented, skipped, and todo remediation cases as missing", () => {
  const disabledSources = [
    '// test("provider remediation case", () => {})',
    'test("provider remediation case", { skip: true }, () => {})',
    'test("provider remediation case", { todo: true }, () => {})',
    'test.skip("provider remediation case", () => {})'
  ];
  for (const source of disabledSources) {
    const input = fixture();
    input.source_texts["tests/provider.test.ts"] = source;
    assert.ok(auditTestSelection(input).includes("REMEDIATION_CASE_MISSING: sr1-provider -> provider remediation case"), source);
  }
});

test("selection catalog freezes OAuth portability file, lane, CI step, and concrete safety case", () => {
  const required: OAuthPortabilitySuite = {
    id: "oauth-provider",
    path: "tests/provider.test.ts",
    npm_script: "test:provider",
    ci_step: "Provider tests",
    case_name: "provider remediation case"
  };
  const input = fixture({ required_oauth_portability_suites: [required] });
  input.catalog.oauth_portability_suites = [structuredClone(required)];
  assert.deepEqual(auditTestSelection(input), []);

  const missing = fixture({ required_oauth_portability_suites: [required] });
  assert.ok(auditTestSelection(missing).includes("OAUTH_PORTABILITY_SUITE_MISSING: oauth-provider"));

  const caseMissing = fixture({ required_oauth_portability_suites: [required] });
  caseMissing.catalog.oauth_portability_suites = [structuredClone(required)];
  caseMissing.source_texts["tests/provider.test.ts"] = 'test("different case", () => {})';
  assert.ok(auditTestSelection(caseMissing).includes("OAUTH_PORTABILITY_CASE_MISSING: oauth-provider -> provider remediation case"));

  for (const field of ["path", "npm_script", "ci_step", "case_name"] as const) {
    const drift = fixture({ required_oauth_portability_suites: [required] });
    drift.catalog.oauth_portability_suites = [structuredClone(required)];
    drift.catalog.oauth_portability_suites[0][field] = `drifted-${field}`;
    assert.ok(auditTestSelection(drift).includes("OAUTH_PORTABILITY_SUITE_SIGNATURE_MISMATCH: oauth-provider"), field);
  }

  const disabled = fixture({ required_oauth_portability_suites: [required] });
  disabled.catalog.oauth_portability_suites = [structuredClone(required)];
  disabled.source_texts["tests/provider.test.ts"] = 'test("provider remediation case", { skip: true }, () => {})';
  assert.ok(auditTestSelection(disabled).includes("OAUTH_PORTABILITY_CASE_MISSING: oauth-provider -> provider remediation case"));

  const malformed = fixture();
  delete (malformed.catalog as unknown as { oauth_portability_suites?: OAuthPortabilitySuite[] }).oauth_portability_suites;
  assert.deepEqual(auditTestSelection(malformed), ["CATALOG_OAUTH_PORTABILITY_SUITES_INVALID"]);
});
