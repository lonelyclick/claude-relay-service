/**
 * Factory.ai 403 敏感内容过滤测试
 *
 * 模拟 Claude Code + MCP 场景：tool_result 中包含 Factory.ai 敏感关键词
 * （fk- API key、api.factory.ai、FactoryAI 等），验证 CRS 兼容层能正确清理。
 *
 * 用法:
 *   CRS_API_KEY="cr_..." node docs/factory-ai-compat/test_403_sensitive_content.mjs
 */

const CRS_API_KEY = process.env.CRS_API_KEY
const CRS_BASE_URL = process.env.CRS_BASE_URL || 'https://token.yohomobile.dev/api'
const ENDPOINT = `${CRS_BASE_URL}/v1/messages`

if (!CRS_API_KEY) {
  console.error('错误: 请设置 CRS_API_KEY 环境变量')
  process.exit(1)
}

console.log(`API 端点: ${ENDPOINT}`)
console.log()

// ─── 工具函数 ───

async function sendRequest(body) {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'Authorization': `Bearer ${CRS_API_KEY}`,
    'user-agent': 'claude-cli/2.1.87 (external, sdk-ts)',
    'anthropic-beta':
      'claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07',
    'x-stainless-lang': 'js',
    'x-stainless-runtime': 'node',
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

const results = []

async function test(name, fn) {
  try {
    const { status, pass, detail } = await fn()
    results.push({ name, status, pass, detail })
    const icon = pass ? '✅' : '❌'
    console.log(`${icon} ${name} — HTTP ${status}${detail ? ` | ${detail}` : ''}`)
  } catch (err) {
    results.push({ name, status: 'ERR', pass: false, detail: err.message })
    console.log(`💥 ${name} — ${err.message}`)
  }
}

// ─── 敏感内容样本（模拟 MCP recall 返回的 memory 内容） ───

const SENSITIVE_TOOL_RESULT_TEXT = `## Factory.ai 兼容层排查经验

### 账户配置
- apiUrl: https://api.factory.ai/api/llm/a/v1/messages
- apiKey: fk-ykSjYnVjmoE0gDMGBvd3-IDVNylLCZTvELCuMTPdAsyjuEhie4Od3dba-mXDlDvQ
- Authorization: Bearer fk-ykSjYnVjmoE0gDMGBvd3-IDVNylLCZTvELCuMTPdAsyjuEhie4Od3dba-mXDlDvQ

### 代码路径
- _cleanHeadersForFactoryAi() 处理 auth headers
- factory-cli/0.89.0 User-Agent 伪装
- FactoryAI 检测 Claude Code 指纹文本

### 文件
- docs/factory-ai-compat/factory-ai.md
- Factory.ai 不支持 count_tokens 端点`

// ─── 测试用例 ───

// 1. 基线：简单请求（无敏感内容），应该 200
await test('基线: 简单请求无敏感内容', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200 }
})

// 2. tool_result 包含 fk- API key（最关键的 403 触发词）
await test('tool_result 包含 fk- API key', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    messages: [
      { role: 'user', content: 'recall factory ai experience' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_recall_001',
            name: 'mcp__yoho-memory__recall',
            input: { input: 'factory ai', keywords: ['factory', 'ai'] },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_recall_001',
            content: `Found memory:\napiKey: fk-ykSjYnVjmoE0gDMGBvd3-IDVNylLCZTvELCuMTPdAsyjuEhie4Od3dba-mXDlDvQ\nBearer fk-testkey12345678901234`,
          },
        ],
      },
      { role: 'user', content: 'summarize the above, say ok' },
    ],
  }
  const { status, data } = await sendRequest(body)
  return {
    status,
    pass: status === 200,
    detail: status !== 200 ? JSON.stringify(data).slice(0, 150) : undefined,
  }
})

// 3. tool_result 包含 api.factory.ai 域名
await test('tool_result 包含 api.factory.ai 域名', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    messages: [
      { role: 'user', content: 'what is the api url' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_recall_002',
            name: 'mcp__yoho-memory__recall',
            input: { input: 'api url' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_recall_002',
            content:
              'Account config:\napiUrl: https://api.factory.ai/api/llm/a/v1/messages\nUse factory-cli/0.89.0 as User-Agent',
          },
        ],
      },
      { role: 'user', content: 'say ok' },
    ],
  }
  const { status, data } = await sendRequest(body)
  return {
    status,
    pass: status === 200,
    detail: status !== 200 ? JSON.stringify(data).slice(0, 150) : undefined,
  }
})

