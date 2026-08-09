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
  confirmGeneration,
  prepareGeneration,
  revalidateGenerationPlanMedia
} from "../src/tools/s3bT2GenerationAdmission.js";
import { runWorkbenchGenerationOnce } from "../src/tools/workbenchGeneration.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PROJECT_ID = "project_is2_5_fixture";
const SHOT_ID = "shot_is2_5_fixture";
const PACKAGE_ID = "package_is2_5_fixture";
const ARTIFACT_ID = "artifact_is2_5_fixture";
const BLOB_ID = "blob_is2_5_fixture";
const MODEL = "rhart-video-g/image-to-video";

type Fixture = {
  root: string;
  sqlitePath: string;
  mediaRoot: string;
  imagePath: string;
  db: DatabaseSync;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "s3b-t2-is2_5-"));
  const dataRoot = join(root, "data");
  const mediaRoot = join(dataRoot, "media");
  mkdirSync(mediaRoot, { recursive: true });
  const imagePath = join(mediaRoot, "storyboard.png");
  writeFileSync(imagePath, PNG);
  const sqlitePath = join(dataRoot, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA foreign_keys = ON");

  const project: Project = {
    project_id: PROJECT_ID,
    title: "IS2.5 fixture project",
    project_type: "m0_video_loop",
    status: "storyboard_approved",
    brief: {},
    video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "480p" },
    shot_ids: [SHOT_ID],
    active_storyboard_package_id: PACKAGE_ID,
    generation_batch_ids: [],
    exports: { final_video_artifact_id: "" }
  };
  saveProject(db, project);
  db.prepare("UPDATE workbench_project_meta SET classification = 'production', lifecycle = 'active' WHERE project_id = ?").run(PROJECT_ID);

  const shot: Shot = {
    shot_id: SHOT_ID,
    project_id: PROJECT_ID,
    order: 1,
    status: "storyboard_approved",
    duration_seconds: 6,
    description: "A frozen fixture storyboard.",
    storyboard_image_artifact_id: ARTIFACT_ID,
    video_prompt: "Animate the fixture image with a gentle camera move.",
    negative_prompt: "No deformation.",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  saveShot(db, shot);

  const sha256 = createHash("sha256").update(PNG).digest("hex");
  db.prepare(`INSERT INTO media_blobs
    (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, 'image/png', ?, 'verified', ?)`)
    .run(BLOB_ID, sha256, PNG.length, imagePath, JSON.stringify({ media_root: mediaRoot }));
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)`)
    .run(ARTIFACT_ID, PROJECT_ID, SHOT_ID, JSON.stringify({
      artifact_id: ARTIFACT_ID,
      blob_id: BLOB_ID,
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: imagePath, mime_type: "image/png", filename: "storyboard.png" },
      metadata: { width: 1, height: 1, duration_seconds: null, aspect_ratio: "9:16", sha256 },
      linked_objects: { project_id: PROJECT_ID, shot_id: SHOT_ID },
      source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256, external_url_host: "" }
    }));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(ARTIFACT_ID, BLOB_ID);

  db.prepare(`INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json)
    VALUES (?, ?, ?)`)
    .run(PACKAGE_ID, PROJECT_ID, JSON.stringify({
      storyboard_package_id: PACKAGE_ID,
      project_id: PROJECT_ID,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [{
        shot_id: SHOT_ID,
        order: 1,
        duration_seconds: 6,
        description: shot.description,
        storyboard_image_artifact_id: ARTIFACT_ID,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt
      }],
      user_approval: { storyboard_approved: true }
    }));

  return { root, sqlitePath, mediaRoot, imagePath, db };
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function intentCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM generation_intents").get() as { count: number }).count);
}

function prepareFixture(fixture: Fixture) {
  const prepared = prepareGeneration({ project_id: PROJECT_ID, shot_id: SHOT_ID }, fixture.db);
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared;
}

test("IS2.5 prepare compiles one GenerationPlan and confirm writes the canonical intent atomically", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    assert.equal(prepared.data.decision.state, "ELIGIBLE");
    assert.equal(prepared.data.plan.schema_version, "generation_plan.v1");
    assert.match(prepared.data.plan.input_digest, /^[0-9a-f]{64}$/);
    assert.equal(intentCount(fixture.db), 0);

    const confirmed = confirmGeneration(prepared.data.plan, fixture.db);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.data.status, "queued");
    assert.equal(intentCount(fixture.db), 1);
    const stored = fixture.db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(confirmed.data.intent.intent_id) as { data_json: string };
    const data = JSON.parse(stored.data_json) as { generation_plan?: { schema_version?: string }; input_snapshot?: { prepared_by?: string } };
    assert.equal(data.generation_plan?.schema_version, "generation_plan.v1");
    assert.equal(data.input_snapshot?.prepared_by, "t2_admission");
  } finally {
    closeFixture(fixture);
  }
});

test("IS2.5 confirmation rejects SHOT, package, and persisted Artifact binding drift", () => {
  for (const drift of ["shot", "package", "artifact"] as const) {
    const fixture = createFixture();
    try {
      const prepared = prepareFixture(fixture);
      if (drift === "shot") {
        const row = fixture.db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(SHOT_ID) as { data_json: string };
        const shot = JSON.parse(row.data_json) as Shot;
        shot.video_prompt = "A drifted prompt.";
        fixture.db.prepare("UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE shot_id = ?").run(JSON.stringify(shot), SHOT_ID);
      } else if (drift === "package") {
        const row = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(PACKAGE_ID) as { data_json: string };
        const storyboardPackage = JSON.parse(row.data_json) as { approved_shot_snapshots: Array<{ video_prompt: string }> };
        storyboardPackage.approved_shot_snapshots[0].video_prompt = "A drifted frozen prompt.";
        fixture.db.prepare("UPDATE storyboard_packages SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE storyboard_package_id = ?")
          .run(JSON.stringify(storyboardPackage), PACKAGE_ID);
      } else {
        const row = fixture.db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(ARTIFACT_ID) as { data_json: string };
        const artifact = JSON.parse(row.data_json) as { linked_objects: { shot_id: string } };
        artifact.linked_objects.shot_id = "other_shot";
        fixture.db.prepare("UPDATE media_artifacts SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE artifact_id = ?")
          .run(JSON.stringify(artifact), ARTIFACT_ID);
      }
      const confirmed = confirmGeneration(prepared.data.plan, fixture.db);
      assert.equal(confirmed.ok, false, drift);
      if (confirmed.ok) throw new Error(`${drift} drift unexpectedly confirmed`);
      assert.equal(confirmed.error.code, "GENERATION_PLAN_STALE", drift);
      assert.equal(intentCount(fixture.db), 0);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("IS2.5 confirmation ignores unrelated world drift while retaining the selected facts", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const unrelatedProjectId = "project_unrelated_drift";
    const unrelatedShotId = "shot_unrelated_drift";
    const unrelatedArtifactId = "artifact_unrelated_drift";
    const unrelatedBlobId = "blob_unrelated_drift";
    const unrelatedProject: Project = {
      project_id: unrelatedProjectId,
      title: "Unrelated fixture project",
      project_type: "m0_video_loop",
      status: "draft",
      brief: {},
      video_spec: { duration_seconds: 15, aspect_ratio: "16:9", resolution: "480p" },
      shot_ids: [unrelatedShotId],
      active_storyboard_package_id: "",
      generation_batch_ids: [],
      exports: { final_video_artifact_id: "" }
    };
    saveProject(fixture.db, unrelatedProject);
    saveShot(fixture.db, {
      shot_id: unrelatedShotId,
      project_id: unrelatedProjectId,
      order: 1,
      status: "draft",
      duration_seconds: 6,
      description: "Unrelated shot drift.",
      storyboard_image_artifact_id: "",
      video_prompt: "Unrelated prompt.",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    });
    const unrelatedSha256 = createHash("sha256").update("unrelated-world-blob").digest("hex");
    const unrelatedPath = join(fixture.mediaRoot, "unrelated.bin");
    fixture.db.prepare(`INSERT INTO media_blobs
      (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
      VALUES (?, ?, 19, 'application/octet-stream', ?, 'unverified', ?)`)
      .run(unrelatedBlobId, unrelatedSha256, unrelatedPath, JSON.stringify({ media_root: fixture.mediaRoot }));
    fixture.db.prepare(`INSERT INTO media_artifacts
      (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
      VALUES (?, ?, ?, 'storyboard_image', 'image', 'archived', ?)`)
      .run(unrelatedArtifactId, unrelatedProjectId, unrelatedShotId, JSON.stringify({
        artifact_id: unrelatedArtifactId,
        blob_id: unrelatedBlobId,
        artifact_type: "image",
        role: "storyboard_image",
        status: "archived",
        storage: { uri: unrelatedPath, mime_type: "application/octet-stream", filename: "unrelated.bin" },
        metadata: { width: 0, height: 0, duration_seconds: null, aspect_ratio: "", sha256: unrelatedSha256 },
        linked_objects: { project_id: unrelatedProjectId, shot_id: unrelatedShotId },
        source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: unrelatedSha256, external_url_host: "" }
      }));
    fixture.db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(unrelatedArtifactId, unrelatedBlobId);
    const confirmed = confirmGeneration(prepared.data.plan, fixture.db);
    assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error.code);
    assert.equal(intentCount(fixture.db), 1);
  } finally {
    closeFixture(fixture);
  }
});

test("IS2.5 active-generation race and repeated confirmation admit at most one intent", () => {
  const first = createFixture();
  try {
    const prepared = prepareFixture(first);
    const secondDb = new DatabaseSync(first.sqlitePath);
    secondDb.exec("PRAGMA foreign_keys = ON");
    try {
      const firstConfirmed = confirmGeneration(prepared.data.plan, first.db);
      assert.equal(firstConfirmed.ok, true, firstConfirmed.ok ? "" : firstConfirmed.error.code);
      const repeated = confirmGeneration(prepared.data.plan, secondDb);
      assert.equal(repeated.ok, false);
      if (repeated.ok) throw new Error("repeated confirmation unexpectedly succeeded");
      assert.equal(repeated.error.code, "REAL_GENERATION_ALREADY_ACTIVE");
      assert.equal(intentCount(first.db), 1);
      assert.equal(intentCount(secondDb), 1);
    } finally {
      secondDb.close();
    }
  } finally {
    closeFixture(first);
  }

  const raced = createFixture();
  try {
    const prepared = prepareFixture(raced);
    raced.db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
       duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
       confirmed, expires_at, provider_task_id, status, data_json)
      VALUES ('intent_existing_active', ?, ?, 'runninghub', 'personal', ?, ?, 6, '480p', 0, 0, 'UNSET', 1,
        datetime('now', '+1 hour'), '', 'queued', '{}')`)
      .run(PROJECT_ID, SHOT_ID, MODEL, ARTIFACT_ID);
    const confirmed = confirmGeneration(prepared.data.plan, raced.db);
    assert.equal(confirmed.ok, false);
    if (confirmed.ok) throw new Error("active-generation race unexpectedly succeeded");
    assert.equal(confirmed.error.code, "REAL_GENERATION_ALREADY_ACTIVE");
    assert.equal(intentCount(raced.db), 1);
  } finally {
    closeFixture(raced);
  }
});

