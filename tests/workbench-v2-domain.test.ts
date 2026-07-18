import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { deriveProjectOperationalSummary, deriveShotOperationalState, type ShotOperationalFacts } from "../src/packages/domain/operationalState.js";
import { databaseLogicalManifest, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { WORKBENCH_V2_SCHEMA_VERSION } from "../src/storage/workbenchV2Schema.js";
import { buildStoryboardApprovedShot, createProject, saveProject, saveShot } from "../src/tools/projects.js";
import { collectProjectOperationalBundles } from "../src/tools/operationalStateFacts.js";
import {
  createWorkbenchProject,
  getWorkbenchProjectWorkspace,
  listWorkbenchProjects,
  setWorkbenchProjectLifecycle,
  updateWorkbenchProject
} from "../src/tools/workbenchV2.js";
import { confirmWorkbenchGeneration, preflightWorkbenchGeneration, reconcileGenerationJob, resumeWorkbenchGenerationJobs, runWorkbenchGenerationOnce } from "../src/tools/workbenchGeneration.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { downloadProviderOutputToArtifact } from "../src/tools/providerOutputDownloader.js";
import type { VideoProviderAdapter } from "../src/tools/videoProviderAdapters.js";

function operationalFacts(overrides: Partial<ShotOperationalFacts> = {}): ShotOperationalFacts {
  return {
    shot_id: "shot_operational_001",
    project_id: "project_operational_001",
    stored_workflow_status: "draft",
    duration_seconds: 6,
    video_prompt_present: true,
    storyboard_artifact: { artifact_id: null, status: "missing", verification_level: "none" },
    accepted_clip_artifact: { artifact_id: null, status: "missing", verification_level: "none" },
    generation_version_count: 0,
    accepted_clip_in_version_stack: false,
    accepted_clip_review_status: null,
    review_approval_status: "pending",
    latest_version_review_status: null,
    generation_job_state: null,
    latest_generation_run_status: null,
    ...overrides
  };
}

test("shared operational state separates approval, artifact availability, generation, review, and delivery", () => {
  const approvedWithoutArtifact = deriveShotOperationalState(operationalFacts({ stored_workflow_status: "storyboard_approved" }));
  assert.equal(approvedWithoutArtifact.storyboard.approval_status, "approved");
  assert.equal(approvedWithoutArtifact.storyboard.artifact_status, "missing");
  assert.equal(approvedWithoutArtifact.primary_stage, "storyboard_blocked");
  assert.equal(approvedWithoutArtifact.generation.workflow_ready, false);
  assert.ok(approvedWithoutArtifact.blocker_codes.includes("STORYBOARD_IMAGE_MISSING"));

  const noGeneratedClip = deriveShotOperationalState(operationalFacts());
  assert.deepEqual(noGeneratedClip.review, {
    stage: "not_started",
    reviewable: false,
    approval_status: null,
    selected_artifact_id: null
  });
  assert.equal(deriveProjectOperationalSummary([noGeneratedClip]).review_pending_count, 0);
});

test("shared operational state derives the generation, review, revision, and accepted path consistently", () => {
  const storyboard = { artifact_id: "artifact_storyboard", status: "active", verification_level: "ledger_verified" } as const;
  const generated = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "storyboard_approved",
    storyboard_artifact: storyboard
  }));
  assert.equal(generated.primary_stage, "generation_ready");
  assert.equal(generated.allowed_workflow_actions.prepare_generation, true);

  const awaitingApproval = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "draft",
    storyboard_artifact: storyboard
  }));
  assert.equal(awaitingApproval.primary_stage, "storyboard_draft");
  assert.equal(awaitingApproval.allowed_workflow_actions.approve_storyboard, true);
  assert.ok(awaitingApproval.generation.reason_codes.includes("STORYBOARD_APPROVAL_REQUIRED"));
  assert.deepEqual(awaitingApproval.blocker_codes, []);
  assert.equal(deriveProjectOperationalSummary([awaitingApproval]).blocker_count, 0);

  const legacyQueuedRun = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "storyboard_approved",
    storyboard_artifact: storyboard,
    latest_generation_run_status: "queued"
  }));
  assert.equal(legacyQueuedRun.primary_stage, "generation_queued");
  assert.equal(legacyQueuedRun.generation.stage, "queued");
  assert.equal(legacyQueuedRun.allowed_workflow_actions.prepare_generation, false);
  assert.equal(deriveProjectOperationalSummary([legacyQueuedRun]).active_run_count, 1);

  const failedRegeneration = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "video_review",
    storyboard_artifact: storyboard,
    generation_version_count: 1,
    latest_generation_run_status: "failed",
    latest_version_review_status: "pending"
  }));
  assert.equal(failedRegeneration.primary_stage, "generation_failed");
  assert.equal(failedRegeneration.generation.stage, "failed");
  assert.equal(failedRegeneration.allowed_workflow_actions.prepare_generation, false);
  assert.equal(deriveProjectOperationalSummary([failedRegeneration]).latest_failed_count, 1);

  const pending = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "video_review",
    storyboard_artifact: storyboard,
    generation_version_count: 1,
    latest_version_review_status: "pending"
  }));
  assert.equal(pending.primary_stage, "review_pending");
  assert.equal(pending.review.approval_status, "pending");

  const revision = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "revision_needed",
    storyboard_artifact: storyboard,
    generation_version_count: 1,
    review_approval_status: "revision_needed",
    latest_version_review_status: "rejected"
  }));
  assert.equal(revision.primary_stage, "clip_revision_needed");
  assert.ok(revision.blocker_codes.includes("CLIP_REVISION_REQUIRED"));

  const acceptedClip = { artifact_id: "artifact_clip", status: "active", verification_level: "ledger_verified" } as const;
  const accepted = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "approved",
    storyboard_artifact: storyboard,
    accepted_clip_artifact: acceptedClip,
    generation_version_count: 1,
    accepted_clip_in_version_stack: true,
    accepted_clip_review_status: "approved",
    review_approval_status: "approved",
    latest_version_review_status: "approved"
  }));
  assert.equal(accepted.primary_stage, "accepted");
  assert.equal(accepted.delivery.ready, true);
  assert.equal(accepted.blocker_codes.length, 0);
});

