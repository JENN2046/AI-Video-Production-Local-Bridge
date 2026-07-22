import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { directorBaseStateHash, directorContentHash } from "../src/director/domain.js";
import {
  createDirectorNativeMcpServer,
  DIRECTOR_FORBIDDEN_TOOL_NAMES,
  DIRECTOR_MANUAL_IMPORT_SCHEMA,
  DIRECTOR_NATIVE_TOOL_NAMES,
  DIRECTOR_TOOL_RESULT_MAX_BYTES,
  type DirectorNativeToolHandlers
} from "../src/director/mcpContract.js";
import {
  createDirectorOAuthAuthenticator,
  directorProtectedResourceMetadata,
  directorProtectedResourceMetadataUrl,
  directorWwwAuthenticate,
  loadDirectorOAuthConfig
} from "../src/director/oauth.js";
import { issuerHash, principalIdFromFederatedSubject, WebGptV4Error } from "../src/webgpt-v4/types.js";

const hash = "a".repeat(64);
const now = "2026-07-22T01:00:00.000Z";
const focus = {
  focus_id: "focus_native_001",
  project_id: "project_director_001",
  target_type: "shot" as const,
  target_id: "shot_director_001",
  generation: 3,
  created_at: now,
  expires_at: "2026-07-22T02:00:00.000Z"
};
const targetState = {
  schema_version: "director-domain-v1" as const,
  proposal_kind: "review_assessment" as const,
  project: {
    project_id: focus.project_id,
    status: "video_review" as const,
    lifecycle_state: "active" as const,
    video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "1080x1920" },
    creative_direction_hash: null,
    current_storyboard_package_id: null,
    current_storyboard_package_hash: null
  },
  target_shot: {
    shot_id: focus.target_id,
    project_id: focus.project_id,
    order: 1,
    status: "video_review" as const,
    duration_seconds: 5,
    storyboard_artifact_id: "artifact_storyboard_001",
    storyboard_artifact_sha256: hash,
    accepted_clip_artifact_id: null,
    accepted_clip_artifact_sha256: null,
    prompt_hash: hash,
    negative_prompt_hash: hash,
    continuity_hash: hash,
    current_generation_input_hash: hash,
    current_review_decision_event_id: null
  },
  adjacent_shots: [],
  target_artifact: {
    artifact_id: "artifact_clip_001",
    project_id: focus.project_id,
    shot_id: focus.target_id,
    artifact_type: "video" as const,
    role: "generated_clip" as const,
    status: "active" as const,
    sha256: hash
  },
  generation: {
    prepared_intent_id: null,
    frozen_input_hash: null,
    latest_run_id: "run_001",
    latest_job_state: "succeeded" as const
  }
};

