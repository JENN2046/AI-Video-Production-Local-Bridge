import assert from "node:assert/strict";
import test from "node:test";

import { normalizeT2RawSnapshot } from "../src/tools/s3bT2Normalize.js";
import { T2_SNAPSHOT_ROWSET_NAMES, type T2RawSnapshot } from "../src/tools/s3bT2Types.js";

function raw(overrides: Partial<Record<(typeof T2_SNAPSHOT_ROWSET_NAMES)[number], readonly Record<string, unknown>[]>> = {}): T2RawSnapshot {
  const project = {
    project_id: "p1", status: "storyboard_approved", video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "480p" },
    active_storyboard_package_id: "pkg1", exports: { final_video_artifact_id: "" }
  };
  const shot = {
    shot_id: "s1", project_id: "p1", order: 1, status: "storyboard_approved", duration_seconds: 6,
    storyboard_image_artifact_id: "a1", video_prompt: "a prompt", negative_prompt: null, generation_run_ids: [],
    accepted_clip_artifact_id: "", clip_versions: [], review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  };
  const pkg = {
    storyboard_package_id: "pkg1", project_id: "p1", status: "approved_for_video_generation",
    approved_shot_snapshots: [{ order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "a prompt", negative_prompt: null }],
    user_approval: { storyboard_approved: true }
  };
  const artifact = {
    artifact_id: "a1", blob_id: "b1", artifact_type: "image", role: "storyboard_image", status: "active",
    storage: { uri: "C:/fixture/image.png", mime_type: "image/png", filename: "image.png" }, metadata: { sha256: "a".repeat(64) },
    linked_objects: { project_id: "p1", shot_id: "s1" }, source: { sha256: "a".repeat(64) }
  };
  const blob = { blob_id: "b1", sha256: "a".repeat(64), size_bytes: 68, detected_mime: "image/png", storage_uri: "C:/fixture/image.png", integrity_state: "verified", provenance_json: JSON.stringify({ media_root: "C:/fixture" }) };
  const rowsets = {
    projects: [{ project_id: "p1", data_json: JSON.stringify(project) }],
    workbench_project_meta: [{ project_id: "p1", classification: "production", lifecycle: "active" }],
    shots: [{ shot_id: "s1", project_id: "p1", data_json: JSON.stringify(shot) }],
    storyboard_packages: [{ storyboard_package_id: "pkg1", project_id: "p1", data_json: JSON.stringify(pkg) }],
    media_artifacts: [{ artifact_id: "a1", project_id: "p1", shot_id: "s1", role: "storyboard_image", artifact_type: "image", status: "active", data_json: JSON.stringify(artifact) }],
    media_artifact_blobs: [{ artifact_id: "a1", blob_id: "b1" }], media_blobs: [blob], generation_intents: [], generation_jobs: [], generation_runs: []
  } as T2RawSnapshot["rowsets"];
  return {
    database: { identity_digest: "d".repeat(64), total_changes_before: 0, total_changes_after: 0, active_intent_count: 0, query_only: 1, schema_current: true },
    rowsets: { ...rowsets, ...overrides } as T2RawSnapshot["rowsets"],
    rowset_evidence: Object.fromEntries(T2_SNAPSHOT_ROWSET_NAMES.map((name) => [name, { row_count: rowsets[name].length, digest: "e".repeat(64) }])) as T2RawSnapshot["rowset_evidence"],
    database_evidence_digest: "f".repeat(64)
  };
}

test("normalizes relationally keyed project, shot, package, artifact and blob facts", () => {
  const normalized = normalizeT2RawSnapshot(raw());
  assert.equal(normalized.projects.get("p1")?.project_id, "p1");
  assert.equal(normalized.shots.get("s1")?.negative_prompt, "");
  assert.equal(normalized.packages.get("pkg1")?.project_id, "p1");
  assert.equal(normalized.artifacts.get("a1")?.blob_id, "b1");
  assert.equal(normalized.blobs.get("b1")?.media_root, "C:/fixture");
  assert.equal(normalized.normalization_issues.length, 0);
});

test("persisted malformed and null business rows become issues, not TypeErrors", () => {
  const normalized = normalizeT2RawSnapshot(raw({
    projects: [{ project_id: "bad", data_json: "{" }],
    shots: [{ shot_id: "bad-shot", project_id: "p1", data_json: "null" }],
    media_artifacts: [{ artifact_id: "bad-artifact", project_id: "p1", shot_id: "s1", role: "storyboard_image", artifact_type: "image", status: "active", data_json: null }],
    storyboard_packages: [{ storyboard_package_id: "bad-package", project_id: "p1", data_json: JSON.stringify({}) }]
  }));
  assert.ok(normalized.normalization_issues.some((item) => item.code === "PROJECT_INVALID"));
  assert.ok(normalized.normalization_issues.some((item) => item.code === "SHOT_INVALID"));
  assert.ok(normalized.normalization_issues.some((item) => item.code === "ARTIFACT_INVALID"));
  assert.ok(normalized.normalization_issues.some((item) => item.code === "PACKAGE_INVALID"));
});

