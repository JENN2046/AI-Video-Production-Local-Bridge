# RUN_LOCK.md

status: inactive
run_id: none
owner: none
started_at: null
current_task: none
project: AI Video Production Workspace Three Route Plan
stale_after_minutes: 120
last_completed_run_id: codex-20260707-171333-r3-8i
last_completed_task: R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP
last_completed_at: 2026-07-07T17:18:38+08:00

## Rules

- If status is inactive, a new run may start.
- If status is active and belongs to the current run, continue.
- If status is active and not stale, another agent must not claim the current task.
- If status is active and appears stale, do not silently overwrite it. Record stale evidence in HANDOFF.md and report BLOCK unless stale-lock recovery is explicitly in scope.
- If the lock references a missing or inconsistent task, report BLOCK unless queue repair is explicitly in scope.
