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
import { UNIFIED_WORKSPACE_OAUTH_SCOPES } from "./toolCatalog.js";

export const UNIFIED_WORKSPACE_MCP_PATH = "/workspace/mcp";
export const UNIFIED_WORKSPACE_OAUTH_ENV_KEYS = [
  "WEBGPT_WORKSPACE_RESOURCE_URL",
  "WEBGPT_WORKSPACE_OAUTH_ISSUER",
  "WEBGPT_WORKSPACE_OAUTH_AUDIENCE",
  "WEBGPT_WORKSPACE_OAUTH_JWKS_URI",
  "WEBGPT_WORKSPACE_OAUTH_CLIENT_REGISTRATION"
] as const;

export type UnifiedWorkspaceOAuthConfig = WebGptV4ReadonlyFederatedAuthConfig;

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

function isUnifiedWorkspaceResource(value: string): boolean {
  if (!exactHttpsIdentifier(value)) return false;
  return new URL(value).pathname === UNIFIED_WORKSPACE_MCP_PATH;
}

function invalid(code: "INVALID_UNIFIED_WORKSPACE_OAUTH_CONFIG" | "AMBIGUOUS_UNIFIED_WORKSPACE_OAUTH_RESOURCE", message: string): never {
  throw new WebGptV4Error(code, message, "WEBGPT_WORKSPACE_RESOURCE_URL");
}

/**
 * Loads the OAuth contract for the future single ChatGPT Workspace connector.
 * It deliberately does not replace either legacy Readonly or legacy Director
 * configuration, because those routes remain rollback surfaces until external
 * acceptance has completed.
 */
export function loadUnifiedWorkspaceOAuthConfig(env: NodeJS.ProcessEnv = process.env): UnifiedWorkspaceOAuthConfig | null {
  const present = UNIFIED_WORKSPACE_OAUTH_ENV_KEYS.filter((key) => configured(env, key));
  if (present.length === 0) return null;
  if (present.length !== UNIFIED_WORKSPACE_OAUTH_ENV_KEYS.length) {
    invalid("INVALID_UNIFIED_WORKSPACE_OAUTH_CONFIG", "Unified Workspace OAuth configuration must be supplied as one complete set.");
  }

  const resourceUrl = env.WEBGPT_WORKSPACE_RESOURCE_URL!.trim();
  const issuer = env.WEBGPT_WORKSPACE_OAUTH_ISSUER!.trim();
  const audience = env.WEBGPT_WORKSPACE_OAUTH_AUDIENCE!.trim();
  const jwksUri = env.WEBGPT_WORKSPACE_OAUTH_JWKS_URI!.trim();
  const clientRegistration = env.WEBGPT_WORKSPACE_OAUTH_CLIENT_REGISTRATION!.trim() as WebGptV4ClientRegistration;
  if (!isUnifiedWorkspaceResource(resourceUrl)
    || ![issuer, audience, jwksUri].every(exactHttpsIdentifier)
    || resourceUrl !== audience
    || !(clientRegistration === "predefined" || clientRegistration === "cimd" || clientRegistration === "dcr")) {
    invalid("INVALID_UNIFIED_WORKSPACE_OAUTH_CONFIG", "Unified Workspace OAuth identifiers or client-registration mode are invalid.");
  }

  const legacyResources = [
    env.WEBGPT_V4_RESOURCE_URL?.trim(),
    env.WEBGPT_DIRECTOR_RESOURCE_URL?.trim()
  ].filter((value): value is string => Boolean(value));
  if (legacyResources.includes(resourceUrl)) {
    invalid("AMBIGUOUS_UNIFIED_WORKSPACE_OAUTH_RESOURCE", "Unified Workspace OAuth must use a resource distinct from legacy Readonly and Director resources.");
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

export function createUnifiedWorkspaceOAuthAuthenticator(
  config: UnifiedWorkspaceOAuthConfig,
  options: WebGptV4AuthenticatorOptions = {}
): WebGptV4Authenticator {
  return createOAuthAuthenticator(config, { ...options, required_scopes: ["projects.read"] });
}

export function unifiedWorkspaceProtectedResourceMetadata(config: UnifiedWorkspaceOAuthConfig | null): Record<string, unknown> {
  return protectedResourceMetadata(config, UNIFIED_WORKSPACE_OAUTH_SCOPES, { resource_name: "Jenn AI Video Workspace" });
}

export function unifiedWorkspaceProtectedResourceMetadataUrl(config: UnifiedWorkspaceOAuthConfig): string {
  return protectedResourceMetadataUrl(config.resource_url);
}

export function unifiedWorkspaceWwwAuthenticate(
  config: UnifiedWorkspaceOAuthConfig | null,
  error = "invalid_token",
  options: { scope?: string; error_description?: string } = {}
): string {
  return wwwAuthenticate(config, error, {
    ...options,
    ...(config ? {} : { resource_metadata_url: `/.well-known/oauth-protected-resource${UNIFIED_WORKSPACE_MCP_PATH}` })
  });
}
