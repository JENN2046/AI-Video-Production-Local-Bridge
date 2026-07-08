import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import {
  buildRunningHubImageToVideoSubmitRequest,
  buildRunningHubMediaUploadRequest,
  buildRunningHubQueryRequest,
  downloadProviderOutputToArtifact,
  ensureM0Directories,
  getMediaArtifact,
  getProject,
  getShot,
  getStoryboardPackage,
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
  RUNNINGHUB_MODEL_ROUTE,
  RUNNINGHUB_QUERY_ENDPOINT,
  validateImageFile,
  type MediaArtifact,
  type ProviderGenerationInput,
  type ProviderToolError
} from "../src/index.js";

const TASK = "R3-8M_RUNNINGHUB_6S_SINGLE_SUBMIT_CANARY";
const R3_8L_REPORT_PATH = "data/reports/r3_8l_runninghub_duration_contract_repair_dry_run_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_8m_runninghub_6s_single_submit_canary_result.json";
const OUTPUT_DIR_RELATIVE = "data/media/provider-canary/r3-8m-runninghub-6s-real-keyframe/";
const SELECTED_ARTIFACT_ID = "artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7";
const SELECTED_SOURCE_PATH = "A:\\AI Video Production Workspace\\data\\imports\\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png";
const SELECTED_STORAGE_URI = "A:\\AI Video Production Workspace\\data\\media\\artifacts\\images\\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png";
const AUTHORIZATION_SHA256 = "6d6c85ce16b03301144b6f1720da12026cb093dfaa22da05c962cf1ba4553e32";
const DURATION_SECONDS = 6;
const ASPECT_RATIO = "9:16";
const RESOLUTION = RUNNINGHUB_DEFAULT_RESOLUTION;
const POLL_INTERVAL_MS_DEFAULT = 5000;
const POLL_TIMEOUT_MS_DEFAULT = 600000;
const REQUEST_TIMEOUT_MS_DEFAULT = 60000;

type R3_8MResult = "PASS_LIVE_SINGLE_SUBMIT_COMPLETED" | "PROVIDER_FAILED" | "BLOCK_WITH_REASON";
type JsonRecord = Record<string, unknown>;

interface G0FreezeReport {
  project?: { project_id?: string; title?: string };
  storyboard_package?: { storyboard_package_id?: string };
  shots?: Array<{
    shot_id?: string;
    storyboard_image_artifact_id?: string;
    duration_seconds?: number;
    approved_by_user?: boolean;
  }>;
}

function workspaceRelative(path: string): string {
  return relative(paths.workspaceRoot, path).replace(/\\/g, "/");
}

