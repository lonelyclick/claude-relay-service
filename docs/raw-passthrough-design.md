# Raw Passthrough P1 设计（收敛版）

> **目标**：把原始“任意客户端泛放开”方案收敛为一个可执行、可灰度、可快速回滚的 P1。P1 只解决最小闭环：在严格受控范围内，允许非标准 Claude Code 客户端通过 relay 使用 `claude-official` 的 OAuth 账号池访问 `POST /v1/messages` 与 `POST /v1/messages/count_tokens`，并且做到 **rewrite-or-reject**，绝不原样透传。

---

## 一、P1 范围与明确排除项

### 1.1 P1 仅覆盖以下流量

P1 只在同时满足以下条件时生效：

- provider 为 `claude-official`
- 上游鉴权模式为 relay 注入的本地 OAuth 账号池 `authMode=oauth`
- 路径为 `POST /v1/messages` 或 `POST /v1/messages/count_tokens`
- 命中 raw passthrough 开关与灰度选择器
- 命中显式 raw template

只有这类请求才进入 raw 分支；其余请求继续沿用现有逻辑。

### 1.2 P1 明确排除

以下能力 **不属于 P1**，不得在 P1 中“顺便支持”：

- `preserve_incoming_auth`
- WebSocket 全部路径
- `/api/event_logging/*`
- `/v1/files/*`
- `/v1/sessions/*`
- `/v1/code/*`
- `/v1/session_ingress/*`
- OpenAI body 兼容
- `claude-compatible` / `openai-compatible` / `openai-codex` provider
- `/v1/messages*` 之外的任何 HTTP 路径
- 客户端 system block 追加保留
- 未知客户端复用旧版 `BODY_TEMPLATE_PATH` / `BODY_TEMPLATE_NEW_PATH`

### 1.3 范围外流量的行为

- 范围外请求不进入 raw 分支。
- 现有版本校验、现有 body/template 重写、现有 OpenAI 兼容逻辑全部保持不变。
- P1 **不是**“全局关闭 `MIN_CLAUDE_VERSION`”；它只是对命中 raw 分支的消息接口做精确旁路。

---

## 二、P1 不可变约束

P1 必须同时满足以下硬约束：

1. **rewrite-or-reject**：命中 raw 分支后，只有两种结果。
   - 产出 template-canonical 的安全请求并发往 upstream
   - 在 relay 本地直接 reject

2. **绝不 fallback 原样透传**：任何解析失败、模板缺失、字段越界、模型不允许、header 危险信号，全部本地拒绝，不能把原始 body/header 发到 Anthropic。

3. **template 必须显式存在**：
   - raw 模式使用独立 raw template
   - raw template 必须包含 `block0Template`
   - 未知客户端不能套用旧版 CC template

4. **template-canonical system**：
   - P1 默认不保留客户端 `system`
   - upstream `system` 只能来自 template 生成
   - 如果未来要保留客户端 system，必须作为后续阶段的受限字段，不属于 P1 默认行为

5. **会话与元数据分离**：
   - 下游 session key 只用于 relay 内部 sticky/session route
   - 上游 `metadata.user_id.session_id` 必须由 relay 重新生成
   - 下游 session key 与上游 session id 不得共用

6. **原始敏感内容不得明文落盘**：
   - reject 时不记录原始 body 明文
   - raw 模式 capture 不保存客户端原始 `system` / `metadata.user_id` / `idempotency-key` 明文

---

## 三、P1 核心决策

### 3.1 精确开关，而不是全局放开

新增开关：

- `ALLOW_RAW_PASSTHROUGH=false`
- `RAW_PASSTHROUGH_REPORT_ONLY=false`
- `RAW_PASSTHROUGH_ENFORCE=false`
- `RAW_PASSTHROUGH_KILL_SWITCH=false`

其作用不是“全局关闭版本校验”，而是参与一个精确判断函数：

