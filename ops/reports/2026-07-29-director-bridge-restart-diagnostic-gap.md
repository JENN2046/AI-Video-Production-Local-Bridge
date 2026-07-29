# Director Bridge Restart Diagnostic Gap

Date: 2026-07-29 (Asia/Shanghai, UTC+08:00)

Result: `BLOCK` — an authorized controlled activation of the merged
cross-terminal repair at `2b43f558` did not establish authenticated Remote
contact. The manager failed closed and no Bridge process remains.

## Scope

The maintenance action was limited to the local managed Bridge lifecycle and
low-disclosure readiness checks. It did not authorize or perform a Render
deployment, production configuration change, credential change, Provider call,
Snapshot publication, Memory write, Proposal action or database write.

## Evidence

- The previously accepted `fbf6540` managed Bridge was stopped through the
  controlled lifecycle path.
- The canonical local source advanced to exact merged commit `2b43f558`.
- The new child had matching managed process identity and produced fresh local
  heartbeats in `backoff`.
- No authenticated Remote contact was observed before the 180-second startup
  deadline.
- The manager requested bounded cleanup and the child exited; the final
  manager state had no running Bridge process.
- Public readiness remained fail-closed: workspace OAuth was configured, the
  Director Bridge check was false and Provider execution remained disabled.
- The separately authorized latest stderr-tail inspection contained only a
  runtime warning. It contained no boot failure and no authentication, HTTP,
  DNS, TLS, timeout or generic-network diagnostic.

No raw log text, origin, credential identifier, local path, payload, database
content or provider response was copied into this report.

## Root diagnostic gap

The child records a stable `DIRECTOR_*` poll failure in its instance-bound
heartbeat while it backs off. The start manager previously returned only
`DIRECTOR_BRIDGE_RUNTIME_HEARTBEAT_TIMEOUT` after cleanup. A later operator
therefore could not distinguish the safe child error category without reading
ephemeral private runtime state before it was replaced or removed.

The companion repair captures the validated heartbeat code before cleanup and
adds it as optional `child_error_code` while retaining the manager timeout as
the controlling `stable_error_code`. The projection contains no raw error
message or runtime locator.

## Remaining gate

This report is not a Bridge acceptance. After the diagnostic repair merges and
passes CI, another controlled restart requires separate authorization. If
Remote contact succeeds, that run must verify both configured
`configuration_identity=verified` and independent-terminal
`configuration_identity=not_rechecked`. If it fails, the bounded child error
enum becomes the next diagnostic input.
