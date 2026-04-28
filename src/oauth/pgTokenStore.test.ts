import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { appConfig } from '../config.js'
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
