const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const logger = require('../../utils/logger')
const dal = require('../../models/dal')
const redis = require('../../models/redis')

/**
 * Worker 管理服务
 *
 * 负责 Worker 的 CRUD、Token 管理、在线状态跟踪。
 * 持久数据存 PG，在线连接状态存内存。
 */
class WorkerService {
  constructor() {
    // 在线 Worker 连接：Map<workerId, { ws, ip, currentLoad, connectedAt }>
    this.onlineWorkers = new Map()

    // Worker Token 前缀
    this.TOKEN_PREFIX = 'wrk_'
  }

  // ============================================================
  // Token 管理
  // ============================================================

  /**
   * 生成 Worker Token
   * 返回 { token, tokenHash }
   * token 只返回一次，之后只存 hash
   */
  generateToken() {
    const raw = crypto.randomBytes(32).toString('hex')
    const token = `${this.TOKEN_PREFIX}${raw}`
    const tokenHash = this._hashToken(token)
    return { token, tokenHash }
  }

  _hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex')
  }

  // ============================================================
  // CRUD
  // ============================================================

  /**
   * 创建 Worker
   * 返回 { worker, token } — token 只在创建时返回
   */
  async createWorker(options = {}) {
    const {
      name = '',
      type = 'remote',
      maxConcurrency = 10,
      region = '',
      metadata = {}
    } = options

    const id = uuidv4()
    const { token, tokenHash } = this.generateToken()

    await dal.workers.createWorker({
      id,
      name: name || `Worker-${id.slice(0, 8)}`,
      tokenHash,
      type,
      maxConcurrency,
      region,
      metadata
    })

    const worker = await dal.workers.getWorker(id)
    return { worker, token }
  }

  /**
   * 获取 Worker
   */
  async getWorker(workerId) {
    const worker = await dal.workers.getWorker(workerId)
    if (!worker) return null

    // 补充在线状态
    const online = this.onlineWorkers.get(workerId)
    if (online) {
      worker.status = 'online'
      worker.currentLoad = online.currentLoad || 0
      worker.connectedAt = online.connectedAt
    }
    return worker
  }

  /**
   * 获取全部 Worker
   */
  async getAllWorkers() {
    const workers = await dal.workers.getAllWorkers()
    for (const w of workers) {
      const online = this.onlineWorkers.get(w.id)
      if (online) {
        w.status = 'online'
        w.currentLoad = online.currentLoad || 0
        w.connectedAt = online.connectedAt
      }
    }
    return workers
  }

  /**
   * 更新 Worker
   */
  async updateWorker(workerId, fields) {
    await dal.workers.updateWorker(workerId, fields)
    return this.getWorker(workerId)
  }

  /**
   * 删除 Worker
   */
  async deleteWorker(workerId) {
    // 如果在线，先踢掉
    this.disconnectWorker(workerId, 'Worker deleted')
    // 清除绑定到此 Worker 的账号（PG + Redis）
    const boundAccounts = await dal.accounts.getAccountsByWorkerId(workerId)
    const { query } = require('../../models/pg')
    await query('UPDATE accounts SET worker_id = NULL WHERE worker_id = $1', [workerId])
    // 同步清除 Redis 中的 workerId 字段
    for (const acc of boundAccounts) {
      try {
        await redis.client.hdel(`claude:account:${acc.id}`, 'workerId')
      } catch (err) {
        logger.warn(`Failed to clear workerId in Redis for account ${acc.id}: ${err.message}`)
      }
    }
    await dal.workers.deleteWorker(workerId)
  }

  /**
   * 重新生成 Worker Token
   * 返回新 token（仅此一次）
   */
  async regenerateToken(workerId) {
    const { token, tokenHash } = this.generateToken()
    await dal.workers.updateWorker(workerId, { tokenHash })
    // 踢掉旧连接
    this.disconnectWorker(workerId, 'Token regenerated')
    return token
  }

  // ============================================================
  // 认证
  // ============================================================

  /**
   * 通过 Token 认证 Worker
   * 返回 worker 对象或 null
   */
  async authenticateByToken(token) {
    if (!token || !token.startsWith(this.TOKEN_PREFIX)) return null
    const tokenHash = this._hashToken(token)
    return dal.workers.getWorkerByTokenHash(tokenHash)
  }

  // ============================================================
  // 在线状态管理
  // ============================================================

  /**
   * Worker 上线
   */
  registerOnline(workerId, ws, ip) {
    // 如果已有连接，先关闭旧的
    const existing = this.onlineWorkers.get(workerId)
    if (existing && existing.ws !== ws) {
      try { existing.ws.close(4001, 'Replaced by new connection') } catch {}
    }

    this.onlineWorkers.set(workerId, {
      ws,
      ip,
      currentLoad: 0,
      connectedAt: new Date().toISOString(),
      pendingRequests: new Map() // requestId → { resolve, reject, timeout }
    })

    // 更新 PG 状态
    dal.workers.setWorkerOnline(workerId, ip).catch(err =>
      logger.warn(`Failed to update worker online status: ${err.message}`)
    )

    logger.info(`🟢 Worker online: ${workerId} (${ip})`)
  }

  /**
   * Worker 下线
   */
  registerOffline(workerId) {
    const online = this.onlineWorkers.get(workerId)
    if (online) {
      // 清理所有 pending requests
      for (const [reqId, pending] of online.pendingRequests) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('Worker disconnected'))
      }
      online.pendingRequests.clear()
      this.onlineWorkers.delete(workerId)
    }

    // 更新 PG 状态
    dal.workers.setWorkerOffline(workerId).catch(err =>
      logger.warn(`Failed to update worker offline status: ${err.message}`)
    )

    logger.info(`🔴 Worker offline: ${workerId}`)
  }

  /**
   * 强制断开 Worker
   */
  disconnectWorker(workerId, reason = 'Disconnected by server') {
    const online = this.onlineWorkers.get(workerId)
    if (online) {
      try { online.ws.close(4000, reason) } catch {}
      this.registerOffline(workerId)
    }
  }

  /**
   * 心跳
   */
  async heartbeat(workerId, data = {}) {
    const online = this.onlineWorkers.get(workerId)
    if (online && data.currentLoad !== undefined) {
      online.currentLoad = data.currentLoad
    }
    await dal.workers.heartbeat(workerId)
  }

  /**
   * 获取在线 Worker 列表
   */
  getOnlineWorkerIds() {
    return Array.from(this.onlineWorkers.keys())
  }

  /**
   * 检查 Worker 是否在线
   */
  isOnline(workerId) {
    return this.onlineWorkers.has(workerId)
  }

  /**
   * 获取 Worker 的 WebSocket 连接
   */
  getConnection(workerId) {
    return this.onlineWorkers.get(workerId)
  }

  /**
   * 选择一个可用的在线 Worker（负载均衡）
   * 优先选 currentLoad 最低的
   */
  selectAvailableWorker(excludeIds = []) {
    let bestId = null
    let bestLoad = Infinity

    for (const [id, conn] of this.onlineWorkers) {
      if (excludeIds.includes(id)) continue
      if (conn.currentLoad < bestLoad) {
        bestLoad = conn.currentLoad
        bestId = id
      }
    }

    return bestId
  }

  /**
   * 增减 Worker 负载计数
   */
  incrLoad(workerId) {
    const online = this.onlineWorkers.get(workerId)
    if (online) online.currentLoad++
  }

  decrLoad(workerId) {
    const online = this.onlineWorkers.get(workerId)
    if (online && online.currentLoad > 0) online.currentLoad--
  }
}

module.exports = new WorkerService()
