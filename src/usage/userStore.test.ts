import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import dotenv from 'dotenv'
import pg from 'pg'

import { UsageStore } from './usageStore.js'
import { UserStore } from './userStore.js'

const dotenvResult = dotenv.config()
const databaseUrl = process.env.DATABASE_URL ?? dotenvResult.parsed?.DATABASE_URL ?? null
const hasDatabase = Boolean(databaseUrl)

test('UserStore rejects unsafe user input before persisting', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const userStore = new UserStore(databaseUrl)
  await userStore.ensureTable()

  let userId: string | null = null
  try {
    await assert.rejects(
      userStore.createUser('bad\nname'),
      /name contains unsupported control characters/,
    )

    const user = await userStore.createUser(`safe-${crypto.randomUUID()}`, 'rmb')
    userId = user.id
    assert.equal(user.billingCurrency, 'CNY')

    await assert.rejects(
      userStore.updateUser(user.id, { routingMode: '[object Object]' as never }),
      /routingMode is invalid/,
    )
    await assert.rejects(
      userStore.updateUser(user.id, { billingCurrency: 'EUR' }),
      /billingCurrency must be one of: USD, CNY/,
    )
  } finally {
    if (userId) {
      await userStore.deleteUser(userId).catch(() => {})
    }
    await userStore.close()
  }
})

test('UserStore persists billing currency on create and update', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const userStore = new UserStore(databaseUrl)
  await userStore.ensureTable()

  const user = await userStore.createUser(`billing-currency-${crypto.randomUUID()}`, 'USD')
  try {
    assert.equal(user.billingCurrency, 'USD')

    const updated = await userStore.updateUser(user.id, { billingCurrency: 'CNY' })
    assert.ok(updated)
    assert.equal(updated?.billingCurrency, 'CNY')

    const loaded = await userStore.getUserById(user.id)
    assert.equal(loaded?.billingCurrency, 'CNY')
  } finally {
    await userStore.deleteUser(user.id).catch(() => {})
    await userStore.close()
  }
})

test('UserStore keeps routing_group_id and preferred_group in sync', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const userStore = new UserStore(databaseUrl)
  const user = await userStore.createUser(`routing-group-${crypto.randomUUID()}`)

  const updated = await userStore.updateUser(user.id, {
    routingMode: 'preferred_group',
    routingGroupId: 'team-a',
  })

  assert.ok(updated)
  assert.equal(updated?.routingMode, 'preferred_group')
  assert.equal(updated?.routingGroupId, 'team-a')
  assert.equal(updated?.preferredGroup, 'team-a')

  const loaded = await userStore.getUserById(user.id)
  assert.ok(loaded)
  assert.equal(loaded?.routingGroupId, 'team-a')
  assert.equal(loaded?.preferredGroup, 'team-a')

  await userStore.deleteUser(user.id)
})