```ts
shouldUseRawPassthrough({
  allowRawPassthrough,
  provider,
  authMode,
  path,
  method,
  routeAuthStrategy,
  matchedCanary,
  hasRawTemplate,
})
```

只有当以下条件同时成立时，raw 分支才启用：

- `ALLOW_RAW_PASSTHROUGH=true`
- `provider === 'claude-official'`
- `authMode === 'oauth'`
- `routeAuthStrategy !== 'preserve_incoming_auth'`
- `method === 'POST'`
- `path === '/v1/messages' || path === '/v1/messages/count_tokens'`
- 命中 canary
- 命中 raw template

否则：

- 版本校验按原逻辑执行
- 非消息接口完全不受影响

#### 3.1.1 开关优先级

优先级从高到低如下：

1. `RAW_PASSTHROUGH_KILL_SWITCH`
2. provider / auth / method / path 范围判断
3. `ALLOW_RAW_PASSTHROUGH`
4. canary 命中判断
5. `RAW_PASSTHROUGH_ENFORCE`
6. `RAW_PASSTHROUGH_REPORT_ONLY`

解释：

- kill switch 是最高优先级的硬关闭，一旦开启，不做预演、不做 rewrite、不做 raw report。
- `ALLOW_RAW_PASSTHROUGH` 是 raw 功能族的主开关。它关闭时，`REPORT_ONLY` 和 `ENFORCE` 一律视为无效。
- `RAW_PASSTHROUGH_ENFORCE=true` 表示命中 raw 条件后进入真正的 rewrite-or-reject。
- `RAW_PASSTHROUGH_REPORT_ONLY=true` 只在 `ALLOW=true` 且 `ENFORCE=false` 时生效，表示执行预演并产出 report，但不改变线上行为。

#### 3.1.2 生效状态机

先判断是否命中 P1 范围：

- `provider === 'claude-official'`
- `authMode === 'oauth'`
- `routeAuthStrategy !== 'preserve_incoming_auth'`
- `method === 'POST'`
- `path === '/v1/messages' || path === '/v1/messages/count_tokens'`

只有范围命中后才继续看状态机。

#### 3.1.3 真值表

| `KILL_SWITCH` | `ALLOW` | `REPORT_ONLY` | `ENFORCE` | 生效模式 | 是否做 raw 预演 | 是否真正 rewrite/reject |
|---|---|---|---|---|---|---|
| false | false | false | false | disabled | 否 | 否 |
| false | false | true | false | disabled | 否 | 否 |
| false | false | false | true | disabled | 否 | 否 |
| false | false | true | true | disabled | 否 | 否 |
| false | true | false | false | disabled | 否 | 否 |
| false | true | true | false | report_only | 是 | 否 |
| false | true | false | true | enforce | 是 | 是 |
| false | true | true | true | enforce | 是 | 是 |
| true | false | false | false | killed | 否 | 否 |
| true | false | true | false | killed | 否 | 否 |
| true | false | false | true | killed | 否 | 否 |
| true | false | true | true | killed | 否 | 否 |
| true | true | false | false | killed | 否 | 否 |
| true | true | true | false | killed | 否 | 否 |
| true | true | false | true | killed | 否 | 否 |
| true | true | true | true | killed | 否 | 否 |

关键约束：

- `ALLOW=false + REPORT_ONLY=true` 时，**不执行任何预演**；这是显式禁用，而不是 shadow 模式。
- 若需要只做预演，必须使用 `ALLOW=true + RAW_PASSTHROUGH_REPORT_ONLY=true + RAW_PASSTHROUGH_ENFORCE=false`。
- `ENFORCE=true` 时默认仍然产出 `fingerprint_report`，因此表中“是否做 raw 预演”为“是”。

### 3.2 raw template 必须是独立模板

P1 不复用现有“按客户端版本选 template”的旧机制。raw 模式必须使用显式 raw template，例如：

