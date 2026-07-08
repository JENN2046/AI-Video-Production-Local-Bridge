import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  buildRunningHubImageToVideoSubmitRequest,
  buildRunningHubMediaUploadRequest,
  buildRunningHubQueryRequest,
  downloadProviderOutputToArtifact,
  ensureM0Directories,
  getMediaArtifact,
  mapRunningHubProviderError,
  openM0Database,
  parseRunningHubMediaUploadResponse,
  parseRunningHubQueryResponse,
  parseRunningHubSubmitResponse,
  paths,
  redactSecrets,
  RUNNINGHUB_API_BASE_URL,
  RUNNINGHUB_DEFAULT_RESOLUTION,
  RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
  RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
  RUNNINGHUB_MIN_DURATION_SECONDS,
  RUNNINGHUB_MODEL_ROUTE,
  RUNNINGHUB_QUERY_ENDPOINT,
  validateImageFile,
  type MediaArtifact,
  type ProviderGenerationInput,
  type ProviderToolError
} from "../src/index.js";

const TASK = "R3-9D_RUNNINGHUB_4_SHOT_SINGLE_PASS_LIVE_EXECUTION";
const SOURCE_PLAN_PATH = "data/reports/r3_9c_runninghub_4_shot_live_authorization_prep_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9d_runninghub_4_shot_single_pass_live_execution_result.json";
const AUTHORIZATION_ENV_NAME = "R3_9D_AUTHORIZATION_SHA256";
const AUTHORIZATION_SHA256 = "8e698abfd0606d8c926df00a43dba86368d93cb6396991d3fc3b39ece81486de";
const PROJECT_ID = "project_b742cb15-e44e-41b2-8d2d-4b90a30720df";
const STORYBOARD_PACKAGE_ID = "storyboard_package_1e5c1eca-624e-4687-9775-31e4b59f428a";
const ASPECT_RATIO = "9:16";
const RESOLUTION = RUNNINGHUB_DEFAULT_RESOLUTION;
const OUTPUT_ROOT = "data/media/provider-runs/r3-9b-runninghub-package/";
const REQUEST_TIMEOUT_MS_DEFAULT = 60000;
const POLL_INTERVAL_MS_DEFAULT = 5000;
const POLL_TIMEOUT_MS_DEFAULT = 600000;
const MAX_UPLOAD_CALLS_TOTAL = 4;
const MAX_SUBMIT_CALLS_TOTAL = 4;

type R3_9DResult = "PASS_LIVE_4_SHOT_SINGLE_PASS_COMPLETED" | "PROVIDER_FAILED" | "BLOCK_WITH_REASON";
type JsonRecord = Record<string, unknown>;

interface R3_9CShotConfirmation {
  shot_id?: string | null;
  order?: number | null;
  status?: string;
  local_blockers?: string[];
  artifact?: {
    artifact_id?: string | null;
    artifact_type?: string | null;
    role?: string | null;
    status?: string | null;
    source_path?: string | null;
    storage_uri?: string | null;
    source_asset_overwrite_allowed?: boolean;
  };
  prompt?: {
    shot_description?: string | null;
    video_prompt?: string | null;
    negative_prompt?: string | null;
  } | null;
  duration_seconds?: number | null;
  provider?: {
    provider?: string;
    model_route?: string;
    aspectRatio?: string;
    resolution?: string;
    upload_endpoint?: string;
    submit_endpoint?: string;
    query_endpoint?: string;
  } | null;
  output_dir?: string | null;
}

interface R3_9CReport {
  result?: string;
  hard_gate_summary?: {
    eligible_shot_count_confirmed?: number;
    local_blocker_count?: number;
    provider?: string;
    model_route?: string;
    duration_seconds_per_shot?: number;
    aspectRatio?: string;
    resolution?: string;
    upload_first_required?: boolean;
    no_runway_fallback?: boolean;
    no_retry?: boolean;
    no_second_submit?: boolean;
    no_regeneration?: boolean;
    no_batch_expansion?: boolean;
  };
  shot_confirmations?: R3_9CShotConfirmation[];
  budget_and_stop_conditions?: {
    max_upload_calls_total?: number;
    max_submit_calls_total?: number;
    max_upload_calls_per_shot?: number;
    max_submit_calls_per_shot?: number;
    max_retry_submit_calls?: number;
    max_second_submit_calls?: number;
    stop_if_any_upload_fails?: boolean;
    stop_if_any_submit_fails?: boolean;
    query_only_same_task_id_until_terminal_or_timeout?: boolean;
    no_runway_fallback?: boolean;
    no_regeneration?: boolean;
    no_batch_expansion?: boolean;
  };
  git_receipt?: { implementation_commit?: string };
}

