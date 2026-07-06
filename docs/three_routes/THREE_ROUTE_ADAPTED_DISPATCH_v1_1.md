# AI Video Production Workspace - Three Route Adapted Dispatch v1.1

Source package:

```text
C:\Users\617\Downloads\AI_Video_Workspace_Three_Route_Plan_v1_1.zip
```

Adaptation result:

```yaml
adaptation_result: READY_FOR_COMMANDER_REVIEW
queue_imported: false
reason_not_imported:
  - current .agent_board state was not explicitly scoped for mutation
  - this document is a queue-ready dispatch surface for commander approval
  - importing into TASK_BACKLOG.md should be a separate explicit queue-maintenance action
created_at: 2026-07-06
workspace: A:\AI Video Production Workspace
```

This document converts `07_CODEX_DISPATCH_TASKS.md` into queue-ready task cards
and patches the required hard gates identified during review. It does not execute
the tasks, call providers, read secrets, or mutate `.agent_board`.

## Dispatch Order

```yaml
dispatch_order:
  - R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
  - R2-1_H1_HANDOFF_WORKBENCH_MVP
  - R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT
  - R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN
```

## Global Boundaries

```yaml
global_forbidden:
  - read_or_print_secret_values
  - call_runway_without_explicit_current_authorization
  - call_runninghub_without_explicit_current_authorization
  - generate_real_video_without_explicit_current_authorization
  - overwrite_source_assets
  - accept_fake_or_pending_app_ids_as_truth
  - push
  - tag
  - release
  - deploy
  - public_tunnel
  - production_config_change

global_required_evidence:
  provider_boundary:
    network_call_attempted: false
    runway_called: false
    runninghub_called: false
    provider_credits_consumed: false
    real_video_generated: false
    secret_values_exposed: false
```

## Queue Card Template

```yaml
task_id:
status: READY
priority:
route:
depends_on:
title:
intent:
workspace: A:\AI Video Production Workspace
allowed_delivery:
blocked_delivery:
required_inputs:
required_outputs:
validation_commands:
report_path:
stop_boundary:
acceptance:
```

## Task Card 1

```yaml
task_id: R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
status: READY
priority: P0
route: R3_LOCAL_APP
depends_on: []
title: Local App Contract Freeze And H1 API Support
intent: contract_only
workspace: A:\AI Video Production Workspace

scope:
  - inspect current app-side object model
  - inspect scripts and tool exports
  - draft H1 read endpoint contract
  - draft H1 mutation endpoint contract
  - draft WebGPT MCP v0 read tool contract
  - define mutation report schema
  - define latest pointer strategy
  - define hard gate matrix
  - identify implementation gaps
  - produce next implementation plan

allowed_delivery:
  - read_non_sensitive_source
  - read_non_sensitive_reports
  - write_contract_report
  - write_docs_only

blocked_delivery:
  - source_code_change
  - data_model_migration
  - provider_call
  - video_generation
  - secret_read
  - env_file_edit
  - push
  - tag
  - release
  - deploy

required_inputs:
  - package.json
  - src/
  - scripts/
  - tests/
  - data/reports filenames and redacted summaries only
  - .env.example only

required_outputs:
  - current_object_schema_inventory
  - existing_tool_script_inventory
  - h1_read_endpoint_draft
  - h1_mutation_endpoint_draft
  - mcp_v0_read_tool_draft
  - mutation_report_schema
  - latest_pointer_strategy
  - hard_gate_matrix
  - implementation_gaps
  - next_implementation_plan

report_path: docs/three_routes/r3_0_local_app_contract_freeze_result.md

validation_commands:
  - git diff --check

stop_boundary:
  - if progress requires reading .env or .env.local contents
  - if code mutation appears necessary
  - if current repo state prevents reliable inventory

acceptance:
  result: PASS_CONTRACT_READY or BLOCK_WITH_REASON
  no_network_call: true
  no_secret_exposure: true
  no_source_code_change: true
```

## Task Card 2

