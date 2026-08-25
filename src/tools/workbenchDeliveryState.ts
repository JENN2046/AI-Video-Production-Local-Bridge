import type { M0Database } from "../storage/sqlite.js";
import { withWorkbenchProductionMutationAuthority } from "../storage/productionMutationAuthority.js";

export type WorkbenchDeliveryWorkflowState =
  | "not_ready"
  | "ready_to_assemble"
  | "assembling"
  | "final_review"
  | "revision_requested"
  | "approved"
  | "exported"
  | "closed"
  | "legacy_review_required";

export interface WorkbenchDeliveryState {
  project_id: string;
  workflow_state: WorkbenchDeliveryWorkflowState;
  current_final_artifact_id: string | null;
  assembly_input_fingerprint: string | null;
  approved_artifact_id: string | null;
  latest_export_id: string | null;
  last_assembled_at: string | null;
  latest_exported_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WorkbenchDeliveryJobType = "assembly" | "export";
export type WorkbenchDeliveryJobState = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface WorkbenchDeliveryJobRecord {
  job_id: string;
  project_id: string;
  job_type: WorkbenchDeliveryJobType;
  state: WorkbenchDeliveryJobState;
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

export interface WorkbenchExportRecord {
  export_id: string;
  project_id: string;
  artifact_id: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  created_at: string;
}

export interface WorkbenchCloseoutReceipt {
  event_id: string;
  project_id: string;
  artifact_id: string | null;
  export_id: string | null;
  reason_code: string;
  created_at: string;
}

export type WorkbenchDeliverySummaryState =
  | "not_ready"
  | "ready_to_assemble"
  | "final_review"
  | "verification_required"
  | "delivery_invalid"
  | "delivered";

export type WorkbenchExportVerificationState = "not_applicable" | "unverified" | "verified" | "failed";

export type WorkbenchProductionMutationCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ARCHIVED"
  | "DELIVERY_STATE_MISSING"
  | "PROJECT_CLOSED"
  | "DELIVERY_JOB_ACTIVE"
  | "DELIVERY_REWORK_REQUIRED"
  | "PRODUCTION_MUTATION_CONFLICT"
  | "PRODUCTION_MUTATION_REJECTED";

export interface WorkbenchProductionMutationErrorShape {
  code: WorkbenchProductionMutationCode;
  message: string;
}

export type WorkbenchProductionWriteBoundaryResult =
  | { ok: true; delivery: WorkbenchDeliveryState }
  | { ok: false; error: WorkbenchProductionMutationErrorShape };

const FINAL_EVIDENCE_STATES: ReadonlySet<WorkbenchDeliveryWorkflowState> = new Set([
  "final_review",
  "approved",
  "exported",
  "legacy_review_required"
]);

const PRODUCTION_MUTATION_MESSAGES: Readonly<Record<WorkbenchProductionMutationCode, string>> = {
  PROJECT_NOT_FOUND: "Project was not found.",
  PROJECT_ARCHIVED: "Archived projects are read-only.",
  DELIVERY_STATE_MISSING: "Project delivery state is unavailable.",
  PROJECT_CLOSED: "Closed projects do not accept production changes.",
  DELIVERY_JOB_ACTIVE: "Production content cannot change while a Delivery Job is active.",
  DELIVERY_REWORK_REQUIRED: "Final delivery evidence must enter an explicit rework state before production content changes.",
  PRODUCTION_MUTATION_CONFLICT: "Production mutation failed closed because the database is busy.",
  PRODUCTION_MUTATION_REJECTED: "Production mutation was rejected by the durable authority boundary."
};

export class WorkbenchProductionMutationError extends Error {
  readonly name = "WorkbenchProductionMutationError";

  constructor(readonly code: WorkbenchProductionMutationCode) {
    super(PRODUCTION_MUTATION_MESSAGES[code]);
  }
}

export function workbenchProductionMutationError(
  error: unknown,
  fallback: WorkbenchProductionMutationCode = "PRODUCTION_MUTATION_REJECTED"
): WorkbenchProductionMutationErrorShape {
  if (error instanceof WorkbenchProductionMutationError) {
    return { code: error.code, message: error.message };
  }
  const sqliteCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const raw = error instanceof Error ? error.message : "";
  if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_LOCKED"
    || /\b(?:database|database table|database schema) is locked\b/i.test(raw)) {
    return { code: "PRODUCTION_MUTATION_CONFLICT", message: PRODUCTION_MUTATION_MESSAGES.PRODUCTION_MUTATION_CONFLICT };
  }
  for (const code of Object.keys(PRODUCTION_MUTATION_MESSAGES) as WorkbenchProductionMutationCode[]) {
    if (raw === code || raw.includes(code)) return { code, message: PRODUCTION_MUTATION_MESSAGES[code] };
  }
  return { code: fallback, message: PRODUCTION_MUTATION_MESSAGES[fallback] };
}

export function throwWorkbenchProductionMutationError(error: unknown): never {
  const mapped = workbenchProductionMutationError(error);
  throw new WorkbenchProductionMutationError(mapped.code);
}

export function getWorkbenchDeliveryState(db: M0Database, projectId: string): WorkbenchDeliveryState | null {
  return db.prepare(`
    SELECT project_id, workflow_state, current_final_artifact_id, assembly_input_fingerprint,
      approved_artifact_id, latest_export_id, last_assembled_at, latest_exported_at,
      closed_at, created_at, updated_at
    FROM workbench_delivery_state
    WHERE project_id = ?
  `).get(projectId) as WorkbenchDeliveryState | undefined ?? null;
}

export function requireWorkbenchDeliveryState(db: M0Database, projectId: string): WorkbenchDeliveryState {
  const state = getWorkbenchDeliveryState(db, projectId);
  if (!state) throw new Error("WORKBENCH_DELIVERY_STATE_MISSING");
  return state;
}

const DELIVERY_JOB_PUBLIC_COLUMNS = `
  job_id, project_id, job_type, state, input_fingerprint, retry_of_job_id,
  output_artifact_id, export_id, terminal_event_id, error_code,
  created_at, started_at, finished_at, updated_at
`;

export function getWorkbenchDeliveryJob(db: M0Database, jobId: string): WorkbenchDeliveryJobRecord | null {
  return db.prepare(`SELECT ${DELIVERY_JOB_PUBLIC_COLUMNS}
    FROM workbench_delivery_jobs WHERE job_id = ?`)
    .get(jobId) as WorkbenchDeliveryJobRecord | undefined ?? null;
}

export function getActiveWorkbenchDeliveryJob(
  db: M0Database,
  projectId?: string
): WorkbenchDeliveryJobRecord | null {
  const row = projectId
    ? db.prepare(`SELECT ${DELIVERY_JOB_PUBLIC_COLUMNS}
        FROM workbench_delivery_jobs
        WHERE project_id = ? AND state IN ('queued','running')
        ORDER BY created_at, job_id LIMIT 1`).get(projectId)
    : db.prepare(`SELECT ${DELIVERY_JOB_PUBLIC_COLUMNS}
        FROM workbench_delivery_jobs
        WHERE state IN ('queued','running')
        ORDER BY created_at, job_id LIMIT 1`).get();
  return row as WorkbenchDeliveryJobRecord | undefined ?? null;
}

export function getLatestRetryableWorkbenchDeliveryJob(
  db: M0Database,
  projectId: string,
  jobType: WorkbenchDeliveryJobType
): WorkbenchDeliveryJobRecord | null {
  const row = db.prepare(`SELECT ${DELIVERY_JOB_PUBLIC_COLUMNS}
    FROM workbench_delivery_jobs
    WHERE project_id = ? AND job_type = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(projectId, jobType) as WorkbenchDeliveryJobRecord | undefined;
  return row && (row.state === "failed" || row.state === "interrupted") ? row : null;
}

export function getCurrentWorkbenchExport(db: M0Database, projectId: string): WorkbenchExportRecord | null {
  const row = db.prepare(`
    SELECT exported.export_id, exported.project_id, exported.artifact_id, exported.relative_path,
      exported.sha256, exported.size_bytes, exported.created_at
    FROM workbench_delivery_state state
    JOIN workbench_exports exported
      ON exported.project_id = state.project_id AND exported.export_id = state.latest_export_id
    WHERE state.project_id = ?
  `).get(projectId) as WorkbenchExportRecord | undefined;
  return row ? { ...row, size_bytes: Number(row.size_bytes) } : null;
}

export function getWorkbenchCloseoutReceipt(db: M0Database, projectId: string): WorkbenchCloseoutReceipt | null {
  return db.prepare(`
    SELECT event_id, project_id, artifact_id, export_id, reason_code, created_at
    FROM workbench_delivery_events
    WHERE project_id = ? AND event_type = 'closeout'
    ORDER BY created_at DESC, event_id DESC
    LIMIT 1
  `).get(projectId) as WorkbenchCloseoutReceipt | undefined ?? null;
}

export function assertWorkbenchProductionWriteAllowed(
  db: M0Database,
  projectId: string
): WorkbenchProductionWriteBoundaryResult {
  const project = db.prepare("SELECT 1 AS present FROM projects WHERE project_id = ?")
    .get(projectId) as { present: number } | undefined;
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: PRODUCTION_MUTATION_MESSAGES.PROJECT_NOT_FOUND } };

  const meta = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?")
    .get(projectId) as { lifecycle: string } | undefined;
  if (!meta) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: PRODUCTION_MUTATION_MESSAGES.PROJECT_NOT_FOUND } };
  if (meta.lifecycle === "archived") {
    return { ok: false, error: { code: "PROJECT_ARCHIVED", message: PRODUCTION_MUTATION_MESSAGES.PROJECT_ARCHIVED } };
  }

  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery) {
    return { ok: false, error: { code: "DELIVERY_STATE_MISSING", message: PRODUCTION_MUTATION_MESSAGES.DELIVERY_STATE_MISSING } };
  }
  if (delivery.workflow_state === "closed") {
    return { ok: false, error: { code: "PROJECT_CLOSED", message: PRODUCTION_MUTATION_MESSAGES.PROJECT_CLOSED } };
  }
  const activeJob = db.prepare(`
    SELECT 1 AS present FROM workbench_delivery_jobs
    WHERE project_id = ? AND state IN ('queued','running')
    LIMIT 1
  `).get(projectId) as { present: number } | undefined;
  if (delivery.workflow_state === "assembling" || activeJob) {
    return { ok: false, error: { code: "DELIVERY_JOB_ACTIVE", message: PRODUCTION_MUTATION_MESSAGES.DELIVERY_JOB_ACTIVE } };
  }
  return { ok: true, delivery };
}

export function assertWorkbenchContentMutationAllowed(
  db: M0Database,
  projectId: string
): WorkbenchProductionWriteBoundaryResult {
  const writable = assertWorkbenchProductionWriteAllowed(db, projectId);
  if (!writable.ok) return writable;
  if (FINAL_EVIDENCE_STATES.has(writable.delivery.workflow_state)) {
    return { ok: false, error: { code: "DELIVERY_REWORK_REQUIRED", message: PRODUCTION_MUTATION_MESSAGES.DELIVERY_REWORK_REQUIRED } };
  }
  return writable;
}

export function refreshWorkbenchAssemblyReadiness(db: M0Database, projectId: string): WorkbenchDeliveryState {
  const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  try {
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    const writable = assertWorkbenchContentMutationAllowed(db, projectId);
    if (!writable.ok) throw new WorkbenchProductionMutationError(writable.error.code);
    withWorkbenchProductionMutationAuthority(db, {
      kind: "readiness_refresh", project_id: projectId, object_id: projectId
    }, () => db.prepare(`
      UPDATE workbench_delivery_state
      SET workflow_state = CASE
        WHEN EXISTS (SELECT 1 FROM shots WHERE project_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM shots shot
            WHERE shot.project_id = ?
              AND (
                json_valid(shot.data_json) = 0
                OR COALESCE(json_extract(shot.data_json, '$.status'), '') <> 'approved'
                OR COALESCE(json_extract(shot.data_json, '$.review.approval_status'), '') <> 'approved'
                OR COALESCE(json_extract(shot.data_json, '$.accepted_clip_artifact_id'), '') = ''
                OR NOT EXISTS (
                  SELECT 1
                  FROM media_artifacts artifact
                  JOIN media_artifact_blobs binding ON binding.artifact_id = artifact.artifact_id
                  JOIN media_blobs blob ON blob.blob_id = binding.blob_id
                  WHERE artifact.artifact_id = json_extract(shot.data_json, '$.accepted_clip_artifact_id')
                    AND artifact.project_id = shot.project_id
                    AND artifact.shot_id = shot.shot_id
                    AND artifact.role = 'generated_clip'
                    AND artifact.artifact_type = 'video'
                    AND artifact.status = 'active'
                    AND blob.integrity_state = 'verified'
                )
                OR NOT EXISTS (
                  SELECT 1 FROM json_each(shot.data_json, '$.clip_versions') version
                  WHERE json_extract(version.value, '$.artifact_id') = json_extract(shot.data_json, '$.accepted_clip_artifact_id')
                    AND json_extract(version.value, '$.review_status') = 'approved'
                )
              )
          )
        THEN 'ready_to_assemble'
        ELSE 'not_ready'
      END,
      assembly_input_fingerprint = NULL,
      updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND workflow_state IN ('not_ready','ready_to_assemble','revision_requested')
    `).run(projectId, projectId, projectId));
    const state = requireWorkbenchDeliveryState(db, projectId);
    if (ownsTransaction) db.exec("COMMIT");
    return state;
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    throwWorkbenchProductionMutationError(error);
  }
}

export function projectWorkbenchDeliverySummaryState(
  state: WorkbenchDeliveryWorkflowState,
  exportVerification: WorkbenchExportVerificationState = "not_applicable"
): WorkbenchDeliverySummaryState {
  if (state === "closed") {
    if (exportVerification === "verified") return "delivered";
    if (exportVerification === "failed") return "delivery_invalid";
    return "verification_required";
  }
  if (state === "ready_to_assemble" || state === "assembling") return "ready_to_assemble";
  if (["final_review", "revision_requested", "approved", "exported", "legacy_review_required"].includes(state)) return "final_review";
  return "not_ready";
}
