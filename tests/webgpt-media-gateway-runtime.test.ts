import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { statSync, utimesSync } from "node:fs";
import test from "node:test";

import { paths } from "../src/paths.js";
import { openM0Database, openM0DatabaseConnection, type M0Database } from "../src/storage/sqlite.js";
import { attachArtifactToShot, getMediaArtifact, getMediaBlob, registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { createReadonlyMediaCapabilityRequest } from "../src/webgpt-cloud/mediaCapability.js";
import { bootstrapWebGptProjectOwner, revokeWebGptProjectMembership } from "../src/webgpt-v4/authorizationAdmin.js";
import { actorFromFederatedSubject } from "../src/webgpt-v4/types.js";
import {
  MediaIntegrityQueue,
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

function createFixture(label: string) {
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
    const registered = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
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

async function issue(baseUrl: string, fixture: ReturnType<typeof createFixture>, at?: Date): Promise<string> {
  const response = await fetch(`${baseUrl}/internal/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  settle();
  assert.equal(await next, "next");
  assert.deepEqual(queue.status, { running: 0, waiting: 0 });

  const bounded = new MediaIntegrityQueue(1, 4, 5_000);
  let release!: () => void;
  const hold = bounded.run(() => new Promise<void>((resolve) => { release = resolve; }));
  const waiting = Array.from({ length: 4 }, () => bounded.run(async () => undefined));
  await assert.rejects(bounded.run(async () => undefined), (error) => error instanceof ReadonlyMediaGatewayError && error.code === "MEDIA_INTEGRITY_BUSY");
  release();
  await hold;
  await Promise.all(waiting);
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
    allowed_media_roots: [paths.mediaRoot],
    port: 0
  });
  try {
    const health = await fetch(`${gateway.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "readonly-media-gateway", version: "readonly-media-gateway-v1.0.0" });
    assert.equal((await fetch(`${gateway.url}/readyz`)).status, 200);
    const wrongContentType = await fetch(`${gateway.url}/internal/v1/capabilities`, { method: "POST", body: "{}" });
    assert.equal(wrongContentType.status, 404);
    assert.equal((await wrongContentType.json() as { error: { code: string } }).error.code, "MEDIA_CAPABILITY_INVALID");
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
  const afterDb = openM0DatabaseConnection(paths.sqlitePath, { readOnly: true });
  const after = logicalManifest(afterDb);
  afterDb.close();
  assert.equal(after, before);
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
  } finally {
    await gateway.close();
  }
});
