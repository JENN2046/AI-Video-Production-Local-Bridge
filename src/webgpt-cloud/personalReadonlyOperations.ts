import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assertReadonlyPublisherPathsIgnored,
  loadReadonlyPublisherProfile,
  preflightReadonlyPublisher,
  publishReadonlySnapshot,
  READONLY_PUBLISHER_RECEIPT_SCHEMA,
  ReadonlyPublisherError,
  type PublisherDependencies,
  type ReadonlyPublisherProfile,
  type ReadonlyPublisherReceipt
} from "./publisher.js";

export const PERSONAL_READONLY_OPERATIONS_VERSION = "personal-readonly-operations-v2";
export const DEFAULT_READONLY_PUBLISHER_PROFILE_PATH = "data/webgpt/publisher/profile.json";
export const READONLY_SNAPSHOT_RENEWAL_THRESHOLD_SECONDS = 2 * 60 * 60;

export interface PersonalReadonlySnapshotStatus {
  freshness_status: "no_snapshot" | "fresh" | "snapshot_expired" | "unknown";
  generated_at: string | null;
  expires_at: string | null;
  age_seconds: number | null;
  ttl_remaining_seconds: number | null;
  snapshot_fingerprint: string | null;
}

export interface PersonalReadonlyOperationsStatus {
  operations_version: typeof PERSONAL_READONLY_OPERATIONS_VERSION;
  checked_at: string;
  configuration: "missing" | "invalid" | "ready";
  stable_error_code: string | null;
  database_available: boolean;
  publisher_key_available: boolean;
  ready_to_preflight: boolean;
  ready_to_publish: boolean;
  freshness_operations: {
    state: "current" | "renewal_due" | "restoration_required" | "service_unavailable" | "unknown";
    reason_code:
      | "SNAPSHOT_FRESH"
      | "SNAPSHOT_EXPIRING_SOON"
      | "SNAPSHOT_NOT_PUBLISHED"
      | "SNAPSHOT_EXPIRED"
      | "REMOTE_UNREACHABLE"
      | "REMOTE_NOT_READY"
      | "SNAPSHOT_STATUS_UNKNOWN"
      | "LOCAL_PUBLISHER_NOT_CONFIGURED";
    renewal_recommended: boolean;
    recommended_action: "none" | "preflight_and_renew" | "check_remote" | "configure_publisher";
    renewal_threshold_seconds: number;
  };
  remote: {
    reachable: boolean;
    ready: boolean;
    health_http_status: number | null;
    readiness_http_status: number | null;
    service_version: string | null;
    checks: {
      oauth: boolean | null;
      publisher_key: boolean | null;
      snapshot_fresh: boolean | null;
      authorization_projection: boolean | null;
    };
    snapshot: PersonalReadonlySnapshotStatus;
  };
  last_publish: ReadonlyPublisherReceipt | null;
  last_receipt_state: "none" | "valid" | "invalid";
}

export interface PersonalReadonlyPreflightResult {
  result: "PASS";
  snapshot_fingerprint: string;
  generated_at: string;
  expires_at: string;
}

export interface PersonalReadonlyPublishResult extends PersonalReadonlyPreflightResult {
  http_status: number;
}

interface StatusFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface PersonalReadonlyOperationsDependencies {
  publisher?: PublisherDependencies;
  status_fetch_impl?: (url: string, init: RequestInit) => Promise<StatusFetchResponse>;
  assert_paths_ignored?: (profilePath: string, profile: ReadonlyPublisherProfile) => void;
  now?: () => Date;
}

export interface PersonalReadonlyOperationsService {
  status(): Promise<PersonalReadonlyOperationsStatus>;
  preflight(): Promise<PersonalReadonlyPreflightResult>;
  publish(): Promise<PersonalReadonlyPublishResult>;
}

export class PersonalReadonlyOperationsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const emptySnapshotStatus = (): PersonalReadonlySnapshotStatus => ({
  freshness_status: "unknown",
  generated_at: null,
  expires_at: null,
  age_seconds: null,
  ttl_remaining_seconds: null,
  snapshot_fingerprint: null
});

const emptyRemoteStatus = (): PersonalReadonlyOperationsStatus["remote"] => ({
  reachable: false,
  ready: false,
  health_http_status: null,
  readiness_http_status: null,
  service_version: null,
  checks: { oauth: null, publisher_key: null, snapshot_fresh: null, authorization_projection: null },
  snapshot: emptySnapshotStatus()
});