function handlers(): DirectorNativeToolHandlers {
  const baseStateHash = directorBaseStateHash(targetState);
  return {
    async get_director_focus() {
      return { state: "active", focus };
    },
    async get_director_context() {
      return {
        state: "ready",
        context_version: "director-context-v1",
        focus,
        base_state_hash: baseStateHash,
        target_state: targetState,
        discussion: {
          project: {
            project_id: focus.project_id,
            title: "Fixture Project",
            status: "video_review",
            lifecycle_state: "active",
            brief_summary: "Bounded fixture summary.",
            creative_direction: "Natural movement and accurate product geometry.",
            video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "1080x1920" }
          },
          target_shot: {
            shot_id: focus.target_id,
            order: 1,
            status: "video_review",
            duration_seconds: 5,
            description: "Fixture SHOT",
            storyboard_prompt: "Fixture storyboard prompt",
            video_prompt: "Fixture video prompt",
            negative_prompt: "No deformation",
            continuity_constraints: ["Keep product geometry stable"]
          },
          adjacent_shots: [],
          target_artifact: {
            artifact_id: "artifact_clip_001",
            shot_id: focus.target_id,
            artifact_type: "video",
            role: "generated_clip",
            status: "active",
            mime_type: "video/mp4",
            sha256: hash
          },
          review_history: [],
          memory_recall: { state: "disabled", items: [] }
        }
      };
    },
    async inspect_director_video_frames() {
      return {
        state: "ready",
        focus_id: focus.focus_id,
        focus_generation: focus.generation,
        project_id: focus.project_id,
        artifact_id: "artifact_clip_001",
        mime_type: "video/mp4",
        duration_seconds: 5,
        base_state_hash: baseStateHash,
        frames: [{ sequence: 0, timestamp_seconds: 0, width: 1080, height: 1920, sha256: hash }],
        truncated: false
      };
    },
    async submit_director_proposal(input) {
      return {
        state: "accepted_for_human_review",
        proposal_id: "proposal_native_001",
        kind: input.proposal.kind,
        focus_id: input.focus_id,
        focus_generation: input.focus_generation,
        base_state_hash: input.base_state_hash,
        payload_hash: directorContentHash(input.proposal.payload),
        source: "native",
        created_at: now
      };
    },
    async get_director_proposal_status(input) {
      return { proposal_id: input.proposal_id, state: "pending_review", reason_code: null, updated_at: now };
    }
  };
}

