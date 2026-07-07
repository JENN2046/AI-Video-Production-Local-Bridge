# NEXT_TASK.md

Status: DONE

Task: R3-8H_RUNNINGHUB_ADAPTER_OR_AUTHORIZATION_NEXT_STEP

Title: RunningHub Adapter Skeleton And Offline Tests

Priority: P0

Lane: Provider Adapter Implementation

Project: AI Video Production Workspace Three Route Plan

Claimed by: Codex R3-8H executor

Claim run ID: codex-20260707-161345-r3-8h

Claimed at: 2026-07-07T16:13:45+08:00

Completed by: Codex R3-8H executor

Completed at: 2026-07-07T16:25:39+08:00

Result: PASS_ADAPTER_SKELETON_OFFLINE

Validation result: PASS

## Goal

Implement the local RunningHub adapter skeleton required by the R3-8G frozen contract while keeping the whole task offline. The adapter should build upload-first request plans and parse synthetic submit/query/error responses, but must not call RunningHub or Runway.

## Required Implementation

- Add a RunningHub upload request builder for `POST /openapi/v2/media/upload/binary`.
- Add a RunningHub submit request builder for `POST /openapi/v2/rhart-video-g/image-to-video`.
- Add a RunningHub query request builder for `POST /openapi/v2/query`.
- Add sanitized request summaries that exclude API keys, Authorization values, raw binary data, base64, local private payloads, and raw provider payloads.
- Add response parsers for upload `data.download_url`, submit `taskId/status/errorCode/errorMessage`, and query `results[].url`.
- Add error mapping for invalid API key, rate limit, insufficient permission/credits, content safety, timeout, generation failure, and unknown provider failure where official docs allow.
- Keep `RunningHubVideoProviderAdapter.submitGeneration` fail-closed unless a later exact live-call task authorizes and implements network execution.

## Acceptance

- RunningHub remains the primary provider in the registry.
- Adapter request builders produce the R3-8G contract shape.
- Unit tests cover upload, submit, query, output URL extraction, error mapping, and secret/base64 redaction.
- No network call is attempted.
- No RunningHub upload, submit, query, poll, or output download is attempted.
- No Runway call is attempted.
- No provider credits are consumed.
- No real video is generated.
- No secret values, Authorization values, raw binary payloads, base64 image payloads, or raw provider payloads are recorded.

## Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Stop before any live RunningHub upload, submit, status query, or provider output download. Any live provider action requires a future exact current Jenn authorization phrase.
