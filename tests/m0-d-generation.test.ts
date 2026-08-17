import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  createProject,
  getGenerationStatus,
  getMediaArtifact,
  getShot,
  importStoryboardPackage,
  openM0Database,
  registerMediaArtifact,
  saveShot,
  startStoryboardVideoGeneration
} from "../src/index.js";
import {
  approveWorkbenchDeliveryFixture,
  completeWorkbenchAssemblyFixture,
  completeWorkbenchExportFixture,
  ensureAcceptedAssemblyClipsFixture,
  insertWorkbenchExportFixture
} from "./workbench-delivery-test-helpers.js";

function setupThreeShotProject(db: ReturnType<typeof openM0Database>) {
  const project = createProject({ title: "M0-D Three Shot" }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project setup failed");

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

test("M0-D generation rejects stale package inputs before creating a run", async () => {
  const db = openM0Database();
  try {
    const { project, storyboard } = setupThreeShotProject(db);
    const shot = getShot(db, storyboard.shots[0].shot_id);
    assert.ok(shot);
    if (!shot) return;
    shot.video_prompt = "Changed after Storyboard Package freeze.";
    saveShot(db, shot);
    const result = await startStoryboardVideoGeneration({
      project_id: project.project_id,
      selected_shot_ids: [shot.shot_id],
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "STORYBOARD_PACKAGE_INPUT_STALE");
    const runCount = db.prepare("SELECT COUNT(*) AS count FROM generation_runs WHERE project_id = ?").get(project.project_id) as { count: number };
    assert.equal(runCount.count, 0);
  } finally {
    db.close();
  }
});

test("M0-D generation cannot bypass a pending-review operational gate", async () => {
  const db = openM0Database();
  try {
    const { project } = setupThreeShotProject(db);
    const first = await startStoryboardVideoGeneration({
      project_id: project.project_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = await startStoryboardVideoGeneration({
      project_id: project.project_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "SHOT_WORKFLOW_ACTION_NOT_ALLOWED");
    const runCount = db.prepare("SELECT COUNT(*) AS count FROM generation_runs WHERE project_id = ?").get(project.project_id) as { count: number };
    assert.equal(runCount.count, first.runs.length);
  } finally {
    db.close();
  }
});

test("M0-D legacy batch generation rejects closed projects before all generation side effects", async () => {
  const db = openM0Database();
  try {
    const { project, storyboard } = setupThreeShotProject(db);
    const finalArtifact = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id }
    }, db);
    assert.equal(finalArtifact.ok, true);
    if (!finalArtifact.ok) return;
    const artifactId = finalArtifact.artifact.artifact_id;
    const exportId = `export_${project.project_id}`;
    const now = "2026-08-14T02:00:00.000Z";
    ensureAcceptedAssemblyClipsFixture(db, project.project_id);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, project.project_id);
    completeWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      artifact_id: artifactId,
      job_id: `job_m0d_assembly_${project.project_id}`,
      event_id: `event_m0d_assembly_${project.project_id}`,
      created_at: now
    });
    approveWorkbenchDeliveryFixture(db, {
      project_id: project.project_id,
      event_id: `event_m0d_accepted_${project.project_id}`,
      created_at: now
    });
    insertWorkbenchExportFixture(db, { project_id: project.project_id, artifact_id: artifactId,
      export_id: exportId, created_at: now });
    completeWorkbenchExportFixture(db, {
      project_id: project.project_id,
      export_id: exportId,
      job_id: `job_m0d_export_${project.project_id}`,
      event_id: `event_m0d_export_${project.project_id}`,
      created_at: now
    });
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES (?, ?, 'closeout', 'exported', 'closed', ?, ?, 'CLOSEOUT_CONFIRMED', '{}', ?)`)
      .run(`event_closeout_${project.project_id}`, project.project_id, artifactId, exportId, now);
    const factsBefore = {
      project: db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(project.project_id),
      shots: db.prepare("SELECT shot_id, data_json FROM shots WHERE project_id = ? ORDER BY shot_id").all(project.project_id),
      counts: db.prepare(`SELECT
        (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
        (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs,
        (SELECT COUNT(*) FROM generation_batches WHERE project_id = ?) AS batches`)
        .get(project.project_id, project.project_id, project.project_id)
    };

    const result = await startStoryboardVideoGeneration({
      project_id: project.project_id,
      storyboard_package_id: storyboard.storyboard_package.storyboard_package_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(result.ok ? null : result.error.code, "PROJECT_CLOSED");
    assert.deepEqual({
      project: db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(project.project_id),
      shots: db.prepare("SELECT shot_id, data_json FROM shots WHERE project_id = ? ORDER BY shot_id").all(project.project_id),
      counts: db.prepare(`SELECT
        (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
        (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs,
        (SELECT COUNT(*) FROM generation_batches WHERE project_id = ?) AS batches`)
        .get(project.project_id, project.project_id, project.project_id)
    }, factsBefore);
  } finally {
    db.close();
  }
});
