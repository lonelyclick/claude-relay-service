# Claude Relay Service — Worker 分布式架构方案

## 一、架构总览

```
                                   ┌─ Worker A（机器A，IP-A）──→ Anthropic API
Client ──→ 前端（CF Pages）──→ 中心 ┤─ Worker B（机器B，IP-B）──→ Anthropic API
                                   ├─ Worker C（机器C，IP-C）──→ Anthropic API
                                   └─ 本地 Worker（中心同机）──→ Anthropic API（直连，零额外开销）
```

### 三个独立部署单元

| 部署单元 | 部署位置 | 职责 |
|---------|---------|------|
| **前端 SPA** | Cloudflare Pages / EdgeOne / 任意静态托管 | UI、管理面板、统计页面 |
| **中心服务 (Hub)** | 一台服务器 | 账号管理、调度、API 入口、Redis、统计、Webhook |
| **Worker** | 任意机器（含中心同机） | 接收任务、用本机 IP 发请求到 Anthropic、流回结果 |

---

## 二、通信架构：Worker 主动连接

### 2.1 连接方式：WebSocket

```
Worker ──WebSocket──→ Hub（中心）

连接建立流程：
1. Worker 启动，通过 WebSocket 连接 Hub
2. 携带 workerToken 认证（Hub 预先分配）
3. 连接成功后，Worker 上报：workerId、IP、支持的账号列表、当前负载
4. Hub 将此 Worker 加入可用 Worker 池
5. 心跳维持（30s 间隔）
```

**为什么用 WebSocket 而不是长轮询：**
- SSE 流式数据需要双向通信（Hub 推任务 + Worker 回传流数据）
- WebSocket 原生支持二进制和文本帧混合
- 心跳和状态同步更自然

### 2.2 请求流转（核心流程）

```
时序图：

Client          Hub                    Worker              Anthropic
  │               │                      │                    │
  ├─ POST ───────→│                      │                    │
  │               ├─ 选账号+选Worker ──→ │                    │
  │               │  (via WebSocket)     │                    │
  │               │                      ├─ HTTPS 请求 ─────→│
  │               │                      │                    │
  │               │                      │←── SSE 流 ────────┤
  │               │←── SSE 帧转发 ──────┤                    │
  │←── SSE 流 ───┤                      │                    │
  │               │                      │                    │
  │               │←── usage 数据 ──────┤                    │
  │               │  (统计+计费)         │                    │
```

### 2.3 本地 Worker 优化（零额外开销）

**核心思路：中心同机的 Worker 不走 WebSocket，直接 in-process 调用。**

```javascript
// Hub 内置一个 LocalWorker
// 调度器选中本地 Worker 时：
if (worker.type === 'local') {
  // 直接调用 relayRequest（现有逻辑，零改动）
  // 不经过 WebSocket、不序列化/反序列化
  return await localWorker.executeRequest(task)
}

if (worker.type === 'remote') {
  // 通过 WebSocket 发送给远程 Worker
  return await remoteWorkerProxy.executeRequest(worker, task)
}
```

**效果：**
- 绑定本地 Worker 的账号 = 现有行为，零性能损失
- 绑定远程 Worker 的账号 = 多一跳 WebSocket，但出口 IP 分散

---

## 三、数据模型变更

### 3.1 新增 Redis 数据结构

```
Worker 注册：
  worker:{workerId}  (Hash)
    ├─ id           — Worker UUID
    ├─ name         — 显示名称
    ├─ token        — 认证 Token（加密存储）
    ├─ type         — "local" | "remote"
    ├─ status       — "online" | "offline" | "draining"
    ├─ ip           — Worker 上报的出口 IP
    ├─ region       — 地理区域标签（可选）
    ├─ connectedAt  — 上次连接时间
    ├─ lastHeartbeat— 上次心跳时间
    ├─ maxConcurrency— 最大并发数
    ├─ currentLoad  — 当前进行中的请求数
    └─ metadata     — 扩展字段 JSON

Worker 索引：
  worker:index  (Set) — 所有 Worker ID

Worker 在线列表（内存）：
  Hub 进程内维护 Map<workerId, WebSocket>
```

### 3.2 账号绑定 Worker

现有 `claude:account:{id}` 增加字段：

```
  workerId  — 绑定的 Worker ID（可选）
              为空 = 由调度器自动分配
              填了 = 强制走指定 Worker
```

**调度逻辑变更：**
```
选账号 → 检查 account.workerId
  ├─ 有绑定 → 检查该 Worker 是否在线 → 在线则使用，离线则跳过
  └─ 无绑定 → 根据 Worker 负载均衡选择一个在线 Worker
```

---

## 四、模块拆分

### 4.1 Hub（中心服务）改动