test("shared operational state fails closed on inconsistent accepted-clip and review facts", () => {
  const state = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "approved",
    storyboard_artifact: { artifact_id: "artifact_storyboard", status: "active", verification_level: "ledger_verified" },
    accepted_clip_artifact: { artifact_id: "artifact_clip", status: "active", verification_level: "ledger_verified" },
    generation_version_count: 1,
    accepted_clip_in_version_stack: false,
    accepted_clip_review_status: "approved",
    review_approval_status: "approved",
    latest_version_review_status: "approved"
  }));
  assert.equal(state.primary_stage, "state_inconsistent");
  assert.equal(state.delivery.ready, false);
  assert.ok(state.blocker_codes.includes("SHOT_STATE_INCONSISTENT"));

  const impossibleApprovedStatus = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "approved",
    storyboard_artifact: { artifact_id: "artifact_storyboard", status: "active", verification_level: "ledger_verified" }
  }));
  assert.equal(impossibleApprovedStatus.primary_stage, "state_inconsistent");
  assert.equal(impossibleApprovedStatus.review.stage, "inconsistent");
});

test("operational fact collection uses a fixed query count for a 100-SHOT project", () => {
  const project = {
    project_id: "project_bulk_operational",
    title: "Bulk operational fixture",
    project_type: "m0_video_loop",
    status: "storyboard_approved" as const,
    brief: {},
    video_spec: { duration_seconds: 600, aspect_ratio: "9:16", resolution: "1080x1920" },
    shot_ids: [],
    active_storyboard_package_id: "",
    generation_batch_ids: [],
    exports: { final_video_artifact_id: "" }
  };
  const shots = Array.from({ length: 100 }, (_, index) => buildStoryboardApprovedShot({
    shot_id: `shot_bulk_${String(index).padStart(3, "0")}`,
    project_id: project.project_id,
    order: index + 1,
    duration_seconds: 6,
    storyboard_image_artifact_id: "",
    video_prompt: "Bulk fixture prompt."
  }));
  let queryCount = 0;
  const db = {
    prepare(sql: string) {
      queryCount += 1;
      return {
        all() {
          if (sql.includes("FROM shots")) return shots.map((shot) => ({ shot_id: shot.shot_id, project_id: project.project_id, data_json: JSON.stringify(shot) }));
          return [];
        }
      };
    }
  } as unknown as Parameters<typeof collectProjectOperationalBundles>[0];

  const bundle = collectProjectOperationalBundles(db, [project]).get(project.project_id);
  assert.equal(queryCount, 4);
  assert.equal(bundle?.states.length, 100);
  assert.equal(bundle?.summary.blocked_shot_count, 100);
});

test("operational fact collection fails closed on structured SHOT binding drift", () => {
  const project = {
    project_id: "project_drift",
    title: "Drift fixture",
    project_type: "m0_video_loop",
    status: "draft" as const,
    brief: {},
    video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" },
    shot_ids: [],
    active_storyboard_package_id: "",
    generation_batch_ids: [],
    exports: { final_video_artifact_id: "" }
  };
  const drifted = buildStoryboardApprovedShot({
    shot_id: "shot_json_id",
    project_id: project.project_id,
    order: 1,
    duration_seconds: 6,
    storyboard_image_artifact_id: "",
    video_prompt: "Fixture."
  });
  const db = {
    prepare(sql: string) {
      return { all: () => sql.includes("FROM shots") ? [{ shot_id: "shot_row_id", project_id: project.project_id, data_json: JSON.stringify(drifted) }] : [] };
    }
  } as unknown as Parameters<typeof collectProjectOperationalBundles>[0];
  assert.throws(() => collectProjectOperationalBundles(db, [project]), /SHOT_OPERATIONAL_FACT_INVALID/);
});

