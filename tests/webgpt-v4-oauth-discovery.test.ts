import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import type { PinnedHttpsRuntime } from "../src/net/pinnedHttpsTransport.js";
import {
  oidcAuthorizationServerMetadataUrl,
  probeWebGptOAuthDiscovery,
  rfc8414AuthorizationServerMetadataUrl,
  validateAuthorizationServerMetadata,
  vendorAppendedAuthorizationServerMetadataUrl
} from "../src/webgpt-v4/oauthDiscovery.js";
import type { WebGptV4ReadonlyFederatedAuthConfig } from "../src/webgpt-v4/auth.js";
import { issuerHash } from "../src/webgpt-v4/types.js";

const issuer = "https://tenant.example.test/oauth";
const jwksUri = "https://keys.example.test/jwks.json";
const resource = "https://mcp.example.test/mcp";

function genericConfig(
  registration: WebGptV4ReadonlyFederatedAuthConfig["client_registration"] = "predefined"
): WebGptV4ReadonlyFederatedAuthConfig {
  return {
    provider: "federated",
    access_model: "project_membership",
    issuer,
    issuer_hash: issuerHash(issuer),
    audience: resource,
    resource_url: resource,
    client_registration: registration,
    configuration_source: "generic",
    jwks_uri: jwksUri
  };
}

const legacyIdentifier = "https://api.descope.com/v1/apps/agentic/project-fixture/resource-fixture";
const legacyConfig: WebGptV4ReadonlyFederatedAuthConfig = {
  ...genericConfig("cimd"),
  issuer: "https://api.descope.com/v1/apps/project-fixture",
  issuer_hash: issuerHash("https://api.descope.com/v1/apps/project-fixture"),
  jwks_uri: "https://api.descope.com/v1/apps/project-fixture/.well-known/jwks.json",
  configuration_source: "legacy_descope",
  legacy_authorization_server_url: legacyIdentifier
};

function compatibleMetadata(
  config: WebGptV4ReadonlyFederatedAuthConfig = genericConfig(),
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: "https://tenant.example.test/authorize",
    token_endpoint: "https://tenant.example.test/oauth/token",
    jwks_uri: config.jwks_uri,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    ...overrides
  };
}

function pinnedRuntime(
  handler: (url: URL, address: { address: string; family: 4 | 6 }, signal: AbortSignal) => Promise<Response>
): PinnedHttpsRuntime {
  return {
    resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch_pinned_address: (url, signal, address) => handler(url, address, signal)
  };
}

test("standard metadata URL builders preserve path-based issuer semantics", () => {
  assert.equal(
    rfc8414AuthorizationServerMetadataUrl(issuer),
    "https://tenant.example.test/.well-known/oauth-authorization-server/oauth"
  );
  assert.equal(
    rfc8414AuthorizationServerMetadataUrl(`${issuer}/`),
    "https://tenant.example.test/.well-known/oauth-authorization-server/oauth/"
  );
  assert.equal(
    rfc8414AuthorizationServerMetadataUrl("https://tenant.example.test:8443/oauth"),
    "https://tenant.example.test:8443/.well-known/oauth-authorization-server/oauth"
  );
  assert.equal(
    oidcAuthorizationServerMetadataUrl(issuer),
    "https://tenant.example.test/oauth/.well-known/openid-configuration"
  );
  assert.equal(
    vendorAppendedAuthorizationServerMetadataUrl(legacyIdentifier),
    `${legacyIdentifier}/.well-known/oauth-authorization-server`
  );
  for (const unsafe of [
    "http://tenant.example.test/oauth",
    "https://user:password@tenant.example.test/oauth",
    "https://tenant.example.test/oauth?tenant=other",
    "https://tenant.example.test/oauth#fragment"
  ]) assert.throws(() => rfc8414AuthorizationServerMetadataUrl(unsafe), /OAUTH_DISCOVERY_UNSAFE_IDENTIFIER/);
});

