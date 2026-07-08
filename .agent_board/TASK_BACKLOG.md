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

## R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT - Local App Contract Freeze And H1 API Support

status: DONE
priority: P0
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: contract-only local app reality review, H1 API support draft, WebGPT MCP v0 dependency draft, report schema, latest pointer strategy, hard gate matrix
branch: local-only
depends_on: none
source_plan: docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
report_path: docs/three_routes/r3_0_local_app_contract_freeze_result.md
allowed_delivery: read_non_sensitive_source,read_non_sensitive_reports,write_contract_report,write_docs_only
blocked_delivery: source_code_change,data_model_migration,provider_call,video_generation,secret_read,env_file_edit,push,tag,release,deploy
created_at: 2026-07-06T20:25:39+08:00
updated_at: 2026-07-06T20:38:47+08:00
claimed_at: 2026-07-06T20:38:47+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T20:44:30+08:00
completed_by: Codex sustained executor
result: PASS_CONTRACT_READY

### Goal

Inspect the current local app implementation without changing code, then freeze the app-side object, API, report, latest pointer, and hard-gate contract needed by H1 Workbench and WebGPT MCP v0.

### Acceptance

- Current object and schema inventory is produced.
- Existing tool and script inventory is produced.
- H1 read endpoint draft is produced.
- H1 mutation endpoint draft is produced.
- WebGPT MCP v0 read tool draft is produced.
- Mutation report schema is produced.
- Latest pointer strategy is defined.
- Hard gate matrix is defined.
- Implementation gaps and next implementation plan are documented.
- No provider call, video generation, secret read, or source code change occurs.

### Validation

- `git diff --check`

### Notes

- This is the only imported three-route task currently marked `READY`.
- Output result should be `PASS_CONTRACT_READY` or `BLOCK_WITH_REASON`.
- Stop if progress requires reading `.env`, `.env.local`, private state, or secret values.

## R2-1_H1_HANDOFF_WORKBENCH_MVP - H1 Handoff Workbench MVP

status: DONE
priority: P0
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: local H1 Human Workbench implementation for Dashboard, Imports, Shots, Storyboard Package, Reports
branch: local-only
depends_on: R3-2_STORYBOARD_PACKAGE_FREEZE_CORE
source_plan: docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
report_path: data/reports/h1_handoff_workbench_mvp_result.json
allowed_delivery: source_code_change,tests,local_ui,immutable_report,latest_pointer_report,docs_update_if_needed
blocked_delivery: runway_real_call,runninghub_real_call,video_generation,regeneration,batch_generation,final_assembly,memory_saveback,env_file_edit,secret_printing,public_tunnel,source_overwrite,fake_id_acceptance,push,tag,release,deploy
created_at: 2026-07-06T20:25:39+08:00
updated_at: 2026-07-06T20:39:06+08:00
claimed_at: 2026-07-06T20:44:30+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T20:51:20+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Implement or finish the local H1 Human Workbench MVP with Chinese human-facing UI and strict app-side gates for import, shot review, package freeze, and reports.

### Acceptance

