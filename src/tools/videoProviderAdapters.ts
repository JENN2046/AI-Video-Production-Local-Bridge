import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { MediaArtifact } from "./mediaArtifacts.js";
import { validateImageBuffer, validateImageFile } from "./imageValidity.js";
import {
  projectProviderRequest,
  providerCapabilityErrorMessage,
  RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY,
  RUNWAY_IMAGE_TO_VIDEO_CAPABILITY
} from "./providerCapabilities.js";
import {
  providerError,
  redactSecrets,
  type SanitizedProviderErrorSummary,
  type ProviderToolError,
  type RealProviderName
} from "./provider.js";

export type ProviderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const RUNWAY_API_VERSION = "2024-11-06";
export const RUNWAY_IMAGE_TO_VIDEO_ENDPOINT = "/v1/image_to_video";
export const RUNNINGHUB_API_BASE_URL = "https://www.runninghub.cn";
export const RUNNINGHUB_MODEL_ROUTE = RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model;
export const RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT = `/openapi/v2/${RUNNINGHUB_MODEL_ROUTE}`;
export const RUNNINGHUB_QUERY_ENDPOINT = "/openapi/v2/query";
export const RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT = "/openapi/v2/media/upload/binary";
export const RUNNINGHUB_DEFAULT_RESOLUTION = RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.default_resolution;
export const RUNNINGHUB_MIN_DURATION_SECONDS = RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.duration.min_seconds;
export const RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS = RUNNINGHUB_MIN_DURATION_SECONDS;
export const RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER = "<RUNNINGHUB_UPLOAD_DOWNLOAD_URL>";
export const RUNNINGHUB_AUTHORIZATION_HEADER_PLACEHOLDER = "Bearer <RUNNINGHUB_API_KEY>";
export const RUNNINGHUB_MEDIA_UPLOAD_FILE_FIELD = "file";

export interface ProviderGenerationInput {
  storyboard_artifact: MediaArtifact;
  video_prompt: string;
  negative_prompt: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
}

export type ProviderSubmitResult =
  | { ok: true; provider_job_id: string; provider_status: string }
  | { ok: false; error: ProviderToolError };

export type ProviderStatusResult =
  | {
      ok: true;
      provider_job_id: string;
      status: ProviderJobStatus;
      provider_status: string;
      retryable: boolean;
      output_url?: string;
    }
  | { ok: false; error: ProviderToolError };

export type ProviderOutputResult =
  | { ok: true; provider_job_id: string; output_url: string; provider_status: string }
  | { ok: false; error: ProviderToolError };

export type RunwayImageToVideoRequestBuildResult =
  | {
      ok: true;
      endpoint: typeof RUNWAY_IMAGE_TO_VIDEO_ENDPOINT;
      headers: {
        "Content-Type": "application/json";
        "X-Runway-Version": typeof RUNWAY_API_VERSION;
      };
      body: {
        model: string;
        promptImage: string;
        promptText: string;
        ratio: string;
        duration: number;
      };
      summary: RunwayImageToVideoRequestSummary;
    }
  | { ok: false; error: ProviderToolError };

export interface RunwayPromptImageSummary {
  kind: "data_uri";
  mime_type: string;
  binary_size_bytes: number;
  data_uri_length: number;
  sha256: string;
  width: number;
  height: number;
  aspect_ratio: string;
}

export interface RunwayImageToVideoRequestSummary {
  endpoint: "POST /v1/image_to_video";
  x_runway_version: typeof RUNWAY_API_VERSION;
  model: string;
  ratio: string;
  duration: number;
  prompt_text_length: number;
  prompt_image: RunwayPromptImageSummary;
}

export interface RunningHubImageReferenceSummary {
  source: "uploaded_download_url_required";
  upload_endpoint: `POST ${typeof RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`;
  upload_file_mime_type: string;
  upload_file_size_bytes: number;
  upload_file_sha256: string;
  download_url_placeholder: typeof RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER;
  local_file_path_included: false;
  binary_payload_included: false;
  base64_included: false;
}

export interface RunningHubRequestAuthSummary {
  header_name: "Authorization";
  scheme: "Bearer";
  credential_env_name: "RUNNINGHUB_API_KEY";
  credential_value_included: false;
  authorization_value_included: false;
}

export interface RunningHubMediaUploadRequestSummary {
  endpoint: `POST ${typeof RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`;
  content_type: "multipart/form-data";
  auth: RunningHubRequestAuthSummary;
  file_field: typeof RUNNINGHUB_MEDIA_UPLOAD_FILE_FIELD;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  sha256: string;
  local_file_path_included: false;
  binary_payload_included: false;
  base64_included: false;
}

export type RunningHubMediaUploadRequestBuildResult =
  | {
      ok: true;
      method: "POST";
      endpoint: typeof RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT;
      headers: {
        Authorization: typeof RUNNINGHUB_AUTHORIZATION_HEADER_PLACEHOLDER;
      };
      multipart: {
        file_field: typeof RUNNINGHUB_MEDIA_UPLOAD_FILE_FIELD;
        file_name: string;
        content_type: string;
        binary_payload_placeholder: "<LOCAL_MEDIA_ARTIFACT_BYTES>";
        binary_payload_included: false;
        base64_included: false;
      };
      summary: RunningHubMediaUploadRequestSummary;
    }
  | { ok: false; error: ProviderToolError };

export interface RunningHubImageToVideoSubmitRequestSummary {
  endpoint: `POST ${typeof RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`;
  content_type: "application/json";
  auth: RunningHubRequestAuthSummary;
  prompt_text_length: number;
  negative_prompt_supported: false;
  negative_prompt_text_length: number;
  aspectRatio: string;
  image_urls_count: number;
  image_url_values_included: false;
  imageUrls: [typeof RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER];
  resolution: string;
  duration: number;
  raw_provider_payload_included: false;
}

