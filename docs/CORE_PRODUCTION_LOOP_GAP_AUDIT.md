# Current Core Production Loop Gap Audit

Status: `CURRENT` read-only audit

Task: `S2-T1_CURRENT_CORE_LOOP_GAP_PROOF`

Audit baseline: S1 commit
`d1b1a10365da46a4b3307fb41c2cbbaa89c8d7ea`, whose reviewed code baseline is
`main@bc3fa5a0baab81551bcef5dafc6fbc2f710d31f7`

Audit date: 2026-07-30

This audit traces the current Workbench path from an existing Project with a
confirmed Storyboard Package, an active Storyboard Media Artifact and at least
one generatable Shot. It does not assess project ideation, ChatGPT
pre-production, multi-user operation, Snapshot, Media Gateway, Memory,
automatic startup or Provider-platform expansion.

No active database, activity media, secret or private runtime state was read.
No Provider request, service lifecycle operation, Bridge operation, Snapshot
operation, deployment or external configuration change was performed.

## Method and result boundary

Implementation vocabulary:

- `MISSING`: no current product implementation was found.
- `LEGACY_ONLY`: only a retired/historical execution surface was found.
- `PLACEHOLDER`: a visible or callable surface exists, but its effect is a
  fixture, status card or mock operation rather than the claimed production
  operation.
- `INTERNAL_ONLY`: an internal function exists without a current Workbench
  UI/API path.
- `API_WIRED`: a current API/service path exists, but the complete Workbench
  action is absent.
- `WORKBENCH_WIRED`: the current Workbench exposes the operation through its
  UI and API/service path.

Acceptance vocabulary:

- `NOT_VERIFIED`
- `FIXTURE_VERIFIED`
- `CURRENT_LOCAL_PASS`
- `HISTORICAL_EXTERNAL_PASS`
- `CURRENT_EXTERNAL_PASS`
- `REQUIRES_AUTHORIZATION`

Code presence, fixture tests, current CI and historical live execution are not
interchangeable. The exact current-main Windows CI run passed its `Quality and
integration` and `Browser smoke` jobs, but S2 did not perform a current
external Provider acceptance.

## Required conclusions

```yaml
last_complete_workbench_step:
  approval_branch: C11_ACCEPTED_CLIP_AUTHORITY
  required_regeneration_branch: C09_HUMAN_APPROVE_OR_REJECT
  reason: C10 has a current API/service path, but the Workbench generation action is disabled once a Shot is revision_needed.
first_hard_break: C12_ASSEMBLY_PLAN
current_generation_path_wired: true_for_initial_single_shot
current_generation_live_accepted: false
current_regeneration_path_wired: API_WIRED_NOT_WORKBENCH_WIRED
current_accepted_clip_authority: WORKBENCH_HUMAN_DECISION
current_real_assembly_available: false
current_final_artifact_available: false_for_real_assembly
current_export_available: false
current_closeout_available: false
```

The positive approval branch is complete through C11. The stricter sequence
that must demonstrate rejection, regeneration and preservation of versions is
only continuously reachable from the Workbench through C09. The first
`MISSING`, `PLACEHOLDER` or `LEGACY_ONLY` implementation in the ordered path is
C12. Evidence after C12 is therefore deliberately shallow.

## Sequential core path

### C01 Existing Project selection

```yaml
implementation: WORKBENCH_WIRED
acceptance: FIXTURE_VERIFIED
ui_control: ProjectsPage project list and project picker
http_route: GET /api/v2/projects and GET /api/v2/projects/:project_id/:workspace
service_function: listWorkbenchProjects and getWorkbenchProjectWorkspace
persistence: projects plus workbench_project_meta read through the current database boundary
media_input: NONE
media_output: NONE
test_evidence: tests/workbench-v2-domain.test.ts and src/workbench-ui/App.test.tsx
historical_evidence: NONE_REQUIRED
human_authority: Human selects the current Project in Workbench
failure_behavior: Missing, quarantined or non-writable projects fail through typed Workbench errors
```

### C02 Storyboard Package and Artifact readiness

