import {
  fetchPinnedHttps,
  PinnedHttpsError,
  isUnsafeNetworkHost,
  readBoundedBytes,
  withTimeout,
  type PinnedHttpsRuntime
} from "../net/pinnedHttpsTransport.js";
import type { WebGptV4ReadonlyFederatedAuthConfig } from "./auth.js";

export const WEBGPT_OAUTH_DOCUMENT_MAX_BYTES = 256 * 1024;
export const WEBGPT_OAUTH_FETCH_TIMEOUT_MS = 10_000;

export type WebGptOAuthDiscoveryCode =
  | "OAUTH_DISCOVERY_COMPATIBLE"
  | "OAUTH_DISCOVERY_FETCH_FAILED"
  | "OAUTH_DISCOVERY_STANDARD_METADATA_UNAVAILABLE"
  | "OAUTH_DISCOVERY_ISSUER_MISMATCH"
  | "OAUTH_DISCOVERY_PKCE_S256_MISSING"
  | "OAUTH_DISCOVERY_PUBLIC_CLIENT_UNSUPPORTED"
  | "OAUTH_DISCOVERY_CIMD_MISSING"
  | "OAUTH_DISCOVERY_DCR_MISSING"
  | "OAUTH_DISCOVERY_JWKS_MISMATCH"
  | "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER"
  | "OAUTH_DISCOVERY_UNSAFE_NETWORK_TARGET"
  | "OAUTH_DISCOVERY_RESPONSE_TOO_LARGE"
  | "OAUTH_DISCOVERY_INVALID_JSON";

export interface WebGptOAuthDiscoveryChecks {
  standard_metadata_kind: "rfc8414" | "oidc" | null;
  standard_metadata_status: number | null;
  standard_metadata_http_200: boolean;
  issuer_exact: boolean;
  authorization_endpoint_https: boolean;
  token_endpoint_https: boolean;
  jwks_uri_https: boolean;
  jwks_uri_exact: boolean;
  pkce_s256: boolean;
  public_client_token_auth_none: boolean;
  cimd: boolean;
  dcr: boolean;
  external_client_registration: "pending" | "not_applicable";
}

export interface WebGptOAuthDiscoveryDiagnostics {
  legacy_vendor_metadata_status: number | null;
  legacy_vendor_metadata_http_200: boolean;
  legacy_vendor_issuer_exact: boolean;
  legacy_vendor_cimd: boolean;
  legacy_vendor_dcr: boolean;
}

export interface WebGptOAuthDiscoveryReport {
  ok: boolean;
  code: WebGptOAuthDiscoveryCode;
  checks: WebGptOAuthDiscoveryChecks;
  diagnostics: WebGptOAuthDiscoveryDiagnostics;
}

type MetadataDocument = Record<string, unknown>;
type FetchResult = {
  status: number | null;
  document: MetadataDocument | null;
  failure: "fetch" | "unsafe_network" | "too_large" | "invalid_json" | null;
};

function emptyChecks(registration: WebGptV4ReadonlyFederatedAuthConfig["client_registration"]): WebGptOAuthDiscoveryChecks {
  return {
    standard_metadata_kind: null,
    standard_metadata_status: null,
    standard_metadata_http_200: false,
    issuer_exact: false,
    authorization_endpoint_https: false,
    token_endpoint_https: false,
    jwks_uri_https: false,
    jwks_uri_exact: false,
    pkce_s256: false,
    public_client_token_auth_none: false,
    cimd: false,
    dcr: false,
    external_client_registration: registration === "predefined" ? "pending" : "not_applicable"
  };
}

function emptyDiagnostics(): WebGptOAuthDiscoveryDiagnostics {
  return {
    legacy_vendor_metadata_status: null,
    legacy_vendor_metadata_http_200: false,
    legacy_vendor_issuer_exact: false,
    legacy_vendor_cimd: false,
    legacy_vendor_dcr: false
  };
}

