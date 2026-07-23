# Deployment Guide

Status: `SCHEMA_GATE_PENDING`; current-code migration, local startup and publish re-acceptance are pending. It is descriptive; it does not authorize external changes.

## Current-main database compatibility

The active activity database is `workbench-v2-6` / ledger `0010`. Its 2026-07-22 migration passed the separately authorized backup, isolated migration, read-only `db:check`, restore rehearsal and logical-manifest comparison gate. Current code candidates require ledger `0011` for the controlled Artifact import-receipt schema, so the prior acceptance is historical and does not permit startup or Snapshot publishing. A new independently authorized migration gate is required; it must not enable a Provider.

## Deployment layers

Deploy each layer independently. A PASS in one layer does not promote the next.

```text
Layer 1  Local Workbench + ledger 0011 (migration required; runtime re-acceptance pending)
Layer 2  Remote Readonly MCP App + Auth0 + signed Snapshot
Layer 3  Local Media Gateway + Cloudflare ingress (candidate)
Layer 4  Windows automatic startup (frozen)
Layer 5  Real Provider canary (frozen)
```

## Layer 1 — local Workbench (runtime re-acceptance pending)

Prerequisites:

- Windows 10/11;
- Node 22;
- FFmpeg/FFprobe 8.1.2;
- activity database at schema `workbench-v2-6`, ledger `0011`.

Install and validate:

```powershell
npm ci
npm run typecheck
npm run build
npm run db:check -- --read-only
npm run preflight
```

Run these commands only from the verified Git root that owns the accepted activity database; do not hard-code or infer a workspace path from a similarly named clone. `db:check -- --read-only` disables media-activation recovery. The default writable `db:check` belongs only to a separately authorized recovery procedure.

Only when a bounded runtime acceptance is separately authorized, start through `npm run windows:start`. The process must bind only `127.0.0.1:4181`, return `200` for `/healthz` and `/readyz`, and keep real Provider flags false unless a separate canary is authorized.

Database upgrade is not part of normal startup. The active database is below the current-code `0011` requirement, so the migration preflight is an active gate: service stop, backup, logical manifest, isolated migration, `db:check`, restore rehearsal and explicit activity-database authorization.

## Layer 2 — Remote Readonly MCP App

The accepted Auth0/ChatGPT/Render wiring is retained as historical external evidence. The Layer 1 `0010` migration gate is historical, while `0011` remains pending; a new Snapshot export, renewal or recovery from current code needs both the separate migration and its own bounded acceptance.

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

Current external status is CANDIDATE: named tunnel/DNS/key material have been prepared in bounded stages, but recent `auto`/`http2` starts did not prove an instance-bound public route. Real MP4 playback, Range/seek and recovery remain unaccepted.

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
