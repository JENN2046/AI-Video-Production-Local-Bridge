import assert from "node:assert/strict";
import test from "node:test";

import {
  chatGptMcpBoundaryFlags,
  CHATGPT_MCP_TOOL_DESCRIPTORS,
  createChatGptMcpLocalServer,
  executeChatGptMcpTool,
  FORBIDDEN_CHATGPT_MCP_TOOL_NAMES,
  loadH1WorkbenchState,
  loadWebGptDraftStore,
  loadWebGptPendingActionStore,
  openM0Database
} from "../src/index.js";

test("R2G MCP tool descriptors use official-style schemas, annotations, and safe metadata", () => {
  assert.deepEqual(
    CHATGPT_MCP_TOOL_DESCRIPTORS.map((tool) => tool.name),
    [
      "get_project_status",
      "lookup_media_artifact",
      "submit_storyboard_draft",
      "check_import_readiness",
      "request_package_freeze",
      "get_review_package",
      "draft_human_review_decision",
      "get_closeout_evidence"
    ]
  );

  for (const descriptor of CHATGPT_MCP_TOOL_DESCRIPTORS) {
    assert.equal(descriptor.inputSchema.type, "object");
    assert.equal(descriptor.outputSchema.type, "object");
    assert.equal(descriptor.annotations.destructiveHint, false);
    assert.equal(descriptor.annotations.openWorldHint, false);
    assert.equal(descriptor.security.reads_credentials, false);
    assert.equal(descriptor.security.provider_call_allowed, false);
    assert.equal(descriptor.security.public_network_allowed, false);
    assert.equal(descriptor.security.source_overwrite_allowed, false);
    assert.equal(descriptor._meta.local_only, true);
    assert.equal(descriptor._meta.public_endpoint, false);
  }

  const allowedNames = new Set(CHATGPT_MCP_TOOL_DESCRIPTORS.map((tool) => String(tool.name)));
  for (const forbidden of FORBIDDEN_CHATGPT_MCP_TOOL_NAMES) {
    assert.equal(allowedNames.has(String(forbidden)), false);
  }
});

test("R2G local MCP server skeleton lists approved tools and fails closed for forbidden actions", () => {
  const db = openM0Database();
  try {
    const server = createChatGptMcpLocalServer(db);
    assert.equal(server.transport, "in_process_local_test_only");
    assert.equal(server.public_endpoint, false);
    assert.equal(server.chatgpt_connector_created, false);
    assert.equal(server.provider_call_allowed, false);
    assert.equal(server.listTools().length, CHATGPT_MCP_TOOL_DESCRIPTORS.length);

    const status = server.callTool("get_project_status", {});
    assert.equal(status.ok, true);
    assert.equal(status.mode, "READ_ONLY");
    assert.equal(status._meta.public_endpoint, false);
    assert.equal(status._meta.provider_boundary.network_call_attempted, false);

    const forbidden = server.callTool("generate_video", {});
    assert.equal(forbidden.ok, false);
    assert.equal((forbidden.structuredContent.error as { code?: string }).code, "FORBIDDEN_ACTION");
  } finally {
    db.close();
  }
});

test("R2G draft tool creates draft evidence only and does not freeze package truth", () => {
  const beforeDrafts = loadWebGptDraftStore().drafts.length;
  const beforeFrozen = loadH1WorkbenchState().frozen_package_history.length;

  const result = executeChatGptMcpTool("submit_storyboard_draft", {
    package_title: "R2G draft-only package",
    shots: [
      {
        description: "Draft-only shot.",
        video_prompt: "Draft-only motion prompt.",
        duration_seconds: 6
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "DRAFT_ONLY");
  assert.equal(loadWebGptDraftStore().drafts.length, beforeDrafts + 1);
  assert.equal(loadH1WorkbenchState().frozen_package_history.length, beforeFrozen);
  assert.equal(result._meta.provider_boundary.runninghub_called, false);
  assert.equal(result._meta.source_assets_overwritten, false);
});

test("R2G human-confirmed write path creates pending action only", () => {
  const beforeActions = loadWebGptPendingActionStore().actions.length;
  const beforeFrozen = loadH1WorkbenchState().frozen_package_history.length;

  const result = executeChatGptMcpTool("request_package_freeze", {
    reason: "R2G test gate request."
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "HUMAN_CONFIRMATION_REQUIRED");
  assert.equal(loadWebGptPendingActionStore().actions.length, beforeActions + 1);
  assert.equal(loadH1WorkbenchState().frozen_package_history.length, beforeFrozen);
  assert.equal(result._meta.provider_boundary.network_call_attempted, false);
});

test("R2G bridge rejects invented IDs and keeps boundary flags false", () => {
  const invented = executeChatGptMcpTool("lookup_media_artifact", { artifact_id: "PENDING_FAKE_ARTIFACT_ID" });
  assert.equal(invented.ok, false);
  assert.equal((invented.structuredContent.error as { code?: string }).code, "INVALID_APP_ID");

  const boundary = chatGptMcpBoundaryFlags();
  for (const value of Object.values(boundary)) {
    assert.equal(value, false);
  }
});
