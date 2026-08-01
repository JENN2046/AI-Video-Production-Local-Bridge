# Current Workbench Canary Readiness

Status: `BLOCKED_BY_S3_FINDING`

Task: `S3-T1_CURRENT_WORKBENCH_CANARY_READINESS`

Evidence:

```yaml
code_baseline: main@bc3fa5a0baab81551bcef5dafc6fbc2f710d31f7
evidence_snapshot_commit: e0e08cd77d0923f25a3472510248b8f9e954c9a0
publication_pr: 106
durable_evidence_snapshot:
  object_format: git-sha1
  tree_oid: 47657a7903159342bb2f1f7dcc074fbf1196093d
  manifest_algorithm: sha256
  manifest_canonicalization: SORTED_UTF8_LF_PATH_TAB_BLOB_OID
  manifest_sha256: f73e06223f36d7858ab17ef76f221349594c9167a380dbe2468dbdbb3e8f906d
  manifest:
    - path: .agent_board/HANDOFF.md
      blob_oid: ae0cd76acb8966642086008971880088b88e9cec
    - path: .agent_board/NEXT_TASK.json
      blob_oid: 1ffd346e7e76fae065a8f365d37b02883202838c
    - path: .agent_board/NEXT_TASK.md
      blob_oid: fce6866b59119ce0586399406104373b721d0a16
    - path: .agent_board/TASK_LEDGER.md
      blob_oid: 9515764a1613575729505809d69a444784d793cf
    - path: .agent_board/VALIDATION_LOG.md
      blob_oid: 6386c4ce9c8b090598e2080d7047a3cb2a657361
    - path: docs/README.md
      blob_oid: 6a46ec09badc7a6e9a66f94b38fef48e696a81bf
    - path: ops/reports/2026-07-30-current-workbench-canary-readiness.md
      blob_oid: d19adc0b515290eedb1f456c01de6988cc21eeba
```

Date: 2026-07-30

This is a low-disclosure local readiness receipt. It is not a Provider
preflight, paid generation authorization, Provider acceptance or S4 execution
receipt.

The durable evidence snapshot commits independently to Commit A's complete Git
tree and to the seven evidence blobs changed by that snapshot. To verify the
manifest, sort entries by repository-relative path, encode each as
`path<TAB>blob_oid<LF>` in UTF-8 without a BOM and calculate SHA-256. These
content-addressed identifiers remain recorded in a future squash receipt even
if the PR branch is deleted. They fingerprint the original evidence objects;
they do not claim that the original commit becomes an ancestor of the squash
commit or that Git object retention is permanent.

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
code_baseline: main@bc3fa5a0baab81551bcef5dafc6fbc2f710d31f7
audit_sequence_base: f4a15f565865c045325274251a91d2e11c633e41
branch: codex/s3-workbench-canary-readiness
node:
  detected_version: 24.14.0
  engine_compatible: true
  accepted_paid_canary_baseline: false
  required_S4_node: 22.23.1
current_emitted_build: PASS
ffmpeg: PASS
ffprobe: PASS
service_started: false
```

Node 24.14.0 satisfies the package engine range and was used for this static
inspection and the isolated tests. It does not replace the project's accepted
Node 22.23.1 local baseline for a real paid canary.

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

```yaml
candidate_scan:
  eligible_candidate_count: 0
  result: S3_NO_ELIGIBLE_SHOT
  identifiers_published: false
```

The authorized read-only scan established only the aggregate result above.
This receipt retains no activity-database object identifier, local path, full
prompt or business content. It also retains no alias-to-value mapping. If a
future receipt needs to describe a relationship, it may use only the
non-reversible aliases `CANDIDATE_PROJECT`, `CANDIDATE_SHOT` and
`CANDIDATE_STORYBOARD_ARTIFACT`, without preserving a mapping to real values.

Static code inspection produced the following authorization assessment:

```yaml
identifier_exposure_assessment:
  identifiers_are_bearer_credentials: false
  identifiers_alone_grant_database_access: false
  identifiers_alone_grant_media_access: false
  identifiers_alone_grant_provider_access: false
  revocation_required: false
  history_fully_purged_claimed: false
