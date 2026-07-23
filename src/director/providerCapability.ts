import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import {
  buildProviderCapabilityKey,
  buildProviderPriceCacheKey,
  providerCapabilityPriceSource,
  RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY,
  RUNWAY_IMAGE_TO_VIDEO_CAPABILITY,
  type CapabilityProviderName,
  type ProviderCapability,
  type ProviderCapabilityKey
} from "../tools/providerCapabilities.js";
import { directorProviderAmountToMinor, type DirectorSupportedCurrency } from "./currency.js";
import type { M0Database } from "../storage/sqlite.js";

export const DIRECTOR_PROVIDER_CAPABILITY_REGISTRY_VERSION = "director-provider-capabilities-v1" as const;
export const DIRECTOR_QUOTE_CONTRACT_VERSION = "director-quote-v1" as const;

export type DirectorCapabilityVerification = "verified" | "candidate";
export type DirectorQuoteState = "not_applicable" | "ready" | "missing" | "expired" | "stale" | "capability_drift" | "capability_unavailable";
export type DirectorGenerationAction = "generation.submit" | "generation.retry" | "generation.download" | "artifact.activate";

export interface DirectorProviderCapability {
  reference: string;
  provider_capability: ProviderCapability;
  verification: DirectorCapabilityVerification;
  priority: number;
  allowed_actions: readonly DirectorGenerationAction[];
  quote: {
    max_age_seconds: number;
    requires_official_preflight: true;
    requires_balance_verification: true;
  };
  retry: {
    max_automatic_retries: number;
    only_known_no_submit: true;
  };
}

function capabilityReference(capability: ProviderCapability): string {
  return `${DIRECTOR_PROVIDER_CAPABILITY_REGISTRY_VERSION}:${capability.version}:${capability.capability_id}`;
}

/**
 * This is a Director policy layer over the shared provider registry. A route
 * can appear here as a future candidate without being selectable. Its model
 * always comes from the shared registry, never from an unreviewed string.
 */
export const RUNNINGHUB_DIRECTOR_CAPABILITY = Object.freeze({
  reference: capabilityReference(RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY),
  provider_capability: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY,
  verification: "verified",
  priority: 20,
  allowed_actions: Object.freeze(["generation.submit", "generation.retry", "generation.download", "artifact.activate"]),
  quote: Object.freeze({ max_age_seconds: 10 * 60, requires_official_preflight: true, requires_balance_verification: true }),
  retry: Object.freeze({ max_automatic_retries: 1, only_known_no_submit: true })
} as const satisfies DirectorProviderCapability);

/** A non-selectable candidate until the separate Runway capability canary passes. */
export const RUNWAY_DIRECTOR_CAPABILITY_CANDIDATE = Object.freeze({
  reference: capabilityReference(RUNWAY_IMAGE_TO_VIDEO_CAPABILITY),
  provider_capability: RUNWAY_IMAGE_TO_VIDEO_CAPABILITY,
  verification: "candidate",
  priority: 10,
  allowed_actions: Object.freeze(["generation.submit", "generation.retry", "generation.download", "artifact.activate"]),
  quote: Object.freeze({ max_age_seconds: 10 * 60, requires_official_preflight: true, requires_balance_verification: true }),
  retry: Object.freeze({ max_automatic_retries: 1, only_known_no_submit: true })
} as const satisfies DirectorProviderCapability);

export const DIRECTOR_PROVIDER_CAPABILITIES: readonly DirectorProviderCapability[] = Object.freeze([
  RUNNINGHUB_DIRECTOR_CAPABILITY,
  RUNWAY_DIRECTOR_CAPABILITY_CANDIDATE
]);

export interface DirectorCapabilitySelection {
  capability: DirectorProviderCapability;
  key: ProviderCapabilityKey;
}

export interface DirectorQuotePublic {
  quote_state: Exclude<DirectorQuoteState, "ready">;
  capability_reference: string | null;
  expires_at: string | null;
  currency: DirectorSupportedCurrency | null;
  requires_human_refresh: boolean;
}

