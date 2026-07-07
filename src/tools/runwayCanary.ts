import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { assertInsideWorkspace, paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { createProject } from "./projects.js";
import { importStoryboardPackage } from "./storyboardPackages.js";
import { registerMediaArtifact } from "./mediaArtifacts.js";
import { startStoryboardVideoGeneration } from "./generation.js";
import { checkProviderEnv, providerPreflight } from "./providerEnv.js";
import {
  mapRunwayAspectRatio,
  normalizeRunwayDuration,
  RUNWAY_API_VERSION,
  RUNWAY_IMAGE_TO_VIDEO_ENDPOINT
} from "./videoProviderAdapters.js";
import { validateImageFile } from "./imageValidity.js";
import { redactSecrets } from "./provider.js";

export const RUNWAY_CANARY_COMMAND = "npm run runway:canary";
export const RUNWAY_CANARY_LIVE_AUTHORIZATION_PHRASE = "I_AUTHORIZE_SINGLE_SUBMIT_RUNWAY_CANARY";
export const RUNWAY_CANARY_INPUT_READINESS_REPORT = "data/reports/m1_r0_runway_canary_input_readiness.json";
export const RUNWAY_CANARY_DRY_RUN_REPORT = "data/reports/m1_r0_runway_canary_dry_run_report.json";

export interface RunwayCanaryOptions {
  mode?: "dry_run" | "live";
  env?: NodeJS.ProcessEnv;
  readiness_report_path?: string;
  authorization_phrase?: string;
}

export interface RunwayCanaryReport {
  task: "M1-R0-CANARY-SCRIPT_Add_Strict_Single_Submit_Runway_Canary_Script";
  result: "PASS_READY_FOR_USER_AUTHORIZATION" | "BLOCK_WITH_REASON" | "PASS_LIVE_SINGLE_SUBMIT_COMPLETED" | "PROVIDER_FAILED";
  mode: "dry_run" | "live";
  generated_at: string;
  command: string;
  network_call_attempted: boolean;
  runway_called: boolean;
  runninghub_called: boolean;
  provider_credits_consumed: boolean;
  real_video_generated: boolean;
  secret_values_exposed: false;
  provider_boundary: {
    provider: "runway";
    max_submit_calls: 1;
    duration_seconds: 2;
    input_image: string;
    project_aspect_ratio: "9:16";
    runway_ratio: "768:1280";
    endpoint: "POST /v1/image_to_video";
    x_runway_version: "2024-11-06";
    allow_regeneration: false;
    allow_batch_generation: false;
    allow_runninghub: false;
    allow_publish: false;
    allow_deploy: false;
    allow_source_asset_overwrite: false;
    allow_secret_printing: false;
    direct_9_16_sent_to_runway: false;
  };
  preflight: {
    env_check_result: "PASS" | "FAIL";
    provider_preflight_result: "PASS" | "BLOCKED";
    active_provider: string;
    selected_provider: string;
    status: string;
    credential_env_name: string | null;
    credential_present: boolean;
    missing: string[];
    network_call_attempted: false;
  };
  input_readiness: {
    report_path: string;
    report_result: string;
    selected_canary_input_exists: boolean;
    selected_canary_input_readable: boolean;
    selected_canary_input_usable: boolean;
    old_68_byte_fixture_marked_not_usable: boolean;
  };
  selected_canary_input: {
    path: string;
    absolute_path: string;
    mime_type: string;
    width: number;
    height: number;
    aspect_ratio: string;
    runway_ratio: string | null;
    duration_seconds: number;
    size_bytes: number;
    readable_by_image_validator: boolean;
    usable_for_real_provider_canary: boolean;
    source_type: string;
  };
  authorization: {
    required_for_real_call: true;
    provided: boolean;
    accepted: boolean;
    phrase_env: "RUNWAY_CANARY_AUTHORIZATION";
    required_phrase: string;
  };
  dry_run: {
    report_only: boolean;
    start_storyboard_video_generation_called: boolean;
    submit_generation_called: boolean;
    fallback_to_demo_m1_real: false;
  };
  live_result?: {
    project_id: string;
    storyboard_package_id: string;
    run_count: number;
    batch_id: string;
    run_id: string;
    run_status: string;
    generated_artifact_id: string | null;
    provider_job_id_present: boolean;
    error_code: string | null;
  };
  block_reason: string | null;
}

interface ReadinessReport {
  result?: string;
  selected_canary_input?: {
    path?: string;
    mime_type?: string;
    width?: number;
    height?: number;
    aspect_ratio?: string;
    runway_ratio?: string;
    size_bytes?: number;
    readable_by_image_validator?: boolean;
    source_type?: string;
    usable_for_real_provider_canary?: boolean;
  };
  acceptance?: {
    old_68_byte_fixture_marked_not_usable?: boolean;
  };
}

function reportPath(inputPath: string | undefined): string {
  return inputPath ?? join(paths.workspaceRoot, RUNWAY_CANARY_INPUT_READINESS_REPORT);
}

function workspaceRelative(absolutePath: string): string {
  return relative(paths.workspaceRoot, absolutePath).replace(/\\/g, "/");
}

function baseReport(input: {
  mode: "dry_run" | "live";
  env: NodeJS.ProcessEnv;
  readinessReportPath: string;
  selectedPath?: string;
}): RunwayCanaryReport {
  const envCheck = checkProviderEnv(input.env);
  const preflight = providerPreflight(input.env);
  const selectedPath = input.selectedPath ?? "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png";

  return {
    task: "M1-R0-CANARY-SCRIPT_Add_Strict_Single_Submit_Runway_Canary_Script",
    result: "PASS_READY_FOR_USER_AUTHORIZATION",
    mode: input.mode,
    generated_at: new Date().toISOString(),
    command: RUNWAY_CANARY_COMMAND,
    network_call_attempted: false,
    runway_called: false,
    runninghub_called: false,
    provider_credits_consumed: false,
    real_video_generated: false,
    secret_values_exposed: false,
    provider_boundary: {
      provider: "runway",
      max_submit_calls: 1,
      duration_seconds: 2,
      input_image: selectedPath,
      project_aspect_ratio: "9:16",
      runway_ratio: "768:1280",
      endpoint: `POST ${RUNWAY_IMAGE_TO_VIDEO_ENDPOINT}`,
      x_runway_version: RUNWAY_API_VERSION,
      allow_regeneration: false,
      allow_batch_generation: false,
      allow_runninghub: false,
      allow_publish: false,
      allow_deploy: false,
      allow_source_asset_overwrite: false,
      allow_secret_printing: false,
      direct_9_16_sent_to_runway: false
    },
    preflight: {
      env_check_result: envCheck.result,
      provider_preflight_result: preflight.result,
      active_provider: envCheck.provider_name,
      selected_provider: preflight.selected_provider,
      status: preflight.status,
      credential_env_name: envCheck.credential_env_name,
      credential_present: envCheck.credential_present,
      missing: [...new Set([...envCheck.missing, ...preflight.missing])],
      network_call_attempted: false
    },
    input_readiness: {
      report_path: workspaceRelative(input.readinessReportPath),
      report_result: "UNKNOWN",
      selected_canary_input_exists: false,
      selected_canary_input_readable: false,
      selected_canary_input_usable: false,
      old_68_byte_fixture_marked_not_usable: false
    },
    selected_canary_input: {
      path: selectedPath,
      absolute_path: "",
      mime_type: "",
      width: 0,
      height: 0,
      aspect_ratio: "",
      runway_ratio: null,
      duration_seconds: 2,
      size_bytes: 0,
      readable_by_image_validator: false,
      usable_for_real_provider_canary: false,
      source_type: ""
    },
    authorization: {
      required_for_real_call: true,
      provided: false,
      accepted: false,
      phrase_env: "RUNWAY_CANARY_AUTHORIZATION",
      required_phrase: RUNWAY_CANARY_LIVE_AUTHORIZATION_PHRASE
    },
    dry_run: {
      report_only: input.mode === "dry_run",
      start_storyboard_video_generation_called: false,
      submit_generation_called: false,
      fallback_to_demo_m1_real: false
    },
    block_reason: null
  };
}

function blocked(report: RunwayCanaryReport, reason: string): RunwayCanaryReport {
  return {
    ...report,
    result: "BLOCK_WITH_REASON",
    block_reason: reason
  };
}

function readReadiness(readinessReportPath: string): { report?: ReadinessReport; error?: string } {
  if (!existsSync(readinessReportPath)) {
    return { error: "input readiness report does not exist" };
  }

  try {
    return { report: JSON.parse(readFileSync(readinessReportPath, "utf8")) as ReadinessReport };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "input readiness report is not valid JSON" };
  }
}

