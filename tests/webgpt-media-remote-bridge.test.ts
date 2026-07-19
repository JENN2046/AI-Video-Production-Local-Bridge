import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ClientRequest } from "node:http";

import { openReadonlyMediaCapabilityRequest } from "../src/webgpt-cloud/mediaCapability.js";
import {
  armReadonlyMediaGatewayConnectTimeout,
  loadReadonlyMediaGatewayClientOptions,
  ReadonlyMediaGatewayClientError,
  requestReadonlyMediaPlayback
} from "../src/webgpt-cloud/mediaGatewayClient.js";

class FakeConnectRequest extends EventEmitter {
  destroyed_with: Error | null = null;
  destroy(error: Error): void { this.destroyed_with = error; }
}

class FakeConnectSocket extends EventEmitter {
  connecting = true;
}

const keyring = { active: { kid: "remote-bridge-test", key: Buffer.alloc(32, 47) } };
const binding = {
  artifact_id: "artifact_fixture",
  project_id: "project_fixture",
  shot_id: "shot_fixture",
  artifact_type: "image" as const,
  role: "storyboard_image" as const,
  mime_type: "image/png" as const,
  sha256: "a".repeat(64),
  status: "active" as const
};
const input = {
  principal_id: "b".repeat(64),
  issuer_hash: "c".repeat(64),
  project_id: binding.project_id,
  binding,
  snapshot_fingerprint: "d".repeat(64)
};

test("remote media bridge uses a validated pinned address and keeps identifiers inside AES-GCM ciphertext", async () => {
  let posted = 0;
  const grant = await requestReadonlyMediaPlayback({
    origin: "https://media.skmt617.top",
    keyring,
    runtime: {
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      post_pinned_address: async (url, _signal, address, body) => {
        posted += 1;
        assert.equal(url.toString(), "https://media.skmt617.top/internal/v1/capabilities");
        assert.equal(address.address, "8.8.8.8");
        const serialized = Buffer.from(body).toString("utf8");
        assert.equal(serialized.includes(input.project_id), false);
        const payload = openReadonlyMediaCapabilityRequest(JSON.parse(serialized), keyring);
        assert.equal(payload.project_id, input.project_id);
        assert.equal(payload.artifact_id, binding.artifact_id);
        return new Response(JSON.stringify({
          capability_handle: "h".repeat(43),
          expires_at: payload.expires_at
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
    }
  }, input);
  assert.equal(posted, 1);
  assert.equal(grant.playback_url, `https://media.skmt617.top/media/v1/c/${"h".repeat(43)}`);
  assert.equal(grant.snapshot_fingerprint, input.snapshot_fingerprint);
});

test("remote media bridge limits only connection establishment and permits slow gateway hashing", async () => {
  const timedOut = new FakeConnectRequest();
  armReadonlyMediaGatewayConnectTimeout(timedOut as unknown as ClientRequest, 15);
  timedOut.emit("socket", new FakeConnectSocket());
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timedOut.destroyed_with?.message, "MEDIA_GATEWAY_CONNECT_TIMEOUT");

  const connected = new FakeConnectRequest();
  const socket = new FakeConnectSocket();
  armReadonlyMediaGatewayConnectTimeout(connected as unknown as ClientRequest, 15);
  connected.emit("socket", socket);
  socket.connecting = false;
  socket.emit("secureConnect");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connected.destroyed_with, null);
});

test("remote media bridge rejects unsafe DNS, redirects, oversized responses, and malformed handles", async () => {
  let transported = false;
  await assert.rejects(requestReadonlyMediaPlayback({
    origin: "https://media.skmt617.top",
    keyring,
    runtime: {
      resolve_hostname: async () => [{ address: "127.0.0.1", family: 4 }],
      post_pinned_address: async () => { transported = true; return new Response(); }
    }
  }, input), (error) => error instanceof ReadonlyMediaGatewayClientError && error.code === "MEDIA_GATEWAY_UNAVAILABLE");
  assert.equal(transported, false);

  const requestWith = async (response: Response) => requestReadonlyMediaPlayback({
    origin: "https://media.skmt617.top",
    keyring,
    runtime: {
      resolve_hostname: async () => [{ address: "8.8.8.8", family: 4 }],
      post_pinned_address: async () => response
    }
  }, input);
  await assert.rejects(requestWith(new Response("", { status: 302, headers: { location: "https://private.example/" } })),
    (error) => error instanceof ReadonlyMediaGatewayClientError && error.code === "MEDIA_GATEWAY_UNAVAILABLE");
  await assert.rejects(requestWith(new Response("x".repeat(4 * 1024 + 1), {
    status: 201,
    headers: { "content-type": "application/json" }
  })),
    (error) => error instanceof ReadonlyMediaGatewayClientError && error.code === "MEDIA_GATEWAY_UNAVAILABLE");
  await assert.rejects(requestWith(new Response(JSON.stringify({ capability_handle: "short", expires_at: new Date().toISOString() }), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" }
  })),
    (error) => error instanceof ReadonlyMediaGatewayClientError && error.code === "MEDIA_GATEWAY_RESPONSE_INVALID");
  await assert.rejects(requestWith(new Response(JSON.stringify({ capability_handle: "h".repeat(43), expires_at: new Date().toISOString() }), {
    status: 201,
    headers: { "content-type": "text/plain" }
  })), (error) => error instanceof ReadonlyMediaGatewayClientError && error.code === "MEDIA_GATEWAY_RESPONSE_INVALID");
});

test("remote media bridge environment configuration is all-or-nothing and supports a bounded previous key", () => {
  assert.equal(loadReadonlyMediaGatewayClientOptions({}), null);
  assert.throws(() => loadReadonlyMediaGatewayClientOptions({ WEBGPT_MEDIA_GATEWAY_ORIGIN: "https://media.skmt617.top" }),
    (error) => error instanceof ReadonlyMediaGatewayClientError && error.code === "MEDIA_GATEWAY_CONFIG_INVALID");
  assert.throws(() => loadReadonlyMediaGatewayClientOptions({
    WEBGPT_MEDIA_GATEWAY_ORIGIN: "https://other.example",
    WEBGPT_MEDIA_CAPABILITY_ACTIVE_KID: "active",
    WEBGPT_MEDIA_CAPABILITY_ACTIVE_KEY_B64URL: Buffer.alloc(32, 47).toString("base64url")
  }), (error) => error instanceof ReadonlyMediaGatewayClientError && error.code === "MEDIA_GATEWAY_CONFIG_INVALID");
  const encoded = Buffer.alloc(32, 47).toString("base64url");
  const configured = loadReadonlyMediaGatewayClientOptions({
    WEBGPT_MEDIA_GATEWAY_ORIGIN: "https://media.skmt617.top",
    WEBGPT_MEDIA_CAPABILITY_ACTIVE_KID: "active",
    WEBGPT_MEDIA_CAPABILITY_ACTIVE_KEY_B64URL: encoded,
    WEBGPT_MEDIA_CAPABILITY_PREVIOUS_KID: "previous",
    WEBGPT_MEDIA_CAPABILITY_PREVIOUS_KEY_B64URL: Buffer.alloc(32, 48).toString("base64url"),
    WEBGPT_MEDIA_CAPABILITY_PREVIOUS_ACCEPTED_FROM: "2026-07-19T00:00:00.000Z",
    WEBGPT_MEDIA_CAPABILITY_PREVIOUS_ACCEPTED_UNTIL: "2026-07-19T00:10:00.000Z"
  });
  assert.equal(configured?.origin, "https://media.skmt617.top");
  assert.equal(configured?.keyring.previous?.kid, "previous");
});
