# R3-0 Local App Contract Freeze And H1 API Support

```yaml
result: PASS_CONTRACT_READY
task_id: R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
created_at: 2026-07-06T20:38:47+08:00
workspace: A:\AI Video Production Workspace
source_plan: docs/three_routes/THREE_ROUTE_ADAPTED_DISPATCH_v1_1.md
scope: contract-only local app reality review
provider_boundary:
  network_call_attempted: false
  runway_called: false
  runninghub_called: false
  provider_credits_consumed: false
  real_video_generated: false
  secret_values_exposed: false
blocked_actions_not_performed:
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
```

## 1. Current Object And Schema Inventory

The local app is the source of truth. Web GPT, H1 Workbench, and future MCP/Bridge surfaces must treat app-returned IDs and app reports as authoritative.

### SQLite Tables

Defined in `src/storage/sqlite.ts`:

| Table | Purpose | Public Contract Notes |
|---|---|---|
| `m0_meta` | schema metadata | reports current schema version |
| `projects` | project state JSON | source for project readiness/status |
| `shots` | shot state JSON | source for shot status and accepted artifacts |
| `storyboard_packages` | frozen approved package JSON | immutable package truth after import/freeze |
| `media_artifacts` | app-owned media artifact metadata | source for artifact IDs, roles, status, storage |
| `generation_batches` | generation batch metadata | read-only for H1/MCP until provider stage |
| `generation_runs` | generation run metadata | read-only for H1/MCP until provider stage |

### Project / Shot

Defined in `src/tools/projects.ts`.

Required contract:

- `project_id` and `shot_id` are app-generated or app-owned identifiers.
- GPT-supplied fake or `PENDING_*` IDs are not production truth.
- Shot state may reference storyboard image artifacts and generated clips only through real app artifact IDs.

### Media Artifact

Defined in `src/tools/mediaArtifacts.ts`.

Stable shape:

```yaml
MediaArtifact:
  artifact_id: string
  artifact_type: image | video
  role: storyboard_image | generated_clip | final_video
  status: pending_upload | active | inaccessible | expired | archived
  storage:
    uri: local app-controlled path or reference URI
    mime_type: string
    filename: string
  metadata:
    width: number
    height: number
    duration_seconds: number | null
    aspect_ratio: string
    sha256: string
  linked_objects:
    project_id: string
    shot_id: string
  source:
    kind: string
    provider: string
    provider_job_id: string
    sha256: string
    external_url_host: string
```

Hard gates:

- Storyboard Package may use only `artifact_type=image`, `role=storyboard_image`, `status=active`.
- Source media is copied into app-controlled storage before it becomes production truth.
- Direct arbitrary local path input is not part of the H1/WebGPT contract.
- `data/imports` is staging only; provider chains must use Media Artifact storage, not raw import paths.

### Storyboard Package

Defined in `src/tools/storyboardPackages.ts` and `src/tools/g0Pregen.ts`.

Package truth:

- Approved packages freeze shot snapshots.
- Later Shot edits must not mutate frozen package snapshots.
- `validateG0StoryboardPackage` is the app-ready gate for G0 packages.
- `importG0AppReadyStoryboardPackage` is the app-side package import/freeze entry.

Minimum app-ready shot fields:

```yaml
shot_id: string
order: number
duration_seconds: number
storyboard_image_artifact_id: real active app artifact ID
shot_description: string
video_prompt: string
negative_prompt: string
continuity_constraints: string[]
approved_by_user: true
```

### H1 Workbench State

Defined in `src/tools/h1Workbench.ts`.

State file:

```text
data/h1/workbench_state.json
```

Runtime state is local-only and ignored by git. H1 exposes:

- project draft fields;
- shot drafts;
- rejected imports;
- frozen package history.

The current H1 provider boundary object is always false for H1 operations:

```yaml
network_call_attempted: false
runway_called: false
runninghub_called: false
provider_credits_consumed: false
real_video_generated: false
regeneration_performed: false
batch_generation_performed: false
final_assembly_performed: false
memory_saveback_performed: false
source_asset_overwritten: false
secret_values_exposed: false
```

## 2. Existing Tool And Script Inventory

### Package Scripts

Observed in `package.json`:

| Script | Contract Role |
|---|---|
| `test:m0`, `demo:m0`, `closeout:m0` | M0 local mock loop validation |
| `test:m1-0`, `demo:m1-0`, `closeout:m1-0` | external image transfer validation |
| `test:m1`, `demo:m1`, `closeout:m1` | provider boundary and offline M1 checks |
| `runway:canary`, `demo:m1:canary` | strict Runway canary dry-run entry |
| `gpt:handoff:app`, `test:gpt:handoff`, `demo:gpt:handoff` | WebGPT handoff local import/freeze support |
| `g0:r1:import-prep`, `g0:r1:freeze`, `g0:r1:full` | approved WebGPT keyframe artifact/package chain |
| `h1:workbench`, `test:h1` | local Human Operator Workbench |
| `env:check`, `provider:preflight`, `secret:scan` | provider/env/secret boundary validation |
| `test:g0`, `demo:g0`, `closeout:g0` | G0 app-side pregeneration validation |

### Core Tools

| Module | Contract Role |
|---|---|
| `mediaArtifacts.ts` | app-controlled media artifact registration and activation |
| `storyboardPackages.ts` | M0 storyboard package import and frozen snapshots |
| `g0Pregen.ts` | G0 artifact persistence and app-ready package validation/import |
| `gptHandoff.ts` | local WebGPT package scanning and freeze helper |
| `h1Workbench.ts` | H1 state, import, shot, package, report operations |
| `runwayCanary.ts` | strict single-submit canary dry-run plan |
| `providerEnv.ts` | env/preflight/secret scan helpers with redaction |
| `videoProviderAdapters.ts` | provider adapter boundary, Runway ratio mapping, RunningHub placeholder |

## 3. H1 Read Endpoint Draft

Current local server: `scripts/h1-workbench.ts`, bound to `127.0.0.1`.

Read endpoints should remain side-effect-free:

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /api/bootstrap` | nonce, dashboard, state, package, imports, reports | one-shot UI bootstrap |
| `GET /api/dashboard` | dashboard summary | provider boundary included |
| `GET /api/imports` | scanned import candidates | no arbitrary path input |
| `GET /api/shots` | H1 shot drafts | app state only |
| `GET /api/package` | package readiness snapshot | does not run G0 validation |
| `GET /api/reports` | report history metadata | filenames only |
| `GET /api/reports/read?name=<basename.json>` | selected JSON report | basename-only allowlist |
| `GET /imports/<basename>` | validated staged image preview | PNG/JPEG only, no symlink escape |

Read endpoint hard rules:

- localhost only;
- no shell execution;
- no provider calls;
- no secret/env reads;
- no arbitrary filesystem path parameters;
- report reads use basename and reports-root containment.

## 4. H1 Mutation Endpoint Draft

All mutation endpoints require `x-h1-action-nonce`. GPT/MCP must not call these directly in v0.

| Endpoint | App Operation | Required Gate |
|---|---|---|
| `POST /api/imports/register` | `registerH1ApprovedKeyframe` | approved review status, readable 9:16 PNG/JPEG, no audit/reference/four-panel/docs/zip |
| `POST /api/imports/reject` | `rejectH1Import` | local H1 state only |
| `POST /api/shots/update` | `updateH1ShotMetadata` | shot exists |
| `POST /api/shots/link-artifact` | `linkH1ArtifactToShot` | real active image/storyboard artifact, no `PENDING_*` |
| `POST /api/shots/approve` | `markH1ShotApproved` | explicit human confirmation |
| `POST /api/shots/revision-needed` | `markH1ShotRevisionNeeded` | shot exists |
| `POST /api/package/validate` | `validateH1StoryboardPackage` | all shot/package gates checked by app |
| `POST /api/package/freeze` | `freezeH1StoryboardPackage` | explicit human confirmation and validation pass |

Mutation response contract:

```yaml
success:
  ok: true
  state?: H1WorkbenchState
  validation?: H1PackageValidation
  report?: object
failure:
  ok: false
  error:
    code: stable_machine_code
    message: human_readable_message
```

## 5. WebGPT MCP v0 Read Tool Draft

MCP v0 must be read-only. It should call H1/local app read surfaces and return app truth, never infer IDs from chat.

Recommended v0 tools:

| Tool | Maps To | Mutation Allowed |
|---|---|---|
| `get_workspace_status` | package metadata, dashboard summary | no |
| `get_project_status` | `GET /api/dashboard`, projects table summary | no |
| `list_import_candidates` | `GET /api/imports` | no |
| `list_media_artifacts` | app artifact read helper | no |
| `get_media_artifact` | app artifact read helper by real ID | no |
| `get_shot_status` | `GET /api/shots` | no |
| `get_storyboard_package_status` | `GET /api/package` | no |
| `get_latest_reports` | `GET /api/reports` | no |
| `get_provider_readiness_summary` | redacted provider readiness report only | no |

MCP v0 forbidden:

- provider calls;
- shell commands;
- raw `.env`/secret reads;
- raw filesystem reads beyond allowlisted report/status surfaces;
- package freeze;
- media artifact registration;
- source overwrite/delete;
- memory saveback.

## 6. Mutation Report Schema

Every app mutation report must include:

```yaml
task: string
action: string
result: PASS | BLOCK_WITH_REASON | FAIL
run_id: uuid_or_stable_run_id
created_at: iso_timestamp
input_summary:
  filenames?: string[]
  artifact_ids?: string[]
  shot_ids?: string[]
  project_id?: string
