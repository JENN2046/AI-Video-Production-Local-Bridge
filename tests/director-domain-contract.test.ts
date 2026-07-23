import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIRECTOR_DOMAIN_SCHEMA_VERSION,
  DIRECTOR_PROPOSAL_DRAFT_SCHEMA,
  directorBaseStateHash,
  directorContentHash,
  finalizeDirectorAutomationGrant,
  finalizeStoryboardPackageV2,
  validateDirectorAutomationGrant,
  validateDirectorProposal,
  validateDirectorProposalAgainstTargetState,
  validateStoryboardPackageV2,
  type DirectorAutomationGrantUnsigned,
  type DirectorTargetStateV1
} from "../src/director/domain.js";
import { directorMinorToProviderAmount, directorProviderAmountToMinor } from "../src/director/currency.js";
import { deriveDirectorOperationalState } from "../src/packages/domain/operationalState.js";
import { checkDatabase } from "../src/storage/databaseGovernance.js";
import { assertSchemaCurrent, DATABASE_MIGRATIONS, migrationChecksum, runDatabaseMigrations } from "../src/storage/migrations.js";
import { WORKBENCH_V2_SCHEMA_VERSION } from "../src/storage/workbenchV2Schema.js";

const principalId = "a".repeat(64);
const hash = (value: string): string => directorContentHash(value);
const HISTORICAL_MIGRATION_0009_CHECKSUM = "7ccfa5f3302bbb3a35d6c9a21846bcaf2f1cf904dcb6ad1344d8f03999e1d0d7";

function targetState(): DirectorTargetStateV1 {
  return {
    schema_version: DIRECTOR_DOMAIN_SCHEMA_VERSION,
    proposal_kind: "storyboard_revision",
    project: {
      project_id: "project_director",
      status: "storyboard_approved",
      lifecycle_state: "active",
      video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "1080x1920" },
      creative_direction_hash: hash("creative"),
      current_storyboard_package_id: "package_v1",
      current_storyboard_package_hash: hash("package-v1")
    },
    target_shot: {
      shot_id: "shot_002",
      project_id: "project_director",
      order: 2,
      status: "storyboard_approved",
      duration_seconds: 5,
      storyboard_artifact_id: "artifact_storyboard_002",
      storyboard_artifact_sha256: hash("storyboard-002"),
      accepted_clip_artifact_id: null,
      accepted_clip_artifact_sha256: null,
      prompt_hash: hash("prompt"),
      negative_prompt_hash: hash("negative"),
      continuity_hash: hash("continuity"),
      current_generation_input_hash: null,
      current_review_decision_event_id: null
    },
    adjacent_shots: [{
      shot_id: "shot_001",
      project_id: "project_director",
      order: 1,
      status: "storyboard_approved",
      duration_seconds: 5,
      storyboard_artifact_id: "artifact_storyboard_001",
      storyboard_artifact_sha256: hash("storyboard-001"),
      accepted_clip_artifact_id: null,
      accepted_clip_artifact_sha256: null,
      prompt_hash: hash("prompt-1"),
      negative_prompt_hash: hash("negative-1"),
      continuity_hash: hash("continuity-1"),
      current_generation_input_hash: null,
      current_review_decision_event_id: null
    }],
    target_artifact: {
      artifact_id: "artifact_storyboard_002",
      project_id: "project_director",
      shot_id: "shot_002",
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      sha256: hash("storyboard-002")
    },
    generation: { prepared_intent_id: null, frozen_input_hash: null, latest_run_id: null, latest_job_state: null }
  };
}

test("director base-state hash uses deterministic JCS and changes with authoritative inputs", () => {
  const state = targetState();
  const reordered = {
    generation: state.generation,
    adjacent_shots: state.adjacent_shots,
    target_artifact: state.target_artifact,
    target_shot: state.target_shot,
    project: state.project,
    proposal_kind: state.proposal_kind,
    schema_version: state.schema_version
  } as DirectorTargetStateV1;
  assert.equal(directorBaseStateHash(state), directorBaseStateHash(reordered));
  assert.notEqual(directorBaseStateHash(state), directorBaseStateHash({
    ...state,
    target_shot: { ...state.target_shot!, duration_seconds: 6 }
  }));
  assert.throws(() => directorBaseStateHash({
    ...state,
    adjacent_shots: [state.target_shot!]
  }), /Adjacent SHOTs must not repeat/);
  assert.throws(() => directorBaseStateHash({
    ...state,
    target_artifact: { ...state.target_artifact!, shot_id: "shot_other" }
  }), /Target Artifact must belong to the target SHOT/);
  assert.throws(() => directorBaseStateHash({
    ...state,
    target_artifact: { ...state.target_artifact!, shot_id: null }
  }), /Target Artifact must belong to the target SHOT/);
  assert.throws(() => directorBaseStateHash({
    ...state,
    target_shot: { ...state.target_shot!, storyboard_artifact_sha256: null }
  }), /must be present or absent together/);
  assert.throws(() => directorBaseStateHash({
    ...state,
    target_artifact: { ...state.target_artifact!, artifact_type: "video" }
  }), /requires type image/);
});

