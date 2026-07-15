import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  probeWebGptOAuthDiscovery,
  rfc8414AuthorizationServerMetadataUrl,
  validateAuthorizationServerMetadata,
  vendorAppendedAuthorizationServerMetadataUrl
} from "../src/webgpt-v4/oauthDiscovery.js";
import type { WebGptV4ReadonlyFederatedAuthConfig } from "../src/webgpt-v4/auth.js";
import { issuerHash } from "../src/webgpt-v4/types.js";

const identifier = "https://api.descope.com/v1/apps/agentic/project-fixture/resource-fixture";
const config: WebGptV4ReadonlyFederatedAuthConfig = {
  provider: "federated",
  access_model: "project_membership",
  issuer: "https://api.descope.com/v1/apps/project-fixture",
  issuer_hash: issuerHash("https://api.descope.com/v1/apps/project-fixture"),
  audience: "https://mcp.example.test/mcp",
  resource_url: "https://mcp.example.test/mcp",
  client_registration: "cimd",
  configuration_source: "legacy_descope",
  legacy_authorization_server_url: identifier,
  jwks_uri: "https://api.descope.com/v1/apps/project-fixture/.well-known/jwks.json"
};

function compatibleMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: identifier,
    authorization_endpoint: "https://api.descope.com/oauth2/authorize",
    token_endpoint: "https://api.descope.com/oauth2/token",
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    ...overrides
  };
}

test("RFC 8414 metadata URL inserts the well-known path before a path-based issuer", () => {
  assert.equal(
    rfc8414AuthorizationServerMetadataUrl(identifier),
    "https://api.descope.com/.well-known/oauth-authorization-server/v1/apps/agentic/project-fixture/resource-fixture"
  );
  assert.equal(
    vendorAppendedAuthorizationServerMetadataUrl(identifier),
    "https://api.descope.com/v1/apps/agentic/project-fixture/resource-fixture/.well-known/oauth-authorization-server"
  );
  assert.throws(
    () => rfc8414AuthorizationServerMetadataUrl("https://api.descope.com/resource?secret=value"),
    /OAUTH_DISCOVERY_UNSAFE_IDENTIFIER/
  );
  assert.throws(
    () => rfc8414AuthorizationServerMetadataUrl("https://oauth.example.test/resource"),
    /OAUTH_DISCOVERY_UNSAFE_IDENTIFIER/
  );
});

test("metadata validation requires exact issuer, HTTPS endpoints, PKCE S256, public-client auth, and CIMD or DCR", () => {
  assert.equal(validateAuthorizationServerMetadata(identifier, compatibleMetadata()).ok, true);
  assert.equal(validateAuthorizationServerMetadata(identifier, compatibleMetadata({
    client_id_metadata_document_supported: false,
    registration_endpoint: "https://api.descope.com/oauth2/register"
  })).ok, true);
  assert.equal(
    validateAuthorizationServerMetadata(identifier, compatibleMetadata({ issuer: config.issuer })).code,
    "OAUTH_DISCOVERY_ISSUER_MISMATCH"
  );
  assert.equal(
    validateAuthorizationServerMetadata(identifier, compatibleMetadata({ code_challenge_methods_supported: ["plain"] })).code,
    "OAUTH_DISCOVERY_PKCE_S256_MISSING"
  );
  assert.equal(
    validateAuthorizationServerMetadata(identifier, compatibleMetadata({ token_endpoint_auth_methods_supported: ["client_secret_basic"] })).code,
    "OAUTH_DISCOVERY_PUBLIC_CLIENT_UNSUPPORTED"
  );
  assert.equal(
    validateAuthorizationServerMetadata(identifier, compatibleMetadata({ client_id_metadata_document_supported: false })).code,
    "OAUTH_DISCOVERY_REGISTRATION_CAPABILITY_MISSING"
  );
});

test("probe passes only the RFC 8414 location and sends no credentials", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(compatibleMetadata()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const result = await probeWebGptOAuthDiscovery(config, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.code, "OAUTH_DISCOVERY_COMPATIBLE");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, rfc8414AuthorizationServerMetadataUrl(identifier));
  assert.equal(requests[0]?.init?.credentials, "omit");
  assert.equal(requests[0]?.init?.redirect, "manual");
  assert.deepEqual(requests[0]?.init?.headers, { accept: "application/json" });
});

test("vendor-appended capabilities remain diagnostic when the RFC 8414 location fails", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === rfc8414AuthorizationServerMetadataUrl(identifier)) return new Response(null, { status: 401 });
    if (url === vendorAppendedAuthorizationServerMetadataUrl(identifier)) {
      return new Response(JSON.stringify(compatibleMetadata({
        issuer: config.issuer,
        registration_endpoint: "https://api.descope.com/oauth2/register"
      })), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error("unexpected discovery URL");
  };
  const result = await probeWebGptOAuthDiscovery(config, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.code, "OAUTH_DISCOVERY_RFC8414_UNAVAILABLE");
  assert.deepEqual(result.diagnostics, {
    vendor_appended_metadata_status: 200,
    vendor_appended_metadata_http_200: true,
    vendor_appended_issuer_exact: false,
    vendor_appended_cimd: true,
    vendor_appended_dcr: true
  });
  assert.equal(JSON.stringify(result).includes("project-fixture"), false);
  assert.equal(JSON.stringify(result).includes("resource-fixture"), false);
});

test("probe fails closed on malformed or oversized metadata", async () => {
  const malformed = await probeWebGptOAuthDiscovery(config, async () => new Response("not-json", { status: 200 }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, "OAUTH_DISCOVERY_INVALID_JSON");

  const oversized = await probeWebGptOAuthDiscovery(config, async () => new Response("x".repeat(256 * 1024 + 1), {
    status: 200,
    headers: { "content-length": String(256 * 1024 + 1) }
  }));
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, "OAUTH_DISCOVERY_RESPONSE_TOO_LARGE");

  const unavailable = await probeWebGptOAuthDiscovery(config, async () => { throw new Error("offline"); });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "OAUTH_DISCOVERY_FETCH_FAILED");
});

test("dedicated discovery preflight fails closed without reading database state", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist", "scripts", "webgpt-oauth-discovery-preflight.js")], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WEBGPT_V4_PROFILE: "readonly"
    }
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: "OAUTH_DISCOVERY_REQUIRES_READONLY_FEDERATED"
  });
  assert.equal(result.stderr, "");
});
