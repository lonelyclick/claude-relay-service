#!/usr/bin/env node

/**
 * Claude Relay Worker
 *
 * 轻量级 Worker 节点，通过 WebSocket 连接到 Hub（中心服务），
 * 接收 HTTP 请求任务并执行，将响应流回 Hub。
 *
 * 使用方式：
 *   HUB_URL=wss://relay.example.com WORKER_TOKEN=wrk_xxx node index.js
 *
 * 环境变量：
 *   HUB_URL        - Hub 的 WebSocket 地址（如 ws://localhost:3000 或 wss://relay.example.com）
 *   WORKER_TOKEN   - Worker 认证 Token（从 Hub 管理后台创建 Worker 时获取）
 *   LOG_LEVEL      - 日志级别：debug, info, warn, error（默认 info）
 */

const WebSocket = require('ws')
const https = require('https')
const http = require('http')
const zlib = require('zlib')

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  hubUrl: process.env.HUB_URL || 'ws://localhost:3000',
  workerToken: process.env.WORKER_TOKEN || '',
  // Worker 心跳间隔（需小于 Hub 检测间隔，确保 Hub 能收到心跳）
  // Hub 配置: 检测间隔 30s, 超时阈值 90s (3次)
  heartbeatInterval: 25000, // 25s - Worker 每 25s 发一次心跳
  reconnectDelay: 3000, // 重连延迟
  maxReconnectDelay: 60000, // 最大重连延迟
  logLevel: process.env.LOG_LEVEL || 'info'
}

// ============================================================
// 日志
// ============================================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? 1

const log = {
  debug: (...args) =>
    currentLevel <= 0 && console.log('[DEBUG]', new Date().toISOString(), ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', new Date().toISOString(), ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', new Date().toISOString(), ...args),
  error: (...args) =>
    currentLevel <= 3 && console.error('[ERROR]', new Date().toISOString(), ...args)
}

// ============================================================
// Worker WebSocket 客户端
// ============================================================

class WorkerClient {
  constructor() {
    this.ws = null
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.reconnectDelay = CONFIG.reconnectDelay
    this.currentLoad = 0
    this.isShuttingDown = false
    this.workerId = null
    this.workerName = null
    this.activeRequests = new Map() // requestId → { req } for aborting on WS disconnect
  }

  start() {
    if (!CONFIG.workerToken) {
      log.error('WORKER_TOKEN is required. Set it via environment variable.')
      process.exit(1)
    }
    this._connect()
    this._setupGracefulShutdown()
  }

  // ============================================================
  // WebSocket 连接
  // ============================================================

