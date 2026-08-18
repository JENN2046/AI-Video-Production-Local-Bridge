import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateLocalMediaArtifact,
  buildStoryboardApprovedShot,
  buildRunwayCanaryDryRunReport,
  buildRunwayImageToVideoRequest,
  buildRunningHubImageToVideoDryRunPlan,
  buildRunningHubImageToVideoSubmitRequest,
  buildRunningHubMediaUploadRequest,
  buildRunningHubQueryRequest,
  createGenerationRunFromPackageShot,
  createProject,
  downloadProviderOutputToArtifact,
  getMediaArtifact,
  getMediaBlob,
  importStoryboardPackage,
  listProviderConfigs,
  mapRunwayAspectRatio,
  mapRunningHubAspectRatio,
  mapRunningHubProviderError,
  normalizeRunningHubDurationForDryRun,
  normalizeRunwayDuration,
  openM0Database,
  parseRunningHubMediaUploadResponse,
  parseRunningHubQueryResponse,
  parseRunningHubSubmitResponse,
  paths,
  redactSecrets,
  registerMediaArtifact,
  RUNNINGHUB_MIN_DURATION_SECONDS,
  RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
  RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
  RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
  RUNNINGHUB_QUERY_ENDPOINT,
  RUNWAY_API_VERSION,
  RUNWAY_IMAGE_TO_VIDEO_ENDPOINT,
  RunwayVideoProviderAdapter,
  saveShot,
  selectM1ProviderPort,
  startStoryboardVideoGeneration,
  validateProviderOutputUrl,
  verifyMediaArtifactBytes
} from "../src/index.js";
import type { MediaArtifact } from "../src/index.js";
import { failWorkbenchAssemblyFixture } from "./workbench-delivery-test-helpers.js";

const FAKE_SECRET = "M1_TEST_SECRET_DO_NOT_LOG_123";

function withEnv<T>(updates: Record<string, string | undefined>, action: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withEnvAsync<T>(updates: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  return withEnv(updates, action);
}

function setupOneShotProject(db: ReturnType<typeof openM0Database>, aspectRatio = "9:16") {
  const project = createProject({ title: "M1 Provider Boundary", video_spec: { aspect_ratio: aspectRatio, resolution: "1080x1920" } }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project failed");

  const artifact = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
    },
    db
  );
  assert.equal(artifact.ok, true);
  if (!artifact.ok) throw new Error("artifact failed");

  const storyboard = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [
        {
          order: 1,
          duration_seconds: 2,
          storyboard_image_artifact_id: artifact.artifact.artifact_id,
          video_prompt: "Animate the storyboard image."
        }
      ],
      user_approval: { storyboard_approved: true }
    },
    db
  );
  assert.equal(storyboard.ok, true);
  if (!storyboard.ok) throw new Error("storyboard failed");
  return { project, storyboard, artifact: artifact.artifact };
}

function fakeStoryboardArtifact(): MediaArtifact {
  const uri = join(paths.workspaceRoot, "fixtures", "storyboard", "shot_001.png");
  const sha256 = createHash("sha256").update(readFileSync(uri)).digest("hex");
  return {
    status: "active",
    artifact_type: "image",
    role: "storyboard_image",
    storage: { uri, mime_type: "image/png", filename: "shot_001.png" },
    metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256 },
    linked_objects: { project_id: "", shot_id: "" },
    source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256, external_url_host: "" }
  } as MediaArtifact;
}

