import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateDatabase } from "../src/storage/databaseGovernance.js";
import { saveProject, saveShot, type Project, type Shot } from "../src/tools/projects.js";
import { readGenerationAdmissionCandidateFacts } from "../src/tools/s3bT2AdmissionFacts.js";
import {
  confirmGenerationAdmission,
  prepareGenerationAdmission,
  projectGenerationAdmission
} from "../src/tools/s3bT2GenerationAdmissionSurface.js";
import {
  admissionCandidateKey,
  classifyAdmissionAuthoritySlice,
  classifyGenerationHistoryAttribution
} from "../src/tools/s3bT2Normalize.js";
import { runWorkbenchGenerationOnce } from "../src/tools/workbenchGeneration.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const MODEL = "rhart-video-g/image-to-video";
const BASE = {
  project_id: "project_is3_fixture",
  shot_id: "shot_is3_fixture",
  package_id: "package_is3_fixture",
  artifact_id: "artifact_is3_fixture",
  blob_id: "blob_is3_fixture"
} as const;
const PEER = {
  project_id: "project_is3_peer",
  shot_id: "shot_is3_peer",
  package_id: "package_is3_peer",
  artifact_id: "artifact_is3_peer",
  blob_id: "blob_is3_peer"
} as const;

type CandidateIds = {
  project_id: string;
  shot_id: string;
  package_id: string;
  artifact_id: string;
  blob_id: string;
};

type Fixture = {
  root: string;
  sqlitePath: string;
  mediaRoot: string;
  imagePath: string;
  db: DatabaseSync;
};

