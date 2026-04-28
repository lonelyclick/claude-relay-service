# Cor Reseller Gateway 规范（基于当前仓库）

> 文档状态：`draft-spec`
>
> 本文档只以当前仓库代码与现有文档为依据，目标是把“reseller gateway”方向落成一份可执行规范。
> 未能从仓库直接确认的内容，统一标记为“待确认”，不得视为既定事实。

---

## 1. 文档目的与约束

### 1.1 目的

把当前 `claude-oauth-relay` 仓库整理成一条明确的落地方向：

1. 以 **API key 型上游通道** 为主，构建可转售的网关能力
2. 复用仓库里已有的用户、计费、路由、管理后台骨架
3. 明确哪些是“现状已具备”，哪些是“必须新增”，哪些只能列为“待确认”

### 1.2 依据范围

本规范主要依据以下仓库事实：

- `README.md`
- `src/types.ts`
- `src/server.ts`
- `src/proxy/relayService.ts`
- `src/scheduler/accountScheduler.ts`
- `src/scheduler/healthTracker.ts`
- `src/usage/userStore.ts`
- `src/usage/apiKeyStore.ts`
- `src/usage/usageStore.ts`
- `src/billing/engine.ts`
- `src/billing/billingStore.ts`
- `src/oauth/pgTokenStore.ts`

### 1.3 标记规则

- `已确认`：能从仓库代码直接确认
- `新增要求`：为实现 reseller gateway 必须补齐的规范
- `待确认`：仓库内没有足够证据，不能写成既定事实

---

## 2. 当前基线

### 2.1 已确认的 provider 与协议能力

| Provider | 协议 | 鉴权模式 | 当前已支持路径 | 适合 reseller 主路径 |
|---|---|---|---|---|
| `claude-official` | Claude | `oauth` | Claude first-party HTTP / WebSocket 路径 | 否，保留为兼容模式 |
| `openai-codex` | OpenAI | `oauth` | `/v1/responses`、`/v1/responses/*` | 否，保留为兼容模式 |
| `openai-compatible` | OpenAI | `api_key` | `/v1/chat/completions` | 是，主推 |
| `claude-compatible` | Claude | `api_key` | `/v1/messages`、`/v1/messages/count_tokens` | 可选，作为兼容补充 |

已确认事实：

- 路由匹配定义在 `src/proxy/relayService.ts` 的 `HTTP_ROUTES`
- `openai-compatible` 当前只支持 `POST /v1/chat/completions`
- `claude-compatible` 当前只支持 `POST /v1/messages` 与 `POST /v1/messages/count_tokens`
- 仓库当前 **没有** `GET /v1/models`
- 仓库当前 **没有** `POST /v1/embeddings`

### 2.2 已确认的持久化对象

| 业务概念 | 当前实现 | 状态 | 备注 |
|---|---|---|---|
| 上游通道 | `StoredAccount`，持久化在 `accounts` 表 JSON 数据中 | 已确认 | 管理接口仍以 `account` 命名 |
| 路由组 | `RoutingGroup` | 已确认 | 账号与用户都能绑定 `routingGroupId` |
| 下游用户 | `relay_users` + `RelayUser` | 已确认 | 有 `routingMode`、`billingMode`、`billingCurrency`、`balanceMicros` |
| 下游多 API Key | `relay_api_keys` | 已确认 | 哈希存储，支持多 key |
| 用量记录 | `usage_records` | 已确认 | 会记录 user/account/model/headers/body preview 等 |
| 下游价格规则 | `billing_price_rules` | 已确认 | 当前是单层价格规则 |
| 下游账单行 | `billing_line_items` | 已确认 | 每条 usage 会同步生成/更新 |
| 下游余额账本 | `billing_balance_ledger` | 已确认 | 支持 `topup` / `manual_adjustment` / `usage_debit` |
| 会话路由 | `session_routes` / `session_handoffs` | 已确认 | 主要服务 Claude session 场景 |

### 2.3 当前可复用的核心能力

1. `relay_users` 已具备 prepaid / postpaid、币种、余额字段
2. `billingStore.syncUsageRecordById()` 已在 usage 写入后自动执行，可形成下游计费闭环
3. `ApiKeyStore` 已支持多 key、吊销、最后使用时间更新
4. `AccountScheduler` 已支持按 group、health、capacity、weight、planMultiplier 选账号
5. `AccountHealthTracker` 已支持记录 `429`、`5xx`、连接错误，并维护 cooldown
6. 管理接口已覆盖账号、路由组、用户、计费规则、余额账本、用量查询

### 2.4 当前缺口与风险

