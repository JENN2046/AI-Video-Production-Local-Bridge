# Director Active Database Migration Acceptance

Date: 2026-07-22
Repository baseline: `main@4a94cf2d62f3e98923b3166411f13181143d1cbc`
Scope: active database schema migration only

## Authorized scope

The activity database was authorized to move from `workbench-v2-5` / ledger `0008` to `workbench-v2-6` / ledger `0010`.

The operation did not start a Workbench, Director runtime, Gateway or Tunnel; it did not publish a Snapshot; and it did not alter Auth0, Render, DNS, ChatGPT, Provider, media or automatic-start configuration.

## Evidence summary

| Check | Result |
|---|---|
| Relevant local service ports released before migration | PASS |
| Node 22 build of current code | PASS |
| Coherent migration-pre backup | PASS |
| Isolated `0008` to `0010` migration | PASS (`0009`, `0010` applied) |
| Isolated read-only `db:check` | PASS |
| Isolated post-migration backup and restore rehearsal | PASS |
| Isolated normalized core-record manifest comparison | PASS |
| Formal active-database migration | PASS (`0009`, `0010` applied) |
| Formal active-database read-only `db:check` | PASS |
| Formal post-migration backup and restore rehearsal | PASS |
| Formal normalized core-record manifest comparison | PASS |

The final read-only check reported current schema, `quick_check=ok`, and zero invalid JSON, structured drift, orphan, missing-media, media-integrity, pending-activation, quarantined-activation, unbound-authorization and check-error counts.

Migration pre- and post-backups remain in Git-ignored local storage. This report intentionally records no backup paths, database rows, identifiers, hashes, subjects, tokens, credentials or business content.

## Resulting boundary

`data/app.sqlite` now satisfies the current-main `workbench-v2-6` / ledger `0010` schema prerequisite for the Workbench, readonly exporter and Director candidate.

This is not a runtime, OAuth, Snapshot publish/recovery, Director transport, Memory plugin, media, Provider or production-readiness acceptance. The next Director gate remains an explicitly authorized, `REAL_PROVIDER_ENABLED=false` transport/bridge acceptance.
