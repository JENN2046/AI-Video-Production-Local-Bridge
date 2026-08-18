import type { M0Database } from "../src/storage/sqlite.js";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { paths } from "../src/paths.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { buildStoryboardApprovedShot, getShot, saveShot } from "../src/tools/projects.js";

export function createAcceptedAssemblyClipFixture(
  db: M0Database,
  input: { project_id: string; shot_id?: string; order?: number; label?: string }
): { shot_id: string; artifact_id: string } {
  const order = input.order ?? 1;
  const label = input.label ?? String(order);
  const shot = buildStoryboardApprovedShot({
    project_id: input.project_id,
    order,
    duration_seconds: 2,
    storyboard_image_artifact_id: "",
    video_prompt: `Assembly source ${label}`
  });
  if (input.shot_id) shot.shot_id = input.shot_id;
  saveShot(db, shot);
  const clip = registerMediaArtifact({
    artifact_type: "video",
    role: "generated_clip",
    source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
    linked_objects: { project_id: input.project_id, shot_id: shot.shot_id }
  }, db);
  if (!clip.ok) throw new Error(`DELIVERY_FIXTURE_CLIP_REGISTRATION_FAILED:${clip.error.code}`);
  shot.status = "approved";
  shot.accepted_clip_artifact_id = clip.artifact.artifact_id;
  shot.clip_versions = [{
    artifact_id: clip.artifact.artifact_id,
    run_id: `run_${shot.shot_id}`,
    attempt_number: 1,
    review_status: "approved"
  }];
  shot.review.approval_status = "approved";
  saveShot(db, shot);
  return { shot_id: shot.shot_id, artifact_id: clip.artifact.artifact_id };
}

export function ensureAcceptedAssemblyClipsFixture(db: M0Database, projectId: string): void {
  const shotIds = (db.prepare("SELECT shot_id FROM shots WHERE project_id = ? ORDER BY shot_id")
    .all(projectId) as Array<{ shot_id: string }>).map((row) => row.shot_id);
  if (shotIds.length === 0) {
    createAcceptedAssemblyClipFixture(db, { project_id: projectId, label: "default" });
    return;
  }
  for (const shotId of shotIds) {
    const shot = getShot(db, shotId);
    if (!shot) throw new Error(`DELIVERY_FIXTURE_SHOT_MISSING:${shotId}`);
    let changed = false;
    if (!shot.accepted_clip_artifact_id) {
      const clip = registerMediaArtifact({
        artifact_type: "video",
        role: "generated_clip",
        source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
        linked_objects: { project_id: projectId, shot_id: shotId }
      }, db);
      if (!clip.ok) throw new Error(`DELIVERY_FIXTURE_CLIP_REGISTRATION_FAILED:${clip.error.code}`);
      shot.accepted_clip_artifact_id = clip.artifact.artifact_id;
      shot.clip_versions = [...shot.clip_versions, {
        artifact_id: clip.artifact.artifact_id,
        run_id: `run_${shot.shot_id}`,
        attempt_number: shot.clip_versions.length + 1,
        review_status: "approved"
      }];
      changed = true;
    } else {
      const acceptedVersion = shot.clip_versions.find((version) => version.artifact_id === shot.accepted_clip_artifact_id);
      if (!acceptedVersion) throw new Error(`DELIVERY_FIXTURE_ACCEPTED_VERSION_MISSING:${shotId}`);
      if (acceptedVersion.review_status !== "approved") {
        acceptedVersion.review_status = "approved";
        changed = true;
      }
    }
    if (shot.status !== "approved") {
      shot.status = "approved";
      changed = true;
    }
    if (shot.review.approval_status !== "approved") {
      shot.review.approval_status = "approved";
      changed = true;
    }
    if (changed) saveShot(db, shot);
  }
}

