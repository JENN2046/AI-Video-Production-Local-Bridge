import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { actorFromFederatedSubject, actorFromSubject, sha256, WebGptV4Error, WEBGPT_V4_SCOPES, type WebGptV4Actor, type WebGptV4Scope } from "./types.js";
import type { WebGptV4Profile } from "./toolCatalog.js";

interface WebGptV4AuthConfigBase {
  issuer: string;
  audience: string;
  resource_url: string;
  jwks_uri: string;
}

export interface WebGptV4DescopeAuthConfig extends WebGptV4AuthConfigBase {
  provider: "descope";
  authorization_server_url: string;
}

export interface WebGptV4Auth0Config extends WebGptV4AuthConfigBase {
  provider: "auth0";
  allowed_subject_hash: string;
}

export type WebGptV4AuthConfig = WebGptV4DescopeAuthConfig | WebGptV4Auth0Config;

export type WebGptV4Authenticator = (request: IncomingMessage) => Promise<WebGptV4Actor>;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function secureUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

function authBase(
  issuerValue: string | undefined,
  audienceValue: string | undefined,
  jwksValue: string | undefined,
  env: NodeJS.ProcessEnv,
  options: { require_explicit_jwks?: boolean; issuer_trailing_slash?: boolean } = {}
): WebGptV4AuthConfigBase | null {
  const issuer = issuerValue?.trim() ?? "";
  const audience = audienceValue?.trim() ?? "";
  const resourceUrl = env.WEBGPT_V4_RESOURCE_URL?.trim() ?? "";
  if (!issuer || !audience || !resourceUrl || !secureUrl(issuer) || !secureUrl(resourceUrl)) return null;
  const normalizedIssuer = options.issuer_trailing_slash === false ? trimSlash(issuer) : `${trimSlash(issuer)}/`;
  const explicitJwksUri = jwksValue?.trim() ?? "";
  if (options.require_explicit_jwks && !explicitJwksUri) return null;
  const jwksUri = explicitJwksUri || new URL(".well-known/jwks.json", normalizedIssuer).toString();
  if (!secureUrl(jwksUri)) return null;
  return { issuer: normalizedIssuer, audience, resource_url: trimSlash(resourceUrl), jwks_uri: jwksUri };
}

export function loadWebGptV4AuthConfig(
  profile: WebGptV4Profile = "readonly",
  env: NodeJS.ProcessEnv = process.env
): WebGptV4AuthConfig | null {
  if (profile === "readonly") {
    const base = authBase(
      env.WEBGPT_V4_DESCOPE_ISSUER,
      env.WEBGPT_V4_DESCOPE_AUDIENCE,
      env.WEBGPT_V4_DESCOPE_JWKS_URI,
      env,
      { require_explicit_jwks: true, issuer_trailing_slash: false }
    );
    const authorizationServerUrl = env.WEBGPT_V4_DESCOPE_AUTHORIZATION_SERVER_URL?.trim() ?? "";
    return base && base.audience === base.resource_url && secureUrl(authorizationServerUrl)
      ? { provider: "descope", ...base, authorization_server_url: trimSlash(authorizationServerUrl) }
      : null;
  }
  const base = authBase(
    env.WEBGPT_V4_AUTH0_ISSUER,
    env.WEBGPT_V4_AUTH0_AUDIENCE,
    env.WEBGPT_V4_AUTH0_JWKS_URI,
    env
  );
  const allowedSubjectHash = env.WEBGPT_V4_ALLOWED_SUBJECT_SHA256?.trim().toLowerCase() ?? "";
  return base && /^[a-f0-9]{64}$/.test(allowedSubjectHash)
    ? { provider: "auth0", ...base, allowed_subject_hash: allowedSubjectHash }
    : null;
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) throw new WebGptV4Error("AUTH_REQUIRED", "A valid OAuth bearer token is required.");
  return match[1];
}

