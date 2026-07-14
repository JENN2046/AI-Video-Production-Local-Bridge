import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { actorFromSubject, sha256, WebGptV4Error, WEBGPT_V4_SCOPES, type WebGptV4Actor, type WebGptV4Scope } from "./types.js";

export interface WebGptV4AuthConfig {
  issuer: string;
  audience: string;
  resource_url: string;
  jwks_uri: string;
  allowed_subject_hash: string;
}

export type WebGptV4Authenticator = (request: IncomingMessage) => Promise<WebGptV4Actor>;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function secureUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function loadWebGptV4AuthConfig(env: NodeJS.ProcessEnv = process.env): WebGptV4AuthConfig | null {
  const issuer = env.WEBGPT_V4_AUTH0_ISSUER?.trim() ?? "";
  const audience = env.WEBGPT_V4_AUTH0_AUDIENCE?.trim() ?? "";
  const resourceUrl = env.WEBGPT_V4_RESOURCE_URL?.trim() ?? "";
  const allowedSubjectHash = env.WEBGPT_V4_ALLOWED_SUBJECT_SHA256?.trim().toLowerCase() ?? "";
  if (!issuer || !audience || !resourceUrl || !secureUrl(issuer) || !secureUrl(resourceUrl) || !/^[a-f0-9]{64}$/.test(allowedSubjectHash)) return null;
  const normalizedIssuer = `${trimSlash(issuer)}/`;
  const jwksUri = env.WEBGPT_V4_AUTH0_JWKS_URI?.trim() || `${normalizedIssuer}.well-known/jwks.json`;
  if (!secureUrl(jwksUri)) return null;
  return {
    issuer: normalizedIssuer,
    audience,
    resource_url: trimSlash(resourceUrl),
    jwks_uri: jwksUri,
    allowed_subject_hash: allowedSubjectHash
  };
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
    if (!subject || sha256(subject) !== config.allowed_subject_hash) throw new WebGptV4Error("AUTH_SUBJECT_DENIED", "OAuth subject is not allowed for this app.");
    const rawScopes = typeof payload.scope === "string"
      ? payload.scope.split(/\s+/)
      : Array.isArray(payload.permissions) ? payload.permissions.filter((value): value is string => typeof value === "string") : [];
    return actorFromSubject(subject, rawScopes);
  };
}

export function createAuth0Authenticator(config: WebGptV4AuthConfig): WebGptV4Authenticator {
  const authenticateToken = createTokenAuthenticator(config);
  return async (request) => authenticateToken(bearerToken(request));
}

export function createAuth0MediaAuthenticator(
  config: WebGptV4AuthConfig,
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
    authorization_servers: config ? [config.issuer] : [],
    scopes_supported: [...scopes],
    bearer_methods_supported: ["header"],
    configured: Boolean(config)
  };
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
    ? new URL("/.well-known/oauth-protected-resource/mcp", config.resource_url).toString()
    : "/.well-known/oauth-protected-resource/mcp";
  const parts = [`Bearer resource_metadata="${challengeValue(metadataUrl)}"`, `error="${challengeValue(error)}"`];
  if (options.error_description) parts.push(`error_description="${challengeValue(options.error_description)}"`);
  if (options.scope) parts.push(`scope="${challengeValue(options.scope)}"`);
  return parts.join(", ");
}
