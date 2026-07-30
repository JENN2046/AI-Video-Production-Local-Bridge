import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { READONLY_MEDIA_ACCEPTANCE_MAX_SOURCE_BYTES, READONLY_MEDIA_ACCEPTANCE_VARIANT_TRAILER, isReadonlyMediaAcceptanceSourceSizeAllowed } from "../src/webgpt-media-gateway/acceptanceFixtureBudget.js";
import { READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN, READONLY_MEDIA_GATEWAY_MAX_FILE_BYTES, startReadonlyMediaGateway } from "../src/webgpt-media-gateway/runtime.js";
import { exportReadonlySnapshotFromDatabase } from "../src/webgpt-cloud/dataSource.js";
import { openM0DatabaseConnection } from "../src/storage/sqlite.js";

const ISSUER = "https://issuer.acceptance.test/";
const RESOURCE = "https://aivideo.skmt617.top/workspace/mcp";
const SUBJECT = "auth0|media-acceptance-test-subject";

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function windowsPathIdentity(path: string): string {
  const stats = statSync(path, { bigint: true });
  return `${stats.dev.toString(16).toUpperCase().padStart(8, "0")}:${stats.ino.toString(16).toUpperCase().padStart(16, "0")}`;
}

function databaseDirectoryPaths(databasePath: string): string[] {
  const paths: string[] = [];
  let current = dirname(resolve(databasePath));
  for (;;) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths.reverse();
}

function lowDisclosureError(stderr: string): unknown {
  const line = stderr.trim().split(/\r?\n/).reverse().find((candidate) => candidate.startsWith("{"));
  assert.ok(line, "expected a stable JSON error receipt");
  return JSON.parse(line);
}

const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
const matrixExpiryTestEnv: NodeJS.ProcessEnv = {
  ...childEnv,
  NODE_ENV: "test",
  MEDIA_ACCEPTANCE_TEST_HANDLE_EXPIRY_LEAD_MS: "3000"
};

function runChild(command: string, args: string[], input: string, env = childEnv, timeoutMs?: number): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      if (timer) clearTimeout(timer);
      resolveChild({ status, stdout, stderr, timed_out: timedOut });
    });
    child.stdin.end(input);
  });
}

type GatewayProxy = {
  server: ReturnType<typeof createServer>;
  origin: string;
  seenOrigins: Set<string>;
};

type GatewayProxyTransform = (incoming: IncomingMessage, upstream: IncomingMessage, outgoing: ServerResponse) => boolean;

async function startGatewayProxy(targetOrigin: string, transform?: GatewayProxyTransform): Promise<GatewayProxy> {
  const seenOrigins = new Set<string>();
  const server = createServer((incoming, outgoing) => {
    if (typeof incoming.headers.origin === "string") seenOrigins.add(incoming.headers.origin);
    const upstream = httpRequest(new URL(incoming.url ?? "/", targetOrigin), {
      method: incoming.method,
      headers: incoming.headers
    }, (upstreamResponse) => {
      if (transform?.(incoming, upstreamResponse, outgoing)) return;
      outgoing.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [name, value] of Object.entries(upstreamResponse.headers)) if (value !== undefined) outgoing.setHeader(name, value);
      upstreamResponse.pipe(outgoing);
    });
    upstream.once("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else { outgoing.statusCode = 502; outgoing.end(); }
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, origin: `http://127.0.0.1:${address.port}`, seenOrigins };
}

async function startCorsStrippingProxy(targetOrigin: string, strippedHeader: "access-control-allow-origin" | "access-control-allow-credentials"): Promise<GatewayProxy> {
  return startGatewayProxy(targetOrigin, (_incoming, upstream, outgoing) => {
    outgoing.statusCode = upstream.statusCode ?? 502;
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (name.toLowerCase() !== strippedHeader && value !== undefined) outgoing.setHeader(name, value);
    }
    upstream.pipe(outgoing);
    return true;
  });
}

async function startCapabilityExpiryBypassProxy(targetOrigin: string): Promise<GatewayProxy & { expiredHandleRequests: () => number }> {
  let expiredHandleRequests = 0;
  const proxy = await startGatewayProxy(targetOrigin, (incoming, upstream, outgoing) => {
    if (upstream.statusCode !== 404 || !/^\/media\/v1\/c\/[A-Za-z0-9_-]{43}$/.test(incoming.url ?? "")) return false;
    expiredHandleRequests += 1;
    upstream.resume();
    const payload = JSON.stringify({ ok: true });
    outgoing.writeHead(302, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
      "access-control-allow-origin": READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN,
      "access-control-allow-credentials": "true"
    });
    outgoing.end(payload);
    return true;
  });
  return { ...proxy, expiredHandleRequests: () => expiredHandleRequests };
}

async function startRevokedIssuanceBypassProxy(targetOrigin: string): Promise<GatewayProxy & { rewrittenIssuances: () => number }> {
  let rewrittenIssuances = 0;
  const proxy = await startGatewayProxy(targetOrigin, (incoming, upstream, outgoing) => {
    if (upstream.statusCode !== 404 || incoming.method !== "POST" || incoming.url !== "/internal/v1/capabilities") {
      return false;
    }
    const chunks: Buffer[] = [];
    upstream.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    upstream.on("end", () => {
      const body = Buffer.concat(chunks);
      let code = "";
      try {
        code = String((JSON.parse(body.toString("utf8")) as { error?: { code?: string } }).error?.code ?? "");
      } catch {
        // Forward malformed upstream failures unchanged so the matrix retains control of response validation.
      }
      if (code !== "MEDIA_AUTHORIZATION_DENIED") {
        outgoing.statusCode = upstream.statusCode ?? 502;
        for (const [name, value] of Object.entries(upstream.headers)) if (value !== undefined) outgoing.setHeader(name, value);
        outgoing.end(body);
        return;
      }
      rewrittenIssuances += 1;
      const payload = JSON.stringify({
        capability_handle: "A".repeat(43),
        expires_at: new Date(Date.now() + 60_000).toISOString()
      });
      outgoing.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(payload))
      });
      outgoing.end(payload);
    });
    return true;
  });
  return { ...proxy, rewrittenIssuances: () => rewrittenIssuances };
}

async function startOversizeRangeProxy(targetOrigin: string): Promise<GatewayProxy & { rangeRequests: () => number }> {
  let rangeRequests = 0;
  const proxy = await startGatewayProxy(targetOrigin, (incoming, upstream, outgoing) => {
    if (upstream.statusCode !== 206 || typeof incoming.headers.range !== "string" || !/^\/media\/v1\/s\/[A-Za-z0-9_-]{43}$/.test(incoming.url ?? "")) return false;
    rangeRequests += 1;
    upstream.resume();
    outgoing.writeHead(200, {
      "content-type": "video/mp4",
      "access-control-allow-origin": READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN,
      "access-control-allow-credentials": "true"
    });
    outgoing.write(Buffer.alloc(17));
    setImmediate(() => { if (!outgoing.destroyed) outgoing.end(Buffer.alloc(17)); });
    return true;
  });
  return { ...proxy, rangeRequests: () => rangeRequests };
}

