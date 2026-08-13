# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-08-13

Result: `CODE_COMPLETE` for candidate code and synthetic fixtures only.

Product completion: `PARTIAL`. The activity database migration, one authorized
real single-SHOT canary, one complete real production loop, and three real
project acceptances have not occurred. Nothing in this document promotes the
candidate to production-complete status.

Retained package and historical closeout identities:

| Identity | Value |
|---|---|
| Package | `0.1.0-beta.5` |
| MCP service | `webgpt-v4.3.0` |
| Historical owner-only App acceptance | `JENN_SINGLE_USER_MCP_APP_PASS` |
| Historical manual Snapshot boundary | `MANUAL_PUBLISH_OPERATIONAL_READY` |
| Multi-user boundary | `PARTIAL_MULTI_USER_GATE` |

These identifiers preserve their earlier exact acceptance scopes. They do not
authorize activity migration, Snapshot publication, Provider execution or a
new real-production claim for this candidate.

## Repository truth

The accepted mainline remains `origin/main@0785928`. The Human Workbench
completion work is an independent stacked Draft PR series and is not part of
`main`:

| Work package | Branch | Commit | Delivery |
|---|---|---|---|
| 0 Seedance V1.5 Pro | `codex/seedance-v1-5-pro` | `6ab80f2` | Draft PR #121 |
| 1 Workbench operability | `codex/workbench-operability` | `3381969` | Draft PR #122, stacked on WP0 |
| 2 Delivery state foundation | `codex/delivery-state-machine` | `6580b7e` | Draft PR #123, stacked on WP1 |
| 3 Real assembly engine | `codex/real-assembly-engine` | `7616ade` | Draft PR #124, stacked on WP2 |
| 4 Final review/export/closeout | `codex/final-review-export-closeout` | `a3a3290` | Draft PR #125, stacked on WP3 |
| 5 Responsive and WCAG AA | `codex/workbench-responsive-aa` | `7ba8f9b` | Draft PR #126, stacked on WP4 |
| 6 Acceptance and recovery docs | `codex/workbench-acceptance-docs` | candidate HEAD | Review-ready candidate stacked on WP5 |

Each PR must be reviewed in order. Later packages cannot be merged to `main`
before WP0 is accepted as the baseline, and no PR in this series authorizes a
direct push or merge to `main`.

## Product authority and core loop

SQLite remains the only business fact source. The Local Workbench remains the
only surface allowed to acknowledge cost, submit a Provider job, reconcile an
unknown paid result, adopt a clip, approve a final video, export it, or close a
project. ChatGPT and Director are advisory/read boundaries and cannot perform
those decisions.

The candidate implements this owner-controlled loop:

```text
Storyboard
  -> Provider generation
  -> manual reconciliation when outcome is unknown
  -> clip review / targeted regeneration
  -> accepted SHOT clips
  -> FFmpeg assembly
  -> final review / targeted rework
  -> governed local export
  -> explicit closeout
```

## Candidate capability matrix

| Capability | Candidate code fact | Real acceptance boundary |
|---|---|---|
| Provider selection | RunningHub routes include the bounded Seedance V1.5 Pro model, ratio mapping, quote/preflight and UI selection | No paid Provider call was made by this series |
| Manual reconciliation | Sanitized reconciliation items, attach-known-task, continue-known-task and reasoned abandon are available; recovery never submits again | Activity database and paid unknown-result recovery remain untested |
| Review | Version stacks remain visible/clickable at 1920, 1166, 820 and 390×844; generation gates expose a named reason and next action | Real current-path review/regeneration remains S5/S6 evidence |
| Delivery ledger | `workbench-v2-7` / migration `0012` adds state, jobs, append-only events and immutable exports | Activity database remains `workbench-v2-6` / `0011` |
| Assembly | Persistent jobs invoke governed FFmpeg staging, normalize video/audio, validate output and register a new immutable final Artifact | Engine tests and synthetic fixtures pass; no current-path real project assembly has been accepted |
| Final review | Accept, reassemble and selected-SHOT regeneration preserve old clips/final versions | Requires a real assembled Artifact acceptance |
| Export/closeout | Exclusive `.part` export, SHA/FFprobe verification, idempotent reuse, local file route and phrase-gated closeout are implemented | No activity export or new-style closeout has occurred |
| UX/accessibility | Six desktop entries, five-entry mobile navigation with More sheet, responsive Director, keyboard models, focus trapping and axe coverage are implemented | Active pages have fixture-level WCAG 2.2 AA evidence only |

