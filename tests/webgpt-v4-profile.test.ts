import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { getProductionProjectContext } from "../src/webgpt-v4/domain.js";
import { readProjectContext } from "../src/webgpt-v4/contracts.js";
import { startWebGptV4 } from "../src/webgpt-v4/server.js";
import { webGptV4ToolsForProfile } from "../src/webgpt-v4/toolCatalog.js";
import { actorFromSubject, issuerHash, WEBGPT_V4_SCOPES, WebGptV4Error } from "../src/webgpt-v4/types.js";

function stableValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return { buffer_sha256: createHash("sha256").update(value).digest("hex") };
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

function logicalManifest(db: M0Database): { table_count: number; row_count: number; sha256: string } {
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  let rowCount = 0;
  const payload = tables.map((name) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("unsafe fixture table name");
    const rows = (db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>).map(stableValue);
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    rowCount += rows.length;
    return { name, rows };
  });
  return { table_count: tables.length, row_count: rowCount, sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

test("default readonly profile exposes six project tools and performs no database writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-readonly-"));
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  const created = createProject({ title: "Readonly production" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture setup failed");
  db.prepare("UPDATE workbench_project_meta SET classification = 'production', last_opened_at = ? WHERE project_id = ?").run("2026-01-01T00:00:00.000Z", created.project_id);
  const shot: Shot = {
    shot_id: "shot_readonly_001", project_id: created.project_id, order: 1, status: "storyboard_approved", duration_seconds: 6,
    description: "Readonly shot", storyboard_image_artifact_id: "", video_prompt: "Readonly prompt", negative_prompt: "", generation_run_ids: [],
    accepted_clip_artifact_id: "", clip_versions: [], review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  created.project.shot_ids = [shot.shot_id];
  saveProject(db, created.project);
  const projectedContext = readProjectContext(getProductionProjectContext({ project_id: created.project_id, workspace: "overview" }, db), "full");
  assert.equal(projectedContext.ok, true, JSON.stringify(projectedContext));
  const before = logicalManifest(db);
  db.close();

  const actor = actorFromSubject("auth0|jenn", WEBGPT_V4_SCOPES);
  const runtime = await startWebGptV4({ mcp_port: 0, media_port: 0, sqlite_path: sqlitePath, authenticate: async () => actor, media: { ffmpeg_path: join(root, "missing-ffmpeg.exe") } });
  assert.equal(runtime.profile, "readonly");
  assert.equal(runtime.media_port, null);
  assert.equal(runtime.media_url, null);
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { Authorization: "Bearer fixture" } } });
  const client = new Client({ name: "webgpt-v4-readonly-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), webGptV4ToolsForProfile("readonly").map((tool) => tool.name).sort());
    for (const tool of listed.tools) {
      const metadata = tool._meta as { securitySchemes?: Array<{ scopes: string[] }> };
      assert.deepEqual(metadata.securitySchemes?.[0]?.scopes, ["projects.read"]);
    }
    const resources = await client.listResources().catch(() => ({ resources: [] }));
    assert.equal(resources.resources.some((resource) => resource.uri.includes("media-inspector")), false);

    const calls = [
      { name: "list_production_projects", arguments: {} },
      { name: "get_project_context", arguments: { project_id: created.project_id, workspace: "overview" } },
      { name: "get_project_context", arguments: { project_id: created.project_id, workspace: "storyboard" } },
      { name: "get_project_context", arguments: { project_id: created.project_id, workspace: "generation" } },
      { name: "get_project_context", arguments: { project_id: created.project_id, workspace: "review" } },
      { name: "get_project_context", arguments: { project_id: created.project_id, workspace: "delivery" } },
      { name: "list_project_shots", arguments: { project_id: created.project_id } },
      { name: "get_review_package", arguments: { project_id: created.project_id, shot_id: shot.shot_id } },
      { name: "get_delivery_status", arguments: { project_id: created.project_id } },
      { name: "get_closeout_evidence", arguments: { project_id: created.project_id } }
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      assert.equal(result.isError, false, `${call.name}: ${JSON.stringify(result)}`);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.deepEqual(Object.keys(structured).sort(), ["data", "meta", "ok"]);
    }
    const missing = await client.callTool({ name: "get_project_context", arguments: { project_id: "project_missing", workspace: "overview" } });
    assert.equal(missing.isError, true);
    assert.deepEqual(Object.keys(missing.structuredContent as Record<string, unknown>).sort(), ["error", "meta", "ok"]);
    assert.equal((missing.structuredContent as { error: { code: string } }).error.code, "PROJECT_NOT_FOUND");

    const metadataResponse = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/.well-known/oauth-protected-resource"));
    const metadata = await metadataResponse.json() as { scopes_supported: string[] };
    assert.deepEqual(metadata.scopes_supported, ["projects.read"]);
    const resourceMetadataResponse = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/.well-known/oauth-protected-resource/mcp"));
    assert.equal(resourceMetadataResponse.status, 200);
    assert.deepEqual(await resourceMetadataResponse.json(), metadata);
    const readyResponse = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/readyz"));
    const ready = await readyResponse.json() as { checks: Record<string, boolean>; profile: string };
    assert.equal(ready.profile, "readonly");
    assert.deepEqual(Object.keys(ready.checks).sort(), ["database", "oauth", "schema"]);
  } finally {
    await client.close();
    await runtime.close();
  }

  const verify = openM0Database(sqlitePath);
  try {
    assert.deepEqual(logicalManifest(verify), before);
    const lastOpened = verify.prepare("SELECT last_opened_at FROM workbench_project_meta WHERE project_id = ?").get(created.project_id) as { last_opened_at: string };
    assert.equal(lastOpened.last_opened_at, "2026-01-01T00:00:00.000Z");
    assert.equal((verify.prepare("SELECT COUNT(*) count FROM webgpt_audit_events").get() as { count: number }).count, 0);
  } finally {
    verify.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("full profile remains explicit and invalid profiles fail closed", async () => {
  await assert.rejects(() => startWebGptV4({ profile: "expanded" }), (error: unknown) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_PROFILE");
  const commonAuth = {
    issuer: "https://issuer.example.test/",
    audience: "https://mcp.example.test/mcp",
    resource_url: "https://mcp.example.test/mcp",
    jwks_uri: "https://issuer.example.test/.well-known/jwks.json"
  };
  await assert.rejects(
    () => startWebGptV4({ profile: "readonly", auth_config: { provider: "auth0", access_model: "single_subject", ...commonAuth, allowed_subject_hash: "a".repeat(64) } }),
    (error: unknown) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_AUTH_PROVIDER"
  );
  await assert.rejects(
    () => startWebGptV4({ profile: "full", auth_config: { provider: "federated", access_model: "project_membership", ...commonAuth, issuer_hash: issuerHash(commonAuth.issuer), client_registration: "predefined", configuration_source: "generic" } }),
    (error: unknown) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_AUTH_PROVIDER"
  );
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-full-profile-"));
  const sqlitePath = join(root, "app.sqlite");
  openM0Database(sqlitePath).close();
  const actor = actorFromSubject("auth0|jenn", WEBGPT_V4_SCOPES);
  const runtime = await startWebGptV4({ profile: "full", mcp_port: 0, media_port: 0, sqlite_path: sqlitePath, authenticate: async () => actor });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { Authorization: "Bearer fixture" } } });
  const client = new Client({ name: "webgpt-v4-full-profile-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(runtime.profile, "full");
    assert.equal(typeof runtime.media_port, "number");
    assert.equal(typeof runtime.media_url, "string");
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), webGptV4ToolsForProfile("full").map((tool) => tool.name).sort());
  } finally {
    await client.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly contract violations return a stable safe envelope", () => {
  const result = readProjectContext({
    ok: true,
    data: { project: { project_id: "project_invalid" } },
    meta: { request_id: "contract-fixture", source_version: "webgpt-v4.3.0", updated_at: "2026-01-01T00:00:00.000Z" }
  }, "full");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "WEBGPT_V4_OUTPUT_CONTRACT_VIOLATION");
    assert.equal(JSON.stringify(result).includes("Zod"), false);
  }
});

