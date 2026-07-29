import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { READONLY_MEDIA_ACCEPTANCE_MAX_SOURCE_BYTES, READONLY_MEDIA_ACCEPTANCE_VARIANT_TRAILER, isReadonlyMediaAcceptanceSourceSizeAllowed } from "../src/webgpt-media-gateway/acceptanceFixtureBudget.js";
import { READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN, READONLY_MEDIA_GATEWAY_MAX_FILE_BYTES, startReadonlyMediaGateway } from "../src/webgpt-media-gateway/runtime.js";

const ISSUER = "https://issuer.acceptance.test/";
const RESOURCE = "https://aivideo.skmt617.top/workspace/mcp";
const SUBJECT = "auth0|media-acceptance-test-subject";

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

test("MP4 acceptance fixture and generated profiles are isolated, contract-valid, source-preserving, and low disclosure", () => {
  const wrapper = readFileSync(resolve("scripts/windows/media-create-acceptance-fixture.ps1"), "utf8");
  const matrixWrapper = readFileSync(resolve("scripts/windows/media-run-acceptance-matrix.ps1"), "utf8");
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
  assert.doesNotMatch(runbook, /`npm run media:fixture:(?:create|verify|profiles|matrix)/);
  assert.match(matrixWrapper, /Unprotect-MediaBytes \$profile\.CapabilityKeyPath/);
  assert.match(matrixWrapper, /\$encodedKey \| & \$node\.NodePath/);
  assert.doesNotMatch(matrixWrapper, /--key|Write-MediaJson.*encodedKey/);
  assert.match(matrixWrapper, /\$candidate = \[string\]\$_\.Exception\.Message/);
  assert.match(matrixWrapper, /MEDIA_ACCEPTANCE_WRAPPER_FAILED/);
  assert.doesNotMatch(matrixWrapper, /stable_error_code\s*=\s*\$_\.Exception\.Message/);
  assert.match(matrixSource, /READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN/);
  assert.match(matrixSource, /READONLY_MEDIA_GATEWAY_HASH_TIMEOUT_MS \+ 15_000/);
  assert.match(matrixSource, /READONLY_MEDIA_CAPABILITY_TTL_MS/);
  assert.match(matrixSource, /MEDIA_ACCEPTANCE_RESPONSE_TOO_LARGE/);
  assert.match(matrixSource, /JSON_RESPONSE_MAX_BYTES/);
  assert.match(matrixSource, /MANIFEST_MAX_BYTES = 16 \* 1024/);
  assert.match(matrixSource, /fstatSync\(descriptor\)/);
  assert.doesNotMatch(matrixSource, /readFileSync\(manifestReal/);
  assert.match(matrixSource, /MATRIX_CAPABILITY_REQUESTS = DISTINCT_MEDIA_VALIDATIONS \+ 3/);
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
