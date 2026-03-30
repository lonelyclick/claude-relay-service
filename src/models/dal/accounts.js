const pg = require('../pg')
const logger = require('../../utils/logger')

/**
 * Accounts DAL — 统一账户数据访问层
 *
 * 所有平台（claude, claude-console, bedrock, gemini, gemini-api,
 * openai, openai-responses, azure-openai, ccr）统一存储在 accounts 表。
 *
 * Redis → PG 字段映射策略：
 * - 公共字段 → 对应列
 * - 凭证字段 → credentials JSONB
 * - 限流/封禁状态 → rate_limit_status JSONB
 * - 额度管理 → quota_config JSONB
 * - 平台特有字段 → extra JSONB
 */

// Redis Hash 字段 → PG 列/JSONB 的映射规则
// 列出哪些 Redis 字段对应 PG 的独立列
const COLUMN_FIELDS = new Set([
  'id', 'platform', 'name', 'description',
  'accountType', 'priority', 'schedulable', 'isActive', 'status', 'errorMessage',
  'proxy',
  'expiresAt', 'subscriptionExpiresAt',
  'supportedModels',
  'maxConcurrency', 'disableAutoProtection', 'interceptWarmup',
  'disableTempUnavailable', 'tempUnavailable503TtlSeconds', 'tempUnavailable5xxTtlSeconds',
  'useUnifiedUserAgent', 'useUnifiedClientId', 'unifiedClientId', 'userAgent',
  'groupId',
  'createdAt', 'updatedAt', 'lastUsedAt', 'lastRefreshAt',
  'workerId'
])

// 凭证字段 → credentials JSONB
const CREDENTIAL_FIELDS = new Set([
  'email', 'password', 'claudeAiOauth', 'accessToken', 'refreshToken', 'scopes',
  'apiUrl', 'apiKey',
  'awsCredentials', 'bearerToken', 'credentialType', 'region', 'defaultModel',
  'geminiOauth', 'oauthProvider', 'projectId', 'tempProjectId',
  'idToken', 'openaiOauth', 'chatgptUserId',
  'azureEndpoint', 'apiVersion', 'deploymentName',
  'baseApi', 'providerEndpoint',
  'tokenType', 'authenticationMethod', 'apiKeys', 'apiKeyCount', 'apiKeyStrategy'
])

// 限流/过载/封禁状态 → rate_limit_status JSONB
const RATE_LIMIT_FIELDS = new Set([
  'rateLimitDuration', 'rateLimitedAt', 'rateLimitStatus', 'rateLimitAutoStopped',
  'rateLimitResetAt',
  'blockedAt', 'blockedStatus', 'blockedAutoStopped',
  'unauthorizedAt', 'unauthorizedCount',
  'overloadedAt', 'overloadStatus',
  'countTokensUnavailable', 'countTokensUnavailableAt'
])

// 额度管理 → quota_config JSONB
const QUOTA_FIELDS = new Set([
  'dailyQuota', 'dailyUsage', 'lastResetDate', 'quotaResetTime',
  'quotaStoppedAt', 'quotaAutoStopped'
])

// camelCase → snake_case
function toSnake(str) {
  return str.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
}

// snake_case → camelCase
function toCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

/**
 * 将 Redis 格式的 flat object 拆分为 PG 列和 JSONB 字段
 */
function splitRedisDataToPg(data) {
  const columns = {}
  const credentials = {}
  const rateLimitStatus = {}
  const quotaConfig = {}
  const extra = {}

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue

    if (COLUMN_FIELDS.has(key)) {
      columns[key] = value
    } else if (CREDENTIAL_FIELDS.has(key)) {
      credentials[key] = value
    } else if (RATE_LIMIT_FIELDS.has(key)) {
      rateLimitStatus[key] = value
    } else if (QUOTA_FIELDS.has(key)) {
      quotaConfig[key] = value
    } else {
      extra[key] = value
    }
  }

  return { columns, credentials, rateLimitStatus, quotaConfig, extra }
}

/**
 * 将 PG row 合并为 Redis 格式的 flat object（所有值为字符串）
 */
