# Current Workbench Canary Readiness

Status: `BLOCKED_BY_S3_FINDING`

Task: `S3-T1_CURRENT_WORKBENCH_CANARY_READINESS`

Baseline: `f4a15f565865c045325274251a91d2e11c633e41`

Date: 2026-07-30

This is a low-disclosure local readiness receipt. It is not a Provider
preflight, paid generation authorization, Provider acceptance or S4 execution
receipt.

## Result

```yaml
result: BLOCKED_BY_S3_FINDING
current_path_static_verification: PASS
local_environment: PASS
activity_database_readonly_check: PASS
targeted_isolated_tests: PASS
s4_authorized: false
s4_executable: false
provider_network_call_attempted: false
```

Three current local findings prevent S4:

1. `S3_NO_ELIGIBLE_SHOT`: no active production Shot satisfies the complete
   approved-package, operational-state and RunningHub capability boundary.
2. `S3_RUNNINGHUB_CREDENTIAL_NOT_CONFIGURED`: the RunningHub target credential
   is not present in the existing local Provider configuration.
3. `S3_PROVIDER_POLL_TIMEOUT_UNBOUNDED`: the active Workbench polls in bounded
   requests, but no whole-job polling timeout is enforced. The configurable
   Provider timeout keys are not consumed by this Workbench execution path.

## Baseline and environment

```yaml
repository: JENN2046/AI-Video-Production-Local-Bridge
remote_main: bc3fa5a0baab81551bcef5dafc6fbc2f710d31f7
source_commit: f4a15f565865c045325274251a91d2e11c633e41
branch: codex/s3-workbench-canary-readiness
node:
  version: 24.14.0
  accepted: true
current_emitted_build: PASS
ffmpeg: PASS
ffprobe: PASS
service_started: false
```

The build contains the current Workbench generation UI, API routes, Intent
logic, RunningHub adapter boundary, bounded download, FFprobe and governed
Artifact registration code. Build output is local and generated; no source or
test file changed.

## Activity database and governed media

The database was opened with SQLite `readOnly: true` and `PRAGMA query_only =
ON`. Media activation recovery was disabled for the check.

```yaml
database_identity: CURRENT_REPOSITORY_ACTIVITY_DATABASE
database_source: CURRENT_REPOSITORY_DEFAULT
database_ledger: "0011"
schema_version: workbench-v2-6
schema_current: true
db_readonly_check: PASS
quick_check: ok
invalid_json_rows: 0
structured_drift_rows: 0
orphan_rows: 0
missing_media_files: 0
media_integrity_errors: 0
pending_media_activations: 0
quarantined_media_activations: 0
unbound_webgpt_authorization_rows: 0
check_errors: 0
required_local_directories: PASS
governed_media_roots: PASS
database_write_attempted: false
media_write_attempted: false
```

No migration, recovery write, Artifact creation, media copy, re-encoding or
state repair occurred.

## RunningHub configuration

The existing Provider loader was invoked in a one-time process. Only the
approved fields below were retained. The three execution gates were forced to
remain false in the process before and after loading.

```yaml
selected_provider: runninghub
credential_env_name: RUNNINGHUB_API_KEY
credential_present: false
real_provider_enabled: false
execution_allowed: false
cost_acknowledged: false
missing_gate_names:
  - REAL_PROVIDER_ENABLED
  - M1_REAL_PROVIDER_EXECUTION_ALLOWED
  - M1_REAL_PROVIDER_COST_ACK
  - RUNNINGHUB_API_KEY
no_network_call: true
```

The disabled execution gates are the expected S3 safety state and are not a
system failure. Credential absence is a readiness blocker because S4 cannot
perform its exact RunningHub target without a separately authorized secure
configuration step. No credential value, preview, file content or path was
read into a receipt.

## Candidate and input

Candidate selection result:

```yaml
selection_status: S3_NO_ELIGIBLE_SHOT
active_production_projects: 2
evaluated_shots: 1
eligible_candidate_count: 0
```

The nearest observed production Shot is recorded only to make the remediation
boundary concrete:

```yaml
project_id: project_b45b26f5-2c24-4921-89a8-8298736bab11
shot_id: shot_director_activity_63845a20-95d4-455f-9aa2-6c317af14fb8
storyboard_package_id: ""
storyboard_artifact_id: artifact_67458ac9-a0cb-4e82-961e-9f34490413d7
project_status: draft
shot_status: draft
storyboard_package_approved: false
video_prompt_present: true
nonterminal_generation_intent_conflict: false
runninghub_capability:
  result: FAIL
  error_code: PROVIDER_CAPABILITY_DURATION_UNSUPPORTED
  duration_seconds: 5
  required_minimum_seconds: 6
```

The observed Artifact itself passed the allowed read-only media checks:

```yaml
artifact_reference_ready: true
artifact_blob_identity: PASS
project_shot_ownership: PASS
file_exists: true
regular_file: true
approved_root_containment: true
nonzero_file: true
supported_image_mime: true
valid_dimensions: true
aspect_ratio_compatible: true
artifact_digest_verified: true
input_readiness: PASS_FOR_OBSERVED_ARTIFACT_ONLY
```

This does not make the Shot eligible: it is still draft, lacks an approved
Storyboard Package and requests a duration below the RunningHub capability
minimum. S3 did not alter those facts or guess a different business target.

## Current Workbench path

