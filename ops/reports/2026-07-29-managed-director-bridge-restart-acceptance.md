# Managed Director Bridge Restart Acceptance

Date: 2026-07-29
Result: `PASS` — the managed local Director Bridge was adopted through a
controlled restart at source baseline `fbf6540`, without Provider execution or
workflow-side mutation.

## Authorized scope

The bounded maintenance action was limited to a controlled local Bridge
restart and its local acceptance checks. It did not authorize a Render deploy,
service configuration change, secret inspection, Proposal decision, Grant
compilation, Provider execution, Snapshot publication, Memory write or
Artifact delivery.

## Verified result

- The managed Bridge adopted source baseline `fbf6540` after the controlled
  restart.
- A local read-only database compatibility check passed.
- The manager assessment resolved to `RUNNING` with matched process identity,
  fresh heartbeat and fresh Remote contact.
- Provider execution remained disabled.
- The contemporaneous Render deployment receipt recorded the same `fbf6540`
  source baseline as live; this report does not claim that local runtime state
  came from Render or that Render configuration was changed.

## Recovery accounting

Two earlier restart attempts reached the bounded
`DIRECTOR_BRIDGE_RUNTIME_HEARTBEAT_TIMEOUT` condition. Their manager state was
cleaned as stale before the accepted attempt. The accepted result is limited to
the managed process and low-disclosure manager observations; no raw runtime
log, key material, database content, configuration value or endpoint is
recorded here.

## Side-effect accounting

| Action | Result |
| --- | --- |
| Provider calls | `0` |
| Proposal approvals or rejections | `0` |
| Automation Grants compiled or started | `0` |
| Snapshots published | `0` |
| Memory writes | `0` |
| Artifacts delivered | `0` |
| Render, Auth0, DNS, secret, environment or route changes by this action | `0` |

## Retained boundary

The cross-terminal configuration-identity repair is validated only in the
current source tree and fixture runtime. The accepted running Bridge was not
stopped or restarted to activate that repair. After the repair is merged, a
new controlled restart requires separate authorization before any live claim
about independent-terminal status behavior.
