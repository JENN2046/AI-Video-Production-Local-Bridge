# RUN_LOCK.md

status: inactive
run_id: codex-20260706-203847-three-route-sustained
owner: Codex sustained executor
started_at: 2026-07-06T20:38:47+08:00
current_task: none
project: AI Video Production Workspace Three Route Plan
stale_after_minutes: 120

## Rules

- If status is `inactive`, a new run may start.
- If status is `active` and belongs to the current run, continue.
- If status is `active` and not stale, another agent must not claim the current task.
- If status is `active` and appears stale, do not silently overwrite it. Record stale evidence in `HANDOFF.md` and report `BLOCK` unless stale-lock recovery is explicitly in scope.
- If the lock references a missing or inconsistent task, report `BLOCK` unless queue repair is explicitly in scope.
