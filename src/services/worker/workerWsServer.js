const { WebSocketServer } = require('ws')
const url = require('url')
const logger = require('../../utils/logger')
const workerService = require('./workerService')

/**
 * Worker WebSocket Server
 *
 * 挂载到现有 HTTP Server 的 /ws/worker 路径。
 * Worker 主动连接 Hub，Hub 分发任务。
 *
 * 协议：JSON 消息，type 字段区分消息类型。
 *
 * 心跳配置：
 * - Worker 心跳间隔: 25s (worker/index.js: heartbeatInterval)
 * - Hub 检测间隔: 30s (本文件: HEARTBEAT_INTERVAL)
 * - Hub 超时阈值: 90s (本文件: HEARTBEAT_TIMEOUT, 3次检测未响应)
 * - Worker 间隔需小于 Hub 检测间隔，确保 Hub 能稳定收到心跳
 */

const HEARTBEAT_INTERVAL = 30000 // 30s - Hub 每 30s 检测一次心跳
const HEARTBEAT_TIMEOUT = 90000 // 90s - 3 次检测未收到心跳 → 断开 Worker

class WorkerWsServer {
  constructor() {
    this.wss = null
    this.heartbeatTimer = null
  }

  /**
   * 挂载到已有的 HTTP Server
   */
  attach(httpServer) {
    this.wss = new WebSocketServer({
      noServer: true
    })

    // HTTP upgrade 拦截
    httpServer.on('upgrade', (request, socket, head) => {
      const { pathname, query: queryStr } = url.parse(request.url, true)

      if (pathname === '/ws/worker') {
        this._handleUpgrade(request, socket, head, queryStr)
      } else {
        // 非 Worker WS 路径，拒绝升级
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
      }
    })

    // 启动心跳检测
    this._startHeartbeatCheck()

    logger.info('🔌 Worker WebSocket Server attached to /ws/worker')
  }

