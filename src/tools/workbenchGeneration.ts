import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getGenerationRun, saveGenerationRun, type GenerationRun } from "./generation.js";
import { getMediaArtifact, type MediaArtifact } from "./mediaArtifacts.js";
import { providerError, selectM1ProviderPort, type ProviderToolError } from "./provider.js";
import { downloadProviderOutputToArtifact } from "./providerOutputDownloader.js";
import { getProject, getShot, saveProject, saveShot } from "./projects.js";
import {
  buildRunningHubImageToVideoSubmitRequest,
  mapRunningHubProviderError,
  RUNNINGHUB_API_BASE_URL,
  RUNNINGHUB_DEFAULT_RESOLUTION,
  RUNNINGHUB_MODEL_ROUTE,
  RunningHubVideoProviderAdapter,
  type ProviderGenerationInput,
  type VideoProviderAdapter
} from "./videoProviderAdapters.js";
import { assertWorkbenchProjectWritable, type WorkbenchV2Result } from "./workbenchV2.js";

export type WorkbenchGenerationIntentStatus = "prepared" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export interface WorkbenchGenerationIntent {
  intent_id: string;
  run_id: string;
  project_id: string;
  shot_id: string;
  provider: "runninghub";
  account_label: "personal" | "team";
  model: string;
  input_artifact_id: string;
  duration_seconds: number;
  resolution: string;
  estimated_cost_value: number;
  budget_limit_value: number;
  currency: string;
  confirmed: boolean;
  expires_at: string;
  provider_task_id: string;
  status: WorkbenchGenerationIntentStatus;
  upload_attempts: number;
  submit_attempts: number;
  output_artifact_id: string;
  sanitized_error: Record<string, unknown>;
  input_snapshot: {
    video_prompt: string;
    negative_prompt: string;
    aspect_ratio: string;
    price_source: "runninghub_price_preview" | "local_verified_cache";
    balance_gate: "pass" | "not_checked";
    requires_human_preflight?: boolean;
    prepared_by?: "human_workbench" | "webgpt_v4";
  };
  created_at: string;
  updated_at: string;
}

