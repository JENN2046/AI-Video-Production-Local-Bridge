import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  ensureM0Directories,
  executeWebGptReadOnlyTool,
  openM0Database,
  paths,
  registerH1ApprovedKeyframe,
  WEBGPT_READ_ONLY_TOOLS
} from "../src/index.js";

const CANARY_SOURCE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");

function copyBridgeImport(filename: string): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  assert.equal(existsSync(CANARY_SOURCE), true, `Missing bridge test source image: ${CANARY_SOURCE}`);
  const target = join(paths.importsRoot, filename);
  copyFileSync(CANARY_SOURCE, target);
  return filename;
}

test("WebGPT v0 read-only tool inventory exposes no mutation/provider/secret/shell tools", () => {
  const names = WEBGPT_READ_ONLY_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    "get_workspace_status",
    "get_project_status",
    "list_import_candidates",
    "list_media_artifacts",
    "get_media_artifact",
    "get_shot_status",
    "get_storyboard_package_status",
    "get_latest_reports",
    "get_provider_readiness_summary_redacted"
  ]);
  for (const tool of WEBGPT_READ_ONLY_TOOLS) {
    assert.equal(tool.mode, "READ_ONLY");
    assert.equal(tool.mutation_allowed, false);
    assert.equal(tool.provider_call_allowed, false);
    assert.equal(tool.secret_read_allowed, false);
    assert.equal(tool.shell_allowed, false);
  }
});

test("WebGPT v0 read-only tools return app facts and reject invented artifact ids", () => {
  const db = openM0Database();

  try {
    const filename = copyBridgeImport(`webgpt_bridge_test_${randomUUID().slice(0, 8)}.png`);
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

    const workspace = executeWebGptReadOnlyTool("get_workspace_status", {}, db);
    assert.equal(workspace.ok, true);
    assert.equal(workspace.mutation_allowed, false);

    const listed = executeWebGptReadOnlyTool("list_media_artifacts", {}, db);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const listedData = listed.data as { artifacts: Array<{ artifact_id: string }> };
    assert.equal(listedData.artifacts.some((artifact) => artifact.artifact_id === registered.value.artifact.artifact_id), true);

    const found = executeWebGptReadOnlyTool("get_media_artifact", { artifact_id: registered.value.artifact.artifact_id }, db);
    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal((found.data as { artifact: { artifact_id: string } }).artifact.artifact_id, registered.value.artifact.artifact_id);

    const fake = executeWebGptReadOnlyTool("get_media_artifact", { artifact_id: "artifact_fake" }, db);
    assert.equal(fake.ok, false);
    if (fake.ok) return;
    assert.equal(fake.error.code, "ARTIFACT_NOT_FOUND");

    const pending = executeWebGptReadOnlyTool("get_media_artifact", { artifact_id: "PENDING_ACTIVE_ARTIFACT_ID" }, db);
    assert.equal(pending.ok, false);
    if (pending.ok) return;
    assert.equal(pending.error.code, "INVALID_APP_ID");
  } finally {
    db.close();
  }
});

test("WebGPT v0 provider readiness summary is redacted and offline", () => {
  const db = openM0Database();

  try {
    const result = executeWebGptReadOnlyTool("get_provider_readiness_summary_redacted", {}, db);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.provider_boundary.network_call_attempted, false);
    assert.equal(result.provider_boundary.runway_called, false);
    assert.equal(result.provider_boundary.runninghub_called, false);
    assert.equal(result.provider_boundary.real_video_generated, false);
    assert.equal(result.provider_boundary.secret_values_exposed, false);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("sk-"), false);
    assert.equal(serialized.includes("key****"), false);
  } finally {
    db.close();
  }
});
