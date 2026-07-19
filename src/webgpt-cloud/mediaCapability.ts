import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod/v4";

export const READONLY_MEDIA_CAPABILITY_VERSION = "readonly-media-capability-v1";
export const READONLY_MEDIA_CAPABILITY_PATH = "/internal/v1/capabilities";
export const READONLY_MEDIA_CAPABILITY_TTL_MS = 5 * 60 * 1000;
export const READONLY_MEDIA_CAPABILITY_CLOCK_SKEW_MS = 30 * 1000;
export const READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES = 4 * 1024;
export const READONLY_MEDIA_CAPABILITY_REPLAY_WINDOW_MS = 10 * 60 * 1000;
export const READONLY_MEDIA_CAPABILITY_MAX_REPLAY_RECORDS = 256;
export const READONLY_MEDIA_CAPABILITY_MAX_REPLAY_RECORDS_PER_PRINCIPAL = 32;
export const READONLY_MEDIA_PREVIOUS_KEY_MAX_ACCEPTANCE_MS = 10 * 60 * 1000;
export const READONLY_MEDIA_SESSION_MAX_SECONDS = 30 * 60;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "Expected a canonical UTC ISO instant.");

export const READONLY_MEDIA_CAPABILITY_PAYLOAD_SCHEMA = z.object({
  version: z.literal(READONLY_MEDIA_CAPABILITY_VERSION),
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  principal_id: sha256Schema,
  issuer_hash: sha256Schema,
  project_id: z.string().min(1).max(200),
  artifact_id: z.string().min(1).max(200),
  artifact_sha256: sha256Schema,
  snapshot_fingerprint: sha256Schema,
  issued_at: canonicalInstantSchema,
  expires_at: canonicalInstantSchema,
  nonce: base64UrlSchema.length(43)
}).strict();

export const READONLY_MEDIA_CAPABILITY_ENVELOPE_SCHEMA = z.object({
  version: z.literal(READONLY_MEDIA_CAPABILITY_VERSION),
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  iv: base64UrlSchema.length(16),
  ciphertext: base64UrlSchema.min(1),
  tag: base64UrlSchema.length(22)
}).strict();

export const READONLY_MEDIA_CAPABILITY_RESPONSE_SCHEMA = z.object({
  capability_handle: base64UrlSchema.length(43),
  expires_at: canonicalInstantSchema
}).strict();

export type ReadonlyMediaCapabilityPayload = z.infer<typeof READONLY_MEDIA_CAPABILITY_PAYLOAD_SCHEMA>;
export type ReadonlyMediaCapabilityEnvelope = z.infer<typeof READONLY_MEDIA_CAPABILITY_ENVELOPE_SCHEMA>;
export type ReadonlyMediaCapabilityResponse = z.infer<typeof READONLY_MEDIA_CAPABILITY_RESPONSE_SCHEMA>;

export interface ReadonlyMediaCapabilityKey {
  kid: string;
  key: Uint8Array;
}

export interface ReadonlyMediaCapabilityKeyring {
  active: ReadonlyMediaCapabilityKey;
  previous?: ReadonlyMediaCapabilityKey & {
    accepted_from: string;
    accepted_until: string;
  };
}

export class ReadonlyMediaCapabilityError extends Error {
  constructor(readonly code: string, message = "Readonly media capability is invalid.") {
    super(message);
  }
}

function normalizedKey(value: ReadonlyMediaCapabilityKey): Buffer {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value.kid) || value.key.byteLength !== 32) {
    throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_INVALID");
  }
  return Buffer.from(value.key);
}

function validatePreviousKeyWindow(previous: NonNullable<ReadonlyMediaCapabilityKeyring["previous"]>): { acceptedFrom: number; acceptedUntil: number } {
  const acceptedFrom = Date.parse(previous.accepted_from);
  const acceptedUntil = Date.parse(previous.accepted_until);
  if (!Number.isFinite(acceptedFrom)
    || !Number.isFinite(acceptedUntil)
    || new Date(acceptedFrom).toISOString() !== previous.accepted_from
    || new Date(acceptedUntil).toISOString() !== previous.accepted_until
    || acceptedUntil <= acceptedFrom
    || acceptedUntil - acceptedFrom > READONLY_MEDIA_PREVIOUS_KEY_MAX_ACCEPTANCE_MS) {
    throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_INVALID");
  }
  return { acceptedFrom, acceptedUntil };
}

export function assertReadonlyMediaCapabilityKeyring(keyring: ReadonlyMediaCapabilityKeyring): void {
  normalizedKey(keyring.active);
  if (!keyring.previous) return;
  normalizedKey(keyring.previous);
  if (keyring.previous.kid === keyring.active.kid) throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_INVALID");
  validatePreviousKeyWindow(keyring.previous);
}

function capabilityAad(): Buffer {
  return Buffer.from(`${READONLY_MEDIA_CAPABILITY_VERSION}\nPOST\n${READONLY_MEDIA_CAPABILITY_PATH}`, "utf8");
}

function keyForKid(keyring: ReadonlyMediaCapabilityKeyring, kid: string, now: Date): ReadonlyMediaCapabilityKey {
  if (keyring.active.kid === kid) return keyring.active;
  const previous = keyring.previous;
  if (!previous || previous.kid !== kid) throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_UNKNOWN");
  const { acceptedFrom, acceptedUntil } = validatePreviousKeyWindow(previous);
  if (now.getTime() < acceptedFrom || now.getTime() >= acceptedUntil) {
    throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_UNKNOWN");
  }
  return previous;
}

