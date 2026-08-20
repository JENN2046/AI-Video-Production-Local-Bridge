import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { paths } from "../src/paths.js";
import { confirmWorkbenchGeneration } from "../src/tools/workbenchGeneration.js";
import { decideWorkbenchPendingAction, transitionWorkbenchDraft } from "../src/tools/workbenchInbox.js";
import { saveWorkbenchPendingActionRecord } from "../src/tools/workbenchInboxStore.js";
import {
  approveWorkbenchDeliveryFixture,
  completeWorkbenchAssemblyFixture,
  completeWorkbenchExportFixture,
  ensureAcceptedAssemblyClipsFixture,
  insertWorkbenchExportFixture
} from "./workbench-delivery-test-helpers.js";
import { createProject, saveProject, saveShot, type Project, type Shot } from "../src/tools/projects.js";
import {
  addProductionReviewNote,
  closeProductionProposal,
  getProductionDeliveryStatus,
  getProductionProjectContext,
  getProductionReviewPackage,
  listProductionProjectMedia,
  listProductionProjectShots,
  listProductionProjects,
  prepareProductionGenerationIntent,
  reviseProductionProposal,
  submitProductionProposal,
  updateProductionShotCopy
} from "../src/webgpt-v4/domain.js";
import { migrateLegacyWebGptV4History } from "../src/webgpt-v4/migration.js";
import { readProjectContext, readReviewPackage, readShotList } from "../src/webgpt-v4/contracts.js";
import { actorFromSubject } from "../src/webgpt-v4/types.js";
import { buildProviderCapabilityKey, buildProviderPriceCacheKey, RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY } from "../src/tools/providerCapabilities.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { getProjectStatus } from "../src/tools/projects.js";
import { getWorkbenchDashboard, getWorkbenchProjectWorkspace, listWorkbenchProjects, type WorkbenchProjectSummary } from "../src/tools/workbenchV2.js";
import { verifyWorkbenchExportFileIdentity } from "../src/storage/workbenchExportIntegrity.js";

interface TestContext {
  root: string;
  db: M0Database;
  production: Project;
  productionShot: Shot;
  testProject: Project;
}

