# State Surface Governance

Status: `ACTIVE_REPOSITORY_GOVERNANCE`

## Governing principle

`ONE FACT → ONE AUTHORITATIVE OWNER`

Other documents may link to or summarize an owned fact when they identify the
authority and do not become an independently maintained state source. Static
architecture, schema, API, migration, security, and operating-command facts
remain in their owning technical documents.

## Authority map

| Fact class | Authoritative owner | Owns | Does not own |
|---|---|---|---|
| Aggregate current operational truth | [`CURRENT_STATE.md`](../CURRENT_STATE.md) | Overall code status, accepted runtime boundary, remaining major gates, recommended next gate, `product_complete` | Exact PR/commit/CI facts or detailed execution receipts |
| Execution truth | [`ops/reports/`](../ops/reports/) | Exact operation, inputs/boundary, result, recovery/side effects, immutable acceptance evidence | The global current state or what should happen next |
| Code delivery truth | GitHub PR, commit, CI, and review | Merge state, exact head/merge commit, CI result, review result, delivery into `main` | Operational acceptance outside its tested boundary |
| Ephemeral agent execution state | Local process or ignored `.agent_board/` | Temporary worker scratch, local locks, transient notes, run-local progress | Repository authority, cross-clone truth, durable evidence, or new scope |

## Current-state contract

`CURRENT_STATE.md` is intentionally thin and must remain at or below 200 lines,
with fewer than 150 preferred. It contains only the current product/code
conclusion, Activity Runtime conclusion, completed and remaining major gates,
the exact recommended next gate, authorization state, bounded non-claims, and
minimal evidence links/provenance.

It must not embed the exact current `main` SHA or mirror a PR/CI ledger. It is
updated only for a major state transition:

- a major code/product gate completes;
- Activity Runtime acceptance changes;
- a real Provider gate changes;
- real production-loop acceptance changes;
- product completion changes;
- a rollback or incident materially changes current reality.

Ordinary commits, review findings, CI retries, local test runs, worker changes,
handoffs, implementation substeps, and PR comments do not update it.

A recommended next gate is descriptive. It never grants an approval that the
operation otherwise requires. `authorization: REQUIRED` means execution must
stop until Jenn explicitly authorizes the exact operation and boundary.

## Immutable execution evidence

`ops/reports/` is `IMMUTABLE_EXECUTION_EVIDENCE`:

- an existing report is not rewritten because current state later changes;
- a historical report retains its original exact boundary;
- later code never retroactively updates an old report;
- a correction uses a new correction or supersession receipt;
- reports do not own the next action or global current project state.

Post-hoc reconciliation must never masquerade as a contemporaneous execution
receipt. If only an operator-accepted closeout exists, current state must name
that provenance and the absence of a repository receipt. A later note must be
clearly labeled as post-hoc reconciliation, not independently rerun evidence.

## Agent coordination

The former committed single-slot queue and ledgers are retired. `.agent_board/`
is root-ignored and may be used only as `LOCAL_EPHEMERAL_AGENT_SCRATCH`.
Scratch filenames and schemas are not contracts; contents may be deleted and
must not override Jenn's instruction, an authorized taskbook or issue,
applicable `AGENTS` instructions, `CURRENT_STATE.md`, reports, or GitHub.

Sustained work must come from an explicit current taskbook, issue/work package,
or a queue explicitly supplied by Jenn. Scratch content and incidental findings
cannot independently create scope or authorize production execution.

## Derived summaries

Allowed:

- a README link saying “current operational status → `CURRENT_STATE.md`”;
- architecture documentation describing the implemented schema contract;
- `CURRENT_STATE.md` naming the source schema and linking to its evidence.

Forbidden:

- different active documents independently naming conflicting next gates;
- a handoff or local scratch file overriding current authorization;
- a committed task, validation, or handoff ledger becoming a second current
  state surface;
- new `CURRENT_STATE.json`, `PROJECT_STATUS.json`, `NEXT_GATE.json`,
  `ACTIVE_TASK.md`, `CURRENT_HANDOFF.md`, or equivalent synchronization loop
  without a separately reviewed executable requirement and architecture
  decision.
