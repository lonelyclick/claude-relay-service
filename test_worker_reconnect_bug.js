#!/usr/bin/env node

/**
 * Worker 重连时 pending 请求泄漏问题验证
 *
 * Bug 描述：
 * 当 Worker 重连时，registerOnline 会关闭旧 WebSocket 并立即覆盖 onlineWorkers Map。
 * 旧连接的 pendingRequests 会因为覆盖而丢失，导致这些请求的 Promise 永远 pending。
 *
 * 模拟场景：
 * 1. Worker A 连接到 Hub，currentLoad = 0
 * 2. Hub 发送 3 个请求给 Worker A，currentLoad = 3
 * 3. Worker A 网络抖动，重新连接（或重启）
 * 4. registerOnline 覆盖 Map entry，旧的 3 个 pending 请求丢失
 * 5. close 事件触发时，拿到的是新 entry，pendingRequests 为空
 * 6. 3 个请求的 Promise 永远不会 resolve/reject
 * 7. currentLoad 不会减，保持为 3
 */

const assert = require('assert')

class MockWorkerService {
  constructor() {
    this.onlineWorkers = new Map()
  }

  // 原始的 registerOnline 实现（有 bug）
  registerOnline(workerId, ws, ip) {
    // 如果已有连接，先关闭旧的
    const existing = this.onlineWorkers.get(workerId)
    if (existing && existing.ws !== ws) {
      console.log(`  ⚠️  关闭旧连接，当前有 ${existing.pendingRequests.size} 个 pending 请求`)

      // 模拟异步 close 事件
      setTimeout(() => {
        console.log(`  📡 旧连接 close 事件触发`)
        this.registerOffline(workerId)
      }, 10)

      // ❌ Bug: 立即覆盖 Map entry，丢失旧 pendingRequests
      // 正确做法应该是先处理完 pendingRequests 再覆盖
    }

    this.onlineWorkers.set(workerId, {
      ws,
      ip,
      currentLoad: 0,
      connectedAt: new Date().toISOString(),
      pendingRequests: new Map()
    })

    console.log(`  🟢 Worker online: ${workerId} (${ip})`)
  }

  registerOffline(workerId) {
    const online = this.onlineWorkers.get(workerId)
    if (online) {
      console.log(`  🔴 registerOffline called, pendingRequests: ${online.pendingRequests.size}`)

      // 清理所有 pending requests
      for (const [reqId, pending] of online.pendingRequests) {
        console.log(`    ❌ Rejecting pending request: ${reqId}`)
        clearTimeout(pending.timeout)
        try {
          pending.reject(new Error('Worker disconnected'))
        } catch (err) {
          console.log(`      ⚠️  Reject failed: ${err.message}`)
        }
      }
      online.pendingRequests.clear()
      this.onlineWorkers.delete(workerId)
    } else {
      console.log(`  ⚠️  registerOffline called but worker not found: ${workerId}`)
    }
  }

  // 模拟发送请求
  sendRequest(workerId, requestId) {
    const conn = this.onlineWorkers.get(workerId)
    if (!conn) {
      throw new Error(`Worker ${workerId} not online`)
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingRequests.delete(requestId)
        reject(new Error(`Request timeout: ${requestId}`))
      }, 60000)

      conn.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout: timer
      })

      conn.currentLoad++
      console.log(`  📤 Request sent: ${requestId}, currentLoad: ${conn.currentLoad}`)
    })
  }

  getCurrentLoad(workerId) {
    const conn = this.onlineWorkers.get(workerId)
    return conn ? conn.currentLoad : 0
  }

  getPendingCount(workerId) {
    const conn = this.onlineWorkers.get(workerId)
    return conn ? conn.pendingRequests.size : 0
  }
}

async function runTest() {
  console.log('🧪 测试 Worker 重连时 pending 请求泄漏问题\n')

  const service = new MockWorkerService()
  const workerId = 'worker-test-001'
  const ws1 = { id: 'ws1' }
  const ws2 = { id: 'ws2' }

  console.log('步骤 1: Worker 首次连接')
  service.registerOnline(workerId, ws1, '192.168.1.100')
  assert.strictEqual(service.getCurrentLoad(workerId), 0, 'Initial load should be 0')

  console.log('\n步骤 2: 发送 3 个请求')
  const req1 = service.sendRequest(workerId, 'req1')
  const req2 = service.sendRequest(workerId, 'req2')
  const req3 = service.sendRequest(workerId, 'req3')

  assert.strictEqual(service.getCurrentLoad(workerId), 3, 'Load should be 3')
  assert.strictEqual(service.getPendingCount(workerId), 3, 'Should have 3 pending')

  console.log('\n步骤 3: Worker 重连（模拟网络抖动或重启）')
  service.registerOnline(workerId, ws2, '192.168.1.100')

  // 立即检查：新连接的 pendingRequests 应该是空的
  assert.strictEqual(service.getPendingCount(workerId), 0, '❌ Bug: 新连接 pendingRequests 为空，旧请求丢失！')

  // currentLoad 也被重置为 0（这是正确的，但旧请求的负载计数丢失了）
  assert.strictEqual(service.getCurrentLoad(workerId), 0, 'currentLoad reset to 0')

  console.log('\n步骤 4: 等待旧连接 close 事件触发')
  await new Promise(resolve => setTimeout(resolve, 50))

  console.log('\n步骤 5: 检查 Promise 状态')
  const results = await Promise.allSettled([req1, req2, req3])

  let pendingCount = 0
  let rejectedCount = 0

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'pending') {
      pendingCount++
      console.log(`  ❌ 请求 ${i + 1} 仍然 pending（Promise 泄漏）`)
    } else if (result.status === 'rejected') {
      rejectedCount++
      console.log(`  ✅ 请求 ${i + 1} 被正确 reject: ${result.reason.message}`)
    }
  }

  console.log('\n📊 测试结果：')
  console.log(`  - Pending 请求数: ${pendingCount}`)
  console.log(`  - Rejected 请求数: ${rejectedCount}`)

  if (pendingCount > 0) {
    console.log('\n❌ Bug 确认：Worker 重连导致 pending 请求泄漏')
    console.log('   影响：')
    console.log('   - Promise 永远不会 resolve/reject，调用方 hang 住')
    console.log('   - Timeout timer 未清理，内存泄漏')
    console.log('   - 并发计数不准确')
  } else {
    console.log('\n✅ 测试通过：所有请求都被正确处理')
  }
}

runTest().catch((err) => {
  console.error('❌ 测试失败:', err)
  process.exit(1)
})