function deriveFreshnessOperations(
  remote: PersonalReadonlyOperationsStatus["remote"]
): PersonalReadonlyOperationsStatus["freshness_operations"] {
  const base = { renewal_threshold_seconds: READONLY_SNAPSHOT_RENEWAL_THRESHOLD_SECONDS } as const;
  if (!remote.reachable) {
    return { ...base, state: "service_unavailable", reason_code: "REMOTE_UNREACHABLE", renewal_recommended: false, recommended_action: "check_remote" };
  }
  if (remote.snapshot.freshness_status === "no_snapshot") {
    return { ...base, state: "restoration_required", reason_code: "SNAPSHOT_NOT_PUBLISHED", renewal_recommended: true, recommended_action: "preflight_and_renew" };
  }
  if (remote.snapshot.freshness_status === "snapshot_expired") {
    return { ...base, state: "restoration_required", reason_code: "SNAPSHOT_EXPIRED", renewal_recommended: true, recommended_action: "preflight_and_renew" };
  }
  if (remote.snapshot.freshness_status !== "fresh" || remote.snapshot.ttl_remaining_seconds === null) {
    return { ...base, state: "unknown", reason_code: "SNAPSHOT_STATUS_UNKNOWN", renewal_recommended: false, recommended_action: "check_remote" };
  }
  if (!remote.ready) {
    return { ...base, state: "service_unavailable", reason_code: "REMOTE_NOT_READY", renewal_recommended: false, recommended_action: "check_remote" };
  }
  if (remote.snapshot.ttl_remaining_seconds <= READONLY_SNAPSHOT_RENEWAL_THRESHOLD_SECONDS) {
    return { ...base, state: "renewal_due", reason_code: "SNAPSHOT_EXPIRING_SOON", renewal_recommended: true, recommended_action: "preflight_and_renew" };
  }
  return { ...base, state: "current", reason_code: "SNAPSHOT_FRESH", renewal_recommended: false, recommended_action: "none" };
}

const unconfiguredFreshnessOperations = (): PersonalReadonlyOperationsStatus["freshness_operations"] => ({
  state: "unknown",
  reason_code: "LOCAL_PUBLISHER_NOT_CONFIGURED",
  renewal_recommended: false,
  recommended_action: "configure_publisher",
  renewal_threshold_seconds: READONLY_SNAPSHOT_RENEWAL_THRESHOLD_SECONDS
});

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).isFile();
  } catch {
    return false;
  }
}

function loadProfile(
  profilePath: string,
  assertPathsIgnored: (path: string, profile: ReadonlyPublisherProfile) => void
): ReadonlyPublisherProfile {
  if (!isRegularFile(profilePath)) throw new PersonalReadonlyOperationsError("READONLY_PUBLISHER_PROFILE_NOT_CONFIGURED");
  try {
    const profile = loadReadonlyPublisherProfile(profilePath);
    assertPathsIgnored(profilePath, profile);
    return profile;
  } catch (error) {
    const code = error instanceof ReadonlyPublisherError ? error.code : "READONLY_PUBLISHER_PROFILE_INVALID";
    throw new PersonalReadonlyOperationsError(code);
  }
}