```yaml
task_id: R2-1_H1_HANDOFF_WORKBENCH_MVP
status: READY
priority: P0
route: R2_HUMAN_WORKBENCH
depends_on:
  - R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
title: H1 Handoff Workbench MVP
intent: local_implementation
workspace: A:\AI Video Production Workspace

scope:
  - implement Dashboard
  - implement Imports
  - implement Shots
  - implement Storyboard Package
  - implement Reports
  - expose local-only HTTP app or equivalent local operator UI
  - reuse Local App validation and mutation functions
  - write H1 closeout result

local_server_security:
  bind_host: 127.0.0.1
  reject_lan_access: true
  no_public_tunnel: true
  no_arbitrary_path_input: true
  no_shell_command_from_ui: true
  mutation_allowlist_required: true
  csrf_or_action_nonce_for_mutations: required
  report_read_by_basename_allowlist: true
  import_image_read_allowlist: data/imports
  source_asset_overwrite: forbidden

page_requirements:
  Dashboard:
    - project_readiness
    - import_readiness
    - shot_completeness
    - package_blockers
    - latest_reports
    - provider_readiness_summary_read_only
  Imports:
    - scan_data_imports
    - preview_images
    - validate_selected_image
    - register_approved_image_as_media_artifact
    - block_audit_reference_docs_zip
    - block_path_traversal
    - block_symlink_escape
  Shots:
    - edit_description_video_prompt_negative_prompt_duration
    - link_active_media_artifact
    - mark_approved_or_revision_needed
    - block_pending_ids
    - block_inactive_artifact
  Storyboard_Package:
    - run_validateG0StoryboardPackage
    - freeze_app_ready_package
    - write_immutable_report
    - update_latest_pointer
  Reports:
    - open_latest_report
    - open_report_history
    - show_provider_boundary_evidence

allowed_delivery:
  - source_code_change
  - tests
  - local_ui
  - immutable_report
  - latest_pointer_report
  - docs_update_if_needed

blocked_delivery:
  - runway_real_call
  - runninghub_real_call
  - video_generation
  - regeneration
  - batch_generation
  - final_assembly
  - memory_saveback
  - env_file_edit
  - secret_printing
  - public_tunnel
  - source_overwrite
  - fake_id_acceptance
  - push
  - tag
  - release
  - deploy

required_outputs:
  - H1_HANDOFF_WORKBENCH_MVP_RESULT
  - changed_files
  - pages
  - api_endpoints
  - reports_written
  - validation
  - provider_boundary

report_path: data/reports/h1_handoff_workbench_mvp_result.json

validation_commands:
  - npm run typecheck
  - npm run test:m1
  - npm run test:g0
  - npm run secret:scan
  - git diff --check

required_tests:
  positive:
    - register_approved_SHOT_image
    - link_active_artifact_to_shot
    - validate_complete_package
    - freeze_app_ready_package
  negative:
    - reject_audit_image
    - reject_product_reference
    - reject_PENDING_ids
    - reject_inactive_artifact
    - reject_package_freeze_before_all_shots_approved
    - ensure_no_provider_or_network_call_from_H1

stop_boundary:
  - if implementation requires secret contents
  - if real provider call becomes necessary
  - if source asset overwrite is requested by UI flow
  - if arbitrary filesystem access is required

acceptance:
  result: PASS or BLOCK_WITH_REASON
  all_pages_present: true
  no_provider_call: true
  no_secret_exposure: true
  local_server_security_pass: true
```

## Task Card 3

```yaml
task_id: R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT
status: READY
priority: P0
route: R3_LOCAL_APP
depends_on:
  - R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
title: Strict Single Runway Canary Script
intent: dry_run_implementation_first
workspace: A:\AI Video Production Workspace

phase_policy:
  current_phase: dry_run_only
  real_call_requires_separate_current_authorization: true
  real_call_authorization_must_name:
    - provider
    - max_submit_calls
    - input_image
    - duration_seconds
    - expected_cost_or_budget
    - stop_condition

runway_hard_rules:
  provider: runway
  endpoint: /v1/image_to_video
  x_runway_version_header: 2024-11-06
  api_version_env: RUNWAYML_API_VERSION=2024-11-06
  max_submit_calls: 1
  duration_seconds: 2
  input_image: fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png
  project_aspect_ratio: 9:16
  runway_ratio: 768:1280
  forbidden_ratio_values:
    - 9:16
    - 16:9
  allow_regeneration: false
  allow_batch_generation: false
  allow_runninghub: false
  allow_publish: false
  allow_deploy: false
  allow_source_asset_overwrite: false
  allow_secret_printing: false

dry_run_report_required_fields:
  - provider
  - endpoint
  - x_runway_version_header
  - max_submit_calls
  - duration_seconds
  - input_image
  - input_readable
  - usable_for_real_provider_canary
  - runway_ratio
  - ratio_mapping_proof
  - env_secret_present_boolean_only
  - network_call_attempted=false
  - runway_called=false
  - runninghub_called=false
  - provider_credits_consumed=false
  - real_video_generated=false
  - requires_user_authorization_for_real_call=true

allowed_delivery:
  - source_code_change
  - tests
  - dry_run_report
  - secret_redaction
  - provider_preflight_reuse

blocked_delivery:
  - runway_called
  - runninghub_called
  - network_call_attempted
  - provider_credits_consumed
  - real_video_generated
  - regeneration
  - batch_generation
  - secret_value_output
  - push
  - tag
  - release
  - deploy

new_command:
  preferred: npm run runway:canary
  acceptable_alias: npm run demo:m1:canary

report_path: data/reports/r3_3_strict_single_runway_canary_result.json

validation_commands:
  - npm run env:check
  - npm run provider:preflight
  - npm run typecheck
  - npm run test:m1
  - npm run test:g0
  - npm run secret:scan
  - git diff --check

stop_boundary:
  - if live provider call would be attempted
  - if secret contents must be read or printed
  - if canary input is unreadable or not native 9:16
  - if Runway ratio would be sent as 9:16 instead of 768:1280

acceptance:
  result: PASS_READY_FOR_USER_AUTHORIZATION or BLOCK_WITH_REASON
  dry_run_only: true
  no_network_call: true
  no_secret_exposure: true
```