test('UserStore persists session routes, burn tracking, and handoff summaries', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const prefix = `user-store-test-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const sessionKey = `${prefix}-session`
  const accountA = `${prefix}-account-a`
  const accountB = `${prefix}-account-b`
  const accountC = `${prefix}-account-c`
  const clientDeviceId = `${prefix}-device`
  const apiKey = `rk_${crypto.randomBytes(16).toString('hex')}`
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })

  await usageStore.ensureTable()
  await userStore.ensureTable()

  try {
    await pool.query(
      `INSERT INTO relay_users (id, api_key, name, routing_mode, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, apiKey, `${prefix}-name`, 'auto', true],
    )

    const route = await userStore.ensureSessionRoute({
      sessionKey,
      userId,
      clientDeviceId,
      accountId: accountA,
    })
    assert.equal(route.generation, 1)
    assert.equal(route.accountId, accountA)
    assert.equal(route.clientDeviceId, clientDeviceId)

    const initialGuard = await userStore.getRoutingGuardSnapshot({
      userId,
      clientDeviceId,
    })
    assert.equal(initialGuard.userActiveSessions, 1)
    assert.equal(initialGuard.clientDeviceActiveSessions, 1)

    await usageStore.insertRecord({
      requestId: `${prefix}-request-1`,
      accountId: accountA,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 12,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 800,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.2,
      rateLimit7dUtilization: 0.3,
      rateLimitReset: 1776074400,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"hello from stored usage"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: `${prefix}-request-1b`,
      accountId: accountA,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 750,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.22,
      rateLimit7dUtilization: 0.31,
      rateLimitReset: 1776074410,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"hello again from account a"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: `${prefix}-request-legacy`,
      accountId: accountA,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 4,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 400,
      durationMs: 300,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.23,
      rateLimit7dUtilization: 0.32,
      rateLimitReset: 1776074415,
      requestHeaders: null,
      requestBodyPreview: '{"system":[{"type":"text","text":"relay_handoff_summary=true\\n这是 relay 在本地生成的会话交接摘要。"}],"messages":[{"role":"assistant","content":"already summarized state"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    const firstUsage = await userStore.noteSessionRouteUsage({
      sessionKey,
      userId,
      clientDeviceId,
      accountId: accountA,
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.2,
      rateLimit7dUtilization: 0.3,
    })
    assert.ok(firstUsage)
    assert.equal(firstUsage?.generationBurn7d, 0)

    const secondUsage = await userStore.noteSessionRouteUsage({
      sessionKey,
      userId,
      clientDeviceId,
      accountId: accountA,
      rateLimitStatus: 'allowed_warning',
      rateLimit5hUtilization: 0.25,
      rateLimit7dUtilization: 0.4,
    })
    assert.ok(secondUsage)
    assert.equal(secondUsage?.generationBurn5h, 0.05)
    assert.equal(secondUsage?.generationBurn7d, 0.1)
    assert.ok((secondUsage?.predictedBurn7d ?? 0) > 0)

    const summary = await userStore.buildSessionHandoffSummary({
      sessionKey,
      fromAccountId: accountA,
      currentRequestBodyPreview: '{"messages":[{"role":"user","content":"new prompt for handoff"}]}',
    })
    assert.match(summary, /压缩背景/)
    assert.match(summary, /hello again from account a/)
    assert.match(summary, /already summarized state/)
    assert.doesNotMatch(summary, /relay_handoff_summary=true/)
    assert.doesNotMatch(summary, /原账号：/)
    assert.doesNotMatch(summary, /new prompt for handoff/)

    const migrated = await userStore.migrateSessionRoute({
      sessionKey,
      userId,
      clientDeviceId,
      fromAccountId: accountA,
      toAccountId: accountB,
      reason: 'rate_limit_rejected',
      summary,
    })
    assert.equal(migrated.generation, 2)
    assert.equal(migrated.accountId, accountB)
    assert.equal(migrated.clientDeviceId, clientDeviceId)
    assert.equal(migrated.pendingHandoffSummary, summary)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: `${prefix}-request-2`,
      accountId: accountB,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 20,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 600,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.3,
      rateLimit7dUtilization: 0.45,
      rateLimitReset: 1776074500,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"hello from migrated account"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: `${prefix}-request-3`,
      accountId: accountB,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 18,
      outputTokens: 6,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 640,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.28,
      rateLimit7dUtilization: 0.42,
      rateLimitReset: 1776074510,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"hello again from account b"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await usageStore.insertRecord({
      requestId: `${prefix}-request-ignored`,
      accountId: accountC,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 1,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 100,
      target: '/v1/messages/count_tokens',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.05,
      rateLimit7dUtilization: 0.05,
      rateLimitReset: 1776074520,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[]}',
      responseHeaders: null,
      responseBodyPreview: '{"input_tokens":1}',
      upstreamRequestHeaders: null,
    })

    const preferredAccountIds = await userStore.getPreferredAccountIdsForClientDevice({
      userId,
      clientDeviceId,
    })
    assert.deepEqual(preferredAccountIds, [accountB, accountA])

    await usageStore.insertRecord({
      requestId: `${prefix}-request-bad-request`,
      accountId: accountA,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 400,
      durationMs: 120,
      target: '/v1/messages',
      rateLimitStatus: null,
      rateLimit5hUtilization: null,
      rateLimit7dUtilization: null,
      rateLimitReset: null,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"bad request"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"error":{"message":"invalid request"}}',
      upstreamRequestHeaders: null,
    })

    const preferredAfterBadRequest = await userStore.getPreferredAccountIdsForClientDevice({
      userId,
      clientDeviceId,
    })
    assert.deepEqual(preferredAfterBadRequest, [accountB, accountA])

    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: `${prefix}-request-3`,
      accountId: accountC,
      userId,
      sessionKey,
      clientDeviceId,
      attemptKind: 'retry_failure',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 429,
      durationMs: 300,
      target: '/v1/messages',
      rateLimitStatus: 'rejected',
      rateLimit5hUtilization: 1,
      rateLimit7dUtilization: 1,
      rateLimitReset: 1776074515,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"intermediate failure"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"error":{"message":"retry me"}}',
      upstreamRequestHeaders: null,
    })

    await usageStore.insertRecord({
      requestId: `${prefix}-request-penalty`,
      accountId: accountB,
      userId,
      sessionKey,
      clientDeviceId,
      model: 'claude-sonnet-4-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 429,
      durationMs: 200,
      target: '/v1/sessions/ws',
      rateLimitStatus: 'rejected',
      rateLimit5hUtilization: 1,
      rateLimit7dUtilization: 1,
      rateLimitReset: 1776074600,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"penalty"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"error":{"message":"rate limited"}}',
      upstreamRequestHeaders: null,
    })

    const preferredAfterPenalty = await userStore.getPreferredAccountIdsForClientDevice({
      userId,
      clientDeviceId,
    })
    assert.deepEqual(preferredAfterPenalty, [accountA])

    const userRequests = await userStore.getUserRequests(userId, 20, 0)
    assert.equal(userRequests.total, 8)
    assert.equal(userRequests.requests[0]?.clientDeviceId, clientDeviceId)

    const sessionRequests = await userStore.getSessionRequests(userId, sessionKey, 20, 0)
    assert.equal(sessionRequests.total, 8)
    assert.equal(sessionRequests.requests[0]?.clientDeviceId, clientDeviceId)

    const sessions = await userStore.getUserSessions(userId)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.sessionKey, sessionKey)
    assert.equal(sessions[0]?.accountId, accountB)
    assert.equal(sessions[0]?.clientDeviceId, clientDeviceId)
    assert.equal(sessions[0]?.requestCount, 8)

    const requestDetail = await userStore.getRequestDetail(userId, `${prefix}-request-3`)
    assert.ok(requestDetail)
    assert.equal(requestDetail?.statusCode, 200)
    assert.equal(requestDetail?.clientDeviceId, clientDeviceId)

    const budgetSnapshot = await userStore.getRoutingGuardSnapshot({
      userId,
      clientDeviceId,
    })
    assert.equal(budgetSnapshot.userRecentRequests, 7)
    assert.equal(budgetSnapshot.clientDeviceRecentRequests, 7)
    assert.equal(budgetSnapshot.userRecentTokens, 88)
    assert.equal(budgetSnapshot.clientDeviceRecentTokens, 88)

    const userGuard = (await userStore.listRoutingGuardUserStats(20)).find(
      (item) => item.userId === userId,
    )
    assert.ok(userGuard)
    assert.equal(userGuard.userId, userId)
    assert.equal(userGuard.activeSessions, 1)
    assert.equal(userGuard.recentRequests, 7)
    assert.equal(userGuard.recentTokens, 88)

    const deviceGuard = (await userStore.listRoutingGuardDeviceStats(20)).find(
      (item) => item.userId === userId && item.clientDeviceId === clientDeviceId,
    )
    assert.ok(deviceGuard)
    assert.equal(deviceGuard.userId, userId)
    assert.equal(deviceGuard.clientDeviceId, clientDeviceId)
    assert.equal(deviceGuard.activeSessions, 1)
    assert.equal(deviceGuard.recentRequests, 7)
    assert.equal(deviceGuard.recentTokens, 88)

    const handoffs = await userStore.listSessionHandoffs(10)
    const handoff = handoffs.find((item) => item.sessionKey === sessionKey)
    assert.ok(handoff)
    assert.equal(handoff?.fromAccountId, accountA)
    assert.equal(handoff?.toAccountId, accountB)
    assert.equal(handoff?.reason, 'rate_limit_rejected')

    await userStore.clearPendingHandoffSummary(sessionKey)
    const cleared = await userStore.getSessionRoute(sessionKey)
    assert.equal(cleared?.pendingHandoffSummary, null)

    const preparedCount = await userStore.prepareSessionRoutesForAccountHandoff({
      accountId: accountB,
      reason: 'rate_limit:rejected',
    })
    assert.equal(preparedCount, 1)

    const prepared = await userStore.getSessionRoute(sessionKey)
    assert.ok(prepared?.pendingHandoffSummary)
    assert.equal(prepared?.lastHandoffReason, 'rate_limit:rejected')
    assert.match(prepared?.pendingHandoffSummary ?? '', /压缩背景/)
  } finally {
    await pool.query('DELETE FROM session_handoffs WHERE session_key = $1', [sessionKey])
    await pool.query('DELETE FROM session_routes WHERE session_key = $1', [sessionKey])
    await pool.query('DELETE FROM usage_records WHERE session_key = $1 OR user_id = $2 OR request_id LIKE $3', [
      sessionKey,
      userId,
      `${prefix}%`,
    ])
    await pool.query('DELETE FROM relay_users WHERE id = $1', [userId])
    await pool.end()
    await usageStore.close()
    await userStore.close()
  }
})

