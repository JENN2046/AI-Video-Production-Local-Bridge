import type { WebGptV4DescopeAuthConfig } from "./auth.js";

const MAX_METADATA_BYTES = 256 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DESCOPE_DISCOVERY_HOST = "api.descope.com";

export type WebGptOAuthDiscoveryCode =
  | "OAUTH_DISCOVERY_COMPATIBLE"
  | "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER"
  | "OAUTH_DISCOVERY_FETCH_FAILED"
  | "OAUTH_DISCOVERY_RFC8414_UNAVAILABLE"
  | "OAUTH_DISCOVERY_RESPONSE_TOO_LARGE"
  | "OAUTH_DISCOVERY_INVALID_JSON"
  | "OAUTH_DISCOVERY_ISSUER_MISMATCH"
  | "OAUTH_DISCOVERY_AUTHORIZATION_ENDPOINT_INVALID"
  | "OAUTH_DISCOVERY_TOKEN_ENDPOINT_INVALID"
  | "OAUTH_DISCOVERY_PKCE_S256_MISSING"
  | "OAUTH_DISCOVERY_PUBLIC_CLIENT_UNSUPPORTED"
  | "OAUTH_DISCOVERY_REGISTRATION_CAPABILITY_MISSING";

export interface WebGptOAuthDiscoveryChecks {
  rfc8414_metadata_status: number | null;
  rfc8414_metadata_http_200: boolean;
  issuer_exact: boolean;
  authorization_endpoint_https: boolean;
  token_endpoint_https: boolean;
  pkce_s256: boolean;
  public_client_token_auth_none: boolean;
  cimd: boolean;
  dcr: boolean;
}

export interface WebGptOAuthDiscoveryDiagnostics {
  vendor_appended_metadata_status: number | null;
  vendor_appended_metadata_http_200: boolean;
  vendor_appended_issuer_exact: boolean;
  vendor_appended_cimd: boolean;
  vendor_appended_dcr: boolean;
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
  failure: "fetch" | "too_large" | "invalid_json" | null;
};

function emptyChecks(): WebGptOAuthDiscoveryChecks {
  return {
    rfc8414_metadata_status: null,
    rfc8414_metadata_http_200: false,
    issuer_exact: false,
    authorization_endpoint_https: false,
    token_endpoint_https: false,
    pkce_s256: false,
    public_client_token_auth_none: false,
    cimd: false,
    dcr: false
  };
}

function emptyDiagnostics(): WebGptOAuthDiscoveryDiagnostics {
  return {
    vendor_appended_metadata_status: null,
    vendor_appended_metadata_http_200: false,
    vendor_appended_issuer_exact: false,
    vendor_appended_cimd: false,
    vendor_appended_dcr: false
  };
}

