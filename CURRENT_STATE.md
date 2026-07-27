# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-27
Repository baseline: `main@c91d1d0`

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

The controlled Artifact import-receipt migration `0011` has since completed its separately authorized activity-database gate: coherent backup, isolated migration, read-only `db:check`, restore rehearsal and logical-manifest comparison. The active database is now current-code compatible at `workbench-v2-6` / ledger `0011`. Runtime startup still never migrates or rolls back the database automatically.

## Capability matrix

| Capability | Code | Real acceptance | Current decision |
|---|---:|---:|---|
| Workbench V2 local production UI | Current code requires `0011` | Activity database compatible at `0011` | PASS within accepted human boundaries |
| Database ledger `0010` and `db:check` | Historical migration evidence | PASS: migration, manifests and restore rehearsal | Historical evidence retained |
| Database ledger `0011` and `db:check` | Current code schema | PASS: authorized migration, manifests and restore rehearsal | Current activity database gate passed |
| Persistent generation/review/delivery boundaries | PASS | Fixture/local acceptance | Provider remains off by default |
| Auth0 owner-only Readonly MCP App | PASS | PASS | Accepted |
| Seven readonly App tools and Workbench panels | PASS | PASS | Accepted |
| Manual Snapshot publish/recovery/freshness | Current exporter requires `0011` | Unified bounded publish accepted; remote remains memory-only | Manual, not automatic |
| Snapshot v4 media bindings | PASS | Not fully external-accepted | Candidate |
| Local Media Gateway runtime | PASS | Local/fixture tests PASS | Candidate |
| Cloudflare media ingress | Configured in part | FAIL/BLOCKED at edge/route startup | Not accepted |
| Real MP4 playback, Range and seek | Prepared | Not yet run successfully | Not accepted |
| Windows media logon task | PASS | Not installed/accepted | Frozen |
| Second real user and revoke path | PASS | Deferred by Jenn | `PARTIAL_MULTI_USER_GATE` |
| Automatic Snapshot synchronization | Not implemented | Not accepted | Future gate |
| Real Provider canary | Boundary exists | Not authorized | Frozen |
| ChatGPT Director PR1–PR6 + controlled import receipt | Current code | Single-Owner Focus → Context → advisory Proposal → Human Workbench decision → receipt PASS | `DIRECTOR_OWNER_PROPOSAL_PASS` |
| Unified ChatGPT Workspace Remote | Current runtime and contract | Unified OAuth, Bridge, Render, ChatGPT App and activity-database path PASS | `UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_PASS` |

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
- [Unified Director Activity Acceptance](ops/reports/2026-07-27-unified-director-activity-acceptance.md)

Acceptance reports record the commit and boundary that was actually tested. Later code must not silently inherit an older report's PASS.

## Current operations

### Daily local work

The active database is ledger `0011` and current-code compatible. `REAL_PROVIDER_ENABLED=false` remains the safe default. Schema compatibility and the accepted Director path do not authorize Provider work, automatic Snapshot publishing or production delivery.

### Daily ChatGPT App work

The remote service is memory-only. A Unified signed Snapshot was published during bounded acceptance, but restart or expiry still requires a separately confirmed manual republish. Do not infer automatic publishing from migration or transport acceptance.

### Media gateway work

PR #56–#62 implemented Snapshot v4 media bindings, encrypted capabilities, local streaming, Widget media UI, Windows operations, Cloudflare diagnostics and selectable `auto|http2|quic` transport. The latest bounded starts still did not establish a verified public media route. Keep Gateway stopped unless performing a separately authorized test. Do not install the current-user logon task yet.

### ChatGPT Director candidate

PR #69–#72 and the controlled Artifact import-receipt work are now accepted through an activity-database single-Owner golden path. The observed path was Focus → Context → advisory Proposal → Human Workbench decision → one immutable, digest-revalidated receipt. This does **not** alter the accepted Readonly MCP App or the safe default `REAL_PROVIDER_ENABLED=false`.

Director startup requires explicit non-secret runtime configuration and its accepted transport configuration; database readiness alone still is not a general authorization. The Memory Port has no configured stable plugin, endpoint or automatic Saveback dispatch. See [Director Local Candidate Closeout](docs/CHATGPT_DIRECTOR_LOCAL_CANDIDATE_CLOSEOUT.md).

### Unified ChatGPT Workspace candidate

The single-Connector runtime at `/workspace/mcp` now joins the independently fail-closed Readonly signed-Snapshot chain and Director outbound local-Bridge chain in an accepted bounded deployment. One unified Auth0 resource, minimal user-delegated grant, independent Bridge key, Render path, ChatGPT App, signed Unified Snapshot and activity-database owner path were accepted. `/mcp` remains an accepted rollback surface. See [Unified Workspace Transport Runbook](docs/webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md).

## Active blockers and next gates

The isolated MP4 fixture and profile tooling is merged. It is an acceptance input, not a remaining merge gate.

1. Diagnose local network reachability to Cloudflare edge on UDP/TCP 7844 without weakening route or instance binding.
2. Once edge connectivity is proven, use the merged isolated fixture to run one bounded Snapshot playback acceptance: image, MP4, Range/seek, expiration and recovery.
3. Restore a fresh real activity Snapshot after fixture acceptance and prove database manifest unchanged.
4. Only after the above PASS: write a media closeout report and consider `0.1.0-beta.6` version closeout.

Separate, non-blocking future gates are the second real user, automatic Snapshot publishing, Windows automatic startup, Full profile externalization and real Provider canary.

Director has completed its migration, transport and single-Owner Proposal/receipt gates without Provider execution. Its remaining ordered external gates are:

1. select and accept a stable Memory plugin with project/issuer-bound recall-only behavior before any Saveback dispatch;
2. separately authorize a bounded Provider execution canary under an Automation Grant and budget;
3. accept a second real user and revoke path before claiming multi-user readiness.

The unified Connector transport gate has passed while retaining legacy `/mcp` as rollback. Its remaining work is the same separately authorized stable Memory, bounded Provider, multi-user and Media Gateway gates; the legacy connector may be audited for removal only after a distinct authorization.

## Non-claims

- No npm package, tag or public release has been published.
- `render.yaml` is tracked configuration evidence; it is not proof that the live Render service matches every field.
- Snapshot v4 code does not prove that the currently running remote process holds a v4 Snapshot.
- A created Cloudflare tunnel/DNS record does not prove edge connectivity or media playback.
- Passing fixture tests does not authorize reading the activity database or source media.

See [docs/README.md](docs/README.md) for the current-document index and [docs/PROJECT_LESSONS.md](docs/PROJECT_LESSONS.md) for construction lessons.
