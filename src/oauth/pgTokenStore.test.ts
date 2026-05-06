import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { appConfig } from '../config.js'
import { ApiKeyStore } from '../usage/apiKeyStore.js'
import { BillingStore } from '../billing/billingStore.js'
import { UsageStore } from '../usage/usageStore.js'
import { UserStore } from '../usage/userStore.js'
import { PgTokenStore } from './pgTokenStore.js'

const hasDatabase = Boolean(appConfig.databaseUrl)

test('PgTokenStore normalizes legacy account scheduling fields when reading JSON rows', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const accountId = `pg-token-store-test-${crypto.randomUUID()}`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  const tokenStore = new PgTokenStore(databaseUrl)

  try {
    await pool.query(
      `INSERT INTO accounts (id, data, created_at, updated_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())`,
      [
        accountId,
        JSON.stringify({
          id: accountId,
          provider: 'claude-official',
          label: 'legacy-account',
          isActive: true,
          status: 'active',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: null,
          scopes: [],
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          accountUuid: accountId,
          organizationUuid: `org-${accountId}`,
          emailAddress: `${accountId}@example.com`,
          displayName: accountId,
          schedulerEnabled: null,
          schedulerState: 'paused',
          autoBlockedReason: null,
          lastRateLimitStatus: null,
          proxyUrl: 'http://127.0.0.1:10810',
        }),
      ],
    )

    const data = await tokenStore.getData()
    const account = data.accounts.find((item) => item.id === accountId)
    assert.ok(account)
    assert.equal(account?.schedulerEnabled, true)
    assert.equal(account?.schedulerState, 'paused')
    assert.equal(account?.protocol, 'claude')
    assert.equal(account?.authMode, 'oauth')
    assert.equal(account?.subscriptionType, null)
  } finally {
    await pool.query('DELETE FROM accounts WHERE id = $1', [accountId])
    await pool.end()
    await tokenStore.close()
  }
})