```json
{
  "templateId": "raw-claude-oauth-v1",
  "supportedProvider": "claude-official",
  "supportedAuthMode": "oauth",
  "supportedPaths": ["/v1/messages", "/v1/messages/count_tokens"],
  "block0Template": "polling-header: cc_version=2.1.112.e61; cc_entrypoint=sdk-cli; cch=00000;",
  "systemBlocks": [
    { "type": "text", "cache_control": { "type": "ephemeral", "ttl": "1h" }, "text": "..." }
  ],
  "tools": [
    { "name": "Bash", "description": "..." }
  ],
  "anthropicBeta": "claude-code-20250219",
  "forcedModel": null,
  "allowedModels": ["claude-sonnet-4-5", "claude-opus-4-1"]
}
```

说明：

- `block0Template` 示例不再使用人为杜撰的 `x-raw-header`。
- 文档中的 `polling-header:` 仅用于说明 block0 的结构形态；**真实落地时必须直接来自真实 Claude Code 抓包模板**，不能手写虚构前缀。
- `anthropicBeta` 字段只承载“客户端指纹模板 beta”。必要 OAuth beta token 不放在 template 里，由 relay 在 headerPolicy 层单独强制追加，避免双来源重复。

约束：

- raw template 与旧版 `BODY_TEMPLATE_PATH` / `BODY_TEMPLATE_NEW_PATH` 分离
- `block0Template` 为必填项
- 不能通过客户端 `user-agent` 或 `system[0]` 自动推断 template
- 没有 raw template 时：
  - 若启用了 raw 模式并要求全局可用，服务启动失败
  - 若只在部分账号/灰度范围内启用，命中请求直接 reject

### 3.3 客户端 system 不作为 P1 默认输入

P1 的 `system` 策略固定为：

- upstream `system` 完全由 template 生成
- 客户端 `system` 缺失或空值可接受
- 客户端 `system` 非空时，默认 reject

原因：

- 追加客户端 `system` 会破坏 template-canonical 形状
- 静默丢弃客户端 `system` 会造成隐蔽语义偏差
- P1 优先选择确定性和可审计性

### 3.4 metadata.user_id 强制重建

P1 中 upstream metadata 只允许 relay 自己生成，不信任客户端输入：

```ts
metadata.user_id = JSON.stringify({
  device_id: account.deviceId,
  account_uuid: account.accountUuid,
  session_id: relayGeneratedUpstreamSessionId,
})
```

约束：

- 客户端 `metadata` 默认不透传
- 客户端 `metadata` 整体视为不可信输入，不能用于路由、亲和性、灰度命中或任何安全决策
- raw 模式下 **不得** 从客户端 `metadata.user_id` 提取 `clientDeviceId`
- 路由与亲和性只允许使用 header 信号或 relay 自生成/稳定映射信号
  - 例如显式 header：`x-client-device-id`、`x-relay-client-device-id`
  - 例如 relay 已有的 user/device 稳定映射、匿名设备稳定哈希
- 下游 sticky `sessionKey` 继续用于 relay 内部路由
- upstream `session_id` 必须是新的 relay 生成值

### 3.5 raw 模式下不透传客户端 beta

raw 模式中：

- `anthropic-beta` 采用单一归属规则：
  - raw template 只定义客户端指纹基线 beta
  - 必要 OAuth beta token 只由 relay 强制追加
- relay 追加时必须做去重，确保每个 token 在最终 header 中只出现一次
- 客户端传入的 beta token 不 forward
- 允许把客户端 beta token 作为 report 统计对象，但只能记录摘要/枚举，不可直接透传

---

## 四、P1 请求处理流水线

### 4.1 总流程

```text
handleHttpRequest
  -> 鉴权 / 选账号 / 得到 provider + authMode + routingGroup + user
  -> 判断是否命中 raw 分支
  -> 未命中: 走现有逻辑
  -> 命中: raw header sanitize
          -> raw body validate + rewrite
          -> 失败则本地 reject
          -> 成功则以 canonical 请求发往 upstream
```

### 4.2 raw 分支前置 gate