interface GenerationIntentRow {
  intent_id: string;
  run_id: string | null;
  project_id: string;
  shot_id: string;
  provider: "runninghub";
  account_label: "personal" | "team";
  model: string;
  input_artifact_id: string;
  duration_seconds: number;
  resolution: string;
  estimated_cost_value: number;
  budget_limit_value: number;
  currency: string;
  confirmed: number;
  expires_at: string;
  provider_task_id: string;
  status: WorkbenchGenerationIntentStatus;
  upload_attempts: number;
  submit_attempts: number;
  output_artifact_id: string;
  sanitized_error_json: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkbenchGenerationDependencies {
  env?: NodeJS.ProcessEnv;
  fetch_impl?: typeof fetch;
  adapter_factory?: (credential: string) => VideoProviderAdapter;
  now?: () => Date;
  poll_interval_ms?: number;
  timeout_ms?: number;
}

export type GenerationJobState = "queued" | "submitting" | "polling" | "downloading" | "finalizing" | "manual_reconciliation" | "succeeded" | "failed" | "cancelled";

export interface GenerationJob {
  job_id: string;
  intent_id: string;
  state: GenerationJobState;
  reconciliation_reason: string;
  lease_expires_at: string | null;
}

const activeExecutions = new Map<string, Promise<void>>();

class GenerationJobLeaseLostError extends Error {
  constructor() {
    super("Generation job lease was lost before the worker could write its result.");
    this.name = "GenerationJobLeaseLostError";
  }
}

function jobForIntent(db: M0Database, intentId: string): GenerationJob | null {
  const row = db.prepare("SELECT job_id, intent_id, state, reconciliation_reason, lease_expires_at FROM generation_jobs WHERE intent_id = ?").get(intentId) as GenerationJob | undefined;
  return row ?? null;
}

function appendJobEvent(db: M0Database, jobId: string, fromState: string, toState: GenerationJobState, reasonCode = "", data: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO generation_job_events (event_id, job_id, from_state, to_state, reason_code, data_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`job_event_${randomUUID()}`, jobId, fromState, toState, reasonCode, JSON.stringify(data));
}

function setJobState(db: M0Database, job: GenerationJob, state: GenerationJobState, reasonCode = ""): GenerationJob {
  db.prepare("UPDATE generation_jobs SET state = ?, reconciliation_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?")
    .run(state, reasonCode, job.job_id);
  appendJobEvent(db, job.job_id, job.state, state, reasonCode);
  return { ...job, state, reconciliation_reason: reasonCode };
}

function claimJob(db: M0Database, intentId: string, owner: string, token: string): GenerationJob | null {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = jobForIntent(db, intentId);
    if (!job || ["succeeded", "failed", "cancelled", "manual_reconciliation"].includes(job.state)) {
      db.exec("ROLLBACK");
      return null;
    }
    const result = db.prepare(`UPDATE generation_jobs SET lease_owner = ?, lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND (lease_token = '' OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP)`).run(owner, token, expiresAt, job.job_id) as { changes: number | bigint };
    if (Number(result.changes) !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    db.exec("COMMIT");
    return { ...job, lease_expires_at: expiresAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function releaseJobLease(db: M0Database, jobId: string, token: string): void {
  db.prepare("UPDATE generation_jobs SET lease_owner = '', lease_token = '', lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND lease_token = ?").run(jobId, token);
}

function assertJobLease(db: M0Database, jobId: string, token: string): void {
  const row = db.prepare(`SELECT 1 AS valid FROM generation_jobs
    WHERE job_id = ? AND lease_token = ? AND lease_expires_at IS NOT NULL
      AND datetime(lease_expires_at) > CURRENT_TIMESTAMP`).get(jobId, token) as { valid: number } | undefined;
  if (!row) throw new GenerationJobLeaseLostError();
}

function dateNow(dependencies: WorkbenchGenerationDependencies): Date {
  return dependencies.now?.() ?? new Date();
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function intentFromRow(row: GenerationIntentRow): WorkbenchGenerationIntent {
  const data = parseRecord(row.data_json);
  const fallbackSnapshot: WorkbenchGenerationIntent["input_snapshot"] = {
    video_prompt: "",
    negative_prompt: "",
    aspect_ratio: "",
    price_source: "runninghub_price_preview",
    balance_gate: "pass"
  };
  const snapshot = data.input_snapshot && typeof data.input_snapshot === "object" && !Array.isArray(data.input_snapshot)
    ? data.input_snapshot as WorkbenchGenerationIntent["input_snapshot"]
    : fallbackSnapshot;
  return {
    intent_id: row.intent_id,
    run_id: row.run_id ?? "",
    project_id: row.project_id,
    shot_id: row.shot_id,
    provider: row.provider,
    account_label: row.account_label,
    model: row.model,
    input_artifact_id: row.input_artifact_id,
    duration_seconds: row.duration_seconds,
    resolution: row.resolution,
    estimated_cost_value: row.estimated_cost_value,
    budget_limit_value: row.budget_limit_value,
    currency: row.currency,
    confirmed: row.confirmed === 1,
    expires_at: row.expires_at,
    provider_task_id: row.provider_task_id,
    status: row.status,
    upload_attempts: row.upload_attempts,
    submit_attempts: row.submit_attempts,
    output_artifact_id: row.output_artifact_id,
    sanitized_error: parseRecord(row.sanitized_error_json),
    input_snapshot: snapshot,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function getIntent(db: M0Database, intentId: string): WorkbenchGenerationIntent | null {
  const row = db.prepare("SELECT * FROM generation_intents WHERE intent_id = ?").get(intentId) as GenerationIntentRow | undefined;
  return row ? intentFromRow(row) : null;
}

function sanitizedError(error: ProviderToolError | { code: string; message: string; retryable?: boolean }): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable === true,
    ...("sanitized_provider_error_summary" in error && error.sanitized_provider_error_summary
      ? { provider: error.sanitized_provider_error_summary }
      : {})
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  credential: string,
  dependencies: WorkbenchGenerationDependencies
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: ProviderToolError }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, dependencies.timeout_ms ?? 60_000));
  try {
    const response = await (dependencies.fetch_impl ?? fetch)(url, { ...init, signal: controller.signal });
    let payload: Record<string, unknown> = {};
    try {
      const parsed = await response.json() as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (!response.ok) return { ok: false, error: mapRunningHubProviderError({ http_status: response.status, payload, secrets: [credential] }) };
    return { ok: true, payload };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { ok: false, error: providerError("PROVIDER_TIMEOUT", "RunningHub preflight timed out.", true) };
    return { ok: false, error: providerError("PROVIDER_REQUEST_FAILED", "RunningHub preflight failed.", true) };
  } finally {
    clearTimeout(timeout);
  }
}

function numericField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export async function preflightWorkbenchGeneration(
  input: { project_id: string; shot_id: string; account_label: "personal" | "team"; budget_limit_value: number },
  db = openM0Database(),
  dependencies: WorkbenchGenerationDependencies = {}
): Promise<WorkbenchV2Result<{ intent: WorkbenchGenerationIntent }>> {
  const writable = assertWorkbenchProjectWritable(db, input.project_id);
  if (!writable.ok) return writable;
  const shot = getShot(db, input.shot_id);
  if (!shot || shot.project_id !== input.project_id) return { ok: false, error: { code: "SHOT_NOT_FOUND", message: "SHOT does not belong to this project.", field: "shot_id" } };
  if (shot.status !== "storyboard_approved" && shot.status !== "revision_needed") {
    return { ok: false, error: { code: "SHOT_NOT_APPROVED", message: "Storyboard approval is required before generation." } };
  }
  if (!Number.isFinite(input.budget_limit_value) || input.budget_limit_value <= 0) {
    return { ok: false, error: { code: "BUDGET_LIMIT_REQUIRED", message: "A positive budget limit is required.", field: "budget_limit_value" } };
  }
  const active = db.prepare("SELECT intent_id FROM generation_intents WHERE status IN ('queued', 'running') LIMIT 1").get() as { intent_id: string } | undefined;
  if (active) return { ok: false, error: { code: "REAL_GENERATION_ALREADY_ACTIVE", message: "Only one real generation task may run at a time." } };
  const artifact = getMediaArtifact(db, shot.storyboard_image_artifact_id);
  if (!artifact || artifact.status !== "active" || artifact.artifact_type !== "image") {
    return { ok: false, error: { code: "ARTIFACT_NOT_FOUND", message: "An active storyboard image is required." } };
  }

  const selection = selectM1ProviderPort({ provider: "real", provider_name: "runninghub", model_name: RUNNINGHUB_MODEL_ROUTE, cost_acknowledged: true }, dependencies.env ?? process.env);
  if (!selection.ok) return { ok: false, error: selection.error };
  if (selection.selected.provider_name !== "runninghub" || !selection.selected.credential) {
    return { ok: false, error: { code: "PROVIDER_SELECTION_MISMATCH", message: "RunningHub must be the selected real provider." } };
  }
  const providerResolution = writable.data.project.video_spec.resolution.includes("x") ? RUNNINGHUB_DEFAULT_RESOLUTION : writable.data.project.video_spec.resolution;
  const generationInput: ProviderGenerationInput = {
    storyboard_artifact: artifact,
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    duration_seconds: shot.duration_seconds,
    aspect_ratio: writable.data.project.video_spec.aspect_ratio,
    resolution: providerResolution
  };
  const priceRequest = buildRunningHubImageToVideoSubmitRequest({ generation_input: generationInput, uploaded_download_url: "https://example.invalid/input.png" });
  if (!priceRequest.ok) return { ok: false, error: priceRequest.error };
  const credential = selection.selected.credential;
  const price = await fetchJson(`${RUNNINGHUB_API_BASE_URL}/openapi/v2/price-preview/${RUNNINGHUB_MODEL_ROUTE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify(priceRequest.body)
  }, credential, dependencies);
  if (!price.ok) return { ok: false, error: price.error };
  const estimatedPrice = numericField(price.payload, "estimatedPrice");
  const currency = typeof price.payload.currency === "string" ? price.payload.currency : "";
  const errorCode = typeof price.payload.errorCode === "string" ? price.payload.errorCode : "";
  if (errorCode || estimatedPrice === null || !currency) {
    return { ok: false, error: { code: "PRICE_ESTIMATE_UNAVAILABLE", message: "Official RunningHub price estimate was unavailable." } };
  }
  if (estimatedPrice > input.budget_limit_value) {
    return { ok: false, error: { code: "BUDGET_LIMIT_EXCEEDED", message: `Estimated cost ${estimatedPrice} ${currency} exceeds the budget limit.` } };
  }

  const account = await fetchJson(`${RUNNINGHUB_API_BASE_URL}/uc/openapi/accountStatus`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: credential })
  }, credential, dependencies);
  if (!account.ok) return { ok: false, error: account.error };
  const accountData = account.payload.data && typeof account.payload.data === "object" && !Array.isArray(account.payload.data)
    ? account.payload.data as Record<string, unknown>
    : {};
  const accountCurrency = typeof accountData.currency === "string" ? accountData.currency : "";
  const remainingMoney = numericField(accountData, "remainMoney");
  const remainingCoins = numericField(accountData, "remainCoins");
  const balanceEnough = currency === accountCurrency && remainingMoney !== null
    ? remainingMoney >= estimatedPrice
    : currency.toUpperCase().includes("COIN") && remainingCoins !== null
      ? remainingCoins >= estimatedPrice
      : false;
  if (!balanceEnough) return { ok: false, error: { code: "BALANCE_GATE_UNKNOWN_OR_INSUFFICIENT", message: "RunningHub balance could not be verified as sufficient." } };

  const createdAt = dateNow(dependencies);
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);
  const intentId = `intent_${randomUUID()}`;
  const inputSnapshot: WorkbenchGenerationIntent["input_snapshot"] = {
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    aspect_ratio: writable.data.project.video_spec.aspect_ratio,
    price_source: "runninghub_price_preview",
    balance_gate: "pass",
    requires_human_preflight: false,
    prepared_by: "human_workbench"
  };
  db.prepare(`
    INSERT INTO webgpt_provider_price_cache (
      provider, model, duration_seconds, resolution, estimated_cost_value, currency,
      source, fetched_at, expires_at
    ) VALUES ('runninghub', ?, ?, ?, ?, ?, 'human_workbench_official_preflight', ?, ?)
    ON CONFLICT(provider, model, duration_seconds, resolution) DO UPDATE SET
      estimated_cost_value = excluded.estimated_cost_value,
      currency = excluded.currency,
      source = excluded.source,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(
    RUNNINGHUB_MODEL_ROUTE,
    shot.duration_seconds,
    providerResolution,
    estimatedPrice,
    currency,
    createdAt.toISOString(),
    new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
  );
  db.prepare(`
    INSERT INTO generation_intents (
      intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
      duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
      confirmed, expires_at, status, data_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'runninghub', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'prepared', ?, ?, ?)
  `).run(
    intentId, input.project_id, input.shot_id, input.account_label, RUNNINGHUB_MODEL_ROUTE, artifact.artifact_id,
    shot.duration_seconds, providerResolution, estimatedPrice, input.budget_limit_value, currency,
    expiresAt.toISOString(), JSON.stringify({ input_snapshot: inputSnapshot }), createdAt.toISOString(), createdAt.toISOString()
  );
  return { ok: true, data: { intent: getIntent(db, intentId) as WorkbenchGenerationIntent } };
}

export function confirmWorkbenchGeneration(
  input: { intent_id: string; budget_limit_value: number; cost_confirmed: boolean; human_confirmation: boolean },
  db = openM0Database(),
  dependencies: WorkbenchGenerationDependencies = {}
): WorkbenchV2Result<{ intent: WorkbenchGenerationIntent; run_id: string; job_id: string; status: "queued" }> {
  if (input.cost_confirmed !== true || input.human_confirmation !== true) {
    return { ok: false, error: { code: "GENERATION_CONFIRMATION_REQUIRED", message: "Cost and generation confirmation are required." } };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const intent = getIntent(db, input.intent_id);
    if (!intent) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_NOT_FOUND", message: "Generation intent was not found." } };
    }
    if (intent.status !== "prepared") {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_NOT_PREPARED", message: "Generation intent is not prepared." } };
    }
    if (intent.input_snapshot.requires_human_preflight === true || intent.input_snapshot.balance_gate !== "pass") {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "OFFICIAL_PREFLIGHT_REQUIRED", message: "Run a fresh official preflight in the human workbench before confirmation." } };
    }
    if (dateNow(dependencies).getTime() >= Date.parse(intent.expires_at)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_EXPIRED", message: "Generation preflight has expired." } };
    }
    if (!Number.isFinite(input.budget_limit_value) || input.budget_limit_value < intent.estimated_cost_value) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "BUDGET_LIMIT_EXCEEDED", message: "Budget limit is below the official estimate." } };
    }
    const active = db.prepare("SELECT intent_id FROM generation_intents WHERE status IN ('queued', 'running') LIMIT 1").get() as { intent_id: string } | undefined;
    if (active) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "REAL_GENERATION_ALREADY_ACTIVE", message: "Only one real generation task may run at a time." } };
    }
    const writable = assertWorkbenchProjectWritable(db, intent.project_id);
    if (!writable.ok) {
      db.exec("ROLLBACK");
      return writable;
    }
    const shot = getShot(db, intent.shot_id);
    if (!shot || shot.project_id !== intent.project_id) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "SHOT_NOT_FOUND", message: "SHOT was not found in the selected project." } };
    }
    const runId = `run_${randomUUID()}`;
    const run: GenerationRun = {
      run_id: runId,
      batch_id: "",
      project_id: intent.project_id,
      shot_id: intent.shot_id,
      run_type: "image_to_video",
      status: "queued",
      input: {
        storyboard_image_artifact_id: intent.input_artifact_id,
        video_prompt: intent.input_snapshot.video_prompt,
        negative_prompt: intent.input_snapshot.negative_prompt,
        duration_seconds: intent.duration_seconds,
        aspect_ratio: intent.input_snapshot.aspect_ratio,
        resolution: intent.resolution
      },
      output: { artifact_ids: [] },
      provider: { provider: "real", provider_name: "runninghub", model_name: intent.model, provider_job_id: "", provider_status: "not_submitted" },
      versioning: { attempt_number: shot.clip_versions.length + 1, parent_run_id: shot.generation_run_ids.at(-1) ?? "" },
      error: { code: "", message: "", retryable: false }
    };
    saveGenerationRun(db, run);
    shot.generation_run_ids.push(runId);
    shot.status = "video_pending";
    saveShot(db, shot);
    writable.data.project.status = "video_generation_in_progress";
    saveProject(db, writable.data.project);
    db.prepare(`
      UPDATE generation_intents
      SET run_id = ?, confirmed = 1, budget_limit_value = ?, status = 'queued',
        upload_attempts = 1, submit_attempts = 1, updated_at = CURRENT_TIMESTAMP
      WHERE intent_id = ?
    `).run(runId, input.budget_limit_value, intent.intent_id);
    const jobId = `job_${randomUUID()}`;
    db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')").run(jobId, intent.intent_id);
    appendJobEvent(db, jobId, "", "queued", "HUMAN_CONFIRMED");
    db.exec("COMMIT");
    return { ok: true, data: { intent: getIntent(db, intent.intent_id) as WorkbenchGenerationIntent, run_id: runId, job_id: jobId, status: "queued" } };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function failIntent(db: M0Database, intent: WorkbenchGenerationIntent, status: "failed" | "timeout", error: ProviderToolError | { code: string; message: string; retryable?: boolean }): void {
  const safe = sanitizedError(error);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE generation_intents SET status = ?, sanitized_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?")
      .run(status, JSON.stringify(safe), intent.intent_id);
    if (intent.run_id) {
      const run = getGenerationRun(db, intent.run_id);
      if (run) {
        run.status = "failed";
        run.error = { code: String(safe.code ?? "PROVIDER_REQUEST_FAILED"), message: String(safe.message ?? "Generation failed."), retryable: safe.retryable === true };
        saveGenerationRun(db, run);
      }
    }
    const job = jobForIntent(db, intent.intent_id);
    if (job) setJobState(db, job, "failed", String(safe.code ?? "PROVIDER_REQUEST_FAILED"));
    db.exec("COMMIT");
  } catch (failure) {
    db.exec("ROLLBACK");
    throw failure;
  }
}

