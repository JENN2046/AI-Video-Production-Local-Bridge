import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { paths } from "../paths.js";
import {
  consumeDirectorGrantReservation,
  loadDirectorGrantAuthorization,
  releaseDirectorGrantReservation,
  reserveDirectorGrant,
  type DirectorAutomationLink
} from "../director/grantRuntime.js";
import { directorMinorToProviderAmount, directorProviderAmountToMinor } from "../director/currency.js";
import { legacyProposalMatchesDirectorCapability, selectVerifiedDirectorCapability } from "../director/providerCapability.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { withWorkbenchProductionMutationAuthority } from "../storage/productionMutationAuthority.js";
import { getGenerationRun, saveGenerationRun, type GenerationRun } from "./generation.js";
import {
  createGenerationExecutionReceipt,
  getGenerationExecutionReceipt,
  revalidateGenerationExecutionAuthority,
  transitionGenerationExecutionReceipt,
  type GenerationExecutionBindingInput
} from "./generationExecutionIntegrity.js";
import { requireShotWorkflowWriteAction } from "./operationalWriteGates.js";
import {
  activateLocalMediaArtifact,
  cleanupCommittedMediaActivationMarkers,
  transitionMediaArtifactStatus,
  validateActiveArtifactReference,
  type ActivateLocalMediaArtifactInput,
  type MediaArtifact,
  type RegisterMediaArtifactResult
} from "./mediaArtifacts.js";
import { providerError, resolveRunningHubComparableBalance, selectM1ProviderPort, type ProviderToolError } from "./provider.js";
import { buildProviderCapabilityKey, buildProviderPriceCacheKey, providerCapabilityErrorMessage } from "./providerCapabilities.js";
import { parseAssemblyResolution } from "./assembly.js";
import { validateMp4File } from "./mediaValidity.js";
import { downloadProviderOutputToArtifact } from "./providerOutputDownloader.js";
import { getProject, getShot, listProjectShots, saveProject, saveShot, type Project, type ProjectStatus, type Shot, type ShotStatus } from "./projects.js";
import { parseGenerationPlan, planMatchesFacts, revalidateGenerationPlanMedia } from "./s3bT2AdmissionPlan.js";
import { readGenerationAdmissionFacts } from "./s3bT2AdmissionFacts.js";
import type { GenerationPlan } from "./s3bT2Types.js";
import {
  buildRunningHubImageToVideoSubmitRequest,
  mapRunningHubProviderError,
  RUNNINGHUB_API_BASE_URL,
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
    project_resolution?: string;
    price_source: "runninghub_price_preview" | "local_verified_cache";
    balance_gate: "pass" | "not_checked";
    account_balance_value?: number;
    account_balance_currency?: string;
    requires_human_preflight?: boolean;
    prepared_by?: "human_workbench" | "webgpt_v4" | "director_automation" | "t2_admission";
    admission_only?: true;
    capability_key?: string;
    director_automation?: DirectorAutomationPreflightAuthorization & { reservation_id?: string; amount_minor?: number };
  };
  generation_plan?: GenerationPlan;
  generation_plan_invalid?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DirectorAutomationPreflightAuthorization {
  grant_id: string;
  proposal_id: string;
  policy_hash: string;
}

function buildDirectorAutomationBinding(
  input?: DirectorAutomationPreflightAuthorization
): DirectorAutomationPreflightAuthorization | undefined {
  if (!input) return undefined;
  return {
    grant_id: input.grant_id,
    proposal_id: input.proposal_id,
    policy_hash: input.policy_hash
  };
}

function directorAutomationBindingMatches(
  binding: WorkbenchGenerationIntent["input_snapshot"]["director_automation"] | undefined,
  input: DirectorAutomationPreflightAuthorization
): boolean {
  if (!binding) return false;
  return binding.grant_id === input.grant_id
    && binding.proposal_id === input.proposal_id
    && binding.policy_hash === input.policy_hash;
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
  download_provider_output?: typeof downloadProviderOutputToArtifact;
  open_database?: (sqlitePath?: string) => M0Database;
  scheduler_retry_ms?: number;
  on_scheduler_error?: (error: unknown) => void;
  fault_injection_after_provider_success_run_write?: () => void;
  fault_injection_after_provider_artifact_persist?: () => void;
  now?: () => Date;
  monotonic_now_ms?: () => number;
  poll_interval_ms?: number;
  timeout_ms?: number;
  sqlite_path?: string;
  provider_output_storage_directory?: string;
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
const scheduledWakeups = new Map<string, NodeJS.Timeout>();
const submittingRecoveryWakeups = new Map<string, NodeJS.Timeout>();
const DUE_GENERATION_JOB_SQL = "datetime(next_attempt_at) <= CURRENT_TIMESTAMP";
export const DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS = 600_000;
export const MIN_PROVIDER_TASK_POLL_TIMEOUT_MS = 1_000;
export const MAX_PROVIDER_TASK_POLL_TIMEOUT_MS = 3_600_000;

class ProviderPollTimeoutConfigurationError extends Error {
  readonly code = "PROVIDER_POLL_TIMEOUT_CONFIG_INVALID";

  constructor() {
    super("Provider poll timeout configuration is invalid.");
    this.name = "ProviderPollTimeoutConfigurationError";
  }
}

function schedulerKey(dependencies: WorkbenchGenerationDependencies): string {
  return dependencies.sqlite_path ?? "__default_workbench_database__";
}

export function generationWorkerStatus(db: M0Database): { ready: boolean; active: number; concurrency: 1; stale_leases: number; unowned_runnable: number; runnable: number } {
  const staleRow = db.prepare(`SELECT COUNT(*) AS count FROM generation_jobs
    WHERE state IN ('submitting','polling','downloading','finalizing')
      AND lease_token <> '' AND lease_expires_at IS NOT NULL
      AND datetime(lease_expires_at) <= CURRENT_TIMESTAMP`).get() as { count: number };
  const unownedRow = db.prepare(`SELECT COUNT(*) AS count FROM generation_jobs
    WHERE state IN ('queued','submitting','polling','downloading','finalizing')
      AND ${DUE_GENERATION_JOB_SQL}
      AND (lease_token = '' OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP)`).get() as { count: number };
  const staleLeases = Number(staleRow.count);
  const unownedRunnable = Number(unownedRow.count);
  const runnable = Number((db.prepare(`SELECT COUNT(*) AS count FROM generation_jobs
    WHERE state IN ('queued','submitting','polling','downloading','finalizing')
      AND ${DUE_GENERATION_JOB_SQL}`).get() as { count: number }).count);
  const active = activeExecutions.size;
  return { ready: active <= 1 && staleLeases === 0 && (active > 0 || runnable === 0), active, concurrency: 1, stale_leases: staleLeases, unowned_runnable: unownedRunnable, runnable };
}

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

function executionBinding(
  intent: WorkbenchGenerationIntent,
  job: Pick<GenerationJob, "job_id">,
  expectedJobState: GenerationExecutionBindingInput["expected_job_state"]
): GenerationExecutionBindingInput {
  return {
    intent_id: intent.intent_id,
    job_id: job.job_id,
    expected_job_state: expectedJobState,
    run_id: intent.run_id,
    project_id: intent.project_id,
    shot_id: intent.shot_id,
    provider: intent.provider,
    account_label: intent.account_label,
    model: intent.model,
    input_artifact_id: intent.input_artifact_id,
    provider_task_id: intent.provider_task_id,
    duration_seconds: intent.duration_seconds,
    resolution: intent.resolution,
    estimated_cost_value: intent.estimated_cost_value,
    budget_limit_value: intent.budget_limit_value,
    currency: intent.currency,
    confirmed: intent.confirmed,
    expires_at: intent.expires_at,
    input_snapshot: intent.input_snapshot,
    ...(intent.generation_plan ? { generation_plan: intent.generation_plan } : {})
  };
}

function generationExecutionAuthorityError(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  job: Pick<GenerationJob, "job_id">,
  expectedJobState: GenerationExecutionBindingInput["expected_job_state"]
): ProviderToolError | null {
  const authority = revalidateGenerationExecutionAuthority(db, executionBinding(intent, job, expectedJobState));
  return authority.ok ? null : providerError(authority.error.code, authority.error.message);
}

function appendJobEvent(db: M0Database, jobId: string, fromState: string, toState: GenerationJobState, reasonCode = "", data: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO generation_job_events (event_id, job_id, from_state, to_state, reason_code, data_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`job_event_${randomUUID()}`, jobId, fromState, toState, reasonCode, JSON.stringify(data));
}

function setJobState(
  db: M0Database,
  job: GenerationJob,
  state: GenerationJobState,
  reasonCode = "",
  options: { lease_token?: string; in_transaction?: boolean } = {}
): GenerationJob {
  if (!options.in_transaction) db.exec("BEGIN IMMEDIATE");
  try {
    const result = options.lease_token
      ? db.prepare(`UPDATE generation_jobs SET state = ?, reconciliation_reason = ?, updated_at = CURRENT_TIMESTAMP
          WHERE job_id = ? AND state = ? AND lease_token = ? AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at) > CURRENT_TIMESTAMP`)
        .run(state, reasonCode, job.job_id, job.state, options.lease_token) as { changes: number | bigint }
      : db.prepare("UPDATE generation_jobs SET state = ?, reconciliation_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = ?")
        .run(state, reasonCode, job.job_id, job.state) as { changes: number | bigint };
    if (Number(result.changes) !== 1) {
      if (options.lease_token) throw new GenerationJobLeaseLostError();
      throw new Error("GENERATION_JOB_NOT_FOUND");
    }
    appendJobEvent(db, job.job_id, job.state, state, reasonCode);
    if (!options.in_transaction) db.exec("COMMIT");
    return { ...job, state, reconciliation_reason: reasonCode };
  } catch (error) {
    if (!options.in_transaction) db.exec("ROLLBACK");
    throw error;
  }
}

function enterManualReconciliationJob(
  db: M0Database,
  job: GenerationJob,
  reasonCode: string,
  options: { lease_token?: string; record_event: boolean }
): GenerationJob {
  let updated: GenerationJob;
  if (options.record_event) {
    updated = setJobState(db, job, "manual_reconciliation", reasonCode, {
      ...(options.lease_token ? { lease_token: options.lease_token } : {}),
      in_transaction: true
    });
    const cleared = db.prepare(`UPDATE generation_jobs
      SET lease_owner = '', lease_token = '', lease_expires_at = NULL,
        next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND state = 'manual_reconciliation'`).run(job.job_id) as { changes: number | bigint };
    if (Number(cleared.changes) !== 1) throw new Error("GENERATION_JOB_NOT_FOUND");
  } else {
    const result = options.lease_token
      ? db.prepare(`UPDATE generation_jobs
          SET state = 'manual_reconciliation', reconciliation_reason = ?,
            lease_owner = '', lease_token = '', lease_expires_at = NULL,
            next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE job_id = ? AND state = ? AND lease_token = ? AND lease_expires_at IS NOT NULL
            AND datetime(lease_expires_at) > CURRENT_TIMESTAMP`)
        .run(reasonCode, job.job_id, job.state, options.lease_token) as { changes: number | bigint }
      : db.prepare(`UPDATE generation_jobs
          SET state = 'manual_reconciliation', reconciliation_reason = ?,
            lease_owner = '', lease_token = '', lease_expires_at = NULL,
            next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE job_id = ? AND state = ?`)
        .run(reasonCode, job.job_id, job.state) as { changes: number | bigint };
    if (Number(result.changes) !== 1) {
      if (options.lease_token) throw new GenerationJobLeaseLostError();
      throw new Error("GENERATION_JOB_NOT_FOUND");
    }
    updated = { ...job, state: "manual_reconciliation", reconciliation_reason: reasonCode };
  }
  return { ...updated, lease_expires_at: null };
}

type ReconciliationRestoreState = { shot_status: ShotStatus; project_status: ProjectStatus };

function persistedReconciliationRestoreState(
  db: M0Database,
  intentId: string
): ReconciliationRestoreState | null {
  const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string } | undefined;
  const data = parseRecord(row?.data_json ?? "");
  const restore = data.reconciliation_restore && typeof data.reconciliation_restore === "object" && !Array.isArray(data.reconciliation_restore)
    ? data.reconciliation_restore as Record<string, unknown>
    : {};
  if (typeof restore.shot_status !== "string"
    || !["draft", "storyboard_approved", "video_generated", "video_review", "approved", "revision_needed"].includes(restore.shot_status)
    || typeof restore.project_status !== "string"
    || !["draft", "storyboard_approved", "video_review", "final_approved"].includes(restore.project_status)) return null;
  return {
    shot_status: restore.shot_status as ShotStatus,
    project_status: restore.project_status as ProjectStatus
  };
}

function migratedReconciliationRestoreState(
  db: M0Database,
  job: GenerationJob,
  intent: WorkbenchGenerationIntent,
  project: Project,
  shot: Shot
): ReconciliationRestoreState | null {
  const restoredShotStatus: ShotStatus = shot.clip_versions.length > 0 ? "revision_needed" : "storyboard_approved";
  if (job.job_id !== `job_${intent.intent_id}`
    || job.reconciliation_reason !== "PROVIDER_SUBMIT_OUTCOME_UNKNOWN"
    || !intent.confirmed
    || (intent.status !== "queued" && intent.status !== "running")
    || intent.provider_task_id !== ""
    || !["storyboard_approved", "video_generation_in_progress", "video_review"].includes(project.status)
    || !project.shot_ids.includes(shot.shot_id)
    || (shot.status !== "video_pending" && shot.status !== restoredShotStatus)) return null;

  const event = db.prepare(`SELECT
      COUNT(*) AS event_count,
      SUM(CASE WHEN event_id = ?
        AND from_state = ''
        AND to_state = 'manual_reconciliation'
        AND reason_code = 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN'
        AND json_valid(data_json) = 1
        AND json_extract(data_json, '$.source') = 'migration_0004'
        THEN 1 ELSE 0 END) AS migration_event_count
    FROM generation_job_events WHERE job_id = ?`).get(
      `job_event_backfill_${job.job_id}`,
      job.job_id
    ) as { event_count: number; migration_event_count: number };
  if (Number(event.event_count) !== 1 || Number(event.migration_event_count) !== 1) return null;

  const projectStatus: ProjectStatus = listProjectShots(db, project.project_id).some((candidate) =>
    candidate.clip_versions.length > 0
      || ["video_review", "video_generated", "approved", "revision_needed"].includes(candidate.status)
  )
    ? "video_review"
    : "storyboard_approved";
  return { shot_status: restoredShotStatus, project_status: projectStatus };
}

function isMigration0016ExecutionQuarantine(
  db: M0Database,
  job: GenerationJob,
  intent: WorkbenchGenerationIntent,
  project: Project,
  shot: Shot
): boolean {
  if (job.reconciliation_reason !== "GENERATION_EXECUTION_SNAPSHOT_MISSING"
    || getGenerationExecutionReceipt(db, intent.intent_id)
    || !intent.confirmed
    || (intent.status !== "queued" && intent.status !== "running")
    || project.status !== "video_generation_in_progress"
    || shot.status !== "video_pending") return false;
  const attestation = db.prepare(`SELECT quarantine.intent_id, quarantine.event_id,
      quarantine.from_state AS attested_from_state, quarantine.reason_code AS attested_reason_code,
      event.job_id, event.from_state, event.to_state, event.reason_code, event.data_json
    FROM generation_execution_legacy_quarantines quarantine
    JOIN generation_job_events event ON event.event_id = quarantine.event_id
    WHERE quarantine.job_id = ?`).get(job.job_id) as {
      intent_id: string;
      event_id: string;
      attested_from_state: string;
      attested_reason_code: string;
      job_id: string;
      from_state: string;
      to_state: string;
      reason_code: string;
      data_json: string;
    } | undefined;
  return attestation?.intent_id === intent.intent_id
    && attestation.event_id === `job_event_0016_${job.job_id}`
    && attestation.job_id === job.job_id
    && ["queued", "submitting", "polling", "downloading", "finalizing"].includes(attestation.from_state)
    && attestation.attested_from_state === attestation.from_state
    && attestation.to_state === "manual_reconciliation"
    && attestation.reason_code === "GENERATION_EXECUTION_SNAPSHOT_MISSING"
    && attestation.attested_reason_code === attestation.reason_code
    && parseRecord(attestation.data_json).source === "migration_0016";
}

function persistReconciliationRestoreState(db: M0Database, intentId: string, restore: ReconciliationRestoreState): void {
  const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string };
  const data = parseRecord(row.data_json);
  data.reconciliation_restore = restore;
  db.prepare("UPDATE generation_intents SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?")
    .run(JSON.stringify(data), intentId);
}

function reconciliationRestoreState(db: M0Database, intentId: string): ReconciliationRestoreState {
  return persistedReconciliationRestoreState(db, intentId)
    ?? { shot_status: "storyboard_approved", project_status: "storyboard_approved" };
}

function pollingLeaseRecoveryRequired(db: M0Database, intentId: string, now: Date): boolean {
  const nowIso = now.toISOString();
  return Boolean(db.prepare(`SELECT 1 AS required
    FROM generation_intents
    WHERE intent_id = ?
      AND (
        julianday(CASE
          WHEN json_valid(data_json) = 1
            THEN json_extract(data_json, '$.provider_poll_started_at')
          ELSE NULL
        END) > julianday(?)
        OR julianday(CASE
          WHEN json_valid(data_json) = 1
            THEN json_extract(data_json, '$.provider_poll_deadline_at')
          ELSE NULL
        END) <= julianday(?)
      )`).get(intentId, nowIso, nowIso));
}

function claimJob(
  db: M0Database,
  intentId: string,
  owner: string,
  token: string,
  recoveryNow: Date
): GenerationJob | null {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = jobForIntent(db, intentId);
    if (!job || ["succeeded", "failed", "cancelled", "manual_reconciliation"].includes(job.state)) {
      db.exec("ROLLBACK");
      return null;
    }
    const pollingRecovery = job.state === "polling"
      && pollingLeaseRecoveryRequired(db, intentId, recoveryNow);
    const result = db.prepare(`UPDATE generation_jobs SET lease_owner = ?, lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND (
        lease_token = ''
        OR lease_expires_at IS NULL
        OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP
        OR ? = 1
      )`).run(owner, token, expiresAt, job.job_id, pollingRecovery ? 1 : 0) as { changes: number | bigint };
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

function monotonicNowMs(dependencies: WorkbenchGenerationDependencies): number {
  return dependencies.monotonic_now_ms?.() ?? performance.now();
}

export function parseProviderTaskPollTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PROVIDER_TASK_POLL_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS;
  if (!/^[0-9]+$/.test(raw)) throw new ProviderPollTimeoutConfigurationError();
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)
    || parsed < MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    || parsed > MAX_PROVIDER_TASK_POLL_TIMEOUT_MS) {
    throw new ProviderPollTimeoutConfigurationError();
  }
  return parsed;
}

interface ProviderPollWindow {
  started_at_ms: number;
  timeout_ms: number;
  deadline_ms: number;
}

function providerPollWindowFromIntent(db: M0Database, intentId: string): ProviderPollWindow | null {
  const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string } | undefined;
  if (!row) throw new ProviderPollTimeoutConfigurationError();
  const data = parseRecord(row.data_json);
  const fields = [
    data.provider_poll_started_at,
    data.provider_poll_timeout_ms,
    data.provider_poll_deadline_at
  ];
  if (fields.every((value) => value === undefined)) return null;
  if (typeof data.provider_poll_started_at !== "string"
    || typeof data.provider_poll_timeout_ms !== "number"
    || !Number.isSafeInteger(data.provider_poll_timeout_ms)
    || data.provider_poll_timeout_ms < MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    || data.provider_poll_timeout_ms > MAX_PROVIDER_TASK_POLL_TIMEOUT_MS
    || typeof data.provider_poll_deadline_at !== "string") {
    throw new ProviderPollTimeoutConfigurationError();
  }
  const started = Date.parse(data.provider_poll_started_at);
  const persisted = Date.parse(data.provider_poll_deadline_at);
  if (!Number.isFinite(started)
    || !Number.isFinite(persisted)
    || persisted - started !== data.provider_poll_timeout_ms) {
    throw new ProviderPollTimeoutConfigurationError();
  }
  return {
    started_at_ms: started,
    timeout_ms: data.provider_poll_timeout_ms,
    deadline_ms: persisted
  };
}

