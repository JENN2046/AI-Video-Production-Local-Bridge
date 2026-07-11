import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  ensureM0Directories,
  getMediaArtifact,
  openM0Database,
  paths,
  registerMediaArtifact,
  validateImageFile
} from "../src/index.js";

const REPORT_STEM = "g0_r1_import_prep_result";
const LATEST_REPORT = `data/reports/${REPORT_STEM}.json`;

const approvedKeyframes = [
  {
    shot_id: "SHOT_001",
    order: 1,
    import_filename: "g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png",
    package_source_file: "images/SHOT_001_IMAGE_ACCEPTED_WEBGPT.png",
    approval_basis: "Jenn approval true in G0_R1 package ledger"
  },
  {
    shot_id: "SHOT_002",
    order: 2,
    import_filename: "g0_r1_SHOT_002_IMAGE_WEBGPT_V1.png",
    package_source_file: "images/SHOT_002_IMAGE_WEBGPT_V1.png",
    approval_basis: "Jenn explicit approval in current Codex thread on 2026-07-06"
  },
  {
    shot_id: "SHOT_003",
    order: 3,
    import_filename: "g0_r1_SHOT_003_IMAGE_WEBGPT_V2.png",
    package_source_file: "images/SHOT_003_IMAGE_WEBGPT_V2.png",
    approval_basis: "Jenn explicit approval in current Codex thread on 2026-07-06"
  },
  {
    shot_id: "SHOT_004",
    order: 4,
    import_filename: "g0_r1_SHOT_004_IMAGE_WEBGPT_V2.png",
    package_source_file: "images/SHOT_004_IMAGE_WEBGPT_V2.png",
    approval_basis: "Jenn explicit approval in current Codex thread on 2026-07-06"
  }
] as const;

const skippedKeyframes = [] as const;

const forbiddenAssets = [
  "audit/FAILED_LAYOUT_OUTPUT_01_DO_NOT_USE_AS_KEYFRAME.png",
  "audit/FAILED_LAYOUT_OUTPUT_02_DO_NOT_USE_AS_KEYFRAME.png",
  "references/product_reference_gray_skullcap.png"
] as const;

function reportPath(runId: string): string {
  return join(paths.reportsRoot, `${REPORT_STEM}_${runId}.json`);
}

function latestReportPath(): string {
  return join(paths.workspaceRoot, LATEST_REPORT);
}

function previousArtifactIdForImport(importFilename: string): string | null {
  const latest = latestReportPath();
  if (!existsSync(latest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(latest, "utf8")) as {
      imported_artifacts?: Array<{ data_import_filename?: string; artifact_id?: string }>;
    };
    const existing = parsed.imported_artifacts?.find((artifact) => artifact.data_import_filename === importFilename);
    return existing?.artifact_id ?? null;
  } catch {
    return null;
  }
}

function forbiddenFilename(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (filename !== basename(filename)) return "filename_must_be_plain_data_imports_filename";
  if (lower.includes("audit") || lower.includes("failed_layout") || lower.includes("do_not_use")) return "audit_image_forbidden";
  if (lower.includes("product_reference") || lower.includes("reference")) return "product_reference_forbidden";
  if (lower.includes("pending_")) return "pending_id_or_pending_asset_forbidden";
  if (!lower.endsWith(".png")) return "only_png_keyframes_supported";
  return null;
}

function writeReport(runId: string, payload: unknown): string {
  ensureM0Directories();
  const immutablePath = reportPath(runId);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(immutablePath, text, "utf8");
  writeFileSync(latestReportPath(), text, "utf8");
  return immutablePath;
}

ensureM0Directories();
const db = openM0Database();
const runId = randomUUID();

