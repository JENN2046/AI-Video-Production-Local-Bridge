import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { paths } from "../paths.js";
import type { M0Database } from "../storage/sqlite.js";

const MIGRATION_KEY = "webgpt_v4_legacy_history_migrated_at";

interface LegacyStore {
  drafts?: Array<Record<string, unknown>>;
  plans?: Array<Record<string, unknown>>;
}

function parseStore(path: string): { hash: string; value: LegacyStore } {
  if (!existsSync(path)) return { hash: "", value: {} };
  const bytes = readFileSync(path);
  let value: LegacyStore = {};
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as LegacyStore;
  } catch {
    value = {};
  }
  return { hash: createHash("sha256").update(bytes).digest("hex"), value };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function insertClosedDraft(db: M0Database, input: {
  id: string;
  tool: string;
  created_at: string;
  updated_at: string;
  project_id: string;
  shot_id: string;
  payload: Record<string, unknown>;
  legacy_kind: string;
}): number {
  const stored = {
    draft_id: input.id,
    tool: input.tool,
    status: "closed",
    source: "legacy_webgpt",
    created_at: input.created_at,
    updated_at: input.updated_at,
    target_project_id: input.project_id,
    target_shot_id: input.shot_id,
    payload: input.payload,
    legacy_kind: input.legacy_kind
  };
  const result = db.prepare(`
    INSERT OR IGNORE INTO workbench_drafts (
      draft_id, tool, status, source, target_project_id, target_shot_id,
      revision_note, data_json, created_at, updated_at
    ) VALUES (?, ?, 'closed', 'legacy_webgpt', ?, ?, '', ?, ?, ?)
  `).run(input.id, input.tool, input.project_id || null, input.shot_id || null, JSON.stringify(stored), input.created_at, input.updated_at) as { changes: number | bigint };
  return Number(result.changes);
}

export function migrateLegacyWebGptV4History(db: M0Database, dataRoot = paths.dataRoot): {
  migrated: boolean;
  review_drafts: number;
  production_plans: number;
  inserted: number;
  source_hashes: Record<string, string>;
  source_json_written: false;
} {
  const review = parseStore(join(dataRoot, "webgpt", "review_assistant_drafts.json"));
  const production = parseStore(join(dataRoot, "webgpt", "production_assistant_plans.json"));
  const sourceHashes = { review_assistant_drafts: review.hash, production_assistant_plans: production.hash };
  const reviewDrafts = Array.isArray(review.value.drafts) ? review.value.drafts : [];
  const productionPlans = Array.isArray(production.value.plans) ? production.value.plans : [];
  const prior = db.prepare("SELECT value FROM m0_meta WHERE key = ?").get(MIGRATION_KEY) as { value: string } | undefined;
  if (prior) {
    return { migrated: false, review_drafts: reviewDrafts.length, production_plans: productionPlans.length, inserted: 0, source_hashes: sourceHashes, source_json_written: false };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    let inserted = 0;
    for (const item of reviewDrafts) {
      const linked = record(item.linked);
      inserted += insertClosedDraft(db, {
        id: text(item.review_draft_id) || `legacy_review_${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24)}`,
        tool: text(item.tool) || "legacy_review_draft",
        created_at: text(item.created_at) || new Date(0).toISOString(),
        updated_at: text(item.updated_at) || text(item.created_at) || new Date(0).toISOString(),
        project_id: text(linked.project_id),
        shot_id: text(linked.shot_id),
        payload: record(item.payload),
        legacy_kind: "review_assistant_draft"
      });
    }
    for (const item of productionPlans) {
      const linked = record(item.linked);
      inserted += insertClosedDraft(db, {
        id: text(item.plan_id) || `legacy_plan_${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24)}`,
        tool: text(item.tool) || "legacy_production_plan",
        created_at: text(item.created_at) || new Date(0).toISOString(),
        updated_at: text(item.updated_at) || text(item.created_at) || new Date(0).toISOString(),
        project_id: text(linked.project_id),
        shot_id: text(linked.shot_id),
        payload: record(item.payload),
        legacy_kind: "production_assistant_plan"
      });
    }
    db.prepare("INSERT INTO m0_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(MIGRATION_KEY, JSON.stringify({ migrated_at: new Date().toISOString(), source_hashes: sourceHashes, inserted }));
    db.exec("COMMIT");
    return { migrated: true, review_drafts: reviewDrafts.length, production_plans: productionPlans.length, inserted, source_hashes: sourceHashes, source_json_written: false };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
