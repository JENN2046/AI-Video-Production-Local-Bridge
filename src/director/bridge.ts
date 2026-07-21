import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import { errorBody, requireScope, WebGptV4Error, type WebGptV4Actor } from "../webgpt-v4/types.js";
import {
  DIRECTOR_NATIVE_TOOL_CATALOG,
  DIRECTOR_NATIVE_TOOL_NAMES,
  type DirectorNativeToolHandlers,
  type DirectorNativeToolName
} from "./mcpContract.js";

export const DIRECTOR_BRIDGE_PROTOCOL_VERSION = "director-local-bridge-v1";
export const DIRECTOR_BRIDGE_DEFAULT_TIMEOUT_MS = 30_000;
export const DIRECTOR_BRIDGE_FRAME_TIMEOUT_MS = 130_000;
export const DIRECTOR_BRIDGE_MAX_BODY_BYTES = 24 * 1024 * 1024;

const idSchema = z.string().trim().min(1).max(160);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime();
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export interface DirectorBridgeKey {
  kid: string;
  key: Buffer;
}

export interface DirectorBridgeKeyring {
  active: DirectorBridgeKey;
}

const bridgeActorSchema = z.object({
  principal_id: hashSchema,
  actor_hash: hashSchema,
  issuer_hash: hashSchema,
  scopes: z.array(z.enum(["projects.read", "media.read", "proposals.write"])).max(3)
}).strict();

export const DIRECTOR_BRIDGE_REQUEST_SCHEMA = z.object({
  protocol_version: z.literal(DIRECTOR_BRIDGE_PROTOCOL_VERSION),
  request_id: idSchema,
  actor: bridgeActorSchema,
  tool: z.enum(DIRECTOR_NATIVE_TOOL_NAMES),
  input: z.unknown(),
  issued_at: timestampSchema,
  expires_at: timestampSchema
}).strict().superRefine((value, context) => {
  const issuedAt = Date.parse(value.issued_at);
  const expiresAt = Date.parse(value.expires_at);
  if (expiresAt <= issuedAt) {
    context.addIssue({ code: "custom", message: "Bridge request must expire after issuance.", path: ["expires_at"] });
  }
  const maximumLifetime = value.tool === "inspect_director_video_frames"
    ? DIRECTOR_BRIDGE_FRAME_TIMEOUT_MS
    : 60_000;
  if (expiresAt > issuedAt && expiresAt - issuedAt > maximumLifetime) {
    context.addIssue({ code: "custom", message: "Bridge request lifetime exceeds the protocol limit.", path: ["expires_at"] });
  }
});

export type DirectorBridgeRequest = z.infer<typeof DIRECTOR_BRIDGE_REQUEST_SCHEMA>;

export const DIRECTOR_BRIDGE_COMPLETION_SCHEMA = z.object({
  protocol_version: z.literal(DIRECTOR_BRIDGE_PROTOCOL_VERSION),
  request_id: idSchema,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().regex(/^[A-Z0-9_]{3,96}$/), message: z.string().max(1_024) }).strict().optional(),
  completed_at: timestampSchema
}).strict().superRefine((value, context) => {
  if (value.ok === (value.result === undefined) || value.ok === (value.error !== undefined)) {
    context.addIssue({ code: "custom", message: "Successful completions require only result; failures require only error.", path: ["ok"] });
  }
});

export type DirectorBridgeCompletion = z.infer<typeof DIRECTOR_BRIDGE_COMPLETION_SCHEMA>;

const bridgePollBodySchema = z.object({
  operation: z.literal("poll"),
  client_id: idSchema,
  issued_at: timestampSchema
}).strict();

export const DIRECTOR_BRIDGE_SIGNED_ENVELOPE_SCHEMA = z.object({
  protocol_version: z.literal(DIRECTOR_BRIDGE_PROTOCOL_VERSION),
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  nonce: nonceSchema,
  issued_at: timestampSchema,
  body: z.unknown(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

export type DirectorBridgeSignedEnvelope = z.infer<typeof DIRECTOR_BRIDGE_SIGNED_ENVELOPE_SCHEMA>;

export class DirectorBridgeError extends WebGptV4Error {}

function assertKey(key: DirectorBridgeKey): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key.kid) || key.key.byteLength !== 32) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_INVALID", "Director bridge authentication is not configured correctly.");
  }
}

