import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JSDOM } from "jsdom";

import {
  READONLY_MEDIA_PLAYBACK_INPUT_SCHEMA,
  READONLY_MEDIA_PLAYBACK_META_SCHEMA,
  READONLY_MEDIA_PLAYBACK_OUTPUT_SCHEMA,
  READONLY_WORKBENCH_APP_ONLY_TOOLS,
  READONLY_WORKBENCH_DATA_TOOLS,
  READONLY_WORKBENCH_MEDIA_TOOL,
  READONLY_WORKBENCH_RENDER_INPUT_SCHEMA,
  READONLY_WORKBENCH_RENDER_TOOL,
  READONLY_WORKBENCH_RESOURCE_MIME,
  READONLY_WORKBENCH_RESOURCE_URI,
  READONLY_WORKBENCH_RESOURCE_VERSION,
  READONLY_WORKBENCH_SHELL_SCHEMA
} from "../src/webgpt-cloud/appContract.js";
import { readonlyWorkbenchShell, startReadonlyRemoteRuntime } from "../src/webgpt-cloud/remoteRuntime.js";
import { READONLY_MEDIA_GATEWAY_ORIGIN } from "../src/webgpt-cloud/mediaGatewayClient.js";
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
    structuredContent: { ok: true, data, meta: { request_id: "fixture", source_version: "webgpt-v4.3.0", updated_at: "2026-07-17T00:00:00.000Z", snapshot_fingerprint: fingerprint } },
    _meta: {
      snapshot_fingerprint: fingerprint,
      snapshot_status: shell().status
    }
  };
}

function toolFailure(code: string): Record<string, unknown> {
  return {
    structuredContent: {
      ok: false,
      error: { code, message: code, retryable: false },
      meta: { request_id: "fixture", source_version: "webgpt-v4.3.0", updated_at: "2026-07-17T00:00:00.000Z", snapshot_fingerprint: FINGERPRINT }
    },
    _meta: { snapshot_fingerprint: FINGERPRINT, snapshot_status: shell().status }
  };
}

test("readonly MCP App contract freezes one render tool, six data tools, one app-only media tool, and the v1 resource", () => {
  assert.equal(READONLY_WORKBENCH_RENDER_TOOL, "render_ai_video_workspace_app");
  assert.deepEqual(READONLY_WORKBENCH_DATA_TOOLS, [
    "list_production_projects", "get_project_context", "list_project_shots",
    "get_review_package", "get_delivery_status", "get_closeout_evidence"
  ]);
  assert.equal(READONLY_WORKBENCH_RESOURCE_URI, "ui://aivideo/readonly-workbench-v1.html");
  assert.equal(READONLY_WORKBENCH_RESOURCE_MIME, "text/html;profile=mcp-app");
  assert.equal(READONLY_WORKBENCH_RESOURCE_VERSION, "readonly-workbench-v1.0.0");
});

test("readonly media playback contract is app-only and keeps the capability URL out of model-visible output", () => {
  assert.deepEqual(READONLY_WORKBENCH_APP_ONLY_TOOLS, [READONLY_WORKBENCH_MEDIA_TOOL]);
  assert.deepEqual(READONLY_MEDIA_PLAYBACK_INPUT_SCHEMA.parse({ project_id: "project_fixture", artifact_id: "artifact_fixture" }), {
    project_id: "project_fixture",
    artifact_id: "artifact_fixture"
  });
  const output = READONLY_MEDIA_PLAYBACK_OUTPUT_SCHEMA.parse({
    state: "ready",
    kind: "video",
    mime_type: "video/mp4",
    capability_expires_at: "2026-07-19T00:05:00.000Z",
    session_max_seconds: 1800,
    snapshot_fingerprint: FINGERPRINT
  });
  const meta = READONLY_MEDIA_PLAYBACK_META_SCHEMA.parse({ playback_url: `https://media.skmt617.top/media/v1/c/${"m".repeat(43)}` });
  assert.equal(JSON.stringify(output).includes(meta.playback_url), false);
  assert.throws(() => READONLY_MEDIA_PLAYBACK_META_SCHEMA.parse({ playback_url: "http://127.0.0.1/media" }));
  assert.throws(() => READONLY_MEDIA_PLAYBACK_META_SCHEMA.parse({ playback_url: "https://user:secret@media.skmt617.top/media" }));
  assert.throws(() => READONLY_MEDIA_PLAYBACK_META_SCHEMA.parse({ playback_url: "https://media.skmt617.top/media?artifact=hidden" }));
  assert.throws(() => READONLY_MEDIA_PLAYBACK_META_SCHEMA.parse({ playback_url: `https://other.example/media/v1/c/${"m".repeat(43)}` }));
  assert.throws(() => READONLY_MEDIA_PLAYBACK_META_SCHEMA.parse({ playback_url: "https://media.skmt617.top/media/v1/c/short" }));
});