export interface DirectorVerifiedQuote extends Omit<DirectorQuotePublic, "quote_state" | "capability_reference" | "expires_at" | "currency" | "requires_human_refresh"> {
  quote_state: "ready";
  capability_reference: string;
  expires_at: string;
  currency: DirectorSupportedCurrency;
  requires_human_refresh: false;
  amount_minor: number;
  reference: string;
}

/** The only quote projection that may leave the local approval boundary. */
export function publicDirectorQuote(quote: DirectorQuotePublic | DirectorVerifiedQuote): {
  quote_state: DirectorQuoteState;
  expires_at: string | null;
  currency: DirectorSupportedCurrency | null;
  requires_human_refresh: boolean;
} {
  return {
    quote_state: quote.quote_state,
    expires_at: quote.expires_at,
    currency: quote.currency,
    requires_human_refresh: quote.requires_human_refresh
  };
}

function quoteHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeJcs(value)).digest("hex");
}

function parsedDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asCurrency(value: string): DirectorSupportedCurrency | null {
  const normalized = value.trim().toUpperCase();
  return normalized === "CNY" || normalized === "RH_COINS" ? normalized : null;
}

function capabilityInputMatches(
  capability: DirectorProviderCapability,
  input: { duration_seconds: number; resolution: string; aspect_ratio: string }
): ProviderCapabilityKey | null {
  const result = buildProviderCapabilityKey({
    provider: capability.provider_capability.provider,
    model: capability.provider_capability.model,
    duration_seconds: input.duration_seconds,
    resolution: input.resolution,
    aspect_ratio: input.aspect_ratio
  });
  if (!result.ok || result.capability.capability_id !== capability.provider_capability.capability_id) return null;
  return result.key;
}

export function selectVerifiedDirectorCapability(input: {
  duration_seconds: number;
  resolution: string;
  aspect_ratio: string;
}): DirectorCapabilitySelection | null {
  for (const capability of [...DIRECTOR_PROVIDER_CAPABILITIES].sort((left, right) => right.priority - left.priority)) {
    if (capability.verification !== "verified") continue;
    const key = capabilityInputMatches(capability, input);
    if (key) return { capability, key };
  }
  return null;
}

export function directorCapabilityForReference(reference: string, provider: CapabilityProviderName): DirectorProviderCapability | null {
  const found = DIRECTOR_PROVIDER_CAPABILITIES.find((candidate) => candidate.reference === reference);
  return found?.provider_capability.provider === provider ? found : null;
}

export function isLegacyRunningHubGrantReference(provider: string, capabilityReferenceValue: string): boolean {
  return provider === "runninghub" && capabilityReferenceValue === "runninghub-capability-v1";
}

export function assertDirectorGrantCapability(provider: string, capabilityReferenceValue: string): DirectorProviderCapability | null {
  if (provider !== "runninghub" && provider !== "runway") throw new Error("DIRECTOR_PROVIDER_CAPABILITY_UNAVAILABLE");
  const capability = directorCapabilityForReference(capabilityReferenceValue, provider);
  if (capability?.verification === "verified") return capability;
  if (capability) throw new Error("DIRECTOR_PROVIDER_CAPABILITY_UNAVAILABLE");
  if (isLegacyRunningHubGrantReference(provider, capabilityReferenceValue)) return null;
  throw new Error("DIRECTOR_PROVIDER_CAPABILITY_DRIFT");
}

