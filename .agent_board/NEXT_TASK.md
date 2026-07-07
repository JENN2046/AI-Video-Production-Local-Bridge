# NEXT_TASK.md

Status: DONE

Task: R3-8C_RUNWAY_SUBMIT_FAILURE_EVIDENCE_AND_INPUT_CONTRACT_TRIAGE

Title: Runway Submit Failure Evidence And Input Contract Triage

Priority: P0

Lane: Provider Failure Evidence And Offline Triage

Project: AI Video Production Workspace Three Route Plan

Claimed by: Codex R3-8C executor

Claim run ID: codex-20260707-142112-r3-8c

Claimed at: 2026-07-07T14:21:12+08:00

Completed by: Codex R3-8C executor

Completed at: 2026-07-07T14:21:12+08:00

Result: PASS_READY_FOR_INPUT_STRATEGY_DECISION

## Goal

Improve the evidence chain after R3-8B failed with `PROVIDER_UNSUPPORTED_INPUT`, while making no Runway or RunningHub calls.

## Evidence

- `data/reports/r3_8c_runway_submit_failure_triage_result.json`
- `data/reports/r3_8b_runway_gen45_single_submit_canary_result.json`
- `data/reports/m1_r0_runway_canary_live_result.json`
- `data/reports/secret_scan_result.json`

## Validation

- `npm run r3:8c:triage` PASS
- `npm run typecheck` PASS
- `npm run test:m1` PASS
- `npm run secret:scan` PASS
- `git diff --check` PASS

## Boundary

No Runway or RunningHub call was made during R3-8C. No retry, provider credit consumption, real video generation, secret output, promptImage/base64 recording, raw provider payload recording, source overwrite, push, tag, release, or deploy occurred.

## Finding

The current canary image is a readable 720x1280 PNG, but local visual inspection and pixel stats show it is an abstract gradient without a clear subject. It should be deprecated for live Gen-4.5 I2V canary use.

## Next Safe Option

Choose one of:

- `R3-8D Prepare Real Storyboard Keyframe Canary`
- `R3-8D Prepare Runway Ephemeral Upload Canary Path`
- `R3-8D Ask Jenn For Next Live Canary Authorization`

Any live Runway submit still requires a new exact current Jenn authorization phrase.
