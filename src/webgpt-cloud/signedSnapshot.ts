import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";

import { z } from "zod/v4";

import {
  canonicalizeJcs,
  parseReadonlySnapshot,
  readonlySnapshotStatus,
  READONLY_SNAPSHOT_SCHEMA,
  type ReadonlySnapshot
} from "./snapshot.js";

export const READONLY_SIGNED_SNAPSHOT_VERSION = "readonly-snapshot-envelope-v1";
export const READONLY_SIGNED_SNAPSHOT_ALGORITHM = "Ed25519";

const keyIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

export const READONLY_SIGNED_SNAPSHOT_SCHEMA = z.object({
  envelope_version: z.literal(READONLY_SIGNED_SNAPSHOT_VERSION),
  algorithm: z.literal(READONLY_SIGNED_SNAPSHOT_ALGORITHM),
  key_id: keyIdSchema,
  snapshot: READONLY_SNAPSHOT_SCHEMA,
  signature: signatureSchema
}).strict();

export type ReadonlySignedSnapshot = z.infer<typeof READONLY_SIGNED_SNAPSHOT_SCHEMA>;
export type ReadonlySigningPrivateKey = KeyObject | string | Buffer;
export type ReadonlySigningPublicKey = KeyObject | string | Buffer;

function privateKey(value: ReadonlySigningPrivateKey): KeyObject {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  if (key.type !== "private") throw new Error("READONLY_SNAPSHOT_SIGNING_KEY_INVALID");
  return key;
}

function publicKey(value: ReadonlySigningPublicKey): KeyObject {
  const key = value instanceof KeyObject ? value : createPublicKey(value);
  if (key.type !== "public") throw new Error("READONLY_SNAPSHOT_VERIFICATION_KEY_INVALID");
  return key;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

function signaturePayload(snapshot: ReadonlySnapshot): Buffer {
  return Buffer.from(`readonly-snapshot-signature-v1\n${canonicalizeJcs(snapshot)}`, "utf8");
}

export function signReadonlySnapshot(
  snapshotInput: ReadonlySnapshot,
  keyId: string,
  signingKey: ReadonlySigningPrivateKey,
  now = new Date()
): ReadonlySignedSnapshot {
  const snapshot = parseReadonlySnapshot(snapshotInput, now);
  if (readonlySnapshotStatus(snapshot, now).freshness_status !== "fresh") throw new Error("READONLY_SNAPSHOT_EXPIRED");
  const parsedKeyId = keyIdSchema.parse(keyId);
  const key = privateKey(signingKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("READONLY_SNAPSHOT_SIGNING_KEY_INVALID");
  return READONLY_SIGNED_SNAPSHOT_SCHEMA.parse({
    envelope_version: READONLY_SIGNED_SNAPSHOT_VERSION,
    algorithm: READONLY_SIGNED_SNAPSHOT_ALGORITHM,
    key_id: parsedKeyId,
    snapshot,
    signature: sign(null, signaturePayload(snapshot), key).toString("base64url")
  });
}

export function verifyReadonlySignedSnapshot(
  input: unknown,
  expectedKeyId: string,
  verificationKey: ReadonlySigningPublicKey,
  now = new Date()
): ReadonlySnapshot {
  const envelope = READONLY_SIGNED_SNAPSHOT_SCHEMA.parse(input);
  if (envelope.key_id !== expectedKeyId) throw new Error("READONLY_SNAPSHOT_SIGNING_KEY_UNKNOWN");
  const snapshot = parseReadonlySnapshot(envelope.snapshot, now);
  if (readonlySnapshotStatus(snapshot, now).freshness_status !== "fresh") throw new Error("READONLY_SNAPSHOT_EXPIRED");
  const key = publicKey(verificationKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("READONLY_SNAPSHOT_VERIFICATION_KEY_INVALID");
  const signature = Buffer.from(envelope.signature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== envelope.signature || !verify(null, signaturePayload(snapshot), key, signature)) {
    throw new Error("READONLY_SNAPSHOT_SIGNATURE_INVALID");
  }
  return snapshot;
}

export class ReadonlySnapshotStore {
  private current: ReadonlySnapshot | null = null;

  constructor(
    readonly key_id: string,
    private readonly verification_key: ReadonlySigningPublicKey,
    private readonly now: () => Date = () => new Date(),
    private readonly expected?: { resource_url: string; issuer_hash: string }
  ) {
    keyIdSchema.parse(key_id);
    const key = publicKey(verification_key);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("READONLY_SNAPSHOT_VERIFICATION_KEY_INVALID");
  }

  read(): ReadonlySnapshot | null {
    return this.current;
  }

  replace(input: unknown): ReadonlySnapshot {
    const next = verifyReadonlySignedSnapshot(input, this.key_id, this.verification_key, this.now());
    if (this.expected && next.resource_url !== this.expected.resource_url) throw new Error("READONLY_SNAPSHOT_RESOURCE_MISMATCH");
    if (this.expected && next.issuer_hash !== this.expected.issuer_hash) throw new Error("READONLY_SNAPSHOT_ISSUER_MISMATCH");
    if (this.current?.snapshot_fingerprint === next.snapshot_fingerprint) return this.current;
    if (this.current && Date.parse(next.generated_at) <= Date.parse(this.current.generated_at)) {
      throw new Error("READONLY_SNAPSHOT_NOT_NEWER");
    }
    this.current = deepFreeze(next);
    return this.current;
  }
}
