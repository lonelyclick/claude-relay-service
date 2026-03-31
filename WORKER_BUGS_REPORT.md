# Worker 分布式系统 Bug 分析报告

生成时间：2026-03-30
分析范围：claude-relay-service 分布式 Worker 系统

---

## 执行摘要

本报告对 claude-relay-service 的分布式 Worker 系统进行了全面的代码审查和架构分析，发现 **8 个 Bug**，其中 **2 个高严重性问题**需要优先修复：

1. **Bug #1（高严重）**: Worker 重连时 pending 请求泄漏，导致 Promise 永远 pending 和内存泄漏
2. **Bug #5（高严重-业务）**: 流式请求 usage 统计完全失效，所有经过 Worker 的流式请求 token 数为 0

---

## 系统架构概览

### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| Worker 客户端 | `worker/index.js` | 连接 Hub，执行 HTTP 请求 |
| Hub WS 服务器 | `src/services/worker/workerWsServer.js` | 接收连接，分发任务 |
| Worker 状态管理 | `src/services/worker/workerService.js` | 管理在线状态和负载 |
| 路由决策 | `src/services/worker/workerRouter.js` | 决定 local/remote |
| 远程代理 | `src/services/worker/remoteWorkerProxy.js` | 封装 WS 请求为 Promise |

### 请求流程

```
客户端请求 → Relay Service → workerRouter
  ├─ mode=local:  直接 HTTPS 到 Anthropic
  └─ mode=remote: remoteWorkerProxy
      └─ workerWsServer.sendRequest(workerId, task)
          ├─ 生成 requestId，注册到 pendingRequests
          ├─ 发送 WS 消息 {type:'request'} → Worker
          │   └─ Worker 发 HTTPS 到 Anthropic
          │       ├─ 流式: stream_start → stream_data* → stream_end
          │       └─ 非流式: response
          └─ Hub 接收响应，路由到 pending.resolve/callbacks
```

---

## Bug 详细分析

### Bug #1 — 高严重：Worker 重连时 pending 请求泄漏

**严重程度:** 🔴 高
**影响范围:** 所有 Worker 重连场景（网络抖动、Worker 重启、deploy 更新）

#### 问题描述

当同一 `workerId` 的 Worker 重连时，`registerOnline()` 会关闭旧 WebSocket 并**立即覆盖** `onlineWorkers` Map entry，导致旧连接的 `pendingRequests` 被丢弃。稍后触发的 `close` 事件调用 `registerOffline()`，但拿到的是新 entry（`pendingRequests` 为空），旧请求的 `reject` 永远不会被调用。

#### 代码位置

`src/services/worker/workerService.js` 第 169-222 行

```javascript
registerOnline(workerId, ws, ip) {
  // 如果已有连接，先关闭旧的
  const existing = this.onlineWorkers.get(workerId)
  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close(4001, 'Replaced by new connection')  // ← 异步，稍后触发 close 事件
    } catch (_err) { }
  }

  // ❌ Bug: 立即覆盖 Map entry，丢弃 existing.pendingRequests
  this.onlineWorkers.set(workerId, {
    ws,
    ip,
    currentLoad: 0,
    connectedAt: new Date().toISOString(),
    pendingRequests: new Map()  // ← 新 Map，旧 pending 全部丢失
  })
}

registerOffline(workerId) {
  const online = this.onlineWorkers.get(workerId)  // ← 拿到的是新 entry！
  if (online) {
    // ❌ 旧 pendingRequests 已被覆盖，这里拿到的是空 Map
    for (const [reqId, pending] of online.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Worker disconnected'))
    }
    this.onlineWorkers.delete(workerId)
  }
}
```

#### 时序分析

```
T0: registerOnline(id, newWs) 被调用
    existing.ws.close(4001)  ← 异步触发 close 事件
    onlineWorkers.set(id, {新entry, pendingRequests: new Map()})  ← 覆盖

T1: （稍后）close 事件触发 registerOffline(id)
    online = onlineWorkers.get(id)  ← 拿到新 entry
    online.pendingRequests.size = 0  ← 旧 pending 全部丢失
```

