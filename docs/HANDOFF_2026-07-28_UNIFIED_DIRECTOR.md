# Unified Director Handoff — 2026-07-28

Status: `CURRENT` handoff note as of its named repository baseline. Re-check
the linked CI run before taking the next external action.

## Handoff identity

| Item | Value |
| --- | --- |
| Repository baseline | `main@479fdb832498f0195e14c093b778552198a1a19a` |
| Change just merged | PR #95 — model-friendly Director Proposal wire contract |
| PR CI at merge | Browser smoke and Quality and integration passed after a transient Windows runner dependency-source retry |
| Main CI at handoff | In progress for `main@479fdb8`; use the [GitHub Actions run](https://github.com/JENN2046/AI-Video-Production-Local-Bridge/actions/runs/30321849987) as the current source of truth |
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

## Verified versus still required

Already verified on the PR branch:

- `npm run typecheck`
- `npm run test:webgpt:director` — 49 passing
- `npm run test:webgpt:workspace` — 14 passing
- PR #95 Windows CI: Browser smoke and Quality and integration passed

Still required before claiming the new Proposal wire contract is externally
accepted:

1. Wait for the `main@479fdb8` Windows CI run to complete successfully.
2. Obtain a current, explicit authorization to deploy that exact main baseline
   to Render. A merge and a passing CI run do not authorize deployment.
3. Reconnect the single `AI Video Production Workspace — Unified` ChatGPT App
   and exercise this bounded path against the deployed service:

   ```text
   get_director_focus
   → get_director_context
   → submit_director_proposal
   → get_director_proposal_status
   ```

4. Confirm in the local Workbench that the resulting Proposal is advisory and
   pending human action. Do not approve it, compile an Automation Grant, or
   invoke a Provider during this recheck.
5. Record an acceptance report with the exact deployed commit and only
   low-disclosure evidence.

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
- Media Gateway remains bounded-fixture accepted for public MP4 playback, but
  byte-range `206` / `Content-Range`, recovery-soak, and other gates remain as
  listed in `CURRENT_STATE.md`.
- Stable Memory, bounded Provider execution, and multi-user/revocation remain
  separate, unaccepted gates.

## Local working-copy caution

User-owned untracked local material exists in the checkout. Preserve it and
use precise staging; do not use bulk clean, reset, or blanket add commands.

## Resumption checklist

1. Verify `main`, `origin/main`, and the deployed commit are the same intended
   baseline.
2. Verify main CI is green.
3. Confirm a current deployment authorization.
4. Deploy once; wait for readiness without inspecting secrets or raw logs.
5. Run the bounded ChatGPT Proposal path above.
6. Stop after the advisory Proposal/status observation and report the result.