test("operational fact collection uses insertion order to break same-second generation job ties", () => {
  const root = mkdtempSync(join(tmpdir(), "operational-job-order-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const created = createProject({
        title: "Same-second job ordering",
        video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" }
      }, db);
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error("project setup failed");
      const shot = buildStoryboardApprovedShot({
        project_id: created.project_id,
        order: 1,
        duration_seconds: 6,
        storyboard_image_artifact_id: "",
        video_prompt: "Same-second ordering fixture."
      });
      saveShot(db, shot);
      created.project.shot_ids.push(shot.shot_id);
      saveProject(db, created.project);

      const insertIntent = db.prepare(`
        INSERT INTO generation_intents (
          intent_id, run_id, project_id, shot_id, provider, account_label, model,
          input_artifact_id, duration_seconds, resolution, estimated_cost_value,
          budget_limit_value, currency, confirmed, expires_at, status, data_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'runninghub', 'personal', 'fixture-model', '', 6,
          '1080x1920', 0, 0, 'CNY', 1, '2099-01-01T00:00:00.000Z', ?, '{}',
          '2026-07-18 00:00:00', '2026-07-18 00:00:00')
      `);
      insertIntent.run("intent_old", "run_old", created.project_id, shot.shot_id, "cancelled");
      db.prepare(`
        INSERT INTO generation_jobs (job_id, intent_id, state, created_at, updated_at)
        VALUES ('job_zzzz_old', 'intent_old', 'cancelled', '2026-07-18 00:00:00', '2026-07-18 00:00:00')
      `).run();
      insertIntent.run("intent_new", "run_new", created.project_id, shot.shot_id, "queued");
      db.prepare(`
        INSERT INTO generation_jobs (job_id, intent_id, state, created_at, updated_at)
        VALUES ('job_aaaa_new', 'intent_new', 'queued', '2026-07-18 00:00:00', '2026-07-18 00:00:00')
      `).run();

      const bundle = collectProjectOperationalBundles(db, [created.project]).get(created.project_id);
      assert.equal(bundle?.states[0]?.generation.stage, "queued");
      assert.equal(bundle?.states[0]?.primary_stage, "generation_queued");
      assert.equal(bundle?.summary.active_run_count, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function prepareConfirmedGeneration(sqlitePath: string, title: string): Promise<{ intent_id: string; job_id: string; env: NodeJS.ProcessEnv }> {
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const project = createProject({ title, video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" } }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("project setup failed");
    const shot = buildStoryboardApprovedShot({ project_id: project.project_id, order: 1, duration_seconds: 6, storyboard_image_artifact_id: "", video_prompt: "Fault injection generation." });
    const artifact = registerMediaArtifact({
      artifact_type: "image", role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: project.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(artifact.ok, true);
    if (!artifact.ok) throw new Error("artifact setup failed");
    shot.storyboard_image_artifact_id = artifact.artifact.artifact_id;
    saveShot(db, shot);
    project.project.shot_ids.push(shot.shot_id);
    project.project.status = "storyboard_approved";
    saveProject(db, project.project);
    const env = { REAL_PROVIDER_ENABLED: "true", M1_REAL_PROVIDER: "runninghub", M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true", M1_REAL_PROVIDER_COST_ACK: "true", RUNNINGHUB_API_KEY: "synthetic-test-key" } as NodeJS.ProcessEnv;
    const fetchImpl: typeof fetch = async (input) => String(input).includes("price-preview")
      ? new Response(JSON.stringify({ errorCode: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { remainMoney: "10", currency: "CNY" } }), { status: 200 });
    const prepared = await preflightWorkbenchGeneration({ project_id: project.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1 }, db, { env, fetch_impl: fetchImpl });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("generation preflight failed");
    const confirmed = confirmWorkbenchGeneration({ intent_id: prepared.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) throw new Error("generation confirmation failed");
    return { intent_id: prepared.data.intent.intent_id, job_id: confirmed.data.job_id, env };
  } finally {
    db.close();
  }
}

test("V2 schema is transactional, versioned, and initializes project metadata", () => {
  const db = openM0Database(":memory:");
  try {
    const version = db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(version.value, WORKBENCH_V2_SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    for (const table of ["workbench_project_meta", "import_index", "import_decisions", "regeneration_requests", "generation_intents", "workbench_drafts", "workbench_pending_actions", "workbench_inbox_events", "workbench_governance_runs"]) {
      assert.equal(tables.some((row) => row.name === table), true, `missing table ${table}`);
    }
    const missingClassification = createWorkbenchProject({ title: "Classification is required" }, db);
    assert.equal(missingClassification.ok, false);
    if (!missingClassification.ok) assert.equal(missingClassification.error.code, "CLASSIFICATION_REQUIRED");
    const created = createWorkbenchProject({ title: "V2 production project", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.data.meta.classification, "production");
    assert.equal(created.data.meta.lifecycle, "active");
  } finally {
    db.close();
  }
});

test("project lifecycle blocks writes without deleting project truth", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Archive boundary", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(setWorkbenchProjectLifecycle(created.data.project.project_id, "archived", db).ok, true);
    const renamed = updateWorkbenchProject(created.data.project.project_id, { title: "should not change" }, db);
    assert.equal(renamed.ok, false);
    if (renamed.ok) return;
    assert.equal(renamed.error.code, "PROJECT_ARCHIVED");
    const archived = listWorkbenchProjects({ scope: "all", lifecycle: "archived" }, db);
    assert.equal(archived.meta.total, 1);
    assert.equal(setWorkbenchProjectLifecycle(created.data.project.project_id, "active", db).ok, true);
    assert.equal(updateWorkbenchProject(created.data.project.project_id, { title: "restored" }, db).ok, true);
  } finally {
    db.close();
  }
});

test("saving a project preserves V2 classification metadata", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Metadata preservation", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    created.data.project.brief = { note: "updated" };
    saveProject(db, created.data.project);
    const meta = db.prepare("SELECT classification, lifecycle FROM workbench_project_meta WHERE project_id = ?").get(created.data.project.project_id) as { classification: string; lifecycle: string };
    assert.deepEqual({ classification: meta.classification, lifecycle: meta.lifecycle }, { classification: "production", lifecycle: "active" });
  } finally {
    db.close();
  }
});

test("readonly workspace reads preserve the complete database logical manifest unless an explicit touch is requested", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-readonly-manifest-"));
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const created = createWorkbenchProject({ title: "Readonly manifest fixture", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const before = databaseLogicalManifest(sqlitePath);
    const workspace = getWorkbenchProjectWorkspace(created.data.project.project_id, "overview", db);
    assert.equal(workspace.ok, true);
    assert.deepEqual(databaseLogicalManifest(sqlitePath), before);

    const touched = getWorkbenchProjectWorkspace(created.data.project.project_id, "overview", db, { touch_last_opened: true });
    assert.equal(touched.ok, true);
    assert.notEqual(databaseLogicalManifest(sqlitePath).sha256, before.sha256);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Workbench read surfaces use shared operational state for approved-but-missing storyboard and unstarted review", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Operational state projection", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot = buildStoryboardApprovedShot({
      shot_id: "shot_operational_projection",
      project_id: created.data.project.project_id,
      order: 1,
      duration_seconds: 6,
      storyboard_image_artifact_id: "",
      video_prompt: "A safe fixture prompt."
    });
    saveShot(db, shot);
    created.data.project.shot_ids = [shot.shot_id];
    created.data.project.status = "storyboard_approved";
    saveProject(db, created.data.project);

    const overview = getWorkbenchProjectWorkspace(created.data.project.project_id, "overview", db);
    assert.equal(overview.ok, true);
    if (!overview.ok) return;
    const metrics = overview.data.metrics as Record<string, number>;
    const blockers = overview.data.blockers as Array<{ shot_id: string; missing_image: boolean; reason_codes: string[] }>;
    assert.equal(metrics.storyboard_approved, 1);
    assert.equal(metrics.review_pending, 0);
    assert.deepEqual(blockers, [{
      shot_id: shot.shot_id,
      order: 1,
      missing_image: true,
      missing_prompt: false,
      reason_codes: ["STORYBOARD_IMAGE_MISSING"]
    }]);

    const storyboard = getWorkbenchProjectWorkspace(created.data.project.project_id, "storyboard", db);
    assert.equal(storyboard.ok, true);
    if (!storyboard.ok) return;
    const projectedShot = (storyboard.data.shots as Array<{ operational_state: ReturnType<typeof deriveShotOperationalState> }>)[0];
    assert.equal(projectedShot.operational_state.storyboard.approval_status, "approved");
    assert.equal(projectedShot.operational_state.storyboard.artifact_status, "missing");
    assert.equal(projectedShot.operational_state.review.stage, "not_started");
    assert.equal(projectedShot.operational_state.review.approval_status, null);
  } finally {
    db.close();
  }
});

test("Workbench project summary treats a complete draft storyboard as awaiting approval, not blocked", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Storyboard approval queue", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot = buildStoryboardApprovedShot({
      shot_id: "shot_storyboard_approval_queue",
      project_id: created.data.project.project_id,
      order: 1,
      duration_seconds: 6,
      storyboard_image_artifact_id: "",
      video_prompt: "A complete draft awaiting human approval."
    });
    const registered = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: created.data.project.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    shot.status = "draft";
    shot.storyboard_image_artifact_id = registered.artifact.artifact_id;
    saveShot(db, shot);
    created.data.project.shot_ids = [shot.shot_id];
    created.data.project.status = "draft";
    saveProject(db, created.data.project);

    const listed = listWorkbenchProjects({ scope: "daily" }, db);
    const summary = listed.items.find((item) => item.project.project_id === created.data.project.project_id);
    assert.equal(summary?.blocker_count, 0);
    assert.equal(summary?.risk, "clear");
    assert.equal(summary?.next_action.reason_code, "storyboard_review");
  } finally {
    db.close();
  }
});

test("operational facts fail closed when a referenced Artifact JSON binding drifts from its row", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Artifact drift guard", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot = buildStoryboardApprovedShot({
      shot_id: "shot_artifact_drift_target",
      project_id: created.data.project.project_id,
      order: 1,
      duration_seconds: 6,
      storyboard_image_artifact_id: "",
      video_prompt: "Artifact drift fixture."
    });
    const registered = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: created.data.project.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    shot.storyboard_image_artifact_id = registered.artifact.artifact_id;
    saveShot(db, shot);
    created.data.project.shot_ids = [shot.shot_id];
    saveProject(db, created.data.project);
    db.prepare(`
      UPDATE media_artifacts
      SET data_json = json_set(data_json, '$.linked_objects.shot_id', 'shot_other_same_project')
      WHERE artifact_id = ?
    `).run(registered.artifact.artifact_id);

    assert.throws(
      () => collectProjectOperationalBundles(db, [created.data.project]),
      /ARTIFACT_OPERATIONAL_FACT_INVALID/
    );
  } finally {
    db.close();
  }
});

