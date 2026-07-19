import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { paths } from "../src/paths.js";
import { openM0Database, openM0DatabaseConnection, type M0Database } from "../src/storage/sqlite.js";
import { attachArtifactToShot, getMediaArtifact, getMediaBlob, registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { createReadonlyMediaCapabilityRequest, ReadonlyMediaCapabilityReplayGuard } from "../src/webgpt-cloud/mediaCapability.js";
import { bootstrapWebGptProjectOwner, revokeWebGptProjectMembership } from "../src/webgpt-v4/authorizationAdmin.js";
import { actorFromFederatedSubject } from "../src/webgpt-v4/types.js";
import {
  MediaIntegrityQueue,
  READONLY_MEDIA_GATEWAY_MAX_CAPABILITY_RECORDS_PER_PRINCIPAL,
  READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES,
  READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES_PER_PRINCIPAL,
  ReadonlyMediaGatewayError,
  startReadonlyMediaGateway
} from "../src/webgpt-media-gateway/runtime.js";

const ISSUER = "https://issuer.media-gateway.test/";
const ORIGIN = "https://aivideo.skmt617.top";
const keyring = { active: { kid: "media-runtime-test", key: Buffer.alloc(32, 23) } };

function stable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return { sha256: createHash("sha256").update(value).digest("hex") };
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stable(item)]));
}

