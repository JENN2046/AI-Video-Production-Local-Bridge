import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { classifyStoryboardImageImport } from "./importClassifier.js";
import { validateImageFile } from "./imageValidity.js";
import { listH1Reports, loadH1WorkbenchState, registerH1ApprovedKeyframe, type H1WorkbenchState } from "./h1Workbench.js";
import {
  attachArtifactToShot,
  createScopedArtifactFromBlob,
  getMediaArtifact,
  validateAcceptedClipReference,
  validateActiveArtifactReference,
  type MediaArtifact
} from "./mediaArtifacts.js";
import { loadMemorySavebackStore } from "./memorySaveback.js";
import { createProject, getProject, getShot, listProjectShots, saveProject, saveShot, type Project, type Shot } from "./projects.js";
import { collectProjectOperationalBundle, collectProjectOperationalBundles, OperationalStateIntegrityError } from "./operationalStateFacts.js";
import type { ProjectOperationalSummary } from "../packages/domain/operationalState.js";
import { markShotClipReview, type RevisionInstruction } from "./review.js";
import { listWorkbenchDraftRecords, listWorkbenchPendingActionRecords } from "./workbenchInboxStore.js";

export type WorkbenchProjectClassification = "unclassified" | "production" | "test";
export type WorkbenchProjectLifecycle = "active" | "archived";
export type WorkbenchWorkspace = "overview" | "storyboard" | "generation" | "review" | "delivery";
export type WorkbenchProjectPriority = "urgent" | "high" | "normal";
export type WorkbenchProjectScope = "daily" | "all";

export interface WorkbenchNextAction {
  source: "derived" | "override";
  label: string;
  reason_code: string;
  priority: WorkbenchProjectPriority;
  expires_at: string | null;
  derived: {
    label: string;
    reason_code: string;
    priority: WorkbenchProjectPriority;
  };
}

export interface WorkbenchProjectSummary {
  project: Project;
  meta: WorkbenchProjectMeta;
  shot_count: number;
  accepted_count: number;
  active_run_count: number;
  blocker_count: number;
  blocked_shot_count: number;
  blocker_codes: string[];
  blocker_reason: string;
  review_pending_count: number;
  delivery_state: "not_ready" | "ready_to_assemble" | "final_review" | "delivered";
  next_action: WorkbenchNextAction;
  risk: "blocked" | "attention" | "clear";
}

export interface WorkbenchProjectMeta {
  project_id: string;
  classification: WorkbenchProjectClassification;
  lifecycle: WorkbenchProjectLifecycle;
  pinned: boolean;
  last_opened_at: string | null;
  next_action_override: string;
  next_action_priority: WorkbenchProjectPriority | null;
  next_action_expires_at: string | null;
  next_action_project_status: string | null;
  next_action_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkbenchPage<T> {
  items: T[];
  meta: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
}

export interface WorkbenchV2Error {
  code: string;
  message: string;
  field?: string;
}

export type WorkbenchV2Result<T> = { ok: true; data: T } | { ok: false; error: WorkbenchV2Error };

interface ProjectRow {
  project_id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
  classification: WorkbenchProjectClassification;
  lifecycle: WorkbenchProjectLifecycle;
  pinned: number;
  last_opened_at: string | null;
  next_action_override: string;
  next_action_priority: WorkbenchProjectPriority | null;
  next_action_expires_at: string | null;
  next_action_project_status: string | null;
  next_action_updated_at: string | null;
}

interface ImportIndexRow {
  relative_path: string;
  filename: string;
  size_bytes: number;
  mtime_ms: number;
  checksum: string;
  metadata_json: string;
  scanned_at: string;
  decision: string | null;
  target_project_id: string | null;
  artifact_id: string | null;
  reason: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function clampLimit(value: number | undefined, fallback = 50, maximum = 200): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value ?? fallback)));
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value ?? 0));
}

