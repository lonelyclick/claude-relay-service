/**
 * Claude Code 兼容性端到端测试
 *
 * 模拟 Claude Code 2.1.33 和 2.1.87 两个版本的真实请求格式，
 * 通过 CRS 代理发送到 Factory.ai，验证兼容层是否正常工作。
 *
 * 用法:
 *   export CRS_API_KEY="cr_..."          # CRS 绑定 Factory.ai 账户的 API Key
 *   export CRS_BASE_URL="https://token.yohomobile.dev/api"  # 可选
 *   node docs/factory-ai-compat/test_claude_code_compat.mjs
 *
 * 也可直接测试 Factory.ai（跳过 CRS）:
 *   export FACTORY_AI_API_KEY="fk-..."
 *   export FACTORY_AI_BASE_URL="https://api.factory.ai/api/llm/a"
 *   export TEST_DIRECT=1
 *   node docs/factory-ai-compat/test_claude_code_compat.mjs
 */

const CRS_API_KEY = process.env.CRS_API_KEY
const CRS_BASE_URL = process.env.CRS_BASE_URL || 'https://token.yohomobile.dev/api'
const FACTORY_API_KEY = process.env.FACTORY_AI_API_KEY
const FACTORY_BASE_URL = process.env.FACTORY_AI_BASE_URL || 'https://api.factory.ai/api/llm/a'
const TEST_DIRECT = process.env.TEST_DIRECT === '1'

const API_KEY = TEST_DIRECT ? FACTORY_API_KEY : CRS_API_KEY
const BASE_URL = TEST_DIRECT ? FACTORY_BASE_URL : CRS_BASE_URL
const ENDPOINT = `${BASE_URL}/v1/messages`

if (!API_KEY) {
  console.error(`错误: 请设置 ${TEST_DIRECT ? 'FACTORY_AI_API_KEY' : 'CRS_API_KEY'} 环境变量`)
  process.exit(1)
}

console.log(`测试模式: ${TEST_DIRECT ? '直连 Factory.ai' : '通过 CRS 代理'}`)
console.log(`API 端点: ${ENDPOINT}`)
console.log()

// ─── Claude Code 模拟 tools ───

const CLAUDE_CODE_TOOLS_SAMPLE = [
  {
    name: 'Bash',
    description: 'Execute a bash command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to read' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Perform exact string replacement in a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
]

// ─── Claude Code 模拟 system prompt（精简版） ───

const SYSTEM_PROMPT_V233 = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.
You are an interactive agent that helps users with software engineering tasks.

# System
- All text you output outside of tool use is displayed to the user.
- Tools are executed in a user-selected permission mode.

# Environment
- Platform: linux
- The current date is: 2026-03-30
- You are powered by Claude Opus 4.6.

Contents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):

# Dev Guidelines
- Use Chinese for communication
- Always verify before executing`

// ─── 工具函数 ───

async function sendRequest(body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'Authorization': `Bearer ${API_KEY}`,
    ...extraHeaders,
  }

  // 非直连时加上 Claude Code 的典型 headers
  if (!TEST_DIRECT) {
    headers['user-agent'] = 'claude-cli/2.1.87 (external, sdk-ts)'
    headers['anthropic-beta'] = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07'
    headers['x-stainless-lang'] = 'js'
    headers['x-stainless-runtime'] = 'node'
  } else {
    headers['User-Agent'] = 'factory-cli/0.89.0'
    headers['x-client-version'] = '0.89.0'
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

// ─── 测试用例 ───

// 1. Claude Code 2.1.33 风格请求
await test('Claude Code 2.1.33 风格 (stream, 5 tools, system as msg[0])', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 32000,
    temperature: 1,
    stream: true,
    messages: [
      { role: 'user', content: SYSTEM_PROMPT_V233 },
      { role: 'assistant', content: 'I understand the instructions.' },
      { role: 'user', content: 'say ok' },
    ],
    tools: CLAUDE_CODE_TOOLS_SAMPLE,
  }
  const { status, data } = await sendRequest(body)
  // stream 模式下返回 SSE 文本
  const hasContent = typeof data === 'string' ? data.includes('event:') : data?.content?.[0]?.text
  return { status, pass: status === 200, detail: hasContent ? 'response ok' : 'unexpected response format' }
})

// 2. Claude Code 2.1.87 风格请求（新增 thinking:adaptive, context_management, output_config）
await test('Claude Code 2.1.87 风格 (adaptive thinking, context_management, output_config)', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 64000,
    stream: true,
    thinking: { type: 'adaptive' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: SYSTEM_PROMPT_V233 },
      { role: 'assistant', content: 'I understand the instructions.' },
      { role: 'user', content: 'say ok' },
    ],
    tools: CLAUDE_CODE_TOOLS_SAMPLE,
  }
  const { status, data } = await sendRequest(body)
  const hasContent = typeof data === 'string' ? data.includes('event:') : data?.content?.[0]?.text
  return { status, pass: status === 200, detail: hasContent ? 'response ok' : `${JSON.stringify(data).slice(0, 150)}` }
})

// 3. 带 Claude Code 指纹文本（通过 CRS 时应被清理）
await test('Claude Code 指纹文本: "official CLI for Claude"', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 100,
    messages: [
      { role: 'user', content: `You are Claude Code, Anthropic's official CLI for Claude.\nsay ok` },
    ],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

// 4. 带 CLAUDE.md 指纹文本
await test('Claude Code 指纹文本: "(user\'s private global instructions for all projects)"', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Contents of CLAUDE.md (user's private global instructions for all projects):\n# Config\n- rule 1` },
          { type: 'text', text: 'say ok' },
        ],
      },
    ],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

// 5. thinking enabled + budget_tokens < max_tokens
await test('thinking enabled: budget=4096, max_tokens=8192', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    thinking: { type: 'enabled', budget_tokens: 4096 },
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200 }
})

// 6. thinking enabled + budget > max (CRS 应自动修正)
await test('thinking enabled: budget=10000, max_tokens=4096 (CRS 应修正 max_tokens)', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

// 7. thinking enabled + budget < 1024 (CRS 应修正为 1024)
await test('thinking enabled: budget=256 (CRS 应修正为 1024)', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    thinking: { type: 'enabled', budget_tokens: 256 },
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 100) : undefined }
})

// 8. 非 stream 请求
await test('非 stream 请求', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 100,
    stream: false,
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  const text = data?.content?.[0]?.text
  return { status, pass: status === 200 && !!text, detail: text ? `response: "${text}"` : undefined }
})

// 9. cache_control
await test('cache_control (ephemeral) 保留', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'A'.repeat(2000) + '\nThis is a long system prompt for caching test.',
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: 'say ok' },
      ],
    }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200 }
})

// 10. 大量 tools (Claude Code 2.1.87 有 59 个 tools)
await test('59 个 tools（模拟 2.1.87）', async () => {
  const tools = Array.from({ length: 59 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool number ${i} for testing. `.repeat(3),
    input_schema: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'First parameter' },
        param2: { type: 'number', description: 'Second parameter' },
      },
      required: ['param1'],
    },
  }))
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'say ok' }],
    tools,
  }
  const { status } = await sendRequest(body)
  return { status, pass: status === 200 }
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
    console.log(`  ❌ ${r.name} — HTTP ${r.status}${r.detail ? ` | ${r.detail}` : ''}`)
  }
}

process.exit(failed > 0 ? 1 : 0)
