export const T2_SNAPSHOT_ROWSET_NAMES = [
  "projects",
  "workbench_project_meta",
  "shots",
  "storyboard_packages",
  "media_artifacts",
  "media_artifact_blobs",
  "media_blobs",
  "generation_intents",
  "generation_jobs",
  "generation_runs"
] as const;

export type T2SnapshotRowsetName = typeof T2_SNAPSHOT_ROWSET_NAMES[number];
export type T2DatabaseRow = Record<string, unknown>;

export type T2RowsetEvidence = {
  row_count: number;
  digest: string;
};

export type T2RowsetEvidenceMap = {
  [K in T2SnapshotRowsetName]: T2RowsetEvidence;
};

export type T2RawRowsetMap = {
  [K in T2SnapshotRowsetName]: readonly T2DatabaseRow[];
};

export type T2DatabaseEvidence = {
  identity_digest: string;
  total_changes_before: number;
  total_changes_after: number;
  active_intent_count: number;
  query_only: 1;
  schema_current: true;
};

export type T2RawSnapshot = {
  database: T2DatabaseEvidence;
  rowsets: T2RawRowsetMap;
  rowset_evidence: T2RowsetEvidenceMap;
  database_evidence_digest: string;
};

export type T2NormalizationIssue = {
  code: string;
  entity: "project" | "project_meta" | "shot" | "package" | "artifact" | "blob" | "generation" | "relation";
  key?: string;
};

export type T2NormalizedProject = {
  project_id: string;
  status: string;
  video_spec: {
    duration_seconds: number;
    aspect_ratio: string;
    resolution: string;
  };
  active_storyboard_package_id: string;
  final_video_artifact_id: string;
};

export type T2NormalizedProjectMeta = {
  project_id: string;
  classification: "production" | "test" | "unclassified";
  lifecycle: "active" | "archived";
};

export type T2NormalizedShot = {
  shot_id: string;
  project_id: string;
  order: number;
  status: string;
  duration_seconds: number;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt: string;
  generation_run_ids: string[];
  accepted_clip_artifact_id: string;
  clip_versions: Array<{
    artifact_id: string;
    run_id: string;
    attempt_number: number;
    review_status: "pending" | "approved" | "rejected";
  }>;
  review: {
    approval_status: "pending" | "approved" | "revision_needed";
    rejection_reasons: string[];
    latest_revision_instruction: unknown;
  };
};

export type T2NormalizedPackageSnapshot = {
  shot_id?: string;
  order: number;
  duration_seconds: number;
  description: string;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt: string;
};

export type T2NormalizedPackage = {
  storyboard_package_id: string;
  project_id: string;
  status: string;
  approved_shot_snapshots: T2NormalizedPackageSnapshot[];
  storyboard_approved: boolean;
};

export type T2NormalizedArtifact = {
  artifact_id: string;
  project_id: string;
  shot_id: string;
  blob_id: string;
  artifact_type: string;
  role: string;
  status: string;
  storage: { uri: string; mime_type: string; filename: string };
  metadata: { sha256: string };
  linked_objects: { project_id: string; shot_id: string };
  source: { sha256: string };
};

export type T2NormalizedBlob = {
  blob_id: string;
  sha256: string;
  size_bytes: number;
  detected_mime: string;
  storage_uri: string;
  integrity_state: string;
  media_root: string;
};

export type T2GenerationFacts = {
  project_id: string;
  shot_id: string;
  has_any_job_or_run: boolean;
  latest_run_status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  latest_job_state: "queued" | "submitting" | "polling" | "downloading" | "finalizing" | "manual_reconciliation" | "succeeded" | "failed" | "cancelled" | null;
  malformed_history: boolean;
};

export type T2NormalizedSnapshot = {
  database: T2DatabaseEvidence;
  projects: Map<string, T2NormalizedProject>;
  project_meta: Map<string, T2NormalizedProjectMeta>;
  shots: Map<string, T2NormalizedShot>;
  packages: Map<string, T2NormalizedPackage>;
  artifacts: Map<string, T2NormalizedArtifact>;
  blobs: Map<string, T2NormalizedBlob>;
  artifact_blob_links: Map<string, string>;
  generation: Map<string, T2GenerationFacts>;
  normalization_issues: T2NormalizationIssue[];
  rowsets: T2RowsetEvidenceMap;
  database_evidence_digest: string;
  business_evaluation?: "not_started";
};

export type T2SnapshotEvidence = {
  database_evidence_digest: string;
  media_root_evidence_digest?: string;
  referenced_media_evidence?: readonly GovernedMediaEvidence[];
  rowsets: T2RowsetEvidenceMap;
  business_evaluation?: "not_started";
};