以下都是从当前代码直接推出来的缺口，不是推测：

1. `openai-compatible` 还没有 `/v1/models`
2. OpenAI 路径上的本地拒绝仍复用 Anthropic 风格错误体，**不符合 OpenAI 兼容预期**
3. `openai-compatible` 当前是一跳上游请求，**没有统一的同请求多通道 failover**
4. 路由保护统计当前主要围绕 `/v1/messages` 和 `/v1/sessions/ws`，**并未完整覆盖 `/v1/chat/completions`**
5. device affinity 与 session route 目前是 Claude session 语义，**不适合作为 OpenAI reseller MVP 的主约束**
6. 仓库只有“下游售价”体系，没有“上游成本”体系
7. `relay_users.api_key` 仍保留单 key 明文能力，而 `relay_api_keys` 是哈希多 key；两套机制并存
8. 当前没有公开注册、支付订单、用户控制台登录闭环

### 2.5 三层接口边界（基于 `src/server.ts`）

本节只讨论 reviewer 指出的三层“控制/运营接口”边界，不把协议入口 `/v1/*` 混进来。

说明：

- `/v1/chat/completions` 等协议入口已存在，仍是 reseller 主路径，见 §6.4
- 本表聚焦 `src/server.ts` 中当前真实可见的 `internal` / `admin` / future public user API 分层

| 层级 | 当前路由边界 | 目标使用者 | 认证方式 | 当前是否已存在 | 主要能力 | 是否属于当前 reseller gateway MVP |
|---|---|---|---|---|---|---|
| `internal cc-webapp` | `/internal/ccwebapp/*` | Yoho 自有上层站点或受信后端集成，不面向公网终端用户 | `Authorization: Bearer <INTERNAL_TOKEN>`；未配置 `INTERNAL_TOKEN` 时整层返回 `503` | 是 | 用户同步 `POST /internal/ccwebapp/users/sync`、多 API key 管理、用户 summary / usage、价格规则读取、用户 topup | 否，不作为本次 reseller MVP 的对外接口层 |
| `admin` | `/admin/*` | 运营/开发/管理员 | 先受 `ADMIN_UI_ALLOWED_ORIGINS` CORS 约束；`/admin/session/exchange` 用 Keycloak access token 换 admin session；其余 `/admin/*` 用 `ADMIN_TOKEN` 或 admin session + `x-admin-csrf` | 是 | 账号/通道管理、routing group、OAuth 接入、scheduler / session route、用户管理、proxy 管理、usage、billing、余额账本 | 是，当前 reseller MVP 的主要运营面 |
| `public user console / 对外用户 API` | 当前 `src/server.ts` 中 **不存在** `/api/user/*`、`/api/payment/*`、用户侧控制台路由 | 最终下游付费用户 | 待确认；至少需要 end-user session / OTP / 外部身份系统之一，当前仓库未实现 | 否 | 未来应承载用户自助查看余额、创建/吊销 key、查看 usage / billing、创建充值订单、支付回调配套流程 | 否，当前 reseller MVP 不要求，属于后续阶段 |

边界结论：

1. 当前仓库已经有两层真实存在的控制面：`/internal/ccwebapp/*` 与 `/admin/*`
2. reseller MVP 应优先复用 `/admin/*` 完成运营闭环，不应把 `/internal/ccwebapp/*` 误当成公开用户接口
3. 如果后续建设 public user console，必须新增独立路由层，而不是继续向 `/internal/ccwebapp/*` 暴露公网能力
4. 对外协议入口 `/v1/*` 与用户控制台 API 是两条不同边界：前者是“模型调用面”，后者是“账户与账务自助面”

---

## 3. 目标、范围与非目标

### 3.1 目标

`新增要求`

本仓库的 reseller gateway 目标定义为：

- 以 `openai-compatible` 和可选的 `claude-compatible` 账号作为上游通道池
- 对下游用户提供稳定的 API key 鉴权、价格规则、余额扣费和可观测性
- 让后台可以管理通道、路由组、用户、价格、余额和用量

### 3.2 MVP 范围

`新增要求`

MVP 只要求覆盖以下闭环：

1. 管理员创建 reseller routing group
2. 管理员录入一个或多个 `openai-compatible` 上游通道
3. 管理员创建 relay user，并为其发放 `rk_` 前缀 API key
4. 管理员配置下游售价规则
5. 管理员为 prepaid 用户充值
6. 用户调用 `POST /v1/chat/completions`
7. 请求完成后能查到 usage、line item、余额变化

### 3.3 非目标

`已确认 + 待确认`

以下内容当前不应写成 MVP 已定事项：