test('UserStore getRequestDetail can disambiguate duplicate request ids with usageRecordId', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const prefix = `user-store-request-detail-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const accountId = `${prefix}-account`
  const requestId = `${prefix}-shared-request`
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })

  await usageStore.ensureTable()
  await userStore.ensureTable()

  try {
    await pool.query(
      `INSERT INTO relay_users (id, api_key, name, routing_mode, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, `rk_${crypto.randomBytes(16).toString('hex')}`, `${prefix}-name`, 'auto', true],
    )

    await usageStore.insertRecord({
      requestId,
      accountId,
      userId,
      sessionKey: `${prefix}-session-a`,
      clientDeviceId: `${prefix}-device-a`,
      model: 'claude-sonnet-4-5',
      inputTokens: 11,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 400,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.1,
      rateLimit7dUtilization: 0.1,
      rateLimitReset: 1776074400,
      requestHeaders: null,
      requestBodyPreview: '{"index":1}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId,
      accountId,
      userId,
      sessionKey: `${prefix}-session-b`,
      clientDeviceId: `${prefix}-device-b`,
      model: 'claude-sonnet-4-5',
      inputTokens: 22,
      outputTokens: 6,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 500,
      target: '/v1/messages',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.2,
      rateLimit7dUtilization: 0.2,
      rateLimitReset: 1776074410,
      requestHeaders: null,
      requestBodyPreview: '{"index":2}',
      responseHeaders: null,
      responseBodyPreview: '{"ok":true}',
      upstreamRequestHeaders: null,
    })

    const recordIds = await pool.query<{ id: string }>(
      `SELECT id
       FROM usage_records
       WHERE user_id = $1
         AND request_id = $2
         AND COALESCE(attempt_kind, 'final') = 'final'
       ORDER BY created_at ASC, id ASC`,
      [userId, requestId],
    )
    assert.equal(recordIds.rows.length, 2)

    const earliestUsageRecordId = Number(recordIds.rows[0]?.id)
    const latestUsageRecordId = Number(recordIds.rows[1]?.id)

    const latestDetail = await userStore.getRequestDetail(userId, requestId)
    assert.ok(latestDetail)
    assert.equal(latestDetail?.usageRecordId, latestUsageRecordId)
    assert.equal(latestDetail?.clientDeviceId, `${prefix}-device-b`)

    const exactDetail = await userStore.getRequestDetail(userId, requestId, earliestUsageRecordId)
    assert.ok(exactDetail)
    assert.equal(exactDetail?.usageRecordId, earliestUsageRecordId)
    assert.equal(exactDetail?.clientDeviceId, `${prefix}-device-a`)
    assert.equal(exactDetail?.requestBodyPreview, '{"index":1}')
  } finally {
    await pool.query('DELETE FROM usage_records WHERE user_id = $1 OR request_id LIKE $2', [userId, `${prefix}%`]).catch(() => {})
    await pool.query('DELETE FROM relay_users WHERE id = $1', [userId]).catch(() => {})
    await pool.end()
    await usageStore.close()
    await userStore.close()
  }
})

