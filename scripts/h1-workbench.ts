import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

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
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
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

function withDb<T>(fn: (db: ReturnType<typeof openM0Database>) => T): T {
  const db = openM0Database();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function bootstrapPayload() {
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
      review: h3VideoReviewSummary(state, db),
      assembly: h4FinalAssemblyWorkbenchSummary(state, db),
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
  <title>H1 人类工作台</title>
  <style>
    :root { font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; color: #1f2328; background: #f7f7f4; }
    body { margin: 0; }
    header { height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; background: #fff; border-bottom: 1px solid #d8d8d2; }
    h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
    main { display: grid; grid-template-columns: 192px 1fr; min-height: calc(100vh - 54px); }
    nav { background: #fff; border-right: 1px solid #d8d8d2; padding: 10px; }
    nav button { display: block; width: 100%; margin-bottom: 6px; text-align: left; }
    section { padding: 14px; overflow: auto; }
    button { border: 1px solid #9a9a90; background: #fff; color: #1f2328; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button.primary { background: #0f766e; border-color: #0f766e; color: #fff; }
    button.warn { border-color: #a16207; color: #7c2d12; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #b8b8ae; border-radius: 6px; padding: 7px; font: inherit; background: #fff; }
    textarea { min-height: 58px; resize: vertical; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
    th, td { border-bottom: 1px solid #deded8; padding: 7px; vertical-align: top; font-size: 12px; word-break: break-word; }
    th { text-align: left; color: #55554d; font-weight: 600; background: #fbfbf8; }
    .toolbar { display: flex; gap: 8px; align-items: center; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .metric { background: #fff; border: 1px solid #deded8; border-radius: 8px; padding: 10px; }
    .metric b { display: block; font-size: 22px; margin-top: 4px; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .hidden { display: none; }
    pre { background: #202124; color: #f4f4ef; padding: 12px; border-radius: 8px; overflow: auto; max-height: 360px; }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid #d8d8d2; } .summary, .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>H1 人类工作台</h1>
    <div class="toolbar"><button id="refresh">刷新</button></div>
  </header>
  <main>
    <nav>
      <button data-page="dashboard">总览</button>
      <button data-page="imports">导入</button>
      <button data-page="webgptDrafts">GPT 草稿</button>
      <button data-page="pendingActions">待确认</button>
      <button data-page="shots">镜头</button>
      <button data-page="package">分镜包</button>
      <button data-page="review">审片</button>
      <button data-page="assembly">合成</button>
      <button data-page="memory">记忆资产</button>
      <button data-page="canary">金丝雀</button>
      <button data-page="reports">报告</button>
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
      <div id="memory" class="hidden"></div>
      <div id="canary" class="hidden"></div>
      <div id="reports" class="hidden"></div>
      <pre id="result">等待操作结果</pre>
    </section>
  </main>
  <script>
    let model = null;
    let nonce = '';
    let page = 'dashboard';
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
      FAKE_PROJECT_ID_REJECTED: '拒绝虚假项目 ID',
      FOUR_PANEL_OR_CONTACT_SHEET_NOT_STORYBOARD: '四宫格或联系表不能作为单张分镜图',
      FREEZE_PRECONDITIONS_BLOCKED: '冻结前置条件未满足',
      HUMAN_CONFIRMATION_REQUIRED: '需要人类明确确认',
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
      PROJECT_HAS_NO_SHOTS: '项目没有镜头',
      PROJECT_NOT_FOUND: '未找到项目',
      REPORT_NOT_FOUND: '未找到报告',
      SERVER_ERROR: '服务器错误',
      SHOT_NOT_APPROVED: '镜头尚未批准',
      SHOT_NOT_FOUND: '未找到镜头',
      STORAGE_PATH_NOT_ALLOWED: '路径不在允许范围内',
      SYMLINK_ESCAPE_BLOCKED: '已阻止符号链接逃逸'
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
      private_state_read: '读取私有状态'
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
      const response = await fetch('/api/bootstrap');
      model = await response.json();
      nonce = model.action_nonce;
      render();
    }
    function show(next) {
      page = next;
      for (const id of ['dashboard','imports','webgptDrafts','pendingActions','shots','package','review','assembly','memory','canary','reports']) document.getElementById(id).classList.toggle('hidden', id !== page);
      render();
    }
    function render() {
      if (!model) return;
      renderDashboard();
      renderImports();
      renderWebGptDrafts();
      renderPendingActions();
      renderShots();
      renderPackage();
      renderReview();
      renderAssembly();
      renderMemory();
      renderCanary();
      renderReports();
      for (const id of ['dashboard','imports','webgptDrafts','pendingActions','shots','package','review','assembly','memory','canary','reports']) document.getElementById(id).classList.toggle('hidden', id !== page);
    }
    function renderDashboard() {
      const d = model.dashboard;
      document.getElementById('dashboard').innerHTML = '<div class="summary">' +
        metric('镜头批准', d.shots_approved + '/' + d.shots_total) +
        metric('可导入图片', d.imports_ready + '/' + d.imports_total) +
        metric('阻断项', d.blockers_total) +
        metric('报告', d.reports_total) +
        '</div>' + boundaryTable(d.provider_boundary);
    }
    function renderImports() {
      const rows = model.imports.map(item => '<tr><td>' + escapeHtml(item.filename) + '</td><td>' + item.width + 'x' + item.height + '</td><td>' + escapeHtml(item.normalized_aspect_ratio || item.detected_aspect_ratio) + '</td><td>' + escapeHtml(blockerText(item.blockers)) + '</td><td><button onclick="registerImport(\\'' + jsString(item.filename) + '\\')" ' + (item.blockers.length ? 'disabled' : '') + '>注册</button><button onclick="rejectImport(\\'' + jsString(item.filename) + '\\')">拒绝</button></td></tr>').join('');
      document.getElementById('imports').innerHTML = '<table><thead><tr><th>文件</th><th>尺寸</th><th>比例</th><th>阻断项</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    function renderWebGptDrafts() {
      const summary = model.webgpt_drafts || { drafts: [], drafts_total: 0, provider_boundary: {}, production_effects: {} };
      const rows = summary.drafts.map(draft => '<tr><td>' + escapeHtml(draft.draft_id) + '</td><td>' + escapeHtml(draft.tool) + '</td><td>' + escapeHtml(draft.status) + '</td><td>' + escapeHtml(draft.created_at) + '</td><td>' + escapeHtml(JSON.stringify(draft.payload)) + '</td></tr>').join('');
      document.getElementById('webgptDrafts').innerHTML = '<div class="summary">' +
        metric('草稿总数', String(summary.drafts_total || 0)) +
        metric('当前显示', String((summary.drafts || []).length)) +
        metric('真值变更', summary.production_effects && summary.production_effects.app_ready_truth_changed ? '是' : '否') +
        metric('直接冻结', summary.production_effects && summary.production_effects.package_frozen ? '是' : '否') +
        '</div><table><thead><tr><th>草稿 ID</th><th>工具</th><th>状态</th><th>提交时间</th><th>Payload</th></tr></thead><tbody>' + rows + '</tbody></table>' + boundaryTable(summary.provider_boundary || {});
    }
    function renderPendingActions() {
      const summary = model.pending_actions || { actions: [], actions_total: 0, pending_count: 0, provider_boundary: {} };
      const rows = summary.actions.map(action => '<tr><td>' + escapeHtml(action.action_id) + '</td><td>' + escapeHtml(action.tool) + '</td><td>' + escapeHtml(action.status) + '</td><td>' + escapeHtml(action.created_at) + '</td><td>' + escapeHtml(JSON.stringify(action.payload)) + '</td><td>' + actionButtons(action) + '</td></tr>').join('');
      document.getElementById('pendingActions').innerHTML = '<div class="summary">' +
        metric('待确认', String(summary.pending_count || 0)) +
        metric('动作总数', String(summary.actions_total || 0)) +
        metric('当前显示', String((summary.actions || []).length)) +
        metric('Provider 调用', '否') +
        '</div><table><thead><tr><th>动作 ID</th><th>工具</th><th>状态</th><th>提交时间</th><th>Payload</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' + boundaryTable(summary.provider_boundary || {});
    }
    function renderShots() {
      const rows = model.state.shots.map(shot => '<tr><td>' + escapeHtml(shot.shot_id) + '</td><td><input value="' + escapeAttr(String(shot.duration_seconds)) + '" onchange="saveShot(\\'' + jsString(shot.shot_id) + '\\', this, 0)"></td><td><textarea onchange="saveShot(\\'' + jsString(shot.shot_id) + '\\', this, 1)">' + escapeHtml(shot.description) + '</textarea></td><td><textarea onchange="saveShot(\\'' + jsString(shot.shot_id) + '\\', this, 2)">' + escapeHtml(shot.video_prompt) + '</textarea></td><td><input value="' + escapeAttr(shot.storyboard_image_artifact_id) + '" onchange="linkArtifact(\\'' + jsString(shot.shot_id) + '\\', this.value)"></td><td>' + escapeHtml(labelStatus(shot.approval_status)) + '<br><button onclick="approveShot(\\'' + jsString(shot.shot_id) + '\\')">批准</button><button onclick="revisionShot(\\'' + jsString(shot.shot_id) + '\\')">需修改</button></td></tr>').join('');
      document.getElementById('shots').innerHTML = '<table><thead><tr><th>镜头</th><th>秒数</th><th>描述</th><th>视频提示词</th><th>媒体 Artifact</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    function renderPackage() {
      const pkg = model.package;
      const rows = pkg.shots.map(shot => '<tr><td>' + escapeHtml(shot.shot_id) + '</td><td>' + escapeHtml(labelStatus(shot.approval_status)) + '</td><td>' + escapeHtml(shot.storyboard_image_artifact_id) + '</td><td>' + escapeHtml(shot.artifact ? labelStatus(shot.artifact.status) : '无') + '</td><td>' + escapeHtml(blockerText(shot.blockers)) + '</td></tr>').join('');
      document.getElementById('package').innerHTML = '<div class="toolbar"><button onclick="validatePackage()">校验</button><button class="primary" onclick="freezePackage()">冻结</button></div>' + validationPanel(pkg.validation) + '<table><thead><tr><th>镜头</th><th>批准状态</th><th>分镜图 Artifact</th><th>Artifact 状态</th><th>阻断项</th></tr></thead><tbody>' + rows + '</tbody></table><pre>' + escapeHtml(historyText(pkg.history)) + '</pre>';
    }
    function renderReview() {
      const review = model.review || { generated_clips: [], regeneration_request_drafts: [], provider_boundary: {} };
      const rows = review.generated_clips.map(item => '<tr><td>' + escapeHtml(item.shot_id) + '</td><td>' + escapeHtml(item.artifact_id) + '</td><td>' + escapeHtml(item.run_id) + '<br>' + escapeHtml(item.run_status) + '</td><td>' + escapeHtml(item.provider_name) + '</td><td>' + escapeHtml(item.ffprobe ? item.ffprobe.status : '未测试') + '</td><td>' + escapeHtml(labelStatus(item.clip_review_status)) + '</td><td>' + escapeHtml(item.accepted_clip_artifact_id || '无') + '</td><td><button onclick="approveClip(\\'' + jsString(item.shot_id) + '\\',\\'' + jsString(item.artifact_id) + '\\')">批准</button><button class="warn" onclick="rejectClip(\\'' + jsString(item.shot_id) + '\\',\\'' + jsString(item.artifact_id) + '\\')">拒绝</button></td></tr>').join('');
      document.getElementById('review').innerHTML = '<div class="summary">' +
        metric('当前显示', String(review.generated_clips.length)) +
        metric('历史总数', String(review.generated_clip_total_available || review.generated_clips.length)) +
        metric('显示上限', String(review.generated_clip_limit || review.generated_clips.length)) +
        metric('重生成草案', String((review.regeneration_request_drafts || []).length)) +
        '</div><table><thead><tr><th>镜头</th><th>Clip Artifact</th><th>Generation Run</th><th>Provider</th><th>ffprobe</th><th>审片状态</th><th>已采纳 Clip</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table><pre>' + escapeHtml(draftText(review.regeneration_request_drafts)) + '</pre>' + boundaryTable(review.provider_boundary || {});
    }
    function renderAssembly() {
      const assembly = model.assembly || { clip_order_preview: [], blockers: [], provider_boundary: {}, confirmation: {} };
      const rows = assembly.clip_order_preview.map(item => '<tr><td>' + escapeHtml(String(item.order)) + '</td><td>' + escapeHtml(item.shot_id) + '</td><td>' + escapeHtml(String(item.duration_seconds)) + ' 秒</td><td>' + escapeHtml(item.accepted_clip_artifact_id || '无') + '</td><td>' + escapeHtml(item.ffprobe ? item.ffprobe.status : '未测试') + '</td><td>' + escapeHtml(blockerText(item.blockers)) + '</td></tr>').join('');
      const finalArtifact = assembly.final_video_artifact;
      const finalTable = finalArtifact ? keyValueTable('最终视频 Artifact', [
        ['Artifact ID', finalArtifact.artifact_id],
        ['存在', yesNo(Boolean(finalArtifact.exists))],
        ['类型', finalArtifact.artifact_type + '/' + finalArtifact.role],
        ['状态', labelStatus(finalArtifact.status)],
        ['文件', finalArtifact.storage_filename],
        ['ffprobe', finalArtifact.ffprobe ? finalArtifact.ffprobe.status : '未测试']
      ]) : keyValueTable('最终视频 Artifact', [['状态', '尚未合成']]);
      document.getElementById('assembly').innerHTML = '<div class="toolbar"><button class="primary" onclick="assembleFinal()" ' + (assembly.ready_for_assembly ? '' : 'disabled') + '>确认合成</button>' +
        (assembly.latest_report_exists ? '<button onclick="openReport(\\'h4_final_assembly_result.json\\')">打开合成报告</button>' : '<button disabled>暂无合成报告</button>') + '</div>' +
        '<div class="summary">' +
        metric('项目', assembly.project_title || assembly.project_id || '未找到') +
        metric('可合成', yesNo(Boolean(assembly.ready_for_assembly))) +
        metric('已采纳 Clip', String(assembly.accepted_clips || 0) + '/' + String(assembly.required_shots || 0)) +
        metric('阻断项', String((assembly.blockers || []).length)) +
        '</div>' +
        keyValueTable('合成硬门', [
          ['项目 ID', assembly.project_id || '无'],
          ['项目状态', assembly.project_status || '未知'],
          ['需要人类确认', assembly.confirmation && assembly.confirmation.required ? '是' : '否'],
          ['阻断项', blockerText(assembly.blockers || [])],
          ['报告路径', assembly.latest_report_exists ? assembly.latest_report_path : '暂无']
        ]) +
        '<table><thead><tr><th>顺序</th><th>镜头</th><th>时长</th><th>已采纳 Clip</th><th>ffprobe</th><th>阻断项</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        finalTable +
        boundaryTable(assembly.provider_boundary || {});
    }
    function renderMemory() {
      const memory = model.memory || { latest_proposal: null, memory_items: [], assets: [], references: [], recall_packs: [], boundary: {} };
      const proposal = memory.latest_proposal;
      const proposalRows = proposal ? proposal.items.map(item => '<tr><td>' + escapeHtml(item.item_type) + '<br>' + escapeHtml(labelStatus(item.status)) + '</td><td><input id="memory_title_' + jsString(item.item_id) + '" value="' + escapeAttr(item.title) + '"><textarea id="memory_content_' + jsString(item.item_id) + '">' + escapeHtml(item.content) + '</textarea></td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td><td><select id="memory_decision_' + jsString(item.item_id) + '"><option value="ignore">不处理</option><option value="approve">批准</option><option value="reject">拒绝</option></select><input id="memory_reject_' + jsString(item.item_id) + '" placeholder="拒绝原因"></td></tr>').join('') : '';
      const memoryRows = (memory.memory_items || []).map(item => '<tr><td>' + escapeHtml(item.memory_item_id) + '</td><td>' + escapeHtml(item.title) + '</td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td></tr>').join('');
      const assetRows = (memory.assets || []).map(item => '<tr><td>' + escapeHtml(item.asset_id) + '</td><td>' + escapeHtml(item.title) + '</td><td>' + escapeHtml(item.artifact_id) + '</td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td></tr>').join('');
      const referenceRows = (memory.references || []).map(item => '<tr><td>' + escapeHtml(item.reference_id) + '</td><td>' + escapeHtml(item.title) + '</td><td>' + escapeHtml(provenanceText(item.provenance)) + '</td></tr>').join('');
      const recallRows = (memory.recall_packs || []).map(item => '<tr><td>' + escapeHtml(item.recall_pack_id) + '</td><td>' + escapeHtml(item.project_id) + '</td><td>' + escapeHtml(item.generated_at) + '</td></tr>').join('');
      document.getElementById('memory').innerHTML = '<div class="toolbar">' +
        (proposal ? '<button class="primary" onclick="confirmMemoryProposal()">确认回存选择</button><button onclick="generateRecallPack()">生成 Recall Pack</button>' : '<button disabled>暂无 Saveback Proposal</button>') +
        '</div><div class="summary">' +
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
      document.getElementById('canary').innerHTML = '<div class="toolbar">' + reportButton + '<button disabled>真实提交需单独授权</button></div>' +
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
      const rows = model.reports.map(report => '<tr><td>' + escapeHtml(report.name) + '</td><td>' + report.size_bytes + '</td><td>' + escapeHtml(report.updated_at) + '</td><td><button onclick="openReport(\\'' + jsString(report.name) + '\\')">打开</button></td></tr>').join('');
      document.getElementById('reports').innerHTML = '<table><thead><tr><th>名称</th><th>字节</th><th>更新时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    async function registerImport(filename) { await api('/api/imports/register', { import_filename: filename, review_status: 'approved_for_media_artifact_handoff' }); }
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
    function metric(label, value) { return '<div class="metric">' + escapeHtml(label) + '<b>' + escapeHtml(String(value)) + '</b></div>'; }
    function keyValueTable(title, rows) {
      return '<table><thead><tr><th colspan="2">' + escapeHtml(title) + '</th></tr></thead><tbody>' +
        rows.map(row => '<tr><td>' + escapeHtml(row[0]) + '</td><td>' + escapeHtml(row[1]) + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function labelStatus(value) { return statusLabels[value] || value || ''; }
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
      if (payload && payload.report && payload.report.storyboard_package_id) lines.push('分镜包 ID：' + payload.report.storyboard_package_id);
      if (payload && payload.validation) {
        lines.push('校验结果：' + (payload.validation.ok ? '通过' : '未通过'));
        lines.push('阻断项：' + blockerText(payload.validation.blockers));
      }
      return lines.join('\\n');
    }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
    function escapeAttr(value) { return escapeHtml(value); }
    function jsString(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
    document.querySelectorAll('nav button').forEach(button => button.onclick = () => show(button.dataset.page));
    document.getElementById('refresh').onclick = load;
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
  if (request.method === "GET" && url.pathname === "/") return sendHtml(response, appHtml());
  if (request.method === "GET" && url.pathname === "/api/bootstrap") return sendJson(response, 200, bootstrapPayload());
  if (request.method === "GET" && url.pathname === "/api/dashboard") return sendJson(response, 200, { ok: true, dashboard: bootstrapPayload().dashboard });
  if (request.method === "GET" && url.pathname === "/api/imports") return sendJson(response, 200, { ok: true, imports: bootstrapPayload().imports });
  if (request.method === "GET" && url.pathname === "/api/webgpt-drafts") return sendJson(response, 200, { ok: true, webgpt_drafts: webGptDraftWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/pending-actions") return sendJson(response, 200, { ok: true, pending_actions: webGptPendingActionWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/shots") return sendJson(response, 200, { ok: true, shots: loadH1WorkbenchState().shots });
  if (request.method === "GET" && url.pathname === "/api/canary") return sendJson(response, 200, { ok: true, canary: h2CanaryWorkbenchSummary() });
  if (request.method === "GET" && url.pathname === "/api/review") {
    return withDb((db) => sendJson(response, 200, { ok: true, review: h3VideoReviewSummary(loadH1WorkbenchState(), db) }));
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
  if (request.method === "GET" && url.pathname.startsWith("/imports/")) return serveImportImage(url.pathname, response);

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
        saveH1WorkbenchState(result.value.state);
        return { ok: true, validation: result.value.validation, state: result.value.state };
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