function page<T>(items: T[], total: number, limit: number, offset: number): WorkbenchPage<T> {
  return { items, meta: { limit, offset, total, has_more: offset + items.length < total } };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function integrityPlaceholderProject(projectId: string): Project {
  return {
    project_id: projectId,
    title: "Project data integrity error",
    project_type: "unknown",
    status: "draft",
    brief: {},
    video_spec: { duration_seconds: 0, aspect_ratio: "", resolution: "" },
    shot_ids: [],
    active_storyboard_package_id: "",
    generation_batch_ids: [],
    exports: { final_video_artifact_id: "" }
  };
}

function projectFromBoundRow(row: Pick<ProjectRow, "project_id" | "data_json">): { project: Project; integrity_valid: boolean } {
  const parsed = parseJson<Project | null>(row.data_json, null);
  if (parsed?.project_id === row.project_id) return { project: parsed, integrity_valid: true };
  return { project: integrityPlaceholderProject(row.project_id), integrity_valid: false };
}

function projectMetaFromRow(row: ProjectRow): WorkbenchProjectMeta {
  return {
    project_id: row.project_id,
    classification: row.classification,
    lifecycle: row.lifecycle,
    pinned: row.pinned === 1,
    last_opened_at: row.last_opened_at,
    next_action_override: row.next_action_override ?? "",
    next_action_priority: row.next_action_priority ?? null,
    next_action_expires_at: row.next_action_expires_at ?? null,
    next_action_project_status: row.next_action_project_status ?? null,
    next_action_updated_at: row.next_action_updated_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function ensureProjectMeta(db: M0Database, projectId: string): void {
  db.prepare("INSERT OR IGNORE INTO workbench_project_meta (project_id) VALUES (?)").run(projectId);
}

function projectMeta(db: M0Database, projectId: string, ensure = true): WorkbenchProjectMeta | null {
  if (ensure) ensureProjectMeta(db, projectId);
  const row = db.prepare(`
    SELECT project_id, classification, lifecycle, pinned, last_opened_at,
      next_action_override, next_action_priority, next_action_expires_at,
      next_action_project_status, next_action_updated_at, created_at, updated_at
    FROM workbench_project_meta WHERE project_id = ?
  `).get(projectId) as {
    project_id: string;
    classification: WorkbenchProjectClassification;
    lifecycle: WorkbenchProjectLifecycle;
    pinned: number;
    last_opened_at: string | null;
    next_action_override: string;
    next_action_priority: WorkbenchProjectPriority | null;
    next_action_expires_at: string | null;
    next_action_project_status: string | null;
    next_action_updated_at: string | null;
    created_at: string;
    updated_at: string;
  } | undefined;
  return row ? { ...row, pinned: row.pinned === 1 } : null;
}

function projectNotFound(projectId: string): WorkbenchV2Result<never> {
  return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}`, field: "project_id" } };
}

export function assertWorkbenchProjectWritable(db: M0Database, projectId: string): WorkbenchV2Result<{ project: Project; meta: WorkbenchProjectMeta }> {
  const project = getProject(db, projectId);
  if (!project) return projectNotFound(projectId);
  const meta = projectMeta(db, projectId);
  if (!meta) return projectNotFound(projectId);
  if (meta.lifecycle === "archived") {
    return { ok: false, error: { code: "PROJECT_ARCHIVED", message: "Archived projects are read-only.", field: "project_id" } };
  }
  return { ok: true, data: { project, meta } };
}

export function listWorkbenchProjects(
  input: {
    scope?: WorkbenchProjectScope;
    lifecycle?: WorkbenchProjectLifecycle | "all";
    classification?: WorkbenchProjectClassification | "all";
    query?: string;
    limit?: number;
    offset?: number;
  } = {},
  db = openM0Database()
): WorkbenchPage<WorkbenchProjectSummary> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const lifecycle = input.lifecycle ?? "active";
  const classification = input.classification ?? "all";
  const scope = input.scope ?? "daily";
  const query = input.query?.trim() ?? "";
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope === "daily") {
    clauses.push("m.lifecycle = 'active'");
    clauses.push("m.classification IN ('production', 'unclassified')");
  } else {
    if (lifecycle !== "all") {
      clauses.push("m.lifecycle = ?");
      params.push(lifecycle);
    }
    if (classification !== "all") {
      clauses.push("m.classification = ?");
      params.push(classification);
    }
  }
  if (query) {
    clauses.push("(json_extract(p.data_json, '$.title') LIKE ? OR p.project_id LIKE ?)");
    params.push(`%${query}%`, `%${query}%`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM projects p
    JOIN workbench_project_meta m ON m.project_id = p.project_id
    ${where}
  `).get(...params) as { count: number };
  const rows = db.prepare(`
    SELECT p.project_id, p.data_json, p.created_at, p.updated_at,
      m.classification, m.lifecycle, m.pinned, m.last_opened_at,
      m.next_action_override, m.next_action_priority, m.next_action_expires_at,
      m.next_action_project_status, m.next_action_updated_at
    FROM projects p
    JOIN workbench_project_meta m ON m.project_id = p.project_id
    ${where}
    ORDER BY m.pinned DESC,
      CASE json_extract(p.data_json, '$.status')
        WHEN 'video_review' THEN 0
        WHEN 'video_generation_in_progress' THEN 1
        WHEN 'storyboard_approved' THEN 2
        WHEN 'draft' THEN 3
        ELSE 4
      END,
      COALESCE(m.last_opened_at, p.updated_at) DESC,
      p.project_id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as ProjectRow[];

  const parsed = rows.map((row) => ({ row, ...projectFromBoundRow(row) }));
  const summaries = collectOperationalSummariesForList(db, parsed.filter((item) => item.integrity_valid).map((item) => item.project));
  return page(parsed.map(({ row, project, integrity_valid }) => {
    const operational = integrity_valid ? summaries.get(project.project_id) ?? {
      shot_count: 0,
      accepted_count: 0,
      active_run_count: 0,
      blocked_shot_count: 0,
      blocker_count: 0,
      blocker_codes: [],
      blocker_code_counts: {},
      review_pending_count: 0,
      revision_needed_count: 0,
      latest_failed_count: 0
    } : integrityBlockedSummary(project);
    return projectSummaryFromRow(project, row, operational);
  }), totalRow.count, limit, offset);
}

function integrityBlockedSummary(project: Project): ProjectOperationalSummary {
  const shotCount = project.shot_ids.length;
  const code = "PROJECT_OPERATIONAL_DATA_INTEGRITY_VIOLATION";
  return {
    shot_count: shotCount,
    accepted_count: 0,
    active_run_count: 0,
    blocked_shot_count: shotCount > 0 ? 1 : 0,
    blocker_count: 1,
    blocker_codes: [code],
    blocker_code_counts: { [code]: 1 },
    review_pending_count: 0,
    revision_needed_count: 0,
    latest_failed_count: 0
  };
}

function collectOperationalSummariesForList(db: M0Database, projects: Project[]): Map<string, ProjectOperationalSummary> {
  try {
    const bundles = collectProjectOperationalBundles(db, projects);
    return new Map([...bundles].map(([projectId, bundle]) => [projectId, bundle.summary]));
  } catch (error) {
    if (!(error instanceof OperationalStateIntegrityError)) throw error;
  }

  const summaries = new Map<string, ProjectOperationalSummary>();
  for (const project of projects) {
    try {
      summaries.set(project.project_id, collectProjectOperationalBundle(db, project).summary);
    } catch (error) {
      if (!(error instanceof OperationalStateIntegrityError)) throw error;
      summaries.set(project.project_id, integrityBlockedSummary(project));
    }
  }
  return summaries;
}

export function getWorkbenchProjectSummary(projectId: string, db = openM0Database()): WorkbenchProjectSummary | null {
  const result = listWorkbenchProjects({ scope: "all", lifecycle: "all", classification: "all", query: projectId, limit: 10 }, db);
  return result.items.find((item) => item.project.project_id === projectId) ?? null;
}

type SummaryAssemblyReadiness = "not_applicable" | "unverified" | "ready" | "invalid";

const BLOCKER_LABELS: Record<string, string> = {
  STORYBOARD_APPROVAL_REQUIRED: "待审批分镜",
  STORYBOARD_REVISION_REQUIRED: "分镜需修改",
  STORYBOARD_IMAGE_MISSING: "缺分镜图",
  STORYBOARD_ARTIFACT_INACTIVE: "分镜图不可用",
  STORYBOARD_ARTIFACT_BINDING_INVALID: "分镜图绑定错误",
  STORYBOARD_ARTIFACT_ROLE_INVALID: "分镜图角色错误",
  STORYBOARD_ARTIFACT_INTEGRITY_INVALID: "分镜图完整性异常",
  VIDEO_PROMPT_MISSING: "缺提示词",
  SHOT_DURATION_INVALID: "时长无效",
  CLIP_REVISION_REQUIRED: "片段需修改",
  GENERATION_MANUAL_RECONCILIATION: "生成需人工核对",
  GENERATION_FAILED: "生成失败",
  SHOT_STATE_INCONSISTENT: "状态不一致",
  REVIEW_CLIP_MISSING: "待审片段缺失",
  REVIEW_CLIP_INACTIVE: "待审片段不可用",
  REVIEW_CLIP_BINDING_INVALID: "待审片段绑定错误",
  REVIEW_CLIP_ROLE_INVALID: "待审片段角色错误",
  REVIEW_CLIP_INTEGRITY_INVALID: "待审片段完整性异常",
  PROJECT_OPERATIONAL_DATA_INTEGRITY_VIOLATION: "项目运行数据完整性异常"
};

function blockerLabel(code: string): string {
  return BLOCKER_LABELS[code] ?? code;
}

function hasAcceptedClipIntegrityBlocker(summary: ProjectOperationalSummary): boolean {
  return summary.blocker_codes.some((code) => code === "SHOT_STATE_INCONSISTENT" || code === "ARTIFACT_NOT_IN_SHOT_REVIEW" || code.startsWith("ACCEPTED_CLIP_"));
}

function projectSummaryFromRow(project: Project, row: ProjectRow, operational: ProjectOperationalSummary): WorkbenchProjectSummary {
  const meta = projectMetaFromRow(row);
  const assemblyReadiness: SummaryAssemblyReadiness = operational.shot_count > 0
    && operational.accepted_count === operational.shot_count
    && !project.exports.final_video_artifact_id
    ? "unverified"
    : "not_applicable";
  const derived = deriveNextAction(project, operational, assemblyReadiness);
  const overrideValid = Boolean(
    assemblyReadiness !== "unverified"
    && !hasAcceptedClipIntegrityBlocker(operational)
    && meta.next_action_override
    && meta.next_action_priority
    && meta.next_action_expires_at
    && new Date(meta.next_action_expires_at).getTime() > Date.now()
    && meta.next_action_project_status === project.status
  );
  const nextAction: WorkbenchNextAction = overrideValid ? {
    source: "override",
    label: meta.next_action_override,
    reason_code: "manual_override",
    priority: meta.next_action_priority as WorkbenchProjectPriority,
    expires_at: meta.next_action_expires_at,
    derived
  } : { source: "derived", ...derived, expires_at: null, derived };
  const deliveryState = project.status === "final_approved"
    ? "delivered"
    : project.exports.final_video_artifact_id
      ? "final_review"
      : "not_ready";
  const blockerParts = operational.blocker_codes.map((code) => `${operational.blocker_code_counts[code] ?? 0} 个${blockerLabel(code)}`);
  const risk: "blocked" | "attention" | "clear" = operational.blocker_count > 0 || operational.latest_failed_count > 0
    ? "blocked"
    : assemblyReadiness === "unverified" || operational.active_run_count > 0 || operational.review_pending_count > 0
      ? "attention"
      : "clear";
  return {
    project,
    meta,
    shot_count: operational.shot_count,
    accepted_count: operational.accepted_count,
    active_run_count: operational.active_run_count,
    blocker_count: operational.blocker_count,
    blocked_shot_count: operational.blocked_shot_count,
    blocker_codes: operational.blocker_codes,
    blocker_reason: blockerParts.join("、"),
    review_pending_count: operational.review_pending_count,
    delivery_state: deliveryState,
    next_action: nextAction,
    risk
  };
}

function deriveNextAction(project: Project, state: ProjectOperationalSummary, assemblyReadiness: SummaryAssemblyReadiness = "not_applicable"): WorkbenchNextAction["derived"] {
  if (state.latest_failed_count > 0) return { label: "处理生成失败", reason_code: "generation_failed", priority: "urgent" };
  if (state.blocker_codes.includes("PROJECT_OPERATIONAL_DATA_INTEGRITY_VIOLATION")) {
    return { label: "修复项目运行数据", reason_code: "operational_data_integrity", priority: "urgent" };
  }
  if (state.shot_count === 0) return { label: "创建第一个 SHOT", reason_code: "no_shots", priority: "high" };
  if (state.blocker_codes.some((code) => code === "STORYBOARD_IMAGE_MISSING" || code === "VIDEO_PROMPT_MISSING")) {
    return { label: "补齐分镜门禁", reason_code: "storyboard_blocked", priority: "urgent" };
  }
  if (state.revision_needed_count > 0) return { label: "处理需修改 SHOT", reason_code: "revision_required", priority: "urgent" };
  if (hasAcceptedClipIntegrityBlocker(state)) {
    return { label: "修复无效采纳片段", reason_code: "accepted_clip_invalid", priority: "urgent" };
  }
  if (state.blocker_count > 0) return { label: "补齐分镜门禁", reason_code: "storyboard_blocked", priority: "urgent" };
  if (project.status === "draft") return { label: "审批分镜", reason_code: "storyboard_review", priority: "high" };
  if (state.active_run_count > 0) return { label: "等待生成完成", reason_code: "generation_running", priority: "normal" };
  if (state.accepted_count < state.shot_count && state.review_pending_count === 0) return { label: "生成缺失 SHOT", reason_code: "generate_shot", priority: "high" };
  if (state.review_pending_count > 0) return { label: "审片", reason_code: "clip_review", priority: "high" };
  if (state.accepted_count === state.shot_count && !project.exports.final_video_artifact_id) {
    if (assemblyReadiness === "ready") return { label: "合成交付", reason_code: "assemble", priority: "high" };
    if (assemblyReadiness === "invalid") return { label: "修复无效采纳片段", reason_code: "accepted_clip_invalid", priority: "urgent" };
    return { label: "验证合成就绪状态", reason_code: "assembly_readiness_required", priority: "high" };
  }
  if (project.exports.final_video_artifact_id && project.status !== "final_approved") return { label: "最终审查", reason_code: "final_review", priority: "high" };
  return { label: "已交付", reason_code: "delivered", priority: "normal" };
}

function withValidatedAssemblyReadiness(
  summary: WorkbenchProjectSummary | null,
  ready: boolean,
  invalidCount: number
): WorkbenchProjectSummary | null {
  if (!summary || summary.project.exports.final_video_artifact_id) return summary;
  const readinessDerived: WorkbenchNextAction["derived"] = ready
    ? { label: "合成交付", reason_code: "assemble", priority: "high" }
    : { label: "修复无效采纳片段", reason_code: "accepted_clip_invalid", priority: "urgent" };
  const derived = summary.next_action.derived.reason_code === "assembly_readiness_required"
    ? readinessDerived
    : summary.next_action.derived;
  const overrideValid = Boolean(
    invalidCount === 0
    && summary.meta.next_action_override
    && summary.meta.next_action_priority
    && summary.meta.next_action_expires_at
    && new Date(summary.meta.next_action_expires_at).getTime() > Date.now()
    && summary.meta.next_action_project_status === summary.project.status
  );
  const nextAction: WorkbenchNextAction = overrideValid ? {
    source: "override",
    label: summary.meta.next_action_override,
    reason_code: "manual_override",
    priority: summary.meta.next_action_priority as WorkbenchProjectPriority,
    expires_at: summary.meta.next_action_expires_at,
    derived
  } : { source: "derived", ...derived, expires_at: null, derived };
  const blockerCount = summary.blocker_count + invalidCount;
  return {
    ...summary,
    blocker_count: blockerCount,
    blocker_reason: [summary.blocker_reason, invalidCount > 0 ? `${invalidCount} 个采纳片段无效` : ""].filter(Boolean).join("、"),
    delivery_state: ready ? "ready_to_assemble" : "not_ready",
    next_action: nextAction,
    risk: blockerCount > 0 ? "blocked" : summary.active_run_count > 0 || summary.review_pending_count > 0 ? "attention" : "clear"
  };
}

export function createWorkbenchProject(
  input: { title: string; classification?: WorkbenchProjectClassification; project_type?: string; duration_seconds?: number; aspect_ratio?: string; resolution?: string },
  db = openM0Database()
): WorkbenchV2Result<{ project: Project; meta: WorkbenchProjectMeta }> {
  const title = input.title?.trim();
  if (!title) return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "Project title is required.", field: "title" } };
  if (input.classification !== "production" && input.classification !== "test") {
    return { ok: false, error: { code: "CLASSIFICATION_REQUIRED", message: "Project classification must be production or test.", field: "classification" } };
  }
  const created = createProject({
    title,
    project_type: input.project_type ?? "human_workbench_v2",
    video_spec: {
      duration_seconds: input.duration_seconds ?? 15,
      aspect_ratio: input.aspect_ratio ?? "9:16",
      resolution: input.resolution ?? "1080x1920"
    }
  }, db);
  if (!created.ok) return created;
  ensureProjectMeta(db, created.project_id);
  db.prepare("UPDATE workbench_project_meta SET classification = ?, lifecycle = 'active', updated_at = CURRENT_TIMESTAMP WHERE project_id = ?").run(input.classification, created.project_id);
  return { ok: true, data: { project: created.project, meta: projectMeta(db, created.project_id) as WorkbenchProjectMeta } };
}

export function updateWorkbenchProject(
  projectId: string,
  input: {
    title?: string;
    classification?: WorkbenchProjectClassification;
    pinned?: boolean;
    next_action_override?: { label: string; priority: WorkbenchProjectPriority } | null;
  },
  db = openM0Database()
): WorkbenchV2Result<{ project: Project; meta: WorkbenchProjectMeta }> {
  const writable = assertWorkbenchProjectWritable(db, projectId);
  if (!writable.ok) return writable;
  const project = writable.data.project;
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "Project title is required.", field: "title" } };
    project.title = title;
    saveProject(db, project);
  }
  const classification = input.classification ?? writable.data.meta.classification;
  const pinned = input.pinned ?? writable.data.meta.pinned;
  let overrideLabel = writable.data.meta.next_action_override;
  let overridePriority = writable.data.meta.next_action_priority;
  let overrideExpiresAt = writable.data.meta.next_action_expires_at;
  let overrideProjectStatus = writable.data.meta.next_action_project_status;
  let overrideUpdatedAt = writable.data.meta.next_action_updated_at;
  if (input.next_action_override === null) {
    overrideLabel = "";
    overridePriority = null;
    overrideExpiresAt = null;
    overrideProjectStatus = null;
    overrideUpdatedAt = now();
  } else if (input.next_action_override !== undefined) {
    const label = input.next_action_override.label?.trim();
    const priority = input.next_action_override.priority;
    if (!label || label.length > 120) return { ok: false, error: { code: "NEXT_ACTION_OVERRIDE_INVALID", message: "Next action must contain 1 to 120 characters.", field: "next_action_override.label" } };
    if (priority !== "urgent" && priority !== "high" && priority !== "normal") {
      return { ok: false, error: { code: "NEXT_ACTION_OVERRIDE_INVALID", message: "Next action priority is invalid.", field: "next_action_override.priority" } };
    }
    const updatedAt = new Date();
    overrideLabel = label;
    overridePriority = priority;
    overrideExpiresAt = new Date(updatedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    overrideProjectStatus = project.status;
    overrideUpdatedAt = updatedAt.toISOString();
  }
  db.prepare(`
    UPDATE workbench_project_meta
    SET classification = ?, pinned = ?, next_action_override = ?, next_action_priority = ?,
      next_action_expires_at = ?, next_action_project_status = ?, next_action_updated_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE project_id = ?
  `).run(classification, pinned ? 1 : 0, overrideLabel, overridePriority, overrideExpiresAt, overrideProjectStatus, overrideUpdatedAt, projectId);
  return { ok: true, data: { project, meta: projectMeta(db, projectId) as WorkbenchProjectMeta } };
}

export function setWorkbenchProjectLifecycle(
  projectId: string,
  lifecycle: WorkbenchProjectLifecycle,
  db = openM0Database()
): WorkbenchV2Result<{ project: Project; meta: WorkbenchProjectMeta }> {
  const project = getProject(db, projectId);
  if (!project) return projectNotFound(projectId);
  if (project.project_id !== projectId) {
    return {
      ok: false,
      error: {
        code: "PROJECT_OPERATIONAL_DATA_INTEGRITY_VIOLATION",
        message: "Project operational data failed integrity validation.",
        field: "project_id"
      }
    };
  }
  ensureProjectMeta(db, projectId);
  db.prepare(`UPDATE workbench_project_meta SET lifecycle = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`).run(lifecycle, projectId);
  return { ok: true, data: { project, meta: projectMeta(db, projectId) as WorkbenchProjectMeta } };
}

export function updateWorkbenchShot(
  projectId: string,
  shotId: string,
  input: {
    description?: string;
    video_prompt?: string;
    negative_prompt?: string;
    duration_seconds?: number;
    storyboard_image_artifact_id?: string;
    approve_storyboard?: boolean;
    human_confirmation?: boolean;
  },
  db = openM0Database()
): WorkbenchV2Result<{ shot: Shot }> {
  const writable = assertWorkbenchProjectWritable(db, projectId);
  if (!writable.ok) return writable;
  let shot = getShot(db, shotId);
  if (!shot || shot.project_id !== projectId) return { ok: false, error: { code: "SHOT_NOT_FOUND", message: `Shot not found in project: ${shotId}`, field: "shot_id" } };
  const ownsTransaction = input.storyboard_image_artifact_id !== undefined
    && !(db as unknown as { isTransaction?: boolean }).isTransaction;
  try {
  if (input.duration_seconds !== undefined) {
    if (!Number.isFinite(input.duration_seconds) || input.duration_seconds <= 0) {
      return { ok: false, error: { code: "INVALID_FIELD", message: "Duration must be positive.", field: "duration_seconds" } };
    }
    shot.duration_seconds = input.duration_seconds;
  }
  if (input.description !== undefined) shot.description = input.description;
  if (input.video_prompt !== undefined) shot.video_prompt = input.video_prompt;
  if (input.negative_prompt !== undefined) shot.negative_prompt = input.negative_prompt;
  if (input.approve_storyboard) {
    if (input.human_confirmation !== true) return { ok: false, error: { code: "HUMAN_CONFIRMATION_REQUIRED", message: "Storyboard approval requires confirmation." } };
    if (!(input.storyboard_image_artifact_id || shot.storyboard_image_artifact_id) || !shot.video_prompt) {
      return { ok: false, error: { code: "SHOT_BLOCKED", message: "Storyboard image and video prompt are required before approval." } };
    }
  }
  if (input.storyboard_image_artifact_id !== undefined) {
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    let artifact = getMediaArtifact(db, input.storyboard_image_artifact_id);
    if (!artifact || artifact.status !== "active" || artifact.artifact_type !== "image" || artifact.role !== "storyboard_image") {
      if (ownsTransaction) db.exec("ROLLBACK");
      return { ok: false, error: { code: "INVALID_ARTIFACT_ROLE", message: "SHOT requires an active storyboard image.", field: "storyboard_image_artifact_id" } };
    }
    if (artifact.linked_objects.project_id !== projectId || artifact.linked_objects.shot_id !== shotId) {
      const scoped = createScopedArtifactFromBlob({ source_artifact_id: artifact.artifact_id, project_id: projectId, shot_id: shotId }, db);
      if (!scoped.ok) {
        if (ownsTransaction) db.exec("ROLLBACK");
        return { ok: false, error: { ...scoped.error, field: "storyboard_image_artifact_id" } };
      }
      artifact = scoped.artifact;
    }
    const attached = attachArtifactToShot({
      project_id: projectId,
      shot_id: shotId,
      artifact_id: artifact.artifact_id,
      reference: "storyboard_image_artifact_id",
      expected_current_artifact_id: shot.storyboard_image_artifact_id
    }, db);
    if (!attached.ok) {
      if (ownsTransaction) db.exec("ROLLBACK");
      return { ok: false, error: { ...attached.error, field: "storyboard_image_artifact_id" } };
    }
    shot = attached.shot;
    if (input.duration_seconds !== undefined) shot.duration_seconds = input.duration_seconds;
    if (input.description !== undefined) shot.description = input.description;
    if (input.video_prompt !== undefined) shot.video_prompt = input.video_prompt;
    if (input.negative_prompt !== undefined) shot.negative_prompt = input.negative_prompt;
  }
  if (input.approve_storyboard) {
    shot.status = "storyboard_approved";
  }
  saveShot(db, shot);
  if (ownsTransaction) db.exec("COMMIT");
  return { ok: true, data: { shot } };
  } catch (error) {
    if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
    return { ok: false, error: { code: "SHOT_UPDATE_FAILED", message: error instanceof Error ? error.message : "SHOT update failed." } };
  }
}

export function decideWorkbenchClip(
  projectId: string,
  input: {
    shot_id: string;
    artifact_id: string;
    decision: "approved" | "revision_needed";
    rejection_reasons?: string[];
    revision_instruction?: RevisionInstruction;
  },
  db = openM0Database()
): WorkbenchV2Result<{ shot: Shot; regeneration_request?: Record<string, unknown> }> {
  const writable = assertWorkbenchProjectWritable(db, projectId);
  if (!writable.ok) return writable;
  const candidate = getShot(db, input.shot_id);
  if (!candidate || candidate.project_id !== projectId) return { ok: false, error: { code: "SHOT_NOT_FOUND", message: "SHOT does not belong to the selected project.", field: "shot_id" } };
  const result = markShotClipReview({
    shot_id: input.shot_id,
    artifact_id: input.artifact_id,
    decision: input.decision,
    rejection_reasons: input.rejection_reasons,
    revision_instruction: input.revision_instruction
  }, db);
  if (!result.ok) return result;
  if (input.decision === "approved") return { ok: true, data: { shot: result.shot } };
  const version = result.shot.clip_versions.find((item) => item.artifact_id === input.artifact_id);
  const request = {
    request_id: `regen_${randomUUID()}`,
    project_id: projectId,
    shot_id: input.shot_id,
    artifact_id: input.artifact_id,
    previous_run_id: version?.run_id ?? "",
    rejection_reasons: input.rejection_reasons ?? [],
    revision_instruction: input.revision_instruction ?? null,
    status: "draft",
    created_at: now()
  };
  db.prepare(`
    INSERT INTO regeneration_requests (request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(request.request_id, projectId, request.shot_id, request.artifact_id, request.previous_run_id, JSON.stringify(request), request.created_at, request.created_at);
  return { ok: true, data: { shot: result.shot, regeneration_request: request } };
}

function artifactMap(db: M0Database, artifactIds: string[]): Record<string, MediaArtifact> {
  const result: Record<string, MediaArtifact> = {};
  for (const artifactId of [...new Set(artifactIds.filter(Boolean))].slice(0, 500)) {
    const artifact = getMediaArtifact(db, artifactId);
    if (artifact) result[artifactId] = artifact;
  }
  return result;
}

export function getWorkbenchProjectWorkspace(
  projectId: string,
  workspace: WorkbenchWorkspace,
  db = openM0Database(),
  options: { touch_last_opened?: boolean } = {}
): WorkbenchV2Result<Record<string, unknown>> {
  const project = getProject(db, projectId);
  if (!project) return projectNotFound(projectId);
  if (project.project_id !== projectId) {
    return {
      ok: false,
      error: {
        code: "PROJECT_OPERATIONAL_DATA_INTEGRITY_VIOLATION",
        message: "Project operational data failed integrity validation.",
        field: "project_id"
      }
    };
  }
  const touchLastOpened = options.touch_last_opened === true;
  const meta = projectMeta(db, projectId, touchLastOpened);
  if (!meta) return projectNotFound(projectId);
  if (touchLastOpened) {
    db.prepare("UPDATE workbench_project_meta SET last_opened_at = CURRENT_TIMESTAMP WHERE project_id = ?").run(projectId);
  }
  let operationalBundle: ReturnType<typeof collectProjectOperationalBundle>;
  try {
    operationalBundle = collectProjectOperationalBundle(db, project);
  } catch (error) {
    if (!(error instanceof OperationalStateIntegrityError)) throw error;
    return {
      ok: false,
      error: {
        code: "PROJECT_OPERATIONAL_DATA_INTEGRITY_VIOLATION",
        message: "Project operational data failed integrity validation.",
        field: "project_id"
      }
    };
  }
  const shots = operationalBundle.shots;
  const shotsWithOperationalState = shots.map((shot) => ({
    ...shot,
    operational_state: operationalBundle.states_by_shot_id.get(shot.shot_id)
  }));
  project.shot_ids = shots.map((shot) => shot.shot_id);
  const runRows = db.prepare(`SELECT data_json FROM generation_runs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 200`).all(projectId) as Array<{ data_json: string }>;
  const runs = runRows.map((row) => parseJson<Record<string, unknown>>(row.data_json, {}));
  const packageRows = db.prepare(`SELECT data_json FROM storyboard_packages WHERE project_id = ? ORDER BY updated_at DESC LIMIT 25`).all(projectId) as Array<{ data_json: string }>;
  const packages = packageRows.map((row) => parseJson<Record<string, unknown>>(row.data_json, {}));
  const artifactIds = shots.flatMap((shot) => [shot.storyboard_image_artifact_id, shot.accepted_clip_artifact_id, ...shot.clip_versions.map((version) => version.artifact_id)]);
  const artifacts = artifactMap(db, artifactIds);
  const shotsById = new Map(shots.map((shot) => [shot.shot_id, shot]));
  const regenerationRows = db.prepare(`
    SELECT request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json
    FROM regeneration_requests WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100
  `).all(projectId) as Array<{ request_id: string; project_id: string; shot_id: string; artifact_id: string; previous_run_id: string; status: string; data_json: string }>;
  const regeneration_requests = regenerationRows.map((row) => {
    const data = parseJson<Record<string, unknown>>(row.data_json, {});
    let reference_error_code = "";
    if (data.request_id !== row.request_id || data.project_id !== row.project_id || data.shot_id !== row.shot_id
      || data.artifact_id !== row.artifact_id || data.previous_run_id !== row.previous_run_id || data.status !== row.status) {
      reference_error_code = "REGENERATION_REQUEST_STRUCTURED_DRIFT";
    } else {
      const shot = shotsById.get(row.shot_id);
      if (!shot || !shot.clip_versions.some((version) => version.artifact_id === row.artifact_id)) {
        reference_error_code = "ARTIFACT_NOT_IN_SHOT_REVIEW";
      } else {
        const validated = validateActiveArtifactReference(db, {
          artifact_id: row.artifact_id, project_id: projectId, shot_id: row.shot_id, role: "generated_clip", artifact_type: "video"
        });
        if (!validated.ok) reference_error_code = validated.error.code;
      }
    }
    return { ...data, ...(reference_error_code ? { reference_error_code } : {}) };
  });
  const summary = getWorkbenchProjectSummary(projectId, db);
  const base = { project, meta, summary, workspace };

  if (workspace === "overview") {
    const shotBlockerCodeCounts = operationalBundle.states.flatMap((state) => state.blocker_codes)
      .reduce<Record<string, number>>((counts, code) => {
        counts[code] = (counts[code] ?? 0) + 1;
        return counts;
      }, {});
    const projectBlockers = operationalBundle.summary.blocker_codes
      .filter((code) => (operationalBundle.summary.blocker_code_counts[code] ?? 0) > (shotBlockerCodeCounts[code] ?? 0))
      .map((code) => ({
        scope: "project",
        shot_id: "PROJECT",
        order: 0,
        missing_image: false,
        missing_prompt: false,
        reason_codes: [code]
      }));
    return { ok: true, data: {
      ...base,
      metrics: {
        shots: operationalBundle.summary.shot_count,
        storyboard_approved: operationalBundle.states.filter((state) => state.storyboard.approval_status === "approved").length,
        generation_active: operationalBundle.summary.active_run_count,
        review_pending: operationalBundle.summary.review_pending_count,
        accepted_clips: operationalBundle.summary.accepted_count
      },
      blockers: [...shots.map((shot) => {
        const state = operationalBundle.states_by_shot_id.get(shot.shot_id);
        return {
          scope: "shot",
          shot_id: shot.shot_id,
          order: shot.order,
          missing_image: state?.storyboard.artifact_status === "missing",
          missing_prompt: state?.generation.reason_codes.includes("VIDEO_PROMPT_MISSING") ?? false,
          reason_codes: state?.blocker_codes ?? []
        };
      }).filter((blocker) => blocker.reason_codes.length > 0), ...projectBlockers],
      recent_runs: runs.slice(0, 8)
    } };
  }
  if (workspace === "storyboard") return { ok: true, data: { ...base, shots: shotsWithOperationalState, packages, artifacts } };
  if (workspace === "generation") return { ok: true, data: { ...base, shots: shotsWithOperationalState, runs, artifacts } };
  if (workspace === "review") {
    const version_stacks = shots.map((shot) => ({
      shot: { ...shot, operational_state: operationalBundle.states_by_shot_id.get(shot.shot_id) },
      versions: shot.clip_versions.map((version) => {
        const validated = validateActiveArtifactReference(db, {
          artifact_id: version.artifact_id, project_id: projectId, shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video"
        });
        return { ...version, artifact: validated.ok ? validated.artifact : null, ...(!validated.ok ? { reference_error_code: validated.error.code } : {}) };
      })
    }));
    const reviewNoteRows = db.prepare(`
      SELECT note_id, project_id, shot_id, artifact_id, author_hash, note, source, created_at, updated_at
      FROM workbench_review_notes WHERE project_id = ? ORDER BY created_at DESC
    `).all(projectId) as Array<Record<string, unknown>>;
    const review_notes = reviewNoteRows.map((note) => {
      const shotId = typeof note.shot_id === "string" ? note.shot_id : "";
      const artifactId = typeof note.artifact_id === "string" ? note.artifact_id : "";
      if (!artifactId) return note;
      const shot = shotsById.get(shotId);
      if (!shot || !shot.clip_versions.some((version) => version.artifact_id === artifactId)) {
        return { ...note, reference_error_code: "ARTIFACT_NOT_IN_SHOT_REVIEW" };
      }
      const validated = validateActiveArtifactReference(db, {
        artifact_id: artifactId, project_id: projectId, shot_id: shotId, role: "generated_clip", artifact_type: "video"
      });
      return validated.ok ? note : { ...note, reference_error_code: validated.error.code };
    });
    return { ok: true, data: { ...base, version_stacks, regeneration_requests, review_notes } };
  }
  const accepted_clips = shots.map((shot) => {
    if (!shot.accepted_clip_artifact_id) return { shot_id: shot.shot_id, order: shot.order, artifact_id: "", artifact: null, reference_error_code: "SHOT_ACCEPTED_CLIP_MISSING" };
    const validated = validateAcceptedClipReference(db, shot);
    return { shot_id: shot.shot_id, order: shot.order, artifact_id: shot.accepted_clip_artifact_id, artifact: validated.ok ? validated.artifact : null, ...(!validated.ok ? { reference_error_code: validated.error.code } : {}) };
  });
  const finalArtifact = project.exports.final_video_artifact_id
    ? validateActiveArtifactReference(db, {
      artifact_id: project.exports.final_video_artifact_id, project_id: projectId, shot_id: "", role: "final_video", artifact_type: "video"
    })
    : null;
  const readyForAssembly = accepted_clips.length > 0 && accepted_clips.every((clip) => clip.artifact !== null);
  const invalidAcceptedClipCount = accepted_clips.filter((clip) => clip.artifact_id && clip.artifact === null).length;
  const deliverySummary = withValidatedAssemblyReadiness(summary, readyForAssembly, invalidAcceptedClipCount);
  return { ok: true, data: {
    ...base,
    summary: deliverySummary,
    ready_for_assembly: readyForAssembly,
    readiness_checks: accepted_clips.map((clip) => ({ shot_id: clip.shot_id, artifact_id: clip.artifact_id, ok: clip.artifact !== null, reason_code: clip.artifact ? "SHOT_ACCEPTED_CLIP_READY" : clip.reference_error_code })),
    accepted_clips,
    final_artifact: finalArtifact?.ok ? finalArtifact.artifact : null,
    final_artifact_reason_code: finalArtifact && !finalArtifact.ok ? finalArtifact.error.code : ""
  } };
}

export function getWorkbenchShell(db = openM0Database()): Record<string, unknown> {
  const pending = listWorkbenchPendingActionRecords(db);
  const drafts = listWorkbenchDraftRecords(db);
  const dashboard = getDashboardTotals(db);
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM import_index i LEFT JOIN import_decisions d ON d.checksum = i.checksum WHERE d.decision IS NULL OR d.decision = 'quarantined') AS quarantined_imports,
      (SELECT COUNT(*) FROM media_artifacts a WHERE (a.project_id IS NULL OR a.project_id = '' OR NOT EXISTS (SELECT 1 FROM workbench_project_meta m WHERE m.project_id = a.project_id))) AS unassigned_assets
  `).get() as { quarantined_imports: number; unassigned_assets: number };
  const pendingConfirmations = pending.filter((item) => item.status === "pending").length;
  const activeDrafts = drafts.filter((item) => item.status === "pending" || item.status === "revision_needed").length;
  return {
    version: "human-workbench-v2.1",
    operator: "Jenn",
    navigation: {
      dashboard: dashboard.blocked_projects + dashboard.review_pending + dashboard.pending_delivery,
      inbox: pendingConfirmations + activeDrafts + counts.quarantined_imports,
      projects: 0,
      assets: 0,
      system: 0
    },
    actionable: {
      pending_confirmations: pendingConfirmations,
      gpt_drafts: activeDrafts,
      quarantined_imports: counts.quarantined_imports,
      review_pending: dashboard.review_pending,
      running_jobs: dashboard.generation_active,
      unassigned_assets: counts.unassigned_assets
    },
    capabilities: {
      legacy_available: false,
      real_generation_requires_preflight: true,
      max_real_generation_jobs: 1,
      automatic_retry: false
    }
  };
}

export function getWorkbenchDashboard(db = openM0Database()): Record<string, unknown> {
  const projects = listWorkbenchProjects({ scope: "daily", limit: 12, offset: 0 }, db);
  const totals = getDashboardTotals(db);
  return { totals, projects: projects.items, generated_at: now() };
}

function getDashboardTotals(db: M0Database): { pending_confirmations: number; blocked_projects: number; review_pending: number; generation_active: number; pending_delivery: number } {
  const rows = db.prepare(`
    SELECT p.project_id, p.data_json
    FROM projects p JOIN workbench_project_meta m ON m.project_id = p.project_id
    WHERE m.lifecycle = 'active' AND m.classification IN ('production', 'unclassified')
  `).all() as Array<{ project_id: string; data_json: string }>;
  const projects = rows.map((row) => projectFromBoundRow(row));
  const operationalSummaries = collectOperationalSummariesForList(db, projects.filter((item) => item.integrity_valid).map((item) => item.project));
  const summaries = projects.map(({ project, integrity_valid }) => ({
    project,
    summary: integrity_valid ? operationalSummaries.get(project.project_id) : integrityBlockedSummary(project)
  }));
  const pending = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM workbench_pending_actions WHERE status = 'pending')
        + (SELECT COUNT(*) FROM workbench_drafts WHERE status IN ('pending', 'revision_needed')) AS count
  `).get() as { count: number };
  return {
    pending_confirmations: pending.count,
    blocked_projects: summaries.filter(({ summary }) => (summary?.blocker_count ?? 0) > 0 || (summary?.latest_failed_count ?? 0) > 0).length,
    review_pending: summaries.reduce((count, { summary }) => count + (summary?.review_pending_count ?? 0), 0),
    generation_active: summaries.reduce((count, { summary }) => count + (summary?.active_run_count ?? 0), 0),
    pending_delivery: summaries.filter(({ project, summary }) => Boolean(
      summary && summary.shot_count > 0 && summary.accepted_count === summary.shot_count && project.status !== "final_approved"
    )).length
  };
}

export function refreshWorkbenchImportIndex(db = openM0Database()): { indexed: number; reused: number; rescanned: number; removed: number } {
  const existingRows = db.prepare("SELECT relative_path, size_bytes, mtime_ms FROM import_index").all() as Array<{ relative_path: string; size_bytes: number; mtime_ms: number }>;
  const existing = new Map(existingRows.map((row) => [row.relative_path, row]));
  const seen = new Set<string>();
  let reused = 0;
  let rescanned = 0;
  if (existsSync(paths.importsRoot)) {
    for (const entry of readdirSync(paths.importsRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relativePath = `data/imports/${entry.name}`;
      const absolutePath = join(paths.importsRoot, entry.name);
      const stat = statSync(absolutePath);
      const mtimeMs = Math.trunc(stat.mtimeMs);
      seen.add(relativePath);
      const cached = existing.get(relativePath);
      if (cached && cached.size_bytes === stat.size && cached.mtime_ms === mtimeMs) {
        reused += 1;
        continue;
      }
      const validation = validateImageFile(absolutePath);
      const classification = classifyStoryboardImageImport(entry.name);
      const blockers: string[] = [];
      if (!classification.ok) blockers.push(classification.reason_code);
      if (!validation.ok) blockers.push(validation.error_code || "IMAGE_FILE_INVALID");
      if (validation.ok && validation.aspect_ratio !== "9:16") blockers.push("ASPECT_RATIO_NOT_9_16");
      const checksum = validation.ok ? validation.sha256 : createHash("sha256").update(`${entry.name}:${stat.size}:${mtimeMs}`).digest("hex");
      const metadata = validation.ok
        ? { readable_image: true, mime_type: validation.detected_mime, width: validation.width, height: validation.height, aspect_ratio: validation.aspect_ratio, blockers }
        : { readable_image: false, mime_type: "", width: 0, height: 0, aspect_ratio: "", blockers };
      db.prepare(`
        INSERT OR REPLACE INTO import_index (relative_path, filename, size_bytes, mtime_ms, checksum, metadata_json, scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(relativePath, entry.name, stat.size, mtimeMs, checksum, JSON.stringify(metadata));
      rescanned += 1;
    }
  }
  let removed = 0;
  for (const row of existingRows) {
    if (seen.has(row.relative_path)) continue;
    db.prepare("DELETE FROM import_index WHERE relative_path = ?").run(row.relative_path);
    removed += 1;
  }
  return { indexed: seen.size, reused, rescanned, removed };
}

export function listWorkbenchInbox(
  tab: "pending" | "drafts" | "quarantine",
  input: { status?: string; limit?: number; offset?: number } = {},
  db = openM0Database()
): WorkbenchPage<Record<string, unknown>> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  if (tab === "pending") {
    const all = [...listWorkbenchPendingActionRecords(db)].reverse().filter((item) => !input.status || input.status === "all" || item.status === input.status);
    return page(all.slice(offset, offset + limit) as unknown as Record<string, unknown>[], all.length, limit, offset);
  }
  if (tab === "drafts") {
    const all = [...listWorkbenchDraftRecords(db)].reverse().filter((item) => !input.status || input.status === "all" || item.status === input.status);
    return page(all.slice(offset, offset + limit) as unknown as Record<string, unknown>[], all.length, limit, offset);
  }
  const statusClause = input.status && input.status !== "all" ? "AND COALESCE(d.decision, 'quarantined') = ?" : "";
  const statusParams = statusClause ? [input.status] : [];
  const countRow = db.prepare(`
    SELECT COUNT(*) AS count FROM import_index i LEFT JOIN import_decisions d ON d.checksum = i.checksum
    WHERE 1 = 1 ${statusClause}
  `).get(...statusParams) as { count: number };
  const rows = db.prepare(`
    SELECT i.*, d.decision, d.target_project_id, d.artifact_id, d.reason
    FROM import_index i LEFT JOIN import_decisions d ON d.checksum = i.checksum
    WHERE 1 = 1 ${statusClause}
    ORDER BY i.scanned_at DESC, i.filename
    LIMIT ? OFFSET ?
  `).all(...statusParams, limit, offset) as ImportIndexRow[];
  const items = rows.map((row) => ({
    relative_path: row.relative_path,
    filename: row.filename,
    size_bytes: row.size_bytes,
    checksum: row.checksum,
    ...(parseJson<Record<string, unknown>>(row.metadata_json, {})),
    decision: row.decision ?? "quarantined",
    target_project_id: row.target_project_id ?? "",
    artifact_id: row.artifact_id ?? "",
    reason: row.reason ?? ""
  }));
  return page(items, countRow.count, limit, offset);
}

export function decideWorkbenchImport(
  checksum: string,
  input: { decision: "quarantined" | "excluded" | "registered"; target_project_id?: string; reason?: string },
  db = openM0Database()
): WorkbenchV2Result<Record<string, unknown>> {
  const row = db.prepare("SELECT filename, metadata_json FROM import_index WHERE checksum = ?").get(checksum) as { filename: string; metadata_json: string } | undefined;
  if (!row) return { ok: false, error: { code: "IMPORT_NOT_FOUND", message: "Import checksum was not found.", field: "checksum" } };
  let artifactId = "";
  if (input.decision === "registered") {
    if (!input.target_project_id) return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "Target project is required.", field: "target_project_id" } };
    const writable = assertWorkbenchProjectWritable(db, input.target_project_id);
    if (!writable.ok) return writable;
    const metadata = parseJson<{ blockers?: string[] }>(row.metadata_json, {});
    if ((metadata.blockers ?? []).length > 0) return { ok: false, error: { code: "IMPORT_BLOCKED", message: `Import is blocked: ${(metadata.blockers ?? []).join(", ")}` } };
    const prior = db.prepare(`
      SELECT artifact_id FROM import_decisions
      WHERE checksum = ? AND decision = 'registered' AND target_project_id = ? AND artifact_id IS NOT NULL
    `).get(checksum, input.target_project_id) as { artifact_id: string } | undefined;
    const priorValidated = prior ? validateActiveArtifactReference(db, {
      artifact_id: prior.artifact_id,
      project_id: input.target_project_id,
      shot_id: "",
      role: "storyboard_image",
      artifact_type: "image"
    }) : null;
    if (priorValidated?.ok) {
      artifactId = priorValidated.artifact.artifact_id;
    } else {
      const existing = db.prepare(`
        SELECT m.artifact_id
        FROM media_blobs b
        JOIN media_artifact_blobs m ON m.blob_id = b.blob_id
        JOIN media_artifacts a ON a.artifact_id = m.artifact_id
        WHERE b.sha256 = ? AND b.integrity_state = 'verified' AND a.status = 'active'
        ORDER BY m.created_at, m.artifact_id LIMIT 1
      `).get(checksum) as { artifact_id: string } | undefined;
      let sourceArtifactId = existing?.artifact_id ?? "";
      if (!sourceArtifactId) {
      const registered = registerH1ApprovedKeyframe({
        import_filename: row.filename,
        review_status: "approved_for_media_artifact_handoff",
        write_report: false
      }, db);
      if (!registered.ok) return registered;
        sourceArtifactId = registered.value.artifact.artifact_id;
      }
      const scoped = createScopedArtifactFromBlob({ source_artifact_id: sourceArtifactId, project_id: input.target_project_id }, db);
      if (!scoped.ok) return { ok: false, error: scoped.error };
      artifactId = scoped.artifact.artifact_id;
    }
  }
  db.prepare(`
    INSERT INTO import_decisions (checksum, filename, decision, target_project_id, artifact_id, reason, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(checksum) DO UPDATE SET
      filename = excluded.filename,
      decision = excluded.decision,
      target_project_id = excluded.target_project_id,
      artifact_id = excluded.artifact_id,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
  `).run(checksum, row.filename, input.decision, input.target_project_id ?? null, artifactId || null, input.reason ?? "");
  return { ok: true, data: { checksum, filename: row.filename, decision: input.decision, target_project_id: input.target_project_id ?? "", artifact_id: artifactId } };
}

export function listWorkbenchAssets(
  tab: "media" | "memory" | "reference" | "recall",
  input: { scope?: "daily" | "unassigned" | "all"; project_id?: string; type?: string; role?: string; status?: string; limit?: number; offset?: number } = {},
  db = openM0Database()
): WorkbenchPage<Record<string, unknown>> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const scope = input.scope ?? "daily";
  if (tab !== "media") {
    const store = loadMemorySavebackStore();
    const source = tab === "memory" ? store.memory_items : tab === "reference" ? store.references : store.recall_packs;
    const filtered = source.filter((item) => {
      const projectId = assetLikeProjectId(item as unknown as Record<string, unknown>);
      if (input.project_id && projectId !== input.project_id) return false;
      const meta = projectId ? projectMeta(db, projectId) : null;
      if (scope === "daily") return Boolean(meta && meta.lifecycle === "active" && (meta.classification === "production" || meta.classification === "unclassified"));
      if (scope === "unassigned") return !projectId || !meta;
      return true;
    });
    const reversed = [...filtered].reverse();
    return page(reversed.slice(offset, offset + limit) as unknown as Record<string, unknown>[], reversed.length, limit, offset);
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope === "daily") clauses.push("EXISTS (SELECT 1 FROM workbench_project_meta m WHERE m.project_id = a.project_id AND m.lifecycle = 'active' AND m.classification IN ('production', 'unclassified'))");
  if (scope === "unassigned") clauses.push("(a.project_id IS NULL OR a.project_id = '' OR NOT EXISTS (SELECT 1 FROM workbench_project_meta m WHERE m.project_id = a.project_id))");
  if (input.project_id) { clauses.push("a.project_id = ?"); params.push(input.project_id); }
  if (input.type) { clauses.push("a.artifact_type = ?"); params.push(input.type); }
  if (input.role) { clauses.push("a.role = ?"); params.push(input.role); }
  if (input.status) { clauses.push("a.status = ?"); params.push(input.status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts a ${where}`).get(...params) as { count: number };
  const rows = db.prepare(`SELECT a.data_json FROM media_artifacts a ${where} ORDER BY a.updated_at DESC, a.artifact_id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{ data_json: string }>;
  return page(rows.map((row) => parseJson<Record<string, unknown>>(row.data_json, {})), countRow.count, limit, offset);
}

function assetLikeProjectId(item: Record<string, unknown>): string {
  if (typeof item.project_id === "string") return item.project_id;
  const linked = item.linked_objects;
  if (linked && typeof linked === "object" && typeof (linked as Record<string, unknown>).project_id === "string") return String((linked as Record<string, unknown>).project_id);
  return "";
}

export function listWorkbenchReports(input: { limit?: number; offset?: number } = {}): WorkbenchPage<Record<string, unknown>> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const all = listH1Reports();
  return page(all.slice(offset, offset + limit) as unknown as Record<string, unknown>[], all.length, limit, offset);
}

export function getWorkbenchReport(name: string): WorkbenchV2Result<Record<string, unknown>> {
  const filename = basename(name);
  if (!filename || filename !== name || !filename.endsWith(".json")) {
    return { ok: false, error: { code: "REPORT_NOT_FOUND", message: "Report was not found." } };
  }
  const known = listH1Reports().some((report) => String((report as unknown as Record<string, unknown>).name ?? "") === filename);
  if (!known) return { ok: false, error: { code: "REPORT_NOT_FOUND", message: "Report was not found." } };
  try {
    const value = JSON.parse(readFileSync(resolve(paths.reportsRoot, filename), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: { code: "REPORT_INVALID", message: "Report must contain a JSON object." } };
    }
    return { ok: true, data: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: { code: "REPORT_INVALID", message: "Report could not be parsed." } };
  }
}

function shotFromH1(projectId: string, shot: H1WorkbenchState["shots"][number]): Shot {
  return {
    shot_id: shot.shot_id,
    project_id: projectId,
    order: shot.order,
    status: shot.approval_status === "approved" ? "storyboard_approved" : shot.approval_status === "revision_needed" ? "revision_needed" : "draft",
    duration_seconds: shot.duration_seconds,
    description: shot.description,
    storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
}

export function migrateH1StateToWorkbenchV2(db = openM0Database()): Record<string, unknown> {
  const prior = db.prepare("SELECT value FROM m0_meta WHERE key = 'workbench_v2_h1_migrated_at'").get() as { value: string } | undefined;
  if (prior) {
    const project = db.prepare("SELECT value FROM m0_meta WHERE key = 'workbench_v2_h1_project_id'").get() as { value: string } | undefined;
    return { migrated: false, already_migrated_at: prior.value, target_project_id: project?.value ?? "" };
  }
  const state = loadH1WorkbenchState();
  const createdProjects: string[] = [];
  const createdShots: string[] = [];
  const unresolvedImports: string[] = [];
  let projectId = state.project.project_id;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!projectId) {
      const created = createProject({
        title: state.project.title,
        project_type: state.project.project_type,
        video_spec: { duration_seconds: state.project.duration_seconds, aspect_ratio: state.project.aspect_ratio, resolution: state.project.resolution }
      }, db);
      if (!created.ok) throw new Error(created.error.message);
      projectId = created.project_id;
      createdProjects.push(projectId);
    } else if (!getProject(db, projectId)) {
      const project: Project = {
        project_id: projectId,
        title: state.project.title,
        project_type: state.project.project_type,
        status: "draft",
        brief: {},
        video_spec: { duration_seconds: state.project.duration_seconds, aspect_ratio: state.project.aspect_ratio, resolution: state.project.resolution },
        shot_ids: [], active_storyboard_package_id: "", generation_batch_ids: [], exports: { final_video_artifact_id: "" }
      };
      saveProject(db, project);
      createdProjects.push(projectId);
    }
    ensureProjectMeta(db, projectId);
    const project = getProject(db, projectId) as Project;
    for (const h1Shot of state.shots) {
      if (getShot(db, h1Shot.shot_id)) continue;
      const shot = shotFromH1(projectId, h1Shot);
      saveShot(db, shot);
      project.shot_ids.push(shot.shot_id);
      createdShots.push(shot.shot_id);
    }
    saveProject(db, project);
    for (const rejected of state.rejected_imports) {
      const indexed = db.prepare("SELECT checksum FROM import_index WHERE filename = ? LIMIT 1").get(rejected.import_filename) as { checksum: string } | undefined;
      if (!indexed) {
        unresolvedImports.push(rejected.import_filename);
        continue;
      }
      db.prepare(`
        INSERT OR IGNORE INTO import_decisions (checksum, filename, decision, reason, created_at, updated_at)
        VALUES (?, ?, 'excluded', ?, ?, ?)
      `).run(indexed.checksum, rejected.import_filename, rejected.reason, rejected.rejected_at, rejected.rejected_at);
    }
    for (const draft of state.regeneration_request_drafts) {
      const shot = getShot(db, draft.shot_id);
      if (!shot) continue;
      db.prepare(`
        INSERT OR IGNORE INTO regeneration_requests (request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      `).run(draft.draft_id, shot.project_id, draft.shot_id, draft.artifact_id, draft.previous_run_id, JSON.stringify({ ...draft, project_id: shot.project_id }), draft.created_at, draft.created_at);
    }
    const migratedAt = now();
    db.prepare("INSERT INTO m0_meta (key, value, updated_at) VALUES ('workbench_v2_h1_migrated_at', ?, CURRENT_TIMESTAMP)").run(migratedAt);
    db.prepare("INSERT INTO m0_meta (key, value, updated_at) VALUES ('workbench_v2_h1_project_id', ?, CURRENT_TIMESTAMP)").run(projectId);
    db.prepare("UPDATE workbench_project_meta SET pinned = 1, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?").run(projectId);
    db.exec("COMMIT");
    const suggestions = db.prepare(`
      SELECT project_id, json_extract(data_json, '$.title') AS title FROM projects
      WHERE lower(json_extract(data_json, '$.title')) LIKE '%test%'
      ORDER BY updated_at DESC LIMIT 100
    `).all() as Array<{ project_id: string; title: string }>;
    return {
      migrated: true,
      migrated_at: migratedAt,
      h1_source_kept_read_only: true,
      target_project_id: projectId,
      created_projects: createdProjects,
      created_shots: createdShots,
      rejected_imports_unresolved: unresolvedImports,
      test_classification_suggestions: suggestions,
      automatic_classification_changes: 0,
      deleted_or_hidden_records: 0
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