test('UserStore filters relay_key_source from DB-backed usage records', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const prefix = `user-store-relay-key-source-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const sessionKey = `${prefix}-session`
  const primaryRequestId = `${prefix}-request-primary`
  const legacyRequestId = `${prefix}-request-legacy`
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })

  await usageStore.ensureTable()
  await userStore.ensureTable()

  try {
    await pool.query(
      `INSERT INTO relay_users (id, api_key, name, routing_mode, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, `rk_${crypto.randomBytes(16).toString('hex')}`, `${prefix}-name`, 'auto', true],
    )

    await usageStore.insertRecord({
      requestId: primaryRequestId,
      accountId: `${prefix}-account`,
      userId,
      sessionKey,
      clientDeviceId: `${prefix}-device`,
      relayKeySource: 'relay_api_keys',
      model: 'gpt-4.1',
      inputTokens: 12,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 320,
      target: '/v1/chat/completions',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.2,
      rateLimit7dUtilization: 0.1,
      rateLimitReset: 1776074500,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"hello"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"id":"chatcmpl-1"}',
      upstreamRequestHeaders: null,
    })

    const primaryOnlySummary = await userStore.getUserRelayKeySourceSummary(userId)
    assert.deepEqual(primaryOnlySummary, {
      recentWindowLimit: 100,
      countedRequests: 1,
      relayApiKeysCount: 1,
      legacyFallbackCount: 0,
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: legacyRequestId,
      accountId: `${prefix}-account`,
      userId,
      sessionKey,
      clientDeviceId: `${prefix}-device`,
      relayKeySource: 'relay_users_legacy',
      model: 'gpt-4.1',
      inputTokens: 8,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 280,
      target: '/v1/chat/completions',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.25,
      rateLimit7dUtilization: 0.12,
      rateLimitReset: 1776074510,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"legacy"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"id":"chatcmpl-2"}',
      upstreamRequestHeaders: null,
    })

    const persisted = await pool.query<{ request_id: string; relay_key_source: string | null }>(
      `SELECT request_id, relay_key_source
       FROM usage_records
       WHERE user_id = $1
         AND request_id LIKE $2
       ORDER BY created_at ASC, id ASC`,
      [userId, `${prefix}-request-%`],
    )
    assert.deepEqual(
      persisted.rows.map((row) => ({
        requestId: row.request_id,
        relayKeySource: row.relay_key_source,
      })),
      [
        { requestId: primaryRequestId, relayKeySource: 'relay_api_keys' },
        { requestId: legacyRequestId, relayKeySource: 'relay_users_legacy' },
      ],
    )

    const requests = await userStore.getUserRequests(userId, 10, 0)
    assert.equal(requests.total, 2)
    assert.deepEqual(
      requests.requests.map((request) => request.relayKeySource),
      ['relay_users_legacy', 'relay_api_keys'],
    )

    const relayKeySourceSummary = await userStore.getUserRelayKeySourceSummary(userId)
    assert.deepEqual(relayKeySourceSummary, {
      recentWindowLimit: 100,
      countedRequests: 2,
      relayApiKeysCount: 1,
      legacyFallbackCount: 1,
    })

    const primaryRequests = await userStore.getUserRequests(userId, 10, 0, 'relay_api_keys')
    assert.equal(primaryRequests.total, 1)
    assert.equal(primaryRequests.requests[0]?.requestId, primaryRequestId)
    assert.equal(primaryRequests.requests[0]?.relayKeySource, 'relay_api_keys')

    const legacyRequests = await userStore.getUserRequests(userId, 10, 0, 'relay_users_legacy')
    assert.equal(legacyRequests.total, 1)
    assert.equal(legacyRequests.requests[0]?.requestId, legacyRequestId)
    assert.equal(legacyRequests.requests[0]?.relayKeySource, 'relay_users_legacy')

    const sessionRequests = await userStore.getSessionRequests(userId, sessionKey, 10, 0)
    assert.equal(sessionRequests.total, 2)
    assert.deepEqual(
      sessionRequests.requests.map((request) => request.relayKeySource),
      ['relay_users_legacy', 'relay_api_keys'],
    )

    const filteredSessionRequests = await userStore.getSessionRequests(userId, sessionKey, 10, 0, 'relay_users_legacy')
    assert.equal(filteredSessionRequests.total, 1)
    assert.equal(filteredSessionRequests.requests[0]?.requestId, legacyRequestId)
    assert.equal(filteredSessionRequests.requests[0]?.relayKeySource, 'relay_users_legacy')

    const detail = await userStore.getRequestDetail(userId, primaryRequestId)
    assert.ok(detail)
    assert.equal(detail?.relayKeySource, 'relay_api_keys')
  } finally {
    await pool.query('DELETE FROM usage_records WHERE user_id = $1 OR request_id LIKE $2', [userId, `${prefix}%`]).catch(() => {})
    await pool.query('DELETE FROM relay_users WHERE id = $1', [userId]).catch(() => {})
    await pool.end()
    await usageStore.close()
    await userStore.close()
  }
})

