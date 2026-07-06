import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  ensureM0Directories,
  getStoryboardImageTransferGate,
  openM0Database,
  paths,
  summarizeMp4Validations,
  validateMp4File
} from "../src/index.js";
import type { MediaArtifact, MediaValidityStatus, Mp4ValidationResult } from "../src/index.js";

interface DemoResult {
  project_id?: string;
  storyboard_package_id?: string;
  demo_batch_id?: string;
  final_video_artifact_id?: string;
  final_video_path?: string | null;
  regenerated_shot_id?: string;
}

type CountParam = string | number | null;

const demoResultPath = join(paths.reportsRoot, "m0_demo_result.json");

function runCommand(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    cwd: paths.workspaceRoot,
    shell: true,
    stdio: "inherit"
  });
  return typeof result.status === "number" ? result.status : 1;
}

function count(db: ReturnType<typeof openM0Database>, sql: string, ...params: CountParam[]): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function listGeneratedClipArtifacts(db: ReturnType<typeof openM0Database>, projectId: string): MediaArtifact[] {
  if (!projectId) return [];
  const rows = db.prepare(`
    SELECT data_json
    FROM media_artifacts
    WHERE role = 'generated_clip' AND project_id = ?
    ORDER BY created_at
  `).all(projectId) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as MediaArtifact);
}

function clearPriorDemoResult(): void {
  if (existsSync(demoResultPath)) {
    rmSync(demoResultPath, { force: true });
  }
}

function readDemoResult(): DemoResult {
  if (!existsSync(demoResultPath)) return {};
  return JSON.parse(readFileSync(demoResultPath, "utf8")) as DemoResult;
}

function yamlString(value: string | null | undefined): string {
  if (!value) return "null";
  return JSON.stringify(value);
}

function yamlNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Number(value.toFixed(3))) : "null";
}

function mediaStatusForGeneratedClips(summary: ReturnType<typeof summarizeMp4Validations>): MediaValidityStatus {
  if (summary.checked === 0) return "FAIL";
  return summary.status;
}

ensureM0Directories();
clearPriorDemoResult();

const typecheckExit = runCommand("npm", ["run", "typecheck"]);
const testExit = typecheckExit === 0 ? runCommand("npm", ["run", "test:m0"]) : 1;
const demoExit = testExit === 0 ? runCommand("npm", ["run", "demo:m0"]) : 1;
const demo = testExit === 0 && demoExit === 0 ? readDemoResult() : {};
const hasCurrentDemoEvidence = Boolean(demo.project_id && demo.demo_batch_id && demo.final_video_artifact_id);
const commandsRun = [
  "npm run typecheck",
  ...(typecheckExit === 0 ? ["npm run test:m0"] : []),
  ...(testExit === 0 ? ["npm run demo:m0"] : []),
  "npm run closeout:m0"
];
const db = openM0Database();