test("IS2.5 media verification becomes stale before Provider selection and no adapter is called", async () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const confirmed = confirmGeneration(prepared.data.plan, fixture.db);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    assert.equal(confirmed.ok, true);

    writeFileSync(fixture.imagePath, Buffer.from("not the verified storyboard bytes"));
    const stale = revalidateGenerationPlanMedia(prepared.data.plan, fixture.db);
    assert.equal(stale.ok, false);
    if (stale.ok) throw new Error("stale media unexpectedly revalidated");
    assert.equal(stale.code, "MEDIA_VERIFICATION_STALE");

    let adapterCalls = 0;
    await runWorkbenchGenerationOnce(confirmed.data.intent.intent_id, {
      allow_submit: true,
      dependencies: {
        sqlite_path: fixture.sqlitePath,
        adapter_factory: () => {
          adapterCalls += 1;
          throw new Error("Provider adapter must not be constructed after media staleness.");
        }
      }
    });
    assert.equal(adapterCalls, 0);
    const row = fixture.db.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(confirmed.data.intent.intent_id) as { status: string; sanitized_error_json: string };
    assert.equal(row.status, "failed");
    assert.equal((JSON.parse(row.sanitized_error_json) as { code: string }).code, "MEDIA_VERIFICATION_STALE");
  } finally {
    closeFixture(fixture);
  }
});
