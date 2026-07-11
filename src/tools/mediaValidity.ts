import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

export type MediaValidityStatus = "PASS" | "FAIL" | "NOT_TESTED";

export interface Mp4ValidationResult {
  status: MediaValidityStatus;
  path: string;
  ffprobe_exit_code: number | null;
  has_video_stream: boolean;
  duration_seconds: number | null;
  stream_count: number;
  error: string;
}

export interface MediaValiditySummary {
  status: MediaValidityStatus;
  checked: number;
  failed: number;
}

interface FfprobeStream {
  codec_type?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
  };
}

function executableCandidates(name: "ffprobe"): string[] {
  const envPath = process.env.FFPROBE_PATH;
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((entry) => [`${entry}\\${name}.exe`, `${entry}\\${name}`]);

  return [
    ...(envPath ? [envPath] : []),
    name,
    `${name}.exe`,
    "A:\\AI-VIDEO\\ffmpeg\\bin\\ffprobe.exe",
    ...(process.platform === "win32" && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffprobe.exe")] : []),
    ...pathCandidates
  ];
}

export function findFfprobeExecutable(): string | null {
  for (const candidate of executableCandidates("ffprobe")) {
    if (candidate.includes("\\") && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["-version"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (result.status === 0) return candidate;
  }

  return null;
}

function parseDuration(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function validateMp4File(filePath: string): Mp4ValidationResult {
  if (!filePath) {
    return {
      status: "FAIL",
      path: filePath,
      ffprobe_exit_code: null,
      has_video_stream: false,
      duration_seconds: null,
      stream_count: 0,
      error: "MP4 path is empty."
    };
  }

  if (!existsSync(filePath)) {
    return {
      status: "FAIL",
      path: filePath,
      ffprobe_exit_code: null,
      has_video_stream: false,
      duration_seconds: null,
      stream_count: 0,
      error: "MP4 file does not exist."
    };
  }

  try {
    readFileSync(filePath);
  } catch (error) {
    return {
      status: "FAIL",
      path: filePath,
      ffprobe_exit_code: null,
      has_video_stream: false,
      duration_seconds: null,
      stream_count: 0,
      error: error instanceof Error ? error.message : "MP4 file is not readable."
    };
  }

  const ffprobe = findFfprobeExecutable();
  if (!ffprobe) {
    return {
      status: "NOT_TESTED",
      path: filePath,
      ffprobe_exit_code: null,
      has_video_stream: false,
      duration_seconds: null,
      stream_count: 0,
      error: "ffprobe is unavailable."
    };
  }

  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", filePath],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
      windowsHide: true
    }
  );
  const exitCode = typeof result.status === "number" ? result.status : 1;
  if (exitCode !== 0) {
    return {
      status: "FAIL",
      path: filePath,
      ffprobe_exit_code: exitCode,
      has_video_stream: false,
      duration_seconds: null,
      stream_count: 0,
      error: result.stderr?.trim() || result.error?.message || "ffprobe failed."
    };
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch {
    return {
      status: "FAIL",
      path: filePath,
      ffprobe_exit_code: exitCode,
      has_video_stream: false,
      duration_seconds: null,
      stream_count: 0,
      error: "ffprobe output was not valid JSON."
    };
  }

  const streams = parsed.streams ?? [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  const duration = parseDuration(parsed.format?.duration) ?? parseDuration(videoStreams[0]?.duration);
  const hasVideoStream = videoStreams.length > 0;

  return {
    status: hasVideoStream && duration !== null ? "PASS" : "FAIL",
    path: filePath,
    ffprobe_exit_code: exitCode,
    has_video_stream: hasVideoStream,
    duration_seconds: duration,
    stream_count: streams.length,
    error: hasVideoStream && duration !== null ? "" : "ffprobe did not report a video stream and positive duration."
  };
}

export function summarizeMp4Validations(results: Mp4ValidationResult[]): MediaValiditySummary {
  const failed = results.filter((result) => result.status !== "PASS").length;
  const hasNotTested = results.some((result) => result.status === "NOT_TESTED");
  return {
    status: failed === 0 ? "PASS" : hasNotTested ? "NOT_TESTED" : "FAIL",
    checked: results.length,
    failed
  };
}
