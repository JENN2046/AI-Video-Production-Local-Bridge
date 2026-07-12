# GPT Service Capability Hardening v1

This taskbook hardens WebGPT V4 without creating WebGPT V5 or opening any external connection.

## Release sequence

1. Eval contract, adversarial corpus, and sanitized replay.
2. Default-readonly registry and strict read contracts.
3. Full-profile DTOs, compact context, and response budgets.
4. Widget metadata, low-disclosure telemetry, and version closeout.

Each delivery starts from the latest green `main`. Auth0, Secure MCP Tunnel, public HTTPS, media exposure, Windows auto-start, real Provider calls, and Company Knowledge `search`/`fetch` remain outside this taskbook.

Target closeout: package `0.1.0-beta.2`, MCP service `webgpt-v4.1.0`. This remains WebGPT V4; no V5 service or compatibility alias is introduced.

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

## Widget and telemetry

The Full-only Media Inspector uses `ui://webgpt-v4/media-inspector-v2.html`, model/app visibility metadata, invocation labels, a project-media-only CSP, and an optional HTTPS `WEBGPT_V4_WIDGET_DOMAIN`. The Widget domain is validated independently from the media public origin. Missing Widget domain is allowed for local Full tests but leaves the external release gate unsatisfied. Readonly registers no Widget resource.

`WEBGPT_V4_TELEMETRY_MODE=off` is the default and performs no filesystem writes. Explicit `jsonl` mode writes only low-disclosure event fields to `data/webgpt/telemetry/webgpt-v4-YYYY-MM-DD.jsonl`. It never records arguments, prompts, business content, actor identity, paths, credentials, Provider payloads, or media data. Retention is seven days with a 20 MB total cap; cleanup only considers matching regular files and refuses symlinked directories/files. A cached 30-second create/append/delete probe gates readiness. Event-write failure does not alter the tool result, but invalidates Telemetry health until a later probe succeeds.

## Completion boundary

The hardening release adds no database migration and does not require Jenn's active database. It does not call OpenAI, ChatGPT, Provider, Auth0, Tunnel, or any paid API. Eval replay files, Telemetry files, `.env`, local runtime state, and local-only database acceptance evidence remain outside Git.
