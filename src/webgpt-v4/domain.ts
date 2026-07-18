import { randomUUID } from "node:crypto";

import type { M0Database } from "../storage/sqlite.js";
import { ArtifactStructuredDriftError, validateAcceptedClipReference, validateActiveArtifactReference, type ArtifactRole, type ArtifactType, type MediaArtifact } from "../tools/mediaArtifacts.js";
import { listProjectShots, type Project, type Shot } from "../tools/projects.js";
import { OperationalStateIntegrityError } from "../tools/operationalStateFacts.js";
import { getWorkbenchProjectSummary, getWorkbenchProjectWorkspace } from "../tools/workbenchV2.js";
import { appendWorkbenchInboxEvent, getWorkbenchDraftRecord, saveWorkbenchDraftRecord, type WorkbenchDraftRecord } from "../tools/workbenchInboxStore.js";
import { buildProviderCapabilityKey, buildProviderPriceCacheKey, providerCapabilityErrorMessage, RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY } from "../tools/providerCapabilities.js";
import { parseProductionProposalPayload } from "./proposals.js";
import {
  errorBody,
  fail,
  ok,
  requestId,
  sha256,
  WEBGPT_V4_VERSION,
  WebGptV4Error,
  type WebGptV4Actor,
  type WebGptV4Result
} from "./types.js";

export type ProductionProposalKind =
  | "storyboard_package"
  | "review_decision"
  | "regeneration"
  | "final_assembly"
  | "memory_saveback"
  | "package_freeze";

export interface MutationContext {
  actor: WebGptV4Actor;
  request_id?: string;
  idempotency_key: string;
}

interface ProjectRow {
  project_id: string;
  data_json: string;
  updated_at: string;
  classification: string;
  lifecycle: string;
}

interface MutationOutcome<T> {
  data: T;
  project_id: string;
  object_type: string;
  object_id: string;
  changed_fields: string[];
  before_hash?: string;
  after_hash?: string;
  updated_at: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function dataIntegrityViolation(field: string): never {
  throw new WebGptV4Error(
    "WEBGPT_V4_DATA_INTEGRITY_VIOLATION",
    "Stored production data does not match its project binding.",
    field
  );
}

function domainErrorBody(error: unknown) {
  if (error instanceof ArtifactStructuredDriftError || error instanceof OperationalStateIntegrityError) {
    return {
      code: "WEBGPT_V4_DATA_INTEGRITY_VIOLATION",
      message: "Stored production data does not match its Artifact binding.",
      field: "artifact_id"
    };
  }
  return errorBody(error);
}

function parseBoundJson<T>(value: string, field: string): T {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return dataIntegrityViolation(field);
    return parsed as T;
  } catch {
    return dataIntegrityViolation(field);
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function assertBoundProjectObject(value: unknown, projectId: string): void {
  const item = recordValue(value);
  if (!item || item.project_id !== projectId) dataIntegrityViolation("project_id");
}

function assertBoundArtifactObject(
  value: unknown,
  projectId: string,
  expectedArtifactId: string,
  db: M0Database,
  expectedShotId?: string
): void {
  const item = recordValue(value);
  const links = recordValue(item?.linked_objects);
  const artifact = requireArtifact(db, projectId, expectedArtifactId);
  if (!item || item.artifact_id !== artifact.artifact_id || !links
    || links.project_id !== artifact.linked_objects.project_id || links.shot_id !== artifact.linked_objects.shot_id
    || item.role !== artifact.role || item.artifact_type !== artifact.artifact_type || item.status !== artifact.status
    || (expectedShotId !== undefined && artifact.linked_objects.shot_id !== expectedShotId)) {
    dataIntegrityViolation("artifact_id");
  }
}

function assertWorkspaceBindings(value: unknown, projectId: string, db: M0Database): void {
  const workspace = recordValue(value);
  if (!workspace) dataIntegrityViolation("project_id");
  assertBoundProjectObject(workspace.project, projectId);
  if (workspace.meta !== undefined) assertBoundProjectObject(workspace.meta, projectId);

  const artifactShotBindings = new Map<string, Set<string>>();
  const bindArtifactToShot = (artifactId: unknown, shotId: string): void => {
    if (typeof artifactId !== "string" || !artifactId) return;
    const shotIds = artifactShotBindings.get(artifactId) ?? new Set<string>();
    shotIds.add(shotId);
    artifactShotBindings.set(artifactId, shotIds);
  };
  for (const shotValue of Array.isArray(workspace.shots) ? workspace.shots : []) {
    assertBoundProjectObject(shotValue, projectId);
    const shot = recordValue(shotValue);
    if (typeof shot?.shot_id !== "string") dataIntegrityViolation("shot_id");
    bindArtifactToShot(shot.storyboard_image_artifact_id, shot.shot_id);
    bindArtifactToShot(shot.accepted_clip_artifact_id, shot.shot_id);
    for (const versionValue of Array.isArray(shot.clip_versions) ? shot.clip_versions : []) {
      bindArtifactToShot(recordValue(versionValue)?.artifact_id, shot.shot_id);
    }
  }
  for (const stackValue of Array.isArray(workspace.version_stacks) ? workspace.version_stacks : []) {
    const stack = recordValue(stackValue);
    if (!stack) dataIntegrityViolation("shot_id");
    assertBoundProjectObject(stack.shot, projectId);
    const stackShot = recordValue(stack.shot);
    if (typeof stackShot?.shot_id !== "string") dataIntegrityViolation("shot_id");
    for (const versionValue of Array.isArray(stack.versions) ? stack.versions : []) {
      const version = recordValue(versionValue);
      if (version?.artifact) {
        if (typeof version.artifact_id !== "string") dataIntegrityViolation("artifact_id");
        assertBoundArtifactObject(version.artifact, projectId, version.artifact_id, db, stackShot.shot_id);
      }
    }
  }
  for (const noteValue of Array.isArray(workspace.review_notes) ? workspace.review_notes : []) {
    assertBoundProjectObject(noteValue, projectId);
    const note = recordValue(noteValue);
    if (!note || typeof note.shot_id !== "string") dataIntegrityViolation("shot_id");
    const shot = requireShot(db, projectId, note.shot_id).shot;
    if (typeof note.artifact_id === "string" && note.artifact_id) {
      if (!shot.clip_versions.some((version) => version.artifact_id === note.artifact_id)) dataIntegrityViolation("artifact_id");
      const validated = validateActiveArtifactReference(db, {
        artifact_id: note.artifact_id, project_id: projectId, shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video"
      });
      if (!validated.ok) throw new WebGptV4Error(validated.error.code, validated.error.message, "artifact_id");
    }
  }
  for (const [artifactId, artifact] of Object.entries(recordValue(workspace.artifacts) ?? {})) {
    if (artifact) {
      const expectedShotIds = artifactShotBindings.get(artifactId);
      if (!expectedShotIds || expectedShotIds.size !== 1) dataIntegrityViolation("artifact_id");
      const expectedShotId = expectedShotIds.values().next().value;
      if (typeof expectedShotId !== "string") dataIntegrityViolation("shot_id");
      assertBoundArtifactObject(artifact, projectId, artifactId, db, expectedShotId);
    }
  }
  for (const clipValue of Array.isArray(workspace.accepted_clips) ? workspace.accepted_clips : []) {
    const clip = recordValue(clipValue);
    if (clip?.artifact) {
      if (typeof clip.shot_id !== "string") dataIntegrityViolation("shot_id");
      const expectedArtifactId = requireShot(db, projectId, clip.shot_id).shot.accepted_clip_artifact_id;
      if (!expectedArtifactId) dataIntegrityViolation("artifact_id");
      assertBoundArtifactObject(clip.artifact, projectId, expectedArtifactId, db, clip.shot_id);
    }
  }
  if (workspace.final_artifact) {
    const project = recordValue(workspace.project);
    const exports = recordValue(project?.exports);
    const expectedArtifactId = exports?.final_video_artifact_id;
    if (typeof expectedArtifactId !== "string" || !expectedArtifactId) dataIntegrityViolation("artifact_id");
    assertBoundArtifactObject(workspace.final_artifact, projectId, expectedArtifactId, db);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function requestHash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function plainId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.length > 200) {
    throw new WebGptV4Error("INVALID_APP_ID", `${field} must be a valid application id.`, field);
  }
  return normalized;
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.trunc(value as number))) : fallback;
}

