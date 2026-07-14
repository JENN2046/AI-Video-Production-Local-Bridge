import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { createAuth0Authenticator, createAuth0MediaAuthenticator, loadWebGptV4AuthConfig, wwwAuthenticate, type WebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";
import { sha256, WebGptV4Error } from "../src/webgpt-v4/types.js";

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
  const config: WebGptV4AuthConfig = {
    issuer,
    audience: "https://webgpt-v4.example.test",
    resource_url: "https://mcp.example.test",
    jwks_uri: `http://127.0.0.1:${address.port}/jwks.json`,
    allowed_subject_hash: sha256(subject)
  };
  const sign = (sub: string, tokenIssuer = issuer, expires = "5m") => new SignJWT({ scope: "projects.read media.read" })
    .setProtectedHeader({ alg: "RS256", kid: "webgpt-v4-test" })
    .setIssuer(tokenIssuer)
    .setAudience(config.audience)
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
    const expiredToken = await sign(subject, issuer, "0s");
    await assert.rejects(() => authenticate(request(otherSubjectToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_SUBJECT_DENIED");
    await assert.rejects(() => authenticate(request(wrongIssuerToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
    await assert.rejects(() => authenticate(request(expiredToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
  } finally {
    await new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("OAuth environment configuration fails closed for incomplete or non-HTTPS endpoints", () => {
  const base = {
    WEBGPT_V4_AUTH0_ISSUER: "https://tenant.example.test/",
    WEBGPT_V4_AUTH0_AUDIENCE: "https://api.example.test",
    WEBGPT_V4_RESOURCE_URL: "https://mcp.example.test",
    WEBGPT_V4_ALLOWED_SUBJECT_SHA256: "a".repeat(64)
  } as NodeJS.ProcessEnv;
  assert.equal(loadWebGptV4AuthConfig(base)?.issuer, "https://tenant.example.test/");
  assert.equal(loadWebGptV4AuthConfig({ ...base, WEBGPT_V4_AUTH0_ISSUER: "http://tenant.example.test" }), null);
  assert.equal(loadWebGptV4AuthConfig({ ...base, WEBGPT_V4_ALLOWED_SUBJECT_SHA256: "plaintext-subject" }), null);
  const challenge = wwwAuthenticate({ ...loadWebGptV4AuthConfig(base)!, resource_url: "https://mcp.example.test/mcp" });
  assert.equal(challenge.includes("https://mcp.example.test/.well-known/oauth-protected-resource/mcp"), true);
  assert.equal(challenge.includes("/mcp/.well-known"), false);
});