function applyInputGuard(report: RunwayCanaryReport, readiness: ReadinessReport): RunwayCanaryReport {
  const selected = readiness.selected_canary_input;
  if (!selected?.path) return blocked(report, "input readiness report is missing selected_canary_input.path");

  const absolutePath = assertInsideWorkspace(resolve(paths.workspaceRoot, selected.path));
  const validation = validateImageFile(absolutePath);
  const sizeBytes = existsSync(absolutePath) ? readFileSync(absolutePath).byteLength : 0;
  const runwayRatio = mapRunwayAspectRatio("9:16");

  const next: RunwayCanaryReport = {
    ...report,
    provider_boundary: {
      ...report.provider_boundary,
      input_image: selected.path
    },
    input_readiness: {
      report_path: report.input_readiness.report_path,
      report_result: readiness.result ?? "UNKNOWN",
      selected_canary_input_exists: existsSync(absolutePath),
      selected_canary_input_readable: validation.ok,
      selected_canary_input_usable: selected.usable_for_real_provider_canary === true,
      old_68_byte_fixture_marked_not_usable: readiness.acceptance?.old_68_byte_fixture_marked_not_usable === true
    },
    selected_canary_input: {
      path: selected.path,
      absolute_path: absolutePath,
      mime_type: validation.detected_mime || selected.mime_type || "",
      width: validation.width,
      height: validation.height,
      aspect_ratio: validation.aspect_ratio,
      runway_ratio: runwayRatio,
      duration_seconds: 2,
      size_bytes: sizeBytes,
      readable_by_image_validator: validation.ok,
      usable_for_real_provider_canary: selected.usable_for_real_provider_canary === true,
      source_type: selected.source_type ?? ""
    }
  };

  if (!existsSync(absolutePath)) return blocked(next, "selected canary input does not exist");
  if (!validation.ok) return blocked(next, validation.error || "selected canary input is not readable by image validator");
  if (validation.aspect_ratio !== "9:16") return blocked(next, `selected canary input aspect_ratio must be 9:16, got ${validation.aspect_ratio}`);
  if (sizeBytes <= 68) return blocked(next, "selected canary input is still a tiny placeholder");
  if (selected.usable_for_real_provider_canary !== true) return blocked(next, "selected canary input is not marked usable_for_real_provider_canary=true");
  if (selected.source_type !== "fixture_canary_image_provider_path_only") return blocked(next, "selected canary input source_type is not fixture_canary_image_provider_path_only");
  if (readiness.acceptance?.old_68_byte_fixture_marked_not_usable !== true) return blocked(next, "old 68-byte fixture is not marked not usable");
  if (normalizeRunwayDuration(2) !== 2) return blocked(next, "canary duration_seconds=2 is not accepted by Runway duration normalizer");
  if (runwayRatio !== "768:1280") return blocked(next, `Runway ratio mapping for project 9:16 must be 768:1280, got ${runwayRatio ?? "null"}`);
  if (RUNWAY_API_VERSION !== "2024-11-06") return blocked(next, `Runway API version must be 2024-11-06, got ${RUNWAY_API_VERSION}`);
  if (RUNWAY_IMAGE_TO_VIDEO_ENDPOINT !== "/v1/image_to_video") return blocked(next, `Runway endpoint must be /v1/image_to_video, got ${RUNWAY_IMAGE_TO_VIDEO_ENDPOINT}`);

  return next;
}

