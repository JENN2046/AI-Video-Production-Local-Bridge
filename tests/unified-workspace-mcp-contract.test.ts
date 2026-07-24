import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
  createUnifiedWorkspaceOAuthAuthenticator,
  loadUnifiedWorkspaceOAuthConfig,
  UNIFIED_WORKSPACE_MCP_PATH,
  unifiedWorkspaceProtectedResourceMetadata,
  unifiedWorkspaceProtectedResourceMetadataUrl,
  unifiedWorkspaceWwwAuthenticate
} from "../src/unified-workspace/oauth.js";
import {
  assertUnifiedWorkspaceToolCatalog,
  UNIFIED_WORKSPACE_APP_ONLY_TOOL_CATALOG,
  UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG,
  UNIFIED_WORKSPACE_OAUTH_SCOPES,
  unifiedWorkspaceToolScopes
} from "../src/unified-workspace/toolCatalog.js";
import { issuerHash, WebGptV4Error } from "../src/webgpt-v4/types.js";

const issuer = "https://tenant.example.test/";
const resource = "https://aivideo.example.test/workspace/mcp";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WEBGPT_WORKSPACE_RESOURCE_URL: resource,
    WEBGPT_WORKSPACE_OAUTH_ISSUER: issuer,
    WEBGPT_WORKSPACE_OAUTH_AUDIENCE: resource,
    WEBGPT_WORKSPACE_OAUTH_JWKS_URI: "https://tenant.example.test/.well-known/jwks.json",
    WEBGPT_WORKSPACE_OAUTH_CLIENT_REGISTRATION: "predefined",
    ...overrides
  };
}

test("Unified Workspace MCP contract exposes exactly twelve model tools plus one App-only media tool", () => {
  assert.doesNotThrow(assertUnifiedWorkspaceToolCatalog);
  assert.equal(UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG.length, 12);
  assert.deepEqual(
    UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG.map((entry) => entry.name).sort(),
    [
      "get_closeout_evidence",
      "get_delivery_status",
      "get_director_context",
      "get_director_focus",
      "get_director_proposal_status",
      "get_project_context",
      "get_review_package",
      "inspect_director_video_frames",
      "list_project_shots",
      "list_production_projects",
      "render_ai_video_workspace_app",
      "submit_director_proposal"
    ].sort()
  );
  assert.deepEqual(UNIFIED_WORKSPACE_APP_ONLY_TOOL_CATALOG.map((entry) => entry.name), ["get_readonly_media_playback"]);
  assert.deepEqual(UNIFIED_WORKSPACE_OAUTH_SCOPES, ["projects.read", "media.read", "proposals.write"]);
});

test("Unified Workspace MCP contract assigns independent readonly and Director scopes", () => {
  const scopes = unifiedWorkspaceToolScopes();
  assert.deepEqual(scopes.render_ai_video_workspace_app, ["projects.read"]);
  assert.deepEqual(scopes.inspect_director_video_frames, ["projects.read", "media.read"]);
  assert.deepEqual(scopes.submit_director_proposal, ["projects.read", "proposals.write"]);
  assert.equal(scopes.get_readonly_media_playback, undefined);
  assert.deepEqual(unifiedWorkspaceToolScopes(true).get_readonly_media_playback, ["projects.read"]);
});

test("Unified Workspace OAuth resource is complete, distinct, and advertises the fixed scopes", () => {
  const config = loadUnifiedWorkspaceOAuthConfig(env({
    WEBGPT_V4_RESOURCE_URL: "https://aivideo.example.test/mcp",
    WEBGPT_DIRECTOR_RESOURCE_URL: "https://aivideo.example.test/director/mcp"
  }))!;
  assert.equal(config.resource_url, resource);
  assert.equal(config.audience, resource);
  assert.equal(config.issuer_hash, issuerHash(issuer));
  assert.equal(unifiedWorkspaceProtectedResourceMetadataUrl(config), "https://aivideo.example.test/.well-known/oauth-protected-resource/workspace/mcp");
  assert.deepEqual(unifiedWorkspaceProtectedResourceMetadata(config), {
    resource,
    resource_name: "Jenn AI Video Workspace",
    authorization_servers: [issuer],
    scopes_supported: ["projects.read", "media.read", "proposals.write"],
    bearer_methods_supported: ["header"],
    configured: true
  });
  assert.match(
    unifiedWorkspaceWwwAuthenticate(config, "insufficient_scope", { scope: "proposals.write" }),
    /resource_metadata="https:\/\/aivideo\.example\.test\/.well-known\/oauth-protected-resource\/workspace\/mcp"/
  );
  assert.match(unifiedWorkspaceWwwAuthenticate(null), new RegExp(`resource_metadata="/.well-known/oauth-protected-resource${UNIFIED_WORKSPACE_MCP_PATH}"`));
});