interface LiveShotReceipt {
  shot_id: string | null;
  order: number | null;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  artifact_id: string | null;
  source_path: string | null;
  storage_uri: string | null;
  output_dir: string | null;
  upload_call_count: number;
  submit_call_count: number;
  query_call_count: number;
  provider_job_id: string | null;
  provider_job_id_present: boolean;
  provider_status: string | null;
  upload_download_url_recorded: false;
  upload_download_url_host: string | null;
  output_url_recorded: false;
  output_url_host: string | null;
  output_download_attempted: boolean;
  generated_artifact_id: string | null;
  local_storage_uri: string | null;
  ffprobe_status: string | null;
  ffprobe_duration_seconds: number | null;
  has_video_stream: boolean | null;
  stream_count: number | null;
  error: JsonRecord | null;
}

function envString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readJson<T>(path: string): T | null {
  const absolute = resolve(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function payloadObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stripInlineComment(value: string): string {
  let output = "";
  let quoted: "\"" | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!quoted && (char === "\"" || char === "'")) {
      quoted = char;
      output += char;
      continue;
    }
    if (quoted && char === quoted) {
      quoted = null;
      output += char;
      continue;
    }
    if (!quoted && char === "#") break;
    output += char;
  }
  return output.trim();
}

function unquote(value: string): string {
  const trimmed = stripInlineComment(value);
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function loadAuthorizedRunningHubEnv(): {
  env_file_found: boolean;
  loaded_keys: string[];
  skipped_existing_keys: string[];
  ignored_keys_count: number;
  parse_errors: string[];
  credential_present: boolean;
  secret_values_exposed: false;
} {
  const allowedKeys = new Set([
    "RUNNINGHUB_API_KEY",
    "RUNNINGHUB_API_BASE_URL",
    "PROVIDER_TASK_POLL_INTERVAL_MS",
    "PROVIDER_TASK_POLL_TIMEOUT_MS",
    "PROVIDER_OUTPUT_DOWNLOAD_TIMEOUT_MS",
    "REAL_PROVIDER_ENABLED",
    "M1_REAL_PROVIDER",
    "M1_REAL_PROVIDER_EXECUTION_ALLOWED",
    "M1_REAL_PROVIDER_COST_ACK"
  ]);
  const envFilePath = join(paths.workspaceRoot, ".env.local");
  const result = {
    env_file_found: existsSync(envFilePath),
    loaded_keys: [] as string[],
    skipped_existing_keys: [] as string[],
    ignored_keys_count: 0,
    parse_errors: [] as string[],
    credential_present: false,
    secret_values_exposed: false as const
  };

  if (!result.env_file_found) {
    result.credential_present = Boolean(process.env.RUNNINGHUB_API_KEY);
    return result;
  }

  const text = readFileSync(envFilePath, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      result.parse_errors.push(`line_${index + 1}_invalid_assignment`);
      continue;
    }

    const key = match[1];
    if (!allowedKeys.has(key)) {
      result.ignored_keys_count += 1;
      continue;
    }

    if (process.env[key]) {
      result.skipped_existing_keys.push(key);
      continue;
    }
    process.env[key] = unquote(match[2] ?? "");
    result.loaded_keys.push(key);
  }

  result.credential_present = Boolean(process.env.RUNNINGHUB_API_KEY);
  return result;
}

function safeError(error: ProviderToolError | null, secrets: string[] = []): JsonRecord | null {
  if (!error) return null;
  return {
    code: error.code,
    retryable: error.retryable === true,
    message: redactSecrets(error.message, secrets),
    sanitized_provider_error_summary: error.sanitized_provider_error_summary ?? null
  };
}

async function safeJson(response: Response): Promise<JsonRecord> {
  try {
    const text = await response.text();
    if (!text.trim()) return {};
    return payloadObject(JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS_DEFAULT): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(input: {
  apiBase: string;
  endpoint: string;
  credential: string;
  body: unknown;
}): Promise<{ ok: true; payload: JsonRecord } | { ok: false; error: ProviderToolError }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${input.apiBase}${input.endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.credential}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input.body)
    });
  } catch {
    return { ok: false, error: { code: "PROVIDER_REQUEST_FAILED", message: "RunningHub request failed before a response was received.", retryable: true } };
  }

  const payload = await safeJson(response);
  if (!response.ok) return { ok: false, error: mapRunningHubProviderError({ http_status: response.status, payload, secrets: [input.credential] }) };
  return { ok: true, payload };
}

