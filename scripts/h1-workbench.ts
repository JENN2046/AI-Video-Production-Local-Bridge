import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { handleWorkbenchV2Api } from "../src/http/workbenchV2Routes.js";
import { resumeWorkbenchGenerationJobs } from "../src/tools/workbenchGeneration.js";
import { migrateLegacyWorkbenchInboxStores } from "../src/tools/workbenchInboxStore.js";

import {
  ensureM0Directories,
  approveH3GeneratedClip,
  confirmMemorySavebackProposal,
  confirmWebGptPendingAction,
  generateMemoryRecallPack,
  freezeH1StoryboardPackage,
  getMediaArtifact,
  H1_PROVIDER_BOUNDARY,
  h1DashboardSummary,
  h2CanaryWorkbenchSummary,
  h3VideoReviewSummary,
  h4FinalAssemblyWorkbenchSummary,
  executeH4FinalAssembly,
  h1ShotBlockers,
  linkH1ArtifactToShot,
  listH1Reports,
  loadH1WorkbenchState,
  markH1ShotApproved,
  markH1ShotRevisionNeeded,
  openM0Database,
  paths,
  prepareH1StoryboardPackageProject,
  registerH1ApprovedKeyframe,
  rejectH1Import,
  rejectH3GeneratedClip,
  rejectWebGptPendingAction,
  saveH1WorkbenchState,
  scanH1Imports,
  updateH1ShotMetadata,
  validateH1StoryboardPackage,
  validateImageFile,
  memorySavebackWorkbenchSummary,
  webGptDraftWorkbenchSummary,
  webGptPendingActionWorkbenchSummary
} from "../src/index.js";

const DEFAULT_PORT = 4181;
const ACTION_NONCE = randomUUID();
const MAX_BODY_BYTES = 1024 * 1024;
const R3_9P_FINAL_REVIEW_REPORT = "data/reports/r3_9p_final_video_review_package_result.json";
const R3_9O_FINAL_ASSEMBLY_REPORT = "data/reports/r3_9o_final_video_assembly_execution_result.json";
const R3_9Q_FINAL_DECISION_STEM = "r3_9q_final_video_review_decision_result";
const R3_9Q_FINAL_DECISION_REPORT = `data/reports/${R3_9Q_FINAL_DECISION_STEM}.json`;
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  ...IMAGE_CONTENT_TYPES,
  ".mp4": "video/mp4"
};
const UI_ASSETS_ROOT = resolve(paths.workspaceRoot, "data", "ui");
const V2_UI_ROOT = resolve(paths.workspaceRoot, "dist", "workbench-ui");
const V2_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function isLocalRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? "";
  if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
  const host = normalizeHostHeader(request.headers.host);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function normalizeHostHeader(hostHeader: string | undefined): string {
  const host = (hostHeader ?? "").toLowerCase();
  if (host.startsWith("[::1]")) return "::1";
  const colonIndex = host.indexOf(":");
  return colonIndex === -1 ? host : host.slice(0, colonIndex);
}

function hasMutationNonce(request: IncomingMessage): boolean {
  return request.headers["x-h1-action-nonce"] === ACTION_NONCE;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("请求体必须是有效 JSON。"));
      }
    });
    request.on("error", reject);
  });
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function serveImportImage(pathname: string, response: ServerResponse): void {
  const filename = basename(decodeURIComponent(pathname.replace("/imports/", "")));
  const extension = extname(filename).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到导入图片。" } });
    return;
  }

  const importsRoot = resolve(paths.importsRoot);
  const target = resolve(importsRoot, filename);
  if (!isPathInside(target, importsRoot) || !existsSync(target) || lstatSync(target).isSymbolicLink()) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到导入图片。" } });
    return;
  }

  const realTarget = realpathSync(target);
  if (!isPathInside(realTarget, importsRoot) || !statSync(realTarget).isFile() || !validateImageFile(realTarget).ok) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到导入图片。" } });
    return;
  }

  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  createReadStream(realTarget).pipe(response);
}

function serveUiAsset(pathname: string, response: ServerResponse): void {
  const filename = basename(decodeURIComponent(pathname.replace("/ui-assets/", "")));
  const extension = extname(filename).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到 UI 资源。" } });
    return;
  }

  const target = resolve(UI_ASSETS_ROOT, filename);
  if (!isPathInside(target, UI_ASSETS_ROOT) || !existsSync(target) || lstatSync(target).isSymbolicLink()) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到 UI 资源。" } });
    return;
  }

  const realTarget = realpathSync(target);
  if (!isPathInside(realTarget, UI_ASSETS_ROOT) || !statSync(realTarget).isFile()) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到 UI 资源。" } });
    return;
  }

  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  createReadStream(realTarget).pipe(response);
}

function serveWorkbenchV2(pathname: string, response: ServerResponse): void {
  const target = pathname.startsWith("/v2-assets/")
    ? resolve(V2_UI_ROOT, pathname.slice(1))
    : resolve(V2_UI_ROOT, "index.html");
  if (!isPathInside(target, V2_UI_ROOT) || !existsSync(target) || lstatSync(target).isSymbolicLink()) {
    sendJson(response, 503, { ok: false, error: { code: "V2_UI_NOT_BUILT", message: "V2 UI has not been built yet." } });
    return;
  }
  const realTarget = realpathSync(target);
  if (!isPathInside(realTarget, V2_UI_ROOT) || !statSync(realTarget).isFile()) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "V2 asset was not found." } });
    return;
  }
  const contentType = V2_CONTENT_TYPES[extname(realTarget).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": pathname.startsWith("/v2-assets/") ? "public, max-age=31536000, immutable" : "no-store"
  });
  createReadStream(realTarget).pipe(response);
}

function readReport(name: string): unknown {
  const filename = basename(name);
  if (filename !== name || !filename.endsWith(".json")) {
    return { ok: false, error: { code: "REPORT_NOT_FOUND", message: "未找到报告。" } };
  }
  const target = resolve(paths.reportsRoot, filename);
  if (!isPathInside(target, paths.reportsRoot) || !existsSync(target)) {
    return { ok: false, error: { code: "REPORT_NOT_FOUND", message: "未找到报告。" } };
  }
  return JSON.parse(readFileSync(target, "utf8"));
}

function readJsonReport(relativePath: string): Record<string, unknown> | null {
  const target = resolve(paths.workspaceRoot, relativePath);
  if (!isPathInside(target, paths.reportsRoot) || !existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finalDecisionReport() {
  const report = readJsonReport(R3_9Q_FINAL_DECISION_REPORT);
  if (!report) return null;
  const reviewPackage = objectValue(report.review_package);
  return {
    report_path: R3_9Q_FINAL_DECISION_REPORT,
    result: String(report.result ?? "UNKNOWN"),
    generated_at: String(report.generated_at ?? ""),
    decision: String(report.decision ?? ""),
    reviewer: String(report.reviewer ?? ""),
    note: String(report.note ?? ""),
    final_creative_approval_recorded: reviewPackage.final_creative_approval_recorded === true,
    provider_boundary: objectValue(report.provider_boundary)
  };
}

function markdownCellText(value: string): string {
  return value.trim().replace(/^`|`$/g, "").replace(/<br>/gi, "\n").replace(/\\\|/g, "|");
}

function finalReviewTableDecision(relativePath: string) {
  if (!relativePath) return null;
  const target = resolve(paths.workspaceRoot, relativePath);
  if (!isPathInside(target, paths.reportsRoot) || !existsSync(target)) return null;
  const row = readFileSync(target, "utf8")
    .split(/\r?\n/)
    .find((line) => /^\|\s*最终成片\s*\|/.test(line));
  if (!row) return null;
  const cells = row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(markdownCellText);
  const selections = [
    { decision: "accept", cell: cells[4] ?? "" },
    { decision: "reject", cell: cells[5] ?? "" },
    { decision: "revision_requested", cell: cells[6] ?? "" }
  ].filter((item) => /^\[(?!\s*\])/.test(item.cell) || item.cell.toLowerCase().includes(item.decision));
  return {
    source_path: relativePath,
    decision_count: selections.length,
    decision: selections.length === 1 ? selections[0].decision : "",
    reviewer: cells[7] ?? "",
    note: cells[8] ?? "",
    valid: selections.length === 1 && Boolean(cells[7])
  };
}

function finalReviewWorkbenchSummary() {
  const reportPath = existsSync(resolve(paths.workspaceRoot, R3_9P_FINAL_REVIEW_REPORT))
    ? R3_9P_FINAL_REVIEW_REPORT
    : R3_9O_FINAL_ASSEMBLY_REPORT;
  const report = readJsonReport(reportPath);
  if (!report) {
    return {
      report_path: reportPath,
      report_exists: false,
      result: "MISSING_REPORT",
      project: {},
      final_video: null,
      source_clips: [],
      review_package: null,
      provider_boundary: H1_PROVIDER_BOUNDARY
    };
  }

  const project = objectValue(report.project);
  const finalVideo = objectValue(report.final_video);
  const assemblyExecution = objectValue(report.assembly_execution);
  const ffprobe = objectValue(finalVideo.ffprobe ?? report.ffprobe_result);
  const reviewPackage = objectValue(report.review_package);
  const reviewTablePath = String(reviewPackage.review_table_path ?? "");
  const sourceClips = arrayValue(report.source_clips ?? report.ordered_input_clips).map((item) => objectValue(item));
  const artifactId = String(finalVideo.final_video_artifact_id ?? assemblyExecution.final_video_artifact_id ?? "");

  return {
    report_path: reportPath,
    report_exists: true,
    result: String(report.result ?? "UNKNOWN"),
    project: {
      project_id: String(project.project_id ?? ""),
      project_title: String(project.project_title ?? project.title ?? ""),
      storyboard_package_id: String(project.storyboard_package_id ?? "")
    },
    final_video: artifactId
      ? {
          artifact_id: artifactId,
          local_video_exists: finalVideo.local_video_exists === true || assemblyExecution.final_video_exists === true,
          local_video_path: String(finalVideo.local_video_path ?? assemblyExecution.final_video_path ?? ""),
          artifact_path: String(finalVideo.final_video_artifact_path ?? assemblyExecution.final_video_artifact_path ?? ""),
          byte_size: Number(finalVideo.byte_size ?? assemblyExecution.final_video_byte_size ?? 0),
          ffprobe
        }
      : null,
    source_clips: sourceClips.map((clip) => ({
      order: Number(clip.order ?? 0),
      shot_id: String(clip.shot_id ?? ""),
      artifact_id: String(clip.source_clip_artifact_id ?? clip.accepted_clip_artifact_id ?? ""),
      ffprobe_status: String(clip.ffprobe_status ?? ""),
      duration_seconds: Number(clip.duration_seconds ?? 0),
      generation_run_id: String(clip.source_generation_run_id ?? "")
    })),
    review_package: {
      status: String(reviewPackage.status ?? ""),
      review_table_path: reviewTablePath,
      final_creative_approval_recorded: reviewPackage.final_creative_approval_recorded === true,
      decision: reviewPackage.decision ?? null,
      local_blocker_count: Number(reviewPackage.local_blocker_count ?? 0),
      local_blockers: arrayValue(reviewPackage.local_blockers).map(String)
    },
    table_decision: finalReviewTableDecision(reviewTablePath),
    decision_report: finalDecisionReport(),
    provider_boundary: objectValue(report.provider_boundary)
  };
}

function writeDecisionReport(payload: Record<string, unknown>): { immutable_path: string; latest_path: string } {
  ensureM0Directories();
  const runId = String(payload.run_id ?? randomUUID());
  const immutableRelativePath = `data/reports/${R3_9Q_FINAL_DECISION_STEM}_${runId}.json`;
  const nextPayload = { ...payload, report_path: immutableRelativePath, latest_report_path: R3_9Q_FINAL_DECISION_REPORT };
  const text = `${JSON.stringify(nextPayload, null, 2)}\n`;
  writeFileSync(resolve(paths.workspaceRoot, immutableRelativePath), text, "utf8");
  writeFileSync(resolve(paths.workspaceRoot, R3_9Q_FINAL_DECISION_REPORT), text, "utf8");
  return { immutable_path: immutableRelativePath, latest_path: R3_9Q_FINAL_DECISION_REPORT };
}

function recordFinalReviewDecision(input: { decision: string; reviewer: string; note: string; human_confirmation: boolean }) {
  if (input.human_confirmation !== true) {
    return { ok: false, error: { code: "HUMAN_CONFIRMATION_REQUIRED", message: "最终成片决策需要人类明确确认。" } };
  }

  const decision = input.decision.trim();
  const reviewer = input.reviewer.trim();
  const note = input.note.trim();
  if (decision !== "accept" && decision !== "reject" && decision !== "revision_requested") {
    return { ok: false, error: { code: "INVALID_FINAL_REVIEW_DECISION", message: "最终成片决策必须是 accept、reject 或 revision_requested。" } };
  }
  if (!reviewer) return { ok: false, error: { code: "REVIEWER_REQUIRED", message: "请填写审查人。" } };
  if ((decision === "reject" || decision === "revision_requested") && !note) {
    return { ok: false, error: { code: "FINAL_REVIEW_NOTE_REQUIRED", message: "拒绝或请求修订时必须填写备注。" } };
  }
  if (finalDecisionReport()) {
    return { ok: false, error: { code: "FINAL_DECISION_ALREADY_RECORDED", message: "最终成片决策已记录；为保持审计链，不在工作台中覆盖。" } };
  }

  const summary = finalReviewWorkbenchSummary();
  if (!summary.report_exists || summary.result !== "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY" || !summary.final_video) {
    return { ok: false, error: { code: "FINAL_REVIEW_PACKAGE_NOT_READY", message: "最终成片审查包未就绪。" } };
  }

  const result =
    decision === "accept"
      ? "PASS_FINAL_CREATIVE_APPROVAL_RECORDED"
      : decision === "reject"
        ? "PASS_FINAL_VIDEO_REJECTED"
        : "PASS_FINAL_REVISION_REQUEST_RECORDED";
  const runId = randomUUID();
  const payload = {
    task: "R3-9Q_FINAL_VIDEO_REVIEW_DECISION_APPLY",
    result,
    mode: "local_final_video_decision_only",
    run_id: runId,
    generated_at: new Date().toISOString(),
    source_review_package_report: summary.report_path,
    decision,
    reviewer,
    note,
    project: summary.project,
    final_video: summary.final_video,
    source_clips: summary.source_clips,
    review_package: {
      status: "FINAL_DECISION_RECORDED",
      final_creative_approval_recorded: decision === "accept",
      decision,
      reviewer,
      note
    },
    provider_boundary: {
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      media_upload_to_provider: false,
      provider_submit: false,
      status_poll: false,
      output_download_from_provider: false,
      provider_credits_consumed: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      env_files_read: false,
      credentials_read: false,
      source_assets_overwritten: false,
      secret_values_exposed: false,
      raw_provider_payload_recorded: false,
      signed_url_recorded: false,
      publish_performed: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false
    },
    validation: {
      final_review_package_ready: "PASS",
      final_video_artifact_present: "PASS",
      final_decision_single_write_gate: "PASS",
      provider_boundary: "PASS"
    },
    git_receipt: {
      repo: true,
      branch: "master",
      commit: "PENDING_LOCAL_COMMIT",
      push: false,
      pr: null,
      tag_created: false,
      release_or_deploy_performed: false
    }
  };
  const pathsWritten = writeDecisionReport(payload);
  return { ok: true, value: { ...payload, ...pathsWritten } };
}

function withDb<T>(fn: (db: ReturnType<typeof openM0Database>) => T): T {
  const db = openM0Database();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function serveMediaArtifact(pathname: string, request: IncomingMessage, response: ServerResponse): void {
  const artifactId = basename(decodeURIComponent(pathname.replace("/media/artifacts/", "")));
  if (!/^artifact_[0-9a-f-]+$/i.test(artifactId)) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到媒体 Artifact。" } });
    return;
  }

  const artifact = withDb((db) => getMediaArtifact(db, artifactId));
  if (!artifact || artifact.status !== "active") {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到媒体 Artifact。" } });
    return;
  }

  const mediaRoot = resolve(paths.mediaRoot);
  const target = resolve(artifact.storage.uri);
  if (!isPathInside(target, mediaRoot) || !existsSync(target) || lstatSync(target).isSymbolicLink()) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到媒体 Artifact。" } });
    return;
  }

  const realTarget = realpathSync(target);
  const targetStat = statSync(realTarget);
  if (!isPathInside(realTarget, mediaRoot) || !targetStat.isFile()) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到媒体 Artifact。" } });
    return;
  }

  const contentType = artifact.storage.mime_type || MEDIA_CONTENT_TYPES[extname(realTarget).toLowerCase()] || "application/octet-stream";
  const commonHeaders = {
    "content-type": contentType,
    "cache-control": "no-store",
    "accept-ranges": artifact.artifact_type === "video" ? "bytes" : "none"
  };

  const range = request.headers.range;
  if (artifact.artifact_type === "video" && typeof range === "string") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : targetStat.size - 1;
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end < targetStat.size) {
        response.writeHead(206, {
          ...commonHeaders,
          "content-range": `bytes ${start}-${end}/${targetStat.size}`,
          "content-length": String(end - start + 1)
        });
        createReadStream(realTarget, { start, end }).pipe(response);
        return;
      }
    }
    response.writeHead(416, { "content-range": `bytes */${targetStat.size}` });
    response.end();
    return;
  }

  response.writeHead(200, { ...commonHeaders, "content-length": String(targetStat.size) });
  createReadStream(realTarget).pipe(response);
}

function reviewOptionsFromSearchParams(searchParams: URLSearchParams) {
  const rawStatus = searchParams.get("review_status") || searchParams.get("status") || "all";
  const status: "all" | "pending" | "approved" | "rejected" =
    rawStatus === "pending" || rawStatus === "approved" || rawStatus === "rejected" ? rawStatus : "all";
  return {
    status,
    shot_id: searchParams.get("review_shot_id") || searchParams.get("shot_id") || "",
    offset: Number(searchParams.get("review_offset") || searchParams.get("offset") || 0),
    limit: Number(searchParams.get("review_limit") || searchParams.get("limit") || 50)
  };
}

function bootstrapPayload(reviewOptions = {}) {
  return withDb((db) => {
    const state = loadH1WorkbenchState();
    return {
      ok: true,
      action_nonce: ACTION_NONCE,
      dashboard: h1DashboardSummary(state, db),
      state,
      package: packagePayloadForState(state, db),
      imports: scanH1Imports(db),
      canary: h2CanaryWorkbenchSummary(),
      review: h3VideoReviewSummary(state, db, reviewOptions),
      assembly: h4FinalAssemblyWorkbenchSummary(state, db),
      final_review: finalReviewWorkbenchSummary(),
      memory: memorySavebackWorkbenchSummary(),
      webgpt_drafts: webGptDraftWorkbenchSummary(),
      pending_actions: webGptPendingActionWorkbenchSummary(),
      reports: listH1Reports()
    };
  });
}

function packagePayloadForState(state: ReturnType<typeof loadH1WorkbenchState>, db: ReturnType<typeof openM0Database>) {
  const shots = state.shots.map((shot) => {
    const artifact = shot.storyboard_image_artifact_id ? getMediaArtifact(db, shot.storyboard_image_artifact_id) : null;
    return {
      shot_id: shot.shot_id,
      approval_status: shot.approval_status,
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      blockers: h1ShotBlockers(shot, db),
      artifact: artifact
        ? {
            artifact_id: artifact.artifact_id,
            artifact_type: artifact.artifact_type,
            role: artifact.role,
            status: artifact.status,
            filename: artifact.storage?.filename ?? "",
            mime_type: artifact.storage?.mime_type ?? ""
          }
        : null
    };
  });
  const blockers = shots.flatMap((shot) => shot.blockers.map((blocker) => `${shot.shot_id}:${blocker}`));
  return {
    project: state.project,
    shots,
    validation: {
      ok: blockers.length === 0,
      blockers,
      validateG0StoryboardPackage: "NOT_RUN_UNTIL_VALIDATE_ACTION",
      app_ready_candidate: blockers.length === 0,
      provider_boundary: H1_PROVIDER_BOUNDARY
    },
    history: state.frozen_package_history,
    latest_frozen_package: state.frozen_package_history.at(-1) ?? null
  };
}

function appHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Video Production 人类工作台</title>
  <style>
    :root {
      color: #172b4d;
      background: #f7f8f9;
      font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      --line: #dfe1e6;
      --soft: #e9f2ff;
      --panel: #fff;
      --board: #0c66e4;
      --card: #fff;
      --list: #e4e6ea;
      --ink-soft: #44546f;
      --green: #216e4e;
      --blue: #0c66e4;
      --amber: #974f0c;
      --red: #ae2e24;
      --purple: #6e5dc6;
      --label-green: #4bce97;
      --label-blue: #579dff;
      --label-yellow: #f5cd47;
      --label-red: #f87168;
      --label-purple: #9f8fef;
      --shadow: 0 1px 1px rgba(9, 30, 66, .18), 0 1px 4px rgba(9, 30, 66, .12);
      --shadow-hover: 0 2px 2px rgba(9, 30, 66, .20), 0 8px 18px rgba(9, 30, 66, .14);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f8f9; }
    header {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 18px;
      background: rgba(255, 255, 255, .94);
      color: #172b4d;
      border-bottom: 1px solid #dfe1e6;
      position: sticky;
      top: 0;
      z-index: 5;
      backdrop-filter: blur(12px);
      box-shadow: 0 1px 1px rgba(9, 30, 66, .10);
    }
    h1 { margin: 0; font-size: 19px; letter-spacing: 0; }
    h2 { margin: 0 0 10px; font-size: 19px; letter-spacing: 0; }
    h3 { margin: 0 0 8px; font-size: 15px; letter-spacing: 0; }
    main { display: grid; grid-template-columns: 224px minmax(0, 1fr) 360px; height: calc(100vh - 64px); min-height: 0; overflow: hidden; transition: grid-template-columns .18s ease; }
    main.inspector-hidden { grid-template-columns: 128px minmax(0, 1fr); }
    main.inspector-hidden aside { display: none; }
    nav { position: sticky; top: 64px; z-index: 3; align-self: start; width: 224px; height: calc(100vh - 64px); background: rgba(255,255,255,.82); border-right: 1px solid rgba(223,225,230,.92); padding: 12px; overflow-x: hidden; overflow-y: auto; backdrop-filter: blur(10px); box-shadow: inset -1px 0 0 rgba(9,30,66,.04); transition: width .18s ease, padding .18s ease, box-shadow .18s ease, background .18s ease; scrollbar-gutter: stable; }
    nav button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      min-height: 36px;
      margin-bottom: 6px;
      text-align: left;
      border-color: transparent;
      background: transparent;
      color: #172b4d;
      font-weight: 500;
    }
    nav button:hover { background: #e9f2ff; border-color: #85b8ff; }
    nav button.active { background: #deebff; border-color: #deebff; color: #0747a6; font-weight: 700; box-shadow: inset 3px 0 0 #0c66e4; }
    main.inspector-hidden nav { width: 128px; padding: 10px 8px; background: rgba(255,255,255,.90); box-shadow: inset -1px 0 0 rgba(9,30,66,.08), 1px 0 8px rgba(9,30,66,.06); }
    main.inspector-hidden nav:hover, main.inspector-hidden nav:focus-within { width: 224px; padding: 12px; background: rgba(255,255,255,.96); box-shadow: var(--shadow-hover); }
    main.inspector-hidden nav:not(:hover):not(:focus-within) button { justify-content: flex-start; min-height: 38px; padding: 8px 12px; }
    main.inspector-hidden nav:not(:hover):not(:focus-within) .nav-label { max-width: none; opacity: 1; }
    main.inspector-hidden nav:not(:hover):not(:focus-within) .nav-badge { flex: 0 0 0; width: 0; min-width: 0; min-height: 0; max-width: 0; padding: 0; opacity: 0; overflow: hidden; }
    section {
      position: relative;
      isolation: isolate;
      padding: 16px;
      overflow: auto;
      min-height: 0;
      height: 100%;
      background-color: #f4f6f8;
      background-image:
        linear-gradient(90deg, rgba(9,30,66,.035) 1px, transparent 1px),
        linear-gradient(180deg, rgba(9,30,66,.03) 1px, transparent 1px),
        url("/ui-assets/trello-vivid-board-background.png");
      background-repeat: repeat, repeat, no-repeat;
      background-size: 28px 28px, 28px 28px, max(1500px, 118vw) auto;
      background-position: center top, center top, center;
      background-attachment: local, local, fixed;
    }
    section::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background: rgba(247, 248, 249, .54);
      backdrop-filter: blur(18px) saturate(.88);
    }
    section > * { position: relative; z-index: 1; }
    main.inspector-hidden section { background-position: center top; }
    aside { border-left: 1px solid rgba(9, 30, 66, .18); background: rgba(247,248,249,.86); padding: 14px; overflow: auto; min-height: 0; height: 100%; backdrop-filter: blur(14px) saturate(.92); }
    button {
      border: 1px solid transparent;
      background: #f1f2f4;
      color: #172b4d;
      border-radius: 3px;
      padding: 8px 10px;
      cursor: pointer;
      font: inherit;
      overflow-wrap: anywhere;
      transition: background .14s ease, border-color .14s ease, box-shadow .14s ease, transform .14s ease;
    }
    button:hover { background: #dcdfe4; }
    button:active { transform: translateY(1px); }
    button.primary { background: #0c66e4; border-color: #0c66e4; color: #fff; }
    button.primary:hover { background: #0055cc; border-color: #0055cc; }
    button.warn { border-color: var(--amber); color: #7c2d12; }
    button.warn:hover { background: #fff3c4; }
    button.danger { border-color: var(--red); color: var(--red); }
    button.danger:hover { background: #ffebe6; }
    button:disabled { cursor: not-allowed; opacity: .48; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #d0d5dd; border-radius: 3px; padding: 7px; font: inherit; background: #fff; color: #172b4d; }
    textarea { min-height: 70px; resize: vertical; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
    th, td { border-bottom: 1px solid #e1e6e2; padding: 8px; vertical-align: top; font-size: 13px; word-break: break-word; }
    th { text-align: left; color: var(--ink-soft); font-weight: 600; background: #f8faf8; }
    video, img.preview { width: 100%; max-height: 380px; object-fit: contain; background: #091e42; border: 1px solid #dfe1e6; border-radius: 6px; }
    .brand-lockup { min-width: 0; }
    .brand-lockup h1 { margin-bottom: 2px; }
    .brand-subtitle { color: #44546f; font-size: 13px; }
    .top-status { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .nav-mark { display: none; flex: 0 0 28px; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 6px; background: #deebff; color: #0747a6; font-size: 14px; font-weight: 800; }
    main.inspector-hidden nav:not(:hover):not(:focus-within) .nav-mark { display: none; }
    .nav-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: opacity .14s ease, max-width .14s ease; }
    .nav-badge { min-width: 22px; min-height: 20px; border-radius: 999px; background: #dfe1e6; color: #44546f; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px; font-size: 12px; }
    .active .nav-badge { background: #0c66e4; color: #fff; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .toolbar button { max-width: 100%; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .metric { background: rgba(255,255,255,.86); border: 1px solid rgba(255,255,255,.62); border-radius: 3px; padding: 10px; color: var(--ink-soft); min-height: 56px; box-shadow: var(--shadow); backdrop-filter: blur(14px) saturate(.96); }
    .metric b { display: block; color: #172026; font-size: 24px; margin-top: 4px; overflow-wrap: anywhere; }
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 12px; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .panel { background: rgba(255,255,255,.88); border: 1px solid rgba(255,255,255,.62); border-radius: 3px; padding: 12px; margin-bottom: 12px; box-shadow: var(--shadow); backdrop-filter: blur(14px) saturate(.96); }
    .list { display: grid; gap: 8px; }
    .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; border-bottom: 1px solid #e8ece9; padding: 8px 0; }
    .row:last-child { border-bottom: 0; }
    .muted { color: var(--ink-soft); font-size: 13px; }
    .pill { display: inline-flex; align-items: center; min-height: 22px; padding: 0 8px; border-radius: 4px; border: 0; background: #dfe1e6; color: #172b4d; font-size: 13px; font-weight: 700; box-shadow: inset 0 -1px 0 rgba(9,30,66,.12); }
    .pill.ok { color: #164b35; background: #baf3db; }
    .pill.warn { color: #7f5f01; background: #f8e6a0; }
    .pill.bad { color: #5d1f1a; background: #ffd5d2; }
    .media-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .clip-card { background: #fff; border: 0; border-radius: 8px; padding: 10px; box-shadow: var(--shadow); border-top: 4px solid var(--label-purple); }
    .clip-card video { max-height: 260px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; padding: 10px 12px; background: rgba(255,255,255,.76); border: 1px solid rgba(255,255,255,.62); border-radius: 8px; box-shadow: var(--shadow); backdrop-filter: blur(18px) saturate(.98); }
    .page-head { color: #172b4d; }
    .page-head h2 { color: #172b4d; }
    .page-kicker { color: #44546f; font-size: 13px; margin-top: 3px; }
    .trello-board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(300px, 360px); gap: 12px; overflow-x: auto; overflow-y: hidden; padding: 2px 2px 12px; align-items: start; max-height: calc(100vh - 238px); scrollbar-color: rgba(23,43,77,.32) rgba(255,255,255,.34); scrollbar-width: thin; }
    .trello-board.wide { grid-auto-columns: minmax(340px, 430px); }
    .trello-board::-webkit-scrollbar, .board-list-cards::-webkit-scrollbar, .import-shot-strip::-webkit-scrollbar, .import-batch-strip::-webkit-scrollbar, .draft-sections::-webkit-scrollbar, .draft-grid::-webkit-scrollbar, .action-sections::-webkit-scrollbar, .action-grid::-webkit-scrollbar, .batch-stage .import-batches::-webkit-scrollbar, nav::-webkit-scrollbar, section::-webkit-scrollbar { width: 12px; height: 12px; }
    .trello-board::-webkit-scrollbar-thumb, .board-list-cards::-webkit-scrollbar-thumb, .import-shot-strip::-webkit-scrollbar-thumb, .import-batch-strip::-webkit-scrollbar-thumb, .draft-sections::-webkit-scrollbar-thumb, .draft-grid::-webkit-scrollbar-thumb, .action-sections::-webkit-scrollbar-thumb, .action-grid::-webkit-scrollbar-thumb, .batch-stage .import-batches::-webkit-scrollbar-thumb, nav::-webkit-scrollbar-thumb, section::-webkit-scrollbar-thumb { background: rgba(23,43,77,.28); border: 3px solid transparent; border-radius: 999px; background-clip: padding-box; }
    .trello-board::-webkit-scrollbar-track, .board-list-cards::-webkit-scrollbar-track, .import-shot-strip::-webkit-scrollbar-track, .import-batch-strip::-webkit-scrollbar-track, .draft-sections::-webkit-scrollbar-track, .draft-grid::-webkit-scrollbar-track, .action-sections::-webkit-scrollbar-track, .action-grid::-webkit-scrollbar-track, .batch-stage .import-batches::-webkit-scrollbar-track, nav::-webkit-scrollbar-track, section::-webkit-scrollbar-track { background: rgba(255,255,255,.24); border-radius: 999px; }
    .board-list { background: rgba(228,230,234,.78); border: 1px solid rgba(255,255,255,.32); border-radius: 8px; padding: 10px; min-height: 112px; box-shadow: 0 1px 1px rgba(9, 30, 66, .22), 0 6px 18px rgba(9, 30, 66, .08); backdrop-filter: blur(12px) saturate(.92); }
    .trello-board > .board-list { display: flex; flex-direction: column; max-height: min(calc(100vh - 254px), 1040px); overflow: hidden; }
    .board-list-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .board-list-header h2, .board-list-header h3 { margin: 0; font-size: 15px; color: #172b4d; }
    .board-list-help { color: var(--ink-soft); font-size: 13px; margin-top: 3px; line-height: 1.45; }
    .batch-stage > .board-list-header { padding: 8px 10px; background: rgba(223,227,232,.78); border: 1px solid rgba(255,255,255,.32); border-radius: 8px; box-shadow: var(--shadow); backdrop-filter: blur(12px) saturate(.92); }
    .batch-stage > .board-list-header h2, .batch-stage > .board-list-header h3 { color: #172b4d; }
    .batch-stage > .board-list-header .board-list-help { color: #44546f; }
    .board-list-cards { display: grid; grid-template-columns: 1fr; gap: 8px; min-height: 0; overflow-x: hidden; overflow-y: auto; padding-right: 4px; overscroll-behavior: contain; scrollbar-gutter: stable; }
    .board-list-cards .task-card { margin-bottom: 0; }
    .task-card { background: var(--card); border: 0; border-top: 4px solid var(--label-green); border-radius: 8px; padding: 10px; display: grid; gap: 8px; margin-bottom: 8px; box-shadow: var(--shadow); transition: box-shadow .14s ease, transform .14s ease, outline-color .14s ease; }
    .task-card:last-child { margin-bottom: 0; }
    .task-card h3 { margin: 0; font-size: 15px; line-height: 1.35; }
    .task-card:hover { outline: 2px solid #85b8ff; box-shadow: var(--shadow-hover); transform: translateY(-1px); }
    .task-card:has(.pill.warn) { border-top-color: var(--label-yellow); }
    .task-card:has(.pill.bad) { border-top-color: var(--label-red); }
    .task-card.selected { outline: 2px solid #0c66e4; box-shadow: 0 0 0 3px rgba(12,102,228,.14), var(--shadow-hover); }
    .card-labels { display: flex; gap: 6px; flex-wrap: wrap; }
    .card-fields { display: grid; gap: 6px; }
    .card-field { display: grid; gap: 2px; border-top: 1px solid #edf1f5; padding-top: 6px; }
    .card-field b { color: var(--ink-soft); font-size: 12px; font-weight: 700; }
    .card-field span { font-size: 13px; overflow-wrap: anywhere; }
    .card-cover { width: 100%; aspect-ratio: 9 / 16; max-height: 260px; object-fit: contain; background: #091e42; border: 1px solid #dfe1e6; border-radius: 6px; }
    .card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .card-actions button { padding: 6px 8px; font-size: 13px; }
    .import-workbench { display: grid; grid-template-columns: 260px minmax(0, 1fr) 280px; gap: 12px; align-items: stretch; }
    .asset-inbox, .batch-stage, .batch-check { min-width: 0; }
    .asset-inbox, .batch-stage { display: flex; flex-direction: column; height: calc(100vh - 260px); min-height: 0; }
    .asset-inbox .import-batches { flex: 1 1 auto; min-height: 0; max-height: none; overflow-y: auto; overflow-x: hidden; padding-right: 4px; scrollbar-gutter: stable; }
    .asset-inbox .import-batch-strip { grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: 1fr; overflow: visible; padding-bottom: 0; }
    .asset-inbox .import-card { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; align-items: start; }
    .asset-inbox .import-card .preview { grid-row: span 5; aspect-ratio: 16 / 9; max-height: 72px; }
    .asset-inbox .import-card h3 { min-height: 0; margin: 0; }
    .asset-inbox .import-card .decision-bar { grid-column: span 2; }
    .batch-stage-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(220px, 260px) minmax(0, 1fr); gap: 12px; }
    .batch-queue, .batch-detail { min-width: 0; min-height: 0; }
    .batch-queue { display: grid; gap: 8px; align-content: start; overflow-y: auto; overflow-x: hidden; padding-right: 4px; scrollbar-gutter: stable; }
    .batch-queue-card { width: 100%; text-align: left; border: 1px solid rgba(9,30,66,.12); border-left: 4px solid var(--label-green); background: rgba(255,255,255,.9); color: #172b4d; border-radius: 8px; padding: 9px; display: grid; gap: 7px; box-shadow: var(--shadow); }
    .batch-queue-card:hover { box-shadow: var(--shadow-hover); }
    .batch-queue-card.selected { border-left-color: var(--blue); outline: 2px solid rgba(12,102,228,.25); background: #fff; }
    .batch-queue-card h3 { margin: 0; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
    .batch-queue-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .batch-detail { display: flex; flex-direction: column; overflow: hidden; }
    .batch-detail .import-batch { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .batch-detail .import-shot-strip { flex: 1 1 auto; min-height: 0; overflow-x: auto; overflow-y: auto; }
    .inbox-group-summary { display: grid; gap: 8px; }
    .inbox-group-samples { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .inbox-thumb { aspect-ratio: 16 / 9; object-fit: cover; background: #091e42; border-radius: 5px; border: 1px solid #dfe1e6; width: 100%; }
    .batch-check { position: sticky; top: 80px; }
    .import-batches { display: grid; gap: 12px; }
    .import-batch { background: rgba(223,227,232,.78); border: 1px solid rgba(255,255,255,.32); border-radius: 8px; padding: 10px; box-shadow: 0 1px 1px rgba(9, 30, 66, .22), 0 6px 18px rgba(9, 30, 66, .08); backdrop-filter: blur(12px) saturate(.92); }
    .import-batch.blocked { background: var(--list); }
    .import-batch-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .import-batch-title { min-width: 0; }
    .import-batch-title h3 { margin-bottom: 4px; overflow-wrap: anywhere; }
    .import-shot-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(188px, 218px); gap: 10px; overflow-x: auto; padding-bottom: 6px; }
    .import-batch-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(150px, 185px); gap: 10px; overflow-x: auto; padding-bottom: 4px; }
    .import-shot { min-width: 0; background: #fff; border: 0; border-top: 4px solid var(--label-blue); border-radius: 8px; padding: 8px; box-shadow: var(--shadow); transition: box-shadow .14s ease, transform .14s ease; }
    .import-shot:hover { box-shadow: var(--shadow-hover); transform: translateY(-1px); }
    .import-shot-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .import-shot-title { min-width: 0; }
    .import-shot-title h3 { margin-bottom: 2px; font-size: 15px; overflow-wrap: anywhere; }
    .import-shot-viewer { display: grid; grid-template-columns: 1fr 36px; gap: 8px; align-items: stretch; }
    .import-shot-viewer img.preview { aspect-ratio: 9 / 16; max-height: 216px; cursor: pointer; border-radius: 3px; }
    .import-shot-controls { display: grid; grid-template-rows: 1fr 1fr; gap: 6px; }
    .import-shot-controls button { min-height: 0; padding: 6px 4px; }
    .import-card { min-width: 0; background: #fff; border: 0; border-top: 4px solid var(--label-green); border-radius: 8px; padding: 8px; box-shadow: var(--shadow); transition: box-shadow .14s ease, transform .14s ease; }
    .import-card:hover { box-shadow: var(--shadow-hover); transform: translateY(-1px); }
    .import-card.is-blocked { background: #fff; border-top-color: var(--label-red); }
    .import-card .preview { aspect-ratio: 9 / 16; max-height: 220px; }
    .import-card h3 { min-height: 36px; margin-top: 6px; font-size: 13px; overflow-wrap: anywhere; }
    .import-card .toolbar { margin-bottom: 0; }
    .draft-sections { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(300px, 360px); gap: 12px; overflow-x: auto; overflow-y: hidden; padding-bottom: 12px; align-items: start; max-height: calc(100vh - 238px); }
    .draft-section { margin-bottom: 0; background: var(--list); border: 0; border-radius: 8px; display: flex; flex-direction: column; max-height: min(calc(100vh - 254px), 1040px); overflow: hidden; box-shadow: 0 1px 1px rgba(9, 30, 66, .22), 0 6px 18px rgba(9, 30, 66, .08); }
    .draft-section .draft-grid { margin-top: 10px; }
    .draft-grid { display: grid; grid-template-columns: 1fr; gap: 8px; min-height: 0; overflow-x: hidden; overflow-y: auto; padding-right: 4px; overscroll-behavior: contain; scrollbar-gutter: stable; }
    .draft-triage-workbench { display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr) minmax(260px, 320px); gap: 12px; height: calc(100vh - 260px); min-height: 0; }
    .draft-queue, .draft-review, .draft-evidence { min-width: 0; min-height: 0; overflow: hidden; }
    .draft-queue, .draft-evidence { display: flex; flex-direction: column; }
    .draft-queue-list, .draft-evidence-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 4px; scrollbar-gutter: stable; }
    .draft-queue-list { display: grid; gap: 8px; align-content: start; }
    .draft-review { display: flex; flex-direction: column; }
    .draft-review-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding-right: 4px; scrollbar-gutter: stable; }
    .draft-queue-card { width: 100%; text-align: left; border: 1px solid rgba(9,30,66,.12); border-left: 4px solid var(--label-purple); background: rgba(255,255,255,.9); color: #172b4d; border-radius: 8px; padding: 9px; display: grid; gap: 7px; box-shadow: var(--shadow); }
    .draft-queue-card:hover { box-shadow: var(--shadow-hover); }
    .draft-queue-card.selected { border-left-color: var(--blue); outline: 2px solid rgba(12,102,228,.25); background: #fff; }
    .draft-queue-card.high-risk { border-left-color: var(--label-yellow); }
    .draft-queue-card h3 { margin: 0; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
    .draft-queue-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .draft-review-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .draft-review-title h2 { margin-bottom: 4px; overflow-wrap: anywhere; }
    .draft-review-summary { display: grid; gap: 8px; }
    .draft-review-actions { margin-top: 10px; }
    .draft-evidence details { margin-top: 10px; }
    .draft-evidence pre { max-height: 260px; }
    .draft-card { background: #fff; border: 0; border-top: 4px solid var(--label-purple); border-radius: 8px; padding: 10px; display: grid; gap: 8px; box-shadow: var(--shadow); transition: box-shadow .14s ease, transform .14s ease; }
    .draft-card:hover { box-shadow: var(--shadow-hover); transform: translateY(-1px); }
    .draft-card h3 { font-size: 16px; margin: 0; }
    .draft-fields { display: grid; gap: 7px; }
    .draft-field { border-top: 1px solid #e8ece9; padding-top: 7px; }
    .draft-field b { display: block; font-size: 13px; color: var(--ink-soft); margin-bottom: 2px; }
    .draft-field span { display: block; font-size: 14px; overflow-wrap: anywhere; }
    details.draft-raw summary { cursor: pointer; color: var(--ink-soft); font-size: 13px; }
    details.draft-raw pre { max-height: 180px; margin: 6px 0 0; }
    .action-sections { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(310px, 380px); gap: 12px; overflow-x: auto; overflow-y: hidden; padding-bottom: 12px; align-items: start; max-height: calc(100vh - 238px); }
    .action-section { margin-bottom: 0; background: var(--list); border: 0; border-radius: 8px; display: flex; flex-direction: column; max-height: min(calc(100vh - 254px), 1040px); overflow: hidden; box-shadow: 0 1px 1px rgba(9, 30, 66, .22), 0 6px 18px rgba(9, 30, 66, .08); }
    .action-grid { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 10px; min-height: 0; overflow-x: hidden; overflow-y: auto; padding-right: 4px; overscroll-behavior: contain; scrollbar-gutter: stable; }
    .pending-decision-workbench { display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr) minmax(260px, 320px); gap: 12px; height: calc(100vh - 260px); min-height: 0; }
    .pending-queue, .pending-decision, .pending-evidence { min-width: 0; min-height: 0; overflow: hidden; }
    .pending-queue, .pending-decision, .pending-evidence { display: flex; flex-direction: column; }
    .pending-filter-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 10px; }
    .pending-filter-tabs button { padding: 7px 8px; }
    .pending-filter-tabs button.active { background: #deebff; border-color: #0c66e4; color: #0747a6; font-weight: 700; }
    .pending-queue-list, .pending-decision-body, .pending-evidence-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 4px; scrollbar-gutter: stable; }
    .pending-queue-list { display: grid; gap: 8px; align-content: start; }
    .pending-queue-card { width: 100%; text-align: left; border: 1px solid rgba(9,30,66,.12); border-left: 4px solid var(--label-yellow); background: rgba(255,255,255,.9); color: #172b4d; border-radius: 8px; padding: 9px; display: grid; gap: 7px; box-shadow: var(--shadow); }
    .pending-queue-card:hover { box-shadow: var(--shadow-hover); }
    .pending-queue-card.selected { border-left-color: var(--blue); outline: 2px solid rgba(12,102,228,.25); background: #fff; }
    .pending-queue-card.executed { border-left-color: var(--label-green); }
    .pending-queue-card.rejected, .pending-queue-card.failed { border-left-color: var(--label-red); }
    .pending-queue-card h3 { margin: 0; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
    .pending-queue-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .pending-decision-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .pending-decision-title h2 { margin-bottom: 4px; overflow-wrap: anywhere; }
    .pending-decision-summary { display: grid; gap: 8px; }
    .pending-decision-actions { margin-top: 10px; }
    .pending-evidence details { margin-top: 10px; }
    .pending-evidence pre { max-height: 260px; }
    .review-workbench { display: grid; grid-template-columns: minmax(260px, 330px) minmax(0, 1fr) minmax(280px, 350px); gap: 12px; height: calc(100vh - 260px); min-height: 0; }
    .review-queue, .review-player, .review-evidence { min-width: 0; min-height: 0; overflow: hidden; }
    .review-queue, .review-player, .review-evidence { display: flex; flex-direction: column; }
    .review-filters { display: grid; gap: 8px; margin-bottom: 10px; }
    .review-filter-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
    .review-filter-tabs button { padding: 7px 8px; }
    .review-filter-tabs button.active { background: #deebff; border-color: #0c66e4; color: #0747a6; font-weight: 700; }
    .review-filter-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; }
    .review-filter-row button { white-space: nowrap; }
    .review-page-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .review-queue-list, .review-player-body, .review-evidence-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 4px; scrollbar-gutter: stable; }
    .review-queue-list { display: grid; gap: 8px; align-content: start; }
    .review-queue-card { width: 100%; text-align: left; border: 1px solid rgba(9,30,66,.12); border-left: 4px solid var(--label-yellow); background: rgba(255,255,255,.9); color: #172b4d; border-radius: 8px; padding: 9px; display: grid; gap: 7px; box-shadow: var(--shadow); }
    .review-queue-card:hover { box-shadow: var(--shadow-hover); }
    .review-queue-card.selected { border-left-color: var(--blue); outline: 2px solid rgba(12,102,228,.25); background: #fff; }
    .review-queue-card.approved { border-left-color: var(--label-green); }
    .review-queue-card.rejected, .review-queue-card.failed { border-left-color: var(--label-red); }
    .review-queue-card h3 { margin: 0; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
    .review-queue-meta, .review-version-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .review-player-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .review-player-title h2 { margin-bottom: 4px; overflow-wrap: anywhere; }
    .review-player-body { overflow: auto; }
    .review-player-media { background: #091e42; border: 1px solid rgba(9,30,66,.18); border-radius: 8px; padding: 10px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.05); }
    .review-player-media video { display: block; max-height: min(58vh, 620px); border: 0; border-radius: 6px; background: #091e42; }
    .review-timeline { margin-top: 10px; }
    .review-timeline-track { height: 8px; border-radius: 999px; background: rgba(223,225,230,.72); overflow: hidden; }
    .review-timeline-fill { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #0c66e4, #36b37e); }
    .review-timeline-labels { display: flex; justify-content: space-between; margin-top: 5px; color: #c1c7d0; font-size: 12px; }
    .review-player-facts { margin-top: 12px; display: grid; gap: 10px; }
    .review-player-actions { margin-top: 12px; }
    .review-version-strip { display: grid; gap: 8px; margin-top: 12px; }
    .review-version-card { width: 100%; text-align: left; border: 1px solid rgba(9,30,66,.12); border-left: 4px solid var(--label-blue); background: rgba(255,255,255,.92); color: #172b4d; border-radius: 8px; padding: 9px; display: grid; gap: 6px; box-shadow: var(--shadow); }
    .review-version-card.selected { border-left-color: var(--blue); outline: 2px solid rgba(12,102,228,.25); background: #fff; }
    .review-version-card.approved { border-left-color: var(--label-green); }
    .review-version-card.rejected { border-left-color: var(--label-red); }
    .review-evidence details { margin-top: 10px; }
    .review-evidence pre { max-height: 260px; }
    .action-card { background: #fff; border: 0; border-top: 4px solid var(--label-green); border-radius: 8px; padding: 10px; display: grid; gap: 8px; box-shadow: var(--shadow); transition: box-shadow .14s ease, transform .14s ease; }
    .action-card:hover { box-shadow: var(--shadow-hover); transform: translateY(-1px); }
    .action-card.pending { border-top-color: var(--label-yellow); box-shadow: var(--shadow); }
    .action-card.failed { border-top-color: var(--label-red); box-shadow: var(--shadow); }
    .action-fields { display: grid; gap: 7px; }
    .action-field { border-top: 1px solid #e8ece9; padding-top: 7px; }
    .action-field b { display: block; font-size: 13px; color: var(--ink-soft); margin-bottom: 2px; }
    .action-field span { display: block; font-size: 14px; overflow-wrap: anywhere; }
    .decision-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .inspector-empty { color: var(--ink-soft); border: 1px dashed #dfe1e6; border-radius: 8px; padding: 12px; background: #fff; }
    .hidden { display: none; }
    pre { background: #091e42; color: #f4f7f5; padding: 12px; border-radius: 8px; overflow: auto; max-height: 420px; white-space: pre-wrap; }
    @media (max-width: 1300px) { .import-workbench { grid-template-columns: minmax(0, 1fr); align-items: start; } .batch-stage { order: 1; } .batch-check { order: 2; position: static; } .asset-inbox { order: 3; } .asset-inbox, .batch-stage { height: auto; } .batch-stage-grid, .draft-triage-workbench, .pending-decision-workbench, .review-workbench { grid-template-columns: minmax(0, 1fr); height: auto; } .asset-inbox .import-batches, .batch-queue, .batch-detail .import-shot-strip, .draft-queue-list, .draft-review-body, .draft-evidence-body, .pending-queue-list, .pending-decision-body, .pending-evidence-body, .review-queue-list, .review-player-body, .review-evidence-body { max-height: none; overflow: visible; padding-right: 0; } .asset-inbox .import-batch-strip { overflow: visible; } }
    @media (max-width: 1100px) { main { grid-template-columns: 190px 1fr; } main.inspector-hidden { grid-template-columns: 128px 1fr; } aside { display: none; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 760px) { main, main.inspector-hidden { grid-template-columns: 1fr; height: auto; min-height: calc(100vh - 64px); overflow: visible; } nav, main.inspector-hidden nav, main.inspector-hidden nav:hover, main.inspector-hidden nav:focus-within { position: relative; top: auto; height: auto; width: auto; padding: 12px; overflow: visible; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.18); box-shadow: inset 0 -1px 0 rgba(9,30,66,.04); } main.inspector-hidden nav button { justify-content: space-between; padding: 8px 10px; } main.inspector-hidden nav:not(:hover):not(:focus-within) .nav-label, main.inspector-hidden nav:not(:hover):not(:focus-within) .nav-badge { width: auto; max-width: none; padding: 0 6px; opacity: 1; } main.inspector-hidden nav:not(:hover):not(:focus-within) .nav-label { padding: 0; } main.inspector-hidden nav .nav-mark, main.inspector-hidden nav:not(:hover):not(:focus-within) .nav-mark { display: none; } section, main.inspector-hidden section { height: auto; overflow: visible; } .trello-board, .draft-sections, .action-sections { max-height: none; } .trello-board > .board-list, .draft-section, .action-section { max-height: none; } .board-list-cards, .draft-grid, .action-grid { max-height: none; overflow: visible; padding-right: 0; } .summary, .grid { grid-template-columns: 1fr; } .span-4, .span-5, .span-6, .span-7, .span-8, .span-12 { grid-column: span 1; } }
  </style>
</head>
<body>
  <header>
    <div class="brand-lockup">
      <h1>AI Video Production 人类工作台</h1>
      <div class="brand-subtitle">Legacy 只读视图 · 历史批次、SHOT、草稿与确认记录</div>
    </div>
    <div class="top-status">
      <span id="topProject" class="pill">项目加载中</span>
      <span id="topBatch" class="pill">批次加载中</span>
      <span id="liveStatus" class="pill">连接中</span>
      <button id="focusBoard">专注 board</button>
      <button id="refresh">刷新</button>
    </div>
  </header>
  <main>
    <nav>
      <button data-page="dashboard"><span class="nav-mark">指</span><span class="nav-label">指挥台</span><span class="nav-badge" data-nav-badge="dashboard">0</span></button>
      <button data-page="imports"><span class="nav-mark">导</span><span class="nav-label">导入</span><span class="nav-badge" data-nav-badge="imports">0</span></button>
      <button data-page="webgptDrafts"><span class="nav-mark">草</span><span class="nav-label">GPT 草稿</span><span class="nav-badge" data-nav-badge="webgptDrafts">0</span></button>
      <button data-page="pendingActions"><span class="nav-mark">待</span><span class="nav-label">待确认</span><span class="nav-badge" data-nav-badge="pendingActions">0</span></button>
      <button data-page="shots"><span class="nav-mark">镜</span><span class="nav-label">镜头</span><span class="nav-badge" data-nav-badge="shots">0</span></button>
      <button data-page="package"><span class="nav-mark">包</span><span class="nav-label">分镜包</span><span class="nav-badge" data-nav-badge="package">0</span></button>
      <button data-page="review"><span class="nav-mark">审</span><span class="nav-label">审片</span><span class="nav-badge" data-nav-badge="review">0</span></button>
      <button data-page="assembly"><span class="nav-mark">合</span><span class="nav-label">合成</span><span class="nav-badge" data-nav-badge="assembly">0</span></button>
      <button data-page="finalReview"><span class="nav-mark">终</span><span class="nav-label">最终审查</span><span class="nav-badge" data-nav-badge="finalReview">0</span></button>
      <button data-page="memory"><span class="nav-mark">记</span><span class="nav-label">记忆资产</span><span class="nav-badge" data-nav-badge="memory">0</span></button>
      <button data-page="canary"><span class="nav-mark">雀</span><span class="nav-label">金丝雀</span><span class="nav-badge" data-nav-badge="canary">0</span></button>
      <button data-page="reports"><span class="nav-mark">证</span><span class="nav-label">证据报告</span><span class="nav-badge" data-nav-badge="reports">0</span></button>
    </nav>
    <section>
      <div id="dashboard"></div>
      <div id="imports" class="hidden"></div>
      <div id="webgptDrafts" class="hidden"></div>
      <div id="pendingActions" class="hidden"></div>
      <div id="shots" class="hidden"></div>
      <div id="package" class="hidden"></div>
      <div id="review" class="hidden"></div>
      <div id="assembly" class="hidden"></div>
      <div id="finalReview" class="hidden"></div>
      <div id="memory" class="hidden"></div>
      <div id="canary" class="hidden"></div>
      <div id="reports" class="hidden"></div>
    </section>
    <aside>
      <h3>操作回执</h3>
      <pre id="result">等待操作结果</pre>
      <div id="sidePanel"></div>
    </aside>
  </main>
  <script>
    let model = null;
    let nonce = '';
    let page = 'dashboard';
    let activeInspector = null;
    let inspectorVisible = window.localStorage.getItem('h1InspectorVisible') !== 'false';
    const importViewerState = {};
    let selectedImportBatchKey = window.localStorage.getItem('h1SelectedImportBatchKey') || '';
    let selectedDraftId = window.localStorage.getItem('h1SelectedDraftId') || '';
    let selectedPendingActionId = window.localStorage.getItem('h1SelectedPendingActionId') || '';
    let pendingActionFilter = window.localStorage.getItem('h1PendingActionFilter') || 'pending';
    let selectedReviewClipId = window.localStorage.getItem('h1SelectedReviewClipId') || '';
    let reviewStatusFilter = window.localStorage.getItem('h1ReviewStatusFilter') || 'all';
    let reviewShotFilter = window.localStorage.getItem('h1ReviewShotFilter') || '';
    let reviewOffset = Number(window.localStorage.getItem('h1ReviewOffset') || 0);
    const reviewPageSize = 50;
    const result = document.getElementById('result');
    const statusLabels = {
      pending: '待处理',
      approved: '已批准',
      revision_needed: '需修改',
      active: '可用',
      pending_upload: '待上传',
      inaccessible: '不可访问',
      expired: '已过期',
      archived: '已归档',
      rejected: '已拒绝',
      blocked: '已阻断',
      draft: '草案',
      reviewed: '已审核',
      confirmed: '已确认',
      proposed: '待决策',
      local_confirmed: '本地已确认',
      approved_for_media_artifact_handoff: '可注册为媒体 Artifact'
    };
    const blockerLabels = {
      ACTION_NONCE_REQUIRED: '缺少操作 nonce',
      ACCEPTED_CLIP_ARTIFACT_MISSING: '已采纳 clip 的 Artifact 不存在',
      ACCEPTED_CLIP_NOT_GENERATED_VIDEO: '已采纳 clip 不是 generated_clip 视频',
      ARTIFACT_NOT_FOUND: '未找到媒体 Artifact',
      ASPECT_RATIO_NOT_9_16: '图片不是 9:16 竖屏比例',
      AUDIT_IMAGE_NOT_ALLOWED: '审计图片不能进入分镜流程',
      AUDIT_IMAGE_REJECTED: '审计图片不能进入分镜流程',
      FAKE_PROJECT_ID_REJECTED: '拒绝虚假项目 ID',
      FOUR_PANEL_OR_CONTACT_SHEET_NOT_STORYBOARD: '四宫格或联系表不能作为单张分镜图',
      FOUR_PANEL_REFERENCE_REJECTED: '四宫格或联系表不能作为单张分镜图',
      FREEZE_PRECONDITIONS_BLOCKED: '冻结前置条件未满足',
      HUMAN_CONFIRMATION_REQUIRED: '需要人类明确确认',
      IMAGE_EXTENSION_UNSUPPORTED: '图片扩展名不受支持',
      IMAGE_FILE_INVALID: '图片文件无效',
      IMAGE_FILE_NOT_READABLE: '图片不可读取',
      IMAGE_MIME_UNSUPPORTED: '图片格式不受支持',
      IMPORT_FILE_TYPE_NOT_SUPPORTED: '导入文件类型不受支持',
      IMPORT_FILENAME_NOT_ALLOWED: '导入文件名不允许',
      INVALID_ARTIFACT_ROLE: 'Artifact 类型或角色不正确',
      LOCALHOST_ONLY: '只允许本机访问',
      MISSING_DESCRIPTION: '缺少镜头描述',
      MISSING_DURATION_SECONDS: '缺少镜头时长',
      MISSING_NEGATIVE_PROMPT: '缺少负向提示词',
      MISSING_ACCEPTED_CLIP: '缺少已采纳 clip',
      MISSING_STORYBOARD_IMAGE_ARTIFACT_ID: '缺少分镜图 Artifact ID',
      MISSING_VIDEO_PROMPT: '缺少视频提示词',
      NOT_FOUND: '未找到',
      PENDING_ID_REJECTED: '拒绝 PENDING ID',
      PRODUCT_REFERENCE_NOT_STORYBOARD: '产品参考图不能作为分镜图',
      PRODUCT_REFERENCE_REJECTED: '产品参考图不能作为分镜图',
      PROJECT_HAS_NO_SHOTS: '项目没有镜头',
      PROJECT_NOT_FOUND: '未找到项目',
      REPORT_NOT_FOUND: '未找到报告',
      FINAL_DECISION_ALREADY_RECORDED: '最终决策已记录',
      FINAL_REVIEW_NOTE_REQUIRED: '最终审查备注必填',
      FINAL_REVIEW_PACKAGE_NOT_READY: '最终审查包未就绪',
      INVALID_FINAL_REVIEW_DECISION: '最终决策无效',
      REVIEWER_REQUIRED: '审查人必填',
      SERVER_ERROR: '服务器错误',
      SHOT_NOT_APPROVED: '镜头尚未批准',
      SHOT_NOT_FOUND: '未找到镜头',
      STORAGE_PATH_NOT_ALLOWED: '路径不在允许范围内',
      SYMLINK_ESCAPE_BLOCKED: '已阻止符号链接逃逸',
      ZIP_FILE_REJECTED: '压缩包不能作为分镜图',
      DOC_FILE_REJECTED: '文档不能作为分镜图'
    };
    const boundaryLabels = {
      network_call_attempted: '尝试网络调用',
      runway_called: '调用 Runway',
      runninghub_called: '调用 RunningHub',
      provider_credits_consumed: '消耗 provider 额度',
      real_video_generated: '生成真实视频',
      regeneration_performed: '执行重新生成',
      batch_generation_performed: '执行批量生成',
      final_assembly_performed: '执行最终合成',
      memory_saveback_performed: '执行记忆回写',
      source_asset_overwritten: '覆盖源资产',
      secret_values_exposed: '暴露 secret 值',
      provider: 'Provider',
      endpoint: 'Endpoint',
      x_runway_version: 'X-Runway-Version',
      max_submit_calls: '最大提交次数',
      runway_ratio: 'Runway ratio',
      direct_9_16_sent_to_runway: '直接发送 9:16',
      real_submit_available: '真实提交可用',
      real_submit_requires_separate_authorization: '真实提交需单独授权',
      automatic_memory_save: '自动记忆回写',
      long_term_memory_write_attempted: '尝试长期记忆写入',
      secret_read: '读取 secret',
      private_state_read: '读取私有状态',
      env_files_read: '读取 env 文件',
      credentials_read: '读取凭证',
      source_assets_overwritten: '覆盖源资产',
      media_upload_to_provider: '上传到 provider',
      provider_submit: '提交 provider',
      status_poll: '轮询 provider',
      output_download_from_provider: '从 provider 下载',
      publish_performed: '发布',
      raw_provider_payload_recorded: '记录 raw provider payload',
      signed_url_recorded: '记录 signed URL',
      push_performed: 'push',
      tag_created: '创建 tag',
      release_or_deploy_performed: 'release/deploy'
    };
    async function api(path, body) {
      const options = body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-h1-action-nonce': nonce }, body: JSON.stringify(body) } : {};
      const response = await fetch(path, options);
      const payload = await response.json();
      result.textContent = actionText(payload);
      await load();
      return payload;
    }
    async function load() {
      const response = await fetch('/api/bootstrap' + reviewQueryString());
      model = await response.json();
      nonce = model.action_nonce;
      render();
    }
    function reviewQueryString() {
      const params = new URLSearchParams();
      params.set('review_status', reviewStatusFilter || 'all');
      if (reviewShotFilter) params.set('review_shot_id', reviewShotFilter);
      params.set('review_offset', String(Math.max(0, reviewOffset || 0)));
      params.set('review_limit', String(reviewPageSize));
      return '?' + params.toString();
    }
    function show(next) {
      page = next;
      for (const id of ['dashboard','imports','webgptDrafts','pendingActions','shots','package','review','assembly','finalReview','memory','canary','reports']) document.getElementById(id).classList.toggle('hidden', id !== page);
      render();
    }
    function render() {
      if (!model) return;
      document.getElementById('liveStatus').textContent = '已连接';
      document.getElementById('liveStatus').className = 'pill ok';
      document.getElementById('topProject').textContent = model.state && model.state.project ? model.state.project.title || model.state.project.project_id || '当前项目' : '当前项目';
      document.getElementById('topProject').className = 'pill ok';
      document.getElementById('topBatch').textContent = primaryBatchTitle();
      document.getElementById('topBatch').className = 'pill warn';
      document.querySelector('main').classList.toggle('inspector-hidden', !inspectorVisible);
      document.getElementById('focusBoard').textContent = inspectorVisible ? '专注 board' : '显示 inspector';
      renderDashboard();
      renderImports();
      renderWebGptDrafts();
      renderPendingActions();
      renderShots();
      renderPackage();
      renderReview();
      renderAssembly();
      renderFinalReview();
      renderMemory();
      renderCanary();
      renderReports();
      renderSidePanel();
      for (const id of ['dashboard','imports','webgptDrafts','pendingActions','shots','package','review','assembly','finalReview','memory','canary','reports']) document.getElementById(id).classList.toggle('hidden', id !== page);
      document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.page === page));
      renderNavBadges();
    }
    function primaryBatchTitle() {
      const groups = importBatchGroups(model && model.imports ? model.imports : []);
      return groups.ready.length ? groups.ready[0].title : '暂无批次';
    }
    function renderNavBadges() {
      const pending = model.pending_actions || { pending_count: 0 };
      const drafts = model.webgpt_drafts || { drafts_total: 0 };
      const review = model.review || { generated_clips: [], regeneration_request_drafts: [] };
      const memory = model.memory || {};
      const assembly = model.assembly || {};
      const finalReview = model.final_review || {};
      const imports = model.imports || [];
      const shots = model.state && model.state.shots ? model.state.shots : [];
      const reviewTotal = review.generated_clip_total_available || (review.generated_clips || []).length;
      const values = {
        dashboard: String((pending.pending_count || 0) + reviewTotal),
        imports: String(imports.length),
        webgptDrafts: String(drafts.drafts_total || 0),
        pendingActions: String(pending.pending_count || 0),
        shots: String(shots.length),
        package: model.package && model.package.validation && model.package.validation.ok ? 'OK' : '!',
        review: String(reviewTotal),
        assembly: assembly.ready_for_assembly ? 'OK' : String((assembly.blockers || []).length),
        finalReview: finalReview.decision_report ? 'OK' : (finalReview.final_video ? '1' : '0'),
        memory: String(memory.proposals_total || 0),
        canary: model.canary && model.canary.active_provider ? '1' : '0',
        reports: String((model.reports || []).length)
      };
      Object.keys(values).forEach(key => {
        const node = document.querySelector('[data-nav-badge="' + key + '"]');
        if (node) node.textContent = values[key];
      });
    }
    function renderDashboard() {
      const d = model.dashboard;
      const pending = model.pending_actions || { pending_count: 0 };
      const assembly = model.assembly || { ready_for_assembly: false, final_video_artifact: null, blockers: [] };
      const finalReview = model.final_review || { final_video: null, review_package: null };
      const finalVideo = finalReview.final_video || (assembly.final_video_artifact ? { artifact_id: assembly.final_video_artifact.artifact_id, ffprobe: assembly.final_video_artifact.ffprobe } : null);
      const review = model.review || { generated_clips: [], regeneration_request_drafts: [] };
      const memory = model.memory || { latest_proposal: null };
      const imports = importBatchGroups(model.imports || []);
      const shots = model.state && model.state.shots ? model.state.shots : [];
      const r3p = latestReport('r3_9p_final_video_review_package_result.json');
      const r3o = latestReport('r3_9o_final_video_assembly_execution_result.json');
      const decisionReport = finalReview.decision_report;
      const pendingCards = [
        trelloCard('待确认动作', String(pending.pending_count || 0) + ' 个动作等待 Jenn 点头。', [
          ['处理方式', '像 Trello Inbox：先看清楚，再确认或拒绝'],
          ['Provider', '不会调用'],
          ['入口', '待确认页']
        ], [{ label: '打开待确认', page: 'pendingActions', kind: 'pending', id: 'summary' }], (pending.pending_count || 0) ? 'warn' : 'ok'),
        trelloCard('GPT 草稿收件箱', String(model.webgpt_drafts && model.webgpt_drafts.drafts_total || 0) + ' 条草稿按类型分列。', [
          ['重点', '镜头脚本 / Artifact 绑定 / 分镜包'],
          ['安全', '不会自动改真实项目'],
          ['入口', 'GPT 草稿页']
        ], [{ label: '打开草稿', page: 'webgptDrafts', kind: 'drafts', id: 'summary' }], 'ok')
      ].join('');
      const batchCards = imports.ready.slice(0, 4).map(batch => {
        const shotCount = importShotGroups(batch).length;
        return trelloCard(batch.title, shotCount + ' 个 SHOT，' + batch.items.length + ' 张候选图。', [
          ['batch_id', batch.key],
          ['结构', '批次 > SHOT > 候选图'],
          ['当前动作', '查看、切换、注册或排除当前图']
        ], [{ label: '去导入页', page: 'imports', kind: 'batch', id: batch.key }], 'ok');
      }).join('');
      const productionCards = [
        trelloCard('镜头状态', d.shots_approved + '/' + d.shots_total + ' 个镜头已批准。', [
          ['需修改', String(shots.filter(shot => shot.approval_status === 'revision_needed').length)],
          ['待处理', String(shots.filter(shot => shot.approval_status !== 'approved').length)],
          ['入口', '镜头页']
        ], [{ label: '打开镜头', page: 'shots', kind: 'shots', id: 'summary' }], d.shots_approved === d.shots_total ? 'ok' : 'warn'),
        trelloCard('审片决策', String(review.generated_clip_total_available || review.generated_clips.length) + ' 个 generated_clip 可筛查。', [
          ['重生成草案', String((review.regeneration_request_drafts || []).length)],
          ['工作方式', '按状态 / SHOT 筛查后逐个审片'],
          ['入口', '审片页']
        ], [{ label: '打开审片', page: 'review', kind: 'review', id: 'summary' }], (review.generated_clip_total_available || review.generated_clips.length) ? 'warn' : 'ok'),
        trelloCard('最终合成', assembly.ready_for_assembly ? '本地合成条件已满足。' : '仍有阻断项需要处理。', [
          ['阻断项', blockerText(assembly.blockers || [])],
          ['最终视频', finalVideo ? '已生成' : '未生成'],
          ['最终决策', decisionReport ? labelDecision(decisionReport.decision) : '未记录']
        ], [{ label: '打开合成', page: assembly.ready_for_assembly ? 'assembly' : 'review', kind: 'assembly', id: 'summary' }], assembly.ready_for_assembly ? 'ok' : 'warn')
      ].join('');
      const evidenceCards = [
        trelloCard('最终审查包', r3p ? 'R3-9P 已有审查包。' : '暂无最终审查包。', [
          ['最终视频', finalVideo ? '已生成' : '未生成'],
          ['决策报告', decisionReport ? '已记录' : '未记录'],
          ['入口', '最终审查页']
        ], [{ label: '打开最终审查', page: 'finalReview', kind: 'finalReview', id: 'summary' }], decisionReport ? 'ok' : 'warn'),
        trelloCard('记忆资产', memory.latest_proposal ? '有 proposal 待处理。' : '暂无待处理 proposal。', [
          ['Proposal', String(memory.proposals_total || 0)],
          ['Memory', String(memory.memory_items_total || 0)],
          ['Asset', String(memory.assets_total || 0)]
        ], [{ label: '打开记忆资产', page: 'memory', kind: 'memory', id: 'summary' }], memory.latest_proposal ? 'warn' : 'ok'),
        trelloCard('关键报告', String(d.reports_total) + ' 份证据报告可查看。', [
          ['R3-9P', r3p ? '有' : '无'],
          ['R3-9O', r3o ? '有' : '无'],
          ['边界', '只展示低披露摘要']
        ], [{ label: '打开证据报告', page: 'reports', kind: 'reports', id: 'summary' }], 'ok')
      ].join('');
      document.getElementById('dashboard').innerHTML =
        '<div class="page-head"><div><h2>' + escapeHtml(model.state.project.title || assembly.project_title || '当前项目') + '</h2><div class="page-kicker">把导入、草稿、审片、合成、证据都放到一张生产 board 上。</div></div><div class="toolbar">' + statusPill('ok', 'Safe Local Production Lane') + statusPill((pending.pending_count || 0) ? 'warn' : 'ok', String(pending.pending_count || 0) + ' 个待确认') + '</div></div>' +
        '<div class="summary">' +
        metric('镜头批准', d.shots_approved + '/' + d.shots_total) +
        metric('可导入图片', d.imports_ready + '/' + d.imports_total) +
        metric('阻断项', d.blockers_total) +
        metric('报告', d.reports_total) +
        '</div>' +
        '<div class="trello-board wide">' +
        boardList('Jenn 收件箱', '需要人类判断的东西先进这里，不让 payload 直接砸到脸上。', pendingCards, String((pending.pending_count || 0) + (model.webgpt_drafts && model.webgpt_drafts.drafts_total || 0))) +
        boardList('当前批次', '导入图按视频生成批次和 SHOT 排列。', batchCards || emptyState('暂无可用导入批次'), String(imports.ready.length)) +
        boardList('生产推进', '镜头、审片、合成的当前状态。', productionCards, String(shots.length + review.generated_clips.length)) +
        boardList('证据与收工', '最终审查、记忆资产和报告入口。', evidenceCards, String(d.reports_total)) +
        '</div>' +
        '<div class="panel"><h2>生产边界</h2>' + boundaryTable(d.provider_boundary) + '</div>';
    }
    function inferImportBatch(item) {
      const filename = String(item.filename || '');
      const stem = filename.replace(/\\.[^.]+$/, '');
      let batchKey = stem;
      let sequence = 999999;
      let shotLabel = '未编号';
      let kind = '单张候选';
      let match = /^(.*?)[_-]SHOT[_-]?(\\d{1,4})(?:[_-].*)?$/i.exec(stem);
      if (match) {
        batchKey = trimBatchKey(match[1]);
        sequence = Number(match[2]);
        shotLabel = 'SHOT_' + padImportNumber(sequence, 3);
        kind = 'SHOT 批次';
      } else {
        match = /^(.*?)[_-](\\d{1,4})(?:[_-].*)?$/i.exec(stem);
        if (match) {
          batchKey = trimBatchKey(match[1]);
          sequence = Number(match[2]);
          shotLabel = 'SHOT_' + padImportNumber(sequence, 3);
          kind = '编号批次';
        }
      }
      return {
        batchKey,
        title: importBatchTitle(batchKey),
        sequence,
        shotLabel,
        kind
      };
    }
    function trimBatchKey(value) {
      const key = String(value || '').replace(/[_-]+$/g, '');
      return key || '未分类批次';
    }
    function padImportNumber(value, length) {
      return String(Number.isFinite(value) ? value : 0).padStart(length, '0');
    }
    function importBatchTitle(batchKey) {
      return String(batchKey || '未分类批次')
        .split(/[_-]+/)
        .filter(Boolean)
        .map(token => token.length <= 3 ? token.toUpperCase() : token)
        .join(' ');
    }
    function blockedImportCategory(item) {
      const filename = String(item.filename || '').toLowerCase();
      const blockers = item.blockers || [];
      if (blockers.includes('AUDIT_IMAGE_REJECTED') || filename.includes('audit') || filename.includes('do_not_use')) return { key: 'audit', title: '审计 / 禁用图' };
      if (blockers.includes('PRODUCT_REFERENCE_REJECTED') || filename.includes('reference')) return { key: 'reference', title: '参考图 / 产品图' };
      if (blockers.includes('FOUR_PANEL_REFERENCE_REJECTED') || filename.includes('contact_sheet') || filename.includes('four_panel') || filename.includes('storyboard_sheet')) return { key: 'contact_sheet', title: '联系表 / 多宫格' };
      if (blockers.includes('ASPECT_RATIO_NOT_9_16')) return { key: 'ratio', title: '比例不合格' };
      if (blockers.includes('IMAGE_FILE_INVALID') || blockers.includes('IMAGE_FILE_NOT_READABLE')) return { key: 'invalid', title: '坏图 / 不可读' };
      if (blockers.includes('PENDING_ID_REJECTED')) return { key: 'pending', title: 'Pending / 假 ID' };
      return { key: 'other', title: '其他不可用图' };
    }
    function importBatchGroups(imports) {
      const readyMap = new Map();
      const blockedMap = new Map();
      for (const item of imports || []) {
        const meta = inferImportBatch(item);
        const entry = { item, meta };
        if (item.blockers && item.blockers.length) {
          const category = blockedImportCategory(item);
          if (!blockedMap.has(category.key)) blockedMap.set(category.key, { key: category.key, title: category.title, items: [] });
          blockedMap.get(category.key).items.push(entry);
          continue;
        }
        if (!readyMap.has(meta.batchKey)) {
          readyMap.set(meta.batchKey, { key: meta.batchKey, title: meta.title, kind: meta.kind, items: [] });
        }
        readyMap.get(meta.batchKey).items.push(entry);
      }
      const sortEntries = (entries) => entries.sort((left, right) => {
        if (left.meta.sequence !== right.meta.sequence) return left.meta.sequence - right.meta.sequence;
        return String(left.item.filename || '').localeCompare(String(right.item.filename || ''));
      });
      const ready = Array.from(readyMap.values()).map(batch => ({ ...batch, items: sortEntries(batch.items) }))
        .sort((left, right) => String(left.key).localeCompare(String(right.key)));
      const blockedOrder = ['audit', 'reference', 'contact_sheet', 'ratio', 'invalid', 'pending', 'other'];
      const blocked = Array.from(blockedMap.values()).map(group => ({ ...group, items: sortEntries(group.items) }))
        .sort((left, right) => blockedOrder.indexOf(left.key) - blockedOrder.indexOf(right.key));
      return { ready, blocked };
    }
    function importShotGroups(batch) {
      const shotMap = new Map();
      for (const entry of batch.items || []) {
        const shotKey = entry.meta.shotLabel || 'UNNUMBERED';
        if (!shotMap.has(shotKey)) {
          shotMap.set(shotKey, {
            key: shotKey,
            label: shotDisplayLabel(shotKey),
            sequence: entry.meta.sequence,
            viewerKey: batch.key + '|' + shotKey,
            items: []
          });
        }
        shotMap.get(shotKey).items.push(entry);
      }
      return Array.from(shotMap.values())
        .map(shot => ({
          ...shot,
          items: shot.items.sort((left, right) => String(left.item.filename || '').localeCompare(String(right.item.filename || '')))
        }))
        .sort((left, right) => {
          if (left.sequence !== right.sequence) return left.sequence - right.sequence;
          return String(left.key).localeCompare(String(right.key));
        });
    }
    function shotDisplayLabel(value) {
      return String(value || '未编号').replace('_', ' ');
    }
    function selectedImportEntry(shot) {
      const maxIndex = Math.max(0, shot.items.length - 1);
      const current = Number(importViewerState[shot.viewerKey] || 0);
      const index = Math.min(Math.max(Number.isFinite(current) ? current : 0, 0), maxIndex);
      importViewerState[shot.viewerKey] = index;
      return { entry: shot.items[index], index };
    }
    function renderImports() {
      const imports = model.imports || [];
      const grouped = importBatchGroups(imports);
      const readyCount = grouped.ready.reduce((total, batch) => total + batch.items.length, 0);
      const registerableCount = grouped.ready.reduce((total, batch) => total + batch.items.filter(entry => !(entry.item.existing_artifact_ids || []).length).length, 0);
      const blockedCount = grouped.blocked.reduce((total, group) => total + group.items.length, 0);
      const selectedBatch = selectedImportBatch(grouped.ready);
      const selectedShots = selectedBatch ? importShotGroups(selectedBatch) : [];
      const selectedEntries = selectedShots.map(selectedImportEntry).map(selection => selection.entry).filter(Boolean);
      const selectedRegisterable = selectedEntries.filter(entry => !(entry.item.existing_artifact_ids || []).length);
      const selectedRegistered = selectedEntries.length - selectedRegisterable.length;
      const readyRows = grouped.ready.map(batch => renderImportBatchQueueCard(batch, selectedBatch ? selectedBatch.key : '')).join('');
      const blockedRows = grouped.blocked.map(renderBlockedImportSummary).join('');
      const selectedSummary = selectedBatch ? [
        ['当前批次', selectedBatch.title],
        ['当前 SHOT', String(selectedShots.length)],
        ['当前候选图', String(selectedBatch.items.length)],
        ['当前可注册', String(selectedRegisterable.length) + '/' + String(selectedEntries.length)],
        ['当前已注册', String(selectedRegistered)]
      ] : [];
      const blockedSummary = selectedSummary.concat(grouped.blocked.map(group => [group.title, String(group.items.length) + ' 张'])).concat([
        ['可注册分镜', String(registerableCount) + '/' + String(readyCount)],
        ['视频批次', String(grouped.ready.length)],
        ['源素材覆盖', '不会']
      ]);
      document.getElementById('imports').innerHTML =
        '<div class="page-head"><div><h2>导入与归类</h2><div class="page-kicker">批次先排队，当前批次再展开；不可用素材只保留异常摘要。</div></div><div class="toolbar">' + statusPill('ok', '只读取 data/imports 内图片') + statusPill('warn', '源文件不会被覆盖') + statusPill('ok', '先批次后细节') + '</div></div>' +
        '<div class="summary">' +
        metric('导入文件', String(imports.length)) +
        metric('视频批次', String(grouped.ready.length)) +
        metric('可注册分镜', String(registerableCount) + '/' + String(readyCount)) +
        metric('不可用图', String(blockedCount)) +
        '</div>' +
        '<div class="import-workbench">' +
        '<div class="asset-inbox board-list"><div class="board-list-header"><div><h2>隔离收件箱</h2><div class="board-list-help">这里只显示异常分组和样例，不把坏图展开成操作墙。</div></div>' + statusPill(blockedCount ? 'bad' : 'ok', String(blockedCount)) + '</div><div class="import-batches">' + (blockedRows || emptyState('暂无不可用导入图')) + '</div></div>' +
        '<div class="batch-stage"><div class="board-list-header"><div><h2>批次视图</h2><div class="board-list-help">左边选批次，右边只处理当前批次的 SHOT 候选图。</div></div>' + statusPill('ok', String(grouped.ready.length) + ' 批') + '</div><div class="batch-stage-grid"><div class="batch-queue">' + (readyRows || emptyState('data/imports 里暂无可用于生成视频的 9:16 分镜图')) + '</div><div class="batch-detail">' + (selectedBatch ? renderImportBatch(selectedBatch) : emptyState('请选择一个批次')) + '</div></div></div>' +
        '<div class="batch-check board-list"><div class="board-list-header"><div><h2>批次检查</h2><div class="board-list-help">这列只显示会影响下一步的导入事实。</div></div></div>' + keyValueTable('导入概览', blockedSummary) + '<div class="decision-bar"><button onclick="show(\\'pendingActions\\')">去待确认</button><button onclick="show(\\'package\\')">看分镜包</button></div></div>' +
        '</div>';
    }
    function selectedImportBatch(batches) {
      if (!batches.length) return null;
      let batch = batches.find(item => item.key === selectedImportBatchKey);
      if (!batch) {
        batch = batches[0];
        selectedImportBatchKey = batch.key;
        window.localStorage.setItem('h1SelectedImportBatchKey', selectedImportBatchKey);
      }
      return batch;
    }
    function selectImportBatch(batchKey) {
      const batchList = document.querySelector('.batch-queue');
      const detailList = document.querySelector('.batch-detail .import-shot-strip');
      const inboxList = document.querySelector('.asset-inbox .import-batches');
      const positions = {
        batchScrollTop: batchList ? batchList.scrollTop : 0,
        detailScrollLeft: detailList ? detailList.scrollLeft : 0,
        inboxScrollTop: inboxList ? inboxList.scrollTop : 0
      };
      selectedImportBatchKey = String(batchKey || '');
      window.localStorage.setItem('h1SelectedImportBatchKey', selectedImportBatchKey);
      renderImports();
      restoreImportScrollPositions(positions);
    }
    function renderImportBatchQueueCard(batch, selectedKey) {
      const shots = importShotGroups(batch);
      const selected = shots.map(selectedImportEntry).map(selection => selection.entry).filter(Boolean);
      const registerable = selected.filter(entry => !(entry.item.existing_artifact_ids || []).length);
      const registered = selected.length - registerable.length;
      return '<button class="batch-queue-card ' + (batch.key === selectedKey ? 'selected' : '') + '" onclick="selectImportBatch(\\'' + jsString(batch.key) + '\\')">' +
        '<div class="batch-queue-meta">' + statusPill(registerable.length ? 'ok' : 'warn', registerable.length ? '可处理' : '已处理') + statusPill('ok', String(shots.length) + ' SHOT') + statusPill('warn', String(batch.items.length) + ' 候选') + '</div>' +
        '<h3>' + escapeHtml(batch.title) + '</h3>' +
        '<div class="muted">' + escapeHtml(batch.kind) + ' · 当前可注册 ' + escapeHtml(String(registerable.length)) + '/' + escapeHtml(String(selected.length)) + (registered ? ' · 已注册 ' + escapeHtml(String(registered)) : '') + '</div>' +
        '</button>';
    }
    function renderImportBatch(batch) {
      const shots = importShotGroups(batch);
      const selected = shots.map(selectedImportEntry).map(selection => selection.entry).filter(Boolean);
      const registerable = selected.filter(entry => !(entry.item.existing_artifact_ids || []).length);
      const registered = selected.length - registerable.length;
      const batchAction = 'registerImportBatch(' + jsStringArray(registerable.map(entry => entry.item.filename)) + ')';
      return '<div class="import-batch">' +
        '<div class="import-batch-header">' +
        '<div class="import-batch-title"><h3>' + escapeHtml(batch.title) + '</h3><div class="muted">batch_id: ' + escapeHtml(batch.key) + ' · ' + escapeHtml(batch.kind) + '</div></div>' +
        '<div class="toolbar">' + statusPill('ok', String(shots.length) + ' 个 SHOT') + statusPill('warn', String(batch.items.length) + ' 张候选图') + (registered ? statusPill('warn', String(registered) + ' 个当前图已注册') : '') + '<button class="primary" onclick="' + escapeAttr(batchAction) + '" ' + (registerable.length ? '' : 'disabled') + '>注册本批当前图</button></div>' +
        '</div>' +
        '<div class="import-shot-strip">' + shots.map(renderImportShot).join('') + '</div>' +
        '</div>';
    }
    function renderImportShot(shot) {
      const selection = selectedImportEntry(shot);
      const entry = selection.entry;
      if (!entry) return '';
      const item = entry.item;
      const existing = item.existing_artifact_ids || [];
      const registered = existing.length > 0;
      const dimensions = item.width && item.height ? String(item.width) + 'x' + String(item.height) : '尺寸未知';
      const aspect = item.normalized_aspect_ratio || item.detected_aspect_ratio || 'unknown';
      const currentText = String(selection.index + 1) + '/' + String(shot.items.length);
      const viewerKey = shot.viewerKey;
      return '<div class="import-shot">' +
        '<div class="import-shot-header">' +
        '<div class="import-shot-title"><h3>' + escapeHtml(shot.label) + '</h3><div class="muted">候选图 ' + escapeHtml(currentText) + '</div></div>' +
        statusPill(registered ? 'warn' : 'ok', registered ? String(existing.length) + ' 已注册' : '可注册') +
        '</div>' +
        '<div class="import-shot-viewer">' +
        '<img class="preview" loading="lazy" src="/imports/' + encodeURIComponent(item.filename) + '" alt="" onclick="cycleImportShot(\\'' + jsString(viewerKey) + '\\', 1, ' + String(shot.items.length) + ')">' +
        '<div class="import-shot-controls"><button onclick="cycleImportShot(\\'' + jsString(viewerKey) + '\\', -1, ' + String(shot.items.length) + ')">上</button><button onclick="cycleImportShot(\\'' + jsString(viewerKey) + '\\', 1, ' + String(shot.items.length) + ')">下</button></div>' +
        '</div>' +
        '<h3 title="' + escapeAttr(item.filename) + '">' + escapeHtml(item.filename) + '</h3>' +
        '<div class="muted">' + escapeHtml(dimensions) + ' · ' + escapeHtml(aspect) + '</div>' +
        (registered ? '<div class="muted">' + escapeHtml(String(existing.length) + ' 个 Artifact' + (existing[0] ? ' · ' + existing[0] : '')) + '</div>' : '') +
        '<div class="decision-bar"><button class="primary" onclick="registerImport(\\'' + jsString(item.filename) + '\\')" ' + (registered ? 'disabled' : '') + '>注册当前图</button><button class="warn" onclick="rejectImport(\\'' + jsString(item.filename) + '\\')">排除当前图</button>' + inspectButton('import', item.filename, '详情') + '</div>' +
        '</div>';
    }
    function renderBlockedImportSummary(group) {
      const samples = group.items.filter(entry => entry.item.width && entry.item.height).slice(0, 3);
      const sampleImages = samples.map(entry => '<img class="inbox-thumb" loading="lazy" src="/imports/' + encodeURIComponent(entry.item.filename) + '" alt="">').join('');
      const blockers = Array.from(new Set(group.items.flatMap(entry => (entry.item.blockers || []).map(labelBlocker)))).slice(0, 3);
      const sampleNames = samples.map(entry => entry.item.filename).join(' / ');
      return '<div class="import-batch blocked inbox-group-summary">' +
        '<div class="import-batch-header"><div class="import-batch-title"><h3>' + escapeHtml(group.title) + '</h3><div class="muted">' + escapeHtml(String(group.items.length)) + ' 张已隔离，不进入视频批次</div></div>' + statusPill('bad', '异常分组') + '</div>' +
        (sampleImages ? '<div class="inbox-group-samples">' + sampleImages + '</div>' : '') +
        '<div class="card-fields">' +
        cardField('主要原因', blockers.length ? blockers.join(' / ') : '未归类异常') +
        cardField('样例文件', sampleNames || '无') +
        '</div>' +
        '</div>';
    }
    function renderBlockedImportGroup(group) {
      return '<div class="import-batch blocked">' +
        '<div class="import-batch-header"><div class="import-batch-title"><h3>' + escapeHtml(group.title) + '</h3><div class="muted">' + escapeHtml(String(group.items.length)) + ' 张不会进入视频生成批次</div></div>' + statusPill('bad', '已隔离') + '</div>' +
        '<div class="import-batch-strip">' + group.items.map(renderImportCard).join('') + '</div>' +
        '</div>';
    }
    function renderImportCard(entry) {
      const item = entry.item;
      const meta = entry.meta;
      const blockers = item.blockers || [];
      const existing = item.existing_artifact_ids || [];
      const blocked = blockers.length > 0;
      const registered = existing.length > 0;
      const dimensions = item.width && item.height ? String(item.width) + 'x' + String(item.height) : '尺寸未知';
      const aspect = item.normalized_aspect_ratio || item.detected_aspect_ratio || 'unknown';
      const existingText = registered ? String(existing.length) + ' 个 Artifact' + (existing[0] ? ' · ' + existing[0] : '') : '';
      return '<div class="import-card ' + (blocked ? 'is-blocked' : '') + '">' +
        '<img class="preview" loading="lazy" src="/imports/' + encodeURIComponent(item.filename) + '" alt="">' +
        '<div class="muted">' + escapeHtml(meta.shotLabel) + '</div>' +
        '<h3 title="' + escapeAttr(item.filename) + '">' + escapeHtml(item.filename) + '</h3>' +
        '<div class="muted">' + escapeHtml(dimensions) + ' · ' + escapeHtml(aspect) + '</div>' +
        '<div class="toolbar">' + (blocked ? statusPill('bad', blockerText(blockers)) : registered ? statusPill('warn', String(existing.length) + ' 已注册') : statusPill('ok', '可注册')) + '</div>' +
        (registered ? '<div class="muted">' + escapeHtml(existingText) + '</div>' : '') +
        '<div class="decision-bar"><button class="primary" onclick="registerImport(\\'' + jsString(item.filename) + '\\')" ' + (blocked || registered ? 'disabled' : '') + '>注册</button><button class="warn" onclick="rejectImport(\\'' + jsString(item.filename) + '\\')">排除</button>' + inspectButton('import', item.filename, '详情') + '</div>' +
        '</div>';
    }
    function renderWebGptDrafts() {
      const summary = model.webgpt_drafts || { drafts: [], drafts_total: 0, provider_boundary: {}, production_effects: {} };
      const drafts = summary.drafts || [];
      const groups = draftToolCounts(drafts);
      const orderedDrafts = draftTriageQueue(drafts);
      const selectedDraft = selectedWebGptDraft(orderedDrafts);
      const highRiskCount = drafts.filter(draft => draftRiskLevel(draft).kind !== 'ok').length;
      const queue = orderedDrafts.map(draft => renderDraftQueueCard(draft, selectedDraft ? selectedDraft.draft_id : '')).join('');
      document.getElementById('webgptDrafts').innerHTML =
        '<div class="page-head"><div><h2>GPT 草稿</h2><div class="page-kicker">先按风险排队，选中后再看摘要、证据和去向。</div></div><div class="toolbar">' + statusPill('ok', '这里只是 WebGPT 草稿') + statusPill('warn', '不会自动改镜头/注册素材/冻结分镜包') + '</div></div>' +
        '<div class="summary">' +
        metric('草稿总数', String(summary.drafts_total || 0)) +
        metric('当前队列', String(drafts.length)) +
        metric('需重点看', String(highRiskCount)) +
        metric('Provider 调用', summary.provider_boundary && summary.provider_boundary.provider_credits_consumed ? '有' : '无') +
        '</div>' +
        '<div class="toolbar">' + statusPill('ok', draftToolCountText(groups)) + '</div>' +
        '<div class="draft-triage-workbench">' +
        '<div class="draft-queue panel"><div class="board-list-header"><div><h2>草稿队列</h2><div class="board-list-help">高风险和冻结相关草稿排前面；点击一条看详情。</div></div>' + statusPill('ok', String(drafts.length) + ' 条') + '</div><div class="draft-queue-list">' + (queue || emptyState('暂无 GPT 草稿')) + '</div></div>' +
        '<div class="draft-review panel">' + renderSelectedDraftReview(selectedDraft) + '</div>' +
        '<div class="draft-evidence panel">' + renderSelectedDraftEvidence(selectedDraft, summary) + '</div>' +
        '</div>';
    }
    function selectedWebGptDraft(drafts) {
      if (!drafts.length) return null;
      let draft = drafts.find(item => item.draft_id === selectedDraftId);
      if (!draft) {
        draft = drafts[0];
        selectedDraftId = draft.draft_id;
        window.localStorage.setItem('h1SelectedDraftId', selectedDraftId);
      }
      return draft;
    }
    function selectWebGptDraft(draftId) {
      const queue = document.querySelector('.draft-queue-list');
      const evidence = document.querySelector('.draft-evidence-body');
      const positions = {
        queueScrollTop: queue ? queue.scrollTop : 0,
        evidenceScrollTop: evidence ? evidence.scrollTop : 0
      };
      selectedDraftId = String(draftId || '');
      window.localStorage.setItem('h1SelectedDraftId', selectedDraftId);
      renderWebGptDrafts();
      restoreDraftScrollPositions(positions);
    }
    function restoreDraftScrollPositions(positions) {
      const nextQueue = document.querySelector('.draft-queue-list');
      const nextEvidence = document.querySelector('.draft-evidence-body');
      if (nextQueue) nextQueue.scrollTop = positions.queueScrollTop || 0;
      if (nextEvidence) nextEvidence.scrollTop = positions.evidenceScrollTop || 0;
      window.requestAnimationFrame(() => {
        const rafQueue = document.querySelector('.draft-queue-list');
        const rafEvidence = document.querySelector('.draft-evidence-body');
        if (rafQueue) rafQueue.scrollTop = positions.queueScrollTop || 0;
        if (rafEvidence) rafEvidence.scrollTop = positions.evidenceScrollTop || 0;
      });
    }
    function draftTriageQueue(drafts) {
      return (drafts || []).slice().sort((left, right) => {
        const riskDelta = draftRiskRank(right) - draftRiskRank(left);
        if (riskDelta) return riskDelta;
        const timeDelta = String(right.created_at || '').localeCompare(String(left.created_at || ''));
        if (timeDelta) return timeDelta;
        return String(left.draft_id || '').localeCompare(String(right.draft_id || ''));
      });
    }
    function draftRiskRank(draft) {
      return ({
        propose_freeze_request: 4,
        propose_package_validation: 3,
        submit_storyboard_package_draft: 2,
        propose_artifact_link: 2,
        submit_shot_script_draft: 1
      })[String(draft.tool || '')] || 1;
    }
    function draftRiskLevel(draft) {
      const tool = String(draft.tool || '');
      if (tool === 'propose_freeze_request') return { kind: 'bad', text: '高风险' };
      if (tool === 'propose_package_validation' || tool === 'submit_storyboard_package_draft' || tool === 'propose_artifact_link') return { kind: 'warn', text: '需审查' };
      return { kind: 'ok', text: '低风险' };
    }
    function renderDraftQueueCard(draft, selectedId) {
      const info = draftInfo(draft);
      const risk = draftRiskLevel(draft);
      const target = draftTargetText(draft);
      return '<button class="draft-queue-card ' + (draft.draft_id === selectedId ? 'selected ' : '') + (risk.kind !== 'ok' ? 'high-risk' : '') + '" onclick="selectWebGptDraft(\\'' + jsString(draft.draft_id) + '\\')">' +
        '<div class="draft-queue-meta">' + statusPill(risk.kind, risk.text) + statusPill(info.pillKind, info.statusText) + '</div>' +
        '<h3>' + escapeHtml(info.title) + '</h3>' +
        '<div class="muted">' + escapeHtml(target) + '</div>' +
        '<div class="muted">' + escapeHtml(relativeTimeText(draft.created_at)) + '</div>' +
        '</button>';
    }
    function renderSelectedDraftReview(draft) {
      if (!draft) return '<div class="board-list-header"><div><h2>草稿详情</h2><div class="board-list-help">请选择一条草稿。</div></div></div>' + emptyState('暂无可审草稿');
      const info = draftInfo(draft);
      const risk = draftRiskLevel(draft);
      const rows = info.fields.map(row => cardField(row[0], row[1])).join('');
      return '<div class="board-list-header draft-review-title"><div><h2>' + escapeHtml(info.title) + '</h2><div class="board-list-help">' + escapeHtml(draftHumanIntent(draft)) + '</div></div>' + statusPill(risk.kind, risk.text) + '</div>' +
        '<div class="draft-review-body">' +
        '<div class="draft-review-summary">' + rows + '</div>' +
        '<div class="decision-bar draft-review-actions">' + info.actions.map(action => '<button onclick="inspectCard(\\'draft\\', \\'' + jsString(draft.draft_id) + '\\');show(\\'' + jsString(action.page) + '\\')">' + escapeHtml(action.label) + '</button>').join('') + inspectButton('draft', draft.draft_id, '详情') + '</div>' +
        '</div>';
    }
    function renderSelectedDraftEvidence(draft, summary) {
      const boundary = boundaryTable((summary && summary.provider_boundary) || {});
      if (!draft) return '<div class="board-list-header"><div><h2>证据与边界</h2><div class="board-list-help">选择草稿后显示技术证据。</div></div></div><div class="draft-evidence-body">' + boundary + '</div>';
      return '<div class="board-list-header"><div><h2>证据与边界</h2><div class="board-list-help">默认不执行动作，只展示来源、影响和原始字段。</div></div></div>' +
        '<div class="draft-evidence-body">' +
        keyValueTable('草稿证据', [
          ['草稿 ID', String(draft.draft_id || '')],
          ['工具类型', draftToolLabel(draft.tool)],
          ['状态', labelStatus(draft.status)],
          ['目标', draftTargetText(draft)],
          ['真实项目改动', draftProductionChanged(draft.production_effects || {}) ? '有' : '无'],
          ['Provider 调用', draft.production_effects && draft.production_effects.provider_call_attempted ? '有' : '无']
        ]) +
        '<details class="draft-raw"><summary>查看原始 payload</summary><pre>' + escapeHtml(JSON.stringify(draft.payload || {}, null, 2)) + '</pre></details>' +
        boundary +
        '</div>';
    }
    function draftTargetText(draft) {
      const payload = draft.payload || {};
      const tool = String(draft.tool || '');
      if (tool === 'submit_shot_script_draft' || tool === 'propose_artifact_link') return '目标镜头：' + textOr(payload.shot_id || payload.proposed_shot_key, '未指定');
      if (tool === 'submit_storyboard_package_draft') return '分镜包：' + textOr(payload.package_title, '未命名候选');
      if (tool === 'propose_package_validation' || tool === 'propose_freeze_request') return '关联草稿：' + textOr(payload.package_draft_id, '未指定');
      return tool || '未知目标';
    }
    function draftHumanIntent(draft) {
      const tool = String(draft.tool || '');
      return ({
        submit_shot_script_draft: '把镜头描述、视频提示词和时长建议交给你审阅。',
        propose_artifact_link: '建议把一个媒体 Artifact 绑定到目标镜头。',
        submit_storyboard_package_draft: '提交一组分镜包候选，等待结构审查。',
        propose_package_validation: '请求检查某个分镜包候选是否满足后续流程。',
        propose_freeze_request: '请求人工确认后冻结分镜包。'
      })[tool] || '未归类草稿，先看证据再处理。';
    }
    function draftSections(drafts) {
      const order = draftToolOrder();
      const map = new Map(order.map(tool => [tool, { tool, title: draftToolLabel(tool), help: draftSectionHelp(tool), drafts: [] }]));
      for (const draft of drafts || []) {
        const tool = String(draft.tool || 'unknown');
        if (!map.has(tool)) map.set(tool, { tool, title: draftToolLabel(tool), help: draftSectionHelp(tool), drafts: [] });
        map.get(tool).drafts.push(draft);
      }
      return Array.from(map.values()).filter(section => section.drafts.length > 0);
    }
    function renderDraftSection(section) {
      const cards = section.drafts.map(renderWebGptDraftCard).join('');
      return '<div class="draft-section panel">' +
        '<div class="import-batch-header">' +
        '<div class="import-batch-title"><h2>' + escapeHtml(section.title) + '</h2><div class="muted">' + escapeHtml(section.help) + '</div></div>' +
        statusPill('ok', String(section.drafts.length) + ' 条') +
        '</div>' +
        '<div class="draft-grid">' + cards + '</div>' +
        '</div>';
    }
    function renderWebGptDraftCard(draft) {
      const info = draftInfo(draft);
      const rows = info.fields.map(row => '<div class="draft-field"><b>' + escapeHtml(row[0]) + '</b><span>' + escapeHtml(row[1]) + '</span></div>').join('');
      return '<div class="draft-card">' +
        '<div class="import-batch-header">' +
        '<div class="import-batch-title"><h3>' + escapeHtml(info.title) + '</h3><div class="muted">' + escapeHtml(relativeTimeText(draft.created_at)) + '</div></div>' +
        statusPill(info.pillKind, info.statusText) +
        '</div>' +
        '<div class="draft-fields">' + rows + '</div>' +
        '<div class="toolbar">' + info.actions.map(action => '<button onclick="inspectCard(\\'draft\\', \\'' + jsString(draft.draft_id) + '\\');show(\\'' + jsString(action.page) + '\\')">' + escapeHtml(action.label) + '</button>').join('') + inspectButton('draft', draft.draft_id, '详情') + '</div>' +
        '<details class="draft-raw"><summary>查看技术字段</summary><pre>' + escapeHtml(JSON.stringify(draft.payload || {}, null, 2)) + '</pre></details>' +
        '<div class="muted">' + escapeHtml(shortDraftId(draft.draft_id)) + '</div>' +
        '</div>';
    }
    function draftInfo(draft) {
      const payload = draft.payload || {};
      const tool = String(draft.tool || '');
      const base = {
        title: draftToolLabel(tool),
        pillKind: draft.status === 'submitted' ? 'ok' : 'warn',
        statusText: draft.status === 'submitted' ? '待你审阅' : labelStatus(draft.status),
        actions: draftActions(tool),
        fields: []
      };
      if (tool === 'submit_shot_script_draft') {
        base.fields = [
          ['目标镜头', textOr(payload.shot_id || payload.proposed_shot_key, '未指定')],
          ['画面描述', textOr(payload.description, '未填写')],
          ['视频提示词', textOr(payload.video_prompt, '未填写')],
          ['负向提示词', textOr(payload.negative_prompt, '无')],
          ['建议时长', payload.duration_seconds ? String(payload.duration_seconds) + ' 秒' : '未指定']
        ];
      } else if (tool === 'submit_storyboard_package_draft') {
        const shots = Array.isArray(payload.shots) ? payload.shots : [];
        base.fields = [
          ['草稿标题', textOr(payload.package_title, '未命名分镜包')],
          ['包含镜头', String(shots.length) + ' 个'],
          ['镜头摘要', shots.map(shot => textOr(shot.shot_id, '未命名镜头')).join('，') || '无'],
          ['它想让你做什么', '把这组镜头作为分镜包候选来审阅']
        ];
      } else if (tool === 'propose_artifact_link') {
        base.fields = [
          ['目标镜头', textOr(payload.shot_id, '未指定')],
          ['建议绑定的 Artifact', textOr(payload.artifact_id, '未指定')],
          ['它想让你做什么', '把这个媒体 Artifact 绑定到对应镜头']
        ];
      } else if (tool === 'propose_package_validation') {
        base.fields = [
          ['关联分镜包草稿', textOr(payload.package_draft_id, '未指定')],
          ['备注', textOr(payload.notes, '无')],
          ['它想让你做什么', '检查这个分镜包候选是否可进入后续流程']
        ];
      } else if (tool === 'propose_freeze_request') {
        base.fields = [
          ['关联分镜包草稿', textOr(payload.package_draft_id, '未指定')],
          ['冻结理由', textOr(payload.reason, '未填写')],
          ['它想让你做什么', '人工确认后再冻结分镜包']
        ];
      } else {
        base.fields = [
          ['草稿类型', tool || '未知'],
          ['内容摘要', compactJson(payload)]
        ];
      }
      base.fields.push(['安全说明', draftSafetyText(draft)]);
      return base;
    }
    function draftToolLabel(tool) {
      return ({
        submit_shot_script_draft: '镜头脚本草稿',
        submit_storyboard_package_draft: '分镜包草稿',
        propose_artifact_link: 'Artifact 绑定建议',
        propose_package_validation: '分镜包校验建议',
        propose_freeze_request: '冻结请求草稿'
      })[tool] || tool || '未知草稿';
    }
    function draftToolOrder() {
      return ['submit_shot_script_draft', 'propose_artifact_link', 'submit_storyboard_package_draft', 'propose_package_validation', 'propose_freeze_request'];
    }
    function draftSectionHelp(tool) {
      return ({
        submit_shot_script_draft: 'GPT 提出的镜头描述、视频提示词、负向提示词和时长建议。',
        propose_artifact_link: 'GPT 建议把某个媒体 Artifact 绑定到某个镜头；这里只是建议，尚未执行。',
        submit_storyboard_package_draft: 'GPT 提出的一组分镜包候选，需要你看结构是否合理。',
        propose_package_validation: 'GPT 请求检查某个分镜包候选是否满足进入后续流程的条件。',
        propose_freeze_request: 'GPT 请求人工确认后冻结分镜包；页面不会自动冻结。'
      })[tool] || '未归类的 GPT 草稿。';
    }
    function draftActions(tool) {
      if (tool === 'submit_shot_script_draft' || tool === 'propose_artifact_link') return [{ label: '去镜头页处理', page: 'shots' }];
      if (tool === 'submit_storyboard_package_draft' || tool === 'propose_package_validation' || tool === 'propose_freeze_request') return [{ label: '去分镜包页处理', page: 'package' }];
      return [{ label: '回指挥台', page: 'dashboard' }];
    }
    function draftSafetyText(draft) {
      const effects = draft.production_effects || {};
      const changed = Object.keys(effects).some(key => effects[key] === true);
      return changed ? '这条草稿记录了生产影响，请检查边界。' : '仅保存草稿；未改真实项目、未调用 provider。';
    }
    function draftProductionChanged(effects) {
      return Object.keys(effects || {}).some(key => (effects || {})[key] === true);
    }
    function draftToolCounts(drafts) {
      return (drafts || []).reduce((acc, draft) => {
        const label = draftToolLabel(draft.tool);
        acc[label] = (acc[label] || 0) + 1;
        return acc;
      }, {});
    }
    function draftToolCountText(groups) {
      const parts = Object.keys(groups || {}).map(key => key + ' ' + groups[key]);
      return parts.length ? parts.join(' / ') : '无草稿';
    }
    function relativeTimeText(value) {
      return value ? '提交时间：' + String(value).replace('T', ' ').replace('Z', ' UTC') : '提交时间未知';
    }
    function shortDraftId(value) {
      const text = String(value || '');
      return text ? '草稿 ID：' + text.replace(/^webgpt_draft_/, '') : '草稿 ID：无';
    }
    function textOr(value, fallback) {
      const text = String(value ?? '').trim();
      return text || fallback;
    }
    function compactJson(value) {
      const text = JSON.stringify(value || {});
      return text.length > 220 ? text.slice(0, 220) + '...' : text;
    }
    function renderPendingActions() {
      const summary = model.pending_actions || { actions: [], actions_total: 0, pending_count: 0, provider_boundary: {} };
      const actions = summary.actions || [];
      const counts = pendingActionStatusCounts(actions);
      const filteredActions = pendingActionQueue(actions, pendingActionFilter);
      const selectedAction = selectedPendingAction(actions, filteredActions);
      const queue = filteredActions.map(action => renderPendingActionQueueCard(action, selectedAction ? selectedAction.action_id : '')).join('');
      document.getElementById('pendingActions').innerHTML =
        '<div class="page-head"><div><h2>待确认 Inbox</h2><div class="page-kicker">先选中一个动作，再看后果、证据和回执；高风险按钮只在决策面板出现。</div></div><div class="toolbar">' + statusPill(summary.pending_count ? 'warn' : 'ok', summary.pending_count ? String(summary.pending_count) + ' 个动作等你决定' : '没有待确认动作') + statusPill('ok', '不会调用 provider') + statusPill('warn', '确认后会改本地项目状态') + '</div></div>' +
        '<div class="summary">' +
        metric('待确认', String(summary.pending_count || 0)) +
        metric('动作总数', String(summary.actions_total || 0)) +
        metric('当前队列', String(filteredActions.length)) +
        metric('Provider 调用', '否') +
        '</div>' +
        '<div class="pending-decision-workbench">' +
        '<div class="pending-queue panel"><div class="board-list-header"><div><h2>决策队列</h2><div class="board-list-help">默认只看待处理；历史从筛选进入。</div></div>' + statusPill('warn', String(counts.pending || 0) + ' 待处理') + '</div>' +
        renderPendingActionFilters(counts) +
        '<div class="pending-queue-list">' + (queue || emptyState('当前筛选下没有动作')) + '</div></div>' +
        '<div class="pending-decision panel">' + renderSelectedPendingDecision(selectedAction) + '</div>' +
        '<div class="pending-evidence panel">' + renderSelectedPendingEvidence(selectedAction, summary) + '</div>' +
        '</div>';
    }
    function pendingActionStatusCounts(actions) {
      return (actions || []).reduce((acc, action) => {
        const key = String(action.status || 'unknown');
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
    }
    function renderPendingActionFilters(counts) {
      const filters = [
        ['pending', '待处理'],
        ['executed', '已执行'],
        ['rejected', '已拒绝'],
        ['failed', '失败']
      ];
      return '<div class="pending-filter-tabs">' + filters.map(filter => '<button class="' + (pendingActionFilter === filter[0] ? 'active' : '') + '" onclick="setPendingActionFilter(\\'' + jsString(filter[0]) + '\\')">' + escapeHtml(filter[1]) + ' ' + escapeHtml(String(counts[filter[0]] || 0)) + '</button>').join('') + '</div>';
    }
    function setPendingActionFilter(filter) {
      const queue = document.querySelector('.pending-queue-list');
      const positions = { queueScrollTop: queue ? queue.scrollTop : 0 };
      pendingActionFilter = String(filter || 'pending');
      window.localStorage.setItem('h1PendingActionFilter', pendingActionFilter);
      selectedPendingActionId = '';
      window.localStorage.removeItem('h1SelectedPendingActionId');
      renderPendingActions();
      restorePendingScrollPositions(positions);
    }
    function selectedPendingAction(allActions, filteredActions) {
      const pool = filteredActions.length ? filteredActions : allActions;
      if (!pool.length) return null;
      let action = pool.find(item => item.action_id === selectedPendingActionId);
      if (!action) {
        action = pool[0];
        selectedPendingActionId = action.action_id;
        window.localStorage.setItem('h1SelectedPendingActionId', selectedPendingActionId);
      }
      return action;
    }
    function selectPendingAction(actionId) {
      const queue = document.querySelector('.pending-queue-list');
      const evidence = document.querySelector('.pending-evidence-body');
      const positions = {
        queueScrollTop: queue ? queue.scrollTop : 0,
        evidenceScrollTop: evidence ? evidence.scrollTop : 0
      };
      selectedPendingActionId = String(actionId || '');
      window.localStorage.setItem('h1SelectedPendingActionId', selectedPendingActionId);
      renderPendingActions();
      restorePendingScrollPositions(positions);
    }
    function restorePendingScrollPositions(positions) {
      const nextQueue = document.querySelector('.pending-queue-list');
      const nextEvidence = document.querySelector('.pending-evidence-body');
      if (nextQueue) nextQueue.scrollTop = positions.queueScrollTop || 0;
      if (nextEvidence) nextEvidence.scrollTop = positions.evidenceScrollTop || 0;
      window.requestAnimationFrame(() => {
        const rafQueue = document.querySelector('.pending-queue-list');
        const rafEvidence = document.querySelector('.pending-evidence-body');
        if (rafQueue) rafQueue.scrollTop = positions.queueScrollTop || 0;
        if (rafEvidence) rafEvidence.scrollTop = positions.evidenceScrollTop || 0;
      });
    }
    function pendingActionQueue(actions, filter) {
      return (actions || [])
        .filter(action => String(action.status || '') === filter)
        .slice()
        .sort((left, right) => {
          const riskDelta = pendingActionRiskRank(right) - pendingActionRiskRank(left);
          if (riskDelta) return riskDelta;
          const timeDelta = String(right.created_at || '').localeCompare(String(left.created_at || ''));
          if (timeDelta) return timeDelta;
          return String(left.action_id || '').localeCompare(String(right.action_id || ''));
        });
    }
    function pendingActionRiskRank(action) {
      return ({
        request_import_storyboard_package: 4,
        request_validate_storyboard_package: 3,
        request_register_media_artifact_from_import: 2,
        request_link_artifact_to_shot: 2
      })[String(action.tool || '')] || 1;
    }
    function pendingActionRiskLevel(action) {
      const tool = String(action.tool || '');
      if (tool === 'request_import_storyboard_package') return { kind: 'bad', text: '高风险' };
      if (tool === 'request_validate_storyboard_package') return { kind: 'warn', text: '阻断检查' };
      if (tool === 'request_register_media_artifact_from_import' || tool === 'request_link_artifact_to_shot') return { kind: 'warn', text: '改本地状态' };
      return { kind: 'ok', text: '低风险' };
    }
    function renderPendingActionQueueCard(action, selectedId) {
      const info = pendingActionInfo(action);
      const risk = pendingActionRiskLevel(action);
      return '<button class="pending-queue-card ' + escapeAttr(action.status || '') + ' ' + (action.action_id === selectedId ? 'selected' : '') + '" onclick="selectPendingAction(\\'' + jsString(action.action_id) + '\\')">' +
        '<div class="pending-queue-meta">' + statusPill(risk.kind, risk.text) + statusPill(pendingActionPillKind(action), pendingActionStatusText(action)) + '</div>' +
        '<h3>' + escapeHtml(info.title) + '</h3>' +
        '<div class="muted">' + escapeHtml(pendingActionTargetText(action)) + '</div>' +
        '<div class="muted">' + escapeHtml(relativeTimeText(action.created_at)) + '</div>' +
        '</button>';
    }
    function renderSelectedPendingDecision(action) {
      if (!action) return '<div class="board-list-header"><div><h2>决策面板</h2><div class="board-list-help">请选择一条待确认动作。</div></div></div>' + emptyState('当前筛选下没有动作');
      const info = pendingActionInfo(action);
      const risk = pendingActionRiskLevel(action);
      const rows = info.fields.map(row => cardField(row[0], row[1])).join('');
      return '<div class="board-list-header pending-decision-title"><div><h2>' + escapeHtml(info.title) + '</h2><div class="board-list-help">' + escapeHtml(pendingActionHumanIntent(action)) + '</div></div>' + statusPill(risk.kind, risk.text) + '</div>' +
        '<div class="pending-decision-body">' +
        '<div class="pending-decision-summary">' + rows + '</div>' +
        '<div class="decision-bar pending-decision-actions">' + pendingActionDecisionButtons(action, info) + '</div>' +
        '</div>';
    }
    function renderSelectedPendingEvidence(action, summary) {
      const boundary = boundaryTable((summary && summary.provider_boundary) || {});
      if (!action) return '<div class="board-list-header"><div><h2>证据与回执</h2><div class="board-list-help">选择动作后显示 payload、边界和回执。</div></div></div><div class="pending-evidence-body">' + boundary + '</div>';
      const reportName = action.execution && action.execution.report_path ? reportNameFromPath(action.execution.report_path) : '';
      return '<div class="board-list-header"><div><h2>证据与回执</h2><div class="board-list-help">这里放技术字段和执行结果，不承载主要决策按钮。</div></div></div>' +
        '<div class="pending-evidence-body">' +
        keyValueTable('动作证据', [
          ['动作 ID', String(action.action_id || '')],
          ['动作类型', pendingActionToolLabel(action.tool)],
          ['状态', pendingActionStatusText(action)],
          ['目标', pendingActionTargetText(action)],
          ['执行结果', pendingExecutionText(action)],
          ['回执报告', reportName || '无']
        ]) +
        (reportName ? '<div class="decision-bar"><button onclick="openReport(\\'' + jsString(reportName) + '\\')">打开回执</button></div>' : '') +
        '<details class="draft-raw"><summary>查看原始 payload</summary><pre>' + escapeHtml(JSON.stringify(action.payload || {}, null, 2)) + '</pre></details>' +
        boundary +
        '</div>';
    }
    function pendingActionDecisionButtons(action, info) {
      const buttons = [];
      if (action.status === 'pending') {
        buttons.push('<button class="primary" onclick="confirmPendingAction(\\'' + jsString(action.action_id) + '\\')">确认执行</button>');
        buttons.push('<button class="warn" onclick="rejectPendingAction(\\'' + jsString(action.action_id) + '\\')">拒绝</button>');
      }
      if (info.page) buttons.push('<button onclick="show(\\'' + jsString(info.page) + '\\')">去相关页面</button>');
      buttons.push(inspectButton('pendingAction', action.action_id, '详情'));
      return buttons.join('');
    }
    function pendingActionTargetText(action) {
      const payload = action.payload || {};
      const tool = String(action.tool || '');
      if (tool === 'request_register_media_artifact_from_import') return '导入文件：' + textOr(payload.import_filename, '未指定');
      if (tool === 'request_link_artifact_to_shot') return '镜头：' + textOr(payload.shot_id, '未指定');
      if (tool === 'request_validate_storyboard_package') return '分镜包校验';
      if (tool === 'request_import_storyboard_package') return '冻结当前 app-ready 分镜包';
      return tool || '未知目标';
    }
    function pendingActionHumanIntent(action) {
      const tool = String(action.tool || '');
      return ({
        request_register_media_artifact_from_import: '确认后会把导入图注册成本地 active storyboard_image Artifact。',
        request_link_artifact_to_shot: '确认后会把 Artifact 写入对应镜头字段。',
        request_validate_storyboard_package: '确认后只运行本地分镜包校验并写回执。',
        request_import_storyboard_package: '确认后会冻结当前 app-ready 分镜包，这是本地项目状态变更。'
      })[tool] || '这是一个需要人工确认的本地动作。';
    }
    function pendingActionSections(actions) {
      const list = actions || [];
      const pending = list.filter(action => action.status === 'pending');
      const failed = list.filter(action => action.status === 'failed');
      const executed = list.filter(action => action.status === 'executed');
      const rejected = list.filter(action => action.status === 'rejected');
      return [
        { key: 'pending', title: '待你决定', help: '这些动作还没有执行；只有点击确认后才会改本地项目状态。', actions: pending },
        { key: 'failed', title: '执行失败', help: '这些动作曾被确认，但执行没有成功，需要看错误原因。', actions: failed },
        { key: 'executed', title: '已执行', help: '这些动作已经执行过，卡片显示实际结果和报告。', actions: executed },
        { key: 'rejected', title: '已拒绝', help: '这些动作被人工拒绝，不会再执行。', actions: rejected }
      ].filter(section => section.actions.length > 0);
    }
    function renderPendingActionSection(section) {
      return '<div class="action-section panel">' +
        '<div class="import-batch-header">' +
        '<div class="import-batch-title"><h2>' + escapeHtml(section.title) + '</h2><div class="muted">' + escapeHtml(section.help) + '</div></div>' +
        statusPill(section.key === 'pending' ? 'warn' : section.key === 'failed' ? 'bad' : 'ok', String(section.actions.length) + ' 个') +
        '</div>' +
        '<div class="action-grid">' + section.actions.map(renderPendingActionCard).join('') + '</div>' +
        '</div>';
    }
    function renderPendingActionCard(action) {
      const info = pendingActionInfo(action);
      const fields = info.fields.map(row => '<div class="action-field"><b>' + escapeHtml(row[0]) + '</b><span>' + escapeHtml(row[1]) + '</span></div>').join('');
      return '<div class="action-card ' + escapeAttr(action.status || '') + '">' +
        '<div class="import-batch-header">' +
        '<div class="import-batch-title"><h3>' + escapeHtml(info.title) + '</h3><div class="muted">' + escapeHtml(relativeTimeText(action.created_at)) + '</div></div>' +
        statusPill(pendingActionPillKind(action), pendingActionStatusText(action)) +
        '</div>' +
        '<div class="action-fields">' + fields + '</div>' +
        '<div class="decision-bar">' + pendingActionButtons(action, info) + '</div>' +
        '<details class="draft-raw"><summary>查看技术字段</summary><pre>' + escapeHtml(JSON.stringify(action.payload || {}, null, 2)) + '</pre></details>' +
        '<div class="muted">' + escapeHtml(shortActionId(action.action_id)) + '</div>' +
        '</div>';
    }
    function pendingActionInfo(action) {
      const payload = action.payload || {};
      const tool = String(action.tool || '');
      const base = {
        title: pendingActionToolLabel(tool),
        page: 'dashboard',
        fields: []
      };
      if (tool === 'request_register_media_artifact_from_import') {
        base.page = 'imports';
        base.fields = [
          ['目标文件', textOr(payload.import_filename, '未指定')],
          ['确认后会做什么', '把这张导入图注册成 active storyboard_image Media Artifact'],
          ['会不会覆盖源文件', '不会'],
          ['会不会调用 Provider', '不会']
        ];
      } else if (tool === 'request_link_artifact_to_shot') {
        base.page = 'shots';
        base.fields = [
          ['目标镜头', textOr(payload.shot_id, '未指定')],
          ['目标 Artifact', textOr(payload.artifact_id, '未指定')],
          ['确认后会做什么', '把这个 Artifact 写入对应镜头的分镜图字段'],
          ['会不会调用 Provider', '不会']
        ];
      } else if (tool === 'request_validate_storyboard_package') {
        base.page = 'package';
        base.fields = [
          ['备注', textOr(payload.notes, '无')],
          ['确认后会做什么', '运行本地分镜包校验，并写执行回执'],
          ['会不会冻结分镜包', '不会，只校验'],
          ['会不会调用 Provider', '不会']
        ];
      } else if (tool === 'request_import_storyboard_package') {
        base.page = 'package';
        base.fields = [
          ['冻结理由', textOr(payload.reason, '未填写')],
          ['确认后会做什么', '准备、校验并冻结当前 app-ready 分镜包'],
          ['会不会调用 Provider', '不会'],
          ['注意', '这是本地项目状态变更，确认前请先检查分镜包页']
        ];
      } else {
        base.fields = [
          ['动作类型', tool || '未知'],
          ['内容摘要', compactJson(payload)]
        ];
      }
      base.fields.push(['执行结果', pendingExecutionText(action)]);
      return base;
    }
    function pendingActionToolLabel(tool) {
      return ({
        request_register_media_artifact_from_import: '注册导入图',
        request_link_artifact_to_shot: '绑定 Artifact 到镜头',
        request_validate_storyboard_package: '校验分镜包',
        request_import_storyboard_package: '冻结分镜包'
      })[tool] || tool || '未知动作';
    }
    function pendingActionPillKind(action) {
      if (action.status === 'pending') return 'warn';
      if (action.status === 'failed') return 'bad';
      if (action.status === 'rejected') return 'bad';
      return 'ok';
    }
    function pendingActionStatusText(action) {
      return ({
        pending: '等待你确认',
        executed: '已执行',
        rejected: '已拒绝',
        failed: '执行失败'
      })[action.status] || labelStatus(action.status);
    }
    function pendingExecutionText(action) {
      if (action.status === 'pending') return '尚未执行';
      if (action.status === 'rejected') return '已拒绝：' + textOr(action.human_confirmation && action.human_confirmation.rejected_reason, '未填写原因');
      if (action.status === 'failed') return '失败：' + textOr(action.execution && action.execution.error && action.execution.error.code, '未知错误');
      if (action.status === 'executed') return action.execution && action.execution.ok === true ? '执行成功' : '已尝试执行';
      return '未知';
    }
    function pendingActionButtons(action, info) {
      const buttons = [];
      if (action.status === 'pending') {
        buttons.push('<button class="primary" onclick="confirmPendingAction(\\'' + jsString(action.action_id) + '\\')">确认执行</button>');
        buttons.push('<button class="warn" onclick="rejectPendingAction(\\'' + jsString(action.action_id) + '\\')">拒绝</button>');
      }
      if (info.page) buttons.push('<button onclick="show(\\'' + jsString(info.page) + '\\')">去相关页面</button>');
      buttons.push(inspectButton('pendingAction', action.action_id, '详情'));
      const reportName = action.execution && action.execution.report_path ? reportNameFromPath(action.execution.report_path) : '';
      if (reportName) buttons.push('<button onclick="openReport(\\'' + jsString(reportName) + '\\')">打开回执</button>');
      return buttons.join('');
    }
    function reportNameFromPath(value) {
      const parts = String(value || '').split(/[\\\\/]/);
      return parts[parts.length - 1] || '';
    }
    function shortActionId(value) {
      const text = String(value || '');
      return text ? '动作 ID：' + text.replace(/^webgpt_action_/, '') : '动作 ID：无';
    }
    function renderShots() {
      const shots = model.state.shots || [];
      const pending = shots.filter(shot => shot.approval_status !== 'approved' && shot.approval_status !== 'revision_needed');
      const revision = shots.filter(shot => shot.approval_status === 'revision_needed');
      const approved = shots.filter(shot => shot.approval_status === 'approved');
      document.getElementById('shots').innerHTML =
        '<div class="page-head"><div><h2>镜头看板</h2><div class="page-kicker">每个 SHOT 是一张可编辑卡片，右侧抽屉负责看上下文。</div></div><div class="toolbar">' + statusPill('ok', String(approved.length) + ' 已批准') + statusPill(revision.length ? 'warn' : 'ok', String(revision.length) + ' 需修改') + '</div></div>' +
        '<div class="trello-board wide">' +
        renderShotList('待处理', '还没有批准或打回的镜头。', pending, 'warn') +
        renderShotList('需修改', '已经被标记为需要重新处理的镜头。', revision, 'bad') +
        renderShotList('已批准', '可进入分镜包和后续生成链路的镜头。', approved, 'ok') +
        '</div>';
    }
    function renderShotList(title, help, shots, kind) {
      const cards = (shots || []).map(shot => renderShotCard(shot, kind)).join('');
      return boardList(title, help, cards || emptyState('暂无镜头'), String((shots || []).length));
    }
    function renderShotCard(shot, kind) {
      const blockers = model.package && model.package.shots ? (model.package.shots.find(item => item.shot_id === shot.shot_id) || {}).blockers || [] : [];
      return '<div class="task-card">' +
        '<div class="card-labels">' + statusPill(kind, labelStatus(shot.approval_status)) + (blockers.length ? statusPill('bad', blockerText(blockers)) : statusPill('ok', '无阻断')) + '</div>' +
        '<h3>' + escapeHtml(shot.shot_id) + '</h3>' +
        '<label class="card-field"><b>秒数</b><input value="' + escapeAttr(String(shot.duration_seconds)) + '" onchange="saveShot(\\'' + jsString(shot.shot_id) + '\\', this, 0)"></label>' +
        '<label class="card-field"><b>描述</b><textarea onchange="saveShot(\\'' + jsString(shot.shot_id) + '\\', this, 1)">' + escapeHtml(shot.description) + '</textarea></label>' +
        '<label class="card-field"><b>视频提示词</b><textarea onchange="saveShot(\\'' + jsString(shot.shot_id) + '\\', this, 2)">' + escapeHtml(shot.video_prompt) + '</textarea></label>' +
        '<label class="card-field"><b>媒体 Artifact</b><input value="' + escapeAttr(shot.storyboard_image_artifact_id) + '" onchange="linkArtifact(\\'' + jsString(shot.shot_id) + '\\', this.value)"></label>' +
        '<div class="card-actions"><button class="primary" onclick="approveShot(\\'' + jsString(shot.shot_id) + '\\')">批准</button><button class="warn" onclick="revisionShot(\\'' + jsString(shot.shot_id) + '\\')">需修改</button>' + inspectButton('shot', shot.shot_id, '详情') + '</div>' +
        '</div>';
    }
    function renderPackage() {
      const pkg = model.package;
      const ready = (pkg.shots || []).filter(shot => !(shot.blockers || []).length);
      const blocked = (pkg.shots || []).filter(shot => (shot.blockers || []).length);
      document.getElementById('package').innerHTML =
        '<div class="page-head"><div><h2>分镜包</h2><div class="page-kicker">准备、校验、冻结都在这里；冻结是本地项目状态变更，需要你点击。</div></div><div class="toolbar"><button onclick="preparePackageProject()">准备项目</button><button onclick="validatePackage()">校验</button><button class="primary" onclick="freezePackage()">冻结</button></div></div>' +
        '<div class="summary">' +
        metric('校验', pkg.validation && pkg.validation.ok ? '通过' : '未通过') +
        metric('可用 SHOT', String(ready.length)) +
        metric('阻断 SHOT', String(blocked.length)) +
        metric('冻结历史', String((pkg.history || []).length)) +
        '</div>' +
        validationPanel(pkg.validation) +
        '<div class="trello-board">' +
        boardList('可进入分镜包', '这些 SHOT 没有当前阻断项。', ready.map(renderPackageShotCard).join('') || emptyState('暂无可用 SHOT'), String(ready.length)) +
        boardList('需要处理', '这些 SHOT 仍有批准、Artifact 或素材问题。', blocked.map(renderPackageShotCard).join('') || emptyState('暂无阻断 SHOT'), String(blocked.length)) +
        boardList('冻结历史', '最近的本地冻结记录。', '<pre>' + escapeHtml(historyText(pkg.history)) + '</pre>', String((pkg.history || []).length)) +
        '</div>';
    }
    function renderPackageShotCard(shot) {
      return '<div class="task-card">' +
        '<div class="card-labels">' + statusPill((shot.blockers || []).length ? 'bad' : 'ok', (shot.blockers || []).length ? '阻断' : '可用') + statusPill(shot.approval_status === 'approved' ? 'ok' : 'warn', labelStatus(shot.approval_status)) + '</div>' +
        '<h3>' + escapeHtml(shot.shot_id) + '</h3>' +
        '<div class="card-fields">' +
        cardField('Storyboard Artifact', shot.storyboard_image_artifact_id || '无') +
        cardField('Artifact 状态', shot.artifact ? labelStatus(shot.artifact.status) : '无') +
        cardField('阻断项', blockerText(shot.blockers || [])) +
        '</div>' +
        '<div class="card-actions">' + inspectButton('shot', shot.shot_id, '详情') + '<button onclick="show(\\'shots\\')">去镜头页</button></div>' +
        '</div>';
    }
    function renderReview() {
      const review = model.review || { generated_clips: [], regeneration_request_drafts: [], provider_boundary: {} };
      const clips = review.generated_clips || [];
      const selected = selectedReviewClip(clips);
      const queue = reviewClipQueue(clips);
      const counts = reviewClipCounts(clips);
      const filteredTotal = Number(review.generated_clip_filtered_available || review.generated_clip_total_available || queue.length);
      const totalAvailable = Number(review.generated_clip_total_available || filteredTotal);
      const offset = Number(review.generated_clip_offset || 0);
      const shownStart = queue.length ? offset + 1 : 0;
      const shownEnd = offset + queue.length;
      document.getElementById('review').innerHTML =
        '<div class="page-head"><div><h2>审片工作区</h2><div class="page-kicker">逐个检查 generated_clip，采纳进入最终合成，拒绝则写重生成草案。</div></div><div class="toolbar">' + statusPill(review.generated_clips.length ? 'warn' : 'ok', String(shownStart) + '-' + String(shownEnd) + ' / ' + String(filteredTotal)) + statusPill('ok', '总 ' + String(totalAvailable)) + statusPill('ok', '本地确认') + '</div></div>' +
        '<div class="summary">' +
        metric('待审', String(review.generated_clip_status_counts ? review.generated_clip_status_counts.pending : counts.pending)) +
        metric('已采纳', String(review.generated_clip_status_counts ? review.generated_clip_status_counts.approved : counts.approved)) +
        metric('已拒绝', String(review.generated_clip_status_counts ? review.generated_clip_status_counts.rejected : counts.rejected)) +
        metric('重生成草案', String((review.regeneration_request_drafts || []).length)) +
        '</div>' +
        '<div class="review-workbench">' +
        '<div class="review-queue panel"><div class="board-list-header"><div><h2>Clip 队列</h2><div class="board-list-help">按分类从完整审片池筛查；点击只切换播放器。</div></div>' + statusPill('ok', String(queue.length)) + '</div>' + renderReviewFilters(review, filteredTotal, offset, queue.length) + '<div class="review-queue-list">' + (queue.map(item => renderReviewQueueCard(item, selected)).join('') || emptyState('暂无 generated_clip 可审')) + '</div></div>' +
        '<div class="review-player panel">' + renderSelectedReviewPlayer(selected, clips) + '</div>' +
        '<div class="review-evidence panel">' + renderSelectedReviewEvidence(selected, review) + '</div>' +
        '</div>';
    }
    function renderReviewFilters(review, filteredTotal, offset, currentCount) {
      const statusCounts = review.generated_clip_status_counts || { all: filteredTotal, pending: 0, approved: 0, rejected: 0 };
      const status = (review.generated_clip_filters && review.generated_clip_filters.status) || reviewStatusFilter || 'all';
      const shotId = (review.generated_clip_filters && review.generated_clip_filters.shot_id) || reviewShotFilter || '';
      const statuses = [
        ['all', '全部', statusCounts.all],
        ['pending', '待审', statusCounts.pending],
        ['approved', '已采纳', statusCounts.approved],
        ['rejected', '已拒绝', statusCounts.rejected]
      ];
      const tabs = statuses.map(item => '<button class="' + (status === item[0] ? 'active' : '') + '" onclick="setReviewStatusFilter(\\'' + jsString(item[0]) + '\\')">' + escapeHtml(item[1]) + ' ' + escapeHtml(String(item[2])) + '</button>').join('');
      const shotOptions = ['<option value="">全部 SHOT</option>'].concat((review.generated_clip_shot_counts || []).map(item => '<option value="' + escapeAttr(item.shot_id) + '" ' + (shotId === item.shot_id ? 'selected' : '') + '>' + escapeHtml(shortShotId(item.shot_id) + ' · ' + String(item.count)) + '</option>')).join('');
      const shotTotal = Number(review.generated_clip_shot_count_total || (review.generated_clip_shot_counts || []).length);
      const canPrev = offset > 0;
      const canNext = offset + currentCount < filteredTotal;
      return '<div class="review-filters">' +
        '<div class="review-filter-tabs">' + tabs + '</div>' +
        '<div class="review-filter-row"><select onchange="setReviewShotFilter(this.value)">' + shotOptions + '</select><button onclick="resetReviewFilters()">重置</button></div>' +
        '<div class="review-page-controls"><button onclick="changeReviewPage(-1)" ' + (canPrev ? '' : 'disabled') + '>上一页</button><button onclick="changeReviewPage(1)" ' + (canNext ? '' : 'disabled') + '>下一页</button></div>' +
        '<div class="muted">' + escapeHtml(String(currentCount ? offset + 1 : 0)) + '-' + escapeHtml(String(offset + currentCount)) + ' / ' + escapeHtml(String(filteredTotal)) + ' · SHOT ' + escapeHtml(String((review.generated_clip_shot_counts || []).length)) + '/' + escapeHtml(String(shotTotal)) + '</div>' +
        '</div>';
    }
    async function refreshReview() {
      const response = await fetch('/api/review' + reviewQueryString());
      const payload = await response.json();
      if (payload && payload.ok && payload.review) {
        model.review = payload.review;
        renderReview();
        renderNavBadges();
      }
    }
    async function setReviewStatusFilter(status) {
      reviewStatusFilter = String(status || 'all');
      reviewOffset = 0;
      selectedReviewClipId = '';
      window.localStorage.setItem('h1ReviewStatusFilter', reviewStatusFilter);
      window.localStorage.setItem('h1ReviewOffset', '0');
      window.localStorage.removeItem('h1SelectedReviewClipId');
      await refreshReview();
    }
    async function setReviewShotFilter(shotId) {
      reviewShotFilter = String(shotId || '');
      reviewOffset = 0;
      selectedReviewClipId = '';
      window.localStorage.setItem('h1ReviewShotFilter', reviewShotFilter);
      window.localStorage.setItem('h1ReviewOffset', '0');
      window.localStorage.removeItem('h1SelectedReviewClipId');
      await refreshReview();
    }
    async function resetReviewFilters() {
      reviewStatusFilter = 'all';
      reviewShotFilter = '';
      reviewOffset = 0;
      selectedReviewClipId = '';
      window.localStorage.setItem('h1ReviewStatusFilter', reviewStatusFilter);
      window.localStorage.setItem('h1ReviewShotFilter', reviewShotFilter);
      window.localStorage.setItem('h1ReviewOffset', '0');
      window.localStorage.removeItem('h1SelectedReviewClipId');
      await refreshReview();
    }
    async function changeReviewPage(delta) {
      const review = model.review || {};
      const filteredTotal = Number(review.generated_clip_filtered_available || 0);
      reviewOffset = Math.max(0, Math.min(Math.max(0, filteredTotal - 1), reviewOffset + Number(delta || 0) * reviewPageSize));
      window.localStorage.setItem('h1ReviewOffset', String(reviewOffset));
      selectedReviewClipId = '';
      window.localStorage.removeItem('h1SelectedReviewClipId');
      await refreshReview();
    }
    function reviewClipCounts(clips) {
      return {
        pending: (clips || []).filter(item => !item.clip_review_status || item.clip_review_status === 'pending' || item.clip_review_status === 'proposed').length,
        approved: (clips || []).filter(item => item.clip_review_status === 'approved').length,
        rejected: (clips || []).filter(item => item.clip_review_status === 'rejected').length
      };
    }
    function reviewClipQueue(clips) {
      return [...(clips || [])].sort((a, b) => reviewClipRank(a) - reviewClipRank(b) || String(a.shot_id || '').localeCompare(String(b.shot_id || '')) || String(a.artifact_id || '').localeCompare(String(b.artifact_id || '')));
    }
    function reviewClipRank(clip) {
      if (!clip || clip.ffprobe && clip.ffprobe.status && clip.ffprobe.status !== 'PASS') return 0;
      if (!clip.clip_review_status || clip.clip_review_status === 'pending' || clip.clip_review_status === 'proposed') return 1;
      if (clip.clip_review_status === 'rejected') return 2;
      if (clip.clip_review_status === 'approved') return 3;
      return 4;
    }
    function selectedReviewClip(clips) {
      const current = (clips || []).find(item => item.artifact_id === selectedReviewClipId);
      const next = current || reviewClipQueue(clips)[0] || null;
      if (next && selectedReviewClipId !== next.artifact_id) {
        selectedReviewClipId = next.artifact_id;
        window.localStorage.setItem('h1SelectedReviewClipId', selectedReviewClipId);
      }
      return next;
    }
    function selectReviewClip(artifactId) {
      const queue = document.querySelector('.review-queue-list');
      const player = document.querySelector('.review-player-body');
      const evidence = document.querySelector('.review-evidence-body');
      const positions = {
        queueScrollTop: queue ? queue.scrollTop : 0,
        playerScrollTop: player ? player.scrollTop : 0,
        evidenceScrollTop: evidence ? evidence.scrollTop : 0
      };
      selectedReviewClipId = String(artifactId || '');
      window.localStorage.setItem('h1SelectedReviewClipId', selectedReviewClipId);
      renderReview();
      restoreReviewScrollPositions(positions);
    }
    function restoreReviewScrollPositions(positions) {
      const nextQueue = document.querySelector('.review-queue-list');
      const nextPlayer = document.querySelector('.review-player-body');
      const nextEvidence = document.querySelector('.review-evidence-body');
      if (nextQueue) nextQueue.scrollTop = positions.queueScrollTop || 0;
      if (nextPlayer) nextPlayer.scrollTop = positions.playerScrollTop || 0;
      if (nextEvidence) nextEvidence.scrollTop = positions.evidenceScrollTop || 0;
      window.requestAnimationFrame(() => {
        const rafQueue = document.querySelector('.review-queue-list');
        const rafPlayer = document.querySelector('.review-player-body');
        const rafEvidence = document.querySelector('.review-evidence-body');
        if (rafQueue) rafQueue.scrollTop = positions.queueScrollTop || 0;
        if (rafPlayer) rafPlayer.scrollTop = positions.playerScrollTop || 0;
        if (rafEvidence) rafEvidence.scrollTop = positions.evidenceScrollTop || 0;
      });
    }
    function renderReviewQueueCard(item, selected) {
      const risk = reviewClipRisk(item);
      const selectedClass = selected && selected.artifact_id === item.artifact_id ? ' selected' : '';
      const statusClass = item.clip_review_status === 'approved' ? ' approved' : item.clip_review_status === 'rejected' ? ' rejected' : risk.kind === 'bad' ? ' failed' : '';
      return '<button class="review-queue-card' + selectedClass + statusClass + '" onclick="selectReviewClip(\\'' + jsString(item.artifact_id) + '\\')">' +
        '<div class="review-queue-meta">' + statusPill(risk.kind, risk.text) + statusPill(item.ffprobe && item.ffprobe.status === 'PASS' ? 'ok' : 'bad', item.ffprobe ? 'ffprobe ' + item.ffprobe.status : '未测试') + '</div>' +
        '<h3>' + escapeHtml(item.shot_id || '未绑定 SHOT') + '</h3>' +
        '<div class="muted">' + escapeHtml(reviewClipIntent(item)) + '</div>' +
        '<div class="muted">' + escapeHtml(shortArtifact(item.artifact_id)) + ' · ' + escapeHtml(reviewClipDuration(item)) + '</div>' +
        '</button>';
    }
    function renderSelectedReviewPlayer(clip, clips) {
      if (!clip) return '<div class="board-list-header"><div><h2>播放器</h2><div class="board-list-help">暂无可审 clip。</div></div></div>' + emptyState('暂无 generated_clip 可审');
      const risk = reviewClipRisk(clip);
      const siblings = (clips || []).filter(item => item.shot_id === clip.shot_id);
      const duration = clip.ffprobe && clip.ffprobe.duration_seconds ? Number(clip.ffprobe.duration_seconds) : 0;
      const timelineWidth = duration > 0 ? 100 : 0;
      return '<div class="review-player-title"><div><h2>' + escapeHtml(clip.shot_id || '未绑定 SHOT') + '</h2><div class="board-list-help">' + escapeHtml(clip.artifact_id || '') + '</div></div>' + statusPill(risk.kind, risk.text) + '</div>' +
        '<div class="review-player-body">' +
        '<div class="review-player-media">' + mediaPreview(clip.artifact_id, 'video') +
        '<div class="review-timeline"><div class="review-timeline-track"><span class="review-timeline-fill" style="width:' + String(timelineWidth) + '%"></span></div><div class="review-timeline-labels"><span>00:00</span><span>' + escapeHtml(reviewClipDuration(clip)) + '</span></div></div></div>' +
        '<div class="decision-bar review-player-actions"><button class="primary" onclick="approveClip(\\'' + jsString(clip.shot_id) + '\\',\\'' + jsString(clip.artifact_id) + '\\')">采纳这个 clip</button><button class="danger" onclick="rejectClip(\\'' + jsString(clip.shot_id) + '\\',\\'' + jsString(clip.artifact_id) + '\\')">拒绝并写重生成草案</button>' + inspectButton('clip', clip.artifact_id, '详情') + '</div>' +
        '<div class="review-player-facts">' + keyValueTable('当前片段', [
          ['审片状态', labelStatus(clip.clip_review_status) || '待处理'],
          ['ffprobe', clip.ffprobe ? clip.ffprobe.status : '未测试'],
          ['时长', reviewClipDuration(clip)],
          ['已采纳 Clip', clip.accepted_clip_artifact_id || '无']
        ]) + '</div>' +
        '<div class="review-version-strip"><div class="board-list-header"><div><h3>同 SHOT 版本</h3><div class="board-list-help">把版本关系放在播放器旁边，避免在卡片墙里找片。</div></div>' + statusPill('ok', String(siblings.length)) + '</div>' + siblings.map(item => renderReviewVersionCard(item, clip)).join('') + '</div>' +
        '</div>';
    }
    function renderReviewVersionCard(item, selected) {
      const risk = reviewClipRisk(item);
      const selectedClass = selected && selected.artifact_id === item.artifact_id ? ' selected' : '';
      const statusClass = item.clip_review_status === 'approved' ? ' approved' : item.clip_review_status === 'rejected' ? ' rejected' : '';
      return '<button class="review-version-card' + selectedClass + statusClass + '" onclick="selectReviewClip(\\'' + jsString(item.artifact_id) + '\\')">' +
        '<div class="review-version-meta">' + statusPill(risk.kind, risk.text) + statusPill(item.provider_name ? 'ok' : 'warn', item.provider_name || 'unknown') + '</div>' +
        '<div><b>' + escapeHtml(shortArtifact(item.artifact_id)) + '</b><div class="muted">' + escapeHtml(item.run_id || '无 run_id') + '</div></div>' +
        '</button>';
    }
    function renderSelectedReviewEvidence(clip, review) {
      if (!clip) return '<div class="board-list-header"><div><h2>证据</h2><div class="board-list-help">暂无片段证据。</div></div></div>';
      const shotDrafts = (review.regeneration_request_drafts || []).filter(item => item.shot_id === clip.shot_id || item.artifact_id === clip.artifact_id);
      const revision = clip.latest_revision_instruction || {};
      const rejectionReasons = (clip.rejection_reasons || []).join('，') || '无';
      return '<div class="board-list-header"><div><h2>批注与证据</h2><div class="board-list-help">把判断依据放在审批动作旁边，而不是藏进 inspector。</div></div>' + statusPill('ok', String(shotDrafts.length) + ' 草案') + '</div>' +
        '<div class="review-evidence-body">' +
        keyValueTable('来源证据', [
          ['Generation Run', clip.run_id || '无'],
          ['Run 状态', clip.run_status || '未知'],
          ['Run 类型', clip.run_type || '未知'],
          ['Provider', clip.provider_name || 'unknown'],
          ['Provider Job', clip.provider_job_id || '无'],
          ['文件', clip.storage_filename || '无']
        ]) +
        keyValueTable('审片记录', [
          ['状态', labelStatus(clip.clip_review_status) || '待处理'],
          ['拒绝原因', rejectionReasons],
          ['重做摘要', revision.summary || '无'],
          ['Prompt 增量', revision.prompt_delta || '无'],
          ['Negative 增量', revision.negative_delta || '无'],
          ['优先级', revision.priority || '无']
        ]) +
        '<details open><summary>本 SHOT 重生成草案</summary><pre>' + escapeHtml(draftText(shotDrafts)) + '</pre></details>' +
        '<details><summary>Provider 边界</summary>' + boundaryTable(review.provider_boundary || {}) + '</details>' +
        '<details><summary>Raw clip payload</summary><pre>' + escapeHtml(compactJson(clip)) + '</pre></details>' +
        '</div>';
    }
    function reviewClipRisk(clip) {
      if (!clip) return { kind: 'warn', text: '未选择' };
      if (clip.ffprobe && clip.ffprobe.status && clip.ffprobe.status !== 'PASS') return { kind: 'bad', text: '视频异常' };
      if (clip.clip_review_status === 'approved') return { kind: 'ok', text: '已采纳' };
      if (clip.clip_review_status === 'rejected') return { kind: 'bad', text: '已拒绝' };
      return { kind: 'warn', text: '待审' };
    }
    function reviewClipIntent(clip) {
      if (!clip) return '';
      if (clip.ffprobe && clip.ffprobe.status && clip.ffprobe.status !== 'PASS') return '先处理视频可用性，再做创意判断';
      if (clip.clip_review_status === 'approved') return '已进入最终合成候选';
      if (clip.clip_review_status === 'rejected') return '查看拒绝原因与重生成草案';
      return '等待人类看片决策';
    }
    function reviewClipDuration(clip) {
      const duration = clip && clip.ffprobe && clip.ffprobe.duration_seconds ? Number(clip.ffprobe.duration_seconds) : 0;
      return duration ? String(duration) + ' 秒' : '时长未知';
    }
    function shortArtifact(value) {
      const text = String(value || '');
      return text.length > 18 ? text.slice(0, 12) + '...' + text.slice(-6) : text || '无 Artifact';
    }
    function shortShotId(value) {
      const text = String(value || '');
      return text.length > 20 ? text.slice(0, 15) + '...' + text.slice(-6) : text || '无 SHOT';
    }
    function renderAssembly() {
      const assembly = model.assembly || { clip_order_preview: [], blockers: [], provider_boundary: {}, confirmation: {} };
      const finalReview = model.final_review || { final_video: null, source_clips: [], review_package: null };
      const finalReviewProject = finalReview.project || {};
      const sourceCards = assembly.clip_order_preview.map(item => '<div class="clip-card">' +
        (item.accepted_clip_artifact_id ? mediaPreview(item.accepted_clip_artifact_id, 'video') : emptyState('未采纳 clip')) +
        '<h3>' + escapeHtml(String(item.order)) + '. ' + escapeHtml(item.shot_id) + '</h3>' +
        '<div class="decision-bar">' +
        statusPill(item.ffprobe && item.ffprobe.status === 'PASS' ? 'ok' : 'bad', item.ffprobe ? 'ffprobe ' + item.ffprobe.status : '未测试') +
        statusPill(item.blockers && item.blockers.length ? 'bad' : 'ok', item.blockers && item.blockers.length ? blockerText(item.blockers) : '可用') +
        '</div>' +
        '<div class="muted">' + escapeHtml(item.accepted_clip_artifact_id || '') + '</div>' +
        '</div>').join('');
      const finalArtifact = assembly.final_video_artifact;
      const finalReviewVideo = finalReview.final_video;
      const finalArtifactId = finalArtifact ? finalArtifact.artifact_id : finalReviewVideo ? finalReviewVideo.artifact_id : '';
      const finalSourceCards = sourceCards || (finalReview.source_clips || []).map(item => '<div class="clip-card">' +
        (item.artifact_id ? mediaPreview(item.artifact_id, 'video') : emptyState('未绑定 source clip')) +
        '<h3>' + escapeHtml(String(item.order)) + '. ' + escapeHtml(item.shot_id) + '</h3>' +
        '<div class="decision-bar">' + statusPill(item.ffprobe_status === 'PASS' ? 'ok' : 'bad', item.ffprobe_status || '未测试') + '</div>' +
        '<div class="muted">' + escapeHtml(item.artifact_id || '') + '</div>' +
        '</div>').join('');
      const finalPanel = finalArtifact ? '<div class="panel">' +
        '<h2>最终视频</h2>' +
        mediaPreview(finalArtifact.artifact_id, 'video') +
        keyValueTable('Final Artifact', [
          ['Artifact ID', finalArtifact.artifact_id],
          ['存在', yesNo(Boolean(finalArtifact.exists))],
          ['类型', finalArtifact.artifact_type + '/' + finalArtifact.role],
          ['状态', labelStatus(finalArtifact.status)],
          ['文件', finalArtifact.storage_filename],
          ['ffprobe', finalArtifact.ffprobe ? finalArtifact.ffprobe.status : '未测试']
        ]) +
        reportButtons([latestReport('r3_9p_final_video_review_package_result.json'), latestReport('r3_9o_final_video_assembly_execution_result.json')]) +
        '</div>' : finalReviewVideo ? '<div class="panel"><h2>最终视频</h2>' +
        mediaPreview(finalReviewVideo.artifact_id, 'video') +
        keyValueTable('Final Review', [
          ['Artifact ID', finalReviewVideo.artifact_id],
          ['存在', yesNo(Boolean(finalReviewVideo.local_video_exists))],
          ['ffprobe', finalReviewVideo.ffprobe && finalReviewVideo.ffprobe.status ? finalReviewVideo.ffprobe.status : '未测试'],
          ['时长', finalReviewVideo.ffprobe && finalReviewVideo.ffprobe.duration_seconds ? String(finalReviewVideo.ffprobe.duration_seconds) + ' 秒' : '未知'],
          ['审查包', finalReview.review_package ? finalReview.review_package.status : '无'],
          ['报告', finalReview.report_exists ? finalReview.report_path : '无']
        ]) +
        reportButtons([latestReport('r3_9p_final_video_review_package_result.json'), latestReport('r3_9o_final_video_assembly_execution_result.json')]) +
        '</div>' : '<div class="panel">' + emptyState('最终视频尚未合成') + '</div>';
      document.getElementById('assembly').innerHTML = '<div class="toolbar"><button class="primary" onclick="assembleFinal()" ' + (assembly.ready_for_assembly ? '' : 'disabled') + '>确认合成</button>' +
        (assembly.latest_report_exists ? '<button onclick="openReport(\\'h4_final_assembly_result.json\\')">打开合成报告</button>' : '<button disabled>暂无合成报告</button>') + '</div>' +
        '<div class="summary">' +
        metric('项目', assembly.project_title || finalReviewProject.project_title || assembly.project_id || '未找到') +
        metric('可合成', yesNo(Boolean(assembly.ready_for_assembly))) +
        metric('已采纳 Clip', String(assembly.accepted_clips || (finalReview.source_clips || []).length || 0) + '/' + String(assembly.required_shots || (finalReview.source_clips || []).length || 0)) +
        metric('阻断项', String((assembly.blockers || []).length)) +
        '</div>' +
        keyValueTable('合成硬门', [
          ['项目 ID', assembly.project_id || '无'],
          ['项目状态', assembly.project_status || '未知'],
          ['需要人类确认', assembly.confirmation && assembly.confirmation.required ? '是' : '否'],
          ['阻断项', blockerText(assembly.blockers || [])],
          ['报告路径', assembly.latest_report_exists ? assembly.latest_report_path : '暂无']
        ]) +
        finalPanel +
        '<div class="panel"><h2>合成输入</h2><div class="media-strip">' + (finalSourceCards || emptyState('暂无合成输入')) + '</div></div>' +
        boundaryTable(assembly.provider_boundary || {});
    }
    function renderFinalReview() {
      const finalReview = model.final_review || { final_video: null, source_clips: [], review_package: null, decision_report: null, provider_boundary: {} };
      const finalVideo = finalReview.final_video;
      const decisionReport = finalReview.decision_report;
      const tableDecision = finalReview.table_decision || {};
      const sourceCards = (finalReview.source_clips || []).map(item => '<div class="clip-card">' +
        (item.artifact_id ? mediaPreview(item.artifact_id, 'video') : emptyState('未绑定 source clip')) +
        '<h3>' + escapeHtml(String(item.order)) + '. ' + escapeHtml(item.shot_id) + '</h3>' +
        '<div class="decision-bar">' + statusPill(item.ffprobe_status === 'PASS' ? 'ok' : 'bad', item.ffprobe_status || '未测试') + statusPill('warn', String(item.duration_seconds || 0) + ' 秒') + '</div>' +
        '<div class="muted">' + escapeHtml(item.artifact_id || '') + '</div>' +
        '</div>').join('');
      const decisionPanel = decisionReport
        ? '<div class="panel"><h2>最终决策已记录</h2>' + keyValueTable('R3-9Q', [
            ['结果', decisionReport.result],
            ['决策', labelDecision(decisionReport.decision)],
            ['审查人', decisionReport.reviewer],
            ['时间', decisionReport.generated_at],
            ['备注', decisionReport.note || '无'],
            ['报告', decisionReport.report_path]
          ]) + '<div class="toolbar"><button onclick="openReport(\\'r3_9q_final_video_review_decision_result.json\\')">打开决策报告</button></div></div>'
        : '<div class="panel"><h2>记录最终决策</h2>' +
          keyValueTable('表格识别', [
            ['来源', tableDecision.source_path || '未检测到'],
            ['选择数量', String(tableDecision.decision_count || 0)],
            ['识别决策', tableDecision.decision ? labelDecision(tableDecision.decision) : '未识别'],
            ['审查人', tableDecision.reviewer || '未填写']
          ]) +
          '<div class="grid">' +
          '<label class="span-4">决策<select id="final_decision">' + decisionOptions(tableDecision.decision || '') + '</select></label>' +
          '<label class="span-4">审查人<input id="final_reviewer" placeholder="Jenn" value="' + escapeAttr(tableDecision.reviewer || '') + '"></label>' +
          '<label class="span-12">备注<textarea id="final_note" placeholder="接受可留空；拒绝或请求修订必须写明原因">' + escapeHtml(tableDecision.note || '') + '</textarea></label>' +
          '</div>' +
          '<div class="decision-bar"><button class="primary" onclick="submitFinalDecision()">写入本地最终决策报告</button><button onclick="openReport(\\'r3_9p_final_video_review_package_result.json\\')">打开审查包报告</button></div>' +
          '</div>';
      document.getElementById('finalReview').innerHTML =
        '<div class="summary">' +
        metric('审查包', finalReview.result || '未知') +
        metric('最终决策', decisionReport ? labelDecision(decisionReport.decision) : '未记录') +
        metric('表格选择', tableDecision.decision ? labelDecision(tableDecision.decision) : '未识别') +
        metric('来源 Clip', String((finalReview.source_clips || []).length)) +
        '</div>' +
        '<div class="grid">' +
        '<div class="panel span-7"><h2>最终成片</h2>' + (finalVideo ? mediaPreview(finalVideo.artifact_id, 'video') : emptyState('没有最终视频')) +
        keyValueTable('成片事实', [
          ['Artifact ID', finalVideo ? finalVideo.artifact_id : '无'],
          ['文件存在', finalVideo ? yesNo(Boolean(finalVideo.local_video_exists)) : '否'],
          ['ffprobe', finalVideo && finalVideo.ffprobe ? finalVideo.ffprobe.status || '未知' : '未知'],
          ['时长', finalVideo && finalVideo.ffprobe && finalVideo.ffprobe.duration_seconds ? String(finalVideo.ffprobe.duration_seconds) + ' 秒' : '未知'],
          ['报告', finalReview.report_exists ? finalReview.report_path : '无']
        ]) + '</div>' +
        '<div class="span-5">' + decisionPanel + '</div>' +
        '<div class="panel span-12"><h2>来源片段</h2><div class="media-strip">' + (sourceCards || emptyState('暂无来源 clip')) + '</div></div>' +
        '<div class="panel span-12"><h2>边界</h2>' + boundaryTable(finalReview.provider_boundary || {}) + '</div>' +
        '</div>';
    }
    function renderMemory() {
      const memory = model.memory || { latest_proposal: null, memory_items: [], assets: [], references: [], recall_packs: [], boundary: {} };
      const proposal = memory.latest_proposal;
      const proposalRows = proposal ? proposal.items.map(item => '<tr><td>' + escapeHtml(item.item_type) + '<br>' + escapeHtml(labelStatus(item.status)) + '</td><td><input id="memory_title_' + jsString(item.item_id) + '" value="' + escapeAttr(item.title) + '"><textarea id="memory_content_' + jsString(item.item_id) + '">' + escapeHtml(item.content) + '</textarea></td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td><td><select id="memory_decision_' + jsString(item.item_id) + '"><option value="ignore">不处理</option><option value="approve">批准</option><option value="reject">拒绝</option></select><input id="memory_reject_' + jsString(item.item_id) + '" placeholder="拒绝原因"></td></tr>').join('') : '';
      const memoryRows = (memory.memory_items || []).map(item => '<tr><td>' + escapeHtml(item.memory_item_id) + '</td><td>' + escapeHtml(item.title) + '</td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td></tr>').join('');
      const assetRows = (memory.assets || []).map(item => '<tr><td>' + escapeHtml(item.asset_id) + '</td><td>' + escapeHtml(item.title) + '</td><td>' + escapeHtml(item.artifact_id) + '</td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td></tr>').join('');
      const referenceRows = (memory.references || []).map(item => '<tr><td>' + escapeHtml(item.reference_id) + '</td><td>' + escapeHtml(item.title) + '</td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td></tr>').join('');
      const recallRows = (memory.recall_packs || []).map(item => '<tr><td>' + escapeHtml(item.recall_pack_id) + '</td><td>' + escapeHtml(item.project_id) + '</td><td>' + escapeHtml(item.generated_at) + '</td></tr>').join('');
      document.getElementById('memory').innerHTML =
        '<div class="page-head"><div><h2>记忆资产</h2><div class="page-kicker">本地 Memory / Asset / Reference 的回存与召回，不写外部长期记忆。</div></div><div class="toolbar">' +
        (proposal ? '<button class="primary" onclick="confirmMemoryProposal()">确认回存选择</button><button onclick="generateRecallPack()">生成 Recall Pack</button>' : '<button disabled>暂无 Saveback Proposal</button>') +
        '</div></div><div class="summary">' +
        metric('Proposal', String(memory.proposals_total || 0)) +
        metric('Memory', String(memory.memory_items_total || 0)) +
        metric('Asset', String(memory.assets_total || 0)) +
        metric('Reference', String(memory.references_total || 0)) +
        '</div>' +
        keyValueTable('当前 Proposal', [
          ['Proposal ID', proposal ? proposal.proposal_id : '无'],
          ['项目', proposal ? proposal.project_title : '无'],
          ['状态', proposal ? labelStatus(proposal.status) : '无'],
          ['长期记忆写入', proposal && proposal.long_term_memory_write_attempted ? '是' : '否']
        ]) +
        '<table><thead><tr><th>类型/状态</th><th>内容</th><th>溯源</th><th>决定</th></tr></thead><tbody>' + proposalRows + '</tbody></table>' +
        '<div class="split">' +
        '<table><thead><tr><th>Memory Item</th><th>标题</th><th>溯源</th></tr></thead><tbody>' + memoryRows + '</tbody></table>' +
        '<table><thead><tr><th>Asset</th><th>标题</th><th>Artifact</th><th>溯源</th></tr></thead><tbody>' + assetRows + '</tbody></table>' +
        '</div>' +
        '<div class="split">' +
        '<table><thead><tr><th>Reference</th><th>标题</th><th>溯源</th></tr></thead><tbody>' + referenceRows + '</tbody></table>' +
        '<table><thead><tr><th>Recall Pack</th><th>项目</th><th>生成时间</th></tr></thead><tbody>' + recallRows + '</tbody></table>' +
        '</div>' +
        boundaryTable(memory.boundary || {});
    }
    function renderCanary() {
      const canary = model.canary;
      const input = canary.selected_input || {};
      const boundary = canary.provider_boundary || {};
      const plan = canary.dry_run_plan || {};
      const authorization = canary.authorization || {};
      const reportButton = plan.can_open_latest_report ? '<button onclick="openReport(\\'m1_r0_runway_canary_dry_run_report.json\\')">打开 dry-run 计划</button>' : '<button disabled>暂无 dry-run 计划</button>';
      document.getElementById('canary').innerHTML =
        '<div class="page-head"><div><h2>金丝雀</h2><div class="page-kicker">真实 provider 提交前的 dry-run / 授权 / 边界检查区。</div></div><div class="toolbar">' + reportButton + '<button disabled>真实提交需单独授权</button></div></div>' +
        '<div class="summary">' +
        metric('Provider', canary.active_provider || '未就绪') +
        metric('Env Check', canary.env_check_result) +
        metric('Preflight', canary.provider_preflight_result) +
        metric('Runway Ratio', input.runway_ratio || boundary.runway_ratio || '未就绪') +
        '</div>' +
        '<div class="split">' +
        keyValueTable('金丝雀输入', [
          ['图片', input.path || '未选择'],
          ['来源', input.source_type || '未标记'],
          ['尺寸', (input.width || 0) + 'x' + (input.height || 0)],
          ['项目比例', input.aspect_ratio || '未知'],
          ['Runway ratio', input.runway_ratio || '未知'],
          ['时长', String(input.duration_seconds || 0) + ' 秒'],
          ['图片可读', yesNo(Boolean(input.readable))],
          ['可用于真实 canary', yesNo(Boolean(input.usable_for_real_provider_canary))]
        ]) +
        keyValueTable('提交边界', [
          ['Endpoint', boundary.endpoint || '未知'],
          ['X-Runway-Version', boundary.x_runway_version || '未知'],
          ['最大提交次数', String(boundary.max_submit_calls || 0)],
          ['credential env', canary.credential_env_name || '未设置'],
          ['credential present', yesNo(Boolean(canary.credential_present))],
          ['重新生成', plan.regeneration_allowed ? '允许' : '禁止'],
          ['批量生成', plan.batch_generation_allowed ? '允许' : '禁止'],
          ['RunningHub', plan.runninghub_allowed ? '允许' : '禁止']
        ]) +
        '</div>' +
        keyValueTable('授权状态', [
          ['真实提交可用', boundary.real_submit_available ? '是' : '否'],
          ['需要单独授权', boundary.real_submit_requires_separate_authorization ? '是' : '否'],
          ['授权已提供', authorization.provided ? '是' : '否'],
          ['授权已接受', authorization.accepted ? '是' : '否'],
          ['报告', canary.report_exists ? canary.report_path : '未找到']
        ]) +
        boundaryTable(boundary);
    }
    function renderReports() {
      const keyReports = [
        latestReport('r3_9q_final_video_review_decision_result.json'),
        latestReport('r3_9p_final_video_review_package_result.json'),
        latestReport('r3_9o_final_video_assembly_execution_result.json'),
        latestReport('r3_9n_final_video_assembly_dry_run_result.json'),
        latestReport('r3_9l_human_regenerated_clip_review_decision_apply_result.json'),
        latestReport('r2_5_h5_memory_asset_workbench_result.json')
      ].filter(Boolean);
      const rows = model.reports.map(report => '<tr><td>' + escapeHtml(report.name) + '</td><td>' + report.size_bytes + '</td><td>' + escapeHtml(report.updated_at) + '</td><td>' + (report.is_latest_pointer ? statusPill('ok', 'latest') : statusPill('warn', 'history')) + '</td><td><button onclick="openReport(\\'' + jsString(report.name) + '\\')">打开</button></td></tr>').join('');
      document.getElementById('reports').innerHTML = '<div class="page-head"><div><h2>证据报告</h2><div class="page-kicker">本地报告入口，只展示低披露证据和打开按钮。</div></div></div><div class="panel"><h2>关键证据</h2>' + reportButtons(keyReports) + '</div><table><thead><tr><th>名称</th><th>字节</th><th>更新时间</th><th>类型</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    async function registerImport(filename) { await api('/api/imports/register', { import_filename: filename, review_status: 'approved_for_media_artifact_handoff' }); }
    async function registerImportBatch(files) {
      const queue = Array.isArray(files) ? files : [];
      if (!queue.length) return;
      result.textContent = '正在注册批次：' + String(queue.length) + ' 张';
      for (const filename of queue) {
        const payload = await api('/api/imports/register', { import_filename: filename, review_status: 'approved_for_media_artifact_handoff' });
        if (!payload || !payload.ok) break;
      }
    }
    function cycleImportShot(viewerKey, delta, total, event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const batchList = document.querySelector('.batch-queue');
      const detailList = document.querySelector('.batch-detail .import-shot-strip');
      const inboxList = document.querySelector('.asset-inbox .import-batches');
      const positions = {
        batchScrollTop: batchList ? batchList.scrollTop : 0,
        detailScrollLeft: detailList ? detailList.scrollLeft : 0,
        inboxScrollTop: inboxList ? inboxList.scrollTop : 0
      };
      const key = String(viewerKey || '');
      const current = Number(importViewerState[key] || 0);
      const count = Math.max(1, Number(total || 1));
      importViewerState[key] = (current + Number(delta || 0) + count) % count;
      renderImports();
      restoreImportScrollPositions(positions);
    }
    function restoreImportScrollPositions(positions) {
      const nextBatchList = document.querySelector('.batch-queue');
      const nextDetailList = document.querySelector('.batch-detail .import-shot-strip');
      const nextInboxList = document.querySelector('.asset-inbox .import-batches');
      if (nextBatchList) nextBatchList.scrollTop = positions.batchScrollTop || 0;
      if (nextDetailList) nextDetailList.scrollLeft = positions.detailScrollLeft || 0;
      if (nextInboxList) nextInboxList.scrollTop = positions.inboxScrollTop || 0;
      window.requestAnimationFrame(() => {
        const rafBatchList = document.querySelector('.batch-queue');
        const rafDetailList = document.querySelector('.batch-detail .import-shot-strip');
        const rafInboxList = document.querySelector('.asset-inbox .import-batches');
        if (rafBatchList) rafBatchList.scrollTop = positions.batchScrollTop || 0;
        if (rafDetailList) rafDetailList.scrollLeft = positions.detailScrollLeft || 0;
        if (rafInboxList) rafInboxList.scrollTop = positions.inboxScrollTop || 0;
      });
    }
    async function rejectImport(filename) { await api('/api/imports/reject', { import_filename: filename, reason: 'rejected_from_storyboard_flow' }); }
    async function saveShot(shotId, element, field) {
      const body = { shot_id: shotId };
      if (field === 0) body.duration_seconds = Number(element.value);
      if (field === 1) body.description = element.value;
      if (field === 2) body.video_prompt = element.value;
      await api('/api/shots/update', body);
    }
    async function linkArtifact(shotId, artifactId) { await api('/api/shots/link-artifact', { shot_id: shotId, artifact_id: artifactId }); }
    async function approveShot(shotId) { await api('/api/shots/approve', { shot_id: shotId, human_confirmation: true }); }
    async function revisionShot(shotId) { await api('/api/shots/revision-needed', { shot_id: shotId }); }
    async function preparePackageProject() { await api('/api/package/prepare-project', {}); }
    async function validatePackage() { await api('/api/package/validate', {}); }
    async function freezePackage() { await api('/api/package/freeze', { human_confirmation: true }); }
    async function approveClip(shotId, artifactId) { await api('/api/review/approve', { shot_id: shotId, artifact_id: artifactId }); }
    async function rejectClip(shotId, artifactId) {
      const reason = window.prompt('拒绝原因', '需要调整运动或画面表现') || '需要调整';
      const promptDelta = window.prompt('重生成草案提示词增量', '增加更自然的运动') || '';
      await api('/api/review/reject', {
        shot_id: shotId,
        artifact_id: artifactId,
        rejection_reasons: [reason],
        revision_instruction: {
          summary: reason,
          prompt_delta: promptDelta,
          negative_delta: '',
          priority: 'medium'
        }
      });
    }
    async function openReport(name) { const response = await fetch('/api/reports/read?name=' + encodeURIComponent(name)); result.textContent = '报告内容：\\n' + JSON.stringify(await response.json(), null, 2); }
    async function assembleFinal() {
      if (!window.confirm('确认执行本地最终合成？这不会调用 provider，也不会覆盖源 clip。')) return;
      await api('/api/assembly/execute', { project_id: model.assembly && model.assembly.project_id, human_confirmation: true });
    }
    async function submitFinalDecision() {
      const decision = document.getElementById('final_decision').value;
      const reviewer = document.getElementById('final_reviewer').value.trim();
      const note = document.getElementById('final_note').value.trim();
      if (!decision) {
        result.textContent = '操作失败\\n原因：请选择最终决策';
        return;
      }
      if (!reviewer) {
        result.textContent = '操作失败\\n原因：请填写审查人';
        return;
      }
      if ((decision === 'reject' || decision === 'revision_requested') && !note) {
        result.textContent = '操作失败\\n原因：拒绝或请求修订时必须填写备注';
        return;
      }
      if (!window.confirm('确认写入本地最终成片决策报告？此操作不会发布、部署或上传。')) return;
      await api('/api/final-review/decision', { decision, reviewer, note, human_confirmation: true });
    }
    async function confirmMemoryProposal() {
      const proposal = model.memory && model.memory.latest_proposal;
      if (!proposal || !window.confirm('确认按当前选择写入本地 Memory / Asset / Reference？不会写入外部长期记忆。')) return;
      const decisions = proposal.items.map(item => {
        const decision = document.getElementById('memory_decision_' + item.item_id).value;
        return {
          item_id: item.item_id,
          decision,
          title: document.getElementById('memory_title_' + item.item_id).value,
          content: document.getElementById('memory_content_' + item.item_id).value,
          rejection_reason: document.getElementById('memory_reject_' + item.item_id).value
        };
      }).filter(item => item.decision === 'approve' || item.decision === 'reject');
      await api('/api/memory/confirm', { proposal_id: proposal.proposal_id, human_confirmation: true, decisions });
    }
    async function generateRecallPack() {
      const proposal = model.memory && model.memory.latest_proposal;
      if (!proposal) return;
      await api('/api/memory/recall-pack', { project_id: proposal.project_id });
    }
    async function confirmPendingAction(actionId) { await api('/api/pending-actions/confirm', { action_id: actionId, human_confirmation: true }); }
    async function rejectPendingAction(actionId) { await api('/api/pending-actions/reject', { action_id: actionId, reason: window.prompt('拒绝原因', '不执行这个请求') || 'rejected' }); }
    function actionButtons(action) {
      if (!action || action.status !== 'pending') return '';
      return '<button class="primary" onclick="confirmPendingAction(\\'' + jsString(action.action_id) + '\\')">确认执行</button><button class="warn" onclick="rejectPendingAction(\\'' + jsString(action.action_id) + '\\')">拒绝</button>';
    }
    function renderSidePanel() {
      const assembly = model.assembly || {};
      const finalReview = model.final_review || { final_video: null };
      const pending = model.pending_actions || { pending_count: 0 };
      const review = model.review || { generated_clips: [], regeneration_request_drafts: [] };
      const finalArtifact = assembly.final_video_artifact;
      const finalVideo = finalArtifact ? { artifact_id: finalArtifact.artifact_id, status: finalArtifact.status } : finalReview.final_video ? { artifact_id: finalReview.final_video.artifact_id, status: 'active' } : null;
      const decisionReport = finalReview.decision_report;
      const keyReports = [
        latestReport('r3_9q_final_video_review_decision_result.json'),
        latestReport('r3_9p_final_video_review_package_result.json'),
        latestReport('r3_9o_final_video_assembly_execution_result.json'),
        latestReport('r3_9l_human_regenerated_clip_review_decision_apply_result.json')
      ].filter(Boolean);
      const inspector = activeInspector ? inspectorPanel(activeInspector) : '<div class="inspector-empty">点击任意卡片的“详情”，这里会显示 SHOT、草稿、导入图、待确认动作或 clip 的上下文。</div>';
      document.getElementById('sidePanel').innerHTML =
        '<div class="panel"><h3>当前生产态</h3>' +
        '<div class="list">' +
        '<div class="row"><span>页面</span><b>' + escapeHtml(pageTitle(page)) + '</b></div>' +
        '<div class="row"><span>最终视频</span><b>' + escapeHtml(finalVideo ? labelStatus(finalVideo.status) : '未生成') + '</b></div>' +
        '<div class="row"><span>最终决策</span><b>' + escapeHtml(decisionReport ? labelDecision(decisionReport.decision) : '未记录') + '</b></div>' +
        '<div class="row"><span>待确认</span><b>' + escapeHtml(String(pending.pending_count || 0)) + '</b></div>' +
        '<div class="row"><span>可审 clip</span><b>' + escapeHtml(String(review.generated_clips.length)) + '</b></div>' +
        '<div class="row"><span>重生成草案</span><b>' + escapeHtml(String((review.regeneration_request_drafts || []).length)) + '</b></div>' +
        '</div></div>' +
        inspector +
        (finalVideo ? '<div class="panel"><h3>最终成片</h3>' + mediaPreview(finalVideo.artifact_id, 'video') + '</div>' : '') +
        '<div class="panel"><h3>快捷证据</h3>' + reportButtons(keyReports) + '</div>';
    }
    function inspectorPanel(selection) {
      if (!selection) return '';
      if (selection.kind === 'import') return importInspector(selection.id);
      if (selection.kind === 'draft') return draftInspector(selection.id);
      if (selection.kind === 'pendingAction') return pendingActionInspector(selection.id);
      if (selection.kind === 'shot') return shotInspector(selection.id);
      if (selection.kind === 'clip') return clipInspector(selection.id);
      if (selection.kind === 'batch') return batchInspector(selection.id);
      if (selection.kind === 'pending') return genericInspector('待确认动作', '所有需要 Jenn 决策的动作都在待确认 Inbox 中处理。', 'pendingActions');
      if (selection.kind === 'drafts') return genericInspector('GPT 草稿收件箱', '草稿按类型分列，只在你确认后才会进入真实项目状态。', 'webgptDrafts');
      if (selection.kind === 'shots') return genericInspector('镜头看板', '每个 SHOT 都是一张可编辑生产卡片。', 'shots');
      if (selection.kind === 'review') return genericInspector('审片工作区', '采纳 clip 会写入本地审片决策；拒绝会生成重做草案。', 'review');
      if (selection.kind === 'assembly') return genericInspector('最终合成', '本地合成不会调用 provider，也不会覆盖源 clip。', 'assembly');
      if (selection.kind === 'finalReview') return genericInspector('最终审查', '最终接受、拒绝或请求修订必须由 Jenn 明确决定。', 'finalReview');
      if (selection.kind === 'memory') return genericInspector('记忆资产', '只写本地 Memory / Asset / Reference，不写外部长期记忆。', 'memory');
      if (selection.kind === 'reports') return genericInspector('证据报告', '这里展示低披露的本地报告入口。', 'reports');
      return genericInspector('详情', '暂无可展示的上下文。', page);
    }
    function genericInspector(title, body, targetPage) {
      return '<div class="panel"><h3>' + escapeHtml(title) + '</h3><div class="muted">' + escapeHtml(body) + '</div><div class="decision-bar"><button onclick="show(\\'' + jsString(targetPage) + '\\')">打开页面</button></div></div>';
    }
    function importInspector(filename) {
      const item = (model.imports || []).find(entry => entry.filename === filename);
      if (!item) return genericInspector('导入图', '未找到这张导入图。', 'imports');
      const existing = item.existing_artifact_ids || [];
      return '<div class="panel"><h3>导入图详情</h3>' +
        '<img class="preview" loading="lazy" src="/imports/' + encodeURIComponent(item.filename) + '" alt="">' +
        keyValueTable('文件', [
          ['文件名', item.filename],
          ['尺寸', item.width && item.height ? String(item.width) + 'x' + String(item.height) : '未知'],
          ['比例', item.normalized_aspect_ratio || item.detected_aspect_ratio || 'unknown'],
          ['阻断项', blockerText(item.blockers || [])],
          ['已注册 Artifact', existing.length ? existing.join(', ') : '无']
        ]) +
        '<div class="decision-bar"><button class="primary" onclick="registerImport(\\'' + jsString(item.filename) + '\\')" ' + (existing.length || (item.blockers || []).length ? 'disabled' : '') + '>注册</button><button class="warn" onclick="rejectImport(\\'' + jsString(item.filename) + '\\')">排除</button></div>' +
        '</div>';
    }
    function draftInspector(draftId) {
      const draft = ((model.webgpt_drafts || {}).drafts || []).find(item => item.draft_id === draftId);
      if (!draft) return genericInspector('GPT 草稿', '未找到这条草稿。', 'webgptDrafts');
      const info = draftInfo(draft);
      return '<div class="panel"><h3>' + escapeHtml(info.title) + '</h3>' +
        '<div class="muted">' + escapeHtml(shortDraftId(draft.draft_id)) + '</div>' +
        '<div class="card-fields">' + info.fields.map(row => cardField(row[0], row[1])).join('') + '</div>' +
        '<div class="decision-bar">' + info.actions.map(action => '<button onclick="show(\\'' + jsString(action.page) + '\\')">' + escapeHtml(action.label) + '</button>').join('') + '</div>' +
        '</div>';
    }
    function pendingActionInspector(actionId) {
      const action = ((model.pending_actions || {}).actions || []).find(item => item.action_id === actionId);
      if (!action) return genericInspector('待确认动作', '未找到这个动作。', 'pendingActions');
      const info = pendingActionInfo(action);
      return '<div class="panel"><h3>' + escapeHtml(info.title) + '</h3>' +
        '<div class="muted">' + escapeHtml(shortActionId(action.action_id)) + '</div>' +
        '<div class="card-fields">' + info.fields.map(row => cardField(row[0], row[1])).join('') + '</div>' +
        '<div class="decision-bar">' + pendingActionButtons(action, info) + '</div>' +
        '</div>';
    }
    function shotInspector(shotId) {
      const shot = (model.state.shots || []).find(item => item.shot_id === shotId);
      if (!shot) return genericInspector('SHOT', '未找到这个镜头。', 'shots');
      const packageShot = model.package && model.package.shots ? model.package.shots.find(item => item.shot_id === shotId) : null;
      return '<div class="panel"><h3>' + escapeHtml(shot.shot_id) + '</h3>' +
        '<div class="card-labels">' + statusPill(shot.approval_status === 'approved' ? 'ok' : shot.approval_status === 'revision_needed' ? 'bad' : 'warn', labelStatus(shot.approval_status)) + '</div>' +
        keyValueTable('镜头上下文', [
          ['秒数', String(shot.duration_seconds)],
          ['描述', shot.description || '无'],
          ['视频提示词', shot.video_prompt || '无'],
          ['负向提示词', shot.negative_prompt || '无'],
          ['Storyboard Artifact', shot.storyboard_image_artifact_id || '无'],
          ['分镜包阻断项', packageShot ? blockerText(packageShot.blockers || []) : '无']
        ]) +
        '<div class="decision-bar"><button class="primary" onclick="approveShot(\\'' + jsString(shot.shot_id) + '\\')">批准</button><button class="warn" onclick="revisionShot(\\'' + jsString(shot.shot_id) + '\\')">需修改</button></div>' +
        '</div>';
    }
    function clipInspector(artifactId) {
      const review = model.review || { generated_clips: [] };
      const clip = (review.generated_clips || []).find(item => item.artifact_id === artifactId);
      if (!clip) return genericInspector('Clip', '未找到这个 generated_clip。', 'review');
      return '<div class="panel"><h3>' + escapeHtml(clip.shot_id) + '</h3>' +
        mediaPreview(clip.artifact_id, 'video') +
        keyValueTable('Clip 上下文', [
          ['Artifact ID', clip.artifact_id],
          ['Run ID', clip.run_id || '无'],
          ['Provider', clip.provider_name || 'unknown'],
          ['Provider Job', clip.provider_job_id || '无'],
          ['ffprobe', clip.ffprobe ? clip.ffprobe.status : '未测试'],
          ['审片状态', labelStatus(clip.clip_review_status)]
        ]) +
        '<div class="decision-bar"><button class="primary" onclick="approveClip(\\'' + jsString(clip.shot_id) + '\\',\\'' + jsString(clip.artifact_id) + '\\')">采纳</button><button class="danger" onclick="rejectClip(\\'' + jsString(clip.shot_id) + '\\',\\'' + jsString(clip.artifact_id) + '\\')">拒绝</button></div>' +
        '</div>';
    }
    function batchInspector(batchKey) {
      const batch = importBatchGroups(model.imports || []).ready.find(item => item.key === batchKey);
      if (!batch) return genericInspector('批次', '未找到这个批次。', 'imports');
      const shots = importShotGroups(batch);
      return '<div class="panel"><h3>' + escapeHtml(batch.title) + '</h3>' +
        keyValueTable('批次结构', [
          ['batch_id', batch.key],
          ['类型', batch.kind],
          ['SHOT', String(shots.length)],
          ['候选图', String(batch.items.length)],
          ['当前规则', '每个 SHOT 选择当前图后注册']
        ]) +
        '<div class="decision-bar"><button onclick="show(\\'imports\\')">打开导入页</button></div>' +
        '</div>';
    }
    function pageTitle(id) {
      return ({
        dashboard: '指挥台',
        imports: '导入',
        webgptDrafts: 'GPT 草稿',
        pendingActions: '待确认',
        shots: '镜头',
        package: '分镜包',
        review: '审片',
        assembly: '合成',
        finalReview: '最终审查',
        memory: '记忆资产',
        canary: '金丝雀',
        reports: '证据报告'
      })[id] || id;
    }
    function latestReport(name) {
      return (model.reports || []).find(report => report.name === name) || null;
    }
    function actionItem(title, detail, targetPage, enabled) {
      return '<div class="row"><div><b>' + escapeHtml(title) + '</b><div class="muted">' + escapeHtml(detail) + '</div></div><button onclick="show(\\'' + jsString(targetPage) + '\\')" ' + (enabled ? '' : 'disabled') + '>打开</button></div>';
    }
    function boardList(title, help, cards, count) {
      return '<div class="board-list">' +
        '<div class="board-list-header"><div><h2>' + escapeHtml(title) + '</h2><div class="board-list-help">' + escapeHtml(help) + '</div></div>' +
        statusPill('ok', String(count)) +
        '</div>' +
        '<div class="board-list-cards">' + (cards || emptyState('暂无卡片')) + '</div>' +
        '</div>';
    }
    function trelloCard(title, summary, fields, actions, kind) {
      const fieldRows = (fields || []).map(row => cardField(row[0], row[1])).join('');
      const buttons = (actions || []).map(action => {
        const inspect = action.kind ? 'inspectCard(\\'' + jsString(action.kind) + '\\', \\'' + jsString(action.id || '') + '\\')' : '';
        const pageAction = action.page ? 'show(\\'' + jsString(action.page) + '\\')' : '';
        const onclick = inspect && pageAction ? inspect + ';' + pageAction : inspect || pageAction || '';
        return '<button onclick="' + escapeAttr(onclick) + '">' + escapeHtml(action.label) + '</button>';
      }).join('');
      return '<div class="task-card">' +
        '<div class="card-labels">' + statusPill(kind || 'ok', kind === 'bad' ? '阻断' : kind === 'warn' ? '待处理' : '可推进') + '</div>' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        '<div class="muted">' + escapeHtml(summary) + '</div>' +
        '<div class="card-fields">' + fieldRows + '</div>' +
        (buttons ? '<div class="card-actions">' + buttons + '</div>' : '') +
        '</div>';
    }
    function cardField(label, value) {
      return '<div class="card-field"><b>' + escapeHtml(label) + '</b><span>' + escapeHtml(value) + '</span></div>';
    }
    function inspectButton(kind, id, label) {
      return '<button onclick="inspectCard(\\'' + jsString(kind) + '\\', \\'' + jsString(id) + '\\')">' + escapeHtml(label || '详情') + '</button>';
    }
    function inspectCard(kind, id) {
      activeInspector = { kind: String(kind || ''), id: String(id || '') };
      if (!inspectorVisible) {
        inspectorVisible = true;
        window.localStorage.setItem('h1InspectorVisible', 'true');
      }
      renderSidePanel();
      document.querySelector('main').classList.toggle('inspector-hidden', !inspectorVisible);
      document.getElementById('focusBoard').textContent = inspectorVisible ? '专注 board' : '显示 inspector';
    }
    function toggleInspector() {
      inspectorVisible = !inspectorVisible;
      window.localStorage.setItem('h1InspectorVisible', inspectorVisible ? 'true' : 'false');
      render();
    }
    function statusPill(kind, text) {
      return '<span class="pill ' + escapeAttr(kind) + '">' + escapeHtml(text) + '</span>';
    }
    function emptyState(text) {
      return '<div class="muted">' + escapeHtml(text) + '</div>';
    }
    function reportButtons(reports) {
      const buttons = (reports || []).filter(Boolean).map(report => '<button onclick="openReport(\\'' + jsString(report.name) + '\\')">' + escapeHtml(report.name) + '</button>').join('');
      return '<div class="toolbar">' + (buttons || '<button disabled>暂无关键报告</button>') + '</div>';
    }
    function mediaPreview(artifactId, type) {
      if (!artifactId) return emptyState('未绑定媒体 Artifact');
      const url = '/media/artifacts/' + encodeURIComponent(artifactId);
      if (type === 'image') return '<img class="preview" src="' + url + '" alt="">';
      return '<video controls preload="metadata" src="' + url + '"></video>';
    }
    function metric(label, value) { return '<div class="metric">' + escapeHtml(label) + '<b>' + escapeHtml(String(value)) + '</b></div>'; }
    function keyValueTable(title, rows) {
      return '<table><thead><tr><th colspan="2">' + escapeHtml(title) + '</th></tr></thead><tbody>' +
        rows.map(row => '<tr><td>' + escapeHtml(row[0]) + '</td><td>' + escapeHtml(row[1]) + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function labelStatus(value) { return statusLabels[value] || value || ''; }
    function labelDecision(value) {
      return ({ accept: '接受', reject: '拒绝', revision_requested: '请求修订' })[value] || value || '未记录';
    }
    function decisionOptions(selected) {
      const options = [
        ['', '选择'],
        ['accept', 'accept'],
        ['reject', 'reject'],
        ['revision_requested', 'revision_requested']
      ];
      return options.map(option => '<option value="' + escapeAttr(option[0]) + '" ' + (option[0] === selected ? 'selected' : '') + '>' + escapeHtml(option[1]) + '</option>').join('');
    }
    function labelBlocker(value) {
      const text = String(value || '');
      const splitAt = text.indexOf(':');
      if (splitAt > 0) return text.slice(0, splitAt) + '：' + labelBlocker(text.slice(splitAt + 1));
      if (blockerLabels[text]) return blockerLabels[text];
      if (text.startsWith('ARTIFACT_')) return 'Artifact 状态不允许：' + text.slice('ARTIFACT_'.length).toLowerCase();
      return text;
    }
    function blockerText(blockers) {
      return blockers && blockers.length ? blockers.map(labelBlocker).join('，') : '无';
    }
    function yesNo(value) { return value ? '是' : '否'; }
    function boundaryTable(boundary) {
      const rows = Object.keys(boundary || {}).map(key => {
        const value = boundary[key];
        const text = typeof value === 'boolean' ? yesNo(Boolean(value)) : String(value);
        return '<tr><td>' + escapeHtml(boundaryLabels[key] || key) + '</td><td>' + escapeHtml(text) + '</td></tr>';
      }).join('');
      return '<table><thead><tr><th>边界项</th><th>是否发生</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    function provenanceText(provenance) {
      if (!provenance) return '';
      return ['project=' + (provenance.project_id || ''), 'shot=' + (provenance.shot_id || ''), 'artifact=' + (provenance.artifact_id || ''), 'run=' + (provenance.run_id || ''), 'package=' + (provenance.storyboard_package_id || '')].filter(Boolean).join('\\n');
    }
    function validationPanel(validation) {
      return '<table><thead><tr><th>校验项</th><th>结果</th></tr></thead><tbody>' +
        '<tr><td>分镜包候选</td><td>' + escapeHtml(validation.ok ? '通过' : '未通过') + '</td></tr>' +
        '<tr><td>G0 校验</td><td>' + escapeHtml(validation.validateG0StoryboardPackage === 'NOT_RUN_UNTIL_VALIDATE_ACTION' ? '等待手动校验' : validation.validateG0StoryboardPackage) + '</td></tr>' +
        '<tr><td>App Ready 候选</td><td>' + escapeHtml(yesNo(Boolean(validation.app_ready_candidate || validation.app_ready))) + '</td></tr>' +
        '<tr><td>阻断项</td><td>' + escapeHtml(blockerText(validation.blockers)) + '</td></tr>' +
        '</tbody></table>' + boundaryTable(validation.provider_boundary || {});
    }
    function historyText(history) {
      return history && history.length ? '冻结历史：\\n' + JSON.stringify(history, null, 2) : '暂无冻结历史';
    }
    function draftText(drafts) {
      return drafts && drafts.length ? '重生成请求草案：\\n' + JSON.stringify(drafts, null, 2) : '暂无重生成请求草案';
    }
    function actionText(payload) {
      const lines = [payload && payload.ok ? '操作成功' : '操作失败'];
      if (payload && payload.error) {
        const message = payload.error.message && /[\u4e00-\u9fff]/.test(payload.error.message) ? '（' + payload.error.message + '）' : '';
        lines.push('原因：' + labelBlocker(payload.error.code) + message);
      }
      if (payload && payload.value && payload.value.artifact) lines.push('Artifact ID：' + payload.value.artifact.artifact_id);
      if (payload && payload.value && payload.value.final_video_artifact_id) lines.push('最终视频 Artifact ID：' + payload.value.final_video_artifact_id);
      if (payload && payload.value && payload.value.decision) lines.push('最终决策：' + labelDecision(payload.value.decision));
      if (payload && payload.value && payload.value.latest_path) lines.push('报告：' + payload.value.latest_path);
      if (payload && payload.report && payload.report.storyboard_package_id) lines.push('分镜包 ID：' + payload.report.storyboard_package_id);
      if (payload && payload.validation) {
        lines.push('校验结果：' + (payload.validation.ok ? '通过' : '未通过'));
        lines.push('阻断项：' + blockerText(payload.validation.blockers));
      }
      return lines.join('\\n');
    }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
    function escapeAttr(value) { return escapeHtml(value); }
    function jsString(value) { return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
    function jsStringArray(values) { return '[' + (values || []).map(value => '\\'' + jsString(value) + '\\'').join(',') + ']'; }
    document.querySelectorAll('nav button').forEach(button => button.onclick = () => show(button.dataset.page));
    document.getElementById('refresh').onclick = load;
    document.getElementById('focusBoard').onclick = toggleInspector;
    load().catch(error => result.textContent = error.message);
  </script>
</body>
</html>`;
}

async function mutate(request: IncomingMessage, response: ServerResponse, fn: (body: Record<string, unknown>) => unknown): Promise<void> {
  if (!hasMutationNonce(request)) {
    sendJson(response, 403, { ok: false, error: { code: "ACTION_NONCE_REQUIRED", message: "操作需要 H1 nonce。" } });
    return;
  }
  const body = (await readBody(request)) as Record<string, unknown>;
  const payload = fn(body);
  sendJson(response, 200, payload);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { ok: false, error: { code: "LOCALHOST_ONLY", message: "H1 人类工作台仅接受本机请求。" } });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (await handleWorkbenchV2Api(request, response, url, ACTION_NONCE)) return;
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    response.writeHead(302, { location: "/v2/dashboard", "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/legacy") return sendHtml(response, appHtml());
  if (request.method === "GET" && (url.pathname === "/v2" || url.pathname.startsWith("/v2/") || url.pathname.startsWith("/v2-assets/"))) {
    return serveWorkbenchV2(url.pathname, response);
  }
  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") return sendJson(response, 200, bootstrapPayload(reviewOptionsFromSearchParams(url.searchParams)));
  if (request.method === "GET" && url.pathname === "/api/dashboard") return sendJson(response, 200, { ok: true, dashboard: bootstrapPayload().dashboard });
  if (request.method === "GET" && url.pathname === "/api/imports") return sendJson(response, 200, { ok: true, imports: bootstrapPayload().imports });
  if (request.method === "GET" && url.pathname === "/api/webgpt-drafts") return sendJson(response, 200, { ok: true, webgpt_drafts: webGptDraftWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/pending-actions") return sendJson(response, 200, { ok: true, pending_actions: webGptPendingActionWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/shots") return sendJson(response, 200, { ok: true, shots: loadH1WorkbenchState().shots });
  if (request.method === "GET" && url.pathname === "/api/canary") return sendJson(response, 200, { ok: true, canary: h2CanaryWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/final-review") return sendJson(response, 200, { ok: true, final_review: finalReviewWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/review") {
    return withDb((db) => sendJson(response, 200, { ok: true, review: h3VideoReviewSummary(loadH1WorkbenchState(), db, reviewOptionsFromSearchParams(url.searchParams)) }));
  }
  if (request.method === "GET" && url.pathname === "/api/assembly") {
    return withDb((db) => sendJson(response, 200, { ok: true, assembly: h4FinalAssemblyWorkbenchSummary(loadH1WorkbenchState(), db) }));
  }
  if (request.method === "GET" && url.pathname === "/api/memory") return sendJson(response, 200, { ok: true, memory: memorySavebackWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/package") {
    return withDb((db) => sendJson(response, 200, { ok: true, package: packagePayloadForState(loadH1WorkbenchState(), db) }));
  }
  if (request.method === "GET" && url.pathname === "/api/reports") return sendJson(response, 200, { ok: true, reports: listH1Reports() });
  if (request.method === "GET" && url.pathname === "/api/reports/read") return sendJson(response, 200, readReport(url.searchParams.get("name") ?? ""));
  if (request.method === "GET" && url.pathname.startsWith("/ui-assets/")) return serveUiAsset(url.pathname, response);
  if (request.method === "GET" && url.pathname.startsWith("/imports/")) return serveImportImage(url.pathname, response);
  if (request.method === "GET" && url.pathname.startsWith("/media/artifacts/")) return serveMediaArtifact(url.pathname, request, response);

  if (request.method !== "GET" && url.pathname.startsWith("/api/")) {
    sendJson(response, 410, { ok: false, error: { code: "LEGACY_READ_ONLY", message: "Legacy 已切换为只读，请在 V2 工作台执行生产操作。" } });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/imports/register") {
    return mutate(request, response, (body) =>
      withDb((db) => registerH1ApprovedKeyframe({ import_filename: String(body.import_filename ?? ""), review_status: String(body.review_status ?? "") }, db))
    );
  }
  if (request.method === "POST" && url.pathname === "/api/imports/reject") {
    return mutate(request, response, (body) => {
      const state = rejectH1Import(loadH1WorkbenchState(), { import_filename: String(body.import_filename ?? ""), reason: String(body.reason ?? "") });
      saveH1WorkbenchState(state);
      return { ok: true, state };
    });
  }
  if (request.method === "POST" && url.pathname === "/api/shots/update") {
    return mutate(request, response, (body) => {
      const result = updateH1ShotMetadata(loadH1WorkbenchState(), {
        shot_id: String(body.shot_id ?? ""),
        duration_seconds: body.duration_seconds === undefined ? undefined : Number(body.duration_seconds),
        description: body.description === undefined ? undefined : String(body.description),
        video_prompt: body.video_prompt === undefined ? undefined : String(body.video_prompt),
        negative_prompt: body.negative_prompt === undefined ? undefined : String(body.negative_prompt),
        continuity_constraints: Array.isArray(body.continuity_constraints) ? body.continuity_constraints.map(String) : undefined
      });
      if (!result.ok) return result;
      return { ok: true, state: saveH1WorkbenchState(result.value) };
    });
  }
  if (request.method === "POST" && url.pathname === "/api/shots/link-artifact") {
    return mutate(request, response, (body) =>
      withDb((db) => {
        const result = linkH1ArtifactToShot(loadH1WorkbenchState(), { shot_id: String(body.shot_id ?? ""), artifact_id: String(body.artifact_id ?? "") }, db);
        if (!result.ok) return result;
        return { ok: true, state: saveH1WorkbenchState(result.value) };
      })
    );
  }
  if (request.method === "POST" && url.pathname === "/api/shots/approve") {
    return mutate(request, response, (body) => {
      const result = markH1ShotApproved(loadH1WorkbenchState(), { shot_id: String(body.shot_id ?? ""), human_confirmation: body.human_confirmation === true });
      if (!result.ok) return result;
      return { ok: true, state: saveH1WorkbenchState(result.value) };
    });
  }
  if (request.method === "POST" && url.pathname === "/api/shots/revision-needed") {
    return mutate(request, response, (body) => {
      const result = markH1ShotRevisionNeeded(loadH1WorkbenchState(), { shot_id: String(body.shot_id ?? "") });
      if (!result.ok) return result;
      return { ok: true, state: saveH1WorkbenchState(result.value) };
    });
  }
  if (request.method === "POST" && url.pathname === "/api/package/validate") {
    return mutate(request, response, () =>
      withDb((db) => {
        const result = validateH1StoryboardPackage(loadH1WorkbenchState(), db);
        if (!result.ok) return result;
        return { ok: true, validation: result.value.validation, state: result.value.state };
      })
    );
  }
  if (request.method === "POST" && url.pathname === "/api/package/prepare-project") {
    return mutate(request, response, () =>
      withDb((db) => {
        const result = prepareH1StoryboardPackageProject(loadH1WorkbenchState(), db);
        if (!result.ok) return result;
        return { ok: true, project: result.value.project, state: saveH1WorkbenchState(result.value.state) };
      })
    );
  }
  if (request.method === "POST" && url.pathname === "/api/package/freeze") {
    return mutate(request, response, (body) =>
      withDb((db) => {
        const result = freezeH1StoryboardPackage(loadH1WorkbenchState(), { human_confirmation: body.human_confirmation === true }, db);
        if (!result.ok) return result;
        saveH1WorkbenchState(result.value.state);
        return { ok: true, report: result.value.report, state: result.value.state };
      })
    );
  }
  if (request.method === "POST" && url.pathname === "/api/review/approve") {
    return mutate(request, response, (body) =>
      withDb((db) => approveH3GeneratedClip({ shot_id: String(body.shot_id ?? ""), artifact_id: String(body.artifact_id ?? "") }, db))
    );
  }
  if (request.method === "POST" && url.pathname === "/api/review/reject") {
    return mutate(request, response, (body) =>
      withDb((db) => {
        const revision = (body.revision_instruction ?? {}) as Record<string, unknown>;
        const result = rejectH3GeneratedClip(
          loadH1WorkbenchState(),
          {
            shot_id: String(body.shot_id ?? ""),
            artifact_id: String(body.artifact_id ?? ""),
            rejection_reasons: Array.isArray(body.rejection_reasons) ? body.rejection_reasons.map(String) : [],
            revision_instruction: {
              summary: String(revision.summary ?? ""),
              prompt_delta: String(revision.prompt_delta ?? ""),
              negative_delta: String(revision.negative_delta ?? ""),
              priority: revision.priority === "low" || revision.priority === "high" ? revision.priority : "medium"
            }
          },
          db
        );
        return result.ok ? { ok: true, state: result.value.state, draft: result.value.draft, report: result.value.report } : result;
      })
    );
  }
  if (request.method === "POST" && url.pathname === "/api/assembly/execute") {
    return mutate(request, response, (body) =>
      withDb((db) =>
        executeH4FinalAssembly(
          {
            project_id: String(body.project_id ?? ""),
            human_confirmation: body.human_confirmation === true
          },
          loadH1WorkbenchState(),
          db
        )
      )
    );
  }
  if (request.method === "POST" && url.pathname === "/api/final-review/decision") {
    return mutate(request, response, (body) =>
      recordFinalReviewDecision({
        decision: String(body.decision ?? ""),
        reviewer: String(body.reviewer ?? ""),
        note: String(body.note ?? ""),
        human_confirmation: body.human_confirmation === true
      })
    );
  }
  if (request.method === "POST" && url.pathname === "/api/memory/confirm") {
    return mutate(request, response, (body) => {
      const decisions: Array<{ item_id: string; decision: "approve" | "reject"; title?: string; content?: string; rejection_reason?: string }> = [];
      for (const item of Array.isArray(body.decisions) ? body.decisions : []) {
        const record = item as Record<string, unknown>;
        if (record.decision !== "approve" && record.decision !== "reject") {
          return { ok: false, error: { code: "INVALID_DECISION", message: "回存决定必须是 approve 或 reject。" } };
        }
        decisions.push({
          item_id: String(record.item_id ?? ""),
          decision: record.decision,
          title: record.title === undefined ? undefined : String(record.title),
          content: record.content === undefined ? undefined : String(record.content),
          rejection_reason: record.rejection_reason === undefined ? undefined : String(record.rejection_reason)
        });
      }
      const result = confirmMemorySavebackProposal({
        proposal_id: String(body.proposal_id ?? ""),
        human_confirmation: body.human_confirmation === true,
        decisions
      });
      return result.ok ? { ok: true, value: result.value, memory: memorySavebackWorkbenchSummary(result.value.store) } : result;
    });
  }
  if (request.method === "POST" && url.pathname === "/api/memory/recall-pack") {
    return mutate(request, response, (body) => {
      const result = generateMemoryRecallPack({ project_id: String(body.project_id ?? "") });
      return result.ok ? { ok: true, value: result.value, memory: memorySavebackWorkbenchSummary(result.value.store) } : result;
    });
  }
  if (request.method === "POST" && url.pathname === "/api/pending-actions/confirm") {
    return mutate(request, response, (body) =>
      withDb((db) => confirmWebGptPendingAction({ action_id: String(body.action_id ?? ""), human_confirmation: body.human_confirmation === true }, db))
    );
  }
  if (request.method === "POST" && url.pathname === "/api/pending-actions/reject") {
    return mutate(request, response, (body) =>
      rejectWebGptPendingAction({ action_id: String(body.action_id ?? ""), reason: String(body.reason ?? "") })
    );
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未找到路由。" } });
}

ensureM0Directories();
migrateLegacyWorkbenchInboxStores();
resumeWorkbenchGenerationJobs();
const startPort = Number(process.env.H1_WORKBENCH_PORT || process.env.PORT || DEFAULT_PORT);
const server = createServer((request, response) => {
  route(request, response).catch(() => sendJson(response, 500, { ok: false, error: { code: "SERVER_ERROR", message: "服务器错误。" } }));
});

function listen(port: number): void {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && port < startPort + 20) {
      listen(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`H1 人类工作台运行中：http://127.0.0.1:${actualPort}`);
  });
}

listen(startPort);