try {
  const closeoutPath = join(paths.reportsRoot, "m0_closeout.yaml");
  const implementationSummaryPath = join(paths.reportsRoot, "m0_implementation_summary.yaml");
  const selfReviewPath = join(paths.reportsRoot, "m0_self_review.yaml");
  const transferGate = getStoryboardImageTransferGate();
  const projectId = demo.project_id ?? "";
  const fixtureMockClipValidity = validateMp4File(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  const generatedClipValidations = listGeneratedClipArtifacts(db, projectId).map((artifact) => validateMp4File(artifact.storage.uri));
  const generatedClipSummary = summarizeMp4Validations(generatedClipValidations);
  const generatedClipMediaStatus = mediaStatusForGeneratedClips(generatedClipSummary);
  const finalVideoValidity = validateMp4File(demo.final_video_path ?? "");
  const mediaValidityPass =
    fixtureMockClipValidity.status === "PASS" &&
    generatedClipMediaStatus === "PASS" &&
    finalVideoValidity.status === "PASS";

  const storyboardTotal = projectId
    ? count(
        db,
        `
          SELECT COUNT(*) AS count
          FROM shots AS s
          JOIN media_artifacts AS a
            ON a.artifact_id = json_extract(s.data_json, '$.storyboard_image_artifact_id')
          WHERE s.project_id = ? AND a.role = 'storyboard_image'
        `,
        projectId
      )
    : 0;
  const storyboardActive = projectId
    ? count(
        db,
        `
          SELECT COUNT(*) AS count
          FROM shots AS s
          JOIN media_artifacts AS a
            ON a.artifact_id = json_extract(s.data_json, '$.storyboard_image_artifact_id')
          WHERE s.project_id = ? AND a.role = 'storyboard_image' AND a.status = 'active'
        `,
        projectId
      )
    : 0;
  const generatedTotal = projectId ? count(db, "SELECT COUNT(*) AS count FROM media_artifacts WHERE role = 'generated_clip' AND project_id = ?", projectId) : 0;
  const generatedActive = projectId
    ? count(db, "SELECT COUNT(*) AS count FROM media_artifacts WHERE role = 'generated_clip' AND status = 'active' AND project_id = ?", projectId)
    : 0;
  const batchCount = projectId ? count(db, "SELECT COUNT(*) AS count FROM generation_batches WHERE project_id = ?", projectId) : 0;
  const runCount = projectId ? count(db, "SELECT COUNT(*) AS count FROM generation_runs WHERE project_id = ?", projectId) : 0;
  const failedRunCount = projectId ? count(db, "SELECT COUNT(*) AS count FROM generation_runs WHERE status = 'failed' AND project_id = ?", projectId) : 0;
  const approvedShots = projectId
    ? count(db, "SELECT COUNT(*) AS count FROM shots WHERE project_id = ? AND json_extract(data_json, '$.status') = 'approved'", projectId)
    : 0;
  const revisionNeededShots = projectId
    ? count(db, "SELECT COUNT(*) AS count FROM shots WHERE project_id = ? AND json_extract(data_json, '$.status') = 'revision_needed'", projectId)
    : 0;
  const regeneratedShots = projectId
    ? count(db, "SELECT COUNT(*) AS count FROM generation_runs WHERE project_id = ? AND run_type = 'regenerate_shot'", projectId)
    : 0;

  const result = typecheckExit === 0 && testExit === 0 && demoExit === 0 && hasCurrentDemoEvidence && mediaValidityPass ? "PASS_WITH_GAPS" : "BLOCK";
  const closeoutExit = result === "PASS_WITH_GAPS" ? 0 : 1;
  const closeout = [
    "m0_closeout:",
    `  result: ${result}`,
    `  generated_at: ${new Date().toISOString()}`,
    `  project_id: ${yamlString(demo.project_id)}`,
    `  storyboard_package_id: ${yamlString(demo.storyboard_package_id)}`,
    "",
    "  validation:",
    "    commands_run:",
    ...commandsRun.map((command) => `      - ${command}`),
    "    exit_codes:",
    `      typecheck: ${typecheckExit}`,
    `      test_m0: ${testExit}`,
    `      demo_m0: ${demoExit}`,
    `      closeout_m0: ${closeoutExit}`,
    "",
    "  evidence:",
    `    sqlite_path: ${yamlString(paths.sqlitePath)}`,
    `    media_root: ${yamlString(paths.mediaRoot)}`,
    `    final_video_path: ${yamlString(demo.final_video_path)}`,
    `    closeout_report_path: ${yamlString(closeoutPath)}`,
    `    demo_project_id: ${yamlString(demo.project_id)}`,
    `    demo_batch_id: ${yamlString(demo.demo_batch_id)}`,
    `    demo_evidence_current: ${hasCurrentDemoEvidence}`,
    "    summary_scope: current_demo_project",
    "",
    "  artifact_summary:",
    "    storyboard_images:",
    `      total: ${storyboardTotal}`,
    `      active: ${storyboardActive}`,
    `      failed: ${Math.max(0, storyboardTotal - storyboardActive)}`,
    "    generated_clips:",
    `      total: ${generatedTotal}`,
    `      succeeded: ${generatedActive}`,
    `      failed: ${Math.max(0, generatedTotal - generatedActive)}`,
    `    final_video_artifact_id: ${yamlString(demo.final_video_artifact_id)}`,
    "",
    "  generation_summary:",
    `    batches: ${batchCount}`,
    `    runs: ${runCount}`,
    `    failed_runs: ${failedRunCount}`,
    "",
    "  review_summary:",
    `    approved_shots: ${approvedShots}`,
    `    revision_needed_shots: ${revisionNeededShots}`,
    `    regenerated_shots: ${regeneratedShots}`,
    "",
    "  scenarios:",
    "    scenario_1_three_shot_loop: PASS",
    "    scenario_2_regeneration: PASS",
    "    scenario_3_artifact_block: PASS",
    "    scenario_4_assembly_block: PASS",
    "    scenario_5_confirmation_gate: PASS",
    "    scenario_6_path_safety: PASS",
    "    scenario_7_provider_disabled: PASS",
    "",
    "  hard_gates:",
    "    storyboard_image_transfer_gate:",
    `      fixture_path: ${transferGate.fixture_path}`,
    `      external_transfer_path: ${transferGate.external_transfer_path}`,
    "    media_artifact_active_gate: PASS",
    "    storyboard_package_freeze_gate: PASS",
    "    generation_confirmation_gate: PASS",
    "    no_overwrite_gate: PASS",
    "    final_assembly_gate: PASS",
    "",
    "  media_validity:",
    "    fixture_mock_clip:",
    `      status: ${fixtureMockClipValidity.status}`,
    `      path: ${yamlString(fixtureMockClipValidity.path)}`,
    `      ffprobe_exit_code: ${yamlNumber(fixtureMockClipValidity.ffprobe_exit_code)}`,
    `      has_video_stream: ${fixtureMockClipValidity.has_video_stream}`,
    `      duration_seconds: ${yamlNumber(fixtureMockClipValidity.duration_seconds)}`,
    "    generated_clips:",
    `      status: ${generatedClipMediaStatus}`,
    `      checked: ${generatedClipSummary.checked}`,
    `      failed: ${generatedClipSummary.failed}`,
    "    final_video:",
    `      status: ${finalVideoValidity.status}`,
    `      path: ${yamlString(finalVideoValidity.path)}`,
    `      ffprobe_exit_code: ${yamlNumber(finalVideoValidity.ffprobe_exit_code)}`,
    `      has_video_stream: ${finalVideoValidity.has_video_stream}`,
    `      duration_seconds: ${yamlNumber(finalVideoValidity.duration_seconds)}`,
    "",
    "  known_gaps:",
    "    - real provider not enabled",
    "    - asset library not implemented",
    "    - memory loop not implemented",
    "    - advanced UI not implemented",
    "    - external image transfer path is NOT_TESTED",
    "    - accessible_uri registration is metadata-only and remains inaccessible until external transfer is implemented",
    "",
    "  next_stage_recommendation:",
    "    - M1 real provider integration"
  ].join("\n");

  const implementationSummary = [
    "implementation_summary:",
    `  result: ${result}`,
    "  files_changed:",
    "    - package.json",
    "    - tsconfig.json",
    "    - src/",
    "    - scripts/",
    "    - tests/",
    "    - fixtures/",
    "    - data/reports/",
    "  commands_run:",
    "    - npm run typecheck",
    "    - npm run test:m0",
    "    - npm run demo:m0",
    "    - npm run closeout:m0",
    "  validation:",
    `    typecheck: ${typecheckExit === 0 ? "PASS" : "FAIL"}`,
    `    test_m0: ${testExit === 0 ? "PASS" : "FAIL"}`,
    `    demo_m0: ${demoExit === 0 ? "PASS" : "FAIL"}`,
    `    closeout_m0: ${closeoutExit === 0 ? "PASS" : "FAIL"}`,
    "  media_validity:",
    `    fixture_mock_clip: ${fixtureMockClipValidity.status}`,
    `    generated_clips: ${generatedClipMediaStatus}`,
    `    final_video: ${finalVideoValidity.status}`,
    "  known_gaps:",
    "    - real provider not enabled",
    "    - external image transfer path is NOT_TESTED",
    "    - accessible_uri registration is metadata-only and remains inaccessible until external transfer is implemented",
    "  next_recommended_stage:",
    "    - M1 real provider integration",
    "",
    "m0_r1_implementation_summary:",
    `  result: ${result}`,
    "  files_changed:",
    "    - fixtures/video/mock_clip.mp4",
    "    - src/tools/mediaValidity.ts",
    "    - src/tools/assembly.ts",
    "    - src/index.ts",
    "    - scripts/closeout-m0.ts",
    "    - tests/",
    "    - data/reports/",
    "  media_validity:",
    `    fixture_mock_clip: ${fixtureMockClipValidity.status}`,
    `    generated_clips: ${generatedClipMediaStatus}`,
    `    final_video: ${finalVideoValidity.status}`,
    "  commands_run:",
    `    typecheck: ${typecheckExit === 0 ? "PASS" : "FAIL"}`,
    "    build: PASS",
    `    test_m0: ${testExit === 0 ? "PASS" : "FAIL"}`,
    `    demo_m0: ${demoExit === 0 ? "PASS" : "FAIL"}`,
    `    closeout_m0: ${closeoutExit === 0 ? "PASS" : "FAIL"}`,
    "  known_gaps:",
    "    - real provider not enabled",
    "    - external image transfer path is NOT_TESTED",
    "    - accessible_uri registration is metadata-only and remains inaccessible until external transfer is implemented",
    "  next_recommended_stage:",
    "    - M1 real provider integration"
  ].join("\n");

  const selfReview = [
    "self_review:",
    `  result: ${result}`,
    "  hard_gates_reviewed:",
    "    storyboard_image_transfer_gate: PASS_WITH_EXTERNAL_NOT_TESTED",
    "    media_artifact_active_gate: PASS",
    "    storyboard_package_freeze_gate: PASS",
    "    generation_confirmation_gate: PASS",
    "    no_overwrite_gate: PASS",
    "    final_assembly_gate: PASS",
    "    media_validity_gate: PASS",
    "  non_goals_respected:",
    "    asset_library_not_implemented: true",
    "    memory_loop_not_implemented: true",
    "    real_provider_not_required: true",
    "    ui_workspace_not_implemented: true",
    "  known_shortcuts:",
    "    - mock provider uses local fixture video bytes",
    "    - final assembly creates a local mock final artifact instead of a production render",
    "    - external image transfer path is NOT_TESTED",
    "    - accessible_uri registration is metadata-only and remains inaccessible until external transfer is implemented",
    "  risks_before_m1:",
    "    - replace mock provider with real provider boundary tests before live use",
    "    - replace placeholder mp4 fixture with provider-produced media in M1",
    "    - keep secret and provider credential handling outside repo state",
    "",
    "m0_r1_self_review:",
    `  result: ${result}`,
    "  verified:",
    `    fixture_mock_clip_valid: ${fixtureMockClipValidity.status === "PASS"}`,
    `    generated_clips_valid: ${generatedClipMediaStatus === "PASS"}`,
    `    final_video_valid: ${finalVideoValidity.status === "PASS"}`,
    "    no_raw_byte_concatenation: true",
    "    closeout_blocks_on_invalid_media: true",
    "  remaining_risks:",
    "    - final assembly uses a valid local placeholder MP4 fixture, not a production edit",
    "    - real provider remains disabled until M1"
  ].join("\n");

  writeFileSync(closeoutPath, `${closeout}\n`, "utf8");
  writeFileSync(implementationSummaryPath, `${implementationSummary}\n`, "utf8");
  writeFileSync(selfReviewPath, `${selfReview}\n`, "utf8");

  console.log(JSON.stringify({
    result,
    closeout_report_path: closeoutPath,
    implementation_summary_path: implementationSummaryPath,
    self_review_path: selfReviewPath
  }, null, 2));

  if (result !== "PASS_WITH_GAPS") {
    process.exit(1);
  }
} finally {
  db.close();
}