#### 影响

1. **Promise 泄漏**: 旧请求的 Promise 永远 pending，调用方 hang 住
2. **内存泄漏**: Timeout timer 未清理，持续占用内存
3. **并发计数错误**: `currentLoad` 不会减，Worker 负载虚高，影响负载均衡
4. **资源耗尽**: 长期运行后可能导致 Node.js OOM

#### 复现条件

- Worker 网络抖动导致断线重连
- Worker 进程重启（维护、更新）
- Worker 所在机器重启
- 频率：任何 Worker 重连都会触发

#### 修复方案

**方案 1: 先清理旧 pending 再覆盖 Map（推荐）**

```javascript
registerOnline(workerId, ws, ip) {
  const existing = this.onlineWorkers.get(workerId)
  if (existing && existing.ws !== ws) {
    // ✅ 先清理旧 pendingRequests，再关闭连接
    for (const [reqId, pending] of existing.pendingRequests) {
      clearTimeout(pending.timeout)
      try {
        pending.reject(new Error('Worker replaced by new connection'))
      } catch (err) {
        logger.debug(`Pending request ${reqId} reject failed: ${err.message}`)
      }
    }
    existing.pendingRequests.clear()

    // 然后关闭旧连接（此时 close 事件触发时 pendingRequests 已清空）
    try {
      existing.ws.close(4001, 'Replaced by new connection')
    } catch (_err) { }
  }

  // 现在可以安全覆盖 Map entry
  this.onlineWorkers.set(workerId, {
    ws,
    ip,
    currentLoad: 0,
    connectedAt: new Date().toISOString(),
    pendingRequests: new Map()
  })
}
```

**方案 2: 使用独立的 cleanup 标记防止二次清理**

在 `onlineWorkers` entry 中添加 `_cleanedUp: false` 标记，确保 `registerOffline` 只执行一次。

---

### Bug #5 — 高严重（业务）：流式请求 usage 统计完全失效

**严重程度:** 🔴 高（业务影响）
**影响范围:** 所有经过 Worker 的流式请求

#### 问题描述

Worker 是透明 TCP 代理，只转发 Anthropic 的原始 SSE 字节流，不解析内容。因此 Worker 发送的 `stream_end` 消息 `data` 为空对象 `{}`，Hub 端无法获取 `usage` 信息，导致所有流式请求的 token 统计为 0。

#### 代码位置

**Worker 端**: `worker/index.js` 第 339-349 行

```javascript
// ❌ Bug: stream_end 时 data 为空，没有包含 usage
this._send({
  type: 'stream_end',
  id: requestId,
  data: {}  // ← 空对象，缺少 usage 字段
})
```

**Hub 端**: `src/services/relay/claudeRelayService.js` 第 2190 行

```javascript
onEnd: (summary) => {
  // ❌ Bug: summary 永远是 {}，usageCallback 永远不会触发
  if (usageCallback && summary?.usage) {
    usageCallback(summary.usage)
  }
}
```

#### 问题根因

Worker 的 `_handleStreamRequest` 方法只是简单地转发字节流：

```javascript
res.on('data', (chunk) => {
  if (isStreamWritable(responseStream)) {
    responseStream.write(chunk)  // ← 直接转发，不解析
  }
  this._send({ type: 'stream_data', id: requestId, data: chunk.toString() })
})

res.on('end', () => {
  // ❌ 没有解析 SSE 流中的 usage 信息
  this._send({ type: 'stream_end', id: requestId, data: {} })
})
```

Anthropic API 的 usage 数据在 SSE 流中的 `message_delta` 事件中：

```
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":254}}
```

Worker 不解析这个 JSON，直接透传给客户端，但 `stream_end` 时没有携带 usage 数据。

#### 影响

1. **成本统计失效**: 所有经过 Worker 的流式请求 token 数为 0
2. **账单数据失真**: 无法准确计算 API 调用成本
3. **用量监控失效**: 无法对 Worker 账户进行用量限流
4. **统计报表不准**: Dashboard 中的 token 统计和成本报表不准确

