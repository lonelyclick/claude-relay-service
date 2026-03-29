const pg = require('../pg')

/**
 * Misc DAL — 小表：test_configs, balance_scripts, system_metadata, system_configs
 */

// ============================================================
// Account Test Configs
// ============================================================

async function saveTestConfig(accountId, platform, config) {
  await pg.query(
    `INSERT INTO account_test_configs (account_id, platform, enabled, cron_expression, model)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, platform) DO UPDATE SET
       enabled = $3, cron_expression = $4, model = $5`,
    [
      accountId,
      platform,
      config.enabled === true || config.enabled === 'true',
      config.cronExpression || '0 8 * * *',
      config.model || 'claude-sonnet-4-5-20250929'
    ]
  )
}

async function getTestConfig(accountId, platform) {
  const { rows } = await pg.query(
    'SELECT * FROM account_test_configs WHERE account_id = $1 AND platform = $2',
    [accountId, platform]
  )
  if (!rows[0]) return null
  return {
    enabled: rows[0].enabled,
    cronExpression: rows[0].cron_expression,
    model: rows[0].model,
    updatedAt: rows[0].updated_at?.toISOString()
  }
}

async function getEnabledTestConfigs() {
  const { rows } = await pg.query(
    'SELECT * FROM account_test_configs WHERE enabled = TRUE'
  )
  return rows.map(r => ({
    accountId: r.account_id,
    platform: r.platform,
    enabled: r.enabled,
    cronExpression: r.cron_expression,
    model: r.model
  }))
}

async function deleteTestConfig(accountId, platform) {
  await pg.query(
    'DELETE FROM account_test_configs WHERE account_id = $1 AND platform = $2',
    [accountId, platform]
  )
}

// ============================================================
// Balance Script Configs
// ============================================================

async function setBalanceScriptConfig(accountId, platform, scriptConfig) {
  await pg.query(
    `INSERT INTO balance_script_configs (account_id, platform, config)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (account_id, platform) DO UPDATE SET config = $3::jsonb`,
    [accountId, platform, JSON.stringify(scriptConfig || {})]
  )
}

async function getBalanceScriptConfig(accountId, platform) {
  const { rows } = await pg.query(
    'SELECT config FROM balance_script_configs WHERE account_id = $1 AND platform = $2',
    [accountId, platform]
  )
  return rows[0]?.config || null
}

async function deleteBalanceScriptConfig(accountId, platform) {
  await pg.query(
    'DELETE FROM balance_script_configs WHERE account_id = $1 AND platform = $2',
    [accountId, platform]
  )
}

// ============================================================
// System Metadata (KV)
// ============================================================

async function getSystemMeta(key) {
  const { rows } = await pg.query(
    'SELECT value FROM system_metadata WHERE key = $1',
    [key]
  )
  return rows[0]?.value || null
}

async function setSystemMeta(key, value) {
  await pg.query(
    `INSERT INTO system_metadata (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  )
}

// ============================================================
// System Configs (JSONB)
// ============================================================

async function getSystemConfig(key) {
  const { rows } = await pg.query(
    'SELECT value FROM system_configs WHERE key = $1',
    [key]
  )
  return rows[0]?.value || null
}

async function setSystemConfig(key, value) {
  await pg.query(
    `INSERT INTO system_configs (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  )
}

module.exports = {
  saveTestConfig,
  getTestConfig,
  getEnabledTestConfigs,
  deleteTestConfig,
  setBalanceScriptConfig,
  getBalanceScriptConfig,
  deleteBalanceScriptConfig,
  getSystemMeta,
  setSystemMeta,
  getSystemConfig,
  setSystemConfig
}
