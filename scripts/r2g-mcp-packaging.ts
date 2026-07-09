import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildR2GCloseoutReport,
  buildR2GConfirmationGateReport,
  buildR2GConnectorAuthorizationPrepReport,
  buildR2GDryRunReport,
  buildR2GHardeningFixReport,
  buildR2GLocalServerSkeletonReport,
  buildR2GSecurityModelReport,
  buildR2GToolContractReport,
  ensureM0Directories,
  openM0Database,
  paths
} from "../src/index.js";

const REPORTS: Record<string, string> = {
  "r2g-a": "data/reports/r2g_a_mcp_security_and_permission_model_result.json",
  "r2g-b": "data/reports/r2g_b_mcp_tool_schema_and_contract_freeze_result.json",
  "r2g-c": "data/reports/r2g_c_local_mcp_server_skeleton_result.json",
  "r2g-d": "data/reports/r2g_d_chatgpt_handoff_e2e_dry_run_result.json",
  "r2g-e": "data/reports/r2g_e_human_confirmation_and_write_gates_result.json",
  "r2g-f": "data/reports/r2g_f_mcp_packaging_closeout_result.json",
  "r2g-h1": "data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json",
  "r2g-g": "data/reports/r2g_g_chatgpt_connector_live_connection_authorization_prep_result.json"
};

const SCHEMA_FIXTURE = "fixtures/mcp/chatgpt_mcp_tool_contract_r2g_b.json";

function writeJson(relativePath: string, payload: unknown): void {
  const target = join(paths.workspaceRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function reportFor(stage: string, generatedAt: string): Record<string, unknown> {
  if (stage === "r2g-a") return buildR2GSecurityModelReport(generatedAt);
  if (stage === "r2g-b") return buildR2GToolContractReport(generatedAt);
  if (stage === "r2g-f") return buildR2GCloseoutReport(generatedAt);
  if (stage === "r2g-h1") return buildR2GHardeningFixReport(generatedAt);
  if (stage === "r2g-g") return buildR2GConnectorAuthorizationPrepReport(generatedAt);

  const db = openM0Database();
  try {
    if (stage === "r2g-c") return buildR2GLocalServerSkeletonReport(generatedAt, db);
    if (stage === "r2g-d") return buildR2GDryRunReport(generatedAt, db);
    if (stage === "r2g-e") return buildR2GConfirmationGateReport(generatedAt, db);
  } finally {
    db.close();
  }

  throw new Error(`Unknown R2G packaging stage: ${stage}`);
}

function main(): void {
  ensureM0Directories();
  const stage = process.argv[2] ?? "";
  const reportPath = REPORTS[stage];
  if (!reportPath) {
    throw new Error(`Usage: node dist/scripts/r2g-mcp-packaging.js <${Object.keys(REPORTS).join("|")}>`);
  }

  const report = reportFor(stage, new Date().toISOString());
  writeJson(reportPath, report);

  if (stage === "r2g-b") {
    writeJson(SCHEMA_FIXTURE, {
      generated_from_report: reportPath,
      generated_at: report.generated_at,
      bridge_version: report.bridge_version,
      tool_contract: report.tool_contract
    });
  }

  const result = typeof report.result === "string" ? report.result : "UNKNOWN";
  console.log(JSON.stringify({ stage, result, report_path: reportPath }, null, 2));
  if (!result.startsWith("PASS")) process.exitCode = 1;
}

main();
