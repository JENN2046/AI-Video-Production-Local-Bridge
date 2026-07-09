import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  chatGptMcpBoundaryFlags,
  CHATGPT_MCP_TOOL_DESCRIPTORS,
  createChatGptMcpLocalServer,
  executeChatGptMcpReadOnlyTool,
  executeChatGptMcpTool,
  FORBIDDEN_CHATGPT_MCP_TOOL_NAMES,
  listChatGptMcpReadOnlyToolDescriptors,
  listChatGptMcpToolDescriptors,
  loadH1WorkbenchState,
  loadWebGptDraftStore,
  loadWebGptPendingActionStore,
  openM0Database,
  paths,
  runR2GHttpMcpTransportLocalDryRun,
  runR2GReadOnlyLiveSmokeLocalEntryPrep,
  startChatGptMcpHttpLocalHarness,
  startChatGptMcpReadOnlyLiveSmokeLocalEntry,
  type ChatGptMcpToolResultEnvelope
} from "../src/index.js";

function assertMcpEnvelopeConforms(result: ChatGptMcpToolResultEnvelope): void {
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ["boundary", "data", "error", "ok"]);
  assert.equal(typeof result.structuredContent.ok, "boolean");
  assert.equal(Boolean(result.structuredContent.data && typeof result.structuredContent.data === "object" && !Array.isArray(result.structuredContent.data)), true);
  assert.equal(Boolean(result.structuredContent.error && typeof result.structuredContent.error === "object" && !Array.isArray(result.structuredContent.error)), true);
  assert.equal(Boolean(result.structuredContent.boundary && typeof result.structuredContent.boundary === "object" && !Array.isArray(result.structuredContent.boundary)), true);
}

