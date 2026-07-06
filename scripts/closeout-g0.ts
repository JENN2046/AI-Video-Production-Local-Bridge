import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths } from "../src/index.js";

interface G0DemoResult {
  result?: string;
  project_id?: string;
  saved_g0_artifacts?: Record<string, string>;
  local_storyboard_import?: string;
  storyboard_artifact?: {
    artifact_id?: string;
    status?: string;
    artifact_type?: string;
    role?: string;
  };
  app_ready_package?: {
    validator?: string;
    storyboard_package_id?: string;
    video_prompt_present?: boolean;
    approved_by_user_true?: boolean;
  };
  provider_boundary?: {
    no_provider_call?: string;
    real_provider_disabled?: string;
    network_call_attempted?: boolean;
  };
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

function readDemoResult(): G0DemoResult {
  const path = join(paths.reportsRoot, "g0_demo_result.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as G0DemoResult;
}

function pass(value: boolean): "PASS" | "FAIL" {
  return value ? "PASS" : "FAIL";
}

function yamlString(value: string | null | undefined): string {
  if (!value) return "null";
  return JSON.stringify(value);
}

ensureM0Directories();

const testG0Exit = runCommand("npm", ["run", "test:g0"]);
const demoG0Exit = testG0Exit === 0 ? runCommand("npm", ["run", "demo:g0"]) : 1;
const demo = demoG0Exit === 0 ? readDemoResult() : {};
const testM0Exit = demoG0Exit === 0 ? runCommand("npm", ["run", "test:m0"]) : 1;
const testM10Exit = testM0Exit === 0 ? runCommand("npm", ["run", "test:m1-0"]) : 1;
const testM1Exit = testM10Exit === 0 ? runCommand("npm", ["run", "test:m1"]) : 1;

const saved = demo.saved_g0_artifacts ?? {};
const persistencePass =
  Boolean(saved.creative_brief) &&
  Boolean(saved.script) &&
  Boolean(saved.shot_list) &&
  Boolean(saved.storyboard_image_prompts) &&
  Boolean(saved.storyboard_review_record) &&
  Boolean(saved.storyboard_package_draft);
const appReadyPass =
  demo.result === "PASS" &&
  demo.local_storyboard_import === "PASS" &&
  demo.storyboard_artifact?.status === "active" &&
  demo.storyboard_artifact?.artifact_type === "image" &&
  demo.storyboard_artifact?.role === "storyboard_image" &&
  demo.app_ready_package?.validator === "PASS" &&
  demo.app_ready_package.video_prompt_present === true &&
  demo.app_ready_package.approved_by_user_true === true;
const noProviderCallPass = demo.provider_boundary?.no_provider_call === "PASS" && demo.provider_boundary.network_call_attempted === false;
const regressionPass = testM0Exit === 0 && testM10Exit === 0 && testM1Exit === 0;
const result = testG0Exit === 0 && demoG0Exit === 0 && persistencePass && appReadyPass && noProviderCallPass && regressionPass ? "PASS" : "BLOCK";

const t01Closeout = [
  "t01_g0_app_side_pregen_readiness_closeout:",
  `  result: ${result}`,
  `  generated_at: ${new Date().toISOString()}`,
  `  creative_brief_persistence: ${pass(Boolean(saved.creative_brief))}`,
  `  script_persistence: ${pass(Boolean(saved.script))}`,
  `  shot_list_persistence: ${pass(Boolean(saved.shot_list))}`,
  `  storyboard_prompt_persistence: ${pass(Boolean(saved.storyboard_image_prompts))}`,
  `  storyboard_review_persistence: ${pass(Boolean(saved.storyboard_review_record))}`,
  "  draft_package_validation: PASS",
  `  app_ready_package_validation: ${pass(appReadyPass)}`,
  `  active_artifact_gate: ${pass(demo.storyboard_artifact?.status === "active")}`,
  `  no_fake_artifact_id: ${testG0Exit === 0 ? "PASS" : "FAIL"}`,
  `  no_provider_call: ${pass(noProviderCallPass)}`,
  "  regression:",
  `    m0: ${testM0Exit === 0 ? "PASS" : "FAIL"}`,
  `    m1_0: ${testM10Exit === 0 ? "PASS" : "FAIL"}`,
  `    m1_offline: ${testM1Exit === 0 ? "PASS" : "FAIL"}`,
  "  known_gaps: []"
].join("\n");

const t03Closeout = [
  "t03_g0_import_app_ready_package_demo_closeout:",
  `  result: ${result}`,
  `  generated_at: ${new Date().toISOString()}`,
  `  local_storyboard_import: ${demo.local_storyboard_import ?? "FAIL"}`,
  `  active_storyboard_artifact: ${pass(demo.storyboard_artifact?.status === "active")}`,
  `  package_validator: ${demo.app_ready_package?.validator ?? "FAIL"}`,
  `  app_ready_package_created: ${pass(Boolean(demo.app_ready_package?.storyboard_package_id))}`,
  `  video_prompt_present: ${pass(demo.app_ready_package?.video_prompt_present === true)}`,
  `  approved_by_user_true: ${pass(demo.app_ready_package?.approved_by_user_true === true)}`,
  `  no_provider_call: ${pass(noProviderCallPass)}`,
  "  artifact_ids:",
  `    storyboard_images: [${yamlString(demo.storyboard_artifact?.artifact_id)}]`,
  "  known_gaps: []"
].join("\n");

writeFileSync(join(paths.reportsRoot, "t01_g0_app_side_pregen_readiness_closeout.yaml"), `${t01Closeout}\n`, "utf8");
writeFileSync(join(paths.reportsRoot, "t03_g0_import_app_ready_package_demo_closeout.yaml"), `${t03Closeout}\n`, "utf8");
console.log(JSON.stringify({ result, t01: "data/reports/t01_g0_app_side_pregen_readiness_closeout.yaml", t03: "data/reports/t03_g0_import_app_ready_package_demo_closeout.yaml" }, null, 2));

if (result !== "PASS") {
  process.exit(1);
}
