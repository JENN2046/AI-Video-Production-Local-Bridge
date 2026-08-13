# Product Scope Freeze

Status: `ACTIVE`

Current accepted mainline: `origin/main@0785928`.

Human Workbench completion candidate: the stacked Draft PR series beginning at
PR #121. It is not part of `main` and does not change this freeze until each
package is reviewed and accepted in order.

This document is the current product-scope source of truth. It freezes
peripheral expansion so current work can complete a repeatable real video
production loop. It does not replace [Current State](../CURRENT_STATE.md),
historical acceptance reports or the architecture contract:

- this document answers what the product is investing in now;
- Current State answers what is currently true;
- exact-commit reports answer what was actually accepted;
- historical taskbooks remain evidence, not current priorities.

## Current P0

The only P0 is:

```text
CURRENT_MAIN_REPEATABLE_PRODUCTION_LOOP

Current Project
  -> Approved Storyboard Package
  -> Provider Generation
  -> Governed Media Artifact
  -> Workbench Review
  -> Regeneration
  -> Accepted Clips
  -> Real Assembly
  -> Final Review / Targeted Rework
  -> Export
  -> Closeout
```

All `READY` work must directly advance one of these stages or protect a safety
boundary that the stage cannot operate without.

## Completion vocabulary

`CODE_COMPLETE` means the candidate implementation and synthetic fixture
gates pass. It does not mean the activity database was migrated or a paid/real
production path was accepted.

“产品补完” is reserved until all of these are complete:

1. activity-library copy rehearsal and authorized `0011` → `0012` migration;
2. one authorized real single-SHOT canary with `max_submit=1`;
3. one real generation → review → regeneration → assembly → final review →
   export → closeout loop;
4. three Jenn-selected real production projects, including multi-SHOT,
   targeted rework and Grok/Seedance mixed specifications.

Until then the product status remains `PARTIAL`, even when code is
`CODE_COMPLETE`.

## Classification rule

Each current component has exactly one primary classification:

- `KEEP_CORE`: directly produces, reviews, regenerates, selects, assembles,
  exports or protects production truth and cost.
- `KEEP_OPTIONAL`: useful experience that cannot block local production.
- `FREEZE`: retain existing code, but add no features or external gates.
- `ROLLBACK_ONLY`: retain only for rollback and security maintenance.
- `REMOVE_LATER`: a future cleanup task after its evidence gate; no deletion is
  authorized now.
- `UNDECIDED`: a bounded future decision with named evidence still missing.

`REMOVE_LATER` and `UNDECIDED` below classify future cleanup or decision tasks,
not the same current component a second time. For example, legacy `/mcp` is
currently `ROLLBACK_ONLY`; its possible future removal is a separate
`REMOVE_LATER` task.

## KEEP_CORE

| Component | Why it is core |
|---|---|
| Local Workbench | Only human decision surface for approval, cost acknowledgement, unknown-task reconciliation, accepted clips, final review, export and closeout |
| SQLite and migration governance | Business fact source, transactional state and recovery evidence |
| Governed Media Store | Keeps bytes, digests, provenance and project ownership trustworthy |
| Project / Shot / Storyboard Package | Defines the production plan and approved generation input |
| Media Artifact / Blob | Governs every input, generated clip and final video |
| Generation Intent / Generation Run | Records budgeted intent, attempts, outcomes and regeneration history |
| Provider adapters | Isolates real Provider contracts behind explicit gates |
| Review / version selection / accepted clip | Preserves old versions and keeps clip adoption human-controlled |
| Assembly / Export / Delivery / Closeout | Produces and records the actual finished video |
| Unified `/workspace/mcp` | Main ChatGPT collaboration entry; it has no independent business authority |
| Unified OAuth resource | Minimum authentication boundary for the Unified entry only |
| Director Local Bridge | Outbound transport for bounded Director work; it has no approval authority |
| Director frame inspection | Model review path using local FFmpeg timestamped frames |
| Human approval and cost acknowledgement | Required authority and paid-call boundary |
| Workbench/Bridge managed-runtime safety controls | Protect process identity and recovery without granting automatic startup |
| Core Workbench, database, media and Provider safety tests | Protect production truth, cost and no-overwrite behavior |

Being core to the complete product does not make a component a prerequisite for
every stage. Unified and Director frame inspection are core collaboration
capabilities, but they are not required for S2, S3 or S4.

## KEEP_OPTIONAL

