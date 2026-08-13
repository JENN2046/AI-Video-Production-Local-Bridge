import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

import {
  buildFinalAssemblyFfmpegArgs,
  buildStoryboardApprovedShot,
  createProject,
  getAssemblyDatabasePreflight,
  getMediaArtifact,
  getProject,
  interruptUnfinishedWorkbenchDeliveryJobs,
  openM0Database,
  parseAssemblyResolution,
  paths,
  preflightWorkbenchAssembly,
  queueWorkbenchAssembly,
  registerMediaArtifact,
  runWorkbenchAssemblyJob,
  saveProject,
  saveShot,
  validateMp4File,
  type AssemblyInputSnapshot,
  type MediaArtifact,
  type Project,
  type Shot
} from "../src/index.js";
import { getWorkbenchProjectWorkspace } from "../src/tools/workbenchV2.js";
import type { M0Database } from "../src/storage/sqlite.js";
import { handleWorkbenchV2Api } from "../src/http/workbenchV2Routes.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function runFixtureFfmpeg(args: string[]): void {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "ignore",
    windowsHide: true
  });
  assert.equal(result.status, 0, "FFmpeg fixture creation should succeed");
}

function createInputClip(
  name: string,
  dimensions: string,
  _color: string,
  withAudio: boolean
): string {
  const directory = resolve(paths.mediaRoot, ".assembly-test-inputs");
  mkdirSync(directory, { recursive: true });
  const output = resolve(directory, `${name}_${randomUUID()}.mp4`);
  const uniqueColor = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 6);
  const args = ["-f", "lavfi", "-i", `color=c=0x${uniqueColor}:s=${dimensions}:r=30:d=1`];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-shortest");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push("-metadata", `comment=assembly-test-${randomUUID()}`);
  args.push(output);
  runFixtureFfmpeg(args);
  return output;
}

function attachAcceptedClip(
  db: M0Database,
  project: Project,
  order: number,
  sourcePath: string,
  dimensions: { width: number; height: number },
  durationSeconds = 1
): { shot: Shot; artifact: MediaArtifact } {
  const sourceSha = sha256(sourcePath);
  const priorBlob = db.prepare("SELECT blob_id FROM media_blobs WHERE sha256 = ?").get(sourceSha) as { blob_id: string } | undefined;
  if (priorBlob) throw new Error(`TEST_INPUT_SHA_COLLISION:${priorBlob.blob_id}`);
  const shot = buildStoryboardApprovedShot({
    project_id: project.project_id,
    order,
    duration_seconds: durationSeconds,
    storyboard_image_artifact_id: "",
    video_prompt: `Assembly SHOT ${order}`
  });
  const registered = registerMediaArtifact({
    artifact_type: "video",
    role: "generated_clip",
    source: { kind: "provider_output_file", path: sourcePath, mime_type: "video/mp4" },
    linked_objects: { project_id: project.project_id, shot_id: shot.shot_id },
    metadata: {
      width: dimensions.width,
      height: dimensions.height,
      aspect_ratio: `${dimensions.width}:${dimensions.height}`
    },
    provenance: { provider: "mock", provider_job_id: `fixture_${project.project_id}_${order}` }
  }, db);
  if (!registered.ok) throw new Error(`${registered.error.code}: ${registered.error.message}`);
  assert.equal(registered.ok, true);
  shot.accepted_clip_artifact_id = registered.artifact.artifact_id;
  shot.clip_versions = [{
    artifact_id: registered.artifact.artifact_id,
    run_id: `run_fixture_${randomUUID()}`,
    attempt_number: 1,
    review_status: "approved"
  }];
  shot.status = "approved";
  shot.review.approval_status = "approved";
  saveShot(db, shot);
  project.shot_ids.push(shot.shot_id);
  saveProject(db, project);
  return { shot, artifact: registered.artifact };
}

function setupAssemblyProject(db: M0Database, shotCount = 2): {
  project: Project;
  shots: Shot[];
  artifacts: MediaArtifact[];
} {
  const created = createProject({
    title: `Assembly ${randomUUID().slice(0, 8)}`,
    video_spec: { duration_seconds: shotCount, aspect_ratio: "16:9", resolution: "320x180" }
  }, db);
  if (!created.ok) throw new Error(created.error.message);
  assert.equal(created.ok, true);
  const project = created.project;
  const first = attachAcceptedClip(db, project, 1, createInputClip("landscape-silent", "320x180", "red", false), { width: 320, height: 180 });
  const pairs = [first];
  if (shotCount > 1) {
    pairs.push(attachAcceptedClip(db, project, 2, createInputClip("portrait-audio", "180x320", "blue", true), { width: 180, height: 320 }));
  }
  return { project, shots: pairs.map((item) => item.shot), artifacts: pairs.map((item) => item.artifact) };
}

