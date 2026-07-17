import { createHash, randomUUID } from "node:crypto";

export const WEBGPT_V4_VERSION = "webgpt-v4.3.0";

export const WEBGPT_V4_SCOPES = [
  "projects.read",
  "media.read",
  "shots.write",
  "reviews.write",
  "proposals.write",
  "generation.prepare"
] as const;

export type WebGptV4Scope = typeof WEBGPT_V4_SCOPES[number];

export interface WebGptV4Actor {
  principal_id: string;
  actor_hash: string;
  scopes: ReadonlySet<string>;
  issuer_hash?: string;
}

export interface WebGptV4Meta {
  request_id: string;
  source_version: typeof WEBGPT_V4_VERSION;
  updated_at: string;
  idempotent_replay?: boolean;
}

export interface WebGptV4ErrorBody {
  code: string;
  message: string;
  field?: string;
  retryable?: boolean;
  suggested_parameters?: {
    detail?: "compact";
    limit?: number;
    notes_limit?: number;
  };
}

export type WebGptV4Result<T> =
  | { ok: true; data: T; meta: WebGptV4Meta }
  | { ok: false; error: WebGptV4ErrorBody; meta: WebGptV4Meta };

export class WebGptV4Error extends Error {
  constructor(readonly code: string, message: string, readonly field?: string, readonly retryable = false) {
    super(message);
  }
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function actorFromSubject(subject: string, scopes: Iterable<string>): WebGptV4Actor {
  const principalId = sha256(subject);
  return { principal_id: principalId, actor_hash: principalId, scopes: new Set(scopes) };
}

export function principalIdFromFederatedSubject(issuer: string, subject: string): string {
  const normalizedIssuer = normalizeFederatedIssuer(issuer);
  return sha256(`${normalizedIssuer}\0${sha256(subject)}`);
}

export function normalizeFederatedIssuer(issuer: string): string {
  return `${issuer.trim().replace(/\/+$/, "")}/`;
}

export function issuerHash(issuer: string): string {
  return sha256(normalizeFederatedIssuer(issuer));
}

export function actorFromFederatedSubject(issuer: string, subject: string, scopes: Iterable<string>): WebGptV4Actor {
  const principalId = principalIdFromFederatedSubject(issuer, subject);
  return { principal_id: principalId, actor_hash: principalId, issuer_hash: issuerHash(issuer), scopes: new Set(scopes) };
}

export function requestId(value?: string): string {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.length <= 128 ? normalized : `webgpt_request_${randomUUID()}`;
}

export function resultMeta(id: string, updatedAt = new Date().toISOString()): WebGptV4Meta {
  return { request_id: id, source_version: WEBGPT_V4_VERSION, updated_at: updatedAt };
}

export function ok<T>(id: string, data: T, updatedAt?: string): WebGptV4Result<T> {
  return { ok: true, data, meta: resultMeta(id, updatedAt) };
}

export function fail<T = never>(id: string, error: WebGptV4ErrorBody): WebGptV4Result<T> {
  return { ok: false, error, meta: resultMeta(id) };
}

export function errorBody(error: unknown): WebGptV4ErrorBody {
  if (error instanceof WebGptV4Error) {
    return { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}), ...(error.retryable ? { retryable: true } : {}) };
  }
  return { code: "WEBGPT_V4_INTERNAL_ERROR", message: "WebGPT V4 could not complete the request." };
}

export function requireScope(actor: WebGptV4Actor, scope: WebGptV4Scope): void {
  if (!actor.scopes.has(scope)) throw new WebGptV4Error("INSUFFICIENT_SCOPE", `Required scope is missing: ${scope}`);
}
