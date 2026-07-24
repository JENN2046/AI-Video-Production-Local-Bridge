import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startUnifiedWorkspaceRemoteRuntime, UNIFIED_WORKSPACE_BRIDGE_POLL_PATH } from "../src/unified-workspace/remoteRuntime.js";
import { DirectorLocalBridgeClient } from "../src/director/bridge.js";
import type { DirectorNativeToolHandlers } from "../src/director/mcpContract.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { attachArtifactToShot, registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { bootstrapWebGptProjectOwner } from "../src/webgpt-v4/authorizationAdmin.js";
import { actorFromFederatedSubject, issuerHash, WebGptV4Error } from "../src/webgpt-v4/types.js";
import { exportReadonlySnapshotFromDatabase } from "../src/webgpt-cloud/dataSource.js";
import { signReadonlySnapshot } from "../src/webgpt-cloud/signedSnapshot.js";

const ISSUER = "https://auth.example.test/";
const WORKSPACE_RESOURCE = "https://aivideo.example.test/workspace/mcp";
const LEGACY_RESOURCE = "https://aivideo.example.test/mcp";
const SUBJECT = "auth0|unified-workspace-runtime-owner";
const ACTOR = actorFromFederatedSubject(ISSUER, SUBJECT, ["projects.read", "media.read", "proposals.write"]);

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function fixture(root: string) {
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  try {
    const created = createProject({ title: "Unified Workspace runtime fixture" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("fixture project creation failed");
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
    const shot: Shot = {
      shot_id: "shot_unified_workspace_runtime_001",
      project_id: created.project_id,
      order: 1,
      status: "storyboard_approved",
      duration_seconds: 6,
      description: "Unified Workspace runtime SHOT",
      storyboard_image_artifact_id: "",
      video_prompt: "Synthetic fixture prompt",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    created.project.shot_ids = [shot.shot_id];
    saveProject(db, created.project);
    const registered = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: created.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(registered.ok, true);
    if (!registered.ok) throw new Error("fixture artifact registration failed");
    const attached = attachArtifactToShot({
      project_id: created.project_id,
      shot_id: shot.shot_id,
      artifact_id: registered.artifact.artifact_id,
      reference: "storyboard_image_artifact_id",
      expected_current_artifact_id: ""
    }, db);
    assert.equal(attached.ok, true);
    bootstrapWebGptProjectOwner(db, ACTOR.principal_id, created.project_id, "UNIFIED_WORKSPACE_RUNTIME", ACTOR.issuer_hash!);
    return {
      project_id: created.project_id,
      artifact_id: registered.artifact.artifact_id,
      snapshotFor: (resource_url: string) => exportReadonlySnapshotFromDatabase({
        database_path: sqlitePath,
        issuer_hash: ACTOR.issuer_hash!,
        resource_url,
        generated_at: new Date(Date.now() - 1_000).toISOString(),
        ttl_seconds: 60 * 60
      })
    };
  } finally {
    db.close();
  }
}

function authConfig(resource_url: string) {
  return {
    provider: "federated" as const,
    access_model: "project_membership" as const,
    issuer: ISSUER,
    issuer_hash: issuerHash(ISSUER),
    audience: resource_url,
    resource_url,
    jwks_uri: "https://auth.example.test/.well-known/jwks.json",
    client_registration: "predefined" as const,
    configuration_source: "generic" as const
  };
}

test("Unified Workspace remote module graph remains detached from SQLite, local paths, and Provider execution", () => {
  const entry = resolve("src/unified-workspace/remoteRuntime.ts");
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("openM0Database"), false, path);
    assert.equal(source.includes("AI_VIDEO_WORKSPACE_DB_PATH"), false, path);
    assert.equal(source.includes("submitProvider"), false, path);
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const candidate = resolve(dirname(path), match[1]!.replace(/\.js$/, ".ts"));
      if (existsSync(candidate)) visit(candidate);
    }
  };
  visit(entry);
});

test("Unified Workspace rejects a legacy rollback route that collides with its OAuth resource", async () => {
  await assert.rejects(
    () => startUnifiedWorkspaceRemoteRuntime({
      port: 0,
      auth_config: authConfig(WORKSPACE_RESOURCE),
      legacy_readonly: {
        // Legacy Descope normalization trims the presentation-only trailing slash.
        auth_config: authConfig(`${WORKSPACE_RESOURCE}/`)
      }
    }),
    (error: unknown) => error instanceof WebGptV4Error
      && error.code === "AMBIGUOUS_UNIFIED_WORKSPACE_LEGACY_RESOURCE"
  );
});

