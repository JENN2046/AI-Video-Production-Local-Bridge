# Deployment Guide

Status: `UNIFIED_TRANSPORT_AND_SCHEMA_PASS` remains historical, commit-scoped evidence. Canonical source now includes Production Mutation Authority and requires `workbench-v2-8` / ledger `0013`. The activity database's last explicitly accepted runtime boundary remains `workbench-v2-6` / ledger `0011`; current-main activity runtime acceptance is not established. This is descriptive and does not authorize migration, runtime transition, publication or other external changes.

## Current-main source / activity database boundary

Canonical source now requires `workbench-v2-8` / ledger `0013`. The existing activity database remains at its last explicitly accepted boundary, `workbench-v2-6` / ledger `0011`; its separately authorized migrations included backup, isolated migration, read-only `db:check`, restore rehearsal and logical-manifest comparison. Do not start current main against that database as though the new source/runtime combination were already accepted. Runtime never migrates or rolls back the database automatically, and no migration gate enables a Provider. A separate `ACTIVITY_DB_0011_TO_0013_ADMISSION_AND_MIGRATION` operation and runtime acceptance are required before making a current-main compatibility claim.

## Deployment layers

Deploy each layer independently. A PASS in one layer does not promote the next.

```text
Layer 1  Local Workbench (source requires 0013; activity DB last accepted at 0011; current-main runtime not accepted)
Layer 2  Remote Readonly MCP App + Auth0 + signed Snapshot (manual publish/recovery boundary)
Layer 3  Local Media Gateway + Cloudflare ingress (candidate; isolated MP4 fixture playback PASS, byte-range pending)
Layer 4  Windows automatic startup (frozen)
Layer 5  Real Provider canary (frozen)
```

## Layer 1 — local Workbench (historical `0011` bounded path accepted; current-main pending)

Prerequisites:

- Windows 10/11;
- Node 22;
- FFmpeg/FFprobe 8.1.2;
- an activity database admitted for the checked-out source. Canonical current source requires `workbench-v2-8` / ledger `0013`; the existing `workbench-v2-6` / `0011` activity database has not completed that separate admission.

Install and validate:

```powershell
npm ci
npm run typecheck
npm run build
npm run db:check -- --read-only
npm run preflight
```

Run these commands only from the verified Git root that owns the accepted activity database; do not hard-code or infer a workspace path from a similarly named clone. `db:check -- --read-only` disables media-activation recovery. The default writable `db:check` belongs only to a separately authorized recovery procedure.

The historical `0011` Unified activity evidence includes a bounded local start through `npm run windows:start`, manual Snapshot publishing, and the single-Owner Director path. It does not authorize starting current main against the activity database before the separate `0011 → 0013` admission and runtime-acceptance gate. For any later authorized start, preserve the same boundary: bind only `127.0.0.1:4181`, verify `/healthz` and `/readyz`, and keep real Provider flags false unless a separate canary is authorized. A prior bounded PASS does not authorize a persistent runtime, automatic publish or a new external change.

Database upgrade is not part of normal startup. The activity database remains accepted at `0011`, while current source requires `0013`; this source/runtime gap is an admission boundary, not migration authorization. Any future migration requires service stop, backup, logical manifest, isolated migration, `db:check`, restore rehearsal, explicit activity-database authorization and separate runtime acceptance.

## Layer 2A — historical Remote Readonly MCP App

The accepted Auth0/ChatGPT/Render wiring is retained as historical legacy-Readonly evidence. The Layer 1 `0010` migration gate is historical, and the activity runtime's last accepted boundary is `0011`; a new legacy Snapshot export, renewal or recovery still needs its own bounded acceptance and must not weaken the Unified rollback boundary.

The accepted topology is:

```text
ChatGPT App
  -> https://aivideo.skmt617.top/mcp
  -> Auth0 public-client PKCE / projects.read
  -> Render database-free runtime
  -> one signed in-memory Snapshot
```

Required non-secret relationships:

- resource/audience: exact external `/mcp` URL;
- issuer and JWKS: exact Auth0 values;
- registration: `predefined`;
- one public/native ChatGPT client using Authorization Code + PKCE S256;
- API grant: user-delegated `projects.read` only;
- no M2M/default grant.

Required verification material:

- publisher key ID;
- Ed25519 public key in Render secret/config;
- private key protected locally with DPAPI CurrentUser.

Publisher setup and commands are documented in [webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md](webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md).