function readLatestReceipt(profile: ReadonlyPublisherProfile): {
  receipt: ReadonlyPublisherReceipt | null;
  state: PersonalReadonlyOperationsStatus["last_receipt_state"];
} {
  try {
    if (!existsSync(profile.receipts_directory) || lstatSync(profile.receipts_directory).isSymbolicLink()) return { receipt: null, state: "none" };
    const names = readdirSync(profile.receipts_directory)
      .filter((name) => /^readonly-publish-[0-9TZ.-]+-[0-9a-f-]+\.json$/i.test(name))
      .sort()
      .reverse();
    if (names.length === 0) return { receipt: null, state: "none" };
    const target = join(profile.receipts_directory, names[0]!);
    if (!isRegularFile(target) || statSync(target).size > 64 * 1024) return { receipt: null, state: "invalid" };
    return { receipt: READONLY_PUBLISHER_RECEIPT_SCHEMA.parse(JSON.parse(readFileSync(target, "utf8"))), state: "valid" };
  } catch {
    return { receipt: null, state: "invalid" };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function safeJson(response: StatusFetchResponse): Promise<Record<string, unknown> | null> {
  const value = await response.text();
  if (Buffer.byteLength(value, "utf8") > 64 * 1024) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

async function fetchRemoteStatus(
  profile: ReadonlyPublisherProfile,
  fetchImpl: (url: string, init: RequestInit) => Promise<StatusFetchResponse>
): Promise<PersonalReadonlyOperationsStatus["remote"]> {
  const remote = emptyRemoteStatus();
  const origin = new URL(profile.resource_url).origin;
  const request = (path: string) => fetchImpl(`${origin}${path}`, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json" }
  });
  try {
    const health = await request("/healthz");
    remote.health_http_status = health.status;
    remote.reachable = health.status === 200;
    await safeJson(health);
  } catch {
    return remote;
  }
  try {
    const readiness = await request("/readyz");
    remote.readiness_http_status = readiness.status;
    const payload = await safeJson(readiness);
    const checks = record(payload?.checks);
    const snapshot = record(payload?.snapshot);
    remote.ready = readiness.status === 200 && payload?.ok === true;
    remote.service_version = stringOrNull(payload?.version);
    remote.checks = {
      oauth: booleanOrNull(checks?.oauth),
      publisher_key: booleanOrNull(checks?.publisher_key),
      snapshot_fresh: booleanOrNull(checks?.snapshot_fresh),
      authorization_projection: booleanOrNull(checks?.authorization_projection)
    };
    const freshness = snapshot?.freshness_status;
    remote.snapshot = {
      freshness_status: freshness === "no_snapshot" || freshness === "fresh" || freshness === "snapshot_expired" ? freshness : "unknown",
      generated_at: stringOrNull(snapshot?.generated_at),
      expires_at: stringOrNull(snapshot?.expires_at),
      age_seconds: numberOrNull(snapshot?.age_seconds),
      ttl_remaining_seconds: numberOrNull(snapshot?.ttl_remaining_seconds),
      snapshot_fingerprint: typeof snapshot?.snapshot_fingerprint === "string" && /^[0-9a-f]{64}$/.test(snapshot.snapshot_fingerprint)
        ? snapshot.snapshot_fingerprint
        : null
    };
  } catch {
    // A reachable service with an unavailable readiness response remains explicitly not ready.
  }
  return remote;
}

function publisherError(error: unknown): PersonalReadonlyOperationsError {
  if (error instanceof PersonalReadonlyOperationsError) return error;
  if (error instanceof ReadonlyPublisherError) return new PersonalReadonlyOperationsError(error.code);
  return new PersonalReadonlyOperationsError("READONLY_PERSONAL_OPERATIONS_FAILED");
}

export function createPersonalReadonlyOperationsService(
  profilePath = DEFAULT_READONLY_PUBLISHER_PROFILE_PATH,
  dependencies: PersonalReadonlyOperationsDependencies = {}
): PersonalReadonlyOperationsService {
  const now = dependencies.now ?? (() => new Date());
  const assertPathsIgnored = dependencies.assert_paths_ignored ?? assertReadonlyPublisherPathsIgnored;
  const statusFetch = dependencies.status_fetch_impl ?? (async (url, init) => fetch(url, init));
  let operationInProgress = false;

  const configuredProfile = () => loadProfile(profilePath, assertPathsIgnored);
  const runExclusive = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (operationInProgress) throw new PersonalReadonlyOperationsError("READONLY_PUBLISH_OPERATION_IN_PROGRESS");
    operationInProgress = true;
    try {
      return await operation();
    } catch (error) {
      throw publisherError(error);
    } finally {
      operationInProgress = false;
    }
  };

  return {
    status: async () => {
      const checkedAt = now().toISOString();
      let profile: ReadonlyPublisherProfile;
      try {
        profile = configuredProfile();
      } catch (error) {
        const code = publisherError(error).code;
        return {
          operations_version: PERSONAL_READONLY_OPERATIONS_VERSION,
          checked_at: checkedAt,
          configuration: code === "READONLY_PUBLISHER_PROFILE_NOT_CONFIGURED" ? "missing" : "invalid",
          stable_error_code: code,
          database_available: false,
          publisher_key_available: false,
          ready_to_preflight: false,
          ready_to_publish: false,
          freshness_operations: unconfiguredFreshnessOperations(),
          remote: emptyRemoteStatus(),
          last_publish: null,
          last_receipt_state: "none"
        };
      }
      const databaseAvailable = isRegularFile(profile.database_path);
      const publisherKeyAvailable = isRegularFile(profile.protected_private_key_path) && isRegularFile(profile.public_key_path);
      const last = readLatestReceipt(profile);
      const remote = await fetchRemoteStatus(profile, statusFetch);
      return {
        operations_version: PERSONAL_READONLY_OPERATIONS_VERSION,
        checked_at: checkedAt,
        configuration: "ready",
        stable_error_code: null,
        database_available: databaseAvailable,
        publisher_key_available: publisherKeyAvailable,
        ready_to_preflight: databaseAvailable && publisherKeyAvailable,
        ready_to_publish: databaseAvailable && publisherKeyAvailable && !operationInProgress,
        freshness_operations: deriveFreshnessOperations(remote),
        remote,
        last_publish: last.receipt,
        last_receipt_state: last.state
      };
    },
    preflight: () => runExclusive(() => {
      const prepared = preflightReadonlyPublisher(configuredProfile(), dependencies.publisher);
      return {
        result: "PASS",
        snapshot_fingerprint: prepared.snapshot.snapshot_fingerprint,
        generated_at: prepared.snapshot.generated_at,
        expires_at: prepared.snapshot.expires_at
      };
    }),
    publish: () => runExclusive(async () => {
      const result = await publishReadonlySnapshot(configuredProfile(), dependencies.publisher);
      if (result.receipt.result !== "PASS" || result.receipt.http_status !== 202 || !result.receipt.snapshot_fingerprint || !result.receipt.generated_at || !result.receipt.expires_at) {
        throw new PersonalReadonlyOperationsError("READONLY_PUBLISH_RECEIPT_INVALID");
      }
      return {
        result: "PASS",
        http_status: result.receipt.http_status,
        snapshot_fingerprint: result.receipt.snapshot_fingerprint,
        generated_at: result.receipt.generated_at,
        expires_at: result.receipt.expires_at
      };
    })
  };
}