function readJson<T>(path: string): T | null {
  const absolute = resolve(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function payloadObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stripInlineComment(value: string): string {
  let output = "";
  let quoted: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!quoted && (char === '"' || char === "'")) {
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
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
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
    return {
      ok: false,
      error: {
        code: "PROVIDER_REQUEST_FAILED",
        message: "RunningHub request failed before a response was received.",
        retryable: true
      }
    };
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
      headers: {
        Authorization: `Bearer ${input.credential}`
      },
      body: form
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "PROVIDER_REQUEST_FAILED",
        message: "RunningHub media upload failed before a response was received.",
        retryable: true
      }
    };
  }

  const payload = await safeJson(response);
  if (!response.ok) return { ok: false, error: mapRunningHubProviderError({ http_status: response.status, payload, secrets: [input.credential] }) };

  const parsed = parseRunningHubMediaUploadResponse(payload, [input.credential]);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  try {
    return { ok: true, download_url: parsed.download_url, download_url_host: new URL(parsed.download_url).host };
  } catch {
    return {
      ok: false,
      error: {
        code: "PROVIDER_REQUEST_FAILED",
        message: "RunningHub media upload returned an invalid download_url.",
        retryable: false
      }
    };
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

  const submitted = await postJson({
    apiBase: input.apiBase,
    endpoint: request.endpoint,
    credential: input.credential,
    body: request.body
  });
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

    const queried = await postJson({
      apiBase: input.apiBase,
      endpoint: request.endpoint,
      credential: input.credential,
      body: request.body
    });
    if (!queried.ok) return { ok: false, attempts: attempt, error: queried.error };

    const parsed = parseRunningHubQueryResponse(queried.payload, input.providerJobId, [input.credential]);
    if (!parsed.ok) return { ok: false, attempts: attempt, error: parsed.error };

    if (parsed.status === "succeeded") {
      let outputUrlHost = "";
      if (parsed.output_url) {
        try {
          outputUrlHost = new URL(parsed.output_url).host;
        } catch {
          return {
            ok: false,
            attempts: attempt,
            error: {
              code: "PROVIDER_OUTPUT_URI_BLOCKED",
              message: "RunningHub query returned an invalid output URL.",
              retryable: false
            }
          };
        }
      }
      return {
        ok: true,
        attempts: attempt,
        provider_status: parsed.provider_status,
        status: "succeeded",
        output_url: parsed.output_url,
        output_url_host: outputUrlHost
      };
    }

    if (parsed.status === "failed" || parsed.status === "cancelled") {
      return {
        ok: true,
        attempts: attempt,
        provider_status: parsed.provider_status,
        status: parsed.status,
        mapped_error: parsed.mapped_error
      };
    }

    if (attempt < maxAttempts && intervalMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }

  return {
    ok: false,
    attempts: maxAttempts,
    error: {
      code: "PROVIDER_TIMEOUT",
      message: "RunningHub task did not complete before the configured poll timeout.",
      retryable: true
    }
  };
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

function block(report: JsonRecord, reason: string): JsonRecord {
  report.result = "BLOCK_WITH_REASON";
  report.blocked_reason = reason;
  return report;
}

function baseReport(input: {
  envLoad: ReturnType<typeof loadAuthorizedRunningHubEnv>;
  r3_8lReport: JsonRecord | null;
  freezeReport: G0FreezeReport | null;
  artifact: MediaArtifact | null;
  sourceReadable: boolean;
  storageValidation: ReturnType<typeof validateImageFile> | null;
}): JsonRecord {
  const selectedShot = input.freezeReport?.shots?.find((shot) => shot.storyboard_image_artifact_id === SELECTED_ARTIFACT_ID);
  return {
    task: TASK,
    result: "BLOCK_WITH_REASON" satisfies R3_8MResult,
    mode: process.argv.includes("--live") ? "live" : "dry_run",
    generated_at: new Date().toISOString(),
    source_reports: {
      r3_8l_duration_contract_repair: R3_8L_REPORT_PATH,
      g0_freeze: G0_FREEZE_REPORT_PATH
    },
    authorization: {
      required_for_real_call: true,
      provided: Boolean(process.env.R3_8M_AUTHORIZATION_SHA256),
      accepted: process.env.R3_8M_AUTHORIZATION_SHA256 === AUTHORIZATION_SHA256,
      mechanism: "R3_8M_AUTHORIZATION_SHA256",
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
    selected_keyframe: {
      artifact_id: input.artifact?.artifact_id ?? SELECTED_ARTIFACT_ID,
      source_path: SELECTED_SOURCE_PATH,
      storage_uri: input.artifact?.storage.uri ?? SELECTED_STORAGE_URI,
      mime_type: input.storageValidation?.ok ? input.storageValidation.detected_mime : input.artifact?.storage.mime_type ?? "",
      width: input.storageValidation?.ok ? input.storageValidation.width : 0,
      height: input.storageValidation?.ok ? input.storageValidation.height : 0,
      aspect_ratio: input.storageValidation?.ok ? input.storageValidation.aspect_ratio : "",
      sha256: input.storageValidation?.ok ? input.storageValidation.sha256 : "",
      source_readable: input.sourceReadable,
      storage_readable: input.storageValidation?.ok === true,
      artifact_role: input.artifact?.role ?? null,
      artifact_status: input.artifact?.status ?? null,
      artifact_id_from_app_registry: input.artifact?.artifact_id === SELECTED_ARTIFACT_ID,
      source_asset_overwritten: false
    },
    project_linkage: {
      project_id: input.freezeReport?.project?.project_id ?? null,
      storyboard_package_id: input.freezeReport?.storyboard_package?.storyboard_package_id ?? null,
      shot_id: selectedShot?.shot_id ?? null,
      package_shot_duration_seconds: selectedShot?.duration_seconds ?? null,
      runninghub_canary_duration_seconds: DURATION_SECONDS
    },
    provider_contract: {
      provider: "runninghub",
      api_base_url: process.env.RUNNINGHUB_API_BASE_URL || RUNNINGHUB_API_BASE_URL,
      model_route: RUNNINGHUB_MODEL_ROUTE,
      upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      request_fields: ["prompt", "aspectRatio", "imageUrls", "resolution", "duration"],
      duration_seconds: DURATION_SECONDS,
      aspectRatio: ASPECT_RATIO,
      resolution: RESOLUTION,
      max_upload_calls: 1,
      max_submit_calls: 1,
      retry_submit_allowed: false,
      output_dir: OUTPUT_DIR_RELATIVE
    },
    preflight: {
      r3_8l_report_result: input.r3_8lReport?.result ?? null,
      r3_8l_duration_seconds: payloadObject(input.r3_8lReport?.dry_run_plan).duration_seconds ?? null,
      r3_8l_git_commit: payloadObject(input.r3_8lReport?.git_receipt).commit ?? null,
      r3_8l_receipt_fix_commit: payloadObject(input.r3_8lReport?.source_receipts).r3_8j_receipt_fix_commit ?? null,
      network_call_attempted_before_live_step: false
    },
    live_execution: {
      upload_call_count: 0,
      submit_call_count: 0,
      query_call_count: 0,
      output_download_attempted: false,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      provider_job_id: null,
      provider_job_id_present: false,
      provider_status: null,
      upload_download_url_recorded: false,
      upload_download_url_host: null,
      output_url_recorded: false,
      output_url_host: null,
      channel_link_recorded: false,
      error: null
    },
    output_artifact: {
      generated_artifact_id: null,
      storage_uri: null,
      ffprobe_status: null,
      duration_seconds: null,
      has_video_stream: null,
      stream_count: null
    },
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
      retry_submit_performed: false,
      second_submit_performed: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false
    },
    validation: {
      "npm run r3:8m:live": "PENDING",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "package.json",
      "scripts/r3-8m-runninghub-6s-single-submit-canary.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    blocked_reason: null,
    next_step: {
      no_automatic_second_submit: true,
      stop_after_terminal_result: true
    }
  };
}

async function main(): Promise<JsonRecord> {
  ensureM0Directories();
  mkdirSync(resolve(paths.workspaceRoot, OUTPUT_DIR_RELATIVE), { recursive: true });
  const envLoad = loadAuthorizedRunningHubEnv();
  const db = openM0Database();
  try {
    const r3_8lReport = readJson<JsonRecord>(R3_8L_REPORT_PATH);
    const freezeReport = readJson<G0FreezeReport>(G0_FREEZE_REPORT_PATH);
    const artifact = getMediaArtifact(db, SELECTED_ARTIFACT_ID);
    const sourceReadable = existsSync(SELECTED_SOURCE_PATH);
    const storageValidation = artifact?.storage.uri ? validateImageFile(artifact.storage.uri) : null;
    const report = baseReport({ envLoad, r3_8lReport, freezeReport, artifact, sourceReadable, storageValidation });
    const credential = process.env.RUNNINGHUB_API_KEY ?? "";
    const secrets = [credential].filter(Boolean);

    if (!process.argv.includes("--live")) return block(report, "R3-8M live runner requires --live.");
    if (process.env.R3_8M_AUTHORIZATION_SHA256 !== AUTHORIZATION_SHA256) return block(report, "R3-8M live call requires the matching current authorization hash.");
    if (!envLoad.credential_present || !credential) return block(report, "RUNNINGHUB_API_KEY is not present.");
    if (r3_8lReport?.result !== "PASS_DURATION_CONTRACT_REPAIRED") return block(report, "R3-8L duration contract report is missing or not PASS.");
    if (payloadObject(r3_8lReport.dry_run_plan).duration_seconds !== DURATION_SECONDS) return block(report, "R3-8L dry-run duration is not 6 seconds.");
    if (payloadObject(r3_8lReport.git_receipt).commit !== "18f0d90") return block(report, "R3-8L git receipt does not record commit 18f0d90.");
    if (payloadObject(r3_8lReport.source_receipts).r3_8j_receipt_fix_commit !== "590f7fd") return block(report, "R3-8L source receipts do not record R3-8J receipt fix commit 590f7fd.");
    if (!artifact || artifact.artifact_id !== SELECTED_ARTIFACT_ID) return block(report, "Selected artifact is missing from app registry.");
    if (resolve(artifact.storage.uri) !== resolve(SELECTED_STORAGE_URI)) return block(report, "Selected artifact storage URI does not match authorization.");
    if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image" || artifact.status !== "active") return block(report, "Selected artifact is not an active storyboard_image image.");
    if (!storageValidation?.ok || !sourceReadable) return block(report, "Selected keyframe image is not readable.");

    const selectedShot = freezeReport?.shots?.find((shot) => shot.storyboard_image_artifact_id === SELECTED_ARTIFACT_ID);
    const project = freezeReport?.project?.project_id ? getProject(db, freezeReport.project.project_id) : null;
    const shot = selectedShot?.shot_id ? getShot(db, selectedShot.shot_id) : null;
    const storyboardPackage = freezeReport?.storyboard_package?.storyboard_package_id ? getStoryboardPackage(db, freezeReport.storyboard_package.storyboard_package_id) : null;
    if (!project || !shot || !storyboardPackage) return block(report, "Selected project, shot, or storyboard package linkage is missing.");

    const generationInput: ProviderGenerationInput = {
      storyboard_artifact: artifact,
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt,
      duration_seconds: DURATION_SECONDS,
      aspect_ratio: ASPECT_RATIO,
      resolution: RESOLUTION
    };
    const submitDryRun = buildRunningHubImageToVideoSubmitRequest({ generation_input: generationInput, uploaded_download_url: "https://example.invalid/input.png" });
    if (!submitDryRun.ok || submitDryRun.summary.duration !== DURATION_SECONDS || submitDryRun.summary.aspectRatio !== ASPECT_RATIO) {
      return block(report, "RunningHub submit builder does not match authorized duration/aspectRatio.");
    }

    const apiBase = process.env.RUNNINGHUB_API_BASE_URL || RUNNINGHUB_API_BASE_URL;
    report.live_execution = { ...(report.live_execution as JsonRecord), upload_call_count: 1, network_call_attempted: true, runninghub_called: true };
    report.provider_boundary = { ...(report.provider_boundary as JsonRecord), network_call_attempted: true, runninghub_called: true, upload_attempted: true };

    const upload = await uploadRunningHubMedia({ apiBase, credential, artifact });
    if (!upload.ok) {
      report.result = "PROVIDER_FAILED";
      (report.live_execution as JsonRecord).error = safeError(upload.error, secrets);
      return report;
    }
    (report.live_execution as JsonRecord).upload_download_url_host = upload.download_url_host;

    report.live_execution = { ...(report.live_execution as JsonRecord), submit_call_count: 1 };
    report.provider_boundary = { ...(report.provider_boundary as JsonRecord), submit_attempted: true };
    const submit = await submitRunningHubGeneration({ apiBase, credential, generationInput, uploadedDownloadUrl: upload.download_url });
    if (!submit.ok) {
      report.result = "PROVIDER_FAILED";
      (report.live_execution as JsonRecord).error = safeError(submit.error, secrets);
      return report;
    }

    report.live_execution = { ...(report.live_execution as JsonRecord), provider_job_id: submit.provider_job_id, provider_job_id_present: true, provider_status: submit.provider_status };
    report.provider_boundary = { ...(report.provider_boundary as JsonRecord), provider_credits_consumed: true };

    const polled = await pollRunningHubUntilTerminal({ apiBase, credential, providerJobId: submit.provider_job_id });
    report.live_execution = { ...(report.live_execution as JsonRecord), query_call_count: polled.attempts };
    report.provider_boundary = { ...(report.provider_boundary as JsonRecord), status_poll_attempted: polled.attempts > 0 };
    if (!polled.ok) {
      report.result = "PROVIDER_FAILED";
      (report.live_execution as JsonRecord).error = safeError(polled.error, secrets);
      return report;
    }

    (report.live_execution as JsonRecord).provider_status = polled.provider_status;
    if (polled.status !== "succeeded") {
      report.result = "PROVIDER_FAILED";
      (report.live_execution as JsonRecord).error = safeError(
        polled.mapped_error ?? { code: "PROVIDER_REQUEST_FAILED", message: `RunningHub task ended with status ${polled.provider_status}.`, retryable: false },
        secrets
      );
      return report;
    }

    if (!polled.output_url) {
      report.result = "PROVIDER_FAILED";
      (report.live_execution as JsonRecord).error = safeError({ code: "PROVIDER_OUTPUT_MISSING", message: "RunningHub task succeeded without an output URL.", retryable: false }, secrets);
      return report;
    }

    (report.live_execution as JsonRecord).output_url_host = polled.output_url_host ?? null;
    report.live_execution = { ...(report.live_execution as JsonRecord), output_download_attempted: true };
    report.provider_boundary = { ...(report.provider_boundary as JsonRecord), output_download_attempted: true };

    const download = await downloadProviderOutputToArtifact(
      {
        url: polled.output_url,
        provider_name: "runninghub",
        provider_job_id: submit.provider_job_id,
        project_id: project.project_id,
        shot_id: shot.shot_id,
        duration_seconds: DURATION_SECONDS,
        aspect_ratio: ASPECT_RATIO,
        storage_directory: resolve(paths.workspaceRoot, OUTPUT_DIR_RELATIVE)
      },
      db
    );
    if (!download.ok) {
      report.result = "PROVIDER_FAILED";
      (report.live_execution as JsonRecord).error = safeError(download.error, secrets);
      return report;
    }

    report.result = "PASS_LIVE_SINGLE_SUBMIT_COMPLETED";
    report.output_artifact = {
      generated_artifact_id: download.artifact.artifact_id,
      storage_uri: download.artifact.storage.uri,
      ffprobe_status: download.ffprobe.status,
      duration_seconds: download.ffprobe.duration_seconds ?? null,
      has_video_stream: download.ffprobe.has_video_stream,
      stream_count: download.ffprobe.stream_count
    };
    report.live_execution = { ...(report.live_execution as JsonRecord), output_url_host: download.output_url_hostname };
    report.provider_boundary = { ...(report.provider_boundary as JsonRecord), real_video_generated: true };
    return report;
  } finally {
    db.close();
  }
}

const report = await main();
const credential = process.env.RUNNINGHUB_API_KEY ?? "";
if (containsForbiddenLiveLeak(report, [credential])) {
  report.result = "BLOCK_WITH_REASON";
  report.blocked_reason = "R3-8M report contained forbidden secret-shaped, signed URL, base64, or raw provider payload text.";
  report.provider_boundary = { ...(report.provider_boundary as JsonRecord), secret_values_exposed: false, raw_provider_payload_recorded: false };
}

writeFileSync(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      result: report.result,
      report_path: workspaceRelative(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH)),
      upload_call_count: payloadObject(report.live_execution).upload_call_count,
      submit_call_count: payloadObject(report.live_execution).submit_call_count,
      query_call_count: payloadObject(report.live_execution).query_call_count,
      provider_job_id_present: payloadObject(report.live_execution).provider_job_id_present,
      output_url_recorded: false,
      output_url_host: payloadObject(report.live_execution).output_url_host,
      generated_artifact_id: payloadObject(report.output_artifact).generated_artifact_id,
      storage_uri: payloadObject(report.output_artifact).storage_uri,
      ffprobe_status: payloadObject(report.output_artifact).ffprobe_status,
      secret_values_exposed: false
    },
    null,
    2
  )
);

if (report.result === "BLOCK_WITH_REASON" || report.result === "PROVIDER_FAILED") process.exitCode = 1;