test("metadata validation enforces exact issuer, endpoints, JWKS, PKCE, public client, and selected registration mode", () => {
  const predefined = genericConfig("predefined");
  const predefinedResult = validateAuthorizationServerMetadata(predefined, compatibleMetadata(predefined));
  assert.equal(predefinedResult.ok, true);
  assert.equal(predefinedResult.checks.external_client_registration, "pending");
  assert.equal(
    validateAuthorizationServerMetadata(predefined, compatibleMetadata(predefined, { issuer: `${issuer}/` })).code,
    "OAUTH_DISCOVERY_ISSUER_MISMATCH"
  );
  assert.equal(
    validateAuthorizationServerMetadata(predefined, compatibleMetadata(predefined, { authorization_endpoint: "http://tenant.example.test/authorize" })).code,
    "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER"
  );
  assert.equal(
    validateAuthorizationServerMetadata(predefined, compatibleMetadata(predefined, { jwks_uri: "https://other.example.test/jwks" })).code,
    "OAUTH_DISCOVERY_JWKS_MISMATCH"
  );
  assert.equal(
    validateAuthorizationServerMetadata(predefined, compatibleMetadata(predefined, { code_challenge_methods_supported: ["plain"] })).code,
    "OAUTH_DISCOVERY_PKCE_S256_MISSING"
  );
  assert.equal(
    validateAuthorizationServerMetadata(predefined, compatibleMetadata(predefined, { token_endpoint_auth_methods_supported: ["client_secret_basic"] })).code,
    "OAUTH_DISCOVERY_PUBLIC_CLIENT_UNSUPPORTED"
  );
  const cimd = genericConfig("cimd");
  assert.equal(validateAuthorizationServerMetadata(cimd, compatibleMetadata(cimd)).code, "OAUTH_DISCOVERY_CIMD_MISSING");
  assert.equal(validateAuthorizationServerMetadata(cimd, compatibleMetadata(cimd, { client_id_metadata_document_supported: true })).ok, true);
  const dcr = genericConfig("dcr");
  assert.equal(validateAuthorizationServerMetadata(dcr, compatibleMetadata(dcr)).code, "OAUTH_DISCOVERY_DCR_MISSING");
  assert.equal(
    validateAuthorizationServerMetadata(dcr, compatibleMetadata(dcr, { registration_endpoint: "https://127.0.0.1/register" })).code,
    "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER"
  );
  assert.equal(validateAuthorizationServerMetadata(dcr, compatibleMetadata(dcr, { registration_endpoint: "https://tenant.example.test/register" })).ok, true);
});

test("probe uses a DNS-pinned RFC 8414 request and predefined mode does not require CIMD or DCR", async () => {
  const requests: Array<{ url: string; address: string }> = [];
  const config = genericConfig("predefined");
  const result = await probeWebGptOAuthDiscovery(config, pinnedRuntime(async (url, address) => {
    requests.push({ url: url.toString(), address: address.address });
    return new Response(JSON.stringify(compatibleMetadata(config)), { status: 200, headers: { "content-type": "application/json" } });
  }));
  assert.equal(result.ok, true);
  assert.equal(result.code, "OAUTH_DISCOVERY_COMPATIBLE");
  assert.equal(result.checks.standard_metadata_kind, "rfc8414");
  assert.equal(result.checks.external_client_registration, "pending");
  assert.deepEqual(requests, [{ url: rfc8414AuthorizationServerMetadataUrl(issuer), address: "8.8.8.8" }]);
  assert.equal(JSON.stringify(result).includes("tenant.example.test"), false);
});

test("probe falls back from unavailable RFC 8414 metadata to OIDC discovery", async () => {
  const requests: string[] = [];
  const config = genericConfig();
  const result = await probeWebGptOAuthDiscovery(config, pinnedRuntime(async (url) => {
    requests.push(url.toString());
    if (url.toString() === rfc8414AuthorizationServerMetadataUrl(issuer)) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(compatibleMetadata(config)), { status: 200 });
  }));
  assert.equal(result.ok, true);
  assert.equal(result.checks.standard_metadata_kind, "oidc");
  assert.deepEqual(requests, [rfc8414AuthorizationServerMetadataUrl(issuer), oidcAuthorizationServerMetadataUrl(issuer)]);
});

test("redirects are not followed and both unavailable standard locations fail closed", async () => {
  const requests: string[] = [];
  const result = await probeWebGptOAuthDiscovery(genericConfig(), pinnedRuntime(async (url) => {
    requests.push(url.toString());
    return url.pathname.includes("oauth-authorization-server")
      ? new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } })
      : new Response(null, { status: 404 });
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "OAUTH_DISCOVERY_STANDARD_METADATA_UNAVAILABLE");
  assert.equal(requests.length, 2);
  assert.equal(requests.some((url) => url.includes("127.0.0.1")), false);
});