test("director proposal contract is kind-specific and review assessment remains advisory", () => {
  const reviewState: DirectorTargetStateV1 = {
    ...targetState(),
    proposal_kind: "review_assessment",
    target_artifact: {
      artifact_id: "artifact_clip_002",
      project_id: "project_director",
      shot_id: "shot_002",
      artifact_type: "video",
      role: "generated_clip",
      status: "active",
      sha256: hash("clip-002")
    }
  };
  const payload = {
    shot_id: "shot_002",
    artifact_id: "artifact_clip_002",
    diagnosis: "The product rotates after contact.",
    evidence: [{ timestamp_seconds: 0.75, observation: "Unexpected product rotation begins." }],
    recommended_disposition: "regenerate",
    prompt_delta: "Keep the product facing camera.",
    continuity_delta: ["Product proportions remain fixed."],
    confidence: 0.9
  };
  const proposal = validateDirectorProposal({
    proposal_id: "proposal_director_001",
    schema_version: DIRECTOR_DOMAIN_SCHEMA_VERSION,
    workspace_id: "jenn-ai-video-workspace",
    principal_id: principalId,
    project_id: "project_director",
    target_type: "artifact",
    target_id: "artifact_clip_002",
    focus_id: "focus_director_001",
    focus_generation: 1,
    base_state_hash: directorBaseStateHash(reviewState),
    payload_hash: directorContentHash(payload),
    parent_proposal_id: null,
    idempotency_key: "director-review-0001",
    source: "native",
    created_at: "2026-07-22T00:00:00.000Z",
    kind: "review_assessment",
    payload
  });
  assert.equal(proposal.kind, "review_assessment");
  assert.equal(validateDirectorProposalAgainstTargetState(proposal, reviewState).target_state.target_artifact?.artifact_id, "artifact_clip_002");
  assert.equal("approval_status" in proposal.payload, false);
  assert.throws(() => validateDirectorProposal({ ...proposal, payload_hash: "b".repeat(64) }), /DIRECTOR_PROPOSAL_PAYLOAD_HASH_MISMATCH/);
  assert.throws(() => validateDirectorProposal({
    ...proposal,
    payload: { ...payload, approval_status: "approved" },
    payload_hash: directorContentHash({ ...payload, approval_status: "approved" })
  }));
  assert.throws(() => validateDirectorProposal({ ...proposal, target_id: "artifact_other" }), /not bound to its payload target/);
  assert.throws(
    () => validateDirectorProposalAgainstTargetState(proposal, { ...reviewState, target_artifact: { ...reviewState.target_artifact!, sha256: hash("drift") } }),
    /BASE_STATE_MISMATCH/
  );
  assert.throws(
    () => validateDirectorProposalAgainstTargetState(proposal, { ...reviewState, target_artifact: { ...reviewState.target_artifact!, artifact_id: "artifact_other" } }),
    /BASE_STATE_MISMATCH|TARGET_STATE_MISMATCH/
  );
});

test("Storyboard Package V2 is content-addressed and preserves continuity semantics", () => {
  const base = {
    schema_version: "storyboard-package-v2" as const,
    package_version_id: "storyboard_package_version_001",
    project_id: "project_director",
    version: 1,
    supersedes_package_version_id: null,
    initial_state: "draft_candidate" as const,
    video_spec: { duration_seconds: 5, aspect_ratio: "9:16", resolution: "1080x1920" },
    creative_direction_hash: hash("creative"),
    shots: [{
      shot_id: "shot_001",
      order: 1,
      storyboard_artifact_id: "artifact_storyboard_001",
      artifact_sha256: hash("storyboard"),
      storyboard_prompt: "Worker reaches for the product.",
      negative_prompt: "No deformation.",
      composition_notes: "Product remains centered.",
      continuity_constraints: ["Product proportions remain fixed."],
      duration_seconds: 5,
      camera_motion: "Subtle handheld drift.",
      generation_constraints: ["No product rotation."]
    }],
    created_from_proposal_id: null,
    created_at: "2026-07-22T00:00:00.000Z"
  };
  const finalized = finalizeStoryboardPackageV2(base);
  assert.equal(finalized.content_hash, directorContentHash(base));
  assert.deepEqual(validateStoryboardPackageV2(finalized), finalized);
  assert.throws(() => validateStoryboardPackageV2({ ...finalized, content_hash: "b".repeat(64) }), /CONTENT_HASH_MISMATCH/);
  assert.deepEqual(finalized.shots[0].continuity_constraints, ["Product proportions remain fixed."]);
  assert.throws(() => finalizeStoryboardPackageV2({ ...base, shots: [...base.shots, { ...base.shots[0] }] }), /Duplicate SHOT/);
});