- 公网品牌名、域名、备案方案
- 支付渠道选型
- 公开注册流程
- 发票、合同、退款政策
- `POST /v1/embeddings`
- “一定要支持 Anthropic 和 OpenAI 双协议同时对外售卖”

这些都保留为待确认项。

### 3.4 进入阶段 B / C 前必须拍板的决策门槛

以下两项不能继续隐含处理；如果不先拍板，后续开发会在接口、计费和 UI 上反复返工。

| 决策项 | 最迟拍板阶段 | 推荐默认值 | 不拍板会卡住什么 |
|---|---|---|---|
| `/v1/models` 目录来源规则 | 阶段 B 开工前 | `价格规则白名单` | 模型目录实现、SDK 文档、前端模型下拉、价格规则校验口径 |
| 币种策略：单币种还是双币种 | 阶段 C 开工前 | `单部署单币种` | 价格规则设计、余额/账本、上游成本表、对账流程、UI 展示 |

#### 决策门槛 A：`GET /v1/models` 目录来源

状态：✓ 已拍板（2026-04-28）— 采用 **方案 A：价格规则白名单**，已在阶段 B 落地（详见 §10）。

当前仓库事实：

- `GET /v1/models` 已注册在 `relayService.ts` 的 `HTTP_ROUTES` 并由 `serveModelsCatalog` 处理
- 现有 `billing_price_rules` 能表达模型级价格
- 现有 `StoredAccount` / `openai-compatible` 并没有统一的“可售模型目录”字段

可选规则：

| 规则 | 含义 | 优点 | 风险 / 代价 |
|---|---|---|---|
| 方案 A：价格规则白名单 | 只暴露已配置下游售价规则、且 `model` 非空的模型 | 最保守；和收费口径一致；不会把未定价模型暴露出去 | 需要运营先配价格，模型目录才会出现 |
| 方案 B：价格规则与活跃 channel 交集 | 必须同时满足“有下游售价规则”且“至少一个活跃 channel 可承接” | 目录更接近实时可用性 | 需要额外判断 channel 可承接模型，`openai-compatible` 当前没有统一模型目录，判断逻辑更复杂 |
| 方案 C：按 channel 联合集合暴露 | 只要某个 channel 声称可接，就出现在目录 | 最接近上游能力 | 高风险；可能暴露未定价模型，或暴露 fallback/运营未准备好的模型 |

推荐默认值：

- 采用 **方案 A：价格规则白名单**

推荐理由：

1. 当前仓库最可靠的“公开售卖范围”来源是价格规则，不是 channel 元数据
2. 这与 `rejectIfMissingBillingRule()` 的请求前预检逻辑一致
3. 该方案不会把 `system-default-all-models-*` 这种系统 fallback 规则误暴露成公开模型目录

影响范围：

- `GET /v1/models` 返回逻辑
- 控制台或对外文档中的模型列表
- 调用前价格预检的一致性
- 运营上新流程：先配价格，再开放模型

#### 决策门槛 B：币种策略

当前仓库事实：

- 代码层已支持 `USD` / `CNY`
- `relay_users.billingCurrency`、`billing_price_rules.currency`、`billing_balance_ledger.currency` 已存在
- 当前仓库 **没有** 汇率、自动换汇或跨币种对账能力

可选策略：

| 策略 | 含义 | 优点 | 风险 / 代价 |
|---|---|---|---|
| 方案 A：单部署单币种 | 一个部署实例只允许一种结算币种，例如全站 `CNY` 或全站 `USD` | 最保守；价格、余额、对账、UI 都简单 | 同一实例无法同时面向两类结算市场 |
| 方案 B：单部署双币种 | 同一实例允许用户、价格规则、上游成本同时出现 `USD` 与 `CNY` | 灵活 | 需要在价格规则、余额、账本、报表、UI 全面处理币种切换与隔离；仍不能自动换汇 |

推荐默认值：

- 采用 **方案 A：单部署单币种**

推荐理由：

1. 当前仓库虽然能存两种币种，但没有换汇与跨币种对账基础设施
2. reseller 第一阶段重点是把成本与账务闭环跑通，不应同时引入多币种复杂度
3. 单币种能减少 price rule、topup、channel 成本录入和报表展示的歧义

影响范围：

- 下游售价规则是否允许混币种创建
- 用户余额与 topup 入口的币种限制
- 新增 `upstream_price_rules` / `channel_balance_ledger` 的币种约束
- admin 与 future public user console 的金额展示
- 对账与毛利报表是否需要按币种分桶

在未拍板前，本规范默认按“单部署单币种”设计新增实现。

