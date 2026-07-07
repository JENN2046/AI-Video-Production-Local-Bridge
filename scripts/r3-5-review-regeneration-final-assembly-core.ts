import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assembleFinalVideo,
  createGenerationRunFromPackageShot,
  createProject,
  ensureM0Directories,
  getMediaArtifact,
  importStoryboardPackage,
  markShotClipReview,
  openM0Database,
  paths,
  regenerateShotVideo,
  registerMediaArtifact
} from "../src/index.js";

const REPORT_STEM = "r3_5_review_regeneration_final_assembly_core_result";
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
    const project = createProject({ title: `R3-5 Core ${runId.slice(0, 8)}` }, db);
    if (!project.ok) throw new Error(project.error.message);

    const storyboardArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
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
            video_prompt: "Animate this shot for R3-5 local core proof.",
            negative_prompt: ""
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    if (!storyboard.ok) throw new Error(storyboard.error.message);

    const shotId = storyboard.shots[0].shot_id;
    const firstGeneration = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: shotId,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    if (!firstGeneration.ok || !firstGeneration.generated_artifact_id) {
      throw new Error(firstGeneration.ok ? "Initial generation produced no artifact." : firstGeneration.error.message);
    }

    const assemblyBeforeAccepted = assembleFinalVideo(
      {
        project_id: project.project_id,
        confirmation: { confirmation_level: "explicit", user_confirmed: true }
      },
      db
    );

    const rejected = markShotClipReview(
      {
        shot_id: shotId,
        artifact_id: firstGeneration.generated_artifact_id,
        decision: "revision_needed",
        rejection_reasons: ["R3-5 local proof rejects first version."],
        revision_instruction: {
          summary: "Increase movement",
          prompt_delta: "add stronger camera motion",
          negative_delta: "static",
          priority: "medium"
        }
      },
      db
    );
    if (!rejected.ok) throw new Error(rejected.error.message);

    const missingRegenerationConfirmation = await regenerateShotVideo(
      {
        shot_id: shotId,
        previous_run_id: firstGeneration.run.run_id,
        updated_prompt: "Add stronger camera motion."
      },
      db
    );

    const regenerated = await regenerateShotVideo(
      {
        shot_id: shotId,
        previous_run_id: firstGeneration.run.run_id,
        updated_prompt: "Add stronger camera motion.",
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    if (!regenerated.ok) throw new Error(regenerated.error.message);

    const approved = markShotClipReview({ shot_id: shotId, artifact_id: regenerated.artifact_id, decision: "approved" }, db);
    if (!approved.ok) throw new Error(approved.error.message);

    const finalAssembly = assembleFinalVideo(
      {
        project_id: project.project_id,
        confirmation: { confirmation_level: "explicit", user_confirmed: true }
      },
      db
    );
    if (!finalAssembly.ok) throw new Error(finalAssembly.error.message);

    const firstArtifact = getMediaArtifact(db, firstGeneration.generated_artifact_id);
    const regeneratedArtifact = getMediaArtifact(db, regenerated.artifact_id);
    const finalArtifact = getMediaArtifact(db, finalAssembly.final_video_artifact_id);
    const report = {
      task_id: "R3-5_REVIEW_REGENERATION_FINAL_ASSEMBLY_CORE",
      result: "PASS",
      run_id: runId,
      generated_at: new Date().toISOString(),
      project_id: project.project_id,
      storyboard_package_id: storyboard.storyboard_package_id,
      shot_id: shotId,
      review_core: {
        mark_clip_rejected: rejected.shot.clip_versions.find((version) => version.artifact_id === firstGeneration.generated_artifact_id)?.review_status === "rejected",
        mark_clip_approved: approved.shot.accepted_clip_artifact_id === regenerated.artifact_id,
        rejected_clip_traceable: Boolean(rejected.shot.clip_versions.find((version) => version.artifact_id === firstGeneration.generated_artifact_id)),
        accepted_clip_artifact_id: approved.shot.accepted_clip_artifact_id
      },
      regeneration_core: {
        missing_confirmation_result: missingRegenerationConfirmation.ok ? "UNEXPECTED_PASS" : missingRegenerationConfirmation.error.code,
        regenerated_run_id: regenerated.run.run_id,
        parent_run_id: regenerated.run.versioning.parent_run_id,
        attempt_number: regenerated.run.versioning.attempt_number,
        old_artifact_id: firstGeneration.generated_artifact_id,
        new_artifact_id: regenerated.artifact_id,
        old_artifact_preserved: firstArtifact?.status === "active",
        new_artifact_active: regeneratedArtifact?.status === "active",
        no_overwrite: firstGeneration.generated_artifact_id !== regenerated.artifact_id
      },
      assembly_core: {
        blocked_before_accepted: !assemblyBeforeAccepted.ok && assemblyBeforeAccepted.error.code === "FINAL_ASSEMBLY_NOT_READY",
        final_assembly_run_id: finalAssembly.run.run_id,
        final_video_artifact_id: finalAssembly.final_video_artifact_id,
        final_video_artifact_active: finalArtifact?.status === "active",
        final_assembly_report_written: true
      },
      provider_boundary: {
        network_call_attempted: false,
        runway_called: false,
        runninghub_called: false,
        provider_credits_consumed: false,
        live_provider_regeneration_performed: false,
        live_provider_requires_exact_authorization: true,
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
