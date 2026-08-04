# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-08-04
Repository baseline: `main@3c502e23f884d1b062210321d84848b45c7bb344`

## Repository and CI truth

- PR #104, `fix: classify Director Bridge authentication failures`, merged as
  `3a142bb1aeaf34a506f84b2fa2598a5819203d45`.
- PR #105, `test: add readonly media acceptance matrix`, merged as
  `bc3fa5a0baab81551bcef5dafc6fbc2f710d31f7`.
- PR #106, `docs: freeze scope and record core production readiness`, was
  squash-merged as `b3a108abc8728e89259d0d953e1c638b9ca482ea`.
- PR #108, `fix: bound Provider polling and harden output recovery`, was
  merged as `808d9334a49def7ce858f7c6138af75fed392c5b`.
- PR #110, `fix: stabilize Director Bridge smoke process quiescence`, was
  merged as `00c8ed458144f03d4b0e1389d4de6dbf8005ed9a`.
- PR #112, `fix: converge Director Bridge fixture failure receipts`, was
  merged as `55553cbf2f9bc387beb255cebb8b36bcb2deadbf`.
- PR #109 was closed without merge after controlled retirement. Its head
  `423351bf376378d6fde48cea3060cc7af35bb148` and branch remain retained as
  architecture and threat-model evidence; no commit from it is accepted into
  `main`.
- PR #111, `fix: align Node preflight with engine floor`, was squash-merged as
  `770f3dff342874e90788d0f475c4cff49136e114`.
- PR #113 is an open Ready governance closeout candidate. The task board keeps
  both its current and candidate head symbolic at `VERIFY_BEFORE_MERGE` until
  the current PR head is re-read and revalidated. Its last-reviewed and
  last-passed head is `16babfd9650184183acef959244c2d765ea53dcc` against
  current base `3c502e23f884d1b062210321d84848b45c7bb344`; this is historical
  evidence, not a claim about the current PR head. The earlier `f8ed0b9` is
  retained only as a reviewed head with a state-reconciliation finding. No
  merge is claimed.
- PR #114 was squash-merged as current `main@3c502e23f884d1b062210321d84848b45c7bb344`.
  Its valid behavior-test P2 remains `DEFERRED_UNRESOLVED` (thread
  `3708908011`); no reply or resolution is claimed.
- PR #115 is closed without merge at head
  `866accc40ea36c7d8098048ea911eb6e6b0a376b`; its branch remains retained and
  its final fixture CI failure was
  `DIRECTOR_BRIDGE_RUNTIME_SMOKE_FIXTURE_STAGING_UNCLASSIFIED`.
- Current-main code/CI status does not imply a fresh external Provider,
  Bridge, database, Snapshot, Memory, deployment or public acceptance.
- The final PR #106 head passed both `Quality and integration` and
  `Browser smoke`; the squash commit has the same tree as that reviewed head.
- Code and CI PASS establish repository facts only. They do not create a new
  deployment, public maintenance-window, Provider, database, Bridge, Snapshot,
  Memory or production acceptance.

## PR #109 controlled retirement

```yaml
pull_request: 109
state: CLOSED
merged: false
branch_retained: true
review_history_retained: true
ci_history_retained: true
source_commits_accepted_into_main: false
classification: RESEARCH_AND_ARCHITECTURE_EVIDENCE
```

