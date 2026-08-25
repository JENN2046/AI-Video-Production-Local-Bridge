import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { paths } from "../src/paths.js";
import { deriveProjectOperationalSummary, deriveShotOperationalState, type ShotOperationalFacts } from "../src/packages/domain/operationalState.js";
import { databaseLogicalManifest, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { DATABASE_MIGRATIONS, migrationChecksum, runDatabaseMigrations } from "../src/storage/migrations.js";
import { withWorkbenchProductionMutationAuthority } from "../src/storage/productionMutationAuthority.js";
import { openM0Database, openM0DatabaseConnection } from "../src/storage/sqlite.js";
import { WORKBENCH_V2_SCHEMA_VERSION } from "../src/storage/workbenchV2Schema.js";
import { saveGenerationRun, type GenerationRun } from "../src/tools/generation.js";
import { getGenerationExecutionReceipt, transitionGenerationExecutionReceipt } from "../src/tools/generationExecutionIntegrity.js";
import { buildStoryboardApprovedShot, createProject, getProject, getShot, saveProject, saveShot } from "../src/tools/projects.js";
import { saveStoryboardPackage } from "../src/tools/storyboardPackages.js";
import { collectProjectOperationalBundles } from "../src/tools/operationalStateFacts.js";
import { requireProjectShotWorkflowWriteAction } from "../src/tools/operationalWriteGates.js";
import {
  createWorkbenchProject,
  getWorkbenchProjectWorkspace,
  getWorkbenchDashboard,
  listWorkbenchProjects,
  setWorkbenchProjectLifecycle,
  updateWorkbenchProject,
  updateWorkbenchShot
} from "../src/tools/workbenchV2.js";
import {
  confirmWorkbenchGeneration,
  DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS,
  generationWorkerStatus,
  MAX_PROVIDER_TASK_POLL_TIMEOUT_MS,
  MIN_PROVIDER_TASK_POLL_TIMEOUT_MS,
  parseProviderTaskPollTimeoutMs,
  preflightWorkbenchGeneration,
  reconcileGenerationJob,
  resumeWorkbenchGenerationJobs,
  runWorkbenchGenerationOnce
} from "../src/tools/workbenchGeneration.js";
import { activateLocalMediaArtifact, persistMediaArtifact, recoverMediaActivations, registerMediaArtifact, type MediaArtifact } from "../src/tools/mediaArtifacts.js";
import { downloadProviderOutputToArtifact } from "../src/tools/providerOutputDownloader.js";
import type { ProviderPollOptions, VideoProviderAdapter } from "../src/tools/videoProviderAdapters.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

function writeProviderOutputFixture(
  targetPath: string,
  input: { duration_seconds?: number; width?: number; height?: number } = {}
): void {
  const duration = input.duration_seconds ?? 6;
  const width = input.width ?? 1080;
  const height = input.height ?? 1920;
  mkdirSync(dirname(resolve(targetPath)), { recursive: true });
  const sourcePath = resolve("fixtures/video/mock_clip.mp4");
  const sameDimensions = width === 1080 && height === 1920;
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-stream_loop", "-1", "-i", sourcePath,
    "-t", String(duration), "-an"
  ];
  if (sameDimensions) args.push("-c:v", "copy");
  else args.push("-vf", `scale=${width}:${height}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  args.push("-movflags", "+faststart", targetPath);
  const result = spawnSync(FFMPEG, args, { stdio: "ignore", windowsHide: true });
  assert.equal(result.status, 0, "Provider output fixture creation should succeed");
}

function operationalFacts(overrides: Partial<ShotOperationalFacts> = {}): ShotOperationalFacts {
  const generationVersionCount = overrides.generation_version_count ?? 0;
  return {
    shot_id: "shot_operational_001",
    project_id: "project_operational_001",
    stored_workflow_status: "draft",
    duration_seconds: 6,
    video_prompt_present: true,
    storyboard_artifact: { artifact_id: null, status: "missing", verification_level: "none" },
    accepted_clip_artifact: { artifact_id: null, status: "missing", verification_level: "none" },
    latest_version_artifact: generationVersionCount > 0
      ? { artifact_id: "artifact_latest_version", status: "active", verification_level: "ledger_verified" }
      : { artifact_id: null, status: "missing", verification_level: "none" },
    generation_version_count: generationVersionCount,
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
  assert.equal(awaitingApproval.allowed_workflow_actions.freeze_storyboard, true);
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

  const manualReconciliation = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "storyboard_approved",
    storyboard_artifact: storyboard,
    generation_job_state: "manual_reconciliation",
    latest_generation_run_status: "running"
  }));
  assert.equal(manualReconciliation.primary_stage, "manual_reconciliation");
  assert.ok(manualReconciliation.blocker_codes.includes("GENERATION_MANUAL_RECONCILIATION"));
  assert.equal(manualReconciliation.allowed_workflow_actions.prepare_generation, false);
  assert.equal(deriveProjectOperationalSummary([manualReconciliation]).active_run_count, 0);

  const otherRunningShot = deriveShotOperationalState(operationalFacts({
    shot_id: "shot_operational_002",
    stored_workflow_status: "video_pending",
    storyboard_artifact: storyboard,
    generation_job_state: "polling",
    latest_generation_run_status: "running"
  }));
  assert.equal(deriveProjectOperationalSummary([manualReconciliation, otherRunningShot]).active_run_count, 1);

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
  assert.equal(pending.allowed_workflow_actions.freeze_storyboard, false);
  assert.equal(pending.allowed_workflow_actions.prepare_generation, false);

  const regeneratedPendingAfterRevision = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "video_review",
    storyboard_artifact: storyboard,
    accepted_clip_artifact: { artifact_id: "artifact_previous_revision", status: "active", verification_level: "ledger_verified" },
    generation_version_count: 2,
    accepted_clip_in_version_stack: true,
    accepted_clip_review_status: "rejected",
    review_approval_status: "revision_needed",
    latest_version_review_status: "pending"
  }));
  assert.equal(regeneratedPendingAfterRevision.primary_stage, "review_pending");
  assert.equal(regeneratedPendingAfterRevision.review.stage, "pending");
  assert.equal(regeneratedPendingAfterRevision.review.approval_status, "pending");
  assert.equal(regeneratedPendingAfterRevision.review.selected_artifact_id, null);
  assert.equal(deriveProjectOperationalSummary([regeneratedPendingAfterRevision]).review_pending_count, 1);
  assert.equal(deriveProjectOperationalSummary([regeneratedPendingAfterRevision]).revision_needed_count, 0);

  const pendingWithInvalidArtifact = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "video_review",
    storyboard_artifact: storyboard,
    generation_version_count: 1,
    latest_version_artifact: { artifact_id: "artifact_unverified", status: "integrity_invalid", verification_level: "none" },
    latest_version_review_status: "pending"
  }));
  assert.equal(pendingWithInvalidArtifact.primary_stage, "state_inconsistent");
  assert.equal(pendingWithInvalidArtifact.review.reviewable, false);
  assert.ok(pendingWithInvalidArtifact.blocker_codes.includes("REVIEW_CLIP_INTEGRITY_INVALID"));

  const revision = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "revision_needed",
    storyboard_artifact: storyboard,
    generation_version_count: 1,
    review_approval_status: "revision_needed",
    latest_version_review_status: "rejected"
  }));
  assert.equal(revision.primary_stage, "clip_revision_needed");
  assert.ok(revision.blocker_codes.includes("CLIP_REVISION_REQUIRED"));

  const revisionAfterAcceptance = deriveShotOperationalState(operationalFacts({
    stored_workflow_status: "revision_needed",
    storyboard_artifact: storyboard,
    accepted_clip_artifact: { artifact_id: "artifact_previously_accepted", status: "active", verification_level: "ledger_verified" },
    generation_version_count: 1,
    accepted_clip_in_version_stack: true,
    accepted_clip_review_status: "rejected",
    review_approval_status: "revision_needed",
    latest_version_review_status: "rejected"
  }));
  assert.equal(revisionAfterAcceptance.primary_stage, "clip_revision_needed");
  assert.equal(revisionAfterAcceptance.review.stage, "revision_needed");
  assert.equal(revisionAfterAcceptance.review.selected_artifact_id, "artifact_previously_accepted");
  assert.equal(revisionAfterAcceptance.delivery.ready, false);
  assert.equal(deriveProjectOperationalSummary([revisionAfterAcceptance]).revision_needed_count, 1);

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
  assert.equal(deriveProjectOperationalSummary([state]).accepted_count, 1);

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

test("project workflow write gate evaluates 100 SHOTs with a fixed query count", () => {
  const project = {
    project_id: "project_bulk_write_gate",
    title: "Bulk write gate fixture",
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
    shot_id: `shot_gate_${String(index).padStart(3, "0")}`,
    project_id: project.project_id,
    order: index + 1,
    duration_seconds: 6,
    storyboard_image_artifact_id: `artifact_gate_${String(index).padStart(3, "0")}`,
    video_prompt: "Bulk gate fixture prompt."
  }));
  let queryCount = 0;
  const db = {
    prepare(sql: string) {
      queryCount += 1;
      return {
        get: () => sql.includes("workbench_project_meta") ? { lifecycle: "active" } : undefined,
        all() {
          if (sql.includes("FROM shots")) return shots.map((shot) => ({ shot_id: shot.shot_id, project_id: project.project_id, data_json: JSON.stringify(shot) }));
          if (sql.includes("FROM media_artifacts")) return shots.map((shot) => ({
            artifact_id: shot.storyboard_image_artifact_id,
            project_id: project.project_id,
            shot_id: shot.shot_id,
            role: "storyboard_image",
            artifact_type: "image",
            status: "active",
            data_json: JSON.stringify({
              artifact_id: shot.storyboard_image_artifact_id,
              blob_id: `blob_${shot.shot_id}`,
              role: "storyboard_image",
              artifact_type: "image",
              status: "active",
              linked_objects: { project_id: project.project_id, shot_id: shot.shot_id }
            }),
            blob_id: `blob_${shot.shot_id}`,
            integrity_state: "verified"
          }));
          return [];
        }
      };
    }
  } as unknown as Parameters<typeof requireProjectShotWorkflowWriteAction>[0];

  const gate = requireProjectShotWorkflowWriteAction(db, project, shots, "freeze_storyboard");
  assert.equal(gate.ok, true);
  assert.equal(queryCount, 5);
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

  const unknownStatus = { ...drifted, shot_id: "shot_row_id", status: "unknown_after_manual_repair" };
  const invalidStatusDb = {
    prepare(sql: string) {
      return { all: () => sql.includes("FROM shots") ? [{ shot_id: "shot_row_id", project_id: project.project_id, data_json: JSON.stringify(unknownStatus) }] : [] };
    }
  } as unknown as Parameters<typeof collectProjectOperationalBundles>[0];
  assert.throws(() => collectProjectOperationalBundles(invalidStatusDb, [project]), /SHOT_OPERATIONAL_FACT_INVALID/);
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

test("operational fact collection ignores a stale job after a newer independent run succeeds", () => {
  const root = mkdtempSync(join(tmpdir(), "operational-stale-job-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const created = createProject({
        title: "Stale job after successful run",
        video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" }
      }, db);
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error("project setup failed");
      const shot = buildStoryboardApprovedShot({
        project_id: created.project_id,
        order: 1,
        duration_seconds: 6,
        storyboard_image_artifact_id: "",
        video_prompt: "Stale job fixture."
      });
      const latestArtifact = registerMediaArtifact({
        artifact_type: "video",
        role: "generated_clip",
        source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
        linked_objects: { project_id: created.project_id, shot_id: shot.shot_id }
      }, db);
      assert.equal(latestArtifact.ok, true);
      if (!latestArtifact.ok) throw new Error("clip artifact setup failed");
      shot.status = "video_review";
      shot.clip_versions = [{ artifact_id: latestArtifact.artifact.artifact_id, run_id: "run_latest", attempt_number: 1, review_status: "pending" }];
      saveShot(db, shot);
      created.project.shot_ids.push(shot.shot_id);
      saveProject(db, created.project);

      db.prepare(`
        INSERT INTO generation_intents (
          intent_id, run_id, project_id, shot_id, provider, account_label, model,
          input_artifact_id, duration_seconds, resolution, estimated_cost_value,
          budget_limit_value, currency, confirmed, expires_at, status, data_json,
          created_at, updated_at
        ) VALUES ('intent_stale', 'run_stale', ?, ?, 'runninghub', 'personal', 'fixture-model', '', 6,
          '1080x1920', 0, 0, 'CNY', 1, '2099-01-01T00:00:00.000Z', 'failed', '{}',
          '2026-07-18 00:00:00', '2026-07-18 00:00:00')
      `).run(created.project_id, shot.shot_id);
      db.prepare(`
        INSERT INTO generation_jobs (job_id, intent_id, state, created_at, updated_at)
        VALUES ('job_stale', 'intent_stale', 'failed', '2026-07-18 00:00:00', '2026-07-18 00:00:00')
      `).run();
      db.prepare(`
        INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json, created_at, updated_at)
        VALUES ('run_latest', '', ?, ?, 'generate_shot', 'succeeded', '{}', '2026-07-18 00:01:00', '2026-07-18 00:01:00')
      `).run(created.project_id, shot.shot_id);

      const state = collectProjectOperationalBundles(db, [created.project]).get(created.project_id)?.states[0];
      assert.equal(state?.generation.stage, "completed");
      assert.equal(state?.review.stage, "pending");
      assert.equal(state?.primary_stage, "review_pending");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operational fact collection blocks a pending version whose clip Artifact is not verified", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createProject({
      title: "Invalid review clip",
      video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" }
    }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot = buildStoryboardApprovedShot({
      project_id: created.project_id,
      order: 1,
      duration_seconds: 6,
      storyboard_image_artifact_id: "",
      video_prompt: "Invalid review clip fixture."
    });
    shot.status = "video_review";
    shot.clip_versions = [{ artifact_id: "artifact_missing_review_clip", run_id: "run_missing_clip", attempt_number: 1, review_status: "pending" }];
    saveShot(db, shot);
    created.project.shot_ids.push(shot.shot_id);
    saveProject(db, created.project);

    const state = collectProjectOperationalBundles(db, [created.project]).get(created.project_id)?.states[0];
    assert.equal(state?.primary_stage, "state_inconsistent");
    assert.equal(state?.review.reviewable, false);
    assert.ok(state?.blocker_codes.includes("REVIEW_CLIP_INTEGRITY_INVALID"));
  } finally {
    db.close();
  }
});

test("project-level generation runs contribute to operational active and failure summaries", () => {
  const root = mkdtempSync(join(tmpdir(), "operational-project-run-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    migrateDatabase(sqlitePath);
    const db = openM0Database(sqlitePath);
    try {
      const created = createWorkbenchProject({ title: "Project-level assembly run", classification: "production" }, db);
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const insertRun = db.prepare(`
        INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json, created_at, updated_at)
        VALUES (?, '', ?, '', 'assemble_video', ?, '{}', '2026-07-18 00:00:00', '2026-07-18 00:00:00')
      `);
      insertRun.run("run_project_queued", created.data.project.project_id, "queued");
      let bundle = collectProjectOperationalBundles(db, [created.data.project]).get(created.data.project.project_id);
      assert.equal(bundle?.summary.active_run_count, 1);
      assert.equal(bundle?.summary.latest_failed_count, 0);

      insertRun.run("run_project_failed", created.data.project.project_id, "failed");
      bundle = collectProjectOperationalBundles(db, [created.data.project]).get(created.data.project.project_id);
      assert.equal(bundle?.summary.active_run_count, 0);
      assert.equal(bundle?.summary.latest_failed_count, 1);
      assert.equal(bundle?.summary.blocker_count, 1);
      assert.deepEqual(bundle?.summary.blocker_codes, ["GENERATION_FAILED"]);

      const summary = listWorkbenchProjects({ scope: "daily" }, db).items.find((item) => item.project.project_id === created.data.project.project_id);
      assert.equal(summary?.next_action.reason_code, "generation_failed");
      assert.equal(summary?.risk, "blocked");
      const dashboard = getWorkbenchDashboard(db) as { totals: { blocked_projects: number; generation_active: number } };
      assert.equal(dashboard.totals.blocked_projects, 1);
      assert.equal(dashboard.totals.generation_active, 0);
      const overview = getWorkbenchProjectWorkspace(created.data.project.project_id, "overview", db);
      assert.equal(overview.ok, true);
      if (overview.ok) {
        assert.deepEqual(overview.data.blockers, [{
          scope: "project",
          shot_id: "PROJECT",
          order: 0,
          missing_image: false,
          missing_prompt: false,
          reason_codes: ["GENERATION_FAILED"]
        }]);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function prepareConfirmedGeneration(
  sqlitePath: string,
  title: string,
  options: { regeneration?: boolean } = {},
  existingDb?: ReturnType<typeof openM0Database>
): Promise<{ intent_id: string; job_id: string; run_id: string; project_id: string; shot_id: string; env: NodeJS.ProcessEnv }> {
  if (!existingDb) migrateDatabase(sqlitePath);
  const db = existingDb ?? openM0Database(sqlitePath);
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
    if (options.regeneration) {
      const previous = registerMediaArtifact({
        artifact_type: "video", role: "generated_clip",
        source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
        linked_objects: { project_id: project.project_id, shot_id: shot.shot_id }
      }, db);
      assert.equal(previous.ok, true);
      if (!previous.ok) throw new Error("previous clip setup failed");
      shot.status = "revision_needed";
      shot.review.approval_status = "revision_needed";
      shot.review.rejection_reasons = ["motion_drift"];
      shot.clip_versions = [{
        artifact_id: previous.artifact.artifact_id,
        run_id: "run_previous_rejected",
        attempt_number: 1,
        review_status: "rejected"
      }];
    }
    saveShot(db, shot);
    const storyboardPackageId = `package_${shot.shot_id}`;
    saveStoryboardPackage(db, {
      storyboard_package_id: storyboardPackageId,
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [{
        shot_id: shot.shot_id,
        order: shot.order,
        duration_seconds: shot.duration_seconds,
        description: shot.description,
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt
      }],
      user_approval: { storyboard_approved: true }
    });
    project.project.shot_ids.push(shot.shot_id);
    project.project.active_storyboard_package_id = storyboardPackageId;
    project.project.status = options.regeneration ? "video_review" : "storyboard_approved";
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
    return {
      intent_id: prepared.data.intent.intent_id,
      job_id: confirmed.data.job_id,
      run_id: confirmed.data.run_id,
      project_id: project.project_id,
      shot_id: shot.shot_id,
      env
    };
  } finally {
    if (!existingDb) db.close();
  }
}

function persistKnownProviderTask(
  sqlitePath: string,
  intentId: string,
  jobId: string,
  taskId: string,
  timeoutMs = DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS,
  existingDb?: ReturnType<typeof openM0Database>
): void {
  const db = existingDb ?? openM0Database(sqlitePath);
  try {
    const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(intentId) as { data_json: string };
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    const startedAt = Date.now();
    data.provider_poll_started_at = new Date(startedAt).toISOString();
    data.provider_poll_timeout_ms = timeoutMs;
    data.provider_poll_deadline_at = new Date(startedAt + timeoutMs).toISOString();
    db.prepare("UPDATE generation_intents SET provider_task_id = ?, status = 'running', data_json = ? WHERE intent_id = ?")
      .run(taskId, JSON.stringify(data), intentId);
    transitionGenerationExecutionReceipt(db, intentId, {
      state: "submitted",
      provider_task_id: taskId,
      provider_status: "TEST_PERSISTED_TASK"
    });
    db.prepare("UPDATE generation_jobs SET state = 'polling' WHERE job_id = ?").run(jobId);
  } finally {
    if (!existingDb) db.close();
  }
}

function restoreGenerationReconciliationContext(db: ReturnType<typeof openM0Database>, intentId: string): void {
  const row = db.prepare("SELECT project_id, shot_id, data_json FROM generation_intents WHERE intent_id = ?")
    .get(intentId) as { project_id: string; shot_id: string; data_json: string };
  const restore = (JSON.parse(row.data_json) as {
    reconciliation_restore?: { project_status?: string; shot_status?: string };
  }).reconciliation_restore;
  const project = getProject(db, row.project_id);
  const shot = getShot(db, row.shot_id);
  assert.ok(restore?.project_status);
  assert.ok(restore?.shot_status);
  assert.ok(project);
  assert.ok(shot);
  project.status = restore.project_status as typeof project.status;
  shot.status = restore.shot_status as typeof shot.status;
  saveProject(db, project);
  saveShot(db, shot);
}

function seedMigratedLegacyReconciliation(
  db: ReturnType<typeof openM0Database>,
  suffix: string,
  options: { apply_migration?: boolean; persisted_restore?: boolean } = {}
) {
  const project = createProject({
    title: `Migrated reconciliation ${suffix}`,
    video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" }
  }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("legacy reconciliation project setup failed");
  const shot = buildStoryboardApprovedShot({
    project_id: project.project_id,
    order: 1,
    duration_seconds: 6,
    storyboard_image_artifact_id: "",
    video_prompt: "Migrated reconciliation fixture."
  });
  const storyboardArtifact = registerMediaArtifact({
    artifact_type: "image",
    role: "storyboard_image",
    source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
    linked_objects: { project_id: project.project_id, shot_id: shot.shot_id }
  }, db);
  assert.equal(storyboardArtifact.ok, true);
  if (!storyboardArtifact.ok) throw new Error("legacy reconciliation storyboard setup failed");
  shot.storyboard_image_artifact_id = storyboardArtifact.artifact.artifact_id;
  const intentId = `intent_migrated_${suffix}`;
  const runId = `run_migrated_${suffix}`;
  const jobId = `job_${intentId}`;
  shot.status = "video_pending";
  shot.generation_run_ids = [runId];
  saveShot(db, shot);
  const packageId = `package_migrated_${suffix}`;
  saveStoryboardPackage(db, {
    storyboard_package_id: packageId,
    project_id: project.project_id,
    status: "approved_for_video_generation",
    approved_shot_snapshots: [{
      shot_id: shot.shot_id,
      order: shot.order,
      duration_seconds: shot.duration_seconds,
      description: shot.description,
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt
    }],
    user_approval: { storyboard_approved: true }
  });
  project.project.shot_ids = [shot.shot_id];
  project.project.active_storyboard_package_id = packageId;
  project.project.status = "video_generation_in_progress";
  saveProject(db, project.project);
  const run: GenerationRun = {
    run_id: runId,
    batch_id: "",
    project_id: project.project_id,
    shot_id: shot.shot_id,
    run_type: "image_to_video",
    status: "queued",
    input: {
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt,
      duration_seconds: shot.duration_seconds,
      aspect_ratio: "9:16",
      resolution: "480p"
    },
    output: { artifact_ids: [] },
    provider: {
      provider: "real",
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      provider_job_id: "",
      provider_status: "not_submitted"
    },
    versioning: { attempt_number: 1, parent_run_id: "" },
    error: { code: "", message: "", retryable: false }
  };
  saveGenerationRun(db, run);
  db.prepare(`INSERT INTO generation_intents
    (intent_id, run_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds,
     resolution, estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id,
     status, upload_attempts, submit_attempts, data_json)
    VALUES (?, ?, ?, ?, 'runninghub', 'personal', 'rhart-video-g/image-to-video', ?, 6,
      '480p', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', '', 'queued', 1, 1, ?)`)
    .run(intentId, runId, project.project_id, shot.shot_id, shot.storyboard_image_artifact_id, JSON.stringify({
      input_snapshot: {
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt,
        aspect_ratio: "9:16",
        project_resolution: "1080x1920",
        price_source: "runninghub_price_preview",
        balance_gate: "pass",
        requires_human_preflight: false
      },
      ...(options.persisted_restore
        ? { reconciliation_restore: { shot_status: "storyboard_approved", project_status: "storyboard_approved" } }
        : {})
    }));
  if (options.apply_migration !== false) {
    DATABASE_MIGRATIONS[2].apply(db);
    DATABASE_MIGRATIONS[3].apply(db);
  }
  return { project_id: project.project_id, shot_id: shot.shot_id, intent_id: intentId, run_id: runId, job_id: jobId };
}