---

## 4. 术语与角色

### 4.1 Channel

业务术语里的 “Channel” 在代码里仍对应 `StoredAccount`。本规范不要求重命名已有代码和 API。

- 管理接口继续使用 `/admin/accounts/*`
- 文档中提到 “channel” 时，指 reseller 语义下的 API-key 型上游通道

### 4.2 Routing Group

`RoutingGroup` 是通道和用户的共同分组边界。

`新增要求`

- reseller 流量使用的 routing group **不得与 OAuth 兼容流量混用**
- 同一个 reseller group 内，只放 `authMode=api_key` 的通道

这样可以避免 `resolveRequestedProvider()` 在混合组里回退到 OAuth provider。

### 4.3 Relay User

下游用户继续复用 `RelayUser`：

- `routingMode`: `auto` / `pinned_account` / `preferred_group`
- `billingMode`: `prepaid` / `postpaid`
- `billingCurrency`: `USD` / `CNY`
- `balanceMicros`

`新增要求`

- 自助转售用户默认应使用 `prepaid`
- `postpaid` 只保留给后续企业月结场景，当前不作为 MVP 主路径

### 4.4 Legacy Key 与 Managed Key

当前仓库里有两套下游 key：

- `relay_users.api_key`
  - 旧式单 key
  - 明文存储
- `relay_api_keys`
  - 多 key
  - `key_hash` 存储

`新增要求`

- 新发放给 reseller 用户的 key 统一来自 `relay_api_keys`
- `relay_users.api_key` 仅保留为兼容字段与管理端过渡能力
- 对外文档不得再把 `relay_users.api_key` 当长期主方案

---

## 5. 数据模型规范

### 5.1 已有模型的保留方式

#### Channel（复用 `StoredAccount`）

`已确认`

reseller 需要的关键字段当前都已有承载位置：

- `provider`
- `authMode`
- `apiBaseUrl`
- `accessToken`
- `routingGroupId`
- `weight`
- `schedulerEnabled`
- `schedulerState`
- `proxyUrl`
- `modelName`
- `modelTierMap`

`新增要求`

- reseller 主路径只使用 `authMode=api_key` 的通道
- 对于 `openai-compatible`，`modelName` 可为空，允许按客户端传入模型直通
- 对于 `claude-compatible`，`modelName` 或 `modelTierMap` 必须可确定最终上游模型

#### Downstream pricing（复用 `billing_price_rules`）

`已确认`

当前 `billing_price_rules` 已支持以下维度：

- `currency`
- `provider`
- `accountId`
- `userId`
- `model`
- `effective_from` / `effective_to`

`新增要求`

- reseller 模式下，`billing_price_rules` 明确定义为 **下游售价规则**
- 该表不再承担上游成本规则语义

#### Downstream balance（复用 `billing_balance_ledger`）

`已确认`

当前账本已支持：

- 充值
- 手工调账
- usage 自动扣费

MVP 继续沿用。

### 5.2 新增表

#### `upstream_price_rules`

`新增要求`

用途：保存每个 channel 的上游成本规则。

建议字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | 规则 ID |
| `account_id` | `TEXT NOT NULL` | 对应 `StoredAccount.id` |
| `currency` | `TEXT NOT NULL` | `USD` / `CNY` |
| `model` | `TEXT NULL` | 可为空，表示 fallback |
| `effective_from` | `TIMESTAMPTZ NOT NULL` | 生效时间 |
| `effective_to` | `TIMESTAMPTZ NULL` | 失效时间 |
| `input_price_micros_per_million` | `BIGINT NOT NULL` | 输入单价 |
| `output_price_micros_per_million` | `BIGINT NOT NULL` | 输出单价 |
| `cache_creation_price_micros_per_million` | `BIGINT NOT NULL` | cache create 单价 |
| `cache_read_price_micros_per_million` | `BIGINT NOT NULL` | cache read 单价 |
| `created_at` | `TIMESTAMPTZ NOT NULL` | 创建时间 |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | 更新时间 |

#### `channel_balance_state`

`新增要求`

用途：保存每个 channel 的当前余额快照，避免每次都全表汇总。

建议字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `account_id` | `TEXT PK` | channel ID |
| `currency` | `TEXT NOT NULL` | 余额币种 |
| `balance_micros` | `BIGINT NOT NULL` | 当前余额 |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | 最后更新时间 |

#### `channel_balance_ledger`

`新增要求`

用途：记录上游充值、手工调账、usage 成本扣减。