test("real assembly preserves ordered sources, supplies silence, and atomically registers a final version", async () => {
  const db = openM0Database();
  try {
    const fixture = setupAssemblyProject(db);
    const sourceHashes = fixture.artifacts.map((artifact) => sha256(artifact.storage.uri));
    const preflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    assert.equal(preflight.data.ready, true);
    assert.equal(preflight.data.tooling_checked, true);
    assert.deepEqual(preflight.data.target, { width: 320, height: 180, fps: 30, video_codec: "h264", audio_codec: "aac" });
    assert.deepEqual(preflight.data.shots.map((shot) => shot.order), [1, 2]);

    const deliveryBefore = getWorkbenchProjectWorkspace(fixture.project.project_id, "delivery", db);
    assert.equal(deliveryBefore.ok, true);
    assert.equal(JSON.stringify(deliveryBefore).includes(resolve(paths.mediaRoot)), false);
    if (deliveryBefore.ok) {
      const dtoPreflight = deliveryBefore.data.assembly_preflight as { input_fingerprint: string };
      assert.equal(dtoPreflight.input_fingerprint, preflight.data.input_fingerprint);
    }

    const queued = await queueWorkbenchAssembly({
      project_id: fixture.project.project_id,
      input_fingerprint: preflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    assert.equal("input_json" in queued.data.job, false);
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?").get(fixture.project.project_id) as { workflow_state: string }).workflow_state, "assembling");

    const completed = await runWorkbenchAssemblyJob(queued.data.job.job_id, db);
    assert.equal(completed.ok, true);
    if (!completed.ok) return;
    assert.equal(completed.data.job.state, "succeeded");
    assert.equal(completed.data.run.provider.provider, "local");
    assert.equal(completed.data.run.provider.provider_name, "local_assembly");
    assert.equal(completed.data.run.provider.model_name, "final-assembly-v1");
    const finalArtifact = getMediaArtifact(db, completed.data.final_video_artifact_id);
    assert.equal(finalArtifact?.role, "final_video");
    assert.equal(validateMp4File(finalArtifact?.storage.uri ?? "").status, "PASS");
    assert.equal(getProject(db, fixture.project.project_id)?.exports.final_video_artifact_id, completed.data.final_video_artifact_id);
    assert.deepEqual(fixture.artifacts.map((artifact) => sha256(artifact.storage.uri)), sourceHashes);
    const delivery = db.prepare("SELECT workflow_state, current_final_artifact_id, approved_artifact_id FROM workbench_delivery_state WHERE project_id = ?")
      .get(fixture.project.project_id) as { workflow_state: string; current_final_artifact_id: string; approved_artifact_id: string | null };
    assert.equal(delivery.workflow_state, "final_review");
    assert.equal(delivery.current_final_artifact_id, completed.data.final_video_artifact_id);
    assert.equal(delivery.approved_artifact_id, null);
    assert.deepEqual((db.prepare("SELECT event_type FROM workbench_delivery_events WHERE project_id = ? ORDER BY created_at, rowid")
      .all(fixture.project.project_id) as Array<{ event_type: string }>).map((row) => row.event_type), ["assembly_queued", "assembly_started", "assembly_succeeded"]);
  } finally {
    db.close();
  }
});

test("assembly preflight rejects missing clips and immutable Blob drift", async () => {
  const db = openM0Database();
  try {
    const fixture = setupAssemblyProject(db, 1);
    const shot = fixture.shots[0];
    shot.accepted_clip_artifact_id = "";
    saveShot(db, shot);
    const missing = getAssemblyDatabasePreflight(fixture.project.project_id, db);
    assert.equal(missing.ok, true);
    if (missing.ok) {
      assert.equal(missing.data.ready, false);
      assert.equal(missing.data.blockers.some((item) => item.code === "SHOT_ACCEPTED_CLIP_MISSING"), true);
    }
    shot.accepted_clip_artifact_id = fixture.artifacts[0].artifact_id;
    saveShot(db, shot);
    writeFileSync(fixture.artifacts[0].storage.uri, "drifted assembly source", "utf8");
    const drift = await preflightWorkbenchAssembly(fixture.project.project_id, db);
    assert.equal(drift.ok, true);
    if (drift.ok) {
      assert.equal(drift.data.ready, false);
      assert.equal(drift.data.blockers.length > 0, true);
    }
  } finally {
    db.close();
  }
});

test("assembly queue rejects stale fingerprints without creating a Job", async () => {
  const db = openM0Database();
  try {
    const fixture = setupAssemblyProject(db, 1);
    const preflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    fixture.shots[0].duration_seconds = 0.75;
    saveShot(db, fixture.shots[0]);
    const queued = await queueWorkbenchAssembly({
      project_id: fixture.project.project_id,
      input_fingerprint: preflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
    assert.equal(queued.ok, false);
    if (!queued.ok) assert.equal(queued.error.code, "ASSEMBLY_INPUT_CHANGED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE project_id = ?").get(fixture.project.project_id) as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

for (const failure of [
  { name: "FFmpeg failure", result: { exit_code: 1, timed_out: false }, code: "ASSEMBLY_FFMPEG_FAILED" },
  { name: "hard timeout", result: { exit_code: null, timed_out: true }, code: "ASSEMBLY_TIMEOUT" }
] as const) {
  test(`assembly ${failure.name} leaves project pointers unchanged and requires explicit retry`, async () => {
    const db = openM0Database();
    try {
      const fixture = setupAssemblyProject(db, 1);
      const preflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
      assert.equal(preflight.ok, true);
      if (!preflight.ok) return;
      const queued = await queueWorkbenchAssembly({ project_id: fixture.project.project_id, input_fingerprint: preflight.data.input_fingerprint, human_confirmation: true }, db);
      assert.equal(queued.ok, true);
      if (!queued.ok) return;
      const completed = await runWorkbenchAssemblyJob(queued.data.job.job_id, db, {
        run_process: async () => failure.result
      });
      assert.equal(completed.ok, false);
      if (!completed.ok) assert.equal(completed.error.code, failure.code);
      const job = db.prepare("SELECT state, error_code FROM workbench_delivery_jobs WHERE job_id = ?").get(queued.data.job.job_id) as { state: string; error_code: string };
      assert.equal(job.state, "failed");
      assert.equal(job.error_code, failure.code);
      assert.equal(getProject(db, fixture.project.project_id)?.exports.final_video_artifact_id, "");
      assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?").get(fixture.project.project_id) as { workflow_state: string }).workflow_state, "ready_to_assemble");
    } finally {
      db.close();
    }
  });
}

test("global delivery concurrency and restart recovery interrupt without auto retry", async () => {
  const db = openM0Database();
  try {
    const first = setupAssemblyProject(db, 1);
    const second = setupAssemblyProject(db, 1);
    const firstPreflight = await preflightWorkbenchAssembly(first.project.project_id, db);
    const secondPreflight = await preflightWorkbenchAssembly(second.project.project_id, db);
    assert.equal(firstPreflight.ok && secondPreflight.ok, true);
    if (!firstPreflight.ok || !secondPreflight.ok) return;
    const queued = await queueWorkbenchAssembly({ project_id: first.project.project_id, input_fingerprint: firstPreflight.data.input_fingerprint, human_confirmation: true }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    const blocked = await queueWorkbenchAssembly({ project_id: second.project.project_id, input_fingerprint: secondPreflight.data.input_fingerprint, human_confirmation: true }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "DELIVERY_JOB_ACTIVE");
    const jobDirectory = resolve(paths.mediaRoot, ".delivery", "assembly", createHash("sha256").update(queued.data.job.job_id).digest("hex"));
    mkdirSync(jobDirectory, { recursive: true });
    writeFileSync(resolve(jobDirectory, "owned.staging"), "owned", "utf8");
    const recovered = interruptUnfinishedWorkbenchDeliveryJobs(db);
    assert.deepEqual(recovered, { interrupted: 1, staging_cleanup_failed: 0 });
    assert.equal(existsSync(jobDirectory), false);
    const interrupted = db.prepare("SELECT state, error_code FROM workbench_delivery_jobs WHERE job_id = ?").get(queued.data.job.job_id) as { state: string; error_code: string };
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.error_code, "PROCESS_RESTART");
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?").get(first.project.project_id) as { workflow_state: string }).workflow_state, "ready_to_assemble");
  } finally {
    db.close();
  }
});

test("FFmpeg output exclusivity keeps an existing staging output unchanged", async () => {
  const db = openM0Database();
  try {
    const fixture = setupAssemblyProject(db, 1);
    const preflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    const queued = await queueWorkbenchAssembly({ project_id: fixture.project.project_id, input_fingerprint: preflight.data.input_fingerprint, human_confirmation: true }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    const sentinel = Buffer.from("existing-output-must-not-change", "utf8");
    let checked = false;
    const completed = await runWorkbenchAssemblyJob(queued.data.job.job_id, db, {
      before_render: (outputPath) => writeFileSync(outputPath, sentinel, { flag: "wx" }),
      run_process: async (command, args) => {
        assert.equal(args.includes("-n"), true);
        const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
        const outputPath = args.at(-1) ?? "";
        checked = readFileSync(outputPath).equals(sentinel);
        return { exit_code: result.status, timed_out: false };
      }
    });
    assert.equal(completed.ok, false);
    assert.equal(checked, true);
    if (!completed.ok) assert.equal(completed.error.code, "ASSEMBLY_OUTPUT_INVALID");
  } finally {
    db.close();
  }
});

test("assembly HTTP preflight and start require nonce and return a persistent 202 Job", async (t) => {
  const db = openM0Database();
  const nonce = `assembly-nonce-${randomUUID()}`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void handleWorkbenchV2Api(request, response, url, nonce).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  try {
    const fixture = setupAssemblyProject(db, 1);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const endpoint = `${base}/api/v2/projects/${encodeURIComponent(fixture.project.project_id)}/delivery/assembly`;
    const denied = await fetch(`${endpoint}/preflight`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 403);
    const prepared = await fetch(`${endpoint}/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-h1-action-nonce": nonce },
      body: "{}"
    });
    assert.equal(prepared.status, 200);
    const preparedBody = await prepared.json() as { ok: true; data: { ready: boolean; input_fingerprint: string } };
    assert.equal(preparedBody.data.ready, true);
    const started = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-h1-action-nonce": nonce },
      body: JSON.stringify({ input_fingerprint: preparedBody.data.input_fingerprint, human_confirmation: true })
    });
    assert.equal(started.status, 202);
    const startedBody = await started.json() as { ok: true; data: { job: { job_id: string; state: string } } };
    assert.equal(startedBody.data.job.state, "queued");
    assert.equal(JSON.stringify(startedBody).includes("input_json"), false);
    const deadline = Date.now() + 20_000;
    let state = "queued";
    while (Date.now() < deadline) {
      state = (db.prepare("SELECT state FROM workbench_delivery_jobs WHERE job_id = ?").get(startedBody.data.job.job_id) as { state: string } | undefined)?.state ?? "missing";
      if (["succeeded", "failed", "interrupted"].includes(state)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(state, "succeeded");
  } finally {
    db.close();
  }
});

test("assembly filter plan preserves SHOT order, pads instead of cropping, and creates missing audio", () => {
  assert.deepEqual(parseAssemblyResolution("1080p", "9:16"), { width: 1080, height: 1920 });
  assert.deepEqual(parseAssemblyResolution("720:1280", "9:16"), { width: 720, height: 1280 });
  const snapshot: AssemblyInputSnapshot = {
    contract_version: "final-assembly-v1",
    project: {
      project_id: "project_plan",
      declared_duration_seconds: 2,
      aspect_ratio: "16:9",
      resolution: "320x180",
      target_width: 320,
      target_height: 180
    },
    shots: [
      { shot_id: "shot_1", order: 1, artifact_id: "artifact_1", blob_sha256: "a".repeat(64), duration_seconds: 1, source_duration_seconds: 1 },
      { shot_id: "shot_2", order: 2, artifact_id: "artifact_2", blob_sha256: "b".repeat(64), duration_seconds: 1, source_duration_seconds: 1 }
    ],
    expected_duration_seconds: 2
  };
  const args = buildFinalAssemblyFfmpegArgs([
    { shot_id: "shot_1", order: 1, artifact_id: "artifact_1", path: "first.mp4", duration_seconds: 1, has_audio: false },
    { shot_id: "shot_2", order: 2, artifact_id: "artifact_2", path: "second.mp4", duration_seconds: 1, has_audio: true }
  ], snapshot, "output.mp4");
  assert.deepEqual(args.filter((item, index) => args[index - 1] === "-i"), ["first.mp4", "second.mp4"]);
  assert.equal(args.includes("-n"), true);
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /force_original_aspect_ratio=decrease/);
  assert.match(filter, /pad=320:180/);
  assert.match(filter, /anullsrc=channel_layout=stereo:sample_rate=48000/);
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1/);
});

test("assembly staging refuses a symbolic-link Job directory when the platform supports links", async (t) => {
  const db = openM0Database();
  let linkedPath = "";
  try {
    const fixture = setupAssemblyProject(db, 1);
    const preflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    const queued = await queueWorkbenchAssembly({ project_id: fixture.project.project_id, input_fingerprint: preflight.data.input_fingerprint, human_confirmation: true }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    const assemblyRoot = resolve(paths.mediaRoot, ".delivery", "assembly");
    mkdirSync(assemblyRoot, { recursive: true });
    const outside = resolve(paths.dataRoot, `assembly-link-target-${randomUUID()}`);
    mkdirSync(outside);
    linkedPath = resolve(assemblyRoot, createHash("sha256").update(queued.data.job.job_id).digest("hex"));
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, linkedPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      interruptUnfinishedWorkbenchDeliveryJobs(db);
      t.skip("Directory links are unavailable on this platform.");
      return;
    }
    const completed = await runWorkbenchAssemblyJob(queued.data.job.job_id, db);
    assert.equal(completed.ok, false);
    if (!completed.ok) assert.equal(completed.error.code, "ASSEMBLY_OUTPUT_INVALID");
    assert.equal(existsSync(linkedPath), true);
  } finally {
    if (linkedPath && existsSync(linkedPath)) unlinkSync(linkedPath);
    db.close();
  }
});
