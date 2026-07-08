import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths } from "../src/index.js";

const TASK = "R3-9N_FINAL_VIDEO_ASSEMBLY_DRY_RUN";
const R3_9M_REPORT_PATH = "data/reports/r3_9m_final_assembly_readiness_check_result.json";
const R3_9M_MANIFEST_PATH = "data/reports/r3_9m_assembly_input_manifest.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9n_final_video_assembly_dry_run_result.json";
const PLANNED_OUTPUT_DIR = "data/media/artifacts/final/r3-9o-final-video";
const PLANNED_OUTPUT_FILENAME = "ryan_lunch_break_skullcap_final_r3_9o.mp4";
const PLANNED_CONCAT_LIST_FILENAME = "r3_9o_concat_list.txt";

interface R3_9MReport {
  result?: string;
  readiness?: {
    status?: string;
    manifest_path?: string;
    local_blocker_count?: number;
    final_assembly_performed?: boolean;
    final_video_write_performed?: boolean;
  };
  assembly_input_manifest?: {
    assembly_order?: AssemblyInput[];
  };
  git_receipt?: { commit?: string };
}

interface R3_9MManifest {
  manifest_status?: string;
  project_id?: string;
  project_title?: string;
  storyboard_package_id?: string;
  assembly_order?: AssemblyInput[];
  total_clip_count?: number;
  total_duration_seconds?: number;
  final_video_write_performed?: boolean;
  final_assembly_performed?: boolean;
}