async function uploadRunningHubMedia(input: {
  apiBase: string;
  credential: string;
  artifact: MediaArtifact;
}): Promise<{ ok: true; download_url: string; download_url_host: string } | { ok: false; error: ProviderToolError }> {
  const request = buildRunningHubMediaUploadRequest({ storyboard_artifact: input.artifact });
  if (!request.ok) return { ok: false, error: request.error };

  const bytes = readFileSync(input.artifact.storage.uri);
  const form = new FormData();
  form.append(request.summary.file_field, new globalThis.Blob([bytes], { type: request.summary.mime_type }), request.summary.file_name || basename(input.artifact.storage.uri));

  let response: Response;
  try {
    response = await fetchWithTimeout(`${input.apiBase}${request.endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.credential}` },
      body: form
    });
  } catch {
    return { ok: false, error: { code: "PROVIDER_REQUEST_FAILED", message: "RunningHub media upload failed before a response was received.", retryable: true } };
  }

  const payload = await safeJson(response);
  if (!response.ok) return { ok: false, error: mapRunningHubProviderError({ http_status: response.status, payload, secrets: [input.credential] }) };

  const parsed = parseRunningHubMediaUploadResponse(payload, [input.credential]);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  try {
    return { ok: true, download_url: parsed.download_url, download_url_host: new URL(parsed.download_url).host };
  } catch {
    return { ok: false, error: { code: "PROVIDER_REQUEST_FAILED", message: "RunningHub media upload returned an invalid download_url.", retryable: false } };
  }
}

async function submitRunningHubGeneration(input: {
  apiBase: string;
  credential: string;
  generationInput: ProviderGenerationInput;
  uploadedDownloadUrl: string;
}): Promise<{ ok: true; provider_job_id: string; provider_status: string } | { ok: false; error: ProviderToolError }> {
  const request = buildRunningHubImageToVideoSubmitRequest({
    generation_input: input.generationInput,
    uploaded_download_url: input.uploadedDownloadUrl
  });
  if (!request.ok) return { ok: false, error: request.error };

  const submitted = await postJson({ apiBase: input.apiBase, endpoint: request.endpoint, credential: input.credential, body: request.body });
  if (!submitted.ok) return submitted;

  const parsed = parseRunningHubSubmitResponse(submitted.payload, [input.credential]);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, provider_job_id: parsed.provider_job_id, provider_status: parsed.provider_status };
}

async function pollRunningHubUntilTerminal(input: {
  apiBase: string;
  credential: string;
  providerJobId: string;
}): Promise<{
  ok: true;
  attempts: number;
  provider_status: string;
  status: "succeeded" | "failed" | "cancelled";
  output_url?: string;
  output_url_host?: string;
  mapped_error?: ProviderToolError;
} | { ok: false; attempts: number; error: ProviderToolError }> {
  const intervalMs = numberFromEnv("PROVIDER_TASK_POLL_INTERVAL_MS", POLL_INTERVAL_MS_DEFAULT);
  const timeoutMs = numberFromEnv("PROVIDER_TASK_POLL_TIMEOUT_MS", POLL_TIMEOUT_MS_DEFAULT);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(intervalMs, 1)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const request = buildRunningHubQueryRequest(input.providerJobId);
    if (!request.ok) return { ok: false, attempts: attempt, error: request.error };

    const queried = await postJson({ apiBase: input.apiBase, endpoint: request.endpoint, credential: input.credential, body: request.body });
    if (!queried.ok) return { ok: false, attempts: attempt, error: queried.error };

    const parsed = parseRunningHubQueryResponse(queried.payload, input.providerJobId, [input.credential]);
    if (!parsed.ok) return { ok: false, attempts: attempt, error: parsed.error };

    if (parsed.status === "succeeded") {
      let outputUrlHost = "";
      if (parsed.output_url) {
        try {
          outputUrlHost = new URL(parsed.output_url).host;
        } catch {
          return { ok: false, attempts: attempt, error: { code: "PROVIDER_OUTPUT_URI_BLOCKED", message: "RunningHub query returned an invalid output URL.", retryable: false } };
        }
      }
      return { ok: true, attempts: attempt, provider_status: parsed.provider_status, status: "succeeded", output_url: parsed.output_url, output_url_host: outputUrlHost };
    }

    if (parsed.status === "failed" || parsed.status === "cancelled") {
      return { ok: true, attempts: attempt, provider_status: parsed.provider_status, status: parsed.status, mapped_error: parsed.mapped_error };
    }

    if (attempt < maxAttempts && intervalMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }

  return { ok: false, attempts: maxAttempts, error: { code: "PROVIDER_TIMEOUT", message: "RunningHub task did not complete before the configured poll timeout.", retryable: true } };
}

