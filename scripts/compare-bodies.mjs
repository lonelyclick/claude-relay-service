#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = path.resolve('scripts/captured-bodies')
const files = readdirSync(DIR)
  .filter(f => f.endsWith('.json') && !f.includes('headers') && !f.startsWith('vunknown'))
  .sort()

console.log('=== Body Size Summary ===')
const bodies = []
for (const file of files) {
  const raw = readFileSync(path.join(DIR, file))
  const json = JSON.parse(raw)
  const version = file.match(/v([\d.]+)/)?.[1] ?? 'unknown'
  bodies.push({ version, json, size: raw.length, file })
  console.log(`v${version}: ${raw.length} bytes`)
}

console.log('\n=== Top-Level Keys ===')
for (const { version, json } of bodies) {
  console.log(`v${version}: ${Object.keys(json).sort().join(', ')}`)
}

console.log('\n=== Scalar Fields ===')
for (const { version, json } of bodies) {
  const { model, max_tokens, stream, temperature, top_k, top_p, stop_sequences } = json
  console.log(`v${version}: model=${model}, max_tokens=${max_tokens}, stream=${stream}, temperature=${temperature}, top_k=${top_k}, top_p=${top_p}, stop_sequences=${JSON.stringify(stop_sequences)}`)
}

console.log('\n=== System Prompt ===')
for (const { version, json } of bodies) {
  const system = json.system
  if (Array.isArray(system)) {
    const totalLen = system.reduce((sum, s) => sum + (typeof s === 'string' ? s.length : JSON.stringify(s).length), 0)
    console.log(`v${version}: ${system.length} blocks, total ~${totalLen} chars`)
  } else if (typeof system === 'string') {
    console.log(`v${version}: string, ${system.length} chars`)
  } else {
    console.log(`v${version}: ${typeof system}`)
  }
}

console.log('\n=== Tools ===')
for (const { version, json } of bodies) {
  const tools = json.tools ?? []
  const toolNames = tools.map(t => t.name).sort()
  console.log(`v${version}: ${tools.length} tools: ${toolNames.join(', ')}`)
}

// Find tools that differ between versions
const allToolSets = bodies.map(b => new Set((b.json.tools ?? []).map(t => t.name)))
const allToolNames = new Set(allToolSets.flatMap(s => [...s]))
console.log('\n=== Tool Differences ===')
for (const toolName of [...allToolNames].sort()) {
  const present = bodies.filter((b, i) => allToolSets[i].has(toolName)).map(b => b.version)
  const absent = bodies.filter((b, i) => !allToolSets[i].has(toolName)).map(b => b.version)
  if (absent.length > 0) {
    console.log(`"${toolName}": present in [${present.join(', ')}], absent in [${absent.join(', ')}]`)
  }
}

// Compare tool schemas between versions
console.log('\n=== Tool Schema Differences ===')
for (const toolName of [...allToolNames].sort()) {
  const schemas = bodies
    .map(b => {
      const tool = (b.json.tools ?? []).find(t => t.name === toolName)
      return tool ? { version: b.version, schema: JSON.stringify(tool) } : null
    })
    .filter(Boolean)

  const unique = new Map()
  for (const s of schemas) {
    const existing = [...unique.entries()].find(([_, schema]) => schema === s.schema)
    if (existing) {
      existing[0].push(s.version)
    } else {
      unique.set([s.version], s.schema)
    }
  }

  if (unique.size > 1) {
    console.log(`"${toolName}": ${unique.size} variants`)
    for (const [versions, schema] of unique) {
      console.log(`  [${versions.join(', ')}]: ${schema.length} chars`)
    }
  }
}

// Compare messages
console.log('\n=== Messages ===')
for (const { version, json } of bodies) {
  const messages = json.messages ?? []
  console.log(`v${version}: ${messages.length} messages`)
  for (const msg of messages) {
    const contentLen = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length
    console.log(`  role=${msg.role}, content length=${contentLen}`)
  }
}

// Compare system prompt blocks in detail
console.log('\n=== System Prompt Block Comparison ===')
const baseline = bodies[0]
for (const other of bodies.slice(1)) {
  const baseSystem = baseline.json.system ?? []
  const otherSystem = other.json.system ?? []

  if (baseSystem.length !== otherSystem.length) {
    console.log(`v${baseline.version} vs v${other.version}: different block count (${baseSystem.length} vs ${otherSystem.length})`)
    continue
  }

  let diffs = 0
  for (let i = 0; i < baseSystem.length; i++) {
    const a = JSON.stringify(baseSystem[i])
    const b = JSON.stringify(otherSystem[i])
    if (a !== b) {
      diffs++
      // Show first 200 chars of diff
      const aText = typeof baseSystem[i] === 'string' ? baseSystem[i] : baseSystem[i].text ?? ''
      const bText = typeof otherSystem[i] === 'string' ? otherSystem[i] : otherSystem[i].text ?? ''
      if (aText.length !== bText.length) {
        console.log(`v${baseline.version} vs v${other.version}: block[${i}] length diff ${aText.length} vs ${bText.length}`)
      } else {
        // Find first diff position
        for (let j = 0; j < aText.length; j++) {
          if (aText[j] !== bText[j]) {
            console.log(`v${baseline.version} vs v${other.version}: block[${i}] differs at pos ${j}: "${aText.slice(Math.max(0, j - 20), j + 50)}" vs "${bText.slice(Math.max(0, j - 20), j + 50)}"`)
            break
          }
        }
      }
    }
  }
  if (diffs === 0) {
    console.log(`v${baseline.version} vs v${other.version}: system prompts identical`)
  }
}

// Full body hash comparison
console.log('\n=== Body Hash (minus dynamic fields) ===')
for (const { version, json } of bodies) {
  // Remove potentially dynamic fields for comparison
  const { messages, ...rest } = json
  const stableStr = JSON.stringify(rest)
  const crypto = await import('node:crypto')
  const hash = crypto.createHash('sha256').update(stableStr).digest('hex').slice(0, 16)
  console.log(`v${version}: stable-body-hash=${hash}, stable-body-size=${stableStr.length}`)
}