**保留不变的：**
- Redis 连接和所有数据模型
- 账号管理（CRUD）
- API Key 管理
- 调度器（selectAccountForApiKey）— 增加 Worker 维度
- 统计和计费
- Webhook 通知
- Admin API

**新增的：**
- `src/services/worker/workerManager.js` — Worker 注册、心跳、状态管理
- `src/services/worker/workerRouter.js` — 请求路由到 Worker（本地/远程）
- `src/services/worker/localWorker.js` — 本地 Worker（复用现有 relay 逻辑）
- `src/services/worker/remoteWorkerProxy.js` — 远程 Worker 的 WebSocket 代理
- `src/routes/admin/workerAdmin.js` — Worker 管理 API（CRUD、监控）
- WebSocket Server（挂载在现有 HTTP Server 上）

**修改的：**
- `claudeRelayService.js` — `relayRequest` 和 `relayStreamRequest` 增加 Worker 路由分支
- `unifiedClaudeScheduler.js` — 选账号时考虑 Worker 可用性
- `claudeAccountService.js` — 账号增加 workerId 字段

### 4.2 Worker（远程进程）

**独立的 Node.js 进程，极轻量。**

```
claude-relay-worker/
├── src/
│   ├── index.js            — 入口：连接 Hub、注册、心跳
│   ├── wsClient.js         — WebSocket 客户端（含重连逻辑）
│   ├── requestExecutor.js  — 执行 HTTP 请求到 Anthropic API
│   ├── streamHandler.js    — SSE 流解析与转发
│   └── config.js           — 配置（Hub 地址、Worker Token、并发限制）
├── package.json
└── .env
```

**Worker 职责极简：**
1. 连接 Hub
2. 接收任务（账号凭据 + 请求体 + 请求头）
3. 用本机 IP 发 HTTPS 请求到 Anthropic API
4. 将响应流实时回传给 Hub
5. 汇报 usage 数据

**Worker 不需要：**
- Redis
- 账号管理逻辑
- 调度逻辑
- 前端文件
- Webhook

### 4.3 前端 SPA（独立部署）

**改动：**

1. **`vite.config.js`** — 新增环境变量 `VITE_API_BASE_URL`
   ```javascript
   // 生产环境：API 地址指向 Hub
   // 例如：https://relay-api.example.com
   ```

2. **`src/utils/request.js`** — axios baseURL 改为可配置
   ```javascript
   const baseURL = import.meta.env.VITE_API_BASE_URL || ''
   // 空字符串 = 同源（向后兼容现有部署方式）
   ```

3. **Hub 的 CORS 配置** — 允许前端域名跨域访问 Admin API

4. **新增 Worker 管理页面**：
   - `views/WorkersView.vue` — Worker 列表、状态监控
   - `components/workers/` — Worker 相关组件
   - 功能：查看在线 Worker、负载、IP、绑定的账号、手动注册 Worker Token

---

## 五、WebSocket 协议设计

### 5.1 消息格式（JSON）

```javascript
// 通用消息结构
{
  "type": "消息类型",
  "id": "消息ID（用于请求-响应关联）",
  "data": { ... }
}
```

### 5.2 连接与认证

```javascript
// Worker → Hub: 连接时的认证
ws://hub:3000/ws/worker?token=<workerToken>

// Hub → Worker: 认证成功
{ "type": "auth_ok", "data": { "workerId": "xxx" } }

// Hub → Worker: 认证失败
{ "type": "auth_error", "data": { "message": "Invalid token" } }
```

### 5.3 心跳

```javascript
// Worker → Hub: 心跳（30s 间隔）
{ "type": "heartbeat", "data": { "currentLoad": 3, "maxConcurrency": 10 } }

// Hub → Worker: 心跳回复
{ "type": "heartbeat_ack" }
```

### 5.4 请求执行

```javascript
// Hub → Worker: 分配任务
{
  "type": "request",
  "id": "req_001",
  "data": {
    "accountId": "acc_xxx",
    "credentials": {             // 加密传输的临时凭据
      "accessToken": "sk-ant-...",
      "tokenType": "bearer"
    },
    "proxy": null,               // Worker 用自己的 IP，不需要代理
    "upstream": {
      "url": "https://api.anthropic.com/v1/messages",
      "method": "POST",
      "headers": { ... },        // 已处理好的请求头
      "body": { ... }            // 已处理好的请求体
    },
    "stream": true               // 是否流式
  }
}

// Worker → Hub: 非流式响应
{
  "type": "response",
  "id": "req_001",
  "data": {
    "statusCode": 200,
    "headers": { ... },
    "body": { ... }
  }
}

// Worker → Hub: 流式响应（多帧）
{ "type": "stream_start", "id": "req_001", "data": { "statusCode": 200, "headers": {...} } }
{ "type": "stream_data",  "id": "req_001", "data": "event: message_start\ndata: {...}\n\n" }
{ "type": "stream_data",  "id": "req_001", "data": "event: content_block_delta\ndata: {...}\n\n" }
...
{ "type": "stream_end",   "id": "req_001", "data": { "usage": {...} } }

// Worker → Hub: 请求失败
{
  "type": "request_error",
  "id": "req_001",
  "data": {
    "statusCode": 429,
    "headers": { "anthropic-ratelimit-unified-reset": "1711700000" },
    "body": { "error": { "type": "rate_limit_error", ... } }
  }
}
```