test("generation preflight rejects a storyboard Artifact bound to another SHOT", async () => {
  const db = openM0Database(":memory:");
  try {
    const project = createProject({ title: "Cross-SHOT generation guard", video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" } }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const target = buildStoryboardApprovedShot({ project_id: project.project_id, order: 1, duration_seconds: 6, storyboard_image_artifact_id: "", video_prompt: "Target" });
    const other = buildStoryboardApprovedShot({ project_id: project.project_id, order: 2, duration_seconds: 6, storyboard_image_artifact_id: "", video_prompt: "Other" });
    const wrongArtifact = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: project.project_id, shot_id: other.shot_id }
    }, db);
    assert.equal(wrongArtifact.ok, true);
    if (!wrongArtifact.ok) return;
    target.storyboard_image_artifact_id = wrongArtifact.artifact.artifact_id;
    saveShot(db, target);
    saveShot(db, other);
    project.project.shot_ids = [target.shot_id, other.shot_id];
    saveProject(db, project.project);

    const result = await preflightWorkbenchGeneration({ project_id: project.project_id, shot_id: target.shot_id, account_label: "personal", budget_limit_value: 1 }, db, { env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "ARTIFACT_REFERENCE_BINDING_MISMATCH");
  } finally {
    db.close();
  }
});