async function postLocalMcp(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function postJsonRpcMcp(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function nestedRecord(value: unknown, field: string): Record<string, unknown> {
  assert.equal(Boolean(value && typeof value === "object" && !Array.isArray(value)), true, `${field} must be an object`);
  return value as Record<string, unknown>;
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
      "get_final_delivery_status",
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

test("R2G-L read-only live smoke surface lists only READ_ONLY tools", () => {
  const readOnly = listChatGptMcpReadOnlyToolDescriptors();
  assert.deepEqual(
    readOnly.map((tool) => tool.name),
    [
      "get_project_status",
      "lookup_media_artifact",
      "check_import_readiness",
      "get_review_package",
      "get_final_delivery_status",
      "get_closeout_evidence"
    ]
  );
  for (const descriptor of readOnly) {
    assert.equal(descriptor.security.mode, "READ_ONLY");
    assert.equal(descriptor.annotations.readOnlyHint, true);
    assert.equal(descriptor.security.provider_call_allowed, false);
    assert.equal(descriptor.security.reads_credentials, false);
  }
});

test("R2G-L read-only executor blocks draft and human-confirmed write tools before mutation", () => {
  const beforeDrafts = loadWebGptDraftStore().drafts.length;
  const beforeActions = loadWebGptPendingActionStore().actions.length;

  const draft = executeChatGptMcpReadOnlyTool("submit_storyboard_draft", {
    shots: [{ description: "No write", video_prompt: "No write" }]
  });
  assert.equal(draft.ok, false);
  assert.equal((draft.structuredContent.error as { code?: string }).code, "READ_ONLY_LIVE_SMOKE_ONLY");

  const freeze = executeChatGptMcpReadOnlyTool("request_package_freeze", {
    reason: "No pending action"
  });
  assert.equal(freeze.ok, false);
  assert.equal((freeze.structuredContent.error as { code?: string }).code, "READ_ONLY_LIVE_SMOKE_ONLY");

  const provider = executeChatGptMcpReadOnlyTool("call_runninghub", {});
  assert.equal(provider.ok, false);
  assert.equal((provider.structuredContent.error as { code?: string }).code, "FORBIDDEN_ACTION");

  assert.equal(loadWebGptDraftStore().drafts.length, beforeDrafts);
  assert.equal(loadWebGptPendingActionStore().actions.length, beforeActions);
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

test("R2G read-only final delivery status distinguishes R3 closeout from H1 draft state", () => {
  const result = executeChatGptMcpReadOnlyTool("get_final_delivery_status", {});
  assert.equal(result.ok, true);
  assert.equal(result.mode, "READ_ONLY");
  assertMcpEnvelopeConforms(result);

  const data = nestedRecord(result.structuredContent.data, "final delivery data");
  const finalDelivery = nestedRecord(data.final_delivery, "final delivery");
  assert.equal(finalDelivery.status, "FINAL_APPROVED");
  const finalProject = nestedRecord(finalDelivery.project, "final delivery project");
  assert.equal(finalProject.project_id, "project_b742cb15-e44e-41b2-8d2d-4b90a30720df");
  assert.equal(finalProject.project_status, "final_approved");

  const h1State = nestedRecord(data.h1_workbench_state, "h1 workbench state");
  assert.equal(h1State.status, "DRAFT_NOT_APP_READY");
  assert.equal(h1State.shots_approved, 0);

  const reconciliation = nestedRecord(data.reconciliation, "reconciliation");
  assert.equal(reconciliation.finding, "STATE_SURFACE_MISMATCH");
  assert.equal(reconciliation.state_surface, "R3_FINAL_APPROVED_H1_DRAFT_UNSYNCED");
  assert.equal(reconciliation.is_r3_final_delivery_complete, true);
  assert.equal(reconciliation.is_h1_dashboard_app_ready, false);
  assert.equal(reconciliation.provider_action_exposed, false);
});

test("R2G project status includes final delivery dashboard distinction", () => {
  const result = executeChatGptMcpReadOnlyTool("get_project_status", {});
  assert.equal(result.ok, true);

  const data = nestedRecord(result.structuredContent.data, "project status data");
  const localToolResult = nestedRecord(data.local_tool_result, "local tool result");
  const localData = nestedRecord(localToolResult.data, "local tool data");
  const finalDelivery = nestedRecord(localData.final_delivery, "final delivery summary");
  assert.equal(finalDelivery.status, "FINAL_APPROVED");
  const reconciliation = nestedRecord(localData.state_surface_reconciliation, "state surface reconciliation");
  assert.equal(reconciliation.state_surface, "R3_FINAL_APPROVED_H1_DRAFT_UNSYNCED");
  assert.equal(reconciliation.should_generate_next_without_new_task, false);
});

test("R2G closeout evidence exposes final delivery status for cached connector tool lists", () => {
  const result = executeChatGptMcpReadOnlyTool("get_closeout_evidence", {});
  assert.equal(result.ok, true);
  assert.equal(result.mode, "READ_ONLY");
  assertMcpEnvelopeConforms(result);

  const data = nestedRecord(result.structuredContent.data, "closeout evidence data");
  assert.equal(data.final_delivery_status, "FINAL_APPROVED");
  assert.equal(data.closeout_result, "PASS_FINAL_DELIVERY_CLOSEOUT_READY");
  assert.equal(data.final_video_review_decision, "accept");
  assert.equal(data.final_artifact_id, "artifact_2fa09a9e-3408-49f8-96f9-42c87cfbbfbe");
  assert.equal(data.evidence_manifest_path, "data/reports/r3_9r_final_delivery_evidence_manifest.json");

  const reconciliation = nestedRecord(data.state_surface_reconciliation, "state surface reconciliation");
  assert.equal(reconciliation.state_surface, "R3_FINAL_APPROVED_H1_DRAFT_UNSYNCED");
  assert.equal(reconciliation.provider_action_exposed, false);
  assert.equal(Array.isArray(data.blockers), true);
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

test("R2G-J localhost HTTP MCP harness lists tools and calls an approved read-only tool", async () => {
  const harness = await startChatGptMcpHttpLocalHarness();
  try {
    assert.equal(harness.host, "127.0.0.1");
    assert.equal(harness.public_endpoint, false);
    assert.equal(harness.chatgpt_connector_created, false);

    const listed = await postLocalMcp(harness.mcpUrl, { method: "tools/list", params: {} });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.ok, true);
    const listedResult = nestedRecord(listed.body.result, "list result");
    assert.equal(Array.isArray(listedResult.tools), true);
    assert.equal((listedResult.tools as unknown[]).length, CHATGPT_MCP_TOOL_DESCRIPTORS.length);

    const approved = await postLocalMcp(harness.mcpUrl, {
      method: "tools/call",
      params: { name: "get_project_status", arguments: {} }
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.ok, true);
    const approvedResult = nestedRecord(approved.body.result, "approved result") as unknown as ChatGptMcpToolResultEnvelope;
    assert.equal(approvedResult.ok, true);
    assert.equal(approvedResult.mode, "READ_ONLY");
    assert.equal(approvedResult._meta.provider_boundary.network_call_attempted, false);
  } finally {
    await harness.close();
  }
});

test("R2G-J localhost HTTP MCP harness fails closed for forbidden tools and schema errors", async () => {
  const harness = await startChatGptMcpHttpLocalHarness();
  try {
    const forbidden = await postLocalMcp(harness.mcpUrl, {
      method: "tools/call",
      params: { name: "generate_video", arguments: {} }
    });
    assert.equal(forbidden.status, 200);
    const forbiddenResult = nestedRecord(forbidden.body.result, "forbidden result") as unknown as ChatGptMcpToolResultEnvelope;
    assert.equal(forbiddenResult.ok, false);
    assert.equal((forbiddenResult.structuredContent.error as { code?: string }).code, "FORBIDDEN_ACTION");

    const schemaInvalid = await postLocalMcp(harness.mcpUrl, {
      method: "tools/call",
      params: { name: "get_project_status", arguments: { extra_unexpected: true } }
    });
    assert.equal(schemaInvalid.status, 200);
    const schemaResult = nestedRecord(schemaInvalid.body.result, "schema result") as unknown as ChatGptMcpToolResultEnvelope;
    assert.equal(schemaResult.ok, false);
    assert.equal((schemaResult.structuredContent.error as { code?: string }).code, "UNKNOWN_INPUT_FIELD");

    for (const response of [forbidden.body, schemaInvalid.body]) {
      const boundary = nestedRecord(response.boundary, "http boundary");
      for (const value of Object.values(boundary)) assert.equal(value, false);
    }
  } finally {
    await harness.close();
  }
});

test("R2G-J dry-run report proves local HTTP transport without live side effects", async () => {
  const report = await runR2GHttpMcpTransportLocalDryRun("2026-07-09T00:00:00.000Z");
  assert.equal(report.result, "PASS_LOCAL_HTTP_MCP_TRANSPORT_DRY_RUN");
  const httpTransport = nestedRecord(report.http_transport, "http transport");
  assert.equal(httpTransport.localhost_only, true);
  assert.equal(httpTransport.public_endpoint, false);
  assert.equal(httpTransport.chatgpt_connector_created, false);
  assert.equal(httpTransport.server_closed_after_run, true);
  const checks = nestedRecord(report.dry_run_checks, "dry-run checks");
  for (const value of Object.values(checks)) {
    if (typeof value === "boolean") assert.equal(value, true);
    if (value && typeof value === "object" && !Array.isArray(value)) assert.equal((value as { ok?: unknown }).ok, true);
  }
  const boundary = nestedRecord(report.boundary_observed, "boundary observed");
  assert.equal(boundary.public_tunnel_started, false);
  assert.equal(boundary.chatgpt_connector_created, false);
  assert.equal(boundary.env_files_read, false);
  assert.equal(boundary.provider_api_called, false);
});

test("R2G-L read-only local entry initializes, lists read-only tools, and calls get_project_status", async () => {
  const entry = await startChatGptMcpReadOnlyLiveSmokeLocalEntry();
  try {
    assert.equal(entry.host, "127.0.0.1");
    assert.equal(entry.public_endpoint, false);
    assert.equal(entry.public_tunnel_started, false);
    assert.equal(entry.chatgpt_connector_created, false);
    assert.equal(entry.read_only_only, true);

    const initialize = await postJsonRpcMcp(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" }
    });
    assert.equal(initialize.status, 200);
    const initResult = nestedRecord(initialize.body.result, "initialize result");
    assert.equal(nestedRecord(initResult.serverInfo, "server info").name, "ai-video-production-chatgpt-mcp-local-test");

    const listed = await postJsonRpcMcp(entry.mcpUrl, { jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
    assert.equal(listed.status, 200);
    const listResult = nestedRecord(listed.body.result, "list result");
    const tools = listResult.tools as Array<{ name?: string; annotations?: { readOnlyHint?: boolean } }>;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      listChatGptMcpReadOnlyToolDescriptors().map((tool) => tool.name)
    );
    for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);

    const approved = await postJsonRpcMcp(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "approved",
      method: "tools/call",
      params: { name: "get_project_status", arguments: {} }
    });
    assert.equal(approved.status, 200);
    const approvedResult = nestedRecord(approved.body.result, "approved result");
    assert.equal(approvedResult.isError, false);
    const approvedStructured = nestedRecord(approvedResult.structuredContent, "approved structured");
    assert.equal(approvedStructured.ok, true);
  } finally {
    await entry.close();
  }
});

test("R2G-L read-only local entry fails closed for non-read-only, provider, unknown, and schema-invalid tools", async () => {
  const beforeDrafts = loadWebGptDraftStore().drafts.length;
  const beforeActions = loadWebGptPendingActionStore().actions.length;
  const entry = await startChatGptMcpReadOnlyLiveSmokeLocalEntry();
  try {
    const probes = [
      {
        name: "submit_storyboard_draft",
        arguments: { shots: [{ description: "No write", video_prompt: "No write" }] },
        code: "READ_ONLY_LIVE_SMOKE_ONLY"
      },
      {
        name: "request_package_freeze",
        arguments: { reason: "No pending action" },
        code: "READ_ONLY_LIVE_SMOKE_ONLY"
      },
      {
        name: "call_runninghub",
        arguments: {},
        code: "FORBIDDEN_ACTION"
      },
      {
        name: "unknown_tool",
        arguments: {},
        code: "TOOL_NOT_FOUND"
      },
      {
        name: "get_project_status",
        arguments: { extra_unexpected: true },
        code: "UNKNOWN_INPUT_FIELD"
      }
    ];

    for (const probe of probes) {
      const response = await postJsonRpcMcp(entry.mcpUrl, {
        jsonrpc: "2.0",
        id: probe.name,
        method: "tools/call",
        params: { name: probe.name, arguments: probe.arguments }
      });
      assert.equal(response.status, 200);
      const result = nestedRecord(response.body.result, `${probe.name} result`);
      assert.equal(result.isError, true);
      const structured = nestedRecord(result.structuredContent, `${probe.name} structured`);
      const error = nestedRecord(structured.error, `${probe.name} error`);
      assert.equal(error.code, probe.code);
      const boundary = nestedRecord(structured.boundary, `${probe.name} boundary`);
      for (const value of Object.values(boundary)) assert.equal(value, false);
    }
  } finally {
    await entry.close();
  }
  assert.equal(loadWebGptDraftStore().drafts.length, beforeDrafts);
  assert.equal(loadWebGptPendingActionStore().actions.length, beforeActions);
});

test("R2G-L prep report proves read-only local entry without live side effects", async () => {
  const report = await runR2GReadOnlyLiveSmokeLocalEntryPrep("2026-07-09T00:00:00.000Z");
  assert.equal(report.result, "PASS_READ_ONLY_LIVE_SMOKE_LOCAL_ENTRY_PREP");
  const localEntry = nestedRecord(report.local_entry, "local entry");
  assert.equal(localEntry.localhost_only, true);
  assert.equal(localEntry.public_endpoint, false);
  assert.equal(localEntry.public_tunnel_started, false);
  assert.equal(localEntry.chatgpt_connector_created, false);
  assert.equal(localEntry.read_only_only, true);
  assert.equal(localEntry.server_closed_after_run, true);

  const toolSurface = nestedRecord(report.tool_surface, "tool surface");
  assert.deepEqual(toolSurface.listed_tool_names, listChatGptMcpReadOnlyToolDescriptors().map((tool) => tool.name));

  const checks = nestedRecord(report.local_smoke_checks, "local smoke checks");
  for (const value of Object.values(checks)) {
    if (typeof value === "boolean") assert.equal(value, true);
    if (value && typeof value === "object" && !Array.isArray(value)) assert.equal((value as { ok?: unknown }).ok, true);
  }

  const boundary = nestedRecord(report.boundary_observed, "boundary observed");
  assert.equal(boundary.public_tunnel_started, false);
  assert.equal(boundary.chatgpt_connector_created, false);
  assert.equal(boundary.env_files_read, false);
  assert.equal(boundary.provider_api_called, false);
});