function existingOutputArtifact(db: M0Database, providerTaskId: string): MediaArtifact | null {
  const row = db.prepare("SELECT data_json FROM media_artifacts WHERE json_extract(data_json, '$.source.provider_job_id') = ? LIMIT 1").get(providerTaskId) as { data_json: string } | undefined;
  return row ? JSON.parse(row.data_json) as MediaArtifact : null;
}

async function executeIntent(intentId: string, allowSubmit: boolean, dependencies: WorkbenchGenerationDependencies): Promise<void> {
  const db = openM0Database();
  const leaseOwner = `worker_${process.pid}`;
  const leaseToken = randomUUID();
  let job = claimJob(db, intentId, leaseOwner, leaseToken);
  if (!job) {
    db.close();
    return;
  }
  const heartbeat = setInterval(() => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    db.prepare("UPDATE generation_jobs SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND lease_token = ?").run(expiresAt, job?.job_id, leaseToken);
  }, 30_000);
  try {
    let intent = getIntent(db, intentId);
    if (!intent || (intent.status !== "queued" && intent.status !== "running")) return;
    const selection = selectM1ProviderPort({ provider: "real", provider_name: "runninghub", model_name: RUNNINGHUB_MODEL_ROUTE, cost_acknowledged: true }, dependencies.env ?? process.env);
    if (!selection.ok || selection.selected.provider_name !== "runninghub" || !selection.selected.credential) {
      failIntent(db, intent, "failed", selection.ok ? providerError("PROVIDER_SELECTION_MISMATCH", "RunningHub provider selection changed after confirmation.") : selection.error);
      return;
    }
    const artifact = getMediaArtifact(db, intent.input_artifact_id);
    if (!artifact) {
      failIntent(db, intent, "failed", providerError("ARTIFACT_NOT_FOUND", "Generation input artifact is missing."));
      return;
    }
    const adapter = dependencies.adapter_factory?.(selection.selected.credential)
      ?? new RunningHubVideoProviderAdapter({ credential: selection.selected.credential, fetch_impl: dependencies.fetch_impl });
    let taskId = intent.provider_task_id;
    if (!taskId) {
      if (!allowSubmit) {
        job = setJobState(db, job, "manual_reconciliation", "PROVIDER_SUBMIT_OUTCOME_UNKNOWN");
        return;
      }
      job = setJobState(db, job, "submitting");
      const submit = await adapter.submitGeneration({
        storyboard_artifact: artifact,
        video_prompt: intent.input_snapshot.video_prompt,
        negative_prompt: intent.input_snapshot.negative_prompt,
        duration_seconds: intent.duration_seconds,
        aspect_ratio: intent.input_snapshot.aspect_ratio,
        resolution: intent.resolution
      });
      assertJobLease(db, job.job_id, leaseToken);
      if (!submit.ok) {
        failIntent(db, intent, "failed", submit.error);
        return;
      }
      taskId = submit.provider_job_id;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`UPDATE generation_intents SET provider_task_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?`).run(taskId, intent.intent_id);
        const run = getGenerationRun(db, intent.run_id);
        if (run) {
          run.status = "running";
          run.provider.provider_job_id = taskId;
          run.provider.provider_status = submit.provider_status;
          saveGenerationRun(db, run);
        }
        job = setJobState(db, job, "polling");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      intent = getIntent(db, intent.intent_id) as WorkbenchGenerationIntent;
    }

    const deadline = Date.now() + Math.max(10_000, dependencies.timeout_ms ?? 20 * 60_000);
    const interval = Math.max(250, dependencies.poll_interval_ms ?? 5_000);
    let outputUrl = "";
    while (Date.now() < deadline) {
      const polled = await adapter.pollStatus(taskId);
      assertJobLease(db, job.job_id, leaseToken);
      if (!polled.ok) {
        if (polled.error.retryable) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
          continue;
        }
        failIntent(db, intent, "failed", polled.error);
        return;
      }
      const run = getGenerationRun(db, intent.run_id);
      if (run) {
        run.provider.provider_status = polled.provider_status;
        saveGenerationRun(db, run);
      }
      if (polled.status === "succeeded") {
        outputUrl = polled.output_url ?? "";
        break;
      }
      if (polled.status === "failed" || polled.status === "cancelled") {
        failIntent(db, intent, "failed", providerError("PROVIDER_REQUEST_FAILED", `RunningHub task ended with ${polled.provider_status}.`));
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
    }
    if (!outputUrl) {
      failIntent(db, intent, "timeout", providerError("PROVIDER_TIMEOUT", "RunningHub task did not complete before timeout.", true));
      return;
    }
    let output = existingOutputArtifact(db, taskId);
    if (!output) {
      job = setJobState(db, job, "downloading");
      assertJobLease(db, job.job_id, leaseToken);
      const downloaded = await downloadProviderOutputToArtifact({
        url: outputUrl,
        provider_name: "runninghub",
        provider_job_id: taskId,
        project_id: intent.project_id,
        shot_id: intent.shot_id,
        duration_seconds: intent.duration_seconds,
        aspect_ratio: intent.input_snapshot.aspect_ratio
      }, db);
      assertJobLease(db, job.job_id, leaseToken);
      if (!downloaded.ok) {
        failIntent(db, intent, "failed", downloaded.error);
        return;
      }
      output = downloaded.artifact;
    }
    const shot = getShot(db, intent.shot_id);
    const project = getProject(db, intent.project_id);
    const run = getGenerationRun(db, intent.run_id);
    if (!shot || !project || !run) {
      failIntent(db, intent, "failed", providerError("PROVIDER_REQUEST_FAILED", "Local project state was missing after provider completion."));
      return;
    }
    job = setJobState(db, job, "finalizing");
    assertJobLease(db, job.job_id, leaseToken);
    if (!shot.clip_versions.some((version) => version.artifact_id === output?.artifact_id)) {
      shot.clip_versions.push({ artifact_id: output.artifact_id, run_id: run.run_id, attempt_number: run.versioning.attempt_number, review_status: "pending" });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      shot.status = "video_review";
      saveShot(db, shot);
      project.status = "video_review";
      saveProject(db, project);
      run.status = "succeeded";
      run.output.artifact_ids = [output.artifact_id];
      run.provider.provider_status = "SUCCESS";
      saveGenerationRun(db, run);
      db.prepare(`UPDATE generation_intents SET status = 'succeeded', output_artifact_id = ?, sanitized_error_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?`)
        .run(output.artifact_id, intent.intent_id);
      job = setJobState(db, job, "succeeded");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error instanceof GenerationJobLeaseLostError) return;
    const intent = getIntent(db, intentId);
    if (intent) failIntent(db, intent, "failed", providerError("PROVIDER_REQUEST_FAILED", error instanceof Error ? error.message : "Generation worker failed."));
  } finally {
    clearInterval(heartbeat);
    releaseJobLease(db, job.job_id, leaseToken);
    db.close();
  }
}

