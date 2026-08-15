import type { M0Database } from "../storage/sqlite.js";

export const WORKBENCH_DELIVERY_WORKFLOW_STATES = [
  "not_ready",
  "ready_to_assemble",
  "assembling",
  "final_review",
  "revision_requested",
  "approved",
  "exported",
  "closed",
  "legacy_review_required"
] as const;

export type WorkbenchDeliveryWorkflowState = typeof WORKBENCH_DELIVERY_WORKFLOW_STATES[number];
export type WorkbenchSummaryDeliveryState = "not_ready" | "ready_to_assemble" | "final_review" | "delivered";
export type WorkbenchDeliveryJobType = "assembly" | "export";
export type WorkbenchDeliveryJobState = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface WorkbenchDeliveryStateRecord {
  project_id: string;
  workflow_state: WorkbenchDeliveryWorkflowState;
  current_final_artifact_id: string | null;
  assembly_input_fingerprint: string | null;
  approved_artifact_id: string | null;
  latest_export_id: string | null;
  latest_exported_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkbenchDeliveryJobRecord {
  job_id: string;
  project_id: string;
  job_type: WorkbenchDeliveryJobType;
  state: WorkbenchDeliveryJobState;
  input_fingerprint: string | null;
  retry_of_job_id: string | null;
  output_artifact_id: string | null;
  export_id: string | null;
  error_code: string | null;
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

export type WorkbenchProductionWriteBoundaryResult =
  | { ok: true; delivery: WorkbenchDeliveryStateRecord }
  | { ok: false; error: { code: "PROJECT_NOT_FOUND" | "PROJECT_ARCHIVED" | "DELIVERY_STATE_MISSING" | "PROJECT_CLOSED"; message: string } };

export type WorkbenchContentMutationBoundaryResult =
  | WorkbenchProductionWriteBoundaryResult
  | { ok: false; error: { code: "DELIVERY_REWORK_REQUIRED"; message: string } };

const FINAL_EVIDENCE_STATES: ReadonlySet<WorkbenchDeliveryWorkflowState> = new Set([
  "final_review",
  "approved",
  "exported",
  "legacy_review_required"
]);

export function getWorkbenchDeliveryState(db: M0Database, projectId: string): WorkbenchDeliveryStateRecord | null {
  const row = db.prepare(`
    SELECT project_id, workflow_state, current_final_artifact_id, assembly_input_fingerprint,
      approved_artifact_id, latest_export_id, latest_exported_at, closed_at, created_at, updated_at
    FROM workbench_delivery_state WHERE project_id = ?
  `).get(projectId) as WorkbenchDeliveryStateRecord | undefined;
  return row ?? null;
}

export function assertWorkbenchProductionWriteAllowed(db: M0Database, projectId: string): WorkbenchProductionWriteBoundaryResult {
  const project = db.prepare("SELECT 1 AS present FROM projects WHERE project_id = ?").get(projectId) as { present: number } | undefined;
  if (!project) {
    return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` } };
  }

  const meta = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?").get(projectId) as { lifecycle: string } | undefined;
  if (!meta) {
    return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` } };
  }
  if (meta.lifecycle === "archived") {
    return { ok: false, error: { code: "PROJECT_ARCHIVED", message: "Archived projects are read-only." } };
  }

  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery) {
    return { ok: false, error: { code: "DELIVERY_STATE_MISSING", message: "Project delivery state is unavailable." } };
  }
  if (delivery.workflow_state === "closed") {
    return { ok: false, error: { code: "PROJECT_CLOSED", message: "Closed projects do not accept production changes." } };
  }
  return { ok: true, delivery };
}

export function assertWorkbenchContentMutationAllowed(
  db: M0Database,
  projectId: string,
  options: { allow_atomic_final_review_transaction?: boolean } = {}
): WorkbenchContentMutationBoundaryResult {
  const writable = assertWorkbenchProductionWriteAllowed(db, projectId);
  if (!writable.ok) return writable;
  const callerOwnsAtomicFinalReview = options.allow_atomic_final_review_transaction === true
    && (db as unknown as { isTransaction?: boolean }).isTransaction === true;
  if (FINAL_EVIDENCE_STATES.has(writable.delivery.workflow_state) && !callerOwnsAtomicFinalReview) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_REWORK_REQUIRED",
        message: "Final delivery evidence must enter an explicit rework state before production content changes."
      }
    };
  }
  return writable;
}

export function getActiveWorkbenchDeliveryJob(db: M0Database, projectId?: string): WorkbenchDeliveryJobRecord | null {
  const row = db.prepare(`
    SELECT job_id, project_id, job_type, state, input_fingerprint, retry_of_job_id,
      output_artifact_id, export_id, error_code, created_at, started_at, finished_at, updated_at
    FROM workbench_delivery_jobs
    WHERE state IN ('queued','running') ${projectId ? "AND project_id = ?" : ""}
    ORDER BY created_at, job_id LIMIT 1
  `).get(...(projectId ? [projectId] : [])) as WorkbenchDeliveryJobRecord | undefined;
  return row ?? null;
}

export function getLatestWorkbenchExport(db: M0Database, projectId: string): WorkbenchExportRecord | null {
  const row = db.prepare(`
    SELECT e.export_id, e.project_id, e.artifact_id, e.relative_path, e.sha256, e.size_bytes, e.created_at
    FROM workbench_delivery_state d
    JOIN workbench_exports e ON e.export_id = d.latest_export_id AND e.project_id = d.project_id
    WHERE d.project_id = ?
  `).get(projectId) as WorkbenchExportRecord | undefined;
  return row ? { ...row, size_bytes: Number(row.size_bytes) } : null;
}

export function getWorkbenchCloseoutReceipt(db: M0Database, projectId: string): WorkbenchCloseoutReceipt | null {
  const row = db.prepare(`
    SELECT event_id, project_id, artifact_id, export_id, reason_code, created_at
    FROM workbench_delivery_events
    WHERE project_id = ? AND event_type = 'closeout'
    ORDER BY created_at DESC, event_id DESC LIMIT 1
  `).get(projectId) as WorkbenchCloseoutReceipt | undefined;
  return row ?? null;
}

export function projectSummaryDeliveryState(state: WorkbenchDeliveryWorkflowState): WorkbenchSummaryDeliveryState {
  if (state === "closed") return "delivered";
  if (state === "ready_to_assemble" || state === "assembling") return "ready_to_assemble";
  if (state === "final_review" || state === "approved" || state === "exported" || state === "legacy_review_required") return "final_review";
  return "not_ready";
}
