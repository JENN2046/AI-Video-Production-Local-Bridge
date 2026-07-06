import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createProject,
  downloadProviderOutputToArtifact,
  getMediaArtifact,
  importStoryboardPackage,
  listProviderConfigs,
  mapRunwayAspectRatio,
  normalizeRunwayDuration,
  openM0Database,
  paths,
  redactSecrets,
  registerMediaArtifact,
  RunwayVideoProviderAdapter,
  selectM1ProviderPort,
  startStoryboardVideoGeneration,
  validateProviderOutputUrl
} from "../src/index.js";
import type { MediaArtifact } from "../src/index.js";

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
      source: { kind: "fixture_path", path: "storyboard/shot_001.png" }
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

test("M1 provider registry keeps mock default and exposes two real ports", () => {
  const configs = listProviderConfigs();
  assert.equal(configs.find((config) => config.provider_name === "mock")?.default, true);
  assert.equal(configs.find((config) => config.provider_name === "runway")?.selectable, true);
  assert.equal(configs.find((config) => config.provider_name === "runninghub")?.selectable, true);
  assert.equal(configs.find((config) => config.provider_name === "runway")?.primary, true);
  assert.equal(configs.find((config) => config.provider_name === "runninghub")?.model_name, "rhart-video-g/image-to-video");
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

test("M1 RunningHub selectable boundary fails honestly without fake success", async () => {
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

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].status, "failed");
    assert.equal(result.runs[0].provider.provider_name, "runninghub");
    assert.equal(result.runs[0].error.code, "PROVIDER_UNSUPPORTED");
    assert.deepEqual(result.runs[0].output.artifact_ids, []);
  } finally {
    db.close();
  }
});

test("M1 Runway request boundary rejects unsupported ratio and duration before network", async () => {
  assert.equal(mapRunwayAspectRatio("9:16"), "768:1280");
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
  const fakeArtifact = {
    status: "active",
    artifact_type: "image",
    role: "storyboard_image",
    storage: { uri: join(paths.workspaceRoot, "fixtures", "storyboard", "shot_001.png"), mime_type: "image/png", filename: "shot_001.png" }
  } as MediaArtifact;

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

test("M1 provider output URL safety blocks unsafe destinations", () => {
  for (const url of [
    "http://example.com/video.mp4",
    "file:///tmp/video.mp4",
    "data:video/mp4;base64,AAAA",
    "https://localhost/video.mp4",
    "https://127.0.0.1/video.mp4",
    "https://10.0.0.2/video.mp4",
    "https://169.254.169.254/latest/meta-data"
  ]) {
    const result = validateProviderOutputUrl(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.equal(result.error.code, "PROVIDER_OUTPUT_URI_BLOCKED");
  }
  assert.equal(validateProviderOutputUrl("https://cdn.example.test/video.mp4").ok, true);
});

test("M1 provider output downloader saves ffprobe-valid local artifact without persisting URL", async () => {
  const db = openM0Database();
  try {
    const fixtureBytes = readFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
    const result = await downloadProviderOutputToArtifact(
      {
        url: "https://cdn.example.test/generated/output.mp4?signature=secret",
        provider_name: "runway",
        provider_job_id: "runway_job_test",
        project_id: "project_test",
        shot_id: "shot_test",
        duration_seconds: 2,
        aspect_ratio: "9:16",
        fetch_impl: (async () =>
          new Response(fixtureBytes, {
            status: 200,
            headers: {
              "content-type": "video/mp4",
              "content-length": String(fixtureBytes.length)
            }
          })) as typeof fetch
      },
      db
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const artifact = getMediaArtifact(db, result.artifact.artifact_id);
    assert.equal(artifact?.source.provider, "runway");
    assert.equal(artifact?.source.provider_job_id, "runway_job_test");
    assert.equal(artifact?.source.external_url_host, "cdn.example.test");
    assert.equal(artifact?.storage.uri.includes("signature"), false);
    assert.equal(result.ffprobe.status, "PASS");
  } finally {
    db.close();
  }
});

test("M1 secret redactor removes fake credential from text", () => {
  const redacted = redactSecrets(`Authorization: Bearer ${FAKE_SECRET}\nRUNWAYML_API_SECRET=${FAKE_SECRET}`, [FAKE_SECRET]);
  assert.equal(redacted.includes(FAKE_SECRET), false);
  assert.equal(redacted.includes("<REDACTED>") || redacted.includes("<REDACTED_TEST_SECRET>"), true);
});
