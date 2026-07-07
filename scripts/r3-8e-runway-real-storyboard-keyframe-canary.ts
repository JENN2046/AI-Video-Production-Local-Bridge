import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  buildRunwayImageToVideoRequest,
  checkProviderEnv,
  downloadProviderOutputToArtifact,
  ensureM0Directories,
  getMediaArtifact,
  getProject,
  getShot,
  getStoryboardPackage,
  loadProviderEnvLocal,
  mapRunwayAspectRatio,
  normalizeRunwayDuration,
  openM0Database,
  paths,
  providerPreflight,
  redactSecrets,
  RUNWAY_API_VERSION,
  RUNWAY_IMAGE_TO_VIDEO_ENDPOINT,
  RunwayVideoProviderAdapter,
  selectM1ProviderPort,
  validateImageFile,
  type MediaArtifact,
  type ProviderGenerationInput,
  type ProviderJobStatus,
  type ProviderStatusResult,
  type ProviderToolError,
  type RunwayImageToVideoRequestSummary
} from "../src/index.js";

const TASK = "R3-8E_Runway_Real_Storyboard_Keyframe_Single_Submit_Authorization";
const PREP_REPORT_PATH = "data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_8e_runway_real_storyboard_keyframe_canary_result.json";
const OUTPUT_DIR_RELATIVE = "data/media/provider-canary/r3-8d-real-keyframe/";
const SELECTED_ARTIFACT_ID = "artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7";
const SELECTED_SOURCE_PATH = "A:\\AI Video Production Workspace\\data\\imports\\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png";
const SELECTED_STORAGE_URI = "A:\\AI Video Production Workspace\\data\\media\\artifacts\\images\\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png";
const AUTHORIZATION_SHA256 = "2e57e2161135faf7efdfe62b2f6017ab4defa673e8c09936b1b6d8bebc40a438";
const POLL_INTERVAL_MS_DEFAULT = 5000;
const POLL_TIMEOUT_MS_DEFAULT = 600000;

type R3_8EResult = "PASS_READY_FOR_LIVE_AUTHORIZATION" | "PASS_LIVE_SINGLE_SUBMIT_COMPLETED" | "PROVIDER_FAILED" | "BLOCK_WITH_REASON";

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

interface Report {
  task: typeof TASK;
  result: R3_8EResult;
  mode: "dry_run" | "live";
  generated_at: string;
  source_evidence: {
    r3_8d_report: { path: string; exists: boolean; result: string | null; selected_artifact_id: string | null };
    g0_package_freeze_report: { path: string; exists: boolean; project_id: string | null; storyboard_package_id: string | null; shot_id: string | null };
    r3_8d_commit: "4fbbb36";
  };
  authorization: {
    required_for_real_call: true;
    provided: boolean;
    accepted: boolean;
    mechanism: "R3_8E_AUTHORIZATION_SHA256";
    expected_sha256: string;
    full_phrase_recorded: false;
  };
  preflight: {
    env_check_result: string;
    provider_preflight_result: string;
    active_provider: string;
    selected_provider: string;
    credential_env_name: string | null;
    credential_present: boolean;
    missing: string[];
    network_call_attempted: false;
    secret_values_exposed: false;
  };
  selected_input: {
    artifact_id: string;
    source_path: string;
    storage_uri: string;
    mime_type: string;
    width: number;
    height: number;
    aspect_ratio: string;
    sha256: string;
    role: string;
    status: string;
    artifact_id_from_app_registry: boolean;
    source_asset_overwritten: false;
  };
  provider_contract: {
    provider: "runway";
    endpoint: "POST /v1/image_to_video";
    x_runway_version: "2024-11-06";
    model: "gen4.5";
    duration_seconds: 2;
    project_aspect_ratio: "9:16";
    ratio: "720:1280";
    max_submit_calls: 1;
    output_dir: typeof OUTPUT_DIR_RELATIVE;
    no_retry: true;
    no_regeneration: true;
    no_batch: true;
    no_runninghub: true;
    no_publish_deploy: true;
    no_source_overwrite: true;
    no_secret_printing: true;
  };
  runway_request_summary: RunwayImageToVideoRequestSummary | null;
  live_execution: {
    submit_call_count: number;
    network_call_attempted: boolean;
    runway_called: boolean;
    runninghub_called: false;
    provider_job_id: string | null;
    provider_job_id_present: boolean;
    provider_status: string | null;
    poll_attempts: number;
    output_url_recorded: false;
    output_url_hostname: string | null;
    sanitized_provider_error_summary?: unknown;
    error_code: string | null;
    error_message: string | null;
  };
  output_artifact: {
    generated_artifact_id: string | null;
    storage_uri: string | null;
    ffprobe_status: string | null;
    duration_seconds: number | null;
    has_video_stream: boolean | null;
    stream_count: number | null;
  };
  provider_boundary: {
    network_call_attempted: boolean;
    runway_called: boolean;
    runninghub_called: false;
    provider_credits_consumed: boolean;
    real_video_generated: boolean;
    regeneration_performed: false;
    batch_generation_performed: false;
    source_assets_overwritten: false;
    secret_values_exposed: false;
    submit_call_count: number;
    max_submit_calls: 1;
  };
  validation: Record<string, string>;
  changed_files: string[];
  commit: null;
  next_step: {
    no_automatic_second_submit: true;
    requires_new_user_authorization_for_any_retry_or_next_live_call: true;
  };
  block_reason: string | null;
}

