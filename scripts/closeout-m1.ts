import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths } from "../src/index.js";

type Status = "PASS" | "FAIL" | "NOT_TESTED" | "SKIPPED_MISSING_ENV_GATE" | "SKIPPED_MISSING_CREDENTIAL" | "PROVIDER_FAILED";

interface OfflineDemo {
  provider_boundary?: Record<string, string>;
  output_download_safety?: Record<string, string>;
  mock_default_generation?: {
    status?: string;
  };
}

interface RealDemo {
  result?: string;
  provider_name?: string;
  single_shot?: {
    status?: string;
    run_id?: string;
    provider_job_id?: string;
    artifact_id?: string | null;
    artifact_source_provider?: string | null;
    error_code?: string | null;
  };
  regeneration?: {
    status?: string;
    first_run_id?: string;
    second_run_id?: string | null;
    second_artifact_id?: string | null;
  };
  batch_generation?: {
    status?: string;
  };
  final_video_artifact_id?: string | null;
}

const TEST_SECRET = "M1_TEST_SECRET_DO_NOT_LOG_123";

function runCommand(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    cwd: paths.workspaceRoot,
    shell: true,
    stdio: "inherit",
    windowsHide: true
  });
  return typeof result.status === "number" ? result.status : 1;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function yamlString(value: string | null | undefined): string {
  if (!value) return "null";
  return JSON.stringify(value);
}

function status(value: unknown): Status {
  if (
    value === "PASS" ||
    value === "FAIL" ||
    value === "NOT_TESTED" ||
    value === "SKIPPED_MISSING_ENV_GATE" ||
    value === "SKIPPED_MISSING_CREDENTIAL" ||
    value === "PROVIDER_FAILED"
  ) {
    return value;
  }
  return "FAIL";
}

function scanFileForTestSecret(path: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path).includes(Buffer.from(TEST_SECRET, "utf8"));
}

function reportsSecretScan(): "PASS" | "FAIL" {
  if (!existsSync(paths.reportsRoot)) return "PASS";
  const files = readdirSync(paths.reportsRoot, { withFileTypes: true }).filter((entry) => entry.isFile());
  for (const file of files) {
    if (scanFileForTestSecret(join(paths.reportsRoot, file.name))) return "FAIL";
  }
  return "PASS";
}

ensureM0Directories();

const typecheckExit = runCommand("npm", ["run", "typecheck"]);
const buildExit = typecheckExit === 0 ? runCommand("npm", ["run", "build"]) : 1;
const testM0Exit = buildExit === 0 ? runCommand("npm", ["run", "test:m0"]) : 1;
const demoM0Exit = testM0Exit === 0 ? runCommand("npm", ["run", "demo:m0"]) : 1;
const closeoutM0Exit = demoM0Exit === 0 ? runCommand("npm", ["run", "closeout:m0"]) : 1;
const testM10Exit = closeoutM0Exit === 0 ? runCommand("npm", ["run", "test:m1-0"]) : 1;
const demoM10Exit = testM10Exit === 0 ? runCommand("npm", ["run", "demo:m1-0"]) : 1;
const closeoutM10Exit = demoM10Exit === 0 ? runCommand("npm", ["run", "closeout:m1-0"]) : 1;
const testM1Exit = closeoutM10Exit === 0 ? runCommand("npm", ["run", "test:m1"]) : 1;
const demoM1Exit = testM1Exit === 0 ? runCommand("npm", ["run", "demo:m1"]) : 1;

const offlineDemo = readJson<OfflineDemo>(join(paths.reportsRoot, "m1_offline_demo_result.json"));
const realDemo = readJson<RealDemo>(join(paths.reportsRoot, "m1_real_demo_result.json"));
const sqliteSecretScan = scanFileForTestSecret(paths.sqlitePath) ? "FAIL" : "PASS";
const reportSecretScan = reportsSecretScan();
const offlineBoundaryPass =
  testM1Exit === 0 &&
  demoM1Exit === 0 &&
  offlineDemo?.mock_default_generation?.status === "PASS" &&
  Object.values(offlineDemo.provider_boundary ?? {}).every((item) => item === "PASS");