建议字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | 账本 ID |
| `account_id` | `TEXT NOT NULL` | channel ID |
| `kind` | `TEXT NOT NULL` | `topup` / `manual_adjustment` / `usage_debit` |
| `amount_micros` | `BIGINT NOT NULL` | 正数加余额，负数减余额 |
| `currency` | `TEXT NOT NULL` | 币种 |
| `usage_record_id` | `BIGINT NULL UNIQUE` | 关联 usage |
| `external_ref` | `TEXT NULL` | 幂等键或外部订单号 |
| `note` | `TEXT NULL` | 备注 |
| `created_at` | `TIMESTAMPTZ NOT NULL` | 创建时间 |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | 更新时间 |

### 5.3 `usage_records` 扩展

`新增要求`

为支持毛利和上游核算，`usage_records` 需新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `upstream_cost_micros` | `BIGINT` | 本次上游成本 |
| `upstream_cost_currency` | `TEXT` | 成本币种 |

不要求在第一阶段新增 `margin` 字段；毛利可由 `billing_line_items.amount_micros - usage_records.upstream_cost_micros` 推导。

---

## 6. 接口与行为规范

### 6.1 保留并复用的管理接口

以下接口当前已存在，应作为 reseller 落地的第一批复用能力：

| 接口 | 用途 |
|---|---|
| `POST /admin/accounts/create` | 创建上游通道 |
| `POST /admin/accounts/:accountId/settings` | 设置 group、weight、scheduler 等 |
| `GET/POST /admin/routing-groups` | 管理 routing group |
| `GET/POST /admin/users` | 管理下游用户 |
| `GET/POST /admin/billing/rules` | 管理下游售价规则 |
| `GET /admin/billing/users/:userId/balance` | 查询用户余额 |
| `POST /admin/billing/users/:userId/ledger` | 充值或手工调账 |
| `GET /admin/usage/*` | 查询 usage |
| `GET /admin/billing/*` | 查询账单汇总与明细 |

### 6.2 新增管理接口

`新增要求`

为 reseller 方向新增以下接口即可，不要求重写现有后台体系：

| 接口 | 用途 |
|---|---|
| `GET /admin/upstream-pricing` | 查询上游成本规则 |
| `POST /admin/upstream-pricing` | 新增上游成本规则 |
| `POST /admin/upstream-pricing/:ruleId/update` | 修改上游成本规则 |
| `POST /admin/upstream-pricing/:ruleId/delete` | 删除上游成本规则 |
| `GET /admin/accounts/:accountId/channel-balance` | 查询 channel 余额与最近账本 |
| `POST /admin/accounts/:accountId/channel-balance/ledger` | 给 channel 充值或手工调账 |

### 6.3 下游 API key 规范

`已确认`

- `RelayService.resolveRelayUser()` 目前只识别 `rk_` 前缀 token
- 可从 `Authorization: Bearer rk_xxx` 或 `x-api-key: rk_xxx` 读取
- 识别成功后会从请求头中剥离，不透传到上游

`新增要求`

- reseller MVP 继续沿用 `rk_` 前缀
- 如果未来要改成 `sk-...`，必须同步修改 resolver，不属于本阶段文档事实

### 6.4 下游协议范围

#### 主协议：OpenAI Chat Completions

`新增要求`

MVP 必须支持：

- `POST /v1/chat/completions`

行为要求：

1. 路径命中后只选择 `provider=openai-compatible` 的 channel
2. 请求体原样按 OpenAI 兼容协议透传到上游
3. 成功响应原样透传给客户端
4. 失败响应若来自上游，原样透传上游的 OpenAI 风格错误
5. 失败响应若由 relay 本地生成，必须返回 **OpenAI 风格错误体**

OpenAI 风格错误体建议统一为：

```json
{
  "error": {
    "message": "human readable message",
    "type": "invalid_request_error",
    "code": "internal_machine_code"
  }
}
```

`已确认缺口`

当前代码在 OpenAI 路径上本地拒绝时仍使用 Anthropic 风格错误体，这一行为必须修正。

#### 辅助协议：Models

`新增要求`

目录来源决策见 §3.4 的“决策门槛 A”。

MVP 增加：

- `GET /v1/models`

最小返回语义：

1. 只返回当前 reseller routing group 中可售卖的模型
2. 模型来源优先级：
   - 已生效的下游售价规则中的 `model`
   - 若规则没有显式模型，则不对外暴露“全部模型”
3. `system-default-all-models-*` 这种系统 fallback 规则 **不能直接生成公开模型目录**

#### 次要协议：Anthropic Messages

`待确认`

是否将 `POST /v1/messages` 也作为公开转售协议，对当前仓库来说是可行但不是 MVP 必选项。

