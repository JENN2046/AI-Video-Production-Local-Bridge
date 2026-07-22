import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECTOR_MEMORY_PORT_VERSION,
  DISABLED_DIRECTOR_MEMORY_PORT,
  prepareDirectorMemorySavebackEnvelope,
  recallDirectorMemory
} from "../src/director/memoryPort.js";

const request = {
  workspace_id: "jenn-ai-video-workspace" as const,
  principal_id: "a".repeat(64),
  issuer_hash: "b".repeat(64),
  project_id: "project_memory_fixture",
  proposal_kind: "review_assessment"
};

function readyResponse() {
  return {
    version: DIRECTOR_MEMORY_PORT_VERSION,
    state: "ready" as const,
    workspace_id: request.workspace_id,
    principal_id: request.principal_id,
    issuer_hash: request.issuer_hash,
    project_id: request.project_id,
    items: [
      {
        category: "failure_pattern" as const,
        summary: "Keep product geometry stable during a hand contact.",
        evidence: ["Prior reviewed clip deformed at contact."],
        scope: "project" as const,
        source_project_id: request.project_id
      },
      {
        category: "preference" as const,
        summary: "Prefer natural light and slight handheld movement.",
        evidence: ["Confirmed production preference."],
        scope: "workspace" as const,
        source_project_id: null
      }
    ]
  };
}

test("Director memory port binds advisory recall to the exact project and fails closed on port drift", async () => {
  let calls = 0;
  const port = {
    async recall(received: typeof request) {
      calls += 1;
      assert.deepEqual(received, request);
      return readyResponse();
    }
  };
  const recall = await recallDirectorMemory(port, request);
  assert.equal(calls, 1);
  assert.deepEqual(recall, {
    state: "ready",
    items: [
      {
        category: "failure_pattern",
        summary: "Keep product geometry stable during a hand contact.",
        evidence: ["Prior reviewed clip deformed at contact."],
        scope: "project"
      },
      {
        category: "preference",
        summary: "Prefer natural light and slight handheld movement.",
        evidence: ["Confirmed production preference."],
        scope: "workspace"
      }
    ]
  });

  const wrongProject = await recallDirectorMemory({
    async recall() { return { ...readyResponse(), project_id: "project_other" }; }
  }, request);
  assert.deepEqual(wrongProject, { state: "unavailable", items: [] });

  const crossProjectItem = await recallDirectorMemory({
    async recall() {
      return {
        ...readyResponse(),
        items: [{ ...readyResponse().items[0]!, source_project_id: "project_other" }]
      };
    }
  }, request);
  assert.deepEqual(crossProjectItem, { state: "unavailable", items: [] });

  const malformed = await recallDirectorMemory({ async recall() { throw new Error("port unavailable"); } }, request);
  assert.deepEqual(malformed, { state: "unavailable", items: [] });

  const stalled = await recallDirectorMemory({ async recall() { return await new Promise(() => undefined); } }, request);
  assert.deepEqual(stalled, { state: "unavailable", items: [] });

  const disabled = await recallDirectorMemory(DISABLED_DIRECTOR_MEMORY_PORT, request);
  assert.deepEqual(disabled, { state: "disabled", items: [] });
});

test("Director memory saveback envelope stays non-dispatched until a separate external confirmation", () => {
  const envelope = prepareDirectorMemorySavebackEnvelope({
    proposal_id: "proposal_memory_fixture",
    workspace_id: "jenn-ai-video-workspace",
    principal_id: request.principal_id,
    issuer_hash: request.issuer_hash,
    project_id: request.project_id,
    items: [{
      category: "reusable_rule",
      summary: "Keep a brief anticipation before hand contact.",
      evidence: ["Accepted review rationale."],
      scope: "project"
    }],
    requires_human_confirmation: true
  });
  assert.equal(envelope.version, DIRECTOR_MEMORY_PORT_VERSION);
  assert.equal(envelope.dispatch_state, "awaiting_external_confirmation");
  assert.equal(envelope.requires_human_confirmation, true);
  assert.equal(envelope.principal_id, request.principal_id);
  assert.equal(envelope.issuer_hash, request.issuer_hash);
  assert.throws(() => prepareDirectorMemorySavebackEnvelope({
    ...envelope,
    requires_human_confirmation: false
  } as never));
});