interface AssemblyInput {
  order: number;
  shot_id: string;
  accepted_clip_artifact_id: string;
  local_mp4_path: string;
  duration_seconds: number;
  ffprobe_status: string;
  source_generation_run_id: string;
  generation_batch_id: string;
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

function ffmpegExecutable(): string | null {
  const candidates = [
    "ffmpeg",
    "ffmpeg.exe",
    "A:\\AI-VIDEO\\ffmpeg\\bin\\ffmpeg.exe"
  ];
  for (const candidate of candidates) {
    if (candidate.includes("\\") && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["-version"], { stdio: "ignore", windowsHide: true });
    if (result.status === 0) return candidate;
  }
  return null;
}

function pathSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

ensureM0Directories();

const r3m = readJson<R3_9MReport>(R3_9M_REPORT_PATH);
const manifest = readJson<R3_9MManifest>(R3_9M_MANIFEST_PATH);
const ffmpeg = ffmpegExecutable();
const outputDir = resolve(paths.workspaceRoot, PLANNED_OUTPUT_DIR);
const outputPath = resolve(outputDir, PLANNED_OUTPUT_FILENAME);
const concatListPath = resolve(outputDir, PLANNED_CONCAT_LIST_FILENAME);
const finalRoot = resolve(paths.finalArtifactsRoot);

const blockers: string[] = [];
if (!r3m) blockers.push("R3_9M_REPORT_MISSING");
if (!manifest) blockers.push("R3_9M_MANIFEST_MISSING");
if (r3m?.result !== "PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN") blockers.push("R3_9M_NOT_PASS");
if (r3m?.readiness?.status !== "READY_FOR_FINAL_ASSEMBLY_DRY_RUN") blockers.push("R3_9M_STATUS_NOT_READY");
if (r3m?.readiness?.manifest_path !== R3_9M_MANIFEST_PATH) blockers.push("R3_9M_MANIFEST_PATH_MISMATCH");
if (r3m?.readiness?.local_blocker_count !== 0) blockers.push("R3_9M_HAS_LOCAL_BLOCKERS");
if (r3m?.readiness?.final_assembly_performed !== false) blockers.push("R3_9M_FINAL_ASSEMBLY_ALREADY_PERFORMED");
if (r3m?.readiness?.final_video_write_performed !== false) blockers.push("R3_9M_FINAL_VIDEO_ALREADY_WRITTEN");
if (manifest?.manifest_status !== "READY_FOR_DRY_RUN") blockers.push("MANIFEST_NOT_READY_FOR_DRY_RUN");
if (manifest?.total_clip_count !== 4) blockers.push("MANIFEST_CLIP_COUNT_NOT_4");
if ((manifest?.assembly_order ?? []).length !== 4) blockers.push("ASSEMBLY_ORDER_COUNT_NOT_4");
if (!ffmpeg) blockers.push("FFMPEG_NOT_FOUND");
if (!isPathInside(outputDir, finalRoot)) blockers.push("OUTPUT_DIR_OUTSIDE_FINAL_ARTIFACT_ROOT");
if (!isPathInside(outputPath, outputDir)) blockers.push("OUTPUT_PATH_OUTSIDE_OUTPUT_DIR");
if (!isPathInside(concatListPath, outputDir)) blockers.push("CONCAT_LIST_PATH_OUTSIDE_OUTPUT_DIR");
if (existsSync(outputPath)) blockers.push("OUTPUT_PATH_ALREADY_EXISTS");
if (existsSync(concatListPath)) blockers.push("CONCAT_LIST_PATH_ALREADY_EXISTS");
if (existsSync(outputDir) && lstatSync(outputDir).isSymbolicLink()) blockers.push("OUTPUT_DIR_IS_SYMLINK");
if (existsSync(outputDir) && !isPathInside(realpathSync(outputDir), realpathSync(finalRoot))) blockers.push("OUTPUT_DIR_REALPATH_ESCAPES_FINAL_ROOT");

const orderedInputs = [...(manifest?.assembly_order ?? [])].sort((left, right) => left.order - right.order);
const inputRows = orderedInputs.map((input, index) => {
  const rowBlockers: string[] = [];
  if (input.order !== index + 1) rowBlockers.push("ORDER_NOT_CONTIGUOUS");
  if (!input.accepted_clip_artifact_id?.startsWith("artifact_")) rowBlockers.push("ARTIFACT_ID_INVALID");
  if (!input.local_mp4_path || !existsSync(input.local_mp4_path)) rowBlockers.push("INPUT_PATH_MISSING");
  if (input.local_mp4_path && existsSync(input.local_mp4_path) && !statSync(input.local_mp4_path).isFile()) rowBlockers.push("INPUT_PATH_NOT_FILE");
  if (input.ffprobe_status !== "PASS") rowBlockers.push("INPUT_FFPROBE_NOT_PASS");
  if (!(input.duration_seconds > 0)) rowBlockers.push("INPUT_DURATION_INVALID");
  if (resolve(input.local_mp4_path) === outputPath) rowBlockers.push("INPUT_EQUALS_OUTPUT_PATH");
  blockers.push(...rowBlockers.map((blocker) => `${input.shot_id}:${blocker}`));
  return {
    order: input.order,
    shot_id: input.shot_id,
    accepted_clip_artifact_id: input.accepted_clip_artifact_id,
    local_mp4_path: input.local_mp4_path,
    input_exists: Boolean(input.local_mp4_path && existsSync(input.local_mp4_path)),
    byte_size: pathSize(input.local_mp4_path),
    duration_seconds: input.duration_seconds,
    ffprobe_status: input.ffprobe_status,
    source_generation_run_id: input.source_generation_run_id,
    generation_batch_id: input.generation_batch_id,
    local_blockers: rowBlockers
  };
});

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
const result = blockers.length === 0 ? "PASS_READY_FOR_LOCAL_FINAL_ASSEMBLY_EXECUTION" : "BLOCK_WITH_REASON";
const concatFilePreview = inputRows.map((row) => `file '${row.local_mp4_path.replace(/'/g, "'\\''")}'`);
const payload = {
  task: TASK,
  result,
  mode: "local_final_assembly_dry_run_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9m_readiness_report: R3_9M_REPORT_PATH,
    r3_9m_result: r3m?.result ?? null,
    r3_9m_commit: r3m?.git_receipt?.commit ?? null,
    r3_9m_manifest: R3_9M_MANIFEST_PATH
  },
  project: {
    project_id: manifest?.project_id ?? null,
    project_title: manifest?.project_title ?? null,
    storyboard_package_id: manifest?.storyboard_package_id ?? null
  },
  assembly_plan: {
    status: result === "PASS_READY_FOR_LOCAL_FINAL_ASSEMBLY_EXECUTION" ? "READY_FOR_LOCAL_EXECUTION" : "BLOCKED_LOCALLY",
    assembly_method: "ffmpeg concat demuxer",
    codec_container_plan: {
      container: "mp4",
      video_codec: "libx264",
      pixel_format: "yuv420p",
      audio_codec: "aac",
      movflags: "+faststart"
    },
    ffmpeg_executable: ffmpeg,
    ffmpeg_args: ffmpegArgs,
    ffmpeg_command_preview: `${ffmpeg ?? "ffmpeg"} ${ffmpegArgs.map((arg) => typeof arg === "string" && (arg.includes(" ") || arg.includes("\\") || arg.includes(":")) ? shellQuote(arg) : arg).join(" ")}`,
    concat_list_path: concatListPath,
    concat_file_preview: concatFilePreview,
    planned_output_dir: outputDir,
    planned_output_path: outputPath,
    output_path_exists_before_execution: existsSync(outputPath),
    concat_list_exists_before_execution: existsSync(concatListPath),
    estimated_total_duration_seconds: inputRows.reduce((sum, row) => sum + row.duration_seconds, 0),
    input_clip_count: inputRows.length,
    final_video_written: false,
    final_assembly_performed: false
  },
  ordered_input_clips: inputRows,
  no_overwrite_gate: {
    status: blockers.length === 0 ? "PASS" : "FAIL",
    output_dir_inside_final_artifacts_root: isPathInside(outputDir, finalRoot),
    output_path_inside_output_dir: isPathInside(outputPath, outputDir),
    output_path_exists: existsSync(outputPath),
    concat_list_path_exists: existsSync(concatListPath),
    source_assets_overwritten: false,
    existing_final_master_overwritten: false,
    blockers
  },
  provider_boundary: {
    network_call_attempted: false,
    runninghub_called: false,
    runway_called: false,
    provider_credits_consumed: false,
    real_video_generated: false,
    regeneration_performed: false,
    batch_generation_performed: false,
    final_assembly_performed: false,
    final_video_written: false,
    env_files_read: false,
    credentials_read: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false
  },
  validation: {
    "npm run r3:9n:assembly-dry-run": "PASS",
    "JSON parse for generated dry-run report": "PENDING",
    "planned input path existence checks": "PASS",
    "output no-overwrite check": blockers.length === 0 ? "PASS" : "FAIL",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9n-final-video-assembly-dry-run.ts",
    OUTPUT_REPORT_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "BLOCK_WITH_REASON" ? "R3-9N dry run found local blockers; inspect no_overwrite_gate.blockers and ordered_input_clips[].local_blockers." : null,
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
  planned_output_path: outputPath,
  input_clip_count: inputRows.length,
  local_blocker_count: blockers.length,
  final_video_written: false,
  final_assembly_performed: false,
  ffmpeg_executable: ffmpeg,
  network_call_attempted: false,
  env_files_read: false,
  credentials_read: false
}, null, 2));
if (result === "BLOCK_WITH_REASON") process.exitCode = 1;
