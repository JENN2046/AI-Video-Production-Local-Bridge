import ts from "typescript";

export type TestSuiteClassification = "mandatory" | "historical_non_runtime";

export interface TestSuiteGroup {
  id: string;
  classification: TestSuiteClassification;
  paths: string[];
  npm_script?: string;
  ci_step?: string;
  rationale?: string;
  active_entrypoint?: boolean;
  evidence?: string;
}

export interface RequiredCommand {
  npm_script: string;
  ci_step: string;
}

export type RemediationStage = "SR1" | "SR2" | "SR3" | "SR4";
export type RemediationKind = "fault_injection" | "migration_copy" | "boundary";

export interface RemediationSuite {
  id: string;
  stage: RemediationStage;
  kind: RemediationKind;
  path: string;
  npm_script: string;
  ci_step: string;
  case_name: string;
}

export interface OAuthPortabilitySuite {
  id: string;
  path: string;
  npm_script: string;
  ci_step: string;
  case_name: string;
}

export interface ReadonlyAppSuite extends OAuthPortabilitySuite {}

export const REQUIRED_READONLY_APP_SUITES: ReadonlyArray<ReadonlyAppSuite> = [
  { id: "readonly-projection-ledger-gate", path: "tests/webgpt-cloud-projection.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "readonly projection requires migration 0008 and never upgrades an older database" },
  { id: "readonly-projection-dto-parity", path: "tests/webgpt-cloud-projection.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "SQLite and Snapshot readonly adapters preserve six-tool DTO parity and database zero-write manifest" },
  { id: "readonly-snapshot-fingerprint", path: "tests/webgpt-cloud-projection.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "snapshot fingerprint uses deterministic JCS input and server time remains authoritative" },
  { id: "readonly-signed-snapshot-transport", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "signed snapshot transport rejects tampering and atomically replaces only newer snapshots" },
  { id: "readonly-remote-no-database", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote runtime module graph excludes SQLite and local database adapter entrypoints" },
  { id: "readonly-remote-oauth-tools", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote OAuth challenges, signed publish, six readonly tools, and readiness stay fail closed" },
  { id: "readonly-remote-publish-limits", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote runtime rejects oversized and rate-limited publish attempts without replacing the snapshot" },
  { id: "readonly-remote-expiry", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote snapshot expiry makes readiness and data tools fail closed while health stays live" },
  { id: "readonly-app-resource-contract", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly MCP App contract freezes one render tool, six data tools, and the v1 resource" },
  { id: "readonly-app-shell-disclosure", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "render contract accepts only low-disclosure shell state and initial intent" }
];

export const REQUIRED_OAUTH_PORTABILITY_SUITES: ReadonlyArray<OAuthPortabilitySuite> = [
  { id: "oauth-selected-provider-capability", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider capability rejects missing PKCE, public-client, audience, and scope guarantees" },
  { id: "oauth-selected-provider-jwt", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider JWT verifies signature, issuer, audience, expiry, scope claims, and key rotation" },
  { id: "oauth-selected-provider-authorization", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider authorization distinguishes unregistered, owner, viewer, revoked, and cross-project access" },
  { id: "oauth-selected-provider-six-tools", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider six readonly tools preserve the complete database logical manifest" },
  { id: "oauth-fakeip-doh-boundary", path: "tests/webgpt-v4-oauth-discovery.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "benchmark fake-IP recovery uses bounded public DoH without weakening private-address rejection" },
  { id: "oauth-fakeip-jwks-pinning", path: "tests/webgpt-v4-server.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "server authentication carries benchmark fake-IP recovery through remote JWKS pinning" }
];

export const REQUIRED_REMEDIATION_SUITES: ReadonlyArray<RemediationSuite> = [
  { id: "sr1-artifact-blob-faults", stage: "SR1", kind: "fault_injection", path: "tests/artifact-blob-boundary.test.ts", npm_script: "test:foundation-boundaries", ci_step: "Foundation and media boundary tests", case_name: "cross-SHOT reuse and stale concurrent binding attempts fail closed" },
  { id: "sr1-legacy-migration-copy", stage: "SR1", kind: "migration_copy", path: "tests/artifact-blob-boundary.test.ts", npm_script: "test:foundation-boundaries", ci_step: "Foundation and media boundary tests", case_name: "v2-4 migration derives Blob facts from local bytes and fails closed on structured drift" },
  { id: "sr2-provider-contract-faults", stage: "SR2", kind: "fault_injection", path: "tests/provider-capability-contract.test.ts", npm_script: "test:provider-boundaries", ci_step: "Provider and transfer safety tests", case_name: "Provider capability key rejects model, duration, resolution, and aspect drift" },
  { id: "sr2-worker-outcome-boundary", stage: "SR2", kind: "boundary", path: "tests/workbench-v2-domain.test.ts", npm_script: "test:v2", ci_step: "Workbench V2 domain tests", case_name: "provider task persistence failure enters manual reconciliation without losing the paid task ID" },
  { id: "sr3-activation-recovery-faults", stage: "SR3", kind: "fault_injection", path: "tests/media-activation-integrity.test.ts", npm_script: "test:foundation-boundaries", ci_step: "Foundation and media boundary tests", case_name: "recovery removes an activation-owned duplicate final after Blob dedupe" },
  { id: "sr3-integrity-migration-copy", stage: "SR3", kind: "migration_copy", path: "tests/database-governance.test.ts", npm_script: "test:db", ci_step: "Database and authorization governance tests", case_name: "migration 0006 backfills active legacy Artifact facts from the verified Blob" },
  { id: "sr4-reference-readiness-faults", stage: "SR4", kind: "fault_injection", path: "tests/workbench-v2-domain.test.ts", npm_script: "test:v2", ci_step: "Workbench V2 domain tests", case_name: "generation preflight rejects a storyboard Artifact bound to another SHOT" },
  { id: "sr4-webgpt-cross-shot-boundary", stage: "SR4", kind: "boundary", path: "tests/webgpt-v4-domain.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "review and delivery guards reject same-project wrong-SHOT and tampered artifacts" }
];

export interface TestSuiteCatalog {
  version: 2;
  groups: TestSuiteGroup[];
  required_commands?: RequiredCommand[];
  remediation_suites: RemediationSuite[];
  oauth_portability_suites: OAuthPortabilitySuite[];
  readonly_app_suites: ReadonlyAppSuite[];
}

export interface TestSelectionAuditInput {
  catalog: TestSuiteCatalog;
  source_files: string[];
  source_texts: Record<string, string>;
  package_scripts: Record<string, string>;
  workflow_text: string;
  required_remediation_suites?: ReadonlyArray<RemediationSuite>;
  required_oauth_portability_suites?: ReadonlyArray<OAuthPortabilitySuite>;
  required_readonly_app_suites?: ReadonlyArray<ReadonlyAppSuite>;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function npmRuns(command: string): Set<string> {
  const result = new Set<string>();
  for (const segment of command.split("&&").map((item) => item.trim())) {
    const match = segment.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)(?:\s+--(?:\s+.*)?)?$/);
    if (match) result.add(match[1]);
  }
  return result;
}

function workflowNpmSteps(workflow: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let currentName = "";
  for (const line of workflow.split(/\r?\n/)) {
    const name = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (name) {
      currentName = name[1].replace(/^['"]|['"]$/g, "");
      continue;
    }
    const run = line.match(/^\s*run:\s*npm\s+run\s+([A-Za-z0-9:_-]+)\s*$/);
    if (!run) continue;
    const names = result.get(run[1]) ?? new Set<string>();
    names.add(currentName);
    result.set(run[1], names);
  }
  return result;
}

function expectedRunnerPath(sourcePath: string): string {
  const normalized = normalizePath(sourcePath);
  if (normalized.startsWith("tests/browser/")) return normalized;
  return `dist/${normalized.replace(/\.ts$/, ".js")}`;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function packageScriptSelectsPath(command: string, sourcePath: string): boolean {
  const unsupportedControlOperators = command.replaceAll("&&", "");
  if (/[;|&\r\n]/.test(unsupportedControlOperators)) return false;
  const expected = expectedRunnerPath(sourcePath);
  return command.split("&&").some((rawSegment) => {
    const segment = rawSegment.trim();
    const tokens = segment
      .split(/\s+/)
      .map((token) => token.replace(/^["']|["',]$/g, ""))
      .filter(Boolean);
    const pathIndex = tokens.findIndex((token) => globMatches(normalizePath(token), expected));
    if (pathIndex < 0) return false;
    const isDirectNodeRunner = tokens[0] === "node" && pathIndex === 1;
    const isNodeTestRunner = tokens[0] === "node" && tokens[1] === "--test" && pathIndex >= 2;
    const isIsolatedNodeRunner = tokens[0] === "node" && /run-isolated-tests\.(?:js|mjs)$/.test(tokens[1] ?? "") && pathIndex >= 2;
    const playwrightOffset = tokens[0] === "npx" ? 1 : 0;
    const isPlaywrightRunner = tokens[playwrightOffset] === "playwright"
      && tokens[playwrightOffset + 1] === "test"
      && pathIndex > playwrightOffset + 1;
    return isDirectNodeRunner || isNodeTestRunner || isIsolatedNodeRunner || isPlaywrightRunner;
  });
}

function sourceContainsNamedCase(source: string, caseName: string): boolean {
  const sourceFile = ts.createSourceFile("selection-gate-case.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === "test" || node.expression.text === "it")) {
      const name = node.arguments[0];
      const nameMatches = name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && name.text === caseName;
      if (nameMatches) {
        const options = node.arguments[1];
        const disabled = options && ts.isObjectLiteralExpression(options) && options.properties.some((property) => {
          if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "skip" || property.name.text === "todo";
          if (!ts.isPropertyAssignment(property)) return false;
          const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
          if (propertyName !== "skip" && propertyName !== "todo") return false;
          return property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
        });
        if (!disabled) found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function auditTestSelection(input: TestSelectionAuditInput): string[] {
  const errors: string[] = [];
  if (input.catalog.version !== 2) return ["CATALOG_VERSION_INVALID"];
  if (!Array.isArray(input.catalog.groups)) return ["CATALOG_GROUPS_INVALID"];
  if (!Array.isArray(input.catalog.remediation_suites)) return ["CATALOG_REMEDIATION_SUITES_INVALID"];
  if (!Array.isArray(input.catalog.oauth_portability_suites)) return ["CATALOG_OAUTH_PORTABILITY_SUITES_INVALID"];
  if (!Array.isArray(input.catalog.readonly_app_suites)) return ["CATALOG_READONLY_APP_SUITES_INVALID"];

  const sourceFiles = new Set(input.source_files.map(normalizePath));
  const catalogPaths = new Map<string, string>();
  const requirements: RequiredCommand[] = [...(input.catalog.required_commands ?? [])];

  for (const group of input.catalog.groups) {
    if (!group.id?.trim() || !Array.isArray(group.paths) || group.paths.length === 0) {
      errors.push(`CATALOG_GROUP_INVALID: ${group.id || "<missing>"}`);
      continue;
    }
    if (group.classification !== "mandatory" && group.classification !== "historical_non_runtime") {
      errors.push(`CATALOG_CLASSIFICATION_INVALID: ${group.id}`);
      continue;
    }
    if (group.classification === "historical_non_runtime") {
      if (!group.rationale || group.rationale.trim().length < 20) errors.push(`CATALOG_HISTORICAL_RATIONALE_REQUIRED: ${group.id}`);
      if (group.active_entrypoint !== false) errors.push(`CATALOG_HISTORICAL_ACTIVE_ENTRYPOINT_REQUIRED: ${group.id}`);
      if (!group.evidence || group.evidence.trim().length < 10) errors.push(`CATALOG_HISTORICAL_EVIDENCE_REQUIRED: ${group.id}`);
      if (group.npm_script || group.ci_step) errors.push(`CATALOG_HISTORICAL_GATE_FORBIDDEN: ${group.id}`);
    } else if (!group.npm_script || !group.ci_step) {
      errors.push(`CATALOG_MANDATORY_GATE_REQUIRED: ${group.id}`);
    } else {
      requirements.push({ npm_script: group.npm_script, ci_step: group.ci_step });
    }

    for (const rawPath of group.paths) {
      const path = normalizePath(rawPath);
      const owner = catalogPaths.get(path);
      if (owner) errors.push(`CATALOG_DUPLICATE: ${path} (${owner}, ${group.id})`);
      else catalogPaths.set(path, group.id);
    }
  }

  for (const path of sourceFiles) {
    if (!catalogPaths.has(path)) errors.push(`CATALOG_UNCLASSIFIED: ${path}`);
  }
  for (const path of catalogPaths.keys()) {
    if (!sourceFiles.has(path)) errors.push(`CATALOG_FILE_MISSING: ${path}`);
  }

  const remediationIds = new Set<string>();
  const remediationStages = new Set<RemediationStage>();
  const remediationKinds = new Set<RemediationKind>();
  for (const suite of input.catalog.remediation_suites) {
    const path = normalizePath(suite.path ?? "");
    if (!suite.id?.trim() || remediationIds.has(suite.id)) {
      errors.push(`REMEDIATION_SUITE_ID_INVALID: ${suite.id || "<missing>"}`);
    } else {
      remediationIds.add(suite.id);
    }
    if (!["SR1", "SR2", "SR3", "SR4"].includes(suite.stage)) {
      errors.push(`REMEDIATION_STAGE_INVALID: ${suite.id}`);
    } else {
      remediationStages.add(suite.stage);
    }
    if (!["fault_injection", "migration_copy", "boundary"].includes(suite.kind)) {
      errors.push(`REMEDIATION_KIND_INVALID: ${suite.id}`);
    } else {
      remediationKinds.add(suite.kind);
    }
    const ownerId = catalogPaths.get(path);
    const owner = input.catalog.groups.find((group) => group.id === ownerId);
    if (!owner || owner.classification !== "mandatory") {
      errors.push(`REMEDIATION_SUITE_NOT_MANDATORY: ${suite.id} -> ${path || "<missing>"}`);
    } else if (owner.npm_script !== suite.npm_script || owner.ci_step !== suite.ci_step) {
      errors.push(`REMEDIATION_LANE_MISMATCH: ${suite.id}`);
    }
    if (!suite.case_name?.trim() || !sourceContainsNamedCase(input.source_texts[path] ?? "", suite.case_name)) {
      errors.push(`REMEDIATION_CASE_MISSING: ${suite.id} -> ${suite.case_name || "<missing>"}`);
    }
  }
  const requiredSuites = input.required_remediation_suites ?? REQUIRED_REMEDIATION_SUITES;
  const requiredRemediation = new Map(requiredSuites.map((suite) => [suite.id, suite]));
  const actualRemediation = new Map(input.catalog.remediation_suites.map((suite) => [suite.id, suite]));
  for (const required of requiredSuites) {
    const actual = actualRemediation.get(required.id);
    if (!actual) {
      errors.push(`REMEDIATION_SUITE_MISSING: ${required.id}`);
    } else if (actual.stage !== required.stage
      || actual.kind !== required.kind
      || normalizePath(actual.path) !== normalizePath(required.path)
      || actual.npm_script !== required.npm_script
      || actual.ci_step !== required.ci_step
      || actual.case_name !== required.case_name) {
      errors.push(`REMEDIATION_SUITE_SIGNATURE_MISMATCH: ${required.id}`);
    }
  }
  for (const suite of input.catalog.remediation_suites) {
    if (!requiredRemediation.has(suite.id)) errors.push(`REMEDIATION_SUITE_UNDECLARED: ${suite.id}`);
  }
  for (const stage of ["SR1", "SR2", "SR3", "SR4"] as const) {
    if (!remediationStages.has(stage)) errors.push(`REMEDIATION_STAGE_MISSING: ${stage}`);
  }
  for (const kind of ["fault_injection", "migration_copy"] as const) {
    if (!remediationKinds.has(kind)) errors.push(`REMEDIATION_KIND_MISSING: ${kind}`);
  }

  const requiredOauthSuites = input.required_oauth_portability_suites ?? REQUIRED_OAUTH_PORTABILITY_SUITES;
  const requiredOauth = new Map(requiredOauthSuites.map((suite) => [suite.id, suite]));
  const actualOauth = new Map(input.catalog.oauth_portability_suites.map((suite) => [suite.id, suite]));
  if (actualOauth.size !== input.catalog.oauth_portability_suites.length) errors.push("OAUTH_PORTABILITY_SUITE_ID_DUPLICATE");
  for (const required of requiredOauthSuites) {
    const actual = actualOauth.get(required.id);
    if (!actual) {
      errors.push(`OAUTH_PORTABILITY_SUITE_MISSING: ${required.id}`);
      continue;
    }
    if (normalizePath(actual.path) !== normalizePath(required.path)
      || actual.npm_script !== required.npm_script
      || actual.ci_step !== required.ci_step
      || actual.case_name !== required.case_name) {
      errors.push(`OAUTH_PORTABILITY_SUITE_SIGNATURE_MISMATCH: ${required.id}`);
    }
  }
  for (const suite of input.catalog.oauth_portability_suites) {
    if (!requiredOauth.has(suite.id)) errors.push(`OAUTH_PORTABILITY_SUITE_UNDECLARED: ${suite.id}`);
    const path = normalizePath(suite.path ?? "");
    const ownerId = catalogPaths.get(path);
    const owner = input.catalog.groups.find((group) => group.id === ownerId);
    if (!owner || owner.classification !== "mandatory") {
      errors.push(`OAUTH_PORTABILITY_SUITE_NOT_MANDATORY: ${suite.id} -> ${path || "<missing>"}`);
    } else if (owner.npm_script !== suite.npm_script || owner.ci_step !== suite.ci_step) {
      errors.push(`OAUTH_PORTABILITY_LANE_MISMATCH: ${suite.id}`);
    }
    if (!suite.case_name?.trim() || !sourceContainsNamedCase(input.source_texts[path] ?? "", suite.case_name)) {
      errors.push(`OAUTH_PORTABILITY_CASE_MISSING: ${suite.id} -> ${suite.case_name || "<missing>"}`);
    }
  }

  const requiredReadonlyAppSuites = input.required_readonly_app_suites ?? REQUIRED_READONLY_APP_SUITES;
  const requiredReadonlyApps = new Map(requiredReadonlyAppSuites.map((suite) => [suite.id, suite]));
  const actualReadonlyApps = new Map(input.catalog.readonly_app_suites.map((suite) => [suite.id, suite]));
  if (actualReadonlyApps.size !== input.catalog.readonly_app_suites.length) errors.push("READONLY_APP_SUITE_ID_DUPLICATE");
  for (const required of requiredReadonlyAppSuites) {
    const actual = actualReadonlyApps.get(required.id);
    if (!actual) {
      errors.push(`READONLY_APP_SUITE_MISSING: ${required.id}`);
      continue;
    }
    if (normalizePath(actual.path) !== normalizePath(required.path)
      || actual.npm_script !== required.npm_script
      || actual.ci_step !== required.ci_step
      || actual.case_name !== required.case_name) {
      errors.push(`READONLY_APP_SUITE_SIGNATURE_MISMATCH: ${required.id}`);
    }
  }
  for (const suite of input.catalog.readonly_app_suites) {
    if (!requiredReadonlyApps.has(suite.id)) errors.push(`READONLY_APP_SUITE_UNDECLARED: ${suite.id}`);
    const path = normalizePath(suite.path ?? "");
    const ownerId = catalogPaths.get(path);
    const owner = input.catalog.groups.find((group) => group.id === ownerId);
    if (!owner || owner.classification !== "mandatory") {
      errors.push(`READONLY_APP_SUITE_NOT_MANDATORY: ${suite.id} -> ${path || "<missing>"}`);
    } else if (owner.npm_script !== suite.npm_script || owner.ci_step !== suite.ci_step) {
      errors.push(`READONLY_APP_SUITE_LANE_MISMATCH: ${suite.id}`);
    }
    if (!suite.case_name?.trim() || !sourceContainsNamedCase(input.source_texts[path] ?? "", suite.case_name)) {
      errors.push(`READONLY_APP_CASE_MISSING: ${suite.id} -> ${suite.case_name || "<missing>"}`);
    }
  }

  const canonicalRuns = npmRuns(input.package_scripts.test ?? "");
  const workflowSteps = workflowNpmSteps(input.workflow_text);
  const uniqueRequirements = new Map<string, RequiredCommand>();
  for (const requirement of requirements) {
    const existing = uniqueRequirements.get(requirement.npm_script);
    if (existing && existing.ci_step !== requirement.ci_step) {
      errors.push(`CATALOG_REQUIREMENT_CONFLICT: ${requirement.npm_script} (${existing.ci_step}, ${requirement.ci_step})`);
    } else {
      uniqueRequirements.set(requirement.npm_script, requirement);
    }
  }
  for (const requirement of uniqueRequirements.values()) {
    if (!input.package_scripts[requirement.npm_script]) errors.push(`PACKAGE_SCRIPT_MISSING: ${requirement.npm_script}`);
    if (!canonicalRuns.has(requirement.npm_script)) errors.push(`LOCAL_GATE_MISSING: ${requirement.npm_script}`);
    const names = workflowSteps.get(requirement.npm_script);
    if (!names) errors.push(`CI_GATE_MISSING: ${requirement.npm_script}`);
    else if (!names.has(requirement.ci_step)) errors.push(`CI_STEP_MISMATCH: ${requirement.npm_script} expected ${requirement.ci_step}`);
  }

  for (const group of input.catalog.groups.filter((item) => item.classification === "mandatory")) {
    const command = input.package_scripts[group.npm_script ?? ""] ?? "";
    for (const path of group.paths) {
      if (!packageScriptSelectsPath(command, path)) {
        errors.push(`PACKAGE_SUITE_PATH_MISSING: ${group.npm_script} -> ${normalizePath(path)}`);
      }
    }
  }

  return errors;
}