function logicalManifest(db: M0Database): string {
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  const payload = tables.map((name) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("UNSAFE_TABLE_NAME");
    const rows = (db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>).map(stable);
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { name, rows };
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function createFixture(label: string, uniqueMedia = false) {
  const db = openM0Database();
  try {
    const created = createProject({ title: `Media Gateway ${label}` }, db);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("PROJECT_SETUP_FAILED");
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
    const shot: Shot = {
      shot_id: `shot_media_gateway_${randomUUID()}`,
      project_id: created.project_id,
      order: 1,
      status: "storyboard_approved",
      duration_seconds: 6,
      description: "Readonly media gateway fixture",
      storyboard_image_artifact_id: "",
      video_prompt: "Fixture prompt",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    created.project.shot_ids = [shot.shot_id];
    saveProject(db, created.project);
    const fixtureBytes = uniqueMedia
      ? Buffer.concat([
          readFileSync(resolve(paths.workspaceRoot, "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png")),
          Buffer.from(`media-gateway-${label}`)
        ])
      : null;
    const registered = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: fixtureBytes
        ? { kind: "app_upload", filename: `${label}.png`, mime_type: "image/png", bytes_base64: fixtureBytes.toString("base64") }
        : { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: created.project_id, shot_id: shot.shot_id }
    }, db);
    if (!registered.ok) throw new Error(`MEDIA_FIXTURE_REGISTRATION_FAILED:${registered.error.code}`);
    const attached = attachArtifactToShot({
      project_id: created.project_id,
      shot_id: shot.shot_id,
      artifact_id: registered.artifact.artifact_id,
      reference: "storyboard_image_artifact_id",
      expected_current_artifact_id: ""
    }, db);
    assert.equal(attached.ok, true);
    const artifact = getMediaArtifact(db, registered.artifact.artifact_id);
    assert.ok(artifact);
    const blob = getMediaBlob(db, artifact.blob_id);
    assert.ok(blob);
    const actor = actorFromFederatedSubject(ISSUER, `media-owner-${label}`, ["projects.read"]);
    bootstrapWebGptProjectOwner(db, actor.principal_id, created.project_id, "MEDIA_GATEWAY_TEST", actor.issuer_hash!);
    return { actor, project_id: created.project_id, artifact, blob };
  } finally {
    db.close();
  }
}

function envelope(fixture: ReturnType<typeof createFixture>, at?: Date) {
  return createReadonlyMediaCapabilityRequest({
    principal_id: fixture.actor.principal_id,
    issuer_hash: fixture.actor.issuer_hash!,
    project_id: fixture.project_id,
    artifact_id: fixture.artifact.artifact_id,
    artifact_sha256: fixture.blob.sha256,
    snapshot_fingerprint: "4".repeat(64)
  }, keyring, at ? { now: () => at } : {});
}

function authorizeAdditionalActor(fixture: ReturnType<typeof createFixture>, label: string): ReturnType<typeof createFixture> {
  const actor = actorFromFederatedSubject(ISSUER, `media-owner-${label}`, ["projects.read"]);
  const db = openM0Database();
  try {
    bootstrapWebGptProjectOwner(db, actor.principal_id, fixture.project_id, "MEDIA_GATEWAY_CAPACITY_TEST", actor.issuer_hash!);
  } finally {
    db.close();
  }
  return { ...fixture, actor };
}

async function issue(baseUrl: string, fixture: ReturnType<typeof createFixture>, at?: Date): Promise<string> {
  const response = await fetch(`${baseUrl}/internal/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(envelope(fixture, at))
  });
  assert.equal(response.status, 201);
  const result = await response.json() as { capability_handle: string };
  assert.match(result.capability_handle, /^[A-Za-z0-9_-]{43}$/);
  return result.capability_handle;
}

test("media integrity queue remains bounded and retains a timed-out slot until the underlying task settles", async () => {
  const queue = new MediaIntegrityQueue(1, 4, 20);
  let settle!: () => void;
  const blocked = new Promise<void>((resolve) => { settle = resolve; });
  const first = queue.run(async () => blocked);
  await assert.rejects(first, (error) => error instanceof ReadonlyMediaGatewayError && error.code === "MEDIA_INTEGRITY_TIMEOUT");
  assert.deepEqual(queue.status, { running: 1, waiting: 0 });
  const next = queue.run(async () => "next");
  assert.deepEqual(queue.status, { running: 1, waiting: 1 });
  await assert.rejects(next, (error) => error instanceof ReadonlyMediaGatewayError && error.code === "MEDIA_INTEGRITY_TIMEOUT");
  assert.deepEqual(queue.status, { running: 1, waiting: 0 });
  settle();
  await blocked;
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(queue.status, { running: 0, waiting: 0 });
  assert.equal(await queue.run(async () => "recovered"), "recovered");

  const bounded = new MediaIntegrityQueue(1, 4, 5_000);
  let release!: () => void;
  const hold = bounded.run(() => new Promise<void>((resolve) => { release = resolve; }));
  const waiting = Array.from({ length: 4 }, () => bounded.run(async () => undefined));
  await assert.rejects(bounded.run(async () => undefined), (error) => error instanceof ReadonlyMediaGatewayError && error.code === "MEDIA_INTEGRITY_BUSY");
  release();
  await hold;
  await Promise.all(waiting);
});

test("readonly media gateway starts negative-cache TTL after an expensive integrity failure", async () => {
  const fixture = createFixture("negative-cache-clock");
  let clock = new Date("2026-07-19T00:00:00.000Z");
  let hashCalls = 0;
  const corruptQueue = new class extends MediaIntegrityQueue {
    override async run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      hashCalls += 1;
      const result = await super.run(task);
      clock = new Date(clock.getTime() + 20_000);
      return { ...(result as Record<string, unknown>), sha256: "0".repeat(64) } as T;
    }
  }();
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0,
    now: () => clock,
    integrity_queue: corruptQueue
  });
  const request = () => fetch(`${gateway.url}/internal/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope(fixture, clock))
  });
  try {
    const first = await request();
    assert.equal(first.status, 404);
    assert.equal((await first.json() as { error: { code: string } }).error.code, "MEDIA_INTEGRITY_FAILED");
    const cached = await request();
    assert.equal(cached.status, 404);
    assert.equal((await cached.json() as { error: { code: string } }).error.code, "MEDIA_INTEGRITY_FAILED");
    assert.equal(hashCalls, 1);
  } finally {
    await gateway.close();
  }
});

