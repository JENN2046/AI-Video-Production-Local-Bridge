import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { buildDirectorContext } from "../src/director/localService.js";
import { startDirectorBoundedGeneration } from "../src/director/boundedOrchestrator.js";
import { consumeDirectorGrantReservation, loadDirectorGrantAuthorization, reserveDirectorGrant } from "../src/director/grantRuntime.js";
import { directorBaseStateHash, directorContentHash, DIRECTOR_FOCUS_SCHEMA, DIRECTOR_PROPOSAL_SCHEMA, type DirectorProposal } from "../src/director/domain.js";
import {
  compileDirectorProposalToAutomationGrant,
  createDirectorWorkbenchFocus,
  decideDirectorProposal,
  getDirectorApprovalTower
} from "../src/director/workbenchApproval.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { createWorkbenchProject } from "../src/tools/workbenchV2.js";
import { runWorkbenchGenerationOnce } from "../src/tools/workbenchGeneration.js";
import { bootstrapWebGptProjectOwner } from "../src/webgpt-v4/authorizationAdmin.js";
import { handleWorkbenchV2Api } from "../src/http/workbenchV2Routes.js";

const principalId = "d".repeat(64);
const issuerHash = "e".repeat(64);
const firstNow = new Date("2026-07-22T08:00:00.000Z");