function providerPollDeadlineFromIntent(db: M0Database, intentId: string): number | null {
  return providerPollWindowFromIntent(db, intentId)?.deadline_ms ?? null;
}

function persistProviderPollDeadline(
  db: M0Database,
  intentId: string,
  timeoutMs: number,
  nowMs: number
): number {
  const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string };
  const data = parseRecord(row.data_json);
  const deadline = nowMs + timeoutMs;
  if (!Number.isSafeInteger(deadline)) throw new ProviderPollTimeoutConfigurationError();
  data.provider_poll_started_at = new Date(nowMs).toISOString();
  data.provider_poll_timeout_ms = timeoutMs;
  data.provider_poll_deadline_at = new Date(deadline).toISOString();
  db.prepare("UPDATE generation_intents SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?")
    .run(JSON.stringify(data), intentId);
  return deadline;
}

function ensureProviderPollDeadline(
  db: M0Database,
  intentId: string,
  timeoutMs: number,
  nowMs: number
): number {
  const existing = providerPollDeadlineFromIntent(db, intentId);
  return existing ?? persistProviderPollDeadline(db, intentId, timeoutMs, nowMs);
}

function restartProviderPollDeadlineAfterHumanAttachment(
  db: M0Database,
  intentId: string,
  timeoutMs: number,
  nowMs: number
): number {
  return persistProviderPollDeadline(db, intentId, timeoutMs, nowMs);
}

