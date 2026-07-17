import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { z } from "zod/v4";

import { issuerHash } from "../webgpt-v4/types.js";
import { exportReadonlySnapshotFromDatabase } from "./dataSource.js";
import { signReadonlySnapshot, type ReadonlySignedSnapshot, type ReadonlySigningPrivateKey } from "./signedSnapshot.js";
import type { ReadonlySnapshot } from "./snapshot.js";

const httpsUrl = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}, "Expected a credential-free HTTPS URL.");

export const READONLY_PUBLISHER_PROFILE_SCHEMA = z.object({
  profile_version: z.literal("readonly-publisher-profile-v1"),
  database_path: z.string().min(1),
  issuer: httpsUrl,
  resource_url: httpsUrl,
  snapshot_url: httpsUrl,
  key_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  protected_private_key_path: z.string().min(1),
  public_key_path: z.string().min(1),
  receipts_directory: z.string().min(1),
  ttl_seconds: z.number().int().min(1).max(86400).default(86400)
}).strict().superRefine((value, context) => {
  const resource = new URL(value.resource_url);
  const snapshot = new URL(value.snapshot_url);
  if (resource.pathname !== "/mcp") {
    context.addIssue({ code: "custom", path: ["resource_url"], message: "Resource URL must use the exact /mcp path." });
  }
  if (resource.origin !== snapshot.origin || snapshot.pathname !== "/snapshot") {
    context.addIssue({ code: "custom", path: ["snapshot_url"], message: "Snapshot URL must be /snapshot on the MCP resource origin." });
  }
});

export type ReadonlyPublisherProfile = z.infer<typeof READONLY_PUBLISHER_PROFILE_SCHEMA>;

export const READONLY_PUBLISHER_RECEIPT_SCHEMA = z.object({
  receipt_version: z.literal("readonly-publisher-receipt-v1"),
  timestamp: z.iso.datetime(),
  result: z.enum(["PASS", "FAIL"]),
  stable_error_code: z.string().nullable(),
  http_status: z.number().int().min(100).max(599).nullable(),
  key_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  snapshot_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  generated_at: z.iso.datetime().nullable(),
  expires_at: z.iso.datetime().nullable()
}).strict().superRefine((value, context) => {
  if (value.result === "PASS" && (value.stable_error_code !== null || value.http_status !== 202 || !value.snapshot_fingerprint || !value.generated_at || !value.expires_at)) {
    context.addIssue({ code: "custom", message: "A successful publisher receipt must describe one accepted Snapshot." });
  }
  if (value.result === "FAIL" && !value.stable_error_code) {
    context.addIssue({ code: "custom", message: "A failed publisher receipt must include a stable error code." });
  }
});

export type ReadonlyPublisherReceipt = z.infer<typeof READONLY_PUBLISHER_RECEIPT_SCHEMA>;

export interface ReadonlyDpapi {
  protect(value: Buffer): Buffer;
  unprotect(value: Buffer): Buffer;
}

export interface PublisherDependencies {
  dpapi?: ReadonlyDpapi;
  export_snapshot?: (input: {
    database_path: string;
    issuer_hash: string;
    resource_url: string;
    generated_at?: string;
    ttl_seconds?: number;
  }) => ReadonlySnapshot;
  fetch_impl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  now?: () => Date;
}

