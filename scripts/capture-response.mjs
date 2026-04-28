#!/usr/bin/env node
import { createServer, request as httpRequest } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'

const PORT = 9998
const RELAY_HOST = '127.0.0.1'
const RELAY_PORT = 3560
const OUTPUT_DIR = path.resolve('scripts/captured-responses')
mkdirSync(OUTPUT_DIR, { recursive: true })

let requestCounter = 0

const server = createServer((clientReq, clientRes) => {
  const chunks = []
  clientReq.on('data', (chunk) => chunks.push(chunk))
  clientReq.on('end', () => {
    const requestBody = Buffer.concat(chunks)
    const ua = clientReq.headers['user-agent'] ?? 'unknown'
    const versionMatch = ua.match(/claude-cli\/(\d+\.\d+\.\d+)/)
    const version = versionMatch ? versionMatch[1] : 'unknown'
    const method = clientReq.method
    const urlPath = clientReq.url

    requestCounter++
    const reqId = `${version}_${requestCounter}`

    console.log(`[${reqId}] ${method} ${urlPath} reqBody=${requestBody.length} bytes`)

    // Remove accept-encoding to get uncompressed response; also strip gzip from template
    const fwdHeaders = { ...clientReq.headers, host: `${RELAY_HOST}:${RELAY_PORT}` }
    delete fwdHeaders['accept-encoding']

    const proxyReq = httpRequest({
      hostname: RELAY_HOST,
      port: RELAY_PORT,
      path: urlPath,
      method,
      headers: fwdHeaders,
    }, (proxyRes) => {
      const responseChunks = []
      proxyRes.on('data', (chunk) => responseChunks.push(chunk))
      proxyRes.on('end', () => {
        let responseBody = Buffer.concat(responseChunks)

        // Decompress if still gzipped
        if (proxyRes.headers['content-encoding'] === 'gzip') {
          try { responseBody = gunzipSync(responseBody) } catch {}
        }

        console.log(`[${reqId}] <- ${proxyRes.statusCode} resBody=${responseBody.length} bytes`)

        if (urlPath.includes('/v1/messages')) {
          const safeUrl = urlPath.replace(/[^a-zA-Z0-9]/g, '_')
          const prefix = `v${version}__${method}${safeUrl}`

          writeFileSync(path.join(OUTPUT_DIR, `${prefix}__request.json`), requestBody)
          writeFileSync(path.join(OUTPUT_DIR, `${prefix}__response.txt`), responseBody)
          writeFileSync(path.join(OUTPUT_DIR, `${prefix}__response_headers.json`),
            JSON.stringify({ statusCode: proxyRes.statusCode, headers: proxyRes.headers }, null, 2))

          console.log(`[${reqId}] Saved to ${prefix}__*.{json,txt}`)
        }

        // Forward original (possibly compressed) response back
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers)
        clientRes.end(Buffer.concat(responseChunks))
      })
    })

    proxyReq.on('error', (err) => {
      console.error(`[${reqId}] Proxy error: ${err.message}`)
      clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: 'proxy_error', message: err.message }))
    })

    proxyReq.end(requestBody)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Capture response proxy listening on http://127.0.0.1:${PORT}`)
  console.log(`Forwarding to relay at http://${RELAY_HOST}:${RELAY_PORT}`)
})