export function startWorkbenchGeneration(intentId: string, input: { allow_submit: boolean; dependencies?: WorkbenchGenerationDependencies }): void {
  if (activeExecutions.has(intentId)) return;
  const execution = executeIntent(intentId, input.allow_submit, input.dependencies ?? {}).finally(() => activeExecutions.delete(intentId));
  activeExecutions.set(intentId, execution);
}

export function resumeWorkbenchGenerationJobs(dependencies: WorkbenchGenerationDependencies = {}): { resumed: string[]; reconciled: string[] } {
  const db = openM0Database();
  try {
    const rows = db.prepare(`SELECT i.intent_id, i.provider_task_id, j.state, j.job_id
      FROM generation_intents i JOIN generation_jobs j ON j.intent_id = i.intent_id
      WHERE i.status IN ('queued', 'running') AND j.state NOT IN ('succeeded', 'failed', 'cancelled') ORDER BY j.created_at`).all() as Array<{ intent_id: string; provider_task_id: string; state: GenerationJobState; job_id: string }>;
    const resumed: string[] = [];
    const reconciled: string[] = [];
    for (const row of rows) {
      if (row.state === "manual_reconciliation") {
        reconciled.push(row.intent_id);
      } else if (row.provider_task_id) {
        startWorkbenchGeneration(row.intent_id, { allow_submit: false, dependencies });
        resumed.push(row.intent_id);
      } else {
        const job = jobForIntent(db, row.intent_id);
        if (job) setJobState(db, job, "manual_reconciliation", "PROVIDER_SUBMIT_OUTCOME_UNKNOWN");
        reconciled.push(row.intent_id);
      }
    }
    return { resumed, reconciled };
  } finally {
    db.close();
  }
}

