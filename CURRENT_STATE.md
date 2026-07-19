# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-19

Baseline: `0.1.0-beta.5` accepted Jenn single-user MCP App runtime; multi-user gate remains partial

Accepted version: `0.1.0-beta.5`; MCP service: `webgpt-v4.3.0`; Remote App service: `readonly-remote-v1.0.0`; database schema: `workbench-v2-5`; accepted activity-database ledger: `0008`

Stage 3 acceptance source baseline: `main@07ad045f3b1d1ade1b2249ce256bafa2fc05385c`

Owner-only operations acceptance source baseline: `main@932e145e201ddf5763ab5fcbdc11b88fa8c81bad`

Snapshot v3 derived-state acceptance source baseline: `main@82043df7eb1d5e65bd4a7b3db2af6352979c9bf9`

Snapshot v3 Human Workbench recovery acceptance source baseline: `main@d4c7d8cf52d52e3a28293180a771d3b36f6e399f`

Current accepted active-database runtime: `0.1.0-beta.5` on schema `workbench-v2-5`, migration ledger `0008`. Jenn's single-user Readonly ChatGPT MCP App has passed real activity-database acceptance with manual Snapshot publishing.

## Product state

AI Video Production Workspace 已经越过概念验证：Workbench V2、WebGPT V4、真实 RunningHub 生成、审片、重生成、合成、交付、Memory 与媒体分析均有实现和测试。

系统当前适合 Jenn 的单人 Windows 本地生产与受控验证。Stabilization Release v2 已完成，PR #1–#7 均已合并：版本化数据库迁移、持久化 generation worker、媒体有界队列、完整 readiness、标准本地 preflight 和受保护的 Windows Workbench 生命周期控制均已实现。活动数据库已完成备份、迁移、`db:check`、隔离恢复演练与约四小时只读 soak；外部 OAuth/Tunnel 接线和 Windows 自动启动仍被冻结。

WebGPT V4 已收敛为默认 Readonly 的严格契约服务面：默认仅暴露六个 `projects.read` 工具；14 个 Full 工具均使用显式公共 DTO；大型上下文默认 Compact 并受 128 KiB 预算约束；离线 contract/eval、Widget v2 和可选低披露 JSONL Telemetry 均有故障路径测试。PR #25–#28 又完成 path-aware PRMD、readonly Descope JWT、migration `0007`、opaque principal、显式 production-project membership、append-only authorization event、active-owner readiness 与全局 8/每 principal 4 的 request admission。`webgpt-v4.2.0` 保留为 Beta 4 历史边界；当前接受服务版本为 `webgpt-v4.3.0`。

Readonly Federated OAuth 与 MCP App 单用户路线已经验收：migration `0008`、不可变 issuer binding、provider-neutral Federated config、严格 `scope`/`scp`、Auth0 predefined public-client、签名 Snapshot、Remote MCP Runtime、七个只读工具和 iframe Workbench 已完成真实活动库黄金路径。活动库迁移、`db:check`、业务核心 manifest、隔离恢复、手动发布、关闭—重开和有界 soak 均通过。Personal Readonly Operations 又完成了真实一键 preflight/publish、Snapshot fingerprint 一致性和七工具 owner-only 验收。Snapshot v3 进一步完成精确 Render 部署、旧 v2 拒绝、共享派生状态真实验收，以及 Render 重启后 `no_snapshot → Human Workbench 单次确认发布 → 七工具恢复` 的完整人工恢复路径。当前状态为 `JENN_SINGLE_USER_MCP_APP_PASS`、`MANUAL_PUBLISH_OPERATIONAL_READY` 和 `PARTIAL_MULTI_USER_GATE`；第二真实用户已由 Jenn 延期，自动同步与自动启动仍未验收。

Stabilization Remediation 已完成代码与门禁收敛：SR0/SR0.5 固定实施路线和测试选择双门禁；SR1 建立不可变 Blob 与原子 Artifact 绑定；SR2 收敛共享 Provider capability/pricing contract；SR3 建立媒体激活、字节校验和恢复门禁；SR4 修复跨 SHOT 引用、readiness 和旧再生旁路；SR5 冻结可执行的故障注入回归矩阵。上述实现已经通过 PR #15–#21 合入 `main@958df57`。

## Verified local baseline

