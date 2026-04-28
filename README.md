# Claude OAuth Relay

一个独立的 Node.js 服务，用来把 Claude Code 风格的请求转发到不同上游账号。

它不是 CRS 的通用多供应商代理，而是把当前 Claude Code 的 first-party 行为单独抽出来，做成一层更干净、可本地托管的兼容 relay。

当前内置了三类账号：

- `claude-official`
  - Claude 官方 OAuth
  - 覆盖 Claude Code 常见 first-party HTTP / WebSocket 路径
- `openai-codex`
  - Codex / ChatGPT OAuth
  - 当前支持透传 OpenAI Codex `/v1/responses` 风格请求到 ChatGPT Codex 上游
- `openai-compatible`
  - API key 模式的 OpenAI-compatible 上游
  - 当前只支持 `/v1/chat/completions`

当前策略已经从“按 allowlist 补常见 header”改成“除鉴权替换和内部控制参数外，尽量原样透传 Claude Code 发来的应用层请求信息”。

同时会对 first-party 路径做方法级校验；路径命中但方法不匹配时，会直接返回 `405 Method Not Allowed`，不会把异常方法继续转发到上游。

## 目标

- 处理 Claude Code 风格请求到不同上游账号的兼容转发
- 修正 CRS 已确认的 OAuth 兼容性问题
- 代理 Claude 官方账号的常见 first-party Anthropic 端点
- 为 `openai-codex` / `openai-compatible` 提供最小可用的 OpenAI 协议透传层
- 支持多账号本地加密存储、固定默认账号、sticky session 和强制指定账号

## 相比 CRS 已修正的问题

- OAuth token URL 改为当前 Claude Code 使用的 `https://platform.claude.com/v1/oauth/token`
- OAuth scope 改为当前 Claude Code 的完整集合：
  - `user:profile`
  - `user:inference`
  - `user:sessions:claude_code`
  - `user:mcp_servers`
  - `user:file_upload`
- refresh token 时会显式请求完整 scope，避免老 token 刷新后仍缺 MCP / 文件能力
- 上游返回 `401` 或 `403 + OAuth token has been revoked` 时，只会 refresh 当前账号，不会自动切到其他账号
- 会尽量原样透传 Claude Code 发来的请求头和请求体，不再只依赖固定 allowlist

## 当前支持的上游路径

按 provider 划分：

- `claude-official`
  - 支持下述全部 HTTP / WebSocket 路径
- `openai-codex`
  - 仅支持 HTTP: `/v1/responses`、`/v1/responses/*`
  - 暂不支持 Claude WebSocket 路径，也不支持 Claude 专有 bootstrap / profile / files / session API
- `openai-compatible`
  - 仅支持 HTTP: `/v1/chat/completions`
  - 暂不支持 Claude WebSocket 路径，也不支持 Claude 专有 bootstrap / profile / files / session API

HTTP:

- `/v1/messages`
- `/v1/messages/count_tokens`
- `/v1/files/*`
- `/v1/mcp_servers*`
- `/v1/ultrareview/*`
- `/v1/environment_providers/*`
- `/v1/environments/*`
- `/v1/sessions/*`
- `/v1/session_ingress/*`
- `/v1/code/*`
- `/v1/oauth/hello`
- `/api/hello`
- `/api/oauth/*`
- `/api/claude_cli/*`
- `/api/claude_cli_profile`
- `/api/claude_cli_feedback`
- `/api/claude_code/*`
- `/api/claude_code_grove`
- `/api/claude_code_penguin_mode`
- `/api/claude_code_shared_session_transcripts`
- `/api/event_logging/*`
- `/api/organization/claude_code_first_token_date`

WebSocket:

- `/v1/sessions/ws/{sessionId}/subscribe`
- `/v1/session_ingress/ws/{sessionId}`
- `/v1/code/upstreamproxy/ws`
- `/api/ws/speech_to_text/voice_stream`

这意味着它不只是能转 `messages`，还覆盖了当前 Claude Code 运行期常见的 profile / bootstrap / metrics / files / remote session / trigger / environment / WebSocket 会话链路。

