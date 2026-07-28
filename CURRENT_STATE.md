# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-28
Repository baseline: `main@a71c1a9`

## Changes since the last accepted Unified Director deployment

The current source baseline is `main@a71c1a9`. The following merged changes
are later than the exact `479fdb8` Unified Director deployment acceptance.
They have passed the `main` Windows CI and are current code facts, not new
external acceptance or deployment claims:

- PR #94 keeps Director Focus controls visible in the Workbench UI.
- PR #97 adds the managed Windows Director Bridge runtime candidate. Its
  local/fixture coverage passed, but the active Bridge has not been restarted
  under that manager.
- PR #98 adds a local-only Direct OAuth compatibility canary. It is not a
  public HTTPS interoperability experiment and does not change Auth0, Render,
  DNS, environment configuration, or the live Connector.

The last bounded Unified Director deployment acceptance remains the exact
`479fdb8` target recorded in the Unified Director handoff. No deployment or
reconnection has been performed for the later main commits.

## Accepted historical operations baseline

```text
Package:                  0.1.0-beta.5
MCP service:              webgpt-v4.3.0
Remote App service:       readonly-remote-v1.0.0
Database schema:          workbench-v2-6
Migration ledger:         0011
Snapshot code contract:   readonly-snapshot-v4
Media Gateway code:       readonly-media-gateway-v1.0.0
```