test("private or mixed DNS answers fail before any injected pinned transport runs", async () => {
  let transported = false;
  const result = await probeWebGptOAuthDiscovery(genericConfig(), {
    resolve_hostname: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ],
    fetch_pinned_address: async () => {
      transported = true;
      return new Response(null, { status: 200 });
    }
  });
  assert.equal(result.code, "OAUTH_DISCOVERY_UNSAFE_NETWORK_TARGET");
  assert.equal(transported, false);
});

test("malformed, oversized, and unreachable discovery documents use stable failure codes", async () => {
  const malformed = await probeWebGptOAuthDiscovery(genericConfig(), pinnedRuntime(async () => new Response("not-json", { status: 200 })));
  assert.equal(malformed.code, "OAUTH_DISCOVERY_INVALID_JSON");

  const oversized = await probeWebGptOAuthDiscovery(genericConfig(), pinnedRuntime(async () => new Response("x".repeat(256 * 1024 + 1), {
    status: 200,
    headers: { "content-length": String(256 * 1024 + 1) }
  })));
  assert.equal(oversized.code, "OAUTH_DISCOVERY_RESPONSE_TOO_LARGE");

  const unreachable = await probeWebGptOAuthDiscovery(genericConfig(), pinnedRuntime(async () => { throw new Error("offline"); }));
  assert.equal(unreachable.code, "OAUTH_DISCOVERY_FETCH_FAILED");
});

test("legacy vendor-appended metadata remains diagnostic and can never become portability-compatible", async () => {
  const result = await probeWebGptOAuthDiscovery(legacyConfig, pinnedRuntime(async (url) => {
    if (url.toString() === vendorAppendedAuthorizationServerMetadataUrl(legacyIdentifier)) {
      return new Response(JSON.stringify({
        ...compatibleMetadata(legacyConfig),
        issuer: legacyIdentifier,
        client_id_metadata_document_supported: true,
        registration_endpoint: "https://api.descope.com/register"
      }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "OAUTH_DISCOVERY_STANDARD_METADATA_UNAVAILABLE");
  assert.deepEqual(result.diagnostics, {
    legacy_vendor_metadata_status: 200,
    legacy_vendor_metadata_http_200: true,
    legacy_vendor_issuer_exact: true,
    legacy_vendor_cimd: true,
    legacy_vendor_dcr: true
  });
  assert.equal(JSON.stringify(result).includes("project-fixture"), false);
  assert.equal(JSON.stringify(result).includes("resource-fixture"), false);
});

test("dedicated discovery preflight accepts only Readonly Federated config and does not read database state", () => {
  const missing = spawnSync(process.execPath, [join(process.cwd(), "dist", "scripts", "webgpt-oauth-discovery-preflight.js")], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WEBGPT_V4_PROFILE: "readonly" }
  });
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, code: "OAUTH_DISCOVERY_REQUIRES_READONLY_FEDERATED" });

  const unsafe = spawnSync(process.execPath, [join(process.cwd(), "dist", "scripts", "webgpt-oauth-discovery-preflight.js")], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WEBGPT_V4_PROFILE: "readonly",
      WEBGPT_V4_RESOURCE_URL: resource,
      WEBGPT_V4_READONLY_OAUTH_ISSUER: "https://127.0.0.1/oauth",
      WEBGPT_V4_READONLY_OAUTH_AUDIENCE: resource,
      WEBGPT_V4_READONLY_OAUTH_JWKS_URI: jwksUri,
      WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION: "predefined"
    }
  });
  assert.equal(unsafe.status, 1);
  assert.equal(JSON.parse(unsafe.stdout).code, "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER");

  const invalid = spawnSync(process.execPath, [join(process.cwd(), "dist", "scripts", "webgpt-oauth-discovery-preflight.js")], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WEBGPT_V4_PROFILE: "readonly",
      WEBGPT_V4_READONLY_OAUTH_ISSUER: "https://tenant.example.test/oauth"
    }
  });
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), { ok: false, code: "INVALID_WEBGPT_AUTH_CONFIG" });
  assert.equal(invalid.stderr, "");
});
