import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { openM0Database } from "../src/storage/sqlite.js";
import { createProject } from "../src/tools/projects.js";
import { WEBGPT_V4_WIDGET_URI } from "../src/webgpt-v4/mcpApp.js";
import { startWebGptV4 } from "../src/webgpt-v4/server.js";
import { actorFromSubject, WebGptV4Error, WEBGPT_V4_SCOPES } from "../src/webgpt-v4/types.js";

test("official MCP transport advertises the V4 scoped tool contract and hides test projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-server-"));
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  const production = createProject({ title: "Visible production" }, db);
  const fixture = createProject({ title: "Secret fixture" }, db);
  assert.equal(production.ok, true);
  assert.equal(fixture.ok, true);
  if (!production.ok || !fixture.ok) return;
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(production.project_id);
  db.prepare("UPDATE workbench_project_meta SET classification = 'test' WHERE project_id = ?").run(fixture.project_id);
  db.close();

  const actor = actorFromSubject("auth0|jenn", WEBGPT_V4_SCOPES);
  const runtime = await startWebGptV4({ mcp_port: 0, media_port: 0, sqlite_path: sqlitePath, data_root: dataRoot, authenticate: async () => actor, media: { public_origin: "https://media.example.test" } });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { Authorization: "Bearer test-token" } } });
  const client = new Client({ name: "webgpt-v4-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const expected = [
      "list_production_projects", "get_project_context", "list_project_shots", "list_project_media",
      "inspect_media", "get_review_package", "get_delivery_status", "get_closeout_evidence",
      "update_shot_copy", "add_review_note", "submit_production_proposal",
      "revise_production_proposal", "close_production_proposal", "prepare_generation_intent"
    ];
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), expected.sort());
    for (const forbidden of ["submit_generation", "upload_media", "approve_review", "assemble_video", "deliver_project", "read_file", "shell"]) {
      assert.equal(tools.tools.some((tool) => tool.name === forbidden), false);
    }
    for (const tool of tools.tools) {
      assert.equal(typeof tool.inputSchema, "object");
      assert.equal(typeof tool.outputSchema, "object");
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.annotations?.destructiveHint, false);
      const metadata = tool._meta as Record<string, unknown>;
      assert.equal(Array.isArray(metadata.securitySchemes), true);
      const schemes = metadata.securitySchemes as Array<{ type: string; scopes: string[] }>;
      assert.equal(schemes[0].type, "oauth2");
      assert.equal(schemes[0].scopes.length, 1);
      assert.equal((WEBGPT_V4_SCOPES as readonly string[]).includes(schemes[0].scopes[0]), true);
      const output = tool.outputSchema as { properties?: Record<string, unknown> };
      assert.equal(Boolean(output.properties?.data), true);
    }
    const rawListResponse = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/list", params: {} })
    });
    assert.equal(rawListResponse.status, 200);
    const rawListText = await rawListResponse.text();
    const rawPayload = rawListText.startsWith("event:")
      ? rawListText.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "{}"
      : rawListText;
    const rawList = JSON.parse(rawPayload) as { result: { tools: Array<{ name: string; securitySchemes?: Array<{ type: string; scopes: string[] }> }> } };
    for (const tool of rawList.result.tools) {
      assert.equal(tool.securitySchemes?.[0]?.type, "oauth2");
      assert.equal(tool.securitySchemes?.[0]?.scopes.length, 1);
    }
    const contextTool = tools.tools.find((tool) => tool.name === "get_project_context");
    const contextData = ((contextTool?.outputSchema as { properties?: { data?: { properties?: Record<string, unknown> } } })?.properties?.data)?.properties;
    assert.equal(Boolean(contextData?.project), true);
    assert.equal(Boolean(contextData?.workspace), true);
    const generationTool = tools.tools.find((tool) => tool.name === "prepare_generation_intent");
    const generationData = ((generationTool?.outputSchema as { properties?: { data?: { properties?: Record<string, unknown> } } })?.properties?.data)?.properties;
    assert.equal(Boolean(generationData?.intent_id), true);
    assert.equal(Boolean(generationData?.provider_call_attempted), true);
    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === WEBGPT_V4_WIDGET_URI), true);
    const widget = await client.readResource({ uri: WEBGPT_V4_WIDGET_URI });
    const widgetContent = widget.contents[0];
    const widgetHtml = widgetContent && "text" in widgetContent ? widgetContent.text : "";
    assert.equal(widgetHtml.includes("innerHTML"), false);
    assert.equal(widgetHtml.includes("event.source!==window.parent"), true);
    assert.equal(widgetHtml.includes("use-credentials"), true);

    const listed = await client.callTool({ name: "list_production_projects", arguments: {} });
    const content = listed.structuredContent as { ok: boolean; data: { items: Array<{ project: { project_id: string; title: string } }> } };
    assert.equal(content.ok, true);
    assert.equal(content.data.items.length, 1);
    assert.equal(content.data.items[0].project.project_id, production.project_id);
    assert.equal(JSON.stringify(content).includes("Secret fixture"), false);

    const hidden = await client.callTool({ name: "get_project_context", arguments: { project_id: fixture.project_id, workspace: "overview" } });
    assert.equal(hidden.isError, true);
    assert.equal(JSON.stringify(hidden).includes("Secret fixture"), false);
    assert.equal((hidden.structuredContent as { error: { code: string } }).error.code, "PROJECT_NOT_FOUND");
  } finally {
    await client.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP endpoint fails closed without OAuth and exposes only protected-resource metadata anonymously", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-auth-"));
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  const runtime = await startWebGptV4({
    mcp_port: 0,
    media_port: 0,
    sqlite_path: join(root, "app.sqlite"),
    data_root: dataRoot,
    max_body_bytes: 256,
    authenticate: async (request) => {
      if (!request.headers.authorization) throw new WebGptV4Error("AUTH_REQUIRED", "OAuth required.");
      return actorFromSubject("auth0|jenn", WEBGPT_V4_SCOPES);
    }
  });
  try {
    const metadata = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/.well-known/oauth-protected-resource"));
    assert.equal(metadata.status, 200);
    const metadataBody = await metadata.json() as { configured: boolean; scopes_supported: string[] };
    assert.equal(metadataBody.configured, false);
    assert.deepEqual(metadataBody.scopes_supported, [...WEBGPT_V4_SCOPES]);

    const denied = await fetch(runtime.mcp_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.has("www-authenticate"), true);
    assert.equal(JSON.stringify(await denied.json()).includes("AUTH_REQUIRED"), true);
    const oversized = await fetch(runtime.mcp_url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify({ value: "x".repeat(512) }) });
    assert.equal(oversized.status, 400);
    assert.equal(JSON.stringify(await oversized.json()).includes("BODY_TOO_LARGE"), true);
    const mediaDenied = await fetch(`${runtime.media_url}/media/v4/projects/project/artifacts/artifact/content?grant=fixture`);
    assert.equal(mediaDenied.status, 401);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP tools reject callers that lack the exact write scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-scope-"));
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  const runtime = await startWebGptV4({
    mcp_port: 0,
    media_port: 0,
    sqlite_path: join(root, "app.sqlite"),
    data_root: dataRoot,
    authenticate: async () => actorFromSubject("auth0|jenn", ["projects.read"])
  });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { Authorization: "Bearer fixture" } } });
  const client = new Client({ name: "webgpt-v4-scope-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "update_shot_copy", arguments: { project_id: "project_hidden", shot_id: "shot_hidden", expected_updated_at: "2026-01-01T00:00:00.000Z", idempotency_key: "scope-test", description: "blocked" } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, "INSUFFICIENT_SCOPE");
    const challenges = (result._meta as Record<string, unknown> | undefined)?.["mcp/www_authenticate"] as string[] | undefined;
    assert.equal(Array.isArray(challenges), true);
    assert.equal(challenges?.[0]?.includes("insufficient_scope"), true);
    assert.equal(challenges?.[0]?.includes("shots.write"), true);
  } finally {
    await client.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("media server rejects malformed encoded paths without terminating the service", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-media-path-"));
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  const actor = actorFromSubject("auth0|jenn", ["media.read"]);
  const runtime = await startWebGptV4({
    mcp_port: 0,
    media_port: 0,
    sqlite_path: join(root, "app.sqlite"),
    data_root: dataRoot,
    authenticate: async () => actor,
    authenticate_media: async () => actor
  });
  try {
    const malformed = await fetch(`${runtime.media_url}/media/v4/projects/%ZZ/artifacts/artifact/content?grant=fixture`);
    assert.equal(malformed.status, 400);
    assert.equal(JSON.stringify(await malformed.json()).includes("INVALID_MEDIA_PATH"), true);
    const health = await fetch(`${runtime.media_url}/healthz`);
    assert.equal(health.status, 200);
    const ready = await fetch(`${runtime.media_url}/readyz`);
    assert.equal(ready.status, 503);
    const readyBody = await ready.json() as { ok: boolean; auth_configured: boolean };
    assert.equal(readyBody.ok, false);
    assert.equal(readyBody.auth_configured, false);
    const startupDb = openM0Database(join(root, "app.sqlite"));
    try {
      const marker = startupDb.prepare("SELECT COUNT(*) AS count FROM m0_meta WHERE key = 'webgpt_v4_legacy_history_migrated_at'").get() as { count: number };
      assert.equal(marker.count, 0, "service startup must not run legacy data migrations");
    } finally { startupDb.close(); }
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
