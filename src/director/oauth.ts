import {
  createOAuthAuthenticator,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticate,
  type WebGptV4Authenticator,
  type WebGptV4AuthenticatorOptions,
  type WebGptV4ClientRegistration,
  type WebGptV4ReadonlyFederatedAuthConfig
} from "../webgpt-v4/auth.js";
import { issuerHash, WebGptV4Error } from "../webgpt-v4/types.js";
import { DIRECTOR_OAUTH_SCOPES } from "./mcpContract.js";

export const DIRECTOR_OAUTH_ENV_KEYS = [
  "WEBGPT_DIRECTOR_RESOURCE_URL",
  "WEBGPT_DIRECTOR_OAUTH_ISSUER",
  "WEBGPT_DIRECTOR_OAUTH_AUDIENCE",
  "WEBGPT_DIRECTOR_OAUTH_JWKS_URI",
  "WEBGPT_DIRECTOR_OAUTH_CLIENT_REGISTRATION"
] as const;

export type DirectorOAuthConfig = WebGptV4ReadonlyFederatedAuthConfig;

function configured(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim() !== "";
}

function exactHttpsIdentifier(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function invalid(code: "INVALID_DIRECTOR_OAUTH_CONFIG" | "AMBIGUOUS_DIRECTOR_OAUTH_RESOURCE", message: string): never {
  throw new WebGptV4Error(code, message, "WEBGPT_DIRECTOR_RESOURCE_URL");
}

export function loadDirectorOAuthConfig(env: NodeJS.ProcessEnv = process.env): DirectorOAuthConfig | null {
  const present = DIRECTOR_OAUTH_ENV_KEYS.filter((key) => configured(env, key));
  if (present.length === 0) return null;
  if (present.length !== DIRECTOR_OAUTH_ENV_KEYS.length) {
    invalid("INVALID_DIRECTOR_OAUTH_CONFIG", "Director OAuth configuration must be supplied as one complete set.");
  }

  const resourceUrl = env.WEBGPT_DIRECTOR_RESOURCE_URL!.trim();
  const issuer = env.WEBGPT_DIRECTOR_OAUTH_ISSUER!.trim();
  const audience = env.WEBGPT_DIRECTOR_OAUTH_AUDIENCE!.trim();
  const jwksUri = env.WEBGPT_DIRECTOR_OAUTH_JWKS_URI!.trim();
  const clientRegistration = env.WEBGPT_DIRECTOR_OAUTH_CLIENT_REGISTRATION!.trim() as WebGptV4ClientRegistration;
  if (![resourceUrl, issuer, audience, jwksUri].every(exactHttpsIdentifier)
    || resourceUrl !== audience
    || !(clientRegistration === "predefined" || clientRegistration === "cimd" || clientRegistration === "dcr")) {
    invalid("INVALID_DIRECTOR_OAUTH_CONFIG", "Director OAuth identifiers or client-registration mode are invalid.");
  }

  const readonlyResource = env.WEBGPT_V4_RESOURCE_URL?.trim() ?? "";
  if (readonlyResource && readonlyResource === resourceUrl) {
    invalid("AMBIGUOUS_DIRECTOR_OAUTH_RESOURCE", "Director OAuth must use a resource distinct from the accepted Readonly MCP resource.");
  }

  return {
    provider: "federated",
    access_model: "project_membership",
    issuer,
    issuer_hash: issuerHash(issuer),
    audience,
    resource_url: resourceUrl,
    jwks_uri: jwksUri,
    client_registration: clientRegistration,
    configuration_source: "generic"
  };
}

export function createDirectorOAuthAuthenticator(
  config: DirectorOAuthConfig,
  options: WebGptV4AuthenticatorOptions = {}
): WebGptV4Authenticator {
  return createOAuthAuthenticator(config, { ...options, required_scopes: ["projects.read"] });
}

export function directorProtectedResourceMetadata(config: DirectorOAuthConfig | null): Record<string, unknown> {
  return protectedResourceMetadata(config, DIRECTOR_OAUTH_SCOPES, { resource_name: "Jenn AI Video Workspace Director" });
}

export function directorProtectedResourceMetadataUrl(config: DirectorOAuthConfig): string {
  return protectedResourceMetadataUrl(config.resource_url);
}

export function directorWwwAuthenticate(
  config: DirectorOAuthConfig | null,
  error = "invalid_token",
  options: { scope?: string; error_description?: string } = {}
): string {
  return wwwAuthenticate(config, error, {
    ...options,
    ...(config ? {} : { resource_metadata_url: "/.well-known/oauth-protected-resource/director/mcp" })
  });
}