export function readDirectorQuote(
  db: M0Database,
  selection: DirectorCapabilitySelection | null,
  now = new Date()
): DirectorQuotePublic | DirectorVerifiedQuote {
  if (!selection) {
    return { quote_state: "capability_unavailable", capability_reference: null, expires_at: null, currency: null, requires_human_refresh: true };
  }
  const { capability, key } = selection;
  if (capability.verification !== "verified") {
    return { quote_state: "capability_unavailable", capability_reference: capability.reference, expires_at: null, currency: null, requires_human_refresh: true };
  }
  const priceKey = buildProviderPriceCacheKey(key, capability.provider_capability);
  const row = db.prepare(`SELECT estimated_cost_value, currency, source, fetched_at, expires_at
    FROM webgpt_provider_price_cache
    WHERE provider = ? AND model = ? AND duration_seconds = ? AND resolution = ?`).get(
    priceKey.provider, priceKey.model, priceKey.duration_seconds, priceKey.storage_resolution
  ) as { estimated_cost_value: number; currency: string; source: string; fetched_at: string; expires_at: string } | undefined;
  if (!row) {
    return { quote_state: "missing", capability_reference: capability.reference, expires_at: null, currency: null, requires_human_refresh: true };
  }
  const currency = asCurrency(row.currency);
  const fetchedAt = parsedDate(row.fetched_at);
  const expiresAt = parsedDate(row.expires_at);
  const amountMinor = currency ? directorProviderAmountToMinor(Number(row.estimated_cost_value), currency) : null;
  const officialSource = providerCapabilityPriceSource(capability.provider_capability, key.aspect_ratio);
  if (row.source !== officialSource || !currency || amountMinor === null || fetchedAt === null || expiresAt === null) {
    return { quote_state: "capability_drift", capability_reference: capability.reference, expires_at: null, currency: null, requires_human_refresh: true };
  }
  const current = now.getTime();
  const publicValue = {
    capability_reference: capability.reference,
    expires_at: new Date(expiresAt).toISOString(),
    currency
  } as const;
  if (expiresAt <= current) return { quote_state: "expired", ...publicValue, requires_human_refresh: true };
  if (current - fetchedAt > capability.quote.max_age_seconds * 1_000) return { quote_state: "stale", ...publicValue, requires_human_refresh: true };
  return {
    quote_state: "ready",
    ...publicValue,
    requires_human_refresh: false,
    amount_minor: amountMinor,
    reference: `${DIRECTOR_QUOTE_CONTRACT_VERSION}:${quoteHash({
      capability_reference: capability.reference,
      provider: key.provider,
      model: key.model,
      duration_seconds: key.duration_seconds,
      resolution: key.resolution,
      aspect_ratio: key.aspect_ratio,
      source: row.source,
      fetched_at: new Date(fetchedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      currency,
      amount_minor: amountMinor
    })}`
  };
}

export function directorQuoteFailureCode(quote: DirectorQuotePublic): string {
  switch (quote.quote_state) {
    case "missing": return "DIRECTOR_QUOTE_REQUIRED";
    case "expired":
    case "stale": return "DIRECTOR_QUOTE_EXPIRED";
    case "capability_drift": return "DIRECTOR_PROVIDER_CAPABILITY_DRIFT";
    case "capability_unavailable": return "DIRECTOR_PROVIDER_CAPABILITY_UNAVAILABLE";
    default: return "DIRECTOR_QUOTE_REQUIRED";
  }
}

/**
 * Legacy Proposal payloads may still be read, but a historical provider/model
 * declaration can never override the selected current capability at compile
 * time. New ChatGPT-authored payloads do not carry any of these fields.
 */
export function legacyProposalMatchesDirectorCapability(
  payload: Record<string, unknown>,
  selection: DirectorCapabilitySelection
): boolean {
  if (!("provider" in payload || "model" in payload || "duration_seconds" in payload || "resolution" in payload)) return true;
  if (typeof payload.provider !== "string" || typeof payload.model !== "string"
    || typeof payload.duration_seconds !== "number" || !Number.isSafeInteger(payload.duration_seconds)
    || typeof payload.resolution !== "string") return false;
  const legacy = buildProviderCapabilityKey({
    provider: payload.provider as CapabilityProviderName,
    model: payload.model,
    duration_seconds: payload.duration_seconds,
    resolution: payload.resolution,
    aspect_ratio: selection.key.aspect_ratio
  });
  return legacy.ok && legacy.key.serialized === selection.key.serialized;
}