```yaml
implementation: WORKBENCH_WIRED
acceptance: FIXTURE_VERIFIED
ui_control: Storyboard tab, active image preview and human approval control
http_route: PATCH /api/v2/projects/:project_id/shots/:shot_id
service_function: updateWorkbenchShot and active Artifact validation used by generation preflight
persistence: projects, shots, storyboard_packages, media_artifacts and media_blobs
media_input: Active storyboard_image Artifact bound to the same Project and Shot
media_output: NONE
test_evidence: tests/workbench-v2-domain.test.ts and current-main Workbench UI tests
historical_evidence: NONE_REQUIRED
human_authority: Human confirms the storyboard image and prompt before setting storyboard_approved
failure_behavior: Missing or mismatched package, role, Project, Shot, active state or Blob prevents readiness
```

### C03 Generation readiness

```yaml
implementation: WORKBENCH_WIRED
acceptance: REQUIRES_AUTHORIZATION
ui_control: Generation tab Shot selector and 预检并生成 action
http_route: POST /api/v2/projects/:project_id/generation/preflight
service_function: preflightWorkbenchGeneration
persistence: Reads Project, Shot, active Artifact, Provider configuration and budget policy before preparing an Intent
media_input: Active storyboard image validated against Project, Shot, role and Blob
media_output: NONE
test_evidence: tests/workbench-v2-domain.test.ts and tests/m1-provider-boundary.test.ts provide fixture evidence
historical_evidence: R3-8O and R3-9D prove earlier RunningHub readiness only
human_authority: Human chooses Shot, account label and budget limit
failure_behavior: Provider capability, credential, price, balance, budget, workflow or input drift fails closed
```

Current live readiness is not accepted by static code or CI. A future S3 live
preflight requires its own narrow authorization and exact current environment.

### C04 Cost acknowledgement and Generation Intent

```yaml
implementation: WORKBENCH_WIRED
acceptance: FIXTURE_VERIFIED
ui_control: Preflight modal showing official cost, budget and explicit acknowledgement checkbox
http_route: POST /api/v2/generation-intents/:intent_id/confirm
service_function: preflightWorkbenchGeneration and confirmWorkbenchGeneration
persistence: generation_intents, generation_jobs, generation_runs, projects and shots
media_input: Immutable input snapshot referencing the validated storyboard Artifact
media_output: NONE
test_evidence: tests/workbench-v2-domain.test.ts covers Intent preparation, confirmation, expiry and stale-input gates
historical_evidence: Earlier R3 execution used explicit canary boundaries but is not current Workbench acceptance
human_authority: Both cost acknowledgement and generation confirmation must be true
failure_behavior: Expired Intent, changed input, changed capability, insufficient budget or absent confirmation fails closed before submit
```

### C05 Provider submission

```yaml
implementation: WORKBENCH_WIRED
acceptance: HISTORICAL_EXTERNAL_PASS
ui_control: Confirm action schedules the one prepared generation job
http_route: POST /api/v2/generation-intents/:intent_id/confirm
service_function: confirmWorkbenchGeneration, startWorkbenchGeneration and runWorkbenchGenerationOnce
persistence: generation_intents, generation_jobs, generation_job_events and generation_runs
media_input: Validated storyboard Artifact supplied through the RunningHub adapter boundary
media_output: Provider task reference after a known successful submit
test_evidence: tests/workbench-v2-domain.test.ts and tests/m1-provider-boundary.test.ts
historical_evidence: R3-8O and R3-9D completed real RunningHub submissions on earlier commits
human_authority: Paid submit follows explicit Workbench cost acknowledgement and confirmation
failure_behavior: Unknown submit outcome enters manual_reconciliation and is not blindly resubmitted
```

`HISTORICAL_EXTERNAL_PASS` does not mean this current-main Workbench submit has
been externally accepted. That remains false and requires a separately
authorized S4 canary after S3 readiness.

### C06 Poll, download and FFprobe validation

