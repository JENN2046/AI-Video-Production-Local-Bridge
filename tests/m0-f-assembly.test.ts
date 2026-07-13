import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  assembleFinalVideo,
  createProject,
  getMediaArtifact,
  getProject,
  getShot,
  importStoryboardPackage,
  markShotClipReview,
  openM0Database,
  registerMediaArtifact,
  saveShot,
  startStoryboardVideoGeneration
} from "../src/index.js";

async function setupGeneratedProject(db: ReturnType<typeof openM0Database>) {
  const project = createProject({ title: "M0-F Project" }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project failed");
  const snapshots = [1, 2, 3].map((_, index) => {
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
    return {
      order: index + 1,
      duration_seconds: 2,
      storyboard_image_artifact_id: artifact.artifact.artifact_id,
      video_prompt: `Animate shot ${index + 1}`
    };
  });
  const storyboard = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: snapshots,
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
  return { project, storyboard, generation };
}

test("M0-F assembly requires explicit confirmation", async () => {
  const db = openM0Database();

  try {
    const { project } = await setupGeneratedProject(db);
    const assembled = assembleFinalVideo({ project_id: project.project_id }, db);
    assert.equal(assembled.ok, false);
    if (assembled.ok) return;
    assert.equal(assembled.error.code, "USER_CONFIRMATION_REQUIRED");
  } finally {
    db.close();
  }
});

test("M0-F assembly blocks before all shots are approved", async () => {
  const db = openM0Database();

  try {
    const { project, storyboard, generation } = await setupGeneratedProject(db);
    for (const shot of storyboard.shots.slice(0, 2)) {
      const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      const review = markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db);
      assert.equal(review.ok, true);
    }

    const assembled = assembleFinalVideo(
      {
        project_id: project.project_id,
        confirmation: { confirmation_level: "explicit", user_confirmed: true }
      },
      db
    );
    assert.equal(assembled.ok, false);
    if (assembled.ok) return;
    assert.equal(assembled.error.code, "FINAL_ASSEMBLY_NOT_READY");
    assert.equal(assembled.blocking_reasons?.some((reason) => reason.includes("Shot 003")), true);
  } finally {
    db.close();
  }
});

test("M0-F assembly succeeds after all shots are approved", async () => {
  const db = openM0Database();

  try {
    const { project, storyboard, generation } = await setupGeneratedProject(db);
    for (const shot of storyboard.shots) {
      const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      const review = markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db);
      assert.equal(review.ok, true);
    }

    const assembled = assembleFinalVideo(
      {
        project_id: project.project_id,
        confirmation: { confirmation_level: "explicit", user_confirmed: true }
      },
      db
    );
    assert.equal(assembled.ok, true);
    if (!assembled.ok) return;
    const artifact = getMediaArtifact(db, assembled.final_video_artifact_id);
    assert.equal(artifact?.role, "final_video");
    assert.equal(artifact?.artifact_type, "video");
    assert.equal(artifact?.status, "active");
    assert.equal(existsSync(artifact?.storage.uri ?? ""), true);
    assert.equal(readFileSync(artifact?.storage.uri ?? "").length > 0, true);
    assert.equal(getProject(db, project.project_id)?.exports.final_video_artifact_id, assembled.final_video_artifact_id);
  } finally {
    db.close();
  }
});

test("M0-F assembly rejects an accepted clip that is not in the SHOT version stack", async () => {
  const db = openM0Database();

  try {
    const { project, storyboard, generation } = await setupGeneratedProject(db);
    for (const shot of storyboard.shots) {
      const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      const review = markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db);
      assert.equal(review.ok, true);
    }
    const target = getShot(db, storyboard.shots[0].shot_id);
    assert.ok(target);
    if (!target) return;
    const stale = registerMediaArtifact({
      artifact_type: "video",
      role: "generated_clip",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id, shot_id: target.shot_id }
    }, db);
    assert.equal(stale.ok, true);
    if (!stale.ok) return;
    target.accepted_clip_artifact_id = stale.artifact.artifact_id;
    saveShot(db, target);

    const assembled = assembleFinalVideo({
      project_id: project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(assembled.ok, false);
    if (!assembled.ok) {
      assert.equal(assembled.error.code, "FINAL_ASSEMBLY_NOT_READY");
      assert.equal(assembled.blocking_reasons?.some((reason) => reason.includes("ARTIFACT_NOT_IN_SHOT_REVIEW")), true);
    }
  } finally {
    db.close();
  }
});