function applyProviderGuard(report: RunwayCanaryReport): RunwayCanaryReport {
  if (report.preflight.env_check_result !== "PASS") return blocked(report, "env check did not pass");
  if (report.preflight.provider_preflight_result !== "PASS") return blocked(report, "provider preflight did not pass");
  if (report.preflight.active_provider !== "runway") return blocked(report, `active provider must be runway, got ${report.preflight.active_provider}`);
  if (report.preflight.selected_provider !== "runway") return blocked(report, `selected provider must be runway, got ${report.preflight.selected_provider}`);
  if (report.preflight.credential_env_name !== "RUNWAYML_API_SECRET") return blocked(report, "credential env must be RUNWAYML_API_SECRET");
  if (report.preflight.credential_present !== true) return blocked(report, "RUNWAYML_API_SECRET is not present");
  return report;
}

function liveAuthorization(input: RunwayCanaryOptions, env: NodeJS.ProcessEnv): { provided: boolean; accepted: boolean } {
  const phrase = input.authorization_phrase ?? env.RUNWAY_CANARY_AUTHORIZATION ?? "";
  return {
    provided: phrase.length > 0,
    accepted: phrase === RUNWAY_CANARY_LIVE_AUTHORIZATION_PHRASE
  };
}

export function buildRunwayCanaryDryRunReport(input: RunwayCanaryOptions = {}): RunwayCanaryReport {
  const env = input.env ?? process.env;
  const mode = input.mode ?? "dry_run";
  const readinessReportPath = assertInsideWorkspace(reportPath(input.readiness_report_path));
  let report = baseReport({ mode, env, readinessReportPath });

  const readiness = readReadiness(readinessReportPath);
  if (readiness.error || !readiness.report) {
    return blocked(report, readiness.error ?? "input readiness report could not be loaded");
  }

  report = applyInputGuard(report, readiness.report);
  report = applyProviderGuard(report);
  const authorization = liveAuthorization(input, env);
  report = {
    ...report,
    authorization: {
      ...report.authorization,
      provided: authorization.provided,
      accepted: authorization.accepted
    }
  };

  if (report.result === "BLOCK_WITH_REASON") return report;
  if (mode === "live" && !authorization.accepted) {
    return blocked(report, "live canary requires RUNWAY_CANARY_AUTHORIZATION exact phrase");
  }

  return {
    ...report,
    result: "PASS_READY_FOR_USER_AUTHORIZATION",
    block_reason: null
  };
}

