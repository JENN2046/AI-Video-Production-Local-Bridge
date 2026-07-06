# AI Video Production Workspace｜M0 Codex Handoff Prompt v1.1

You are Codex acting as the implementation agent for **AI Video Production Workspace｜M0 Video Loop Validation**.

Your task is to implement the **M0 mock-provider-first video production loop**.

Do **not** expand the product beyond M0.

---

## 0. Mission

Implement the M0 video loop:

```text
create_project
  ↓
register_media_artifact
  ↓
import_storyboard_package
  ↓
start_storyboard_video_generation
  ↓
get_generation_status
  ↓
mark_shot_clip_review
  ↓
regenerate_shot_video
  ↓
assemble_final_video
  ↓
get_project_status
```

The purpose of M0 is to prove:

```text
GPT-generated storyboard image
  → active Media Artifact
  → approved Storyboard Package
  → Generation Batch
  → Generation Run
  → generated video artifact
  → shot review
  → revision_needed
  → regenerated shot
  → accepted clip
  → final video artifact
```

M0 success is not measured by video quality.

M0 success is measured by whether the engineering loop is:

```text
traceable
persistent
testable
repeatable
auditable
safe against invalid file states
safe against silent overwrites
```

---

## 1. First Step｜Repository Reality Calibration

Before editing code, inspect the repository and output a short reality report.

```yaml
repo_reality:
  stack_detected:
  package_manager:
  existing_server:
  existing_storage:
  existing_tests:
  existing_scripts:
  existing_media_or_fixture_dirs:
  implementation_strategy:
  blockers:
```

### 1.1 Continue / Stop Rule

After reality calibration:

```text
Continue implementation if:
- the stack is clear, or
- no stack exists and a minimal M0 app skeleton can be created, or
- missing pieces can be safely added within M0 scope.

Stop and report BLOCK only if:
- destructive migration would be required,
- production data would be modified,
- secrets or provider credentials are required,
- no writable app-controlled storage is possible,
- file transfer into active Media Artifact is impossible,
- repository state prevents safe implementation.
```

Do not stop merely because the repository is empty or lacks an app skeleton.
If no usable structure exists, create a minimal M0 app.

### 1.2 Default stack if none exists

If no stack is established, prefer:

```text
Node.js / TypeScript
SQLite for metadata
local filesystem for media artifacts
npm scripts for validation commands
```

### 1.3 Hard prohibitions

Do not:

```text
push
tag
release
deploy
publish
connect real video provider
require provider credentials
write outside app-controlled storage
read secrets
log secrets
```

---

## 2. Scope

### 2.1 Must implement these 9 M0 tools

```text
1. create_project
2. get_project_status
3. register_media_artifact
4. import_storyboard_package
5. start_storyboard_video_generation
6. get_generation_status
7. mark_shot_clip_review
8. regenerate_shot_video
9. assemble_final_video
```

### 2.2 Must implement these 6 minimal objects

```text
1. Project
2. Shot
3. Storyboard Package
4. Media Artifact
5. Generation Batch
6. Generation Run
```

### 2.3 Must implement storage

Use:

```text
SQLite for metadata
app-controlled local filesystem for media files
```

Recommended structure:

```text
data/
  app.sqlite
  media/
    artifacts/
      images/
      videos/
      final/
  reports/
    m0_closeout.yaml

fixtures/
  storyboard/
    shot_001.png
    shot_002.png
    shot_003.png
  video/
    mock_clip.mp4
```

### 2.4 Must provide validation commands

Provide these commands or exact equivalents:

```bash
npm run test:m0
npm run demo:m0
npm run closeout:m0
```

Also provide one of the following:

```bash
npm run m0:reset
```

or make `test:m0` and `demo:m0` use isolated/reset test data automatically.

Requirements:

```text
test:m0      runs all M0 automated tests
demo:m0      runs the 3-shot mock demo
closeout:m0  writes data/reports/m0_closeout.yaml
m0:reset     resets M0 test/demo data if implemented
```

Any failed hard gate must return non-zero exit code.

---

## 3. Non-Goals

Do not implement:

```text
1. complete asset library
2. complete reference library
3. memory recall
4. memory saveback
5. real video provider dependency
6. complete UI workspace
7. advanced timeline editor
8. subtitles
9. voiceover
10. music
11. cover generation
12. commercial delivery package
13. multi-user permissions
14. complete version system
15. complete review event system
16. automatic aesthetic learning
17. cloud storage
18. production deployment
19. provider billing
20. provider rate-limit management
```

Do not drift into M1.

---

## 4. Tool Exposure Requirement

The 9 tools must be implemented behind a stable tool interface.

Minimum requirement:

```text
1. Each tool has a stable callable function/interface.
2. demo:m0 and test:m0 must call the tool interface.
3. demo:m0 and test:m0 must not mutate SQLite or media files directly to fake success.
4. If an existing server exists, expose tools through the existing server route pattern.
5. If no server exists, implement a clear src/tools/* layer or equivalent.
6. HTTP / MCP / ChatGPT App bridge can be added later; M0 only needs a stable internal tool layer.
```

Do not implement the whole loop only inside a demo script.

The demo must prove that the tools work.

---

## 5. Minimal Data Model

### 5.1 Project

```json
{
  "project_id": "",
  "title": "",
  "project_type": "",
  "status": "draft",
  "brief": {},
  "video_spec": {
    "duration_seconds": 15,
    "aspect_ratio": "9:16",
    "resolution": "1080x1920"
  },
  "shot_ids": [],
  "active_storyboard_package_id": "",
  "generation_batch_ids": [],
  "exports": {
    "final_video_artifact_id": ""
  }
}
```

Project status enum:

```text
draft
storyboard_approved
video_generation_in_progress
video_review
final_approved
```

Rule:

```text
assemble_final_video succeeded → video_review
final_approved requires explicit final approval path
```

M0 does not need a separate `final_video_generated` status.
Whether a final video exists is represented by:

```text
Project.exports.final_video_artifact_id
```

---

### 5.2 Shot

```json
{
  "shot_id": "",
  "project_id": "",
  "order": 1,
  "status": "draft",
  "duration_seconds": 2,
  "description": "",
  "storyboard_image_artifact_id": "",
  "video_prompt": "",
  "negative_prompt": "",
  "generation_run_ids": [],
  "accepted_clip_artifact_id": "",
  "clip_versions": [],
  "review": {
    "approval_status": "pending",
    "rejection_reasons": [],
    "latest_revision_instruction": null
  }
}
```

Shot status enum:

```text
draft
storyboard_approved
video_pending
video_generated
video_review
approved
revision_needed
```

---

### 5.3 Storyboard Package

```json
{
  "storyboard_package_id": "",
  "project_id": "",
  "status": "approved_for_video_generation",
  "approved_shot_snapshots": [],
  "user_approval": {
    "storyboard_approved": true
  }
}
```

Rule:

```text
Storyboard Package is a frozen snapshot.
Do not dynamically mutate it when Shot later changes.
```

---

### 5.4 Media Artifact

```json
{
  "artifact_id": "",
  "artifact_type": "image | video",
  "role": "storyboard_image | generated_clip | final_video",
  "status": "pending_upload | active | inaccessible | expired | archived",
  "storage": {
    "uri": "",
    "mime_type": "",
    "filename": ""
  },
  "metadata": {
    "width": 0,
    "height": 0,
    "duration_seconds": null,
    "aspect_ratio": ""
  },
  "linked_objects": {
    "project_id": "",
    "shot_id": ""
  }
}
```

Rules:

```text
pending_upload / inaccessible / expired artifacts must not enter Storyboard Package.
Only active storyboard_image image artifacts may be used for video generation.
Only active generated_clip video artifacts may be accepted for Shot review.
Only active final_video video artifacts may be written as final output.
```

---

### 5.5 Generation Batch

```json
{
  "batch_id": "",
  "project_id": "",
  "storyboard_package_id": "",
  "run_ids": [],
  "status": "queued | running | succeeded | failed | partially_failed | cancelled",
  "summary": {
    "total": 0,
    "queued": 0,
    "running": 0,
    "succeeded": 0,
    "failed": 0
  }
}
```

`partially_failed` is allowed only on Generation Batch.
It must never appear on a single Generation Run.

