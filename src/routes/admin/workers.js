/**
 * Admin Routes - Worker Management
 * Worker 节点管理路由
 */

const express = require('express')
const router = express.Router()
const workerService = require('../../services/worker/workerService')
const dal = require('../../models/dal')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')

// 获取所有 Workers
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const workers = await workerService.getAllWorkers()
    res.json({ success: true, data: workers })
  } catch (error) {
    logger.error('Failed to get workers:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 获取单个 Worker
router.get('/:id', authenticateAdmin, async (req, res) => {
  try {
    const worker = await workerService.getWorker(req.params.id)
    if (!worker) {
      return res.status(404).json({ success: false, error: 'Worker not found' })
    }

    // 附加绑定的账户列表
    const boundAccounts = await dal.accounts.getAccountsByWorkerId(req.params.id)
    worker.boundAccounts = boundAccounts.map(a => ({
      id: a.id,
      platform: a.platform,
      name: a.name,
      isActive: a.isActive
    }))

    res.json({ success: true, data: worker })
  } catch (error) {
    logger.error('Failed to get worker:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 创建 Worker
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { name, type, maxConcurrency, region, metadata } = req.body
    const { worker, token } = await workerService.createWorker({
      name, type, maxConcurrency, region, metadata
    })

    // token 只在创建时返回，之后无法再获取
    res.json({
      success: true,
      data: worker,
      token // ⚠️ 一次性返回
    })
  } catch (error) {
    logger.error('Failed to create worker:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 更新 Worker
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const existing = await workerService.getWorker(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Worker not found' })
    }

    const { name, maxConcurrency, region, metadata } = req.body
    const fields = {}
    if (name !== undefined) fields.name = name
    if (maxConcurrency !== undefined) fields.maxConcurrency = maxConcurrency
    if (region !== undefined) fields.region = region
    if (metadata !== undefined) fields.metadata = metadata

    const worker = await workerService.updateWorker(req.params.id, fields)
    res.json({ success: true, data: worker })
  } catch (error) {
    logger.error('Failed to update worker:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 删除 Worker
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const existing = await workerService.getWorker(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Worker not found' })
    }

    await workerService.deleteWorker(req.params.id)
    res.json({ success: true })
  } catch (error) {
    logger.error('Failed to delete worker:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 重新生成 Token
router.post('/:id/regenerate-token', authenticateAdmin, async (req, res) => {
  try {
    const existing = await workerService.getWorker(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Worker not found' })
    }

    const token = await workerService.regenerateToken(req.params.id)
    res.json({ success: true, token })
  } catch (error) {
    logger.error('Failed to regenerate token:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 踢掉 Worker（强制断开）
router.post('/:id/disconnect', authenticateAdmin, async (req, res) => {
  try {
    const { reason } = req.body
    workerService.disconnectWorker(req.params.id, reason || 'Disconnected by admin')
    res.json({ success: true })
  } catch (error) {
    logger.error('Failed to disconnect worker:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 绑定账户到 Worker
router.post('/:id/bind-account', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.body
    if (!accountId) {
      return res.status(400).json({ success: false, error: 'accountId is required' })
    }

    const worker = await workerService.getWorker(req.params.id)
    if (!worker) {
      return res.status(404).json({ success: false, error: 'Worker not found' })
    }

    // 同步写入 PG 和 Redis
    await dal.accounts.updateAccount(accountId, { workerId: req.params.id })
    await redis.setClaudeAccount(accountId, { workerId: req.params.id })
    res.json({ success: true })
  } catch (error) {
    logger.error('Failed to bind account:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// 解绑账户
router.post('/:id/unbind-account', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.body
    if (!accountId) {
      return res.status(400).json({ success: false, error: 'accountId is required' })
    }

    // 安全检查：只解绑属于该 Worker 的账户
    const pg = require('../../models/pg')
    const { rowCount } = await pg.query(
      'UPDATE accounts SET worker_id = NULL WHERE id = $1 AND worker_id = $2',
      [accountId, req.params.id]
    )
    // 同步清除 Redis 中的 workerId 字段
    if (rowCount > 0) {
      const redisKey = `claude:account:${accountId}`
      await redis.client.hdel(redisKey, 'workerId')
    }
    res.json({ success: true })
  } catch (error) {
    logger.error('Failed to unbind account:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

module.exports = router