## 运行

1. 安装依赖

```bash
pnpm install
```

2. 复制环境变量

```bash
cp .env.example .env
```

3. 启动开发模式

```bash
pnpm dev
```

4. 或构建后启动

```bash
pnpm build
pnpm start
```

## 环境变量

必填：

- `ADMIN_TOKEN`
- `DATABASE_URL` — Postgres 连接串，用于 token store、usage analytics、relay user 管理、session route / handoff 持久化
- `ADMIN_UI_SESSION_SECRET` — 至少 16 字节，用于签发 admin UI session cookie

常用可选：

- `REQUEST_TIMEOUT_MS`
- `API_TIMEOUT_MS`
- `UPSTREAM_REQUEST_TIMEOUT_MS`
- `UPSTREAM_PROXY_URL`
- `STICKY_SESSION_TTL_HOURS`
- `ACCOUNT_ERROR_COOLDOWN_MS`
- `ANTHROPIC_API_BASE_URL`
- `OAUTH_AUTHORIZE_URL`
- `OAUTH_TOKEN_URL`
- `OAUTH_MANUAL_REDIRECT_URL`
- `OAUTH_CLIENT_ID`
- `OPENAI_CODEX_OAUTH_ISSUER`
- `OPENAI_CODEX_OAUTH_CLIENT_ID`
- `OPENAI_CODEX_OAUTH_REDIRECT_URL`
- `OPENAI_CODEX_API_BASE_URL`
- `OPENAI_CODEX_MODEL`
- `MIN_CLAUDE_VERSION`
- `ADMIN_UI_ALLOWED_EMAILS`
- `ADMIN_UI_ALLOWED_EMAIL_DOMAINS`
- `ADMIN_UI_ALLOWED_ORIGINS`
- `RELAY_LOG_ENABLED`
- `RELAY_CAPTURE_ENABLED`
- `RELAY_CAPTURE_BODY_MAX_BYTES`
- `BODY_REWRITE_SKIP_LOG_ENABLED`
- `VM_FINGERPRINT_TEMPLATE_PATH`
- `BODY_TEMPLATE_PATH`
- `BODY_TEMPLATE_NEW_PATH`

多租户路由与保护阈值：

- `ROUTING_USER_MAX_ACTIVE_SESSIONS`
- `ROUTING_DEVICE_MAX_ACTIVE_SESSIONS`
- `ROUTING_BUDGET_WINDOW_MS`
- `ROUTING_USER_MAX_REQUESTS_PER_WINDOW`
- `ROUTING_DEVICE_MAX_REQUESTS_PER_WINDOW`
- `ROUTING_USER_MAX_TOKENS_PER_WINDOW`
- `ROUTING_DEVICE_MAX_TOKENS_PER_WINDOW`
- `DEVICE_AFFINITY_LOOKBACK_HOURS`
- `DEVICE_AFFINITY_MIN_SUCCESSES`
- `DEVICE_AFFINITY_FAILURE_PENALTY_MS`

调度与保活：

- `DEFAULT_MAX_SESSIONS_PER_ACCOUNT`
- `ACCOUNT_MAX_SESSION_OVERFLOW`
- `DEFAULT_ACCOUNT_GROUP`
- `HEALTH_WINDOW_MS`
- `HEALTH_ERROR_DECAY_THRESHOLD`
- `RATE_LIMIT_AUTO_BLOCK_COOLDOWN_MS`
- `SAME_REQUEST_SESSION_MIGRATION_ENABLED`
- `ACCOUNT_KEEPALIVE_ENABLED`
- `ACCOUNT_KEEPALIVE_INTERVAL_MS`
- `ACCOUNT_KEEPALIVE_REFRESH_BEFORE_MS`
- `ACCOUNT_KEEPALIVE_FORCE_REFRESH_MS`

详细示例见 [`.env.example`](./.env.example)。

## Relay User 与会话路由

配置 `DATABASE_URL` 后，relay 会额外启用一套面向“下游真实用户”的本地路由层：