---

### 5.6 Generation Run

```json
{
  "run_id": "",
  "batch_id": "",
  "project_id": "",
  "shot_id": "",
  "run_type": "image_to_video | regenerate_shot | assemble_video",
  "status": "queued | running | succeeded | failed | cancelled",
  "input": {
    "storyboard_image_artifact_id": "",
    "video_prompt": "",
    "negative_prompt": "",
    "duration_seconds": 2,
    "aspect_ratio": "9:16",
    "resolution": "1080x1920"
  },
  "output": {
    "artifact_ids": []
  },
  "versioning": {
    "attempt_number": 1,
    "parent_run_id": ""
  },
  "error": {
    "code": "",
    "message": "",
    "retryable": false
  }
}
```

---

## 6. Required Tool Behavior

### 6.1 create_project

Create a Project.

Must return:

```json
{
  "project_id": "",
  "status": "draft"
}
```

Acceptance:

```text
Project persists to SQLite.
get_project_status can retrieve it after restart.
```

---

### 6.2 get_project_status

Return:

```text
Project status
Shot list
Generation Batch summary
Generation Run summary
ready_for_assembly
blocking_reasons
final_video_artifact_id
```

Acceptance:

```text
draft project returns draft
imported storyboard returns shot list
generated project returns generation summary
not all shots approved → ready_for_assembly = false
all shots approved → ready_for_assembly = true
```

---

### 6.3 register_media_artifact

Support:

```text
file_handle
accessible_uri
app_upload
pending_user_upload
fixture_path
```

Rules:

```text
fixture_path may only point to fixtures directory.
All copied media must be stored under app-controlled data/media directory.
No arbitrary local path read.
No path traversal.
No writes outside app-controlled media directory.
```

Acceptance:

```text
accessible file → active
pending user upload → pending_upload
bad path → STORAGE_PATH_NOT_ALLOWED
unreadable file → MEDIA_FILE_NOT_READABLE
wrong role → INVALID_ARTIFACT_ROLE
```

---

### 6.4 import_storyboard_package

Validate:

```text
Project exists
status = approved_for_video_generation
user_approval.storyboard_approved = true
approved_shot_snapshots not empty
each shot has storyboard_image_artifact_id
each storyboard artifact is active
each storyboard artifact role = storyboard_image
each storyboard artifact artifact_type = image
each shot has video_prompt
each shot has duration_seconds
```

Effects:

```text
Save Storyboard Package frozen snapshot
Create/update Shots
Project.active_storyboard_package_id = storyboard_package_id
Project.status = storyboard_approved
Shot.status = storyboard_approved
```

Failure codes:

```text
MISSING_REQUIRED_FIELD
ARTIFACT_PENDING_UPLOAD
ARTIFACT_INACCESSIBLE
ARTIFACT_EXPIRED
INVALID_ARTIFACT_ROLE
UNAPPROVED_STORYBOARD_PACKAGE
```

---

### 6.5 start_storyboard_video_generation

Requires hard gate confirmation:

```json
{
  "confirmation": {
    "confirmation_level": "hard_gate",
    "user_confirmed": true
  }
}
```

If missing:

```text
HARD_GATE_CONFIRMATION_REQUIRED
```

Internal behavior:

```text
Read Storyboard Package
Validate each Shot
Create Generation Batch
Create Generation Run per Shot
Use mock provider by default
Create generated_clip video artifact per succeeded run
Update Shot.clip_versions
Update project / batch / run status
```

Acceptance:

```text
3-shot package creates 1 batch
batch has 3 runs
each run maps to one shot
each successful run creates active generated_clip video artifact
batch summary is correct
```

---

### 6.6 get_generation_status

Support query by:

```text
project_id
batch_id
run_id
```

Acceptance:

```text
batch_id returns all runs
run_id returns single run
project_id returns generation summary
failed run returns error.code and error.message
```

---

### 6.7 mark_shot_clip_review

M0 user decision enum:

```text
approved
revision_needed
```

For `approved`:

```text
Shot.accepted_clip_artifact_id = artifact_id
Shot.status = approved
clip_versions.review_status = approved
```