test("Unified Workspace dispatches a Director read through the authenticated outbound bridge without a Snapshot", async () => {
  const keyring = { active: { kid: "unified-bridge-fixture", key: Buffer.alloc(32, 21) } };
  const runtime = await startUnifiedWorkspaceRemoteRuntime({
    port: 0,
    auth_config: authConfig(WORKSPACE_RESOURCE),
    authenticate: async () => ACTOR,
    bridge_keyring: keyring
  });
  let stopping = false;
  const handlers = (): DirectorNativeToolHandlers => ({
    get_director_focus: async () => ({ state: "no_focus", focus: null }),
    get_director_context: async () => { throw new Error("not invoked"); },
    inspect_director_video_frames: async () => { throw new Error("not invoked"); },
    submit_director_proposal: async () => { throw new Error("not invoked"); },
    get_director_proposal_status: async () => { throw new Error("not invoked"); }
  });
  const bridge = new DirectorLocalBridgeClient({
    remote_origin: runtime.origin,
    client_id: "unified-runtime-bridge-client",
    keyring,
    handlers: () => handlers()
  });
  const pump = (async () => {
    while (!stopping) {
      try { await bridge.runOnce(); } catch { /* tool results carry bounded failures */ }
      await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    }
  })();
  const client = new Client({ name: "unified-workspace-bridge", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url));
  try {
    await new Promise((resolveTick) => setTimeout(resolveTick, 30));
    assert.equal((await fetch(new URL("/readyz", runtime.origin))).status, 200);
    await client.connect(transport);
    const result = await client.callTool({ name: "get_director_focus", arguments: {} });
    assert.equal(result.isError, false);
    assert.equal(record(result.structuredContent).state, "no_focus");
  } finally {
    await transport.close().catch(() => undefined);
    stopping = true;
    await pump;
    await runtime.close();
  }
});

test("Unified Workspace refuses signed Snapshot publish until its OAuth contract is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "unified-workspace-publish-auth-"));
  const source = fixture(root);
  const pair = generateKeyPairSync("ed25519");
  const logs: Array<{ event_type: string; stable_error_code?: string }> = [];
  const runtime = await startUnifiedWorkspaceRemoteRuntime({
    port: 0,
    publisher_key_id: "unified-workspace-publisher-v1",
    publisher_public_key: pair.publicKey,
    log: (event) => logs.push(event)
  });
  try {
    const response = await fetch(runtime.snapshot_url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signReadonlySnapshot(source.snapshotFor(WORKSPACE_RESOURCE), "unified-workspace-publisher-v1", pair.privateKey))
    });
    assert.equal(response.status, 503);
    assert.equal(record(record(await response.json()).error).code, "READONLY_SNAPSHOT_PUBLISH_AUTH_NOT_CONFIGURED");
    assert.equal(logs.at(-1)?.event_type, "snapshot_publish");
    assert.equal(logs.at(-1)?.stable_error_code, "READONLY_SNAPSHOT_PUBLISH_AUTH_NOT_CONFIGURED");
    assert.equal(runtime.snapshot_status().freshness_status, "no_snapshot");
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Unified Workspace logs MCP authentication failures and classifies malformed Bridge JSON", async () => {
  const logs: Array<{ event_type: string; stable_error_code?: string }> = [];
  const runtime = await startUnifiedWorkspaceRemoteRuntime({
    port: 0,
    auth_config: authConfig(WORKSPACE_RESOURCE),
    authenticate: async () => { throw new WebGptV4Error("AUTH_REQUIRED", "Authentication is required."); },
    bridge_keyring: { active: { kid: "unified-bridge-fixture", key: Buffer.alloc(32, 28) } },
    log: (event) => logs.push(event)
  });
  try {
    const denied = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    assert.equal(denied.status, 401);
    assert.equal(logs.at(-1)?.event_type, "auth_failure");
    assert.equal(logs.at(-1)?.stable_error_code, "AUTH_REQUIRED");

    const malformed = await fetch(new URL(UNIFIED_WORKSPACE_BRIDGE_POLL_PATH, runtime.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assert.equal(record(record(await malformed.json()).error).code, "DIRECTOR_BRIDGE_INVALID_JSON_BODY");
    assert.equal(logs.at(-1)?.event_type, "bridge");
    assert.equal(logs.at(-1)?.stable_error_code, "DIRECTOR_BRIDGE_INVALID_JSON_BODY");
  } finally {
    await runtime.close();
  }
});

