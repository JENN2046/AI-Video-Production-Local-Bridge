import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderCapabilityKey,
  buildProviderPriceCacheKey,
  buildRunningHubImageToVideoSubmitRequest,
  PROVIDER_CAPABILITY_REGISTRY_VERSION,
  RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY,
  RUNWAY_IMAGE_TO_VIDEO_CAPABILITY,
  projectProviderRequest,
  selectM1ProviderPort,
  type MediaArtifact,
  type ProviderGenerationInput
} from "../src/index.js";

function storyboardArtifact(): MediaArtifact {
  return {
    artifact_id: "artifact_capability_fixture",
    blob_id: "blob_capability_fixture",
    artifact_type: "image",
    role: "storyboard_image",
    status: "active",
    storage: { uri: "synthetic-fixture.png", mime_type: "image/png", filename: "synthetic-fixture.png" },
    metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256: "a".repeat(64) },
    linked_objects: { project_id: "project_capability", shot_id: "shot_capability" },
    source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: "a".repeat(64), external_url_host: "" }
  };
}

test("Provider capability registry owns current routes, defaults, and duration bounds", () => {
  assert.equal(PROVIDER_CAPABILITY_REGISTRY_VERSION, "provider-capabilities-v1");
  assert.equal(RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model, "rhart-video-g/image-to-video");
  assert.equal(RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.default_resolution, "480p");
  assert.equal(RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.duration.min_seconds, 6);
  assert.equal(RUNWAY_IMAGE_TO_VIDEO_CAPABILITY.model, "gen4.5");
});

test("Provider capability key rejects model, duration, resolution, and aspect drift", () => {
  const valid = buildProviderCapabilityKey({ provider: "runninghub", model: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model, duration_seconds: 6, resolution: "1080x1920", aspect_ratio: "9:16" });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.key.resolution, "480p");
  if (valid.ok) assert.match(valid.key.serialized, /^provider-capabilities-v1\|runninghub\.image_to_video\.v1\|/);
  const otherAspect = buildProviderCapabilityKey({ provider: "runninghub", model: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model, duration_seconds: 6, resolution: "1920x1080", aspect_ratio: "16:9" });
  assert.equal(otherAspect.ok, true);
  if (valid.ok && otherAspect.ok) {
    assert.notEqual(valid.key.serialized, otherAspect.key.serialized);
    const validPriceKey = buildProviderPriceCacheKey(valid.key, valid.capability);
    const otherPriceKey = buildProviderPriceCacheKey(otherAspect.key, otherAspect.capability);
    assert.notEqual(validPriceKey.serialized, otherPriceKey.serialized);
    assert.notEqual(validPriceKey.storage_resolution, otherPriceKey.storage_resolution);
  }

  const cases = [
    buildProviderCapabilityKey({ provider: "runninghub", model: "stale-model", duration_seconds: 6, resolution: "480p", aspect_ratio: "9:16" }),
    buildProviderCapabilityKey({ provider: "runninghub", duration_seconds: 5, resolution: "480p", aspect_ratio: "9:16" }),
    buildProviderCapabilityKey({ provider: "runninghub", duration_seconds: 6, resolution: "1080p", aspect_ratio: "9:16" }),
    buildProviderCapabilityKey({ provider: "runninghub", duration_seconds: 6, resolution: "badxvalue", aspect_ratio: "9:16" }),
    buildProviderCapabilityKey({ provider: "runninghub", duration_seconds: 6, resolution: "480p", aspect_ratio: "4:5" })
  ];
  assert.deepEqual(cases.map((item) => item.ok ? "OK" : item.code), [
    "PROVIDER_CAPABILITY_MODEL_MISMATCH",
    "PROVIDER_CAPABILITY_DURATION_UNSUPPORTED",
    "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED",
    "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED",
    "PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED"
  ]);
});

