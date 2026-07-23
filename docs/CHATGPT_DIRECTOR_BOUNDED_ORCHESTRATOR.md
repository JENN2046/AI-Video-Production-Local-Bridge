# ChatGPT Director Bounded Orchestrator

Status: `CANDIDATE` — PR5 local implementation. The later controlled Artifact import-receipt candidate raises the current code prerequisite to `workbench-v2-6` / ledger `0011`; the activity database remains at separately accepted `0010` and must not run this route until an independent migration gate passes. This does not enable a real Provider, deploy a Director runtime or alter external OAuth configuration.

## Purpose

PR5 separates recorded proposal acceptance from executable authority:

```text
immutable advisory Proposal
  -> human accepts
  -> human compiles an immutable Automation Grant
  -> bounded local preflight and reservation
  -> existing Workbench Generation worker
```

Only `generation_plan` and `clip_regeneration` may compile. Every other Proposal kind fails with `DIRECTOR_PROPOSAL_KIND_NOT_AUTOMATABLE`.

## Compilation boundary

`POST /api/v2/director/proposals/:proposal_id/compile` is local Workbench-only. It requires the existing action nonce and a second `human_confirmation: true`.

Under one SQLite writer transaction it rechecks:

- active production project;
- the Proposal's issuer-bound principal is the exact current sole active owner;
- active membership and immutable owner binding;
- current, unexpired, non-terminal Focus generation;
- accepted terminal Proposal event and absence of an earlier compilation receipt;
- the current authoritative Director target state and `base_state_hash`.

It then writes exactly one immutable `director_automation_grants` row and one `compiled` Proposal event carrying the grant receipt. It does **not** create a Generation Intent, job, run, media Artifact, provider request, or scheduler work.

The fixed Grant contains only RunningHub actions: `generation.submit`, optional `generation.retry`, `generation.download`, and `artifact.activate`. Its policy is JCS/SHA-256 content addressed and bounds total/per-run cost, versions per SHOT, retry count, and a one-minute to twenty-four-hour validity window. A positive retry limit requires `generation.retry`; a zero limit forbids it.

## Execution boundary

`POST /api/v2/director/grants/:grant_id/start` is also local Workbench-only and requires the action nonce plus explicit confirmation. It cannot be reached by ChatGPT, the public Director runtime, the Readonly App, or a generic MCP tool.

Before the existing Workbench provider preflight is allowed to run, the bounded orchestrator requires:

- `REAL_PROVIDER_ENABLED=true` (otherwise `DIRECTOR_AUTOMATION_PROVIDER_DISABLED`);
- an active, unexpired Grant and matching compiled Proposal/policy hash;
- the exact sole owner, active principal binding and active project membership;
- active production project and bound SHOT;
- unchanged authoritative Proposal target state;
- a proposal whose model, duration, resolution and prompts exactly match the current generation inputs;
- existing RunningHub capability, official price/balance and Workbench workflow gates.

The ordinary human confirmation route cannot confirm a Director-prepared intent. The internal Grant path converts the official RunningHub display-unit estimate through the frozen `CNY=100` / `RH_COINS=1` minor-unit table, then reserves that integer amount inside the same transaction that creates the Generation Run and Job. Before the worker submits, it rechecks Grant authority; a successful submission consumes the already-reserved amount even if the Grant expires during the in-flight request, while a pre-submit terminal failure releases it. Reservation and spend events are append-only.

No new generic execution path bypasses the existing Provider capability, price, balance, media-byte, project workflow, budget, lease, reconciliation, or audit boundaries.

An automatic retry is intentionally narrower than a new creative regeneration: it applies only when RunningHub explicitly marks the submission response as retryable **and** confirms no Provider task may exist. The worker revalidates the live Grant before every retry, records one append-only `DIRECTOR_AUTOMATION_SUBMIT_RETRY` job event, uses bounded exponential backoff, and stops at the immutable Grant limit. Any ambiguous submission outcome, known Provider task, authority change, expiry, or retry-limit exhaustion never creates a second paid task automatically; it remains in the existing reconciliation or terminal-failure path.

## Current operational status

The implementation remains a local candidate. The default is `REAL_PROVIDER_ENABLED=false`; local and CI fixtures validate the disabled boundary and immutable Grant/event behavior only. Any real RunningHub call, deployment or external Director/OAuth acceptance requires its separate explicit gate and evidence. The activity-database migration gate is separately recorded as PASS, not as execution acceptance.

## Validation

```text
npm run test:webgpt:director
npm run test:v2:ui
npm run test:selection-gate
```

The Director lane is selected by canonical `npm test` and Windows CI.
