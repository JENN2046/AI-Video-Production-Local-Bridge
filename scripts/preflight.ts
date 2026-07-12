import { accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";

import { paths } from "../src/paths.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { checkProviderEnv } from "../src/tools/providerEnv.js";
import { loadWebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";
import { resolveFfmpegExecutable, resolveFfprobeExecutable } from "../src/webgpt-v4/media.js";
import { parseWebGptV4Profile } from "../src/webgpt-v4/toolCatalog.js";

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
let webgptProfile: "readonly" | "full" | null = null;
if (profile === "webgpt") {
  try { webgptProfile = parseWebGptV4Profile(process.env.WEBGPT_V4_PROFILE); }
  catch {
    console.log(JSON.stringify({ ok: false, profile, error: { code: "INVALID_WEBGPT_PROFILE", message: "WEBGPT_V4_PROFILE must be readonly or full." } }, null, 2));
    process.exit(1);
  }
}
const checks: Record<string, Check> = {};
const [major, minor] = process.versions.node.split(".").map(Number);
checks.node = { ok: major > 22 || (major === 22 && minor >= 5), detail: `Node ${process.versions.node}; minimum is 22.5.0 and CI is pinned to 22` };

if (profile === "local" || webgptProfile === "full") {
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

const directories = profile === "webgpt" && webgptProfile === "readonly"
  ? { data_directory: paths.dataRoot }
  : { data_directory: paths.dataRoot, media_directory: paths.mediaRoot };
for (const [name, directory] of Object.entries(directories)) {
  try {
    accessSync(directory, constants.R_OK | constants.W_OK);
    checks[name] = { ok: true, detail: directory };
  } catch { checks[name] = { ok: false, detail: `${directory} is not readable and writable` }; }
}

const ports = profile === "webgpt"
  ? webgptProfile === "full"
    ? [Number(process.env.WEBGPT_V4_MCP_PORT || 2091), Number(process.env.WEBGPT_V4_MEDIA_PORT || 2092)]
    : [Number(process.env.WEBGPT_V4_MCP_PORT || 2091)]
  : [Number(process.env.H1_WORKBENCH_PORT || process.env.PORT || 4181)];
checks.ports = { ok: (await Promise.all(ports.map(portAvailable))).every(Boolean), detail: ports.join(", ") };
if (profile === "webgpt") {
  const auth = loadWebGptV4AuthConfig();
  checks.oauth = { ok: Boolean(auth), detail: auth ? "configured" : "not configured (WebGPT remains fail closed)" };
}
if (process.env.REAL_PROVIDER_ENABLED === "true") {
  const provider = checkProviderEnv();
  const ok = provider.result === "PASS" && provider.provider_name === "runninghub";
  checks.provider = { ok, detail: provider.missing.length > 0 ? `missing: ${provider.missing.join(", ")}` : ok ? "real-provider gates configured" : "M1_REAL_PROVIDER must be runninghub" };
}

const ok = Object.values(checks).every((check) => check.ok);
console.log(JSON.stringify({ ok, profile, ...(webgptProfile ? { webgpt_profile: webgptProfile } : {}), checks }, null, 2));
process.exitCode = ok ? 0 : 1;
