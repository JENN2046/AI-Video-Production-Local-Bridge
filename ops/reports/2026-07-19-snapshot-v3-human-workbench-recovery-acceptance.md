# Snapshot v3 Human Workbench Recovery Acceptance

Acceptance date (Asia/Shanghai, UTC+08:00): 2026-07-19

Result: `PASS_HUMAN_WORKBENCH_SNAPSHOT_V3_RECOVERY`

## Accepted identity

- Source baseline: `main@d4c7d8cf52d52e3a28293180a771d3b36f6e399f`
- Package: `0.1.0-beta.5`
- MCP service: `webgpt-v4.3.0`
- Remote App service: `readonly-remote-v1.0.0`
- Snapshot schema: `readonly-snapshot-v3`
- Database schema: `workbench-v2-5`
- Accepted activity-database ledger: `0008`

## Authorization and disclosure boundary

Jenn authorized a real Snapshot v3 Human Workbench recovery drill. The existing
Render service was restarted only to clear its in-memory Snapshot. No deploy,
configuration edit, DNS change, Auth0 change or ChatGPT App change was made.

The local Workbench used the accepted activity database with
`REAL_PROVIDER_ENABLED=false` and the existing Git-ignored publisher profile.
The drill did not enable media, a write tool, Provider execution, automatic
publishing or Windows automatic start.

This report contains no OAuth subject, token, cookie, principal hash, publisher
key, private profile value, project identifier, project title, database business
row, Snapshot body, tool output or Provider payload. It does not retain the
Snapshot fingerprint value; it records only equality between the accepted
surfaces.

## Recovery sequence

Before the drill, the remote service was healthy and held a fresh Snapshot v3.
The authorized Render restart cleared that process-local state. The public
service then reported:

```text
/healthz = 200
/readyz  = 503
snapshot freshness = no_snapshot
snapshot fingerprint = absent
```

The repository-managed Windows Workbench launcher started a local Workbench on
Node `22.23.1`. Its health and readiness probes returned HTTP `200`, the Provider
lane remained disabled, and no automatic-start configuration was created.

In `System -> Readonly App Publish`, the Human Workbench displayed the remote
service as `Not ready` and the Snapshot as unpublished. Jenn's recovery action
then used the actual UI boundary:

1. select `Preflight and publish`;
2. review the explicit readonly/DPAPI/HTTPS replacement confirmation;
3. select `Confirm preflight and publish` exactly once.

The Workbench returned `PASS`, HTTP `202`, and a sanitized successful receipt.
No retry or second publish action occurred.

## Restored service acceptance

After the one-click action:

```text
/healthz = 200
/readyz  = 200
snapshot freshness = fresh
```

OAuth, publisher key, Snapshot freshness and authorization projection readiness
checks were all true. The Snapshot had the expected approximately 24-hour TTL.
The Workbench receipt, remote readiness and all ChatGPT tools reported one
identical Snapshot fingerprint.

The authenticated Jenn owner path restored the complete MCP App surface:

```text
render_ai_video_workspace_app
list_production_projects
get_project_context
list_project_shots
get_review_package
get_delivery_status
get_closeout_evidence
```

All seven calls succeeded. The render tool returned `app_state=ready`, and the
six data tools read the same Snapshot v3 without invoking a write or Provider
capability.

The post-recovery activity-database integrity check returned `PASS`:

- SQLite quick check: `ok`;
- schema current: true;
- invalid JSON, structured drift and orphan rows: 0;
- missing media and media integrity errors: 0;
- pending or quarantined media activations: 0;
- unbound WebGPT authorization rows: 0;
- total check errors: 0.

The local Workbench then stopped gracefully without a forced fallback, and port
`4181` was released. The repository had no tracked workspace changes from the
drill.

## Accepted operations boundary

The following real recovery path is now accepted:

```text
Render restart / in-memory Snapshot loss
  -> no_snapshot
  -> Human Workbench preflight and publish
  -> one confirmed Snapshot v3 replacement
  -> ready
  -> seven readonly tools restored
```

Remaining limitations are unchanged:

- Render Free may sleep or restart and clear the in-memory Snapshot again;
- Snapshot TTL remains 24 hours;
- recovery still requires a manual Human Workbench action;
- automatic synchronization and Windows automatic start remain unimplemented;
- the second real-user viewer/grant/revoke path remains deferred;
- ChatGPT developer-mode acceptance still does not prove platform CSP
  enforcement.

Accepted status remains:

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

This closeout PR changes documentation only. It does not restart or deploy a
service, create a tag, publish a package or modify external configuration.