export type RunningHubImageToVideoSubmitRequestBuildResult =
  | {
      ok: true;
      method: "POST";
      endpoint: typeof RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT;
      headers: {
        Authorization: typeof RUNNINGHUB_AUTHORIZATION_HEADER_PLACEHOLDER;
        "Content-Type": "application/json";
      };
      body: {
        prompt: string;
        aspectRatio: string;
        imageUrls: string[];
        resolution: string;
        duration: number;
      };
      summary: RunningHubImageToVideoSubmitRequestSummary;
    }
  | { ok: false; error: ProviderToolError };

export interface RunningHubQueryRequestSummary {
  endpoint: `POST ${typeof RUNNINGHUB_QUERY_ENDPOINT}`;
  content_type: "application/json";
  auth: RunningHubRequestAuthSummary;
  task_id_present: boolean;
  task_id_length: number;
  task_id_value_included: false;
}

export type RunningHubQueryRequestBuildResult =
  | {
      ok: true;
      method: "POST";
      endpoint: typeof RUNNINGHUB_QUERY_ENDPOINT;
      headers: {
        Authorization: typeof RUNNINGHUB_AUTHORIZATION_HEADER_PLACEHOLDER;
        "Content-Type": "application/json";
      };
      body: {
        taskId: string;
      };
      summary: RunningHubQueryRequestSummary;
    }
  | { ok: false; error: ProviderToolError };

export type RunningHubMediaUploadParseResult =
  | { ok: true; download_url: string; download_url_present: true; raw_provider_payload_recorded: false }
  | { ok: false; error: ProviderToolError };

export type RunningHubSubmitParseResult =
  | {
      ok: true;
      provider_job_id: string;
      provider_status: string;
      error_code: string;
      error_message: string;
      raw_provider_payload_recorded: false;
    }
  | { ok: false; error: ProviderToolError };

export type RunningHubQueryParseResult =
  | {
      ok: true;
      provider_job_id: string;
      status: ProviderJobStatus;
      provider_status: string;
      retryable: boolean;
      output_urls: string[];
      output_url?: string;
      error_code: string;
      error_message: string;
      mapped_error?: ProviderToolError;
      raw_provider_payload_recorded: false;
    }
  | { ok: false; error: ProviderToolError };

export interface RunningHubImageToVideoDryRunPlan {
  provider: "runninghub";
  api_base_url: typeof RUNNINGHUB_API_BASE_URL;
  model_route: typeof RUNNINGHUB_MODEL_ROUTE;
  submit_endpoint: `POST ${typeof RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`;
  auth: {
    header_name: "Authorization";
    scheme: "Bearer";
    credential_env_name: "RUNNINGHUB_API_KEY";
    credential_value_included: false;
  };
  request_body_shape: {
    prompt: "string";
    aspectRatio: "string";
    imageUrls: "string[]";
    resolution: "string";
    duration: "number";
  };
  request_body_sanitized: {
    prompt_text_length: number;
    negative_prompt_supported: false;
    negative_prompt_text_length: number;
    aspectRatio: string;
    imageUrls: [typeof RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER];
    resolution: string;
    duration: number;
  };
  image_reference: RunningHubImageReferenceSummary;
  submit_response_contract: {
    task_id_field: "taskId";
    status_field: "status";
    error_code_field: "errorCode";
    error_message_field: "errorMessage";
    results_field: "results";
  };
  query_contract: {
    endpoint: `POST ${typeof RUNNINGHUB_QUERY_ENDPOINT}`;
    body_shape: { taskId: "string" };
    terminal_success_status: "SUCCESS";
    output_url_field: "results[].url";
    output_type_field: "results[].outputType";
  };
  error_shape: {
    code_field: "code";
    message_fields: ["msg", "message", "errorMessage"];
    model_error_code_field: "errorCode";
  };
  unresolved_fields: string[];
  provider_boundary: {
    network_call_attempted: false;
    runninghub_called: false;
    runway_called: false;
    provider_credits_consumed: false;
    real_video_generated: false;
    secret_values_exposed: false;
  };
}

export interface VideoProviderAdapter {
  provider_name: RealProviderName | "mock";
  model_name: string;
  submitGeneration(input: ProviderGenerationInput): Promise<ProviderSubmitResult>;
  pollStatus(providerJobId: string): Promise<ProviderStatusResult>;
  fetchOutput(providerJobId: string): Promise<ProviderOutputResult>;
}

export class MockVideoProviderAdapter implements VideoProviderAdapter {
  provider_name = "mock" as const;
  model_name = "mock_fixture";
  private readonly jobs = new Map<string, { fixture_path: string }>();