命中 raw 分支前必须先完成：

- 本地鉴权解析
- relay user / routing group / selected account 解析
- provider / authMode 判断
- canary 判断
- raw template 解析

这样 `ALLOW_RAW_PASSTHROUGH` 才能精确作用于 provider / auth / path / cohort，而不是粗暴地在入口处关闭所有版本校验。

### 4.3 Header 规则

P1 header 规则如下。

#### 4.3.1 危险 header 黑名单

必须新增硬黑名单，优先级高于所有 allowlist：

```ts
const DANGEROUS_HEADERS = new Set([
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'via',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'true-client-ip',
  'x-client-ip',
  'cookie',
  'set-cookie',
  'x-client-version',
  'x-app-version',
  'x-device-id',
])
```

规则：

- 命中黑名单直接丢弃
- `fingerprint_report` 记录命中的 header 名称
- 生产告警以“命中次数 > 0”为准

#### 4.3.2 raw 模式下的覆盖项

raw 模式中以下 header 不能信任客户端：

- `x-request-id`
  - 必须由 relay 覆盖为 `trace.requestId`
- `idempotency-key`
  - 必须由 relay 覆盖为新的内部值，例如基于 `trace.requestId`
- `x-claude-code-session-id`
  - 必须由 relay 生成新的 upstream session UUID
- `x-claude-remote-session-id`
  - 必须由 relay 生成新的 upstream session UUID
- `anthropic-beta`
  - 必须按单一归属规则生成：
    - raw template 只提供客户端指纹基线 beta
    - 必要 OAuth beta 只由 relay 单一来源强制追加
    - 最终输出前必须去重
- `content-type`
  - 重写后强制为 `application/json`
- `accept-encoding`
  - upstream 强制发 `identity`

`Authorization` 继续由 OAuth 账号池注入。

#### 4.3.3 `$passthrough:default`

`$passthrough:default_value` 必须提前到 P1，避免空值 header：

```ts
if (templateValue.startsWith('$passthrough:')) {
  const defaultValue = templateValue.slice('$passthrough:'.length)
  return incomingValues[0] ?? defaultValue
}
```

适用场景：

- `x-stainless-retry-count`
- `x-stainless-timeout`

约束：

- raw 模式允许 `$passthrough:default` 用于少数受控机器指纹字段
- 不允许借此恢复客户端 `anthropic-beta` 或其他高风险 header

### 4.4 Body 规则

P1 核心机制是一个新的 **rewrite-or-reject** 函数。例如：

```ts
type RawRewriteResult =
  | { ok: true; body: Buffer; report: FingerprintReport }
  | { ok: false; reject: RawRejectReason; report: FingerprintReport }
```

#### 4.4.1 请求体基本要求

raw 分支只接受：

- `Content-Encoding` 为空
- body 可解析为 JSON
- `messages` 为 Anthropic 兼容数组
- `stream` 为布尔值或缺失

以下情况必须 reject：

- 请求体带 `content-encoding`
- 非 JSON
- `messages` 缺失
- `messages` 结构不是 Anthropic 兼容格式
- OpenAI body 兼容需求

P1 不做：

- `messages: "string"` 自动转换
- `gpt-*` model 映射
- OpenAI `input` / `instructions` 兼容

#### 4.4.2 顶层字段白名单

P1 只接受以下客户端字段：

- `model`
- `messages`
- `max_tokens`
- `temperature`
- `top_p`
- `top_k`
- `stop_sequences`
- `stream`
- `thinking`
- `tools`
- `tool_choice`

说明：

- `system` 不属于客户端可用字段；raw 模式下由 template 生成
- `metadata` 不属于客户端可用字段；由 relay 重建
- 白名单外顶层字段全部 reject，不做静默 strip

#### 4.4.3 system 规则

P1 中：

- upstream `system = [buildBlock0(template.block0Template), ...template.systemBlocks]`
- 客户端 `system` 缺失或空数组：允许
- 客户端 `system` 非空：reject

