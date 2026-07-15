import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export interface PinnedNetworkAddress {
  address: string;
  family: 4 | 6;
}

export interface PinnedHttpsRuntime {
  resolve_hostname?: (hostname: string) => Promise<PinnedNetworkAddress[]>;
  fetch_pinned_address?: (url: URL, signal: AbortSignal, address: PinnedNetworkAddress, headers?: Headers) => Promise<Response>;
}

export type PinnedHttpsErrorCode = "UNSAFE_NETWORK_TARGET" | "FETCH_FAILED" | "RESPONSE_TOO_LARGE";

export class PinnedHttpsError extends Error {
  constructor(readonly code: PinnedHttpsErrorCode) {
    super(code);
    this.name = "PinnedHttpsError";
  }
}

const BLOCKED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96],
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
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

export function isUnsafeNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return true;
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)?.[1];
  if (mappedIpv4) return isUnsafeNetworkHost(mappedIpv4);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isUnsafeNetworkHost(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  if (isIP(host) === 6) return BLOCKED_IPV6.check(host, "ipv6");

  const ipv4 = ipv4ToNumber(host);
  if (ipv4 === null) return false;
  const first = (ipv4 >>> 24) & 0xff;
  const second = (ipv4 >>> 16) & 0xff;
  const third = (ipv4 >>> 8) & 0xff;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 0 && third === 0) return true;
  if (first === 192 && second === 0 && third === 2) return true;
  if (first === 192 && second === 88 && third === 99) return true;
  if (first === 192 && second === 168) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  if (first >= 224) return true;
  return false;
}

export function assertSafeHttpsUrl(url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password || url.hash || isUnsafeNetworkHost(url.hostname)) {
    throw new PinnedHttpsError("UNSAFE_NETWORK_TARGET");
  }
}

export async function resolvePublicAddresses(
  hostname: string,
  resolver: (hostname: string) => Promise<PinnedNetworkAddress[]> = async (name) => {
    const result = await lookup(name, { all: true, verbatim: true });
    return result.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  }
): Promise<PinnedNetworkAddress[]> {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(normalizedHostname);
  let addresses: PinnedNetworkAddress[];
  try {
    addresses = literalFamily
      ? [{ address: normalizedHostname, family: literalFamily as 4 | 6 }]
      : await resolver(normalizedHostname);
  } catch (error) {
    if (error instanceof PinnedHttpsError) throw error;
    throw new PinnedHttpsError("FETCH_FAILED");
  }
  if (addresses.length === 0 || addresses.some((candidate) => {
    const actualFamily = isIP(candidate.address);
    return actualFamily !== candidate.family || isUnsafeNetworkHost(candidate.address);
  })) {
    throw new PinnedHttpsError("UNSAFE_NETWORK_TARGET");
  }
  return addresses;
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return await new Promise<T>((resolveValue, rejectValue) => {
    const abort = (): void => rejectValue(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolveValue, rejectValue).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createPinnedLookup(address: PinnedNetworkAddress): (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, result: string | LookupAddress[], family?: number) => void
) => void {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

const SAFE_OUTBOUND_HEADERS = new Set([
  "accept",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "user-agent"
]);

export function safePinnedRequestHeaders(input: Headers = new Headers()): Headers {
  const output = new Headers();
  for (const [name, value] of input.entries()) {
    if (SAFE_OUTBOUND_HEADERS.has(name.toLowerCase())) output.append(name, value);
  }
  return output;
}

export async function pinnedHttpsFetch(
  url: URL,
  signal: AbortSignal,
  address: PinnedNetworkAddress,
  headers: Headers = new Headers()
): Promise<Response> {
  return await new Promise<Response>((resolveResponse, rejectResponse) => {
    const safeHeaders = safePinnedRequestHeaders(headers);
    const request = httpsRequest(url, {
      method: "GET",
      signal,
      lookup: createPinnedLookup(address),
      headers: Object.fromEntries(safeHeaders.entries())
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

export async function fetchFromValidatedAddresses(
  url: URL,
  signal: AbortSignal,
  addresses: PinnedNetworkAddress[],
  fetchAddress: (url: URL, signal: AbortSignal, address: PinnedNetworkAddress, headers?: Headers) => Promise<Response> = pinnedHttpsFetch,
  headers: Headers = new Headers()
): Promise<Response> {
  let lastError: unknown = new PinnedHttpsError("FETCH_FAILED");
  for (const address of addresses) {
    try {
      return await fetchAddress(url, signal, address, headers);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export async function fetchPinnedHttps(
  url: URL,
  signal: AbortSignal,
  runtime: PinnedHttpsRuntime = {},
  headers: Headers = new Headers()
): Promise<Response> {
  assertSafeHttpsUrl(url);
  const addresses = await abortable(resolvePublicAddresses(url.hostname, runtime.resolve_hostname), signal);
  const safeHeaders = safePinnedRequestHeaders(headers);
  try {
    return await fetchFromValidatedAddresses(url, signal, addresses, runtime.fetch_pinned_address, safeHeaders);
  } catch (error) {
    if (error instanceof PinnedHttpsError || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new PinnedHttpsError("FETCH_FAILED");
  }
}

export async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* preserve the bounded-size failure */ }
    throw new PinnedHttpsError("RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the bounded-size failure */ }
        throw new PinnedHttpsError("RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export function createBoundedPinnedFetch(
  runtime: PinnedHttpsRuntime = {},
  options: { max_bytes: number; timeout_ms: number }
): (url: string, init: { headers: Headers; method: "GET"; redirect: "manual"; signal: AbortSignal }) => Promise<Response> {
  return async (url, init) => {
    if (init.method !== "GET" || init.redirect !== "manual") throw new PinnedHttpsError("FETCH_FAILED");
    const response = await fetchPinnedHttps(new URL(url), withTimeout(init.signal, options.timeout_ms), runtime, init.headers);
    const body = await readBoundedBytes(response, options.max_bytes);
    if ([204, 205, 304].includes(response.status)) {
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);
    return new Response(copy.buffer, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
