import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ensureM0Directories,
  loadProviderEnvLocal,
  paths,
  RUNWAY_CANARY_DRY_RUN_REPORT,
  runStrictRunwayCanary
} from "../src/index.js";

function canaryMode(): "dry_run" | "live" {
  return process.env.RUNWAY_CANARY_MODE === "live" || process.argv.includes("--live") ? "live" : "dry_run";
}

function reportPath(mode: "dry_run" | "live"): string {
  if (mode === "live") return join(paths.reportsRoot, "m1_r0_runway_canary_live_result.json");
  return join(paths.workspaceRoot, RUNWAY_CANARY_DRY_RUN_REPORT);
}

ensureM0Directories();
loadProviderEnvLocal();

const mode = canaryMode();
const report = await runStrictRunwayCanary({
  mode,
  authorization_phrase: process.env.RUNWAY_CANARY_AUTHORIZATION
});

const target = reportPath(mode);
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

if (report.result === "BLOCK_WITH_REASON" || report.result === "PROVIDER_FAILED") {
  process.exit(1);
}
