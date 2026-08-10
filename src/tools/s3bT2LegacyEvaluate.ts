import { buildProviderCapabilityKey } from "./providerCapabilities.js";
import { deriveNormalizedShotState } from "./s3bT2Normalize.js";
import type {
  GovernedMediaEvidence,
  T2EligibilityDecision,
  T2NormalizedPackage,
  T2NormalizedProject,
  T2NormalizedShot,
  T2NormalizedSnapshot
} from "./s3bT2Types.js";

export type T2InternalDecision = {
  state: "ELIGIBLE" | "INELIGIBLE";
  candidates: Array<{ project_id: string; shot_id: string }>;
  reason_code_counts: Record<string, number>;
};

type LegacyFoundationSnapshot = {
  database: unknown;
  rowsets: unknown;
  database_evidence_digest: string;
  business_evaluation: "not_started";
};

function addReason(counts: Record<string, number>, code: string): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

function snapshotForShot(pkg: T2NormalizedPackage, shot: T2NormalizedShot): T2NormalizedPackage["approved_shot_snapshots"][number] | null {
  const byId = pkg.approved_shot_snapshots.filter((item) => item.shot_id !== undefined);
  if (byId.length > 0) return pkg.approved_shot_snapshots.find((item) => item.shot_id === shot.shot_id) ?? null;
  return pkg.approved_shot_snapshots.find((item) => item.order === shot.order) ?? null;
}

function frozenInputMatches(snapshot: ReturnType<typeof snapshotForShot>, shot: T2NormalizedShot): boolean {
  return Boolean(snapshot
    && snapshot.duration_seconds === shot.duration_seconds
    && snapshot.storyboard_image_artifact_id === shot.storyboard_image_artifact_id
    && snapshot.video_prompt === shot.video_prompt
    && snapshot.negative_prompt === shot.negative_prompt);
}

function mediaFor(mediaEvidence: Map<string, GovernedMediaEvidence> | undefined, artifactId: string): GovernedMediaEvidence | undefined {
  return mediaEvidence?.get(artifactId);
}

function evaluateInternal(snapshot: T2NormalizedSnapshot, mediaEvidence?: Map<string, GovernedMediaEvidence>): T2InternalDecision {
  const reason_code_counts: Record<string, number> = {};
  const candidates: Array<{ project_id: string; shot_id: string }> = [];

  // Compatibility evaluator for the IS1 snapshot/diagnostic surface.  The
  // IS2.5 admission path uses evaluateGenerationAdmission instead.
  if (snapshot.database.active_intent_count > 0) {
    return { state: "INELIGIBLE", candidates, reason_code_counts: { REAL_GENERATION_ALREADY_ACTIVE: snapshot.database.active_intent_count } };
  }

  for (const [projectId, project] of snapshot.projects) {
    const meta = snapshot.project_meta.get(projectId);
    if (!meta || meta.classification !== "production") {
      addReason(reason_code_counts, "PROJECT_NOT_PRODUCTION");
      continue;
    }
    if (meta.lifecycle !== "active") {
      addReason(reason_code_counts, "PROJECT_NOT_ACTIVE");
      continue;
    }
    if (project.status === "final_approved" || project.final_video_artifact_id.length > 0) {
      addReason(reason_code_counts, "PROJECT_ALREADY_DELIVERED");
      continue;
    }
    evaluateProject(projectId, project, snapshot, mediaEvidence, reason_code_counts, candidates);
  }

  return { state: candidates.length > 0 ? "ELIGIBLE" : "INELIGIBLE", candidates, reason_code_counts };
}

function evaluateProject(
  projectId: string,
  project: T2NormalizedProject,
  snapshot: T2NormalizedSnapshot,
  mediaEvidence: Map<string, GovernedMediaEvidence> | undefined,
  reasons: Record<string, number>,
  candidates: Array<{ project_id: string; shot_id: string }>
): void {
  const pkg = snapshot.packages.get(project.active_storyboard_package_id);
  if (!pkg) {
    addReason(reasons, "STORYBOARD_PACKAGE_MISSING");
    return;
  }
  if (pkg.project_id !== projectId) {
    addReason(reasons, "STORYBOARD_PACKAGE_BINDING_INVALID");
    return;
  }
  if (pkg.status !== "approved_for_video_generation" || !pkg.storyboard_approved) {
    addReason(reasons, "STORYBOARD_PACKAGE_NOT_APPROVED");
    return;
  }
  const shots = [...snapshot.shots.values()].filter((shot) => shot.project_id === projectId);
  if (shots.length === 0 || pkg.approved_shot_snapshots.length !== shots.length) {
    addReason(reasons, "STORYBOARD_PACKAGE_INCOMPLETE");
    return;
  }
  const explicitIds = new Set<string>();
  const orderCounts = new Map<number, number>();
  for (const item of pkg.approved_shot_snapshots) {
    if (item.shot_id !== undefined) {
      if (explicitIds.has(item.shot_id)) {
        addReason(reasons, "STORYBOARD_PACKAGE_SNAPSHOT_AMBIGUOUS");
        return;
      }
      explicitIds.add(item.shot_id);
    } else {
      orderCounts.set(item.order, (orderCounts.get(item.order) ?? 0) + 1);
    }
  }
  if ([...orderCounts.values()].some((count) => count > 1)) {
    addReason(reasons, "STORYBOARD_PACKAGE_SNAPSHOT_AMBIGUOUS");
    return;
  }
  for (const shot of shots) {
    evaluateShot(shot, pkg, project, snapshot, mediaEvidence, reasons, candidates);
  }
}