test("Automation Grant is content-addressed, bounded, and immutable by replacement", () => {
  const unsigned: DirectorAutomationGrantUnsigned = {
    grant_id: "grant_director_contract_001",
    workspace_id: "jenn-ai-video-workspace" as const,
    principal_id: principalId,
    project_id: "project_director",
    provider: "runninghub" as const,
    allowed_actions: ["generation.submit", "generation.retry", "generation.download"],
    currency: "CNY",
    max_total_minor: 10_000,
    max_per_run_minor: 1_000,
    max_versions_per_shot: 3,
    max_automatic_retries: 1,
    pricing_contract_version: "pricing-v1",
    capability_contract_version: "capability-v1",
    starts_at: "2026-07-22T00:00:00.000Z",
    expires_at: "2026-07-23T00:00:00.000Z",
    created_at: "2026-07-22T00:00:00.000Z"
  };
  const grant = finalizeDirectorAutomationGrant(unsigned);
  assert.deepEqual(validateDirectorAutomationGrant(grant), grant);
  assert.throws(() => validateDirectorAutomationGrant({ ...grant, max_total_minor: 20_000 }), /POLICY_HASH_MISMATCH/);
  assert.throws(() => finalizeDirectorAutomationGrant({ ...unsigned, allowed_actions: ["generation.submit", "generation.submit"] }), /must be unique/);
  assert.throws(() => finalizeDirectorAutomationGrant({ ...unsigned, allowed_actions: ["generation.submit"], max_automatic_retries: 1 }), /retry action must exactly match/);
  assert.throws(() => finalizeDirectorAutomationGrant({ ...unsigned, max_automatic_retries: 0 }), /retry action must exactly match/);
  const coinsGrant = finalizeDirectorAutomationGrant({ ...unsigned, currency: "RH_COINS" });
  assert.equal(coinsGrant.currency, "RH_COINS");
  assert.equal(directorProviderAmountToMinor(12, "RH_COINS"), 12);
  assert.equal(directorMinorToProviderAmount(12, "RH_COINS"), 12);
  assert.throws(() => finalizeDirectorAutomationGrant({ ...unsigned, currency: "USD" } as unknown as DirectorAutomationGrantUnsigned), /Invalid option/);
  const coinsPlan = {
    kind: "generation_plan",
    payload: {
      shot_id: "shot_002",
      provider: "runninghub",
      model: "rhart-video-g/image-to-video",
      duration_seconds: 5,
      resolution: "1080x1920",
      video_prompt: "Keep the product stable.",
      negative_prompt: "No deformation.",
      continuity_constraints: [],
      estimated_cost_minor: 12,
      currency: "RH_COINS"
    }
  } as const;
  const parsedCoinsPlan = DIRECTOR_PROPOSAL_DRAFT_SCHEMA.parse(coinsPlan);
  assert.equal(parsedCoinsPlan.kind, "generation_plan");
  if (parsedCoinsPlan.kind !== "generation_plan") throw new Error("Expected a generation plan.");
  assert.equal(parsedCoinsPlan.payload.currency, "RH_COINS");
  assert.throws(() => DIRECTOR_PROPOSAL_DRAFT_SCHEMA.parse({
    ...coinsPlan,
    payload: { ...coinsPlan.payload, currency: "USD" }
  }), /Invalid option/);
});

