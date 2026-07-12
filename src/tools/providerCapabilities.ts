export const PROVIDER_CAPABILITY_REGISTRY_VERSION = "provider-capabilities-v1" as const;

export type CapabilityProviderName = "runninghub" | "runway";
const RUNNINGHUB_IMAGE_TO_VIDEO_MODEL = "rhart-video-g/image-to-video" as const;

export interface ProviderCapability {
  capability_id: string;
  version: typeof PROVIDER_CAPABILITY_REGISTRY_VERSION;
  provider: CapabilityProviderName;
  model: string;
  generation_mode: "image_to_video";
  allowed_resolutions: readonly string[];
  default_resolution: string;
  pixel_resolution_by_aspect: Readonly<Record<string, string>>;
  duration: {
    min_seconds: number;
    max_seconds: number;
    step_seconds: number;
    default_seconds: number;
  };
  allowed_aspect_ratios: readonly string[];
  price_preview_path: string | null;
}

export const RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY = Object.freeze({
  capability_id: "runninghub.image_to_video.v1",
  version: PROVIDER_CAPABILITY_REGISTRY_VERSION,
  provider: "runninghub",
  model: RUNNINGHUB_IMAGE_TO_VIDEO_MODEL,
  generation_mode: "image_to_video",
  allowed_resolutions: Object.freeze(["480p", "720p"]),
  default_resolution: "480p",
  pixel_resolution_by_aspect: Object.freeze({ "9:16": "480p", "16:9": "480p", "2:3": "480p", "3:2": "480p", "1:1": "480p" }),
  duration: Object.freeze({ min_seconds: 6, max_seconds: 60, step_seconds: 1, default_seconds: 6 }),
  allowed_aspect_ratios: Object.freeze(["9:16", "16:9", "2:3", "3:2", "1:1"]),
  price_preview_path: `/openapi/v2/price-preview/${RUNNINGHUB_IMAGE_TO_VIDEO_MODEL}`
} as const satisfies ProviderCapability);

export const RUNWAY_IMAGE_TO_VIDEO_CAPABILITY = Object.freeze({
  capability_id: "runway.image_to_video.v1",
  version: PROVIDER_CAPABILITY_REGISTRY_VERSION,
  provider: "runway",
  model: "gen4.5",
  generation_mode: "image_to_video",
  allowed_resolutions: Object.freeze(["720:1280", "1280:768"]),
  default_resolution: "720:1280",
  pixel_resolution_by_aspect: Object.freeze({ "9:16": "720:1280", "16:9": "1280:768" }),
  duration: Object.freeze({ min_seconds: 2, max_seconds: 10, step_seconds: 1, default_seconds: 5 }),
  allowed_aspect_ratios: Object.freeze(["9:16", "16:9"]),
  price_preview_path: null
} as const satisfies ProviderCapability);

export const PROVIDER_CAPABILITIES: Readonly<Record<CapabilityProviderName, ProviderCapability>> = Object.freeze({
  runninghub: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY,
  runway: RUNWAY_IMAGE_TO_VIDEO_CAPABILITY
});

export interface ProviderCapabilityKey {
  registry_version: typeof PROVIDER_CAPABILITY_REGISTRY_VERSION;
  capability_id: string;
  provider: CapabilityProviderName;
  model: string;
  duration_seconds: number;
  resolution: string;
  aspect_ratio: string;
  serialized: string;
}

export interface ProviderRequestProjection {
  model: string;
  duration_seconds: number;
  resolution: string;
  aspect_ratio: string;
}

export interface ProviderPriceCacheKey {
  provider: CapabilityProviderName;
  model: string;
  duration_seconds: number;
  resolution: string;
  storage_resolution: string;
  aspect_ratio: string;
  source: string;
  serialized: string;
}

export type ProviderCapabilityKeyResult =
  | { ok: true; capability: ProviderCapability; key: ProviderCapabilityKey; aspect_ratio: string }
  | { ok: false; code: "PROVIDER_CAPABILITY_NOT_FOUND" | "PROVIDER_CAPABILITY_MODEL_MISMATCH" | "PROVIDER_CAPABILITY_DURATION_UNSUPPORTED" | "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED" | "PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED"; field: "provider" | "model" | "duration_seconds" | "resolution" | "aspect_ratio" };

function pixelOrientationMatches(width: number, height: number, aspectRatio: string): boolean {
  if (aspectRatio === "1:1") return width === height;
  const [aspectWidth, aspectHeight] = aspectRatio.split(":").map(Number);
  if (!Number.isFinite(aspectWidth) || !Number.isFinite(aspectHeight)) return false;
  if (aspectWidth === aspectHeight) return width === height;
  return aspectWidth < aspectHeight ? width < height : width > height;
}