- `npm run typecheck`: PASS under Node `22.23.1`
- `npm run build`: PASS under Node `22.23.1`
- Canonical `npm test`: PASS against isolated disposable databases；`npm run test:webgpt:v4`: 51/51；`npm run test:db`: 35/35；browser smoke: 9/9；Windows runtime smoke 覆盖 graceful stop、forced fallback 和最终 `db:check`
- Stabilization review remediation: PASS，包括未知 submit 人工核对、五对象终态收敛、完整 schema baseline、单一 migration lock、Legacy UI 退出和显式 legacy backfill
- `npm run preflight`: PASS on an isolated local profile
- FFmpeg/FFprobe 8.1.2: PASS，通过 WinGet Links 自动发现
- Workbench `/healthz`、`/readyz`: PASS；WebGPT 无 OAuth 时 `/readyz`: expected 503 fail closed
- Active database migration and read-only soak: PASS，属于 Jenn 本机的 local-only/untracked evidence，不是本仓库提交的公开 release artifact；本基线不把它宣称为可独立审计的仓库证据。需要复核时，请在本机用 Node `22.23.1` 重新执行 `npm run preflight`、`npm run db:check`、`npm run test:windows-runtime` 和只读 Workbench 验收路径。
- SR6 disposable Stage 1: PASS。使用 Node `22.23.1`、FFmpeg/FFprobe `8.1.2` 和完全隔离的 synthetic database，完成 fresh migration、`db:check`、一致性备份、隔离恢复、preflight 与两轮 Workbench 启停；逻辑 manifest 全程不变。公开脱敏证据见 [SR6 Disposable Database Acceptance](ops/reports/2026-07-13-sr6-disposable-acceptance.md)。
- SR6 active-database Stage 2: PASS。经 Jenn 明确授权，活动库完成双重迁移前备份、`0005`/`0006` 迁移、`db:check`、迁移后备份、隔离恢复、核心记录一致性比较、两轮只读黄金路径和 10 分钟/20 次观察；最终 manifest 保持稳定。公开脱敏证据见 [SR6 Active Database Acceptance](ops/reports/2026-07-13-sr6-active-database-acceptance.md)。
- Owner-only operations acceptance: PASS。基于 `main@932e145e201ddf5763ab5fcbdc11b88fa8c81bad`，在 Windows Node `22.23.1`、Provider 关闭和活动库 ledger `0008` 条件下完成 Human Workbench 一键 preflight/publish、远端健康检查、七工具低披露验收与最终 `db:check`；脱敏证据见 [Owner-Only Operations Acceptance](ops/reports/2026-07-18-owner-only-operations-acceptance.md)。
- Snapshot v3 derived-state acceptance: PASS。基于 `main@82043df7eb1d5e65bd4a7b3db2af6352979c9bf9` 精确部署，确认新进程为 `no_snapshot`、旧 v2 契约稳定拒绝，随后只发布一次 v3 Snapshot；七工具、Workbench、统一 fingerprint、共享派生状态和最终 `db:check` 均通过。脱敏证据见 [Snapshot v3 Derived State Acceptance](ops/reports/2026-07-19-snapshot-v3-derived-state-acceptance.md)。
- Snapshot v3 Human Workbench recovery acceptance: PASS。基于 `main@d4c7d8cf52d52e3a28293180a771d3b36f6e399f`，真实执行 Render restart、确认 `no_snapshot`、通过 Human Workbench UI 单次确认发布，并恢复远端 readiness 与七工具；最终 `db:check` 通过且本地 Workbench 优雅停止。脱敏证据见 [Snapshot v3 Human Workbench Recovery Acceptance](ops/reports/2026-07-19-snapshot-v3-human-workbench-recovery-acceptance.md)。

Remote CI evidence: PR #9–#13、Remediation PR #15–#21、SR6 PR #22、Hotfix PR #23 以及 Descope readonly PR #25–#29 均已合并；这些实现 PR 保持 Windows `Quality and integration` 与 `Browser smoke` 门禁。PR2 establishes the Windows Node 22 CI baseline; every future PR must retain that gate.

## Accepted Beta 3 boundary

- `0.1.0-beta.2` 的运行实现快照为 `main@fbba4ce`，Closeout 位于 `main@de8c2cd`，保留为迁移前回退证据。
- `0.1.0-beta.3`、`webgpt-v4.1.1` 和 `workbench-v2-5` 已通过 SR6 disposable Stage 1 与经授权的 active-database Stage 2，构成 Beta 4 验收前的上一版活动库基线。
- 不创建 Git tag、不发布 package、不执行 release 或 deploy。
- Auth0、Secure MCP Tunnel、媒体公网 HTTPS、Windows 自动启动和真实 Provider canary 均继续冻结；是否进入任何一项由 Jenn 另行决定和授权。

