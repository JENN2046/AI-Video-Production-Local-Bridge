import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import { paths } from "../paths.js";
import { persistMediaArtifact, type MediaArtifact } from "./mediaArtifacts.js";
import { validateMp4File, type Mp4ValidationResult } from "./mediaValidity.js";
import { providerError, type ProviderToolError } from "./provider.js";
import type { M0Database } from "../storage/sqlite.js";

export interface ProviderOutputDownloadSafety {
  timeout_seconds: number;
  redirect_limit: number;
  max_size_mb: number;
}

export interface ProviderOutputDownloadInput {
  url: string;
  provider_name: string;
  provider_job_id: string;
  project_id: string;
  shot_id: string;
  duration_seconds: number;
  aspect_ratio: string;
  storage_directory?: string;
  allowed_storage_root?: string;
  fetch_impl?: typeof fetch;
  safety?: Partial<ProviderOutputDownloadSafety>;
}

export type ProviderOutputDownloadResult =
  | { ok: true; artifact: MediaArtifact; ffprobe: Mp4ValidationResult; output_url_hostname: string }
  | { ok: false; error: ProviderToolError };

export interface ProviderOutputDownloadRuntime {
  fault_injection_after_file_commit?: (path: string) => void;
}

const DEFAULT_SAFETY: ProviderOutputDownloadSafety = {
  timeout_seconds: 30,
  redirect_limit: 3,
  max_size_mb: 200
};

function ipv4ToNumber(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const parsed = Number(part);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
    value = (value << 8) + parsed;
  }
  return value >>> 0;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (host === "169.254.169.254") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;

  const ipv4 = ipv4ToNumber(host);
  if (ipv4 === null) return false;
  const first = (ipv4 >>> 24) & 0xff;
  const second = (ipv4 >>> 16) & 0xff;
  if (first === 10 || first === 127 || first === 0) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  return false;
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

function outputStorageDirectory(input: ProviderOutputDownloadInput): { ok: true; path: string } | { ok: false; error: ProviderToolError } {
  const mediaRoot = resolve(input.allowed_storage_root ?? paths.mediaRoot);
  const directory = resolve(input.storage_directory ?? paths.videoArtifactsRoot);
  if (!isPathInside(directory, mediaRoot)) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_STORAGE_BLOCKED", "Provider output storage directory must be inside app-controlled media storage.") };
  }
  if (hasExistingSymlinkAncestor(directory, mediaRoot)) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_STORAGE_BLOCKED", "Provider output storage directory must not pass through symbolic links.") };
  }
  mkdirSync(directory, { recursive: true });
  if (lstatSync(mediaRoot).isSymbolicLink()) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_STORAGE_BLOCKED", "App media root symbolic links are blocked for provider outputs.") };
  }
  if (lstatSync(directory).isSymbolicLink()) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_STORAGE_BLOCKED", "Provider output storage directory symbolic links are blocked.") };
  }
  const realMediaRoot = realpathSync(mediaRoot);
  const realDirectory = realpathSync(directory);
  if (!isPathInside(realDirectory, realMediaRoot)) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_STORAGE_BLOCKED", "Provider output storage directory resolves outside app-controlled media storage.") };
  }
  return { ok: true, path: directory };
}

export function validateProviderOutputUrl(urlInput: string): { ok: true; url: URL } | { ok: false; error: ProviderToolError } {
  let url: URL;
  try {
    url = new URL(urlInput);
  } catch {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_URI_BLOCKED", "Provider output URL is invalid.") };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_URI_BLOCKED", "Provider output URL must use https.") };
  }

  if (url.username || url.password) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_URI_BLOCKED", "Provider output URL must not contain embedded credentials.") };
  }

  if (isPrivateHost(url.hostname)) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_URI_BLOCKED", "Provider output URL targets a private or local network host.") };
  }

  return { ok: true, url };
}

function isAllowedContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return normalized.includes("video/") || normalized.includes("application/octet-stream") || normalized.includes("binary/octet-stream");
}

function extensionForUrl(url: URL): string {
  const ext = extname(url.pathname).toLowerCase();
  return ext === ".mp4" ? ".mp4" : ".mp4";
}

async function fetchWithRedirects(
  initialUrl: URL,
  fetchImpl: typeof fetch,
  safety: ProviderOutputDownloadSafety
): Promise<{ response: Response; finalUrl: URL } | { error: ProviderToolError }> {
  let currentUrl = initialUrl;
  for (let attempt = 0; attempt <= safety.redirect_limit; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), safety.timeout_seconds * 1000);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      return {
        error: providerError(
          "PROVIDER_OUTPUT_DOWNLOAD_FAILED",
          error instanceof Error && error.name === "AbortError" ? "Provider output download timed out." : "Provider output download failed.",
          true
        )
      };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { error: providerError("PROVIDER_OUTPUT_DOWNLOAD_FAILED", "Provider output redirect was missing a Location header.", true) };
      }
      const nextUrl = new URL(location, currentUrl);
      const urlValidation = validateProviderOutputUrl(nextUrl.toString());
      if (!urlValidation.ok) return { error: urlValidation.error };
      currentUrl = urlValidation.url;
      continue;
    }

    if (!response.ok) {
      return { error: providerError("PROVIDER_OUTPUT_DOWNLOAD_FAILED", `Provider output download returned HTTP ${response.status}.`, true) };
    }

    return { response, finalUrl: currentUrl };
  }

  return { error: providerError("PROVIDER_OUTPUT_DOWNLOAD_FAILED", "Provider output exceeded redirect limit.", true) };
}

