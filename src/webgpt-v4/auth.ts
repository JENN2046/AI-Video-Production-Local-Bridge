import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { actorFromFederatedSubject, actorFromSubject, issuerHash, sha256, WebGptV4Error, WEBGPT_V4_SCOPES, type WebGptV4Actor, type WebGptV4Scope } from "./types.js";
import type { WebGptV4Profile } from "./toolCatalog.js";

interface WebGptV4AuthConfigBase {
  issuer: string;
  audience: string;
  resource_url: string;
  jwks_uri: string;
}

export type WebGptV4ClientRegistration = "predefined" | "cimd" | "dcr";

export interface WebGptV4ReadonlyFederatedAuthConfig extends WebGptV4AuthConfigBase {
  provider: "federated";
  access_model: "project_membership";
  issuer_hash: string;
  client_registration: WebGptV4ClientRegistration;
  configuration_source: "generic" | "legacy_descope";
  legacy_authorization_server_url?: string;
}

export interface WebGptV4Auth0Config extends WebGptV4AuthConfigBase {
  provider: "auth0";
  access_model: "single_subject";
  allowed_subject_hash: string;
}

export type WebGptV4AuthConfig = WebGptV4ReadonlyFederatedAuthConfig | WebGptV4Auth0Config;

export type WebGptV4Authenticator = (request: IncomingMessage) => Promise<WebGptV4Actor>;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function secureUrl(value: string, options: { allow_query?: boolean } = {}): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash
      && (options.allow_query === true || !parsed.search);
  } catch {
    return false;
  }
}

function secureIssuerIdentifier(value: string): boolean {
  return secureUrl(value);
}

const READONLY_GENERIC_KEYS = [
  "WEBGPT_V4_READONLY_OAUTH_ISSUER",
  "WEBGPT_V4_READONLY_OAUTH_AUDIENCE",
  "WEBGPT_V4_READONLY_OAUTH_JWKS_URI",
  "WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION"
] as const;

const READONLY_LEGACY_DESCOPE_KEYS = [
  "WEBGPT_V4_DESCOPE_ISSUER",
  "WEBGPT_V4_DESCOPE_AUDIENCE",
  "WEBGPT_V4_DESCOPE_JWKS_URI",
  "WEBGPT_V4_DESCOPE_AUTHORIZATION_SERVER_URL"
] as const;

function configured(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]?.trim() !== "";
}

function invalidAuthConfig(code: "INVALID_WEBGPT_AUTH_CONFIG" | "AMBIGUOUS_WEBGPT_AUTH_CONFIG", message: string): never {
  throw new WebGptV4Error(code, message, "WEBGPT_V4_READONLY_OAUTH_ISSUER");
}

export function assertWebGptV4AuthConfig(config: WebGptV4AuthConfig): void {
  if (config.provider === "federated") {
    const valid = config.access_model === "project_membership"
      && secureIssuerIdentifier(config.issuer)
      && secureUrl(config.audience)
      && secureUrl(config.resource_url)
      && secureUrl(config.jwks_uri)
      && config.audience === config.resource_url
      && config.issuer_hash === issuerHash(config.issuer)
      && (["predefined", "cimd", "dcr"] as const).includes(config.client_registration)
      && (config.configuration_source === "generic"
        ? config.legacy_authorization_server_url === undefined
        : config.client_registration === "cimd" && secureIssuerIdentifier(config.legacy_authorization_server_url ?? ""));
    if (!valid) invalidAuthConfig("INVALID_WEBGPT_AUTH_CONFIG", "Readonly Federated OAuth configuration is incomplete or invalid.");
    return;
  }
  if (config.access_model !== "single_subject" || !/^[a-f0-9]{64}$/.test(config.allowed_subject_hash)) {
    throw new WebGptV4Error("INVALID_WEBGPT_AUTH_CONFIG", "Full Auth0 OAuth configuration is incomplete or invalid.");
  }
}

function readonlyBase(input: {
  issuer?: string;
  audience?: string;
  jwks_uri?: string;
  resource_url?: string;
}): WebGptV4AuthConfigBase | null {
  const issuer = input.issuer?.trim() ?? "";
  const audience = input.audience?.trim() ?? "";
  const jwksUri = input.jwks_uri?.trim() ?? "";
  const resourceUrl = input.resource_url?.trim() ?? "";
  if (!issuer || !audience || !jwksUri || !resourceUrl) return null;
  if (![issuer, audience, jwksUri, resourceUrl].every((value) => secureUrl(value))) return null;
  if (audience !== resourceUrl) return null;
  return { issuer, audience, resource_url: resourceUrl, jwks_uri: jwksUri };
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
  if (!issuer || !audience || !resourceUrl || !secureIssuerIdentifier(issuer) || !secureUrl(resourceUrl, { allow_query: true })) return null;
  const normalizedIssuer = options.issuer_trailing_slash === false ? trimSlash(issuer) : `${trimSlash(issuer)}/`;
  const explicitJwksUri = jwksValue?.trim() ?? "";
  if (options.require_explicit_jwks && !explicitJwksUri) return null;
  const jwksUri = explicitJwksUri || new URL(".well-known/jwks.json", normalizedIssuer).toString();
  if (!secureUrl(jwksUri, { allow_query: true })) return null;
  return { issuer: normalizedIssuer, audience, resource_url: trimSlash(resourceUrl), jwks_uri: jwksUri };
}

