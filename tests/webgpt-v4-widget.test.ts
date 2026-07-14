import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

import { webGptV4WidgetHtml } from "../src/webgpt-v4/mcpApp.js";

const toolOutput = (filename: string) => ({
  ok: true,
  data: {
    artifact: { artifact_id: "artifact_widget", artifact_type: "image", role: "storyboard_image", filename, mime_type: "image/png", metadata: { aspect_ratio: "9:16" } },
    analysis: { kind: "image", model_input: "original_image" }
  },
  meta: { request_id: "widget", source_version: "webgpt-v4.2.0", updated_at: "2026-07-12T00:00:00.000Z" }
});

test("widget restores toolOutput, handles parent notifications, and rejects malformed or foreign messages", () => {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  virtualConsole.on("error", (error) => errors.push(String(error)));
  const dom = new JSDOM(webGptV4WidgetHtml(), {
    runScripts: "dangerously",
    url: "https://widgets.example.test/",
    virtualConsole,
    beforeParse(window) {
      (window as unknown as { openai: unknown }).openai = { toolOutput: toolOutput("restored.png"), toolResponseMetadata: { playback_url: "" } };
    }
  });
  const { window } = dom;
  const title = window.document.getElementById("title");
  assert.equal(title?.textContent, "restored.png");

  window.dispatchEvent(new window.MessageEvent("message", { source: {} as Window, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: toolOutput("foreign.png") } } }));
  assert.equal(title?.textContent, "restored.png");
  window.dispatchEvent(new window.MessageEvent("message", { source: window.parent, data: null }));
  assert.equal(title?.textContent, "restored.png");
  window.dispatchEvent(new window.MessageEvent("message", { source: window.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: toolOutput("notified.png"), _meta: { playback_url: "" } } } }));
  assert.equal(title?.textContent, "notified.png");
  assert.equal(errors.length, 0, errors.join("\n"));
  dom.window.close();
});