export function assertDirectorBridgeKeyring(keyring: DirectorBridgeKeyring): void {
  assertKey(keyring.active);
}

function signatureInput(value: Omit<DirectorBridgeSignedEnvelope, "signature">): string {
  return canonicalizeJcs(value);
}

export function signDirectorBridgeBody(body: unknown, key: DirectorBridgeKey, now = new Date()): DirectorBridgeSignedEnvelope {
  assertKey(key);
  const unsigned = {
    protocol_version: DIRECTOR_BRIDGE_PROTOCOL_VERSION,
    kid: key.kid,
    nonce: randomBytes(32).toString("base64url"),
    issued_at: now.toISOString(),
    body
  } as const;
  const signature = createHmac("sha256", key.key).update(signatureInput(unsigned)).digest("base64url");
  return DIRECTOR_BRIDGE_SIGNED_ENVELOPE_SCHEMA.parse({ ...unsigned, signature });
}

export class DirectorBridgeReplayGuard {
  private readonly records = new Map<string, number>();

  constructor(private readonly maximum = 2_048) {}

  accept(nonce: string, expiresAt: number, now: number): void {
    for (const [tracked, expiry] of this.records) if (expiry <= now) this.records.delete(tracked);
    if (this.records.has(nonce)) throw new DirectorBridgeError("DIRECTOR_BRIDGE_REPLAYED", "Director bridge message was already used.");
    if (this.records.size >= this.maximum) throw new DirectorBridgeError("DIRECTOR_BRIDGE_BUSY", "Director bridge replay capacity is full.", undefined, true);
    this.records.set(nonce, expiresAt);
  }
}

export function verifyDirectorBridgeBody<T>(
  value: unknown,
  keyring: DirectorBridgeKeyring,
  bodySchema: z.ZodType<T>,
  replay: DirectorBridgeReplayGuard,
  now = new Date()
): T {
  assertDirectorBridgeKeyring(keyring);
  const parsedEnvelope = DIRECTOR_BRIDGE_SIGNED_ENVELOPE_SCHEMA.safeParse(value);
  if (!parsedEnvelope.success) throw new DirectorBridgeError("DIRECTOR_BRIDGE_AUTH_INVALID", "Director bridge authentication failed.");
  const envelope = parsedEnvelope.data;
  const key = envelope.kid === keyring.active.kid ? keyring.active : null;
  if (!key) throw new DirectorBridgeError("DIRECTOR_BRIDGE_AUTH_INVALID", "Director bridge authentication failed.");
  const issuedAt = Date.parse(envelope.issued_at);
  if (!Number.isFinite(issuedAt) || Math.abs(now.getTime() - issuedAt) > 60_000) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_AUTH_EXPIRED", "Director bridge authentication expired.");
  }
  const expected = createHmac("sha256", key.key).update(signatureInput({
    protocol_version: envelope.protocol_version, kid: envelope.kid, nonce: envelope.nonce,
    issued_at: envelope.issued_at, body: envelope.body
  })).digest();
  const actual = Buffer.from(envelope.signature, "base64url");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_AUTH_INVALID", "Director bridge authentication failed.");
  }
  const parsedBody = bodySchema.safeParse(envelope.body);
  if (!parsedBody.success) throw new DirectorBridgeError("DIRECTOR_BRIDGE_BODY_INVALID", "Director bridge message body is invalid.");
  replay.accept(envelope.nonce, now.getTime() + 2 * 60_000, now.getTime());
  return parsedBody.data;
}

interface PendingRequest {
  request: DirectorBridgeRequest;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export class DirectorBridgeBroker {
  private readonly queued: PendingRequest[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completionReplay = new DirectorBridgeReplayGuard();
  private lastPollAt = 0;

  constructor(
    private readonly keyring: DirectorBridgeKeyring,
    private readonly now: () => Date = () => new Date(),
    private readonly maximumPending = 32,
    private readonly maximumPerPrincipal = 4,
    private readonly timeoutMs = DIRECTOR_BRIDGE_DEFAULT_TIMEOUT_MS
  ) { assertDirectorBridgeKeyring(keyring); }

  connected(): boolean {
    return this.lastPollAt > 0 && this.now().getTime() - this.lastPollAt <= 30_000;
  }

  authenticatePoll(value: unknown, replay: DirectorBridgeReplayGuard): void {
    verifyDirectorBridgeBody(value, this.keyring, bridgePollBodySchema, replay, this.now());
    this.lastPollAt = this.now().getTime();
  }

  private removeQueued(requestId: string): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      if (this.queued[index]?.request.request_id === requestId) this.queued.splice(index, 1);
    }
  }