```yaml
implementation: WORKBENCH_WIRED
acceptance: HISTORICAL_EXTERNAL_PASS
ui_control: Generation status is read from the current Project workspace
http_route: Generation worker behind the confirmed Intent; no separate operator poll route is required
service_function: runWorkbenchGenerationOnce and downloadProviderOutputToArtifact
persistence: generation_jobs, generation_job_events, generation_runs, media_blobs and media_artifacts
media_input: Known Provider task and pinned Provider output response
media_output: Size-bounded temporary MP4 followed by an activated governed media file
test_evidence: tests/m1-provider-boundary.test.ts covers Provider output download and FFprobe-valid Artifact registration
historical_evidence: R3-8O, R3-9D and R3-9J completed real poll, download and FFprobe validation on earlier commits
human_authority: No second paid submit is inferred from a poll or download retry
failure_behavior: Timeout, unsafe redirect, oversized body, invalid MP4 or uncertain known task fails or enters reconciliation without duplicate submit
```

### C07 Generation Run and Artifact registration

```yaml
implementation: WORKBENCH_WIRED
acceptance: HISTORICAL_EXTERNAL_PASS
ui_control: Generation and Review tabs expose Run state and generated version
http_route: GET /api/v2/projects/:project_id/:workspace and GET /media/artifacts/:artifact_id
service_function: runWorkbenchGenerationOnce, downloadProviderOutputToArtifact and getWorkbenchProjectWorkspace
persistence: generation_runs, generation_intents, generation_jobs, media_blobs, media_artifacts and Shot clip_versions
media_input: FFprobe-valid downloaded MP4
media_output: Active generated_clip Artifact bound to the current Project and Shot
test_evidence: tests/m1-provider-boundary.test.ts and tests/workbench-v2-domain.test.ts
historical_evidence: R3-8O, R3-9D and R3-9J registered earlier real outputs on their exact commits
human_authority: Generated output remains pending review and is not auto-accepted
failure_behavior: Finalization is transactional and invalid or stale bindings do not become accepted clips
```

### C08 Local Workbench playback

```yaml
implementation: WORKBENCH_WIRED
acceptance: FIXTURE_VERIFIED
ui_control: MediaPreview video element with native controls in Generation and Review
http_route: GET /media/artifacts/:artifact_id with byte Range support
service_function: Workbench media handler and getWorkbenchProjectWorkspace
persistence: Reads active media_artifacts and media_blobs
media_input: Governed generated_clip file constrained to the configured media root
media_output: Local video response, including partial-content responses
test_evidence: Current-main Workbench UI, domain and browser smoke jobs
historical_evidence: NONE_REQUIRED
human_authority: Human watches the generated clip locally
failure_behavior: Missing, inactive, mismatched or out-of-root Artifact is rejected
```

### C09 Human approve or reject

```yaml
implementation: WORKBENCH_WIRED
acceptance: FIXTURE_VERIFIED
ui_control: Review tab 采纳此版本 and 请求重生成 actions
http_route: POST /api/v2/projects/:project_id/review/decision
service_function: decideWorkbenchClip and markShotClipReview
persistence: Shot review state, accepted artifact reference, review notes and regeneration_requests
media_input: Selected generated_clip version
media_output: NONE
test_evidence: tests/workbench-v2-domain.test.ts and tests/m0-e-review-regeneration.test.ts
historical_evidence: R3-9J includes an earlier real regeneration decision path
human_authority: Only the Workbench human decision accepts or rejects a clip
failure_behavior: Artifact, Project or Shot mismatch and invalid decision state fail closed
```

### C10 Regeneration and version preservation

```yaml
implementation: API_WIRED
acceptance: FIXTURE_VERIFIED
ui_control: Review can create revision_needed, but Generation disables 预检并生成 unless the Shot is storyboard_approved
http_route: Existing generation preflight and confirm routes accept regeneration workflow state through the operational gate
service_function: decideWorkbenchClip, preflightWorkbenchGeneration, confirmWorkbenchGeneration and runWorkbenchGenerationOnce
persistence: regeneration_requests, parent_generation_run_id, generation_runs and Shot clip_versions
media_input: Prior generated version remains governed while the storyboard input snapshot is prepared again
media_output: A new version can be appended without deleting the old Artifact
test_evidence: tests/m0-e-review-regeneration.test.ts and tests/workbench-v2-domain.test.ts
historical_evidence: R3-9J completed real regeneration on its exact historical commit
human_authority: Human rejection and revision instruction exist, but the current Workbench lacks the follow-through launch control
failure_behavior: API gates preserve stale-input, budget and unknown-submit protections; the UI currently stops before preflight
```

