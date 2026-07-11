import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  defaultH1WorkbenchState,
  approveH3GeneratedClip,
  createGenerationRunFromPackageShot,
  createProject,
  executeH4FinalAssembly,
  ensureM0Directories,
  freezeH1StoryboardPackage,
  getMediaArtifact,
  getShot,
  h4FinalAssemblyWorkbenchSummary,
  H1_PROVIDER_BOUNDARY,
  h2CanaryWorkbenchSummary,
  h3VideoReviewSummary,
  importStoryboardPackage,
  linkH1ArtifactToShot,
  markH1ShotApproved,
  openM0Database,
  paths,
  prepareH1StoryboardPackageProject,
  registerH1ApprovedKeyframe,
  registerMediaArtifact,
  rejectH3GeneratedClip,
  updateH1ShotMetadata,
  validateH1StoryboardPackage,
  type H1WorkbenchState
} from "../src/index.js";

const CANARY_SOURCE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");
const ONE_BY_ONE_SOURCE = resolve(paths.workspaceRoot, "fixtures", "storyboard", "shot_001.png");

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

    const validationBeforePrepare = validateH1StoryboardPackage(state, db);
    assert.equal(validationBeforePrepare.ok, true);
    if (!validationBeforePrepare.ok) return;
    assert.equal(validationBeforePrepare.value.validation.ok, false);
    assert.equal(validationBeforePrepare.value.validation.blockers.includes("PROJECT_NOT_PREPARED"), true);
    assert.equal(validationBeforePrepare.value.state.project.project_id, "");

    const prepared = prepareH1StoryboardPackageProject(state, db);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    state = prepared.value.state;

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

test("H1 rejects readable images that are not vertical 9:16 storyboard frames", () => {
  const db = openM0Database();

  try {
    ensureM0Directories();
    mkdirSync(paths.importsRoot, { recursive: true });
    const filename = `h1_square_storyboard_${randomUUID().slice(0, 8)}.png`;
    copyFileSync(ONE_BY_ONE_SOURCE, join(paths.importsRoot, filename));
    const result = registerH1ApprovedKeyframe({ import_filename: filename, review_status: "approved_for_media_artifact_handoff", write_report: false }, db);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "ASPECT_RATIO_NOT_9_16");
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

    const prepared = prepareH1StoryboardPackageProject(approved.value, db);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const validation = validateH1StoryboardPackage(prepared.value.state, db);
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
    const preparedForFreeze = prepareH1StoryboardPackageProject(withPrompt.value, db);
    assert.equal(preparedForFreeze.ok, true);
    if (!preparedForFreeze.ok) return;
    const frozen = freezeH1StoryboardPackage(preparedForFreeze.value.state, { human_confirmation: true, write_report: false }, db);
    assert.equal(frozen.ok, false);
    if (frozen.ok) return;
    assert.equal(frozen.error.code, "FREEZE_PRECONDITIONS_BLOCKED");
  } finally {
    db.close();
  }
});

test("H2 canary workbench summary is read-only and redacted", () => {
  const summary = h2CanaryWorkbenchSummary();
  assert.equal(summary.provider_boundary.network_call_attempted, false);
  assert.equal(summary.provider_boundary.runway_called, false);
  assert.equal(summary.provider_boundary.runninghub_called, false);
  assert.equal(summary.provider_boundary.real_video_generated, false);
  assert.equal(summary.provider_boundary.secret_values_exposed, false);
  assert.equal(summary.dry_run_plan.command, "npm run provider:preflight");
  assert.equal(summary.provider_boundary.real_submit_available, false);
  assert.equal(summary.provider_boundary.real_submit_requires_separate_authorization, true);
  assert.equal(summary.dry_run_plan.can_generate_from_workbench, false);
  assert.equal(summary.dry_run_plan.regeneration_allowed, false);
  assert.equal(summary.dry_run_plan.batch_generation_allowed, false);
  assert.equal(summary.dry_run_plan.runninghub_allowed, false);
  assert.equal(typeof summary.credential_present, "boolean");

  if (summary.report_exists) {
    assert.equal(summary.provider_boundary.provider, "runway");
    assert.equal(summary.provider_boundary.max_submit_calls, 1);
    assert.equal(summary.provider_boundary.runway_ratio, "720:1280");
    assert.equal(summary.provider_boundary.direct_9_16_sent_to_runway, false);
    assert.equal(summary.selected_input.duration_seconds, 2);
    assert.equal(summary.selected_input.runway_ratio, "720:1280");
  }

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("sk-"), false);
  assert.equal(serialized.includes("key****"), false);
});