function setup(): TestContext {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-domain-"));
  const db = openM0Database(join(root, "app.sqlite"));
  const productionResult = createProject({ title: "Real production" }, db);
  const testResult = createProject({ title: "Fixture project" }, db);
  assert.equal(productionResult.ok, true);
  assert.equal(testResult.ok, true);
  if (!productionResult.ok || !testResult.ok) throw new Error("setup failed");
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(productionResult.project_id);
  db.prepare("UPDATE workbench_project_meta SET classification = 'test' WHERE project_id = ?").run(testResult.project_id);
  const shot: Shot = {
    shot_id: "shot_real_001",
    project_id: productionResult.project_id,
    order: 1,
    status: "storyboard_approved",
    duration_seconds: 6,
    description: "Original",
    storyboard_image_artifact_id: "artifact_storyboard_001",
    video_prompt: "Original prompt",
    negative_prompt: "",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  productionResult.project.shot_ids = [shot.shot_id];
  saveProject(db, productionResult.project);
  return { root, db, production: productionResult.project, productionShot: shot, testProject: testResult.project };
}

function teardown(context: TestContext): void {
  context.db.close();
  rmSync(context.root, { recursive: true, force: true });
}

const actor = actorFromSubject("auth0|jenn", ["projects.read", "shots.write", "reviews.write", "proposals.write", "generation.prepare"]);

function setProductionDeliveryProjectionFixture(
  context: TestContext,
  input: { status?: Project["status"]; final_artifact_id?: string }
): void {
  const row = context.db.prepare("SELECT data_json FROM projects WHERE project_id = ?")
    .get(context.production.project_id) as { data_json: string } | undefined;
  if (!row) throw new Error("production project fixture missing");
  const project = JSON.parse(row.data_json) as Project;
  if (input.status !== undefined) project.status = input.status;
  if (input.final_artifact_id !== undefined) {
    project.exports.final_video_artifact_id = input.final_artifact_id;
  }
  context.db.prepare(`UPDATE projects SET data_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = ?`).run(JSON.stringify(project), project.project_id);
  context.production = project;
}

function setProductionDeliveryProjectionDriftFixture(
  context: TestContext,
  input: { status?: Project["status"]; final_artifact_id?: string }
): void {
  const guard = (context.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
    AND name = 'workbench_delivery_project_content_guard'`).get() as { sql: string }).sql;
  context.db.exec("DROP TRIGGER workbench_delivery_project_content_guard");
  try {
    setProductionDeliveryProjectionFixture(context, input);
  } finally {
    context.db.exec(guard);
  }
}

function closeProductionProject(context: TestContext): void {
  const registered = registerMediaArtifact({
    artifact_type: "video",
    role: "final_video",
    source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
    linked_objects: { project_id: context.production.project_id }
  }, context.db);
  assert.equal(registered.ok, true, registered.ok ? "" : registered.error.code);
  if (!registered.ok) throw new Error("closed project final video fixture registration failed");

  setProductionDeliveryProjectionFixture(context, {
    status: "final_approved",
    final_artifact_id: registered.artifact.artifact_id
  });
  const now = "2026-08-14T00:00:00.000Z";
  const exportId = `export_${context.production.project_id}`;
  ensureAcceptedAssemblyClipsFixture(context.db, context.production.project_id);
  context.db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
    .run(now, context.production.project_id);
  completeWorkbenchAssemblyFixture(context.db, {
    project_id: context.production.project_id,
    artifact_id: registered.artifact.artifact_id,
    job_id: `job_webgpt_v4_closeout_assembly_${context.production.project_id}`,
    event_id: `event_webgpt_v4_closeout_assembly_${context.production.project_id}`,
    created_at: now
  });
  approveWorkbenchDeliveryFixture(context.db, {
    project_id: context.production.project_id,
    event_id: "event_webgpt_v4_closeout_accepted",
    created_at: now
  });
  insertWorkbenchExportFixture(context.db, { project_id: context.production.project_id,
    artifact_id: registered.artifact.artifact_id, export_id: exportId, created_at: now });
  completeWorkbenchExportFixture(context.db, {
    project_id: context.production.project_id,
    export_id: exportId,
    job_id: `job_webgpt_v4_closeout_export_${context.production.project_id}`,
    event_id: `event_webgpt_v4_closeout_export_${context.production.project_id}`,
    created_at: now
  });
  context.db.prepare(`INSERT INTO workbench_delivery_events
    (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
    VALUES (?, ?, 'closeout', 'exported', 'closed', ?, ?, 'CLOSEOUT_CONFIRMED', '{}', ?)`)
    .run(`event_closeout_${context.production.project_id}`, context.production.project_id,
      registered.artifact.artifact_id, exportId, now);
}

function setProductionFinalEvidence(
  context: TestContext,
  target: "approved" | "exported"
): { artifact_id: string; export_id: string | null } {
  const registered = registerMediaArtifact({
    artifact_type: "video",
    role: "final_video",
    source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
    linked_objects: { project_id: context.production.project_id }
  }, context.db);
  assert.equal(registered.ok, true, registered.ok ? "" : registered.error.code);
  if (!registered.ok) throw new Error("final evidence fixture registration failed");
  const artifactId = registered.artifact.artifact_id;
  const now = "2026-08-15T01:00:00.000Z";
  ensureAcceptedAssemblyClipsFixture(context.db, context.production.project_id);
  setProductionDeliveryProjectionFixture(context, { final_artifact_id: artifactId });
  context.db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
    .run(now, context.production.project_id);
  completeWorkbenchAssemblyFixture(context.db, {
    project_id: context.production.project_id,
    artifact_id: artifactId,
    job_id: `job_webgpt_v4_final_assembly_${artifactId}`,
    event_id: `event_webgpt_v4_final_assembly_${artifactId}`,
    created_at: now
  });
  approveWorkbenchDeliveryFixture(context.db, {
    project_id: context.production.project_id,
    event_id: `event_webgpt_v4_accepted_${artifactId}`,
    created_at: now
  });
  if (target === "approved") return { artifact_id: artifactId, export_id: null };
  const exportId = `export_final_evidence_${context.production.project_id}`;
  insertWorkbenchExportFixture(context.db, { project_id: context.production.project_id,
    artifact_id: artifactId, export_id: exportId, created_at: now });
  completeWorkbenchExportFixture(context.db, {
    project_id: context.production.project_id,
    export_id: exportId,
    job_id: `job_webgpt_v4_final_export_${artifactId}`,
    event_id: `event_webgpt_v4_final_export_${artifactId}`,
    created_at: now
  });
  return { artifact_id: artifactId, export_id: exportId };
}

test("WebGPT V4 production mutations reject closed projects at the shared write boundary", () => {
  const context = setup();
  try {
    context.db.prepare(`UPDATE workbench_project_meta SET
      next_action_override = '遗留人工动作', next_action_priority = 'urgent',
      next_action_expires_at = '2099-01-01T00:00:00.000Z', next_action_project_status = ?
      WHERE project_id = ?`).run(context.production.status, context.production.project_id);
    closeProductionProject(context);
    const closedWorkspace = getWorkbenchProjectWorkspace(
      context.production.project_id,
      "overview",
      context.db,
      { touch_last_opened: false }
    );
    assert.equal(closedWorkspace.ok, true);
    if (closedWorkspace.ok) {
      const summary = closedWorkspace.data.summary as {
        next_action: { source: string; label: string; reason_code: string };
      };
      assert.deepEqual(summary.next_action, {
        source: "derived",
        label: "已结案",
        reason_code: "delivered",
        priority: "normal",
        expires_at: null,
        derived: { label: "已结案", reason_code: "delivered", priority: "normal" }
      });
    }
    const shotBefore = context.db.prepare("SELECT data_json, updated_at FROM shots WHERE shot_id = ?")
      .get(context.productionShot.shot_id) as { data_json: string; updated_at: string };
    const countsBefore = context.db.prepare(`SELECT
      (SELECT COUNT(*) FROM workbench_review_notes) AS notes,
      (SELECT COUNT(*) FROM workbench_drafts) AS drafts,
      (SELECT COUNT(*) FROM generation_intents) AS intents`).get() as { notes: number; drafts: number; intents: number };

    const results = [
      updateProductionShotCopy({
        project_id: context.production.project_id,
        shot_id: context.productionShot.shot_id,
        expected_updated_at: shotBefore.updated_at,
        description: "Closed projects must remain unchanged"
      }, { actor, idempotency_key: "closed-shot-copy" }, context.db),
      addProductionReviewNote({
        project_id: context.production.project_id,
        shot_id: context.productionShot.shot_id,
        note: "Closed projects must reject notes"
      }, { actor, idempotency_key: "closed-review-note" }, context.db),
      submitProductionProposal({
        project_id: context.production.project_id,
        kind: "final_assembly",
        payload: { notes: "Closed projects must reject proposals" }
      }, { actor, idempotency_key: "closed-submit-proposal" }, context.db),
      reviseProductionProposal({
        project_id: context.production.project_id,
        draft_id: "closed_missing_draft",
        payload: {}
      }, { actor, idempotency_key: "closed-revise-proposal" }, context.db),
      closeProductionProposal({
        project_id: context.production.project_id,
        draft_id: "closed_missing_draft",
        reason: "must reject before draft lookup"
      }, { actor, idempotency_key: "closed-close-proposal" }, context.db),
      prepareProductionGenerationIntent({
        project_id: context.production.project_id,
        shot_id: context.productionShot.shot_id,
        account_label: "personal",
        budget_limit_value: 100
      }, { actor, idempotency_key: "closed-generation-intent" }, context.db)
    ];

    for (const result of results) {
      assert.equal(result.ok, false, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.code, "PROJECT_CLOSED");
    }
    const shotAfter = context.db.prepare("SELECT data_json, updated_at FROM shots WHERE shot_id = ?")
      .get(context.productionShot.shot_id) as { data_json: string; updated_at: string };
    const countsAfter = context.db.prepare(`SELECT
      (SELECT COUNT(*) FROM workbench_review_notes) AS notes,
      (SELECT COUNT(*) FROM workbench_drafts) AS drafts,
      (SELECT COUNT(*) FROM generation_intents) AS intents`).get() as { notes: number; drafts: number; intents: number };
    assert.deepEqual(shotAfter, shotBefore);
    assert.deepEqual(countsAfter, countsBefore);
  } finally {
    teardown(context);
  }
});

test("WebGPT V4 SHOT copy cannot mutate approved or exported production evidence", () => {
  for (const target of ["approved", "exported"] as const) {
    const context = setup();
    try {
      const evidence = setProductionFinalEvidence(context, target);
      const shotBefore = context.db.prepare("SELECT data_json, updated_at FROM shots WHERE shot_id = ?")
        .get(context.productionShot.shot_id) as { data_json: string; updated_at: string };
      const deliveryBefore = context.db.prepare(`SELECT workflow_state, current_final_artifact_id,
        approved_artifact_id, latest_export_id FROM workbench_delivery_state WHERE project_id = ?`)
        .get(context.production.project_id) as Record<string, unknown>;

      const result = updateProductionShotCopy({
        project_id: context.production.project_id,
        shot_id: context.productionShot.shot_id,
        expected_updated_at: shotBefore.updated_at,
        video_prompt: `WebGPT must not mutate ${target} evidence`
      }, { actor, idempotency_key: `final-evidence-shot-copy-${target}` }, context.db);

      assert.equal(result.ok ? null : result.error.code, "DELIVERY_REWORK_REQUIRED");
      assert.deepEqual(context.db.prepare("SELECT data_json, updated_at FROM shots WHERE shot_id = ?")
        .get(context.productionShot.shot_id), shotBefore);
      assert.deepEqual({ ...(context.db.prepare(`SELECT workflow_state, current_final_artifact_id,
        approved_artifact_id, latest_export_id FROM workbench_delivery_state WHERE project_id = ?`)
        .get(context.production.project_id) as Record<string, unknown>) }, { ...deliveryBefore });
      assert.equal(deliveryBefore.current_final_artifact_id, evidence.artifact_id);
      assert.equal(deliveryBefore.latest_export_id, evidence.export_id);
    } finally {
      teardown(context);
    }
  }
});

test("Workbench delivery latest export follows the persisted pointer instead of history ordering", () => {
  const context = setup();
  try {
    const historicalArtifact = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: context.production.project_id }
    }, context.db);
    assert.equal(historicalArtifact.ok, true, historicalArtifact.ok ? "" : historicalArtifact.error.code);
    if (!historicalArtifact.ok) return;

    const createdAt = "2026-08-14T00:00:00.000Z";
    const historicalExportId = "zz_export_historical";
    insertWorkbenchExportFixture(context.db, { project_id: context.production.project_id,
      artifact_id: historicalArtifact.artifact.artifact_id, export_id: historicalExportId, created_at: createdAt });

    const withoutPointer = getWorkbenchProjectWorkspace(
      context.production.project_id,
      "delivery",
      context.db,
      { touch_last_opened: false }
    );
    assert.equal(withoutPointer.ok, true);
    if (withoutPointer.ok) assert.equal(withoutPointer.data.latest_export, null);

    closeProductionProject(context);
    const delivery = context.db.prepare(`SELECT latest_export_id FROM workbench_delivery_state WHERE project_id = ?`)
      .get(context.production.project_id) as { latest_export_id: string };
    const withPointer = getWorkbenchProjectWorkspace(
      context.production.project_id,
      "delivery",
      context.db,
      { touch_last_opened: false }
    );
    assert.equal(withPointer.ok, true);
    if (withPointer.ok) {
      const latest = withPointer.data.latest_export as { export_id: string; relative_path: string } | null;
      assert.equal(latest?.export_id, delivery.latest_export_id);
      assert.equal(latest?.relative_path, `data/exports/${context.production.project_id}/${delivery.latest_export_id}.mp4`);
    }

    const exportIds = (context.db.prepare(`SELECT export_id FROM workbench_exports WHERE project_id = ? ORDER BY export_id`)
      .all(context.production.project_id) as Array<{ export_id: string }>).map((row) => row.export_id);
    assert.deepEqual(exportIds, [delivery.latest_export_id, historicalExportId].sort());
    assert.throws(() => context.db.prepare("UPDATE workbench_exports SET relative_path = 'changed' WHERE export_id = ?")
      .run(historicalExportId), /WORKBENCH_EXPORT_IMMUTABLE/);
    assert.throws(() => context.db.prepare("DELETE FROM workbench_exports WHERE export_id = ?")
      .run(historicalExportId), /WORKBENCH_EXPORT_IMMUTABLE/);
  } finally {
    teardown(context);
  }
});

test("closed delivery stops claiming delivered when the current Export file drifts or disappears", () => {
  const context = setup();
  let exportPath = "";
  try {
    closeProductionProject(context);
    const initial = getProductionDeliveryStatus({ project_id: context.production.project_id }, context.db);
    assert.equal(initial.ok, true);
    if (initial.ok) assert.equal(initial.data.delivered, true);
    const initialWorkbench = getWorkbenchProjectWorkspace(
      context.production.project_id, "overview", context.db, { touch_last_opened: false }
    );
    assert.equal(initialWorkbench.ok, true);
    if (initialWorkbench.ok) {
      const summary = initialWorkbench.data.summary as WorkbenchProjectSummary | null;
      assert.equal(summary?.delivery_state, "delivered");
    }
    const currentExport = context.db.prepare(`SELECT export.export_id, export.project_id, export.artifact_id,
        export.relative_path, export.sha256, export.size_bytes, export.file_identity_sha256
      FROM workbench_delivery_state state
      JOIN workbench_exports export ON export.export_id = state.latest_export_id
      WHERE state.project_id = ?`).get(context.production.project_id) as {
        export_id: string;
        project_id: string;
        artifact_id: string;
        relative_path: string;
        sha256: string;
        size_bytes: number;
        file_identity_sha256: string;
      };
    exportPath = join(paths.exportsRoot, context.production.project_id, basename(currentExport.relative_path));

    const tamperedBytes = Buffer.from(readFileSync(exportPath));
    tamperedBytes[0] = tamperedBytes[0] === 0 ? 1 : tamperedBytes[0]! ^ 0xff;
    writeFileSync(exportPath, tamperedBytes);
    const stat = lstatSync(exportPath);
    currentExport.file_identity_sha256 = createHash("sha256").update(JSON.stringify({
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: stat.size,
      mtime_ms: String(stat.mtimeMs),
      ctime_ms: String(stat.ctimeMs)
    })).digest("hex");
    const immutableExportGuard = (context.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'workbench_exports_no_update'`).get() as { sql: string }).sql;
    context.db.exec("DROP TRIGGER workbench_exports_no_update");
    context.db.prepare("UPDATE workbench_exports SET file_identity_sha256 = ? WHERE export_id = ?")
      .run(currentExport.file_identity_sha256, currentExport.export_id);
    context.db.exec(immutableExportGuard);
    assert.equal(verifyWorkbenchExportFileIdentity(currentExport).ok, true);
    const drifted = getProductionDeliveryStatus({ project_id: context.production.project_id }, context.db);
    assert.equal(drifted.ok, true);
    if (drifted.ok) assert.equal(drifted.data.delivered, false);
    const driftedWorkbench = getWorkbenchProjectWorkspace(
      context.production.project_id, "overview", context.db, { touch_last_opened: false }
    );
    assert.equal(driftedWorkbench.ok, true);
    if (driftedWorkbench.ok) {
      const summary = driftedWorkbench.data.summary as WorkbenchProjectSummary | null;
      assert.equal(summary?.delivery_state, "final_review");
      assert.equal(summary?.next_action.reason_code, "export_integrity_failed");
      assert.equal(summary?.blocker_codes.includes("EXPORT_INTEGRITY_FAILED"), true);
    }

    rmSync(exportPath, { force: true });
    const missing = getProductionDeliveryStatus({ project_id: context.production.project_id }, context.db);
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.data.delivered, false);
    const missingWorkbench = getWorkbenchProjectWorkspace(
      context.production.project_id, "delivery", context.db, { touch_last_opened: false }
    );
    assert.equal(missingWorkbench.ok, true);
    if (missingWorkbench.ok) {
      const summary = missingWorkbench.data.summary as WorkbenchProjectSummary | null;
      assert.equal(summary?.delivery_state, "final_review");
    }
    const missingDashboard = getWorkbenchDashboard(context.db) as {
      totals: { blocked_projects: number };
      projects: WorkbenchProjectSummary[];
    };
    assert.equal(missingDashboard.projects[0]?.risk, "blocked");
    assert.equal(missingDashboard.totals.blocked_projects, 1);
  } finally {
    if (exportPath) rmSync(exportPath, { force: true });
    teardown(context);
  }
});