function evaluateShot(
  shot: T2NormalizedShot,
  pkg: T2NormalizedPackage,
  project: T2NormalizedProject,
  snapshot: T2NormalizedSnapshot,
  mediaEvidence: Map<string, GovernedMediaEvidence> | undefined,
  reasons: Record<string, number>,
  candidates: Array<{ project_id: string; shot_id: string }>
): void {
  const generation = snapshot.generation.get(`${shot.project_id}\u0000${shot.shot_id}`);
  if (shot.generation_run_ids.length > 0 || shot.clip_versions.length > 0 || generation?.has_any_job_or_run) {
    addReason(reasons, "GENERATION_ALREADY_STARTED");
    return;
  }
  if (generation?.malformed_history) {
    addReason(reasons, "GENERATION_ALREADY_STARTED");
    return;
  }
  const operational = deriveNormalizedShotState(snapshot, shot, new Set(mediaEvidence ? [...mediaEvidence].filter(([, value]) => value.status === "VALID").map(([id]) => id) : []));
  if (operational.generation.reason_codes.length > 0) {
    for (const code of operational.generation.reason_codes) addReason(reasons, code);
    return;
  }
  if (operational.generation.stage === "queued" || operational.generation.stage === "running") {
    addReason(reasons, "GENERATION_ALREADY_STARTED");
    return;
  }
  if (shot.status !== "storyboard_approved") {
    addReason(reasons, "SHOT_NOT_STORYBOARD_APPROVED");
    return;
  }
  const packageSnapshot = snapshotForShot(pkg, shot);
  if (!packageSnapshot || !frozenInputMatches(packageSnapshot, shot)) {
    addReason(reasons, "STORYBOARD_PACKAGE_SNAPSHOT_MISMATCH");
    return;
  }
  const artifact = snapshot.artifacts.get(shot.storyboard_image_artifact_id);
  const evidence = mediaFor(mediaEvidence, shot.storyboard_image_artifact_id);
  if (!artifact || artifact.project_id !== shot.project_id || artifact.shot_id !== shot.shot_id
    || artifact.role !== "storyboard_image" || artifact.artifact_type !== "image" || artifact.status !== "active"
    || !evidence || evidence.status !== "VALID") {
    addReason(reasons, "STORYBOARD_ARTIFACT_INTEGRITY_INVALID");
    return;
  }
  const capability = buildProviderCapabilityKey({
    provider: "runninghub",
    duration_seconds: shot.duration_seconds,
    resolution: project.video_spec.resolution,
    aspect_ratio: project.video_spec.aspect_ratio
  });
  if (!capability.ok) {
    addReason(reasons, capability.code);
    return;
  }
  candidates.push({ project_id: shot.project_id, shot_id: shot.shot_id });
}

export function evaluateT2Snapshot(snapshot: T2NormalizedSnapshot, mediaEvidence?: Map<string, GovernedMediaEvidence>): T2InternalDecision;
export function evaluateT2Snapshot(snapshot: LegacyFoundationSnapshot): Extract<T2EligibilityDecision, { result: "FOUNDATION_ONLY" }>;
export function evaluateT2Snapshot(snapshot: T2NormalizedSnapshot | LegacyFoundationSnapshot, mediaEvidence?: Map<string, GovernedMediaEvidence>): T2EligibilityDecision {
  if ("business_evaluation" in snapshot && snapshot.business_evaluation === "not_started") {
    return { result: "FOUNDATION_ONLY", eligible: false, reason_code: "T2_EVALUATION_NOT_STARTED" } as never;
  }
  return evaluateInternal(snapshot as T2NormalizedSnapshot, mediaEvidence);
}

export { evaluateInternal as evaluateT2Internal };
