/**
 * Factory.ai API 能力探测测试
 *
 * 逐项测试 Factory.ai 对 Anthropic API 各字段的支持情况。
 * 每个测试独立运行，结果汇总输出。
 *
 * 用法:
 *   export FACTORY_AI_API_KEY="fk-..."
 *   export FACTORY_AI_BASE_URL="https://api.factory.ai/api/llm/a"  # 可选
 *   node docs/factory-ai-compat/test_api_capabilities.mjs
 */

const API_KEY = process.env.FACTORY_AI_API_KEY
const BASE_URL = process.env.FACTORY_AI_BASE_URL || 'https://api.factory.ai/api/llm/a'
const ENDPOINT = `${BASE_URL}/v1/messages`

if (!API_KEY) {
  console.error('错误: 请设置 FACTORY_AI_API_KEY 环境变量')
  process.exit(1)
}

// ─── 工具函数 ───

async function sendRequest(body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'factory-cli/0.89.0',
    'x-client-version': '0.89.0',
    'Authorization': `Bearer ${API_KEY}`,
    ...extraHeaders,
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

function simpleBody(overrides = {}) {
  return {
    model: 'claude-opus-4-6',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'say ok' }],
    ...overrides,
  }
}

const results = []

async function test(name, fn) {
  try {
    const { status, pass, detail } = await fn()
    results.push({ name, status, pass, detail })
    const icon = pass ? '✅' : '❌'
    console.log(`${icon} ${name} — HTTP ${status}${detail ? ` (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, status: 'ERR', pass: false, detail: err.message })
    console.log(`💥 ${name} — ${err.message}`)
  }
}

// ─── 测试用例 ───

// 基础连通性
await test('基础请求 (最小 body)', async () => {
  const { status } = await sendRequest(simpleBody())
  return { status, pass: status === 200 }
})

// 模型支持
for (const model of [
  'claude-opus-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
]) {
  await test(`模型: ${model}`, async () => {
    const { status } = await sendRequest(simpleBody({ model }))
    return { status, pass: status === 200 }
  })
}

// 模型日期后缀（预期失败：Factory.ai 4.6 系列不接受日期后缀）
await test('模型: claude-opus-4-6-20260320 (带日期后缀, 预期 400)', async () => {
  const { status } = await sendRequest(simpleBody({ model: 'claude-opus-4-6-20260320' }))
  return { status, pass: status === 400, detail: 'Factory.ai 4.6 系列不支持日期后缀，CRS 会自动去除' }
})

// system 字段（预期失败：Factory.ai 返回 403，CRS 会转为 messages）
await test('system 字段 (预期 403)', async () => {
  const { status } = await sendRequest(simpleBody({
    system: 'You are a helpful assistant.',
  }))
  return { status, pass: status === 403, detail: 'Factory.ai 不支持 system 字段，CRS 会自动转为 messages' }
})

// system 字段 (数组格式)
await test('system 字段 数组格式 (预期 403)', async () => {
  const { status } = await sendRequest(simpleBody({
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
  }))
  return { status, pass: status === 403, detail: 'Factory.ai 不支持 system 字段，CRS 会自动转为 messages' }
})

// metadata（实测支持，但 CRS 仍删除以防泄露用户信息）
await test('metadata 字段 (实际支持)', async () => {
  const { status } = await sendRequest(simpleBody({
    metadata: { user_id: 'test_user_123' },
  }))
  return { status, pass: status === 200, detail: 'Factory.ai 支持 metadata，但 CRS 删除以防泄露信息' }
})

// context_management（预期失败：Factory.ai 不认识该字段，CRS 会删除）
await test('context_management 字段 (预期 400)', async () => {
  const { status } = await sendRequest(simpleBody({
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  }))
  return { status, pass: status === 400, detail: 'Factory.ai 不支持 context_management，CRS 会自动删除' }
})

// output_config
await test('output_config 字段', async () => {
  const { status } = await sendRequest(simpleBody({
    output_config: { effort: 'high' },
  }))
  return { status, pass: status === 200 }
})