test("director operational state is derived with exception and human gates taking priority", () => {
  const idle = deriveDirectorOperationalState({
    pending_proposal_count: 0,
    accepted_uncompiled_proposal_count: 0,
    active_grant_count: 0,
    automation_running_count: 0,
    director_input_required_count: 0,
    exception_count: 0
  });
  assert.deepEqual({ phase: idle.director_phase, gate: idle.next_human_gate }, { phase: "idle", gate: "none" });

  const awaitingBudget = deriveDirectorOperationalState({ ...idle, accepted_uncompiled_proposal_count: 1 });
  assert.deepEqual({ phase: awaitingBudget.director_phase, gate: awaitingBudget.next_human_gate }, {
    phase: "human_approval_required",
    gate: "budget_authorization"
  });

  const exception = deriveDirectorOperationalState({ ...awaitingBudget, automation_running_count: 1, exception_count: 1 });
  assert.deepEqual({ phase: exception.director_phase, gate: exception.next_human_gate }, {
    phase: "exception",
    gate: "exception_resolution"
  });
  assert.throws(() => deriveDirectorOperationalState({ ...idle, pending_proposal_count: -1 }), /DIRECTOR_OPERATIONAL_FACT_INVALID/);
});

test("migrations 0009 through 0011 upgrade a real 0008 shape and make Director evidence immutable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 8)) migration.apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertMigration = db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 8)) {
      insertMigration.run(migration.id, migration.name, migrationChecksum(migration));
    }

    assert.deepEqual(runDatabaseMigrations(db).applied, ["0009", "0010", "0011"]);
    assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, WORKBENCH_V2_SCHEMA_VERSION);

    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)").run("project_director", JSON.stringify({ project_id: "project_director" }));
    db.prepare("INSERT INTO webgpt_auth_principals (workspace_id, principal_id) VALUES ('jenn-ai-video-workspace', ?)").run(principalId);
    db.prepare(`INSERT INTO director_focuses
      (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation, created_at, expires_at)
      VALUES ('focus_director_001', 'jenn-ai-video-workspace', ?, 'project_director', 'project', 'project_director', 1,
        '2026-07-22T00:00:00.000Z', '2026-07-22T02:00:00.000Z')`).run(principalId);
    assert.throws(() => db.prepare("UPDATE director_focuses SET target_id = 'other' WHERE focus_id = 'focus_director_001'").run(), /DIRECTOR_FOCUS_IMMUTABLE/);
    assert.throws(() => db.prepare("DELETE FROM director_focuses WHERE focus_id = 'focus_director_001'").run(), /DIRECTOR_FOCUS_IMMUTABLE/);

    db.prepare(`INSERT INTO director_automation_grants
      (grant_id, workspace_id, principal_id, project_id, provider, allowed_actions_json, currency,
       max_total_minor, max_per_run_minor, max_versions_per_shot, max_automatic_retries,
       pricing_contract_version, capability_contract_version, starts_at, expires_at, policy_hash, created_at)
      VALUES ('grant_director_001', 'jenn-ai-video-workspace', ?, 'project_director', 'runninghub', '["generation.submit","generation.retry"]', 'RH_COINS',
        10000, 1000, 3, 1, 'pricing-v1', 'capability-v1', '2026-07-22T00:00:00.000Z',
        '2026-07-23T00:00:00.000Z', ?, '2026-07-22T00:00:00.000Z')`).run(principalId, hash("policy"));
    assert.throws(() => db.prepare("UPDATE director_automation_grants SET max_total_minor = 20000 WHERE grant_id = 'grant_director_001'").run(), /DIRECTOR_AUTOMATION_GRANT_IMMUTABLE/);
    assert.throws(() => db.prepare(`INSERT INTO director_automation_grants
      (grant_id, workspace_id, principal_id, project_id, provider, allowed_actions_json, currency,
       max_total_minor, max_per_run_minor, max_versions_per_shot, max_automatic_retries,
       pricing_contract_version, capability_contract_version, starts_at, expires_at, policy_hash, created_at)
      VALUES ('grant_director_invalid', 'jenn-ai-video-workspace', ?, 'project_director', 'runninghub',
        '["generation.submit","generation.submit"]', 'CNY', 10000, 1000, 3, 1, 'pricing-v1', 'capability-v1',
        '2026-07-22T00:00:00.000Z', '2026-07-23T00:00:00.000Z', ?, '2026-07-22T00:00:00.000Z')`)
      .run(principalId, hash("invalid-policy")), /DIRECTOR_AUTOMATION_GRANT_ACTIONS_INVALID/);

    db.prepare(`INSERT INTO director_automation_grant_events
      (event_id, grant_id, event_type, reservation_id, amount_minor, currency, reason_code, created_at)
      VALUES ('grant_event_001', 'grant_director_001', 'reserve', 'reservation_001', 500, 'RH_COINS', 'GENERATION_APPROVED', '2026-07-22T00:01:00.000Z')`).run();
    assert.throws(() => db.prepare("DELETE FROM director_automation_grant_events WHERE event_id = 'grant_event_001'").run(), /DIRECTOR_AUTOMATION_GRANT_EVENTS_APPEND_ONLY/);
    assert.throws(() => db.prepare(`INSERT INTO director_automation_grant_events
      (event_id, grant_id, event_type, reservation_id, amount_minor, currency, reason_code, created_at)
      VALUES ('grant_event_unsupported_currency', 'grant_director_001', 'reserve', 'reservation_unsupported', 1, 'USD', 'GENERATION_APPROVED', '2026-07-22T00:01:00.000Z')`).run(), /CHECK constraint failed/);

    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)").run("project_other", JSON.stringify({ project_id: "project_other" }));
    assert.throws(() => db.prepare(`INSERT INTO director_proposals
      (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
       schema_version, kind, base_state_hash, payload_json, payload_hash, idempotency_key, source, created_at)
      VALUES ('proposal_cross_project', 'jenn-ai-video-workspace', ?, 'project_other', 'project', 'project_director',
        'focus_director_001', 1, 'director-domain-v1', 'creative_brief', ?, '{}', ?, 'cross-project-proposal',
        'native', '2026-07-22T00:00:00.000Z')`).run(principalId, hash("base"), directorContentHash({})), /FOREIGN KEY/);

    db.exec("DROP TRIGGER director_proposal_events_no_delete");
    assert.throws(() => assertSchemaCurrent(db), /missing_trigger:director_proposal_events_no_delete/);
  } finally {
    db.close();
  }
});

