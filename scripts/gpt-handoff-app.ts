import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import {
  ensureM0Directories,
  freezeGptHandoffStoryboardPackage,
  GPT_HANDOFF_FREEZE_REPORT,
  paths,
  scanGptHandoffImports,
  validateImageFile
} from "../src/index.js";

const DEFAULT_PORT = 4177;
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

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function latestReport(): unknown {
  const target = join(paths.workspaceRoot, GPT_HANDOFF_FREEZE_REPORT);
  if (!existsSync(target)) return { ok: false, error: { code: "REPORT_NOT_FOUND", message: "No handoff report has been written yet." } };
  return JSON.parse(readFileSync(target, "utf8"));
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
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Import image not found." } });
    return;
  }
  const importsRoot = resolve(paths.importsRoot);
  const target = resolve(importsRoot, filename);
  if (!isPathInside(target, importsRoot) || !existsSync(target)) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Import image not found." } });
    return;
  }
  const linkStat = lstatSync(target);
  if (linkStat.isSymbolicLink()) {
    sendJson(response, 404, { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Import image not found." } });
    return;
  }
  const realTarget = realpathSync(target);
  if (!isPathInside(realTarget, importsRoot) || !statSync(realTarget).isFile()) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Import image not found." } });
    return;
  }
  const validation = validateImageFile(realTarget);
  if (!validation.ok) {
    sendJson(response, 404, { ok: false, error: { code: validation.error_code || "IMAGE_FILE_INVALID", message: "Import image not found." } });
    return;
  }
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  createReadStream(realTarget).pipe(response);
}

function appHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPT Handoff</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; background: #f6f6f3; color: #202124; }
    body { margin: 0; }
    header { height: 52px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; border-bottom: 1px solid #d8d8d2; background: #ffffff; }
    h1 { font-size: 18px; margin: 0; letter-spacing: 0; }
    main { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 52px); }
    aside { border-right: 1px solid #d8d8d2; background: #ffffff; padding: 14px; overflow: auto; }
    section { padding: 16px; overflow: auto; }
    button { border: 1px solid #9a9a90; background: #ffffff; color: #202124; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button.primary { background: #0f766e; color: #ffffff; border-color: #0f766e; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid #b8b8ae; border-radius: 6px; padding: 8px; font: inherit; background: #ffffff; }
    textarea { min-height: 68px; resize: vertical; }
    label { display: block; font-size: 12px; color: #55554d; margin-bottom: 5px; }
    .toolbar { display: flex; gap: 8px; align-items: center; }
    .imports { display: grid; gap: 8px; margin-top: 12px; }
    .import-item { display: grid; grid-template-columns: 56px 1fr; gap: 8px; align-items: center; border: 1px solid #ddddd6; border-radius: 8px; padding: 8px; background: #fafaf8; }
    .import-item img { width: 56px; height: 82px; object-fit: cover; background: #ecece7; }
    .import-name { font-size: 12px; word-break: break-all; }
    .import-meta { font-size: 11px; color: #6a6a61; margin-top: 4px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .shot-table { width: 100%; border-collapse: collapse; margin-top: 14px; table-layout: fixed; }
    th, td { border-bottom: 1px solid #d8d8d2; padding: 8px; vertical-align: top; }
    th { text-align: left; font-size: 12px; color: #55554d; font-weight: 600; }
    .file-cell { width: 180px; font-size: 12px; word-break: break-all; }
    .duration-cell { width: 86px; }
    .actions-cell { width: 76px; }
    pre { margin: 14px 0 0; padding: 12px; background: #202124; color: #f4f4ef; border-radius: 8px; overflow: auto; max-height: 260px; }
    .status { min-height: 20px; font-size: 13px; color: #3f3f38; }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #d8d8d2; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>GPT Handoff</h1>
    <div class="toolbar">
      <button id="refresh">Refresh</button>
      <button id="freeze" class="primary">Freeze Package</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="status" id="status"></div>
      <div class="imports" id="imports"></div>
    </aside>
    <section>
      <div class="grid">
        <div>
          <label for="title">Project title</label>
          <input id="title" value="Web GPT Handoff">
        </div>
        <div>
          <label for="approval">Approval</label>
          <input id="approval" type="checkbox">
        </div>
      </div>
      <table class="shot-table">
        <thead>
          <tr>
            <th class="file-cell">Image</th>
            <th>Description</th>
            <th>Video prompt</th>
            <th>Negative prompt</th>
            <th class="duration-cell">Seconds</th>
            <th class="actions-cell"></th>
          </tr>
        </thead>
        <tbody id="shots"></tbody>
      </table>
      <pre id="result">{}</pre>
    </section>
  </main>
  <script>
    const importsEl = document.getElementById('imports');
    const shotsEl = document.getElementById('shots');
    const resultEl = document.getElementById('result');
    const statusEl = document.getElementById('status');
    const shots = [];

    function setStatus(text) { statusEl.textContent = text; }
    function renderShots() {
      shotsEl.innerHTML = '';
      shots.forEach((shot, index) => {
        const row = document.createElement('tr');
        row.innerHTML = '<td class="file-cell"></td><td></td><td></td><td></td><td class="duration-cell"></td><td class="actions-cell"></td>';
        row.children[0].textContent = shot.import_filename;
        row.children[1].appendChild(field('textarea', shot.shot_description, value => shot.shot_description = value));
        row.children[2].appendChild(field('textarea', shot.video_prompt, value => shot.video_prompt = value));
        row.children[3].appendChild(field('textarea', shot.negative_prompt, value => shot.negative_prompt = value));
        row.children[4].appendChild(field('input', String(shot.duration_seconds), value => shot.duration_seconds = Number(value || 0)));
        const remove = document.createElement('button');
        remove.textContent = 'Remove';
        remove.onclick = () => { shots.splice(index, 1); renderShots(); };
        row.children[5].appendChild(remove);
        shotsEl.appendChild(row);
      });
    }
    function field(tag, value, onChange) {
      const el = document.createElement(tag);
      el.value = value;
      if (tag === 'input') el.type = 'number';
      if (tag === 'input') el.min = '1';
      el.oninput = event => onChange(event.target.value);
      return el;
    }
    function addShot(image) {
      const order = shots.length + 1;
      shots.push({
        import_filename: image.filename,
        order,
        duration_seconds: 2,
        shot_description: 'Shot ' + String(order).padStart(3, '0'),
        video_prompt: 'Animate this keyframe with gentle camera motion.',
        negative_prompt: '',
        continuity_constraints: []
      });
      renderShots();
    }
    async function loadImports() {
      const response = await fetch('/api/imports');
      const payload = await response.json();
      importsEl.innerHTML = '';
      payload.images.forEach(image => {
        const item = document.createElement('div');
        item.className = 'import-item';
        item.innerHTML = '<img alt=""><div><div class="import-name"></div><div class="import-meta"></div><button>Add</button></div>';
        item.querySelector('img').src = '/imports/' + encodeURIComponent(image.filename);
        item.querySelector('.import-name').textContent = image.filename;
        item.querySelector('.import-meta').textContent = image.readable_by_image_validator ? image.width + 'x' + image.height + ' ' + image.mime_type : image.error_code;
        item.querySelector('button').disabled = !image.readable_by_image_validator;
        item.querySelector('button').onclick = () => addShot(image);
        importsEl.appendChild(item);
      });
      setStatus(String(payload.images.length) + ' imports');
    }
    async function freeze() {
      const approved = document.getElementById('approval').checked === true;
      const body = { project_title: document.getElementById('title').value, approved_by_user: approved, shots };
      const response = await fetch('/api/freeze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      resultEl.textContent = JSON.stringify(payload, null, 2);
      setStatus(payload.ok ? 'Frozen' : 'Blocked');
    }
    document.getElementById('refresh').onclick = loadImports;
    document.getElementById('freeze').onclick = freeze;
    loadImports().catch(error => setStatus(error.message));
  </script>
</body>
</html>`;
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, appHtml());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/imports") {
    sendJson(response, 200, { ok: true, images: scanGptHandoffImports() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/report/latest") {
    sendJson(response, 200, latestReport());
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/imports/")) {
    serveImportImage(url.pathname, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/freeze") {
    try {
      const body = await readBody(request);
      const result = freezeGptHandoffStoryboardPackage(body as Parameters<typeof freezeGptHandoffStoryboardPackage>[0]);
      sendJson(response, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: { code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Bad request." } });
    }
    return;
  }
  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });
}

ensureM0Directories();
const startPort = Number(process.env.GPT_HANDOFF_PORT || process.env.PORT || DEFAULT_PORT);
const server = createServer((request, response) => {
  route(request, response).catch((error) => sendJson(response, 500, { ok: false, error: { code: "SERVER_ERROR", message: error instanceof Error ? error.message : "Server error." } }));
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
    console.log(`GPT handoff app listening on http://127.0.0.1:${actualPort}`);
  });
}

listen(startPort);
