import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths } from "../src/index.js";

function runCommand(label: string, command: string, args: string[]): { label: string; exit_code: number } {
  const result = spawnSync(command, args, {
    cwd: paths.workspaceRoot,
    shell: true,
    stdio: "inherit",
    windowsHide: true
  });
  return { label, exit_code: typeof result.status === "number" ? result.status : 1 };
}

function reportHasPass(filename: string): boolean {
  const path = join(paths.reportsRoot, filename);
  if (!existsSync(path)) return false;
  return /result:\s+PASS\b/.test(readFileSync(path, "utf8"));
}

function pass(value: boolean): "PASS" | "FAIL" {
  return value ? "PASS" : "FAIL";
}

ensureM0Directories();

const commands = [
  runCommand("typecheck", "npm", ["run", "typecheck"]),
  runCommand("build", "npm", ["run", "build"]),
  runCommand("test_m0", "npm", ["run", "test:m0"]),
  runCommand("demo_m0", "npm", ["run", "demo:m0"]),
  runCommand("closeout_m0", "npm", ["run", "closeout:m0"]),
  runCommand("test_m1_0", "npm", ["run", "test:m1-0"]),
  runCommand("demo_m1_0", "npm", ["run", "demo:m1-0"]),
  runCommand("closeout_m1_0", "npm", ["run", "closeout:m1-0"]),
  runCommand("test_m1", "npm", ["run", "test:m1"]),
  runCommand("demo_m1", "npm", ["run", "demo:m1"]),
  runCommand("closeout_m1", "npm", ["run", "closeout:m1"]),
  runCommand("test_g0", "npm", ["run", "test:g0"]),
  runCommand("demo_g0", "npm", ["run", "demo:g0"]),
  runCommand("closeout_g0", "npm", ["run", "closeout:g0"]),
  runCommand("env_check", "npm", ["run", "env:check"]),
  runCommand("provider_preflight", "npm", ["run", "provider:preflight"]),
  runCommand("secret_scan", "npm", ["run", "secret:scan"]),
  runCommand("closeout_t00", "npm", ["run", "closeout:t00"]),
  runCommand("closeout_provider_env", "npm", ["run", "closeout:provider-env"])
];

const commandPass = Object.fromEntries(commands.map((command) => [command.label, command.exit_code === 0]));
const repositoryBaseline = reportHasPass("t00_repository_baseline_closeout.yaml");
const pregenReadiness = reportHasPass("t01_g0_app_side_pregen_readiness_closeout.yaml");
const providerEnvSetup = reportHasPass("t02_provider_api_env_secret_safety_closeout.yaml");
const appReadyDemo = reportHasPass("t03_g0_import_app_ready_package_demo_closeout.yaml");
const secretSafety = commandPass.secret_scan && providerEnvSetup;
const noRealProviderCall = commandPass.demo_m1 && commandPass.provider_preflight && commandPass.env_check;
const regression =
  commandPass.typecheck &&
  commandPass.build &&
  commandPass.test_m0 &&
  commandPass.demo_m0 &&
  commandPass.closeout_m0 &&
  commandPass.test_m1_0 &&
  commandPass.demo_m1_0 &&
  commandPass.closeout_m1_0 &&
  commandPass.test_m1 &&
  commandPass.demo_m1 &&
  commandPass.closeout_m1;
const allPass =
  repositoryBaseline &&
  pregenReadiness &&
  providerEnvSetup &&
  appReadyDemo &&
  secretSafety &&
  noRealProviderCall &&
  regression &&
  commandPass.test_g0 &&
  commandPass.demo_g0 &&
  commandPass.closeout_g0;
const result = allPass ? "PASS" : "BLOCK";

const closeout = [
  "t04_pregeneration_final_closeout:",
  `  result: ${result}`,
  `  generated_at: ${new Date().toISOString()}`,
  `  repository_baseline: ${pass(repositoryBaseline)}`,
  `  pregen_readiness: ${pass(pregenReadiness)}`,
  `  provider_env_setup: ${pass(providerEnvSetup)}`,
  `  app_ready_package_demo: ${pass(appReadyDemo)}`,
  `  secret_safety: ${pass(secretSafety)}`,
  `  no_real_provider_call: ${pass(noRealProviderCall)}`,
  "  validation:",
  `    typecheck: ${pass(commandPass.typecheck)}`,
  `    build: ${pass(commandPass.build)}`,
  `    m0: ${pass(commandPass.test_m0 && commandPass.demo_m0 && commandPass.closeout_m0)}`,
  `    m1_0: ${pass(commandPass.test_m1_0 && commandPass.demo_m1_0 && commandPass.closeout_m1_0)}`,
  `    m1_offline: ${pass(commandPass.test_m1 && commandPass.demo_m1 && commandPass.closeout_m1)}`,
  `    g0: ${pass(commandPass.test_g0 && commandPass.demo_g0 && commandPass.closeout_g0)}`,
  `    env_check: ${pass(commandPass.env_check)}`,
  `    provider_preflight: ${pass(commandPass.provider_preflight)}`,
  `    secret_scan: ${pass(commandPass.secret_scan)}`,
  `  ready_for_m1_r0_runway_live_gate: ${allPass ? "true" : "false"}`,
  "  t05_hold:",
  "    status: HOLD_UNTIL_JENN_EXPLICIT_AUTHORIZATION",
  "    runway_live_call_authorized: false",
  "    real_provider_call_executed: false",
  "  known_gaps: []"
].join("\n");

writeFileSync(join(paths.reportsRoot, "t04_pregeneration_final_closeout.yaml"), `${closeout}\n`, "utf8");
console.log(JSON.stringify({ result, closeout_report_path: "data/reports/t04_pregeneration_final_closeout.yaml" }, null, 2));

if (result !== "PASS") {
  process.exit(1);
}
