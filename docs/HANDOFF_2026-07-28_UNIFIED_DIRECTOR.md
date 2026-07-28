# Unified Director Handoff — 2026-07-28

Status: `PASS` — the exact target commit is live, the Unified App was
reconnected, and one locally prepared, Context-bound `storyboard_revision`
Proposal is advisory and `pending_review`.

See the low-disclosure
[acceptance report](../ops/reports/2026-07-28-unified-director-wire-contract-acceptance.md)
for the deployment evidence, local preparation, bounded acceptance and
side-effect accounting.

## Handoff identity

| Item | Value |
| --- | --- |
| Repository baseline | `main@479fdb832498f0195e14c093b778552198a1a19a` |
| Change just merged | PR #95 — model-friendly Director Proposal wire contract |
| PR CI at merge | Browser smoke and Quality and integration passed after a transient Windows runner dependency-source retry |
| Main CI at handoff | [GitHub Actions run 30321849987](https://github.com/JENN2046/AI-Video-Production-Local-Bridge/actions/runs/30321849987) completed successfully for the exact baseline; Browser smoke and Quality and integration passed |
| Local checkout | `main` equals `origin/main` at `479fdb8` |

## What PR #95 changes

`submit_director_proposal` now accepts a model-friendly wire envelope at the
MCP boundary. Before anything can persist, the local Bridge and remote path
still validate the proposal with the existing exact discriminated contract.

- Valid `storyboard_revision` and `clip_regeneration` inputs retain their
  existing semantic validation.
- Extra or malformed proposal payload fields fail closed with a stable error
  code and do not create a Proposal.
- The change is limited to the Proposal tool contract; it does not approve a
  Proposal, compile a Grant, call a Provider, deliver an Artifact, or change
  database schema.

## External acceptance result

Verified:

- `npm run typecheck`
- `npm run test:webgpt:director` — 49 passing
- `npm run test:webgpt:workspace` — 14 passing
- PR #95 Windows CI: Browser smoke and Quality and integration passed
- `main@479fdb8` Windows CI: Browser smoke and Quality and integration passed
- Render: exact commit
  `479fdb832498f0195e14c093b778552198a1a19a` deployed with **Deploy a
  specific commit** and observed live
- Public service probes: `/healthz` healthy; `/readyz` ready with OAuth and
  Director Bridge checks passing
- ChatGPT App: existing `AI Video Production Workspace — Unified` connection
  reconnected successfully
- Refreshed Proposal tool: model-friendly wire envelope visible
- Local preparation: Workbench health/readiness passed, the current Focus was
  one active SHOT at generation `7`, and the pending count was zero
- Current-baseline local validation: typecheck passed, Director 49/49 and
  Unified Workspace 14/14
- Context: `ready` and bound to the same Focus and generation
- Proposal: exactly one `storyboard_revision`, accepted for human review with
  source `native`
- Status: `pending_review` with `DIRECTOR_NATIVE_SUBMITTED`
- Human Workbench: one matching `ChatGPT Native`, Focus `#7`, `待审批` card
- Forbidden side effects: zero approvals/rejections, Grants, Provider calls,
  Snapshot publications, Memory writes, Artifact deliveries or configuration
  changes

The first post-reconnection Focus read had returned:

```text
get_director_focus
→ state=focus_expired
→ focus=null
```

That attempt stopped before Context or Proposal work. Jenn then explicitly
requested a Focus retry and required local preparation before testing. The
Workbench state was refreshed, the new current active SHOT Focus was checked
locally, and only then was the bounded path resumed.

The deployed positive wire path is externally accepted. The resulting
Proposal deliberately remains pending human action.

Runtime note:

- The Workbench manager's recorded PID is stale, while the actual local
  listener, expected entrypoint, UI and HTTP readiness are healthy. It was not
  restarted.
- The continuously running Bridge process predates PR #95. Exact target
  source was rebuilt and the isolated Bridge/Unified tests passed, but a live
  Bridge restart was blocked before execution by local command policy. The
  existing compatible Bridge carried the valid positive path end to end.
  Live negative-path acceptance of the new local malformed-input error
  mapping is not claimed.

## Do not cross these boundaries during the next step

- Do not read, display, copy, or rotate Bridge keys, OAuth credentials, token
  material, private profiles, raw logs, or database contents.
- Do not migrate or otherwise write the activity database outside the one
  expected advisory Proposal record created by the bounded acceptance.
- Do not publish a Snapshot, alter Auth0/Render/DNS settings, install startup
  tasks, enable `REAL_PROVIDER_ENABLED`, submit a Provider job, or deliver an
  Artifact unless separately authorized.
- Treat legacy `/mcp` as a rollback surface. This handoff concerns the Unified
  `/workspace/mcp` chain only.

## Separate pending work

- PR #94, the Director Focus-panel layout hotfix, remains an independent Draft
  PR. It is not part of PR #95 and must be reviewed and merged separately if
  its UI improvement is desired.
- A follow-up local code branch adds a managed Windows Bridge runtime:
  tracked-source/emitted-`dist`/Node/entrypoint fingerprints, exact
  two-argument command identity, hashed launch configuration, a two-phase
  activation gate, instance-bound heartbeat, repeat-start detection and
  final-heartbeat non-forced stop. Its isolated tests use a copied fake child
  plus a pre-activation real-entrypoint check; they do not read the active
  database or Bridge credential, contact the Remote, or call a Provider. This
  is local code/fixture evidence only; the current live Bridge has not been
  restarted under the new manager, and dependency-tree identity is not
  attested.
- Media Gateway remains bounded-fixture accepted for public MP4 playback, but
  byte-range `206` / `Content-Range`, recovery-soak, and other gates remain as
  listed in `CURRENT_STATE.md`.
- Stable Memory, bounded Provider execution, and multi-user/revocation remain
  separate, unaccepted gates.

## Local working-copy caution

User-owned untracked local material exists in the checkout. Preserve it and
use precise staging; do not use bulk clean, reset, or blanket add commands.

## Closeout boundary

- Do not redeploy or reconnect again for this acceptance.
- Leave the new Proposal in `pending_review`.
- Any approval, rejection, Grant compilation, Provider execution, Snapshot
  publication, Memory write or Artifact delivery requires a separate current
  instruction.
- A future live negative-path check should first establish a safely managed
  runtime at the intended source commit and emitted-`dist`/Node fingerprints.
  It must not inspect or expose the Bridge credential or active database
  contents.
- The managed stop path never performs a default `Stop-Process`. It checks the
  stop sentinel immediately before handler invocation, lets an already-running
  handler finish, retries an unacknowledged completion before polling again,
  and requires a matching final heartbeat with `completion_pending=false`
  before reporting graceful stop. If Remote `202` cannot be confirmed, it
  does not delete receipts, report graceful, or force-kill a still-running
  child.