export function queueWorkbenchAssemblyFixture(
  db: M0Database,
  input: { project_id: string; job_id: string; event_id: string; created_at: string; input_fingerprint?: string }
): string {
  ensureAcceptedAssemblyClipsFixture(db, input.project_id);
  const sourceClipArtifactIds = (db.prepare(`SELECT json_extract(data_json, '$.accepted_clip_artifact_id') AS id
    FROM shots WHERE project_id = ? ORDER BY CAST(json_extract(data_json, '$.order') AS INTEGER), shot_id`)
    .all(input.project_id) as Array<{ id: string }>).map((row) => row.id);
  if (sourceClipArtifactIds.length === 0 || sourceClipArtifactIds.some((id) => !id)) {
    throw new Error("DELIVERY_FIXTURE_COMPLETE_ACCEPTED_SHOTS_REQUIRED");
  }
  const fingerprint = input.input_fingerprint ?? "a".repeat(64);
  const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_fingerprint, input_json, created_at, updated_at)
      VALUES (?, ?, 'assembly', 'queued', ?, ?, ?, ?)`)
      .run(input.job_id, input.project_id, fingerprint,
        JSON.stringify({ source_clip_artifact_ids: sourceClipArtifactIds }), input.created_at, input.created_at);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state,
        input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'assembly_queued', 'ready_to_assemble', 'assembling', ?,
        'ASSEMBLY_QUEUED', '{}', ?)`)
      .run(input.event_id, input.project_id, input.job_id, fingerprint, input.created_at);
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'assembling', active_assembly_job_id = ?,
        assembly_input_fingerprint = ?, updated_at = ?
      WHERE project_id = ?`).run(input.job_id, fingerprint, input.created_at, input.project_id);
    if (ownsTransaction) db.exec("COMMIT");
    return fingerprint;
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function failWorkbenchAssemblyFixture(
  db: M0Database,
  input: { project_id: string; job_id: string; event_id: string; created_at: string; interrupted?: boolean }
): void {
  const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const terminalState = input.interrupted ? "interrupted" : "failed";
    const eventType = input.interrupted ? "assembly_interrupted" : "assembly_failed";
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = ?, error_code = 'SYNTHETIC_FAILURE', terminal_event_id = ?, finished_at = ?, updated_at = ?
      WHERE job_id = ? AND project_id = ? AND job_type = 'assembly' AND state IN ('queued','running')`)
      .run(terminalState, input.event_id, input.created_at, input.created_at, input.job_id, input.project_id);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint,
        reason_code, data_json, created_at)
      SELECT ?, project_id, job_id, ?, 'assembling', 'ready_to_assemble', input_fingerprint,
        'SYNTHETIC_FAILURE', '{}', ? FROM workbench_delivery_jobs WHERE job_id = ? AND project_id = ?`)
      .run(input.event_id, eventType, input.created_at, input.job_id, input.project_id);
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function completeWorkbenchAssemblyFixture(
  db: M0Database,
  input: { project_id: string; artifact_id: string; job_id: string; event_id: string; created_at: string; input_fingerprint?: string }
): void {
  ensureAcceptedAssemblyClipsFixture(db, input.project_id);
  const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    let state = db.prepare(`SELECT workflow_state, assembly_input_fingerprint, active_assembly_job_id
      FROM workbench_delivery_state WHERE project_id = ?`).get(input.project_id) as {
        workflow_state: string;
        assembly_input_fingerprint: string | null;
        active_assembly_job_id: string | null;
      } | undefined;
    const sourceClipArtifactIds = (db.prepare(`SELECT json_extract(data_json, '$.accepted_clip_artifact_id') AS accepted_clip_artifact_id
      FROM shots WHERE project_id = ? AND COALESCE(json_extract(data_json, '$.accepted_clip_artifact_id'), '') <> ''
      ORDER BY CAST(json_extract(data_json, '$.order') AS INTEGER), shot_id`).all(input.project_id) as Array<{ accepted_clip_artifact_id: string }>)
      .map((row) => row.accepted_clip_artifact_id);
    const totalShots = Number((db.prepare("SELECT COUNT(*) AS count FROM shots WHERE project_id = ?")
      .get(input.project_id) as { count: number }).count);
    if (totalShots === 0 || sourceClipArtifactIds.length !== totalShots) {
      throw new Error("DELIVERY_FIXTURE_COMPLETE_ACCEPTED_SHOTS_REQUIRED");
    }
    if (state?.workflow_state === "ready_to_assemble") {
      const fingerprint = input.input_fingerprint ?? state.assembly_input_fingerprint ?? "a".repeat(64);
      db.prepare(`INSERT INTO workbench_delivery_jobs
        (job_id, project_id, job_type, state, input_fingerprint, input_json, created_at, updated_at)
        VALUES (?, ?, 'assembly', 'queued', ?, ?, ?, ?)`)
        .run(input.job_id, input.project_id, fingerprint,
          JSON.stringify({ source_clip_artifact_ids: sourceClipArtifactIds }), input.created_at, input.created_at);
      db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state,
          input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, 'assembly_queued', 'ready_to_assemble', 'assembling', ?,
          'ASSEMBLY_QUEUED', '{}', ?)`)
        .run(`${input.event_id}_queued`, input.project_id, input.job_id, fingerprint, input.created_at);
      db.prepare(`UPDATE workbench_delivery_state
        SET workflow_state = 'assembling', active_assembly_job_id = ?,
          assembly_input_fingerprint = ?, updated_at = ?
        WHERE project_id = ?`).run(input.job_id, fingerprint, input.created_at, input.project_id);
      state = { workflow_state: "assembling", assembly_input_fingerprint: fingerprint, active_assembly_job_id: input.job_id };
    }
    if (state?.workflow_state !== "assembling" || state.active_assembly_job_id !== input.job_id
      || !state.assembly_input_fingerprint) {
      throw new Error("DELIVERY_FIXTURE_ASSEMBLING_REQUIRED");
    }
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'running', started_at = ?, updated_at = ? WHERE job_id = ?`)
      .run(input.created_at, input.created_at, input.job_id);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state,
        input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'assembly_started', 'assembling', 'assembling', ?,
        'ASSEMBLY_STARTED', '{}', ?)`)
      .run(`${input.event_id}_started`, input.project_id, input.job_id,
        state.assembly_input_fingerprint, input.created_at);
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'succeeded', output_artifact_id = ?, terminal_event_id = ?, finished_at = ?, updated_at = ?
      WHERE job_id = ?`).run(input.artifact_id, input.event_id, input.created_at, input.created_at, input.job_id);
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
      (job_id, project_id, job_type, state, input_json, export_id, terminal_event_id,
        created_at, started_at, finished_at, updated_at)
      VALUES (?, ?, 'export', 'succeeded', json_object('artifact_id', ?), ?, ?, ?, ?, ?, ?)`)
      .run(input.job_id, input.project_id, state.current_final_artifact_id, input.export_id,
        input.event_id, input.created_at, input.created_at, input.created_at, input.created_at);
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

