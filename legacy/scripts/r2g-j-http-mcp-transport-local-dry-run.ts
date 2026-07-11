import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ensureM0Directories,
  paths,
  runR2GHttpMcpTransportLocalDryRun
} from "../src/index.js";

const REPORT_PATH = "data/reports/r2g_j_http_mcp_transport_local_dry_run_result.json";

function writeJson(relativePath: string, payload: unknown): void {
  const target = join(paths.workspaceRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

ensureM0Directories();
const report = await runR2GHttpMcpTransportLocalDryRun();
writeJson(REPORT_PATH, report);

const result = typeof report.result === "string" ? report.result : "UNKNOWN";
console.log(JSON.stringify({ stage: "r2g-j", result, report_path: REPORT_PATH }, null, 2));
if (!result.startsWith("PASS")) process.exitCode = 1;