- `/admin/users` 管理 API 与管理台用户页
- 每个 relay user 的独立 `rk_...` API key
- 按 user / client device 维度的请求、token、session 统计
- session route、handoff 摘要、设备亲和（device affinity）与 routing guard

创建 user 后，客户端把返回的 API key 作为本地 relay 鉴权发送：

```http
Authorization: Bearer rk_xxx...
X-Claude-Code-Session-Id: session-123
X-Relay-Client-Device-Id: macbook-pro-01
```

说明：

- `Authorization: Bearer rk_...` 只在 relay 本地识别，不会透传到上游 Anthropic
- relay 识别到 relay user key 后，会按该 user 的 routing mode 选账号，再为需要 OAuth 的路径注入真正的上游 Bearer token
- `X-Claude-Code-Session-Id` 仍然是 session route 复用的主键；WebSocket `/v1/sessions/ws/*` 也会复用同一条路由
- `client device id` 会优先从请求 body 的 `metadata.user_id.device_id` 提取，没有时回退到 `x-client-device-id`、`x-relay-client-device-id` 或 `client_device_id` query 参数
- 当 user 或 device 超过本地 guard 阈值时，relay 会直接返回 `429`，避免把热点流量继续压到上游账号池

## VM 指纹模板

如果你的部署策略是“每个 VM 一个上游账号”，并且同一个账号会被多个真实用户共享，建议开启 VM 级指纹模板，让上游长期看到的是一套固定的本机 Claude Code 机器特征，而不是把所有用户的 `User-Agent` / `x-stainless-*` 全量混上去。

配置方式：

1. 先抓一条真实请求

```bash
RELAY_CAPTURE_ENABLED=true claude -p '只回复 pong'
```

2. 从 relay 日志提取模板

```bash
node --import tsx src/tools/extractVmFingerprintTemplate.ts /path/to/relay.log > vm-fingerprint.template.json
```

3. 在 `.env` 里启用

```bash
VM_FINGERPRINT_TEMPLATE_PATH=./vm-fingerprint.template.json
```

模板只会固定少数“机器指纹头”，包括：

- `User-Agent`
- `x-app`
- `x-stainless-lang`
- `x-stainless-package-version`
- `x-stainless-os`
- `x-stainless-arch`
- `x-stainless-runtime`
- `x-stainless-runtime-version`
- `anthropic-version`
- `accept-language`
- `accept-encoding`
- `sec-fetch-mode`

`anthropic-beta` 不由模板管理，而是硬编码在 `headerPolicy.ts` 中，所有请求统一注入。

不会固定的字段包括：

- `Authorization`
- `X-Claude-Code-Session-Id`
- `content-length`
- `host`
- `connection`

## 管理接口

所有 `/admin/*` 接口都需要：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

### OAuth 登录

`POST /admin/oauth/generate-auth-url`

请求体：

```json
{
  "expiresIn": 3600
}
```

返回 `sessionId`、`authUrl`、`redirectUri`、`scopes`。

`POST /admin/oauth/exchange-code`

请求体：

```json
{
  "sessionId": "uuid",
  "authorizationInput": "https://platform.claude.com/oauth/code/callback?code=...&state=...",
  "label": "main-max"
}
```

`POST /admin/oauth/login-with-session-key`

请求体：

```json
{
  "sessionKey": "your-claude-ai-sessionKey",
  "label": "backup-pro"
}
```

### 账号池管理

- `GET /admin/account`
  - 兼容旧接口，返回 `account` 和 `accounts`
- `GET /admin/accounts`
  - 返回全部账号
- `GET /admin/accounts/:accountId`
  - 查看单个账号
- `POST /admin/accounts/:accountId/refresh`
  - 刷新指定账号
- `POST /admin/oauth/refresh`
  - 不带 `accountId` 时刷新全部活跃账号
  - 带 `{"accountId":"..."}` 时只刷新指定账号
- `POST /admin/accounts/:accountId/delete`
  - 删除指定账号
- `POST /admin/account/clear`
  - 清空整个账号池和 sticky session

### Sticky Session 管理

