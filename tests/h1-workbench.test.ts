import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  defaultH1WorkbenchState,
  ensureM0Directories,
  freezeH1StoryboardPackage,
  H1_PROVIDER_BOUNDARY,
  linkH1ArtifactToShot,
  markH1ShotApproved,
  openM0Database,
  paths,
  registerH1ApprovedKeyframe,
  registerMediaArtifact,
  updateH1ShotMetadata,
  validateH1StoryboardPackage,
  type H1WorkbenchState
} from "../src/index.js";

const CANARY_SOURCE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");

function copyH1Import(filename: string): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  assert.equal(existsSync(CANARY_SOURCE), true, `Missing H1 test source image: ${CANARY_SOURCE}`);
  const target = join(paths.importsRoot, filename);
  copyFileSync(CANARY_SOURCE, target);
  return filename;
}

function oneShotState(): H1WorkbenchState {
  const state = defaultH1WorkbenchState();
  return {
    ...state,
    project: {
      ...state.project,
      project_id: "",
      title: `H1 Test ${randomUUID().slice(0, 8)}`
    },
    shots: [
      {
        shot_id: `h1_test_shot_${randomUUID().slice(0, 8)}`,
        order: 1,
        duration_seconds: 2,
        description: "Approved H1 test keyframe.",
        video_prompt: "Animate this approved keyframe with a small natural camera move.",
        negative_prompt: "",
        continuity_constraints: [],
        storyboard_image_artifact_id: "",
        approval_status: "pending"
      }
    ],
    rejected_imports: [],
    frozen_package_history: []
  };
}

test("H1 registers approved SHOT image, links it, validates, and freezes app-ready package", () => {
  const db = openM0Database();

  try {
    const filename = copyH1Import(`h1_test_shot_${randomUUID().slice(0, 8)}.png`);
    const registered = registerH1ApprovedKeyframe(
      {
        import_filename: filename,
        review_status: "approved_for_media_artifact_handoff",
        write_report: false
      },
      db
    );
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    assert.equal(registered.value.artifact.artifact_type, "image");
    assert.equal(registered.value.artifact.role, "storyboard_image");
    assert.equal(registered.value.artifact.status, "active");

    let state = oneShotState();
    const linked = linkH1ArtifactToShot(state, { shot_id: state.shots[0].shot_id, artifact_id: registered.value.artifact.artifact_id }, db);
    assert.equal(linked.ok, true);
    if (!linked.ok) return;
    state = linked.value;

    const updated = updateH1ShotMetadata(state, {
      shot_id: state.shots[0].shot_id,
      video_prompt: "Use the keyframe as the visual anchor and preserve product continuity.",
      negative_prompt: ""
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    state = updated.value;

    const approved = markH1ShotApproved(state, { shot_id: state.shots[0].shot_id, human_confirmation: true });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    state = approved.value;

    const validation = validateH1StoryboardPackage(state, db);
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.equal(validation.value.validation.validateG0StoryboardPackage, "PASS");
    assert.equal(validation.value.validation.app_ready, true);

    const frozen = freezeH1StoryboardPackage(validation.value.state, { human_confirmation: true, write_report: false }, db);
    assert.equal(frozen.ok, true);
    if (!frozen.ok) return;
    const report = frozen.value.report as {
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
      storyboard_package: { frozen: boolean; shot_count: number; storyboard_package_id: string };
    };
    assert.equal(report.storyboard_package.frozen, true);
    assert.equal(report.storyboard_package.shot_count, 1);
    assert.equal(report.provider_boundary.network_call_attempted, false);
    assert.equal(report.provider_boundary.runway_called, false);
    assert.equal(report.provider_boundary.runninghub_called, false);
    assert.equal(report.provider_boundary.real_video_generated, false);
  } finally {
    db.close();
  }
});

test("H1 rejects audit images and product references as storyboard images", () => {
  const db = openM0Database();

  try {
    const audit = copyH1Import(`h1_audit_DO_NOT_USE_${randomUUID().slice(0, 8)}.png`);
    const auditResult = registerH1ApprovedKeyframe({ import_filename: audit, review_status: "approved_for_media_artifact_handoff", write_report: false }, db);
    assert.equal(auditResult.ok, false);
    if (auditResult.ok) return;
    assert.equal(auditResult.error.code, "AUDIT_IMAGE_REJECTED");

    const reference = copyH1Import(`h1_product_reference_${randomUUID().slice(0, 8)}.png`);
    const referenceResult = registerH1ApprovedKeyframe({ import_filename: reference, review_status: "approved_for_media_artifact_handoff", write_report: false }, db);
    assert.equal(referenceResult.ok, false);
    if (referenceResult.ok) return;
    assert.equal(referenceResult.error.code, "PRODUCT_REFERENCE_REJECTED");
  } finally {
    db.close();
  }
});

test("H1 rejects PENDING artifact IDs and inactive artifacts when linking to shots", () => {
  const db = openM0Database();

  try {
    const state = oneShotState();
    const pendingId = linkH1ArtifactToShot(state, { shot_id: state.shots[0].shot_id, artifact_id: "PENDING_ACTIVE_ARTIFACT_ID" }, db);
    assert.equal(pendingId.ok, false);
    if (pendingId.ok) return;
    assert.equal(pendingId.error.code, "PENDING_ID_REJECTED");

    const pendingArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "pending_user_upload", filename: "pending.png", mime_type: "image/png" }
      },
      db
    );
    assert.equal(pendingArtifact.ok, true);
    if (!pendingArtifact.ok) return;
    const inactive = linkH1ArtifactToShot(state, { shot_id: state.shots[0].shot_id, artifact_id: pendingArtifact.artifact.artifact_id }, db);
    assert.equal(inactive.ok, false);
    if (inactive.ok) return;
    assert.equal(inactive.error.code, "ARTIFACT_PENDING_UPLOAD");
  } finally {
    db.close();
  }
});

