import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { appConfig } from '../config.js'
import { BillingStore } from './billingStore.js'
import { UsageStore } from '../usage/usageStore.js'
import { UserStore } from '../usage/userStore.js'

const hasDatabase = Boolean(appConfig.databaseUrl)

async function seedBillingIdentity(
  pool: pg.Pool,
  prefix: string,
  userId: string,
  accountId: string,
  provider = 'claude-official',
): Promise<void> {
  await pool.query(
    `INSERT INTO relay_users (id, api_key, name, routing_mode, is_active)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, `rk_${crypto.randomBytes(16).toString('hex')}`, `${prefix}-name`, 'auto', true],
  )
  await pool.query(
    `INSERT INTO accounts (id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [accountId, JSON.stringify({
      id: accountId,
      provider,
      label: `${prefix}-account`,
      emailAddress: `${prefix}@example.com`,
    })],
  )
}

async function cleanupBillingPrefix(pool: pg.Pool, prefix: string, accountId: string, userId: string): Promise<void> {
  await pool.query('DELETE FROM billing_balance_ledger WHERE user_id = $1 OR request_id LIKE $2', [userId, `${prefix}%`]).catch(() => {})
  await pool.query('DELETE FROM billing_line_items WHERE request_id LIKE $1', [`${prefix}%`]).catch(() => {})
  await pool.query('DELETE FROM billing_price_rules WHERE name LIKE $1', [`${prefix}%`]).catch(() => {})
  await pool.query('DELETE FROM usage_records WHERE request_id LIKE $1', [`${prefix}%`]).catch(() => {})
  await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]).catch(() => {})
  await pool.query('DELETE FROM relay_users WHERE id = $1', [userId]).catch(() => {})
}

