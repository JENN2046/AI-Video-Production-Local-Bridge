# Snapshot Freshness Operations Acceptance

Acceptance date (Asia/Shanghai, UTC+08:00): 2026-07-19

Result: `PASS_SNAPSHOT_FRESHNESS_OPERATIONS`

## Accepted identity

- Source baseline: `main@80cd790773db04ffcf696e46e54a2f552dab703a`
- Package: `0.1.0-beta.5`
- MCP service: `webgpt-v4.3.0`
- Remote App service: `readonly-remote-v1.0.0`
- Snapshot schema: `readonly-snapshot-v3`
- Database schema: `workbench-v2-5`
- Accepted activity-database ledger: `0008`

## Authorization and disclosure boundary

Jenn authorized one bounded real acceptance of the Snapshot freshness operations
surface. The existing Render service was restarted exactly once to clear its
process-local Snapshot. The local Workbench used the accepted activity database
with `REAL_PROVIDER_ENABLED=false` and the existing Git-ignored publisher
profile.

The drill did not deploy code, alter Render configuration, change Auth0, DNS or
the ChatGPT App, enable media or Provider execution, write business data, or
configure Windows automatic start. This report contains no token, cookie,
subject, principal hash, publisher key, private profile value, project or SHOT
identifier, business row, Snapshot body, tool output or Provider payload. It
records fingerprint equality without retaining the fingerprint value.

## Freshness transition acceptance

After the authorized Render restart, the public service stayed alive while
readiness failed closed:

```text
/healthz = 200
/readyz  = 503
snapshot freshness = no_snapshot
stable reason code = SNAPSHOT_NOT_PUBLISHED
Human Workbench action = Restore now
```

The Workbench status refresh remained read-only and explicitly stated that it
would not publish automatically. A temporary signed Snapshot v3 derived through
the readonly activity-database projection was then published with a 90-minute
TTL. It produced the expected bounded renewal state:

```text
/readyz = 200
remote snapshot freshness = fresh
Human Workbench operations state = renewal_due
stable reason code = SNAPSHOT_EXPIRING_SOON
Human Workbench action = Renew now
```

Jenn used the Human Workbench confirmation boundary once. The confirmed action
performed one preflight and one renewal, returned HTTP `202`, and replaced the
canary with the normal 24-hour Snapshot. No retry or second renewal occurred.

After renewal:

```text
/healthz = 200
/readyz  = 200
snapshot freshness = fresh
normal TTL = approximately 24 hours
```

OAuth, publisher-key, Snapshot-freshness and authorization-projection readiness
checks were true. The remote runtime remained database-free and reported that
Provider calls were not allowed.

## ChatGPT MCP App acceptance

The authenticated Jenn owner path exercised the complete readonly surface:

```text
render_ai_video_workspace_app
list_production_projects
get_project_context
list_project_shots
get_review_package
get_delivery_status
get_closeout_evidence
```

All seven calls succeeded. Every result reported one identical Snapshot
fingerprint. Project List, Project Context, Shot Workbench, Review, Delivery and
Closeout panels all opened successfully. No stable tool error was reported, and
the acceptance output was kept low-disclosure.

## Database and CI evidence

The complete activity-database logical manifest was identical before and after
the complete canary-and-renewal drill:

```text
table_count = 30
row_count   = 23
content hash equality = true
```

The final database check returned `PASS`:

- SQLite quick check: `ok`;
- schema current: true;
- invalid JSON, structured drift and orphan rows: 0;
- missing media and media integrity errors: 0;
- pending or quarantined media activations: 0;
- unbound WebGPT authorization rows: 0;
- total check errors: 0.

The previously failed `main@80cd7907` Quality and integration job was rerun once
and passed. Browser smoke and all named Windows CI safety lanes were green.

The local Workbench stopped gracefully, port `4181` was released, and all
Git-ignored temporary canary files and receipts created for this drill were
removed. No tracked workspace change was produced by the runtime acceptance.

## Accepted operations boundary

The following manual owner-only path is now accepted:

```text
no_snapshot
  -> immediate recovery reminder
  -> bounded short-TTL Snapshot
  -> renewal_due
  -> immediate renewal reminder
  -> one Human Workbench confirmation
  -> normal 24-hour Snapshot
  -> seven readonly tools and all Workbench panels restored
```

This proves reminder semantics and the manual renewal path. It does not enable
automatic publishing, scheduled renewal, Windows automatic start, media,
Provider execution or the deferred second-user acceptance.

Accepted status remains:

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

This closeout PR changes documentation only. It does not restart or deploy a
service, create a tag, publish a package, modify a database or change external
configuration.
