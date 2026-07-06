# R1-0 WebGPT MCP Boundary And Read-Only Bridge Plan

```yaml
result: PASS_MCP_BOUNDARY_READY
task_id: R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN
created_at: 2026-07-06T21:23:00+08:00
workspace: A:\AI Video Production Workspace
source_plan:
  - docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
  - docs/three_routes/source_v1_1/05_R1_WEBGPT_MCP_ROUTE_TASKBOOK.md
  - docs/three_routes/r3_0_local_app_contract_freeze_result.md
intent: planning_and_contract_only
runtime_server_implemented: false
provider_boundary:
  network_call_attempted: false
  runway_called: false
  runninghub_called: false
  provider_credits_consumed: false
  real_video_generated: false
  secret_values_exposed: false
blocked_actions_not_performed:
  - full_mcp_app_implementation
  - mutation_tool_implementation
  - provider_tool_implementation
  - secret_read
  - public_tunnel
  - push
  - tag
  - release
  - deploy
```

## 1. Boundary Principle

Web GPT / MCP is a controlled connection layer. It may read app truth and submit proposals, but it is not the Local App, not the Human Workbench, and not a provider runner.

Authoritative state remains in the Local App:

- real `artifact_id` values come from app-side Media Artifact registration;
- real `storyboard_package_id` values come from app-side package import/freeze;
- reports under `data/reports` are references, not raw private payloads;
- Human Workbench remains the hard gate for local mutations;
- provider execution remains outside MCP unless a later task explicitly creates a separate human-authorized runner.

The short-term bridge is local-only by default. The long-term MCP App may add ChatGPT-native resources and UI, but it must keep the same permission split.

## 2. Architecture

Short term:

```text
Web GPT / GPT Action
  -> local-only HTTPS or localhost bridge
  -> Local App read surfaces / Human Workbench pending-action inbox
```

Long term:

```text
ChatGPT MCP App / Apps SDK
  -> MCP tools + resources + optional UI
  -> Local App and Human Workbench guarded actions
```

Default network rules:

```yaml
default_network_mode: local_only
bind_host: 127.0.0.1
public_tunnel: forbidden_by_default
lan_access: forbidden_by_default
production_deploy: out_of_scope
```

## 3. Tool Categories

| Category | Phase | Permission | Production Truth |
|---|---|---|---|
| Read-only status tools | v0 | read app state and report references | yes, app-owned truth only |
| Draft submission tools | v0.5 | write drafts to a separate draft store | no |
| Human-confirmed action request tools | v1 | create pending requests for Human Workbench review | no until accepted and executed by Local App |
| Review assistant tools | v2 | draft review notes and regeneration suggestions | no |
| Production assistant tools | v3 | propose generation, assembly, and saveback plans | no direct execution |
| Forbidden tools | all phases | never exposed through Web GPT MCP | no |

## 4. v0 Read-Only Tools

v0 tools must be side-effect-free. They return app truth and redacted readiness, never inferred IDs from chat context.

| Tool | Input | Output | Hard Gate |
|---|---|---|---|
| `get_workspace_status` | none | package version, available local surfaces, active task/report summary | no private state |
| `get_project_status` | `project_id?` | project status, active package id, readiness flags | app ids only |
| `list_import_candidates` | optional filters | staged import metadata, approval/rejection hints | basename-only, no arbitrary path |
| `list_media_artifacts` | role/status filters | app artifact summaries | no raw source reads |
| `get_media_artifact` | `artifact_id` | one artifact summary | real app id required |
| `get_shot_status` | `project_id?`, `shot_id?` | shot metadata and linked artifact ids | no mutation |
| `get_storyboard_package_status` | `project_id?`, `storyboard_package_id?` | package readiness/frozen status | no freeze |
| `get_latest_reports` | report type filters | report references and safe summaries | basename allowlist |
| `get_provider_readiness_summary_redacted` | provider filter | booleans and redacted readiness only | no secret values |

v0 returns `READ_ONLY` in every response and must include `mutation_allowed: false`.

## 5. v0.5 Draft Submission Tools

