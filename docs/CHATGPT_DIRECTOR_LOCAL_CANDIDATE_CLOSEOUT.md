# ChatGPT Director Local Candidate Closeout

Status: `CANDIDATE` — local implementation evidence plus historical `0010` activity-database migration evidence. Current controlled import-receipt code requires a separately authorized `0010` → `0011` migration. This document does not accept a running Director service, deploy a remote runtime, configure OAuth or a Memory plugin, call a Provider, or create a production release.

Planning/merge baseline:

```text
main@4a94cf2d62f3e98923b3166411f13181143d1cbc
Active activity database: workbench-v2-6 / ledger 0010 (historical evidence)
Current-code database prerequisite: ledger 0011
Database migration acceptance: 0010 PASS (2026-07-22); 0011 PENDING separate authorization
Provider default: REAL_PROVIDER_ENABLED=false
```

## What is merged

The six local implementation PRs establish a deliberately split authority model:

| Area | Local candidate boundary |
|---|---|
| PR1 — Domain | Immutable Focus, Proposal, Automation Grant and Storyboard Package V2 records; `0009`/`0010` schema and integrity checks. |
| PR2 — Director tools | Five fixed ChatGPT-facing advisory tools with their own resource/scopes; no approval or execution tool is registered. |
| PR3 — Local bridge | Signed outbound-only bridge, issuer/principal/project/Focus checks, bounded frame analysis, and one immutable Proposal write path. |
| PR4 — Human approval | Workbench proposal queue and current single-owner decision checks. A decision is not execution. |
| PR5 — Bounded orchestration | Immutable Grant, reservation/settlement evidence and RunningHub-only execution vocabulary. Provider execution stays disabled. |
| PR6 — Memory Port | Replaceable, project- and issuer-bound advisory recall contract plus a non-dispatched Saveback envelope. The default is data-free `disabled`. |

The resulting intended flow is:

```text
ChatGPT reasoning
  -> advisory immutable Proposal
  -> Human Workbench owner decision
  -> immutable bounded Automation Grant
  -> future separately accepted Local Orchestrator
```

Neither ChatGPT nor a future memory system may silently approve a Proposal, submit a paid job, adopt a clip, finalize delivery, overwrite historical Artifacts or commit long-term memory.

## What this merge does not change

- The accepted Jenn Readonly MCP App remains the only accepted ChatGPT integration.
- The separately accepted `0010` database migration is historical evidence only. It does not satisfy the current `0011` importer gate and does not accept a Director runtime, transport or Provider execution.
- Existing Readonly Snapshot, media-gateway and provider gates retain their documented statuses.
- No Director environment variables, secrets, OAuth resource, bridge key, endpoint, scheduled task, plugin connection or deployment was created by these PRs.
- No actual user or project facts were sent to a memory plugin; no Saveback was dispatched.
- The package remains `0.1.0-beta.5`; this closeout does not create a tag, package publication or release claim.

`start:director:remote` and `start:director:bridge` are code-entry commands, not day-to-day operator commands. They must remain stopped until the remaining transport and external acceptance gates below have passed.

## Required external acceptance order

Each line needs its own current authorization and must leave low-disclosure evidence. A later line never authorizes an earlier one retroactively.

1. **Current-code database readiness — PENDING:** `0010` was backed up, isolated-migrated, read-only `db:check`-checked, manifest-compared, formally migrated and restore-rehearsed on 2026-07-22. It is historical evidence; before any controlled import receipt or current Director workflow, separately authorize `0010` → `0011` backup, isolated migration, read-only `db:check`, manifest comparison and restore rehearsal.
2. **Director transport:** create/configure a distinct OAuth resource and isolated remote/bridge runtime; verify PRMD, tool scopes and challenges with `REAL_PROVIDER_ENABLED=false`. This is not a change to the accepted Readonly App.
3. **Single-owner workflow:** against the `0011`-migrated database, verify Focus, proposal submission, state-drift rejection, owner-only approval and one locally validated import receipt. Do not execute a Provider job.
4. **Memory recall:** select a stable replacement plugin and prove exact issuer/principal/project/proposal-kind binding, cross-project rejection, two-second unavailable fallback and no automatic dispatch. The current plugin discussion is not a configured integration.
5. **Saveback:** separately authorize one observable, user-confirmed dispatch path with a receipt and kill switch. It must remain independent of current production facts.
6. **Bounded execution:** only after the prior gates, separately authorize a single Provider canary with an explicit Grant, currency/budget cap, stop conditions and reconciliation path.

The second real-user/revocation path, automatic Snapshot publishing, Windows automatic startup and public media acceptance remain independent gates; they are not prerequisites for documenting this local candidate, and this local candidate does not close them.

## Local verification surface

The mandatory Director lane is:

```text
npm run test:webgpt:director
npm run test:selection-gate
```

It is selected by canonical `npm test` and Windows CI. The tests cover immutable-record contracts, exact Director tool scopes, signed bridge boundaries, Focus/project/issuer checks, state-drift rejection, bounded Grant accounting and the disabled/fail-closed Memory Port. Passing those tests is necessary local evidence, not a substitute for any external acceptance listed above.

## Operational status vocabulary

Use the following terms precisely:

```text
DIRECTOR_LOCAL_CANDIDATE          code merged and locally testable
DIRECTOR_DATABASE_GATE_0010_HISTORICAL  historical migration evidence only
DIRECTOR_DATABASE_GATE_0011_PENDING     current-code migration and validation not accepted
DIRECTOR_EXTERNAL_GATE_PENDING    Director runtime/OAuth/bridge/plugin acceptance not completed
DIRECTOR_PROVIDER_FROZEN          real Provider execution remains disabled
```

Do not use `production ready`, `Director live`, `memory connected`, `autonomous` or `Provider enabled` until the corresponding evidence exists.