  async submitGeneration(): Promise<ProviderSubmitResult> {
    const providerJobId = `mock_job_${randomUUID()}`;
    this.jobs.set(providerJobId, { fixture_path: "video/mock_clip.mp4" });
    return { ok: true, provider_job_id: providerJobId, provider_status: "succeeded" };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusResult> {
    if (!this.jobs.has(providerJobId)) {
      return { ok: false, error: providerError("PROVIDER_NOT_FOUND", "Mock provider job was not found.") };
    }
    return {
      ok: true,
      provider_job_id: providerJobId,
      status: "succeeded",
      provider_status: "succeeded",
      retryable: false
    };
  }

  async fetchOutput(providerJobId: string): Promise<ProviderOutputResult> {
    if (!this.jobs.has(providerJobId)) {
      return { ok: false, error: providerError("PROVIDER_NOT_FOUND", "Mock provider job was not found.") };
    }
    return {
      ok: true,
      provider_job_id: providerJobId,
      output_url: "fixture://video/mock_clip.mp4",
      provider_status: "succeeded"
    };
  }
}

export function mapRunwayAspectRatio(aspectRatio: string): string | null {
  if (aspectRatio === "9:16") return "720:1280";
  if (aspectRatio === "16:9") return "1280:768";
  return null;
}

export function normalizeRunwayDuration(durationSeconds: number): number | null {
  const rule = RUNWAY_IMAGE_TO_VIDEO_CAPABILITY.duration;
  if (!Number.isInteger(durationSeconds)) return null;
  if (durationSeconds < rule.min_seconds || durationSeconds > rule.max_seconds) return null;
  return durationSeconds;
}

export function mapRunningHubAspectRatio(aspectRatio: string): string | null {
  if (RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.allowed_aspect_ratios.includes(aspectRatio)) return aspectRatio;
  return null;
}

export function normalizeRunningHubDurationForDryRun(durationSeconds: number): number | null {
  const rule = RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.duration;
  if (!Number.isInteger(durationSeconds)) return null;
  if (durationSeconds < rule.min_seconds || durationSeconds > rule.max_seconds || (durationSeconds - rule.min_seconds) % rule.step_seconds !== 0) return null;
  return durationSeconds;
}

function runningHubAuthSummary(): RunningHubRequestAuthSummary {
  return {
    header_name: "Authorization",
    scheme: "Bearer",
    credential_env_name: "RUNNINGHUB_API_KEY",
    credential_value_included: false,
    authorization_value_included: false
  };
}

function ensureRunningHubStoryboardImageArtifact(artifact: MediaArtifact): { ok: true } | { ok: false; error: ProviderToolError } {
  if (artifact.status !== "active" || artifact.artifact_type !== "image" || artifact.role !== "storyboard_image") {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", "RunningHub requires an active storyboard_image image artifact.") };
  }
  return { ok: true };
}

function runningHubUploadFacts(artifact: MediaArtifact):
  | {
      ok: true;
      file_name: string;
      mime_type: string;
      file_size_bytes: number;
      sha256: string;
    }
  | { ok: false; error: ProviderToolError } {
  const artifactGate = ensureRunningHubStoryboardImageArtifact(artifact);
  if (!artifactGate.ok) return artifactGate;

  const validation = validateImageFile(artifact.storage.uri);
  if (!validation.ok) {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", validation.error || "RunningHub upload image is not readable.") };
  }

  if (!validation.detected_mime.startsWith("image/")) {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", "RunningHub upload requires an image file.") };
  }

  let fileSize = 0;
  try {
    fileSize = statSync(artifact.storage.uri).size;
  } catch (error) {
    return {
      ok: false,
      error: providerError("PROVIDER_UNSUPPORTED_INPUT", error instanceof Error ? error.message : "RunningHub upload image size is not readable.")
    };
  }
  if ((artifact.metadata.sha256 && artifact.metadata.sha256 !== validation.sha256)
    || (artifact.source.sha256 && artifact.source.sha256 !== validation.sha256)
    || (artifact.storage.mime_type && artifact.storage.mime_type !== validation.detected_mime)) {
    return { ok: false, error: providerError("PROVIDER_INPUT_INTEGRITY_DRIFT", "RunningHub upload bytes differ from the registered Artifact facts.") };
  }

  return {
    ok: true,
    file_name: artifact.storage.filename || "storyboard_image.png",
    mime_type: validation.detected_mime || artifact.storage.mime_type,
    file_size_bytes: fileSize,
    sha256: validation.sha256
  };
}

export function buildRunningHubMediaUploadRequest(input: { storyboard_artifact: MediaArtifact }): RunningHubMediaUploadRequestBuildResult {
  const facts = runningHubUploadFacts(input.storyboard_artifact);
  if (!facts.ok) return { ok: false, error: facts.error };

  const summary: RunningHubMediaUploadRequestSummary = {
    endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
    content_type: "multipart/form-data",
    auth: runningHubAuthSummary(),
    file_field: RUNNINGHUB_MEDIA_UPLOAD_FILE_FIELD,
    file_name: facts.file_name,
    mime_type: facts.mime_type,
    file_size_bytes: facts.file_size_bytes,
    sha256: facts.sha256,
    local_file_path_included: false,
    binary_payload_included: false,
    base64_included: false
  };

  return {
    ok: true,
    method: "POST",
    endpoint: RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
    headers: {
      Authorization: RUNNINGHUB_AUTHORIZATION_HEADER_PLACEHOLDER
    },
    multipart: {
      file_field: RUNNINGHUB_MEDIA_UPLOAD_FILE_FIELD,
      file_name: facts.file_name,
      content_type: facts.mime_type,
      binary_payload_placeholder: "<LOCAL_MEDIA_ARTIFACT_BYTES>",
      binary_payload_included: false,
      base64_included: false
    },
    summary
  };
}

export function buildRunningHubImageToVideoSubmitRequest(input: {
  generation_input: ProviderGenerationInput;
  uploaded_download_url?: string;
}): RunningHubImageToVideoSubmitRequestBuildResult {
  const artifactGate = ensureRunningHubStoryboardImageArtifact(input.generation_input.storyboard_artifact);
  if (!artifactGate.ok) return { ok: false, error: artifactGate.error };

  const contract = projectProviderRequest({
    provider: "runninghub",
    model: RUNNINGHUB_MODEL_ROUTE,
    duration_seconds: input.generation_input.duration_seconds,
    resolution: input.generation_input.resolution,
    aspect_ratio: input.generation_input.aspect_ratio
  });
  if (!contract.ok) {
    return {
      ok: false,
      error: providerError("PROVIDER_UNSUPPORTED_INPUT", providerCapabilityErrorMessage(contract))
    };
  }
  const aspectRatio = contract.request.aspect_ratio;
  const duration = contract.request.duration_seconds;
  const resolution = contract.request.resolution;

  const uploadedDownloadUrl = input.uploaded_download_url ?? RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER;
  if (!uploadedDownloadUrl.trim()) {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", "RunningHub submit requires an uploaded image download URL.") };
  }

  const summary: RunningHubImageToVideoSubmitRequestSummary = {
    endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
    content_type: "application/json",
    auth: runningHubAuthSummary(),
    prompt_text_length: input.generation_input.video_prompt.length,
    negative_prompt_supported: false,
    negative_prompt_text_length: input.generation_input.negative_prompt.length,
    aspectRatio,
    image_urls_count: 1,
    image_url_values_included: false,
    imageUrls: [RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER],
    resolution,
    duration,
    raw_provider_payload_included: false
  };

  return {
    ok: true,
    method: "POST",
    endpoint: RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
    headers: {
      Authorization: RUNNINGHUB_AUTHORIZATION_HEADER_PLACEHOLDER,
      "Content-Type": "application/json"
    },
    body: {
      prompt: input.generation_input.video_prompt,
      aspectRatio,
      imageUrls: [uploadedDownloadUrl],
      resolution,
      duration
    },
    summary
  };
}

export function buildRunningHubQueryRequest(providerJobId: string): RunningHubQueryRequestBuildResult {
  if (!providerJobId.trim()) {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", "RunningHub query requires a non-empty taskId.") };
  }

  return {
    ok: true,
    method: "POST",
    endpoint: RUNNINGHUB_QUERY_ENDPOINT,
    headers: {
      Authorization: RUNNINGHUB_AUTHORIZATION_HEADER_PLACEHOLDER,
      "Content-Type": "application/json"
    },
    body: {
      taskId: providerJobId
    },
    summary: {
      endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      content_type: "application/json",
      auth: runningHubAuthSummary(),
      task_id_present: true,
      task_id_length: providerJobId.length,
      task_id_value_included: false
    }
  };
}

function runningHubSuccessLikeErrorCode(errorCode: string): boolean {
  const normalized = errorCode.trim().toLowerCase();
  return normalized === "" || normalized === "0" || normalized === "success" || normalized === "ok" || normalized === "null";
}

function runningHubProviderErrorSummary(input: {
  http_status?: number | null;
  payload?: Record<string, unknown>;
  error_code?: unknown;
  error_message?: unknown;
  secrets?: string[];
  retryable?: boolean;
}): SanitizedProviderErrorSummary {
  const payload = input.payload ?? {};
  const errorPayload = payloadObject(payload.error);
  const secrets = input.secrets ?? [];
  return {
    http_status: input.http_status ?? null,
    provider_error_code: firstShortString(secrets, input.error_code, payload.errorCode, payload.code, errorPayload.code, errorPayload.errorCode),
    provider_error_message: firstShortString(input.secrets ?? [], input.error_message, payload.errorMessage, payload.msg, payload.message, errorPayload.message, errorPayload.errorMessage),
    provider_error_field: firstShortString(secrets, payload.field, payload.param, payload.path, errorPayload.field, errorPayload.param, errorPayload.path),
    retryable: input.retryable ?? false
  };
}

export function mapRunningHubProviderError(input: {
  http_status?: number | null;
  payload?: Record<string, unknown>;
  error_code?: unknown;
  error_message?: unknown;
  secrets?: string[];
}): ProviderToolError {
  const status = input.http_status ?? null;
  const summary = runningHubProviderErrorSummary({
    http_status: status,
    payload: input.payload,
    error_code: input.error_code,
    error_message: input.error_message,
    secrets: input.secrets
  });
  const text = [summary.provider_error_code, summary.provider_error_message].filter(Boolean).join(" ").toLowerCase();

  if (status === 401 || text.includes("invalid api key") || text.includes("api key") || text.includes("unauthorized") || text.includes("auth")) {
    summary.retryable = false;
    return providerError("PROVIDER_AUTH_FAILED", "RunningHub authentication failed.", false, summary);
  }

  if (text.includes("rate") || text.includes("too many") || text.includes("frequency")) {
    summary.retryable = true;
    return providerError("PROVIDER_RATE_LIMITED", "RunningHub rate limit was reached.", true, summary);
  }

  if (status === 403 || text.includes("permission") || text.includes("forbidden")) {
    summary.retryable = false;
    return providerError("PROVIDER_AUTH_FAILED", "RunningHub permission check failed.", false, summary);
  }

  if (status === 402 || text.includes("credit") || text.includes("balance") || text.includes("quota") || text.includes("insufficient")) {
    summary.retryable = false;
    return providerError("PROVIDER_INSUFFICIENT_CREDITS", "RunningHub reports insufficient credits or quota.", false, summary);
  }

  if (text.includes("safety") || text.includes("sensitive") || text.includes("moderation") || text.includes("content")) {
    summary.retryable = false;
    return providerError("PROVIDER_CONTENT_REJECTED", "RunningHub rejected the request for content safety.", false, summary);
  }

  if (status === 408 || status === 504 || text.includes("timeout") || text.includes("timed out")) {
    summary.retryable = true;
    return providerError("PROVIDER_TIMEOUT", "RunningHub request timed out.", true, summary);
  }

  if (status !== null && (status === 429 || status >= 500)) {
    summary.retryable = status === 429 || status >= 500;
    if (status === 429) return providerError("PROVIDER_RATE_LIMITED", "RunningHub rate limit was reached.", true, summary);
    return providerError("PROVIDER_TRANSIENT_FAILURE", "RunningHub returned a transient server error.", true, summary);
  }

  if (status === 400 || status === 422) {
    summary.retryable = false;
    return providerError("PROVIDER_UNSUPPORTED_INPUT", "RunningHub rejected the request input.", false, summary);
  }

  if (text.includes("generation") || text.includes("failed") || text.includes("failure")) {
    summary.retryable = false;
    return providerError("PROVIDER_REQUEST_FAILED", "RunningHub generation failed.", false, summary);
  }

  summary.retryable = false;
  return providerError("PROVIDER_REQUEST_FAILED", "RunningHub provider request failed.", false, summary);
}

export function parseRunningHubMediaUploadResponse(payload: unknown, secrets: string[] = []): RunningHubMediaUploadParseResult {
  const record = payloadObject(payload);
  const data = payloadObject(record.data);
  const downloadUrl = stringField(data, "download_url") || stringField(record, "download_url");
  if (downloadUrl) {
    return {
      ok: true,
      download_url: downloadUrl,
      download_url_present: true,
      raw_provider_payload_recorded: false
    };
  }

  if (stringField(record, "errorCode") || stringField(record, "code") || stringField(record, "msg") || stringField(record, "message")) {
    return { ok: false, error: mapRunningHubProviderError({ payload: record, secrets }) };
  }

  return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "RunningHub upload response did not include data.download_url.") };
}

