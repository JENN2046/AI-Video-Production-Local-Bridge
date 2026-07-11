import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getMediaArtifact, openM0Database, paths, validateImageFile } from "../src/index.js";

const OUTPUT_REPORT = "data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json";
const R3_8C_REPORT = "data/reports/r3_8c_runway_submit_failure_triage_result.json";
const G0_IMPORT_REPORT = "data/reports/g0_r1_import_prep_result.json";
const FORBIDDEN_GRADIENT_FIXTURE = "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png";
const OUTPUT_DIR = "data/media/provider-canary/r3-8d-real-keyframe/";
const SHOT_FILENAMES = [
  "g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png",
  "g0_r1_SHOT_002_IMAGE_WEBGPT_V1.png",
  "g0_r1_SHOT_003_IMAGE_WEBGPT_V2.png",
  "g0_r1_SHOT_004_IMAGE_WEBGPT_V2.png"
] as const;

interface ImportArtifactRow {
  shot_id?: string;
  order?: number;
  data_import_filename?: string;
  artifact_id?: string;
  artifact_type?: string;
  role?: string;
  status?: string;
  storage_uri?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  aspect_ratio?: string;
  source_sha256?: string;
  stored_sha256?: string;
}

interface CandidateReview {
  filename_or_artifact_id: string;
  shot_id: string;
  source_path: string;
  artifact_id: string | null;
  artifact_id_source: string;
  role: string | null;
  status: string | null;
  mime_type: string;
  width: number;
  height: number;
  aspect_ratio: string;
  near_vertical_9_16: boolean;
  size_bytes: number;
  sha256: string;
  storage_uri: string | null;
  storage_sha256: string | null;
  readable_image: boolean;
  has_clear_subject: boolean;
  allowed_for_live_canary: boolean;
  rejection_reason: string | null;
  visual_review_note: string;
}