export async function runStrictRunwayCanary(input: RunwayCanaryOptions = {}, db: M0Database = openM0Database()): Promise<RunwayCanaryReport> {
  const mode = input.mode ?? "dry_run";
  const dryRun = buildRunwayCanaryDryRunReport({ ...input, mode });
  if (dryRun.result !== "PASS_READY_FOR_USER_AUTHORIZATION" || mode === "dry_run") return dryRun;

  const liveAuth = liveAuthorization(input, input.env ?? process.env);
  if (!liveAuth.accepted) return blocked(dryRun, "live canary requires RUNWAY_CANARY_AUTHORIZATION exact phrase");

  const fixturePath = dryRun.selected_canary_input.path.replace(/^fixtures\//, "");
  try {
    const project = createProject(
      {
        title: "M1-R0 Strict Runway Canary",
        video_spec: {
          duration_seconds: 2,
          aspect_ratio: "9:16",
          resolution: "720x1280"
        }
      },
      db
    );
    if (!project.ok) return blocked(dryRun, project.error.message);

    const artifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: fixturePath },
        linked_objects: {
          project_id: project.project_id
        },
        metadata: {
          width: dryRun.selected_canary_input.width,
          height: dryRun.selected_canary_input.height,
          aspect_ratio: dryRun.selected_canary_input.aspect_ratio
        }
      },
      db
    );
    if (!artifact.ok) return blocked(dryRun, artifact.error.message);

    const storyboard = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            description: "M1-R0 strict single-submit Runway canary",
            storyboard_image_artifact_id: artifact.artifact.artifact_id,
            video_prompt: "Animate the provider-path canary keyframe with a gentle camera push.",
            negative_prompt: ""
          }
        ],
        user_approval: {
          storyboard_approved: true
        }
      },
      db
    );
    if (!storyboard.ok) return blocked(dryRun, storyboard.error.message);

    const generation = await startStoryboardVideoGeneration(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        selected_shot_ids: [storyboard.shots[0].shot_id],
        provider_output_storage_directory: join(paths.mediaRoot, "provider-canary", "m1-r0-runway-canary"),
        provider_execution: {
          provider: "real",
          provider_name: "runway",
          cost_acknowledged: true
        },
        confirmation: {
          confirmation_level: "hard_gate",
          user_confirmed: true
        }
      },
      db
    );
    if (!generation.ok) return blocked(dryRun, generation.error.message);

    const run = generation.runs[0];
    if (generation.runs.length !== 1) return blocked(dryRun, `strict canary expected 1 run, got ${generation.runs.length}`);
    if (generation.batch.summary.total !== 1) return blocked(dryRun, `strict canary expected batch total 1, got ${generation.batch.summary.total}`);

    const providerJobIdPresent = run.provider.provider_job_id.length > 0;
    return {
      ...dryRun,
      result: run.status === "succeeded" ? "PASS_LIVE_SINGLE_SUBMIT_COMPLETED" : "PROVIDER_FAILED",
      mode: "live",
      network_call_attempted: true,
      runway_called: true,
      provider_credits_consumed: providerJobIdPresent,
      real_video_generated: run.status === "succeeded" && run.output.artifact_ids.length > 0,
      dry_run: {
        report_only: false,
        start_storyboard_video_generation_called: true,
        submit_generation_called: true,
        fallback_to_demo_m1_real: false
      },
      live_result: {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        run_count: generation.runs.length,
        batch_id: generation.batch.batch_id,
        run_id: run.run_id,
        run_status: run.status,
        generated_artifact_id: run.output.artifact_ids[0] ?? null,
        provider_job_id_present: providerJobIdPresent,
        error_code: run.error.code || null
      }
    };
  } catch (error) {
    const redacted = redactSecrets(error instanceof Error ? error.message : String(error), [
      input.env?.RUNWAYML_API_SECRET ?? process.env.RUNWAYML_API_SECRET ?? ""
    ]);
    return blocked(dryRun, redacted);
  }
}