test("migrations 0010 and 0011 upgrade an already-ledgered 0009 Grant database without checksum drift", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 9)) migration.apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertMigration = db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 9)) {
      insertMigration.run(migration.id, migration.name, migration.id === "0009" ? HISTORICAL_MIGRATION_0009_CHECKSUM : migrationChecksum(migration));
    }
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)").run("project_director_0010", JSON.stringify({ project_id: "project_director_0010" }));
    db.prepare("INSERT INTO webgpt_auth_principals (workspace_id, principal_id) VALUES ('jenn-ai-video-workspace', ?)").run(principalId);
    db.prepare(`INSERT INTO director_automation_grants
      (grant_id, workspace_id, principal_id, project_id, provider, allowed_actions_json, currency,
       max_total_minor, max_per_run_minor, max_versions_per_shot, max_automatic_retries,
       pricing_contract_version, capability_contract_version, starts_at, expires_at, policy_hash, created_at)
      VALUES ('grant_director_0009', 'jenn-ai-video-workspace', ?, 'project_director_0010', 'runninghub', '["generation.submit"]', 'CNY',
        10000, 1000, 3, 0, 'pricing-v1', 'capability-v1', '2026-07-22T00:00:00.000Z',
        '2026-07-23T00:00:00.000Z', ?, '2026-07-22T00:00:00.000Z')`).run(principalId, hash("policy-0009"));
    db.prepare(`INSERT INTO director_automation_grant_events
      (event_id, grant_id, event_type, reservation_id, amount_minor, currency, reason_code, created_at)
      VALUES ('grant_event_0009', 'grant_director_0009', 'reserve', 'reservation_0009', 500, 'CNY', 'GENERATION_APPROVED', '2026-07-22T00:01:00.000Z')`).run();

    assert.deepEqual(runDatabaseMigrations(db).applied, ["0010", "0011"]);
    assert.doesNotThrow(() => assertSchemaCurrent(db));
    assert.equal(migrationChecksum(DATABASE_MIGRATIONS[8]), HISTORICAL_MIGRATION_0009_CHECKSUM);
    assert.equal((db.prepare("SELECT checksum FROM schema_migrations WHERE migration_id = '0009'").get() as { checksum: string }).checksum, HISTORICAL_MIGRATION_0009_CHECKSUM);
    assert.equal((db.prepare("SELECT currency FROM director_automation_grants WHERE grant_id = 'grant_director_0009'").get() as { currency: string }).currency, "CNY");
    db.prepare(`INSERT INTO director_automation_grant_events
      (event_id, grant_id, event_type, reservation_id, amount_minor, currency, reason_code, created_at)
      VALUES ('grant_event_rh_coins', 'grant_director_0009', 'reserve', 'reservation_rh_coins', 1, 'RH_COINS', 'GENERATION_APPROVED', '2026-07-22T00:02:00.000Z')`).run();
  } finally {
    db.close();
  }
});

