import pg from 'pg'

import type { RelayKeySource } from '../types.js'

export interface UsageRecord {
  requestId: string
  accountId: string | null
  userId: string | null
  organizationId?: string | null
  routingGroupId?: string | null
  sessionKey: string | null
  clientDeviceId?: string | null
  relayKeySource?: RelayKeySource | null
  attemptKind?: 'final' | 'retry_failure'
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  statusCode: number
  durationMs: number
  target: string
  rateLimitStatus: string | null
  rateLimit5hUtilization: number | null
  rateLimit7dUtilization: number | null
  rateLimitReset: number | null
  requestHeaders: Record<string, string | string[] | undefined> | null
  requestBodyPreview: string | null
  responseHeaders: Record<string, string | string[] | undefined> | null
  responseBodyPreview: string | null
  upstreamRequestHeaders: Record<string, string | string[] | undefined> | null
  billingReservationId?: string | null
}

export interface UsageSummary {
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  uniqueAccounts: number
  uniqueModels: number
  period: { from: string; to: string }
}

export interface AccountUsageRow {
  accountId: string
  label: string | null
  emailAddress: string | null
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  lastUsedAt: string | null
}

export interface AccountDetail {
  accountId: string
  label: string | null
  emailAddress: string | null
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  byModel: Array<{
    model: string
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreationTokens: number
    totalCacheReadTokens: number
  }>
  rateLimits: {
    latestStatus: string | null
    latest5hUtilization: number | null
    latest7dUtilization: number | null
  }
}