  poll(): DirectorBridgeSignedEnvelope | null {
    this.lastPollAt = this.now().getTime();
    while (this.queued.length > 0) {
      const item = this.queued.shift()!;
      if (this.pending.has(item.request.request_id)) {
        return signDirectorBridgeBody(item.request, this.keyring.active, this.now());
      }
    }
    return null;
  }

  submit(actor: WebGptV4Actor, tool: DirectorNativeToolName, input: unknown): Promise<unknown> {
    if (!actor.issuer_hash) return Promise.reject(new DirectorBridgeError("WEBGPT_PRINCIPAL_NOT_REGISTERED", "Director identity is not issuer-bound."));
    const perPrincipal = [...this.pending.values()].filter((item) => item.request.actor.principal_id === actor.principal_id).length;
    if (this.pending.size >= this.maximumPending || perPrincipal >= this.maximumPerPrincipal) {
      return Promise.reject(new DirectorBridgeError("DIRECTOR_BRIDGE_BUSY", "Director bridge request capacity is full.", undefined, true));
    }
    const issued = this.now();
    const requestTimeoutMs = tool === "inspect_director_video_frames"
      ? DIRECTOR_BRIDGE_FRAME_TIMEOUT_MS
      : this.timeoutMs;
    const request = DIRECTOR_BRIDGE_REQUEST_SCHEMA.parse({
      protocol_version: DIRECTOR_BRIDGE_PROTOCOL_VERSION,
      request_id: `director_bridge_${randomUUID()}`,
      actor: {
        principal_id: actor.principal_id, actor_hash: actor.actor_hash, issuer_hash: actor.issuer_hash,
        scopes: [...actor.scopes].filter((scope): scope is "projects.read" | "media.read" | "proposals.write" => ["projects.read", "media.read", "proposals.write"].includes(scope))
      },
      tool, input, issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + requestTimeoutMs).toISOString()
    });
    return new Promise((resolve, reject) => {
      const item: PendingRequest = {
        request, resolve, reject,
        timer: setTimeout(() => {
          this.pending.delete(request.request_id);
          this.removeQueued(request.request_id);
          reject(new DirectorBridgeError("DIRECTOR_BRIDGE_TIMEOUT", "Local Director bridge did not respond in time.", undefined, true));
        }, requestTimeoutMs)
      };
      this.pending.set(request.request_id, item);
      this.queued.push(item);
    });
  }

  complete(value: unknown): void {
    const completion = verifyDirectorBridgeBody(value, this.keyring, DIRECTOR_BRIDGE_COMPLETION_SCHEMA, this.completionReplay, this.now());
    const pending = this.pending.get(completion.request_id);
    if (!pending) throw new DirectorBridgeError("DIRECTOR_BRIDGE_REQUEST_NOT_FOUND", "Director bridge request is no longer pending.");
    clearTimeout(pending.timer);
    this.pending.delete(completion.request_id);
    if (completion.ok) pending.resolve(completion.result);
    else pending.reject(new DirectorBridgeError(completion.error!.code, completion.error!.message));
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DirectorBridgeError("DIRECTOR_BRIDGE_CLOSED", "Director bridge is stopping."));
    }
    this.pending.clear();
    this.queued.length = 0;
  }
}

export interface DirectorLocalBridgeClientOptions {
  remote_origin: string;
  client_id: string;
  keyring: DirectorBridgeKeyring;
  handlers: (actor: WebGptV4Actor) => DirectorNativeToolHandlers;
  fetch?: typeof fetch;
  now?: () => Date;
}