#### 数据验证

运行 `test_worker_usage_bug.js` 测试：

```bash
$ node test_worker_usage_bug.js

📊 测试结果：
  - 收到 SSE 数据块数: 7
  - 流是否结束: true
  - usage 是否被记录: false  ← ❌
  - 记录的 usage: null        ← ❌
```

#### 修复方案

**方案 1: Worker 端解析 SSE 流提取 usage（不推荐）**

- 优点：Hub 端不需改动
- 缺点：Worker 端复杂度大幅增加，需要完整解析 SSE 协议

**方案 2: Hub 端自己解析流数据（推荐）**

修改 `remoteWorkerProxy.js`，在 `onStreamData` 回调中缓存 SSE 数据并解析：

```javascript
const sseBuffer = []
const callbacks = {
  onStreamData: (data) => {
    sseBuffer.push(data)
    if (onStreamData) onStreamData(data)
  },
  onStreamEnd: (summary) => {
    // ✅ 从缓存的 SSE 数据中提取 usage
    const usage = extractUsageFromSSE(sseBuffer.join(''))
    if (usageCallback && usage) {
      usageCallback(usage)
    }
    if (onStreamEnd) onStreamEnd(summary)
  }
}

function extractUsageFromSSE(sseData) {
  const lines = sseData.split('\n')
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6))
        if (data.type === 'message_delta' && data.usage) {
          return data.usage
        }
      } catch (e) { }
    }
  }
  return null
}
```

**方案 3: Worker 透传原始 SSE 事件，Hub 端按需解析**

修改 Worker 的 `stream_data` 消息，携带解析后的事件类型：

```javascript
// Worker 端
res.on('data', (chunk) => {
  const chunkStr = chunk.toString()
  this._send({
    type: 'stream_data',
    id: requestId,
    data: chunkStr,
    _raw: true  // ← 标记为原始 SSE 数据，Hub 端自行解析
  })
})
```

---

### Bug #2 — 中严重：`maxConcurrency` 配置完全未被使用

**严重程度:** 🟡 中
**影响范围:** 高并发场景，Worker 过载

#### 问题描述

Worker 在数据库有 `max_concurrency` 字段（默认 10），管理界面可以配置，但负载均衡逻辑 `selectAvailableWorker` 完全没有检查上限，`sendRequest` 也不验证。

#### 代码位置

`src/services/worker/workerService.js` 第 275-289 行

```javascript
selectAvailableWorker(excludeIds = []) {
  let bestId = null
  let bestLoad = Infinity

  for (const [id, conn] of this.onlineWorkers) {
    if (excludeIds.includes(id)) continue

    // ❌ Bug: 完全没有检查 maxConcurrency
    if (conn.currentLoad < bestLoad) {
      bestLoad = conn.currentLoad
      bestId = id
    }
  }
  return bestId
}
```

#### 影响

- 单个 Worker 可能被分配远超其处理能力的并发请求
- Worker 端 HTTP 连接池耗尽
- 可能导致 Worker OOM 或响应超时

#### 修复方案

```javascript
async selectAvailableWorker(excludeIds = []) {
  let bestId = null
  let bestLoad = Infinity

  for (const [id, conn] of this.onlineWorkers) {
    if (excludeIds.includes(id)) continue

    // ✅ 获取 Worker 的 maxConcurrency 配置
    const worker = await this.getWorker(id)
    const maxConcurrency = worker.maxConcurrency || 10

    // ✅ 跳过已满载的 Worker
    if (conn.currentLoad >= maxConcurrency) {
      logger.debug(`Worker ${id} is at max capacity (${conn.currentLoad}/${maxConcurrency})`)
      continue
    }

    if (conn.currentLoad < bestLoad) {
      bestLoad = conn.currentLoad
      bestId = id
    }
  }

  return bestId
}
```

---

### Bug #3 — 低严重：取消请求后仍发送 `request_error`