function cookieValue(request: IncomingMessage, name: string): string {
  const header = request.headers.cookie ?? "";
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      throw new WebGptV4Error("AUTH_INVALID", "Media session cookie is malformed.");
    }
  }
  throw new WebGptV4Error("AUTH_REQUIRED", "A valid OAuth media session is required.");
}

function createTokenAuthenticator(config: WebGptV4AuthConfig): (token: string) => Promise<WebGptV4Actor> {
  const jwks = createRemoteJWKSet(new URL(config.jwks_uri));
  return async (token) => {
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience }));
    } catch {
      throw new WebGptV4Error("AUTH_INVALID", "OAuth token validation failed.");
    }
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    if (!subject) throw new WebGptV4Error("AUTH_INVALID", "OAuth token is missing a subject.");
    if (config.provider === "auth0" && sha256(subject) !== config.allowed_subject_hash) {
      throw new WebGptV4Error("AUTH_SUBJECT_DENIED", "OAuth subject is not allowed for this app.");
    }
    const scopeClaim = payload.scope ?? payload.scopes;
    const rawScopes = typeof scopeClaim === "string"
      ? scopeClaim.split(/\s+/)
      : Array.isArray(scopeClaim)
        ? scopeClaim.filter((value): value is string => typeof value === "string")
        : config.provider === "auth0" && Array.isArray(payload.permissions)
          ? payload.permissions.filter((value): value is string => typeof value === "string")
          : [];
    return config.provider === "descope"
      ? actorFromFederatedSubject(config.issuer, subject, rawScopes)
      : actorFromSubject(subject, rawScopes);
  };
}

export function createOAuthAuthenticator(config: WebGptV4AuthConfig): WebGptV4Authenticator {
  const authenticateToken = createTokenAuthenticator(config);
  return async (request) => authenticateToken(bearerToken(request));
}

export function createAuth0Authenticator(config: WebGptV4Auth0Config): WebGptV4Authenticator {
  return createOAuthAuthenticator(config);
}

export function createAuth0MediaAuthenticator(
  config: WebGptV4Auth0Config,
  cookieName = "__Host-webgpt_v4_media"
): WebGptV4Authenticator {
  const authenticateToken = createTokenAuthenticator(config);
  return async (request) => {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return authenticateToken(match?.[1] || cookieValue(request, cookieName));
  };
}

export function unavailableAuthenticator(): WebGptV4Authenticator {
  return async () => { throw new WebGptV4Error("AUTH_NOT_CONFIGURED", "WebGPT V4 OAuth is not configured."); };
}

export function protectedResourceMetadata(config: WebGptV4AuthConfig | null, scopes: readonly WebGptV4Scope[] = WEBGPT_V4_SCOPES): Record<string, unknown> {
  return {
    resource: config?.resource_url ?? "",
    resource_name: "AI Video Production Assistant",
    authorization_servers: config
      ? [config.provider === "descope" ? config.authorization_server_url : config.issuer]
      : [],
    scopes_supported: [...scopes],
    bearer_methods_supported: ["header"],
    configured: Boolean(config)
  };
}

export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const metadataUrl = new URL(resourceUrl);
  const resourcePath = metadataUrl.pathname === "/" ? "" : metadataUrl.pathname;
  metadataUrl.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;
  return metadataUrl.toString();
}

function challengeValue(value: string): string {
  return value.replace(/["\\\r\n]/g, " ").trim();
}

export function wwwAuthenticate(
  config: WebGptV4AuthConfig | null,
  error = "invalid_token",
  options: { scope?: string; error_description?: string } = {}
): string {
  const metadataUrl = config
    ? protectedResourceMetadataUrl(config.resource_url)
    : "/.well-known/oauth-protected-resource/mcp";
  const parts = [`Bearer resource_metadata="${challengeValue(metadataUrl)}"`, `error="${challengeValue(error)}"`];
  if (options.error_description) parts.push(`error_description="${challengeValue(options.error_description)}"`);
  if (options.scope) parts.push(`scope="${challengeValue(options.scope)}"`);
  return parts.join(", ");
}
