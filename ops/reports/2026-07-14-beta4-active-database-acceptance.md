# Beta 4 Active Database Acceptance

Date: 2026-07-14

Result: `PASS_ACTIVE_DATABASE_ACCEPTANCE`

Scope: Jenn-authorized migration and bounded local runtime acceptance of
`data/app.sqlite`

## Accepted identity

- Package: `0.1.0-beta.4`
- MCP service: `webgpt-v4.2.0`
- Database schema: `workbench-v2-5`
- Migration ledger: `0007`
- Acceptance source baseline: `main@c796c40`
- Runtime: Node.js `22.23.1`
- Media tools: FFmpeg `8.1.2`, FFprobe `8.1.2`

## Authorization and isolation boundary

Jenn explicitly authorized stopping the existing local WebGPT and tunnel
processes, backing up and migrating the activity database, integrity checks,
isolated restore, logical consistency comparison, read-only start/restart and
a bounded soak.

The local WebGPT and tunnel processes were stopped before migration. Workbench
runtime acceptance forced `REAL_PROVIDER_ENABLED=false`; no Provider request,
paid API, Descope/Auth0 change, ChatGPT connector change, Tunnel restart,
public media endpoint, Windows automatic startup, release or deployment was
performed.

## Database acceptance

The following consistent snapshots were retained in the Git-ignored local
backup area:

- explicit pre-migration backup: `app-2026-07-14T08-41-59-196Z.sqlite`
- automatic `db:migrate` backup: `app-2026-07-14T08-42-20-248Z.sqlite`
- post-migration backup: `app-2026-07-14T08-43-26-412Z.sqlite`

`db:migrate` applied only migration `0007`. Legacy inbox and WebGPT history
backfills were no-ops and wrote no legacy source JSON.

The full logical manifest changed only for the three authorization tables and
the `0007` migration ledger row:

| Point | Tables | Rows | SHA-256 |
| --- | ---: | ---: | --- |
| Before migration | 26 | 9 | `03dc1b805adc38e6fcdbc148dbc16453fc1f231f6caaa912a498322e41f0f887` |
| After migration | 29 | 10 | `5cdfca2fd148fbe6f81e98c13eca4ffcaf056ec1c514c156536b633717f37472` |
| Isolated restore | 29 | 10 | `5cdfca2fd148fbe6f81e98c13eca4ffcaf056ec1c514c156536b633717f37472` |
| After runtime acceptance | 29 | 10 | `5cdfca2fd148fbe6f81e98c13eca4ffcaf056ec1c514c156536b633717f37472` |

The business-core manifest excluded `schema_migrations` and the three new
authorization tables. It was identical before migration, after migration, in
the isolated restore and after runtime acceptance:

```text
table_count=25
row_count=3
sha256=c5359363f7cbb813467971cd7ea5bc4f49b03258407df0839e4e519fc31c3080
```

The activity database and isolated restored copy passed `db:check` with:

- `quick_check=ok`
- current schema
- zero invalid JSON rows
- zero structured drift rows
- zero orphan rows
- zero missing media files
- zero media integrity errors
- zero pending or quarantined media activations
- zero check errors

## Runtime acceptance

The Workbench completed two independent starts against the migrated activity
database with Provider execution disabled. Both starts returned HTTP 200 for
`/healthz` and `/readyz`; all readiness checks were true. A read-only V2
project-list request returned HTTP 200. The first process was shut down before
the second start.

The second process remained under observation for 10 minutes with 20 samples:

- PID and port 4181 listener ownership remained stable
- every health and readiness response returned HTTP 200
- every readiness check remained true
- working set stayed between 57.24 MB and 59.77 MB
- process CPU increased from 0.359 seconds to 1.047 seconds
- shutdown was graceful and port 4181 was released

The final `db:check`, full manifest and business-core manifest remained
unchanged after the read-only runtime acceptance.

## Conclusion

`0.1.0-beta.4` with `webgpt-v4.2.0`, schema `workbench-v2-5` and migration
ledger `0007` is accepted as Jenn's current local runtime baseline.

This acceptance does not claim external multi-user readiness. Descope tenant,
ChatGPT connector, first-owner bootstrap, Secure MCP Tunnel, public media,
Windows automatic startup and real Provider canary remain separate closed
gates.
