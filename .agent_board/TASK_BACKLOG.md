# TASK_BACKLOG.md

Backlog tasks may be loaded into `.agent_board/NEXT_TASK.json` one at a time.

Only `READY` tasks may be auto-loaded. `FOLLOW_UP` tasks must not be auto-loaded unless promoted to `READY` by Jenn, Commander, or an authorized queue-maintenance task.

Allowed backlog states:

- `READY`
- `IN_PROGRESS`
- `DONE`
- `BLOCKED`
- `FAILED`
- `SKIPPED`
- `FOLLOW_UP`
- `CANCELLED`

## T-0001 - Example local production governance task

status: FOLLOW_UP
priority: P2
lane: Safe Local Production Lane
project: workspace-control-plane
scope: docs and task-state templates
branch: local-only
depends_on: none
allowed_delivery: local_file_update,task_note,validation_log,handoff
blocked_delivery: force_push,history_rewrite,tag,release,deploy,production_config_change,secret_read,state_private_read,source_media_delete,source_media_overwrite
created_at: 2026-07-06
updated_at: 2026-07-06

### Goal

Replace this example with a real AI Video Production Workspace task.

### Acceptance

- The change is scoped to the named project or workspace control plane.
- Validation is run or marked `NOT RUN` with a reason.
- No secrets or private-state contents are read or written.
- Source media, original assets, and project masters are not deleted or overwritten without exact approval.

### Validation

- `python -m json.tool .agent_board/NEXT_TASK.json`
- `git diff --check` when the workspace is inside a git repo.

### Notes

- This entry is a non-executable template because its status is `FOLLOW_UP`.
- Promote a real task to `READY` only after replacing the template fields with concrete scope.

## T-0002 - Example approval-boundary preparation task

status: FOLLOW_UP
priority: P2
lane: Approval Boundary Preparation
project: workspace-control-plane
scope: analysis, dry-run plan, authorization checklist, handoff only
branch: local-only
depends_on: none
allowed_delivery: task_note,report,handoff,validation_log
blocked_delivery: private_state_read,secret_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change,paid_provider_call_without_budget
created_at: 2026-07-06
updated_at: 2026-07-06

### Goal

Prepare safe analysis and an authorization checklist for an action that would cross one of the AI Video Production Workspace approval boundaries. Do not perform the approval-required action.

### Acceptance

- Risks are identified.
- Safe dry-run, mock, or fixture options are listed.
- Exact Jenn authorization requirements are listed.
- No approval-required action is performed.

### Validation

- static review

### Notes

- Approval-boundary tasks may be claimed for safe preparation, but the guarded action itself still requires exact current authorization.

## M0-000 - Repo Reality Calibration for M0 Video Loop

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: read-only repository inspection, implementation routing, blocker assessment
branch: local-only
depends_on: none
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
decomposition_doc: docs/m0/M0_TASK_DECOMPOSITION.md
allowed_delivery: task_note,handoff,validation_log,repo_reality_report_in_final_response
blocked_delivery: code_edit,app_skeleton_creation,secret_read,state_private_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change,real_provider_call
created_at: 2026-07-06
updated_at: 2026-07-06
completed_at: 2026-07-06T11:42:30+08:00
result: PASS

### Goal

Perform the M0 first-step repository reality calibration before any implementation edits.

### Acceptance

- Inspect repository/workspace structure without modifying app code.
- Output the required `repo_reality` fields:
  - `stack_detected`
  - `package_manager`
  - `existing_server`
  - `existing_storage`
  - `existing_tests`
  - `existing_scripts`
  - `existing_media_or_fixture_dirs`
  - `implementation_strategy`
  - `blockers`
- Decide whether to connect to an existing stack or create a minimal M0 app skeleton.
- Do not read secrets, `state-private/`, provider credentials, raw logs, token stores, or private state.
- Do not create the app skeleton during this task.
- Treat "read-only" as no implementation edits, no app skeleton creation, and no project structure changes beyond required `.agent_board` state transitions.
- Report `repo_reality` in the final response and summarize it in `.agent_board/HANDOFF.md`; do not create a separate repo reality report file unless Jenn explicitly asks for one.

### Validation

- static review of inspected non-sensitive paths
- confirm no implementation files were changed
- confirm no private-state contents were read

### Notes

- This is the only initial `READY` M0 task.
- Promote `M0-A` only after this calibration identifies a safe implementation strategy.
- Queue bookkeeping writes to `.agent_board` are allowed for claim, validation evidence, ledger, and handoff.