output_summary:
  artifact_id?: string
  storyboard_package_id?: string
  report_path?: string
validation:
  commands?: string[]
  result: PASS | PARTIAL | BLOCK | FAIL | NOT_RUN
provider_boundary:
  network_call_attempted: false
  runway_called: false
  runninghub_called: false
  provider_credits_consumed: false
  real_video_generated: false
  secret_values_exposed: false
hard_gates:
  source_asset_overwritten: false
  fake_or_pending_ids_accepted: false
  human_confirmation_required?: true
  human_confirmation_present?: true
evidence:
  immutable_report_path?: string
  latest_report_path?: string
```

Reports must not contain raw secret values, bearer tokens, cookies, private logs, or provider raw payloads.

## 7. Latest Pointer Strategy

Use paired immutable and latest reports:

```yaml
immutable:
  pattern: data/reports/<stem>_<run_id>.json
  purpose: audit history
latest_pointer:
  pattern: data/reports/<stem>.json
  purpose: UI/MCP convenience pointer to the latest immutable result
```

Existing examples:

- `data/reports/m1_5_gpt_handoff_app_freeze_report_<uuid>.json`
- `data/reports/m1_5_gpt_handoff_app_freeze_report.json`
- `data/reports/m1_r0_runway_canary_dry_run_report.json`
- `data/reports/g0_r1_import_prep_result_<uuid>.json`
- `data/reports/g0_r1_import_prep_result.json`
- `data/reports/h1_workbench_package_freeze_result_<uuid>.json`
- `data/reports/h1_workbench_package_freeze_result.json`

H1 and MCP should display latest pointers, but must be able to open immutable history.

## 8. Hard Gate Matrix

| Gate | H1 | MCP v0 | MCP v0.5 Draft | MCP v1 Human Confirmed |
|---|---|---|---|---|
| Read app state | yes | yes | yes | yes |
| Register media artifact | yes with nonce and gates | no | draft request only | request plus human confirm |
| Link artifact to shot | yes with nonce and gates | no | draft proposal only | request plus human confirm |
| Validate storyboard package | yes with nonce | no direct mutation | request only | request plus human confirm |
| Freeze storyboard package | yes with explicit human confirm | no | no | request plus human confirm |
| Run provider | no | no | no | no |
| Generate/regenerate video | no | no | no | no |
| Read secrets/env values | no | no | no | no |
| Shell execution | no | no | no | no |
| Source overwrite/delete | no | no | no | no |
| Public tunnel | no by default | no by default | no by default | no by default |

## 9. Implementation Gaps

Current implementation is strong enough for local H1 and dry-run provider preparation. Remaining gaps for future routes:

- MCP/Bridge server is not implemented.
- MCP v0 read tools are only drafted here.
- Draft submission store is not implemented.
- Pending human action inbox is not implemented.
- H1 UI can read reports, but does not yet provide a polished pending-action review workflow.
- Real provider canary still requires separate current Jenn authorization.
- RunningHub remains selected as a second provider boundary but is not live-integrated in H1.

## 10. Next Implementation Plan

Recommended dependency order:

1. Close R3-0 with this contract as the app-side truth.
2. Re-validate or finish R2-1 H1 Workbench MVP against this contract.
3. Re-validate or finish R3-3 strict Runway canary dry-run report.
4. Complete R1-0 WebGPT MCP boundary plan.
5. Add future tasks for:
   - `R1-1 WebGPT Bridge Read-Only Local API`;
   - `R1-2 Draft Submission Store`;
   - `R1-3 Human Workbench Pending Action Inbox`;
   - `R1-4 Confirmed Action Execution Bridge`.

## 11. Validation

Required validation for this task:

```yaml
git diff --check: PASS
```

This task did not read `.env`, `.env.local`, credentials, private state, raw logs, or provider payloads.
