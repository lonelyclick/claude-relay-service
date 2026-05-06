import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { appConfig } from '../config.js'
import { UsageStore } from '../usage/usageStore.js'
import { UserStore } from '../usage/userStore.js'
import { BillingInsufficientBalanceError, BillingStore } from './billingStore.js'

const hasDatabase = Boolean(appConfig.databaseUrl)

test('BillingStore.syncUsageRecordById debits prepaid balance atomically and rejects overdraft', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const suffix = crypto.randomUUID()
  const userId = `billing-user-${suffix}`
  const accountId = `billing-account-${suffix}`
  const routingGroupId = `billing-group-${suffix}`
  const model = `billing-model-${suffix}`
  const channelId = `${routingGroupId}:anthropic_messages:anthropic:${model}`

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const userStore = new UserStore(databaseUrl)
  const usageStore = new UsageStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)
  let firstUsageRecordId: number | null = null
  let secondUsageRecordId: number | null = null

  try {
    await userStore.ensureTable()
    await usageStore.ensureTable()
    await billingStore.ensureTables()
    await pool.query(
      `INSERT INTO relay_users (id, api_key, name, billing_mode, billing_currency, balance_micros, credit_limit_micros, is_active)
       VALUES ($1, $2, $3, 'prepaid', 'USD', 1000, 0, true)`,
      [userId, `rk_${crypto.randomBytes(16).toString('hex')}`, `billing-${suffix}`],
    )
    await pool.query(
      `INSERT INTO billing_base_skus (
         id, provider, model_vendor, protocol, model, currency, display_name, is_active,
         input_price_micros_per_million, output_price_micros_per_million,
         cache_creation_price_micros_per_million, cache_read_price_micros_per_million
       ) VALUES ($1, 'anthropic', 'anthropic', 'anthropic_messages', $2, 'USD', $2, true, 0, 1000000, 0, 0)`,
      [`base-${suffix}`, model],
    )
    await pool.query(
      `INSERT INTO billing_channel_multipliers (id, routing_group_id, provider, model_vendor, protocol, model, multiplier_micros, is_active)
       VALUES ($1, $2, 'anthropic', 'anthropic', 'anthropic_messages', $3, 1000000, true)`,
      [channelId, routingGroupId, model],
    )

    firstUsageRecordId = await usageStore.insertRecord({
      requestId: `req-first-${suffix}`,
      accountId,
      userId,
      routingGroupId,
      relayKeySource: 'relay_users_legacy',
      sessionKey: null,
      clientDeviceId: null,
      model,
      inputTokens: 0,
      outputTokens: 700,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 10,
      target: '/v1/messages',
      rateLimitStatus: null,
      rateLimit5hUtilization: null,
      rateLimit7dUtilization: null,
      rateLimitReset: null,
      requestHeaders: null,
      requestBodyPreview: null,
      responseHeaders: null,
      responseBodyPreview: null,
      upstreamRequestHeaders: null,
    })
    await billingStore.syncUsageRecordById(firstUsageRecordId)

    const afterFirst = await pool.query<{ balance_micros: string }>(
      `SELECT balance_micros FROM relay_users WHERE id = $1`,
      [userId],
    )
    assert.equal(String(afterFirst.rows[0].balance_micros), '300')

    secondUsageRecordId = await usageStore.insertRecord({
      requestId: `req-second-${suffix}`,
      accountId,
      userId,
      routingGroupId,
      relayKeySource: 'relay_users_legacy',
      sessionKey: null,
      clientDeviceId: null,
      model,
      inputTokens: 0,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 10,
      target: '/v1/messages',
      rateLimitStatus: null,
      rateLimit5hUtilization: null,
      rateLimit7dUtilization: null,
      rateLimitReset: null,
      requestHeaders: null,
      requestBodyPreview: null,
      responseHeaders: null,
      responseBodyPreview: null,
      upstreamRequestHeaders: null,
    })
    await assert.rejects(
      () => billingStore.syncUsageRecordById(secondUsageRecordId as number),
      BillingInsufficientBalanceError,
    )

    const afterRejected = await pool.query<{ balance_micros: string }>(
      `SELECT balance_micros FROM relay_users WHERE id = $1`,
      [userId],
    )
    assert.equal(String(afterRejected.rows[0].balance_micros), '300')
  } finally {
    if (secondUsageRecordId !== null) {
      await pool.query('DELETE FROM billing_balance_ledger WHERE usage_record_id = $1', [secondUsageRecordId])
      await pool.query('DELETE FROM billing_line_items WHERE usage_record_id = $1', [secondUsageRecordId])
      await pool.query('DELETE FROM usage_records WHERE id = $1', [secondUsageRecordId])
    }
    if (firstUsageRecordId !== null) {
      await pool.query('DELETE FROM billing_balance_ledger WHERE usage_record_id = $1', [firstUsageRecordId])
      await pool.query('DELETE FROM billing_line_items WHERE usage_record_id = $1', [firstUsageRecordId])
      await pool.query('DELETE FROM usage_records WHERE id = $1', [firstUsageRecordId])
    }
    await pool.query('DELETE FROM billing_channel_multipliers WHERE id = $1', [channelId])
    await pool.query('DELETE FROM billing_base_skus WHERE id = $1', [`base-${suffix}`])
    await pool.query('DELETE FROM relay_users WHERE id = $1', [userId])
    await pool.end()
    await billingStore.close()
    await usageStore.close()
    await userStore.close()
  }
})