export type T2EligibilityDecision = {
  state: "ELIGIBLE" | "INELIGIBLE";
  candidates: Array<{ project_id: string; shot_id: string }>;
  reason_code_counts: Record<string, number>;
} | {
  result: "FOUNDATION_ONLY";
  eligible: false;
  reason_code: "T2_EVALUATION_NOT_STARTED";
};

export type GovernedMediaEvidence =
  | {
      status: "VALID";
      fingerprint_digest: string;
      artifact_id?: string;
      raw_sha256?: string;
      size_bytes?: number;
      detected_mime?: string;
      decoded?: true;
    }
  | {
      status: "INVALID";
      fingerprint_digest: string;
      failure_class: string;
      artifact_id?: string;
    };

export type GovernedMediaRootEvidence =
  | { status: "VALID"; fingerprint_digest: string; authority: { dev: number; ino: number; nlink: number } }
  | { status: "INVALID"; fingerprint_digest: string; failure_class: string };

/**
 * The smallest immutable hand-off from T2 admission to the Generation
 * Domain.  It deliberately contains one Shot's provider input rather than a
 * database or filesystem snapshot.
 */
export type GenerationPlan = {
  schema_version: "generation_plan.v1";
  project_id: string;
  shot_id: string;
  storyboard_package_id: string;
  storyboard_artifact_id: string;
  provider_name: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
  input_digest: string;
  decision_revision: string;
  media_verification_token: string;
};

export type GenerationAdmissionProjectFacts = {
  project_id: string;
  status: string;
  classification: string;
  lifecycle: string;
  active_storyboard_package_id: string;
  final_video_artifact_id: string;
  video_spec: {
    duration_seconds: number;
    aspect_ratio: string;
    resolution: string;
  };
};

export type GenerationAdmissionShotFacts = {
  shot_id: string;
  project_id: string;
  order: number;
  status: string;
  duration_seconds: number;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt: string;
  generation_run_ids: readonly string[];
  clip_versions: readonly {
    artifact_id: string;
    run_id: string;
    attempt_number: number;
    review_status: "pending" | "approved" | "rejected";
  }[];
  review_approval_status: "pending" | "approved" | "revision_needed";
  operational_stage: string;
  operational_reason_codes: readonly string[];
  prepare_generation_allowed: boolean;
};

export type GenerationAdmissionPackageSnapshot = {
  shot_id?: string;
  order: number;
  duration_seconds: number;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt: string;
};

export type GenerationAdmissionPackageFacts = {
  storyboard_package_id: string;
  project_id: string;
  status: string;
  storyboard_approved: boolean;
  snapshot_count: number;
  project_shot_count: number;
  snapshot_collection_complete: boolean;
  snapshot_ambiguous: boolean;
  selected_snapshot: GenerationAdmissionPackageSnapshot | null;
  match_mode: "shot_id" | "order" | null;
};

export type GenerationAdmissionArtifactFacts = {
  artifact_id: string;
  project_id: string;
  shot_id: string;
  role: string;
  artifact_type: string;
  status: string;
  blob_id: string;
  storage_uri: string;
  mime_type: string;
  artifact_sha256: string;
  source_sha256: string;
  blob_sha256: string;
  blob_size_bytes: number;
  blob_detected_mime: string;
  blob_integrity_state: string;
};

export type GenerationAdmissionMediaFacts = {
  status: "VALID" | "INVALID" | "NOT_CHECKED";
  verification_level: "bytes_verified" | "none";
  artifact: GenerationAdmissionArtifactFacts | null;
  media_verification_token: string;
  fingerprint_digest: string;
  raw_sha256: string;
  size_bytes: number;
  detected_mime: string;
  failure_class?: string;
};

export type GenerationAdmissionStateFacts = {
  active_intent_count: number;
  selected_has_any_job_or_run: boolean;
  latest_run_status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  latest_job_state: "queued" | "submitting" | "polling" | "downloading" | "finalizing" | "manual_reconciliation" | "succeeded" | "failed" | "cancelled" | null;
  malformed_history: boolean;
};

export type GenerationAdmissionProviderFacts = {
  ok: boolean;
  provider_name: string;
  model: string;
  capability_key: string;
  capability_id: string;
  registry_version: string;
  duration_seconds: number;
  resolution: string;
  aspect_ratio: string;
  error_code?: string;
};

export type GenerationAdmissionFacts = {
  project: GenerationAdmissionProjectFacts;
  shot: GenerationAdmissionShotFacts;
  package: GenerationAdmissionPackageFacts;
  media: GenerationAdmissionMediaFacts;
  generation: GenerationAdmissionStateFacts;
  provider: GenerationAdmissionProviderFacts;
};

export type GenerationAdmissionDecision = {
  state: "ELIGIBLE" | "INELIGIBLE";
  candidates: Array<{ project_id: string; shot_id: string }>;
  reason_code_counts: Record<string, number>;
};