function setupProviderBlobRecovery(
  db: ReturnType<typeof openM0Database>,
  mediaRoot: string
): { artifact: MediaArtifact; project_id: string; shot_id: string } {
  const created = createProject({ title: `Provider Blob recovery ${Date.now()}` }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("PROVIDER_RECOVERY_PROJECT_SETUP_FAILED");
  const shot = buildStoryboardApprovedShot({
    project_id: created.project_id,
    order: 1,
    duration_seconds: 6,
    storyboard_image_artifact_id: "",
    video_prompt: "Provider recovery fixture"
  });
  saveShot(db, shot);
  const artifactId = `artifact_provider_recovery_${createHash("sha256").update(mediaRoot).digest("hex").slice(0, 16)}`;
  const prepared: MediaArtifact = {
    artifact_id: artifactId,
    blob_id: "",
    artifact_type: "video",
    role: "generated_clip",
    status: "active",
    storage: {
      uri: join(mediaRoot, "artifacts", "videos", `${artifactId}.mp4`),
      mime_type: "video/mp4",
      filename: `${artifactId}.mp4`
    },
    metadata: {
      width: 1080,
      height: 1920,
      duration_seconds: 6,
      aspect_ratio: "9:16",
      sha256: ""
    },
    linked_objects: { project_id: created.project_id, shot_id: shot.shot_id },
    source: {
      kind: "provider_output_file",
      provider: "runninghub",
      provider_job_id: "paid-task-requiring-human-recovery",
      sha256: "",
      external_url_host: "fixture.invalid"
    }
  };
  const activated = activateLocalMediaArtifact({
    artifact: prepared,
    source_path: join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"),
    media_root: mediaRoot
  }, db);
  assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
  if (!activated.ok) throw new Error("PROVIDER_RECOVERY_ARTIFACT_SETUP_FAILED");
  return { artifact: activated.artifact, project_id: created.project_id, shot_id: shot.shot_id };
}

test("M1 provider registry keeps mock default and exposes two real ports", () => {
  const configs = listProviderConfigs();
  assert.equal(configs.find((config) => config.provider_name === "mock")?.default, true);
  assert.equal(configs.find((config) => config.provider_name === "runway")?.selectable, true);
  assert.equal(configs.find((config) => config.provider_name === "runninghub")?.selectable, true);
  assert.equal(configs.find((config) => config.provider_name === "runway")?.primary, false);
  assert.equal(configs.find((config) => config.provider_name === "runway")?.status, "secondary_selectable_provider_port");
  assert.equal(configs.find((config) => config.provider_name === "runninghub")?.primary, true);
  assert.equal(configs.find((config) => config.provider_name === "runninghub")?.required_for_m1_pass, true);
  assert.equal(configs.find((config) => config.provider_name === "runninghub")?.status, "primary_real_provider");
  assert.equal(configs.find((config) => config.provider_name === "runninghub")?.model_name, "rhart-video-g/image-to-video");
  assert.deepEqual(configs.find((config) => config.provider_name === "runninghub")?.model_names, ["rhart-video-g/image-to-video", "seedance-v1.5-pro/image-to-video"]);
});

test("M1 RunningHub dry-run freezes official endpoint shape without provider calls", () => {
  assert.equal(RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT, "/openapi/v2/rhart-video-g/image-to-video");
  assert.equal(RUNNINGHUB_QUERY_ENDPOINT, "/openapi/v2/query");
  assert.equal(RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT, "/openapi/v2/media/upload/binary");
  assert.equal(mapRunningHubAspectRatio("9:16"), "9:16");
  assert.equal(mapRunningHubAspectRatio("1:1"), "1:1");
  assert.equal(mapRunningHubAspectRatio("4:5"), null);
  assert.equal(RUNNINGHUB_MIN_DURATION_SECONDS, 6);
  assert.equal(normalizeRunningHubDurationForDryRun(3), null);
  assert.equal(normalizeRunningHubDurationForDryRun(6), RUNNINGHUB_MIN_DURATION_SECONDS);
  assert.equal(normalizeRunningHubDurationForDryRun(0), null);

  const request = buildRunningHubImageToVideoDryRunPlan({
    storyboard_artifact: fakeStoryboardArtifact(),
    video_prompt: "Animate portrait shot.",
    negative_prompt: "blur",
    duration_seconds: 6,
    aspect_ratio: "9:16",
    resolution: "480p"
  });

  assert.equal(request.ok, true);
  if (!request.ok) return;
  assert.equal(request.plan.provider, "runninghub");
  assert.equal(request.plan.submit_endpoint, "POST /openapi/v2/rhart-video-g/image-to-video");
  assert.equal(request.plan.query_contract.endpoint, "POST /openapi/v2/query");
  assert.equal(request.plan.image_reference.upload_endpoint, "POST /openapi/v2/media/upload/binary");
  assert.equal(request.plan.request_body_sanitized.prompt_text_length, "Animate portrait shot.".length);
  assert.equal(request.plan.request_body_sanitized.negative_prompt_supported, false);
  assert.equal(request.plan.request_body_sanitized.aspectRatio, "9:16");
  assert.deepEqual(request.plan.request_body_sanitized.imageUrls, ["<RUNNINGHUB_UPLOAD_DOWNLOAD_URL>"]);
  assert.equal(request.plan.request_body_sanitized.duration, 6);
  assert.equal(request.plan.image_reference.binary_payload_included, false);
  assert.equal(request.plan.image_reference.base64_included, false);
  assert.equal(request.plan.auth.credential_value_included, false);
  assert.equal(request.plan.provider_boundary.network_call_attempted, false);
  assert.equal(request.plan.provider_boundary.runninghub_called, false);
  assert.equal(request.plan.provider_boundary.runway_called, false);

  const serialized = JSON.stringify(request.plan);
  assert.equal(serialized.includes("Authorization: Bearer"), false);
  assert.equal(serialized.includes("data:image/"), false);
  assert.equal(serialized.includes("base64,"), false);
  assert.equal(serialized.includes(FAKE_SECRET), false);
});

test("M1 RunningHub upload-first request builders stay offline and sanitized", () => {
  const artifact = fakeStoryboardArtifact();
  const upload = buildRunningHubMediaUploadRequest({ storyboard_artifact: artifact });
  assert.equal(upload.ok, true);
  if (!upload.ok) return;
  assert.equal(upload.method, "POST");
  assert.equal(upload.endpoint, RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT);
  assert.equal(upload.multipart.file_field, "file");
  assert.equal(upload.multipart.binary_payload_included, false);
  assert.equal(upload.multipart.base64_included, false);
  assert.equal(upload.summary.endpoint, "POST /openapi/v2/media/upload/binary");
  assert.equal(upload.summary.file_field, "file");
  assert.equal(upload.summary.local_file_path_included, false);
  assert.equal(upload.summary.binary_payload_included, false);
  assert.equal(upload.summary.base64_included, false);
  assert.equal(upload.summary.auth.authorization_value_included, false);
  assert.equal(upload.summary.auth.credential_value_included, false);
  assert.equal(upload.summary.file_size_bytes > 0, true);
  assert.equal(upload.summary.sha256.length, 64);

  const submit = buildRunningHubImageToVideoSubmitRequest({
    generation_input: {
      storyboard_artifact: artifact,
      video_prompt: "Animate portrait shot.",
      negative_prompt: "blur",
      duration_seconds: 6,
      aspect_ratio: "9:16",
      resolution: "480p"
    },
    uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
  });
  assert.equal(submit.ok, true);
  if (!submit.ok) return;
  assert.equal(submit.method, "POST");
  assert.equal(submit.endpoint, RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT);
  assert.equal(submit.body.aspectRatio, "9:16");
  assert.deepEqual(submit.body.imageUrls, [RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER]);
  assert.equal(submit.summary.duration, 6);
  assert.equal(submit.summary.prompt_text_length, "Animate portrait shot.".length);
  assert.equal(submit.summary.negative_prompt_supported, false);
  assert.equal(submit.summary.image_url_values_included, false);
  assert.equal(submit.summary.raw_provider_payload_included, false);

  const durationTooShort = buildRunningHubImageToVideoSubmitRequest({
    generation_input: {
      storyboard_artifact: artifact,
      video_prompt: "Animate portrait shot.",
      negative_prompt: "blur",
      duration_seconds: 3,
      aspect_ratio: "9:16",
      resolution: "480p"
    },
    uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
  });
  assert.equal(durationTooShort.ok, false);
  if (durationTooShort.ok) throw new Error("duration_seconds=3 should fail before RunningHub submit request construction.");
  assert.equal(durationTooShort.error.code, "PROVIDER_UNSUPPORTED_INPUT");
  assert.equal(durationTooShort.error.message.includes("PROVIDER_CAPABILITY_DURATION_UNSUPPORTED"), true);

  const query = buildRunningHubQueryRequest("runninghub_task_synthetic");
  assert.equal(query.ok, true);
  if (!query.ok) return;
  assert.equal(query.method, "POST");
  assert.equal(query.endpoint, RUNNINGHUB_QUERY_ENDPOINT);
  assert.deepEqual(query.body, { taskId: "runninghub_task_synthetic" });
  assert.equal(query.summary.task_id_present, true);
  assert.equal(query.summary.task_id_value_included, false);

  const serializedSummaries = JSON.stringify([upload.summary, submit.summary, query.summary]);
  assert.equal(serializedSummaries.includes(FAKE_SECRET), false);
  assert.equal(serializedSummaries.includes(artifact.storage.uri), false);
  assert.equal(serializedSummaries.includes("data:image/"), false);
  assert.equal(serializedSummaries.includes("base64,"), false);
  assert.equal(serializedSummaries.includes("Authorization: Bearer"), false);
  assert.equal(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(serializedSummaries), false);
});

test("M1 RunningHub primary lane planning uses 6 second provider minimum without credentials", () => {
  const configs = listProviderConfigs();
  const runningHub = configs.find((config) => config.provider_name === "runninghub");
  const runway = configs.find((config) => config.provider_name === "runway");
  assert.equal(runningHub?.primary, true);
  assert.equal(runningHub?.status, "primary_real_provider");
  assert.equal(runningHub?.required_for_m1_pass, true);
  assert.equal(runway?.primary, false);
  assert.equal(runway?.status, "secondary_selectable_provider_port");

  const artifact = fakeStoryboardArtifact();
  const appShotDurations = [3, 4, 5, 6];
  for (const appDuration of appShotDurations) {
    const providerDuration = Math.max(appDuration, RUNNINGHUB_MIN_DURATION_SECONDS);
    const submit = buildRunningHubImageToVideoSubmitRequest({
      generation_input: {
        storyboard_artifact: artifact,
        video_prompt: "Animate portrait shot.",
        negative_prompt: "blur",
        duration_seconds: providerDuration,
        aspect_ratio: "9:16",
        resolution: "480p"
      },
      uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
    });

    assert.equal(providerDuration, RUNNINGHUB_MIN_DURATION_SECONDS);
    assert.equal(submit.ok, true);
    if (!submit.ok) return;
    assert.equal(submit.summary.duration, RUNNINGHUB_MIN_DURATION_SECONDS);
    assert.equal(submit.summary.image_url_values_included, false);
    assert.equal(submit.summary.raw_provider_payload_included, false);
    assert.equal(submit.summary.auth.credential_value_included, false);
    assert.equal(submit.summary.auth.authorization_value_included, false);
  }
});

test("M1 RunningHub synthetic response parsers cover upload, submit, and query outputs", () => {
  const upload = parseRunningHubMediaUploadResponse({
    data: {
      download_url: "https://runninghub-cdn.example/uploaded/keyframe.png"
    }
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) return;
  assert.equal(upload.download_url_present, true);
  assert.equal(upload.raw_provider_payload_recorded, false);

  const submit = parseRunningHubSubmitResponse({
    taskId: "runninghub_task_synthetic",
    status: "PENDING",
    errorCode: "",
    errorMessage: "",
    results: []
  });
  assert.equal(submit.ok, true);
  if (!submit.ok) return;
  assert.equal(submit.provider_job_id, "runninghub_task_synthetic");
  assert.equal(submit.provider_status, "PENDING");
  assert.equal(submit.raw_provider_payload_recorded, false);

  const query = parseRunningHubQueryResponse({
    taskId: "runninghub_task_synthetic",
    status: "SUCCESS",
    errorCode: "",
    errorMessage: "",
    results: [{ url: "https://cdn.example.test/video.mp4", outputType: "video" }]
  });
  assert.equal(query.ok, true);
  if (!query.ok) return;
  assert.equal(query.status, "succeeded");
  assert.equal(query.retryable, false);
  assert.equal(query.output_url, "https://cdn.example.test/video.mp4");
  assert.deepEqual(query.output_urls, ["https://cdn.example.test/video.mp4"]);
  assert.equal(query.raw_provider_payload_recorded, false);

  const failed = parseRunningHubQueryResponse({
    taskId: "runninghub_task_failed",
    status: "FAILED",
    errorCode: "GENERATION_FAILED",
    errorMessage: `generation failure ${FAKE_SECRET}`,
    results: []
  }, "runninghub_task_failed", [FAKE_SECRET]);
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.status, "failed");
  assert.equal(failed.mapped_error?.code, "PROVIDER_REQUEST_FAILED");
  assert.equal(failed.mapped_error?.sanitized_provider_error_summary?.provider_error_message?.includes(FAKE_SECRET), false);
});

test("M1 RunningHub error mapper classifies official failure classes without leaking secrets", () => {
  const cases: Array<{ name: string; payload: Record<string, unknown>; expected: string; retryable: boolean; http_status?: number }> = [
    { name: "invalid API key", payload: { errorCode: "INVALID_API_KEY", errorMessage: `invalid api key ${FAKE_SECRET}` }, expected: "PROVIDER_AUTH_FAILED", retryable: false },
    { name: "rate limit", payload: { errorCode: "RATE_LIMIT", errorMessage: "rate limit exceeded" }, expected: "PROVIDER_RATE_LIMITED", retryable: true },
    { name: "insufficient credits", payload: { errorCode: "INSUFFICIENT_CREDITS", errorMessage: "insufficient credits" }, expected: "PROVIDER_INSUFFICIENT_CREDITS", retryable: false },
    { name: "insufficient permission", payload: { errorCode: "NO_PERMISSION", errorMessage: "insufficient permission" }, expected: "PROVIDER_AUTH_FAILED", retryable: false, http_status: 403 },
    { name: "content safety", payload: { errorCode: "CONTENT_SAFETY", errorMessage: "content safety rejected" }, expected: "PROVIDER_CONTENT_REJECTED", retryable: false },
    { name: "timeout", payload: { errorCode: "TIMEOUT", errorMessage: "task timeout" }, expected: "PROVIDER_TIMEOUT", retryable: true },
    { name: "generation failure", payload: { errorCode: "GENERATION_FAILED", errorMessage: "generation failed" }, expected: "PROVIDER_REQUEST_FAILED", retryable: false },
    { name: "unknown provider failure", payload: { errorCode: "SOMETHING_ELSE", errorMessage: "unknown provider failure" }, expected: "PROVIDER_REQUEST_FAILED", retryable: false }
  ];

  for (const item of cases) {
    const mapped = mapRunningHubProviderError({ http_status: item.http_status ?? null, payload: item.payload, secrets: [FAKE_SECRET] });
    assert.equal(mapped.code, item.expected, item.name);
    assert.equal(mapped.retryable, item.retryable, item.name);
    const serialized = JSON.stringify(mapped);
    assert.equal(serialized.includes(FAKE_SECRET), false, item.name);
    assert.equal(serialized.includes("Authorization"), false, item.name);
    assert.equal(serialized.includes("base64,"), false, item.name);
  }
});

test("M1 real provider gates block disabled, missing cost ack, mismatch, and missing credential", () => {
  assert.equal(selectM1ProviderPort({ provider: "mock" }).ok, true);

  const disabled = selectM1ProviderPort({ provider: "real", provider_name: "runway", cost_acknowledged: true }, { M1_REAL_PROVIDER: "runway" });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.error.code, "PROVIDER_DISABLED");

  const costMissing = selectM1ProviderPort(
    { provider: "real", provider_name: "runway", cost_acknowledged: false },
    {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runway",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true"
    }
  );
  assert.equal(costMissing.ok, false);
  if (!costMissing.ok) assert.equal(costMissing.error.code, "PROVIDER_COST_CONFIRMATION_REQUIRED");

  const mismatch = selectM1ProviderPort(
    { provider: "real", provider_name: "runninghub", cost_acknowledged: true },
    {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runway",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNWAYML_API_SECRET: FAKE_SECRET
    }
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "PROVIDER_SELECTION_MISMATCH");

  const missingCredential = selectM1ProviderPort(
    { provider: "real", provider_name: "runninghub", cost_acknowledged: true },
    {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runninghub",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true"
    }
  );
  assert.equal(missingCredential.ok, false);
  if (!missingCredential.ok) assert.equal(missingCredential.error.code, "PROVIDER_CREDENTIAL_MISSING");
});