function containsForbiddenLiveLeak(value: unknown, secrets: string[]): boolean {
  const serialized = JSON.stringify(value);
  return (
    secrets.some((secret) => secret.length > 0 && serialized.includes(secret)) ||
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(serialized) ||
    /base64,[A-Za-z0-9+/=]{32,}/.test(serialized) ||
    serialized.includes("data:image/") ||
    serialized.includes("RUNNINGHUB_API_KEY=") ||
    serialized.includes("q-signature=") ||
    serialized.includes("Rh-Comfy-Auth=") ||
    /"raw_provider_payload"\s*:/.test(serialized)
  );
}

function newShotReceipt(shot: R3_9CShotConfirmation): LiveShotReceipt {
  return {
    shot_id: shot.shot_id ?? null,
    order: shot.order ?? null,
    status: "PENDING",
    artifact_id: shot.artifact?.artifact_id ?? null,
    source_path: shot.artifact?.source_path ?? null,
    storage_uri: shot.artifact?.storage_uri ?? null,
    output_dir: shot.output_dir ?? null,
    upload_call_count: 0,
    submit_call_count: 0,
    query_call_count: 0,
    provider_job_id: null,
    provider_job_id_present: false,
    provider_status: null,
    upload_download_url_recorded: false,
    upload_download_url_host: null,
    output_url_recorded: false,
    output_url_host: null,
    output_download_attempted: false,
    generated_artifact_id: null,
    local_storage_uri: null,
    ffprobe_status: null,
    ffprobe_duration_seconds: null,
    has_video_stream: null,
    stream_count: null,
    error: null
  };
}

function validateSourcePlan(report: R3_9CReport | null): string[] {
  const blockers: string[] = [];
  const summary = report?.hard_gate_summary ?? {};
  const budget = report?.budget_and_stop_conditions ?? {};
  const shots = report?.shot_confirmations ?? [];
  if (!report) blockers.push("SOURCE_PLAN_MISSING");
  if (report?.result !== "PASS_READY_FOR_USER_AUTHORIZATION") blockers.push("SOURCE_PLAN_NOT_PASS");
  if (summary.eligible_shot_count_confirmed !== 4 || shots.length !== 4) blockers.push("SHOT_COUNT_NOT_4");
  if (summary.local_blocker_count !== 0) blockers.push("SOURCE_PLAN_HAS_LOCAL_BLOCKERS");
  if (summary.provider !== "runninghub" || summary.model_route !== RUNNINGHUB_MODEL_ROUTE) blockers.push("PROVIDER_CONTRACT_MISMATCH");
  if (summary.duration_seconds_per_shot !== RUNNINGHUB_MIN_DURATION_SECONDS) blockers.push("DURATION_CONTRACT_MISMATCH");
  if (summary.aspectRatio !== ASPECT_RATIO || summary.resolution !== RESOLUTION) blockers.push("RATIO_OR_RESOLUTION_MISMATCH");
  if (summary.upload_first_required !== true) blockers.push("UPLOAD_FIRST_NOT_REQUIRED");
  if (summary.no_retry !== true || summary.no_second_submit !== true) blockers.push("RETRY_OR_SECOND_SUBMIT_NOT_FORBIDDEN");
  if (summary.no_runway_fallback !== true || summary.no_regeneration !== true || summary.no_batch_expansion !== true) blockers.push("EXPANSION_BOUNDARY_MISMATCH");
  if (budget.max_upload_calls_total !== MAX_UPLOAD_CALLS_TOTAL || budget.max_submit_calls_total !== MAX_SUBMIT_CALLS_TOTAL) blockers.push("TOTAL_CALL_BUDGET_MISMATCH");
  if (budget.max_upload_calls_per_shot !== 1 || budget.max_submit_calls_per_shot !== 1) blockers.push("PER_SHOT_CALL_BUDGET_MISMATCH");
  if (budget.max_retry_submit_calls !== 0 || budget.max_second_submit_calls !== 0) blockers.push("RETRY_BUDGET_MISMATCH");
  if (budget.query_only_same_task_id_until_terminal_or_timeout !== true) blockers.push("QUERY_STOP_CONDITION_MISSING");

  for (const shot of shots) {
    if (shot.status !== "CONFIRMED_READY_FOR_FUTURE_AUTHORIZED_LIVE_CALL") blockers.push(`SHOT_NOT_READY:${shot.shot_id ?? "unknown"}`);
    if ((shot.local_blockers ?? []).length > 0) blockers.push(`SHOT_HAS_LOCAL_BLOCKERS:${shot.shot_id ?? "unknown"}`);
    if (!shot.artifact?.artifact_id?.startsWith("artifact_")) blockers.push(`SHOT_ARTIFACT_ID_INVALID:${shot.shot_id ?? "unknown"}`);
    if (shot.artifact?.artifact_type !== "image" || shot.artifact.role !== "storyboard_image" || shot.artifact.status !== "active") blockers.push(`SHOT_ARTIFACT_CLASSIFICATION_INVALID:${shot.shot_id ?? "unknown"}`);
    if (!shot.artifact?.source_path || !existsSync(shot.artifact.source_path)) blockers.push(`SHOT_SOURCE_MISSING:${shot.shot_id ?? "unknown"}`);
    if (!shot.artifact?.storage_uri || !existsSync(shot.artifact.storage_uri)) blockers.push(`SHOT_STORAGE_MISSING:${shot.shot_id ?? "unknown"}`);
    if (!shot.prompt?.video_prompt) blockers.push(`SHOT_PROMPT_MISSING:${shot.shot_id ?? "unknown"}`);
    if (shot.duration_seconds !== RUNNINGHUB_MIN_DURATION_SECONDS) blockers.push(`SHOT_DURATION_MISMATCH:${shot.shot_id ?? "unknown"}`);
    if (!shot.output_dir?.startsWith(OUTPUT_ROOT)) blockers.push(`SHOT_OUTPUT_DIR_OUTSIDE_ROOT:${shot.shot_id ?? "unknown"}`);
  }
  return Array.from(new Set(blockers));
}