  /**
   * 处理 WebSocket upgrade
   */
  async _handleUpgrade(request, socket, head, query) {
    const { token } = query
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    try {
      const worker = await workerService.authenticateByToken(token)
      if (!worker) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this._onConnection(ws, worker, request)
      })
    } catch (err) {
      logger.error('Worker auth error:', err.message)
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
  }

  /**
   * 新 Worker 连接
   */
  _onConnection(ws, worker, request) {
    const ip =
      request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      request.socket.remoteAddress ||
      ''

    // 注册在线
    workerService.registerOnline(worker.id, ws, ip)

    // 发送认证成功
    this._send(ws, {
      type: 'auth_ok',
      data: { workerId: worker.id, name: worker.name }
    })

    // 标记最后活跃时间（用于心跳检测）
    ws._lastPong = Date.now()
    ws._workerId = worker.id

    // 消息处理
    ws.on('message', (data) => {
      this._onMessage(ws, worker.id, data)
    })

    // 断开处理
    ws.on('close', (code, reason) => {
      logger.info(`Worker WS closed: ${worker.id} code=${code} reason=${reason}`)
      workerService.registerOffline(worker.id)
    })

    ws.on('error', (err) => {
      logger.warn(`Worker WS error: ${worker.id} — ${err.message}`)
    })

    // pong 响应（用于心跳检测）
    ws.on('pong', () => {
      ws._lastPong = Date.now()
    })
  }

  /**
   * 处理 Worker 发来的消息
   */
  _onMessage(ws, workerId, raw) {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      logger.warn(`Invalid JSON from worker ${workerId}`)
      return
    }

    switch (msg.type) {
      case 'heartbeat':
        this._handleHeartbeat(ws, workerId, msg)
        break

      case 'response':
      case 'stream_start':
      case 'stream_data':
      case 'stream_end':
      case 'request_error':
        this._handleRequestMessage(workerId, msg)
        break

      default:
        logger.debug(`Unknown message type from worker ${workerId}: ${msg.type}`)
    }
  }

  /**
   * 心跳处理
   *
   * 以 Hub 端的 pendingRequests.size 为准，覆盖 Worker 上报的 currentLoad。
   * 这样可以确保负载计数始终准确，不受 Worker 端计数器漂移影响。
   */
  _handleHeartbeat(ws, workerId, _msg) {
    const conn = workerService.getConnection(workerId)
    // 使用 Hub 端实际的 pending 请求数量，而不是 Worker 上报的
    const actualLoad = conn ? conn.pendingRequests.size : 0
    workerService.heartbeat(workerId, { currentLoad: actualLoad })
    this._send(ws, { type: 'heartbeat_ack' })
  }

  /**
   * 请求响应消息 → 路由到 pending request
   */
  _handleRequestMessage(workerId, msg) {
    const conn = workerService.getConnection(workerId)
    if (!conn) {
      return
    }

    const requestId = msg.id
    if (!requestId) {
      return
    }

    const pending = conn.pendingRequests.get(requestId)
    if (!pending) {
      logger.debug(`No pending request for ${requestId} from worker ${workerId}`)
      return
    }

    switch (msg.type) {
      case 'response':
        // 非流式响应：一次性返回
        clearTimeout(pending.timeout)
        conn.pendingRequests.delete(requestId)
        workerService.decrLoad(workerId)
        pending.resolve(msg.data)
        break

      case 'stream_start':
        // 流式开始：触发 onStreamStart 回调
        if (pending.onStreamStart) {
          pending.onStreamStart(msg.data)
        }
        break

      case 'stream_data':
        // 流式数据：触发 onStreamData 回调
        if (pending.onStreamData) {
          pending.onStreamData(msg.data)
        }
        break

      case 'stream_end':
        // 流式结束
        clearTimeout(pending.timeout)
        conn.pendingRequests.delete(requestId)
        workerService.decrLoad(workerId)
        if (pending.onStreamEnd) {
          pending.onStreamEnd(msg.data)
        }
        pending.resolve(msg.data)
        break

      case 'request_error':
        // 请求失败
        clearTimeout(pending.timeout)
        conn.pendingRequests.delete(requestId)
        workerService.decrLoad(workerId)
        pending.resolve(msg.data) // resolve with error data, let caller handle
        break
    }
  }

  /**
   * 向 Worker 发送任务请求
   *
   * @param {string} workerId
   * @param {object} task - { accountId, credentials, upstream, stream }
   * @param {object} options - { timeout, onStreamStart, onStreamData, onStreamEnd }
   * @returns {Promise<object>} 响应数据
   */
  sendRequest(workerId, task, options = {}) {
    const conn = workerService.getConnection(workerId)
    if (!conn) {
      return Promise.reject(new Error(`Worker ${workerId} not online`))
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const timeoutMs = options.timeout || 600000 // 10 min default

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 通知 Worker 取消请求（中断 HTTP 请求）
        this._send(conn.ws, {
          type: 'cancel_request',
          id: requestId,
          data: { reason: 'timeout' }
        })
        conn.pendingRequests.delete(requestId)
        workerService.decrLoad(workerId)
        reject(new Error(`Worker request timeout: ${requestId}`))
      }, timeoutMs)

      conn.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout: timer,
        onStreamStart: options.onStreamStart,
        onStreamData: options.onStreamData,
        onStreamEnd: options.onStreamEnd
      })

      workerService.incrLoad(workerId)

      this._send(conn.ws, {
        type: 'request',
        id: requestId,
        data: task
      })
    })
  }

  /**
   * 发送 JSON 消息到 WebSocket
   */
  _send(ws, msg) {
    if (ws.readyState === 1) {
      // OPEN
      ws.send(JSON.stringify(msg))
    }
  }

  /**
   * 心跳检测定时器
   */
  _startHeartbeatCheck() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.wss) {
        return
      }

      this.wss.clients.forEach((ws) => {
        if (ws._lastPong && Date.now() - ws._lastPong > HEARTBEAT_TIMEOUT) {
          // 3 次心跳未响应，断开
          logger.warn(`Worker ${ws._workerId} heartbeat timeout, closing`)
          ws.terminate()
          return
        }
        // 发送 ping
        if (ws.readyState === 1) {
          ws.ping()
        }
      })
    }, HEARTBEAT_INTERVAL)
  }

  /**
   * 关闭
   */
  close() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
  }
}

module.exports = new WorkerWsServer()
