import type { ShotOperationalState } from "../packages/domain/operationalState";

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
  navigation: Record<"dashboard" | "inbox" | "director" | "projects" | "assets" | "system", number>;
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
  operations_version: "personal-readonly-operations-v2";
  checked_at: string;
  configuration: "missing" | "invalid" | "ready";
  stable_error_code: string | null;
  database_available: boolean;
  publisher_key_available: boolean;
  ready_to_preflight: boolean;
  ready_to_publish: boolean;
  freshness_operations: {
    state: "current" | "renewal_due" | "restoration_required" | "service_unavailable" | "unknown";
    reason_code: "SNAPSHOT_FRESH" | "SNAPSHOT_EXPIRING_SOON" | "SNAPSHOT_NOT_PUBLISHED" | "SNAPSHOT_EXPIRED" | "REMOTE_UNREACHABLE" | "REMOTE_NOT_READY" | "SNAPSHOT_STATUS_UNKNOWN" | "LOCAL_PUBLISHER_NOT_CONFIGURED";
    renewal_recommended: boolean;
    recommended_action: "none" | "preflight_and_renew" | "check_remote" | "configure_publisher";
    renewal_threshold_seconds: number;
  };
  remote: {
    reachable: boolean;
    ready: boolean;
    health_http_status: number | null;
    readiness_http_status: number | null;
    service_version: string | null;
    checks: Record<"oauth" | "publisher_key" | "snapshot_fresh" | "authorization_projection" | "media_capability_roundtrip", boolean | null>;
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
  blocked_shot_count: number;
  blocker_codes: string[];
  blocker_reason: string;
  review_pending_count: number;
  delivery_state: "not_ready" | "ready_to_assemble" | "final_review" | "verification_required" | "delivery_invalid" | "delivered";
  export_verification_state: "not_applicable" | "unverified" | "verified" | "failed";
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
  operational_state?: ShotOperationalState;
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

export type DeliveryWorkflowState = "not_ready" | "ready_to_assemble" | "assembling" | "final_review" | "revision_requested" | "approved" | "exported" | "closed" | "legacy_review_required";

export interface DeliveryJob {
  job_id: string;
  project_id: string;
  job_type: "assembly" | "export";
  state: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  input_fingerprint: string | null;
  retry_of_job_id: string | null;
  output_artifact_id: string | null;
  export_id: string | null;
  terminal_event_id: string | null;
  error_code: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface AssemblyPreflight {
  ready: boolean;
  tooling_checked: boolean;
  contract_version: "final-assembly-v1";
  input_fingerprint: string;
  target: { width: number; height: number; fps: 30; video_codec: "h264"; audio_codec: "aac" } | null;
  shots: Array<{ shot_id: string; order: number; artifact_id: string; blob_sha256: string; duration_seconds: number; source_duration_seconds: number }>;
  expected_duration_seconds: number;
  blockers: Array<{ code: string; shot_id?: string; order?: number }>;
}

export interface FinalVersion {
  artifact_id: string;
  created_at: string;
  assembly_job_id: string | null;
  assembled_at: string | null;
  artifact: MediaArtifact | null;
  is_current: boolean;
  is_approved: boolean;
}

export interface WorkbenchExport {
  export_id: string;
  project_id: string;
  artifact_id: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  created_at: string;
  verification_state?: "not_applicable" | "unverified" | "verified" | "failed";
  verification_reason_code?: string;
  verified_at?: string | null;
}

export interface CloseoutReceipt {
  event_id: string;
  project_id: string;
  artifact_id: string | null;
  export_id: string | null;
  reason_code: string;
  created_at: string;
}

export interface WorkspaceData {
  project: Project;
  meta: ProjectMeta;
  summary?: ProjectSummary | null;
  workspace: string;
  shots?: Shot[];
  packages?: Record<string, unknown>[];
  runs?: GenerationRun[];
  reconciliation_items?: ReconciliationItem[];
  recent_runs?: GenerationRun[];
  artifacts?: Record<string, MediaArtifact>;
  version_stacks?: Array<{ shot: Shot; versions: ClipVersion[] }>;
  regeneration_requests?: Record<string, unknown>[];
  review_notes?: ReviewNote[];
  metrics?: Record<string, number>;
  blockers?: Array<Record<string, unknown>>;
  workflow_state?: DeliveryWorkflowState;
  ready_for_assembly?: boolean;
  readiness_checks?: Array<{ shot_id: string; artifact_id: string; ok: boolean; reason_code: string }>;
  accepted_clips?: Array<{ shot_id: string; order: number; artifact_id: string; artifact: MediaArtifact | null; reference_error_code?: string }>;
  assembly_preflight?: AssemblyPreflight;
  active_job?: DeliveryJob | null;
  retryable_jobs?: { assembly: DeliveryJob | null; export: DeliveryJob | null };
  final_versions?: FinalVersion[];
  current_final_version?: FinalVersion | null;
  final_review?: { current_artifact_id: string | null; approved_artifact_id: string | null; decision_required: boolean };
  latest_export?: WorkbenchExport | null;
  closeout_receipt?: CloseoutReceipt | null;
  final_artifact?: MediaArtifact | null;
  final_artifact_reason_code?: string;
}

export interface ReconciliationItem {
  job_id: string;
  intent_id: string;
  shot_id: string;
  provider: string;
  model: string;
  job_state: "manual_reconciliation";
  intent_status: string;
  reason_code: string;
  has_provider_task_id: boolean;
  updated_at: string;
  reference_error_code?: string;
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
  input_snapshot: {
    balance_gate: "pass" | "not_checked";
    account_balance_value?: number;
    account_balance_currency?: string;
  };
  confirmed: boolean;
  expires_at: string;
  status: string;
  provider_task_id?: string;
}
