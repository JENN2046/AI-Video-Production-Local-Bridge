export interface ApiError {
  code: string;
  message: string;
  field?: string;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  meta?: PageMeta;
  error?: ApiError;
}

export interface PageMeta {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface ShellData {
  version: string;
  operator: string;
  action_nonce: string;
  navigation: Record<"dashboard" | "inbox" | "projects" | "assets" | "system", number>;
  actionable: {
    pending_confirmations: number;
    gpt_drafts: number;
    quarantined_imports: number;
    review_pending: number;
    running_jobs: number;
    unassigned_assets?: number;
  };
  capabilities: {
    legacy_available: boolean;
    real_generation_requires_preflight: boolean;
    max_real_generation_jobs: number;
    automatic_retry: boolean;
  };
}

export interface PersonalReadonlyOperationsStatus {
  operations_version: "personal-readonly-operations-v1";
  checked_at: string;
  configuration: "missing" | "invalid" | "ready";
  stable_error_code: string | null;
  database_available: boolean;
  publisher_key_available: boolean;
  ready_to_preflight: boolean;
  ready_to_publish: boolean;
  remote: {
    reachable: boolean;
    ready: boolean;
    health_http_status: number | null;
    readiness_http_status: number | null;
    service_version: string | null;
    checks: Record<"oauth" | "publisher_key" | "snapshot_fresh" | "authorization_projection", boolean | null>;
    snapshot: {
      freshness_status: "no_snapshot" | "fresh" | "snapshot_expired" | "unknown";
      generated_at: string | null;
      expires_at: string | null;
      age_seconds: number | null;
      ttl_remaining_seconds: number | null;
      snapshot_fingerprint: string | null;
    };
  };
  last_publish: {
    timestamp: string;
    result: "PASS" | "FAIL";
    stable_error_code: string | null;
    http_status: number | null;
    snapshot_fingerprint: string | null;
    generated_at: string | null;
    expires_at: string | null;
  } | null;
  last_receipt_state: "none" | "valid" | "invalid";
}

export interface PersonalReadonlyOperationResult {
  result: "PASS";
  snapshot_fingerprint: string;
  generated_at: string;
  expires_at: string;
  http_status?: number;
}

export interface Project {
  project_id: string;
  title: string;
  project_type: string;
  status: string;
  brief: Record<string, unknown>;
  video_spec: { duration_seconds: number; aspect_ratio: string; resolution: string };
  shot_ids: string[];
  active_storyboard_package_id: string;
  generation_batch_ids: string[];
  exports: { final_video_artifact_id: string };
}

export interface ProjectMeta {
  project_id: string;
  classification: "unclassified" | "production" | "test";
  lifecycle: "active" | "archived";
  pinned: boolean;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  next_action_override: string | null;
  next_action_priority: "urgent" | "high" | "normal" | null;
  next_action_expires_at: string | null;
  next_action_project_status: string | null;
  next_action_updated_at: string | null;
}

export interface ProjectNextAction {
  source: "override" | "derived";
  label: string;
  reason_code: string;
  priority: "urgent" | "high" | "normal";
  expires_at: string | null;
  derived: {
    label: string;
    reason_code: string;
    priority: "urgent" | "high" | "normal";
  };
}

export interface ProjectSummary {
  project: Project;
  meta: ProjectMeta;
  shot_count: number;
  accepted_count: number;
  active_run_count: number;
  blocker_count: number;
  blocker_reason: string;
  review_pending_count: number;
  delivery_state: "not_ready" | "ready_to_assemble" | "final_review" | "delivered";
  next_action: ProjectNextAction;
  risk: "blocked" | "attention" | "clear";
}

export interface Shot {
  shot_id: string;
  project_id: string;
  order: number;
  status: string;
  duration_seconds: number;
  description: string;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt: string;
  generation_run_ids: string[];
  accepted_clip_artifact_id: string;
  clip_versions: ClipVersion[];
  review: {
    approval_status: string;
    rejection_reasons: string[];
    latest_revision_instruction: Record<string, unknown> | null;
  };
}

export interface ClipVersion {
  artifact_id: string;
  run_id: string;
  attempt_number: number;
  review_status: "pending" | "approved" | "rejected";
  artifact?: MediaArtifact | null;
}

export interface MediaArtifact {
  artifact_id: string;
  artifact_type: "image" | "video";
  role: string;
  status: string;
  storage: { uri: string; mime_type: string; filename: string };
  metadata: { width: number; height: number; duration_seconds: number | null; aspect_ratio: string; sha256: string };
  linked_objects: { project_id: string; shot_id: string };
  source: { kind: string; provider: string; provider_job_id: string; sha256: string; external_url_host: string };
}

export interface WorkspaceData {
  project: Project;
  meta: ProjectMeta;
  summary?: ProjectSummary | null;
  workspace: string;
  shots?: Shot[];
  packages?: Record<string, unknown>[];
  runs?: GenerationRun[];
  recent_runs?: GenerationRun[];
  artifacts?: Record<string, MediaArtifact>;
  version_stacks?: Array<{ shot: Shot; versions: ClipVersion[] }>;
  regeneration_requests?: Record<string, unknown>[];
  review_notes?: ReviewNote[];
  metrics?: Record<string, number>;
  blockers?: Array<Record<string, unknown>>;
  ready_for_assembly?: boolean;
  accepted_clips?: Array<{ shot_id: string; order: number; artifact: MediaArtifact | null }>;
  final_artifact?: MediaArtifact | null;
}

export interface ReviewNote {
  note_id: string;
  project_id: string;
  shot_id: string;
  artifact_id: string;
  author_hash: string;
  note: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface GenerationRun {
  run_id: string;
  project_id: string;
  shot_id: string;
  status: string;
  run_type: string;
  input: Record<string, unknown>;
  output: { artifact_ids: string[] };
  provider: { provider_name: string; model_name: string; provider_job_id: string; provider_status: string };
  error: { code: string; message: string; retryable: boolean };
  versioning: { attempt_number: number; parent_run_id: string };
}

export interface GenerationIntent {
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
  status: string;
}