test("project lists use persisted Export identity while a project read performs the full verification", () => {
  const context = setup();
  try {
    closeProductionProject(context);
    const currentExport = context.db.prepare(`SELECT export.project_id, export.relative_path, export.sha256,
        export.size_bytes, export.file_identity_sha256
      FROM workbench_delivery_state state
      JOIN workbench_exports export ON export.export_id = state.latest_export_id
      WHERE state.project_id = ?`).get(context.production.project_id) as {
        project_id: string;
        relative_path: string;
        sha256: string;
        size_bytes: number;
        file_identity_sha256: string;
      };
    assert.equal(verifyWorkbenchExportFileIdentity(currentExport).ok, true);

    const listed = listWorkbenchProjects({ scope: "all", lifecycle: "all" }, context.db).items
      .find((item) => item.project.project_id === context.production.project_id);
    assert.equal(listed?.delivery_state, "delivered");

    const webgptList = listProductionProjects({}, context.db);
    assert.equal(webgptList.ok, true);
    if (webgptList.ok) {
      const item = webgptList.data.items.find((candidate) => {
        const project = candidate.project as { project_id?: string } | undefined;
        return project?.project_id === context.production.project_id;
      });
      assert.equal((item?.summary as WorkbenchProjectSummary | undefined)?.delivery_state, "delivered");
    }

    const workspace = getWorkbenchProjectWorkspace(
      context.production.project_id, "overview", context.db, { touch_last_opened: false }
    );
    assert.equal(workspace.ok, true);
    if (workspace.ok) {
      const summary = workspace.data.summary as WorkbenchProjectSummary | null;
      assert.equal(summary?.delivery_state, "delivered");
    }
    assert.equal(verifyWorkbenchExportFileIdentity(currentExport).ok, true);
  } finally {
    teardown(context);
  }
});

test("dashboard pending delivery follows the persisted closed state instead of legacy Project status", () => {
  const context = setup();
  try {
    ensureAcceptedAssemblyClipsFixture(context.db, context.production.project_id);
    const beforeClose = getWorkbenchDashboard(context.db) as { totals: { pending_delivery: number } };
    assert.equal(beforeClose.totals.pending_delivery, 1);

    closeProductionProject(context);
    setProductionDeliveryProjectionDriftFixture(context, { status: "video_review" });
    const afterClose = getWorkbenchDashboard(context.db) as { totals: { pending_delivery: number } };
    assert.equal(afterClose.totals.pending_delivery, 0);
  } finally {
    teardown(context);
  }
});