如果做，则应：

1. 只路由到 `claude-compatible`
2. 与 OAuth Claude 兼容流量使用不同 routing group

### 6.5 价格规则预检

`已确认`

当前 `RelayService.rejectIfMissingBillingRule()` 会在请求转发前做下游价格规则预检。

`新增要求`

reseller 模式下，预检通过的条件需收紧为：

1. 命中了有效规则
2. 金额大于 0
3. 命中的规则 **不是** `system-default-all-models-*`

原因：

- 当前仓库会自动创建系统 fallback 规则
- 对 reseller 产品来说，fallback 规则只能做安全网，不能充当正式定价

---

## 7. 路由、重试与状态机

### 7.1 通道选择

`已确认`

当前 `AccountScheduler` 已经按以下维度打分：

- health score
- capacity
- manual weight
- plan multiplier
- proxy score

`新增要求`

reseller 第一阶段继续复用现有调度器，不新增一套独立路由器。

选择规则：

1. 先按请求路径确定 provider
2. 再按 `routingGroupId` 缩小可见通道集合
3. 然后交给 `AccountScheduler` 选出一个账号

### 7.2 同请求 failover

`新增要求`

需要把 `openai-compatible` 路径补齐到与 `claude-compatible` 类似的同请求切换能力。

统一规则：

1. 最多重试次数复用现有 `SAME_REQUEST_MAX_RETRIES`
2. 只允许在 **响应头尚未发送给客户端前** 切换通道
3. 每次重试都必须把当前失败账号加入 `disallowedAccountIds`
4. 重试间隔复用现有 backoff 配置

#### 可重试条件

在响应头发送前，以下情况可尝试下一条 channel：

- 连接错误
- 超时
- `429`
- `5xx`
- `401` / `403`
- 上游 200/4xx 但错误体明确表明 key 失效、额度耗尽、余额耗尽

#### 不可重试条件

- 客户端参数错误
- 已开始向客户端发送流式数据
- 显式强制指定了 `forceAccountId`

### 7.3 流式边界

`已确认`

当前代码已经能监测 SSE 流中断并记录 usage / log。

`新增要求`

对于 reseller 主路径，规范必须明确：

- 一旦第一个流式 chunk 已发送给客户端，**禁止中途切换 channel**
- 发生中途断流时，只能：
  1. 记录失败
  2. 结束当前响应
  3. 让客户端自行重试

### 7.4 健康状态机

`已确认`

当前 `AccountHealthTracker` 已跟踪：

- `429`
- `5xx`
- 连接错误
- `retry-after` 推导出的 cooldown

`新增要求`

reseller 场景下还必须补充：

1. `401` / `403` 的终态判定
2. 响应体关键词判定
3. OpenAI 错误 JSON 的 message 解析
4. channel 账本透支判定

推荐状态定义：

- `enabled`
- `paused`
- `draining`
- `auto_blocked`

与当前 `schedulerState` 对齐，不引入第二套状态字段。

### 7.5 OpenAI 路径的路由保护

`已确认缺口`

当前 user/device 的 request/token budget 与 device affinity 统计，主要针对：

- `/v1/messages`
- `/v1/sessions/ws`

`新增要求`

若 reseller 主路径是 `/v1/chat/completions`，则必须把以下统计扩展到 OpenAI 路径：

- user recent requests
- device recent requests
- user recent tokens
- device recent tokens

否则路由保护对主路径无效。

---

## 8. 计费、余额与成本核算

### 8.1 下游售价

`已确认`

当前下游售价闭环已经存在：

1. 请求前预检价格规则
2. usage 记录入库
3. `billingStore.syncUsageRecordById()` 生成或更新 `billing_line_items`
4. prepaid 用户通过 `billing_balance_ledger` 自动扣费

MVP 继续保留。

### 8.2 上游成本

`新增要求`

reseller 模式必须补一套独立的上游成本核算：

1. 根据 `accountId + model + currency + effective time` 匹配 `upstream_price_rules`
2. 用 usage token 计算 `upstream_cost_micros`
3. 将成本写回 `usage_records`
4. 在 `channel_balance_ledger` 中插入 `usage_debit`
5. 更新 `channel_balance_state.balance_micros`

### 8.3 用户余额策略

`已确认 + 新增要求`

- `prepaid`：保留并作为 reseller 默认模式
- `postpaid`：保留但不作为 MVP 主路径

请求前：

- `billingStore.assertUserCanConsume()` 负责阻断余额耗尽的 prepaid 用户

请求后：

