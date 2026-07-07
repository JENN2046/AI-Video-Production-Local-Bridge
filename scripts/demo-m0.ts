import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createProject,
  assembleFinalVideo,
  getGenerationStatus,
  getMediaArtifact,
  getStoryboardImageTransferGate,
  importStoryboardPackage,
  listM0Tools,
  markShotClipReview,
  openM0Database,
  paths,
  registerMediaArtifact,
  regenerateShotVideo,
  startStoryboardVideoGeneration
} from "../src/index.js";

const db = openM0Database();

try {
  const project = createProject({ title: "M0 Demo Project" }, db);
  if (!project.ok) {
    throw new Error("M0 demo setup failed.");
  }
  const storyboardArtifacts = [1, 2, 3].map(() => {
    const artifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "fixture_path",
          path: "provider-canary/m1-r0/shot_001_canary_720x1280.png"
        }
      },
      db
    );
    if (!artifact.ok) throw new Error(artifact.error.message);
    return artifact.artifact;
  });
  const storyboardPackage = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: storyboardArtifacts.map((artifact, index) => ({
        order: index + 1,
        duration_seconds: 2,
        description: `Shot ${index + 1}`,
        storyboard_image_artifact_id: artifact.artifact_id,
        video_prompt: `Animate storyboard shot ${index + 1} with a slow push-in.`,
        negative_prompt: "blur"
      })),
      user_approval: { storyboard_approved: true }
    },
    db
  );
  if (!storyboardPackage.ok) throw new Error(storyboardPackage.error.message);
  const generation = await startStoryboardVideoGeneration(
    {
      project_id: project.project_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  if (!generation.ok) throw new Error(generation.error.message);
  const firstRunByShot = new Map(generation.runs.map((run) => [run.shot_id, run]));
  const firstGeneratedArtifactByShot = new Map(generation.runs.map((run) => [run.shot_id, run.output.artifact_ids[0]]));
  const secondShot = storyboardPackage.shots[1];
  const secondShotFirstRun = firstRunByShot.get(secondShot.shot_id);
  const secondShotFirstArtifact = firstGeneratedArtifactByShot.get(secondShot.shot_id);
  if (!secondShotFirstRun || !secondShotFirstArtifact) throw new Error("Missing shot 002 generated artifact.");

  for (const shot of storyboardPackage.shots) {
    const artifactId = firstGeneratedArtifactByShot.get(shot.shot_id);
    if (!artifactId) throw new Error("Missing generated artifact.");
    if (shot.shot_id === secondShot.shot_id) {
      const rejected = markShotClipReview(
        {
          shot_id: shot.shot_id,
          artifact_id: artifactId,
          decision: "revision_needed",
          rejection_reasons: ["motion too static"],
          revision_instruction: {
            summary: "Increase motion",
            prompt_delta: "add faster camera movement",
            negative_delta: "static",
            priority: "medium"
          }
        },
        db
      );
      if (!rejected.ok) throw new Error(rejected.error.message);
      continue;
    }
    const approved = markShotClipReview({ shot_id: shot.shot_id, artifact_id: artifactId, decision: "approved" }, db);
    if (!approved.ok) throw new Error(approved.error.message);
  }

  const regenerated = await regenerateShotVideo(
    {
      shot_id: secondShot.shot_id,
      previous_run_id: secondShotFirstRun.run_id,
      updated_prompt: "Animate storyboard shot 2 with faster camera movement.",
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  if (!regenerated.ok) throw new Error(regenerated.error.message);
  const approvedRevision = markShotClipReview({ shot_id: secondShot.shot_id, artifact_id: regenerated.artifact_id, decision: "approved" }, db);
  if (!approvedRevision.ok) throw new Error(approvedRevision.error.message);
  const finalAssembly = assembleFinalVideo(
    {
      project_id: project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    },
    db
  );
  if (!finalAssembly.ok) throw new Error(finalAssembly.error.message);
  const finalArtifact = getMediaArtifact(db, finalAssembly.final_video_artifact_id);
  const generationStatus = getGenerationStatus({ batch_id: generation.batch.batch_id }, db);

  const payload = {
    phase: "M0-F",
    result: "PASS",
    project_id: project.project_id,
    storyboard_package_id: storyboardPackage.storyboard_package_id,
    demo_batch_id: generation.batch.batch_id,
    generated_runs: generation.runs.length,
    regenerated_shot_id: secondShot.shot_id,
    regenerated_artifact_id: regenerated.artifact_id,
    final_video_artifact_id: finalAssembly.final_video_artifact_id,
    final_video_path: finalArtifact?.storage.uri ?? null,
    generation_status: generationStatus.ok ? "PASS" : "FAIL",
    sqlite_path: paths.sqlitePath,
    media_root: paths.mediaRoot,
    tools_registered: listM0Tools().map((tool) => tool.name),
    fixture_transfer: "PASS",
    storyboard_import: "PASS",
    storyboard_image_transfer_gate: getStoryboardImageTransferGate(),
    note: "M0-F validates review, regeneration, and final assembly."
  };

  writeFileSync(join(paths.reportsRoot, "m0_demo_result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
} finally {
  db.close();
}