export function parseReadonlyMediaCapabilityKey(kid: string, encoded: string): ReadonlyMediaCapabilityKey {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_INVALID");
  const value = { kid, key: Buffer.from(encoded, "base64url") };
  normalizedKey(value);
  return value;
}

export function createReadonlyMediaCapabilityRequest(
  input: Omit<ReadonlyMediaCapabilityPayload, "version" | "kid" | "issued_at" | "expires_at" | "nonce">,
  keyring: ReadonlyMediaCapabilityKeyring,
  options: { now?: () => Date; random_bytes?: (size: number) => Buffer } = {}
): ReadonlyMediaCapabilityEnvelope {
  const key = normalizedKey(keyring.active);
  const now = options.now?.() ?? new Date();
  const random = options.random_bytes ?? randomBytes;
  const payload = READONLY_MEDIA_CAPABILITY_PAYLOAD_SCHEMA.parse({
    ...input,
    version: READONLY_MEDIA_CAPABILITY_VERSION,
    kid: keyring.active.kid,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + READONLY_MEDIA_CAPABILITY_TTL_MS).toISOString(),
    nonce: random(32).toString("base64url")
  });
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(capabilityAad());
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return READONLY_MEDIA_CAPABILITY_ENVELOPE_SCHEMA.parse({
    version: READONLY_MEDIA_CAPABILITY_VERSION,
    kid: keyring.active.kid,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  });
}

export function openReadonlyMediaCapabilityRequest(
  input: unknown,
  keyring: ReadonlyMediaCapabilityKeyring,
  options: { now?: () => Date } = {}
): ReadonlyMediaCapabilityPayload {
  try {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES) {
      throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_INVALID");
    }
    const envelope = READONLY_MEDIA_CAPABILITY_ENVELOPE_SCHEMA.parse(input);
    const current = options.now?.() ?? new Date();
    const selected = keyForKid(keyring, envelope.kid, current);
    const decipher = createDecipheriv("aes-256-gcm", normalizedKey(selected), Buffer.from(envelope.iv, "base64url"), { authTagLength: 16 });
    decipher.setAAD(capabilityAad());
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final()
    ]);
    if (plaintext.byteLength > READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES) {
      throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_RESPONSE_TOO_LARGE");
    }
    const payload = READONLY_MEDIA_CAPABILITY_PAYLOAD_SCHEMA.parse(JSON.parse(plaintext.toString("utf8")) as unknown);
    if (payload.kid !== envelope.kid) throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_MISMATCH");
    const issuedAt = Date.parse(payload.issued_at);
    const expiresAt = Date.parse(payload.expires_at);
    const now = current.getTime();
    if (keyring.previous?.kid === payload.kid
      && issuedAt > Date.parse(keyring.previous.accepted_from) + READONLY_MEDIA_CAPABILITY_CLOCK_SKEW_MS) {
      throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_KEY_UNKNOWN");
    }
    if (expiresAt <= issuedAt || expiresAt - issuedAt !== READONLY_MEDIA_CAPABILITY_TTL_MS) {
      throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_TTL_INVALID");
    }
    if (issuedAt > now + READONLY_MEDIA_CAPABILITY_CLOCK_SKEW_MS || expiresAt <= now - READONLY_MEDIA_CAPABILITY_CLOCK_SKEW_MS) {
      throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_EXPIRED");
    }
    return payload;
  } catch (error) {
    if (error instanceof ReadonlyMediaCapabilityError) throw error;
    throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_INVALID");
  }
}

export class ReadonlyMediaCapabilityReplayGuard {
  private readonly seen = new Map<string, { expires_at_ms: number; principal_id: string }>();

  constructor(
    readonly maximumRecords = READONLY_MEDIA_CAPABILITY_MAX_REPLAY_RECORDS,
    readonly maximumRecordsPerPrincipal = READONLY_MEDIA_CAPABILITY_MAX_REPLAY_RECORDS_PER_PRINCIPAL
  ) {
    if (!Number.isInteger(maximumRecords) || maximumRecords <= 0
      || !Number.isInteger(maximumRecordsPerPrincipal) || maximumRecordsPerPrincipal <= 0
      || maximumRecordsPerPrincipal > maximumRecords) {
      throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_REPLAY_GUARD_INVALID");
    }
  }

  private sweep(current: number): void {
    for (const [nonce, record] of this.seen) if (record.expires_at_ms <= current) this.seen.delete(nonce);
  }

  accept(payload: ReadonlyMediaCapabilityPayload, now = new Date()): void {
    const current = now.getTime();
    this.sweep(current);
    if (this.seen.has(payload.nonce)) throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_REPLAYED");
    const principalRecords = [...this.seen.values()].filter((record) => record.principal_id === payload.principal_id).length;
    if (this.seen.size >= this.maximumRecords || principalRecords >= this.maximumRecordsPerPrincipal) {
      throw new ReadonlyMediaCapabilityError("MEDIA_CAPABILITY_REPLAY_CAPACITY_EXCEEDED");
    }
    this.seen.set(payload.nonce, {
      expires_at_ms: Date.parse(payload.issued_at) + READONLY_MEDIA_CAPABILITY_REPLAY_WINDOW_MS,
      principal_id: payload.principal_id
    });
  }

  size(now = new Date()): number {
    const current = now.getTime();
    this.sweep(current);
    return this.seen.size;
  }
}

export function createReadonlyMediaHandle(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}