test("render contract accepts only low-disclosure shell state and initial intent", () => {
  const shell = {
    app_state: "no_snapshot",
    service_version: "webgpt-v4.3.0",
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

test("readonly workbench renders canonical blocker reason codes", async () => {
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string) => {
          if (name === "list_production_projects") {
            return toolResult({ items: [{ project: { project_id: "project_a", title: "Project A", status: "video_review" } }], page: { next_offset: null } });
          }
          if (name === "get_project_context") {
            return toolResult({
              project: { project_id: "project_a", title: "Project A", status: "video_review" },
              workspace: "overview",
              summary: {},
              metrics: { shots: 1, storyboard_approved: 1, generation_active: 0, review_pending: 0, accepted_clips: 0 },
              blockers: [{
                shot_id: "shot_a", order: 1, missing_image: false, missing_prompt: false, reason_codes: ["CLIP_REVISION_REQUIRED"]
              }]
            });
          }
          if (name === "list_project_shots") return toolResult({ items: [], page: { next_offset: null } });
          return toolResult({ project_status: "video_review", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const contextText = dom.window.document.querySelector("#context")?.textContent ?? "";
    assert.equal(contextText.includes("CLIP_REVISION_REQUIRED"), true);
    assert.equal(contextText.includes("SHOT 1 · "), true);
  } finally {
    dom.window.close();
  }
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
    assert.deepEqual(tools.tools.map((tool) => tool.name), [READONLY_WORKBENCH_RENDER_TOOL, ...READONLY_WORKBENCH_DATA_TOOLS, READONLY_WORKBENCH_MEDIA_TOOL]);
    const render = tools.tools[0]!;
    const renderMeta = record(render._meta);
    assert.deepEqual(record(renderMeta.ui), { resourceUri: READONLY_WORKBENCH_RESOURCE_URI, visibility: ["model", "app"] });
    assert.equal(renderMeta["openai/outputTemplate"], READONLY_WORKBENCH_RESOURCE_URI);
    for (const tool of tools.tools.slice(1, -1)) {
      const meta = record(tool._meta);
      assert.deepEqual(record(meta.ui), { visibility: ["model", "app"] }, tool.name);
      assert.equal("resourceUri" in record(meta.ui), false, tool.name);
      assert.equal("openai/outputTemplate" in meta, false, tool.name);
    }
    const media = tools.tools.at(-1)!;
    assert.equal(media.name, READONLY_WORKBENCH_MEDIA_TOOL);
    assert.deepEqual(record(record(media._meta).ui), { visibility: ["app"] });
    assert.equal(media.annotations?.idempotentHint, false);

    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === READONLY_WORKBENCH_RESOURCE_URI), true);
    const loaded = await client.readResource({ uri: READONLY_WORKBENCH_RESOURCE_URI });
    assert.equal(loaded.contents.length, 1);
    const resource = loaded.contents[0]!;
    assert.equal(resource.mimeType, READONLY_WORKBENCH_RESOURCE_MIME);
    const resourceMeta = record(resource._meta);
    assert.equal(record(resourceMeta.ui).domain, READONLY_WORKBENCH_WIDGET_DOMAIN);
    assert.deepEqual(record(record(resourceMeta.ui).csp), {
      connectDomains: [READONLY_MEDIA_GATEWAY_ORIGIN],
      resourceDomains: [READONLY_MEDIA_GATEWAY_ORIGIN],
      frameDomains: []
    });

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
    "当前数据来自只读快照", "选中文本后按 Ctrl+C", "No generated clip", "storyboard ", "review ",
    "get_readonly_media_playback", "crossOrigin='anonymous'", "referrerPolicy='no-referrer'", "clearMedia()",
    "Gateway offline", "Integrity failed", "Capability expired", "Session expired", "Reload media"
  ]) assert.equal(html.includes(required), true, required);
  const escaped = escapeReadonlyWorkbenchInlineText("</ScRiPt><script>safe</script></STYLE>\u2028\u2029");
  assert.equal(/<\/script/i.test(escaped), false);
  assert.equal(/<\/style/i.test(escaped), false);
  assert.equal(escaped.includes("\\u2028"), true);
  assert.equal(escaped.includes("\\u2029"), true);
});

