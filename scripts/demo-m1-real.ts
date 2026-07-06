import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  assembleFinalVideo,
  createProject,
  ensureM0Directories,
  getMediaArtifact,
  importStoryboardPackage,
  loadProviderEnvLocal,
  markShotClipReview,
  openM0Database,
  paths,
  realCommandReadiness,
  registerMediaArtifact,
  regenerateShotVideo,
  startStoryboardVideoGeneration
} from "../src/index.js";

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function writeImportImage(filename: string): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  const target = join(paths.importsRoot, filename);
  writeFileSync(target, SAMPLE_PNG);
  return target;
}

function writeResult(payload: unknown): void {
  writeFileSync(join(paths.reportsRoot, "m1_real_demo_result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
}

ensureM0Directories();
loadProviderEnvLocal();
const readiness = realCommandReadiness();
if (!readiness.ok) {
  writeResult({
    phase: "M1-real-demo",
    result: readiness.status,
    provider_name: readiness.provider_name,
    missing: readiness.missing,
    real_provider_called: false,
    provider_credits_consumed: false
  });
  process.exit(0);
}

const db = openM0Database();
try {
  const providerName = readiness.provider_name;
  const project = createProject({ title: `M1 Real Demo ${providerName}` }, db);
  if (!project.ok) throw new Error(project.error.message);

  const imagePath = writeImportImage(`m1_real_${providerName}_single.png`);
  const storyboardArtifact = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "local_file_import", import_filename: basename(imagePath) }
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
          duration_seconds: 5,
          description: "M1 real provider single shot",
          storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
          video_prompt: "Animate the simple storyboard image with a gentle camera push."
        }
      ],
      user_approval: { storyboard_approved: true }
    },
    db
  );
  if (!storyboard.ok) throw new Error(storyboard.error.message);

  const single = await startStoryboardVideoGeneration(
    {
      project_id: project.project_id,
      provider_execution: { provider: "real", provider_name: providerName, cost_acknowledged: true },
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  if (!single.ok) throw new Error(single.error.message);
  const firstRun = single.runs[0];
  const firstArtifactId = firstRun.output.artifact_ids[0] ?? "";
  const firstArtifact = firstArtifactId ? getMediaArtifact(db, firstArtifactId) : null;

  let regenerationStatus = "NOT_RUN";
  let secondRunId = "";
  let secondArtifactId = "";
  let finalVideoArtifactId = "";

  if (firstRun.status === "succeeded" && firstArtifactId) {
    const rejected = markShotClipReview(
      {
        shot_id: firstRun.shot_id,
        artifact_id: firstArtifactId,
        decision: "revision_needed",
        rejection_reasons: ["M1 real demo regeneration proof"],
        revision_instruction: {
          summary: "Regenerate for M1 proof",
          prompt_delta: "slightly more camera motion",
          negative_delta: "",
          priority: "medium"
        }
      },
      db
    );
    if (!rejected.ok) throw new Error(rejected.error.message);

    const regenerated = await regenerateShotVideo(
      {
        shot_id: firstRun.shot_id,
        previous_run_id: firstRun.run_id,
        updated_prompt: "Animate the simple storyboard image with slightly more camera motion.",
        provider_execution: { provider: "real", provider_name: providerName, cost_acknowledged: true },
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    if (!regenerated.ok) throw new Error(regenerated.error.message);
    regenerationStatus = regenerated.run.status === "succeeded" ? "PASS" : "PROVIDER_FAILED";
    secondRunId = regenerated.run.run_id;
    secondArtifactId = regenerated.artifact_id;

    if (regenerated.run.status === "succeeded" && regenerated.artifact_id) {
      const approved = markShotClipReview({ shot_id: firstRun.shot_id, artifact_id: regenerated.artifact_id, decision: "approved" }, db);
      if (!approved.ok) throw new Error(approved.error.message);
      const assembled = assembleFinalVideo(
        {
          project_id: project.project_id,
          confirmation: { confirmation_level: "explicit", user_confirmed: true }
        },
        db
      );
      if (assembled.ok) finalVideoArtifactId = assembled.final_video_artifact_id;
    }
  }

  writeResult({
    phase: "M1-real-demo",
    result: firstRun.status === "succeeded" ? "PASS_WITH_GAPS" : "PROVIDER_FAILED",
    provider_name: providerName,
    real_provider_called: true,
    project_id: project.project_id,
    storyboard_package_id: storyboard.storyboard_package_id,
    single_shot: {
      status: firstRun.status === "succeeded" ? "PASS" : "PROVIDER_FAILED",
      run_id: firstRun.run_id,
      provider_job_id: firstRun.provider.provider_job_id,
      artifact_id: firstArtifactId || null,
      artifact_source_provider: firstArtifact?.source.provider ?? null,
      error_code: firstRun.error.code || null
    },
    regeneration: {
      status: regenerationStatus,
      first_run_id: firstRun.run_id,
      second_run_id: secondRunId || null,
      second_artifact_id: secondArtifactId || null
    },
    batch_generation: {
      status: "NOT_TESTED",
      note: "demo:m1:real performs single-shot and regeneration only to limit provider spend."
    },
    final_video_artifact_id: finalVideoArtifactId || null
  });
} finally {
  db.close();
}