```yaml
workbench_generation_action: PASS
cost_acknowledgement: PASS
generation_intent: PASS
provider_adapter: runninghub
submit_boundary: PASS
polling_boundary: PASS
bounded_download: PASS
ffprobe_validation: PASS
blob_artifact_registration: PASS
generation_run_completion: PASS
ordinary_automatic_submit_retry: 0
unknown_paid_submission: MANUAL_RECONCILIATION
one_intent_per_real_operation: PASS
old_artifact_overwrite: BLOCKED
source_and_emitted_build_parity: PASS
```

Effective timing facts:

```yaml
preflight_request_timeout_ms: 60000
provider_request_timeout_ms: 60000
provider_poll_interval_ms: 5000
provider_poll_whole_job_timeout: NO_BOUND_FOUND
provider_download_timeout_ms: 30000
configured_timeout_env_consumed_by_current_workbench: false
```

The absence of a whole-job poll timeout does not create a second submit:
unknown submission remains manual reconciliation and ordinary Workbench
automatic resubmission remains zero. It still prevents an exact bounded S4
authorization packet from truthfully naming an enforced poll timeout.

## Targeted isolated tests

All test processes used temporary databases. Process-level Provider execution
gates remained false, fixture transports were used and no Provider network
request occurred.

| Group | Existing isolated scope | Result |
|---|---|---|
| 1 | Provider environment safety and capability contract | `PASS` — 11 tests |
| 2 | Generation Intent, cost acknowledgement and Workbench worker safety | `PASS` — 32 tests |
| 3 | Provider output boundary, bounded download and FFprobe | `PASS` — 27 tests |
| 4 | Generation, Blob/Artifact identity and media activation integrity | `PASS` — 37 tests |

No full test suite, Browser Smoke, Media Gateway, Snapshot, Director Bridge,
Memory, multi-user or legacy script was run. No isolated-test process remained
after completion.

## S4 authorization request

This packet is deliberately incomplete and not executable because its target,
credential and polling bound have not passed S3.

```yaml
S4_AUTHORIZATION_REQUEST:
  status: NOT_AUTHORIZED_BLOCKED_BY_S3_FINDING
  source_commit: f4a15f565865c045325274251a91d2e11c633e41
  database_ledger: "0011"
  provider: RunningHub
  provider_model_or_route: rhart-video-g/image-to-video
  project_id: UNAVAILABLE_S3_NO_ELIGIBLE_SHOT
  shot_id: UNAVAILABLE_S3_NO_ELIGIBLE_SHOT
  storyboard_package_id: UNAVAILABLE_S3_NO_ELIGIBLE_SHOT
  storyboard_artifact_id: UNAVAILABLE_S3_NO_ELIGIBLE_SHOT
  input_digest_verified: false
  duration_seconds: UNAVAILABLE_S3_NO_ELIGIBLE_SHOT
  aspect_ratio: UNAVAILABLE_S3_NO_ELIGIBLE_SHOT
  resolution: UNAVAILABLE_S3_NO_ELIGIBLE_SHOT
  single_submit_limit: 1
  automatic_submit_retry: 0
  provider_poll_timeout: NO_ENFORCED_WHOLE_JOB_BOUND
  provider_download_timeout: 30000_ms
  budget_currency: BUDGET_REQUIRES_JENN_DECISION
  maximum_budget: BUDGET_REQUIRES_JENN_DECISION
  cost_estimate_source: RUNNINGHUB_OFFICIAL_PRICE_PREVIEW_REQUIRED_IN_S4
  live_provider_check_required: true
  paid_submit_requires_jenn_confirmation: true
  stop_conditions:
    - source commit, database identity or ledger drift
    - no exact eligible Project and Shot
    - Storyboard Package, Artifact, Blob, digest or capability mismatch
    - RunningHub credential absence
    - missing exact Jenn budget and paid-submit confirmation
    - no enforced whole-job Provider poll timeout
    - official price, balance or budget failure
    - more than one submit attempt
    - unknown submit outcome, which must enter manual reconciliation
    - any unexpected Provider, network, download or Artifact result
```

## Required next boundary

S4 remains `BLOCKED_BY_S3_FINDING`. One core blocker task should:

1. obtain Jenn's exact business choice and separately authorized Workbench
   writes for one approved Storyboard Package and a RunningHub-supported Shot;
2. establish the RunningHub credential through a separately authorized secure
   configuration step while keeping all real execution gates false;
3. define and enforce one whole-job polling timeout consumed by the current
   Workbench path;
4. rerun the bounded S3 checks before producing a new S4 authorization packet.

S3 did not execute any of those approval-required actions.

## S3B-1 bounded polling addendum

The local `codex/s3b-bound-provider-polling` branch closes only the polling
implementation finding. It consumes `PROVIDER_TASK_POLL_TIMEOUT_MS` with a
600000 ms default and fail-closed 1000–3600000 ms bounds, persists one absolute
deadline after a Provider task ID is known, and limits each request and
scheduled wakeup to the remaining time. Expiry enters
`PROVIDER_POLL_TIMEOUT` manual reconciliation while retaining the task ID,
Intent, Run and prior Artifacts with zero automatic resubmits.

Injected-clock and fixture-adapter tests passed without Provider network,
activity database/media or secret access. The detected Node `24.14.0` is
engine-compatible for this local validation but is not an accepted paid-canary
baseline; the later S3 rerun and S4 require the existing Node `22.23.1` path.

This addendum is local, unmerged code/test evidence. It does not make the
original S4 packet executable. An eligible Shot, local RunningHub credential
action, merged S3B-1 baseline and a separately authorized S3 readiness rerun
remain required.