test('UserStore listUsersWithUsage includes relay key source summary for each user', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const prefix = `user-store-list-summary-${crypto.randomUUID()}`
  const legacyUserId = `${prefix}-legacy-user`
  const primaryUserId = `${prefix}-primary-user`
  const idleUserId = `${prefix}-idle-user`
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })

  await usageStore.ensureTable()
  await userStore.ensureTable()

  try {
    await pool.query(
      `INSERT INTO relay_users (id, api_key, name, routing_mode, is_active)
       VALUES
         ($1, $2, $3, $4, $5),
         ($6, $7, $8, $9, $10),
         ($11, $12, $13, $14, $15)`,
      [
        legacyUserId, `rk_${crypto.randomBytes(16).toString('hex')}`, `${prefix}-legacy`, 'auto', true,
        primaryUserId, `rk_${crypto.randomBytes(16).toString('hex')}`, `${prefix}-primary`, 'auto', true,
        idleUserId, `rk_${crypto.randomBytes(16).toString('hex')}`, `${prefix}-idle`, 'auto', true,
      ],
    )

    await usageStore.insertRecord({
      requestId: `${prefix}-legacy-primary`,
      accountId: `${prefix}-account`,
      userId: legacyUserId,
      sessionKey: `${prefix}-legacy-session`,
      clientDeviceId: `${prefix}-legacy-device`,
      relayKeySource: 'relay_api_keys',
      model: 'gpt-4.1',
      inputTokens: 10,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 210,
      target: '/v1/chat/completions',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.1,
      rateLimit7dUtilization: 0.1,
      rateLimitReset: 1776074600,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"primary"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"id":"chatcmpl-primary"}',
      upstreamRequestHeaders: null,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: `${prefix}-legacy-fallback`,
      accountId: `${prefix}-account`,
      userId: legacyUserId,
      sessionKey: `${prefix}-legacy-session`,
      clientDeviceId: `${prefix}-legacy-device`,
      relayKeySource: 'relay_users_legacy',
      model: 'gpt-4.1',
      inputTokens: 6,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 190,
      target: '/v1/chat/completions',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.12,
      rateLimit7dUtilization: 0.11,
      rateLimitReset: 1776074610,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"legacy"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"id":"chatcmpl-legacy"}',
      upstreamRequestHeaders: null,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await usageStore.insertRecord({
      requestId: `${prefix}-primary-only`,
      accountId: `${prefix}-account`,
      userId: primaryUserId,
      sessionKey: `${prefix}-primary-session`,
      clientDeviceId: `${prefix}-primary-device`,
      relayKeySource: 'relay_api_keys',
      model: 'gpt-4.1',
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      durationMs: 180,
      target: '/v1/chat/completions',
      rateLimitStatus: 'allowed',
      rateLimit5hUtilization: 0.09,
      rateLimit7dUtilization: 0.08,
      rateLimitReset: 1776074620,
      requestHeaders: null,
      requestBodyPreview: '{"messages":[{"role":"user","content":"only primary"}]}',
      responseHeaders: null,
      responseBodyPreview: '{"id":"chatcmpl-primary-only"}',
      upstreamRequestHeaders: null,
    })

    const users = await userStore.listUsersWithUsage()
    const legacyUser = users.find((user) => user.id === legacyUserId)
    const primaryUser = users.find((user) => user.id === primaryUserId)
    const idleUser = users.find((user) => user.id === idleUserId)

    assert.ok(legacyUser)
    assert.equal(legacyUser?.totalRequests, 2)
    assert.deepEqual(legacyUser?.relayKeySourceSummary, {
      recentWindowLimit: 100,
      countedRequests: 2,
      relayApiKeysCount: 1,
      legacyFallbackCount: 1,
    })

    assert.ok(primaryUser)
    assert.equal(primaryUser?.totalRequests, 1)
    assert.deepEqual(primaryUser?.relayKeySourceSummary, {
      recentWindowLimit: 100,
      countedRequests: 1,
      relayApiKeysCount: 1,
      legacyFallbackCount: 0,
    })

    assert.ok(idleUser)
    assert.equal(idleUser?.totalRequests, 0)
    assert.deepEqual(idleUser?.relayKeySourceSummary, {
      recentWindowLimit: 100,
      countedRequests: 0,
      relayApiKeysCount: 0,
      legacyFallbackCount: 0,
    })
  } finally {
    await pool.query('DELETE FROM usage_records WHERE user_id IN ($1, $2, $3) OR request_id LIKE $4', [
      legacyUserId,
      primaryUserId,
      idleUserId,
      `${prefix}-%`,
    ]).catch(() => {})
    await pool.query('DELETE FROM relay_users WHERE id IN ($1, $2, $3)', [
      legacyUserId,
      primaryUserId,
      idleUserId,
    ]).catch(() => {})
    await pool.end()
    await usageStore.close()
    await userStore.close()
  }
})

