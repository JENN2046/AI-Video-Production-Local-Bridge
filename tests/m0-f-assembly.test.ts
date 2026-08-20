import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  activateLocalMediaArtifact,
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
  startStoryboardVideoGeneration,
  transitionMediaArtifactStatus
} from "../src/index.js";
import { approveWorkbenchDeliveryFixture, completeWorkbenchExportFixture, ensureAcceptedAssemblyClipsFixture, failWorkbenchAssemblyFixture, insertWorkbenchExportFixture, queueWorkbenchAssemblyFixture } from "./workbench-delivery-test-helpers.js";

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
    assert.equal(artifact.ok, true, artifact.ok ? "" : artifact.error.code);
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
  assert.equal(generation.ok, true, generation.ok ? "" : `${generation.error.code}:${generation.error.message}`);
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

test("M0-F queued and running assembly Jobs freeze their source Clip Artifacts", async () => {
  const db = openM0Database();
  try {
    const { project, storyboard, generation } = await setupGeneratedProject(db);
    for (const shot of storyboard.shots) {
      const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({
        shot_id: shot.shot_id,
        artifact_id: run.output.artifact_ids[0],
        decision: "approved"
      }, db).ok, true);
    }
    const now = "2026-08-18T04:00:00.000Z";
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, project.project_id);
    queueWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      job_id: "job_m0f_frozen_input",
      event_id: "event_m0f_frozen_input_queued",
      created_at: now
    });
    const acceptedClipId = getShot(db, storyboard.shots[0].shot_id)?.accepted_clip_artifact_id ?? "";
    const acceptedClip = getMediaArtifact(db, acceptedClipId);
    assert.ok(acceptedClip);
    const replacement = structuredClone(acceptedClip);
    replacement.metadata.aspect_ratio = "1:1";
    const assertFrozen = (): void => {
      const activation = activateLocalMediaArtifact({
        artifact: replacement,
        source_path: acceptedClip.storage.uri
      }, db);
      assert.equal(activation.ok ? null : activation.error.code, "WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE");
      const transition = transitionMediaArtifactStatus(acceptedClipId, "archived", db);
      assert.equal(transition.ok ? null : transition.error.code, "WORKBENCH_DELIVERY_ARTIFACT_ACTIVE_REQUIRED");
      assert.throws(() => db.prepare(`UPDATE media_artifacts
        SET data_json = json_set(data_json, '$.metadata.aspect_ratio', '1:1')
        WHERE artifact_id = ?`).run(acceptedClipId), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    };

    assertFrozen();
    db.prepare("UPDATE workbench_delivery_jobs SET state = 'running', started_at = ?, updated_at = ? WHERE job_id = ?")
      .run(now, now, "job_m0f_frozen_input");
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint,
        reason_code, data_json, created_at)
      SELECT 'event_m0f_frozen_input_started', project_id, job_id, 'assembly_started',
        'assembling', 'assembling', input_fingerprint, 'ASSEMBLY_STARTED', '{}', ?
      FROM workbench_delivery_jobs WHERE job_id = ?`).run(now, "job_m0f_frozen_input");
    assertFrozen();

    failWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      job_id: "job_m0f_frozen_input",
      event_id: "event_m0f_frozen_input_failed",
      created_at: now
    });
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble',
      active_assembly_job_id = NULL, updated_at = ? WHERE project_id = ?`).run(now, project.project_id);
    const released = transitionMediaArtifactStatus(acceptedClipId, "archived", db);
    assert.equal(released.ok, true);
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
    const acceptedClipArtifactIds = storyboard.shots.map((shot) => {
      const persisted = getShot(db, shot.shot_id);
      assert.ok(persisted?.accepted_clip_artifact_id);
      return persisted?.accepted_clip_artifact_id ?? "";
    });
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
    const event = db.prepare(`SELECT event.event_type, event.from_state, event.to_state, event.artifact_id,
      event.reason_code, job.job_type, job.state AS job_state, job.output_artifact_id
      FROM workbench_delivery_events event
      JOIN workbench_delivery_jobs job ON job.job_id = event.job_id AND job.project_id = event.project_id
      WHERE event.project_id = ? AND event.event_type = 'assembly_succeeded'
      ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1`)
      .get(project.project_id) as Record<string, unknown>;
    assert.deepEqual({ ...event }, {
      event_type: "assembly_succeeded",
      from_state: "assembling",
      to_state: "final_review",
      artifact_id: assembled.final_video_artifact_id,
      reason_code: "LEGACY_ASSEMBLY_SUCCEEDED",
      job_type: "assembly",
      job_state: "succeeded",
      output_artifact_id: assembled.final_video_artifact_id
    });
    const assemblyInput = JSON.parse((db.prepare(`SELECT input_json FROM workbench_delivery_jobs
      WHERE project_id = ? AND job_type = 'assembly' AND state = 'succeeded'`)
      .get(project.project_id) as { input_json: string }).input_json) as { source_clip_artifact_ids: string[] };
    assert.deepEqual(assemblyInput.source_clip_artifact_ids, acceptedClipArtifactIds);

    const acceptedClip = getMediaArtifact(db, acceptedClipArtifactIds[0]);
    assert.ok(acceptedClip);
    if (!acceptedClip) throw new Error("accepted clip evidence was not found");
    const journalCountBefore = Number((db.prepare("SELECT COUNT(*) AS count FROM media_activation_journal").get() as { count: number }).count);
    const replacement = structuredClone(acceptedClip);
    replacement.metadata.aspect_ratio = "1:1";
    const blockedActivation = activateLocalMediaArtifact({
      artifact: replacement,
      source_path: acceptedClip.storage.uri
    }, db);
    assert.equal(blockedActivation.ok, false);
    if (!blockedActivation.ok) assert.equal(blockedActivation.error.code, "WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM media_activation_journal").get() as { count: number }).count), journalCountBefore);
    assert.throws(() => db.prepare(`UPDATE media_artifacts
      SET data_json = json_set(data_json, '$.metadata.aspect_ratio', '1:1') WHERE artifact_id = ?`)
      .run(acceptedClip.artifact_id), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    const deactivatedClip = transitionMediaArtifactStatus(acceptedClip.artifact_id, "archived", db);
    assert.equal(deactivatedClip.ok ? null : deactivatedClip.error.code, "WORKBENCH_DELIVERY_ARTIFACT_ACTIVE_REQUIRED");
    assert.equal(getMediaArtifact(db, acceptedClip.artifact_id)?.status, "active");

    const deactivated = transitionMediaArtifactStatus(assembled.final_video_artifact_id, "archived", db);
    assert.equal(deactivated.ok ? null : deactivated.error.code, "WORKBENCH_DELIVERY_ARTIFACT_ACTIVE_REQUIRED");
    assert.equal(getMediaArtifact(db, assembled.final_video_artifact_id)?.status, "active");
  } finally {
    db.close();
  }
});

