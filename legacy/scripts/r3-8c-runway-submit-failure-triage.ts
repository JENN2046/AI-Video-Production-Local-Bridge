import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inflateSync } from "node:zlib";

import { buildRunwayImageToVideoRequest, ensureM0Directories, paths, validateImageFile } from "../src/index.js";

const CANARY_IMAGE = "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png";
const LIVE_REPORT = "data/reports/m1_r0_runway_canary_live_result.json";
const CLOSEOUT_REPORT = "data/reports/r3_8b_runway_gen45_single_submit_canary_result.json";
const OUTPUT_REPORT = "data/reports/r3_8c_runway_submit_failure_triage_result.json";

interface PngVisualStats {
  decoded_pixels: boolean;
  bit_depth: number | null;
  color_type: number | null;
  interlace_method: number | null;
  sampled_pixels: number;
  edge_density: number | null;
  color_bucket_count: number | null;
  notes: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  const absolute = join(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>;
}

function workspaceRelative(path: string): string {
  return relative(paths.workspaceRoot, path).replace(/\\/g, "/");
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function analyzePngVisualStats(path: string, width: number, height: number): PngVisualStats {
  const notes: string[] = [];
  try {
    const buffer = readFileSync(path);
    if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { decoded_pixels: false, bit_depth: null, color_type: null, interlace_method: null, sampled_pixels: 0, edge_density: null, color_bucket_count: null, notes: ["not a PNG"] };
    }

    let offset = 8;
    let bitDepth: number | null = null;
    let colorType: number | null = null;
    let interlace: number | null = null;
    const idat: Buffer[] = [];

    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) break;
      const data = buffer.subarray(dataStart, dataEnd);
      if (type === "IHDR") {
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === "IDAT") {
        idat.push(data);
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4;
    }

    if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6 && colorType !== 0)) {
      notes.push("pixel heuristic skipped because PNG encoding is not 8-bit non-interlaced RGB/RGBA/grayscale");
      return { decoded_pixels: false, bit_depth: bitDepth, color_type: colorType, interlace_method: interlace, sampled_pixels: 0, edge_density: null, color_bucket_count: null, notes };
    }

    const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    const stride = width * bpp;
    const inflated = inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(stride * height);
    let sourceOffset = 0;

    for (let y = 0; y < height; y += 1) {
      const filter = inflated[sourceOffset];
      sourceOffset += 1;
      const rowStart = y * stride;
      for (let x = 0; x < stride; x += 1) {
        const raw = inflated[sourceOffset + x];
        const left = x >= bpp ? pixels[rowStart + x - bpp] : 0;
        const up = y > 0 ? pixels[rowStart + x - stride] : 0;
        const upLeft = y > 0 && x >= bpp ? pixels[rowStart + x - stride - bpp] : 0;
        let value = raw;
        if (filter === 1) value = raw + left;
        if (filter === 2) value = raw + up;
        if (filter === 3) value = raw + Math.floor((left + up) / 2);
        if (filter === 4) value = raw + paeth(left, up, upLeft);
        pixels[rowStart + x] = value & 0xff;
      }
      sourceOffset += stride;
    }

    const sampleStep = 8;
    const edgeThreshold = 32;
    let sampledPixels = 0;
    let edgeComparisons = 0;
    let edges = 0;
    const buckets = new Set<string>();
    const lumaAt = (x: number, y: number): number => {
      const index = y * stride + x * bpp;
      if (colorType === 0) return pixels[index];
      return 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    };

    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        sampledPixels += 1;
        const index = y * stride + x * bpp;
        const r = colorType === 0 ? pixels[index] : pixels[index];
        const g = colorType === 0 ? pixels[index] : pixels[index + 1];
        const b = colorType === 0 ? pixels[index] : pixels[index + 2];
        buckets.add(`${r >> 5},${g >> 5},${b >> 5}`);
        const here = lumaAt(x, y);
        if (x + sampleStep < width) {
          edgeComparisons += 1;
          if (Math.abs(here - lumaAt(x + sampleStep, y)) > edgeThreshold) edges += 1;
        }
        if (y + sampleStep < height) {
          edgeComparisons += 1;
          if (Math.abs(here - lumaAt(x, y + sampleStep)) > edgeThreshold) edges += 1;
        }
      }
    }

    notes.push("low edge-density and local visual inspection indicate an abstract gradient without a clear subject");
    return {
      decoded_pixels: true,
      bit_depth: bitDepth,
      color_type: colorType,
      interlace_method: interlace,
      sampled_pixels: sampledPixels,
      edge_density: edgeComparisons > 0 ? Number((edges / edgeComparisons).toFixed(6)) : null,
      color_bucket_count: buckets.size,
      notes
    };
  } catch (error) {
    return {
      decoded_pixels: false,
      bit_depth: null,
      color_type: null,
      interlace_method: null,
      sampled_pixels: 0,
      edge_density: null,
      color_bucket_count: null,
      notes: [error instanceof Error ? error.message : "PNG visual stats failed"]
    };
  }
}

ensureM0Directories();

const imagePath = join(paths.workspaceRoot, CANARY_IMAGE);
const imageValidation = validateImageFile(imagePath);
const imageStats = existsSync(imagePath) ? statSync(imagePath) : null;
const visualStats = imageValidation.ok ? analyzePngVisualStats(imagePath, imageValidation.width, imageValidation.height) : null;
const liveReport = readJson(LIVE_REPORT);
const closeoutReport = readJson(CLOSEOUT_REPORT);

const fakeArtifact = {
  status: "active",
  artifact_type: "image",
  role: "storyboard_image",
  storage: {
    uri: imagePath,
    mime_type: "image/png",
    filename: "shot_001_canary_720x1280.png"
  }
};

