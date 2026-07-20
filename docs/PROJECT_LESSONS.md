# Project Construction Lessons

Status: CURRENT low-disclosure engineering memory.
Scope: lessons that should survive individual PRs and external-provider changes.

## 1. Separate capability from acceptance

The project repeatedly reached “code-complete” before the external route was usable. A merged runtime, created DNS record or green local health probe is not an end-to-end PASS.

Use four labels:

```text
implemented
locally verified
externally wired
operationally accepted
```

Every status document and release claim must say which one applies.

## 2. Change one variable in compatibility experiments

The Secure MCP Tunnel OAuth investigation became useful only after isolating the hosted Tunnel path from the direct HTTPS path. The durable pattern is:

1. hold issuer, audience, scope, PRMD and challenge constant;
2. change only transport/hosting;
3. record the first failing protocol boundary;
4. avoid deleting old objects until the replacement passes.

This prevents authentication, discovery, callback and transport failures from being mixed together.

## 3. Local authorization remains authoritative

Auth0 or another IdP proves identity. It does not decide project access. Persist only opaque issuer-bound principals; require explicit active memberships and an active owner for readiness. Keep bindings and authorization events immutable/append-only.

This made the IdP replaceable without turning the cloud provider into a second business database.

## 4. A readonly label is insufficient

Readonly must be proven at every layer:

- tool registration excludes writes;
- SQLite connections are read-only;
- projections compare logical manifests before/after;
- browser/status polling does not touch `last_opened_at`;
- Snapshot publishing writes only remote ephemeral state and a sanitized local receipt;
- media streaming never creates DB grants.

Model annotations are hints, not an authorization boundary.

## 5. Derive operational state once

Independent status fields caused contradictions such as “Storyboard approved but image missing” and “review pending count zero while SHOT review is pending.” The repair was a shared derived state model projected into project summaries, SHOTs, reviews and Snapshot validation.

Canonical state must bind to containing project/SHOT IDs and preserve blocker reason codes. Public DTOs use `null` plus stable reason codes instead of ambiguous empty strings.

## 6. Treat migrations as a governed release operation

Runtime auto-migration hid risk and made rollback unclear. The accepted model is explicit migration with:

- service stop;
- pre-migration backup and logical manifest;
- isolated-copy migration and restore rehearsal;
- checksum/name/DDL validation;
- `db:check`;
- activity-database authorization;
- backup restore, not down migration.

Compatibility fixes must account for databases that already ran an interim migration checksum.

## 7. Provider submission uncertainty is a first-class state

An HTTP response, an application rejection and an unknown paid submit outcome are different. Definite rejections should fail normally; only genuinely unknown outcomes enter manual reconciliation. Persist intent before submission, use idempotency, and never automatically retry a possibly paid unknown submit.

## 8. Artifact identity includes bytes and ownership

Artifact IDs alone are insufficient. Safe use requires agreement among structured columns, JSON, project/SHOT binding, role/type/status, Blob owner, approved media root, file identity and SHA-256. Stream from the same file descriptor whose identity was verified; path re-open introduces TOCTOU risk.

## 9. Ephemeral cloud state needs a human recovery surface

Render Free makes in-memory Snapshot loss normal. The product became usable only after Workbench exposed `no_snapshot`, renewal warnings, one explicit preflight/publish and stable recovery codes. Operational UX is part of the system, not optional documentation.

## 10. Media capability design must bound every collection

Pending capabilities, consumed tombstones, replay nonces, sessions, hash workers, queue waiters and caches all need explicit global/per-principal limits and expiry. Limiting only active sessions leaves other denial-of-service paths open.

Capability URLs are short-lived bearer material. Keep them only in media element `src`, never in model-visible content, Widget state, copy text or logs.

## 11. Public health must identify this instance

Cloudflare replicas and stale connectors can return a valid generic health body while routing capabilities to a different in-memory Gateway. Public acceptance therefore needs an instance nonce/fingerprint echoed by the exact local process. Transport evidence must distinguish QUIC from TCP and must not treat an open UDP socket as a connected edge session.

## 12. Test selection is part of the safety contract

A regression test that is not selected by both canonical `npm test` and Windows CI is not a gate. Maintain a suite catalog and meta-test exact safety case names, npm lanes and CI steps. Fail if either local or CI selection is absent.

## 13. Preserve evidence, but retire stale instructions

Historical taskbooks explain decisions; current runbooks operate the system. A docs index and explicit `CURRENT/CANDIDATE/HISTORICAL` vocabulary prevent old plans from overriding accepted reality. Reports remain tied to their tested commit and must not be generalized to later code.

## 14. Secrets need operationally usable handling

“Never print the secret” is not enough. The system needs hidden input, DPAPI CurrentUser storage, child-only environment injection, command-line exclusion, clipboard clearing, redacted status and key rotation rules. A secret can be securely stored yet operationally unusable if recovery and rotation are not designed.

## 15. The safest next step is usually the smallest falsifiable test

When an external path fails, prefer a bounded canary that can answer one question: discovery vs callback, key mismatch vs network, edge transport vs public route, fixture projection vs activity data. Stop after the first failure and keep rollback evidence. Repeated retries without a changed hypothesis add risk, not knowledge.

## Decision checklist for future work

Before promoting a capability, answer:

1. What is the sole source of truth?
2. What exact authority permits this action?
3. What is written locally and externally?
4. What stable failure code names the first boundary?
5. What proves zero unintended writes?
6. What is the rollback and has it been rehearsed?
7. Which exact tests run locally and in Windows CI?
8. What remains merely implemented rather than accepted?

If any answer is missing, keep the capability at CANDIDATE.
