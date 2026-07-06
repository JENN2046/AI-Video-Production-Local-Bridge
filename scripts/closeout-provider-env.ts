import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, maskSecret, paths } from "../src/index.js";

interface EnvCheckResult {
  result?: string;
  no_network_call?: boolean;
  env_file?: {
    env_file_found?: boolean;
    disabled?: boolean;
    loaded_keys?: string[];
    skipped_existing_keys?: string[];
    ignored_keys?: string[];
    parse_errors?: string[];
  };
}

interface PreflightResult {
  result?: string;
  network_call_attempted?: boolean;
  env_file?: {
    env_file_found?: boolean;
    disabled?: boolean;
    loaded_keys?: string[];
    skipped_existing_keys?: string[];
    ignored_keys?: string[];
    parse_errors?: string[];
  };
}

interface SecretScanResult {
  result?: string;
  git_tracked_files?: string;
  reports?: string;
  sqlite_or_runtime_state?: string;
}

function runCommand(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    cwd: paths.workspaceRoot,
    shell: true,
    stdio: "inherit",
    windowsHide: true
  });
  return typeof result.status === "number" ? result.status : 1;
}

function readJson<T>(filename: string): T | null {
  const path = join(paths.reportsRoot, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function gitCheckIgnore(path: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", path], {
    cwd: paths.workspaceRoot,
    shell: false,
    windowsHide: true
  });
  return result.status === 0;
}

function gitTrackedForbidden(): boolean {
  const result = spawnSync("git", ["ls-files", ".env", ".env.local", "credentials", "secrets", "state-private"], {
    cwd: paths.workspaceRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return Boolean(result.stdout.trim());
}

function pass(value: boolean): "PASS" | "FAIL" {
  return value ? "PASS" : "FAIL";
}

ensureM0Directories();

const envExit = runCommand("npm", ["run", "env:check"]);
const preflightExit = envExit === 0 ? runCommand("npm", ["run", "provider:preflight"]) : 1;
const secretExit = preflightExit === 0 ? runCommand("npm", ["run", "secret:scan"]) : 1;

const envCheck = readJson<EnvCheckResult>("provider_env_check_result.json");
const preflight = readJson<PreflightResult>("provider_preflight_result.json");
const secretScan = readJson<SecretScanResult>("secret_scan_result.json");
const envExamplePath = join(paths.workspaceRoot, ".env.example");
const envExample = existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";
const envExamplePresent =
  envExample.includes("REAL_PROVIDER_ENABLED=false") &&
  envExample.includes("RUNWAYML_API_SECRET=") &&
  envExample.includes("RUNNINGHUB_API_KEY=");
const envGitignored = gitCheckIgnore(".env") && gitCheckIgnore(".env.local") && gitCheckIgnore("credentials/api.key") && !gitCheckIgnore(".env.example");
const maskedLogging = maskSecret("dummy_secret_value_1234") === "dum****1234";
const noProviderCall = envCheck?.no_network_call === true && preflight?.network_call_attempted === false;
const secretSafetyPass =
  secretExit === 0 &&
  secretScan?.git_tracked_files === "PASS" &&
  secretScan?.reports === "PASS" &&
  !gitTrackedForbidden();
const result =
  envExit === 0 &&
  preflightExit === 0 &&
  envExamplePresent &&
  envGitignored &&
  maskedLogging &&
  noProviderCall &&
  secretSafetyPass
    ? "PASS"
    : "BLOCK";

const closeout = [
  "t02_provider_api_env_secret_safety_closeout:",
  `  result: ${result}`,
  `  generated_at: ${new Date().toISOString()}`,
  `  env_example_present: ${pass(envExamplePresent)}`,
  `  env_gitignored: ${pass(envGitignored)}`,
  `  provider_env_loader: ${envExit === 0 ? "PASS" : "FAIL"}`,
  `  provider_gate_validation: ${preflightExit === 0 ? "PASS" : "FAIL"}`,
  `  runway_env_declared: ${pass(envExample.includes("RUNWAYML_API_SECRET="))}`,
  `  runninghub_env_declared: ${pass(envExample.includes("RUNNINGHUB_API_KEY="))}`,
  `  masked_logging: ${pass(maskedLogging)}`,
  "  secret_scan:",
  `    git_tracked_files: ${secretScan?.git_tracked_files ?? "FAIL"}`,
  `    reports: ${secretScan?.reports ?? "FAIL"}`,
  `    sqlite_or_runtime_state: ${secretScan?.sqlite_or_runtime_state ?? "NOT_APPLICABLE"}`,
  `  no_provider_call: ${pass(noProviderCall)}`,
  "  env_mapping:",
  "    runway_credential: RUNWAYML_API_SECRET",
  "    runninghub_credential: RUNNINGHUB_API_KEY",
  "    provider_selector: M1_REAL_PROVIDER",
  "    master_gate: REAL_PROVIDER_ENABLED",
  "    execution_gate: M1_REAL_PROVIDER_EXECUTION_ALLOWED",
  "    cost_gate: M1_REAL_PROVIDER_COST_ACK",
  "  env_local_loader:",
  `    env_file_found: ${envCheck?.env_file?.env_file_found === true}`,
  `    disabled: ${envCheck?.env_file?.disabled === true}`,
  `    loaded_keys: [${(envCheck?.env_file?.loaded_keys ?? []).map((key) => JSON.stringify(key)).join(", ")}]`,
  `    skipped_existing_keys: [${(envCheck?.env_file?.skipped_existing_keys ?? []).map((key) => JSON.stringify(key)).join(", ")}]`,
  `    ignored_keys: [${(envCheck?.env_file?.ignored_keys ?? []).map((key) => JSON.stringify(key)).join(", ")}]`,
  `    parse_errors: [${(envCheck?.env_file?.parse_errors ?? []).map((key) => JSON.stringify(key)).join(", ")}]`,
  `    secret_values_recorded: false`,
  "  known_gaps: []"
].join("\n");

writeFileSync(join(paths.reportsRoot, "t02_provider_api_env_secret_safety_closeout.yaml"), `${closeout}\n`, "utf8");
console.log(JSON.stringify({ result, closeout_report_path: "data/reports/t02_provider_api_env_secret_safety_closeout.yaml" }, null, 2));

if (result !== "PASS") {
  process.exit(1);
}
