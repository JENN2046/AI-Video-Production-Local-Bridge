import { createHash, randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";

export const GOVERNANCE_RULE_VERSION = "workbench-governance-v1";

export type GovernanceRuleId =
  | "m0"
  | "m1"
  | "fixtures"
  | "g0"
  | "h1_test"
  | "h3_review"
  | "h4_assembly"
  | "assistant_gpt_test"
  | "memory_saveback"
  | "pipeline_validation"
  | "orphan_duplicate";

export interface GovernanceCandidate {
  project_id: string;
  title: string;
  updated_at: string;
  rule_id: GovernanceRuleId;
}

export interface GovernanceGroup {
  rule_id: GovernanceRuleId;
  label: string;
  count: number;
  samples: Array<{ project_id: string; title: string }>;
}

export interface GovernancePreview {
  rule_version: typeof GOVERNANCE_RULE_VERSION;
  snapshot_hash: string;
  groups: GovernanceGroup[];
  candidate_count: number;
  unmatched_count: number;
  action: "classify_test_and_archive";
  generated_at: string;
}

type GovernanceError = { code: string; message: string; field?: string };
type GovernanceResult<T> = { ok: true; data: T } | { ok: false; error: GovernanceError };

const RULE_LABELS: Record<GovernanceRuleId, string> = {
  m0: "M0 测试项目",
  m1: "M1 测试项目",
  fixtures: "固定测试夹具",
  g0: "G0 测试项目",
  h1_test: "H1 Test",
  h3_review: "H3 Review",
  h4_assembly: "H4 Assembly",
  assistant_gpt_test: "Assistant / GPT Test",
  memory_saveback: "Memory Saveback 验证项目",
  pipeline_validation: "R1 / R2 / R3 流水线验证",
  orphan_duplicate: "无实际 SHOT 的重复导入"
};

const FIXTURE_TITLES = new Set([
  "unapproved",
  "storyboard import",
  "pending artifact",
  "missing prompt",
  "inaccessible artifact",
  "invalid storyboard aspect"
]);

export function governanceRuleForTitle(title: string): GovernanceRuleId | null {
  const normalized = title.trim().toLowerCase();
  if (/^m0(\b|[-.])/.test(normalized)) return "m0";
  if (/^m1(\b|[-.])/.test(normalized)) return "m1";
  if (FIXTURE_TITLES.has(normalized)) return "fixtures";
  if (/^g0(\b|[-.])/.test(normalized)) return "g0";
  if (/^h1 test(\b|[-.])/.test(normalized)) return "h1_test";
  if (/^h3 review(\b|[-.])/.test(normalized)) return "h3_review";
  if (/^h4 assembly(\b|[-.])/.test(normalized)) return "h4_assembly";
  if (/(assistant test|gpt handoff test)$/.test(normalized)) return "assistant_gpt_test";
  if (/memory saveback/.test(normalized)) return "memory_saveback";
  if (/^r[1-3]-\d+/.test(normalized) || normalized === "debug") return "pipeline_validation";
  return null;
}

function governanceRuleForProject(input: { title: string; project_type: string; status: string; shot_count: number }): GovernanceRuleId | null {
  const titleRule = governanceRuleForTitle(input.title);
  if (titleRule) return titleRule;
  if (
    input.title.trim().toLowerCase() === "ryan's lunch break skullcap"
    && input.project_type === "g0_r1_webgpt_product_ad"
    && input.status === "storyboard_approved"
    && input.shot_count === 0
  ) return "orphan_duplicate";
  return null;
}

export function getWorkbenchGovernancePreview(db = openM0Database()): GovernancePreview {
  const rows = db.prepare(`
    SELECT p.project_id, json_extract(p.data_json, '$.title') AS title,
      json_extract(p.data_json, '$.project_type') AS project_type,
      json_extract(p.data_json, '$.status') AS status,
      (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.project_id) AS shot_count,
      p.updated_at
    FROM projects p
    JOIN workbench_project_meta m ON m.project_id = p.project_id
    WHERE m.classification = 'unclassified' AND m.lifecycle = 'active'
    ORDER BY p.project_id
  `).all() as Array<{ project_id: string; title: string | null; project_type: string | null; status: string | null; shot_count: number; updated_at: string }>;
  const candidates: GovernanceCandidate[] = [];
  let unmatchedCount = 0;
  for (const row of rows) {
    const title = row.title ?? "";
    const ruleId = governanceRuleForProject({ title, project_type: row.project_type ?? "", status: row.status ?? "", shot_count: row.shot_count });
    if (!ruleId) {
      unmatchedCount += 1;
      continue;
    }
    candidates.push({ project_id: row.project_id, title, updated_at: row.updated_at, rule_id: ruleId });
  }
  const groupOrder = Object.keys(RULE_LABELS) as GovernanceRuleId[];
  const groups = groupOrder.map((ruleId) => {
    const matching = candidates.filter((candidate) => candidate.rule_id === ruleId);
    return {
      rule_id: ruleId,
      label: RULE_LABELS[ruleId],
      count: matching.length,
      samples: matching.slice(0, 10).map(({ project_id, title }) => ({ project_id, title }))
    };
  });
  const snapshotHash = createHash("sha256")
    .update(GOVERNANCE_RULE_VERSION)
    .update("\n")
    .update(candidates.map((candidate) => `${candidate.rule_id}:${candidate.project_id}:${candidate.updated_at}`).join("\n"))
    .digest("hex");
  return {
    rule_version: GOVERNANCE_RULE_VERSION,
    snapshot_hash: snapshotHash,
    groups,
    candidate_count: candidates.length,
    unmatched_count: unmatchedCount,
    action: "classify_test_and_archive",
    generated_at: new Date().toISOString()
  };
}

export function applyWorkbenchGovernance(
  input: { rule_groups: string[]; snapshot_hash: string },
  db = openM0Database()
): GovernanceResult<{ affected_count: number; selected_groups: GovernanceRuleId[]; preview: GovernancePreview; run_id: string }> {
  const selected = [...new Set(input.rule_groups)] as GovernanceRuleId[];
  if (selected.length === 0) return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "At least one governance rule group is required.", field: "rule_groups" } };
  if (selected.some((ruleId) => !(ruleId in RULE_LABELS))) {
    return { ok: false, error: { code: "INVALID_FIELD", message: "Unknown governance rule group.", field: "rule_groups" } };
  }
  const before = getWorkbenchGovernancePreview(db);
  if (!input.snapshot_hash || input.snapshot_hash !== before.snapshot_hash) {
    return { ok: false, error: { code: "GOVERNANCE_SNAPSHOT_STALE", message: "Governance candidates changed. Refresh the preview before applying." } };
  }
  const rows = db.prepare(`
    SELECT p.project_id, json_extract(p.data_json, '$.title') AS title,
      json_extract(p.data_json, '$.project_type') AS project_type,
      json_extract(p.data_json, '$.status') AS status,
      (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.project_id) AS shot_count
    FROM projects p
    JOIN workbench_project_meta m ON m.project_id = p.project_id
    WHERE m.classification = 'unclassified' AND m.lifecycle = 'active'
    ORDER BY p.project_id
  `).all() as Array<{ project_id: string; title: string | null; project_type: string | null; status: string | null; shot_count: number }>;
  const projectIds = rows
    .filter((row) => {
      const ruleId = governanceRuleForProject({ title: row.title ?? "", project_type: row.project_type ?? "", status: row.status ?? "", shot_count: row.shot_count });
      return ruleId !== null && selected.includes(ruleId);
    })
    .map((row) => row.project_id);
  const runId = `governance_${randomUUID()}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare(`
      UPDATE workbench_project_meta
      SET classification = 'test', lifecycle = 'archived', pinned = 0, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND classification = 'unclassified' AND lifecycle = 'active'
    `);
    let affectedCount = 0;
    for (const projectId of projectIds) {
      const result = update.run(projectId) as { changes: number | bigint };
      affectedCount += Number(result.changes);
    }
    if (affectedCount !== projectIds.length) throw new Error("Governance candidate set changed during apply.");
    db.prepare(`
      INSERT INTO workbench_governance_runs (run_id, snapshot_hash, rule_groups_json, affected_count, result)
      VALUES (?, ?, ?, ?, 'applied')
    `).run(runId, before.snapshot_hash, JSON.stringify(selected), affectedCount);
    db.exec("COMMIT");
    return { ok: true, data: { affected_count: affectedCount, selected_groups: selected, preview: getWorkbenchGovernancePreview(db), run_id: runId } };
  } catch (error) {
    db.exec("ROLLBACK");
    return { ok: false, error: { code: "GOVERNANCE_APPLY_FAILED", message: error instanceof Error ? error.message : "Governance apply failed." } };
  }
}
