import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import { paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { validateActiveArtifactReference, validateAcceptedClipReference } from "./mediaArtifacts.js";
import { validateMp4File } from "./mediaValidity.js";
import { getProject, listProjectShots, saveProject, saveShot, type Project, type Shot, type ToolError } from "./projects.js";
import { markShotClipReview } from "./review.js";
import {
  getActiveWorkbenchDeliveryJob,
  getWorkbenchDeliveryState,
  type WorkbenchCloseoutReceipt,
  type WorkbenchDeliveryJobRecord,
  type WorkbenchDeliveryStateRecord,
  type WorkbenchExportRecord
} from "./workbenchDeliveryState.js";

export const FINAL_EXPORT_CONTRACT_VERSION = "final-export-v1" as const;
export const CLOSEOUT_CONFIRMATION_PHRASE = "确认结案" as const;

export type WorkbenchDeliveryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError & { field?: string } };

export type WorkbenchFinalReviewDecision = "accept" | "reassemble" | "regenerate_shots";

export interface WorkbenchFinalVersionRecord {
  artifact_id: string;
  created_at: string;
  assembly_job_id: string | null;
  assembled_at: string | null;
}

export interface WorkbenchExportSnapshot {
  contract_version: typeof FINAL_EXPORT_CONTRACT_VERSION;
  project_id: string;
  artifact_id: string;
  blob_sha256: string;
  size_bytes: number;
  relative_path: string;
}

export interface WorkbenchDeliveryDependencies {
  now?: () => Date;
  random_uuid?: () => string;
  before_export_copy?: (partPath: string) => void | Promise<void>;
  after_export_copy?: (partPath: string) => void | Promise<void>;
  validate_export_file?: (filePath: string) => boolean;
}

interface DeliveryJobRow extends WorkbenchDeliveryJobRecord {
  input_json: string;
}

interface FileFacts {
  sha256: string;
  size_bytes: number;
}

class DeliveryFailure extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

function now(dependencies: WorkbenchDeliveryDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function uuid(dependencies: WorkbenchDeliveryDependencies): string {
  return dependencies.random_uuid?.() ?? randomUUID();
}

function isPathInside(child: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function hasExistingSymlinkAncestor(child: string, parent: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  if (!isPathInside(target, root)) return true;
  let current = root;
  for (const part of relative(root, target).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function fileFacts(filePath: string): FileFacts {
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes are unavailable or unsafe.");
  }
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes changed during verification.");
    }
    return { sha256: hash.digest("hex"), size_bytes: before.size };
  } finally {
    closeSync(descriptor);
  }
}

function validateExportFile(filePath: string, expected: Pick<WorkbenchExportSnapshot, "blob_sha256" | "size_bytes">, dependencies: WorkbenchDeliveryDependencies): FileFacts {
  const facts = fileFacts(filePath);
  const mediaValid = dependencies.validate_export_file
    ? dependencies.validate_export_file(filePath)
    : validateMp4File(filePath).status === "PASS";
  if (facts.sha256 !== expected.blob_sha256 || facts.size_bytes !== expected.size_bytes || !mediaValid) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes failed SHA-256, size, or FFprobe validation.");
  }
  return facts;
}

function deliveryError(error: unknown): WorkbenchDeliveryResult<never> {
  if (error instanceof DeliveryFailure) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } };
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("idx_workbench_delivery_jobs_single_active") || message.includes("UNIQUE constraint failed: index 'idx_workbench_delivery_jobs_single_active'")) {
    return { ok: false, error: { code: "DELIVERY_JOB_ACTIVE", message: "Another assembly or export Job is active." } };
  }
  return { ok: false, error: { code: "EXPORT_INTEGRITY_FAILED", message: "Delivery operation failed closed." } };
}

function projectForDelivery(db: M0Database, projectId: string): { project: Project; delivery: WorkbenchDeliveryStateRecord } {
  const project = getProject(db, projectId);
  if (!project) throw new DeliveryFailure("PROJECT_NOT_FOUND", "Project was not found.", "project_id");
  const meta = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?").get(projectId) as { lifecycle: string } | undefined;
  if (!meta) throw new DeliveryFailure("PROJECT_NOT_FOUND", "Project workbench metadata was not found.", "project_id");
  if (meta.lifecycle === "archived") throw new DeliveryFailure("PROJECT_ARCHIVED", "Archived projects are read-only.", "project_id");
  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery) throw new DeliveryFailure("DELIVERY_STATE_MISSING", "Project delivery state is unavailable.", "project_id");
  if (delivery.workflow_state === "closed") throw new DeliveryFailure("PROJECT_CLOSED", "Closed projects do not accept production changes.", "project_id");
  return { project, delivery };
}