export class ReadonlyPublisherError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runDpapi(operation: "Protect" | "Unprotect", value: Buffer): Buffer {
  if (process.platform !== "win32") throw new ReadonlyPublisherError("READONLY_PUBLISHER_DPAPI_UNAVAILABLE");
  const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;` +
    `$inputValue=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($inputValue);` +
    `$result=[System.Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Console]::Out.Write([Convert]::ToBase64String($result));`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)], {
    input: value.toString("base64"), encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024
  });
  if (result.status !== 0 || typeof result.stdout !== "string") throw new ReadonlyPublisherError("READONLY_PUBLISHER_DPAPI_FAILED");
  const output = result.stdout.trim();
  if (!output || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output)) {
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_DPAPI_FAILED");
  }
  const decoded = Buffer.from(output, "base64");
  if (decoded.length === 0) throw new ReadonlyPublisherError("READONLY_PUBLISHER_DPAPI_FAILED");
  return decoded;
}

export const currentUserDpapi: ReadonlyDpapi = {
  protect: (value) => runDpapi("Protect", value),
  unprotect: (value) => runDpapi("Unprotect", value)
};

export function parseReadonlyPublisherProfile(input: unknown): ReadonlyPublisherProfile {
  try {
    return READONLY_PUBLISHER_PROFILE_SCHEMA.parse(input);
  } catch {
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_PROFILE_INVALID");
  }
}

export function loadReadonlyPublisherProfile(path: string): ReadonlyPublisherProfile {
  try {
    return parseReadonlyPublisherProfile(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof ReadonlyPublisherError) throw error;
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_PROFILE_INVALID");
  }
}

export function assertReadonlyPublisherPathsIgnored(
  profilePath: string,
  profile: ReadonlyPublisherProfile,
  isIgnored: (path: string) => boolean = (path) => spawnSync(
    "git", ["check-ignore", "--quiet", "--no-index", "--", path], { windowsHide: true }
  ).status === 0,
  isTracked: (path: string) => boolean = (path) => spawnSync(
    "git", ["ls-files", "--error-unmatch", "--", path], { windowsHide: true }
  ).status === 0
): void {
  const paths = [profilePath, profile.protected_private_key_path, profile.public_key_path, profile.receipts_directory];
  if (paths.some((path) => isTracked(path) || !isIgnored(path))) throw new ReadonlyPublisherError("READONLY_PUBLISHER_PATH_NOT_IGNORED");
}

function privateKeyFromProfile(profile: ReadonlyPublisherProfile, dpapi: ReadonlyDpapi): ReadonlySigningPrivateKey {
  let privatePem: Buffer | null = null;
  try {
    const protectedValue = readFileSync(profile.protected_private_key_path);
    privatePem = dpapi.unprotect(protectedValue);
    const key = createPrivateKey(privatePem);
    const expectedPublic = createPublicKey(readFileSync(profile.public_key_path));
    const actualDer = createPublicKey(key).export({ type: "spki", format: "der" });
    const expectedDer = expectedPublic.export({ type: "spki", format: "der" });
    if (!Buffer.from(actualDer).equals(Buffer.from(expectedDer)) || key.asymmetricKeyType !== "ed25519") {
      throw new Error("key mismatch");
    }
    return key;
  } catch {
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_KEY_INVALID");
  } finally {
    privatePem?.fill(0);
  }
}

export function createReadonlyPublisherKey(profile: ReadonlyPublisherProfile, dpapi: ReadonlyDpapi = currentUserDpapi): { key_id: string; public_key_sha256: string } {
  if (existsSync(profile.protected_private_key_path) || existsSync(profile.public_key_path)) {
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_KEY_ALREADY_EXISTS");
  }
  mkdirSync(dirname(profile.protected_private_key_path), { recursive: true });
  mkdirSync(dirname(profile.public_key_path), { recursive: true });
  const pair = generateKeyPairSync("ed25519");
  const privatePem = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const publicPem = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" }));
  let protectedValue: Buffer;
  try {
    protectedValue = dpapi.protect(privatePem);
  } finally {
    privatePem.fill(0);
  }
  let privateCreated = false;
  let publicCreated = false;
  try {
    writeFileSync(profile.protected_private_key_path, protectedValue, { flag: "wx", mode: 0o600 });
    privateCreated = true;
    writeFileSync(profile.public_key_path, publicPem, { flag: "wx", mode: 0o644 });
    publicCreated = true;
  } catch {
    if (privateCreated) try { unlinkSync(profile.protected_private_key_path); } catch { /* remove only this attempt's file */ }
    if (publicCreated) try { unlinkSync(profile.public_key_path); } catch { /* remove only this attempt's file */ }
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_KEY_WRITE_FAILED");
  } finally {
    protectedValue.fill(0);
  }
  return {
    key_id: profile.key_id,
    public_key_sha256: createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("hex")
  };
}

export function preflightReadonlyPublisher(profile: ReadonlyPublisherProfile, dependencies: PublisherDependencies = {}): { snapshot: ReadonlySnapshot; envelope: ReadonlySignedSnapshot } {
  const dpapi = dependencies.dpapi ?? currentUserDpapi;
  const exportSnapshot = dependencies.export_snapshot ?? exportReadonlySnapshotFromDatabase;
  const now = dependencies.now?.() ?? new Date();
  const snapshot = exportSnapshot({
    database_path: profile.database_path,
    issuer_hash: issuerHash(profile.issuer),
    resource_url: profile.resource_url,
    generated_at: now.toISOString(),
    ttl_seconds: profile.ttl_seconds
  });
  const envelope = signReadonlySnapshot(snapshot, profile.key_id, privateKeyFromProfile(profile, dpapi), now);
  return { snapshot, envelope };
}

function writeReceipt(directory: string, receipt: ReadonlyPublisherReceipt): string {
  mkdirSync(directory, { recursive: true });
  const stamp = receipt.timestamp.replaceAll(":", "-");
  const name = `readonly-publish-${stamp}-${randomUUID()}.json`;
  const target = join(directory, name);
  const temporary = join(directory, `.${basename(name)}.tmp`);
  try {
    const validated = READONLY_PUBLISHER_RECEIPT_SCHEMA.parse(receipt);
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    return target;
  } catch {
    try { unlinkSync(temporary); } catch { /* owned temporary may not exist */ }
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_RECEIPT_WRITE_FAILED");
  }
}

export async function publishReadonlySnapshot(profile: ReadonlyPublisherProfile, dependencies: PublisherDependencies = {}): Promise<{ receipt: ReadonlyPublisherReceipt; receipt_path: string }> {
  const now = dependencies.now?.() ?? new Date();
  let snapshot: ReadonlySnapshot | null = null;
  let status: number | null = null;
  let code: string | null = null;
  try {
    const prepared = preflightReadonlyPublisher(profile, dependencies);
    snapshot = prepared.snapshot;
    const fetchImpl = dependencies.fetch_impl ?? (async (url, init) => fetch(url, init));
    const response = await fetchImpl(profile.snapshot_url, {
      method: "PUT",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prepared.envelope)
    });
    status = response.status;
    if (!response.ok || response.status !== 202) throw new ReadonlyPublisherError("READONLY_PUBLISHER_REMOTE_REJECTED");
  } catch (error) {
    code = error instanceof ReadonlyPublisherError ? error.code : "READONLY_PUBLISHER_FAILED";
  }
  const receipt: ReadonlyPublisherReceipt = {
    receipt_version: "readonly-publisher-receipt-v1",
    timestamp: now.toISOString(),
    result: code ? "FAIL" : "PASS",
    stable_error_code: code,
    http_status: status,
    key_id: profile.key_id,
    snapshot_fingerprint: snapshot?.snapshot_fingerprint ?? null,
    generated_at: snapshot?.generated_at ?? null,
    expires_at: snapshot?.expires_at ?? null
  };
  const receiptPath = writeReceipt(profile.receipts_directory, receipt);
  if (code) throw new ReadonlyPublisherError(code);
  return { receipt, receipt_path: receiptPath };
}