v0.5 may accept GPT-authored drafts, but drafts are separate from production truth. A draft cannot create a Media Artifact, link a shot, freeze a package, approve delivery, or call a provider.

| Tool | Purpose | Stored As | Not Allowed |
|---|---|---|---|
| `submit_shot_script_draft` | propose shot description, video prompt, negative prompt, duration | draft record | no shot mutation |
| `submit_storyboard_package_draft` | propose package structure using known app ids | draft record | no package freeze |
| `propose_artifact_link` | suggest linking an existing artifact to a shot | pending proposal | no direct link |
| `propose_package_validation` | request app validation in Human Workbench | pending proposal | no validation execution by GPT |
| `propose_freeze_request` | ask Human Workbench to consider freeze | pending proposal | no direct freeze |

Draft records must include:

```yaml
draft_id: app_generated
draft_type: shot_script | storyboard_package | artifact_link | validation_request | freeze_request
created_by: webgpt
created_at: iso_timestamp
source_conversation_ref: optional_redacted_reference
payload_summary: safe_summary
payload: draft_payload_without_secrets
status: submitted | accepted_by_human | rejected_by_human | superseded
production_effect: none
```

## 6. v1 Human-Confirmed Action Requests

v1 may create pending action requests. The Local App executes only after Human Workbench confirmation.

| Tool | Creates Pending Request | Human Workbench Executes |
|---|---|---|
| `request_register_media_artifact_from_import` | register an approved import candidate | `register_media_artifact` through app gate |
| `request_link_artifact_to_shot` | link real artifact id to shot | shot update through app gate |
| `request_validate_storyboard_package` | run package readiness check | app validation |
| `request_import_storyboard_package` | freeze app-ready package | app import/freeze with human confirmation |

Request schema:

```yaml
request_id: app_generated
requested_by: webgpt
requested_at: iso_timestamp
action_type: register_media_artifact | link_artifact_to_shot | validate_storyboard_package | import_storyboard_package
input_summary:
  project_id: string | null
  shot_id: string | null
  artifact_id: string | null
  import_candidate_basename: string | null
  report_refs: string[]
risk_class: low | medium | blocked
requires_human_confirmation: true
status: pending_human_review | accepted | rejected | expired | executed | blocked
provider_boundary:
  network_call_attempted: false
  provider_call_allowed: false
```

Execution schema after Human Workbench confirmation:

```yaml
execution_report:
  request_id: string
  executed_by: local_app
  confirmed_by_human: true
  confirmed_at: iso_timestamp
  result: PASS | BLOCK_WITH_REASON | FAIL
  immutable_report_path: data/reports/<stem>_<run_id>.json
  latest_report_path: data/reports/<stem>.json
```

## 7. Forbidden Tools

These tools must not exist in WebGPT MCP:

```yaml
forbidden_tools:
  - call_runway
  - call_runninghub
  - submit_provider_job
  - poll_provider_raw_payload
  - run_shell
  - read_secret
  - read_raw_env
  - read_cookie_jar
  - read_token_store
  - arbitrary_filesystem_read
  - delete_file
  - overwrite_source_asset
  - direct_register_media_artifact_without_human_gate
  - direct_link_artifact_to_shot_without_human_gate
  - direct_freeze_storyboard_package_without_human_gate
  - approve_final_delivery
  - write_long_term_memory_without_human_confirmation
```

If a user prompt asks Web GPT to do any forbidden action, MCP should return:

```yaml
ok: false
error:
  code: ACTION_NOT_AVAILABLE_IN_MCP
  message: This action requires Human Workbench or Local App execution outside the read-only MCP boundary.
```

## 8. Auth And Local Bridge Boundary

Short-term local bridge requirements:

```yaml
network:
  bind_host: 127.0.0.1
  public_tunnel: false
  cors_default: deny
  allowed_origin: explicit_local_operator_origin_only
auth:
  read_tools: local_operator_session_or_dev_token
  draft_tools: local_operator_session_or_dev_token
  mutation_requests: local_operator_session_plus_action_nonce
secrets:
  raw_env_values_returned: false
  credential_presence_boolean_allowed: true
  redacted_provider_status_allowed: true
filesystem:
  arbitrary_path_input: false
  report_read: basename_allowlist_only
  import_candidates: data/imports scan only
  source_asset_overwrite: false
```