function getDeliveryJob(db: M0Database, jobId: string): DeliveryJobRow | null {
  const row = db.prepare(`SELECT job_id, project_id, job_type, state, input_fingerprint, input_json,
    retry_of_job_id, output_artifact_id, export_id, error_code, created_at, started_at, finished_at, updated_at
    FROM workbench_delivery_jobs WHERE job_id = ?`).get(jobId) as DeliveryJobRow | undefined;
  return row ?? null;
}

function publicDeliveryJob(row: DeliveryJobRow): WorkbenchDeliveryJobRecord {
  const { input_json: _inputJson, ...job } = row;
  return job;
}

function exportInputFingerprint(snapshot: WorkbenchExportSnapshot): string {
  return createHash("sha256").update(canonicalizeJcs(snapshot), "utf8").digest("hex");
}

function finalArtifactShortId(artifactId: string): string {
  const safe = artifactId.replace(/^artifact_/, "").replace(/[^A-Za-z0-9]/g, "");
  return safe.slice(0, 8) || createHash("sha256").update(artifactId, "utf8").digest("hex").slice(0, 8);
}

function exportTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function assertSafeProjectSegment(projectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Project id cannot be represented in the governed export library.", "project_id");
  }
}

function exportFileLocation(relativePath: string, expectedProjectId?: string): { directory: string; final: string; part: string } {
  if (relativePath.includes("\\") || relativePath.includes("..") || relativePath.includes(":")) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export path failed governance validation.");
  }
  const parts = relativePath.split("/");
  if (parts.length !== 4 || parts[0] !== "data" || parts[1] !== "exports" || !parts[2] || !parts[3]
    || (expectedProjectId && parts[2] !== expectedProjectId) || basename(parts[3]) !== parts[3] || !parts[3].endsWith(".mp4")) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export path failed governance validation.");
  }
  const root = resolve(paths.exportsRoot);
  const directory = resolve(root, parts[2]);
  const final = resolve(directory, parts[3]);
  const part = `${final}.part`;
  if (!isPathInside(directory, root) || !isPathInside(final, directory) || !isPathInside(part, directory)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export path escaped the governed library.");
  }
  return { directory, final, part };
}

function chooseExportRelativePath(projectId: string, artifactId: string, date: Date, db: M0Database): string {
  assertSafeProjectSegment(projectId);
  for (let offsetMs = 0; offsetMs < 10_000; offsetMs += 1) {
    const filename = `${projectId}_${exportTimestamp(new Date(date.getTime() + offsetMs))}_${finalArtifactShortId(artifactId)}.mp4`;
    const relativePath = `data/exports/${projectId}/${filename}`;
    const location = exportFileLocation(relativePath, projectId);
    const claimed = db.prepare("SELECT 1 AS claimed FROM workbench_exports WHERE relative_path = ?").get(relativePath);
    if (!claimed && !existsSync(location.final) && !existsSync(location.part)) return relativePath;
  }
  throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "A unique export filename could not be allocated.");
}

function ensureSafeExportDirectory(projectId: string): string {
  assertSafeProjectSegment(projectId);
  const dataRoot = resolve(paths.dataRoot);
  const root = resolve(paths.exportsRoot);
  if (!existsSync(dataRoot) || lstatSync(dataRoot).isSymbolicLink() || !statSync(dataRoot).isDirectory()) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export data root is unsafe.");
  }
  if (!isPathInside(root, dataRoot) || hasExistingSymlinkAncestor(root, dataRoot)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export library path is unsafe.");
  }
  if (!existsSync(root)) mkdirSync(root);
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory() || !isPathInside(realpathSync(root), realpathSync(dataRoot))) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export library path is unsafe.");
  }
  const directory = resolve(root, projectId);
  if (!isPathInside(directory, root) || hasExistingSymlinkAncestor(directory, root)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Project export path is unsafe.");
  }
  if (!existsSync(directory)) mkdirSync(directory);
  if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory() || !isPathInside(realpathSync(directory), realpathSync(root))) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Project export path is unsafe.");
  }
  return directory;
}

function exportRecord(db: M0Database, projectId: string, exportId: string): WorkbenchExportRecord | null {
  const row = db.prepare(`SELECT export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at
    FROM workbench_exports WHERE project_id = ? AND export_id = ?`).get(projectId, exportId) as WorkbenchExportRecord | undefined;
  return row ? { ...row, size_bytes: Number(row.size_bytes) } : null;
}