test("readonly workbench renders compact review stage from operational state", async () => {
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") return toolResult({
            items: [{ project: { project_id: "project_a", title: "Project A", status: "video_review" }, lifecycle: "active", updated_at: "2026-07-17T00:00:00.000Z" }],
            page: { next_offset: null }
          });
          if (name === "get_project_context") return toolResult({ project: { project_id: "project_a", title: "Project A", status: "video_review" }, workspace: "overview", summary: {} });
          if (name === "list_project_shots") return toolResult({
            items: [{ shot_id: "shot_1", order: 1, status: "video_review", description: "Compact review SHOT" }],
            page: { next_offset: null }
          });
          if (name === "get_review_package") return toolResult({
            shot: {
              shot_id: String(args.shot_id),
              description: "Compact review SHOT",
              operational_state: { review: { stage: "pending" } }
            },
            package_state: "available",
            reviewable: true,
            reason_code: null,
            selected_artifact_id: null,
            versions: [],
            notes: [],
            notes_total: 0
          });
          return toolResult({ project_status: "video_review", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reviewText = dom.window.document.querySelector("#review")?.textContent ?? "";
    assert.match(reviewText, /Review stagepending/);
    assert.doesNotMatch(reviewText, /Review stageunknown/);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench loads app-only media lazily and clears the capability URL on project switch", async () => {
  const mediaCalls: Array<{ project_id: string; artifact_id: string }> = [];
  const playbackUrl = `https://media.skmt617.top/media/v1/c/${"p".repeat(43)}`;
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") return toolResult({
            items: ["project_a", "project_b"].map((project_id) => ({ project: { project_id, title: project_id, status: "storyboard_review" } })),
            page: { next_offset: null }
          });
          if (name === "get_project_context") return toolResult({ project: { project_id: args.project_id, title: args.project_id }, workspace: "overview", summary: {}, metrics: {}, blockers: [] });
          if (name === "list_project_shots") return toolResult({
            items: [{ shot_id: `shot_${args.project_id}`, project_id: args.project_id, order: 1, description: "Storyboard", storyboard_image_artifact_id: `artifact_${args.project_id}`, operational_state: { storyboard: {}, review: {} } }],
            page: { next_offset: null }
          });
          if (name === "get_review_package") return toolResult({ shot: { shot_id: args.shot_id }, versions: [], notes: [] });
          if (name === "get_readonly_media_playback") {
            mediaCalls.push(args as { project_id: string; artifact_id: string });
            return {
              isError: false,
              structuredContent: { state: "ready", kind: "image", mime_type: "image/png", capability_expires_at: "2026-07-19T00:05:00.000Z", session_max_seconds: 1800, snapshot_fingerprint: FINGERPRINT },
              content: [],
              _meta: { playback_url: playbackUrl, snapshot_fingerprint: FINGERPRINT }
            };
          }
          return toolResult({ project_status: "storyboard_review", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    const loadButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".media-card button")].find((button) => button.textContent === "加载媒体");
    assert.ok(loadButton);
    loadButton.click();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const image = dom.window.document.querySelector<HTMLImageElement>(".media-card img");
    assert.ok(image);
    assert.equal(image.src, playbackUrl);
    assert.equal(image.crossOrigin, "anonymous");
    assert.equal(image.referrerPolicy, "no-referrer");
    assert.equal(JSON.stringify(mediaCalls), JSON.stringify([{ project_id: "project_a", artifact_id: "artifact_project_a" }]));

    const secondProject = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".project")].find((button) => button.dataset.projectId === "project_b");
    assert.ok(secondProject);
    secondProject.click();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(image.hasAttribute("src"), false);
  } finally {
    dom.window.close();
  }
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

