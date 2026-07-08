# NEXT_TASK.md

status: READY

task_id: R3-9L_HUMAN_REGENERATED_CLIP_REVIEW_DECISION_APPLY

title: Human Regenerated Clip Review Decision Apply

priority: P0

lane: Human Regenerated Clip Review Decision Apply

project: AI Video Production Workspace Three Route Plan

depends_on: R3-9K_RUNNINGHUB_REGENERATED_CLIP_REVIEW_PREP

## Goal

Apply Jenn's completed R3-9K human review decisions for the four regenerated RunningHub clips, making accepted clips eligible for final assembly readiness checks.

## Required Work

- Read `data/reports/r3_9k_runninghub_regenerated_clip_review_table.md` as the human source of truth.
- Parse exactly 4 regenerated clip rows.
- Require exactly one decision per row: `accept`, `reject`, or `regenerate_requested`.
- Apply accepted regenerated clips to local review state and app database.
- Preserve Jenn's reviewer and notes in review metadata.
- Generate `data/reports/r3_9l_human_regenerated_clip_review_decision_apply_result.json`.
- Do not call providers, regenerate clips, batch-expand, assemble final video, read env files or credentials, overwrite source assets, push, tag, release, or deploy.

## Acceptance

- R3-9K review table is parsed as the source of truth.
- Exactly 4 rows are parsed.
- Each row has exactly one human decision.
- Accepted rows set the corresponding `accepted_clip_artifact_id` to the R3-9J regenerated clip artifact.
- Rejected or regenerate_requested rows preserve Jenn's notes and keep final assembly blocked.
- Report includes per-shot decision, reviewer, note, regenerated clip artifact id, previous rejected clip artifact id, and local video path.
- Report includes summary counts for `accept`, `reject`, and `regenerate_requested`.
- If all 4 shots are accepted, report marks final assembly readiness check as the next safe task, not final assembly execution.

## Validation

- R3-9K review table parse / required decisions check
- JSON parse for generated R3-9L decision apply report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Boundary

Decision apply only. No RunningHub/Runway call, regeneration execution, batch expansion, final assembly, env or credential read, source overwrite, push, tag, release, or deploy.
