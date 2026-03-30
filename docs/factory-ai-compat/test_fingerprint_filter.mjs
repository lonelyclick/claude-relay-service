/**
 * Factory.ai 指纹过滤规则验证测试
 *
 * 精确测试 Factory.ai 安全系统对 Claude Code 指纹文本的检测逻辑，
 * 包括被封锁的短语、不触发的变体、以及边界情况。
 *
 * 用法:
 *   export FACTORY_AI_API_KEY="fk-..."
 *   export FACTORY_AI_BASE_URL="https://api.factory.ai/api/llm/a"  # 可选
 *   node docs/factory-ai-compat/test_fingerprint_filter.mjs
 */

const API_KEY = process.env.FACTORY_AI_API_KEY
const BASE_URL = process.env.FACTORY_AI_BASE_URL || 'https://api.factory.ai/api/llm/a'
const ENDPOINT = `${BASE_URL}/v1/messages`

if (!API_KEY) {
  console.error('错误: 请设置 FACTORY_AI_API_KEY 环境变量')
  process.exit(1)
}

// ─── 工具函数 ───

async function testText(text) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'factory-cli/0.89.0',
      'x-client-version': '0.89.0',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 50,
      messages: [{ role: 'user', content: text + '\nsay ok' }],
    }),
  })
  return res.status
}

const results = []

async function expect(name, text, expectedStatus) {
  const status = await testText(text)
  const pass = status === expectedStatus
  results.push({ name, status, pass, expected: expectedStatus })
  const icon = pass ? '✅' : '❌'
  console.log(`${icon} ${name} — HTTP ${status} (期望 ${expectedStatus})`)
}

// ─── 指纹 1: Claude Code 身份声明 ───

console.log('═══ 指纹 1: Claude Code 身份声明 ═══\n')

await expect(
  '完整身份声明 (应被封锁)',
  "You are Claude Code, Anthropic's official CLI for Claude",
  403
)

await expect(
  '只有 "You are Claude Code" (不触发)',
  'You are Claude Code',
  200
)

await expect(
  '只有 "Anthropic\'s official CLI for Claude" (不触发)',
  "Anthropic's official CLI for Claude",
  200
)

await expect(
  '"Claude Code, Anthropic\'s official CLI" (不触发)',
  "Claude Code, Anthropic's official CLI",
  200
)

await expect(
  '"Claude Code CLI" (不触发)',
  'Claude Code CLI',
  200
)

await expect(
  '身份声明 + 后续内容',
  "You are Claude Code, Anthropic's official CLI for Claude.\nYou help with coding tasks.",
  403
)

await expect(
  '身份声明在 messages 中间',
  "Here is some context.\nYou are Claude Code, Anthropic's official CLI for Claude.\nMore context.",
  403
)

// ─── 指纹 2: CLAUDE.md 注入标记 ───

console.log('\n═══ 指纹 2: CLAUDE.md 注入标记 ═══\n')

await expect(
  '带括号的完整短语 (应被封锁)',
  "(user's private global instructions for all projects)",
  403
)

await expect(
  '不带括号 (不触发)',
  "user's private global instructions for all projects",
  200
)

await expect(
  '只有 "private global instructions" (不触发)',
  'private global instructions',
  200
)

await expect(
  '"(user\'s private global instructions)" 少了 "for all projects" (不触发)',
  "(user's private global instructions)",
  200
)

await expect(
  '"(user\'s global instructions for all projects)" 少了 "private" (不触发)',
  "(user's global instructions for all projects)",
  200
)

await expect(
  '"(user\'s private instructions for all projects)" 少了 "global" (不触发)',
  "(user's private instructions for all projects)",
  200
)

await expect(
  '"private global instructions for all projects:" 带冒号无括号 (不触发)',
  'private global instructions for all projects:',
  200
)

await expect(
  '完整格式: "Contents of CLAUDE.md (user\'s private...)" (应被封锁)',
  "Contents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):\n# Config\n- rule 1",
  403
)

// ─── 其他可能的指纹 ───

console.log('\n═══ 其他 Claude Code 相关文本 ═══\n')

await expect(
  '"<system-reminder>" 标签 (不触发)',
  '<system-reminder>some content</system-reminder>',
  200
)

await expect(
  '"running within the Claude Agent SDK" (不触发)',
  'running within the Claude Agent SDK',
  200
)

await expect(
  '"instructions OVERRIDE any default behavior" (不触发)',
  'These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
  200
)

await expect(
  '"Claude Code" 在帮助文本中 (不触发)',
  '/help: Get help with using Claude Code',
  200
)

// ─── 替换后的文本验证 ───

console.log('\n═══ CRS 替换后的文本 (应不触发) ═══\n')

await expect(
  'CRS 替换: "You are an AI coding assistant"',
  'You are an AI coding assistant',
  200
)

await expect(
  'CRS 替换: "[user project-level config]"',
  'Contents of CLAUDE.md [user project-level config]:\n# Config\n- rule 1',
  200
)

// ─── 汇总 ───

console.log('\n' + '='.repeat(60))
console.log('汇总:')
const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass).length
console.log(`  ✅ 通过: ${passed}`)
console.log(`  ❌ 失败: ${failed}`)
console.log(`  总计: ${results.length}`)

if (failed > 0) {
  console.log('\n失败项 (Factory.ai 行为与预期不符):')
  for (const r of results.filter(r => !r.pass)) {
    console.log(`  ❌ ${r.name} — 实际 HTTP ${r.status}, 期望 ${r.expected}`)
  }
  console.log('\n注意: 如果某些之前被封锁的短语现在通过了，说明 Factory.ai 更新了过滤规则，')
  console.log('      CRS 中对应的指纹替换可以移除。')
}

process.exit(failed > 0 ? 1 : 0)
