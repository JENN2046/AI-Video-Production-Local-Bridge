import { WebGptV4Error } from "./types.js";

export interface WebGptPredefinedPublicClientCapability {
  provider_id: string;
  client_registration: "predefined";
  authorization_endpoint: string;
  authorization_endpoint_hosting: "provider_hosted" | "application_hosted" | string;
  authorization_endpoint_reachable: boolean;
  end_user_login_and_consent_ready: boolean;
  grant_types: readonly string[];
  pkce_code_challenge_method: "S256" | string;
  token_endpoint_auth_method: "none" | string;
  configured_scopes: readonly string[];
  redirect_uris: readonly string[];
  redirect_policy: "exact_allowlist" | string;
  resource_url: string;
  access_token_audience: string;
  client_credentials_enabled: boolean;
  client_secret_present: boolean;
}

export interface WebGptPredefinedPublicClientCompatibility {
  compatible: true;
  client_registration: "predefined";
  external_client_registration: "pending" | "verified";
}

export interface WebGptPredefinedPublicClientTarget {
  resource_url: string;
  redirect_uri: string;
}

function capabilityError(field: keyof WebGptPredefinedPublicClientCapability): never {
  throw new WebGptV4Error(
    "INVALID_WEBGPT_PROVIDER_CAPABILITY",
    "The selected OAuth provider/client capability does not satisfy the Readonly predefined public-client contract.",
    field
  );
}

function isHttpsIdentifier(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function assertWebGptPredefinedPublicClientCapability(
  capability: WebGptPredefinedPublicClientCapability,
  expected: WebGptPredefinedPublicClientTarget
): WebGptPredefinedPublicClientCompatibility {
  if (typeof capability.provider_id !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(capability.provider_id)) capabilityError("provider_id");
  if (capability.client_registration !== "predefined") capabilityError("client_registration");
  if (!isHttpsIdentifier(capability.authorization_endpoint)) capabilityError("authorization_endpoint");
  if (capability.authorization_endpoint_hosting !== "provider_hosted"
    && capability.authorization_endpoint_hosting !== "application_hosted") capabilityError("authorization_endpoint_hosting");
  if (capability.authorization_endpoint_reachable !== true) capabilityError("authorization_endpoint_reachable");
  if (capability.end_user_login_and_consent_ready !== true) capabilityError("end_user_login_and_consent_ready");
  if (!Array.isArray(capability.grant_types) || capability.grant_types.length !== 1 || capability.grant_types[0] !== "authorization_code") capabilityError("grant_types");
  if (capability.pkce_code_challenge_method !== "S256") capabilityError("pkce_code_challenge_method");
  if (capability.token_endpoint_auth_method !== "none") capabilityError("token_endpoint_auth_method");
  if (!Array.isArray(capability.configured_scopes) || capability.configured_scopes.length !== 1 || capability.configured_scopes[0] !== "projects.read") capabilityError("configured_scopes");
  if (!isHttpsIdentifier(expected.redirect_uri) || capability.redirect_policy !== "exact_allowlist"
    || !Array.isArray(capability.redirect_uris) || capability.redirect_uris.length !== 1 || capability.redirect_uris[0] !== expected.redirect_uri
    || capability.redirect_uris.some((value) => !isHttpsIdentifier(value))) capabilityError("redirect_uris");
  if (!isHttpsIdentifier(expected.resource_url) || !isHttpsIdentifier(capability.resource_url)
    || capability.resource_url !== expected.resource_url) capabilityError("resource_url");
  if (capability.access_token_audience !== capability.resource_url) capabilityError("access_token_audience");
  if (capability.client_credentials_enabled !== false) capabilityError("client_credentials_enabled");
  if (capability.client_secret_present !== false) capabilityError("client_secret_present");
  return {
    compatible: true,
    client_registration: "predefined",
    // A local capability declaration cannot prove that ChatGPT used the registered Client ID.
    external_client_registration: "pending"
  };
}
