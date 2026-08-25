import { accessSync, constants, existsSync, lstatSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

export type MediaValidityStatus = "PASS" | "FAIL" | "NOT_TESTED";

export interface Mp4ValidationResult {
  status: MediaValidityStatus;
  path: string;
  ffprobe_exit_code: number | null;
  has_video_stream: boolean;
  width: number | null;
  height: number | null;
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
  width?: number;
  height?: number;
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

function probeMp4(input: string, displayPath: string, stdinDescriptor?: number): Mp4ValidationResult {
  const ffprobe = findFfprobeExecutable();
  if (!ffprobe) {
    return {
      status: "NOT_TESTED",
      path: displayPath,
      ffprobe_exit_code: null,
      has_video_stream: false,
      width: null,
      height: null,
      duration_seconds: null,
      stream_count: 0,
      error: "ffprobe is unavailable."
    };
  }

  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", input],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
      windowsHide: true,
      ...(stdinDescriptor === undefined ? {} : { stdio: [stdinDescriptor, "pipe", "pipe"] })
    }
  );
  const exitCode = typeof result.status === "number" ? result.status : 1;
  if (exitCode !== 0) {
    return {
      status: "FAIL",
      path: displayPath,
      ffprobe_exit_code: exitCode,
      has_video_stream: false,
      width: null,
      height: null,
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
      path: displayPath,
      ffprobe_exit_code: exitCode,
      has_video_stream: false,
      width: null,
      height: null,
      duration_seconds: null,
      stream_count: 0,
      error: "ffprobe output was not valid JSON."
    };
  }

  const streams = parsed.streams ?? [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  const duration = parseDuration(parsed.format?.duration) ?? parseDuration(videoStreams[0]?.duration);
  const width = Number(videoStreams[0]?.width);
  const height = Number(videoStreams[0]?.height);
  const hasVideoStream = videoStreams.length > 0
    && Number.isInteger(width) && width > 0
    && Number.isInteger(height) && height > 0;

  return {
    status: hasVideoStream && duration !== null ? "PASS" : "FAIL",
    path: displayPath,
    ffprobe_exit_code: exitCode,
    has_video_stream: hasVideoStream,
    width: hasVideoStream ? width : null,
    height: hasVideoStream ? height : null,
    duration_seconds: duration,
    stream_count: streams.length,
    error: hasVideoStream && duration !== null ? "" : "ffprobe did not report a dimensioned video stream and positive duration."
  };
}

export function validateMp4FileDescriptor(fileDescriptor: number): Mp4ValidationResult {
  if (!Number.isInteger(fileDescriptor) || fileDescriptor < 0) {
    return {
      status: "FAIL",
      path: "",
      ffprobe_exit_code: null,
      has_video_stream: false,
      width: null,
      height: null,
      duration_seconds: null,
      stream_count: 0,
      error: "MP4 file descriptor is invalid."
    };
  }
  return probeMp4("pipe:0", "", fileDescriptor);
}

export function validateMp4File(filePath: string): Mp4ValidationResult {
  if (!filePath) {
    return {
      status: "FAIL",
      path: filePath,
      ffprobe_exit_code: null,
      has_video_stream: false,
      width: null,
      height: null,
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
      width: null,
      height: null,
      duration_seconds: null,
      stream_count: 0,
      error: "MP4 file does not exist."
    };
  }

  try {
    accessSync(filePath, constants.R_OK);
    if (lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) {
      throw new Error("MP4 path is not a regular file.");
    }
  } catch (error) {
    return {
      status: "FAIL",
      path: filePath,
      ffprobe_exit_code: null,
      has_video_stream: false,
      width: null,
      height: null,
      duration_seconds: null,
      stream_count: 0,
      error: error instanceof Error ? error.message : "MP4 file is not readable."
    };
  }

  return probeMp4(filePath, filePath);
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