export function parseRunningHubSubmitResponse(payload: unknown, secrets: string[] = []): RunningHubSubmitParseResult {
  const record = payloadObject(payload);
  const taskId = stringField(record, "taskId");
  const providerStatus = stringField(record, "status") || "UNKNOWN";
  const errorCode = stringField(record, "errorCode");
  const errorMessage = stringField(record, "errorMessage");

  if (!taskId && (!runningHubSuccessLikeErrorCode(errorCode) || errorMessage)) {
    return { ok: false, error: mapRunningHubProviderError({ payload: record, error_code: errorCode, error_message: errorMessage, secrets }) };
  }

  if (!taskId) {
    return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "RunningHub submit response did not include taskId.") };
  }

  return {
    ok: true,
    provider_job_id: taskId,
    provider_status: providerStatus,
    error_code: errorCode,
    error_message: errorMessage,
    raw_provider_payload_recorded: false
  };
}

function runningHubStatusFromProvider(providerStatus: string): { status: ProviderJobStatus; retryable: boolean } {
  const normalized = providerStatus.trim().toUpperCase();
  if (normalized === "SUCCESS" || normalized === "SUCCEEDED" || normalized === "COMPLETED") return { status: "succeeded", retryable: false };
  if (normalized === "FAILED" || normalized === "FAIL" || normalized === "ERROR") return { status: "failed", retryable: false };
  if (normalized === "CANCELLED" || normalized === "CANCELED") return { status: "cancelled", retryable: false };
  if (normalized === "PENDING" || normalized === "QUEUED" || normalized === "WAITING" || normalized === "CREATED") return { status: "queued", retryable: true };
  return { status: "running", retryable: true };
}