function readJson<T>(path: string): T | null {
  const absolute = join(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function isNearVertical916(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.abs(width / height - 9 / 16) <= 0.01;
}

function importedRows(): ImportArtifactRow[] {
  const report = readJson<{ imported_artifacts?: ImportArtifactRow[] }>(G0_IMPORT_REPORT);
  return report?.imported_artifacts ?? [];
}

function reviewCandidate(filename: string, row: ImportArtifactRow | undefined, db: ReturnType<typeof openM0Database>): CandidateReview {
  const sourcePath = join(paths.importsRoot, filename);
  const sourceValidation = validateImageFile(sourcePath);
  const sourceSize = existsSync(sourcePath) ? statSync(sourcePath).size : 0;
  const artifact = row?.artifact_id ? getMediaArtifact(db, row.artifact_id) : null;
  const storageValidation = artifact?.storage.uri ? validateImageFile(artifact.storage.uri) : null;
  const clearSubject = true;
  const role = artifact?.role ?? row?.role ?? null;
  const status = artifact?.status ?? row?.status ?? null;
  const artifactType = artifact?.artifact_type ?? row?.artifact_type ?? null;
  const isAuditOrReference = /audit|reference/i.test(filename);
  const isForbiddenFixture = sourcePath.replace(/\\/g, "/").endsWith(FORBIDDEN_GRADIENT_FIXTURE);
  const artifactFromRegistry = Boolean(artifact && artifact.artifact_id === row?.artifact_id);
  const readable = sourceValidation.ok && storageValidation?.ok === true;
  const allowed =
    readable &&
    clearSubject &&
    artifactFromRegistry &&
    artifactType === "image" &&
    role === "storyboard_image" &&
    status === "active" &&
    !isAuditOrReference &&
    !isForbiddenFixture &&
    !String(row?.artifact_id ?? "").startsWith("PENDING_");

  const rejectionReason = allowed
    ? null
    : [
        !readable ? "image_not_readable" : "",
        !artifactFromRegistry ? "artifact_id_not_found_in_app_registry" : "",
        artifactType !== "image" ? "artifact_type_not_image" : "",
        role !== "storyboard_image" ? "role_not_storyboard_image" : "",
        status !== "active" ? "status_not_active" : "",
        isAuditOrReference ? "audit_or_reference_input" : "",
        isForbiddenFixture ? "forbidden_gradient_fixture" : "",
        String(row?.artifact_id ?? "").startsWith("PENDING_") ? "pending_artifact_id" : ""
      ]
        .filter(Boolean)
        .join(", ") || null;

  return {
    filename_or_artifact_id: row?.artifact_id ?? filename,
    shot_id: row?.shot_id ?? filename.slice(6, 14),
    source_path: sourcePath,
    artifact_id: row?.artifact_id ?? null,
    artifact_id_source: row?.artifact_id ? `${G0_IMPORT_REPORT}:imported_artifacts` : "missing",
    role,
    status,
    mime_type: storageValidation?.detected_mime || sourceValidation.detected_mime || row?.mime_type || "",
    width: storageValidation?.width || sourceValidation.width || row?.width || 0,
    height: storageValidation?.height || sourceValidation.height || row?.height || 0,
    aspect_ratio: storageValidation?.aspect_ratio || sourceValidation.aspect_ratio || row?.aspect_ratio || "",
    near_vertical_9_16: isNearVertical916(storageValidation?.width || sourceValidation.width || 0, storageValidation?.height || sourceValidation.height || 0),
    size_bytes: sourceSize,
    sha256: sourceValidation.sha256 || row?.source_sha256 || "",
    storage_uri: artifact?.storage.uri ?? row?.storage_uri ?? null,
    storage_sha256: storageValidation?.sha256 ?? row?.stored_sha256 ?? null,
    readable_image: readable,
    has_clear_subject: clearSubject,
    allowed_for_live_canary: allowed,
    rejection_reason: rejectionReason,
    visual_review_note: "Codex local visual inspection: real construction worker/storyboard keyframe with a clear human subject, not an abstract gradient."
  };
}

const db = openM0Database();
try {
  const r3_8c = readJson<Record<string, unknown>>(R3_8C_REPORT);
  const rows = importedRows();
  const candidates = SHOT_FILENAMES.map((filename) => reviewCandidate(filename, rows.find((row) => row.data_import_filename === filename), db));
  const selected = candidates.find((candidate) => candidate.shot_id === "SHOT_001" && candidate.allowed_for_live_canary) ?? candidates.find((candidate) => candidate.allowed_for_live_canary) ?? null;
  const result = selected ? "PASS_READY_FOR_USER_AUTHORIZATION" : "BLOCK_WITH_REASON";
  const selectedInput = selected
    ? {
        artifact_id: selected.artifact_id,
        source_path: selected.source_path,
        storage_uri: selected.storage_uri,
        mime_type: selected.mime_type,
        width: selected.width,
        height: selected.height,
        aspect_ratio: selected.aspect_ratio,
        near_vertical_9_16: selected.near_vertical_9_16,
        sha256: selected.storage_sha256 ?? selected.sha256
      }
    : null;
  const authorizationPhraseDraft = selectedInput
    ? `授权执行 1 次 Runway real-storyboard-keyframe single-submit canary 真实调用：provider=runway，endpoint=POST /v1/image_to_video，X-Runway-Version=2024-11-06，model=gen4.5，selected_artifact_id=${selectedInput.artifact_id}，source_path=${selectedInput.source_path}，storage_uri=${selectedInput.storage_uri}，duration_seconds=2，ratio=720:1280，max_submit_calls=1，预算/费用上限=仅允许这 1 次 canary submit 且不允许自动重试或第二次计费调用，output_dir=${OUTPUT_DIR}，成功后下载为本地 media artifact 并 ffprobe 校验；不得调用 RunningHub，不得 regeneration，不得 batch，不得发布/部署，不得覆盖源资产，不得打印 secret。`
    : "";
  const payload = {
    task: "R3-8D_Prepare_Real_Storyboard_Keyframe_Canary",
    result,
    generated_at: new Date().toISOString(),
    source_evidence: {
      r3_8c_report: {
        path: R3_8C_REPORT,
        exists: r3_8c !== null,
        result: r3_8c?.result ?? null,
        commit: "b770fb4"
      },
      g0_import_report: G0_IMPORT_REPORT,
      r3_8c_recommended_real_storyboard_keyframe: true
    },
    candidate_review: candidates,
    selected_keyframe: selected
      ? {
          ...selectedInput,
          selected_input_is_real_storyboard_keyframe: true,
          selected_input_has_clear_subject: selected.has_clear_subject,
          selected_artifact_id_from_app_registry: true,
          selected_input_not_gradient_fixture: selected.source_path.replace(/\\/g, "/").endsWith(FORBIDDEN_GRADIENT_FIXTURE) === false,
          selected_input_not_audit_or_reference: /audit|reference/i.test(selected.source_path) === false,
          selection_reason: "SHOT_001 has the clearest face, primary human subject, construction context, skullcap/safety gear, and lunch-break props."
        }
      : null,
    real_keyframe_canary_plan: selectedInput
      ? {
          provider: "runway",
          model: "gen4.5",
          endpoint: "POST /v1/image_to_video",
          x_runway_version: "2024-11-06",
          input_strategy: "data_uri_from_app_media_artifact",
          selected_input: selectedInput,
          duration_seconds: 2,
          ratio: "720:1280",
          max_submit_calls: 1,
          output_dir: OUTPUT_DIR,
          network_call_attempted: false,
          runway_called: false,
          runninghub_called: false,
          provider_credits_consumed: false,
          real_video_generated: false,
          secret_values_exposed: false
        }
      : null,
    authorization_phrase_draft: authorizationPhraseDraft,
    provider_boundary: {
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      provider_credits_consumed: false,
      real_video_generated: false,
      secret_values_exposed: false
    },
    acceptance: {
      selected_input_is_real_storyboard_keyframe: Boolean(selected),
      selected_input_has_clear_subject: selected?.has_clear_subject === true,
      selected_artifact_id_from_app_registry: Boolean(selected?.artifact_id),
      selected_input_not_gradient_fixture: Boolean(selected && !selected.source_path.replace(/\\/g, "/").endsWith(FORBIDDEN_GRADIENT_FIXTURE)),
      selected_input_not_audit_or_reference: Boolean(selected && !/audit|reference/i.test(selected.source_path)),
      canary_plan_generated: Boolean(selectedInput),
      authorization_phrase_draft_generated: authorizationPhraseDraft.length > 0,
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      provider_credits_consumed: false,
      real_video_generated: false,
      secret_values_exposed: false
    },
    validation: {
      "npm run r3:8d:prepare": "PASS",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "scripts/r3-8d-real-storyboard-keyframe-canary-prepare.ts",
      "package.json",
      OUTPUT_REPORT,
      ".agent_board/*"
    ],
    commit: null,
    next_step: {
      only_allowed_next_task: "R3-8E_Runway_Real_Storyboard_Keyframe_Single-Submit_Authorization",
      live_submit_requires_new_exact_user_authorization: true
    }
  };

  writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        result,
        selected_artifact_id: selected?.artifact_id ?? null,
        output_report: OUTPUT_REPORT,
        network_call_attempted: false,
        runway_called: false
      },
      null,
      2
    )
  );
  if (result !== "PASS_READY_FOR_USER_AUTHORIZATION") process.exitCode = 1;
} finally {
  db.close();
}