Public tunnels remain forbidden by default because they convert a local operator bridge into an external attack surface. A future public bridge would need a separate security task, threat model, auth flow, rate limits, and explicit approval.

## 9. Error Schema

All MCP/Bridge tools should return stable, low-disclosure errors:

```yaml
success:
  ok: true
  tool: string
  mode: READ_ONLY | DRAFT_ONLY | PENDING_HUMAN_CONFIRMATION
  data: object
  report_refs: ReportReference[]
  provider_boundary: ProviderBoundaryFalse
failure:
  ok: false
  tool: string
  mode: READ_ONLY | DRAFT_ONLY | PENDING_HUMAN_CONFIRMATION
  error:
    code: stable_machine_code
    message: safe_human_message
    retryable: boolean
    next_safe_action: string | null
  report_refs: ReportReference[]
```

Common error codes:

```yaml
PROJECT_NOT_FOUND:
ARTIFACT_NOT_FOUND:
SHOT_NOT_FOUND:
REPORT_NOT_FOUND:
REPORT_NOT_ALLOWLISTED:
INVALID_APP_ID:
PENDING_ID_REJECTED:
HUMAN_CONFIRMATION_REQUIRED:
ACTION_NOT_AVAILABLE_IN_MCP:
PROVIDER_ACTION_FORBIDDEN:
SECRET_ACCESS_FORBIDDEN:
PUBLIC_TUNNEL_FORBIDDEN:
```

## 10. Report Reference Schema

MCP returns report references, not private raw logs or secrets.

```yaml
ReportReference:
  report_id: app_generated_or_basename
  kind: import_prep | package_freeze | canary_dry_run | h1_action | validation | closeout
  basename: string
  relative_path: data/reports/<basename>
  immutable: boolean
  latest_pointer: boolean
  created_at: iso_timestamp | null
  result: PASS | PASS_READY_FOR_USER_AUTHORIZATION | BLOCK_WITH_REASON | FAIL | PARTIAL | UNKNOWN
  safe_summary: string
```

Report read rules:

- basename only, no path traversal;
- reports root containment check;
- JSON/YAML/Markdown only when explicitly allowlisted;
- no `.env`, database dump, raw provider payload, raw log, token, cookie, or private-state file;
- large media files are referenced as Media Artifacts, not streamed through MCP v0.

## 11. Human Workbench Confirmation Flow

```text
Web GPT proposes or requests action
  -> MCP writes draft or pending request
  -> Human Workbench displays request, input summary, blockers, and risk
  -> Jenn accepts or rejects
  -> Local App executes the allowed mutation
  -> Local App writes immutable report and latest pointer
  -> MCP read tools expose the updated app truth and report reference
```

Confirmation hard gates:

```yaml
human_confirmation_required_for:
  - register_media_artifact
  - link_artifact_to_shot
  - validate_storyboard_package
  - import_storyboard_package
  - provider canary real submit
  - regeneration
  - final assembly
  - memory saveback
human_confirmation_not_sufficient_for:
  - secret printing
  - arbitrary shell execution
  - source asset overwrite without exact explicit scope
  - public tunnel without separate security approval
```

## 12. Acceptance Closeout

```yaml
acceptance:
  short_term_bridge_local_only: true
  public_tunnel_forbidden_by_default: true
  v0_read_only_tools_listed: true
  v0_5_draft_submission_tools_listed: true
  v1_human_confirmed_action_request_flow_defined: true
  forbidden_tool_list_complete: true
  error_schema_defined: true
  report_reference_schema_defined: true
  human_workbench_confirmation_flow_defined: true
  provider_call_attempted: false
  mutation_implementation_added: false
  secret_exposure: false
  push_tag_release_deploy: false
```

## 13. Validation

Required validation for this docs-only task:

```yaml
git diff --check: PASS
```

This task did not implement a runtime MCP service, read secret/private-state contents, open a public tunnel, call providers, generate video, mutate production app state, push, tag, release, or deploy.