function normalizeResolution(capability: ProviderCapability, resolution: string, aspectRatio: string): string | null {
  const requested = resolution.trim();
  if (!requested) return capability.pixel_resolution_by_aspect[aspectRatio] ?? capability.default_resolution;
  const pixels = /^(\d+)x(\d+)$/.exec(requested);
  if (pixels) {
    const width = Number(pixels[1]);
    const height = Number(pixels[2]);
    if (width <= 0 || height <= 0 || !pixelOrientationMatches(width, height, aspectRatio)) return null;
    return capability.pixel_resolution_by_aspect[aspectRatio] ?? null;
  }
  return capability.allowed_resolutions.includes(requested) ? requested : null;
}

function durationAllowed(capability: ProviderCapability, durationSeconds: number): boolean {
  const rule = capability.duration;
  return Number.isInteger(durationSeconds)
    && durationSeconds >= rule.min_seconds
    && durationSeconds <= rule.max_seconds
    && (durationSeconds - rule.min_seconds) % rule.step_seconds === 0;
}

export function buildProviderCapabilityKey(input: {
  provider: CapabilityProviderName;
  model?: string;
  duration_seconds: number;
  resolution: string;
  aspect_ratio: string;
}): ProviderCapabilityKeyResult {
  const capability = PROVIDER_CAPABILITIES[input.provider];
  if (!capability) return { ok: false, code: "PROVIDER_CAPABILITY_NOT_FOUND", field: "provider" };
  if (input.model !== undefined && input.model !== capability.model) {
    return { ok: false, code: "PROVIDER_CAPABILITY_MODEL_MISMATCH", field: "model" };
  }
  if (!durationAllowed(capability, input.duration_seconds)) {
    return { ok: false, code: "PROVIDER_CAPABILITY_DURATION_UNSUPPORTED", field: "duration_seconds" };
  }
  const resolution = normalizeResolution(capability, input.resolution, input.aspect_ratio);
  if (!resolution) return { ok: false, code: "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED", field: "resolution" };
  if (!capability.allowed_aspect_ratios.includes(input.aspect_ratio)) {
    return { ok: false, code: "PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED", field: "aspect_ratio" };
  }
  const key: ProviderCapabilityKey = {
    registry_version: PROVIDER_CAPABILITY_REGISTRY_VERSION,
    capability_id: capability.capability_id,
    provider: capability.provider,
    model: capability.model,
    duration_seconds: input.duration_seconds,
    resolution,
    aspect_ratio: input.aspect_ratio,
    serialized: [capability.version, capability.capability_id, capability.provider, capability.model, input.duration_seconds, resolution, input.aspect_ratio].join("|")
  };
  return { ok: true, capability, key, aspect_ratio: input.aspect_ratio };
}

export function projectProviderRequest(input: Parameters<typeof buildProviderCapabilityKey>[0]):
  | { ok: true; capability: ProviderCapability; key: ProviderCapabilityKey; request: ProviderRequestProjection }
  | Extract<ProviderCapabilityKeyResult, { ok: false }> {
  const result = buildProviderCapabilityKey(input);
  if (!result.ok) return result;
  return {
    ok: true,
    capability: result.capability,
    key: result.key,
    request: {
      model: result.key.model,
      duration_seconds: result.key.duration_seconds,
      resolution: result.key.resolution,
      aspect_ratio: result.aspect_ratio
    }
  };
}

export function providerCapabilityErrorMessage(result: Extract<ProviderCapabilityKeyResult, { ok: false }>): string {
  return `${result.code}: unsupported ${result.field}.`;
}

export function providerCapabilityPriceSource(capability: ProviderCapability, aspectRatio: string): string {
  return `human_workbench_official_preflight@${capability.version}:${capability.capability_id}:${aspectRatio}`;
}

export function buildProviderPriceCacheKey(key: ProviderCapabilityKey, capability: ProviderCapability): ProviderPriceCacheKey {
  if (key.registry_version !== capability.version || key.capability_id !== capability.capability_id) {
    throw new Error("PROVIDER_CAPABILITY_PRICE_KEY_MISMATCH");
  }
  const source = providerCapabilityPriceSource(capability, key.aspect_ratio);
  // The v2-4 cache table's primary key predates capability sources. Folding the
  // versioned source into its resolution dimension preserves distinct verified
  // estimates without changing the workbench-v2-5 schema ledger.
  const storageResolution = `${key.resolution}@${source}`;
  return {
    provider: key.provider,
    model: key.model,
    duration_seconds: key.duration_seconds,
    resolution: key.resolution,
    storage_resolution: storageResolution,
    aspect_ratio: key.aspect_ratio,
    source,
    serialized: [source, key.provider, key.model, key.duration_seconds, key.resolution, key.aspect_ratio].join("|")
  };
}
