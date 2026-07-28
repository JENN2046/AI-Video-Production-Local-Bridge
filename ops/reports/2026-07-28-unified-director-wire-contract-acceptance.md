# Unified Director Wire Contract Acceptance

Date: 2026-07-28
Result: `PASS` — the exact commit was deployed, the App was reconnected, and
one locally prepared, Context-bound advisory Proposal reached
`pending_review`.

## Authorized scope

The authorized external action was limited to:

- deploy commit `479fdb832498f0195e14c093b778552198a1a19a` to the existing
  Render service `jenn-ai-video-readonly-mcp-app` with **Deploy a specific
  commit**;
- preserve the existing Render Build, Start, Health and Environment
  configuration without applying `render.yaml`;
- reconnect the existing `AI Video Production Workspace — Unified` App;
- if and only if the current Focus was one active SHOT, derive and submit one
  advisory `storyboard_revision` Proposal from its bound Context and confirm
  `pending_review`.

The instruction required an immediate stop on any baseline, Focus, Bridge or
Context mismatch.

## Verified results

- GitHub Actions run
  [30321849987](https://github.com/JENN2046/AI-Video-Production-Local-Bridge/actions/runs/30321849987)
  completed successfully for the exact target commit. Both `Browser smoke`
  and `Quality and integration` passed.
- Render accepted the exact commit through **Deploy a specific commit** and
  displayed that commit as live.
- The deployment action did not save any service setting, apply
  `render.yaml`, or modify Render, Auth0, DNS, secret, environment or route
  configuration.
- The public `/healthz` probe returned healthy for
  `unified-workspace-mcp`.
- The public `/readyz` probe returned ready with
  `workspace_oauth=true`, `director_bridge=true` and
  `legacy_readonly_enabled=true`.
- `workspace_snapshot_fresh=false` after the service restart. No Snapshot was
  published because the authorized path was Director-only.
- The existing `AI Video Production Workspace — Unified` App reconnected
  successfully through its existing OAuth session. No credential, OTP or
  permission setting was entered or changed.
- The refreshed `submit_director_proposal` tool exposed the model-friendly
  Proposal envelope.

## Local preparation

- The existing Human Workbench answered `/healthz` and `/readyz` successfully
  as `workbench-v2`; all reported readiness checks passed and Provider
  execution remained disabled.
- The Director page showed one active SHOT Focus at generation `7`, one active
  issuer-bound Owner, and zero pending Proposals before the test.
- The public Unified readiness check showed `director_bridge=true`.
- The target source baseline had no `src/`, `scripts/` or `package.json`
  drift from `479fdb8`.
- `npm run typecheck` passed.
- `npm run test:webgpt:director` passed with 49 tests.
- `npm run test:webgpt:workspace` passed with 14 tests.

The first Focus read immediately after App reconnection had returned:

```text
state=focus_expired
focus=null
```

That attempt stopped before Context or Proposal work. After Jenn explicitly
requested a retry and required local preparation first, the Workbench state
was refreshed and the current Focus was confirmed locally before the bounded
external path resumed.

## Bounded acceptance

The final accepted path was:

```text
active SHOT Focus, generation 7
  -> Context ready with the same Focus and generation
  -> one Context-derived storyboard_revision Proposal
  -> accepted_for_human_review, source=native
  -> pending_review, reason=DIRECTOR_NATIVE_SUBMITTED
  -> matching local Workbench card: ChatGPT Native / Focus #7 / 待审批
```

The Proposal retained the current five-second, vertical `9:16`,
`720x1280` SHOT specification and existing active storyboard image. It
advised filling the empty storyboard prompt with explicit subject, readable
action and composition hierarchy. The report deliberately omits the
Proposal, Focus, project, SHOT and Artifact identifiers and the full payload.

## Side-effect accounting

| Action | Result |
| --- | --- |
| Advisory Proposals submitted | `1` |
| Proposal approvals or rejections | `0` |
| Automation Grants compiled or started | `0` |
| Provider calls | `0` |
| Snapshots published | `0` |
| Memory writes | `0` |
| Artifacts delivered | `0` |
| Configuration changes | `0` |

The Proposal remains advisory and awaits human review. No Workbench decision
was made.

## Limitations and retained boundaries

- The managed Workbench status record is stale relative to the healthy
  listener process. The listener identity, entrypoint, local UI and HTTP
  readiness were checked directly; Workbench was not stopped or restarted.
- The continuously running Bridge process predates PR #95. The exact target
  source was rebuilt and passed the isolated Bridge/Unified tests locally,
  but a live Bridge restart was blocked before execution by the local command
  policy, so the existing process was left unchanged. The positive valid
  Proposal path is wire-compatible and passed end to end. This report does
  not claim a live negative-path validation of PR #95's new local malformed
  input error mapping.
- `workspace_snapshot_fresh=false` remained expected after the Render
  restart. Director readiness came from the independent Bridge; no Snapshot
  was published.
- This is not approval, Grant, Provider, Memory, Artifact delivery or
  automatic-execution acceptance.

One sensitive operations field was visible while checking the Render service
settings. It was not used, copied, stored or changed.
