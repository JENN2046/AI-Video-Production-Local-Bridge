import { openM0Database, type M0Database } from "../storage/sqlite.js";
import {
  confirmGeneration,
  prepareGeneration,
  type ConfirmGenerationResult,
  type PrepareGenerationInput,
  type PrepareGenerationResult
} from "./s3bT2GenerationAdmission.js";
import type { GenerationPlan } from "./s3bT2Types.js";

/**
 * The only public receipt shape for offline admission preparation.  It keeps
 * authority-backed paths, hashes, media tokens, prompts, and the full plan
 * inside the local application boundary.
 */
export type GenerationAdmissionProjection = {
  result: "READY" | "BLOCKED";
  candidate_count: number;
  reason_codes: string[];
};

export type PreparedGenerationAdmission =
  | {
      result: "READY";
      plan: GenerationPlan;
      projection: GenerationAdmissionProjection;
    }
  | {
      result: "BLOCKED";
      projection: GenerationAdmissionProjection;
    };

export type ConfirmGenerationAdmissionResult =
  | {
      result: "CONFIRMED";
      intent_id: string;
      run_id: string;
      job_id: string;
      status: "queued";
    }
  | {
      result:
        | "BLOCKED"
        | "GENERATION_PLAN_INVALID"
        | "GENERATION_PLAN_STALE"
        | "REAL_GENERATION_ALREADY_ACTIVE"
        | "GENERATION_ADMISSION_CONFLICT";
      reason_code: string;
    };

type ConfirmGenerationAdmissionBlockedResult = Exclude<ConfirmGenerationAdmissionResult, { result: "CONFIRMED" }>["result"];

function stableReasonCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.filter((code) => code.length > 0))].sort();
}

function prepareProjection(result: PrepareGenerationResult): GenerationAdmissionProjection {
  if (result.ok) {
    return { result: "READY", candidate_count: 1, reason_codes: [] };
  }
  return {
    result: "BLOCKED",
    candidate_count: result.error.candidate_count ?? 0,
    reason_codes: stableReasonCodes(result.error.reason_codes ?? [result.error.code])
  };
}

/**
 * Formal offline Prepare surface.  The existing IS2.5 preparation path owns
 * fact reads, pure policy evaluation, and GenerationPlan construction.  This
 * surface only adds the stable internal/public boundary around that path.
 */
export function prepareGenerationAdmission(
  input: PrepareGenerationInput = {},
  db: M0Database = openM0Database()
): PreparedGenerationAdmission {
  const prepared = prepareGeneration(input, db);
  const projection = prepareProjection(prepared);
  if (!prepared.ok) return { result: "BLOCKED", projection };
  return { result: "READY", plan: prepared.data.plan, projection };
}

/**
 * Public low-disclosure projection for Workbench/UI callers.  Callers that
 * need to continue inside the local application retain the internal prepared
 * result and pass its plan to the Confirm surface explicitly.
 */
export function projectGenerationAdmission(
  prepared: PreparedGenerationAdmission
): GenerationAdmissionProjection {
  return {
    result: prepared.projection.result,
    candidate_count: prepared.projection.candidate_count,
    reason_codes: [...prepared.projection.reason_codes]
  };
}

function confirmationResult(result: ConfirmGenerationResult): ConfirmGenerationAdmissionResult {
  if (result.ok) {
    return {
      result: "CONFIRMED",
      intent_id: result.data.intent.intent_id,
      run_id: result.data.run_id,
      job_id: result.data.job_id,
      status: result.data.status
    };
  }
  const knownResult = new Set([
    "GENERATION_PLAN_INVALID",
    "GENERATION_PLAN_STALE",
    "REAL_GENERATION_ALREADY_ACTIVE",
    "GENERATION_ADMISSION_CONFLICT"
  ]);
  return {
    result: knownResult.has(result.error.code)
      ? result.error.code as ConfirmGenerationAdmissionBlockedResult
      : "BLOCKED",
    reason_code: result.error.code
  };
}

/**
 * Formal Confirm surface.  The existing IS2.5 atomic confirmation owns
 * persisted-fact revalidation and the one canonical Generation Domain intent
 * writer.  This wrapper deliberately returns no intent payload or plan.
 */
export function confirmGenerationAdmission(
  plan: GenerationPlan,
  db: M0Database = openM0Database()
): ConfirmGenerationAdmissionResult {
  return confirmationResult(confirmGeneration(plan, db));
}
