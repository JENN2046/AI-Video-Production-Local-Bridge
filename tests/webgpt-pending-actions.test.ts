import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  confirmWebGptPendingAction,
  defaultH1WorkbenchState,
  ensureM0Directories,
  executeWebGptPendingActionTool,
  getMediaArtifact,
  loadWebGptPendingActionStore,
  loadH1WorkbenchState,
  openM0Database,
  paths,
  rejectWebGptPendingAction,
  saveH1WorkbenchState,
  WEBGPT_PENDING_ACTION_TOOLS,
  webGptPendingActionWorkbenchSummary
} from "../src/index.js";

const CANARY_SOURCE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");

function copyPendingImport(filename: string): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  assert.equal(existsSync(CANARY_SOURCE), true, `Missing pending action test source image: ${CANARY_SOURCE}`);
  const target = join(paths.importsRoot, filename);
  copyFileSync(CANARY_SOURCE, target);
  return filename;
}

test("WebGPT v1 pending action tool inventory has no direct mutation/provider/secret/shell powers", () => {
  assert.deepEqual(
    WEBGPT_PENDING_ACTION_TOOLS.map((tool) => tool.name),
    [
      "request_register_media_artifact_from_import",
      "request_link_artifact_to_shot",
      "request_validate_storyboard_package",
      "request_import_storyboard_package"
    ]
  );

  for (const tool of WEBGPT_PENDING_ACTION_TOOLS) {
    assert.equal(tool.mode, "PENDING_HUMAN_CONFIRMATION");
    assert.equal(tool.pending_action_write_allowed, true);
    assert.equal(tool.direct_mutation_allowed, false);
    assert.equal(tool.human_confirmation_required, true);
    assert.equal(tool.provider_call_allowed, false);
    assert.equal(tool.secret_read_allowed, false);
    assert.equal(tool.shell_allowed, false);
  }
});

test("WebGPT v1 request creates a pending action only and human confirmation executes it", () => {
  const db = openM0Database();

  try {
    const beforeStoreCount = loadWebGptPendingActionStore().actions.length;
    const filename = copyPendingImport(`webgpt_action_register_${randomUUID().slice(0, 8)}.png`);
    const requested = executeWebGptPendingActionTool("request_register_media_artifact_from_import", { import_filename: filename }, db);
    assert.equal(requested.ok, true);
    if (!requested.ok) return;
    assert.equal(requested.action.status, "pending");
    assert.equal(requested.action.production_effects.media_artifact_registered, false);
    assert.equal(requested.action.execution.attempted, false);
    assert.equal(loadWebGptPendingActionStore().actions.length, beforeStoreCount + 1);

    const blocked = confirmWebGptPendingAction({ action_id: requested.action.action_id, human_confirmation: false }, db);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.error.code, "HUMAN_CONFIRMATION_REQUIRED");

    const confirmed = confirmWebGptPendingAction({ action_id: requested.action.action_id, human_confirmation: true }, db);
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    assert.equal(confirmed.action.status, "executed");
    assert.equal(confirmed.action.execution.attempted, true);
    assert.equal(confirmed.action.execution.ok, true);
    assert.equal(confirmed.action.production_effects.media_artifact_registered, true);
    assert.equal(confirmed.action.production_effects.provider_call_attempted, false);
    assert.equal(confirmed.action.production_effects.source_asset_overwritten, false);
    assert.equal(existsSync(join(paths.workspaceRoot, confirmed.action.execution.report_path)), true);

    const result = confirmed.action.execution.result as { artifact?: { artifact_id?: string } };
    assert.equal(Boolean(result.artifact?.artifact_id && getMediaArtifact(db, result.artifact.artifact_id)), true);
  } finally {
    db.close();
  }
});

test("WebGPT v1 rejects fake IDs and can reject pending actions without execution", () => {
  const db = openM0Database();

  try {
    const fake = executeWebGptPendingActionTool("request_link_artifact_to_shot", { shot_id: "SHOT_FAKE", artifact_id: "artifact_fake" }, db);
    assert.equal(fake.ok, false);
    if (fake.ok) return;
    assert.equal(fake.error.code, "INVALID_APP_ID");

    const validationRequest = executeWebGptPendingActionTool("request_validate_storyboard_package", { notes: "Human should decide." }, db);
    assert.equal(validationRequest.ok, true);
    if (!validationRequest.ok) return;

    const rejected = rejectWebGptPendingAction({ action_id: validationRequest.action.action_id, reason: "Not needed now." });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    assert.equal(rejected.action.status, "rejected");
    assert.equal(rejected.action.execution.attempted, false);
    assert.equal(rejected.action.production_effects.package_validated, false);
    assert.equal(existsSync(join(paths.workspaceRoot, rejected.action.execution.report_path)), true);
  } finally {
    db.close();
  }
});

test("WebGPT v1 package validation remains read-only and does not create a project", () => {
  const db = openM0Database();
  const previousState = loadH1WorkbenchState();

  try {
    const state = defaultH1WorkbenchState();
    state.project.project_id = "";
    saveH1WorkbenchState(state);
    const before = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };

    const requested = executeWebGptPendingActionTool("request_validate_storyboard_package", { notes: "read-only validation" }, db);
    assert.equal(requested.ok, true);
    if (!requested.ok) return;

    const confirmed = confirmWebGptPendingAction({ action_id: requested.action.action_id, human_confirmation: true }, db);
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    const after = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
    assert.equal(after.count, before.count);
    const result = confirmed.action.execution.result as { validation?: { ok?: boolean; blockers?: string[]; project_id?: string } };
    assert.equal(result.validation?.ok, false);
    assert.equal(result.validation?.blockers?.includes("PROJECT_NOT_PREPARED"), true);
    assert.equal(result.validation?.project_id, "");
  } finally {
    saveH1WorkbenchState(previousState);
    db.close();
  }
});

test("WebGPT v1 pending action workbench summary is visible and offline", () => {
  const summary = webGptPendingActionWorkbenchSummary();
  assert.equal(summary.mode, "PENDING_ACTION_REVIEW");
  assert.equal(summary.provider_boundary.network_call_attempted, false);
  assert.equal(summary.provider_boundary.runway_called, false);
  assert.equal(summary.provider_boundary.runninghub_called, false);
});
