import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildDirectorContext } from "../src/director/localService.js";
import { directorBaseStateHash, directorContentHash, DIRECTOR_FOCUS_SCHEMA, DIRECTOR_PROPOSAL_SCHEMA } from "../src/director/domain.js";
import {
  createDirectorWorkbenchFocus,
  decideDirectorProposal,
  getDirectorApprovalTower
} from "../src/director/workbenchApproval.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { saveProject } from "../src/tools/projects.js";
import { createWorkbenchProject } from "../src/tools/workbenchV2.js";
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
