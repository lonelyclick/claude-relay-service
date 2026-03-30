const pg = require('../pg')
const logger = require('../../utils/logger')

/**
 * API Keys DAL
 *
 * Redis Hash 全是字符串，PG 有类型。
 * 写入时做类型转换，读出时转回字符串（兼容现有代码）。
 */

// camelCase Redis 字段 → snake_case PG 列
const FIELD_MAP = {
  id: 'id',
  name: 'name',
  description: 'description',
  apiKey: 'api_key_hash',
  isActive: 'is_active',
  isDeleted: 'is_deleted',
  claudeAccountId: 'claude_account_id',
  claudeConsoleAccountId: 'claude_console_account_id',
  geminiAccountId: 'gemini_account_id',
  openaiAccountId: 'openai_account_id',
  azureOpenaiAccountId: 'azure_openai_account_id',
  bedrockAccountId: 'bedrock_account_id',
  tokenLimit: 'token_limit',
  dailyCostLimit: 'daily_cost_limit',
  totalCostLimit: 'total_cost_limit',
  weeklyOpusCostLimit: 'weekly_opus_cost_limit',
  weeklyResetDay: 'weekly_reset_day',
  weeklyResetHour: 'weekly_reset_hour',
  concurrencyLimit: 'concurrency_limit',
  rateLimitWindow: 'rate_limit_window',
  rateLimitRequests: 'rate_limit_requests',
  rateLimitCost: 'rate_limit_cost',
  enableModelRestriction: 'enable_model_restriction',
  restrictedModels: 'restricted_models',
  enableClientRestriction: 'enable_client_restriction',
  allowedClients: 'allowed_clients',
  permissions: 'permissions',
  serviceRates: 'service_rates',
  tags: 'tags',
  expirationMode: 'expiration_mode',
  activationDays: 'activation_days',
  activationUnit: 'activation_unit',
  isActivated: 'is_activated',
  activatedAt: 'activated_at',
  expiresAt: 'expires_at',
  userId: 'user_id',
  userUsername: 'user_username',
  ownerDisplayName: 'owner_display_name',
  createdBy: 'created_by',
  icon: 'icon',
  createdAt: 'created_at',
  lastUsedAt: 'last_used_at'
}

// 布尔字段
const BOOL_FIELDS = new Set([
  'is_active', 'is_deleted', 'enable_model_restriction',
  'enable_client_restriction', 'is_activated'
])

// 整型字段
const INT_FIELDS = new Set([
  'token_limit', 'weekly_reset_day', 'weekly_reset_hour',
  'concurrency_limit', 'rate_limit_window', 'rate_limit_requests',
  'activation_days'
])

// 浮点字段
const NUMERIC_FIELDS = new Set([
  'daily_cost_limit', 'total_cost_limit', 'weekly_opus_cost_limit', 'rate_limit_cost'
])

// JSONB 字段
const JSONB_FIELDS = new Set([
  'restricted_models', 'allowed_clients', 'permissions', 'service_rates', 'tags'
])

// 时间戳字段
const TS_FIELDS = new Set(['activated_at', 'expires_at', 'created_at', 'last_used_at'])

/**
 * Redis flat data → PG typed values
 */
// NOT NULL TEXT 列，空字符串应保留为 ''
const TEXT_NOT_NULL_FIELDS = new Set([
  'id', 'name', 'description', 'api_key_hash', 'expiration_mode', 'activation_unit',
  'user_id', 'user_username', 'owner_display_name', 'created_by', 'icon'
])