| Component | Optional role |
|---|---|
| WebGPT readonly projection | Read-only remote access without business authority |
| Remote Readonly App | Optional remote review/status experience |
| Manual signed Snapshot projection | Optional read-only projection; never a fact source |
| Local Media Gateway | Optional human Widget playback |
| Cloudflare media ingress | Optional transport for Media Gateway only |
| Widget media playback | Human playback convenience, not model video understanding |
| Historical acceptance reports | Immutable evidence for their exact commit and scope |

The optional failure rule is:

```yaml
optional_failure:
  blocks_local_workbench: false
  blocks_provider_canary: false
  blocks_generation: false
  blocks_assembly: false
  blocks_export: false
```

Optional components may keep existing security tests and receive security
repairs. Their promotion, convenience work or broader acceptance cannot block
the core Beta.

## FREEZE

The following current or proposed surfaces are frozen:

- WebGPT full new functionality;
- Full profile externalization;
- complete multi-user support;
- second real user golden path;
- automatic Snapshot synchronization;
- Windows automatic logon startup;
- Media Gateway WebM support;
- broad media-format expansion;
- Media Gateway long recovery soak;
- new large Media Gateway acceptance matrices;
- multi-Provider intelligent routing;
- Provider marketplace;
- Provider multi-account management;
- browser API-key editing;
- automatic price comparison;
- automatic Provider failover;
- Provider analytics center;
- automatic Memory Saveback;
- complex Memory Retrieval Policy;
- new OAuth compatibility experiments;
- Direct OAuth external experiments;
- non-core UI expansion.

Freeze means:

```yaml
freeze:
  delete_existing_code: false
  accept_security_fixes: true
  accept_new_features: false
  accept_new_external_gates: false
  blocks_core_beta: false
  blocks_s3: false
  blocks_s4: false
```

The only freeze exceptions are:

- a demonstrated security vulnerability;
- a regression that breaks the current core path;
- a defect that can leak data, cause an unintended paid call or corrupt the
  business fact source.

Experience improvements, format expansion and future compatibility do not
qualify as exceptions.

## ROLLBACK_ONLY

| Surface | Current purpose |
|---|---|
| Legacy `/mcp` | Temporary rollback for the earlier Readonly App route |
| Dedicated `/director/mcp` | Temporary rollback/diagnostic route for Director |
| Legacy OAuth resources | Authenticate only retained rollback routes |
| Legacy Snapshot store | Serve only the retained legacy rollback route |
| Legacy App connection | Preserve bounded rollback while Unified stabilizes |

```yaml
rollback_only:
  new_features: forbidden
  behavior_expansion: forbidden
  compatibility_experiments: forbidden
  security_maintenance: allowed
  removal_now: forbidden
```

## REMOVE_LATER candidates

These are future cleanup tasks, not permissions to delete:

- remove the WebGPT full duplicate execution surface;
- remove standalone Remote routes proven to be duplicated by Unified;
- remove the Dedicated Director route after its observation window;
- remove legacy `/mcp` after Unified stability evidence;
- archive obsolete current-operation taskbooks;
- remove obsolete demo and closeout command surfaces after dependency scans.

Every cleanup requires a separate task, a reviewed dependency scan, a recovery
commit and Jenn's explicit authorization.

## UNDECIDED decisions

| Decision | Evidence required |
|---|---|
| Whether Remote Readonly App remains permanently separate | Existing route usage, value during Bridge unavailability, maintenance cost and Unified replacement coverage |
| Exact removal date of Dedicated Director route | Zero route use, current-version Unified Director coverage, current-version Bridge acceptance and loss-of-diagnostic-value review |
| Exact removal date of legacy `/mcp` | 30 days or two Beta cycles of Unified stability, zero old-audience use and a documented rollback alternative |
| Whether Widget playback provides enough daily value | Existing capability/session usage or manual observation, Jenn's actual playback frequency and comparison with Workbench playback |

Do not build new telemetry for these decisions. Use existing route requests,
existing logs or explicit manual observation.

## Stage dependency rules

