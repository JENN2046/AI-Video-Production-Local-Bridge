# WebGPT V4 本地运行与外部接线手册

状态：接受的本地运行基线仍为 `webgpt-v4.2.0`；仓库候选运行时已建立 provider-neutral Federated OAuth、issuer binding 与安全 discovery/JWKS transport。外部 IdP/ChatGPT connector、Secure MCP Tunnel、媒体域名和 Windows 自动启动尚未通过新路线验收。

## 固定边界

- MCP：`127.0.0.1:2091/mcp`
- 媒体：`127.0.0.1:2092`
- 数据源：V2 SQLite
- 可见范围：仅 `classification=production`
- Readonly：仅显式 membership 授权的 production 项目可见；owner/viewer 均只有六个 `projects.read` 工具
- Full：保留既有 SHOT 文案、审片注记、工作台提议和未确认 generation intent；必须显式设置 `WEBGPT_V4_PROFILE=full`
- 禁止：Provider 请求、上传、费用确认、生成提交、采纳、合成、交付、删除、任意文件读取

## 本地命令

```powershell
npm run db:migrate
npm run migrate:webgpt:v4
npm run auth:webgpt -- list --db <explicit-database-path>
npm run preflight -- --profile=webgpt
npm run preflight:webgpt:oauth
npm run test:webgpt:v4
npm run start:webgpt
```

普通 `preflight` 和 `/readyz` 证明本地服务边界，不代表 ChatGPT 已接受外部 OAuth discovery。外部 Readonly 接线前必须另外运行 `preflight:webgpt:oauth`；这个独立命令不打开数据库，先按 RFC 8414 规则从 issuer 推导 metadata URL，不可用时再尝试 OIDC discovery。两条路径都要求匿名 `200`、精确 issuer、精确 JWKS URI、HTTPS authorize/token/JWKS、PKCE S256 与 public client token auth `none`；`cimd` 还要求 CIMD capability，`dcr` 还要求 HTTPS registration endpoint，`predefined` 把外部 Client ID 验证保留给真实连接验收。

Discovery 与运行时 JWKS refresh 共用 DNS-pinned HTTPS transport：拒绝 loopback/private/link-local/multicast/reserved 地址和混合公私 DNS 结果，禁止 redirect，单次超时 10 秒，metadata/JWKS 上限 256 KiB。若且仅若系统 DNS 的全部结果都落在 RFC 2544 benchmark 范围 `198.18.0.0/15`，transport 才通过固定的公共 DoH endpoint 重新查询 A/AAAA；DoH 请求自身使用 bounded pinned HTTPS，响应必须匹配原问题和受控 CNAME 链，恢复地址仍要通过完整的公有地址校验并固定到实际 TLS 请求。普通 private/mixed/畸形 DNS 结果不会触发 fallback。任何注入测试 transport 都必须接收已验证的 pinned address；普通 injected `fetch` 或代理不能替代这个边界。探针不发送 credential，也不输出 endpoint identifier 或 response body。Descope vendor-appended metadata 仅进入 legacy 诊断，不能把标准 discovery 失败提升为 PASS。

探针公共结果只使用以下稳定 code：`OAUTH_DISCOVERY_COMPATIBLE`、`OAUTH_DISCOVERY_FETCH_FAILED`、`OAUTH_DISCOVERY_STANDARD_METADATA_UNAVAILABLE`、`OAUTH_DISCOVERY_ISSUER_MISMATCH`、`OAUTH_DISCOVERY_PKCE_S256_MISSING`、`OAUTH_DISCOVERY_PUBLIC_CLIENT_UNSUPPORTED`、`OAUTH_DISCOVERY_CIMD_MISSING`、`OAUTH_DISCOVERY_DCR_MISSING`、`OAUTH_DISCOVERY_JWKS_MISMATCH`、`OAUTH_DISCOVERY_UNSAFE_IDENTIFIER`、`OAUTH_DISCOVERY_UNSAFE_NETWORK_TARGET`、`OAUTH_DISCOVERY_RESPONSE_TOO_LARGE`、`OAUTH_DISCOVERY_INVALID_JSON`。输出只包含布尔检查、HTTP status、所用标准路径类型和注册状态，不包含实际 URL 或 metadata body。

未配置 OAuth 时，服务仍可启动用于本机健康检查，但 `/readyz` 返回 `503`，`/mcp` 拒绝所有调用。这是预期的 fail-closed 状态。

```text
GET http://127.0.0.1:2091/healthz
GET http://127.0.0.1:2091/readyz
GET http://127.0.0.1:2091/.well-known/oauth-protected-resource
GET http://127.0.0.1:2092/healthz
```

## 数据迁移

- `review_assistant_drafts.json` 与 `production_assistant_plans.json` 只读。
- 历史记录以 `source=legacy_webgpt`、`status=closed` 迁入 `workbench_drafts`。
- 迁移键写入 `m0_meta`，重复运行不会重复插入。
- 源 JSON 的 SHA-256 必须与备份一致。
- 每次 V4 服务启动都会清空未过期媒体票据，因此重启后旧播放 URL 必然失效。

## 旧入口

4182–4186 和 R2G-L 的脚本已冻结为只读历史证据，不再作为公共 npm command 或监听端口。

旧入口不得恢复写能力。V4 是唯一允许连接 ChatGPT 的生产辅助面。

