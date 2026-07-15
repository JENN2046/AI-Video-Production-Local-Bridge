import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { createOAuthAuthenticator, type WebGptV4ReadonlyFederatedAuthConfig } from "../src/webgpt-v4/auth.js";
import { bootstrapWebGptProjectOwner, grantWebGptProjectMembership, registerWebGptPrincipal, revokeWebGptProjectMembership, bindWebGptPrincipalIssuer } from "../src/webgpt-v4/authorizationAdmin.js";
import { assertWebGptPredefinedPublicClientCapability, type WebGptPredefinedPublicClientCapability } from "../src/webgpt-v4/predefinedClientContract.js";
import { authorizedWebGptProjectIds, requireWebGptProjectReadAccess } from "../src/webgpt-v4/projectAuthorization.js";
import { startWebGptV4 } from "../src/webgpt-v4/server.js";
import { webGptV4ToolsForProfile } from "../src/webgpt-v4/toolCatalog.js";
import { actorFromFederatedSubject, issuerHash, WebGptV4Error } from "../src/webgpt-v4/types.js";

const ISSUER = "https://fixture.stytch.example/oauth2";
const RESOURCE = "https://api.openai.com/v1/mcp/tunnel_fixture";
const REDIRECT_URI = "https://chatgpt.example.test/oauth/callback";
const EXPECTED_CLIENT_TARGET = { resource_url: RESOURCE, redirect_uri: REDIRECT_URI };

function federatedConfig(): WebGptV4ReadonlyFederatedAuthConfig {
  return {
    provider: "federated",
    access_model: "project_membership",
    issuer: ISSUER,
    issuer_hash: issuerHash(ISSUER),
    audience: RESOURCE,
    resource_url: RESOURCE,
    jwks_uri: "https://fixture.stytch.example/.well-known/jwks.json",
    client_registration: "predefined",
    configuration_source: "generic"
  };
}

const stytchFixtureCapability: WebGptPredefinedPublicClientCapability = {
  provider_id: "stytch",
  client_registration: "predefined",
  grant_types: ["authorization_code"],
  pkce_code_challenge_method: "S256",
  token_endpoint_auth_method: "none",
  configured_scopes: ["projects.read"],
  redirect_uris: [REDIRECT_URI],
  redirect_policy: "exact_allowlist",
  resource_url: RESOURCE,
  access_token_audience: RESOURCE,
  client_credentials_enabled: false,
  client_secret_present: false
};