test("project-scoped reads fail closed when structured columns and JSON bindings drift", () => {
  const context = setup();
  try {
    const foreignProjectId = context.testProject.project_id;
    const driftedShot = { ...context.productionShot, project_id: foreignProjectId, description: "foreign body must not escape" };
    context.db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?").run(JSON.stringify(driftedShot), context.productionShot.shot_id);

    const shots = listProductionProjectShots({ project_id: context.production.project_id }, context.db);
    assert.equal(shots.ok, false);
    if (!shots.ok) assert.equal(shots.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION");

    const workspace = getProductionProjectContext({ project_id: context.production.project_id, workspace: "storyboard" }, context.db);
    assert.equal(workspace.ok, false);
    if (!workspace.ok) assert.equal(workspace.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION");

    context.db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?").run(JSON.stringify(context.productionShot), context.productionShot.shot_id);
    const artifact = {
      artifact_id: "artifact_drifted", artifact_type: "image", role: "storyboard_image", status: "active",
      storage: { uri: join(context.root, "drifted.png"), mime_type: "image/png", filename: "drifted.png" },
      metadata: { width: 1, height: 1, duration_seconds: null, aspect_ratio: "1:1", sha256: "drifted" },
      linked_objects: { project_id: foreignProjectId, shot_id: context.productionShot.shot_id },
      source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: "drifted", external_url_host: "" }
    };
    context.db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)")
      .run(artifact.artifact_id, context.production.project_id, context.productionShot.shot_id, JSON.stringify(artifact));
    const media = listProductionProjectMedia({ project_id: context.production.project_id }, context.db);
    assert.equal(media.ok, false);
    if (!media.ok) assert.equal(media.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION");
  } finally {
    teardown(context);
  }
});

test("project context ignores project_id keys inside free-form business metadata", () => {
  const context = setup();
  try {
    const stored = context.db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(context.production.project_id) as { data_json: string };
    const project = JSON.parse(stored.data_json) as Record<string, unknown>;
    project.brief = {
      client_reference: { project_id: "external-client-project" },
      provider_metadata: { project_id: "provider-side-project" }
    };
    context.db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run(JSON.stringify(project), context.production.project_id);

    const result = getProductionProjectContext({ project_id: context.production.project_id, workspace: "storyboard" }, context.db);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    teardown(context);
  }
});

test("project context rejects an artifact whose JSON id drifts from its bound slot", () => {
  const context = setup();
  try {
    const artifact = {
      artifact_id: "artifact_slot_b", artifact_type: "video", role: "generated_clip", status: "active",
      storage: { uri: join(context.root, "clip.mp4"), mime_type: "video/mp4", filename: "clip.mp4" },
      metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "slot-drift" },
      linked_objects: { project_id: context.production.project_id, shot_id: context.productionShot.shot_id },
      source: { kind: "provider_download", provider: "fixture", provider_job_id: "fixture-task", sha256: "slot-drift", external_url_host: "" }
    };
    context.db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES ('artifact_slot_a', ?, ?, 'generated_clip', 'video', 'active', ?)")
      .run(context.production.project_id, context.productionShot.shot_id, JSON.stringify(artifact));
    saveShot(context.db, { ...context.productionShot, accepted_clip_artifact_id: "artifact_slot_a" });

    const result = getProductionProjectContext({ project_id: context.production.project_id, workspace: "delivery" }, context.db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION");
  } finally {
    teardown(context);
  }
});

test("project context rejects an artifact whose JSON shot binding drifts within the project", () => {
  const context = setup();
  try {
    const secondShot: Shot = { ...context.productionShot, shot_id: "shot_same_project_other", order: 2, description: "Other shot" };
    saveShot(context.db, secondShot);
    const artifact = {
      artifact_id: "artifact_shot_binding", artifact_type: "video", role: "generated_clip", status: "active",
      storage: { uri: join(context.root, "bound-clip.mp4"), mime_type: "video/mp4", filename: "bound-clip.mp4" },
      metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "shot-drift" },
      linked_objects: { project_id: context.production.project_id, shot_id: secondShot.shot_id },
      source: { kind: "provider_download", provider: "fixture", provider_job_id: "fixture-shot-task", sha256: "shot-drift", external_url_host: "" }
    };
    context.db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES (?, ?, ?, 'generated_clip', 'video', 'active', ?)")
      .run(artifact.artifact_id, context.production.project_id, context.productionShot.shot_id, JSON.stringify(artifact));
    saveShot(context.db, { ...context.productionShot, accepted_clip_artifact_id: artifact.artifact_id });

    const result = getProductionProjectContext({ project_id: context.production.project_id, workspace: "delivery" }, context.db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION");
  } finally {
    teardown(context);
  }
});

test("storyboard context binds artifact map entries to the referencing shot", () => {
  const context = setup();
  try {
    const secondShot: Shot = { ...context.productionShot, shot_id: "shot_artifact_owner", order: 2, description: "Artifact owner" };
    saveShot(context.db, secondShot);
    const artifact = {
      artifact_id: "artifact_wrong_storyboard_owner", artifact_type: "image", role: "storyboard_image", status: "active",
      storage: { uri: join(context.root, "storyboard.png"), mime_type: "image/png", filename: "storyboard.png" },
      metadata: { width: 1080, height: 1920, duration_seconds: null, aspect_ratio: "9:16", sha256: "storyboard-owner" },
      linked_objects: { project_id: context.production.project_id, shot_id: secondShot.shot_id },
      source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: "storyboard-owner", external_url_host: "" }
    };
    context.db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)")
      .run(artifact.artifact_id, context.production.project_id, secondShot.shot_id, JSON.stringify(artifact));
    saveShot(context.db, { ...context.productionShot, storyboard_image_artifact_id: artifact.artifact_id });

    const result = getProductionProjectContext({ project_id: context.production.project_id, workspace: "storyboard" }, context.db);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION");
  } finally {
    teardown(context);
  }
});

test("workspace artifacts reject role, type, and status drift from structured columns", () => {
  const context = setup();
  try {
    const cases = [
      { suffix: "role", change: { role: "generated_clip" } },
      { suffix: "type", change: { artifact_type: "video" } },
      { suffix: "status", change: { status: "archived" } }
    ];
    for (const item of cases) {
      const artifactId = `artifact_structured_${item.suffix}`;
      const artifact = {
        artifact_id: artifactId, artifact_type: "image", role: "storyboard_image", status: "active",
        storage: { uri: join(context.root, `${item.suffix}.png`), mime_type: "image/png", filename: `${item.suffix}.png` },
        metadata: { width: 1080, height: 1920, duration_seconds: null, aspect_ratio: "9:16", sha256: item.suffix },
        linked_objects: { project_id: context.production.project_id, shot_id: context.productionShot.shot_id },
        source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: item.suffix, external_url_host: "" },
        ...item.change
      };
      context.db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)")
        .run(artifactId, context.production.project_id, context.productionShot.shot_id, JSON.stringify(artifact));
      saveShot(context.db, { ...context.productionShot, storyboard_image_artifact_id: artifactId });

      const result = getProductionProjectContext({ project_id: context.production.project_id, workspace: "storyboard" }, context.db);
      assert.equal(result.ok, false, item.suffix);
      if (!result.ok) assert.equal(result.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION", item.suffix);
    }
  } finally {
    teardown(context);
  }
});

test("production project listing excludes test and unclassified projects", () => {
  const context = setup();
  try {
    const result = listProductionProjects({}, context.db);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.page.total, 1);
    assert.equal((result.data.items[0].project as Project).project_id, context.production.project_id);
    assert.equal(JSON.stringify(result.data).includes(context.testProject.project_id), false);
  } finally {
    teardown(context);
  }
});

