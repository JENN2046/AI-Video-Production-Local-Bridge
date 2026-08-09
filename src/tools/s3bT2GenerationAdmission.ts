import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getProject, getShot, type Project, type Shot } from "./projects.js";
import { evaluateGenerationAdmission } from "./s3bT2AdmissionEvaluate.js";
import { readGenerationAdmissionCandidateFacts } from "./s3bT2AdmissionFacts.js";
import {
  buildGenerationPlan,
  parseGenerationPlan,
  planMatchesFacts
} from "./s3bT2AdmissionPlan.js";
import type {
  GenerationAdmissionDecision,
  GenerationAdmissionFacts,
  GenerationPlan
} from "./s3bT2Types.js";
import {
  commitCanonicalGenerationAdmission,
  generationRightConflict,
  type CanonicalGenerationAdmissionCommitInput,
  type WorkbenchGenerationIntent
} from "./workbenchGeneration.js";

export type PrepareGenerationInput = {
  project_id?: string;
  shot_id?: string;
};

export type PrepareGenerationResult =
  | { ok: true; data: { plan: GenerationPlan; decision: GenerationAdmissionDecision } }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        candidate_count?: number;
        reason_codes?: string[];
      };
      decision?: GenerationAdmissionDecision;
    };

export type ConfirmGenerationResult =
  | { ok: true; data: { plan: GenerationPlan; intent: WorkbenchGenerationIntent; run_id: string; job_id: string; status: "prepared" | "queued" } }
  | { ok: false; error: { code: string; message: string } };

type Candidate = { facts: GenerationAdmissionFacts; decision: GenerationAdmissionDecision };
type CandidateRead = {
  candidates: Candidate[];
  candidate_count: number;
  reason_codes: string[];
};

function error(
  code: string,
  message: string,
  metadata: Pick<NonNullable<Extract<PrepareGenerationResult, { ok: false }>["error"]>, "candidate_count" | "reason_codes"> = {}
): { ok: false; error: { code: string; message: string; candidate_count?: number; reason_codes?: string[] } } {
  return { ok: false, error: { code, message, ...metadata } };
}

function readCandidates(db: M0Database, input: PrepareGenerationInput): CandidateRead {
  const candidates: Candidate[] = [];
  const reasonCodes = new Set<string>();
  const read = readGenerationAdmissionCandidateFacts(db, input);
  if (!read.ok) {
    return {
      candidates,
      candidate_count: 0,
      reason_codes: [read.error.code]
    };
  }
  for (const facts of read.facts) {
    const decision = evaluateGenerationAdmission(facts);
    if (decision.state === "ELIGIBLE") {
      candidates.push({ facts, decision });
      continue;
    }
    Object.keys(decision.reason_code_counts).forEach((code) => reasonCodes.add(code));
  }
  return {
    candidates,
    candidate_count: candidates.length,
    reason_codes: [...reasonCodes].sort()
  };
}

/**
 * Offline preparation.  It reads authority-backed facts, runs the pure T2
 * policy, and returns one immutable plan.  It never writes an intent and
 * never performs network, credential or Provider work.
 */
export function prepareGeneration(
  input: PrepareGenerationInput = {},
  db = openM0Database()
): PrepareGenerationResult {
  const candidateRead = readCandidates(db, input);
  const { candidates } = candidateRead;
  if (candidates.length === 0) {
    return error("S3_NO_ELIGIBLE_SHOT", "No unique eligible SHOT satisfied the Generation Admission policy.", {
      candidate_count: candidateRead.candidate_count,
      reason_codes: candidateRead.reason_codes.length > 0 ? candidateRead.reason_codes : ["S3_NO_ELIGIBLE_SHOT"]
    });
  }
  if (candidates.length > 1) {
    return error("S3_MULTIPLE_ELIGIBLE_SHOTS", "More than one SHOT satisfied the Generation Admission policy.", {
      candidate_count: candidates.length,
      reason_codes: ["S3_MULTIPLE_ELIGIBLE_SHOTS"]
    });
  }
  try {
    const candidate = candidates[0];
    return {
      ok: true,
      data: {
        plan: buildGenerationPlan(candidate.facts),
        decision: candidate.decision
      }
    };
  } catch {
    return error("GENERATION_PLAN_FACTS_INCOMPLETE", "Trusted admission facts could not be compiled into a GenerationPlan.", {
      candidate_count: candidates.length,
      reason_codes: ["GENERATION_PLAN_FACTS_INCOMPLETE"]
    });
  }
}