This is a P0 full-loop gap, but it is not an S3 initial single-shot readiness
gap.

### C11 Accepted clip authority

```yaml
implementation: WORKBENCH_WIRED
acceptance: FIXTURE_VERIFIED
ui_control: Workbench Review approval and Delivery accepted-clip order preview
http_route: POST /api/v2/projects/:project_id/review/decision and GET /api/v2/projects/:project_id/delivery
service_function: decideWorkbenchClip, markShotClipReview and getWorkbenchProjectWorkspace
persistence: Shot accepted_artifact_id and approval state
media_input: Human-selected generated_clip Artifact
media_output: Ordered references to accepted governed clips, not copied media
test_evidence: tests/m0-e-review-regeneration.test.ts and tests/workbench-v2-domain.test.ts
historical_evidence: R3-9O consumed accepted clips on an earlier path
human_authority: Workbench is the business authority for clip adoption
failure_behavior: Unaccepted, inactive or mismatched Artifacts cannot satisfy ready_for_assembly
```

### C12 Assembly plan

```yaml
implementation: PLACEHOLDER
acceptance: FIXTURE_VERIFIED
ui_control: Delivery exposes readiness only; Inbox can execute an imported final-assembly Proposal
http_route: POST /api/v2/inbox/pending/:action_id/decision for an existing Proposal; no direct assembly-plan creation route
service_function: decideWorkbenchPendingAction validates accepted clips and returns their order but does not create an executable plan
persistence: Pending-action execution is audited, but no executable assembly plan with frozen media inputs was found
media_input: Accepted clip references
media_output: NONE
test_evidence: Delivery-state fixture tests only
historical_evidence: R3-9O used a historical explicit assembly execution script
human_authority: Human may accept an advisory Inbox Proposal, but that decision does not freeze an executable plan
failure_behavior: Delivery can report readiness and Inbox can acknowledge an order without providing the next production action
```

This is `first_hard_break`. The remaining steps are entry checks rather than a
claim that a complete downstream path exists.

### C13 Real assembly execution

```yaml
implementation: PLACEHOLDER
acceptance: FIXTURE_VERIFIED
ui_control: No current Workbench execution control
http_route: No current Workbench assembly execution route
service_function: assembleFinalVideo uses placeholder_copy and a fixed fixture
persistence: A placeholder Generation Run can be written
media_input: fixtures/video/mock_clip.mp4 rather than accepted clip bytes
media_output: Existing fixture content is registered rather than a newly assembled file
test_evidence: tests/m0-f-assembly.test.ts
historical_evidence: R3-9O performed real FFmpeg assembly only on its exact historical commit
human_authority: Explicit confirmation exists only on the internal placeholder function
failure_behavior: Accepted-clip checks run, but no real FFmpeg assembly or production cleanup path exists
```

### C14 Final Artifact registration

```yaml
implementation: PLACEHOLDER
acceptance: FIXTURE_VERIFIED
ui_control: Delivery can display a final Artifact if one already exists
http_route: No current Workbench real-final registration action
service_function: assembleFinalVideo registers the placeholder fixture as final_video
persistence: media_blobs, media_artifacts, generation_runs and project.exports.final_video_artifact_id
media_input: Fixed fixture from the placeholder assembly path
media_output: Governed final_video reference whose bytes are not a real current assembly
test_evidence: tests/m0-f-assembly.test.ts
historical_evidence: R3-9O registered a real assembled Artifact on an earlier path
human_authority: No current Workbench action approves a real assembled output
failure_behavior: Placeholder registration can satisfy structural state without proving production assembly
```

### C15 Export

