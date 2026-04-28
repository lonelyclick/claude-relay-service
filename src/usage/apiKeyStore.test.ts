import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import dotenv from 'dotenv'
import pg from 'pg'

import { ApiKeyStore } from './apiKeyStore.js'

const dotenvResult = dotenv.config()
const databaseUrl = process.env.DATABASE_URL ?? dotenvResult.parsed?.DATABASE_URL ?? null
const hasDatabase = Boolean(databaseUrl)

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('ApiKeyStore serializes concurrent rotateLatestForUser per user', { skip: !hasDatabase }, async () => {
  assert.ok(databaseUrl)

  const userId = `api-key-rotate-${crypto.randomUUID()}`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  const blocker = await pool.connect()
  const apiKeyStore = new ApiKeyStore(databaseUrl)
  let blockerTxnOpen = false

  await apiKeyStore.ensureTable()

  try {
    const initialKey = await apiKeyStore.create(userId, { name: 'Initial Key' })

    await blocker.query('BEGIN')
    blockerTxnOpen = true
    await blocker.query(
      `SELECT id
       FROM relay_api_keys
       WHERE id = $1
       FOR UPDATE`,
      [initialKey.id],
    )

    const firstRotationPromise = apiKeyStore.rotateLatestForUser(userId, { name: 'Rotate One' })
    await sleep(50)
    const secondRotationPromise = apiKeyStore.rotateLatestForUser(userId, { name: 'Rotate Two' })
    await sleep(50)

    await blocker.query('COMMIT')
    blockerTxnOpen = false

    const [firstRotation, secondRotation] = await Promise.all([
      firstRotationPromise,
      secondRotationPromise,
    ])

    assert.equal(firstRotation.previousActiveCount, 1)
    assert.equal(secondRotation.previousActiveCount, 1)
    assert.notEqual(firstRotation.created.id, secondRotation.created.id)

    const activeKeys = await apiKeyStore.listForUser(userId)
    assert.equal(activeKeys.length, 1)
    const activeKey = activeKeys[0]
    assert.ok(activeKey)
    assert.ok([firstRotation.created.id, secondRotation.created.id].includes(activeKey.id))
    assert.notEqual(activeKey.id, initialKey.id)

    const rows = await pool.query<{
      id: string
      revoked_at: Date | null
    }>(
      `SELECT id, revoked_at
       FROM relay_api_keys
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId],
    )
    assert.equal(rows.rows.length, 3)
    assert.equal(rows.rows.filter((row) => row.revoked_at === null).length, 1)
    assert.ok(rows.rows.some((row) => row.id === initialKey.id && row.revoked_at !== null))

    const firstLookup = await apiKeyStore.lookupByKey(firstRotation.created.apiKey)
    const secondLookup = await apiKeyStore.lookupByKey(secondRotation.created.apiKey)
    const activeLookupIds = [
      firstLookup?.keyId ?? null,
      secondLookup?.keyId ?? null,
    ].filter((keyId): keyId is string => Boolean(keyId))
    assert.equal(activeLookupIds.length, 1)
    assert.equal(activeLookupIds[0], activeKey.id)
  } finally {
    if (blockerTxnOpen) {
      await blocker.query('ROLLBACK').catch(() => {})
    }
    blocker.release()
    await pool.query('DELETE FROM relay_api_keys WHERE user_id = $1', [userId]).catch(() => {})
    await apiKeyStore.close()
    await pool.end()
  }
})