test("snapshot shot_id presence semantics and ClipVersion schema remain strict", () => {
  const absent = normalizeT2RawSnapshot(raw({
    storyboard_packages: [{ storyboard_package_id: "pkg1", project_id: "p1", data_json: JSON.stringify({
      storyboard_package_id: "pkg1", project_id: "p1", status: "approved_for_video_generation", user_approval: { storyboard_approved: true },
      approved_shot_snapshots: [{ order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "a prompt" }]
    }) }]
  }));
  assert.equal(absent.packages.get("pkg1")?.approved_shot_snapshots[0].shot_id, undefined);
  const invalid = normalizeT2RawSnapshot(raw({
    storyboard_packages: [{ storyboard_package_id: "pkg1", project_id: "p1", data_json: JSON.stringify({
      storyboard_package_id: "pkg1", project_id: "p1", status: "approved_for_video_generation", user_approval: { storyboard_approved: true },
      approved_shot_snapshots: [{ shot_id: null, order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "a prompt" }]
    }) }]
  }));
  assert.ok(invalid.normalization_issues.some((item) => item.code === "PACKAGE_INVALID"));
});

function emptyDatabaseEvidence(): T2RawSnapshot["database"] {
  return {
    identity_digest: "d".repeat(64),
    total_changes_before: 0,
    total_changes_after: 0,
    active_intent_count: 0,
    query_only: 1,
    schema_current: true
  };
}

function rawSnapshot(overrides: Partial<T2RawSnapshot["rowsets"]> = {}): T2RawSnapshot {
  const shots = ["s1", "s2", "s3"].map((shotId, index) => ({
    shot_id: shotId,
    project_id: "p1",
    order: index + 1,
    status: "storyboard_approved",
    duration_seconds: 6,
    storyboard_image_artifact_id: `a${index + 1}`,
    video_prompt: `prompt-${shotId}`,
    negative_prompt: null,
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
  }));
  const packages = [{
    storyboard_package_id: "pkg1",
    project_id: "p1",
    status: "approved_for_video_generation",
    approved_shot_snapshots: [
      { shot_id: "s1", order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
      { shot_id: "s2", order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
      { shot_id: "s3", order: 3, duration_seconds: 6, storyboard_image_artifact_id: "a3", video_prompt: "prompt-s3" }
    ],
    user_approval: { storyboard_approved: true }
  }];
  const artifacts = shots.map((shot) => ({
    artifact_id: shot.storyboard_image_artifact_id,
    project_id: "p1",
    shot_id: shot.shot_id,
    role: "storyboard_image",
    artifact_type: "image",
    status: "active",
    data_json: JSON.stringify({
      artifact_id: shot.storyboard_image_artifact_id,
      blob_id: `b${shot.shot_id.slice(1)}`,
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: "fixture", mime_type: "image/png", filename: `${shot.shot_id}.png` },
      metadata: { sha256: "a".repeat(64) },
      linked_objects: { project_id: "p1", shot_id: shot.shot_id },
      source: { sha256: "a".repeat(64) }
    })
  }));
  const blobs = ["b1", "b2", "b3"].map((blobId) => ({
    blob_id: blobId,
    sha256: "a".repeat(64),
    size_bytes: 1,
    detected_mime: "image/png",
    storage_uri: "fixture",
    integrity_state: "verified",
    provenance_json: JSON.stringify({ media_root: "fixture" })
  }));
  const rowsets: T2RawSnapshot["rowsets"] = {
    projects: [{
      project_id: "p1",
      data_json: JSON.stringify({
        project_id: "p1",
        status: "storyboard_approved",
        video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "480p" },
        active_storyboard_package_id: "pkg1",
        exports: { final_video_artifact_id: "" }
      })
    }],
    workbench_project_meta: [{ project_id: "p1", classification: "production", lifecycle: "active" }],
    shots: shots.map((shot) => ({ shot_id: shot.shot_id, project_id: "p1", data_json: JSON.stringify(shot) })),
    storyboard_packages: packages.map((pkg) => ({ storyboard_package_id: "pkg1", project_id: "p1", data_json: JSON.stringify(pkg) })),
    media_artifacts: artifacts,
    media_artifact_blobs: ["a1", "a2", "a3"].map((artifactId, index) => ({ artifact_id: artifactId, blob_id: `b${index + 1}` })),
    media_blobs: blobs,
    generation_intents: [],
    generation_jobs: [],
    generation_runs: []
  };
  const merged = { ...rowsets, ...overrides };
  return {
    database: emptyDatabaseEvidence(),
    rowsets: merged,
    rowset_evidence: Object.fromEntries(T2_SNAPSHOT_ROWSET_NAMES.map((name) => [name, { row_count: merged[name].length, digest: "e".repeat(64) }])) as T2RawSnapshot["rowset_evidence"],
    database_evidence_digest: "f".repeat(64)
  };
}