- `GET /admin/sticky-sessions`
  - 查看当前 sticky session 绑定
- `POST /admin/sticky-sessions/clear`
  - 清空全部 sticky session

### Relay User 管理

以下接口依赖 `DATABASE_URL`，未配置时会返回 `404 user_management_disabled`。

- `GET /admin/users`
  - 列出全部 relay users 及聚合 usage
- `POST /admin/users`
  - 创建 user，返回 `user` 与一次性明文 `apiKey`
- `GET /admin/users/:userId`
  - 查看单个 user
- `GET /admin/users/:userId/api-key`
  - 查看当前主 key 来源；当主路径为 `relay_api_keys` 时返回 active key 元数据，legacy 明文只作为兼容字段保留
- `POST /admin/users/:userId/update`
  - 更新 `name`、`isActive`、`routingMode`、`accountId`、`preferredGroup`
- `POST /admin/users/:userId/regenerate-key`
  - 重新生成 API key，旧 key 立即失效
- `POST /admin/users/:userId/delete`
  - 删除 user
- `GET /admin/users/:userId/sessions`
  - 查看该 user 的 session routes、当前账号、handoff 状态与 burn 信息
- `GET /admin/users/:userId/requests`
  - 分页查看该 user 最近请求
- `GET /admin/users/:userId/sessions/:sessionKey/requests`
  - 查看某个 session 的请求历史
- `GET /admin/users/:userId/requests/:requestId`
  - 查看单条请求的 headers / body preview / response detail

## 一致性优先策略

### 固定默认账号

- 默认按 `createdAt` 最早、`id` 字典序兜底的稳定规则选出一个默认账号
- 只在客户端没带 `Authorization`，或你显式指定 `force_account` 时，才会使用这个固定默认账号
- 默认账号在 refresh 失败、被吊销或处于错误状态时，请求会直接失败，不会自动切到其他账号
- 如果你之前已经跑过旧版轮换逻辑，建议先调用 `/admin/sticky-sessions/clear`，把历史 sticky 绑定清掉后再验证一致性

### 鉴权透传规则

- 如果客户端请求本来就带了 `Authorization`，relay 默认优先原样透传，不主动替换
- 只有在客户端没带 `Authorization` 时，relay 才会回退到本地存储的账号 OAuth token
- `force_account` 是唯一的显式覆盖开关；带了它就按指定账号改写 `Authorization`
- 某些 first-party 路径必须保留来路鉴权，不会改写为账号 OAuth，例如：
  - `/v1/session_ingress/*`
  - `/v1/sessions/{id}/events`
  - `/v1/environments/{id}/work/poll`
  - `/v1/environments/{id}/work/{workId}/ack`
  - `/v1/environments/{id}/work/{workId}/heartbeat`
  - `/v1/code/sessions/{id}/worker*`
- 某些路径按 Claude Code 的原始行为不会带鉴权，relay 也会显式去掉，例如：
  - `/v1/code/upstreamproxy/ca-cert`
  - `/api/hello`
  - `/v1/oauth/hello`

### Sticky Session

- 读取 `X-Claude-Code-Session-Id`，没有时退回 `x-claude-remote-session-id`
- 同一个 session 会优先复用同一个账号
- sticky session 绑定的账号如果当前不可用，请求会直接失败，不会自动改绑到别的账号
- sticky session 会按 `STICKY_SESSION_TTL_HOURS` 过期

### 强制指定账号

可通过 header 或 query 参数强制指定本次请求走哪个账号：

```http
x-force-account: claude-official:<accountId>
```

或者：

```text
?force_account=claude-official:<accountId>
```

也支持：

- `x-force-account: openai-codex:<accountId>`
- `x-force-account: openai-compatible:<accountId>`
- 直接传裸 `accountId`

`force_account` 只在 relay 内部使用，不会透传到上游 Anthropic。

## 代理用法

服务启动后，直接把请求发到本服务即可，路径保持 Anthropic first-party 原样，例如：

