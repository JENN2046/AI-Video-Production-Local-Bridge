# Documentation Index

This index separates current operating truth from historical implementation evidence.

## Current reconciliation

This reconciliation follows canonical source at migration `0016` /
`workbench-v2-11`. That is a source fact, not a new activity-database, runtime,
Snapshot, Provider or delivery acceptance. The activity runtime remains accepted
only at migration `0011` / `workbench-v2-6`.

The current production priority is the real Workbench generation, review,
regeneration, assembly, export and closeout path. Media Gateway, Memory,
multi-user, automatic Snapshot, Windows logon startup and new OAuth experiments
are not blockers for the Delivery State Foundation. Use the repository
[README](../README.md) and [Delivery State Foundation Closeout](DELIVERY_STATE_FOUNDATION_CLOSEOUT_2026-08-21.md)
for the current source/runtime boundary. [Historical State Snapshot](../CURRENT_STATE.md)
is retained only as dated evidence and is not current-main operator authority.

S1 is now complete. [Product Scope Freeze](PRODUCT_SCOPE_FREEZE.md) is the
single current statement of component classification, stage dependencies,
Provider MVP boundaries, route ownership and future removal conditions.
[Current Core Production Loop Gap Audit](CORE_PRODUCTION_LOOP_GAP_AUDIT.md)
and [Current Workbench Canary Readiness](../ops/reports/2026-07-30-current-workbench-canary-readiness.md)
remain dated gap evidence. Their PR and execution-state statements must not be
used as current authority after PR #128.

## Start here

| Need | Document |
|---|---|
| Understand current status and open gates | [Repository README](../README.md) and [Delivery State Foundation Closeout](DELIVERY_STATE_FOUNDATION_CLOSEOUT_2026-08-21.md) |
| Audit the pre-Foundation historical snapshot | [Historical State Snapshot](../CURRENT_STATE.md) |
| Audit the accepted Delivery State Foundation source/runtime boundary | [Delivery State Foundation Closeout](DELIVERY_STATE_FOUNDATION_CLOSEOUT_2026-08-21.md) |
| Audit the disposable `0011 → 0012` backup/migration/restore rehearsal | [Activity DB 0012 Foundation Rehearsal](ACTIVITY_DB_0012_FOUNDATION_REHEARSAL_2026-08-24.md) |
| Audit Production Mutation Authority and its 11 deferred review threads | [Production Mutation Authority](PRODUCTION_MUTATION_AUTHORITY_2026-08-24.md) |
| Audit durable local FFmpeg Assembly and restart semantics | [Durable FFmpeg Assembly](DURABLE_FFMPEG_ASSEMBLY_2026-08-25.md) |
| Audit Final Review, immutable Export, and exact Closeout | [Final Review, Export, and Closeout](FINAL_REVIEW_EXPORT_CLOSEOUT_2026-08-25.md) |
| Audit Provider await, receipt, atomic finalization, and recovery integrity | [External Execution Integrity](EXTERNAL_EXECUTION_INTEGRITY_2026-08-25.md) |
| Understand the active product scope and frozen surfaces | [Product Scope Freeze](PRODUCT_SCOPE_FREEZE.md) |
| See the current Workbench core-loop gaps and S3 boundary | [Current Core Production Loop Gap Audit](CORE_PRODUCTION_LOOP_GAP_AUDIT.md) |
| See the completed S3 readiness findings and exact follow-up gates | [Current Workbench Canary Readiness](../ops/reports/2026-07-30-current-workbench-canary-readiness.md) |
| Resume the latest Unified Director work safely | [2026-07-28 Unified Director handoff](HANDOFF_2026-07-28_UNIFIED_DIRECTOR.md) |
| Use the local Workbench and ChatGPT App | [User Guide](USER_GUIDE.md) |
| Install, configure or recover a runtime | [Deployment Guide](DEPLOYMENT_GUIDE.md) |
| Understand trust and data boundaries | [Architecture](ARCHITECTURE.md) |
| Learn why the system is built this way | [Project Lessons](PROJECT_LESSONS.md) |

## Operator and historical runbooks

- [Readonly MCP App Delivery](webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md) — historical acceptance and future revalidation boundary; current-main execution requires `0016` admission
- [Unified ChatGPT Workspace Transport](webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md) — historical transport/activity evidence and future revalidation boundary; current-main execution requires `0016` admission
- [Readonly Local Media Gateway](webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md)
- [WebGPT V4 legacy rollback reference](webgpt/WEBGPT_V4_RUNBOOK.md)
- [Federated OAuth portability](READONLY_FEDERATED_OAUTH_PORTABILITY.md)

Runbooks describe historical commands and future boundaries. They do not prove
current-main runtime compatibility or grant authorization for database writes,
secrets, external configuration, deployment, Scheduled Tasks or paid Provider
calls.