这保证：

- system 形状始终 template-canonical
- 不会因为追加 block 产生新的指纹分叉

#### 4.4.4 tools 规则

P1 中 tools 不是“客户端想传什么就传什么”。规则如下：

- template 中的 tool 列表是 canonical allowlist
- 客户端 `tools` 缺失或空数组：允许
- 客户端 `tools` 非空时：
  - 每个 tool 名必须存在于 template allowlist
  - 任何未知 tool、schema 不匹配、重复冲突都直接 reject
- upstream 使用 template 中的 canonical tool 定义，不回传客户端自定义 schema
- `tool_choice` 若引用了非 allowlist tool，直接 reject

#### 4.4.5 model 规则

P1 必须在 raw template 中二选一：

- `forcedModel`
- `allowedModels`

规则：

- 若配置了 `forcedModel`，upstream 始终使用 `forcedModel`
- 若未配置 `forcedModel`，则客户端 `model` 必须命中 `allowedModels`
- 未命中 allowlist 的 model 直接 reject

P1 不允许：

- 放任任意 model 原样透传
- 因客户端未知 model 自动兜底为旧模板

#### 4.4.6 metadata 规则

P1 中客户端 `metadata` 不进入 upstream：

- 客户端 body 中存在 `metadata` 时，默认 reject
- relay 在重写完成后再补上自己的 `metadata.user_id`

这样可以彻底避免：

- 客户端 device id 泄漏
- 客户端 account uuid 泄漏
- 下游 session key 与上游 `metadata.session_id` 混用

### 4.5 `/api/event_logging/*` 的硬处理

P1 不支持 raw 客户端访问 `/api/event_logging/*`。

规则：

- 如果请求不是标准 CC 流量，且路径命中 `/api/event_logging/*`
- 直接在 relay 本地返回 `403 invalid_request_error`
- 不做 rewrite
- 不 forward upstream
- 不记录原始 body 明文

原因：

- `event_logging` 属于指纹与行为暴露面
- P1 只收敛在 `/v1/messages*`

---

## 五、协议与流式硬要求

### 5.1 请求侧

P1 必须满足：

- upstream `accept-encoding` 强制为 `identity`
- 请求体若带 `content-encoding`，直接 `415 invalid_request_error`
- 重写后的 upstream `content-type` 强制为 `application/json`
- raw 分支内不得依赖客户端 `content-length`，必须在 rewrite 后重新同步

### 5.2 响应侧

针对 `stream=true` 的消息请求：

- stream response 必须剥离 `content-length`
- 客户端断连时必须 abort upstream 请求
- 如果 upstream 仍然返回压缩 SSE：
  - 不向压缩流里注入明文 `event: error`
  - 直接关闭流并记日志
- 如果 upstream 是 identity SSE，且 relay 需要补一个 stream error 事件：
  - 必须使用标准 SSE 结尾
  - 事件格式必须是：

```text
event: error
data: {"type":"stream_error","message":"stream_interrupted"}

```

注意最后必须是双换行 `\n\n`。

### 5.3 upstream 中断

需要区分三类异常：

- relay 在 headers 发送前失败
  - 返回普通 Anthropic 风格 JSON 错误
- relay 在 identity SSE 中途失败
  - 允许 append 一个标准 SSE error 事件，然后结束连接
- relay 在压缩 SSE 中途失败
  - 不 append 明文 SSE error
  - 直接结束连接并记录 `http_stream_error`

---

## 六、Reject 错误流

### 6.1 位置

raw reject 必须在 `handleHttpRequest` 层完成，不能等到请求已经发给 upstream 之后。

### 6.2 返回格式

