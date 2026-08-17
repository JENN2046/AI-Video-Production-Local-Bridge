import type { M0Database } from "../src/storage/sqlite.js";

export function completeWorkbenchAssemblyFixture(
  db: M0Database,
  input: { project_id: string; artifact_id: string; job_id: string; event_id: string; created_at: string }
): void {
  const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare(`SELECT workflow_state, assembly_input_fingerprint
      FROM workbench_delivery_state WHERE project_id = ?`).get(input.project_id) as {
        workflow_state: string;
        assembly_input_fingerprint: string | null;
      } | undefined;
    if (state?.workflow_state !== "assembling") throw new Error("DELIVERY_FIXTURE_ASSEMBLING_REQUIRED");
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_fingerprint, input_json, output_artifact_id,
        created_at, started_at, finished_at, updated_at)
      VALUES (?, ?, 'assembly', 'succeeded', ?, '{}', ?, ?, ?, ?, ?)`)
      .run(input.job_id, input.project_id, state.assembly_input_fingerprint, input.artifact_id,
        input.created_at, input.created_at, input.created_at, input.created_at);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id,
        input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'assembly_succeeded', 'assembling', 'final_review', ?, ?,
        'ASSEMBLY_SUCCEEDED', '{}', ?)`)
      .run(input.event_id, input.project_id, input.job_id, input.artifact_id,
        state.assembly_input_fingerprint, input.created_at);
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function completeWorkbenchExportFixture(
  db: M0Database,
  input: { project_id: string; export_id: string; job_id: string; event_id: string; created_at: string }
): void {
  const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare(`SELECT workflow_state, current_final_artifact_id, approved_artifact_id
      FROM workbench_delivery_state WHERE project_id = ?`).get(input.project_id) as {
        workflow_state: string;
        current_final_artifact_id: string | null;
        approved_artifact_id: string | null;
      } | undefined;
    if (state?.workflow_state !== "approved" || !state.current_final_artifact_id
      || state.approved_artifact_id !== state.current_final_artifact_id) {
      throw new Error("DELIVERY_FIXTURE_APPROVED_REQUIRED");
    }
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id,
        created_at, started_at, finished_at, updated_at)
      VALUES (?, ?, 'export', 'succeeded', json_object('artifact_id', ?), ?, ?, ?, ?, ?)`)
      .run(input.job_id, input.project_id, state.current_final_artifact_id, input.export_id,
        input.created_at, input.created_at, input.created_at, input.created_at);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id,
        export_id, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'export_succeeded', 'approved', 'exported', ?, ?,
        'EXPORT_SUCCEEDED', '{}', ?)`)
      .run(input.event_id, input.project_id, input.job_id, state.current_final_artifact_id,
        input.export_id, input.created_at);
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

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
