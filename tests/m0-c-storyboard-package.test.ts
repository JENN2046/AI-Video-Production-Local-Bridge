import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  getProject,
  getProjectStatus,
  getStoryboardPackage,
  importStoryboardPackage,
  openM0Database,
  registerMediaArtifact
} from "../src/index.js";

function createActiveStoryboardArtifact(db: ReturnType<typeof openM0Database>) {
  const result = registerMediaArtifact(
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
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture setup failed");
  return result.artifact;
}

test("M0-C create_project persists draft project and get_project_status retrieves it", () => {
  const db = openM0Database();

  try {
    const created = createProject({ title: "M0-C Project" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.status, "draft");

    const status = getProjectStatus({ project_id: created.project_id }, db);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.status, "draft");
    assert.equal(status.shots.length, 0);
  } finally {
    db.close();
  }
});

test("M0-C unknown project returns PROJECT_NOT_FOUND", () => {
  const db = openM0Database();

  try {
    const status = getProjectStatus({ project_id: "project_missing" }, db);
    assert.equal(status.ok, false);
    if (status.ok) return;
    assert.equal(status.error.code, "PROJECT_NOT_FOUND");
  } finally {
    db.close();
  }
});

test("M0-C valid Storyboard Package import freezes snapshots and creates shots", () => {
  const db = openM0Database();

  try {
    const created = createProject({ title: "Storyboard Import" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const artifact = createActiveStoryboardArtifact(db);
    const snapshot = {
      order: 1,
      duration_seconds: 2,
      description: "Opening shot",
      storyboard_image_artifact_id: artifact.artifact_id,
      video_prompt: "Slow camera push over the product.",
      negative_prompt: "blur"
    };

    const imported = importStoryboardPackage(
      {
        project_id: created.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [snapshot],
        user_approval: { storyboard_approved: true }
      },
      db
    );

    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    assert.equal(imported.project.status, "storyboard_approved");
    assert.equal(imported.shots.length, 1);
    assert.equal(imported.shots[0].status, "storyboard_approved");

    snapshot.video_prompt = "Mutated after import";
    const frozen = getStoryboardPackage(db, imported.storyboard_package_id);
    assert.equal(frozen?.approved_shot_snapshots[0].video_prompt, "Slow camera push over the product.");

    const project = getProject(db, created.project_id);
    assert.equal(project?.active_storyboard_package_id, imported.storyboard_package_id);
  } finally {
    db.close();
  }
});

test("M0-C missing video_prompt is rejected", () => {
  const db = openM0Database();

  try {
    const created = createProject({ title: "Missing Prompt" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const artifact = createActiveStoryboardArtifact(db);

    const imported = importStoryboardPackage(
      {
        project_id: created.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: artifact.artifact_id,
            video_prompt: ""
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );

    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.equal(imported.error.code, "MISSING_REQUIRED_FIELD");
  } finally {
    db.close();
  }
});

test("M0-C Storyboard Package rejects active storyboard images that are not 9:16", () => {
  const db = openM0Database();

  try {
    const created = createProject({ title: "Invalid Storyboard Aspect" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const squareArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "storyboard/shot_001.png" }
      },
      db
    );
    assert.equal(squareArtifact.ok, true);
    if (!squareArtifact.ok) return;

    const imported = importStoryboardPackage(
      {
        project_id: created.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: squareArtifact.artifact.artifact_id,
            video_prompt: "This square fixture should not pass."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.equal(imported.error.code, "STORYBOARD_IMAGE_ASPECT_RATIO_NOT_9_16");
  } finally {
    db.close();
  }
});

test("M0-C pending upload artifact is rejected", () => {
  const db = openM0Database();

  try {
    const created = createProject({ title: "Pending Artifact" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const pending = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "pending_user_upload", filename: "later.png", mime_type: "image/png" }
      },
      db
    );
    assert.equal(pending.ok, true);
    if (!pending.ok) return;

    const imported = importStoryboardPackage(
      {
        project_id: created.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: pending.artifact.artifact_id,
            video_prompt: "Animate it."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );

    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.equal(imported.error.code, "ARTIFACT_PENDING_UPLOAD");
  } finally {
    db.close();
  }
});

test("M0-C inaccessible accessible_uri artifact is rejected", () => {
  const db = openM0Database();

  try {
    const created = createProject({ title: "Inaccessible Artifact" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const external = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "accessible_uri",
          uri: "https://example.test/storyboard/shot.png",
          filename: "shot.png",
          mime_type: "image/png"
        }
      },
      db
    );
    assert.equal(external.ok, true);
    if (!external.ok) return;
    assert.equal(external.artifact.status, "inaccessible");

    const imported = importStoryboardPackage(
      {
        project_id: created.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: external.artifact.artifact_id,
            video_prompt: "Animate it."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );

    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.equal(imported.error.code, "ARTIFACT_INACCESSIBLE");
  } finally {
    db.close();
  }
});

test("M0-C unapproved package is rejected", () => {
  const db = openM0Database();

  try {
    const created = createProject({ title: "Unapproved" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const imported = importStoryboardPackage(
      {
        project_id: created.project_id,
        status: "draft",
        approved_shot_snapshots: [],
        user_approval: { storyboard_approved: false }
      },
      db
    );

    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.equal(imported.error.code, "UNAPPROVED_STORYBOARD_PACKAGE");
  } finally {
    db.close();
  }
});

test("M0-C archived projects cannot bypass the shared Storyboard freeze gate", () => {
  const db = openM0Database();
  try {
    const created = createProject({ title: "Archived Storyboard Import" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const artifact = createActiveStoryboardArtifact(db);
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'archived' WHERE project_id = ?").run(created.project_id);

    const imported = importStoryboardPackage({
      project_id: created.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [{
        order: 1,
        duration_seconds: 2,
        storyboard_image_artifact_id: artifact.artifact_id,
        video_prompt: "This write must roll back."
      }],
      user_approval: { storyboard_approved: true }
    }, db);
    assert.equal(imported.ok, false);
    if (!imported.ok) assert.equal(imported.error.code, "PROJECT_ARCHIVED");
    const shotCount = db.prepare("SELECT COUNT(*) AS count FROM shots WHERE project_id = ?").get(created.project_id) as { count: number };
    const packageCount = db.prepare("SELECT COUNT(*) AS count FROM storyboard_packages WHERE project_id = ?").get(created.project_id) as { count: number };
    assert.equal(shotCount.count, 0);
    assert.equal(packageCount.count, 0);
  } finally {
    db.close();
  }
});

test("M0-C closed projects reject Storyboard import before SHOT, Artifact, package, or Project writes", () => {
  const db = openM0Database();
  try {
    const created = createProject({ title: "Closed Storyboard Import" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const storyboardArtifact = createActiveStoryboardArtifact(db);
    const finalArtifact = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: created.project_id }
    }, db);
    assert.equal(finalArtifact.ok, true);
    if (!finalArtifact.ok) return;
    const now = "2026-08-14T04:00:00.000Z";
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, created.project_id);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', updated_at = ? WHERE project_id = ?")
      .run(now, created.project_id);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review',
      current_final_artifact_id = ?, updated_at = ? WHERE project_id = ?`)
      .run(finalArtifact.artifact.artifact_id, now, created.project_id);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
      approved_artifact_id = ?, updated_at = ? WHERE project_id = ?`)
      .run(finalArtifact.artifact.artifact_id, now, created.project_id);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_closed_storyboard', ?, ?, ?, ?, 123, ?)`)
      .run(created.project_id, finalArtifact.artifact.artifact_id,
        `data/exports/${created.project_id}/final.mp4`, "f".repeat(64), now);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported',
      latest_export_id = 'export_closed_storyboard', latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
      .run(now, now, created.project_id);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES ('event_closeout_storyboard', ?, 'closeout', 'exported', 'closed', ?, 'export_closed_storyboard',
        'CLOSEOUT_CONFIRMED', '{}', ?)`)
      .run(created.project_id, finalArtifact.artifact.artifact_id, now);

    const projectBefore = getProject(db, created.project_id);
    const countsBefore = db.prepare(`SELECT
      (SELECT COUNT(*) FROM shots WHERE project_id = ?) AS shots,
      (SELECT COUNT(*) FROM storyboard_packages WHERE project_id = ?) AS packages,
      (SELECT COUNT(*) FROM media_artifacts) AS artifacts,
      (SELECT COUNT(*) FROM media_artifact_blobs) AS artifact_blobs`)
      .get(created.project_id, created.project_id) as Record<string, unknown>;
    const imported = importStoryboardPackage({
      project_id: created.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [{
        order: 1,
        duration_seconds: 2,
        storyboard_image_artifact_id: storyboardArtifact.artifact_id,
        video_prompt: "This must fail before any persistent write."
      }],
      user_approval: { storyboard_approved: true }
    }, db);

    assert.equal(imported.ok, false);
    if (!imported.ok) assert.equal(imported.error.code, "PROJECT_CLOSED");
    assert.deepEqual(getProject(db, created.project_id), projectBefore);
    assert.deepEqual({ ...(db.prepare(`SELECT
      (SELECT COUNT(*) FROM shots WHERE project_id = ?) AS shots,
      (SELECT COUNT(*) FROM storyboard_packages WHERE project_id = ?) AS packages,
      (SELECT COUNT(*) FROM media_artifacts) AS artifacts,
      (SELECT COUNT(*) FROM media_artifact_blobs) AS artifact_blobs`)
      .get(created.project_id, created.project_id) as Record<string, unknown>) }, { ...countsBefore });
  } finally {
    db.close();
  }
});