function authorizationServerIdentifier(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || isUnsafeNetworkHost(parsed.hostname)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function secureEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash
      && !isUnsafeNetworkHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function rfc8414AuthorizationServerMetadataUrl(identifier: string): string {
  const parsed = authorizationServerIdentifier(identifier);
  if (!parsed) throw new Error("OAUTH_DISCOVERY_UNSAFE_IDENTIFIER");
  const issuerPath = parsed.pathname === "/" ? "" : parsed.pathname;
  parsed.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  return parsed.toString();
}

export function oidcAuthorizationServerMetadataUrl(identifier: string): string {
  const parsed = authorizationServerIdentifier(identifier);
  if (!parsed) throw new Error("OAUTH_DISCOVERY_UNSAFE_IDENTIFIER");
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`;
  return parsed.toString();
}

export function vendorAppendedAuthorizationServerMetadataUrl(identifier: string): string {
  const parsed = authorizationServerIdentifier(identifier);
  if (!parsed) throw new Error("OAUTH_DISCOVERY_UNSAFE_IDENTIFIER");
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  return parsed.toString();
}

export function validateAuthorizationServerMetadata(
  config: WebGptV4ReadonlyFederatedAuthConfig,
  document: MetadataDocument
): Pick<WebGptOAuthDiscoveryReport, "ok" | "code" | "checks"> {
  const checks = emptyChecks(config.client_registration);
  checks.standard_metadata_http_200 = true;
  checks.issuer_exact = document.issuer === config.issuer;
  checks.authorization_endpoint_https = secureEndpoint(document.authorization_endpoint);
  checks.token_endpoint_https = secureEndpoint(document.token_endpoint);
  checks.jwks_uri_https = secureEndpoint(document.jwks_uri);
  checks.jwks_uri_exact = document.jwks_uri === config.jwks_uri;
  checks.pkce_s256 = Array.isArray(document.code_challenge_methods_supported)
    && document.code_challenge_methods_supported.includes("S256");
  checks.public_client_token_auth_none = Array.isArray(document.token_endpoint_auth_methods_supported)
    && document.token_endpoint_auth_methods_supported.includes("none");
  checks.cimd = document.client_id_metadata_document_supported === true;
  checks.dcr = secureEndpoint(document.registration_endpoint);

  if (!checks.issuer_exact) return { ok: false, code: "OAUTH_DISCOVERY_ISSUER_MISMATCH", checks };
  if (!checks.authorization_endpoint_https || !checks.token_endpoint_https) {
    return { ok: false, code: "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER", checks };
  }
  if (!checks.jwks_uri_https || !checks.jwks_uri_exact) return { ok: false, code: "OAUTH_DISCOVERY_JWKS_MISMATCH", checks };
  if (!checks.pkce_s256) return { ok: false, code: "OAUTH_DISCOVERY_PKCE_S256_MISSING", checks };
  if (!checks.public_client_token_auth_none) return { ok: false, code: "OAUTH_DISCOVERY_PUBLIC_CLIENT_UNSUPPORTED", checks };
  if (config.client_registration === "cimd" && !checks.cimd) return { ok: false, code: "OAUTH_DISCOVERY_CIMD_MISSING", checks };
  if (config.client_registration === "dcr" && document.registration_endpoint !== undefined && !checks.dcr) {
    return { ok: false, code: "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER", checks };
  }
  if (config.client_registration === "dcr" && !checks.dcr) return { ok: false, code: "OAUTH_DISCOVERY_DCR_MISSING", checks };
  return { ok: true, code: "OAUTH_DISCOVERY_COMPATIBLE", checks };
}

async function boundedJson(response: Response): Promise<MetadataDocument> {
  const bytes = await readBoundedBytes(response, WEBGPT_OAUTH_DOCUMENT_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("OAUTH_DISCOVERY_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OAUTH_DISCOVERY_INVALID_JSON");
  return parsed as MetadataDocument;
}

async function fetchMetadata(url: string, runtime: PinnedHttpsRuntime): Promise<FetchResult> {
  try {
    const response = await fetchPinnedHttps(new URL(url), withTimeout(undefined, WEBGPT_OAUTH_FETCH_TIMEOUT_MS), runtime);
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* the status remains authoritative */ }
      return { status: response.status, document: null, failure: null };
    }
    try {
      return { status: 200, document: await boundedJson(response), failure: null };
    } catch (error) {
      const failure = error instanceof PinnedHttpsError && error.code === "RESPONSE_TOO_LARGE"
        ? "too_large"
        : error instanceof Error && error.message === "OAUTH_DISCOVERY_INVALID_JSON"
          ? "invalid_json"
          : "fetch";
      return {
        status: 200,
        document: null,
        failure
      };
    }
  } catch (error) {
    return {
      status: null,
      document: null,
      failure: error instanceof PinnedHttpsError && error.code === "UNSAFE_NETWORK_TARGET" ? "unsafe_network" : "fetch"
    };
  }
}

function fetchFailureCode(result: FetchResult): WebGptOAuthDiscoveryCode | null {
  if (result.failure === "unsafe_network") return "OAUTH_DISCOVERY_UNSAFE_NETWORK_TARGET";
  if (result.failure === "too_large") return "OAUTH_DISCOVERY_RESPONSE_TOO_LARGE";
  if (result.failure === "invalid_json") return "OAUTH_DISCOVERY_INVALID_JSON";
  return null;
}

async function legacyDiagnostics(config: WebGptV4ReadonlyFederatedAuthConfig, runtime: PinnedHttpsRuntime): Promise<WebGptOAuthDiscoveryDiagnostics> {
  const diagnostics = emptyDiagnostics();
  if (config.configuration_source !== "legacy_descope" || !config.legacy_authorization_server_url) return diagnostics;
  const appended = await fetchMetadata(vendorAppendedAuthorizationServerMetadataUrl(config.legacy_authorization_server_url), runtime);
  diagnostics.legacy_vendor_metadata_status = appended.status;
  diagnostics.legacy_vendor_metadata_http_200 = appended.status === 200;
  if (appended.document) {
    diagnostics.legacy_vendor_issuer_exact = appended.document.issuer === config.legacy_authorization_server_url;
    diagnostics.legacy_vendor_cimd = appended.document.client_id_metadata_document_supported === true;
    diagnostics.legacy_vendor_dcr = secureEndpoint(appended.document.registration_endpoint);
  }
  return diagnostics;
}

export async function probeWebGptOAuthDiscovery(
  config: WebGptV4ReadonlyFederatedAuthConfig,
  runtime: PinnedHttpsRuntime = {}
): Promise<WebGptOAuthDiscoveryReport> {
  const diagnostics = emptyDiagnostics();
  const identifier = config.configuration_source === "legacy_descope"
    ? config.legacy_authorization_server_url ?? config.issuer
    : config.issuer;
  if (!authorizationServerIdentifier(identifier) || !authorizationServerIdentifier(config.issuer)) {
    return { ok: false, code: "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER", checks: emptyChecks(config.client_registration), diagnostics };
  }

  const candidates = [
    { kind: "rfc8414" as const, url: rfc8414AuthorizationServerMetadataUrl(identifier) },
    { kind: "oidc" as const, url: oidcAuthorizationServerMetadataUrl(identifier) }
  ];
  let sawFetchFailure = false;
  let lastKind: WebGptOAuthDiscoveryChecks["standard_metadata_kind"] = null;
  let lastStatus: number | null = null;
  for (const candidate of candidates) {
    const fetched = await fetchMetadata(candidate.url, runtime);
    lastKind = candidate.kind;
    lastStatus = fetched.status;
    const hardFailure = fetchFailureCode(fetched);
    if (hardFailure) {
      const checks = emptyChecks(config.client_registration);
      checks.standard_metadata_kind = candidate.kind;
      checks.standard_metadata_status = fetched.status;
      return { ok: false, code: hardFailure, checks, diagnostics: await legacyDiagnostics(config, runtime) };
    }
    if (fetched.failure === "fetch") sawFetchFailure = true;
    if (!fetched.document) continue;
    const validated = validateAuthorizationServerMetadata(config, fetched.document);
    validated.checks.standard_metadata_kind = candidate.kind;
    validated.checks.standard_metadata_status = fetched.status;
    validated.checks.standard_metadata_http_200 = fetched.status === 200;
    if (config.configuration_source === "legacy_descope") {
      return {
        ok: false,
        code: "OAUTH_DISCOVERY_STANDARD_METADATA_UNAVAILABLE",
        checks: validated.checks,
        diagnostics: await legacyDiagnostics(config, runtime)
      };
    }
    return { ...validated, diagnostics };
  }

  const checks = emptyChecks(config.client_registration);
  checks.standard_metadata_kind = lastKind;
  checks.standard_metadata_status = lastStatus;
  return {
    ok: false,
    code: sawFetchFailure ? "OAUTH_DISCOVERY_FETCH_FAILED" : "OAUTH_DISCOVERY_STANDARD_METADATA_UNAVAILABLE",
    checks,
    diagnostics: await legacyDiagnostics(config, runtime)
  };
}