function insertCreativeBriefProposal(
  db: ReturnType<typeof openM0Database>,
  input: { project_id: string; focus_id: string; generation: number; proposal_id: string; idempotency_key: string; now: Date }
) {
  const focusRow = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
    generation, supersedes_focus_id, created_at, expires_at FROM director_focuses WHERE focus_id = ?`).get(input.focus_id) as Record<string, unknown>;
  const context = buildDirectorContext(db, DIRECTOR_FOCUS_SCHEMA.parse(focusRow), "creative_brief", "full");
  const payload = {
    summary: "Use a verified natural-light direction.",
    objectives: ["Keep the product geometry stable."],
    constraints: ["No Provider submission."],
    proposed_brief: {
      title: "Director fixture brief",
      audience: "Fixture reviewers",
      key_message: "Human approval remains required.",
      creative_direction: "Natural light and grounded movement.",
      call_to_action: "Review first."
    }
  };
  const proposal = DIRECTOR_PROPOSAL_SCHEMA.parse({
    proposal_id: input.proposal_id,
    schema_version: "director-domain-v1",
    workspace_id: "jenn-ai-video-workspace",
    principal_id: principalId,
    project_id: input.project_id,
    target_type: "project",
    target_id: input.project_id,
    focus_id: input.focus_id,
    focus_generation: input.generation,
    base_state_hash: directorBaseStateHash(context.targetState),
    payload_hash: directorContentHash(payload),
    parent_proposal_id: null,
    idempotency_key: input.idempotency_key,
    source: "native",
    created_at: input.now.toISOString(),
    kind: "creative_brief",
    payload
  });
  db.prepare(`INSERT INTO director_proposals
    (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
      schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id, idempotency_key, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(proposal.proposal_id, proposal.workspace_id, proposal.principal_id, proposal.project_id, proposal.target_type,
      proposal.target_id, proposal.focus_id, proposal.focus_generation, proposal.schema_version, proposal.kind,
      proposal.base_state_hash, JSON.stringify(proposal.payload), proposal.payload_hash, proposal.parent_proposal_id,
      proposal.idempotency_key, proposal.source, proposal.created_at);
  db.prepare(`INSERT INTO director_proposal_events (event_id, proposal_id, event_type, reason_code, created_at)
    VALUES (?, ?, 'submitted', 'DIRECTOR_NATIVE_SUBMITTED', ?)`)
    .run(`event_${proposal.proposal_id}`, proposal.proposal_id, proposal.created_at);
  return proposal;
}

function insertGenerationPlanProposal(
  db: ReturnType<typeof openM0Database>,
  input: { project_id: string; focus_id: string; generation: number; proposal_id: string; idempotency_key: string; now: Date }
): DirectorProposal {
  const shotId = "shot_director_automation_001";
  const storyboardArtifactId = "artifact_director_storyboard_001";
  const project = JSON.parse((db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(input.project_id) as { data_json: string }).data_json) as {
    project_id: string; shot_ids: string[]; status: string; video_spec: { duration_seconds: number; aspect_ratio: string; resolution: string };
  };
  project.status = "storyboard_approved";
  project.shot_ids = [shotId];
  saveProject(db, project as never);
  const shot: Shot = {
    shot_id: shotId, project_id: input.project_id, order: 1, status: "storyboard_approved", duration_seconds: 5,
    description: "A verified storyboard for bounded automation.", storyboard_image_artifact_id: storyboardArtifactId,
    video_prompt: "Move slowly toward the product.", negative_prompt: "No deformation.", generation_run_ids: [],
    accepted_clip_artifact_id: "", clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  const sha256 = "a".repeat(64);
  db.prepare(`INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)`).run(storyboardArtifactId, input.project_id, shotId, JSON.stringify({
    artifact_id: storyboardArtifactId, blob_id: "blob_director_storyboard_001", artifact_type: "image", role: "storyboard_image", status: "active",
    storage: { uri: "fixture://storyboard.png", mime_type: "image/png", filename: "storyboard.png" },
    metadata: { width: 1080, height: 1920, duration_seconds: null, aspect_ratio: "9:16", sha256 },
    linked_objects: { project_id: input.project_id, shot_id: shotId },
    source: { kind: "fixture", provider: "mock", provider_job_id: "", sha256, external_url_host: "" }
  }));
  const focusRow = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
    generation, supersedes_focus_id, created_at, expires_at FROM director_focuses WHERE focus_id = ?`).get(input.focus_id) as Record<string, unknown>;
  const context = buildDirectorContext(db, DIRECTOR_FOCUS_SCHEMA.parse(focusRow), "generation_plan", "full");
  const payload = {
    shot_id: shotId, provider: "runninghub" as const, model: "kling-v1", duration_seconds: 5, resolution: "1080x1920",
    video_prompt: shot.video_prompt, negative_prompt: shot.negative_prompt, continuity_constraints: [], estimated_cost_minor: 500, currency: "CNY"
  };
  const proposal = DIRECTOR_PROPOSAL_SCHEMA.parse({
    proposal_id: input.proposal_id, schema_version: "director-domain-v1", workspace_id: "jenn-ai-video-workspace",
    principal_id: principalId, project_id: input.project_id, target_type: "shot", target_id: shotId,
    focus_id: input.focus_id, focus_generation: input.generation, base_state_hash: directorBaseStateHash(context.targetState),
    payload_hash: directorContentHash(payload), parent_proposal_id: null, idempotency_key: input.idempotency_key,
    source: "native", created_at: input.now.toISOString(), kind: "generation_plan", payload
  });
  db.prepare(`INSERT INTO director_proposals
    (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
      schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id, idempotency_key, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(proposal.proposal_id, proposal.workspace_id, proposal.principal_id, proposal.project_id, proposal.target_type,
      proposal.target_id, proposal.focus_id, proposal.focus_generation, proposal.schema_version, proposal.kind,
      proposal.base_state_hash, JSON.stringify(proposal.payload), proposal.payload_hash, proposal.parent_proposal_id,
      proposal.idempotency_key, proposal.source, proposal.created_at);
  db.prepare(`INSERT INTO director_proposal_events (event_id, proposal_id, event_type, reason_code, created_at)
    VALUES (?, ?, 'submitted', 'DIRECTOR_NATIVE_SUBMITTED', ?)`)
    .run(`event_${proposal.proposal_id}`, proposal.proposal_id, proposal.created_at);
  return proposal;
}

function prepareRunnableDirectorGenerationFixture(db: ReturnType<typeof openM0Database>) {
  const created = createWorkbenchProject({
    title: "Director bounded execution fixture",
    classification: "production",
    duration_seconds: 6,
    aspect_ratio: "9:16",
    resolution: "480p"
  }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("Director execution fixture project failed");
  const projectId = created.data.project.project_id;
  bootstrapWebGptProjectOwner(db, principalId, projectId, "DIRECTOR_EXECUTION_FIXTURE", issuerHash);

  const shotId = "shot_director_execution_001";
  const artifactId = "artifact_director_execution_storyboard_001";
  const sourcePath = resolve("fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png");
  const sourceBytes = readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const blobId = `blob_sha256_${sha256}`;
  const project = created.data.project;
  project.status = "storyboard_approved";
  project.shot_ids = [shotId];
  saveProject(db, project);
  const shot: Shot = {
    shot_id: shotId,
    project_id: projectId,
    order: 1,
    status: "storyboard_approved",
    duration_seconds: 6,
    description: "A storyboard backed by tracked fixture bytes.",
    storyboard_image_artifact_id: artifactId,
    video_prompt: "Move slowly toward the product.",
    negative_prompt: "No deformation.",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  db.prepare(`INSERT INTO media_blobs
    (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, 'image/png', ?, 'verified', ?)`)
    .run(blobId, sha256, statSync(sourcePath).size, sourcePath, JSON.stringify({ media_root: dirname(sourcePath) }));
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)`)
    .run(artifactId, projectId, shotId, JSON.stringify({
      artifact_id: artifactId,
      blob_id: blobId,
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: sourcePath, mime_type: "image/png", filename: "shot_001_canary_720x1280.png" },
      metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256 },
      linked_objects: { project_id: projectId, shot_id: shotId },
      source: { kind: "fixture", provider: "mock", provider_job_id: "", sha256, external_url_host: "" }
    }));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(artifactId, blobId);

  const focusId = "director_focus_execution_001";
  db.prepare(`INSERT INTO director_focuses
    (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation, created_at, expires_at)
    VALUES (?, 'jenn-ai-video-workspace', ?, ?, 'shot', ?, 1, ?, ?)`)
    .run(focusId, principalId, projectId, shotId, firstNow.toISOString(), new Date(firstNow.getTime() + 60 * 60_000).toISOString());
  db.prepare(`INSERT INTO director_focus_events (event_id, focus_id, event_type, reason_code, created_at)
    VALUES ('director_focus_event_execution_001', ?, 'created', 'DIRECTOR_HUMAN_FOCUS_CREATED', ?)`)
    .run(focusId, firstNow.toISOString());
  const focusRow = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
    generation, supersedes_focus_id, created_at, expires_at FROM director_focuses WHERE focus_id = ?`).get(focusId) as Record<string, unknown>;
  const payload = {
    shot_id: shotId,
    provider: "runninghub" as const,
    model: "rhart-video-g/image-to-video",
    duration_seconds: 6,
    resolution: "480p",
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    continuity_constraints: [],
    estimated_cost_minor: 8,
    currency: "CNY"
  };
  const proposal = DIRECTOR_PROPOSAL_SCHEMA.parse({
    proposal_id: "director_proposal_execution_001",
    schema_version: "director-domain-v1",
    workspace_id: "jenn-ai-video-workspace",
    principal_id: principalId,
    project_id: projectId,
    target_type: "shot",
    target_id: shotId,
    focus_id: focusId,
    focus_generation: 1,
    base_state_hash: directorBaseStateHash(buildDirectorContext(db, DIRECTOR_FOCUS_SCHEMA.parse(focusRow), "generation_plan", "full").targetState),
    payload_hash: directorContentHash(payload),
    parent_proposal_id: null,
    idempotency_key: "director-execution-proposal-0001",
    source: "native",
    created_at: firstNow.toISOString(),
    kind: "generation_plan",
    payload
  });
  db.prepare(`INSERT INTO director_proposals
    (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
      schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id, idempotency_key, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(proposal.proposal_id, proposal.workspace_id, proposal.principal_id, proposal.project_id, proposal.target_type,
      proposal.target_id, proposal.focus_id, proposal.focus_generation, proposal.schema_version, proposal.kind,
      proposal.base_state_hash, JSON.stringify(proposal.payload), proposal.payload_hash, proposal.parent_proposal_id,
      proposal.idempotency_key, proposal.source, proposal.created_at);
  db.prepare(`INSERT INTO director_proposal_events (event_id, proposal_id, event_type, reason_code, created_at)
    VALUES ('director_proposal_event_execution_001', ?, 'submitted', 'DIRECTOR_NATIVE_SUBMITTED', ?)`)
    .run(proposal.proposal_id, firstNow.toISOString());
  return { projectId, proposal };
}

test("Human Workbench creates a single-owner Focus and records acceptance without compiling or executing", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Director approval fixture", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const projectId = created.data.project.project_id;
    bootstrapWebGptProjectOwner(db, principalId, projectId, "DIRECTOR_WORKBENCH_FIXTURE", issuerHash);

    const missingConfirmation = createDirectorWorkbenchFocus({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: false }, db, () => firstNow);
    assert.equal(missingConfirmation.ok, false);
    if (!missingConfirmation.ok) assert.equal(missingConfirmation.error.code, "DIRECTOR_FOCUS_CONFIRMATION_REQUIRED");

    const focused = createDirectorWorkbenchFocus({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: true }, db, () => firstNow);
    assert.equal(focused.ok, true);
    if (!focused.ok) return;
    const proposal = insertCreativeBriefProposal(db, {
      project_id: projectId,
      focus_id: focused.data.focus.focus_id,
      generation: focused.data.focus.generation,
      proposal_id: "director_proposal_workbench_001",
      idempotency_key: "director-workbench-proposal-0001",
      now: firstNow
    });
    const pending = getDirectorApprovalTower(projectId, db, () => firstNow);
    assert.equal(pending.ok, true, pending.ok ? "" : pending.error.code);
    if (!pending.ok) return;
    assert.equal(pending.data.principal_state, "single_owner_ready");
    assert.equal(pending.data.focus.state, "active");
    assert.equal(pending.data.proposals[0]?.status, "pending_review");
    assert.equal(JSON.stringify(pending.data).includes(principalId), false);

    const notConfirmed = decideDirectorProposal({ proposal_id: proposal.proposal_id, decision: "accept", human_confirmation: false }, db, () => firstNow);
    assert.equal(notConfirmed.ok, false);
    if (!notConfirmed.ok) assert.equal(notConfirmed.error.code, "DIRECTOR_PROPOSAL_CONFIRMATION_REQUIRED");

    const accepted = decideDirectorProposal({ proposal_id: proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => firstNow);
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
    if (!accepted.ok) return;
    assert.equal(accepted.data.proposal.status, "accepted");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_automation_grants").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_intents").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ? AND event_type = 'accepted'").get(proposal.proposal_id) as { count: number }).count, 1);
    const replay = decideDirectorProposal({ proposal_id: proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => firstNow);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.error.code, "DIRECTOR_PROPOSAL_NOT_PENDING");
  } finally { db.close(); }
});

test("an accepted current generation Proposal compiles exactly one immutable Automation Grant without an Intent, job, or Provider side effect", async () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Director grant fixture", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const projectId = created.data.project.project_id;
    bootstrapWebGptProjectOwner(db, principalId, projectId, "DIRECTOR_GRANT_FIXTURE", issuerHash);
    const focusId = "director_focus_grant_001";
    db.prepare(`INSERT INTO director_focuses
      (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation, created_at, expires_at)
      VALUES (?, 'jenn-ai-video-workspace', ?, ?, 'shot', 'shot_director_automation_001', 1, ?, ?)`)
      .run(focusId, principalId, projectId, firstNow.toISOString(), new Date(firstNow.getTime() + 60 * 60_000).toISOString());
    db.prepare(`INSERT INTO director_focus_events (event_id, focus_id, event_type, reason_code, created_at)
      VALUES ('director_focus_event_grant_001', ?, 'created', 'DIRECTOR_HUMAN_FOCUS_CREATED', ?)`)
      .run(focusId, firstNow.toISOString());
    const proposal = insertGenerationPlanProposal(db, {
      project_id: projectId, focus_id: focusId, generation: 1, proposal_id: "director_proposal_grant_001",
      idempotency_key: "director-grant-proposal-0001", now: firstNow
    });
    const accepted = decideDirectorProposal({ proposal_id: proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => firstNow);
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
    const noConfirmation = compileDirectorProposalToAutomationGrant({
      proposal_id: proposal.proposal_id, max_total_minor: 1_000, max_per_run_minor: 500, max_versions_per_shot: 2,
      max_automatic_retries: 1, expires_at: new Date(firstNow.getTime() + 60 * 60_000).toISOString(), human_confirmation: false
    }, db, () => firstNow);
    assert.equal(noConfirmation.ok, false);
    if (!noConfirmation.ok) assert.equal(noConfirmation.error.code, "DIRECTOR_GRANT_CONFIRMATION_REQUIRED");
    const compiled = compileDirectorProposalToAutomationGrant({
      proposal_id: proposal.proposal_id, max_total_minor: 1_000, max_per_run_minor: 500, max_versions_per_shot: 2,
      max_automatic_retries: 1, expires_at: new Date(firstNow.getTime() + 60 * 60_000).toISOString(), human_confirmation: true
    }, db, () => firstNow);
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.code);
    if (!compiled.ok) return;
    assert.equal(compiled.data.proposal.status, "compiled");
    assert.equal(compiled.data.grant.provider, "runninghub");
    assert.deepEqual(compiled.data.grant.allowed_actions, ["generation.submit", "generation.retry", "generation.download", "artifact.activate"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_automation_grants").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ? AND event_type = 'compiled' AND receipt_id = ?")
      .get(proposal.proposal_id, compiled.data.grant.grant_id) as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_intents").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get() as { count: number }).count, 0);
    const authorization = loadDirectorGrantAuthorization(db, {
      grant_id: compiled.data.grant.grant_id, proposal_id: proposal.proposal_id, policy_hash: compiled.data.grant.policy_hash
    }, "generation.submit", firstNow);
    const reservation = reserveDirectorGrant(db, authorization, {
      amount_minor: 500, currency: "CNY", intent_id: "intent_director_reservation_001", run_id: "run_director_reservation_001", now: firstNow
    });
    consumeDirectorGrantReservation(db, reservation, {
      amount_minor: 500, currency: "CNY", intent_id: "intent_director_reservation_001", run_id: "run_director_reservation_001", now: new Date(firstNow.getTime() + 2 * 60 * 60_000)
    });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_automation_grant_events WHERE grant_id = ? AND event_type = 'consume'")
      .get(compiled.data.grant.grant_id) as { count: number }).count, 1);
    const disabled = await startDirectorBoundedGeneration({
      grant_id: compiled.data.grant.grant_id, proposal_id: proposal.proposal_id, policy_hash: compiled.data.grant.policy_hash, account_label: "personal"
    }, db, { env: { REAL_PROVIDER_ENABLED: "false" }, now: () => firstNow });
    assert.equal(disabled.ok, false);
    if (!disabled.ok) assert.equal(disabled.error.code, "DIRECTOR_AUTOMATION_PROVIDER_DISABLED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_intents").get() as { count: number }).count, 0);
    assert.throws(() => db.prepare("UPDATE director_automation_grants SET max_total_minor = 2 WHERE grant_id = ?").run(compiled.data.grant.grant_id), /DIRECTOR_AUTOMATION_GRANT_IMMUTABLE/);
    db.prepare(`UPDATE webgpt_project_memberships SET role = 'viewer'
      WHERE workspace_id = 'jenn-ai-video-workspace' AND principal_id = ? AND project_id = ?`).run(principalId, projectId);
    assert.throws(
      () => loadDirectorGrantAuthorization(db, {
        grant_id: compiled.data.grant.grant_id, proposal_id: proposal.proposal_id, policy_hash: compiled.data.grant.policy_hash
      }, "generation.submit", firstNow),
      (caught: unknown) => caught instanceof Error && "code" in caught
        && (caught as { code?: unknown }).code === "DIRECTOR_AUTOMATION_OWNER_REQUIRED"
    );
    const replay = compileDirectorProposalToAutomationGrant({
      proposal_id: proposal.proposal_id, max_total_minor: 1_000, max_per_run_minor: 500, max_versions_per_shot: 2,
      max_automatic_retries: 1, expires_at: new Date(firstNow.getTime() + 60 * 60_000).toISOString(), human_confirmation: true
    }, db, () => firstNow);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.error.code, "DIRECTOR_PROPOSAL_ALREADY_COMPILED");
  } finally { db.close(); }
});

test("a bounded Director start reserves the official decimal price in minor units without submitting a Provider task", async () => {
  const db = openM0Database(":memory:");
  try {
    const fixture = prepareRunnableDirectorGenerationFixture(db);
    const accepted = decideDirectorProposal({ proposal_id: fixture.proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => firstNow);
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
    const compiled = compileDirectorProposalToAutomationGrant({
      proposal_id: fixture.proposal.proposal_id,
      max_total_minor: 500,
      max_per_run_minor: 500,
      max_versions_per_shot: 2,
      max_automatic_retries: 0,
      expires_at: new Date(firstNow.getTime() + 60 * 60_000).toISOString(),
      human_confirmation: true
    }, db, () => firstNow);
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.code);
    if (!compiled.ok) return;
    let officialCalls = 0;
    const execution = await startDirectorBoundedGeneration({
      grant_id: compiled.data.grant.grant_id,
      proposal_id: fixture.proposal.proposal_id,
      policy_hash: compiled.data.grant.policy_hash,
      account_label: "personal",
      start_worker: false
    }, db, {
      now: () => firstNow,
      env: {
        REAL_PROVIDER_ENABLED: "true",
        M1_REAL_PROVIDER: "runninghub",
        M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
        M1_REAL_PROVIDER_COST_ACK: "true",
        RUNNINGHUB_API_KEY: "synthetic-test-key"
      },
      fetch_impl: async (input) => {
        officialCalls += 1;
        return String(input).includes("price-preview")
          ? new Response(JSON.stringify({ errorCode: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200 })
          : new Response(JSON.stringify({ code: 0, data: { remainMoney: "10", currency: "CNY" } }), { status: 200 });
      }
    });
    assert.equal(execution.ok, true, execution.ok ? "" : execution.error.code);
    if (!execution.ok) return;
    assert.equal(officialCalls, 2);
    assert.equal(execution.data.intent.status, "queued");
    assert.equal(execution.data.intent.estimated_cost_value, 0.08);
    assert.equal(execution.data.intent.budget_limit_value, 5);
    assert.equal(execution.data.intent.input_snapshot.director_automation?.amount_minor, 8);
    const reservation = db.prepare(`SELECT amount_minor, currency, event_type FROM director_automation_grant_events
      WHERE grant_id = ? AND event_type = 'reserve'`).get(compiled.data.grant.grant_id) as { amount_minor: number; currency: string; event_type: string };
    assert.equal(reservation.amount_minor, 8);
    assert.equal(reservation.currency, "CNY");
    assert.equal(reservation.event_type, "reserve");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM generation_jobs WHERE state = 'queued'").get() as { count: number }).count, 1);
  } finally { db.close(); }
});

test("a malformed Director-prepared intent fails closed before provider selection", async () => {
  const db = openM0Database(":memory:");
  try {
    const fixture = prepareRunnableDirectorGenerationFixture(db);
    const accepted = decideDirectorProposal({ proposal_id: fixture.proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => firstNow);
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
    const compiled = compileDirectorProposalToAutomationGrant({
      proposal_id: fixture.proposal.proposal_id,
      max_total_minor: 500,
      max_per_run_minor: 500,
      max_versions_per_shot: 2,
      max_automatic_retries: 0,
      expires_at: new Date(firstNow.getTime() + 60 * 60_000).toISOString(),
      human_confirmation: true
    }, db, () => firstNow);
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.code);
    if (!compiled.ok) return;
    const env: NodeJS.ProcessEnv = {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runninghub",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNNINGHUB_API_KEY: "synthetic-test-key"
    };
    const fetchImpl: typeof fetch = async (input) => String(input).includes("price-preview")
      ? new Response(JSON.stringify({ errorCode: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { remainMoney: "10", currency: "CNY" } }), { status: 200 });
    const execution = await startDirectorBoundedGeneration({
      grant_id: compiled.data.grant.grant_id,
      proposal_id: fixture.proposal.proposal_id,
      policy_hash: compiled.data.grant.policy_hash,
      account_label: "personal",
      start_worker: false
    }, db, { now: () => firstNow, env, fetch_impl: fetchImpl });
    assert.equal(execution.ok, true, execution.ok ? "" : execution.error.code);
    if (!execution.ok) return;

    const row = db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?").get(execution.data.intent.intent_id) as { data_json: string };
    const data = JSON.parse(row.data_json) as { input_snapshot: { director_automation?: Record<string, unknown> } };
    delete data.input_snapshot.director_automation?.reservation_id;
    db.prepare("UPDATE generation_intents SET data_json = ? WHERE intent_id = ?").run(JSON.stringify(data), execution.data.intent.intent_id);
    let providerCalls = 0;
    const workerDatabase = new Proxy(db, {
      get(target, property) {
        if (property === "close") return () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReturnType<typeof openM0Database>;
    await runWorkbenchGenerationOnce(execution.data.intent.intent_id, {
      allow_submit: true,
      dependencies: {
        open_database: () => workerDatabase,
        env,
        fetch_impl: fetchImpl,
        adapter_factory: () => {
          providerCalls += 1;
          throw new Error("provider adapter must not be created for malformed Director binding");
        },
        now: () => firstNow
      }
    });
    assert.equal(providerCalls, 0);
    const terminal = db.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?").get(execution.data.intent.intent_id) as { status: string; sanitized_error_json: string };
    assert.equal(terminal.status, "failed");
    assert.equal(JSON.parse(terminal.sanitized_error_json).code, "DIRECTOR_AUTOMATION_BINDING_MISMATCH");
  } finally { db.close(); }
});

test("a Director Grant retries only known no-submit failures and stops exactly at its retry limit", async () => {
  const db = openM0Database(":memory:");
  try {
    const fixture = prepareRunnableDirectorGenerationFixture(db);
    const accepted = decideDirectorProposal({ proposal_id: fixture.proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => firstNow);
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
    const compiled = compileDirectorProposalToAutomationGrant({
      proposal_id: fixture.proposal.proposal_id,
      max_total_minor: 500,
      max_per_run_minor: 500,
      max_versions_per_shot: 2,
      max_automatic_retries: 1,
      expires_at: new Date(firstNow.getTime() + 60 * 60_000).toISOString(),
      human_confirmation: true
    }, db, () => firstNow);
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.code);
    if (!compiled.ok) return;

    const env: NodeJS.ProcessEnv = {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runninghub",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true",
      RUNNINGHUB_API_KEY: "synthetic-test-key"
    };
    const fetchImpl: typeof fetch = async (input) => String(input).includes("price-preview")
      ? new Response(JSON.stringify({ errorCode: "", estimatedPrice: 0.08, currency: "CNY" }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { remainMoney: "10", currency: "CNY" } }), { status: 200 });
    const execution = await startDirectorBoundedGeneration({
      grant_id: compiled.data.grant.grant_id,
      proposal_id: fixture.proposal.proposal_id,
      policy_hash: compiled.data.grant.policy_hash,
      account_label: "personal",
      start_worker: false
    }, db, { now: () => firstNow, env, fetch_impl: fetchImpl });
    assert.equal(execution.ok, true, execution.ok ? "" : execution.error.code);
    if (!execution.ok) return;

    let submitCalls = 0;
    const adapter = {
      provider_name: "runninghub" as const,
      model_name: "rhart-video-g/image-to-video",
      submitGeneration: async () => {
        submitCalls += 1;
        return submitCalls === 1
          ? { ok: false as const, error: { code: "PROVIDER_TEMPORARY", message: "Temporary known failure.", retryable: true } }
          : { ok: false as const, error: { code: "PROVIDER_REJECTED", message: "Terminal fixture failure.", retryable: false } };
      },
      pollStatus: async () => { throw new Error("poll must not run for a known no-submit retry test"); },
      fetchOutput: async () => { throw new Error("output must not run for a known no-submit retry test"); }
    };
    // executeIntent owns its database lifecycle. This no-close facade retains
    // the in-memory fixture only for this deterministic unit test.
    const workerDatabase = new Proxy(db, {
      get(target, property) {
        if (property === "close") return () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReturnType<typeof openM0Database>;
    const dependencies = {
      open_database: () => workerDatabase,
      env,
      fetch_impl: fetchImpl,
      adapter_factory: () => adapter,
      now: () => firstNow,
      poll_interval_ms: 10
    };
    await runWorkbenchGenerationOnce(execution.data.intent.intent_id, { allow_submit: true, dependencies });
    const afterFirst = db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?").get(execution.data.job_id) as { state: string; reconciliation_reason: string };
    assert.equal(afterFirst.state, "queued");
    assert.equal(afterFirst.reconciliation_reason, "DIRECTOR_AUTOMATION_SUBMIT_RETRY");
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM generation_job_events
      WHERE job_id = ? AND reason_code = 'DIRECTOR_AUTOMATION_SUBMIT_RETRY'`).get(execution.data.job_id) as { count: number }).count, 1);

    await runWorkbenchGenerationOnce(execution.data.intent.intent_id, { allow_submit: true, dependencies });
    assert.equal(submitCalls, 2);
    const terminal = db.prepare("SELECT status FROM generation_intents WHERE intent_id = ?").get(execution.data.intent.intent_id) as { status: string };
    assert.equal(terminal.status, "failed");
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM director_automation_grant_events
      WHERE grant_id = ? AND event_type = 'consume'`).get(compiled.data.grant.grant_id) as { count: number }).count, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM director_automation_grant_events
      WHERE grant_id = ? AND event_type = 'release'`).get(compiled.data.grant.grant_id) as { count: number }).count, 1);
  } finally { db.close(); }
});

