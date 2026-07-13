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

export const REQUIRED_REMEDIATION_SUITES: ReadonlyArray<Pick<RemediationSuite, "id" | "stage" | "kind">> = [
  { id: "sr1-artifact-blob-faults", stage: "SR1", kind: "fault_injection" },
  { id: "sr1-legacy-migration-copy", stage: "SR1", kind: "migration_copy" },
  { id: "sr2-provider-contract-faults", stage: "SR2", kind: "fault_injection" },
  { id: "sr2-worker-outcome-boundary", stage: "SR2", kind: "boundary" },
  { id: "sr3-activation-recovery-faults", stage: "SR3", kind: "fault_injection" },
  { id: "sr3-integrity-migration-copy", stage: "SR3", kind: "migration_copy" },
  { id: "sr4-reference-readiness-faults", stage: "SR4", kind: "fault_injection" },
  { id: "sr4-webgpt-cross-shot-boundary", stage: "SR4", kind: "boundary" }
];

export interface TestSuiteCatalog {
  version: 2;
  groups: TestSuiteGroup[];
  required_commands?: RequiredCommand[];
  remediation_suites: RemediationSuite[];
}

export interface TestSelectionAuditInput {
  catalog: TestSuiteCatalog;
  source_files: string[];
  source_texts: Record<string, string>;
  package_scripts: Record<string, string>;
  workflow_text: string;
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
  const escaped = caseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:test|it)\\s*\\(\\s*["'\`]${escaped}["'\`]`).test(source);
}

export function auditTestSelection(input: TestSelectionAuditInput): string[] {
  const errors: string[] = [];
  if (input.catalog.version !== 2) return ["CATALOG_VERSION_INVALID"];
  if (!Array.isArray(input.catalog.groups)) return ["CATALOG_GROUPS_INVALID"];
  if (!Array.isArray(input.catalog.remediation_suites)) return ["CATALOG_REMEDIATION_SUITES_INVALID"];

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
  const requiredRemediation = new Map(REQUIRED_REMEDIATION_SUITES.map((suite) => [suite.id, suite]));
  const actualRemediation = new Map(input.catalog.remediation_suites.map((suite) => [suite.id, suite]));
  for (const required of REQUIRED_REMEDIATION_SUITES) {
    const actual = actualRemediation.get(required.id);
    if (!actual) {
      errors.push(`REMEDIATION_SUITE_MISSING: ${required.id}`);
    } else if (actual.stage !== required.stage || actual.kind !== required.kind) {
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
