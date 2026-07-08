# NEXT_TASK.md

status: READY

task_id: R3-9Q_HUMAN_FINAL_VIDEO_REVIEW_DECISION_APPLY

title: Human Final Video Review Decision Apply

priority: P0

lane: Human Final Video Review Decision Apply

project: AI Video Production Workspace Three Route Plan

depends_on: R3-9P_FINAL_VIDEO_REVIEW_PACKAGE

## Goal

Apply Jenn's completed final video review decision and, if accepted, mark the local final video as creatively approved for closeout.

## Required Work

- Read `data/reports/r3_9p_final_video_review_table.md` as the human source of truth.
- Parse exactly one final video decision row.
- Require exactly one decision: `accept`, `reject`, or `revision_requested`.
- If the decision is `accept`, record final creative approval for `artifact_2fa09a9e-3408-49f8-96f9-42c87cfbbfbe`.
- If the decision is `reject` or `revision_requested`, keep final creative approval false and route to a revision strategy task.
- Generate `data/reports/r3_9q_human_final_video_review_decision_apply_result.json`.
- Do not publish, deploy, upload, call providers, regenerate, reassemble, read env files or credentials, overwrite source assets, push, tag, or release.

## Acceptance

- R3-9P final video review table is parsed as the source of truth.
- Exactly one final video decision row is parsed.
- Exactly one decision is selected among `accept`, `reject`, and `revision_requested`.
- Report includes reviewer, note, final video path, final video artifact id, source clip artifacts, ffprobe status, and decision summary.
- If accepted, report marks final creative approval as recorded locally and routes next to `R3-9R_FINAL_DELIVERY_CLOSEOUT`.
- If not accepted, report routes next to a revision strategy task.

## Validation

- R3-9P final video review table parse / required decision check
- JSON parse for generated R3-9Q decision apply report
- final video path existence check
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Boundary

Decision apply only. No publish, deploy, provider call, regeneration, reassembly, env or credential read, source overwrite, push, tag, or release.
