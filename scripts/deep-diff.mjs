#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const DIR = path.resolve('scripts/captured-bodies')
const DIFF_DIR = path.resolve('scripts/body-diffs')
mkdirSync(DIFF_DIR, { recursive: true })

const files = readdirSync(DIR)
  .filter(f => f.endsWith('.json') && !f.includes('headers') && !f.startsWith('vunknown'))
  .sort()

const bodies = files.map(file => {
  const raw = readFileSync(path.join(DIR, file), 'utf8')
  const json = JSON.parse(raw)
  const version = file.match(/v([\d.]+)/)?.[1] ?? 'unknown'
  return { version, json, file }
})

const target = bodies.find(b => b.version === '2.1.98')
if (!target) { console.error('No 2.1.98 body found'); process.exit(1) }

// ========================================
// 1. System Prompt Deep Diff
// ========================================
console.log('='.repeat(70))
console.log('1. SYSTEM PROMPT DEEP DIFF (each version vs 2.1.98)')
console.log('='.repeat(70))

const targetSystem = target.json.system
console.log(`\n2.1.98 system: ${targetSystem.length} blocks`)
for (let i = 0; i < targetSystem.length; i++) {
  const block = targetSystem[i]
  const text = typeof block === 'string' ? block : (block.text ?? JSON.stringify(block))
  console.log(`  block[${i}]: type=${block.type ?? 'string'}, cache_control=${JSON.stringify(block.cache_control ?? null)}, length=${text.length}`)
}

for (const body of bodies) {
  if (body.version === '2.1.98') continue
  console.log(`\n--- v${body.version} vs v2.1.98 ---`)
  const sys = body.json.system
  console.log(`  block count: ${sys.length} vs ${targetSystem.length}`)

  // Compare each block text
  const maxBlocks = Math.max(sys.length, targetSystem.length)
  for (let i = 0; i < maxBlocks; i++) {
    const a = sys[i]
    const b = targetSystem[i]
    if (!a) { console.log(`  block[${i}]: MISSING in v${body.version}`); continue }
    if (!b) { console.log(`  block[${i}]: EXTRA in v${body.version}`); continue }

    const aText = typeof a === 'string' ? a : (a.text ?? '')
    const bText = typeof b === 'string' ? b : (b.text ?? '')
    const aType = a.type ?? 'string'
    const bType = b.type ?? 'string'
    const aCacheControl = JSON.stringify(a.cache_control ?? null)
    const bCacheControl = JSON.stringify(b.cache_control ?? null)

    if (aType !== bType) console.log(`  block[${i}]: type differs: ${aType} vs ${bType}`)
    if (aCacheControl !== bCacheControl) console.log(`  block[${i}]: cache_control differs: ${aCacheControl} vs ${bCacheControl}`)

    if (aText === bText) {
      console.log(`  block[${i}]: IDENTICAL (${aText.length} chars)`)
      continue
    }

    console.log(`  block[${i}]: DIFFERS (${aText.length} vs ${bText.length} chars)`)

    // Find all diff positions
    const diffs = []
    const maxLen = Math.max(aText.length, bText.length)
    let diffStart = -1
    for (let j = 0; j <= maxLen; j++) {
      const same = j < aText.length && j < bText.length && aText[j] === bText[j]
      if (!same && diffStart === -1) {
        diffStart = j
      } else if ((same || j === maxLen) && diffStart !== -1) {
        diffs.push({ start: diffStart, end: j })
        diffStart = -1
      }
    }

    for (const d of diffs) {
      const ctx = 30
      const aSlice = aText.slice(Math.max(0, d.start - ctx), d.end + ctx)
      const bSlice = bText.slice(Math.max(0, d.start - ctx), d.end + ctx)
      console.log(`    diff at [${d.start}..${d.end}]:`)
      console.log(`      v${body.version}: ...${JSON.stringify(aSlice)}...`)
      console.log(`      v2.1.98:  ...${JSON.stringify(bSlice)}...`)
    }
  }
}

// ========================================
// 2. Tool Diffs
// ========================================
console.log('\n' + '='.repeat(70))
console.log('2. TOOL DIFFS (each version vs 2.1.98)')
console.log('='.repeat(70))

const targetTools = new Map(target.json.tools.map(t => [t.name, t]))