export async function downloadProviderOutputToArtifact(
  input: ProviderOutputDownloadInput,
  db: M0Database,
  runtime: ProviderOutputDownloadRuntime = {}
): Promise<ProviderOutputDownloadResult> {
  const safety: ProviderOutputDownloadSafety = { ...DEFAULT_SAFETY, ...input.safety };
  const storageDirectory = outputStorageDirectory(input);
  if (!storageDirectory.ok) return { ok: false, error: storageDirectory.error };

  const urlValidation = validateProviderOutputUrl(input.url);
  if (!urlValidation.ok) return { ok: false, error: urlValidation.error };

  const fetchImpl = input.fetch_impl ?? fetch;
  const fetched = await fetchWithRedirects(urlValidation.url, fetchImpl, safety);
  if ("error" in fetched) return { ok: false, error: fetched.error };

  const contentType = fetched.response.headers.get("content-type");
  if (!isAllowedContentType(contentType)) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_INVALID_CONTENT_TYPE", "Provider output did not advertise a video-compatible content type.") };
  }

  const contentLength = Number(fetched.response.headers.get("content-length"));
  const maxBytes = safety.max_size_mb * 1024 * 1024;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_TOO_LARGE", "Provider output is larger than the configured maximum.") };
  }

  const body = Buffer.from(await fetched.response.arrayBuffer());
  if (body.byteLength > maxBytes) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_TOO_LARGE", "Provider output is larger than the configured maximum.") };
  }

  mkdirSync(storageDirectory.path, { recursive: true });
  const tempPath = resolve(storageDirectory.path, `provider_download_${randomUUID()}${extensionForUrl(fetched.finalUrl)}`);
  writeFileSync(tempPath, body);

  try {
    const ffprobe = validateMp4File(tempPath);
    if (ffprobe.status !== "PASS") {
      return { ok: false, error: providerError("PROVIDER_OUTPUT_INVALID", ffprobe.error || "Provider output is not ffprobe-valid.") };
    }

    const identity = createHash("sha256").update(`${input.provider_name}\0${input.provider_job_id}`).digest("hex");
    const artifactId = `artifact_${identity}`;
    const finalPath = resolve(storageDirectory.path, `${artifactId}.mp4`);
    if (!isPathInside(finalPath, storageDirectory.path)) throw new Error("PROVIDER_OUTPUT_STORAGE_BLOCKED");
    let createdFinal = false;
    try {
      linkSync(tempPath, finalPath);
      createdFinal = true;
    } catch (error) {
      if (!existsSync(finalPath)) throw error;
    }
    const committedValidation = validateMp4File(finalPath);
    if (committedValidation.status !== "PASS") {
      if (createdFinal) rmSync(finalPath, { force: true });
      return { ok: false, error: providerError("PROVIDER_OUTPUT_INVALID", committedValidation.error || "Committed provider output is invalid.") };
    }
    const sha256 = createHash("sha256").update(readFileSync(finalPath)).digest("hex");
    const preparedArtifact: MediaArtifact = {
      artifact_id: artifactId,
      artifact_type: "video",
      role: "generated_clip",
      status: "active",
      storage: { uri: finalPath, mime_type: contentType ?? "video/mp4", filename: basename(finalPath) },
      metadata: { width: 1080, height: 1920, duration_seconds: committedValidation.duration_seconds ?? input.duration_seconds, aspect_ratio: input.aspect_ratio, sha256 },
      linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
      source: { kind: "provider_output_file", provider: input.provider_name, provider_job_id: input.provider_job_id, sha256, external_url_host: fetched.finalUrl.hostname }
    };
    runtime.fault_injection_after_file_commit?.(finalPath);

    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = db.prepare(`SELECT data_json FROM media_artifacts
        WHERE json_valid(data_json) = 1
          AND json_extract(data_json, '$.source.provider') = ?
          AND json_extract(data_json, '$.source.provider_job_id') = ?
        LIMIT 1`).get(input.provider_name, input.provider_job_id) as { data_json: string } | undefined;
      if (existingRow) {
        const existing = JSON.parse(existingRow.data_json) as MediaArtifact;
        if (existing.linked_objects.project_id !== input.project_id || existing.linked_objects.shot_id !== input.shot_id) {
          if (createdFinal && resolve(existing.storage.uri) !== finalPath) rmSync(finalPath, { force: true });
          db.exec("ROLLBACK");
          return { ok: false, error: providerError("PROVIDER_OUTPUT_TASK_CONFLICT", "Provider task output is already bound to a different project or SHOT.") };
        }
        if (createdFinal && resolve(existing.storage.uri) !== finalPath) rmSync(finalPath, { force: true });
        db.exec("COMMIT");
        return { ok: true, artifact: existing, ffprobe, output_url_hostname: fetched.finalUrl.hostname };
      }
      persistMediaArtifact(db, preparedArtifact);
      db.exec("COMMIT");
      return { ok: true, artifact: preparedArtifact, ffprobe, output_url_hostname: fetched.finalUrl.hostname };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}