test("readonly workbench maps an unregistered principal refresh to no authorized projects", async () => {
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async () => toolFailure("WEBGPT_PRINCIPAL_NOT_REGISTERED")
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.querySelector<HTMLElement>("#workspace")?.hidden, true);
    const visibleState = dom.window.document.querySelector<HTMLElement>("#global-state")?.textContent ?? "";
    assert.equal(visibleState.includes("No authorized projects"), true);
    assert.equal(visibleState.includes("Service temporarily unavailable"), false);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench clears business panels as soon as the client TTL reaches zero", async () => {
  const baseShell = shell();
  const expiringShell = {
    ...baseShell,
    status: { ...baseShell.status, ttl_remaining_seconds: 0.1 }
  };
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        nativeSetInterval(handler, timeout === 1000 ? 10 : timeout, ...args)) as typeof window.setInterval;
      Object.defineProperty(window, "openai", { value: {
        toolOutput: expiringShell,
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") {
            const result = toolResult({
              items: [{ project: { project_id: "project_ttl", title: "Expiring project", status: "active" }, lifecycle: "active", updated_at: "2026-07-17" }],
              page: { next_offset: null }
            });
            record(result._meta).snapshot_status = expiringShell.status;
            return result;
          }
          if (name === "get_project_context") return toolResult({ project: { project_id: args.project_id, title: "Expiring project", status: "active" }, workspace: "overview", summary: {} });
          if (name === "list_project_shots") return toolResult({ items: [], page: { next_offset: null } });
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(dom.window.document.querySelector<HTMLElement>("#workspace")?.hidden, false);
    assert.equal(dom.window.document.querySelector<HTMLElement>("#context")?.textContent?.includes("Expiring project"), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dom.window.document.querySelector<HTMLElement>("#workspace")?.hidden, true);
    assert.equal(dom.window.document.querySelector<HTMLElement>("#global-state")?.textContent?.includes("Snapshot expired"), true);
    assert.equal(dom.window.document.querySelector<HTMLElement>("#context")?.textContent, "");
  } finally {
    dom.window.close();
  }
});