For `revision_needed`:

```text
Shot.status = revision_needed
clip_versions.review_status = rejected
review.rejection_reasons saved
review.latest_revision_instruction saved
old artifact preserved
```

Expected revision instruction:

```json
{
  "summary": "",
  "prompt_delta": "",
  "negative_delta": "",
  "priority": "low | medium | high"
}
```

---

### 6.8 regenerate_shot_video

Requires hard gate confirmation:

```json
{
  "confirmation": {
    "confirmation_level": "hard_gate",
    "user_confirmed": true
  }
}
```

Preconditions:

```text
Shot exists
previous_run_id exists
updated_prompt exists
confirmation is valid
```

Effects:

```text
Create new Generation Run
attempt_number = previous attempt + 1
parent_run_id = previous_run_id
Create new generated_clip artifact
Preserve old artifact and old run
```

Acceptance:

```text
old run preserved
old artifact preserved
new run created
new artifact created
new run parent_run_id points to previous run
new artifact can be reviewed and approved
Shot.clip_versions contains V1 rejected + V2 approved in demo
```

---

### 6.9 assemble_final_video

Requires explicit confirmation:

```json
{
  "confirmation": {
    "confirmation_level": "explicit",
    "user_confirmed": true
  }
}
```

Preconditions:

```text
All required Shots have accepted_clip_artifact_id
Each accepted clip is active Media Artifact
Each accepted clip artifact_type = video
Each accepted clip role = generated_clip
aspect_ratio matches Project.video_spec
```

Effects:

```text
Create Generation Run with run_type = assemble_video
Create final_video Media Artifact
Project.exports.final_video_artifact_id = artifact_id
Project.status = video_review
```

If not ready:

```text
FINAL_ASSEMBLY_NOT_READY
```

---

## 7. Storyboard Image Transfer Spike

Before full Storyboard Package implementation, perform:

```text
M0-B0｜Storyboard Image Transfer Spike
```

### 7.1 Two-layer validation

Do not collapse fixture validation and external image transfer validation.

Implement and report both:

```text
M0-B0a｜Fixture Transfer Test
M0-B0b｜External Image Transfer Path Check
```

### 7.2 M0-B0a｜Fixture Transfer Test

Goal:

```text
Validate the artifact pipeline using fixture storyboard images.
```

Must prove:

```text
app can read fixture image bytes
app can copy/save image under data/media/artifacts/images
app can reopen the saved file
artifact.status = active
import_storyboard_package can reference it
```

### 7.3 M0-B0b｜External Image Transfer Path Check

Goal:

```text
Validate at least one non-fixture path or explicitly report NOT_TESTED.
```

Allowed paths:

```text
file handle
user upload
stable URI
pending_user_upload + later activation
```

Closeout must distinguish:

```yaml
storyboard_image_transfer_gate:
  fixture_path: PASS | FAIL
  external_transfer_path: PASS | FAIL | NOT_TESTED
```

Rule:

```text
Fixture path can validate the engineering loop.
Fixture path alone must not be claimed as proof that real GPT image transfer is solved.
```

If no external transfer path is available in the repo/runtime, mark:

```text
external_transfer_path: NOT_TESTED
```

and include it in known gaps.

Do not block M0 solely because external transfer is NOT_TESTED, but do not misrepresent it as solved.

---

## 8. Mock Provider Requirements

M0 default provider must be mock.

Do not make real provider required.

Implement a minimal provider boundary:

```text
submit_generation(input) → provider_job_id
poll_status(provider_job_id) → status
fetch_output(provider_job_id) → video_file
```

Mock provider output must be:

```text
real readable .mp4 file
Media Artifact.status = active
artifact_type = video
role = generated_clip
duration_seconds non-empty
aspect_ratio matches Project.video_spec
storage.uri points to real existing file
```

Allowed mock implementation:

```text
copy fixture video
generate simple placeholder mp4
use static test mp4
```

Forbidden:

```text
fake path only
metadata-only video
active artifact with unreadable file
real provider required for M0
```

### 8.1 Real provider placeholder

Real provider must be disabled in M0.

If selected or called:

```text
return PROVIDER_DISABLED
do not attempt network calls
do not require credentials
do not log provider secrets
```