test("storyboard package relational identity drift fails closed during normalization", () => {
  const normalized = normalizeT2RawSnapshot(rawSnapshot({
    storyboard_packages: [{
      storyboard_package_id: "pkg_record",
      project_id: "p1",
      data_json: JSON.stringify({
        storyboard_package_id: "pkg_json",
        project_id: "p1",
        status: "approved_for_video_generation",
        approved_shot_snapshots: [],
        user_approval: { storyboard_approved: true }
      })
    }]
  }));
  assert.equal(normalized.packages.has("pkg_record"), false);
  assert.ok(normalized.normalization_issues.some((item) => item.code === "PACKAGE_INVALID"));
});

test("duplicate and missing package snapshots fail closed during normalization", () => {
  const snapshot = rawSnapshot({
    storyboard_packages: [{
      storyboard_package_id: "pkg1",
      project_id: "p1",
      data_json: JSON.stringify({
        storyboard_package_id: "pkg1",
        project_id: "p1",
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          { shot_id: "s1", order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
          { shot_id: "s2", order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
          { shot_id: "s2", order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" }
        ],
        user_approval: { storyboard_approved: true }
      })
    }]
  });
  const normalized = normalizeT2RawSnapshot(snapshot);
  assert.equal(normalized.packages.has("pkg1"), false);
  assert.ok(normalized.normalization_issues.some((item) => item.code === "PACKAGE_INVALID"));
});

test("artifact/blob relational drift removes the artifact from normalized facts", () => {
  const snapshot = rawSnapshot({
    media_artifacts: [{
      artifact_id: "a1",
      project_id: "p1",
      shot_id: "s1",
      role: "storyboard_image",
      artifact_type: "image",
      status: "active",
      data_json: JSON.stringify({
        artifact_id: "a1",
        blob_id: "b2",
        artifact_type: "image",
        role: "storyboard_image",
        status: "active",
        storage: { uri: "fixture", mime_type: "image/png", filename: "s1.png" },
        metadata: { sha256: "a".repeat(64) },
        linked_objects: { project_id: "p1", shot_id: "s1" },
        source: { sha256: "a".repeat(64) }
      })
    }],
    media_artifact_blobs: [{ artifact_id: "a1", blob_id: "b1" }]
  });
  const normalized = normalizeT2RawSnapshot(snapshot);
  assert.equal(normalized.artifacts.has("a1"), false);
  assert.ok(normalized.normalization_issues.some((item) => item.code === "ARTIFACT_BLOB_BINDING_INVALID"));
});

test("missing artifact/blob relation or authoritative blob removes the artifact from normalized facts", () => {
  for (const overrides of [{ media_artifact_blobs: [] }, { media_blobs: [] }] as const) {
    const normalized = normalizeT2RawSnapshot(rawSnapshot(overrides));
    assert.equal(normalized.artifacts.has("a1"), false);
    assert.ok(normalized.normalization_issues.some((item) => item.code === "ARTIFACT_BLOB_BINDING_INVALID"));
  }
});

test("valid explicit package snapshots remain usable", () => {
  const normalized = normalizeT2RawSnapshot(rawSnapshot());
  assert.equal(normalized.packages.has("pkg1"), true);
  assert.equal(normalized.normalization_issues.length, 0);
});

test("valid legacy order fallback remains usable", () => {
  const normalized = normalizeT2RawSnapshot(rawSnapshot({
    storyboard_packages: [{
      storyboard_package_id: "pkg1",
      project_id: "p1",
      data_json: JSON.stringify({
        storyboard_package_id: "pkg1",
        project_id: "p1",
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          { order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
          { order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
          { order: 3, duration_seconds: 6, storyboard_image_artifact_id: "a3", video_prompt: "prompt-s3" }
        ],
        user_approval: { storyboard_approved: true }
      })
    }]
  }));
  assert.equal(normalized.packages.has("pkg1"), true);
  assert.equal(normalized.normalization_issues.length, 0);
});

test("duplicate legacy order, missing snapshot, and foreign snapshot fail closed", () => {
  const cases = [
    [
      { order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
      { order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
      { order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" }
    ],
    [
      { order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
      { order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" }
    ],
    [
      { shot_id: "s1", order: 1, duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt-s1" },
      { shot_id: "s2", order: 2, duration_seconds: 6, storyboard_image_artifact_id: "a2", video_prompt: "prompt-s2" },
      { shot_id: "foreign", order: 3, duration_seconds: 6, storyboard_image_artifact_id: "a3", video_prompt: "prompt-foreign" }
    ]
  ];
  for (const approved_shot_snapshots of cases) {
    const normalized = normalizeT2RawSnapshot(rawSnapshot({
      storyboard_packages: [{
        storyboard_package_id: "pkg1",
        project_id: "p1",
        data_json: JSON.stringify({
          storyboard_package_id: "pkg1",
          project_id: "p1",
          status: "approved_for_video_generation",
          approved_shot_snapshots,
          user_approval: { storyboard_approved: true }
        })
      }]
    }));
    assert.equal(normalized.packages.has("pkg1"), false);
  }
});
