# R2-0 Human Workbench UX And State Plan

```yaml
result: PASS_UX_STATE_READY
task_id: R2-0_HUMAN_WORKBENCH_UX_STATE_PLAN
created_at: 2026-07-06T21:03:00+08:00
workspace: A:\AI Video Production Workspace
source_plan: legacy/docs/three_routes/source_v1_1/04_R2_HUMAN_WORKBENCH_ROUTE_TASKBOOK.md
provider_boundary:
  network_call_attempted: false
  runway_called: false
  runninghub_called: false
  provider_credits_consumed: false
  real_video_generated: false
  secret_values_exposed: false
blocked_actions_not_performed:
  - source_code_change
  - provider_call
  - video_generation
  - secret_read
  - env_file_edit
  - public_tunnel
  - push
  - tag
  - release
  - deploy
```

## 1. Workbench Scope

Human Workbench is Jenn's local production console. It owns human decisions, visibility, hard-gate confirmation, and report inspection. It is not a provider runner, not a shell surface, not a WebGPT automation tool, and not a public service.

Authority model:

```yaml
human_workbench_can:
  - read app-side truth
  - show blockers and readiness
  - collect explicit human decisions
  - call guarded local app mutations
  - write immutable mutation reports
  - open report history

human_workbench_cannot:
  - call Runway or RunningHub directly
  - bypass provider authorization
  - run shell commands
  - read secret values
  - expose raw .env values
  - accept GPT-invented IDs as truth
  - overwrite source assets
  - publish, deploy, push, tag, or release
```

## 2. Page List

| Phase | Page | Purpose | Current Status |
|---|---|---|---|
| H1 | 总览 / 导入 / 镜头 / 分镜包 / 报告 | WebGPT handoff to app-ready package | implemented MVP |
| H2 | Canary Guard | single-submit provider canary readiness and authorization display | planned |
| H3 | Video Review | generated clip review and regeneration request drafting | planned |
| H4 | Final Assembly | readiness, final assembly confirmation, final artifact report | planned |
| H5 | Memory / Asset | saveback proposal review and asset/reference provenance | planned |

## 3. Page Contracts

### H1 Dashboard

Read state:

- H1 project draft;
- shot approval counts;
- import readiness counts;
- package blockers;
- latest reports;
- provider boundary summary as read-only false flags.

Allowed actions:

- refresh local state;
- navigate to H1 pages;
- open reports.

Hard gates:

- none directly on dashboard.

Blocked actions:

- provider call;
- package freeze;
- source file mutation;
- secret display.

### H1 Imports

Read state:

- `data/imports` basename-only candidate list;
- image readability, dimensions, MIME, aspect ratio, checksum;
- existing app Media Artifact IDs by checksum;
- rejected import list;
- latest import reports.

Allowed actions:

- preview allowlisted PNG/JPEG image;
- validate selected image;
- register selected approved SHOT image as active `image/storyboard_image` Media Artifact;
- reject selected import from storyboard flow.

Hard gates:

- filename must be basename only;
- path must stay inside `data/imports`;
- symlink escape blocked;
- source file must not be overwritten;
- PNG/JPEG only;
- 9:16 vertical image required for storyboard image flow;
- audit, reference, docs, zip, four-panel/contact-sheet, fake IDs, and `PENDING_*` rejected.

Blocked actions:

- arbitrary path read;
- source asset overwrite/delete;
- provider call;
- batch import without explicit later task.

### H1 Shots

Read state:

- H1 shot drafts;
- linked storyboard image artifact status;
- missing fields and blockers;
- approval status.

Allowed actions:

- edit `description`;
- edit `video_prompt`;
- edit `negative_prompt`;
- edit `duration_seconds`;
- link real active storyboard image artifact;
- mark approved;
- mark revision needed.

Hard gates:

- shot must exist;
- linked artifact must be real app artifact ID;
- no `PENDING_*`;
- artifact must be `artifact_type=image`, `role=storyboard_image`, `status=active`;
- approval requires explicit human confirmation.

Blocked actions:

- direct package mutation;
- direct provider call;
- generated clip review.

### H1 Storyboard Package

Read state:

- H1 project draft;
- shot completeness;
- artifact gates;
- latest validation;
- frozen package history;
- latest package report.

Allowed actions:

- run app-side package validation;
- freeze app-ready package after all hard gates pass;
- open frozen package report.

Hard gates:

- every shot approved;
- each shot has active storyboard image artifact ID;
- description, video prompt, duration, and negative prompt string present;
- no fake or `PENDING_*` IDs;
- no raw `data/imports` paths in provider chain;
- `validateG0StoryboardPackage` must pass;
- freeze requires explicit human confirmation.

Blocked actions:

- provider call;
- video generation;
- regeneration;
- final assembly.

### H1 Reports

Read state:

- immutable report history under `data/reports`;
- latest pointer reports;
- provider boundary fields;
- validation summaries.

Allowed actions:

- list reports;
- open report by basename-only allowlist;
- display report JSON.

Hard gates:

- report filename must be basename only;
- `.json` reports only;
- path must stay inside `data/reports`;
- no raw log or secret surfaces.

Blocked actions:

- arbitrary file open;
- report mutation from UI;
- raw provider payload display.

### H2 Canary Guard

Read state:

- active provider summary;
- env check/preflight summary with booleans only;
- selected canary input;
- image dimensions and ratio;
- Runway ratio mapping;
- canary dry-run report;
- authorization requirement text.

Allowed actions:

- generate or refresh dry-run canary plan;
- open dry-run report;
- show exact authorization checklist.

Hard gates:

- no live call without separate current Jenn authorization;
- max submit calls must remain `1`;
- duration must remain `2`;
- project ratio `9:16` maps to Runway `768:1280`;
- secret values never shown;
- dry-run report must mark provider/network/cost/video flags false.

Blocked actions:

- live provider submit;
- regeneration;
- batch generation;
- publishing/deploying.

### H3 Video Review

Read state:

- generated clip artifacts;
- ffprobe validation summary;
- generation runs and batch;
- shot-to-clip version chain;
- previous review decisions.

Allowed actions:

- play or open local generated clip artifact;
- approve clip;
- reject clip with reason;
- create regeneration request draft;
- inspect version history.

Hard gates:

- only app-controlled generated clip artifacts;
- review decision writes immutable report;
- regeneration request is draft until explicit confirmation;
- previous clips are never overwritten.

Blocked actions:

- automatic regeneration;
- provider call without authorization;
- deleting rejected clips.

### H4 Final Assembly

Read state:

- accepted clip per required shot;
- final assembly readiness;
- ffprobe metadata for source clips;
- final video reports.

Allowed actions:

- run readiness check;
- confirm final assembly;
- open final video artifact/report.

Hard gates:

- every required shot has accepted clip;
- source clips are active and readable;
- final assembly requires explicit human confirmation;
- final output must become `final_video` Media Artifact;
- final video ffprobe must pass.

Blocked actions:

- source clip overwrite;
- publishing/deploying;
- assembly before readiness pass.

### H5 Memory / Asset

Read state:

- memory saveback proposal;
- asset/reference candidates;
- provenance;
- previous approve/reject decisions.

Allowed actions:

- approve memory item;
- reject memory item;
- approve asset/reference update;
- open provenance report.

Hard gates:

- no automatic long-term memory write;
- human confirmation required per saveback batch;
- no secrets, provider raw payloads, private logs, or unverified guesses;
- source provenance must be retained.

Blocked actions:

- background memory saveback;
- private-state read;
- generic template pollution with project-specific private material.

## 4. Mutation Report Schema

Every workbench mutation writes or links an immutable report:

```yaml
task: string
action: string
result: PASS | BLOCK_WITH_REASON | FAIL
created_at: iso_timestamp
run_id: uuid_or_stable_run_id
actor: human_workbench
input_summary:
  project_id?: string
  shot_ids?: string[]
  artifact_ids?: string[]
  filenames?: string[]
  requested_action?: string
output_summary:
  artifact_id?: string
  storyboard_package_id?: string
  generation_run_id?: string
  final_video_artifact_id?: string
validation:
  result: PASS | PARTIAL | BLOCK | FAIL | NOT_RUN
  commands?: string[]
hard_gates:
  human_confirmation_required?: boolean
  human_confirmation_present?: boolean
  fake_or_pending_ids_accepted: false
  source_asset_overwritten: false
provider_boundary:
  network_call_attempted: false
  runway_called: false
  runninghub_called: false
  provider_credits_consumed: false
  real_video_generated: false
  secret_values_exposed: false
evidence:
  immutable_report_path?: string
  latest_report_path?: string
```

## 5. Local Server Security Rules

Required defaults for all Human Workbench servers:

```yaml
bind_host: 127.0.0.1
reject_lan: true
public_tunnel_default: forbidden
mutation_nonce_required: true
csrf_boundary: process-local action nonce or stronger
arbitrary_path_input: forbidden
file_read_allowlist:
  - data/imports basename previews
  - data/reports basename JSON reports
shell_commands_from_ui: forbidden
secret_values_from_ui: forbidden
raw_env_values_from_ui: forbidden
provider_call_from_h1: forbidden
```

Additional rules:

- Paths must be resolved and checked against their allowed root.
- Symlinks are blocked for import previews and registration.
- UI may show secret presence booleans only in H2/Higher provider guard pages.
- Long-running provider actions must remain outside H1 and require explicit current authorization.

## 6. No-Provider Boundary

Human Workbench H1 is allowed to prepare a package, not generate video.

```yaml
H1_provider_boundary:
  network_call_attempted: false
  runway_called: false
  runninghub_called: false
  provider_credits_consumed: false
  real_video_generated: false
  regeneration_performed: false
  batch_generation_performed: false
  final_assembly_performed: false
  memory_saveback_performed: false
  secret_values_exposed: false
```

Provider-adjacent visibility starts in H2 as read-only/dry-run by default. Real provider execution must be a separate task with exact current Jenn authorization, provider, input image or package, max submit count, budget/cost bound, and stop condition.

## 7. Next Implementation Notes

- H1 MVP already exists and should be treated as the baseline local workbench.
- H2 should add a Provider Guard / Canary page using existing dry-run reports.
- H3 should add review UI only after package-based generation creates generated clips.
- H4 should stay behind accepted clip readiness gates.
- H5 should produce saveback proposals first; durable memory writes stay separately confirmed.

## 8. Validation

```yaml
git diff --check: PASS
```