test("public SHOT and empty review DTOs expose normalized operational semantics", () => {
  const context = setup();
  try {
    context.productionShot.storyboard_image_artifact_id = "";
    saveShot(context.db, context.productionShot);
    const shots = readShotList(listProductionProjectShots({ project_id: context.production.project_id }, context.db), "compact");
    assert.equal(shots.ok, true, JSON.stringify(shots));
    if (!shots.ok) return;
    const shot = (shots.data as { items: Array<Record<string, any>> }).items[0]!;
    assert.equal(shot.storyboard_image_artifact_id, null);
    assert.equal(shot.accepted_clip_artifact_id, null);
    assert.equal(shot.operational_state.storyboard.approval_status, "approved");
    assert.equal(shot.operational_state.storyboard.artifact_status, "missing");
    assert.equal(shot.operational_state.generation.workflow_ready, false);
    assert.deepEqual(shot.operational_state.blocker_codes, ["STORYBOARD_IMAGE_MISSING"]);
    assert.equal(shot.operational_state.review.stage, "not_started");
    assert.equal(shot.operational_state.review.reviewable, false);
    assert.equal(shot.operational_state.review.approval_status, null);
    assert.equal(shot.operational_state.review.selected_artifact_id, null);
    assert.match(shot.updated_at, /^\d{4}-\d{2}-\d{2}T.*Z$/u);

    const review = readReviewPackage(
      getProductionReviewPackage({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id }, context.db),
      "compact",
      context.production.project_id,
      context.productionShot.shot_id
    );
    assert.equal(review.ok, true, JSON.stringify(review));
    if (!review.ok) return;
    const data = review.data as Record<string, any>;
    assert.equal(data.package_state, "not_available");
    assert.equal(data.reviewable, false);
    assert.equal(data.reason_code, "NO_GENERATED_CLIP");
    assert.equal(data.selected_artifact_id, null);
    assert.deepEqual(data.versions, []);
  } finally {
    teardown(context);
  }
});

test("delivery project context accepts null final reason when a valid final export exists", () => {
  const context = setup();
  try {
    const registered = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: context.production.project_id }
    }, context.db);
    assert.equal(registered.ok, true);
    if (!registered.ok) throw new Error("final video fixture registration failed");
    setProductionDeliveryProjectionFixture(context, {
      status: "final_approved",
      final_artifact_id: registered.artifact.artifact_id
    });

    for (const detail of ["compact", "full"] as const) {
      const result = readProjectContext(
        getProductionProjectContext({ project_id: context.production.project_id, workspace: "delivery" }, context.db),
        detail
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) continue;
      const delivery = result.data as { final_artifact: { artifact_id: string } | null; final_artifact_reason_code: string | null };
      assert.equal(delivery.final_artifact?.artifact_id, registered.artifact.artifact_id);
      assert.equal(delivery.final_artifact_reason_code, null);
    }
  } finally {
    teardown(context);
  }
});

test("five-stage readonly fixture keeps SHOT, review package, and project summary semantics aligned", () => {
  const context = setup();
  try {
    const storyboard = (shotId: string): string => {
      const artifact = registerMediaArtifact({
        artifact_type: "image", role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
        linked_objects: { project_id: context.production.project_id, shot_id: shotId }
      }, context.db);
      assert.equal(artifact.ok, true);
      if (!artifact.ok) throw new Error("storyboard fixture registration failed");
      return artifact.artifact.artifact_id;
    };
    const clip = (shotId: string): string => {
      const artifact = registerMediaArtifact({
        artifact_type: "video", role: "generated_clip",
        source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
        linked_objects: { project_id: context.production.project_id, shot_id: shotId }
      }, context.db);
      assert.equal(artifact.ok, true);
      if (!artifact.ok) throw new Error("clip fixture registration failed");
      return artifact.artifact.artifact_id;
    };
    const base = (shotId: string, order: number): Shot => ({
      shot_id: shotId, project_id: context.production.project_id, order, status: "draft", duration_seconds: 6,
      description: shotId, storyboard_image_artifact_id: "", video_prompt: "Fixture prompt", negative_prompt: "",
      generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    });

    const draft = base("shot_stage_draft", 1);
    const ready = base("shot_stage_ready", 2);
    ready.status = "storyboard_approved";
    ready.storyboard_image_artifact_id = storyboard(ready.shot_id);
    const pending = base("shot_stage_pending", 3);
    pending.status = "video_review";
    pending.storyboard_image_artifact_id = storyboard(pending.shot_id);
    const pendingClip = clip(pending.shot_id);
    pending.clip_versions = [{ artifact_id: pendingClip, run_id: "run_stage_pending", attempt_number: 1, review_status: "pending" }];
    const rejected = base("shot_stage_rejected", 4);
    rejected.status = "revision_needed";
    rejected.storyboard_image_artifact_id = storyboard(rejected.shot_id);
    const rejectedClip = clip(rejected.shot_id);
    rejected.clip_versions = [{ artifact_id: rejectedClip, run_id: "run_stage_rejected", attempt_number: 1, review_status: "rejected" }];
    rejected.review = { approval_status: "revision_needed", rejection_reasons: ["Pacing"], latest_revision_instruction: null };
    const accepted = base("shot_stage_accepted", 5);
    accepted.status = "approved";
    accepted.storyboard_image_artifact_id = storyboard(accepted.shot_id);
    const acceptedClip = clip(accepted.shot_id);
    accepted.clip_versions = [{ artifact_id: acceptedClip, run_id: "run_stage_accepted", attempt_number: 1, review_status: "approved" }];
    accepted.accepted_clip_artifact_id = acceptedClip;
    accepted.review = { approval_status: "approved", rejection_reasons: [], latest_revision_instruction: null };

    const staged = [draft, ready, pending, rejected, accepted];
    context.db.prepare("DELETE FROM shots WHERE shot_id = ?").run(context.productionShot.shot_id);
    for (const shot of staged) saveShot(context.db, shot);
    context.production.shot_ids = staged.map((shot) => shot.shot_id);
    saveProject(context.db, context.production);

    const shots = readShotList(listProductionProjectShots({ project_id: context.production.project_id, limit: 20 }, context.db), "full");
    assert.equal(shots.ok, true, JSON.stringify(shots));
    if (!shots.ok) return;
    const items = (shots.data as { items: Array<Record<string, any>> }).items;
    assert.deepEqual(items.map((shot) => shot.operational_state.primary_stage), [
      "storyboard_draft", "generation_ready", "review_pending", "clip_revision_needed", "accepted"
    ]);
    assert.deepEqual(items.map((shot) => shot.review.stage), ["not_started", "not_started", "pending", "revision_needed", "approved"]);

    const reviewStates = staged.map((shot) => {
      const review = readReviewPackage(
        getProductionReviewPackage({ project_id: context.production.project_id, shot_id: shot.shot_id }, context.db),
        "compact",
        context.production.project_id,
        shot.shot_id
      );
      assert.equal(review.ok, true, JSON.stringify(review));
      if (!review.ok) throw new Error("review projection failed");
      const data = review.data as Record<string, any>;
      return [data.package_state, data.reviewable, data.reason_code, data.selected_artifact_id, data.shot.operational_state.review.selected_artifact_id];
    });
    assert.deepEqual(reviewStates, [
      ["not_available", false, "NO_GENERATED_CLIP", null, null],
      ["not_available", false, "NO_GENERATED_CLIP", null, null],
      ["available", true, null, null, null],
      ["available", true, null, null, null],
      ["available", true, null, acceptedClip, acceptedClip]
    ]);

    const projects = listProductionProjects({}, context.db);
    assert.equal(projects.ok, true, JSON.stringify(projects));
    if (projects.ok) {
      const summary = (projects.data.items[0] as { summary: Record<string, number> }).summary;
      assert.equal(summary.review_pending_count, 1);
      assert.equal(summary.accepted_count, 1);
    }
  } finally {
    teardown(context);
  }
});