Accepted product states, recorded before the current-main compatibility hold:

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
READONLY_MEDIA_GATEWAY_FIXTURE_MP4_PLAYBACK_PASS
```

These states record Jenn's owner-only ChatGPT MCP App, manual Snapshot evidence and one isolated-fixture public MP4 playback path. They do not accept byte-range responses, multi-user production, automatic publishing, Windows auto-start, broad Media Gateway readiness or a real Provider canary.

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
| Snapshot v4 media bindings | PASS | Signed fixture Snapshot accepted during bounded external test | Candidate |
| Local Media Gateway runtime | PASS | Local/fixture tests plus bounded public fixture run PASS | Candidate |
| Cloudflare media ingress | Configured | Bounded fixture route and instance health PASS | Candidate; broad recovery gate remains |
| Real MP4 playback | PASS | ChatGPT Widget fixture playback PASS | `READONLY_MEDIA_GATEWAY_FIXTURE_MP4_PLAYBACK_PASS` |
| Byte-range response / Range seek | Runtime support exists | No `206`/`Content-Range` evidence captured | Not accepted |
| Windows media logon task | PASS | Not installed/accepted | Frozen |
| Second real user and revoke path | PASS | Deferred by Jenn | `PARTIAL_MULTI_USER_GATE` |
| Automatic Snapshot synchronization | Not implemented | Not accepted | Future gate |
| Real Provider canary | Boundary exists | Not authorized | Frozen |
| ChatGPT Director PR1–PR6 + controlled import receipt | Current code | Single-Owner Focus → Context → advisory Proposal → Human Workbench decision → receipt PASS | `DIRECTOR_OWNER_PROPOSAL_PASS` |
| Unified ChatGPT Workspace Remote | Current runtime and contract | Unified OAuth, Bridge, Render, ChatGPT App and activity-database path PASS | `UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_PASS` |
| Director Bridge managed Windows runtime | Current `main` | Implementation and isolated fake-runtime coverage passed; no durable live acceptance receipt, current live Bridge not restarted | Merge complete; awaiting a separately controlled live restart |
| Direct OAuth compatibility canary | Current `main`, local-contract only | Windows CI and local contract coverage passed; no public endpoint experiment | Keep local-only; any public interoperability test needs separate authorization |

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
- [Readonly Media Gateway MP4 Fixture Acceptance](ops/reports/2026-07-27-readonly-media-gateway-mp4-fixture-acceptance.md)
- [Unified Director Wire Contract Acceptance](ops/reports/2026-07-28-unified-director-wire-contract-acceptance.md)

Acceptance reports record the commit and boundary that was actually tested. Later code must not silently inherit an older report's PASS.

## Current operations

### Daily local work

The active database is ledger `0011` and current-code compatible. `REAL_PROVIDER_ENABLED=false` remains the safe default. Schema compatibility and the accepted Director path do not authorize Provider work, automatic Snapshot publishing or production delivery.

### Daily ChatGPT App work

The remote service is memory-only. A Unified signed Snapshot was published during bounded acceptance, but restart or expiry still requires a separately confirmed manual republish. Do not infer automatic publishing from migration or transport acceptance.

### Media gateway work

PR #56–#62 implemented Snapshot v4 media bindings, encrypted capabilities, local streaming, Widget media UI, Windows operations, Cloudflare diagnostics and selectable `auto|http2|quic` transport. PR #91 added the exact ChatGPT Workspace sandbox-origin allowlist required for Widget media requests. A bounded isolated fixture acceptance has now established the public route, signed Snapshot delivery and ChatGPT MP4 playback; the managed default runtime and a fresh real Snapshot were restored afterward. A forward seek remained playable, but no `206`/`Content-Range` was captured, so byte-range is still pending. This is also not a persistence, revocation, recovery-soak, activity-data-unchanged or multi-user acceptance: that fixture sequence recorded only a post-restore read-only `db:check`, not a before/after logical-manifest comparison. Do not install the current-user logon task without separate authorization.

### ChatGPT Director candidate

PR #69–#72 and the controlled Artifact import-receipt work are now accepted through an activity-database single-Owner golden path. The observed path was Focus → Context → advisory Proposal → Human Workbench decision → one immutable, digest-revalidated receipt. This does **not** alter the accepted Readonly MCP App or the safe default `REAL_PROVIDER_ENABLED=false`.

Director startup requires explicit non-secret runtime configuration and its accepted transport configuration; database readiness alone still is not a general authorization. A managed Windows runtime candidate now records the tracked-source commit, emitted `dist` fingerprints, Node executable fingerprint, exact two-argument process identity and a low-disclosure launch-configuration digest. A two-phase activation gate prevents key/database loading before manager adoption; instance-bound heartbeat and completion state support a final `stopped` receipt, while identical completion retries are deduplicated within the Remote broker's bounded five-minute in-memory acceptance window. Expiry or Remote restart makes a later retry unconfirmed again. The default stop path never force-kills. This is not dependency-tree attestation or business-readiness proof, and validation remains local/fixture-only: the currently running Bridge predates this manager and was not restarted. The Memory Port has no configured stable plugin, endpoint or automatic Saveback dispatch. See [Director Local Bridge](docs/CHATGPT_DIRECTOR_LOCAL_BRIDGE.md) and [Director Local Candidate Closeout](docs/CHATGPT_DIRECTOR_LOCAL_CANDIDATE_CLOSEOUT.md).

### Unified ChatGPT Workspace candidate

The single-Connector runtime at `/workspace/mcp` now joins the independently fail-closed Readonly signed-Snapshot chain and Director outbound local-Bridge chain in an accepted bounded deployment. One unified Auth0 resource, minimal user-delegated grant, independent Bridge key, Render path, ChatGPT App, signed Unified Snapshot and activity-database owner path were accepted. `/mcp` remains an accepted rollback surface. See [Unified Workspace Transport Runbook](docs/webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md).

## Active blockers and next gates

The isolated MP4 fixture and profile tooling is merged. Its bounded public playback acceptance is recorded; it is not a full Media Gateway promotion.

1. Record the selected protocol plus the final QUIC/UDP or HTTP2/TCP edge classification, capture an actual byte-range `206`/`Content-Range`, then run the remaining Media Gateway behavioral cases: image and WebM where supported, capability expiration/replay, membership revocation, project switching, and offline/recovery.
2. Separately authorize and validate the current-user Windows logon task.
3. Capture a before/after activity-database logical-manifest comparison for the fixture/restore path, then complete a bounded restart/recovery soak while preserving the manual Snapshot boundary.
4. Only after all Media Gateway gates pass: consider `0.1.0-beta.6` version closeout.

Separate, non-blocking future gates are the second real user, automatic Snapshot publishing, Windows automatic startup, Full profile externalization and real Provider canary.

Director has completed its migration, transport and single-Owner Proposal/receipt gates without Provider execution. Its remaining ordered external gates are:

1. perform one separately authorized controlled local restart of the merged managed Bridge runtime at the intended source commit and emitted-`dist` fingerprint before claiming live managed-process identity or the malformed-Proposal negative path;
2. select and accept a stable Memory plugin with project/issuer-bound recall-only behavior before any Saveback dispatch;
3. separately authorize a bounded Provider execution canary under an Automation Grant and budget;
4. accept a second real user and revoke path before claiming multi-user readiness.

The unified Connector transport gate has passed while retaining legacy `/mcp` as rollback. Its remaining work is the same separately authorized stable Memory, bounded Provider, multi-user and Media Gateway gates; the legacy connector may be audited for removal only after a distinct authorization.

## Non-claims

- No npm package, tag or public release has been published.
- `render.yaml` is tracked configuration evidence; it is not proof that the live Render service matches every field.
- Snapshot v4 code does not prove that the currently running remote process holds a v4 Snapshot.
- A created Cloudflare tunnel/DNS record alone does not prove edge connectivity or media playback; the bounded MP4 fixture report is the only accepted public-playback evidence.
- Passing fixture tests does not authorize reading the activity database or source media.

See [docs/README.md](docs/README.md) for the current-document index and [docs/PROJECT_LESSONS.md](docs/PROJECT_LESSONS.md) for construction lessons.