Important live-runtime fact: the accepted service operates with Render Free behavior, so it can sleep/restart and lose the in-memory Snapshot. `render.yaml` remains tracked configuration evidence and currently names a `starter` plan; do not apply it blindly or treat it as a live-state assertion. Any plan change is a separately authorized external mutation.

Deployment acceptance requires:

1. `/healthz=200`;
2. `/readyz=503` before a Snapshot and `200` only after a valid Snapshot;
3. OAuth 401 challenge, PRMD and security schemes agree;
4. anonymous tool calls succeed zero times;
5. seven readonly tools use one fingerprint;
6. activity-database manifest is unchanged.

## Layer 2B — Unified ChatGPT Workspace candidate

Current `main` also contains the local `Unified Workspace Remote` candidate:

```text
ChatGPT App -> /workspace/mcp
             -> signed Snapshot chain
             -> outbound local Director bridge chain
```

It uses a **new** exact OAuth resource with `projects.read`, `media.read` and `proposals.write`, while preserving old `/mcp` as a rollback surface. The routes must never share a resource URL, audience, publisher key or in-memory Snapshot store. The Remote has no SQLite, local path or Provider execution path.

This layer has completed its bounded external gate: activity database ledger `0011`, Auth0 preflight and one user-delegated grant on the existing Native/public client, a dedicated Bridge key, Render deployment and one ChatGPT App were accepted. Do not treat that result as authorization for a new external change, Provider execution or removal of the legacy rollback route. The exact staged procedure and rollback contract are in [webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md](webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md).

## Layer 3 — Local Media Gateway candidate

Target topology:

```text
Remote Widget
  -> app-only playback tool
  -> encrypted capability request
  -> media.skmt617.top
  -> Cloudflare named tunnel
  -> 127.0.0.1:2092
  -> local Artifact/Blob bytes
```

Implemented controls include Snapshot v4 media bindings, AES-256-GCM capability envelopes, DPAPI CurrentUser secret protection, pinned `cloudflared`, instance-bound public health, bounded hashing, single-use handles, Range streaming and project/membership revalidation.

Current external status is CANDIDATE: named tunnel/DNS/key material and one isolated MP4 fixture have passed instance-bound public routing and ChatGPT Widget playback. The selected protocol was `auto`, but no final QUIC/UDP or HTTP2/TCP classification and no actual `206`/`Content-Range` response were captured; transport attribution and byte-range remain unaccepted along with image/WebM coverage, expiry/replay, revocation, project switching, offline/recovery, Windows startup, soak, and the fixture/restore activity-database before/after logical-manifest comparison.

Port 2092 is mutually exclusive with the legacy local `WEBGPT_V4_PROFILE=full` media listener. Preflight must confirm Full is stopped; do not solve a bind conflict by moving the Gateway to a public interface or weakening listener identity checks.

Do not proceed to playback until:

```powershell
npm run media:preflight
npm run media:start
npm run media:status
```

returns local readiness plus instance-bound public health. `TUNNEL_TRANSPORT_PROTOCOL` may be only `auto`, `http2` or `quic`; protocol selection is diagnostic, not permission to weaken edge checks.

The complete setup and rollback contract is in [webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md](webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md).

## Layer 4 — Windows startup

Local Workbench and Media Gateway Scheduled Tasks are not part of the accepted baseline. Installation changes persistent OS behavior and needs separate authorization. Do not install a task merely because installer code exists.

## Layer 5 — real Provider

Keep:

```text
REAL_PROVIDER_ENABLED=false
M1_REAL_PROVIDER_EXECUTION_ALLOWED=false
M1_REAL_PROVIDER_COST_ACK=false
```

until a priced, bounded canary is explicitly authorized. No deployment or documentation update authorizes a paid call.

## Rollback principles

- Application code: deploy the last accepted commit; do not rewrite history.
- Snapshot: publish a compatible fresh Snapshot after the accepted runtime is restored.
- Database: restore only a verified pre-migration backup; no automatic down migration.
- OAuth: disable a new object/config first; do not delete historical principals, bindings, memberships or events.
- Media: stop Gateway/cloudflared, disable only the new media route/secrets, preserve local media and authorization evidence.
- Windows: remove only the task created by the bounded change.

Never recover availability by enabling anonymous access, widening scope, accepting issuer/audience drift, skipping byte integrity, placing tokens on command lines or making Cloudflare authoritative.

## Release gate

Version closeout requires code CI, external acceptance, activity-database manifest comparison, `db:check`, rollback rehearsal and a committed sanitized report. Code merge alone does not justify `0.1.0-beta.6`, `webgpt-v4.4.0` or `readonly-remote-v1.1.0`.
