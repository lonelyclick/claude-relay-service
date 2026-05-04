import pg from 'pg'

import { resolveClaudeWarmupStatus, type ClaudeWarmupStatus } from './claudeWarmupPolicy.js'
import type { AccountProvider } from '../types.js'

export type AccountLifecycleEventType =
  | 'account_added'
  | 'token_imported'
  | 'oauth_exchanged'
  | 'session_key_login'
  | 'compatible_account_added'
  | 'onboarding_probe_started'
  | 'onboarding_probe_completed'
  | 'first_real_request'
  | 'terminal_failure'
  | 'claude_org_revoked'
  | 'rate_limit_probe'
  | 'warmup_task'

export interface AccountLifecycleEventInput {
  accountId: string
  eventType: AccountLifecycleEventType
  outcome?: 'ok' | 'failure' | 'info' | null
  ingressIp?: string | null
  ingressUserAgent?: string | null
  ingressForwardedFor?: string | null
  egressProxyUrl?: string | null
  egressProvider?: string | null
  upstreamStatus?: number | null
  upstreamRequestId?: string | null
  upstreamOrganizationId?: string | null
  upstreamRateLimitTier?: string | null
  anthropicHeaders?: Record<string, string | string[] | undefined> | null
  notes?: Record<string, unknown> | null
  durationMs?: number | null
}

export interface AccountLifecycleEventRow {
  id: number
  accountId: string
  eventType: AccountLifecycleEventType
  outcome: 'ok' | 'failure' | 'info' | null
  ingressIp: string | null
  ingressUserAgent: string | null
  ingressForwardedFor: string | null
  egressProxyUrl: string | null
  egressProvider: string | null
  upstreamStatus: number | null
  upstreamRequestId: string | null
  upstreamOrganizationId: string | null
  upstreamRateLimitTier: string | null
  anthropicHeaders: Record<string, string | string[] | undefined> | null
  notes: Record<string, unknown> | null
  durationMs: number | null
  occurredAt: string
}