test("H3 reviews generated clips and creates regeneration drafts without regenerating", async () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: `H3 Review ${randomUUID().slice(0, 8)}` }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const storyboardArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
      },
      db
    );
    assert.equal(storyboardArtifact.ok, true);
    if (!storyboardArtifact.ok) return;

    const storyboard = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
            video_prompt: "Animate this shot for H3 review."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    assert.equal(storyboard.ok, true);
    if (!storyboard.ok) return;
    const shotId = storyboard.shots[0].shot_id;

    const firstGeneration = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: shotId,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(firstGeneration.ok, true);
    if (!firstGeneration.ok) return;
    const firstArtifactId = firstGeneration.generated_artifact_id ?? "";
    const summary = h3VideoReviewSummary(defaultH1WorkbenchState(), db);
    assert.equal(summary.generated_clips.some((clip) => clip.artifact_id === firstArtifactId && clip.ffprobe?.status === "PASS"), true);

    const approved = approveH3GeneratedClip({ shot_id: shotId, artifact_id: firstArtifactId, write_report: false }, db);
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.value.accepted_clip_artifact_id, firstArtifactId);

    const secondGeneration = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: shotId,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(secondGeneration.ok, true);
    if (!secondGeneration.ok) return;
    const secondArtifactId = secondGeneration.generated_artifact_id ?? "";
    const runCountBeforeReject = getShot(db, shotId)?.generation_run_ids.length ?? 0;

    const rejected = rejectH3GeneratedClip(
      defaultH1WorkbenchState(),
      {
        shot_id: shotId,
        artifact_id: secondArtifactId,
        rejection_reasons: ["motion is too subtle"],
        revision_instruction: {
          summary: "Increase motion",
          prompt_delta: "add a more visible camera move",
          negative_delta: "static",
          priority: "medium"
        },
        write_report: false
      },
      db
    );
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    assert.equal(rejected.value.draft.status, "draft");
    assert.equal(rejected.value.draft.previous_run_id, secondGeneration.run.run_id);
    assert.equal(getShot(db, shotId)?.clip_versions.find((version) => version.artifact_id === secondArtifactId)?.review_status, "rejected");
    assert.equal(getShot(db, shotId)?.generation_run_ids.length, runCountBeforeReject);
  } finally {
    db.close();
  }
});

test("H4 shows assembly readiness and executes final assembly only after explicit confirmation", async () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: `H4 Assembly ${randomUUID().slice(0, 8)}` }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const storyboardArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
      },
      db
    );
    assert.equal(storyboardArtifact.ok, true);
    if (!storyboardArtifact.ok) return;

    const storyboard = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
            video_prompt: "Animate this shot for H4 assembly."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    assert.equal(storyboard.ok, true);
    if (!storyboard.ok) return;

    const shotId = storyboard.shots[0].shot_id;
    const blockedSummary = h4FinalAssemblyWorkbenchSummary(defaultH1WorkbenchState(), db, { project_id: project.project_id });
    assert.equal(blockedSummary.ready_for_assembly, false);
    assert.equal(blockedSummary.blockers.some((blocker) => blocker.includes("MISSING_ACCEPTED_CLIP")), true);

    const generation = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: shotId,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(generation.ok, true);
    if (!generation.ok) return;
    const generatedArtifactId = generation.generated_artifact_id ?? "";

    const missingConfirmation = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: false, write_report: false }, defaultH1WorkbenchState(), db);
    assert.equal(missingConfirmation.ok, false);
    if (missingConfirmation.ok) return;
    assert.equal(missingConfirmation.error.code, "HUMAN_CONFIRMATION_REQUIRED");

    const notReady = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: true, write_report: false }, defaultH1WorkbenchState(), db);
    assert.equal(notReady.ok, false);
    if (notReady.ok) return;
    assert.equal(notReady.error.code, "FINAL_ASSEMBLY_NOT_READY");

    const approved = approveH3GeneratedClip({ shot_id: shotId, artifact_id: generatedArtifactId, write_report: false }, db);
    assert.equal(approved.ok, true);
    if (!approved.ok) return;

    const ready = h4FinalAssemblyWorkbenchSummary(defaultH1WorkbenchState(), db, { project_id: project.project_id });
    assert.equal(ready.ready_for_assembly, true);
    assert.equal(ready.accepted_clips, 1);
    assert.equal(ready.clip_order_preview[0].ffprobe?.status, "PASS");

    const assembled = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: true, write_report: false }, defaultH1WorkbenchState(), db);
    assert.equal(assembled.ok, true);
    if (!assembled.ok) return;

    const report = assembled.value.report as {
      provider_boundary: { runway_called: boolean; runninghub_called: boolean; source_asset_overwritten: boolean; final_assembly_performed: boolean };
      final_video_artifact: { ffprobe: { status: string } | null };
    };
    assert.equal(report.provider_boundary.runway_called, false);
    assert.equal(report.provider_boundary.runninghub_called, false);
    assert.equal(report.provider_boundary.source_asset_overwritten, false);
    assert.equal(report.provider_boundary.final_assembly_performed, true);
    assert.equal(report.final_video_artifact.ffprobe?.status, "PASS");
    assert.equal(getMediaArtifact(db, generatedArtifactId)?.status, "active");
  } finally {
    db.close();
  }
});