  _connect() {
    const wsUrl = `${CONFIG.hubUrl}/ws/worker?token=${encodeURIComponent(CONFIG.workerToken)}`
    log.info(`Connecting to Hub: ${CONFIG.hubUrl}/ws/worker`)

    this.ws = new WebSocket(wsUrl)

    this.ws.on('open', () => {
      log.info('WebSocket connected, waiting for auth...')
      this.reconnectDelay = CONFIG.reconnectDelay // 重置重连延迟
    })

    this.ws.on('message', (data) => {
      this._onMessage(data)
    })

    this.ws.on('close', (code, reason) => {
      log.warn(`WebSocket closed: code=${code} reason=${reason}`)
      this._stopHeartbeat()
      // 中断所有进行中的 HTTP 请求（避免资源泄漏）
      for (const [reqId, entry] of this.activeRequests) {
        log.warn(`[${reqId}] Aborting HTTP request due to WS disconnect`)
        try {
          entry.req.destroy()
        } catch (_err) {
          // ignore
        }
      }
      this.activeRequests.clear()
      // 注意：不手动调整 currentLoad，让请求的 finally 块自然减计数
      // 重连后会在 auth_ok 中重置 currentLoad = 0，确保计数准确
      if (!this.isShuttingDown) {
        this._scheduleReconnect()
      }
    })

    this.ws.on('error', (err) => {
      log.error('WebSocket error:', err.message)
    })

    this.ws.on('pong', () => {
      log.debug('Received pong from Hub')
    })
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) {
      return
    }
    log.info(`Reconnecting in ${this.reconnectDelay / 1000}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, CONFIG.maxReconnectDelay)
      this._connect()
    }, this.reconnectDelay)
  }

  // ============================================================
  // 消息处理
  // ============================================================

  _onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      log.warn('Invalid JSON from Hub')
      return
    }

    switch (msg.type) {
      case 'auth_ok':
        this.workerId = msg.data?.workerId
        this.workerName = msg.data?.name
        // 重置 currentLoad 为 0（避免重连后计数不一致）
        this.currentLoad = 0
        log.info(`Authenticated as: ${this.workerName} (${this.workerId})`)
        this._startHeartbeat()
        break

      case 'heartbeat_ack':
        log.debug('Heartbeat acknowledged')
        break

      case 'request':
        this._handleRequest(msg.id, msg.data)
        break

      case 'cancel_request':
        this._handleCancelRequest(msg.id, msg.data)
        break

      default:
        log.debug(`Unknown message type: ${msg.type}`)
    }
  }

  /**
   * 处理 Hub 发来的取消请求（超时或主动取消）
   * 中断正在执行的 HTTP 请求
   */
  _handleCancelRequest(requestId, data) {
    const entry = this.activeRequests.get(requestId)
    if (entry) {
      log.info(`[${requestId}] Request cancelled by Hub: ${data.reason || 'unknown'}`)
      try {
        entry.req.destroy()
      } catch (_err) {
        // ignore
      }
      // 标记为已取消，避免后续处理
      entry.cancelled = true
      this.activeRequests.delete(requestId)
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  // ============================================================
  // 心跳
  // ============================================================

  _startHeartbeat() {
    this._stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this._send({
        type: 'heartbeat',
        data: { currentLoad: this.currentLoad }
      })
    }, CONFIG.heartbeatInterval)
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // ============================================================
  // 请求处理
  // ============================================================

  async _handleRequest(requestId, task) {
    if (!requestId || !task) {
      return
    }

    this.currentLoad++
    let loadDecremented = false // 防止重复减计数
    log.info(`[${requestId}] Processing request: ${task.method} ${task.url} stream=${task.stream}`)

    try {
      if (task.stream) {
        await this._handleStreamRequest(requestId, task)
      } else {
        await this._handleNonStreamRequest(requestId, task)
      }
    } catch (err) {
      log.error(`[${requestId}] Request failed:`, err.message)
      this._send({
        type: 'request_error',
        id: requestId,
        data: { error: err.message, statusCode: 500 }
      })
    } finally {
      // 防御性检查：避免在 WebSocket 断开后重复减计数
      if (!loadDecremented && this.currentLoad > 0) {
        this.currentLoad--
        loadDecremented = true
      }
    }
  }

  /**
   * 非流式请求：发出 HTTPS 请求，等待完整响应，一次性返回
   */
  async _handleNonStreamRequest(requestId, task) {
    const result = await this._makeHttpRequest(requestId, task)

    this._send({
      type: 'response',
      id: requestId,
      data: {
        statusCode: result.statusCode,
        headers: result.headers,
        body: result.body
      }
    })

    log.info(`[${requestId}] Response sent: ${result.statusCode}`)
  }

  /**
   * 流式请求：发出 HTTPS 请求，逐块流回 Hub
   */
  async _handleStreamRequest(requestId, task) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(task.url)
      const isHttps = parsed.protocol === 'https:'
      const transport = isHttps ? https : http

      const headers = { ...(task.headers || {}) }
      // 用 task.body 计算 content-length（如果是字符串）
      const bodyStr = typeof task.body === 'string' ? task.body : JSON.stringify(task.body)
      headers['content-length'] = String(Buffer.byteLength(bodyStr, 'utf8'))

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: task.method || 'POST',
        headers,
        timeout: 600000 // 10 min
      }

      const req = transport.request(options, (res) => {
        // 检查是否已被取消
        const entry = this.activeRequests.get(requestId)
        if (entry?.cancelled) {
          log.debug(`[${requestId}] Request already cancelled, ignoring response`)
          resolve()
          return
        }

        // stream_start：通知 Hub 响应头
        this._send({
          type: 'stream_start',
          id: requestId,
          data: {
            statusCode: res.statusCode,
            headers: res.headers
          }
        })

        res.on('data', (chunk) => {
          // 检查是否已被取消（避免发送无用数据）
          const entry = this.activeRequests.get(requestId)
          if (entry?.cancelled) {
            return
          }
          // stream_data：逐块发送
          this._send({
            type: 'stream_data',
            id: requestId,
            data: {
              chunk: chunk.toString('base64'),
              encoding: 'base64'
            }
          })
        })

        res.on('end', () => {
          this.activeRequests.delete(requestId)
          // stream_end
          this._send({
            type: 'stream_end',
            id: requestId,
            data: {}
          })
          log.info(`[${requestId}] Stream ended: ${res.statusCode}`)
          resolve()
        })

        res.on('error', (err) => {
          this.activeRequests.delete(requestId)
          log.error(`[${requestId}] Response stream error:`, err.message)
          this._send({
            type: 'request_error',
            id: requestId,
            data: { error: err.message, statusCode: 502 }
          })
          reject(err)
        })
      })

      // 注册到 activeRequests 以便 WS 断开时中断
      this.activeRequests.set(requestId, { req })

      req.on('error', (err) => {
        this.activeRequests.delete(requestId)
        log.error(`[${requestId}] Request error:`, err.message)
        this._send({
          type: 'request_error',
          id: requestId,
          data: { error: err.message, statusCode: 502 }
        })
        reject(err)
      })

      req.on('timeout', () => {
        this.activeRequests.delete(requestId)
        req.destroy()
        const err = new Error('Request timeout')
        this._send({
          type: 'request_error',
          id: requestId,
          data: { error: err.message, statusCode: 504 }
        })
        reject(err)
      })

      req.write(bodyStr)
      req.end()
    })
  }

  /**
   * 非流式 HTTP 请求辅助方法
   */
  _makeHttpRequest(requestId, task) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(task.url)
      const isHttps = parsed.protocol === 'https:'
      const transport = isHttps ? https : http

      const headers = { ...(task.headers || {}) }
      const bodyStr = typeof task.body === 'string' ? task.body : JSON.stringify(task.body)
      headers['content-length'] = String(Buffer.byteLength(bodyStr, 'utf8'))

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: task.method || 'POST',
        headers,
        timeout: 600000
      }

      const req = transport.request(options, (res) => {
        const chunks = []

        res.on('data', (chunk) => chunks.push(chunk))

        res.on('end', () => {
          this.activeRequests.delete(requestId)
          const raw = Buffer.concat(chunks)
          let body

          const encoding = res.headers['content-encoding']
          if (encoding === 'gzip') {
            try {
              body = zlib.gunzipSync(raw).toString('utf8')
            } catch {
              body = raw.toString('utf8')
            }
          } else if (encoding === 'deflate') {
            try {
              body = zlib.inflateSync(raw).toString('utf8')
            } catch {
              body = raw.toString('utf8')
            }
          } else {
            body = raw.toString('utf8')
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          })
        })

        res.on('error', (err) => {
          this.activeRequests.delete(requestId)
          reject(err)
        })
      })

      // 注册到 activeRequests 以便 WS 断开时中断
      this.activeRequests.set(requestId, { req })

      req.on('error', (err) => {
        this.activeRequests.delete(requestId)
        reject(err)
      })
      req.on('timeout', () => {
        this.activeRequests.delete(requestId)
        req.destroy()
        reject(new Error('Request timeout'))
      })

      req.write(bodyStr)
      req.end()
    })
  }

  // ============================================================
  // 优雅关闭
  // ============================================================

  _setupGracefulShutdown() {
    const shutdown = (signal) => {
      log.info(`Received ${signal}, shutting down...`)
      this.isShuttingDown = true
      this._stopHeartbeat()
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
      }
      if (this.ws) {
        this.ws.close(1000, 'Worker shutting down')
      }
      // 等待现有请求完成（最多 10 秒）
      const waitForIdle = () => {
        if (this.currentLoad === 0) {
          log.info('All requests completed. Bye!')
          process.exit(0)
        }
        log.info(`Waiting for ${this.currentLoad} pending requests...`)
      }
      waitForIdle()
      const interval = setInterval(waitForIdle, 1000)
      setTimeout(() => {
        clearInterval(interval)
        log.warn('Force shutdown after timeout')
        process.exit(1)
      }, 10000)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  }
}

// ============================================================
// 启动
// ============================================================

log.info('='.repeat(50))
log.info('Claude Relay Worker v1.0.0')
log.info(`Hub URL: ${CONFIG.hubUrl}`)
log.info(`Log level: ${CONFIG.logLevel}`)
log.info('='.repeat(50))

const worker = new WorkerClient()
worker.start()
