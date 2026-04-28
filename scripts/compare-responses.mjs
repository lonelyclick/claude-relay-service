#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = path.resolve('scripts/captured-responses')
const files = readdirSync(DIR)
  .filter(f => f.endsWith('__response.txt'))
  .sort()

console.log('='.repeat(70))
console.log('RESPONSE COMPARISON')
console.log('='.repeat(70))

const responses = files.map(file => {
  const raw = readFileSync(path.join(DIR, file), 'utf8')
  const version = file.match(/v([\d.]+)/)?.[1] ?? 'unknown'
  return { version, raw, file }
})

// Parse SSE events
function parseSSE(text) {
  const events = []
  let currentEvent = {}
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent.event = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      try {
        currentEvent.data = JSON.parse(line.slice(6))
      } catch {
        currentEvent.data = line.slice(6)
      }
      events.push(currentEvent)
      currentEvent = {}
    }
  }
  return events
}

// Compare all responses
console.log('\n## Response sizes')
for (const r of responses) {
  console.log(`  v${r.version}: ${r.raw.length} bytes`)
}

console.log('\n## SSE event types')
for (const r of responses) {
  const events = parseSSE(r.raw)
  console.log(`  v${r.version}: ${events.map(e => e.event).join(', ')}`)
}

console.log('\n## message_start event')
for (const r of responses) {
  const events = parseSSE(r.raw)
  const msgStart = events.find(e => e.event === 'message_start')
  if (!msgStart) { console.log(`  v${r.version}: NOT FOUND`); continue }
  const msg = msgStart.data.message
  console.log(`  v${r.version}: model=${msg.model}, usage=${JSON.stringify(msg.usage)}`)
}

console.log('\n## message_delta event (final usage + stop)')
for (const r of responses) {
  const events = parseSSE(r.raw)
  const msgDelta = events.find(e => e.event === 'message_delta')
  if (!msgDelta) { console.log(`  v${r.version}: NOT FOUND`); continue }
  const { delta, usage, context_management } = msgDelta.data
  console.log(`  v${r.version}:`)
  console.log(`    delta: ${JSON.stringify(delta)}`)
  console.log(`    usage: ${JSON.stringify(usage)}`)
  console.log(`    context_management: ${JSON.stringify(context_management)}`)
}

console.log('\n## content_block_delta (actual response text)')
for (const r of responses) {
  const events = parseSSE(r.raw)
  const textDeltas = events.filter(e => e.event === 'content_block_delta')
  const fullText = textDeltas.map(e => e.data?.delta?.text ?? '').join('')
  console.log(`  v${r.version}: "${fullText}"`)
}

// Full structural diff: compare event-by-event
console.log('\n## Structural diff vs v2.1.98')
const targetEvents = parseSSE(responses.find(r => r.version === '2.1.98').raw)

for (const r of responses) {
  if (r.version === '2.1.98') continue
  const events = parseSSE(r.raw)

  console.log(`\n  --- v${r.version} vs v2.1.98 ---`)

  if (events.length !== targetEvents.length) {
    console.log(`    event count: ${events.length} vs ${targetEvents.length}`)
  }

  for (let i = 0; i < Math.max(events.length, targetEvents.length); i++) {
    const a = events[i]
    const b = targetEvents[i]
    if (!a) { console.log(`    [${i}] MISSING in v${r.version}: ${b.event}`); continue }
    if (!b) { console.log(`    [${i}] EXTRA in v${r.version}: ${a.event}`); continue }
    if (a.event !== b.event) {
      console.log(`    [${i}] event type: ${a.event} vs ${b.event}`)
      continue
    }

    const aStr = JSON.stringify(a.data)
    const bStr = JSON.stringify(b.data)
    if (aStr === bStr) continue

    // Find what changed
    if (a.event === 'message_start') {
      const aMsg = a.data.message
      const bMsg = b.data.message
      const fields = new Set([...Object.keys(aMsg), ...Object.keys(bMsg)])
      for (const f of fields) {
        const av = JSON.stringify(aMsg[f])
        const bv = JSON.stringify(bMsg[f])
        if (av !== bv) {
          console.log(`    [${i}] message_start.message.${f}:`)
          if (f === 'usage') {
            // Compare usage fields
            const aUsage = aMsg[f] ?? {}
            const bUsage = bMsg[f] ?? {}
            const usageFields = new Set([...Object.keys(aUsage), ...Object.keys(bUsage)])
            for (const uf of usageFields) {
              const uav = JSON.stringify(aUsage[uf])
              const ubv = JSON.stringify(bUsage[uf])
              if (uav !== ubv) {
                console.log(`      .${uf}: ${uav} vs ${ubv}`)
              }
            }
          } else {
            console.log(`      ${av?.slice(0, 100)} vs ${bv?.slice(0, 100)}`)
          }
        }
      }
    } else if (a.event === 'message_delta') {
      const fields = new Set([...Object.keys(a.data), ...Object.keys(b.data)])
      for (const f of fields) {
        const av = JSON.stringify(a.data[f])
        const bv = JSON.stringify(b.data[f])
        if (av !== bv) {
          console.log(`    [${i}] message_delta.${f}:`)
          if (f === 'usage') {
            const aUsage = a.data[f] ?? {}
            const bUsage = b.data[f] ?? {}
            const usageFields = new Set([...Object.keys(aUsage), ...Object.keys(bUsage)])
            for (const uf of usageFields) {
              const uav = JSON.stringify(aUsage[uf])
              const ubv = JSON.stringify(bUsage[uf])
              if (uav !== ubv) {
                console.log(`      .${uf}: ${uav} vs ${ubv}`)
              }
            }
          } else {
            console.log(`      ${av?.slice(0, 200)}`)
            console.log(`      ${bv?.slice(0, 200)}`)
          }
        }
      }
    } else {
      console.log(`    [${i}] ${a.event}: DIFFERS`)
      console.log(`      v${r.version}: ${aStr.slice(0, 150)}`)
      console.log(`      v2.1.98:  ${bStr.slice(0, 150)}`)
    }
  }
}

// Check response headers differences
console.log('\n\n## Response Headers Comparison')
const headerFiles = readdirSync(DIR).filter(f => f.endsWith('__response_headers.json')).sort()
const headerData = headerFiles.map(f => {
  const json = JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))
  const version = f.match(/v([\d.]+)/)?.[1] ?? 'unknown'
  return { version, ...json }
})

// Compare header keys across versions
const allHeaderKeys = new Set(headerData.flatMap(h => Object.keys(h.headers)))
const varyingHeaders = []
for (const key of [...allHeaderKeys].sort()) {
  const values = headerData.map(h => h.headers[key])
  const unique = new Set(values.map(v => JSON.stringify(v)))
  if (unique.size > 1) {
    varyingHeaders.push(key)
  }
}
console.log(`  Headers that vary across versions: ${varyingHeaders.join(', ')}`)
for (const key of varyingHeaders) {
  // Skip obviously dynamic headers
  if (['date', 'set-cookie', 'cf-ray', 'request-id', 'x-envoy-upstream-service-time',
       'server-timing', 'content-length', 'transfer-encoding'].includes(key)) continue
  console.log(`  ${key}:`)
  for (const h of headerData) {
    console.log(`    v${h.version}: ${JSON.stringify(h.headers[key])}`)
  }
}