test("Unified and legacy MCP routes classify malformed and oversized authenticated bodies as client errors", async () => {
  const runtime = await startUnifiedWorkspaceRemoteRuntime({
    port: 0,
    auth_config: authConfig(WORKSPACE_RESOURCE),
    authenticate: async () => ACTOR,
    max_mcp_body_bytes: 4,
    legacy_readonly: {
      auth_config: authConfig(LEGACY_RESOURCE),
      authenticate: async () => ACTOR
    }
  });
  const assertClientBodyError = async (url: string, body: string, expectedStatus: number, expectedCode: string): Promise<void> => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(response.status, expectedStatus);
    const error = record(record(await response.json()).error);
    assert.equal(error.code, -32700);
    assert.equal(record(error.data).code, expectedCode);
  };
  try {
    for (const url of [runtime.mcp_url, runtime.legacy_mcp_url!]) {
      await assertClientBodyError(url, "{", 400, "INVALID_JSON_BODY");
      await assertClientBodyError(url, "{\"a\":1}", 413, "BODY_TOO_LARGE");
    }
  } finally {
    await runtime.close();
  }
});

test("Unified Workspace route exposes the fixed directory, isolates an unavailable Director bridge, and preserves legacy /mcp", async () => {
  const root = mkdtempSync(join(tmpdir(), "unified-workspace-runtime-"));
  const source = fixture(root);
  const pair = generateKeyPairSync("ed25519");
  let activeActor = ACTOR;
  let mediaRequests = 0;
  const runtime = await startUnifiedWorkspaceRemoteRuntime({
    port: 0,
    auth_config: authConfig(WORKSPACE_RESOURCE),
    authenticate: async () => activeActor,
    publisher_key_id: "unified-workspace-publisher-v1",
    publisher_public_key: pair.publicKey,
    publish_requests_per_minute: 1,
    media_gateway: {
      origin: "https://media.skmt617.top",
      keyring: { active: { kid: "unified-media-fixture", key: Buffer.alloc(32, 9) } },
      runtime: {
        resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
        post_pinned_address: async () => {
          mediaRequests += 1;
          return new Response(JSON.stringify({
            capability_handle: "m".repeat(43),
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString()
          }), { status: 201, headers: { "content-type": "application/json" } });
        }
      }
    },
    legacy_readonly: {
      auth_config: authConfig(LEGACY_RESOURCE),
      authenticate: async () => activeActor,
      publisher_key_id: "legacy-readonly-publisher-v1",
      publisher_public_key: pair.publicKey
    }
  });
  const client = new Client({ name: "unified-workspace-runtime", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url));
  const legacyClient = new Client({ name: "unified-workspace-legacy", version: "1.0.0" });
  const legacyTransport = new StreamableHTTPClientTransport(new URL(runtime.legacy_mcp_url!));
  try {
    const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/workspace/mcp", runtime.origin));
    assert.equal(metadata.status, 200);
    assert.deepEqual(record(await metadata.json()).scopes_supported, ["projects.read", "media.read", "proposals.write"]);
    const legacyMetadata = await fetch(new URL("/.well-known/oauth-protected-resource", runtime.origin));
    assert.equal(legacyMetadata.status, 200);
    assert.equal(record(await legacyMetadata.json()).resource, LEGACY_RESOURCE);
    assert.equal((await fetch(new URL("/readyz", runtime.origin))).status, 503);

    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 13);
    assert.equal(tools.tools.filter((tool) => ((tool._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility ?? []).includes("model")).length, 12);
    assert.deepEqual((tools.tools.find((tool) => tool.name === "get_readonly_media_playback")?._meta as { ui?: { visibility?: string[] } }).ui?.visibility, ["app"]);
    assert.deepEqual((tools.tools.find((tool) => tool.name === "get_director_focus")?._meta as { ui?: { visibility?: string[] } }).ui?.visibility, ["model", "app"]);
    assert.deepEqual((tools.tools.find((tool) => tool.name === "get_director_context")?._meta as { ui?: { visibility?: string[] } }).ui?.visibility, ["model"]);
    for (const tool of tools.tools) {
      const scopes = (tool._meta as { securitySchemes?: Array<{ scopes?: string[] }> } | undefined)?.securitySchemes?.[0]?.scopes;
      const expected = tool.name === "inspect_director_video_frames"
        ? ["projects.read", "media.read"]
        : tool.name === "submit_director_proposal"
          ? ["projects.read", "proposals.write"]
          : ["projects.read"];
      assert.deepEqual(scopes, expected, tool.name);
    }

    const empty = await client.callTool({ name: "render_ai_video_workspace_app", arguments: {} });
    assert.equal(record(empty.structuredContent).app_state, "no_snapshot");
    assert.deepEqual(record(empty.structuredContent).director, { state: "unavailable", bridge_connected: false });

    const published = await fetch(runtime.snapshot_url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signReadonlySnapshot(source.snapshotFor(WORKSPACE_RESOURCE), "unified-workspace-publisher-v1", pair.privateKey))
    });
    assert.equal(published.status, 202);
    const rateLimitedPublish = await fetch(runtime.snapshot_url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signReadonlySnapshot(source.snapshotFor(WORKSPACE_RESOURCE), "unified-workspace-publisher-v1", pair.privateKey))
    });
    assert.equal(rateLimitedPublish.status, 429);
    assert.equal(record(record(await rateLimitedPublish.json()).error).code, "READONLY_SNAPSHOT_PUBLISH_RATE_LIMITED");
    assert.equal((await fetch(new URL("/readyz", runtime.origin))).status, 200);

    const shell = record((await client.callTool({ name: "render_ai_video_workspace_app", arguments: {} })).structuredContent);
    assert.equal(shell.app_state, "ready");
    assert.equal(record(shell.director).state, "unavailable");
    const projects = await client.callTool({ name: "list_production_projects", arguments: { detail: "compact" } });
    assert.equal(record(projects.structuredContent).ok, true);
    const media = await client.callTool({ name: "get_readonly_media_playback", arguments: {
      project_id: source.project_id,
      artifact_id: source.artifact_id
    } });
    assert.equal(media.isError, false, String(record(media._meta).media_error_code ?? ""));
    assert.equal(record(media._meta).playback_url, `https://media.skmt617.top/media/v1/c/${"m".repeat(43)}`);
    assert.equal(JSON.stringify(media.structuredContent).includes("media.skmt617.top"), false);
    assert.equal(mediaRequests, 1);
    const director = await client.callTool({ name: "get_director_focus", arguments: {} });
    assert.equal(director.isError, true);
    const directorContent = director.content as Array<{ text?: string }> | undefined;
    assert.match(String(directorContent?.[0]?.text), /DIRECTOR_BRIDGE_UNAVAILABLE/);
    activeActor = { ...ACTOR, scopes: new Set(["projects.read"]) };
    const deniedFrames = await client.callTool({ name: "inspect_director_video_frames", arguments: {
      focus_id: "focus_scope_fixture", focus_generation: 1, artifact_id: "artifact_scope_fixture"
    } });
    const deniedProposal = await client.callTool({ name: "submit_director_proposal", arguments: {
      focus_id: "focus_scope_fixture",
      focus_generation: 1,
      base_state_hash: "a".repeat(64),
      idempotency_key: "scope-proposal-0001",
      proposal: {
        kind: "storyboard_revision",
        payload: {
          shot_id: "shot_scope_fixture",
          diagnosis: "Fixture scope check.",
          keep: [],
          change: ["Keep the revision advisory."],
          storyboard_prompt: "Fixture storyboard prompt.",
          negative_prompt: "",
          composition_notes: "",
          continuity_constraints: []
        }
      }
    } });
    assert.equal(deniedFrames.isError, true);
    assert.equal(deniedProposal.isError, true);
    assert.match(String((deniedFrames.content as Array<{ text?: string }> | undefined)?.[0]?.text), /INSUFFICIENT_SCOPE/);
    assert.match(String((deniedProposal.content as Array<{ text?: string }> | undefined)?.[0]?.text), /INSUFFICIENT_SCOPE/);
    activeActor = ACTOR;

    await legacyClient.connect(legacyTransport);
    const legacyPublished = await fetch(runtime.legacy_snapshot_url!, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signReadonlySnapshot(source.snapshotFor(LEGACY_RESOURCE), "legacy-readonly-publisher-v1", pair.privateKey))
    });
    assert.equal(legacyPublished.status, 202);
    const legacyProjects = await legacyClient.callTool({ name: "list_production_projects", arguments: { detail: "compact" } });
    assert.equal(record(legacyProjects.structuredContent).ok, true);
  } finally {
    await Promise.allSettled([transport.close(), legacyTransport.close()]);
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