function runningHubResultUrls(payload: Record<string, unknown>): string[] {
  const results = payload.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => {
      if (typeof item === "string") return item;
      const record = payloadObject(item);
      const outputType = stringField(record, "outputType").toLowerCase();
      if (outputType && !outputType.includes("video") && !outputType.includes("mp4")) return "";
      return stringField(record, "url");
    })
    .filter(Boolean);
}

export function parseRunningHubQueryResponse(payload: unknown, fallbackProviderJobId = "", secrets: string[] = []): RunningHubQueryParseResult {
  const record = payloadObject(payload);
  const taskId = stringField(record, "taskId") || fallbackProviderJobId;
  const providerStatus = stringField(record, "status") || "UNKNOWN";
  const errorCode = stringField(record, "errorCode");
  const errorMessage = stringField(record, "errorMessage");
  const mapped = runningHubStatusFromProvider(providerStatus);

  if (!taskId) {
    return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "RunningHub query response did not include taskId.") };
  }

  const mappedError = !runningHubSuccessLikeErrorCode(errorCode) || (mapped.status === "failed" && errorMessage)
    ? mapRunningHubProviderError({ payload: record, error_code: errorCode, error_message: errorMessage, secrets })
    : undefined;
  const outputUrls = runningHubResultUrls(record);
  if (mapped.status === "succeeded" && outputUrls.length === 0) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_MISSING", "RunningHub query response succeeded without results[].url.") };
  }

  return {
    ok: true,
    provider_job_id: taskId,
    status: mapped.status,
    provider_status: providerStatus,
    retryable: mapped.retryable,
    output_urls: outputUrls,
    ...(outputUrls[0] ? { output_url: outputUrls[0] } : {}),
    error_code: errorCode,
    error_message: errorMessage,
    ...(mappedError ? { mapped_error: mappedError } : {}),
    raw_provider_payload_recorded: false
  };
}

