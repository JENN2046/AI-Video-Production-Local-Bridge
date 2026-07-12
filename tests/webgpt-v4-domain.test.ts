import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openM0Database, type M0Database } from "../src/storage/sqlite.js";
import { confirmWorkbenchGeneration } from "../src/tools/workbenchGeneration.js";
import { decideWorkbenchPendingAction, transitionWorkbenchDraft } from "../src/tools/workbenchInbox.js";
import { saveWorkbenchPendingActionRecord } from "../src/tools/workbenchInboxStore.js";
import { createProject, saveProject, saveShot, type Project, type Shot } from "../src/tools/projects.js";
import {
  addProductionReviewNote,
  getProductionProjectContext,
  listProductionProjectMedia,
  listProductionProjectShots,
  listProductionProjects,
  prepareProductionGenerationIntent,
  submitProductionProposal,
  updateProductionShotCopy
} from "../src/webgpt-v4/domain.js";
import { migrateLegacyWebGptV4History } from "../src/webgpt-v4/migration.js";
import { actorFromSubject } from "../src/webgpt-v4/types.js";

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

    const replay = updateProductionShotCopy(input, { actor, idempotency_key: "shot-copy-1" }, context.db);
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.meta.idempotent_replay, true);

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
  try {
    const artifact = {
      artifact_id: "artifact_storyboard_001",
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: join(context.root, "image.png"), mime_type: "image/png", filename: "image.png" },
      metadata: { width: 1, height: 1, duration_seconds: null, aspect_ratio: "1:1", sha256: "abc" },
      linked_objects: { project_id: context.production.project_id, shot_id: context.productionShot.shot_id },
      source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: "abc", external_url_host: "" }
    };
    context.db.prepare("INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json) VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)")
      .run(artifact.artifact_id, context.production.project_id, context.productionShot.shot_id, JSON.stringify(artifact));
    const blocked = prepareProductionGenerationIntent({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, account_label: "personal", budget_limit_value: 100 }, { actor, idempotency_key: "intent-blocked" }, context.db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "GENERATION_PREP_BLOCKED");

    const now = new Date();
    context.db.prepare(`INSERT INTO webgpt_provider_price_cache (provider, model, duration_seconds, resolution, estimated_cost_value, currency, source, fetched_at, expires_at) VALUES ('runninghub', 'runninghub_kling_3_0_image_to_video', 6, '720p', 12, 'RH_COINS', 'test', ?, ?)`)
      .run(now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    const prepared = prepareProductionGenerationIntent({ project_id: context.production.project_id, shot_id: context.productionShot.shot_id, account_label: "personal", budget_limit_value: 100 }, { actor, idempotency_key: "intent-ready" }, context.db);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const confirmed = confirmWorkbenchGeneration({ intent_id: String(prepared.data.intent_id), budget_limit_value: 100, cost_confirmed: true, human_confirmation: true }, context.db);
    assert.equal(confirmed.ok, false);
    if (!confirmed.ok) assert.equal(confirmed.error.code, "OFFICIAL_PREFLIGHT_REQUIRED");
  } finally {
    teardown(context);
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