function projectRow(db: M0Database, projectId: string, write = false): ProjectRow {
  const id = plainId(projectId, "project_id");
  const row = db.prepare(`
    SELECT p.project_id, p.data_json, p.updated_at, m.classification, m.lifecycle
    FROM projects p JOIN workbench_project_meta m ON m.project_id = p.project_id
    WHERE p.project_id = ? AND m.classification = 'production'
  `).get(id) as ProjectRow | undefined;
  if (!row) throw new WebGptV4Error("PROJECT_NOT_FOUND", "Production project was not found.", "project_id");
  const project = parseBoundJson<Project>(row.data_json, "project_id");
  if (project.project_id !== row.project_id) dataIntegrityViolation("project_id");
  if (write && row.lifecycle !== "active") throw new WebGptV4Error("PROJECT_ARCHIVED", "Archived production projects are read-only.", "project_id");
  return row;
}

function requireShot(db: M0Database, projectId: string, shotId: string): { shot: Shot; updated_at: string } {
  const id = plainId(shotId, "shot_id");
  const row = db.prepare("SELECT shot_id, project_id, data_json, updated_at FROM shots WHERE shot_id = ? AND project_id = ?")
    .get(id, projectId) as { shot_id: string; project_id: string; data_json: string; updated_at: string } | undefined;
  if (!row) throw new WebGptV4Error("SHOT_NOT_FOUND", "SHOT was not found in the production project.", "shot_id");
  const shot = parseBoundJson<Shot>(row.data_json, "shot_id");
  if (shot.shot_id !== row.shot_id || shot.project_id !== row.project_id) dataIntegrityViolation("shot_id");
  return { shot, updated_at: row.updated_at };
}

function requireArtifact(
  db: M0Database,
  projectId: string,
  artifactId: string,
  requireActive = false,
  expected?: { shot_id: string; role: ArtifactRole; artifact_type: ArtifactType }
): MediaArtifact {
  const id = plainId(artifactId, "artifact_id");
  const row = db.prepare(`
    SELECT artifact_id, project_id, shot_id, role, artifact_type, status, data_json
    FROM media_artifacts WHERE artifact_id = ? AND project_id = ?
  `).get(id, projectId) as {
    artifact_id: string; project_id: string; shot_id: string | null; role: string; artifact_type: string; status: string; data_json: string;
  } | undefined;
  if (!row || !["storyboard_image", "generated_clip", "final_video"].includes(row.role)) {
    throw new WebGptV4Error("ARTIFACT_NOT_FOUND", "Production media artifact was not found.", "artifact_id");
  }
  const artifact = parseBoundJson<MediaArtifact>(row.data_json, "artifact_id");
  if (artifact.artifact_id !== row.artifact_id
    || artifact.linked_objects?.project_id !== row.project_id
    || artifact.linked_objects?.shot_id !== (row.shot_id ?? "")
    || artifact.role !== row.role || artifact.artifact_type !== row.artifact_type || artifact.status !== row.status) {
    dataIntegrityViolation("artifact_id");
  }
  if (requireActive) {
    const validated = validateActiveArtifactReference(db, {
      artifact_id: artifact.artifact_id,
      project_id: projectId,
      shot_id: expected?.shot_id ?? artifact.linked_objects.shot_id,
      role: expected?.role ?? artifact.role,
      artifact_type: expected?.artifact_type ?? artifact.artifact_type
    });
    if (!validated.ok) throw new WebGptV4Error(validated.error.code, validated.error.message, "artifact_id");
  }
  return artifact;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["uri", "path", "local_path", "storage_directory", "signed_url", "provider_payload", "author_hash", "actor_hash"].includes(key)) continue;
    result[key] = sanitize(item);
  }
  return result;
}

