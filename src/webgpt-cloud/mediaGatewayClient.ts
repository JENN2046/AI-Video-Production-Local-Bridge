import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import { z } from "zod/v4";

import {
  abortable,
  assertSafeHttpsUrl,
  createPinnedLookup,
  fetchFromValidatedAddresses,
  readBoundedBytes,
  resolvePublicAddresses,
  type PinnedNetworkAddress
} from "../net/pinnedHttpsTransport.js";
import {
  assertReadonlyMediaCapabilityKeyring,
  createReadonlyMediaCapabilityRequest,
  parseReadonlyMediaCapabilityKey,
  READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES,
  READONLY_MEDIA_CAPABILITY_PATH,
  READONLY_MEDIA_CAPABILITY_RESPONSE_SCHEMA,
  READONLY_MEDIA_SESSION_MAX_SECONDS,
  type ReadonlyMediaCapabilityKeyring
} from "./mediaCapability.js";
import type { ReadonlyMediaBinding } from "./snapshot.js";

export const READONLY_MEDIA_GATEWAY_ORIGIN = "https://media.skmt617.top";
export const READONLY_MEDIA_GATEWAY_CONNECT_TIMEOUT_MS = 5_000;
export const READONLY_MEDIA_GATEWAY_REQUEST_TIMEOUT_MS = 60_000;

const gatewayErrorSchema = z.object({
  error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,96}$/) }).strict()
}).strict();

export interface ReadonlyMediaGatewayRuntime {
  resolve_hostname?: (hostname: string) => Promise<PinnedNetworkAddress[]>;
  post_pinned_address?: (url: URL, signal: AbortSignal, address: PinnedNetworkAddress, body: Uint8Array) => Promise<Response>;
}

export interface ReadonlyMediaGatewayClientOptions {
  origin: string;
  keyring: ReadonlyMediaCapabilityKeyring;
  runtime?: ReadonlyMediaGatewayRuntime;
  now?: () => Date;
}

export function loadReadonlyMediaGatewayClientOptions(env: NodeJS.ProcessEnv): ReadonlyMediaGatewayClientOptions | null {
  const origin = env.WEBGPT_MEDIA_GATEWAY_ORIGIN?.trim() ?? "";
  const activeKid = env.WEBGPT_MEDIA_CAPABILITY_ACTIVE_KID?.trim() ?? "";
  const activeKey = env.WEBGPT_MEDIA_CAPABILITY_ACTIVE_KEY_B64URL?.trim() ?? "";
  const previousKid = env.WEBGPT_MEDIA_CAPABILITY_PREVIOUS_KID?.trim() ?? "";
  const previousKey = env.WEBGPT_MEDIA_CAPABILITY_PREVIOUS_KEY_B64URL?.trim() ?? "";
  const acceptedFrom = env.WEBGPT_MEDIA_CAPABILITY_PREVIOUS_ACCEPTED_FROM?.trim() ?? "";
  const acceptedUntil = env.WEBGPT_MEDIA_CAPABILITY_PREVIOUS_ACCEPTED_UNTIL?.trim() ?? "";
  const values = [origin, activeKid, activeKey, previousKid, previousKey, acceptedFrom, acceptedUntil];
  if (values.every((value) => value === "")) return null;
  if (!origin || !activeKid || !activeKey) throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_CONFIG_INVALID");
  const previousValues = [previousKid, previousKey, acceptedFrom, acceptedUntil];
  if (previousValues.some(Boolean) && !previousValues.every(Boolean)) throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_CONFIG_INVALID");
  try {
    const keyring: ReadonlyMediaCapabilityKeyring = {
      active: parseReadonlyMediaCapabilityKey(activeKid, activeKey),
      ...(previousValues.every(Boolean) ? {
        previous: {
          ...parseReadonlyMediaCapabilityKey(previousKid, previousKey),
          accepted_from: acceptedFrom,
          accepted_until: acceptedUntil
        }
      } : {})
    };
    assertReadonlyMediaCapabilityKeyring(keyring);
    return { origin: parseReadonlyMediaGatewayOrigin(origin), keyring };
  } catch {
    throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_CONFIG_INVALID");
  }
}

export interface ReadonlyMediaPlaybackGrant {
  state: "ready";
  kind: "image" | "video";
  mime_type: ReadonlyMediaBinding["mime_type"];
  capability_expires_at: string;
  session_max_seconds: typeof READONLY_MEDIA_SESSION_MAX_SECONDS;
  snapshot_fingerprint: string;
  playback_url: string;
}

export class ReadonlyMediaGatewayClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReadonlyMediaGatewayClientError";
  }
}

export function parseReadonlyMediaGatewayOrigin(value: string): string {
  try {
    const url = new URL(value);
    assertSafeHttpsUrl(url);
    if (url.origin !== READONLY_MEDIA_GATEWAY_ORIGIN || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("not the fixed media origin");
    }
    return url.origin;
  } catch {
    throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_ORIGIN_INVALID");
  }
}

async function postPinnedJson(
  url: URL,
  signal: AbortSignal,
  address: PinnedNetworkAddress,
  body: Uint8Array
): Promise<Response> {
  return await new Promise<Response>((resolveResponse, rejectResponse) => {
    const request = httpsRequest(url, {
      method: "POST",
      signal,
      lookup: createPinnedLookup(address),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(body.byteLength)
      }
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const responseBody = [204, 205, 304].includes(response.statusCode ?? 500)
        ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolveResponse(new Response(responseBody, { status: response.statusCode ?? 500, headers }));
    });
    request.setTimeout(READONLY_MEDIA_GATEWAY_CONNECT_TIMEOUT_MS, () => request.destroy(new Error("MEDIA_GATEWAY_CONNECT_TIMEOUT")));
    request.on("error", rejectResponse);
    request.end(body);
  });
}

function safeGatewayCode(input: unknown): string {
  const parsed = gatewayErrorSchema.safeParse(input);
  if (!parsed.success || !parsed.data.error.code.startsWith("MEDIA_")) return "MEDIA_GATEWAY_UNAVAILABLE";
  return parsed.data.error.code;
}

export async function requestReadonlyMediaPlayback(
  options: ReadonlyMediaGatewayClientOptions,
  input: {
    principal_id: string;
    issuer_hash: string;
    project_id: string;
    binding: ReadonlyMediaBinding;
    snapshot_fingerprint: string;
  }
): Promise<ReadonlyMediaPlaybackGrant> {
  const origin = parseReadonlyMediaGatewayOrigin(options.origin);
  const endpoint = new URL(READONLY_MEDIA_CAPABILITY_PATH, origin);
  const envelope = createReadonlyMediaCapabilityRequest({
    principal_id: input.principal_id,
    issuer_hash: input.issuer_hash,
    project_id: input.project_id,
    artifact_id: input.binding.artifact_id,
    artifact_sha256: input.binding.sha256,
    snapshot_fingerprint: input.snapshot_fingerprint
  }, options.keyring, { now: options.now });
  const body = Buffer.from(JSON.stringify(envelope), "utf8");
  if (body.byteLength > READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES) throw new ReadonlyMediaGatewayClientError("MEDIA_CAPABILITY_INVALID");
  const signal = AbortSignal.timeout(READONLY_MEDIA_GATEWAY_REQUEST_TIMEOUT_MS);
  try {
    const addresses = await abortable(resolvePublicAddresses(endpoint.hostname, options.runtime?.resolve_hostname), signal);
    const response = await fetchFromValidatedAddresses(
      endpoint,
      signal,
      addresses,
      (url, requestSignal, address) => (options.runtime?.post_pinned_address ?? postPinnedJson)(url, requestSignal, address, body)
    );
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* preserve the redirect rejection */ }
      throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_UNAVAILABLE");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      try { await response.body?.cancel(); } catch { /* preserve the response contract failure */ }
      throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_RESPONSE_INVALID");
    }
    const bytes = await readBoundedBytes(response, READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES);
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch {
      throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_RESPONSE_INVALID");
    }
    if (response.status !== 201) throw new ReadonlyMediaGatewayClientError(safeGatewayCode(decoded));
    const result = READONLY_MEDIA_CAPABILITY_RESPONSE_SCHEMA.safeParse(decoded);
    if (!result.success) throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_RESPONSE_INVALID");
    const playbackUrl = new URL(`/media/v1/c/${result.data.capability_handle}`, origin).toString();
    return {
      state: "ready",
      kind: input.binding.artifact_type,
      mime_type: input.binding.mime_type,
      capability_expires_at: result.data.expires_at,
      session_max_seconds: READONLY_MEDIA_SESSION_MAX_SECONDS,
      snapshot_fingerprint: input.snapshot_fingerprint,
      playback_url: playbackUrl
    };
  } catch (error) {
    if (error instanceof ReadonlyMediaGatewayClientError) throw error;
    throw new ReadonlyMediaGatewayClientError("MEDIA_GATEWAY_UNAVAILABLE");
  }
}