test('BillingStore syncs rules and line items from usage records', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-store-test-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestId = `${prefix}-request`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)

    const rule = await billingStore.createRule({
      name: `${prefix}-default`,
      provider: 'claude-official',
      inputPriceMicrosPerMillion: '2500000',
      outputPriceMicrosPerMillion: '10000000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(rule.provider, 'claude-official')

    await usageStore.insertRecord({
      requestId,
      accountId,
      userId,
      sessionKey: `${prefix}-session`,
      clientDeviceId: `${prefix}-device`,
      model: 'claude-sonnet-4-5',
      inputTokens: 2000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 900,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.2,
      rateLimit7dUtilization: 0.3,
      rateLimitReset: 1776074400,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"bill me"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    const syncResult = await billingStore.syncLineItems()
    assert.ok(syncResult.processedRequests >= 1)
    assert.ok(syncResult.billedRequests >= 1)

    const users = await billingStore.getUserBilling(new Date('2026-01-01T00:00:00.000Z'))
    const userRow = users.find((row) => row.userId === userId)
    assert.ok(userRow)
    assert.equal(userRow?.totalRequests, 1)
    assert.equal(userRow?.billedRequests, 1)
    assert.equal(userRow?.totalAmountMicros, '10000')

    const detail = await billingStore.getUserDetail(userId, new Date('2026-01-01T00:00:00.000Z'))
    assert.ok(detail)
    assert.equal(detail?.billedRequests, 1)

    const lineItems = await billingStore.getUserLineItems(userId, new Date('2026-01-01T00:00:00.000Z'))
    assert.equal(lineItems.total, 1)
    assert.ok(lineItems.items[0]?.usageRecordId)
    assert.equal(lineItems.items[0]?.requestId, requestId)
    assert.equal(lineItems.items[0]?.status, 'billed')
    assert.equal(lineItems.items[0]?.amountMicros, '10000')
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore allows duplicate request ids across distinct usage records', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-duplicate-request-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestId = `${prefix}-shared-request`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)
    await billingStore.createRule({
      name: `${prefix}-default`,
      provider: 'claude-official',
      inputPriceMicrosPerMillion: '1000000',
      outputPriceMicrosPerMillion: '1000000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })

    for (const suffix of ['a', 'b']) {
      await usageStore.insertRecord({
        requestId,
        accountId,
        userId,
        sessionKey: `${prefix}-session-${suffix}`,
        clientDeviceId: `${prefix}-device-${suffix}`,
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        statusCode: 200,
        durationMs: 500,
        target: '/v1/messages',
        rateLimitStatus: 'allowed',
        rateLimit5hUtilization: 0.1,
        rateLimit7dUtilization: 0.1,
        rateLimitReset: 1776074400,
        requestHeaders: null,
        requestBodyPreview: `{"request":"${suffix}"}`,
        responseHeaders: null,
        responseBodyPreview: '{"ok":true}',
        upstreamRequestHeaders: null,
      })
    }

    const syncResult = await billingStore.syncLineItems()
    assert.ok(syncResult.billedRequests >= 2)

    const lineItems = await billingStore.getUserLineItems(userId, new Date('2026-01-01T00:00:00.000Z'))
    assert.equal(lineItems.total, 2)
    assert.equal(lineItems.items.filter((item) => item.requestId === requestId).length, 2)
    assert.equal(new Set(lineItems.items.map((item) => item.usageRecordId)).size, 2)
    assert.ok(lineItems.items.every((item) => item.status === 'billed'))
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore reconciles all missing_rule line items across multiple batches', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-reconcile-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestCount = 520
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)

    for (let index = 0; index < requestCount; index += 1) {
      await usageStore.insertRecord({
        requestId: `${prefix}-request-${index}`,
        accountId,
        userId,
        sessionKey: `${prefix}-session`,
        clientDeviceId: `${prefix}-device`,
        model: 'claude-sonnet-4-5',
        inputTokens: 40,
        outputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        statusCode: 200,
        durationMs: 300,
        target: '/v1/messages',
        rateLimitStatus: 'allowed',
        rateLimit5hUtilization: 0.1,
        rateLimit7dUtilization: 0.2,
        rateLimitReset: 1776074400,
        requestHeaders: null,
        requestBodyPreview: `{"index":${index}}`,
        responseHeaders: null,
        responseBodyPreview: '{"ok":true}',
        upstreamRequestHeaders: null,
      })
    }

    const initialSync = await billingStore.syncLineItems()
    assert.ok(initialSync.missingRuleRequests >= requestCount)

    await billingStore.createRule({
      name: `${prefix}-default`,
      provider: 'claude-official',
      inputPriceMicrosPerMillion: '1000000',
      outputPriceMicrosPerMillion: '2000000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })

    const reconcileResult = await billingStore.syncLineItems({ reconcileMissing: true })
    assert.ok(reconcileResult.billedRequests >= requestCount)

    const detail = await billingStore.getUserDetail(userId, new Date('2026-01-01T00:00:00.000Z'))
    assert.ok(detail)
    assert.equal(detail?.totalRequests, requestCount)
    assert.equal(detail?.billedRequests, requestCount)
    assert.equal(detail?.missingRuleRequests, 0)
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore creates top-up ledger entries and updates balance after usage sync', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-balance-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestId = `${prefix}-request`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)
    await billingStore.createRule({
      name: `${prefix}-default`,
      provider: 'claude-official',
      inputPriceMicrosPerMillion: '2500000',
      outputPriceMicrosPerMillion: '10000000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })

    const topup = await billingStore.createLedgerEntry({
      userId,
      kind: 'topup',
      amountMicros: '5000000',
      note: 'initial recharge',
    })
    assert.equal(topup.balance.balanceMicros, '5000000')
    assert.equal(topup.balance.currency, topup.balance.billingCurrency)

    const usageRecordId = await usageStore.insertRecord({
      requestId,
      accountId,
      userId,
      sessionKey: `${prefix}-session`,
      clientDeviceId: `${prefix}-device`,
      model: 'claude-sonnet-4-5',
      inputTokens: 2000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 800,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.2,
      rateLimit7dUtilization: 0.2,
      rateLimitReset: 1776074400,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"hello"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await billingStore.syncUsageRecordById(usageRecordId)

    const balance = await billingStore.getUserBalanceSummary(userId)
    assert.ok(balance)
    assert.equal(balance?.totalCreditedMicros, '5000000')
    assert.equal(balance?.totalDebitedMicros, '10000')
    assert.equal(balance?.balanceMicros, '4990000')
    assert.equal(balance?.currency, balance?.billingCurrency)

    const ledger = await billingStore.listUserLedger(userId, 10, 0)
    assert.equal(ledger.total, 2)
    assert.ok(ledger.entries.some((entry) => entry.kind === 'topup' && entry.amountMicros === '5000000'))
    assert.ok(ledger.entries.some((entry) => entry.kind === 'usage_debit' && entry.amountMicros === '-10000'))
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore usage sync is idempotent and adjusts balance deltas instead of double-charging', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-delta-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestId = `${prefix}-request`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)
    const rule = await billingStore.createRule({
      name: `${prefix}-default`,
      provider: 'claude-official',
      inputPriceMicrosPerMillion: '1000000',
      outputPriceMicrosPerMillion: '0',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })

    await billingStore.createLedgerEntry({
      userId,
      kind: 'topup',
      amountMicros: '1000000',
      note: 'working balance',
    })

    const usageRecordId = await usageStore.insertRecord({
      requestId,
      accountId,
      userId,
      sessionKey: `${prefix}-session`,
      clientDeviceId: `${prefix}-device`,
      model: 'claude-sonnet-4-5',
      inputTokens: 1000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 500,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.1,
      rateLimit7dUtilization: 0.1,
      rateLimitReset: 1776074400,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"delta"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await billingStore.syncUsageRecordById(usageRecordId)
    let balance = await billingStore.getUserBalanceSummary(userId)
    assert.equal(balance?.balanceMicros, '999000')

    await billingStore.syncUsageRecordById(usageRecordId)
    balance = await billingStore.getUserBalanceSummary(userId)
    assert.equal(balance?.balanceMicros, '999000')

    await billingStore.updateRule(rule.id, {
      inputPriceMicrosPerMillion: '2000000',
    })
    await billingStore.syncUsageRecordById(usageRecordId)

    balance = await billingStore.getUserBalanceSummary(userId)
    assert.equal(balance?.totalDebitedMicros, '2000')
    assert.equal(balance?.balanceMicros, '998000')

    const ledger = await billingStore.listUserLedger(userId, 10, 0)
    const usageDebit = ledger.entries.find((entry) => entry.kind === 'usage_debit')
    assert.ok(usageDebit)
    assert.equal(usageDebit?.amountMicros, '-2000')
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore bills usage targets with query strings', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-query-target-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestId = `${prefix}-request`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)
    await billingStore.createRule({
      name: `${prefix}-default`,
      provider: 'claude-official',
      userId,
      model: 'claude-opus-4-7',
      inputPriceMicrosPerMillion: '1000000',
      outputPriceMicrosPerMillion: '1000000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })

    await billingStore.createLedgerEntry({
      userId,
      kind: 'topup',
      amountMicros: '1000000',
      note: 'query target balance',
    })

    const usageRecordId = await usageStore.insertRecord({
      requestId,
      accountId,
      userId,
      sessionKey: `${prefix}-session`,
      clientDeviceId: `${prefix}-device`,
      model: 'claude-opus-4-7',
      inputTokens: 6,
      outputTokens: 6,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 600,
      target: '/v1/messages?beta=true',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.1,
      rateLimit7dUtilization: 0.1,
      rateLimitReset: 1776074400,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"query target"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await billingStore.syncUsageRecordById(usageRecordId)

    const lineItems = await billingStore.getUserLineItems(userId, new Date('2026-01-01T00:00:00.000Z'))
    assert.equal(lineItems.total, 1)
    assert.equal(lineItems.items[0]?.status, 'billed')

    const balance = await billingStore.getUserBalanceSummary(userId)
    assert.ok(balance)
    assert.equal(balance?.totalDebitedMicros, '12')
    assert.equal(balance?.balanceMicros, '999988')
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore only matches rules with the same billing currency as the user', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-currency-match-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestId = `${prefix}-request`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)
    await userStore.updateUser(userId, { billingCurrency: 'CNY' })
    await billingStore.createRule({
      name: `${prefix}-usd-default`,
      currency: 'USD',
      provider: 'claude-official',
      inputPriceMicrosPerMillion: '1000000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })

    const usageRecordId = await usageStore.insertRecord({
      requestId,
      accountId,
      userId,
      sessionKey: `${prefix}-session`,
      clientDeviceId: `${prefix}-device`,
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 200,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.1,
      rateLimit7dUtilization: 0.1,
      rateLimitReset: 1776074400,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"currency match"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await billingStore.syncUsageRecordById(usageRecordId)

    let lineItems = await billingStore.getUserLineItems(userId, new Date('2026-01-01T00:00:00.000Z'))
    assert.equal(lineItems.items[0]?.status, 'missing_rule')
    assert.equal(lineItems.items[0]?.currency, 'CNY')

    await billingStore.createRule({
      name: `${prefix}-cny-default`,
      currency: 'CNY',
      provider: 'claude-official',
      inputPriceMicrosPerMillion: '1000000',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    })
    await billingStore.syncLineItems({ reconcileMissing: true })

    lineItems = await billingStore.getUserLineItems(userId, new Date('2026-01-01T00:00:00.000Z'))
    assert.equal(lineItems.items[0]?.status, 'billed')
    assert.equal(lineItems.items[0]?.currency, 'CNY')
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore blocks currency changes after balance or billed history exists', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-currency-guard-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)
    const initialBalance = await billingStore.getUserBalanceSummary(userId)
    const alternateCurrency = initialBalance?.currency === 'USD' ? 'CNY' : 'USD'

    await billingStore.assertUserCurrencyChangeAllowed(userId, alternateCurrency)

    await billingStore.createLedgerEntry({
      userId,
      kind: 'topup',
      amountMicros: '1000000',
      note: 'guard balance',
    })

    await assert.rejects(
      billingStore.assertUserCurrencyChangeAllowed(userId, alternateCurrency),
      /Cannot change billingCurrency while balance is non-zero/,
    )
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})

test('BillingStore rejects unsafe rule and ledger input', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const prefix = `billing-input-guard-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)

  await usageStore.ensureTable()
  await userStore.ensureTable()
  await billingStore.ensureTables()

  try {
    await seedBillingIdentity(pool, prefix, userId, accountId)

    await assert.rejects(
      billingStore.createRule({
        name: 'unsafe\nrule',
        provider: 'claude-official',
      }),
      /name contains unsupported control characters/,
    )

    await assert.rejects(
      billingStore.createLedgerEntry({
        userId,
        kind: 'manual_adjustment',
        amountMicros: '9223372036854775808',
        note: 'overflow',
      }),
      /amountMicros is out of range/,
    )

    await assert.rejects(
      billingStore.createLedgerEntry({
        userId,
        kind: 'manual_adjustment',
        amountMicros: '1000',
        note: `unsafe-${'\u0000'}`,
      }),
      /note contains unsupported control characters/,
    )
  } finally {
    await cleanupBillingPrefix(pool, prefix, accountId, userId)
    await usageStore.close()
    await userStore.close()
    await billingStore.close()
    await pool.end()
  }
})
