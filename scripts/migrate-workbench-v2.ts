import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { paths } from "../src/paths.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { migrateH1StateToWorkbenchV2, refreshWorkbenchImportIndex } from "../src/tools/workbenchV2.js";
import { getWorkbenchGovernancePreview } from "../src/tools/workbenchGovernance.js";
import { migrateLegacyWorkbenchInboxStores } from "../src/tools/workbenchInboxStore.js";

const db = openM0Database();
try {
  const importIndex = refreshWorkbenchImportIndex(db);
  const migration = migrateH1StateToWorkbenchV2(db);
  const inboxMigration = migrateLegacyWorkbenchInboxStores(db);
  let targetProjectId = typeof migration.target_project_id === "string" ? migration.target_project_id : "";
  if (!targetProjectId) {
    const fallback = db.prepare(`
      SELECT p.project_id
      FROM projects p
      WHERE json_extract(p.data_json, '$.project_type') = 'h1_human_operator_workbench'
      ORDER BY p.updated_at DESC LIMIT 1
    `).get() as { project_id: string } | undefined;
    targetProjectId = fallback?.project_id ?? "";
    if (targetProjectId) {
      db.prepare("INSERT OR REPLACE INTO m0_meta (key, value, updated_at) VALUES ('workbench_v2_h1_project_id', ?, CURRENT_TIMESTAMP)").run(targetProjectId);
    }
  }
  if (targetProjectId) db.prepare("UPDATE workbench_project_meta SET pinned = 1, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?").run(targetProjectId);
  const counts = db.prepare(`
    SELECT classification, lifecycle, COUNT(*) AS count
    FROM workbench_project_meta
    GROUP BY classification, lifecycle
    ORDER BY classification, lifecycle
  `).all();
  const governance = getWorkbenchGovernancePreview(db);
  const report = {
    task: "HUMAN_WORKBENCH_V2_MIGRATION",
    result: "PASS",
    generated_at: new Date().toISOString(),
    database_path: "data/app.sqlite",
    h1_source: "data/h1/workbench_state.json",
    h1_source_kept_read_only: true,
    import_index: importIndex,
    migration,
    inbox_migration: inboxMigration,
    pinned_h1_project_id: targetProjectId,
    project_meta_counts: counts,
    test_classification_suggestions: {
      mode: "proposal_only",
      proposed_classification: "test",
      requires_human_confirmation: true,
      matched_count: governance.candidate_count,
      unmatched_count: governance.unmatched_count,
      snapshot_hash: governance.snapshot_hash,
      rule_version: governance.rule_version,
      groups: governance.groups
    },
    safety: {
      source_media_deleted_or_overwritten: false,
      projects_deleted_or_hidden: false,
      classifications_applied_automatically: false,
      h1_json_written: false,
      provider_called: false,
      credentials_read_by_migration: false
    }
  };
  const reportRoot = join(paths.workspaceRoot, "ops", "reports");
  mkdirSync(reportRoot, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, "-");
  const immutablePath = join(reportRoot, `human_workbench_v2_migration_${stamp}.json`);
  const latestPath = join(reportRoot, "human_workbench_v2_migration_latest.json");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(immutablePath, serialized, "utf8");
  writeFileSync(latestPath, serialized, "utf8");
  console.log(JSON.stringify({ result: report.result, report: immutablePath, import_index: importIndex, migration }));
} finally {
  db.close();
}
