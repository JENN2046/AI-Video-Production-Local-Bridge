import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { openM0Database } from "../src/storage/sqlite.js";
import { WORKBENCH_V2_SCHEMA_VERSION } from "../src/storage/workbenchV2Schema.js";
import { buildStoryboardApprovedShot, createProject, saveProject, saveShot } from "../src/tools/projects.js";
import {
  createWorkbenchProject,
  listWorkbenchProjects,
  setWorkbenchProjectLifecycle,
  updateWorkbenchProject
} from "../src/tools/workbenchV2.js";
import { confirmWorkbenchGeneration, preflightWorkbenchGeneration, reconcileGenerationJob, runWorkbenchGenerationOnce } from "../src/tools/workbenchGeneration.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import type { VideoProviderAdapter } from "../src/tools/videoProviderAdapters.js";

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

test("generation preflight enforces official estimate, balance gate, budget and one active submit", async () => {
  const db = openM0Database(":memory:");
  try {
    const projectResult = createProject({ title: "Generation gate", video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" } }, db);
    assert.equal(projectResult.ok, true);
    if (!projectResult.ok) return;
    const artifactResult = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: projectResult.project_id }
    }, db);
    assert.equal(artifactResult.ok, true);
    if (!artifactResult.ok) return;
    const shot = buildStoryboardApprovedShot({ project_id: projectResult.project_id, order: 1, duration_seconds: 6, storyboard_image_artifact_id: artifactResult.artifact.artifact_id, video_prompt: "Subtle camera move." });
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
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("price-preview")) return new Response(JSON.stringify({ errorCode: "", errorMessage: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200, headers: { "content-type": "application/json" } });
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
    const reconciliationEvent = db.prepare("SELECT to_state, reason_code FROM generation_job_events WHERE job_id = ? ORDER BY rowid DESC LIMIT 1").get(confirmed.data.job_id) as { to_state: string; reason_code: string };
    assert.equal(reconciliationEvent.to_state, "polling");
    assert.equal(reconciliationEvent.reason_code, "HUMAN_ATTACHED_EXISTING_TASK");
    assert.throws(() => db.prepare("UPDATE generation_job_events SET reason_code = 'rewritten' WHERE job_id = ?").run(confirmed.data.job_id), /GENERATION_JOB_EVENTS_APPEND_ONLY/);

    db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state, reconciliation_reason) VALUES (?, ?, 'manual_reconciliation', 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN')")
      .run("job_abandon_test", second.data.intent.intent_id);
    const abandoned = reconcileGenerationJob("job_abandon_test", { decision: "abandon", reason: "Human verified that no provider task exists.", human_confirmation: true }, db);
    assert.equal(abandoned.ok, true);
    if (abandoned.ok) {
      assert.equal(abandoned.data.job.state, "cancelled");
      assert.equal(abandoned.data.intent.status, "cancelled");
      assert.equal(abandoned.data.intent.provider_task_id, "");
    }
  } finally {
    db.close();
  }
});