- 仍以 usage 实际结果扣费
- 如果上游成功但 usage 缺失，应记为异常 usage，后续人工处理；不得静默按 0 扣费

### 8.4 对账原则

`新增要求`

对账优先级：

1. 下游计费以 `billing_line_items` 为准
2. 上游成本以 `upstream_price_rules + usage` 计算结果为准
3. 如果实际对账发现 channel 余额与系统偏差，使用 `manual_adjustment` 记差额，不直接改历史 usage

### 8.5 币种

`已确认 + 待确认`

币种策略的显式拍板见 §3.4 的“决策门槛 B”。

当前系统支持 `USD` 与 `CNY` 两种币种。

待确认但必须明确的一点：

- reseller MVP 是只支持单币种，还是允许同一部署同时存在 `USD` / `CNY`

在未确认前，本规范不要求实现自动汇率换算。

---

## 9. 安全与运维边界

### 9.1 管理面鉴权

`已确认`

当前管理面支持：

- `Authorization: Bearer <ADMIN_TOKEN>`
- 或 admin session + CSRF

reseller 落地不需要另起一套后台鉴权。

### 9.2 密钥存储

`已确认`

- `relay_api_keys` 使用 hash
- `sanitizeAccount()` 会隐藏上游 access token / refresh token / loginPassword

`新增要求`

- 新对外 key 一律走 `relay_api_keys`
- 生产环境不应继续鼓励使用 `relay_users.api_key`

### 9.3 请求/响应采集

`已确认`

仓库支持 `RELAY_CAPTURE_ENABLED` 与 body preview 采集。

`新增要求`

面向第三方 reseller 流量时：

- 生产默认关闭全量 capture
- 如开启，只允许保留截断后的 preview
- 不得把下游真实 `rk_` key 或上游真实 `api_key` 写入日志

### 9.4 组隔离

`新增要求`

必须把以下两类流量分组隔离：

1. OAuth 兼容流量
2. reseller API-key 通道流量

否则同一 routing group 内混用 provider 会让路径解析和调度语义变得不稳定。

---

## 10. 实施顺序与验收

### 阶段 A：把现有能力整理成可用的 reseller 最小闭环

目标：

- 不引入支付、不引入公开注册
- 先用现有 admin API 跑通“创建用户、配置价格、充值、调用、扣费”

必须完成：

1. 在文档与后台操作说明中统一 channel / account 术语
2. 明确 reseller routing group 的隔离规则
3. 用现有接口完成最小人工闭环

验收：

1. 创建 `openai-compatible` 通道成功
2. 创建 relay user 成功
3. 配置非 fallback 的下游价格规则成功
4. 给用户充值成功
5. `POST /v1/chat/completions` 调用成功
6. 能在 `/admin/usage/*` 与 `/admin/billing/*` 查到该请求

### 阶段 B：补齐 OpenAI reseller 主路径的协议正确性

状态：✓ 已完成（2026-04-28）。决策门槛 A 拍板「价格规则白名单」。

目标：

- 让 `/v1/chat/completions` 成为真正的主产品接口

必须完成：

1. ✓ 本地错误改为 OpenAI 风格错误体（`localHttpErrorBody` / `openAIErrorBody` / `isOpenAIStyleHttpPath` 已覆盖 `/v1/chat/completions` 与 `/v1/models`）
2. ✓ 新增 `GET /v1/models`（`HTTP_ROUTES` 注册 + `serveModelsCatalog` 按 user `billingCurrency` 走价格规则白名单，过滤 `isActive=false`、`model` 为空、`system-default-all-models-*` 与生效窗口外的规则；按 `model` 去重并按字典序输出 OpenAI 标准 envelope）
3. ✓ 将 user/device 路由保护扩展到 OpenAI 路径（`userStore.getRoutingGuardSnapshot` / `listRoutingGuardUserStats` / `listRoutingGuardDeviceStats` 三处 SQL 把 `/v1/chat/completions` 纳入与 `/v1/messages`、`/v1/sessions/ws` 同一桶；device affinity 仍按 Claude session 语义保持只看 `/v1/messages`）
4. ✓ 给 `openai-compatible` 补同请求 failover（`relayService.handleOpenAICompatibleHttp` 通过 `compatDisallowed` + `disallowedAccountIds` 复用 `SAME_REQUEST_MAX_RETRIES`）

验收：