Add error code:

```text
PROVIDER_DISABLED
```

---

## 9. Network Boundary

M0 runtime must not require network access.

Allowed:

```text
dependency installation only if the repository workflow already requires it
```

Forbidden:

```text
real provider network calls
provider credential validation against external services
remote upload to cloud storage
network-only media artifact storage
```

All M0 tests and demo must pass without real provider network access.

---

## 10. Safety Boundaries

### 10.1 Storage safety

Must enforce:

```text
No path traversal
No writes outside app-controlled media directory
No arbitrary local file read
No absolute user-supplied paths unless explicitly allowed fixture path
No secrets in logs
No provider keys in database
```

Required error codes:

```text
STORAGE_PATH_NOT_ALLOWED
MEDIA_FILE_NOT_READABLE
```

### 10.2 Confirmation safety

Hard gate actions must reject missing confirmation.

Every hard/explicit confirmation tool must have:

```text
positive test with confirmation
negative test without confirmation
```

Never infer confirmation from system intent.

Only accept `user_confirmed=true` when the user explicitly requested:

```text
start generation
confirm generation
regenerate
confirm assembly
```

### 10.3 No overwrite

Regeneration must never overwrite previous run or artifact.

---

## 11. M0 Phases

Execute in order.

```text
M0-A  Base storage and app skeleton
M0-B  Media Artifact file chain and transfer spike
M0-C  Storyboard Package import
M0-D  Mock Provider video generation
M0-E  Review and regeneration
M0-F  Final assembly
M0-G  Provider boundary placeholder
M0-H  Validation and closeout
```

Do not skip M0-B0.

---

## 12. Validation Scenarios

### Scenario 1｜Three-shot mock loop

Flow:

```text
create_project
register_media_artifact × 3
import_storyboard_package
start_storyboard_video_generation
get_generation_status
mark_shot_clip_review × 3 approved
assemble_final_video
get_project_status
```

Pass:

```text
3 storyboard images active
Storyboard Package imported
3 generated clips active
3 Shots approved
final_video artifact active
get_project_status shows final_video_artifact_id
```

---

### Scenario 2｜Failed shot regeneration

Flow:

```text
generate 3 shot videos
Shot 002 revision_needed
regenerate_shot_video Shot 002
Shot 002 new version approved
assemble_final_video
```

Pass:

```text
Shot 002 original version preserved
Shot 002 new version generated
accepted_clip_artifact_id points to new version
final video uses approved new version
clip_versions contains V1 rejected + V2 approved
```

---

### Scenario 3｜Unavailable artifact blocked

Input:

```text
storyboard_image_artifact_id.status = pending_upload
```

Expected:

```text
import_storyboard_package fails
error.code = ARTIFACT_PENDING_UPLOAD
```

---

### Scenario 4｜Assembly blocked before all shots approved

Input:

```text
Shot 001 approved
Shot 002 revision_needed
Shot 003 approved
```

Expected:

```text
assemble_final_video fails
error.code = FINAL_ASSEMBLY_NOT_READY
blocking_reasons include Shot 002 has no accepted clip
```

---

### Scenario 5｜Confirmation gate blocked

Input:

```text
start_storyboard_video_generation without user_confirmed=true
```

Expected:

```text
error.code = HARD_GATE_CONFIRMATION_REQUIRED
```

Input:

```text
assemble_final_video without explicit confirmation
```

Expected:

```text
error.code = USER_CONFIRMATION_REQUIRED
```

---

### Scenario 6｜Path safety blocked

Input:

```text
register_media_artifact with path traversal path:
../../outside.png
```

Expected:

```text
error.code = STORAGE_PATH_NOT_ALLOWED
```

---

### Scenario 7｜Provider disabled blocked

Input:

```text
select real provider in M0
```

Expected:

```text
error.code = PROVIDER_DISABLED
no network call attempted
```

---

## 13. Required Tests

At minimum, implement automated tests for:

```text
Project:
- create project succeeds
- get project status returns draft
- unknown project returns PROJECT_NOT_FOUND
- metadata persists after restart

Artifact:
- active artifact registration succeeds
- pending upload artifact cannot be used
- inaccessible artifact cannot be used
- wrong artifact role rejected
- path traversal rejected
- fixture artifact readable
- fixture transfer path reported separately from external transfer path

Storyboard Package:
- valid package import succeeds
- missing video_prompt rejected
- pending artifact rejected
- unapproved package rejected
- package creates shots
- package is frozen snapshot

Generation:
- batch creation succeeds
- run creation succeeds
- mock provider output artifact created
- batch partially_failed works
- get_generation_status works
- run never uses partially_failed
- real provider selection returns PROVIDER_DISABLED

Review:
- approved clip sets accepted_clip_artifact_id
- revision_needed saves revision instruction
- regeneration creates new run
- regeneration preserves old artifact
- version chain V1 rejected / V2 approved exists

Assembly:
- assembly blocked before all shots approved
- assembly succeeds after all shots approved
- final video artifact created
- final video file readable

Confirmation:
- hard_gate missing confirmation blocked
- explicit confirmation missing blocked
- confirmed action succeeds

Repeatability:
- test:m0 does not depend on stale prior demo state
- demo:m0 is repeatable after reset or isolated state
```

---

## 14. Required Commands

Provide these commands:

```bash
npm run test:m0
npm run demo:m0
npm run closeout:m0
```

Also provide one of:

```bash
npm run m0:reset
```

or equivalent isolated test/demo state.

### 14.1 test:m0

Runs all M0 automated tests.

Requirements:

```text
all scenarios pass → exit code 0
any hard gate failure → non-zero exit code
prints failed error code
does not depend on stale prior demo state
```

### 14.2 demo:m0

Runs a 3-shot mock demo.

Must complete:

```text
create Project
register 3 storyboard fixture artifacts
import Storyboard Package
mock generate 3 generated clips
mark Shot 002 revision_needed
regenerate Shot 002
approve Shot 002 second version
assemble final video
```

### 14.3 closeout:m0

Writes:

```text
data/reports/m0_closeout.yaml
```

---

## 15. Closeout Report Format

Write exactly this structure to:

```text
data/reports/m0_closeout.yaml
```

```yaml
m0_closeout:
  result: PASS | PASS_WITH_GAPS | BLOCK
  generated_at:
  project_id:
  storyboard_package_id:

  validation:
    commands_run:
      - npm run test:m0
      - npm run demo:m0
      - npm run closeout:m0
    exit_codes:
      test_m0:
      demo_m0:
      closeout_m0:

  evidence:
    sqlite_path:
    media_root:
    final_video_path:
    closeout_report_path:
    demo_project_id:
    demo_batch_id:

  artifact_summary:
    storyboard_images:
      total:
      active:
      failed:
    generated_clips:
      total:
      succeeded:
      failed:
    final_video_artifact_id:

  generation_summary:
    batches:
    runs:
    failed_runs:

  review_summary:
    approved_shots:
    revision_needed_shots:
    regenerated_shots:

  scenarios:
    scenario_1_three_shot_loop: PASS | FAIL
    scenario_2_regeneration: PASS | FAIL
    scenario_3_artifact_block: PASS | FAIL
    scenario_4_assembly_block: PASS | FAIL
    scenario_5_confirmation_gate: PASS | FAIL
    scenario_6_path_safety: PASS | FAIL
    scenario_7_provider_disabled: PASS | FAIL

  hard_gates:
    storyboard_image_transfer_gate:
      fixture_path: PASS | FAIL
      external_transfer_path: PASS | FAIL | NOT_TESTED
    media_artifact_active_gate: PASS | FAIL
    storyboard_package_freeze_gate: PASS | FAIL
    generation_confirmation_gate: PASS | FAIL
    no_overwrite_gate: PASS | FAIL
    final_assembly_gate: PASS | FAIL

  known_gaps:
    - real provider not enabled
    - asset library not implemented
    - memory loop not implemented
    - advanced UI not implemented

  next_stage_recommendation:
    - M1 real provider integration
```

---

## 16. Error Codes

Implement at least:

```text
PROJECT_NOT_FOUND
SHOT_NOT_FOUND
ARTIFACT_NOT_FOUND
STORYBOARD_PACKAGE_NOT_FOUND
GENERATION_RUN_NOT_FOUND
GENERATION_BATCH_NOT_FOUND

MISSING_REQUIRED_FIELD
INVALID_STATUS_TRANSITION
INVALID_ARTIFACT_ROLE
ARTIFACT_PENDING_UPLOAD
ARTIFACT_INACCESSIBLE
ARTIFACT_EXPIRED

UNAPPROVED_STORYBOARD_PACKAGE
SHOT_NOT_READY_FOR_GENERATION
STORYBOARD_PACKAGE_NOT_READY
GENERATION_ALREADY_RUNNING
GENERATION_FAILED
GENERATION_PROVIDER_ERROR
GENERATION_BATCH_PARTIALLY_FAILED

FINAL_ASSEMBLY_NOT_READY
USER_CONFIRMATION_REQUIRED
HARD_GATE_CONFIRMATION_REQUIRED

STORAGE_PATH_NOT_ALLOWED
MEDIA_FILE_NOT_READABLE
PROVIDER_DISABLED
```

---

## 17. Deliverables

At the end of M0 implementation, deliver:

```text
1. implemented M0 tools
2. stable tool interface layer
3. SQLite metadata persistence
4. local media storage
5. fixtures
6. mock provider
7. provider disabled placeholder
8. automated tests
9. demo:m0
10. closeout:m0
11. data/reports/m0_closeout.yaml
12. short implementation summary
13. M0 self-review report
```

Implementation summary:

```yaml
implementation_summary:
  result:
  files_changed:
  commands_run:
  validation:
    test_m0:
    demo_m0:
    closeout_m0:
  known_gaps:
  next_recommended_stage:
```

Self-review:

```yaml
self_review:
  result: PASS | PASS_WITH_GAPS | BLOCK
  hard_gates_reviewed:
    storyboard_image_transfer_gate:
    media_artifact_active_gate:
    storyboard_package_freeze_gate:
    generation_confirmation_gate:
    no_overwrite_gate:
    final_assembly_gate:
  non_goals_respected:
    asset_library_not_implemented:
    memory_loop_not_implemented:
    real_provider_not_required:
    ui_workspace_not_implemented:
  known_shortcuts:
  risks_before_m1:
```

---

## 18. Stop Conditions

Stop and report `BLOCK` if:

```text
1. storyboard image cannot become active Media Artifact even through fixture path
2. storage cannot persist metadata
3. local media files cannot be read after write
4. mock provider cannot produce readable video artifact
5. Storyboard Package cannot be frozen and imported
6. confirmation gates cannot be enforced
7. final video artifact cannot be created
8. path safety cannot be enforced
```

Do not continue by pretending success.

If external image transfer is unavailable but fixture path works, do not block M0.
Report:

```text
external_transfer_path: NOT_TESTED
```

and list it as a known gap.

---

## 19. Final Acceptance Standard

M0 is accepted only if all are true:

```text
1. 9 M0 tools are implemented.
2. tools are exposed through a stable tool interface layer.
3. 6 minimal objects persist.
4. SQLite metadata storage works.
5. local media storage works.
6. fixture storyboard transfer path passes.
7. external transfer path is PASS or explicitly NOT_TESTED.
8. validation scenarios pass.
9. Media Artifact active gate passes.
10. Storyboard Package freeze gate passes.
11. Confirmation gates pass.
12. No overwrite gate passes.
13. Generation Batch / Run status is traceable.
14. revision_needed → regenerate → approved works.
15. final_video artifact is created and readable.
16. get_project_status shows complete project state.
17. npm run test:m0 passes.
18. npm run demo:m0 passes.
19. npm run closeout:m0 writes data/reports/m0_closeout.yaml.
20. closeout report includes validation evidence.
21. self-review report is produced.
```

---

## 20. Final Reminder

Do not optimize for beauty of generated video.

Optimize for:

```text
traceability
persistence
state correctness
artifact availability
reviewability
regeneration safety
repeatable validation
hard-gate enforcement
honest closeout reporting
```

The M0 question is:

> Can GPT-confirmed storyboard images enter the app and move through a complete, auditable video production loop?