所有 raw reject 都返回 Anthropic 风格错误体：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "..."
  }
}
```

常见状态码：

- `400`：非法 JSON、非法 body 结构、非法 model、非法 system/tools
- `403`：不允许访问的 raw 路径，例如 `event_logging`
- `415`：请求体 `content-encoding` 不支持
- `422`：template 无法满足请求约束时可用，但如果团队偏好统一为 `400` 也可接受；重点是统一用 `invalid_request_error`

### 6.3 Reject 日志要求

reject 时：

- 不记录原始 body 明文
- 不记录客户端 `system`
- 不记录客户端 `metadata.user_id`
- `idempotency-key` 只记录 hash / 摘要
- body 相关只允许记录：
  - `bodyBytes`
  - `bodySha256`
  - 顶层字段名列表
  - rejectReason

---

## 七、观测、指标、告警与 Dashboard

### 7.1 复用现有事件

P1 不另起一套完全平行的日志体系，而是复用并扩展：

- `body_rewrite_metrics`
- `http_request_capture`

P1 需要新增：

- `fingerprint_report`

### 7.2 `fingerprint_report` 最小字段

建议最小字段：

```ts
type FingerprintReport = {
  requestId: string
  provider: 'claude-official'
  authMode: 'oauth'
  path: '/v1/messages' | '/v1/messages/count_tokens'
  rawMode: 'report_only' | 'enforce'
  canaryScope: 'routing_group' | 'account' | 'user' | 'none'
  templateId: string | null
  matchedRawTemplate: boolean
  rejectReason: string | null
  dangerousHeadersStripped: string[]
  requestHadContentEncoding: boolean
  requestHadClientSystem: boolean
  requestHadClientMetadata: boolean
  requestToolNames: string[]
  allowedToolNames: string[]
  originalModel: string | null
  resolvedModel: string | null
  bodyBytes: number
  bodySha256: string | null
  outcome: 'rewritten' | 'rejected' | 'report_only_rejected'
}
```

原则：

- 可以记录结构化摘要
- 不记录原始 body/system 明文

### 7.3 `http_request_capture` 的 raw 模式脱敏要求

raw 模式下 capture 必须降敏：

- `incomingBody`
  - 不保留明文 preview
  - 只保留长度、sha256、是否截断、顶层字段摘要
- `upstreamBody`
  - 可保留 rewritten 后的 preview，但仍需屏蔽 `metadata.user_id`
- `Authorization`
  - 继续 redaction
- `idempotency-key`
  - hash 化
- `x-request-id`
  - 记录 relay 值，不记录客户端原值

### 7.4 Dashboard 与告警

P1 上线前必须配齐 dashboard 与告警。

#### Dashboard 最少包含

- raw 请求量
- raw `report_only` 与 `enforce` 请求量
- raw reject rate
- `dangerousHeadersStripped` 命中次数
- template 缺失或加载失败次数
- 429 / 403 / 5xx 按 account / routing group / user 的分布
- streaming 请求量、stream 中断量、client abort 量

#### 告警最少包含

- `template_missing > 0`
- `dangerous_headers_stripped > 0`
- raw `reject_rate` 在 canary cohort 中 5 分钟超过阈值
- raw 模式启用后 `429` / `403` / `5xx` 相对基线突增
- `http_stream_error` 相对基线突增

---

## 八、发布工程化

### 8.1 `report_only`

P1 必须支持 `report_only`：

- 命中 raw 条件后，执行同样的 template 匹配、header sanitize 预演、body validate/rewrite 预演
- 产出 `fingerprint_report`
- 不改变现有线上行为
- 非 CC 请求仍返回现有错误

用途：

- 在不打开真实 raw 放行的前提下，先拿到真实输入分布
- 先验证模板覆盖率与 reject 分布

### 8.2 Canary

P1 必须支持至少三种 canary 维度：

- 按 `routing group`
- 按 `account`
- 按 `user`

建议配置项示例：

- `RAW_PASSTHROUGH_REPORT_ONLY=true|false`
- `RAW_PASSTHROUGH_CANARY_ROUTING_GROUPS=a,b`
- `RAW_PASSTHROUGH_CANARY_ACCOUNTS=account-1,account-2`
- `RAW_PASSTHROUGH_CANARY_USERS=user-1,user-2`

只要没有命中 canary，就不进入 raw `enforce`。

### 8.3 全局 kill switch 与主开关

P1 中有两个不同层级的“关闭”概念：

- `RAW_PASSTHROUGH_KILL_SWITCH=true`
  - 最高优先级硬关闭
  - 不做预演、不做 rewrite、不产出 raw report
- `ALLOW_RAW_PASSTHROUGH=false`
  - raw 功能族主开关关闭
  - `REPORT_ONLY` / `ENFORCE` 全部失效
  - 现有版本校验与旧路径逻辑保持原样

要求：

- kill switch 打开后，所有命中 P1 范围的请求都立即退出 raw 状态机
- `ALLOW=false` 时，raw 预演同样不会执行
- 两者都不能影响非 raw 范围流量
- 两者都不能把版本校验全局关掉

### 8.4 启动失败策略

若 raw enforce 已开启，但 raw template 缺失或非法：

- 服务启动失败，禁止带病上线

若运行时账户/灰度命中了 raw 分支，但请求对应 template 缺失：

- 请求本地 reject
- `fingerprint_report` 记 `template_missing`
- 告警立即触发

---

## 九、实现落点

P1 只讨论以下文件的改动职责。

| 文件 | P1 职责 |
|---|---|
| `src/config.ts` | 新增 `ALLOW_RAW_PASSTHROUGH`、`RAW_PASSTHROUGH_REPORT_ONLY`、`RAW_PASSTHROUGH_ENFORCE`、`RAW_PASSTHROUGH_KILL_SWITCH`、canary、raw template 配置解析；支持启动失败校验 |
| `src/proxy/bodyRewriter.ts` | 实现 raw rewrite-or-reject；基于 raw template 生成 canonical `system` / `tools` / `metadata` |
| `src/proxy/relayService.ts` | 在 `handleHttpRequest` 中做精确 raw gating；在本地完成 reject；处理 stream 协议要求与 client abort |
| `src/proxy/headerPolicy.ts` | 危险 header 黑名单、`x-request-id` / `idempotency-key` / session headers 覆盖、`accept-encoding=identity`、强制 `content-type` |
| `src/proxy/fingerprintTemplate.ts` | 支持 `$passthrough:default`，但禁止 raw 模式借此透传 beta |
| `src/scheduler/fingerprintCache.ts`（或实际模板缓存模块） | 负责 raw template 的加载、缓存、失效与热更新可见性；raw template 不应在每次请求中重复磁盘读取 |
| `src/proxy/relayLogger.ts` | 复用 `body_rewrite_metrics` / `http_request_capture`，新增 `fingerprint_report`，并落实 raw capture 脱敏 |

---

## 十、测试门禁

P1 必须有稳定的自动化门禁；没有稳定门禁，不允许进入 canary。

要求最终沉淀出一条稳定命令，例如 `pnpm test:raw-passthrough`，由它统一串起 raw 相关单元测试、集成测试与流式专项测试。

### 10.1 单元测试

必须覆盖：

- flag `off` / `on`
- raw template 缺失
- `block0Template` 缺失
- 非法 JSON
- 非法 `messages`
- 非法 `content-encoding`
- `model` reject
- 非空客户端 `system` reject
- 非法 `tools` / `tool_choice` reject
- `metadata` reject 或重建规则
- `$passthrough:default`
- `x-request-id` 覆盖
- `idempotency-key` 覆盖
- dangerous headers 黑名单
- raw 模式禁客户端 beta passthrough

### 10.2 集成测试

必须覆盖：

- `ALLOW_RAW_PASSTHROUGH=false`
- `ALLOW_RAW_PASSTHROUGH=true + report_only`
- `ALLOW_RAW_PASSTHROUGH=true + enforce`
- `ALLOW_RAW_PASSTHROUGH=false + RAW_PASSTHROUGH_REPORT_ONLY=true` 时不执行预演
- 仅 `claude-official + oauth + /v1/messages*` 命中 raw
- `preserve_incoming_auth` 不命中 raw
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- 非法 body reject
- 无 template reject
- model reject
- 危险 header 清洗
- `x-request-id` 被覆盖
- `idempotency-key` 被覆盖
- reject body 显式断言为 Anthropic JSON 结构：
  - 顶层 `type === "error"`
  - `error.type === "invalid_request_error"`
  - 不混入原始 body 明文
- `stream=false`
- `stream=true`
- SSE 中断
- upstream `429`
- upstream `403`
- upstream `5xx`
- 客户端断连后 upstream 被 abort
- capture 脱敏

### 10.3 流式专项测试

必须单独验证：

- upstream 返回 identity SSE
- upstream 异常断流
- relay append 的 SSE error 是否严格以双换行结束
- upstream 误返回压缩 SSE 时不注入明文 error
- stream response 已剥离 `content-length`

### 10.4 范围外回归测试

必须证明 P1 不破坏以下现有行为：

- 标准 Claude Code 正常请求
- 非 raw 路径继续走旧逻辑
- `/api/event_logging/*` 不命中 raw
- `/v1/files/*` 不命中 raw
- `/v1/sessions/*` 不命中 raw
- OpenAI 兼容路径不受影响
- `preserve_incoming_auth` 不受影响
- WS 行为不因 P1 被误放开

---

## 十一、上线 Checklist

### 11.1 上线前

- [ ] raw template 与 `block0Template` 已生成并评审
- [ ] `ALLOW_RAW_PASSTHROUGH=false` 时全量回归通过
- [ ] `report_only` 自动化通过
- [ ] `enforce` 自动化通过
- [ ] `/v1/messages` 与 `/v1/messages/count_tokens` 都已覆盖
- [ ] stream on/off 都已覆盖
- [ ] 非法 body / model / system / tools 均验证为本地 reject
- [ ] dangerous headers 黑名单验证通过
- [ ] `x-request-id` / `idempotency-key` 覆盖验证通过
- [ ] capture 脱敏验证通过
- [ ] dashboard 已建好
- [ ] 告警已接通
- [ ] canary 范围已确认
- [ ] kill switch 回滚演练完成

### 11.2 `report_only` 阶段

- [ ] 先按 routing group 开 `report_only`
- [ ] 观察 template 命中率
- [ ] 观察 reject 分布
- [ ] 观察危险 header 命中
- [ ] 观察 429 / 403 / 5xx 是否异常

### 11.3 `enforce` 阶段

- [ ] 先按 account 或 user 小流量 canary
- [ ] 观察 raw reject rate
- [ ] 观察 upstream 429 / 403 / 5xx
- [ ] 观察 stream error 比例
- [ ] 观察 account cooldown / incident 是否异常升高

### 11.4 回滚

- [ ] 关闭 `ALLOW_RAW_PASSTHROUGH`
- [ ] 确认 raw 请求不再命中 enforce
- [ ] 确认版本校验恢复到旧行为
- [ ] 确认非 raw 范围流量不受影响

---

## 十二、P1 之后再讨论的事项

以下内容明确延期到后续阶段：

- 客户端 `system` 的受限保留策略
- OpenAI body 兼容
- WebSocket raw passthrough
- `/api/event_logging/*` 的安全兼容层
- `/v1/files/*` / `/v1/sessions/*` 的 raw 支持
- 行为层账号亲和性
- 更复杂的客户端 beta 兼容策略

---

## 十三、结论

P1 的设计基线不是“让任意客户端尽量跑起来”，而是：

- **只放开最小范围**
- **只接受显式模板能描述的输入**
- **只做 rewrite-or-reject**
- **只在可观测、可灰度、可回滚的工程化前提下上线**

如果某个请求不在这个边界内，P1 的正确行为不是“尽力兼容”，而是 **明确拒绝，不把原始请求发给 upstream**。
