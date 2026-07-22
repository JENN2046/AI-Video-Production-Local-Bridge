# Documentation Index

This index separates current operating truth from historical implementation evidence.

## Start here

| Need | Document |
|---|---|
| Understand current status and open gates | [Current State](../CURRENT_STATE.md) |
| Use the local Workbench and ChatGPT App | [User Guide](USER_GUIDE.md) |
| Install, configure or recover a runtime | [Deployment Guide](DEPLOYMENT_GUIDE.md) |
| Understand trust and data boundaries | [Architecture](ARCHITECTURE.md) |
| Learn why the system is built this way | [Project Lessons](PROJECT_LESSONS.md) |

## Current operator runbooks

- [Readonly MCP App Delivery](webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md)
- [Readonly Local Media Gateway](webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md)
- [WebGPT V4 local operator runbook](webgpt/WEBGPT_V4_RUNBOOK.md)
- [Federated OAuth portability](READONLY_FEDERATED_OAUTH_PORTABILITY.md)

Current runbooks describe commands and boundaries. They do not grant authorization for database writes, secrets, external configuration, deployment, Scheduled Tasks or paid Provider calls.

## Candidate implementation contracts

- [ChatGPT Director domain contract](CHATGPT_DIRECTOR_DOMAIN_CONTRACT.md) — PR1 domain and migration contract; it does not change the accepted activity database or expose Director tools.
- [ChatGPT Director Manual/Native tools](CHATGPT_DIRECTOR_MANUAL_NATIVE_TOOLS.md) — PR2 fixed advisory tool registry, manual-import boundary, and separate OAuth resource contract.
- [ChatGPT Director Local Bridge](CHATGPT_DIRECTOR_LOCAL_BRIDGE.md) — PR3 public runtime, authenticated outbound bridge, Focus/context, frame analysis and immutable Proposal candidate boundary.
- [ChatGPT Director Human Approval](CHATGPT_DIRECTOR_HUMAN_APPROVAL.md) — PR4 local Workbench approval-tower candidate; a recorded decision is not orchestration or Provider execution.
- [ChatGPT Director Bounded Orchestrator](CHATGPT_DIRECTOR_BOUNDED_ORCHESTRATOR.md) — PR5 local immutable Grant, bounded reservation and RunningHub-only candidate; it defaults to a disabled Provider boundary.

## Accepted evidence

- [SR6 disposable database](../ops/reports/2026-07-13-sr6-disposable-acceptance.md)
- [SR6 activity database](../ops/reports/2026-07-13-sr6-active-database-acceptance.md)
- [Beta 4 activity database](../ops/reports/2026-07-14-beta4-active-database-acceptance.md)
- [MCP App Stage 3](../ops/reports/2026-07-17-readonly-mcp-app-stage3-acceptance.md)
- [Owner-only operations](../ops/reports/2026-07-18-owner-only-operations-acceptance.md)
- [Snapshot v3 derived state](../ops/reports/2026-07-19-snapshot-v3-derived-state-acceptance.md)
- [Snapshot v3 recovery](../ops/reports/2026-07-19-snapshot-v3-human-workbench-recovery-acceptance.md)
- [Snapshot freshness operations](../ops/reports/2026-07-19-snapshot-freshness-operations-acceptance.md)

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

When documents conflict, use this order: `CURRENT_STATE.md` → current operator runbook → accepted report for the exact commit → historical taskbook.
