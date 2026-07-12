# GPT Service Capability Hardening v1

This taskbook hardens WebGPT V4 without creating WebGPT V5 or opening any external connection.

## Release sequence

1. Eval contract, adversarial corpus, and sanitized replay.
2. Default-readonly registry and strict read contracts.
3. Full-profile DTOs, compact context, and response budgets.
4. Widget metadata, low-disclosure telemetry, and version closeout.

Each delivery starts from the latest green `main`. Auth0, Secure MCP Tunnel, public HTTPS, media exposure, Windows auto-start, real Provider calls, and Company Knowledge `search`/`fetch` remain outside this taskbook.

## Runtime profiles

`start:webgpt` defaults to `WEBGPT_V4_PROFILE=readonly`. This profile registers only the six `projects.read` tools, opens SQLite read-only for MCP calls and readiness, and does not start the media listener. `WEBGPT_V4_PROFILE=full` is required to restore the existing media and limited-write tool surface.

Model-facing `readOnlyHint` and local database access are separate catalog facts. In particular, `inspect_media` is model-read-only but needs a writable SQLite connection to create its short-lived playback grant.

## Evaluation boundary

The committed corpus labels direct, indirect, negative, and adversarial prompts. Local tests verify corpus consistency and MCP contracts with synthetic fixtures; they do not run or simulate ChatGPT tool selection.

`npm run eval:webgpt:replay -- --input <sanitized-result.json>` scores a future Developer Mode observation. A replay may contain case ids, selected registered tool names, argument field names, schema-validity facts, fixture aliases, and confirmation facts. It must not contain argument values, prompts, project ids, production copy, tool results, tokens, provider payloads, or local paths.

Real model selection becomes a release gate only after an authorized HTTPS connection exists. Until then, passing the offline suite means the server contract and security fixtures pass; it does not claim ChatGPT routing quality.

## Context and output contract

All fourteen Full-profile tools now project database and domain objects into explicit public DTOs before returning them. Readonly and Full share the same strict result envelope; success contains `data` only, while failure contains `error` only. Contract projection failure is reported as `WEBGPT_V4_OUTPUT_CONTRACT_VIOLATION` without parser details.

The project, SHOT, review-package, and Full media list tools default to `detail=compact`. Full detail remains available when explicitly requested. Compact SHOT results omit complete video prompts, negative prompts, clip-version stacks, and review blobs. Project context reuses the Workbench-authoritative `summary.next_action`; WebGPT does not derive a separate action or map it to a write tool.

Paginated results expose `next_offset`. Review packages default to the newest ten notes, accept `notes_limit` up to 50, and include `notes_total`. Model-visible `structuredContent` is limited to 128 KiB. Oversize results fail explicitly with `RESPONSE_BUDGET_EXCEEDED`, a non-retryable classification, and smaller `detail` or `limit` guidance. Text content stays concise and does not duplicate the business JSON; media inspection may still return image content separately.

The fixed canonical large-project fixture proves that compact output is at least 50% smaller than full output for that fixture only. This is a regression gate, not a general compression claim.