export interface TrendPoint {
  date: string
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS usage_records (
  id            BIGSERIAL PRIMARY KEY,
  request_id    TEXT NOT NULL,
  account_id    TEXT,
  attempt_kind  TEXT NOT NULL DEFAULT 'final',
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  status_code   INTEGER,
  duration_ms   INTEGER,
  target        TEXT,
  rate_limit_status           TEXT,
  rate_limit_5h_utilization   REAL,
  rate_limit_7d_utilization   REAL,
  rate_limit_reset            BIGINT,
  relay_key_source TEXT,
  organization_id TEXT,
  billing_reservation_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

const CREATE_INDEXES_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_usage_records_account_id ON usage_records (account_id)',
  'CREATE INDEX IF NOT EXISTS idx_usage_records_created_at ON usage_records (created_at)',
  'CREATE INDEX IF NOT EXISTS idx_usage_records_model ON usage_records (model)',
  'CREATE INDEX IF NOT EXISTS idx_usage_records_routing_group_created ON usage_records (routing_group_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_usage_records_org_created_at ON usage_records (organization_id, created_at DESC)',
]

function resolveUsageAccountIdentity(
  accountId: string,
  label: string | null,
  emailAddress: string | null,
): { label: string | null; emailAddress: string | null } {
  if (label || emailAddress) {
    return { label, emailAddress }
  }
  if (accountId.startsWith('email:')) {
    const derivedEmail = accountId.slice('email:'.length).trim()
    return {
      label: null,
      emailAddress: derivedEmail || null,
    }
  }
  return { label: null, emailAddress: null }
}

export class UsageStore {
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 })
  }

  async ensureTable(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(CREATE_TABLE_SQL)
      await client.query('ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS relay_key_source TEXT')
      await client.query('ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS routing_group_id TEXT')
      await client.query('ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS organization_id TEXT')
      await client.query('ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS billing_reservation_id TEXT')
      for (const sql of CREATE_INDEXES_SQL) {
        await client.query(sql)
      }
    } finally {
      client.release()
    }
  }

  async insertRecord(record: UsageRecord): Promise<number> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO usage_records (
        request_id, account_id, user_id, organization_id, routing_group_id, session_key, client_device_id, attempt_kind, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        status_code, duration_ms, target,
        rate_limit_status, rate_limit_5h_utilization,
        rate_limit_7d_utilization, rate_limit_reset, relay_key_source,
        request_headers, request_body_preview, response_headers, response_body_preview, upstream_request_headers, billing_reservation_id
      ) VALUES (
        $1,$2,$3,$4,
        COALESCE($5, (SELECT NULLIF(COALESCE(a.data->>'routingGroupId', a.data->>'group'), '') FROM accounts a WHERE a.id = $2)),
        $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
      )
      RETURNING id`,
      [
        record.requestId,
        record.accountId,
        record.userId,
        record.organizationId ?? null,
        record.routingGroupId ?? null,
        record.sessionKey,
        record.clientDeviceId ?? null,
        record.attemptKind ?? 'final',
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cacheCreationInputTokens,
        record.cacheReadInputTokens,
        record.statusCode,
        record.durationMs,
        record.target,
        record.rateLimitStatus,
        record.rateLimit5hUtilization,
        record.rateLimit7dUtilization,
        record.rateLimitReset,
        record.relayKeySource ?? null,
        record.requestHeaders ? JSON.stringify(record.requestHeaders) : null,
        record.requestBodyPreview,
        record.responseHeaders ? JSON.stringify(record.responseHeaders) : null,
        record.responseBodyPreview,
        record.upstreamRequestHeaders ? JSON.stringify(record.upstreamRequestHeaders) : null,
        record.billingReservationId ?? null,
      ],
    )
    return Number(result.rows[0]?.id ?? 0)
  }

  async getSummary(since: Date | null): Promise<UsageSummary> {
    const sinceDate = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const result = await this.pool.query(
      `SELECT
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation,
        COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read,
        COUNT(DISTINCT account_id)::int AS unique_accounts,
        COUNT(DISTINCT model)::int AS unique_models,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at
      FROM usage_records
      WHERE created_at >= $1
        AND COALESCE(attempt_kind, 'final') = 'final'`,
      [sinceDate],
    )
    const row = result.rows[0]
    return {
      totalRequests: row.total_requests,
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      totalCacheCreationTokens: Number(row.total_cache_creation),
      totalCacheReadTokens: Number(row.total_cache_read),
      uniqueAccounts: row.unique_accounts,
      uniqueModels: row.unique_models,
      period: {
        from: sinceDate.toISOString(),
        to: row.last_at ? new Date(row.last_at).toISOString() : new Date().toISOString(),
      },
    }
  }

  async getAccountUsage(since: Date | null): Promise<AccountUsageRow[]> {
    const sinceDate = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const result = await this.pool.query(
      `SELECT
        u.account_id,
        a.data->>'label' AS label,
        a.data->>'emailAddress' AS email_address,
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(u.input_tokens), 0)::bigint AS total_input_tokens,
        COALESCE(SUM(u.output_tokens), 0)::bigint AS total_output_tokens,
        COALESCE(SUM(u.cache_creation_input_tokens), 0)::bigint AS total_cache_creation,
        COALESCE(SUM(u.cache_read_input_tokens), 0)::bigint AS total_cache_read,
        MAX(u.created_at) AS last_used_at
      FROM usage_records u
      LEFT JOIN accounts a ON a.id = u.account_id
      WHERE u.created_at >= $1
        AND u.account_id IS NOT NULL
        AND COALESCE(u.attempt_kind, 'final') = 'final'
      GROUP BY u.account_id, a.data->>'label', a.data->>'emailAddress'
      ORDER BY total_input_tokens DESC`,
      [sinceDate],
    )
    return result.rows.map((row) => {
      const identity = resolveUsageAccountIdentity(row.account_id, row.label, row.email_address)
      return {
        accountId: row.account_id,
        label: identity.label,
        emailAddress: identity.emailAddress,
        totalRequests: row.total_requests,
        totalInputTokens: Number(row.total_input_tokens),
        totalOutputTokens: Number(row.total_output_tokens),
        totalCacheCreationTokens: Number(row.total_cache_creation),
        totalCacheReadTokens: Number(row.total_cache_read),
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      }
    })
  }

  async getAccountDetail(accountId: string, since: Date | null): Promise<AccountDetail> {
    const sinceDate = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const totalResult = await this.pool.query(
      `SELECT
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation,
        COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read
      FROM usage_records
      WHERE account_id = $1
        AND created_at >= $2
        AND COALESCE(attempt_kind, 'final') = 'final'`,
      [accountId, sinceDate],
    )

    const modelResult = await this.pool.query(
      `SELECT
        model,
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation,
        COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read
      FROM usage_records
      WHERE account_id = $1
        AND created_at >= $2
        AND COALESCE(attempt_kind, 'final') = 'final'
      GROUP BY model
      ORDER BY total_input_tokens DESC`,
      [accountId, sinceDate],
    )

    const rateLimitResult = await this.pool.query(
      `SELECT rate_limit_status, rate_limit_5h_utilization, rate_limit_7d_utilization
      FROM usage_records
      WHERE account_id = $1
        AND rate_limit_status IS NOT NULL
        AND COALESCE(attempt_kind, 'final') = 'final'
      ORDER BY created_at DESC LIMIT 1`,
      [accountId],
    )

    const accountResult = await this.pool.query(
      `SELECT data->>'label' AS label, data->>'emailAddress' AS email_address
      FROM accounts WHERE id = $1`,
      [accountId],
    )

    const total = totalResult.rows[0]
    const rl = rateLimitResult.rows[0]
    const acc = accountResult.rows[0]
    const identity = resolveUsageAccountIdentity(accountId, acc?.label ?? null, acc?.email_address ?? null)

    return {
      accountId,
      label: identity.label,
      emailAddress: identity.emailAddress,
      totalRequests: total.total_requests,
      totalInputTokens: Number(total.total_input_tokens),
      totalOutputTokens: Number(total.total_output_tokens),
      totalCacheCreationTokens: Number(total.total_cache_creation),
      totalCacheReadTokens: Number(total.total_cache_read),
      byModel: modelResult.rows.map((row) => ({
        model: row.model,
        totalRequests: row.total_requests,
        totalInputTokens: Number(row.total_input_tokens),
        totalOutputTokens: Number(row.total_output_tokens),
        totalCacheCreationTokens: Number(row.total_cache_creation),
        totalCacheReadTokens: Number(row.total_cache_read),
      })),
      rateLimits: {
        latestStatus: rl?.rate_limit_status ?? null,
        latest5hUtilization: rl?.rate_limit_5h_utilization ?? null,
        latest7dUtilization: rl?.rate_limit_7d_utilization ?? null,
      },
    }
  }

  async getTrend(days: number, accountId: string | null): Promise<TrendPoint[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const params: unknown[] = [since]
    let accountFilter = ''
    if (accountId) {
      accountFilter = ' AND account_id = $2'
      params.push(accountId)
    }

    const result = await this.pool.query(
      `SELECT
        created_at::date AS date,
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation,
        COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read
      FROM usage_records
      WHERE created_at >= $1
        AND COALESCE(attempt_kind, 'final') = 'final'${accountFilter}
      GROUP BY created_at::date
      ORDER BY date`,
      params,
    )

    return result.rows.map((row) => ({
      date: row.date.toISOString().split('T')[0],
      totalRequests: row.total_requests,
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      totalCacheCreationTokens: Number(row.total_cache_creation),
      totalCacheReadTokens: Number(row.total_cache_read),
    }))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
