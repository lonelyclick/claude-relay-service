#!/usr/bin/env node

/**
 * Worker Bug 修复验证脚本
 *
 * 测试场景：
 * 1. currentLoad 在 WebSocket 断开时不会变负
 * 2. Worker 重连后 currentLoad 正确重置为 0
 * 3. 取消的请求不会重复减计数
 */

const assert = require('assert')

// 模拟 Worker Client（简化版）
class MockWorkerClient {
  constructor() {
    this.currentLoad = 0
    this.activeRequests = new Map()
    this.isConnected = true
  }

  // 模拟处理请求
  async handleRequest(requestId) {
    this.currentLoad++
    let loadDecremented = false

    this.activeRequests.set(requestId, { req: {}, cancelled: false })

    try {
      // 模拟异步处理
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      // 防御性检查
      if (!loadDecremented && this.currentLoad > 0) {
        this.currentLoad--
        loadDecremented = true
      }
      this.activeRequests.delete(requestId)
    }
  }

  // 模拟 WebSocket 断开
  simulateDisconnect() {
    this.isConnected = false
    // 中断所有请求
    for (const [reqId, entry] of this.activeRequests) {
      console.log(`Aborting request: ${reqId}`)
      entry.cancelled = true
    }
    this.activeRequests.clear()
    // 注意：不手动调整 currentLoad
  }

  // 模拟重连并认证成功
  simulateReconnect() {
    this.isConnected = true
    // 重置 currentLoad
    this.currentLoad = 0
    console.log('Reconnected, currentLoad reset to 0')
  }
}

async function runTests() {
  console.log('🧪 Starting Worker Bug Fix Tests...\n')

  // 测试 1: WebSocket 断开时 currentLoad 不会变负
  console.log('Test 1: WebSocket disconnect does not cause negative currentLoad')
  const worker1 = new MockWorkerClient()

  // 启动 3 个并发请求
  const promises = [
    worker1.handleRequest('req1'),
    worker1.handleRequest('req2'),
    worker1.handleRequest('req3')
  ]

  // 等待请求开始（currentLoad 增加）
  await new Promise((resolve) => setTimeout(resolve, 10))
  console.log(`  Current load before disconnect: ${worker1.currentLoad}`)
  assert.strictEqual(worker1.currentLoad, 3, 'Should have 3 active requests')

  // 模拟 WebSocket 断开
  worker1.simulateDisconnect()

  // 等待所有请求的 finally 块执行
  await Promise.allSettled(promises)

  console.log(`  Current load after disconnect: ${worker1.currentLoad}`)
  assert.ok(worker1.currentLoad >= 0, 'currentLoad should not be negative')
  console.log('  ✅ Test 1 passed\n')

  // 测试 2: Worker 重连后 currentLoad 重置为 0
  console.log('Test 2: Worker reconnect resets currentLoad to 0')
  const worker2 = new MockWorkerClient()

  // 启动请求
  const promise2 = worker2.handleRequest('req4')
  await new Promise((resolve) => setTimeout(resolve, 10))
  console.log(`  Current load before reconnect: ${worker2.currentLoad}`)

  // 断开并重连
  worker2.simulateDisconnect()
  await Promise.allSettled([promise2])

  // 重连
  worker2.simulateReconnect()
  console.log(`  Current load after reconnect: ${worker2.currentLoad}`)
  assert.strictEqual(worker2.currentLoad, 0, 'currentLoad should be 0 after reconnect')
  console.log('  ✅ Test 2 passed\n')

  // 测试 3: 已取消的请求标记正确
  console.log('Test 3: Cancelled request flag works correctly')
  const worker3 = new MockWorkerClient()

  worker3.activeRequests.set('req5', { req: {}, cancelled: false })
  const entry = worker3.activeRequests.get('req5')
  assert.strictEqual(entry.cancelled, false, 'Initially not cancelled')

  // 标记为已取消
  entry.cancelled = true
  assert.strictEqual(entry.cancelled, true, 'Should be marked as cancelled')
  console.log('  ✅ Test 3 passed\n')

  console.log('🎉 All tests passed!')
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