## Accepted Beta 4 boundary

- Package 为 `0.1.0-beta.4`，MCP service 为 `webgpt-v4.2.0`；仍是 WebGPT V4，不建立 V5 alias。
- Readonly 使用 Descope OAuth 配置和本地 project membership；Full 保留 legacy Auth0 单用户能力，不在本次外部化。
- migration `0007` 已通过 fresh/0006-copy/idempotency/schema-drift 测试，并经 Jenn 明确授权应用到活动数据库。
- 活动库完成迁移前后备份、`db:check`、业务核心 manifest 比较、隔离恢复、两轮只读启动和 10 分钟/20 次观察；脱敏证据见 [Beta 4 Active Database Acceptance](ops/reports/2026-07-14-beta4-active-database-acceptance.md)。
- 外部 Descope tenant、ChatGPT connector、Secure MCP Tunnel 和真实多用户黄金路径尚未配置或验收；Beta 4 的本地运行验收不等于外部多用户 readiness。
- 不创建 Git tag、不发布 package、不执行 release 或 deploy。

## Accepted Beta 5 MCP App boundary

- Package 为 `0.1.0-beta.5`，MCP service 为 `webgpt-v4.3.0`，Remote App service 保持 `readonly-remote-v1.0.0`。
- 经 Jenn 明确授权，活动库从 ledger `0007` 迁移至 `0008`；旧 Descope 授权记录完整保留并绑定原 issuer，新 Auth0 owner 使用不可变 issuer binding。
- 活动库与隔离恢复副本均通过 `db:check`；迁移前后业务核心 manifest 完全一致，Snapshot 发布和七工具调用未写回活动库。
- ChatGPT Test App 完成 OAuth、七工具、五个 Workbench 面板、关闭—重开和 60 秒/5 次 readiness soak。
- 当前状态是 `JENN_SINGLE_USER_MCP_APP_PASS`、`MANUAL_PUBLISH_OPERATIONAL_READY`、`PARTIAL_MULTI_USER_GATE`。
- Render Free 可能休眠或重启并清空内存 Snapshot；Snapshot TTL 为 24 小时，因此当前路线要求手动重新发布。
- Human Workbench 的一键 preflight/publish 与 Snapshot v3 冷启动恢复均已完成真实 owner-only 验收：Render restart 后观察到 `no_snapshot`，Human Workbench 单次确认发布恢复 readiness 与七工具。该路径仍是人工操作，不代表自动同步或自动启动。
- ChatGPT developer-mode 验收未开启平台 CSP enforcement 开关；资源自身的 CSP 契约有自动化测试，但平台强制 CSP 仍是外部实测限制。
- 不创建 Git tag、不发布 package、不执行 release 或额外部署。

## Stabilization policy

- Freeze WebGPT V5, Workbench V3 and new providers.
- Preserve human confirmation, cost acknowledgement, idempotency and fail-closed behavior.
- Prefer compatibility-preserving internal seams before physical repository restructuring.
- Keep historical evidence readable, but remove historical execution paths from the production command surface.
- Do not perform live Provider calls during stabilization acceptance.

## Remaining external gates

- GPT hardening PRs retain the Windows Node 22 + FFmpeg 8.1.2 CI and browser-smoke gates.
- Single-user Auth0/ChatGPT MCP App access is accepted; Jenn deferred the second real-user and revoke path, so it remains `PARTIAL_MULTI_USER_GATE` without blocking owner-only operations.
- Manual Snapshot publish is accepted; automatic synchronization and Windows auto-start remain separate gates.
- The Personal Readonly Operations surface provides Human Workbench status, explicit readonly preflight and a confirmed real one-click publish path. Its freshness projection uses stable reason codes for fresh, two-hour renewal window, `no_snapshot`, expiry and remote failure; UI status polling remains read-only and never triggers a publish. Snapshot v3 has passed Render restart, `no_snapshot`, one confirmed Human Workbench replacement and seven-tool recovery. Automatic synchronization, Windows auto-start and multi-user acceptance remain separate gates.
- Keep Full profile externalization, public media, real Provider canary, WebGPT V5, Workbench V3 and new Providers outside this release.
- Do not make a paid Provider call as part of this closeout.
