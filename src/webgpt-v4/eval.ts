import { z } from "zod/v4";

import { WEBGPT_V4_METADATA_GOLDEN_PROMPTS } from "./metadataGoldenPrompts.js";
import { isWebGptV4ToolName } from "./toolCatalog.js";
import { WebGptV4Error } from "./types.js";

const identifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const argumentKey = z.string().trim().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const fixtureAlias = z.string().trim().min(2).max(100).regex(/^\$[a-z0-9_]+$/);

const replayCaseSchema = z.object({
  case_id: identifier,
  selected_tool: z.string().trim().min(1).max(100).nullable(),
  argument_keys: z.array(argumentKey).max(50),
  argument_schema_valid: z.boolean(),
  fixture_aliases: z.array(fixtureAlias).max(20),
  confirmation_shown: z.boolean().nullable()
}).strict().superRefine((value, context) => {
  if (new Set(value.argument_keys).size !== value.argument_keys.length) {
    context.addIssue({ code: "custom", path: ["argument_keys"], message: "argument_keys must be unique." });
  }
  if (new Set(value.fixture_aliases).size !== value.fixture_aliases.length) {
    context.addIssue({ code: "custom", path: ["fixture_aliases"], message: "fixture_aliases must be unique." });
  }
});

export const webGptV4EvalReplaySchema = z.object({
  run_id: identifier,
  source: z.literal("chatgpt-developer-mode"),
  cases: z.array(replayCaseSchema).min(1).max(500)
}).strict();

export interface WebGptV4EvalSummary {
  run_id: string;
  source: "chatgpt-developer-mode";
  case_count: number;
  selection_correct: number;
  selection_accuracy: number;
  forbidden_tool_calls: number;
  argument_schema_valid: number;
  argument_schema_accuracy: number;
  confirmation_mismatches: number;
}

export function evaluateWebGptV4Replay(input: unknown): WebGptV4EvalSummary {
  const parsed = webGptV4EvalReplaySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WebGptV4Error("INVALID_EVAL_REPLAY", issue?.message ?? "Eval replay is invalid.", issue?.path.join(".") || "replay");
  }
  const seen = new Set<string>();
  const corpus = new Map(WEBGPT_V4_METADATA_GOLDEN_PROMPTS.map((item) => [item.case_id, item]));
  let selectionCorrect = 0;
  let forbiddenToolCalls = 0;
  let argumentSchemaValid = 0;
  let confirmationMismatches = 0;

  for (const replayCase of parsed.data.cases) {
    if (seen.has(replayCase.case_id)) throw new WebGptV4Error("DUPLICATE_EVAL_CASE", "Eval replay contains a duplicate case id.", "case_id");
    seen.add(replayCase.case_id);
    const expected = corpus.get(replayCase.case_id);
    if (!expected) throw new WebGptV4Error("UNKNOWN_EVAL_CASE", "Eval replay references an unknown case id.", "case_id");
    if (replayCase.selected_tool !== null && !isWebGptV4ToolName(replayCase.selected_tool)) {
      throw new WebGptV4Error("UNKNOWN_EVAL_TOOL", "Eval replay references an unknown registered tool.", "selected_tool");
    }
    if (replayCase.selected_tool === expected.expected_tool) selectionCorrect += 1;
    if (replayCase.selected_tool && expected.forbidden_tools.includes(replayCase.selected_tool)) forbiddenToolCalls += 1;
    const actualArgumentKeys = [...replayCase.argument_keys].sort();
    const expectedArgumentKeys = [...expected.expected_argument_keys].sort();
    const argumentKeysMatch = actualArgumentKeys.length === expectedArgumentKeys.length
      && actualArgumentKeys.every((key, index) => key === expectedArgumentKeys[index]);
    if (argumentKeysMatch && replayCase.argument_schema_valid) argumentSchemaValid += 1;
    if (expected.confirmation_expected !== null && replayCase.confirmation_shown !== expected.confirmation_expected) confirmationMismatches += 1;
  }

  const caseCount = parsed.data.cases.length;
  return {
    run_id: parsed.data.run_id,
    source: parsed.data.source,
    case_count: caseCount,
    selection_correct: selectionCorrect,
    selection_accuracy: selectionCorrect / caseCount,
    forbidden_tool_calls: forbiddenToolCalls,
    argument_schema_valid: argumentSchemaValid,
    argument_schema_accuracy: argumentSchemaValid / caseCount,
    confirmation_mismatches: confirmationMismatches
  };
}