## M0-A - Base Storage And App Skeleton

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: Node/TypeScript app skeleton, SQLite metadata storage, app-controlled data/media directories, test harness, stable tool interface skeleton
branch: local-only
depends_on: M0-000
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,tests,demo_script,validation_log,handoff
blocked_delivery: secret_read,state_private_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change,real_provider_call
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T11:52:01+08:00
claim_run_id: codex-20260706-115201-m0-a
completed_at: 2026-07-06T11:57:07+08:00
result: PASS

### Goal

Create or connect the base M0 application structure needed for persistent tool execution.

### Acceptance

- Node/TypeScript or repo-native equivalent is established.
- SQLite metadata storage is available.
- App-controlled `data/media` storage exists.
- Stable internal `src/tools/*` or equivalent tool interface exists.
- Basic test harness and scripts are present or routed through existing project conventions.

### Validation

- package/script inspection
- targeted skeleton tests when available
- JSON/schema/static validation where applicable

### Notes

- Do not implement the full M0 loop in this task.
- Do not require real provider credentials.

## M0-B - Media Artifact Chain And Transfer Spike

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: register_media_artifact, media storage safety, fixture transfer, external transfer path check
branch: local-only
depends_on: M0-A
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,fixtures,tests,validation_log,handoff
blocked_delivery: arbitrary_local_file_read,secret_read,state_private_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change,real_provider_call
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T11:57:45+08:00
claim_run_id: codex-20260706-115745-m0-b
completed_at: 2026-07-06T12:00:41+08:00
result: PASS

### Goal

Implement the Media Artifact file chain and mandatory `M0-B0` storyboard image transfer spike.

### Acceptance

- `register_media_artifact` supports M0-approved source modes.
- Fixture storyboard image bytes can be read, copied under app-controlled media storage, reopened, and marked active.
- External transfer path is tested or honestly reported as `NOT_TESTED`.
- Path traversal and arbitrary local path reads are blocked.
- Pending/inaccessible/expired artifacts cannot enter Storyboard Package later.

### Validation

- fixture transfer test
- external transfer path check or explicit `NOT_TESTED`
- negative path traversal test
- media file readability test

### Notes

- Fixture transfer can validate the engineering loop, but must not be represented as proof that real GPT image transfer is solved.

## M0-C - Storyboard Package Import

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: import_storyboard_package, frozen snapshots, Shot creation/update, artifact gates
branch: local-only
depends_on: M0-B
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,tests,validation_log,handoff
blocked_delivery: secret_read,state_private_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change,real_provider_call
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T12:01:05+08:00
claim_run_id: codex-20260706-120105-m0-c
completed_at: 2026-07-06T12:03:38+08:00
result: PASS

### Goal

Implement Storyboard Package import and freeze behavior.

### Acceptance

- Valid approved package imports successfully.
- Shots are created or updated from approved shot snapshots.
- Project status becomes `storyboard_approved`.
- Storyboard Package remains a frozen snapshot after later Shot changes.
- Missing prompt, unapproved package, pending artifact, inaccessible artifact, expired artifact, and wrong role/type are rejected with stable error codes.

### Validation

- valid import test
- missing field tests
- artifact gate tests
- frozen snapshot test

### Notes

- Do not start video generation in this task.

## M0-D - Mock Provider Video Generation

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: start_storyboard_video_generation, get_generation_status, Generation Batch, Generation Run, mock provider, generated clip artifacts
branch: local-only
depends_on: M0-C
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,fixtures,tests,validation_log,handoff
blocked_delivery: real_provider_call,provider_credential_read,network_required_runtime,secret_read,state_private_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T12:03:38+08:00
claim_run_id: codex-20260706-120338-m0-d
completed_at: 2026-07-06T12:06:43+08:00
result: PASS

### Goal

Implement mock-provider-first storyboard video generation.

### Acceptance

- Hard-gate confirmation is required and tested.
- 3-shot package creates one Generation Batch and three Generation Runs.
- Each successful run creates an active readable `generated_clip` video artifact.
- Batch summary and generation status queries work.
- Single Generation Run never uses `partially_failed`.

### Validation

- batch/run creation tests
- mock provider output readability test
- generation status tests
- confirmation gate positive and negative tests

### Notes

- Mock provider output may copy a fixture mp4 or generate a simple placeholder mp4.
- Do not call a real provider.

## M0-E - Review And Regeneration

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: mark_shot_clip_review, regenerate_shot_video, clip version chain, no-overwrite behavior
branch: local-only
depends_on: M0-D
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,tests,validation_log,handoff
blocked_delivery: real_provider_call,provider_credential_read,secret_read,state_private_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T12:06:43+08:00
claim_run_id: codex-20260706-120643-m0-e
completed_at: 2026-07-06T12:08:45+08:00
result: PASS

