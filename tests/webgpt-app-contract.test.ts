import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JSDOM } from "jsdom";

import {
  READONLY_WORKBENCH_DATA_TOOLS,
  READONLY_WORKBENCH_RENDER_INPUT_SCHEMA,
  READONLY_WORKBENCH_RENDER_TOOL,
  READONLY_WORKBENCH_RESOURCE_MIME,
  READONLY_WORKBENCH_RESOURCE_URI,
  READONLY_WORKBENCH_RESOURCE_VERSION,
  READONLY_WORKBENCH_SHELL_SCHEMA
} from "../src/webgpt-cloud/appContract.js";
import { readonlyWorkbenchShell, startReadonlyRemoteRuntime } from "../src/webgpt-cloud/remoteRuntime.js";
import {
  READONLY_WORKBENCH_WIDGET_DOMAIN,
  escapeReadonlyWorkbenchInlineText,
  readonlyWorkbenchWidgetHtml
} from "../src/webgpt-cloud/readonlyWorkbenchWidget.js";
import type { WebGptV4Actor } from "../src/webgpt-v4/types.js";

const FINGERPRINT = "a".repeat(64);
const ACTOR: WebGptV4Actor = {
  principal_id: "b".repeat(64),
  actor_hash: "b".repeat(64),
  issuer_hash: "c".repeat(64),
  scopes: new Set(["projects.read"])
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function shell(appState: "ready" | "no_snapshot" = "ready") {
  return {
    app_state: appState,
    service_version: "readonly-remote-v1.0.0",
    resource_version: READONLY_WORKBENCH_RESOURCE_VERSION,
    status: {
      server_now: "2026-07-17T00:00:00.000Z",
      generated_at: appState === "ready" ? "2026-07-17T00:00:00.000Z" : null,
      expires_at: appState === "ready" ? "2026-07-18T00:00:00.000Z" : null,
      age_seconds: appState === "ready" ? 0 : null,
      ttl_remaining_seconds: appState === "ready" ? 86400 : 0,
      freshness_status: appState === "ready" ? "fresh" : "no_snapshot",
      snapshot_fingerprint: appState === "ready" ? FINGERPRINT : null
    },
    initial_intent: { project_id: null, panel: "projects" }
  } as const;
}

function toolResult(data: unknown, fingerprint = FINGERPRINT): Record<string, unknown> {
  return {
    structuredContent: { ok: true, data, meta: { request_id: "fixture", source_version: "webgpt-v4.2.0", updated_at: "2026-07-17T00:00:00.000Z" } },
    _meta: {
      snapshot_fingerprint: fingerprint,
      snapshot_status: shell().status
    }
  };
}

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

test("readonly App resource and render binding expose a low-disclosure authenticated shell", async () => {
  const runtime = await startReadonlyRemoteRuntime({
    port: 0,
    authenticate: async () => ACTOR,
    log: () => undefined
  });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), {
    requestInit: { headers: { authorization: "Bearer fixture" } }
  });
  const client = new Client({ name: "readonly-app-contract", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [READONLY_WORKBENCH_RENDER_TOOL, ...READONLY_WORKBENCH_DATA_TOOLS]);
    const render = tools.tools[0]!;
    const renderMeta = record(render._meta);
    assert.deepEqual(record(renderMeta.ui), { resourceUri: READONLY_WORKBENCH_RESOURCE_URI, visibility: ["model", "app"] });
    assert.equal(renderMeta["openai/outputTemplate"], READONLY_WORKBENCH_RESOURCE_URI);
    for (const tool of tools.tools.slice(1)) {
      const meta = record(tool._meta);
      assert.deepEqual(record(meta.ui), { visibility: ["model", "app"] }, tool.name);
      assert.equal("resourceUri" in record(meta.ui), false, tool.name);
      assert.equal("openai/outputTemplate" in meta, false, tool.name);
    }

    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === READONLY_WORKBENCH_RESOURCE_URI), true);
    const loaded = await client.readResource({ uri: READONLY_WORKBENCH_RESOURCE_URI });
    assert.equal(loaded.contents.length, 1);
    const resource = loaded.contents[0]!;
    assert.equal(resource.mimeType, READONLY_WORKBENCH_RESOURCE_MIME);
    const resourceMeta = record(resource._meta);
    assert.equal(record(resourceMeta.ui).domain, READONLY_WORKBENCH_WIDGET_DOMAIN);
    assert.deepEqual(record(record(resourceMeta.ui).csp), { connectDomains: [], resourceDomains: [], frameDomains: [] });

    const rendered = await client.callTool({ name: READONLY_WORKBENCH_RENDER_TOOL, arguments: { initial_project_id: "hidden-project", initial_panel: "shots" } });
    assert.equal(rendered.isError, false);
    const output = record(rendered.structuredContent);
    assert.equal(output.app_state, "no_snapshot");
    assert.equal("project_cards" in output, false);
    assert.equal(JSON.stringify(output).includes("hidden-project"), false);
    assert.equal((record(output.initial_intent)).panel, "shots");
  } finally {
    await client.close();
    await runtime.close();
  }
});