export function buildRunningHubImageToVideoDryRunPlan(input: ProviderGenerationInput): { ok: true; plan: RunningHubImageToVideoDryRunPlan } | { ok: false; error: ProviderToolError } {
  const artifactGate = ensureRunningHubStoryboardImageArtifact(input.storyboard_artifact);
  if (!artifactGate.ok) return { ok: false, error: artifactGate.error };

  const contract = projectProviderRequest({
    provider: "runninghub",
    model: RUNNINGHUB_MODEL_ROUTE,
    duration_seconds: input.duration_seconds,
    resolution: input.resolution,
    aspect_ratio: input.aspect_ratio
  });
  if (!contract.ok) {
    return {
      ok: false,
      error: providerError("PROVIDER_UNSUPPORTED_INPUT", providerCapabilityErrorMessage(contract))
    };
  }
  const aspectRatio = contract.request.aspect_ratio;
  const duration = contract.request.duration_seconds;

  return {
    ok: true,
    plan: {
      provider: "runninghub",
      api_base_url: RUNNINGHUB_API_BASE_URL,
      model_route: RUNNINGHUB_MODEL_ROUTE,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      auth: {
        header_name: "Authorization",
        scheme: "Bearer",
        credential_env_name: "RUNNINGHUB_API_KEY",
        credential_value_included: false
      },
      request_body_shape: {
        prompt: "string",
        aspectRatio: "string",
        imageUrls: "string[]",
        resolution: "string",
        duration: "number"
      },
      request_body_sanitized: {
        prompt_text_length: input.video_prompt.length,
        negative_prompt_supported: false,
        negative_prompt_text_length: input.negative_prompt.length,
        aspectRatio,
        imageUrls: [RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER],
        resolution: contract.request.resolution,
        duration
      },
      image_reference: {
        source: "uploaded_download_url_required",
        upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
        upload_file_mime_type: input.storyboard_artifact.storage.mime_type,
        upload_file_size_bytes: 0,
        upload_file_sha256: input.storyboard_artifact.metadata?.sha256 ?? "",
        download_url_placeholder: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
        local_file_path_included: false,
        binary_payload_included: false,
        base64_included: false
      },
      submit_response_contract: {
        task_id_field: "taskId",
        status_field: "status",
        error_code_field: "errorCode",
        error_message_field: "errorMessage",
        results_field: "results"
      },
      query_contract: {
        endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
        body_shape: { taskId: "string" },
        terminal_success_status: "SUCCESS",
        output_url_field: "results[].url",
        output_type_field: "results[].outputType"
      },
      error_shape: {
        code_field: "code",
        message_fields: ["msg", "message", "errorMessage"],
        model_error_code_field: "errorCode"
      },
      unresolved_fields: [
        "Official page does not enumerate all supported aspectRatio values; 9:16 remains planned for vertical output.",
        "R3-8J sanitized provider evidence established minimum duration 6; maximum supported duration remains unresolved.",
        "Official page does not document a native negative_prompt field for this model API.",
        "Local app media requires a future RunningHub upload step before imageUrls can be populated."
      ],
      provider_boundary: {
        network_call_attempted: false,
        runninghub_called: false,
        runway_called: false,
        provider_credits_consumed: false,
        real_video_generated: false,
        secret_values_exposed: false
      }
    }
  };
}

function dataUriFromImageArtifact(artifact: MediaArtifact): { ok: true; data_uri: string; prompt_image: RunwayPromptImageSummary } | { ok: false; error: ProviderToolError } {
  if (artifact.status !== "active" || artifact.artifact_type !== "image" || artifact.role !== "storyboard_image") {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", "Runway requires an active storyboard_image image artifact.") };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(artifact.storage.uri);
  } catch (error) {
    return {
      ok: false,
      error: providerError("PROVIDER_UNSUPPORTED_INPUT", error instanceof Error ? error.message : "Storyboard image is not readable.")
    };
  }

  const validation = validateImageBuffer(buffer, artifact.storage.uri);
  if (!validation.ok) {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", validation.error || "Storyboard image validation failed.") };
  }

  const mime = validation.detected_mime || artifact.storage.mime_type;
  if (!mime || !mime.startsWith("image/")) {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", "Storyboard image MIME type is not supported.") };
  }

  const encoded = buffer.toString("base64");
  const dataUri = `data:${mime};base64,${encoded}`;
  return {
    ok: true,
    data_uri: dataUri,
    prompt_image: {
      kind: "data_uri",
      mime_type: mime,
      binary_size_bytes: buffer.length,
      data_uri_length: dataUri.length,
      sha256: validation.sha256,
      width: validation.width,
      height: validation.height,
      aspect_ratio: validation.aspect_ratio
    }
  };
}

export function buildRunwayImageToVideoRequest(input: ProviderGenerationInput, modelName = RUNWAY_IMAGE_TO_VIDEO_CAPABILITY.model): RunwayImageToVideoRequestBuildResult {
  const ratio = mapRunwayAspectRatio(input.aspect_ratio);
  if (!ratio) return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", `Unsupported Runway aspect ratio: ${input.aspect_ratio}.`) };

  const duration = normalizeRunwayDuration(input.duration_seconds);
  if (duration === null) {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED_INPUT", `Unsupported Runway duration: ${input.duration_seconds}.`) };
  }

  const promptImage = dataUriFromImageArtifact(input.storyboard_artifact);
  if (!promptImage.ok) return { ok: false, error: promptImage.error };

  return {
    ok: true,
    endpoint: RUNWAY_IMAGE_TO_VIDEO_ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      "X-Runway-Version": RUNWAY_API_VERSION
    },
    body: {
      model: modelName,
      promptImage: promptImage.data_uri,
      promptText: input.video_prompt,
      ratio,
      duration
    },
    summary: {
      endpoint: "POST /v1/image_to_video",
      x_runway_version: RUNWAY_API_VERSION,
      model: modelName,
      ratio,
      duration,
      prompt_text_length: input.video_prompt.length,
      prompt_image: promptImage.prompt_image
    }
  };
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function shortSafe(value: unknown, secrets: string[]): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const redacted = redactSecrets(value, secrets)
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "<REDACTED_DATA_URI>")
    .replace(/[A-Za-z0-9+/=]{200,}/g, "<REDACTED_LONG_TOKEN>")
    .trim();
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
}

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstShortString(secrets: string[], ...values: unknown[]): string | null {
  for (const value of values) {
    const safe = shortSafe(value, secrets);
    if (safe) return safe;
  }
  return null;
}