async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new DirectorBridgeError("DIRECTOR_BRIDGE_RESPONSE_TOO_LARGE", "Director bridge response exceeded its size limit.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

async function boundedNetworkOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof DirectorBridgeError) throw error;
    if (controller.signal.aborted) {
      throw new DirectorBridgeError("DIRECTOR_BRIDGE_NETWORK_TIMEOUT", "Director bridge network request timed out.", undefined, true);
    }
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_NETWORK_FAILED", "Director bridge network request failed.", undefined, true);
  } finally {
    clearTimeout(timeout);
  }
}

export class DirectorLocalBridgeClient {
  private readonly requestReplay = new DirectorBridgeReplayGuard();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: DirectorLocalBridgeClientOptions) {
    assertDirectorBridgeKeyring(options.keyring);
    const origin = new URL(options.remote_origin);
    const localHttp = origin.protocol === "http:"
      && (origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
    if (origin.protocol !== "https:" && !localHttp) {
      throw new DirectorBridgeError("DIRECTOR_BRIDGE_ORIGIN_INVALID", "Director bridge origin must use HTTPS.");
    }
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      throw new DirectorBridgeError("DIRECTOR_BRIDGE_ORIGIN_INVALID", "Director bridge origin must be an exact credential-free origin.");
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<boolean> {
    const poll = signDirectorBridgeBody({ operation: "poll", client_id: this.options.client_id, issued_at: this.now().toISOString() }, this.options.keyring.active, this.now());
    const { response, encoded } = await boundedNetworkOperation(async (signal) => {
      const response = await this.fetchImpl(new URL("/director/bridge/v1/poll", this.options.remote_origin), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(poll), redirect: "manual", signal
      });
      const encoded = response.status === 200 ? await boundedResponseText(response, DIRECTOR_BRIDGE_MAX_BODY_BYTES) : "";
      return { response, encoded };
    });
    if (response.status === 204) return false;
    if (response.status !== 200) throw new DirectorBridgeError("DIRECTOR_BRIDGE_POLL_FAILED", "Director bridge poll failed.", undefined, true);
    let decoded: unknown;
    try { decoded = JSON.parse(encoded) as unknown; }
    catch { throw new DirectorBridgeError("DIRECTOR_BRIDGE_RESPONSE_INVALID", "Director bridge response was malformed."); }
    const request = verifyDirectorBridgeBody(decoded, this.options.keyring, DIRECTOR_BRIDGE_REQUEST_SCHEMA, this.requestReplay, this.now());
    let completion: DirectorBridgeCompletion;
    try {
      if (Date.parse(request.expires_at) <= this.now().getTime()) throw new DirectorBridgeError("DIRECTOR_BRIDGE_REQUEST_EXPIRED", "Director bridge request expired.");
      const actor: WebGptV4Actor = {
        principal_id: request.actor.principal_id, actor_hash: request.actor.actor_hash,
        issuer_hash: request.actor.issuer_hash, scopes: new Set(request.actor.scopes)
      };
      const catalog = DIRECTOR_NATIVE_TOOL_CATALOG.find((entry) => entry.name === request.tool)!;
      for (const scope of catalog.scope) requireScope(actor, scope);
      const input = catalog.input.parse(request.input);
      const result = await this.options.handlers(actor)[request.tool](input as never);
      completion = DIRECTOR_BRIDGE_COMPLETION_SCHEMA.parse({
        protocol_version: DIRECTOR_BRIDGE_PROTOCOL_VERSION, request_id: request.request_id,
        ok: true, result, completed_at: this.now().toISOString()
      });
    } catch (error) {
      const safe = errorBody(error);
      completion = DIRECTOR_BRIDGE_COMPLETION_SCHEMA.parse({
        protocol_version: DIRECTOR_BRIDGE_PROTOCOL_VERSION, request_id: request.request_id,
        ok: false, error: { code: safe.code, message: safe.message }, completed_at: this.now().toISOString()
      });
    }
    const completed = signDirectorBridgeBody(completion, this.options.keyring.active, this.now());
    const completedResponse = await boundedNetworkOperation((signal) => this.fetchImpl(
      new URL("/director/bridge/v1/complete", this.options.remote_origin),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completed), redirect: "manual", signal }
    ));
    if (completedResponse.status !== 202) throw new DirectorBridgeError("DIRECTOR_BRIDGE_COMPLETE_FAILED", "Director bridge completion was not accepted.", undefined, true);
    return true;
  }
}
