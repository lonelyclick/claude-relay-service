/**
 * 子 Agent 请求通过 CRS 代理测试
 *
 * 验证 CRS 兼容层能否正确处理子 agent 格式的请求。
 * 使用 force_account 强制路由到 Factory.ai (droid) 账户。
 *
 * 用法:
 *   CRS_API_KEY="cr_..." node docs/factory-ai-compat/test_subagent_via_crs.mjs
 */

const CRS_API_KEY = process.env.CRS_API_KEY
const CRS_BASE_URL = process.env.CRS_BASE_URL || 'https://token.yohomobile.dev/api'
const DROID_ACCOUNT_ID = process.env.DROID_ACCOUNT_ID || '433a4dfe-999c-4784-8e01-29c334888a4a'

if (!CRS_API_KEY) {
  console.error('错误: 请设置 CRS_API_KEY 环境变量')
  process.exit(1)
}

// 使用 force_account query 参数强制路由到 droid 账户
const ENDPOINT = `${CRS_BASE_URL}/v1/messages?force_account=claude-console:${DROID_ACCOUNT_ID}`
console.log(`通过 CRS 代理测试子 Agent 兼容性`)
console.log(`CRS 端点: ${ENDPOINT}`)
console.log(`强制路由到 droid 账户: ${DROID_ACCOUNT_ID}\n`)

async function send(body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${CRS_API_KEY}`,
    'anthropic-version': '2023-06-01',
    'user-agent': 'claude-cli/2.1.33 (external, sdk-ts)',
    'anthropic-beta': 'interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219',
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

const results = []
async function test(name, fn) {
  try {
    const { status, pass, detail } = await fn()
    results.push({ name, status, pass })
    console.log(`${pass ? '✅' : '❌'} ${name} — HTTP ${status}${detail ? ` | ${detail}` : ''}`)
  } catch (err) {
    results.push({ name, status: 'ERR', pass: false })
    console.log(`💥 ${name} — ${err.message}`)
  }
}

// ─── 基线：主 agent 正常请求 ───

await test('基线: 主 agent 正常请求 (有 system, tools)', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
      { type: 'text', text: "You are an interactive agent that helps users with software engineering tasks." },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
    tools: [
      { name: 'Bash', description: 'Execute a bash command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    ],
  }
  const { status, data } = await send(body)
  const text = data?.content?.find(c => c.type === 'text')?.text
  return { status, pass: status === 200, detail: text ? `"${text}"` : JSON.stringify(data).slice(0, 100) }
})

// ─── 子 Agent 场景 ───

// Explore agent: system=[billing, "Claude Code official CLI", explore-desc], messages 含 CLAUDE.md
await test('Explore 子agent: system + messages 含全部指纹', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.", cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: "You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.\n\n=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===\nYour role is EXCLUSIVELY to search and analyze existing code.",
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nContents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):\n\n# Dev Rules\n- Use Chinese\n</system-reminder>\n",
        },
        { type: 'text', text: 'say ok' },
      ],
    }],
    tools: [
      { name: 'Bash', description: 'Execute a bash command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Glob', description: 'Find files.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'Grep', description: 'Search.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'Read', description: 'Read file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    ],
    metadata: { user_id: 'test_user' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  }
  const { status, data } = await send(body)
  const text = data?.content?.find(c => c.type === 'text')?.text
  return { status, pass: status === 200, detail: text ? `"${text}"` : JSON.stringify(data).slice(0, 120) }
})

// 内部 Haiku 辅助请求 (filepath extractor)
await test('Haiku filepath-extractor: system=[billing, Agent SDK, extractor]', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.964; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: "Extract any file paths that this command reads or modifies.\nFormat: <filepaths>path</filepaths>",
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: 'Command: ls /tmp\nOutput: foo.txt bar.txt' }],
    tools: [],
    metadata: { user_id: 'test_user' },
  }
  const { status, data } = await send(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// WebFetch Haiku 辅助请求
await test('Haiku WebFetch: system=[billing, Agent SDK]', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.964; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
    messages: [{ role: 'user', content: 'Web page content:\n---\nHello World\n---\n\nExtract the main heading.' }],
    tools: [],
  }
  const { status, data } = await send(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// Plan agent
await test('Plan 子agent: system 含 Claude Code 指纹, messages 含 CLAUDE.md', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.", cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: "You are a software architect agent for Claude Code. You design implementation plans.\n\nGuidelines:\n- Explore the codebase\n- Identify critical files\n- Consider architectural trade-offs",
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: "<system-reminder>\nContents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):\n# Rules\n- Always confirm before actions\n</system-reminder>\n",
        },
        { type: 'text', text: 'say ok' },
      ],
    }],
    tools: [
      { name: 'Glob', description: 'Find files.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'Read', description: 'Read file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    ],
  }
  const { status, data } = await send(body)
  const text = data?.content?.find(c => c.type === 'text')?.text
  return { status, pass: status === 200, detail: text ? `"${text}"` : JSON.stringify(data).slice(0, 120) }
})

// stream 模式子 agent
await test('Stream Explore 子agent', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 32000,
    temperature: 1,
    stream: true,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.", cache_control: { type: 'ephemeral' } },
      { type: 'text', text: "You are a file search specialist.", cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: "<system-reminder>\nContents of CLAUDE.md (user's private global instructions for all projects):\n# Config\n</system-reminder>" },
        { type: 'text', text: 'say ok' },
      ],
    }],
  }
  const { status, data } = await send(body)
  const hasEvent = typeof data === 'string' && data.includes('event:')
  return { status, pass: status === 200, detail: hasEvent ? 'stream ok' : JSON.stringify(data).slice(0, 120) }
})

// ─── 汇总 ───
console.log('\n' + '='.repeat(60))
const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass).length
console.log(`✅ 通过: ${passed}  ❌ 失败: ${failed}  总计: ${results.length}`)

if (failed > 0) {
  console.log('\n失败项:')
  for (const r of results.filter(r => !r.pass)) console.log(`  ❌ ${r.name} — HTTP ${r.status}`)
}

process.exit(failed > 0 ? 1 : 0)
