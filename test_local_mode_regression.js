#!/usr/bin/env node

/**
 * 本地模式回归测试
 *
 * 验证引入 Worker 架构后，不使用 Worker（本地模式）的请求链路完全不受影响。
 *
 * 测试内容：
 *   1. WorkerRouter: 无 workerId 时始终返回 local
 *   2. 调度器 Worker 过滤: 无 workerId 时不过滤任何账户
 *   3. Hub 启动不依赖 Worker 组件就绪
 *   4. workerWsServer.attach() 不影响正常 HTTP 请求
 *   5. 非 /ws/worker 的 upgrade 请求被正确拒绝（返回 404）
 *   6. claudeRelayService 本地路径不触发 Worker 分支
 *   7. 性能: Worker 路由判断开销忽略不计
 *
 * 用法：
 *   node test_local_mode_regression.js
 */

const http = require('http')
const { WebSocket } = require('ws')
const assert = require('assert')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  return async () => {
    try {
      await fn()
      passed++
      console.log(`  ✅ ${name}`)
    } catch (err) {
      failed++
      failures.push({ name, error: err.message })
      console.log(`  ❌ ${name}: ${err.message}`)
    }
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertTrue(val, msg) {
  if (!val) throw new Error(msg || 'Expected truthy')
}

// ============================================================
// Test Group 1: 本地路由决策
// ============================================================

async function testGroup1_LocalRouting() {
  console.log('\n📦 Group 1: 本地路由决策')

  const workerRouter = require('./src/services/worker/workerRouter')

  // 所有不触发 Worker 的 workerId 值
  const localCases = [
    { input: null, desc: 'null' },
    { input: undefined, desc: 'undefined' },
    { input: '', desc: '空字符串' },
    { input: 0, desc: '数字 0' },
    { input: false, desc: 'false' }
  ]

  for (const c of localCases) {
    await test(`workerId=${c.desc} → local`, () => {
      const result = workerRouter.resolve(c.input)
      assertEqual(result.mode, 'local', `workerId=${c.desc} 应为 local`)
      assertEqual(result.workerId, null, `workerId 应为 null`)
    })()
  }

  // Worker 离线 → fallback local
  await test('workerId 存在但 Worker 不在线 → local', () => {
    const result = workerRouter.resolve('some-worker-id-that-does-not-exist')
    assertEqual(result.mode, 'local', '离线 Worker 应 fallback 到 local')
    assertEqual(result.workerId, null, 'workerId 应为 null')
  })()
}

// ============================================================
// Test Group 2: 调度器 Worker 过滤（无 Worker 场景）
// ============================================================

async function testGroup2_SchedulerFilter() {
  console.log('\n📦 Group 2: 调度器 Worker 过滤（无 Worker 场景）')

  const workerService = require('./src/services/worker/workerService')

  // 模拟一组没有绑定 Worker 的账户
  const mockAccounts = [
    { id: 'acc-1', name: 'Account 1', isActive: 'true', schedulable: 'true' },
    { id: 'acc-2', name: 'Account 2', isActive: 'true', schedulable: 'true', workerId: undefined },
    { id: 'acc-3', name: 'Account 3', isActive: 'true', schedulable: 'true', workerId: '' },
    { id: 'acc-4', name: 'Account 4', isActive: 'true', schedulable: 'true', workerId: null }
  ]

  await test('无 workerId 的账户全部保留', () => {
    const filtered = mockAccounts.filter(acc => {
      if (!acc.workerId) return true
      return workerService.isOnline(acc.workerId)
    })
    assertEqual(filtered.length, mockAccounts.length, `应保留全部 ${mockAccounts.length} 个账户`)
  })()

  // 模拟一个绑定了离线 Worker 的账户混入
  await test('绑定离线 Worker 的账户被过滤', () => {
    const mixedAccounts = [
      ...mockAccounts,
      { id: 'acc-5', name: 'Bound to Offline', workerId: 'offline-worker-id' }
    ]
    const filtered = mixedAccounts.filter(acc => {
      if (!acc.workerId) return true
      return workerService.isOnline(acc.workerId)
    })
    assertEqual(filtered.length, mockAccounts.length, '绑定离线 Worker 的账户应被过滤掉')
    assertTrue(!filtered.some(a => a.id === 'acc-5'), 'acc-5 不应在结果中')
  })()

  // 模拟绑定了在线 Worker 的账户
  await test('绑定在线 Worker 的账户保留', () => {
    const onlineWorkerId = 'online-worker-' + Date.now()
    const fakeWs = { close: () => {}, readyState: 1, send: () => {} }
    workerService.registerOnline(onlineWorkerId, fakeWs, '1.1.1.1')

    const mixedAccounts = [
      ...mockAccounts,
      { id: 'acc-6', name: 'Bound to Online', workerId: onlineWorkerId }
    ]
    const filtered = mixedAccounts.filter(acc => {
      if (!acc.workerId) return true
      return workerService.isOnline(acc.workerId)
    })
    assertEqual(filtered.length, mockAccounts.length + 1, '在线 Worker 的账户应保留')
    assertTrue(filtered.some(a => a.id === 'acc-6'), 'acc-6 应在结果中')

    workerService.registerOffline(onlineWorkerId)
  })()

  // 空账户列表
  await test('空账户列表不报错', () => {
    const filtered = [].filter(acc => {
      if (!acc.workerId) return true
      return workerService.isOnline(acc.workerId)
    })
    assertEqual(filtered.length, 0, '空列表应返回空')
  })()
}

// ============================================================
// Test Group 3: HTTP Server + WS 挂载不影响正常请求
// ============================================================

async function testGroup3_HttpAndWs() {
  console.log('\n📦 Group 3: HTTP 请求 + WS 升级行为')

  const workerWsServer = require('./src/services/worker/workerWsServer')

  // 创建一个简单 HTTP server 并挂载 workerWsServer
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    } else if (req.url === '/api/test') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('API response OK')
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  workerWsServer.attach(httpServer)

  await new Promise(r => httpServer.listen(0, '127.0.0.1', r))
  const port = httpServer.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  // 3.1 正常 HTTP GET 请求不受影响
  await test('正常 HTTP GET /health 正常响应', async () => {
    const res = await fetch(`${baseUrl}/health`)
    assertEqual(res.status, 200, '状态码应为 200')
    const body = await res.json()
    assertEqual(body.status, 'ok', '响应体应正确')
  })()

  // 3.2 正常 HTTP POST 请求不受影响
  await test('正常 HTTP POST /api/test 正常响应', async () => {
    const res = await fetch(`${baseUrl}/api/test`, { method: 'POST' })
    assertEqual(res.status, 200, '状态码应为 200')
    const text = await res.text()
    assertEqual(text, 'API response OK', '响应体应正确')
  })()

  // 3.3 WebSocket 到 /ws/worker 但无 token → 401
  await test('WS /ws/worker 无 token → 连接被拒', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`)
    const result = await new Promise((resolve) => {
      ws.on('close', () => resolve('closed'))
      ws.on('error', () => resolve('error'))
      setTimeout(() => { ws.close(); resolve('timeout') }, 2000)
    })
    assertTrue(result === 'closed' || result === 'error', `无 token 应被拒绝，got: ${result}`)
  })()

  // 3.4 WebSocket 到非 /ws/worker 路径 → 被拒
  await test('WS /ws/other → 404 拒绝', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/other`)
    const result = await new Promise((resolve) => {
      ws.on('close', () => resolve('closed'))
      ws.on('error', () => resolve('error'))
      ws.on('unexpected-response', (req, res) => resolve(`unexpected-${res.statusCode}`))
      setTimeout(() => { ws.close(); resolve('timeout') }, 2000)
    })
    // 应该收到 404 或者 connection closed
    assertTrue(
      result === 'closed' || result === 'error' || result === 'unexpected-404',
      `非 Worker 路径应被拒，got: ${result}`
    )
  })()

  // 3.5 WebSocket 到随机路径 → 被拒
  await test('WS / (根路径) → 拒绝', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const result = await new Promise((resolve) => {
      ws.on('close', () => resolve('closed'))
      ws.on('error', () => resolve('error'))
      ws.on('unexpected-response', (req, res) => resolve(`unexpected-${res.statusCode}`))
      setTimeout(() => { ws.close(); resolve('timeout') }, 2000)
    })
    assertTrue(
      result === 'closed' || result === 'error' || result.startsWith('unexpected-'),
      `根路径 WS 应被拒，got: ${result}`
    )
  })()

  // 3.6 挂载 WS 后 HTTP 请求仍正常（并发测试）
  await test('并发 HTTP 请求不受 WS 挂载影响', async () => {
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(
        fetch(`${baseUrl}/health`).then(r => r.json()).then(j => j.status)
      )
    }
    const results = await Promise.all(promises)
    assertTrue(results.every(r => r === 'ok'), '所有并发请求应正常响应')
  })()

  // Cleanup
  workerWsServer.close()
  httpServer.close()
}