function pgRowToRedisFormat(row) {
  if (!row) return null

  const result = {}

  // 列字段
  if (row.id) result.id = row.id
  if (row.platform) result.platform = row.platform
  result.name = row.name || ''
  result.description = row.description || ''
  result.accountType = row.account_type || 'shared'
  result.priority = String(row.priority ?? 50)
  result.schedulable = String(row.schedulable ?? true)
  result.isActive = String(row.is_active ?? true)
  result.status = row.status || 'active'
  result.errorMessage = row.error_message || ''

  if (row.proxy) result.proxy = typeof row.proxy === 'string' ? row.proxy : JSON.stringify(row.proxy)
  if (row.supported_models) result.supportedModels = typeof row.supported_models === 'string' ? row.supported_models : JSON.stringify(row.supported_models)

  result.maxConcurrency = String(row.max_concurrency ?? 0)
  result.disableAutoProtection = String(row.disable_auto_protection ?? false)
  result.interceptWarmup = String(row.intercept_warmup ?? false)
  result.disableTempUnavailable = String(row.disable_temp_unavailable ?? false)
  if (row.temp_unavailable_503_ttl_s != null) result.tempUnavailable503TtlSeconds = String(row.temp_unavailable_503_ttl_s)
  if (row.temp_unavailable_5xx_ttl_s != null) result.tempUnavailable5xxTtlSeconds = String(row.temp_unavailable_5xx_ttl_s)

  result.useUnifiedUserAgent = String(row.use_unified_user_agent ?? false)
  result.useUnifiedClientId = String(row.use_unified_client_id ?? false)
  result.unifiedClientId = row.unified_client_id || ''
  result.userAgent = row.user_agent || ''

  if (row.group_id) result.groupId = row.group_id

  if (row.expires_at) result.expiresAt = new Date(row.expires_at).toISOString()
  if (row.subscription_expires_at) result.subscriptionExpiresAt = new Date(row.subscription_expires_at).toISOString()
  if (row.created_at) result.createdAt = new Date(row.created_at).toISOString()
  if (row.updated_at) result.updatedAt = new Date(row.updated_at).toISOString()
  if (row.last_used_at) result.lastUsedAt = new Date(row.last_used_at).toISOString()
  if (row.last_refresh_at) result.lastRefreshAt = new Date(row.last_refresh_at).toISOString()

  if (row.worker_id) result.workerId = row.worker_id

  // JSONB 字段展开为 flat
  if (row.credentials && typeof row.credentials === 'object') {
    Object.assign(result, row.credentials)
  }
  if (row.rate_limit_status && typeof row.rate_limit_status === 'object') {
    Object.assign(result, row.rate_limit_status)
  }
  if (row.quota_config && typeof row.quota_config === 'object') {
    Object.assign(result, row.quota_config)
  }
  if (row.extra && typeof row.extra === 'object') {
    Object.assign(result, row.extra)
  }

  return result
}

/**
 * 构建 UPSERT SQL
 */
function buildUpsertSQL(data, platform) {
  const { columns, credentials, rateLimitStatus, quotaConfig, extra } = splitRedisDataToPg(data)

  // 构建列映射
  const fields = ['id', 'platform']
  const values = [data.id, platform]
  const placeholders = ['$1', '$2']
  const updates = ['platform = EXCLUDED.platform']
  let idx = 3

  // 列字段（跳过 id 和 platform，已处理）
  const columnMapping = {
    name: 'name',
    description: 'description',
    accountType: 'account_type',
    priority: 'priority',
    schedulable: 'schedulable',
    isActive: 'is_active',
    status: 'status',
    errorMessage: 'error_message',
    proxy: 'proxy',
    expiresAt: 'expires_at',
    subscriptionExpiresAt: 'subscription_expires_at',
    supportedModels: 'supported_models',
    maxConcurrency: 'max_concurrency',
    disableAutoProtection: 'disable_auto_protection',
    interceptWarmup: 'intercept_warmup',
    disableTempUnavailable: 'disable_temp_unavailable',
    tempUnavailable503TtlSeconds: 'temp_unavailable_503_ttl_s',
    tempUnavailable5xxTtlSeconds: 'temp_unavailable_5xx_ttl_s',
    useUnifiedUserAgent: 'use_unified_user_agent',
    useUnifiedClientId: 'use_unified_client_id',
    unifiedClientId: 'unified_client_id',
    userAgent: 'user_agent',
    groupId: 'group_id',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    lastUsedAt: 'last_used_at',
    lastRefreshAt: 'last_refresh_at',
    workerId: 'worker_id'
  }

  for (const [camel, snake] of Object.entries(columnMapping)) {
    if (columns[camel] !== undefined) {
      let val = columns[camel]

      // 类型转换
      if (['schedulable', 'isActive', 'disableAutoProtection', 'interceptWarmup',
           'disableTempUnavailable', 'useUnifiedUserAgent', 'useUnifiedClientId'].includes(camel)) {
        val = val === 'true' || val === true
      }
      if (['priority', 'maxConcurrency', 'tempUnavailable503TtlSeconds', 'tempUnavailable5xxTtlSeconds'].includes(camel)) {
        val = parseInt(val) || 0
      }
      if (['proxy', 'supportedModels'].includes(camel)) {
        if (typeof val === 'string') {
          try { val = JSON.parse(val) } catch { /* keep as string */ }
        }
      }
      if (['expiresAt', 'subscriptionExpiresAt', 'createdAt', 'updatedAt', 'lastUsedAt', 'lastRefreshAt'].includes(camel)) {
        if (!val || val === 'null' || val === '') {
          val = null
        } else {
          // 支持毫秒时间戳（纯数字字符串）和 ISO 字符串
          let d
          if (/^\d+$/.test(val)) {
            d = new Date(parseInt(val))
          } else {
            d = new Date(val)
          }
          val = isNaN(d.getTime()) ? null : d.toISOString()
        }
      }

      fields.push(snake)
      values.push(val)
      placeholders.push(`$${idx}`)
      updates.push(`${snake} = EXCLUDED.${snake}`)
      idx++
    }
  }

  // JSONB 字段
  const jsonbFields = [
    { name: 'credentials', data: credentials },
    { name: 'rate_limit_status', data: rateLimitStatus },
    { name: 'quota_config', data: quotaConfig },
    { name: 'extra', data: extra }
  ]

  for (const { name, data: jsonData } of jsonbFields) {
    if (Object.keys(jsonData).length > 0) {
      fields.push(name)
      values.push(JSON.stringify(jsonData))
      placeholders.push(`$${idx}::jsonb`)
      // JSONB 合并：已有数据 || 新数据覆盖
      updates.push(`${name} = COALESCE(accounts.${name}, '{}'::jsonb) || EXCLUDED.${name}`)
      idx++
    }
  }

  const sql = `INSERT INTO accounts (${fields.join(', ')})
VALUES (${placeholders.join(', ')})
ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`

  return { sql, values }
}

