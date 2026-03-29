const { Pool } = require('pg')
const path = require('path')
const fs = require('fs')
const logger = require('../utils/logger')

/**
 * PostgreSQL 连接池 (ccqiao 数据库)
 * 用于持久数据存储：accounts, api_keys, users, workers 等
 *
 * 使用 CRS_PG_ 前缀避免与系统环境变量冲突。
 * 也支持无前缀的 PG_ 作为 fallback。
 */

// 从 .env 文件直接解析 CRS_PG_ 配置（绕过已被系统变量覆盖的 dotenv）
function loadPgConfig() {
  // 优先用 CRS_PG_ 前缀
  const host = process.env.CRS_PG_HOST || process.env.PG_HOST || '127.0.0.1'
  const port = parseInt(process.env.CRS_PG_PORT || process.env.PG_PORT) || 5432
  const database = process.env.CRS_PG_DATABASE || process.env.PG_DATABASE || 'ccqiao'
  const user = process.env.CRS_PG_USER || process.env.PG_USER || 'guang'
  const password = process.env.CRS_PG_PASSWORD || process.env.PG_PASSWORD || ''
  const max = parseInt(process.env.CRS_PG_POOL_MAX || process.env.PG_POOL_MAX) || 20

  return { host, port, database, user, password, max }
}

let pool = null
let pgConfig = null

function getPool() {
  if (!pool) {
    pgConfig = loadPgConfig()
    pool = new Pool({
      ...pgConfig,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    })

    pool.on('error', (err) => {
      logger.error('PG pool error:', err.message)
    })
  }
  return pool
}

/** 快捷查询 */
async function query(text, params) {
  const p = getPool()
  return p.query(text, params)
}

/** 获取单个客户端（事务用） */
async function getClient() {
  const p = getPool()
  return p.connect()
}

/** 连接测试 */
async function connect() {
  const p = getPool()
  const client = await p.connect()
  try {
    const res = await client.query('SELECT NOW()')
    const cfg = pgConfig || loadPgConfig()
    logger.info(`✅ PostgreSQL connected: ${cfg.database} @ ${cfg.host} — ${res.rows[0].now}`)
  } finally {
    client.release()
  }
}

/** 关闭连接池 */
async function close() {
  if (pool) {
    await pool.end()
    pool = null
    logger.info('PostgreSQL pool closed')
  }
}

module.exports = { query, getClient, connect, close, getPool }