```

The identifiers select records only after an independently authorized database
or service boundary has already been established. Media playback uses a
separately issued capability handle, and Provider execution still requires its
configured adapter, credential and human execution gates. Current-tree cleanup
does not erase the earlier PR commits from GitHub object history.
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

## S4 authorization status

```yaml
s4:
  task: S4-T1_REAL_SINGLE_SHOT_CURRENT_PATH
  status: BLOCKED
  authorization_granted: false
  executable: false
  candidate_identifiers_published: false
```

No target object is named in this receipt. No Provider preflight, submit,
polling, download or paid action was authorized or attempted.
## Required next boundary

S3 is terminal `DONE` with `BLOCKED_BY_S3_FINDING`; it is not `READY`.
PR #106 was squash-merged as
`main@b3a108abc8728e89259d0d953e1c638b9ca482ea`. This publication state does
not change the S3 evidence baseline recorded at the top of this receipt.

```yaml
old_pr107:
  status: CLOSED_SUPERSEDED_UNMERGED
  merge_authorized: false
pr108:
  number: 108
  status: MERGED_WITH_LATE_P2_FOLLOWUP
  squash_commit: 808d9334a49def7ce858f7c6138af75fed392c5b
remediation_pr:
  number: 109
  status: OPEN_READY
  implementation_commit: 528aee4020d4be15a5fc5278de2f8c8abb20c637
  review_remediation_commit: e5c42113c73ba35a2c307eb0890dcd7d3be1216f
  root_identity_review_remediation_commit: 193b1077d67dd8872831e8fe7646d8879d4947f7
  deterministic_stage_whitelist_commit: 0ff40f085368658887d3a77315d1eb7f51124c3f
  superseded_canonical_database_sweep_commit: 27058e32f5339359d15b876dc25375046075eb18
  explicit_stage_convergence_commit: 35122cd405f42bc627ae73d121f5a3dd14f3edbe
  cross_database_target_mutex_commit: e3704cb
  windows_mutex_identity_commit: 20f029e
  target_authority_commit: 95d8b29
  remediation_strategy: CROSS_DATABASE_TARGET_SQLITE_MUTEX
  current_head: STATE_SYNC_COMMIT_CONTAINING_THIS_RECORD
  resolved_prior_threads:
    - PRRT_kwDOTTDtUM6VdGmY
  current_unresolved_threads_at_state_sync:
    - PRRT_kwDOTTDtUM6Vdmly
    - PRRT_kwDOTTDtUM6VeTXd
    - PRRT_kwDOTTDtUM6VekUB
    - PRRT_kwDOTTDtUM6VkSwY
    - PRRT_kwDOTTDtUM6VkqqS
    - PRRT_kwDOTTDtUM6VkzTx
    - PRRT_kwDOTTDtUM6VkzTz
    - PRRT_kwDOTTDtUM6Vk38a
    - PRRT_kwDOTTDtUM6Vk38b
  post_promotion_finding_status: REMEDIATION_IN_PROGRESS_AT_STATE_SYNC
  merged_to_main: false
S3B-T1:
  local_status: PASS
  repository_status: DONE_IN_MAIN
S3B-T1A:
  local_status: PASS
  repository_status: DONE_IN_MAIN
S3B_VERIFIED_BLOB_STORAGE_RECOVERY:
  status: DONE_IN_MAIN_WITH_REMEDIATION_PENDING
S3B-T1B_RECOVER_ORPHANED_BLOB_STAGING:
  status: BLOCKED_BY_PR109_POST_PROMOTION_FINDING
  pull_request: 109
S3B-T2:
  status: AWAITING_JENN_AUTHORIZATION
S3B-T3:
  status: AWAITING_JENN_LOCAL_ACTION
S3B-T4:
  status: BLOCKED
S4:
  status: BLOCKED_UNAUTHORIZED
  authorization_granted: false