test("Provider capability maps pixel dimensions by Provider aspect instead of a global default", () => {
  const vertical = buildProviderCapabilityKey({ provider: "runway", model: RUNWAY_IMAGE_TO_VIDEO_CAPABILITY.model, duration_seconds: 5, resolution: "720x1280", aspect_ratio: "9:16" });
  const horizontal = buildProviderCapabilityKey({ provider: "runway", model: RUNWAY_IMAGE_TO_VIDEO_CAPABILITY.model, duration_seconds: 5, resolution: "1280x768", aspect_ratio: "16:9" });
  const inconsistent = buildProviderCapabilityKey({ provider: "runway", model: RUNWAY_IMAGE_TO_VIDEO_CAPABILITY.model, duration_seconds: 5, resolution: "1280x768", aspect_ratio: "9:16" });
  assert.equal(vertical.ok, true);
  assert.equal(horizontal.ok, true);
  if (vertical.ok) assert.equal(vertical.key.resolution, "720:1280");
  if (horizontal.ok) assert.equal(horizontal.key.resolution, "1280:768");
  assert.equal(inconsistent.ok, false);
  if (!inconsistent.ok) assert.equal(inconsistent.code, "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED");
});

test("estimate, intent, and submit projections produce one identical RunningHub key", () => {
  const estimate = buildProviderCapabilityKey({ provider: "runninghub", duration_seconds: 6, resolution: "1080x1920", aspect_ratio: "9:16" });
  assert.equal(estimate.ok, true);
  if (!estimate.ok) return;
  const intent = buildProviderCapabilityKey({
    provider: "runninghub",
    model: estimate.key.model,
    duration_seconds: estimate.key.duration_seconds,
    resolution: estimate.key.resolution,
    aspect_ratio: "9:16"
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) return;
  const projection = projectProviderRequest({
    provider: "runninghub",
    model: intent.key.model,
    duration_seconds: intent.key.duration_seconds,
    resolution: intent.key.resolution,
    aspect_ratio: "9:16"
  });
  assert.equal(projection.ok, true);
  if (!projection.ok) return;
  const generationInput: ProviderGenerationInput = {
    storyboard_artifact: storyboardArtifact(),
    video_prompt: "Move gently",
    negative_prompt: "",
    duration_seconds: projection.request.duration_seconds,
    aspect_ratio: projection.request.aspect_ratio,
    resolution: projection.request.resolution
  };
  const submit = buildRunningHubImageToVideoSubmitRequest({ generation_input: generationInput, uploaded_download_url: "https://example.invalid/input.png" });
  assert.equal(submit.ok, true);
  if (!submit.ok) return;
  const submitKey = buildProviderCapabilityKey({
    provider: "runninghub",
    model: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model,
    duration_seconds: submit.body.duration,
    resolution: submit.body.resolution,
    aspect_ratio: submit.body.aspectRatio
  });
  assert.equal(submitKey.ok, true);
  if (!submitKey.ok) return;
  assert.equal(estimate.key.serialized, intent.key.serialized);
  assert.equal(intent.key.serialized, submitKey.key.serialized);
  const estimatePriceKey = buildProviderPriceCacheKey(estimate.key, estimate.capability);
  const intentPriceKey = buildProviderPriceCacheKey(intent.key, intent.capability);
  const submitPriceKey = buildProviderPriceCacheKey(submitKey.key, submitKey.capability);
  assert.equal(estimatePriceKey.serialized, intentPriceKey.serialized);
  assert.equal(intentPriceKey.serialized, submitPriceKey.serialized);
});

test("Provider selection rejects a model outside the declared capability", () => {
  const result = selectM1ProviderPort({ provider: "real", provider_name: "runninghub", model_name: "stale-model", cost_acknowledged: true }, {
    REAL_PROVIDER_ENABLED: "true",
    M1_REAL_PROVIDER: "runninghub",
    M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
    M1_REAL_PROVIDER_COST_ACK: "true",
    RUNNINGHUB_API_KEY: "synthetic-test-key"
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROVIDER_CAPABILITY_MODEL_MISMATCH");
});
