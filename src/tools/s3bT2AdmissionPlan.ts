import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import type { M0Database } from "../storage/sqlite.js";
import { readGenerationAdmissionFacts } from "./s3bT2AdmissionFacts.js";
import type {
  GenerationAdmissionFacts,
  GenerationAdmissionMediaFacts,
  GenerationPlan
} from "./s3bT2Types.js";

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0`).update(canonicalizeJcs(value)).digest("hex");
}

export function mediaVerificationToken(media: GenerationAdmissionMediaFacts): string {
  if (media.status !== "VALID" || media.verification_level !== "bytes_verified") return "";
  return hash("generation-media-verification-token.v1", {
    artifact_id: media.artifact?.artifact_id ?? "",
    fingerprint_digest: media.fingerprint_digest,
    raw_sha256: media.raw_sha256,
    size_bytes: media.size_bytes,
    detected_mime: media.detected_mime
  });
}

export function buildDecisionRevision(facts: GenerationAdmissionFacts): string {
  return hash("generation-decision-revision.v1", {
    domain_version: "is2.5",
    project: {
      project_id: facts.project.project_id,
      status: facts.project.status,
      classification: facts.project.classification,
      lifecycle: facts.project.lifecycle,
      active_storyboard_package_id: facts.project.active_storyboard_package_id,
      final_video_artifact_id: facts.project.final_video_artifact_id,
      video_spec: facts.project.video_spec
    },
    shot: {
      shot_id: facts.shot.shot_id,
      project_id: facts.shot.project_id,
      order: facts.shot.order,
      status: facts.shot.status,
      duration_seconds: facts.shot.duration_seconds,
      storyboard_image_artifact_id: facts.shot.storyboard_image_artifact_id,
      video_prompt: facts.shot.video_prompt,
      negative_prompt: facts.shot.negative_prompt,
      generation_run_ids: facts.shot.generation_run_ids,
      clip_versions: facts.shot.clip_versions,
      review_approval_status: facts.shot.review_approval_status,
      operational_stage: facts.shot.operational_stage,
      operational_reason_codes: facts.shot.operational_reason_codes,
      prepare_generation_allowed: facts.shot.prepare_generation_allowed
    },
    package: {
      storyboard_package_id: facts.package.storyboard_package_id,
      project_id: facts.package.project_id,
      status: facts.package.status,
      storyboard_approved: facts.package.storyboard_approved,
      snapshot_count: facts.package.snapshot_count,
      project_shot_count: facts.package.project_shot_count,
      snapshot_collection_complete: facts.package.snapshot_collection_complete,
      snapshot_ambiguous: facts.package.snapshot_ambiguous,
      selected_snapshot: facts.package.selected_snapshot,
      match_mode: facts.package.match_mode
    },
    artifact: facts.media.artifact,
    generation: facts.generation,
    provider: {
      ok: facts.provider.ok,
      provider_name: facts.provider.provider_name,
      model: facts.provider.model,
      capability_key: facts.provider.capability_key,
      capability_id: facts.provider.capability_id,
      registry_version: facts.provider.registry_version,
      duration_seconds: facts.provider.duration_seconds,
      resolution: facts.provider.resolution,
      aspect_ratio: facts.provider.aspect_ratio,
      error_code: facts.provider.error_code ?? ""
    }
  });
}

export function buildInputDigest(facts: GenerationAdmissionFacts): string {
  return hash("generation-input-digest.v1", {
    domain_version: "is2.5",
    project_id: facts.project.project_id,
    shot_id: facts.shot.shot_id,
    storyboard_package_id: facts.package.storyboard_package_id,
    storyboard_artifact_id: facts.shot.storyboard_image_artifact_id,
    video_prompt: facts.shot.video_prompt,
    negative_prompt: facts.shot.negative_prompt,
    duration_seconds: facts.provider.duration_seconds,
    aspect_ratio: facts.provider.aspect_ratio,
    resolution: facts.provider.resolution,
    provider_name: facts.provider.provider_name,
    provider_capability: {
      registry_version: facts.provider.registry_version,
      capability_id: facts.provider.capability_id,
      capability_key: facts.provider.capability_key,
      model: facts.provider.model
    }
  });
}

export function buildGenerationPlan(facts: GenerationAdmissionFacts): GenerationPlan {
  const token = mediaVerificationToken(facts.media);
  if (!facts.provider.ok || !token || !facts.package.storyboard_package_id) {
    throw new Error("GENERATION_PLAN_FACTS_INCOMPLETE");
  }
  return {
    schema_version: "generation_plan.v1",
    project_id: facts.project.project_id,
    shot_id: facts.shot.shot_id,
    storyboard_package_id: facts.package.storyboard_package_id,
    storyboard_artifact_id: facts.shot.storyboard_image_artifact_id,
    provider_name: facts.provider.provider_name,
    duration_seconds: facts.provider.duration_seconds,
    aspect_ratio: facts.provider.aspect_ratio,
    resolution: facts.provider.resolution,
    input_digest: buildInputDigest(facts),
    decision_revision: buildDecisionRevision(facts),
    media_verification_token: token
  };
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function parseGenerationPlan(value: unknown): GenerationPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as Record<string, unknown>;
  if (plan.schema_version !== "generation_plan.v1"
    || typeof plan.project_id !== "string"
    || typeof plan.shot_id !== "string"
    || typeof plan.storyboard_package_id !== "string"
    || typeof plan.storyboard_artifact_id !== "string"
    || typeof plan.provider_name !== "string"
    || !Number.isSafeInteger(plan.duration_seconds)
    || typeof plan.aspect_ratio !== "string"
    || typeof plan.resolution !== "string"
    || !isHash(plan.input_digest)
    || !isHash(plan.decision_revision)
    || !isHash(plan.media_verification_token)) return null;
  return {
    schema_version: "generation_plan.v1",
    project_id: plan.project_id,
    shot_id: plan.shot_id,
    storyboard_package_id: plan.storyboard_package_id,
    storyboard_artifact_id: plan.storyboard_artifact_id,
    provider_name: plan.provider_name,
    duration_seconds: Number(plan.duration_seconds),
    aspect_ratio: plan.aspect_ratio,
    resolution: plan.resolution,
    input_digest: plan.input_digest,
    decision_revision: plan.decision_revision,
    media_verification_token: plan.media_verification_token
  };
}

export function planMatchesFacts(plan: GenerationPlan, facts: GenerationAdmissionFacts): boolean {
  return plan.project_id === facts.project.project_id
    && plan.shot_id === facts.shot.shot_id
    && plan.storyboard_package_id === facts.package.storyboard_package_id
    && plan.storyboard_artifact_id === facts.shot.storyboard_image_artifact_id
    && plan.provider_name === facts.provider.provider_name
    && plan.duration_seconds === facts.provider.duration_seconds
    && plan.aspect_ratio === facts.provider.aspect_ratio
    && plan.resolution === facts.provider.resolution
    && plan.input_digest === buildInputDigest(facts)
    && plan.decision_revision === buildDecisionRevision(facts);
}

export function revalidateGenerationPlanMedia(
  plan: GenerationPlan,
  db: M0Database
): { ok: true; media_verification_token: string } | { ok: false; code: "MEDIA_VERIFICATION_STALE"; message: string } {
  const current = readGenerationAdmissionFacts(db, plan.project_id, plan.shot_id, { verify_media: true });
  if (!current.ok) return { ok: false, code: "MEDIA_VERIFICATION_STALE", message: "The confirmed media evidence could not be revalidated." };
  const token = mediaVerificationToken(current.facts.media);
  if (!token || token !== plan.media_verification_token) {
    return { ok: false, code: "MEDIA_VERIFICATION_STALE", message: "Confirmed media bytes or entity identity changed before Provider execution." };
  }
  return { ok: true, media_verification_token: token };
}