- Dashboard, Imports, Shots, Storyboard Package, and Reports pages are present.
- Local server binds `127.0.0.1`, rejects LAN access, uses mutation nonce/CSRF, forbids arbitrary paths, and exposes no shell command execution.
- Imports can register approved SHOT images while rejecting audit, reference, docs, zip, path traversal, symlink escape, fake IDs, and pending IDs.
- Shots can link active storyboard image artifacts and mark approved or revision needed.
- Package freeze is blocked until all shots are complete and approved.
- Reports can open latest and historical reports.
- No provider call, video generation, secret exposure, source overwrite, push, tag, release, or deploy occurs.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run test:g0`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task is promoted to `READY` for sustained automation, but remains dependency-gated behind R2-0, R3-1, and R3-2.
- UI-visible text for the human workbench should be Simplified Chinese.

## R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT - Strict Single Runway Canary Script

status: DONE
priority: P1
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: dry-run-only strict single Runway canary script and authorization boundary
branch: local-only
depends_on: R2-1_H1_HANDOFF_WORKBENCH_MVP
source_plan: docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
report_path: data/reports/r3_3_strict_single_runway_canary_result.json
allowed_delivery: source_code_change,tests,dry_run_report,secret_redaction,provider_preflight_reuse
blocked_delivery: runway_called,runninghub_called,network_call_attempted,provider_credits_consumed,real_video_generated,regeneration,batch_generation,secret_value_output,push,tag,release,deploy
created_at: 2026-07-06T20:25:39+08:00
updated_at: 2026-07-06T20:59:00+08:00
claimed_at: 2026-07-06T20:51:20+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T20:59:00+08:00
completed_by: Codex sustained executor
result: PASS_READY_FOR_USER_AUTHORIZATION

### Goal

Implement a strict dry-run-first `npm run runway:canary` entry that prepares a one-submit Runway canary plan without making any network or provider call.

### Acceptance

- Dry-run report includes provider `runway`, endpoint `/v1/image_to_video`, `X-Runway-Version=2024-11-06`, duration `2`, max submit calls `1`, selected input image, and ratio mapping proof.
- Project aspect ratio `9:16` maps to Runway ratio `768:1280`; `9:16` is never sent to Runway as the API `ratio`.
- `RUNWAYML_API_SECRET` presence may be checked only as a boolean and must not be printed.
- Report marks `network_call_attempted=false`, `runway_called=false`, `runninghub_called=false`, `provider_credits_consumed=false`, and `real_video_generated=false`.
- Real call requires separate current Jenn authorization naming provider, max submit calls, input image, duration, budget or cost bound, and stop condition.

### Validation

- `npm run env:check`
- `npm run provider:preflight`
- `npm run typecheck`
- `npm run test:m1`
- `npm run test:g0`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task is promoted to `READY` for sustained automation, but only for dry-run implementation.
- Live provider execution must remain a separate future task requiring exact current Jenn authorization.

## R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN - WebGPT MCP Boundary And Read-Only Bridge Plan

status: DONE
priority: P2
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: docs-only WebGPT MCP boundary and read-only bridge plan
branch: local-only
depends_on: R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT
source_plan: docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
report_path: docs/three_routes/r1_0_webgpt_mcp_boundary_readonly_bridge_plan.md
allowed_delivery: docs_only,boundary_plan,schemas,no_runtime_server_required
blocked_delivery: full_mcp_app_implementation,mutation_tool_implementation,provider_tool_implementation,secret_read,public_tunnel,push,tag,release,deploy
created_at: 2026-07-06T20:25:39+08:00
updated_at: 2026-07-06T21:28:00+08:00
claimed_at: 2026-07-06T21:23:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T21:28:00+08:00
completed_by: Codex sustained executor
result: PASS_MCP_BOUNDARY_READY

### Goal

Plan the WebGPT MCP or bridge boundary so Web GPT can read real app status and submit drafts later without gaining provider, shell, secret, filesystem, or direct mutation power.

### Acceptance

- Short-term bridge is local-only by default and forbids public tunnel by default.
- v0 read-only tools are listed.
- v0.5 draft submission tools are listed separately from production truth.
- v1 human-confirmed action request flow is defined.
- Forbidden tool list includes provider calls, shell execution, secret reads, raw env reads, source overwrites, deletes, direct package freeze, final delivery approval, and long-term memory write without human confirmation.
- Error schema, report reference schema, and Human Workbench confirmation flow are documented.
- No provider call, mutation implementation, secret exposure, push, tag, release, or deploy occurs.

### Validation

- `git diff --check`

### Notes

- This task is promoted to `READY` for sustained automation, but remains behind local contract, H1, and dry-run canary planning.

## R2-0_HUMAN_WORKBENCH_UX_STATE_PLAN - Human Workbench UX And State Plan

status: DONE
priority: P0
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: H1/H2/H3/H4/H5 workbench page, state, action, hard-gate, local-server-security planning
branch: local-only
depends_on: R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
source_plan: docs/three_routes/source_v1_1/04_R2_HUMAN_WORKBENCH_ROUTE_TASKBOOK.md
report_path: docs/three_routes/r2_0_human_workbench_ux_state_plan.md
allowed_delivery: docs_only,boundary_plan,screen_contract,action_contract,hard_gate_matrix
blocked_delivery: source_code_change,provider_call,video_generation,secret_read,env_file_edit,public_tunnel,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T21:03:00+08:00
claimed_at: 2026-07-06T21:03:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T21:08:00+08:00
completed_by: Codex sustained executor
result: PASS_UX_STATE_READY

### Goal

Freeze Human Workbench pages, state sources, actions, approval gates, mutation report schema, local server security rules, and no-provider boundaries before extending UI implementation.

### Acceptance

- H1 through H5 page roles are documented.
- Each page lists read state, allowed actions, hard gates, and blocked actions.
- Mutation report schema is defined.
- Local server security rules are defined: `127.0.0.1`, reject LAN, nonce/CSRF for mutations, no arbitrary paths, no shell commands, no public tunnel.
- Provider calls are excluded from H1 and require separate later authorization.
- Fake IDs, pending IDs, source overwrite, and secret exposure are blocked.

### Validation

- `git diff --check`

### Notes

- This is a docs-only planning task inserted before H1 implementation.

## R3-1_MEDIA_ARTIFACT_IMPORT_CORE - Media Artifact Import Core

status: DONE
priority: P0
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: data/imports image import hardening, image validation, app-controlled media artifact registration, unsafe import rejection, immutable import report
branch: local-only
depends_on: R2-0_HUMAN_WORKBENCH_UX_STATE_PLAN
source_plan: docs/three_routes/source_v1_1/03_R3_LOCAL_APP_ROUTE_TASKBOOK.md
report_path: data/reports/r3_1_media_artifact_import_core_result.json
allowed_delivery: source_code_change,tests,fixtures,immutable_report,latest_pointer_report
blocked_delivery: provider_call,video_generation,secret_read,env_file_edit,source_overwrite,arbitrary_path_read,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T21:08:00+08:00
claimed_at: 2026-07-06T21:08:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T21:17:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Stabilize `data/imports -> register_media_artifact -> data/media/artifacts/images -> real artifact_id` for approved WebGPT keyframes.

### Acceptance

- Approved SHOT image becomes an active `image/storyboard_image` Media Artifact.
- PNG/JPEG readability, width, height, aspect ratio, size bytes, and checksum are recorded.
- Path traversal and symlink escape are rejected.
- Audit images, references, docs, zip, non-images, unreadable images, `PENDING_*`, and fake IDs are rejected.
- Source files are not overwritten.
- Immutable import report and latest pointer are written.
- Provider boundary remains false.

### Validation

- `npm run typecheck`
- `npm run test:g0`
- `npm run secret:scan`
- `git diff --check`

### Notes

- If existing implementation already satisfies this, produce a closeout report and targeted tests rather than rewriting.

## R3-2_STORYBOARD_PACKAGE_FREEZE_CORE - Storyboard Package Freeze Core

status: DONE
priority: P0
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: validate/import/freeze app-ready Storyboard Package with active artifact IDs and immutable reports
branch: local-only
depends_on: R3-1_MEDIA_ARTIFACT_IMPORT_CORE
source_plan: docs/three_routes/source_v1_1/03_R3_LOCAL_APP_ROUTE_TASKBOOK.md
report_path: data/reports/r3_2_storyboard_package_freeze_core_result.json
allowed_delivery: source_code_change,tests,immutable_report,latest_pointer_report
blocked_delivery: provider_call,video_generation,secret_read,env_file_edit,fake_id_acceptance,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T21:23:00+08:00
claimed_at: 2026-07-06T21:17:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T21:23:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Ensure WebGPT shot scripts and real app-returned artifact IDs can be validated and frozen into an app-ready Storyboard Package.

### Acceptance

- Complete 4-shot package validates PASS.
- Incomplete package returns `BLOCK_WITH_REASON`.
- `PENDING_*`, fake IDs, missing active storyboard images, missing description, missing video prompt, missing duration, and invalid negative prompt are rejected.
- Raw `data/imports` paths are not allowed in the provider chain.
- Package is frozen immutably and previous package versions are not overwritten.
- Real `storyboard_package_id` is returned only by the app.

### Validation

- `npm run typecheck`
- `npm run test:g0`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task gates H1 package freeze behavior.

## R2-2_H2_CANARY_WORKBENCH - H2 Canary Workbench

status: DONE
priority: P1
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: Provider Guard and Canary UI for dry-run readiness, authorization explanation, and redacted provider state
branch: local-only
depends_on: R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN
source_plan: docs/three_routes/source_v1_1/04_R2_HUMAN_WORKBENCH_ROUTE_TASKBOOK.md
report_path: data/reports/r2_2_h2_canary_workbench_result.json
allowed_delivery: source_code_change,tests,local_ui,dry_run_report,redacted_status_display
blocked_delivery: provider_call,network_call_attempted,video_generation,secret_printing,env_file_edit,public_tunnel,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T21:35:00+08:00
claimed_at: 2026-07-06T21:28:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T21:35:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Add or specify the H2 Provider Guard / Canary workbench page so Jenn can inspect readiness and authorization requirements before any real provider call.

### Acceptance

- Active provider, env check, preflight, selected canary input, dimensions, ratio, Runway ratio, duration, and `max_submit_calls=1` are visible.
- No regeneration and no batch status are visible.
- Dry-run canary plan can be generated or opened.
- Secret values are never shown.
- Real submit requires separate exact Jenn authorization and is not performed by this task.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task may implement UI or produce a detailed implementation spec depending on current code reality.

## R1-1_MCP_V0_READ_ONLY_SERVICE - MCP v0 Read-Only Service

status: DONE
priority: P1
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: WebGPT MCP or bridge v0 read-only tools for app-side status, reports, and redacted provider readiness
branch: local-only
depends_on: R2-2_H2_CANARY_WORKBENCH
source_plan: docs/three_routes/source_v1_1/05_R1_WEBGPT_MCP_ROUTE_TASKBOOK.md
report_path: data/reports/r1_1_mcp_v0_read_only_service_result.json
allowed_delivery: source_code_change,tests,local_bridge,read_only_tools,docs_update
blocked_delivery: mutation_tools,provider_tools,provider_call,secret_read,raw_filesystem_access,shell_execution,public_tunnel,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T21:43:00+08:00
claimed_at: 2026-07-06T21:35:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T21:43:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Allow WebGPT to read real app-side status without guessing artifact, shot, package, report, or provider readiness state.

### Acceptance

- Read-only tool schema is implemented or frozen.
- Tools include workspace status, project status, import candidates, media artifacts, shot status, package status, latest reports, and redacted provider readiness summary.
- No mutation, provider call, shell execution, secret read, raw filesystem exposure, or public tunnel is implemented.
- GPT cannot invent IDs because all IDs returned are app-side facts.

### Validation

- `npm run typecheck`
- `npm run secret:scan`
- `git diff --check`

### Notes

- If implementation would require external hosting or public tunnel, stop and report `BLOCK_WITH_REASON`.

## R3-4_PACKAGE_BASED_SHOT_GENERATION - Package-Based Shot Generation

status: DONE
priority: P1
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: frozen package to Generation Run to generated_clip artifact path, with provider hard gate and local validation
branch: local-only
depends_on: R1-1_MCP_V0_READ_ONLY_SERVICE
source_plan: docs/three_routes/source_v1_1/03_R3_LOCAL_APP_ROUTE_TASKBOOK.md
report_path: data/reports/r3_4_package_based_shot_generation_result.json
allowed_delivery: source_code_change,tests,dry_run_provider_request_builder,provider_gate,download_adapter_mock,ffprobe_validation_logic,immutable_report
blocked_delivery: live_provider_call_without_exact_authorization,secret_printing,source_overwrite,raw_data_imports_provider_input,automatic_regeneration,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T21:52:00+08:00
claimed_at: 2026-07-06T21:43:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T21:52:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Implement the package-based generation path from frozen Storyboard Package shot to Generation Run and generated clip artifact, while stopping before any unapproved live provider submit.

### Acceptance

- `create_generation_run_from_package_shot` or equivalent is implemented.
- Provider request body builder maps project `9:16` to Runway `768:1280`.
- Provider hard gate blocks live submit without exact current Jenn authorization.
- Output downloader and generated clip artifact registration are implemented using mock or fixture validation when no live call is authorized.
- ffprobe validation logic is present.
- Old versions are not overwritten.
- Raw WebGPT image paths and `data/imports` are never used as provider input.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run test:g0`
- `npm run secret:scan`
- `git diff --check`