test('PgTokenStore.renameRoutingGroup cascades atomically across routing_groups, accounts (JSONB), relay_users, relay_api_keys, billing_channel_multipliers, billing_line_items, and usage_records', { skip: !hasDatabase }, async () => {
  const databaseUrl = appConfig.databaseUrl
  assert.ok(databaseUrl)

  const suffix = crypto.randomUUID()
  const oldId = `rg-old-${suffix}`
  const newId = `rg-new-${suffix}`
  const accountId = `acct-${suffix}`
  const userId = `user-${suffix}`
  const apiKeyId = `apikey-${suffix}`
  const requestId = `req-${suffix}`
  const channelId = `${oldId}:anthropic_messages:anthropic:claude-rename-${suffix}`

  const tokenStore = new PgTokenStore(databaseUrl)
  const userStore = new UserStore(databaseUrl)
  const apiKeyStore = new ApiKeyStore(databaseUrl)
  const usageStore = new UsageStore(databaseUrl)
  const billingStore = new BillingStore(databaseUrl)
  await userStore.ensureTable()
  await apiKeyStore.ensureTable()
  await usageStore.ensureTable()
  await billingStore.ensureTables()
  await tokenStore.getRoutingGroups()

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  let usageRecordId: number | null = null

  try {
    await pool.query(
      `INSERT INTO routing_groups (id, name, type, is_active) VALUES ($1, $1, 'anthropic', true)`,
      [oldId],
    )

    await pool.query(
      `INSERT INTO accounts (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, NOW(), NOW())`,
      [
        accountId,
        JSON.stringify({
          id: accountId,
          provider: 'claude-official',
          isActive: true,
          status: 'active',
          accessToken: 'tok',
          refreshToken: null,
          expiresAt: null,
          scopes: [],
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          accountUuid: accountId,
          organizationUuid: null,
          emailAddress: null,
          displayName: null,
          routingGroupId: oldId,
          group: oldId,
        }),
      ],
    )

    await pool.query(
      `INSERT INTO relay_users (id, api_key, name, routing_mode, routing_group_id, preferred_group, is_active)
       VALUES ($1, $2, $3, 'preferred_group', $4, $4, true)`,
      [userId, `rk_${crypto.randomBytes(16).toString('hex')}`, `rename-${suffix}`, oldId],
    )

    await pool.query(
      `INSERT INTO relay_api_keys (id, user_id, key_hash, key_preview, name, anthropic_group_id, openai_group_id, google_group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [apiKeyId, userId, crypto.randomBytes(16).toString('hex'), 'preview', `rename-key-${suffix}`, oldId, oldId],
    )

    await pool.query(
      `INSERT INTO billing_channel_multipliers (id, routing_group_id, provider, model_vendor, protocol, model, multiplier_micros, is_active)
       VALUES ($1, $2, 'anthropic', 'anthropic', 'anthropic_messages', $3, 1000000, true)`,
      [channelId, oldId, `claude-rename-${suffix}`],
    )

    const usageInsert = await pool.query<{ id: number }>(
      `INSERT INTO usage_records (request_id, account_id, routing_group_id, target, model, status_code, duration_ms)
       VALUES ($1, $2, $3, 'anthropic', $4, 200, 100) RETURNING id`,
      [requestId, accountId, oldId, `claude-rename-${suffix}`],
    )
    usageRecordId = usageInsert.rows[0].id

    await pool.query(
      `INSERT INTO billing_line_items (
         usage_record_id, request_id, user_id, account_id, provider, model, routing_group_id,
         target, status, currency, usage_created_at
       ) VALUES ($1, $2, $3, $4, 'anthropic', $5, $6, 'anthropic', 'billed', 'USD', NOW())`,
      [usageRecordId, requestId, userId, accountId, `claude-rename-${suffix}`, oldId],
    )

    const renamed = await tokenStore.renameRoutingGroup(oldId, newId)
    assert.ok(renamed)
    assert.equal(renamed?.id, newId)

    const rgNew = await pool.query('SELECT id FROM routing_groups WHERE id = $1', [newId])
    assert.equal(rgNew.rows.length, 1)
    const rgOld = await pool.query('SELECT id FROM routing_groups WHERE id = $1', [oldId])
    assert.equal(rgOld.rows.length, 0)

    const acct = await pool.query<{ rg: string; g: string }>(
      `SELECT data->>'routingGroupId' AS rg, data->>'group' AS g FROM accounts WHERE id = $1`,
      [accountId],
    )
    assert.equal(acct.rows[0].rg, newId)
    assert.equal(acct.rows[0].g, newId)

    const user = await pool.query<{ rgi: string; pg: string }>(
      `SELECT routing_group_id AS rgi, preferred_group AS pg FROM relay_users WHERE id = $1`,
      [userId],
    )
    assert.equal(user.rows[0].rgi, newId)
    assert.equal(user.rows[0].pg, newId)

    const apik = await pool.query<{ a: string | null; o: string | null }>(
      `SELECT anthropic_group_id AS a, openai_group_id AS o FROM relay_api_keys WHERE id = $1`,
      [apiKeyId],
    )
    assert.equal(apik.rows[0].a, newId)
    assert.equal(apik.rows[0].o, newId)

    const channel = await pool.query<{ id: string; rgi: string }>(
      `SELECT id, routing_group_id AS rgi FROM billing_channel_multipliers WHERE routing_group_id = $1`,
      [newId],
    )
    assert.equal(channel.rows.length, 1)
    assert.equal(channel.rows[0].rgi, newId)
    assert.equal(channel.rows[0].id, `${newId}:anthropic_messages:anthropic:claude-rename-${suffix}`)

    const lineItem = await pool.query<{ rgi: string }>(
      `SELECT routing_group_id AS rgi FROM billing_line_items WHERE usage_record_id = $1`,
      [usageRecordId],
    )
    assert.equal(lineItem.rows[0].rgi, newId)

    const usage = await pool.query<{ rgi: string }>(
      `SELECT routing_group_id AS rgi FROM usage_records WHERE id = $1`,
      [usageRecordId],
    )
    assert.equal(usage.rows[0].rgi, newId)
  } finally {
    if (usageRecordId !== null) {
      await pool.query('DELETE FROM billing_line_items WHERE usage_record_id = $1', [usageRecordId]).catch(() => {})
      await pool.query('DELETE FROM usage_records WHERE id = $1', [usageRecordId]).catch(() => {})
    }
    await pool
      .query(`DELETE FROM billing_channel_multipliers WHERE routing_group_id IN ($1, $2)`, [oldId, newId])
      .catch(() => {})
    await pool.query('DELETE FROM relay_api_keys WHERE id = $1', [apiKeyId]).catch(() => {})
    await pool.query('DELETE FROM relay_users WHERE id = $1', [userId]).catch(() => {})
    await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]).catch(() => {})
    await pool.query('DELETE FROM routing_groups WHERE id IN ($1, $2)', [oldId, newId]).catch(() => {})
    await pool.end()
    await tokenStore.close()
    await userStore.close().catch(() => {})
    await apiKeyStore.close().catch(() => {})
    await usageStore.close().catch(() => {})
    await billingStore.close().catch(() => {})
  }
})