test("superseded Focus and authoritative drift block human acceptance without rewriting proposal history", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Director stale fixture", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const projectId = created.data.project.project_id;
    bootstrapWebGptProjectOwner(db, principalId, projectId, "DIRECTOR_WORKBENCH_STALE", issuerHash);
    const focus = createDirectorWorkbenchFocus({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: true }, db, () => firstNow);
    assert.equal(focus.ok, true);
    if (!focus.ok) return;
    const staleProposal = insertCreativeBriefProposal(db, {
      project_id: projectId, focus_id: focus.data.focus.focus_id, generation: focus.data.focus.generation,
      proposal_id: "director_proposal_stale_focus", idempotency_key: "director-workbench-proposal-0002", now: firstNow
    });
    const replacement = createDirectorWorkbenchFocus({ project_id: projectId, target_type: "memory", target_id: projectId, human_confirmation: true }, db, () => new Date(firstNow.getTime() + 1_000));
    assert.equal(replacement.ok, true);
    const staleDecision = decideDirectorProposal({ proposal_id: staleProposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => new Date(firstNow.getTime() + 2_000));
    assert.equal(staleDecision.ok, false);
    if (!staleDecision.ok) assert.equal(staleDecision.error.code, "DIRECTOR_FOCUS_STALE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ?").get(staleProposal.proposal_id) as { count: number }).count, 1);

    const newFocus = createDirectorWorkbenchFocus({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: true }, db, () => new Date(firstNow.getTime() + 3_000));
    assert.equal(newFocus.ok, true);
    if (!newFocus.ok) return;
    const driftProposal = insertCreativeBriefProposal(db, {
      project_id: projectId, focus_id: newFocus.data.focus.focus_id, generation: newFocus.data.focus.generation,
      proposal_id: "director_proposal_state_drift", idempotency_key: "director-workbench-proposal-0003", now: new Date(firstNow.getTime() + 3_000)
    });
    const changed = created.data.project;
    changed.brief = { creative_direction: "A different approved direction." };
    saveProject(db, changed);
    const driftDecision = decideDirectorProposal({ proposal_id: driftProposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => new Date(firstNow.getTime() + 4_000));
    assert.equal(driftDecision.ok, false);
    if (!driftDecision.ok) assert.equal(driftDecision.error.code, "DIRECTOR_PROPOSAL_STALE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ? AND event_type = 'accepted'").get(driftProposal.proposal_id) as { count: number }).count, 0);
  } finally { db.close(); }
});