### Notes

- If exact current authorization for a live provider call is absent, complete safe implementation and report live generation as not performed.

## R2-3_H3_VIDEO_REVIEW_WORKBENCH - H3 Video Review Workbench

status: DONE
priority: P1
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: human video review UI for generated_clip artifacts, ffprobe metadata, Generation Run, approval, rejection, and regeneration request drafts
branch: local-only
depends_on: R3-4_PACKAGE_BASED_SHOT_GENERATION
source_plan: docs/three_routes/source_v1_1/04_R2_HUMAN_WORKBENCH_ROUTE_TASKBOOK.md
report_path: data/reports/r2_3_h3_video_review_workbench_result.json
allowed_delivery: source_code_change,tests,local_ui,review_report,regeneration_request_draft
blocked_delivery: automatic_regeneration,provider_call,secret_read,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T22:08:00+08:00
claimed_at: 2026-07-06T21:52:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T22:08:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Let Jenn review generated clips, approve or reject them, record rejection reasons, and create regeneration request drafts without automatically regenerating.

### Acceptance

- generated_clip artifact playback or metadata view is available.
- ffprobe metadata and Generation Run are visible.
- Approve and reject decisions are saved.
- Approved clip writes `accepted_clip_artifact_id`.
- Rejected clip remains traceable.
- Regeneration request is a draft and requires explicit confirmation before execution.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task must not trigger regeneration.

## R1-2_MCP_V0_5_DRAFT_SUBMISSION - MCP v0.5 Draft Submission

status: DONE
priority: P2
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: WebGPT draft submission tools stored separately from production truth
branch: local-only
depends_on: R2-3_H3_VIDEO_REVIEW_WORKBENCH
source_plan: docs/three_routes/source_v1_1/05_R1_WEBGPT_MCP_ROUTE_TASKBOOK.md
report_path: data/reports/r1_2_mcp_v0_5_draft_submission_result.json
allowed_delivery: source_code_change,tests,draft_storage,tool_schema,docs_update
blocked_delivery: direct_freeze,direct_artifact_registration,provider_call,secret_read,shell_execution,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T22:22:00+08:00
claimed_at: 2026-07-06T22:09:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T22:22:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Allow GPT to submit creative drafts and proposed links without changing production truth or bypassing human workbench approval.

### Acceptance

- Draft tools are defined for shot script draft, storyboard package draft, artifact link proposal, validation proposal, and freeze request proposal.
- Drafts are stored separately from app-ready truth.
- Human Workbench can review drafts.
- Fake IDs are rejected.
- No frozen package is created directly by GPT.

### Validation

- `npm run typecheck`
- `npm run secret:scan`
- `git diff --check`

### Notes

- Draft submission is not a production mutation.

## R1-3_MCP_V1_HUMAN_CONFIRMED_HANDOFF_TOOLS - MCP v1 Human-Confirmed Handoff Tools

status: DONE
priority: P2
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: pending action request tools that require Human Workbench confirmation before Local App mutation
branch: local-only
depends_on: R1-2_MCP_V0_5_DRAFT_SUBMISSION
source_plan: docs/three_routes/source_v1_1/05_R1_WEBGPT_MCP_ROUTE_TASKBOOK.md
report_path: data/reports/r1_3_mcp_v1_human_confirmed_handoff_tools_result.json
allowed_delivery: source_code_change,tests,pending_action_queue,tool_schema,docs_update
blocked_delivery: direct_mutation_without_human_confirmation,provider_call,secret_read,shell_execution,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T22:36:00+08:00
claimed_at: 2026-07-06T22:23:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T22:36:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Allow GPT to request low-risk mutations by creating pending actions that Jenn must confirm or reject in the Human Workbench before Local App execution.

### Acceptance

- Tools are defined for request register media artifact from import, request link artifact to shot, request validate package, and request import package.
- GPT request creates a pending action only.
- Human Workbench displays pending action.
- Jenn confirmation or rejection is required.
- Local App executes mutation after confirmation and writes immutable report.

### Validation

- `npm run typecheck`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task must not allow GPT to execute mutations alone.

## R1-4_MCP_V2_REVIEW_ASSISTANT_TOOLS - MCP v2 Review Assistant Tools

status: DONE
priority: P2
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: GPT review assistant read and draft tools for generated clips and regeneration prompts
branch: local-only
depends_on: R1-3_MCP_V1_HUMAN_CONFIRMED_HANDOFF_TOOLS
source_plan: docs/three_routes/source_v1_1/05_R1_WEBGPT_MCP_ROUTE_TASKBOOK.md
report_path: data/reports/r1_4_mcp_v2_review_assistant_tools_result.json
allowed_delivery: source_code_change,tests,review_note_drafts,tool_schema,docs_update
blocked_delivery: final_human_approval,automatic_regeneration,provider_call,secret_read,shell_execution,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T22:50:00+08:00
claimed_at: 2026-07-06T22:37:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T22:50:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Let GPT read generated clip metadata and draft review notes, rejection reasons, and regeneration prompts without making final approval or triggering regeneration.

### Acceptance

- Tools are defined for get generation run, get generated clip metadata, submit review note draft, propose rejection reason, and propose regeneration prompt.
- Human final approval remains required.
- Regeneration is not triggered automatically.
- No provider call, shell execution, or secret exposure occurs.

### Validation

- `npm run typecheck`
- `npm run secret:scan`
- `git diff --check`

### Notes

- GPT suggestions remain drafts until human action.

## R3-5_REVIEW_REGENERATION_FINAL_ASSEMBLY_CORE - Review Regeneration Final Assembly Core

status: DONE
priority: P1
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: local core for clip review, regeneration run creation, no-overwrite versioning, accepted clip selection, final assembly report
branch: local-only
depends_on: R1-4_MCP_V2_REVIEW_ASSISTANT_TOOLS
source_plan: docs/three_routes/source_v1_1/03_R3_LOCAL_APP_ROUTE_TASKBOOK.md
report_path: data/reports/r3_5_review_regeneration_final_assembly_core_result.json
allowed_delivery: source_code_change,tests,local_review_core,regeneration_request_core,no_overwrite_versioning,assembly_readiness_gate,immutable_report
blocked_delivery: live_provider_call_without_exact_authorization,source_overwrite,final_assembly_without_accepted_clips,secret_read,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T23:00:00+08:00
claimed_at: 2026-07-06T22:51:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T23:00:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Implement or harden the local core for clip approval, rejection, regeneration run creation, no-overwrite clip versioning, accepted clip selection, and final assembly readiness.

### Acceptance