export function getWorkbenchGenerationIntent(intentId: string, db = openM0Database()): WorkbenchV2Result<{ intent: WorkbenchGenerationIntent; job: GenerationJob | null }> {
  const intent = getIntent(db, intentId);
  return intent ? { ok: true, data: { intent, job: jobForIntent(db, intentId) } } : { ok: false, error: { code: "GENERATION_INTENT_NOT_FOUND", message: "Generation intent was not found." } };
}

export function reconcileGenerationJob(
  jobId: string,
  input: { decision: string; provider_task_id?: string; reason?: string; human_confirmation: boolean },
  db = openM0Database()
): WorkbenchV2Result<{ job: GenerationJob; intent: WorkbenchGenerationIntent }> {
  if (input.human_confirmation !== true) return { ok: false, error: { code: "GENERATION_CONFIRMATION_REQUIRED", message: "Human confirmation is required." } };
  if (input.decision !== "attach_existing_task" && input.decision !== "abandon") {
    return { ok: false, error: { code: "INVALID_RECONCILIATION_DECISION", message: "Decision must be attach_existing_task or abandon.", field: "decision" } };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT job_id, intent_id, state, reconciliation_reason, lease_expires_at FROM generation_jobs WHERE job_id = ?").get(jobId) as GenerationJob | undefined;
    if (!row) { db.exec("ROLLBACK"); return { ok: false, error: { code: "GENERATION_JOB_NOT_FOUND", message: "Generation job was not found." } }; }
    if (row.state !== "manual_reconciliation") { db.exec("ROLLBACK"); return { ok: false, error: { code: "GENERATION_JOB_NOT_RECONCILABLE", message: "Generation job does not require reconciliation." } }; }
    const intent = getIntent(db, row.intent_id);
    if (!intent) { db.exec("ROLLBACK"); return { ok: false, error: { code: "GENERATION_INTENT_NOT_FOUND", message: "Generation intent was not found." } }; }
    let job: GenerationJob;
    if (input.decision === "attach_existing_task") {
      const taskId = input.provider_task_id?.trim() ?? "";
      if (!/^[A-Za-z0-9._:-]{3,200}$/.test(taskId)) { db.exec("ROLLBACK"); return { ok: false, error: { code: "INVALID_PROVIDER_TASK_ID", message: "Provider task ID is invalid." } }; }
      db.prepare("UPDATE generation_intents SET provider_task_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?").run(taskId, intent.intent_id);
      job = setJobState(db, row, "polling", "HUMAN_ATTACHED_EXISTING_TASK");
    } else {
      db.prepare("UPDATE generation_intents SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?").run(intent.intent_id);
      const run = getGenerationRun(db, intent.run_id);
      if (run) { run.status = "cancelled"; saveGenerationRun(db, run); }
      job = setJobState(db, row, "cancelled", input.reason?.trim() || "HUMAN_ABANDONED");
    }
    db.exec("COMMIT");
    return { ok: true, data: { job, intent: getIntent(db, intent.intent_id) as WorkbenchGenerationIntent } };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
