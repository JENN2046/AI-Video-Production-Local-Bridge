import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { paths } from "../src/paths.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { getShot, listProjectShots, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { getMediaArtifact, registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { decideWorkbenchPendingAction, transitionWorkbenchDraft } from "../src/tools/workbenchInbox.js";
import { getWorkbenchDraftRecord, getWorkbenchPendingActionRecord, migrateLegacyWorkbenchInboxStores, saveWorkbenchDraftRecord, saveWorkbenchPendingActionRecord } from "../src/tools/workbenchInboxStore.js";
import { createWorkbenchProject } from "../src/tools/workbenchV2.js";

test("legacy inbox JSON migrates once without changing source hashes", () => {
  const webgptDir = join(paths.dataRoot, "webgpt");
  mkdirSync(webgptDir, { recursive: true });
  const draftsPath = join(webgptDir, "draft_submissions.json");
  const actionsPath = join(webgptDir, "pending_actions.json");
  writeFileSync(draftsPath, JSON.stringify({ drafts: Array.from({ length: 41 }, (_, index) => ({ draft_id: `draft_${index}`, tool: "submit_shot_script_draft", status: "submitted", payload: { description: `SHOT ${index}` }, created_at: new Date(2026, 0, 1, 0, index).toISOString() })) }, null, 2));
  writeFileSync(actionsPath, JSON.stringify({ actions: Array.from({ length: 35 }, (_, index) => ({ action_id: `action_${index}`, tool: "request_validate_storyboard_package", status: "pending", payload: {}, created_at: new Date(2026, 0, 2, 0, index).toISOString() })) }, null, 2));
  const before = [sha256(draftsPath), sha256(actionsPath)];
  const db = openM0Database(":memory:");
  try {
    const first = migrateLegacyWorkbenchInboxStores(db);
    const second = migrateLegacyWorkbenchInboxStores(db);
    assert.equal(first.migrated, true);
    assert.equal(first.drafts, 41);
    assert.equal(first.pending_actions, 35);
    assert.equal(second.migrated, false);
    assert.deepEqual([sha256(draftsPath), sha256(actionsPath)], before);
  } finally {
    db.close();
  }
});

test("SHOT draft promotion updates text only and preserves media binding", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Draft target", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot: Shot = {
      shot_id: "shot_existing",
      project_id: created.data.project.project_id,
      order: 1,
      status: "draft",
      duration_seconds: 3,
      description: "Old description",
      storyboard_image_artifact_id: "artifact_keep_me",
      video_prompt: "Old prompt",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    created.data.project.shot_ids = [shot.shot_id];
    saveProject(db, created.data.project);
    saveWorkbenchDraftRecord({ draft_id: "draft_shot", tool: "submit_shot_script_draft", status: "pending", source: "test", payload: { description: "New description", video_prompt: "New prompt", negative_prompt: "No shake", duration_seconds: 6 } }, db);
    const result = transitionWorkbenchDraft("draft_shot", { action: "promote", target_project_id: created.data.project.project_id, target_shot_id: shot.shot_id }, db);
    assert.equal(result.ok, true);
    const updated = getShot(db, shot.shot_id);
    assert.equal(updated?.description, "New description");
    assert.equal(updated?.video_prompt, "New prompt");
    assert.equal(updated?.duration_seconds, 6);
    assert.equal(updated?.storyboard_image_artifact_id, "artifact_keep_me");
    assert.equal(getWorkbenchDraftRecord("draft_shot", db)?.status, "promoted");
  } finally {
    db.close();
  }
});

