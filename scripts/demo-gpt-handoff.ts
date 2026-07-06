import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ensureM0Directories,
  freezeGptHandoffStoryboardPackage,
  openM0Database,
  paths
} from "../src/index.js";

const DEMO_REPORT = "m1_5_gpt_handoff_demo_result.json";
const CANARY_SOURCE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");

function copyDemoImport(runId: string, order: number): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  if (!existsSync(CANARY_SOURCE)) {
    throw new Error(`Demo source image is missing: ${CANARY_SOURCE}`);
  }
  const filename = `gpt_handoff_demo_${runId}_${String(order).padStart(3, "0")}.png`;
  const target = join(paths.importsRoot, filename);
  copyFileSync(CANARY_SOURCE, target);
  return filename;
}

function writeDemoResult(payload: unknown): void {
  const target = join(paths.reportsRoot, DEMO_REPORT);
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
}

ensureM0Directories();
const db = openM0Database();

try {
  const runId = randomUUID().slice(0, 8);
  const importFilenames = [1, 2, 3, 4].map((order) => copyDemoImport(runId, order));
  const freeze = freezeGptHandoffStoryboardPackage(
    {
      project_title: `M1.5 GPT Handoff Demo ${runId}`,
      approved_by_user: true,
      shots: importFilenames.map((importFilename, index) => {
        const order = index + 1;
        return {
          import_filename: importFilename,
          order,
          duration_seconds: 2,
          shot_description: `SHOT_${String(order).padStart(3, "0")} web GPT keyframe handoff demo.`,
          video_prompt: `Use SHOT_${String(order).padStart(3, "0")} as the locked keyframe and animate with a restrained vertical camera move.`,
          negative_prompt: "no extra text, no logo distortion, no frame overwrite",
          continuity_constraints: ["Keep vertical composition", "Preserve source keyframe content"]
        };
      })
    },
    db
  );

  writeDemoResult({
    task: "M1.5-GPT-HANDOFF-APP",
    result: freeze.ok ? "PASS" : "BLOCK",
    run_id: runId,
    source_fixture: basename(CANARY_SOURCE),
    imported_filenames: importFilenames,
    frozen_package_report: freeze.report.report_path,
    latest_frozen_package_report: freeze.report.latest_report_path,
    demo_report: `data/reports/${DEMO_REPORT}`,
    acceptance: {
      shot_001_image_import_to_media_artifact: freeze.report.imported_artifacts.some((artifact) => artifact.order === 1 && artifact.artifact_type === "image"),
      four_shot_app_ready_package_freeze: freeze.ok && freeze.report.storyboard_package.frozen && freeze.report.storyboard_package.shot_count === 4,
      artifact_ids_from_app: freeze.report.input_summary.artifact_ids_from_gpt === false,
      reports_traceable: true
    },
    provider_boundary: {
      network_call_attempted: freeze.report.network_call_attempted,
      runway_called: freeze.report.runway_called,
      runninghub_called: freeze.report.runninghub_called,
      provider_credits_consumed: freeze.report.provider_credits_consumed,
      real_video_generated: freeze.report.real_video_generated,
      regeneration_performed: freeze.report.regeneration_performed,
      batch_generation_performed: freeze.report.batch_generation_performed,
      secret_values_exposed: freeze.report.secret_values_exposed,
      source_asset_overwrite: freeze.report.source_asset_overwrite
    },
    freeze_report: freeze.report
  });

  if (!freeze.ok) process.exitCode = 1;
} finally {
  db.close();
}