```yaml
S2_CORE_LOOP_GAP_AUDIT:
  director_bridge_required: false
  snapshot_required: false
  media_gateway_required: false
  memory_required: false
  multi_user_required: false
S3_PROVIDER_CANARY_READINESS:
  unified_workspace_required: false
  director_bridge_required: false
  snapshot_required: false
  media_gateway_required: false
  memory_required: false
  multi_user_required: false
S4_REAL_SINGLE_SHOT_CANARY:
  unified_workspace_required: false
  director_bridge_required: false
  snapshot_required: false
  media_gateway_required: false
  memory_required: false
  multi_user_required: false
S5_CHATGPT_FRAME_REVIEW:
  director_bridge_required: true
  snapshot_required: false
  media_gateway_required: false
S6_ASSEMBLY_EXPORT_CLOSEOUT:
  director_bridge_required: false
  snapshot_required: false
  media_gateway_required: false
  memory_required: false
```

The current Bridge being `RESTART_REQUIRED` cannot block S2, S3 or S4.

## New-task admission rule

Every proposed task must answer:

```yaml
observed_real_problem:
core_loop_stage:
user_action_reduced:
production_risk_reduced:
maintenance_cost_added:
simpler_alternative:
reason_not_to_defer:
```

If any field lacks a concrete answer, the task defaults to `DEFERRED` or
`FROZEN`.

The following reasons are insufficient by themselves:

- it may be useful later;
- it makes the architecture more complete;
- it supports more users, formats or Providers;
- it adds more automation or settings;
- it makes an already optional test surface more complete.

## Provider scope

The Provider Connections MVP is limited to:

- Provider name;
- Primary / Fallback;
- Configured, Ready, Disabled and Error state;
- capability summary;
- read-only preflight;
- budget status;
- cost acknowledgement status;
- disabling a Provider.

The following are frozen:

- dynamic Provider registration;
- browser secret editing;
- multiple Provider accounts;
- Provider marketplace;
- automatic benchmarking;
- automatic cost comparison;
- automatic routing;
- automatic failover;
- Provider analytics center.

Provider adapters report capabilities and execute only after the existing
authorization, budget and human-confirmation gates. An adapter cannot decide to
execute by itself.

## Route ownership

| Route / surface | Current role | Authority | Classification | Blocks core loop | New features allowed |
|---|---|---|---|---|---|
| Local Workbench | Production and human decision surface | Sole approval, cost, clip adoption and delivery authority | KEEP_CORE | Yes | Only direct core-loop work |
| Unified `/workspace/mcp` | Main ChatGPT collaboration entry | Advisory/read boundary only | KEEP_CORE | No for S2-S4 | Bounded core collaboration only |
| Legacy `/mcp` | Rollback route | No new business authority | ROLLBACK_ONLY | No | Security maintenance only |
| Dedicated `/director/mcp` | Director rollback/diagnostic route | Advisory only | ROLLBACK_ONLY | No | Security maintenance only |
| Director Local Bridge | Outbound context/frame/Proposal transport | Cannot approve, spend, adopt or deliver | KEEP_CORE | Only S5 ChatGPT frame review | Core security and frame-review fixes |
| Remote Readonly App | Optional remote read view | None | KEEP_OPTIONAL | No | Security fixes only during freeze |
| Snapshot publisher | Manual readonly projection | None; Snapshot is not a fact source | KEEP_OPTIONAL | No | Security fixes and bounded maintenance |
| Media Gateway | Optional human media playback | None | KEEP_OPTIONAL | No | Security fixes only during freeze |
| Cloudflare media route | Optional Gateway ingress | None | KEEP_OPTIONAL | No | Security fixes only during freeze |
| WebGPT full | Duplicate remote execution surface | Cannot override Workbench authority | FREEZE | No | No new features |

Widget playback URLs are browser presentation capabilities. They are not the
model video-understanding path; Director frame inspection uses local FFmpeg
frames.

## Duplicate-route exit criteria

### Legacy `/mcp`

Removal requires all of:

1. Unified remains stable for at least two Beta cycles or 30 days;
2. old-route actual use is zero;
3. the old OAuth audience has no real user;
4. a Unified recovery alternative is documented and rehearsed;
5. Jenn separately approves removal.

### Dedicated Director route

Removal requires all of:

1. Unified Director tools cover current needs;
2. Dedicated route use is zero;
3. it no longer provides independent diagnostic value;
4. Unified Bridge has current-version acceptance;
5. Jenn separately approves removal.

### WebGPT full

Removal requires all of:

1. there is no current caller;
2. Workbench and Unified Proposal paths cover actual use;
3. dependency scanning passes;
4. a recoverable historical commit is retained;
5. Jenn separately approves removal.

No route removal, external configuration change or new usage telemetry is
authorized by this policy.
