# NEXT_TASK

task_id: R3-9K_RUNNINGHUB_REGENERATED_CLIP_REVIEW_PREP
status: DONE
priority: P0
lane: RunningHub Regenerated Clip Review Prep
project: AI Video Production Workspace Three Route Plan
claimed_by: Codex R3-9K regenerated clip review prep
claim_run_id: codex-20260708-180238-r3-9k
claimed_at: 2026-07-08T18:02:38+08:00
completed_by: Codex R3-9K regenerated clip review prep
completed_at: 2026-07-08T18:07:27+08:00
result: PASS_REVIEW_PACKAGE_READY
validation_result: PASS

## Goal

为 R3-9J 新生成的 4 条视频生成中文人工审查包。

## Acceptance

- 4 个新生成 clip 全部列入审查表。
- 审查项包含 accept / reject / regenerate_requested。
- 每条包含本地视频路径、artifact_id、shot_id、上一轮问题、这轮重点检查项。
- 报告明确 final assembly 仍等待人工 accept。

## Boundary

- 不调用 RunningHub / Runway。
- 不 regeneration。
- 不 batch。
- 不 final assembly。
- 不改 review decision。
- 不读 credentials / .env。
- 不覆盖源资产。

## Validation

- JSON parse: PASS
- table parse / required rows check: PASS
- `npm run typecheck`: PASS
- `npm run test:m1`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY

## Evidence

- `data/reports/r3_9k_runninghub_regenerated_clip_review_prep_result.json`
- `data/reports/r3_9k_runninghub_regenerated_clip_review_table.md`

## Result

- 4 个 R3-9J 再生成 clip 已全部列入中文人工审查表。
- 每条都包含本地视频路径、artifact_id、shot_id、上一轮问题、这轮重点检查项。
- 审查项包含 accept / reject / regenerate_requested。
- final assembly 仍等待人工 accept。
