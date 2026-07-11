import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { WORKBENCH_V2_SCHEMA_VERSION } from "../src/storage/workbenchV2Schema.js";
import { buildStoryboardApprovedShot, createProject, saveProject, saveShot } from "../src/tools/projects.js";
import {
  createWorkbenchProject,
  listWorkbenchProjects,
  setWorkbenchProjectLifecycle,
  updateWorkbenchProject
} from "../src/tools/workbenchV2.js";
import { confirmWorkbenchGeneration, preflightWorkbenchGeneration, reconcileGenerationJob, resumeWorkbenchGenerationJobs, runWorkbenchGenerationOnce } from "../src/tools/workbenchGeneration.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { downloadProviderOutputToArtifact } from "../src/tools/providerOutputDownloader.js";
import type { VideoProviderAdapter } from "../src/tools/videoProviderAdapters.js";

async function prepareConfirmedGeneration(sqlitePath: string, title: string): Promise<{ intent_id: string; job_id: string; env: NodeJS.ProcessEnv }> {
  migrateDatabase(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const project = createProject({ title, video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" } }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("project setup failed");
    const artifact = registerMediaArtifact({
      artifact_type: "image", role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
      linked_objects: { project_id: project.project_id }
    }, db);
    assert.equal(artifact.ok, true);
    if (!artifact.ok) throw new Error("artifact setup failed");
    const shot = buildStoryboardApprovedShot({ project_id: project.project_id, order: 1, duration_seconds: 6, storyboard_image_artifact_id: artifact.artifact.artifact_id, video_prompt: "Fault injection generation." });
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
      provider_name: "runninghub", model_name: "model",
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

test("each worker claim performs one provider step and defers a still-running task", async () => {
  const root = mkdtempSync(join(tmpdir(), "generation-poll-timeout-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    const prepared = await prepareConfirmedGeneration(sqlitePath, "Polling timeout");
    const adapter = {
      provider_name: "runninghub", model_name: "model",
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
      provider_name: "runninghub", model_name: "model",
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