test("M1 legacy batch lane blocks RunningHub and routes real generation to V2", async () => {
  const db = openM0Database();
  try {
    const { project } = setupOneShotProject(db);
    const result = await withEnvAsync(
      {
        REAL_PROVIDER_ENABLED: "true",
        M1_REAL_PROVIDER: "runninghub",
        M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
        M1_REAL_PROVIDER_COST_ACK: "true",
        RUNNINGHUB_API_KEY: FAKE_SECRET
      },
      () =>
        startStoryboardVideoGeneration(
          {
            project_id: project.project_id,
            provider_execution: { provider: "real", provider_name: "runninghub", cost_acknowledged: true },
            confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
          },
          db
        )
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "PROVIDER_DISABLED");
  } finally {
    db.close();
  }
});

test("M1 legacy live generation preserves a known Provider task for reconciliation after content drift", async () => {
  const db = openM0Database();
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  try {
    const { project, storyboard } = setupOneShotProject(db);
    const shotId = storyboard.shots[0].shot_id;
    const before = {
      project: db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(project.project_id),
      shot: db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(shotId),
      artifacts: db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ?").get(project.project_id),
      runs: db.prepare("SELECT COUNT(*) AS count FROM generation_runs WHERE project_id = ?").get(project.project_id),
      batches: db.prepare("SELECT COUNT(*) AS count FROM generation_batches WHERE project_id = ?").get(project.project_id),
      intents: db.prepare("SELECT COUNT(*) AS count FROM generation_intents WHERE project_id = ?").get(project.project_id)
    };
    globalThis.fetch = (async () => {
      providerCalls += 1;
      const at = "2026-08-17T00:00:00.000Z";
      const fingerprint = "a".repeat(64);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble' WHERE project_id = ?")
        .run(project.project_id);
      db.prepare(`INSERT INTO workbench_delivery_jobs
        (job_id, project_id, job_type, state, input_fingerprint, input_json, created_at, updated_at)
        VALUES ('job_m1_provider_drift', ?, 'assembly', 'queued', ?,
          '{"source_clip_artifact_ids":[]}', ?, ?)`).run(project.project_id, fingerprint, at, at);
      db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint,
          reason_code, data_json, created_at)
        VALUES ('event_m1_provider_drift_queued', ?, 'job_m1_provider_drift', 'assembly_queued',
          'ready_to_assemble', 'assembling', ?, 'ASSEMBLY_QUEUED', '{}', ?)`)
        .run(project.project_id, fingerprint, at);
      db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'assembling',
        active_assembly_job_id = 'job_m1_provider_drift', assembly_input_fingerprint = ?, updated_at = ?
        WHERE project_id = ?`).run(fingerprint, at, project.project_id);
      db.exec("COMMIT");
      return new Response(JSON.stringify({ id: "synthetic_runway_task", status: "PENDING" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const result = await withEnvAsync({
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runway",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNWAYML_API_SECRET: FAKE_SECRET
    }, () => startStoryboardVideoGeneration({
      project_id: project.project_id,
      selected_shot_ids: [shotId],
      provider_execution: { provider: "real", provider_name: "runway", cost_acknowledged: true },
      allow_live_provider: true,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db));

    assert.equal(result.ok ? null : result.error.code, "CONTENT_MUTATION_REQUIRES_RECONCILIATION");
    assert.equal(providerCalls, 1);
    assert.deepEqual(db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(project.project_id), before.project);
    assert.deepEqual(db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(shotId), before.shot);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE project_id = ?").get(project.project_id), before.artifacts);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_runs WHERE project_id = ?").get(project.project_id) as { count: number }).count,
      (before.runs as { count: number }).count + 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_batches WHERE project_id = ?").get(project.project_id) as { count: number }).count,
      (before.batches as { count: number }).count + 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_intents WHERE project_id = ?").get(project.project_id) as { count: number }).count,
      (before.intents as { count: number }).count + 1);
    const reconciliation = db.prepare(`SELECT i.provider_task_id, i.status AS intent_status,
        r.status AS run_status, json_extract(r.data_json, '$.provider.provider_job_id') AS run_provider_task_id,
        j.state AS job_state, j.reconciliation_reason
      FROM generation_intents i
      JOIN generation_runs r ON r.run_id = i.run_id
      JOIN generation_jobs j ON j.intent_id = i.intent_id
      WHERE i.project_id = ? AND i.shot_id = ?`).get(project.project_id, shotId) as Record<string, unknown>;
    assert.deepEqual({ ...reconciliation }, {
      provider_task_id: "synthetic_runway_task",
      intent_status: "running",
      run_status: "running",
      run_provider_task_id: "synthetic_runway_task",
      job_state: "manual_reconciliation",
      reconciliation_reason: "CONTENT_MUTATION_REQUIRES_RECONCILIATION"
    });
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM generation_job_events event
      JOIN generation_jobs job ON job.job_id = event.job_id
      JOIN generation_intents intent ON intent.intent_id = job.intent_id
      WHERE intent.project_id = ? AND event.to_state = 'manual_reconciliation'
        AND event.reason_code = 'CONTENT_MUTATION_REQUIRES_RECONCILIATION'`).get(project.project_id) as { count: number }).count, 1);
    failWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      job_id: "job_m1_provider_drift",
      event_id: "event_m1_provider_drift_failed",
      created_at: "2026-08-17T00:00:00.000Z"
    });
    const duplicate = await withEnvAsync({
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runway",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNWAYML_API_SECRET: FAKE_SECRET
    }, () => startStoryboardVideoGeneration({
      project_id: project.project_id,
      selected_shot_ids: [shotId],
      provider_execution: { provider: "real", provider_name: "runway", cost_acknowledged: true },
      allow_live_provider: true,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    }, db));
    assert.equal(duplicate.ok, false);
    assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("M1 Runway request boundary rejects unsupported ratio and duration before network", async () => {
  assert.equal(mapRunwayAspectRatio("9:16"), "720:1280");
  assert.equal(mapRunwayAspectRatio("16:9"), "1280:768");
  assert.equal(mapRunwayAspectRatio("1:1"), null);
  assert.equal(normalizeRunwayDuration(2), 2);
  assert.equal(normalizeRunwayDuration(10), 10);
  assert.equal(normalizeRunwayDuration(1), null);
  assert.equal(normalizeRunwayDuration(11), null);

  const adapter = new RunwayVideoProviderAdapter({
    credential: FAKE_SECRET,
    fetch_impl: (() => {
      throw new Error("network should not be called for invalid input");
    }) as typeof fetch
  });
  const fakeArtifact = fakeStoryboardArtifact();

  const badRatio = await adapter.submitGeneration({
    storyboard_artifact: fakeArtifact,
    video_prompt: "Animate",
    negative_prompt: "",
    duration_seconds: 2,
    aspect_ratio: "1:1",
    resolution: "1080x1080"
  });
  assert.equal(badRatio.ok, false);
  if (!badRatio.ok) assert.equal(badRatio.error.code, "PROVIDER_UNSUPPORTED_INPUT");

  const badDuration = await adapter.submitGeneration({
    storyboard_artifact: fakeArtifact,
    video_prompt: "Animate",
    negative_prompt: "",
    duration_seconds: 11,
    aspect_ratio: "9:16",
    resolution: "1080x1920"
  });
  assert.equal(badDuration.ok, false);
  if (!badDuration.ok) assert.equal(badDuration.error.code, "PROVIDER_UNSUPPORTED_INPUT");
});

test("M1 Runway request maps project aspect ratio to API resolution ratio before submit", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const adapter = new RunwayVideoProviderAdapter({
    credential: FAKE_SECRET,
    api_base: "https://api.test.runway",
    fetch_impl: (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "runway_job_request_contract", status: "PENDING" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });

  const result = await adapter.submitGeneration({
    storyboard_artifact: fakeStoryboardArtifact(),
    video_prompt: "Animate portrait shot.",
    negative_prompt: "",
    duration_seconds: 2,
    aspect_ratio: "9:16",
    resolution: "1080x1920"
  });

  assert.equal(result.ok, true);
  assert.equal(capturedUrl, `https://api.test.runway${RUNWAY_IMAGE_TO_VIDEO_ENDPOINT}`);
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["X-Runway-Version"], RUNWAY_API_VERSION);

  const rawBody = String(capturedInit?.body);
  const body = JSON.parse(rawBody) as { ratio?: string; duration?: number; promptText?: string };
  assert.equal(body.ratio, "720:1280");
  assert.equal(body.duration, 2);
  assert.equal(body.promptText, "Animate portrait shot.");
  assert.equal(rawBody.includes("9:16"), false);
});

test("M1 Runway request summary excludes prompt image bytes and records safe image facts", () => {
  const request = buildRunwayImageToVideoRequest({
    storyboard_artifact: fakeStoryboardArtifact(),
    video_prompt: "Animate portrait shot.",
    negative_prompt: "",
    duration_seconds: 2,
    aspect_ratio: "9:16",
    resolution: "1080x1920"
  });

  assert.equal(request.ok, true);
  if (!request.ok) return;
  assert.equal(request.summary.endpoint, `POST ${RUNWAY_IMAGE_TO_VIDEO_ENDPOINT}`);
  assert.equal(request.summary.x_runway_version, RUNWAY_API_VERSION);
  assert.equal(request.summary.model, "gen4.5");
  assert.equal(request.summary.ratio, "720:1280");
  assert.equal(request.summary.duration, 2);
  assert.equal(request.summary.prompt_text_length, "Animate portrait shot.".length);
  assert.equal(request.summary.prompt_image.kind, "data_uri");
  assert.equal(request.summary.prompt_image.mime_type, "image/png");
  assert.equal(request.summary.prompt_image.width > 0, true);
  assert.equal(request.summary.prompt_image.height > 0, true);
  assert.equal(request.summary.prompt_image.sha256.length, 64);

  const serializedSummary = JSON.stringify(request.summary);
  assert.equal(serializedSummary.includes("promptImage"), false);
  assert.equal(serializedSummary.includes("base64"), false);
  assert.equal(serializedSummary.includes("Authorization"), false);
  assert.equal(serializedSummary.includes("RUNWAYML_API_SECRET"), false);
});

test("M1 Runway submit failure keeps sanitized provider summary without raw payload", async () => {
  const adapter = new RunwayVideoProviderAdapter({
    credential: FAKE_SECRET,
    api_base: "https://api.test.runway",
    fetch_impl: (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_prompt_image",
            message: `Rejected image ${FAKE_SECRET} data:image/png;base64,${"A".repeat(220)}`,
            field: "promptImage"
          },
          raw_provider_payload: "do not keep"
        }),
        {
          status: 422,
          headers: { "content-type": "application/json" }
        }
      )) as typeof fetch
  });

  const result = await adapter.submitGeneration({
    storyboard_artifact: fakeStoryboardArtifact(),
    video_prompt: "Animate portrait shot.",
    negative_prompt: "",
    duration_seconds: 2,
    aspect_ratio: "9:16",
    resolution: "1080x1920"
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PROVIDER_UNSUPPORTED_INPUT");
  const summary = result.error.sanitized_provider_error_summary;
  assert.equal(summary?.http_status, 422);
  assert.equal(summary?.provider_error_code, "invalid_prompt_image");
  assert.equal(summary?.provider_error_field, "promptImage");
  assert.equal(summary?.retryable, false);

  const serializedSummary = JSON.stringify(summary);
  assert.equal(serializedSummary.includes(FAKE_SECRET), false);
  assert.equal(serializedSummary.includes("data:image/png;base64"), false);
  assert.equal(serializedSummary.includes("raw_provider_payload"), false);
  assert.equal(serializedSummary.includes("Authorization"), false);
});

