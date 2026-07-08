import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  ensureM0Directories,
  getProject,
  openM0Database,
  paths,
  registerMediaArtifact,
  saveGenerationRun,
  saveProject,
  validateMp4File,
  type GenerationRun
} from "../src/index.js";

const TASK = "R3-9O_FINAL_VIDEO_ASSEMBLY_EXECUTION";
const SOURCE_REPORT_PATH = "data/reports/r3_9n_final_video_assembly_dry_run_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9o_final_video_assembly_execution_result.json";

interface R3_9NReport {
  result?: string;
  project?: {
    project_id?: string | null;
    project_title?: string | null;
    storyboard_package_id?: string | null;
  };
  assembly_plan?: {
    status?: string;
    assembly_method?: string;
    codec_container_plan?: Record<string, unknown>;
    ffmpeg_executable?: string | null;
    ffmpeg_args?: string[];
    concat_list_path?: string;
    planned_output_dir?: string;
    planned_output_path?: string;
    estimated_total_duration_seconds?: number;
    input_clip_count?: number;
    final_video_written?: boolean;
    final_assembly_performed?: boolean;
  };
  ordered_input_clips?: AssemblyInput[];
  no_overwrite_gate?: {
    status?: string;
    output_dir_inside_final_artifacts_root?: boolean;
    output_path_inside_output_dir?: boolean;
    output_path_exists?: boolean;
    concat_list_path_exists?: boolean;
    source_assets_overwritten?: boolean;
    existing_final_master_overwritten?: boolean;
    blockers?: string[];
  };
  provider_boundary?: Record<string, unknown>;
  git_receipt?: {
    commit?: string;
  };
}