test("readonly workbench HTML enforces CSP-compatible local rendering and inline escaping", () => {
  const html = readonlyWorkbenchWidgetHtml();
  for (const forbidden of ["innerHTML", "localStorage", "sessionStorage", "indexedDB", "caches.", "serviceWorker", "eval(", "new Function", "setWidgetState"]) {
    assert.equal(html.includes(forbidden), false, forbidden);
  }
  for (const required of [
    "Service Status", "Production Projects", "Project Context", "Shot Workbench", "Review Package",
    "Delivery Status", "Closeout Evidence", "window.openai?.callTool", "event.source!==window.parent",
    "当前数据来自只读快照", "选中文本后按 Ctrl+C"
  ]) assert.equal(html.includes(required), true, required);
  const escaped = escapeReadonlyWorkbenchInlineText("</ScRiPt><script>safe</script></STYLE>\u2028\u2029");
  assert.equal(/<\/script/i.test(escaped), false);
  assert.equal(/<\/style/i.test(escaped), false);
  assert.equal(escaped.includes("\\u2028"), true);
  assert.equal(escaped.includes("\\u2029"), true);
});

test("readonly workbench escapes malicious business text and ignores stale cross-project responses", async () => {
  const pending: Array<{ project: string; resolve: (value: Record<string, unknown>) => void }> = [];
  const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === "list_production_projects") return toolResult({ items: [
      { project: { project_id: "project_a", title: "<img src=x onerror=alert(1)>", status: "active" }, lifecycle: "active", updated_at: "2026-07-17" },
      { project: { project_id: "project_b", title: "Project B", status: "active" }, lifecycle: "active", updated_at: "2026-07-17" }
    ] });
    const project = String(args.project_id ?? "");
    if (project === "project_a") return new Promise((resolve) => pending.push({ project, resolve }));
    if (name === "get_project_context") return toolResult({ project: { project_id: project, title: "Project B", status: "active" }, workspace: "overview", summary: {} });
    if (name === "list_project_shots") return toolResult({ items: [{ shot_id: "shot_b", order: 1, status: "ready", description: "B SHOT" }] });
    if (name === "get_review_package") return toolResult({ shot: { description: "B SHOT" }, status: "ready" });
    return toolResult({ project_status: "active", marker: "B-only" });
  };
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: { toolOutput: shell(), callTool }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.querySelector("img"), null);
    assert.equal(dom.window.document.body.textContent?.includes("<img src=x onerror=alert(1)>"), true);
    const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button.project")];
    assert.equal(buttons.length, 2);
    buttons[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.body.textContent?.includes("Project B"), true);
    for (const item of pending) item.resolve(toolResult({ project: { project_id: item.project, title: "STALE PROJECT A", status: "active" }, summary: {} }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.body.textContent?.includes("STALE PROJECT A"), false);
    assert.equal(dom.window.document.body.textContent?.includes("Project B"), true);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench refresh recovers an existing empty shell through the data tool", async () => {
  let calls = 0;
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell("no_snapshot"),
        callTool: async (name: string) => {
          calls += 1;
          assert.equal(name, "list_production_projects");
          return toolResult({ items: [], page: { next_offset: null } });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(dom.window.document.querySelector<HTMLElement>("#workspace")?.hidden, true);
    dom.window.document.querySelector<HTMLButtonElement>("#refresh")!.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1);
    assert.equal(dom.window.document.body.textContent?.includes("No authorized projects"), true);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench preserves a selected project outside the first page", async () => {
  const projectCalls: string[] = [];
  const baseShell = shell();
  const initial = { ...baseShell, initial_intent: { ...baseShell.initial_intent, project_id: "project_page_2" } };
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: initial,
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") return toolResult({
            items: [{ project: { project_id: "project_page_1", title: "First page", status: "active" }, lifecycle: "active", updated_at: "2026-07-17" }],
            page: { next_offset: 25 }
          });
          projectCalls.push(String(args.project_id ?? ""));
          if (name === "get_project_context") return toolResult({ project: { project_id: args.project_id, title: "Selected page 2", status: "active" }, workspace: "overview", summary: {} });
          if (name === "list_project_shots") return toolResult({ items: [] });
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(projectCalls.length > 0, true);
    assert.deepEqual(new Set(projectCalls), new Set(["project_page_2"]));
    assert.equal(dom.window.document.body.textContent?.includes("Selected page 2"), true);
    dom.window.document.querySelector<HTMLButtonElement>("#refresh")!.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(new Set(projectCalls), new Set(["project_page_2"]));
    assert.equal(dom.window.document.body.textContent?.includes("Selected page 2"), true);
  } finally {
    dom.window.close();
  }
});

test("render shell never reveals an unauthorized initial project", () => {
  const result = readonlyWorkbenchShell(ACTOR, null, { initial_project_id: "project_secret", initial_panel: "delivery" }, new Date("2026-07-17T00:00:00.000Z"));
  assert.equal(result.app_state, "no_snapshot");
  assert.equal(result.initial_intent.project_id, null);
  assert.equal(result.initial_intent.panel, "delivery");
});