function exportRecordIsReusable(db: M0Database, record: WorkbenchExportRecord, dependencies: WorkbenchDeliveryDependencies): boolean {
  try {
    const artifact = validateActiveArtifactReference(db, {
      artifact_id: record.artifact_id,
      project_id: record.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!artifact.ok || artifact.blob.sha256 !== record.sha256 || artifact.blob.size_bytes !== record.size_bytes) return false;
    const location = exportFileLocation(record.relative_path, record.project_id);
    validateExportFile(location.final, { blob_sha256: record.sha256, size_bytes: record.size_bytes }, dependencies);
    return true;
  } catch {
    return false;
  }
}

export function listWorkbenchFinalVersions(db: M0Database, projectId: string): WorkbenchFinalVersionRecord[] {
  return (db.prepare(`SELECT a.artifact_id, a.created_at, j.job_id AS assembly_job_id, j.finished_at AS assembled_at
    FROM media_artifacts a
    LEFT JOIN workbench_delivery_jobs j
      ON j.output_artifact_id = a.artifact_id AND j.project_id = a.project_id AND j.job_type = 'assembly' AND j.state = 'succeeded'
    WHERE a.project_id = ? AND COALESCE(a.shot_id, '') = '' AND a.role = 'final_video'
      AND a.artifact_type = 'video' AND a.status = 'active'
    ORDER BY COALESCE(j.finished_at, a.created_at) DESC, a.artifact_id DESC`).all(projectId) as WorkbenchFinalVersionRecord[])
    .map((row) => ({ ...row, assembly_job_id: row.assembly_job_id ?? null, assembled_at: row.assembled_at ?? null }));
}

export function refreshWorkbenchDeliveryAssemblyReadiness(db: M0Database, projectId: string): WorkbenchDeliveryStateRecord | null {
  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery || delivery.workflow_state === "closed" || getActiveWorkbenchDeliveryJob(db, projectId)) return delivery;
  if (!new Set(["not_ready", "ready_to_assemble", "revision_requested"]).has(delivery.workflow_state)) return delivery;
  const shots = listProjectShots(db, projectId);
  const ready = shots.length > 0 && shots.every((shot) => Boolean(shot.accepted_clip_artifact_id) && validateAcceptedClipReference(db, shot).ok);
  const next = ready ? "ready_to_assemble"
    : delivery.workflow_state === "ready_to_assemble" ? "not_ready"
      : delivery.workflow_state;
  if (next !== delivery.workflow_state) {
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?")
      .run(next, projectId);
  }
  return getWorkbenchDeliveryState(db, projectId);
}

