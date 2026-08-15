import type { M0Database } from "../src/storage/sqlite.js";

export function approveWorkbenchDeliveryFixture(
  db: M0Database,
  input: { project_id: string; event_id: string; created_at: string; assembly_input_fingerprint?: string | null }
): void {
  const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare(`SELECT workflow_state, current_final_artifact_id, assembly_input_fingerprint
      FROM workbench_delivery_state WHERE project_id = ?`).get(input.project_id) as {
        workflow_state: string;
        current_final_artifact_id: string;
        assembly_input_fingerprint: string | null;
    } | undefined;
    if (!state?.current_final_artifact_id) throw new Error("DELIVERY_FIXTURE_FINAL_REVIEW_REQUIRED");
    const fingerprint = input.assembly_input_fingerprint === undefined
      ? state.assembly_input_fingerprint
      : input.assembly_input_fingerprint;
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'approved', approved_artifact_id = current_final_artifact_id,
        assembly_input_fingerprint = ?, latest_export_id = NULL, latest_exported_at = NULL, updated_at = ?
      WHERE project_id = ?`).run(fingerprint, input.created_at, input.project_id);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id,
        input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, 'final_review_accepted', ?, 'approved', ?, ?,
        'FINAL_REVIEW_ACCEPTED', '{}', ?)`)
      .run(
        input.event_id,
        input.project_id,
        state.workflow_state,
        state.current_final_artifact_id,
        fingerprint,
        input.created_at
      );
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
