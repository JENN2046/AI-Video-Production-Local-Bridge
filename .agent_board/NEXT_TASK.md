# NEXT_TASK.md

Status: FAILED

Task: R3-8M_RUNNINGHUB_6S_SINGLE_SUBMIT_CANARY

Title: RunningHub 6s Single-Submit Canary

Priority: P0

Lane: Approval Boundary Live Provider Execution

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8L_RECEIPT_FIX_R1

## Goal

Run exactly one authorized RunningHub 6-second live canary after R3-8L receipt fix.

## Authorized Scope

- provider: `runninghub`
- upload_endpoint: `POST /openapi/v2/media/upload/binary`
- submit_endpoint: `POST /openapi/v2/rhart-video-g/image-to-video`
- query_endpoint: `POST /openapi/v2/query`
- selected_artifact_id: `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- duration_seconds: `6`
- aspectRatio: `9:16`
- resolution: `480p`
- max_upload_calls: `1`
- max_submit_calls: `1`
- output_dir: `data/media/provider-canary/r3-8m-runninghub-6s-real-keyframe/`

## Hard Stops

- No automatic retry or second billable submit.
- No Runway call.
- No regeneration or batch.
- No push, tag, release, or deploy.
- No source asset overwrite.
- No secret value output.
- No raw provider payload recording.

## Validation

- `npm run r3:8m:live`
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Claim

- claimed_by: Codex R3-8M live runner
- claim_run_id: codex-20260708-102426-r3-8m-live
- claimed_at: 2026-07-08T10:24:26+08:00

## Result

`PROVIDER_FAILED_AUTH_1014`

## Evidence

- Exactly one RunningHub media upload was attempted.
- Exactly one RunningHub submit was attempted.
- No provider task id was returned.
- No query, output download, local video artifact, or ffprobe validation occurred.
- RunningHub returned provider error code `1014`: Standard Model API is restricted to Enterprise-Shared API Keys only.

## Completed Boundary

- No retry or second submit.
- No Runway call.
- No regeneration or batch.
- No source overwrite.
- No secret value output.
- No raw provider payload recording.

## Failed At

2026-07-08T10:30:30+08:00