export function decideWorkbenchFinalReview(
  input: {
    project_id: string;
    artifact_id: string;
    decision: WorkbenchFinalReviewDecision;
    shot_ids?: string[];
    reason?: string;
    human_confirmation: boolean;
  },
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{
  delivery: WorkbenchDeliveryStateRecord;
  decision: WorkbenchFinalReviewDecision;
  regeneration_requests: Array<Record<string, unknown>>;
}> {
  if (!input.human_confirmation) {
    return { ok: false, error: { code: "HUMAN_CONFIRMATION_REQUIRED", message: "Final review requires explicit human confirmation." } };
  }
  if (!new Set<WorkbenchFinalReviewDecision>(["accept", "reassemble", "regenerate_shots"]).has(input.decision)) {
    return { ok: false, error: { code: "FINAL_REVIEW_DECISION_INVALID", message: "Final review decision is invalid.", field: "decision" } };
  }
  const selectedShotIds = [...new Set((input.shot_ids ?? []).map((value) => value.trim()).filter(Boolean))];
  if (input.decision === "regenerate_shots" && selectedShotIds.length === 0) {
    return { ok: false, error: { code: "FINAL_REWORK_SELECTION_REQUIRED", message: "Select at least one SHOT for targeted regeneration.", field: "shot_ids" } };
  }
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const { project, delivery } = projectForDelivery(db, input.project_id);
    if (getActiveWorkbenchDeliveryJob(db, input.project_id)) {
      throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "A delivery Job is active for this project.");
    }
    if (!delivery.current_final_artifact_id || input.artifact_id !== delivery.current_final_artifact_id
      || project.exports.final_video_artifact_id !== delivery.current_final_artifact_id) {
      throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Final review must target the current final Artifact.", "artifact_id");
    }
    const finalArtifact = validateActiveArtifactReference(db, {
      artifact_id: input.artifact_id,
      project_id: input.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!finalArtifact.ok) throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Current final Artifact failed integrity validation.", "artifact_id");

    const reviewStates = new Set(["final_review", "approved", "exported", "legacy_review_required"]);
    if (!reviewStates.has(delivery.workflow_state)
      || (input.decision === "accept" && !new Set(["final_review", "legacy_review_required"]).has(delivery.workflow_state))) {
      throw new DeliveryFailure("FINAL_REVIEW_STATE_INVALID", "Project is not waiting for this final review decision.");
    }

    const timestamp = now(dependencies);
    const requests: Array<Record<string, unknown>> = [];
    if (delivery.workflow_state === "legacy_review_required" && input.decision !== "reassemble") {
      db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'final_review', updated_at = ? WHERE project_id = ?")
        .run(timestamp, input.project_id);
    }

    let nextState: "approved" | "ready_to_assemble" | "revision_requested";
    let eventType: "final_review_accepted" | "final_review_reassemble" | "final_review_regenerate_shots";
    let reasonCode: string;
    if (input.decision === "accept") {
      nextState = "approved";
      eventType = "final_review_accepted";
      reasonCode = "FINAL_REVIEW_ACCEPTED";
      db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved', approved_artifact_id = current_final_artifact_id,
        latest_export_id = NULL, latest_exported_at = NULL, updated_at = ? WHERE project_id = ?`)
        .run(timestamp, input.project_id);
    } else if (input.decision === "reassemble") {
      nextState = "ready_to_assemble";
      eventType = "final_review_reassemble";
      reasonCode = "FINAL_REASSEMBLY_REQUESTED";
      db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', approved_artifact_id = NULL,
        latest_export_id = NULL, latest_exported_at = NULL, updated_at = ? WHERE project_id = ?`)
        .run(timestamp, input.project_id);
    } else {
      nextState = "revision_requested";
      eventType = "final_review_regenerate_shots";
      reasonCode = "FINAL_SHOT_REGENERATION_REQUESTED";
      const shots = new Map(listProjectShots(db, input.project_id).map((shot) => [shot.shot_id, shot]));
      for (const shotId of selectedShotIds) {
        const shot = shots.get(shotId);
        if (!shot?.accepted_clip_artifact_id) {
          throw new DeliveryFailure("FINAL_REWORK_SELECTION_REQUIRED", "Every selected SHOT must have a current accepted clip.", "shot_ids");
        }
        const artifactId = shot.accepted_clip_artifact_id;
        const version = shot.clip_versions.find((item) => item.artifact_id === artifactId);
        if (!version) throw new DeliveryFailure("FINAL_REWORK_SELECTION_REQUIRED", "Selected SHOT acceptance evidence is incomplete.", "shot_ids");
        const reviewed = markShotClipReview({
          shot_id: shotId,
          artifact_id: artifactId,
          decision: "revision_needed",
          rejection_reasons: [input.reason?.trim() || "最终审查要求定向返工"],
          revision_instruction: {
            summary: input.reason?.trim() || "最终审查要求定向返工",
            prompt_delta: input.reason?.trim() || "",
            negative_delta: "",
            priority: "high"
          }
        }, db);
        if (!reviewed.ok) throw new DeliveryFailure("FINAL_REWORK_SELECTION_REQUIRED", "Selected SHOT could not enter regeneration.", "shot_ids");
        reviewed.shot.accepted_clip_artifact_id = "";
        saveShot(db, reviewed.shot);
        const request = {
          request_id: `regeneration_${uuid(dependencies)}`,
          project_id: input.project_id,
          shot_id: shotId,
          artifact_id: artifactId,
          previous_run_id: version.run_id,
          rejection_reasons: [input.reason?.trim() || "最终审查要求定向返工"],
          revision_instruction: reviewed.shot.review.latest_revision_instruction,
          source: "final_review",
          status: "draft",
          created_at: timestamp
        };
        db.prepare(`INSERT INTO regeneration_requests
          (request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
          .run(request.request_id, request.project_id, request.shot_id, request.artifact_id, request.previous_run_id, canonicalizeJcs(request), timestamp, timestamp);
        requests.push(request);
      }
      db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'revision_requested', approved_artifact_id = NULL,
        latest_export_id = NULL, latest_exported_at = NULL, updated_at = ? WHERE project_id = ?`)
        .run(timestamp, input.project_id);
    }

    project.status = "video_review";
    saveProject(db, project);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`delivery_event_${uuid(dependencies)}`, input.project_id, eventType, delivery.workflow_state, nextState,
        input.artifact_id, delivery.assembly_input_fingerprint, reasonCode,
        canonicalizeJcs({ shot_ids: selectedShotIds, reason: (input.reason ?? "").trim().slice(0, 1_000) }), timestamp);
    db.exec("COMMIT");
    transactionOpen = false;
    const updated = getWorkbenchDeliveryState(db, input.project_id);
    if (!updated) throw new DeliveryFailure("DELIVERY_STATE_MISSING", "Updated delivery state is unavailable.");
    return { ok: true, data: { delivery: updated, decision: input.decision, regeneration_requests: requests } };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    }
    return deliveryError(error);
  }
}