test("failed package promotion rolls back project creation and draft status", () => {
  const db = openM0Database(":memory:");
  try {
    saveWorkbenchDraftRecord({ draft_id: "draft_package", tool: "submit_storyboard_package_draft", status: "pending", source: "test", payload: { shots: [{ description: "Invalid media", storyboard_image_artifact_id: "missing_artifact", video_prompt: "Move" }] } }, db);
    const before = (db.prepare("SELECT COUNT(*) count FROM projects").get() as { count: number }).count;
    const result = transitionWorkbenchDraft("draft_package", { action: "promote", project_title: "Must roll back", classification: "production" }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DRAFT_APPLY_BLOCKED");
    const after = (db.prepare("SELECT COUNT(*) count FROM projects").get() as { count: number }).count;
    assert.equal(after, before);
    assert.equal(getWorkbenchDraftRecord("draft_package", db)?.status, "pending");
  } finally {
    db.close();
  }
});

test("package promotion scopes and attaches validated storyboard media atomically", () => {
  const db = openM0Database(":memory:");
  try {
    const source = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
    }, db);
    assert.equal(source.ok, true);
    if (!source.ok) return;
    saveWorkbenchDraftRecord({
      draft_id: "draft_package_with_media",
      tool: "submit_storyboard_package_draft",
      status: "pending",
      source: "test",
      payload: { shots: [{ description: "Scoped media", storyboard_image_artifact_id: source.artifact.artifact_id, video_prompt: "Move" }] }
    }, db);

    const result = transitionWorkbenchDraft("draft_package_with_media", { action: "promote", project_title: "Scoped package", classification: "production" }, db);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const projectId = result.data.project?.project_id ?? "";
    const shots = listProjectShots(db, projectId);
    assert.equal(shots.length, 1);
    assert.notEqual(shots[0].storyboard_image_artifact_id, source.artifact.artifact_id);
    assert.equal(shots[0].status, "storyboard_approved");
    const scoped = getMediaArtifact(db, shots[0].storyboard_image_artifact_id);
    assert.deepEqual(scoped?.linked_objects, { project_id: projectId, shot_id: shots[0].shot_id });
    assert.equal(getWorkbenchDraftRecord("draft_package_with_media", db)?.status, "promoted");
  } finally {
    db.close();
  }
});

test("pending actions require a project target and remain pending after failure", () => {
  const db = openM0Database(":memory:");
  try {
    saveWorkbenchPendingActionRecord({ action_id: "action_target", tool: "request_validate_storyboard_package", status: "pending", source: "test", payload: {} }, db);
    const result = decideWorkbenchPendingAction("action_target", { decision: "execute" }, db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PENDING_ACTION_TARGET_REQUIRED");
    assert.equal(getWorkbenchPendingActionRecord("action_target", db)?.status, "pending");
  } finally {
    db.close();
  }
});

test("Storyboard validate and import actions reject bytes that drift after Artifact registration", () => {
  const db = openM0Database(":memory:");
  let artifactPath = "";
  let originalBytes: Buffer | null = null;
  try {
    const created = createWorkbenchProject({ title: "Storyboard byte drift", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot: Shot = {
      shot_id: "shot_storyboard_byte_drift",
      project_id: created.data.project.project_id,
      order: 1,
      status: "draft",
      duration_seconds: 3,
      description: "Byte drift fixture",
      storyboard_image_artifact_id: "",
      video_prompt: "Animate safely.",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    const artifact = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: created.data.project.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    shot.storyboard_image_artifact_id = artifact.artifact.artifact_id;
    saveShot(db, shot);
    created.data.project.shot_ids = [shot.shot_id];
    saveProject(db, created.data.project);
    artifactPath = artifact.artifact.storage.uri;
    originalBytes = readFileSync(artifactPath);
    writeFileSync(artifactPath, "corrupted-after-registration");

    for (const [actionId, tool] of [
      ["action_validate_byte_drift", "request_validate_storyboard_package"],
      ["action_import_byte_drift", "request_import_storyboard_package"]
    ] as const) {
      saveWorkbenchPendingActionRecord({
        action_id: actionId,
        tool,
        status: "pending",
        source: "test",
        project_id: created.data.project.project_id,
        payload: { project_id: created.data.project.project_id }
      }, db);
      const result = decideWorkbenchPendingAction(actionId, { decision: "execute" }, db);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "PACKAGE_BLOCKED");
        assert.match(result.error.message, /\[(?:IMAGE_FILE_INVALID|MEDIA_BLOB_CONTENT_DRIFT)\]/);
      }
      assert.equal(getWorkbenchPendingActionRecord(actionId, db)?.status, "pending");
    }
    const packageCount = db.prepare("SELECT COUNT(*) AS count FROM storyboard_packages WHERE project_id = ?")
      .get(created.data.project.project_id) as { count: number };
    assert.equal(packageCount.count, 0);
  } finally {
    if (artifactPath && originalBytes) writeFileSync(artifactPath, originalBytes);
    db.close();
  }
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
