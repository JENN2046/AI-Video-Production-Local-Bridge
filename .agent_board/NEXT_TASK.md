# NEXT_TASK.md

Status: READY

Task: R3-8G_RUNNINGHUB_CONTRACT_FREEZE_AND_DRY_RUN

Title: RunningHub Contract Freeze And Dry Run

Priority: P0

Lane: Provider Contract Freeze

Project: AI Video Production Workspace Three Route Plan

Claimed by: none

Claim run ID: none

Claimed at: none

## Goal

Freeze the RunningHub.cn image-to-video API contract for the current real storyboard keyframe workflow and produce a dry-run request plan. This task must not call RunningHub, Runway, or any paid/quota-consuming provider endpoint.

## Required Source Review

- Review `https://www.runninghub.cn/`.
- Review `https://www.runninghub.cn/call-api/api-detail/2019380112598044674` if available.
- If the official API page is unavailable, requires login, or lacks enough details, mark the missing fields explicitly and return `BLOCK_WITH_REASON`.
- Do not rely on stale memory or guessed request fields.

## Selected Keyframe

- artifact_id: `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- storage_uri: `A:\AI Video Production Workspace\data\media\artifacts\images\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png`
- source_path: `A:\AI Video Production Workspace\data\imports\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png`

## Acceptance

- RunningHub is confirmed as primary provider in local registry.
- Runway remains secondary and is not called.
- Official RunningHub docs/API detail page are reviewed or missing fields are explicitly blocked.
- API base URL, submit endpoint, auth header names, model/workflow id fields, image field shape, prompt fields, duration, ratio, task id, status polling, output shape, and error shape are frozen or marked unresolved.
- Dry-run request summary is generated without credentials, base64, Authorization values, or raw provider payloads.
- No RunningHub call, Runway call, provider credit consumption, real video generation, secret value output, source overwrite, push, tag, release, or deploy occurs.

## Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Stop before any live RunningHub submit. Do not run `npm run env:check` or `npm run provider:preflight` against `.env.local` unless Jenn gives a fresh exact authorization to read local env presence.