## Task Card 4

```yaml
task_id: R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN
status: READY
priority: P1
route: R1_WEBGPT_MCP
depends_on:
  - R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
title: WebGPT MCP Boundary And Read-Only Bridge Plan
intent: planning_and_contract_only
workspace: A:\AI Video Production Workspace

scope:
  - short_term_local_bridge_design
  - long_term_chatgpt_mcp_app_design
  - v0_read_only_tool_list
  - v0_5_draft_submission_tool_list
  - v1_human_confirmed_action_request_flow
  - forbidden_tool_list
  - auth_local_bridge_boundary
  - error_schema
  - report_reference_schema
  - human_workbench_confirmation_flow

short_term_bridge_boundary:
  default_network_mode: local_only
  public_tunnel: forbidden_by_default
  raw_filesystem_access: forbidden
  arbitrary_path_input: forbidden
  shell_execution: forbidden
  secret_read: forbidden
  provider_call: forbidden
  mutation_tools: forbidden_for_v0
  draft_submission: v0_5_only
  human_confirmed_mutation_request: v1_only

mcp_v0_read_tools:
  - get_workspace_status
  - get_project_status
  - list_import_candidates
  - list_media_artifacts
  - get_media_artifact
  - get_shot_status
  - get_storyboard_package_status
  - get_latest_reports
  - get_provider_readiness_summary_redacted

forbidden_tools:
  - call_runway
  - call_runninghub
  - run_shell
  - read_secret
  - read_raw_env
  - delete_file
  - overwrite_source_asset
  - direct_register_media_artifact_without_human_gate
  - direct_freeze_storyboard_package_without_human_gate
  - approve_final_delivery
  - write_long_term_memory_without_human_confirmation

allowed_delivery:
  - docs_only
  - boundary_plan
  - schemas
  - no_runtime_server_required

blocked_delivery:
  - full_mcp_app_implementation
  - mutation_tool_implementation
  - provider_tool_implementation
  - secret_read
  - public_tunnel
  - push
  - tag
  - release
  - deploy

report_path: docs/three_routes/r1_0_webgpt_mcp_boundary_readonly_bridge_plan.md

validation_commands:
  - git diff --check

stop_boundary:
  - if plan requires exposing public tunnel
  - if plan requires mutation before H1 confirmation flow exists
  - if plan requires secret or raw filesystem access

acceptance:
  result: PASS_MCP_BOUNDARY_READY or BLOCK_WITH_REASON
  no_mutation: true
  no_provider_call: true
  no_secret_exposure: true
```

## Import Guidance For `.agent_board`

Do not paste this document directly into `.agent_board/TASK_BACKLOG.md` without
queue-maintenance authorization. If the commander approves queue import, use the
following rules:

```yaml
queue_import_rules:
  - preserve current NEXT_TASK.json unless it is EMPTY/DONE/BLOCKED/FAILED/SKIPPED and no active RUN_LOCK exists
  - append cards as READY only if commander wants automatic execution
  - append cards as FOLLOW_UP if they are planning candidates only
  - keep depends_on exactly as listed above
  - do not mark R3-3 live provider call READY; only dry-run implementation is READY
  - record queue import in TASK_LEDGER.md and HANDOFF.md
```

Recommended initial queue statuses:

```yaml
recommended_backlog_status:
  R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT: READY
  R2-1_H1_HANDOFF_WORKBENCH_MVP: READY
  R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT: READY
  R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN: READY
```

## Adaptation Closeout

```yaml
ADAPTED_THREE_ROUTE_PLAN_V1_1_RESULT:
  result: PASS_ADAPTED_FOR_COMMANDER_REVIEW
  source_package_read_only: true
  queue_imported: false
  provider_call_attempted: false
  secret_values_exposed: false
  files_created:
    - docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
  next_step:
    - commander may approve importing these cards into .agent_board/TASK_BACKLOG.md
    - commander may instead execute any single task card manually
```