test("Unified Workspace OAuth rejects partial, unsafe, and legacy-resource-colliding configuration", () => {
  assert.equal(loadUnifiedWorkspaceOAuthConfig({} as NodeJS.ProcessEnv), null);
  for (const candidate of [
    env({ WEBGPT_WORKSPACE_OAUTH_JWKS_URI: "" }),
    env({ WEBGPT_WORKSPACE_OAUTH_AUDIENCE: "https://aivideo.example.test/other" }),
    env({ WEBGPT_WORKSPACE_RESOURCE_URL: "http://aivideo.example.test/workspace/mcp" }),
    env({
      WEBGPT_WORKSPACE_RESOURCE_URL: "https://aivideo.example.test/mcp",
      WEBGPT_WORKSPACE_OAUTH_AUDIENCE: "https://aivideo.example.test/mcp"
    }),
    env({ WEBGPT_WORKSPACE_RESOURCE_URL: "https://aivideo.example.test/workspace/mcp?unsafe=true" }),
    env({ WEBGPT_WORKSPACE_OAUTH_CLIENT_REGISTRATION: "implicit" }),
    env({ WEBGPT_V4_RESOURCE_URL: resource }),
    env({ WEBGPT_DIRECTOR_RESOURCE_URL: resource })
  ]) {
    assert.throws(
      () => loadUnifiedWorkspaceOAuthConfig(candidate),
      (error) => error instanceof WebGptV4Error
        && ["INVALID_UNIFIED_WORKSPACE_OAUTH_CONFIG", "AMBIGUOUS_UNIFIED_WORKSPACE_OAUTH_RESOURCE"].includes(error.code)
    );
  }
});

test("Unified Workspace startup preserves stable OAuth and Bridge configuration error codes", () => {
  const command = resolve("dist/scripts/unified-workspace-remote-server.js");
  const base = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_NO_WARNINGS: "1"
  };
  for (const [overrides, expected] of [
    [{ WEBGPT_WORKSPACE_OAUTH_ISSUER: issuer }, "INVALID_UNIFIED_WORKSPACE_OAUTH_CONFIG"],
    [{ WEBGPT_DIRECTOR_BRIDGE_KEY_ID: "partial" }, "DIRECTOR_BRIDGE_KEY_INVALID"]
  ] as const) {
    const result = spawnSync(process.execPath, [command], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: { ...base, ...overrides }
    });
    assert.equal(result.status, 1);
    const bootFailure = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
    assert.deepEqual(bootFailure.event_type, "boot_failure");
    assert.equal(bootFailure.stable_error_code, expected);
  }
});

test("remote startup rejects private publisher material instead of deriving a public key", () => {
  const privatePem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const encoded = Buffer.from(privatePem, "utf8").toString("base64");
  for (const [command, overrides, expected] of [
    [
      "dist/scripts/unified-workspace-remote-server.js",
      { WEBGPT_WORKSPACE_PUBLISHER_KEY_ID: "workspace-publisher-test", WEBGPT_WORKSPACE_PUBLISHER_PUBLIC_KEY_B64: encoded },
      "UNIFIED_WORKSPACE_PUBLISHER_CONFIG_INVALID"
    ],
    [
      "dist/scripts/webgpt-cloud-server.js",
      { WEBGPT_CLOUD_PUBLISHER_KEY_ID: "readonly-publisher-test", WEBGPT_CLOUD_PUBLISHER_PUBLIC_KEY_B64: encoded },
      "READONLY_REMOTE_PUBLISHER_CONFIG_INVALID"
    ]
  ] as const) {
    const result = spawnSync(process.execPath, [resolve(command)], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_NO_WARNINGS: "1", ...overrides }
    });
    assert.equal(result.status, 1);
    const bootFailure = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
    assert.equal(bootFailure.stable_error_code, expected);
  }
});

test("Unified Workspace OAuth authenticator requires projects.read before any tool dispatch", async () => {
  const config = loadUnifiedWorkspaceOAuthConfig(env())!;
  const authenticator = createUnifiedWorkspaceOAuthAuthenticator(config, {
    jwks: async () => { throw new Error("fixture does not need key lookup"); }
  });
  await assert.rejects(
    () => authenticator({ headers: {} } as never),
    (error) => error instanceof WebGptV4Error && error.code === "AUTH_REQUIRED"
  );
});
