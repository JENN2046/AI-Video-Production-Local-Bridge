import assert from "node:assert/strict";
import test from "node:test";

import {
  READONLY_WORKBENCH_DATA_TOOLS,
  READONLY_WORKBENCH_RENDER_INPUT_SCHEMA,
  READONLY_WORKBENCH_RENDER_TOOL,
  READONLY_WORKBENCH_RESOURCE_MIME,
  READONLY_WORKBENCH_RESOURCE_URI,
  READONLY_WORKBENCH_RESOURCE_VERSION,
  READONLY_WORKBENCH_SHELL_SCHEMA
} from "../src/webgpt-cloud/appContract.js";

test("readonly MCP App contract freezes one render tool, six data tools, and the v1 resource", () => {
  assert.equal(READONLY_WORKBENCH_RENDER_TOOL, "render_ai_video_workspace_app");
  assert.deepEqual(READONLY_WORKBENCH_DATA_TOOLS, [
    "list_production_projects", "get_project_context", "list_project_shots",
    "get_review_package", "get_delivery_status", "get_closeout_evidence"
  ]);
  assert.equal(READONLY_WORKBENCH_RESOURCE_URI, "ui://aivideo/readonly-workbench-v1.html");
  assert.equal(READONLY_WORKBENCH_RESOURCE_MIME, "text/html;profile=mcp-app");
  assert.equal(READONLY_WORKBENCH_RESOURCE_VERSION, "readonly-workbench-v1.0.0");
});

test("render contract accepts only low-disclosure shell state and initial intent", () => {
  const shell = {
    app_state: "no_snapshot",
    service_version: "webgpt-v4.2.0",
    resource_version: READONLY_WORKBENCH_RESOURCE_VERSION,
    status: {
      server_now: "2026-07-16T00:00:00.000Z",
      generated_at: null,
      expires_at: null,
      age_seconds: null,
      ttl_remaining_seconds: 0,
      freshness_status: "no_snapshot",
      snapshot_fingerprint: null
    },
    initial_intent: { project_id: null, panel: "projects" }
  };
  assert.equal(READONLY_WORKBENCH_SHELL_SCHEMA.safeParse(shell).success, true);
  assert.equal(READONLY_WORKBENCH_SHELL_SCHEMA.safeParse({ ...shell, project_cards: [] }).success, false);
  assert.equal(READONLY_WORKBENCH_SHELL_SCHEMA.safeParse({ ...shell, view_revision: "undefined-contract" }).success, false);
  assert.equal(READONLY_WORKBENCH_RENDER_INPUT_SCHEMA.safeParse({ initial_project_id: "project_1", initial_panel: "shots" }).success, true);
  assert.equal(READONLY_WORKBENCH_RENDER_INPUT_SCHEMA.safeParse({ initial_panel: "media" }).success, false);
});