function addEligibleCandidate(fixture: Fixture, ids: CandidateIds, filename: string, bytes = PNG): string {
  const imagePath = join(fixture.mediaRoot, filename);
  writeFileSync(imagePath, bytes);
  const project: Project = {
    project_id: ids.project_id,
    title: "IS3 fixture project",
    project_type: "m0_video_loop",
    status: "storyboard_approved",
    brief: {},
    video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "480p" },
    shot_ids: [ids.shot_id],
    active_storyboard_package_id: ids.package_id,
    generation_batch_ids: [],
    exports: { final_video_artifact_id: "" }
  };
  saveProject(fixture.db, project);
  fixture.db.prepare("UPDATE workbench_project_meta SET classification = 'production', lifecycle = 'active' WHERE project_id = ?")
    .run(ids.project_id);

  const shot: Shot = {
    shot_id: ids.shot_id,
    project_id: ids.project_id,
    order: 1,
    status: "storyboard_approved",
    duration_seconds: 6,
    description: "A frozen IS3 fixture storyboard.",
    storyboard_image_artifact_id: ids.artifact_id,
    video_prompt: "Animate the fixture image with a gentle camera move.",
    negative_prompt: "No deformation.",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(fixture.db, shot);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fixture.db.prepare(`INSERT INTO media_blobs
    (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, 'image/png', ?, 'verified', ?)`)
    .run(ids.blob_id, sha256, bytes.length, imagePath, JSON.stringify({ media_root: fixture.mediaRoot }));
  fixture.db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)`)
    .run(ids.artifact_id, ids.project_id, ids.shot_id, JSON.stringify({
      artifact_id: ids.artifact_id,
      blob_id: ids.blob_id,
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: imagePath, mime_type: "image/png", filename },
      metadata: { width: 1, height: 1, duration_seconds: null, aspect_ratio: "9:16", sha256 },
      linked_objects: { project_id: ids.project_id, shot_id: ids.shot_id },
      source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256, external_url_host: "" }
    }));
  fixture.db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)")
    .run(ids.artifact_id, ids.blob_id);

  fixture.db.prepare(`INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json)
    VALUES (?, ?, ?)`)
    .run(ids.package_id, ids.project_id, JSON.stringify({
      storyboard_package_id: ids.package_id,
      project_id: ids.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [{
        shot_id: ids.shot_id,
        order: 1,
        duration_seconds: 6,
        description: shot.description,
        storyboard_image_artifact_id: ids.artifact_id,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt
      }],
      user_approval: { storyboard_approved: true }
    }));
  return imagePath;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "s3b-t2-is3-"));
  const dataRoot = join(root, "data");
  const mediaRoot = join(dataRoot, "media");
  mkdirSync(mediaRoot, { recursive: true });
  const sqlitePath = join(dataRoot, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA foreign_keys = ON");
  const fixture = { root, sqlitePath, mediaRoot, imagePath: join(mediaRoot, "storyboard.png"), db };
  addEligibleCandidate(fixture, BASE, "storyboard.png");
  return fixture;
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function intentCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM generation_intents").get() as { count: number }).count);
}

function totalChanges(db: DatabaseSync): number {
  return Number((db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes);
}

function rewritePayloadIdentity(
  fixture: Fixture,
  table: "projects" | "shots",
  relationalId: string,
  mutate: (payload: Record<string, unknown>) => void
): void {
  const idColumn = table === "projects" ? "project_id" : "shot_id";
  const row = fixture.db.prepare(`SELECT data_json FROM ${table} WHERE ${idColumn} = ?`).get(relationalId) as { data_json: string };
  const payload = JSON.parse(row.data_json) as Record<string, unknown>;
  mutate(payload);
  fixture.db.prepare(`UPDATE ${table} SET data_json = ? WHERE ${idColumn} = ?`).run(JSON.stringify(payload), relationalId);
}

function assertFactsUnavailable(result: ReturnType<typeof prepareGenerationAdmission>): void {
  assert.equal(result.result, "BLOCKED");
  assert.deepEqual(result.projection, {
    result: "BLOCKED",
    candidate_count: 0,
    reason_codes: ["GENERATION_ADMISSION_FACTS_UNAVAILABLE"]
  });
  assert.equal("plan" in result, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /malformed|orphan|SQL|JSON|stack|[A-Za-z]:\\|\/tmp\/|sha256|hash|intent_is3_missing/i
  );
}

function prepareFixture(fixture: Fixture) {
  const prepared = prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db);
  if (prepared.result !== "READY") throw new Error(prepared.projection.reason_codes.join(","));
  return prepared;
}

test("IS3 ready Prepare returns one internal plan and a READY low-disclosure projection", () => {
  const fixture = createFixture();
  try {
    const before = totalChanges(fixture.db);
    const prepared = prepareFixture(fixture);
    assert.equal(prepared.projection.result, "READY");
    assert.equal(prepared.projection.candidate_count, 1);
    assert.deepEqual(prepared.projection.reason_codes, []);
    assert.equal(prepared.plan.schema_version, "generation_plan.v1");
    assert.equal(intentCount(fixture.db), 0);
    assert.equal(totalChanges(fixture.db), before);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 blocked Prepare exposes a canonical reason and creates no plan or write", () => {
  const fixture = createFixture();
  try {
    fixture.db.prepare("UPDATE workbench_project_meta SET classification = 'test' WHERE project_id = ?").run(BASE.project_id);
    const before = totalChanges(fixture.db);
    const prepared = prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db);
    assert.equal(prepared.result, "BLOCKED");
    assert.equal(prepared.projection.candidate_count, 0);
    assert.ok(prepared.projection.reason_codes.includes("PROJECT_NOT_PRODUCTION"));
    assert.equal("plan" in prepared, false);
    assert.equal(intentCount(fixture.db), 0);
    assert.equal(totalChanges(fixture.db), before);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 public projection closes paths, hashes, media tokens, prompts, credentials, and full plan", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const projection = projectGenerationAdmission(prepared);
    assert.deepEqual(Object.keys(projection).sort(), ["candidate_count", "reason_codes", "result"]);
    assert.equal("plan" in projection, false);
    const serialized = JSON.stringify(projection);
    assert.doesNotMatch(serialized, /[A-Za-z]:\\|\/tmp\/|storage_uri|sha256|media_verification_token|video_prompt|negative_prompt|credential|password|token/i);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 multiple eligible candidates block without an executable plan", () => {
  const fixture = createFixture();
  try {
    addEligibleCandidate(fixture, {
      project_id: "project_is3_fixture_two",
      shot_id: "shot_is3_fixture_two",
      package_id: "package_is3_fixture_two",
      artifact_id: "artifact_is3_fixture_two",
      blob_id: "blob_is3_fixture_two"
    }, "storyboard-two.png", Buffer.concat([PNG, Buffer.from([0])]));
    const before = totalChanges(fixture.db);
    const prepared = prepareGenerationAdmission({}, fixture.db);
    assert.equal(prepared.result, "BLOCKED");
    assert.equal(prepared.projection.candidate_count, 2);
    assert.deepEqual(prepared.projection.reason_codes, ["S3_MULTIPLE_ELIGIBLE_SHOTS"]);
    assert.equal("plan" in prepared, false);
    assert.equal(intentCount(fixture.db), 0);
    assert.equal(totalChanges(fixture.db), before);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 project and global enumeration failures return one canonical low-disclosure BLOCKED result", () => {
  const fixture = createFixture();
  try {
    const validProject = prepareGenerationAdmission({ project_id: BASE.project_id }, fixture.db);
    assert.equal(validProject.result, "READY");
    const explicitShot = prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db);
    assert.equal(explicitShot.result, "READY");

    // The production index normally rejects malformed JSON on write. Dropping
    // it in this isolated fixture models a legacy/corrupted persisted row so
    // the read boundary itself can be exercised.
    fixture.db.exec("DROP INDEX idx_shots_project_order");
    fixture.db.prepare("INSERT INTO shots (shot_id, project_id, data_json) VALUES (?, ?, ?)")
      .run("shot_is3_malformed", BASE.project_id, "{malformed-shot-json");
    const before = totalChanges(fixture.db);
    for (const input of [{ project_id: BASE.project_id }, {}]) {
      const prepared = prepareGenerationAdmission(input, fixture.db);
      assert.equal(prepared.result, "BLOCKED");
      assert.deepEqual(prepared.projection, {
        result: "BLOCKED",
        candidate_count: 0,
        reason_codes: ["GENERATION_ADMISSION_FACTS_UNAVAILABLE"]
      });
      assert.equal("plan" in prepared, false);
      const serialized = JSON.stringify(prepared);
      assert.doesNotMatch(serialized, /malformed|SQL|JSON|stack|[A-Za-z]:\\|\/tmp\/|sha256|hash/i);
    }
    assert.equal(intentCount(fixture.db), 0);
    assert.equal(totalChanges(fixture.db), before);
  } finally {
    closeFixture(fixture);
  }
});

test("admission rejects Project relational/payload identity drift on explicit, project, and global paths", () => {
  const fixture = createFixture();
  try {
    addEligibleCandidate(fixture, {
      project_id: "project_is3_valid_peer",
      shot_id: "shot_is3_valid_peer",
      package_id: "package_is3_valid_peer",
      artifact_id: "artifact_is3_valid_peer",
      blob_id: "blob_is3_valid_peer"
    }, "storyboard-valid-peer.png", Buffer.concat([PNG, Buffer.from([1])]));
    rewritePayloadIdentity(fixture, "projects", BASE.project_id, (payload) => { payload.project_id = "project_payload_drift"; });
    const before = totalChanges(fixture.db);
    for (const input of [
      { project_id: BASE.project_id, shot_id: BASE.shot_id },
      { project_id: BASE.project_id },
      {}
    ]) assertFactsUnavailable(prepareGenerationAdmission(input, fixture.db));
    assert.equal(totalChanges(fixture.db), before);
  } finally {
    closeFixture(fixture);
  }
});

test("admission rejects SHOT relational/payload identity drift", () => {
  const fixture = createFixture();
  try {
    rewritePayloadIdentity(fixture, "shots", BASE.shot_id, (payload) => { payload.shot_id = "shot_payload_drift"; });
    assertFactsUnavailable(prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db));
  } finally {
    closeFixture(fixture);
  }
});

test("admission rejects contradictory SHOT project binding", () => {
  const fixture = createFixture();
  try {
    rewritePayloadIdentity(fixture, "shots", BASE.shot_id, (payload) => { payload.project_id = "project_payload_drift"; });
    assertFactsUnavailable(prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db));
  } finally {
    closeFixture(fixture);
  }
});

test("valid identity and legitimate no-history absence remain READY on every candidate path", () => {
  const fixture = createFixture();
  try {
    for (const input of [
      { project_id: BASE.project_id, shot_id: BASE.shot_id },
      { project_id: BASE.project_id },
      {}
    ]) {
      const prepared = prepareGenerationAdmission(input, fixture.db);
      assert.equal(prepared.result, "READY");
      assert.deepEqual(prepared.projection, { result: "READY", candidate_count: 1, reason_codes: [] });
    }
  } finally {
    closeFixture(fixture);
  }
});

test("generation-history attribution distinguishes all four contract states", () => {
  const candidates = [{ project_id: BASE.project_id, shot_id: BASE.shot_id }];
  const canonical = (kind: "job" | "run", projectId: string, shotId: string) => ({
    history_kind: kind,
    history_id: `${kind}_${projectId}_${shotId}`,
    history_project_id: projectId,
    history_shot_id: shotId,
    history_state: kind === "job" ? "queued" : "succeeded",
    history_run_type: kind === "run" ? "image_to_video" : null,
    authority_parent_id: kind === "job" ? `intent_${projectId}_${shotId}` : null,
    authority_project_id: projectId,
    authority_project_data_json: JSON.stringify({ project_id: projectId }),
    authority_shot_id: shotId,
    authority_shot_project_id: projectId,
    authority_shot_data_json: JSON.stringify({ project_id: projectId, shot_id: shotId })
  });

  assert.equal(classifyGenerationHistoryAttribution(canonical("job", BASE.project_id, BASE.shot_id), candidates), "ATTRIBUTABLE");
  assert.equal(classifyGenerationHistoryAttribution(canonical("run", BASE.project_id, BASE.shot_id), candidates), "ATTRIBUTABLE");
  assert.equal(classifyGenerationHistoryAttribution(canonical("job", PEER.project_id, PEER.shot_id), candidates), "UNRELATED");
  assert.equal(classifyGenerationHistoryAttribution(canonical("run", PEER.project_id, PEER.shot_id), candidates), "UNRELATED");
  assert.equal(classifyGenerationHistoryAttribution({ history_kind: "job", authority_parent_id: null }, candidates), "UNASSIGNABLE");

  const empty = classifyAdmissionAuthoritySlice({
    projects: [{ project_id: BASE.project_id, data_json: JSON.stringify({ project_id: BASE.project_id }) }],
    shots: [{ shot_id: BASE.shot_id, project_id: BASE.project_id, data_json: JSON.stringify({ shot_id: BASE.shot_id, project_id: BASE.project_id }) }],
    generation_jobs: [],
    generation_runs: [],
    candidates,
    required_project_ids: [BASE.project_id],
    required_shot_ids: [BASE.shot_id]
  });
  assert.equal(empty.status, "COMPLETE");
  assert.equal(empty.history_by_candidate.get(admissionCandidateKey(candidates[0]))?.attribution, "LEGITIMATE_ABSENCE");
});

test("orphan generation jobs are unassignable authority, never absent history", () => {
  const fixture = createFixture();
  try {
    fixture.db.exec("PRAGMA foreign_keys = OFF");
    fixture.db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
      .run("job_is3_orphan", "intent_is3_missing");
    fixture.db.exec("PRAGMA foreign_keys = ON");
    const before = totalChanges(fixture.db);
    for (const input of [
      { project_id: BASE.project_id, shot_id: BASE.shot_id },
      { project_id: BASE.project_id },
      {}
    ]) assertFactsUnavailable(prepareGenerationAdmission(input, fixture.db));
    assert.equal(totalChanges(fixture.db), before);
  } finally {
    closeFixture(fixture);
  }
});

test("valid attributable generation jobs retain existing history semantics", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(confirmed.result, "CONFIRMED");
    fixture.db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
      .run(confirmed.job_id, confirmed.intent_id);
    const subsequent = prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db);
    assert.equal(subsequent.result, "BLOCKED");
    assert.equal(subsequent.projection.reason_codes.includes("GENERATION_ADMISSION_FACTS_UNAVAILABLE"), false);
    assert.ok(subsequent.projection.reason_codes.some((code) => code === "REAL_GENERATION_ALREADY_ACTIVE" || code === "GENERATION_ALREADY_STARTED"));
  } finally {
    closeFixture(fixture);
  }
});

test("canonical unrelated jobs do not block explicit, project, or global candidate selection", () => {
  const fixture = createFixture();
  try {
    addEligibleCandidate(fixture, PEER, "storyboard-peer-job.png", Buffer.concat([PNG, Buffer.from([2])]));
    const peerPrepared = prepareGenerationAdmission({ project_id: PEER.project_id, shot_id: PEER.shot_id }, fixture.db);
    assert.equal(peerPrepared.result, "READY");
    const peerConfirmed = confirmGenerationAdmission(peerPrepared.plan, fixture.db);
    assert.equal(peerConfirmed.result, "CONFIRMED");
    fixture.db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
      .run(peerConfirmed.job_id, peerConfirmed.intent_id);

    for (const input of [
      { project_id: BASE.project_id, shot_id: BASE.shot_id },
      { project_id: BASE.project_id },
      {}
    ]) {
      const prepared = prepareGenerationAdmission(input, fixture.db);
      assert.equal(prepared.result, "READY");
      assert.deepEqual(prepared.projection, { result: "READY", candidate_count: 1, reason_codes: [] });
    }
  } finally {
    closeFixture(fixture);
  }
});

test("both half-matched intent/job attribution shapes fail closed instead of becoming absent history", () => {
  for (const mismatch of [
    { column: "project_id", value: "project_is3_contradictory" },
    { column: "shot_id", value: "shot_is3_contradictory" }
  ] as const) {
    const fixture = createFixture();
    try {
      const prepared = prepareFixture(fixture);
      const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
      assert.equal(confirmed.result, "CONFIRMED");
      fixture.db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
        .run(confirmed.job_id, confirmed.intent_id);
      fixture.db.prepare(`UPDATE generation_intents SET ${mismatch.column} = ? WHERE intent_id = ?`)
        .run(mismatch.value, confirmed.intent_id);
      assertFactsUnavailable(prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db));
    } finally {
      closeFixture(fixture);
    }
  }
});

test("canonical candidate runs remain attributable generation history", () => {
  const fixture = createFixture();
  try {
    fixture.db.prepare(`INSERT INTO generation_runs
      (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
      VALUES (?, '', ?, ?, 'image_to_video', 'succeeded', ?)`)
      .run("run_is3_candidate", BASE.project_id, BASE.shot_id, JSON.stringify({ run_type: "image_to_video" }));
    const prepared = prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db);
    assert.equal(prepared.result, "BLOCKED");
    assert.equal(prepared.projection.reason_codes.includes("GENERATION_ADMISSION_FACTS_UNAVAILABLE"), false);
    assert.equal(prepared.projection.reason_codes.includes("GENERATION_ALREADY_STARTED"), true);
  } finally {
    closeFixture(fixture);
  }
});

test("canonical unrelated runs do not block explicit, project, or global candidate selection", () => {
  const fixture = createFixture();
  try {
    addEligibleCandidate(fixture, PEER, "storyboard-peer-run.png", Buffer.concat([PNG, Buffer.from([3])]));
    fixture.db.prepare(`INSERT INTO generation_runs
      (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
      VALUES (?, '', ?, ?, 'image_to_video', 'succeeded', ?)`)
      .run("run_is3_unrelated", PEER.project_id, PEER.shot_id, JSON.stringify({ run_type: "image_to_video" }));
    for (const input of [
      { project_id: BASE.project_id, shot_id: BASE.shot_id },
      { project_id: BASE.project_id },
      {}
    ]) {
      const prepared = prepareGenerationAdmission(input, fixture.db);
      assert.equal(prepared.result, "READY");
      assert.deepEqual(prepared.projection, { result: "READY", candidate_count: 1, reason_codes: [] });
    }
  } finally {
    closeFixture(fixture);
  }
});

test("both half-matched SHOT generation-run shapes fail closed instead of becoming absent history", () => {
  for (const binding of [
    { project_id: "project_is3_contradictory", shot_id: BASE.shot_id },
    { project_id: BASE.project_id, shot_id: "shot_is3_contradictory" }
  ]) {
    const fixture = createFixture();
    try {
      fixture.db.prepare(`INSERT INTO generation_runs
        (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
        VALUES (?, '', ?, ?, 'image_to_video', 'succeeded', ?)`)
        .run(`run_is3_unassignable_${binding.project_id}_${binding.shot_id}`, binding.project_id, binding.shot_id, JSON.stringify({ run_type: "image_to_video" }));
      assertFactsUnavailable(prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db));
    } finally {
      closeFixture(fixture);
    }
  }
});

test("unrelated project-level assembly history does not become a world-admission blocker", () => {
  const fixture = createFixture();
  try {
    fixture.db.prepare(`INSERT INTO generation_runs
      (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
      VALUES (?, '', ?, '', 'assemble_video', 'succeeded', ?)`)
      .run("run_is3_unrelated_assembly", "project_is3_unrelated", JSON.stringify({ run_type: "assemble_video" }));
    const prepared = prepareGenerationAdmission({ project_id: BASE.project_id, shot_id: BASE.shot_id }, fixture.db);
    assert.equal(prepared.result, "READY");
  } finally {
    closeFixture(fixture);
  }
});

test("admission validates and constructs generation facts from one selected history slice", () => {
  const fixture = createFixture();
  try {
    const statements: string[] = [];
    const instrumented = new Proxy(fixture.db, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as DatabaseSync;
    const read = readGenerationAdmissionCandidateFacts(
      instrumented,
      { project_id: BASE.project_id, shot_id: BASE.shot_id }
    );
    if (!read.ok) assert.fail(read.error.code);
    assert.equal(read.facts.length, 1);
    assert.equal(read.facts[0].generation.selected_has_any_job_or_run, false);
    const historyStatements = statements.filter((sql) => /\bFROM\s+generation_(?:jobs|runs)\b/i.test(sql));
    assert.equal(historyStatements.length, 2);
    assert.equal(historyStatements.filter((sql) => /'job' AS history_kind/i.test(sql)).length, 1);
    assert.equal(historyStatements.filter((sql) => /'run' AS history_kind/i.test(sql)).length, 1);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 explicit confirm reuses the existing human gate boundary and writes one canonical intent", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    assert.equal(intentCount(fixture.db), 0);
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(confirmed.result, "CONFIRMED");
    assert.equal(confirmed.status, "prepared");
    assert.deepEqual(Object.keys(confirmed).sort(), ["intent_id", "job_id", "result", "run_id", "status"]);
    assert.equal(intentCount(fixture.db), 1);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 transaction-start contention maps to the stable admission conflict without writes", () => {
  const fixture = createFixture();
  const lockDb = new DatabaseSync(fixture.sqlitePath);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("Confirmation must not dispatch Provider work.");
  };
  try {
    const prepared = prepareFixture(fixture);
    const before = intentCount(fixture.db);
    lockDb.exec("PRAGMA busy_timeout = 0");
    fixture.db.exec("PRAGMA busy_timeout = 0");
    lockDb.exec("BEGIN IMMEDIATE");
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.deepEqual(confirmed, {
      result: "GENERATION_ADMISSION_CONFLICT",
      reason_code: "GENERATION_ADMISSION_CONFLICT"
    });
    assert.equal(intentCount(fixture.db), before);
    assert.equal((fixture.db as DatabaseSync & { isTransaction?: boolean }).isTransaction, false);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if ((lockDb as DatabaseSync & { isTransaction?: boolean }).isTransaction) lockDb.exec("ROLLBACK");
    lockDb.close();
    closeFixture(fixture);
  }
});

test("IS3 transaction-start SQLITE_LOCKED mapping does not roll back an unstarted transaction", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const statements: string[] = [];
    const instrumented = new Proxy(fixture.db, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            statements.push(sql);
            if (sql === "BEGIN IMMEDIATE") {
              const locked = new Error("database table is locked") as Error & { code: string };
              locked.code = "SQLITE_LOCKED";
              throw locked;
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as DatabaseSync;
    const confirmed = confirmGenerationAdmission(prepared.plan, instrumented);
    assert.deepEqual(confirmed, {
      result: "GENERATION_ADMISSION_CONFLICT",
      reason_code: "GENERATION_ADMISSION_CONFLICT"
    });
    assert.deepEqual(statements, ["BEGIN IMMEDIATE"]);
    assert.equal(intentCount(fixture.db), 0);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 non-contention transaction-start errors preserve their original semantics", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const instrumented = new Proxy(fixture.db, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            if (sql === "BEGIN IMMEDIATE") throw new Error("INJECTED_BEGIN_FAILURE");
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as DatabaseSync;
    assert.throws(
      () => confirmGenerationAdmission(prepared.plan, instrumented),
      /INJECTED_BEGIN_FAILURE/
    );
    assert.equal(intentCount(fixture.db), 0);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 stale plan returns GENERATION_PLAN_STALE without gaining a new generation right", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const row = fixture.db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(BASE.shot_id) as { data_json: string };
    const shot = JSON.parse(row.data_json) as Shot;
    shot.video_prompt = "A changed prompt after prepare.";
    fixture.db.prepare("UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE shot_id = ?")
      .run(JSON.stringify(shot), BASE.shot_id);
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(confirmed.result, "GENERATION_PLAN_STALE");
    assert.equal(intentCount(fixture.db), 0);
  } finally {
    closeFixture(fixture);
  }
});

test("atomic confirmation revalidates newly unassignable authority without creating a generation right", () => {
  const fixture = createFixture();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Confirmation must not dispatch Provider work.");
  };
  try {
    const prepared = prepareFixture(fixture);
    fixture.db.exec("PRAGMA foreign_keys = OFF");
    fixture.db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
      .run("job_is3_confirm_orphan", "intent_is3_confirm_missing");
    fixture.db.exec("PRAGMA foreign_keys = ON");
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(confirmed.result, "GENERATION_PLAN_STALE");
    assert.equal(intentCount(fixture.db), 0);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    closeFixture(fixture);
  }
});

test("IS3 double confirm returns REAL_GENERATION_ALREADY_ACTIVE and keeps one intent", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const first = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(first.result, "CONFIRMED");
    const second = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(second.result, "REAL_GENERATION_ALREADY_ACTIVE");
    assert.equal(intentCount(fixture.db), 1);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 admission reservation is rejected before Provider construction", async () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(confirmed.result, "CONFIRMED");
    let providerCalls = 0;
    await runWorkbenchGenerationOnce(confirmed.intent_id, {
      allow_submit: true,
      dependencies: {
        sqlite_path: fixture.sqlitePath,
        adapter_factory: () => {
          providerCalls += 1;
          throw new Error("Provider adapter must not be constructed after media staleness.");
        }
      }
    });
    assert.equal(providerCalls, 0);
    const row = fixture.db.prepare("SELECT status, confirmed, run_id FROM generation_intents WHERE intent_id = ?")
      .get(confirmed.intent_id) as { status: string; confirmed: number; run_id: string | null };
    assert.equal(row.status, "prepared");
    assert.equal(row.confirmed, 0);
    assert.equal(row.run_id, null);
  } finally {
    closeFixture(fixture);
  }
});

test("IS3 Prepare side-effect boundary keeps database, network, and Provider work at zero", () => {
  const fixture = createFixture();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Prepare must not call network.");
  };
  try {
    const before = totalChanges(fixture.db);
    const prepared = prepareFixture(fixture);
    assert.equal(prepared.result, "READY");
    assert.equal(totalChanges(fixture.db), before);
    assert.equal(networkCalls, 0);
    assert.equal(intentCount(fixture.db), 0);
  } finally {
    globalThis.fetch = originalFetch;
    closeFixture(fixture);
  }
});