async function startOversizeCapabilityJsonProxy(targetOrigin: string): Promise<GatewayProxy & { capabilityRequests: () => number }> {
  let capabilityRequests = 0;
  const proxy = await startGatewayProxy(targetOrigin, (incoming, upstream, outgoing) => {
    if (upstream.statusCode !== 201 || incoming.method !== "POST" || incoming.url !== "/internal/v1/capabilities") return false;
    capabilityRequests += 1;
    upstream.resume();
    outgoing.writeHead(201, { "content-type": "application/json; charset=utf-8" });
    outgoing.write(Buffer.alloc(8 * 1024, 0x20));
    setImmediate(() => { if (!outgoing.destroyed) outgoing.end(Buffer.alloc(9 * 1024, 0x20)); });
    return true;
  });
  return { ...proxy, capabilityRequests: () => capabilityRequests };
}

async function startShortCapabilityExpiryProxy(targetOrigin: string): Promise<GatewayProxy & { rewrittenResponses: () => number }> {
  let rewrittenResponses = 0;
  const proxy = await startGatewayProxy(targetOrigin, (incoming, upstream, outgoing) => {
    if (upstream.statusCode !== 201 || incoming.method !== "POST" || incoming.url !== "/internal/v1/capabilities") {
      return false;
    }
    const chunks: Buffer[] = [];
    upstream.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    upstream.on("end", () => {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      value.expires_at = new Date(Date.now() + 5_000).toISOString();
      const payload = JSON.stringify(value);
      outgoing.statusCode = 201;
      for (const [name, headerValue] of Object.entries(upstream.headers)) {
        if (name.toLowerCase() !== "content-length" && headerValue !== undefined) outgoing.setHeader(name, headerValue);
      }
      outgoing.setHeader("content-length", String(Buffer.byteLength(payload)));
      outgoing.end(payload);
      rewrittenResponses += 1;
    });
    return true;
  });
  return { ...proxy, rewrittenResponses: () => rewrittenResponses };
}

async function startWrongJsonContentTypeProxy(
  targetOrigin: string,
  target: "capability" | "replay"
): Promise<GatewayProxy & { rewrittenResponses: () => number }> {
  let rewrittenResponses = 0;
  const proxy = await startGatewayProxy(targetOrigin, (incoming, upstream, outgoing) => {
    const capabilityResponse = target === "capability"
      && incoming.method === "POST"
      && incoming.url === "/internal/v1/capabilities"
      && upstream.statusCode === 201;
    const replayResponse = target === "replay"
      && incoming.method === "GET"
      && /^\/media\/v1\/c\/[A-Za-z0-9_-]{43}$/.test(incoming.url ?? "")
      && upstream.statusCode === 409;
    if (!capabilityResponse && !replayResponse) return false;
    rewrittenResponses += 1;
    outgoing.statusCode = upstream.statusCode ?? 502;
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (name.toLowerCase() !== "content-type" && value !== undefined) outgoing.setHeader(name, value);
    }
    outgoing.setHeader("content-type", "text/plain; charset=utf-8");
    upstream.pipe(outgoing);
    return true;
  });
  return { ...proxy, rewrittenResponses: () => rewrittenResponses };
}

async function startUnterminatedHealthProxy(targetOrigin: string): Promise<GatewayProxy & { healthRequests: () => number; closedHealthBodies: () => number }> {
  let healthRequests = 0;
  let closedHealthBodies = 0;
  const proxy = await startGatewayProxy(targetOrigin, (incoming, upstream, outgoing) => {
    if (upstream.statusCode !== 200 || incoming.url !== "/healthz") return false;
    healthRequests += 1;
    upstream.resume();
    outgoing.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    const bodyTimer = setInterval(() => {
      if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.write(".");
    }, 25);
    outgoing.once("close", () => {
      clearInterval(bodyTimer);
      closedHealthBodies += 1;
    });
    outgoing.write("ok");
    return true;
  });
  return { ...proxy, healthRequests: () => healthRequests, closedHealthBodies: () => closedHealthBodies };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

test("SQLite path guards run before readonly export queries and writable connection pragmas", () => {
  const root = mkdtempSync(join(tmpdir(), "media-acceptance-database-guard-"));
  const databasePath = join(root, "app.sqlite");
  writeFileSync(databasePath, "");
  try {
    const readonlyGuard = new Error("READONLY_GUARD");
    let readonlyGuardCalls = 0;
    assert.throws(() => exportReadonlySnapshotFromDatabase({
      database_path: databasePath,
      issuer_hash: "0".repeat(64),
      resource_url: RESOURCE
    }, {
      assertDatabaseCurrent: () => {
        readonlyGuardCalls += 1;
        throw readonlyGuard;
      }
    }), (error) => error === readonlyGuard);
    assert.equal(readonlyGuardCalls, 1);

    const writableGuard = new Error("WRITABLE_GUARD");
    let writableGuardCalls = 0;
    assert.throws(() => openM0DatabaseConnection(databasePath, {
      assertPathCurrent: () => {
        writableGuardCalls += 1;
        throw writableGuard;
      }
    }), (error) => error === writableGuard);
    assert.equal(writableGuardCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("media database path guard rejects a lease identity mismatch before reporting LOCKED", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "media-database-identity-guard-"));
  const databasePath = join(root, "app.sqlite");
  writeFileSync(databasePath, "database", "utf8");
  writeFileSync(`${databasePath}-wal`, "");
  writeFileSync(`${databasePath}-shm`, "");
  try {
    const invalidIdentity = "00000000:0000000000000000";
    const directoryIdentities = databaseDirectoryPaths(databasePath).map(windowsPathIdentity);
    const result = await runChild("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "RemoteSigned",
      "-File", resolve("scripts/windows/media-database-path-guard.ps1")
    ], `${databasePath}\n${[invalidIdentity, invalidIdentity, invalidIdentity].join(",")}\n${directoryIdentities.join(",")}\n`, childEnv, 45_000);
    assert.equal(result.timed_out, false);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("media database path guard prevents an ancestor directory rebind while LOCKED", { skip: process.platform !== "win32" }, async () => {
  const outerRoot = mkdtempSync(join(tmpdir(), "media-database-ancestor-guard-"));
  const acceptanceRoot = join(outerRoot, "acceptance");
  const runRoot = join(acceptanceRoot, "run");
  const movedAcceptanceRoot = join(outerRoot, "acceptance-moved");
  mkdirSync(runRoot, { recursive: true });
  const databasePath = join(runRoot, "app.sqlite");
  const protectedPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  writeFileSync(databasePath, "database", "utf8");
  writeFileSync(`${databasePath}-wal`, "");
  writeFileSync(`${databasePath}-shm`, "");
  const fileIdentities = protectedPaths.map(windowsPathIdentity);
  const directoryIdentities = databaseDirectoryPaths(databasePath).map(windowsPathIdentity);
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "RemoteSigned",
    "-File", resolve("scripts/windows/media-database-path-guard.ps1")
  ], { cwd: process.cwd(), windowsHide: true, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<number | null>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", resolveClose);
  });
  const locked = new Promise<void>((resolveLock, rejectLock) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectLock(new Error("DATABASE_GUARD_LOCK_TIMEOUT"));
    }, 45_000);
    child.stdout.on("data", () => {
      if (settled || !stdout.includes("\n")) return;
      settled = true;
      clearTimeout(timer);
      if (/^LOCKED\r?\n$/.test(stdout)) resolveLock();
      else rejectLock(new Error("DATABASE_GUARD_LOCK_INVALID"));
    });
    child.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectLock(new Error("DATABASE_GUARD_LOCK_FAILED"));
    });
  });
  child.stdin.write(`${databasePath}\n${fileIdentities.join(",")}\n${directoryIdentities.join(",")}\n`);
  try {
    await locked;
    assert.throws(() => renameSync(acceptanceRoot, movedAcceptanceRoot), (error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      return ["EACCES", "EBUSY", "EPERM"].includes(code);
    });
    child.stdin.end("RELEASE\n");
    assert.equal(await closed, 0);
    assert.match(stdout, /^LOCKED\r?\n$/);
    assert.equal(stderr, "");
    renameSync(acceptanceRoot, movedAcceptanceRoot);
    renameSync(movedAcceptanceRoot, acceptanceRoot);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed.catch(() => undefined);
    }
    rmSync(outerRoot, { recursive: true, force: true });
  }
});

