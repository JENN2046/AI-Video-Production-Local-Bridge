import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { openM0Database } from "../src/storage/sqlite.js";
import { createProject } from "../src/tools/projects.js";
import { startWebGptV4 } from "../src/webgpt-v4/server.js";
import { createWebGptTelemetrySink, JsonlWebGptTelemetrySink, parseWebGptTelemetryMode, parseWebGptWidgetDomain, type WebGptTelemetryEvent, type WebGptTelemetrySink } from "../src/webgpt-v4/telemetry.js";
import { actorFromSubject, WebGptV4Error } from "../src/webgpt-v4/types.js";

const event: WebGptTelemetryEvent = {
  timestamp: "2026-07-12T00:00:00.000Z", request_id: "request-safe", profile: "readonly", tool: "list_production_projects",
  duration_ms: 3, outcome: "success", result_bytes: 128, item_count: 1, detail_level: "compact"
};

test("telemetry and widget configuration parse fail closed", () => {
  assert.equal(parseWebGptTelemetryMode(), "off");
  assert.equal(parseWebGptTelemetryMode("jsonl"), "jsonl");
  assert.throws(() => parseWebGptTelemetryMode("verbose"), (error: unknown) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_TELEMETRY_MODE");
  assert.equal(parseWebGptWidgetDomain(), null);
  assert.equal(parseWebGptWidgetDomain("https://widgets.example.test"), "https://widgets.example.test");
  for (const invalid of ["http://widgets.example.test", "https://widgets.example.test/path", "not-a-url"]) {
    assert.throws(() => parseWebGptWidgetDomain(invalid), (error: unknown) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_WIDGET_DOMAIN");
  }
});

test("off mode creates no directory and jsonl contains only low-disclosure fields", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-telemetry-off-"));
  const offRoot = join(root, "off");
  const off = createWebGptTelemetrySink("off", offRoot);
  off.record(event);
  assert.equal(off.probe(), true);
  assert.equal(existsSync(offRoot), false);

  const jsonlRoot = join(root, "jsonl");
  const sink = new JsonlWebGptTelemetrySink(jsonlRoot, { now: () => new Date("2026-07-12T00:00:00.000Z") });
  sink.record(event);
  const path = join(jsonlRoot, "webgpt-v4-2026-07-12.jsonl");
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["detail_level", "duration_ms", "item_count", "outcome", "profile", "request_id", "result_bytes", "timestamp", "tool"].sort());
  for (const forbidden of ["prompt", "arguments", "structuredContent", "actor", "subject", "path", "token", "cookie", "provider_payload", "media_data"]) {
    assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  rmSync(root, { recursive: true, force: true });
});

test("jsonl rotation, size cap, probe cache, and unrelated-file preservation are bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-telemetry-rotation-"));
  let now = new Date("2026-07-12T12:00:00.000Z");
  const sink = new JsonlWebGptTelemetrySink(root, { now: () => now, retention_days: 7, maximum_bytes: 700, probe_interval_ms: 30_000 });
  mkdirSync(root, { recursive: true });
  const old = join(root, "webgpt-v4-2026-07-01.jsonl");
  const unrelated = join(root, "keep-me.txt");
  writeFileSync(old, "old");
  writeFileSync(unrelated, "unrelated");
  utimesSync(old, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
  for (let index = 0; index < 12; index += 1) sink.record({ ...event, request_id: `request-${index}` });
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(unrelated, "utf8"), "unrelated");
  const total = readdirSync(root).filter((name) => /^webgpt-v4-.*\.jsonl$/.test(name)).reduce((sum, name) => sum + lstatSync(join(root, name)).size, 0);
  assert.ok(total <= 700);

  assert.equal(sink.probe(), true);
  mkdirSync(join(root, ".webgpt-telemetry-probe"));
  assert.equal(sink.probe(), true, "cached probe must not run twice inside 30 seconds");
  now = new Date(now.getTime() + 31_000);
  assert.equal(sink.probe(), false);
  rmSync(root, { recursive: true, force: true });
});

test("telemetry cleanup refuses matching symlinks when the platform permits them", (context) => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-telemetry-symlink-"));
  const target = join(root, "target.txt");
  const link = join(root, "webgpt-v4-2026-07-01.jsonl");
  writeFileSync(target, "preserve");
  try {
    symlinkSync(target, link, "file");
  } catch {
    rmSync(root, { recursive: true, force: true });
    context.skip("Windows symlink creation is unavailable for this process");
    return;
  }
  const sink = new JsonlWebGptTelemetrySink(root, { now: () => new Date("2026-07-12T00:00:00.000Z") });
  sink.record(event);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8"), "preserve");
  rmSync(root, { recursive: true, force: true });
});

test("telemetry refuses a symlinked directory ancestor without writing through it", (context) => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-telemetry-root-link-"));
  const target = join(root, "outside");
  const link = join(root, "linked-data");
  mkdirSync(target);
  try {
    symlinkSync(target, link, "junction");
  } catch {
    rmSync(root, { recursive: true, force: true });
    context.skip("Windows junction creation is unavailable for this process");
    return;
  }
  const sink = new JsonlWebGptTelemetrySink(join(link, "webgpt", "telemetry"), { now: () => new Date("2026-07-12T00:00:00.000Z") });
  sink.record(event);
  assert.equal(sink.isHealthy(), false);
  assert.equal(existsSync(join(target, "webgpt")), false);
  rmSync(root, { recursive: true, force: true });
});

test("telemetry write failures preserve tool results and gate readiness until probe recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-telemetry-ready-"));
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  const created = createProject({ title: "Telemetry production" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture setup failed");
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
  db.close();
  let healthy = true;
  let recover = false;
  let recorded: WebGptTelemetryEvent | undefined;
  const sink: WebGptTelemetrySink = {
    mode: "jsonl",
    record: (value) => { recorded = value; throw new Error("fixture write failure"); },
    markUnhealthy: () => { healthy = false; },
    probe: () => { if (recover) healthy = true; return healthy; },
    isHealthy: () => healthy
  };
  const authConfig = {
    issuer: "https://auth.example.test/", audience: "fixture", resource_url: "https://mcp.example.test",
    jwks_uri: "https://auth.example.test/.well-known/jwks.json", allowed_subject_hash: "a".repeat(64)
  };
  const actor = actorFromSubject("auth0|jenn", ["projects.read"]);
  const runtime = await startWebGptV4({
    profile: "readonly", telemetry_sink: sink, mcp_port: 0, sqlite_path: sqlitePath, auth_config: authConfig, authenticate: async () => actor
  });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { Authorization: "Bearer fixture" } } });
  const client = new Client({ name: "telemetry-recovery", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "list_production_projects", arguments: { detail: "compact", request_id: "client-secret-argument" } });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    assert.ok(recorded);
    assert.equal(recorded?.request_id.includes("client-secret-argument"), false);
    assert.equal(healthy, false);
    const failed = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/readyz"));
    assert.equal(failed.status, 503);
    assert.equal(((await failed.json()) as { checks: { telemetry: boolean } }).checks.telemetry, false);
    recover = true;
    const restored = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/readyz"));
    assert.equal(restored.status, 200);
    assert.equal(((await restored.json()) as { checks: { telemetry: boolean } }).checks.telemetry, true);
    const health = await fetch(runtime.mcp_url.replace(/\/mcp$/, "/healthz"));
    assert.equal(health.status, 200);
  } finally {
    await client.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
