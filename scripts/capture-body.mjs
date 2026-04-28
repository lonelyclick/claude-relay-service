#!/usr/bin/env node
/**
 * Minimal capture proxy: saves the full request body from Claude Code
 * to a file named by the client version extracted from User-Agent.
 *
 * Usage:
 *   node scripts/capture-body.mjs
 *   # In another terminal:
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:9999 claude -p "say ok" --max-turns 1
 */
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const PORT = 9999
const OUTPUT_DIR = path.resolve('scripts/captured-bodies')
mkdirSync(OUTPUT_DIR, { recursive: true })

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const ua = req.headers['user-agent'] ?? 'unknown'
    const versionMatch = ua.match(/claude-cli\/(\d+\.\d+\.\d+)/)
    const version = versionMatch ? versionMatch[1] : 'unknown'
    const method = req.method
    const urlPath = req.url

    // Save body
    const safePathName = urlPath.replace(/[^a-zA-Z0-9]/g, '_')
    const filename = `v${version}__${method}${safePathName}.json`
    const filepath = path.join(OUTPUT_DIR, filename)
    writeFileSync(filepath, body)

    // Also save headers
    const headersFilepath = path.join(OUTPUT_DIR, `v${version}__${method}${safePathName}.headers.json`)
    writeFileSync(headersFilepath, JSON.stringify({
      method,
      url: urlPath,
      userAgent: ua,
      headers: req.rawHeaders,
    }, null, 2))

    console.log(`[${version}] ${method} ${urlPath} body=${body.length} bytes -> ${filename}`)

    // Return a minimal valid response so Claude Code doesn't retry
    if (urlPath.includes('/v1/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_capture',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }))
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Capture proxy listening on http://127.0.0.1:${PORT}`)
  console.log(`Output directory: ${OUTPUT_DIR}`)
  console.log('Press Ctrl+C to stop')
})