function baseReport(input: {
  sourcePlan: R3_9CReport | null;
  envLoad: ReturnType<typeof loadAuthorizedRunningHubEnv>;
  planBlockers: string[];
}): JsonRecord {
  const shots = input.sourcePlan?.shot_confirmations ?? [];
  return {
    task: TASK,
    result: "BLOCK_WITH_REASON" satisfies R3_9DResult,
    mode: process.argv.includes("--live") ? "live" : "dry_run",
    generated_at: new Date().toISOString(),
    source_plan: {
      path: SOURCE_PLAN_PATH,
      result: input.sourcePlan?.result ?? null,
      implementation_commit: input.sourcePlan?.git_receipt?.implementation_commit ?? null,
      local_blockers: input.planBlockers
    },
    authorization: {
      required_for_real_call: true,
      provided: Boolean(process.env[AUTHORIZATION_ENV_NAME]),
      accepted: process.env[AUTHORIZATION_ENV_NAME] === AUTHORIZATION_SHA256,
      mechanism: AUTHORIZATION_ENV_NAME,
      expected_sha256: AUTHORIZATION_SHA256,
      full_phrase_recorded: false
    },
    env: {
      env_file_found: input.envLoad.env_file_found,
      loaded_keys: input.envLoad.loaded_keys,
      skipped_existing_keys: input.envLoad.skipped_existing_keys,
      ignored_keys_count: input.envLoad.ignored_keys_count,
      parse_error_count: input.envLoad.parse_errors.length,
      credential_env_name: "RUNNINGHUB_API_KEY",
      credential_present: input.envLoad.credential_present,
      secret_values_exposed: false
    },
    provider_contract: {
      provider: "runninghub",
      api_base_url: process.env.RUNNINGHUB_API_BASE_URL || RUNNINGHUB_API_BASE_URL,
      model_route: RUNNINGHUB_MODEL_ROUTE,
      upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      duration_seconds_per_shot: RUNNINGHUB_MIN_DURATION_SECONDS,
      aspectRatio: ASPECT_RATIO,
      resolution: RESOLUTION,
      output_root: OUTPUT_ROOT
    },
    budget_and_stop_conditions: {
      max_upload_calls_total: MAX_UPLOAD_CALLS_TOTAL,
      max_submit_calls_total: MAX_SUBMIT_CALLS_TOTAL,
      max_upload_calls_per_shot: 1,
      max_submit_calls_per_shot: 1,
      max_retry_submit_calls: 0,
      max_second_submit_calls: 0,
      stop_if_any_upload_fails: true,
      stop_if_any_submit_fails: true,
      stop_if_any_query_or_download_fails: true,
      query_only_same_task_id_until_terminal_or_timeout: true,
      no_runway_fallback: true,
      no_regeneration: true,
      no_batch_expansion: true
    },
    live_execution: {
      upload_call_count: 0,
      submit_call_count: 0,
      query_call_count: 0,
      successful_shot_count: 0,
      failed_shot_count: 0,
      skipped_shot_count: 0,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      provider_statuses: [] as string[],
      output_url_recorded: false,
      signed_url_recorded: false,
      raw_provider_payload_recorded: false
    },
    shots: shots.map(newShotReceipt),
    output_artifacts: [] as JsonRecord[],
    provider_boundary: {
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      upload_attempted: false,
      submit_attempted: false,
      status_poll_attempted: false,
      output_download_attempted: false,
      provider_credits_consumed: false,
      real_video_generated: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false,
      secret_values_exposed: false,
      raw_provider_payload_recorded: false,
      signed_url_recorded: false,
      retry_submit_performed: false,
      second_submit_performed: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false
    },
    validation: {
      "npm run r3:9d:live": "PENDING",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "package.json",
      "scripts/r3-9d-runninghub-4-shot-single-pass-live-execution.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    blocked_reason: null,
    next_step: {
      no_automatic_second_submit: true,
      stop_after_single_pass: true
    }
  };
}

async function executeShot(input: {
  shot: R3_9CShotConfirmation;
  receipt: LiveShotReceipt;
  artifact: MediaArtifact;
  apiBase: string;
  credential: string;
  secrets: string[];
}): Promise<void> {
  const generationInput: ProviderGenerationInput = {
    storyboard_artifact: input.artifact,
    video_prompt: input.shot.prompt?.video_prompt ?? "",
    negative_prompt: input.shot.prompt?.negative_prompt ?? "",
    duration_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
    aspect_ratio: ASPECT_RATIO,
    resolution: RESOLUTION
  };

  const submitGate = buildRunningHubImageToVideoSubmitRequest({
    generation_input: generationInput,
    uploaded_download_url: "https://example.invalid/input.png"
  });
  if (!submitGate.ok || submitGate.summary.duration !== RUNNINGHUB_MIN_DURATION_SECONDS || submitGate.summary.aspectRatio !== ASPECT_RATIO) {
    input.receipt.status = "FAILED";
    input.receipt.error = safeError(submitGate.ok ? null : submitGate.error, input.secrets) ?? {
      code: "SUBMIT_BUILDER_CONTRACT_MISMATCH",
      retryable: false,
      message: "RunningHub submit builder contract did not match authorized R3-9D fields."
    };
    return;
  }

  input.receipt.upload_call_count = 1;
  const upload = await uploadRunningHubMedia({ apiBase: input.apiBase, credential: input.credential, artifact: input.artifact });
  if (!upload.ok) {
    input.receipt.status = "FAILED";
    input.receipt.error = safeError(upload.error, input.secrets);
    return;
  }
  input.receipt.upload_download_url_host = upload.download_url_host;

  input.receipt.submit_call_count = 1;
  const submit = await submitRunningHubGeneration({
    apiBase: input.apiBase,
    credential: input.credential,
    generationInput,
    uploadedDownloadUrl: upload.download_url
  });
  if (!submit.ok) {
    input.receipt.status = "FAILED";
    input.receipt.error = safeError(submit.error, input.secrets);
    return;
  }

  input.receipt.provider_job_id = submit.provider_job_id;
  input.receipt.provider_job_id_present = true;
  input.receipt.provider_status = submit.provider_status;

  const polled = await pollRunningHubUntilTerminal({ apiBase: input.apiBase, credential: input.credential, providerJobId: submit.provider_job_id });
  input.receipt.query_call_count = polled.attempts;
  if (!polled.ok) {
    input.receipt.status = "FAILED";
    input.receipt.error = safeError(polled.error, input.secrets);
    return;
  }

  input.receipt.provider_status = polled.provider_status;
  if (polled.status !== "succeeded" || !polled.output_url) {
    input.receipt.status = "FAILED";
    input.receipt.error = safeError(
      polled.mapped_error ?? { code: "PROVIDER_REQUEST_FAILED", message: `RunningHub task ended with status ${polled.provider_status}.`, retryable: false },
      input.secrets
    );
    return;
  }
  input.receipt.output_url_host = polled.output_url_host ?? null;
  input.receipt.output_download_attempted = true;

  const db = openM0Database();
  try {
    const download = await downloadProviderOutputToArtifact(
      {
        url: polled.output_url,
        provider_name: "runninghub",
        provider_job_id: submit.provider_job_id,
        project_id: PROJECT_ID,
        shot_id: input.shot.shot_id ?? "",
        duration_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
        aspect_ratio: ASPECT_RATIO,
        storage_directory: resolve(paths.workspaceRoot, input.shot.output_dir ?? OUTPUT_ROOT)
      },
      db
    );
    if (!download.ok) {
      input.receipt.status = "FAILED";
      input.receipt.error = safeError(download.error, input.secrets);
      return;
    }

    input.receipt.status = "SUCCEEDED";
    input.receipt.generated_artifact_id = download.artifact.artifact_id;
    input.receipt.local_storage_uri = download.artifact.storage.uri;
    input.receipt.ffprobe_status = download.ffprobe.status;
    input.receipt.ffprobe_duration_seconds = download.ffprobe.duration_seconds ?? null;
    input.receipt.has_video_stream = download.ffprobe.has_video_stream;
    input.receipt.stream_count = download.ffprobe.stream_count;
    input.receipt.output_url_host = download.output_url_hostname;
  } finally {
    db.close();
  }
}

function summarizeLive(report: JsonRecord): void {
  const shots = (report.shots as LiveShotReceipt[]) ?? [];
  const live = report.live_execution as JsonRecord;
  live.upload_call_count = shots.reduce((sum, shot) => sum + shot.upload_call_count, 0);
  live.submit_call_count = shots.reduce((sum, shot) => sum + shot.submit_call_count, 0);
  live.query_call_count = shots.reduce((sum, shot) => sum + shot.query_call_count, 0);
  live.successful_shot_count = shots.filter((shot) => shot.status === "SUCCEEDED").length;
  live.failed_shot_count = shots.filter((shot) => shot.status === "FAILED").length;
  live.skipped_shot_count = shots.filter((shot) => shot.status === "SKIPPED").length;
  live.network_call_attempted = Number(live.upload_call_count) > 0 || Number(live.submit_call_count) > 0 || Number(live.query_call_count) > 0;
  live.runninghub_called = Boolean(live.network_call_attempted);
  live.provider_statuses = shots.map((shot) => shot.provider_status).filter(Boolean);

  report.output_artifacts = shots
    .filter((shot) => shot.generated_artifact_id)
    .map((shot) => ({
      shot_id: shot.shot_id,
      artifact_id: shot.generated_artifact_id,
      storage_uri: shot.local_storage_uri,
      ffprobe_status: shot.ffprobe_status,
      duration_seconds: shot.ffprobe_duration_seconds
    }));

  const boundary = report.provider_boundary as JsonRecord;
  boundary.network_call_attempted = live.network_call_attempted;
  boundary.runninghub_called = live.runninghub_called;
  boundary.upload_attempted = Number(live.upload_call_count) > 0;
  boundary.submit_attempted = Number(live.submit_call_count) > 0;
  boundary.status_poll_attempted = Number(live.query_call_count) > 0;
  boundary.output_download_attempted = shots.some((shot) => shot.output_download_attempted);
  boundary.provider_credits_consumed = Number(live.submit_call_count) > 0;
  boundary.real_video_generated = Number(live.successful_shot_count) > 0;
}

async function main(): Promise<JsonRecord> {
  ensureM0Directories();
  mkdirSync(resolve(paths.workspaceRoot, OUTPUT_ROOT), { recursive: true });
  const envLoad = loadAuthorizedRunningHubEnv();
  const sourcePlan = readJson<R3_9CReport>(SOURCE_PLAN_PATH);
  const planBlockers = validateSourcePlan(sourcePlan);
  const report = baseReport({ sourcePlan, envLoad, planBlockers });
  const credential = process.env.RUNNINGHUB_API_KEY ?? "";
  const secrets = [credential].filter(Boolean);

  if (!process.argv.includes("--live")) {
    report.blocked_reason = `${TASK} live runner requires --live.`;
    return report;
  }
  if (process.env[AUTHORIZATION_ENV_NAME] !== AUTHORIZATION_SHA256) {
    report.blocked_reason = `${TASK} live call requires the matching current authorization hash.`;
    return report;
  }
  if (planBlockers.length > 0) {
    report.blocked_reason = "R3-9C source plan failed one or more R3-9D live hard gates.";
    return report;
  }
  if (!envLoad.credential_present || !credential) {
    report.blocked_reason = "RUNNINGHUB_API_KEY is not present.";
    return report;
  }

  const apiBase = process.env.RUNNINGHUB_API_BASE_URL || RUNNINGHUB_API_BASE_URL;
  const shots = sourcePlan?.shot_confirmations ?? [];
  const receipts = report.shots as LiveShotReceipt[];
  const db = openM0Database();
  try {
    for (const [index, shot] of shots.entries()) {
      const receipt = receipts[index];
      const artifactId = shot.artifact?.artifact_id ?? "";
      const artifact = getMediaArtifact(db, artifactId);
      if (!artifact) {
        receipt.status = "FAILED";
        receipt.error = { code: "ARTIFACT_NOT_FOUND", retryable: false, message: "Shot storyboard image artifact was not found in the app registry." };
        break;
      }
      if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image" || artifact.status !== "active") {
        receipt.status = "FAILED";
        receipt.error = { code: "ARTIFACT_CLASSIFICATION_INVALID", retryable: false, message: "Shot artifact is not an active storyboard_image image." };
        break;
      }
      if (resolve(artifact.storage.uri) !== resolve(shot.artifact?.storage_uri ?? "")) {
        receipt.status = "FAILED";
        receipt.error = { code: "ARTIFACT_STORAGE_MISMATCH", retryable: false, message: "Shot artifact storage URI does not match the authorized source plan." };
        break;
      }
      const imageValidation = validateImageFile(artifact.storage.uri);
      if (!imageValidation.ok) {
        receipt.status = "FAILED";
        receipt.error = { code: imageValidation.error_code ?? "IMAGE_FILE_INVALID", retryable: false, message: imageValidation.error ?? "Storyboard image validation failed." };
        break;
      }
      if (Number((report.live_execution as JsonRecord).upload_call_count) >= MAX_UPLOAD_CALLS_TOTAL || Number((report.live_execution as JsonRecord).submit_call_count) >= MAX_SUBMIT_CALLS_TOTAL) {
        receipt.status = "SKIPPED";
        receipt.error = { code: "CALL_BUDGET_EXHAUSTED", retryable: false, message: "R3-9D call budget was exhausted before this shot." };
        break;
      }

      await executeShot({ shot, receipt, artifact, apiBase, credential, secrets });
      summarizeLive(report);
      if (receipt.status !== "SUCCEEDED") break;
    }
  } finally {
    db.close();
  }

  summarizeLive(report);
  for (const receipt of receipts) {
    if (receipt.status === "PENDING") receipt.status = "SKIPPED";
  }
  summarizeLive(report);

  if (receipts.every((receipt) => receipt.status === "SUCCEEDED")) {
    report.result = "PASS_LIVE_4_SHOT_SINGLE_PASS_COMPLETED";
    report.blocked_reason = null;
  } else {
    report.result = "PROVIDER_FAILED";
  }

  return report;
}