1. ✓ 本地 401/402/429/5xx 错误体均符合 OpenAI 风格（`relayService.test.ts` 已覆盖 `BILLING_RULE_MISSING`、`BILLING_INSUFFICIENT_BALANCE`、`SCHEDULER_CAPACITY`、`RELAY_USER_REJECTED`、`METHOD_NOT_ALLOWED` 等场景）
2. ✓ `GET /v1/models` 只返回显式可售卖模型（`relayService.test.ts` 覆盖 currency / `isActive` / fallback prefix / 生效窗口 / 去重与排序）
3. ✓ 一个 channel 返回 `429` 后，请求可切到下一条 channel（`compatDisallowed` 同请求重试已有覆盖）
4. ✓ 用户或设备超额时，OpenAI 路径能收到本地限流拒绝（`userStore.test.ts` 覆盖 routing-guard 计入 `/v1/chat/completions`）

### 阶段 C：补齐上游成本与 channel 账本

目标：

- 能计算“向用户收了多少”和“向上游花了多少”

必须完成：

1. 新增 `upstream_price_rules`
2. 新增 `channel_balance_state` / `channel_balance_ledger`
3. `usage_records` 增加上游成本字段
4. 管理面可录入 channel 充值与调账

验收：

1. 同一条 usage 同时可看到用户收费和上游成本
2. channel 扣费与余额变化可追溯
3. 人工调账不会改写历史 usage

### 阶段 D：支付、公开注册、用户控制台

`待确认`

这一阶段不能仅凭当前仓库写成既定事实。实现前至少还要确认：

1. 支付渠道
2. 用户注册形态
3. 登录身份源
4. 合规与客服流程

---

## 11. 基于当前代码的最小人工闭环

以下步骤不依赖新增代码，适合作为第一轮 smoke test。

### 11.1 创建 routing group

```http
POST /admin/routing-groups
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "id": "reseller-openai",
  "name": "Reseller OpenAI",
  "isActive": true
}
```

### 11.2 创建 `openai-compatible` channel

```http
POST /admin/accounts/create
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "provider": "openai-compatible",
  "label": "upstream-a",
  "apiKey": "upstream-secret",
  "apiBaseUrl": "https://example-upstream/v1",
  "routingGroupId": "reseller-openai"
}
```

### 11.3 创建下游用户

```http
POST /admin/users
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "name": "demo-user",
  "billingCurrency": "USD"
}
```

### 11.4 把用户设为 prepaid 并绑定 group

```http
POST /admin/users/:userId/update
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "routingMode": "preferred_group",
  "routingGroupId": "reseller-openai",
  "billingMode": "prepaid"
}
```

### 11.5 配置显式价格规则

```http
POST /admin/billing/rules
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "name": "gpt-4.1 default",
  "currency": "USD",
  "model": "gpt-4.1",
  "inputPriceMicrosPerMillion": "1000000",
  "outputPriceMicrosPerMillion": "4000000"
}
```

### 11.6 给用户充值

```http
POST /admin/billing/users/:userId/ledger
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "kind": "topup",
  "amountMicros": "10000000",
  "note": "manual topup for smoke test"
}
```

### 11.7 以 `rk_` key 调用主路径

```http
POST /v1/chat/completions
Authorization: Bearer rk_xxx
Content-Type: application/json

{
  "model": "gpt-4.1",
  "messages": [
    { "role": "user", "content": "ping" }
  ]
}
```

### 11.8 验收查询

- `GET /admin/usage/summary`
- `GET /admin/users/:userId/requests`
- `GET /admin/billing/users/:userId`
- `GET /admin/billing/users/:userId/balance`

---

## 12. 待确认事项

以下内容仓库里没有足够证据，必须单独确认：

1. reseller MVP 是否公开支持 Anthropic `/v1/messages`，还是只做 OpenAI `/v1/chat/completions`
2. `GET /v1/models` 的模型目录来源，是“价格规则白名单”还是“价格规则与通道交集”
3. 是否允许单部署同时支持 `USD` 与 `CNY`
4. 支付渠道、公开注册、用户登录身份源
5. 是否要逐步淘汰 `relay_users.api_key`
6. 是否需要在 reseller 路径上支持 `POST /v1/embeddings`

---

## 13. 结论

当前仓库已经具备 reseller gateway 的一半骨架：

- 有 channel 存储
- 有 routing group
- 有下游用户
- 有多 key 管理
- 有 usage 与下游计费账本
- 有后台管理接口

真正阻碍“可售卖”的，不是基础设施从零开始，而是四个明确缺口：

1. OpenAI 主路径的协议正确性还不完整
2. OpenAI 主路径的 failover 与路由保护还不完整
3. 上游成本与 channel 账本还不存在
4. 支付与公开注册仍是待确认范围

因此，后续开发应优先按“阶段 A → B → C”的顺序推进，而不是先做支付或市场化外壳。