test("WebGPT preflight skips media dependencies for the readonly profile", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-readonly-preflight-"));
  const sqlitePath = join(root, "app.sqlite");
  openM0Database(sqlitePath).close();
  try {
    const output = execFileSync(process.execPath, [join(process.cwd(), "dist", "scripts", "preflight.js"), "--profile=webgpt"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        AI_VIDEO_WORKSPACE_DATA_ROOT: root,
        AI_VIDEO_WORKSPACE_DB_PATH: sqlitePath,
        WEBGPT_V4_PROFILE: "readonly",
        WEBGPT_V4_MCP_PORT: "0",
        WEBGPT_V4_DESCOPE_ISSUER: "https://api.descope.com/project-fixture/",
        WEBGPT_V4_DESCOPE_AUDIENCE: "https://workspace.example.test",
        WEBGPT_V4_RESOURCE_URL: "https://workspace.example.test",
        WEBGPT_V4_DESCOPE_JWKS_URI: "https://api.descope.com/project-fixture/.well-known/jwks.json",
        WEBGPT_V4_DESCOPE_AUTHORIZATION_SERVER_URL: "https://api.descope.com/v1/apps/agentic/project-fixture/resource-fixture"
      }
    });
    const report = JSON.parse(output) as { ok: boolean; webgpt_profile: string; checks: Record<string, { ok: boolean; detail: string }> };
    assert.equal(report.ok, true);
    assert.equal(report.webgpt_profile, "readonly");
    assert.equal(report.checks.ports.detail, "0");
    assert.equal("ffmpeg" in report.checks, false);
    assert.equal("ffprobe" in report.checks, false);
    assert.equal("media_directory" in report.checks, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
