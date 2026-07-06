# RUN_LOCK.md

status: inactive
run_id: null
owner: null
started_at: null
current_task: null
project: null
stale_after_minutes: 120

## Rules

- If status is `inactive`, a new run may start.
- If status is `active` and belongs to the current run, continue.
- If status is `active` and not stale, another agent must not claim the current task.
- If status is `active` and appears stale, do not silently overwrite it. Record stale evidence in `HANDOFF.md` and report `BLOCK` unless stale-lock recovery is explicitly in scope.
- If the lock references a missing or inconsistent task, report `BLOCK` unless queue repair is explicitly in scope.
