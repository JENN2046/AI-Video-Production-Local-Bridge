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
  prepareGeneration
} from "../src/tools/s3bT2GenerationAdmission.js";
import {
  cancelPreparedGenerationIntent,
  confirmWorkbenchGeneration,
  generationRightConflict,
  preflightWorkbenchGeneration,
  resumeWorkbenchGenerationJobs,
  runWorkbenchGenerationOnce,
  startWorkbenchGeneration,
  type WorkbenchGenerationDependencies
} from "../src/tools/workbenchGeneration.js";
import { getStoryboardPackage } from "../src/tools/storyboardPackages.js";
import { readGenerationAdmissionFacts } from "../src/tools/s3bT2AdmissionFacts.js";
import { evaluateGenerationAdmission } from "../src/tools/s3bT2AdmissionEvaluate.js";

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

type WorkbenchIntentSnapshot = {
  balance_gate: string;
  requires_human_preflight?: boolean;
  admission_only?: boolean;
  prepared_by?: string;
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

function confirmT2Fixture(fixture: Fixture) {
  const prepared = prepareFixture(fixture);
  const confirmed = confirmGeneration(prepared.data.plan, fixture.db);
  if (!confirmed.ok) throw new Error(confirmed.error.code);
  return { prepared, confirmed };
}

function fixtureExecutionDependencies(
  fixture: Fixture,
  counters: { preflight_requests: number; adapter_constructs: number; provider_submits: number }
): WorkbenchGenerationDependencies {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    M1_REAL_PROVIDER: "runninghub",
    REAL_PROVIDER_ENABLED: "true",
    M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
    M1_REAL_PROVIDER_COST_ACK: "true",
    RUNNINGHUB_API_KEY: "p1-fixture-key",
    PROVIDER_TASK_POLL_TIMEOUT_MS: "1000"
  };
  const fixtureProviderError = { code: "FIXTURE_PROVIDER_STOP", message: "fixture provider stop", retryable: false } as const;
  return {
    sqlite_path: fixture.sqlitePath,
    env,
    fetch_impl: async (input) => {
      counters.preflight_requests += 1;
      const url = String(input);
      if (url.endsWith("/uc/openapi/accountStatus")) {
        return new Response(JSON.stringify({ data: { currency: "CNY", remainMoney: 100, remainCoins: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ estimatedPrice: 1, currency: "CNY" }), { status: 200 });
    },
    adapter_factory: () => {
      counters.adapter_constructs += 1;
      return {
        provider_name: "runninghub" as const,
        model_name: MODEL,
        submitGeneration: async () => {
          counters.provider_submits += 1;
          return { ok: false as const, error: fixtureProviderError };
        },
        pollStatus: async () => ({ ok: false as const, error: fixtureProviderError }),
        fetchOutput: async () => ({ ok: false as const, error: fixtureProviderError })
      };
    }
  };
}

function mutatePersistedIntentData(
  fixture: Fixture,
  intentId: string,
  mutate: (data: Record<string, unknown>) => void
): void {
  const row = fixture.db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
    .get(intentId) as { data_json: string };
  const data = JSON.parse(row.data_json) as Record<string, unknown>;
  mutate(data);
  fixture.db.prepare("UPDATE generation_intents SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE intent_id = ?")
    .run(JSON.stringify(data), intentId);
}

async function promoteT2FixtureToQueued(
  fixture: Fixture,
  counters: { preflight_requests: number; adapter_constructs: number; provider_submits: number }
) {
  const { confirmed: admitted } = confirmT2Fixture(fixture);
  const dependencies = fixtureExecutionDependencies(fixture, counters);
  const preflight = await preflightWorkbenchGeneration({
    project_id: PROJECT_ID,
    shot_id: SHOT_ID,
    account_label: "personal",
    budget_limit_value: 10
  }, fixture.db, dependencies);
  if (!preflight.ok) throw new Error(preflight.error.code);
  const confirmed = confirmWorkbenchGeneration({
    intent_id: admitted.data.intent.intent_id,
    budget_limit_value: 10,
    cost_confirmed: true,
    human_confirmation: true
  }, fixture.db, dependencies);
  if (!confirmed.ok) throw new Error(confirmed.error.code);
  return { admitted, confirmed, dependencies };
}

async function waitForGenerationJobState(
  fixture: Fixture,
  intentId: string,
  expectedState: string
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = fixture.db.prepare("SELECT state, lease_token FROM generation_jobs WHERE intent_id = ?")
      .get(intentId) as { state: string; lease_token: string };
    if (job.state === expectedState && job.lease_token === "") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const job = fixture.db.prepare("SELECT state, lease_token FROM generation_jobs WHERE intent_id = ?")
    .get(intentId) as { state: string; lease_token: string };
  assert.deepEqual(job, { state: expectedState, lease_token: "" });
}

function addUnrelatedWorldDrift(fixture: Fixture): void {
  const unrelatedProjectId = "project_unrelated_promotion_drift";
  const unrelatedShotId = "shot_unrelated_promotion_drift";
  const unrelatedArtifactId = "artifact_unrelated_promotion_drift";
  const unrelatedBlobId = "blob_unrelated_promotion_drift";
  const unrelatedProject: Project = {
    project_id: unrelatedProjectId,
    title: "Unrelated promotion project",
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
    description: "Unrelated promotion drift.",
    storyboard_image_artifact_id: "",
    video_prompt: "Unrelated prompt.",
    negative_prompt: "",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  });
  const unrelatedSha256 = createHash("sha256").update("unrelated-promotion-blob").digest("hex");
  const unrelatedPath = join(fixture.mediaRoot, "unrelated-promotion.bin");
  fixture.db.prepare(`INSERT INTO media_blobs
    (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, 26, 'application/octet-stream', ?, 'unverified', ?)`)
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
      storage: { uri: unrelatedPath, mime_type: "application/octet-stream", filename: "unrelated-promotion.bin" },
      metadata: { width: 0, height: 0, duration_seconds: null, aspect_ratio: "", sha256: unrelatedSha256 },
      linked_objects: { project_id: unrelatedProjectId, shot_id: unrelatedShotId },
      source: { kind: "fixture_path", provider: "", provider_job_id: "", sha256: unrelatedSha256, external_url_host: "" }
    }));
  fixture.db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(unrelatedArtifactId, unrelatedBlobId);
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
    assert.equal(confirmed.data.status, "prepared");
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

test("P1 T2 confirm creates one prepared reservation without a runnable job", async () => {
  const fixture = createFixture();
  try {
    const { confirmed } = confirmT2Fixture(fixture);
    assert.equal(confirmed.data.status, "prepared");
    assert.equal(intentCount(fixture.db), 1);
    assert.equal(Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get() as { count: number }).count), 0);
    assert.equal(Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM generation_runs").get() as { count: number }).count), 0);
    const row = fixture.db.prepare("SELECT status, confirmed, run_id, data_json FROM generation_intents WHERE intent_id = ?")
      .get(confirmed.data.intent.intent_id) as { status: string; confirmed: number; run_id: string | null; data_json: string };
    const inputSnapshot = (JSON.parse(row.data_json) as { input_snapshot: WorkbenchIntentSnapshot }).input_snapshot;
    assert.deepEqual({ status: row.status, confirmed: row.confirmed, run_id: row.run_id }, { status: "prepared", confirmed: 0, run_id: null });
    assert.deepEqual({
      balance_gate: inputSnapshot.balance_gate,
      requires_human_preflight: inputSnapshot.requires_human_preflight,
      admission_only: inputSnapshot.admission_only
    }, { balance_gate: "not_checked", requires_human_preflight: true, admission_only: true });
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    await runWorkbenchGenerationOnce(confirmed.data.intent.intent_id, { allow_submit: true, dependencies: fixtureExecutionDependencies(fixture, counters) });
    assert.deepEqual(counters, { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 });
  } finally {
    closeFixture(fixture);
  }
});

