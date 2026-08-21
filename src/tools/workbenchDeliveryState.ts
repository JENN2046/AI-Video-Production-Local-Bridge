import type { M0Database } from "../storage/sqlite.js";

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

export type WorkbenchDeliverySummaryState = "not_ready" | "ready_to_assemble" | "final_review" | "delivered";

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

export function projectWorkbenchDeliverySummaryState(state: WorkbenchDeliveryWorkflowState): WorkbenchDeliverySummaryState {
  if (state === "closed") return "delivered";
  if (state === "ready_to_assemble" || state === "assembling") return "ready_to_assemble";
  if (["final_review", "revision_requested", "approved", "exported", "legacy_review_required"].includes(state)) return "final_review";
  return "not_ready";
}
