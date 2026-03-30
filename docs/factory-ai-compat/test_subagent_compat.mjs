/**
 * 子 Agent (Task tool) 兼容性测试
 *
 * 模拟 Claude Code 子 agent 的请求格式，直连 Factory.ai 测试。
 * 子 agent 请求与主 agent 的关键区别：
 *   1. system 中包含 "You are Claude Code..." + 子 agent 角色描述
 *   2. system 中包含 "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 *   3. messages 中嵌入了 CLAUDE.md 内容（含指纹文本）
 *   4. 没有 Droid magic string
 *
 * 用法:
 *   FACTORY_AI_API_KEY="fk-..." node docs/factory-ai-compat/test_subagent_compat.mjs
 */

const API_KEY = process.env.FACTORY_AI_API_KEY
const BASE_URL = process.env.FACTORY_AI_BASE_URL || 'https://api.factory.ai/api/llm/a'

if (!API_KEY) {
  console.error('错误: 请设置 FACTORY_AI_API_KEY 环境变量')
  process.exit(1)
}

const ENDPOINT = `${BASE_URL}/v1/messages`
console.log(`直连 Factory.ai 测试子 Agent 兼容性`)
console.log(`API 端点: ${ENDPOINT}\n`)

// Droid 标准 headers
const DROID_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
  'anthropic-version': '2023-06-01',
  'User-Agent': 'factory-cli/0.89.0',
  'x-client-version': '0.89.0',
  'x-factory-client': 'cli',
  'x-api-provider': 'anthropic',
  'x-api-key': 'placeholder',
  'x-session-id': crypto.randomUUID(),
  'x-assistant-message-id': crypto.randomUUID(),
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'x-stainless-package-version': '0.70.1',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
}

async function sendRequest(body, headers = DROID_HEADERS) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...headers, 'x-assistant-message-id': crypto.randomUUID() },
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

// ─── 基线测试：Droid 正常请求 ───

await test('基线: Droid 标准请求 (有 magic string)', async () => {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 128000,
    stream: false,
    system: [
      { type: 'text', text: 'You are Droid, an AI software engineering agent built by Factory.' },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  }
  const { status } = await sendRequest(body)
  return { status, pass: status === 200 }
})

// ─── 子 Agent 场景 ───

// 场景 1: 无 system 字段
await test('子agent: 无 system 字段', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    stream: false,
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status } = await sendRequest(body)
  return { status, pass: status === 200 }
})

// 场景 2: system 只有 billing header（子 agent 典型格式）
await test('子agent: system=[billing-header]', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// 场景 3: system 包含 "You are a Claude agent, built on Anthropic's Claude Agent SDK."
await test('子agent: system=[billing, "Claude Agent SDK"]', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// 场景 4: system 包含 "Claude Code" 完整指纹
await test('子agent: system=[billing, "Claude Code official CLI"]', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// 场景 5: system 包含子 agent 角色描述（Explore agent）
await test('子agent: system=[billing, "Claude Code official CLI", explore-agent-desc]', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 32000,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
      { type: 'text', text: "You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.\n\n=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===" },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// 场景 6: messages 中嵌入 CLAUDE.md（带指纹）
await test('子agent: messages 中嵌入 CLAUDE.md 指纹', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    stream: false,
    system: [
      { type: 'text', text: 'You are Droid, an AI software engineering agent built by Factory.' },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: "<system-reminder>\nContents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):\n# Dev Rules\n- Use Chinese\n</system-reminder>" },
        { type: 'text', text: 'say ok' },
      ],
    }],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// 场景 7: 完整子 agent 格式（billing + Claude Agent SDK + Claude Code 指纹在 messages 中）
await test('子agent 完整格式: system=[billing, Agent SDK], msg 含 CLAUDE.md 指纹', async () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: 'ephemeral' } },
      { type: 'text', text: "You are a file search specialist for Claude Code. You excel at navigating codebases.\n\nGuidelines:\n- Use Glob for file pattern matching\n- Use Grep for content search\n- Use Read for reading files", cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nContents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):\n\n# Dev Guidelines\n- Use Chinese for communication\n</system-reminder>\n",
        },
        { type: 'text', text: 'Search for files matching *.ts in the src directory and report what you find. Just say ok for testing.' },
      ],
    }],
    tools: [
      { name: 'Bash', description: 'Execute a bash command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Glob', description: 'Find files matching a glob pattern.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'Grep', description: 'Search file contents.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'Read', description: 'Read a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    ],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// 场景 8: Haiku 内部辅助请求（如文件路径提取）—— 最小的子请求
await test('内部辅助请求: system=[billing, Agent SDK, filepath-extractor]', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.964; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      { type: 'text', text: "Extract any file paths that this command reads or modifies.\n\nFormat your response as:\n<filepaths>\npath/to/file\n</filepaths>" },
    ],
    messages: [{ role: 'user', content: 'Command: ls /tmp\nOutput: foo.txt bar.txt' }],
    tools: [],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
})

// 场景 9: WebFetch 辅助请求 —— Haiku 做内容提取
await test('WebFetch 辅助请求: system=[billing, Agent SDK, content-extractor]', async () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32000,
    temperature: 1,
    stream: false,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.33.964; cc_entrypoint=sdk-ts;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
    messages: [{ role: 'user', content: 'Web page content:\n---\nHello World\n---\n\nExtract the main content.' }],
    tools: [],
  }
  const { status, data } = await sendRequest(body)
  return { status, pass: status === 200, detail: status !== 200 ? JSON.stringify(data).slice(0, 120) : undefined }
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

console.log('\n分析:')
console.log('  子 agent 请求 403 的触发条件：')
for (const r of results) {
  if (!r.pass && r.status === 403) {
    console.log(`    → ${r.name}`)
  }
}

process.exit(failed > 0 ? 1 : 0)
