import assert from "node:assert/strict";
import test from "node:test";

import {
  approveH3GeneratedClip,
  createProject,
  defaultH1WorkbenchState,
  getMediaArtifact,
  getShot,
  importStoryboardPackage,
  markShotClipReview,
  openM0Database,
  regenerateShotVideo,
  registerMediaArtifact,
  rejectH3GeneratedClip,
  startStoryboardVideoGeneration
} from "../src/index.js";
import { setWorkbenchProjectLifecycle, updateWorkbenchShot } from "../src/tools/workbenchV2.js";

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

function setProjectFinalEvidenceState(
  db: ReturnType<typeof openM0Database>,
  projectId: string,
  target: "approved" | "exported"
): { artifact_id: string; export_id: string | null } {
  const finalArtifact = registerMediaArtifact({
    artifact_type: "video",
    role: "final_video",
    source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
    linked_objects: { project_id: projectId }
  }, db);
  assert.equal(finalArtifact.ok, true);
  if (!finalArtifact.ok) throw new Error("final evidence Artifact registration failed");
  const artifactId = finalArtifact.artifact.artifact_id;
  const now = "2026-08-14T01:00:00.000Z";
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
    .run(now, projectId);
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = ?")
    .run(now, projectId);
  db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review',
    current_final_artifact_id = ?, updated_at = ? WHERE project_id = ?`).run(artifactId, now, projectId);
  db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
    approved_artifact_id = ?, updated_at = ? WHERE project_id = ?`).run(artifactId, now, projectId);
  if (target === "approved") return { artifact_id: artifactId, export_id: null };
  const exportId = `export_${projectId}`;
  db.prepare(`INSERT INTO workbench_exports
    (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(exportId, projectId, artifactId, `data/exports/${projectId}/final.mp4`, "c".repeat(64), now);
  db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported', latest_export_id = ?,
    latest_exported_at = ?, updated_at = ? WHERE project_id = ?`).run(exportId, now, now, projectId);
  return { artifact_id: artifactId, export_id: exportId };
}