test("generation preflight enforces official estimate, balance gate, budget and one active submit", async () => {
  const db = openM0Database(":memory:");
  try {
    const projectResult = createProject({ title: "Generation gate", video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" } }, db);
    assert.equal(projectResult.ok, true);
    if (!projectResult.ok) return;
    const shot = buildStoryboardApprovedShot({ project_id: projectResult.project_id, order: 1, duration_seconds: 6, storyboard_image_artifact_id: "", video_prompt: "Subtle camera move." });
    const artifactResult = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: projectResult.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(artifactResult.ok, true);
    if (!artifactResult.ok) return;
    shot.storyboard_image_artifact_id = artifactResult.artifact.artifact_id;
    saveShot(db, shot);
    projectResult.project.shot_ids.push(shot.shot_id);
    saveProject(db, projectResult.project);

    const env = {
      M1_REAL_PROVIDER: "runninghub",
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNNINGHUB_API_KEY: "synthetic-test-key"
    } as NodeJS.ProcessEnv;
    const priceBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("price-preview")) {
        priceBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ errorCode: "", errorMessage: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accountStatus")) return new Response(JSON.stringify({ code: 0, data: { remainCoins: "99", remainMoney: "10", currency: "CNY" } }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected URL ${url}`);
    };

    const blocked = await preflightWorkbenchGeneration({ project_id: projectResult.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 0.01 }, db, { env, fetch_impl: fetchImpl });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "BUDGET_LIMIT_EXCEEDED");

    const first = await preflightWorkbenchGeneration({ project_id: projectResult.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1 }, db, { env, fetch_impl: fetchImpl });
    const second = await preflightWorkbenchGeneration({ project_id: projectResult.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1 }, db, { env, fetch_impl: fetchImpl });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.data.intent.estimated_cost_value, 0.08);
    assert.equal(first.data.intent.currency, "CNY");
    assert.equal(first.data.intent.model, "rhart-video-g/image-to-video");
    assert.equal(first.data.intent.resolution, "480p");
    assert.equal(first.data.intent.input_snapshot.capability_key, "provider-capabilities-v1|runninghub.image_to_video.v1|runninghub|rhart-video-g/image-to-video|6|480p|9:16");
    assert.equal(priceBodies.every((body) => body.duration === 6 && body.resolution === "480p"), true);
    const priceKey = db.prepare("SELECT provider, model, duration_seconds, resolution FROM webgpt_provider_price_cache WHERE model = ?").get(first.data.intent.model) as { provider: string; model: string; duration_seconds: number; resolution: string };
    assert.deepEqual({ ...priceKey }, {
      provider: "runninghub",
      model: first.data.intent.model,
      duration_seconds: first.data.intent.duration_seconds,
      resolution: `${first.data.intent.resolution}@human_workbench_official_preflight@provider-capabilities-v1:runninghub.image_to_video.v1:9:16`
    });
    projectResult.project.video_spec.aspect_ratio = "16:9";
    projectResult.project.video_spec.resolution = "1920x1080";
    saveProject(db, projectResult.project);
    const otherAspect = await preflightWorkbenchGeneration({ project_id: projectResult.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1 }, db, { env, fetch_impl: fetchImpl });
    assert.equal(otherAspect.ok, true);
    const cacheRows = db.prepare("SELECT COUNT(*) AS count FROM webgpt_provider_price_cache WHERE provider = 'runninghub' AND model = ?").get(first.data.intent.model) as { count: number };
    assert.equal(cacheRows.count, 2);
    projectResult.project.video_spec.aspect_ratio = "9:16";
    projectResult.project.video_spec.resolution = "1080x1920";
    saveProject(db, projectResult.project);
    const originalIntentJson = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(first.data.intent.intent_id) as { data_json: string };
    const driftedIntent = JSON.parse(originalIntentJson.data_json) as { input_snapshot: { aspect_ratio: string } };
    driftedIntent.input_snapshot.aspect_ratio = "16:9";
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?").run(JSON.stringify(driftedIntent), first.data.intent.intent_id);
    const rejectedDrift = confirmWorkbenchGeneration({ intent_id: first.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(rejectedDrift.ok, false);
    if (!rejectedDrift.ok) assert.equal(rejectedDrift.error.code, "PROVIDER_CAPABILITY_CONTRACT_MISMATCH");
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?").run(originalIntentJson.data_json, first.data.intent.intent_id);
    const confirmed = confirmWorkbenchGeneration({ intent_id: first.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    assert.equal(confirmed.data.status, "queued");
    assert.match(confirmed.data.job_id, /^job_/);
    const queuedJob = db.prepare("SELECT state FROM generation_jobs WHERE job_id = ?").get(confirmed.data.job_id) as { state: string };
    assert.equal(queuedJob.state, "queued");
    const queuedEvent = db.prepare("SELECT to_state, reason_code FROM generation_job_events WHERE job_id = ? ORDER BY created_at LIMIT 1").get(confirmed.data.job_id) as { to_state: string; reason_code: string };
    assert.equal(queuedEvent.to_state, "queued");
    assert.equal(queuedEvent.reason_code, "HUMAN_CONFIRMED");
    const conflicting = confirmWorkbenchGeneration({ intent_id: second.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.error.code, "REAL_GENERATION_ALREADY_ACTIVE");
    const row = db.prepare("SELECT upload_attempts, submit_attempts, status FROM generation_intents WHERE intent_id = ?").get(first.data.intent.intent_id) as { upload_attempts: number; submit_attempts: number; status: string };
    assert.equal(row.upload_attempts, 1);
    assert.equal(row.submit_attempts, 1);
    assert.equal(row.status, "queued");

    db.prepare("UPDATE generation_jobs SET state = 'manual_reconciliation', reconciliation_reason = 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN' WHERE job_id = ?").run(confirmed.data.job_id);
    const unconfirmedAttach = reconcileGenerationJob(confirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "existing-task-123", human_confirmation: false }, db);
    assert.equal(unconfirmedAttach.ok, false);
    if (!unconfirmedAttach.ok) assert.equal(unconfirmedAttach.error.code, "GENERATION_CONFIRMATION_REQUIRED");
    const invalidDecision = reconcileGenerationJob(confirmed.data.job_id, { decision: "retry_submit", human_confirmation: true }, db);
    assert.equal(invalidDecision.ok, false);
    if (!invalidDecision.ok) assert.equal(invalidDecision.error.code, "INVALID_RECONCILIATION_DECISION");
    const attached = reconcileGenerationJob(confirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "existing-task-123", human_confirmation: true }, db);
    assert.equal(attached.ok, true);
    if (attached.ok) {
      assert.equal(attached.data.job.state, "polling");
      assert.equal(attached.data.intent.provider_task_id, "existing-task-123");
    }
    const attachedRun = db.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?").get(confirmed.data.run_id) as { data_json: string };
    const attachedRunData = JSON.parse(attachedRun.data_json) as { status: string; provider: { provider_job_id: string; provider_status: string } };
    assert.equal(attachedRunData.status, "running");
    assert.equal(attachedRunData.provider.provider_job_id, "existing-task-123");
    assert.equal(attachedRunData.provider.provider_status, "HUMAN_ATTACHED_EXISTING_TASK");
    const reconciliationEvent = db.prepare("SELECT to_state, reason_code FROM generation_job_events WHERE job_id = ? ORDER BY rowid DESC LIMIT 1").get(confirmed.data.job_id) as { to_state: string; reason_code: string };
    assert.equal(reconciliationEvent.to_state, "polling");
    assert.equal(reconciliationEvent.reason_code, "HUMAN_ATTACHED_EXISTING_TASK");
    assert.throws(() => db.prepare("UPDATE generation_job_events SET reason_code = 'rewritten' WHERE job_id = ?").run(confirmed.data.job_id), /GENERATION_JOB_EVENTS_APPEND_ONLY/);

    db.prepare("UPDATE generation_jobs SET state = 'cancelled' WHERE job_id = ?").run(confirmed.data.job_id);
    db.prepare("UPDATE generation_intents SET status = 'cancelled' WHERE intent_id = ?").run(first.data.intent.intent_id);
    shot.status = "revision_needed";
    shot.review.approval_status = "revision_needed";
    saveShot(db, shot);
    projectResult.project.status = "video_review";
    saveProject(db, projectResult.project);
    const secondConfirmed = confirmWorkbenchGeneration({ intent_id: second.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(secondConfirmed.ok, true);
    if (!secondConfirmed.ok) return;
    db.prepare("UPDATE generation_jobs SET state = 'manual_reconciliation', reconciliation_reason = 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN' WHERE job_id = ?")
      .run(secondConfirmed.data.job_id);
    db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES ('artifact_cross_provider', ?, ?, 'generated_clip', 'video', 'active', ?)")
      .run(projectResult.project_id, shot.shot_id, JSON.stringify({ artifact_id: "artifact_cross_provider", source: { provider: "runway", provider_job_id: "cross-provider-task" }, linked_objects: { project_id: projectResult.project_id, shot_id: shot.shot_id } }));
    const crossProviderTask = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "cross-provider-task", human_confirmation: true }, db);
    assert.equal(crossProviderTask.ok, false);
    if (!crossProviderTask.ok) assert.equal(crossProviderTask.error.code, "PROVIDER_TASK_ALREADY_OWNED");
    const reusedTask = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "existing-task-123", human_confirmation: true }, db);
    assert.equal(reusedTask.ok, false);
    if (!reusedTask.ok) assert.equal(reusedTask.error.code, "PROVIDER_TASK_ALREADY_OWNED");
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'archived' WHERE project_id = ?").run(projectResult.project_id);
    const archivedAbandon = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "abandon", reason: "Blocked while archived.", human_confirmation: true }, db);
    assert.equal(archivedAbandon.ok, false);
    if (!archivedAbandon.ok) assert.equal(archivedAbandon.error.code, "PROJECT_ARCHIVED");
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'active' WHERE project_id = ?").run(projectResult.project_id);
    const abandoned = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "abandon", reason: "Human verified that no provider task exists.", human_confirmation: true }, db);
    assert.equal(abandoned.ok, true);
    if (abandoned.ok) {
      assert.equal(abandoned.data.job.state, "cancelled");
      assert.equal(abandoned.data.intent.status, "cancelled");
      assert.equal(abandoned.data.intent.provider_task_id, "");
    }
    const restoredShot = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(shot.shot_id) as { data_json: string };
    const restoredProject = db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(projectResult.project_id) as { data_json: string };
    const abandonedRun = db.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?").get(secondConfirmed.data.run_id) as { data_json: string };
    assert.equal((JSON.parse(restoredShot.data_json) as { status: string }).status, "revision_needed");
    assert.equal((JSON.parse(restoredProject.data_json) as { status: string }).status, "video_review");
    assert.equal((JSON.parse(abandonedRun.data_json) as { status: string }).status, "cancelled");
  } finally {
    db.close();
  }
});

