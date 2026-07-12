import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { auditTestSelection, type TestSuiteCatalog } from "./testSelectionGate.js";

const workspaceRoot = resolve(process.cwd());

function discoverTests(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discoverTests(path));
    else if (entry.isFile() && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts"))) {
      files.push(relative(workspaceRoot, path).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

const catalog = JSON.parse(readFileSync(join(workspaceRoot, "tests", "test-suite-catalog.json"), "utf8")) as TestSuiteCatalog;
const packageJson = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const workflowText = readFileSync(join(workspaceRoot, ".github", "workflows", "windows-ci.yml"), "utf8");
const sourceFiles = discoverTests(join(workspaceRoot, "tests"));
const errors = auditTestSelection({ catalog, source_files: sourceFiles, package_scripts: packageJson.scripts ?? {}, workflow_text: workflowText });

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  const mandatoryFiles = catalog.groups
    .filter((group) => group.classification === "mandatory")
    .reduce((count, group) => count + group.paths.length, 0);
  process.stdout.write(`TEST_SELECTION_GATE_PASS files=${sourceFiles.length} mandatory=${mandatoryFiles}\n`);
}
