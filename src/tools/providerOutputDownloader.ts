import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";

import { paths } from "../paths.js";
import { activateLocalMediaArtifact, recoverMediaActivations, type MediaArtifact } from "./mediaArtifacts.js";
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
  /** @deprecated Provider output transports must use runtime.fetch_pinned_address so validated DNS addresses cannot be ignored. */
  fetch_impl?: typeof fetch;
  safety?: Partial<ProviderOutputDownloadSafety>;
}

export type ProviderOutputDownloadResult =
  | { ok: true; artifact: MediaArtifact; ffprobe: Mp4ValidationResult; output_url_hostname: string }
  | { ok: false; error: ProviderToolError };

export interface ProviderOutputDownloadRuntime {
  storage_root?: string;
  fault_injection_after_file_commit?: (path: string) => void;
  resolve_hostname?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  fetch_pinned_address?: (url: URL, signal: AbortSignal, address: { address: string; family: 4 | 6 }) => Promise<Response>;
}

const DEFAULT_SAFETY: ProviderOutputDownloadSafety = {
  timeout_seconds: 30,
  redirect_limit: 3,
  max_size_mb: 200
};

const BLOCKED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96],
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
] as const) BLOCKED_IPV6.addSubnet(network, prefix, "ipv6");

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
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return true;
  if (host === "169.254.169.254") return true;
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)?.[1];
  if (mappedIpv4) return isPrivateHost(mappedIpv4);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateHost(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  if (isIP(host) === 6) return BLOCKED_IPV6.check(host, "ipv6");

  const ipv4 = ipv4ToNumber(host);
  if (ipv4 === null) return false;
  const first = (ipv4 >>> 24) & 0xff;
  const second = (ipv4 >>> 16) & 0xff;
  const third = (ipv4 >>> 8) & 0xff;
  if (first === 10 || first === 127 || first === 0) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return true;
  if (first === 192 && second === 88 && third === 99) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  if (first >= 224) return true;
  return false;
}

