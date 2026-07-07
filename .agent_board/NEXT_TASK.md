# NEXT_TASK.md

Status: FAILED

Task: R3-8B_RUNWAY_GEN45_SINGLE_SUBMIT_CANARY_REAUTHORIZATION

Title: Runway Gen-4.5 Single-Submit Canary Reauthorization

Priority: P0

Lane: Approval Boundary Live Provider Execution

Project: AI Video Production Workspace Three Route Plan

Claimed by: Codex R3-8B executor

Claim run ID: codex-20260707-133651-r3-8b

Claimed at: 2026-07-07T13:36:51+08:00

Failed by: Codex R3-8B executor

Failed at: 2026-07-07T13:38:48+08:00

Result: PROVIDER_FAILED

## Goal

Execute a single Runway Gen-4.5 canary only after Jenn provides the exact current authorization phrase for this task. If exact authorization is absent, the worker may perform safe preflight only and must stop before any live provider submit.

## Live Contract

- provider: `runway`
- model: `gen4.5`
- endpoint: `POST /v1/image_to_video`
- `X-Runway-Version`: `2024-11-06`
- input: `fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png`
- project aspect ratio: `9:16`
- Runway ratio: `720:1280`
- duration_seconds: `2`
- max_submit_calls: `1`
- output_dir: `data/media/provider-canary/m1-r0-runway-canary/`

## Required Authorization Phrase

```text
授权执行 1 次 Runway single-submit canary 真实调用：provider=runway，endpoint=POST /v1/image_to_video，X-Runway-Version=2024-11-06，model=gen4.5，input=fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png，duration_seconds=2，ratio=720:1280，max_submit_calls=1，预算/费用上限=仅允许这 1 次 canary submit 且不允许自动重试或第二次计费调用，output_dir=data/media/provider-canary/m1-r0-runway-canary/，成功后下载为本地 media artifact 并 ffprobe 校验；不得调用 RunningHub，不得 regeneration，不得 batch，不得发布/部署，不得覆盖源资产，不得打印 secret。
```

## Acceptance

- Claim R3-8B only after confirming R3-8A commit `143da65` and dry-run report are present.
- Confirm `.agent_board/RUN_LOCK.md` is inactive before claim.
- Confirm active provider is `runway`.
- Confirm `RUNWAYML_API_SECRET` presence only as a boolean; never print the value.
- Execute at most one Runway submit only after exact current Jenn authorization is present.
- Do not retry on failure.
- Do not call RunningHub.
- Do not run regeneration or batch generation.
- Do not publish, deploy, push, tag, or release.
- Do not overwrite source assets.
- If succeeded, download output to `data/media/provider-canary/m1-r0-runway-canary/`, register a local media artifact, and ffprobe validate it.
- If failed, record a sanitized provider failure summary without secret values or raw private payloads.

## Validation

- `npm run env:check`
- `npm run provider:preflight`
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Exactly one authorized Runway submit attempt was performed. The provider path failed with sanitized error code `PROVIDER_UNSUPPORTED_INPUT` before a provider job id was recorded. No retry was attempted.

## Evidence

- `data/reports/m1_r0_runway_canary_live_result.json`
- `data/reports/r3_8b_runway_gen45_single_submit_canary_result.json`
- `data/reports/provider_env_check_result.json`
- `data/reports/provider_preflight_result.json`
- `data/reports/secret_scan_result.json`

## Next Safe Option

Investigate the Runway Gen-4.5 input contract offline before any new live submit authorization.
