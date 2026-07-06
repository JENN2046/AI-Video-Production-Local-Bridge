import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { ensureM0Directories, paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { validateImageFile, type ImageValidationResult } from "./imageValidity.js";
import { importG0AppReadyStoryboardPackage, validateG0StoryboardPackage, type G0StoryboardPackageInput } from "./g0Pregen.js";
import { registerMediaArtifact, type MediaArtifact } from "./mediaArtifacts.js";
import { createProject, getProject, type Project } from "./projects.js";

export const GPT_HANDOFF_FREEZE_REPORT = "data/reports/m1_5_gpt_handoff_app_freeze_report.json";
const GPT_HANDOFF_FREEZE_REPORT_STEM = "m1_5_gpt_handoff_app_freeze_report";

export interface GptHandoffImportImage {
  filename: string;
  relative_path: string;
  size_bytes: number;
  mime_type: string;
  width: number;
  height: number;
  aspect_ratio: string;
  readable_by_image_validator: boolean;
  error_code: string;
  error: string;
}

export interface GptHandoffShotInput {
  import_filename: string;
  order: number;
  duration_seconds: number;
  shot_description: string;
  video_prompt: string;
  negative_prompt?: string;
  continuity_constraints?: string[];
}

export interface FreezeGptHandoffInput {
  project_id?: string;
  project_title?: string;
  shots: GptHandoffShotInput[];
  approved_by_user?: boolean;
  write_report?: boolean;
}

export interface FreezeGptHandoffReport {
  task: "M1.5-GPT-HANDOFF-APP";
  result: "PASS" | "BLOCK";
  run_id: string;
  generated_at: string;
  network_call_attempted: false;
  runway_called: false;
  runninghub_called: false;
  provider_credits_consumed: false;
  real_video_generated: false;
  regeneration_performed: false;
  batch_generation_performed: false;
  secret_values_exposed: false;
  source_asset_overwrite: false;
  project: {
    project_id: string;
    title: string;
    status: string;
  };
  input_summary: {
    requested_shots: number;
    source: "web_gpt_local_imports";
    artifact_ids_from_gpt: false;
  };
  imported_artifacts: Array<{
    order: number;
    import_filename: string;
    artifact_id: string;
    artifact_type: string;
    role: string;
    status: string;
    storage_uri: string;
    width: number;
    height: number;
    aspect_ratio: string;
  }>;
  package_validation: {
    validateG0StoryboardPackage: "PASS" | "FAIL";
    importG0AppReadyStoryboardPackage: "PASS" | "FAIL";
    error_code: string | null;
    error_message: string | null;
  };
  storyboard_package: {
    storyboard_package_id: string | null;
    frozen: boolean;
    shot_count: number;
    shot_ids: string[];
  };
  report_path: string;
  latest_report_path: string;
}

type FreezeResult = { ok: true; report: FreezeGptHandoffReport } | { ok: false; report: FreezeGptHandoffReport; error: { code: string; message: string } };
type HandoffError = { code: string; message: string };
type PreparedShot = {
  input: GptHandoffShotInput;
  order: number;
  validation: ImageValidationResult;
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

function latestReportPath(): string {
  return join(paths.workspaceRoot, GPT_HANDOFF_FREEZE_REPORT);
}

function immutableReportRelativePath(runId: string): string {
  return `data/reports/${GPT_HANDOFF_FREEZE_REPORT_STEM}_${runId}.json`;
}

function immutableReportPath(runId: string): string {
  return join(paths.reportsRoot, `${GPT_HANDOFF_FREEZE_REPORT_STEM}_${runId}.json`);
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function imageValidationError(validation: ImageValidationResult): HandoffError {
  return {
    code: validation.error_code || "IMAGE_FILE_INVALID",
    message: validation.error || "Image validation failed."
  };
}

function emptyProjectReport(input: { project: Project; requestedShots: number; runId: string }): FreezeGptHandoffReport {
  return {
    task: "M1.5-GPT-HANDOFF-APP",
    result: "BLOCK",
    run_id: input.runId,
    generated_at: new Date().toISOString(),
    network_call_attempted: false,
    runway_called: false,
    runninghub_called: false,
    provider_credits_consumed: false,
    real_video_generated: false,
    regeneration_performed: false,
    batch_generation_performed: false,
    secret_values_exposed: false,
    source_asset_overwrite: false,
    project: {
      project_id: input.project.project_id,
      title: input.project.title,
      status: input.project.status
    },
    input_summary: {
      requested_shots: input.requestedShots,
      source: "web_gpt_local_imports",
      artifact_ids_from_gpt: false
    },
    imported_artifacts: [],
    package_validation: {
      validateG0StoryboardPackage: "FAIL",
      importG0AppReadyStoryboardPackage: "FAIL",
      error_code: null,
      error_message: null
    },
    storyboard_package: {
      storyboard_package_id: null,
      frozen: false,
      shot_count: 0,
      shot_ids: []
    },
    report_path: immutableReportRelativePath(input.runId),
    latest_report_path: GPT_HANDOFF_FREEZE_REPORT
  };
}

function block(report: FreezeGptHandoffReport, code: string, message: string, writeReport: boolean): FreezeResult {
  const next = {
    ...report,
    result: "BLOCK" as const,
    package_validation: {
      ...report.package_validation,
      error_code: code,
      error_message: message
    }
  };
  if (writeReport) writeFreezeReport(next);
  return { ok: false, report: next, error: { code, message } };
}

function validImportFilename(filename: string): boolean {
  return filename === basename(filename) && IMAGE_EXTENSIONS.has(extname(filename).toLowerCase());
}

function cleanupImportedArtifactFiles(report: FreezeGptHandoffReport): void {
  for (const artifact of report.imported_artifacts) {
    const target = resolve(artifact.storage_uri);
    if (isPathInside(target, paths.imageArtifactsRoot)) {
      rmSync(target, { force: true });
    }
  }
}

function validateImportImageReady(filename: string): { ok: true; validation: ImageValidationResult } | { ok: false; error: HandoffError } {
  if (!validImportFilename(filename)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: `Invalid import filename: ${filename}` } };
  }

  const importsRoot = resolve(paths.importsRoot);
  const sourcePath = resolve(importsRoot, filename);
  if (!isPathInside(sourcePath, importsRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Import path resolved outside data/imports." } };
  }
  if (!existsSync(sourcePath)) {
    return { ok: false, error: { code: "IMAGE_FILE_NOT_READABLE", message: `Import image is not readable: ${filename}` } };
  }
  const linkStat = lstatSync(sourcePath);
  if (linkStat.isSymbolicLink()) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "local_file_import refuses symbolic links." } };
  }
  const realSourcePath = realpathSync(sourcePath);
  if (!isPathInside(realSourcePath, importsRoot)) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Import file resolves outside data/imports." } };
  }
  if (!statSync(realSourcePath).isFile()) {
    return { ok: false, error: { code: "IMAGE_FILE_NOT_READABLE", message: "Import path is not a file." } };
  }

  const validation = validateImageFile(realSourcePath);
  if (!validation.ok) return { ok: false, error: imageValidationError(validation) };
  return { ok: true, validation };
}

