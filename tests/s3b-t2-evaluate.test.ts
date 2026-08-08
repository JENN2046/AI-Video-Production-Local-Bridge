import assert from "node:assert/strict";
import test from "node:test";

import { evaluateT2Snapshot } from "../src/tools/s3bT2Evaluate.js";
import type { GovernedMediaEvidence, T2NormalizedSnapshot } from "../src/tools/s3bT2Types.js";

function baseSnapshot(): T2NormalizedSnapshot {
  const project = { project_id: "p1", status: "storyboard_approved", video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "480p" }, active_storyboard_package_id: "pkg1", final_video_artifact_id: "" };
  const shot = { shot_id: "s1", project_id: "p1", order: 1, status: "storyboard_approved", duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt", negative_prompt: "", generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [], review: { approval_status: "pending" as const, rejection_reasons: [], latest_revision_instruction: null } };
  const pkg = { storyboard_package_id: "pkg1", project_id: "p1", status: "approved_for_video_generation", storyboard_approved: true, approved_shot_snapshots: [{ order: 1, duration_seconds: 6, description: "changed description is allowed", storyboard_image_artifact_id: "a1", video_prompt: "prompt", negative_prompt: "" }] };
  const artifact = { artifact_id: "a1", project_id: "p1", shot_id: "s1", blob_id: "b1", artifact_type: "image", role: "storyboard_image", status: "active", storage: { uri: "fixture", mime_type: "image/png", filename: "x.png" }, metadata: { sha256: "a".repeat(64) }, linked_objects: { project_id: "p1", shot_id: "s1" }, source: { sha256: "a".repeat(64) } };
  return { database: { identity_digest: "a".repeat(64), total_changes_before: 0, total_changes_after: 0, active_intent_count: 0, query_only: 1, schema_current: true }, projects: new Map([["p1", project]]), project_meta: new Map([["p1", { project_id: "p1", classification: "production", lifecycle: "active" }]]), shots: new Map([["s1", shot]]), packages: new Map([["pkg1", pkg]]), artifacts: new Map([["a1", artifact]]), blobs: new Map([["b1", { blob_id: "b1", sha256: "a".repeat(64), size_bytes: 10, detected_mime: "image/png", storage_uri: "fixture", integrity_state: "verified", media_root: "fixture" }]]), artifact_blob_links: new Map([["a1", "b1"]]), generation: new Map(), normalization_issues: [], rowsets: {} as never, database_evidence_digest: "b".repeat(64) };
}

const validMedia = (): Map<string, GovernedMediaEvidence> => new Map([["a1", { status: "VALID", artifact_id: "a1", fingerprint_digest: "c".repeat(64), raw_sha256: "a".repeat(64), size_bytes: 10, detected_mime: "image/png", decoded: true }]]);

test("valid one-candidate evaluation is pure and ignores description-only drift", () => {
  const result = evaluateT2Snapshot(baseSnapshot(), validMedia());
  assert.equal(result.state, "ELIGIBLE");
  assert.deepEqual(result.candidates, [{ project_id: "p1", shot_id: "s1" }]);
});

test("global active intent has sole precedence", () => {
  const snapshot = baseSnapshot();
  snapshot.database.active_intent_count = 1;
  const result = evaluateT2Snapshot(snapshot, validMedia());
  assert.deepEqual(result.reason_code_counts, { REAL_GENERATION_ALREADY_ACTIVE: 1 });
});

test("project classification, lifecycle and delivery gates use stable reasons", () => {
  const notProduction = baseSnapshot();
  notProduction.project_meta.get("p1")!.classification = "test";
  assert.equal(evaluateT2Snapshot(notProduction, validMedia()).reason_code_counts.PROJECT_NOT_PRODUCTION, 1);
  const archived = baseSnapshot();
  archived.project_meta.get("p1")!.lifecycle = "archived";
  assert.equal(evaluateT2Snapshot(archived, validMedia()).reason_code_counts.PROJECT_NOT_ACTIVE, 1);
  const delivered = baseSnapshot();
  delivered.projects.get("p1")!.status = "final_approved";
  assert.equal(evaluateT2Snapshot(delivered, validMedia()).reason_code_counts.PROJECT_ALREADY_DELIVERED, 1);
});

test("generation history and invalid media cannot collapse into a generic filesystem reason", () => {
  const started = baseSnapshot();
  started.generation.set("p1\u0000s1", { project_id: "p1", shot_id: "s1", has_any_job_or_run: true, latest_run_status: "queued", latest_job_state: null, malformed_history: false });
  const startedResult = evaluateT2Snapshot(started, validMedia());
  assert.equal(startedResult.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
  assert.equal(startedResult.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
  const invalidMedia = new Map([["a1", { status: "INVALID" as const, artifact_id: "a1", fingerprint_digest: "d".repeat(64), failure_class: "MEDIA_SYMLINK_ENTITY" }]]);
  const invalidResult = evaluateT2Snapshot(baseSnapshot(), invalidMedia);
  assert.equal(invalidResult.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
});

test("provider registry reasons are preserved", () => {
  const snapshot = baseSnapshot();
  snapshot.shots.get("s1")!.duration_seconds = 5;
  snapshot.packages.get("pkg1")!.approved_shot_snapshots[0].duration_seconds = 5;
  const result = evaluateT2Snapshot(snapshot, validMedia());
  assert.equal(result.reason_code_counts.PROVIDER_CAPABILITY_DURATION_UNSUPPORTED, 1);
});