export function loadWebGptV4AuthConfig(
  profile: WebGptV4Profile = "readonly",
  env: NodeJS.ProcessEnv = process.env
): WebGptV4AuthConfig | null {
  if (profile === "readonly") {
    const hasGeneric = READONLY_GENERIC_KEYS.some((key) => configured(env, key));
    const hasLegacy = READONLY_LEGACY_DESCOPE_KEYS.some((key) => configured(env, key));
    if (hasGeneric && hasLegacy) {
      invalidAuthConfig("AMBIGUOUS_WEBGPT_AUTH_CONFIG", "Generic and legacy Readonly OAuth configuration cannot be combined.");
    }
    if (!hasGeneric && !hasLegacy) return null;
    if (hasGeneric) {
      const base = readonlyBase({
        issuer: env.WEBGPT_V4_READONLY_OAUTH_ISSUER,
        audience: env.WEBGPT_V4_READONLY_OAUTH_AUDIENCE,
        jwks_uri: env.WEBGPT_V4_READONLY_OAUTH_JWKS_URI,
        resource_url: env.WEBGPT_V4_RESOURCE_URL
      });
      const registration = env.WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION?.trim() as WebGptV4ClientRegistration | undefined;
      if (!base || !registration || !(["predefined", "cimd", "dcr"] as const).includes(registration)) {
        invalidAuthConfig("INVALID_WEBGPT_AUTH_CONFIG", "Readonly Federated OAuth configuration is incomplete or invalid.");
      }
      return {
        provider: "federated", access_model: "project_membership", ...base,
        issuer_hash: issuerHash(base.issuer), client_registration: registration, configuration_source: "generic"
      };
    }
    const base = readonlyBase({
      issuer: env.WEBGPT_V4_DESCOPE_ISSUER,
      audience: env.WEBGPT_V4_DESCOPE_AUDIENCE,
      jwks_uri: env.WEBGPT_V4_DESCOPE_JWKS_URI,
      resource_url: env.WEBGPT_V4_RESOURCE_URL
    });
    const authorizationServerUrl = env.WEBGPT_V4_DESCOPE_AUTHORIZATION_SERVER_URL?.trim() ?? "";
    if (!base || !secureIssuerIdentifier(authorizationServerUrl)) {
      invalidAuthConfig("INVALID_WEBGPT_AUTH_CONFIG", "Legacy Descope Readonly OAuth configuration is incomplete or invalid.");
    }
    return {
      provider: "federated", access_model: "project_membership", ...base,
      issuer_hash: issuerHash(base.issuer), client_registration: "cimd", configuration_source: "legacy_descope",
      legacy_authorization_server_url: authorizationServerUrl
    };
  }
  const base = authBase(
    env.WEBGPT_V4_AUTH0_ISSUER,
    env.WEBGPT_V4_AUTH0_AUDIENCE,
    env.WEBGPT_V4_AUTH0_JWKS_URI,
    env
  );
  const allowedSubjectHash = env.WEBGPT_V4_ALLOWED_SUBJECT_SHA256?.trim().toLowerCase() ?? "";
  return base && /^[a-f0-9]{64}$/.test(allowedSubjectHash)
    ? { provider: "auth0", access_model: "single_subject", ...base, allowed_subject_hash: allowedSubjectHash }
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

function createTokenAuthenticator(config: WebGptV4AuthConfig, jwksOverride?: JWTVerifyGetKey): (token: string) => Promise<WebGptV4Actor> {
  const jwks = jwksOverride ?? createRemoteJWKSet(new URL(config.jwks_uri));
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
    if (config.provider === "federated") {
      const scopePresent = payload.scope !== undefined;
      const scpPresent = payload.scp !== undefined;
      if (scopePresent && typeof payload.scope !== "string") throw new WebGptV4Error("AUTH_INVALID", "OAuth scope claim is malformed.");
      if (scpPresent && typeof payload.scp !== "string" && !(Array.isArray(payload.scp) && payload.scp.every((value) => typeof value === "string"))) {
        throw new WebGptV4Error("AUTH_INVALID", "OAuth scp claim is malformed.");
      }
      const scopeSet = new Set(typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : []);
      const scpValues = typeof payload.scp === "string" ? payload.scp.split(/\s+/).filter(Boolean) : Array.isArray(payload.scp) ? payload.scp : [];
      const scpSet = new Set(scpValues);
      if (scopePresent && scpPresent && (scopeSet.size !== scpSet.size || [...scopeSet].some((scope) => !scpSet.has(scope)))) {
        throw new WebGptV4Error("AUTH_SCOPE_CLAIM_CONFLICT", "OAuth scope and scp claims disagree.");
      }
      const scopes = scopePresent ? scopeSet : scpSet;
      if (!scopes.has("projects.read")) throw new WebGptV4Error("INSUFFICIENT_SCOPE", "Required scope is missing: projects.read");
      return actorFromFederatedSubject(config.issuer, subject, scopes);
    }
    const scopeClaim = payload.scope ?? payload.scopes;
    const rawScopes = typeof scopeClaim === "string"
      ? scopeClaim.split(/\s+/)
      : Array.isArray(scopeClaim)
        ? scopeClaim.filter((value): value is string => typeof value === "string")
        : Array.isArray(payload.permissions)
          ? payload.permissions.filter((value): value is string => typeof value === "string")
          : [];
    return actorFromSubject(subject, rawScopes);
  };
}

export function createOAuthAuthenticator(config: WebGptV4AuthConfig, options: { jwks?: JWTVerifyGetKey } = {}): WebGptV4Authenticator {
  assertWebGptV4AuthConfig(config);
  const authenticateToken = createTokenAuthenticator(config, options.jwks);
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
      ? [config.provider === "federated" && config.configuration_source === "legacy_descope"
          ? config.legacy_authorization_server_url ?? config.issuer
          : config.issuer]
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
