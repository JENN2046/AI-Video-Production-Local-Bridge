import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
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
import { handleWorkbenchV2Api } from "../src/http/workbenchV2Routes.js";
import { DATABASE_MIGRATIONS, migrationChecksum, runDatabaseMigrations } from "../src/storage/migrations.js";
import { installWorkbenchProductionMutationAuthority } from "../src/storage/productionMutationAuthority.js";
import type { M0Database } from "../src/storage/sqlite.js";
import { refreshWorkbenchAssemblyReadiness } from "../src/tools/workbenchDeliveryState.js";
import { getWorkbenchProjectWorkspace } from "../src/tools/workbenchV2.js";

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

function createInputClip(name: string, dimensions: string, withAudio: boolean): string {
  const directory = resolve(paths.mediaRoot, ".assembly-test-inputs");
  mkdirSync(directory, { recursive: true });
  const output = resolve(directory, `${name}_${randomUUID()}.mp4`);
  const color = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 6);
  const args = ["-f", "lavfi", "-i", `color=c=0x${color}:s=${dimensions}:r=30:d=1`];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-shortest");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push("-metadata", `comment=assembly-test-${randomUUID()}`, output);
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
  const project = created.project;
  const pairs = [
    attachAcceptedClip(db, project, 1, createInputClip("landscape-silent", "320x180", false), { width: 320, height: 180 })
  ];
  if (shotCount > 1) {
    pairs.push(attachAcceptedClip(db, project, 2, createInputClip("portrait-audio", "180x320", true), { width: 180, height: 320 }));
  }
  const delivery = refreshWorkbenchAssemblyReadiness(db, project.project_id);
  assert.equal(delivery.workflow_state, "ready_to_assemble");
  return { project, shots: pairs.map((item) => item.shot), artifacts: pairs.map((item) => item.artifact) };
}

