# Snapshot v3 Derived State Acceptance

Acceptance date (Asia/Shanghai, UTC+08:00): 2026-07-19

Result: `PASS_SNAPSHOT_V3_DERIVED_STATE`

## Accepted identity

- Source baseline: `main@82043df7eb1d5e65bd4a7b3db2af6352979c9bf9`
- Package: `0.1.0-beta.5`
- MCP service: `webgpt-v4.3.0`
- Remote App service: `readonly-remote-v1.0.0`
- Snapshot schema: `readonly-snapshot-v3`
- Snapshot envelope: `readonly-snapshot-envelope-v3`
- Database schema: `workbench-v2-5`
- Accepted activity-database ledger: `0008`

## Authorization and disclosure boundary

Jenn authorized an exact deployment of the latest `main` to the existing
readonly Render service and one replacement publish of the signed Snapshot.
Real Provider execution remained disabled. The operation did not modify Render
configuration, DNS, Auth0, the ChatGPT App, the activity database, media or
Windows automatic-start configuration.

This report contains no OAuth subject, token, cookie, principal hash, publisher
key, private profile value, project identifier, project title, database business
row, Snapshot body, tool output or Provider payload. It does not retain the
Snapshot fingerprint value; it records only the verified equality result.

## Deployment and Snapshot replacement

Render checked out the exact accepted source commit and brought the new service
instance to `Live`. Before publication:

- `/healthz` returned HTTP `200`;
- `/readyz` returned HTTP `503`;
- Snapshot freshness was `no_snapshot`.

The new process therefore did not reuse the previous in-memory Snapshot. The
cloud regression lane also proved that a prior `readonly-snapshot-v2` payload is
rejected with the stable unsupported-version contract.

Publisher preflight completed against the activity database with migration
ledger `0008`. One and only one `readonly-snapshot-v3` replacement was then
published. The remote service accepted it with HTTP `202`; after publication:

- `/healthz` returned HTTP `200`;
- `/readyz` returned HTTP `200`;
- Snapshot freshness was `fresh` with the expected approximately 24-hour TTL;
- OAuth, publisher key, Snapshot freshness and authorization projection checks
  were all true;
- the publisher receipt and remote readiness reported the same fingerprint.

The final activity-database integrity check returned `PASS`: SQLite quick check
was `ok`, schema was current, and JSON drift, orphan references, missing or
invalid media, pending activations, unbound authorization rows and total check
errors were all zero.

## Real ChatGPT MCP App acceptance

After Jenn refreshed the ChatGPT OAuth connection, the authenticated owner path
completed all seven readonly operations:

```text
render_ai_video_workspace_app
list_production_projects
get_project_context
list_project_shots
get_review_package
get_delivery_status
get_closeout_evidence
```

All seven calls succeeded and reported one identical Snapshot fingerprint. The
Workbench shell reported `ready` and resource version
`readonly-workbench-v1.0.0`.

The shared derived-state projection was internally consistent:

- project SHOT count matched the projected SHOT list;
- project blocker count matched the SHOTs carrying canonical blocker codes;
- project review-pending count was zero while projected review stages were
  `not_started`;
- a non-reviewable empty package returned `package_state=not_available` and
  `reason_code=NO_GENERATED_CLIP`;
- absent storyboard, accepted, selected and final Artifact references were
  represented as `null`, not empty strings;
- an unavailable final Artifact retained an explicit reason code;
- legacy top-level SHOT status remained compatibility data, while
  `operational_state` was the authoritative shared derived state for
  Storyboard, Generation, Review, blocker and Delivery interpretation.

No data tool wrote to the activity database, invoked a Provider, downloaded
media or exposed a write capability.

## Automated evidence

`npm run test:webgpt:cloud` passed `29/29`, including:

- five-stage operational-state export through Snapshot v3;
- canonical blocker reason preservation;
- stable rejection of Snapshot v2 payloads;
- SQLite/Snapshot DTO parity and zero-write manifest;
- signed transport, TTL, atomic replacement, OAuth and readiness failure paths.

`npm run db:check` also returned `PASS` after the real publish and ChatGPT App
calls.

## Remaining boundaries

- Render Free may sleep or restart and clear its in-memory Snapshot.
- Snapshot TTL remains 24 hours and requires manual republication.
- This acceptance proved `no_snapshot -> CLI preflight/publish -> seven tools
  restored`; it did not repeat the Human Workbench one-click recovery path on
  Snapshot v3.
- The second real-user viewer/grant/revoke path remains deferred.
- Automatic synchronization and Windows automatic start remain unimplemented.
- ChatGPT developer-mode acceptance still does not prove platform CSP
  enforcement.

Accepted status remains:

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

This closeout PR changes documentation only. It does not create a tag, publish a
package, deploy code or modify any external configuration.
