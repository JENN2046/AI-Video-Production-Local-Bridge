import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  DIRECTOR_BRIDGE_FRAME_TIMEOUT_MS,
  DIRECTOR_BRIDGE_REQUEST_SCHEMA,
  DirectorBridgeBroker,
  DirectorBridgeReplayGuard,
  DirectorLocalBridgeClient,
  signDirectorBridgeBody,
  verifyDirectorBridgeBody,
  type DirectorBridgeKeyring
} from "../src/director/bridge.js";
import { loadDirectorBridgeKeyring } from "../src/director/bridgeConfig.js";
import { createDirectorLocalService, selectDirectorFramePlan } from "../src/director/localService.js";
import {
  DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA,
  DIRECTOR_NATIVE_TOOL_NAMES,
  DIRECTOR_VIDEO_FRAME_TOOL_OUTPUT_SCHEMA
} from "../src/director/mcpContract.js";
import { startDirectorRemoteRuntime } from "../src/director/remoteRuntime.js";
import type { DirectorOAuthConfig } from "../src/director/oauth.js";
import { assertSchemaCurrent } from "../src/storage/migrations.js";
import { openM0Database, openM0DatabaseConnection } from "../src/storage/sqlite.js";
import type { MediaArtifact } from "../src/tools/mediaArtifacts.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { bootstrapWebGptProjectOwner } from "../src/webgpt-v4/authorizationAdmin.js";
import { resolveFfmpegExecutable } from "../src/webgpt-v4/media.js";
import { withToolSecuritySchemes } from "../src/webgpt-v4/securityTransport.js";
import { actorFromFederatedSubject, issuerHash } from "../src/webgpt-v4/types.js";

const ISSUER = "https://issuer.director.example.test/";
const RESOURCE = "https://aivideo.example.test/director/mcp";
const SUBJECT = "auth0|director-local-owner";
const keyring: DirectorBridgeKeyring = { active: { kid: "director-bridge-test", key: Buffer.alloc(32, 71) } };

function oauthConfig(): DirectorOAuthConfig {
  return {
    provider: "federated", access_model: "project_membership", issuer: ISSUER, issuer_hash: issuerHash(ISSUER),
    audience: RESOURCE, resource_url: RESOURCE, jwks_uri: "https://issuer.director.example.test/jwks.json",
    client_registration: "predefined", configuration_source: "generic"
  };
}

function logicalManifest(path: string): string {
  const db = openM0DatabaseConnection(path, { readOnly: true });
  try {
    assertSchemaCurrent(db);
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    const content = tables.map((table) => ({ table, rows: db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() }));
    return createHash("sha256").update(JSON.stringify(content)).digest("hex");
  } finally { db.close(); }
}

