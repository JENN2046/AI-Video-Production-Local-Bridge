import { readFileSync } from "node:fs";

import { evaluateWebGptV4Replay } from "../src/webgpt-v4/eval.js";
import { errorBody } from "../src/webgpt-v4/types.js";

const inputIndex = process.argv.indexOf("--input");
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;

if (!inputPath) {
  console.error(JSON.stringify({ ok: false, error: { code: "EVAL_INPUT_REQUIRED", message: "Use --input <sanitized-result.json>." } }));
  process.exitCode = 1;
} else {
  try {
    const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    console.log(JSON.stringify({ ok: true, summary: evaluateWebGptV4Replay(parsed) }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: errorBody(error) }));
    process.exitCode = 1;
  }
}
