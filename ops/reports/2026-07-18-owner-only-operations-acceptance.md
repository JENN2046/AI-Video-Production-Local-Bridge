# Owner-Only Readonly Operations Acceptance

Date: 2026-07-18

Result: `PASS_OWNER_ONLY_ONE_CLICK_PUBLISH`

## Accepted identity

- Source baseline: `main@932e145e201ddf5763ab5fcbdc11b88fa8c81bad`
- Package: `0.1.0-beta.5`
- MCP service: `webgpt-v4.3.0`
- Remote App service: `readonly-remote-v1.0.0`
- Database schema: `workbench-v2-5`
- Accepted activity-database ledger: `0008`
- Runtime: Windows with Node `22.23.1`

## Authorization and disclosure boundary

Jenn authorized the real owner-only one-click publish acceptance after Personal
Readonly Operations was merged. The acceptance used the existing Git-ignored
publisher profile and DPAPI CurrentUser key through the Human Workbench. Real
Provider execution remained disabled.

This report contains no OAuth subject, token, cookie, principal hash, publisher
key, private profile value, project identifier, project title, database business
row, Snapshot body or Provider payload. It does not reproduce raw browser,
database or remote-service output.

No Auth0, Render, DNS or ChatGPT App configuration was created or modified. No
media, write tool, Provider or Windows automatic-start capability was enabled.

## One-click acceptance

The Workbench Personal Readonly Operations surface reported a ready local
runtime and completed the protected `preflight and publish` action. The action
required the existing action nonce and explicit human confirmation, returned
HTTP `202`, and replaced the remote signed Snapshot exactly once.

The newly published Snapshot was fresh with the expected approximately 24-hour
TTL. Its fingerprint was consistent between the publisher result and the
subsequent ChatGPT MCP App tool results; the fingerprint value itself is not
retained in this report.

ChatGPT completed authenticated calls to the full owner-only readonly surface:

```text
render_ai_video_workspace_app
list_production_projects
get_project_context
list_project_shots
get_review_package
get_delivery_status
get_closeout_evidence
```

All seven calls completed without a stable error code. The acceptance prompt
required low-disclosure status-only output and did not reproduce project fields
or business text.

The post-publish activity-database integrity check returned `PASS`:

- SQLite quick check: `ok`
- schema current: true
- invalid JSON, structured drift and orphan rows: 0
- missing media and media integrity errors: 0
- pending or quarantined media activations: 0
- unbound WebGPT authorization rows: 0
- total check errors: 0

The local Workbench was stopped after acceptance and its listener was released.
The accepted Jenn owner connection remained functional.

## Deferred gates

Jenn explicitly deferred the second real-user viewer/grant/revoke golden path.
No database backup or authorization write was performed for that attempted
lane, so status remains `PARTIAL_MULTI_USER_GATE` without weakening the accepted
single-user baseline.

The next external operations gate is a separately authorized Render Free
cold-start and in-memory Snapshot-loss recovery drill:

```text
no_snapshot
  -> one-click preflight and publish
  -> seven readonly tools restored
```

That drill was not executed by this closeout. Render Free may sleep or restart,
and the in-memory Snapshot still expires after 24 hours. Until the recovery
drill passes, manual republishing remains an accepted but not yet failure-drilled
operating procedure.

ChatGPT developer-mode acceptance did not enable platform CSP enforcement. The
resource CSP contract remains covered by automated tests, while platform
enforcement remains an external limitation.

## Accepted status

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

No tag, package publication, release, deployment or external configuration
change was performed by this closeout.