function prepareShots(input: FreezeGptHandoffInput): { ok: true; shots: PreparedShot[] } | { ok: false; error: HandoffError } {
  if (!input.shots?.length) {
    return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "At least one shot is required." } };
  }
  if (input.approved_by_user !== true) {
    return { ok: false, error: { code: "USER_APPROVAL_REQUIRED", message: "Web GPT handoff freeze requires explicit approved_by_user=true." } };
  }

  const seenOrders = new Set<number>();
  const preparedShots: PreparedShot[] = [];
  for (const [index, shot] of input.shots.entries()) {
    const order = Number.isInteger(shot.order) && shot.order > 0 ? shot.order : index + 1;
    if (seenOrders.has(order)) {
      return { ok: false, error: { code: "DUPLICATE_SHOT_ORDER", message: `Duplicate shot order: ${order}` } };
    }
    seenOrders.add(order);
    if (!shot.shot_description?.trim()) return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: `Shot ${order} is missing shot_description.` } };
    if (!shot.video_prompt?.trim()) return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: `Shot ${order} is missing video_prompt.` } };
    if (typeof shot.duration_seconds !== "number" || shot.duration_seconds <= 0) {
      return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: `Shot ${order} has invalid duration_seconds.` } };
    }

    const importValidation = validateImportImageReady(shot.import_filename);
    if (!importValidation.ok) {
      return { ok: false, error: { code: importValidation.error.code, message: `Shot ${order}: ${importValidation.error.message}` } };
    }

    preparedShots.push({ input: shot, order, validation: importValidation.validation });
  }

  return { ok: true, shots: preparedShots };
}