export function queueWorkbenchExport(
  input: {
    project_id: string;
    artifact_id: string;
    human_confirmation: boolean;
    retry_of_job_id?: string;
  },
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{ reused: boolean; export: WorkbenchExportRecord | null; job: WorkbenchDeliveryJobRecord | null }> {
  if (!input.human_confirmation) {
    return { ok: false, error: { code: "EXPORT_CONFIRMATION_REQUIRED", message: "Local export requires explicit human confirmation." } };
  }
  try {
    const { project, delivery } = projectForDelivery(db, input.project_id);
    if (getActiveWorkbenchDeliveryJob(db)) throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "Another assembly or export Job is active.");
    if (!new Set(["approved", "exported"]).has(delivery.workflow_state)
      || !delivery.current_final_artifact_id || delivery.current_final_artifact_id !== input.artifact_id
      || delivery.approved_artifact_id !== input.artifact_id || project.exports.final_video_artifact_id !== input.artifact_id) {
      throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Export must target the current approved final Artifact.", "artifact_id");
    }
    const artifact = validateActiveArtifactReference(db, {
      artifact_id: input.artifact_id,
      project_id: input.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!artifact.ok) throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Approved final Artifact failed integrity validation.");

    const existing = db.prepare(`SELECT export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at
      FROM workbench_exports WHERE project_id = ? AND artifact_id = ? ORDER BY created_at DESC, export_id DESC`)
      .all(input.project_id, input.artifact_id) as WorkbenchExportRecord[];
    const reusable = existing.map((record) => ({ ...record, size_bytes: Number(record.size_bytes) }))
      .find((record) => exportRecordIsReusable(db, record, dependencies));
    if (reusable) {
      if (delivery.workflow_state !== "exported" || delivery.latest_export_id !== reusable.export_id) {
        const timestamp = now(dependencies);
        let transactionOpen = false;
        try {
          db.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const locked = projectForDelivery(db, input.project_id).delivery;
          if (getActiveWorkbenchDeliveryJob(db) || !new Set(["approved", "exported"]).has(locked.workflow_state)
            || locked.current_final_artifact_id !== input.artifact_id || locked.approved_artifact_id !== input.artifact_id) {
            throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "Delivery state changed before export reuse.");
          }
          db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported', latest_export_id = ?,
            latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
            .run(reusable.export_id, reusable.created_at, timestamp, input.project_id);
          db.prepare(`INSERT INTO workbench_delivery_events
            (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
            VALUES (?, ?, 'export_succeeded', ?, 'exported', ?, ?, 'EXPORT_REUSED', '{"reused":true}', ?)`)
            .run(`delivery_event_${uuid(dependencies)}`, input.project_id, locked.workflow_state, input.artifact_id, reusable.export_id, timestamp);
          db.exec("COMMIT");
          transactionOpen = false;
        } catch (error) {
          if (transactionOpen) {
            try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
          }
          throw error;
        }
      }
      return { ok: true, data: { reused: true, export: reusable, job: null } };
    }

    if (input.retry_of_job_id) {
      const prior = getDeliveryJob(db, input.retry_of_job_id);
      if (!prior || prior.project_id !== input.project_id || prior.job_type !== "export" || !new Set(["failed", "interrupted"]).has(prior.state)) {
        throw new DeliveryFailure("EXPORT_RETRY_INVALID", "Export retry must reference a failed or interrupted export Job.", "retry_of_job_id");
      }
    }
    const timestamp = now(dependencies);
    const relativePath = chooseExportRelativePath(input.project_id, input.artifact_id, new Date(timestamp), db);
    const snapshot: WorkbenchExportSnapshot = {
      contract_version: FINAL_EXPORT_CONTRACT_VERSION,
      project_id: input.project_id,
      artifact_id: input.artifact_id,
      blob_sha256: artifact.blob.sha256,
      size_bytes: artifact.blob.size_bytes,
      relative_path: relativePath
    };
    const fingerprint = exportInputFingerprint(snapshot);
    const jobId = `delivery_job_${uuid(dependencies)}`;
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const locked = projectForDelivery(db, input.project_id).delivery;
      if (getActiveWorkbenchDeliveryJob(db)) throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "Another assembly or export Job is active.");
      if (!new Set(["approved", "exported"]).has(locked.workflow_state)
        || locked.current_final_artifact_id !== input.artifact_id || locked.approved_artifact_id !== input.artifact_id) {
        throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Approved final Artifact changed before export queueing.", "artifact_id");
      }
      db.prepare(`INSERT INTO workbench_delivery_jobs
        (job_id, project_id, job_type, state, input_fingerprint, input_json, retry_of_job_id, created_at, updated_at)
        VALUES (?, ?, 'export', 'queued', ?, ?, ?, ?, ?)`)
        .run(jobId, input.project_id, fingerprint, canonicalizeJcs(snapshot), input.retry_of_job_id ?? null, timestamp, timestamp);
      db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, 'export_queued', ?, ?, ?, ?, 'EXPORT_QUEUED', '{}', ?)`)
        .run(`delivery_event_${uuid(dependencies)}`, input.project_id, jobId, locked.workflow_state, locked.workflow_state,
          input.artifact_id, fingerprint, timestamp);
      db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      throw error;
    }
    const job = getDeliveryJob(db, jobId);
    if (!job) throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Queued export Job could not be read.");
    return { ok: true, data: { reused: false, export: null, job: publicDeliveryJob(job) } };
  } catch (error) {
    return deliveryError(error);
  }
}

function exportSnapshotFromJob(job: DeliveryJobRow): WorkbenchExportSnapshot {
  try {
    const parsed = JSON.parse(job.input_json) as WorkbenchExportSnapshot;
    if (parsed.contract_version !== FINAL_EXPORT_CONTRACT_VERSION || parsed.project_id !== job.project_id
      || parsed.artifact_id.length === 0 || parsed.blob_sha256.length !== 64 || parsed.size_bytes <= 0
      || exportInputFingerprint(parsed) !== job.input_fingerprint) throw new Error("drift");
    exportFileLocation(parsed.relative_path, parsed.project_id);
    return parsed;
  } catch {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Stored export inputs failed integrity validation.");
  }
}

function cleanupRegularFile(filePath: string, parent: string): boolean {
  try {
    if (!existsSync(filePath)) return true;
    if (!isPathInside(filePath, parent) || hasExistingSymlinkAncestor(filePath, parent)
      || lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) return false;
    rmSync(filePath, { force: true });
    return !existsSync(filePath);
  } catch {
    return false;
  }
}

export function cleanupInterruptedWorkbenchExportJob(job: Pick<DeliveryJobRow, "project_id" | "input_json" | "input_fingerprint">, db: M0Database): boolean {
  try {
    const snapshot = JSON.parse(job.input_json) as WorkbenchExportSnapshot;
    if (snapshot.contract_version !== FINAL_EXPORT_CONTRACT_VERSION || snapshot.project_id !== job.project_id
      || exportInputFingerprint(snapshot) !== job.input_fingerprint) return false;
    const location = exportFileLocation(snapshot.relative_path, snapshot.project_id);
    let clean = cleanupRegularFile(location.part, location.directory);
    const registered = db.prepare("SELECT 1 AS registered FROM workbench_exports WHERE relative_path = ?").get(snapshot.relative_path);
    if (!registered && existsSync(location.final)) {
      let ownedFinal = false;
      try {
        const facts = fileFacts(location.final);
        ownedFinal = facts.sha256 === snapshot.blob_sha256 && facts.size_bytes === snapshot.size_bytes;
      } catch { /* unsafe or incomplete final output is retained for manual inspection */ }
      if (ownedFinal) clean = cleanupRegularFile(location.final, location.directory) && clean;
      else clean = false;
    }
    return clean;
  } catch {
    return false;
  }
}

function markExportJobFailed(db: M0Database, jobId: string, errorCode: string, dependencies: WorkbenchDeliveryDependencies): void {
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const job = getDeliveryJob(db, jobId);
    if (!job || job.job_type !== "export" || !new Set(["queued", "running"]).has(job.state)) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return;
    }
    const delivery = getWorkbenchDeliveryState(db, job.project_id);
    const state = delivery?.workflow_state ?? "";
    const timestamp = now(dependencies);
    db.prepare(`UPDATE workbench_delivery_jobs SET state = 'failed', error_code = ?, finished_at = ?, updated_at = ? WHERE job_id = ?`)
      .run(errorCode, timestamp, timestamp, jobId);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'export_failed', ?, ?, ?, ?, ?, '{}', ?)`)
      .run(`delivery_event_${uuid(dependencies)}`, job.project_id, jobId, state, state,
        (() => { try { return exportSnapshotFromJob(job).artifact_id; } catch { return null; } })(),
        job.input_fingerprint, errorCode, timestamp);
    db.exec("COMMIT");
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* retain original failure */ }
    }
  }
}

