import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { issuerHash, type WebGptV4Actor } from "../src/webgpt-v4/types.js";
import { READONLY_WORKBENCH_RESOURCE_MIME, READONLY_WORKBENCH_RESOURCE_URI, READONLY_WORKBENCH_RENDER_TOOL } from "../src/webgpt-cloud/appContract.js";
import { startReadonlyRemoteRuntime } from "../src/webgpt-cloud/remoteRuntime.js";

const ISSUER = "https://auth.example.test/";
const RESOURCE = "https://aivideo.example.test/mcp";
const ACTOR: WebGptV4Actor = {
  principal_id: "a".repeat(64), actor_hash: "a".repeat(64), issuer_hash: issuerHash(ISSUER), scopes: new Set(["projects.read"])
};

test("Apps smoke discovers seven readonly tools, reads the UI resource, and renders an empty authenticated shell", async () => {
  const pair = generateKeyPairSync("ed25519");
  const runtime = await startReadonlyRemoteRuntime({
    port: 0,
    auth_config: {
      provider: "federated", access_model: "project_membership", issuer: ISSUER, issuer_hash: issuerHash(ISSUER),
      audience: RESOURCE, resource_url: RESOURCE, jwks_uri: "https://auth.example.test/.well-known/jwks.json",
      client_registration: "predefined", configuration_source: "generic"
    },
    authenticate: async () => ACTOR,
    publisher_key_id: "publisher-smoke-v1",
    publisher_public_key: pair.publicKey
  });
  const client = new Client({ name: "readonly-apps-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    assert.equal(tools.tools.some((tool) => tool.name === READONLY_WORKBENCH_RENDER_TOOL), true);
    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === READONLY_WORKBENCH_RESOURCE_URI && resource.mimeType === READONLY_WORKBENCH_RESOURCE_MIME), true);
    const resource = await client.readResource({ uri: READONLY_WORKBENCH_RESOURCE_URI });
    assert.equal(resource.contents[0]?.mimeType, READONLY_WORKBENCH_RESOURCE_MIME);
    const rendered = await client.callTool({ name: READONLY_WORKBENCH_RENDER_TOOL, arguments: {} });
    const shell = rendered.structuredContent as { app_state?: string };
    assert.equal(shell.app_state, "no_snapshot");
  } finally {
    await transport.close();
    await runtime.close();
  }
});