function applyMigrationsThrough(db: DatabaseSync, through: string): void {
  installWorkbenchProductionMutationAuthority(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    BEGIN EXCLUSIVE;
  `);
  try {
    for (const migration of DATABASE_MIGRATIONS.filter((candidate) => candidate.id <= through)) {
      migration.apply(db);
      db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
        .run(migration.id, migration.name, migrationChecksum(migration));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("real assembly preserves ordered sources and atomically registers the final version", async () => {
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
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?")
      .get(fixture.project.project_id) as { workflow_state: string }).workflow_state, "assembling");

    const completed = await runWorkbenchAssemblyJob(queued.data.job.job_id, db);
    assert.equal(completed.ok, true, completed.ok ? undefined : `${completed.error.code}: ${completed.error.message}`);
    if (!completed.ok) return;
    assert.equal(completed.data.job.state, "succeeded");
    assert.equal(completed.data.job.input_fingerprint, preflight.data.input_fingerprint);
    assert.equal(completed.data.run.provider.provider, "local");
    assert.equal(completed.data.run.provider.provider_name, "local_assembly");
    const finalArtifact = getMediaArtifact(db, completed.data.final_video_artifact_id);
    assert.equal(finalArtifact?.role, "final_video");
    assert.equal(validateMp4File(finalArtifact?.storage.uri ?? "").status, "PASS");
    assert.equal(getProject(db, fixture.project.project_id)?.exports.final_video_artifact_id, completed.data.final_video_artifact_id);
    assert.deepEqual(fixture.artifacts.map((artifact) => sha256(artifact.storage.uri)), sourceHashes);

    const delivery = db.prepare(`SELECT workflow_state, current_final_artifact_id, approved_artifact_id
      FROM workbench_delivery_state WHERE project_id = ?`).get(fixture.project.project_id) as {
        workflow_state: string; current_final_artifact_id: string; approved_artifact_id: string | null;
      };
    assert.deepEqual({ ...delivery }, {
      workflow_state: "final_review",
      current_final_artifact_id: completed.data.final_video_artifact_id,
      approved_artifact_id: null
    });
    const events = db.prepare(`SELECT event_type, from_state, to_state, input_fingerprint
      FROM workbench_delivery_events WHERE project_id = ? ORDER BY created_at, rowid`)
      .all(fixture.project.project_id) as Array<{ event_type: string; from_state: string; to_state: string; input_fingerprint: string }>;
    assert.deepEqual(events.map((row) => row.event_type), ["assembly_queued", "assembly_started", "assembly_succeeded"]);
    assert.deepEqual(events.map((row) => [row.from_state, row.to_state]), [
      ["ready_to_assemble", "assembling"], ["assembling", "assembling"], ["assembling", "final_review"]
    ]);
    assert.equal(events.every((row) => row.input_fingerprint === preflight.data.input_fingerprint), true);
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
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE project_id = ?")
      .get(fixture.project.project_id) as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

for (const failure of [
  { name: "FFmpeg failure", result: { exit_code: 1, timed_out: false }, code: "ASSEMBLY_FFMPEG_FAILED" },
  { name: "hard timeout", result: { exit_code: null, timed_out: true }, code: "ASSEMBLY_TIMEOUT" }
] as const) {
  test(`assembly ${failure.name} preserves pointers and requires explicit retry`, async () => {
    const db = openM0Database();
    try {
      const fixture = setupAssemblyProject(db, 1);
      const preflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
      assert.equal(preflight.ok, true);
      if (!preflight.ok) return;
      const queued = await queueWorkbenchAssembly({
        project_id: fixture.project.project_id,
        input_fingerprint: preflight.data.input_fingerprint,
        human_confirmation: true
      }, db);
      assert.equal(queued.ok, true);
      if (!queued.ok) return;
      const completed = await runWorkbenchAssemblyJob(queued.data.job.job_id, db, {
        run_process: async () => failure.result
      });
      assert.equal(completed.ok, false);
      if (!completed.ok) assert.equal(completed.error.code, failure.code);
      const job = db.prepare(`SELECT state, error_code, terminal_event_id, finished_at
        FROM workbench_delivery_jobs WHERE job_id = ?`).get(queued.data.job.job_id) as {
          state: string; error_code: string; terminal_event_id: string | null; finished_at: string | null;
        };
      assert.equal(job.state, "failed");
      assert.equal(job.error_code, failure.code);
      assert.match(job.terminal_event_id ?? "", /^delivery_event_/);
      assert.notEqual(job.finished_at, null);
      assert.equal(getProject(db, fixture.project.project_id)?.exports.final_video_artifact_id, "");
      assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?")
        .get(fixture.project.project_id) as { workflow_state: string }).workflow_state, "ready_to_assemble");

      const retryPreflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
      assert.equal(retryPreflight.ok, true);
      if (!retryPreflight.ok) return;
      const implicitRetry = await queueWorkbenchAssembly({
        project_id: fixture.project.project_id,
        input_fingerprint: retryPreflight.data.input_fingerprint,
        human_confirmation: true
      }, db);
      assert.equal(implicitRetry.ok, false);
      if (!implicitRetry.ok) assert.equal(implicitRetry.error.code, "ASSEMBLY_RETRY_REQUIRED");
      const explicitRetry = await queueWorkbenchAssembly({
        project_id: fixture.project.project_id,
        input_fingerprint: retryPreflight.data.input_fingerprint,
        human_confirmation: true,
        retry_of_job_id: queued.data.job.job_id
      }, db);
      assert.equal(explicitRetry.ok, true);
      if (explicitRetry.ok) {
        assert.equal(explicitRetry.data.job.retry_of_job_id, queued.data.job.job_id);
        interruptUnfinishedWorkbenchDeliveryJobs(db);
      }
    } finally {
      db.close();
    }
  });
}

test("global delivery concurrency and restart recovery preserve evidence without auto retry", async () => {
  const db = openM0Database();
  try {
    const first = setupAssemblyProject(db, 1);
    const second = setupAssemblyProject(db, 1);
    const firstPreflight = await preflightWorkbenchAssembly(first.project.project_id, db);
    const secondPreflight = await preflightWorkbenchAssembly(second.project.project_id, db);
    assert.equal(firstPreflight.ok && secondPreflight.ok, true);
    if (!firstPreflight.ok || !secondPreflight.ok) return;
    const queued = await queueWorkbenchAssembly({
      project_id: first.project.project_id,
      input_fingerprint: firstPreflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    const blocked = await queueWorkbenchAssembly({
      project_id: second.project.project_id,
      input_fingerprint: secondPreflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "DELIVERY_JOB_ACTIVE");

    const stagingKey = createHash("sha256").update(queued.data.job.job_id).digest("hex");
    const jobDirectory = resolve(paths.mediaRoot, ".delivery", "assembly", stagingKey);
    mkdirSync(jobDirectory, { recursive: true });
    writeFileSync(resolve(jobDirectory, "owned.staging"), "owned", "utf8");
    const recovered = interruptUnfinishedWorkbenchDeliveryJobs(db);
    assert.deepEqual(recovered, { interrupted: 1, recovery_evidence_preserved: 1 });
    assert.equal(existsSync(jobDirectory), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_delivery_jobs WHERE project_id = ?")
      .get(first.project.project_id) as { count: number }).count, 1);
    const interrupted = db.prepare(`SELECT state, error_code, terminal_event_id, finished_at
      FROM workbench_delivery_jobs WHERE job_id = ?`).get(queued.data.job.job_id) as {
        state: string; error_code: string; terminal_event_id: string | null; finished_at: string | null;
      };
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.error_code, "PROCESS_RESTART");
    assert.notEqual(interrupted.terminal_event_id, null);
    assert.notEqual(interrupted.finished_at, null);
    const event = db.prepare("SELECT data_json FROM workbench_delivery_events WHERE event_id = ?")
      .get(interrupted.terminal_event_id) as { data_json: string };
    const recoveryData = JSON.parse(event.data_json) as { recovery_evidence_preserved: boolean; staging_key: string };
    assert.deepEqual(recoveryData, { recovery_evidence_preserved: true, staging_key: stagingKey });
    assert.equal(event.data_json.includes(resolve(paths.mediaRoot)), false);

    const retryPreflight = await preflightWorkbenchAssembly(first.project.project_id, db);
    assert.equal(retryPreflight.ok, true);
    if (!retryPreflight.ok) return;
    const retry = await queueWorkbenchAssembly({
      project_id: first.project.project_id,
      input_fingerprint: retryPreflight.data.input_fingerprint,
      human_confirmation: true,
      retry_of_job_id: queued.data.job.job_id
    }, db);
    assert.equal(retry.ok, true);
    if (retry.ok) {
      assert.equal(retry.data.job.retry_of_job_id, queued.data.job.job_id);
      interruptUnfinishedWorkbenchDeliveryJobs(db);
    }
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
    const queued = await queueWorkbenchAssembly({
      project_id: fixture.project.project_id,
      input_fingerprint: preflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
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
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  try {
    const fixture = setupAssemblyProject(db, 1);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const endpoint = `${base}/api/v2/projects/${encodeURIComponent(fixture.project.project_id)}/delivery/assembly`;
    const denied = await fetch(`${endpoint}/preflight`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
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
      state = (db.prepare("SELECT state FROM workbench_delivery_jobs WHERE job_id = ?")
        .get(startedBody.data.job.job_id) as { state: string } | undefined)?.state ?? "missing";
      if (["succeeded", "failed", "interrupted"].includes(state)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const terminal = db.prepare("SELECT state, error_code FROM workbench_delivery_jobs WHERE job_id = ?")
      .get(startedBody.data.job.job_id) as { state: string; error_code: string };
    assert.equal(state, "succeeded", `${terminal.state}: ${terminal.error_code}`);
  } finally {
    db.close();
  }
});

test("assembly filter plan preserves SHOT order, pads, and supplies missing audio", () => {
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

test("assembly staging refuses a symbolic-link Job directory when links are available", async (t) => {
  const db = openM0Database();
  let linkedPath = "";
  try {
    const fixture = setupAssemblyProject(db, 1);
    const preflight = await preflightWorkbenchAssembly(fixture.project.project_id, db);
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    const queued = await queueWorkbenchAssembly({
      project_id: fixture.project.project_id,
      input_fingerprint: preflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
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

test("migration 0014 is additive and rolls back completely on a late schema fault", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrationsThrough(db, "0013");
    db.exec("ALTER TABLE workbench_delivery_jobs ADD COLUMN started_at TEXT");
    assert.throws(() => runDatabaseMigrations(db), /duplicate column name: started_at/);
    const columns = db.prepare("PRAGMA table_info(workbench_delivery_jobs)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "input_fingerprint"), false);
    assert.equal(columns.some((column) => column.name === "finished_at"), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_id = '0014'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-8");
  } finally {
    db.close();
  }
});

test("migration 0014 freezes assembly Job identity and terminal evidence", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrationsThrough(db, "0014");
    const fixture = setupAssemblyProject(db, 1);
    const fingerprint = "a".repeat(64);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'assembling', assembly_input_fingerprint = ?
        WHERE project_id = ?`).run(fingerprint, fixture.project.project_id);
      assert.fail("Direct SQL must not create an assembling projection.");
    } catch (error) {
      db.exec("ROLLBACK");
      assert.match(error instanceof Error ? error.message : String(error), /WORKBENCH_DELIVERY_PROJECTION_OWNER_REQUIRED/);
    }

    const preflight = getAssemblyDatabasePreflight(fixture.project.project_id, db);
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    assert.equal(preflight.data.ready, true);
    const queued = await queueWorkbenchAssembly({
      project_id: fixture.project.project_id,
      input_fingerprint: preflight.data.input_fingerprint,
      human_confirmation: true
    }, db, {
      ffmpeg_path: FFMPEG,
      ffprobe_path: process.env.FFPROBE_PATH ?? "ffprobe"
    });
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    assert.throws(() => db.prepare("UPDATE workbench_delivery_jobs SET input_fingerprint = ? WHERE job_id = ?")
      .run("b".repeat(64), queued.data.job.job_id), /WORKBENCH_DELIVERY_JOB_IDENTITY_IMMUTABLE/);

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE workbench_delivery_jobs SET state = 'running', started_at = CURRENT_TIMESTAMP
        WHERE job_id = ?`).run(queued.data.job.job_id);
      db.prepare(`UPDATE workbench_delivery_jobs SET state = 'failed', terminal_event_id = 'missing_terminal_event',
        error_code = 'TEST_FAILURE', finished_at = CURRENT_TIMESTAMP WHERE job_id = ?`).run(queued.data.job.job_id);
      assert.throws(() => db.exec("COMMIT"), /FOREIGN KEY constraint failed/);
      db.exec("ROLLBACK");
    } catch (error) {
      if ((db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    const preserved = db.prepare("SELECT state, terminal_event_id, started_at, finished_at FROM workbench_delivery_jobs WHERE job_id = ?")
      .get(queued.data.job.job_id) as { state: string; terminal_event_id: string | null; started_at: string | null; finished_at: string | null };
    assert.deepEqual({ ...preserved }, { state: "queued", terminal_event_id: null, started_at: null, finished_at: null });
    interruptUnfinishedWorkbenchDeliveryJobs(db);
  } finally {
    db.close();
  }
});
