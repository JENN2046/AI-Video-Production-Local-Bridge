# NEXT_TASK.md

Status: READY

Task: R3-9G_REGENERATION_STRATEGY_FOR_REVIEW_NOTES

Title: Regeneration Strategy For Review Notes

Priority: P0

Lane: Regeneration Strategy

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9F_HUMAN_CLIP_REVIEW_DECISION_APPLY

## Goal

Prepare a local regeneration strategy for the three `regenerate_requested` shots without calling providers.

## Required Work

- Parse `data/reports/r3_9f_human_clip_review_decision_apply_result.json` as the source of truth.
- Include only `SHOT_001`, `SHOT_003`, and `SHOT_004` as regeneration candidates.
- Convert Jenn's Chinese review notes into revised action constraints, prompt guidance, negative constraints, and risk notes.
- Draft a future bounded RunningHub regeneration authorization plan without executing it.
- Exclude `SHOT_002`; it belongs to `R3-9H_SHOT_002_REPLACEMENT_DECISION`.

## Acceptance

- `SHOT_001` strategy addresses food picked from lunchbox and brought to mouth, not picking up the lunchbox.
- `SHOT_003` strategy addresses realistic cap fold and fabric behavior when pulled.
- `SHOT_004` strategy addresses physically plausible cap lighting and shadow realism.
- Each candidate has revised prompt guidance, negative constraints, source keyframe/artifact reference, `duration_seconds=6`, and future output directory plan.
- Budget draft is bounded to `max_upload_calls_total=3` and `max_submit_calls_total=3`, one upload and one submit per candidate, no retry, no second submit, no batch expansion, and no Runway fallback.
- Report records `network_call_attempted=false`, `runninghub_called=false`, `runway_called=false`, `provider_credits_consumed=false`, `real_video_generated=false`, `regeneration_performed=false`, `secret_values_exposed=false`.

## Validation

- JSON parse for generated regeneration strategy report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Strategy only. Do not call providers, execute regeneration, assemble final video, overwrite source assets, push, tag, release, or deploy.
