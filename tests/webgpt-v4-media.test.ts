import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { openM0Database } from "../src/storage/sqlite.js";
import { activateLocalMediaArtifact, type MediaArtifact } from "../src/tools/mediaArtifacts.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { fullInspection } from "../src/webgpt-v4/contracts.js";
import { cleanupMediaAnalysisCache, coverageFramePlan, createMediaGrant, handleMediaGatewayRequest, inspectProductionMedia, invalidateMediaGrantsForRestart, MediaAnalysisQueue, resolveFfmpegExecutable, resolveProductionMediaPath, validateMediaGrant } from "../src/webgpt-v4/media.js";
import { actorFromSubject, ok, WebGptV4Error } from "../src/webgpt-v4/types.js";

const validPng = readFileSync(resolve("fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png"));
const alternatePng = readFileSync(resolve("fixtures/storyboard/shot_001.png"));

test("media grants are project-bound, expire, and support one HTTP byte range", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-media-"));
  const mediaRoot = join(root, "media");
  mkdirSync(mediaRoot, { recursive: true });
  const imageSourcePath = join(root, "image-source.png");
  const imagePath = join(mediaRoot, "image.png");
  writeFileSync(imageSourcePath, validPng);
  const db = openM0Database(join(root, "app.sqlite"));
  try {
    const created = createProject({ title: "Media project" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
    const artifact: MediaArtifact = {
      artifact_id: "artifact_media_image",
      blob_id: "",
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: imagePath, mime_type: "image/png", filename: "image.png" },
      metadata: { width: 1, height: 1, duration_seconds: null, aspect_ratio: "1:1", sha256: "png-hash" },
      linked_objects: { project_id: created.project_id, shot_id: "shot_media" },
      source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: "png-hash", external_url_host: "" }
    };
    const activated = activateLocalMediaArtifact({ artifact, source_path: imageSourcePath, media_root: mediaRoot }, db);
    assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
    if (!activated.ok) return;
    const actor = actorFromSubject("auth0|jenn", ["media.read"]);
    const grant = createMediaGrant(db, { actor, project_id: created.project_id, artifact_id: artifact.artifact_id });
    assert.equal(validateMediaGrant(db, { token: grant.token, actor_hash: actor.actor_hash, project_id: created.project_id, artifact_id: artifact.artifact_id }).grant_id, grant.grant_id);
    assert.throws(() => validateMediaGrant(db, { token: grant.token, actor_hash: actor.actor_hash, project_id: "project_other", artifact_id: artifact.artifact_id }), (error) => error instanceof WebGptV4Error && error.code === "MEDIA_GRANT_INVALID");
    const otherActor = actorFromSubject("auth0|not-jenn", ["media.read"]);
    assert.throws(() => validateMediaGrant(db, { token: grant.token, actor_hash: otherActor.actor_hash, project_id: created.project_id, artifact_id: artifact.artifact_id }), (error) => error instanceof WebGptV4Error && error.code === "MEDIA_GRANT_INVALID");

    const server = createServer((request, response) => handleMediaGatewayRequest(request, response, {
      project_id: created.project_id,
      artifact_id: artifact.artifact_id,
      token: new URL(request.url ?? "/", "http://localhost").searchParams.get("grant") ?? "",
      actor_hash: actor.actor_hash,
      db,
      options: { allowed_media_roots: [mediaRoot] }
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server failed");
    const response = await fetch(`http://127.0.0.1:${address.port}/media?grant=${encodeURIComponent(grant.token)}`, { headers: { Range: "bytes=0-9" } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 10);
    const invalidRange = await fetch(`http://127.0.0.1:${address.port}/media?grant=${encodeURIComponent(grant.token)}`, { headers: { Range: "bytes=0-1,3-4" } });
    assert.equal(invalidRange.status, 416);
    assert.equal(JSON.stringify(await invalidRange.json()).includes("INVALID_MEDIA_RANGE"), true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    const expiredGrant = createMediaGrant(db, { actor, project_id: created.project_id, artifact_id: artifact.artifact_id }, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    assert.throws(() => validateMediaGrant(db, { token: expiredGrant.token, actor_hash: actor.actor_hash, project_id: created.project_id, artifact_id: artifact.artifact_id }, { now: () => new Date("2026-01-01T00:06:00.000Z") }), (error) => error instanceof WebGptV4Error && error.code === "MEDIA_GRANT_INVALID");

    const outsideRoot = join(root, "outside-media");
    const outsideSourcePath = join(root, "outside-source.png");
    writeFileSync(outsideSourcePath, alternatePng);
    const outside: MediaArtifact = { ...structuredClone(artifact), artifact_id: "artifact_outside", blob_id: "", storage: { ...artifact.storage, uri: join(outsideRoot, "outside.png") } };
    const outsideActivated = activateLocalMediaArtifact({ artifact: outside, source_path: outsideSourcePath, media_root: outsideRoot }, db);
    assert.equal(outsideActivated.ok, true, outsideActivated.ok ? undefined : outsideActivated.error.code);
    if (!outsideActivated.ok) return;
    assert.throws(() => validateMediaGrant(db, { token: grant.token, actor_hash: actor.actor_hash, project_id: created.project_id, artifact_id: outside.artifact_id }), (error) => error instanceof WebGptV4Error && error.code === "MEDIA_GRANT_INVALID");
    assert.throws(() => resolveProductionMediaPath(db, created.project_id, outside.artifact_id, { allowed_media_roots: [mediaRoot] }), (error) => error instanceof WebGptV4Error && error.code === "MEDIA_NOT_AVAILABLE");
    const restartGrant = createMediaGrant(db, { actor, project_id: created.project_id, artifact_id: artifact.artifact_id });
    assert.equal(invalidateMediaGrantsForRestart(db) >= 1, true);
    assert.throws(() => validateMediaGrant(db, { token: restartGrant.token, actor_hash: actor.actor_hash, project_id: created.project_id, artifact_id: artifact.artifact_id }), (error) => error instanceof WebGptV4Error && error.code === "MEDIA_GRANT_INVALID");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("media analysis queue runs one, waits four, and rejects the sixth", async () => {
  const queue = new MediaAnalysisQueue(1, 4, 2_000);
  const releases: Array<() => void> = [];
  const operations = Array.from({ length: 5 }, (_, index) => queue.run(() => new Promise<number>((resolveOperation) => {
    releases.push(() => resolveOperation(index));
  })));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(queue.status(), { active: 1, waiting: 4, capacity: 5 });
  await assert.rejects(() => queue.run(async () => 6), (error) => error instanceof WebGptV4Error && error.code === "MEDIA_ANALYSIS_BUSY" && error.retryable === true);
  for (let index = 0; index < 5; index += 1) {
    releases[index]();
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
  assert.deepEqual(await Promise.all(operations), [0, 1, 2, 3, 4]);
  assert.deepEqual(queue.status(), { active: 0, waiting: 0, capacity: 5 });
});

test("timed out analysis retains its slot until the underlying process settles", async () => {
  const queue = new MediaAnalysisQueue(1, 0, 10);
  let release: (() => void) | undefined;
  const operation = queue.run(() => new Promise<void>((resolveOperation) => { release = resolveOperation; }));
  await assert.rejects(operation, (error) => error instanceof WebGptV4Error && error.code === "MEDIA_ANALYSIS_TIMEOUT" && error.retryable === true);
  assert.equal(queue.status().active, 1);
  release?.();
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(queue.status().active, 0);
});

test("timed out analysis aborts the running operation and releases its slot", async () => {
  const queue = new MediaAnalysisQueue(1, 0, 10);
  let aborted = false;
  const operation = queue.run((signal) => new Promise<void>((resolveOperation) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      setImmediate(resolveOperation);
    }, { once: true });
  }));
  await assert.rejects(operation, (error) => error instanceof WebGptV4Error && error.code === "MEDIA_ANALYSIS_TIMEOUT");
  await new Promise((resolveTick) => setImmediate(resolveTick));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(aborted, true);
  assert.equal(queue.status().active, 0);
});

test("media analysis timeout includes time spent waiting in the queue", async () => {
  const queue = new MediaAnalysisQueue(1, 1, 20);
  let release: (() => void) | undefined;
  const active = queue.run(() => new Promise<void>((resolveOperation) => { release = resolveOperation; }));
  const waiting = queue.run(async () => undefined);
  const activeRejection = assert.rejects(active, (error) => error instanceof WebGptV4Error && error.code === "MEDIA_ANALYSIS_TIMEOUT");
  await assert.rejects(waiting, (error) => error instanceof WebGptV4Error && error.code === "MEDIA_ANALYSIS_TIMEOUT");
  assert.deepEqual(queue.status(), { active: 1, waiting: 0, capacity: 2 });
  await activeRejection;
  release?.();
  await new Promise((resolveTick) => setImmediate(resolveTick));
});

test("analysis cache cleanup removes only analyzer-owned hash directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "media-cache-cleanup-"));
  try {
    const generated = join(root, "a".repeat(64));
    const sourceLike = join(root, "source-media");
    mkdirSync(generated);
    mkdirSync(sourceLike);
    writeFileSync(join(generated, "frame.jpg"), Buffer.alloc(16));
    writeFileSync(join(sourceLike, "source.mp4"), Buffer.alloc(16));
    utimesSync(generated, new Date(0), new Date(0));
    const result = await cleanupMediaAnalysisCache(root, { now: Date.now(), max_age_ms: 1, max_bytes: 1 });
    assert.equal(result.removed, 1);
    assert.equal(existsSync(generated), false);
    assert.equal(existsSync(join(sourceLike, "source.mp4")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("video inspection produces a full-duration timestamp plan and paged model frames", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-video-"));
  const mediaRoot = join(root, "media");
  const analysisRoot = join(root, "analysis");
  mkdirSync(mediaRoot, { recursive: true });
  const videoSourcePath = join(root, "fixture-source.mp4");
  const videoPath = join(mediaRoot, "fixture.mp4");
  const ffmpeg = await resolveFfmpegExecutable();
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", videoSourcePath], { windowsHide: true, timeout: 30_000 });
  const db = openM0Database(join(root, "app.sqlite"));
  try {
    const created = createProject({ title: "Video project" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
    const shot: Shot = {
      shot_id: "shot_video",
      project_id: created.project_id,
      order: 1,
      status: "video_review",
      duration_seconds: 2,
      description: "Video",
      storyboard_image_artifact_id: "",
      video_prompt: "",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [{ artifact_id: "artifact_video", run_id: "run_video", attempt_number: 1, review_status: "pending" }],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    created.project.shot_ids = [shot.shot_id];
    saveProject(db, created.project);
    const artifact: MediaArtifact = {
      artifact_id: "artifact_video",
      blob_id: "",
      artifact_type: "video",
      role: "generated_clip",
      status: "active",
      storage: { uri: videoPath, mime_type: "video/mp4", filename: "fixture.mp4" },
      metadata: { width: 320, height: 180, duration_seconds: 2, aspect_ratio: "16:9", sha256: "video-hash" },
      linked_objects: { project_id: created.project_id, shot_id: shot.shot_id },
      source: { kind: "fixture_path", provider: "fake", provider_job_id: "", sha256: "video-hash", external_url_host: "" }
    };
    const activated = activateLocalMediaArtifact({ artifact, source_path: videoSourcePath, media_root: mediaRoot }, db);
    assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
    if (!activated.ok) return;
    const plan = coverageFramePlan(2, [0.75]);
    assert.equal(plan[0].timestamp_seconds, 0);
    assert.equal(plan.at(-1)?.timestamp_seconds, 2);
    assert.equal(plan.some((frame) => frame.reason === "scene_change"), true);

    const inspected = await inspectProductionMedia(db, { project_id: created.project_id, artifact_id: artifact.artifact_id, frame_limit: 3 }, actorFromSubject("auth0|jenn", ["media.read"]), {
      public_origin: "https://media.example.test",
      ffmpeg_path: ffmpeg,
      allowed_media_roots: [mediaRoot],
      analysis_root: analysisRoot
    });
    assert.equal(inspected.playback.available, true);
    assert.equal(inspected.model_images.length, 3);
    assert.equal(inspected.model_images.every((frame) => /^[a-f0-9]{64}$/.test(frame.sha256)), true);
    const analysis = inspected.data.analysis as Record<string, unknown>;
    assert.equal(analysis.direct_video_model_input, false);
    assert.equal((analysis.frame_plan as unknown[]).length >= 3, true);
    assert.equal((analysis.model_frames as Array<{ sha256: string }>).every((frame) => /^[a-f0-9]{64}$/.test(frame.sha256)), true);
    assert.equal(JSON.stringify(inspected.data).includes(mediaRoot), false);
    assert.equal(JSON.stringify(inspected.data).includes("fixture.mp4\""), true);
    const contracted = fullInspection(ok("media-contract", inspected.data));
    assert.equal(contracted.ok, true, JSON.stringify(contracted));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
