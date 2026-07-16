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
import { issuerHash, actorFromFederatedSubject, WebGptV4Error } from "../src/webgpt-v4/types.js";

const RESOURCE = "https://direct-canary.example.test/mcp";
const ISSUER = "https://tenant.example.auth0.com/";

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
  if (token === "y") throw new WebGptV4Error("INSUFFICIENT_SCOPE", "Required scope is missing: projects.read");
  if (token !== "x") throw new WebGptV4Error("AUTH_INVALID", "OAuth token validation failed.");
  return Promise.resolve(actorFromFederatedSubject(ISSUER, "canary-user", [DIRECT_OAUTH_CANARY_SCOPE]));
}

test("direct OAuth canary exposes only health, PRMD, and a protected MCP smoke tool", async () => {
  const runtime = await startDirectOAuthCanary({ port: 0, auth_config: authConfig(), authenticate: fixtureAuthenticator });
  const origin = new URL(runtime.mcp_url).origin;
  try {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "direct-oauth-canary",
      version: "direct-oauth-canary-v1.0.0"
    });

    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        resource: RESOURCE,
        resource_name: "AI Video Production Assistant",
        authorization_servers: [ISSUER],
        scopes_supported: [DIRECT_OAUTH_CANARY_SCOPE],
        bearer_methods_supported: ["header"],
        configured: true
      });
    }

    const anonymous = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/direct-canary\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.equal(JSON.stringify(await anonymous.json()).includes("canary-user"), false);

    const insufficient = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer y" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    assert.equal(insufficient.status, 403);
    assert.match(insufficient.headers.get("www-authenticate") ?? "", /error="insufficient_scope"/);
    assert.match(insufficient.headers.get("www-authenticate") ?? "", /scope="projects\.read"/);

    const notFound = await fetch(`${origin}/readyz`);
    assert.equal(notFound.status, 404);
  } finally {
    await runtime.close();
  }
});

test("official MCP client sees exactly one scoped read-only tool and invokes it without production data", async () => {
  const runtime = await startDirectOAuthCanary({ port: 0, auth_config: authConfig(), authenticate: fixtureAuthenticator });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), {
    requestInit: { headers: { authorization: "Bearer x" } }
  });
  const client = new Client({ name: "direct-oauth-canary-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [DIRECT_OAUTH_CANARY_TOOL]);
    const tool = listed.tools[0];
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.deepEqual((tool._meta as { securitySchemes?: unknown }).securitySchemes, [{ type: "oauth2", scopes: [DIRECT_OAUTH_CANARY_SCOPE] }]);

    const rawResponse = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer x" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })
    });
    assert.equal(rawResponse.status, 200);
    const rawText = await rawResponse.text();
    const rawPayload = rawText.startsWith("event:")
      ? rawText.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "{}"
      : rawText;
    const rawTool = (JSON.parse(rawPayload) as { result: { tools: Array<{ securitySchemes?: unknown }> } }).result.tools[0];
    assert.deepEqual(rawTool.securitySchemes, [{ type: "oauth2", scopes: [DIRECT_OAUTH_CANARY_SCOPE] }]);

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
    const serialized = JSON.stringify(called);
    for (const forbidden of ["project_id", "artifact", "provider_payload", "sqlite", "snapshot_fingerprint"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await client.close();
    await runtime.close();
  }
});

test("direct OAuth canary source has no database, Snapshot, media, Provider, or Workbench runtime dependency", () => {
  const source = readFileSync(resolve(process.cwd(), "src/webgpt-canary/directOAuthCanary.ts"), "utf8");
  for (const forbiddenImport of ["../storage/", "../webgpt-cloud/", "../providers/", "../webgpt-v4/media", "../apps/workbench/"]) {
    assert.equal(source.includes(forbiddenImport), false, forbiddenImport);
  }
  assert.equal(source.includes("openM0Database"), false);
  assert.equal(source.includes("createWebGptV4McpApp"), false);
});

test("direct OAuth canary independently rejects an injected actor without projects.read", async () => {
  const runtime = await startDirectOAuthCanary({
    port: 0,
    auth_config: authConfig(),
    authenticate: async () => actorFromFederatedSubject(ISSUER, "scope-less-canary-user", [])
  });
  try {
    const response = await fetch(runtime.mcp_url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer x" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })
    });
    assert.equal(response.status, 403);
    assert.match(response.headers.get("www-authenticate") ?? "", /scope="projects\.read"/);
  } finally {
    await runtime.close();
  }
});

test("direct OAuth canary wires the real JWT verifier for signature, issuer, audience, and projects.read", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "direct-canary", alg: "RS256", use: "sig" });
  const token = await new SignJWT({ scope: DIRECT_OAUTH_CANARY_SCOPE })
    .setProtectedHeader({ alg: "RS256", kid: "direct-canary" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject("jwt-canary-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const wrongAudience = await new SignJWT({ scope: DIRECT_OAUTH_CANARY_SCOPE })
    .setProtectedHeader({ alg: "RS256", kid: "direct-canary" })
    .setIssuer(ISSUER)
    .setAudience("https://wrong-resource.example.test/mcp")
    .setSubject("jwt-canary-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const runtime = await startDirectOAuthCanary({
    port: 0,
    auth_config: authConfig(),
    authenticator_options: { jwks: createLocalJWKSet({ keys: [jwk] }) }
  });
  const request = (bearer: string) => fetch(runtime.mcp_url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} })
  });
  try {
    const accepted = await request(token);
    assert.equal(accepted.status, 200);
    const rejected = await request(wrongAudience);
    assert.equal(rejected.status, 401);
    assert.match(rejected.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  } finally {
    await runtime.close();
  }
});