### Goal

Implement shot review decisions and regeneration while preserving prior runs and artifacts.

### Acceptance

- Approved clip sets `accepted_clip_artifact_id`.
- `revision_needed` records rejection reasons and latest revision instruction.
- Regeneration requires hard-gate confirmation.
- New run has incremented attempt number and parent run ID.
- Old run and old artifact are preserved.
- Demo-ready version chain supports V1 rejected and V2 approved.

### Validation

- approved review test
- revision-needed test
- regeneration test
- no-overwrite test
- clip version chain test

### Notes

- Do not assemble final video in this task.

## M0-F - Final Assembly

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: assemble_final_video, final video artifact, assembly readiness gate
branch: local-only
depends_on: M0-E
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,tests,validation_log,handoff
blocked_delivery: real_provider_call,provider_credential_read,secret_read,state_private_read,source_media_delete,source_media_overwrite,force_push,history_rewrite,tag,release,deploy,production_config_change
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T12:08:45+08:00
claim_run_id: codex-20260706-120845-m0-f
completed_at: 2026-07-06T12:10:29+08:00
result: PASS

### Goal

Implement final assembly using accepted generated clips.

### Acceptance

- Explicit confirmation is required.
- Assembly is blocked before all required shots have accepted active generated clips.
- Accepted clip artifacts must be active videos with role `generated_clip`.
- Final video artifact is active, readable, and stored under app-controlled media storage.
- Project `exports.final_video_artifact_id` is set and Project status becomes `video_review`.

### Validation

- blocked-before-ready test
- successful assembly test
- final file readability test
- explicit confirmation positive and negative tests

### Notes

- `final_approved` is not required by M0 final assembly.

## M0-G - Provider Boundary Placeholder

status: DONE
priority: P1
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: real provider disabled boundary, no-network runtime guard, provider error code
branch: local-only
depends_on: M0-F
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,tests,validation_log,handoff
blocked_delivery: real_provider_call,provider_credential_read,network_required_runtime,secret_read,state_private_read,force_push,history_rewrite,tag,release,deploy,production_config_change
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T12:10:29+08:00
claim_run_id: codex-20260706-121029-m0-g
completed_at: 2026-07-06T12:11:41+08:00
result: PASS

### Goal

Ensure real provider selection is disabled in M0 and returns `PROVIDER_DISABLED`.

### Acceptance

- Selecting or calling a real provider returns `PROVIDER_DISABLED`.
- No network call is attempted.
- No provider credentials are required, read, logged, or stored.
- Mock provider remains the default M0 provider.

### Validation

- provider disabled negative test
- no credential dependency review
- no runtime network requirement review

### Notes

- Real provider integration belongs to M1, not M0.

## M0-H - Validation And Closeout

status: DONE
priority: P0
lane: Safe Local Production Lane
project: M0 Video Loop Validation
scope: npm run test:m0, npm run demo:m0, npm run closeout:m0, m0_closeout.yaml, implementation summary, self-review
branch: local-only
depends_on: M0-G
handoff_doc: docs/m0/M0_Codex_Handoff_Prompt_v1.1.md
allowed_delivery: local_file_update,tests,demo,closeout_report,self_review,validation_log,handoff
blocked_delivery: push,tag,release,deploy,publish,real_provider_call,provider_credential_read,secret_read,state_private_read,production_config_change
created_at: 2026-07-06
updated_at: 2026-07-06
claimed_at: 2026-07-06T12:11:41+08:00
claim_run_id: codex-20260706-121141-m0-h
completed_at: 2026-07-06T12:13:42+08:00
result: PASS_WITH_GAPS

### Goal

Run final M0 validation and produce honest closeout evidence.

### Acceptance

- `npm run test:m0` passes.
- `npm run demo:m0` passes and exercises the tool interface.
- `npm run closeout:m0` writes `data/reports/m0_closeout.yaml`.
- Closeout report includes all required validation, evidence, artifact summary, scenarios, hard gates, known gaps, and next recommendation.
- Implementation summary is produced.
- Self-review report is produced.

### Validation

- `npm run test:m0`
- `npm run demo:m0`
- `npm run closeout:m0`
- closeout YAML structure check
- self-review structure check

### Notes

- Report `external_transfer_path: NOT_TESTED` if no real external transfer path is available.
- Do not overclaim M1 readiness.
