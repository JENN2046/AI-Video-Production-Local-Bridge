import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { RunningHubVideoProviderAdapter, type ProviderGenerationInput } from "../src/tools/videoProviderAdapters.js";
import type { MediaArtifact } from "../src/tools/mediaArtifacts.js";

function fixtureArtifact(): MediaArtifact {
  return {
    artifact_id: "artifact_fixture",
    blob_id: "",
    artifact_type: "image",
    role: "storyboard_image",
    status: "active",
    storage: {
      uri: resolve("fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png"),
      mime_type: "image/png",
      filename: "shot_001_canary_720x1280.png"
    },
    metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256: "" },
    linked_objects: { project_id: "project_test", shot_id: "shot_test" },
    source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: "", external_url_host: "" }
  };
}

test("RunningHub adapter performs one upload, one submit, and queries the same taskId", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/media/upload/binary")) {
      assert.equal(init?.body instanceof FormData, true);
      return new Response(JSON.stringify({ data: { download_url: "https://example.invalid/uploaded.png" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/rhart-video-g/image-to-video")) {
      return new Response(JSON.stringify({ taskId: "task_123", status: "QUEUED", errorCode: "", errorMessage: "" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/openapi/v2/query")) {
      assert.equal(JSON.parse(String(init?.body)).taskId, "task_123");
      return new Response(JSON.stringify({ taskId: "task_123", status: "SUCCESS", errorCode: "", errorMessage: "", results: [{ outputType: "video", url: "https://example.invalid/output.mp4" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = new RunningHubVideoProviderAdapter({ credential: "synthetic-test-key", fetch_impl: fetchImpl, api_base: "https://runninghub.test" });
  const generation: ProviderGenerationInput = { storyboard_artifact: fixtureArtifact(), video_prompt: "Move gently.", negative_prompt: "", duration_seconds: 6, aspect_ratio: "9:16", resolution: "480p" };
  const submit = await adapter.submitGeneration(generation);
  assert.equal(submit.ok, true);
  if (!submit.ok) return;
  assert.equal(submit.provider_job_id, "task_123");
  const status = await adapter.pollStatus(submit.provider_job_id);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.status, "succeeded");
  assert.equal(status.output_url, "https://example.invalid/output.mp4");
  assert.equal(calls.filter((url) => url.endsWith("/media/upload/binary")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/rhart-video-g/image-to-video")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/openapi/v2/query")).length, 1);
});

test("RunningHub adapter rejects a mismatched taskId and never resubmits", async () => {
  let queryCalls = 0;
  const adapter = new RunningHubVideoProviderAdapter({ credential: "synthetic-test-key", api_base: "https://runninghub.test", fetch_impl: async () => {
    queryCalls += 1;
    return new Response(JSON.stringify({ taskId: "different_task", status: "RUNNING", errorCode: "", errorMessage: "" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await adapter.pollStatus("task_expected");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROVIDER_REQUEST_FAILED");
  assert.equal(queryCalls, 1);
});

test("RunningHub adapter marks a lost submit response as outcome unknown", async () => {
  const adapter = new RunningHubVideoProviderAdapter({ credential: "synthetic-test-key", api_base: "https://runninghub.test", fetch_impl: async (input) => {
    if (String(input).endsWith("/media/upload/binary")) {
      return new Response(JSON.stringify({ data: { download_url: "https://example.invalid/uploaded.png" } }), { status: 200 });
    }
    throw new TypeError("connection closed after request upload");
  } });
  const result = await adapter.submitGeneration({ storyboard_artifact: fixtureArtifact(), video_prompt: "Move gently.", negative_prompt: "", duration_seconds: 6, aspect_ratio: "9:16", resolution: "480p" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.retryable, true);
    assert.equal(result.error.submission_outcome_unknown, true);
  }
});

test("RunningHub adapter does not quarantine a definite submit rejection", async () => {
  const adapter = new RunningHubVideoProviderAdapter({ credential: "synthetic-test-key", api_base: "https://runninghub.test", fetch_impl: async (input) => {
    if (String(input).endsWith("/media/upload/binary")) {
      return new Response(JSON.stringify({ data: { download_url: "https://example.invalid/uploaded.png" } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      errorCode: "INSUFFICIENT_CREDITS",
      errorMessage: "insufficient credits",
      status: "FAILED"
    }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await adapter.submitGeneration({ storyboard_artifact: fixtureArtifact(), video_prompt: "Move gently.", negative_prompt: "", duration_seconds: 6, aspect_ratio: "9:16", resolution: "480p" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "PROVIDER_INSUFFICIENT_CREDITS");
    assert.equal(result.error.retryable, false);
    assert.equal(result.error.submission_outcome_unknown, undefined);
  }
});

test("RunningHub adapter quarantines a malformed success response without taskId or rejection", async () => {
  const adapter = new RunningHubVideoProviderAdapter({ credential: "synthetic-test-key", api_base: "https://runninghub.test", fetch_impl: async (input) => {
    if (String(input).endsWith("/media/upload/binary")) {
      return new Response(JSON.stringify({ data: { download_url: "https://example.invalid/uploaded.png" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", errorCode: "0", errorMessage: "" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await adapter.submitGeneration({ storyboard_artifact: fixtureArtifact(), video_prompt: "Move gently.", negative_prompt: "", duration_seconds: 6, aspect_ratio: "9:16", resolution: "480p" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "PROVIDER_REQUEST_FAILED");
    assert.equal(result.error.submission_outcome_unknown, true);
  }
});
