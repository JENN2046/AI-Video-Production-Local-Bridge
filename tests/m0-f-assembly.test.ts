import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleFinalVideo,
  createProject,
  importStoryboardPackage,
  markShotClipReview,
  openM0Database,
  registerMediaArtifact,
  startStoryboardVideoGeneration
} from "../src/index.js";

async function setupApprovedProject(db: ReturnType<typeof openM0Database>) {
  const project = createProject({ title: "M0-F compatibility project" }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project failed");
  const snapshotArtifact = registerMediaArtifact({
    artifact_type: "image",
    role: "storyboard_image",
    source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
  }, db);
  assert.equal(snapshotArtifact.ok, true);
  if (!snapshotArtifact.ok) throw new Error("artifact failed");
  const storyboard = importStoryboardPackage({
    project_id: project.project_id,
    status: "approved_for_video_generation",
    approved_shot_snapshots: [{
      order: 1,
      duration_seconds: 2,
      storyboard_image_artifact_id: snapshotArtifact.artifact.artifact_id,
      video_prompt: "Animate the compatibility fixture"
    }],
    user_approval: { storyboard_approved: true }
  }, db);
  assert.equal(storyboard.ok, true);
  if (!storyboard.ok) throw new Error("storyboard failed");
  const generation = await startStoryboardVideoGeneration({
    project_id: project.project_id,
    confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
  }, db);
  assert.equal(generation.ok, true);
  if (!generation.ok) throw new Error("generation failed");
  const review = markShotClipReview({
    shot_id: storyboard.shots[0]!.shot_id,
    artifact_id: generation.runs[0]!.output.artifact_ids[0]!,
    decision: "approved"
  }, db);
  assert.equal(review.ok, true);
  return project.project_id;
}

test("M0-F durable assembly commits final media and delivery evidence", async () => {
  const db = openM0Database(":memory:");
  try {
    const projectId = await setupApprovedProject(db);
    const before = {
      project: db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(projectId),
      delivery: db.prepare("SELECT * FROM workbench_delivery_state WHERE project_id = ?").get(projectId),
      jobs: db.prepare("SELECT COUNT(*) count FROM workbench_delivery_jobs").get(),
      events: db.prepare("SELECT COUNT(*) count FROM workbench_delivery_events").get(),
      artifacts: db.prepare("SELECT COUNT(*) count FROM media_artifacts").get(),
      runs: db.prepare("SELECT COUNT(*) count FROM generation_runs").get()
    };

    const assembled = await assembleFinalVideo({
      project_id: projectId,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);

    assert.equal(assembled.ok, true);
    if (!assembled.ok) return;
    assert.equal(assembled.run.provider.provider_name, "local_assembly");
    const delivery = db.prepare(`SELECT workflow_state, current_final_artifact_id FROM workbench_delivery_state
      WHERE project_id = ?`).get(projectId) as { workflow_state: string; current_final_artifact_id: string };
    assert.equal(delivery.workflow_state, "final_review");
    assert.equal(delivery.current_final_artifact_id, assembled.final_video_artifact_id);
    assert.equal(
      JSON.parse((db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(projectId) as { data_json: string }).data_json)
        .exports.final_video_artifact_id,
      assembled.final_video_artifact_id
    );
    assert.equal((db.prepare("SELECT COUNT(*) count FROM workbench_delivery_jobs").get() as { count: number }).count,
      (before.jobs as { count: number }).count + 1);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM workbench_delivery_events").get() as { count: number }).count >
      (before.events as { count: number }).count, true);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM media_artifacts").get() as { count: number }).count,
      (before.artifacts as { count: number }).count + 1);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM generation_runs").get() as { count: number }).count,
      (before.runs as { count: number }).count + 1);
    assert.notDeepEqual(db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(projectId), before.project);
    assert.notDeepEqual(db.prepare("SELECT * FROM workbench_delivery_state WHERE project_id = ?").get(projectId), before.delivery);
  } finally {
    db.close();
  }
});