- `mark_clip_approved`, `mark_clip_rejected`, and `create_regeneration_run` or equivalents exist.
- Rejected clip remains traceable.
- Regeneration creates a new Generation Run and never overwrites old artifacts.
- Approved clip becomes `accepted_clip_artifact_id`.
- Final assembly is blocked until all required shots have accepted clips.
- Final assembly report is written when assembly is executed.
- Live provider regeneration requires exact authorization and is not automatic.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run test:m0`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task may complete local core and block live regeneration if provider authorization is absent.

## R2-4_H4_FINAL_ASSEMBLY_WORKBENCH - H4 Final Assembly Workbench

status: DONE
priority: P1
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: final assembly readiness UI, clip order preview, final assembly confirmation, export artifact display
branch: local-only
depends_on: R3-5_REVIEW_REGENERATION_FINAL_ASSEMBLY_CORE
source_plan: docs/three_routes/source_v1_1/04_R2_HUMAN_WORKBENCH_ROUTE_TASKBOOK.md
report_path: data/reports/r2_4_h4_final_assembly_workbench_result.json
allowed_delivery: source_code_change,tests,local_ui,assembly_readiness_display,final_report_display
blocked_delivery: final_assembly_without_confirmation,source_overwrite,secret_read,provider_call,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T23:15:00+08:00
claimed_at: 2026-07-06T23:00:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T23:15:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Let Jenn inspect final assembly readiness, preview clip order, confirm final assembly, and view final video artifact evidence.

### Acceptance

- All required shots must have accepted clips before assembly.
- Assembly readiness and blockers are visible.
- Final assembly approval requires explicit human confirmation.
- Final assembly report is visible.
- Final video artifact display includes ffprobe validation status when available.
- Source clips are not overwritten.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- UI may expose final assembly action only if local core gates pass.

## R3-6_MEMORY_ASSET_SAVEBACK_CORE - Memory Asset Saveback Core

status: DONE
priority: P2
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: Memory Saveback Proposal, Asset, Reference, Memory Item, Memory Recall Pack local core with human confirmation boundary
branch: local-only
depends_on: R2-4_H4_FINAL_ASSEMBLY_WORKBENCH
source_plan: docs/three_routes/source_v1_1/03_R3_LOCAL_APP_ROUTE_TASKBOOK.md
report_path: data/reports/r3_6_memory_asset_saveback_core_result.json
allowed_delivery: source_code_change,tests,proposal_report,asset_reference_schema,memory_recall_pack_schema
blocked_delivery: long_term_memory_write_without_human_confirmation,secret_read,private_state_read,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T23:25:00+08:00
claimed_at: 2026-07-06T23:15:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T23:25:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Create the local core for project closeout memory and asset saveback proposals without writing long-term memory unless Jenn confirms.

### Acceptance

- Closeout creates a Memory Saveback Proposal.
- Proposal items preserve provenance to project, shot, artifact, and run.
- Approved items can become Memory Items only after human confirmation.
- Rejected items are not saved.
- Asset and Reference updates preserve provenance.
- Memory Recall Pack can be generated for future GPT use.

### Validation

- `npm run typecheck`
- `npm run secret:scan`
- `git diff --check`

### Notes

- If no secure memory channel is available or approved, stop at proposal/report generation.

## R2-5_H5_MEMORY_ASSET_WORKBENCH - H5 Memory Asset Workbench

status: DONE
priority: P2
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: Memory Saveback Proposal review, asset/reference curation UI, approve/reject/edit with provenance
branch: local-only
depends_on: R3-6_MEMORY_ASSET_SAVEBACK_CORE
source_plan: docs/three_routes/source_v1_1/04_R2_HUMAN_WORKBENCH_ROUTE_TASKBOOK.md
report_path: data/reports/r2_5_h5_memory_asset_workbench_result.json
allowed_delivery: source_code_change,tests,local_ui,proposal_review,asset_reference_review
blocked_delivery: automatic_memory_save,secret_read,private_state_read,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T23:35:00+08:00
claimed_at: 2026-07-06T23:25:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T23:35:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Let Jenn review, edit, approve, or reject Memory Saveback Proposal items and asset/reference updates with clear provenance.

### Acceptance

- Memory Saveback Proposal is visible.
- Human can approve, reject, or edit memory items.
- Asset/reference updates preserve provenance.
- No automatic memory save occurs without confirmation.
- Rejected memory items remain rejected and are not written to long-term memory.

### Validation

- `npm run typecheck`
- `npm run secret:scan`
- `git diff --check`

### Notes

- UI-visible text should be Simplified Chinese.

## R1-5_MCP_V3_PRODUCTION_ASSISTANT - MCP v3 Production Assistant

status: DONE
priority: P2
lane: Safe Local Production Lane
project: AI Video Production Workspace Three Route Plan
scope: GPT production assistant planning tools for generation, regeneration, assembly, and memory saveback proposals
branch: local-only
depends_on: R2-5_H5_MEMORY_ASSET_WORKBENCH
source_plan: docs/three_routes/source_v1_1/05_R1_WEBGPT_MCP_ROUTE_TASKBOOK.md
report_path: data/reports/r1_5_mcp_v3_production_assistant_result.json
allowed_delivery: source_code_change,tests,planning_tools,tool_schema,docs_update
blocked_delivery: real_provider_call,final_delivery_approval,long_term_memory_write,secret_read,shell_execution,source_overwrite,push,tag,release,deploy
created_at: 2026-07-06T20:39:06+08:00
updated_at: 2026-07-06T23:45:00+08:00
claimed_at: 2026-07-06T23:35:00+08:00
claim_run_id: codex-20260706-203847-three-route-sustained
claimed_by: Codex sustained executor
completed_at: 2026-07-06T23:45:00+08:00
completed_by: Codex sustained executor
result: PASS

### Goal

Let GPT assist with generation, regeneration, final assembly, and memory saveback planning while Human Workbench remains the hard gate and Local App remains the only executor.

### Acceptance

- Tools are defined for propose generation plan, propose regeneration plan, propose final assembly plan, and propose memory saveback.
- GPT proposes but does not execute real provider calls.
- GPT cannot approve final delivery.
- GPT cannot write long-term memory.
- Human Workbench remains hard gate and Local App remains executor.

### Validation

- `npm run typecheck`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This is the final full-route assistant layer and should not weaken earlier boundaries.

## R3-7_RUNWAY_LIVE_CANARY_AUTHORIZATION - Runway Live Canary Authorization

status: DONE
priority: P0
lane: Approval Boundary Preparation
project: AI Video Production Workspace Three Route Plan
scope: prepare exact Jenn authorization checklist for one live Runway canary; do not submit provider request
branch: local-only
depends_on: R1-5_MCP_V3_PRODUCTION_ASSISTANT
source_plan: docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
report_path: data/reports/r3_7_runway_live_canary_authorization_result.json
allowed_delivery: authorization_checklist,readiness_review,dry_run_report_reference,handoff,validation_log
blocked_delivery: runway_submit,runninghub_call,network_call_attempted,provider_credits_consumed,real_video_generated,secret_value_output,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T10:55:00+08:00
updated_at: 2026-07-07T11:34:21+08:00
claimed_at: 2026-07-07T11:30:15+08:00
claim_run_id: codex-20260707-113015-r3-7
claimed_by: Codex sustained executor
completed_at: 2026-07-07T11:34:21+08:00
completed_by: Codex sustained executor
result: PASS_READY_FOR_USER_AUTHORIZATION

### Goal

Prepare the exact authorization surface for a single live Runway canary after the local three-route workflow has passed. This task must stop before any live provider submit.

### Acceptance

- Confirm latest strict canary dry-run report is present.
- Confirm selected input image is explicit and readable.
- Confirm provider is `runway`.
- Confirm endpoint is `/v1/image_to_video`.
- Confirm `X-Runway-Version=2024-11-06`.
- Confirm duration is `2`.
- Confirm max submit calls is `1`.
- Confirm project aspect ratio `9:16` maps to Runway `768:1280`.
- Confirm `RUNWAYML_API_SECRET` presence is checked only as a boolean and no secret value is printed.
- Produce exact Jenn authorization phrase/checklist naming provider, max submit calls, input image, duration, budget/cost bound, and stop condition.
- Report `network_call_attempted=false`, `runway_called=false`, `runninghub_called=false`, `provider_credits_consumed=false`, and `real_video_generated=false`.

### Validation

- `npm run env:check`
- `npm run provider:preflight`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This is an authorization preparation task, not the live canary execution.
- A live Runway submit requires a separate exact current Jenn authorization after this task.

## R3-8A_RUNWAY_GEN45_CONTRACT_FIX_AND_DRY_RUN - Runway Gen-4.5 Contract Fix And Dry Run

status: DONE
priority: P0
lane: Provider Contract Correction
project: AI Video Production Workspace Three Route Plan
scope: fix Runway Gen-4.5 image-to-video ratio mapping and regenerate dry-run evidence without provider calls
branch: local-only
depends_on: R3-7_RUNWAY_LIVE_CANARY_AUTHORIZATION
source_plan: Commander side review after Runway Gen-4.5 contract investigation
report_path: data/reports/r3_8a_runway_gen45_contract_dry_run_report.json
allowed_delivery: source_code_change,tests,dry_run_report,contract_mapping_update,local_commit
blocked_delivery: runway_submit,runninghub_call,network_call_attempted,provider_credits_consumed,real_video_generated,secret_value_output,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T12:26:42+08:00
updated_at: 2026-07-07T12:26:42+08:00
claimed_at: 2026-07-07T12:20:00+08:00
claim_run_id: r3-8a-worker-run
claimed_by: worker
completed_at: 2026-07-07T12:26:42+08:00
completed_by: worker
commit: 143da65
result: PASS_READY_FOR_REAUTHORIZATION

### Goal

Correct the Runway Gen-4.5 canary contract so project aspect ratio `9:16` maps to Runway ratio `720:1280`, not `768:1280`, while preserving `duration_seconds=2` for budget control.

### Acceptance

- Confirm `provider=runway`.
- Confirm `model=gen4.5`.
- Confirm endpoint is `POST /v1/image_to_video`.
- Confirm `X-Runway-Version=2024-11-06`.
- Confirm `duration_seconds=2`.
- Confirm max submit calls is `1`.
- Confirm project aspect ratio `9:16` maps to Runway `720:1280`.
- Confirm `network_call_attempted=false`.
- Confirm `runway_called=false` and `runninghub_called=false`.
- Confirm `provider_credits_consumed=false`.
- Confirm `secret_values_exposed=false`.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run test:g0`
- `npm run secret:scan`
- `git diff --check`

