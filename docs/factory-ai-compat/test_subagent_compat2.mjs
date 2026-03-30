/**
 * 子 Agent 兼容性测试 - 第二轮：细粒度定位 403 触发条件
 */

const API_KEY = process.env.FACTORY_AI_API_KEY
const BASE_URL = process.env.FACTORY_AI_BASE_URL || 'https://api.factory.ai/api/llm/a'
const ENDPOINT = `${BASE_URL}/v1/messages`

if (!API_KEY) { console.error('需要 FACTORY_AI_API_KEY'); process.exit(1) }

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
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'x-stainless-package-version': '0.70.1',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
}

async function send(body) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...DROID_HEADERS, 'x-assistant-message-id': crypto.randomUUID() },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
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

const DROID_MAGIC = 'You are Droid, an AI software engineering agent built by Factory.'
const BILLING = 'x-anthropic-billing-header: cc_version=2.1.33.dc6; cc_entrypoint=sdk-ts;'
const AGENT_SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
const CLAUDEMD_FINGERPRINT = "(user's private global instructions for all projects)"

console.log('=== 第一组：system 字段中的 Droid magic + 其他 block ===\n')

await test('1a. system=[Droid magic only]', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: DROID_MAGIC }],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('1b. system=[Droid magic, billing]', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [
      { type: 'text', text: DROID_MAGIC },
      { type: 'text', text: BILLING },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('1c. system=[Droid magic, Agent SDK]', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [
      { type: 'text', text: DROID_MAGIC },
      { type: 'text', text: AGENT_SDK },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('1d. system=[Droid magic, Claude Code identity]', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [
      { type: 'text', text: DROID_MAGIC },
      { type: 'text', text: CC_IDENTITY },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('1e. system=[Droid magic, billing, Agent SDK]', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [
      { type: 'text', text: DROID_MAGIC },
      { type: 'text', text: BILLING },
      { type: 'text', text: AGENT_SDK },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

console.log('\n=== 第二组：messages 中的指纹 ===\n')

await test('2a. Droid magic + msg 含 "Claude Code official CLI" 短语', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: DROID_MAGIC }],
    messages: [{ role: 'user', content: "You are Claude Code, Anthropic's official CLI for Claude.\nsay ok" }],
  })
  return { status, pass: status === 200 }
})

await test('2b. Droid magic + msg 含 CLAUDE.md 指纹（带括号）', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: DROID_MAGIC }],
    messages: [{ role: 'user', content: `Contents of CLAUDE.md ${CLAUDEMD_FINGERPRINT}:\n# Rules\nsay ok` }],
  })
  return { status, pass: status === 200 }
})

await test('2c. Droid magic + msg 含 "Claude Agent SDK" 短语', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: DROID_MAGIC }],
    messages: [{ role: 'user', content: `${AGENT_SDK}\nsay ok` }],
  })
  return { status, pass: status === 200 }
})

await test('2d. Droid magic + msg 含 billing header 文本', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: DROID_MAGIC }],
    messages: [{ role: 'user', content: `${BILLING}\nsay ok` }],
  })
  return { status, pass: status === 200 }
})

console.log('\n=== 第三组：不同的 system 第一个 block 内容 ===\n')

await test('3a. system=[billing only] (无 Droid)', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: BILLING }],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('3b. system=[Agent SDK only] (无 Droid)', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: AGENT_SDK }],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('3c. system=[random text] (无 Droid)', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('3d. system="" (空字符串)', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: '',
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
})

await test('3e. system=[] (空数组)', async () => {
  const { status } = await send({
    model: 'claude-haiku-4-5-20251001', max_tokens: 100, stream: false,
    system: [],
    messages: [{ role: 'user', content: 'say ok' }],
  })
  return { status, pass: status === 200 }
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
