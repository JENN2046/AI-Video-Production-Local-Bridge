import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { MediaArtifact } from "./mediaArtifacts.js";
import { validateImageBuffer, validateImageFile } from "./imageValidity.js";
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
  if (!Number.isInteger(durationSeconds)) return null;
  if (durationSeconds < 2 || durationSeconds > 10) return null;
  return durationSeconds;
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

export function buildRunwayImageToVideoRequest(input: ProviderGenerationInput, modelName = "gen4.5"): RunwayImageToVideoRequestBuildResult {
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
  if (status === 401 || status === 403) return providerError("PROVIDER_AUTH_FAILED", `${providerName} authentication failed.`, false, summary);
  if (status === 402) return providerError("PROVIDER_INSUFFICIENT_CREDITS", `${providerName} reports insufficient credits.`, false, summary);
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
  model_name = "gen4.5";
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
  model_name = "rhart-video-g/image-to-video";

  async submitGeneration(): Promise<ProviderSubmitResult> {
    return {
      ok: false,
      error: providerError(
        "PROVIDER_UNSUPPORTED",
        "RunningHub live generation is not implemented until its image-to-video prompt field and model route are frozen."
      )
    };
  }

  async pollStatus(): Promise<ProviderStatusResult> {
    return {
      ok: false,
      error: providerError("PROVIDER_UNSUPPORTED", "RunningHub status polling is unavailable until its live contract is frozen.")
    };
  }

  async fetchOutput(): Promise<ProviderOutputResult> {
    return {
      ok: false,
      error: providerError("PROVIDER_UNSUPPORTED", "RunningHub output fetching is unavailable until its live contract is frozen.")
    };
  }
}
