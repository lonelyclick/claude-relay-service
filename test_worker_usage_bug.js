#!/usr/bin/env node

/**
 * Worker 流式请求 usage 统计失效问题验证
 *
 * Bug 描述：
 * Worker 是透明 TCP 代理，只转发 Anthropic 的原始 SSE 字节流，不解析内容。
 * 因此 Worker 发送的 stream_end 消息 data 为空对象 {}，导致 Hub 端无法获取 usage 信息。
 *
 * 模拟场景：
 * 1. Hub 通过 Worker 发送流式请求
 * 2. Worker 透传 SSE 数据，包含 usage 信息
 * 3. Worker 发送 stream_end 时 data = {}（没有解析 usage）
 * 4. Hub 端 usageCallback 永远不会触发
 * 5. Token 统计为 0，成本计算失效
 */

const assert = require('assert')

// 模拟 Anthropic API 的 SSE 流（包含 usage）
const MOCK_SSE_STREAM = `event: message_start
data: {"type":"message_start","message":{"id":"msg_123","model":"claude-3-5-sonnet-20241022","role":"assistant"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}

event: message_stop
data: {"type":"message_stop"}

`

console.log('🧪 测试 Worker 流式请求 usage 统计失效问题\n')

// Worker 端：透明转发 SSE 流，不解析
class MockWorker {
  processStreamRequest(requestId, sseData, sendToHub) {
    console.log('📡 Worker 收到流式请求')
    console.log('  - 透传 SSE 数据，不解析内容')

    // 模拟逐行发送
    const lines = sseData.trim().split('\n')
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6)
        sendToHub({ type: 'stream_data', id: requestId, data })
      }
    }

    // ❌ Bug: stream_end 时 data 为空，没有包含 usage
    console.log('  - 发送 stream_end，data = {}（缺少 usage！）')
    sendToHub({ type: 'stream_end', id: requestId, data: {} })
  }
}

// Hub 端：期望从 stream_end 获取 usage
class MockHub {
  constructor() {
    this.usageRecorded = false
    this.recordedUsage = null
  }

  handleStreamRequest(onStreamData, onStreamEnd) {
    const usageCallback = (usage) => {
      console.log('  ✅ usageCallback 触发，记录 usage:', usage)
      this.usageRecorded = true
      this.recordedUsage = usage
    }

    const callbacks = {
      onStreamData: (data) => {
        onStreamData(data)
      },
      onStreamEnd: (summary) => {
        console.log('  📥 收到 stream_end，summary:', summary)

        // ❌ Bug: summary.usage 永远是 undefined
        if (usageCallback && summary?.usage) {
          usageCallback(summary.usage)
        } else {
          console.log('  ❌ summary.usage 不存在，usageCallback 不会触发')
        }

        onStreamEnd(summary)
      }
    }

    return callbacks
  }
}

async function runTest() {
  const worker = new MockWorker()
  const hub = new MockHub()

  let receivedDataCount = 0
  let streamEnded = false

  console.log('步骤 1: Hub 通过 Worker 发送流式请求\n')

  const callbacks = hub.handleStreamRequest(
    (data) => {
      receivedDataCount++
      // 模拟解析 SSE 数据
      try {
        const parsed = JSON.parse(data)
        if (parsed.type === 'message_delta' && parsed.usage) {
          console.log(`  📊 SSE 数据中包含 usage: ${JSON.stringify(parsed.usage)}`)
        }
      } catch (e) {
        // 不是所有行都是 JSON
      }
    },
    (summary) => {
      streamEnded = true
    }
  )

  console.log('步骤 2: Worker 透传 SSE 流\n')

  // Worker 处理请求
  worker.processStreamRequest('req-001', MOCK_SSE_STREAM, (msg) => {
    if (msg.type === 'stream_data') {
      callbacks.onStreamData(msg.data)
    } else if (msg.type === 'stream_end') {
      callbacks.onStreamEnd(msg.data)
    }
  })

  console.log('\n步骤 3: 检查结果\n')

  console.log('📊 测试结果：')
  console.log(`  - 收到 SSE 数据块数: ${receivedDataCount}`)
  console.log(`  - 流是否结束: ${streamEnded}`)
  console.log(`  - usage 是否被记录: ${hub.usageRecorded}`)
  console.log(`  - 记录的 usage: ${JSON.stringify(hub.recordedUsage)}`)

  if (!hub.usageRecorded) {
    console.log('\n❌ Bug 确认：流式请求 usage 统计完全失效')
    console.log('   根本原因：')
    console.log('   - Worker 只是透明 TCP 代理，不解析 SSE 内容')
    console.log('   - stream_end 消息的 data 为空对象 {}')
    console.log('   - Hub 端无法从 summary.usage 获取 token 统计')
    console.log('\n   影响：')
    console.log('   - 所有经过 Worker 的流式请求 token 数为 0')
    console.log('   - 成本计算不准确，账单数据失真')
    console.log('   - 用量监控和限流功能失效')
    console.log('\n   修复方案：')
    console.log('   1. Worker 端解析 SSE 流，提取 usage（增加复杂度）')
    console.log('   2. Hub 端自己解析流数据，提取 usage（推荐）')
    console.log('   3. 在 stream_data 中传递每个事件，Hub 端缓存并解析')
  } else {
    console.log('\n✅ 测试通过：usage 统计正常工作')
  }
}

runTest().catch((err) => {
  console.error('❌ 测试失败:', err)
  process.exit(1)
})
