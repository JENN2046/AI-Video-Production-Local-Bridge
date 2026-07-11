import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const legacyEntries = [
  "webgpt-readonly-bridge.js",
  "webgpt-draft-bridge.js",
  "webgpt-human-handoff-bridge.js",
  "webgpt-review-assistant-bridge.js",
  "webgpt-production-assistant-bridge.js",
  "r2g-l-chatgpt-read-only-live-smoke-local-entry-server.js"
];

test("legacy WebGPT entry points are offline read-only commands and never remain listening", () => {
  for (const entry of legacyEntries) {
    const path = fileURLToPath(new URL(`../scripts/${entry}`, import.meta.url));
    const result = spawnSync(process.execPath, [path], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.mode, "LEGACY_OFFLINE_READ_ONLY");
    assert.equal(output.network_listener_started, false);
    assert.equal(output.writes_allowed, false);
  }
});