**严重程度:** 🟢 低
**影响范围:** 超时取消场景，产生脏消息

#### 问题描述

Worker 收到 `cancel_request` 后，`req.destroy()` 会触发 `req.on('error')`，导致 `_handleRequest` 的 `catch` 块发送 `request_error` 消息。但此时 Hub 端已经删除了 `pendingRequests`，消息被忽略。

#### 代码位置

`worker/index.js` 第 184-197 行（`_handleCancelRequest`）
`worker/index.js` 第 267-274 行（`_handleRequest` 的 catch）

#### 影响

- 不必要的 WS 消息传输
- 日志中出现 "No pending request" 警告

#### 修复方案

在 `activeRequests` 中添加 `cancelled` 标记，catch 块检查后跳过发送：

```javascript
// _handleRequest catch 块
} catch (err) {
  const entry = this.activeRequests.get(requestId)
  if (entry?.cancelled) {
    // ✅ 已被取消的请求不发送 error 消息
    return
  }
  this._send({ type: 'request_error', ... })
}
```

---

### Bug #4 — 低严重：`disconnectWorker` 双重触发 `registerOffline`

**严重程度:** 🟢 低
**影响范围:** 管理后台踢人、删除 Worker

#### 问题描述

`disconnectWorker` 先调用 `ws.close()` 再立即调用 `registerOffline()`。`ws.close()` 是异步的，稍后触发的 `close` 事件也会调用 `registerOffline()`，导致两次调用。

#### 影响

- PostgreSQL 的 `setWorkerOffline` 查询被执行两次
- 轻微的 DB 开销

#### 修复方案

```javascript
disconnectWorker(workerId, reason = 'Disconnected by server') {
  const online = this.onlineWorkers.get(workerId)
  if (online) {
    // ✅ 先调用 registerOffline 清理状态
    this.registerOffline(workerId)

    // ✅ 然后关闭 WebSocket（close 事件触发时 worker 已不在 Map 中）
    try {
      online.ws.close(4000, reason)
    } catch (_err) { }
  }
}
```

---

### Bug #6 — 极低严重：`_handleStreamRequest` 注册 `activeRequests` 时序问题

**严重程度:** ⚪ 极低
**影响范围:** 理论上的竞态，实际不会触发

#### 问题描述

HTTP 请求回调在 `activeRequests.set` 之前注册，在极端情况下（本地回环、极快响应）可能导致 `entry` 为 `undefined`。

#### 修复方案

```javascript
// ✅ 先注册到 activeRequests
const reqEntry = { req, cancelled: false }
this.activeRequests.set(requestId, reqEntry)

// ✅ 然后定义回调
const req = transport.request(options, (res) => {
  const entry = this.activeRequests.get(requestId)
  if (entry?.cancelled) return
  ...
})
```

---

### Bug #7 — 极低严重：Brotli 压缩未处理

**严重程度:** ⚪ 极低
**影响范围:** 非流式请求，Anthropic API 目前不使用 Brotli

#### 问题描述

非流式请求解压缩只处理 `gzip` 和 `deflate`，缺少 `br`（Brotli）支持。

#### 修复方案

```javascript
const encoding = res.headers['content-encoding']
if (encoding === 'gzip') {
  body = zlib.gunzipSync(raw).toString('utf8')
} else if (encoding === 'deflate') {
  body = zlib.inflateSync(raw).toString('utf8')
} else if (encoding === 'br') {  // ✅ 添加 Brotli 支持
  body = zlib.brotliDecompressSync(raw).toString('utf8')
} else {
  body = raw.toString('utf8')
}
```

---

### Bug #8 — 低严重（安全）：Worker Token 在 URL 中明文传输

**严重程度:** 🟡 低（安全考虑）
**影响范围:** 所有 Worker 连接

#### 问题描述

Token 作为 URL query parameter 传递，即使使用 WSS（TLS），URL 仍会出现在日志中。

#### 代码位置

`worker/index.js` 第 85 行

