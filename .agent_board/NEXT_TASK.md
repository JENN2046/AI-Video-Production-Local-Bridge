# NEXT_TASK.md

status: READY

task_id: R1-6_WEBGPT_POST_CLOSEOUT_BRIDGE_REALITY_AUDIT

title: WebGPT Post-Closeout Bridge Reality Audit

priority: P0

lane: WebGPT MCP Bridge Reality Audit

project: AI Video Production Workspace GPT Bridge Line

depends_on: R3-9R_FINAL_DELIVERY_CLOSEOUT

## Goal

Recalibrate the GPT bridge line against the completed final video project so the next GPT-facing work starts from current app truth instead of stale R1 assumptions.

## Required Work

- Inspect the existing WebGPT/MCP bridge implementation after R3-9 final video closeout.
- Inventory v0 read-only, v0.5 draft, v1 human-confirmed pending action, v2 review assistant, and v3 production assistant surfaces.
- Map existing bridge capabilities to the `final_approved` project state and R3-9 closeout evidence.
- Identify gaps before any new GPT-facing implementation or official ChatGPT MCP app packaging.
- Generate `data/reports/r1_6_webgpt_post_closeout_bridge_reality_audit_result.json`.
- Do not start public tunnels, call providers, read env files or credentials, mutate production truth, publish, deploy, push, tag, or release.

## Acceptance

- Report includes current R1-0 through R1-5 completion status and evidence paths.
- Report inventories package scripts and implemented bridge entrypoints for WebGPT v0, v0.5, v1, v2, and v3.
- Report maps what GPT can read, draft, request, and propose after R3-9 final approval.
- Report verifies final approved project evidence from R3-9R is reachable by app-side report references, not GPT-invented IDs.
- Report identifies local blockers, stale assumptions, and recommended next tasks.
- Provider, secret, publish, deploy, public tunnel, and direct GPT mutation boundaries remain false.

## Validation

- JSON parse for generated R1-6 audit report
- `npm run typecheck`
- `npm run test:webgpt:bridge`
- `npm run test:webgpt:drafts`
- `npm run test:webgpt:pending`
- `npm run test:webgpt:review`
- `npm run test:webgpt:production`
- `npm run secret:scan`
- `git diff --check`

## Boundary

Audit only. No public tunnel, provider call, env or credential read, production mutation, publish, deploy, push, tag, or release.