function authorizationServerIdentifier(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== DESCOPE_DISCOVERY_HOST
      || (parsed.port && parsed.port !== "443")
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
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
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

export function rfc8414AuthorizationServerMetadataUrl(identifier: string): string {
  const parsed = authorizationServerIdentifier(identifier);
  if (!parsed) throw new Error("OAUTH_DISCOVERY_UNSAFE_IDENTIFIER");
  const issuerPath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  parsed.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  return parsed.toString();
}

export function vendorAppendedAuthorizationServerMetadataUrl(identifier: string): string {
  const parsed = authorizationServerIdentifier(identifier);
  if (!parsed) throw new Error("OAUTH_DISCOVERY_UNSAFE_IDENTIFIER");
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  return parsed.toString();
}

export function validateAuthorizationServerMetadata(
  identifier: string,
  document: MetadataDocument
): Pick<WebGptOAuthDiscoveryReport, "ok" | "code" | "checks"> {
  const checks = emptyChecks();
  checks.rfc8414_metadata_http_200 = true;
  checks.issuer_exact = document.issuer === identifier;
  checks.authorization_endpoint_https = secureEndpoint(document.authorization_endpoint);
  checks.token_endpoint_https = secureEndpoint(document.token_endpoint);
  checks.pkce_s256 = Array.isArray(document.code_challenge_methods_supported)
    && document.code_challenge_methods_supported.includes("S256");
  checks.public_client_token_auth_none = Array.isArray(document.token_endpoint_auth_methods_supported)
    && document.token_endpoint_auth_methods_supported.includes("none");
  checks.cimd = document.client_id_metadata_document_supported === true;
  checks.dcr = secureEndpoint(document.registration_endpoint);

  if (!checks.issuer_exact) return { ok: false, code: "OAUTH_DISCOVERY_ISSUER_MISMATCH", checks };
  if (!checks.authorization_endpoint_https) return { ok: false, code: "OAUTH_DISCOVERY_AUTHORIZATION_ENDPOINT_INVALID", checks };
  if (!checks.token_endpoint_https) return { ok: false, code: "OAUTH_DISCOVERY_TOKEN_ENDPOINT_INVALID", checks };
  if (!checks.pkce_s256) return { ok: false, code: "OAUTH_DISCOVERY_PKCE_S256_MISSING", checks };
  if (!checks.public_client_token_auth_none) return { ok: false, code: "OAUTH_DISCOVERY_PUBLIC_CLIENT_UNSUPPORTED", checks };
  if (!checks.cimd && !checks.dcr) return { ok: false, code: "OAUTH_DISCOVERY_REGISTRATION_CAPABILITY_MISSING", checks };
  return { ok: true, code: "OAUTH_DISCOVERY_COMPATIBLE", checks };
}

async function boundedJson(response: Response): Promise<MetadataDocument> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) {
    try { await response.body?.cancel(); } catch { /* preserve the bounded-size failure */ }
    throw new Error("OAUTH_DISCOVERY_RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new Error("OAUTH_DISCOVERY_INVALID_JSON");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_METADATA_BYTES) {
        try { await reader.cancel(); } catch { /* preserve the bounded-size failure */ }
        throw new Error("OAUTH_DISCOVERY_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("OAUTH_DISCOVERY_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OAUTH_DISCOVERY_INVALID_JSON");
  }
  return parsed as MetadataDocument;
}

async function fetchMetadata(url: string, fetchImpl: typeof fetch): Promise<FetchResult> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* the HTTP status remains authoritative */ }
      return { status: response.status, document: null, failure: null };
    }
    try {
      return { status: response.status, document: await boundedJson(response), failure: null };
    } catch (error) {
      const failure = error instanceof Error && error.message === "OAUTH_DISCOVERY_RESPONSE_TOO_LARGE"
        ? "too_large"
        : "invalid_json";
      return { status: response.status, document: null, failure };
    }
  } catch {
    return { status: null, document: null, failure: "fetch" };
  }
}

function primaryFetchFailure(result: FetchResult): WebGptOAuthDiscoveryCode {
  if (result.failure === "fetch") return "OAUTH_DISCOVERY_FETCH_FAILED";
  if (result.failure === "too_large") return "OAUTH_DISCOVERY_RESPONSE_TOO_LARGE";
  if (result.failure === "invalid_json") return "OAUTH_DISCOVERY_INVALID_JSON";
  return "OAUTH_DISCOVERY_RFC8414_UNAVAILABLE";
}

export async function probeWebGptOAuthDiscovery(
  config: WebGptV4DescopeAuthConfig,
  fetchImpl: typeof fetch = fetch
): Promise<WebGptOAuthDiscoveryReport> {
  const identifier = config.authorization_server_url;
  if (!authorizationServerIdentifier(identifier)) {
    return { ok: false, code: "OAUTH_DISCOVERY_UNSAFE_IDENTIFIER", checks: emptyChecks(), diagnostics: emptyDiagnostics() };
  }

  const standard = await fetchMetadata(rfc8414AuthorizationServerMetadataUrl(identifier), fetchImpl);
  let primary = standard.document
    ? validateAuthorizationServerMetadata(identifier, standard.document)
    : { ok: false as const, code: primaryFetchFailure(standard), checks: emptyChecks() };
  primary.checks.rfc8414_metadata_http_200 = standard.status === 200;
  primary.checks.rfc8414_metadata_status = standard.status;

  const diagnostics = emptyDiagnostics();
  if (!primary.ok) {
    const appended = await fetchMetadata(vendorAppendedAuthorizationServerMetadataUrl(identifier), fetchImpl);
    diagnostics.vendor_appended_metadata_status = appended.status;
    diagnostics.vendor_appended_metadata_http_200 = appended.status === 200;
    if (appended.document) {
      const appendedValidation = validateAuthorizationServerMetadata(identifier, appended.document);
      diagnostics.vendor_appended_issuer_exact = appendedValidation.checks.issuer_exact;
      diagnostics.vendor_appended_cimd = appendedValidation.checks.cimd;
      diagnostics.vendor_appended_dcr = appendedValidation.checks.dcr;
    }
  }

  return { ok: primary.ok, code: primary.code, checks: primary.checks, diagnostics };
}
