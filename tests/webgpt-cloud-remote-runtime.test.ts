import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";

import { openM0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { bootstrapWebGptProjectOwner } from "../src/webgpt-v4/authorizationAdmin.js";
import type { WebGptV4ReadonlyFederatedAuthConfig } from "../src/webgpt-v4/auth.js";
import { actorFromFederatedSubject, issuerHash } from "../src/webgpt-v4/types.js";
import { exportReadonlySnapshotFromDatabase } from "../src/webgpt-cloud/dataSource.js";
import {
  READONLY_REMOTE_SERVICE_VERSION,
  startReadonlyRemoteRuntime,
  type ReadonlyRemoteLogEvent
} from "../src/webgpt-cloud/remoteRuntime.js";
import { ReadonlySnapshotStore, signReadonlySnapshot } from "../src/webgpt-cloud/signedSnapshot.js";
import { finalizeReadonlySnapshot, type ReadonlySnapshot } from "../src/webgpt-cloud/snapshot.js";

const ISSUER = "https://issuer.example.test/";
const RESOURCE = "https://aivideo.skmt617.top/mcp";
const SUBJECT = "auth0|readonly-remote-owner";

function authConfig(): WebGptV4ReadonlyFederatedAuthConfig {
  return {
    provider: "federated",
    access_model: "project_membership",
    issuer: ISSUER,
    issuer_hash: issuerHash(ISSUER),
    audience: RESOURCE,
    resource_url: RESOURCE,
    jwks_uri: "https://issuer.example.test/.well-known/jwks.json",
    client_registration: "predefined",
    configuration_source: "generic"
  };
}

function fixtureSnapshot(generatedAt = new Date(Date.now() - 60_000).toISOString()): {
  root: string;
  snapshot: ReadonlySnapshot;
  project_id: string;
  shot_id: string;
  actor: ReturnType<typeof actorFromFederatedSubject>;
} {
  const root = mkdtempSync(join(tmpdir(), "readonly-remote-runtime-"));
  const sqlitePath = join(root, "app.sqlite");
  const actor = actorFromFederatedSubject(ISSUER, SUBJECT, ["projects.read"]);
  const db = openM0Database(sqlitePath);
  const created = createProject({ title: "Readonly remote fixture" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture project creation failed");
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
  const shot: Shot = {
    shot_id: "shot_readonly_remote_001",
    project_id: created.project_id,
    order: 1,
    status: "storyboard_approved",
    duration_seconds: 6,
    description: "Readonly remote SHOT",
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
  bootstrapWebGptProjectOwner(db, actor.principal_id, created.project_id, "READONLY_REMOTE_FIXTURE", actor.issuer_hash!);
  db.close();
  return {
    root,
    snapshot: exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: actor.issuer_hash!,
      resource_url: RESOURCE,
      generated_at: generatedAt,
      ttl_seconds: 60 * 60
    }),
    project_id: created.project_id,
    shot_id: shot.shot_id,
    actor
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("remote runtime module graph excludes SQLite and local database adapter entrypoints", () => {
  const root = resolve("src/webgpt-cloud/remoteRuntime.ts");
  const visited = new Set<string>();
  const visit = (path: string): void => {
    const normalized = path.replaceAll("\\", "/");
    assert.equal(normalized.includes("/storage/"), false, normalized);
    assert.equal(normalized.endsWith("/webgpt-cloud/dataSource.ts"), false, normalized);
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("openM0Database"), false, normalized);
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const specifier = match[1]!;
      const candidate = resolve(dirname(path), specifier.replace(/\.js$/, ".ts"));
      if (existsSync(candidate)) visit(candidate);
    }
  };
  visit(root);
});

test("signed snapshot transport rejects tampering and atomically replaces only newer snapshots", () => {
  const first = fixtureSnapshot(new Date(Date.now() - 120_000).toISOString());
  const second = fixtureSnapshot(new Date(Date.now() - 60_000).toISOString());
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  try {
    const store = new ReadonlySnapshotStore("publisher-v1", publicKey, () => new Date(), { resource_url: RESOURCE, issuer_hash: issuerHash(ISSUER) });
    const firstEnvelope = signReadonlySnapshot(first.snapshot, "publisher-v1", privateKey);
    assert.equal(store.replace(firstEnvelope).snapshot_fingerprint, first.snapshot.snapshot_fingerprint);
    assert.throws(() => { store.read()!.projects = []; }, TypeError);

    const { snapshot_fingerprint: _wrongFingerprint, ...wrongResourceUnsigned } = structuredClone(first.snapshot);
    const wrongResourceSnapshot = finalizeReadonlySnapshot({ ...wrongResourceUnsigned, resource_url: "https://wrong.example.test/mcp" });
    assert.throws(
      () => store.replace(signReadonlySnapshot(wrongResourceSnapshot, "publisher-v1", privateKey)),
      /READONLY_SNAPSHOT_RESOURCE_MISMATCH/
    );

    const expiredGeneratedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { snapshot_fingerprint: _expiredFingerprint, ...expiredUnsigned } = structuredClone(first.snapshot);
    const expiredSnapshot = finalizeReadonlySnapshot({
      ...expiredUnsigned,
      generated_at: expiredGeneratedAt,
      expires_at: new Date(Date.parse(expiredGeneratedAt) + 60 * 60_000).toISOString()
    });
    assert.throws(
      () => signReadonlySnapshot(expiredSnapshot, "publisher-v1", privateKey),
      /READONLY_SNAPSHOT_EXPIRED/
    );

    const tampered = structuredClone(firstEnvelope);
    tampered.signature = `${tampered.signature.slice(0, -1)}${tampered.signature.endsWith("A") ? "B" : "A"}`;
    assert.throws(() => store.replace(tampered), /READONLY_SNAPSHOT_SIGNATURE_INVALID/);
    assert.equal(store.read()?.snapshot_fingerprint, first.snapshot.snapshot_fingerprint);

    const secondEnvelope = signReadonlySnapshot(second.snapshot, "publisher-v1", privateKey);
    assert.equal(store.replace(secondEnvelope).snapshot_fingerprint, second.snapshot.snapshot_fingerprint);
    assert.throws(() => store.replace(firstEnvelope), /READONLY_SNAPSHOT_NOT_NEWER/);
    assert.equal(store.read()?.snapshot_fingerprint, second.snapshot.snapshot_fingerprint);
    assert.equal(store.replace(secondEnvelope).snapshot_fingerprint, second.snapshot.snapshot_fingerprint);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("remote OAuth challenges, signed publish, six readonly tools, and readiness stay fail closed", async () => {
  const fixture = fixtureSnapshot();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ownerToken = await new SignJWT({ scope: "projects.read" })
    .setProtectedHeader({ alg: "RS256", kid: "readonly-remote-jwt" })
    .setIssuer(ISSUER).setAudience(RESOURCE).setSubject(SUBJECT).setIssuedAt().setExpirationTime("5m")
    .sign(jwtKeys.privateKey);
  const deniedToken = await new SignJWT({ scope: "" })
    .setProtectedHeader({ alg: "RS256", kid: "readonly-remote-jwt" })
    .setIssuer(ISSUER).setAudience(RESOURCE).setSubject(SUBJECT).setIssuedAt().setExpirationTime("5m")
    .sign(jwtKeys.privateKey);
  const unregisteredToken = await new SignJWT({ scope: "projects.read" })
    .setProtectedHeader({ alg: "RS256", kid: "readonly-remote-jwt" })
    .setIssuer(ISSUER).setAudience(RESOURCE).setSubject("auth0|unregistered-remote-user").setIssuedAt().setExpirationTime("5m")
    .sign(jwtKeys.privateKey);
  const events: ReadonlyRemoteLogEvent[] = [];
  const runtime = await startReadonlyRemoteRuntime({
    port: 0,
    auth_config: authConfig(),
    publisher_key_id: "publisher-v1",
    publisher_public_key: publicKey,
    auth_jwks: async () => jwtKeys.publicKey,
    log: (event) => events.push(event)
  });
  try {
    const health = await fetch(`${runtime.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(jsonRecord(await health.json()).version, READONLY_REMOTE_SERVICE_VERSION);

    const notReady = await fetch(`${runtime.origin}/readyz`);
    assert.equal(notReady.status, 503);
    assert.equal(jsonRecord(jsonRecord(await notReady.json()).checks).snapshot_fresh, false);

    const metadata = await fetch(`${runtime.origin}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(jsonRecord(await metadata.json()), {
      resource: RESOURCE,
      resource_name: "AI Video Production Assistant",
      authorization_servers: [ISSUER],
      scopes_supported: ["projects.read"],
      bearer_methods_supported: ["header"],
      configured: true
    });

    const unauthorized = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    const unauthorizedBody = jsonRecord(await unauthorized.json());
    assert.equal(JSON.stringify(unauthorizedBody).includes("project_id"), false);
    assert.equal(JSON.stringify(unauthorizedBody).includes("mcp/www_authenticate"), true);

    const denied = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${deniedToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get("www-authenticate") ?? "", /insufficient_scope/);
    assert.match(denied.headers.get("www-authenticate") ?? "", /projects\.read/);

    const emptyTransport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { authorization: `Bearer ${ownerToken}` } } });
    const emptyClient = new Client({ name: "readonly-remote-empty-test", version: "1.0.0" });
    try {
      await emptyClient.connect(emptyTransport);
      const emptyResult = await emptyClient.callTool({ name: "list_production_projects", arguments: {} });
      assert.equal(emptyResult.isError, true);
      const emptyStructured = jsonRecord(emptyResult.structuredContent);
      assert.equal(jsonRecord(emptyStructured.error).code, "WEBGPT_CLOUD_SNAPSHOT_UNAVAILABLE");
    } finally {
      await emptyClient.close();
    }

    const envelope = signReadonlySnapshot(fixture.snapshot, "publisher-v1", privateKey);
    const published = await fetch(runtime.snapshot_url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    assert.equal(published.status, 202);
    assert.equal(jsonRecord(await published.json()).snapshot_fingerprint, fixture.snapshot.snapshot_fingerprint);
    assert.equal((await fetch(`${runtime.origin}/readyz`)).status, 200);

    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { authorization: `Bearer ${ownerToken}` } } });
    const client = new Client({ name: "readonly-remote-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), [
        "list_production_projects", "get_project_context", "list_project_shots",
        "get_review_package", "get_delivery_status", "get_closeout_evidence"
      ]);
      for (const tool of tools.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.deepEqual((tool._meta as Record<string, unknown>).securitySchemes, [{ type: "oauth2", scopes: ["projects.read"] }]);
      }
      const calls = [
        { name: "list_production_projects", arguments: {} },
        { name: "get_project_context", arguments: { project_id: fixture.project_id, workspace: "overview" } },
        { name: "list_project_shots", arguments: { project_id: fixture.project_id } },
        { name: "get_review_package", arguments: { project_id: fixture.project_id, shot_id: fixture.shot_id } },
        { name: "get_delivery_status", arguments: { project_id: fixture.project_id } },
        { name: "get_closeout_evidence", arguments: { project_id: fixture.project_id } }
      ];
      for (const call of calls) {
        const result = await client.callTool(call);
        assert.equal(result.isError, false, call.name);
        assert.equal(jsonRecord(result.structuredContent).ok, true);
        assert.equal(jsonRecord(result._meta).snapshot_fingerprint, fixture.snapshot.snapshot_fingerprint);
      }
      const crossProject = await client.callTool({ name: "get_project_context", arguments: { project_id: "project_not_authorized", workspace: "overview" } });
      assert.equal(crossProject.isError, true);
      assert.equal(jsonRecord(jsonRecord(crossProject.structuredContent).error).code, "PROJECT_NOT_FOUND");
    } finally {
      await client.close();
    }

    const unregisteredTransport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { authorization: `Bearer ${unregisteredToken}` } } });
    const unregisteredClient = new Client({ name: "readonly-remote-unregistered-test", version: "1.0.0" });
    try {
      await unregisteredClient.connect(unregisteredTransport);
      const result = await unregisteredClient.callTool({ name: "list_production_projects", arguments: {} });
      assert.equal(result.isError, true);
      const structured = jsonRecord(result.structuredContent);
      assert.equal(jsonRecord(structured.error).code, "WEBGPT_PRINCIPAL_NOT_REGISTERED");
      assert.equal("data" in structured, false);
    } finally {
      await unregisteredClient.close();
    }

    const serializedEvents = JSON.stringify(events);
    for (const forbidden of [fixture.project_id, fixture.shot_id, SUBJECT, ownerToken, deniedToken, unregisteredToken, "structuredContent", "tool input", "tool output"]) {
      assert.equal(serializedEvents.includes(forbidden), false, forbidden);
    }
    assert.equal(events.some((event) => event.event_type === "auth_failure" && event.http_status === 401), true);
    assert.equal(events.some((event) => event.event_type === "snapshot_publish" && event.http_status === 202), true);
  } finally {
    await runtime.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("remote snapshot expiry makes readiness and data tools fail closed while health stays live", async () => {
  const fixture = fixtureSnapshot();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let clock = new Date(Date.parse(fixture.snapshot.generated_at) + 1_000);
  const runtime = await startReadonlyRemoteRuntime({
    port: 0,
    auth_config: authConfig(),
    publisher_key_id: "publisher-v1",
    publisher_public_key: publicKey,
    authenticate: async () => fixture.actor,
    now: () => clock,
    log: () => undefined
  });
  try {
    const envelope = signReadonlySnapshot(fixture.snapshot, "publisher-v1", privateKey, clock);
    assert.equal((await fetch(runtime.snapshot_url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) })).status, 202);
    clock = new Date(Date.parse(fixture.snapshot.expires_at));
    const readiness = await fetch(`${runtime.origin}/readyz`);
    assert.equal(readiness.status, 503);
    assert.equal(jsonRecord(jsonRecord(await readiness.json()).snapshot).freshness_status, "snapshot_expired");
    assert.equal((await fetch(`${runtime.origin}/healthz`)).status, 200);

    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { authorization: "Bearer fixture" } } });
    const client = new Client({ name: "readonly-remote-expiry-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "list_production_projects", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(jsonRecord(jsonRecord(result.structuredContent).error).code, "WEBGPT_CLOUD_SNAPSHOT_EXPIRED");
    } finally {
      await client.close();
    }
  } finally {
    await runtime.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("remote runtime rejects oversized and rate-limited publish attempts without replacing the snapshot", async () => {
  const fixture = fixtureSnapshot();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const runtime = await startReadonlyRemoteRuntime({
    port: 0,
    auth_config: authConfig(),
    publisher_key_id: "publisher-v1",
    publisher_public_key: publicKey,
    authenticate: async () => fixture.actor,
    max_publish_body_bytes: 64,
    publish_requests_per_minute: 1,
    log: () => undefined
  });
  try {
    const envelope = signReadonlySnapshot(fixture.snapshot, "publisher-v1", privateKey);
    const wrongContentType = await fetch(runtime.snapshot_url, { method: "PUT", body: JSON.stringify(envelope) });
    assert.equal(wrongContentType.status, 415);
    assert.equal(jsonRecord(jsonRecord(await wrongContentType.json()).error).code, "READONLY_SNAPSHOT_PUBLISH_CONTENT_TYPE_REQUIRED");
    assert.equal(runtime.snapshot_status().freshness_status, "no_snapshot");
    const oversized = await fetch(runtime.snapshot_url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
    assert.equal(oversized.status, 413);
    assert.equal(runtime.snapshot_status().freshness_status, "no_snapshot");
    const limited = await fetch(runtime.snapshot_url, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(limited.status, 429);
    assert.equal(runtime.snapshot_status().freshness_status, "no_snapshot");
  } finally {
    await runtime.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