### Notes

- R3-8A was completed and committed as `143da65`.
- R3-8A is the dependency gate for R3-8B.

## R3-8B_RUNWAY_GEN45_SINGLE_SUBMIT_CANARY_REAUTHORIZATION - Runway Gen-4.5 Single-Submit Canary Reauthorization

status: FAILED
priority: P0
lane: Approval Boundary Live Provider Execution
project: AI Video Production Workspace Three Route Plan
scope: execute exactly one authorized Runway Gen-4.5 image-to-video canary after exact current Jenn authorization
branch: local-only
depends_on: R3-8A_RUNWAY_GEN45_CONTRACT_FIX_AND_DRY_RUN
source_plan: data/reports/r3_8a_runway_gen45_contract_dry_run_report.json
report_path: data/reports/m1_r0_runway_canary_live_result.json
allowed_delivery: preflight,one_authorized_runway_submit,live_result_report,provider_job_id_if_present,local_media_artifact_if_succeeded,ffprobe_if_succeeded,local_commit
blocked_delivery: runway_submit_without_exact_authorization,runninghub_call,second_submit,retry,regeneration,batch,provider_credits_beyond_one_submit,secret_value_output,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T12:32:22+08:00
updated_at: 2026-07-07T13:38:48+08:00
claimed_at: 2026-07-07T13:36:51+08:00
claim_run_id: codex-20260707-133651-r3-8b
claimed_by: Codex R3-8B executor
completed_at: null
completed_by: null
failed_at: 2026-07-07T13:38:48+08:00
failed_by: Codex R3-8B executor
result: PROVIDER_FAILED

### Goal

Execute a single Runway Gen-4.5 canary only after Jenn provides the exact current authorization phrase for this task. If exact authorization is absent, the worker may perform safe preflight only and must stop before any live provider submit.

### Live Contract

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

### Required Authorization Phrase

Jenn must provide an exact current authorization phrase equivalent to:

```text
授权执行 1 次 Runway single-submit canary 真实调用：provider=runway，endpoint=POST /v1/image_to_video，X-Runway-Version=2024-11-06，model=gen4.5，input=fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png，duration_seconds=2，ratio=720:1280，max_submit_calls=1，预算/费用上限=仅允许这 1 次 canary submit 且不允许自动重试或第二次计费调用，output_dir=data/media/provider-canary/m1-r0-runway-canary/，成功后下载为本地 media artifact 并 ffprobe 校验；不得调用 RunningHub，不得 regeneration，不得 batch，不得发布/部署，不得覆盖源资产，不得打印 secret。
```

### Acceptance

- Claim R3-8B only after confirming R3-8A commit `143da65` and dry-run report are present.
- Confirm `.agent_board/RUN_LOCK.md` is inactive before claim.
- Confirm active provider is `runway`.
- Confirm `RUNWAYML_API_SECRET` presence only as a boolean; never print the value.
- Confirm `network_call_attempted=false` before the live command starts.
- Execute at most one Runway submit only after exact current Jenn authorization is present.
- Do not retry on failure.
- Do not call RunningHub.
- Do not run regeneration or batch generation.
- Do not publish, deploy, push, tag, or release.
- Do not overwrite source assets.
- If provider job id is present, record it in the live result report.
- If succeeded, download output to `data/media/provider-canary/m1-r0-runway-canary/`, register a local media artifact, and ffprobe validate it.
- If failed, record a sanitized provider failure summary without secret values or raw private payloads.
- Report truthful boundary flags for `network_call_attempted`, `runway_called`, `provider_credits_consumed`, `real_video_generated`, and `secret_values_exposed`.

### Validation

- `npm run env:check`
- `npm run provider:preflight`
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Stop Conditions

- Stop before live submit if exact current Jenn authorization is absent.
- Stop after one submit attempt, regardless of success or failure.
- Stop if the provider returns an input, auth, credit, rate-limit, or transient error.
- Stop if any secret value appears in output or report.

### Notes

- This is a paid/quota-consuming approval-boundary task.
- The worker must not use the old `768:1280` ratio.
- The worker must preserve the `duration_seconds=2` budget decision.
- R3-8B performed exactly one authorized Runway submit attempt and did not retry.
- Result was `PROVIDER_FAILED` with sanitized error code `PROVIDER_UNSUPPORTED_INPUT`.
- No provider job id was recorded, no local video artifact was generated, and no RunningHub call occurred.

## R3-8C_RUNWAY_SUBMIT_FAILURE_EVIDENCE_AND_INPUT_CONTRACT_TRIAGE - Runway Submit Failure Evidence And Input Contract Triage

status: DONE
priority: P0
lane: Provider Failure Evidence And Offline Triage
project: AI Video Production Workspace Three Route Plan
scope: add sanitized Runway failure evidence capture, safe request summary, canary image suitability review, and next input strategy recommendation
branch: local-only
depends_on: R3-8B_RUNWAY_GEN45_SINGLE_SUBMIT_CANARY_REAUTHORIZATION
source_plan: pasted R3-8C taskbook
report_path: data/reports/r3_8c_runway_submit_failure_triage_result.json
allowed_delivery: source_code_change,tests,offline_triage_report,local_commit
blocked_delivery: runway_call,runninghub_call,retry_live_submit,provider_credits_consumed,real_video_generated,secret_value_output,promptImage_base64_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T14:21:12+08:00
updated_at: 2026-07-07T14:21:12+08:00
claimed_at: 2026-07-07T14:21:12+08:00
claim_run_id: codex-20260707-142112-r3-8c
claimed_by: Codex R3-8C executor
completed_at: 2026-07-07T14:21:12+08:00
completed_by: Codex R3-8C executor
result: PASS_READY_FOR_INPUT_STRATEGY_DECISION

### Goal

Improve the evidence chain after R3-8B failed with `PROVIDER_UNSUPPORTED_INPUT`, while making no provider calls.

### Acceptance

- Sanitized provider error summary support exists for Runway non-2xx submit failures.
- Runway request summary support exists and excludes `promptImage`, base64, Authorization, secret names, and raw provider payload.
- Canary image suitability is reported.
- Next canary input strategy is reported.
- No Runway or RunningHub call, retry, credit consumption, real video generation, source overwrite, push, tag, release, or deploy occurred.

### Validation

- `npm run r3:8c:triage`
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- Current gradient fixture is technically valid but unsuitable for the next live Gen-4.5 I2V canary because it lacks a clear subject.
- Next live Runway submit requires a new exact current Jenn authorization phrase.

## R3-8D_PREPARE_REAL_STORYBOARD_KEYFRAME_CANARY - Prepare Real Storyboard Keyframe Canary

status: DONE
priority: P0
lane: Provider Input Preparation And Offline Canary Planning
project: AI Video Production Workspace Three Route Plan
scope: inspect app-registered approved WebGPT keyframes, validate image facts, select a real storyboard keyframe, and prepare a dry-run Runway canary plan
branch: local-only
depends_on: R3-8C_RUNWAY_SUBMIT_FAILURE_EVIDENCE_AND_INPUT_CONTRACT_TRIAGE
source_plan: pasted R3-8D taskbook
report_path: data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json
allowed_delivery: source_code_change,offline_prepare_report,task_board_update,local_commit
blocked_delivery: runway_call,runninghub_call,upload_to_runway,retry_live_submit,provider_credits_consumed,real_video_generated,secret_value_output,promptImage_base64_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T14:51:58+08:00
updated_at: 2026-07-07T14:51:58+08:00
claimed_at: 2026-07-07T14:51:58+08:00
claim_run_id: codex-20260707-145158-r3-8d
claimed_by: Codex R3-8D executor
completed_at: 2026-07-07T14:51:58+08:00
completed_by: Codex R3-8D executor
result: PASS_READY_FOR_USER_AUTHORIZATION

