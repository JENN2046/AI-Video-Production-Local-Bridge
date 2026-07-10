import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";

export type WorkbenchDraftStatus = "pending" | "revision_needed" | "promoted" | "closed";
export type WorkbenchPendingStatus = "pending" | "executed" | "rejected" | "failed";

export interface WorkbenchDraftRecord extends Record<string, unknown> {
  draft_id: string;
  tool: string;
  status: WorkbenchDraftStatus;
  source: string;
  created_at: string;
  updated_at: string;
  payload: Record<string, unknown>;
  parent_draft_id?: string;
  target_project_id?: string;
  target_shot_id?: string;
  promoted_object_type?: string;
  promoted_object_id?: string;
  revision_note?: string;
}

export interface WorkbenchPendingActionRecord extends Record<string, unknown> {
  action_id: string;
  tool: string;
  status: WorkbenchPendingStatus;
  source: string;
  created_at: string;
  updated_at: string;
  payload: Record<string, unknown>;
  project_id?: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeDraftStatus(value: unknown): WorkbenchDraftStatus {
  return value === "revision_needed" || value === "promoted" || value === "closed" ? value : "pending";
}

function normalizePendingStatus(value: unknown): WorkbenchPendingStatus {
  return value === "executed" || value === "rejected" || value === "failed" ? value : "pending";
}

export function saveWorkbenchDraftRecord(input: Record<string, unknown>, db = openM0Database()): WorkbenchDraftRecord {
  const createdAt = typeof input.created_at === "string" ? input.created_at : new Date().toISOString();
  const updatedAt = typeof input.updated_at === "string" ? input.updated_at : createdAt;
  const record: WorkbenchDraftRecord = {
    ...input,
    draft_id: String(input.draft_id ?? `webgpt_draft_${randomUUID()}`),
    tool: String(input.tool ?? "unknown"),
    status: normalizeDraftStatus(input.status),
    source: String(input.source ?? "webgpt_bridge_v0_5"),
    created_at: createdAt,
    updated_at: updatedAt,
    payload: input.payload && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {}
  };
  db.prepare(`
    INSERT INTO workbench_drafts (
      draft_id, tool, status, source, parent_draft_id, target_project_id, target_shot_id,
      promoted_object_type, promoted_object_id, revision_note, data_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(draft_id) DO UPDATE SET
      tool = excluded.tool,
      status = excluded.status,
      source = excluded.source,
      parent_draft_id = excluded.parent_draft_id,
      target_project_id = excluded.target_project_id,
      target_shot_id = excluded.target_shot_id,
      promoted_object_type = excluded.promoted_object_type,
      promoted_object_id = excluded.promoted_object_id,
      revision_note = excluded.revision_note,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(
    record.draft_id,
    record.tool,
    record.status,
    record.source,
    String(record.parent_draft_id ?? "") || null,
    String(record.target_project_id ?? "") || null,
    String(record.target_shot_id ?? "") || null,
    String(record.promoted_object_type ?? "") || null,
    String(record.promoted_object_id ?? "") || null,
    String(record.revision_note ?? ""),
    JSON.stringify(record),
    record.created_at,
    record.updated_at
  );
  return record;
}

export function listWorkbenchDraftRecords(db = openM0Database()): WorkbenchDraftRecord[] {
  const rows = db.prepare(`
    SELECT draft_id, tool, status, source, parent_draft_id, target_project_id, target_shot_id,
      promoted_object_type, promoted_object_id, revision_note, data_json, created_at, updated_at
    FROM workbench_drafts ORDER BY created_at, draft_id
  `).all() as Array<Record<string, string | null>>;
  return rows.map((row) => ({
    ...parseJson<Record<string, unknown>>(String(row.data_json), {}),
    draft_id: String(row.draft_id),
    tool: String(row.tool),
    status: normalizeDraftStatus(row.status),
    source: String(row.source),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    payload: parseJson<Record<string, unknown>>(String(row.data_json), {}).payload as Record<string, unknown> ?? {},
    parent_draft_id: row.parent_draft_id ?? "",
    target_project_id: row.target_project_id ?? "",
    target_shot_id: row.target_shot_id ?? "",
    promoted_object_type: row.promoted_object_type ?? "",
    promoted_object_id: row.promoted_object_id ?? "",
    revision_note: row.revision_note ?? ""
  }));
}

export function getWorkbenchDraftRecord(draftId: string, db = openM0Database()): WorkbenchDraftRecord | null {
  return listWorkbenchDraftRecords(db).find((record) => record.draft_id === draftId) ?? null;
}

export function saveWorkbenchPendingActionRecord(input: Record<string, unknown>, db = openM0Database()): WorkbenchPendingActionRecord {
  const createdAt = typeof input.created_at === "string" ? input.created_at : new Date().toISOString();
  const updatedAt = typeof input.updated_at === "string" ? input.updated_at : createdAt;
  const record: WorkbenchPendingActionRecord = {
    ...input,
    action_id: String(input.action_id ?? `webgpt_action_${randomUUID()}`),
    tool: String(input.tool ?? "unknown"),
    status: normalizePendingStatus(input.status),
    source: String(input.source ?? "webgpt_bridge_v1"),
    created_at: createdAt,
    updated_at: updatedAt,
    payload: input.payload && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {}
  };
  db.prepare(`
    INSERT INTO workbench_pending_actions (action_id, tool, status, source, project_id, data_json, result_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(action_id) DO UPDATE SET
      tool = excluded.tool,
      status = excluded.status,
      source = excluded.source,
      project_id = excluded.project_id,
      data_json = excluded.data_json,
      result_json = excluded.result_json,
      updated_at = excluded.updated_at
  `).run(
    record.action_id,
    record.tool,
    record.status,
    record.source,
    String(record.project_id ?? record.payload.project_id ?? "") || null,
    JSON.stringify(record),
    JSON.stringify(record.execution ?? {}),
    record.created_at,
    record.updated_at
  );
  return record;
}

export function listWorkbenchPendingActionRecords(db = openM0Database()): WorkbenchPendingActionRecord[] {
  const rows = db.prepare(`
    SELECT action_id, tool, status, source, project_id, data_json, created_at, updated_at
    FROM workbench_pending_actions ORDER BY created_at, action_id
  `).all() as Array<Record<string, string | null>>;
  return rows.map((row) => {
    const parsed = parseJson<Record<string, unknown>>(String(row.data_json), {});
    return {
      ...parsed,
      action_id: String(row.action_id),
      tool: String(row.tool),
      status: normalizePendingStatus(row.status),
      source: String(row.source),
      project_id: row.project_id ?? "",
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      payload: parsed.payload && typeof parsed.payload === "object" ? parsed.payload as Record<string, unknown> : {}
    };
  });
}

export function getWorkbenchPendingActionRecord(actionId: string, db = openM0Database()): WorkbenchPendingActionRecord | null {
  return listWorkbenchPendingActionRecords(db).find((record) => record.action_id === actionId) ?? null;
}

export function appendWorkbenchInboxEvent(
  input: { object_type: "draft" | "pending_action"; object_id: string; event_type: string; from_status?: string; to_status?: string; data?: Record<string, unknown> },
  db = openM0Database()
): string {
  const eventId = `inbox_event_${randomUUID()}`;
  db.prepare(`
    INSERT INTO workbench_inbox_events (event_id, object_type, object_id, event_type, from_status, to_status, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, input.object_type, input.object_id, input.event_type, input.from_status ?? null, input.to_status ?? null, JSON.stringify(input.data ?? {}));
  return eventId;
}

export function migrateLegacyWorkbenchInboxStores(db = openM0Database()): { migrated: boolean; drafts: number; pending_actions: number; source_json_written: false } {
  const prior = db.prepare("SELECT value FROM m0_meta WHERE key = 'workbench_v2_1_inbox_migrated_at'").get() as { value: string } | undefined;
  if (prior) {
    const draftCount = db.prepare("SELECT COUNT(*) count FROM workbench_drafts").get() as { count: number };
    const actionCount = db.prepare("SELECT COUNT(*) count FROM workbench_pending_actions").get() as { count: number };
    return { migrated: false, drafts: draftCount.count, pending_actions: actionCount.count, source_json_written: false };
  }
  const draftStore = readLegacyStore(join(paths.dataRoot, "webgpt", "draft_submissions.json"), "drafts");
  const pendingStore = readLegacyStore(join(paths.dataRoot, "webgpt", "pending_actions.json"), "actions");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const draft of draftStore) saveWorkbenchDraftRecord({ ...draft, status: "pending" }, db);
    for (const action of pendingStore) saveWorkbenchPendingActionRecord(action, db);
    db.prepare(`
      INSERT INTO m0_meta (key, value, updated_at)
      VALUES ('workbench_v2_1_inbox_migrated_at', ?, CURRENT_TIMESTAMP)
    `).run(new Date().toISOString());
    db.exec("COMMIT");
    return { migrated: true, drafts: draftStore.length, pending_actions: pendingStore.length, source_json_written: false };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readLegacyStore(path: string, field: "drafts" | "actions"): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const parsed = parseJson<Record<string, unknown>>(readFileSync(path, "utf8"), {});
  const value = parsed[field];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}
