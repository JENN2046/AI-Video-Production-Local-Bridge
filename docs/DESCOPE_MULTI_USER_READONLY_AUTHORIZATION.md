# Descope Multi-User Readonly Authorization v1

Status: implemented code boundary; external Descope/ChatGPT/Tunnel cutover not performed
Package: `0.1.0-beta.4`
MCP service: `webgpt-v4.2.0`
Workspace: `jenn-ai-video-workspace`

## Purpose

WebGPT Readonly accepts multiple Descope-authenticated users without storing raw identity claims. Authentication proves the token; local SQLite membership decides which production projects that principal may read. Authentication alone never grants project access.

Full profile remains the legacy local Auth0 lane and is not part of this multi-user release. No write scope, media exposure, Provider call, automatic startup, Tunnel, or public deployment is enabled here.

## Identity and authorization model

- JWT verification requires the configured Descope issuer, resource audience and explicit HTTPS JWKS URI.
- A stable `principal_id` is derived as `SHA256(normalized issuer + NUL + SHA256(subject))`.
- Raw subject, email, token, cookie and Provider payload are never persisted.
- `webgpt_auth_principals` records opaque principals and active/disabled status.
- `webgpt_project_memberships` records `owner | viewer` for one production project and active/revoked status.
- `webgpt_auth_events` is append-only; UPDATE and DELETE fail at the database boundary.
- Owner and viewer currently have the same six read tools. Owner is an administrative bootstrap/readiness role, not a write capability.
- Unauthorized projects use `PROJECT_NOT_FOUND` so callers cannot distinguish nonexistent from unassigned project IDs.

There is no JIT authorization. A valid first login that has not been explicitly registered receives `WEBGPT_PRINCIPAL_NOT_REGISTERED` when it calls a data tool. Registration and membership changes use the local admin command under a separately authorized database-write procedure.

## Readiness and request boundary

Readonly becomes ready only when all of the following are true:

- Descope OAuth configuration is complete;
- migration `0007` and the full schema contract are current;
- the database is readable;
- at least one active principal has an active `owner` membership on a production project.

The owner check is recalculated on every readiness probe and every MCP request. It is not stored in the 30-second schema/database cache, so revoking or disabling the last owner makes `/readyz` and subsequent MCP requests fail closed immediately.

Request admission is bounded to 8 active MCP requests globally and 4 per principal. Rejected requests return HTTP 429, `WEBGPT_REQUEST_BUSY`, `retryable: true`, and `Retry-After: 1`. Every DB-open, app-construction, transport and normal completion path releases its admission slot.

## Migration and admin commands

Migration `0007` creates the authorization tables, constraints, indexes and append-only triggers. Runtime startup only verifies the schema; it does not migrate automatically.

Admin commands require `--db`; omission fails with `INVALID_WEBGPT_AUTH_ADMIN_INPUT`. There is no default activity-database target.

```powershell
npm run auth:webgpt -- bootstrap-owner --db <path> --principal <opaque-sha256> --project <production-project-id>
npm run auth:webgpt:bootstrap-owner -- -DatabasePath <path> -Issuer <https-issuer> -ProjectId <production-project-id>
npm run auth:webgpt -- register --db <path> --principal <opaque-sha256>
npm run auth:webgpt -- grant --db <path> --principal <opaque-sha256> --project <production-project-id> --role owner|viewer
npm run auth:webgpt -- revoke --db <path> --principal <opaque-sha256> --project <production-project-id>
npm run auth:webgpt -- list --db <path>
```

`bootstrap-owner` creates the principal, owner membership and events atomically. It refuses disabled principals and will not overwrite a different existing membership. `grant` requires an active registered principal and a production-classified project. `revoke` preserves the membership record and appends an audit event. `list` returns counts only.

On Windows, `auth:webgpt:bootstrap-owner` is the preferred first-owner path. Its PowerShell wrapper uses `Read-Host -AsSecureString`, sends the subject only through child-process stdin, reuses the runtime issuer normalization and principal derivation, and returns only creation booleans. It never accepts the subject in argv or writes it to the database. Direct `bootstrap-owner-interactive` invocation from a TTY fails closed so an unmasked prompt cannot be mistaken for the supported path.

## Test and CI evidence

The mandatory `test:db` lane covers migration `0007`, schema drift, append-only events, explicit DB selection, owner bootstrap, disabled principals, grants/revocation and cross-project filtering. The `test:webgpt:v4` lane covers Descope JWT verification, readiness, viewer-without-owner failure, immediate owner-revocation failure, MCP project authorization and request admission. Both lanes are selected by canonical `npm test` and the named Windows CI steps.

No test reads Jenn's activity database or calls Descope, ChatGPT, Tunnel, OpenAI, RunningHub or another paid API.

## External gates still closed

- create or select the production Descope project and MCP Server Resource;
- associate an Agentic Client using CIMD first, DCR only as a compatibility fallback, or a public pre-registered client only when required;
- configure exact redirect/callback URLs and ChatGPT app metadata without guessing the callback identifier;
- migrate Jenn's activity database through `0007` under a new explicit authorization;
- derive/register the first production owner without exposing the raw subject;
- start and verify Secure MCP Tunnel;
- complete a real multi-user readonly golden-path acceptance;
- separately decide Full/Auth0, media public HTTPS, Windows automatic startup and real Provider canary.

This document is not external-connection authorization and does not claim deployment readiness.

The exact external object model and gate sequence are defined in [External Multi-User Readonly Connection — Preflight](EXTERNAL_MULTI_USER_READONLY_CONNECTION_PREFLIGHT.md).