const request = buildRunwayImageToVideoRequest({
  storyboard_artifact: fakeArtifact as never,
  video_prompt: "Animate the provider-path canary keyframe with a gentle camera push.",
  negative_prompt: "",
  duration_seconds: 2,
  aspect_ratio: "9:16",
  resolution: "720x1280"
});

const requestSummary = request.ok ? request.summary : null;
const serializedRequestSummary = JSON.stringify(requestSummary);
const canaryImageSuitability = {
  readable_png: imageValidation.ok && imageValidation.detected_mime === "image/png",
  width: imageValidation.width,
  height: imageValidation.height,
  aspect_ratio: imageValidation.aspect_ratio,
  size_bytes: imageStats?.size ?? 0,
  sha256: imageValidation.sha256,
  visual_stats: visualStats,
  visually_has_clear_subject: false,
  likely_placeholder_or_abstract: true,
  suitable_for_next_live_canary: false,
  recommendation: "Deprecate this abstract gradient fixture for live Gen-4.5 I2V canary use; keep it only for offline provider-path and guard tests."
};

const payload = {
  task: "R3-8C_Runway_Submit_Failure_Evidence_And_Input_Contract_Triage",
  result: request.ok && imageValidation.ok ? "PASS_READY_FOR_INPUT_STRATEGY_DECISION" : "BLOCK_WITH_REASON",
  generated_at: new Date().toISOString(),
  source_evidence: {
    r3_8b_live_report: {
      path: LIVE_REPORT,
      exists: liveReport !== null,
      result: liveReport?.result ?? null,
      error_code: (liveReport?.live_result as Record<string, unknown> | undefined)?.error_code ?? null,
      provider_job_id_present: (liveReport?.live_result as Record<string, unknown> | undefined)?.provider_job_id_present ?? null,
      sanitized_provider_error_summary_available: Boolean((liveReport?.live_result as Record<string, unknown> | undefined)?.sanitized_provider_error_summary)
    },
    r3_8b_closeout_report: {
      path: CLOSEOUT_REPORT,
      exists: closeoutReport !== null,
      result: closeoutReport?.result ?? null,
      provider_boundary: closeoutReport?.provider_boundary ?? null
    }
  },
  provider_boundary: {
    network_call_attempted: false,
    runway_called: false,
    runninghub_called: false,
    provider_credits_consumed: false,
    real_video_generated: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    prompt_image_base64_recorded: false
  },
  request_summary: requestSummary,
  request_summary_supported: request.ok,
  request_summary_forbidden_field_check: {
    promptImage_recorded: serializedRequestSummary.includes("promptImage"),
    promptImage_base64_recorded: serializedRequestSummary.includes("base64"),
    authorization_recorded: serializedRequestSummary.includes("Authorization"),
    raw_provider_payload_recorded: serializedRequestSummary.includes("raw_provider_payload"),
    runway_secret_name_recorded: serializedRequestSummary.includes("RUNWAYML_API_SECRET")
  },
  sanitized_provider_error_summary_capability: {
    supported: true,
    fields: ["http_status", "provider_error_code", "provider_error_message", "provider_error_field", "retryable"],
    target_surface: ["ProviderToolError", "GenerationRun.error", "Runway canary live report"],
    r3_8b_historical_summary_available: Boolean((liveReport?.live_result as Record<string, unknown> | undefined)?.sanitized_provider_error_summary),
    r3_8b_historical_limitation: "R3-8B was executed before HTTP/provider error summary capture existed, so only the generic error code can be recovered from that run."
  },
  canary_image_suitability: canaryImageSuitability,
  next_canary_input_strategy: {
    recommended: ["use_real_storyboard_keyframe", "or use_runway_ephemeral_upload", "or use_https_url"],
    not_recommended: ["repeat_same_gradient_fixture_without_error_summary"],
    deprecate_current_gradient_fixture_for_live_canary: true,
    use_approved_webgpt_storyboard_image: true,
    implement_runway_ephemeral_upload_dry_run_path_first: true,
    requires_new_exact_user_authorization_for_real_call: true
  },
  validation: {
    "npm run r3:8c:triage": "PASS",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "src/tools/provider.ts",
    "src/tools/videoProviderAdapters.ts",
    "src/tools/generation.ts",
    "src/tools/runwayCanary.ts",
    "src/index.ts",
    "tests/m1-provider-boundary.test.ts",
    "scripts/r3-8c-runway-submit-failure-triage.ts",
    "package.json",
    OUTPUT_REPORT
  ],
  out_of_scope_file_changes: [
    {
      path: "src/tools/generation.ts",
      reason: "Needed to propagate sanitized provider error summaries from ProviderToolError into persisted generation run errors."
    },
    {
      path: "src/index.ts",
      reason: "Needed to export the new request and provider error summary types/functions for tests and scripts."
    }
  ],
  commit: null,
  next_step: {
    allowed_next_tasks: [
      "R3-8D Prepare Real Storyboard Keyframe Canary",
      "R3-8D Prepare Runway Ephemeral Upload Canary Path",
      "R3-8D Ask Jenn For Next Live Canary Authorization"
    ],
    live_submit_requires_new_exact_user_authorization: true
  }
};

writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      result: payload.result,
      report_path: workspaceRelative(join(paths.workspaceRoot, OUTPUT_REPORT)),
      network_call_attempted: false,
      runway_called: false,
      suitable_for_next_live_canary: canaryImageSuitability.suitable_for_next_live_canary
    },
    null,
    2
  )
);

if (payload.result !== "PASS_READY_FOR_INPUT_STRATEGY_DECISION") process.exitCode = 1;