### Goal

Prepare a real storyboard keyframe canary input package for a future Runway Gen-4.5 single-submit authorization, without making any provider call.

### Selected Input

- Shot: `SHOT_001`
- Artifact ID: `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- Source path: `A:\AI Video Production Workspace\data\imports\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png`
- Storage URI: `A:\AI Video Production Workspace\data\media\artifacts\images\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png`
- Canary contract: `provider=runway`, `model=gen4.5`, `duration_seconds=2`, `ratio=720:1280`, `max_submit_calls=1`

### Acceptance

- SHOT_001 through SHOT_004 WebGPT keyframes were reviewed.
- Selected input is a real storyboard keyframe with a clear subject.
- Selected artifact ID comes from the app media artifact registry.
- Selected input is not the gradient fixture, audit image, or product reference.
- A dry-run real-keyframe canary plan and authorization phrase draft were generated.
- No Runway or RunningHub call, upload, retry, credit consumption, real video generation, source overwrite, push, tag, release, or deploy occurred.

### Validation

- `npm run r3:8d:prepare`
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- R3-8D stops before live provider execution.
- The only allowed next live step is R3-8E with a new exact current Jenn authorization phrase.

## R3-8E_RUNWAY_REAL_STORYBOARD_KEYFRAME_SINGLE_SUBMIT_AUTHORIZATION - Runway Real Storyboard Keyframe Single-Submit Authorization

status: FAILED
priority: P0
lane: Approval Boundary Live Provider Execution
project: AI Video Production Workspace Three Route Plan
scope: execute exactly one authorized Runway Gen-4.5 image-to-video canary using the R3-8D real storyboard keyframe
branch: local-only
depends_on: R3-8D_PREPARE_REAL_STORYBOARD_KEYFRAME_CANARY
source_plan: Jenn exact authorization phrase on 2026-07-07
report_path: data/reports/r3_8e_runway_real_storyboard_keyframe_canary_result.json
allowed_delivery: one_authorized_runway_submit,sanitized_live_result_report,provider_failure_classification_fix,tests,task_board_update,local_commit
blocked_delivery: second_submit,retry_live_submit,runninghub_call,regeneration,batch_generation,source_overwrite,secret_value_output,promptImage_base64_output,raw_provider_payload_recording,push,tag,release,deploy
created_at: 2026-07-07T15:14:33+08:00
updated_at: 2026-07-07T15:14:33+08:00
claimed_at: 2026-07-07T15:14:33+08:00
claim_run_id: codex-20260707-151433-r3-8e
claimed_by: Codex R3-8E executor
failed_at: 2026-07-07T15:14:33+08:00
failed_by: Codex R3-8E executor
result: PROVIDER_FAILED_INSUFFICIENT_CREDITS

### Goal

Perform the one exact Jenn-authorized real storyboard keyframe Runway canary and stop after that one submit attempt.

### Execution

- Provider: `runway`
- Endpoint: `POST /v1/image_to_video`
- X-Runway-Version: `2024-11-06`
- Model: `gen4.5`
- Selected artifact: `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- Source storage: `A:\AI Video Production Workspace\data\media\artifacts\images\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png`
- Duration: `2`
- Ratio: `720:1280`
- Submit calls: `1`
- Provider job id present: `false`
- Generated video artifact: `none`

### Failure

Runway returned sanitized provider evidence indicating insufficient credits. No retry was attempted.

### Validation

- `npm run env:check`
- `npm run provider:preflight`
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- `max_submit_calls=1` has been used as an attempt.
- Another live Runway submit requires a new exact current Jenn authorization phrase and should be opened as a new task.

## R3-8F_PROVIDER_PRIORITY_SWITCH_TO_RUNNINGHUB - Provider Priority Switch To RunningHub

status: DONE
priority: P0
lane: Provider Strategy Update
project: AI Video Production Workspace Three Route Plan
scope: make RunningHub.cn the primary real provider choice and move Runway to secondary fallback
branch: local-only
depends_on: R3-8E_RUNWAY_REAL_STORYBOARD_KEYFRAME_SINGLE_SUBMIT_AUTHORIZATION
source_plan: Jenn instruction on 2026-07-07 to stop using Runway as first choice and make runninghub.cn first choice
report_path: data/reports/r3_8f_provider_priority_switch_to_runninghub_result.json
allowed_delivery: provider_registry_change,tests,env_example_update,local_commit
blocked_delivery: runninghub_call,runway_call,provider_credits_consumed,real_video_generated,secret_value_output,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T15:28:31+08:00
updated_at: 2026-07-07T15:28:31+08:00
claimed_at: 2026-07-07T15:28:31+08:00
claim_run_id: codex-20260707-152831-r3-8f
claimed_by: Codex commander
completed_at: 2026-07-07T15:28:31+08:00
completed_by: Codex commander
commit: 9a4f081
result: PASS_LOCAL_PRIORITY_SWITCH

### Goal

Make RunningHub.cn the primary real provider choice while keeping mock as the safe local default and Runway as a secondary selectable fallback.

### Acceptance

- `runninghub` is the primary real provider in the provider registry.
- `runway` is no longer the primary real provider.
- `.env.example` presents RunningHub.cn as the primary real provider.
- Tests assert the new provider priority.
- No RunningHub or Runway call occurs.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task changed provider priority only.
- RunningHub live adapter still returns `PROVIDER_UNSUPPORTED` until its contract is frozen and implemented.

## R3-8G_RUNNINGHUB_CONTRACT_FREEZE_AND_DRY_RUN - RunningHub Contract Freeze And Dry Run

status: DONE
priority: P0
lane: Provider Contract Freeze
project: AI Video Production Workspace Three Route Plan
scope: freeze RunningHub.cn model API contract and build a no-network dry-run request plan for the selected real storyboard keyframe
branch: local-only
depends_on: R3-8F_PROVIDER_PRIORITY_SWITCH_TO_RUNNINGHUB
source_plan: Jenn instruction to use runninghub.cn as first provider after Runway insufficient credits
report_path: data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json
allowed_delivery: docs_contract_review,source_code_change,tests,dry_run_report,task_board_update,local_commit
blocked_delivery: runninghub_call,runway_call,provider_credits_consumed,real_video_generated,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T15:37:23+08:00
updated_at: 2026-07-07T15:55:16+08:00
claimed_at: 2026-07-07T15:42:16+08:00
claim_run_id: codex-20260707-154200-r3-8g
claimed_by: Codex R3-8G executor
completed_at: 2026-07-07T15:55:16+08:00
completed_by: Codex R3-8G executor
result: PASS_CONTRACT_FREEZE_DRY_RUN

### Goal

Freeze the RunningHub.cn image-to-video API contract for the current real storyboard keyframe workflow and produce a dry-run request plan. This task must not call RunningHub, Runway, or any paid/quota-consuming provider endpoint.

### Required Source Review

- Review the official RunningHub site: `https://www.runninghub.cn/`.
- Review the RunningHub model API detail page if available: `https://www.runninghub.cn/call-api/api-detail/2019380112598044674`.
- If the official API page is unavailable, requires login, or lacks enough details, mark the missing fields explicitly and return `BLOCK_WITH_REASON`.
- Do not rely on stale memory or guessed request fields.

### Contract Fields To Freeze

- API base URL.
- Submit endpoint path and HTTP method.
- Auth mechanism and required header names, without reading or printing credential values.
- Workflow/model identifier field names.
- Input image field shape.
- Prompt field names, including positive and negative prompt support.
- Duration field name and supported range.
- Ratio/resolution field name and supported values for vertical output.
- Task id/job id field in the submit response.
- Status polling endpoint, method, and status values.
- Output URL/file field shape.
- Error response shape and retryability classes.

### Dry-Run Plan

Use the R3-8D selected keyframe unless Jenn changes it:

