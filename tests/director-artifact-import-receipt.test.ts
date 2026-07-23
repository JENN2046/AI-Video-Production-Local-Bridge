import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DIRECTOR_FOCUS_SCHEMA,
  DIRECTOR_PROPOSAL_DRAFT_SCHEMA,
  DIRECTOR_PROPOSAL_SCHEMA,
  directorBaseStateHash,
  directorContentHash
} from "../src/director/domain.js";
import { buildDirectorContext } from "../src/director/localService.js";
import {
  createDirectorWorkbenchFocus,
  decideDirectorProposal,
  recordDirectorArtifactImportReceipt
} from "../src/director/workbenchApproval.js";
import { DATABASE_MIGRATIONS, assertSchemaCurrent, migrationChecksum, runDatabaseMigrations } from "../src/storage/migrations.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { createWorkbenchProject, listWorkbenchAssets } from "../src/tools/workbenchV2.js";
import { bootstrapWebGptProjectOwner } from "../src/webgpt-v4/authorizationAdmin.js";

const principalId = "a".repeat(64);
const issuerHash = "b".repeat(64);
const now = new Date("2026-07-23T00:00:00.000Z");
const fixturePath = resolve("fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png");

function insertVerifiedStoryboardArtifact(
  db: ReturnType<typeof openM0Database>,
  input: { project_id: string; shot_id: string; artifact_id: string }
): void {
  const bytes = readFileSync(fixturePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existingBlob = db.prepare("SELECT blob_id FROM media_blobs WHERE sha256 = ? AND integrity_state = 'verified'")
    .get(sha256) as { blob_id: string } | undefined;
  const blobId = existingBlob?.blob_id ?? `blob_${input.artifact_id}`;
  if (!existingBlob) {
    db.prepare(`INSERT INTO media_blobs
      (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
      VALUES (?, ?, ?, 'image/png', ?, 'verified', ?)`)
      .run(blobId, sha256, statSync(fixturePath).size, fixturePath, JSON.stringify({ media_root: dirname(fixturePath) }));
  }
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)`)
    .run(input.artifact_id, input.project_id, input.shot_id, JSON.stringify({
      artifact_id: input.artifact_id,
      blob_id: blobId,
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: fixturePath, mime_type: "image/png", filename: "shot_001_canary_720x1280.png" },
      metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256 },
      linked_objects: { project_id: input.project_id, shot_id: input.shot_id },
      source: { kind: "fixture", provider: "mock", provider_job_id: "", sha256, external_url_host: "" }
    }));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(input.artifact_id, blobId);
}

function createProjectShot(db: ReturnType<typeof openM0Database>, title: string, suffix: string) {
  const created = createWorkbenchProject({ title, classification: "production" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture project creation failed");
  const project = created.data.project;
  const shotId = `shot_import_${suffix}`;
  project.shot_ids = [shotId];
  saveProject(db, project);
  const shot: Shot = {
    shot_id: shotId,
    project_id: project.project_id,
    order: 1,
    status: "draft",
    duration_seconds: 5,
    description: "Artifact import receipt fixture SHOT.",
    storyboard_image_artifact_id: "",
    video_prompt: "Keep the subject stable.",
    negative_prompt: "No deformation.",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);
  return { project, shot };
}

function submitArtifactImportProposal(
  db: ReturnType<typeof openM0Database>,
  input: { project_id: string; shot_id: string; focus_id: string; generation: number; proposal_id: string; idempotency_key: string }
) {
  const focusRow = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
    generation, supersedes_focus_id, created_at, expires_at FROM director_focuses WHERE focus_id = ?`).get(input.focus_id) as Record<string, unknown>;
  const focus = DIRECTOR_FOCUS_SCHEMA.parse(focusRow);
  const context = buildDirectorContext(db, focus, "artifact_import", "full");
  const payload = {
    shot_id: input.shot_id,
    target_role: "storyboard_image" as const,
    expected_mime_type: "image/png" as const,
    summary: "Import a locally selected storyboard reference.",
    rationale: "The proposal names only the desired local evidence boundary."
  };
  const proposal = DIRECTOR_PROPOSAL_SCHEMA.parse({
    proposal_id: input.proposal_id,
    schema_version: "director-domain-v1",
    workspace_id: "jenn-ai-video-workspace",
    principal_id: principalId,
    project_id: input.project_id,
    target_type: "shot",
    target_id: input.shot_id,
    focus_id: input.focus_id,
    focus_generation: input.generation,
    base_state_hash: directorBaseStateHash(context.targetState),
    payload_hash: directorContentHash(payload),
    parent_proposal_id: null,
    idempotency_key: input.idempotency_key,
    source: "native",
    created_at: now.toISOString(),
    kind: "artifact_import",
    payload
  });
  db.prepare(`INSERT INTO director_proposals
    (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
      schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id, idempotency_key, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(proposal.proposal_id, proposal.workspace_id, proposal.principal_id, proposal.project_id,
      proposal.target_type, proposal.target_id, proposal.focus_id, proposal.focus_generation,
      proposal.schema_version, proposal.kind, proposal.base_state_hash, JSON.stringify(proposal.payload),
      proposal.payload_hash, proposal.parent_proposal_id, proposal.idempotency_key, proposal.source, proposal.created_at);
  db.prepare(`INSERT INTO director_proposal_events (event_id, proposal_id, event_type, reason_code, created_at)
    VALUES (?, ?, 'submitted', 'DIRECTOR_NATIVE_SUBMITTED', ?)`)
    .run(`event_${proposal.proposal_id}`, proposal.proposal_id, proposal.created_at);
  return proposal;
}

test("artifact_import proposals reject source locations and enforce SHOT role and MIME semantics", () => {
  const valid = {
    kind: "artifact_import",
    payload: {
      shot_id: "shot_contract_001",
      target_role: "storyboard_image",
      expected_mime_type: "image/png",
      summary: "Import one local storyboard image.",
      rationale: "Human-selected evidence is required."
    }
  };
  assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.parse(valid).kind, "artifact_import");
  assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
    ...valid, payload: { ...valid.payload, source_path: "C:/sensitive/video.mp4" }
  }).success, false);
  assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
    ...valid, payload: { ...valid.payload, external_url: "https://example.invalid/video.mp4" }
  }).success, false);
  assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
    ...valid, payload: { ...valid.payload, file_bytes_base64: "AA==" }
  }).success, false);
  for (const prohibitedText of [
    "Select C:\\Users\\Jenn\\Downloads\\storyboard.png.",
    "Select /private/staging/storyboard.png.",
    "Import https://example.invalid/storyboard.png.",
    "data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    `Embedded bytes: ${"QUJD".repeat(20)}`
  ]) {
    assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
      ...valid, payload: { ...valid.payload, summary: prohibitedText }
    }).success, false);
    assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
      ...valid, payload: { ...valid.payload, rationale: prohibitedText }
    }).success, false);
  }
  assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
    ...valid, payload: { ...valid.payload, target_role: "generated_clip", expected_mime_type: "image/png" }
  }).success, false);
  assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
    ...valid, payload: { ...valid.payload, expected_mime_type: "image/webp" }
  }).success, false);
  assert.equal(DIRECTOR_PROPOSAL_DRAFT_SCHEMA.safeParse({
    ...valid, payload: { ...valid.payload, target_role: "generated_clip", expected_mime_type: "video/webm" }
  }).success, false);
});

test("narrow Artifact filters keep an import receipt candidate reachable beyond the general asset page", () => {
  const db = openM0Database(":memory:");
  try {
    const primary = createProjectShot(db, "Director import candidate paging", "paging");
    const artifactId = "artifact_import_paging_target";
    insertVerifiedStoryboardArtifact(db, { project_id: primary.project.project_id, shot_id: primary.shot.shot_id, artifact_id: artifactId });
    const insertDistractor = db.prepare(`INSERT INTO media_artifacts
      (artifact_id, project_id, shot_id, role, artifact_type, status, data_json, updated_at)
      VALUES (?, ?, ?, 'generated_clip', 'video', 'active', ?, '2030-01-01T00:00:00.000Z')`);
    for (let index = 0; index < 201; index += 1) {
      const distractorId = `zz_director_import_distractor_${String(index).padStart(3, "0")}`;
      insertDistractor.run(distractorId, primary.project.project_id, primary.shot.shot_id, JSON.stringify({
        artifact_id: distractorId,
        artifact_type: "video",
        role: "generated_clip",
        status: "active",
        storage: { uri: "", mime_type: "video/mp4", filename: "" },
        metadata: { width: 0, height: 0, duration_seconds: 5, aspect_ratio: "9:16", sha256: "d".repeat(64) },
        linked_objects: { project_id: primary.project.project_id, shot_id: primary.shot.shot_id },
        source: { kind: "fixture", provider: "", provider_job_id: "", sha256: "d".repeat(64), external_url_host: "" }
      }));
    }
    const broadPage = listWorkbenchAssets("media", {
      scope: "all", project_id: primary.project.project_id, status: "active", limit: 200
    }, db);
    assert.equal(broadPage.items.some((item) => item.artifact_id === artifactId), false);
    const exactCandidates = listWorkbenchAssets("media", {
      scope: "all", project_id: primary.project.project_id, shot_id: primary.shot.shot_id,
      role: "storyboard_image", mime_type: "image/png", status: "active", limit: 200
    }, db);
    assert.deepEqual(exactCandidates.items.map((item) => item.artifact_id), [artifactId]);
  } finally {
    db.close();
  }
});

test("accepted artifact_import records exactly one immutable, path-free receipt after local byte validation", () => {
  const db = openM0Database(":memory:");
  try {
    const primary = createProjectShot(db, "Director import receipt fixture", "primary");
    bootstrapWebGptProjectOwner(db, principalId, primary.project.project_id, "DIRECTOR_IMPORT_RECEIPT", issuerHash);
    const artifactId = "artifact_import_primary";
    insertVerifiedStoryboardArtifact(db, { project_id: primary.project.project_id, shot_id: primary.shot.shot_id, artifact_id: artifactId });
    primary.shot.storyboard_image_artifact_id = artifactId;
    saveShot(db, primary.shot);
    const focus = createDirectorWorkbenchFocus({
      project_id: primary.project.project_id, target_type: "shot", target_id: primary.shot.shot_id, human_confirmation: true
    }, db, () => now);
    if (!focus.ok) throw new Error(focus.error.code);
    assert.equal(focus.ok, true);
    const proposal = submitArtifactImportProposal(db, {
      project_id: primary.project.project_id, shot_id: primary.shot.shot_id,
      focus_id: focus.data.focus.focus_id, generation: focus.data.focus.generation,
      proposal_id: "proposal_import_primary", idempotency_key: "proposal-import-primary-0001"
    });
    const accepted = decideDirectorProposal({ proposal_id: proposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => now);
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
    const receipt = recordDirectorArtifactImportReceipt({ proposal_id: proposal.proposal_id, artifact_id: artifactId, human_confirmation: true }, db, () => now);
    if (!receipt.ok) throw new Error(receipt.error.code);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.data.receipt.project_id, primary.project.project_id);
    assert.equal(receipt.data.receipt.shot_id, primary.shot.shot_id);
    assert.equal(receipt.data.receipt.blob_sha256.length, 64);
    const serialized = JSON.stringify(receipt.data.receipt);
    assert.equal(serialized.includes("storage"), false);
    assert.equal(serialized.includes("path"), false);
    assert.equal(serialized.includes("uri"), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = ?").get(proposal.proposal_id) as { count: number }).count, 2);
    assert.throws(() => db.prepare("UPDATE director_artifact_import_receipts SET role = 'generated_clip' WHERE proposal_id = ?").run(proposal.proposal_id), /DIRECTOR_ARTIFACT_IMPORT_RECEIPTS_IMMUTABLE/);
    assert.throws(() => db.prepare("DELETE FROM director_artifact_import_receipts WHERE proposal_id = ?").run(proposal.proposal_id), /DIRECTOR_ARTIFACT_IMPORT_RECEIPTS_IMMUTABLE/);

    const replay = recordDirectorArtifactImportReceipt({ proposal_id: proposal.proposal_id, artifact_id: artifactId, human_confirmation: true }, db, () => now);
    assert.equal(replay.ok, true);
    const changedArtifact = recordDirectorArtifactImportReceipt({ proposal_id: proposal.proposal_id, artifact_id: "artifact_different", human_confirmation: true }, db, () => now);
    assert.equal(changedArtifact.ok ? null : changedArtifact.error.code, "DIRECTOR_ARTIFACT_IMPORT_RECEIPT_EXISTS");

    const foreign = createProjectShot(db, "Director import foreign project", "foreign");
    const foreignArtifactId = "artifact_import_foreign";
    insertVerifiedStoryboardArtifact(db, { project_id: foreign.project.project_id, shot_id: foreign.shot.shot_id, artifact_id: foreignArtifactId });
    const secondProposal = submitArtifactImportProposal(db, {
      project_id: primary.project.project_id, shot_id: primary.shot.shot_id,
      focus_id: focus.data.focus.focus_id, generation: focus.data.focus.generation,
      proposal_id: "proposal_import_cross_project", idempotency_key: "proposal-import-cross-project-0001"
    });
    const secondAccepted = decideDirectorProposal({ proposal_id: secondProposal.proposal_id, decision: "accept", human_confirmation: true }, db, () => now);
    assert.equal(secondAccepted.ok, true, secondAccepted.ok ? "" : secondAccepted.error.code);
    const crossProject = recordDirectorArtifactImportReceipt({ proposal_id: secondProposal.proposal_id, artifact_id: foreignArtifactId, human_confirmation: true }, db, () => now);
    assert.equal(crossProject.ok ? null : crossProject.error.code, "DIRECTOR_ARTIFACT_IMPORT_ARTIFACT_INVALID");
    const staleShot = { ...primary.shot, video_prompt: "Changed after approval so the advisory state is stale." };
    db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?")
      .run(JSON.stringify(staleShot), primary.shot.shot_id);
    const stale = recordDirectorArtifactImportReceipt({ proposal_id: secondProposal.proposal_id, artifact_id: artifactId, human_confirmation: true }, db, () => now);
    assert.equal(stale.ok ? null : stale.error.code, "DIRECTOR_PROPOSAL_STALE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_artifact_import_receipts WHERE proposal_id = ?").get(secondProposal.proposal_id) as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test("migration 0011 preserves 0010 proposal evidence and adds the immutable import receipt ledger", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 10)) migration.apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertMigration = db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 10)) {
      insertMigration.run(migration.id, migration.name, migrationChecksum(migration));
    }
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_0011', '{\"project_id\":\"project_0011\"}')").run();
    db.prepare("INSERT INTO webgpt_auth_principals (workspace_id, principal_id) VALUES ('jenn-ai-video-workspace', ?)").run(principalId);
    db.prepare(`INSERT INTO director_focuses
      (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation, created_at, expires_at)
      VALUES ('focus_0011', 'jenn-ai-video-workspace', ?, 'project_0011', 'project', 'project_0011', 1, ?, ?)`)
      .run(principalId, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    db.prepare(`INSERT INTO director_proposals
      (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
       schema_version, kind, base_state_hash, payload_json, payload_hash, idempotency_key, source, created_at)
      VALUES ('proposal_legacy_0010', 'jenn-ai-video-workspace', ?, 'project_0011', 'project', 'project_0011', 'focus_0011', 1,
       'director-domain-v1', 'creative_brief', ?, '{}', ?, 'legacy-proposal-0010', 'native', ?)`)
      .run(principalId, "c".repeat(64), directorContentHash({}), now.toISOString());
    db.prepare(`INSERT INTO director_proposal_events (event_id, proposal_id, event_type, reason_code, created_at)
      VALUES ('event_legacy_0010', 'proposal_legacy_0010', 'submitted', 'DIRECTOR_NATIVE_SUBMITTED', ?)`)
      .run(now.toISOString());
    db.prepare(`INSERT INTO director_proposal_events (event_id, proposal_id, event_type, reason_code, receipt_type, receipt_id, created_at)
      VALUES ('event_compiled_legacy_0010', 'proposal_legacy_0010', 'compiled', 'DIRECTOR_HISTORICAL_COMPILED', 'director_automation_grant', 'grant_legacy_0010', ?)`)
      .run(now.toISOString());

    assert.deepEqual(runDatabaseMigrations(db).applied, ["0011"]);
    assert.doesNotThrow(() => assertSchemaCurrent(db));
    assert.equal((db.prepare("SELECT kind FROM director_proposals WHERE proposal_id = 'proposal_legacy_0010'").get() as { kind: string }).kind, "creative_brief");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM director_proposal_events WHERE proposal_id = 'proposal_legacy_0010' AND event_type = 'compiled' AND receipt_id = 'grant_legacy_0010'").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'director_artifact_import_receipts'").get() as { count: number }).count, 1);
    assert.throws(() => db.prepare("UPDATE director_proposals SET kind = 'artifact_import' WHERE proposal_id = 'proposal_legacy_0010'").run(), /DIRECTOR_PROPOSAL_IMMUTABLE/);
  } finally {
    db.close();
  }
});
