import crypto from 'node:crypto'

import pg from 'pg'

const { Pool } = pg

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS relay_api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  key_preview  TEXT NOT NULL,
  name         TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_api_keys_hash
  ON relay_api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_relay_api_keys_user_active
  ON relay_api_keys (user_id, created_at DESC) WHERE revoked_at IS NULL;
`

export type RelayApiKey = {
  id: string
  userId: string
  name: string
  keyPreview: string
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export type CreatedApiKey = RelayApiKey & { apiKey: string }
export type RotatedApiKeyResult = {
  created: CreatedApiKey
  revoked: RelayApiKey | null
  previousActiveCount: number
}

const DEFAULT_MAX_KEYS_PER_USER = 100
const LOOKUP_CACHE_MAX = 4096

function generateApiKey(): string {
  return `rk_${crypto.randomBytes(32).toString('hex')}`
}

export function buildApiKeyRotationLockKey(userId: string): readonly [number, number] {
  const digest = crypto
    .createHash('sha256')
    .update(`relay_api_keys.rotate:${userId}`)
    .digest()
  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const
}

function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex')
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 14) return apiKey
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`
}

function newId(): string {
  return crypto.randomUUID()
}

function buildApiKeyName(options: { name?: string }, createdAtIso: string): string {
  return (options.name?.trim() || `Key ${createdAtIso.slice(0, 10)}`).slice(0, 60)
}

function rowToApiKey(row: Record<string, unknown>): RelayApiKey {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: (row.name as string) ?? '',
    keyPreview: (row.key_preview as string) ?? '',
    lastUsedAt: row.last_used_at ? (row.last_used_at as Date).toISOString() : null,
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

type CacheEntry = { keyId: string; userId: string }

export class ApiKeyStore {
  private readonly pool: pg.Pool
  private readonly maxKeysPerUser: number
  private readonly hashLookupCache = new Map<string, CacheEntry | null>()

  constructor(databaseUrl: string, options: { maxKeysPerUser?: number } = {}) {
    this.pool = new Pool({ connectionString: databaseUrl })
    this.maxKeysPerUser = options.maxKeysPerUser ?? DEFAULT_MAX_KEYS_PER_USER
  }

  async ensureTable(): Promise<void> {
    await this.pool.query(CREATE_TABLE_SQL)
  }

  async lookupByKey(apiKey: string): Promise<CacheEntry | null> {
    if (!apiKey || !apiKey.startsWith('rk_')) return null
    const hash = hashApiKey(apiKey)
    if (this.hashLookupCache.has(hash)) {
      return this.hashLookupCache.get(hash) ?? null
    }
    const { rows } = await this.pool.query(
      `SELECT id, user_id FROM relay_api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [hash],
    )
    const entry: CacheEntry | null = rows[0]
      ? { keyId: rows[0].id as string, userId: rows[0].user_id as string }
      : null
    if (this.hashLookupCache.size >= LOOKUP_CACHE_MAX) {
      const firstKey = this.hashLookupCache.keys().next().value
      if (firstKey !== undefined) this.hashLookupCache.delete(firstKey)
    }
    this.hashLookupCache.set(hash, entry)
    return entry
  }

  touchLastUsed(keyId: string): void {
    this.pool
      .query(
        `UPDATE relay_api_keys SET last_used_at = NOW() WHERE id = $1`,
        [keyId],
      )
      .catch(() => {
        // best-effort, never block the relay path
      })
  }

  async listForUser(userId: string): Promise<RelayApiKey[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM relay_api_keys
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [userId],
    )
    return rows.map(rowToApiKey)
  }

  async countActiveForUser(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM relay_api_keys
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    )
    return rows[0]?.n ?? 0
  }

  async create(userId: string, options: { name?: string } = {}): Promise<CreatedApiKey> {
    const active = await this.countActiveForUser(userId)
    if (active >= this.maxKeysPerUser) {
      const err = new Error(
        `已达 API Key 上限（${this.maxKeysPerUser}），请先撤销不再使用的 Key。`,
      )
      ;(err as Error & { code?: string }).code = 'api_key_quota_exceeded'
      throw err
    }
    const apiKey = generateApiKey()
    const id = newId()
    const createdAtIso = new Date().toISOString()
    const name = buildApiKeyName(options, createdAtIso)
    const keyHash = hashApiKey(apiKey)
    const keyPreview = maskApiKey(apiKey)
    const { rows } = await this.pool.query(
      `INSERT INTO relay_api_keys (id, user_id, key_hash, key_preview, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, userId, keyHash, keyPreview, name],
    )
    const record = rowToApiKey(rows[0])
    return { ...record, apiKey }
  }

  async rotateLatestForUser(
    userId: string,
    options: { name?: string } = {},
  ): Promise<RotatedApiKeyResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const [lockKeyA, lockKeyB] = buildApiKeyRotationLockKey(userId)
      // Serialize rotations per user across processes so a second request cannot
      // observe the old row disappearing before it sees the newly issued key.
      await client.query(
        'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
        [lockKeyA, lockKeyB],
      )
      const activeResult = await client.query(
        `SELECT * FROM relay_api_keys
         WHERE user_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC
         FOR UPDATE`,
        [userId],
      )
      const previousActiveCount = activeResult.rows.length
      let revoked: RelayApiKey | null = null
      const previousPrimary = activeResult.rows[0] ?? null

      if (previousActiveCount >= this.maxKeysPerUser && previousPrimary) {
        const revokeResult = await client.query(
          `UPDATE relay_api_keys
           SET revoked_at = NOW()
           WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [previousPrimary.id, userId],
        )
        revoked = revokeResult.rows[0] ? rowToApiKey(revokeResult.rows[0]) : null
      } else if (previousActiveCount >= this.maxKeysPerUser) {
        const err = new Error(
          `已达 API Key 上限（${this.maxKeysPerUser}），请先撤销不再使用的 Key。`,
        )
        ;(err as Error & { code?: string }).code = 'api_key_quota_exceeded'
        throw err
      }

      const apiKey = generateApiKey()
      const id = newId()
      const createdAtIso = new Date().toISOString()
      const name = buildApiKeyName(options, createdAtIso)
      const keyHash = hashApiKey(apiKey)
      const keyPreview = maskApiKey(apiKey)
      const insertResult = await client.query(
        `INSERT INTO relay_api_keys (id, user_id, key_hash, key_preview, name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, userId, keyHash, keyPreview, name],
      )
      const created = {
        ...rowToApiKey(insertResult.rows[0]),
        apiKey,
      }

      if (!revoked && previousPrimary) {
        const revokeResult = await client.query(
          `UPDATE relay_api_keys
           SET revoked_at = NOW()
           WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [previousPrimary.id, userId],
        )
        revoked = revokeResult.rows[0] ? rowToApiKey(revokeResult.rows[0]) : null
      }

      await client.query('COMMIT')
      this.hashLookupCache.clear()
      return {
        created,
        revoked,
        previousActiveCount,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async revoke(userId: string, keyId: string): Promise<RelayApiKey | null> {
    const { rows } = await this.pool.query(
      `UPDATE relay_api_keys
       SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING *`,
      [keyId, userId],
    )
    if (rows.length === 0) return null
    this.hashLookupCache.clear()
    return rowToApiKey(rows[0])
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