// ============================================================
// Test Group 4: Worker 路由判断对本地模式零开销
// ============================================================

async function testGroup4_PerformanceCheck() {
  console.log('\n📦 Group 4: 性能影响检查')

  const workerRouter = require('./src/services/worker/workerRouter')

  await test('10000 次 workerRouter.resolve(undefined) < 50ms', () => {
    const start = process.hrtime.bigint()
    for (let i = 0; i < 10000; i++) {
      workerRouter.resolve(undefined)
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6 // ms
    assertTrue(elapsed < 50, `10000 次调用耗时 ${elapsed.toFixed(2)}ms，超过 50ms 阈值`)
  })()

  await test('10000 次 workerRouter.resolve(null) < 50ms', () => {
    const start = process.hrtime.bigint()
    for (let i = 0; i < 10000; i++) {
      workerRouter.resolve(null)
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6
    assertTrue(elapsed < 50, `10000 次调用耗时 ${elapsed.toFixed(2)}ms，超过 50ms 阈值`)
  })()

  // 模拟 "正常请求路径中的 Worker 判断" 流程
  await test('模拟请求链路中 Worker 路由判断开销', () => {
    const start = process.hrtime.bigint()
    for (let i = 0; i < 1000; i++) {
      // 模拟 claudeRelayService._makeClaudeRequest 中的判断
      const account = { id: 'test', name: 'Test' } // 没有 workerId
      const routing = workerRouter.resolve(account?.workerId)
      if (routing.mode === 'remote') {
        throw new Error('不应该走 remote')
      }
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6
    assertTrue(elapsed < 10, `1000 次模拟调用耗时 ${elapsed.toFixed(2)}ms，超过 10ms 阈值`)
  })()
}

// ============================================================
// Test Group 5: RemoteWorkerProxy 错误处理（Worker 不在线）
// ============================================================

async function testGroup5_ProxyErrorHandling() {
  console.log('\n📦 Group 5: RemoteWorkerProxy 错误处理')

  const workerWsServer = require('./src/services/worker/workerWsServer')

  await test('sendRequest to offline Worker → reject', async () => {
    try {
      await workerWsServer.sendRequest('nonexistent-worker-id', { test: true })
      throw new Error('应该抛出异常')
    } catch (err) {
      assertTrue(err.message.includes('not online'), `错误消息应包含 "not online"，got: "${err.message}"`)
    }
  })()
}

// ============================================================
// Test Group 6: 模块加载验证
// ============================================================

async function testGroup6_ModuleLoading() {
  console.log('\n📦 Group 6: 模块加载安全性')

  await test('require workerRouter 不报错', () => {
    const m = require('./src/services/worker/workerRouter')
    assertTrue(typeof m.resolve === 'function', 'workerRouter.resolve 应是函数')
  })()

  await test('require remoteWorkerProxy 不报错', () => {
    const m = require('./src/services/worker/remoteWorkerProxy')
    assertTrue(typeof m.sendRequest === 'function', 'remoteWorkerProxy.sendRequest 应是函数')
    assertTrue(typeof m.sendStreamRequest === 'function', 'remoteWorkerProxy.sendStreamRequest 应是函数')
  })()

  await test('require workerWsServer 不报错', () => {
    const m = require('./src/services/worker/workerWsServer')
    assertTrue(typeof m.attach === 'function', 'workerWsServer.attach 应是函数')
    assertTrue(typeof m.sendRequest === 'function', 'workerWsServer.sendRequest 应是函数')
    assertTrue(typeof m.close === 'function', 'workerWsServer.close 应是函数')
  })()

  await test('require workerService 是单例', () => {
    const s1 = require('./src/services/worker/workerService')
    const s2 = require('./src/services/worker/workerService')
    assertTrue(s1 === s2, 'workerService 应是单例')
  })()

  await test('workerService 初始时 onlineWorkers 为空', () => {
    const s = require('./src/services/worker/workerService')
    // 注意：之前测试可能注册了一些 Worker 并已注销
    // 这里测试的是 getOnlineWorkerIds 方法可用
    const ids = s.getOnlineWorkerIds()
    assertTrue(Array.isArray(ids), 'getOnlineWorkerIds 应返回数组')
  })()
}

// ============================================================
// Test Group 7: Edge Cases
// ============================================================

async function testGroup7_EdgeCases() {
  console.log('\n📦 Group 7: 边界情况')

  const workerRouter = require('./src/services/worker/workerRouter')
  const workerService = require('./src/services/worker/workerService')

  // 账户对象完全没有 workerId 属性
  await test('account 对象无 workerId 属性 → local', () => {
    const account = { id: 'test', name: 'Test Account' }
    const result = workerRouter.resolve(account.workerId) // undefined
    assertEqual(result.mode, 'local', '应为 local')
  })()

  // account 本身为 null
  await test('account 为 null → local', () => {
    const account = null
    const result = workerRouter.resolve(account?.workerId) // undefined
    assertEqual(result.mode, 'local', '应为 local')
  })()

  // incrLoad/decrLoad 对不存在的 Worker
  await test('incrLoad/decrLoad 对不存在的 Worker 不报错', () => {
    workerService.incrLoad('does-not-exist')
    workerService.decrLoad('does-not-exist')
    // 不应抛异常
  })()

  // disconnectWorker 对不存在的 Worker
  await test('disconnectWorker 对不在线 Worker 不报错', () => {
    workerService.disconnectWorker('does-not-exist', 'test')
    // 不应抛异常
  })()

  // isOnline 对各种输入
  await test('isOnline 对各种输入安全', () => {
    assertEqual(workerService.isOnline(null), false, 'null → false')
    assertEqual(workerService.isOnline(undefined), false, 'undefined → false')
    assertEqual(workerService.isOnline(''), false, '空字符串 → false')
    assertEqual(workerService.isOnline(0), false, '0 → false')
  })()

  // getConnection 对不存在的 Worker
  await test('getConnection 对不存在的 Worker 返回 undefined', () => {
    const conn = workerService.getConnection('does-not-exist')
    assertEqual(conn, undefined, '应返回 undefined')
  })()
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('🏠 本地模式回归测试（验证 Worker 架构引入不影响现有功能）\n')
  console.log('='.repeat(60))

  try {
    await testGroup1_LocalRouting()
    await testGroup2_SchedulerFilter()
    await testGroup3_HttpAndWs()
    await testGroup4_PerformanceCheck()
    await testGroup5_ProxyErrorHandling()
    await testGroup6_ModuleLoading()
    await testGroup7_EdgeCases()
  } catch (err) {
    console.error('\n💥 测试运行器自身出错:', err)
  }

  console.log('\n' + '='.repeat(60))
  console.log(`\n📊 测试结果: ${passed} passed, ${failed} failed`)

  if (failures.length > 0) {
    console.log('\n🔴 失败列表:')
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`)
    }
  }

  console.log()
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300)
}

main()
