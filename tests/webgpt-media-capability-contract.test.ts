import assert from "node:assert/strict";
import test from "node:test";

import {
  createReadonlyMediaCapabilityRequest,
  createReadonlyMediaHandle,
  openReadonlyMediaCapabilityRequest,
  parseReadonlyMediaCapabilityKey,
  ReadonlyMediaCapabilityError,
  ReadonlyMediaCapabilityReplayGuard,
  READONLY_MEDIA_CAPABILITY_REPLAY_WINDOW_MS,
  READONLY_MEDIA_CAPABILITY_TTL_MS
} from "../src/webgpt-cloud/mediaCapability.js";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const active = { kid: "media-2026-07", key: Buffer.alloc(32, 7) };
const previous = { kid: "media-previous", key: Buffer.alloc(32, 6) };
const input = {
  principal_id: "1".repeat(64),
  issuer_hash: "2".repeat(64),
  project_id: "project_media_fixture",
  artifact_id: "artifact_media_fixture",
  artifact_sha256: "3".repeat(64),
  snapshot_fingerprint: "4".repeat(64)
};

test("readonly media capability encrypts strict five-minute claims and supports bounded key rotation", () => {
  const envelope = createReadonlyMediaCapabilityRequest(input, { active }, {
    now: () => NOW,
    random_bytes: (size) => Buffer.alloc(size, size === 12 ? 8 : 9)
  });
  assert.equal(JSON.stringify(envelope).includes(input.project_id), false);
  assert.equal(JSON.stringify(envelope).includes(input.artifact_id), false);
  const payload = openReadonlyMediaCapabilityRequest(envelope, { active }, { now: () => new Date(NOW.getTime() + 1_000) });
  assert.deepEqual({
    principal_id: payload.principal_id,
    issuer_hash: payload.issuer_hash,
    project_id: payload.project_id,
    artifact_id: payload.artifact_id,
    artifact_sha256: payload.artifact_sha256,
    snapshot_fingerprint: payload.snapshot_fingerprint
  }, input);
  assert.equal(Date.parse(payload.expires_at) - Date.parse(payload.issued_at), READONLY_MEDIA_CAPABILITY_TTL_MS);

  const rotated = createReadonlyMediaCapabilityRequest(input, { active: previous }, { now: () => NOW });
  const boundedPrevious = {
    ...previous,
    accepted_from: NOW.toISOString(),
    accepted_until: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString()
  };
  assert.equal(openReadonlyMediaCapabilityRequest(rotated, { active, previous: boundedPrevious }, { now: () => NOW }).kid, previous.kid);
  const mintedAtSkewBoundary = createReadonlyMediaCapabilityRequest(input, { active: previous }, {
    now: () => new Date(NOW.getTime() + 30_000)
  });
  assert.equal(
    openReadonlyMediaCapabilityRequest(mintedAtSkewBoundary, { active, previous: boundedPrevious }, { now: () => new Date(NOW.getTime() + 30_000) }).kid,
    previous.kid
  );
  const mintedAfterRotation = createReadonlyMediaCapabilityRequest(input, { active: previous }, {
    now: () => new Date(NOW.getTime() + 31_000)
  });
  assert.throws(
    () => openReadonlyMediaCapabilityRequest(mintedAfterRotation, { active, previous: boundedPrevious }, { now: () => new Date(NOW.getTime() + 31_000) }),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_KEY_UNKNOWN"
  );
  assert.throws(
    () => openReadonlyMediaCapabilityRequest(rotated, { active, previous: boundedPrevious }, { now: () => new Date(NOW.getTime() + 10 * 60 * 1000) }),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_KEY_UNKNOWN"
  );
  assert.throws(
    () => openReadonlyMediaCapabilityRequest(rotated, {
      active,
      previous: {
        ...previous,
        accepted_from: NOW.toISOString(),
        accepted_until: new Date(NOW.getTime() + 11 * 60 * 1000).toISOString()
      }
    }, { now: () => NOW }),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_KEY_INVALID"
  );
  assert.throws(
    () => openReadonlyMediaCapabilityRequest(rotated, { active }, { now: () => NOW }),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_KEY_UNKNOWN"
  );
});

test("readonly media capability rejects tampering, expiry, replay, and invalid key material", () => {
  const envelope = createReadonlyMediaCapabilityRequest(input, { active }, { now: () => NOW });
  const tampered = { ...envelope, tag: `${envelope.tag.startsWith("A") ? "B" : "A"}${envelope.tag.slice(1)}` };
  assert.throws(
    () => openReadonlyMediaCapabilityRequest(tampered, { active }, { now: () => NOW }),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_INVALID"
  );
  assert.throws(
    () => openReadonlyMediaCapabilityRequest(envelope, { active }, { now: () => new Date(NOW.getTime() + READONLY_MEDIA_CAPABILITY_TTL_MS + 31_000) }),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_EXPIRED"
  );

  const payload = openReadonlyMediaCapabilityRequest(envelope, { active }, { now: () => NOW });
  const replay = new ReadonlyMediaCapabilityReplayGuard();
  replay.accept(payload, NOW);
  assert.equal(replay.size(NOW), 1);
  assert.throws(
    () => replay.accept(payload, NOW),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_REPLAYED"
  );
  assert.equal(replay.size(new Date(Date.parse(payload.issued_at) + READONLY_MEDIA_CAPABILITY_REPLAY_WINDOW_MS - 1)), 1);
  assert.equal(replay.size(new Date(Date.parse(payload.issued_at) + READONLY_MEDIA_CAPABILITY_REPLAY_WINDOW_MS)), 0);

  assert.throws(
    () => parseReadonlyMediaCapabilityKey("bad key", Buffer.alloc(32).toString("base64url")),
    (error) => error instanceof ReadonlyMediaCapabilityError && error.code === "MEDIA_CAPABILITY_KEY_INVALID"
  );
  assert.match(createReadonlyMediaHandle(() => Buffer.alloc(32, 5)), /^[A-Za-z0-9_-]{43}$/);
});
