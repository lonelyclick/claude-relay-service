#!/usr/bin/env node
/**
 * Analyze what exactly needs to be rewritten in the body for each version
 * to match v2.1.98, and assess feasibility.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DIR = path.resolve('scripts/captured-bodies')
const files = readdirSync(DIR)
  .filter(f => f.endsWith('.json') && !f.includes('headers') && !f.startsWith('vunknown'))
  .sort()

const bodies = files.map(file => {
  const raw = readFileSync(path.join(DIR, file), 'utf8')
  const json = JSON.parse(raw)
  const version = file.match(/v([\d.]+)/)?.[1] ?? 'unknown'
  return { version, json, raw }
})

const target = bodies.find(b => b.version === '2.1.98')

console.log('='.repeat(70))
console.log('BODY REWRITE FEASIBILITY ANALYSIS')
console.log('Target: v2.1.98')
console.log('='.repeat(70))

// ========================================
// 1. cc_version in system prompt block[0]
// ========================================
console.log('\n## 1. cc_version (system.block[0])')
console.log('Format: cc_version=MAJOR.MINOR.PATCH.HASH')
for (const b of bodies) {
  const block0 = b.json.system[0]
  const text = typeof block0 === 'string' ? block0 : block0.text
  const match = text.match(/cc_version=([\d.]+\.\w+)/)
  console.log(`  v${b.version}: ${match?.[1] ?? 'NOT FOUND'}`)
}
console.log('  Rewrite: simple regex replace cc_version=X.Y.Z.HASH -> cc_version=2.1.98.e54')
console.log('  Risk: LOW - just a version string swap')

// ========================================
// 2. System prompt structure
// ========================================
console.log('\n## 2. System prompt block structure')
for (const b of bodies) {
  const sys = b.json.system
  console.log(`  v${b.version}: ${sys.length} blocks`)
  for (let i = 0; i < sys.length; i++) {
    const block = sys[i]
    const text = typeof block === 'string' ? block : (block.text ?? '')
    const cc = JSON.stringify(block.cache_control ?? null)
    console.log(`    [${i}] type=${block.type ?? 'string'}, cache=${cc}, len=${text.length}`)
  }
}

// Check if block content differs beyond cc_version
console.log('\n  Content differences (ignoring cc_version):')
for (const b of bodies) {
  if (b.version === '2.1.98') continue
  const sys = b.json.system
  const targetSys = target.json.system

  // Normalize cc_version for comparison
  const normalize = text => text.replace(/cc_version=[\d.]+\.\w+/, 'cc_version=NORMALIZED')

  if (sys.length !== targetSys.length) {
    // Check if the content is a subset
    const allSrcText = sys.map(bl => normalize(typeof bl === 'string' ? bl : bl.text ?? '')).join('|||')
    const allTargetText = targetSys.map(bl => normalize(typeof bl === 'string' ? bl : bl.text ?? '')).join('|||')

    // Check block-by-block overlap
    for (let i = 0; i < Math.min(sys.length, targetSys.length); i++) {
      const srcText = normalize(typeof sys[i] === 'string' ? sys[i] : sys[i].text ?? '')
      const targetText = normalize(typeof targetSys[i] === 'string' ? targetSys[i] : targetSys[i].text ?? '')
      if (srcText === targetText) {
        console.log(`    v${b.version}: block[${i}] IDENTICAL after normalization`)
      } else if (targetText.startsWith(srcText)) {
        console.log(`    v${b.version}: block[${i}] is prefix of target (${srcText.length} vs ${targetText.length})`)
      } else if (srcText.startsWith(targetText)) {
        console.log(`    v${b.version}: block[${i}] target is prefix of source (${targetText.length} vs ${srcText.length})`)
      } else {
        console.log(`    v${b.version}: block[${i}] DIFFERENT content`)
      }
    }
    if (sys.length > targetSys.length) {
      console.log(`    v${b.version}: has ${sys.length - targetSys.length} extra blocks`)
    } else {
      console.log(`    v${b.version}: missing ${targetSys.length - sys.length} blocks from target`)
    }
  } else {
    let allSame = true
    for (let i = 0; i < sys.length; i++) {
      const srcText = normalize(typeof sys[i] === 'string' ? sys[i] : sys[i].text ?? '')
      const targetText = normalize(typeof targetSys[i] === 'string' ? targetSys[i] : targetSys[i].text ?? '')
      if (srcText !== targetText) {
        allSame = false
        console.log(`    v${b.version}: block[${i}] DIFFERENT (${srcText.length} vs ${targetText.length})`)
      }
    }
    if (allSame) console.log(`    v${b.version}: ALL BLOCKS IDENTICAL after normalization`)
  }
}

// ========================================
// 3. cache_control differences
// ========================================
console.log('\n## 3. cache_control on system blocks')
for (const b of bodies) {
  const ccs = b.json.system.map((bl, i) => `[${i}]=${JSON.stringify(bl.cache_control ?? null)}`)
  console.log(`  v${b.version}: ${ccs.join(', ')}`)
}
console.log('  Rewrite: update cache_control on each block')
console.log('  Risk: LOW - metadata only')

// ========================================
// 4. Tools
// ========================================
console.log('\n## 4. Tools')
const targetToolNames = target.json.tools.map(t => t.name)
const targetToolMap = new Map(target.json.tools.map(t => [t.name, JSON.stringify(t)]))

for (const b of bodies) {
  if (b.version === '2.1.98') continue
  const srcToolMap = new Map(b.json.tools.map(t => [t.name, JSON.stringify(t)]))

  const missing = targetToolNames.filter(n => !srcToolMap.has(n))
  const extra = [...srcToolMap.keys()].filter(n => !targetToolMap.has(n))
  const changed = targetToolNames.filter(n => srcToolMap.has(n) && srcToolMap.get(n) !== targetToolMap.get(n))
  const identical = targetToolNames.filter(n => srcToolMap.has(n) && srcToolMap.get(n) === targetToolMap.get(n))

  console.log(`  v${b.version}:`)
  console.log(`    identical: ${identical.length} tools`)
  console.log(`    missing: [${missing.join(', ')}]`)
  console.log(`    extra: [${extra.join(', ')}]`)
  console.log(`    changed: [${changed.join(', ')}]`)
}
console.log('  Rewrite: replace entire tools array with v2.1.98 tools')
console.log('  Risk: MEDIUM - tool availability must match what model expects')

// ========================================
// 5. messages content
// ========================================
console.log('\n## 5. Messages')
const targetMsgs = target.json.messages
for (const b of bodies) {
  if (b.version === '2.1.98') continue
  const msgs = b.json.messages
  if (msgs.length !== targetMsgs.length) {
    console.log(`  v${b.version}: different message count ${msgs.length} vs ${targetMsgs.length}`)
    continue
  }
  for (let i = 0; i < msgs.length; i++) {
    const src = JSON.stringify(msgs[i])
    const tgt = JSON.stringify(targetMsgs[i])
    if (src === tgt) {
      console.log(`  v${b.version}: msg[${i}] IDENTICAL`)
    } else {
      // Check if it's just the content structure
      const srcContent = msgs[i].content
      const tgtContent = targetMsgs[i].content

      if (typeof srcContent === typeof tgtContent && Array.isArray(srcContent) && Array.isArray(tgtContent)) {
        // Compare block by block
        for (let j = 0; j < Math.max(srcContent.length, tgtContent.length); j++) {
          const a = JSON.stringify(srcContent[j] ?? null)
          const b_str = JSON.stringify(tgtContent[j] ?? null)
          if (a !== b_str) {
            const srcText = srcContent[j]?.text ?? ''
            const tgtText = tgtContent[j]?.text ?? ''
            // Find first diff
            for (let k = 0; k < Math.max(srcText.length, tgtText.length); k++) {
              if (srcText[k] !== tgtText[k]) {
                console.log(`  v${b.version}: msg[${i}].content[${j}] differs at pos ${k}:`)
                console.log(`    src: "${srcText.slice(Math.max(0,k-20), k+60)}"`)
                console.log(`    tgt: "${tgtText.slice(Math.max(0,k-20), k+60)}"`)
                break
              }
            }
          }
        }
      } else {
        console.log(`  v${b.version}: msg[${i}] DIFFERENT structure`)
      }
    }
  }
}

// ========================================
// 6. Other fields
// ========================================
console.log('\n## 6. Other top-level fields')
const SKIP = new Set(['system', 'tools', 'messages'])
for (const b of bodies) {
  if (b.version === '2.1.98') continue
  const diffs = []
  for (const key of Object.keys(target.json)) {
    if (SKIP.has(key)) continue
    const src = JSON.stringify(b.json[key])
    const tgt = JSON.stringify(target.json[key])
    if (src !== tgt) diffs.push(`${key}: ${src} vs ${tgt}`)
  }
  if (diffs.length === 0) {
    console.log(`  v${b.version}: ALL IDENTICAL`)
  } else {
    console.log(`  v${b.version}:`)
    for (const d of diffs) console.log(`    ${d}`)
  }
}

// ========================================
// 7. Summary
// ========================================
console.log('\n' + '='.repeat(70))
console.log('REWRITE STRATEGY SUMMARY')
console.log('='.repeat(70))
console.log(`
Rewrite points for any v2.1.90-2.1.97 body to look like v2.1.98:

1. system[0].text: regex replace cc_version
   - Pattern: cc_version=\\d+\\.\\d+\\.\\d+\\.\\w+
   - Replace: cc_version=2.1.98.e54

2. system block structure:
   - v90-96: 4 blocks -> need to merge/restructure to 3 blocks
   - v97: already 3 blocks, might need content adjustment
   - cache_control needs updating

3. system[last].text: session-specific guidance section
   - v90-96: ~11695 chars (shorter, missing session guidance)
   - v97: ~26646 chars (same as v98? need to verify)
   - v98: ~26646 chars

4. tools[]: replace entire array with v2.1.98 tools
   - Add Monitor tool
   - Update Agent, Bash, Edit, Read descriptions/schemas

5. messages[].content: may contain version-specific strings

6. metadata, thinking, context_management, output_config, max_tokens:
   - Compare for differences
`)