function workspaceRelative(path: string): string {
  return relative(paths.workspaceRoot, path).replace(/\\/g, "/");
}

function readJson<T>(path: string): T | null {
  const absolute = resolve(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function providerErrorFields(error: ProviderToolError): Pick<Report["live_execution"], "error_code" | "error_message" | "sanitized_provider_error_summary"> {
  return {
    error_code: error.code,
    error_message: redactSecrets(error.message, [process.env.RUNWAYML_API_SECRET ?? ""]),
    sanitized_provider_error_summary: error.sanitized_provider_error_summary ?? null
  };
}

function baseReport(input: {
  mode: "dry_run" | "live";
  prepReport: Record<string, unknown> | null;
  freezeReport: G0FreezeReport | null;
  artifact: MediaArtifact | null;
  requestSummary: RunwayImageToVideoRequestSummary | null;
}): Report {
  const envCheck = checkProviderEnv();
  const preflight = providerPreflight();
  const shot = input.freezeReport?.shots?.find((candidate) => candidate.storyboard_image_artifact_id === SELECTED_ARTIFACT_ID);
  const validation = input.artifact?.storage.uri ? validateImageFile(input.artifact.storage.uri) : null;

  return {
    task: TASK,
    result: "PASS_READY_FOR_LIVE_AUTHORIZATION",
    mode: input.mode,
    generated_at: new Date().toISOString(),
    source_evidence: {
      r3_8d_report: {
        path: PREP_REPORT_PATH,
        exists: input.prepReport !== null,
        result: typeof input.prepReport?.result === "string" ? input.prepReport.result : null,
        selected_artifact_id:
          input.prepReport?.selected_keyframe &&
          typeof input.prepReport.selected_keyframe === "object" &&
          "artifact_id" in input.prepReport.selected_keyframe &&
          typeof input.prepReport.selected_keyframe.artifact_id === "string"
            ? input.prepReport.selected_keyframe.artifact_id
            : null
      },
      g0_package_freeze_report: {
        path: G0_FREEZE_REPORT_PATH,
        exists: input.freezeReport !== null,
        project_id: input.freezeReport?.project?.project_id ?? null,
        storyboard_package_id: input.freezeReport?.storyboard_package?.storyboard_package_id ?? null,
        shot_id: shot?.shot_id ?? null
      },
      r3_8d_commit: "4fbbb36"
    },
    authorization: {
      required_for_real_call: true,
      provided: Boolean(process.env.R3_8E_AUTHORIZATION_SHA256),
      accepted: process.env.R3_8E_AUTHORIZATION_SHA256 === AUTHORIZATION_SHA256,
      mechanism: "R3_8E_AUTHORIZATION_SHA256",
      expected_sha256: AUTHORIZATION_SHA256,
      full_phrase_recorded: false
    },
    preflight: {
      env_check_result: envCheck.result,
      provider_preflight_result: preflight.result,
      active_provider: envCheck.provider_name,
      selected_provider: preflight.selected_provider,
      credential_env_name: envCheck.credential_env_name,
      credential_present: envCheck.credential_present,
      missing: [...new Set([...envCheck.missing, ...preflight.missing])],
      network_call_attempted: false,
      secret_values_exposed: false
    },
    selected_input: {
      artifact_id: input.artifact?.artifact_id ?? SELECTED_ARTIFACT_ID,
      source_path: SELECTED_SOURCE_PATH,
      storage_uri: input.artifact?.storage.uri ?? SELECTED_STORAGE_URI,
      mime_type: validation?.detected_mime || input.artifact?.storage.mime_type || "",
      width: validation?.width ?? input.artifact?.metadata.width ?? 0,
      height: validation?.height ?? input.artifact?.metadata.height ?? 0,
      aspect_ratio: validation?.aspect_ratio || input.artifact?.metadata.aspect_ratio || "",
      sha256: validation?.sha256 || input.artifact?.metadata.sha256 || "",
      role: input.artifact?.role ?? "",
      status: input.artifact?.status ?? "",
      artifact_id_from_app_registry: input.artifact?.artifact_id === SELECTED_ARTIFACT_ID,
      source_asset_overwritten: false
    },
    provider_contract: {
      provider: "runway",
      endpoint: `POST ${RUNWAY_IMAGE_TO_VIDEO_ENDPOINT}`,
      x_runway_version: RUNWAY_API_VERSION,
      model: "gen4.5",
      duration_seconds: 2,
      project_aspect_ratio: "9:16",
      ratio: "720:1280",
      max_submit_calls: 1,
      output_dir: OUTPUT_DIR_RELATIVE,
      no_retry: true,
      no_regeneration: true,
      no_batch: true,
      no_runninghub: true,
      no_publish_deploy: true,
      no_source_overwrite: true,
      no_secret_printing: true
    },
    runway_request_summary: input.requestSummary,
    live_execution: {
      submit_call_count: 0,
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      provider_job_id: null,
      provider_job_id_present: false,
      provider_status: null,
      poll_attempts: 0,
      output_url_recorded: false,
      output_url_hostname: null,
      error_code: null,
      error_message: null
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
      runway_called: false,
      runninghub_called: false,
      provider_credits_consumed: false,
      real_video_generated: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false,
      secret_values_exposed: false,
      submit_call_count: 0,
      max_submit_calls: 1
    },
    validation: {
      "npm run env:check": "PENDING",
      "npm run provider:preflight": "PENDING",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [OUTPUT_REPORT_PATH, "scripts/r3-8e-runway-real-storyboard-keyframe-canary.ts", "package.json", ".agent_board/*"],
    commit: null,
    next_step: {
      no_automatic_second_submit: true,
      requires_new_user_authorization_for_any_retry_or_next_live_call: true
    },
    block_reason: null
  };
}

function blocked(report: Report, reason: string): Report {
  return {
    ...report,
    result: "BLOCK_WITH_REASON",
    block_reason: reason
  };
}

function validateGuard(report: Report, input: { artifact: MediaArtifact | null; freezeReport: G0FreezeReport | null; requestSummary: RunwayImageToVideoRequestSummary | null }): Report {
  if (report.source_evidence.r3_8d_report.result !== "PASS_READY_FOR_USER_AUTHORIZATION") return blocked(report, "R3-8D report is not PASS_READY_FOR_USER_AUTHORIZATION.");
  if (report.source_evidence.r3_8d_report.selected_artifact_id !== SELECTED_ARTIFACT_ID) return blocked(report, "R3-8D selected artifact does not match authorization.");
  if (!input.artifact) return blocked(report, "selected artifact is not present in app registry.");
  if (input.artifact.artifact_type !== "image" || input.artifact.role !== "storyboard_image" || input.artifact.status !== "active") {
    return blocked(report, "selected artifact is not an active storyboard_image image artifact.");
  }
  if (resolve(input.artifact.storage.uri) !== resolve(SELECTED_STORAGE_URI)) return blocked(report, "selected artifact storage_uri does not match authorization.");
  if (!existsSync(input.artifact.storage.uri)) return blocked(report, "selected artifact storage file does not exist.");
  if (report.selected_input.aspect_ratio !== "941:1672" || report.selected_input.width !== 941 || report.selected_input.height !== 1672) {
    return blocked(report, "selected keyframe image facts changed since R3-8D.");
  }
  if (report.preflight.env_check_result !== "PASS") return blocked(report, "env check did not pass.");
  if (report.preflight.provider_preflight_result !== "PASS") return blocked(report, "provider preflight did not pass.");
  if (report.preflight.active_provider !== "runway" || report.preflight.selected_provider !== "runway") return blocked(report, "active provider must be runway.");
  if (report.preflight.credential_env_name !== "RUNWAYML_API_SECRET" || report.preflight.credential_present !== true) {
    return blocked(report, "RUNWAYML_API_SECRET presence check did not pass.");
  }
  if (process.env.RUNWAYML_API_VERSION && process.env.RUNWAYML_API_VERSION !== RUNWAY_API_VERSION) return blocked(report, "RUNWAYML_API_VERSION env does not match 2024-11-06.");
  if (RUNWAY_API_VERSION !== "2024-11-06") return blocked(report, "Runway API version constant does not match 2024-11-06.");
  if (RUNWAY_IMAGE_TO_VIDEO_ENDPOINT !== "/v1/image_to_video") return blocked(report, "Runway endpoint constant does not match /v1/image_to_video.");
  if (normalizeRunwayDuration(2) !== 2) return blocked(report, "duration_seconds=2 is not accepted by local Runway duration normalizer.");
  if (mapRunwayAspectRatio("9:16") !== "720:1280") return blocked(report, "project aspect_ratio 9:16 does not map to Runway ratio 720:1280.");
  if (!input.requestSummary) return blocked(report, "Runway request summary was not generated.");
  if (input.requestSummary?.ratio !== "720:1280" || input.requestSummary.duration !== 2 || input.requestSummary.model !== "gen4.5") {
    return blocked(report, "Runway request summary does not match authorized model/ratio/duration.");
  }
  if (!input.freezeReport?.project?.project_id || !input.freezeReport.storyboard_package?.storyboard_package_id || !report.source_evidence.g0_package_freeze_report.shot_id) {
    return blocked(report, "G0 package freeze linkage for selected artifact is missing.");
  }
  return report;
}

async function pollUntilTerminal(adapter: RunwayVideoProviderAdapter, providerJobId: string): Promise<{ status: ProviderStatusResult; attempts: number }> {
  const intervalMs = numberFromEnv("PROVIDER_TASK_POLL_INTERVAL_MS", POLL_INTERVAL_MS_DEFAULT);
  const timeoutMs = numberFromEnv("PROVIDER_TASK_POLL_TIMEOUT_MS", POLL_TIMEOUT_MS_DEFAULT);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(intervalMs, 1)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await adapter.pollStatus(providerJobId);
    if (!status.ok || status.status === "succeeded" || status.status === "failed" || status.status === "cancelled") {
      return { status, attempts: attempt };
    }
    if (attempt < maxAttempts && intervalMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }

  return {
    attempts: maxAttempts,
    status: {
      ok: false,
      error: {
        code: "PROVIDER_TIMEOUT",
        message: "Runway task did not complete before the configured poll timeout.",
        retryable: true
      }
    }
  };
}

async function main(): Promise<Report> {
  ensureM0Directories();
  mkdirSync(resolve(paths.workspaceRoot, OUTPUT_DIR_RELATIVE), { recursive: true });
  loadProviderEnvLocal();

  const mode = process.argv.includes("--live") ? "live" : "dry_run";
  const db = openM0Database();
  try {
    const prepReport = readJson<Record<string, unknown>>(PREP_REPORT_PATH);
    const freezeReport = readJson<G0FreezeReport>(G0_FREEZE_REPORT_PATH);
    const artifact = getMediaArtifact(db, SELECTED_ARTIFACT_ID);
    const shotId = freezeReport?.shots?.find((candidate) => candidate.storyboard_image_artifact_id === SELECTED_ARTIFACT_ID)?.shot_id ?? "";
    const projectId = freezeReport?.project?.project_id ?? "";
    const packageId = freezeReport?.storyboard_package?.storyboard_package_id ?? "";
    const project = projectId ? getProject(db, projectId) : null;
    const shot = shotId ? getShot(db, shotId) : null;
    const storyboardPackage = packageId ? getStoryboardPackage(db, packageId) : null;

    const providerInput: ProviderGenerationInput | null =
      artifact && project && shot && storyboardPackage
        ? {
            storyboard_artifact: artifact,
            video_prompt: shot.video_prompt,
            negative_prompt: shot.negative_prompt,
            duration_seconds: 2,
            aspect_ratio: "9:16",
            resolution: "720x1280"
          }
        : null;
    const request = providerInput ? buildRunwayImageToVideoRequest(providerInput, "gen4.5") : null;
    let report = baseReport({
      mode,
      prepReport,
      freezeReport,
      artifact,
      requestSummary: request?.ok ? request.summary : null
    });

    report = validateGuard(report, { artifact, freezeReport, requestSummary: request?.ok ? request.summary : null });
    if (!project || !shot || !storyboardPackage) report = blocked(report, "Selected project, shot, or storyboard package is missing from the app database.");
    if (request && !request.ok) report = blocked(report, request.error.message);
    if (mode === "live" && !report.authorization.accepted) report = blocked(report, "R3-8E live call requires matching R3_8E_AUTHORIZATION_SHA256.");
    if (mode !== "live") return report;
    if (report.result === "BLOCK_WITH_REASON" || !providerInput || !request?.ok || !project || !shot) return report;

    const selected = selectM1ProviderPort({ provider: "real", provider_name: "runway", cost_acknowledged: true });
    if (!selected.ok || selected.selected.provider_name !== "runway") return blocked(report, selected.ok ? "selected provider is not runway." : selected.error.message);

    const adapter = new RunwayVideoProviderAdapter({
      credential: selected.selected.credential ?? "",
      api_base: process.env.RUNWAYML_API_BASE_URL || undefined
    });

    const submit = await adapter.submitGeneration(providerInput);
    report = {
      ...report,
      live_execution: {
        ...report.live_execution,
        submit_call_count: 1,
        network_call_attempted: true,
        runway_called: true
      },
      provider_boundary: {
        ...report.provider_boundary,
        submit_call_count: 1,
        network_call_attempted: true,
        runway_called: true
      }
    };

    if (!submit.ok) {
      const fields = providerErrorFields(submit.error);
      return {
        ...report,
        result: "PROVIDER_FAILED",
        live_execution: {
          ...report.live_execution,
          ...fields,
          provider_status: null
        }
      };
    }

    report = {
      ...report,
      live_execution: {
        ...report.live_execution,
        provider_job_id: submit.provider_job_id,
        provider_job_id_present: true,
        provider_status: submit.provider_status
      },
      provider_boundary: {
        ...report.provider_boundary,
        provider_credits_consumed: true
      }
    };

    const polled = await pollUntilTerminal(adapter, submit.provider_job_id);
    report = {
      ...report,
      live_execution: {
        ...report.live_execution,
        poll_attempts: polled.attempts,
        provider_status: polled.status.ok ? polled.status.provider_status : report.live_execution.provider_status
      }
    };

    if (!polled.status.ok) {
      return {
        ...report,
        result: "PROVIDER_FAILED",
        live_execution: {
          ...report.live_execution,
          ...providerErrorFields(polled.status.error)
        }
      };
    }

    if (polled.status.status !== "succeeded") {
      return {
        ...report,
        result: "PROVIDER_FAILED",
        live_execution: {
          ...report.live_execution,
          error_code: polled.status.status === "cancelled" ? "PROVIDER_REQUEST_FAILED" : "PROVIDER_REQUEST_FAILED",
          error_message: `Runway task ended with status ${polled.status.provider_status}.`
        }
      };
    }

    const outputUrl = polled.status.output_url;
    if (!outputUrl) {
      return {
        ...report,
        result: "PROVIDER_FAILED",
        live_execution: {
          ...report.live_execution,
          error_code: "PROVIDER_OUTPUT_MISSING",
          error_message: "Runway task succeeded without an output URL."
        }
      };
    }

    const download = await downloadProviderOutputToArtifact(
      {
        url: outputUrl,
        provider_name: "runway",
        provider_job_id: submit.provider_job_id,
        project_id: project.project_id,
        shot_id: shot.shot_id,
        duration_seconds: 2,
        aspect_ratio: "9:16",
        storage_directory: resolve(paths.workspaceRoot, OUTPUT_DIR_RELATIVE)
      },
      db
    );

    if (!download.ok) {
      return {
        ...report,
        result: "PROVIDER_FAILED",
        live_execution: {
          ...report.live_execution,
          ...providerErrorFields(download.error)
        }
      };
    }

    return {
      ...report,
      result: "PASS_LIVE_SINGLE_SUBMIT_COMPLETED",
      live_execution: {
        ...report.live_execution,
        output_url_hostname: download.output_url_hostname
      },
      output_artifact: {
        generated_artifact_id: download.artifact.artifact_id,
        storage_uri: download.artifact.storage.uri,
        ffprobe_status: download.ffprobe.status,
        duration_seconds: download.ffprobe.duration_seconds ?? null,
        has_video_stream: download.ffprobe.has_video_stream,
        stream_count: download.ffprobe.stream_count
      },
      provider_boundary: {
        ...report.provider_boundary,
        real_video_generated: true
      }
    };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [process.env.RUNWAYML_API_SECRET ?? ""]);
    return blocked(
      baseReport({
        mode: process.argv.includes("--live") ? "live" : "dry_run",
        prepReport: null,
        freezeReport: null,
        artifact: null,
        requestSummary: null
      }),
      message
    );
  } finally {
    db.close();
  }
}

const report = await main();
writeFileSync(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      result: report.result,
      report_path: workspaceRelative(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH)),
      submit_call_count: report.provider_boundary.submit_call_count,
      provider_job_id_present: report.live_execution.provider_job_id_present,
      generated_artifact_id: report.output_artifact.generated_artifact_id,
      secret_values_exposed: false
    },
    null,
    2
  )
);

if (report.result === "BLOCK_WITH_REASON" || report.result === "PROVIDER_FAILED") process.exitCode = 1;