test("M1 Runway submit failure classifies credit messages even on HTTP 400", async () => {
  const adapter = new RunwayVideoProviderAdapter({
    credential: FAKE_SECRET,
    api_base: "https://api.test.runway",
    fetch_impl: (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "You do not have enough credits to run this task."
          }
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" }
        }
      )) as typeof fetch
  });

  const result = await adapter.submitGeneration({
    storyboard_artifact: fakeStoryboardArtifact(),
    video_prompt: "Animate portrait shot.",
    negative_prompt: "",
    duration_seconds: 2,
    aspect_ratio: "9:16",
    resolution: "1080x1920"
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PROVIDER_INSUFFICIENT_CREDITS");
  assert.equal(result.error.sanitized_provider_error_summary?.http_status, 400);
  assert.equal(result.error.sanitized_provider_error_summary?.provider_error_message, "You do not have enough credits to run this task.");
});

test("M1 package shot generation creates mock generated clip with ffprobe validation and no raw import input", async () => {
  const db = openM0Database();
  try {
    const { project, storyboard } = setupOneShotProject(db);
    const shotId = storyboard.shots[0].shot_id;

    const result = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: shotId,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.batch.summary.total, 1);
    assert.equal(result.run.shot_id, shotId);
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.run.provider.provider_name, "mock");
    assert.equal(result.generated_artifact_id?.startsWith("artifact_"), true);
    assert.equal(result.provider_request_summary?.project_aspect_ratio, "9:16");
    assert.equal(result.provider_request_summary?.runway_ratio, "720:1280");
    assert.equal(result.provider_request_summary?.raw_data_imports_provider_input, false);
    assert.equal(result.provider_request_summary?.prompt_image_storage_is_app_media, true);
    assert.equal(result.ffprobe?.status, "PASS");

    const artifact = getMediaArtifact(db, result.generated_artifact_id ?? "");
    assert.equal(artifact?.role, "generated_clip");
    assert.equal(artifact?.artifact_type, "video");
    assert.equal(artifact?.source.provider, "mock");
  } finally {
    db.close();
  }
});