test("P1 second T2 confirm conflicts with the prepared reservation", () => {
  const fixture = createFixture();
  try {
    confirmT2Fixture(fixture);
    const secondPrepared = prepareFixture(fixture);
    const second = confirmGeneration(secondPrepared.data.plan, fixture.db);
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("second T2 confirmation unexpectedly succeeded");
    assert.equal(second.error.code, "REAL_GENERATION_ALREADY_ACTIVE");
    assert.equal(intentCount(fixture.db), 1);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 resume ignores a prepared T2 reservation before preflight", async () => {
  const fixture = createFixture();
  try {
    const { confirmed } = confirmT2Fixture(fixture);
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const resumed = resumeWorkbenchGenerationJobs(fixtureExecutionDependencies(fixture, counters));
    assert.deepEqual(resumed, { resumed: [], reconciled: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(counters, { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 });
    const row = fixture.db.prepare("SELECT status, confirmed FROM generation_intents WHERE intent_id = ?")
      .get(confirmed.data.intent.intent_id) as { status: string; confirmed: number };
    assert.equal(row.status, "prepared");
    assert.equal(row.confirmed, 0);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 existing preflight upgrades the same T2 reservation and execution submits once", async () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const dependencies = fixtureExecutionDependencies(fixture, counters);
    const preflight = await preflightWorkbenchGeneration({
      project_id: PROJECT_ID,
      shot_id: SHOT_ID,
      account_label: "personal",
      budget_limit_value: 10
    }, fixture.db, dependencies);
    if (!preflight.ok) throw new Error(preflight.error.code);
    assert.equal(preflight.data.intent.intent_id, admitted.data.intent.intent_id);
    const staged = JSON.parse((fixture.db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(admitted.data.intent.intent_id) as { data_json: string }).data_json) as { input_snapshot: WorkbenchIntentSnapshot };
    assert.equal(staged.input_snapshot.balance_gate, "pass");
    assert.equal(staged.input_snapshot.requires_human_preflight, false);
    assert.equal(staged.input_snapshot.admission_only, true);
    assert.equal(intentCount(fixture.db), 1);
    assert.equal(Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get() as { count: number }).count), 0);

    const confirmed = confirmWorkbenchGeneration({
      intent_id: admitted.data.intent.intent_id,
      budget_limit_value: 10,
      cost_confirmed: true,
      human_confirmation: true
    }, fixture.db, dependencies);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    assert.equal(confirmed.data.intent.intent_id, admitted.data.intent.intent_id);
    assert.equal(confirmed.data.status, "queued");
    assert.equal(intentCount(fixture.db), 1);
    await runWorkbenchGenerationOnce(admitted.data.intent.intent_id, { allow_submit: true, dependencies });
    assert.equal(counters.preflight_requests, 2);
    assert.equal(counters.provider_submits, 1);
    assert.equal(Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM generation_intents").get() as { count: number }).count), 1);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 preflight terminalizes stale SHOT and project inputs before returning", async () => {
  for (const drift of ["shot", "project"] as const) {
    const fixture = createFixture();
    try {
      const { confirmed: admitted } = confirmT2Fixture(fixture);
      if (drift === "shot") {
        const row = fixture.db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(SHOT_ID) as { data_json: string };
        const shot = JSON.parse(row.data_json) as Shot;
        shot.video_prompt = "A preflight-drifted prompt.";
        fixture.db.prepare("UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE shot_id = ?")
          .run(JSON.stringify(shot), SHOT_ID);
      } else {
        const row = fixture.db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(PROJECT_ID) as { data_json: string };
        const project = JSON.parse(row.data_json) as Project;
        project.video_spec.resolution = "720p";
        saveProject(fixture.db, project);
      }
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const preflight = await preflightWorkbenchGeneration({
        project_id: PROJECT_ID,
        shot_id: SHOT_ID,
        account_label: "personal",
        budget_limit_value: 10
      }, fixture.db, fixtureExecutionDependencies(fixture, counters));
      assert.equal(preflight.ok, false, drift);
      if (preflight.ok) throw new Error(`${drift} drift unexpectedly passed preflight`);
      assert.equal(preflight.error.code, "GENERATION_INTENT_INPUT_STALE", drift);
      const row = fixture.db.prepare("SELECT status, confirmed, sanitized_error_json, data_json FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { status: string; confirmed: number; sanitized_error_json: string; data_json: string };
      assert.deepEqual({ status: row.status, confirmed: row.confirmed }, { status: "cancelled", confirmed: 0 }, drift);
      assert.equal((JSON.parse(row.sanitized_error_json) as { code?: string }).code, "GENERATION_INTENT_INPUT_STALE", drift);
      assert.equal((JSON.parse(row.data_json) as { generation_plan?: { schema_version?: string } }).generation_plan?.schema_version, "generation_plan.v1", drift);
      assert.equal(generationRightConflict(fixture.db), null, drift);
      assert.deepEqual(counters, { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 }, drift);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("P1 package, Artifact, and Provider capability drift before preflight terminalize the same reservation", async () => {
  for (const drift of ["package", "artifact", "capability"] as const) {
    const fixture = createFixture();
    try {
      const { confirmed: admitted } = confirmT2Fixture(fixture);
      if (drift === "package") {
        const row = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(PACKAGE_ID) as { data_json: string };
        const storyboardPackage = JSON.parse(row.data_json) as { approved_shot_snapshots: Array<{ video_prompt: string }> };
        storyboardPackage.approved_shot_snapshots[0].video_prompt = "A package-drifted frozen prompt.";
        fixture.db.prepare("UPDATE storyboard_packages SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE storyboard_package_id = ?")
          .run(JSON.stringify(storyboardPackage), PACKAGE_ID);
      } else if (drift === "artifact") {
        const row = fixture.db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(ARTIFACT_ID) as { data_json: string };
        const artifact = JSON.parse(row.data_json) as { linked_objects: { shot_id: string } };
        artifact.linked_objects.shot_id = "other_preflight_shot";
        fixture.db.prepare("UPDATE media_artifacts SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE artifact_id = ?")
          .run(JSON.stringify(artifact), ARTIFACT_ID);
      } else {
        const row = fixture.db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(PROJECT_ID) as { data_json: string };
        const project = JSON.parse(row.data_json) as Project;
        project.video_spec.resolution = "720p";
        saveProject(fixture.db, project);
      }
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const preflight = await preflightWorkbenchGeneration({
        project_id: PROJECT_ID,
        shot_id: SHOT_ID,
        account_label: "personal",
        budget_limit_value: 10
      }, fixture.db, fixtureExecutionDependencies(fixture, counters));
      assert.equal(preflight.ok, false, drift);
      if (preflight.ok) throw new Error(`${drift} drift unexpectedly passed preflight`);
      assert.equal(preflight.error.code, drift === "capability" ? "GENERATION_INTENT_INPUT_STALE" : "GENERATION_PLAN_STALE", drift);
      const row = fixture.db.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { status: string; sanitized_error_json: string };
      assert.equal(row.status, "cancelled", drift);
      assert.equal((JSON.parse(row.sanitized_error_json) as { code?: string }).code, preflight.error.code, drift);
      assert.equal(generationRightConflict(fixture.db), null, drift);
      assert.deepEqual(counters, { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 }, drift);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("P1 preflight stale remains historical across restart and requires a new prepare/confirm", async () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const shotRow = fixture.db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(SHOT_ID) as { data_json: string };
    const shot = JSON.parse(shotRow.data_json) as Shot;
    shot.video_prompt = "A restart-safe replacement prompt.";
    fixture.db.prepare("UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE shot_id = ?")
      .run(JSON.stringify(shot), SHOT_ID);
    const preflight = await preflightWorkbenchGeneration({
      project_id: PROJECT_ID,
      shot_id: SHOT_ID,
      account_label: "personal",
      budget_limit_value: 10
    }, fixture.db, fixtureExecutionDependencies(fixture, { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 }));
    assert.equal(preflight.ok, false);
    if (preflight.ok) throw new Error("stale reservation unexpectedly passed preflight");
    assert.equal(preflight.error.code, "GENERATION_INTENT_INPUT_STALE");
    assert.equal(intentCount(fixture.db), 1);
    assert.equal(generationRightConflict(fixture.db), null);

    const packageRow = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(PACKAGE_ID) as { data_json: string };
    const storyboardPackage = JSON.parse(packageRow.data_json) as { approved_shot_snapshots: Array<{ video_prompt: string }> };
    storyboardPackage.approved_shot_snapshots[0].video_prompt = shot.video_prompt;
    fixture.db.prepare("UPDATE storyboard_packages SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE storyboard_package_id = ?")
      .run(JSON.stringify(storyboardPackage), PACKAGE_ID);

    const restartedDb = new DatabaseSync(fixture.sqlitePath);
    try {
      restartedDb.exec("PRAGMA foreign_keys = ON");
      assert.equal(generationRightConflict(restartedDb), null);
      const replacementPrepared = prepareGeneration({ project_id: PROJECT_ID, shot_id: SHOT_ID }, restartedDb);
      if (!replacementPrepared.ok) throw new Error(replacementPrepared.error.code);
      assert.equal(replacementPrepared.ok, true);
      const replacement = confirmGeneration(replacementPrepared.data.plan, restartedDb);
      if (!replacement.ok) throw new Error(replacement.error.code);
      assert.equal(replacement.ok, true);
      assert.notEqual(replacement.data.intent.intent_id, admitted.data.intent.intent_id);
      assert.equal(intentCount(restartedDb), 2);
      const rows = restartedDb.prepare("SELECT intent_id, status FROM generation_intents ORDER BY created_at, intent_id").all() as Array<{ intent_id: string; status: string }>;
      assert.equal(rows.find((row) => row.intent_id === admitted.data.intent.intent_id)?.status, "cancelled");
      assert.equal(rows.find((row) => row.intent_id === replacement.data.intent.intent_id)?.status, "prepared");
      assert.equal(generationRightConflict(restartedDb)?.intent_id, replacement.data.intent.intent_id);
    } finally {
      restartedDb.close();
    }
  } finally {
    closeFixture(fixture);
  }
});

test("P1 non-stale balance and transient preflight failures retain the prepared generation right", async () => {
  for (const failure of ["balance", "transient"] as const) {
    const fixture = createFixture();
    try {
      const { confirmed: admitted } = confirmT2Fixture(fixture);
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const dependencies: WorkbenchGenerationDependencies = fixtureExecutionDependencies(fixture, counters);
      dependencies.fetch_impl = async (input) => {
        counters.preflight_requests += 1;
        if (failure === "transient") throw new Error("fixture transient preflight failure");
        const url = String(input);
        return url.endsWith("/uc/openapi/accountStatus")
          ? new Response(JSON.stringify({ data: { currency: "CNY", remainMoney: 0, remainCoins: 0 } }), { status: 200 })
          : new Response(JSON.stringify({ estimatedPrice: 1, currency: "CNY" }), { status: 200 });
      };
      const preflight = await preflightWorkbenchGeneration({
        project_id: PROJECT_ID,
        shot_id: SHOT_ID,
        account_label: "personal",
        budget_limit_value: 10
      }, fixture.db, dependencies);
      assert.equal(preflight.ok, false, failure);
      if (preflight.ok) throw new Error(`${failure} preflight unexpectedly passed`);
      assert.equal(preflight.error.code, failure === "balance" ? "BALANCE_GATE_UNKNOWN_OR_INSUFFICIENT" : "PROVIDER_REQUEST_FAILED", failure);
      const row = fixture.db.prepare("SELECT status, confirmed FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { status: string; confirmed: number };
      assert.deepEqual({ status: row.status, confirmed: row.confirmed }, { status: "prepared", confirmed: 0 }, failure);
      assert.equal(generationRightConflict(fixture.db)?.intent_id, admitted.data.intent.intent_id, failure);
      assert.equal(counters.provider_submits, 0, failure);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("P1 promotion retires shot, package, and persisted Artifact drift as a stale reservation", async () => {
  for (const drift of ["shot", "package", "artifact"] as const) {
    const fixture = createFixture();
    try {
      const { confirmed: admitted } = confirmT2Fixture(fixture);
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const dependencies = fixtureExecutionDependencies(fixture, counters);
      const preflight = await preflightWorkbenchGeneration({
        project_id: PROJECT_ID,
        shot_id: SHOT_ID,
        account_label: "personal",
        budget_limit_value: 10
      }, fixture.db, dependencies);
      if (!preflight.ok) throw new Error(preflight.error.code);
      if (drift === "shot") {
        const row = fixture.db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(SHOT_ID) as { data_json: string };
        const shot = JSON.parse(row.data_json) as Shot;
        shot.video_prompt = "A promotion-drifted prompt.";
        fixture.db.prepare("UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE shot_id = ?")
          .run(JSON.stringify(shot), SHOT_ID);
      } else if (drift === "package") {
        const row = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(PACKAGE_ID) as { data_json: string };
        const storyboardPackage = JSON.parse(row.data_json) as { approved_shot_snapshots: Array<{ video_prompt: string }> };
        storyboardPackage.approved_shot_snapshots[0].video_prompt = "A promotion-drifted frozen prompt.";
        fixture.db.prepare("UPDATE storyboard_packages SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE storyboard_package_id = ?")
          .run(JSON.stringify(storyboardPackage), PACKAGE_ID);
      } else {
        const row = fixture.db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(ARTIFACT_ID) as { data_json: string };
        const artifact = JSON.parse(row.data_json) as { linked_objects: { shot_id: string } };
        artifact.linked_objects.shot_id = "other_promotion_shot";
        fixture.db.prepare("UPDATE media_artifacts SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE artifact_id = ?")
          .run(JSON.stringify(artifact), ARTIFACT_ID);
      }
      const promoted = confirmWorkbenchGeneration({
        intent_id: admitted.data.intent.intent_id,
        budget_limit_value: 10,
        cost_confirmed: true,
        human_confirmation: true
      }, fixture.db, dependencies);
      assert.equal(promoted.ok, false, drift);
      if (promoted.ok) throw new Error(`${drift} drift unexpectedly promoted`);
      assert.equal(promoted.error.code, "GENERATION_PLAN_STALE", drift);
      const row = fixture.db.prepare("SELECT status, sanitized_error_json, data_json FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { status: string; sanitized_error_json: string; data_json: string };
      assert.equal(row.status, "cancelled", drift);
      assert.equal((JSON.parse(row.sanitized_error_json) as { code?: string }).code, "GENERATION_PLAN_STALE", drift);
      assert.equal((JSON.parse(row.data_json) as { generation_plan?: { schema_version?: string } }).generation_plan?.schema_version, "generation_plan.v1", drift);
      assert.equal(generationRightConflict(fixture.db), null, drift);
      assert.equal(counters.provider_submits, 0, drift);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("P1 promotion detects stale facts before preflight authorization and releases the right", () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const row = fixture.db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(SHOT_ID) as { data_json: string };
    const shot = JSON.parse(row.data_json) as Shot;
    shot.video_prompt = "A stale-before-preflight prompt.";
    fixture.db.prepare("UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE shot_id = ?")
      .run(JSON.stringify(shot), SHOT_ID);
    const promoted = confirmWorkbenchGeneration({
      intent_id: admitted.data.intent.intent_id,
      budget_limit_value: 10,
      cost_confirmed: true,
      human_confirmation: true
    }, fixture.db);
    assert.equal(promoted.ok, false);
    if (promoted.ok) throw new Error("stale reservation unexpectedly promoted before preflight");
    assert.equal(promoted.error.code, "GENERATION_PLAN_STALE");
    const stored = fixture.db.prepare("SELECT status FROM generation_intents WHERE intent_id = ?")
      .get(admitted.data.intent.intent_id) as { status: string };
    assert.equal(stored.status, "cancelled");
    assert.equal(generationRightConflict(fixture.db), null);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 unrelated world drift does not invalidate a valid prepared reservation", async () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const dependencies = fixtureExecutionDependencies(fixture, counters);
    const preflight = await preflightWorkbenchGeneration({ project_id: PROJECT_ID, shot_id: SHOT_ID, account_label: "personal", budget_limit_value: 10 }, fixture.db, dependencies);
    if (!preflight.ok) throw new Error(preflight.error.code);
    addUnrelatedWorldDrift(fixture);
    const promoted = confirmWorkbenchGeneration({ intent_id: admitted.data.intent.intent_id, budget_limit_value: 10, cost_confirmed: true, human_confirmation: true }, fixture.db, dependencies);
    if (!promoted.ok) throw new Error(promoted.error.code);
    assert.equal(promoted.ok, true);
    assert.equal(promoted.data.intent.intent_id, admitted.data.intent.intent_id);
    await runWorkbenchGenerationOnce(admitted.data.intent.intent_id, { allow_submit: true, dependencies });
    assert.equal(counters.provider_submits, 1);
    assert.equal(generationRightConflict(fixture.db), null);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 stale reservation is retained as history and requires a new prepare/confirm for replacement", async () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const dependencies = fixtureExecutionDependencies(fixture, { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 });
    const preflight = await preflightWorkbenchGeneration({ project_id: PROJECT_ID, shot_id: SHOT_ID, account_label: "personal", budget_limit_value: 10 }, fixture.db, dependencies);
    if (!preflight.ok) throw new Error(preflight.error.code);
    const shotRow = fixture.db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(SHOT_ID) as { data_json: string };
    const shot = JSON.parse(shotRow.data_json) as Shot;
    shot.video_prompt = "A replacement-ready prompt.";
    fixture.db.prepare("UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE shot_id = ?").run(JSON.stringify(shot), SHOT_ID);
    const stale = confirmWorkbenchGeneration({ intent_id: admitted.data.intent.intent_id, budget_limit_value: 10, cost_confirmed: true, human_confirmation: true }, fixture.db, dependencies);
    assert.equal(stale.ok, false);
    if (stale.ok) throw new Error("stale reservation unexpectedly promoted");
    assert.equal(stale.error.code, "GENERATION_PLAN_STALE");

    const packageRow = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(PACKAGE_ID) as { data_json: string };
    const storyboardPackage = JSON.parse(packageRow.data_json) as { approved_shot_snapshots: Array<{ video_prompt: string }> };
    storyboardPackage.approved_shot_snapshots[0].video_prompt = shot.video_prompt;
    fixture.db.prepare("UPDATE storyboard_packages SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE storyboard_package_id = ?")
      .run(JSON.stringify(storyboardPackage), PACKAGE_ID);
    const replacement = confirmT2Fixture(fixture);
    assert.notEqual(replacement.confirmed.data.intent.intent_id, admitted.data.intent.intent_id);
    assert.equal(intentCount(fixture.db), 2);
    const rows = fixture.db.prepare("SELECT intent_id, status FROM generation_intents ORDER BY created_at, intent_id").all() as Array<{ intent_id: string; status: string }>;
    assert.equal(rows.find((row) => row.intent_id === admitted.data.intent.intent_id)?.status, "cancelled");
    assert.equal(rows.find((row) => row.intent_id === replacement.confirmed.data.intent.intent_id)?.status, "prepared");
    assert.equal(generationRightConflict(fixture.db)?.intent_id, replacement.confirmed.data.intent.intent_id);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 explicit cancellation releases a prepared reservation without Provider execution", async () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const cancelled = cancelPreparedGenerationIntent({ intent_id: admitted.data.intent.intent_id, human_confirmation: true }, fixture.db);
    if (!cancelled.ok) throw new Error(cancelled.error.code);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.data.intent.status, "cancelled");
    assert.equal(generationRightConflict(fixture.db), null);
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    await runWorkbenchGenerationOnce(admitted.data.intent.intent_id, { allow_submit: true, dependencies: fixtureExecutionDependencies(fixture, counters) });
    assert.deepEqual(counters, { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 });
    const replacement = confirmT2Fixture(fixture);
    assert.equal(intentCount(fixture.db), 2);
    assert.equal(generationRightConflict(fixture.db)?.intent_id, replacement.confirmed.data.intent.intent_id);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 restart after canonical preflight resumes the same executable reservation", async () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const dependencies = fixtureExecutionDependencies(fixture, counters);
    const preflight = await preflightWorkbenchGeneration({ project_id: PROJECT_ID, shot_id: SHOT_ID, account_label: "personal", budget_limit_value: 10 }, fixture.db, dependencies);
    if (!preflight.ok) throw new Error(preflight.error.code);
    const confirmed = confirmWorkbenchGeneration({ intent_id: admitted.data.intent.intent_id, budget_limit_value: 10, cost_confirmed: true, human_confirmation: true }, fixture.db, dependencies);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    const resumed = resumeWorkbenchGenerationJobs(dependencies);
    assert.deepEqual(resumed, { resumed: [admitted.data.intent.intent_id], reconciled: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(counters.provider_submits, 1);
    assert.equal(intentCount(fixture.db), 1);
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

test("T2 admission reservation never reaches Provider execution before preflight", async () => {
  const fixture = createFixture();
  try {
    const prepared = prepareFixture(fixture);
    const confirmed = confirmGeneration(prepared.data.plan, fixture.db);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    assert.equal(confirmed.ok, true);
    let adapterConstructs = 0;
    let adapterCalls = 0;
    await runWorkbenchGenerationOnce(confirmed.data.intent.intent_id, {
      allow_submit: true,
      dependencies: {
        sqlite_path: fixture.sqlitePath,
        adapter_factory: () => {
          adapterConstructs += 1;
          adapterCalls += 1;
          throw new Error("Provider adapter must not be constructed before preflight.");
        }
      }
    });
    assert.equal(adapterConstructs, 0);
    assert.equal(adapterCalls, 0);
    const row = fixture.db.prepare("SELECT status, confirmed, run_id FROM generation_intents WHERE intent_id = ?")
      .get(confirmed.data.intent.intent_id) as { status: string; confirmed: number; run_id: string | null };
    assert.equal(row.status, "prepared");
    assert.equal(row.confirmed, 0);
    assert.equal(row.run_id, null);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 unauthorized queued intent terminalizes once without Provider work or scheduler reselection", async () => {
  const fixture = createFixture();
  try {
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const promoted = await promoteT2FixtureToQueued(fixture, counters);
    const intentId = promoted.admitted.data.intent.intent_id;
    mutatePersistedIntentData(fixture, intentId, (data) => {
      const snapshot = data.input_snapshot as Record<string, unknown>;
      snapshot.balance_gate = "not_checked";
      snapshot.requires_human_preflight = true;
    });

    startWorkbenchGeneration(intentId, {
      allow_submit: true,
      dependencies: promoted.dependencies
    });
    await waitForGenerationJobState(fixture, intentId, "failed");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 0, provider_submits: 0 });
    const row = fixture.db.prepare("SELECT status, confirmed, sanitized_error_json, data_json FROM generation_intents WHERE intent_id = ?")
      .get(intentId) as { status: string; confirmed: number; sanitized_error_json: string; data_json: string };
    assert.equal(row.status, "failed");
    assert.equal(row.confirmed, 1);
    assert.equal((JSON.parse(row.sanitized_error_json) as { code?: string }).code, "OFFICIAL_PREFLIGHT_REQUIRED");
    assert.equal((JSON.parse(row.data_json) as { generation_plan?: { schema_version?: string } }).generation_plan?.schema_version, "generation_plan.v1");
    const job = fixture.db.prepare("SELECT state, reconciliation_reason, lease_token, lease_expires_at FROM generation_jobs WHERE intent_id = ?")
      .get(intentId) as { state: string; reconciliation_reason: string; lease_token: string; lease_expires_at: string | null };
    assert.deepEqual({ ...job }, {
      state: "failed",
      reconciliation_reason: "OFFICIAL_PREFLIGHT_REQUIRED",
      lease_token: "",
      lease_expires_at: null
    });
    const run = fixture.db.prepare("SELECT status, data_json FROM generation_runs WHERE run_id = ?")
      .get(promoted.confirmed.data.run_id) as { status: string; data_json: string };
    assert.equal(run.status, "failed");
    assert.equal((JSON.parse(run.data_json) as { error?: { code?: string } }).error?.code, "OFFICIAL_PREFLIGHT_REQUIRED");
    const history = fixture.db.prepare("SELECT reason_code FROM generation_job_events WHERE job_id = ? ORDER BY rowid")
      .all(promoted.confirmed.data.job_id) as Array<{ reason_code: string }>;
    assert.deepEqual(history.map((event) => event.reason_code), ["HUMAN_CONFIRMED", "OFFICIAL_PREFLIGHT_REQUIRED"]);
    assert.equal(generationRightConflict(fixture.db), null);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(resumeWorkbenchGenerationJobs(promoted.dependencies), { resumed: [], reconciled: [] });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const historyAfterResume = fixture.db.prepare("SELECT COUNT(*) AS count FROM generation_job_events WHERE job_id = ?")
      .get(promoted.confirmed.data.job_id) as { count: number };
    assert.equal(Number(historyAfterResume.count), history.length);
  } finally {
    closeFixture(fixture);
  }
});

test("P1 first-submit workers terminalize current Project and Package authority drift", async () => {
  for (const drift of ["project_classification", "package_approval", "active_package_replacement"] as const) {
    const fixture = createFixture();
    try {
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const promoted = await promoteT2FixtureToQueued(fixture, counters);
      const intentId = promoted.admitted.data.intent.intent_id;
      if (drift === "project_classification") {
        fixture.db.prepare("UPDATE workbench_project_meta SET classification = 'test', updated_at = CURRENT_TIMESTAMP WHERE project_id = ?")
          .run(PROJECT_ID);
      } else if (drift === "package_approval") {
        const row = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?")
          .get(PACKAGE_ID) as { data_json: string };
        const storyboardPackage = JSON.parse(row.data_json) as { user_approval: { storyboard_approved: boolean } };
        storyboardPackage.user_approval.storyboard_approved = false;
        fixture.db.prepare("UPDATE storyboard_packages SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE storyboard_package_id = ?")
          .run(JSON.stringify(storyboardPackage), PACKAGE_ID);
      } else {
        const replacementId = `${PACKAGE_ID}_replacement`;
        const row = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?")
          .get(PACKAGE_ID) as { data_json: string };
        const replacement = JSON.parse(row.data_json) as Record<string, unknown>;
        replacement.storyboard_package_id = replacementId;
        fixture.db.prepare("INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json) VALUES (?, ?, ?)")
          .run(replacementId, PROJECT_ID, JSON.stringify(replacement));
        const project = JSON.parse((fixture.db.prepare("SELECT data_json FROM projects WHERE project_id = ?")
          .get(PROJECT_ID) as { data_json: string }).data_json) as Project;
        project.active_storyboard_package_id = replacementId;
        saveProject(fixture.db, project);
      }

      if (drift === "project_classification") {
        await runWorkbenchGenerationOnce(intentId, { allow_submit: true, dependencies: promoted.dependencies });
      } else if (drift === "package_approval") {
        assert.deepEqual(resumeWorkbenchGenerationJobs(promoted.dependencies), { resumed: [intentId], reconciled: [] });
        await waitForGenerationJobState(fixture, intentId, "failed");
      } else {
        startWorkbenchGeneration(intentId, { allow_submit: true, dependencies: promoted.dependencies });
        await waitForGenerationJobState(fixture, intentId, "failed");
      }

      const intent = fixture.db.prepare("SELECT status, sanitized_error_json, data_json FROM generation_intents WHERE intent_id = ?")
        .get(intentId) as { status: string; sanitized_error_json: string; data_json: string };
      const job = fixture.db.prepare("SELECT state, reconciliation_reason, lease_token FROM generation_jobs WHERE intent_id = ?")
        .get(intentId) as { state: string; reconciliation_reason: string; lease_token: string };
      const run = fixture.db.prepare("SELECT status, data_json FROM generation_runs WHERE run_id = ?")
        .get(promoted.confirmed.data.run_id) as { status: string; data_json: string };
      assert.equal(intent.status, "failed", drift);
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code?: string }).code, "GENERATION_PLAN_STALE", drift);
      assert.equal((JSON.parse(intent.data_json) as { generation_plan?: { schema_version?: string } }).generation_plan?.schema_version, "generation_plan.v1", drift);
      assert.deepEqual({ ...job }, { state: "failed", reconciliation_reason: "GENERATION_PLAN_STALE", lease_token: "" }, drift);
      assert.equal(run.status, "failed", drift);
      assert.equal((JSON.parse(run.data_json) as { error?: { code?: string } }).error?.code, "GENERATION_PLAN_STALE", drift);
      assert.equal(generationRightConflict(fixture.db), null, drift);
      assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 0, provider_submits: 0 }, drift);
      const history = fixture.db.prepare("SELECT reason_code FROM generation_job_events WHERE job_id = ? ORDER BY rowid")
        .all(promoted.confirmed.data.job_id) as Array<{ reason_code: string }>;
      assert.deepEqual(history.map((event) => event.reason_code), ["HUMAN_CONFIRMED", "GENERATION_PLAN_STALE"], drift);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("P1 post-preflight media revalidation blocks Provider construction", async () => {
  const fixture = createFixture();
  try {
    const { confirmed: admitted } = confirmT2Fixture(fixture);
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const dependencies = fixtureExecutionDependencies(fixture, counters);
    const preflight = await preflightWorkbenchGeneration({
      project_id: PROJECT_ID,
      shot_id: SHOT_ID,
      account_label: "personal",
      budget_limit_value: 10
    }, fixture.db, dependencies);
    if (!preflight.ok) throw new Error(preflight.error.code);
    const workbenchConfirmation = confirmWorkbenchGeneration({
      intent_id: admitted.data.intent.intent_id,
      budget_limit_value: 10,
      cost_confirmed: true,
      human_confirmation: true
    }, fixture.db, dependencies);
    if (!workbenchConfirmation.ok) throw new Error(workbenchConfirmation.error.code);
    writeFileSync(fixture.imagePath, Buffer.from("fixture-media-drift-after-preflight"));
    await runWorkbenchGenerationOnce(admitted.data.intent.intent_id, { allow_submit: true, dependencies });
    assert.equal(counters.preflight_requests, 2);
    assert.equal(counters.adapter_constructs, 0);
    assert.equal(counters.provider_submits, 0);
    const row = fixture.db.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(admitted.data.intent.intent_id) as { status: string; sanitized_error_json: string };
    assert.equal(row.status, "failed");
    assert.equal((JSON.parse(row.sanitized_error_json) as { code?: string }).code, "MEDIA_VERIFICATION_STALE");
  } finally {
    closeFixture(fixture);
  }
});

test("P1 known Provider task keeps ownership across every GenerationPlan validation failure", async () => {
  const variants = ["invalid_plan", "media_drift"] as const;
  for (const variant of variants) {
    const fixture = createFixture();
    try {
      const { confirmed: admitted } = confirmT2Fixture(fixture);
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const dependencies = fixtureExecutionDependencies(fixture, counters);
      const preflight = await preflightWorkbenchGeneration({
        project_id: PROJECT_ID,
        shot_id: SHOT_ID,
        account_label: "personal",
        budget_limit_value: 10
      }, fixture.db, dependencies);
      if (!preflight.ok) throw new Error(preflight.error.code);
      const workbenchConfirmation = confirmWorkbenchGeneration({
        intent_id: admitted.data.intent.intent_id,
        budget_limit_value: 10,
        cost_confirmed: true,
        human_confirmation: true
      }, fixture.db, dependencies);
      if (!workbenchConfirmation.ok) throw new Error(workbenchConfirmation.error.code);

      const taskId = `known-task-${variant}`;
      const intentRow = fixture.db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { data_json: string };
      const intentData = JSON.parse(intentRow.data_json) as Record<string, unknown>;
      const pollStartedAt = Date.now();
      intentData.provider_poll_started_at = new Date(pollStartedAt).toISOString();
      intentData.provider_poll_timeout_ms = 1_000;
      intentData.provider_poll_deadline_at = new Date(pollStartedAt + 1_000).toISOString();
      if (variant === "invalid_plan") {
        intentData.generation_plan = { schema_version: "generation_plan.v1" };
      } else {
        writeFileSync(fixture.imagePath, Buffer.from("known-task-media-drift"));
      }
      fixture.db.prepare("UPDATE generation_intents SET provider_task_id = ?, status = 'running', data_json = ? WHERE intent_id = ?")
        .run(taskId, JSON.stringify(intentData), admitted.data.intent.intent_id);
      fixture.db.prepare("UPDATE generation_jobs SET state = 'polling' WHERE job_id = ?")
        .run(workbenchConfirmation.data.job_id);

      await runWorkbenchGenerationOnce(admitted.data.intent.intent_id, {
        allow_submit: false,
        dependencies
      });

      const intent = fixture.db.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { status: string; provider_task_id: string; sanitized_error_json: string };
      const job = fixture.db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE job_id = ?")
        .get(workbenchConfirmation.data.job_id) as { state: string; reconciliation_reason: string };
      assert.equal(intent.status, "running", variant);
      assert.equal(intent.provider_task_id, taskId, variant);
      assert.equal(
        (JSON.parse(intent.sanitized_error_json) as { code?: string }).code,
        variant === "invalid_plan" ? "GENERATION_PLAN_STALE" : "MEDIA_VERIFICATION_STALE",
        variant
      );
      assert.deepEqual(
        { ...job },
        { state: "manual_reconciliation", reconciliation_reason: "GENERATION_PLAN_REQUIRES_RECONCILIATION" },
        variant
      );
      assert.equal(generationRightConflict(fixture.db)?.intent_id, admitted.data.intent.intent_id, variant);
      assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 0, provider_submits: 0 }, variant);

      await runWorkbenchGenerationOnce(admitted.data.intent.intent_id, {
        allow_submit: true,
        dependencies
      });
      assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 0, provider_submits: 0 }, `${variant}: no duplicate submit`);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("P1 known Provider task bypasses ordinary first-submit authority failure and keeps ownership", async () => {
  const fixture = createFixture();
  try {
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const promoted = await promoteT2FixtureToQueued(fixture, counters);
    const intentId = promoted.admitted.data.intent.intent_id;
    const taskId = "known-task-after-authority-drift";
    mutatePersistedIntentData(fixture, intentId, (data) => {
      const now = Date.now();
      data.provider_poll_started_at = new Date(now).toISOString();
      data.provider_poll_timeout_ms = 1_000;
      data.provider_poll_deadline_at = new Date(now + 1_000).toISOString();
    });
    fixture.db.prepare("UPDATE generation_intents SET provider_task_id = ?, status = 'running' WHERE intent_id = ?")
      .run(taskId, intentId);
    fixture.db.prepare("UPDATE generation_jobs SET state = 'polling' WHERE job_id = ?")
      .run(promoted.confirmed.data.job_id);
    fixture.db.prepare("UPDATE workbench_project_meta SET classification = 'test', updated_at = CURRENT_TIMESTAMP WHERE project_id = ?")
      .run(PROJECT_ID);

    await runWorkbenchGenerationOnce(intentId, { allow_submit: false, dependencies: promoted.dependencies });

    const intent = fixture.db.prepare("SELECT status, provider_task_id, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
      .get(intentId) as { status: string; provider_task_id: string; sanitized_error_json: string };
    const job = fixture.db.prepare("SELECT state, reconciliation_reason, lease_token FROM generation_jobs WHERE job_id = ?")
      .get(promoted.confirmed.data.job_id) as { state: string; reconciliation_reason: string; lease_token: string };
    assert.equal(intent.status, "running");
    assert.equal(intent.provider_task_id, taskId);
    assert.equal((JSON.parse(intent.sanitized_error_json) as { code?: string }).code, "FIXTURE_PROVIDER_STOP");
    assert.deepEqual({ ...job }, {
      state: "manual_reconciliation",
      reconciliation_reason: "PROVIDER_POLL_REQUIRES_RECONCILIATION",
      lease_token: ""
    });
    assert.equal(generationRightConflict(fixture.db)?.intent_id, intentId);
    assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 1, provider_submits: 0 });
  } finally {
    closeFixture(fixture);
  }
});

test("durable GenerationPlan keeps authority revalidation required after marker loss", async () => {
  for (const drift of ["package_approval", "project_classification"] as const) {
    const fixture = createFixture();
    try {
      const { confirmed: admitted } = confirmT2Fixture(fixture);
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const dependencies = fixtureExecutionDependencies(fixture, counters);
      const preflight = await preflightWorkbenchGeneration({
        project_id: PROJECT_ID,
        shot_id: SHOT_ID,
        account_label: "personal",
        budget_limit_value: 10
      }, fixture.db, dependencies);
      if (!preflight.ok) throw new Error(preflight.error.code);

      mutatePersistedIntentData(fixture, admitted.data.intent.intent_id, (data) => {
        const snapshot = data.input_snapshot as Record<string, unknown>;
        if (drift === "package_approval") delete snapshot.prepared_by;
        else delete snapshot.admission_only;
      });
      if (drift === "package_approval") {
        const row = fixture.db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?")
          .get(PACKAGE_ID) as { data_json: string };
        const storyboardPackage = JSON.parse(row.data_json) as { user_approval: { storyboard_approved: boolean } };
        storyboardPackage.user_approval.storyboard_approved = false;
        fixture.db.prepare("UPDATE storyboard_packages SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE storyboard_package_id = ?")
          .run(JSON.stringify(storyboardPackage), PACKAGE_ID);
      } else {
        fixture.db.prepare("UPDATE workbench_project_meta SET classification = 'test', updated_at = CURRENT_TIMESTAMP WHERE project_id = ?")
          .run(PROJECT_ID);
      }

      const confirmed = confirmWorkbenchGeneration({
        intent_id: admitted.data.intent.intent_id,
        budget_limit_value: 10,
        cost_confirmed: true,
        human_confirmation: true
      }, fixture.db, dependencies);
      assert.equal(confirmed.ok, false, drift);
      if (confirmed.ok) throw new Error(`${drift} unexpectedly bypassed durable T2 revalidation`);
      assert.equal(confirmed.error.code, "GENERATION_PLAN_STALE", drift);
      const stored = fixture.db.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { status: string; sanitized_error_json: string };
      assert.equal(stored.status, "cancelled", drift);
      assert.equal((JSON.parse(stored.sanitized_error_json) as { code?: string }).code, "GENERATION_PLAN_STALE", drift);
      assert.equal(generationRightConflict(fixture.db), null, drift);
      assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 0, provider_submits: 0 }, drift);
      assert.equal(intentCount(fixture.db), 1, drift);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("durable GenerationPlan marker inconsistency alone fails closed", async () => {
  for (const drift of ["prepared_by_missing", "prepared_by_inconsistent", "admission_only_missing", "admission_only_inconsistent"] as const) {
    const fixture = createFixture();
    try {
      const { confirmed: admitted } = confirmT2Fixture(fixture);
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const dependencies = fixtureExecutionDependencies(fixture, counters);
      const preflight = await preflightWorkbenchGeneration({
        project_id: PROJECT_ID,
        shot_id: SHOT_ID,
        account_label: "personal",
        budget_limit_value: 10
      }, fixture.db, dependencies);
      if (!preflight.ok) throw new Error(preflight.error.code);
      mutatePersistedIntentData(fixture, admitted.data.intent.intent_id, (data) => {
        const snapshot = data.input_snapshot as Record<string, unknown>;
        if (drift === "prepared_by_missing") delete snapshot.prepared_by;
        else if (drift === "prepared_by_inconsistent") snapshot.prepared_by = "human_workbench";
        else if (drift === "admission_only_missing") delete snapshot.admission_only;
        else snapshot.admission_only = false;
      });

      const confirmed = confirmWorkbenchGeneration({
        intent_id: admitted.data.intent.intent_id,
        budget_limit_value: 10,
        cost_confirmed: true,
        human_confirmation: true
      }, fixture.db, dependencies);
      assert.equal(confirmed.ok, false, drift);
      if (confirmed.ok) throw new Error(`${drift} unexpectedly became an ordinary Workbench intent`);
      assert.equal(confirmed.error.code, "GENERATION_PLAN_STALE", drift);
      const stored = fixture.db.prepare("SELECT status FROM generation_intents WHERE intent_id = ?")
        .get(admitted.data.intent.intent_id) as { status: string };
      assert.equal(stored.status, "cancelled", drift);
      assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 0, provider_submits: 0 }, drift);
      assert.equal(intentCount(fixture.db), 1, drift);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("direct and resumed workers enforce the durable T2 marker gate", async () => {
  for (const entry of ["direct", "resume"] as const) {
    const fixture = createFixture();
    try {
      const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
      const promoted = await promoteT2FixtureToQueued(fixture, counters);
      mutatePersistedIntentData(fixture, promoted.admitted.data.intent.intent_id, (data) => {
        const snapshot = data.input_snapshot as Record<string, unknown>;
        delete snapshot.prepared_by;
      });

      if (entry === "direct") {
        await runWorkbenchGenerationOnce(promoted.admitted.data.intent.intent_id, {
          allow_submit: true,
          dependencies: promoted.dependencies
        });
      } else {
        const resumed = resumeWorkbenchGenerationJobs(promoted.dependencies);
        assert.deepEqual(resumed, { resumed: [promoted.admitted.data.intent.intent_id], reconciled: [] });
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const state = fixture.db.prepare("SELECT state FROM generation_jobs WHERE intent_id = ?")
            .get(promoted.admitted.data.intent.intent_id) as { state: string };
          if (state.state === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      const intent = fixture.db.prepare("SELECT status, sanitized_error_json FROM generation_intents WHERE intent_id = ?")
        .get(promoted.admitted.data.intent.intent_id) as { status: string; sanitized_error_json: string };
      const job = fixture.db.prepare("SELECT state, reconciliation_reason FROM generation_jobs WHERE intent_id = ?")
        .get(promoted.admitted.data.intent.intent_id) as { state: string; reconciliation_reason: string };
      assert.equal(intent.status, "failed", entry);
      assert.equal((JSON.parse(intent.sanitized_error_json) as { code?: string }).code, "GENERATION_PLAN_STALE", entry);
      assert.deepEqual({ ...job }, { state: "failed", reconciliation_reason: "GENERATION_PLAN_STALE" }, entry);
      assert.deepEqual(counters, { preflight_requests: 2, adapter_constructs: 0, provider_submits: 0 }, entry);
      assert.equal(intentCount(fixture.db), 1, entry);
    } finally {
      closeFixture(fixture);
    }
  }
});

test("ordinary non-T2 Workbench execution remains outside T2 revalidation", async () => {
  const fixture = createFixture();
  try {
    const counters = { preflight_requests: 0, adapter_constructs: 0, provider_submits: 0 };
    const dependencies = fixtureExecutionDependencies(fixture, counters);
    const preflight = await preflightWorkbenchGeneration({
      project_id: PROJECT_ID,
      shot_id: SHOT_ID,
      account_label: "personal",
      budget_limit_value: 10
    }, fixture.db, dependencies);
    if (!preflight.ok) throw new Error(preflight.error.code);
    const persisted = fixture.db.prepare("SELECT data_json FROM generation_intents WHERE intent_id = ?")
      .get(preflight.data.intent.intent_id) as { data_json: string };
    assert.equal("generation_plan" in (JSON.parse(persisted.data_json) as Record<string, unknown>), false);
    const confirmed = confirmWorkbenchGeneration({
      intent_id: preflight.data.intent.intent_id,
      budget_limit_value: 10,
      cost_confirmed: true,
      human_confirmation: true
    }, fixture.db, dependencies);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    await runWorkbenchGenerationOnce(confirmed.data.intent.intent_id, { allow_submit: true, dependencies });
    assert.equal(counters.provider_submits, 1);
    assert.equal(intentCount(fixture.db), 1);
  } finally {
    closeFixture(fixture);
  }
});

type AuthorityFactsFixture = { root: string; db: DatabaseSync };

function createAuthorityFactsFixture(packageSnapshots: unknown[]): AuthorityFactsFixture {
  const root = mkdtempSync(join(tmpdir(), "t2-authority-admission-"));
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { recursive: true });
  const sqlitePath = join(dataRoot, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = new DatabaseSync(sqlitePath);
  const project: Project = {
    project_id: "p1",
    title: "Authority facts fixture",
    project_type: "m0_video_loop",
    status: "storyboard_approved",
    brief: {},
    video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "480p" },
    shot_ids: ["s1", "s2", "s3"],
    active_storyboard_package_id: "pkg1",
    generation_batch_ids: [],
    exports: { final_video_artifact_id: "" }
  };
  saveProject(db, project);
  db.prepare("UPDATE workbench_project_meta SET classification = 'production', lifecycle = 'active' WHERE project_id = ?").run("p1");
  for (const [index, shotId] of ["s1", "s2", "s3"].entries()) {
    const shot: Shot = {
      shot_id: shotId,
      project_id: "p1",
      order: index + 1,
      status: "storyboard_approved",
      duration_seconds: 6,
      description: `Shot ${shotId}`,
      storyboard_image_artifact_id: `a${index + 1}`,
      video_prompt: `prompt-${shotId}`,
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
  }
  db.prepare("INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json) VALUES (?, ?, ?)")
    .run("pkg1", "p1", JSON.stringify({
      storyboard_package_id: "pkg1",
      project_id: "p1",
      status: "approved_for_video_generation",
      approved_shot_snapshots: packageSnapshots,
      user_approval: { storyboard_approved: true }
    }));
  return { root, db };
}

function closeAuthorityFactsFixture(fixture: AuthorityFactsFixture): void {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

test("storyboard package relational identity drift fails closed at the canonical loader", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-authority-package-"));
  const sqlitePath = join(root, "app.sqlite");
  migrateDatabase(sqlitePath);
  const db = new DatabaseSync(sqlitePath);
  try {
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)").run("p1", JSON.stringify({ project_id: "p1" }));
    db.prepare("INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json) VALUES (?, ?, ?)")
      .run("pkg_record", "p1", JSON.stringify({ storyboard_package_id: "pkg_json", project_id: "p1" }));
    assert.equal(getStoryboardPackage(db, "pkg_record"), null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("product admission facts reject duplicate/missing collection while preserving valid collection", () => {
  const validSnapshots = [
    { shot_id: "s1", order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
    { shot_id: "s2", order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
    { shot_id: "s3", order: 3, duration_seconds: 6, storyboard_image_artifact_id: "a3", video_prompt: "prompt-s3" }
  ];
  const valid = createAuthorityFactsFixture(validSnapshots);
  try {
    const read = readGenerationAdmissionFacts(valid.db, "p1", "s1", { verify_media: false });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.facts.package.snapshot_collection_complete, true);
      assert.equal(read.facts.package.snapshot_ambiguous, false);
      assert.equal(evaluateGenerationAdmission(read.facts).state, "INELIGIBLE");
    }
  } finally {
    closeAuthorityFactsFixture(valid);
  }

  const invalid = createAuthorityFactsFixture([validSnapshots[0], validSnapshots[1], validSnapshots[1]]);
  try {
    const read = readGenerationAdmissionFacts(invalid.db, "p1", "s1", { verify_media: false });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.facts.package.snapshot_collection_complete, false);
      assert.equal(read.facts.package.selected_snapshot, null);
      const decision = evaluateGenerationAdmission(read.facts);
      assert.equal(decision.state, "INELIGIBLE");
      assert.equal(decision.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
    }
  } finally {
    closeAuthorityFactsFixture(invalid);
  }
});

test("product admission facts reject package identity drift before eligibility", () => {
  const fixture = createAuthorityFactsFixture([
    { shot_id: "s1", order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
    { shot_id: "s2", order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
    { shot_id: "s3", order: 3, duration_seconds: 6, storyboard_image_artifact_id: "a3", video_prompt: "prompt-s3" }
  ]);
  try {
    fixture.db.prepare("UPDATE storyboard_packages SET data_json = ? WHERE storyboard_package_id = ?")
      .run(JSON.stringify({ storyboard_package_id: "pkg_other", project_id: "p1", status: "approved_for_video_generation", approved_shot_snapshots: [], user_approval: { storyboard_approved: true } }), "pkg1");
    const read = readGenerationAdmissionFacts(fixture.db, "p1", "s1", { verify_media: false });
    assert.equal(read.ok, true);
    if (read.ok) {
      const decision = evaluateGenerationAdmission(read.facts);
      assert.equal(decision.state, "INELIGIBLE");
      assert.equal(decision.reason_code_counts.PACKAGE_NOT_FOUND, 1);
    }
  } finally {
    closeAuthorityFactsFixture(fixture);
  }
});

test("product admission facts preserve valid legacy order fallback", () => {
  const fixture = createAuthorityFactsFixture([
    { order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
    { order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
    { order: 3, duration_seconds: 6, storyboard_image_artifact_id: "a3", video_prompt: "prompt-s3" }
  ]);
  try {
    const read = readGenerationAdmissionFacts(fixture.db, "p1", "s1", { verify_media: false });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.facts.package.snapshot_collection_complete, true);
      assert.equal(read.facts.package.match_mode, "order");
      assert.equal(read.facts.package.selected_snapshot?.order, 1);
    }
  } finally {
    closeAuthorityFactsFixture(fixture);
  }
});