function shotIdFor(order: number): string {
  return `shot_${String(order).padStart(3, "0")}_${randomUUID()}`;
}

function ensureProject(input: FreezeGptHandoffInput, db: M0Database) {
  if (input.project_id) {
    const project = getProject(db, input.project_id);
    if (!project) return { ok: false as const, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };
    return { ok: true as const, project };
  }

  const created = createProject(
    {
      title: input.project_title?.trim() || `Web GPT Handoff ${new Date().toISOString()}`,
      project_type: "web_gpt_handoff",
      video_spec: {
        aspect_ratio: "9:16",
        resolution: "1080x1920"
      }
    },
    db
  );
  if (!created.ok) return created;
  return { ok: true as const, project: created.project };
}

export function scanGptHandoffImports(): GptHandoffImportImage[] {
  ensureM0Directories();
  if (!existsSync(paths.importsRoot)) return [];

  return readdirSync(paths.importsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const filePath = join(paths.importsRoot, entry.name);
      const validation = validateImageFile(filePath);
      return {
        filename: entry.name,
        relative_path: `data/imports/${entry.name}`,
        size_bytes: statSync(filePath).size,
        mime_type: validation.detected_mime,
        width: validation.width,
        height: validation.height,
        aspect_ratio: validation.aspect_ratio,
        readable_by_image_validator: validation.ok,
        error_code: validation.error_code,
        error: validation.error
      };
    });
}

export function writeFreezeReport(report: FreezeGptHandoffReport): string {
  ensureM0Directories();
  const immutableTarget = immutableReportPath(report.run_id);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(immutableTarget, payload, "utf8");
  writeFileSync(latestReportPath(), payload, "utf8");
  return immutableTarget;
}