test("revoked proposal membership blocks a pending Director decision without creating a terminal event", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Director revocation fixture", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const projectId = created.data.project.project_id;
    bootstrapWebGptProjectOwner(db, principalId, projectId, "DIRECTOR_WORKBENCH_REVOKED", issuerHash);
    const focus = createDirectorWorkbenchFocus({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: true }, db, () => firstNow);
    assert.equal(focus.ok, true);
    if (!focus.ok) return;
    const proposal = insertCreativeBriefProposal(db, {
      project_id: projectId, focus_id: focus.data.focus.focus_id, generation: focus.data.focus.generation,
      proposal_id: "director_proposal_revoked_membership", idempotency_key: "director-workbench-proposal-0004", now: firstNow
    });
    db.prepare(`UPDATE webgpt_project_memberships SET status = 'revoked'
      WHERE workspace_id = ? AND principal_id = ? AND project_id = ?`)
      .run("jenn-ai-video-workspace", principalId, projectId);
    const blocked = decideDirectorProposal({ proposal_id: proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => new Date(firstNow.getTime() + 1_000));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "DIRECTOR_PROPOSAL_PRINCIPAL_INACTIVE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ?").get(proposal.proposal_id) as { count: number }).count, 1);
  } finally { db.close(); }
});

test("owner demotion or owner ambiguity blocks a pending Director decision without appending a terminal event", () => {
  const db = openM0Database(":memory:");
  try {
    const demoted = createWorkbenchProject({ title: "Director owner demotion fixture", classification: "production" }, db);
    assert.equal(demoted.ok, true);
    if (!demoted.ok) return;
    const demotedProjectId = demoted.data.project.project_id;
    bootstrapWebGptProjectOwner(db, principalId, demotedProjectId, "DIRECTOR_WORKBENCH_OWNER_DEMOTION", issuerHash);
    const demotedFocus = createDirectorWorkbenchFocus({ project_id: demotedProjectId, target_type: "project", target_id: demotedProjectId, human_confirmation: true }, db, () => firstNow);
    assert.equal(demotedFocus.ok, true);
    if (!demotedFocus.ok) return;
    const demotedProposal = insertCreativeBriefProposal(db, {
      project_id: demotedProjectId, focus_id: demotedFocus.data.focus.focus_id, generation: demotedFocus.data.focus.generation,
      proposal_id: "director_proposal_owner_demoted", idempotency_key: "director-workbench-proposal-owner-0001", now: firstNow
    });
    db.prepare(`UPDATE webgpt_project_memberships SET role = 'viewer'
      WHERE workspace_id = ? AND principal_id = ? AND project_id = ?`)
      .run("jenn-ai-video-workspace", principalId, demotedProjectId);
    const demotionBlocked = decideDirectorProposal({ proposal_id: demotedProposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => new Date(firstNow.getTime() + 1_000));
    assert.equal(demotionBlocked.ok, false);
    if (!demotionBlocked.ok) assert.equal(demotionBlocked.error.code, "DIRECTOR_PROPOSAL_OWNER_REQUIRED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ?").get(demotedProposal.proposal_id) as { count: number }).count, 1);

    const ambiguous = createWorkbenchProject({ title: "Director owner ambiguity fixture", classification: "production" }, db);
    assert.equal(ambiguous.ok, true);
    if (!ambiguous.ok) return;
    const ambiguousProjectId = ambiguous.data.project.project_id;
    bootstrapWebGptProjectOwner(db, principalId, ambiguousProjectId, "DIRECTOR_WORKBENCH_OWNER_AMBIGUITY", issuerHash);
    const ambiguousFocus = createDirectorWorkbenchFocus({ project_id: ambiguousProjectId, target_type: "project", target_id: ambiguousProjectId, human_confirmation: true }, db, () => firstNow);
    assert.equal(ambiguousFocus.ok, true);
    if (!ambiguousFocus.ok) return;
    const ambiguousProposal = insertCreativeBriefProposal(db, {
      project_id: ambiguousProjectId, focus_id: ambiguousFocus.data.focus.focus_id, generation: ambiguousFocus.data.focus.generation,
      proposal_id: "director_proposal_owner_ambiguous", idempotency_key: "director-workbench-proposal-owner-0002", now: firstNow
    });
    bootstrapWebGptProjectOwner(db, "f".repeat(64), ambiguousProjectId, "DIRECTOR_WORKBENCH_SECOND_OWNER", "c".repeat(64));
    const ambiguityBlocked = decideDirectorProposal({ proposal_id: ambiguousProposal.proposal_id, decision: "reject", human_confirmation: true }, db, () => new Date(firstNow.getTime() + 1_000));
    assert.equal(ambiguityBlocked.ok, false);
    if (!ambiguityBlocked.ok) assert.equal(ambiguityBlocked.error.code, "DIRECTOR_PROPOSAL_OWNER_REQUIRED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ?").get(ambiguousProposal.proposal_id) as { count: number }).count, 1);
  } finally { db.close(); }
});

