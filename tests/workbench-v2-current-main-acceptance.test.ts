import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  buildStoryboardApprovedShot,
  closeoutWorkbenchDelivery,
  createProject,
  decideWorkbenchFinalReview,
  getMediaArtifact,
  getProject,
  getShot,
  listWorkbenchFinalVersions,
  paths,
  preflightWorkbenchAssembly,
  queueWorkbenchAssembly,
  queueWorkbenchExport,
  refreshWorkbenchDeliveryAssemblyReadiness,
  registerMediaArtifact,
  runWorkbenchAssemblyJob,
  runWorkbenchExportJob,
  saveProject,
  saveShot
} from "../src/index.js";
import { checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { downloadProviderOutputToArtifact } from "../src/tools/providerOutputDownloader.js";
import { saveStoryboardPackage } from "../src/tools/storyboardPackages.js";
import type { VideoProviderAdapter } from "../src/tools/videoProviderAdapters.js";
import {
  confirmWorkbenchGeneration,
  preflightWorkbenchGeneration,
  reconcileGenerationJob,
  runWorkbenchGenerationOnce,
  type WorkbenchGenerationDependencies
} from "../src/tools/workbenchGeneration.js";
import { decideWorkbenchClip, getWorkbenchProjectWorkspace } from "../src/tools/workbenchV2.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

function createProviderFixture(targetPath: string, color: string): Buffer {
  mkdirSync(dirname(targetPath), { recursive: true });
  const result = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=480x854:r=30:d=6`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an",
    "-movflags", "+faststart", "-metadata", `comment=current-main-${randomUUID()}`,
    targetPath
  ], { stdio: "ignore", windowsHide: true });
  assert.equal(result.status, 0, "FFmpeg should create the synthetic Provider fixture");
  return readFileSync(targetPath);
}

function providerEnvironment(): NodeJS.ProcessEnv {
  return {
    REAL_PROVIDER_ENABLED: "true",
    M1_REAL_PROVIDER: "runninghub",
    M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
    M1_REAL_PROVIDER_COST_ACK: "true",
    RUNNINGHUB_API_KEY: "synthetic-current-main-test-key"
  };
}

const quoteFetch: typeof fetch = async (input) => String(input).includes("price-preview")
  ? new Response(JSON.stringify({ errorCode: "", estimatedPrice: 0.08, currency: "CNY" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })
  : new Response(JSON.stringify({ code: 0, data: { remainMoney: "10", currency: "CNY" } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

async function prepareGeneration(db: M0Database, projectId: string, shotId: string) {
  const prepared = await preflightWorkbenchGeneration({
    project_id: projectId,
    shot_id: shotId,
    account_label: "personal",
    budget_limit_value: 1
  }, db, { env: providerEnvironment(), fetch_impl: quoteFetch });
  assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.error.code);
  const confirmed = confirmWorkbenchGeneration({
    intent_id: prepared.data.intent.intent_id,
    budget_limit_value: 1,
    cost_confirmed: true,
    human_confirmation: true
  }, db);
  assert.equal(confirmed.ok, true, confirmed.ok ? undefined : confirmed.error.code);
  return {
    intent_id: prepared.data.intent.intent_id,
    run_id: confirmed.data.run_id,
    job_id: confirmed.data.job_id
  };
}

function fixtureDownloader(bytesByTask: ReadonlyMap<string, Buffer>, storageRoot: string): typeof downloadProviderOutputToArtifact {
  return async (input, db, runtime = {}) => {
    const bytes = bytesByTask.get(input.provider_job_id);
    assert.ok(bytes, `missing synthetic bytes for ${input.provider_job_id}`);
    return downloadProviderOutputToArtifact({ ...input, storage_directory: storageRoot }, db, {
      ...runtime,
      storage_root: storageRoot,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength) }
      })
    });
  };
}

function deliveryState(db: M0Database, projectId: string): string {
  return (db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?")
    .get(projectId) as { workflow_state: string }).workflow_state;
}

function isInside(child: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

test("current-main fixture completes generation, reconciliation, targeted regeneration, assembly, export, and closeout", {
  timeout: 240_000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-current-main-acceptance-"));
  const sqlitePath = join(root, "app.sqlite");
  const providerRoot = join(root, "provider-output");
  const firstTaskId = "task-current-main-reconciled";
  const secondTaskId = "task-current-main-regenerated";
  const providerBytes = new Map([
    [firstTaskId, createProviderFixture(join(root, "provider-first.mp4"), "0x274690")],
    [secondTaskId, createProviderFixture(join(root, "provider-second.mp4"), "0xE07A5F")]
  ]);
  const generatedMediaPaths = new Set<string>();
  let exportProjectDirectory = "";
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const created = createProject({
      title: "Current-main complete fixture",
      video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" }
    }, db);
    assert.equal(created.ok, true, created.ok ? undefined : created.error.code);
    const project = created.project;
    exportProjectDirectory = resolve(paths.exportsRoot, project.project_id);
    const shot = buildStoryboardApprovedShot({
      project_id: project.project_id,
      order: 1,
      duration_seconds: 6,
      storyboard_image_artifact_id: "",
      video_prompt: "A controlled camera move for current-main acceptance."
    });
    const storyboard = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: project.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(storyboard.ok, true, storyboard.ok ? undefined : storyboard.error.code);
    shot.storyboard_image_artifact_id = storyboard.artifact.artifact_id;
    saveShot(db, shot);
    const packageId = `package_${randomUUID()}`;
    saveStoryboardPackage(db, {
      storyboard_package_id: packageId,
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [{
        shot_id: shot.shot_id,
        order: shot.order,
        duration_seconds: shot.duration_seconds,
        description: shot.description,
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt
      }],
      user_approval: { storyboard_approved: true }
    });
    project.shot_ids = [shot.shot_id];
    project.active_storyboard_package_id = packageId;
    project.status = "storyboard_approved";
    saveProject(db, project);

    let wallTime = Date.now();
    let monotonicTime = 10_000;
    const clock = {
      now: () => new Date(wallTime),
      monotonic_now_ms: () => monotonicTime,
      poll_interval_ms: 10,
      sqlite_path: sqlitePath,
      env: providerEnvironment(),
      provider_output_storage_directory: providerRoot,
      download_provider_output: fixtureDownloader(providerBytes, providerRoot)
    } satisfies WorkbenchGenerationDependencies;

    const firstGeneration = await prepareGeneration(db, project.project_id, shot.shot_id);
    let ambiguousSubmitCalls = 0;
    const ambiguousAdapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        ambiguousSubmitCalls += 1;
        return {
          ok: false as const,
          error: {
            code: "PROVIDER_TIMEOUT",
            message: "Synthetic unknown submission outcome.",
            retryable: true,
            submission_outcome_unknown: true
          }
        };
      },
      pollStatus: async () => { throw new Error("poll must wait for explicit reconciliation"); },
      fetchOutput: async () => { throw new Error("output must wait for explicit reconciliation"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(firstGeneration.intent_id, {
      allow_submit: true,
      dependencies: { ...clock, adapter_factory: () => ambiguousAdapter }
    });
    assert.equal(ambiguousSubmitCalls, 1);
    const reconciliationJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(firstGeneration.job_id) as { state: string; reconciliation_reason: string };
    assert.deepEqual({ ...reconciliationJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_SUBMIT_OUTCOME_UNKNOWN"
    });
    const attached = reconcileGenerationJob(firstGeneration.job_id, {
      decision: "attach_existing_task",
      provider_task_id: firstTaskId,
      human_confirmation: true
    }, db, { env: providerEnvironment(), now: clock.now });
    assert.equal(attached.ok, true, attached.ok ? undefined : attached.error.code);

    let firstPollCalls = 0;
    const firstCompletionAdapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("reconciled task must not be submitted again"); },
      pollStatus: async () => {
        firstPollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: firstTaskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://cdn.example.test/current-main-first.mp4"
        };
      },
      fetchOutput: async () => { throw new Error("worker downloader owns output retrieval"); }
    } as unknown as VideoProviderAdapter;
    wallTime += 100;
    monotonicTime += 100;
    await runWorkbenchGenerationOnce(firstGeneration.intent_id, {
      allow_submit: false,
      dependencies: { ...clock, adapter_factory: () => firstCompletionAdapter }
    });
    assert.equal(firstPollCalls, 1);
    const firstIntent = db.prepare("SELECT status, output_artifact_id FROM generation_intents WHERE intent_id = ?")
      .get(firstGeneration.intent_id) as { status: string; output_artifact_id: string };
    assert.equal(firstIntent.status, "succeeded");
    assert.notEqual(firstIntent.output_artifact_id, "");
    const firstArtifact = getMediaArtifact(db, firstIntent.output_artifact_id);
    assert.ok(firstArtifact);
    generatedMediaPaths.add(firstArtifact.storage.uri);
    const firstAccepted = decideWorkbenchClip(project.project_id, {
      shot_id: shot.shot_id,
      artifact_id: firstIntent.output_artifact_id,
      decision: "approved"
    }, db);
    assert.equal(firstAccepted.ok, true, firstAccepted.ok ? undefined : firstAccepted.error.code);

    const compactProject = getProject(db, project.project_id);
    assert.ok(compactProject);
    compactProject.video_spec.resolution = "480x854";
    saveProject(db, compactProject);
    assert.equal(refreshWorkbenchDeliveryAssemblyReadiness(db, project.project_id)?.workflow_state, "ready_to_assemble");
    const firstAssemblyPreflight = await preflightWorkbenchAssembly(project.project_id, db);
    assert.equal(firstAssemblyPreflight.ok, true, firstAssemblyPreflight.ok ? undefined : firstAssemblyPreflight.error.code);
    const firstAssemblyQueue = await queueWorkbenchAssembly({
      project_id: project.project_id,
      input_fingerprint: firstAssemblyPreflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
    assert.equal(firstAssemblyQueue.ok, true, firstAssemblyQueue.ok ? undefined : firstAssemblyQueue.error.code);
    const firstAssembly = await runWorkbenchAssemblyJob(firstAssemblyQueue.data.job.job_id, db);
    assert.equal(firstAssembly.ok, true, firstAssembly.ok ? undefined : firstAssembly.error.code);
    const firstFinal = getMediaArtifact(db, firstAssembly.data.final_video_artifact_id);
    assert.ok(firstFinal);
    generatedMediaPaths.add(firstFinal.storage.uri);
    assert.equal(deliveryState(db, project.project_id), "final_review");

    const targeted = decideWorkbenchFinalReview({
      project_id: project.project_id,
      artifact_id: firstFinal.artifact_id,
      decision: "regenerate_shots",
      shot_ids: [shot.shot_id],
      reason: "Tighten the camera motion for the final cut.",
      human_confirmation: true
    }, db);
    assert.equal(targeted.ok, true, targeted.ok ? undefined : targeted.error.code);
    assert.equal(targeted.data.regeneration_requests.length, 1);
    assert.equal(deliveryState(db, project.project_id), "revision_requested");
    assert.equal(getShot(db, shot.shot_id)?.accepted_clip_artifact_id, "");

    const secondGeneration = await prepareGeneration(db, project.project_id, shot.shot_id);
    let secondSubmitCalls = 0;
    let secondPollCalls = 0;
    const secondAdapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        secondSubmitCalls += 1;
        return { ok: true as const, provider_job_id: secondTaskId, provider_status: "PENDING", sanitized_request: {} };
      },
      pollStatus: async () => {
        secondPollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: secondTaskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://cdn.example.test/current-main-regenerated.mp4"
        };
      },
      fetchOutput: async () => { throw new Error("worker downloader owns output retrieval"); }
    } as unknown as VideoProviderAdapter;
    wallTime += 100;
    monotonicTime += 100;
    await runWorkbenchGenerationOnce(secondGeneration.intent_id, {
      allow_submit: true,
      dependencies: { ...clock, adapter_factory: () => secondAdapter }
    });
    wallTime += 100;
    monotonicTime += 100;
    await runWorkbenchGenerationOnce(secondGeneration.intent_id, {
      allow_submit: false,
      dependencies: { ...clock, adapter_factory: () => secondAdapter }
    });
    assert.deepEqual({ secondSubmitCalls, secondPollCalls }, { secondSubmitCalls: 1, secondPollCalls: 1 });
    const secondIntent = db.prepare("SELECT status, output_artifact_id FROM generation_intents WHERE intent_id = ?")
      .get(secondGeneration.intent_id) as { status: string; output_artifact_id: string };
    assert.equal(secondIntent.status, "succeeded");
    const regeneratedArtifact = getMediaArtifact(db, secondIntent.output_artifact_id);
    assert.ok(regeneratedArtifact);
    generatedMediaPaths.add(regeneratedArtifact.storage.uri);
    const secondAccepted = decideWorkbenchClip(project.project_id, {
      shot_id: shot.shot_id,
      artifact_id: secondIntent.output_artifact_id,
      decision: "approved"
    }, db);
    assert.equal(secondAccepted.ok, true, secondAccepted.ok ? undefined : secondAccepted.error.code);
    assert.equal(deliveryState(db, project.project_id), "ready_to_assemble");

    const secondAssemblyPreflight = await preflightWorkbenchAssembly(project.project_id, db);
    assert.equal(secondAssemblyPreflight.ok, true, secondAssemblyPreflight.ok ? undefined : secondAssemblyPreflight.error.code);
    const secondAssemblyQueue = await queueWorkbenchAssembly({
      project_id: project.project_id,
      input_fingerprint: secondAssemblyPreflight.data.input_fingerprint,
      human_confirmation: true
    }, db);
    assert.equal(secondAssemblyQueue.ok, true, secondAssemblyQueue.ok ? undefined : secondAssemblyQueue.error.code);
    const secondAssembly = await runWorkbenchAssemblyJob(secondAssemblyQueue.data.job.job_id, db);
    assert.equal(secondAssembly.ok, true, secondAssembly.ok ? undefined : secondAssembly.error.code);
    const currentFinal = getMediaArtifact(db, secondAssembly.data.final_video_artifact_id);
    assert.ok(currentFinal);
    generatedMediaPaths.add(currentFinal.storage.uri);
    assert.notEqual(currentFinal.artifact_id, firstFinal.artifact_id);
    assert.equal(getMediaArtifact(db, firstFinal.artifact_id)?.status, "active");
    assert.equal(listWorkbenchFinalVersions(db, project.project_id).length, 2);

    const acceptedFinal = decideWorkbenchFinalReview({
      project_id: project.project_id,
      artifact_id: currentFinal.artifact_id,
      decision: "accept",
      human_confirmation: true
    }, db);
    assert.equal(acceptedFinal.ok, true, acceptedFinal.ok ? undefined : acceptedFinal.error.code);
    const queuedExport = queueWorkbenchExport({
      project_id: project.project_id,
      artifact_id: currentFinal.artifact_id,
      human_confirmation: true
    }, db);
    assert.equal(queuedExport.ok, true, queuedExport.ok ? undefined : queuedExport.error.code);
    if (!queuedExport.data.job) throw new Error("EXPORT_JOB_NOT_CREATED");
    const exported = await runWorkbenchExportJob(queuedExport.data.job.job_id, db);
    assert.equal(exported.ok, true, exported.ok ? undefined : exported.error.code);
    const exportedPath = resolve(paths.exportsRoot, project.project_id, basename(exported.data.export.relative_path));
    assert.equal(existsSync(exportedPath), true);
    assert.equal(createHash("sha256").update(readFileSync(exportedPath)).digest("hex"), exported.data.export.sha256);
    assert.equal(deliveryState(db, project.project_id), "exported");

    const inexactCloseout = closeoutWorkbenchDelivery({
      project_id: project.project_id,
      confirmation_phrase: "确认结案 "
    }, db);
    assert.equal(inexactCloseout.ok, false);
    if (!inexactCloseout.ok) assert.equal(inexactCloseout.error.code, "CLOSEOUT_CONFIRMATION_REQUIRED");
    const closed = closeoutWorkbenchDelivery({
      project_id: project.project_id,
      confirmation_phrase: "确认结案"
    }, db);
    assert.equal(closed.ok, true, closed.ok ? undefined : closed.error.code);
    assert.equal(closed.data.delivery.workflow_state, "closed");
    assert.equal(getProject(db, project.project_id)?.status, "final_approved");

    const workspace = getWorkbenchProjectWorkspace(project.project_id, "delivery", db);
    assert.equal(workspace.ok, true, workspace.ok ? undefined : workspace.error.code);
    assert.equal(workspace.data.workflow_state, "closed");
    assert.equal(workspace.data.active_job, null);
    assert.equal((workspace.data.final_versions as unknown[]).length, 2);
    assert.equal((workspace.data.current_final_version as { artifact_id: string }).artifact_id, currentFinal.artifact_id);
    assert.equal((workspace.data.final_review as { approved_artifact_id: string }).approved_artifact_id, currentFinal.artifact_id);
    assert.equal((workspace.data.latest_export as { export_id: string }).export_id, exported.data.export.export_id);
    assert.equal((workspace.data.closeout_receipt as { export_id: string }).export_id, exported.data.export.export_id);
    const generationJobs = db.prepare(`SELECT job.state FROM generation_jobs job
        JOIN generation_intents intent ON intent.intent_id = job.intent_id
        WHERE intent.project_id = ? ORDER BY job.created_at`)
      .all(project.project_id) as Array<{ state: string }>;
    const deliveryJobs = db.prepare("SELECT state FROM workbench_delivery_jobs WHERE project_id = ? ORDER BY created_at")
      .all(project.project_id) as Array<{ state: string }>;
    assert.deepEqual(generationJobs.map((job) => job.state), ["succeeded", "succeeded"]);
    assert.deepEqual(deliveryJobs.map((job) => job.state), ["succeeded", "succeeded", "succeeded"]);
    assert.equal(checkDatabase(sqlitePath).result, "PASS");
  } finally {
    db.close();
    for (const mediaPath of generatedMediaPaths) {
      if (isInside(mediaPath, paths.mediaRoot)) rmSync(mediaPath, { force: true });
    }
    if (exportProjectDirectory && isInside(exportProjectDirectory, paths.exportsRoot)) {
      rmSync(exportProjectDirectory, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
