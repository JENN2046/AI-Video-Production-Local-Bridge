# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-22
Repository baseline: `main@4a94cf2d62f3e98923b3166411f13181143d1cbc`

## Accepted historical operations baseline

```text
Package:                  0.1.0-beta.5
MCP service:              webgpt-v4.3.0
Remote App service:       readonly-remote-v1.0.0
Database schema:          workbench-v2-5
Migration ledger:         0008
Snapshot code contract:   readonly-snapshot-v4
Media Gateway code:       readonly-media-gateway-v1.0.0
```

Accepted product states, recorded before the current-main compatibility hold:

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

These states record Jenn's owner-only ChatGPT MCP App and manual Snapshot evidence. They do not accept multi-user production, automatic publishing, Windows auto-start, public media playback or real Provider canary.

## Current-main database compatibility

The active database completed the authorized `workbench-v2-5` / ledger `0008` to `workbench-v2-6` / ledger `0010` migration on 2026-07-22. The gate included a coherent pre-migration backup, isolated migration, read-only `db:check`, normalized core-manifest comparison, post-migration backup and isolated restore rehearsal. All recorded checks passed.

This closes only the database-schema compatibility hold. It does not itself accept a renewed local runtime, Snapshot publish/recovery, Director transport, OAuth configuration, memory integration, Provider execution or any external service change. Runtime startup still never migrates the database automatically.

## Capability matrix

| Capability | Code | Real acceptance | Current decision |
|---|---:|---:|---|
| Workbench V2 local production UI | Current code requires `0010` | Activity database migrated and integrity-checked | Runtime re-acceptance pending |
| Database ledger `0010` and `db:check` | Active database migrated 2026-07-22 | PASS: migration, manifests and restore rehearsal | Current-main compatible |
| Persistent generation/review/delivery boundaries | PASS | Fixture/local acceptance | Provider remains off by default |
| Auth0 owner-only Readonly MCP App | PASS | PASS | Accepted |
| Seven readonly App tools and Workbench panels | PASS | PASS | Accepted |
| Manual Snapshot publish/recovery/freshness | Current exporter requires `0010` | Historical `0008` acceptance; schema hold closed | Renewed publish/recovery acceptance pending |
| Snapshot v4 media bindings | PASS | Not fully external-accepted | Candidate |
| Local Media Gateway runtime | PASS | Local/fixture tests PASS | Candidate |
| Cloudflare media ingress | Configured in part | FAIL/BLOCKED at edge/route startup | Not accepted |
| Real MP4 playback, Range and seek | Prepared | Not yet run successfully | Not accepted |
| Windows media logon task | PASS | Not installed/accepted | Frozen |
| Second real user and revoke path | PASS | Deferred by Jenn | `PARTIAL_MULTI_USER_GATE` |
| Automatic Snapshot synchronization | Not implemented | Not accepted | Future gate |
| Real Provider canary | Boundary exists | Not authorized | Frozen |
| ChatGPT Director PR1–PR6 | Merged local candidate | Database gate PASS; runtime/OAuth/bridge/plugin still unaccepted | `DIRECTOR_EXTERNAL_GATE_PENDING` |

## Accepted evidence

- [SR6 Disposable Database Acceptance](ops/reports/2026-07-13-sr6-disposable-acceptance.md)
- [SR6 Active Database Acceptance](ops/reports/2026-07-13-sr6-active-database-acceptance.md)
- [Beta 4 Active Database Acceptance](ops/reports/2026-07-14-beta4-active-database-acceptance.md)
- [Readonly MCP App Stage 3 Acceptance](ops/reports/2026-07-17-readonly-mcp-app-stage3-acceptance.md)
- [Owner-Only Operations Acceptance](ops/reports/2026-07-18-owner-only-operations-acceptance.md)
- [Snapshot v3 Derived State Acceptance](ops/reports/2026-07-19-snapshot-v3-derived-state-acceptance.md)
- [Snapshot v3 Human Workbench Recovery Acceptance](ops/reports/2026-07-19-snapshot-v3-human-workbench-recovery-acceptance.md)
- [Snapshot Freshness Operations Acceptance](ops/reports/2026-07-19-snapshot-freshness-operations-acceptance.md)
- [Director Active Database Migration Acceptance](ops/reports/2026-07-22-director-active-database-migration-acceptance.md)

