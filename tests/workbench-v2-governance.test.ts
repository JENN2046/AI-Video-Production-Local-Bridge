import assert from "node:assert/strict";
import test from "node:test";

import { openM0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject } from "../src/tools/projects.js";
import { applyWorkbenchGovernance, getWorkbenchGovernancePreview } from "../src/tools/workbenchGovernance.js";
import { createWorkbenchProject, getWorkbenchProjectSummary, listWorkbenchProjects, setWorkbenchProjectLifecycle, updateWorkbenchProject } from "../src/tools/workbenchV2.js";

test("governance preview is grouped and stale snapshots fail closed", () => {
  const db = openM0Database(":memory:");
  try {
    const first = createProject({ title: "M0 fixture one" }, db);
    const retained = createProject({ title: "Client launch" }, db);
    assert.equal(first.ok, true);
    assert.equal(retained.ok, true);
    const initial = getWorkbenchGovernancePreview(db);
    assert.equal(initial.groups.find((group) => group.rule_id === "m0")?.count, 1);
    assert.equal(initial.unmatched_count, 1);

    assert.equal(createProject({ title: "M0 fixture two" }, db).ok, true);
    const stale = applyWorkbenchGovernance({ rule_groups: ["m0"], snapshot_hash: initial.snapshot_hash }, db);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "GOVERNANCE_SNAPSHOT_STALE");

    const current = getWorkbenchGovernancePreview(db);
    const applied = applyWorkbenchGovernance({ rule_groups: ["m0"], snapshot_hash: current.snapshot_hash }, db);
    assert.equal(applied.ok, true);
    if (!applied.ok || !first.ok || !retained.ok) return;
    assert.equal(applied.data.affected_count, 2);
    const governed = db.prepare("SELECT classification, lifecycle FROM workbench_project_meta WHERE project_id = ?").get(first.project_id) as { classification: string; lifecycle: string };
    assert.equal(governed.classification, "test");
    assert.equal(governed.lifecycle, "archived");
    const untouched = db.prepare("SELECT classification, lifecycle FROM workbench_project_meta WHERE project_id = ?").get(retained.project_id) as { classification: string; lifecycle: string };
    assert.equal(untouched.classification, "unclassified");
    assert.equal(untouched.lifecycle, "active");
  } finally {
    db.close();
  }
});

test("daily scope excludes test and archived projects", () => {
  const db = openM0Database(":memory:");
  try {
    const production = createWorkbenchProject({ title: "Daily production", classification: "production" }, db);
    const testProject = createWorkbenchProject({ title: "Visible only by filter", classification: "test" }, db);
    const imported = createProject({ title: "External unclassified" }, db);
    const archived = createWorkbenchProject({ title: "Archived production", classification: "production" }, db);
    assert.equal(production.ok && testProject.ok && imported.ok && archived.ok, true);
    if (!production.ok || !testProject.ok || !imported.ok || !archived.ok) return;
    assert.equal(setWorkbenchProjectLifecycle(archived.data.project.project_id, "archived", db).ok, true);
    const daily = listWorkbenchProjects({ scope: "daily", limit: 20 }, db);
    const ids = new Set(daily.items.map((item) => item.project.project_id));
    assert.equal(ids.has(production.data.project.project_id), true);
    assert.equal(ids.has(imported.project_id), true);
    assert.equal(ids.has(testProject.data.project.project_id), false);
    assert.equal(ids.has(archived.data.project.project_id), false);
  } finally {
    db.close();
  }
});

test("secondary governance isolates validation projects and orphan duplicates", () => {
  const db = openM0Database(":memory:");
  try {
    assert.equal(createProject({ title: "Memory Saveback abc123" }, db).ok, true);
    assert.equal(createProject({ title: "R2-4 H4 Workbench abc123" }, db).ok, true);
    assert.equal(createProject({ title: "debug" }, db).ok, true);
    const duplicate = createProject({ title: "Ryan's Lunch Break Skullcap", project_type: "g0_r1_webgpt_product_ad" }, db);
    const delivered = createProject({ title: "Ryan's Lunch Break Skullcap", project_type: "g0_r1_webgpt_product_ad" }, db);
    assert.equal(duplicate.ok && delivered.ok, true);
    if (!duplicate.ok || !delivered.ok) return;
    duplicate.project.status = "storyboard_approved";
    delivered.project.status = "final_approved";
    saveProject(db, duplicate.project);
    saveProject(db, delivered.project);

    const preview = getWorkbenchGovernancePreview(db);
    assert.equal(preview.groups.find((group) => group.rule_id === "memory_saveback")?.count, 1);
    assert.equal(preview.groups.find((group) => group.rule_id === "pipeline_validation")?.count, 2);
    assert.equal(preview.groups.find((group) => group.rule_id === "orphan_duplicate")?.count, 1);
    assert.equal(preview.unmatched_count, 1);
    const applied = applyWorkbenchGovernance({ rule_groups: ["memory_saveback", "pipeline_validation", "orphan_duplicate"], snapshot_hash: preview.snapshot_hash }, db);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.data.affected_count, 4);
    const deliveredMeta = db.prepare("SELECT classification, lifecycle FROM workbench_project_meta WHERE project_id = ?").get(delivered.project_id) as { classification: string; lifecycle: string };
    assert.equal(deliveredMeta.classification, "unclassified");
    assert.equal(deliveredMeta.lifecycle, "active");
  } finally {
    db.close();
  }
});

test("manual next action exposes the derived suggestion and expires on stage change or time", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Override project", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const projectId = created.data.project.project_id;
    assert.equal(updateWorkbenchProject(projectId, { next_action_override: { label: "Call the client", priority: "urgent" } }, db).ok, true);
    const overridden = getWorkbenchProjectSummary(projectId, db);
    assert.equal(overridden?.next_action.source, "override");
    assert.equal(overridden?.next_action.label, "Call the client");
    assert.equal(overridden?.next_action.derived.label, "创建第一个 SHOT");

    created.data.project.status = "storyboard_approved";
    saveProject(db, created.data.project);
    assert.equal(getWorkbenchProjectSummary(projectId, db)?.next_action.source, "derived");

    assert.equal(updateWorkbenchProject(projectId, { next_action_override: { label: "Temporary", priority: "normal" } }, db).ok, true);
    db.prepare("UPDATE workbench_project_meta SET next_action_expires_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ?").run(projectId);
    assert.equal(getWorkbenchProjectSummary(projectId, db)?.next_action.source, "derived");
  } finally {
    db.close();
  }
});
