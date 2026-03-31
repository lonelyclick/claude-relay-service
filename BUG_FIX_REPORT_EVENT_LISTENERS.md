# Bug 修复报告 - 事件监听器内存泄漏（第二轮）

**日期**: 2026-03-31
**修复范围**: 流式响应事件监听器管理
**严重程度**: 中等 → 高（长时间运行导致内存累积泄漏）

---

## 修复概要

本轮发现并修复了 **2 个新的事件监听器内存泄漏问题**：

1. **Bug #3**: Azure OpenAI 流式响应事件监听器泄漏
2. **Bug #4**: CCR 流式响应事件监听器泄漏

这些问题与第一轮修复的 Bug #2（OpenAI Responses 监听器泄漏）性质相同，都是在流式响应处理中添加了事件监听器但未在所有退出路径中清理。

---

## Bug #3: Azure OpenAI 流式响应事件监听器泄漏

### 问题描述

**文件**: `src/services/relay/azureOpenaiRelayService.js`
**位置**: 第 613-615 行
**严重程度**: 中等

### 根本原因

在 `handleStreamResponse()` 函数中：

```javascript
// 添加监听器（第 613-615 行）
const clientCleanup = () => {
  streamManager.cleanup(streamId)
}

clientResponse.on('close', clientCleanup)
clientResponse.on('aborted', clientCleanup)
clientResponse.on('error', clientCleanup)
```

但在流结束处理（`upstreamResponse.data.on('end')`）和错误处理（`upstreamResponse.data.on('error')`）中，**从未移除这些监听器**。

### 影响分析

- **内存泄漏**: 每个 Azure OpenAI 流式请求泄漏 3 个事件监听器
- **累积效应**: 在高并发或长时间运行的服务中，监听器会持续累积
- **EventEmitter 警告**: 当单个 `clientResponse` 上的监听器超过 10 个时，Node.js 会输出警告
- **性能下降**: 大量未清理的监听器会拖慢事件分发性能

### 修复方案

在所有流退出路径中添加监听器清理：

1. **正常结束路径** (`upstreamResponse.data.on('end')`)：
```javascript
// 清理客户端监听器
clientResponse.removeListener('close', clientCleanup)
clientResponse.removeListener('aborted', clientCleanup)
clientResponse.removeListener('error', clientCleanup)
```

2. **错误路径** (`upstreamResponse.data.on('error')`)：
```javascript
// 清理客户端监听器
clientResponse.removeListener('close', clientCleanup)
clientResponse.removeListener('aborted', clientCleanup)
clientResponse.removeListener('error', clientCleanup)
```

### 测试验证

**验证步骤**：
1. 监控 Node.js 进程的事件监听器数量
2. 执行 1000 次 Azure OpenAI 流式请求
3. 确认监听器数量保持稳定，没有累积增长

**预期结果**：
- 修复前：每次请求后监听器数量增加 3
- 修复后：监听器数量保持稳定

---

## Bug #4: CCR 流式响应事件监听器泄漏

### 问题描述

**文件**: `src/services/relay/ccrRelayService.js`
**位置**: 第 1069、1077 行
**严重程度**: 中等

### 根本原因

在 `_makeCcrStreamRequest()` 函数中：

```javascript
// 添加监听器（第 1069-1080 行）
responseStream.on('close', () => {
  logger.info('🔌 Client disconnected from CCR stream')
  aborted = true
  if (response.data && typeof response.data.destroy === 'function') {
    response.data.destroy()
  }
})

responseStream.on('error', (err) => {
  logger.error('❌ Response stream error:', err)
  aborted = true
})
```

但在 `response.data.on('end')` 和 `response.data.on('error')` 处理中，**从未移除这些监听器**。

### 影响分析

- **内存泄漏**: 每个 CCR 流式请求泄漏 2 个事件监听器
- **特别影响**: CCR 是核心转发服务，流量大时泄漏更严重
- **跨账户累积**: 多个 CCR 账户同时工作会加速监听器累积
- **资源耗尽风险**: 长时间运行后可能耗尽 EventEmitter 的监听器容量

### 修复方案

**重构方案**：将匿名监听器改为命名函数，便于清理

1. **定义监听器函数**：
```javascript
const handleStreamClose = () => {
  logger.info('🔌 Client disconnected from CCR stream')
  aborted = true
  if (response.data && typeof response.data.destroy === 'function') {
    response.data.destroy()
  }
}

const handleStreamError = (err) => {
  logger.error('❌ Response stream error:', err)
  aborted = true
}

responseStream.on('close', handleStreamClose)
responseStream.on('error', handleStreamError)
```

2. **正常结束路径清理**：
```javascript
response.data.on('end', () => {
  // ... 处理 usage 数据 ...

  // 清理 responseStream 监听器
  responseStream.removeListener('close', handleStreamClose)
  responseStream.removeListener('error', handleStreamError)

  // ... 结束响应 ...
})
```

3. **错误路径清理**：
```javascript
response.data.on('error', (err) => {
  logger.error('❌ Stream data error:', err)

  // 清理 responseStream 监听器
  responseStream.removeListener('close', handleStreamClose)
  responseStream.removeListener('error', handleStreamError)

  // ... 错误处理 ...
})
```

### 测试验证

**验证步骤**：
1. 模拟高并发 CCR 流式请求场景
2. 使用 `process._getActiveHandles()` 监控活跃句柄数量
3. 观察长时间运行后的监听器数量

**预期结果**：
- 修复前：监听器数量随请求数量线性增长
- 修复后：监听器数量保持在正常范围内