test("SHOT copy writes are field-limited, optimistic, idempotent, and audited", () => {
  const context = setup();
  try {
    const row = context.db.prepare("SELECT updated_at FROM shots WHERE shot_id = ?").get(context.productionShot.shot_id) as { updated_at: string };
    const input = {
      project_id: context.production.project_id,
      shot_id: context.productionShot.shot_id,
      expected_updated_at: row.updated_at,
      description: "Updated by WebGPT",
      video_prompt: "Updated prompt"
    };
    const write = updateProductionShotCopy(input, { actor, idempotency_key: "shot-copy-1" }, context.db);
    assert.equal(write.ok, true);
    if (!write.ok) return;
    assert.equal(write.data.shot.description, "Updated by WebGPT");
    assert.equal(write.data.shot.status, "storyboard_approved");
    assert.equal(write.data.shot.storyboard_image_artifact_id, "artifact_storyboard_001");
    assert.equal(write.data.shot.operational_state.storyboard.artifact_status, "integrity_invalid");

    const replay = updateProductionShotCopy(input, { actor, idempotency_key: "shot-copy-1" }, context.db);
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.meta.idempotent_replay, true);
      assert.equal(replay.data.shot.operational_state.storyboard.artifact_status, "integrity_invalid");
    }

    const conflict = updateProductionShotCopy({ ...input, description: "Different" }, { actor, idempotency_key: "shot-copy-1" }, context.db);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");

    const stale = updateProductionShotCopy({ ...input, description: "Stale" }, { actor, idempotency_key: "shot-copy-2" }, context.db);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "CONFLICT_STALE_VERSION");
    const audits = context.db.prepare("SELECT COUNT(*) count FROM webgpt_audit_events WHERE tool = 'update_shot_copy'").get() as { count: number };
    assert.equal(audits.count, 2);
    const successAudit = context.db.prepare("SELECT result_json FROM webgpt_audit_events WHERE tool = 'update_shot_copy' AND result = 'succeeded'").get() as { result_json: string };
    assert.deepEqual(Object.keys(JSON.parse(successAudit.result_json) as Record<string, unknown>).sort(), ["meta", "ok"]);
    assert.equal(successAudit.result_json.includes("Updated by WebGPT"), false);
  } finally {
    teardown(context);
  }
});

test("review notes and production proposals enter SQLite without changing review truth", () => {
  const context = setup();
  try {
    const note = addProductionReviewNote({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, note: "Check hand continuity." }, { actor, idempotency_key: "note-1" }, context.db);
    assert.equal(note.ok, true);
    const unchanged = context.db.prepare("SELECT json_extract(data_json, '$.review.approval_status') value FROM shots WHERE shot_id = ?").get(context.productionShot.shot_id) as { value: string };
    assert.equal(unchanged.value, "pending");

    const proposal = submitProductionProposal({ project_id: context.production.project_id, kind: "final_assembly", payload: { notes: "Use accepted clips in SHOT order." } }, { actor, idempotency_key: "proposal-1" }, context.db);
    assert.equal(proposal.ok, true);
    if (!proposal.ok) return;
    assert.equal(proposal.data.draft.status, "pending");
    assert.equal(proposal.data.draft.source, "webgpt_v4");
    const promoted = transitionWorkbenchDraft(proposal.data.draft.draft_id, { action: "promote", target_project_id: context.production.project_id }, context.db);
    assert.equal(promoted.ok, true);
    if (promoted.ok) {
      assert.equal(promoted.data.draft.status, "promoted");
      assert.equal(promoted.data.pending_action?.tool, "request_webgpt_final_assembly_plan");
      assert.equal(promoted.data.pending_action?.status, "pending");
    }
  } finally {
    teardown(context);
  }
});