test("readonly workbench does not mount business panels when the initial TTL is zero", async () => {
  const baseShell = shell();
  let calls = 0;
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: { ...baseShell, status: { ...baseShell.status, ttl_remaining_seconds: 0 } },
        callTool: async () => { calls += 1; return toolResult({ items: [], page: { next_offset: null } }); }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 0);
    assert.equal(dom.window.document.querySelector<HTMLElement>("#workspace")?.hidden, true);
    assert.equal(dom.window.document.querySelector<HTMLElement>("#global-state")?.textContent?.includes("Snapshot expired"), true);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench ignores project responses that arrive after a non-ready host shell", async () => {
  let resolveProjects!: (value: Record<string, unknown>) => void;
  const pendingProjects = new Promise<Record<string, unknown>>((resolve) => { resolveProjects = resolve; });
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async () => pendingProjects
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    dom.window.dispatchEvent(new dom.window.CustomEvent("openai:set_globals", {
      detail: { globals: { toolOutput: shell("no_snapshot") } }
    }));
    resolveProjects(toolResult({
      items: [{ project: { project_id: "stale_project", title: "Stale project", status: "active" } }],
      page: { next_offset: null }
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.querySelector<HTMLElement>("#workspace")?.hidden, true);
    assert.equal(dom.window.document.querySelector<HTMLElement>("#global-state")?.textContent?.includes("No snapshot published"), true);
    assert.equal(dom.window.document.querySelector<HTMLElement>("#projects")?.textContent?.includes("Stale project"), false);
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

test("readonly workbench appends project pages without cancelling detail loads", async () => {
  const contextRequest: { resolve: ((value: Record<string, unknown>) => void) | null } = { resolve: null };
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") {
            const secondPage = args.offset === 25;
            return toolResult({
              items: [{ project: { project_id: secondPage ? "project_b" : "project_a", title: secondPage ? "Project B" : "Project A", status: "active" }, lifecycle: "active", updated_at: "2026-07-17" }],
              page: { next_offset: secondPage ? null : 25 }
            });
          }
          if (name === "get_project_context") return new Promise((resolve) => { contextRequest.resolve = resolve; });
          if (name === "list_project_shots") return toolResult({ items: [] });
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(contextRequest.resolve);
    dom.window.document.querySelector<HTMLButtonElement>("#more-projects")!.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.body.textContent?.includes("Project B"), true);
    contextRequest.resolve(toolResult({ project: { project_id: "project_a", title: "Loaded context", status: "active" }, workspace: "overview", summary: {} }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.body.textContent?.includes("Loaded context"), true);
    assert.equal(dom.window.document.querySelector("#context")?.textContent?.includes("Loading"), false);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench paginates SHOTs without changing project generation", async () => {
  const shotOffsets: number[] = [];
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") return toolResult({
            items: [{ project: { project_id: "project_a", title: "Project A", status: "active" }, lifecycle: "active", updated_at: "2026-07-17" }],
            page: { next_offset: null }
          });
          if (name === "get_project_context") return toolResult({ project: { project_id: "project_a", title: "Project A", status: "active" }, workspace: "overview", summary: {} });
          if (name === "list_project_shots") {
            const offset = Number(args.offset ?? 0);
            shotOffsets.push(offset);
            return toolResult({
              items: [{ shot_id: offset === 0 ? "shot_1" : "shot_101", order: offset === 0 ? 1 : 101, status: "ready", description: offset === 0 ? "First SHOT" : "Later SHOT" }],
              page: { next_offset: offset === 0 ? 100 : null }
            });
          }
          if (name === "get_review_package") return toolResult({ shot: { shot_id: args.shot_id, description: String(args.shot_id) }, versions: [], notes: [] });
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(shotOffsets, [0]);
    dom.window.document.querySelector<HTMLButtonElement>('button[data-shot-id="shot_1"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    dom.window.document.querySelector<HTMLButtonElement>("#more-shots")!.click();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(shotOffsets, [0, 100]);
    assert.equal(dom.window.document.querySelector("#shots")?.textContent?.includes("First SHOT"), true);
    assert.equal(dom.window.document.querySelector("#shots")?.textContent?.includes("Later SHOT"), true);
    assert.equal(dom.window.document.querySelector("#context")?.textContent?.includes("Project A"), true);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench routes parallel tool failures to their own panels", async () => {
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string) => {
          if (name === "list_production_projects") return toolResult({
            items: [{ project: { project_id: "project_a", title: "Project A", status: "active" }, lifecycle: "active", updated_at: "2026-07-17" }],
            page: { next_offset: null }
          });
          if (name === "get_project_context") return toolResult({ project: { project_id: "project_a", title: "Healthy context", status: "active" }, workspace: "overview", summary: {} });
          if (name === "list_project_shots") return toolResult({ items: [], page: { next_offset: null } });
          if (name === "get_delivery_status") return toolFailure("RESPONSE_BUDGET_EXCEEDED");
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(dom.window.document.querySelector("#context")?.textContent?.includes("Healthy context"), true);
    assert.equal(dom.window.document.querySelector("#context")?.textContent?.includes("RESPONSE_BUDGET_EXCEEDED"), false);
    assert.equal(dom.window.document.querySelector("#delivery")?.textContent?.includes("RESPONSE_BUDGET_EXCEEDED"), true);
    assert.equal(dom.window.document.querySelector("#closeout")?.textContent?.includes("RESPONSE_BUDGET_EXCEEDED"), false);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench rejects stale review responses for prior SHOT selections", async () => {
  const firstReview: { resolve: ((value: Record<string, unknown>) => void) | null } = { resolve: null };
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") return toolResult({ items: [{ project: { project_id: "project_a", title: "Project A", status: "active" } }], page: { next_offset: null } });
          if (name === "get_project_context") return toolResult({ project: { project_id: "project_a", title: "Project A", status: "active" }, workspace: "overview", summary: {} });
          if (name === "list_project_shots") return toolResult({ items: [
            { shot_id: "shot_1", order: 1, status: "ready", description: "First SHOT" },
            { shot_id: "shot_2", order: 2, status: "ready", description: "Second SHOT" }
          ], page: { next_offset: null } });
          if (name === "get_review_package" && args.shot_id === "shot_1") return new Promise((resolve) => { firstReview.resolve = resolve; });
          if (name === "get_review_package") return toolResult({ shot: { shot_id: "shot_2", description: "Second review" }, versions: [], notes: [] });
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(firstReview.resolve);
    dom.window.document.querySelector<HTMLButtonElement>('button[data-shot-id="shot_2"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.querySelector("#review")?.textContent?.includes("Second review"), true);
    firstReview.resolve(toolResult({ shot: { shot_id: "shot_1", description: "STALE FIRST REVIEW" }, versions: [], notes: [] }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.querySelector("#review")?.textContent?.includes("Second review"), true);
    assert.equal(dom.window.document.querySelector("#review")?.textContent?.includes("STALE FIRST REVIEW"), false);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench preserves the selected project when refresh fails", async () => {
  let projectListCalls = 0;
  const contextProjects: string[] = [];
  const baseShell = shell();
  const initial = { ...baseShell, initial_intent: { ...baseShell.initial_intent, project_id: "project_page_2" } };
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: initial,
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") {
            projectListCalls += 1;
            if (projectListCalls === 2) return toolFailure("SERVICE_TEMPORARILY_UNAVAILABLE");
            return toolResult({ items: [{ project: { project_id: "project_page_1", title: "First page", status: "active" } }], page: { next_offset: 25 } });
          }
          if (name === "get_project_context") {
            contextProjects.push(String(args.project_id ?? ""));
            return toolResult({ project: { project_id: args.project_id, title: "Selected page 2", status: "active" }, workspace: "overview", summary: {} });
          }
          if (name === "list_project_shots") return toolResult({ items: [], page: { next_offset: null } });
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    dom.window.document.querySelector<HTMLButtonElement>("#refresh")!.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    dom.window.document.querySelector<HTMLButtonElement>("#refresh")!.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(projectListCalls, 3);
    assert.deepEqual(new Set(contextProjects), new Set(["project_page_2"]));
    assert.equal(dom.window.document.querySelector("#context")?.textContent?.includes("Selected page 2"), true);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench reloads project pages from offset zero after snapshot changes", async () => {
  const offsets: number[] = [];
  const secondFingerprint = "d".repeat(64);
  let projectListCalls = 0;
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") {
            projectListCalls += 1;
            const offset = Number(args.offset ?? 0);
            offsets.push(offset);
            if (projectListCalls === 1) return toolResult({ items: [{ project: { project_id: "project_old", title: "Old first page", status: "active" } }], page: { next_offset: 25 } });
            if (projectListCalls === 2) return toolResult({ items: [{ project: { project_id: "project_wrong_page", title: "New second page", status: "active" } }], page: { next_offset: null } }, secondFingerprint);
            return toolResult({ items: [{ project: { project_id: "project_new", title: "New first page", status: "active" } }], page: { next_offset: null } }, secondFingerprint);
          }
          if (name === "get_project_context") return toolResult({ project: { project_id: args.project_id, title: String(args.project_id), status: "active" }, workspace: "overview", summary: {} }, projectListCalls >= 3 ? secondFingerprint : FINGERPRINT);
          if (name === "list_project_shots") return toolResult({ items: [], page: { next_offset: null } }, projectListCalls >= 3 ? secondFingerprint : FINGERPRINT);
          return toolResult({ project_status: "active", readiness_checks: [] }, projectListCalls >= 3 ? secondFingerprint : FINGERPRINT);
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    dom.window.document.querySelector<HTMLButtonElement>("#more-projects")!.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(offsets, [0, 25, 0]);
    assert.equal(dom.window.document.body.textContent?.includes("New first page"), true);
    assert.equal(dom.window.document.body.textContent?.includes("New second page"), false);
    assert.equal(dom.window.document.body.textContent?.includes("Old first page"), false);
    assert.equal(dom.window.document.querySelector("#context")?.textContent?.includes("project_new"), true);
  } finally {
    dom.window.close();
  }
});

