import { accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";

import { paths } from "../src/paths.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { loadWebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";
import { resolveFfmpegExecutable, resolveFfprobeExecutable } from "../src/webgpt-v4/media.js";

type Check = { ok: boolean; detail: string };

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

const profileArg = process.argv.find((value) => value.startsWith("--profile="))?.split("=")[1];
const profile = profileArg === "webgpt" ? "webgpt" : "local";
const checks: Record<string, Check> = {};
const [major, minor] = process.versions.node.split(".").map(Number);
checks.node = { ok: major > 22 || (major === 22 && minor >= 5), detail: `Node ${process.versions.node}; minimum is 22.5.0 and CI is pinned to 22` };

try {
  const ffmpeg = await resolveFfmpegExecutable();
  const ffprobe = await resolveFfprobeExecutable(ffmpeg);
  const version = execFileSync(ffmpeg, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 5_000 }).split(/\r?\n/, 1)[0] ?? "";
  checks.ffmpeg = { ok: /ffmpeg version 8\.1\.2(?:[-\s]|$)/i.test(version), detail: `${ffmpeg} (${version})` };
  checks.ffprobe = { ok: true, detail: ffprobe };
} catch {
  checks.ffmpeg = { ok: false, detail: "FFmpeg 8.1.2 was not resolved" };
  checks.ffprobe = { ok: false, detail: "FFprobe was not resolved" };
}

try {
  const db = openM0Database();
  try {
    const quick = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    checks.schema = { ok: quick.quick_check === "ok", detail: quick.quick_check };
  } finally { db.close(); }
} catch (error) {
  checks.schema = { ok: false, detail: error instanceof Error ? error.message : "Schema validation failed" };
}

for (const [name, directory] of Object.entries({ data_directory: paths.dataRoot, media_directory: paths.mediaRoot })) {
  try {
    accessSync(directory, constants.R_OK | constants.W_OK);
    checks[name] = { ok: true, detail: directory };
  } catch { checks[name] = { ok: false, detail: `${directory} is not readable and writable` }; }
}

const ports = profile === "webgpt" ? [2091, 2092] : [4181];
checks.ports = { ok: (await Promise.all(ports.map(portAvailable))).every(Boolean), detail: ports.join(", ") };
if (profile === "webgpt") checks.oauth = { ok: Boolean(loadWebGptV4AuthConfig()), detail: loadWebGptV4AuthConfig() ? "configured" : "not configured (WebGPT remains fail closed)" };
if (process.env.REAL_PROVIDER_ENABLED === "true") checks.provider = { ok: Boolean(process.env.RUNNINGHUB_API_KEY?.trim()), detail: "required only for enabled real-provider lane" };

const ok = Object.values(checks).every((check) => check.ok);
console.log(JSON.stringify({ ok, profile, checks }, null, 2));
process.exitCode = ok ? 0 : 1;