### 5.5 流式数据传输优化

**关键考量：SSE chunk 可能很大（长文本生成），需要高效传输。**

```javascript
// 方案：批量发送 + 低延迟
// Worker 收到 SSE chunk 后不逐行发，而是：
// 1. 收到 chunk 立即放入缓冲
// 2. 每 10ms 或缓冲 > 4KB 时 flush 一次
// 3. WebSocket 单帧发送（减少帧开销）

// 对于本地 Worker：完全跳过序列化，直连 stream pipe
```

---

## 六、安全设计

### 6.1 Worker Token

- Hub 管理面板生成 Worker Token（类似 API Key）
- Token 存储在 Redis 中，加密
- Worker 连接时携带 Token 认证
- 支持撤销（踢掉在线 Worker）

### 6.2 凭据传输

```
Hub 发给 Worker 的凭据（accessToken 等）：
- 仅在请求执行时临时传输
- Worker 不持久化存储任何凭据
- WebSocket 建议用 wss://（TLS 加密）
- 内网 Worker 可选用 ws://（性能优先）
```

### 6.3 前端 CORS

```
Hub 新增 CORS 白名单配置：
  CORS_ALLOWED_ORIGINS=https://relay-admin.pages.dev,https://relay.example.com

仅 Admin API 和 User API 开启 CORS
Relay API（客户端请求转发）不受影响
```

---

## 七、前端独立部署方案

### 7.1 构建配置变更

```bash
# .env.production（Cloudflare Pages 部署时）
VITE_API_BASE_URL=https://relay-hub.example.com
VITE_APP_BASE_URL=/
```

### 7.2 Cloudflare Pages 部署

```
构建命令：cd web/admin-spa && npm run build
输出目录：web/admin-spa/dist
环境变量：VITE_API_BASE_URL=https://relay-hub.example.com
```

### 7.3 向后兼容

**不改变现有部署方式。** 如果不设 `VITE_API_BASE_URL`：
- `request.js` 的 baseURL = `''`（空字符串）
- = 同源请求 = 现有行为完全不变
- Express 仍然 serve 前端静态文件 = 一体化部署照常工作

---

## 八、实施步骤（优先级排序）

### Phase 1：基础通信层（核心）
1. Hub 端 WebSocket Server（挂载在现有 HTTP Server）
2. Worker 认证和注册协议
3. 心跳与断线重连
4. Worker CRUD API（Admin）
5. Worker Redis 数据模型

### Phase 2：请求路由（核心）
1. LocalWorker — 包装现有 relay 逻辑
2. RemoteWorkerProxy — WebSocket 任务分发
3. 修改调度器 — 账号选择后增加 Worker 路由
4. 非流式请求的完整链路
5. 流式请求的完整链路（SSE over WebSocket）

### Phase 3：前端独立部署
1. `request.js` 改 baseURL 可配置
2. Hub CORS 配置
3. Cloudflare Pages 部署脚本

### Phase 4：前端 Worker 管理
1. Worker 列表页面
2. Worker Token 生成
3. Worker 状态实时监控（WebSocket 推送到前端）
4. 账号-Worker 绑定 UI

### Phase 5：Worker 独立项目
1. 创建 `claude-relay-worker` 独立 npm 项目
2. WebSocket 客户端 + 重连
3. HTTP 请求执行器
4. SSE 流解析和回传
5. 配置和部署文档

---

## 九、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| WebSocket 断连导致请求丢失 | 进行中的请求失败 | 请求级超时检测 + Hub 端对未完成请求做 fallback（切本地 Worker 重试） |
| 远程 Worker 延迟增加 | 首字节时间变长 | 本地 Worker 零开销；远程 Worker 批量 flush 减少帧数 |
| 凭据在 WebSocket 中传输 | 安全风险 | 强制 wss:// 或内网部署；凭据不落盘 |
| Worker 进程崩溃 | 该 Worker 所有请求中断 | 心跳检测 3 次失败 → 标记离线 → 调度器跳过 |
| 向后兼容 | 现有部署方式不能break | LocalWorker 默认启用 = 不配远程 Worker 时行为不变 |