test("readonly workbench preserves the selected paged SHOT across refresh", async () => {
  const reviewShots: string[] = [];
  const dom = new JSDOM(readonlyWorkbenchWidgetHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, "openai", { value: {
        toolOutput: shell(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === "list_production_projects") return toolResult({ items: [{ project: { project_id: "project_a", title: "Project A", status: "active" } }], page: { next_offset: null } });
          if (name === "get_project_context") return toolResult({ project: { project_id: "project_a", title: "Project A", status: "active" }, workspace: "overview", summary: {} });
          if (name === "list_project_shots") {
            const offset = Number(args.offset ?? 0);
            return toolResult({
              items: [{ shot_id: offset === 0 ? "shot_1" : "shot_101", order: offset === 0 ? 1 : 101, status: "ready", description: offset === 0 ? "First SHOT" : "Paged SHOT" }],
              page: { next_offset: offset === 0 ? 100 : null }
            });
          }
          if (name === "get_review_package") {
            const shotId = String(args.shot_id ?? "");
            reviewShots.push(shotId);
            return toolResult({ shot: { shot_id: shotId, description: shotId === "shot_101" ? "Paged review" : "First review" }, versions: [], notes: [] });
          }
          return toolResult({ project_status: "active", readiness_checks: [] });
        }
      }, configurable: true });
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    dom.window.document.querySelector<HTMLButtonElement>("#more-shots")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    dom.window.document.querySelector<HTMLButtonElement>('button[data-shot-id="shot_101"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    dom.window.document.querySelector<HTMLButtonElement>("#refresh")!.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reviewShots.at(-1), "shot_101");
    assert.equal(dom.window.document.querySelector("#review")?.textContent?.includes("Paged review"), true);
    assert.equal(dom.window.document.querySelector("#review")?.textContent?.includes("First review"), false);
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
