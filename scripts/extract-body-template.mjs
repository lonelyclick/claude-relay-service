#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const bodyPath = path.resolve('scripts/captured-bodies/v2.1.98__POST_v1_messages_beta_true.json')
const headersPath = bodyPath.replace('.json', '.headers.json')

const body = JSON.parse(readFileSync(bodyPath, 'utf8'))
const headersData = JSON.parse(readFileSync(headersPath, 'utf8'))

const system = body.system
const ccMatch = (typeof system[0] === 'string' ? system[0] : system[0].text).match(/cc_version=([\d.]+\.\w+)/)
const entrypointMatch = (typeof system[0] === 'string' ? system[0] : system[0].text).match(/cc_entrypoint=(\S+?)(?=;|\s|$)/)

// Extract anthropic-beta from captured headers
let anthropicBeta = null
const rawHeaders = headersData.headers ?? []
for (let i = 0; i < rawHeaders.length - 1; i += 2) {
  if (rawHeaders[i].toLowerCase() === 'anthropic-beta') {
    anthropicBeta = rawHeaders[i + 1]
    break
  }
}

const metadata = body.metadata ?? {}
let deviceId = null
let accountUuid = null
try {
  const userId = JSON.parse(metadata.user_id ?? '{}')
  deviceId = userId.device_id ?? null
  accountUuid = userId.account_uuid ?? null
} catch {}

const template = {
  ccVersion: ccMatch[1],
  ...(entrypointMatch ? { ccEntrypoint: entrypointMatch[1] } : {}),
  ...(anthropicBeta ? { anthropicBeta } : {}),
  systemBlocks: system.slice(1).map(block => ({
    type: block.type,
    ...(block.cache_control ? { cache_control: block.cache_control } : {}),
    text: block.text,
  })),
  tools: body.tools,
  deviceId,
  accountUuid,
}

const outPath = path.resolve('data/v2.1.98-body-template.json')
writeFileSync(outPath, JSON.stringify(template, null, 2))

console.log(`Extracted template to ${outPath}`)
console.log(`  ccVersion: ${template.ccVersion}`)
console.log(`  systemBlocks: ${template.systemBlocks.length} blocks`)
for (let i = 0; i < template.systemBlocks.length; i++) {
  const b = template.systemBlocks[i]
  console.log(`    [${i}] type=${b.type}, cache_control=${JSON.stringify(b.cache_control ?? null)}, text=${b.text.length} chars`)
}
console.log(`  tools: ${template.tools.length} tools (${template.tools.map(t => t.name).join(', ')})`)
console.log(`  anthropicBeta: ${template.anthropicBeta ?? '(not found)'}`)
console.log(`  deviceId: ${template.deviceId}`)
console.log(`  accountUuid: ${template.accountUuid}`)
console.log(`  file size: ${JSON.stringify(template).length} bytes`)