test("H1 rejects missing video_prompt and freeze before all shots are approved", () => {
  const db = openM0Database();

  try {
    const filename = copyH1Import(`h1_test_missing_prompt_${randomUUID().slice(0, 8)}.png`);
    const registered = registerH1ApprovedKeyframe(
      {
        import_filename: filename,
        review_status: "approved_for_media_artifact_handoff",
        write_report: false
      },
      db
    );
    assert.equal(registered.ok, true);
    if (!registered.ok) return;

    let state = oneShotState();
    state.shots[0].video_prompt = "";
    const linked = linkH1ArtifactToShot(state, { shot_id: state.shots[0].shot_id, artifact_id: registered.value.artifact.artifact_id }, db);
    assert.equal(linked.ok, true);
    if (!linked.ok) return;
    state = linked.value;
    const approved = markH1ShotApproved(state, { shot_id: state.shots[0].shot_id, human_confirmation: true });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;

    const validation = validateH1StoryboardPackage(approved.value, db);
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.equal(validation.value.validation.ok, false);
    assert.equal(validation.value.validation.blockers.some((blocker) => blocker.includes("MISSING_VIDEO_PROMPT")), true);

    const withPrompt = updateH1ShotMetadata(linked.value, {
      shot_id: linked.value.shots[0].shot_id,
      video_prompt: "Use the keyframe as anchor.",
      negative_prompt: ""
    });
    assert.equal(withPrompt.ok, true);
    if (!withPrompt.ok) return;
    const frozen = freezeH1StoryboardPackage(withPrompt.value, { human_confirmation: true, write_report: false }, db);
    assert.equal(frozen.ok, false);
    if (frozen.ok) return;
    assert.equal(frozen.error.code, "FREEZE_PRECONDITIONS_BLOCKED");
  } finally {
    db.close();
  }
});