test("provider task persistence failure enters manual reconciliation without losing the paid task ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-persist-fault-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Persistence fault");
    const db = openM0Database(sqlitePath);
    db.exec(`CREATE TRIGGER inject_polling_event_failure BEFORE INSERT ON generation_job_events
      WHEN NEW.to_state = 'polling' BEGIN SELECT RAISE(ABORT, 'INJECTED_POLLING_EVENT_FAILURE'); END`);
    db.close();
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => ({ ok: true as const, provider_job_id: "task-persisted-after-fault", provider_status: "PENDING", sanitized_request: {} }),
      pollStatus: async () => { throw new Error("poll must not run after persistence fault"); },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: true, dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter } });
    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string };
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: "task-persisted-after-fault" });
    assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_TASK_PERSISTENCE_UNKNOWN" });
    checked.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker rejects an injected adapter outside the confirmed capability before submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-capability-mismatch-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Capability mismatch");
    let submitCalls = 0;
    const adapter = {
      provider_name: "runninghub",
      model_name: "stale-model",
      submitGeneration: async () => { submitCalls += 1; throw new Error("submit must not run"); },
      pollStatus: async () => { throw new Error("poll must not run"); },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: true, dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter } });
    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { status: string; sanitized_error_json: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string };
    assert.equal(submitCalls, 0);
    assert.equal(intent.status, "failed");
    assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "PROVIDER_CAPABILITY_CONTRACT_MISMATCH");
    assert.deepEqual({ ...job }, { state: "failed", reconciliation_reason: "PROVIDER_CAPABILITY_CONTRACT_MISMATCH" });
    checked.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker preserves a known paid task when a resumed capability drifts", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-known-task-capability-drift-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Known task capability drift");
    const db = openM0Database(sqlitePath);
    db.prepare("UPDATE generation_intents SET model = 'stale-model', provider_task_id = 'paid-task-known', status = 'running' WHERE intent_id = ?").run(prepared.intent_id);
    db.prepare("UPDATE generation_jobs SET state = 'polling' WHERE job_id = ?").run(prepared.job_id);
    db.close();

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => { throw new Error("adapter must not be created for capability drift"); }
      }
    });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string };
    assert.equal(intent.status, "running");
    assert.equal(intent.provider_task_id, "paid-task-known");
    assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "PROVIDER_CAPABILITY_CONTRACT_MISMATCH");
    assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_CAPABILITY_REQUIRES_RECONCILIATION" });
    checked.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker preserves a known paid task when the adapter contract drifts", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-known-task-adapter-drift-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Known task adapter drift");
    const db = openM0Database(sqlitePath);
    db.prepare("UPDATE generation_intents SET provider_task_id = 'paid-task-adapter', status = 'running' WHERE intent_id = ?").run(prepared.intent_id);
    db.prepare("UPDATE generation_jobs SET state = 'polling' WHERE job_id = ?").run(prepared.job_id);
    db.close();
    let providerCalls = 0;
    const adapter = {
      provider_name: "runninghub",
      model_name: "stale-model",
      submitGeneration: async () => { providerCalls += 1; throw new Error("submit must not run"); },
      pollStatus: async () => { providerCalls += 1; throw new Error("poll must not run"); },
      fetchOutput: async () => { providerCalls += 1; throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;

    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter } });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string };
    assert.equal(providerCalls, 0);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: "paid-task-adapter" });
    assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_ADAPTER_REQUIRES_RECONCILIATION" });
    checked.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker closes its database when claiming the job throws", async () => {
  let closed = false;
  const injectedDatabase = {
    exec: (sql: string) => {
      if (sql === "BEGIN IMMEDIATE") throw new Error("INJECTED_CLAIM_FAILURE");
      throw new Error(`unexpected SQL after claim failure: ${sql}`);
    },
    close: () => { closed = true; }
  } as unknown as ReturnType<typeof openM0Database>;
  await assert.rejects(() => runWorkbenchGenerationOnce("intent_claim_failure", {
    allow_submit: false,
    dependencies: { open_database: () => injectedDatabase }
  }), /INJECTED_CLAIM_FAILURE/);
  assert.equal(closed, true);
});