function factsForPlanConfirmation(facts: GenerationAdmissionFacts, plan: GenerationPlan): GenerationAdmissionFacts {
  if (facts.media.status === "INVALID") return facts;
  return {
    ...facts,
    media: {
      ...facts.media,
      status: "VALID",
      verification_level: "bytes_verified",
      media_verification_token: plan.media_verification_token
    }
  };
}

function canonicalCommitInput(
  project: Project,
  shot: Shot,
  facts: GenerationAdmissionFacts,
  plan: GenerationPlan
): CanonicalGenerationAdmissionCommitInput {
  return {
    project,
    shot,
    provider: "runninghub",
    model: facts.provider.model,
    input_artifact_id: plan.storyboard_artifact_id,
    duration_seconds: plan.duration_seconds,
    resolution: plan.resolution,
    input_snapshot: {
      video_prompt: facts.shot.video_prompt,
      negative_prompt: facts.shot.negative_prompt,
      aspect_ratio: plan.aspect_ratio,
      project_resolution: facts.project.video_spec.resolution,
      price_source: "local_verified_cache",
      balance_gate: "not_checked",
      requires_human_preflight: true,
      prepared_by: "t2_admission",
      capability_key: facts.provider.capability_key,
      admission_only: true
    },
    generation_plan: plan,
    account_label: "personal",
    estimated_cost_value: 0,
    budget_limit_value: 0,
    currency: "UNSET",
    reservation_only: true
  };
}

/**
 * Atomic Generation Admission Commit.  The only work inside the transaction
 * is persisted-fact re-read, revision comparison, policy confirmation, and
 * the canonical Generation Domain intent/run/job write.
 */
export function confirmGeneration(
  planInput: GenerationPlan,
  db = openM0Database()
): ConfirmGenerationResult {
  const plan = parseGenerationPlan(planInput);
  if (!plan) return error("GENERATION_PLAN_INVALID", "GenerationPlan does not match generation_plan.v1.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readGenerationAdmissionCandidateFacts(
      db,
      { project_id: plan.project_id, shot_id: plan.shot_id },
      { verify_media: false }
    );
    if (!current.ok || current.facts.length !== 1) {
      db.exec("ROLLBACK");
      return error("GENERATION_PLAN_STALE", "GenerationPlan no longer resolves to the same selected SHOT authority.");
    }
    const currentFacts = current.facts[0];
    if (currentFacts.generation.active_intent_count > 0) {
      db.exec("ROLLBACK");
      return error("REAL_GENERATION_ALREADY_ACTIVE", "Another active generation intent already owns the generation slot.");
    }
    if (generationRightConflict(db)) {
      db.exec("ROLLBACK");
      return error("REAL_GENERATION_ALREADY_ACTIVE", "Another generation right already owns the generation slot.");
    }
    if (!planMatchesFacts(plan, currentFacts)) {
      db.exec("ROLLBACK");
      return error("GENERATION_PLAN_STALE", "Persisted generation-admission facts changed after plan preparation.");
    }
    const confirmedFacts = factsForPlanConfirmation(currentFacts, plan);
    const decision = evaluateGenerationAdmission(confirmedFacts);
    if (decision.state !== "ELIGIBLE"
      || decision.candidates.length !== 1
      || decision.candidates[0].project_id !== plan.project_id
      || decision.candidates[0].shot_id !== plan.shot_id) {
      db.exec("ROLLBACK");
      return error("GENERATION_PLAN_STALE", "The selected SHOT is no longer eligible for Generation Admission.");
    }
    const project = getProject(db, plan.project_id);
    const shot = getShot(db, plan.shot_id);
    if (!project || !shot || shot.project_id !== project.project_id) {
      db.exec("ROLLBACK");
      return error("GENERATION_PLAN_STALE", "The selected Project or SHOT disappeared before admission commit.");
    }
    const committed = commitCanonicalGenerationAdmission(canonicalCommitInput(project, shot, confirmedFacts, plan), db);
    db.exec("COMMIT");
    return { ok: true, data: { plan, ...committed } };
  } catch (caught) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction may already be closed */ }
    const message = caught instanceof Error ? caught.message : "Generation admission commit failed.";
    if (/constraint|busy|locked/i.test(message)) return error("GENERATION_ADMISSION_CONFLICT", "Generation admission failed closed on a concurrent database conflict.");
    throw caught;
  }
}

export { evaluateGenerationAdmission } from "./s3bT2AdmissionEvaluate.js";
export { buildDecisionRevision, buildInputDigest, buildGenerationPlan, mediaVerificationToken, revalidateGenerationPlanMedia } from "./s3bT2AdmissionPlan.js";
