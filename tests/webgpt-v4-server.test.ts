import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { openM0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { mediaAnalysisQueue } from "../src/webgpt-v4/media.js";
import { WEBGPT_V4_WIDGET_URI } from "../src/webgpt-v4/mcpApp.js";
import { startWebGptV4 } from "../src/webgpt-v4/server.js";
import { actorFromSubject, WebGptV4Error, WEBGPT_V4_SCOPES } from "../src/webgpt-v4/types.js";

function schemaContainsProperty(value: unknown, property: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && property in record.properties) return true;
  return Object.values(record).some((item) => Array.isArray(item)
    ? item.some((entry) => schemaContainsProperty(entry, property))
    : schemaContainsProperty(item, property));
}

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
  const shot: Shot = {
    shot_id: "shot_server_contract", project_id: production.project_id, order: 1, status: "storyboard_approved", duration_seconds: 6,
    description: "Server contract", storyboard_image_artifact_id: "artifact_missing", video_prompt: "Contract prompt", negative_prompt: "",
    generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  production.project.shot_ids = [shot.shot_id];
  saveProject(db, production.project);
  const shotUpdatedAt = (db.prepare("SELECT updated_at FROM shots WHERE shot_id = ?").get(shot.shot_id) as { updated_at: string }).updated_at;
  db.close();

  const actor = actorFromSubject("auth0|jenn", WEBGPT_V4_SCOPES);
  const runtime = await startWebGptV4({ profile: "full", mcp_port: 0, media_port: 0, sqlite_path: sqlitePath, data_root: dataRoot, widget_domain: "https://widgets.example.test", authenticate: async () => actor, media: { public_origin: "https://media.example.test" } });
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
      const output = tool.outputSchema as { properties?: Record<string, unknown>; oneOf?: Array<Record<string, unknown>> };
      assert.equal(Boolean(output.properties?.data), true);
      assert.equal(output.oneOf?.length, 2);
      assert.deepEqual(output.oneOf?.map((branch) => branch.required), [["ok", "data", "meta"], ["ok", "error", "meta"]]);
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
    const contextData = (contextTool?.outputSchema as { properties?: { data?: unknown } })?.properties?.data;
    assert.equal(schemaContainsProperty(contextData, "project"), true);
    assert.equal(schemaContainsProperty(contextData, "workspace"), true);
    const generationTool = tools.tools.find((tool) => tool.name === "prepare_generation_intent");
    const generationData = ((generationTool?.outputSchema as { properties?: { data?: { properties?: Record<string, unknown> } } })?.properties?.data)?.properties;
    assert.equal(Boolean(generationData?.intent_id), true);
    assert.equal(Boolean(generationData?.provider_call_attempted), true);
    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === WEBGPT_V4_WIDGET_URI), true);
    const inspectTool = tools.tools.find((tool) => tool.name === "inspect_media");
    const inspectMeta = inspectTool?._meta as Record<string, unknown>;
    assert.deepEqual((inspectMeta.ui as { visibility: string[] }).visibility, ["model", "app"]);
    assert.equal(typeof inspectMeta["openai/toolInvocation/invoking"], "string");
    assert.equal(typeof inspectMeta["openai/toolInvocation/invoked"], "string");
    const widget = await client.readResource({ uri: WEBGPT_V4_WIDGET_URI });
    const widgetContent = widget.contents[0];
    const widgetHtml = widgetContent && "text" in widgetContent ? widgetContent.text : "";
    assert.equal(widgetHtml.includes("innerHTML"), false);
    assert.equal(widgetHtml.includes("event.source!==window.parent"), true);
    assert.equal(widgetHtml.includes("use-credentials"), true);
    const widgetMeta = widgetContent?._meta as Record<string, unknown>;
    assert.equal(typeof widgetMeta["openai/widgetDescription"], "string");
    const widgetUi = widgetMeta.ui as { domain: string; csp: { connectDomains: string[]; resourceDomains: string[] } };
    assert.equal(widgetUi.domain, "https://widgets.example.test");
    assert.deepEqual(widgetUi.csp.connectDomains, []);
    assert.deepEqual(widgetUi.csp.resourceDomains, ["https://media.example.test"]);

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

    const updated = await client.callTool({ name: "update_shot_copy", arguments: {
      project_id: production.project_id, shot_id: shot.shot_id, expected_updated_at: shotUpdatedAt,
      description: "Updated through strict DTO", idempotency_key: "server-contract-update"
    } });
    assert.equal(updated.isError, false, JSON.stringify(updated.structuredContent));
    assert.equal((updated.structuredContent as { data: { shot: { description: string } } }).data.shot.description, "Updated through strict DTO");

    const note = await client.callTool({ name: "add_review_note", arguments: {
      project_id: production.project_id, shot_id: shot.shot_id, note: "Strict review note", idempotency_key: "server-contract-note"
    } });
    assert.equal(note.isError, false, JSON.stringify(note.structuredContent));

    const submitted = await client.callTool({ name: "submit_production_proposal", arguments: {
      project_id: production.project_id, kind: "storyboard_package", payload: { notes: "Strict proposal" }, idempotency_key: "server-contract-submit"
    } });
    assert.equal(submitted.isError, false, JSON.stringify(submitted.structuredContent));
    const submittedDraft = (submitted.structuredContent as { data: { draft: { draft_id: string; payload: { kind: string } } } }).data.draft;
    assert.equal(submittedDraft.payload.kind, "storyboard_package");

    const revised = await client.callTool({ name: "revise_production_proposal", arguments: {
      project_id: production.project_id, draft_id: submittedDraft.draft_id, payload: { notes: "Revised strict proposal" }, idempotency_key: "server-contract-revise"
    } });
    assert.equal(revised.isError, false, JSON.stringify(revised.structuredContent));
    const revisedDraftId = (revised.structuredContent as { data: { draft: { draft_id: string } } }).data.draft.draft_id;

    const closed = await client.callTool({ name: "close_production_proposal", arguments: {
      project_id: production.project_id, draft_id: revisedDraftId, reason: "Contract complete", idempotency_key: "server-contract-close"
    } });
    assert.equal(closed.isError, false, JSON.stringify(closed.structuredContent));

    const blockedIntent = await client.callTool({ name: "prepare_generation_intent", arguments: {
      project_id: production.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1,
      idempotency_key: "server-contract-intent"
    } });
    assert.equal(blockedIntent.isError, true);
    assert.equal((blockedIntent.structuredContent as { error: { code: string } }).error.code, "ARTIFACT_NOT_FOUND");
  } finally {
    await client.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly readiness and MCP requests fail closed on an unmigrated database", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-schema-gate-"));
  const sqlitePath = join(root, "blank.sqlite");
  writeFileSync(sqlitePath, "");
  const authConfig = {
    issuer: "https://auth.example.test/", audience: "fixture", resource_url: "https://mcp.example.test",
    jwks_uri: "https://auth.example.test/.well-known/jwks.json", allowed_subject_hash: "a".repeat(64)
  };
  const runtime = await startWebGptV4({
    profile: "readonly", mcp_port: 0, sqlite_path: sqlitePath, auth_config: authConfig,
    authenticate: async () => actorFromSubject("auth0|jenn", ["projects.read"])
  });
  try {
    const ready = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/readyz"));
    assert.equal(ready.status, 503);
    const readiness = await ready.json() as { checks: { schema: boolean; database: boolean } };
    assert.equal(readiness.checks.schema, false);
    assert.equal(readiness.checks.database, false);

    const response = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      body: JSON.stringify({ jsonrpc: "2.0", id: { attacker_controlled: true }, method: "tools/list", params: {} })
    });
    assert.equal(response.status, 503);
    const payload = await response.json() as { id: unknown; error: { data: { code: string } } };
    assert.equal(payload.id, null);
    assert.equal(payload.error.data.code, "SCHEMA_MIGRATION_REQUIRED");
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP endpoint fails closed without OAuth and exposes only protected-resource metadata anonymously", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-auth-"));
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  const runtime = await startWebGptV4({
    profile: "full",
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
    const resourceMetadata = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/.well-known/oauth-protected-resource/mcp"));
    assert.equal(resourceMetadata.status, 200);
    assert.deepEqual(await resourceMetadata.json(), metadataBody);

    const denied = await fetch(runtime.mcp_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.has("www-authenticate"), true);
    assert.equal(denied.headers.get("www-authenticate")?.includes("/.well-known/oauth-protected-resource/mcp"), true);
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

test("protected-resource metadata preserves the configured resource path and query", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-prmd-prefix-"));
  const dataRoot = join(root, "data");
  const sqlitePath = join(root, "app.sqlite");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  openM0Database(sqlitePath).close();
  const runtime = await startWebGptV4({
    mcp_port: 0,
    sqlite_path: sqlitePath,
    data_root: dataRoot,
    auth_config: {
      issuer: "https://auth.example.test/",
      audience: "fixture",
      resource_url: "https://mcp.example.test/tenant/mcp?region=us",
      jwks_uri: "https://auth.example.test/.well-known/jwks.json",
      allowed_subject_hash: "a".repeat(64)
    },
    authenticate: async () => { throw new WebGptV4Error("AUTH_REQUIRED", "Authentication is required."); }
  });
  try {
    const origin = runtime.mcp_url.replace(/\/mcp$/, "");
    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/tenant/mcp?region=us`);
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json() as { resource: string }).resource, "https://mcp.example.test/tenant/mcp?region=us");
    assert.equal((await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).status, 404);
    const denied = await fetch(runtime.mcp_url, { method: "POST" });
    assert.equal(denied.headers.get("www-authenticate")?.includes("/.well-known/oauth-protected-resource/tenant/mcp?region=us"), true);
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
    profile: "full",
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
    profile: "full",
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
    const readyBody = await ready.json() as { ok: boolean; auth_configured: boolean; external_release_gate: { widget_domain: boolean } };
    assert.equal(readyBody.ok, false);
    assert.equal(readyBody.auth_configured, false);
    assert.equal(readyBody.external_release_gate.widget_domain, false);
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

test("readiness reports a saturated media analysis queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-ready-queue-"));
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  const runtime = await startWebGptV4({
    profile: "full",
    mcp_port: 0,
    media_port: 0,
    sqlite_path: join(root, "app.sqlite"),
    data_root: dataRoot
  });
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
  let queued: Array<Promise<void>> = [];
  try {
    const warmResponse = await fetch(`${runtime.media_url}/readyz`);
    const warmPayload = await warmResponse.json() as { checks: { media_queue: boolean } };
    assert.equal(warmPayload.checks.media_queue, true);
    queued = Array.from({ length: 5 }, () => mediaAnalysisQueue.run(async () => blocked));
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.deepEqual(mediaAnalysisQueue.status(), { active: 1, waiting: 4, capacity: 5 });
    const response = await fetch(`${runtime.media_url}/readyz`);
    const payload = await response.json() as { ok: boolean; checks: { media_queue: boolean } };
    assert.equal(response.status, 503);
    assert.equal(payload.ok, false);
    assert.equal(payload.checks.media_queue, false);
    release?.();
    await Promise.all(queued);
  } finally {
    release?.();
    await Promise.allSettled(queued);
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
