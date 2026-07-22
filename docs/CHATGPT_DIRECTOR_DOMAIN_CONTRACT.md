# ChatGPT Director Domain Contract

Status: `CANDIDATE` — PR1 implementation contract, not an accepted runtime or activity-database baseline.

## Purpose

The Director route lets ChatGPT prepare bounded production proposals while the local Workbench remains the fact source, approval surface and execution authority.

```text
ChatGPT native conversation
  -> Director proposal
  -> Human Workbench review
  -> explicit approval / Automation Grant
  -> local bounded orchestrator
```

PR1 does not register a Director MCP tool, expose a public OAuth resource, call a Provider, execute a proposal or migrate Jenn's activity database. It establishes the domain and persistence contracts needed by later PRs.

## Fixed authority boundaries

- A Proposal is advisory and immutable. It cannot approve a storyboard, submit a paid generation, adopt a clip, deliver a project or commit memory.
- A Focus identifies the exact principal, project, target and monotonically increasing generation being discussed.
- `base_state_hash` is SHA-256 over RFC 8785/JCS canonical authoritative input. Later compilation must reject drift rather than applying a stale proposal.
- An Automation Grant is an immutable, content-addressed human authorization envelope. Spending and execution are recorded only as append-only events.
- Storyboard Package V2 is a new immutable version object. It never overwrites a legacy Storyboard Package or an earlier V2 version.
- Review assessment remains advice. Human acceptance/rejection is a separate event and later execution gate.
- No OpenAI API, Responses API or Agents SDK call is part of this route. ChatGPT is the user-facing reasoning surface; the local system is the durable executor.

## Schema and migration

Repository-required schema after PR1:

```text
schema: workbench-v2-6
ledger: 0009
```

Migration `0009` creates immutable rows plus append-only event ledgers for:

- Director Focus;
- Director Proposal;
- Automation Grant;
- Storyboard Package V2.

Composite foreign keys bind every Proposal to the same Focus principal, project, target and generation. Parent proposals, superseded focuses and superseded Storyboard packages cannot cross project or principal boundaries. Update/delete triggers protect immutable evidence.

Runtime startup still never migrates a persistent database. Jenn's accepted activity database remains `workbench-v2-5` / `0008` until a separately authorized backup, migration, `db:check`, restore drill and manifest comparison succeeds.

## Contract validation

- Proposal payloads use a strict discriminated union by proposal kind.
- Proposal target type and target ID must agree with the kind-specific payload.
- Proposal ingestion and later compilation use the same target-state validator, which recomputes `base_state_hash` and binds Project, SHOT and Artifact identifiers before accepting the proposal.
- Target-state SHOTs and Artifacts must remain bound to the containing Project/SHOT.
- Optional identifiers and their digests are present or absent together, and media roles must agree with their image/video type.
- Automation Grant actions are unique and limited to the frozen RunningHub execution vocabulary.
- Storyboard Package V2 requires unique SHOT IDs/orders and exact total duration parity.
- Proposal payload, Automation Grant policy and Storyboard Package V2 content hashes are recomputed before acceptance.
- `db:check` counts malformed Director rows as structured drift and never repairs immutable evidence.

## Readonly compatibility

New Snapshot v4 exports require the current `workbench-v2-6` / `0009` pair. The Snapshot v4 parser continues to accept already-signed `workbench-v2-5` / `0008` snapshots so a code deployment does not invalidate an in-memory accepted snapshot before republish. Crossed schema/migration pairs fail closed.

## Test lane

The mandatory lane is:

```text
npm run test:webgpt:director
```

It is selected by canonical `npm test`, Windows CI and `test-selection-gate`. The lane covers deterministic base-state hashing, advisory proposal semantics, Storyboard Package V2, Automation Grant bounds, derived Director state, migration `0009` immutability/FK enforcement and `db:check` drift detection.

## Remaining gates

PR2 freezes the fixed Manual/Native registry and separate Director OAuth resource in [CHATGPT_DIRECTOR_MANUAL_NATIVE_TOOLS.md](CHATGPT_DIRECTOR_MANUAL_NATIVE_TOOLS.md). PR3 implements the isolated authenticated outbound bridge, local authority checks, zero-database-write frame analysis and immutable native Proposal handoff described in [CHATGPT_DIRECTOR_LOCAL_BRIDGE.md](CHATGPT_DIRECTOR_LOCAL_BRIDGE.md). PR4 adds the local approval-tower candidate described in [CHATGPT_DIRECTOR_HUMAN_APPROVAL.md](CHATGPT_DIRECTOR_HUMAN_APPROVAL.md). PR5 adds the local Grant compiler and bounded RunningHub candidate in [CHATGPT_DIRECTOR_BOUNDED_ORCHESTRATOR.md](CHATGPT_DIRECTOR_BOUNDED_ORCHESTRATOR.md). The replaceable memory port and all external acceptance remain later gates. None of these runtime capabilities is claimed as externally operational before its explicit external gate.