function proposalDraft(shotId: string, artifactId: string) {
  return {
    kind: "review_assessment" as const,
    payload: {
      shot_id: shotId, artifact_id: artifactId,
      diagnosis: "The generated movement is too abrupt.",
      evidence: [{ timestamp_seconds: 0.5, observation: "Motion begins without anticipation." }],
      recommended_disposition: "regenerate" as const,
      prompt_delta: "Add a short anticipation before movement.", continuity_delta: ["Keep product geometry stable"], confidence: 0.91
    }
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "director-local-bridge-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  mkdirSync(mediaRoot, { recursive: true });
  const sourcePath = join(mediaRoot, "source.mp4");
  const ffmpeg = await resolveFfmpegExecutable();
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", sourcePath], { windowsHide: true, timeout: 30_000 });
  const actor = actorFromFederatedSubject(ISSUER, SUBJECT, ["projects.read", "media.read", "proposals.write"]);
  const db = openM0Database(sqlitePath);
  const created = createProject({
    title: "Director local fixture",
    brief: { summary: "A bounded local bridge fixture.", creative_direction: "Natural movement." },
    video_spec: { duration_seconds: 2, aspect_ratio: "16:9", resolution: "320x180" }
  }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture project failed");
  created.project.status = "video_review";
  const shot: Shot = {
    shot_id: "shot_director_local_001", project_id: created.project_id, order: 1, status: "video_review",
    duration_seconds: 2, description: "A blue frame moves into review.", storyboard_image_artifact_id: "",
    video_prompt: "Slow deliberate movement.", negative_prompt: "No deformation.", generation_run_ids: [],
    accepted_clip_artifact_id: "", clip_versions: [{ artifact_id: "artifact_director_video_001", run_id: "run_fixture", attempt_number: 1, review_status: "pending" }],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  created.project.shot_ids = [shot.shot_id];
  saveProject(db, created.project);
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
  const sourceBytes = readFileSync(sourcePath);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const blobId = `blob_sha256_${sourceSha256}`;
  const artifact: MediaArtifact = {
    artifact_id: "artifact_director_video_001", blob_id: blobId, artifact_type: "video", role: "generated_clip", status: "active",
    storage: { uri: sourcePath, mime_type: "video/mp4", filename: "source.mp4" },
    metadata: { width: 320, height: 180, duration_seconds: 2, aspect_ratio: "16:9", sha256: sourceSha256 },
    linked_objects: { project_id: created.project_id, shot_id: shot.shot_id },
    source: { kind: "fixture", provider: "mock", provider_job_id: "", sha256: sourceSha256, external_url_host: "" }
  };
  db.prepare(`INSERT INTO media_blobs
    (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, 'video/mp4', ?, 'verified', ?)`)
    .run(blobId, sourceSha256, statSync(sourcePath).size, sourcePath, JSON.stringify({ media_root: mediaRoot }));
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'generated_clip', 'video', 'active', ?)`)
    .run(artifact.artifact_id, created.project_id, shot.shot_id, JSON.stringify(artifact));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(artifact.artifact_id, blobId);
  bootstrapWebGptProjectOwner(db, actor.principal_id, created.project_id, "DIRECTOR_LOCAL_FIXTURE", actor.issuer_hash!);
  const now = new Date("2026-07-22T02:00:00.000Z");
  db.prepare(`INSERT INTO director_focuses
    (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation, created_at, expires_at)
    VALUES (?, 'jenn-ai-video-workspace', ?, ?, 'artifact', ?, 1, ?, ?)`)
    .run("focus_director_local_001", actor.principal_id, created.project_id, artifact.artifact_id, now.toISOString(), new Date(now.getTime() + 60 * 60_000).toISOString());
  db.prepare(`INSERT INTO director_focus_events (event_id, focus_id, event_type, reason_code, created_at)
    VALUES ('focus_event_director_local_001', 'focus_director_local_001', 'created', 'WORKBENCH_SELECTION', ?)`)
    .run(now.toISOString());
  db.close();
  return { root, sqlitePath, mediaRoot, ffmpeg, actor, projectId: created.project_id, shotId: shot.shot_id, artifactId: artifact.artifact_id, now };
}

test("Director bridge HMAC rejects tampering, replay, expired authentication, and invalid keyrings", async () => {
  const schema = DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA;
  const now = new Date("2026-07-22T02:00:00.000Z");
  const envelope = signDirectorBridgeBody({ state: "no_focus", focus: null }, keyring.active, now);
  assert.deepEqual(verifyDirectorBridgeBody(envelope, keyring, schema, new DirectorBridgeReplayGuard(), now), { state: "no_focus", focus: null });
  const replay = new DirectorBridgeReplayGuard();
  verifyDirectorBridgeBody(envelope, keyring, schema, replay, now);
  assert.throws(() => verifyDirectorBridgeBody(envelope, keyring, schema, replay, now), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_REPLAYED");
  assert.throws(() => verifyDirectorBridgeBody({ ...envelope, body: { state: "focus_expired", focus: null } }, keyring, schema, new DirectorBridgeReplayGuard(), now), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_AUTH_INVALID");
  assert.throws(() => verifyDirectorBridgeBody(envelope, keyring, schema, new DirectorBridgeReplayGuard(), new Date(now.getTime() + 61_000)), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_AUTH_EXPIRED");
  assert.throws(() => signDirectorBridgeBody({}, { kid: "bad kid", key: randomBytes(32) }), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_KEY_INVALID");
  assert.equal(loadDirectorBridgeKeyring({}), null);
  assert.throws(() => loadDirectorBridgeKeyring({ WEBGPT_DIRECTOR_BRIDGE_KEY_ID: "partial" }), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_KEY_INVALID");
  assert.equal(loadDirectorBridgeKeyring({
    WEBGPT_DIRECTOR_BRIDGE_KEY_ID: "director-bridge-test",
    WEBGPT_DIRECTOR_BRIDGE_KEY_B64: Buffer.alloc(32, 71).toString("base64")
  })?.active.key.byteLength, 32);
  assert.equal(DIRECTOR_BRIDGE_REQUEST_SCHEMA.safeParse({
    protocol_version: "director-local-bridge-v1",
    request_id: "director_bridge_too_long",
    actor: { principal_id: "1".repeat(64), actor_hash: "2".repeat(64), issuer_hash: "3".repeat(64), scopes: ["projects.read"] },
    tool: "get_director_focus",
    input: { request_id: "req_too_long" },
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_001).toISOString()
  }).success, false);
  const actor = actorFromFederatedSubject(ISSUER, SUBJECT, ["projects.read", "media.read"]);
  let bridgeNow = now;
  const broker = new DirectorBridgeBroker(keyring, () => bridgeNow);
  const pendingFrame = broker.submit(actor, "inspect_director_video_frames", {
    focus_id: "focus_timeout_test", focus_generation: 1, artifact_id: "artifact_timeout_test",
    sampling: "overview", max_frames: 3, request_id: "req_frame_timeout"
  });
  await assert.rejects(() => broker.submit(actor, "get_director_focus", { request_id: "req_behind_frame" }),
    (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_BUSY");
  bridgeNow = new Date(now.getTime() + 61_000);
  const frameEnvelope = broker.poll();
  assert.ok(frameEnvelope);
  const frameRequest = verifyDirectorBridgeBody(
    frameEnvelope,
    keyring,
    DIRECTOR_BRIDGE_REQUEST_SCHEMA,
    new DirectorBridgeReplayGuard(),
    bridgeNow
  );
  assert.equal(Date.parse(frameRequest.expires_at) - Date.parse(frameRequest.issued_at), DIRECTOR_BRIDGE_FRAME_TIMEOUT_MS);
  assert.equal(frameRequest.issued_at, bridgeNow.toISOString());
  assert.equal(broker.connected(), true);
  broker.close();
  await assert.rejects(pendingFrame, (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_CLOSED");
  assert.throws(() => new DirectorLocalBridgeClient({
    remote_origin: "ftp://localhost/",
    client_id: "invalid-origin-test",
    keyring,
    handlers: () => ({}) as never
  }), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_ORIGIN_INVALID");
});

test("Director frame plans downsample across the whole clip", () => {
  const plan = selectDirectorFramePlan(30, 12);
  assert.equal(plan.length, 12);
  assert.equal(plan[0]?.timestamp_seconds, 0);
  assert.equal(plan.at(-1)?.timestamp_seconds, 30);
  assert.equal(plan.some((item) => item.timestamp_seconds >= 15 && item.timestamp_seconds < 30), true);
  assert.deepEqual(
    selectDirectorFramePlan(30, 1).map((item) => item.timestamp_seconds),
    [15]
  );
});

test("Director transport publishes host-visible standard security schemes for multi-scope tools", async () => {
  let sent: unknown;
  const inner = {
    start: async () => undefined,
    send: async (message: unknown) => { sent = message; },
    close: async () => undefined,
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined
  };
  const transport = withToolSecuritySchemes(inner as never, {
    inspect_director_video_frames: ["projects.read", "media.read"]
  });
  await transport.send({
    jsonrpc: "2.0", id: 1,
    result: { tools: [{ name: "inspect_director_video_frames", _meta: { securitySchemes: [{ type: "oauth2", scopes: ["projects.read", "media.read"] }] } }] }
  } as never);
  const tool = ((sent as { result: { tools: Array<Record<string, unknown>> } }).result.tools[0])!;
  assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["projects.read", "media.read"] }]);
});

test("Director local service binds Focus/context and persists only an immutable advisory Proposal", async () => {
  const f = await fixture();
  try {
    const noteDb = openM0Database(f.sqlitePath);
    try {
      noteDb.prepare(`INSERT INTO workbench_review_notes
        (note_id, project_id, shot_id, artifact_id, author_hash, note, source, created_at, updated_at)
        VALUES ('note_director_unbound_001', ?, ?, '', 'fixture-author', 'General SHOT review note.', 'workbench', ?, ?)`)
        .run(f.projectId, f.shotId, f.now.toISOString(), f.now.toISOString());
    } finally { noteDb.close(); }
    const service = createDirectorLocalService(f.actor, { database_path: f.sqlitePath, ffmpeg_path: f.ffmpeg, now: () => f.now });
    const unregistered = createDirectorLocalService(
      actorFromFederatedSubject(ISSUER, "auth0|not-registered", ["projects.read"]),
      { database_path: f.sqlitePath, ffmpeg_path: f.ffmpeg, now: () => f.now }
    );
    await assert.rejects(() => unregistered.get_director_focus(), (error) => error instanceof Error && "code" in error && error.code === "WEBGPT_PRINCIPAL_NOT_REGISTERED");
    const beforeReads = logicalManifest(f.sqlitePath);
    const focus = await service.get_director_focus();
    assert.equal(focus.state, "active");
    assert.equal(JSON.stringify(focus).includes(f.actor.principal_id), false);
    const context = await service.get_director_context({
      focus_id: "focus_director_local_001", focus_generation: 1, proposal_kind: "review_assessment", detail: "full"
    });
    assert.equal(context.discussion.target_artifact?.artifact_id, f.artifactId);
    assert.equal(context.discussion.review_history[0]?.artifact_id, null);
    assert.equal(context.target_state.target_artifact?.project_id, f.projectId);
    assert.equal(logicalManifest(f.sqlitePath), beforeReads);

    const frames = await service.inspect_director_video_frames({
      focus_id: "focus_director_local_001", focus_generation: 1, artifact_id: f.artifactId, sampling: "overview", max_frames: 3
    });
    assert.equal(frames.structured_content.frames.length, 3);
    assert.equal(frames.model_images.length, 3);
    assert.equal(frames.model_images.every((image) => image.mime_type === "image/jpeg" && image.data.length > 100), true);
    assert.throws(() => DIRECTOR_VIDEO_FRAME_TOOL_OUTPUT_SCHEMA.parse({
      ...frames,
      model_images: [{ ...frames.model_images[0], data: `AAAA${frames.model_images[0]!.data.slice(4)}` }, ...frames.model_images.slice(1)]
    }));
    assert.equal(JSON.stringify(frames.structured_content).includes(f.mediaRoot), false);
    assert.equal(logicalManifest(f.sqlitePath), beforeReads, "focus/context/frame analysis must not write SQLite");

    const submitted = await service.submit_director_proposal({
      focus_id: "focus_director_local_001", focus_generation: 1, base_state_hash: context.base_state_hash,
      idempotency_key: "director-local-proposal-0001", parent_proposal_id: null, proposal: proposalDraft(f.shotId, f.artifactId)
    });
    assert.equal(submitted.state, "accepted_for_human_review");
    const replay = await service.submit_director_proposal({
      focus_id: "focus_director_local_001", focus_generation: 1, base_state_hash: context.base_state_hash,
      idempotency_key: "director-local-proposal-0001", parent_proposal_id: null, proposal: proposalDraft(f.shotId, f.artifactId)
    });
    assert.equal(replay.proposal_id, submitted.proposal_id);
    await assert.rejects(() => service.submit_director_proposal({
      focus_id: "focus_director_local_001", focus_generation: 1, base_state_hash: context.base_state_hash,
      idempotency_key: "director-local-proposal-0001", parent_proposal_id: null,
      proposal: { ...proposalDraft(f.shotId, f.artifactId), payload: { ...proposalDraft(f.shotId, f.artifactId).payload, diagnosis: "Different payload." } }
    }), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_IDEMPOTENCY_CONFLICT");
    const manualDb = openM0Database(f.sqlitePath);
    try {
      manualDb.prepare(`INSERT INTO director_proposals
        (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
         schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id, idempotency_key, source, created_at)
        SELECT 'director_proposal_manual_collision', workspace_id, principal_id, project_id, target_type, target_id,
          focus_id, focus_generation, schema_version, kind, base_state_hash, payload_json, payload_hash,
          parent_proposal_id, 'director-local-manual-collision', 'untrusted_manual_import', created_at
        FROM director_proposals WHERE proposal_id = ?`).run(submitted.proposal_id);
    } finally { manualDb.close(); }
    await assert.rejects(() => service.submit_director_proposal({
      focus_id: "focus_director_local_001", focus_generation: 1, base_state_hash: context.base_state_hash,
      idempotency_key: "director-local-manual-collision", parent_proposal_id: null,
      proposal: proposalDraft(f.shotId, f.artifactId)
    }), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_IDEMPOTENCY_CONFLICT");
    await assert.rejects(() => service.submit_director_proposal({
      focus_id: "focus_director_local_001", focus_generation: 1, base_state_hash: context.base_state_hash,
      idempotency_key: "director-local-proposal-0001", parent_proposal_id: "director_proposal_other",
      proposal: proposalDraft(f.shotId, f.artifactId)
    }), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_IDEMPOTENCY_CONFLICT");
    const status = await service.get_director_proposal_status({ proposal_id: submitted.proposal_id });
    assert.deepEqual({ state: status.state, reason: status.reason_code }, { state: "pending_review", reason: "DIRECTOR_NATIVE_SUBMITTED" });
    const db = openM0Database(f.sqlitePath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) count FROM director_proposals").get() as { count: number }).count, 2);
      assert.equal((db.prepare("SELECT COUNT(*) count FROM director_proposal_events WHERE event_type = 'submitted'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) count FROM generation_intents").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) count FROM director_automation_grants").get() as { count: number }).count, 0);
      assert.throws(() => db.prepare("UPDATE director_proposals SET kind = 'script' WHERE proposal_id = ?").run(submitted.proposal_id), /DIRECTOR_PROPOSAL_IMMUTABLE/);
      const storedShot = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(f.shotId) as { data_json: string };
      db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?")
        .run(JSON.stringify({ ...JSON.parse(storedShot.data_json), project_id: "project_drift" }), f.shotId);
    } finally { db.close(); }
    await assert.rejects(() => service.get_director_context({
      focus_id: "focus_director_local_001", focus_generation: 1, proposal_kind: "review_assessment", detail: "compact"
    }), (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_DATA_INTEGRITY_VIOLATION");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Director remote runtime exposes five OAuth tools through the authenticated outbound local bridge", async () => {
  const f = await fixture();
  let stopping = false;
  const runtime = await startDirectorRemoteRuntime({
    port: 0, auth_config: oauthConfig(), bridge_keyring: keyring, authenticate: async () => f.actor, now: () => f.now
  });
  const bridge = new DirectorLocalBridgeClient({
    remote_origin: runtime.origin, client_id: "director-test-client", keyring,
    handlers: (actor) => createDirectorLocalService(actor, { database_path: f.sqlitePath, ffmpeg_path: f.ffmpeg, now: () => f.now }), now: () => f.now
  });
  const pump = (async () => {
    while (!stopping) {
      try { await bridge.runOnce(); } catch { /* request-level errors are returned through the signed completion */ }
      await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    }
  })();
  const client = new Client({ name: "director-remote-test", version: "1.0.0" });
  try {
    await new Promise((resolveTick) => setTimeout(resolveTick, 30));
    const ready = await fetch(`${runtime.origin}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await fetch(runtime.mcp_url)).status, 405);
    assert.equal((await fetch(runtime.mcp_url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    const metadata = await fetch(`${runtime.origin}/.well-known/oauth-protected-resource/director/mcp`);
    assert.deepEqual((await metadata.json() as { scopes_supported: string[] }).scopes_supported, ["projects.read", "media.read", "proposals.write"]);
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url));
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...DIRECTOR_NATIVE_TOOL_NAMES].sort());
    for (const tool of listed.tools) {
      assert.deepEqual((tool._meta as Record<string, unknown>).securitySchemes, [{ type: "oauth2", scopes: tool.name === "inspect_director_video_frames"
        ? ["projects.read", "media.read"] : tool.name === "submit_director_proposal" ? ["projects.read", "proposals.write"] : ["projects.read"] }]);
    }
    const focus = await client.callTool({ name: "get_director_focus", arguments: {} });
    assert.equal(focus.isError, false);
    const context = await client.callTool({
      name: "get_director_context",
      arguments: { focus_id: "focus_director_local_001", focus_generation: 1, proposal_kind: "review_assessment", detail: "compact" }
    });
    assert.equal(context.isError, false);
    assert.equal(JSON.stringify(context).includes(f.sqlitePath), false);
    const frames = await client.callTool({
      name: "inspect_director_video_frames",
      arguments: { focus_id: "focus_director_local_001", focus_generation: 1, artifact_id: f.artifactId, sampling: "overview", max_frames: 2 }
    });
    assert.equal(frames.isError, false);
    assert.equal((frames.content as Array<{ type: string }>).filter((item) => item.type === "image").length, 2);
  } finally {
    await client.close().catch(() => undefined);
    stopping = true;
    await pump;
    await runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Director remote runtime module graph remains detached from SQLite and local media paths", () => {
  const entry = resolve("src/director/remoteRuntime.ts");
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("openM0Database"), false, path);
    assert.equal(source.includes("AI_VIDEO_WORKSPACE_DB_PATH"), false, path);
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const candidate = resolve(dirname(path), match[1]!.replace(/\.js$/, ".ts"));
      if (existsSync(candidate)) visit(candidate);
    }
  };
  visit(entry);
  const disabled = spawnSync(process.execPath, [resolve("dist/scripts/director-local-bridge.js")], {
    cwd: resolve("."),
    env: { ...process.env, REAL_PROVIDER_ENABLED: "true", WEBGPT_DIRECTOR_BRIDGE_KEY_B64: "must-not-be-printed" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /DIRECTOR_PROVIDER_MUST_BE_DISABLED/);
  assert.equal(disabled.stderr.includes("must-not-be-printed"), false);
});