test("readonly media gateway bounds pending capabilities globally and per principal", async () => {
  const fixture = createFixture("capability-capacity");
  const actors = [fixture];
  for (let index = 1; index < READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES / READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES_PER_PRINCIPAL; index += 1) {
    actors.push(authorizeAdditionalActor(fixture, `capacity-${index}`));
  }
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0
  });
  try {
    const handles: string[] = [];
    for (let index = 0; index < READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES_PER_PRINCIPAL; index += 1) {
      handles.push(await issue(gateway.url, actors[0]!));
    }
    const principalCapacity = await fetch(`${gateway.url}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope(actors[0]!))
    });
    assert.equal(principalCapacity.status, 429);
    assert.equal((await principalCapacity.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_CAPACITY_EXCEEDED");

    for (const actorFixture of actors.slice(1)) {
      for (let index = 0; index < READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES_PER_PRINCIPAL; index += 1) {
        await issue(gateway.url, actorFixture);
      }
    }
    assert.equal(gateway.counts().capabilities, READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES);
    const overflowActor = authorizeAdditionalActor(fixture, "capacity-overflow");
    const globalCapacity = await fetch(`${gateway.url}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope(overflowActor))
    });
    assert.equal(globalCapacity.status, 429);
    assert.equal((await globalCapacity.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_CAPACITY_EXCEEDED");

    const activated = await fetch(`${gateway.url}/media/v1/c/${handles[0]}`, { headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(activated.status, 302);
    const replacement = await issue(gateway.url, actors[0]!);
    assert.match(replacement, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(gateway.counts().capabilities, READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES);
  } finally {
    await gateway.close();
  }
});

test("readonly media gateway removes stale pending capabilities after activation validation fails", async () => {
  const fixture = createFixture("stale-pending-capability");
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0
  });
  const prior = statSync(fixture.blob.storage_uri);
  try {
    const handles: string[] = [];
    for (let index = 0; index < READONLY_MEDIA_GATEWAY_MAX_PENDING_CAPABILITIES_PER_PRINCIPAL; index += 1) {
      handles.push(await issue(gateway.url, fixture));
    }
    utimesSync(fixture.blob.storage_uri, prior.atime, new Date(prior.mtimeMs + 2_000));
    for (const handle of handles) {
      const invalid = await fetch(`${gateway.url}/media/v1/c/${handle}`, { headers: { origin: ORIGIN }, redirect: "manual" });
      assert.equal(invalid.status, 404);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, "MEDIA_SESSION_INVALID");
    }
    assert.equal(gateway.counts().capabilities, 0);
    utimesSync(fixture.blob.storage_uri, prior.atime, prior.mtime);
    const corrected = await issue(gateway.url, fixture);
    assert.match(corrected, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    utimesSync(fixture.blob.storage_uri, prior.atime, prior.mtime);
    await gateway.close();
  }
});

test("readonly media gateway bounds replay records created by failed issuances", async () => {
  const fixture = createFixture("failed-issuance-replay");
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0,
    replay_guard: new ReadonlyMediaCapabilityReplayGuard(4, 2)
  });
  const failedEnvelope = () => createReadonlyMediaCapabilityRequest({
    principal_id: fixture.actor.principal_id,
    issuer_hash: fixture.actor.issuer_hash!,
    project_id: fixture.project_id,
    artifact_id: `missing_artifact_${randomUUID()}`,
    artifact_sha256: fixture.blob.sha256,
    snapshot_fingerprint: "4".repeat(64)
  }, keyring);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await fetch(`${gateway.url}/internal/v1/capabilities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(failedEnvelope())
      });
      assert.equal(failed.status, 404);
    }
    const bounded = await fetch(`${gateway.url}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(failedEnvelope())
    });
    assert.equal(bounded.status, 429);
    assert.equal((await bounded.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_REPLAY_CAPACITY_EXCEEDED");
    assert.equal(gateway.counts().capabilities, 0);
  } finally {
    await gateway.close();
  }
});

