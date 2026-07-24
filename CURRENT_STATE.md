# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-24
Repository baseline: `main@e87be21232ac3772735516c071ffb808fe38830b`

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

## Current-code database compatibility

The active database completed the authorized `workbench-v2-5` / ledger `0008` to `workbench-v2-6` / ledger `0010` migration on 2026-07-22. The gate included a coherent pre-migration backup, isolated migration, read-only `db:check`, normalized core-manifest comparison, post-migration backup and isolated restore rehearsal. All recorded checks passed.

The controlled Artifact import-receipt code candidate adds migration `0011`. Therefore the active `0010` database is historical evidence, not current-code compatible. It does not accept a renewed local runtime, Snapshot publish/recovery, Director transport, OAuth configuration, memory integration, Provider execution or any external service change. Runtime startup still never migrates the database automatically.

## Capability matrix

| Capability | Code | Real acceptance | Current decision |
|---|---:|---:|---|
| Workbench V2 local production UI | Current code candidate requires `0011` | Activity database remains at `0010` | Separate migration required |
| Database ledger `0010` and `db:check` | Active database migrated 2026-07-22 | PASS: migration, manifests and restore rehearsal | Historical evidence only |
| Persistent generation/review/delivery boundaries | PASS | Fixture/local acceptance | Provider remains off by default |
| Auth0 owner-only Readonly MCP App | PASS | PASS | Accepted |
| Seven readonly App tools and Workbench panels | PASS | PASS | Accepted |
| Manual Snapshot publish/recovery/freshness | Current exporter requires `0011` | Historical `0008`/`0010` evidence | Blocked pending separate `0011` migration |
| Snapshot v4 media bindings | PASS | Not fully external-accepted | Candidate |
| Local Media Gateway runtime | PASS | Local/fixture tests PASS | Candidate |
| Cloudflare media ingress | Configured in part | FAIL/BLOCKED at edge/route startup | Not accepted |
| Real MP4 playback, Range and seek | Prepared | Not yet run successfully | Not accepted |
| Windows media logon task | PASS | Not installed/accepted | Frozen |
| Second real user and revoke path | PASS | Deferred by Jenn | `PARTIAL_MULTI_USER_GATE` |
| Automatic Snapshot synchronization | Not implemented | Not accepted | Future gate |
| Real Provider canary | Boundary exists | Not authorized | Frozen |
| ChatGPT Director PR1–PR6 + controlled import receipt | Local code candidate | `0011` migration, runtime/OAuth/bridge/plugin unaccepted | `DIRECTOR_EXTERNAL_GATE_PENDING` |
| Unified ChatGPT Workspace Remote | Local runtime and contract merged | OAuth resource, Bridge key, Render path, ChatGPT App and owner acceptance unexecuted | `UNIFIED_TRANSPORT_EXTERNAL_GATE_PENDING` |

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

The active `data/app.sqlite` is ledger `0010`; the current code candidate requires `0011`. `REAL_PROVIDER_ENABLED=false` remains the safe default. Do not run `npm run windows:start` or use schema compatibility as an authorization for Provider work before a separately authorized `0011` migration and runtime smoke.

### Daily ChatGPT App work

The remote service is memory-only. Current export requires `0011`, while the activity database remains at `0010`; no Snapshot was published as part of the earlier migration. Do not treat either migration as a Human Workbench publish, and do not infer automatic publishing; the UI never auto-publishes.

### Media gateway work

PR #56–#62 implemented Snapshot v4 media bindings, encrypted capabilities, local streaming, Widget media UI, Windows operations, Cloudflare diagnostics and selectable `auto|http2|quic` transport. The latest bounded starts still did not establish a verified public media route. Keep Gateway stopped unless performing a separately authorized test. Do not install the current-user logon task yet.

### ChatGPT Director candidate

PR #69–#72 merged the local Director candidate, and the controlled Artifact import-receipt candidate adds immutable `0011` evidence. The active database remains at `workbench-v2-6` / ledger `0010`; it must not run the new receipt path until separately migrated. This does **not** alter the accepted Readonly MCP App or the safe default `REAL_PROVIDER_ENABLED=false`.

Director startup requires explicit non-secret runtime configuration and its separate transport acceptance; database readiness alone is insufficient. Do not run `start:director:remote` or `start:director:bridge` as a normal operation yet. The Memory Port has no configured plugin, endpoint, credential or automatic Saveback dispatch. See [Director Local Candidate Closeout](docs/CHATGPT_DIRECTOR_LOCAL_CANDIDATE_CLOSEOUT.md).

### Unified ChatGPT Workspace candidate

PR #78 merged the single-Connector local runtime at `/workspace/mcp`. It joins the independently fail-closed Readonly signed-Snapshot chain and the Director outbound local-Bridge chain, while preserving `/mcp` as an accepted rollback surface. No unified Auth0 API, public client grant, Bridge key, Render path deployment, ChatGPT App or Snapshot has been created or published. The active database remains at ledger `0010`, below the current ledger `0011` gate. See [Unified Workspace Transport Runbook](docs/webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md).

## Active blockers and next gates

The isolated MP4 fixture and profile tooling is merged. It is an acceptance input, not a remaining merge gate.

1. Diagnose local network reachability to Cloudflare edge on UDP/TCP 7844 without weakening route or instance binding.
2. Once edge connectivity is proven, use the merged isolated fixture to run one bounded Snapshot playback acceptance: image, MP4, Range/seek, expiration and recovery.
3. Restore a fresh real activity Snapshot after fixture acceptance and prove database manifest unchanged.
4. Only after the above PASS: write a media closeout report and consider `0.1.0-beta.6` version closeout.

Separate, non-blocking future gates are the second real user, automatic Snapshot publishing, Windows automatic startup, Full profile externalization and real Provider canary.

Director has its own ordered external gates and does not inherit acceptance from the Readonly App or media gateway:

1. **PASS (historical):** active-database migration from ledger `0008` to `0010`, with backup, manifest, read-only `db:check`, isolated restore and core-record preservation evidence;
2. separately authorize `0010` to `0011` migration with the same backup, manifest, read-only `db:check` and restore boundary;
3. separately authorize an isolated Director OAuth/remote/bridge wiring acceptance with `REAL_PROVIDER_ENABLED=false`;
4. prove the owner-only Proposal and approval path against the migrated activity database without Provider execution;
5. select a stable memory plugin and separately accept recall-only, project/issuer-bound integration before any Saveback dispatch;
6. only then consider a bounded Provider execution canary under a separately approved Automation Grant and budget.

The unified Connector has an ordered, independent transport gate:

1. read-only Auth0/Render/legacy-Readonly/ChatGPT capability preflight;
2. separately authorize one unified OAuth API and its minimal user-delegated grant, one dedicated Bridge key, a path deployment and one test App;
3. accept the isolated owner Focus → context → advisory Proposal path with `REAL_PROVIDER_ENABLED=false`;
4. after the separately authorized `0011` migration, accept the single-owner activity-database Proposal/decision/import-receipt path;
5. only then evaluate stable Memory recall/saveback and a bounded Provider canary as separate gates.

## Non-claims

- No npm package, tag or public release has been published.
- `render.yaml` is tracked configuration evidence; it is not proof that the live Render service matches every field.
- Snapshot v4 code does not prove that the currently running remote process holds a v4 Snapshot.
- A created Cloudflare tunnel/DNS record does not prove edge connectivity or media playback.
- Passing fixture tests does not authorize reading the activity database or source media.

See [docs/README.md](docs/README.md) for the current-document index and [docs/PROJECT_LESSONS.md](docs/PROJECT_LESSONS.md) for construction lessons.