ready_task_count: 0
```

PR #108 is now in current `main`. Its bounded polling, manual reconciliation
and verified-Blob recovery code passed PR and main CI, but this does not prove a
real Provider or S4 acceptance. A P2 review finding arrived after merge: a hard
exit after staged-copy completion could leave a new random full-file stage on
every retry.

Open Ready PR #109 is the bounded remediation. It gives each Blob/target pair one
deterministic slot under the app-controlled activation staging root. Candidate
`35122cd405f42bc627ae73d121f5a3dd14f3edbe` removes the global destructive
verified-Blob stage sweep and the process-local database identity gate from
generic startup recovery. `recoverMediaActivations` no longer enumerates,
deletes or infers ownership of deterministic Blob stages from any database.

The exact stage now converges only through an explicit
`recoverVerifiedBlobStorage` call for its Blob. A complete matching stage is
reused without a second full copy; a partial safe app-owned stage is deleted and
recopied; an already reusable target causes only its exact stage to be removed;
unsafe entries remain preserved and fail closed. The canonical UUID-v4 legacy
rules and media-root safety checks remain unchanged. Local activation marker,
staging-owner and journal recovery remain available to every database.

Candidate `e3704cb` adds a persistent SQLite mutex derived from the canonical
media root and exact resolved storage target. Independent database files use the
same mutex for the same target, including when Blob ids differ. The lock is
acquired before the application write transaction, binding facts are re-read,
and the lock covers the full explicit recovery critical section. Busy timeout is
bounded to 30 seconds and returns without stage, target or quarantine mutation;
process exit releases the OS lock without PID leases or stale cleanup. Different
targets retain independent progress.

Exact-head review found that Windows casing variants of one physical target
could otherwise hash differently. Follow-up `20f029e` applies the same
case-insensitive normalization used by path equality to the mutex identity; the
different-Blob same-target multiprocess regression now uses an uppercase path
variant on Windows.

Follow-up `95d8b29` applies that identity to deterministic staging as well. A
persistent target authority record, stored beside the exact target with only
hashed path identities and immutable Blob facts, rejects different registered
roots or conflicting content claims before application or recovery mutation.
The SQLite mutex uses memory-journal mode and rejects any pre-existing
`-journal`, `-wal` or `-shm` entry without deleting it.

The regression set covers independently configured database A/B/C processes
sharing one media root, an active explicit repair paused after staged copy,
`:memory:`, five hard crashes with repeated startup, explicit retry, partial and
already-reusable stages, unknown deterministic-looking stages, unsafe lock and
stage entries, same-target serialization, different-target concurrency, busy
timeout, binding revalidation and local journal recovery. Local validation
passes with media activation 60/60, Foundation 122/122, Provider 52/52,
Workbench V2 68/68 and selection 23/23;
typecheck, build, secret scan and diff checks pass. Threads
`PRRT_kwDOTTDtUM6Vdmly`, `PRRT_kwDOTTDtUM6VeTXd` and
`PRRT_kwDOTTDtUM6VekUB`, `PRRT_kwDOTTDtUM6VkSwY`,
`PRRT_kwDOTTDtUM6VkqqS`, `PRRT_kwDOTTDtUM6VkzTx`,
`PRRT_kwDOTTDtUM6VkzTz`, `PRRT_kwDOTTDtUM6Vk38a` and
`PRRT_kwDOTTDtUM6Vk38b` remain unresolved at state
sync pending new exact-head CI and review. PR #109 remains open and unmerged.
Cross-database explicit recovery is serialized by an exact-target SQLite mutex,
and merge remains a separate Jenn decision.

The remaining sequence is:

1. require open Ready PR #109 to pass Windows CI and a fresh exact-final-head
   post-promotion Codex review before any merge decision;
2. resolve PR #109's post-promotion findings only after that exact-head evidence;
   retain the PR #107 and PR #108 branches;
3. obtain Jenn's separate authorization for `S3B-T2_PREPARE_ELIGIBLE_SHOT`;
4. wait for Jenn's local action for
   `S3B-T3_CONFIGURE_RUNNINGHUB_CREDENTIAL`;
5. keep `S3B-T4_RERUN_CANARY_READINESS` blocked until T2, T3 and the reviewed
   current-main remediation are available;
6. keep S4 blocked and unauthorized until a new bounded readiness receipt
   supports an exact authorization request.

There is currently no `READY` execution task. No action in this receipt
authorizes business-state writes, credential changes, Provider operations or
S4 execution.