test("M0-F reassembly rejects a cleared clip after targeted final-review regeneration", async () => {
  const db = openM0Database();
  try {
    const { project, storyboard, generation } = await setupGeneratedProject(db);
    for (const shot of storyboard.shots) {
      const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({
        shot_id: shot.shot_id,
        artifact_id: run.output.artifact_ids[0],
        decision: "approved"
      }, db).ok, true);
    }
    const first = assembleFinalVideo({
      project_id: project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const targetShot = getShot(db, storyboard.shots[0].shot_id);
    assert.ok(targetShot?.accepted_clip_artifact_id);
    const delivery = db.prepare(`SELECT assembly_input_fingerprint FROM workbench_delivery_state
      WHERE project_id = ?`).get(project.project_id) as { assembly_input_fingerprint: string };
    const before = {
      finalArtifacts: db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
        .get(project.project_id),
      jobs: db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE project_id = ?")
        .get(project.project_id)
    };

    db.exec("BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, input_fingerprint,
        reason_code, data_json, created_at)
      VALUES ('event_m0f_targeted_regeneration', ?, 'final_review_regenerate_shots', 'final_review',
        'revision_requested', ?, ?, 'FINAL_SHOT_REGENERATION_REQUESTED', ?, ?)`)
      .run(project.project_id, first.final_video_artifact_id, delivery.assembly_input_fingerprint,
        JSON.stringify({ shot_ids: [targetShot.shot_id] }), "2026-08-18T08:00:00.000Z");
    db.exec("COMMIT");
    const reworkShot = getShot(db, targetShot.shot_id);
    assert.equal(reworkShot?.status, "revision_needed");
    assert.equal(reworkShot?.review.approval_status, "revision_needed");
    assert.equal(reworkShot?.accepted_clip_artifact_id, "");
    assert.equal(reworkShot?.clip_versions.find((version) => version.artifact_id === targetShot.accepted_clip_artifact_id)
      ?.review_status, "rejected");

    const reassembled = assembleFinalVideo({
      project_id: project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(reassembled.ok, false);
    if (!reassembled.ok) {
      assert.equal(reassembled.error.code, "FINAL_ASSEMBLY_NOT_READY");
      assert.equal(reassembled.blocking_reasons?.some((reason) => reason.includes("has no accepted clip")), true);
    }
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?")
      .get(project.project_id) as { workflow_state: string }).workflow_state, "revision_requested");
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(project.project_id), before.finalArtifacts);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE project_id = ?")
      .get(project.project_id), before.jobs);
  } finally {
    if (Boolean((db as unknown as { isTransaction?: boolean }).isTransaction)) db.exec("ROLLBACK");
    db.close();
  }
});

test("M0-F reassembly records the approval revocation before producing a new final version", async () => {
  const db = openM0Database();
  try {
    const { project, storyboard, generation } = await setupGeneratedProject(db);
    for (const shot of storyboard.shots) {
      const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({
        shot_id: shot.shot_id,
        artifact_id: run.output.artifact_ids[0],
        decision: "approved"
      }, db).ok, true);
    }
    const first = assembleFinalVideo({
      project_id: project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const now = new Date(Date.now() - 1_000).toISOString();
    approveWorkbenchDeliveryFixture(db, {
      project_id: project.project_id,
      event_id: "event_m0f_first_assembly_accepted",
      created_at: now
    });

    const second = assembleFinalVideo({
      project_id: project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.notEqual(second.final_video_artifact_id, first.final_video_artifact_id);
    assert.equal(getMediaArtifact(db, first.final_video_artifact_id)?.status, "active");
    assert.equal(getMediaArtifact(db, second.final_video_artifact_id)?.status, "active");

    const events = (db.prepare(`SELECT event_type, from_state, to_state, artifact_id, job_id,
      input_fingerprint, reason_code, created_at FROM workbench_delivery_events
      WHERE project_id = ? AND event_type IN ('final_review_reassemble','assembly_succeeded')
      ORDER BY rowid`).all(project.project_id) as Array<Record<string, unknown>>).map((row) => ({ ...row }));
    const [reworkEvent, succeededEvent] = events.slice(-2);
    assert.match(String(reworkEvent.created_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(reworkEvent.created_at, succeededEvent.created_at);
    assert.ok(String(reworkEvent.created_at) >= now);
    assert.equal(typeof reworkEvent.input_fingerprint, "string");
    assert.deepEqual({ ...reworkEvent, input_fingerprint: "<fingerprint>", created_at: "<created_at>" }, {
      event_type: "final_review_reassemble",
      from_state: "approved",
      to_state: "ready_to_assemble",
      artifact_id: first.final_video_artifact_id,
      job_id: null,
      input_fingerprint: "<fingerprint>",
      reason_code: "LEGACY_REASSEMBLY_REQUESTED",
      created_at: "<created_at>"
    });
    assert.equal(typeof succeededEvent.job_id, "string");
    assert.equal(typeof succeededEvent.input_fingerprint, "string");
    assert.deepEqual({ ...succeededEvent, job_id: "<job_id>", input_fingerprint: "<fingerprint>", created_at: "<created_at>" }, {
      event_type: "assembly_succeeded",
      from_state: "assembling",
      to_state: "final_review",
      artifact_id: second.final_video_artifact_id,
      job_id: "<job_id>",
      input_fingerprint: "<fingerprint>",
      reason_code: "LEGACY_ASSEMBLY_SUCCEEDED",
      created_at: "<created_at>"
    });
  } finally {
    db.close();
  }
});

test("M0-F assembly rejects same-project and global durable delivery Jobs before creating a final Artifact", async () => {
  const db = openM0Database();

  try {
    const fixture = await setupGeneratedProject(db);
    for (const shot of fixture.storyboard.shots) {
      const run = fixture.generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db).ok, true);
    }
    const now = "2026-08-14T00:00:00.000Z";
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, fixture.project.project_id);
    queueWorkbenchAssemblyFixture(db, { project_id: fixture.project.project_id,
      job_id: "job_same_project_active", event_id: "event_same_project_active_queued", created_at: now });
    const before = (db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(fixture.project.project_id) as { count: number }).count;
    const sameProject = assembleFinalVideo({
      project_id: fixture.project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(sameProject.ok ? null : sameProject.error.code, "DELIVERY_JOB_ACTIVE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(fixture.project.project_id) as { count: number }).count, before);

    db.exec("BEGIN IMMEDIATE");
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'failed', error_code = 'SYNTHETIC_FAILURE',
        terminal_event_id = 'event_same_project_active_failed', finished_at = ?, updated_at = ?
      WHERE job_id = 'job_same_project_active'`).run(now, now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint,
        reason_code, data_json, created_at)
      SELECT 'event_same_project_active_failed', project_id, job_id, 'assembly_failed',
        'assembling', 'ready_to_assemble', input_fingerprint, 'SYNTHETIC_FAILURE', '{}', ?
      FROM workbench_delivery_jobs WHERE job_id = 'job_same_project_active'`).run(now);
    db.exec("COMMIT");
    const otherProject = createProject({ title: "Other active delivery Job" }, db);
    assert.equal(otherProject.ok, true);
    if (!otherProject.ok) return;
    ensureAcceptedAssemblyClipsFixture(db, otherProject.project_id);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, otherProject.project_id);
    queueWorkbenchAssemblyFixture(db, { project_id: otherProject.project_id,
      job_id: "job_other_project_active", event_id: "event_other_project_active_queued", created_at: now });
    const global = assembleFinalVideo({
      project_id: fixture.project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(global.ok ? null : global.error.code, "DELIVERY_JOB_ACTIVE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(fixture.project.project_id) as { count: number }).count, before);
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'failed', error_code = 'SYNTHETIC_FAILURE',
        terminal_event_id = 'event_other_project_active_failed', finished_at = ?, updated_at = ?
      WHERE job_id = 'job_other_project_active'`).run(now, now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint,
        reason_code, data_json, created_at)
      SELECT 'event_other_project_active_failed', project_id, job_id, 'assembly_failed',
        'assembling', 'ready_to_assemble', input_fingerprint, 'SYNTHETIC_FAILURE', '{}', ?
      FROM workbench_delivery_jobs WHERE job_id = 'job_other_project_active'`).run(now);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
});

test("M0-F assembly rechecks durable delivery Jobs after acquiring the commit transaction", async () => {
  const db = openM0Database();

  try {
    const fixture = await setupGeneratedProject(db);
    for (const shot of fixture.storyboard.shots) {
      const run = fixture.generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db).ok, true);
    }
    const before = (db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(fixture.project.project_id) as { count: number }).count;
    db.exec(`CREATE TRIGGER inject_active_delivery_job_for_test
      AFTER UPDATE OF workflow_state ON workbench_delivery_state
      WHEN NEW.project_id = '${fixture.project.project_id}' AND NEW.workflow_state = 'assembling'
      BEGIN
        INSERT INTO workbench_delivery_jobs
          (job_id, project_id, job_type, state, input_fingerprint, input_json, created_at, updated_at)
        SELECT 'job_injected_during_assembly', NEW.project_id, 'assembly', 'queued',
          input_fingerprint, input_json, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM workbench_delivery_jobs WHERE job_id = NEW.active_assembly_job_id;
      END`);

    const assembled = assembleFinalVideo({
      project_id: fixture.project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(assembled.ok ? null : assembled.error.code, "DELIVERY_JOB_ACTIVE");
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?")
      .get(fixture.project.project_id) as { workflow_state: string }).workflow_state, "not_ready");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE job_id = 'job_injected_during_assembly'")
      .get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(fixture.project.project_id) as { count: number }).count, before);
  } finally {
    db.close();
  }
});

test("M0-F assembly rejects a caller-owned outer transaction before Artifact, Job, Event, or state writes", async () => {
  const db = openM0Database();
  try {
    const fixture = await setupGeneratedProject(db);
    for (const shot of fixture.storyboard.shots) {
      const run = fixture.generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      assert.equal(markShotClipReview({
        shot_id: shot.shot_id,
        artifact_id: run.output.artifact_ids[0],
        decision: "approved"
      }, db).ok, true);
    }
    const before = {
      state: db.prepare("SELECT * FROM workbench_delivery_state WHERE project_id = ?").get(fixture.project.project_id),
      artifacts: db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
        .get(fixture.project.project_id),
      jobs: db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE project_id = ?")
        .get(fixture.project.project_id),
      events: db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_events WHERE project_id = ?")
        .get(fixture.project.project_id)
    };

    db.exec("BEGIN IMMEDIATE");
    const assembled = assembleFinalVideo({
      project_id: fixture.project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    }, db);
    assert.equal(assembled.ok ? null : assembled.error.code, "FINAL_ASSEMBLY_TRANSACTION_UNSAFE");
    assert.equal(Boolean((db as unknown as { isTransaction?: boolean }).isTransaction), true);
    assert.deepEqual(db.prepare("SELECT * FROM workbench_delivery_state WHERE project_id = ?").get(fixture.project.project_id), before.state);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ? AND role = 'final_video'")
      .get(fixture.project.project_id), before.artifacts);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE project_id = ?")
      .get(fixture.project.project_id), before.jobs);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_events WHERE project_id = ?")
      .get(fixture.project.project_id), before.events);
    db.exec("ROLLBACK");
  } finally {
    if (Boolean((db as unknown as { isTransaction?: boolean }).isTransaction)) db.exec("ROLLBACK");
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
    approveWorkbenchDeliveryFixture(db, {
      project_id: closedFixture.project.project_id,
      event_id: "event_m0f_closeout_accepted",
      created_at: now
    });
    insertWorkbenchExportFixture(db, { project_id: closedFixture.project.project_id,
      artifact_id: first.final_video_artifact_id, export_id: exportId, created_at: now });
    completeWorkbenchExportFixture(db, {
      project_id: closedFixture.project.project_id,
      export_id: exportId,
      job_id: `job_export_${closedFixture.project.project_id}`,
      event_id: `event_export_${closedFixture.project.project_id}`,
      created_at: now
    });
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES (?, ?, 'closeout', 'exported', 'closed', ?, ?, 'CLOSEOUT_CONFIRMED', '{}', ?)`)
      .run(`event_closeout_${closedFixture.project.project_id}`, closedFixture.project.project_id,
        first.final_video_artifact_id, exportId, now);
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