test("persisted generation wakeup catches database failures and retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-wakeup-retry-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    migrateDatabase(sqlitePath);
    let wakeupOpenAttempts = 0;
    const observedErrors: string[] = [];
    const dependencies = {
      sqlite_path: sqlitePath,
      scheduler_retry_ms: 1,
      open_database: (path?: string) => {
        wakeupOpenAttempts += 1;
        if (wakeupOpenAttempts === 1) throw new Error("INJECTED_WAKEUP_DATABASE_FAILURE");
        return openM0Database(path);
      },
      on_scheduler_error: (error: unknown) => {
        observedErrors.push(error instanceof Error ? error.message : String(error));
      }
    };
    assert.deepEqual(resumeWorkbenchGenerationJobs(dependencies), { resumed: [], reconciled: [] });
    for (let attempt = 0; attempt < 60 && wakeupOpenAttempts < 2; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(wakeupOpenAttempts, 2);
    assert.deepEqual(observedErrors, ["INJECTED_WAKEUP_DATABASE_FAILURE"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each worker claim performs one provider step and defers a still-running task", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-poll-timeout-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Polling timeout");
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => ({ ok: true as const, provider_job_id: "task-still-running", provider_status: "PENDING", sanitized_request: {} }),
      pollStatus: async () => ({ ok: true as const, status: "running" as const, provider_status: "RUNNING" }),
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const dependencies = { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter, poll_interval_ms: 10 };
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: true, dependencies });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });
    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = checked.prepare("SELECT state, reconciliation_reason, next_attempt_at FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string; next_attempt_at: string };
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: "task-still-running" });
    assert.equal(job.state, "polling");
    assert.equal(job.reconciliation_reason, "");
    assert.equal(Date.parse(job.next_attempt_at) > Date.now() - 1_000, true);
    checked.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery preserves a live lease and quarantines unknown submission state", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-resume-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
       estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id, status)
      VALUES ('intent_resume', 'project_resume', 'shot_resume', 'runninghub', 'personal', 'model', 'artifact_resume', 6,
        '1080x1920', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', 'task_resume', 'running')`).run();
    const inheritedLeaseExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
    db.prepare(`INSERT INTO generation_jobs
      (job_id, intent_id, state, lease_owner, lease_token, lease_expires_at)
      VALUES ('job_resume', 'intent_resume', 'polling', 'crashed_worker', 'live_lease', ?)`).run(inheritedLeaseExpiry);
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
       estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id, status)
      VALUES ('intent_reconcile', 'project_reconcile', 'shot_reconcile', 'runninghub', 'personal', 'model', 'artifact_reconcile', 6,
        '1080x1920', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', '', 'queued')`).run();
    db.prepare(`INSERT INTO generation_jobs
      (job_id, intent_id, state, lease_owner, lease_token, lease_expires_at)
      VALUES ('job_reconcile', 'intent_reconcile', 'submitting', 'crashed_worker', 'inherited_lease', '2099-01-01T00:00:00.000Z')`).run();
    db.close();

    const result = resumeWorkbenchGenerationJobs({ sqlite_path: sqlitePath, env: {} });
    assert.deepEqual(result, { resumed: ["intent_resume"], reconciled: ["intent_reconcile"] });
    const checked = openM0Database(sqlitePath);
    const recovered = checked.prepare("SELECT state, lease_token, lease_expires_at, attempt_count FROM generation_jobs WHERE job_id = 'job_resume'").get() as { state: string; lease_token: string; lease_expires_at: string | null; attempt_count: number };
    assert.equal(recovered.state, "polling");
    assert.equal(recovered.lease_token, "live_lease");
    assert.equal(recovered.lease_expires_at, inheritedLeaseExpiry);
    assert.equal(recovered.attempt_count, 0);
    const reconciled = checked.prepare("SELECT state, lease_owner, lease_token, lease_expires_at FROM generation_jobs WHERE job_id = 'job_reconcile'").get() as { state: string; lease_owner: string; lease_token: string; lease_expires_at: string | null };
    assert.deepEqual({ ...reconciled }, { state: "manual_reconciliation", lease_owner: "", lease_token: "", lease_expires_at: null });
    checked.close();
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery resumes a confirmed queued job before any provider submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-resume-queued-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Resume queued generation");
    let submitCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        return { ok: true as const, provider_job_id: "task-resumed-queued", provider_status: "PENDING", sanitized_request: {} };
      },
      pollStatus: async () => ({ ok: true as const, status: "cancelled" as const, provider_status: "CANCELLED" }),
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const result = resumeWorkbenchGenerationJobs({ sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter, poll_interval_ms: 10 });
    assert.deepEqual(result, { resumed: [prepared.intent_id], reconciled: [] });
    for (let attempt = 0; attempt < 50 && submitCalls === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(submitCalls, 1);
    let finalState = "";
    for (let attempt = 0; attempt < 50 && finalState !== "cancelled"; attempt += 1) {
      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT provider_task_id FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { provider_task_id: string };
      const job = checked.prepare("SELECT state FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string };
      assert.equal(intent.provider_task_id, "task-resumed-queued");
      finalState = job.state;
      checked.close();
      if (finalState !== "cancelled") await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(finalState, "cancelled");
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider output registration is idempotent by provider task ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-output-idempotent-"));
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const fixture = readFileSync(resolve("fixtures/video/mock_clip.mp4"));
    const input = {
      url: "https://cdn.example.test/output.mp4",
      provider_name: "runninghub",
      provider_job_id: "task-idempotent-1",
      project_id: "project_idempotent",
      shot_id: "shot_idempotent",
      duration_seconds: 2,
      aspect_ratio: "9:16",
      storage_directory: join(root, "media")
    };
    const runtime = {
      storage_root: join(root, "media"),
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 as const }],
      fetch_pinned_address: async () => new Response(fixture, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(fixture.length) } })
    };
    await assert.rejects(() => downloadProviderOutputToArtifact(input, db, {
      ...runtime,
      fault_injection_after_file_commit: () => { throw new Error("INJECTED_AFTER_FILE_COMMIT"); }
    }), /INJECTED_AFTER_FILE_COMMIT/);
    const afterCrash = db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE json_extract(data_json, '$.source.provider_job_id') = 'task-idempotent-1'").get() as { count: number };
    assert.equal(afterCrash.count, 0);
    assert.equal(readdirSync(join(root, "media")).filter((name) => /^artifact_[a-f0-9]{64}\.mp4$/.test(name)).length, 1);
    const first = await downloadProviderOutputToArtifact(input, db, runtime);
    const second = await downloadProviderOutputToArtifact(input, db, runtime);
    assert.equal(first.ok, true, first.ok ? undefined : first.error.message);
    assert.equal(second.ok, true, second.ok ? undefined : second.error.message);
    if (!first.ok || !second.ok) return;
    assert.equal(second.artifact.artifact_id, first.artifact.artifact_id);
    const count = db.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE json_extract(data_json, '$.source.provider_job_id') = 'task-idempotent-1'").get() as { count: number };
    assert.equal(count.count, 1);
    assert.equal(readdirSync(join(root, "media")).filter((name) => /^artifact_[a-f0-9]{64}\.mp4$/.test(name)).length, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