test("unknown provider submit is reconciled manually and abandon restores project state", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-unknown-submit-"));
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  try {
    const projectResult = createProject({ title: "Unknown submit", video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" } }, db);
    assert.equal(projectResult.ok, true);
    if (!projectResult.ok) return;
    const artifactResult = registerMediaArtifact({
      artifact_type: "image", role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: projectResult.project_id }
    }, db);
    assert.equal(artifactResult.ok, true);
    if (!artifactResult.ok) return;
    const shot = buildStoryboardApprovedShot({ project_id: projectResult.project_id, order: 1, duration_seconds: 6, storyboard_image_artifact_id: artifactResult.artifact.artifact_id, video_prompt: "Safe unknown submit test." });
    saveShot(db, shot);
    projectResult.project.shot_ids.push(shot.shot_id);
    projectResult.project.status = "storyboard_approved";
    saveProject(db, projectResult.project);
    const env = { REAL_PROVIDER_ENABLED: "true", M1_REAL_PROVIDER: "runninghub", M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true", M1_REAL_PROVIDER_COST_ACK: "true", RUNNINGHUB_API_KEY: "synthetic-test-key" } as NodeJS.ProcessEnv;
    const fetchImpl: typeof fetch = async (input) => String(input).includes("price-preview")
      ? new Response(JSON.stringify({ errorCode: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { remainMoney: "10", currency: "CNY" } }), { status: 200 });
    const prepared = await preflightWorkbenchGeneration({ project_id: projectResult.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1 }, db, { env, fetch_impl: fetchImpl });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const confirmed = confirmWorkbenchGeneration({ intent_id: prepared.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, db);
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    db.close();

    const adapter = {
      provider_name: "runninghub", model_name: prepared.data.intent.model,
      submitGeneration: async () => ({ ok: false as const, error: { code: "PROVIDER_TIMEOUT", message: "Submit response was lost.", retryable: true, submission_outcome_unknown: true } }),
      pollStatus: async () => { throw new Error("poll must not run"); },
      fetchOutput: async () => { throw new Error("output must not run"); }
    } as VideoProviderAdapter;
    await runWorkbenchGenerationOnce(prepared.data.intent.intent_id, { allow_submit: true, dependencies: { sqlite_path: sqlitePath, env, adapter_factory: () => adapter } });

    const check = openM0Database(sqlitePath);
    try {
      const intent = check.prepare("SELECT status, provider_task_id FROM generation_intents WHERE intent_id = ?").get(prepared.data.intent.intent_id) as { status: string; provider_task_id: string };
      const job = check.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(confirmed.data.job_id) as { state: string; reconciliation_reason: string };
      assert.deepEqual({ ...intent }, { status: "running", provider_task_id: "" });
      assert.deepEqual({ ...job }, { state: "manual_reconciliation", reconciliation_reason: "PROVIDER_SUBMIT_OUTCOME_UNKNOWN" });
      const abandoned = reconcileGenerationJob(confirmed.data.job_id, { decision: "abandon", reason: "Provider confirmed no task exists.", human_confirmation: true }, check);
      assert.equal(abandoned.ok, true);
      const restoredShot = check.prepare("SELECT json_extract(data_json, '$.status') AS status FROM shots WHERE shot_id = ?").get(shot.shot_id) as { status: string };
      const restoredProject = check.prepare("SELECT json_extract(data_json, '$.status') AS status FROM projects WHERE project_id = ?").get(projectResult.project_id) as { status: string };
      assert.equal(restoredShot.status, "storyboard_approved");
      assert.equal(restoredProject.status, "storyboard_approved");

      const retryPrepared = await preflightWorkbenchGeneration({ project_id: projectResult.project_id, shot_id: shot.shot_id, account_label: "personal", budget_limit_value: 1 }, check, { env, fetch_impl: fetchImpl });
      assert.equal(retryPrepared.ok, true);
      if (!retryPrepared.ok) return;
      const retryConfirmed = confirmWorkbenchGeneration({ intent_id: retryPrepared.data.intent.intent_id, budget_limit_value: 1, cost_confirmed: true, human_confirmation: true }, check);
      assert.equal(retryConfirmed.ok, true);
      if (!retryConfirmed.ok) return;
      const rejectedAdapter = {
        ...adapter,
        submitGeneration: async () => ({ ok: false as const, error: { code: "PROVIDER_CONTENT_REJECTED", message: "Provider rejected input.", retryable: false } })
      } as VideoProviderAdapter;
      await runWorkbenchGenerationOnce(retryPrepared.data.intent.intent_id, { allow_submit: true, dependencies: { sqlite_path: sqlitePath, env, adapter_factory: () => rejectedAdapter } });
      const failedIntent = check.prepare("SELECT status FROM generation_intents WHERE intent_id = ?").get(retryPrepared.data.intent.intent_id) as { status: string };
      const failedJob = check.prepare("SELECT state FROM generation_jobs WHERE job_id = ?").get(retryConfirmed.data.job_id) as { state: string };
      const failedShot = check.prepare("SELECT json_extract(data_json, '$.status') AS status FROM shots WHERE shot_id = ?").get(shot.shot_id) as { status: string };
      const failedProject = check.prepare("SELECT json_extract(data_json, '$.status') AS status FROM projects WHERE project_id = ?").get(projectResult.project_id) as { status: string };
      assert.equal(failedIntent.status, "failed");
      assert.equal(failedJob.state, "failed");
      assert.equal(failedShot.status, "storyboard_approved");
      assert.equal(failedProject.status, "storyboard_approved");
    } finally { check.close(); }
  } finally {
    try { db.close(); } catch { /* already closed before worker execution */ }
    rmSync(root, { recursive: true, force: true });
  }
});
