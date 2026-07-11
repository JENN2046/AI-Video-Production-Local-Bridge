# Current State

Date: 2026-07-11

Baseline commit: `d38b69b`

Target version: `0.1.0-beta.1`

## Product state

AI Video Production Workspace 已经越过概念验证：Workbench V2、WebGPT V4、真实 RunningHub 生成、审片、重生成、合成、交付、Memory 与媒体分析均有实现和测试。

系统当前适合 Jenn 的单人 Windows 本地生产与受控验证。Stabilization Release v2 已在六个堆叠 PR 中完成代码基线：版本化数据库迁移、持久化 generation worker、媒体有界队列、完整 readiness 与标准本地 preflight 均已实现。外部 OAuth/Tunnel 接线和 Windows 自动启动仍被冻结，Jenn 的活动数据库尚未执行实际迁移。

## Verified local baseline

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm test`: PASS，包括 DB 11/11、V2 19/19、UI 1/1、H1 8/8、WebGPT V4 20/20、browser 9/9 与 secret scan
- Stabilization review remediation: PASS，包括未知 submit 人工核对、五对象终态收敛、完整 schema baseline、单一 migration lock、Legacy UI 退出和显式 legacy backfill
- `npm run preflight`: PASS on an isolated local profile
- FFmpeg/FFprobe 8.1.2: PASS，通过 WinGet Links 自动发现
- Workbench `/healthz`、`/readyz`: PASS；WebGPT 无 OAuth 时 `/readyz`: expected 503 fail closed

These results are local evidence, not a substitute for remote CI. PR2 establishes the Windows Node 22 CI baseline; every stacked PR must retain that gate.

## Stabilization policy

- Freeze WebGPT V5, Workbench V3 and new providers.
- Preserve human confirmation, cost acknowledgement, idempotency and fail-closed behavior.
- Prefer compatibility-preserving internal seams before physical repository restructuring.
- Keep historical evidence readable, but remove historical execution paths from the production command surface.
- Do not perform live Provider calls during stabilization acceptance.

## Remaining release gates

- Do not migrate Jenn's active database until a database-specific preflight is reviewed and explicitly authorized.
- Obtain green remote Windows Node 22 CI for the complete stacked branch.
- Keep Auth0, Tunnel, public HTTPS, Windows auto-start, WebGPT V5, Workbench V3 and new Providers outside this release.
- Do not make a paid Provider call as part of stabilization acceptance.