test("Director native registry exposes only the fixed advisory tool set with exact OAuth scopes", async () => {
  const actor = {
    principal_id: hash,
    actor_hash: hash,
    issuer_hash: "b".repeat(64),
    scopes: new Set(["projects.read", "media.read", "proposals.write"])
  };
  const server = createDirectorNativeMcpServer(actor, handlers());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "director-registry-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...DIRECTOR_NATIVE_TOOL_NAMES]);
    assert.equal(listed.tools.some((tool) => (DIRECTOR_FORBIDDEN_TOOL_NAMES as readonly string[]).includes(tool.name)), false);
    const expectedScopes = new Map([
      ["get_director_focus", ["projects.read"]],
      ["get_director_context", ["projects.read"]],
      ["inspect_director_video_frames", ["projects.read", "media.read"]],
      ["submit_director_proposal", ["projects.read", "proposals.write"]],
      ["get_director_proposal_status", ["projects.read"]]
    ]);
    for (const tool of listed.tools) {
      const scopes = expectedScopes.get(tool.name)!;
      assert.deepEqual((tool._meta as Record<string, unknown>).securitySchemes, [{ type: "oauth2", scopes }]);
      assert.deepEqual((tool._meta as Record<string, unknown>).ui, { visibility: ["model"] });
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.annotations?.readOnlyHint, tool.name !== "submit_director_proposal");
    }
    const focusResult = await client.callTool({ name: "get_director_focus", arguments: {} });
    assert.equal(focusResult.isError, false);
    assert.equal((focusResult.structuredContent as { state: string }).state, "active");
    assert.equal(JSON.stringify(focusResult).includes("principal_id"), false);
    assert.equal(JSON.stringify(focusResult).includes("workspace_id"), false);
    const acceptedProposal = await client.callTool({
      name: "submit_director_proposal",
      arguments: {
        focus_id: focus.focus_id,
        focus_generation: focus.generation,
        base_state_hash: directorBaseStateHash(targetState),
        idempotency_key: "director-native-proposal-001",
        proposal: {
          kind: "review_assessment",
          payload: {
            shot_id: focus.target_id,
            artifact_id: "artifact_clip_001",
            diagnosis: "Motion is too abrupt.",
            evidence: [],
            recommended_disposition: "regenerate",
            prompt_delta: "Slow the movement.",
            continuity_delta: [],
            confidence: 0.9
          }
        }
      }
    });
    assert.equal(acceptedProposal.isError, false);
    assert.equal((acceptedProposal.structuredContent as { state: string }).state, "accepted_for_human_review");
    assert.match(JSON.stringify(acceptedProposal.content), /尚未执行任何生产动作/);
    const injectedAuthority = await client.callTool({
      name: "submit_director_proposal",
      arguments: {
        focus_id: focus.focus_id,
        focus_generation: focus.generation,
        base_state_hash: directorBaseStateHash(targetState),
        idempotency_key: "director-authority-injection-001",
        source: "native",
        principal_id: hash,
        approved: true,
        execute: true,
        proposal: {
          kind: "review_assessment",
          payload: {
            shot_id: focus.target_id,
            artifact_id: "artifact_clip_001",
            diagnosis: "Motion is too abrupt.",
            evidence: [],
            recommended_disposition: "regenerate",
            prompt_delta: "Slow the movement.",
            continuity_delta: [],
            confidence: 0.9
          }
        }
      }
    });
    assert.equal(injectedAuthority.isError, true);
    assert.equal(injectedAuthority.structuredContent, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Director registry enforces media and proposal scopes independently from projects.read", async () => {
  const actor = { principal_id: hash, actor_hash: hash, issuer_hash: "b".repeat(64), scopes: new Set(["projects.read"]) };
  const authConfig = loadDirectorOAuthConfig({
    WEBGPT_DIRECTOR_RESOURCE_URL: "https://aivideo.example.test/director/mcp",
    WEBGPT_DIRECTOR_OAUTH_ISSUER: "https://tenant.example.test/",
    WEBGPT_DIRECTOR_OAUTH_AUDIENCE: "https://aivideo.example.test/director/mcp",
    WEBGPT_DIRECTOR_OAUTH_JWKS_URI: "https://tenant.example.test/.well-known/jwks.json",
    WEBGPT_DIRECTOR_OAUTH_CLIENT_REGISTRATION: "predefined"
  } as NodeJS.ProcessEnv)!;
  const server = createDirectorNativeMcpServer(actor, handlers(), { auth_config: authConfig });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "director-scope-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const focusResult = await client.callTool({ name: "get_director_focus", arguments: {} });
    assert.equal(focusResult.isError, false);
    const deniedFrames = await client.callTool({
      name: "inspect_director_video_frames",
      arguments: { focus_id: focus.focus_id, focus_generation: focus.generation, artifact_id: "artifact_clip_001" }
    });
    assert.equal(deniedFrames.isError, true);
    assert.match(JSON.stringify(deniedFrames.content), /Required scope is missing: media\.read/);
    assert.match(JSON.stringify(deniedFrames._meta), /mcp\/www_authenticate/);
    assert.match(JSON.stringify(deniedFrames._meta), /media\.read/);
    const deniedProposal = await client.callTool({
      name: "submit_director_proposal",
      arguments: {
        focus_id: focus.focus_id,
        focus_generation: focus.generation,
        base_state_hash: directorBaseStateHash(targetState),
        idempotency_key: "director-idempotency-001",
        proposal: {
          kind: "review_assessment",
          payload: {
            shot_id: focus.target_id,
            artifact_id: "artifact_clip_001",
            diagnosis: "Motion is too abrupt.",
            evidence: [],
            recommended_disposition: "regenerate",
            prompt_delta: "Slow the movement.",
            continuity_delta: [],
            confidence: 0.9
          }
        }
      }
    });
    assert.equal(deniedProposal.isError, true);
    assert.match(JSON.stringify(deniedProposal.content), /Required scope is missing: proposals\.write/);
    assert.match(JSON.stringify(deniedProposal._meta), /mcp\/www_authenticate/);
    assert.match(JSON.stringify(deniedProposal._meta), /proposals\.write/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Director tool results fail closed above the 128 KiB structured response budget", async () => {
  const actor = {
    principal_id: hash,
    actor_hash: hash,
    issuer_hash: "b".repeat(64),
    scopes: new Set(["projects.read", "media.read", "proposals.write"])
  };
  const largeHandlers = handlers();
  const baseGetContext = largeHandlers.get_director_context;
  largeHandlers.get_director_context = async (input) => {
    const result = await baseGetContext(input);
    return {
      ...result,
      discussion: {
        ...result.discussion,
        review_history: Array.from({ length: 20 }, (_, index) => ({
          event_id: `review_event_${index}`,
          artifact_id: "artifact_clip_001",
          disposition: "revision_needed" as const,
          reason_codes: ["MOTION_TOO_ABRUPT"],
          note: "x".repeat(8_000),
          created_at: now
        }))
      }
    };
  };
  const server = createDirectorNativeMcpServer(actor, largeHandlers);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "director-budget-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "get_director_context",
      arguments: { focus_id: focus.focus_id, focus_generation: focus.generation, proposal_kind: "review_assessment", detail: "full" }
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(JSON.stringify(result.content), /RESPONSE_BUDGET_EXCEEDED/);
    assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8") < DIRECTOR_TOOL_RESULT_MAX_BYTES, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Director OAuth resource is complete, distinct, and advertises the fixed scopes", () => {
  const env = {
    WEBGPT_V4_RESOURCE_URL: "https://aivideo.example.test/mcp",
    WEBGPT_DIRECTOR_RESOURCE_URL: "https://aivideo.example.test/director/mcp",
    WEBGPT_DIRECTOR_OAUTH_ISSUER: "https://tenant.example.test/",
    WEBGPT_DIRECTOR_OAUTH_AUDIENCE: "https://aivideo.example.test/director/mcp",
    WEBGPT_DIRECTOR_OAUTH_JWKS_URI: "https://tenant.example.test/.well-known/jwks.json",
    WEBGPT_DIRECTOR_OAUTH_CLIENT_REGISTRATION: "predefined"
  } as NodeJS.ProcessEnv;
  const config = loadDirectorOAuthConfig(env)!;
  assert.equal(config.audience, config.resource_url);
  assert.equal(config.issuer_hash, issuerHash(config.issuer));
  assert.equal(directorProtectedResourceMetadataUrl(config), "https://aivideo.example.test/.well-known/oauth-protected-resource/director/mcp");
  assert.deepEqual(directorProtectedResourceMetadata(config), {
    resource: config.resource_url,
    resource_name: "Jenn AI Video Workspace Director",
    authorization_servers: [config.issuer],
    scopes_supported: ["projects.read", "media.read", "proposals.write"],
    bearer_methods_supported: ["header"],
    configured: true
  });
  const challenge = directorWwwAuthenticate(config, "insufficient_scope", {
    scope: "projects.read proposals.write",
    error_description: "Director proposal access is required."
  });
  assert.equal(challenge.includes("/.well-known/oauth-protected-resource/director/mcp"), true);
  assert.equal(challenge.includes('scope="projects.read proposals.write"'), true);
  assert.equal(directorWwwAuthenticate(null).includes("/.well-known/oauth-protected-resource/director/mcp"), true);
  assert.equal(directorWwwAuthenticate(null).includes("/.well-known/oauth-protected-resource/mcp"), false);

  assert.equal(loadDirectorOAuthConfig({} as NodeJS.ProcessEnv), null);
  assert.throws(() => loadDirectorOAuthConfig({ ...env, WEBGPT_DIRECTOR_OAUTH_JWKS_URI: "" }), (error) => error instanceof WebGptV4Error && error.code === "INVALID_DIRECTOR_OAUTH_CONFIG");
  assert.throws(() => loadDirectorOAuthConfig({ ...env, WEBGPT_DIRECTOR_OAUTH_AUDIENCE: env.WEBGPT_V4_RESOURCE_URL }), (error) => error instanceof WebGptV4Error && error.code === "INVALID_DIRECTOR_OAUTH_CONFIG");
  assert.throws(() => loadDirectorOAuthConfig({ ...env, WEBGPT_DIRECTOR_RESOURCE_URL: env.WEBGPT_V4_RESOURCE_URL, WEBGPT_DIRECTOR_OAUTH_AUDIENCE: env.WEBGPT_V4_RESOURCE_URL }), (error) => error instanceof WebGptV4Error && error.code === "AMBIGUOUS_DIRECTOR_OAUTH_RESOURCE");
});

test("Director OAuth verifies its own audience and preserves only token-declared scopes", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "director-oauth-test", alg: "RS256", use: "sig" });
  const issuer = "https://tenant.example.test/";
  const resource = "https://aivideo.example.test/director/mcp";
  const config = loadDirectorOAuthConfig({
    WEBGPT_DIRECTOR_RESOURCE_URL: resource,
    WEBGPT_DIRECTOR_OAUTH_ISSUER: issuer,
    WEBGPT_DIRECTOR_OAUTH_AUDIENCE: resource,
    WEBGPT_DIRECTOR_OAUTH_JWKS_URI: "https://tenant.example.test/.well-known/jwks.json",
    WEBGPT_DIRECTOR_OAUTH_CLIENT_REGISTRATION: "predefined"
  } as NodeJS.ProcessEnv)!;
  const sign = (scope: string, audience = resource) => new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "director-oauth-test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("auth0|director-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const authenticate = createDirectorOAuthAuthenticator(config, { jwks: createLocalJWKSet({ keys: [jwk] }) });
  const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;
  const actor = await authenticate(request(await sign("projects.read proposals.write")));
  assert.equal(actor.principal_id, principalIdFromFederatedSubject(issuer, "auth0|director-user"));
  assert.deepEqual([...actor.scopes].sort(), ["projects.read", "proposals.write"]);
  const missingScopeToken = await sign("proposals.write");
  const wrongAudienceToken = await sign("projects.read", "https://aivideo.example.test/mcp");
  await assert.rejects(() => authenticate(request(missingScopeToken)), (error) => error instanceof WebGptV4Error && error.code === "INSUFFICIENT_SCOPE");
  await assert.rejects(() => authenticate(request(wrongAudienceToken)), (error) => error instanceof WebGptV4Error && error.code === "AUTH_INVALID");
});