function request(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

function stableValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return { buffer_sha256: createHash("sha256").update(value).digest("hex") };
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
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

function makeProductionProject(db: M0Database, title: string, shotId?: string): { project_id: string; shot_id?: string } {
  const created = createProject({ title }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture setup failed");
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
  if (!shotId) return { project_id: created.project_id };
  const shot: Shot = {
    shot_id: shotId, project_id: created.project_id, order: 1, status: "storyboard_approved", duration_seconds: 6,
    description: "Selected provider readonly fixture", storyboard_image_artifact_id: "", video_prompt: "Fixture prompt", negative_prompt: "",
    generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  created.project.shot_ids = [shot.shot_id];
  saveProject(db, created.project);
  return { project_id: created.project_id, shot_id: shot.shot_id };
}

test("selected provider capability rejects missing PKCE, public-client, audience, and scope guarantees", () => {
  assert.deepEqual(assertWebGptPredefinedPublicClientCapability(stytchFixtureCapability, EXPECTED_CLIENT_TARGET), {
    compatible: true,
    client_registration: "predefined",
    external_client_registration: "pending"
  });
  const invalid: Array<Partial<WebGptPredefinedPublicClientCapability>> = [
    { pkce_code_challenge_method: "plain" },
    { token_endpoint_auth_method: "client_secret_post" },
    { access_token_audience: "https://wrong-audience.example/mcp" },
    { resource_url: "https://wrong-resource.example/mcp", access_token_audience: "https://wrong-resource.example/mcp" },
    { configured_scopes: [] },
    { configured_scopes: ["projects.read", "media.read"] },
    { grant_types: ["authorization_code", "client_credentials"] },
    { client_credentials_enabled: true },
    { client_secret_present: true },
    { redirect_uris: ["http://localhost/callback"] },
    { redirect_uris: ["https://other-chatgpt-app.example.test/oauth/callback"] },
    { redirect_uris: ["https://chatgpt.example.test/oauth/callback", "https://extra.example.test/callback"] }
  ];
  for (const override of invalid) {
    assert.throws(
      () => assertWebGptPredefinedPublicClientCapability({ ...stytchFixtureCapability, ...override }, EXPECTED_CLIENT_TARGET),
      (error) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_PROVIDER_CAPABILITY"
    );
  }
});

test("selected provider JWT verifies signature, issuer, audience, expiry, scope claims, and key rotation", async () => {
  const first = await generateKeyPair("RS256");
  const rotated = await generateKeyPair("RS256");
  const attacker = await generateKeyPair("RS256");
  const firstJwk = await exportJWK(first.publicKey);
  const rotatedJwk = await exportJWK(rotated.publicKey);
  Object.assign(firstJwk, { kid: "selected-provider-key-1", alg: "RS256", use: "sig" });
  Object.assign(rotatedJwk, { kid: "selected-provider-key-2", alg: "RS256", use: "sig" });
  const authenticate = createOAuthAuthenticator(federatedConfig(), { jwks: createLocalJWKSet({ keys: [firstJwk, rotatedJwk] }) });
  const sign = (input: {
    subject?: string;
    private_key?: CryptoKey;
    kid?: string;
    issuer?: string;
    audience?: string;
    expiry?: string;
    claims?: Record<string, unknown>;
  } = {}) => new SignJWT(input.claims ?? { scope: "projects.read" })
    .setProtectedHeader({ alg: "RS256", kid: input.kid ?? "selected-provider-key-1" })
    .setIssuer(input.issuer ?? ISSUER)
    .setAudience(input.audience ?? RESOURCE)
    .setSubject(input.subject ?? "selected-provider-user-a")
    .setIssuedAt()
    .setExpirationTime(input.expiry ?? "5m")
    .sign(input.private_key ?? first.privateKey);

  const firstActor = await authenticate(request(await sign()));
  const rotatedToken = await sign({ subject: "selected-provider-user-b", private_key: rotated.privateKey, kid: "selected-provider-key-2", claims: { scp: ["projects.read"] } });
  const secondActor = await authenticate(request(rotatedToken));
  assert.notEqual(firstActor.principal_id, secondActor.principal_id);
  assert.equal(firstActor.issuer_hash, issuerHash(ISSUER));
  assert.equal(secondActor.scopes.has("projects.read"), true);
  const afterRotation = createOAuthAuthenticator(federatedConfig(), { jwks: createLocalJWKSet({ keys: [rotatedJwk] }) });
  assert.equal((await afterRotation(request(rotatedToken))).principal_id, secondActor.principal_id);
  const retiredKeyToken = await sign();
  await assert.rejects(() => afterRotation(request(retiredKeyToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");

  for (const token of [
    await sign({ private_key: attacker.privateKey }),
    await sign({ issuer: "https://wrong-issuer.example/" }),
    await sign({ audience: "https://wrong-audience.example/mcp" }),
    await sign({ expiry: "0s" }),
    await sign({ kid: "unknown-key" })
  ]) {
    await assert.rejects(() => authenticate(request(token)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
  }
  const conflictingScope = await sign({ claims: { scope: "projects.read", scp: ["projects.read", "media.read"] } });
  await assert.rejects(
    () => authenticate(request(conflictingScope)),
    (error) => error instanceof WebGptV4Error && error.code === "AUTH_SCOPE_CLAIM_CONFLICT"
  );
  const missingReadScope = await sign({ claims: { scope: "openid" } });
  await assert.rejects(
    () => authenticate(request(missingReadScope)),
    (error) => error instanceof WebGptV4Error && error.code === "INSUFFICIENT_SCOPE"
  );
});

test("selected provider authorization distinguishes unregistered, owner, viewer, revoked, and cross-project access", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-selected-provider-authz-"));
  const db = openM0Database(join(root, "app.sqlite"));
  try {
    const assigned = makeProductionProject(db, "Assigned project");
    const other = makeProductionProject(db, "Other project");
    const owner = actorFromFederatedSubject(ISSUER, "selected-owner", ["projects.read"]);
    const viewer = actorFromFederatedSubject(ISSUER, "selected-viewer", ["projects.read"]);
    const unregistered = actorFromFederatedSubject(ISSUER, "selected-unregistered", ["projects.read"]);
    bootstrapWebGptProjectOwner(db, owner.principal_id, assigned.project_id, "SELECTED_PROVIDER_OWNER", owner.issuer_hash!);
    registerWebGptPrincipal(db, viewer.principal_id, "SELECTED_PROVIDER_VIEWER");
    bindWebGptPrincipalIssuer(db, viewer.principal_id, viewer.issuer_hash!);
    grantWebGptProjectMembership(db, viewer.principal_id, assigned.project_id, "viewer", "SELECTED_PROVIDER_VIEWER");

    assert.deepEqual(authorizedWebGptProjectIds(db, owner.principal_id, owner.issuer_hash), [assigned.project_id]);
    assert.deepEqual(authorizedWebGptProjectIds(db, viewer.principal_id, viewer.issuer_hash), [assigned.project_id]);
    assert.throws(() => authorizedWebGptProjectIds(db, unregistered.principal_id, unregistered.issuer_hash),
      (error) => error instanceof WebGptV4Error && error.code === "WEBGPT_PRINCIPAL_NOT_REGISTERED");
    assert.throws(() => requireWebGptProjectReadAccess(db, viewer.principal_id, viewer.issuer_hash, other.project_id),
      (error) => error instanceof WebGptV4Error && error.code === "PROJECT_NOT_FOUND");

    revokeWebGptProjectMembership(db, viewer.principal_id, assigned.project_id, "SELECTED_PROVIDER_REVOKE");
    assert.deepEqual(authorizedWebGptProjectIds(db, viewer.principal_id, viewer.issuer_hash), []);
    assert.throws(() => requireWebGptProjectReadAccess(db, viewer.principal_id, viewer.issuer_hash, assigned.project_id),
      (error) => error instanceof WebGptV4Error && error.code === "PROJECT_NOT_FOUND");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected provider six readonly tools preserve the complete database logical manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-selected-provider-tools-"));
  const sqlitePath = join(root, "app.sqlite");
  const owner = actorFromFederatedSubject(ISSUER, "selected-tool-owner", ["projects.read"]);
  const db = openM0Database(sqlitePath);
  const fixture = makeProductionProject(db, "Six-tool project", "shot_selected_provider_001");
  const unassigned = makeProductionProject(db, "Unassigned project");
  bootstrapWebGptProjectOwner(db, owner.principal_id, fixture.project_id, "SELECTED_PROVIDER_TOOLS", owner.issuer_hash!);
  const before = logicalManifest(db);
  db.close();

  const runtime = await startWebGptV4({
    profile: "readonly",
    mcp_port: 0,
    sqlite_path: sqlitePath,
    auth_config: federatedConfig(),
    authenticate: async () => owner
  });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { Authorization: "Bearer fixture" } } });
  const client = new Client({ name: "selected-provider-readonly", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), webGptV4ToolsForProfile("readonly").map((tool) => tool.name).sort());
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
      assert.equal(result.isError, false, `${call.name}: ${JSON.stringify(result)}`);
    }
    const crossProject = await client.callTool({ name: "get_project_context", arguments: { project_id: unassigned.project_id, workspace: "overview" } });
    assert.equal(crossProject.isError, true);
    assert.equal((crossProject.structuredContent as { error: { code: string } }).error.code, "PROJECT_NOT_FOUND");
  } finally {
    await client.close();
    await runtime.close();
  }

  const verify = openM0Database(sqlitePath);
  try {
    assert.deepEqual(logicalManifest(verify), before);
  } finally {
    verify.close();
    rmSync(root, { recursive: true, force: true });
  }
});
