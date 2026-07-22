# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-22
Repository baseline: `main@95c017adfd59543df3e111b56781268f3a6a6e78`

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

## Current-main compatibility hold

`main@95c017a` now requires `workbench-v2-6` / migration ledger `0010` for normal Workbench database opens and new Snapshot exports. Jenn's accepted activity database remains `workbench-v2-5` / ledger `0008`. Therefore the historical baseline above is not a current-main daily-startup or manual-publish authorization.

Do not run `windows:start`, a normal publisher preflight/publish, or Director runtime commands against `data/app.sqlite` on current `main`. Runtime startup never migrates the database automatically. A separate authorized migration gate—backup, isolated `0010` migration, `db:check`, restore drill, normalized-manifest comparison and explicit activity-database authorization—must close first.

## Capability matrix

| Capability | Code | Real acceptance | Current decision |
|---|---:|---:|---|
| Workbench V2 local production UI | Current code requires `0010` | Historical `0008` acceptance | Held pending migration |
| Database ledger `0008` and `db:check` | Accepted historical database | PASS on accepted baseline | Not current-main runtime compatible |
| Persistent generation/review/delivery boundaries | PASS | Fixture/local acceptance | Provider remains off by default |
| Auth0 owner-only Readonly MCP App | PASS | PASS | Accepted |
| Seven readonly App tools and Workbench panels | PASS | PASS | Accepted |
| Manual Snapshot publish/recovery/freshness | Current exporter requires `0010` | Historical `0008` acceptance | Held pending migration |
| Snapshot v4 media bindings | PASS | Not fully external-accepted | Candidate |
| Local Media Gateway runtime | PASS | Local/fixture tests PASS | Candidate |
| Cloudflare media ingress | Configured in part | FAIL/BLOCKED at edge/route startup | Not accepted |
| Real MP4 playback, Range and seek | Prepared | Not yet run successfully | Not accepted |
| Windows media logon task | PASS | Not installed/accepted | Frozen |
| Second real user and revoke path | PASS | Deferred by Jenn | `PARTIAL_MULTI_USER_GATE` |
| Automatic Snapshot synchronization | Not implemented | Not accepted | Future gate |
| Real Provider canary | Boundary exists | Not authorized | Frozen |
| ChatGPT Director PR1–PR6 | Merged local candidate | No runtime, OAuth, bridge, database or plugin acceptance | `DIRECTOR_EXTERNAL_GATE_PENDING` |

## Accepted evidence

- [SR6 Disposable Database Acceptance](ops/reports/2026-07-13-sr6-disposable-acceptance.md)
- [SR6 Active Database Acceptance](ops/reports/2026-07-13-sr6-active-database-acceptance.md)
- [Beta 4 Active Database Acceptance](ops/reports/2026-07-14-beta4-active-database-acceptance.md)
- [Readonly MCP App Stage 3 Acceptance](ops/reports/2026-07-17-readonly-mcp-app-stage3-acceptance.md)
- [Owner-Only Operations Acceptance](ops/reports/2026-07-18-owner-only-operations-acceptance.md)
- [Snapshot v3 Derived State Acceptance](ops/reports/2026-07-19-snapshot-v3-derived-state-acceptance.md)
- [Snapshot v3 Human Workbench Recovery Acceptance](ops/reports/2026-07-19-snapshot-v3-human-workbench-recovery-acceptance.md)
- [Snapshot Freshness Operations Acceptance](ops/reports/2026-07-19-snapshot-freshness-operations-acceptance.md)

Acceptance reports record the commit and boundary that was actually tested. Later code must not silently inherit an older report's PASS.

## Current operations

### Daily local work

**Held on current `main`.** The accepted `data/app.sqlite` is ledger `0008`, while the current Workbench requires `0010`. Do not use `npm run windows:start` as a normal daily action and do not migrate automatically. `REAL_PROVIDER_ENABLED=false` remains the safe default when a separately accepted runtime is eventually started.

### Daily ChatGPT App work

The remote service is memory-only. Existing accepted Snapshot evidence remains historical, but current-main recovery or renewal publishing is held by the same `0010` migration gate. Do not use Human Workbench `系统 → 只读 App 发布` to work around the schema hold. The UI never auto-publishes.

### Media gateway work

PR #56–#62 implemented Snapshot v4 media bindings, encrypted capabilities, local streaming, Widget media UI, Windows operations, Cloudflare diagnostics and selectable `auto|http2|quic` transport. The latest bounded starts still did not establish a verified public media route. Keep Gateway stopped unless performing a separately authorized test. Do not install the current-user logon task yet.

### ChatGPT Director candidate

PR #69–#72 merged the local Director candidate: immutable advisory Proposals, Human Workbench approval, bounded Automation Grants, an isolated local bridge and a disabled-by-default Memory Recall Port. This does **not** alter the accepted Readonly MCP App, the current `workbench-v2-5` / ledger `0008` activity database, or the safe default `REAL_PROVIDER_ENABLED=false`.

Director startup requires a separately accepted `workbench-v2-6` / ledger `0010` database and explicit non-secret runtime configuration. Do not run `start:director:remote` or `start:director:bridge` against the accepted activity database. The Memory Port has no configured plugin, endpoint, credential or automatic Saveback dispatch. See [Director Local Candidate Closeout](docs/CHATGPT_DIRECTOR_LOCAL_CANDIDATE_CLOSEOUT.md).

## Active blockers and next gates

The isolated MP4 fixture and profile tooling is merged. It is an acceptance input, not a remaining merge gate.

1. Diagnose local network reachability to Cloudflare edge on UDP/TCP 7844 without weakening route or instance binding.
2. Once edge connectivity is proven, use the merged isolated fixture to run one bounded Snapshot playback acceptance: image, MP4, Range/seek, expiration and recovery.
3. Restore a fresh real activity Snapshot after fixture acceptance and prove database manifest unchanged.
4. Only after the above PASS: write a media closeout report and consider `0.1.0-beta.6` version closeout.

Separate, non-blocking future gates are the second real user, automatic Snapshot publishing, Windows automatic startup, Full profile externalization and real Provider canary.

Director has its own ordered external gates and does not inherit acceptance from the Readonly App or media gateway:

1. separately authorize active-database migration from ledger `0008` to `0010`, with backup, manifest, `db:check`, isolated restore and rollback evidence;
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