function createRemainingPollBudget(
  window: ProviderPollWindow,
  dependencies: WorkbenchGenerationDependencies
): () => number {
  const wallStartMs = dateNow(dependencies).getTime();
  const monotonicStartMs = monotonicNowMs(dependencies);
  const initialRemainingMs = wallStartMs < window.started_at_ms
    ? 0
    : Math.max(0, Math.min(window.timeout_ms, window.deadline_ms - wallStartMs));
  return () => {
    const wallRemainingMs = window.deadline_ms - dateNow(dependencies).getTime();
    const monotonicRemainingMs = initialRemainingMs - Math.max(0, monotonicNowMs(dependencies) - monotonicStartMs);
    return Math.max(0, Math.floor(Math.min(wallRemainingMs, monotonicRemainingMs)));
  };
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
    balance_gate: "not_checked",
    requires_human_preflight: true
  };
  const snapshot = data.input_snapshot && typeof data.input_snapshot === "object" && !Array.isArray(data.input_snapshot)
    ? data.input_snapshot as WorkbenchGenerationIntent["input_snapshot"]
    : fallbackSnapshot;
  const hasGenerationPlan = Object.prototype.hasOwnProperty.call(data, "generation_plan");
  const generationPlan = hasGenerationPlan ? parseGenerationPlan(data.generation_plan) : undefined;
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
    ...(generationPlan ? { generation_plan: generationPlan } : {}),
    ...(hasGenerationPlan && !generationPlan ? { generation_plan_invalid: true } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function getIntent(db: M0Database, intentId: string): WorkbenchGenerationIntent | null {
  const row = db.prepare("SELECT * FROM generation_intents WHERE intent_id = ?").get(intentId) as GenerationIntentRow | undefined;
  return row ? intentFromRow(row) : null;
}

function hasDurableT2GenerationPlan(intent: Pick<WorkbenchGenerationIntent, "generation_plan" | "generation_plan_invalid">): boolean {
  return intent.generation_plan !== undefined || intent.generation_plan_invalid === true;
}

function isT2AdmissionReservation(
  intent: Pick<WorkbenchGenerationIntent, "status" | "generation_plan" | "generation_plan_invalid">
): boolean {
  return intent.status === "prepared" && hasDurableT2GenerationPlan(intent);
}

type PreparedGenerationPlanRevalidation =
  | { ok: true }
  | { ok: false; message: string };

type PreparedGenerationStaleError = {
  code: "GENERATION_INTENT_INPUT_STALE" | "GENERATION_PLAN_STALE";
  message: string;
};

type PreparedGenerationStaleTerminalization = {
  intent: WorkbenchGenerationIntent;
  error: PreparedGenerationStaleError;
};

function validateT2GenerationPlanStructure(
  intent: WorkbenchGenerationIntent
): PreparedGenerationPlanRevalidation {
  if (!hasDurableT2GenerationPlan(intent)) return { ok: true };
  const plan = intent.generation_plan;
  if (!plan || intent.generation_plan_invalid
    || plan.project_id !== intent.project_id
    || plan.shot_id !== intent.shot_id
    || plan.storyboard_artifact_id !== intent.input_artifact_id
    || plan.provider_name !== intent.provider
    || plan.duration_seconds !== intent.duration_seconds
    || plan.resolution !== intent.resolution
    || plan.aspect_ratio !== intent.input_snapshot.aspect_ratio) {
    return { ok: false, message: "The prepared GenerationPlan no longer matches its reservation binding." };
  }
  return { ok: true };
}

function validateT2GenerationPlanBinding(
  intent: WorkbenchGenerationIntent
): PreparedGenerationPlanRevalidation {
  const structure = validateT2GenerationPlanStructure(intent);
  if (!structure.ok || !hasDurableT2GenerationPlan(intent)) return structure;
  if (intent.input_snapshot.prepared_by !== "t2_admission"
    || intent.input_snapshot.admission_only !== true) {
    return { ok: false, message: "The durable T2 GenerationPlan markers are missing or inconsistent." };
  }
  return { ok: true };
}

function revalidatePreparedGenerationPlan(
  db: M0Database,
  intent: WorkbenchGenerationIntent
): PreparedGenerationPlanRevalidation {
  const structure = validateT2GenerationPlanStructure(intent);
  if (!structure.ok || !hasDurableT2GenerationPlan(intent)) return structure;
  const plan = intent.generation_plan;
  if (!plan) return { ok: false, message: "The prepared GenerationPlan no longer matches its reservation binding." };
  const current = readGenerationAdmissionFacts(db, intent.project_id, intent.shot_id, { verify_media: false });
  if (!current.ok || !current.facts.provider.ok || !planMatchesFacts(plan, current.facts)) {
    return { ok: false, message: "The prepared GenerationPlan no longer matches current authoritative generation facts." };
  }
  return validateT2GenerationPlanBinding(intent);
}

function revalidateQueuedGenerationPlanAuthority(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  job: GenerationJob
): PreparedGenerationPlanRevalidation {
  const binding = validateT2GenerationPlanBinding(intent);
  if (!binding.ok || !hasDurableT2GenerationPlan(intent)) return binding;
  const plan = intent.generation_plan;
  const restore = persistedReconciliationRestoreState(db, intent.intent_id);
  const project = getProject(db, intent.project_id);
  const shot = getShot(db, intent.shot_id);
  const run = intent.run_id ? getGenerationRun(db, intent.run_id) : null;
  if (!plan || !restore || !project || !shot || !run
    || job.state !== "queued"
    || project.status !== "video_generation_in_progress"
    || shot.status !== "video_pending"
    || shot.generation_run_ids.filter((runId) => runId === intent.run_id).length !== 1
    || run.project_id !== intent.project_id
    || run.shot_id !== intent.shot_id
    || run.status !== "queued") {
    return { ok: false, message: "The queued GenerationPlan execution footprint no longer matches its confirmed reservation." };
  }
  const current = readGenerationAdmissionFacts(db, intent.project_id, intent.shot_id, {
    verify_media: false,
    execution_projection: {
      intent_id: intent.intent_id,
      run_id: intent.run_id,
      project_status: restore.project_status,
      shot_status: restore.shot_status
    }
  });
  if (!current.ok || !current.facts.provider.ok || !planMatchesFacts(plan, current.facts)) {
    return { ok: false, message: "The queued GenerationPlan no longer matches current authoritative generation facts." };
  }
  return { ok: true };
}

function classifyPreparedGenerationStale(
  db: M0Database,
  intent: WorkbenchGenerationIntent
): PreparedGenerationStaleError | null {
  if (!isT2AdmissionReservation(intent)) return null;

  const project = getProject(db, intent.project_id);
  const shot = getShot(db, intent.shot_id);
  if (!project || !shot || shot.project_id !== intent.project_id) {
    return {
      code: "GENERATION_PLAN_STALE",
      message: "The prepared GenerationPlan no longer matches the selected Project or SHOT."
    };
  }
  const artifact = validateActiveArtifactReference(db, {
    artifact_id: shot.storyboard_image_artifact_id,
    project_id: intent.project_id,
    shot_id: shot.shot_id,
    role: "storyboard_image",
    artifact_type: "image"
  });
  if (!artifact.ok) {
    return {
      code: "GENERATION_PLAN_STALE",
      message: "The prepared GenerationPlan no longer matches the selected storyboard Artifact."
    };
  }
  const capability = buildProviderCapabilityKey({
    provider: "runninghub",
    model: intent.model,
    duration_seconds: shot.duration_seconds,
    resolution: project.video_spec.resolution,
    aspect_ratio: project.video_spec.aspect_ratio
  });
  if (!capability.ok) {
    return {
      code: "GENERATION_PLAN_STALE",
      message: "The prepared GenerationPlan no longer matches the declared Provider capability."
    };
  }
  if (intent.input_artifact_id !== artifact.artifact.artifact_id
    || intent.input_snapshot.video_prompt !== shot.video_prompt
    || intent.input_snapshot.negative_prompt !== shot.negative_prompt
    || intent.input_snapshot.aspect_ratio !== project.video_spec.aspect_ratio
    || intent.input_snapshot.project_resolution !== project.video_spec.resolution
    || intent.duration_seconds !== capability.key.duration_seconds
    || intent.resolution !== capability.key.resolution
    || (intent.input_snapshot.capability_key !== undefined
      && intent.input_snapshot.capability_key !== capability.key.serialized)) {
    return {
      code: "GENERATION_INTENT_INPUT_STALE",
      message: "SHOT or project inputs changed after generation admission."
    };
  }
  const planRevalidation = revalidatePreparedGenerationPlan(db, intent);
  if (!planRevalidation.ok) {
    return {
      code: "GENERATION_PLAN_STALE",
      message: planRevalidation.message
    };
  }
  return null;
}

function terminalizePreparedIntentInTransaction(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  error: ProviderToolError | { code: string; message: string; retryable?: boolean }
): WorkbenchGenerationIntent | null {
  const result = db.prepare(`UPDATE generation_intents
    SET status = 'cancelled', sanitized_error_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE intent_id = ? AND status = 'prepared' AND confirmed = 0
      AND (run_id IS NULL OR run_id = '') AND provider_task_id = ''`)
    .run(JSON.stringify(sanitizedError(error)), intent.intent_id) as { changes: number | bigint };
  return Number(result.changes) === 1 ? getIntent(db, intent.intent_id) : null;
}

function terminalizeT2PreparedIntentIfStaleInTransaction(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  forcedError?: PreparedGenerationStaleError
): PreparedGenerationStaleTerminalization | null {
  const detectedError = classifyPreparedGenerationStale(db, intent);
  if (!detectedError) return null;
  const error = forcedError ?? detectedError;
  const terminalized = terminalizePreparedIntentInTransaction(db, intent, error);
  if (!terminalized) throw new Error("GENERATION_RESERVATION_NOT_CANCELLABLE");
  return { intent: terminalized, error };
}

function terminalizeStaleT2Reservation(
  db: M0Database,
  intentId: string
): PreparedGenerationStaleTerminalization | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    const intent = getIntent(db, intentId);
    const terminalized = intent ? terminalizeT2PreparedIntentIfStaleInTransaction(db, intent) : null;
    if (!terminalized) {
      db.exec("ROLLBACK");
      return null;
    }
    db.exec("COMMIT");
    return terminalized;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function generationRightConflict(
  db: M0Database,
  excludeIntentId = ""
): WorkbenchGenerationIntent | null {
  const rows = db.prepare("SELECT * FROM generation_intents WHERE status IN ('prepared', 'queued', 'running') ORDER BY created_at, intent_id").all() as GenerationIntentRow[];
  for (const row of rows) {
    const intent = intentFromRow(row);
    if (intent.intent_id === excludeIntentId) continue;
    if (intent.status === "queued" || intent.status === "running" || isT2AdmissionReservation(intent)) return intent;
  }
  return null;
}

function findT2AdmissionReservation(db: M0Database, projectId: string, shotId: string): WorkbenchGenerationIntent | null {
  const rows = db.prepare("SELECT * FROM generation_intents WHERE project_id = ? AND shot_id = ? AND status = 'prepared' ORDER BY created_at, intent_id")
    .all(projectId, shotId) as GenerationIntentRow[];
  const reservations = rows.map(intentFromRow).filter(isT2AdmissionReservation);
  return reservations.length === 1 ? reservations[0] : null;
}

export function isProviderExecutionAuthorized(
  intent: Pick<WorkbenchGenerationIntent, "input_snapshot">
): boolean {
  return intent.input_snapshot.requires_human_preflight === false
    && intent.input_snapshot.balance_gate === "pass";
}

export type CanonicalGenerationAdmissionCommitInput = {
  project: Project;
  shot: Shot;
  provider: "runninghub";
  model: string;
  input_artifact_id: string;
  duration_seconds: number;
  resolution: string;
  input_snapshot: WorkbenchGenerationIntent["input_snapshot"];
  generation_plan?: GenerationPlan;
  account_label: "personal" | "team";
  estimated_cost_value: number;
  budget_limit_value: number;
  currency: string;
  existing_prepared_intent_id?: string;
  run_id?: string;
  existing_data?: Record<string, unknown>;
  admission_reason_code?: string;
  reservation_only?: boolean;
};

export type CanonicalGenerationAdmissionCommitResult = {
  intent: WorkbenchGenerationIntent;
  run_id: string;
  job_id: string;
  status: "prepared" | "queued";
};

/**
 * Shared Generation Domain commit primitive.  Both the existing V2
 * confirmation flow and IS2.5 GenerationPlan confirmation use this one
 * writer; callers own the surrounding short transaction.  T2 admission may
 * select the reservation-only branch below, which intentionally stops before
 * creating a runnable GenerationRun or GenerationJob.
 */
export function commitCanonicalGenerationAdmission(
  input: CanonicalGenerationAdmissionCommitInput,
  db: M0Database
): CanonicalGenerationAdmissionCommitResult {
  const now = new Date().toISOString();
  const intentId = input.existing_prepared_intent_id ?? `intent_${randomUUID()}`;
  const runId = input.run_id ?? `run_${randomUUID()}`;
  const inputData: Record<string, unknown> = {
    ...(input.existing_data ?? {}),
    input_snapshot: input.input_snapshot,
    ...(input.generation_plan ? { generation_plan: input.generation_plan } : {})
  };
  if (input.reservation_only) {
    if (input.existing_prepared_intent_id) throw new Error("GENERATION_RESERVATION_ALREADY_EXISTS");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO generation_intents (
        intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
        duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
        confirmed, expires_at, provider_task_id, status, upload_attempts, submit_attempts,
        output_artifact_id, sanitized_error_json, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', 'prepared', 0, 0, '', '{}', ?, ?, ?)
    `).run(
      intentId,
      input.project.project_id,
      input.shot.shot_id,
      input.provider,
      input.account_label,
      input.model,
      input.input_artifact_id,
      input.duration_seconds,
      input.resolution,
      input.estimated_cost_value,
      input.budget_limit_value,
      input.currency,
      expiresAt,
      JSON.stringify(inputData),
      now,
      now
    );
    const intent = getIntent(db, intentId);
    if (!intent) throw new Error("GENERATION_INTENT_NOT_FOUND");
    return { intent, run_id: "", job_id: "", status: "prepared" };
  }
  const run: GenerationRun = {
    run_id: runId,
    batch_id: "",
    project_id: input.project.project_id,
    shot_id: input.shot.shot_id,
    run_type: "image_to_video",
    status: "queued",
    input: {
      storyboard_image_artifact_id: input.input_artifact_id,
      video_prompt: input.input_snapshot.video_prompt,
      negative_prompt: input.input_snapshot.negative_prompt,
      duration_seconds: input.duration_seconds,
      aspect_ratio: input.input_snapshot.aspect_ratio,
      resolution: input.resolution
    },
    output: { artifact_ids: [] },
    provider: {
      provider: "real",
      provider_name: input.provider,
      model_name: input.model,
      provider_job_id: "",
      provider_status: "not_submitted"
    },
    versioning: {
      attempt_number: input.shot.clip_versions.length + 1,
      parent_run_id: input.shot.generation_run_ids.at(-1) ?? ""
    },
    error: { code: "", message: "", retryable: false }
  };

  saveGenerationRun(db, run);
  input.shot.generation_run_ids = [...input.shot.generation_run_ids, runId];
  input.shot.status = "video_pending";
  saveShot(db, input.shot);
  input.project.status = "video_generation_in_progress";
  saveProject(db, input.project);

  if (input.existing_prepared_intent_id) {
    const updated = db.prepare(`
      UPDATE generation_intents
      SET run_id = ?, confirmed = 1, budget_limit_value = ?, status = 'queued',
        upload_attempts = 1, submit_attempts = 1, data_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE intent_id = ? AND status = 'prepared' AND confirmed = 0 AND (run_id IS NULL OR run_id = '')
    `).run(runId, input.budget_limit_value, JSON.stringify(inputData), intentId) as { changes: number | bigint };
    if (Number(updated.changes) !== 1) throw new Error("GENERATION_INTENT_NOT_PREPARED");
  } else {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO generation_intents (
        intent_id, run_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
        duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
        confirmed, expires_at, provider_task_id, status, upload_attempts, submit_attempts,
        output_artifact_id, sanitized_error_json, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '', 'queued', 1, 1, '', '{}', ?, ?, ?)
    `).run(
      intentId,
      runId,
      input.project.project_id,
      input.shot.shot_id,
      input.provider,
      input.account_label,
      input.model,
      input.input_artifact_id,
      input.duration_seconds,
      input.resolution,
      input.estimated_cost_value,
      input.budget_limit_value,
      input.currency,
      expiresAt,
      JSON.stringify(inputData),
      now,
      now
    );
  }
  const jobId = `job_${randomUUID()}`;
  db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')").run(jobId, intentId);
  appendJobEvent(db, jobId, "", "queued", input.admission_reason_code ?? (input.generation_plan ? "T2_ADMISSION_CONFIRMED" : "HUMAN_CONFIRMED"));
  const intent = getIntent(db, intentId);
  if (!intent) throw new Error("GENERATION_INTENT_NOT_FOUND");
  const executionAuthority = createGenerationExecutionReceipt(db, executionBinding(intent, { job_id: jobId }, "queued"));
  if (!executionAuthority.ok) throw new Error(executionAuthority.error.code);
  return { intent, run_id: runId, job_id: jobId, status: "queued" };
}

function directorAutomationLink(intent: WorkbenchGenerationIntent): DirectorAutomationLink | null {
  const candidate = intent.input_snapshot.director_automation;
  if (!candidate || !candidate.reservation_id) return null;
  const amountMinor = candidate.amount_minor;
  if (![candidate.grant_id, candidate.reservation_id, candidate.proposal_id, candidate.policy_hash].every((value) => typeof value === "string" && value.length > 0)
    || typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  return {
    grant_id: candidate.grant_id,
    reservation_id: candidate.reservation_id,
    proposal_id: candidate.proposal_id,
    policy_hash: candidate.policy_hash,
    amount_minor: amountMinor
  };
}

type DirectorGrantEventType = "reserve" | "consume" | "release" | "revoke" | "expire";

interface DirectorGrantExecutionEvent {
  grant_id: string;
  event_type: DirectorGrantEventType;
  reservation_id: string;
  amount_minor: number;
  currency: string;
  intent_id: string;
  run_id: string;
}

type DirectorExecutionRequirementResolution =
  | { ok: true; required: false; automation: null; latest_event_type: null }
  | { ok: true; required: true; automation: DirectorAutomationLink; latest_event_type: DirectorGrantEventType }
  | { ok: false; error: ProviderToolError };

/**
 * Resolve the persisted Director execution requirement independently from both
 * provenance and successful snapshot parsing. The append-only Grant event is
 * the canonical durable fact; provenance/raw binding presence are fail-closed
 * compatibility evidence when that ledger fact is missing or damaged.
 */
function resolveDirectorExecutionRequirement(
  db: M0Database,
  intent: WorkbenchGenerationIntent
): DirectorExecutionRequirementResolution {
  const events = db.prepare(`SELECT grant_id, event_type, reservation_id, amount_minor, currency, intent_id, run_id
    FROM director_automation_grant_events
    WHERE intent_id = ?
    ORDER BY created_at, rowid`).all(intent.intent_id) as DirectorGrantExecutionEvent[];
  const hasRawBinding = Object.prototype.hasOwnProperty.call(intent.input_snapshot, "director_automation");
  const required = events.length > 0
    || intent.input_snapshot.prepared_by === "director_automation"
    || hasRawBinding;
  if (!required) return { ok: true, required: false, automation: null, latest_event_type: null };

  const automation = directorAutomationLink(intent);
  if (!automation || !intent.run_id) {
    return {
      ok: false,
      error: providerError(
        "DIRECTOR_AUTOMATION_BINDING_MISMATCH",
        "Director-authorized generation is missing its executable Grant reservation binding."
      )
    };
  }
  if (events.length === 0) {
    return {
      ok: false,
      error: providerError(
        "DIRECTOR_AUTOMATION_RESERVATION_INVALID",
        "Director-authorized generation is missing its durable Grant reservation event."
      )
    };
  }

  const expectedIdentity = (event: DirectorGrantExecutionEvent): boolean => event.grant_id === automation.grant_id
    && event.reservation_id === automation.reservation_id
    && Number(event.amount_minor) === automation.amount_minor
    && event.currency === intent.currency
    && event.intent_id === intent.intent_id
    && event.run_id === intent.run_id;
  const eventSequence = events.map((event) => event.event_type);
  const validLifecycle = eventSequence[0] === "reserve"
    && eventSequence.length <= 2
    && (eventSequence.length === 1 || eventSequence[1] === "consume" || eventSequence[1] === "release");
  if (!validLifecycle || !events.every(expectedIdentity)) {
    return {
      ok: false,
      error: providerError(
        "DIRECTOR_AUTOMATION_RESERVATION_INVALID",
        "Director Grant reservation events do not match this generation execution."
      )
    };
  }
  return {
    ok: true,
    required: true,
    automation,
    latest_event_type: events.at(-1)!.event_type
  };
}

function authorizeDirectorProviderExecution(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  knownTaskId: string,
  now: Date
): DirectorExecutionRequirementResolution {
  const resolution = resolveDirectorExecutionRequirement(db, intent);
  if (!resolution.ok || !resolution.required) return resolution;
  const expectedEventType: DirectorGrantEventType = knownTaskId ? "consume" : "reserve";
  if (resolution.latest_event_type !== expectedEventType) {
    return {
      ok: false,
      error: providerError(
        "DIRECTOR_AUTOMATION_RESERVATION_INVALID",
        "Director Grant reservation lifecycle does not authorize the current Provider action."
      )
    };
  }
  const requiredAction = knownTaskId ? "generation.download" : "generation.submit";
  try {
    // The worker's own queued/running projection is expected to differ from the
    // Proposal target. Every other current Grant, principal, and policy binding
    // is revalidated before Provider selection.
    const authorization = loadDirectorGrantAuthorization(
      db,
      resolution.automation,
      requiredAction,
      now,
      { verify_target_state: false }
    );
    if (authorization.grant.project_id !== intent.project_id || authorization.shot.shot_id !== intent.shot_id) {
      return {
        ok: false,
        error: providerError(
          "DIRECTOR_AUTOMATION_BINDING_MISMATCH",
          "Director Grant project or SHOT does not match this generation execution."
        )
      };
    }
  } catch (caught) {
    const code = caught instanceof Error && "code" in caught
      ? String(caught.code)
      : "DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED";
    return {
      ok: false,
      error: providerError(code, "Director Automation Grant no longer authorizes this generation action.")
    };
  }
  return resolution;
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

function normalizedProviderStatus(value: string): "SUCCESS" | "FAILED" | "CANCELLED" | "PENDING" | "RUNNING" | "UNKNOWN" {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(normalized)) return "SUCCESS";
  if (["FAILED", "FAIL", "ERROR"].includes(normalized)) return "FAILED";
  if (["CANCELLED", "CANCELED"].includes(normalized)) return "CANCELLED";
  if (["PENDING", "QUEUED", "WAITING", "CREATED"].includes(normalized)) return "PENDING";
  if (["RUNNING", "PROCESSING", "IN_PROGRESS"].includes(normalized)) return "RUNNING";
  return "UNKNOWN";
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
  input: {
    project_id: string;
    shot_id: string;
    account_label: "personal" | "team";
    budget_limit_value: number;
    model?: string;
    director_automation?: DirectorAutomationPreflightAuthorization;
  },
  db = openM0Database(),
  dependencies: WorkbenchGenerationDependencies = {}
): Promise<WorkbenchV2Result<{ intent: WorkbenchGenerationIntent }>> {
  const admissionReservation = findT2AdmissionReservation(db, input.project_id, input.shot_id);
  const directorBinding = buildDirectorAutomationBinding(input.director_automation);
  const writable = assertWorkbenchProjectWritable(db, input.project_id);
  if (!writable.ok) {
    const terminalized = admissionReservation ? terminalizeStaleT2Reservation(db, admissionReservation.intent_id) : null;
    if (terminalized) return { ok: false, error: terminalized.error };
    return writable;
  }
  const shot = getShot(db, input.shot_id);
  if (!shot || shot.project_id !== input.project_id) {
    const terminalized = admissionReservation ? terminalizeStaleT2Reservation(db, admissionReservation.intent_id) : null;
    if (terminalized) return { ok: false, error: terminalized.error };
    return { ok: false, error: { code: "SHOT_NOT_FOUND", message: "SHOT does not belong to this project.", field: "shot_id" } };
  }
  if (!Number.isFinite(input.budget_limit_value) || input.budget_limit_value <= 0) {
    return { ok: false, error: { code: "BUDGET_LIMIT_REQUIRED", message: "A positive budget limit is required.", field: "budget_limit_value" } };
  }
  const selectedModel = input.model ?? RUNNINGHUB_MODEL_ROUTE;
  if (admissionReservation && selectedModel !== RUNNINGHUB_MODEL_ROUTE) {
    return { ok: false, error: { code: "GENERATION_PLAN_MODEL_MISMATCH", message: "T2 generation admission currently authorizes the default RunningHub model only." } };
  }
  if (input.director_automation && selectedModel !== RUNNINGHUB_MODEL_ROUTE) {
    return { ok: false, error: { code: "DIRECTOR_AUTOMATION_MODEL_MISMATCH", message: "Director Automation currently authorizes the default RunningHub model only." } };
  }
  const conflict = generationRightConflict(db, admissionReservation?.intent_id ?? "");
  if (conflict) return { ok: false, error: { code: "REAL_GENERATION_ALREADY_ACTIVE", message: "Only one real generation task may run at a time." } };
  const artifact = validateActiveArtifactReference(db, {
    artifact_id: shot.storyboard_image_artifact_id, project_id: input.project_id, shot_id: shot.shot_id, role: "storyboard_image", artifact_type: "image"
  });
  if (!artifact.ok) {
    const terminalized = admissionReservation ? terminalizeStaleT2Reservation(db, admissionReservation.intent_id) : null;
    if (terminalized) return { ok: false, error: terminalized.error };
    return { ok: false, error: artifact.error };
  }
  const staleBeforeWorkflow = admissionReservation ? terminalizeStaleT2Reservation(db, admissionReservation.intent_id) : null;
  if (staleBeforeWorkflow) return { ok: false, error: staleBeforeWorkflow.error };
  const workflowGate = requireShotWorkflowWriteAction(db, writable.data.project, shot, "prepare_generation");
  if (!workflowGate.ok) return { ok: false, error: workflowGate.error };

  let directorAuthorization: ReturnType<typeof loadDirectorGrantAuthorization> | null = null;
  if (input.director_automation) {
    try {
      directorAuthorization = loadDirectorGrantAuthorization(db, input.director_automation, "generation.submit", dateNow(dependencies));
    } catch (caught) {
      const code = caught instanceof Error && "code" in caught ? String(caught.code) : "DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED";
      return { ok: false, error: { code, message: "Director Automation Grant cannot authorize generation preflight." } };
    }
    const directorCapability = selectVerifiedDirectorCapability({
      duration_seconds: shot.duration_seconds,
      resolution: writable.data.project.video_spec.resolution,
      aspect_ratio: writable.data.project.video_spec.aspect_ratio
    });
    if (!directorCapability || directorAuthorization.grant.project_id !== input.project_id || directorAuthorization.shot.shot_id !== shot.shot_id
      || directorAuthorization.grant.provider !== directorCapability.key.provider
      || directorAuthorization.grant.capability_contract_version !== directorCapability.capability.reference
      || !legacyProposalMatchesDirectorCapability(directorAuthorization.proposal.payload as Record<string, unknown>, directorCapability)
      || directorAuthorization.proposal.payload.video_prompt !== shot.video_prompt
      || directorAuthorization.proposal.payload.negative_prompt !== shot.negative_prompt) {
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_INPUT_MISMATCH", message: "Director Proposal does not exactly match the current generation inputs." } };
    }
    if (admissionReservation && directorBinding) {
      const existingBinding = admissionReservation.input_snapshot.director_automation;
      if ((existingBinding && !directorAutomationBindingMatches(existingBinding, directorBinding))
        || directorAuthorization.grant.project_id !== admissionReservation.project_id
        || directorAuthorization.shot.shot_id !== admissionReservation.shot_id) {
        return { ok: false, error: { code: "DIRECTOR_AUTOMATION_BINDING_MISMATCH", message: "Director Automation Grant does not match the adopted generation reservation." } };
      }
    }
  }

  const capability = buildProviderCapabilityKey({
    provider: "runninghub",
    model: selectedModel,
    duration_seconds: shot.duration_seconds,
    resolution: writable.data.project.video_spec.resolution,
    aspect_ratio: writable.data.project.video_spec.aspect_ratio
  });
  if (!capability.ok) {
    const terminalized = admissionReservation ? terminalizeStaleT2Reservation(db, admissionReservation.intent_id) : null;
    if (terminalized) return { ok: false, error: terminalized.error };
    return { ok: false, error: { code: capability.code, message: providerCapabilityErrorMessage(capability), field: capability.field } };
  }
  const staleBeforeProvider = admissionReservation ? terminalizeStaleT2Reservation(db, admissionReservation.intent_id) : null;
  if (staleBeforeProvider) return { ok: false, error: staleBeforeProvider.error };
  const priceCacheKey = buildProviderPriceCacheKey(capability.key, capability.capability);
  const selection = selectM1ProviderPort({ provider: "real", provider_name: "runninghub", model_name: capability.key.model, cost_acknowledged: true }, dependencies.env ?? process.env);
  if (!selection.ok) return { ok: false, error: selection.error };
  if (selection.selected.provider_name !== "runninghub" || !selection.selected.credential) {
    return { ok: false, error: { code: "PROVIDER_SELECTION_MISMATCH", message: "RunningHub must be the selected real provider." } };
  }
  const generationInput: ProviderGenerationInput = {
    storyboard_artifact: artifact.artifact,
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    duration_seconds: capability.key.duration_seconds,
    aspect_ratio: writable.data.project.video_spec.aspect_ratio,
    resolution: capability.key.resolution
  };
  const priceRequest = buildRunningHubImageToVideoSubmitRequest({ generation_input: generationInput, uploaded_download_url: "https://example.invalid/input.png", model: capability.key.model });
  if (!priceRequest.ok) return { ok: false, error: priceRequest.error };
  if (!capability.capability.price_preview_path) return { ok: false, error: { code: "PRICE_ESTIMATE_UNAVAILABLE", message: "Provider capability does not declare a price-preview route." } };
  const credential = selection.selected.credential;
  const price = await fetchJson(`${RUNNINGHUB_API_BASE_URL}${capability.capability.price_preview_path}`, {
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
  if (directorAuthorization) {
    const allowedProviderAmount = directorMinorToProviderAmount(directorAuthorization.grant.max_per_run_minor, currency);
    const officialMinor = directorProviderAmountToMinor(estimatedPrice, currency);
    if (currency !== directorAuthorization.grant.currency || allowedProviderAmount === null || officialMinor === null
      || input.budget_limit_value > allowedProviderAmount || officialMinor > directorAuthorization.grant.max_per_run_minor) {
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_BUDGET_DENIED", message: "Official generation estimate is outside the Automation Grant budget." } };
    }
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
  const accountBalance = resolveRunningHubComparableBalance(account.payload, currency);
  const balanceEnough = accountBalance !== null && accountBalance.value >= estimatedPrice;
  if (!balanceEnough) return { ok: false, error: { code: "BALANCE_GATE_UNKNOWN_OR_INSUFFICIENT", message: "RunningHub balance could not be verified as sufficient." } };

  const createdAt = dateNow(dependencies);
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);
  const intentId = admissionReservation?.intent_id ?? `intent_${randomUUID()}`;
  const inputSnapshot: WorkbenchGenerationIntent["input_snapshot"] = admissionReservation
    ? {
      ...admissionReservation.input_snapshot,
      price_source: "runninghub_price_preview",
      balance_gate: "pass",
      account_balance_value: accountBalance.value,
      account_balance_currency: accountBalance.currency,
      requires_human_preflight: false,
      capability_key: capability.key.serialized,
      ...(directorBinding ? { director_automation: directorBinding } : {})
    }
    : {
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt,
      aspect_ratio: writable.data.project.video_spec.aspect_ratio,
      project_resolution: writable.data.project.video_spec.resolution,
      price_source: "runninghub_price_preview",
      balance_gate: "pass",
      account_balance_value: accountBalance.value,
      account_balance_currency: accountBalance.currency,
      requires_human_preflight: false,
      prepared_by: input.director_automation ? "director_automation" : "human_workbench",
      capability_key: capability.key.serialized,
      ...(directorBinding ? { director_automation: directorBinding } : {})
    };
  db.prepare(`
    INSERT INTO webgpt_provider_price_cache (
      provider, model, duration_seconds, resolution, estimated_cost_value, currency,
      source, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, model, duration_seconds, resolution) DO UPDATE SET
      estimated_cost_value = excluded.estimated_cost_value,
      currency = excluded.currency,
      source = excluded.source,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(
    priceCacheKey.provider,
    priceCacheKey.model,
    priceCacheKey.duration_seconds,
    priceCacheKey.storage_resolution,
    estimatedPrice,
    currency,
    priceCacheKey.source,
    createdAt.toISOString(),
    new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
  );
  if (admissionReservation) {
    const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string } | undefined;
    if (!row) return { ok: false, error: { code: "GENERATION_INTENT_NOT_FOUND", message: "Generation admission reservation was not found." } };
    const data = parseRecord(row.data_json);
    data.input_snapshot = inputSnapshot;
    const updated = db.prepare(`
      UPDATE generation_intents
      SET account_label = ?, estimated_cost_value = ?, budget_limit_value = ?, currency = ?, expires_at = ?, data_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE intent_id = ? AND status = 'prepared' AND confirmed = 0 AND (run_id IS NULL OR run_id = '')
    `).run(
      input.account_label,
      estimatedPrice,
      input.budget_limit_value,
      currency,
      expiresAt.toISOString(),
      JSON.stringify(data),
      intentId
    ) as { changes: number | bigint };
    if (Number(updated.changes) !== 1) return { ok: false, error: { code: "GENERATION_ADMISSION_CONFLICT", message: "Generation admission reservation changed before preflight completion." } };
  } else {
    db.prepare(`
      INSERT INTO generation_intents (
        intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
        duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
        confirmed, expires_at, status, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'runninghub', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'prepared', ?, ?, ?)
    `).run(
      intentId, input.project_id, input.shot_id, input.account_label, capability.key.model, artifact.artifact.artifact_id,
      capability.key.duration_seconds, capability.key.resolution, estimatedPrice, input.budget_limit_value, currency,
      expiresAt.toISOString(), JSON.stringify({ input_snapshot: inputSnapshot }), createdAt.toISOString(), createdAt.toISOString()
    );
  }
  return { ok: true, data: { intent: getIntent(db, intentId) as WorkbenchGenerationIntent } };
}

/**
 * A Director preflight is only a short-lived staging record until the normal
 * confirmation transaction commits.  If that confirmation rejects it, mark
 * precisely that unconfirmed, unreserved staging record terminal so it cannot
 * become false authoritative drift for the same immutable Grant.
 */
export function discardDirectorPreparedGenerationIntent(
  input: {
    intent_id: string;
    director_automation: DirectorAutomationPreflightAuthorization;
    cleanup_error?: { code: string; message: string; retryable?: boolean };
  },
  db = openM0Database()
): WorkbenchV2Result<{ intent: WorkbenchGenerationIntent }> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const intent = getIntent(db, input.intent_id);
    const binding = intent?.input_snapshot.director_automation;
    const bindingMatches = Boolean(binding) && directorAutomationBindingMatches(binding, input.director_automation);
    const isDirectorPreparedIntent = intent?.input_snapshot.prepared_by === "director_automation";
    const isAdoptedT2Reservation = intent?.input_snapshot.prepared_by === "t2_admission"
      && intent.input_snapshot.admission_only === true;
    const isOwnedPreparedIntent = isDirectorPreparedIntent || isAdoptedT2Reservation;
    if (!intent || !isOwnedPreparedIntent || !bindingMatches
      || (binding?.reservation_id !== undefined)
      || (binding?.amount_minor !== undefined)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_PREPARED_INTENT_NOT_CANCELLABLE", message: "Director preflight staging record is no longer safe to discard." } };
    }
    if (intent.status === "cancelled") {
      db.exec("ROLLBACK");
      return { ok: true, data: { intent } };
    }
    if (intent.status !== "prepared" || intent.confirmed || intent.run_id || intent.provider_task_id || jobForIntent(db, intent.intent_id)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_PREPARED_INTENT_NOT_CANCELLABLE", message: "Director preflight staging record changed before it could be discarded." } };
    }
    const terminalized = terminalizePreparedIntentInTransaction(db, intent, input.cleanup_error ?? {
      code: "DIRECTOR_AUTOMATION_CONFIRMATION_FAILED",
      message: "Director confirmation failed after adopting the prepared generation reservation."
    });
    if (!terminalized) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_PREPARED_INTENT_NOT_CANCELLABLE", message: "Director preflight staging record changed before it could be discarded." } };
    }
    db.exec("COMMIT");
    return { ok: true, data: { intent: terminalized } };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function cancelPreparedGenerationIntent(
  input: { intent_id: string; human_confirmation: boolean },
  db = openM0Database()
): WorkbenchV2Result<{ intent: WorkbenchGenerationIntent }> {
  if (input.human_confirmation !== true) {
    return { ok: false, error: { code: "GENERATION_CONFIRMATION_REQUIRED", message: "Human confirmation is required." } };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const intent = getIntent(db, input.intent_id);
    if (!intent) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_NOT_FOUND", message: "Generation intent was not found." } };
    }
    if (intent.input_snapshot.prepared_by === "director_automation") {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_PREPARED_INTENT_NOT_CANCELLABLE", message: "Director-prepared generation must use its bound Automation Grant cancellation path." } };
    }
    if (intent.status !== "prepared" || intent.confirmed || intent.run_id || intent.provider_task_id || jobForIntent(db, intent.intent_id)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_NOT_CANCELLABLE", message: "Only an unpromoted prepared generation intent can be cancelled." } };
    }
    const cancelled = terminalizePreparedIntentInTransaction(db, intent, {
      code: "GENERATION_INTENT_CANCELLED",
      message: "Prepared generation reservation was explicitly cancelled."
    });
    if (!cancelled) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_NOT_CANCELLABLE", message: "Generation intent changed before cancellation completed." } };
    }
    db.exec("COMMIT");
    return { ok: true, data: { intent: cancelled } };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function confirmWorkbenchGeneration(
  input: {
    intent_id: string;
    budget_limit_value: number;
    cost_confirmed: boolean;
    human_confirmation: boolean;
    director_automation?: DirectorAutomationPreflightAuthorization;
  },
  db = openM0Database(),
  dependencies: WorkbenchGenerationDependencies = {}
): WorkbenchV2Result<{ intent: WorkbenchGenerationIntent; run_id: string; job_id: string; status: "queued" }> {
  if (!input.director_automation && (input.cost_confirmed !== true || input.human_confirmation !== true)) {
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
    const snapshotAutomation = intent.input_snapshot.director_automation;
    if (snapshotAutomation && !input.director_automation) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_CONFIRMATION_REQUIRED", message: "Director-prepared generation must be confirmed through its bound Automation Grant." } };
    }
    if (input.director_automation && !directorAutomationBindingMatches(snapshotAutomation, input.director_automation)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_BINDING_MISMATCH", message: "Director Automation Grant does not match this prepared intent." } };
    }
    const planRevalidation = revalidatePreparedGenerationPlan(db, intent);
    if (!planRevalidation.ok) {
      const retired = terminalizeT2PreparedIntentIfStaleInTransaction(db, intent, {
        code: "GENERATION_PLAN_STALE",
        message: planRevalidation.message
      });
      if (!retired) throw new Error("GENERATION_RESERVATION_NOT_CANCELLABLE");
      db.exec("COMMIT");
      return { ok: false, error: retired.error };
    }
    if (!isProviderExecutionAuthorized(intent)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "OFFICIAL_PREFLIGHT_REQUIRED", message: "Run a fresh official preflight in the human workbench before confirmation." } };
    }
    const capability = buildProviderCapabilityKey({
      provider: "runninghub",
      model: intent.model,
      duration_seconds: intent.duration_seconds,
      resolution: intent.resolution,
      aspect_ratio: intent.input_snapshot.aspect_ratio
    });
    if (!capability.ok || (intent.input_snapshot.capability_key && intent.input_snapshot.capability_key !== capability.key.serialized)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "PROVIDER_CAPABILITY_CONTRACT_MISMATCH", message: "Generation intent no longer matches the declared Provider capability." } };
    }
    if (dateNow(dependencies).getTime() >= Date.parse(intent.expires_at)) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_EXPIRED", message: "Generation preflight has expired." } };
    }
    if (!Number.isFinite(input.budget_limit_value) || input.budget_limit_value < intent.estimated_cost_value) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "BUDGET_LIMIT_EXCEEDED", message: "Budget limit is below the official estimate." } };
    }
    const conflict = generationRightConflict(db, intent.intent_id);
    if (conflict) {
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
    const workflowGate = requireShotWorkflowWriteAction(db, writable.data.project, shot, "confirm_generation");
    if (!workflowGate.ok) {
      db.exec("ROLLBACK");
      return { ok: false, error: workflowGate.error };
    }
    if (shot.storyboard_image_artifact_id !== intent.input_artifact_id
      || shot.video_prompt !== intent.input_snapshot.video_prompt
      || shot.negative_prompt !== intent.input_snapshot.negative_prompt
      || shot.duration_seconds !== intent.duration_seconds
      || writable.data.project.video_spec.aspect_ratio !== intent.input_snapshot.aspect_ratio
      || intent.input_snapshot.project_resolution === undefined
      || writable.data.project.video_spec.resolution !== intent.input_snapshot.project_resolution) {
      if (isT2AdmissionReservation(intent)) {
        const retired = terminalizeT2PreparedIntentIfStaleInTransaction(db, intent);
        if (!retired) throw new Error("GENERATION_RESERVATION_NOT_CANCELLABLE");
        db.exec("COMMIT");
        return { ok: false, error: retired.error };
      }
      db.exec("ROLLBACK");
      return { ok: false, error: { code: "GENERATION_INTENT_INPUT_STALE", message: "SHOT or project inputs changed after generation preflight." } };
    }
    let directorReservation: DirectorAutomationLink | null = null;
    let directorReservationAmount: number | null = null;
    if (input.director_automation) {
      let authorization: ReturnType<typeof loadDirectorGrantAuthorization>;
      try {
        // Preflight has just recorded this same intent as prepared. Rechecking its
        // generation projection would mistake our own non-submitting preflight
        // evidence for external drift; all other current bindings are checked here.
        authorization = loadDirectorGrantAuthorization(db, input.director_automation, "generation.submit", dateNow(dependencies), { verify_target_state: false });
      } catch (caught) {
        db.exec("ROLLBACK");
        const code = caught instanceof Error && "code" in caught ? String(caught.code) : "DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED";
        return { ok: false, error: { code, message: "Director Automation Grant cannot confirm this generation." } };
      }
      const officialMinor = directorProviderAmountToMinor(intent.estimated_cost_value, intent.currency);
      const allowedProviderAmount = directorMinorToProviderAmount(authorization.grant.max_per_run_minor, intent.currency);
      if (officialMinor === null || intent.currency !== authorization.grant.currency || allowedProviderAmount === null
        || input.budget_limit_value > allowedProviderAmount || officialMinor > authorization.grant.max_per_run_minor) {
        db.exec("ROLLBACK");
        return { ok: false, error: { code: "DIRECTOR_AUTOMATION_BUDGET_DENIED", message: "Official generation estimate is outside the Automation Grant budget." } };
      }
      directorReservationAmount = officialMinor;
    }
    const runId = `run_${randomUUID()}`;
    const intentDataRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intent.intent_id) as { data_json: string };
    const intentData = parseRecord(intentDataRow.data_json);
    intentData.reconciliation_restore = { shot_status: shot.status, project_status: writable.data.project.status };
    if (input.director_automation) {
      try {
        const authorization = loadDirectorGrantAuthorization(db, input.director_automation, "generation.submit", dateNow(dependencies), { verify_target_state: false });
        if (directorReservationAmount === null) {
          db.exec("ROLLBACK");
          return { ok: false, error: { code: "DIRECTOR_AUTOMATION_BUDGET_DENIED", message: "Official generation estimate cannot be represented by the Automation Grant currency contract." } };
        }
        directorReservation = {
          ...reserveDirectorGrant(db, authorization, {
          amount_minor: directorReservationAmount,
          currency: intent.currency,
          intent_id: intent.intent_id,
          run_id: runId,
          now: dateNow(dependencies)
          }),
          amount_minor: directorReservationAmount
        };
      } catch (caught) {
        db.exec("ROLLBACK");
        const code = caught instanceof Error && "code" in caught ? String(caught.code) : "DIRECTOR_AUTOMATION_RESERVATION_FAILED";
        return { ok: false, error: { code, message: "Automation Grant budget could not be reserved." } };
      }
      const rawSnapshot = intentData.input_snapshot && typeof intentData.input_snapshot === "object" && !Array.isArray(intentData.input_snapshot)
        ? intentData.input_snapshot as Record<string, unknown>
        : {};
      rawSnapshot.director_automation = directorReservation;
      intentData.input_snapshot = rawSnapshot;
    }
    const committed = commitCanonicalGenerationAdmission({
      project: writable.data.project,
      shot,
      provider: "runninghub",
      model: intent.model,
      input_artifact_id: intent.input_artifact_id,
      duration_seconds: intent.duration_seconds,
      resolution: intent.resolution,
      input_snapshot: intentData.input_snapshot as WorkbenchGenerationIntent["input_snapshot"],
      account_label: intent.account_label,
      estimated_cost_value: intent.estimated_cost_value,
      budget_limit_value: input.budget_limit_value,
      currency: intent.currency,
      existing_prepared_intent_id: intent.intent_id,
      run_id: runId,
      existing_data: intentData,
      admission_reason_code: input.director_automation ? "DIRECTOR_GRANT_CONFIRMED" : "HUMAN_CONFIRMED"
    }, db);
    db.exec("COMMIT");
    return {
      ok: true,
      data: {
        intent: committed.intent,
        run_id: committed.run_id,
        job_id: committed.job_id,
        status: "queued"
      }
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function failIntent(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  status: "failed" | "timeout",
  error: ProviderToolError | { code: string; message: string; retryable?: boolean },
  leaseToken: string,
  expectedJob?: GenerationJob
): boolean {
  const safe = sanitizedError(error);
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentJob = jobForIntent(db, intent.intent_id);
    if (!currentJob || (expectedJob && currentJob.state !== expectedJob.state)) {
      db.exec("ROLLBACK");
      return false;
    }
    const automation = directorAutomationLink(intent);
    if (automation && intent.run_id) {
      releaseDirectorGrantReservation(db, automation, {
        amount_minor: automation.amount_minor!,
        currency: intent.currency,
        intent_id: intent.intent_id,
        run_id: intent.run_id,
        reason_code: "DIRECTOR_AUTOMATION_PRE_SUBMIT_FAILED"
      });
    }
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
    if (getGenerationExecutionReceipt(db, intent.intent_id)) {
      transitionGenerationExecutionReceipt(db, intent.intent_id, { state: "failed" });
    }
    restoreProjectAfterGenerationAutomationStops(db, intent);
    setJobState(db, expectedJob ?? currentJob, "failed", String(safe.code ?? "PROVIDER_REQUEST_FAILED"), {
      lease_token: leaseToken,
      in_transaction: true
    });
    db.exec("COMMIT");
    return true;
  } catch (failure) {
    db.exec("ROLLBACK");
    throw failure;
  }
}

/**
 * A Director Grant may retry only a provider response that explicitly says it
 * is retryable *and* has already established that no remote task exists.  It
 * deliberately does not retry ambiguous submission outcomes: those require
 * human reconciliation because another request could create a duplicate paid
 * task.
 */
function queueDirectorKnownNoSubmitRetry(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  job: GenerationJob,
  automation: DirectorAutomationLink | null,
  leaseToken: string,
  dependencies: WorkbenchGenerationDependencies
): { queued: true } | { queued: false; error?: ProviderToolError } {
  if (!automation) return { queued: false };
  const priorRetries = db.prepare(`SELECT COUNT(*) AS count FROM generation_job_events
    WHERE job_id = ? AND reason_code = 'DIRECTOR_AUTOMATION_SUBMIT_RETRY'`).get(job.job_id) as { count: number };
  let authorization: ReturnType<typeof loadDirectorGrantAuthorization>;
  try {
    authorization = loadDirectorGrantAuthorization(
      db,
      automation,
      "generation.submit",
      dateNow(dependencies),
      { verify_target_state: false }
    );
  } catch (caught) {
    const code = caught instanceof Error && "code" in caught ? String(caught.code) : "DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED";
    return { queued: false, error: providerError(code, "Director Automation Grant no longer authorizes a retry.") };
  }
  if (Number(priorRetries.count) >= authorization.grant.max_automatic_retries) return { queued: false };
  if (!authorization.grant.allowed_actions.includes("generation.retry")) {
    return { queued: false, error: providerError("DIRECTOR_AUTOMATION_ACTION_DENIED", "Director Automation Grant does not allow automatic retry.") };
  }
  const retryOrdinal = Number(priorRetries.count) + 1;
  // The normal default is five seconds, then bounded exponential backoff. A
  // shorter injected poll interval is a deterministic test seam only.
  const delayMs = Math.min(60_000, Math.max(10, dependencies.poll_interval_ms ?? 5_000) * (2 ** (retryOrdinal - 1)));
  db.exec("BEGIN IMMEDIATE");
  try {
    assertJobLease(db, job.job_id, leaseToken);
    setJobState(db, job, "queued", "DIRECTOR_AUTOMATION_SUBMIT_RETRY", { lease_token: leaseToken, in_transaction: true });
    db.prepare(`UPDATE generation_jobs SET next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND lease_token = ?`).run(new Date(Date.now() + delayMs).toISOString(), job.job_id, leaseToken);
    db.exec("COMMIT");
    return { queued: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function restoreProjectAfterGenerationAutomationStops(db: M0Database, intent: WorkbenchGenerationIntent): void {
  const shot = getShot(db, intent.shot_id);
  const project = getProject(db, intent.project_id);
  if (!shot || !project) return;
  const restore = reconciliationRestoreState(db, intent.intent_id);
  shot.status = shot.clip_versions.length > 0 ? "revision_needed" : restore.shot_status;
  saveShot(db, shot);
  const shots = listProjectShots(db, project.project_id);
  project.status = shots.some((candidate) => candidate.status === "video_pending")
    ? "video_generation_in_progress"
    : shots.some((candidate) => candidate.clip_versions.length > 0 || ["video_review", "video_generated", "approved", "revision_needed"].includes(candidate.status))
      ? "video_review"
      : restore.project_status;
  saveProject(db, project);
}

function markProjectAndShotGenerationActive(db: M0Database, intent: WorkbenchGenerationIntent): void {
  const shot = getShot(db, intent.shot_id);
  const project = getProject(db, intent.project_id);
  if (!shot || !project) throw new Error("GENERATION_WORKFLOW_STATE_MISSING");
  shot.status = "video_pending";
  saveShot(db, shot);
  project.status = "video_generation_in_progress";
  saveProject(db, project);
}

function markUnknownSubmission(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  job: GenerationJob,
  error: ProviderToolError,
  leaseToken?: string
): GenerationJob {
  const safe = sanitizedError(error);
  const persist = (recordEvent: boolean): GenerationJob => {
    db.prepare("UPDATE generation_intents SET status = 'running', sanitized_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?")
      .run(JSON.stringify(safe), intent.intent_id);
    const run = getGenerationRun(db, intent.run_id);
    if (run) {
      run.status = "running";
      run.provider.provider_status = "SUBMIT_OUTCOME_UNKNOWN";
      run.error = { code: String(safe.code ?? "PROVIDER_REQUEST_FAILED"), message: "Provider submission outcome requires human reconciliation.", retryable: false };
      saveGenerationRun(db, run);
    }
    if (getGenerationExecutionReceipt(db, intent.intent_id)) {
      transitionGenerationExecutionReceipt(db, intent.intent_id, { state: "ambiguous" });
    }
    restoreProjectAfterGenerationAutomationStops(db, intent);
    return enterManualReconciliationJob(db, job, "PROVIDER_SUBMIT_OUTCOME_UNKNOWN", {
      ...(leaseToken ? { lease_token: leaseToken } : {}),
      record_event: recordEvent
    });
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = persist(true);
    db.exec("COMMIT");
    return updated;
  } catch (failure) {
    db.exec("ROLLBACK");
    db.exec("BEGIN IMMEDIATE");
    try {
      const updated = persist(false);
      db.exec("COMMIT");
      return updated;
    } catch (fallbackError) {
      db.exec("ROLLBACK");
      throw fallbackError;
    }
  }
}

function markKnownProviderTaskForReconciliation(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  job: GenerationJob,
  taskId: string,
  error: ProviderToolError | { code: string; message: string; retryable?: boolean },
  leaseToken: string,
  reasonCode: string
): GenerationJob {
  const safe = sanitizedError(error);
  const automation = directorAutomationLink(intent);
  const recordPaidDirectorSubmission = (): void => {
    if (!automation || !intent.run_id) return;
    // The Provider task is already known to exist.  This must be durably
    // consumed even when the preceding normal persistence transaction rolled
    // back, otherwise a paid task would remain only reserved in the Grant
    // ledger.  consumeDirectorGrantReservation is deliberately idempotent for
    // the exact reservation so later reconciliation paths cannot double spend.
    consumeDirectorGrantReservation(db, automation, {
      amount_minor: automation.amount_minor!,
      currency: intent.currency,
      intent_id: intent.intent_id,
      run_id: intent.run_id,
      reason_code: "DIRECTOR_AUTOMATION_SUBMITTED_RECONCILED"
    });
  };
  const persist = (withEvent: boolean): GenerationJob => {
    recordPaidDirectorSubmission();
    db.prepare("UPDATE generation_intents SET provider_task_id = ?, status = 'running', sanitized_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?")
      .run(taskId, JSON.stringify(safe), intent.intent_id);
    const run = getGenerationRun(db, intent.run_id);
    if (run) {
      run.status = "running";
      run.provider.provider_job_id = taskId;
      run.provider.provider_status = reasonCode;
      run.error = { code: String(safe.code ?? reasonCode), message: "Provider task requires human reconciliation.", retryable: false };
      saveGenerationRun(db, run);
    }
    if (getGenerationExecutionReceipt(db, intent.intent_id)) {
      transitionGenerationExecutionReceipt(db, intent.intent_id, {
        state: "reconciling",
        provider_task_id: taskId,
        provider_status: reasonCode
      });
    }
    restoreProjectAfterGenerationAutomationStops(db, intent);
    return enterManualReconciliationJob(db, job, reasonCode, { lease_token: leaseToken, record_event: withEvent });
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = persist(true);
    db.exec("COMMIT");
    return updated;
  } catch {
    db.exec("ROLLBACK");
    // First commit the known external identity without depending on accounting,
    // Run projection, Project restoration, or an optional Job event. Those
    // enrichments must never be able to erase an already-created paid task.
    db.exec("BEGIN IMMEDIATE");
    try {
      const persistedTask = db.prepare(`UPDATE generation_intents
        SET provider_task_id = ?, status = 'running', sanitized_error_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE intent_id = ? AND (provider_task_id = '' OR provider_task_id = ?)`)
        .run(taskId, JSON.stringify(safe), intent.intent_id, taskId) as { changes: number | bigint };
      if (Number(persistedTask.changes) !== 1) throw new Error("PROVIDER_TASK_IDENTITY_CONFLICT");
      transitionGenerationExecutionReceipt(db, intent.intent_id, {
        state: "reconciling",
        provider_task_id: taskId,
        provider_status: reasonCode
      });
      db.exec("COMMIT");

      // The external task identity is now durable. Job ownership is a separate
      // compare-and-set: a replacement worker may have acquired the same stage
      // after the failed transaction rolled back, and this worker must not
      // clear that owner's live lease merely to project reconciliation state.
      let finalJob = jobForIntent(db, intent.intent_id) ?? job;
      let jobTransitionedToManual = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        finalJob = enterManualReconciliationJob(db, job, reasonCode, {
          lease_token: leaseToken,
          record_event: false
        });
        db.exec("COMMIT");
        jobTransitionedToManual = true;
      } catch (jobTransitionFailure) {
        try { db.exec("ROLLBACK"); } catch { /* transaction may already have rolled back */ }
        if (!(jobTransitionFailure instanceof GenerationJobLeaseLostError)) throw jobTransitionFailure;
        finalJob = jobForIntent(db, intent.intent_id) ?? finalJob;
      }
      try {
        db.exec("BEGIN IMMEDIATE");
        recordPaidDirectorSubmission();
        if (jobTransitionedToManual) {
          const run = getGenerationRun(db, intent.run_id);
          if (run) {
            run.status = "running";
            run.provider.provider_job_id = taskId;
            run.provider.provider_status = reasonCode;
            run.error = { code: String(safe.code ?? reasonCode), message: "Provider task requires human reconciliation.", retryable: false };
            saveGenerationRun(db, run);
          }
          restoreProjectAfterGenerationAutomationStops(db, intent);
        }
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* transaction may already have rolled back */ }
        if (automation) {
          const accountingReason = "DIRECTOR_ACCOUNTING_REQUIRES_RECONCILIATION";
          const accountingError = sanitizedError(providerError(
            accountingReason,
            "Director accounting could not be settled after Provider task creation."
          ));
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("UPDATE generation_intents SET sanitized_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ? AND provider_task_id = ?")
              .run(JSON.stringify(accountingError), intent.intent_id, taskId);
            transitionGenerationExecutionReceipt(db, intent.intent_id, {
              state: "reconciling",
              provider_task_id: taskId,
              provider_status: accountingReason
            });
            db.prepare(`UPDATE generation_jobs
              SET reconciliation_reason = ?, updated_at = CURRENT_TIMESTAMP
              WHERE job_id = ? AND state = 'manual_reconciliation'
                AND lease_owner = '' AND lease_token = '' AND lease_expires_at IS NULL`)
              .run(accountingReason, finalJob.job_id);
            db.exec("COMMIT");
            finalJob = jobForIntent(db, intent.intent_id) ?? finalJob;
          } catch (accountingFailure) {
            db.exec("ROLLBACK");
            throw accountingFailure;
          }
        }
      }
      return finalJob;
    } catch (fallbackError) {
      try { db.exec("ROLLBACK"); } catch { /* identity transaction may already have committed */ }
      throw fallbackError;
    }
  }
}

function cancelIntent(db: M0Database, intent: WorkbenchGenerationIntent, reason: string, leaseToken: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE generation_intents SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?").run(intent.intent_id);
    const run = getGenerationRun(db, intent.run_id);
    if (run) { run.status = "cancelled"; saveGenerationRun(db, run); }
    if (getGenerationExecutionReceipt(db, intent.intent_id)) {
      transitionGenerationExecutionReceipt(db, intent.intent_id, { state: "cancelled" });
    }
    restoreProjectAfterGenerationAutomationStops(db, intent);
    const job = jobForIntent(db, intent.intent_id);
    if (job) setJobState(db, job, "cancelled", reason, { lease_token: leaseToken, in_transaction: true });
    db.exec("COMMIT");
  } catch (failure) {
    db.exec("ROLLBACK");
    throw failure;
  }
}

interface ProviderOutputRecovery {
  version: 1;
  provider_task_id: string;
  invalid_artifact_id: string;
  local_identity: string;
  requested_at: string;
}

type ExistingOutputArtifactResult =
  | { ok: true; artifact: MediaArtifact | null }
  | { ok: false; error: ProviderToolError; invalid_artifact_id?: string };

function providerOutputArtifactByIdentity(
  db: M0Database,
  providerOutputIdentity: string,
  projectId: string,
  shotId: string,
  execution: { intent_id: string; provider_task_id: string }
): ExistingOutputArtifactResult {
  let row: { artifact_id: string } | undefined;
  try {
    row = db.prepare(`SELECT artifact_id FROM media_artifacts
      WHERE json_valid(data_json) = 1
        AND json_extract(data_json, '$.source.provider') = 'runninghub'
        AND json_extract(data_json, '$.source.provider_job_id') = ?
        AND project_id = ? AND shot_id = ? LIMIT 1`).get(providerOutputIdentity, projectId, shotId) as { artifact_id: string } | undefined;
  } catch {
    return {
      ok: false,
      error: providerError("ARTIFACT_REFERENCE_CHECK_FAILED", "Existing Provider output Artifact lookup could not be verified.")
    };
  }
  if (!row) return { ok: true, artifact: null };
  const validated = validateActiveArtifactReference(db, {
    artifact_id: row.artifact_id,
    project_id: projectId,
    shot_id: shotId,
    role: "generated_clip",
    artifact_type: "video"
  });
  if (!validated.ok) {
    return {
      ok: false,
      error: providerError(validated.error.code, "Existing Provider output Artifact failed active media validation."),
      invalid_artifact_id: row.artifact_id
    };
  }
  const activationAttestation = db.prepare(`SELECT result_artifact_id FROM generation_execution_receipts
    WHERE intent_id = ? AND project_id = ? AND shot_id = ? AND provider_task_id = ?
      AND state = 'succeeded' AND result_artifact_id = ?`).get(
    execution.intent_id,
    projectId,
    shotId,
    execution.provider_task_id,
    row.artifact_id
  ) as { result_artifact_id: string } | undefined;
  if (!activationAttestation) {
    return {
      ok: false,
      error: providerError(
        "PROVIDER_OUTPUT_ACTIVATION_UNATTESTED",
        "Existing Provider output lacks a committed worker activation attestation."
      ),
      invalid_artifact_id: row.artifact_id
    };
  }
  return { ok: true, artifact: validated.artifact };
}

function existingOutputArtifact(
  db: M0Database,
  providerTaskId: string,
  projectId: string,
  shotId: string,
  intentId: string
): ExistingOutputArtifactResult {
  return providerOutputArtifactByIdentity(db, providerTaskId, projectId, shotId, {
    intent_id: intentId,
    provider_task_id: providerTaskId
  });
}

function quarantineUntrustedDownloadedArtifact(
  db: M0Database,
  artifactId: string,
  intent: WorkbenchGenerationIntent,
  providerTaskId: string,
  requestedAt: Date
): { ok: true } | { ok: false; error: ProviderToolError } {
  if (typeof artifactId !== "string" || artifactId.length < 3 || artifactId.length > 300) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_BINDING_INVALID", "Downloader returned an invalid Artifact identity.") };
  }
  const candidate = validateActiveArtifactReference(db, {
    artifact_id: artifactId,
    project_id: intent.project_id,
    shot_id: intent.shot_id,
    role: "generated_clip",
    artifact_type: "video"
  });
  if (!candidate.ok
    || candidate.artifact.source.provider !== intent.provider
    || candidate.artifact.source.provider_job_id !== providerTaskId) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_BINDING_INVALID", "Downloader returned an Artifact outside the current execution binding.") };
  }
  const persistedRecovery = providerOutputRecoveryFromIntent(db, intent.intent_id, providerTaskId);
  if (!persistedRecovery.ok) return persistedRecovery;
  if (!persistedRecovery.recovery) {
    db.exec("BEGIN IMMEDIATE");
    try {
      persistProviderOutputRecovery(db, intent.intent_id, {
        version: 1,
        provider_task_id: providerTaskId,
        invalid_artifact_id: candidate.artifact.artifact_id,
        local_identity: `local_recovery_${randomUUID()}`,
        requested_at: requestedAt.toISOString()
      });
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original stable failure */ }
      return { ok: false, error: providerError("ARTIFACT_RECOVERY_STATE_INVALID", "Untrusted Provider output could not be bound to durable recovery state.") };
    }
  }
  const archived = transitionMediaArtifactStatus(candidate.artifact.artifact_id, "archived", db);
  if (!archived.ok) {
    return { ok: false, error: providerError("PROVIDER_OUTPUT_QUARANTINE_FAILED", "Untrusted Provider output could not be archived and remains recovery-bound.") };
  }
  return { ok: true };
}

function providerOutputActivationBindingError(
  activationInput: ActivateLocalMediaArtifactInput,
  intent: WorkbenchGenerationIntent,
  providerOutputIdentity: string,
  expectedStorageDirectory: string
): ProviderToolError | null {
  const artifact = activationInput.artifact;
  const expectedArtifactId = `artifact_${createHash("sha256")
    .update(`${intent.provider}\0${providerOutputIdentity}`)
    .digest("hex")}`;
  const mediaRoot = expectedStorageDirectory.trim() ? resolve(expectedStorageDirectory) : "";
  const suppliedMediaRoot = activationInput.media_root ? resolve(activationInput.media_root) : "";
  const artifactPath = resolve(artifact.storage.uri);
  const sourcePath = resolve(activationInput.source_path);
  const artifactRelative = mediaRoot ? relative(mediaRoot, artifactPath) : "..";
  const sourceRelative = mediaRoot ? relative(mediaRoot, sourcePath) : "..";
  const insideMediaRoot = (value: string): boolean => value === "" || (!value.startsWith("..") && !isAbsolute(value));
  const expectedResolution = parseAssemblyResolution(
    intent.input_snapshot.project_resolution ?? "",
    intent.input_snapshot.aspect_ratio
  );
  const probed = validateMp4File(sourcePath);
  const durationToleranceSeconds = Math.max(0.25, intent.duration_seconds * 0.02);
  if (artifact.artifact_id !== expectedArtifactId
    || artifact.blob_id !== ""
    || artifact.artifact_type !== "video"
    || artifact.role !== "generated_clip"
    || artifact.status !== "active"
    || artifact.linked_objects.project_id !== intent.project_id
    || artifact.linked_objects.shot_id !== intent.shot_id
    || artifact.source.kind !== "provider_output_file"
    || artifact.source.provider !== intent.provider
    || artifact.source.provider_job_id !== providerOutputIdentity
    || artifact.storage.filename !== `${expectedArtifactId}.mp4`
    || !artifact.storage.mime_type.toLowerCase().startsWith("video/")
    || artifact.metadata.aspect_ratio !== intent.input_snapshot.aspect_ratio
    || !expectedResolution
    || artifact.metadata.width !== expectedResolution.width
    || artifact.metadata.height !== expectedResolution.height
    || probed.status !== "PASS"
    || probed.width !== expectedResolution.width
    || probed.height !== expectedResolution.height
    || probed.duration_seconds === null
    || Math.abs(probed.duration_seconds - intent.duration_seconds) > durationToleranceSeconds
    || artifact.metadata.duration_seconds === null
    || Math.abs(artifact.metadata.duration_seconds - probed.duration_seconds) > durationToleranceSeconds
    || !mediaRoot
    || suppliedMediaRoot !== mediaRoot
    || artifactPath !== resolve(mediaRoot, `${expectedArtifactId}.mp4`)
    || !insideMediaRoot(artifactRelative)
    || !insideMediaRoot(sourceRelative)
    || activationInput.allow_status_transition === true) {
    return providerError("PROVIDER_OUTPUT_BINDING_INVALID", "Provider output activation input does not match the current execution binding.");
  }
  return null;
}

function providerOutputRecoveryFromIntent(
  db: M0Database,
  intentId: string,
  providerTaskId: string
): { ok: true; recovery: ProviderOutputRecovery | null } | { ok: false; error: ProviderToolError } {
  const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string } | undefined;
  if (!row) {
    return { ok: false, error: providerError("ARTIFACT_RECOVERY_STATE_INVALID", "Provider output recovery state could not be verified.") };
  }
  const data = parseRecord(row.data_json);
  if (data.provider_output_recovery === undefined) return { ok: true, recovery: null };
  if (!data.provider_output_recovery
    || typeof data.provider_output_recovery !== "object"
    || Array.isArray(data.provider_output_recovery)) {
    return { ok: false, error: providerError("ARTIFACT_RECOVERY_STATE_INVALID", "Provider output recovery state could not be verified.") };
  }
  const recovery = data.provider_output_recovery as Record<string, unknown>;
  if (recovery.version !== 1
    || recovery.provider_task_id !== providerTaskId
    || typeof recovery.invalid_artifact_id !== "string"
    || recovery.invalid_artifact_id.length < 3
    || recovery.invalid_artifact_id.length > 300
    || typeof recovery.local_identity !== "string"
    || !/^local_recovery_[0-9a-f-]{36}$/i.test(recovery.local_identity)
    || typeof recovery.requested_at !== "string"
    || !Number.isFinite(Date.parse(recovery.requested_at))) {
    return { ok: false, error: providerError("ARTIFACT_RECOVERY_STATE_INVALID", "Provider output recovery state could not be verified.") };
  }
  return { ok: true, recovery: recovery as unknown as ProviderOutputRecovery };
}

function persistProviderOutputRecovery(
  db: M0Database,
  intentId: string,
  recovery: ProviderOutputRecovery | null
): void {
  const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string } | undefined;
  if (!row) throw new Error("GENERATION_INTENT_NOT_FOUND");
  const data = parseRecord(row.data_json);
  if (recovery) data.provider_output_recovery = recovery;
  else delete data.provider_output_recovery;
  db.prepare("UPDATE generation_intents SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?")
    .run(JSON.stringify(data), intentId);
}

interface ProviderOutputRecoveryArtifactRow {
  artifact_id: string;
  project_id: string | null;
  shot_id: string | null;
  role: string;
  artifact_type: string;
  status: string;
  data_json: string;
}

function retireProviderOutputRecoveryArtifacts(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  recovery: ProviderOutputRecovery
): { ok: true } | { ok: false; error: ProviderToolError } {
  try {
    const invalidArtifact = db.prepare(`SELECT artifact_id, project_id, shot_id, role, artifact_type, status, data_json
      FROM media_artifacts
      WHERE artifact_id = ?`).get(recovery.invalid_artifact_id) as ProviderOutputRecoveryArtifactRow | undefined;
    if (!invalidArtifact) throw new Error("ARTIFACT_RECOVERY_RETIRE_BINDING_MISSING");

    const replacementArtifacts = db.prepare(`SELECT artifact_id, project_id, shot_id, role, artifact_type, status, data_json
      FROM media_artifacts
      WHERE json_valid(data_json) = 1
        AND json_extract(data_json, '$.source.provider_job_id') = ?
      LIMIT 2`).all(recovery.local_identity) as ProviderOutputRecoveryArtifactRow[];
    if (replacementArtifacts.length > 1
      || replacementArtifacts[0]?.artifact_id === invalidArtifact.artifact_id) {
      throw new Error("ARTIFACT_RECOVERY_RETIRE_BINDING_AMBIGUOUS");
    }

    const targets = [
      { row: invalidArtifact, expectedProviderJobId: recovery.provider_task_id },
      ...replacementArtifacts.map((row) => ({ row, expectedProviderJobId: recovery.local_identity }))
    ];
    const archivedTargets = targets.map(({ row, expectedProviderJobId }) => {
      const data = parseRecord(row.data_json);
      const linkedObjects = data.linked_objects && typeof data.linked_objects === "object" && !Array.isArray(data.linked_objects)
        ? data.linked_objects as Record<string, unknown>
        : null;
      const source = data.source && typeof data.source === "object" && !Array.isArray(data.source)
        ? data.source as Record<string, unknown>
        : null;
      if (row.project_id !== intent.project_id
        || row.shot_id !== intent.shot_id
        || row.role !== "generated_clip"
        || row.artifact_type !== "video"
        || !["active", "inaccessible", "expired", "archived"].includes(row.status)
        || data.artifact_id !== row.artifact_id
        || data.role !== row.role
        || data.artifact_type !== row.artifact_type
        || data.status !== row.status
        || linkedObjects?.project_id !== intent.project_id
        || linkedObjects?.shot_id !== intent.shot_id
        || source?.provider !== intent.provider
        || source.provider_job_id !== expectedProviderJobId) {
        throw new Error("ARTIFACT_RECOVERY_RETIRE_BINDING_MISMATCH");
      }
      data.status = "archived";
      return { row, data_json: JSON.stringify(data) };
    });

    for (const target of archivedTargets) {
      const archived = withWorkbenchProductionMutationAuthority(db, {
        kind: "artifact", project_id: intent.project_id, object_id: target.row.artifact_id
      }, () => db.prepare(`UPDATE media_artifacts
          SET status = 'archived', data_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE artifact_id = ? AND project_id = ? AND shot_id = ? AND status = ? AND data_json = ?`)
          .run(
            target.data_json,
            target.row.artifact_id,
            intent.project_id,
            intent.shot_id,
            target.row.status,
            target.row.data_json
          )) as { changes: number | bigint };
      if (Number(archived.changes) !== 1) throw new Error("ARTIFACT_RECOVERY_RETIRE_UPDATE_FAILED");
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: providerError("ARTIFACT_RECOVERY_RETIRE_FAILED", "Previous Provider output recovery state could not be retired safely.")
    };
  }
}

function rebindRecoveredProviderOutput(
  db: M0Database,
  intent: WorkbenchGenerationIntent,
  job: GenerationJob,
  leaseToken: string,
  providerTaskId: string,
  recovery: ProviderOutputRecovery,
  replacementArtifactId: string,
  options: { in_transaction?: boolean } = {}
): { ok: true; artifact: MediaArtifact } | { ok: false; error: ProviderToolError } {
  if (!options.in_transaction) db.exec("BEGIN IMMEDIATE");
  try {
    assertJobLease(db, job.job_id, leaseToken);
    const replacement = validateActiveArtifactReference(db, {
      artifact_id: replacementArtifactId,
      project_id: intent.project_id,
      shot_id: intent.shot_id,
      role: "generated_clip",
      artifact_type: "video"
    });
    if (!replacement.ok) {
      if (!options.in_transaction) db.exec("ROLLBACK");
      return { ok: false, error: providerError(replacement.error.code, "Recovered Provider output Artifact failed active media validation.") };
    }

    const invalidRow = db.prepare(`SELECT status, data_json FROM media_artifacts
      WHERE artifact_id = ? AND project_id = ? AND shot_id = ?`).get(
      recovery.invalid_artifact_id,
      intent.project_id,
      intent.shot_id
    ) as { status: string; data_json: string } | undefined;
    const replacementRow = db.prepare(`SELECT data_json FROM media_artifacts
      WHERE artifact_id = ? AND project_id = ? AND shot_id = ?`).get(
      replacementArtifactId,
      intent.project_id,
      intent.shot_id
    ) as { data_json: string } | undefined;
    if (!invalidRow || !replacementRow) throw new Error("ARTIFACT_RECOVERY_BINDING_MISSING");

    const invalidData = parseRecord(invalidRow.data_json);
    const replacementData = parseRecord(replacementRow.data_json);
    if (invalidData.status !== invalidRow.status
      || !["active", "inaccessible", "expired", "archived"].includes(invalidRow.status)) {
      throw new Error("ARTIFACT_RECOVERY_BINDING_MISMATCH");
    }
    const invalidSource = invalidData.source && typeof invalidData.source === "object" && !Array.isArray(invalidData.source)
      ? { ...(invalidData.source as Record<string, unknown>) }
      : null;
    const replacementSource = replacementData.source && typeof replacementData.source === "object" && !Array.isArray(replacementData.source)
      ? { ...(replacementData.source as Record<string, unknown>) }
      : null;
    if (!invalidSource
      || invalidSource.provider !== "runninghub"
      || invalidSource.provider_job_id !== providerTaskId
      || !replacementSource
      || replacementSource.provider !== "runninghub"
      || replacementSource.provider_job_id !== recovery.local_identity) {
      throw new Error("ARTIFACT_RECOVERY_BINDING_MISMATCH");
    }

    invalidSource.provider_job_id = "";
    invalidSource.original_provider_job_id = providerTaskId;
    invalidSource.replaced_by_artifact_id = replacementArtifactId;
    invalidData.source = invalidSource;
    invalidData.status = "archived";
    replacementSource.provider_job_id = providerTaskId;
    replacementSource.local_recovery_identity = recovery.local_identity;
    replacementData.source = replacementSource;

    const detached = withWorkbenchProductionMutationAuthority(db, {
      kind: "artifact", project_id: intent.project_id, object_id: recovery.invalid_artifact_id
    }, () => db.prepare("UPDATE media_artifacts SET status = 'archived', data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE artifact_id = ?")
      .run(JSON.stringify(invalidData), recovery.invalid_artifact_id)) as { changes: number | bigint };
    if (Number(detached.changes) !== 1) throw new Error("ARTIFACT_RECOVERY_DETACH_FAILED");
    const rebound = withWorkbenchProductionMutationAuthority(db, {
      kind: "artifact", project_id: intent.project_id, object_id: replacementArtifactId
    }, () => db.prepare("UPDATE media_artifacts SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE artifact_id = ?")
      .run(JSON.stringify(replacementData), replacementArtifactId)) as { changes: number | bigint };
    if (Number(rebound.changes) !== 1) throw new Error("ARTIFACT_RECOVERY_REBIND_FAILED");
    persistProviderOutputRecovery(db, intent.intent_id, null);
    if (!options.in_transaction) db.exec("COMMIT");

    const validated = validateActiveArtifactReference(db, {
      artifact_id: replacementArtifactId,
      project_id: intent.project_id,
      shot_id: intent.shot_id,
      role: "generated_clip",
      artifact_type: "video"
    });
    if (!validated.ok) {
      return { ok: false, error: providerError(validated.error.code, "Recovered Provider output Artifact failed active media validation.") };
    }
    return { ok: true, artifact: validated.artifact };
  } catch (error) {
    if (!options.in_transaction) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may already have been rolled back */ }
    }
    if (error instanceof GenerationJobLeaseLostError) throw error;
    return { ok: false, error: providerError("ARTIFACT_RECOVERY_REBIND_FAILED", "Recovered Provider output Artifact could not be rebound safely.") };
  }
}

async function executeIntent(intentId: string, allowSubmit: boolean, dependencies: WorkbenchGenerationDependencies): Promise<void> {
  const db = (dependencies.open_database ?? openM0Database)(dependencies.sqlite_path);
  const leaseOwner = `worker_${process.pid}`;
  const leaseToken = randomUUID();
  let job: GenerationJob | null;
  try {
    job = claimJob(db, intentId, leaseOwner, leaseToken, dateNow(dependencies));
  } catch (error) {
    db.close();
    throw error;
  }
  if (!job) {
    db.close();
    return;
  }
  const claimedJobId = job.job_id;
  let providerTaskMayExist = false;
  let knownTaskId = "";
  const heartbeat = setInterval(() => {
    try {
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      db.prepare(`UPDATE generation_jobs SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ? AND lease_token = ? AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at) > CURRENT_TIMESTAMP`).run(expiresAt, job?.job_id, leaseToken);
    } catch {
      // The next conditional lease assertion decides whether this worker may write back.
    }
  }, 30_000);
  try {
    let intent = getIntent(db, intentId);
    if (!intent || (intent.status !== "queued" && intent.status !== "running")) return;
    knownTaskId = intent.provider_task_id;
    providerTaskMayExist = Boolean(knownTaskId);
    const failOrReconcileKnownTask = (currentIntent: WorkbenchGenerationIntent, currentJob: GenerationJob, error: ProviderToolError, reconciliationReason: string): void => {
      if (knownTaskId) {
        job = markKnownProviderTaskForReconciliation(db, currentIntent, currentJob, knownTaskId, error, leaseToken, reconciliationReason);
      } else {
        failIntent(db, currentIntent, "failed", error, leaseToken, currentJob);
      }
    };
    const recoveringLocalCompletion = knownTaskId !== ""
      && (job.state === "downloading" || job.state === "finalizing");
    let providerPollTimeoutMs: number | null = null;
    let pollDeadlineMs: number | null = null;
    let remainingPollBudget: (() => number) | null = null;
    const markProviderPollTimeout = (): void => {
      failOrReconcileKnownTask(
        intent as WorkbenchGenerationIntent,
        job as GenerationJob,
        providerError("PROVIDER_POLL_TIMEOUT", "Provider task polling reached the local deadline."),
        "PROVIDER_POLL_TIMEOUT"
      );
    };
    try {
      if (!recoveringLocalCompletion) {
        providerPollTimeoutMs = parseProviderTaskPollTimeoutMs(dependencies.env ?? process.env);
        const persistedWindow = providerPollWindowFromIntent(db, intent.intent_id);
        if (knownTaskId) {
          if (persistedWindow === null) throw new ProviderPollTimeoutConfigurationError();
          pollDeadlineMs = persistedWindow.deadline_ms;
          remainingPollBudget = createRemainingPollBudget(persistedWindow, dependencies);
        } else if (persistedWindow !== null) {
          throw new ProviderPollTimeoutConfigurationError();
        }
      }
    } catch (caught) {
      if (!(caught instanceof ProviderPollTimeoutConfigurationError)) throw caught;
      failOrReconcileKnownTask(
        intent,
        job,
        providerError(caught.code, "Provider poll timeout configuration is invalid."),
        caught.code
      );
      return;
    }
    if (job.state === "polling" && remainingPollBudget?.() === 0) {
      markProviderPollTimeout();
      return;
    }
    const directorAuthorization = authorizeDirectorProviderExecution(db, intent, knownTaskId, dateNow(dependencies));
    if (!directorAuthorization.ok) {
      failOrReconcileKnownTask(
        intent,
        job,
        directorAuthorization.error,
        "DIRECTOR_AUTOMATION_REQUIRES_RECONCILIATION"
      );
      return;
    }
    const generationPlanAuthority = knownTaskId
      ? validateT2GenerationPlanBinding(intent)
      : revalidateQueuedGenerationPlanAuthority(db, intent, job);
    if (!generationPlanAuthority.ok) {
      failOrReconcileKnownTask(
        intent,
        job,
        providerError("GENERATION_PLAN_STALE", generationPlanAuthority.message),
        "GENERATION_PLAN_REQUIRES_RECONCILIATION"
      );
      return;
    }
    // Preserve the more specific durable Director and T2 admission failures
    // before applying the broader execution snapshot guard. These checks are
    // synchronous and side-effect free; the snapshot still gates Provider
    // selection and every subsequent external await boundary.
    const initialExecutionAuthorityError = generationExecutionAuthorityError(db, intent, job, job.state as GenerationExecutionBindingInput["expected_job_state"]);
    if (initialExecutionAuthorityError) {
      failOrReconcileKnownTask(
        intent,
        job,
        initialExecutionAuthorityError,
        "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
      );
      return;
    }
    const capability = buildProviderCapabilityKey({
      provider: "runninghub",
      model: intent.model,
      duration_seconds: intent.duration_seconds,
      resolution: intent.resolution,
      aspect_ratio: intent.input_snapshot.aspect_ratio
    });
    if (!capability.ok || (intent.input_snapshot.capability_key && intent.input_snapshot.capability_key !== capability.key.serialized)) {
      const error = providerError("PROVIDER_CAPABILITY_CONTRACT_MISMATCH", "Generation intent no longer matches the declared Provider capability.");
      failOrReconcileKnownTask(intent, job, error, "PROVIDER_CAPABILITY_REQUIRES_RECONCILIATION");
      return;
    }
    if (!knownTaskId && !isProviderExecutionAuthorized(intent)) {
      failIntent(
        db,
        intent,
        "failed",
        providerError("OFFICIAL_PREFLIGHT_REQUIRED", "Official preflight authorization is required before Provider execution."),
        leaseToken,
        job
      );
      return;
    }
    if (intent.generation_plan) {
      const mediaGuard = revalidateGenerationPlanMedia(intent.generation_plan, db);
      if (!mediaGuard.ok) {
        failOrReconcileKnownTask(
          intent,
          job,
          providerError(mediaGuard.code, mediaGuard.message),
          "GENERATION_PLAN_REQUIRES_RECONCILIATION"
        );
        return;
      }
    }
    const automation = directorAuthorization.required ? directorAuthorization.automation : null;
    const selection = selectM1ProviderPort({ provider: "real", provider_name: "runninghub", model_name: capability.key.model, cost_acknowledged: true }, dependencies.env ?? process.env);
    if (!selection.ok || selection.selected.provider_name !== "runninghub" || !selection.selected.credential) {
      failOrReconcileKnownTask(intent, job, selection.ok ? providerError("PROVIDER_SELECTION_MISMATCH", "RunningHub provider selection changed after confirmation.") : selection.error, "PROVIDER_SELECTION_REQUIRES_RECONCILIATION");
      return;
    }
    const executionIntentId = intent.intent_id;
    const executionJobId = job.job_id;
    const revalidateBeforePaidSubmit = (): ProviderToolError | null => {
      try {
        assertJobLease(db, executionJobId, leaseToken);
        const currentIntent = getIntent(db, executionIntentId);
        const currentJob = jobForIntent(db, executionIntentId);
        if (!currentIntent || !currentJob) {
          return providerError("GENERATION_EXECUTION_AUTHORITY_STALE", "Generation execution state disappeared before paid Provider submit.");
        }
        const authorityError = generationExecutionAuthorityError(db, currentIntent, currentJob, "submitting");
        if (authorityError) return authorityError;
        if (automation) {
          try {
            loadDirectorGrantAuthorization(db, automation, "generation.submit", dateNow(dependencies), { verify_target_state: false });
          } catch {
            return providerError("DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED", "Director authorization changed before paid Provider submit.");
          }
        }
        return null;
      } catch {
        return providerError("GENERATION_JOB_LEASE_LOST", "Generation Job ownership changed before paid Provider submit.");
      }
    };
    const adapter = dependencies.adapter_factory?.(selection.selected.credential)
      ?? new RunningHubVideoProviderAdapter({
        credential: selection.selected.credential,
        fetch_impl: dependencies.fetch_impl,
        model_name: capability.key.model,
        revalidate_before_paid_submit: revalidateBeforePaidSubmit
      });
    if (adapter.provider_name !== capability.key.provider || adapter.model_name !== capability.key.model) {
      failOrReconcileKnownTask(intent, job, providerError("PROVIDER_CAPABILITY_CONTRACT_MISMATCH", "Provider adapter does not match the confirmed generation capability."), "PROVIDER_ADAPTER_REQUIRES_RECONCILIATION");
      return;
    }
    let taskId = knownTaskId;
    let submittedNow = false;
    if (!taskId) {
      if (providerPollTimeoutMs === null) throw new ProviderPollTimeoutConfigurationError();
      const artifact = validateActiveArtifactReference(db, {
        artifact_id: intent.input_artifact_id, project_id: intent.project_id, shot_id: intent.shot_id, role: "storyboard_image", artifact_type: "image"
      });
      if (!artifact.ok) {
        failIntent(db, intent, "failed", providerError(artifact.error.code, artifact.error.message), leaseToken, job);
        return;
      }
      if (!allowSubmit) {
        job = markUnknownSubmission(
          db,
          intent,
          job,
          providerError("PROVIDER_REQUEST_FAILED", "Provider submission outcome requires human reconciliation."),
          leaseToken
        );
        return;
      }
      job = setJobState(db, job, "submitting", "", { lease_token: leaseToken });
      let submit: Awaited<ReturnType<VideoProviderAdapter["submitGeneration"]>>;
      try {
        submit = await adapter.submitGeneration({
          storyboard_artifact: artifact.artifact,
          video_prompt: intent.input_snapshot.video_prompt,
          negative_prompt: intent.input_snapshot.negative_prompt,
          duration_seconds: capability.key.duration_seconds,
          aspect_ratio: intent.input_snapshot.aspect_ratio,
          resolution: capability.key.resolution
        });
      } catch {
        assertJobLease(db, job.job_id, leaseToken);
        const rejectedAwaitAuthorityError = generationExecutionAuthorityError(db, intent, job, "submitting");
        job = markUnknownSubmission(
          db,
          intent,
          job,
          rejectedAwaitAuthorityError
            ?? providerError("PROVIDER_REQUEST_FAILED", "Provider submission outcome requires human reconciliation."),
          leaseToken
        );
        return;
      }
      if (!submit.ok) {
        assertJobLease(db, job.job_id, leaseToken);
        const postSubmitAuthorityError = generationExecutionAuthorityError(db, intent, job, "submitting");
        if (postSubmitAuthorityError) {
          if (submit.error.submission_outcome_unknown === true) {
            job = markUnknownSubmission(db, intent, job, postSubmitAuthorityError, leaseToken);
          } else {
            failIntent(db, intent, "failed", postSubmitAuthorityError, leaseToken, job);
          }
          return;
        }
        if (submit.error.submission_outcome_unknown === true) {
          job = markUnknownSubmission(db, intent, job, submit.error, leaseToken);
          return;
        }
        if (submit.error.retryable === true) {
          const retried = queueDirectorKnownNoSubmitRetry(db, intent, job, automation, leaseToken, dependencies);
          if (retried.queued) return;
          if (retried.error) {
            failIntent(db, intent, "failed", retried.error, leaseToken, job);
            return;
          }
        }
        failIntent(db, intent, "failed", submit.error, leaseToken, job);
        return;
      }
      const returnedTaskId = submit.provider_job_id;
      if (typeof returnedTaskId !== "string" || returnedTaskId.length === 0 || returnedTaskId.length > 512) {
        assertJobLease(db, job.job_id, leaseToken);
        job = markUnknownSubmission(
          db,
          intent,
          job,
          providerError("PROVIDER_TASK_ID_INVALID", "Provider submission succeeded without a durable task identity."),
          leaseToken
        );
        return;
      }
      taskId = returnedTaskId;
      const submitProviderStatus = normalizedProviderStatus(submit.provider_status);
      providerTaskMayExist = true;
      knownTaskId = taskId;
      db.exec("BEGIN IMMEDIATE");
      try {
        const persistedTask = db.prepare(`UPDATE generation_intents
          SET provider_task_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP
          WHERE intent_id = ? AND (provider_task_id = '' OR provider_task_id = ?)`)
          .run(taskId, intent.intent_id, taskId) as { changes: number | bigint };
        if (Number(persistedTask.changes) !== 1) throw new Error("PROVIDER_TASK_IDENTITY_CONFLICT");
        transitionGenerationExecutionReceipt(db, intent.intent_id, {
          state: "submitted",
          provider_task_id: taskId,
          provider_status: submitProviderStatus
        });
        db.exec("COMMIT");
      } catch {
        db.exec("ROLLBACK");
        try {
          job = markKnownProviderTaskForReconciliation(
            db,
            intent,
            job,
            taskId,
            providerError("LOCAL_TASK_PERSISTENCE_UNKNOWN", "Provider task identity could not be persisted atomically."),
            leaseToken,
            "PROVIDER_TASK_PERSISTENCE_UNKNOWN"
          );
        } catch { /* restart recovery will quarantine any remaining submitting job */ }
        return;
      }
      intent = getIntent(db, intent.intent_id) as WorkbenchGenerationIntent;
      if (!/^[A-Za-z0-9._:-]{3,200}$/.test(taskId) || /^local_recovery_/i.test(taskId)) {
        assertJobLease(db, job.job_id, leaseToken);
        job = markKnownProviderTaskForReconciliation(
          db,
          intent,
          job,
          taskId,
          providerError("PROVIDER_TASK_ID_INVALID", "Provider returned a task identity that requires human reconciliation."),
          leaseToken,
          "PROVIDER_TASK_IDENTITY_REQUIRES_RECONCILIATION"
        );
        return;
      }
      let leaseLostAfterSubmit = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        let leaseStillValid = true;
        try { assertJobLease(db, job.job_id, leaseToken); }
        catch (caught) {
          if (!(caught instanceof GenerationJobLeaseLostError)) throw caught;
          leaseStillValid = false;
          leaseLostAfterSubmit = true;
        }
        if (automation) {
          consumeDirectorGrantReservation(db, automation, {
            amount_minor: automation.amount_minor!,
            currency: intent.currency,
            intent_id: intent.intent_id,
            run_id: intent.run_id
          });
        }
        const persistedTask = db.prepare(`UPDATE generation_intents
          SET provider_task_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP
          WHERE intent_id = ? AND (provider_task_id = '' OR provider_task_id = ?)`)
          .run(taskId, intent.intent_id, taskId) as { changes: number | bigint };
        if (Number(persistedTask.changes) !== 1) throw new Error("PROVIDER_TASK_IDENTITY_CONFLICT");
        pollDeadlineMs = ensureProviderPollDeadline(
          db,
          intent.intent_id,
          providerPollTimeoutMs,
          dateNow(dependencies).getTime()
        );
        const run = getGenerationRun(db, intent.run_id);
        if (run) {
          run.status = "running";
          run.provider.provider_job_id = taskId;
          run.provider.provider_status = submitProviderStatus;
          saveGenerationRun(db, run);
        }
        transitionGenerationExecutionReceipt(db, intent.intent_id, {
          state: "submitted",
          provider_task_id: taskId,
          provider_status: submitProviderStatus
        });
        const persistedIntent = getIntent(db, intent.intent_id);
        if (!persistedIntent) throw new Error("GENERATION_INTENT_NOT_FOUND");
        const postSubmitAuthorityError = generationExecutionAuthorityError(db, persistedIntent, job, "submitting");
        if (!leaseStillValid || postSubmitAuthorityError) {
          const reasonCode = leaseStillValid
            ? "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
            : "GENERATION_JOB_LEASE_REQUIRES_RECONCILIATION";
          transitionGenerationExecutionReceipt(db, intent.intent_id, {
            state: "reconciling",
            provider_status: reasonCode
          });
          if (leaseStillValid) {
            restoreProjectAfterGenerationAutomationStops(db, persistedIntent);
            job = enterManualReconciliationJob(db, job, reasonCode, {
              lease_token: leaseToken,
              record_event: true
            });
          }
        } else {
          job = setJobState(db, job, "polling", "", { lease_token: leaseToken, in_transaction: true });
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        try {
          job = markKnownProviderTaskForReconciliation(db, intent, job, taskId, providerError("LOCAL_TASK_PERSISTENCE_UNKNOWN", "Provider task identity could not be persisted atomically."), leaseToken, "PROVIDER_TASK_PERSISTENCE_UNKNOWN");
        } catch { /* restart recovery will quarantine any remaining submitting job */ }
        return;
      }
      intent = getIntent(db, intent.intent_id) as WorkbenchGenerationIntent;
      if (leaseLostAfterSubmit) return;
      if (job.state === "manual_reconciliation") return;
      remainingPollBudget = createRemainingPollBudget({
        started_at_ms: (pollDeadlineMs as number) - providerPollTimeoutMs,
        timeout_ms: providerPollTimeoutMs,
        deadline_ms: pollDeadlineMs as number
      }, dependencies);
      submittedNow = true;
    }

    const interval = Math.max(10, dependencies.poll_interval_ms ?? 5_000);
    const deferPolling = (): boolean => {
      const remainingMs = remainingPollBudget?.() ?? 0;
      if (remainingMs <= 0 || pollDeadlineMs === null) {
        markProviderPollTimeout();
        return false;
      }
      const wallNowMs = dateNow(dependencies).getTime();
      const nextAttemptMs = Math.min(pollDeadlineMs, wallNowMs + Math.min(interval, remainingMs));
      assertJobLease(db, claimedJobId, leaseToken);
      db.prepare(`UPDATE generation_jobs SET next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ? AND lease_token = ?`).run(new Date(nextAttemptMs).toISOString(), claimedJobId, leaseToken);
      return true;
    };
    if (submittedNow) {
      deferPolling();
      return;
    }

    const recoveryState = providerOutputRecoveryFromIntent(db, intent.intent_id, taskId);
    if (!recoveryState.ok) {
      job = markKnownProviderTaskForReconciliation(
        db,
        intent,
        job,
        taskId,
        recoveryState.error,
        leaseToken,
        "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
      );
      return;
    }
    const recovery = recoveryState.recovery;
    const existingOutput = existingOutputArtifact(db, taskId, intent.project_id, intent.shot_id, intent.intent_id);
    let output: MediaArtifact | null = null;
    let recoveryNeedsDownload = false;
    if (recovery) {
      const replacement = providerOutputArtifactByIdentity(
        db,
        recovery.local_identity,
        intent.project_id,
        intent.shot_id,
        { intent_id: intent.intent_id, provider_task_id: taskId }
      );
      if (!replacement.ok) {
        job = markKnownProviderTaskForReconciliation(
          db,
          intent,
          job,
          taskId,
          replacement.error,
          leaseToken,
          "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
        );
        return;
      }
      if (replacement.artifact) {
        const rebound = rebindRecoveredProviderOutput(
          db,
          intent,
          job,
          leaseToken,
          taskId,
          recovery,
          replacement.artifact.artifact_id
        );
        if (!rebound.ok) {
          job = markKnownProviderTaskForReconciliation(
            db,
            intent,
            job,
            taskId,
            rebound.error,
            leaseToken,
            "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
          );
          return;
        }
        output = rebound.artifact;
      } else if (existingOutput.ok) {
        if (existingOutput.artifact?.artifact_id !== recovery.invalid_artifact_id) {
          job = markKnownProviderTaskForReconciliation(
            db,
            intent,
            job,
            taskId,
            providerError("ARTIFACT_RECOVERY_STATE_INVALID", "Provider output recovery state could not be verified."),
            leaseToken,
            "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
          );
          return;
        }
        // Blob repair can make the old Artifact healthy before replacement
        // activation commits. A persisted recovery request must still finish
        // through the replacement identity instead of adopting the old row.
        recoveryNeedsDownload = true;
      } else if (existingOutput.invalid_artifact_id === recovery.invalid_artifact_id) {
        recoveryNeedsDownload = true;
      } else {
        job = markKnownProviderTaskForReconciliation(
          db,
          intent,
          job,
          taskId,
          existingOutput.error,
          leaseToken,
          "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
        );
        return;
      }
    } else if (existingOutput.ok) {
      output = existingOutput.artifact;
    } else {
      job = markKnownProviderTaskForReconciliation(
        db,
        intent,
        job,
        taskId,
        existingOutput.error,
        leaseToken,
        "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
      );
      return;
    }
    let outputUrl = "";
    if (!output) {
      if (job.state === "finalizing" && !recoveryNeedsDownload) {
        job = markKnownProviderTaskForReconciliation(
          db,
          intent,
          job,
          taskId,
          providerError("LOCAL_FINALIZATION_STATE_MISSING", "The downloaded Artifact was missing during local finalization recovery."),
          leaseToken,
          "LOCAL_FINALIZATION_REQUIRES_RECONCILIATION"
        );
        return;
      }
      const deadlineApplies = job.state === "polling";
      const pollRequestTimeoutMs = deadlineApplies ? remainingPollBudget?.() ?? 0 : null;
      if (deadlineApplies && (pollRequestTimeoutMs ?? 0) <= 0) {
        markProviderPollTimeout();
        return;
      }
      let polled: Awaited<ReturnType<VideoProviderAdapter["pollStatus"]>>;
      try {
        polled = await adapter.pollStatus(
          taskId,
          deadlineApplies ? { timeout_ms: pollRequestTimeoutMs as number } : undefined
        );
      } catch {
        assertJobLease(db, job.job_id, leaseToken);
        const rejectedPollIntent = getIntent(db, intent.intent_id);
        const rejectedAwaitAuthorityError = rejectedPollIntent
          ? generationExecutionAuthorityError(db, rejectedPollIntent, job, "polling")
          : providerError("GENERATION_EXECUTION_AUTHORITY_STALE", "Generation Intent disappeared while polling the Provider task.");
        job = markKnownProviderTaskForReconciliation(
          db,
          rejectedPollIntent ?? intent,
          job,
          taskId,
          rejectedAwaitAuthorityError
            ?? providerError("PROVIDER_REQUEST_FAILED", "Provider polling failed and requires reconciliation."),
          leaseToken,
          rejectedAwaitAuthorityError
            ? "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
            : "PROVIDER_POLL_REQUIRES_RECONCILIATION"
        );
        return;
      }
      assertJobLease(db, job.job_id, leaseToken);
      const postPollIntent = getIntent(db, intent.intent_id);
      const postPollAuthorityError = postPollIntent
        ? generationExecutionAuthorityError(db, postPollIntent, job, "polling")
        : providerError("GENERATION_EXECUTION_AUTHORITY_STALE", "Generation Intent disappeared while polling the Provider task.");
      if (postPollAuthorityError) {
        job = markKnownProviderTaskForReconciliation(
          db,
          postPollIntent ?? intent,
          job,
          taskId,
          postPollAuthorityError,
          leaseToken,
          "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
        );
        return;
      }
      intent = postPollIntent as WorkbenchGenerationIntent;
      if (deadlineApplies && (remainingPollBudget?.() ?? 0) <= 0) {
        markProviderPollTimeout();
        return;
      }
      if (!polled.ok) {
        if (deadlineApplies && polled.error.retryable) {
          deferPolling();
          return;
        }
        job = markKnownProviderTaskForReconciliation(db, intent, job, taskId, polled.error, leaseToken, "PROVIDER_POLL_REQUIRES_RECONCILIATION");
        return;
      }
      if (polled.provider_job_id !== taskId) {
        job = markKnownProviderTaskForReconciliation(
          db,
          intent,
          job,
          taskId,
          providerError("PROVIDER_TASK_ID_MISMATCH", "Provider poll result did not match the retained task identity."),
          leaseToken,
          "PROVIDER_POLL_REQUIRES_RECONCILIATION"
        );
        return;
      }
      const polledProviderStatus = normalizedProviderStatus(polled.provider_status);
      if (polled.status !== "succeeded") {
        db.exec("BEGIN IMMEDIATE");
        try {
          assertJobLease(db, job.job_id, leaseToken);
          const run = getGenerationRun(db, intent.run_id);
          if (run) {
            run.provider.provider_status = polledProviderStatus;
            saveGenerationRun(db, run);
          }
          transitionGenerationExecutionReceipt(db, intent.intent_id, {
            state: "submitted",
            provider_status: polledProviderStatus
          });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      if (polled.status === "failed" || polled.status === "cancelled") {
        job = markKnownProviderTaskForReconciliation(
          db,
          intent,
          job,
          taskId,
          providerError("PROVIDER_TERMINAL_STATUS_REQUIRES_RECONCILIATION", "RunningHub task ended in a terminal state that requires reconciliation."),
          leaseToken,
          "PROVIDER_TERMINAL_STATUS_REQUIRES_RECONCILIATION"
        );
        return;
      }
      if (polled.status !== "succeeded") {
        if (deadlineApplies) {
          deferPolling();
        } else {
          job = markKnownProviderTaskForReconciliation(
            db,
            intent,
            job,
            taskId,
            providerError("PROVIDER_STATUS_REQUIRES_RECONCILIATION", "Provider terminal success could not be reconfirmed during local completion recovery."),
            leaseToken,
            "PROVIDER_POLL_REQUIRES_RECONCILIATION"
          );
        }
        return;
      }
      outputUrl = polled.output_url ?? "";
      if (!outputUrl) {
        job = markKnownProviderTaskForReconciliation(db, intent, job, taskId, providerError("PROVIDER_OUTPUT_MISSING", "Provider reported success without an output URL."), leaseToken, "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION");
        return;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        assertJobLease(db, job.job_id, leaseToken);
        const run = getGenerationRun(db, intent.run_id);
        if (run) {
          run.provider.provider_status = polledProviderStatus;
          saveGenerationRun(db, run);
        }
        transitionGenerationExecutionReceipt(db, intent.intent_id, {
          state: "submitted",
          provider_status: polledProviderStatus
        });
        dependencies.fault_injection_after_provider_success_run_write?.();
        job = setJobState(db, job, "downloading", "", { lease_token: leaseToken, in_transaction: true });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      assertJobLease(db, job.job_id, leaseToken);
      const downloadIntent = intent;
      const downloadJob = job;
      let finalizedDuringActivation = false;
      let activationExpectedJobState: GenerationExecutionBindingInput["expected_job_state"] = "downloading";
      const revalidateDownloadAuthority = (): ProviderToolError | null => {
        try {
          assertJobLease(db, downloadJob.job_id, leaseToken);
          const currentIntent = getIntent(db, downloadIntent.intent_id);
          const currentJob = jobForIntent(db, downloadIntent.intent_id);
          if (!currentIntent || !currentJob) {
            return providerError("GENERATION_EXECUTION_AUTHORITY_STALE", "Generation execution state disappeared during Provider output download.");
          }
          return generationExecutionAuthorityError(db, currentIntent, currentJob, "downloading");
        } catch (caught) {
          return providerError(
            caught instanceof GenerationJobLeaseLostError ? "GENERATION_JOB_LEASE_LOST" : "GENERATION_EXECUTION_AUTHORITY_STALE",
            "Generation execution authority changed during Provider output download."
          );
        }
      };
      const activateAndFinalize = (
        activationInput: ActivateLocalMediaArtifactInput,
        activationDb: M0Database
      ): RegisterMediaArtifactResult => {
        if (activationDb !== db) {
          return { ok: false, error: { code: "GENERATION_EXECUTION_DATABASE_MISMATCH", message: "Provider output activation used a different database authority." } };
        }
        const providerOutputIdentity = recoveryNeedsDownload && recovery ? recovery.local_identity : taskId;
        const providerOutputStorageDirectory = resolve(
          dependencies.provider_output_storage_directory ?? paths.videoArtifactsRoot
        );
        const initialBindingError = providerOutputActivationBindingError(
          activationInput,
          downloadIntent,
          providerOutputIdentity,
          providerOutputStorageDirectory
        );
        if (initialBindingError) return { ok: false, error: initialBindingError };
        db.exec("BEGIN IMMEDIATE");
        try {
          const assertActivationAuthority = (): void => {
            const bindingError = providerOutputActivationBindingError(
              activationInput,
              downloadIntent,
              providerOutputIdentity,
              providerOutputStorageDirectory
            );
            if (bindingError) throw new Error(bindingError.code);
            assertJobLease(db, downloadJob.job_id, leaseToken);
            const currentIntent = getIntent(db, downloadIntent.intent_id);
            const currentJob = jobForIntent(db, downloadIntent.intent_id);
            if (!currentIntent || !currentJob) throw new Error("GENERATION_EXECUTION_AUTHORITY_STALE");
            const authorityError = generationExecutionAuthorityError(db, currentIntent, currentJob, activationExpectedJobState);
            if (authorityError) throw new Error(authorityError.code);
            if (automation) {
              try {
                loadDirectorGrantAuthorization(db, automation, "artifact.activate", dateNow(dependencies), { verify_target_state: false });
              } catch (caught) {
                throw new Error(caught instanceof Error && "code" in caught
                  ? String(caught.code)
                  : "DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED");
              }
            }
          };
          assertActivationAuthority();
          const currentJob = jobForIntent(db, downloadIntent.intent_id);
          if (!currentJob) throw new Error("GENERATION_JOB_NOT_FOUND");
          job = setJobState(db, currentJob, "finalizing", "", { lease_token: leaseToken, in_transaction: true });
          activationExpectedJobState = "finalizing";
          const activated = activateLocalMediaArtifact({
            ...activationInput,
            before_artifact_persist: () => {
              activationInput.before_artifact_persist?.();
              assertActivationAuthority();
            }
          }, db);
          if (!activated.ok) {
            db.exec("ROLLBACK");
            job = downloadJob;
            activationExpectedJobState = "downloading";
            return activated;
          }
          dependencies.fault_injection_after_provider_artifact_persist?.();
          let finalArtifact = activated.artifact;
          if (recoveryNeedsDownload && recovery) {
            const rebound = rebindRecoveredProviderOutput(
              db,
              downloadIntent,
              job ?? downloadJob,
              leaseToken,
              taskId,
              recovery,
              activated.artifact.artifact_id,
              { in_transaction: true }
            );
            if (!rebound.ok) throw new Error(rebound.error.code);
            finalArtifact = rebound.artifact;
          }
          const currentIntent = getIntent(db, downloadIntent.intent_id);
          const currentShot = getShot(db, downloadIntent.shot_id);
          const currentProject = getProject(db, downloadIntent.project_id);
          const currentRun = getGenerationRun(db, downloadIntent.run_id);
          if (!currentIntent || !currentShot || !currentProject || !currentRun) {
            throw new Error("LOCAL_FINALIZATION_STATE_MISSING");
          }
          const finalAuthorityError = generationExecutionAuthorityError(db, currentIntent, job ?? downloadJob, "finalizing");
          if (finalAuthorityError) throw new Error(finalAuthorityError.code);
          if (!currentShot.clip_versions.some((version) => version.artifact_id === finalArtifact.artifact_id)) {
            currentShot.clip_versions.push({
              artifact_id: finalArtifact.artifact_id,
              run_id: currentRun.run_id,
              attempt_number: currentRun.versioning.attempt_number,
              review_status: "pending"
            });
          }
          currentShot.status = "video_review";
          saveShot(db, currentShot);
          currentProject.status = "video_review";
          saveProject(db, currentProject);
          currentRun.status = "succeeded";
          currentRun.output.artifact_ids = [finalArtifact.artifact_id];
          currentRun.provider.provider_job_id = taskId;
          currentRun.provider.provider_status = "SUCCESS";
          currentRun.error = { code: "", message: "", retryable: false };
          saveGenerationRun(db, currentRun);
          const finalizedIntent = db.prepare(`UPDATE generation_intents
            SET status = 'succeeded', output_artifact_id = ?, sanitized_error_json = '{}', updated_at = CURRENT_TIMESTAMP
            WHERE intent_id = ? AND provider_task_id = ? AND status = 'running'`)
            .run(finalArtifact.artifact_id, downloadIntent.intent_id, taskId) as { changes: number | bigint };
          if (Number(finalizedIntent.changes) !== 1) throw new Error("GENERATION_EXECUTION_AUTHORITY_STALE");
          persistProviderOutputRecovery(db, downloadIntent.intent_id, null);
          transitionGenerationExecutionReceipt(db, downloadIntent.intent_id, {
            state: "succeeded",
            provider_status: "SUCCESS",
            result_artifact_id: finalArtifact.artifact_id
          });
          job = setJobState(db, job ?? downloadJob, "succeeded", "", { lease_token: leaseToken, in_transaction: true });
          db.exec("COMMIT");
          cleanupCommittedMediaActivationMarkers(db, [finalArtifact.artifact_id]);
          output = finalArtifact;
          finalizedDuringActivation = true;
          return { ok: true, artifact: finalArtifact };
        } catch (caught) {
          try { db.exec("ROLLBACK"); } catch { /* transaction may already have rolled back */ }
          job = jobForIntent(db, downloadIntent.intent_id) ?? downloadJob;
          activationExpectedJobState = "downloading";
          const rawCode = caught instanceof Error ? caught.message : "LOCAL_FINALIZATION_TRANSACTION_FAILED";
          const code = /^[A-Z][A-Z0-9_]+$/.test(rawCode) ? rawCode : "LOCAL_FINALIZATION_TRANSACTION_FAILED";
          return { ok: false, error: { code, message: "Provider output could not be finalized under current generation authority." } };
        }
      };
      let downloaded: Awaited<ReturnType<typeof downloadProviderOutputToArtifact>>;
      try {
        downloaded = await (dependencies.download_provider_output ?? downloadProviderOutputToArtifact)({
          url: outputUrl,
          provider_name: "runninghub",
          provider_job_id: recoveryNeedsDownload && recovery ? recovery.local_identity : taskId,
          project_id: downloadIntent.project_id,
          shot_id: downloadIntent.shot_id,
          duration_seconds: downloadIntent.duration_seconds,
          aspect_ratio: downloadIntent.input_snapshot.aspect_ratio,
          storage_directory: resolve(dependencies.provider_output_storage_directory ?? paths.videoArtifactsRoot),
          ...(recoveryNeedsDownload && recovery
            ? { verified_blob_recovery: { invalid_artifact_id: recovery.invalid_artifact_id } }
            : {})
        }, db, {
          revalidate_execution_authority: revalidateDownloadAuthority,
          activate_artifact: activateAndFinalize
        });
      } catch {
        if (finalizedDuringActivation) return;
        assertJobLease(db, downloadJob.job_id, leaseToken);
        const rejectedDownloadIntent = getIntent(db, downloadIntent.intent_id);
        const rejectedAwaitAuthorityError = rejectedDownloadIntent
          ? generationExecutionAuthorityError(db, rejectedDownloadIntent, downloadJob, "downloading")
          : providerError("GENERATION_EXECUTION_AUTHORITY_STALE", "Generation Intent disappeared while downloading Provider output.");
        job = markKnownProviderTaskForReconciliation(
          db,
          rejectedDownloadIntent ?? downloadIntent,
          downloadJob,
          taskId,
          rejectedAwaitAuthorityError
            ?? providerError("PROVIDER_REQUEST_FAILED", "Provider output download failed and requires reconciliation."),
          leaseToken,
          rejectedAwaitAuthorityError
            ? "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
            : "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
        );
        return;
      }
      if (finalizedDuringActivation) return;
      assertJobLease(db, downloadJob.job_id, leaseToken);
      if (!downloaded.ok) {
        const failedDownloadIntent = getIntent(db, downloadIntent.intent_id);
        const failedDownloadAuthorityError = failedDownloadIntent
          ? generationExecutionAuthorityError(db, failedDownloadIntent, downloadJob, "downloading")
          : providerError("GENERATION_EXECUTION_AUTHORITY_STALE", "Generation Intent disappeared while downloading Provider output.");
        job = markKnownProviderTaskForReconciliation(
          db,
          failedDownloadIntent ?? downloadIntent,
          downloadJob,
          taskId,
          failedDownloadAuthorityError ?? downloaded.error,
          leaseToken,
          failedDownloadAuthorityError
            ? "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
            : "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
        );
        return;
      }
      const quarantined = quarantineUntrustedDownloadedArtifact(
        db,
        downloaded.artifact.artifact_id,
        downloadIntent,
        taskId,
        dateNow(dependencies)
      );
      job = markKnownProviderTaskForReconciliation(
        db,
        getIntent(db, downloadIntent.intent_id) ?? downloadIntent,
        downloadJob,
        taskId,
        quarantined.ok
          ? providerError("PROVIDER_OUTPUT_ACTIVATION_REQUIRED", "Provider output did not use the worker finalization capability.")
          : quarantined.error,
        leaseToken,
        "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
      );
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      assertJobLease(db, job.job_id, leaseToken);
      const currentIntent = getIntent(db, intent.intent_id);
      const currentJob = jobForIntent(db, intent.intent_id);
      const shot = getShot(db, intent.shot_id);
      const project = getProject(db, intent.project_id);
      const run = getGenerationRun(db, intent.run_id);
      const finalOutput = output;
      if (!currentIntent || !currentJob || !shot || !project || !run || !finalOutput) {
        throw new Error("LOCAL_FINALIZATION_STATE_MISSING");
      }
      const finalAuthorityError = generationExecutionAuthorityError(
        db,
        currentIntent,
        currentJob,
        job.state as GenerationExecutionBindingInput["expected_job_state"]
      );
      if (finalAuthorityError) throw new Error(finalAuthorityError.code);
      const durableOutput = existingOutputArtifact(
        db,
        taskId,
        currentIntent.project_id,
        currentIntent.shot_id,
        currentIntent.intent_id
      );
      if (!durableOutput.ok || !durableOutput.artifact || durableOutput.artifact.artifact_id !== finalOutput.artifact_id) {
        throw new Error("PROVIDER_OUTPUT_BINDING_INVALID");
      }
      if (automation) {
        try {
          loadDirectorGrantAuthorization(db, automation, "artifact.activate", dateNow(dependencies), { verify_target_state: false });
        } catch (caught) {
          throw new Error(caught instanceof Error && "code" in caught
            ? String(caught.code)
            : "DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED");
        }
      }
      job = setJobState(db, currentJob, "finalizing", "", { lease_token: leaseToken, in_transaction: true });
      if (!shot.clip_versions.some((version) => version.artifact_id === finalOutput.artifact_id)) {
        shot.clip_versions.push({ artifact_id: finalOutput.artifact_id, run_id: run.run_id, attempt_number: run.versioning.attempt_number, review_status: "pending" });
      }
      shot.status = "video_review";
      saveShot(db, shot);
      project.status = "video_review";
      saveProject(db, project);
      run.status = "succeeded";
      run.output.artifact_ids = [finalOutput.artifact_id];
      run.provider.provider_job_id = taskId;
      run.provider.provider_status = "SUCCESS";
      run.error = { code: "", message: "", retryable: false };
      saveGenerationRun(db, run);
      db.prepare(`UPDATE generation_intents SET status = 'succeeded', output_artifact_id = ?, sanitized_error_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?`)
        .run(finalOutput.artifact_id, intent.intent_id);
      persistProviderOutputRecovery(db, intent.intent_id, null);
      transitionGenerationExecutionReceipt(db, intent.intent_id, {
        state: "succeeded",
        provider_status: "SUCCESS",
        result_artifact_id: finalOutput.artifact_id
      });
      job = setJobState(db, job, "succeeded", "", { lease_token: leaseToken, in_transaction: true });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error instanceof GenerationJobLeaseLostError) return;
    const intent = getIntent(db, intentId);
    if (intent && providerTaskMayExist && knownTaskId) {
      try {
        job = markKnownProviderTaskForReconciliation(db, intent, job, knownTaskId, providerError("LOCAL_WORKER_STATE_UNKNOWN", "Generation worker failed after Provider task creation; manual reconciliation is required."), leaseToken, "LOCAL_WORKER_REQUIRES_RECONCILIATION");
      } catch { /* leave the active intent non-terminal for restart recovery */ }
    } else if (intent) {
      failIntent(db, intent, "failed", providerError("PROVIDER_REQUEST_FAILED", "Generation worker failed before a Provider task identity was established."), leaseToken, job);
    }
  } finally {
    clearInterval(heartbeat);
    try {
      releaseJobLease(db, job.job_id, leaseToken);
    } finally {
      db.close();
    }
  }
}

export function startWorkbenchGeneration(intentId: string, input: { allow_submit: boolean; dependencies?: WorkbenchGenerationDependencies }): void {
  if (activeExecutions.has(intentId) || activeExecutions.size >= 1) return;
  const dependencies = input.dependencies ?? {};
  const scheduled = scheduledWakeups.get(schedulerKey(dependencies));
  if (scheduled) {
    clearTimeout(scheduled);
    scheduledWakeups.delete(schedulerKey(dependencies));
  }
  const execution = executeIntent(intentId, input.allow_submit, dependencies).catch(() => undefined).finally(() => {
    activeExecutions.delete(intentId);
    scheduleNextPersistedGeneration(dependencies);
  });
  activeExecutions.set(intentId, execution);
}

function scheduleNextPersistedGeneration(dependencies: WorkbenchGenerationDependencies, delayMs = 0): void {
  if (activeExecutions.size >= 1) return;
  const key = schedulerKey(dependencies);
  const existing = scheduledWakeups.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    scheduledWakeups.delete(key);
    try {
      startNextPersistedGeneration(dependencies);
    } catch (error) {
      try { dependencies.on_scheduler_error?.(error); } catch { /* observer failures must not escape the wakeup */ }
      const retryDelay = Math.min(30_000, Math.max(250, dependencies.scheduler_retry_ms ?? 1_000));
      scheduleNextPersistedGeneration(dependencies, retryDelay);
    }
  }, Math.max(0, delayMs));
  timer.unref();
  scheduledWakeups.set(key, timer);
}

function startNextPersistedGeneration(dependencies: WorkbenchGenerationDependencies): void {
  if (activeExecutions.size >= 1) return;
  const db = (dependencies.open_database ?? openM0Database)(dependencies.sqlite_path);
  try {
    const now = dateNow(dependencies);
    const nowIso = now.toISOString();
    const row = db.prepare(`SELECT i.intent_id, i.provider_task_id, j.state FROM generation_intents i
      JOIN generation_jobs j ON j.intent_id = i.intent_id
      WHERE i.status IN ('queued','running')
        AND (i.provider_task_id <> '' OR (i.provider_task_id = '' AND j.state = 'queued'))
        AND j.state IN ('queued','polling','downloading','finalizing')
        AND (
          julianday(j.next_attempt_at) <= julianday(?)
          OR (
            j.state = 'polling'
            AND (
              julianday(CASE
                WHEN json_valid(i.data_json) = 1
                  THEN json_extract(i.data_json, '$.provider_poll_started_at')
                ELSE NULL
              END) > julianday(?)
              OR julianday(CASE
                WHEN json_valid(i.data_json) = 1
                  THEN json_extract(i.data_json, '$.provider_poll_deadline_at')
                ELSE NULL
              END) <= julianday(?)
            )
          )
        )
        AND (
          j.lease_token = ''
          OR j.lease_expires_at IS NULL
          OR julianday(j.lease_expires_at) <= julianday(?)
          OR (
            j.state = 'polling'
            AND (
              julianday(CASE
                WHEN json_valid(i.data_json) = 1
                  THEN json_extract(i.data_json, '$.provider_poll_started_at')
                ELSE NULL
              END) > julianday(?)
              OR julianday(CASE
                WHEN json_valid(i.data_json) = 1
                  THEN json_extract(i.data_json, '$.provider_poll_deadline_at')
                ELSE NULL
              END) <= julianday(?)
            )
          )
        )
      ORDER BY j.created_at LIMIT 1`)
      .get(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso) as { intent_id: string; provider_task_id: string; state: GenerationJobState } | undefined;
    if (row) {
      startWorkbenchGeneration(row.intent_id, { allow_submit: row.state === "queued" && row.provider_task_id === "", dependencies });
      return;
    }
    const wakeup = db.prepare(`SELECT MIN(wake_jd) AS wake_jd FROM (
        SELECT CASE
          WHEN j.lease_token <> '' AND j.lease_expires_at IS NOT NULL
            AND julianday(j.lease_expires_at) > julianday(?)
            THEN julianday(j.lease_expires_at)
          ELSE julianday(j.next_attempt_at)
        END AS wake_jd
        FROM generation_intents i
        JOIN generation_jobs j ON j.intent_id = i.intent_id
        WHERE i.status IN ('queued','running')
          AND (i.provider_task_id <> '' OR (i.provider_task_id = '' AND j.state = 'queued'))
          AND j.state IN ('queued','polling','downloading','finalizing')
        UNION ALL
        SELECT julianday(CASE
          WHEN json_valid(i.data_json) = 1
            THEN json_extract(i.data_json, '$.provider_poll_deadline_at')
          ELSE NULL
        END) AS wake_jd
        FROM generation_intents i
        JOIN generation_jobs j ON j.intent_id = i.intent_id
        WHERE i.status IN ('queued','running')
          AND i.provider_task_id <> ''
          AND j.state = 'polling'
      ) WHERE wake_jd > julianday(?)`).get(nowIso, nowIso) as { wake_jd: number | null };
    if (wakeup.wake_jd !== null) {
      const wakeAtMs = (wakeup.wake_jd - 2_440_587.5) * 86_400_000;
      scheduleNextPersistedGeneration(dependencies, Math.max(50, wakeAtMs - now.getTime() + 50));
    }
  } finally { db.close(); }
}

export function resumeWorkbenchGenerationJobs(dependencies: WorkbenchGenerationDependencies = {}): { resumed: string[]; reconciled: string[] } {
  const db = openM0Database(dependencies.sqlite_path);
  try {
    const rows = db.prepare(`SELECT i.intent_id, i.provider_task_id, j.state, j.job_id,
        j.lease_token, j.lease_expires_at
      FROM generation_intents i JOIN generation_jobs j ON j.intent_id = i.intent_id
      WHERE i.status IN ('queued', 'running') AND j.state NOT IN ('succeeded', 'failed', 'cancelled') ORDER BY j.created_at`).all() as Array<{
        intent_id: string;
        provider_task_id: string;
        state: GenerationJobState;
        job_id: string;
        lease_token: string;
        lease_expires_at: string | null;
      }>;
    const resumed: string[] = [];
    const reconciled: string[] = [];
    for (const row of rows) {
      if (row.state === "manual_reconciliation") {
        reconciled.push(row.intent_id);
      } else if (row.state === "submitting" && row.provider_task_id) {
        const leaseExpiryMs = row.lease_expires_at ? Date.parse(row.lease_expires_at) : Number.NaN;
        const leaseIsLive = row.lease_token !== "" && Number.isFinite(leaseExpiryMs) && leaseExpiryMs > Date.now();
        if (leaseIsLive) {
          const recoveryKey = `${schedulerKey(dependencies)}:${row.job_id}`;
          const existing = submittingRecoveryWakeups.get(recoveryKey);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            submittingRecoveryWakeups.delete(recoveryKey);
            try { resumeWorkbenchGenerationJobs(dependencies); } catch { /* the next startup/readiness check retries */ }
          }, Math.max(50, leaseExpiryMs - Date.now() + 50));
          timer.unref();
          submittingRecoveryWakeups.set(recoveryKey, timer);
          resumed.push(row.intent_id);
          continue;
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          const currentIntent = getIntent(db, row.intent_id);
          const currentJob = jobForIntent(db, row.intent_id);
          if (!currentIntent || !currentJob || currentJob.state !== "submitting"
            || currentIntent.provider_task_id !== row.provider_task_id) {
            throw new Error("GENERATION_SUBMIT_RECOVERY_STATE_CHANGED");
          }
          const currentReceipt = getGenerationExecutionReceipt(db, row.intent_id);
          if (currentReceipt?.provider_task_id === row.provider_task_id) {
            transitionGenerationExecutionReceipt(db, row.intent_id, {
              state: "reconciling",
              provider_task_id: row.provider_task_id,
              provider_status: "GENERATION_SUBMIT_INTERRUPTED_WITH_KNOWN_TASK"
            });
          }
          enterManualReconciliationJob(
            db,
            currentJob,
            "GENERATION_SUBMIT_INTERRUPTED_WITH_KNOWN_TASK",
            { record_event: true }
          );
          db.exec("COMMIT");
          reconciled.push(row.intent_id);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } else if (row.provider_task_id || row.state === "queued") {
        resumed.push(row.intent_id);
      } else {
        const intent = getIntent(db, row.intent_id);
        const job = jobForIntent(db, row.intent_id);
        if (intent && job) {
          markUnknownSubmission(
            db,
            intent,
            job,
            providerError("PROVIDER_REQUEST_FAILED", "Provider submission outcome requires human reconciliation.")
          );
        }
        reconciled.push(row.intent_id);
      }
    }
    scheduleNextPersistedGeneration(dependencies);
    return { resumed, reconciled };
  } finally {
    db.close();
  }
}

export function getWorkbenchGenerationIntent(intentId: string, db = openM0Database()): WorkbenchV2Result<{ intent: WorkbenchGenerationIntent; job: GenerationJob | null }> {
  const intent = getIntent(db, intentId);
  return intent ? { ok: true, data: { intent, job: jobForIntent(db, intentId) } } : { ok: false, error: { code: "GENERATION_INTENT_NOT_FOUND", message: "Generation intent was not found." } };
}

export async function runWorkbenchGenerationOnce(intentId: string, input: { allow_submit: boolean; dependencies?: WorkbenchGenerationDependencies }): Promise<void> {
  await executeIntent(intentId, input.allow_submit, input.dependencies ?? {});
}

export function reconcileGenerationJob(
  jobId: string,
  input: { decision: string; provider_task_id?: string; reason?: string; human_confirmation: boolean },
  db = openM0Database(),
  dependencies: Pick<WorkbenchGenerationDependencies, "env" | "now"> = {}
): WorkbenchV2Result<{ job: GenerationJob; intent: WorkbenchGenerationIntent }> {
  if (input.human_confirmation !== true) return { ok: false, error: { code: "GENERATION_CONFIRMATION_REQUIRED", message: "Human confirmation is required." } };
  if (input.decision !== "attach_existing_task" && input.decision !== "abandon") {
    return { ok: false, error: { code: "INVALID_RECONCILIATION_DECISION", message: "Decision must be attach_existing_task or abandon.", field: "decision" } };
  }
  const abandonReason = input.reason?.trim() ?? "";
  if (input.decision === "abandon" && (abandonReason.length < 3 || abandonReason.length > 1_000)) {
    return { ok: false, error: { code: "RECONCILIATION_REASON_REQUIRED", message: "Abandoning a generation attempt requires a reason between 3 and 1000 characters.", field: "reason" } };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT job_id, intent_id, state, reconciliation_reason, lease_expires_at FROM generation_jobs WHERE job_id = ?").get(jobId) as GenerationJob | undefined;
    if (!row) { db.exec("ROLLBACK"); return { ok: false, error: { code: "GENERATION_JOB_NOT_FOUND", message: "Generation job was not found." } }; }
    if (row.state !== "manual_reconciliation") { db.exec("ROLLBACK"); return { ok: false, error: { code: "GENERATION_JOB_NOT_RECONCILABLE", message: "Generation job does not require reconciliation." } }; }
    const intent = getIntent(db, row.intent_id);
    if (!intent) { db.exec("ROLLBACK"); return { ok: false, error: { code: "GENERATION_INTENT_NOT_FOUND", message: "Generation intent was not found." } }; }
    const writable = assertWorkbenchProjectWritable(db, intent.project_id);
    if (!writable.ok) { db.exec("ROLLBACK"); return writable; }
    const shot = getShot(db, intent.shot_id);
    const run = intent.run_id ? getGenerationRun(db, intent.run_id) : null;
    let restoreState = persistedReconciliationRestoreState(db, intent.intent_id);
    let migratedRestoreState = false;
    if (!restoreState && shot) {
      restoreState = migratedReconciliationRestoreState(db, row, intent, writable.data.project, shot);
      if (restoreState) {
        migratedRestoreState = true;
        persistReconciliationRestoreState(db, intent.intent_id, restoreState);
      }
    }
    const migration0016Quarantine = restoreState !== null && shot !== null
      && isMigration0016ExecutionQuarantine(db, row, intent, writable.data.project, shot);
    const shotStateMatches = restoreState !== null && shot !== null
      && (shot.status === restoreState.shot_status
        || ((migratedRestoreState || migration0016Quarantine) && shot.status === "video_pending"));
    if (!restoreState || !shot || !run
      || writable.data.project.status === "final_approved"
      || !writable.data.project.shot_ids.includes(intent.shot_id)
      || shot.project_id !== intent.project_id
      || !shotStateMatches
      || !intent.confirmed
      || (intent.status !== "queued" && intent.status !== "running")
      || run.project_id !== intent.project_id
      || run.shot_id !== intent.shot_id
      || (run.status !== "queued" && run.status !== "running")
      || shot.generation_run_ids.at(-1) !== intent.run_id) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        error: {
          code: "GENERATION_RECONCILIATION_CONTEXT_STALE",
          message: "Project terminal state or target SHOT generation binding changed after this generation entered reconciliation.",
          field: "job_id"
        }
      };
    }
    const directorRequirement = resolveDirectorExecutionRequirement(db, intent);
    if (!directorRequirement.ok) {
      db.exec("ROLLBACK");
      return { ok: false, error: { code: directorRequirement.error.code, message: directorRequirement.error.message } };
    }
    const automation = directorRequirement.required ? directorRequirement.automation : null;
    let job: GenerationJob;
    if (input.decision === "attach_existing_task") {
      let pollTimeoutMs: number;
      try {
        pollTimeoutMs = parseProviderTaskPollTimeoutMs(dependencies.env ?? process.env);
      } catch (caught) {
        if (!(caught instanceof ProviderPollTimeoutConfigurationError)) throw caught;
        db.exec("ROLLBACK");
        return { ok: false, error: { code: caught.code, message: "Provider poll timeout configuration is invalid." } };
      }
      const taskId = input.provider_task_id?.trim() || intent.provider_task_id.trim();
      if (!/^[A-Za-z0-9._:-]{3,200}$/.test(taskId) || /^local_recovery_/i.test(taskId)) {
        db.exec("ROLLBACK");
        return { ok: false, error: { code: "INVALID_PROVIDER_TASK_ID", message: "Provider task ID is invalid." } };
      }
      const executionReceipt = getGenerationExecutionReceipt(db, intent.intent_id);
      if (executionReceipt?.provider_task_id && executionReceipt.provider_task_id !== taskId) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          error: {
            code: "GENERATION_EXECUTION_TASK_IMMUTABLE",
            message: "A persisted Provider task cannot be replaced; reconcile the retained task or abandon this generation attempt."
          }
        };
      }
      const owningIntent = db.prepare("SELECT intent_id FROM generation_intents WHERE provider_task_id = ? AND intent_id <> ? LIMIT 1")
        .get(taskId, intent.intent_id) as { intent_id: string } | undefined;
      const owningArtifact = db.prepare(`SELECT artifact_id, project_id, shot_id, json_extract(data_json, '$.source.provider') AS provider FROM media_artifacts
        WHERE json_valid(data_json) = 1
          AND json_extract(data_json, '$.source.provider_job_id') = ?
        LIMIT 1`).get(taskId) as { artifact_id: string; project_id: string | null; shot_id: string | null; provider: string | null } | undefined;
      if (owningIntent || (owningArtifact && (owningArtifact.provider !== intent.provider || owningArtifact.project_id !== intent.project_id || owningArtifact.shot_id !== intent.shot_id))) {
        db.exec("ROLLBACK");
        return { ok: false, error: { code: "PROVIDER_TASK_ALREADY_OWNED", message: "Provider task ID is already owned by another generation." } };
      }
      const persistedRecovery = providerOutputRecoveryFromIntent(db, intent.intent_id, intent.provider_task_id);
      if (!persistedRecovery.ok) {
        db.exec("ROLLBACK");
        return { ok: false, error: { code: persistedRecovery.error.code, message: "Existing Provider output recovery state could not be preserved safely." } };
      }
      let outputRecovery = persistedRecovery.recovery;
      if (outputRecovery && taskId !== outputRecovery.provider_task_id) {
        const retired = retireProviderOutputRecoveryArtifacts(db, intent, outputRecovery);
        if (!retired.ok) {
          db.exec("ROLLBACK");
          return { ok: false, error: { code: retired.error.code, message: "Previous Provider output recovery state could not be retired safely." } };
        }
        outputRecovery = null;
      }
      if (!outputRecovery
        && row.reconciliation_reason === "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
        && taskId === intent.provider_task_id) {
        const existingOutput = existingOutputArtifact(db, taskId, intent.project_id, intent.shot_id, intent.intent_id);
        if (!existingOutput.ok) {
          if (!existingOutput.invalid_artifact_id) {
            db.exec("ROLLBACK");
            return { ok: false, error: { code: existingOutput.error.code, message: "Existing Provider output Artifact could not be prepared for replacement." } };
          }
          outputRecovery = {
            version: 1,
            provider_task_id: taskId,
            invalid_artifact_id: existingOutput.invalid_artifact_id,
            local_identity: `local_recovery_${randomUUID()}`,
            requested_at: dateNow(dependencies).toISOString()
          };
        }
      }
      // A human-confirmed existing task may be the successful outcome of an
      // ambiguous submission. It therefore settles the exact reservation as
      // spend before polling, even though no worker submit response was saved.
      if (automation && intent.run_id) {
        consumeDirectorGrantReservation(db, automation, {
          amount_minor: automation.amount_minor!,
          currency: intent.currency,
          intent_id: intent.intent_id,
          run_id: intent.run_id,
          reason_code: "DIRECTOR_AUTOMATION_SUBMITTED_RECONCILED"
        });
      }
      db.prepare("UPDATE generation_intents SET provider_task_id = ?, status = 'running', sanitized_error_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?").run(taskId, intent.intent_id);
      persistProviderOutputRecovery(db, intent.intent_id, outputRecovery);
      restartProviderPollDeadlineAfterHumanAttachment(
        db,
        intent.intent_id,
        pollTimeoutMs,
        dateNow(dependencies).getTime()
      );
      run.status = "running";
      run.provider.provider_job_id = taskId;
      run.provider.provider_status = "HUMAN_ATTACHED_EXISTING_TASK";
      run.error = { code: "", message: "", retryable: false };
      saveGenerationRun(db, run);
      markProjectAndShotGenerationActive(db, intent);
      const attachedIntent = getIntent(db, intent.intent_id);
      if (!attachedIntent) throw new Error("GENERATION_INTENT_NOT_FOUND");
      job = setJobState(db, row, "polling", "HUMAN_ATTACHED_EXISTING_TASK", { in_transaction: true });
      if (!getGenerationExecutionReceipt(db, intent.intent_id)) {
        const createdReceipt = createGenerationExecutionReceipt(db, executionBinding(attachedIntent, job, "polling"));
        if (!createdReceipt.ok) {
          db.exec("ROLLBACK");
          return { ok: false, error: createdReceipt.error };
        }
      }
      transitionGenerationExecutionReceipt(db, intent.intent_id, {
        state: "submitted",
        provider_task_id: taskId,
        provider_status: "HUMAN_ATTACHED_EXISTING_TASK"
      });
    } else {
      // Abandon ends this generation attempt. Retire any explicitly tracked
      // recovery Artifacts first; a previously consumed Grant remains spent.
      const persistedRecovery = providerOutputRecoveryFromIntent(db, intent.intent_id, intent.provider_task_id);
      if (!persistedRecovery.ok) {
        db.exec("ROLLBACK");
        return { ok: false, error: { code: persistedRecovery.error.code, message: "Existing Provider output recovery state could not be abandoned safely." } };
      }
      if (persistedRecovery.recovery) {
        const retired = retireProviderOutputRecoveryArtifacts(db, intent, persistedRecovery.recovery);
        if (!retired.ok) {
          db.exec("ROLLBACK");
          return { ok: false, error: { code: retired.error.code, message: "Provider output recovery artifacts could not be abandoned safely." } };
        }
        persistProviderOutputRecovery(db, intent.intent_id, null);
      }
      if (automation && intent.run_id) {
        releaseDirectorGrantReservation(db, automation, {
          amount_minor: automation.amount_minor!,
          currency: intent.currency,
          intent_id: intent.intent_id,
          run_id: intent.run_id,
          reason_code: "DIRECTOR_AUTOMATION_HUMAN_ABANDONED"
        });
      }
      db.prepare("UPDATE generation_intents SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?").run(intent.intent_id);
      const run = getGenerationRun(db, intent.run_id);
      if (run) { run.status = "cancelled"; saveGenerationRun(db, run); }
      if (getGenerationExecutionReceipt(db, intent.intent_id)) {
        transitionGenerationExecutionReceipt(db, intent.intent_id, { state: "cancelled" });
      }
      restoreProjectAfterGenerationAutomationStops(db, intent);
      job = setJobState(db, row, "cancelled", abandonReason, { in_transaction: true });
    }
    db.exec("COMMIT");
    return { ok: true, data: { job, intent: getIntent(db, intent.intent_id) as WorkbenchGenerationIntent } };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