```yaml
implementation: MISSING
acceptance: NOT_VERIFIED
ui_control: No current Workbench export action
http_route: No current Workbench export route
service_function: UNKNOWN_NEEDS_PROOF
persistence: UNKNOWN_NEEDS_PROOF
media_input: UNKNOWN_NEEDS_PROOF
media_output: UNKNOWN_NEEDS_PROOF
test_evidence: UNKNOWN_NEEDS_PROOF
historical_evidence: R3-9R referenced a historical delivery package rather than a current Workbench export path
human_authority: No current Workbench export confirmation was found
failure_behavior: UNKNOWN_NEEDS_PROOF
```

### C16 Closeout

```yaml
implementation: LEGACY_ONLY
acceptance: NOT_VERIFIED
ui_control: Current surfaces can read delivery or historical closeout status but cannot execute current closeout
http_route: Read-only closeout evidence routes exist; no current Workbench closeout mutation route
service_function: Historical closeout readers exist; current product closeout execution is not wired
persistence: UNKNOWN_NEEDS_PROOF
media_input: UNKNOWN_NEEDS_PROOF
media_output: UNKNOWN_NEEDS_PROOF
test_evidence: Read-only fixture evidence does not prove closeout execution
historical_evidence: R3-9R completed historical local closeout on its exact commit
human_authority: No current Workbench delivery/closeout approval action was found
failure_behavior: Current UI stops at status display
```

## Workbench reachability

| Operation | UI | HTTP route | Service | Persistence | Implementation | Acceptance |
|---|---|---|---|---|---|---|
| Select Project | Project list/picker | `GET /api/v2/projects` | `listWorkbenchProjects` | Project/meta read | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Import or verify Storyboard | Storyboard preview/approval | Shot `PATCH` | `updateWorkbenchShot` | Package, Shot, Artifact | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Generation preflight | `预检并生成` | Generation preflight `POST` | `preflightWorkbenchGeneration` | Prepared Intent | `WORKBENCH_WIRED` | `REQUIRES_AUTHORIZATION` |
| Cost acknowledgement | Confirmation modal | Intent confirm `POST` | `confirmWorkbenchGeneration` | Intent confirmation | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Create Intent | Same preflight flow | Generation preflight `POST` | `preflightWorkbenchGeneration` | `generation_intents` | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Submit generation | Confirm action | Intent confirm `POST` | Generation worker | Job, Run, events | `WORKBENCH_WIRED` | `HISTORICAL_EXTERNAL_PASS` |
| Poll generation | Status refresh | Workspace `GET` | Generation worker | Job, Run | `WORKBENCH_WIRED` | `HISTORICAL_EXTERNAL_PASS` |
| Play generated clip | Video preview | Artifact media `GET` | Workbench media handler | Artifact/Blob read | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Approve | `采纳此版本` | Review decision `POST` | `decideWorkbenchClip` | Accepted Artifact | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Reject | `请求重生成` | Review decision `POST` | `decideWorkbenchClip` | Revision request | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Regenerate | No enabled follow-through control in revision state | Existing preflight/confirm routes | Current generation services | New Run/version supported | `API_WIRED` | `FIXTURE_VERIFIED` |
| Select accepted clip | Approve action/version stack | Review decision `POST` | `markShotClipReview` | `accepted_artifact_id` | `WORKBENCH_WIRED` | `FIXTURE_VERIFIED` |
| Create assembly plan | Delivery status; optional Inbox Proposal decision | Inbox pending-action decision `POST` | Validates and returns accepted-clip order | Audit event, no executable frozen plan | `PLACEHOLDER` | `FIXTURE_VERIFIED` |
| Run assembly | None | None | Fixture-copy internal function | Placeholder Run | `PLACEHOLDER` | `FIXTURE_VERIFIED` |
| Register final video | Display only | None | Placeholder registration | Final Artifact reference | `PLACEHOLDER` | `FIXTURE_VERIFIED` |
| Export | None | None | `UNKNOWN_NEEDS_PROOF` | `UNKNOWN_NEEDS_PROOF` | `MISSING` | `NOT_VERIFIED` |
| Closeout | Read-only status only | Read-only evidence route | Historical readers only | `UNKNOWN_NEEDS_PROOF` | `LEGACY_ONLY` | `NOT_VERIFIED` |

## Assembly trace