test("archived projects reject a pending Director decision after the approval page was opened", () => {
  const db = openM0Database(":memory:");
  try {
    const created = createWorkbenchProject({ title: "Director archived fixture", classification: "production" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const projectId = created.data.project.project_id;
    bootstrapWebGptProjectOwner(db, principalId, projectId, "DIRECTOR_WORKBENCH_ARCHIVED", issuerHash);
    const focus = createDirectorWorkbenchFocus({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: true }, db, () => firstNow);
    assert.equal(focus.ok, true);
    if (!focus.ok) return;
    const proposal = insertCreativeBriefProposal(db, {
      project_id: projectId, focus_id: focus.data.focus.focus_id, generation: focus.data.focus.generation,
      proposal_id: "director_proposal_archived_project", idempotency_key: "director-workbench-proposal-0005", now: firstNow
    });
    db.prepare("UPDATE workbench_project_meta SET lifecycle = 'archived' WHERE project_id = ?").run(projectId);
    const blocked = decideDirectorProposal({ proposal_id: proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => new Date(firstNow.getTime() + 1_000));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "DIRECTOR_PROJECT_NOT_AVAILABLE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ?").get(proposal.proposal_id) as { count: number }).count, 1);
  } finally { db.close(); }
});

test("Human Workbench Director endpoints require the local mutation nonce and confirmation", async (t) => {
  const nonce = "director-workbench-api-nonce";
  const db = openM0Database();
  const created = createWorkbenchProject({ title: "Director API fixture", classification: "production" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) { db.close(); return; }
  const projectId = created.data.project.project_id;
  bootstrapWebGptProjectOwner(db, principalId, projectId, "DIRECTOR_WORKBENCH_API", issuerHash);
  db.close();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void handleWorkbenchV2Api(request, response, url, nonce).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const body = JSON.stringify({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: true });
  const noNonce = await fetch(`${base}/api/v2/director/focus`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(noNonce.status, 403);
  const unconfirmed = await fetch(`${base}/api/v2/director/focus`, {
    method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce },
    body: JSON.stringify({ project_id: projectId, target_type: "project", target_id: projectId, human_confirmation: false })
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json() as { error: { code: string } }).error.code, "DIRECTOR_FOCUS_CONFIRMATION_REQUIRED");
  const focused = await fetch(`${base}/api/v2/director/focus`, { method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce }, body });
  assert.equal(focused.status, 200);
  const startBody = JSON.stringify({ proposal_id: "director_proposal_missing", policy_hash: "a".repeat(64), human_confirmation: true });
  const noStartNonce = await fetch(`${base}/api/v2/director/grants/director_grant_missing/start`, { method: "POST", headers: { "content-type": "application/json" }, body: startBody });
  assert.equal(noStartNonce.status, 403);
  const unconfirmedStart = await fetch(`${base}/api/v2/director/grants/director_grant_missing/start`, {
    method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce },
    body: JSON.stringify({ proposal_id: "director_proposal_missing", policy_hash: "a".repeat(64), human_confirmation: false })
  });
  assert.equal(unconfirmedStart.status, 400);
  assert.equal((await unconfirmedStart.json() as { error: { code: string } }).error.code, "DIRECTOR_AUTOMATION_START_CONFIRMATION_REQUIRED");
  const invalidDecision = await fetch(`${base}/api/v2/director/proposals/director_proposal_missing/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce },
    body: JSON.stringify({ decision: "approve_everything", human_confirmation: true })
  });
  assert.equal(invalidDecision.status, 400);
  assert.equal((await invalidDecision.json() as { error: { code: string } }).error.code, "DIRECTOR_PROPOSAL_DECISION_INVALID");
  const queue = await fetch(`${base}/api/v2/director/projects/${encodeURIComponent(projectId)}`);
  assert.equal(queue.status, 200);
  const payload = await queue.json() as { ok: boolean; data: { focus: { state: string }; principal_state: string } };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.focus.state, "active");
  assert.equal(payload.data.principal_state, "single_owner_ready");
});