async function publicAddresses(
  hostname: string,
  resolver: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(normalizedHostname);
  const addresses = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily as 4 | 6 }]
    : await resolver(normalizedHostname);
  if (addresses.length === 0 || addresses.some((candidate) => isPrivateHost(candidate.address))) {
    throw new Error("PROVIDER_OUTPUT_URI_BLOCKED");
  }
  return addresses;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return await new Promise<T>((resolveValue, rejectValue) => {
    const abort = (): void => rejectValue(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolveValue, rejectValue).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function pinnedHttpsFetch(url: URL, signal: AbortSignal, address: { address: string; family: 4 | 6 }): Promise<Response> {
  return await new Promise<Response>((resolveResponse, rejectResponse) => {
    const request = httpsRequest(url, {
      method: "GET",
      signal,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const body = [204, 205, 304].includes(response.statusCode ?? 500)
        ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolveResponse(new Response(body, { status: response.statusCode ?? 500, statusText: response.statusMessage, headers }));
    });
    request.on("error", rejectResponse);
    request.end();
  });
}

async function fetchFromValidatedAddresses(
  url: URL,
  signal: AbortSignal,
  addresses: Array<{ address: string; family: 4 | 6 }>,
  fetchAddress: (url: URL, signal: AbortSignal, address: { address: string; family: 4 | 6 }) => Promise<Response>
): Promise<Response> {
  let lastError: unknown = new Error("Provider output hostname had no reachable public address.");
  for (const address of addresses) {
    try {
      return await fetchAddress(url, signal, address);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
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

function outputStorageDirectory(input: ProviderOutputDownloadInput, runtime: ProviderOutputDownloadRuntime): { ok: true; path: string } | { ok: false; error: ProviderToolError } {
  const mediaRoot = resolve(runtime.storage_root ?? paths.mediaRoot);
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

function validateCommittedOutputPath(finalPath: string, storageDirectory: string): ProviderToolError | null {
  const entry = lstatSync(finalPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    return providerError("PROVIDER_OUTPUT_STORAGE_BLOCKED", "Existing provider output path must be a regular non-symlink file.");
  }
  const realDirectory = realpathSync(storageDirectory);
  const realFinalPath = realpathSync(finalPath);
  if (!isPathInside(realFinalPath, realDirectory)) {
    return providerError("PROVIDER_OUTPUT_STORAGE_BLOCKED", "Existing provider output path resolves outside app-controlled media storage.");
  }
  return null;
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
  safety: ProviderOutputDownloadSafety,
  resolver: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>,
  fetchAddress: (url: URL, signal: AbortSignal, address: { address: string; family: 4 | 6 }) => Promise<Response>
): Promise<{ response: Response; finalUrl: URL; cleanup: () => void } | { error: ProviderToolError }> {
  let currentUrl = initialUrl;
  for (let attempt = 0; attempt <= safety.redirect_limit; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), safety.timeout_seconds * 1000);
    let response: Response;
    try {
      const addresses = await abortable(publicAddresses(currentUrl.hostname, resolver), controller.signal);
      response = await fetchFromValidatedAddresses(currentUrl, controller.signal, addresses, fetchAddress);
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.message === "PROVIDER_OUTPUT_URI_BLOCKED") {
        return { error: providerError("PROVIDER_OUTPUT_URI_BLOCKED", "Provider output URL resolved to a private or local network address.") };
      }
      return {
        error: providerError(
          "PROVIDER_OUTPUT_DOWNLOAD_FAILED",
          error instanceof Error && error.name === "AbortError" ? "Provider output download timed out." : "Provider output download failed.",
          true
        )
      };
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
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
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
      return { error: providerError("PROVIDER_OUTPUT_DOWNLOAD_FAILED", `Provider output download returned HTTP ${response.status}.`, true) };
    }

    return { response, finalUrl: currentUrl, cleanup: () => clearTimeout(timeout) };
  }

  return { error: providerError("PROVIDER_OUTPUT_DOWNLOAD_FAILED", "Provider output exceeded redirect limit.", true) };
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<{ body: Buffer } | { error: ProviderToolError }> {
  if (!response.body) return { error: providerError("PROVIDER_OUTPUT_DOWNLOAD_FAILED", "Provider output response had no body.", true) };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("PROVIDER_OUTPUT_TOO_LARGE").catch(() => undefined);
        return { error: providerError("PROVIDER_OUTPUT_TOO_LARGE", "Provider output is larger than the configured maximum.") };
      }
      chunks.push(Buffer.from(next.value));
    }
    return { body: Buffer.concat(chunks, total) };
  } catch (error) {
    return {
      error: providerError(
        "PROVIDER_OUTPUT_DOWNLOAD_FAILED",
        error instanceof Error && error.name === "AbortError" ? "Provider output download timed out." : "Provider output download failed.",
        true
      )
    };
  } finally {
    reader.releaseLock();
  }
}

export async function downloadProviderOutputToArtifact(
  input: ProviderOutputDownloadInput,
  db: M0Database,
  runtime: ProviderOutputDownloadRuntime = {}
): Promise<ProviderOutputDownloadResult> {
  recoverMediaActivations(db);
  const safety: ProviderOutputDownloadSafety = { ...DEFAULT_SAFETY, ...input.safety };
  const storageDirectory = outputStorageDirectory(input, runtime);
  if (!storageDirectory.ok) return { ok: false, error: storageDirectory.error };

  const urlValidation = validateProviderOutputUrl(input.url);
  if (!urlValidation.ok) return { ok: false, error: urlValidation.error };

  if (input.fetch_impl) {
    return {
      ok: false,
      error: providerError(
        "PROVIDER_OUTPUT_PINNED_TRANSPORT_REQUIRED",
        "Injected provider output transports must consume the validated address through runtime.fetch_pinned_address."
      )
    };
  }

  const resolver = runtime.resolve_hostname ?? (async (hostname: string) => {
    const result = await lookup(hostname, { all: true, verbatim: true });
    return result.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  });
  const fetched = await fetchWithRedirects(urlValidation.url, safety, resolver, runtime.fetch_pinned_address ?? pinnedHttpsFetch);
  if ("error" in fetched) return { ok: false, error: fetched.error };

  const contentType = fetched.response.headers.get("content-type");
  if (!isAllowedContentType(contentType)) {
    fetched.cleanup();
    await fetched.response.body?.cancel().catch(() => undefined);
    return { ok: false, error: providerError("PROVIDER_OUTPUT_INVALID_CONTENT_TYPE", "Provider output did not advertise a video-compatible content type.") };
  }

  const contentLength = Number(fetched.response.headers.get("content-length"));
  const maxBytes = safety.max_size_mb * 1024 * 1024;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    fetched.cleanup();
    await fetched.response.body?.cancel().catch(() => undefined);
    return { ok: false, error: providerError("PROVIDER_OUTPUT_TOO_LARGE", "Provider output is larger than the configured maximum.") };
  }

  const downloaded = await readBoundedResponseBody(fetched.response, maxBytes);
  fetched.cleanup();
  if ("error" in downloaded) return { ok: false, error: downloaded.error };
  const body = downloaded.body;

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
    if (existsSync(finalPath)) {
      const boundaryError = validateCommittedOutputPath(finalPath, storageDirectory.path);
      if (boundaryError) return { ok: false, error: boundaryError };
    }
    const existingRow = db.prepare(`SELECT data_json FROM media_artifacts
      WHERE json_valid(data_json) = 1
        AND json_extract(data_json, '$.source.provider') = ?
        AND json_extract(data_json, '$.source.provider_job_id') = ?
      LIMIT 1`).get(input.provider_name, input.provider_job_id) as { data_json: string } | undefined;
    if (existingRow) {
      const existing = JSON.parse(existingRow.data_json) as MediaArtifact;
      if (existing.linked_objects.project_id !== input.project_id || existing.linked_objects.shot_id !== input.shot_id) {
        return { ok: false, error: providerError("PROVIDER_OUTPUT_TASK_CONFLICT", "Provider task output is already bound to a different project or SHOT.") };
      }
      return { ok: true, artifact: existing, ffprobe, output_url_hostname: fetched.finalUrl.hostname };
    }
    const preparedArtifact: MediaArtifact = {
      artifact_id: artifactId,
      blob_id: "",
      artifact_type: "video",
      role: "generated_clip",
      status: "active",
      storage: { uri: finalPath, mime_type: contentType ?? "video/mp4", filename: basename(finalPath) },
      metadata: { width: 1080, height: 1920, duration_seconds: ffprobe.duration_seconds ?? input.duration_seconds, aspect_ratio: input.aspect_ratio, sha256: "" },
      linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
      source: { kind: "provider_output_file", provider: input.provider_name, provider_job_id: input.provider_job_id, sha256: "", external_url_host: fetched.finalUrl.hostname }
    };
    const activated = activateLocalMediaArtifact({ artifact: preparedArtifact, source_path: tempPath, media_root: storageDirectory.path, after_file_placed: runtime.fault_injection_after_file_commit }, db);
    if (!activated.ok) return { ok: false, error: providerError(activated.error.code, activated.error.message) };
    return { ok: true, artifact: activated.artifact, ffprobe, output_url_hostname: fetched.finalUrl.hostname };
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}