test("M1 package shot generation hard-gates live provider submit by default", async () => {
  const db = openM0Database();
  try {
    const { project, storyboard } = setupOneShotProject(db);
    const result = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: storyboard.shots[0].shot_id,
        provider_execution: { provider: "real", provider_name: "runway", cost_acknowledged: true },
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "LIVE_PROVIDER_AUTHORIZATION_REQUIRED");
  } finally {
    db.close();
  }
});

test("M1 provider output URL safety blocks unsafe destinations", () => {
  for (const url of [
    "http://example.com/video.mp4",
    "file:///tmp/video.mp4",
    "data:video/mp4;base64,AAAA",
    "https://localhost/video.mp4",
    "https://sub.localhost/video.mp4",
    "https://127.0.0.1/video.mp4",
    "https://[::1]/video.mp4",
    "https://[::127.0.0.1]/video.mp4",
    "https://[::ffff:127.0.0.1]/video.mp4",
    "https://[fc00::1]/video.mp4",
    "https://[fe90::1]/video.mp4",
    "https://[febf::1]/video.mp4",
    "https://[fec0::1]/video.mp4",
    "https://[feff::1]/video.mp4",
    "https://[2001:db8::1]/video.mp4",
    "https://user:password@cdn.example.test/video.mp4",
    "https://10.0.0.2/video.mp4",
    "https://169.254.169.254/latest/meta-data"
  ]) {
    const result = validateProviderOutputUrl(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.equal(result.error.code, "PROVIDER_OUTPUT_URI_BLOCKED");
  }
  assert.equal(validateProviderOutputUrl("https://cdn.example.test/video.mp4").ok, true);
});

test("M1 provider output downloader rejects private DNS answers before transport", async () => {
  const db = openM0Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "provider-output-dns-"));
  let fetched = false;
  try {
    const result = await downloadProviderOutputToArtifact({
      url: "https://cdn.example.test/output.mp4",
      provider_name: "runninghub",
      provider_job_id: "private-dns-task",
      project_id: "project_dns",
      shot_id: "shot_dns",
      duration_seconds: 2,
      aspect_ratio: "9:16",
      storage_directory: root
    }, db, {
      storage_root: root,
      resolve_hostname: async () => [{ address: "127.0.0.1", family: 4 }],
      fetch_pinned_address: async () => { fetched = true; throw new Error("transport must not run"); }
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PROVIDER_OUTPUT_URI_BLOCKED");
    assert.equal(fetched, false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 provider output downloader rejects a generic injected fetch that cannot consume pinned addresses", async () => {
  const db = openM0Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "provider-output-unpinned-fetch-"));
  let fetched = false;
  try {
    const result = await downloadProviderOutputToArtifact({
      url: "https://cdn.example.test/output.mp4",
      provider_name: "runninghub",
      provider_job_id: "unpinned-fetch-task",
      project_id: "project_unpinned_fetch",
      shot_id: "shot_unpinned_fetch",
      duration_seconds: 2,
      aspect_ratio: "9:16",
      storage_directory: root,
      fetch_impl: (async () => { fetched = true; throw new Error("generic fetch must not run"); }) as typeof fetch
    }, db, {
      storage_root: root,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }]
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PROVIDER_OUTPUT_PINNED_TRANSPORT_REQUIRED");
    assert.equal(fetched, false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 provider output persistence guard rejects post-download drift before temp or Artifact commit", async () => {
  const db = openM0Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "provider-output-persist-guard-"));
  const fixture = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  try {
    for (const rejectedCall of [2, 3]) {
      const mediaRoot = join(root, `media-${rejectedCall}`);
      const providerJobId = `persist-guard-${rejectedCall}`;
      let guardCalls = 0;
      const result = await downloadProviderOutputToArtifact({
        url: "https://cdn.example.test/output.mp4",
        provider_name: "runninghub",
        provider_job_id: providerJobId,
        project_id: "project_persist_guard",
        shot_id: "shot_persist_guard",
        duration_seconds: 2,
        aspect_ratio: "9:16",
        storage_directory: mediaRoot
      }, db, {
        storage_root: mediaRoot,
        resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
        fetch_pinned_address: async () => new Response(fixture, {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(fixture.length) }
        }),
        assert_persist_allowed: () => {
          guardCalls += 1;
          return guardCalls === rejectedCall
            ? { code: "PROJECT_CLOSED", message: "Synthetic delivery-state drift." }
            : null;
        }
      });
      const identity = createHash("sha256").update(`runninghub\0${providerJobId}`).digest("hex");
      assert.equal(result.ok ? null : result.error.code, "PROJECT_CLOSED");
      assert.equal(guardCalls, rejectedCall);
      assert.equal(existsSync(join(mediaRoot, `artifact_${identity}.mp4`)), false);
      assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
        WHERE json_extract(data_json, '$.source.provider_job_id') = ?`).get(providerJobId) as { count: number }).count, 0);
    }

    const allowedFixture = setupOneShotProject(db);
    const allowedMediaRoot = join(root, "media-allowed");
    const allowedBatchId = "batch_persist_guard_allowed";
    let allowedGuardCalls = 0;
    const allowed = await downloadProviderOutputToArtifact({
      url: "https://cdn.example.test/output.mp4",
      provider_name: "runninghub",
      provider_job_id: "persist-guard-allowed",
      project_id: allowedFixture.project.project_id,
      shot_id: allowedFixture.storyboard.shots[0].shot_id,
      duration_seconds: 2,
      aspect_ratio: "9:16",
      storage_directory: allowedMediaRoot
    }, db, {
      storage_root: allowedMediaRoot,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(fixture, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(fixture.length) }
      }),
      assert_persist_allowed: () => {
        allowedGuardCalls += 1;
        return null;
      },
      persist_with_artifact: (artifact) => {
        assert.notEqual(getMediaArtifact(db, artifact.artifact_id), null);
        db.prepare(`INSERT INTO generation_batches
          (batch_id, project_id, storyboard_package_id, data_json, updated_at)
          VALUES (?, ?, ?, '{}', CURRENT_TIMESTAMP)`)
          .run(allowedBatchId, allowedFixture.project.project_id, allowedFixture.storyboard.storyboard_package.storyboard_package_id);
        return null;
      }
    });
    assert.equal(allowed.ok, true, allowed.ok ? undefined : allowed.error.message);
    assert.equal(allowedGuardCalls, 3);
    if (allowed.ok) assert.equal(existsSync(allowed.artifact.storage.uri), true);
    assert.notEqual(db.prepare("SELECT batch_id FROM generation_batches WHERE batch_id = ?").get(allowedBatchId), undefined);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 provider output rolls back the Artifact and dependent generation writes in one transaction", async () => {
  const db = openM0Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "provider-output-atomic-persist-"));
  const fixture = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  const providerJobId = "atomic-persist-rollback";
  const batchId = "batch_atomic_persist_rollback";
  let artifactVisibleInsideTransaction = false;
  try {
    const projectFixture = setupOneShotProject(db);
    const shotId = projectFixture.storyboard.shots[0].shot_id;
    const result = await downloadProviderOutputToArtifact({
      url: "https://cdn.example.test/output.mp4",
      provider_name: "runninghub",
      provider_job_id: providerJobId,
      project_id: projectFixture.project.project_id,
      shot_id: shotId,
      duration_seconds: 2,
      aspect_ratio: "9:16",
      storage_directory: root
    }, db, {
      storage_root: root,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(fixture, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(fixture.length) }
      }),
      assert_persist_allowed: () => null,
      persist_with_artifact: (artifact) => {
        artifactVisibleInsideTransaction = getMediaArtifact(db, artifact.artifact_id) !== null;
        db.prepare(`INSERT INTO generation_batches
          (batch_id, project_id, storyboard_package_id, data_json, updated_at)
          VALUES (?, ?, ?, '{}', CURRENT_TIMESTAMP)`)
          .run(batchId, projectFixture.project.project_id, projectFixture.storyboard.storyboard_package.storyboard_package_id);
        return { code: "PROJECT_CLOSED", message: "Synthetic final persistence drift." };
      }
    });

    const identity = createHash("sha256").update(`runninghub\0${providerJobId}`).digest("hex");
    const artifactId = `artifact_${identity}`;
    assert.equal(result.ok ? null : result.error.code, "PROJECT_CLOSED");
    assert.equal(artifactVisibleInsideTransaction, true);
    assert.equal(getMediaArtifact(db, artifactId), null);
    assert.equal(db.prepare("SELECT batch_id FROM generation_batches WHERE batch_id = ?").get(batchId), undefined);
    assert.equal(existsSync(join(root, `${artifactId}.mp4`)), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 provider output downloader retries every validated public address", async () => {
  const db = openM0Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "provider-output-address-fallback-"));
  const fixtureBytes = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  const attempts: string[] = [];
  try {
    const result = await downloadProviderOutputToArtifact({
      url: "https://cdn.example.test/output.mp4",
      provider_name: "runninghub",
      provider_job_id: "address-fallback-task",
      project_id: "project_address_fallback",
      shot_id: "shot_address_fallback",
      duration_seconds: 2,
      aspect_ratio: "9:16",
      storage_directory: root
    }, db, {
      storage_root: root,
      resolve_hostname: async () => [
        { address: "2001:4860:4860::8888", family: 6 },
        { address: "8.8.8.8", family: 4 }
      ],
      fetch_pinned_address: async (_url, _signal, address) => {
        attempts.push(address.address);
        if (address.family === 6) throw new Error("IPv6 route unavailable");
        return new Response(fixtureBytes, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(fixtureBytes.length) } });
      }
    });
    assert.equal(result.ok, true);
    assert.deepEqual(attempts, ["2001:4860:4860::8888", "8.8.8.8"]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 provider output downloader enforces size and timeout while streaming", async () => {
  const db = openM0Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "provider-output-stream-"));
  const base = {
    url: "https://cdn.example.test/output.mp4",
    provider_name: "runninghub",
    project_id: "project_stream",
    shot_id: "shot_stream",
    duration_seconds: 2,
    aspect_ratio: "9:16",
    storage_directory: root
  };
  try {
    const oversized = await downloadProviderOutputToArtifact({
      ...base,
      provider_job_id: "oversized-task",
      safety: { max_size_mb: 0.000001 }
    }, db, {
      storage_root: root,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(32));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "video/mp4" } })
    });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.error.code, "PROVIDER_OUTPUT_TOO_LARGE");

    const timedOut = await downloadProviderOutputToArtifact({
      ...base,
      provider_job_id: "timeout-task",
      safety: { timeout_seconds: 0.01 }
    }, db, {
      storage_root: root,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async (_url, signal) => new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        }
      }), { status: 200, headers: { "content-type": "video/mp4" } })
    });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) {
      assert.equal(timedOut.error.code, "PROVIDER_OUTPUT_DOWNLOAD_FAILED");
      assert.match(timedOut.error.message, /timed out/i);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 provider output registration blocks symlink storage directories", () => {
  const db = openM0Database();
  const sourceDirectory = join(paths.mediaRoot, "provider-output-symlink-source");
  const symlinkDirectory = join(paths.mediaRoot, `provider-output-symlink-${Date.now()}`);
  const externalDirectory = mkdtempSync(join(tmpdir(), "provider-output-outside-"));

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    const sourceFile = join(sourceDirectory, "source.mp4");
    writeFileSync(sourceFile, "not a real video", "utf8");
    try {
      symlinkSync(externalDirectory, symlinkDirectory, "junction");
    } catch {
      return;
    }

    for (const role of ["generated_clip", "final_video"] as const) {
      const result = registerMediaArtifact(
        {
          artifact_type: "video",
          role,
          source: { kind: "provider_output_file", path: sourceFile, mime_type: "video/mp4" },
          storage_directory: symlinkDirectory
        },
        db
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "SYMLINK_ESCAPE_BLOCKED");
    }
  } finally {
    rmSync(symlinkDirectory, { recursive: true, force: true });
    rmSync(sourceDirectory, { recursive: true, force: true });
    rmSync(externalDirectory, { recursive: true, force: true });
    db.close();
  }
});

test("M1 provider output downloader rejects a preexisting symlink final artifact", async () => {
  const db = openM0Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "provider-output-final-symlink-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "provider-output-final-external-"));
  const fixtureBytes = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  const providerName = "runninghub";
  const providerJobId = "preexisting-symlink-task";
  const identity = createHash("sha256").update(`${providerName}\0${providerJobId}`).digest("hex");
  const finalPath = join(root, `artifact_${identity}.mp4`);
  const externalFile = join(externalRoot, "outside.mp4");
  writeFileSync(externalFile, fixtureBytes);
  try {
    try {
      symlinkSync(externalFile, finalPath, "file");
    } catch {
      return;
    }
    const result = await downloadProviderOutputToArtifact({
      url: "https://cdn.example.test/output.mp4",
      provider_name: providerName,
      provider_job_id: providerJobId,
      project_id: "project_final_symlink",
      shot_id: "shot_final_symlink",
      duration_seconds: 2,
      aspect_ratio: "9:16",
      storage_directory: root
    }, db, {
      storage_root: root,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(fixtureBytes, { status: 200, headers: { "content-type": "video/mp4" } })
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PROVIDER_OUTPUT_STORAGE_BLOCKED");
    assert.equal(readFileSync(externalFile).equals(fixtureBytes), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
    db.close();
  }
});

test("M1 provider output registration supports final_video artifacts inside app media storage", () => {
  const db = openM0Database();
  const sourceDirectory = join(paths.mediaRoot, "provider-output-final-video-source");

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    const sourceFile = join(sourceDirectory, "source.mp4");
    writeFileSync(sourceFile, readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4")));

    const result = registerMediaArtifact(
      {
        artifact_type: "video",
        role: "final_video",
        source: { kind: "provider_output_file", path: sourceFile, mime_type: "video/mp4" },
        linked_objects: { project_id: "project_final_video_test" },
        metadata: { duration_seconds: 2, aspect_ratio: "9:16" },
        provenance: { provider: "local_assembly" }
      },
      db
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.artifact.role, "final_video");
    assert.equal(result.artifact.artifact_type, "video");
    assert.equal(result.artifact.status, "active");
    assert.equal(result.artifact.source.provider, "local_assembly");
    assert.equal(existsSync(result.artifact.storage.uri), true);
  } finally {
    rmSync(sourceDirectory, { recursive: true, force: true });
    db.close();
  }
});

test("M1 provider output downloader saves ffprobe-valid local artifact without persisting URL", async () => {
  const db = openM0Database();
  try {
    const fixtureBytes = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
    const storageDirectory = join(paths.mediaRoot, "provider-canary", "m1-r0-runway-canary-test");
    mkdirSync(storageDirectory, { recursive: true });
    const input = {
        url: "https://cdn.example.test/generated/output.mp4?signature=secret",
        provider_name: "runway",
        provider_job_id: "runway_job_test",
        project_id: "project_test",
        shot_id: "shot_test",
        duration_seconds: 2,
        aspect_ratio: "9:16",
        storage_directory: storageDirectory
      } as const;
    const runtime = {
        resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 as const }],
        fetch_pinned_address: async () =>
          new Response(fixtureBytes, {
            status: 200,
            headers: {
              "content-type": "video/mp4",
              "content-length": String(fixtureBytes.length)
            }
          })
      };
    const result = await downloadProviderOutputToArtifact(input, db, runtime);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const artifact = getMediaArtifact(db, result.artifact.artifact_id);
    assert.equal(artifact?.source.provider, "runway");
    assert.equal(artifact?.source.provider_job_id, "runway_job_test");
    assert.equal(artifact?.source.external_url_host, "cdn.example.test");
    assert.equal(artifact?.storage.uri.includes("signature"), false);
    assert.equal(artifact?.storage.uri.startsWith(paths.mediaRoot), true);
    assert.equal(artifact ? getMediaBlob(db, artifact.blob_id)?.storage_uri : null, artifact?.storage.uri);
    assert.equal(result.ffprobe.status, "PASS");

    if (artifact) writeFileSync(artifact.storage.uri, Buffer.from("tampered-provider-output", "utf8"));
    const retry = await downloadProviderOutputToArtifact(input, db, runtime);
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(new Set(["MEDIA_BLOB_CONTENT_DRIFT", "VIDEO_FILE_INVALID"]).has(retry.error.code), true);
  } finally {
    db.close();
  }
});

test("ordinary Provider download cannot repair an invalid verified Blob", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-output-no-implicit-recovery-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  const fixtureBytes = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  try {
    const fixture = setupProviderBlobRecovery(db, mediaRoot);
    const ordinaryInput = {
      url: "https://cdn.example.test/generated/output.mp4",
      provider_name: "runninghub",
      provider_job_id: "ordinary-download-must-not-repair",
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      duration_seconds: 6,
      aspect_ratio: "9:16",
      storage_directory: mediaRoot
    } as const;
    assert.equal("verified_blob_recovery" in ordinaryInput, false);
    const blobBefore = getMediaBlob(db, fixture.artifact.blob_id);
    writeFileSync(fixture.artifact.storage.uri, "invalid-verified-blob", "utf8");

    const result = await downloadProviderOutputToArtifact(ordinaryInput, db, {
      storage_root: mediaRoot,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(fixtureBytes, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(fixtureBytes.length) }
      })
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "MEDIA_BLOB_EXISTING_BYTES_INVALID");
    assert.equal(readFileSync(fixture.artifact.storage.uri).toString("utf8"), "invalid-verified-blob");
    assert.deepEqual(getMediaBlob(db, fixture.artifact.blob_id), blobBefore);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_blobs").get() as { count: number }).count, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Provider recovery restores the same Blob and activates a replacement Artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-output-explicit-recovery-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  const fixtureBytes = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  try {
    const fixture = setupProviderBlobRecovery(db, mediaRoot);
    const blobBefore = getMediaBlob(db, fixture.artifact.blob_id);
    assert.ok(blobBefore);
    writeFileSync(fixture.artifact.storage.uri, "corrupt-paid-output", "utf8");

    const result = await downloadProviderOutputToArtifact({
      url: "https://cdn.example.test/generated/recovered.mp4",
      provider_name: "runninghub",
      provider_job_id: "local_recovery_00000000-0000-4000-8000-000000000001",
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      duration_seconds: 6,
      aspect_ratio: "9:16",
      storage_directory: mediaRoot,
      verified_blob_recovery: {
        invalid_artifact_id: fixture.artifact.artifact_id
      }
    }, db, {
      storage_root: mediaRoot,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(fixtureBytes, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(fixtureBytes.length) }
      })
    });

    assert.equal(result.ok, true, result.ok ? undefined : result.error.code);
    if (!result.ok || !blobBefore) return;
    assert.notEqual(result.artifact.artifact_id, fixture.artifact.artifact_id);
    assert.equal(result.artifact.blob_id, blobBefore.blob_id);
    assert.equal(result.artifact.storage.uri, blobBefore.storage_uri);
    assert.deepEqual(getMediaBlob(db, blobBefore.blob_id), blobBefore);
    assert.equal(verifyMediaArtifactBytes(db, fixture.artifact).ok, true);
    assert.equal(verifyMediaArtifactBytes(db, result.artifact).ok, true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_blobs").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifact_blobs WHERE blob_id = ?").get(blobBefore.blob_id) as { count: number }).count, 2);
    const quarantine = readdirSync(join(mediaRoot, ".activation", "quarantine"))
      .filter((name) => /^blob-recovery-[0-9a-f-]+\.corrupt$/i.test(name));
    assert.equal(quarantine.length, 1);
    assert.equal(readFileSync(join(mediaRoot, ".activation", "quarantine", quarantine[0])).toString("utf8"), "corrupt-paid-output");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Provider recovery rejects different bytes and arbitrary Artifact bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-output-recovery-binding-"));
  const mediaRoot = join(root, "media");
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  const fixtureBytes = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  const runtime = {
    storage_root: mediaRoot,
    resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 as const }],
    fetch_pinned_address: async () => new Response(fixtureBytes, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(fixtureBytes.length) }
    })
  };
  try {
    const fixture = setupProviderBlobRecovery(db, mediaRoot);
    writeFileSync(fixture.artifact.storage.uri, "corrupt-binding-target", "utf8");
    const base = {
      url: "https://cdn.example.test/generated/recovery.mp4",
      provider_name: "runninghub",
      project_id: fixture.project_id,
      shot_id: fixture.shot_id,
      duration_seconds: 6,
      aspect_ratio: "9:16",
      storage_directory: mediaRoot
    } as const;

    const differentBytes = Buffer.concat([fixtureBytes, Buffer.from("different-provider-bytes", "utf8")]);
    const mismatch = await downloadProviderOutputToArtifact({
      ...base,
      provider_job_id: "local_recovery_content_mismatch",
      verified_blob_recovery: { invalid_artifact_id: fixture.artifact.artifact_id }
    }, db, {
      ...runtime,
      fetch_pinned_address: async () => new Response(differentBytes, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(differentBytes.length) }
      })
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH");

    for (const [providerJobId, projectId, shotId] of [
      ["local_recovery_wrong_project", "project_not_bound", fixture.shot_id],
      ["local_recovery_wrong_shot", fixture.project_id, "shot_not_bound"]
    ] as const) {
      const binding = await downloadProviderOutputToArtifact({
        ...base,
        provider_job_id: providerJobId,
        project_id: projectId,
        shot_id: shotId,
        verified_blob_recovery: { invalid_artifact_id: fixture.artifact.artifact_id }
      }, db, runtime);
      assert.equal(binding.ok, false);
      if (!binding.ok) assert.equal(binding.error.code, "MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
    }

    const arbitraryArtifact: MediaArtifact = {
      ...structuredClone(fixture.artifact),
      artifact_id: "artifact_arbitrary_recovery_target",
      blob_id: "",
      artifact_type: "image",
      role: "storyboard_image",
      storage: { uri: "", mime_type: "image/png", filename: "" },
      metadata: { ...fixture.artifact.metadata, duration_seconds: null, sha256: "" },
      source: { ...fixture.artifact.source, provider_job_id: "", sha256: "" }
    };
    db.prepare(`INSERT INTO media_artifacts
      (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
      VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)`)
      .run(arbitraryArtifact.artifact_id, fixture.project_id, fixture.shot_id, JSON.stringify(arbitraryArtifact));
    const arbitrary = await downloadProviderOutputToArtifact({
      ...base,
      provider_job_id: "local_recovery_arbitrary_artifact",
      verified_blob_recovery: { invalid_artifact_id: arbitraryArtifact.artifact_id }
    }, db, runtime);
    assert.equal(arbitrary.ok, false);
    if (!arbitrary.ok) assert.equal(arbitrary.error.code, "MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
    assert.equal(readFileSync(fixture.artifact.storage.uri).toString("utf8"), "corrupt-binding-target");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_blobs").get() as { count: number }).count, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 secret redactor removes fake credential from text", () => {
  const redacted = redactSecrets(`Authorization: Bearer ${FAKE_SECRET}\nRUNWAYML_API_SECRET=${FAKE_SECRET}`, [FAKE_SECRET]);
  assert.equal(redacted.includes(FAKE_SECRET), false);
  assert.equal(redacted.includes("<REDACTED>") || redacted.includes("<REDACTED_TEST_SECRET>"), true);
});

test("M1 strict Runway canary dry-run guard is single-submit and offline", () => {
  const report = buildRunwayCanaryDryRunReport({
    mode: "dry_run",
    env: {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runway",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNWAYML_API_SECRET: FAKE_SECRET
    } as NodeJS.ProcessEnv
  });

  assert.equal(report.result, "PASS_READY_FOR_USER_AUTHORIZATION");
  assert.equal(report.network_call_attempted, false);
  assert.equal(report.runway_called, false);
  assert.equal(report.runninghub_called, false);
  assert.equal(report.provider_credits_consumed, false);
  assert.equal(report.real_video_generated, false);
  assert.equal(report.provider_boundary.provider, "runway");
  assert.equal(report.provider_boundary.model, "gen4.5");
  assert.equal(report.provider_boundary.max_submit_calls, 1);
  assert.equal(report.provider_boundary.duration_seconds, 2);
  assert.equal(report.provider_boundary.runway_ratio, "720:1280");
  assert.equal(report.provider_boundary.allow_regeneration, false);
  assert.equal(report.provider_boundary.allow_batch_generation, false);
  assert.equal(report.selected_canary_input.path, "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png");
  assert.equal(report.selected_canary_input.aspect_ratio, "9:16");
  assert.equal(report.selected_canary_input.usable_for_real_provider_canary, true);
  assert.equal(report.dry_run.start_storyboard_video_generation_called, false);
  assert.equal(report.dry_run.submit_generation_called, false);
  assert.equal(report.dry_run.fallback_to_demo_m1_real, false);
});

test("M1 strict Runway canary live mode blocks without exact authorization", () => {
  const report = buildRunwayCanaryDryRunReport({
    mode: "live",
    env: {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runway",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNWAYML_API_SECRET: FAKE_SECRET
    } as NodeJS.ProcessEnv
  });

  assert.equal(report.result, "BLOCK_WITH_REASON");
  assert.equal(report.authorization.provided, false);
  assert.equal(report.authorization.accepted, false);
  assert.match(report.block_reason ?? "", /authorization/i);
  assert.equal(report.network_call_attempted, false);
  assert.equal(report.runway_called, false);
  assert.equal(report.dry_run.start_storyboard_video_generation_called, false);
  assert.equal(report.dry_run.submit_generation_called, false);
});