function providerSummaryFromHttp(status: number, retryable: boolean, payload: Record<string, unknown>, secrets: string[]): SanitizedProviderErrorSummary {
  const errorPayload = payloadObject(payload.error);
  const errorString = typeof payload.error === "string" ? payload.error : null;
  return {
    http_status: status,
    provider_error_code: firstShortString(
      secrets,
      payload.code,
      payload.error_code,
      payload.errorCode,
      payload.type,
      errorPayload.code,
      errorPayload.error_code,
      errorPayload.type,
      errorPayload.name
    ),
    provider_error_message: firstShortString(
      secrets,
      payload.message,
      payload.error_message,
      payload.errorMessage,
      payload.error_description,
      errorPayload.message,
      errorPayload.error_message,
      errorPayload.detail,
      errorString
    ),
    provider_error_field: firstShortString(secrets, payload.field, payload.param, payload.path, errorPayload.field, errorPayload.param, errorPayload.path),
    retryable
  };
}

function errorFromHttp(status: number, providerName: string, payload: Record<string, unknown> = {}, secrets: string[] = []): ProviderToolError {
  const retryable = status === 408 || status === 504 || status === 429 || status >= 500;
  const summary = providerSummaryFromHttp(status, retryable, payload, secrets);
  const providerFailureText = [summary.provider_error_code, summary.provider_error_message].filter(Boolean).join(" ").toLowerCase();
  const looksLikeCreditFailure = providerFailureText.includes("credit") || providerFailureText.includes("not enough");
  if (status === 401 || status === 403) return providerError("PROVIDER_AUTH_FAILED", `${providerName} authentication failed.`, false, summary);
  if (status === 402 || looksLikeCreditFailure) return providerError("PROVIDER_INSUFFICIENT_CREDITS", `${providerName} reports insufficient credits.`, false, summary);
  if (status === 408 || status === 504) return providerError("PROVIDER_TIMEOUT", `${providerName} request timed out.`, true, summary);
  if (status === 429) return providerError("PROVIDER_RATE_LIMITED", `${providerName} rate limit was reached.`, true, summary);
  if (status >= 500) return providerError("PROVIDER_TRANSIENT_FAILURE", `${providerName} returned a transient server error.`, true, summary);
  if (status === 400 || status === 422) return providerError("PROVIDER_UNSUPPORTED_INPUT", `${providerName} rejected the request input.`, false, summary);
  return providerError("PROVIDER_REQUEST_FAILED", `${providerName} request failed with HTTP ${status}.`, retryable, summary);
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : "";
}

function firstOutputUrl(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  return "";
}

export class RunwayVideoProviderAdapter implements VideoProviderAdapter {
  provider_name = "runway" as const;
  model_name = RUNWAY_IMAGE_TO_VIDEO_CAPABILITY.model;
  private readonly apiBase: string;
  private readonly credential: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: { credential: string; fetch_impl?: typeof fetch; api_base?: string }) {
    this.credential = input.credential;
    this.fetchImpl = input.fetch_impl ?? fetch;
    this.apiBase = input.api_base ?? "https://api.dev.runwayml.com";
  }

  async submitGeneration(input: ProviderGenerationInput): Promise<ProviderSubmitResult> {
    const request = buildRunwayImageToVideoRequest(input, this.model_name);
    if (!request.ok) return { ok: false, error: request.error };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${request.endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credential}`,
          ...request.headers
        },
        body: JSON.stringify(request.body)
      });
    } catch {
      return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "Runway submit request failed.", true) };
    }

    const payload = await safeJson(response);
    if (!response.ok) {
      return { ok: false, error: errorFromHttp(response.status, "Runway", payload, [this.credential]) };
    }

    const providerJobId = stringField(payload, "id");
    if (!providerJobId) {
      return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "Runway submit response did not include a task id.") };
    }

    return { ok: true, provider_job_id: providerJobId, provider_status: stringField(payload, "status") || "PENDING" };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/v1/tasks/${encodeURIComponent(providerJobId)}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.credential}`,
          "X-Runway-Version": RUNWAY_API_VERSION
        }
      });
    } catch {
      return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "Runway status request failed.", true) };
    }

    const payload = await safeJson(response);
    if (!response.ok) {
      return { ok: false, error: errorFromHttp(response.status, "Runway", payload, [this.credential]) };
    }

    const providerStatus = stringField(payload, "status") || "UNKNOWN";
    if (providerStatus === "SUCCEEDED") {
      return {
        ok: true,
        provider_job_id: providerJobId,
        status: "succeeded",
        provider_status: providerStatus,
        retryable: false,
        output_url: firstOutputUrl(payload)
      };
    }

    if (providerStatus === "FAILED" || providerStatus === "CANCELED") {
      return {
        ok: true,
        provider_job_id: providerJobId,
        status: providerStatus === "CANCELED" ? "cancelled" : "failed",
        provider_status: providerStatus,
        retryable: false
      };
    }

    return {
      ok: true,
      provider_job_id: providerJobId,
      status: providerStatus === "PENDING" ? "queued" : "running",
      provider_status: providerStatus,
      retryable: true
    };
  }

  async fetchOutput(providerJobId: string): Promise<ProviderOutputResult> {
    const status = await this.pollStatus(providerJobId);
    if (!status.ok) return status;
    if (status.status !== "succeeded") {
      return { ok: false, error: providerError(status.retryable ? "PROVIDER_OUTPUT_PENDING" : "PROVIDER_REQUEST_FAILED", `Runway task is ${status.provider_status}.`, status.retryable) };
    }
    if (!status.output_url) {
      return { ok: false, error: providerError("PROVIDER_OUTPUT_MISSING", "Runway task succeeded without an output URL.") };
    }
    return { ok: true, provider_job_id: providerJobId, output_url: status.output_url, provider_status: status.provider_status };
  }
}

