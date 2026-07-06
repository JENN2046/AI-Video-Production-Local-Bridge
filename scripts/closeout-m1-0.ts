import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths } from "../src/index.js";

type Status = "PASS" | "FAIL" | "NOT_TESTED";

interface DemoResult {
  manual_upload_or_local_import?: {
    status?: Status;
    artifact_id?: string;
    source_path?: string;
    stored_path?: string;
    width?: number;
    height?: number;
    detected_mime?: string;
    sha256?: string;
  };
  pending_upload_activation?: {
    status?: Status;
    pending_artifact_id?: string;
    activated_artifact_id?: string;
    stored_path?: string;
    width?: number;
    height?: number;
    detected_mime?: string;
    sha256?: string;
  };
  accessible_uri?: {
    status?: Status;
    uri?: string;
    error_code?: string;
  };
  chatgpt_file_handle?: {
    status?: Status;
  };
  storyboard_package_validation?: {
    external_image_artifact_imported?: Status;
    project_status_after_import?: string;
    shot_count?: number;
  };
  negative_tests?: {
    invalid_image_blocked?: Status;
    path_traversal_blocked?: Status;
    symlink_escape_blocked?: Status;
    pending_upload_blocked_before_activation?: Status;
    accessible_uri_private_network_blocked?: Status;
  };
}

function runCommand(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    cwd: paths.workspaceRoot,
    shell: true,
    stdio: "inherit"
  });
  return typeof result.status === "number" ? result.status : 1;
}

function readDemoResult(): DemoResult {
  const demoPath = join(paths.reportsRoot, "m1_0_external_image_transfer_demo_result.json");
  if (!existsSync(demoPath)) return {};
  return JSON.parse(readFileSync(demoPath, "utf8")) as DemoResult;
}

function yamlString(value: string | null | undefined): string {
  if (!value) return "null";
  return JSON.stringify(value);
}

function status(value: unknown): Status {
  return value === "PASS" || value === "FAIL" || value === "NOT_TESTED" ? value : "FAIL";
}

ensureM0Directories();

const typecheckExit = runCommand("npm", ["run", "typecheck"]);
const buildExit = typecheckExit === 0 ? runCommand("npm", ["run", "build"]) : 1;
const testM10Exit = buildExit === 0 ? runCommand("npm", ["run", "test:m1-0"]) : 1;
const demoM10Exit = testM10Exit === 0 ? runCommand("npm", ["run", "demo:m1-0"]) : 1;
const demo = demoM10Exit === 0 ? readDemoResult() : {};
const testM0Exit = demoM10Exit === 0 ? runCommand("npm", ["run", "test:m0"]) : 1;
const demoM0Exit = testM0Exit === 0 ? runCommand("npm", ["run", "demo:m0"]) : 1;
const closeoutM0Exit = demoM0Exit === 0 ? runCommand("npm", ["run", "closeout:m0"]) : 1;

const manualStatus = status(demo.manual_upload_or_local_import?.status);
const pendingStatus = status(demo.pending_upload_activation?.status);
const storyboardImportStatus = status(demo.storyboard_package_validation?.external_image_artifact_imported);
const invalidImageStatus = status(demo.negative_tests?.invalid_image_blocked);
const pathTraversalStatus = status(demo.negative_tests?.path_traversal_blocked);
const symlinkStatus = status(demo.negative_tests?.symlink_escape_blocked);
const pendingBlockedStatus = status(demo.negative_tests?.pending_upload_blocked_before_activation);
const accessiblePrivateStatus = status(demo.negative_tests?.accessible_uri_private_network_blocked);
const accessibleStatus = status(demo.accessible_uri?.status ?? "NOT_TESTED");
const chatgptFileHandleStatus = status(demo.chatgpt_file_handle?.status ?? "NOT_TESTED");
const m0RegressionPass = typecheckExit === 0 && buildExit === 0 && testM0Exit === 0 && demoM0Exit === 0 && closeoutM0Exit === 0;
const corePass =
  manualStatus === "PASS" &&
  pendingStatus === "PASS" &&
  storyboardImportStatus === "PASS" &&
  invalidImageStatus === "PASS" &&
  pathTraversalStatus === "PASS" &&
  pendingBlockedStatus === "PASS" &&
  accessiblePrivateStatus === "PASS" &&
  m0RegressionPass;
const hasAllowedGaps = accessibleStatus === "NOT_TESTED" || chatgptFileHandleStatus === "NOT_TESTED" || symlinkStatus === "NOT_TESTED";
const result = corePass ? (hasAllowedGaps ? "PASS_WITH_GAPS" : "PASS") : "BLOCK";

