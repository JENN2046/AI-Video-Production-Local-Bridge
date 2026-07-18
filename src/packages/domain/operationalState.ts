export type StoredShotWorkflowStatus =
  | "draft"
  | "storyboard_approved"
  | "video_pending"
  | "video_generated"
  | "video_review"
  | "approved"
  | "revision_needed";

export type ArtifactOperationalStatus =
  | "missing"
  | "active"
  | "inactive"
  | "binding_invalid"
  | "role_invalid"
  | "integrity_invalid";

export type ArtifactVerificationLevel = "none" | "ledger_verified" | "bytes_verified";

export interface ArtifactOperationalFact {
  artifact_id: string | null;
  status: ArtifactOperationalStatus;
  verification_level: ArtifactVerificationLevel;
}

export type GenerationOperationalJobState =
  | "queued"
  | "submitting"
  | "polling"
  | "downloading"
  | "finalizing"
  | "manual_reconciliation"
  | "succeeded"
  | "failed"
  | "cancelled"
  | null;

export type GenerationOperationalRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;

export interface ShotOperationalFacts {
  shot_id: string;
  project_id: string;
  stored_workflow_status: StoredShotWorkflowStatus;
  duration_seconds: number;
  video_prompt_present: boolean;
  storyboard_artifact: ArtifactOperationalFact;
  accepted_clip_artifact: ArtifactOperationalFact;
  generation_version_count: number;
  accepted_clip_in_version_stack: boolean;
  accepted_clip_review_status: "pending" | "approved" | "rejected" | null;
  review_approval_status: "pending" | "approved" | "revision_needed";
  latest_version_review_status: "pending" | "approved" | "rejected" | null;
  generation_job_state: GenerationOperationalJobState;
  latest_generation_run_status: GenerationOperationalRunStatus;
}

export type ShotPrimaryStage =
  | "storyboard_draft"
  | "storyboard_blocked"
  | "storyboard_revision_needed"
  | "generation_ready"
  | "generation_queued"
  | "generation_running"
  | "manual_reconciliation"
  | "generation_failed"
  | "review_pending"
  | "clip_revision_needed"
  | "accepted"
  | "state_inconsistent";

export interface ShotOperationalState {
  shot_id: string;
  project_id: string;
  stored_workflow_status: StoredShotWorkflowStatus;
  primary_stage: ShotPrimaryStage;
  storyboard: {
    approval_status: "pending" | "approved" | "revision_needed";
    artifact_id: string | null;
    artifact_status: ArtifactOperationalStatus;
    verification_level: ArtifactVerificationLevel;
  };
  generation: {
    stage: "not_started" | "ready" | "queued" | "running" | "manual_reconciliation" | "failed" | "completed";
    workflow_ready: boolean;
    reason_codes: string[];
  };
  review: {
    stage: "not_started" | "pending" | "revision_needed" | "approved" | "inconsistent";
    reviewable: boolean;
    approval_status: "pending" | "revision_needed" | "approved" | null;
    selected_artifact_id: string | null;
  };
  delivery: {
    accepted_clip_artifact_id: string | null;
    ready: boolean;
    reason_codes: string[];
  };
  allowed_workflow_actions: {
    approve_storyboard: boolean;
    prepare_generation: boolean;
    confirm_generation: boolean;
    review_clip: boolean;
    regenerate: boolean;
  };
  blocker_codes: string[];
}

export interface ProjectOperationalSummary {
  shot_count: number;
  accepted_count: number;
  active_run_count: number;
  blocked_shot_count: number;
  blocker_count: number;
  blocker_codes: string[];
  blocker_code_counts: Record<string, number>;
  review_pending_count: number;
  revision_needed_count: number;
  latest_failed_count: number;
}