try {
  const importedArtifacts = [];
  const skipped = [...skippedKeyframes];
  const rejected = forbiddenAssets.map((asset) => ({
    package_source_file: asset,
    status: asset.startsWith("audit/") ? "REJECTED_AUDIT_IMAGE" : "REJECTED_PRODUCT_REFERENCE"
  }));

  for (const keyframe of approvedKeyframes) {
    const filenameError = forbiddenFilename(keyframe.import_filename);
    if (filenameError) {
      throw new Error(`${keyframe.shot_id} cannot be imported: ${filenameError}`);
    }

    const importPath = join(paths.importsRoot, keyframe.import_filename);
    if (!existsSync(importPath)) {
      throw new Error(`${keyframe.shot_id} import image is missing from data/imports: ${keyframe.import_filename}`);
    }

    const validation = validateImageFile(importPath);
    if (!validation.ok) {
      throw new Error(`${keyframe.shot_id} image validation failed: ${validation.error_code} ${validation.error}`);
    }

    let artifact = null;
    let registrationMode = "created_new_active_artifact";
    const previousArtifactId = previousArtifactIdForImport(keyframe.import_filename);
    if (previousArtifactId) {
      const previous = getMediaArtifact(db, previousArtifactId);
      if (
        previous?.artifact_type === "image" &&
        previous.role === "storyboard_image" &&
        previous.status === "active" &&
        validateImageFile(previous.storage.uri).ok
      ) {
        artifact = previous;
        registrationMode = "reused_existing_active_artifact";
      }
    }

    if (!artifact) {
      const registered = registerMediaArtifact(
        {
          artifact_type: "image",
          role: "storyboard_image",
          source: {
            kind: "local_file_import",
            import_filename: keyframe.import_filename
          }
        },
        db
      );
      if (!registered.ok) {
        throw new Error(`${keyframe.shot_id} media artifact registration failed: ${registered.error.code} ${registered.error.message}`);
      }
      artifact = registered.artifact;
    }

    const storedValidation = validateImageFile(artifact.storage.uri);
    if (!storedValidation.ok) {
      throw new Error(`${keyframe.shot_id} stored artifact validation failed: ${storedValidation.error_code} ${storedValidation.error}`);
    }

    importedArtifacts.push({
      shot_id: keyframe.shot_id,
      order: keyframe.order,
      package_source_file: keyframe.package_source_file,
      data_import_filename: keyframe.import_filename,
      approval_basis: keyframe.approval_basis,
      registration_mode: registrationMode,
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.artifact_type,
      role: artifact.role,
      status: artifact.status,
      storage_uri: artifact.storage.uri,
      mime_type: artifact.storage.mime_type,
      width: artifact.metadata.width,
      height: artifact.metadata.height,
      aspect_ratio: artifact.metadata.aspect_ratio,
      source_sha256: validation.sha256,
      stored_sha256: storedValidation.sha256
    });
  }

  const result = {
    task: "G0-R1-IMPORT-PREP",
    result: "PASS",
    run_id: runId,
    generated_at: new Date().toISOString(),
    input_policy: {
      selected_source: "data/imports",
      accepted_pending_ids: false,
      audit_images_imported: false,
      product_reference_imported_as_storyboard_image: false
    },
    provider_boundary: {
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      video_generated: false,
      source_assets_overwritten: false
    },
    imported_artifacts: importedArtifacts,
    skipped_keyframes: skipped,
    rejected_assets: rejected,
    report_path: `data/reports/${REPORT_STEM}_${runId}.json`,
    latest_report_path: LATEST_REPORT
  };
  writeReport(runId, result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    task: "G0-R1-IMPORT-PREP",
    result: "BLOCK",
    run_id: runId,
    generated_at: new Date().toISOString(),
    error: {
      code: "G0_R1_IMPORT_PREP_BLOCKED",
      message: error instanceof Error ? error.message : "Import prep failed."
    },
    provider_boundary: {
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      video_generated: false,
      source_assets_overwritten: false
    },
    imported_artifacts: [],
    skipped_keyframes: skippedKeyframes,
    rejected_assets: forbiddenAssets
  };
  writeReport(runId, result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
}
