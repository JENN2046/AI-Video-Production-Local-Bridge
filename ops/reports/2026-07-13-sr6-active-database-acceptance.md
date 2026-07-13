# SR6 Active Database Acceptance

Date: 2026-07-13

Result: `PASS_ACTIVE_STAGE_2`

Scope: Jenn-authorized active local database re-acceptance

## Accepted identity

- Package: `0.1.0-beta.3`
- MCP service: `webgpt-v4.1.1`
- Database schema: `workbench-v2-5`
- Acceptance source baseline: `main@77c3282`
- Runtime: Node.js `22.23.1`
- Media tools: FFmpeg `8.1.2`, FFprobe `8.1.2`

## Authorization and isolation boundary

Jenn explicitly authorized backup, migration, integrity checking, isolated
restore, logical consistency comparison, read-only golden-path execution,
restart recovery, and a bounded soak against `data/app.sqlite`.

Provider execution remained disabled throughout:

- `REAL_PROVIDER_ENABLED=false`
- `M1_REAL_PROVIDER_EXECUTION_ALLOWED=false`
- `M1_REAL_PROVIDER_COST_ACK=false`
- `RUNNINGHUB_REAL_SUBMIT=false`

No Auth0, Secure MCP Tunnel, public media endpoint, Windows automatic startup,
external connection, paid API, or Provider call was configured or used.

## Database acceptance

The Workbench was stopped and all target ports were free before migration.
Three consistent backups were retained locally and remain Git-ignored:

- explicit pre-migration backup: `app-2026-07-13T14-36-33-568Z.sqlite`
- automatic `db:migrate` backup: `app-2026-07-13T14-36-40-911Z.sqlite`
- post-migration backup: `app-2026-07-13T14-37-27-297Z.sqlite`

`db:migrate` applied migrations `0005` and `0006`. No legacy inbox or WebGPT
history rows required migration, and no legacy source JSON was written.

The full logical manifest changed only across the expected schema and migration
records:

| Point | Tables | Rows | SHA-256 |
| --- | ---: | ---: | --- |
| Before migration | 23 | 7 | `542decfadc40ea440ad30416c243223caa21ef89741942bb03c142a098a490b7` |
| After migration | 26 | 9 | `03dc1b805adc38e6fcdbc148dbc16453fc1f231f6caaa912a498322e41f0f887` |
| After runtime acceptance | 26 | 9 | `03dc1b805adc38e6fcdbc148dbc16453fc1f231f6caaa912a498322e41f0f887` |

The protected core-business manifest excluded schema metadata and
migration-owned Artifact/Blob/job/activation tables. It remained identical
before and after migration:

```text
table_count=18
row_count=0
sha256=56d6fd3857ba5d9f96b7ba83df9e69ca4903ea43b0f6f1fed47c4aa63e264380
```

The active database and a copy of the post-migration backup both passed
`db:check` with:

- `quick_check=ok`
- current schema
- zero invalid JSON rows
- zero structured drift rows
- zero orphan rows
- zero missing media files
- zero media integrity errors
- zero pending or quarantined media activations
- zero check errors

The active and isolated-restored copies had the same final full manifest.

## Runtime acceptance

`npm run preflight -- --profile=local` passed for Node, FFmpeg, FFprobe,
schema, data/media directories, and port 4181.

The Workbench then completed two independent start/stop cycles against the
migrated active database. Each cycle passed the read-only golden path:

- `/healthz`
- `/readyz`
- Workbench V2 dashboard shell
- dashboard summary
- production-project listing
- governance summary

The second cycle remained under observation for 10 minutes with 20 samples:

- PID and listener ownership remained stable
- every health and readiness response returned HTTP 200
- every readiness check remained true
- working set stayed between 55.86 MB and 70.44 MB
- process CPU increased from 0.453 seconds to 1.531 seconds
- both shutdowns were graceful and port 4181 was released

No intent, job, media grant, project, SHOT, Artifact, or Provider operation was
created. The final database manifest remained identical to the post-migration
manifest.

## Conclusion

SR6 disposable Stage 1 and authorized active-database Stage 2 have both
passed. `0.1.0-beta.3` with `webgpt-v4.1.1` and `workbench-v2-5` is accepted as
Jenn's current local runtime baseline.

This acceptance does not authorize Auth0, Secure MCP Tunnel, public media,
Windows automatic startup, or a real Provider canary. Each remains a separate
future gate.