test("migration 0010 fails closed without partial schema changes for unsupported legacy Grant currency", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 9)) migration.apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertMigration = db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 9)) {
      insertMigration.run(migration.id, migration.name, migrationChecksum(migration));
    }
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)").run("project_director_legacy_currency", JSON.stringify({ project_id: "project_director_legacy_currency" }));
    db.prepare("INSERT INTO webgpt_auth_principals (workspace_id, principal_id) VALUES ('jenn-ai-video-workspace', ?)").run(principalId);
    db.prepare(`INSERT INTO director_automation_grants
      (grant_id, workspace_id, principal_id, project_id, provider, allowed_actions_json, currency,
       max_total_minor, max_per_run_minor, max_versions_per_shot, max_automatic_retries,
       pricing_contract_version, capability_contract_version, starts_at, expires_at, policy_hash, created_at)
      VALUES ('grant_director_legacy_currency', 'jenn-ai-video-workspace', ?, 'project_director_legacy_currency', 'runninghub', '["generation.submit"]', 'USD',
        10000, 1000, 3, 0, 'pricing-v1', 'capability-v1', '2026-07-22T00:00:00.000Z',
        '2026-07-23T00:00:00.000Z', ?, '2026-07-22T00:00:00.000Z')`).run(principalId, hash("policy-legacy-currency"));

    assert.throws(() => runDatabaseMigrations(db), /unsupported value and requires manual remediation/);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_id = '0010'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT currency FROM director_automation_grants WHERE grant_id = 'grant_director_legacy_currency'").get() as { currency: string }).currency, "USD");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('director_automation_grants_0009', 'director_automation_grant_events_0009')").get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test("db check detects Director payload hash drift without repairing evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "director-db-check-"));
  const sqlitePath = join(root, "app.sqlite");
  const db = new DatabaseSync(sqlitePath);
  try {
    runDatabaseMigrations(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
      .run("project_director_check", JSON.stringify({ project_id: "project_director_check" }));
    db.prepare("INSERT INTO webgpt_auth_principals (workspace_id, principal_id, status) VALUES ('jenn-ai-video-workspace', ?, 'disabled')")
      .run(principalId);
    db.prepare(`INSERT INTO director_focuses
      (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation, created_at, expires_at)
      VALUES ('focus_director_check', 'jenn-ai-video-workspace', ?, 'project_director_check', 'project',
        'project_director_check', 1, '2026-07-22T00:00:00.000Z', '2026-07-22T02:00:00.000Z')`).run(principalId);
    const payload = {
      summary: "Safe brief",
      objectives: ["Validate the contract"],
      constraints: [],
      proposed_brief: {
        title: "Director contract fixture",
        audience: "Internal reviewers",
        key_message: "The Director contract remains bounded.",
        creative_direction: "Use a concise structured fixture.",
        call_to_action: "Review the proposal."
      }
    };
    db.prepare(`INSERT INTO director_proposals
      (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
       schema_version, kind, base_state_hash, payload_json, payload_hash, idempotency_key, source, created_at)
      VALUES ('proposal_director_check', 'jenn-ai-video-workspace', ?, 'project_director_check', 'project',
        'project_director_check', 'focus_director_check', 1, 'director-domain-v1', 'creative_brief', ?, ?, ?,
        'director-check-0001', 'native', '2026-07-22T00:00:00.000Z')`)
      .run(principalId, hash("base-check"), JSON.stringify(payload), "b".repeat(64));
  } finally {
    db.close();
  }
  try {
    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.structured_drift_rows, 1);
    const verify = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      assert.equal((verify.prepare("SELECT payload_hash FROM director_proposals WHERE proposal_id = 'proposal_director_check'").get() as { payload_hash: string }).payload_hash, "b".repeat(64));
    } finally { verify.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration 0009 failure rolls back without partial Director tables or ledger evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of DATABASE_MIGRATIONS.slice(0, 8)) migration.apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertMigration = db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 8)) {
      insertMigration.run(migration.id, migration.name, migrationChecksum(migration));
    }
    db.exec("CREATE TABLE director_focuses (sentinel TEXT)");

    assert.throws(() => runDatabaseMigrations(db), /director_focuses already exists/);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE migration_id = '0009'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE type = 'table' AND name = 'director_proposals'").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT value FROM m0_meta WHERE key = 'schema_version'").get() as { value: string }).value, "workbench-v2-5");
  } finally {
    db.close();
  }
});