## 外部授权清单

以下四组均属于外部连接或生产配置，执行前需要 Jenn 单独确认目标、范围和回滚方式。

### Federated Readonly

- 通用配置使用 `WEBGPT_V4_READONLY_OAUTH_ISSUER`、`WEBGPT_V4_READONLY_OAUTH_AUDIENCE`、`WEBGPT_V4_READONLY_OAUTH_JWKS_URI` 和显式 `WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION`
- issuer 同时是 PRMD authorization server 与 JWT `iss`；audience 必须与 `WEBGPT_V4_RESOURCE_URL` 完全相同
- IdP 只认证身份；本地 issuer-bound principal/membership 始终是 production-project 授权权威
- Auth0 Stage 0 标准能力探针已通过：RFC 8414 metadata、精确 issuer/JWKS、PKCE S256、public-client `none` 与 Resource Parameter Compatibility Profile 均满足；新 API/client、ChatGPT redirect、真实 token audience/scope 和双用户路径仍未验收，因此仍是 `PARTIAL_EXTERNAL_GATE`
- 运行时保持 provider-neutral，不允许根据 Stytch/Descope 品牌绕过 issuer、audience、JWKS、scope 或 membership

### Descope Readonly（legacy adapter）

- 目标 Descope project、MCP Server Resource、Agentic Client、issuer、resource audience 与显式 HTTPS JWKS URI
- 旧 Descope 配置固定为 `cimd` legacy adapter；vendor-specific metadata 只能提供诊断，不能声明 portability-compatible
- ChatGPT connector 只申请 `projects.read`
- principal 由 issuer 与 subject 派生为不可逆 SHA-256；不保存原始 subject 或邮箱
- 先在活动库副本验证 migration `0008`，再经单独授权迁移活动库并 bootstrap issuer-bound first owner
- 回滚：停止 connector/Tunnel，撤销 membership 或禁用 principal；不删除 authorization event

### Full/Auth0（独立后续 gate）

- 目标 Auth0 tenant 和 API audience
- 既有单用户 Full Application 边界
- Jenn 账户的允许主体；仓库仅保存主体 SHA-256，不保存明文主体
- scopes：`projects.read`、`media.read`、`shots.write`、`reviews.write`、`proposals.write`、`generation.prepare`
- ChatGPT App 权限设为“修改前询问”
- 回滚：撤销 Application/API 授权并移除本机 V4 环境配置

### Secure MCP Tunnel

- 指定个人 ChatGPT/Platform 组织
- Tunnel 名称和本机目标 `http://127.0.0.1:2091/mcp`
- 仅本机出站 HTTPS，不创建公网入站端口
- 回滚：停止 tunnel-client、撤销 Tunnel、删除自动启动任务

### 媒体域名

- 独立 HTTPS hostname，仅反向代理 `127.0.0.1:2092`
- 允许的 ChatGPT widget origin
- 反向代理前的登录回调必须建立 Auth0 校验后的 `Secure; HttpOnly; SameSite=None` 媒体会话 Cookie；默认名为 `__Host-webgpt_v4_media`，可用 `WEBGPT_V4_MEDIA_AUTH_COOKIE_NAME` 覆盖
- 媒体网关同时校验当前 Auth0 主体与五分钟票据中的 `actor_hash`；仅有播放 URL 或票据不能跨用户播放
- 未配置媒体会话认证时，内容路由固定返回 `401`；`healthz` 仍可用于本机存活检查
- 不记录媒体票据查询参数
- 仅接受项目、Artifact、操作者绑定的五分钟票据，支持单个 HTTP Range
- 回滚：撤销 hostname/route，停止媒体代理；本机源媒体不变

### Windows 自动启动

- 两个独立任务：V4 服务、tunnel-client
- 固定工作目录、非明文配置来源和退避重启策略
- 不读取或打印凭证、token、cookie、原始 Provider payload
- 回滚：禁用并删除两个任务，不删除数据库或媒体

## 验收顺序

1. 本地 V4 单元、MCP/Auth、媒体和元数据测试。
2. V2、H1、前端、浏览器与生产构建回归。
3. 对数据库副本验证 migration `0008`、issuer binding、owner bootstrap、viewer grant/revoke 和 immediate readiness failure。
4. 按 [Readonly Federated OAuth Portability v1](../READONLY_FEDERATED_OAUTH_PORTABILITY.md) 和 [Stytch Predefined Public Client Runbook](STYTCH_PREDEFINED_CLIENT_RUNBOOK.md) 完成新的 capability gate、`projects.read`、predefined public client、ChatGPT test App 与官方 Tunnel 隔离接线。旧 [External Multi-User Readonly Connection — Preflight](../EXTERNAL_MULTI_USER_READONLY_CONNECTION_PREFLIGHT.md) 仅保留为 Descope 历史路线证据。
5. 使用两个真实用户完成 Developer Mode 只读黄金提示集和跨项目拒绝验证。
6. Full/Auth0、写 scopes 和媒体域名分别制定新计划，不由 Readonly 验收自动开放。

任何阶段发现测试项目、未归属媒体或真实 Provider 请求，立即停止并撤销对应外部连接。数据库回滚必须使用开工前在线备份，并在执行前再次获得覆盖当前数据库的明确授权。