export async function runWorkbenchExportJob(
  jobId: string,
  db?: M0Database,
  dependencies: WorkbenchDeliveryDependencies = {}
): Promise<WorkbenchDeliveryResult<{ job: WorkbenchDeliveryJobRecord; export: WorkbenchExportRecord }>> {
  const connection = db ?? openM0Database();
  const ownsConnection = !db;
  let claimed = false;
  let finalOwned = false;
  let location: ReturnType<typeof exportFileLocation> | null = null;
  try {
    let claimOpen = false;
    try {
      connection.exec("BEGIN IMMEDIATE");
      claimOpen = true;
      const queued = getDeliveryJob(connection, jobId);
      if (!queued || queued.job_type !== "export" || queued.state !== "queued") {
        throw new DeliveryFailure("EXPORT_JOB_NOT_FOUND", "Queued export Job was not found.");
      }
      const timestamp = now(dependencies);
      connection.prepare("UPDATE workbench_delivery_jobs SET state = 'running', started_at = ?, updated_at = ? WHERE job_id = ?")
        .run(timestamp, timestamp, jobId);
      const state = getWorkbenchDeliveryState(connection, queued.project_id)?.workflow_state ?? "";
      const snapshot = exportSnapshotFromJob(queued);
      connection.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, 'export_started', ?, ?, ?, ?, 'EXPORT_STARTED', '{}', ?)`)
        .run(`delivery_event_${uuid(dependencies)}`, queued.project_id, jobId, state, state, snapshot.artifact_id, queued.input_fingerprint, timestamp);
      connection.exec("COMMIT");
      claimOpen = false;
      claimed = true;
    } catch (error) {
      if (claimOpen) {
        try { connection.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      throw error;
    }

    const job = getDeliveryJob(connection, jobId);
    if (!job) throw new DeliveryFailure("EXPORT_JOB_NOT_FOUND", "Export Job was not found after claim.");
    const snapshot = exportSnapshotFromJob(job);
    const { project, delivery } = projectForDelivery(connection, job.project_id);
    if (!new Set(["approved", "exported"]).has(delivery.workflow_state)
      || delivery.current_final_artifact_id !== snapshot.artifact_id || delivery.approved_artifact_id !== snapshot.artifact_id
      || project.exports.final_video_artifact_id !== snapshot.artifact_id) {
      throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Approved final Artifact changed before export execution.");
    }
    const artifact = validateActiveArtifactReference(connection, {
      artifact_id: snapshot.artifact_id,
      project_id: snapshot.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!artifact.ok || artifact.blob.sha256 !== snapshot.blob_sha256 || artifact.blob.size_bytes !== snapshot.size_bytes) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Approved final Artifact bytes changed before export.");
    }

    ensureSafeExportDirectory(snapshot.project_id);
    location = exportFileLocation(snapshot.relative_path, snapshot.project_id);
    if (existsSync(location.part) || existsSync(location.final) || hasExistingSymlinkAncestor(location.part, paths.exportsRoot)) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export output path is already occupied or unsafe.");
    }
    if (dependencies.before_export_copy) await dependencies.before_export_copy(location.part);
    copyFileSync(artifact.artifact.storage.uri, location.part, constants.COPYFILE_EXCL);
    if (dependencies.after_export_copy) await dependencies.after_export_copy(location.part);
    validateExportFile(location.part, snapshot, dependencies);
    linkSync(location.part, location.final);
    finalOwned = true;
    unlinkSync(location.part);
    validateExportFile(location.final, snapshot, dependencies);

    const exportId = `export_${uuid(dependencies)}`;
    const timestamp = now(dependencies);
    let finalizationOpen = false;
    try {
      connection.exec("BEGIN IMMEDIATE");
      finalizationOpen = true;
      const lockedJob = getDeliveryJob(connection, jobId);
      const locked = projectForDelivery(connection, snapshot.project_id);
      if (!lockedJob || lockedJob.state !== "running" || lockedJob.input_fingerprint !== exportInputFingerprint(snapshot)
        || !new Set(["approved", "exported"]).has(locked.delivery.workflow_state)
        || locked.delivery.current_final_artifact_id !== snapshot.artifact_id
        || locked.delivery.approved_artifact_id !== snapshot.artifact_id
        || locked.project.exports.final_video_artifact_id !== snapshot.artifact_id) {
        throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Delivery state changed before export finalization.");
      }
      const source = validateActiveArtifactReference(connection, {
        artifact_id: snapshot.artifact_id,
        project_id: snapshot.project_id,
        shot_id: "",
        role: "final_video",
        artifact_type: "video"
      });
      if (!source.ok || source.blob.sha256 !== snapshot.blob_sha256 || source.blob.size_bytes !== snapshot.size_bytes) {
        throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Final Artifact failed the export commit gate.");
      }
      validateExportFile(location.final, snapshot, dependencies);
      connection.prepare(`INSERT INTO workbench_exports
        (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(exportId, snapshot.project_id, snapshot.artifact_id, snapshot.relative_path, snapshot.blob_sha256, snapshot.size_bytes, timestamp);
      connection.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported', latest_export_id = ?,
        latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
        .run(exportId, timestamp, timestamp, snapshot.project_id);
      connection.prepare(`UPDATE workbench_delivery_jobs SET state = 'succeeded', export_id = ?,
        finished_at = ?, updated_at = ? WHERE job_id = ?`)
        .run(exportId, timestamp, timestamp, jobId);
      connection.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, export_id, input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, 'export_succeeded', ?, 'exported', ?, ?, ?, 'EXPORT_SUCCEEDED', ?, ?)`)
        .run(`delivery_event_${uuid(dependencies)}`, snapshot.project_id, jobId, locked.delivery.workflow_state,
          snapshot.artifact_id, exportId, job.input_fingerprint,
          canonicalizeJcs({ relative_path: snapshot.relative_path, sha256: snapshot.blob_sha256, size_bytes: snapshot.size_bytes }), timestamp);
      connection.exec("COMMIT");
      finalizationOpen = false;
    } catch (error) {
      if (finalizationOpen) {
        try { connection.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      throw error;
    }
    finalOwned = false;
    const completedJob = getDeliveryJob(connection, jobId);
    const completedExport = exportRecord(connection, snapshot.project_id, exportId);
    if (!completedJob || !completedExport) throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Completed export evidence could not be read.");
    return { ok: true, data: { job: publicDeliveryJob(completedJob), export: completedExport } };
  } catch (error) {
    const failure = error instanceof DeliveryFailure ? error : new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Local export did not complete.");
    if (claimed) markExportJobFailed(connection, jobId, failure.code, dependencies);
    if (location) {
      cleanupRegularFile(location.part, location.directory);
      if (finalOwned) cleanupRegularFile(location.final, location.directory);
    }
    return deliveryError(failure);
  } finally {
    if (ownsConnection) connection.close();
  }
}

const startedExportJobs = new Set<string>();

export function startWorkbenchExportJob(jobId: string, dependencies: WorkbenchDeliveryDependencies = {}): void {
  if (startedExportJobs.has(jobId)) return;
  startedExportJobs.add(jobId);
  setImmediate(() => {
    void runWorkbenchExportJob(jobId, undefined, dependencies)
      .finally(() => startedExportJobs.delete(jobId));
  });
}

export function resolveWorkbenchExportDownload(
  projectId: string,
  exportId: string,
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{ absolute_path: string; filename: string; size_bytes: number; export: WorkbenchExportRecord }> {
  try {
    const record = exportRecord(db, projectId, exportId);
    if (!record) throw new DeliveryFailure("EXPORT_NOT_FOUND", "Export was not found.");
    if (!exportRecordIsReusable(db, record, dependencies)) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export file no longer matches its immutable record.");
    }
    const location = exportFileLocation(record.relative_path, projectId);
    return { ok: true, data: { absolute_path: location.final, filename: basename(location.final), size_bytes: record.size_bytes, export: record } };
  } catch (error) {
    return deliveryError(error);
  }
}

export function closeoutWorkbenchDelivery(
  input: { project_id: string; confirmation_phrase: string },
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{ delivery: WorkbenchDeliveryStateRecord; receipt: WorkbenchCloseoutReceipt }> {
  if (input.confirmation_phrase !== CLOSEOUT_CONFIRMATION_PHRASE) {
    return { ok: false, error: { code: "CLOSEOUT_CONFIRMATION_REQUIRED", message: `Type ${CLOSEOUT_CONFIRMATION_PHRASE} exactly to close the project.`, field: "confirmation_phrase" } };
  }
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const { project, delivery } = projectForDelivery(db, input.project_id);
    if (getActiveWorkbenchDeliveryJob(db)) throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "Closeout requires no active delivery Job.");
    if (delivery.workflow_state !== "exported" || !delivery.current_final_artifact_id
      || delivery.approved_artifact_id !== delivery.current_final_artifact_id || !delivery.latest_export_id
      || project.exports.final_video_artifact_id !== delivery.current_final_artifact_id) {
      throw new DeliveryFailure("CLOSEOUT_EXPORT_MISMATCH", "Closeout requires the current approved Artifact and its matching export.");
    }
    const exported = exportRecord(db, input.project_id, delivery.latest_export_id);
    if (!exported || exported.artifact_id !== delivery.current_final_artifact_id || !exportRecordIsReusable(db, exported, dependencies)) {
      throw new DeliveryFailure("CLOSEOUT_EXPORT_MISMATCH", "Latest export does not match the current approved Artifact.");
    }
    const timestamp = now(dependencies);
    const eventId = `delivery_event_${uuid(dependencies)}`;
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'closed', closed_at = ?, updated_at = ? WHERE project_id = ?`)
      .run(timestamp, timestamp, input.project_id);
    project.status = "final_approved";
    saveProject(db, project);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES (?, ?, 'closeout', 'exported', 'closed', ?, ?, 'CLOSEOUT_CONFIRMED', '{"confirmation":"exact_phrase"}', ?)`)
      .run(eventId, input.project_id, delivery.current_final_artifact_id, exported.export_id, timestamp);
    db.exec("COMMIT");
    transactionOpen = false;
    const updated = getWorkbenchDeliveryState(db, input.project_id);
    if (!updated) throw new DeliveryFailure("DELIVERY_STATE_MISSING", "Closed delivery state is unavailable.");
    return {
      ok: true,
      data: {
        delivery: updated,
        receipt: {
          event_id: eventId,
          project_id: input.project_id,
          artifact_id: delivery.current_final_artifact_id,
          export_id: exported.export_id,
          reason_code: "CLOSEOUT_CONFIRMED",
          created_at: timestamp
        }
      }
    };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    }
    return deliveryError(error);
  }
}
