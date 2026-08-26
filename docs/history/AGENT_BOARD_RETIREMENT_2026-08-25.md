# Agent Board Retirement Manifest

Status: `HISTORICAL`

The committed `.agent_board` single-slot queue and supporting ledgers were
retired on 2026-08-25 because independently maintained current-state surfaces
had drifted from repository and operational reality.

```yaml
retirement:
  reason: MULTI_SURFACE_CURRENT_STATE_DRIFT
  current_authority_after_retirement: CURRENT_STATE.md
  historical_content_preserved_in_git: true
  replacement_committed_queue: false
  local_scratch_policy: LOCAL_EPHEMERAL_AGENT_SCRATCH
  last_known_stale_state:
    task: S3B-T2_PREPARE_ELIGIBLE_SHOT
    status: BLOCKED
    result: BLOCKED_T2_EXECUTABLE_PATH_MISSING
    stale_dependency: PR_117
```

## Retired tracked paths

| Path | Blob SHA before retirement | Bytes | Classification |
|---|---:|---:|---|
| `.agent_board/HANDOFF.md` | `f2c77c6d039d1e5dc375a6872181d5905a575a09` | 86,698 | `HISTORICAL` |
| `.agent_board/NEXT_TASK.json` | `9653ef4cf1eba45b6774b181abc422cac2bf7999` | 9,385 | `HISTORICAL` |
| `.agent_board/NEXT_TASK.md` | `11bb85e3ea57f9978e67760d4eaff6d9d1cf706b` | 4,775 | `HISTORICAL` |
| `.agent_board/RUN_LOCK.md` | `fde6cad59bfc57a0f3c88853e55864e3edb44a7d` | 8,737 | `HISTORICAL` |
| `.agent_board/TASK_BACKLOG.md` | `7161a6510c2e477ea5665dcb3427ee2872a3b5ae` | 224,963 | `HISTORICAL` |
| `.agent_board/TASK_LEDGER.md` | `88ca266b9628d0d7cf633608379879b25e3f6e53` | 190,286 | `HISTORICAL` |
| `.agent_board/VALIDATION_LOG.md` | `1fc858ca28d74dd9c5cdb326a335e3ee48b2da8c` | 116,701 | `HISTORICAL` |

Git history preserves each complete retired blob; this manifest intentionally
does not copy the old queue or ledgers into another active documentation area.
The files were historical coordination artifacts, not immutable execution
receipts. Current ownership is defined in [State Surface Governance](../STATE_SURFACE_GOVERNANCE.md).