const closeoutPath = join(paths.reportsRoot, "m1_0_external_image_transfer_closeout.yaml");
const closeout = [
  "m1_0_external_image_transfer_closeout:",
  `  result: ${result}`,
  `  generated_at: ${new Date().toISOString()}`,
  "",
  "  transfer_paths:",
  "    fixture_path:",
  "      status: PASS",
  "      note: \"M0 already validated fixture path\"",
  "",
  "    manual_upload_or_local_import:",
  `      status: ${manualStatus}`,
  `      artifact_id: ${yamlString(demo.manual_upload_or_local_import?.artifact_id)}`,
  `      source_path: ${yamlString(demo.manual_upload_or_local_import?.source_path)}`,
  `      stored_path: ${yamlString(demo.manual_upload_or_local_import?.stored_path)}`,
  `      width: ${demo.manual_upload_or_local_import?.width ?? "null"}`,
  `      height: ${demo.manual_upload_or_local_import?.height ?? "null"}`,
  `      detected_mime: ${yamlString(demo.manual_upload_or_local_import?.detected_mime)}`,
  `      sha256: ${yamlString(demo.manual_upload_or_local_import?.sha256)}`,
  "",
  "    pending_upload_activation:",
  `      status: ${pendingStatus}`,
  `      pending_artifact_id: ${yamlString(demo.pending_upload_activation?.pending_artifact_id)}`,
  `      activated_artifact_id: ${yamlString(demo.pending_upload_activation?.activated_artifact_id)}`,
  `      stored_path: ${yamlString(demo.pending_upload_activation?.stored_path)}`,
  `      width: ${demo.pending_upload_activation?.width ?? "null"}`,
  `      height: ${demo.pending_upload_activation?.height ?? "null"}`,
  `      detected_mime: ${yamlString(demo.pending_upload_activation?.detected_mime)}`,
  `      sha256: ${yamlString(demo.pending_upload_activation?.sha256)}`,
  "",
  "    accessible_uri:",
  `      status: ${accessibleStatus}`,
  `      uri: ${yamlString(demo.accessible_uri?.uri)}`,
  `      error_code: ${yamlString(demo.accessible_uri?.error_code)}`,
  "",
  "    chatgpt_file_handle:",
  `      status: ${chatgptFileHandleStatus}`,
  "",
  "  external_image_transfer_claim:",
  `    non_fixture_local_import: ${manualStatus === "PASS" ? "VERIFIED" : "NOT_VERIFIED"}`,
  `    pending_upload_activation: ${pendingStatus === "PASS" ? "VERIFIED" : "NOT_VERIFIED"}`,
  "    direct_chatgpt_generated_image_transfer: NOT_VERIFIED",
  "",
  "  storyboard_package_validation:",
  `    external_image_artifact_imported: ${storyboardImportStatus}`,
  `    project_status_after_import: ${yamlString(demo.storyboard_package_validation?.project_status_after_import)}`,
  `    shot_count: ${demo.storyboard_package_validation?.shot_count ?? "null"}`,
  "",
  "  negative_tests:",
  `    invalid_image_blocked: ${invalidImageStatus}`,
  `    path_traversal_blocked: ${pathTraversalStatus}`,
  `    symlink_escape_blocked: ${symlinkStatus}`,
  `    pending_upload_blocked_before_activation: ${pendingBlockedStatus}`,
  `    accessible_uri_private_network_blocked: ${accessiblePrivateStatus}`,
  "",
  "  regression:",
  `    typecheck: ${typecheckExit === 0 ? "PASS" : "FAIL"}`,
  `    build: ${buildExit === 0 ? "PASS" : "FAIL"}`,
  `    test_m1_0: ${testM10Exit === 0 ? "PASS" : "FAIL"}`,
  `    demo_m1_0: ${demoM10Exit === 0 ? "PASS" : "FAIL"}`,
  `    test_m0: ${testM0Exit === 0 ? "PASS" : "FAIL"}`,
  `    demo_m0: ${demoM0Exit === 0 ? "PASS" : "FAIL"}`,
  `    closeout_m0: ${closeoutM0Exit === 0 ? "PASS" : "FAIL"}`,
  "",
  "  known_gaps:",
  "    - direct_chatgpt_file_handle_not_integrated",
  "    - accessible_uri_not_tested_or_limited",
  "    - real_provider_not_enabled",
  "    - asset_library_not_implemented",
  "    - memory_loop_not_implemented",
  ...(symlinkStatus === "NOT_TESTED" ? ["    - symlink_escape_test_not_available_in_current_os_context"] : []),
  "",
  "  next_stage_recommendation:",
  "    - M1 Real Provider Integration"
].join("\n");

writeFileSync(closeoutPath, `${closeout}\n`, "utf8");
console.log(JSON.stringify({ result, closeout_report_path: closeoutPath }, null, 2));

if (result === "BLOCK") {
  process.exit(1);
}