// cache_control
await test('cache_control (ephemeral)', async () => {
  const { status, data } = await sendRequest(simpleBody({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'This is a long prompt.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'say ok' },
      ],
    }],
  }))
  const hasCache = data?.usage?.cache_creation_input_tokens !== undefined
  return { status, pass: status === 200, detail: hasCache ? 'cache fields present in usage' : 'no cache fields' }
})

// thinking: enabled
await test('thinking: enabled (budget_tokens: 2048)', async () => {
  const { status, data } = await sendRequest(simpleBody({
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 2048 },
  }))
  const hasThinking = data?.content?.some(b => b.type === 'thinking')
  return { status, pass: status === 200, detail: hasThinking ? 'thinking block present' : 'no thinking block' }
})

// thinking: adaptive
await test('thinking: adaptive', async () => {
  const { status, data } = await sendRequest(simpleBody({
    thinking: { type: 'adaptive' },
  }))
  return { status, pass: status === 200 }
})

// thinking: budget_tokens < 1024
await test('thinking: budget_tokens=512 (< 1024)', async () => {
  const { status, data } = await sendRequest(simpleBody({
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 512 },
  }))
  return { status, pass: status !== 200, detail: `期望 400, 实际 ${status}: ${JSON.stringify(data).slice(0, 100)}` }
})

// max_tokens <= budget_tokens
await test('max_tokens=2048 <= budget_tokens=4096', async () => {
  const { status, data } = await sendRequest(simpleBody({
    max_tokens: 2048,
    thinking: { type: 'enabled', budget_tokens: 4096 },
  }))
  return { status, pass: status !== 200, detail: `期望 400, 实际 ${status}: ${JSON.stringify(data).slice(0, 100)}` }
})

// temperature
await test('temperature: 1', async () => {
  const { status } = await sendRequest(simpleBody({ temperature: 1 }))
  return { status, pass: status === 200 }
})

// tools (标准格式)
await test('tools (标准 name/description/input_schema)', async () => {
  const { status } = await sendRequest(simpleBody({
    tools: [{
      name: 'get_weather',
      description: 'Get the weather for a city',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }],
  }))
  return { status, pass: status === 200 }
})

// 多 tools
await test('tools: 50 个工具', async () => {
  const tools = Array.from({ length: 50 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool number ${i}`,
    input_schema: { type: 'object', properties: { x: { type: 'string' } } },
  }))
  const { status } = await sendRequest(simpleBody({ tools }))
  return { status, pass: status === 200 }
})

// stream
await test('stream: true', async () => {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'factory-cli/0.89.0',
    'x-client-version': '0.89.0',
    'Authorization': `Bearer ${API_KEY}`,
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(simpleBody({ stream: true })),
  })
  const text = await res.text()
  const hasSSE = text.includes('event:')
  return { status: res.status, pass: res.status === 200 && hasSSE, detail: hasSSE ? 'SSE events present' : 'no SSE events' }
})

// ─── Beta headers ───

await test('anthropic-beta: interleaved-thinking-2025-05-14', async () => {
  const { status, data } = await sendRequest(simpleBody(), {
    'anthropic-beta': 'interleaved-thinking-2025-05-14',
  })
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

await test('anthropic-beta: claude-code-20250219', async () => {
  const { status, data } = await sendRequest(simpleBody(), {
    'anthropic-beta': 'claude-code-20250219',
  })
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

await test('anthropic-beta: 多个特性组合', async () => {
  const { status, data } = await sendRequest(simpleBody(), {
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07',
  })
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

// ─── 额外 headers ───

await test('x-stainless-* headers', async () => {
  const { status, data } = await sendRequest(simpleBody(), {
    'x-stainless-lang': 'js',
    'x-stainless-runtime': 'node',
    'x-stainless-arch': 'x64',
  })
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

// ─── 汇总 ───

console.log('\n' + '='.repeat(60))
console.log('汇总:')
const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass).length
console.log(`  ✅ 通过: ${passed}`)
console.log(`  ❌ 失败: ${failed}`)
console.log(`  总计: ${results.length}`)

if (failed > 0) {
  console.log('\n失败项:')
  for (const r of results.filter(r => !r.pass)) {
    console.log(`  ❌ ${r.name} — HTTP ${r.status}${r.detail ? ` (${r.detail})` : ''}`)
  }
}