test("MP4 acceptance fixture and generated profiles are isolated, contract-valid, source-preserving, and low disclosure", () => {
  const wrapper = readFileSync(resolve("scripts/windows/media-create-acceptance-fixture.ps1"), "utf8");
  const matrixWrapper = readFileSync(resolve("scripts/windows/media-run-acceptance-matrix.ps1"), "utf8");
  const databaseGuard = readFileSync(resolve("scripts/windows/media-database-path-guard.ps1"), "utf8");
  const matrixSource = readFileSync(resolve("scripts/webgpt-media-acceptance-matrix.ts"), "utf8");
  const runbook = readFileSync(resolve("docs/webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md"), "utf8");
  assert.match(wrapper, /Read-Host "Auth0 user_id\/sub \(input hidden\)" -AsSecureString/);
  assert.doesNotMatch(wrapper, /-MaskInput/);
  assert.match(wrapper, /SecureStringToBSTR\(\$secureSubject\)/);
  assert.match(wrapper, /ZeroFreeBSTR\(\$bstr\)/);
  assert.match(runbook, /npm --silent run media:fixture:create --/);
  assert.match(runbook, /npm --silent run media:fixture:verify --/);
  assert.match(runbook, /npm --silent run media:fixture:profiles --/);
  assert.match(runbook, /npm --silent run media:fixture:matrix --/);
  assert.match(runbook, /approximately 15-minute-35-second stop condition/);
  assert.match(runbook, /eight capability requests/);
  assert.doesNotMatch(runbook, /approximately 14-minute-35-second stop condition/);
  assert.doesNotMatch(runbook, /`npm run media:fixture:(?:create|verify|profiles|matrix)/);
  assert.match(matrixWrapper, /Unprotect-MediaBytes \$profile\.CapabilityKeyPath/);
  assert.match(matrixWrapper, /\$encodedKey \| & \$node\.NodePath/);
  assert.doesNotMatch(matrixWrapper, /--key|Write-MediaJson.*encodedKey/);
  assert.match(matrixWrapper, /\$candidate = \[string\]\$_\.Exception\.Message/);
  assert.match(matrixWrapper, /MEDIA_ACCEPTANCE_WRAPPER_FAILED/);
  assert.doesNotMatch(matrixWrapper, /stable_error_code\s*=\s*\$_\.Exception\.Message/);
  assert.match(databaseGuard, /FileShareRead \| FileShareWrite/);
  assert.doesNotMatch(databaseGuard, /FileShareDelete/);
  assert.match(databaseGuard, /FileFlagOpenReparsePoint/);
  assert.match(databaseGuard, /information\.NumberOfLinks != 1/);
  assert.match(databaseGuard, /information\.VolumeSerialNumber\.ToString\("X8"\)/);
  assert.match(databaseGuard, /fileIndex\.ToString\("X16"\)/);
  assert.match(databaseGuard, /expectedFileIdentities\.Count -ne 3/);
  assert.match(databaseGuard, /expectedDirectoryIdentities\.Count -lt 1/);
  assert.match(databaseGuard, /OpenProtectedDirectory/);
  assert.match(databaseGuard, /DirectoryIdentity\(\$handle\) -cne/);
  assert.match(databaseGuard, /Identity\(\$handle\) -cne/);
  assert.match(databaseGuard, /"\$databasePath-wal"/);
  assert.match(databaseGuard, /"\$databasePath-shm"/);
  assert.match(databaseGuard, /WriteLine\("LOCKED"\)/);
  assert.doesNotMatch(databaseGuard, /Write-(?:Host|Output|Verbose|Debug|Error)/);
  assert.match(matrixSource, /READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN/);
  assert.match(matrixSource, /READONLY_MEDIA_GATEWAY_HASH_TIMEOUT_MS \+ 15_000/);
  assert.match(matrixSource, /READONLY_MEDIA_CAPABILITY_TTL_MS/);
  assert.match(matrixSource, /MEDIA_ACCEPTANCE_RESPONSE_TOO_LARGE/);
  assert.match(matrixSource, /JSON_RESPONSE_MAX_BYTES/);
  assert.match(matrixSource, /isApplicationJsonResponse\(response\)/);
  assert.match(matrixSource, /split\(";", 1\)\[0\]\?\.trim\(\)\.toLowerCase\(\) === "application\/json"/);
  assert.match(matrixSource, /MANIFEST_MAX_BYTES = 16 \* 1024/);
  assert.match(matrixSource, /MANIFEST_NOFOLLOW_FLAG/);
  assert.match(matrixSource, /openSync\(manifestPath, constants\.O_RDONLY \| MANIFEST_NOFOLLOW_FLAG\)/);
  assert.match(matrixSource, /fstatSync\(descriptor, \{ bigint: true \}\)/);
  assert.match(matrixSource, /descriptorStats\.dev !== pathStats\.dev/);
  assert.match(matrixSource, /descriptorStats\.ino !== pathStats\.ino/);
  assert.match(matrixSource, /descriptorStats\.nlink !== 1n/);
  assert.match(matrixSource, /pathStats\.nlink !== 1n/);
  assert.match(matrixSource, /finalStats\.nlink !== 1n/);
  assert.match(matrixSource, /relative\(realpathSync\(root\), manifestReal\)/);
  assert.doesNotMatch(matrixSource, /openSync\(manifestReal/);
  assert.doesNotMatch(matrixSource, /readFileSync\(manifestReal/);
  assert.match(matrixSource, /openDatabaseLease\(root, databasePath\)/);
  assert.match(matrixSource, /acquireDatabasePathGuard\(databaseLease\)/);
  assert.match(matrixSource, /databasePathGuard\.assertHolding\(\)/);
  assert.match(matrixSource, /await databasePathGuard\.release\(\)/);
  assert.match(matrixSource, /await databasePathGuard\.release\(\);[\s\S]*closeDatabaseLease\(databaseLease\);[\s\S]*console\.log\(JSON\.stringify\(passReceipt\)\)/);
  assert.doesNotMatch(matrixSource, /console\.log\(JSON\.stringify\(\{\s*result: "PASS"/);
  assert.match(matrixSource, /assertDatabaseLeaseCurrent\(databaseLease\)/);
  assert.match(matrixSource, /databaseLease\.sidecars/);
  assert.match(matrixSource, /databaseGuardIdentity/);
  assert.match(matrixSource, /\{ assertDatabaseCurrent \}/);
  assert.match(matrixSource, /\{ assertPathCurrent: assertDatabaseCurrent \}/);
  assert.match(matrixSource, /openExpectedMediaFile\(root, media\)/);
  assert.match(matrixSource, /openSync\(path, constants\.O_RDONLY \| MANIFEST_NOFOLLOW_FLAG\)/);
  assert.match(matrixSource, /assertMediaFileLeaseCurrent\(lease\)/);
  assert.match(matrixSource, /readSync\(lease\.descriptor/);
  assert.doesNotMatch(matrixSource, /openSync\(path, "r"\)/);
  assert.match(matrixSource, /MATRIX_CAPABILITY_REQUESTS = DISTINCT_MEDIA_VALIDATIONS \+ 4/);
  assert.match(matrixSource, /MATRIX_ORDINARY_REQUESTS = 2 \+ DISTINCT_MEDIA_VALIDATIONS \* 3 \+ 4/);
  assert.match(matrixSource, /MATRIX_CAPABILITY_REQUESTS \* CAPABILITY_REQUEST_TIMEOUT_MS/);
  assert.match(matrixSource, /MATRIX_ORDINARY_REQUESTS \* REQUEST_TIMEOUT_MS/);
  assert.match(matrixSource, /MATRIX_EXPIRY_WAIT_ALLOWANCE_MS/);
  assert.match(matrixSource, /MATRIX_LOCAL_SETUP_ALLOWANCE_MS/);
  assert.match(matrixSource, /clearTimeout\(requestTimer\)/);
  assert.match(matrixSource, /async function discardResponseBody/);
  assert.match(matrixSource, /await discardResponseBody\(response\)/);
  assert.doesNotMatch(matrixSource, /AbortSignal\.timeout\(/);
  assert.doesNotMatch(matrixSource, /process\.exit\(/);
  assert.doesNotMatch(matrixSource, /response\.arrayBuffer\(\)/);
  assert.doesNotMatch(matrixSource, /response\.json\(\)/);

  const source = resolve("fixtures/video/mock_clip.mp4");
  const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const before = { sha256: sha(source), size: statSync(source).size, mtimeMs: statSync(source).mtimeMs };
  const created = spawnSync(process.execPath, [command, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { result: string; run_id: string; checks: Record<string, boolean> };
  assert.equal(receipt.result, "PASS");
  assert.match(receipt.run_id, /^run_[0-9a-f]{32}$/);
  assert.deepEqual(receipt.checks, {
    source_unchanged: true,
    ledger_0011: true,
    mp4_valid: true,
    snapshot_v4: true,
    media_binding: true,
    project_switch_fixture: true,
    image_fixture: true,
    webm_support: false
  });
  assert.equal(created.stdout.includes(SUBJECT), false);
  assert.equal(created.stdout.includes(source), false);
  assert.doesNotMatch(created.stdout, /[0-9a-f]{64}/);
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  try {
    const verified = spawnSync(process.execPath, [command, "verify", "--run", receipt.run_id, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(verified.status, 0, verified.stderr);
    const verification = JSON.parse(verified.stdout) as { result: string; checks: Record<string, boolean>; project_count: number; media_binding_count: number };
    assert.equal(verification.result, "PASS");
    assert.deepEqual(verification.checks, {
      schema: true,
      database_manifest: true,
      media_digest: true,
      snapshot_v4: true,
      media_binding: true,
      project_switch_fixture: true,
      image_fixture: true,
      webm_support: false
    });
    assert.equal(verification.project_count, 2);
    assert.equal(verification.media_binding_count, 4);
    assert.equal(verified.stdout.includes(SUBJECT), false);
    assert.doesNotMatch(verified.stdout, /[0-9a-f]{64}/);

    const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as {
      issuer_hash: string;
      projects: Array<{ media: Array<{ media_relative_path: string }> }>;
    };
    const publisherTemplatePath = join(root, "publisher-template.json");
    const gatewayTemplatePath = join(root, "gateway-template.json");
    const invalidPublisherTemplatePath = join(root, "publisher-template-invalid.json");
    const wrongIssuerPublisherTemplatePath = join(root, "publisher-template-wrong-issuer.json");
    const publisherTemplate = {
      profile_version: "readonly-publisher-profile-v1",
      database_path: "data/app.sqlite",
      issuer: ISSUER,
      resource_url: RESOURCE,
      snapshot_url: "https://aivideo.skmt617.top/workspace/snapshot",
      key_id: "acceptance-publisher-v1",
      protected_private_key_path: "data/webgpt/publisher/key.dpapi",
      public_key_path: "data/webgpt/publisher/public.pem",
      receipts_directory: "data/webgpt/publisher/receipts",
      ttl_seconds: 86400
    };
    writeFileSync(publisherTemplatePath, JSON.stringify(publisherTemplate), "utf8");
    writeFileSync(invalidPublisherTemplatePath, JSON.stringify({
      ...publisherTemplate,
      protected_key_path: publisherTemplate.protected_private_key_path,
      receipt_directory: publisherTemplate.receipts_directory,
      protected_private_key_path: undefined,
      receipts_directory: undefined
    }), "utf8");
    writeFileSync(wrongIssuerPublisherTemplatePath, JSON.stringify({ ...publisherTemplate, issuer: "https://other-issuer.acceptance.test/" }), "utf8");
    writeFileSync(gatewayTemplatePath, JSON.stringify({
      profile_version: "readonly-media-operations-profile-v1",
      database_path: "data/app.sqlite",
      issuer_hash: manifest.issuer_hash,
      allowed_origin: "https://aivideo.skmt617.top",
      gateway_port: 2092,
      media_roots: ["data/media"],
      capability_key: { kid: "acceptance-media-v1", protected_path: "data/webgpt/media-gateway/key.dpapi" },
      cloudflared: {
        executable_path: "ops/tools/cloudflared/cloudflared.exe",
        manifest_path: "ops/manifests/cloudflared.json",
        protected_token_path: "data/webgpt/media-gateway/token.dpapi",
        public_health_url: "https://media.skmt617.top/healthz"
      },
      runtime_directory: "data/webgpt/media-gateway/runtime"
    }), "utf8");

    const invalidProfiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", invalidPublisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(invalidProfiles.status, 1);
    assert.deepEqual(lowDisclosureError(invalidProfiles.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID" });

    const wrongIssuerProfiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", wrongIssuerPublisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(wrongIssuerProfiles.status, 1);
    assert.deepEqual(lowDisclosureError(wrongIssuerProfiles.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID" });

    const profiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", publisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(profiles.status, 0, profiles.stderr);
    const profileReceipt = JSON.parse(profiles.stdout) as { result: string; action: string; run_id: string; checks: Record<string, boolean> };
    assert.deepEqual(profileReceipt, {
      result: "PASS",
      action: "profiles",
      run_id: receipt.run_id,
      checks: { publisher_profile: true, gateway_profile: true, git_ignored: true, secret_values_copied: false }
    });
    assert.doesNotMatch(profiles.stdout, /[0-9a-f]{64}|\.dpapi|https:\/\//);
    const generatedPublisher = JSON.parse(readFileSync(join(root, "publisher-profile.json"), "utf8")) as Record<string, unknown>;
    const generatedGateway = JSON.parse(readFileSync(join(root, "gateway-profile.json"), "utf8")) as Record<string, unknown>;
    assert.equal(generatedPublisher.protected_private_key_path, publisherTemplate.protected_private_key_path);
    assert.equal(typeof generatedPublisher.receipts_directory, "string");
    assert.equal("protected_key_path" in generatedPublisher, false);
    assert.equal("receipt_directory" in generatedPublisher, false);
    assert.match(String(generatedPublisher.database_path), new RegExp(`${receipt.run_id}/app\\.sqlite$`));
    assert.match(String(generatedPublisher.receipts_directory), new RegExp(`${receipt.run_id}/publisher-receipts$`));
    assert.match(String(generatedGateway.database_path), new RegExp(`${receipt.run_id}/app\\.sqlite$`));
    assert.deepEqual(generatedGateway.media_roots, [`data/webgpt/media-acceptance/${receipt.run_id}/media`]);
    assert.match(String(generatedGateway.runtime_directory), new RegExp(`${receipt.run_id}/gateway-runtime$`));
    const repeatedProfiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", publisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(repeatedProfiles.status, 1);
    assert.deepEqual(lowDisclosureError(repeatedProfiles.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_PROFILE_EXISTS" });

    appendFileSync(resolve(root, manifest.projects[0]!.media[1]!.media_relative_path), Buffer.from([0]));
    const drifted = spawnSync(process.execPath, [command, "verify", "--run", receipt.run_id, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(drifted.status, 1);
    assert.deepEqual(lowDisclosureError(drifted.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_INTEGRITY_FAILED" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const after = { sha256: sha(source), size: statSync(source).size, mtimeMs: statSync(source).mtimeMs };
  assert.deepEqual(after, before);
});

test("MP4 acceptance fixture accepts only the legacy or Unified MCP resource paths", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const rejected = spawnSync(process.execPath, [command, "create", "--input", source, "--issuer", ISSUER, "--resource", "https://aivideo.skmt617.top/other/mcp"], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(rejected.status, 1);
  assert.deepEqual(lowDisclosureError(rejected.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_URL_INVALID" });
});

test("MP4 acceptance fixture reserves the fixed tail variant within the Gateway file-size limit", () => {
  assert.equal(READONLY_MEDIA_ACCEPTANCE_MAX_SOURCE_BYTES + READONLY_MEDIA_ACCEPTANCE_VARIANT_TRAILER.byteLength, READONLY_MEDIA_GATEWAY_MAX_FILE_BYTES);
  assert.equal(isReadonlyMediaAcceptanceSourceSizeAllowed(READONLY_MEDIA_ACCEPTANCE_MAX_SOURCE_BYTES), true);
  assert.equal(isReadonlyMediaAcceptanceSourceSizeAllowed(READONLY_MEDIA_ACCEPTANCE_MAX_SOURCE_BYTES + 1), false);
});

test("media acceptance matrix proves image, byte-range, replay, expiry, project switching, and revocation with low disclosure", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const createReceipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", createReceipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 37);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  const proxy = await startUnterminatedHealthProxy(gateway.url);
  try {
    const result = await runChild(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", createReceipt.run_id,
      "--origin", `${proxy.origin}/`,
      "--kid", "acceptance-matrix-v1"
    ], `${key.toString("base64url")}\n`, matrixExpiryTestEnv, 20_000);
    assert.equal(result.timed_out, false, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      result: "PASS",
      action: "matrix",
      run_id: createReceipt.run_id,
      checks: {
        gateway_ready: true,
        widget_cors: true,
        image_200: true,
        mp4_range_206: true,
        project_switch: true,
        capability_replay: true,
        capability_expiry: true,
        membership_revocation: true,
        unaffected_project_retained: true,
        webm_support: false
      }
    });
    assert.equal(proxy.healthRequests(), 1);
    assert.equal(proxy.closedHealthBodies(), 1);
    assert.doesNotMatch(result.stdout, /[0-9a-f]{64}|https?:\/\/|media\/v1\/[cs]\//);
  } finally {
    await closeServer(proxy.server);
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects a video hard-linked outside the fixture root during its atomic open", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as {
    issuer_hash: string;
    projects: Array<{ media: Array<{ media_relative_path: string; mime_type: string }> }>;
  };
  const video = manifest.projects[0]!.media.find((media) => media.mime_type === "video/mp4");
  assert.ok(video);
  const videoPath = resolve(root, video.media_relative_path);
  const external = mkdtempSync(join(resolve(root, ".."), "external-video-hardlink-race-"));
  const externalVideo = join(external, "private.mp4");
  const preloadPath = join(external, "swap-video-before-open.cjs");
  copyFileSync(videoPath, externalVideo);
  const externalBefore = sha(externalVideo);
  writeFileSync(preloadPath, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalOpenSync = fs.openSync;
let swapped = false;
fs.openSync = function(path, ...args) {
  if (!swapped && typeof path === "string" && path === process.env.MEDIA_ACCEPTANCE_TEST_VIDEO_PATH) {
    swapped = true;
    fs.unlinkSync(path);
    fs.linkSync(process.env.MEDIA_ACCEPTANCE_TEST_EXTERNAL_VIDEO, path);
  }
  return originalOpenSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`, "utf8");
  const key = Buffer.alloc(32, 38);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-media-lease-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  try {
    const result = await runChild(process.execPath, [
      "--require", preloadPath,
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${gateway.url}/`,
      "--kid", "acceptance-matrix-media-lease-v1"
    ], `${key.toString("base64url")}\n`, {
      ...matrixExpiryTestEnv,
      MEDIA_ACCEPTANCE_TEST_VIDEO_PATH: videoPath,
      MEDIA_ACCEPTANCE_TEST_EXTERNAL_VIDEO: externalVideo
    });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    assert.equal(statSync(videoPath).nlink, 2);
    assert.equal(sha(externalVideo), externalBefore);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("media acceptance matrix prevents a path swap from rebinding the writable SQLite connection", { skip: process.platform !== "win32" }, async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const databasePath = join(root, "app.sqlite");
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const external = mkdtempSync(join(resolve(root, ".."), "external-database-swap-race-"));
  const externalDatabase = join(external, "private.sqlite");
  const parkedDatabase = join(external, "parked.sqlite");
  const markerPath = join(external, "attack-result.txt");
  const preloadPath = join(external, "swap-sqlite-during-open.cjs");
  copyFileSync(databasePath, externalDatabase);
  const externalBefore = sha(externalDatabase);
  writeFileSync(preloadPath, `
const fs = require("node:fs");
const sqlite = require("node:sqlite");
const { syncBuiltinESMExports } = require("node:module");
const OriginalDatabaseSync = sqlite.DatabaseSync;
let databaseOpens = 0;
sqlite.DatabaseSync = new Proxy(OriginalDatabaseSync, {
  construct(target, args, newTarget) {
    if (args[0] !== process.env.MEDIA_ACCEPTANCE_TEST_DATABASE_PATH) {
      return Reflect.construct(target, args, newTarget);
    }
    databaseOpens += 1;
    if (databaseOpens !== 2) return Reflect.construct(target, args, newTarget);
    let moved = false;
    let linked = false;
    try {
      fs.renameSync(args[0], process.env.MEDIA_ACCEPTANCE_TEST_PARKED_DATABASE);
      moved = true;
      fs.linkSync(process.env.MEDIA_ACCEPTANCE_TEST_EXTERNAL_DATABASE, args[0]);
      linked = true;
      const database = Reflect.construct(target, args, newTarget);
      fs.unlinkSync(args[0]);
      linked = false;
      fs.renameSync(process.env.MEDIA_ACCEPTANCE_TEST_PARKED_DATABASE, args[0]);
      moved = false;
      fs.writeFileSync(process.env.MEDIA_ACCEPTANCE_TEST_ATTACK_MARKER, "SWAPPED", "utf8");
      return database;
    } catch (error) {
      if (linked) fs.unlinkSync(args[0]);
      if (moved) fs.renameSync(process.env.MEDIA_ACCEPTANCE_TEST_PARKED_DATABASE, args[0]);
      if (!error || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
      fs.writeFileSync(process.env.MEDIA_ACCEPTANCE_TEST_ATTACK_MARKER, "BLOCKED", "utf8");
      return Reflect.construct(target, args, newTarget);
    }
  }
});
syncBuiltinESMExports();
`, "utf8");
  const key = Buffer.alloc(32, 39);
  const gateway = await startReadonlyMediaGateway({
    database_path: databasePath,
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-database-guard-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  try {
    const result = await runChild(process.execPath, [
      "--require", preloadPath,
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${gateway.url}/`,
      "--kid", "acceptance-matrix-database-guard-v1"
    ], `${key.toString("base64url")}\n`, {
      ...matrixExpiryTestEnv,
      MEDIA_ACCEPTANCE_TEST_DATABASE_PATH: databasePath,
      MEDIA_ACCEPTANCE_TEST_EXTERNAL_DATABASE: externalDatabase,
      MEDIA_ACCEPTANCE_TEST_PARKED_DATABASE: parkedDatabase,
      MEDIA_ACCEPTANCE_TEST_ATTACK_MARKER: markerPath
    }, 25_000);
    assert.equal(result.timed_out, false, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(markerPath, "utf8"), "BLOCKED");
    assert.equal(sha(externalDatabase), externalBefore);
    assert.doesNotMatch(result.stdout, /[0-9a-f]{64}|https?:\/\/|media\/v1\/[cs]\//);
  } finally {
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects hard-linked SQLite sidecars before opening the database", { skip: process.platform !== "win32" }, async () => {
  for (const [index, suffix] of ["-wal", "-shm"].entries()) {
    const source = resolve("fixtures/video/mock_clip.mp4");
    const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
    const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(created.status, 0, created.stderr);
    const receipt = JSON.parse(created.stdout) as { run_id: string };
    const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
    const databasePath = join(root, "app.sqlite");
    const sidecarPath = `${databasePath}${suffix}`;
    const external = mkdtempSync(join(resolve(root, ".."), "external-database-sidecar-"));
    const externalSidecar = join(external, `private.sqlite${suffix}`);
    writeFileSync(externalSidecar, "private-sidecar", "utf8");
    const externalBefore = sha(externalSidecar);
    if (existsSync(sidecarPath)) unlinkSync(sidecarPath);
    linkSync(externalSidecar, sidecarPath);
    const key = Buffer.alloc(32, 41 + index);
    try {
      const result = await runChild(process.execPath, [
        resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
        "--run", receipt.run_id,
        "--origin", "http://127.0.0.1:9/",
        "--kid", `acceptance-matrix-sidecar-guard-${index + 1}`
      ], `${key.toString("base64url")}\n`, matrixExpiryTestEnv, 10_000);
      assert.equal(result.timed_out, false, result.stderr);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.deepEqual(lowDisclosureError(result.stderr), {
        result: "FAIL",
        stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE"
      });
      assert.equal(statSync(sidecarPath).nlink, 2);
      assert.equal(sha(externalSidecar), externalBefore);
      assert.doesNotMatch(result.stderr, /private-sidecar|https?:\/\/|media\/v1\/[cs]\//);
    } finally {
      key.fill(0);
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }
});

test("media acceptance matrix emits no PASS when the database guard refuses release", { skip: process.platform !== "win32" }, async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const external = mkdtempSync(join(resolve(root, ".."), "database-guard-release-refusal-"));
  const markerPath = join(external, "release-result.txt");
  const preloadPath = join(external, "refuse-database-guard-release.cjs");
  writeFileSync(preloadPath, `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (Array.isArray(args) && args.some((value) => typeof value === "string" && value.endsWith("media-database-path-guard.ps1"))) {
    const originalEnd = child.stdin.end.bind(child.stdin);
    child.stdin.end = function(chunk, ...rest) {
      if (String(chunk) === "RELEASE\\n") {
        fs.writeFileSync(process.env.MEDIA_ACCEPTANCE_TEST_RELEASE_MARKER, "REFUSED", "utf8");
        return originalEnd("REFUSE\\n", ...rest);
      }
      return originalEnd(chunk, ...rest);
    };
  }
  return child;
};
syncBuiltinESMExports();
`, "utf8");
  const key = Buffer.alloc(32, 40);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-guard-release-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  try {
    const result = await runChild(process.execPath, [
      "--require", preloadPath,
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${gateway.url}/`,
      "--kid", "acceptance-matrix-guard-release-v1"
    ], `${key.toString("base64url")}\n`, {
      ...matrixExpiryTestEnv,
      MEDIA_ACCEPTANCE_TEST_RELEASE_MARKER: markerPath
    }, 25_000);
    assert.equal(result.timed_out, false, result.stderr);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(markerPath, "utf8"), "REFUSED");
    assert.deepEqual(lowDisclosureError(result.stderr), {
      result: "FAIL",
      stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE"
    });
    assert.doesNotMatch(result.stderr, /[0-9a-f]{64}|https?:\/\/|media\/v1\/[cs]\//);
  } finally {
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("media acceptance matrix uses the Widget sandbox Origin and rejects missing CORS response headers", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 93);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-cors-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  try {
    for (const strippedHeader of ["access-control-allow-origin", "access-control-allow-credentials"] as const) {
      const proxy = await startCorsStrippingProxy(gateway.url, strippedHeader);
      try {
        const result = await runChild(process.execPath, [
          resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
          "--run", receipt.run_id,
          "--origin", `${proxy.origin}/`,
          "--kid", "acceptance-matrix-cors-v1"
        ], `${key.toString("base64url")}\n`);
        assert.equal(result.status, 1);
        assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_CORS_FAILED" });
        assert.equal(proxy.seenOrigins.has(READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN), true);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
      } finally {
        await closeServer(proxy.server);
      }
    }
  } finally {
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix proves an issued capability handle expires before accepting its expiry check", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 121);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-expiry-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  const proxy = await startCapabilityExpiryBypassProxy(gateway.url);
  try {
    const result = await runChild(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${proxy.origin}/`,
      "--kid", "acceptance-matrix-expiry-v1"
    ], `${key.toString("base64url")}\n`, matrixExpiryTestEnv);
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_EXPIRY_FAILED" });
    assert.equal(proxy.expiredHandleRequests(), 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    await closeServer(proxy.server);
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects capability issuance that succeeds after membership revocation", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 43);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-revoked-issuance-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  const proxy = await startRevokedIssuanceBypassProxy(gateway.url);
  try {
    const result = await runChild(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${proxy.origin}/`,
      "--kid", "acceptance-matrix-revoked-issuance-v1"
    ], `${key.toString("base64url")}\n`, matrixExpiryTestEnv);
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), {
      result: "FAIL",
      stable_error_code: "MEDIA_ACCEPTANCE_REVOCATION_FAILED"
    });
    assert.equal(proxy.rewrittenIssuances(), 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /[0-9a-f]{64}|https?:\/\/|media\/v1\/[cs]\//);
  } finally {
    await closeServer(proxy.server);
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix bounds a streamed response that ignores the requested video range", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 122);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-range-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  const proxy = await startOversizeRangeProxy(gateway.url);
  try {
    const result = await runChild(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${proxy.origin}/`,
      "--kid", "acceptance-matrix-range-v1"
    ], `${key.toString("base64url")}\n`);
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_RESPONSE_TOO_LARGE" });
    assert.equal(proxy.rangeRequests(), 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    await closeServer(proxy.server);
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix bounds a chunked JSON response before parsing it", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 123);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-json-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  const proxy = await startOversizeCapabilityJsonProxy(gateway.url);
  try {
    const result = await runChild(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${proxy.origin}/`,
      "--kid", "acceptance-matrix-json-v1"
    ], `${key.toString("base64url")}\n`);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_RESPONSE_TOO_LARGE" });
    assert.equal(proxy.capabilityRequests(), 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    await closeServer(proxy.server);
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects an ordinary capability response with a shortened expiry", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 44);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-short-expiry-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  const proxy = await startShortCapabilityExpiryProxy(gateway.url);
  try {
    const result = await runChild(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", `${proxy.origin}/`,
      "--kid", "acceptance-matrix-short-expiry-v1"
    ], `${key.toString("base64url")}\n`, matrixExpiryTestEnv);
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), {
      result: "FAIL",
      stable_error_code: "MEDIA_ACCEPTANCE_RESPONSE_INVALID"
    });
    assert.equal(proxy.rewrittenResponses(), 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /[0-9a-f]{64}|https?:\/\/|media\/v1\/[cs]\//);
  } finally {
    await closeServer(proxy.server);
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects non-JSON Content-Type on capability and other JSON control responses", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string };
  const key = Buffer.alloc(32, 124);
  const gateway = await startReadonlyMediaGateway({
    database_path: join(root, "app.sqlite"),
    issuer_hash: manifest.issuer_hash,
    keyring: { active: { kid: "acceptance-matrix-json-content-type-v1", key } },
    allowed_origin: "https://aivideo.skmt617.top",
    allowed_media_roots: [join(root, "media")],
    port: 0
  });
  try {
    for (const target of ["capability", "replay"] as const) {
      const proxy = await startWrongJsonContentTypeProxy(gateway.url, target);
      try {
        const result = await runChild(process.execPath, [
          resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
          "--run", receipt.run_id,
          "--origin", `${proxy.origin}/`,
          "--kid", "acceptance-matrix-json-content-type-v1"
        ], `${key.toString("base64url")}\n`, matrixExpiryTestEnv);
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(lowDisclosureError(result.stderr), {
          result: "FAIL",
          stable_error_code: "MEDIA_ACCEPTANCE_RESPONSE_INVALID"
        });
        assert.equal(proxy.rewrittenResponses(), 1);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
      } finally {
        await closeServer(proxy.server);
      }
    }
  } finally {
    await gateway.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix wrapper normalizes ordinary PowerShell exceptions", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "media-acceptance-wrapper-"));
  const wrapperPath = resolve("scripts/windows/media-run-acceptance-matrix.ps1");
  const commonPath = resolve("scripts/windows/media-runtime-common.ps1").replace(/'/g, "''");
  const privateMarker = "C:\\private\\matrix-wrapper-test";
  const wrapper = readFileSync(wrapperPath, "utf8")
    .replace('. (Join-Path $PSScriptRoot "media-runtime-common.ps1")', `. '${commonPath}'`)
    .replace('$runRoot = Resolve-MediaInsideWorkspace (Join-Path "data\\webgpt\\media-acceptance" $RunId)', `throw '${privateMarker}'`);
  assert.notEqual(wrapper, readFileSync(wrapperPath, "utf8"));
  const injectedPath = join(root, "media-run-acceptance-matrix.ps1");
  try {
    writeFileSync(injectedPath, wrapper, "utf8");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", injectedPath, "-RunId", "run_00000000000000000000000000000000"], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 10_000, env: childEnv
    });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_WRAPPER_FAILED" });
    assert.equal(`${result.stdout}${result.stderr}`.includes(privateMarker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects a linked manifest before reading it", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const external = mkdtempSync(join(tmpdir(), "media-acceptance-manifest-"));
  const manifestPath = join(root, "fixture.json");
  const externalManifest = join(external, "fixture.json");
  try {
    writeFileSync(externalManifest, readFileSync(manifestPath));
    unlinkSync(manifestPath);
    symlinkSync(externalManifest, manifestPath, "file");
    const result = spawnSync(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", "http://127.0.0.1:2092/",
      "--kid", "acceptance-matrix-v1"
    ], { cwd: process.cwd(), input: `${Buffer.alloc(32).toString("base64url")}\n`, encoding: "utf8", windowsHide: true, env: childEnv });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects a manifest replaced by a link during open", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const external = mkdtempSync(join(tmpdir(), "media-acceptance-manifest-race-"));
  const manifestPath = join(root, "fixture.json");
  const externalManifest = join(external, "fixture.json");
  const preloadPath = join(external, "swap-before-open.cjs");
  try {
    writeFileSync(externalManifest, readFileSync(manifestPath));
    writeFileSync(preloadPath, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalOpenSync = fs.openSync;
let swapped = false;
fs.openSync = function(path, ...args) {
  if (!swapped && typeof path === "string" && path === process.env.MEDIA_ACCEPTANCE_TEST_MANIFEST_PATH) {
    swapped = true;
    fs.unlinkSync(path);
    fs.symlinkSync(process.env.MEDIA_ACCEPTANCE_TEST_EXTERNAL_MANIFEST, path, "file");
  }
  return originalOpenSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`, "utf8");
    const result = spawnSync(process.execPath, [
      "--require", preloadPath,
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", "http://127.0.0.1:2092/",
      "--kid", "acceptance-matrix-v1"
    ], {
      cwd: process.cwd(),
      input: `${Buffer.alloc(32).toString("base64url")}\n`,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...childEnv,
        MEDIA_ACCEPTANCE_TEST_MANIFEST_PATH: manifestPath,
        MEDIA_ACCEPTANCE_TEST_EXTERNAL_MANIFEST: externalManifest
      }
    });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects a manifest hard-linked from outside the fixture root", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const external = mkdtempSync(join(resolve(root, ".."), "external-hardlink-"));
  const manifestPath = join(root, "fixture.json");
  const externalManifest = join(external, "private.json");
  try {
    writeFileSync(externalManifest, readFileSync(manifestPath));
    unlinkSync(manifestPath);
    linkSync(externalManifest, manifestPath);
    assert.equal(statSync(manifestPath).nlink, 2);
    const result = spawnSync(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", "http://127.0.0.1:2092/",
      "--kid", "acceptance-matrix-v1"
    ], { cwd: process.cwd(), input: `${Buffer.alloc(32).toString("base64url")}\n`, encoding: "utf8", windowsHide: true, env: childEnv });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects an acceptance database hard-linked from outside the fixture root", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const external = mkdtempSync(join(resolve(root, ".."), "external-database-hardlink-"));
  const databasePath = join(root, "app.sqlite");
  const externalDatabase = join(external, "private.sqlite");
  try {
    copyFileSync(databasePath, externalDatabase);
    const externalBefore = sha(externalDatabase);
    unlinkSync(databasePath);
    linkSync(externalDatabase, databasePath);
    assert.equal(statSync(databasePath).nlink, 2);
    const result = spawnSync(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", "http://127.0.0.1:2092/",
      "--kid", "acceptance-matrix-v1"
    ], { cwd: process.cwd(), input: `${Buffer.alloc(32).toString("base64url")}\n`, encoding: "utf8", windowsHide: true, env: childEnv });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    assert.equal(sha(externalDatabase), externalBefore);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("media acceptance matrix rejects an oversized manifest before reading it", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifestPath = join(root, "fixture.json");
  try {
    writeFileSync(manifestPath, Buffer.alloc(16 * 1024 + 1, 0x20));
    const result = spawnSync(process.execPath, [
      resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
      "--run", receipt.run_id,
      "--origin", "http://127.0.0.1:2092/",
      "--kid", "acceptance-matrix-v1"
    ], { cwd: process.cwd(), input: `${Buffer.alloc(32).toString("base64url")}\n`, encoding: "utf8", windowsHide: true, env: childEnv });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_MANIFEST_TOO_LARGE" });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance fixture verify rejects manifest metadata that differs from database and Snapshot bindings", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [command, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifestPath = join(root, "fixture.json");
  type FixtureManifest = {
    projects: Array<{
      project_id: string;
      shot_id: string;
      media: Array<{
        artifact_id: string;
        blob_id: string;
        mime_type: "image/png" | "image/jpeg" | "video/mp4";
        role: "storyboard_image" | "generated_clip";
      }>;
    }>;
  };
  try {
    const original = JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest;
    const cases: Array<{ name: string; mutate: (manifest: FixtureManifest) => void }> = [
      {
        name: "mime type",
        mutate: (manifest) => {
          const image = manifest.projects[0]!.media.find((media) => media.role === "storyboard_image");
          assert.ok(image);
          image.mime_type = image.mime_type === "image/png" ? "image/jpeg" : "image/png";
        }
      },
      {
        name: "artifact role and media kind",
        mutate: (manifest) => {
          const image = manifest.projects[0]!.media.find((media) => media.role === "storyboard_image");
          const video = manifest.projects[0]!.media.find((media) => media.role === "generated_clip");
          assert.ok(image && video);
          [image.role, video.role] = [video.role, image.role];
          [image.mime_type, video.mime_type] = [video.mime_type, image.mime_type];
        }
      },
      {
        name: "shot id",
        mutate: (manifest) => {
          [manifest.projects[0]!.shot_id, manifest.projects[1]!.shot_id] = [
            manifest.projects[1]!.shot_id,
            manifest.projects[0]!.shot_id
          ];
        }
      },
      {
        name: "blob id",
        mutate: (manifest) => {
          const firstImage = manifest.projects[0]!.media.find((media) => media.role === "storyboard_image");
          const secondImage = manifest.projects[1]!.media.find((media) => media.role === "storyboard_image");
          assert.ok(firstImage && secondImage);
          [firstImage.blob_id, secondImage.blob_id] = [secondImage.blob_id, firstImage.blob_id];
        }
      }
    ];
    for (const testCase of cases) {
      const altered = structuredClone(original);
      testCase.mutate(altered);
      writeFileSync(manifestPath, JSON.stringify(altered), "utf8");
      const result = spawnSync(process.execPath, [command, "verify", "--run", receipt.run_id, "--issuer", ISSUER, "--resource", RESOURCE], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
      });
      assert.equal(result.status, 1, `${testCase.name}: ${result.stderr}`);
      assert.deepEqual(
        lowDisclosureError(result.stderr),
        { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_SNAPSHOT_INVALID" },
        testCase.name
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance fixture verify rejects media bindings swapped between projects", () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [command, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const manifestPath = join(root, "fixture.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      projects: Array<{ media: unknown[] }>;
    };
    const firstMedia = manifest.projects[0]!.media;
    manifest.projects[0]!.media = manifest.projects[1]!.media;
    manifest.projects[1]!.media = firstMedia;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const result = spawnSync(process.execPath, [command, "verify", "--run", receipt.run_id, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_SNAPSHOT_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("media acceptance matrix maps request and overall stalls to stable bounded failures", async () => {
  const source = resolve("fixtures/video/mock_clip.mp4");
  const fixtureCommand = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const created = spawnSync(process.execPath, [fixtureCommand, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { run_id: string };
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  const server = createServer(() => { /* Deliberately hold response headers open. */ });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const args = [
    resolve("dist/scripts/webgpt-media-acceptance-matrix.js"),
    "--run", receipt.run_id,
    "--origin", `http://127.0.0.1:${address.port}/`,
    "--kid", "acceptance-matrix-v1"
  ];
  const keyInput = `${Buffer.alloc(32).toString("base64url")}\n`;
  try {
    const requestTimeout = await runChild(process.execPath, args, keyInput, {
      ...childEnv,
      NODE_ENV: "test",
      MEDIA_ACCEPTANCE_TEST_REQUEST_TIMEOUT_MS: "100",
      MEDIA_ACCEPTANCE_TEST_MATRIX_TIMEOUT_MS: "5000"
    });
    assert.equal(requestTimeout.status, 1);
    assert.deepEqual(lowDisclosureError(requestTimeout.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_REQUEST_TIMEOUT" });

    const matrixTimeout = await runChild(process.execPath, args, keyInput, {
      ...childEnv,
      NODE_ENV: "test",
      MEDIA_ACCEPTANCE_TEST_REQUEST_TIMEOUT_MS: "1000",
      MEDIA_ACCEPTANCE_TEST_MATRIX_TIMEOUT_MS: "100"
    });
    assert.equal(matrixTimeout.status, 1);
    assert.deepEqual(lowDisclosureError(matrixTimeout.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_MATRIX_TIMEOUT" });
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("MP4 acceptance fixture rejects a symlinked acceptance root", () => {
  const workspace = mkdtempSync(join(tmpdir(), "media-acceptance-workspace-"));
  const external = mkdtempSync(join(tmpdir(), "media-acceptance-external-"));
  const dataRoot = join(workspace, "data", "webgpt");
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "data/\n", "utf8");
  symlinkSync(external, join(dataRoot, "media-acceptance"), process.platform === "win32" ? "junction" : "dir");
  try {
    const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
    const source = resolve("fixtures/video/mock_clip.mp4");
    const result = spawnSync(process.execPath, [command, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: workspace, input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("MP4 acceptance fixture verify rejects symlinked run and nested paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "media-acceptance-verify-workspace-"));
  const external = mkdtempSync(join(tmpdir(), "media-acceptance-verify-external-"));
  const acceptanceRoot = join(workspace, "data", "webgpt", "media-acceptance");
  mkdirSync(acceptanceRoot, { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "data/\n", "utf8");
  spawnSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
  const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const runId = "run_00000000000000000000000000000000";
  const runPath = join(acceptanceRoot, runId);
  try {
    symlinkSync(external, runPath, process.platform === "win32" ? "junction" : "dir");
    const linkedRun = spawnSync(process.execPath, [command, "verify", "--run", runId, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: workspace, encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(linkedRun.status, 1);
    assert.deepEqual(lowDisclosureError(linkedRun.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    unlinkSync(runPath);

    mkdirSync(runPath, { recursive: true });
    const linkedData = join(runPath, "linked-data");
    writeFileSync(join(runPath, "app.sqlite"), "not-a-database", "utf8");
    writeFileSync(join(external, "fixture.mp4"), "not-a-video", "utf8");
    symlinkSync(external, linkedData, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(runPath, "fixture.json"), JSON.stringify({
      fixture_version: "readonly-media-acceptance-fixture-v1",
      run_id: runId,
      database_file: "app.sqlite",
      project_id: "project_fixture",
      shot_id: "shot_fixture",
      artifact_id: "artifact_fixture",
      blob_id: "blob_fixture",
      issuer_hash: "0".repeat(64),
      resource_url: RESOURCE,
      media_relative_path: "linked-data/fixture.mp4",
      media_sha256: "0".repeat(64),
      database_manifest: "0".repeat(64)
    }), "utf8");
    const linkedNested = spawnSync(process.execPath, [command, "verify", "--run", runId, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: workspace, encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(linkedNested.status, 1);
    assert.deepEqual(lowDisclosureError(linkedNested.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