Stable delivery states are:

```text
not_ready | ready_to_assemble | assembling | final_review |
revision_requested | approved | exported | closed |
legacy_review_required
```

Only `closed` projects project to the legacy summary value `delivered`.
Historical `final_approved` projects migrate to `legacy_review_required`; the
migration does not invent approval, export or closeout evidence.

## Database and runtime boundary

The candidate requires `workbench-v2-7` / ledger `0012`. The accepted activity
database remains at `workbench-v2-6` / `0011`. This work did not read, copy,
migrate, restore or start the candidate against the activity database. Runtime
startup never migrates a database automatically.

An isolated synthetic file-level rehearsal now proves:

1. an `0011` source remains unchanged;
2. a coherent backup copy applies only migration `0012`;
3. read-only `db:check` passes after migration;
4. all pre-existing business tables preserve row count and normalized digest;
5. an `0012` backup restores to the same full logical manifest;
6. the pre-migration backup restores as `0011` / `workbench-v2-6`.

This is disposable evidence, not an activity-library copy rehearsal. Reading
or copying the private activity database and formally migrating it each require
their own exact current authorization and named recovery path. See
[Workbench Delivery Recovery](docs/WORKBENCH_DELIVERY_RECOVERY.md).

During this acceptance session, `http://127.0.0.1:4181` is a synthetic fixture
preview and reports healthy/ready. It is deliberately not activity-database,
paid-Provider or real-delivery evidence.

## Verification status

The candidate gates cover typecheck, production build, selection catalog,
foundation/media boundaries, Provider boundaries, database governance,
Workbench V2/API/UI, H1, WebGPT/Director/Unified/Media Gateway contracts,
Windows runtime smokes, Playwright at four viewports, axe, and secret scan.

The acceptance report is
[2026-08-13 Human Workbench code-complete fixture acceptance](ops/reports/2026-08-13-workbench-code-complete-fixture-acceptance.md).
Passing tests prove only the repository and synthetic fixture boundary.

## Remaining acceptance ladder

| Gate | Status | Exact next boundary |
|---|---|---|
| Synthetic migration/restore rehearsal | `PASS` | No activity data was used |
| Synthetic UI/API full-loop fixture | `PASS` | No paid submit or activity write |
| Activity-library copy rehearsal | `BLOCKED_AUTH_REQUIRED` | Name the target, read/copy scope, ignored backup/copy location and rollback path |
| Activity migration `0011` → `0012` | `BLOCKED_AUTH_REQUIRED` | After copy evidence, authorize the exact target, migration, retained backup and rollback |
| S4 real single-SHOT canary | `BLOCKED_AUTH_REQUIRED` | Jenn names Provider, model, Project/SHOT, budget and `max_submit=1`; no automatic retry |
| S5/S6 one real complete loop | `PENDING` | Generation → review → regeneration → assembly → final review → export → closeout |
| S7 three real projects | `PENDING` | Include one multi-SHOT project, one targeted rework and one Grok/Seedance mixed-spec project |

Only S7 completion permits the phrase “产品补完”. Until then the truthful
status is `CODE_COMPLETE` plus `PARTIAL` real acceptance.

## Non-claims

- No activity database or private business row was read, copied or changed.
- No Provider was submitted, polled or charged by this work package.
- No Snapshot was published and no Memory saveback occurred.
- No deployment, release, external upload, tag, protected-branch merge or
  production configuration change occurred.
- No Legacy route was removed or expanded.

See [Product Scope Freeze](docs/PRODUCT_SCOPE_FREEZE.md),
[User Guide](docs/USER_GUIDE.md), and [Documentation Index](docs/README.md).