for (const body of bodies) {
  if (body.version === '2.1.98') continue
  console.log(`\n--- v${body.version} vs v2.1.98 ---`)

  const srcTools = new Map((body.json.tools ?? []).map(t => [t.name, t]))

  // Missing tools
  for (const [name] of targetTools) {
    if (!srcTools.has(name)) console.log(`  MISSING tool: ${name}`)
  }
  // Extra tools
  for (const [name] of srcTools) {
    if (!targetTools.has(name)) console.log(`  EXTRA tool: ${name}`)
  }

  // Schema diffs
  for (const [name, targetTool] of targetTools) {
    const srcTool = srcTools.get(name)
    if (!srcTool) continue

    const targetStr = JSON.stringify(targetTool, null, 2)
    const srcStr = JSON.stringify(srcTool, null, 2)
    if (targetStr === srcStr) continue

    console.log(`  CHANGED tool: ${name}`)

    // Compare description
    if (srcTool.description !== targetTool.description) {
      // Find exact diff in description
      const a = srcTool.description ?? ''
      const b = targetTool.description ?? ''
      console.log(`    description: ${a.length} vs ${b.length} chars`)

      let diffStart = -1
      for (let j = 0; j <= Math.max(a.length, b.length); j++) {
        const same = j < a.length && j < b.length && a[j] === b[j]
        if (!same && diffStart === -1) { diffStart = j }
        else if ((same || j === Math.max(a.length, b.length)) && diffStart !== -1) {
          const ctx = 40
          console.log(`      diff at [${diffStart}..${j}]:`)
          console.log(`        v${body.version}: ...${JSON.stringify(a.slice(Math.max(0, diffStart - ctx), j + ctx))}...`)
          console.log(`        v2.1.98:  ...${JSON.stringify(b.slice(Math.max(0, diffStart - ctx), j + ctx))}...`)
          diffStart = -1
        }
      }
    }

    // Compare input_schema
    const srcSchema = JSON.stringify(srcTool.input_schema)
    const targetSchema = JSON.stringify(targetTool.input_schema)
    if (srcSchema !== targetSchema) {
      console.log(`    input_schema differs (${srcSchema.length} vs ${targetSchema.length} chars)`)
      // Show the schema diff
      const srcObj = srcTool.input_schema?.properties ?? {}
      const targetObj = targetTool.input_schema?.properties ?? {}
      for (const key of new Set([...Object.keys(srcObj), ...Object.keys(targetObj)])) {
        const a = JSON.stringify(srcObj[key])
        const b = JSON.stringify(targetObj[key])
        if (a !== b) {
          if (!a) console.log(`      property "${key}": ADDED in 2.1.98`)
          else if (!b) console.log(`      property "${key}": REMOVED in 2.1.98`)
          else console.log(`      property "${key}": CHANGED`)
        }
      }
    }
  }
}

// ========================================
// 3. Message content diff
// ========================================
console.log('\n' + '='.repeat(70))
console.log('3. MESSAGE CONTENT DIFF (each version vs 2.1.98)')
console.log('='.repeat(70))

const targetMsg = target.json.messages[0]
const targetMsgContent = typeof targetMsg.content === 'string' ? targetMsg.content : JSON.stringify(targetMsg.content)

for (const body of bodies) {
  if (body.version === '2.1.98') continue
  const msg = body.json.messages[0]
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)

  if (content === targetMsgContent) {
    console.log(`v${body.version}: IDENTICAL`)
    continue
  }

  console.log(`v${body.version}: DIFFERS (${content.length} vs ${targetMsgContent.length})`)
  for (let j = 0; j < Math.max(content.length, targetMsgContent.length); j++) {
    if (content[j] !== targetMsgContent[j]) {
      console.log(`  first diff at pos ${j}:`)
      console.log(`    v${body.version}: ...${JSON.stringify(content.slice(Math.max(0, j - 30), j + 80))}...`)
      console.log(`    v2.1.98:  ...${JSON.stringify(targetMsgContent.slice(Math.max(0, j - 30), j + 80))}...`)
      break
    }
  }
}

// ========================================
// 4. Other top-level field diffs
// ========================================
console.log('\n' + '='.repeat(70))
console.log('4. OTHER FIELDS DIFF (each version vs 2.1.98)')
console.log('='.repeat(70))

const SKIP_KEYS = new Set(['system', 'tools', 'messages'])

for (const body of bodies) {
  if (body.version === '2.1.98') continue
  console.log(`\n--- v${body.version} vs v2.1.98 ---`)

  for (const key of Object.keys(target.json)) {
    if (SKIP_KEYS.has(key)) continue
    const a = JSON.stringify(body.json[key])
    const b = JSON.stringify(target.json[key])
    if (a === b) {
      console.log(`  ${key}: IDENTICAL`)
    } else {
      console.log(`  ${key}: DIFFERS`)
      console.log(`    v${body.version}: ${a?.slice(0, 200)}`)
      console.log(`    v2.1.98:  ${b?.slice(0, 200)}`)
    }
  }
}

// ========================================
// 5. Export v2.1.98 full body structure for reference
// ========================================
const refPath = path.join(DIFF_DIR, 'v2.1.98-structure.json')
const struct = {
  topLevelKeys: Object.keys(target.json),
  model: target.json.model,
  max_tokens: target.json.max_tokens,
  thinking: target.json.thinking,
  context_management: target.json.context_management,
  output_config: target.json.output_config,
  metadata: target.json.metadata,
  systemBlockCount: targetSystem.length,
  systemBlocks: targetSystem.map((b, i) => ({
    index: i,
    type: b.type ?? 'string',
    cache_control: b.cache_control ?? null,
    textLength: (typeof b === 'string' ? b : b.text ?? '').length,
    textPreview: (typeof b === 'string' ? b : b.text ?? '').slice(0, 200),
  })),
  toolCount: target.json.tools.length,
  toolNames: target.json.tools.map(t => t.name),
}
writeFileSync(refPath, JSON.stringify(struct, null, 2))
console.log(`\nWrote 2.1.98 structure reference to ${refPath}`)