- artifact_id: `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- storage_uri: `A:\AI Video Production Workspace\data\media\artifacts\images\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png`
- source_path: `A:\AI Video Production Workspace\data\imports\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png`

The dry-run report must include a sanitized request summary only:

- provider: `runninghub`
- model/workflow id or unresolved field.
- endpoint and method.
- selected artifact facts: mime type, dimensions, sha256, byte size.
- prompt text length, not raw secret/private payloads.
- no API key, no Authorization header value, no base64 image payload.

### Acceptance

- RunningHub is confirmed as primary provider in local registry.
- Runway remains secondary and is not called.
- RunningHub live adapter remains no-call unless this task implements only local request building.
- Dry-run request summary is generated without credentials, base64, or raw payloads.
- Missing official contract fields are named explicitly.
- Next safe task is recommended: implementation, further docs research, or user authorization preparation.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- Do not run `npm run env:check` or `npm run provider:preflight` against `.env.local` unless Jenn gives a fresh exact authorization to read local env presence.
- Synthetic env values may be used in tests if they are clearly fake and secret scan passes.
- This task must stop before any live RunningHub submit.

## R3-8H_RUNNINGHUB_ADAPTER_OR_AUTHORIZATION_NEXT_STEP - RunningHub Adapter Or Authorization Next Step

status: DONE
priority: P0
lane: Provider Adapter Implementation
project: AI Video Production Workspace Three Route Plan
scope: implement RunningHub upload-first adapter skeleton, request builders, parsers, and offline tests without any provider network call
branch: local-only
depends_on: R3-8G_RUNNINGHUB_CONTRACT_FREEZE_AND_DRY_RUN
source_plan: data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json
report_path: data/reports/r3_8h_runninghub_adapter_skeleton_offline_result.json
allowed_delivery: source_code_change,tests,offline_adapter_dry_run_report,task_board_update,local_commit
blocked_delivery: runninghub_call,runway_call,media_upload_to_provider,status_poll,output_download_from_provider,provider_credits_consumed,real_video_generated,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T15:37:23+08:00
updated_at: 2026-07-07T16:25:39+08:00
claimed_at: 2026-07-07T16:13:45+08:00
claim_run_id: codex-20260707-161345-r3-8h
claimed_by: Codex R3-8H executor
completed_at: 2026-07-07T16:25:39+08:00
completed_by: Codex R3-8H executor
result: PASS_ADAPTER_SKELETON_OFFLINE
commit: b1efae2

### Goal

Implement the local RunningHub adapter skeleton required by the R3-8G frozen contract while keeping the whole task offline. The adapter should build upload-first request plans and parse synthetic submit/query/error responses, but must not call RunningHub or Runway.

### Required Implementation

- Add a RunningHub upload request builder for `POST /openapi/v2/media/upload/binary`.
- Add a RunningHub submit request builder for `POST /openapi/v2/rhart-video-g/image-to-video`.
- Add a RunningHub query request builder for `POST /openapi/v2/query`.
- Add sanitized request summaries that exclude API keys, Authorization values, raw binary data, base64, local private payloads, and raw provider payloads.
- Add response parsers for upload `data.download_url`, submit `taskId/status/errorCode/errorMessage`, and query `results[].url`.
- Add error mapping for invalid API key, rate limit, insufficient permission/credits, content safety, timeout, generation failure, and unknown provider failure where official docs allow.
- Keep `RunningHubVideoProviderAdapter.submitGeneration` fail-closed unless a later exact live-call task authorizes and implements network execution.

### Acceptance

- RunningHub remains the primary provider in the registry.
- Adapter request builders produce the R3-8G contract shape.
- Unit tests cover upload, submit, query, output URL extraction, error mapping, and secret/base64 redaction.
- No network call is attempted.
- No RunningHub upload, submit, query, poll, or output download is attempted.
- No Runway call is attempted.
- No provider credits are consumed.
- No real video is generated.
- No secret values, Authorization values, raw binary payloads, base64 image payloads, or raw provider payloads are recorded.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This is not a live RunningHub integration task.
- Any real RunningHub upload/submit/query requires a future exact current Jenn authorization phrase.

## R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP - RunningHub Real Keyframe Authorization Prep

status: DONE
priority: P0
lane: Approval Boundary Preparation
project: AI Video Production Workspace Three Route Plan
scope: prepare exact authorization checklist for one RunningHub real-keyframe live canary after R3-8H offline adapter tests pass
branch: local-only
depends_on: R3-8H_RUNNINGHUB_ADAPTER_OR_AUTHORIZATION_NEXT_STEP
source_plan: R3-8H result
report_path: data/reports/r3_8i_runninghub_real_keyframe_authorization_prep_result.json
allowed_delivery: authorization_checklist,final_guard_report,dry_run_report_reference,task_board_update,local_commit
blocked_delivery: runninghub_call,runway_call,media_upload_to_provider,status_poll,output_download_from_provider,provider_credits_consumed,real_video_generated,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T16:06:04+08:00
updated_at: 2026-07-07T17:18:38+08:00
claimed_at: 2026-07-07T17:13:33+08:00
claim_run_id: codex-20260707-171333-r3-8i
claimed_by: Codex R3-8I executor
completed_at: 2026-07-07T17:18:38+08:00
completed_by: Codex R3-8I executor
result: PASS_READY_FOR_USER_AUTHORIZATION

### Goal

Prepare the exact authorization phrase and final guard for a single RunningHub real-keyframe canary. This task must stop before any live provider upload or submit.

### Required Preparation

- Confirm the selected storyboard keyframe artifact from the app registry, not a GPT-invented ID.
- Reuse the R3-8G frozen RunningHub contract and R3-8H offline adapter skeleton.
- Prepare the upload-first plan for `POST /openapi/v2/media/upload/binary`.
- Prepare the single-submit plan for `POST /openapi/v2/rhart-video-g/image-to-video`.
- Prepare the query plan for `POST /openapi/v2/query`.
- Set `max_submit_calls=1`.
- Disable retries, batch, regeneration, publish, deploy, source overwrite, and any fallback to Runway.
- Produce a final guard report and exact user authorization phrase for the later live canary task.

### Acceptance

- No network call is attempted.
- No RunningHub upload, submit, query, poll, or output download is attempted.
- No Runway call is attempted.
- No provider credits are consumed.
- No real video is generated.
- No secret values, Authorization values, raw binary payloads, base64 image payloads, or raw provider payloads are recorded.
- The next live task remains blocked until Jenn gives a new exact authorization phrase.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

### Notes

- This task is `READY` because R3-8H passed with commit `b1efae2`.
- It must confirm selected artifact, upload-first plan, budget limit, max submit calls, and stop conditions.
- Duration override on 2026-07-07: current R3-8I report and exact authorization phrase use `duration_seconds=3` per Jenn's request. No live RunningHub upload or submit has occurred, so no channel/provider link exists yet.

## R3-8J_RUNNINGHUB_REAL_KEYFRAME_SINGLE_SUBMIT_CANARY - RunningHub Real Keyframe Single-Submit Canary

status: FAILED
priority: P0
lane: Approval Boundary Live Provider Execution
project: AI Video Production Workspace Three Route Plan
scope: execute exactly one Jenn-authorized RunningHub upload-first real-keyframe canary
branch: local-only
depends_on: R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP
source_plan: R3-8I exact authorization
report_path: data/reports/r3_8j_runninghub_real_keyframe_single_submit_canary_result.json
allowed_delivery: one_authorized_runninghub_upload,one_authorized_runninghub_submit,status_query,output_download_if_succeeded,ffprobe_if_succeeded,sanitized_live_result_report,local_commit
blocked_delivery: runninghub_call_without_exact_authorization,runway_call,second_submit,retry_live_submit,regeneration,batch_generation,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T16:06:04+08:00
updated_at: 2026-07-07T17:46:23+08:00
claimed_at: 2026-07-07T17:43:55+08:00
claim_run_id: codex-20260707-174355-r3-8j
claimed_by: Codex R3-8J executor
failed_at: 2026-07-07T17:46:23+08:00
failed_by: Codex R3-8J executor
result: PROVIDER_FAILED_DURATION_MIN_6

### Goal

Run exactly one live RunningHub canary under Jenn's fresh exact authorization phrase. This task must not perform a second submit or automatic retry.

### Notes

- `max_submit_calls=1` must be enforced.
- Use `duration_seconds=3` from the current R3-8I authorization prep.
- Upload, submit, status query, and download must be truthfully counted and reported.
- Result: one authorized upload and one authorized submit were attempted. RunningHub rejected `duration=3` with sanitized evidence that the minimum duration is `6`; no provider job id, output URL, local video artifact, or ffprobe result exists.

## R3-8J_RECEIPT_FIX - R3-8J RunningHub Duration Failure Receipt Fix

status: IN_PROGRESS
priority: P0
lane: Provider Evidence Receipt
project: AI Video Production Workspace Three Route Plan
scope: backfill R3-8J live canary commit and duration-minimum failure receipt before further retry planning
branch: local-only
depends_on: R3-8J_RUNNINGHUB_REAL_KEYFRAME_SINGLE_SUBMIT_CANARY
source_plan: R3-8J result
report_path: data/reports/r3_8j_runninghub_real_keyframe_single_submit_canary_result.json
allowed_delivery: receipt_metadata_update,task_board_update,local_commit
blocked_delivery: runninghub_call,runway_call,media_upload_to_provider,status_poll,output_download_from_provider,provider_credits_consumed,real_video_generated,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T17:55:56+08:00
updated_at: 2026-07-07T18:23:37+08:00
claimed_at: 2026-07-07T18:23:37+08:00
claim_run_id: codex-20260707-182337-r3-8j-receipt-fix
claimed_by: Codex R3-8J receipt fixer
completed_at: 2026-07-07T18:23:37+08:00
completed_by: Codex R3-8J receipt fixer
result: PASS_RECEIPT_FIXED

### Goal

Repair the R3-8J audit chain before any further RunningHub retry planning.

### Acceptance

- Backfill R3-8J commit `1f68c36` into the R3-8J report, backlog, and ledger where applicable.
- Record that RunningHub received exactly one upload and exactly one submit.
- Record that `query_call_count=0`, `provider_job_id_present=false`, and no channel/output URL exists.
- Record the provider-side duration contract evidence: `duration=3` is below minimum value `6`.
- Leave R3-8L as the next eligible offline duration-contract repair task.
- Do not call RunningHub or Runway.
- Receipt fixed: R3-8J implementation commit is `1f68c36`; upload count `1`, submit count `1`, query count `0`, job id absent, output/channel link absent, and RunningHub minimum duration is `6`.

### Validation

- JSON parse for updated report files
- `npm run secret:scan`
- `git diff --check`

## R3-8L_RUNNINGHUB_DURATION_CONTRACT_REPAIR_DRY_RUN - RunningHub Duration Contract Repair Dry Run

status: DONE
priority: P0
lane: Provider Contract Repair
project: AI Video Production Workspace Three Route Plan
scope: repair RunningHub duration minimum contract offline and add fail-fast guard before any future live retry
branch: local-only
depends_on: R3-8J_RECEIPT_FIX
source_plan: R3-8J sanitized duration-minimum failure evidence
report_path: data/reports/r3_8l_runninghub_duration_contract_repair_dry_run_result.json
allowed_delivery: source_code_change,tests,dry_run_report,task_board_update,local_commit
blocked_delivery: runninghub_call,runway_call,media_upload_to_provider,status_poll,output_download_from_provider,provider_credits_consumed,real_video_generated,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T17:55:56+08:00
updated_at: 2026-07-07T18:26:33+08:00
claimed_by: Codex R3-8L executor
claim_run_id: codex-20260707-182633-r3-8l
claimed_at: 2026-07-07T18:26:33+08:00
completed_by: Codex R3-8L executor
completed_at: 2026-07-07T18:31:23+08:00
result: PASS_DURATION_CONTRACT_REPAIRED
validation_result: PASS
evidence: data/reports/r3_8l_runninghub_duration_contract_repair_dry_run_result.json
delivery: local_only

### Goal

Update the local RunningHub contract so `duration_seconds < 6` fails before upload or submit. Regenerate a dry-run plan for the same real storyboard keyframe using `duration_seconds=6`.

### Required Implementation

- Encode RunningHub minimum duration as `6` for `rhart-video-g/image-to-video`.
- Add or update a fail-fast guard so future `duration_seconds < 6` attempts stop before upload.
- Update request-plan builders and authorization-prep logic to use `duration_seconds=6` for this RunningHub model.
- Add tests proving `duration_seconds=3` is blocked before upload/submit.
- Produce a dry-run report with `duration_seconds=6`, `max_upload_calls=1`, `max_submit_calls=1`, `query_until_terminal=true`, `network_call_attempted=false`, `runninghub_called=false`, and `provider_credits_consumed=false`.

### Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## R3-8L_RECEIPT_FIX_R1 - R3-8L Receipt Fix R1

status: READY
priority: P0
lane: Provider Evidence Receipt
project: AI Video Production Workspace Three Route Plan
scope: backfill R3-8J receipt fix commit and R3-8L duration contract repair commit before any R3-8M live canary authorization
branch: local-only
depends_on: R3-8L_RUNNINGHUB_DURATION_CONTRACT_REPAIR_DRY_RUN
source_plan: R3-8L result
report_path: data/reports/r3_8l_runninghub_duration_contract_repair_dry_run_result.json
allowed_delivery: receipt_metadata_update,task_board_update,local_commit
blocked_delivery: runninghub_call,runway_call,media_upload_to_provider,status_poll,output_download_from_provider,provider_credits_consumed,real_video_generated,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-08T09:55:24+08:00
updated_at: 2026-07-08T09:55:24+08:00

### Goal

Repair the local audit chain after R3-8J receipt fix and R3-8L duration-contract repair, before any R3-8M live canary authorization.

### Acceptance

- R3-8J receipt-fix ledger entry records commit `590f7fd`.
- R3-8L ledger entry records commit `18f0d90`.
- R3-8L NEXT_TASK/report receipt metadata records commit `18f0d90` where applicable.
- R3-8M remains `FOLLOW_UP` and depends on `R3-8L_RECEIPT_FIX_R1`.
- Do not call RunningHub or Runway.

### Validation

- JSON parse for updated report/state files
- `npm run secret:scan`
- `git diff --check`

## R3-8M_RUNNINGHUB_6S_SINGLE_SUBMIT_CANARY - RunningHub 6s Single-Submit Canary

status: FOLLOW_UP
priority: P0
lane: Approval Boundary Live Provider Execution
project: AI Video Production Workspace Three Route Plan
scope: execute one RunningHub upload-first live canary using duration_seconds=6 after R3-8L receipt fix passes and Jenn gives a fresh exact authorization phrase
branch: local-only
depends_on: R3-8L_RECEIPT_FIX_R1
source_plan: R3-8L receipt-fixed dry-run report
report_path: data/reports/r3_8m_runninghub_6s_single_submit_canary_result.json
allowed_delivery: one_authorized_runninghub_upload,one_authorized_runninghub_submit,status_query,output_download_if_succeeded,ffprobe_if_succeeded,sanitized_live_result_report,local_commit
blocked_delivery: runninghub_call_without_exact_authorization,runway_call,second_submit,retry_live_submit,regeneration,batch_generation,secret_value_output,raw_provider_payload_recording,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T17:55:56+08:00
updated_at: 2026-07-08T09:55:24+08:00

### Goal

Run exactly one RunningHub 6-second canary only after Jenn provides a fresh exact current authorization phrase.

### Hard Boundary

- `duration_seconds=6`
- `max_upload_calls=1`
- `max_submit_calls=1`
- no retry or second submit
- no batch
- no regeneration
- no Runway fallback
- no source overwrite
- no secret output

## R3-8K_PROVIDER_PATH_DECISION_CLOSEOUT - Provider Path Decision Closeout

status: FOLLOW_UP
priority: P1
lane: Provider Decision Closeout
project: AI Video Production Workspace Three Route Plan
scope: summarize Runway and RunningHub evidence and decide M1 provider path readiness after a duration-valid RunningHub canary result
branch: local-only
depends_on: R3-8M_RUNNINGHUB_6S_SINGLE_SUBMIT_CANARY
source_plan: R3-8M result
report_path: data/reports/r3_8k_provider_path_decision_closeout.json
allowed_delivery: decision_report,readiness_summary,task_board_update,local_commit
blocked_delivery: provider_call,provider_credits_consumed,real_video_generated,secret_value_output,source_overwrite,push,tag,release,deploy
created_at: 2026-07-07T16:06:04+08:00
updated_at: 2026-07-07T17:55:56+08:00

### Goal

Close the provider-selection loop after duration-valid RunningHub live canary evidence is available. This task does not call any provider.