// ============================================================
// 公共 CRUD 方法
// ============================================================

/**
 * 保存/更新账户（兼容 Redis hset 语义）
 */
async function setAccount(accountId, accountData, platform) {
  const data = { id: accountId, ...accountData }
  const { sql, values } = buildUpsertSQL(data, platform)
  await pg.query(sql, values)
}

/**
 * 获取单个账户（返回 Redis flat 格式）
 */
async function getAccount(accountId, platform = null) {
  let sql = 'SELECT * FROM accounts WHERE id = $1'
  const params = [accountId]
  if (platform) {
    sql += ' AND platform = $2'
    params.push(platform)
  }
  const { rows } = await pg.query(sql, params)
  return pgRowToRedisFormat(rows[0])
}

/**
 * 获取某平台全部账户
 */
async function getAllAccounts(platform) {
  const { rows } = await pg.query(
    'SELECT * FROM accounts WHERE platform = $1 ORDER BY priority ASC, created_at ASC',
    [platform]
  )
  return rows.map(pgRowToRedisFormat)
}

/**
 * 删除账户
 */
async function deleteAccount(accountId) {
  await pg.query('DELETE FROM accounts WHERE id = $1', [accountId])
}

/**
 * 更新账户部分字段（hset 部分更新语义）
 */
async function updateAccount(accountId, fields, platform) {
  // 用 UPSERT 实现部分更新（JSONB 合并模式）
  const data = { id: accountId, ...fields }
  const { sql, values } = buildUpsertSQL(data, platform)
  await pg.query(sql, values)
}

/**
 * 更新 lastUsedAt
 */
async function touchAccount(accountId) {
  await pg.query(
    'UPDATE accounts SET last_used_at = NOW() WHERE id = $1',
    [accountId]
  )
}

/**
 * 批量获取账户
 */
async function batchGetAccounts(accountIds, platform = null) {
  if (!accountIds.length) return []
  let sql = 'SELECT * FROM accounts WHERE id = ANY($1::text[])'
  const params = [accountIds]
  if (platform) {
    sql += ' AND platform = $2'
    params.push(platform)
  }
  const { rows } = await pg.query(sql, params)
  return rows.map(pgRowToRedisFormat)
}

/**
 * 按 workerId 获取账户
 */
async function getAccountsByWorkerId(workerId) {
  const { rows } = await pg.query(
    'SELECT * FROM accounts WHERE worker_id = $1',
    [workerId]
  )
  return rows.map(pgRowToRedisFormat)
}

module.exports = {
  setAccount,
  getAccount,
  getAllAccounts,
  deleteAccount,
  updateAccount,
  touchAccount,
  batchGetAccounts,
  getAccountsByWorkerId,
  // 导出工具函数供迁移脚本使用
  splitRedisDataToPg,
  pgRowToRedisFormat,
  buildUpsertSQL
}