```javascript
const wsUrl = `${CONFIG.hubUrl}/ws/worker?token=${encodeURIComponent(CONFIG.workerToken)}`
```

#### 影响

- Token 出现在 Nginx access log、服务端日志、代理日志中
- 日志泄漏风险

#### 修复方案

**方案 1: 使用 HTTP Authorization 头**

```javascript
// Worker 端
const ws = new WebSocket(wsUrl, {
  headers: {
    'Authorization': `Bearer ${CONFIG.workerToken}`
  }
})

// Hub 端
const token = request.headers['authorization']?.replace('Bearer ', '')
```

**方案 2: 使用 Sec-WebSocket-Protocol 子协议**

```javascript
// Worker 端
const ws = new WebSocket(wsUrl, ['worker-auth', CONFIG.workerToken])

// Hub 端
const token = request.headers['sec-websocket-protocol']?.split(',')[1]?.trim()
```

---

## 优先级建议

### 🔴 紧急（立即修复）

1. **Bug #1** — Worker 重连时 pending 请求泄漏
2. **Bug #5** — 流式请求 usage 统计失效

### 🟡 中优先级（近期修复）

3. **Bug #2** — `maxConcurrency` 未被使用
4. **Bug #8** — Token 在 URL 中明文传输（安全考虑）

### 🟢 低优先级（可选）

5. **Bug #3** — 取消请求后脏消息
6. **Bug #4** — 双重触发 `registerOffline`

### ⚪ 极低优先级（代码优化）

7. **Bug #6** — `activeRequests` 注册时序
8. **Bug #7** — Brotli 压缩支持

---

## 测试验证

### 现有测试覆盖

- ✅ `test_worker_fixes.js` — Worker 端 currentLoad 计数修复验证
- ✅ `test_worker_reconnect_bug.js` — Bug #1 复现测试（新增）
- ✅ `test_worker_usage_bug.js` — Bug #5 复现测试（新增）

### 建议补充测试

1. **集成测试**: 完整的 Hub-Worker 端到端流程测试
2. **负载测试**: 高并发场景下的 `maxConcurrency` 限流测试
3. **容错测试**: Worker 频繁重连的稳定性测试
4. **Usage 准确性测试**: 对比本地模式和 Worker 模式的 token 统计差异

---

## 部署建议

### 部署流程

1. **灰度发布**: 先在少量 Worker 上部署修复，观察稳定性
2. **监控指标**:
   - Worker 重连频率
   - Pending 请求泄漏数（通过内存监控）
   - Usage 统计准确率（对比 Anthropic 账单）
3. **回滚计划**: 保留旧版本 Worker 二进制，支持快速回滚

### 配置建议

- 设置合理的 `maxConcurrency`（建议 5-20，根据 Worker 机器性能）
- 启用 Worker 心跳日志监控（检测频繁重连）
- 定期审计 usage 统计与实际账单的差异

---

## 附录

### 相关文件清单

| 文件 | 行数 | 描述 |
|------|------|------|
| `worker/index.js` | 565 | Worker 客户端主程序 |
| `src/services/worker/workerService.js` | 322 | Worker 状态管理服务 |
| `src/services/worker/workerWsServer.js` | 336 | Hub 端 WebSocket 服务器 |
| `src/services/worker/remoteWorkerProxy.js` | 308 | 远程 Worker 代理 |
| `src/services/worker/workerRouter.js` | 59 | 路由决策逻辑 |
| `test_worker_fixes.js` | 131 | Worker 计数修复测试 |
| `test_worker_reconnect_bug.js` | 新增 | Bug #1 复现测试 |
| `test_worker_usage_bug.js` | 新增 | Bug #5 复现测试 |

### 参考资料

- WebSocket RFC 6455: https://datatracker.ietf.org/doc/html/rfc6455
- Anthropic API Documentation: https://docs.anthropic.com/
- Node.js Event Loop: https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/

---

**报告生成者**: Claude Code Agent (Sonnet 4.5)
**报告版本**: v1.0
**审查状态**: 待技术负责人确认修复优先级