export interface AccountLifecycleQueryOptions {
  accountId?: string | null
  eventTypes?: AccountLifecycleEventType[] | null
  since?: Date | null
  until?: Date | null
  limit?: number | null
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS account_lifecycle_events (
  id                       BIGSERIAL PRIMARY KEY,
  account_id               TEXT NOT NULL,
  event_type               TEXT NOT NULL,
  outcome                  TEXT,
  ingress_ip               TEXT,
  ingress_user_agent       TEXT,
  ingress_forwarded_for    TEXT,
  egress_proxy_url         TEXT,
  egress_provider          TEXT,
  upstream_status          INTEGER,
  upstream_request_id      TEXT,
  upstream_organization_id TEXT,
  upstream_ratelimit_tier  TEXT,
  anthropic_headers        JSONB,
  notes                    JSONB,
  duration_ms              INTEGER,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

const CREATE_INDEXES_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_account_lifecycle_account_occurred ON account_lifecycle_events (account_id, occurred_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_account_lifecycle_event_type ON account_lifecycle_events (event_type, occurred_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_account_lifecycle_occurred ON account_lifecycle_events (occurred_at DESC)',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_account_lifecycle_first_real_request
    ON account_lifecycle_events (account_id)
    WHERE event_type = 'first_real_request'`,
]

export class AccountLifecycleStore {
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 })
  }

  async ensureTable(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(CREATE_TABLE_SQL)
      for (const sql of CREATE_INDEXES_SQL) {
        await client.query(sql)
      }
    } finally {
      client.release()
    }
  }

  async recordEvent(input: AccountLifecycleEventInput): Promise<number | null> {
    if (!input.accountId) {
      return null
    }
    const sanitizedHeaders = sanitizeHeaders(input.anthropicHeaders ?? null)
    const sanitizedNotes = sanitizeNotes(input.notes ?? null)
    const ingressIp = truncate(input.ingressIp, 64)
    const ingressUserAgent = truncate(input.ingressUserAgent, 512)
    const ingressForwardedFor = truncate(input.ingressForwardedFor, 512)
    const egressProxyUrl = redactProxyUrl(input.egressProxyUrl ?? null)

    if (input.eventType === 'first_real_request') {
      const result = await this.pool.query<{ id: number }>(
        `INSERT INTO account_lifecycle_events (
            account_id, event_type, outcome,
            ingress_ip, ingress_user_agent, ingress_forwarded_for,
            egress_proxy_url, egress_provider,
            upstream_status, upstream_request_id, upstream_organization_id, upstream_ratelimit_tier,
            anthropic_headers, notes, duration_ms
          ) VALUES (
            $1, 'first_real_request', $2,
            $3, $4, $5,
            $6, $7,
            $8, $9, $10, $11,
            $12, $13, $14
          )
          ON CONFLICT (account_id) WHERE event_type = 'first_real_request' DO NOTHING
          RETURNING id`,
        [
          input.accountId,
          input.outcome ?? 'info',
          ingressIp,
          ingressUserAgent,
          ingressForwardedFor,
          egressProxyUrl,
          input.egressProvider ?? null,
          input.upstreamStatus ?? null,
          input.upstreamRequestId ?? null,
          input.upstreamOrganizationId ?? null,
          input.upstreamRateLimitTier ?? null,
          sanitizedHeaders ? JSON.stringify(sanitizedHeaders) : null,
          sanitizedNotes ? JSON.stringify(sanitizedNotes) : null,
          input.durationMs ?? null,
        ],
      )
      return result.rows[0]?.id ?? null
    }

    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO account_lifecycle_events (
          account_id, event_type, outcome,
          ingress_ip, ingress_user_agent, ingress_forwarded_for,
          egress_proxy_url, egress_provider,
          upstream_status, upstream_request_id, upstream_organization_id, upstream_ratelimit_tier,
          anthropic_headers, notes, duration_ms
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6,
          $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15
        )
        RETURNING id`,
      [
        input.accountId,
        input.eventType,
        input.outcome ?? null,
        ingressIp,
        ingressUserAgent,
        ingressForwardedFor,
        egressProxyUrl,
        input.egressProvider ?? null,
        input.upstreamStatus ?? null,
        input.upstreamRequestId ?? null,
        input.upstreamOrganizationId ?? null,
        input.upstreamRateLimitTier ?? null,
        sanitizedHeaders ? JSON.stringify(sanitizedHeaders) : null,
        sanitizedNotes ? JSON.stringify(sanitizedNotes) : null,
        input.durationMs ?? null,
      ],
    )
    return result.rows[0]?.id ?? null
  }

  async listEvents(options: AccountLifecycleQueryOptions): Promise<AccountLifecycleEventRow[]> {
    const conditions: string[] = []
    const values: unknown[] = []
    if (options.accountId) {
      values.push(options.accountId)
      conditions.push(`account_id = $${values.length}`)
    }
    if (options.eventTypes?.length) {
      values.push(options.eventTypes)
      conditions.push(`event_type = ANY($${values.length}::text[])`)
    }
    if (options.since) {
      values.push(options.since)
      conditions.push(`occurred_at >= $${values.length}`)
    }
    if (options.until) {
      values.push(options.until)
      conditions.push(`occurred_at <= $${values.length}`)
    }
    const limit = clampLimit(options.limit ?? 200)
    values.push(limit)
    const limitIndex = values.length

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = await this.pool.query(
      `SELECT id, account_id, event_type, outcome,
              ingress_ip, ingress_user_agent, ingress_forwarded_for,
              egress_proxy_url, egress_provider,
              upstream_status, upstream_request_id, upstream_organization_id, upstream_ratelimit_tier,
              anthropic_headers, notes, duration_ms, occurred_at
       FROM account_lifecycle_events
       ${whereSql}
       ORDER BY occurred_at DESC
       LIMIT $${limitIndex}`,
      values,
    )
    return result.rows.map(mapRow)
  }

  async listAccountSummaries(limit: number = 100): Promise<AccountLifecycleSummaryRow[]> {
    const safeLimit = clampLimit(limit)
    const result = await this.pool.query(
      `WITH base AS (
         SELECT account_id,
                MIN(occurred_at) FILTER (
                  WHERE event_type IN ('account_added','token_imported','oauth_exchanged','session_key_login','compatible_account_added')
                ) AS added_at,
                MIN(occurred_at) FILTER (WHERE event_type = 'onboarding_probe_started') AS first_probe_started_at,
                MIN(occurred_at) FILTER (WHERE event_type = 'onboarding_probe_completed') AS first_probe_completed_at,
                MIN(occurred_at) FILTER (WHERE event_type = 'first_real_request') AS first_real_request_at,
                MIN(occurred_at) FILTER (WHERE event_type IN ('terminal_failure','claude_org_revoked')) AS terminal_at,
                MIN(occurred_at) FILTER (WHERE event_type = 'claude_org_revoked') AS revoked_at,
                COUNT(*) FILTER (
                  WHERE event_type IN ('onboarding_probe_started','onboarding_probe_completed')
                ) AS probe_count,
                COUNT(*) AS total_events
         FROM account_lifecycle_events
         GROUP BY account_id
       )
       SELECT b.*,
              accounts.created_at AS connected_at,
              accounts.data->>'provider' AS provider,
              accounts.data->>'emailAddress' AS email_address,
              accounts.data->>'accountCreatedAt' AS account_created_at,
              accounts.data->>'organizationUuid' AS organization_uuid,
              accounts.data->>'subscriptionType' AS subscription_type,
              accounts.data->>'rateLimitTier' AS rate_limit_tier,
              accounts.data->>'schedulerState' AS scheduler_state,
              accounts.data->>'autoBlockedReason' AS auto_blocked_reason,
              accounts.data->>'warmupEnabled' AS warmup_enabled,
              accounts.data->>'warmupPolicyId' AS warmup_policy_id,
              (
                SELECT row_to_json(t)
                FROM (
                  SELECT event_type, outcome, upstream_status, occurred_at, notes
                  FROM account_lifecycle_events
                  WHERE account_id = b.account_id
                    AND event_type IN ('terminal_failure','claude_org_revoked')
                  ORDER BY occurred_at DESC
                  LIMIT 1
                ) AS t
              ) AS terminal_event
       FROM base b
       LEFT JOIN accounts ON accounts.id = b.account_id
       ORDER BY COALESCE(b.added_at, accounts.created_at, NOW()) DESC
       LIMIT $1`,
      [safeLimit],
    )
    return result.rows.map((row) => ({
      accountId: row.account_id,
      addedAt: toIso(row.added_at),
      firstProbeStartedAt: toIso(row.first_probe_started_at),
      firstProbeCompletedAt: toIso(row.first_probe_completed_at),
      firstRealRequestAt: toIso(row.first_real_request_at),
      terminalAt: toIso(row.terminal_at),
      revokedAt: toIso(row.revoked_at),
      probeCount: Number(row.probe_count ?? 0),
      totalEvents: Number(row.total_events ?? 0),
      terminalEvent: row.terminal_event ?? null,
      provider: row.provider ?? null,
      emailAddress: row.email_address ?? null,
      accountCreatedAt: row.account_created_at ?? null,
      organizationUuid: row.organization_uuid ?? null,
      subscriptionType: row.subscription_type ?? null,
      rateLimitTier: row.rate_limit_tier ?? null,
      schedulerState: row.scheduler_state ?? null,
      autoBlockedReason: row.auto_blocked_reason ?? null,
      warmupEnabled: row.warmup_enabled == null ? true : row.warmup_enabled !== 'false',
      warmupPolicyId: row.warmup_policy_id === 'b' || row.warmup_policy_id === 'c' || row.warmup_policy_id === 'd' || row.warmup_policy_id === 'e' ? row.warmup_policy_id : 'a',
      warmup: resolveClaudeWarmupStatus({
        account: {
          provider: (row.provider ?? '') as AccountProvider,
          createdAt: toIso(row.connected_at) ?? toIso(row.added_at) ?? new Date().toISOString(),
          accountCreatedAt: row.account_created_at ?? null,
          warmupEnabled: row.warmup_enabled == null ? true : row.warmup_enabled !== 'false',
      warmupPolicyId: row.warmup_policy_id === 'b' || row.warmup_policy_id === 'c' || row.warmup_policy_id === 'd' || row.warmup_policy_id === 'e' ? row.warmup_policy_id : 'a',
        },
        firstSeenAt: toIso(row.first_real_request_at),
      }),
    }))
  }
}

export interface AccountLifecycleSummaryRow {
  accountId: string
  addedAt: string | null
  firstProbeStartedAt: string | null
  firstProbeCompletedAt: string | null
  firstRealRequestAt: string | null
  terminalAt: string | null
  revokedAt: string | null
  probeCount: number
  totalEvents: number
  terminalEvent: {
    event_type: AccountLifecycleEventType
    outcome: string | null
    upstream_status: number | null
    occurred_at: string
    notes: Record<string, unknown> | null
  } | null
  provider: string | null
  emailAddress: string | null
  accountCreatedAt: string | null
  organizationUuid: string | null
  subscriptionType: string | null
  rateLimitTier: string | null
  schedulerState: string | null
  autoBlockedReason: string | null
  warmupEnabled: boolean
  warmupPolicyId: 'a' | 'b' | 'c' | 'd' | 'e'
  warmup: ClaudeWarmupStatus
}

function mapRow(row: Record<string, unknown>): AccountLifecycleEventRow {
  return {
    id: Number(row.id ?? 0),
    accountId: String(row.account_id ?? ''),
    eventType: String(row.event_type ?? '') as AccountLifecycleEventType,
    outcome: (row.outcome as AccountLifecycleEventRow['outcome']) ?? null,
    ingressIp: (row.ingress_ip as string | null) ?? null,
    ingressUserAgent: (row.ingress_user_agent as string | null) ?? null,
    ingressForwardedFor: (row.ingress_forwarded_for as string | null) ?? null,
    egressProxyUrl: (row.egress_proxy_url as string | null) ?? null,
    egressProvider: (row.egress_provider as string | null) ?? null,
    upstreamStatus: row.upstream_status == null ? null : Number(row.upstream_status),
    upstreamRequestId: (row.upstream_request_id as string | null) ?? null,
    upstreamOrganizationId: (row.upstream_organization_id as string | null) ?? null,
    upstreamRateLimitTier: (row.upstream_ratelimit_tier as string | null) ?? null,
    anthropicHeaders: (row.anthropic_headers as AccountLifecycleEventRow['anthropicHeaders']) ?? null,
    notes: (row.notes as Record<string, unknown> | null) ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    occurredAt: toIso(row.occurred_at) ?? new Date().toISOString(),
  }
}

const ANTHROPIC_HEADER_ALLOWLIST = new Set([
  'anthropic-organization-id',
  'anthropic-account-id',
  'anthropic-ratelimit-tier',
  'anthropic-ratelimit-organization-id',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-version',
  'request-id',
  'x-request-id',
  'x-served-by',
  'cf-ray',
  'cf-cache-status',
  'server',
  'x-anthropic-organization-uuid',
])

function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined> | null,
): Record<string, string | string[]> | null {
  if (!headers) return null
  const out: Record<string, string | string[]> = {}
  for (const [rawKey, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    const key = rawKey.toLowerCase()
    if (!ANTHROPIC_HEADER_ALLOWLIST.has(key)) continue
    if (Array.isArray(value)) {
      out[key] = value.map((item) => truncate(String(item), 256) ?? '').filter(Boolean)
    } else {
      const truncated = truncate(String(value), 256)
      if (truncated) {
        out[key] = truncated
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function sanitizeNotes(notes: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!notes) return null
  try {
    const json = JSON.stringify(notes)
    if (json.length > 4096) {
      return { _truncated: true, snippet: json.slice(0, 4000) }
    }
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

function redactProxyUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const auth = url.username ? `${url.username ? '***' : ''}${url.password ? ':***' : ''}@` : ''
    return truncate(`${url.protocol}//${auth}${url.hostname}${url.port ? ':' + url.port : ''}`, 256)
  } catch {
    return truncate(value.replace(/\/\/[^/@]+@/, '//***@'), 256)
  }
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (text.length <= max) return text
  return text.slice(0, max)
}

function toIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  return null
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 200
  return Math.max(1, Math.min(1000, Math.floor(limit)))
}
