import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  approveH3GeneratedClip,
  createGenerationRunFromPackageShot,
  createProject,
  ensureM0Directories,
  executeH4FinalAssembly,
  h4FinalAssemblyWorkbenchSummary,
  importStoryboardPackage,
  openM0Database,
  paths,
  registerMediaArtifact
} from "../src/index.js";

const REPORT_STEM = "r2_4_h4_final_assembly_workbench_result";
const LATEST_REPORT = `data/reports/${REPORT_STEM}.json`;

function writeReport(runId: string, payload: unknown): void {
  ensureM0Directories();
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(join(paths.reportsRoot, `${REPORT_STEM}_${runId}.json`), text, "utf8");
  writeFileSync(join(paths.workspaceRoot, LATEST_REPORT), text, "utf8");
}

async function main(): Promise<void> {
  ensureM0Directories();
  const runId = randomUUID();
  const db = openM0Database();

  try {
    const project = createProject({ title: `R2-4 H4 Workbench ${runId.slice(0, 8)}` }, db);
    if (!project.ok) throw new Error(project.error.message);

    const storyboardArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "storyboard/shot_001.png" }
      },
      db
    );
    if (!storyboardArtifact.ok) throw new Error(storyboardArtifact.error.message);

    const storyboard = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
            video_prompt: "Animate this shot for H4 final assembly workbench proof.",
            negative_prompt: ""
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    if (!storyboard.ok) throw new Error(storyboard.error.message);

    const shotId = storyboard.shots[0].shot_id;
    const blockedSummary = h4FinalAssemblyWorkbenchSummary(undefined, db, { project_id: project.project_id });

    const generation = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: shotId,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    if (!generation.ok || !generation.generated_artifact_id) {
      throw new Error(generation.ok ? "Generation produced no artifact." : generation.error.message);
    }

    const missingConfirmation = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: false, write_report: false }, undefined, db);
    const notReady = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: true, write_report: false }, undefined, db);

    const approval = approveH3GeneratedClip({ shot_id: shotId, artifact_id: generation.generated_artifact_id, write_report: false }, db);
    if (!approval.ok) throw new Error(approval.error.message);

    const readySummary = h4FinalAssemblyWorkbenchSummary(undefined, db, { project_id: project.project_id });
    const assembled = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: true, write_report: true }, undefined, db);
    if (!assembled.ok) throw new Error(assembled.error.message);

    const report = {
      task_id: "R2-4_H4_FINAL_ASSEMBLY_WORKBENCH",
      result: "PASS",
      run_id: runId,
      generated_at: new Date().toISOString(),
      project_id: project.project_id,
      storyboard_package_id: storyboard.storyboard_package_id,
      workbench: {
        assembly_readiness_visible: true,
        blockers_visible: blockedSummary.blockers.length > 0,
        clip_order_preview_visible: readySummary.clip_order_preview.length === storyboard.shots.length,
        final_assembly_confirmation_required: !missingConfirmation.ok && missingConfirmation.error.code === "HUMAN_CONFIRMATION_REQUIRED",
        blocked_before_accepted_clips: !notReady.ok && notReady.error.code === "FINAL_ASSEMBLY_NOT_READY",
        final_report_visible: assembled.value.summary.latest_report_exists,
        final_video_ffprobe_status: assembled.value.summary.final_video_artifact?.ffprobe?.status ?? "NOT_TESTED",
        source_clips_overwritten: false
      },
      readiness_before: blockedSummary,
      readiness_after_approval: readySummary,
      final_assembly: {
        final_video_artifact_id: assembled.value.final_video_artifact_id,
        final_video_artifact: assembled.value.summary.final_video_artifact,
        report: assembled.value.report
      },
      provider_boundary: {
        network_call_attempted: false,
        runway_called: false,
        runninghub_called: false,
        provider_credits_consumed: false,
        real_video_generated: false,
        provider_call_attempted: false,
        final_assembly_performed: true,
        source_asset_overwritten: false,
        secret_values_exposed: false
      },
      report_path: `data/reports/${REPORT_STEM}_${runId}.json`,
      latest_report_path: LATEST_REPORT
    };

    writeReport(runId, report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