function convertToPgValue(pgCol, val) {
  if (val === undefined || val === null || val === 'null') {
    if (BOOL_FIELDS.has(pgCol)) return false
    if (TEXT_NOT_NULL_FIELDS.has(pgCol)) return ''
    return null
  }
  if (val === '') {
    if (BOOL_FIELDS.has(pgCol)) return false
    if (INT_FIELDS.has(pgCol) || NUMERIC_FIELDS.has(pgCol) || TS_FIELDS.has(pgCol)) return null
    if (JSONB_FIELDS.has(pgCol)) return null
    return '' // text 列保留空字符串
  }

  if (BOOL_FIELDS.has(pgCol)) return val === 'true' || val === true
  if (INT_FIELDS.has(pgCol)) { const n = parseInt(val); return Number.isFinite(n) ? n : null }
  if (NUMERIC_FIELDS.has(pgCol)) { const n = parseFloat(val); return Number.isFinite(n) ? n : null }
  if (JSONB_FIELDS.has(pgCol)) {
    // pg 驱动需要 JSON string 给 ::jsonb cast
    if (typeof val === 'string') {
      try { JSON.parse(val); return val } catch { return null }
    }
    return JSON.stringify(val)
  }
  if (TS_FIELDS.has(pgCol)) {
    const d = new Date(val)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  return val
}

/**
 * PG row → Redis flat string object
 */
function pgRowToRedisFormat(row) {
  if (!row) return null
  const result = {}

  // 反向映射 snake → camel
  for (const [camel, snake] of Object.entries(FIELD_MAP)) {
    const val = row[snake]
    if (val === null || val === undefined) continue

    if (BOOL_FIELDS.has(snake)) {
      result[camel] = String(val)
    } else if (TS_FIELDS.has(snake)) {
      result[camel] = new Date(val).toISOString()
    } else if (JSONB_FIELDS.has(snake)) {
      result[camel] = typeof val === 'string' ? val : JSON.stringify(val)
    } else {
      result[camel] = String(val)
    }
  }

  return result
}

// ============================================================
// CRUD
// ============================================================

/**
 * 保存 API Key（UPSERT）
 */
async function setApiKey(keyId, keyData) {
  const data = { id: keyId, ...keyData }
  const fields = []
  const values = []
  const placeholders = []
  const updates = []
  let idx = 1

  for (const [camel, snake] of Object.entries(FIELD_MAP)) {
    if (data[camel] !== undefined) {
      fields.push(snake)
      const pgVal = convertToPgValue(snake, data[camel])
      values.push(pgVal)
      const ph = JSONB_FIELDS.has(snake) ? `$${idx}::jsonb` : `$${idx}`
      placeholders.push(ph)
      if (snake !== 'id') {
        updates.push(`${snake} = EXCLUDED.${snake}`)
      }
      idx++
    }
  }

  if (!fields.includes('id')) {
    fields.unshift('id')
    values.unshift(keyId)
    placeholders.unshift(`$${idx}`)
    idx++
  }

  const sql = `INSERT INTO api_keys (${fields.join(', ')})
VALUES (${placeholders.join(', ')})
ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`

  await pg.query(sql, values)
}

/**
 * 获取 API Key
 */
async function getApiKey(keyId) {
  const { rows } = await pg.query('SELECT * FROM api_keys WHERE id = $1', [keyId])
  return pgRowToRedisFormat(rows[0])
}

/**
 * 通过 hash 查找 API Key（认证用）
 */
async function findApiKeyByHash(hashedKey) {
  const { rows } = await pg.query(
    'SELECT * FROM api_keys WHERE api_key_hash = $1',
    [hashedKey]
  )
  return pgRowToRedisFormat(rows[0])
}

/**
 * 删除 API Key（硬删除）
 */
async function deleteApiKey(keyId) {
  await pg.query('DELETE FROM api_keys WHERE id = $1', [keyId])
}

/**
 * 获取全部 API Keys
 */
async function getAllApiKeys() {
  const { rows } = await pg.query(
    'SELECT * FROM api_keys WHERE is_deleted = FALSE ORDER BY created_at DESC'
  )
  return rows.map(pgRowToRedisFormat)
}

/**
 * 分页获取 API Keys
 */
async function getApiKeysPaginated({ page = 1, pageSize = 20, search, tag, isActive, sortBy = 'created_at', sortOrder = 'desc' } = {}) {
  const conditions = ['is_deleted = FALSE']
  const params = []
  let idx = 1

  if (search) {
    conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx} OR id ILIKE $${idx})`)
    params.push(`%${search}%`)
    idx++
  }
  if (tag) {
    conditions.push(`tags @> $${idx}::jsonb`)
    params.push(JSON.stringify([tag]))
    idx++
  }
  if (isActive !== undefined) {
    conditions.push(`is_active = $${idx}`)
    params.push(isActive === 'true' || isActive === true)
    idx++
  }

  const where = conditions.join(' AND ')

  // 白名单排序列
  const allowedSort = { created_at: 'created_at', name: 'name', last_used_at: 'last_used_at' }
  const orderCol = allowedSort[sortBy] || 'created_at'
  const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC'

  const countResult = await pg.query(`SELECT COUNT(*) FROM api_keys WHERE ${where}`, params)
  const total = parseInt(countResult.rows[0].count)

  const offset = (page - 1) * pageSize
  const dataResult = await pg.query(
    `SELECT * FROM api_keys WHERE ${where} ORDER BY ${orderCol} ${orderDir} LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, pageSize, offset]
  )

  return {
    items: dataResult.rows.map(pgRowToRedisFormat),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  }
}

/**
 * 获取所有 API Key IDs
 */
async function getAllApiKeyIds() {
  const { rows } = await pg.query(
    'SELECT id FROM api_keys WHERE is_deleted = FALSE'
  )
  return rows.map(r => r.id)
}

/**
 * 批量获取 API Keys
 */
async function batchGetApiKeys(keyIds) {
  if (!keyIds.length) return []
  const { rows } = await pg.query(
    'SELECT * FROM api_keys WHERE id = ANY($1::text[])',
    [keyIds]
  )
  return rows.map(pgRowToRedisFormat)
}

/**
 * 获取所有唯一 tags
 */
async function getAllTags() {
  const { rows } = await pg.query(
    `SELECT DISTINCT jsonb_array_elements_text(tags) AS tag
     FROM api_keys WHERE is_deleted = FALSE AND tags != '[]'::jsonb`
  )
  return rows.map(r => r.tag)
}

/**
 * 按 userId 获取 API Keys
 */
async function getApiKeysByUserId(userId) {
  const { rows } = await pg.query(
    'SELECT * FROM api_keys WHERE user_id = $1 AND is_deleted = FALSE ORDER BY created_at DESC',
    [userId]
  )
  return rows.map(pgRowToRedisFormat)
}

module.exports = {
  setApiKey,
  getApiKey,
  findApiKeyByHash,
  deleteApiKey,
  getAllApiKeys,
  getApiKeysPaginated,
  getAllApiKeyIds,
  batchGetApiKeys,
  getAllTags,
  getApiKeysByUserId,
  pgRowToRedisFormat,
  convertToPgValue
}
