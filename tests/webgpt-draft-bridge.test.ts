import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  buildStoryboardApprovedShot,
  createProject,
  ensureM0Directories,
  executeWebGptDraftTool,
  loadH1WorkbenchState,
  loadWebGptDraftStore,
  openM0Database,
  paths,
  registerH1ApprovedKeyframe,
  saveProject,
  saveShot,
  WEBGPT_DRAFT_TOOLS,
  webGptDraftWorkbenchSummary
} from "../src/index.js";

const CANARY_SOURCE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");

function copyDraftImport(filename: string): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  assert.equal(existsSync(CANARY_SOURCE), true, `Missing draft bridge test source image: ${CANARY_SOURCE}`);
  const target = join(paths.importsRoot, filename);
  copyFileSync(CANARY_SOURCE, target);
  return filename;
}

function currentShotId(db: ReturnType<typeof openM0Database>): string {
  const existing = db.prepare("SELECT shot_id FROM shots ORDER BY created_at LIMIT 1").get() as { shot_id: string } | undefined;
  if (existing) return existing.shot_id;
  const created = createProject({ title: "WebGPT draft test target" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("Failed to create draft test project.");
  const shot = buildStoryboardApprovedShot({ project_id: created.project_id, order: 1, duration_seconds: 3, storyboard_image_artifact_id: "", video_prompt: "Existing prompt" });
  saveShot(db, shot);
  created.project.shot_ids = [shot.shot_id];
  saveProject(db, created.project);
  return shot.shot_id;
}

test("WebGPT v0.5 draft tool inventory exposes draft-only tools with no production powers", () => {
  assert.deepEqual(
    WEBGPT_DRAFT_TOOLS.map((tool) => tool.name),
    [
      "submit_shot_script_draft",
      "submit_storyboard_package_draft",
      "propose_artifact_link",
      "propose_package_validation",
      "propose_freeze_request"
    ]
  );

  for (const tool of WEBGPT_DRAFT_TOOLS) {
    assert.equal(tool.mode, "DRAFT_SUBMISSION");
    assert.equal(tool.draft_write_allowed, true);
    assert.equal(tool.production_mutation_allowed, false);
    assert.equal(tool.direct_freeze_allowed, false);
    assert.equal(tool.direct_artifact_registration_allowed, false);
    assert.equal(tool.provider_call_allowed, false);
    assert.equal(tool.secret_read_allowed, false);
    assert.equal(tool.shell_allowed, false);
  }
});

test("WebGPT v0.5 stores shot script drafts separately from app-ready truth", () => {
  const db = openM0Database();
  const beforeStore = loadWebGptDraftStore();
  const beforeFrozenCount = loadH1WorkbenchState().frozen_package_history.length;

  const result = executeWebGptDraftTool("submit_shot_script_draft", {
    shot_id: currentShotId(db),
    description: "Draft-only shot description from WebGPT.",
    video_prompt: "Draft-only camera move suggestion.",
    negative_prompt: "",
    duration_seconds: 2
  }, db);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.production_mutation_allowed, false);
  assert.equal(result.draft.production_effects.app_ready_truth_changed, false);
  assert.equal(result.draft.production_effects.package_frozen, false);
  assert.equal(result.draft.human_review.required_before_app_mutation, true);

  const afterStore = loadWebGptDraftStore();
  assert.equal(afterStore.drafts.length, beforeStore.drafts.length + 1);
  assert.equal(afterStore.drafts.some((draft) => draft.draft_id === result.draft.draft_id), true);
  assert.equal(loadH1WorkbenchState().frozen_package_history.length, beforeFrozenCount);
  db.close();
});

test("WebGPT v0.5 rejects fake ids and accepts only real app artifact link proposals", () => {
  const db = openM0Database();

  try {
    const fake = executeWebGptDraftTool("propose_artifact_link", { shot_id: "SHOT_FAKE", artifact_id: "artifact_fake" }, db);
    assert.equal(fake.ok, false);
    if (fake.ok) return;
    assert.equal(fake.error.code, "INVALID_APP_ID");

    const shotId = currentShotId(db);
    const pending = executeWebGptDraftTool("propose_artifact_link", { shot_id: shotId, artifact_id: "PENDING_ACTIVE_ARTIFACT_ID" }, db);
    assert.equal(pending.ok, false);
    if (pending.ok) return;
    assert.equal(pending.error.code, "INVALID_APP_ID");

    const filename = copyDraftImport(`webgpt_draft_link_${randomUUID().slice(0, 8)}.png`);
    const registered = registerH1ApprovedKeyframe(
      {
        import_filename: filename,
        review_status: "approved_for_media_artifact_handoff",
        write_report: false
      },
      db
    );
    assert.equal(registered.ok, true);
    if (!registered.ok) return;

    const accepted = executeWebGptDraftTool(
      "propose_artifact_link",
      { shot_id: shotId, artifact_id: registered.value.artifact.artifact_id },
      db
    );
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(accepted.draft.production_effects.artifact_linked_to_shot, false);
    assert.equal(accepted.draft.production_effects.media_artifact_registered, false);
  } finally {
    db.close();
  }
});

test("WebGPT v0.5 package validation and freeze requests remain drafts only", () => {
  const db = openM0Database();
  const packageDraft = executeWebGptDraftTool("submit_storyboard_package_draft", {
    package_title: "Draft package only",
    shots: [
      {
        shot_id: currentShotId(db),
        description: "Draft package shot.",
        video_prompt: "Draft-only motion."
      }
    ]
  }, db);
  assert.equal(packageDraft.ok, true);
  if (!packageDraft.ok) return;

  const validation = executeWebGptDraftTool("propose_package_validation", {
    package_draft_id: packageDraft.draft.draft_id,
    notes: "Please validate this package candidate."
  }, db);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.equal(validation.draft.production_effects.package_validated, false);

  const beforeFrozenCount = loadH1WorkbenchState().frozen_package_history.length;
  const freeze = executeWebGptDraftTool("propose_freeze_request", {
    package_draft_id: packageDraft.draft.draft_id,
    reason: "Human should review before any freeze."
  }, db);
  assert.equal(freeze.ok, true);
  if (!freeze.ok) return;
  assert.equal(freeze.draft.production_effects.package_frozen, false);
  assert.equal(loadH1WorkbenchState().frozen_package_history.length, beforeFrozenCount);

  const fakeFreeze = executeWebGptDraftTool("propose_freeze_request", {
    package_draft_id: "webgpt_draft_fake",
    reason: "Should fail."
  }, db);
  assert.equal(fakeFreeze.ok, false);
  if (fakeFreeze.ok) return;
  assert.equal(fakeFreeze.error.code, "INVALID_DRAFT_ID");
  db.close();
});

test("WebGPT v0.5 draft workbench summary is visible and offline", () => {
  const summary = webGptDraftWorkbenchSummary();
  assert.equal(summary.mode, "DRAFT_REVIEW");
  assert.equal(summary.provider_boundary.network_call_attempted, false);
  assert.equal(summary.provider_boundary.runway_called, false);
  assert.equal(summary.provider_boundary.runninghub_called, false);
  assert.equal(summary.production_effects.app_ready_truth_changed, false);
  assert.equal(summary.production_effects.package_frozen, false);
  assert.equal(summary.production_effects.provider_call_attempted, false);
});
