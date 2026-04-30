import crypto from 'node:crypto'

import pg from 'pg'

const { Pool } = pg

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS relay_api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  key_preview  TEXT NOT NULL,
  key_plaintext TEXT,
  name         TEXT NOT NULL,
  anthropic_group_id TEXT,
  openai_group_id TEXT,
  google_group_id TEXT,
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
  plaintextAvailable: boolean
  groupAssignments: RelayApiKeyGroupAssignments
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export type RelayApiKeyGroupAssignments = {
  anthropic: string | null
  openai: string | null
  google: string | null
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
    plaintextAvailable: typeof row.key_plaintext === 'string' && row.key_plaintext.length > 0,
    groupAssignments: {
      anthropic: (row.anthropic_group_id as string | null) ?? null,
      openai: (row.openai_group_id as string | null) ?? null,
      google: (row.google_group_id as string | null) ?? null,
    },
    lastUsedAt: row.last_used_at ? (row.last_used_at as Date).toISOString() : null,
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

type CacheEntry = { keyId: string; userId: string }
export type ApiKeyLookupEntry = CacheEntry & { groupAssignments: RelayApiKeyGroupAssignments }

export class ApiKeyStore {
  private readonly pool: pg.Pool
  private readonly maxKeysPerUser: number
  private readonly hashLookupCache = new Map<string, ApiKeyLookupEntry | null>()

  constructor(databaseUrl: string, options: { maxKeysPerUser?: number } = {}) {
    this.pool = new Pool({ connectionString: databaseUrl })
    this.maxKeysPerUser = options.maxKeysPerUser ?? DEFAULT_MAX_KEYS_PER_USER
  }

  async ensureTable(): Promise<void> {
    await this.pool.query(CREATE_TABLE_SQL)
    await this.pool.query('ALTER TABLE relay_api_keys ADD COLUMN IF NOT EXISTS anthropic_group_id TEXT')
    await this.pool.query('ALTER TABLE relay_api_keys ADD COLUMN IF NOT EXISTS openai_group_id TEXT')
    await this.pool.query('ALTER TABLE relay_api_keys ADD COLUMN IF NOT EXISTS google_group_id TEXT')
    await this.pool.query('ALTER TABLE relay_api_keys ADD COLUMN IF NOT EXISTS key_plaintext TEXT')
    await this.pool.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'relay_api_keys' AND column_name = 'claude_group_id'
         ) THEN
           EXECUTE 'UPDATE relay_api_keys
                    SET anthropic_group_id = claude_group_id
                    WHERE anthropic_group_id IS NULL AND claude_group_id IS NOT NULL';
         END IF;
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'relay_api_keys' AND column_name = 'gemini_group_id'
         ) THEN
           EXECUTE 'UPDATE relay_api_keys
                    SET google_group_id = gemini_group_id
                    WHERE google_group_id IS NULL AND gemini_group_id IS NOT NULL';
         END IF;
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'relay_users' AND column_name = 'api_key'
         ) THEN
           UPDATE relay_api_keys k
           SET key_plaintext = u.api_key
           FROM relay_users u
           WHERE k.user_id = u.id
             AND k.key_plaintext IS NULL
             AND u.api_key IS NOT NULL
             AND encode(sha256(convert_to(u.api_key, 'UTF8')), 'hex') = k.key_hash;
         END IF;
       END $$;`,
    )
    await this.pool.query('ALTER TABLE relay_api_keys DROP COLUMN IF EXISTS claude_group_id')
    await this.pool.query('ALTER TABLE relay_api_keys DROP COLUMN IF EXISTS gemini_group_id')
  }

  async lookupByKey(apiKey: string): Promise<ApiKeyLookupEntry | null> {
    if (!apiKey || !apiKey.startsWith('rk_')) return null
    const hash = hashApiKey(apiKey)
    if (this.hashLookupCache.has(hash)) {
      return this.hashLookupCache.get(hash) ?? null
    }
    const { rows } = await this.pool.query(
      `SELECT id, user_id, anthropic_group_id, openai_group_id, google_group_id FROM relay_api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [hash],
    )
    const entry: ApiKeyLookupEntry | null = rows[0]
      ? {
        keyId: rows[0].id as string,
        userId: rows[0].user_id as string,
        groupAssignments: {
          anthropic: (rows[0].anthropic_group_id as string | null) ?? null,
          openai: (rows[0].openai_group_id as string | null) ?? null,
          google: (rows[0].google_group_id as string | null) ?? null,
        },
      }
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

  async getPlaintextForUserKey(userId: string, keyId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT key_plaintext
       FROM relay_api_keys
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       LIMIT 1`,
      [keyId, userId],
    )
    const value = rows[0]?.key_plaintext
    return typeof value === 'string' && value.startsWith('rk_') ? value : null
  }

  async countActiveForUser(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM relay_api_keys
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    )
    return rows[0]?.n ?? 0
  }

  async create(userId: string, options: { name?: string; groupAssignments?: RelayApiKeyGroupAssignments } = {}): Promise<CreatedApiKey> {
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
      `INSERT INTO relay_api_keys (id, user_id, key_hash, key_preview, key_plaintext, name, anthropic_group_id, openai_group_id, google_group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [id, userId, keyHash, keyPreview, apiKey, name, options.groupAssignments?.anthropic ?? null, options.groupAssignments?.openai ?? null, options.groupAssignments?.google ?? null],
    )
    const record = rowToApiKey(rows[0])
    return { ...record, apiKey }
  }

  async updateGroups(
    userId: string,
    keyId: string,
    groupAssignments: RelayApiKeyGroupAssignments,
  ): Promise<RelayApiKey | null> {
    const { rows } = await this.pool.query(
      `UPDATE relay_api_keys
       SET anthropic_group_id = $3,
           openai_group_id = $4,
           google_group_id = $5
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING *`,
      [keyId, userId, groupAssignments.anthropic, groupAssignments.openai, groupAssignments.google],
    )
    this.hashLookupCache.clear()
    return rows[0] ? rowToApiKey(rows[0]) : null
  }

  async renameGroup(oldGroupId: string, newGroupId: string): Promise<void> {
    await this.pool.query(
      `UPDATE relay_api_keys
       SET anthropic_group_id = CASE WHEN anthropic_group_id = $1 THEN $2 ELSE anthropic_group_id END,
           openai_group_id = CASE WHEN openai_group_id = $1 THEN $2 ELSE openai_group_id END,
           google_group_id = CASE WHEN google_group_id = $1 THEN $2 ELSE google_group_id END
       WHERE anthropic_group_id = $1 OR openai_group_id = $1 OR google_group_id = $1`,
      [oldGroupId, newGroupId],
    )
    this.hashLookupCache.clear()
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
        `INSERT INTO relay_api_keys (id, user_id, key_hash, key_preview, key_plaintext, name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, userId, keyHash, keyPreview, apiKey, name],
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
