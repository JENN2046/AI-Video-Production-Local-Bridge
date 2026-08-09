import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateDatabase } from "../src/storage/databaseGovernance.js";
import { saveProject, saveShot, type Project, type Shot } from "../src/tools/projects.js";
import {
  confirmGenerationAdmission,
  prepareGenerationAdmission,
  projectGenerationAdmission
} from "../src/tools/s3bT2GenerationAdmissionSurface.js";
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

test("IS3 explicit confirm reuses the existing human gate boundary and writes one canonical intent", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    assert.equal(intentCount(fixture.db), 0);
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(confirmed.result, "CONFIRMED");
    assert.equal(confirmed.status, "queued");
    assert.deepEqual(Object.keys(confirmed).sort(), ["intent_id", "job_id", "result", "run_id", "status"]);
    assert.equal(intentCount(fixture.db), 1);
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

test("IS3 stale media is rejected before Provider construction", async () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const confirmed = confirmGenerationAdmission(prepared.plan, fixture.db);
    assert.equal(confirmed.result, "CONFIRMED");
    writeFileSync(fixture.imagePath, Buffer.from("stale storyboard bytes"));
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
    const row = fixture.db.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(confirmed.intent_id) as { status: string; sanitized_error_json: string };
    assert.equal(row.status, "failed");
    assert.equal((JSON.parse(row.sanitized_error_json) as { code: string }).code, "MEDIA_VERIFICATION_STALE");
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