---

## 修复文件清单

| 文件 | 修改内容 | 影响范围 |
|------|---------|---------|
| `src/services/relay/azureOpenaiRelayService.js` | 在 `end` 和 `error` 处理中添加监听器清理 | Azure OpenAI 流式请求 |
| `src/services/relay/ccrRelayService.js` | 重构监听器为命名函数并添加清理逻辑 | CCR 流式请求 |

---

## 代码审查要点

### 事件监听器管理最佳实践

1. **命名函数优于匿名函数**：
   ```javascript
   // ❌ 不好：匿名函数无法移除
   stream.on('close', () => { cleanup() })

   // ✅ 好：命名函数可以精确移除
   const handleClose = () => { cleanup() }
   stream.on('close', handleClose)
   stream.removeListener('close', handleClose)
   ```

2. **所有退出路径都要清理**：
   - 正常结束（`end`）
   - 错误结束（`error`）
   - 客户端断开（`close`, `aborted`）
   - 超时或中断

3. **使用 `once()` 替代 `on()` + `removeListener()`**：
   ```javascript
   // ❌ 需要手动清理
   stream.on('end', handler)
   // ... 稍后 ...
   stream.removeListener('end', handler)

   // ✅ 自动清理（仅触发一次）
   stream.once('end', handler)
   ```

4. **监控工具**：
   ```javascript
   // 检查 EventEmitter 的监听器数量
   console.log(stream.listenerCount('close'))

   // 获取所有监听器
   console.log(stream.listeners('close'))
   ```

---

## 累积影响分析

### 已修复的事件监听器泄漏

| Bug | 服务 | 每次请求泄漏 | 影响范围 |
|-----|------|-------------|---------|
| #2 | OpenAI Responses | 2 个 (`req.on('close')`, `req.on('aborted')`) | 流式请求 |
| #3 | Azure OpenAI | 3 个 (`clientResponse.on('close/aborted/error')`) | 流式请求 |
| #4 | CCR | 2 个 (`responseStream.on('close/error')`) | 流式请求 |

### 修复前后对比

假设一个中等负载的生产环境：
- **每日流式请求数**: 50,000 次
- **请求分布**: OpenAI Responses (40%), Azure OpenAI (20%), CCR (40%)

**修复前（每日泄漏）**：
- OpenAI Responses: 20,000 × 2 = 40,000 个监听器
- Azure OpenAI: 10,000 × 3 = 30,000 个监听器
- CCR: 20,000 × 2 = 40,000 个监听器
- **总计**: 110,000 个监听器泄漏/天

**修复后**：
- 所有监听器正常清理，内存使用稳定

---

## 相关 Bug 追踪

- **Bug #1**: Worker 重连时挂起的请求未清理 ✅ 已在代码库中修复
- **Bug #2**: OpenAI Responses 流式响应监听器泄漏 ✅ 第一轮修复完成
- **Bug #3**: Azure OpenAI 流式响应监听器泄漏 ✅ 本轮修复
- **Bug #4**: CCR 流式响应监听器泄漏 ✅ 本轮修复
- **Bug #5**: Worker 流式请求 usage 统计失效 ✅ 已通过 Hub 端 SSE 解析解决

---

## 后续建议

### 1. 全面代码审计

使用以下 grep 命令查找所有事件监听器注册：

```bash
# 查找所有 .on() 调用
grep -rn "\.on\(['\"]" src/services/relay/

# 查找对应的 .removeListener() 调用
grep -rn "\.removeListener\(['\"]" src/services/relay/
```

**关注点**：
- 每个 `.on()` 是否有对应的 `.removeListener()`
- 是否可以使用 `.once()` 代替
- 是否所有退出路径都清理了监听器

### 2. 监控和告警

在生产环境添加监控：

```javascript
// 定期检查监听器数量
setInterval(() => {
  const eventNames = ['close', 'error', 'aborted', 'end']
  eventNames.forEach(name => {
    const count = stream.listenerCount(name)
    if (count > 5) {
      logger.warn(`⚠️ High listener count for '${name}': ${count}`)
    }
  })
}, 60000) // 每分钟检查一次
```

### 3. 单元测试

添加监听器泄漏检测测试：

```javascript
test('should not leak event listeners', async () => {
  const initialCount = stream.listenerCount('close')

  await handleStreamRequest()

  const finalCount = stream.listenerCount('close')
  expect(finalCount).toBe(initialCount) // 监听器数量应该恢复
})
```

### 4. 使用 EventEmitter 诊断工具

```javascript
// 启用内存泄漏警告
require('events').EventEmitter.defaultMaxListeners = 10

// 捕获警告事件
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    logger.error('EventEmitter 监听器泄漏警告:', warning)
  }
})
```

---

## 总结

**本轮修复成果**：
- ✅ 修复 Azure OpenAI 流式响应的 3 个监听器泄漏点
- ✅ 修复 CCR 流式响应的 2 个监听器泄漏点
- ✅ 建立了事件监听器管理的最佳实践模式
- ✅ 所有代码格式化并通过 Prettier 检查

**预期效果**：
- 消除流式请求的内存泄漏隐患
- 提升长时间运行的稳定性
- 降低 EventEmitter 警告的发生频率
- 改善整体系统资源使用效率

**重要提示**：
这是第二轮监听器泄漏修复，与第一轮（OpenAI Responses）合并后，所有主要流式转发服务的监听器管理问题均已解决。建议对其他服务（Claude、Gemini）也进行类似审计。
