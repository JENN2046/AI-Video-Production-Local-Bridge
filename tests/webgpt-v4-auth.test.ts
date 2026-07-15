import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { createAuth0Authenticator, createAuth0MediaAuthenticator, createOAuthAuthenticator, loadWebGptV4AuthConfig, protectedResourceMetadata, protectedResourceMetadataUrl, wwwAuthenticate, type WebGptV4Auth0Config } from "../src/webgpt-v4/auth.js";
import { issuerHash, principalIdFromFederatedSubject, sha256, WebGptV4Error } from "../src/webgpt-v4/types.js";

test("Auth0 verifier enforces JWKS signature, issuer, audience, expiry, subject allowlist, and scopes", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "webgpt-v4-test", alg: "RS256", use: "sig" });
  const jwksServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const address = jwksServer.address();
  if (!address || typeof address === "string") throw new Error("JWKS fixture did not start.");
  const issuer = "https://auth.example.test/";
  const subject = "auth0|jenn-fixture";
  const config: WebGptV4Auth0Config = {
    provider: "auth0",
    access_model: "single_subject",
    issuer,
    audience: "https://webgpt-v4.example.test",
    resource_url: "https://mcp.example.test",
    jwks_uri: `http://127.0.0.1:${address.port}/jwks.json`,
    allowed_subject_hash: sha256(subject)
  };
  const sign = (sub: string, tokenIssuer = issuer, expires = "5m", tokenAudience = config.audience) => new SignJWT({ scope: "projects.read media.read" })
    .setProtectedHeader({ alg: "RS256", kid: "webgpt-v4-test" })
    .setIssuer(tokenIssuer)
    .setAudience(tokenAudience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(privateKey);
  const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;
  try {
    const authenticate = createAuth0Authenticator(config);
    const token = await sign(subject);
    const actor = await authenticate(request(token));
    assert.equal(actor.actor_hash, sha256(subject));
    assert.equal(actor.scopes.has("projects.read"), true);
    assert.equal(actor.scopes.has("shots.write"), false);
    const authenticateMedia = createAuth0MediaAuthenticator(config, "fixture_media_session");
    const cookieActor = await authenticateMedia({ headers: { cookie: `fixture_media_session=${encodeURIComponent(token)}` } } as IncomingMessage);
    assert.equal(cookieActor.actor_hash, actor.actor_hash);
    await assert.rejects(() => authenticateMedia({ headers: { cookie: "fixture_media_session=%ZZ" } } as IncomingMessage), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
    const otherSubjectToken = await sign("auth0|other-user");
    const wrongIssuerToken = await sign(subject, "https://wrong-issuer.example/");
    const wrongAudienceToken = await sign(subject, issuer, "5m", "https://wrong-audience.example");
    const expiredToken = await sign(subject, issuer, "0s");
    await assert.rejects(() => authenticate(request(otherSubjectToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_SUBJECT_DENIED");
    await assert.rejects(() => authenticate(request(wrongIssuerToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
    await assert.rejects(() => authenticate(request(wrongAudienceToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
    await assert.rejects(() => authenticate(request(expiredToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
  } finally {
    await new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("OAuth environment configuration selects one strict Readonly source and fails closed on ambiguity", () => {
  const auth0 = {
    WEBGPT_V4_AUTH0_ISSUER: "https://tenant.example.test/",
    WEBGPT_V4_AUTH0_AUDIENCE: "https://api.example.test",
    WEBGPT_V4_RESOURCE_URL: "https://mcp.example.test",
    WEBGPT_V4_ALLOWED_SUBJECT_SHA256: "a".repeat(64)
  } as NodeJS.ProcessEnv;
  const descope = {
    WEBGPT_V4_DESCOPE_ISSUER: "https://api.descope.com/project-fixture",
    WEBGPT_V4_DESCOPE_AUDIENCE: "https://mcp.example.test/mcp",
    WEBGPT_V4_DESCOPE_JWKS_URI: "https://api.descope.com/project-fixture/.well-known/jwks.json",
    WEBGPT_V4_DESCOPE_AUTHORIZATION_SERVER_URL: "https://api.descope.com/v1/apps/agentic/project-fixture/resource-fixture",
    WEBGPT_V4_RESOURCE_URL: "https://mcp.example.test/mcp"
  } as NodeJS.ProcessEnv;
  const generic = {
    WEBGPT_V4_READONLY_OAUTH_ISSUER: "https://tenant.example.test/oauth",
    WEBGPT_V4_READONLY_OAUTH_AUDIENCE: "https://mcp.example.test/mcp",
    WEBGPT_V4_READONLY_OAUTH_JWKS_URI: "https://keys.example.test/jwks.json",
    WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION: "predefined",
    WEBGPT_V4_RESOURCE_URL: "https://mcp.example.test/mcp"
  } as NodeJS.ProcessEnv;
  const emptyReadonlyPlaceholders = {
    WEBGPT_V4_READONLY_OAUTH_ISSUER: "",
    WEBGPT_V4_READONLY_OAUTH_AUDIENCE: "",
    WEBGPT_V4_READONLY_OAUTH_JWKS_URI: "",
    WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION: "",
    WEBGPT_V4_DESCOPE_ISSUER: "",
    WEBGPT_V4_DESCOPE_AUDIENCE: "",
    WEBGPT_V4_DESCOPE_JWKS_URI: "",
    WEBGPT_V4_DESCOPE_AUTHORIZATION_SERVER_URL: "",
    WEBGPT_V4_RESOURCE_URL: ""
  } as NodeJS.ProcessEnv;
  assert.equal(loadWebGptV4AuthConfig("readonly", emptyReadonlyPlaceholders), null);
  assert.equal(loadWebGptV4AuthConfig("full", auth0)?.issuer, "https://tenant.example.test/");
  const genericConfig = loadWebGptV4AuthConfig("readonly", generic);
  assert.equal(genericConfig?.provider, "federated");
  assert.equal(genericConfig?.issuer, "https://tenant.example.test/oauth");
  assert.equal(genericConfig?.provider === "federated" ? genericConfig.client_registration : undefined, "predefined");
  assert.equal(genericConfig?.provider === "federated" ? genericConfig.issuer_hash : undefined, issuerHash("https://tenant.example.test/oauth"));
  const descopeConfig = loadWebGptV4AuthConfig("readonly", descope);
  assert.equal(descopeConfig?.provider, "federated");
  assert.equal(descopeConfig?.issuer, "https://api.descope.com/project-fixture");
  assert.equal(descopeConfig?.provider === "federated" ? descopeConfig.legacy_authorization_server_url : undefined, "https://api.descope.com/v1/apps/agentic/project-fixture/resource-fixture");
  assert.equal(loadWebGptV4AuthConfig("readonly", { ...emptyReadonlyPlaceholders, ...descope })?.provider, "federated");
  assert.equal(loadWebGptV4AuthConfig("readonly", auth0), null, "readonly must not fall back to Auth0");
  assert.equal(loadWebGptV4AuthConfig("full", descope), null, "full must not use Descope");
  assert.equal(loadWebGptV4AuthConfig("full", { ...auth0, WEBGPT_V4_AUTH0_ISSUER: "http://tenant.example.test" }), null);
  assert.equal(loadWebGptV4AuthConfig("full", { ...auth0, WEBGPT_V4_ALLOWED_SUBJECT_SHA256: "plaintext-subject" }), null);
  for (const invalid of [
    { ...generic, WEBGPT_V4_READONLY_OAUTH_JWKS_URI: "http://keys.example.test/jwks" },
    { ...generic, WEBGPT_V4_READONLY_OAUTH_JWKS_URI: "" },
    { ...generic, WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION: "implicit" },
    { ...generic, WEBGPT_V4_READONLY_OAUTH_ISSUER: "https://tenant.example.test/oauth?tenant=other" },
    {
      ...generic,
      WEBGPT_V4_READONLY_OAUTH_AUDIENCE: "https://mcp.example.test/mcp?region=us",
      WEBGPT_V4_RESOURCE_URL: "https://mcp.example.test/mcp?region=us"
    },
    { ...generic, WEBGPT_V4_RESOURCE_URL: "https://mcp.example.test/mcp#fragment" },
    { ...generic, WEBGPT_V4_READONLY_OAUTH_AUDIENCE: "https://other-resource.example/mcp" }
  ]) assert.throws(() => loadWebGptV4AuthConfig("readonly", invalid), (error) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_AUTH_CONFIG");
  assert.throws(() => loadWebGptV4AuthConfig("readonly", { ...generic, ...descope }), (error) => error instanceof WebGptV4Error && error.code === "AMBIGUOUS_WEBGPT_AUTH_CONFIG");
  assert.throws(() => loadWebGptV4AuthConfig("readonly", { ...descope, WEBGPT_V4_DESCOPE_JWKS_URI: "" }), (error) => error instanceof WebGptV4Error && error.code === "INVALID_WEBGPT_AUTH_CONFIG");
  const descopeMetadata = protectedResourceMetadata(descopeConfig);
  assert.deepEqual(descopeMetadata.authorization_servers, ["https://api.descope.com/v1/apps/agentic/project-fixture/resource-fixture"]);
  const challenge = wwwAuthenticate({ ...loadWebGptV4AuthConfig("full", auth0)!, resource_url: "https://mcp.example.test/mcp" });
  assert.equal(challenge.includes("https://mcp.example.test/.well-known/oauth-protected-resource/mcp"), true);
  assert.equal(challenge.includes("/mcp/.well-known"), false);
  assert.equal(
    protectedResourceMetadataUrl("https://mcp.example.test/tenant/mcp?region=us"),
    "https://mcp.example.test/.well-known/oauth-protected-resource/tenant/mcp?region=us"
  );
  const prefixedChallenge = wwwAuthenticate({ ...loadWebGptV4AuthConfig("full", auth0)!, resource_url: "https://mcp.example.test/tenant/mcp?region=us" });
  assert.equal(prefixedChallenge.includes("https://mcp.example.test/.well-known/oauth-protected-resource/tenant/mcp?region=us"), true);
});

test("Federated verifier accepts multiple subjects, enforces standard scope claims, and derives issuer-bound opaque principals", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "descope-fixture", alg: "RS256", use: "sig" });
  const jwksServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const address = jwksServer.address();
  if (!address || typeof address === "string") throw new Error("JWKS fixture did not start.");
  const issuer = "https://api.descope.com/project-fixture";
  const audience = "https://mcp.example.test/mcp";
  const config = {
    provider: "federated" as const,
    access_model: "project_membership" as const,
    issuer,
    issuer_hash: issuerHash(issuer),
    audience,
    resource_url: audience,
    client_registration: "predefined" as const,
    configuration_source: "generic" as const,
    jwks_uri: "https://keys.example.test/jwks.json"
  };
  const sign = (subject: string, claims: Record<string, unknown> = { scope: "projects.read" }) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "descope-fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;
  try {
    const authenticate = createOAuthAuthenticator(config, { jwks: createLocalJWKSet({ keys: [jwk] }) });
    const first = await authenticate(request(await sign("descope-user-a")));
    const second = await authenticate(request(await sign("descope-user-b", { scp: ["projects.read"] })));
    assert.equal(first.principal_id, principalIdFromFederatedSubject(issuer, "descope-user-a"));
    assert.equal(first.actor_hash, first.principal_id);
    assert.equal(JSON.stringify(first).includes("descope-user-a"), false);
    assert.notEqual(first.principal_id, second.principal_id);
    assert.equal(first.scopes.has("projects.read"), true);
    assert.equal(second.scopes.has("projects.read"), true);
    assert.notEqual(
      principalIdFromFederatedSubject("https://issuer-a.example", "shared-subject"),
      principalIdFromFederatedSubject("https://issuer-b.example", "shared-subject")
    );
    assert.equal(first.issuer_hash, issuerHash(issuer));
    const conflictingScopeToken = await sign("descope-user-a", { scope: "projects.read", scp: ["projects.read", "media.read"] });
    await assert.rejects(
      () => authenticate(request(conflictingScopeToken)),
      (error) => error instanceof WebGptV4Error && error.code === "AUTH_SCOPE_CLAIM_CONFLICT"
    );
    const permissionsOnlyToken = await sign("descope-user-a", { permissions: ["projects.read"] });
    await assert.rejects(
      () => authenticate(request(permissionsOnlyToken)),
      (error) => error instanceof WebGptV4Error && error.code === "INSUFFICIENT_SCOPE"
    );
    const legacyScopesOnlyToken = await sign("descope-user-a", { scopes: ["projects.read"] });
    await assert.rejects(
      () => authenticate(request(legacyScopesOnlyToken)),
      (error) => error instanceof WebGptV4Error && error.code === "INSUFFICIENT_SCOPE"
    );
    const missingSubjectToken = await sign("", { scope: "projects.read" });
    await assert.rejects(
      () => authenticate(request(missingSubjectToken)),
      (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID"
    );
  } finally {
    await new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
  }
});
