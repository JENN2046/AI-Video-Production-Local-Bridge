import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  getMediaArtifact,
  getShot,
  importStoryboardPackage,
  markShotClipReview,
  openM0Database,
  regenerateShotVideo,
  registerMediaArtifact,
  startStoryboardVideoGeneration
} from "../src/index.js";

async function setupGeneratedShot(db: ReturnType<typeof openM0Database>) {
  const project = createProject({ title: "M0-E Project" }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project failed");
  const artifact = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
    },
    db
  );
  assert.equal(artifact.ok, true);
  if (!artifact.ok) throw new Error("artifact failed");
  const storyboard = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [
        {
          order: 1,
          duration_seconds: 2,
          storyboard_image_artifact_id: artifact.artifact.artifact_id,
          video_prompt: "Animate shot"
        }
      ],
      user_approval: { storyboard_approved: true }
    },
    db
  );
  assert.equal(storyboard.ok, true);
  if (!storyboard.ok) throw new Error("storyboard failed");
  const generation = await startStoryboardVideoGeneration(
    {
      project_id: project.project_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  assert.equal(generation.ok, true);
  if (!generation.ok) throw new Error("generation failed");
  const shot = storyboard.shots[0];
  const run = generation.runs[0];
  const artifactId = run.output.artifact_ids[0];
  return { project, shot, run, artifactId };
}

test("M0-E approved review sets accepted clip", async () => {
  const db = openM0Database();

  try {
    const { shot, artifactId } = await setupGeneratedShot(db);
    const review = markShotClipReview({ shot_id: shot.shot_id, artifact_id: artifactId, decision: "approved" }, db);
    assert.equal(review.ok, true);
    if (!review.ok) return;
    assert.equal(review.shot.status, "approved");
    assert.equal(review.shot.accepted_clip_artifact_id, artifactId);
    assert.equal(review.shot.clip_versions[0].review_status, "approved");
  } finally {
    db.close();
  }
});

test("M0-E revision_needed saves rejection and regeneration preserves old artifact", async () => {
  const db = openM0Database();

  try {
    const { shot, run, artifactId } = await setupGeneratedShot(db);
    const oldArtifact = getMediaArtifact(db, artifactId);
    const rejected = markShotClipReview(
      {
        shot_id: shot.shot_id,
        artifact_id: artifactId,
        decision: "revision_needed",
        rejection_reasons: ["too static"],
        revision_instruction: {
          summary: "More motion",
          prompt_delta: "add faster camera movement",
          negative_delta: "static",
          priority: "high"
        }
      },
      db
    );
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    assert.equal(rejected.shot.status, "revision_needed");
    assert.equal(rejected.shot.clip_versions[0].review_status, "rejected");

    const missingGate = await regenerateShotVideo({ shot_id: shot.shot_id, previous_run_id: run.run_id, updated_prompt: "More motion" }, db);
    assert.equal(missingGate.ok, false);
    if (missingGate.ok) return;
    assert.equal(missingGate.error.code, "HARD_GATE_CONFIRMATION_REQUIRED");

    const regenerated = await regenerateShotVideo(
      {
        shot_id: shot.shot_id,
        previous_run_id: run.run_id,
        updated_prompt: "More motion",
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(regenerated.ok, true);
    if (!regenerated.ok) return;
    assert.equal(regenerated.run.versioning.attempt_number, 2);
    assert.equal(regenerated.run.versioning.parent_run_id, run.run_id);
    assert.notEqual(regenerated.artifact_id, artifactId);
    assert.deepEqual(getMediaArtifact(db, artifactId), oldArtifact);

    const approved = markShotClipReview({ shot_id: shot.shot_id, artifact_id: regenerated.artifact_id, decision: "approved" }, db);
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.shot.accepted_clip_artifact_id, regenerated.artifact_id);
    assert.deepEqual(
      getShot(db, shot.shot_id)?.clip_versions.map((version) => version.review_status),
      ["rejected", "approved"]
    );
  } finally {
    db.close();
  }
});

test("legacy regeneration cannot submit to a real Provider outside the persisted worker", async () => {
  const db = openM0Database();
  try {
    const { shot, run } = await setupGeneratedShot(db);
    const result = await regenerateShotVideo({
      shot_id: shot.shot_id,
      previous_run_id: run.run_id,
      updated_prompt: "Do not submit this legacy regeneration",
      provider_execution: { provider: "real", provider_name: "runninghub", cost_acknowledged: true },
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "LEGACY_REGENERATION_RETIRED");
  } finally {
    db.close();
  }
});