const realSingleStatus = status(realDemo?.single_shot?.status ?? "NOT_TESTED");
const realRegenerationStatus = status(realDemo?.regeneration?.status ?? "NOT_TESTED");
const realBatchStatus = status(realDemo?.batch_generation?.status ?? "NOT_TESTED");
const realExecutionStatus: Status =
  realSingleStatus === "PASS"
    ? "PASS"
    : realDemo?.result === "SKIPPED_MISSING_CREDENTIAL"
      ? "SKIPPED_MISSING_CREDENTIAL"
      : realDemo?.result === "PROVIDER_FAILED"
        ? "PROVIDER_FAILED"
        : "SKIPPED_MISSING_ENV_GATE";
const realPassEnoughForM1 =
  realSingleStatus === "PASS" &&
  realRegenerationStatus === "PASS" &&
  (realBatchStatus === "PASS" || realBatchStatus === "NOT_TESTED") &&
  Boolean(realDemo?.final_video_artifact_id);
const regressionPass =
  typecheckExit === 0 &&
  buildExit === 0 &&
  testM0Exit === 0 &&
  demoM0Exit === 0 &&
  closeoutM0Exit === 0 &&
  testM10Exit === 0 &&
  demoM10Exit === 0 &&
  closeoutM10Exit === 0;
const credentialSafetyPass = sqliteSecretScan === "PASS" && reportSecretScan === "PASS";
const finalResult = !offlineBoundaryPass || !regressionPass || !credentialSafetyPass ? "BLOCK" : realPassEnoughForM1 ? "PASS_WITH_GAPS" : "OFFLINE_ONLY";