| Question | Current active result |
|---|---|
| 1. Inputs from accepted clips or fixed fixture? | Accepted clip references are validated, but output bytes come from a fixed fixture. |
| 2. Uses `mock_clip.mp4`? | Yes: `fixtures/video/mock_clip.mp4`. |
| 3. Uses `placeholder_copy`? | Yes, as the recorded model name. |
| 4. Calls FFmpeg? | No. |
| 5. Freezes input order and digests? | No executable assembly manifest or accepted-input digest freeze was found. |
| 6. Generates a new file? | No; it registers fixture content. |
| 7. Runs FFprobe? | Not as a real post-assembly validation of newly composed output. |
| 8. Registers a final Artifact? | Yes, but only from the placeholder fixture path. |
| 9. Has failure cleanup? | No real assembly temporary-output cleanup path exists because no real output is created. |
| 10. Has a Workbench execution entry? | No. |

Therefore `ready_for_assembly` is a readiness predicate, not real assembly
acceptance. A copied mock fixture is not production composition.

## Optional ChatGPT review path: O01 Director frame inspection

```yaml
implementation: WORKBENCH_WIRED
acceptance: REQUIRES_AUTHORIZATION
ui_control: Workbench Director Focus and Proposal review surfaces
http_route: Unified Director MCP tools over the separately managed local Bridge
service_function: Director Focus/context, frame inspection and immutable Proposal submission services
persistence: Frame inspection is read-only; only Proposal submission writes an immutable pending_review Proposal and event
media_input: Current Focus binds the active Project, Shot and video Artifact; the local service verifies Artifact and Blob identity
media_output: Timestamped JPEG frames created from a private temporary copy and removed after inspection
test_evidence: Current-main Director contract, local service and Workbench approval fixture suites
historical_evidence: Managed Bridge was previously accepted at source commit 3a142bb only
human_authority: Proposal remains advisory until a human reviews it in Workbench
failure_behavior: FFprobe, FFmpeg, digest, Focus or source drift fails closed; Director cannot approve, execute, deliver or invoke a Provider
```

Focus binds the selected Project/Shot/video Artifact. The local inspection path
validates the Artifact and Blob, uses FFprobe for metadata and FFmpeg for
bounded frame extraction, and supplies the model JPEG frames rather than a
Widget playback URL. Frame inspection does not write SQLite. A submitted
Proposal is persisted as `pending_review` and enters Workbench; it is not an
approval or execution.

The observed managed Bridge source is `3a142bb`, so it is
`RESTART_REQUIRED` relative to current main. S2 did not revalidate its
configuration identity, heartbeat or authenticated Remote contact. That blocks
a claim that the real S5 ChatGPT frame-review transport is accepted, but it
does not block S2, S3 or S4. The path does not depend on Media Gateway because
the model receives locally extracted frames through the Director transport.

## Historical evidence

| Historical task | Exact commit | Real operation | Current location | Reusable idea | Cannot be inherited |
|---|---|---|---|---|---|
| R3-8O | `99dd716125c876b9f017c2472981c99f36d8fa42` | One real RunningHub submit, download and media validation | `legacy/scripts/r3-8o-runninghub-enterprise-key-6s-single-submit-canary.ts` and its report | One-submit canary boundary and low-disclosure receipt | Current Workbench, schema 0011 and current-main external acceptance |
| R3-9D | `b9e89910a7740c123042274d0b762f25867ad4a9` | Four real Shot generations with download and FFprobe | `legacy/scripts/r3-9d-runninghub-4-shot-single-pass-live-execution.ts` and its report | Bounded multi-Shot execution and governed outputs | Current Workbench orchestration or current Provider readiness |
| R3-9J | `dfc8d422caf6ad47d001caecc3eeb108483e2c16` | Real regeneration with known-task recovery and no duplicate submit | `legacy/scripts/r3-9j-runninghub-regeneration-single-pass-live-execution.ts` and its report | Version preservation and reconcile-known-task principle | Current Workbench regeneration UI reachability |
| R3-9O | `9056c312bacda482dfc8fcb5c49363febf974daa` | Real local FFmpeg concat of four accepted clips, validation and final Artifact registration | `legacy/scripts/r3-9o-final-video-assembly-execution.ts` and its report | Explicit ordered inputs, real composition and post-assembly validation | Current active `assembleFinalVideo`, which remains placeholder-based |
| R3-9R | `17e60e6d1ee5ad0d33bc7c84b7854d1bcc4bd2af` | Historical local delivery closeout evidence | `legacy/scripts/r3-9r-final-delivery-closeout.ts` and its report | Explicit closeout checks and auditable summary | Current Workbench export/closeout execution or external delivery |