test("readonly media gateway releases failed sessions and bounds consumed capability tombstones", async () => {
  const fixture = createFixture("stream-error");
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0,
    create_read_stream: (_path, options) => {
      closeSync(options.fd);
      const stream = new PassThrough();
      setImmediate(() => stream.destroy(new Error("INJECTED_MEDIA_STREAM_FAILURE")));
      return stream;
    }
  });
  try {
    for (let cycle = 0; cycle < READONLY_MEDIA_GATEWAY_MAX_CAPABILITY_RECORDS_PER_PRINCIPAL; cycle += 1) {
      const handle = await issue(gateway.url, fixture);
      const activated = await fetch(`${gateway.url}/media/v1/c/${handle}`, { headers: { origin: ORIGIN }, redirect: "manual" });
      assert.equal(activated.status, 302);
      await assert.rejects(async () => {
        const failed = await fetch(`${gateway.url}${activated.headers.get("location")}`, { headers: { origin: ORIGIN } });
        await failed.arrayBuffer();
      });
      for (let attempt = 0; attempt < 20 && gateway.counts().sessions !== 0; attempt += 1) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
      }
      assert.equal(gateway.counts().sessions, 0);
    }
    assert.equal(gateway.counts().capabilities, 0);
    const bounded = await fetch(`${gateway.url}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope(fixture))
    });
    assert.equal(bounded.status, 429);
    assert.equal((await bounded.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_CAPACITY_EXCEEDED");
  } finally {
    await gateway.close();
  }
});

test("readonly media gateway rejects a file descriptor whose identity differs from the authorized path", async () => {
  const fixture = createFixture("descriptor-drift");
  let streamCreated = false;
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0,
    open_readonly_file: () => openSync(fileURLToPath(import.meta.url), "r"),
    create_read_stream: () => {
      streamCreated = true;
      return new PassThrough();
    }
  });
  try {
    const handle = await issue(gateway.url, fixture);
    const activated = await fetch(`${gateway.url}/media/v1/c/${handle}`, { headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(activated.status, 302);
    const rejected = await fetch(`${gateway.url}${activated.headers.get("location")}`, { headers: { origin: ORIGIN } });
    assert.equal(rejected.status, 404);
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, "MEDIA_SESSION_INVALID");
    assert.equal(streamCreated, false);
    assert.equal(gateway.counts().sessions, 0);
  } finally {
    await gateway.close();
  }
});

test("readonly media gateway rejects same-size overwrites even when mtime is restored", async () => {
  const fixture = createFixture("ctime-drift", true);
  const mediaPath = fixture.blob.storage_uri;
  const original = readFileSync(mediaPath);
  const pinnedMtime = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 5_000);
  utimesSync(mediaPath, pinnedMtime, pinnedMtime);
  const before = statSync(mediaPath);
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0
  });
  try {
    const handle = await issue(gateway.url, fixture);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    const changed = Buffer.from(original);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
    writeFileSync(mediaPath, changed);
    utimesSync(mediaPath, pinnedMtime, pinnedMtime);
    const after = statSync(mediaPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.notEqual(after.ctimeMs, before.ctimeMs);

    const rejected = await fetch(`${gateway.url}/media/v1/c/${handle}`, { headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(rejected.status, 404);
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, "MEDIA_SESSION_INVALID");
    assert.equal(gateway.counts().capabilities, 0);
  } finally {
    writeFileSync(mediaPath, original);
    utimesSync(mediaPath, pinnedMtime, pinnedMtime);
    await gateway.close();
  }
});

test("readonly media gateway verifies bytes, consumes capabilities once, streams ranges, and never writes SQLite", async () => {
  const fixture = createFixture("stream");
  const beforeDb = openM0DatabaseConnection(paths.sqlitePath, { readOnly: true });
  const before = logicalManifest(beforeDb);
  beforeDb.close();
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0
  });
  try {
    assert.notEqual(resolve(String(fixture.blob.provenance.media_root)), resolve(paths.imageArtifactsRoot));
    assert.ok(resolve(fixture.blob.storage_uri).startsWith(resolve(paths.imageArtifactsRoot)));
    const health = await fetch(`${gateway.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "readonly-media-gateway", version: "readonly-media-gateway-v1.0.0" });
    assert.equal((await fetch(`${gateway.url}/readyz`)).status, 200);
    const wrongContentType = await fetch(`${gateway.url}/internal/v1/capabilities`, { method: "POST", body: "{}" });
    assert.equal(wrongContentType.status, 404);
    assert.equal((await wrongContentType.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_INVALID");
    const disguisedContentType = await fetch(`${gateway.url}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/jsonish; charset=utf-8" },
      body: "{}"
    });
    assert.equal(disguisedContentType.status, 404);
    assert.equal((await disguisedContentType.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_INVALID");
    const handle = await issue(gateway.url, fixture);
    const capabilityUrl = `${gateway.url}/media/v1/c/${handle}`;
    const head = await fetch(capabilityUrl, { method: "HEAD", headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(head.status, 204);
    assert.equal(gateway.counts().capabilities, 1);
    const activated = await fetch(capabilityUrl, { headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(activated.status, 302);
    assert.match(activated.headers.get("location") ?? "", /^\/media\/v1\/s\/[A-Za-z0-9_-]{43}$/);
    assert.equal(activated.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(activated.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(activated.headers.get("access-control-allow-credentials"), "true");
    const consumedHead = await fetch(capabilityUrl, { method: "HEAD", headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(consumedHead.status, 409);
    assert.equal(consumedHead.headers.get("access-control-allow-credentials"), "true");
    const replay = await fetch(capabilityUrl, { headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_REPLAYED");
    const sessionUrl = `${gateway.url}${activated.headers.get("location")}`;
    const range = await fetch(sessionUrl, { headers: { origin: ORIGIN, range: "bytes=0-15" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 0-15/${fixture.blob.size_bytes}`);
    assert.equal(range.headers.get("access-control-allow-credentials"), "true");
    assert.equal((await range.arrayBuffer()).byteLength, 16);
    const invalidRange = await fetch(sessionUrl, { headers: { origin: ORIGIN, range: "bytes=0-1,4-5" } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("access-control-allow-credentials"), "true");
    const deniedOrigin = await fetch(sessionUrl, { headers: { origin: "https://denied.example" } });
    assert.equal(deniedOrigin.status, 403);
    assert.equal(deniedOrigin.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(deniedOrigin.headers.get("access-control-allow-credentials"), null);
    assert.equal(gateway.counts().sessions, 1);
    for (let index = 0; index < 3; index += 1) {
      const additional = await issue(gateway.url, fixture);
      const activatedAdditional = await fetch(`${gateway.url}/media/v1/c/${additional}`, { headers: { origin: ORIGIN }, redirect: "manual" });
      assert.equal(activatedAdditional.status, 302);
    }
    assert.equal(gateway.counts().sessions, 4);
    const overCapacity = await issue(gateway.url, fixture);
    const capacityResponse = await fetch(`${gateway.url}/media/v1/c/${overCapacity}`, { headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(capacityResponse.status, 429);
    assert.equal((await capacityResponse.json() as { error: { code: string } }).error.code, "MEDIA_SESSION_CAPACITY_EXCEEDED");
  } finally {
    await gateway.close();
  }
  const wrongRootGateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.videoArtifactsRoot],
    port: 0
  });
  try {
    const denied = await fetch(`${wrongRootGateway.url}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope(fixture))
    });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json() as { error: { code: string } }).error.code, "MEDIA_PATH_UNSAFE");
  } finally {
    await wrongRootGateway.close();
  }
  const emptyRootsGateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [],
    port: 0
  });
  try {
    const notReady = await fetch(`${emptyRootsGateway.url}/readyz`);
    assert.equal(notReady.status, 503);
    assert.equal((await notReady.json() as { checks: { media_roots: boolean } }).checks.media_roots, false);
  } finally {
    await emptyRootsGateway.close();
  }
  const afterDb = openM0DatabaseConnection(paths.sqlitePath, { readOnly: true });
  const after = logicalManifest(afterDb);
  afterDb.close();
  assert.equal(after, before);
});

test("readonly media gateway readiness rejects a malformed capability key id", async () => {
  const fixture = createFixture("invalid-key-readiness");
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring: { active: { ...keyring.active, kid: "invalid key id" } },
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.imageArtifactsRoot],
    port: 0
  });
  try {
    const readiness = await fetch(`${gateway.url}/readyz`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json() as { checks: { capability_key: boolean } }).checks.capability_key, false);
  } finally {
    await gateway.close();
  }
});

test("readonly media sessions fail closed after membership revocation or file identity drift", async () => {
  const fixture = createFixture("revocation");
  const gateway = await startReadonlyMediaGateway({
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.mediaRoot],
    port: 0
  });
  try {
    const first = await issue(gateway.url, fixture);
    const activation = await fetch(`${gateway.url}/media/v1/c/${first}`, { headers: { origin: ORIGIN }, redirect: "manual" });
    const sessionUrl = `${gateway.url}${activation.headers.get("location")}`;
    const db = openM0Database();
    try {
      revokeWebGptProjectMembership(db, fixture.actor.principal_id, fixture.project_id, "MEDIA_GATEWAY_REVOCATION_TEST");
    } finally {
      db.close();
    }
    const revoked = await fetch(sessionUrl, { headers: { origin: ORIGIN, range: "bytes=0-7" } });
    assert.equal(revoked.status, 404);
    assert.equal(gateway.counts().sessions, 0);

    const driftFixture = createFixture("drift");
    await gateway.close();
    const driftGateway = await startReadonlyMediaGateway({
      database_path: paths.sqlitePath,
      issuer_hash: driftFixture.actor.issuer_hash!,
      keyring,
      allowed_origin: ORIGIN,
      allowed_media_roots: [paths.mediaRoot],
      port: 0
    });
    try {
      const second = await issue(driftGateway.url, driftFixture);
      const secondActivation = await fetch(`${driftGateway.url}/media/v1/c/${second}`, { headers: { origin: ORIGIN }, redirect: "manual" });
      const secondSession = `${driftGateway.url}${secondActivation.headers.get("location")}`;
      const prior = statSync(driftFixture.blob.storage_uri);
      utimesSync(driftFixture.blob.storage_uri, prior.atime, new Date(prior.mtimeMs + 2_000));
      const drifted = await fetch(secondSession, { headers: { origin: ORIGIN, range: "bytes=0-7" } });
      assert.equal(drifted.status, 404);
      assert.equal(driftGateway.counts().sessions, 0);
    } finally {
      await driftGateway.close();
    }
    return;
  } finally {
    if (gateway.server.listening) await gateway.close();
  }
});

test("readonly media capability and session handles expire and never survive a gateway restart", async () => {
  const fixture = createFixture("lifetime");
  let clock = new Date();
  const options = {
    database_path: paths.sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    keyring,
    allowed_origin: ORIGIN,
    allowed_media_roots: [paths.mediaRoot],
    port: 0,
    now: () => clock
  };
  const firstGateway = await startReadonlyMediaGateway(options);
  const oldHandle = await issue(firstGateway.url, fixture, clock);
  await firstGateway.close();

  const gateway = await startReadonlyMediaGateway(options);
  try {
    const lostOnRestart = await fetch(`${gateway.url}/media/v1/c/${oldHandle}`, { method: "HEAD", headers: { origin: ORIGIN } });
    assert.equal(lostOnRestart.status, 404);
    const expiringCapability = await issue(gateway.url, fixture, clock);
    clock = new Date(clock.getTime() + 5 * 60 * 1000);
    const expiredCapability = await fetch(`${gateway.url}/media/v1/c/${expiringCapability}`, { method: "HEAD", headers: { origin: ORIGIN } });
    assert.equal(expiredCapability.status, 404);

    const sessionCapability = await issue(gateway.url, fixture, clock);
    const activation = await fetch(`${gateway.url}/media/v1/c/${sessionCapability}`, { headers: { origin: ORIGIN }, redirect: "manual" });
    assert.equal(activation.status, 302);
    const sessionUrl = `${gateway.url}${activation.headers.get("location")}`;
    clock = new Date(clock.getTime() + 30 * 60 * 1000);
    const expiredSession = await fetch(sessionUrl, { headers: { origin: ORIGIN, range: "bytes=0-7" } });
    assert.equal(expiredSession.status, 404);
    assert.equal((await expiredSession.json() as { error: { code: string } }).error.code, "MEDIA_SESSION_EXPIRED");
    assert.deepEqual(gateway.counts(), { capabilities: 0, sessions: 0 });

    const expiredEnvelope = envelope(fixture, clock);
    clock = new Date(clock.getTime() + 5 * 60 * 1000 + 1_000);
    const rejectedIssuance = await fetch(`${gateway.url}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(expiredEnvelope)
    });
    assert.equal(rejectedIssuance.status, 404);
    assert.equal((await rejectedIssuance.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_EXPIRED");
    assert.deepEqual(gateway.counts(), { capabilities: 0, sessions: 0 });
  } finally {
    await gateway.close();
  }
});
