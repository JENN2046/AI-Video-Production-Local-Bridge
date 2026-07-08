# NEXT_TASK.md

Status: READY

Task: R3-8K_PROVIDER_PATH_DECISION_CLOSEOUT

Title: Provider Path Decision Closeout

Priority: P1

Lane: Provider Decision Closeout

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8O_RECEIPT_FIX_R1

## Goal

Close the provider-selection loop after Enterprise Key RunningHub canary evidence is available.

## Required Work

- First backfill `R3-8O_RECEIPT_FIX_R1` commit `507c705` where applicable.
- Summarize Runway insufficient-credits evidence.
- Summarize RunningHub duration minimum fix, account-type failure, Enterprise Key success, generated artifact, and ffprobe PASS.
- Record RunningHub Enterprise-Shared API Key path as the primary validated M1 provider path.
- Keep future live provider calls authorization-gated.

## Acceptance

- No provider call is attempted.
- No provider credits are consumed.
- No real video is generated.
- No secret values are exposed.
- No source assets are overwritten.
- No push, tag, release, or deploy occurs.

## Validation

- JSON/YAML parse for closeout report if applicable
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Closeout only. Do not run any provider or deployment action.