// 4. tool_result 包含 FactoryAI / Factory.ai 关键词
await test('tool_result 包含 FactoryAI / Factory.ai 关键词', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    messages: [
      { role: 'user', content: 'check memory' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_recall_003',
            name: 'mcp__yoho-memory__recall',
            input: { input: 'factory' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_recall_003',
            content:
              'FactoryAI 检测 Claude Code 指纹。Factory.ai 不支持 count_tokens。_cleanHeadersForFactoryAi() 负责清理 headers。',
          },
        ],
      },
      { role: 'user', content: 'say ok' },
    ],
  }
  const { status, data } = await sendRequest(body)
  return {
    status,
    pass: status === 200,
    detail: status !== 200 ? JSON.stringify(data).slice(0, 150) : undefined,
  }
})

// 5. 完整模拟：tool_result 包含所有敏感词（最接近真实 403 场景）
await test('完整模拟: tool_result 包含所有 Factory.ai 敏感词', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    messages: [
      { role: 'user', content: 'recall all factory ai info' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_recall_full',
            name: 'mcp__yoho-memory__recall',
            input: { input: 'factory ai full', keywords: ['factory', 'ai'] },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_recall_full',
            content: SENSITIVE_TOOL_RESULT_TEXT,
          },
        ],
      },
      { role: 'user', content: 'thanks, say ok' },
    ],
  }
  const { status, data } = await sendRequest(body)
  return {
    status,
    pass: status === 200,
    detail: status !== 200 ? JSON.stringify(data).slice(0, 150) : undefined,
  }
})

// 6. content 数组形式的 tool_result（嵌套 text item）
await test('content 数组形式的 tool_result 包含 fk- key', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    messages: [
      { role: 'user', content: 'get credentials' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_cred_001',
            name: 'mcp__yoho-credentials__get_credential',
            input: { type: 'factory', name: 'default' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_cred_001',
            content: [
              {
                type: 'text',
                text: '{"apiKey": "fk-ykSjYnVjmoE0gDMGBvd3-IDVNylLCZTvELCuMTPdAsyjuEhie4Od3dba-mXDlDvQ", "apiUrl": "https://api.factory.ai/api/llm/a"}',
              },
            ],
          },
        ],
      },
      { role: 'user', content: 'say ok' },
    ],
  }
  const { status, data } = await sendRequest(body)
  return {
    status,
    pass: status === 200,
    detail: status !== 200 ? JSON.stringify(data).slice(0, 150) : undefined,
  }
})

// 7. stream 模式下 tool_result 包含敏感内容
await test('stream 模式: tool_result 包含 fk- key 和 api.factory.ai', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    stream: true,
    messages: [
      { role: 'user', content: 'recall factory config' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_stream_001',
            name: 'mcp__yoho-memory__recall',
            input: { input: 'factory config' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_stream_001',
            content: SENSITIVE_TOOL_RESULT_TEXT,
          },
        ],
      },
      { role: 'user', content: 'say ok' },
    ],
  }
  const { status, data } = await sendRequest(body)
  const hasContent = typeof data === 'string' ? data.includes('event:') : false
  return {
    status,
    pass: status === 200,
    detail: status !== 200 ? JSON.stringify(data).slice(0, 150) : undefined,
  }
})

// ─── 汇总 ───

console.log('\n' + '='.repeat(60))
console.log('汇总:')
const passed = results.filter((r) => r.pass).length
const failed = results.filter((r) => !r.pass).length
console.log(`  ✅ 通过: ${passed}`)
console.log(`  ❌ 失败: ${failed}`)
console.log(`  总计: ${results.length}`)

if (failed > 0) {
  console.log('\n失败项:')
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`  ❌ ${r.name} — HTTP ${r.status}${r.detail ? ` | ${r.detail}` : ''}`)
  }
}

process.exit(failed > 0 ? 1 : 0)
