import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ensureM0Directories,
  paths,
  runR2GReadOnlyLiveSmokeLocalEntryPrep
} from "../src/index.js";

const REPORT_PATH = "data/reports/r2g_l_chatgpt_connector_read_only_live_smoke_local_entry_prep_result.json";

function writeJson(relativePath: string, payload: unknown): void {
  const target = join(paths.workspaceRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

ensureM0Directories();
const report = await runR2GReadOnlyLiveSmokeLocalEntryPrep();
writeJson(REPORT_PATH, report);

const result = typeof report.result === "string" ? report.result : "UNKNOWN";
console.log(JSON.stringify({ stage: "r2g-l", result, report_path: REPORT_PATH }, null, 2));
if (!result.startsWith("PASS")) process.exitCode = 1;
