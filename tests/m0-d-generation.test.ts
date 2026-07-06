import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  createProject,
  getGenerationStatus,
  getMediaArtifact,
  importStoryboardPackage,
  openM0Database,
  registerMediaArtifact,
  startStoryboardVideoGeneration
} from "../src/index.js";

function setupThreeShotProject(db: ReturnType<typeof openM0Database>) {
  const project = createProject({ title: "M0-D Three Shot" }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project setup failed");

  const snapshots = ["shot_001.png", "shot_002.png", "shot_003.png"].map((filename, index) => {
    const artifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: `storyboard/${filename}` }
      },
      db
    );
    assert.equal(artifact.ok, true);
    if (!artifact.ok) throw new Error("artifact setup failed");
    return {
      order: index + 1,
      duration_seconds: 2,
      description: `Shot ${index + 1}`,
      storyboard_image_artifact_id: artifact.artifact.artifact_id,
      video_prompt: `Animate shot ${index + 1}`,
      negative_prompt: "blur"
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
  if (!storyboard.ok) throw new Error("storyboard setup failed");
  return { project, storyboard };
}

test("M0-D generation requires hard gate confirmation", async () => {
  const db = openM0Database();

  try {
    const { project } = setupThreeShotProject(db);
    const result = await startStoryboardVideoGeneration({ project_id: project.project_id }, db);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "HARD_GATE_CONFIRMATION_REQUIRED");
  } finally {
    db.close();
  }
});

test("M0-D three-shot mock generation creates one batch and three runs", async () => {
  const db = openM0Database();

  try {
    const { project } = setupThreeShotProject(db);
    const result = await startStoryboardVideoGeneration(
      {
        project_id: project.project_id,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.batch.summary.total, 3);
    assert.equal(result.batch.summary.succeeded, 3);
    assert.equal(result.batch.run_ids.length, 3);
    assert.equal(result.runs.length, 3);
    assert.equal(result.runs.every((run) => (run.status as string) !== "partially_failed"), true);

    for (const run of result.runs) {
      assert.equal(run.output.artifact_ids.length, 1);
      const artifact = getMediaArtifact(db, run.output.artifact_ids[0]);
      assert.equal(artifact?.status, "active");
      assert.equal(artifact?.role, "generated_clip");
      assert.equal(artifact?.artifact_type, "video");
      assert.equal(existsSync(artifact?.storage.uri ?? ""), true);
      assert.equal(readFileSync(artifact?.storage.uri ?? "").length > 0, true);
    }
  } finally {
    db.close();
  }
});

test("M0-D get_generation_status supports project, batch, and run queries", async () => {
  const db = openM0Database();

  try {
    const { project } = setupThreeShotProject(db);
    const generation = await startStoryboardVideoGeneration(
      {
        project_id: project.project_id,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(generation.ok, true);
    if (!generation.ok) return;

    const byBatch = getGenerationStatus({ batch_id: generation.batch.batch_id }, db);
    assert.equal(byBatch.ok, true);
    const batchRuns = byBatch.ok && "runs" in byBatch ? byBatch.runs : undefined;
    assert.equal(batchRuns?.length, 3);

    const byRun = getGenerationStatus({ run_id: generation.runs[0].run_id }, db);
    assert.equal(byRun.ok, true);
    const run = byRun.ok && "run" in byRun ? byRun.run : undefined;
    assert.equal(run?.run_id, generation.runs[0].run_id);

    const byProject = getGenerationStatus({ project_id: project.project_id }, db);
    assert.equal(byProject.ok, true);
    const projectRuns = byProject.ok && "runs" in byProject ? byProject.runs : undefined;
    assert.equal(projectRuns?.length, 3);
  } finally {
    db.close();
  }
});