export function freezeGptHandoffStoryboardPackage(input: FreezeGptHandoffInput, db = openM0Database()): FreezeResult {
  ensureM0Directories();
  const runId = randomUUID();
  const writeReport = input.write_report !== false;
  const prepared = prepareShots(input);
  if (!prepared.ok) {
    const fallbackProject: Project = {
      project_id: input.project_id ?? "",
      title: input.project_title ?? "",
      project_type: "web_gpt_handoff",
      status: "draft",
      brief: {},
      video_spec: { duration_seconds: 0, aspect_ratio: "9:16", resolution: "1080x1920" },
      shot_ids: [],
      active_storyboard_package_id: "",
      generation_batch_ids: [],
      exports: { final_video_artifact_id: "" }
    };
    return block(emptyProjectReport({ project: fallbackProject, requestedShots: input.shots?.length ?? 0, runId }), prepared.error.code, prepared.error.message, writeReport);
  }

  let transactionOpen = false;
  const rollback = (report: FreezeGptHandoffReport): void => {
    if (transactionOpen) {
      db.exec("ROLLBACK");
      transactionOpen = false;
    }
    cleanupImportedArtifactFiles(report);
  };

  const mutationFallbackProject: Project = {
    project_id: input.project_id ?? "",
    title: input.project_title ?? "",
    project_type: "web_gpt_handoff",
    status: "draft",
    brief: {},
    video_spec: { duration_seconds: 0, aspect_ratio: "9:16", resolution: "1080x1920" },
    shot_ids: [],
    active_storyboard_package_id: "",
    generation_batch_ids: [],
    exports: { final_video_artifact_id: "" }
  };
  let activeReport = emptyProjectReport({ project: mutationFallbackProject, requestedShots: input.shots?.length ?? 0, runId });
  let successReport: FreezeGptHandoffReport | null = null;

  try {
  db.exec("BEGIN IMMEDIATE");
  transactionOpen = true;

  const projectResult = ensureProject(input, db);
  if (!projectResult.ok) {
    rollback(activeReport);
    return block(activeReport, projectResult.error.code, projectResult.error.message, writeReport);
  }

  const report = emptyProjectReport({ project: projectResult.project, requestedShots: input.shots?.length ?? 0, runId });
  activeReport = report;
  const fail = (code: string, message: string, sourceReport = report): FreezeResult => {
    rollback(sourceReport);
    return block(sourceReport, code, message, writeReport);
  };

  const packageShots: G0StoryboardPackageInput["shots"] = [];
  for (const preparedShot of prepared.shots) {
    const shot = preparedShot.input;
    const order = preparedShot.order;
    const artifactResult = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "local_file_import",
          import_filename: shot.import_filename
        },
        linked_objects: {
          project_id: projectResult.project.project_id
        }
      },
      db
    );
    if (!artifactResult.ok) return fail(artifactResult.error.code, artifactResult.error.message);

    const artifact: MediaArtifact = artifactResult.artifact;
    report.imported_artifacts.push({
      order,
      import_filename: shot.import_filename,
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.artifact_type,
      role: artifact.role,
      status: artifact.status,
      storage_uri: artifact.storage.uri,
      width: artifact.metadata.width,
      height: artifact.metadata.height,
      aspect_ratio: artifact.metadata.aspect_ratio
    });

    packageShots.push({
      shot_id: shotIdFor(order),
      order,
      duration_seconds: shot.duration_seconds,
      storyboard_image_artifact_id: artifact.artifact_id,
      shot_description: shot.shot_description,
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt ?? "",
      continuity_constraints: shot.continuity_constraints ?? [],
      approved_by_user: true
    });
  }

  const packageInput: G0StoryboardPackageInput = {
    project_id: projectResult.project.project_id,
    status: "approved_for_video_generation",
    shots: packageShots,
    approved_by_user: true,
    confirmation: {
      user_confirmed: true,
      source: "app"
    }
  };

  const validation = validateG0StoryboardPackage(packageInput, db);
  if (!validation.ok) return fail(validation.error.code, validation.error.message);

  const imported = importG0AppReadyStoryboardPackage(packageInput, db);
  if (!imported.ok) {
    return fail(
      imported.error.code,
      imported.error.message,
      {
        ...report,
        package_validation: {
          ...report.package_validation,
          validateG0StoryboardPackage: "PASS"
        }
      }
    );
  }

  const success: FreezeGptHandoffReport = {
    ...report,
    result: "PASS",
    project: {
      project_id: imported.project.project_id,
      title: imported.project.title,
      status: imported.project.status
    },
    package_validation: {
      validateG0StoryboardPackage: "PASS",
      importG0AppReadyStoryboardPackage: "PASS",
      error_code: null,
      error_message: null
    },
    storyboard_package: {
      storyboard_package_id: imported.storyboard_package_id,
      frozen: true,
      shot_count: imported.shots.length,
      shot_ids: imported.shots.map((shot) => shot.shot_id)
    }
  };
  db.exec("COMMIT");
  transactionOpen = false;
  successReport = success;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected handoff freeze failure.";
    rollback(activeReport);
    return block(activeReport, "HANDOFF_FREEZE_FAILED", message, writeReport);
  }

  if (!successReport) return block(activeReport, "HANDOFF_FREEZE_FAILED", "Unexpected handoff freeze failure.", writeReport);
  if (writeReport) writeFreezeReport(successReport);
  return { ok: true, report: successReport };
}
