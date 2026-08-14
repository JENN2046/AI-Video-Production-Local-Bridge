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
    const delivery = db.prepare(`SELECT workflow_state, current_final_artifact_id, approved_artifact_id,
      latest_export_id FROM workbench_delivery_state WHERE project_id = ?`).get(project.project_id) as {
        workflow_state: string;
        current_final_artifact_id: string | null;
        approved_artifact_id: string | null;
        latest_export_id: string | null;
      };
    assert.deepEqual({ ...delivery }, {
      workflow_state: "final_review",
      current_final_artifact_id: assembled.final_video_artifact_id,
      approved_artifact_id: null,
      latest_export_id: null
    });
    const event = db.prepare(`SELECT event_type, from_state, to_state, artifact_id, reason_code
      FROM workbench_delivery_events WHERE project_id = ? ORDER BY created_at DESC, event_id DESC LIMIT 1`)
      .get(project.project_id) as Record<string, unknown>;
    assert.deepEqual({ ...event }, {
      event_type: "assembly_succeeded",
      from_state: "assembling",
      to_state: "final_review",
      artifact_id: assembled.final_video_artifact_id,
      reason_code: "LEGACY_ASSEMBLY_SUCCEEDED"
    });
  } finally {
    db.close();
  }
});

test("M0-F assembly rejects archived and closed projects before creating another final Artifact", async () => {
  const db = openM0Database();

  try {
    const archivedFixture = await setupGeneratedProject(db);
    for (const shot of archivedFixture.storyboard.shots) {
      const run = archivedFixture.generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db).ok, true);
    }
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'archived' WHERE project_id = ?").run(archivedFixture.project.project_id);
    const archivedBefore = (db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(archivedFixture.project.project_id) as { count: number }).count;
    const archived = assembleFinalVideo({
      project_id: archivedFixture.project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(archived.ok ? null : archived.error.code, "PROJECT_ARCHIVED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(archivedFixture.project.project_id) as { count: number }).count, archivedBefore);

    const closedFixture = await setupGeneratedProject(db);
    for (const shot of closedFixture.storyboard.shots) {
      const run = closedFixture.generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db).ok, true);
    }
    const first = assembleFinalVideo({
      project_id: closedFixture.project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const now = "2026-08-14T00:00:00.000Z";
    const exportId = `export_${closedFixture.project.project_id}`;
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'approved', approved_artifact_id = ?, updated_at = ? WHERE project_id = ?")
      .run(first.final_video_artifact_id, now, closedFixture.project.project_id);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(exportId, closedFixture.project.project_id, first.final_video_artifact_id,
        `data/exports/${closedFixture.project.project_id}/final.mp4`, "b".repeat(64), now);
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'exported', latest_export_id = ?, latest_exported_at = ?, updated_at = ?
      WHERE project_id = ?`).run(exportId, now, now, closedFixture.project.project_id);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'closed', closed_at = ?, updated_at = ? WHERE project_id = ?")
      .run(now, now, closedFixture.project.project_id);
    const finalCountBefore = (db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(closedFixture.project.project_id) as { count: number }).count;
    const eventCountBefore = (db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_events WHERE project_id = ?")
      .get(closedFixture.project.project_id) as { count: number }).count;
    const closed = assembleFinalVideo({
      project_id: closedFixture.project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(closed.ok ? null : closed.error.code, "PROJECT_CLOSED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(closedFixture.project.project_id) as { count: number }).count, finalCountBefore);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_events WHERE project_id = ?")
      .get(closedFixture.project.project_id) as { count: number }).count, eventCountBefore);
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
