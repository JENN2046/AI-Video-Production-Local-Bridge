import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateImageBuffer } from "../src/tools/imageValidity.js";
import { resolvedPathsEquivalent } from "../src/tools/pathEquivalence.js";
import { collectT2GovernedMediaEvidence } from "../src/tools/s3bT2MediaEvidence.js";
import type { T2NormalizedSnapshot } from "../src/tools/s3bT2Types.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function snapshot(root: string): T2NormalizedSnapshot {
  const path = join(root, "image.png");
  const sha = createHash("sha256").update(PNG).digest("hex");
  return {
    database: { identity_digest: "d".repeat(64), total_changes_before: 0, total_changes_after: 0, active_intent_count: 0, query_only: 1, schema_current: true },
    projects: new Map(), project_meta: new Map(), packages: new Map(),
    shots: new Map([["s1", { shot_id: "s1", project_id: "p1", order: 1, status: "storyboard_approved", duration_seconds: 6, storyboard_image_artifact_id: "a1", video_prompt: "prompt", negative_prompt: "", generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [], review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null } }]]),
    artifacts: new Map([["a1", { artifact_id: "a1", project_id: "p1", shot_id: "s1", blob_id: "b1", artifact_type: "image", role: "storyboard_image", status: "active", storage: { uri: path, mime_type: "image/png", filename: "image.png" }, metadata: { sha256: sha }, linked_objects: { project_id: "p1", shot_id: "s1" }, source: { sha256: sha } }]]),
    blobs: new Map([["b1", { blob_id: "b1", sha256: sha, size_bytes: PNG.length, detected_mime: "image/png", storage_uri: path, integrity_state: "verified", media_root: root }]]),
    artifact_blob_links: new Map([["a1", "b1"]]), generation: new Map(), normalization_issues: [], rowsets: {} as never, database_evidence_digest: "e".repeat(64)
  };
}

test("valid governed image reads one controlled fd and verifies exact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-media-valid-"));
  try {
    writeFileSync(join(root, "image.png"), PNG);
    const result = collectT2GovernedMediaEvidence({ snapshot: snapshot(root), mediaRoot: root });
    const evidence = result.referenced.get("a1");
    assert.equal(result.media_root.status, "VALID");
    assert.equal(evidence?.status, "VALID");
    if (evidence?.status === "VALID") assert.equal(evidence.raw_sha256, createHash("sha256").update(PNG).digest("hex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical path equivalence follows Windows and POSIX case semantics", () => {
  assert.equal(resolvedPathsEquivalent("C:\\Media\\Root", "c:\\media\\root", "win32"), true);
  assert.equal(resolvedPathsEquivalent("C:\\Media\\Project", "C:\\MEDIA\\project", "win32"), true);
  assert.equal(resolvedPathsEquivalent("C:\\Media\\ProjectA", "C:\\Media\\ProjectB", "win32"), false);
  assert.equal(resolvedPathsEquivalent("/media/project", "/media/project", "linux"), true);
  assert.equal(resolvedPathsEquivalent("/media/Project", "/media/project", "linux"), false);
});

test("Windows case-only media-root representation remains valid", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "t2-media-windows-case-"));
  try {
    writeFileSync(join(root, "image.png"), PNG);
    const caseVariant = root.replace(/[A-Za-z]/gu, (character) =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()
    );
    assert.notEqual(caseVariant, root);
    const result = collectT2GovernedMediaEvidence({ snapshot: snapshot(caseVariant), mediaRoot: caseVariant });
    assert.equal(result.media_root.status, "VALID");
    assert.equal(result.referenced.get("a1")?.status, "VALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlink and hard-link entities fail closed with fingerprints", (t) => {
  const root = mkdtempSync(join(tmpdir(), "t2-media-identity-"));
  try {
    writeFileSync(join(root, "image.png"), PNG);
    const symlinkPath = join(root, "symlink.png");
    try { symlinkSync(join(root, "image.png"), symlinkPath); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "EPERM" || code === "EACCES") t.skip("symlink creation unavailable"); else throw error;
    }
    const symlinkSnapshot = snapshot(root);
    const symlinkArtifact = symlinkSnapshot.artifacts.get("a1")!;
    const symlinkBlob = symlinkSnapshot.blobs.get("b1")!;
    symlinkArtifact.storage.uri = symlinkPath;
    symlinkBlob.storage_uri = symlinkPath;
    const symlinkEvidence = collectT2GovernedMediaEvidence({ snapshot: symlinkSnapshot, mediaRoot: root }).referenced.get("a1");
    assert.equal(symlinkEvidence?.status, "INVALID");
    assert.match(symlinkEvidence?.fingerprint_digest ?? "", /^[0-9a-f]{64}$/);
    const hardLinkPath = join(root, "hard-link.png");
    linkSync(join(root, "image.png"), hardLinkPath);
    const hardSnapshot = snapshot(root);
    hardSnapshot.artifacts.get("a1")!.storage.uri = hardLinkPath;
    hardSnapshot.blobs.get("b1")!.storage_uri = hardLinkPath;
    const hardEvidence = collectT2GovernedMediaEvidence({ snapshot: hardSnapshot, mediaRoot: root }).referenced.get("a1");
    assert.equal(hardEvidence?.status, "INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid authoritative media root does not read media bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-media-root-"));
  const outside = mkdtempSync(join(tmpdir(), "t2-media-outside-"));
  try {
    writeFileSync(join(root, "image.png"), PNG);
    const result = collectT2GovernedMediaEvidence({ snapshot: snapshot(root), mediaRoot: join(root, "missing") });
    assert.equal(result.media_root.status, "INVALID");
    assert.equal(result.referenced.get("a1")?.status, "INVALID");
    assert.notEqual(outside, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("non-directory media root remains rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-media-root-file-"));
  const fileRoot = join(root, "not-a-directory");
  try {
    writeFileSync(fileRoot, "not a directory");
    const result = collectT2GovernedMediaEvidence({ snapshot: snapshot(root), mediaRoot: fileRoot });
    assert.equal(result.media_root.status, "INVALID");
    if (result.media_root.status === "INVALID") assert.equal(result.media_root.failure_class, "MEDIA_ROOT_NOT_DIRECTORY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("structural PNG validation remains a separate pure check", () => {
  assert.equal(validateImageBuffer(PNG).ok, true);
});