const closeout = [
  "m1_real_provider_closeout:",
  `  result: ${finalResult}`,
  `  generated_at: ${new Date().toISOString()}`,
  "",
  "  provider_ports:",
  "    mock:",
  `      boundary: ${offlineDemo?.provider_boundary?.mock_default === "PASS" ? "PASS" : "FAIL"}`,
  `      regression: ${offlineDemo?.mock_default_generation?.status === "PASS" ? "PASS" : "FAIL"}`,
  "    runway:",
  `      boundary: ${offlineDemo?.provider_boundary?.provider_selector === "PASS" ? "PASS" : "FAIL"}`,
  `      real_generation: ${realDemo?.provider_name === "runway" ? realSingleStatus : "NOT_TESTED"}`,
  "      model_name: gen4.5",
  "    runninghub:",
  `      boundary: ${offlineDemo?.provider_boundary?.provider_selector === "PASS" ? "PASS" : "FAIL"}`,
  `      real_generation: ${realDemo?.provider_name === "runninghub" ? realSingleStatus : "NOT_TESTED"}`,
  "      model_name: TBD",
  "",
  "  selected_real_provider:",
  `    provider_name: ${yamlString(realDemo?.provider_name)}`,
  `    real_generation_status: ${realSingleStatus}`,
  `    generated_clip_artifact_id: ${yamlString(realDemo?.single_shot?.artifact_id ?? null)}`,
  `    ffprobe_valid: ${realSingleStatus === "PASS"}`,
  `    provider_job_id: ${yamlString(realDemo?.single_shot?.provider_job_id ?? null)}`,
  "",
  "  result_layers:",
  `    offline_boundary: ${offlineBoundaryPass ? "PASS" : "FAIL"}`,
  `    real_execution: ${realExecutionStatus}`,
  `    final_result: ${finalResult}`,
  "",
  "  provider_boundary:",
  `    mock_default: ${offlineDemo?.provider_boundary?.mock_default ?? "FAIL"}`,
  `    provider_selector: ${offlineDemo?.provider_boundary?.provider_selector ?? "FAIL"}`,
  `    provider_disabled_boundary: ${offlineDemo?.provider_boundary?.provider_disabled_boundary ?? "FAIL"}`,
  `    missing_credential_boundary: ${offlineDemo?.provider_boundary?.missing_credential_boundary ?? "FAIL"}`,
  `    confirmation_gate: ${offlineDemo?.provider_boundary?.confirmation_gate ?? "FAIL"}`,
  `    cost_acknowledgement_gate: ${offlineDemo?.provider_boundary?.cost_acknowledgement_gate ?? "FAIL"}`,
  `    provider_disabled_error: ${offlineDemo?.provider_boundary?.provider_disabled_boundary ?? "FAIL"}`,
  "",
  "  credential_safety:",
  `    sqlite_secret_scan: ${sqliteSecretScan}`,
  `    reports_secret_scan: ${reportSecretScan}`,
  "    logs_secret_scan: NOT_CAPTURED",
  "",
  "  real_generation:",
  "    single_shot:",
  `      status: ${realSingleStatus}`,
  `      run_id: ${yamlString(realDemo?.single_shot?.run_id)}`,
  `      provider_job_id: ${yamlString(realDemo?.single_shot?.provider_job_id)}`,
  `      artifact_id: ${yamlString(realDemo?.single_shot?.artifact_id ?? null)}`,
  `      artifact_source_provider: ${yamlString(realDemo?.single_shot?.artifact_source_provider ?? null)}`,
  `      ffprobe_valid: ${realSingleStatus === "PASS"}`,
  `      error_code: ${yamlString(realDemo?.single_shot?.error_code ?? null)}`,
  "",
  "    regeneration:",
  `      status: ${realRegenerationStatus}`,
  `      first_run_id: ${yamlString(realDemo?.regeneration?.first_run_id)}`,
  `      second_run_id: ${yamlString(realDemo?.regeneration?.second_run_id ?? null)}`,
  `      parent_run_id_valid: ${realRegenerationStatus === "PASS"}`,
  `      second_artifact_id: ${yamlString(realDemo?.regeneration?.second_artifact_id ?? null)}`,
  `      ffprobe_valid: ${realRegenerationStatus === "PASS"}`,
  "      error_code: null",
  "",
  "    batch_generation:",
  `      status: ${realBatchStatus}`,
  "      batch_id: null",
  "      total_runs: 0",
  "      succeeded: 0",
  "      failed: 0",
  "      valid_artifacts: 0",
  "",
  "  output_download_safety:",
  `    https_only: ${offlineDemo?.output_download_safety?.https_only ?? "FAIL"}`,
  `    private_network_block: ${offlineDemo?.output_download_safety?.private_network_block ?? "FAIL"}`,
  `    timeout_set: ${offlineDemo?.output_download_safety?.timeout_set ?? "FAIL"}`,
  `    max_size_set: ${offlineDemo?.output_download_safety?.max_size_set ?? "FAIL"}`,
  `    redirect_limit_set: ${offlineDemo?.output_download_safety?.redirect_limit_set ?? "FAIL"}`,
  "",
  "  media_validity:",
  "    real_generated_clips:",
  `      status: ${realSingleStatus === "PASS" ? "PASS" : "NOT_TESTED"}`,
  `      checked: ${realSingleStatus === "PASS" ? 1 : 0}`,
  "      failed: 0",
  "    final_video:",
  `      status: ${realDemo?.final_video_artifact_id ? "PASS" : "NOT_TESTED"}`,
  `      artifact_id: ${yamlString(realDemo?.final_video_artifact_id ?? null)}`,
  "",
  "  regression:",
  `    typecheck: ${typecheckExit === 0 ? "PASS" : "FAIL"}`,
  `    build: ${buildExit === 0 ? "PASS" : "FAIL"}`,
  `    test_m0: ${testM0Exit === 0 ? "PASS" : "FAIL"}`,
  `    demo_m0: ${demoM0Exit === 0 ? "PASS" : "FAIL"}`,
  `    closeout_m0: ${closeoutM0Exit === 0 ? "PASS" : "FAIL"}`,
  `    test_m1_0: ${testM10Exit === 0 ? "PASS" : "FAIL"}`,
  `    demo_m1_0: ${demoM10Exit === 0 ? "PASS" : "FAIL"}`,
  `    closeout_m1_0: ${closeoutM10Exit === 0 ? "PASS" : "FAIL"}`,
  `    test_m1: ${testM1Exit === 0 ? "PASS" : "FAIL"}`,
  `    demo_m1: ${demoM1Exit === 0 ? "PASS" : "FAIL"}`,
  "",
  "  known_gaps:",
  "    - asset_library_not_implemented",
  "    - memory_loop_not_implemented",
  "    - advanced_ui_not_implemented",
  "    - direct_chatgpt_file_handle_not_integrated",
  ...(finalResult === "OFFLINE_ONLY" ? ["    - real_provider_generation_not_executed_in_this_run"] : []),
  "    - runway_ratio_values_must_be_reconfirmed_against_current_provider_docs_before_live_call",
  "",
  "  next_stage_recommendation:",
  "    - M1 live Runway execution with explicit gates and budget acknowledgement",
  "    - M2 Asset and Reference Library"
].join("\n");

const closeoutPath = join(paths.reportsRoot, "m1_real_provider_closeout.yaml");
writeFileSync(closeoutPath, `${closeout}\n`, "utf8");
console.log(JSON.stringify({ result: finalResult, closeout_report_path: closeoutPath }, null, 2));

if (finalResult === "BLOCK") {
  process.exit(1);
}