export function insertWorkbenchExportFixture(
  db: M0Database,
  input: { project_id: string; artifact_id: string; export_id: string; created_at: string }
): { relative_path: string; sha256: string; size_bytes: number } {
  const blob = db.prepare(`SELECT b.sha256, b.size_bytes
    FROM media_artifact_blobs ab JOIN media_blobs b ON b.blob_id = ab.blob_id
    WHERE ab.artifact_id = ? AND b.integrity_state = 'verified'`).get(input.artifact_id) as {
      sha256: string; size_bytes: number;
    } | undefined;
  if (!blob) throw new Error(`DELIVERY_FIXTURE_VERIFIED_BLOB_REQUIRED:${input.artifact_id}`);
  const projectRoot = join(paths.exportsRoot, input.project_id);
  mkdirSync(projectRoot, { recursive: true });
  const filename = `${input.export_id.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}.mp4`;
  const target = join(projectRoot, filename);
  if (!existsSync(target)) copyFileSync(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"), target);
  const relativePath = `data/exports/${input.project_id}/${basename(target)}`;
  db.prepare(`INSERT INTO workbench_exports
    (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(input.export_id, input.project_id, input.artifact_id, relativePath,
      blob.sha256, blob.size_bytes, input.created_at);
  return { relative_path: relativePath, sha256: blob.sha256, size_bytes: blob.size_bytes };
}

export function approveWorkbenchDeliveryFixture(
  db: M0Database,
  input: { project_id: string; event_id: string; created_at: string }
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
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'approved', approved_artifact_id = current_final_artifact_id,
        latest_export_id = NULL, latest_exported_at = NULL, updated_at = ?
      WHERE project_id = ?`).run(input.created_at, input.project_id);
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
        state.assembly_input_fingerprint,
        input.created_at
      );
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