test("review and delivery guards reject same-project wrong-SHOT and tampered artifacts", () => {
  const context = setup();
  let blobPath = "";
  try {
    const secondShot: Shot = { ...structuredClone(context.productionShot), shot_id: "shot_real_002", order: 2, clip_versions: [], accepted_clip_artifact_id: "" };
    const firstStoryboard = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }, linked_objects: { project_id: context.production.project_id, shot_id: context.productionShot.shot_id } }, context.db);
    const secondStoryboard = registerMediaArtifact({ artifact_type: "image", role: "storyboard_image", source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }, linked_objects: { project_id: context.production.project_id, shot_id: secondShot.shot_id } }, context.db);
    assert.equal(firstStoryboard.ok, true);
    assert.equal(secondStoryboard.ok, true);
    if (!firstStoryboard.ok || !secondStoryboard.ok) return;
    context.productionShot.storyboard_image_artifact_id = firstStoryboard.artifact.artifact_id;
    secondShot.storyboard_image_artifact_id = secondStoryboard.artifact.artifact_id;
    saveShot(context.db, context.productionShot);
    saveShot(context.db, secondShot);
    context.production.shot_ids.push(secondShot.shot_id);
    saveProject(context.db, context.production);
    const first = registerMediaArtifact({ artifact_type: "video", role: "generated_clip", source: { kind: "fixture_path", path: "video/mock_clip.mp4" }, linked_objects: { project_id: context.production.project_id, shot_id: context.productionShot.shot_id } }, context.db);
    const second = registerMediaArtifact({ artifact_type: "video", role: "generated_clip", source: { kind: "fixture_path", path: "video/mock_clip.mp4" }, linked_objects: { project_id: context.production.project_id, shot_id: secondShot.shot_id } }, context.db);
    const stale = registerMediaArtifact({ artifact_type: "video", role: "generated_clip", source: { kind: "fixture_path", path: "video/mock_clip.mp4" }, linked_objects: { project_id: context.production.project_id, shot_id: context.productionShot.shot_id } }, context.db);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(stale.ok, true);
    if (!first.ok || !second.ok || !stale.ok) return;
    blobPath = first.artifact.storage.uri;
    context.productionShot.clip_versions = [{ artifact_id: second.artifact.artifact_id, run_id: "run_wrong_shot", attempt_number: 1, review_status: "pending" }];
    saveShot(context.db, context.productionShot);

    const note = addProductionReviewNote({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, artifact_id: second.artifact.artifact_id, note: "must fail" }, { actor, idempotency_key: "wrong-shot-note" }, context.db);
    assert.equal(note.ok, false);
    if (!note.ok) assert.equal(note.error.code, "ARTIFACT_REFERENCE_BINDING_MISMATCH");
    const review = getProductionReviewPackage({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id }, context.db);
    assert.equal(review.ok, false);
    if (!review.ok) assert.equal(review.error.code, "ARTIFACT_REFERENCE_BINDING_MISMATCH");
    const proposal = submitProductionProposal({ project_id: context.production.project_id, kind: "regeneration", payload: { shot_id: context.productionShot.shot_id, artifact_id: second.artifact.artifact_id, prompt_delta: "must fail" } }, { actor, idempotency_key: "wrong-shot-proposal" }, context.db);
    assert.equal(proposal.ok, false);

    context.productionShot.clip_versions = [{ artifact_id: first.artifact.artifact_id, run_id: "run_first", attempt_number: 1, review_status: "approved" }];
    saveShot(context.db, context.productionShot);
    context.db.prepare(`INSERT INTO workbench_review_notes
      (note_id, project_id, shot_id, artifact_id, author_hash, note, source, created_at, updated_at)
      VALUES ('note_wrong_shot', ?, ?, ?, 'fixture', 'must fail closed', 'fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(context.production.project_id, context.productionShot.shot_id, second.artifact.artifact_id);
    const contextWithWrongNote = getProductionProjectContext({ project_id: context.production.project_id, workspace: "review" }, context.db);
    assert.equal(contextWithWrongNote.ok, false);
    if (!contextWithWrongNote.ok) assert.equal(contextWithWrongNote.error.code, "WEBGPT_V4_DATA_INTEGRITY_VIOLATION");
    const workbenchReview = getWorkbenchProjectWorkspace(context.production.project_id, "review", context.db, { touch_last_opened: false });
    assert.equal(workbenchReview.ok, true);
    if (workbenchReview.ok) assert.equal(JSON.stringify(workbenchReview.data.review_notes).includes("ARTIFACT_NOT_IN_SHOT_REVIEW"), true);
    context.db.prepare("DELETE FROM workbench_review_notes WHERE note_id = 'note_wrong_shot'").run();

    context.production.status = "video_review";
    saveProject(context.db, context.production);
    context.productionShot.accepted_clip_artifact_id = first.artifact.artifact_id;
    context.productionShot.status = "approved";
    context.productionShot.review.approval_status = "approved";
    saveShot(context.db, context.productionShot);
    context.db.prepare(`UPDATE workbench_project_meta SET
      next_action_override = '继续人工审片', next_action_priority = 'high',
      next_action_expires_at = '2099-01-01T00:00:00.000Z', next_action_project_status = 'video_review'
      WHERE project_id = ?`).run(context.production.project_id);
    const incompleteWorkbench = getWorkbenchProjectWorkspace(context.production.project_id, "delivery", context.db, { touch_last_opened: false });
    assert.equal(incompleteWorkbench.ok, true);
    if (incompleteWorkbench.ok) {
      assert.equal(incompleteWorkbench.data.ready_for_assembly, false);
      const summary = incompleteWorkbench.data.summary as { blocker_count: number; blocker_reason: string; next_action: { source: string; label: string; reason_code: string }; risk: string };
      assert.equal(summary.blocker_reason.includes("采纳片段无效"), false);
      assert.deepEqual(
        { source: summary.next_action.source, label: summary.next_action.label, reason_code: summary.next_action.reason_code },
        { source: "override", label: "继续人工审片", reason_code: "manual_override" }
      );
      assert.notEqual(summary.risk, "blocked");
    }
    secondShot.clip_versions = [{ artifact_id: second.artifact.artifact_id, run_id: "run_second", attempt_number: 1, review_status: "approved" }];
    secondShot.accepted_clip_artifact_id = second.artifact.artifact_id;
    secondShot.status = "approved";
    secondShot.review.approval_status = "approved";
    saveShot(context.db, context.productionShot);
    saveShot(context.db, secondShot);
    const validWorkbench = getWorkbenchProjectWorkspace(context.production.project_id, "delivery", context.db, { touch_last_opened: false });
    assert.equal(validWorkbench.ok, true);
    if (validWorkbench.ok) {
      assert.equal(validWorkbench.data.ready_for_assembly, true);
      const summary = validWorkbench.data.summary as { delivery_state: string; next_action: { source: string; reason_code: string; derived: { reason_code: string } } };
      assert.equal(summary.delivery_state, "ready_to_assemble");
      assert.deepEqual(
        { source: summary.next_action.source, reason_code: summary.next_action.reason_code, derived_reason_code: summary.next_action.derived.reason_code },
        { source: "override", reason_code: "manual_override", derived_reason_code: "assemble" }
      );
    }

    context.db.prepare(`UPDATE workbench_project_meta SET
      next_action_override = '合成交付', next_action_priority = 'high',
      next_action_expires_at = '2099-01-01T00:00:00.000Z', next_action_project_status = 'video_review'
      WHERE project_id = ?`).run(context.production.project_id);
    context.productionShot.accepted_clip_artifact_id = stale.artifact.artifact_id;
    saveShot(context.db, context.productionShot);
    const staleDelivery = getProductionDeliveryStatus({ project_id: context.production.project_id }, context.db);
    assert.equal(staleDelivery.ok, true);
    if (staleDelivery.ok) {
      assert.equal(staleDelivery.data.ready_for_assembly, false);
      assert.equal(JSON.stringify(staleDelivery.data.readiness_checks).includes("ARTIFACT_NOT_IN_SHOT_REVIEW"), true);
    }
    const staleStatus = getProjectStatus({ project_id: context.production.project_id }, context.db);
    assert.equal(staleStatus.ok, true);
    if (staleStatus.ok) assert.equal(staleStatus.readiness_checks.some((check) => check.code === "ARTIFACT_NOT_IN_SHOT_REVIEW"), true);
    const staleWorkbench = getWorkbenchProjectWorkspace(context.production.project_id, "delivery", context.db, { touch_last_opened: false });
    assert.equal(staleWorkbench.ok, true);
    if (staleWorkbench.ok) {
      assert.equal(JSON.stringify(staleWorkbench.data.readiness_checks).includes("ARTIFACT_NOT_IN_SHOT_REVIEW"), true);
      const summary = staleWorkbench.data.summary as { delivery_state: string; next_action: { source: string; reason_code: string }; risk: string };
      assert.equal(summary.delivery_state, "not_ready");
      assert.deepEqual({ source: summary.next_action.source, reason_code: summary.next_action.reason_code }, { source: "derived", reason_code: "accepted_clip_invalid" });
      assert.equal(summary.risk, "blocked");
    }
    const staleList = listProductionProjects({}, context.db);
    assert.equal(staleList.ok, true);
    if (staleList.ok) {
      const listed = staleList.data.items.find((item) => (item.project as Project).project_id === context.production.project_id) as { summary: { delivery_state: string; next_action: { reason_code: string }; risk: string } };
      assert.equal(listed.summary.delivery_state, "not_ready");
      assert.equal(listed.summary.next_action.reason_code, "accepted_clip_invalid");
      assert.equal(listed.summary.risk, "blocked");
    }

    context.productionShot.accepted_clip_artifact_id = first.artifact.artifact_id;
    saveShot(context.db, context.productionShot);
    writeFileSync(blobPath, Buffer.from("tampered-delivery-media", "utf8"));
    const delivery = getProductionDeliveryStatus({ project_id: context.production.project_id }, context.db);
    assert.equal(delivery.ok, true);
    if (delivery.ok) {
      assert.equal(delivery.data.ready_for_assembly, false);
      assert.equal(JSON.stringify(delivery.data.readiness_checks).includes("VIDEO_FILE_INVALID"), true);
    }
    const status = getProjectStatus({ project_id: context.production.project_id }, context.db);
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal(status.ready_for_assembly, false);
      assert.equal(status.readiness_checks.some((check) => check.code === "VIDEO_FILE_INVALID"), true);
    }
    const workbench = getWorkbenchProjectWorkspace(context.production.project_id, "delivery", context.db, { touch_last_opened: false });
    assert.equal(workbench.ok, true);
    if (workbench.ok) {
      assert.equal(workbench.data.ready_for_assembly, false);
      assert.equal(JSON.stringify(workbench.data.readiness_checks).includes("VIDEO_FILE_INVALID"), true);
      const summary = workbench.data.summary as { delivery_state: string; next_action: { reason_code: string }; risk: string };
      assert.equal(summary.delivery_state, "not_ready");
      assert.equal(summary.next_action.reason_code, "accepted_clip_invalid");
      assert.equal(summary.risk, "blocked");
    }
  } finally {
    teardown(context);
    if (blobPath) rmSync(blobPath, { force: true });
  }
});

test("project context is read-only and removes actor identity hashes", () => {
  const context = setup();
  try {
    const openedAt = "2026-01-01T00:00:00.000Z";
    context.db.prepare("UPDATE workbench_project_meta SET last_opened_at = ? WHERE project_id = ?").run(openedAt, context.production.project_id);
    const note = addProductionReviewNote({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, note: "Private author hash must not leave SQLite." }, { actor, idempotency_key: "identity-note" }, context.db);
    assert.equal(note.ok, true);
    const result = getProductionProjectContext({ project_id: context.production.project_id, workspace: "review" }, context.db);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(actor.actor_hash), false);
    assert.equal(JSON.stringify(result).includes("author_hash"), false);
    const meta = context.db.prepare("SELECT last_opened_at FROM workbench_project_meta WHERE project_id = ?").get(context.production.project_id) as { last_opened_at: string };
    assert.equal(meta.last_opened_at, openedAt);
  } finally {
    teardown(context);
  }
});

test("proposal payloads and promoted review decisions fail closed", () => {
  const context = setup();
  try {
    const malformed = submitProductionProposal({
      project_id: context.production.project_id,
      kind: "review_decision",
      payload: { shot_id: context.productionShot.shot_id, artifact_id: "artifact_missing", decision: "accept", oauth_token: "must-not-persist" }
    }, { actor, idempotency_key: "invalid-review-proposal" }, context.db);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.code, "INVALID_PROPOSAL_PAYLOAD");
    assert.equal(JSON.stringify(context.db.prepare("SELECT result_json FROM webgpt_audit_events WHERE idempotency_key = 'invalid-review-proposal'").get()).includes("must-not-persist"), false);
    assert.equal(Number((context.db.prepare("SELECT COUNT(*) count FROM workbench_drafts WHERE source = 'webgpt_v4'").get() as { count: number }).count), 0);

    saveWorkbenchPendingActionRecord({
      action_id: "invalid_review_action",
      tool: "request_webgpt_review_decision",
      status: "pending",
      source: "webgpt_v4_draft_promotion",
      project_id: context.production.project_id,
      payload: { project_id: context.production.project_id, webgpt_v4_bound_project_id: context.production.project_id, shot_id: context.productionShot.shot_id, artifact_id: "artifact_missing" }
    }, context.db);
    const decision = decideWorkbenchPendingAction("invalid_review_action", { decision: "execute" }, context.db);
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.error.code, "INVALID_REVIEW_DECISION");
    const stored = context.db.prepare("SELECT status FROM workbench_pending_actions WHERE action_id = 'invalid_review_action'").get() as { status: string };
    assert.equal(stored.status, "pending");
  } finally {
    teardown(context);
  }
});

test("WebGPT generation intent requires local cache and cannot bypass official human preflight", () => {
  const context = setup();
  let mediaPath = "";
  try {
    const registered = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: context.production.project_id, shot_id: context.productionShot.shot_id }
    }, context.db);
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    mediaPath = registered.artifact.storage.uri;
    context.productionShot.storyboard_image_artifact_id = registered.artifact.artifact_id;
    saveShot(context.db, context.productionShot);
    const blocked = prepareProductionGenerationIntent({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, account_label: "personal", budget_limit_value: 100 }, { actor, idempotency_key: "intent-blocked" }, context.db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "GENERATION_PREP_BLOCKED");

    const now = new Date();
    const capability = buildProviderCapabilityKey({
      provider: "runninghub",
      model: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model,
      duration_seconds: context.productionShot.duration_seconds,
      resolution: context.production.video_spec.resolution,
      aspect_ratio: context.production.video_spec.aspect_ratio
    });
    assert.equal(capability.ok, true);
    if (!capability.ok) return;
    const priceKey = buildProviderPriceCacheKey(capability.key, capability.capability);
    context.db.prepare(`INSERT INTO webgpt_provider_price_cache (provider, model, duration_seconds, resolution, estimated_cost_value, currency, source, fetched_at, expires_at) VALUES ('runninghub', 'stale-model-key', 6, '480p', 1, 'RH_COINS', ?, ?, ?)`)
      .run(priceKey.source, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    const staleKey = prepareProductionGenerationIntent({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, account_label: "personal", budget_limit_value: 100 }, { actor, idempotency_key: "intent-stale-key" }, context.db);
    assert.equal(staleKey.ok, false);
    if (!staleKey.ok) assert.equal(staleKey.error.code, "GENERATION_PREP_BLOCKED");
    context.db.prepare(`INSERT INTO webgpt_provider_price_cache (provider, model, duration_seconds, resolution, estimated_cost_value, currency, source, fetched_at, expires_at) VALUES (?, ?, ?, ?, 12, 'RH_COINS', 'legacy-capability-source', ?, ?)`)
      .run(priceKey.provider, priceKey.model, priceKey.duration_seconds, priceKey.storage_resolution, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    const staleSource = prepareProductionGenerationIntent({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, account_label: "personal", budget_limit_value: 100 }, { actor, idempotency_key: "intent-stale-source" }, context.db);
    assert.equal(staleSource.ok, false);
    if (!staleSource.ok) assert.equal(staleSource.error.code, "GENERATION_PREP_BLOCKED");
    context.db.prepare("UPDATE webgpt_provider_price_cache SET source = ? WHERE provider = ? AND model = ? AND duration_seconds = ? AND resolution = ?")
      .run(priceKey.source, priceKey.provider, priceKey.model, priceKey.duration_seconds, priceKey.storage_resolution);
    const prepared = prepareProductionGenerationIntent({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, account_label: "personal", budget_limit_value: 100 }, { actor, idempotency_key: "intent-ready" }, context.db);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.data.model, "rhart-video-g/image-to-video");
    const confirmed = confirmWorkbenchGeneration({ intent_id: String(prepared.data.intent_id), budget_limit_value: 100, cost_confirmed: true, human_confirmation: true }, context.db);
    assert.equal(confirmed.ok, false);
    if (!confirmed.ok) assert.equal(confirmed.error.code, "OFFICIAL_PREFLIGHT_REQUIRED");
    context.productionShot.status = "video_review";
    context.productionShot.review.approval_status = "pending";
    saveShot(context.db, context.productionShot);
    const blockedByWorkflow = prepareProductionGenerationIntent(
      { project_id: context.production.project_id, shot_id: context.productionShot.shot_id, account_label: "personal", budget_limit_value: 100 },
      { actor, idempotency_key: "intent-workflow-blocked" },
      context.db
    );
    assert.equal(blockedByWorkflow.ok, false);
    if (!blockedByWorkflow.ok) assert.equal(blockedByWorkflow.error.code, "SHOT_WORKFLOW_ACTION_NOT_ALLOWED");
  } finally {
    teardown(context);
    if (mediaPath) rmSync(mediaPath, { force: true });
  }
});

test("legacy review drafts and production plans migrate once as closed history without changing source JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-migration-"));
  const dataRoot = join(root, "data");
  const webgptRoot = join(dataRoot, "webgpt");
  mkdirSync(webgptRoot, { recursive: true });
  const reviewPath = join(webgptRoot, "review_assistant_drafts.json");
  const planPath = join(webgptRoot, "production_assistant_plans.json");
  writeFileSync(reviewPath, JSON.stringify({ drafts: [{ review_draft_id: "legacy_review_1", tool: "draft_review", created_at: "2026-01-01T00:00:00.000Z", payload: { note: "old" }, linked: { project_id: "project_old", shot_id: "shot_old" } }] }));
  writeFileSync(planPath, JSON.stringify({ plans: [{ plan_id: "legacy_plan_1", tool: "propose_generation_plan", created_at: "2026-01-02T00:00:00.000Z", payload: { note: "old" }, linked: { project_id: "project_old" } }] }));
  const before = [readFileSync(reviewPath), readFileSync(planPath)];
  const db = openM0Database(join(root, "app.sqlite"));
  try {
    const first = migrateLegacyWebGptV4History(db, dataRoot);
    assert.equal(first.migrated, true);
    assert.equal(first.inserted, 2);
    const second = migrateLegacyWebGptV4History(db, dataRoot);
    assert.equal(second.migrated, false);
    const rows = (db.prepare("SELECT status, source FROM workbench_drafts ORDER BY draft_id").all() as Array<{ status: string; source: string }>)
      .map((row) => ({ status: row.status, source: row.source }));
    assert.deepEqual(rows, [{ status: "closed", source: "legacy_webgpt" }, { status: "closed", source: "legacy_webgpt" }]);
    assert.deepEqual(readFileSync(reviewPath), before[0]);
    assert.deepEqual(readFileSync(planPath), before[1]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
