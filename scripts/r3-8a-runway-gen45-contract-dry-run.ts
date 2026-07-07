import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildRunwayCanaryDryRunReport, ensureM0Directories, paths, RUNWAY_CANARY_DRY_RUN_REPORT } from "../src/index.js";

const REPORT_PATH = join(paths.reportsRoot, "r3_8a_runway_gen45_contract_dry_run_report.json");
const CANONICAL_DRY_RUN_REPORT_PATH = join(paths.workspaceRoot, RUNWAY_CANARY_DRY_RUN_REPORT);
const SYNTHETIC_ENV = {
  REAL_PROVIDER_ENABLED: "true",
  M1_REAL_PROVIDER: "runway",
  M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
  M1_REAL_PROVIDER_COST_ACK: "true",
  RUNWAYML_API_SECRET: "R3_8A_TEST_SECRET_DO_NOT_LOG"
} as NodeJS.ProcessEnv;

ensureM0Directories();

const dryRun = buildRunwayCanaryDryRunReport({
  mode: "dry_run",
  env: SYNTHETIC_ENV
});

const result = dryRun.result === "PASS_READY_FOR_USER_AUTHORIZATION" && dryRun.provider_boundary.runway_ratio === "720:1280" ? "PASS_READY_FOR_REAUTHORIZATION" : "BLOCK_WITH_REASON";
const payload = {
  task: "R3-8A_Runway_Gen-4.5_Contract_Fix_And_Dry_Run",
  result,
  generated_at: new Date().toISOString(),
  canonical_dry_run_report_path: RUNWAY_CANARY_DRY_RUN_REPORT,
  dry_run_report: dryRun,
  provider_boundary: {
    network_call_attempted: dryRun.network_call_attempted,
    runway_called: dryRun.runway_called,
    runninghub_called: dryRun.runninghub_called,
    provider_credits_consumed: dryRun.provider_credits_consumed,
    real_video_generated: dryRun.real_video_generated,
    secret_values_exposed: dryRun.secret_values_exposed
  },
  next_step: {
    requires_user_authorization_for_real_call: true,
    required_contract: {
      provider: "runway",
      model: "gen4.5",
      endpoint: "POST /v1/image_to_video",
      x_runway_version: "2024-11-06",
      duration_seconds: 2,
      ratio: "720:1280",
      max_submit_calls: 1
    }
  }
};

writeFileSync(CANONICAL_DRY_RUN_REPORT_PATH, `${JSON.stringify(dryRun, null, 2)}\n`, "utf8");
writeFileSync(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ result, report_path: REPORT_PATH, runway_ratio: dryRun.provider_boundary.runway_ratio }, null, 2));

if (result !== "PASS_READY_FOR_REAUTHORIZATION") process.exitCode = 1;