function closeProjectForReviewTest(db: ReturnType<typeof openM0Database>, projectId: string): void {
  const finalArtifact = registerMediaArtifact({
    artifact_type: "video",
    role: "final_video",
    source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
    linked_objects: { project_id: projectId }
  }, db);
  assert.equal(finalArtifact.ok, true);
  if (!finalArtifact.ok) throw new Error("review closeout final Artifact registration failed");
  const artifactId = finalArtifact.artifact.artifact_id;
  const exportId = `export_${projectId}`;
  const now = "2026-08-14T00:00:00.000Z";
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?").run(now, projectId);
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = ?").run(now, projectId);
  db.prepare(`UPDATE workbench_delivery_state
    SET workflow_state = 'final_review', current_final_artifact_id = ?, updated_at = ? WHERE project_id = ?`)
    .run(artifactId, now, projectId);
  db.prepare(`UPDATE workbench_delivery_state
    SET workflow_state = 'approved', approved_artifact_id = ?, updated_at = ? WHERE project_id = ?`)
    .run(artifactId, now, projectId);
  db.prepare(`INSERT INTO workbench_exports
    (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(exportId, projectId, artifactId, `data/exports/${projectId}/final.mp4`, "a".repeat(64), now);
  db.prepare(`UPDATE workbench_delivery_state
    SET workflow_state = 'exported', latest_export_id = ?, latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
    .run(exportId, now, now, projectId);
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'closed', closed_at = ?, updated_at = ? WHERE project_id = ?")
    .run(now, now, projectId);
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

test("production content mutations require explicit atomic rework after final evidence exists", async () => {
  const db = openM0Database();
  try {
    const approvedFixture = await setupGeneratedShot(db);
    const approvedFinal = setProjectFinalEvidenceState(db, approvedFixture.project.project_id, "approved");
    const approvedShotBefore = getShot(db, approvedFixture.shot.shot_id);
    const approvedCountsBefore = db.prepare(`SELECT
      (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
      (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs`)
      .get(approvedFixture.project.project_id, approvedFixture.project.project_id) as Record<string, unknown>;

    const changedPrompt = updateWorkbenchShot(approvedFixture.project.project_id, approvedFixture.shot.shot_id, {
      video_prompt: "This direct edit must wait for explicit rework."
    }, db);
    assert.equal(changedPrompt.ok ? null : changedPrompt.error.code, "DELIVERY_REWORK_REQUIRED");
    const changedReview = markShotClipReview({
      shot_id: approvedFixture.shot.shot_id,
      artifact_id: approvedFixture.artifactId,
      decision: "approved"
    }, db);
    assert.equal(changedReview.ok ? null : changedReview.error.code, "DELIVERY_REWORK_REQUIRED");
    const regenerated = await regenerateShotVideo({
      shot_id: approvedFixture.shot.shot_id,
      previous_run_id: approvedFixture.run.run_id,
      updated_prompt: "This must not reach the Provider adapter.",
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(regenerated.ok ? null : regenerated.error.code, "DELIVERY_REWORK_REQUIRED");
    assert.deepEqual(getShot(db, approvedFixture.shot.shot_id), approvedShotBefore);
    assert.deepEqual({ ...(db.prepare(`SELECT
      (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
      (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs`)
      .get(approvedFixture.project.project_id, approvedFixture.project.project_id) as Record<string, unknown>) },
    { ...approvedCountsBefore });

    db.exec("BEGIN IMMEDIATE");
    const transactionOnlyReview = markShotClipReview({
      shot_id: approvedFixture.shot.shot_id,
      artifact_id: approvedFixture.artifactId,
      decision: "revision_needed",
      rejection_reasons: ["A transaction alone must not authorize rework"]
    }, db);
    assert.equal(transactionOnlyReview.ok ? null : transactionOnlyReview.error.code, "DELIVERY_REWORK_REQUIRED");
    db.exec("COMMIT");
    assert.deepEqual(getShot(db, approvedFixture.shot.shot_id), approvedShotBefore);

    db.exec("BEGIN IMMEDIATE");
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'revision_requested',
      approved_artifact_id = NULL, updated_at = ? WHERE project_id = ?`)
      .run("2026-08-14T01:01:00.000Z", approvedFixture.project.project_id);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, reason_code, data_json, created_at)
      VALUES ('event_atomic_content_rework', ?, 'final_review_regenerate_shots', 'approved', 'revision_requested', ?,
        'FINAL_SHOT_REGENERATION_REQUESTED', ?, ?)`)
      .run(approvedFixture.project.project_id, approvedFinal.artifact_id,
        JSON.stringify({ shot_ids: [approvedFixture.shot.shot_id] }), "2026-08-14T01:01:00.000Z");
    const atomicReview = markShotClipReview({
      shot_id: approvedFixture.shot.shot_id,
      artifact_id: approvedFixture.artifactId,
      decision: "revision_needed",
      rejection_reasons: ["Explicit final review rework"]
    }, db);
    assert.equal(atomicReview.ok, true);
    db.exec("COMMIT");
    const explicitEdit = updateWorkbenchShot(approvedFixture.project.project_id, approvedFixture.shot.shot_id, {
      video_prompt: "Explicit rework may now update production content."
    }, db);
    assert.equal(explicitEdit.ok, true);

    const exportedFixture = await setupGeneratedShot(db);
    const exportedFinal = setProjectFinalEvidenceState(db, exportedFixture.project.project_id, "exported");
    const exportedBefore = getShot(db, exportedFixture.shot.shot_id);
    const exportedReview = markShotClipReview({
      shot_id: exportedFixture.shot.shot_id,
      artifact_id: exportedFixture.artifactId,
      decision: "revision_needed"
    }, db);
    assert.equal(exportedReview.ok ? null : exportedReview.error.code, "DELIVERY_REWORK_REQUIRED");
    assert.deepEqual(getShot(db, exportedFixture.shot.shot_id), exportedBefore);
    assert.deepEqual({ ...(db.prepare(`SELECT workflow_state, current_final_artifact_id,
      approved_artifact_id, latest_export_id FROM workbench_delivery_state WHERE project_id = ?`)
      .get(exportedFixture.project.project_id) as Record<string, unknown>) }, {
      workflow_state: "exported",
      current_final_artifact_id: exportedFinal.artifact_id,
      approved_artifact_id: exportedFinal.artifact_id,
      latest_export_id: exportedFinal.export_id
    });
  } finally {
    if ((db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    db.close();
  }
});

test("H3 public review mutations reject closed projects without changing SHOT review state", async () => {
  const db = openM0Database();

  try {
    const { project, shot, run, artifactId } = await setupGeneratedShot(db);
    assert.equal(markShotClipReview({
      shot_id: shot.shot_id,
      artifact_id: artifactId,
      decision: "revision_needed",
      rejection_reasons: ["requires a closed-project gate"]
    }, db).ok, true);
    closeProjectForReviewTest(db, project.project_id);
    const before = getShot(db, shot.shot_id);
    assert.ok(before);
    const countsBefore = db.prepare(`SELECT
      (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
      (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs`).get(project.project_id, project.project_id);

    const approved = approveH3GeneratedClip({ shot_id: shot.shot_id, artifact_id: artifactId, write_report: false }, db);
    assert.equal(approved.ok ? null : approved.error.code, "PROJECT_CLOSED");

    const rejected = rejectH3GeneratedClip(defaultH1WorkbenchState(), {
      shot_id: shot.shot_id,
      artifact_id: artifactId,
      rejection_reasons: ["must remain unchanged after closeout"],
      revision_instruction: {
        summary: "Do not mutate closed project",
        prompt_delta: "none",
        negative_delta: "none",
        priority: "high"
      },
      write_report: false
    }, db);
    assert.equal(rejected.ok ? null : rejected.error.code, "PROJECT_CLOSED");
    const regenerated = await regenerateShotVideo({
      shot_id: shot.shot_id,
      previous_run_id: run.run_id,
      updated_prompt: "This must not reach the Provider adapter",
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(regenerated.ok ? null : regenerated.error.code, "PROJECT_CLOSED");
    assert.deepEqual(getShot(db, shot.shot_id), before);
    assert.deepEqual({ ...(db.prepare(`SELECT
      (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
      (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs`).get(project.project_id, project.project_id) as Record<string, unknown>) },
    { ...(countsBefore as Record<string, unknown>) });
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?")
      .get(project.project_id) as { workflow_state: string }).workflow_state, "closed");
  } finally {
    db.close();
  }
});

test("legacy regeneration rejects archived projects before Provider, Artifact, run, or SHOT side effects", async () => {
  const db = openM0Database();
  try {
    const { project, shot, run, artifactId } = await setupGeneratedShot(db);
    assert.equal(markShotClipReview({
      shot_id: shot.shot_id,
      artifact_id: artifactId,
      decision: "revision_needed",
      rejection_reasons: ["requires an archived-project gate"]
    }, db).ok, true);
    assert.equal(setWorkbenchProjectLifecycle(project.project_id, "archived", db).ok, true);
    const before = getShot(db, shot.shot_id);
    const countsBefore = db.prepare(`SELECT
      (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
      (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs`).get(project.project_id, project.project_id);

    const regenerated = await regenerateShotVideo({
      shot_id: shot.shot_id,
      previous_run_id: run.run_id,
      updated_prompt: "This must not reach the Provider adapter",
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(regenerated.ok ? null : regenerated.error.code, "PROJECT_ARCHIVED");
    assert.deepEqual(getShot(db, shot.shot_id), before);
    assert.deepEqual({ ...(db.prepare(`SELECT
      (SELECT COUNT(*) FROM media_artifacts WHERE project_id = ?) AS artifacts,
      (SELECT COUNT(*) FROM generation_runs WHERE project_id = ?) AS runs`).get(project.project_id, project.project_id) as Record<string, unknown>) },
    { ...(countsBefore as Record<string, unknown>) });
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

test("legacy regeneration cannot bypass the shared pending-review write gate", async () => {
  const db = openM0Database();
  try {
    const { shot, run } = await setupGeneratedShot(db);
    const result = await regenerateShotVideo({
      shot_id: shot.shot_id,
      previous_run_id: run.run_id,
      updated_prompt: "Do not regenerate before a revision decision",
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SHOT_WORKFLOW_ACTION_NOT_ALLOWED");
  } finally {
    db.close();
  }
});