These reports remain commit-scoped feasibility evidence. Their scripts moved
to `legacy/`; no historical external or local result is inherited by current
main.

## Test evidence used

S2 did not run a local test group. Static evidence was sufficient to identify
the first hard break, and avoiding execution kept the audit inside the smallest
read-only boundary. For the exact current-main commit, the existing Windows CI
run already passed:

- `Quality and integration`, including current Workbench V2 domain/UI,
  Provider safety, media/Artifact and Director fixture suites.
- `Browser smoke`.

Those are code/fixture signals only. They do not constitute a Provider call,
current external generation acceptance, real assembly acceptance, export or
closeout.

## Gap priorities

### P0_CORE_BLOCKER

- C10: rejection creates a governed regeneration request and the backend can
  prepare another run, but the current Workbench cannot launch preflight from
  `revision_needed`. This blocks the required human rejection-to-new-version
  loop, but not the initial one-shot S3 readiness audit.
- C12-C14: no executable assembly plan or real composition exists in the
  current product path; the active implementation registers a mock fixture
  through `placeholder_copy`.
- C15-C16: no current Workbench export or closeout execution path exists.

### P1_CORE_RELIABILITY

- Current-main initial generation has strong fixture and safety coverage, but
  no current external Provider acceptance. S3 must bound the exact readiness
  preflight, and S4 must remain a separately authorized one-shot paid canary.

### P2_OPERATOR_USABILITY

- Delivery text says the product can enter the existing assembly flow even
  though neither the Delivery view nor Inbox Proposal adoption creates an
  executable plan or starts assembly. The wording should be corrected when S6
  implements the real path.
- The Review action creates `revision_needed`, but the Generation action does
  not expose why its same-shot preflight is unavailable.

### DEFERRED_OPTIONAL

- Director Bridge promotion, Snapshot, Media Gateway, Memory, multi-user,
  Windows automatic startup, WebM/broad formats, Provider marketplace,
  automatic Provider routing and new OAuth experiments remain outside the S3
  and S4 blocker chain.

## Minimal S3 derivation

```yaml
s3_readiness:
  already_ready:
    - Existing Project and approved Storyboard Artifact selection
    - Initial single-Shot Workbench preflight and explicit confirmation UI
    - Generation Intent, budget and human cost acknowledgement
    - RunningHub capability and adapter boundary
    - Unknown paid-submit outcome enters manual reconciliation without blind retry
    - Poll, bounded download, FFprobe, Blob/Artifact and Run registration path
  proven_current_path:
    - C01 through C09 for an initial single-Shot generation and review
    - C11 for the positive human-approval branch
  minimal_code_gaps: []
  minimal_ui_gaps: []
  required_targeted_tests:
    - Existing isolated Workbench generation Intent and confirmation tests
    - Existing Provider unknown-submit and known-task reconciliation tests
    - Existing bounded download, FFprobe and Artifact registration tests
  live_preflight_required: true
  provider_authorization_required: true_for_the_later_S4_paid_single_shot_only
  explicitly_not_required:
    - Director Bridge
    - Snapshot
    - Media Gateway
    - Memory
    - Multi-user
    - Windows automatic startup
    - WebM
    - Provider marketplace
    - Automatic provider routing
    - Assembly
    - Export
    - Closeout
```

The S3 promotion gate is satisfied at audit level: Generation Intent exists;
budget and human confirmation exist; the Provider adapter boundary exists;
unknown paid submit does not auto-retry; download and FFprobe exist; Run and
Artifact registration exist; and the remaining S3 scope is bounded. S3 is
readiness work only. It does not authorize S4, a Provider call or any external
change.
