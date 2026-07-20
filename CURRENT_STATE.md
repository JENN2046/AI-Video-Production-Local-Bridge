# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-21
Repository baseline: `main@ef5e7bee103e404b1aa4ee0cae291e32e02c3976`

## Accepted baseline

```text
Package:                  0.1.0-beta.5
MCP service:              webgpt-v4.3.0
Remote App service:       readonly-remote-v1.0.0
Database schema:          workbench-v2-5
Migration ledger:         0008
Snapshot code contract:   readonly-snapshot-v4
Media Gateway code:       readonly-media-gateway-v1.0.0
```

Accepted product states:

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

These states accept Jenn's owner-only ChatGPT MCP App and manual Snapshot operations. They do not accept multi-user production, automatic publishing, Windows auto-start, public media playback or real Provider canary.

## Capability matrix

| Capability | Code | Real acceptance | Current decision |
|---|---:|---:|---|
| Workbench V2 local production UI | PASS | PASS | Accepted local baseline |
| Database ledger `0008` and `db:check` | PASS | PASS | Accepted activity database |
| Persistent generation/review/delivery boundaries | PASS | Fixture/local acceptance | Provider remains off by default |
| Auth0 owner-only Readonly MCP App | PASS | PASS | Accepted |
| Seven readonly App tools and Workbench panels | PASS | PASS | Accepted |
| Manual Snapshot publish/recovery/freshness | PASS | PASS | Accepted, 24-hour manual operation |
| Snapshot v4 media bindings | PASS | Not fully external-accepted | Candidate |
| Local Media Gateway runtime | PASS | Local/fixture tests PASS | Candidate |
| Cloudflare media ingress | Configured in part | FAIL/BLOCKED at edge/route startup | Not accepted |
| Real MP4 playback, Range and seek | Prepared | Not yet run successfully | Not accepted |
| Windows media logon task | PASS | Not installed/accepted | Frozen |
| Second real user and revoke path | PASS | Deferred by Jenn | `PARTIAL_MULTI_USER_GATE` |
| Automatic Snapshot synchronization | Not implemented | Not accepted | Future gate |
| Real Provider canary | Boundary exists | Not authorized | Frozen |

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

Use `npm run windows:start|status|stop`. The accepted database is `data/app.sqlite` at ledger `0008`. `REAL_PROVIDER_ENABLED=false` remains the safe default.

### Daily ChatGPT App work

The remote service is memory-only. Render Free sleep/restart or Snapshot TTL expiry produces `no_snapshot`; use Human Workbench `系统 → 只读 App 发布` for one explicit preflight/publish. The UI never auto-publishes.

### Media gateway work

PR #56–#62 implemented Snapshot v4 media bindings, encrypted capabilities, local streaming, Widget media UI, Windows operations, Cloudflare diagnostics and selectable `auto|http2|quic` transport. The latest bounded starts still did not establish a verified public media route. Keep Gateway stopped unless performing a separately authorized test. Do not install the current-user logon task yet.

## Active blockers and next gates

1. Merge and validate the isolated MP4 acceptance fixture tooling currently under review.
2. Diagnose local network reachability to Cloudflare edge on UDP/TCP 7844 without weakening route or instance binding.
3. Once edge connectivity is proven, run one bounded fixture Snapshot playback acceptance: image, MP4, Range/seek, expiration and recovery.
4. Restore a fresh real activity Snapshot after fixture acceptance and prove database manifest unchanged.
5. Only after the above PASS: write a media closeout report and consider `0.1.0-beta.6` version closeout.

Separate, non-blocking future gates are the second real user, automatic Snapshot publishing, Windows automatic startup, Full profile externalization and real Provider canary.

## Non-claims

- No npm package, tag or public release has been published.
- `render.yaml` is tracked configuration evidence; it is not proof that the live Render service matches every field.
- Snapshot v4 code does not prove that the currently running remote process holds a v4 Snapshot.
- A created Cloudflare tunnel/DNS record does not prove edge connectivity or media playback.
- Passing fixture tests does not authorize reading the activity database or source media.

See [docs/README.md](docs/README.md) for the current-document index and [docs/PROJECT_LESSONS.md](docs/PROJECT_LESSONS.md) for construction lessons.