The late staged-file accumulation finding was valid, but the attempted
remediation expanded into an unsupported cross-database and cross-process
media transaction protocol. The product boundary is now single active
Workbench writer, single business database and explicit human recovery only.
See [the PR #109 postmortem](docs/PR109_POSTMORTEM_AND_REUSABLE_ASSETS_2026-08-04.md)
and [the bounded-recovery ADR](docs/ADR_SINGLE_ACTIVE_MEDIA_WRITER_AND_BOUNDED_RECOVERY.md).

The exact accepted external operation recorded by each historical report
remains bounded to that report's commit, inputs and authorization. A later
commit never inherits an older external PASS automatically.

The retained package and closeout identities remain:

| Identity | Current value |
|---|---|
| Package | `0.1.0-beta.5` |
| MCP service contract | `webgpt-v4.3.0` |
| Single-user product closeout | `JENN_SINGLE_USER_MCP_APP_PASS` |
| Manual Snapshot publishing boundary | `MANUAL_PUBLISH_OPERATIONAL_READY` |
| Multi-user boundary | `PARTIAL_MULTI_USER_GATE` |

These identifiers preserve the current package, schema and closeout contract.
They do not imply a fresh external acceptance for this branch or expand the
scope frozen below.

## Current product truth

The stable product authority remains:

```text
Local Workbench
  -> SQLite ledger 0011
  -> Governed Media Store
  -> Provider Adapter
  -> Generation / Review / Assembly / Delivery
```

SQLite is the business fact source. ChatGPT may inspect bounded context and
submit advisory Proposals, but it is not a second fact source and cannot
approve, adopt or deliver production work.

The active database is current-code compatible at `workbench-v2-6` / migration
ledger `0011`. Runtime startup does not automatically migrate or roll back the
database. `REAL_PROVIDER_ENABLED=false` remains the safe default.

## Capability matrix

| Capability | Current code fact | External or real acceptance | Current decision |
|---|---|---|---|
| Workbench V2 local UI | Storyboard, generation preflight, version review and delivery-readiness views exist | Activity database compatibility accepted at ledger `0011` | Core |
| SQLite and governed media | Migration, Artifact/Blob digest and FFprobe boundaries exist | Ledger `0011` migration/restore evidence remains commit-scoped | Core |
| Current Provider path | Intent, budget, confirmation and adapter boundaries exist; Provider defaults off | PR #108 is in `main`; S3B-T1/T1A are done in main, while the verified-Blob recovery path retains a late staged-file accumulation finding. S4 remains separately blocked | Core blocker before S4 |
| Historical R3 Provider path | Execution scripts now reside under `legacy/` | RunningHub real canary, four-shot generation and regeneration completed historically | Feasibility evidence only |
| Review and accepted clips | Version stacks, rejection reasons and human accepted-clip selection exist | Historical R3 review evidence exists | Core; current-path acceptance remains |
| Active assembly/export | Active assembly still contains `placeholder_copy` / mock-fixture behavior; Workbench has no production assembly/export action | No current-main production-path PASS | S6 core gap |
| Historical R3-9O assembly | Historical script used FFmpeg concat and registered a final Artifact | Historical real assembly and closeout passed at their recorded commits | Feasibility evidence only |
| Unified `/workspace/mcp` | Unified Remote and Director tool contracts exist | Earlier bounded transport/activity path passed | Core ChatGPT route; later commits do not inherit that PASS |
| Legacy `/mcp` | Still present | Earlier Readonly acceptance exists | `ROLLBACK_ONLY` |
| Dedicated Director route | Still present beside Unified Director tools | Earlier bounded evidence exists | `ROLLBACK_ONLY` |
| Director Bridge | A managed process was detected with source commit `3a142bb` | The recorded process source predates `main@3c502e23`; no current-main configuration, heartbeat or authenticated-contact acceptance was performed | Do not place before S3/S4 |
| Manual Snapshot | Publisher and signed Snapshot contract exist | Earlier bounded publish/recovery evidence exists | Optional; not an S3/S4 dependency |
| Media Gateway | PR #105 two-project Image/MP4 matrix is in main and CI passed | No corresponding current-main public maintenance-window acceptance | Optional human Widget playback |
| Memory Port | Advisory recall seam and non-dispatched Saveback envelope exist | No stable production plugin or automatic Saveback | Frozen |
| Multi-user | Code-level membership boundaries exist | Second real user path is not accepted | Frozen |
| Windows logon task | Installation code exists | No matching task was detected or accepted | Frozen |
| Automatic Snapshot | Not implemented | Not accepted | Frozen |

## Provider history correction

The repository must not claim that a real Provider canary has never occurred.
The historical R3 route recorded:

- a successful RunningHub real single-submit canary;
- a successful four-shot real generation run;
- a successful four-shot regeneration run;
- local FFmpeg final assembly;
- human final approval and closeout.

Those execution scripts were later moved into `legacy/`. The historical
results prove engineering feasibility, but they do not prove that current
`main`, the current Workbench UI/API, or the ledger `0011` product path has
completed a fresh live acceptance. S3 prepares that current path offline; S4
is the separately authorized real single-shot acceptance.

## Assembly and export status

The active product path has not completed real assembly/export productization
or acceptance. The active assembly implementation still registers mock fixture
behavior through `placeholder_copy`. The Workbench Delivery view reports
readiness but does not provide a production assembly, export and closeout
action.

Historical R3-9O FFmpeg concat evidence is retained as design and feasibility
evidence. Fixture assembly must not be described as a current production
assembly PASS.

## Director Bridge status

A low-disclosure manager status check detected a managed Director Bridge
process whose recorded source commit is
`3a142bb1aeaf34a506f84b2fa2598a5819203d45`.

The recorded manager check returned `RESTART_REQUIRED` on the earlier
repository baseline, and its source commit still predates current
`main@3c502e23`. This retirement did not start, stop or restart the Bridge. It did
not revalidate configuration identity, heartbeat or authenticated Remote
contact. Therefore the repository must not claim that the Bridge is stopped,
healthy, Remote-connected or accepted on current main.

The accepted `fbf6540` restart report and the later `2b43f558` diagnostic-gap
report remain historical, commit-scoped evidence.

## Media Gateway status and role

PR #105 added the two-project Image/MP4 acceptance fixture and low-disclosure
matrix to `main`; its code and CI passed. That merge did not itself run or
accept a corresponding public maintenance window.

The older public MP4 fixture PASS remains limited to
`main@2b84f447c1d85eaf5f96c4da6cf0d81080332131` and the exact boundary recorded
in its report. It does not transfer to PR #105 or current main.

```yaml
media_gateway:
  role: optional_human_widget_playback
  blocks_provider_canary: false
  blocks_core_beta: false
```

Model video understanding uses the local
`inspect_director_video_frames` FFmpeg frame-extraction path. Media Gateway
promotion, WebM, broad-format coverage, automatic startup and long recovery
soak are not core production prerequisites.

## Core phase dependencies

```yaml
S3:
  requires_director_bridge: false
  requires_snapshot: false
  requires_media_gateway: false
  requires_memory: false
  requires_multi_user: false
S4:
  requires_director_bridge: false
  requires_snapshot: false
  requires_media_gateway: false
  requires_memory: false
  requires_multi_user: false
S5:
  requires_director_bridge: true_only_when_using_chatgpt_frame_review
```

## Recovery governance after PR113-R2

```yaml
pr114_p2:
  finding_valid: true
  attempted_remediation: PR115
  remediation_merged: false
  status: DEFERRED_UNRESOLVED
  production_runtime_defect_proven: false
  current_main_ci: GREEN
verified_blob_recovery_operational_policy:
  automatic_use_during_s4: forbidden
  explicit_recovery_use_during_s4: forbidden
  integrity_failure_action: STOP_AND_ENTER_MANUAL_RECONCILIATION
  provider_resubmit_on_integrity_failure: forbidden
  automatic_stage_cleanup: forbidden
minimal_replacement:
  task_id: S3B-T1B-R1_MINIMAL_BOUNDED_STAGE_REPLACEMENT
  status: DEFERRED_NOT_REQUIRED_FOR_S4
  ready: false
  implementation_authorized: false
  blocks_s4: false
```

The sole current task is `S3B-T2_PREPARE_ELIGIBLE_SHOT` and is `BLOCKED` at the
approval boundary (`result: AWAITING_JENN_AUTHORIZATION`); no task is `READY`.
The sequence is T2 prepare, T3 Jenn-local credential configuration, T4 offline
readiness rerun, and then the separately authorized S4 real single-shot canary.
T4 does not perform or claim a live price preview; the credentialed,
networked RunningHub price check belongs to the S4 online preflight immediately
before a paid submit. PR #113 is an open Ready governance closeout candidate
and has not been merged.

Bridge, Snapshot or Media Gateway recovery must not be inserted ahead of the
current-path Provider readiness and real single-shot canary.

## S3B-T2 eligibility and acceptance

The blocked `S3B-T2_PREPARE_ELIGIBLE_SHOT` slot is a preparation gate, not an
authorization to execute it. A future Jenn authorization must select exactly
one alias-only candidate that satisfies the following deterministic predicate:

1. Project facts: `workbench_project_meta.classification` is exactly
   `production`; a classification mismatch is the stable failure
   `PROJECT_NOT_PRODUCTION`. Workbench lifecycle is `active` (not archived),
   and the Project `status` is one of `draft`, `storyboard_approved`,
   `video_generation_in_progress` or `video_review`; `final_approved` is
   explicitly ineligible because it represents a delivered project, producing
   the stable failure `PROJECT_ALREADY_DELIVERED`, and
   `active_storyboard_package_id` names an existing package whose
   `project_id` matches and whose `status` is exactly
   `approved_for_video_generation` with `user_approval.storyboard_approved ==
   true`.
2. Shot facts: `status` is exactly `storyboard_approved`,
   `video_prompt` is present, `duration_seconds` is finite and greater than
   zero, `generation_version_count` is `0`, `generation_job_state` is `null`,
   `latest_generation_run_status` is `null`, and review stage is
   `not_started`.
3. The canonical `deriveShotOperationalState(facts)` result has
   `generation.stage == "ready"` and
   `allowed_workflow_actions.prepare_generation == true`. A failed or
   previously generated/reviewed Shot is not an initial T2 candidate; it must
   use a separately authorized regeneration task.
4. Global generation gate: no row in `generation_intents` for any Project has
   `status` `queued` or `running`. T2 must fail closed with
   `REAL_GENERATION_ALREADY_ACTIVE` rather than selecting a candidate that
   the generation preflight will reject because another real task is active.
5. Package binding: resolve exactly one entry from the package's
   `approved_shot_snapshots`. When a frozen snapshot has a non-empty `shot_id`,
   it must equal the candidate `shot_id`; when the optional `shot_id` is absent,
   match by the candidate's frozen `order`, exactly as the current generation
   path does. The order fallback is valid only when that order identifies one
   snapshot; zero or multiple matches fail closed as `PACKAGE_SNAPSHOT_MISMATCH`.
   The generation inputs `duration_seconds`, `video_prompt`,
   `negative_prompt` (after applying `?? ""` to both values) and
   `storyboard_image_artifact_id` must equal that frozen snapshot.
   `description` is intentionally not compared: the current generation path
   permits a description-only edit after package freeze. `order` is used only
   as the optional snapshot selector, not as a generation payload field. The
   package snapshot Artifact must be the same active Artifact selected in step
   6. The receipt records only the stable matching mode (`shot_id` or `order`),
   never private identifiers.
6. Storyboard Artifact facts: `artifact.status == "active"`,
   `artifact.artifact_type == "image"`, `artifact.role == "storyboard_image"`,
   `artifact.linked_objects.project_id` and `.shot_id` match the candidate,
   `verification_level` is exactly `bytes_verified` (the T2 check must read and
   verify the current bytes, not rely on a ledger-only result), Blob
   `integrity_state == "verified"`, and detected MIME is exactly `image/png`
   or `image/jpeg`.
7. T2 is offline preparation only. It must run the existing registry-only
   `buildProviderCapabilityKey` predicate with `provider: "runninghub"`, the
   existing RunningHub model route, the candidate `duration_seconds`, and the
   Project `video_spec.resolution` / `video_spec.aspect_ratio`; this reads no
   credential and makes no network call. A successful static capability result
   is required. Credential, budget policy and cost acknowledgement are
   **not** T2 predicates; T3/T4 handle their local gates after T2, while the
   live price preview is reserved for the separately authorized S4 online
   preflight. Credential values are never read into the T2 receipt.

The only authoritative state derivation is the existing
`deriveShotOperationalState` / `allowed_workflow_actions.prepare_generation`
predicate together with the Artifact/Blob facts above. Its stable failure
codes for this gate are `PROJECT_NOT_PRODUCTION`, `PROJECT_ALREADY_DELIVERED`,
`PROJECT_NOT_ACTIVE`, `STORYBOARD_APPROVAL_REQUIRED`, `STORYBOARD_REVISION_REQUIRED`,
`STORYBOARD_IMAGE_MISSING`, `STORYBOARD_ARTIFACT_INACTIVE`,
`STORYBOARD_ARTIFACT_BINDING_INVALID`, `STORYBOARD_ARTIFACT_ROLE_INVALID`,
`STORYBOARD_ARTIFACT_INTEGRITY_INVALID`, `STORYBOARD_IMAGE_MIME_UNSUPPORTED`,
`VIDEO_PROMPT_MISSING`, `SHOT_DURATION_INVALID`,
`PREPARE_GENERATION_NOT_ALLOWED`, `GENERATION_ALREADY_STARTED`,
`GENERATION_MANUAL_RECONCILIATION`, `SHOT_STATE_INCONSISTENT`,
`REAL_GENERATION_ALREADY_ACTIVE`,
`PACKAGE_NOT_FOUND`, `PACKAGE_PROJECT_MISMATCH`, `PACKAGE_NOT_APPROVED` and
`PACKAGE_SNAPSHOT_MISMATCH`, `PROVIDER_CAPABILITY_NOT_FOUND`,
`PROVIDER_CAPABILITY_MODEL_MISMATCH`, `PROVIDER_CAPABILITY_DURATION_UNSUPPORTED`,
`PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED` and
`PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED`, plus
`S3_MULTIPLE_ELIGIBLE_SHOTS` when more than one candidate satisfies the full
predicate. T3/T4 may report credential, budget or cost-acknowledgement reason
codes, but those codes do not make an otherwise valid T2 candidate ineligible.
Price-preview reason codes are reserved for the separately authorized S4
online preflight and are not T3/T4 offline results.

For deterministic T2 receipts, every raw `verifyMediaArtifactBytes` failure
must be normalized to the published aggregate
`STORYBOARD_ARTIFACT_INTEGRITY_INVALID`, regardless of whether the raw code is
`ARTIFACT_INTEGRITY_UNVERIFIED`, `MEDIA_BLOB_CONTENT_DRIFT`,
`MEDIA_BLOB_PATH_UNSAFE`, `MEDIA_BLOB_CHECK_FAILED`,
`MEDIA_ACTIVATION_FILE_UNREADABLE`, `MEDIA_FILE_CHANGED_DURING_HASH`, an
image validation code (`IMAGE_FILE_INVALID`, `IMAGE_DIMENSIONS_UNREADABLE`,
`IMAGE_FILE_NOT_READABLE`, `IMAGE_DECODE_UNAVAILABLE` or
`IMAGE_DECODE_FAILED`), or a video/MIME validation code
(`VIDEO_PROBE_UNAVAILABLE`, `VIDEO_FILE_INVALID` or `MEDIA_MIME_MISMATCH`).
No raw filesystem, decoder, storage or runtime detail may be emitted. A
zero-version Shot whose operational derivation reports
`STORYBOARD_REVISION_REQUIRED` must retain that stable code in the aggregate
reason list rather than being mislabeled as a generic preparation failure.

The preparation acceptance receipt must report exactly one candidate, preserve
only non-reversible aliases and aggregate reason codes. Project classification
and delivered-state rejections retain the same stable names,
`PROJECT_NOT_PRODUCTION` and `PROJECT_ALREADY_DELIVERED`, in that reason-code
list. The receipt must retain no activity database identifiers, local paths,
prompt text, credential values or Provider payloads. T2 must not submit or poll
a Provider, configure credentials, create or replace media, invoke recovery,
publish a Snapshot, or run S4. The current
blocked slot authorizes no Project/Shot or Intent write; any such write scope
must be named in a separate Jenn authorization. A zero-candidate result is a
fail-closed `S3_NO_ELIGIBLE_SHOT`, not a readiness PASS. A scan producing more
than one full-predicate candidate is also fail-closed as
`S3_MULTIPLE_ELIGIBLE_SHOTS`; T2 must not choose by scan order or publish a
candidate alias in that case.

## Current priority

The product-scope source of truth is
[Product Scope Freeze](docs/PRODUCT_SCOPE_FREEZE.md). S1 established one
current classification per component, froze peripheral expansion and retained
legacy routes only for rollback. It did not remove routes or change runtime
behavior.

The only P0 is `CURRENT_MAIN_REPEATABLE_PRODUCTION_LOOP`:

```text
Current Project -> Approved Storyboard Package -> Provider Generation
  -> Governed Media Artifact -> Workbench Review -> Regeneration
  -> Accepted Clips -> Real Assembly -> Export -> Closeout
```

Current stage queue:

1. `S1 Scope Freeze` — `DONE`
2. `S2 Core Loop Gap Audit` — `DONE`
3. `S3 Provider Canary Readiness` — `DONE` with local readiness findings
4. `S3B Single-Shot Canary Prerequisites` — `T2_BLOCKED` (`result: AWAITING_JENN_AUTHORIZATION`); recovery replacement deferred
5. `S4 Real Single-Shot Canary` — `BLOCKED_UNAUTHORIZED`
6. `S5 Review and Regeneration` — not loaded
7. `S6 Assembly, Export and Closeout` — not loaded
8. `S7 Three Real Project Evaluation` — not loaded
9. `S8 Legacy Route Cleanup Decision` — not loaded

S3B-T1 and S3B-T1A are now `DONE_IN_MAIN` through PR #108. The verified-Blob
recovery capability is also in `main`, but its late staged-file accumulation
finding remains valid and is not claimed fixed by PR #109 or PR #115. During S4
the recovery path is not used automatically or explicitly; an integrity failure
stops for manual reconciliation and never resubmits to a Provider. The bounded path
requires explicit human reattachment and exact Artifact/Blob, SHA, size and
MIME agreement, preserves the Blob row and link, and does not resubmit.
Replacement rebind archives the old Artifact, restart recovery prefers a
committed local replacement, repeated attachment preserves same-task recovery,
and startup scheduling handles clock rollback without waiting for a future
attempt or a future lease inherited from a crashed process.

Head `2cb245e` passed Windows CI run `30606273467` on attempt 1. Exact-head
review `4825747733` then found that an old persisted recovery prevented a human
from attaching a different unused Provider task. The locally validated
implementation `19f026f8f40f82203a3967a7f449152b272743cf` now verifies and
atomically archives the old invalid Artifact and any committed replacement
before clearing recovery and attaching the new task. Same-task recovery stays
preserved; the internal local recovery identity cannot be attached as a
Provider task; unsafe retirement rolls back with a stable error. Blob rows,
physical bytes and Artifact-Blob links are unchanged. The prior CI is not
transferable.

Head `b8060e1` passed Windows CI run `30608433511`; exact-head review
`4825989650` then found that a different Intent could attach a reserved
`local_recovery_*` identity before the owner created a replacement Artifact.
The locally validated follow-up
`2847a34e8ee638ff1ca46824bc938f19acd870ff` reserves this internal namespace
globally at manual task attachment and covers the cross-Intent, no-replacement
case. That CI is also non-transferable, so new final exact-head CI and review
remain mandatory. Old PR #107 remains open Draft, superseded and unmerged with
its branch retained; none of these candidates is part of current `main`.

Head `528f33a` passed Windows CI run `30610318191`. A retained finding from
review `4826019679` showed that recovery abandon could leave both repaired and
replacement Artifacts active, while exact-head review `4826282464` found that
an interrupted exclusive Blob placement could leave a permanently rejected
two-link target. The locally validated implementation
`aa9b8912d18dc11b6718e5bfed00e1d9c6ee35f9` now retires recovery Artifacts
atomically before abandon and normalizes only the unique generated
staged/target hard-link pair with matching file identity. Unowned hard links
remain rejected; Blob rows and Artifact-Blob links remain unchanged. Typecheck,
build, Workbench V2 67/67, Foundation 94/94, Provider 52/52, selection 23/23,
secret scan and diff checks pass locally. The prior CI and review are not
transferable, so a new exact-head CI/review cycle remains mandatory.

Head `e5cb5d8` passed Windows CI run `30613190531`, but exact-head review
`4826557538` found that the poll-start rollback predicates still truncated both
timestamps to whole seconds. The locally validated implementation
`357b08718e2226a613b7613ede234e4c3cc337b7` now uses fractional
`julianday` comparisons in scheduler selection and lease claim. Its startup
regression proves a same-second 900 ms rollback despite a future inherited
lease, reaches stable `PROVIDER_POLL_TIMEOUT`, and performs zero Provider
calls. All required local gates pass. The prior CI and review are not
transferable, so another exact-head CI/review cycle remains mandatory.

Head `1f49bc3` passed Windows CI run `30615172450`, but exact-head review
`4826803376` found that a due persisted poll deadline could still wait behind
a crashed worker's five-minute lease after wall time caught up with the stored
start, and that the 900 ms regression depended on real scheduler speed. The
locally validated implementation
`2cce0f8af8063228c89237a946553ea62e8503d2` now makes a validated due
deadline an explicit scheduler and lease-claim override, schedules wakeup at
the earlier deadline, and binds scheduler comparisons to the injectable wall
clock. Fixed-clock rollback and already-due-deadline regressions both reach
stable `PROVIDER_POLL_TIMEOUT` with zero Provider calls; the latter retains a
`2099` next attempt and lease. Workbench V2 passes 68/68 and all broader local
gates pass. The prior CI and review are not transferable, so another exact-head
CI/review cycle remains mandatory.

The complete Media Gateway promotion, Memory plugin, second real user,
automatic Snapshot, Windows logon task, WebM/broad formats and new OAuth
compatibility experiments are removed from the S3/S4 blocker chain.

Current frozen work:

- Media Gateway expansion or automatic startup;
- stable Memory plugin and automatic Saveback;
- multi-user expansion and second-user golden path;
- automatic Snapshot synchronization;
- Windows logon startup;
- WebM and broad-format coverage;
- new OAuth compatibility experiments;
- Full WebGPT externalization and legacy-route features.

Current rollback-only surfaces:

- legacy `/mcp`;
- Dedicated Director route.

No rollback surface is authorized for removal by this state correction.

## Accepted evidence index

- [Director Active Database Migration Acceptance](ops/reports/2026-07-22-director-active-database-migration-acceptance.md)
- [Unified Director Activity Acceptance](ops/reports/2026-07-27-unified-director-activity-acceptance.md)
- [Readonly Media Gateway MP4 Fixture Acceptance](ops/reports/2026-07-27-readonly-media-gateway-mp4-fixture-acceptance.md)
- [Unified Director Wire Contract Acceptance](ops/reports/2026-07-28-unified-director-wire-contract-acceptance.md)
- [Managed Director Bridge Restart Acceptance](ops/reports/2026-07-29-managed-director-bridge-restart-acceptance.md)
- [Director Bridge Restart Diagnostic Gap](ops/reports/2026-07-29-director-bridge-restart-diagnostic-gap.md)

Historical R3 Provider, regeneration, assembly and closeout evidence remains
under `data/reports/` and `.agent_board/TASK_LEDGER.md`. Those reports are not
current-main acceptance receipts.

## Non-claims

- No code, database, media, runtime, secret or external configuration was
  changed by S0.
- No Provider was called and no Snapshot was published.
- No Bridge, Gateway, Tunnel or other service was started, stopped or
  restarted.
- No npm package, tag, release, deployment or remote branch update occurred.
- Passing CI does not prove a live Render, Auth0, Cloudflare, Bridge, Snapshot,
  Media Gateway or Provider configuration.

See [docs/README.md](docs/README.md) for the current-document index and
[docs/PROJECT_LESSONS.md](docs/PROJECT_LESSONS.md) for construction lessons.