const ARTIFACT_REASON: Record<Exclude<ArtifactOperationalStatus, "active">, string> = {
  missing: "STORYBOARD_IMAGE_MISSING",
  inactive: "STORYBOARD_ARTIFACT_INACTIVE",
  binding_invalid: "STORYBOARD_ARTIFACT_BINDING_INVALID",
  role_invalid: "STORYBOARD_ARTIFACT_ROLE_INVALID",
  integrity_invalid: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID"
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function storyboardApproval(facts: ShotOperationalFacts): "pending" | "approved" | "revision_needed" {
  if (facts.stored_workflow_status === "draft") return "pending";
  if (facts.stored_workflow_status === "revision_needed" && facts.generation_version_count === 0) return "revision_needed";
  return "approved";
}

function reviewState(facts: ShotOperationalFacts): ShotOperationalState["review"] {
  if (facts.generation_version_count === 0) {
    if (facts.review_approval_status !== "pending"
      || facts.accepted_clip_artifact.artifact_id
      || ["video_generated", "video_review", "approved"].includes(facts.stored_workflow_status)) {
      return { stage: "inconsistent", reviewable: false, approval_status: null, selected_artifact_id: null };
    }
    return { stage: "not_started", reviewable: false, approval_status: null, selected_artifact_id: null };
  }

  if (facts.review_approval_status === "approved") {
    if (!facts.accepted_clip_artifact.artifact_id
      || facts.accepted_clip_artifact.status !== "active"
      || !facts.accepted_clip_in_version_stack
      || facts.accepted_clip_review_status !== "approved") {
      return { stage: "inconsistent", reviewable: true, approval_status: "approved", selected_artifact_id: facts.accepted_clip_artifact.artifact_id };
    }
    return { stage: "approved", reviewable: true, approval_status: "approved", selected_artifact_id: facts.accepted_clip_artifact.artifact_id };
  }

  if (facts.accepted_clip_artifact.artifact_id) {
    return { stage: "inconsistent", reviewable: true, approval_status: facts.review_approval_status, selected_artifact_id: facts.accepted_clip_artifact.artifact_id };
  }

  if (facts.review_approval_status === "revision_needed" || facts.latest_version_review_status === "rejected") {
    return { stage: "revision_needed", reviewable: true, approval_status: "revision_needed", selected_artifact_id: null };
  }

  return { stage: "pending", reviewable: true, approval_status: "pending", selected_artifact_id: null };
}

export function deriveShotOperationalState(facts: ShotOperationalFacts): ShotOperationalState {
  const approval = storyboardApproval(facts);
  const generationReasons: string[] = [];
  if (approval === "pending") generationReasons.push("STORYBOARD_APPROVAL_REQUIRED");
  if (approval === "revision_needed") generationReasons.push("STORYBOARD_REVISION_REQUIRED");
  if (facts.storyboard_artifact.status !== "active") generationReasons.push(ARTIFACT_REASON[facts.storyboard_artifact.status]);
  if (!facts.video_prompt_present) generationReasons.push("VIDEO_PROMPT_MISSING");
  if (!Number.isFinite(facts.duration_seconds) || facts.duration_seconds <= 0) generationReasons.push("SHOT_DURATION_INVALID");

  const review = reviewState(facts);
  const deliveryReasons: string[] = [];
  if (!facts.accepted_clip_artifact.artifact_id) deliveryReasons.push("SHOT_ACCEPTED_CLIP_MISSING");
  else {
    if (!facts.accepted_clip_in_version_stack) deliveryReasons.push("ARTIFACT_NOT_IN_SHOT_REVIEW");
    if (facts.accepted_clip_artifact.status !== "active") deliveryReasons.push(`ACCEPTED_CLIP_${facts.accepted_clip_artifact.status.toUpperCase()}`);
    if (review.stage !== "approved") deliveryReasons.push("SHOT_REVIEW_NOT_APPROVED");
  }

  const inconsistent = review.stage === "inconsistent";
  if (inconsistent) {
    generationReasons.push("SHOT_STATE_INCONSISTENT");
    deliveryReasons.push("SHOT_STATE_INCONSISTENT");
  }

  const generationReady = generationReasons.length === 0;
  const deliveryReady = deliveryReasons.length === 0;
  const activeJob = facts.generation_job_state;
  const generationStage: ShotOperationalState["generation"]["stage"] = activeJob === "manual_reconciliation"
    ? "manual_reconciliation"
    : activeJob === "queued" || activeJob === "submitting" || facts.latest_generation_run_status === "queued"
      ? "queued"
      : activeJob === "polling" || activeJob === "downloading" || activeJob === "finalizing" || facts.latest_generation_run_status === "running"
        ? "running"
        : facts.latest_generation_run_status === "failed" || activeJob === "failed"
          ? "failed"
          : facts.generation_version_count > 0
            ? "completed"
            : generationReady
              ? "ready"
              : "not_started";

  const primaryStage: ShotPrimaryStage = inconsistent
    ? "state_inconsistent"
    : generationStage === "manual_reconciliation"
      ? "manual_reconciliation"
      : generationStage === "queued"
        ? "generation_queued"
        : generationStage === "running"
          ? "generation_running"
          : generationStage === "failed"
            ? "generation_failed"
          : review.stage === "revision_needed"
            ? "clip_revision_needed"
            : review.stage === "approved" && deliveryReady
              ? "accepted"
              : review.stage === "pending"
                ? "review_pending"
                : approval === "revision_needed"
                    ? "storyboard_revision_needed"
                    : generationReady
                      ? "generation_ready"
                      : approval === "pending"
                        ? "storyboard_draft"
                        : "storyboard_blocked";

  const blockers = unique([
    ...(["storyboard_draft", "storyboard_blocked", "storyboard_revision_needed", "generation_ready", "generation_failed", "clip_revision_needed"].includes(primaryStage)
      ? generationReasons.filter((code) => code !== "STORYBOARD_APPROVAL_REQUIRED")
      : []),
    ...(primaryStage === "state_inconsistent" ? ["SHOT_STATE_INCONSISTENT"] : []),
    ...(primaryStage === "clip_revision_needed" ? ["CLIP_REVISION_REQUIRED"] : []),
    ...(primaryStage === "manual_reconciliation" ? ["GENERATION_MANUAL_RECONCILIATION"] : []),
    ...(primaryStage === "generation_failed" ? ["GENERATION_FAILED"] : []),
    ...(primaryStage === "accepted" ? [] : deliveryReasons.filter((code) => !["SHOT_ACCEPTED_CLIP_MISSING", "SHOT_REVIEW_NOT_APPROVED"].includes(code)))
  ]);

  return {
    shot_id: facts.shot_id,
    project_id: facts.project_id,
    stored_workflow_status: facts.stored_workflow_status,
    primary_stage: primaryStage,
    storyboard: {
      approval_status: approval,
      artifact_id: facts.storyboard_artifact.artifact_id,
      artifact_status: facts.storyboard_artifact.status,
      verification_level: facts.storyboard_artifact.verification_level
    },
    generation: { stage: generationStage, workflow_ready: generationReady, reason_codes: unique(generationReasons) },
    review,
    delivery: { accepted_clip_artifact_id: facts.accepted_clip_artifact.artifact_id, ready: deliveryReady, reason_codes: unique(deliveryReasons) },
    allowed_workflow_actions: {
      approve_storyboard: approval !== "approved" && facts.storyboard_artifact.status === "active" && facts.video_prompt_present && facts.duration_seconds > 0,
      prepare_generation: generationReady && !inconsistent && ["ready", "failed"].includes(generationStage) && review.stage !== "pending" && review.stage !== "approved",
      confirm_generation: generationReady && !inconsistent && ["ready", "failed"].includes(generationStage) && review.stage !== "pending" && review.stage !== "approved",
      review_clip: review.reviewable && ["pending", "revision_needed"].includes(review.stage),
      regenerate: generationReady && review.stage === "revision_needed"
    },
    blocker_codes: blockers
  };
}

export function deriveProjectOperationalSummary(states: ShotOperationalState[]): ProjectOperationalSummary {
  const blockerCodes = states.flatMap((state) => state.blocker_codes);
  const blockerCodeCounts = blockerCodes.reduce<Record<string, number>>((counts, code) => {
    counts[code] = (counts[code] ?? 0) + 1;
    return counts;
  }, {});
  return {
    shot_count: states.length,
    accepted_count: states.filter((state) => state.delivery.ready).length,
    active_run_count: states.filter((state) => ["queued", "running", "manual_reconciliation"].includes(state.generation.stage)).length,
    blocked_shot_count: states.filter((state) => state.blocker_codes.length > 0).length,
    blocker_count: blockerCodes.length,
    blocker_codes: unique(blockerCodes),
    blocker_code_counts: blockerCodeCounts,
    review_pending_count: states.filter((state) => state.review.stage === "pending").length,
    revision_needed_count: states.filter((state) => ["storyboard_revision_needed", "clip_revision_needed"].includes(state.primary_stage)).length,
    latest_failed_count: states.filter((state) => state.generation.stage === "failed").length
  };
}
