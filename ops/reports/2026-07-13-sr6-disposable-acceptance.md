# SR6 Disposable Database Acceptance

Date: 2026-07-13

Result: `PASS_DISPOSABLE_STAGE_1`

Scope: synthetic/disposable database only

## Candidate identity

- Package: `0.1.0-beta.3`
- MCP service: `webgpt-v4.1.1`
- Database schema: `workbench-v2-5`
- Runtime: Node.js `22.23.1`
- Media tools: FFmpeg `8.1.2`, FFprobe `8.1.2`

## Isolation boundary

The acceptance used an ignored disposable root under `ops/tools/`. It did not
read, copy, migrate, write, or start a runtime against `data/app.sqlite`.
Provider execution remained disabled throughout:

- `REAL_PROVIDER_ENABLED=false`
- `M1_REAL_PROVIDER_EXECUTION_ALLOWED=false`
- `M1_REAL_PROVIDER_COST_ACK=false`

No Auth0, Secure MCP Tunnel, public media endpoint, Windows automatic startup,
external connection, paid API, or Provider call was configured or used.

## Evidence summary

1. A fresh disposable database migrated through migration IDs `0001`–`0006`.
2. `npm run db:check` passed with `quick_check=ok`, a current schema, and zero
   reported JSON drift, orphan references, media integrity failures, pending
   activations, quarantined activations, or table-constraint failures.
3. A consistent backup was created with SQLite `VACUUM INTO` and restored to a
   separate disposable path.
4. The restored database passed the same `db:check` gate.
5. The Workbench completed two independent Node 22 start/stop cycles. In each
   cycle `/healthz` and `/readyz` returned HTTP 200 and every readiness check
   (`schema`, `database`, `media_directory`, `ffmpeg`, `ffprobe`, `provider`,
   and `worker`) was true.
6. `npm run preflight` passed with Node.js 22.23.1 and FFmpeg/FFprobe 8.1.2.

The normalized logical manifest remained identical before backup, after
isolated restore, and after both runtime cycles:

```text
table_count=26
row_count=9
sha256=5423b16d1345f38ddcede9db97229c14860d325dce076fa2412a9e3cc29548d2
```

This report intentionally contains no business rows, prompts, media, local
paths outside the repository-relative disposable area, raw logs, credentials,
tokens, Provider payloads, or private runtime state.

## Remaining authorization gate

Stage 2 is `BLOCKED_AUTH_REQUIRED`. Before the remediated runtime can become the
accepted local production baseline, Jenn must separately authorize the exact
active-database procedure for `data/app.sqlite`: stop the Workbench, create and
retain a migration backup, migrate, run `db:check`, perform an isolated restore,
exercise the read-only golden path, verify restart recovery, and run a bounded
soak observation.

Until that authorization and acceptance pass, `0.1.0-beta.3` remains a
candidate and the accepted Beta 2 snapshot remains the active-runtime fallback.