export function publicArtifact(artifact: MediaArtifact): Record<string, unknown> {
  return {
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.artifact_type,
    role: artifact.role,
    status: artifact.status,
    filename: artifact.storage.filename,
    mime_type: artifact.storage.mime_type,
    metadata: artifact.metadata,
    linked_objects: artifact.linked_objects,
    provenance: {
      kind: artifact.source.kind,
      provider: artifact.source.provider,
      sha256: artifact.source.sha256 || artifact.metadata.sha256
    }
  };
}

function successfulReplay<T>(db: M0Database, tool: string, row: { project_id: string; object_id: string }, id: string): WebGptV4Result<T> {
  const meta = { request_id: id, source_version: WEBGPT_V4_VERSION, updated_at: new Date().toISOString(), idempotent_replay: true } as const;
  if (tool === "update_shot_copy") {
    const current = requireShot(db, row.project_id, row.object_id);
    return { ok: true, data: { shot: current.shot, updated_at: current.updated_at } as T, meta };
  }
  if (tool === "add_review_note") {
    const note = db.prepare("SELECT note_id, project_id, shot_id, artifact_id, note, source, created_at, updated_at FROM workbench_review_notes WHERE note_id = ? AND project_id = ?")
      .get(row.object_id, row.project_id) as Record<string, unknown> | undefined;
    if (note) return { ok: true, data: note as T, meta };
  }
  if (["submit_production_proposal", "revise_production_proposal", "close_production_proposal"].includes(tool)) {
    const draft = getWorkbenchDraftRecord(row.object_id, db);
    if (draft) {
      const data = tool === "revise_production_proposal" ? { draft, closed_draft_id: draft.parent_draft_id ?? "" } : { draft };
      return { ok: true, data: data as T, meta };
    }
  }
  if (tool === "prepare_generation_intent") {
    const intent = db.prepare(`
      SELECT intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
             estimated_cost_value, budget_limit_value, currency, confirmed, status, expires_at
      FROM generation_intents WHERE intent_id = ? AND project_id = ?
    `).get(row.object_id, row.project_id) as Record<string, unknown> | undefined;
    if (intent) return { ok: true, data: { ...intent, confirmed: Number(intent.confirmed) === 1, requires_human_preflight: true, provider_call_attempted: false } as T, meta };
  }
  return fail(id, { code: "AUDIT_REPLAY_UNAVAILABLE", message: "The prior result object is no longer available." });
}

function replay<T>(db: M0Database, tool: string, idempotencyKey: string, hash: string, id: string): WebGptV4Result<T> | null {
  if (!idempotencyKey) return null;
  const row = db.prepare("SELECT request_hash, result, result_json, project_id, object_id FROM webgpt_audit_events WHERE tool = ? AND idempotency_key = ?")
    .get(tool, idempotencyKey) as { request_hash: string; result: string; result_json: string; project_id: string; object_id: string } | undefined;
  if (!row) return null;
  if (row.request_hash !== hash) return fail(id, { code: "IDEMPOTENCY_CONFLICT", message: "The idempotency key was already used with different input.", field: "idempotency_key" });
  if (row.result === "succeeded") return successfulReplay<T>(db, tool, row, id);
  const stored = parseJson<WebGptV4Result<T>>(row.result_json, fail(id, { code: "AUDIT_REPLAY_UNAVAILABLE", message: "The prior result could not be restored." }));
  return { ...stored, meta: { ...stored.meta, request_id: id, idempotent_replay: true } };
}