const report = await main();
const credential = process.env.RUNNINGHUB_API_KEY ?? "";
if (containsForbiddenLiveLeak(report, [credential])) {
  report.result = "BLOCK_WITH_REASON";
  report.blocked_reason = `${TASK} report contained forbidden secret-shaped, signed URL, base64, or raw provider payload text.`;
  report.provider_boundary = { ...(report.provider_boundary as JsonRecord), secret_values_exposed: false, raw_provider_payload_recorded: false, signed_url_recorded: false };
}

writeFileSync(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      result: report.result,
      report_path: OUTPUT_REPORT_PATH,
      upload_call_count: payloadObject(report.live_execution).upload_call_count,
      submit_call_count: payloadObject(report.live_execution).submit_call_count,
      query_call_count: payloadObject(report.live_execution).query_call_count,
      successful_shot_count: payloadObject(report.live_execution).successful_shot_count,
      failed_shot_count: payloadObject(report.live_execution).failed_shot_count,
      skipped_shot_count: payloadObject(report.live_execution).skipped_shot_count,
      generated_artifact_ids: ((report.output_artifacts as JsonRecord[]) ?? []).map((artifact) => artifact.artifact_id),
      ffprobe_statuses: ((report.output_artifacts as JsonRecord[]) ?? []).map((artifact) => artifact.ffprobe_status),
      secret_values_exposed: false,
      raw_provider_payload_recorded: false,
      signed_url_recorded: false
    },
    null,
    2
  )
);

if (report.result === "BLOCK_WITH_REASON" || report.result === "PROVIDER_FAILED") process.exitCode = 1;