```bash
curl http://127.0.0.1:3560/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'X-Claude-Code-Session-Id: test-session' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

服务会自动：

- 客户端已带 `Authorization` 时，优先原样透传该鉴权
- 客户端没带 `Authorization` 时，对需要账号 OAuth 的路径注入 Bearer OAuth access token
- 只在使用本地账号 OAuth 的请求上做 refresh
- 只在使用本地账号 OAuth 的请求上处理 401 / revoked token 的自愈刷新
- 同一会话优先复用 sticky 账号
- 默认不做自动换号；当前账号不可恢复时直接返回上游认证失败
- 除 `Authorization` 和内部控制参数 `force_account` / `x-force-account` 外，尽量原样转发应用层 header 与 body
- 对 `/v1/code/sessions/{id}/worker*` 保留客户端自带的 session ingress auth，不覆盖为账号 OAuth token
- 对 `/v1/session_ingress/ws/*` 和 `/v1/code/upstreamproxy/ws` 保留客户端自带的 session token auth
- 对 `/v1/sessions/ws/*` 和 `/api/ws/speech_to_text/voice_stream`，有来路鉴权时原样透传；无来路鉴权时才回退到本地账号 OAuth

## 最小观测

- 默认输出一行一条的 JSON 结构化日志
- 会记录 `requestId`、method、target、authMode、accountId、statusCode、durationMs、上游 `request-id` / `cf-ray`
- HTTP 会区分 `http_completed`、`http_rejected`、`http_failed`
- WebSocket 会区分 `ws_opened`、`ws_rejected`、`ws_closed`
- 如需关闭日志，可设置 `RELAY_LOG_ENABLED=false`

## 一致性边界

如果你的目标是“发给 Anthropic 的每一份应用层信息都一致”，当前 relay 已经尽量逼近这个目标：

- HTTP 请求会保留原始 path、query、body 字节，以及绝大多数原始 request headers
- 重复 header 会继续按原始顺序转发
- WebSocket 会保留应用层自定义 header、subprotocol、消息内容和关键 101 响应头
- 1P 响应头里和配额/恢复逻辑相关的 `anthropic-ratelimit-unified-*`、`x-last-uuid`、`retry-after` 等也会继续透传

但以下内容不能做到字节级全等，这是代理层天然边界：

- `Host`、`Connection`、`Upgrade`、`Transfer-Encoding` 一类 hop-by-hop 头会由代理或底层库重建
- WebSocket 的 `Sec-WebSocket-Key`、`Sec-WebSocket-Accept`、底层扩展协商属于新的连接握手，不可能与客户端原始连接完全相同
- TCP/TLS 指纹、连接时序、HTTP 连接复用行为也不可能与直连完全一致
- 如果你配置了多个账号，默认只会使用固定默认账号；只有显式 `force_account` 或既有 sticky 绑定时，`Authorization` 才可能来自别的账号

## 超时策略

- `REQUEST_TIMEOUT_MS` 仍用于本地 OAuth 登录、profile、refresh 一类服务端管理请求，默认 `30000`
- `API_TIMEOUT_MS` 或 `UPSTREAM_REQUEST_TIMEOUT_MS` 用于 relay 到 Anthropic 的上游代理超时，默认 `600000`
- 如果两个都设置，优先使用 `API_TIMEOUT_MS`

## 上游代理

- relay 到 Anthropic 的 HTTP 和 WebSocket 出站，默认会走 `http://127.0.0.1:10808`
- 这适合当前机器上已经跑着的本地 xray 出站代理
- 如果你要临时绕过代理，可设置 `UPSTREAM_PROXY_URL=direct`
- 如果你要切到别的代理口，也可以直接改成别的本地 `http://host:port`

## 存储

- 全部持久化都走 Postgres（`DATABASE_URL` 必填）
- 一张库里保存账号、多账号池、sticky session、usage、relay users、session routes 与 handoff 记录
- 首次启动会自动建表与补齐缺失字段

## 后续可扩展项

- 基于权重或优先级的调度策略
- 全局 / 每账号出站代理
- 更细粒度的路径 allowlist
- 审计日志与请求转储
- PM2 / systemd 部署模板
