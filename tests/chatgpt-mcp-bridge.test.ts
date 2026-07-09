import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  chatGptMcpBoundaryFlags,
  CHATGPT_MCP_TOOL_DESCRIPTORS,
  createChatGptMcpLocalServer,
  executeChatGptMcpTool,
  FORBIDDEN_CHATGPT_MCP_TOOL_NAMES,
  listChatGptMcpToolDescriptors,
  loadH1WorkbenchState,
  loadWebGptDraftStore,
  loadWebGptPendingActionStore,
  openM0Database,
  paths,
  type ChatGptMcpToolResultEnvelope
} from "../src/index.js";

function assertMcpEnvelopeConforms(result: ChatGptMcpToolResultEnvelope): void {
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ["boundary", "data", "error", "ok"]);
  assert.equal(typeof result.structuredContent.ok, "boolean");
  assert.equal(Boolean(result.structuredContent.data && typeof result.structuredContent.data === "object" && !Array.isArray(result.structuredContent.data)), true);
  assert.equal(Boolean(result.structuredContent.error && typeof result.structuredContent.error === "object" && !Array.isArray(result.structuredContent.error)), true);
  assert.equal(Boolean(result.structuredContent.boundary && typeof result.structuredContent.boundary === "object" && !Array.isArray(result.structuredContent.boundary)), true);
}

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
    assertMcpEnvelopeConforms(forbidden);
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
  assertMcpEnvelopeConforms(invented);

  const boundary = chatGptMcpBoundaryFlags();
  for (const value of Object.values(boundary)) {
    assert.equal(value, false);
  }
});

test("R2G-H1 failure envelopes conform to outputSchema", () => {
  const forbidden = executeChatGptMcpTool("call_runninghub", {});
  assert.equal(forbidden.ok, false);
  assert.equal((forbidden.structuredContent.error as { code?: string }).code, "FORBIDDEN_ACTION");
  assertMcpEnvelopeConforms(forbidden);

  const fakeArtifact = executeChatGptMcpTool("lookup_media_artifact", { artifact_id: "artifact_fake" });
  assert.equal(fakeArtifact.ok, false);
  assert.equal((fakeArtifact.structuredContent.error as { code?: string }).code, "INVALID_APP_ID");
  assertMcpEnvelopeConforms(fakeArtifact);

  const missingRequired = executeChatGptMcpTool("request_package_freeze", {});
  assert.equal(missingRequired.ok, false);
  assert.equal((missingRequired.structuredContent.error as { code?: string }).code, "MISSING_REQUIRED_FIELD");
  assertMcpEnvelopeConforms(missingRequired);
});

test("R2G-H1 executor rejects unexpected top-level fields when additionalProperties is false", () => {
  const readOnly = executeChatGptMcpTool("get_project_status", { extra_unexpected: true });
  assert.equal(readOnly.ok, false);
  assert.equal((readOnly.structuredContent.error as { code?: string }).code, "UNKNOWN_INPUT_FIELD");
  assertMcpEnvelopeConforms(readOnly);

  const beforeDrafts = loadWebGptDraftStore().drafts.length;
  const draftOnly = executeChatGptMcpTool("submit_storyboard_draft", {
    package_title: "Bad top-level field",
    shots: [{ description: "Draft", video_prompt: "Draft motion" }],
    extra_unexpected: true
  });
  assert.equal(draftOnly.ok, false);
  assert.equal((draftOnly.structuredContent.error as { code?: string }).code, "UNKNOWN_INPUT_FIELD");
  assert.equal(loadWebGptDraftStore().drafts.length, beforeDrafts);
  assertMcpEnvelopeConforms(draftOnly);

  const beforeActions = loadWebGptPendingActionStore().actions.length;
  const confirmationRequired = executeChatGptMcpTool("request_package_freeze", {
    reason: "schema probe",
    extra_unexpected: true
  });
  assert.equal(confirmationRequired.ok, false);
  assert.equal((confirmationRequired.structuredContent.error as { code?: string }).code, "UNKNOWN_INPUT_FIELD");
  assert.equal(loadWebGptPendingActionStore().actions.length, beforeActions);
  assertMcpEnvelopeConforms(confirmationRequired);
});

test("R2G-H1 schema guard validates primitive types, enum values, and array object items", () => {
  const wrongPrimitive = executeChatGptMcpTool("lookup_media_artifact", { artifact_id: 123 });
  assert.equal(wrongPrimitive.ok, false);
  assert.equal((wrongPrimitive.structuredContent.error as { code?: string }).code, "INVALID_INPUT_TYPE");

  const badEnum = executeChatGptMcpTool("draft_human_review_decision", {
    artifact_id: "artifact_123",
    decision: "maybe"
  });
  assert.equal(badEnum.ok, false);
  assert.equal((badEnum.structuredContent.error as { code?: string }).code, "INVALID_ENUM_VALUE");

  const badItem = executeChatGptMcpTool("submit_storyboard_draft", {
    shots: ["not an object"]
  });
  assert.equal(badItem.ok, false);
  assert.equal((badItem.structuredContent.error as { code?: string }).code, "INVALID_INPUT_TYPE");
});

test("R2G-H1 listed descriptor mutation cannot affect global descriptor metadata", () => {
  assert.equal(Object.isFrozen(CHATGPT_MCP_TOOL_DESCRIPTORS), true);
  assert.equal(Object.isFrozen(CHATGPT_MCP_TOOL_DESCRIPTORS[0].security), true);

  const listed = listChatGptMcpToolDescriptors();
  (listed[0].security as { provider_call_allowed: boolean }).provider_call_allowed = true;
  (listed[0].outputSchema.required as string[]).push("mutated_by_test");

  assert.equal(CHATGPT_MCP_TOOL_DESCRIPTORS[0].security.provider_call_allowed, false);
  assert.equal(CHATGPT_MCP_TOOL_DESCRIPTORS[0].outputSchema.required?.includes("mutated_by_test"), false);

  const listedAgain = listChatGptMcpToolDescriptors();
  assert.equal(listedAgain[0].security.provider_call_allowed, false);
  assert.equal(listedAgain[0].outputSchema.required?.includes("mutated_by_test"), false);
});

test("R2G-H1 schema fixture matches current MCP tool descriptors", () => {
  const fixture = JSON.parse(readFileSync(join(paths.workspaceRoot, "fixtures", "mcp", "chatgpt_mcp_tool_contract_r2g_b.json"), "utf8")) as {
    tool_contract?: unknown;
  };
  assert.deepEqual(fixture.tool_contract, JSON.parse(JSON.stringify(CHATGPT_MCP_TOOL_DESCRIPTORS)));
});