## Candidate implementation contracts

- [ChatGPT Director domain contract](CHATGPT_DIRECTOR_DOMAIN_CONTRACT.md) — PR1 domain and migration contract; it does not change the accepted activity database or expose Director tools.
- [ChatGPT Director Manual/Native tools](CHATGPT_DIRECTOR_MANUAL_NATIVE_TOOLS.md) — PR2 fixed advisory tool registry, manual-import boundary, and separate OAuth resource contract.
- [ChatGPT Director Local Bridge](CHATGPT_DIRECTOR_LOCAL_BRIDGE.md) — PR3 public runtime, authenticated outbound bridge, Focus/context, frame analysis and immutable Proposal candidate boundary.
- [ChatGPT Director Human Approval](CHATGPT_DIRECTOR_HUMAN_APPROVAL.md) — PR4 local Workbench approval-tower candidate; a recorded decision is not orchestration or Provider execution.
- [ChatGPT Director Bounded Orchestrator](CHATGPT_DIRECTOR_BOUNDED_ORCHESTRATOR.md) — local immutable Grant and bounded reservation; it depends on a verified capability and defaults to a disabled Provider boundary.
- [ChatGPT Director Provider Capability & Quote Contract](CHATGPT_DIRECTOR_PROVIDER_QUOTE_CONTRACT.md) — verified-only capability selection and local quote gate; Runway remains a non-executable candidate until its separate canary.
- [ChatGPT Director Memory Port](CHATGPT_DIRECTOR_MEMORY_PORT.md) — PR6 replaceable, project-bound advisory recall and non-dispatched Saveback contract; the default port is disabled and no memory plugin is connected.
- [ChatGPT Director Local Candidate Closeout](CHATGPT_DIRECTOR_LOCAL_CANDIDATE_CLOSEOUT.md) — merged PR1–PR6 scope, current activity-database incompatibility and the exact external gates that remain.
- [Unified ChatGPT Workspace MCP Contract](UNIFIED_CHATGPT_WORKSPACE_MCP.md) — candidate single-connector contract with independent Readonly Snapshot and Director Bridge chains.

## Accepted evidence

- [SR6 disposable database](../ops/reports/2026-07-13-sr6-disposable-acceptance.md)
- [SR6 activity database](../ops/reports/2026-07-13-sr6-active-database-acceptance.md)
- [Beta 4 activity database](../ops/reports/2026-07-14-beta4-active-database-acceptance.md)
- [MCP App Stage 3](../ops/reports/2026-07-17-readonly-mcp-app-stage3-acceptance.md)
- [Owner-only operations](../ops/reports/2026-07-18-owner-only-operations-acceptance.md)
- [Snapshot v3 derived state](../ops/reports/2026-07-19-snapshot-v3-derived-state-acceptance.md)
- [Snapshot v3 recovery](../ops/reports/2026-07-19-snapshot-v3-human-workbench-recovery-acceptance.md)
- [Snapshot freshness operations](../ops/reports/2026-07-19-snapshot-freshness-operations-acceptance.md)
- [Readonly Media Gateway MP4 fixture](../ops/reports/2026-07-27-readonly-media-gateway-mp4-fixture-acceptance.md)

Reports are immutable evidence for their named commit and test boundary. They are not automatically current after later merges.

## Historical taskbooks

The following explain how earlier releases were designed. Keep them for audit and rationale; do not use them as current deployment instructions:

- [Stabilization Release v2](STABILIZATION_RELEASE_V2.md)
- [Stabilization Remediation](STABILIZATION_REMEDIATION.md)
- [GPT Service Capability Hardening](GPT_SERVICE_CAPABILITY_HARDENING.md)
- [Readonly ChatGPT MCP App Workbench planning baseline](READONLY_CHATGPT_MCP_APP_WORKBENCH.md)
- [Descope Multi-User route](DESCOPE_MULTI_USER_READONLY_AUTHORIZATION.md)
- [Historical Descope external preflight](EXTERNAL_MULTI_USER_READONLY_CONNECTION_PREFLIGHT.md)
- `docs/three_routes/`

## Documentation status vocabulary

- `CURRENT`: matches the current accepted repository/operations boundary.
- `CANDIDATE`: code exists, but one or more real external gates remain.
- `HISTORICAL`: retained planning or evidence; not an operator source of truth.
- `LOCAL-ONLY`: evidence exists only on Jenn's machine and must not be claimed as independently auditable in Git.

When documents conflict, use this order: checked-out source and migration
registry → repository `README.md` and Delivery State Foundation Closeout → an
accepted report for the exact commit and operation → a runbook explicitly
admitted for that source → historical snapshots and taskbooks.