test("migration-backed manual reconciliation can attach or abandon without Provider resubmission", async () => {
  const db = openM0Database(":memory:");
  try {
    const attachedFixture = seedMigratedLegacyReconciliation(db, "attach");
    const attached = reconcileGenerationJob(attachedFixture.job_id, {
      decision: "attach_existing_task",
      provider_task_id: "task-migrated-existing",
      human_confirmation: true
    }, db, {
      env: {
        REAL_PROVIDER_ENABLED: "true",
        M1_REAL_PROVIDER: "runninghub",
        M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
        M1_REAL_PROVIDER_COST_ACK: "true",
        RUNNINGHUB_API_KEY: "synthetic-test-key"
      }
    });
    assert.equal(attached.ok, true, attached.ok ? undefined : attached.error.code);
    if (!attached.ok) return;
    const restoredData = JSON.parse((db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(attachedFixture.intent_id) as { data_json: string }).data_json) as {
        reconciliation_restore?: { shot_status: string; project_status: string };
      };
    assert.deepEqual(restoredData.reconciliation_restore, {
      shot_status: "storyboard_approved",
      project_status: "storyboard_approved"
    });

    let submitCalls = 0;
    let pollCalls = 0;
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        throw new Error("migrated reconciliation must never resubmit");
      },
      pollStatus: async () => {
        pollCalls += 1;
        return { ok: true as const, provider_job_id: "task-migrated-existing", status: "cancelled" as const, provider_status: "CANCELLED" };
      },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const workerDatabase = new Proxy(db, {
      get(target, property) {
        if (property === "close") return () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReturnType<typeof openM0Database>;
    await runWorkbenchGenerationOnce(attachedFixture.intent_id, {
      allow_submit: false,
      dependencies: {
        open_database: () => workerDatabase,
        env: {
          REAL_PROVIDER_ENABLED: "true",
          M1_REAL_PROVIDER: "runninghub",
          M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
          M1_REAL_PROVIDER_COST_ACK: "true",
          RUNNINGHUB_API_KEY: "synthetic-test-key"
        },
        adapter_factory: () => adapter
      }
    });
    assert.equal(submitCalls, 0);
    assert.equal(pollCalls, 1);

    const abandonedFixture = seedMigratedLegacyReconciliation(db, "abandon", { apply_migration: false });
    DATABASE_MIGRATIONS[2].apply(db);
    DATABASE_MIGRATIONS[3].apply(db);
    const abandoned = reconcileGenerationJob(abandonedFixture.job_id, {
      decision: "abandon",
      reason: "Human verified that no Provider task exists.",
      human_confirmation: true
    }, db);
    assert.equal(abandoned.ok, true, abandoned.ok ? undefined : abandoned.error.code);
    if (!abandoned.ok) return;
    assert.equal(abandoned.data.job.state, "cancelled");
    assert.equal(abandoned.data.intent.status, "cancelled");
    assert.equal(getShot(db, abandonedFixture.shot_id)?.status, "storyboard_approved");
    assert.equal(getProject(db, abandonedFixture.project_id)?.status, "storyboard_approved");

    const untrustedFixture = seedMigratedLegacyReconciliation(db, "untrusted", { apply_migration: false });
    DATABASE_MIGRATIONS[2].apply(db);
    DATABASE_MIGRATIONS[3].apply(db);
    db.prepare(`INSERT INTO generation_job_events
      (event_id, job_id, from_state, to_state, reason_code, data_json)
      VALUES (?, ?, '', 'manual_reconciliation', 'EXTRA_EVENT', '{}')`)
      .run(`job_event_extra_${untrustedFixture.job_id}`, untrustedFixture.job_id);
    const untrusted = reconcileGenerationJob(untrustedFixture.job_id, {
      decision: "abandon",
      reason: "Reject a reconciliation record without a unique migration provenance.",
      human_confirmation: true
    }, db);
    assert.equal(untrusted.ok, false);
    if (!untrusted.ok) assert.equal(untrusted.error.code, "GENERATION_RECONCILIATION_CONTEXT_STALE");
  } finally {
    db.close();
  }
});

test("[EEI-MIGRATION-01] a genuine 0015 to 0016 execution quarantine admits its random-ID Job for explicit reconciliation", async (t) => {
  for (const decision of ["attach_existing_task", "abandon"] as const) {
    await t.test(decision, () => {
      const db = openM0DatabaseConnection(":memory:");
      try {
        for (const migration of DATABASE_MIGRATIONS.slice(0, -1)) migration.apply(db);
        db.exec(`CREATE TABLE schema_migrations (
          migration_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        for (const migration of DATABASE_MIGRATIONS.slice(0, -1)) {
          db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
            .run(migration.id, migration.name, migrationChecksum(migration));
        }
        const fixture = seedMigratedLegacyReconciliation(db, `0016_${decision}`, {
          apply_migration: false,
          persisted_restore: true
        });
        const jobId = `job_random_0016_${decision}`;
        db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
          .run(jobId, fixture.intent_id);
        db.prepare(`INSERT INTO generation_job_events
          (event_id, job_id, from_state, to_state, reason_code, data_json)
          VALUES (?, ?, '', 'queued', 'HUMAN_CONFIRMED', '{}')`)
          .run(`job_event_admission_${jobId}`, jobId);

        const migrated = runDatabaseMigrations(db);
        assert.deepEqual(migrated.applied, ["0016"]);
        const quarantined = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
          .get(jobId) as { state: string; reconciliation_reason: string };
        const migrationEvent = db.prepare(`SELECT from_state, to_state, reason_code, data_json
          FROM generation_job_events WHERE event_id = ?`).get(`job_event_0016_${jobId}`) as {
            from_state: string;
            to_state: string;
            reason_code: string;
            data_json: string;
          };
        assert.deepEqual({ ...quarantined }, {
          state: "manual_reconciliation",
          reconciliation_reason: "GENERATION_EXECUTION_SNAPSHOT_MISSING"
        });
        assert.deepEqual({
          from_state: migrationEvent.from_state,
          to_state: migrationEvent.to_state,
          reason_code: migrationEvent.reason_code,
          source: (JSON.parse(migrationEvent.data_json) as { source: string }).source
        }, {
          from_state: "queued",
          to_state: "manual_reconciliation",
          reason_code: "GENERATION_EXECUTION_SNAPSHOT_MISSING",
          source: "migration_0016"
        });
        assert.throws(() => db.prepare(`INSERT INTO generation_execution_legacy_quarantines
          (job_id, intent_id, event_id, from_state, reason_code)
          VALUES ('job_forged_attestation', 'intent_forged_attestation',
            'job_event_0016_job_forged_attestation', 'queued',
            'GENERATION_EXECUTION_SNAPSHOT_MISSING')`).run(),
        /GENERATION_EXECUTION_LEGACY_QUARANTINE_IMMUTABLE/);
        assert.throws(() => db.prepare(`UPDATE generation_execution_legacy_quarantines
          SET from_state = 'polling' WHERE job_id = ?`).run(jobId),
        /GENERATION_EXECUTION_LEGACY_QUARANTINE_IMMUTABLE/);
        assert.throws(() => db.prepare("DELETE FROM generation_execution_legacy_quarantines WHERE job_id = ?").run(jobId),
          /GENERATION_EXECUTION_LEGACY_QUARANTINE_IMMUTABLE/);

        const reconciled = decision === "attach_existing_task"
          ? reconcileGenerationJob(jobId, {
              decision,
              provider_task_id: `task-existing-0016-${decision}`,
              human_confirmation: true
            }, db, {
              env: {
                REAL_PROVIDER_ENABLED: "true",
                M1_REAL_PROVIDER: "runninghub",
                M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
                M1_REAL_PROVIDER_COST_ACK: "true",
                RUNNINGHUB_API_KEY: "synthetic-test-key"
              }
            })
          : reconcileGenerationJob(jobId, {
              decision,
              reason: "Human verified that the pre-0016 attempt created no Provider task.",
              human_confirmation: true
            }, db);
        assert.equal(reconciled.ok, true, reconciled.ok ? undefined : reconciled.error.code);
        if (!reconciled.ok) return;
        if (decision === "attach_existing_task") {
          const receipt = getGenerationExecutionReceipt(db, fixture.intent_id);
          assert.equal(reconciled.data.job.state, "polling");
          assert.equal(reconciled.data.intent.provider_task_id, `task-existing-0016-${decision}`);
          assert.equal(receipt?.state, "submitted");
          assert.equal(receipt?.job_id, jobId);
          assert.equal(getProject(db, fixture.project_id)?.status, "video_generation_in_progress");
          assert.equal(getShot(db, fixture.shot_id)?.status, "video_pending");
        } else {
          assert.equal(reconciled.data.job.state, "cancelled");
          assert.equal(reconciled.data.intent.status, "cancelled");
          assert.equal(getProject(db, fixture.project_id)?.status, "storyboard_approved");
          assert.equal(getShot(db, fixture.shot_id)?.status, "storyboard_approved");
          assert.equal(getGenerationExecutionReceipt(db, fixture.intent_id), null);
        }
      } finally {
        db.close();
      }
    });
  }
  await t.test("a fully forged deterministic migration event without the immutable attestation is rejected", () => {
    const db = openM0Database(":memory:");
    try {
      const fixture = seedMigratedLegacyReconciliation(db, "0016_forged", {
        apply_migration: false,
        persisted_restore: true
      });
      const jobId = "job_forged_0016_quarantine";
      db.prepare(`INSERT INTO generation_jobs
        (job_id, intent_id, state, reconciliation_reason)
        VALUES (?, ?, 'manual_reconciliation', 'GENERATION_EXECUTION_SNAPSHOT_MISSING')`)
        .run(jobId, fixture.intent_id);
      db.prepare(`INSERT INTO generation_job_events
        (event_id, job_id, from_state, to_state, reason_code, data_json)
        VALUES (?, ?, 'queued', 'manual_reconciliation',
          'GENERATION_EXECUTION_SNAPSHOT_MISSING', '{"source":"migration_0016"}')`)
        .run(`job_event_0016_${jobId}`, jobId);
      const rejected = reconcileGenerationJob(jobId, {
        decision: "abandon",
        reason: "This row copied the public Event shape but has no migration-only attestation.",
        human_confirmation: true
      }, db);
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.error.code, "GENERATION_RECONCILIATION_CONTEXT_STALE");
    } finally {
      db.close();
    }
  });
});

test("manual reconciliation follows the target SHOT instead of aggregate project progress", () => {
  const db = openM0Database(":memory:");
  try {
    const fixture = seedMigratedLegacyReconciliation(db, "multishot");
    const targetShot = getShot(db, fixture.shot_id);
    assert.ok(targetShot);
    targetShot.status = "storyboard_approved";
    saveShot(db, targetShot);
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(fixture.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.reconciliation_restore = { shot_status: "storyboard_approved", project_status: "storyboard_approved" };
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), fixture.intent_id);
    const project = getProject(db, fixture.project_id);
    assert.ok(project);
    const otherShot = buildStoryboardApprovedShot({
      project_id: fixture.project_id,
      order: 2,
      duration_seconds: 6,
      storyboard_image_artifact_id: "artifact_other_storyboard",
      video_prompt: "Other SHOT already reached review."
    });
    otherShot.status = "video_review";
    saveShot(db, otherShot);
    project.shot_ids.push(otherShot.shot_id);
    project.status = "video_review";
    saveProject(db, project);

    const abandoned = reconcileGenerationJob(fixture.job_id, {
      decision: "abandon",
      reason: "Human verified that no Provider task exists.",
      human_confirmation: true
    }, db);
    assert.equal(abandoned.ok, true, abandoned.ok ? undefined : abandoned.error.code);
    assert.equal(getShot(db, fixture.shot_id)?.status, "storyboard_approved");
    assert.equal(getProject(db, fixture.project_id)?.status, "video_review");
  } finally {
    db.close();
  }
});

test("manual reconciliation fails closed when the target SHOT state changes", () => {
  const db = openM0Database(":memory:");
  try {
    const fixture = seedMigratedLegacyReconciliation(db, "shot-stale");
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(fixture.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.reconciliation_restore = { shot_status: "storyboard_approved", project_status: "storyboard_approved" };
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), fixture.intent_id);
    const shot = getShot(db, fixture.shot_id);
    assert.ok(shot);
    shot.status = "draft";
    saveShot(db, shot);
    const stale = reconcileGenerationJob(fixture.job_id, {
      decision: "abandon",
      reason: "Reject changed target SHOT context.",
      human_confirmation: true
    }, db);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "GENERATION_RECONCILIATION_CONTEXT_STALE");

    shot.status = "storyboard_approved";
    shot.generation_run_ids = ["run_replaced_after_reconciliation"];
    saveShot(db, shot);
    const rebound = reconcileGenerationJob(fixture.job_id, {
      decision: "abandon",
      reason: "Reject changed target SHOT generation binding.",
      human_confirmation: true
    }, db);
    assert.equal(rebound.ok, false);
    if (!rebound.ok) assert.equal(rebound.error.code, "GENERATION_RECONCILIATION_CONTEXT_STALE");
  } finally {
    db.close();
  }
});

test("manual reconciliation keeps archive, terminal project, and Provider task ownership gates closed", () => {
  const db = openM0Database(":memory:");
  try {
    const archivedFixture = seedMigratedLegacyReconciliation(db, "archived");
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'archived' WHERE project_id = ?")
      .run(archivedFixture.project_id);
    const archived = reconcileGenerationJob(archivedFixture.job_id, {
      decision: "abandon",
      reason: "Archived project must stay read-only.",
      human_confirmation: true
    }, db);
    assert.equal(archived.ok, false);
    if (!archived.ok) assert.equal(archived.error.code, "PROJECT_ARCHIVED");

    const terminalFixture = seedMigratedLegacyReconciliation(db, "terminal", { apply_migration: false });
    DATABASE_MIGRATIONS[2].apply(db);
    DATABASE_MIGRATIONS[3].apply(db);
    const terminalProject = getProject(db, terminalFixture.project_id);
    assert.ok(terminalProject);
    terminalProject.status = "final_approved";
    assert.throws(() => saveProject(db, terminalProject), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "PRODUCTION_MUTATION_REJECTED");
    assert.notEqual(getProject(db, terminalFixture.project_id)?.status, "final_approved");

    db.prepare("UPDATE generation_intents SET status = 'cancelled' WHERE intent_id IN (?, ?)")
      .run(archivedFixture.intent_id, terminalFixture.intent_id);
    db.prepare("UPDATE generation_jobs SET state = 'cancelled' WHERE job_id IN (?, ?)")
      .run(archivedFixture.job_id, terminalFixture.job_id);

    const ownerFixture = seedMigratedLegacyReconciliation(db, "owner", { apply_migration: false });
    DATABASE_MIGRATIONS[2].apply(db);
    DATABASE_MIGRATIONS[3].apply(db);
    const owner = reconcileGenerationJob(ownerFixture.job_id, {
      decision: "attach_existing_task",
      provider_task_id: "task-owned-once",
      human_confirmation: true
    }, db);
    assert.equal(owner.ok, true, owner.ok ? undefined : owner.error.code);
    const contenderFixture = seedMigratedLegacyReconciliation(db, "contender", { apply_migration: false });
    DATABASE_MIGRATIONS[2].apply(db);
    DATABASE_MIGRATIONS[3].apply(db);
    const contender = reconcileGenerationJob(contenderFixture.job_id, {
      decision: "attach_existing_task",
      provider_task_id: "task-owned-once",
      human_confirmation: true
    }, db);
    assert.equal(contender.ok, false);
    if (!contender.ok) assert.equal(contender.error.code, "PROVIDER_TASK_ALREADY_OWNED");
  } finally {
    db.close();
  }
});

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

test("Storyboard approval uses the shared candidate-state write gate", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Storyboard write gate", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot = buildStoryboardApprovedShot({
      shot_id: "shot_storyboard_write_gate",
      project_id: created.data.project.project_id,
      order: 1,
      duration_seconds: 6,
      storyboard_image_artifact_id: "",
      video_prompt: "Candidate-state approval."
    });
    shot.status = "draft";
    saveShot(db, shot);
    created.data.project.shot_ids = [shot.shot_id];
    created.data.project.status = "draft";
    saveProject(db, created.data.project);

    const denied = updateWorkbenchShot(created.data.project.project_id, shot.shot_id, {
      approve_storyboard: true,
      human_confirmation: true
    }, db);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "SHOT_WORKFLOW_ACTION_NOT_ALLOWED");
    assert.equal((getShot(db, shot.shot_id) as typeof shot).status, "draft");

    const artifact = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: created.data.project.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    const approved = updateWorkbenchShot(created.data.project.project_id, shot.shot_id, {
      storyboard_image_artifact_id: artifact.artifact.artifact_id,
      approve_storyboard: true,
      human_confirmation: true
    }, db);
    assert.equal(approved.ok, true);
    if (approved.ok) assert.equal(approved.data.shot.status, "storyboard_approved");
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
      scope: "shot",
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

test("Workbench project summary keeps missing storyboard inputs ahead of clip revision", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Revision with missing storyboard", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot = buildStoryboardApprovedShot({
      shot_id: "shot_revision_missing_storyboard",
      project_id: created.data.project.project_id,
      order: 1,
      duration_seconds: 6,
      storyboard_image_artifact_id: "",
      video_prompt: "A revision fixture."
    });
    const generated = registerMediaArtifact({
      artifact_type: "video",
      role: "generated_clip",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: created.data.project.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(generated.ok, true);
    if (!generated.ok) return;
    shot.status = "revision_needed";
    shot.review.approval_status = "revision_needed";
    shot.clip_versions = [{
      artifact_id: generated.artifact.artifact_id,
      run_id: "run_revision_missing_storyboard",
      attempt_number: 1,
      review_status: "rejected"
    }];
    saveShot(db, shot);
    created.data.project.shot_ids = [shot.shot_id];
    created.data.project.status = "video_review";
    saveProject(db, created.data.project);

    const summary = listWorkbenchProjects({ scope: "daily" }, db).items
      .find((item) => item.project.project_id === created.data.project.project_id);
    assert.ok(summary?.blocker_codes.includes("STORYBOARD_IMAGE_MISSING"));
    assert.ok(summary?.blocker_codes.includes("CLIP_REVISION_REQUIRED"));
    assert.equal(summary?.next_action.reason_code, "storyboard_blocked");
  } finally {
    db.close();
  }
});

test("database authority prevents Project row and JSON id drift", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Project binding drift", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.throws(() => db.prepare(`UPDATE projects
      SET data_json = json_set(data_json, '$.project_id', 'project_wrong_binding')
      WHERE project_id = ?`).run(created.data.project.project_id),
    /WORKBENCH_(?:PRODUCTION_OWNER_REQUIRED|PROJECT_BINDING_INVALID)/);
    assert.equal(getProject(db, created.data.project.project_id)?.project_id, created.data.project.project_id);
  } finally {
    db.close();
  }
});

test("database authority prevents a referenced Artifact JSON binding from drifting", () => {
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
    assert.throws(() => db.prepare(`
      UPDATE media_artifacts
      SET data_json = json_set(data_json, '$.linked_objects.shot_id', 'shot_other_same_project')
      WHERE artifact_id = ?
    `).run(registered.artifact.artifact_id), /WORKBENCH_DELIVERY_ARTIFACT_IMMUTABLE/);
    assert.doesNotThrow(() => collectProjectOperationalBundles(db, [created.data.project]));
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
    const packageId = `package_${shot.shot_id}`;
    saveStoryboardPackage(db, {
      storyboard_package_id: packageId,
      project_id: projectResult.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [{
        shot_id: shot.shot_id,
        order: shot.order,
        duration_seconds: shot.duration_seconds,
        description: shot.description,
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt
      }],
      user_approval: { storyboard_approved: true }
    });
    projectResult.project.shot_ids.push(shot.shot_id);
    projectResult.project.active_storyboard_package_id = packageId;
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

    const businessFailureFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("price-preview")) {
        return new Response(JSON.stringify({ errorCode: "", errorMessage: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accountStatus")) {
        return new Response(JSON.stringify({ code: 1, data: { remainMoney: "10", currency: "CNY" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const declaredAccountFailure = await preflightWorkbenchGeneration({ project_id: projectResult.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1 }, db, { env, fetch_impl: businessFailureFetch });
    assert.equal(declaredAccountFailure.ok, false);
    if (!declaredAccountFailure.ok) assert.equal(declaredAccountFailure.error.code, "BALANCE_GATE_UNKNOWN_OR_INSUFFICIENT");

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
    assert.equal(first.data.intent.input_snapshot.account_balance_value, 10);
    assert.equal(first.data.intent.input_snapshot.account_balance_currency, "CNY");
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
    const legacyIntent = JSON.parse(originalIntentJson.data_json) as { input_snapshot: { project_resolution?: string } };
    delete legacyIntent.input_snapshot.project_resolution;
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?").run(JSON.stringify(legacyIntent), first.data.intent.intent_id);
    projectResult.project.video_spec.resolution = "720x1280";
    saveProject(db, projectResult.project);
    const rejectedMissingResolution = confirmWorkbenchGeneration({ intent_id: first.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(rejectedMissingResolution.ok, false);
    if (!rejectedMissingResolution.ok) assert.equal(rejectedMissingResolution.error.code, "GENERATION_INTENT_INPUT_STALE");
    projectResult.project.video_spec.resolution = "1080x1920";
    saveProject(db, projectResult.project);
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?").run(originalIntentJson.data_json, first.data.intent.intent_id);
    shot.video_prompt = "Changed after official preflight.";
    saveShot(db, shot);
    const rejectedStaleInput = confirmWorkbenchGeneration({ intent_id: first.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(rejectedStaleInput.ok, false);
    if (!rejectedStaleInput.ok) assert.equal(rejectedStaleInput.error.code, "GENERATION_INTENT_INPUT_STALE");
    shot.video_prompt = "Subtle camera move.";
    saveShot(db, shot);
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

    const firstReconciliationShot = getShot(db, shot.shot_id);
    assert.ok(firstReconciliationShot);
    firstReconciliationShot.status = "storyboard_approved";
    saveShot(db, firstReconciliationShot);
    projectResult.project.status = "draft";
    saveProject(db, projectResult.project);
    db.prepare("UPDATE generation_jobs SET state = 'manual_reconciliation', reconciliation_reason = 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN' WHERE job_id = ?").run(confirmed.data.job_id);
    const unconfirmedAttach = reconcileGenerationJob(confirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "existing-task-123", human_confirmation: false }, db);
    assert.equal(unconfirmedAttach.ok, false);
    if (!unconfirmedAttach.ok) assert.equal(unconfirmedAttach.error.code, "GENERATION_CONFIRMATION_REQUIRED");
    const invalidDecision = reconcileGenerationJob(confirmed.data.job_id, { decision: "retry_submit", human_confirmation: true }, db);
    assert.equal(invalidDecision.ok, false);
    if (!invalidDecision.ok) assert.equal(invalidDecision.error.code, "INVALID_RECONCILIATION_DECISION");
    const missingTask = reconcileGenerationJob(confirmed.data.job_id, { decision: "attach_existing_task", human_confirmation: true }, db);
    assert.equal(missingTask.ok, false);
    if (!missingTask.ok) assert.equal(missingTask.error.code, "INVALID_PROVIDER_TASK_ID");
    const attached = reconcileGenerationJob(confirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "existing-task-123", human_confirmation: true }, db);
    assert.equal(attached.ok, true);
    if (attached.ok) {
      assert.equal(attached.data.job.state, "polling");
      assert.equal(attached.data.intent.provider_task_id, "existing-task-123");
    }
    const attachedIntentDataRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(first.data.intent.intent_id) as { data_json: string };
    const attachedIntentData = JSON.parse(attachedIntentDataRow.data_json) as {
      provider_poll_started_at: string;
      provider_poll_timeout_ms: number;
      provider_poll_deadline_at: string;
    };
    assert.equal(attachedIntentData.provider_poll_timeout_ms, DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS);
    assert.equal(
      Date.parse(attachedIntentData.provider_poll_deadline_at) - Date.parse(attachedIntentData.provider_poll_started_at),
      DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS
    );
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
    db.prepare("UPDATE generation_runs SET status = 'cancelled', data_json = json_set(data_json, '$.status', 'cancelled') WHERE run_id = ?")
      .run(confirmed.data.run_id);
    shot.status = "storyboard_approved";
    shot.review.approval_status = "pending";
    saveShot(db, shot);
    projectResult.project.status = "video_review";
    saveProject(db, projectResult.project);
    const secondConfirmed = confirmWorkbenchGeneration({ intent_id: second.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(secondConfirmed.ok, true);
    if (!secondConfirmed.ok) return;
    const secondReconciliationShot = getShot(db, shot.shot_id);
    assert.ok(secondReconciliationShot);
    secondReconciliationShot.status = "storyboard_approved";
    saveShot(db, secondReconciliationShot);
    projectResult.project.status = "video_review";
    saveProject(db, projectResult.project);
    db.prepare("UPDATE generation_jobs SET state = 'manual_reconciliation', reconciliation_reason = 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN' WHERE job_id = ?")
      .run(secondConfirmed.data.job_id);
    const crossProviderArtifact = registerMediaArtifact({
      artifact_type: "video",
      role: "generated_clip",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: projectResult.project_id, shot_id: shot.shot_id }
    }, db);
    assert.equal(crossProviderArtifact.ok, true);
    if (!crossProviderArtifact.ok) return;
    crossProviderArtifact.artifact.source.provider = "runway";
    crossProviderArtifact.artifact.source.provider_job_id = "cross-provider-task";
    persistMediaArtifact(db, crossProviderArtifact.artifact);
    const crossProviderTask = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "cross-provider-task", human_confirmation: true }, db);
    assert.equal(crossProviderTask.ok, false);
    if (!crossProviderTask.ok) assert.equal(crossProviderTask.error.code, "PROVIDER_TASK_ALREADY_OWNED");
    const reusedTask = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "attach_existing_task", provider_task_id: "existing-task-123", human_confirmation: true }, db);
    assert.equal(reusedTask.ok, false);
    if (!reusedTask.ok) assert.equal(reusedTask.error.code, "PROVIDER_TASK_ALREADY_OWNED");
    projectResult.project.status = "video_review";
    saveProject(db, projectResult.project);
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'archived' WHERE project_id = ?").run(projectResult.project_id);
    const archivedAbandon = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "abandon", reason: "Blocked while archived.", human_confirmation: true }, db);
    assert.equal(archivedAbandon.ok, false);
    if (!archivedAbandon.ok) assert.equal(archivedAbandon.error.code, "PROJECT_ARCHIVED");
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'active' WHERE project_id = ?").run(projectResult.project_id);
    const missingAbandonReason = reconcileGenerationJob(secondConfirmed.data.job_id, { decision: "abandon", human_confirmation: true }, db);
    assert.equal(missingAbandonReason.ok, false);
    if (!missingAbandonReason.ok) assert.equal(missingAbandonReason.error.code, "RECONCILIATION_REASON_REQUIRED");
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
    assert.equal((JSON.parse(restoredShot.data_json) as { status: string }).status, "storyboard_approved");
    assert.equal((JSON.parse(restoredProject.data_json) as { status: string }).status, "video_review");
    assert.equal((JSON.parse(abandonedRun.data_json) as { status: string }).status, "cancelled");
  } finally {
    db.close();
  }
});

test("explicit task attachment alone resumes bounded polling and generation workflow state", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-explicit-attach-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Explicit reconciliation attach");
    let submitCalls = 0;
    let pollCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        return {
          ok: false as const,
          error: { code: "PROVIDER_TIMEOUT", message: "Synthetic unknown outcome.", retryable: true, submission_outcome_unknown: true }
        };
      },
      pollStatus: async () => {
        pollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: "task-human-attached",
          status: "running" as const,
          provider_status: "RUNNING",
          retryable: true
        };
      },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const dependencies = {
      sqlite_path: sqlitePath,
      env: prepared.env,
      adapter_factory: () => adapter,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      monotonic_now_ms: () => 5_000,
      poll_interval_ms: 100
    };

    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: true, dependencies });
    let db = openM0Database(sqlitePath);
    let summary = listWorkbenchProjects({ scope: "all" }, db).items
      .find((item) => item.project.project_id === prepared.project_id);
    assert.equal(summary?.active_run_count, 0);
    assert.ok(summary?.blocker_codes.includes("GENERATION_MANUAL_RECONCILIATION"));

    const attached = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: "task-human-attached",
      human_confirmation: true
    }, db, { env: prepared.env, now: dependencies.now });
    assert.equal(attached.ok, true);
    if (!attached.ok) throw new Error("explicit task attachment failed");
    const attachedDataRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const attachedData = JSON.parse(attachedDataRow.data_json) as { provider_poll_deadline_at: string };
    const originalDeadline = attachedData.provider_poll_deadline_at;
    const project = db.prepare("SELECT data_json FROM projects WHERE project_id = ?")
      .get(prepared.project_id) as { data_json: string };
    const shot = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?")
      .get(prepared.shot_id) as { data_json: string };
    summary = listWorkbenchProjects({ scope: "all" }, db).items
      .find((item) => item.project.project_id === prepared.project_id);
    assert.equal(attached.data.job.state, "polling");
    assert.equal(attached.data.intent.provider_task_id, "task-human-attached");
    assert.equal((JSON.parse(project.data_json) as { status: string }).status, "video_generation_in_progress");
    assert.equal((JSON.parse(shot.data_json) as { status: string }).status, "video_pending");
    assert.equal(summary?.active_run_count, 1);
    assert.equal(summary?.blocker_codes.includes("GENERATION_MANUAL_RECONCILIATION"), false);
    const duplicateAttach = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: "task-human-attached",
      human_confirmation: true
    }, db, { env: prepared.env, now: dependencies.now });
    assert.equal(duplicateAttach.ok, false);
    if (!duplicateAttach.ok) assert.equal(duplicateAttach.error.code, "GENERATION_JOB_NOT_RECONCILABLE");
    db.close();

    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });
    db = openM0Database(sqlitePath);
    const afterPoll = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const afterPollData = JSON.parse(afterPoll.data_json) as { provider_poll_deadline_at: string };
    const afterPollJob = db.prepare("SELECT state FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string };
    db.close();

    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 1);
    assert.equal(afterPollJob.state, "polling");
    assert.equal(afterPollData.provider_poll_deadline_at, originalDeadline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-TASK-02] provider task persistence failure enters manual reconciliation without losing the paid task ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-persist-fault-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Persistence fault");
    const db = openM0Database(sqlitePath);
    db.exec(`CREATE TRIGGER inject_reconciliation_event_failure BEFORE INSERT ON generation_job_events
      WHEN NEW.to_state IN ('polling', 'manual_reconciliation')
      BEGIN SELECT RAISE(ABORT, 'INJECTED_RECONCILIATION_EVENT_FAILURE'); END`);
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
    const job = checked.prepare(`SELECT state, reconciliation_reason, lease_owner, lease_token, lease_expires_at
      FROM generation_jobs WHERE job_id = ?`).get(prepared.job_id) as {
        state: string; reconciliation_reason: string; lease_owner: string; lease_token: string; lease_expires_at: string | null;
      };
    const project = checked.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(prepared.project_id) as { data_json: string };
    const shot = checked.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(prepared.shot_id) as { data_json: string };
    const manualEventCount = (checked.prepare(`SELECT COUNT(*) AS count FROM generation_job_events
      WHERE job_id = ? AND to_state = 'manual_reconciliation'`).get(prepared.job_id) as { count: number }).count;
    const summary = listWorkbenchProjects({ scope: "all" }, checked).items
      .find((item) => item.project.project_id === prepared.project_id);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: "task-persisted-after-fault" });
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_TASK_PERSISTENCE_UNKNOWN",
      lease_owner: "",
      lease_token: "",
      lease_expires_at: null
    });
    assert.equal((JSON.parse(project.data_json) as { status: string }).status, "storyboard_approved");
    assert.equal((JSON.parse(shot.data_json) as { status: string }).status, "storyboard_approved");
    assert.equal(manualEventCount, 0);
    assert.equal(summary?.active_run_count, 0);
    assert.ok(summary?.blocker_codes.includes("GENERATION_MANUAL_RECONCILIATION"));
    const workspace = getWorkbenchProjectWorkspace(prepared.project_id, "generation", checked);
    if (!workspace.ok) throw new Error(workspace.error.code);
    assert.equal(workspace.ok, true);
    const reconciliationItems = workspace.data.reconciliation_items as Array<Record<string, unknown>>;
    assert.equal(reconciliationItems.length, 1);
    assert.deepEqual(reconciliationItems[0], {
      job_id: prepared.job_id,
      intent_id: prepared.intent_id,
      shot_id: prepared.shot_id,
      provider: "runninghub",
      model: "rhart-video-g/image-to-video",
      job_state: "manual_reconciliation",
      intent_status: "running",
      reason_code: "PROVIDER_TASK_PERSISTENCE_UNKNOWN",
      has_provider_task_id: true,
      updated_at: reconciliationItems[0].updated_at
    });
    assert.equal("provider_task_id" in reconciliationItems[0], false);
    checked.exec("DROP TRIGGER inject_reconciliation_event_failure");
    const resumedRecordedTask = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      human_confirmation: true
    }, checked, { env: prepared.env });
    if (!resumedRecordedTask.ok) throw new Error(resumedRecordedTask.error.code);
    assert.equal(resumedRecordedTask.ok, true);
    assert.equal(resumedRecordedTask.data.job.state, "polling");
    assert.equal(resumedRecordedTask.data.intent.provider_task_id, "task-persisted-after-fault");
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

test("[EEI-TASK-04] a bounded but noncanonical returned Provider task identity is retained for reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-invalid-returned-task-id-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Invalid returned task identity");
    const taskId = "task id/returned-by-provider";
    let submitCalls = 0;
    let pollCalls = 0;
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        return { ok: true as const, provider_job_id: taskId, provider_status: "PENDING", sanitized_request: {} };
      },
      pollStatus: async () => { pollCalls += 1; throw new Error("noncanonical task ID must not be polled automatically"); },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: true,
      dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
    });
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: true,
      dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
    });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    checked.close();
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 0);
    assert.deepEqual({ status: intent.status, provider_task_id: intent.provider_task_id }, { status: "running", provider_task_id: taskId });
    assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "PROVIDER_TASK_ID_INVALID");
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_TASK_IDENTITY_REQUIRES_RECONCILIATION"
    });
    assert.equal(receipt?.provider_task_id, taskId);
    assert.equal(receipt?.state, "reconciling");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-AUTH-01] worker preserves a known paid task when a resumed capability drifts", async () => {
  const db = openM0Database(":memory:");
  const closeDb = db.close.bind(db);
  try {
    const prepared = await prepareConfirmedGeneration(":memory:", "Known task capability drift", {}, db);
    persistKnownProviderTask(":memory:", prepared.intent_id, prepared.job_id, "paid-task-known", DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS, db);
    db.prepare("UPDATE generation_intents SET model = 'stale-model' WHERE intent_id = ?").run(prepared.intent_id);
    db.close = () => undefined;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: ":memory:",
        env: prepared.env,
        open_database: () => db,
        adapter_factory: () => { throw new Error("adapter must not be created for capability drift"); }
      }
    });

    const intent = db.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    const job = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string };
    assert.equal(intent.status, "running");
    assert.equal(intent.provider_task_id, "paid-task-known");
    assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "GENERATION_EXECUTION_AUTHORITY_STALE");
    assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION" });
  } finally {
    closeDb();
  }
});

test("worker preserves a known paid task when the adapter contract drifts", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-known-task-adapter-drift-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Known task adapter drift");
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, "paid-task-adapter");
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

test("[EEI-AWAIT-01] rejected Provider awaits stay low-disclosure and preserve reconciliation rights", async (t) => {
  await t.test("submit rejection is treated as an unknown outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-submit-await-rejection-"));
    const sqlitePath = join(root, "app.sqlite");
    const rawError = "RAW_PROVIDER_SUBMIT_PAYLOAD_MUST_NOT_PERSIST";
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Rejected submit await");
      let submitCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          submitCalls += 1;
          throw new Error(rawError);
        },
        pollStatus: async () => { throw new Error("poll must not run after rejected submit await"); },
        fetchOutput: async () => { throw new Error("output must not run after rejected submit await"); }
      } as unknown as VideoProviderAdapter;

      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });

      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.equal(submitCalls, 1);
      assert.deepEqual({ status: intent.status, provider_task_id: intent.provider_task_id }, { status: "running", provider_task_id: "" });
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_SUBMIT_OUTCOME_UNKNOWN" });
      assert.equal(receipt?.state, "ambiguous");
      assert.equal(intent.sanitized_error_json.includes(rawError), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("poll rejection retains the known task", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-poll-await-rejection-"));
    const sqlitePath = join(root, "app.sqlite");
    const rawError = "RAW_PROVIDER_POLL_PAYLOAD_MUST_NOT_PERSIST";
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Rejected poll await");
      const taskId = "task-poll-await-rejection";
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
      let pollCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
        pollStatus: async () => {
          pollCalls += 1;
          throw new Error(rawError);
        },
        fetchOutput: async () => { throw new Error("output must not run after rejected poll await"); }
      } as unknown as VideoProviderAdapter;

      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });

      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.equal(pollCalls, 1);
      assert.deepEqual({ status: intent.status, provider_task_id: intent.provider_task_id }, { status: "running", provider_task_id: taskId });
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_POLL_REQUIRES_RECONCILIATION" });
      assert.equal(receipt?.state, "reconciling");
      assert.equal(intent.sanitized_error_json.includes(rawError), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("download rejection retains the known task and recovery evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-download-await-rejection-"));
    const sqlitePath = join(root, "app.sqlite");
    const rawError = "RAW_PROVIDER_DOWNLOAD_PAYLOAD_MUST_NOT_PERSIST";
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Rejected download await");
      const taskId = "task-download-await-rejection";
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
      let downloadCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
        pollStatus: async () => ({
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/rejected-download.mp4"
        }),
        fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
      } as unknown as VideoProviderAdapter;

      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: {
          sqlite_path: sqlitePath,
          env: prepared.env,
          adapter_factory: () => adapter,
          download_provider_output: (async () => {
            downloadCalls += 1;
            throw new Error(rawError);
          }) as typeof downloadProviderOutputToArtifact
        }
      });

      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.equal(downloadCalls, 1);
      assert.deepEqual({ status: intent.status, provider_task_id: intent.provider_task_id }, { status: "running", provider_task_id: taskId });
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION" });
      assert.equal(receipt?.state, "reconciling");
      assert.equal(intent.sanitized_error_json.includes(rawError), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("[EEI-AWAIT-02] Intent drift during resolved and rejected Provider awaits fails closed", async (t) => {
  const driftIntentModel = (sqlitePath: string, intentId: string): void => {
    const driftDb = openM0Database(sqlitePath);
    try {
      driftDb.prepare("UPDATE generation_intents SET model = 'drifted-after-await' WHERE intent_id = ?").run(intentId);
    } finally {
      driftDb.close();
    }
  };

  await t.test("rejected submit preserves an unknown outcome under current Intent authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-submit-reject-intent-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Rejected submit Intent drift");
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          driftIntentModel(sqlitePath, prepared.intent_id);
          throw new Error("RAW_REJECTED_SUBMIT_INTENT_DRIFT");
        },
        pollStatus: async () => { throw new Error("poll must not run after rejected submit"); },
        fetchOutput: async () => { throw new Error("output must not run after rejected submit"); }
      } as unknown as VideoProviderAdapter;

      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });

      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.equal(intent.status, "running");
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "GENERATION_EXECUTION_AUTHORITY_STALE");
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_SUBMIT_OUTCOME_UNKNOWN" });
      assert.equal(receipt?.state, "ambiguous");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("resolved submit error cannot retry after current Intent drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-submit-error-intent-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Resolved submit Intent drift");
      let submitCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          submitCalls += 1;
          driftIntentModel(sqlitePath, prepared.intent_id);
          return { ok: false as const, error: { code: "PROVIDER_AUTH_FAILED", message: "Synthetic rejection.", retryable: false } };
        },
        pollStatus: async () => { throw new Error("poll must not run after rejected submit"); },
        fetchOutput: async () => { throw new Error("output must not run after rejected submit"); }
      } as unknown as VideoProviderAdapter;

      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });

      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, submit_attempts, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; submit_attempts: number; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.equal(submitCalls, 1);
      assert.equal(intent.status, "failed");
      assert.equal(intent.submit_attempts, 1);
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "GENERATION_EXECUTION_AUTHORITY_STALE");
      assert.deepEqual({ ...job }, { state: "failed", reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_STALE" });
      assert.equal(receipt?.state, "failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const rejected of [true, false]) {
    await t.test(`${rejected ? "rejected" : "resolved-error"} download retains the known task under current Intent authority`, async () => {
      const root = mkdtempSync(join(tmpdir(), `generation-download-${rejected ? "reject" : "error"}-intent-drift-`));
      const sqlitePath = join(root, "app.sqlite");
      const taskId = `task-download-${rejected ? "reject" : "error"}-intent-drift`;
      try {
        const prepared = await prepareConfirmedGeneration(sqlitePath, "Download Intent drift");
        persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
        const adapter = {
          provider_name: "runninghub",
          model_name: "rhart-video-g/image-to-video",
          submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
          pollStatus: async () => ({
            ok: true as const,
            provider_job_id: taskId,
            status: "succeeded" as const,
            provider_status: "SUCCESS",
            retryable: false,
            output_url: "https://example.invalid/intent-drift.mp4"
          }),
          fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
        } as unknown as VideoProviderAdapter;
        const download = (async () => {
          driftIntentModel(sqlitePath, prepared.intent_id);
          if (rejected) throw new Error("RAW_REJECTED_DOWNLOAD_INTENT_DRIFT");
          return { ok: false as const, error: { code: "PROVIDER_REQUEST_FAILED", message: "Synthetic download failure.", retryable: false } };
        }) as typeof downloadProviderOutputToArtifact;

        await runWorkbenchGenerationOnce(prepared.intent_id, {
          allow_submit: false,
          dependencies: {
            sqlite_path: sqlitePath,
            env: prepared.env,
            adapter_factory: () => adapter,
            download_provider_output: download
          }
        });

        const checked = openM0Database(sqlitePath);
        const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
          .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
        const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
          .get(prepared.job_id) as { state: string; reconciliation_reason: string };
        const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
        checked.close();
        assert.deepEqual({ status: intent.status, provider_task_id: intent.provider_task_id }, { status: "running", provider_task_id: taskId });
        assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "GENERATION_EXECUTION_AUTHORITY_STALE");
        assert.deepEqual({ ...job }, {
          state: "manual_reconciliation",
          reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
        });
        assert.equal(receipt?.state, "reconciling");
        assert.equal(receipt?.provider_task_id, taskId);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("[EEI-AWAIT-04] RunningHub revalidates authority after upload before the paid submit effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-upload-pre-submit-authority-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Upload pre-submit authority drift");
    let uploadCalls = 0;
    let paidSubmitCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/openapi/v2/media/upload/binary")) {
        uploadCalls += 1;
        const driftDb = openM0Database(sqlitePath);
        driftDb.prepare("UPDATE generation_intents SET confirmed = 0 WHERE intent_id = ?").run(prepared.intent_id);
        driftDb.close();
        return new Response(JSON.stringify({
          data: { download_url: "https://runninghub-cdn.example/uploaded/authority-drift.png" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      paidSubmitCalls += 1;
      return new Response(JSON.stringify({
        taskId: "task-must-not-be-created-after-upload-drift",
        status: "PENDING",
        errorCode: "",
        errorMessage: ""
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: true,
      dependencies: { sqlite_path: sqlitePath, env: prepared.env, fetch_impl: fetchImpl }
    });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = checked.prepare("SELECT state FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    checked.close();
    assert.equal(uploadCalls, 1);
    assert.equal(paidSubmitCalls, 0);
    assert.equal(intent.provider_task_id, "");
    assert.equal(intent.status, "failed");
    assert.equal(job.state, "failed");
    assert.equal(receipt?.provider_task_id, "");
    assert.equal(receipt?.state, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-INTENT-01] revoked Intent confirmation blocks initial and post-await Provider execution", async (t) => {
  const revokeConfirmation = (sqlitePath: string, intentId: string): void => {
    const driftDb = openM0Database(sqlitePath);
    try {
      driftDb.prepare("UPDATE generation_intents SET confirmed = 0 WHERE intent_id = ?").run(intentId);
    } finally {
      driftDb.close();
    }
  };

  await t.test("before submit", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-confirmation-revoked-before-submit-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Confirmation revoked before submit");
      revokeConfirmation(sqlitePath, prepared.intent_id);
      let providerCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { providerCalls += 1; throw new Error("submit must not run"); },
        pollStatus: async () => { providerCalls += 1; throw new Error("poll must not run"); },
        fetchOutput: async () => { providerCalls += 1; throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });
      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      checked.close();
      assert.equal(providerCalls, 0);
      assert.equal(intent.status, "failed");
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "GENERATION_EXECUTION_AUTHORITY_STALE");
      assert.deepEqual({ ...job }, { state: "failed", reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_STALE" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("during successful submit", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-confirmation-revoked-during-submit-"));
    const sqlitePath = join(root, "app.sqlite");
    const taskId = "task-confirmation-revoked-submit";
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Confirmation revoked during submit");
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          revokeConfirmation(sqlitePath, prepared.intent_id);
          return { ok: true as const, provider_job_id: taskId, provider_status: "PENDING", sanitized_request: {} };
        },
        pollStatus: async () => { throw new Error("poll must not run after confirmation drift"); },
        fetchOutput: async () => { throw new Error("output must not run after confirmation drift"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });
      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, confirmed, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; confirmed: number; provider_task_id: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.deepEqual({ status: intent.status, confirmed: intent.confirmed, provider_task_id: intent.provider_task_id }, {
        status: "running", confirmed: 0, provider_task_id: taskId
      });
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code?: string }).code, undefined);
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION" });
      assert.equal(receipt?.state, "reconciling");
      assert.equal(receipt?.provider_task_id, taskId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("during poll", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-confirmation-revoked-during-poll-"));
    const sqlitePath = join(root, "app.sqlite");
    const taskId = "task-confirmation-revoked-poll";
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Confirmation revoked during poll");
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
      let downloadCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
        pollStatus: async () => {
          revokeConfirmation(sqlitePath, prepared.intent_id);
          return {
            ok: true as const,
            provider_job_id: taskId,
            status: "succeeded" as const,
            provider_status: "SUCCESS",
            retryable: false,
            output_url: "https://example.invalid/confirmation-revoked-poll.mp4"
          };
        },
        fetchOutput: async () => { throw new Error("output fetch must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: {
          sqlite_path: sqlitePath,
          env: prepared.env,
          adapter_factory: () => adapter,
          download_provider_output: (async () => {
            downloadCalls += 1;
            throw new Error("download must not run after confirmation drift");
          }) as typeof downloadProviderOutputToArtifact
        }
      });
      const checked = openM0Database(sqlitePath);
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      checked.close();
      assert.equal(downloadCalls, 0);
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("during download", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-confirmation-revoked-during-download-"));
    const sqlitePath = join(root, "app.sqlite");
    const taskId = "task-confirmation-revoked-download";
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Confirmation revoked during download");
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
        pollStatus: async () => ({
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/confirmation-revoked-download.mp4"
        }),
        fetchOutput: async () => { throw new Error("output fetch must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: {
          sqlite_path: sqlitePath,
          env: prepared.env,
          adapter_factory: () => adapter,
          download_provider_output: (async () => {
            revokeConfirmation(sqlitePath, prepared.intent_id);
            return { ok: false as const, error: { code: "PROVIDER_REQUEST_FAILED", message: "Synthetic download error.", retryable: false } };
          }) as typeof downloadProviderOutputToArtifact
        }
      });
      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { provider_task_id: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      checked.close();
      assert.equal(intent.provider_task_id, taskId);
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "GENERATION_EXECUTION_AUTHORITY_STALE");
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("[EEI-RUN-01] Generation Run authority is frozen before effects, after submit, and inside final activation", async (t) => {
  await t.test("row and payload identity drift blocks Provider submit", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-run-row-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Run row identity drift");
      const driftDb = openM0Database(sqlitePath);
      try {
        driftDb.prepare("UPDATE generation_runs SET data_json = json_set(data_json, '$.run_id', 'run_payload_drift') WHERE run_id = ?")
          .run(prepared.run_id);
      } finally {
        driftDb.close();
      }
      let submitCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          submitCalls += 1;
          throw new Error("submit must not run after Generation Run identity drift");
        },
        pollStatus: async () => { throw new Error("poll must not run"); },
        fetchOutput: async () => { throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });
      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
      const job = checked.prepare("SELECT state FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string };
      checked.close();
      assert.equal(submitCalls, 0);
      assert.equal(intent.status, "failed");
      assert.equal(intent.provider_task_id, "");
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "GENERATION_EXECUTION_AUTHORITY_STALE");
      assert.equal(job.state, "failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("post-submit Run input drift retains the known task for reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-run-submit-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Run submit drift");
      const taskId = "task-run-submit-drift";
      let submitCalls = 0;
      let pollCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          submitCalls += 1;
          const driftDb = openM0Database(sqlitePath);
          try {
            driftDb.prepare("UPDATE generation_runs SET data_json = json_set(data_json, '$.input.video_prompt', 'Run input drift after submit') WHERE run_id = ?")
              .run(prepared.run_id);
          } finally {
            driftDb.close();
          }
          return { ok: true as const, provider_job_id: taskId, provider_status: "PENDING", sanitized_request: {} };
        },
        pollStatus: async () => { pollCalls += 1; throw new Error("poll must not run after Run authority drift"); },
        fetchOutput: async () => { throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });
      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { status: string; provider_task_id: string };
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.equal(submitCalls, 1);
      assert.equal(pollCalls, 0);
      assert.deepEqual({ ...intent }, { status: "running", provider_task_id: taskId });
      assert.deepEqual({ ...job }, {
        state: "manual_reconciliation",
        reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
      });
      assert.equal(receipt?.state, "reconciling");
      assert.equal(receipt?.provider_task_id, taskId);
      assert.notEqual(receipt?.authority_snapshot.run.input.video_prompt, "Run input drift after submit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("Run drift inside final activation rolls back Artifact and domain success", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-run-finalization-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    const mediaRoot = join(root, "media");
    let newMarkerNames: string[] = [];
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Run finalization drift");
      const taskId = "task-run-finalization-drift";
      const artifactId = `artifact_${createHash("sha256").update(`runninghub\0${taskId}`).digest("hex")}`;
      const sourcePath = join(mediaRoot, "provider-source.mp4");
      mkdirSync(mediaRoot, { recursive: true });
      writeProviderOutputFixture(sourcePath);
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
      const markerNamesBefore = new Set(existsSync(paths.mediaActivationJournalRoot)
        ? readdirSync(paths.mediaActivationJournalRoot)
        : []);
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run"); },
        pollStatus: async () => ({
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/run-finalization-drift.mp4"
        }),
        fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
      } as unknown as VideoProviderAdapter;
      let activationErrorCode = "";
      const download: typeof downloadProviderOutputToArtifact = async (input, targetDb, runtime = {}) => {
        assert.ok(runtime.activate_artifact);
        const activated = runtime.activate_artifact({
          artifact: {
            artifact_id: artifactId,
            blob_id: "",
            artifact_type: "video",
            role: "generated_clip",
            status: "active",
            storage: { uri: join(mediaRoot, `${artifactId}.mp4`), mime_type: "video/mp4", filename: `${artifactId}.mp4` },
            metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "" },
            linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
            source: {
              kind: "provider_output_file",
              provider: "runninghub",
              provider_job_id: input.provider_job_id,
              sha256: "",
              external_url_host: "example.invalid"
            }
          },
          source_path: sourcePath,
          media_root: mediaRoot,
          before_artifact_persist: () => {
            targetDb.prepare("UPDATE generation_runs SET data_json = json_set(data_json, '$.provider.model_name', 'drifted-model') WHERE run_id = ?")
              .run(prepared.run_id);
          }
        }, targetDb);
        assert.equal(activated.ok, false);
        if (activated.ok) throw new Error("Run drift must not activate an Artifact");
        activationErrorCode = activated.error.code;
        return { ok: false, error: { code: activated.error.code, message: activated.error.message, retryable: false } };
      };
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: {
          sqlite_path: sqlitePath,
          env: prepared.env,
          adapter_factory: () => adapter,
          download_provider_output: download,
          provider_output_storage_directory: mediaRoot
        }
      });
      newMarkerNames = existsSync(paths.mediaActivationJournalRoot)
        ? readdirSync(paths.mediaActivationJournalRoot).filter((name) => !markerNamesBefore.has(name))
        : [];
      const checked = openM0Database(sqlitePath);
      const artifact = checked.prepare("SELECT artifact_id FROM media_artifacts WHERE artifact_id = ?").get(artifactId);
      const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const runRow = checked.prepare("SELECT json_extract(data_json, '$.provider.model_name') AS model_name FROM generation_runs WHERE run_id = ?")
        .get(prepared.run_id) as { model_name: string };
      const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
      checked.close();
      assert.equal(activationErrorCode, "GENERATION_EXECUTION_AUTHORITY_STALE");
      assert.equal(artifact, undefined);
      assert.equal(runRow.model_name, "rhart-video-g/image-to-video");
      assert.deepEqual({ ...job }, {
        state: "manual_reconciliation",
        reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
      });
      assert.equal(receipt?.state, "reconciling");
      assert.equal(newMarkerNames.length, 1);
    } finally {
      for (const name of newMarkerNames) rmSync(join(paths.mediaActivationJournalRoot, name), { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("[EEI-JOB-01] external Job stage ownership cannot be overwritten across Provider awaits", async (t) => {
  const moveJobToExternalReconciliation = (sqlitePath: string, jobId: string, reason: string): void => {
    const driftDb = openM0Database(sqlitePath);
    try {
      driftDb.prepare("UPDATE generation_jobs SET state = 'manual_reconciliation', reconciliation_reason = ? WHERE job_id = ?")
        .run(reason, jobId);
    } finally {
      driftDb.close();
    }
  };
  const assertExternalJobState = (sqlitePath: string, jobId: string, intentId: string, taskId: string, reason: string): void => {
    const checked = openM0Database(sqlitePath);
    try {
      const job = checked.prepare("SELECT state, reconciliation_reason, lease_token FROM generation_jobs WHERE job_id = ?")
        .get(jobId) as { state: string; reconciliation_reason: string; lease_token: string };
      const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
        .get(intentId) as { status: string; provider_task_id: string };
      assert.deepEqual({ state: job.state, reconciliation_reason: job.reconciliation_reason, lease_token: job.lease_token }, {
        state: "manual_reconciliation",
        reconciliation_reason: reason,
        lease_token: ""
      });
      assert.deepEqual({ ...intent }, { status: "running", provider_task_id: taskId });
    } finally {
      checked.close();
    }
  };
  const moveJobToExternalSameStageLease = (sqlitePath: string, jobId: string, reason: string, token: string): void => {
    const driftDb = openM0Database(sqlitePath);
    try {
      driftDb.prepare(`UPDATE generation_jobs
        SET reconciliation_reason = ?, lease_owner = 'external_worker', lease_token = ?,
          lease_expires_at = '2099-01-01T00:00:00.000Z'
        WHERE job_id = ? AND state = 'submitting'`).run(reason, token, jobId);
    } finally {
      driftDb.close();
    }
  };
  const assertExternalSameStageLease = (
    sqlitePath: string,
    jobId: string,
    intentId: string,
    taskId: string,
    reason: string,
    token: string
  ): void => {
    const checked = openM0Database(sqlitePath);
    try {
      const job = checked.prepare(`SELECT state, reconciliation_reason, lease_owner, lease_token, lease_expires_at
        FROM generation_jobs WHERE job_id = ?`).get(jobId) as {
          state: string;
          reconciliation_reason: string;
          lease_owner: string;
          lease_token: string;
          lease_expires_at: string | null;
        };
      const intent = checked.prepare("SELECT provider_task_id FROM generation_intents WHERE intent_id = ?")
        .get(intentId) as { provider_task_id: string };
      const receipt = getGenerationExecutionReceipt(checked, intentId);
      assert.deepEqual({ ...job }, {
        state: "submitting",
        reconciliation_reason: reason,
        lease_owner: "external_worker",
        lease_token: token,
        lease_expires_at: "2099-01-01T00:00:00.000Z"
      });
      assert.equal(intent.provider_task_id, taskId);
      assert.equal(receipt?.provider_task_id, taskId);
      assert.equal(receipt?.state, "reconciling");
    } finally {
      checked.close();
    }
  };

  for (const rejected of [false, true]) {
    await t.test(`${rejected ? "rejected" : "resolved-error"} submit without a task`, async () => {
      const root = mkdtempSync(join(tmpdir(), `generation-job-submit-${rejected ? "reject" : "error"}-stage-drift-`));
      const sqlitePath = join(root, "app.sqlite");
      try {
        const prepared = await prepareConfirmedGeneration(sqlitePath, `Job submit ${rejected ? "reject" : "error"} stage drift`);
        const reason = rejected ? "EXTERNAL_OWNER_DURING_REJECTED_SUBMIT" : "EXTERNAL_OWNER_DURING_RESOLVED_SUBMIT_ERROR";
        const adapter = {
          provider_name: "runninghub",
          model_name: "rhart-video-g/image-to-video",
          submitGeneration: async () => {
            moveJobToExternalReconciliation(sqlitePath, prepared.job_id, reason);
            if (rejected) throw new Error("INJECTED_REJECTED_SUBMIT_AFTER_EXTERNAL_STAGE_CHANGE");
            return {
              ok: false as const,
              error: { code: "PROVIDER_AUTH_FAILED", message: "Synthetic definite rejection.", retryable: false }
            };
          },
          pollStatus: async () => { throw new Error("poll must not run"); },
          fetchOutput: async () => { throw new Error("output must not run"); }
        } as unknown as VideoProviderAdapter;
        await runWorkbenchGenerationOnce(prepared.intent_id, {
          allow_submit: true,
          dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
        });
        const checked = openM0Database(sqlitePath);
        try {
          const job = checked.prepare("SELECT state, reconciliation_reason, lease_token FROM generation_jobs WHERE job_id = ?")
            .get(prepared.job_id) as { state: string; reconciliation_reason: string; lease_token: string };
          const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
            .get(prepared.intent_id) as { status: string; provider_task_id: string };
          const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
          assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: reason, lease_token: "" });
          assert.deepEqual({ ...intent }, { status: "queued", provider_task_id: "" });
          assert.equal(receipt?.state, "reserved");
        } finally {
          checked.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  await t.test("submit await", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-job-submit-stage-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Job submit stage drift");
      const taskId = "task-job-submit-stage-drift";
      let pollCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          moveJobToExternalReconciliation(sqlitePath, prepared.job_id, "EXTERNAL_OWNER_DURING_SUBMIT");
          return { ok: true as const, provider_job_id: taskId, provider_status: "PENDING", sanitized_request: {} };
        },
        pollStatus: async () => { pollCalls += 1; throw new Error("poll must not run"); },
        fetchOutput: async () => { throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });
      assert.equal(pollCalls, 0);
      assertExternalJobState(sqlitePath, prepared.job_id, prepared.intent_id, taskId, "EXTERNAL_OWNER_DURING_SUBMIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("submit await preserves a replacement owner that keeps the same submitting stage", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-job-submit-same-stage-takeover-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Job submit same-stage takeover");
      const taskId = "task-job-submit-same-stage-takeover";
      const reason = "EXTERNAL_OWNER_SAME_SUBMITTING_STAGE";
      const externalToken = "external_same_stage_submit_token";
      let pollCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => {
          moveJobToExternalSameStageLease(sqlitePath, prepared.job_id, reason, externalToken);
          return { ok: true as const, provider_job_id: taskId, provider_status: "PENDING", sanitized_request: {} };
        },
        pollStatus: async () => { pollCalls += 1; throw new Error("poll must not run after lease takeover"); },
        fetchOutput: async () => { throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
      });
      assert.equal(pollCalls, 0);
      assertExternalSameStageLease(
        sqlitePath,
        prepared.job_id,
        prepared.intent_id,
        taskId,
        reason,
        externalToken
      );
      const checked = openM0Database(sqlitePath);
      const currentProject = getProject(checked, prepared.project_id);
      const currentShot = getShot(checked, prepared.shot_id);
      checked.close();
      assert.equal(currentProject?.status, "video_generation_in_progress");
      assert.equal(currentShot?.status, "video_pending");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("persistence fallback preserves a replacement owner with the same submitting stage", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-job-fallback-same-stage-takeover-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Job fallback same-stage takeover");
      const taskId = "task-job-fallback-same-stage-takeover";
      const reason = "EXTERNAL_OWNER_DURING_PERSISTENCE_ROLLBACK";
      const externalToken = "external_fallback_same_stage_token";
      const setup = openM0Database(sqlitePath);
      setup.exec(`CREATE TRIGGER inject_same_stage_polling_event_failure BEFORE INSERT ON generation_job_events
        WHEN NEW.to_state = 'polling' BEGIN SELECT RAISE(ABORT, 'INJECTED_POLLING_EVENT_FAILURE'); END`);
      setup.close();
      const workerDb = openM0Database(sqlitePath);
      let takeoverInjected = false;
      const workerDatabase = new Proxy(workerDb, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string) => {
              const result = target.exec(sql);
              if (!takeoverInjected && sql.trim().toUpperCase() === "ROLLBACK") {
                target.prepare(`UPDATE generation_jobs
                  SET reconciliation_reason = ?, lease_owner = 'external_worker', lease_token = ?,
                    lease_expires_at = '2099-01-01T00:00:00.000Z'
                  WHERE job_id = ? AND state = 'submitting'`).run(reason, externalToken, prepared.job_id);
                takeoverInjected = true;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as ReturnType<typeof openM0Database>;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => ({
          ok: true as const,
          provider_job_id: taskId,
          provider_status: "PENDING",
          sanitized_request: {}
        }),
        pollStatus: async () => { throw new Error("poll must not run after persistence fallback"); },
        fetchOutput: async () => { throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: true,
        dependencies: {
          sqlite_path: sqlitePath,
          open_database: () => workerDatabase,
          env: prepared.env,
          adapter_factory: () => adapter
        }
      });
      assert.equal(takeoverInjected, true);
      assertExternalSameStageLease(
        sqlitePath,
        prepared.job_id,
        prepared.intent_id,
        taskId,
        reason,
        externalToken
      );
      const checked = openM0Database(sqlitePath);
      const currentProject = getProject(checked, prepared.project_id);
      const currentShot = getShot(checked, prepared.shot_id);
      checked.close();
      assert.equal(currentProject?.status, "video_generation_in_progress");
      assert.equal(currentShot?.status, "video_pending");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("poll await", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-job-poll-stage-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Job poll stage drift");
      const taskId = "task-job-poll-stage-drift";
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
      let downloadCalls = 0;
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run"); },
        pollStatus: async () => {
          moveJobToExternalReconciliation(sqlitePath, prepared.job_id, "EXTERNAL_OWNER_DURING_POLL");
          return {
            ok: true as const,
            provider_job_id: taskId,
            status: "succeeded" as const,
            provider_status: "SUCCESS",
            retryable: false,
            output_url: "https://example.invalid/job-poll-stage-drift.mp4"
          };
        },
        fetchOutput: async () => { throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: {
          sqlite_path: sqlitePath,
          env: prepared.env,
          adapter_factory: () => adapter,
          download_provider_output: (async () => {
            downloadCalls += 1;
            throw new Error("download must not run after Job stage drift");
          }) as typeof downloadProviderOutputToArtifact
        }
      });
      assert.equal(downloadCalls, 0);
      assertExternalJobState(sqlitePath, prepared.job_id, prepared.intent_id, taskId, "EXTERNAL_OWNER_DURING_POLL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("download await", async () => {
    const root = mkdtempSync(join(tmpdir(), "generation-job-download-stage-drift-"));
    const sqlitePath = join(root, "app.sqlite");
    try {
      const prepared = await prepareConfirmedGeneration(sqlitePath, "Job download stage drift");
      const taskId = "task-job-download-stage-drift";
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
      const adapter = {
        provider_name: "runninghub",
        model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run"); },
        pollStatus: async () => ({
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/job-download-stage-drift.mp4"
        }),
        fetchOutput: async () => { throw new Error("output must not run"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: {
          sqlite_path: sqlitePath,
          env: prepared.env,
          adapter_factory: () => adapter,
          download_provider_output: (async () => {
            moveJobToExternalReconciliation(sqlitePath, prepared.job_id, "EXTERNAL_OWNER_DURING_DOWNLOAD");
            return {
              ok: false as const,
              error: { code: "INJECTED_DOWNLOAD_STOP", message: "Injected download stop.", retryable: false }
            };
          }) as typeof downloadProviderOutputToArtifact
        }
      });
      assertExternalJobState(sqlitePath, prepared.job_id, prepared.intent_id, taskId, "EXTERNAL_OWNER_DURING_DOWNLOAD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("[EEI-TASK-05] mismatched Provider poll identities never replace the retained task", async (t) => {
  for (const scenario of [
    { name: "nonterminal", status: "running" as const, provider_status: "RUNNING", retryable: true },
    { name: "terminal", status: "failed" as const, provider_status: "FAILED", retryable: false },
    { name: "success", status: "succeeded" as const, provider_status: "SUCCESS", retryable: false }
  ]) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), `generation-poll-task-mismatch-${scenario.name}-`));
      const sqlitePath = join(root, "app.sqlite");
      try {
        const prepared = await prepareConfirmedGeneration(sqlitePath, `Poll task mismatch ${scenario.name}`);
        const retainedTaskId = `task-poll-retained-${scenario.name}`;
        persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, retainedTaskId);
        let downloadCalls = 0;
        const adapter = {
          provider_name: "runninghub",
          model_name: "rhart-video-g/image-to-video",
          submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
          pollStatus: async () => ({
            ok: true as const,
            provider_job_id: `task-poll-foreign-${scenario.name}`,
            status: scenario.status,
            provider_status: scenario.provider_status,
            retryable: scenario.retryable,
            ...(scenario.status === "succeeded" ? { output_url: "https://example.invalid/foreign-task.mp4" } : {})
          }),
          fetchOutput: async () => { throw new Error("output must not run"); }
        } as unknown as VideoProviderAdapter;
        await runWorkbenchGenerationOnce(prepared.intent_id, {
          allow_submit: false,
          dependencies: {
            sqlite_path: sqlitePath,
            env: prepared.env,
            adapter_factory: () => adapter,
            download_provider_output: (async () => {
              downloadCalls += 1;
              throw new Error("download must not run for a mismatched poll task");
            }) as typeof downloadProviderOutputToArtifact
          }
        });
        const checked = openM0Database(sqlitePath);
        const intent = checked.prepare("SELECT provider_task_id, output_artifact_id FROM generation_intents WHERE intent_id = ?")
          .get(prepared.intent_id) as { provider_task_id: string; output_artifact_id: string };
        const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
          .get(prepared.job_id) as { state: string; reconciliation_reason: string };
        const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
        checked.close();
        assert.equal(downloadCalls, 0);
        assert.deepEqual({ ...intent }, { provider_task_id: retainedTaskId, output_artifact_id: "" });
        assert.deepEqual({ ...job }, {
          state: "manual_reconciliation",
          reconciliation_reason: "PROVIDER_POLL_REQUIRES_RECONCILIATION"
        });
        assert.equal(receipt?.provider_task_id, retainedTaskId);
        assert.equal(receipt?.state, "reconciling");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("[EEI-STATUS-01] untrusted Provider status strings are never persisted or projected", async (t) => {
  for (const scenario of [
    { name: "nonterminal", status: "running" as const },
    { name: "terminal", status: "failed" as const },
    { name: "success", status: "succeeded" as const }
  ]) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), `generation-provider-status-${scenario.name}-`));
      const sqlitePath = join(root, "app.sqlite");
      const sentinel = `provider-secret-${scenario.name}-${"X".repeat(512)}`;
      try {
        const prepared = await prepareConfirmedGeneration(sqlitePath, `Provider status ${scenario.name}`);
        const taskId = `task-provider-status-${scenario.name}`;
        persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
        const adapter = {
          provider_name: "runninghub",
          model_name: "rhart-video-g/image-to-video",
          submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
          pollStatus: async () => ({
            ok: true as const,
            provider_job_id: taskId,
            status: scenario.status,
            provider_status: sentinel,
            retryable: scenario.status === "running",
            ...(scenario.status === "succeeded" ? { output_url: "https://example.invalid/status.mp4" } : {})
          }),
          fetchOutput: async () => { throw new Error("output must not run"); }
        } as unknown as VideoProviderAdapter;
        await runWorkbenchGenerationOnce(prepared.intent_id, {
          allow_submit: false,
          dependencies: {
            sqlite_path: sqlitePath,
            env: prepared.env,
            adapter_factory: () => adapter,
            download_provider_output: (async () => ({
              ok: false as const,
              error: { code: "INJECTED_STATUS_TEST_STOP", message: "Synthetic stop.", retryable: false }
            })) as typeof downloadProviderOutputToArtifact
          }
        });
        const checked = openM0Database(sqlitePath);
        const intent = checked.prepare(`SELECT status, provider_task_id, sanitized_error_json, data_json
          FROM generation_intents WHERE intent_id = ?`).get(prepared.intent_id) as Record<string, unknown>;
        const run = checked.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?")
          .get(prepared.run_id) as { data_json: string };
        const receipt = checked.prepare(`SELECT provider_status FROM generation_execution_receipts
          WHERE intent_id = ?`).get(prepared.intent_id) as { provider_status: string };
        const events = checked.prepare(`SELECT reason_code, data_json FROM generation_job_events
          WHERE job_id = ?`).all(prepared.job_id) as Array<{ reason_code: string; data_json: string }>;
        checked.close();
        const persisted = JSON.stringify({ intent, run: JSON.parse(run.data_json), receipt, events });
        assert.equal(persisted.includes(sentinel), false);
        assert.match(receipt.provider_status, /^[A-Z0-9._:-]{0,128}$/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("[EEI-TASK-01] a paid submit is persisted before post-await Project authority drift enters reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-submit-authority-drift-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Submit authority drift");
    let submitCalls = 0;
    let pollCalls = 0;
    const taskId = "task-submit-authority-drift";
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        const driftDb = openM0Database(sqlitePath);
        try {
          const project = getProject(driftDb, prepared.project_id);
          assert.ok(project);
          project.video_spec.resolution = "720x1280";
          saveProject(driftDb, project);
        } finally {
          driftDb.close();
        }
        return { ok: true as const, provider_job_id: taskId, provider_status: "PENDING", sanitized_request: {} };
      },
      pollStatus: async () => { pollCalls += 1; throw new Error("poll must not run after submit authority drift"); },
      fetchOutput: async () => { throw new Error("output must not run after submit authority drift"); }
    } as unknown as VideoProviderAdapter;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: true,
      dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
    });
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: true,
      dependencies: { sqlite_path: sqlitePath, env: prepared.env, adapter_factory: () => adapter }
    });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    const currentProject = getProject(checked, prepared.project_id);
    const abandoned = reconcileGenerationJob(prepared.job_id, {
      decision: "abandon",
      reason: "Authority changed after paid submit.",
      human_confirmation: true
    }, checked, { env: prepared.env });
    const reconciledJob = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 0);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: taskId });
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
    });
    assert.equal(receipt?.provider_task_id, taskId);
    assert.equal(receipt?.state, "reconciling");
    assert.equal(receipt?.authority_snapshot.project.video_spec.resolution, "1080x1920");
    assert.equal(currentProject?.video_spec.resolution, "720x1280");
    assert.equal(abandoned.ok, true, abandoned.ok ? undefined : abandoned.error.code);
    assert.deepEqual({ ...reconciledJob }, { state: "cancelled", reconciliation_reason: "Authority changed after paid submit." });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-SHOT-01] post-poll SHOT drift preserves the retained task and blocks download", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-poll-authority-drift-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Poll authority drift");
    const taskId = "task-poll-authority-drift";
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    let submitCalls = 0;
    let pollCalls = 0;
    let downloadCalls = 0;
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { submitCalls += 1; throw new Error("submit must not run for retained task"); },
      pollStatus: async () => {
        pollCalls += 1;
        const driftDb = openM0Database(sqlitePath);
        try {
          const shot = getShot(driftDb, prepared.shot_id);
          assert.ok(shot);
          shot.video_prompt = "Drifted while the Provider poll was awaited.";
          saveShot(driftDb, shot);
        } finally {
          driftDb.close();
        }
        return {
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/must-not-download.mp4"
        };
      },
      fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
    } as unknown as VideoProviderAdapter;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: (async () => {
          downloadCalls += 1;
          throw new Error("download must not run after poll authority drift");
        }) as typeof downloadProviderOutputToArtifact
      }
    });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    checked.close();
    assert.equal(submitCalls, 0);
    assert.equal(pollCalls, 1);
    assert.equal(downloadCalls, 0);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: taskId });
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
    });
    assert.equal(receipt?.state, "reconciling");
    assert.equal(receipt?.provider_task_id, taskId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-PACKAGE-01] post-poll Storyboard Package replacement preserves the retained task and frozen package receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-package-authority-drift-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Package authority drift");
    const taskId = "task-package-authority-drift";
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    let downloadCalls = 0;
    let replacementPackageId = "";
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
      pollStatus: async () => {
        const driftDb = openM0Database(sqlitePath);
        try {
          const project = getProject(driftDb, prepared.project_id);
          const shot = getShot(driftDb, prepared.shot_id);
          assert.ok(project);
          assert.ok(shot);
          replacementPackageId = `package_replacement_${shot.shot_id}`;
          saveStoryboardPackage(driftDb, {
            storyboard_package_id: replacementPackageId,
            project_id: project.project_id,
            status: "approved_for_video_generation",
            approved_shot_snapshots: [{
              shot_id: shot.shot_id,
              order: shot.order,
              duration_seconds: shot.duration_seconds,
              description: shot.description,
              storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
              video_prompt: shot.video_prompt,
              negative_prompt: shot.negative_prompt
            }],
            user_approval: { storyboard_approved: true }
          });
          project.active_storyboard_package_id = replacementPackageId;
          saveProject(driftDb, project);
        } finally {
          driftDb.close();
        }
        return {
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/must-not-download-package-drift.mp4"
        };
      },
      fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
    } as unknown as VideoProviderAdapter;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: (async () => {
          downloadCalls += 1;
          throw new Error("download must not run after Storyboard Package drift");
        }) as typeof downloadProviderOutputToArtifact
      }
    });

    const checked = openM0Database(sqlitePath);
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    const currentProject = getProject(checked, prepared.project_id);
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    assert.equal(downloadCalls, 0);
    assert.equal(receipt?.state, "reconciling");
    assert.notEqual(receipt?.storyboard_package_id, replacementPackageId);
    assert.equal(currentProject?.active_storyboard_package_id, replacementPackageId);
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "GENERATION_EXECUTION_AUTHORITY_REQUIRES_RECONCILIATION"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-ACTIVATION-01] Provider Artifact finalization rollback retains its marker and reconciliation binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-finalization-rollback-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const taskId = "task-finalization-rollback";
  const markerNamesBefore = existsSync(paths.mediaActivationJournalRoot)
    ? new Set(readdirSync(paths.mediaActivationJournalRoot))
    : new Set<string>();
  let newMarkerNames: string[] = [];
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Finalization rollback");
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    const fixturePath = join(mediaRoot, "provider-source.mp4");
    writeProviderOutputFixture(fixturePath);
    const fixture = readFileSync(fixturePath);
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
      pollStatus: async () => ({
        ok: true as const,
        provider_job_id: taskId,
        status: "succeeded" as const,
        provider_status: "SUCCESS",
        retryable: false,
        output_url: "https://example.invalid/finalization-rollback.mp4"
      }),
      fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
    } as unknown as VideoProviderAdapter;
    const download: typeof downloadProviderOutputToArtifact = async (input, targetDb, runtime = {}) =>
      downloadProviderOutputToArtifact({ ...input, storage_directory: mediaRoot }, targetDb, {
        ...runtime,
        storage_root: mediaRoot,
        resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
        fetch_pinned_address: async () => new Response(fixture, {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(fixture.length) }
        })
      });

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: download,
        provider_output_storage_directory: mediaRoot,
        fault_injection_after_provider_artifact_persist: () => {
          throw new Error("INJECTED_AFTER_PROVIDER_ARTIFACT_PERSIST");
        }
      }
    });

    newMarkerNames = existsSync(paths.mediaActivationJournalRoot)
      ? readdirSync(paths.mediaActivationJournalRoot).filter((name) => !markerNamesBefore.has(name))
      : [];
    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id, output_artifact_id FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string; output_artifact_id: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const artifactCount = checked.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE json_valid(data_json) = 1 AND json_extract(data_json, '$.source.provider_job_id') = ?`)
      .get(taskId) as { count: number };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    assert.equal(newMarkerNames.length, 1);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: taskId, output_artifact_id: "" });
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
    });
    assert.equal(artifactCount.count, 0);
    assert.equal(receipt?.state, "reconciling");
    assert.equal(receipt?.result_artifact_id, null);
    const recovered = recoverMediaActivations(checked);
    assert.equal(recovered.failed.some((failure) => failure.code === "MEDIA_ACTIVATION_DB_RECORD_MISSING"), true);
    checked.close();
    assert.equal(newMarkerNames.every((name) => !existsSync(join(paths.mediaActivationJournalRoot, name))), true);
  } finally {
    for (const name of newMarkerNames) rmSync(join(paths.mediaActivationJournalRoot, name), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-DOWNLOAD-01] an injected downloader cannot claim a Provider output outside the worker finalization capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-untrusted-downloader-output-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const taskId = "task-untrusted-downloader-output";
  const artifactId = "artifact_untrusted_downloader_output";
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Untrusted downloader output");
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
      pollStatus: async () => ({
        ok: true as const,
        provider_job_id: taskId,
        status: "succeeded" as const,
        provider_status: "SUCCESS",
        retryable: false,
        output_url: "https://example.invalid/untrusted-downloader.mp4"
      }),
      fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
    } as unknown as VideoProviderAdapter;
    const download = (async (input, targetDb) => {
      const activated = activateLocalMediaArtifact({
        artifact: {
          artifact_id: artifactId,
          blob_id: "",
          artifact_type: "video",
          role: "generated_clip",
          status: "active",
          storage: { uri: join(mediaRoot, `${artifactId}.mp4`), mime_type: "video/mp4", filename: `${artifactId}.mp4` },
          metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "" },
          linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
          source: {
            kind: "provider_output_file",
            provider: "runninghub",
            provider_job_id: input.provider_job_id,
            sha256: "",
            external_url_host: "example.invalid"
          }
        },
        source_path: resolve("fixtures/video/mock_clip.mp4"),
        media_root: mediaRoot
      }, targetDb);
      assert.equal(activated.ok, true);
      return {
        ok: true as const,
        artifact: activated.artifact,
        ffprobe: {
          status: "PASS" as const,
          path: activated.artifact.storage.uri,
          ffprobe_exit_code: 0,
          has_video_stream: true,
          width: 1080,
          height: 1920,
          duration_seconds: 6,
          stream_count: 1,
          error: ""
        },
        output_url_hostname: "example.invalid"
      };
    }) as typeof downloadProviderOutputToArtifact;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: download
      }
    });

    const checked = openM0Database(sqlitePath);
    const artifact = checked.prepare("SELECT status, data_json FROM media_artifacts WHERE artifact_id = ?")
      .get(artifactId) as { status: string; data_json: string };
    const intent = checked.prepare("SELECT status, output_artifact_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; output_artifact_id: string; sanitized_error_json: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    checked.close();
    assert.equal(artifact.status, "archived");
    assert.equal((JSON.parse(artifact.data_json) as { status: string }).status, "archived");
    assert.deepEqual({ status: intent.status, output_artifact_id: intent.output_artifact_id }, { status: "running", output_artifact_id: "" });
    assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "PROVIDER_OUTPUT_ACTIVATION_REQUIRED");
    assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION" });
    assert.equal(receipt?.state, "reconciling");
    assert.equal(receipt?.result_artifact_id, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-DOWNLOAD-02] archive failure keeps an untrusted output recovery-bound and blocks retry adoption", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-untrusted-archive-failure-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const taskId = "task-untrusted-archive-failure";
  const artifactId = "artifact_untrusted_archive_failure";
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Untrusted archive failure");
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    const setup = openM0Database(sqlitePath);
    setup.exec(`CREATE TRIGGER inject_untrusted_archive_failure BEFORE UPDATE OF status ON media_artifacts
      WHEN OLD.artifact_id = '${artifactId}' AND NEW.status = 'archived'
      BEGIN SELECT RAISE(ABORT, 'INJECTED_UNTRUSTED_ARCHIVE_FAILURE'); END`);
    setup.close();
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
      pollStatus: async () => ({
        ok: true as const,
        provider_job_id: taskId,
        status: "succeeded" as const,
        provider_status: "SUCCESS",
        retryable: false,
        output_url: "https://example.invalid/untrusted-archive-failure.mp4"
      }),
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const untrustedDownload = (async (input, targetDb) => {
      const activated = activateLocalMediaArtifact({
        artifact: {
          artifact_id: artifactId,
          blob_id: "",
          artifact_type: "video",
          role: "generated_clip",
          status: "active",
          storage: { uri: join(mediaRoot, `${artifactId}.mp4`), mime_type: "video/mp4", filename: `${artifactId}.mp4` },
          metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "" },
          linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
          source: {
            kind: "provider_output_file",
            provider: "runninghub",
            provider_job_id: input.provider_job_id,
            sha256: "",
            external_url_host: "example.invalid"
          }
        },
        source_path: resolve("fixtures/video/mock_clip.mp4"),
        media_root: mediaRoot
      }, targetDb);
      assert.equal(activated.ok, true);
      if (!activated.ok) return activated;
      return {
        ok: true as const,
        artifact: activated.artifact,
        ffprobe: {
          status: "PASS" as const,
          path: activated.artifact.storage.uri,
          ffprobe_exit_code: 0,
          has_video_stream: true,
          width: 1080,
          height: 1920,
          duration_seconds: 6,
          stream_count: 1,
          error: ""
        },
        output_url_hostname: "example.invalid"
      };
    }) as typeof downloadProviderOutputToArtifact;
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: untrustedDownload
      }
    });

    let checked = openM0Database(sqlitePath);
    const firstArtifact = checked.prepare("SELECT status FROM media_artifacts WHERE artifact_id = ?")
      .get(artifactId) as { status: string };
    const firstIntent = checked.prepare("SELECT output_artifact_id, data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { output_artifact_id: string; data_json: string };
    const recovery = (JSON.parse(firstIntent.data_json) as {
      provider_output_recovery: { provider_task_id: string; invalid_artifact_id: string; local_identity: string };
    }).provider_output_recovery;
    assert.equal(firstArtifact.status, "active");
    assert.equal(firstIntent.output_artifact_id, "");
    assert.equal(recovery.provider_task_id, taskId);
    assert.equal(recovery.invalid_artifact_id, artifactId);
    checked.exec("DROP TRIGGER inject_untrusted_archive_failure");
    const attached = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: taskId,
      human_confirmation: true
    }, checked, { env: prepared.env });
    assert.equal(attached.ok, true, attached.ok ? undefined : attached.error.code);
    checked.close();

    let retryDownloadCalls = 0;
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: (async () => {
          retryDownloadCalls += 1;
          return { ok: false as const, error: { code: "INJECTED_RETRY_STOP", message: "Synthetic retry stop.", retryable: false } };
        }) as typeof downloadProviderOutputToArtifact
      }
    });
    checked = openM0Database(sqlitePath);
    const retriedIntent = checked.prepare("SELECT output_artifact_id, data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { output_artifact_id: string; data_json: string };
    const retriedArtifact = checked.prepare("SELECT status FROM media_artifacts WHERE artifact_id = ?")
      .get(artifactId) as { status: string };
    checked.close();
    assert.equal(retryDownloadCalls, 1);
    assert.equal(retriedIntent.output_artifact_id, "");
    assert.equal(retriedArtifact.status, "active");
    assert.equal((JSON.parse(retriedIntent.data_json) as { provider_output_recovery: { invalid_artifact_id: string } })
      .provider_output_recovery.invalid_artifact_id, artifactId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-DOWNLOAD-03] worker activation capability rejects confused-deputy Artifact bindings", async (t) => {
  for (const mutation of ["project", "role", "task", "path", "spec", "root", "duration", "dimensions", "metadata"] as const) {
    await t.test(mutation, async () => {
      const root = mkdtempSync(join(tmpdir(), `generation-activation-binding-${mutation}-`));
      const sqlitePath = join(root, "app.sqlite");
      const mediaRoot = join(root, "media");
      try {
        const suppliedMediaRoot = mutation === "root" ? join(root, "outside-media") : mediaRoot;
        mkdirSync(suppliedMediaRoot, { recursive: true });
        const sourcePath = join(suppliedMediaRoot, "provider-source.mp4");
        if (mutation === "duration") {
          writeFileSync(sourcePath, readFileSync(resolve("fixtures/video/mock_clip.mp4")));
        } else if (mutation === "dimensions") {
          writeProviderOutputFixture(sourcePath, { width: 720, height: 1280 });
        } else {
          writeProviderOutputFixture(sourcePath);
        }
        const prepared = await prepareConfirmedGeneration(sqlitePath, `Activation binding ${mutation}`);
        const taskId = `task-activation-binding-${mutation}`;
        const artifactId = `artifact_${createHash("sha256").update(`runninghub\0${taskId}`).digest("hex")}`;
        persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
        const adapter = {
          provider_name: "runninghub",
          model_name: "rhart-video-g/image-to-video",
          submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
          pollStatus: async () => ({
            ok: true as const,
            provider_job_id: taskId,
            status: "succeeded" as const,
            provider_status: "SUCCESS",
            retryable: false,
            output_url: "https://example.invalid/capability-binding.mp4"
          }),
          fetchOutput: async () => { throw new Error("output must not run"); }
        } as unknown as VideoProviderAdapter;
        const download = (async (_input, targetDb, runtime = {}) => {
          assert.ok(runtime.activate_artifact);
          const artifact: MediaArtifact = {
            artifact_id: artifactId,
            blob_id: "",
            artifact_type: "video",
            role: "generated_clip",
            status: "active",
            storage: {
              uri: join(suppliedMediaRoot, `${artifactId}.mp4`),
              mime_type: "video/mp4",
              filename: `${artifactId}.mp4`
            },
            metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "" },
            linked_objects: { project_id: prepared.project_id, shot_id: prepared.shot_id },
            source: {
              kind: "provider_output_file",
              provider: "runninghub",
              provider_job_id: taskId,
              sha256: "",
              external_url_host: "example.invalid"
            }
          };
          if (mutation === "project") artifact.linked_objects.project_id = "project_foreign";
          if (mutation === "role") artifact.role = "final_video";
          if (mutation === "task") artifact.source.provider_job_id = "task_foreign";
          if (mutation === "path") artifact.storage.uri = join(mediaRoot, "unexpected-output.mp4");
          if (mutation === "spec") artifact.metadata.aspect_ratio = "16:9";
          if (mutation === "metadata") {
            artifact.metadata.width = 720;
            artifact.metadata.height = 1280;
          }
          const activated = runtime.activate_artifact({ artifact, source_path: sourcePath, media_root: suppliedMediaRoot }, targetDb);
          assert.equal(activated.ok, false);
          if (!activated.ok) assert.equal(activated.error.code, "PROVIDER_OUTPUT_BINDING_INVALID");
          return activated;
        }) as typeof downloadProviderOutputToArtifact;

        await runWorkbenchGenerationOnce(prepared.intent_id, {
          allow_submit: false,
          dependencies: {
            sqlite_path: sqlitePath,
            env: prepared.env,
            adapter_factory: () => adapter,
            download_provider_output: download,
            provider_output_storage_directory: mediaRoot
          }
        });
        const checked = openM0Database(sqlitePath);
        const artifactCount = checked.prepare("SELECT COUNT(*) AS count FROM media_artifacts WHERE artifact_id = ?")
          .get(artifactId) as { count: number };
        const intent = checked.prepare("SELECT status, output_artifact_id FROM generation_intents WHERE intent_id = ?")
          .get(prepared.intent_id) as { status: string; output_artifact_id: string };
        const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
          .get(prepared.job_id) as { state: string; reconciliation_reason: string };
        checked.close();
        assert.equal(artifactCount.count, 0);
        assert.deepEqual({ ...intent }, { status: "running", output_artifact_id: "" });
        assert.deepEqual({ ...job }, {
          state: "manual_reconciliation",
          reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("[EEI-AUTH-02] final activation transaction revalidates SHOT authority immediately before Artifact persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-final-authority-recheck-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const taskId = "task-final-authority-recheck";
  const markerNamesBefore = existsSync(paths.mediaActivationJournalRoot)
    ? new Set(readdirSync(paths.mediaActivationJournalRoot))
    : new Set<string>();
  let newMarkerNames: string[] = [];
  let activationErrorCode = "";
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Final authority recheck");
    const artifactId = `artifact_${createHash("sha256").update(`runninghub\0${taskId}`).digest("hex")}`;
    const sourcePath = join(mediaRoot, "provider-source.mp4");
    mkdirSync(mediaRoot, { recursive: true });
    writeProviderOutputFixture(sourcePath);
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run for retained task"); },
      pollStatus: async () => ({
        ok: true as const,
        provider_job_id: taskId,
        status: "succeeded" as const,
        provider_status: "SUCCESS",
        retryable: false,
        output_url: "https://example.invalid/final-authority-recheck.mp4"
      }),
      fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
    } as unknown as VideoProviderAdapter;
    const download: typeof downloadProviderOutputToArtifact = async (input, targetDb, runtime = {}) => {
      assert.ok(runtime.activate_artifact);
      const activated = runtime.activate_artifact({
        artifact: {
          artifact_id: artifactId,
          blob_id: "",
          artifact_type: "video",
          role: "generated_clip",
          status: "active",
          storage: { uri: join(mediaRoot, `${artifactId}.mp4`), mime_type: "video/mp4", filename: `${artifactId}.mp4` },
          metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "" },
          linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
          source: {
            kind: "provider_output_file",
            provider: "runninghub",
            provider_job_id: input.provider_job_id,
            sha256: "",
            external_url_host: "example.invalid"
          }
        },
        source_path: sourcePath,
        media_root: mediaRoot,
        before_artifact_persist: () => {
          const drifted = getShot(targetDb, prepared.shot_id);
          assert.ok(drifted);
          drifted.video_prompt = "Drift injected inside final activation transaction.";
          saveShot(targetDb, drifted);
        }
      }, targetDb);
      assert.equal(activated.ok, false);
      if (activated.ok) throw new Error("stale authority must not activate an Artifact");
      activationErrorCode = activated.error.code;
      return { ok: false, error: { code: activated.error.code, message: activated.error.message, retryable: false } };
    };

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: download,
        provider_output_storage_directory: mediaRoot
      }
    });

    newMarkerNames = existsSync(paths.mediaActivationJournalRoot)
      ? readdirSync(paths.mediaActivationJournalRoot).filter((name) => !markerNamesBefore.has(name))
      : [];
    const checked = openM0Database(sqlitePath);
    const artifact = checked.prepare("SELECT artifact_id FROM media_artifacts WHERE artifact_id = ?").get(artifactId);
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    recoverMediaActivations(checked);
    checked.close();
    assert.equal(activationErrorCode, "GENERATION_EXECUTION_AUTHORITY_STALE");
    assert.equal(newMarkerNames.length, 1);
    assert.equal(artifact, undefined);
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
    });
    assert.equal(receipt?.state, "reconciling");
  } finally {
    for (const name of newMarkerNames) rmSync(join(paths.mediaActivationJournalRoot, name), { force: true });
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

test("provider polling uses one persisted absolute deadline and never resubmits after timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-poll-timeout-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Absolute polling deadline");
    const baseWallMs = Date.now();
    let wallMs = baseWallMs;
    let monotonicMs = 10_000;
    let submitCalls = 0;
    let pollCalls = 0;
    const pollRequestTimeouts: number[] = [];
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        return { ok: true as const, provider_job_id: "task-absolute-deadline", provider_status: "PENDING", sanitized_request: {} };
      },
      pollStatus: async (_taskId: string, options?: ProviderPollOptions) => {
        pollCalls += 1;
        pollRequestTimeouts.push(options?.timeout_ms ?? -1);
        if (pollCalls === 1) {
          return { ok: false as const, error: { code: "PROVIDER_TIMEOUT", message: "Synthetic retryable poll failure.", retryable: true } };
        }
        return {
          ok: true as const,
          provider_job_id: "task-absolute-deadline",
          status: "running" as const,
          provider_status: "RUNNING",
          retryable: true
        };
      },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const dependencies = {
      sqlite_path: sqlitePath,
      env: { ...prepared.env },
      adapter_factory: () => adapter,
      poll_interval_ms: DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS * 2,
      now: () => new Date(wallMs),
      monotonic_now_ms: () => monotonicMs
    };
    const before = openM0Database(sqlitePath);
    const artifactCountBefore = (before.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count;
    before.close();

    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: true, dependencies });
    let checked = openM0Database(sqlitePath);
    const submittedIntent = checked.prepare("SELECT provider_task_id, data_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { provider_task_id: string; data_json: string };
    const persistedDeadline = Date.parse((JSON.parse(submittedIntent.data_json) as { provider_poll_deadline_at: string }).provider_poll_deadline_at);
    const submittedJob = checked.prepare("SELECT next_attempt_at FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { next_attempt_at: string };
    checked.close();
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 0);
    assert.equal(submittedIntent.provider_task_id, "task-absolute-deadline");
    assert.equal(persistedDeadline, baseWallMs + DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS);
    assert.equal(Date.parse(submittedJob.next_attempt_at), persistedDeadline);

    wallMs += 100_000;
    monotonicMs += 100_000;
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });
    checked = openM0Database(sqlitePath);
    const afterTransient = checked.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { data_json: string };
    const transientJob = checked.prepare("SELECT state, reconciliation_reason, next_attempt_at FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string; next_attempt_at: string };
    checked.close();
    assert.equal(Date.parse((JSON.parse(afterTransient.data_json) as { provider_poll_deadline_at: string }).provider_poll_deadline_at), persistedDeadline);
    assert.deepEqual({ state: transientJob.state, reconciliation_reason: transientJob.reconciliation_reason }, { state: "polling", reconciliation_reason: "" });
    assert.equal(Date.parse(transientJob.next_attempt_at), persistedDeadline);

    wallMs += 100_000;
    monotonicMs += 100_000;
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });
    checked = openM0Database(sqlitePath);
    const afterRunning = checked.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { data_json: string };
    checked.close();
    assert.equal(Date.parse((JSON.parse(afterRunning.data_json) as { provider_poll_deadline_at: string }).provider_poll_deadline_at), persistedDeadline);
    assert.deepEqual(pollRequestTimeouts, [
      DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS - 100_000,
      DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS - 200_000
    ]);

    wallMs = persistedDeadline;
    monotonicMs += DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS - 200_000;
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });
    checked = openM0Database(sqlitePath);
    const timedOutIntent = checked.prepare("SELECT status, provider_task_id, submit_attempts, sanitized_error_json, run_id FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as {
      status: string; provider_task_id: string; submit_attempts: number; sanitized_error_json: string; run_id: string;
    };
    const timedOutJob = checked.prepare(`SELECT state, reconciliation_reason, lease_owner, lease_token, lease_expires_at
      FROM generation_jobs WHERE job_id = ?`).get(prepared.job_id) as {
        state: string; reconciliation_reason: string; lease_owner: string; lease_token: string; lease_expires_at: string | null;
      };
    const timedOutRun = checked.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?").get(timedOutIntent.run_id) as { data_json: string };
    const timedOutProject = checked.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(prepared.project_id) as { data_json: string };
    const timedOutShot = checked.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(prepared.shot_id) as { data_json: string };
    const timedOutSummary = listWorkbenchProjects({ scope: "all" }, checked).items
      .find((item) => item.project.project_id === prepared.project_id);
    const timedOutWorker = generationWorkerStatus(checked);
    const artifactCountAfter = (checked.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count;
    checked.close();
    const runData = JSON.parse(timedOutRun.data_json) as { status: string; provider: { provider_job_id: string; provider_status: string }; error: { code: string; retryable: boolean } };
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 2);
    assert.deepEqual({ status: timedOutIntent.status, provider_task_id: timedOutIntent.provider_task_id }, {
      status: "running",
      provider_task_id: "task-absolute-deadline"
    });
    assert.equal(timedOutIntent.submit_attempts, 1);
    assert.equal((JSON.parse(timedOutIntent.sanitized_error_json) as { code: string }).code, "PROVIDER_POLL_TIMEOUT");
    assert.deepEqual({ ...timedOutJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_POLL_TIMEOUT",
      lease_owner: "",
      lease_token: "",
      lease_expires_at: null
    });
    assert.equal(runData.status, "running");
    assert.equal(runData.provider.provider_job_id, "task-absolute-deadline");
    assert.equal(runData.provider.provider_status, "PROVIDER_POLL_TIMEOUT");
    assert.deepEqual(runData.error, {
      code: "PROVIDER_POLL_TIMEOUT",
      message: "Provider task requires human reconciliation.",
      retryable: false
    });
    assert.equal((JSON.parse(timedOutProject.data_json) as { status: string }).status, "storyboard_approved");
    assert.equal((JSON.parse(timedOutShot.data_json) as { status: string }).status, "storyboard_approved");
    assert.equal(timedOutSummary?.active_run_count, 0);
    assert.ok(timedOutSummary?.blocker_codes.includes("GENERATION_MANUAL_RECONCILIATION"));
    assert.notEqual(timedOutSummary?.next_action.reason_code, "generation_running");
    assert.notEqual(timedOutSummary?.next_action.reason_code, "generate_shot");
    assert.deepEqual({
      ready: timedOutWorker.ready,
      active: timedOutWorker.active,
      unowned_runnable: timedOutWorker.unowned_runnable,
      runnable: timedOutWorker.runnable
    }, { ready: true, active: 0, unowned_runnable: 0, runnable: 0 });
    assert.equal(artifactCountAfter, artifactCountBefore);

    assert.deepEqual(
      resumeWorkbenchGenerationJobs({ sqlite_path: sqlitePath, env: prepared.env }),
      { resumed: [], reconciled: [prepared.intent_id] }
    );
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 2);

    wallMs = persistedDeadline + 60_000;
    monotonicMs += 60_000;
    checked = openM0Database(sqlitePath);
    const reattached = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: "task-absolute-deadline",
      human_confirmation: true
    }, checked, { env: prepared.env, now: () => new Date(wallMs) });
    assert.equal(reattached.ok, true);
    if (!reattached.ok) throw new Error("explicit task reattachment failed");
    const reattachedIntent = checked.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const reattachedJob = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    const reattachedDeadline = Date.parse(
      (JSON.parse(reattachedIntent.data_json) as { provider_poll_deadline_at: string }).provider_poll_deadline_at
    );
    assert.equal(reattachedDeadline, wallMs + DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS);
    assert.notEqual(reattachedDeadline, persistedDeadline);
    assert.deepEqual({ ...reattachedJob }, {
      state: "polling",
      reconciliation_reason: "HUMAN_ATTACHED_EXISTING_TASK"
    });

    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });
    checked = openM0Database(sqlitePath);
    const afterReattachedPoll = checked.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const afterReattachedJob = checked.prepare("SELECT state FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string };
    checked.close();
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 3);
    assert.equal(afterReattachedJob.state, "polling");
    assert.equal(
      Date.parse((JSON.parse(afterReattachedPoll.data_json) as { provider_poll_deadline_at: string }).provider_poll_deadline_at),
      reattachedDeadline
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider polling fails closed after restart when wall time moves before the persisted start", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-poll-clock-rollback-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Clock rollback polling budget");
    persistKnownProviderTask(
      sqlitePath,
      prepared.intent_id,
      prepared.job_id,
      "task-clock-rollback",
      MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    );
    const db = openM0Database(sqlitePath);
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const persisted = JSON.parse(intentRow.data_json) as {
      provider_poll_started_at: string;
      provider_poll_timeout_ms: number;
    };
    db.close();

    let pollCalls = 0;
    let submitCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        throw new Error("known Provider task must not be resubmitted");
      },
      pollStatus: async () => {
        pollCalls += 1;
        throw new Error("clock rollback must fail closed before Provider polling");
      },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const rolledBackWallMs = Date.parse(persisted.provider_poll_started_at) - 6 * 60 * 60_000;
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: { ...prepared.env, PROVIDER_TASK_POLL_TIMEOUT_MS: String(MAX_PROVIDER_TASK_POLL_TIMEOUT_MS) },
        adapter_factory: () => adapter,
        poll_interval_ms: MIN_PROVIDER_TASK_POLL_TIMEOUT_MS,
        now: () => new Date(rolledBackWallMs),
        monotonic_now_ms: () => 50_000
      }
    });

    const checked = openM0Database(sqlitePath);
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    checked.close();
    assert.equal(persisted.provider_poll_timeout_ms, MIN_PROVIDER_TASK_POLL_TIMEOUT_MS);
    assert.equal(pollCalls, 0);
    assert.equal(submitCalls, 0);
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_POLL_TIMEOUT"
    });
    assert.deepEqual({
      status: intent.status,
      provider_task_id: intent.provider_task_id,
      error_code: (JSON.parse(intent.sanitized_error_json) as { code: string }).code
    }, {
      status: "running",
      provider_task_id: "task-clock-rollback",
      error_code: "PROVIDER_POLL_TIMEOUT"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup scheduler immediately fails closed after clock rollback despite a future inherited lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-scheduler-clock-rollback-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Schedule clock rollback reconciliation");
    const taskId = "task-scheduler-clock-rollback";
    persistKnownProviderTask(
      sqlitePath,
      prepared.intent_id,
      prepared.job_id,
      taskId,
      MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    );
    const wallMs = Date.parse("2035-01-02T03:04:05.100Z");
    const futureStartedAtMs = wallMs + 500;
    assert.equal(Math.floor(futureStartedAtMs / 1_000), Math.floor(wallMs / 1_000));
    assert.ok(futureStartedAtMs - wallMs < 1_000);
    const futureDeadlineMs = futureStartedAtMs + MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    const db = openM0Database(sqlitePath);
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.provider_poll_started_at = new Date(futureStartedAtMs).toISOString();
    intentData.provider_poll_timeout_ms = MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    intentData.provider_poll_deadline_at = new Date(futureDeadlineMs).toISOString();
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), prepared.intent_id);
    db.prepare(`UPDATE generation_jobs
      SET next_attempt_at = ?,
          lease_owner = 'crashed_worker',
          lease_token = 'inherited_clock_rollback_lease',
          lease_expires_at = ?
      WHERE job_id = ?`).run(
      new Date(futureDeadlineMs).toISOString(),
      "2099-01-01T00:00:00.000Z",
      prepared.job_id
    );
    db.close();

    let providerCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        providerCalls += 1;
        throw new Error("known Provider task must not be resubmitted");
      },
      pollStatus: async () => {
        providerCalls += 1;
        throw new Error("clock rollback must fail closed before Provider polling");
      },
      fetchOutput: async () => {
        providerCalls += 1;
        throw new Error("output must not run");
      }
    } as unknown as VideoProviderAdapter;
    const resumed = resumeWorkbenchGenerationJobs({
      sqlite_path: sqlitePath,
      env: { ...prepared.env, PROVIDER_TASK_POLL_TIMEOUT_MS: String(MIN_PROVIDER_TASK_POLL_TIMEOUT_MS) },
      adapter_factory: () => adapter,
      now: () => new Date(wallMs),
      monotonic_now_ms: () => 50_000
    });
    assert.deepEqual(resumed, { resumed: [prepared.intent_id], reconciled: [] });

    let observedJob = { state: "", reconciliation_reason: "", lease_token: "" };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const checked = openM0Database(sqlitePath);
      observedJob = checked.prepare("SELECT state, reconciliation_reason, lease_token FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as typeof observedJob;
      checked.close();
      if (observedJob.state === "manual_reconciliation" && observedJob.lease_token === "") break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    checked.close();

    assert.equal(providerCalls, 0);
    assert.deepEqual({ ...observedJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_POLL_TIMEOUT",
      lease_token: ""
    });
    assert.deepEqual({
      status: intent.status,
      provider_task_id: intent.provider_task_id,
      error_code: (JSON.parse(intent.sanitized_error_json) as { code: string }).code
    }, {
      status: "running",
      provider_task_id: taskId,
      error_code: "PROVIDER_POLL_TIMEOUT"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired polling deadline never authorizes an unattested local completion", async () => {
  const roots: string[] = [];
  try {
    for (const recoveryState of ["downloading", "finalizing"] as const) {
      const root = mkdtempSync(join(tmpdir(), `generation-${recoveryState}-recovery-`));
      roots.push(root);
      const sqlitePath = join(root, "app.sqlite");
      const prepared = await prepareConfirmedGeneration(sqlitePath, `Resume ${recoveryState}`);
      const taskId = `task-${recoveryState}-recovery`;
      const wallMs = Date.now();
      persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId, MIN_PROVIDER_TASK_POLL_TIMEOUT_MS);

      let db = openM0Database(sqlitePath);
      const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
        .get(prepared.intent_id) as { data_json: string };
      const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
      intentData.provider_poll_started_at = new Date(wallMs - MIN_PROVIDER_TASK_POLL_TIMEOUT_MS - 1_000).toISOString();
      intentData.provider_poll_timeout_ms = MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
      intentData.provider_poll_deadline_at = new Date(wallMs - 1_000).toISOString();
      db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
        .run(JSON.stringify(intentData), prepared.intent_id);
      db.prepare("UPDATE generation_jobs SET state = ? WHERE job_id = ?")
        .run(recoveryState, prepared.job_id);
      const existingOutput = registerMediaArtifact({
        artifact_type: "video",
        role: "generated_clip",
        source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
        linked_objects: { project_id: prepared.project_id, shot_id: prepared.shot_id },
        provenance: { provider: "runninghub", provider_job_id: taskId }
      }, db);
      assert.equal(existingOutput.ok, true, recoveryState);
      db.close();

      let pollCalls = 0;
      const adapter = {
        provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
        submitGeneration: async () => { throw new Error("submit must not run"); },
        pollStatus: async () => {
          pollCalls += 1;
          throw new Error("poll must not run after Provider success was persisted locally");
        },
        fetchOutput: async () => { throw new Error("output fetch must not run for an existing Artifact"); }
      } as unknown as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(prepared.intent_id, {
        allow_submit: false,
        dependencies: {
          sqlite_path: sqlitePath,
          env: prepared.env,
          adapter_factory: () => adapter,
          now: () => new Date(wallMs),
          monotonic_now_ms: () => 10_000
        }
      });

      db = openM0Database(sqlitePath);
      const completedIntent = db.prepare(`SELECT status, output_artifact_id, sanitized_error_json
        FROM generation_intents WHERE intent_id = ?`)
        .get(prepared.intent_id) as { status: string; output_artifact_id: string; sanitized_error_json: string };
      const completedJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as { state: string; reconciliation_reason: string };
      const completedReceipt = getGenerationExecutionReceipt(db, prepared.intent_id);
      const existingArtifact = db.prepare("SELECT status FROM media_artifacts WHERE artifact_id = ?")
        .get(existingOutput.ok ? existingOutput.artifact.artifact_id : "") as { status: string };
      db.close();
      assert.equal(pollCalls, 0, recoveryState);
      assert.equal(completedIntent.status, "running", recoveryState);
      assert.equal(completedIntent.output_artifact_id, "", recoveryState);
      assert.equal((JSON.parse(completedIntent.sanitized_error_json) as { code: string }).code,
        "PROVIDER_OUTPUT_ACTIVATION_UNATTESTED", recoveryState);
      assert.deepEqual({ ...completedJob }, {
        state: "manual_reconciliation",
        reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
      }, recoveryState);
      assert.equal(completedReceipt?.state, "reconciling", recoveryState);
      assert.equal(existingArtifact.status, "active", recoveryState);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("human reattachment redownloads, repairs verified Blob bytes, and rebinds without another Provider submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-invalid-output-recovery-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const videoFixture = join(mediaRoot, "provider-source.mp4");
  try {
    writeProviderOutputFixture(videoFixture);
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Reject invalid local output");
    const taskId = "task-invalid-output-recovery";
    const wallMs = Date.now();
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId, MIN_PROVIDER_TASK_POLL_TIMEOUT_MS);

    let db = openM0Database(sqlitePath);
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.provider_poll_started_at = new Date(wallMs - MIN_PROVIDER_TASK_POLL_TIMEOUT_MS - 1_000).toISOString();
    intentData.provider_poll_timeout_ms = MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    intentData.provider_poll_deadline_at = new Date(wallMs - 1_000).toISOString();
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), prepared.intent_id);
    db.prepare("UPDATE generation_jobs SET state = 'finalizing' WHERE job_id = ?")
      .run(prepared.job_id);
    const existingPrepared: MediaArtifact = {
      artifact_id: "artifact_invalid_output_recovery",
      blob_id: "",
      artifact_type: "video",
      role: "generated_clip",
      status: "active",
      storage: {
        uri: join(mediaRoot, "artifacts", "videos", "existing-output.mp4"),
        mime_type: "video/mp4",
        filename: "existing-output.mp4"
      },
      metadata: {
        width: 1080,
        height: 1920,
        duration_seconds: 6,
        aspect_ratio: "9:16",
        sha256: ""
      },
      linked_objects: { project_id: prepared.project_id, shot_id: prepared.shot_id },
      source: {
        kind: "provider_output_file",
        provider: "runninghub",
        provider_job_id: taskId,
        sha256: "",
        external_url_host: "fixture.invalid"
      }
    };
    const existingOutput = activateLocalMediaArtifact({
      artifact: existingPrepared,
      source_path: videoFixture,
      media_root: mediaRoot
    }, db);
    assert.equal(existingOutput.ok, true);
    if (!existingOutput.ok) throw new Error("output fixture registration failed");
    writeFileSync(existingOutput.artifact.storage.uri, "corrupt-paid-provider-output", "utf8");
    db.close();

    let pollCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run"); },
      pollStatus: async () => {
        pollCalls += 1;
        throw new Error("poll must not run for a persisted local output");
      },
      fetchOutput: async () => { throw new Error("output fetch must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        now: () => new Date(wallMs),
        monotonic_now_ms: () => 10_000
      }
    });

    db = openM0Database(sqlitePath);
    const reconciledIntent = db.prepare("SELECT status, output_artifact_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; output_artifact_id: string; sanitized_error_json: string };
    const reconciledJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    db.close();
    assert.equal(pollCalls, 0);
    assert.equal(reconciledIntent.status, "running");
    assert.equal(reconciledIntent.output_artifact_id, "");
    assert.equal((JSON.parse(reconciledIntent.sanitized_error_json) as { code: string }).code, "VIDEO_FILE_INVALID");
    assert.deepEqual({ ...reconciledJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
    });

    db = openM0Database(sqlitePath);
    const attached = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: taskId,
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs) });
    assert.equal(attached.ok, true);
    if (!attached.ok) throw new Error("output recovery attachment failed");
    const recoveryIntentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const recoveryIntentData = JSON.parse(recoveryIntentRow.data_json) as {
      provider_output_recovery: {
        provider_task_id: string;
        invalid_artifact_id: string;
        local_identity: string;
      };
    };
    assert.equal(recoveryIntentData.provider_output_recovery.provider_task_id, taskId);
    assert.equal(recoveryIntentData.provider_output_recovery.invalid_artifact_id, existingOutput.artifact.artifact_id);
    assert.match(recoveryIntentData.provider_output_recovery.local_identity, /^local_recovery_[0-9a-f-]{36}$/i);
    db.close();

    let downloadCalls = 0;
    const recoveryAdapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run during output recovery"); },
      pollStatus: async () => {
        pollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/recovered.mp4"
        };
      },
      fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => recoveryAdapter,
        now: () => new Date(wallMs),
        monotonic_now_ms: () => 10_000,
        provider_output_storage_directory: mediaRoot,
        download_provider_output: (async (input, targetDb, runtime = {}) => {
          downloadCalls += 1;
          assert.equal(input.provider_name, "runninghub");
          assert.equal(input.provider_job_id, recoveryIntentData.provider_output_recovery.local_identity);
          assert.deepEqual(input.verified_blob_recovery, {
            invalid_artifact_id: recoveryIntentData.provider_output_recovery.invalid_artifact_id
          });
          return downloadProviderOutputToArtifact({
            ...input,
            storage_directory: mediaRoot
          }, targetDb, {
            ...runtime,
            storage_root: mediaRoot,
            resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
            fetch_pinned_address: async () => new Response(readFileSync(videoFixture), {
              status: 200,
              headers: { "content-type": "video/mp4" }
            })
          });
        }) as typeof downloadProviderOutputToArtifact
      }
    });

    db = openM0Database(sqlitePath);
    const completedIntentRow = db.prepare("SELECT status, output_artifact_id, data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; output_artifact_id: string; data_json: string };
    const completedJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const archivedArtifactRow = db.prepare("SELECT status, data_json FROM media_artifacts WHERE artifact_id = ?")
      .get(existingOutput.artifact.artifact_id) as { status: string; data_json: string };
    const replacementArtifactRow = db.prepare("SELECT status, data_json FROM media_artifacts WHERE artifact_id = ?")
      .get(completedIntentRow.output_artifact_id) as { status: string; data_json: string };
    const originalBlob = db.prepare("SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?")
      .get(existingOutput.artifact.artifact_id) as { blob_id: string };
    const replacementBlob = db.prepare("SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?")
      .get(completedIntentRow.output_artifact_id) as { blob_id: string };
    const canonicalBindingCount = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE json_valid(data_json) = 1
        AND json_extract(data_json, '$.source.provider') = 'runninghub'
        AND json_extract(data_json, '$.source.provider_job_id') = ?`).get(taskId) as { count: number };
    const localRecoveryBindingCount = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE json_valid(data_json) = 1
        AND json_extract(data_json, '$.source.provider_job_id') = ?`)
      .get(recoveryIntentData.provider_output_recovery.local_identity) as { count: number };
    db.close();
    const archivedArtifactData = JSON.parse(archivedArtifactRow.data_json) as {
      source: { provider_job_id: string; original_provider_job_id: string; replaced_by_artifact_id: string };
    };
    const replacementArtifactData = JSON.parse(replacementArtifactRow.data_json) as {
      source: { provider_job_id: string; local_recovery_identity: string };
    };
    assert.equal(pollCalls, 1);
    assert.equal(downloadCalls, 1);
    assert.equal(completedIntentRow.status, "succeeded");
    assert.notEqual(completedIntentRow.output_artifact_id, existingOutput.artifact.artifact_id);
    assert.equal("provider_output_recovery" in JSON.parse(completedIntentRow.data_json), false);
    assert.deepEqual({ ...completedJob }, { state: "succeeded", reconciliation_reason: "" });
    assert.equal(archivedArtifactRow.status, "archived");
    assert.equal((JSON.parse(archivedArtifactRow.data_json) as { status: string }).status, "archived");
    assert.equal(archivedArtifactData.source.provider_job_id, "");
    assert.equal(archivedArtifactData.source.original_provider_job_id, taskId);
    assert.equal(archivedArtifactData.source.replaced_by_artifact_id, completedIntentRow.output_artifact_id);
    assert.equal(replacementArtifactRow.status, "active");
    assert.equal(replacementBlob.blob_id, originalBlob.blob_id);
    assert.equal(replacementArtifactData.source.provider_job_id, taskId);
    assert.equal(replacementArtifactData.source.local_recovery_identity, recoveryIntentData.provider_output_recovery.local_identity);
    assert.equal(canonicalBindingCount.count, 1);
    assert.equal(localRecoveryBindingCount.count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated attachment never adopts an unattested committed recovery replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-recovery-rebind-restart-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const videoFixture = resolve("fixtures/video/mock_clip.mp4");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Resume committed recovery replacement");
    const taskId = "task-recovery-rebind-restart";
    const wallMs = Date.now();
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId, MIN_PROVIDER_TASK_POLL_TIMEOUT_MS);

    let db = openM0Database(sqlitePath);
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.provider_poll_started_at = new Date(wallMs - MIN_PROVIDER_TASK_POLL_TIMEOUT_MS - 1_000).toISOString();
    intentData.provider_poll_timeout_ms = MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    intentData.provider_poll_deadline_at = new Date(wallMs - 1_000).toISOString();
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), prepared.intent_id);
    db.prepare("UPDATE generation_jobs SET state = 'finalizing' WHERE job_id = ?")
      .run(prepared.job_id);
    const existingOutput = activateLocalMediaArtifact({
      artifact: {
        artifact_id: "artifact_recovery_rebind_restart",
        blob_id: "",
        artifact_type: "video",
        role: "generated_clip",
        status: "active",
        storage: {
          uri: join(mediaRoot, "artifacts", "videos", "existing-output.mp4"),
          mime_type: "video/mp4",
          filename: "existing-output.mp4"
        },
        metadata: {
          width: 1080,
          height: 1920,
          duration_seconds: 6,
          aspect_ratio: "9:16",
          sha256: ""
        },
        linked_objects: { project_id: prepared.project_id, shot_id: prepared.shot_id },
        source: {
          kind: "provider_output_file",
          provider: "runninghub",
          provider_job_id: taskId,
          sha256: "",
          external_url_host: "fixture.invalid"
        }
      },
      source_path: videoFixture,
      media_root: mediaRoot
    }, db);
    assert.equal(existingOutput.ok, true);
    if (!existingOutput.ok) throw new Error("output fixture registration failed");
    writeFileSync(existingOutput.artifact.storage.uri, "corrupt-paid-provider-output", "utf8");
    db.close();

    let submitCalls = 0;
    let pollCalls = 0;
    let downloadCalls = 0;
    const noProviderAdapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        throw new Error("submit must not run");
      },
      pollStatus: async () => {
        pollCalls += 1;
        throw new Error("poll must not run");
      },
      fetchOutput: async () => { throw new Error("output fetch must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => noProviderAdapter,
        now: () => new Date(wallMs),
        monotonic_now_ms: () => 10_000
      }
    });

    db = openM0Database(sqlitePath);
    const attached = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: taskId,
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs) });
    assert.equal(attached.ok, true);
    if (!attached.ok) throw new Error("output recovery attachment failed");
    const recoveryIntentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const recovery = (JSON.parse(recoveryIntentRow.data_json) as {
      provider_output_recovery: {
        provider_task_id: string;
        invalid_artifact_id: string;
        local_identity: string;
        requested_at: string;
      };
    }).provider_output_recovery;
    db.prepare("UPDATE generation_jobs SET state = 'downloading' WHERE job_id = ?")
      .run(prepared.job_id);

    // Simulate an out-of-capability downloader commit. PR 6 deliberately does
    // not treat these bytes as a resumable worker activation: only the outer
    // Workbench transaction may attest and adopt a replacement Artifact.
    const downloaded = await downloadProviderOutputToArtifact({
      url: "https://example.invalid/recovered.mp4",
      provider_name: "runninghub",
      provider_job_id: recovery.local_identity,
      project_id: prepared.project_id,
      shot_id: prepared.shot_id,
      duration_seconds: 6,
      aspect_ratio: "9:16",
      storage_directory: mediaRoot,
      verified_blob_recovery: {
        invalid_artifact_id: recovery.invalid_artifact_id
      }
    }, db, {
      storage_root: mediaRoot,
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch_pinned_address: async () => new Response(readFileSync(videoFixture), {
        status: 200,
        headers: { "content-type": "video/mp4" }
      })
    });
    if (!downloaded.ok) {
      const errorCode = downloaded.error.code;
      db.close();
      assert.fail(`recovery download fixture failed: ${errorCode}`);
    }
    const replacementArtifactId = downloaded.artifact.artifact_id;
    const activeBeforeRestart = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE status = 'active' AND role = 'generated_clip' AND artifact_type = 'video'
        AND project_id = ? AND shot_id = ?`)
      .get(prepared.project_id, prepared.shot_id) as { count: number };
    db.prepare(`UPDATE generation_jobs
      SET state = 'manual_reconciliation',
          reconciliation_reason = 'PROVIDER_OUTPUT_REQUIRES_RECONCILIATION',
          lease_owner = '',
          lease_token = '',
          lease_expires_at = NULL
      WHERE job_id = ?`).run(prepared.job_id);
    restoreGenerationReconciliationContext(db, prepared.intent_id);
    const repeatedAttachment = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: taskId,
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs + 1_000) });
    assert.equal(repeatedAttachment.ok, true);
    if (!repeatedAttachment.ok) throw new Error("repeated output recovery attachment failed");
    const repeatedRecoveryRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const repeatedRecovery = (JSON.parse(repeatedRecoveryRow.data_json) as {
      provider_output_recovery: typeof recovery;
    }).provider_output_recovery;
    const reattachedJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    db.close();
    assert.equal(activeBeforeRestart.count, 2);
    assert.deepEqual(repeatedRecovery, recovery);
    assert.deepEqual({ ...reattachedJob }, {
      state: "polling",
      reconciliation_reason: "HUMAN_ATTACHED_EXISTING_TASK"
    });

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => noProviderAdapter,
        now: () => new Date(wallMs + 1_000),
        monotonic_now_ms: () => 11_000,
        download_provider_output: (async () => {
          downloadCalls += 1;
          throw new Error("unattested replacement must not reach another download automatically");
        }) as typeof downloadProviderOutputToArtifact
      }
    });

    db = openM0Database(sqlitePath);
    const completedIntent = db.prepare("SELECT status, output_artifact_id, data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; output_artifact_id: string; data_json: string };
    const completedJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const oldArtifact = db.prepare("SELECT status, data_json FROM media_artifacts WHERE artifact_id = ?")
      .get(existingOutput.artifact.artifact_id) as { status: string; data_json: string };
    const replacementArtifact = db.prepare("SELECT status, data_json FROM media_artifacts WHERE artifact_id = ?")
      .get(replacementArtifactId) as { status: string; data_json: string };
    const activeAfterRestart = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE status = 'active' AND role = 'generated_clip' AND artifact_type = 'video'
        AND project_id = ? AND shot_id = ?`)
      .get(prepared.project_id, prepared.shot_id) as { count: number };
    db.close();

    assert.equal(submitCalls, 0);
    assert.equal(pollCalls, 0);
    assert.equal(downloadCalls, 0);
    assert.equal(completedIntent.status, "running");
    assert.equal(completedIntent.output_artifact_id, "");
    assert.deepEqual((JSON.parse(completedIntent.data_json) as { provider_output_recovery: typeof recovery })
      .provider_output_recovery, recovery);
    assert.deepEqual({ ...completedJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
    });
    assert.equal(oldArtifact.status, "active");
    assert.equal((JSON.parse(oldArtifact.data_json) as { status: string }).status, "active");
    assert.equal(replacementArtifact.status, "active");
    assert.equal((JSON.parse(replacementArtifact.data_json) as { source: { provider_job_id: string } }).source.provider_job_id,
      recovery.local_identity);
    assert.equal(activeAfterRestart.count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-TASK-03] switching a persisted Provider task is rejected without changing recovery Artifact bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-recovery-task-switch-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const videoFixture = resolve("fixtures/video/mock_clip.mp4");
  let dbForCleanup: ReturnType<typeof openM0Database> | null = null;
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Retire recovery before Provider task switch");
    const previousTaskId = "task-recovery-switch-previous";
    const nextTaskId = "task-recovery-switch-next";
    const localIdentity = "local_recovery_11111111-1111-4111-8111-111111111111";
    const wallMs = Date.now();
    persistKnownProviderTask(
      sqlitePath,
      prepared.intent_id,
      prepared.job_id,
      previousTaskId,
      MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    );

    const db = openM0Database(sqlitePath);
    dbForCleanup = db;
    const activateRecoveryArtifact = (artifactId: string, providerJobId: string) => activateLocalMediaArtifact({
      artifact: {
        artifact_id: artifactId,
        blob_id: "",
        artifact_type: "video",
        role: "generated_clip",
        status: "active",
        storage: {
          uri: join(mediaRoot, "artifacts", "videos", `${artifactId}.mp4`),
          mime_type: "video/mp4",
          filename: `${artifactId}.mp4`
        },
        metadata: {
          width: 1080,
          height: 1920,
          duration_seconds: 6,
          aspect_ratio: "9:16",
          sha256: ""
        },
        linked_objects: { project_id: prepared.project_id, shot_id: prepared.shot_id },
        source: {
          kind: "provider_output_file",
          provider: "runninghub",
          provider_job_id: providerJobId,
          sha256: "",
          external_url_host: "fixture.invalid"
        }
      },
      source_path: videoFixture,
      media_root: mediaRoot
    }, db);
    const invalidArtifact = activateRecoveryArtifact("artifact_recovery_switch_invalid", previousTaskId);
    const replacementArtifact = activateRecoveryArtifact("artifact_recovery_switch_replacement", localIdentity);
    assert.equal(invalidArtifact.ok, true);
    assert.equal(replacementArtifact.ok, true);
    if (!invalidArtifact.ok || !replacementArtifact.ok) throw new Error("recovery task-switch fixture activation failed");

    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.provider_output_recovery = {
      version: 1,
      provider_task_id: previousTaskId,
      invalid_artifact_id: invalidArtifact.artifact.artifact_id,
      local_identity: localIdentity,
      requested_at: new Date(wallMs).toISOString()
    };
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), prepared.intent_id);
    db.prepare(`UPDATE generation_jobs
      SET state = 'manual_reconciliation',
          reconciliation_reason = 'PROVIDER_OUTPUT_REQUIRES_RECONCILIATION',
          lease_owner = '',
          lease_token = '',
          lease_expires_at = NULL
      WHERE job_id = ?`).run(prepared.job_id);
    restoreGenerationReconciliationContext(db, prepared.intent_id);

    const blobBindingsBefore = db.prepare(`SELECT artifact_id, blob_id FROM media_artifact_blobs
      WHERE artifact_id IN (?, ?) ORDER BY artifact_id`).all(
      invalidArtifact.artifact.artifact_id,
      replacementArtifact.artifact.artifact_id
    ) as Array<{ artifact_id: string; blob_id: string }>;
    const localIdentityAttachment = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: localIdentity,
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs + 500) });
    assert.equal(localIdentityAttachment.ok, false);
    if (!localIdentityAttachment.ok) {
      assert.equal(localIdentityAttachment.error.code, "INVALID_PROVIDER_TASK_ID");
    }
    const recoveryAfterRejectedIdentity = JSON.parse((db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string }).data_json) as {
      provider_output_recovery: { provider_task_id: string; local_identity: string };
    };
    assert.equal(recoveryAfterRejectedIdentity.provider_output_recovery.provider_task_id, previousTaskId);
    assert.equal(recoveryAfterRejectedIdentity.provider_output_recovery.local_identity, localIdentity);

    const rejectedTaskSwitch = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: nextTaskId,
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs + 750) });
    assert.equal(rejectedTaskSwitch.ok, false);
    if (!rejectedTaskSwitch.ok) assert.equal(rejectedTaskSwitch.error.code, "GENERATION_EXECUTION_TASK_IMMUTABLE");
    const stateAfterRejectedSwitch = db.prepare(`SELECT
        (SELECT provider_task_id FROM generation_intents WHERE intent_id = ?) AS provider_task_id,
        (SELECT data_json FROM generation_intents WHERE intent_id = ?) AS intent_data_json,
        (SELECT status FROM media_artifacts WHERE artifact_id = ?) AS invalid_status,
        (SELECT status FROM media_artifacts WHERE artifact_id = ?) AS replacement_status`)
      .get(prepared.intent_id, prepared.intent_id, invalidArtifact.artifact.artifact_id, replacementArtifact.artifact.artifact_id) as {
        provider_task_id: string; intent_data_json: string; invalid_status: string; replacement_status: string;
      };
    assert.equal(stateAfterRejectedSwitch.provider_task_id, previousTaskId);
    assert.equal("provider_output_recovery" in JSON.parse(stateAfterRejectedSwitch.intent_data_json), true);
    assert.equal(stateAfterRejectedSwitch.invalid_status, "active");
    assert.equal(stateAfterRejectedSwitch.replacement_status, "active");

    const reconciledIntent = db.prepare("SELECT provider_task_id, status, data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { provider_task_id: string; status: string; data_json: string };
    const reconciledJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const retiredArtifacts = db.prepare(`SELECT artifact_id, status, data_json FROM media_artifacts
      WHERE artifact_id IN (?, ?) ORDER BY artifact_id`).all(
      invalidArtifact.artifact.artifact_id,
      replacementArtifact.artifact.artifact_id
    ) as Array<{ artifact_id: string; status: string; data_json: string }>;
    const blobBindingsAfter = db.prepare(`SELECT artifact_id, blob_id FROM media_artifact_blobs
      WHERE artifact_id IN (?, ?) ORDER BY artifact_id`).all(
      invalidArtifact.artifact.artifact_id,
      replacementArtifact.artifact.artifact_id
    ) as Array<{ artifact_id: string; blob_id: string }>;
    const activeGeneratedClips = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE project_id = ? AND shot_id = ? AND role = 'generated_clip'
        AND artifact_type = 'video' AND status = 'active'`)
      .get(prepared.project_id, prepared.shot_id) as { count: number };
    db.close();

    assert.equal(reconciledIntent.provider_task_id, previousTaskId);
    assert.equal(reconciledIntent.status, "running");
    assert.equal("provider_output_recovery" in JSON.parse(reconciledIntent.data_json), true);
    assert.deepEqual({ ...reconciledJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
    });
    assert.equal(retiredArtifacts.length, 2);
    for (const artifact of retiredArtifacts) {
      assert.equal(artifact.status, "active");
      assert.equal((JSON.parse(artifact.data_json) as { status: string }).status, "active");
    }
    assert.deepEqual(blobBindingsAfter, blobBindingsBefore);
    assert.equal(activeGeneratedClips.count, 2);
  } finally {
    try { dbForCleanup?.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("abandoning Provider recovery retires its artifacts atomically without changing Blob bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-recovery-abandon-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const videoFixture = resolve("fixtures/video/mock_clip.mp4");
  let dbForCleanup: ReturnType<typeof openM0Database> | null = null;
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Retire recovery before human abandon");
    const taskId = "task-recovery-abandon";
    const localIdentity = "local_recovery_33333333-3333-4333-8333-333333333333";
    const wallMs = Date.now();
    persistKnownProviderTask(
      sqlitePath,
      prepared.intent_id,
      prepared.job_id,
      taskId,
      MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    );

    const db = openM0Database(sqlitePath);
    dbForCleanup = db;
    const activateRecoveryArtifact = (artifactId: string, providerJobId: string) => activateLocalMediaArtifact({
      artifact: {
        artifact_id: artifactId,
        blob_id: "",
        artifact_type: "video",
        role: "generated_clip",
        status: "active",
        storage: {
          uri: join(mediaRoot, "artifacts", "videos", `${artifactId}.mp4`),
          mime_type: "video/mp4",
          filename: `${artifactId}.mp4`
        },
        metadata: {
          width: 1080,
          height: 1920,
          duration_seconds: 6,
          aspect_ratio: "9:16",
          sha256: ""
        },
        linked_objects: { project_id: prepared.project_id, shot_id: prepared.shot_id },
        source: {
          kind: "provider_output_file",
          provider: "runninghub",
          provider_job_id: providerJobId,
          sha256: "",
          external_url_host: "fixture.invalid"
        }
      },
      source_path: videoFixture,
      media_root: mediaRoot
    }, db);
    const invalidArtifact = activateRecoveryArtifact("artifact_recovery_abandon_invalid", taskId);
    const replacementArtifact = activateRecoveryArtifact("artifact_recovery_abandon_replacement", localIdentity);
    assert.equal(invalidArtifact.ok, true);
    assert.equal(replacementArtifact.ok, true);
    if (!invalidArtifact.ok || !replacementArtifact.ok) throw new Error("recovery abandon fixture activation failed");

    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.provider_output_recovery = {
      version: 1,
      provider_task_id: taskId,
      invalid_artifact_id: invalidArtifact.artifact.artifact_id,
      local_identity: localIdentity,
      requested_at: new Date(wallMs).toISOString()
    };
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), prepared.intent_id);
    db.prepare(`UPDATE generation_jobs
      SET state = 'manual_reconciliation',
          reconciliation_reason = 'PROVIDER_OUTPUT_REQUIRES_RECONCILIATION',
          lease_owner = '',
          lease_token = '',
          lease_expires_at = NULL
      WHERE job_id = ?`).run(prepared.job_id);
    restoreGenerationReconciliationContext(db, prepared.intent_id);

    const blobBindingsBefore = db.prepare(`SELECT artifact_id, blob_id FROM media_artifact_blobs
      WHERE artifact_id IN (?, ?) ORDER BY artifact_id`).all(
      invalidArtifact.artifact.artifact_id,
      replacementArtifact.artifact.artifact_id
    ) as Array<{ artifact_id: string; blob_id: string }>;
    withWorkbenchProductionMutationAuthority(db, {
      kind: "artifact", project_id: prepared.project_id, object_id: replacementArtifact.artifact.artifact_id
    }, () => db.prepare("UPDATE media_artifacts SET status = 'inaccessible' WHERE artifact_id = ?")
      .run(replacementArtifact.artifact.artifact_id));
    const rejectedUnsafeAbandon = reconcileGenerationJob(prepared.job_id, {
      decision: "abandon",
      reason: "Reject unsafe recovery retirement.",
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs + 500) });
    assert.equal(rejectedUnsafeAbandon.ok, false);
    if (!rejectedUnsafeAbandon.ok) assert.equal(rejectedUnsafeAbandon.error.code, "ARTIFACT_RECOVERY_RETIRE_FAILED");
    const stateAfterRejectedAbandon = db.prepare(`SELECT
        (SELECT status FROM generation_intents WHERE intent_id = ?) AS intent_status,
        (SELECT data_json FROM generation_intents WHERE intent_id = ?) AS intent_data_json,
        (SELECT state FROM generation_jobs WHERE job_id = ?) AS job_state,
        (SELECT status FROM media_artifacts WHERE artifact_id = ?) AS invalid_status,
        (SELECT status FROM media_artifacts WHERE artifact_id = ?) AS replacement_status`)
      .get(prepared.intent_id, prepared.intent_id, prepared.job_id, invalidArtifact.artifact.artifact_id,
        replacementArtifact.artifact.artifact_id) as {
        intent_status: string; intent_data_json: string; job_state: string; invalid_status: string; replacement_status: string;
      };
    assert.equal(stateAfterRejectedAbandon.intent_status, "running");
    assert.equal("provider_output_recovery" in JSON.parse(stateAfterRejectedAbandon.intent_data_json), true);
    assert.equal(stateAfterRejectedAbandon.job_state, "manual_reconciliation");
    assert.equal(stateAfterRejectedAbandon.invalid_status, "active");
    assert.equal(stateAfterRejectedAbandon.replacement_status, "inaccessible");
    withWorkbenchProductionMutationAuthority(db, {
      kind: "artifact", project_id: prepared.project_id, object_id: replacementArtifact.artifact.artifact_id
    }, () => db.prepare("UPDATE media_artifacts SET status = 'active' WHERE artifact_id = ?")
      .run(replacementArtifact.artifact.artifact_id));
    const abandoned = reconcileGenerationJob(prepared.job_id, {
      decision: "abandon",
      reason: "Human abandoned the recovered Provider output.",
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs + 1_000) });
    assert.equal(abandoned.ok, true);
    if (!abandoned.ok) throw new Error("Provider recovery abandon failed");

    const abandonedIntent = db.prepare("SELECT provider_task_id, status, data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { provider_task_id: string; status: string; data_json: string };
    const abandonedJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const abandonedRun = db.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?")
      .get(prepared.run_id) as { data_json: string };
    const retiredArtifacts = db.prepare(`SELECT artifact_id, status, data_json FROM media_artifacts
      WHERE artifact_id IN (?, ?) ORDER BY artifact_id`).all(
      invalidArtifact.artifact.artifact_id,
      replacementArtifact.artifact.artifact_id
    ) as Array<{ artifact_id: string; status: string; data_json: string }>;
    const blobBindingsAfter = db.prepare(`SELECT artifact_id, blob_id FROM media_artifact_blobs
      WHERE artifact_id IN (?, ?) ORDER BY artifact_id`).all(
      invalidArtifact.artifact.artifact_id,
      replacementArtifact.artifact.artifact_id
    ) as Array<{ artifact_id: string; blob_id: string }>;
    const activeGeneratedClips = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE project_id = ? AND shot_id = ? AND role = 'generated_clip'
        AND artifact_type = 'video' AND status = 'active'`)
      .get(prepared.project_id, prepared.shot_id) as { count: number };
    db.close();

    assert.equal(abandonedIntent.provider_task_id, taskId);
    assert.equal(abandonedIntent.status, "cancelled");
    assert.equal("provider_output_recovery" in JSON.parse(abandonedIntent.data_json), false);
    assert.deepEqual({ ...abandonedJob }, {
      state: "cancelled",
      reconciliation_reason: "Human abandoned the recovered Provider output."
    });
    assert.equal((JSON.parse(abandonedRun.data_json) as { status: string }).status, "cancelled");
    assert.equal(retiredArtifacts.length, 2);
    for (const artifact of retiredArtifacts) {
      assert.equal(artifact.status, "archived");
      assert.equal((JSON.parse(artifact.data_json) as { status: string }).status, "archived");
    }
    assert.deepEqual(blobBindingsAfter, blobBindingsBefore);
    assert.equal(activeGeneratedClips.count, 0);
  } finally {
    try { dbForCleanup?.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a local recovery identity is reserved across intents before any replacement Artifact exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-recovery-identity-reserved-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const recoveryOwner = await prepareConfirmedGeneration(sqlitePath, "Reserve local recovery identity");
    const previousTaskId = "task-reserved-identity-owner";
    const localIdentity = "local_recovery_22222222-2222-4222-8222-222222222222";
    const setupDb = openM0Database(sqlitePath);
    setupDb.prepare("UPDATE generation_intents SET status = 'cancelled' WHERE intent_id = ?")
      .run(recoveryOwner.intent_id);
    setupDb.prepare("UPDATE generation_jobs SET state = 'cancelled' WHERE job_id = ?")
      .run(recoveryOwner.job_id);
    setupDb.close();
    const otherGeneration = await prepareConfirmedGeneration(sqlitePath, "Reject another Intent using recovery identity");
    persistKnownProviderTask(
      sqlitePath,
      recoveryOwner.intent_id,
      recoveryOwner.job_id,
      previousTaskId,
      MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    );

    const db = openM0Database(sqlitePath);
    const ownerRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(recoveryOwner.intent_id) as { data_json: string };
    const ownerData = JSON.parse(ownerRow.data_json) as Record<string, unknown>;
    ownerData.provider_output_recovery = {
      version: 1,
      provider_task_id: previousTaskId,
      invalid_artifact_id: "artifact_reserved_identity_fixture",
      local_identity: localIdentity,
      requested_at: new Date().toISOString()
    };
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(ownerData), recoveryOwner.intent_id);
    db.prepare("UPDATE generation_intents SET status = 'running' WHERE intent_id = ?")
      .run(otherGeneration.intent_id);
    db.prepare(`UPDATE generation_jobs
      SET state = 'manual_reconciliation',
          reconciliation_reason = 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN',
          lease_owner = '',
          lease_token = '',
          lease_expires_at = NULL
      WHERE job_id = ?`).run(otherGeneration.job_id);
    restoreGenerationReconciliationContext(db, otherGeneration.intent_id);

    const attemptedAttachment = reconcileGenerationJob(otherGeneration.job_id, {
      decision: "attach_existing_task",
      provider_task_id: localIdentity,
      human_confirmation: true
    }, db, { env: otherGeneration.env });
    assert.equal(attemptedAttachment.ok, false);
    if (!attemptedAttachment.ok) {
      assert.equal(attemptedAttachment.error.code, "INVALID_PROVIDER_TASK_ID");
    }

    const ownerAfter = JSON.parse((db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(recoveryOwner.intent_id) as { data_json: string }).data_json) as {
      provider_output_recovery: { provider_task_id: string; local_identity: string };
    };
    const otherIntentAfter = db.prepare("SELECT provider_task_id, status FROM generation_intents WHERE intent_id = ?")
      .get(otherGeneration.intent_id) as { provider_task_id: string; status: string };
    const otherJobAfter = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(otherGeneration.job_id) as { state: string; reconciliation_reason: string };
    const replacementCount = db.prepare(`SELECT COUNT(*) AS count FROM media_artifacts
      WHERE json_valid(data_json) = 1
        AND json_extract(data_json, '$.source.provider_job_id') = ?`)
      .get(localIdentity) as { count: number };
    db.close();

    assert.equal(ownerAfter.provider_output_recovery.provider_task_id, previousTaskId);
    assert.equal(ownerAfter.provider_output_recovery.local_identity, localIdentity);
    assert.deepEqual({ ...otherIntentAfter }, { provider_task_id: "", status: "running" });
    assert.deepEqual({ ...otherJobAfter }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_SUBMIT_OUTCOME_UNKNOWN"
    });
    assert.equal(replacementCount.count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[EEI-RECOVERY-01] failed verified Blob recovery stays in manual reconciliation without polling or resubmitting", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-blob-recovery-failure-"));
  const sqlitePath = join(root, "app.sqlite");
  const mediaRoot = join(root, "media");
  const videoFixture = resolve("fixtures/video/mock_clip.mp4");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Keep failed Blob recovery manual");
    const taskId = "task-blob-recovery-failure";
    const wallMs = Date.now();
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId, MIN_PROVIDER_TASK_POLL_TIMEOUT_MS);

    let db = openM0Database(sqlitePath);
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.provider_poll_started_at = new Date(wallMs - MIN_PROVIDER_TASK_POLL_TIMEOUT_MS - 1_000).toISOString();
    intentData.provider_poll_timeout_ms = MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    intentData.provider_poll_deadline_at = new Date(wallMs - 1_000).toISOString();
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), prepared.intent_id);
    db.prepare("UPDATE generation_jobs SET state = 'finalizing' WHERE job_id = ?")
      .run(prepared.job_id);

    const invalidPrepared: MediaArtifact = {
      artifact_id: "artifact_blob_recovery_failure",
      blob_id: "",
      artifact_type: "video",
      role: "generated_clip",
      status: "active",
      storage: {
        uri: join(mediaRoot, "artifacts", "videos", "invalid-output.mp4"),
        mime_type: "video/mp4",
        filename: "invalid-output.mp4"
      },
      metadata: {
        width: 1080,
        height: 1920,
        duration_seconds: 6,
        aspect_ratio: "9:16",
        sha256: ""
      },
      linked_objects: { project_id: prepared.project_id, shot_id: prepared.shot_id },
      source: {
        kind: "provider_output_file",
        provider: "runninghub",
        provider_job_id: taskId,
        sha256: "",
        external_url_host: "fixture.invalid"
      }
    };
    const invalidOutput = activateLocalMediaArtifact({
      artifact: invalidPrepared,
      source_path: videoFixture,
      media_root: mediaRoot
    }, db);
    assert.equal(invalidOutput.ok, true, invalidOutput.ok ? undefined : invalidOutput.error.code);
    if (!invalidOutput.ok) throw new Error("invalid output fixture registration failed");
    writeFileSync(invalidOutput.artifact.storage.uri, "corrupt-paid-provider-output", "utf8");
    db.close();

    let submitCalls = 0;
    let pollCalls = 0;
    let downloadCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        throw new Error("submit must not run during Blob recovery");
      },
      pollStatus: async () => {
        pollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: taskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/recovery-mismatch.mp4"
        };
      },
      fetchOutput: async () => { throw new Error("adapter output fetch must not run"); }
    } as unknown as VideoProviderAdapter;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        now: () => new Date(wallMs),
        monotonic_now_ms: () => 10_000
      }
    });
    assert.equal(pollCalls, 0);

    db = openM0Database(sqlitePath);
    const attached = reconcileGenerationJob(prepared.job_id, {
      decision: "attach_existing_task",
      provider_task_id: taskId,
      human_confirmation: true
    }, db, { env: prepared.env, now: () => new Date(wallMs) });
    assert.equal(attached.ok, true, attached.ok ? undefined : attached.error.code);
    const recoveryRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const recovery = (JSON.parse(recoveryRow.data_json) as {
      provider_output_recovery: { invalid_artifact_id: string };
    }).provider_output_recovery;
    db.close();

    const differentBytes = Buffer.concat([
      readFileSync(videoFixture),
      Buffer.from("different-provider-output", "utf8")
    ]);
    const download = (async (input, targetDb, runtime = {}) => {
      downloadCalls += 1;
      assert.deepEqual(input.verified_blob_recovery, {
        invalid_artifact_id: recovery.invalid_artifact_id
      });
      return downloadProviderOutputToArtifact({
        ...input,
        storage_directory: mediaRoot
      }, targetDb, {
        ...runtime,
        storage_root: mediaRoot,
        resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
        fetch_pinned_address: async () => new Response(differentBytes, {
          status: 200,
          headers: { "content-type": "video/mp4" }
        })
      });
    }) as typeof downloadProviderOutputToArtifact;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        now: () => new Date(wallMs),
        monotonic_now_ms: () => 10_000,
        download_provider_output: download
      }
    });

    db = openM0Database(sqlitePath);
    const failedIntent = db.prepare("SELECT status, output_artifact_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; output_artifact_id: string; sanitized_error_json: string };
    const failedJob = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    db.close();
    assert.equal(submitCalls, 0);
    assert.equal(pollCalls, 1);
    assert.equal(downloadCalls, 1);
    assert.equal(failedIntent.status, "running");
    assert.equal(failedIntent.output_artifact_id, "");
    assert.equal((JSON.parse(failedIntent.sanitized_error_json) as { code: string }).code, "MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH");
    assert.deepEqual({ ...failedJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_OUTPUT_REQUIRES_RECONCILIATION"
    });

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        now: () => new Date(wallMs + 1_000),
        monotonic_now_ms: () => 11_000,
        download_provider_output: download
      }
    });
    assert.equal(submitCalls, 0);
    assert.equal(pollCalls, 1);
    assert.equal(downloadCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Provider success and downloading state roll back together across the crash window", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-success-state-atomic-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Atomic Provider success state");
    const taskId = "task-success-state-atomic";
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    let downloadCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run"); },
      pollStatus: async () => ({
        ok: true as const,
        provider_job_id: taskId,
        status: "succeeded" as const,
        provider_status: "SUCCESS",
        retryable: false,
        output_url: "https://example.invalid/atomic.mp4"
      }),
      fetchOutput: async () => { throw new Error("output fetch must not run"); }
    } as unknown as VideoProviderAdapter;

    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: sqlitePath,
        env: prepared.env,
        adapter_factory: () => adapter,
        download_provider_output: (async () => {
          downloadCalls += 1;
          throw new Error("download must not start before the atomic state transition commits");
        }) as typeof downloadProviderOutputToArtifact,
        fault_injection_after_provider_success_run_write: () => {
          throw new Error("INJECTED_PROVIDER_SUCCESS_STATE_CRASH");
        }
      }
    });

    const db = openM0Database(sqlitePath);
    const intent = db.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const runRow = db.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?")
      .get(prepared.run_id) as { data_json: string };
    db.close();
    const run = JSON.parse(runRow.data_json) as {
      status: string;
      provider: { provider_job_id: string; provider_status: string };
      error: { code: string };
    };
    assert.equal(downloadCalls, 0);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: taskId });
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "LOCAL_WORKER_REQUIRES_RECONCILIATION"
    });
    assert.equal(run.status, "running");
    assert.equal(run.provider.provider_job_id, taskId);
    assert.equal(run.provider.provider_status, "LOCAL_WORKER_REQUIRES_RECONCILIATION");
    assert.equal(run.error.code, "LOCAL_WORKER_STATE_UNKNOWN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regeneration poll timeout restores review workflow without losing the rejected clip", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-regeneration-poll-timeout-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Regeneration polling deadline", { regeneration: true });
    const baseWallMs = Date.now();
    let wallMs = baseWallMs;
    let monotonicMs = 20_000;
    let submitCalls = 0;
    let pollCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        return { ok: true as const, provider_job_id: "task-regeneration-timeout", provider_status: "PENDING" };
      },
      pollStatus: async () => {
        pollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: "task-regeneration-timeout",
          status: "running" as const,
          provider_status: "RUNNING",
          retryable: true
        };
      },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const dependencies = {
      sqlite_path: sqlitePath,
      env: { ...prepared.env, PROVIDER_TASK_POLL_TIMEOUT_MS: "1000" },
      adapter_factory: () => adapter,
      now: () => new Date(wallMs),
      monotonic_now_ms: () => monotonicMs,
      poll_interval_ms: 100
    };

    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: true, dependencies });
    wallMs += 1_000;
    monotonicMs += 1_000;
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string };
    const run = checked.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?")
      .get(prepared.run_id) as { data_json: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
      .get(prepared.job_id) as { state: string; reconciliation_reason: string };
    const project = checked.prepare("SELECT data_json FROM projects WHERE project_id = ?")
      .get(prepared.project_id) as { data_json: string };
    const shot = checked.prepare("SELECT data_json FROM shots WHERE shot_id = ?")
      .get(prepared.shot_id) as { data_json: string };
    const summary = listWorkbenchProjects({ scope: "all" }, checked).items
      .find((item) => item.project.project_id === prepared.project_id);
    checked.close();

    const runData = JSON.parse(run.data_json) as { status: string };
    const shotData = JSON.parse(shot.data_json) as {
      status: string;
      clip_versions: Array<{ artifact_id: string; review_status: string }>;
      review: { approval_status: string; rejection_reasons: string[] };
    };
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 0);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: "task-regeneration-timeout" });
    assert.equal(runData.status, "running");
    assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_POLL_TIMEOUT" });
    assert.equal((JSON.parse(project.data_json) as { status: string }).status, "video_review");
    assert.equal(shotData.status, "revision_needed");
    assert.equal(shotData.clip_versions.length, 1);
    assert.equal(shotData.clip_versions[0]?.review_status, "rejected");
    assert.deepEqual(shotData.review.rejection_reasons, ["motion_drift"]);
    assert.equal(summary?.active_run_count, 0);
    assert.ok(summary?.blocker_codes.includes("GENERATION_MANUAL_RECONCILIATION"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom provider polling deadline is enforced after a poll response returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-custom-poll-timeout-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Custom polling deadline");
    const baseWallMs = Date.now();
    let wallMs = baseWallMs;
    let monotonicMs = 50_000;
    let submitCalls = 0;
    let pollCalls = 0;
    let observedRequestTimeout = -1;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        return { ok: true as const, provider_job_id: "task-custom-deadline", provider_status: "PENDING" };
      },
      pollStatus: async (_taskId: string, options?: ProviderPollOptions) => {
        pollCalls += 1;
        observedRequestTimeout = options?.timeout_ms ?? -1;
        wallMs += 1_000;
        monotonicMs += 1_000;
        return {
          ok: true as const,
          provider_job_id: "task-custom-deadline",
          status: "running" as const,
          provider_status: "RUNNING",
          retryable: true
        };
      },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const dependencies = {
      sqlite_path: sqlitePath,
      env: { ...prepared.env, PROVIDER_TASK_POLL_TIMEOUT_MS: "1200" },
      adapter_factory: () => adapter,
      poll_interval_ms: 100,
      now: () => new Date(wallMs),
      monotonic_now_ms: () => monotonicMs
    };

    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: true, dependencies });
    wallMs += 200;
    monotonicMs += 200;
    await runWorkbenchGenerationOnce(prepared.intent_id, { allow_submit: false, dependencies });

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT provider_task_id, data_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { provider_task_id: string; data_json: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    assert.equal(Date.parse((JSON.parse(intent.data_json) as { provider_poll_deadline_at: string }).provider_poll_deadline_at), baseWallMs + 1_200);
    assert.equal(observedRequestTimeout, 1_000);
    assert.equal(submitCalls, 1);
    assert.equal(pollCalls, 1);
    assert.equal(intent.provider_task_id, "task-custom-deadline");
    assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_POLL_TIMEOUT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider polling timeout configuration is bounded and fails closed before provider execution", async () => {
  assert.equal(parseProviderTaskPollTimeoutMs({}), DEFAULT_PROVIDER_TASK_POLL_TIMEOUT_MS);
  assert.equal(parseProviderTaskPollTimeoutMs({ PROVIDER_TASK_POLL_TIMEOUT_MS: String(MIN_PROVIDER_TASK_POLL_TIMEOUT_MS) }), MIN_PROVIDER_TASK_POLL_TIMEOUT_MS);
  assert.equal(parseProviderTaskPollTimeoutMs({ PROVIDER_TASK_POLL_TIMEOUT_MS: String(MAX_PROVIDER_TASK_POLL_TIMEOUT_MS) }), MAX_PROVIDER_TASK_POLL_TIMEOUT_MS);
  for (const value of ["", " ", "not-a-number", "-1", "0", "1.5", "Infinity", "999", String(MAX_PROVIDER_TASK_POLL_TIMEOUT_MS + 1), "9007199254740992"]) {
    assert.throws(
      () => parseProviderTaskPollTimeoutMs({ PROVIDER_TASK_POLL_TIMEOUT_MS: value }),
      /Provider poll timeout configuration is invalid/
    );
  }

  const root = mkdtempSync(join(tmpdir(), "generation-invalid-poll-timeout-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Invalid polling timeout");
    let providerCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { providerCalls += 1; throw new Error("submit must not run"); },
      pollStatus: async () => { providerCalls += 1; throw new Error("poll must not run"); },
      fetchOutput: async () => { providerCalls += 1; throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(prepared.intent_id, {
      allow_submit: true,
      dependencies: {
        sqlite_path: sqlitePath,
        env: { ...prepared.env, PROVIDER_TASK_POLL_TIMEOUT_MS: "0" },
        adapter_factory: () => adapter
      }
    });
    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    const job = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    assert.equal(providerCalls, 0);
    assert.deepEqual({ status: intent.status, provider_task_id: intent.provider_task_id }, { status: "failed", provider_task_id: "" });
    assert.equal((JSON.parse(intent.sanitized_error_json) as { code: string }).code, "PROVIDER_POLL_TIMEOUT_CONFIG_INVALID");
    assert.deepEqual({ ...job }, { state: "failed", reconciliation_reason: "PROVIDER_POLL_TIMEOUT_CONFIG_INVALID" });

    const missingPath = join(root, "missing.sqlite");
    const missing = await prepareConfirmedGeneration(missingPath, "Missing persisted polling deadline");
    persistKnownProviderTask(missingPath, missing.intent_id, missing.job_id, "task-missing-deadline");
    const missingDb = openM0Database(missingPath);
    const missingDataRow = missingDb.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(missing.intent_id) as { data_json: string };
    const missingData = JSON.parse(missingDataRow.data_json) as Record<string, unknown>;
    delete missingData.provider_poll_started_at;
    delete missingData.provider_poll_timeout_ms;
    delete missingData.provider_poll_deadline_at;
    missingDb.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(missingData), missing.intent_id);
    missingDb.close();
    await runWorkbenchGenerationOnce(missing.intent_id, {
      allow_submit: false,
      dependencies: { sqlite_path: missingPath, env: missing.env, adapter_factory: () => adapter }
    });
    const missingChecked = openM0Database(missingPath);
    const missingIntent = missingChecked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(missing.intent_id) as { status: string; provider_task_id: string };
    const missingJob = missingChecked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(missing.job_id) as { state: string; reconciliation_reason: string };
    missingChecked.close();
    assert.equal(providerCalls, 0);
    assert.deepEqual({ ...missingIntent }, { status: "running", provider_task_id: "task-missing-deadline" });
    assert.deepEqual({ ...missingJob }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_POLL_TIMEOUT_CONFIG_INVALID" });

    const persistedPath = join(root, "persisted.sqlite");
    const persisted = await prepareConfirmedGeneration(persistedPath, "Invalid persisted polling deadline");
    persistKnownProviderTask(persistedPath, persisted.intent_id, persisted.job_id, "task-invalid-deadline");
    const persistedDb = openM0Database(persistedPath);
    const persistedDataRow = persistedDb.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(persisted.intent_id) as { data_json: string };
    const persistedData = JSON.parse(persistedDataRow.data_json) as Record<string, unknown>;
    const startedAt = Date.now();
    persistedData.provider_poll_started_at = new Date(startedAt).toISOString();
    persistedData.provider_poll_timeout_ms = MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    persistedData.provider_poll_deadline_at = new Date(startedAt + MIN_PROVIDER_TASK_POLL_TIMEOUT_MS + 1).toISOString();
    persistedDb.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(persistedData), persisted.intent_id);
    persistedDb.close();
    await runWorkbenchGenerationOnce(persisted.intent_id, {
      allow_submit: false,
      dependencies: { sqlite_path: persistedPath, env: persisted.env, adapter_factory: () => adapter }
    });
    const persistedChecked = openM0Database(persistedPath);
    const persistedIntent = persistedChecked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(persisted.intent_id) as { status: string; provider_task_id: string };
    const persistedJob = persistedChecked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(persisted.job_id) as { state: string; reconciliation_reason: string };
    persistedChecked.close();
    assert.equal(providerCalls, 0);
    assert.deepEqual({ ...persistedIntent }, { status: "running", provider_task_id: "task-invalid-deadline" });
    assert.deepEqual({ ...persistedJob }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_POLL_TIMEOUT_CONFIG_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("poll timeout remains distinct from submit rejection, unknown submit, task failure, and task success", async () => {
  const roots: string[] = [];
  try {
    const rejectedRoot = mkdtempSync(join(tmpdir(), "generation-submit-rejected-"));
    roots.push(rejectedRoot);
    const rejectedPath = join(rejectedRoot, "app.sqlite");
    const rejected = await prepareConfirmedGeneration(rejectedPath, "Definite submit rejection");
    const rejectedAdapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => ({ ok: false as const, error: { code: "PROVIDER_AUTH_FAILED", message: "Synthetic rejection.", retryable: false } }),
      pollStatus: async () => { throw new Error("poll must not run"); },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(rejected.intent_id, { allow_submit: true, dependencies: { sqlite_path: rejectedPath, env: rejected.env, adapter_factory: () => rejectedAdapter } });
    let checked = openM0Database(rejectedPath);
    const rejectedIntent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(rejected.intent_id) as { status: string; provider_task_id: string };
    const rejectedJob = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(rejected.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    assert.deepEqual({ ...rejectedIntent }, { status: "failed", provider_task_id: "" });
    assert.deepEqual({ ...rejectedJob }, { state: "failed", reconciliation_reason: "PROVIDER_AUTH_FAILED" });

    const unknownRoot = mkdtempSync(join(tmpdir(), "generation-submit-unknown-"));
    roots.push(unknownRoot);
    const unknownPath = join(unknownRoot, "app.sqlite");
    const unknown = await prepareConfirmedGeneration(unknownPath, "Unknown submit outcome");
    let unknownSubmitCalls = 0;
    const unknownAdapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        unknownSubmitCalls += 1;
        return {
          ok: false as const,
          error: { code: "PROVIDER_TIMEOUT", message: "Synthetic unknown outcome.", retryable: true, submission_outcome_unknown: true }
        };
      },
      pollStatus: async () => { throw new Error("poll must not run"); },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const unknownDependencies = { sqlite_path: unknownPath, env: unknown.env, adapter_factory: () => unknownAdapter };
    await runWorkbenchGenerationOnce(unknown.intent_id, { allow_submit: true, dependencies: unknownDependencies });
    await runWorkbenchGenerationOnce(unknown.intent_id, { allow_submit: true, dependencies: unknownDependencies });
    checked = openM0Database(unknownPath);
    const unknownIntent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(unknown.intent_id) as { status: string; provider_task_id: string };
    const unknownJob = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(unknown.job_id) as { state: string; reconciliation_reason: string };
    const unknownProject = checked.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(unknown.project_id) as { data_json: string };
    const unknownShot = checked.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(unknown.shot_id) as { data_json: string };
    const unknownSummary = listWorkbenchProjects({ scope: "all" }, checked).items
      .find((item) => item.project.project_id === unknown.project_id);
    checked.close();
    assert.equal(unknownSubmitCalls, 1);
    assert.deepEqual({ ...unknownIntent }, { status: "running", provider_task_id: "" });
    assert.deepEqual({ ...unknownJob }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_SUBMIT_OUTCOME_UNKNOWN" });
    assert.equal((JSON.parse(unknownProject.data_json) as { status: string }).status, "storyboard_approved");
    assert.equal((JSON.parse(unknownShot.data_json) as { status: string }).status, "storyboard_approved");
    assert.equal(unknownSummary?.active_run_count, 0);
    assert.ok(unknownSummary?.blocker_codes.includes("GENERATION_MANUAL_RECONCILIATION"));

    const failedRoot = mkdtempSync(join(tmpdir(), "generation-task-failed-"));
    roots.push(failedRoot);
    const failedPath = join(failedRoot, "app.sqlite");
    const failed = await prepareConfirmedGeneration(failedPath, "Definite task failure");
    let failedPollCalls = 0;
    persistKnownProviderTask(failedPath, failed.intent_id, failed.job_id, "task-definite-failure");
    const failedAdapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run"); },
      pollStatus: async () => {
        failedPollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: "task-definite-failure",
          status: "failed" as const,
          provider_status: "FAILED",
          retryable: false
        };
      },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(failed.intent_id, { allow_submit: false, dependencies: { sqlite_path: failedPath, env: failed.env, adapter_factory: () => failedAdapter } });
    checked = openM0Database(failedPath);
    const failedIntent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?").get(failed.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    const failedJob = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(failed.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    assert.equal(failedPollCalls, 1);
    assert.deepEqual({ status: failedIntent.status, provider_task_id: failedIntent.provider_task_id }, { status: "running", provider_task_id: "task-definite-failure" });
    assert.equal((JSON.parse(failedIntent.sanitized_error_json) as { code: string }).code, "PROVIDER_TERMINAL_STATUS_REQUIRES_RECONCILIATION");
    assert.deepEqual({ ...failedJob }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_TERMINAL_STATUS_REQUIRES_RECONCILIATION" });

    const succeededRoot = mkdtempSync(join(tmpdir(), "generation-task-succeeded-"));
    roots.push(succeededRoot);
    const succeededPath = join(succeededRoot, "app.sqlite");
    const succeeded = await prepareConfirmedGeneration(succeededPath, "Successful task result");
    const succeededTaskId = "task-definite-success";
    const succeededArtifactId = `artifact_${createHash("sha256").update(`runninghub\0${succeededTaskId}`).digest("hex")}`;
    const succeededMediaRoot = join(succeededRoot, "media");
    const succeededSourcePath = join(succeededMediaRoot, "provider-source.mp4");
    mkdirSync(succeededMediaRoot, { recursive: true });
    writeProviderOutputFixture(succeededSourcePath);
    persistKnownProviderTask(succeededPath, succeeded.intent_id, succeeded.job_id, succeededTaskId);
    let succeededPollCalls = 0;
    let succeededDownloadCalls = 0;
    const succeededAdapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => { throw new Error("submit must not run"); },
      pollStatus: async () => {
        succeededPollCalls += 1;
        return {
          ok: true as const,
          provider_job_id: succeededTaskId,
          status: "succeeded" as const,
          provider_status: "SUCCESS",
          retryable: false,
          output_url: "https://example.invalid/provider-success.mp4"
        };
      },
      fetchOutput: async () => { throw new Error("output fetch must not run when poll returns the output URL"); }
    } as unknown as VideoProviderAdapter;
    const succeededDownload = (async (input, targetDb, runtime = {}) => {
      succeededDownloadCalls += 1;
      assert.ok(runtime.activate_artifact);
      return runtime.activate_artifact({
        artifact: {
          artifact_id: succeededArtifactId,
          blob_id: "",
          artifact_type: "video",
          role: "generated_clip",
          status: "active",
          storage: {
            uri: join(succeededMediaRoot, `${succeededArtifactId}.mp4`),
            mime_type: "video/mp4",
            filename: `${succeededArtifactId}.mp4`
          },
          metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: "" },
          linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
          source: {
            kind: "provider_output_file",
            provider: "runninghub",
            provider_job_id: input.provider_job_id,
            sha256: "",
            external_url_host: "example.invalid"
          }
        },
        source_path: succeededSourcePath,
        media_root: succeededMediaRoot
      }, targetDb);
    }) as typeof downloadProviderOutputToArtifact;
    await runWorkbenchGenerationOnce(succeeded.intent_id, {
      allow_submit: false,
      dependencies: {
        sqlite_path: succeededPath,
        env: succeeded.env,
        adapter_factory: () => succeededAdapter,
        download_provider_output: succeededDownload,
        provider_output_storage_directory: succeededMediaRoot
      }
    });
    checked = openM0Database(succeededPath);
    const succeededIntent = checked.prepare("SELECT status, provider_task_id, output_artifact_id FROM generation_intents WHERE intent_id = ?").get(succeeded.intent_id) as { status: string; provider_task_id: string; output_artifact_id: string };
    const succeededJob = checked.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(succeeded.job_id) as { state: string; reconciliation_reason: string };
    checked.close();
    assert.equal(succeededPollCalls, 1);
    assert.equal(succeededDownloadCalls, 1);
    assert.equal(succeededIntent.status, "succeeded");
    assert.equal(succeededIntent.provider_task_id, succeededTaskId);
    assert.equal(succeededIntent.output_artifact_id, succeededArtifactId);
    assert.deepEqual({ ...succeededJob }, { state: "succeeded", reconciliation_reason: "" });
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
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

test("[EEI-RECOVERY-02] startup quarantines an interrupted submitting Job after its task identity commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-resume-known-submitting-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Resume known submitting task");
    const taskId = "task-known-submitting-after-crash";
    persistKnownProviderTask(sqlitePath, prepared.intent_id, prepared.job_id, taskId);
    const db = openM0Database(sqlitePath);
    db.prepare(`UPDATE generation_jobs
      SET state = 'submitting', lease_owner = 'crashed_worker', lease_token = 'expired_submit_lease',
        lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(prepared.job_id);
    db.close();

    let submitCalls = 0;
    const adapter = {
      provider_name: "runninghub",
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        throw new Error("restart must never resubmit a retained task");
      },
      pollStatus: async () => { throw new Error("explicit reconciliation is required before polling"); },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as unknown as VideoProviderAdapter;
    const resumed = resumeWorkbenchGenerationJobs({
      sqlite_path: sqlitePath,
      env: prepared.env,
      adapter_factory: () => adapter
    });
    assert.deepEqual(resumed, { resumed: [], reconciled: [prepared.intent_id] });
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(submitCalls, 0);

    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string };
    const job = checked.prepare(`SELECT state, reconciliation_reason, lease_owner, lease_token, lease_expires_at
      FROM generation_jobs WHERE job_id = ?`).get(prepared.job_id) as {
        state: string;
        reconciliation_reason: string;
        lease_owner: string;
        lease_token: string;
        lease_expires_at: string | null;
      };
    const receipt = getGenerationExecutionReceipt(checked, prepared.intent_id);
    assert.deepEqual({ ...intent }, { status: "running", provider_task_id: taskId });
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "GENERATION_SUBMIT_INTERRUPTED_WITH_KNOWN_TASK",
      lease_owner: "",
      lease_token: "",
      lease_expires_at: null
    });
    assert.equal(receipt?.provider_task_id, taskId);
    assert.equal(receipt?.state, "reconciling");
    checked.close();
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
    for (let attempt = 0; attempt < 50 && finalState !== "manual_reconciliation"; attempt += 1) {
      const checked = openM0Database(sqlitePath);
      const intent = checked.prepare("SELECT provider_task_id FROM generation_intents WHERE intent_id = ?").get(prepared.intent_id) as { provider_task_id: string };
      const job = checked.prepare("SELECT state FROM generation_jobs WHERE job_id = ?").get(prepared.job_id) as { state: string };
      assert.equal(intent.provider_task_id, "task-resumed-queued");
      finalState = job.state;
      checked.close();
      if (finalState !== "manual_reconciliation") await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(finalState, "manual_reconciliation");
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup scheduler fails closed at the persisted poll deadline before a crashed worker lease expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-scheduler-expired-deadline-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Schedule expired deadline reconciliation");
    const taskId = "task-scheduler-expired-deadline";
    persistKnownProviderTask(
      sqlitePath,
      prepared.intent_id,
      prepared.job_id,
      taskId,
      MIN_PROVIDER_TASK_POLL_TIMEOUT_MS
    );
    const wallMs = Date.parse("2035-01-02T03:04:05.600Z");
    const startedAtMs = wallMs - MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    const db = openM0Database(sqlitePath);
    const intentRow = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { data_json: string };
    const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
    intentData.provider_poll_started_at = new Date(startedAtMs).toISOString();
    intentData.provider_poll_timeout_ms = MIN_PROVIDER_TASK_POLL_TIMEOUT_MS;
    intentData.provider_poll_deadline_at = new Date(wallMs).toISOString();
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?")
      .run(JSON.stringify(intentData), prepared.intent_id);
    db.prepare(`UPDATE generation_jobs
      SET next_attempt_at = '2099-01-01T00:00:00.000Z',
          lease_owner = 'crashed_worker',
          lease_token = 'inherited_expired_deadline_lease',
          lease_expires_at = '2099-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(prepared.job_id);
    db.close();

    let providerCalls = 0;
    const adapter = {
      provider_name: "runninghub", model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        providerCalls += 1;
        throw new Error("known Provider task must not be resubmitted");
      },
      pollStatus: async () => {
        providerCalls += 1;
        throw new Error("expired polling deadline must fail closed before Provider polling");
      },
      fetchOutput: async () => {
        providerCalls += 1;
        throw new Error("output must not run");
      }
    } as unknown as VideoProviderAdapter;
    const resumed = resumeWorkbenchGenerationJobs({
      sqlite_path: sqlitePath,
      env: { ...prepared.env, PROVIDER_TASK_POLL_TIMEOUT_MS: String(MIN_PROVIDER_TASK_POLL_TIMEOUT_MS) },
      adapter_factory: () => adapter,
      now: () => new Date(wallMs),
      monotonic_now_ms: () => 50_000
    });
    assert.deepEqual(resumed, { resumed: [prepared.intent_id], reconciled: [] });

    let observedJob = { state: "", reconciliation_reason: "", lease_token: "" };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const checked = openM0Database(sqlitePath);
      observedJob = checked.prepare("SELECT state, reconciliation_reason, lease_token FROM generation_jobs WHERE job_id = ?")
        .get(prepared.job_id) as typeof observedJob;
      checked.close();
      if (observedJob.state === "manual_reconciliation" && observedJob.lease_token === "") break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    const checked = openM0Database(sqlitePath);
    const intent = checked.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(prepared.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
    checked.close();

    assert.equal(providerCalls, 0);
    assert.deepEqual({ ...observedJob }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_POLL_TIMEOUT",
      lease_token: ""
    });
    assert.deepEqual({
      status: intent.status,
      provider_task_id: intent.provider_task_id,
      error_code: (JSON.parse(intent.sanitized_error_json) as { code: string }).code
    }, {
      status: "running",
      provider_task_id: taskId,
      error_code: "PROVIDER_POLL_TIMEOUT"
    });
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
    const created = createProject({ title: "Provider output idempotency" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shot = buildStoryboardApprovedShot({
      shot_id: "shot_idempotent",
      project_id: created.project_id,
      order: 1,
      duration_seconds: 2,
      storyboard_image_artifact_id: "",
      video_prompt: "Provider output idempotency fixture"
    });
    saveShot(db, shot);
    created.project.shot_ids = [shot.shot_id];
    saveProject(db, created.project);
    const input = {
      url: "https://cdn.example.test/output.mp4",
      provider_name: "runninghub",
      provider_job_id: "task-idempotent-1",
      project_id: created.project_id,
      shot_id: shot.shot_id,
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
