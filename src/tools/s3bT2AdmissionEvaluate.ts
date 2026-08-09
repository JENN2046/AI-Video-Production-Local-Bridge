import type {
  GenerationAdmissionDecision,
  GenerationAdmissionFacts
} from "./s3bT2Types.js";

function addReason(counts: Record<string, number>, code: string): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

function ineligible(reasons: Record<string, number>): GenerationAdmissionDecision {
  return { state: "INELIGIBLE", candidates: [], reason_code_counts: reasons };
}

/**
 * Pure T2 policy.  All JSON parsing, SQL, filesystem verification, hashing
 * and Provider registry lookup are upstream responsibility.  This function
 * consumes only the minimal trusted facts package.
 */
export function evaluateGenerationAdmission(facts: GenerationAdmissionFacts): GenerationAdmissionDecision {
  const reasons: Record<string, number> = {};

  // Global active generation is the sole first-precedence fact.  It keeps a
  // malformed or otherwise incomplete candidate from becoming ambiguous.
  if (facts.generation.active_intent_count > 0) {
    return ineligible({ REAL_GENERATION_ALREADY_ACTIVE: facts.generation.active_intent_count });
  }

  if (facts.project.classification !== "production") {
    addReason(reasons, "PROJECT_NOT_PRODUCTION");
    return ineligible(reasons);
  }
  if (facts.project.lifecycle !== "active") {
    addReason(reasons, "PROJECT_NOT_ACTIVE");
    return ineligible(reasons);
  }
  if (facts.project.status === "final_approved" || facts.project.final_video_artifact_id.length > 0) {
    addReason(reasons, "PROJECT_ALREADY_DELIVERED");
    return ineligible(reasons);
  }

  if (!facts.package.storyboard_package_id) {
    addReason(reasons, "PACKAGE_NOT_FOUND");
    return ineligible(reasons);
  }
  if (facts.package.project_id !== facts.project.project_id) {
    addReason(reasons, "PACKAGE_PROJECT_MISMATCH");
    return ineligible(reasons);
  }
  if (facts.package.status !== "approved_for_video_generation" || !facts.package.storyboard_approved) {
    addReason(reasons, "PACKAGE_NOT_APPROVED");
    return ineligible(reasons);
  }
  if (!facts.package.snapshot_collection_complete || facts.package.snapshot_ambiguous || !facts.package.selected_snapshot) {
    addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH");
    return ineligible(reasons);
  }

  if (facts.generation.selected_has_any_job_or_run
    || facts.generation.malformed_history
    || facts.shot.generation_run_ids.length > 0
    || facts.shot.clip_versions.length > 0) {
    addReason(reasons, "GENERATION_ALREADY_STARTED");
    return ineligible(reasons);
  }

  if (facts.shot.operational_reason_codes.length > 0) {
    for (const reason of facts.shot.operational_reason_codes) addReason(reasons, reason);
    return ineligible(reasons);
  }
  if (!facts.shot.prepare_generation_allowed) {
    addReason(reasons, "PREPARE_GENERATION_NOT_ALLOWED");
    return ineligible(reasons);
  }
  if (facts.shot.status !== "storyboard_approved") {
    addReason(reasons, "PREPARE_GENERATION_NOT_ALLOWED");
    return ineligible(reasons);
  }

  const frozen = facts.package.selected_snapshot;
  if (frozen.duration_seconds !== facts.shot.duration_seconds
    || frozen.storyboard_image_artifact_id !== facts.shot.storyboard_image_artifact_id
    || frozen.video_prompt !== facts.shot.video_prompt
    || frozen.negative_prompt !== facts.shot.negative_prompt) {
    addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH");
    return ineligible(reasons);
  }

  const artifact = facts.media.artifact;
  if (!artifact
    || artifact.artifact_id !== facts.shot.storyboard_image_artifact_id
    || artifact.project_id !== facts.project.project_id
    || artifact.shot_id !== facts.shot.shot_id
    || artifact.role !== "storyboard_image"
    || artifact.artifact_type !== "image"
    || artifact.status !== "active"
    || facts.media.status !== "VALID"
    || facts.media.verification_level !== "bytes_verified") {
    addReason(reasons, "STORYBOARD_ARTIFACT_INTEGRITY_INVALID");
    return ineligible(reasons);
  }
  if (facts.media.detected_mime !== "image/png" && facts.media.detected_mime !== "image/jpeg") {
    addReason(reasons, "STORYBOARD_IMAGE_MIME_UNSUPPORTED");
    return ineligible(reasons);
  }

  if (!facts.provider.ok) {
    addReason(reasons, facts.provider.error_code ?? "PROVIDER_CAPABILITY_NOT_FOUND");
    return ineligible(reasons);
  }

  return {
    state: "ELIGIBLE",
    candidates: [{ project_id: facts.project.project_id, shot_id: facts.shot.shot_id }],
    reason_code_counts: reasons
  };
}