Acceptance reports record the commit and boundary that was actually tested. Later code must not silently inherit an older report's PASS.

## Current operations

### Daily local work

The schema gate is closed: the active `data/app.sqlite` is now ledger `0010`. `REAL_PROVIDER_ENABLED=false` remains the safe default. A separate bounded runtime smoke is still required before treating `npm run windows:start` as reaccepted daily operation; do not use schema compatibility as an authorization for Provider work.

### Daily ChatGPT App work

The remote service is memory-only. The schema hold no longer blocks a renewed publish/recovery acceptance, but no Snapshot was published as part of the database migration. Do not treat the migration as a Human Workbench publish, and do not infer automatic publishing; the UI never auto-publishes.

### Media gateway work

PR #56–#62 implemented Snapshot v4 media bindings, encrypted capabilities, local streaming, Widget media UI, Windows operations, Cloudflare diagnostics and selectable `auto|http2|quic` transport. The latest bounded starts still did not establish a verified public media route. Keep Gateway stopped unless performing a separately authorized test. Do not install the current-user logon task yet.

### ChatGPT Director candidate

PR #69–#72 merged the local Director candidate: immutable advisory Proposals, Human Workbench approval, bounded Automation Grants, an isolated local bridge and a disabled-by-default Memory Recall Port. The active database now satisfies its `workbench-v2-6` / ledger `0010` prerequisite; this does **not** alter the accepted Readonly MCP App or the safe default `REAL_PROVIDER_ENABLED=false`.

Director startup requires explicit non-secret runtime configuration and its separate transport acceptance; database readiness alone is insufficient. Do not run `start:director:remote` or `start:director:bridge` as a normal operation yet. The Memory Port has no configured plugin, endpoint, credential or automatic Saveback dispatch. See [Director Local Candidate Closeout](docs/CHATGPT_DIRECTOR_LOCAL_CANDIDATE_CLOSEOUT.md).

## Active blockers and next gates

The isolated MP4 fixture and profile tooling is merged. It is an acceptance input, not a remaining merge gate.

1. Diagnose local network reachability to Cloudflare edge on UDP/TCP 7844 without weakening route or instance binding.
2. Once edge connectivity is proven, use the merged isolated fixture to run one bounded Snapshot playback acceptance: image, MP4, Range/seek, expiration and recovery.
3. Restore a fresh real activity Snapshot after fixture acceptance and prove database manifest unchanged.
4. Only after the above PASS: write a media closeout report and consider `0.1.0-beta.6` version closeout.

Separate, non-blocking future gates are the second real user, automatic Snapshot publishing, Windows automatic startup, Full profile externalization and real Provider canary.

Director has its own ordered external gates and does not inherit acceptance from the Readonly App or media gateway:

1. **PASS:** active-database migration from ledger `0008` to `0010`, with backup, manifest, read-only `db:check`, isolated restore and core-record preservation evidence;
2. separately authorize an isolated Director OAuth/remote/bridge wiring acceptance with `REAL_PROVIDER_ENABLED=false`;
3. prove the owner-only Proposal and approval path against the migrated activity database without Provider execution;
4. select a stable memory plugin and separately accept recall-only, project/issuer-bound integration before any Saveback dispatch;
5. only then consider a bounded Provider execution canary under a separately approved Automation Grant and budget.

## Non-claims

- No npm package, tag or public release has been published.
- `render.yaml` is tracked configuration evidence; it is not proof that the live Render service matches every field.
- Snapshot v4 code does not prove that the currently running remote process holds a v4 Snapshot.
- A created Cloudflare tunnel/DNS record does not prove edge connectivity or media playback.
- Passing fixture tests does not authorize reading the activity database or source media.

See [docs/README.md](docs/README.md) for the current-document index and [docs/PROJECT_LESSONS.md](docs/PROJECT_LESSONS.md) for construction lessons.
