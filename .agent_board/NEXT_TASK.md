# NEXT_TASK.md

Status: DONE

Task: R3-8O_RUNNINGHUB_ENTERPRISE_KEY_6S_SINGLE_SUBMIT_CANARY

Title: R3-8O RunningHub Enterprise Key 6s Single-Submit Canary

Priority: P0

Lane: Approval Boundary Live Provider Execution

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8N_PROVIDER_ACCESS_STRATEGY_DECISION

## Goal

Run exactly one Jenn-authorized RunningHub 6-second live canary with the Enterprise-Shared API Key path.

## Authorized Scope

- Read `A:/AI Video Production Workspace/.env.local` read-only for `env-check` and `provider-preflight`.
- `provider=runninghub`
- `api_base_url=https://www.runninghub.cn`
- `upload_endpoint=POST /openapi/v2/media/upload/binary`
- `submit_endpoint=POST /openapi/v2/rhart-video-g/image-to-video`
- `query_endpoint=POST /openapi/v2/query`
- `selected_artifact_id=artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- `duration_seconds=6`
- `aspectRatio=9:16`
- `resolution=480p`
- `max_upload_calls=1`
- `max_submit_calls=1`

## Hard Stops

- Do not retry or perform a second submit.
- Do not call Runway.
- Do not run batch or regeneration.
- Do not print, record, commit, or leak secret values.
- Do not record raw provider payloads or signed URLs.
- Do not overwrite source assets.
- Do not push, tag, release, or deploy.

## Validation

- `npm run env:check`
- `npm run provider:preflight`
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Claim

- claimed_by: Codex R3-8O live runner
- claim_run_id: codex-20260708-112510-r3-8o-live
- claimed_at: 2026-07-08T11:25:10+08:00

## Result

`PASS_LIVE_SINGLE_SUBMIT_COMPLETED`

## Completed Work

- Read `.env.local` read-only for authorized env-check and provider-preflight.
- Ran exactly one RunningHub media upload.
- Ran exactly one RunningHub submit.
- Queried the returned `taskId` until `SUCCESS`.
- Downloaded output to `data/media/provider-canary/r3-8o-runninghub-enterprise-key-6s-real-keyframe/`.
- Registered generated artifact `artifact_5bd5b213-3b8b-4717-bec7-298be59b0f62`.
- ffprobe validation: `PASS`.
- No retry, second submit, Runway call, regeneration, batch, source overwrite, push, tag, release, or deploy occurred.

## Completed At

2026-07-08T11:28:19+08:00