function audit(db: M0Database, input: {
  request_id: string;
  idempotency_key: string;
  request_hash: string;
  actor_hash: string;
  tool: string;
  project_id?: string;
  object_type?: string;
  object_id?: string;
  changed_fields?: string[];
  before_hash?: string;
  after_hash?: string;
  result: WebGptV4Result<unknown>;
}): void {
  db.prepare(`
    INSERT INTO webgpt_audit_events (
      event_id, request_id, idempotency_key, request_hash, actor_hash, tool,
      project_id, object_type, object_id, changed_fields_json, before_hash, after_hash,
      result, error_code, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `webgpt_audit_${randomUUID()}`, input.request_id, input.idempotency_key, input.request_hash,
    input.actor_hash, input.tool, input.project_id ?? "", input.object_type ?? "", input.object_id ?? "",
    JSON.stringify(input.changed_fields ?? []), input.before_hash ?? "", input.after_hash ?? "",
    input.result.ok ? "succeeded" : "failed", input.result.ok ? "" : input.result.error.code,
    JSON.stringify(input.result.ok ? { ok: true, meta: input.result.meta } : input.result), new Date().toISOString()
  );
}

function mutation<T>(db: M0Database, tool: string, context: MutationContext, input: unknown, operation: () => MutationOutcome<T>): WebGptV4Result<T> {
  const id = requestId(context.request_id);
  const key = context.idempotency_key.trim();
  if (!key || key.length > 200) return fail(id, { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid idempotency key is required.", field: "idempotency_key" });
  const hash = requestHash(input);
  const prior = replay<T>(db, tool, key, hash, id);
  if (prior) return prior;
  db.exec("BEGIN IMMEDIATE");
  try {
    const outcome = operation();
    const result = ok(id, outcome.data, outcome.updated_at);
    audit(db, {
      request_id: id,
      idempotency_key: key,
      request_hash: hash,
      actor_hash: context.actor.actor_hash,
      tool,
      project_id: outcome.project_id,
      object_type: outcome.object_type,
      object_id: outcome.object_id,
      changed_fields: outcome.changed_fields,
      before_hash: outcome.before_hash,
      after_hash: outcome.after_hash,
      result
    });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    const result = fail<T>(id, domainErrorBody(error));
    try {
      audit(db, { request_id: id, idempotency_key: key, request_hash: hash, actor_hash: context.actor.actor_hash, tool, result });
    } catch {
      // A concurrent use of the same key is resolved by the next replay attempt.
    }
    return result;
  }
}

export function listProductionProjects(
  input: { query?: string; include_archived?: boolean; limit?: number; offset?: number } = {},
  db: M0Database,
  idValue?: string,
  authorizedProjectIds?: readonly string[]
): WebGptV4Result<{ items: Record<string, unknown>[]; page: { limit: number; offset: number; total: number; has_more: boolean; next_offset: number | null } }> {
  const id = requestId(idValue);
  const limit = clamp(input.limit, 25, 100);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const query = input.query?.trim() ?? "";
  const clauses = ["m.classification = 'production'"];
  const values: unknown[] = [];
  if (authorizedProjectIds) {
    if (authorizedProjectIds.length === 0) clauses.push("1 = 0");
    else {
      clauses.push(`p.project_id IN (${authorizedProjectIds.map(() => "?").join(",")})`);
      values.push(...authorizedProjectIds);
    }
  }
  if (!input.include_archived) clauses.push("m.lifecycle = 'active'");
  if (query) {
    clauses.push("(p.project_id LIKE ? OR json_extract(p.data_json, '$.title') LIKE ?)");
    values.push(`%${query}%`, `%${query}%`);
  }
  const where = clauses.join(" AND ");
  const total = Number((db.prepare(`SELECT COUNT(*) count FROM projects p JOIN workbench_project_meta m ON m.project_id = p.project_id WHERE ${where}`).get(...values) as { count: number }).count);
  const rows = db.prepare(`
    SELECT p.project_id, p.data_json, p.updated_at, m.lifecycle, m.pinned, m.last_opened_at
    FROM projects p JOIN workbench_project_meta m ON m.project_id = p.project_id
    WHERE ${where}
    ORDER BY m.pinned DESC, p.updated_at DESC, p.project_id DESC LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as Array<{ project_id: string; data_json: string; updated_at: string; lifecycle: string; pinned: number; last_opened_at: string | null }>;
  const items = rows.map((row) => {
    const project = parseBoundJson<Project>(row.data_json, "project_id");
    if (project.project_id !== row.project_id) dataIntegrityViolation("project_id");
    project.shot_ids = listProjectShots(db, row.project_id).map((shot) => shot.shot_id);
    const summary = getWorkbenchProjectSummary(row.project_id, db);
    return sanitize({ project, lifecycle: row.lifecycle, pinned: row.pinned === 1, last_opened_at: row.last_opened_at, updated_at: row.updated_at, summary }) as Record<string, unknown>;
  });
  const hasMore = offset + items.length < total;
  return ok(id, { items, page: { limit, offset, total, has_more: hasMore, next_offset: hasMore ? offset + limit : null } });
}

export function getProductionProjectContext(
  input: { project_id: string; workspace?: "overview" | "storyboard" | "generation" | "review" | "delivery" },
  db: M0Database,
  idValue?: string
): WebGptV4Result<Record<string, unknown>> {
  const id = requestId(idValue);
  try {
    projectRow(db, input.project_id);
    const result = getWorkbenchProjectWorkspace(input.project_id, input.workspace ?? "overview", db, { touch_last_opened: false });
    if (!result.ok) throw new WebGptV4Error(result.error.code, result.error.message, result.error.field);
    assertWorkspaceBindings(result.data, input.project_id, db);
    return ok(id, sanitize(result.data) as Record<string, unknown>);
  } catch (error) {
    return fail(id, domainErrorBody(error));
  }
}

export function listProductionProjectShots(input: { project_id: string; limit?: number; offset?: number }, db: M0Database, idValue?: string): WebGptV4Result<Record<string, unknown>> {
  const id = requestId(idValue);
  try {
    projectRow(db, input.project_id);
    const limit = clamp(input.limit, 50, 100);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const total = Number((db.prepare("SELECT COUNT(*) count FROM shots WHERE project_id = ?").get(input.project_id) as { count: number }).count);
    const rows = db.prepare("SELECT shot_id, project_id, data_json, updated_at FROM shots WHERE project_id = ? ORDER BY json_extract(data_json, '$.order'), shot_id LIMIT ? OFFSET ?")
      .all(input.project_id, limit, offset) as Array<{ shot_id: string; project_id: string; data_json: string; updated_at: string }>;
    const items = rows.map((row) => {
      const shot = parseBoundJson<Shot>(row.data_json, "shot_id");
      if (shot.shot_id !== row.shot_id || shot.project_id !== row.project_id) dataIntegrityViolation("shot_id");
      return { ...shot, updated_at: row.updated_at };
    });
    const hasMore = offset + items.length < total;
    return ok(id, { items, page: { limit, offset, total, has_more: hasMore, next_offset: hasMore ? offset + limit : null } });
  } catch (error) {
    return fail(id, domainErrorBody(error));
  }
}

export function listProductionProjectMedia(
  input: { project_id: string; shot_id?: string; role?: string; type?: string; status?: string; limit?: number; offset?: number },
  db: M0Database,
  idValue?: string
): WebGptV4Result<Record<string, unknown>> {
  const id = requestId(idValue);
  try {
    projectRow(db, input.project_id);
    const clauses = ["project_id = ?", "role IN ('storyboard_image', 'generated_clip', 'final_video')"];
    const values: unknown[] = [input.project_id];
    if (input.shot_id) { clauses.push("shot_id = ?"); values.push(plainId(input.shot_id, "shot_id")); }
    if (input.role) { clauses.push("role = ?"); values.push(input.role); }
    if (input.type) { clauses.push("artifact_type = ?"); values.push(input.type); }
    if (input.status) { clauses.push("status = ?"); values.push(input.status); }
    const where = clauses.join(" AND ");
    const limit = clamp(input.limit, 50, 100);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const total = Number((db.prepare(`SELECT COUNT(*) count FROM media_artifacts WHERE ${where}`).get(...values) as { count: number }).count);
    const rows = db.prepare(`SELECT artifact_id, updated_at FROM media_artifacts WHERE ${where} ORDER BY updated_at DESC, artifact_id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as Array<{ artifact_id: string; updated_at: string }>;
    const items = rows.map((row) => ({ ...publicArtifact(requireArtifact(db, input.project_id, row.artifact_id)), updated_at: row.updated_at }));
    const hasMore = offset + items.length < total;
    return ok(id, { items, page: { limit, offset, total, has_more: hasMore, next_offset: hasMore ? offset + limit : null } });
  } catch (error) {
    return fail(id, domainErrorBody(error));
  }
}

export function getProductionReviewPackage(input: { project_id: string; shot_id: string; artifact_id?: string; notes_limit?: number }, db: M0Database, idValue?: string): WebGptV4Result<Record<string, unknown>> {
  const id = requestId(idValue);
  try {
    projectRow(db, input.project_id);
    const { shot } = requireShot(db, input.project_id, input.shot_id);
    if (input.artifact_id) {
      if (!shot.clip_versions.some((version) => version.artifact_id === input.artifact_id)) throw new WebGptV4Error("ARTIFACT_NOT_IN_SHOT_REVIEW", "Artifact is not a version of the requested SHOT.", "artifact_id");
      requireArtifact(db, input.project_id, input.artifact_id, true, { shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video" });
    }
    const notesLimit = clamp(input.notes_limit, 10, 50);
    const notesTotal = Number((db.prepare("SELECT COUNT(*) count FROM workbench_review_notes WHERE project_id = ? AND shot_id = ?")
      .get(input.project_id, shot.shot_id) as { count: number }).count);
    const notes = db.prepare("SELECT note_id, artifact_id, note, source, created_at, updated_at FROM workbench_review_notes WHERE project_id = ? AND shot_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(input.project_id, shot.shot_id, notesLimit) as Array<Record<string, unknown>>;
    for (const note of notes) {
      if (typeof note.artifact_id === "string" && note.artifact_id) requireArtifact(db, input.project_id, note.artifact_id, true, { shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video" });
    }
    const versions = shot.clip_versions.map((version) => ({ ...version, artifact: publicArtifact(requireArtifact(db, input.project_id, version.artifact_id, true, { shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video" })) }));
    return ok(id, { shot, versions, notes, notes_total: notesTotal, selected_artifact_id: input.artifact_id ?? shot.accepted_clip_artifact_id ?? "" });
  } catch (error) {
    return fail(id, domainErrorBody(error));
  }
}

export function getProductionDeliveryStatus(input: { project_id: string }, db: M0Database, idValue?: string): WebGptV4Result<Record<string, unknown>> {
  const id = requestId(idValue);
  try {
    const row = projectRow(db, input.project_id);
    const project = parseBoundJson<Project>(row.data_json, "project_id");
    if (project.project_id !== row.project_id) dataIntegrityViolation("project_id");
    const shots = listProjectShots(db, input.project_id);
    for (const shot of shots) {
      if (shot.project_id !== input.project_id) dataIntegrityViolation("shot_id");
    }
    const accepted = shots.map((shot) => {
      if (!shot.accepted_clip_artifact_id) return { artifact: null, check: { shot_id: shot.shot_id, artifact_id: "", ok: false, reason_code: "SHOT_ACCEPTED_CLIP_MISSING" } };
      const validated = validateAcceptedClipReference(db, shot);
      return validated.ok
        ? { artifact: validated.artifact, check: { shot_id: shot.shot_id, artifact_id: shot.accepted_clip_artifact_id, ok: true, reason_code: "SHOT_ACCEPTED_CLIP_READY" } }
        : { artifact: null, check: { shot_id: shot.shot_id, artifact_id: shot.accepted_clip_artifact_id, ok: false, reason_code: validated.error.code } };
    });
    const finalValidated = project.exports.final_video_artifact_id
      ? validateActiveArtifactReference(db, { artifact_id: project.exports.final_video_artifact_id, project_id: input.project_id, shot_id: "", role: "final_video", artifact_type: "video" })
      : null;
    const finalArtifact = finalValidated?.ok ? publicArtifact(finalValidated.artifact) : null;
    return ok(id, {
      project_id: project.project_id,
      project_status: project.status,
      shots_total: shots.length,
      shots_accepted: accepted.filter((item) => item.artifact !== null).length,
      ready_for_assembly: shots.length > 0 && accepted.every((item) => item.check.ok),
      readiness_checks: accepted.map((item) => item.check),
      final_artifact: finalArtifact,
      final_artifact_reason_code: finalValidated && !finalValidated.ok ? finalValidated.error.code : "",
      delivered: project.status === "final_approved" && Boolean(finalArtifact)
    });
  } catch (error) {
    return fail(id, domainErrorBody(error));
  }
}

export function getProductionCloseoutEvidence(input: { project_id: string }, db: M0Database, idValue?: string): WebGptV4Result<Record<string, unknown>> {
  const delivery = getProductionDeliveryStatus(input, db, idValue);
  if (!delivery.ok) return delivery;
  const auditCount = Number((db.prepare("SELECT COUNT(*) count FROM webgpt_audit_events WHERE project_id = ?").get(input.project_id) as { count: number }).count);
  return { ...delivery, data: { ...delivery.data, evidence: { source: "sqlite_structured_summary", webgpt_audit_events: auditCount, raw_reports_exposed: false } } };
}

export function updateProductionShotCopy(
  input: { project_id: string; shot_id: string; expected_updated_at: string; description?: string; video_prompt?: string; negative_prompt?: string; duration_seconds?: number },
  context: MutationContext,
  db: M0Database
): WebGptV4Result<{ shot: Shot; updated_at: string }> {
  return mutation(db, "update_shot_copy", context, input, () => {
    projectRow(db, input.project_id, true);
    const current = requireShot(db, input.project_id, input.shot_id);
    if (!input.expected_updated_at || current.updated_at !== input.expected_updated_at) {
      throw new WebGptV4Error("CONFLICT_STALE_VERSION", "SHOT changed after it was read. Reload before writing.", "expected_updated_at");
    }
    const next = structuredClone(current.shot);
    const changed: string[] = [];
    const setText = (field: "description" | "video_prompt" | "negative_prompt", value: string | undefined, maximum: number): void => {
      if (value === undefined) return;
      if (value.length > maximum) throw new WebGptV4Error("INVALID_FIELD", `${field} exceeds ${maximum} characters.`, field);
      if (next[field] !== value) { next[field] = value; changed.push(field); }
    };
    setText("description", input.description, 2000);
    setText("video_prompt", input.video_prompt, 8000);
    setText("negative_prompt", input.negative_prompt, 4000);
    if (input.duration_seconds !== undefined) {
      if (!Number.isInteger(input.duration_seconds) || input.duration_seconds < 1 || input.duration_seconds > 60) {
        throw new WebGptV4Error("INVALID_FIELD", "duration_seconds must be an integer from 1 to 60.", "duration_seconds");
      }
      if (next.duration_seconds !== input.duration_seconds) { next.duration_seconds = input.duration_seconds; changed.push("duration_seconds"); }
    }
    if (changed.length === 0) throw new WebGptV4Error("NO_CHANGES", "No SHOT copy fields changed.");
    const updatedAt = new Date().toISOString();
    const beforeHash = requestHash(current.shot);
    const afterHash = requestHash(next);
    db.prepare("UPDATE shots SET data_json = ?, updated_at = ? WHERE shot_id = ? AND project_id = ?")
      .run(JSON.stringify(next), updatedAt, next.shot_id, next.project_id);
    return { data: { shot: next, updated_at: updatedAt }, project_id: input.project_id, object_type: "shot", object_id: next.shot_id, changed_fields: changed, before_hash: beforeHash, after_hash: afterHash, updated_at: updatedAt };
  });
}

export function addProductionReviewNote(
  input: { project_id: string; shot_id: string; artifact_id?: string; note: string },
  context: MutationContext,
  db: M0Database
): WebGptV4Result<Record<string, unknown>> {
  return mutation(db, "add_review_note", context, input, () => {
    projectRow(db, input.project_id, true);
    const { shot } = requireShot(db, input.project_id, input.shot_id);
    if (input.artifact_id) {
      if (!shot.clip_versions.some((version) => version.artifact_id === input.artifact_id)) throw new WebGptV4Error("ARTIFACT_NOT_IN_SHOT_REVIEW", "Artifact is not a version of the requested SHOT.", "artifact_id");
      requireArtifact(db, input.project_id, input.artifact_id, true, { shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video" });
    }
    const note = input.note.trim();
    if (!note || note.length > 2000) throw new WebGptV4Error("INVALID_FIELD", "Review note must contain 1 to 2000 characters.", "note");
    const now = new Date().toISOString();
    const noteId = `review_note_${randomUUID()}`;
    db.prepare(`INSERT INTO workbench_review_notes (note_id, project_id, shot_id, artifact_id, author_hash, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'webgpt_v4', ?, ?)`)
      .run(noteId, input.project_id, shot.shot_id, input.artifact_id ?? "", context.actor.actor_hash, note, now, now);
    const data = { note_id: noteId, project_id: input.project_id, shot_id: shot.shot_id, artifact_id: input.artifact_id ?? "", note, source: "webgpt_v4", created_at: now, updated_at: now };
    return { data, project_id: input.project_id, object_type: "review_note", object_id: noteId, changed_fields: ["note"], after_hash: requestHash(data), updated_at: now };
  });
}

function validateProposal(kind: ProductionProposalKind, projectId: string, payload: Record<string, unknown>, db: M0Database): { shot_id: string; artifact_id: string } {
  const shotId = typeof payload.shot_id === "string" ? payload.shot_id : "";
  const artifactId = typeof payload.artifact_id === "string" ? payload.artifact_id : "";
  if (["review_decision", "regeneration"].includes(kind)) {
    if (!shotId) throw new WebGptV4Error("MISSING_REQUIRED_FIELD", "shot_id is required for this proposal.", "shot_id");
    const { shot } = requireShot(db, projectId, shotId);
    if (!artifactId) throw new WebGptV4Error("MISSING_REQUIRED_FIELD", "artifact_id is required for this proposal.", "artifact_id");
    if (!shot.clip_versions.some((version) => version.artifact_id === artifactId)) throw new WebGptV4Error("ARTIFACT_NOT_IN_SHOT_REVIEW", "Artifact is not a version of the requested SHOT.", "artifact_id");
    requireArtifact(db, projectId, artifactId, true, { shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video" });
  }
  return { shot_id: shotId, artifact_id: artifactId };
}

export function submitProductionProposal(
  input: { project_id: string; kind: ProductionProposalKind; payload: Record<string, unknown> },
  context: MutationContext,
  db: M0Database
): WebGptV4Result<{ draft: WorkbenchDraftRecord }> {
  return mutation(db, "submit_production_proposal", context, input, () => {
    projectRow(db, input.project_id, true);
    if (!["storyboard_package", "review_decision", "regeneration", "final_assembly", "memory_saveback", "package_freeze"].includes(input.kind)) {
      throw new WebGptV4Error("INVALID_PROPOSAL_KIND", "Production proposal kind is not supported.", "kind");
    }
    const payload = parseProductionProposalPayload(input.kind, input.payload);
    const linked = validateProposal(input.kind, input.project_id, payload, db);
    const now = new Date().toISOString();
    const draft = saveWorkbenchDraftRecord({
      draft_id: `webgpt_v4_proposal_${randomUUID()}`,
      tool: `webgpt_v4_proposal_${input.kind}`,
      status: "pending",
      source: "webgpt_v4",
      created_at: now,
      updated_at: now,
      target_project_id: input.project_id,
      target_shot_id: linked.shot_id,
      payload: { ...payload, kind: input.kind, project_id: input.project_id, shot_id: linked.shot_id, artifact_id: linked.artifact_id }
    }, db);
    appendWorkbenchInboxEvent({ object_type: "draft", object_id: draft.draft_id, event_type: "created_by_webgpt_v4", to_status: "pending", data: { kind: input.kind, project_id: input.project_id } }, db);
    return { data: { draft }, project_id: input.project_id, object_type: "draft", object_id: draft.draft_id, changed_fields: ["status", "payload"], after_hash: requestHash(draft), updated_at: now };
  });
}

export function reviseProductionProposal(
  input: { project_id: string; draft_id: string; payload: Record<string, unknown> },
  context: MutationContext,
  db: M0Database
): WebGptV4Result<{ draft: WorkbenchDraftRecord; closed_draft_id: string }> {
  return mutation(db, "revise_production_proposal", context, input, () => {
    projectRow(db, input.project_id, true);
    const prior = getWorkbenchDraftRecord(plainId(input.draft_id, "draft_id"), db);
    if (!prior || prior.source !== "webgpt_v4" || prior.target_project_id !== input.project_id) throw new WebGptV4Error("DRAFT_NOT_FOUND", "WebGPT V4 proposal was not found.", "draft_id");
    if (prior.status !== "pending" && prior.status !== "revision_needed") throw new WebGptV4Error("INVALID_PROPOSAL_TRANSITION", `Proposal cannot be revised from ${prior.status}.`);
    const kind = String(prior.payload.kind ?? "") as ProductionProposalKind;
    if (!["storyboard_package", "review_decision", "regeneration", "final_assembly", "memory_saveback", "package_freeze"].includes(kind)) {
      throw new WebGptV4Error("INVALID_PROPOSAL_KIND", "Stored production proposal kind is invalid.", "kind");
    }
    const payload = parseProductionProposalPayload(kind, input.payload);
    const linked = validateProposal(kind, input.project_id, payload, db);
    const now = new Date().toISOString();
    saveWorkbenchDraftRecord({ ...prior, status: "closed", updated_at: now }, db);
    appendWorkbenchInboxEvent({ object_type: "draft", object_id: prior.draft_id, event_type: "superseded", from_status: prior.status, to_status: "closed" }, db);
    const draft = saveWorkbenchDraftRecord({
      ...prior,
      draft_id: `webgpt_v4_proposal_${randomUUID()}`,
      status: "pending",
      parent_draft_id: prior.draft_id,
      target_shot_id: linked.shot_id,
      created_at: now,
      updated_at: now,
      payload: { ...payload, kind, project_id: input.project_id, shot_id: linked.shot_id, artifact_id: linked.artifact_id }
    }, db);
    appendWorkbenchInboxEvent({ object_type: "draft", object_id: draft.draft_id, event_type: "revised", to_status: "pending", data: { parent_draft_id: prior.draft_id } }, db);
    return { data: { draft, closed_draft_id: prior.draft_id }, project_id: input.project_id, object_type: "draft", object_id: draft.draft_id, changed_fields: ["status", "payload", "parent_draft_id"], before_hash: requestHash(prior), after_hash: requestHash(draft), updated_at: now };
  });
}

export function closeProductionProposal(
  input: { project_id: string; draft_id: string; reason?: string },
  context: MutationContext,
  db: M0Database
): WebGptV4Result<{ draft: WorkbenchDraftRecord }> {
  return mutation(db, "close_production_proposal", context, input, () => {
    projectRow(db, input.project_id, true);
    const prior = getWorkbenchDraftRecord(plainId(input.draft_id, "draft_id"), db);
    if (!prior || prior.source !== "webgpt_v4" || prior.target_project_id !== input.project_id) throw new WebGptV4Error("DRAFT_NOT_FOUND", "WebGPT V4 proposal was not found.", "draft_id");
    if (prior.status !== "pending" && prior.status !== "revision_needed") throw new WebGptV4Error("INVALID_PROPOSAL_TRANSITION", `Proposal cannot be closed from ${prior.status}.`);
    const reason = input.reason?.trim() ?? "";
    if (reason.length > 500) throw new WebGptV4Error("INVALID_FIELD", "Close reason cannot exceed 500 characters.", "reason");
    const now = new Date().toISOString();
    const draft = saveWorkbenchDraftRecord({ ...prior, status: "closed", revision_note: reason, updated_at: now }, db);
    appendWorkbenchInboxEvent({ object_type: "draft", object_id: draft.draft_id, event_type: "closed_by_webgpt_v4", from_status: prior.status, to_status: "closed", data: { reason } }, db);
    return { data: { draft }, project_id: input.project_id, object_type: "draft", object_id: draft.draft_id, changed_fields: ["status", "revision_note"], before_hash: requestHash(prior), after_hash: requestHash(draft), updated_at: now };
  });
}

export function prepareProductionGenerationIntent(
  input: { project_id: string; shot_id: string; account_label: "personal" | "team"; budget_limit_value: number },
  context: MutationContext,
  db: M0Database
): WebGptV4Result<Record<string, unknown>> {
  return mutation(db, "prepare_generation_intent", context, input, () => {
    const row = projectRow(db, input.project_id, true);
    const project = parseBoundJson<Project>(row.data_json, "project_id");
    if (project.project_id !== row.project_id) dataIntegrityViolation("project_id");
    const { shot } = requireShot(db, input.project_id, input.shot_id);
    if (shot.status !== "storyboard_approved" && shot.status !== "revision_needed") throw new WebGptV4Error("SHOT_NOT_APPROVED", "Storyboard approval is required before generation preparation.");
    const artifact = requireArtifact(db, input.project_id, shot.storyboard_image_artifact_id, true, { shot_id: shot.shot_id, role: "storyboard_image", artifact_type: "image" });
    if (!Number.isFinite(input.budget_limit_value) || input.budget_limit_value <= 0) throw new WebGptV4Error("BUDGET_LIMIT_REQUIRED", "A positive budget limit is required.", "budget_limit_value");
    const capability = buildProviderCapabilityKey({
      provider: "runninghub",
      model: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model,
      duration_seconds: shot.duration_seconds,
      resolution: project.video_spec.resolution,
      aspect_ratio: project.video_spec.aspect_ratio
    });
    if (!capability.ok) throw new WebGptV4Error(capability.code, providerCapabilityErrorMessage(capability), capability.field);
    const { model, resolution, duration_seconds: durationSeconds } = capability.key;
    const priceCacheKey = buildProviderPriceCacheKey(capability.key, capability.capability);
    const cache = db.prepare(`
      SELECT * FROM webgpt_provider_price_cache
      WHERE provider = ? AND model = ? AND duration_seconds = ? AND resolution = ? AND source = ? AND expires_at > ?
    `).get(priceCacheKey.provider, priceCacheKey.model, priceCacheKey.duration_seconds, priceCacheKey.storage_resolution, priceCacheKey.source, new Date().toISOString()) as Record<string, unknown> | undefined;
    if (!cache) throw new WebGptV4Error("GENERATION_PREP_BLOCKED", "No current human-verified local price cache is available. Run preflight in the human workbench first.");
    const estimated = Number(cache.estimated_cost_value);
    if (estimated > input.budget_limit_value) throw new WebGptV4Error("BUDGET_LIMIT_EXCEEDED", "Cached estimate exceeds the proposed budget limit.", "budget_limit_value");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const intentId = `intent_${randomUUID()}`;
    const snapshot = {
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt,
      aspect_ratio: project.video_spec.aspect_ratio,
      price_source: "local_verified_cache",
      balance_gate: "not_checked",
      requires_human_preflight: true,
      prepared_by: "webgpt_v4",
      capability_key: capability.key.serialized
    };
    db.prepare(`
      INSERT INTO generation_intents (
        intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
        duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
        confirmed, expires_at, status, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'runninghub', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'prepared', ?, ?, ?)
    `).run(intentId, input.project_id, shot.shot_id, input.account_label, model, artifact.artifact_id, durationSeconds, resolution, estimated, input.budget_limit_value, String(cache.currency), expiresAt, JSON.stringify({ input_snapshot: snapshot }), now.toISOString(), now.toISOString());
    const data = {
      intent_id: intentId,
      project_id: input.project_id,
      shot_id: shot.shot_id,
      provider: "runninghub",
      account_label: input.account_label,
      model,
      input_artifact_id: artifact.artifact_id,
      estimated_cost_value: estimated,
      budget_limit_value: input.budget_limit_value,
      currency: String(cache.currency),
      confirmed: false,
      status: "prepared",
      expires_at: expiresAt,
      requires_human_preflight: true,
      provider_call_attempted: false
    };
    return { data, project_id: input.project_id, object_type: "generation_intent", object_id: intentId, changed_fields: ["status"], after_hash: requestHash(data), updated_at: now.toISOString() };
  });
}

export function productionArtifact(db: M0Database, projectId: string, artifactId: string): MediaArtifact {
  projectRow(db, projectId);
  return requireArtifact(db, projectId, artifactId, true);
}
