import assert from "node:assert/strict";
import test from "node:test";

import { WEBGPT_V4_METADATA_GOLDEN_PROMPTS } from "../src/webgpt-v4/metadataGoldenPrompts.js";

test("metadata golden prompts cover direct, indirect, negative, and adversarial routing without provider tools", () => {
  const registeredTools = new Set([
    "list_production_projects", "get_project_context", "list_project_shots", "list_project_media",
    "inspect_media", "get_review_package", "get_delivery_status", "get_closeout_evidence",
    "update_shot_copy", "add_review_note", "submit_production_proposal",
    "revise_production_proposal", "close_production_proposal", "prepare_generation_intent"
  ]);
  const prohibitedTools = new Set(["submit_generation", "upload_media", "confirm_cost", "assemble_video", "approve_review", "deliver_project", "read_file", "shell"]);
  assert.deepEqual([...new Set(WEBGPT_V4_METADATA_GOLDEN_PROMPTS.map((item) => item.category))].sort(), ["adversarial", "direct", "indirect", "negative"]);
  assert.equal(WEBGPT_V4_METADATA_GOLDEN_PROMPTS.length >= 12, true);
  assert.equal(new Set(WEBGPT_V4_METADATA_GOLDEN_PROMPTS.map((item) => item.case_id)).size, WEBGPT_V4_METADATA_GOLDEN_PROMPTS.length);
  for (const item of WEBGPT_V4_METADATA_GOLDEN_PROMPTS) {
    if (item.expected_tool) assert.equal(registeredTools.has(item.expected_tool), true, item.prompt);
    for (const forbidden of item.forbidden_tools) assert.equal(registeredTools.has(forbidden) || prohibitedTools.has(forbidden), true, item.prompt);
  }
  for (const forbiddenName of prohibitedTools) {
    assert.equal(registeredTools.has(forbiddenName), false);
  }
});