export class RunningHubVideoProviderAdapter implements VideoProviderAdapter {
  provider_name = "runninghub" as const;
  model_name = RUNNINGHUB_MODEL_ROUTE;
  private readonly apiBase: string;
  private readonly credential: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(input: { credential?: string; fetch_impl?: typeof fetch; api_base?: string; timeout_ms?: number } = {}) {
    this.credential = input.credential ?? "";
    this.fetchImpl = input.fetch_impl ?? fetch;
    this.apiBase = input.api_base ?? RUNNINGHUB_API_BASE_URL;
    this.timeoutMs = Math.max(1000, input.timeout_ms ?? 60_000);
  }

  private async request(url: string, init: RequestInit, operation: string): Promise<{ response: Response; payload: Record<string, unknown> } | { error: ProviderToolError }> {
    if (!this.credential) return { error: providerError("PROVIDER_CREDENTIAL_MISSING", "RunningHub credential is missing.") };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      return { response, payload: await safeJson(response) };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { error: providerError("PROVIDER_TIMEOUT", `RunningHub ${operation} request timed out.`, true) };
      }
      return { error: providerError("PROVIDER_REQUEST_FAILED", `RunningHub ${operation} request failed.`, true) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async submitGeneration(input: ProviderGenerationInput): Promise<ProviderSubmitResult> {
    const uploadRequest = buildRunningHubMediaUploadRequest({ storyboard_artifact: input.storyboard_artifact });
    if (!uploadRequest.ok) return uploadRequest;
    const form = new FormData();
    const bytes = readFileSync(input.storyboard_artifact.storage.uri);
    form.append(RUNNINGHUB_MEDIA_UPLOAD_FILE_FIELD, new Blob([bytes], { type: uploadRequest.multipart.content_type }), uploadRequest.multipart.file_name);
    const uploadResponse = await this.request(`${this.apiBase}${uploadRequest.endpoint}`, {
      method: uploadRequest.method,
      headers: { Authorization: `Bearer ${this.credential}` },
      body: form
    }, "upload");
    if ("error" in uploadResponse) return { ok: false, error: uploadResponse.error };
    if (!uploadResponse.response.ok) {
      return { ok: false, error: mapRunningHubProviderError({ http_status: uploadResponse.response.status, payload: uploadResponse.payload, secrets: [this.credential] }) };
    }
    const uploaded = parseRunningHubMediaUploadResponse(uploadResponse.payload, [this.credential]);
    if (!uploaded.ok) return uploaded;

    const submitRequest = buildRunningHubImageToVideoSubmitRequest({ generation_input: input, uploaded_download_url: uploaded.download_url });
    if (!submitRequest.ok) return submitRequest;
    const submitResponse = await this.request(`${this.apiBase}${submitRequest.endpoint}`, {
      method: submitRequest.method,
      headers: { Authorization: `Bearer ${this.credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(submitRequest.body)
    }, "submit");
    if ("error" in submitResponse) return { ok: false, error: { ...submitResponse.error, submission_outcome_unknown: true } };
    if (!submitResponse.response.ok) {
      const error = mapRunningHubProviderError({ http_status: submitResponse.response.status, payload: submitResponse.payload, secrets: [this.credential] });
      return { ok: false, error: { ...error, ...(submitResponse.response.status >= 500 || submitResponse.response.status === 408 ? { submission_outcome_unknown: true } : {}) } };
    }
    const parsed = parseRunningHubSubmitResponse(submitResponse.payload, [this.credential]);
    if (parsed.ok) return parsed;
    const providerDeclaredRejection = parsed.error.sanitized_provider_error_summary;
    if (providerDeclaredRejection?.provider_error_code || providerDeclaredRejection?.provider_error_message) {
      return parsed;
    }
    return { ok: false, error: { ...parsed.error, submission_outcome_unknown: true } };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusResult> {
    const query = buildRunningHubQueryRequest(providerJobId);
    if (!query.ok) return query;
    const result = await this.request(`${this.apiBase}${query.endpoint}`, {
      method: query.method,
      headers: { Authorization: `Bearer ${this.credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(query.body)
    }, "query");
    if ("error" in result) return { ok: false, error: result.error };
    if (!result.response.ok) {
      return { ok: false, error: mapRunningHubProviderError({ http_status: result.response.status, payload: result.payload, secrets: [this.credential] }) };
    }
    const parsed = parseRunningHubQueryResponse(result.payload, providerJobId, [this.credential]);
    if (!parsed.ok) return parsed;
    if (parsed.provider_job_id !== providerJobId) {
      return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "RunningHub query returned a mismatched taskId.") };
    }
    return {
      ok: true,
      provider_job_id: providerJobId,
      status: parsed.status,
      provider_status: parsed.provider_status,
      retryable: parsed.retryable,
      ...(parsed.output_url ? { output_url: parsed.output_url } : {})
    };
  }

  async fetchOutput(providerJobId: string): Promise<ProviderOutputResult> {
    const status = await this.pollStatus(providerJobId);
    if (!status.ok) return status;
    if (status.status !== "succeeded") {
      return { ok: false, error: providerError(status.retryable ? "PROVIDER_OUTPUT_PENDING" : "PROVIDER_REQUEST_FAILED", `RunningHub task is ${status.provider_status}.`, status.retryable) };
    }
    if (!status.output_url) return { ok: false, error: providerError("PROVIDER_OUTPUT_MISSING", "RunningHub task succeeded without an output URL.") };
    return { ok: true, provider_job_id: providerJobId, output_url: status.output_url, provider_status: status.provider_status };
  }
}
