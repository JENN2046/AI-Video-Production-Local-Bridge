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

export interface TestSuiteCatalog {
  version: 1;
  groups: TestSuiteGroup[];
  required_commands?: RequiredCommand[];
}

export interface TestSelectionAuditInput {
  catalog: TestSuiteCatalog;
  source_files: string[];
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

export function auditTestSelection(input: TestSelectionAuditInput): string[] {
  const errors: string[] = [];
  if (input.catalog.version !== 1) return ["CATALOG_VERSION_INVALID"];
  if (!Array.isArray(input.catalog.groups)) return ["CATALOG_GROUPS_INVALID"];

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

  return errors;
}