test("Manual Director import remains explicit, confirmed, and untrusted", () => {
  const payload = {
    summary: "Create a bounded fixture brief.",
    objectives: ["Explain the product clearly."],
    constraints: [],
    proposed_brief: {
      title: "Fixture Brief",
      audience: "Fixture audience",
      key_message: "Fixture message",
      creative_direction: "Natural construction-site realism.",
      call_to_action: ""
    }
  };
  const proposal = {
    proposal_id: "proposal_manual_001",
    schema_version: "director-domain-v1" as const,
    workspace_id: "jenn-ai-video-workspace" as const,
    principal_id: hash,
    project_id: focus.project_id,
    target_type: "project" as const,
    target_id: focus.project_id,
    focus_id: focus.focus_id,
    focus_generation: focus.generation,
    base_state_hash: hash,
    payload_hash: directorContentHash(payload),
    parent_proposal_id: null,
    idempotency_key: "manual-idempotency-001",
    source: "untrusted_manual_import" as const,
    created_at: now,
    kind: "creative_brief" as const,
    payload
  };
  assert.equal(DIRECTOR_MANUAL_IMPORT_SCHEMA.parse({ mode: "manual", confirmed_by_user: true, proposal, imported_at: now }).proposal.source, "untrusted_manual_import");
  assert.throws(() => DIRECTOR_MANUAL_IMPORT_SCHEMA.parse({
    mode: "manual",
    confirmed_by_user: true,
    proposal: { ...proposal, source: "native" },
    imported_at: now
  }));
  assert.throws(() => DIRECTOR_MANUAL_IMPORT_SCHEMA.parse({
    mode: "manual",
    confirmed_by_user: true,
    proposal: { ...proposal, payload_hash: "b".repeat(64) },
    imported_at: now
  }));
});