interface AssemblyInput {
  order: number;
  shot_id: string;
  accepted_clip_artifact_id: string;
  local_mp4_path: string;
  input_exists: boolean;
  byte_size: number;
  duration_seconds: number;
  ffprobe_status: string;
  source_generation_run_id: string;
  generation_batch_id: string;
  local_blockers: string[];
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hasExistingSymlinkAncestor(child: string, parent: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (!isPathInside(resolvedChild, resolvedParent)) return true;
  const parts = relative(resolvedParent, resolvedChild).split(/[\\/]+/).filter(Boolean);
  let current = resolvedParent;
  for (const part of parts) {
    current = resolve(current, part);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function concatFileLine(filePath: string): string {
  const normalized = resolve(filePath).replace(/\\/g, "/");
  return `file '${normalized.replace(/'/g, "'\\''")}'`;
}

function fileSize(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0;
}

function pathSha256InReportUnavailable(): null {
  return null;
}

ensureM0Directories();

const source = readJson<R3_9NReport>(SOURCE_REPORT_PATH);
const blockers: string[] = [];
if (!source) blockers.push("R3_9N_REPORT_MISSING");
if (source?.result !== "PASS_READY_FOR_LOCAL_FINAL_ASSEMBLY_EXECUTION") blockers.push("R3_9N_NOT_PASS");
if (source?.assembly_plan?.status !== "READY_FOR_LOCAL_EXECUTION") blockers.push("R3_9N_PLAN_NOT_READY");
if (source?.assembly_plan?.final_video_written !== false) blockers.push("R3_9N_ALREADY_WRITTEN");
if (source?.assembly_plan?.final_assembly_performed !== false) blockers.push("R3_9N_ALREADY_ASSEMBLED");
if (source?.no_overwrite_gate?.status !== "PASS") blockers.push("R3_9N_NO_OVERWRITE_GATE_NOT_PASS");
if (source?.no_overwrite_gate?.output_path_exists !== false) blockers.push("R3_9N_OUTPUT_PATH_ALREADY_EXISTED");
if (source?.no_overwrite_gate?.concat_list_path_exists !== false) blockers.push("R3_9N_CONCAT_LIST_ALREADY_EXISTED");
if (source?.provider_boundary?.network_call_attempted !== false) blockers.push("R3_9N_PROVIDER_BOUNDARY_NOT_CLEAN");

const outputDir = resolve(source?.assembly_plan?.planned_output_dir ?? "");
const outputPath = resolve(source?.assembly_plan?.planned_output_path ?? "");
const concatListPath = resolve(source?.assembly_plan?.concat_list_path ?? "");
const finalRoot = resolve(paths.finalArtifactsRoot);
const ffmpeg = source?.assembly_plan?.ffmpeg_executable ?? null;
const orderedInputs = [...(source?.ordered_input_clips ?? [])].sort((left, right) => left.order - right.order);

if (!ffmpeg || !existsSync(ffmpeg)) blockers.push("FFMPEG_EXECUTABLE_MISSING");
if (!source?.assembly_plan?.planned_output_dir) blockers.push("OUTPUT_DIR_MISSING");
if (!source?.assembly_plan?.planned_output_path) blockers.push("OUTPUT_PATH_MISSING");
if (!source?.assembly_plan?.concat_list_path) blockers.push("CONCAT_LIST_PATH_MISSING");
if (!isPathInside(outputDir, finalRoot)) blockers.push("OUTPUT_DIR_OUTSIDE_FINAL_ARTIFACT_ROOT");
if (!isPathInside(outputPath, outputDir)) blockers.push("OUTPUT_PATH_OUTSIDE_OUTPUT_DIR");
if (!isPathInside(concatListPath, outputDir)) blockers.push("CONCAT_LIST_PATH_OUTSIDE_OUTPUT_DIR");
if (dirname(outputPath) !== outputDir) blockers.push("OUTPUT_PATH_NOT_DIRECT_CHILD_OF_OUTPUT_DIR");
if (dirname(concatListPath) !== outputDir) blockers.push("CONCAT_LIST_NOT_DIRECT_CHILD_OF_OUTPUT_DIR");
if (existsSync(outputPath)) blockers.push("OUTPUT_PATH_ALREADY_EXISTS");
if (existsSync(concatListPath)) blockers.push("CONCAT_LIST_PATH_ALREADY_EXISTS");
if (hasExistingSymlinkAncestor(outputDir, finalRoot)) blockers.push("OUTPUT_DIR_SYMLINK_ANCESTOR");

if (orderedInputs.length !== 4) blockers.push("INPUT_CLIP_COUNT_NOT_4");
const inputRows = orderedInputs.map((input, index) => {
  const rowBlockers: string[] = [];
  if (input.order !== index + 1) rowBlockers.push("ORDER_NOT_CONTIGUOUS");
  if (!input.accepted_clip_artifact_id?.startsWith("artifact_")) rowBlockers.push("ARTIFACT_ID_INVALID");
  if (!input.local_mp4_path || !existsSync(input.local_mp4_path)) rowBlockers.push("INPUT_PATH_MISSING");
  if (input.local_mp4_path && existsSync(input.local_mp4_path) && !statSync(input.local_mp4_path).isFile()) rowBlockers.push("INPUT_PATH_NOT_FILE");
  if (input.ffprobe_status !== "PASS") rowBlockers.push("INPUT_FFPROBE_NOT_PASS");
  if ((input.local_blockers ?? []).length > 0) rowBlockers.push("INPUT_HAS_LOCAL_BLOCKERS");
  if (resolve(input.local_mp4_path) === outputPath) rowBlockers.push("INPUT_EQUALS_OUTPUT_PATH");
  blockers.push(...rowBlockers.map((blocker) => `${input.shot_id}:${blocker}`));
  return {
    order: input.order,
    shot_id: input.shot_id,
    accepted_clip_artifact_id: input.accepted_clip_artifact_id,
    local_mp4_path: input.local_mp4_path,
    input_exists: Boolean(input.local_mp4_path && existsSync(input.local_mp4_path)),
    byte_size: fileSize(input.local_mp4_path),
    duration_seconds: input.duration_seconds,
    ffprobe_status: input.ffprobe_status,
    source_generation_run_id: input.source_generation_run_id,
    generation_batch_id: input.generation_batch_id,
    local_blockers: rowBlockers
  };
});

let ffmpegExitCode: number | null = null;
let ffmpegError = "";
let ffprobe = validateMp4File(outputPath);
let finalVideoArtifactId: string | null = null;
let finalVideoArtifactPath: string | null = null;
let assemblyRunId: string | null = null;
let registrationError: { code: string; message: string } | null = null;
let projectExportUpdated = false;
let concatListWritten = false;
let finalVideoWritten = false;

if (blockers.length === 0) {
  mkdirSync(outputDir, { recursive: true });
  if (lstatSync(outputDir).isSymbolicLink()) blockers.push("OUTPUT_DIR_IS_SYMLINK");
  if (!isPathInside(realpathSync(outputDir), realpathSync(finalRoot))) blockers.push("OUTPUT_DIR_REALPATH_ESCAPES_FINAL_ROOT");
}

if (blockers.length === 0) {
  const concatBody = `${inputRows.map((row) => concatFileLine(row.local_mp4_path)).join("\n")}\n`;
  writeFileSync(concatListPath, concatBody, "utf8");
  concatListWritten = true;

  const ffmpegArgs = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath
  ];
  const ffmpegResult = spawnSync(ffmpeg as string, ffmpegArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
    windowsHide: true
  });
  ffmpegExitCode = typeof ffmpegResult.status === "number" ? ffmpegResult.status : 1;
  ffmpegError = ffmpegResult.stderr?.trim() || ffmpegResult.error?.message || "";
  if (ffmpegExitCode !== 0) {
    blockers.push("FFMPEG_ASSEMBLY_FAILED");
  }
  finalVideoWritten = existsSync(outputPath) && fileSize(outputPath) > 0;
  if (!finalVideoWritten) blockers.push("FINAL_VIDEO_NOT_WRITTEN");
  ffprobe = validateMp4File(outputPath);
  if (ffprobe.status !== "PASS") blockers.push("FINAL_VIDEO_FFPROBE_NOT_PASS");
}

if (blockers.length === 0) {
  const db = openM0Database();
  try {
    const projectId = source?.project?.project_id ?? "";
    const project = getProject(db, projectId);
    if (!project) {
      blockers.push("PROJECT_NOT_FOUND");
    } else if (project.exports.final_video_artifact_id) {
      blockers.push("PROJECT_ALREADY_HAS_FINAL_VIDEO_ARTIFACT");
    } else {
      const artifactResult = registerMediaArtifact(
        {
          artifact_type: "video",
          role: "final_video",
          source: { kind: "provider_output_file", path: outputPath, mime_type: "video/mp4" },
          storage_directory: outputDir,
          linked_objects: { project_id: project.project_id },
          metadata: {
            duration_seconds: ffprobe.duration_seconds ?? source?.assembly_plan?.estimated_total_duration_seconds ?? null,
            aspect_ratio: project.video_spec.aspect_ratio,
            width: 480,
            height: 854
          },
          provenance: {
            provider: "local_assembly",
            provider_job_id: "",
            sha256: pathSha256InReportUnavailable() ?? undefined
          }
        },
        db
      );
      if (!artifactResult.ok) {
        registrationError = artifactResult.error;
        blockers.push(`FINAL_VIDEO_ARTIFACT_REGISTRATION_FAILED:${artifactResult.error.code}`);
      } else {
        finalVideoArtifactId = artifactResult.artifact.artifact_id;
        finalVideoArtifactPath = artifactResult.artifact.storage.uri;
        assemblyRunId = `run_r3_9o_${randomUUID()}`;
        const run: GenerationRun = {
          run_id: assemblyRunId,
          batch_id: "batch_r3_9o_local_final_assembly",
          project_id: project.project_id,
          shot_id: "",
          run_type: "assemble_video",
          status: "succeeded",
          input: {
            storyboard_image_artifact_id: "",
            video_prompt: "local ffmpeg concat final assembly from accepted R3-9J regenerated clips",
            negative_prompt: "",
            duration_seconds: inputRows.reduce((sum, row) => sum + row.duration_seconds, 0),
            aspect_ratio: project.video_spec.aspect_ratio,
            resolution: project.video_spec.resolution
          },
          output: {
            artifact_ids: [finalVideoArtifactId]
          },
          provider: {
            provider: "mock",
            provider_name: "mock",
            model_name: "ffmpeg_concat_local",
            provider_job_id: "",
            provider_status: "succeeded"
          },
          versioning: {
            attempt_number: 1,
            parent_run_id: ""
          },
          error: {
            code: "",
            message: "",
            retryable: false
          }
        };
        project.exports.final_video_artifact_id = finalVideoArtifactId;
        project.status = "video_review";
        saveProject(db, project);
        saveGenerationRun(db, run);
        projectExportUpdated = true;
      }
    }
  } finally {
    db.close();
  }
}

const result = blockers.length === 0 ? "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED" : "FAIL_LOCAL_FINAL_VIDEO_ASSEMBLY";
const payload = {
  task: TASK,
  result,
  mode: "local_final_video_assembly_execution",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9n_dry_run_report: SOURCE_REPORT_PATH,
    r3_9n_result: source?.result ?? null,
    r3_9n_commit: source?.git_receipt?.commit ?? null
  },
  project: {
    project_id: source?.project?.project_id ?? null,
    project_title: source?.project?.project_title ?? null,
    storyboard_package_id: source?.project?.storyboard_package_id ?? null,
    project_export_updated: projectExportUpdated
  },
  assembly_execution: {
    status: result === "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED" ? "ASSEMBLED" : "FAILED",
    assembly_method: "ffmpeg concat demuxer",
    ffmpeg_executable: ffmpeg,
    ffmpeg_exit_code: ffmpegExitCode,
    ffmpeg_error_tail: ffmpegError.split(/\r?\n/).slice(-8).join("\n"),
    concat_list_path: concatListPath,
    concat_list_written: concatListWritten,
    final_video_path: outputPath,
    final_video_exists: existsSync(outputPath),
    final_video_byte_size: fileSize(outputPath),
    final_video_written: finalVideoWritten,
    final_assembly_performed: ffmpegExitCode === 0,
    final_video_artifact_id: finalVideoArtifactId,
    final_video_artifact_path: finalVideoArtifactPath,
    assembly_run_id: assemblyRunId,
    input_clip_count: inputRows.length,
    source_clip_artifact_ids: inputRows.map((row) => row.accepted_clip_artifact_id),
    estimated_input_total_duration_seconds: inputRows.reduce((sum, row) => sum + row.duration_seconds, 0),
    output_duration_seconds: ffprobe.duration_seconds,
    registration_error: registrationError
  },
  ordered_input_clips: inputRows,
  ffprobe_result: ffprobe,
  no_overwrite_confirmation: {
    output_path_existed_before_execution: source?.no_overwrite_gate?.output_path_exists ?? null,
    concat_list_existed_before_execution: source?.no_overwrite_gate?.concat_list_path_exists ?? null,
    output_path_inside_output_dir: isPathInside(outputPath, outputDir),
    output_dir_inside_final_artifacts_root: isPathInside(outputDir, finalRoot),
    source_assets_overwritten: false,
    existing_final_master_overwritten: false,
    blockers
  },
  provider_boundary: {
    network_call_attempted: false,
    runninghub_called: false,
    runway_called: false,
    media_upload_to_provider: false,
    provider_submit: false,
    status_poll: false,
    output_download_from_provider: false,
    provider_credits_consumed: false,
    regeneration_performed: false,
    batch_generation_performed: false,
    local_final_video_generated: finalVideoWritten,
    final_assembly_performed: ffmpegExitCode === 0,
    final_video_written: finalVideoWritten,
    env_files_read: false,
    credentials_read: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    publish_performed: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false
  },
  validation: {
    "npm run r3:9o:assemble": result === "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED" ? "PASS" : "FAIL",
    "JSON parse for generated assembly execution report": "PENDING",
    "final video path existence check": finalVideoWritten ? "PASS" : "FAIL",
    "final video ffprobe PASS": ffprobe.status,
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "src/tools/mediaArtifacts.ts",
    "tests/m1-provider-boundary.test.ts",
    "scripts/r3-9o-final-video-assembly-execution.ts",
    OUTPUT_REPORT_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED" ? null : "R3-9O local final assembly failed; inspect no_overwrite_confirmation.blockers and assembly_execution.",
  git_receipt: {
    repo: true,
    branch: "master",
    commit: "PENDING_LOCAL_COMMIT",
    task: TASK,
    push: false,
    pr: null,
    tag_created: false,
    release_or_deploy_performed: false
  }
};

writeFileSync(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  result,
  report_path: OUTPUT_REPORT_PATH,
  final_video_path: outputPath,
  final_video_artifact_id: finalVideoArtifactId,
  ffprobe_status: ffprobe.status,
  duration_seconds: ffprobe.duration_seconds,
  local_blocker_count: blockers.length,
  network_call_attempted: false,
  runninghub_called: false,
  runway_called: false,
  env_files_read: false,
  credentials_read: false,
  source_assets_overwritten: false
}, null, 2));
if (result !== "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED") process.exitCode = 1;
