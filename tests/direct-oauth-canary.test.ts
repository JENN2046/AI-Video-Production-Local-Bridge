import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  DIRECT_OAUTH_CANARY_SCOPE,
  DIRECT_OAUTH_CANARY_TOOL,
  startDirectOAuthCanary
} from "../src/webgpt-canary/directOAuthCanary.js";
import { actorFromFederatedSubject, issuerHash, WebGptV4Error } from "../src/webgpt-v4/types.js";

const RESOURCE = "https://direct-canary.example.test/mcp";
const ISSUER = "https://tenant.example.auth0.com/";
const CHATGPT_ORIGIN = "https://chatgpt.com";

function authConfig() {
  return {
    provider: "federated" as const,
    access_model: "project_membership" as const,
    issuer: ISSUER,
    issuer_hash: issuerHash(ISSUER),
    audience: RESOURCE,
    resource_url: RESOURCE,
    jwks_uri: `${ISSUER}.well-known/jwks.json`,
    client_registration: "predefined" as const,
    configuration_source: "generic" as const
  };
}

function fixtureAuthenticator(request: import("node:http").IncomingMessage) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) throw new WebGptV4Error("AUTH_REQUIRED", "A valid OAuth bearer token is required.");
  if (token === "fake_scope_less") throw new WebGptV4Error("INSUFFICIENT_SCOPE", "Required scope is missing: projects.read");
  if (token !== "valid") throw new WebGptV4Error("AUTH_INVALID", "OAuth token validation failed.");
  return Promise.resolve(actorFromFederatedSubject(ISSUER, "canary-user", [DIRECT_OAUTH_CANARY_SCOPE]));
}

test("direct OAuth canary defaults to loopback, validates Origin, and reports no standalone SSE stream", async () => {
  const runtime = await startDirectOAuthCanary({
    port: 0,
    allowed_origins: [CHATGPT_ORIGIN],
    auth_config: authConfig(),
    authenticate: fixtureAuthenticator
  });
  const origin = new URL(runtime.mcp_url).origin;
  try {
    assert.equal(runtime.host, "127.0.0.1");

    const rejectedOrigin = await fetch(`${origin}/healthz`, { headers: { origin: "https://untrusted.example.test" } });
    assert.equal(rejectedOrigin.status, 403);
    assert.equal((await rejectedOrigin.json() as { error: { code: string } }).error.code, "DIRECT_OAUTH_CANARY_ORIGIN_FORBIDDEN");

    const health = await fetch(`${origin}/healthz`, { headers: { origin: CHATGPT_ORIGIN } });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "direct-oauth-canary", version: "direct-oauth-canary-v2.0.0" });

    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, { headers: { origin: CHATGPT_ORIGIN } });
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), {
      resource: RESOURCE,
      resource_name: "AI Video Production Assistant",
      authorization_servers: [ISSUER],
      scopes_supported: [DIRECT_OAUTH_CANARY_SCOPE],
      bearer_methods_supported: ["header"],
      configured: true
    });

    const standaloneSse = await fetch(runtime.mcp_url, {
      headers: { origin: CHATGPT_ORIGIN, accept: "text/event-stream" }
    });
    assert.equal(standaloneSse.status, 405);
    assert.equal(standaloneSse.headers.get("allow"), "POST");

    const unknown = await fetch(`${origin}/readyz`, { headers: { origin: CHATGPT_ORIGIN } });
    assert.equal(unknown.status, 404);
  } finally {
    await runtime.close();
  }
});

test("direct OAuth canary requires an Origin allowlist for a non-loopback listener", async () => {
  await assert.rejects(
    startDirectOAuthCanary({ host: "0.0.0.0", port: 0, auth_config: authConfig(), authenticate: fixtureAuthenticator }),
    (error: unknown) => error instanceof WebGptV4Error && error.code === "DIRECT_OAUTH_CANARY_ORIGINS_REQUIRED"
  );
});

test("direct OAuth canary exposes one scoped read-only tool without production data", async () => {
  const runtime = await startDirectOAuthCanary({ port: 0, auth_config: authConfig(), authenticate: fixtureAuthenticator });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), {
    requestInit: { headers: { authorization: "Bearer valid" } }
  });
  const client = new Client({ name: "direct-oauth-canary-test", version: "2.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [DIRECT_OAUTH_CANARY_TOOL]);
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools[0]?.annotations?.destructiveHint, false);
    assert.deepEqual((listed.tools[0]?._meta as { securitySchemes?: unknown }).securitySchemes, [{ type: "oauth2", scopes: [DIRECT_OAUTH_CANARY_SCOPE] }]);

    const called = await client.callTool({ name: DIRECT_OAUTH_CANARY_TOOL, arguments: {} });
    assert.notEqual(called.isError, true);
    assert.deepEqual(called.structuredContent, {
      mode: "direct_public_https",
      oauth_authenticated: true,
      required_scope: "projects.read",
      database_connected: false,
      snapshot_connected: false,
      workbench_ui_enabled: false,
      media_enabled: false,
      provider_calls_allowed: false
    });

    const scopeLess = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer fake_scope_less" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
    });
    assert.equal(scopeLess.status, 403);
    assert.match(scopeLess.headers.get("www-authenticate") ?? "", /scope="projects\.read"/);
  } finally {
    await client.close();
    await runtime.close();
  }
});

test("direct OAuth canary uses the real JWT verifier for signature, issuer, audience, and projects.read", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "direct-canary", alg: "RS256", use: "sig" });
  const sign = (audience: string) => new SignJWT({ scope: DIRECT_OAUTH_CANARY_SCOPE })
    .setProtectedHeader({ alg: "RS256", kid: "direct-canary" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject("jwt-canary-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const runtime = await startDirectOAuthCanary({
    port: 0,
    auth_config: authConfig(),
    authenticator_options: { jwks: createLocalJWKSet({ keys: [jwk] }) }
  });
  const request = (token: string) => fetch(runtime.mcp_url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })
  });
  try {
    assert.equal((await request(await sign(RESOURCE))).status, 200);
    assert.equal((await request(await sign("https://wrong-resource.example.test/mcp"))).status, 401);
  } finally {
    await runtime.close();
  }
});

test("direct OAuth canary keeps database, Snapshot, media, Provider, and Workbench runtime modules out of its source graph", () => {
  const source = readFileSync(resolve(process.cwd(), "src/webgpt-canary/directOAuthCanary.ts"), "utf8");
  for (const forbiddenImport of ["../storage/", "../webgpt-cloud/", "../providers/", "../webgpt-v4/media", "../apps/workbench/"]) {
    assert.equal(source.includes(forbiddenImport), false, forbiddenImport);
  }
  assert.equal(source.includes("openM0Database"), false);
  assert.equal(source.includes("createWebGptV4McpApp"), false);
});