test('UserStore routing guard counts /v1/chat/completions usage alongside Claude paths', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)
  const prefix = `routing-guard-openai-${crypto.randomUUID()}`
  const userId = `${prefix}-user`
  const sessionKey = `${prefix}-session`
  const clientDeviceId = `${prefix}-device`
  const accountId = `${prefix}-account`
  const apiKey = `rk_${crypto.randomBytes(16).toString('hex')}`
  const usageStore = new UsageStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })

  await usageStore.ensureTable()
  await userStore.ensureTable()

  try {
    await pool.query(
      `INSERT INTO relay_users (id, api_key, name, routing_mode, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, apiKey, `${prefix}-name`, 'auto', true],
    )

    await userStore.ensureSessionRoute({ sessionKey, userId, clientDeviceId, accountId })

    const insertUsage = async (
      requestId: string,
      target: string,
      tokens: { input: number; output: number },
    ) => {
      await usageStore.insertRecord({
        requestId,
        accountId,
        userId,
        sessionKey,
        clientDeviceId,
        model: target === '/v1/chat/completions' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        statusCode: 200,
        durationMs: 100,
        target,
        rateLimitStatus: 'allowed',
        rateLimit5hUtilization: 0,
        rateLimit7dUtilization: 0,
        rateLimitReset: 0,
        requestHeaders: null,
        requestBodyPreview: null,
        responseHeaders: null,
        responseBodyPreview: null,
        upstreamRequestHeaders: null,
      })
    }

    await insertUsage(`${prefix}-claude-1`, '/v1/messages', { input: 10, output: 5 })
    await insertUsage(`${prefix}-openai-1`, '/v1/chat/completions', { input: 20, output: 8 })
    await insertUsage(`${prefix}-openai-2`, '/v1/chat/completions', { input: 12, output: 4 })
    await insertUsage(`${prefix}-count`, '/v1/messages/count_tokens', { input: 1, output: 0 })
    await insertUsage(`${prefix}-responses`, '/v1/responses', { input: 100, output: 100 })

    const expectedRequests = 3
    const expectedTokens = 10 + 5 + 20 + 8 + 12 + 4

    const snapshot = await userStore.getRoutingGuardSnapshot({ userId, clientDeviceId })
    assert.equal(snapshot.userRecentRequests, expectedRequests)
    assert.equal(snapshot.clientDeviceRecentRequests, expectedRequests)
    assert.equal(snapshot.userRecentTokens, expectedTokens)
    assert.equal(snapshot.clientDeviceRecentTokens, expectedTokens)

    const userGuard = (await userStore.listRoutingGuardUserStats(50)).find((row) => row.userId === userId)
    assert.ok(userGuard, 'expected user routing guard stats row')
    assert.equal(userGuard.recentRequests, expectedRequests)
    assert.equal(userGuard.recentTokens, expectedTokens)

    const deviceGuard = (await userStore.listRoutingGuardDeviceStats(50)).find(
      (row) => row.userId === userId && row.clientDeviceId === clientDeviceId,
    )
    assert.ok(deviceGuard, 'expected device routing guard stats row')
    assert.equal(deviceGuard.recentRequests, expectedRequests)
    assert.equal(deviceGuard.recentTokens, expectedTokens)
  } finally {
    await pool.query('DELETE FROM session_routes WHERE session_key = $1', [sessionKey]).catch(() => {})
    await pool.query('DELETE FROM usage_records WHERE user_id = $1 OR request_id LIKE $2', [userId, `${prefix}%`]).catch(() => {})
    await pool.query('DELETE FROM relay_users WHERE id = $1', [userId]).catch(() => {})
    await pool.end()
    await usageStore.close()
    await userStore.close()
  }
})
