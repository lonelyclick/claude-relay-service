/**
 * HTTPS 代理：拦截并记录 droid CLI 发往 Factory.ai 的完整请求
 *
 * 用法：
 *   1. 生成自签证书：
 *      openssl req -x509 -newkey rsa:2048 -keyout proxy_key.pem -out proxy_cert.pem \
 *        -days 30 -nodes -subj '/CN=localhost'
 *
 *   2. 启动代理：
 *      node docs/factory-ai-compat/capture_proxy.mjs
 *
 *   3. 在另一个终端，通过代理运行 droid：
 *      FACTORY_API_BASE_URL=https://localhost:18765 \
 *      FACTORY_API_KEY=fk-... \
 *      NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *      droid exec "say ok"
 *
 * 原理：
 *   - droid 通过 FACTORY_API_BASE_URL 环境变量可以重定向 API 请求
 *   - 本代理接收请求、dump 完整 headers/body 到 JSON 文件，然后转发到真实 Factory.ai API
 *   - 响应也会被记录
 *
 * 抓包日期：2026-03-30（droid 0.89.0）
 */
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const PORT = 18765
const TARGET_HOST = 'api.factory.ai'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 证书文件路径（与脚本同目录，或 /tmp 下）
const keyPath = fs.existsSync(path.join(__dirname, 'proxy_key.pem'))
  ? path.join(__dirname, 'proxy_key.pem')
  : '/tmp/proxy_key.pem'
const certPath = fs.existsSync(path.join(__dirname, 'proxy_cert.pem'))
  ? path.join(__dirname, 'proxy_cert.pem')
  : '/tmp/proxy_cert.pem'

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('❌ 未找到证书文件。请先生成：')
  console.error('   openssl req -x509 -newkey rsa:2048 -keyout proxy_key.pem -out proxy_cert.pem -days 30 -nodes -subj \'/CN=localhost\'')
  process.exit(1)
}

const server = https.createServer({
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
}, (req, res) => {
  let body = ''
  req.on('data', chunk => body += chunk)
  req.on('end', () => {
    // 构造完整的请求 dump
    const dump = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: null,
      timestamp: new Date().toISOString()
    }

    try {
      dump.body = body ? JSON.parse(body) : null
    } catch {
      dump.body = body || null
    }

    const dumpPath = `/tmp/droid_request_${Date.now()}.json`
    fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2))

    console.log('\n' + '='.repeat(80))
    console.log(`📦 Captured request: ${req.method} ${req.url}`)
    console.log(`📁 Saved to: ${dumpPath}`)
    console.log('\n--- Headers ---')
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'authorization') {
        console.log(`  ${k}: ${String(v).slice(0, 20)}...`)
      } else {
        console.log(`  ${k}: ${v}`)
      }
    }

    if (dump.body && typeof dump.body === 'object') {
      console.log('\n--- Body summary ---')
      for (const [k, v] of Object.entries(dump.body)) {
        if (k === 'messages') {
          console.log(`  messages: [${v.length} messages]`)
          for (const msg of v) {
            const preview = typeof msg.content === 'string'
              ? msg.content.slice(0, 80)
              : JSON.stringify(msg.content).slice(0, 80)
            console.log(`    - ${msg.role}: ${preview}...`)
          }
        } else if (k === 'tools') {
          console.log(`  tools: [${v.length} tools]`)
          if (Array.isArray(v)) {
            for (const t of v) {
              console.log(`    - ${t.name}: type=${t.type || 'N/A'}`)
            }
          }
        } else if (k === 'system') {
          console.log(`  system: [${Array.isArray(v) ? v.length + ' blocks' : typeof v}]`)
          if (Array.isArray(v)) {
            for (const block of v) {
              console.log(`    - ${block.type}: ${(block.text || '').slice(0, 80)}...`)
            }
          }
        } else if (typeof v === 'object' && v !== null) {
          console.log(`  ${k}: ${JSON.stringify(v)}`)
        } else {
          console.log(`  ${k}: ${v}`)
        }
      }
    }
    console.log('='.repeat(80))

    // 转发到 Factory.ai
    const options = {
      hostname: TARGET_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: TARGET_HOST },
    }
    delete options.headers['transfer-encoding']

    const proxyReq = https.request(options, proxyRes => {
      console.log(`\n📨 Response: ${proxyRes.statusCode}`)

      let respBody = ''
      proxyRes.on('data', chunk => {
        respBody += chunk
        res.write(chunk)
      })
      proxyRes.on('end', () => {
        if (proxyRes.statusCode !== 200) {
          console.log(`Response body: ${respBody.slice(0, 500)}`)
        } else {
          console.log(`Response body length: ${respBody.length} chars`)
        }

        // 保存响应 dump
        const respDump = {
          status: proxyRes.statusCode,
          headers: proxyRes.headers,
          bodyLength: respBody.length,
          bodyPreview: respBody.slice(0, 2000),
        }
        fs.writeFileSync(dumpPath.replace('.json', '_response.json'), JSON.stringify(respDump, null, 2))

        res.end()
      })

      const respHeaders = { ...proxyRes.headers }
      delete respHeaders['transfer-encoding']
      res.writeHead(proxyRes.statusCode, respHeaders)
    })

    proxyReq.on('error', e => {
      console.error('Proxy error:', e.message)
      res.writeHead(502)
      res.end('Proxy error: ' + e.message)
    })

    if (body) proxyReq.write(body)
    proxyReq.end()
  })
})

server.listen(PORT, () => {
  console.log(`🔍 Droid capture proxy listening on https://localhost:${PORT}`)
  console.log(`\nUsage:`)
  console.log(`  FACTORY_API_BASE_URL=https://localhost:${PORT} \\`)
  console.log(`  FACTORY_API_KEY=fk-... \\`)
  console.log(`  NODE_TLS_REJECT_UNAUTHORIZED=0 \\`)
  console.log(`  droid exec "say ok"`)
})
