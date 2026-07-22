# ChatGPT Director Human Approval

Status: `CANDIDATE` — PR4 local Workbench implementation. It requires the PR1 `workbench-v2-6` / ledger `0009` schema, but does not migrate the accepted activity database, deploy a Director runtime, configure OAuth or call a Provider.

## Purpose

The Approval Control Tower is the local human boundary between an immutable advisory Director Proposal and the later bounded orchestrator:

```text
ChatGPT Director Proposal
  -> local Workbench approval queue
  -> explicit human confirmation
  -> immutable accepted/rejected event
  -> (later PR5 only) compilation and bounded execution
```

Acceptance is evidence of a local human decision. It is **not** an Automation Grant, a Generation Intent, a storyboard freeze, a Provider submission, clip adoption, delivery confirmation or memory commit.

## Local Workbench controls

The `Director 审批` Workbench area provides:

- an active production-project selector;
- one explicit `Director Focus` target for project, SHOT, active Artifact, generation run, active storyboard package, delivery or memory discussion;
- a bounded Focus lifetime (default 30 minutes; 60 seconds to two hours);
- a proposal queue with immutable payload, content hash and current actionable state;
- explicit accept/reject controls with a confirmation checkbox;
- an unambiguous statement that acceptance merely records a decision.

The local HTTP surface is deliberately narrow:

```text
GET  /api/v2/director/projects/:project_id
POST /api/v2/director/focus
POST /api/v2/director/proposals/:proposal_id/decision
```

Both mutation routes require the existing local Workbench action nonce and `human_confirmation: true`. The response never exposes a principal identifier or issuer hash.

## Fail-closed approval rules

The tower is usable only when the selected active production project has exactly one active, issuer-bound owner. A missing or ambiguous owner returns `DIRECTOR_PRINCIPAL_SELECTION_REQUIRED`; the UI does not guess an actor.

Creating a Focus holds the SQLite writer lock, supersedes the prior non-terminal Focus for that principal, and allocates a new monotonic generation in the same transaction. Cross-project supersession is terminally recorded but does not create an invalid lineage reference.

Before a decision is written, the Workbench holds the writer lock and re-reads all state. It rejects:

- a missing, expired, superseded or generation-mismatched Focus (`DIRECTOR_FOCUS_STALE`);
- a project that was archived or left the production lifecycle after the page loaded (`DIRECTOR_PROJECT_NOT_AVAILABLE`);
- a non-pending Proposal (`DIRECTOR_PROPOSAL_NOT_PENDING`);
- a proposal whose issuer-bound principal or project membership is no longer active (`DIRECTOR_PROPOSAL_PRINCIPAL_INACTIVE`);
- malformed immutable rows (`DIRECTOR_APPROVAL_DATA_INTEGRITY_VIOLATION`);
- an accepted Proposal whose recomputed authoritative target state no longer matches its `base_state_hash` (`DIRECTOR_PROPOSAL_STALE`).

This reuses the same authoritative Director context and target-state validator used by proposal persistence. A late browser tab therefore cannot accept stale content, and two local tabs cannot both record terminal acceptance.

## Data and execution boundary

The queue projects proposal payloads for the local human Workbench only. It does not register an MCP output template, expose a Director Proposal to the Readonly MCP App, or copy business payload into remote logs.

PR4 only appends allowed Focus or Proposal ledger events. It does not create an Automation Grant, generation run or intent; it does not access Provider credentials, media bytes, external memory or activity-database migration paths.

## Validation

The mandatory Director lane includes these PR4 cases:

- confirmed Focus creation and a decision that leaves Automation Grants and Generation Intents at zero;
- superseded Focus and authoritative state drift rejection;
- revoked principal membership rejection without a terminal decision event;
- an archived project rejection after a pending proposal was shown;
- HTTP action-nonce and confirmation enforcement;
- Workbench UI regression coverage proving the page does not initiate a Director execution request during rendering.

Run:

```text
npm run test:webgpt:director
npm run test:v2:ui
npm run test:selection-gate
```

Canonical `npm test` and Windows CI must select the Director lane. External acceptance, activity-database migration, Director OAuth registration and Provider execution remain separate later gates.
