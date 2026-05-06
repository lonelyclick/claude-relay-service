import crypto from 'node:crypto'

import pg from 'pg'

import { appConfig } from '../config.js'
import {
  InputValidationError,
  MAX_ROUTING_GROUP_ID_LENGTH,
  MAX_SCOPE_FIELD_LENGTH,
  MAX_USER_NAME_LENGTH,
  normalizeBillingCurrency,
  normalizeOptionalText,
  normalizeRequiredText,
} from '../security/inputValidation.js'
import type {
  BillingCurrency,
  RelayKeySource,
  RelayUser,
  RelayUserBillingMode,
  RelayUserCustomerTier,
  RelayUserRiskStatus,
  RelayUserRoutingMode,
  SessionHandoff,
  SessionRoute,
} from '../types.js'

const DEFAULT_BILLING_CURRENCY = normalizeBillingCurrency(appConfig.billingCurrency, {
  field: 'BILLING_CURRENCY',
})

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS relay_users (
  id          TEXT PRIMARY KEY,
  api_key     TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  external_user_id TEXT,
  org_id TEXT,
  account_id  TEXT,
  routing_mode TEXT,
  preferred_group TEXT,
  routing_group_id TEXT,
  billing_mode TEXT NOT NULL DEFAULT 'prepaid',
  billing_currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}',
  customer_tier TEXT NOT NULL DEFAULT 'standard',
  credit_limit_micros BIGINT NOT NULL DEFAULT 0,
  sales_owner TEXT,
  risk_status TEXT NOT NULL DEFAULT 'normal',
  balance_micros BIGINT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_relay_users_api_key ON relay_users (api_key);
`

const ALTER_USAGE_SQL = `
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS session_key TEXT;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS client_device_id TEXT;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS attempt_kind TEXT NOT NULL DEFAULT 'final';
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS request_headers JSONB;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS request_body_preview TEXT;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS response_headers JSONB;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS response_body_preview TEXT;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS upstream_request_headers JSONB;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS relay_key_source TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_records_user_id ON usage_records (user_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_session_key ON usage_records (session_key);
CREATE INDEX IF NOT EXISTS idx_usage_records_user_device_created_at ON usage_records (user_id, client_device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_user_device_target_created_at ON usage_records (user_id, client_device_id, target, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_user_target_attempt_created_at ON usage_records (user_id, target, attempt_kind, created_at DESC);
`

const ALTER_USERS_SQL = `
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS routing_mode TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS preferred_group TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS routing_group_id TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS billing_mode TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS billing_currency TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS customer_tier TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS credit_limit_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS sales_owner TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS risk_status TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS balance_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS external_user_id TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_relay_users_org_id ON relay_users (org_id);
ALTER TABLE relay_users ALTER COLUMN api_key DROP NOT NULL;
UPDATE relay_users SET api_key = NULL WHERE external_user_id IS NOT NULL AND api_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_users_external_user_id
  ON relay_users (external_user_id) WHERE external_user_id IS NOT NULL;
UPDATE relay_users
SET routing_group_id = preferred_group
WHERE routing_group_id IS NULL AND preferred_group IS NOT NULL;
UPDATE relay_users
SET preferred_group = routing_group_id
WHERE preferred_group IS NULL AND routing_group_id IS NOT NULL;
UPDATE relay_users
SET routing_mode = CASE
  WHEN routing_mode IS NOT NULL THEN routing_mode
  WHEN account_id IS NOT NULL THEN 'pinned_account'
  ELSE 'auto'
END
WHERE routing_mode IS NULL;
UPDATE relay_users
SET billing_mode = 'prepaid'
WHERE billing_mode IS NULL OR billing_mode NOT IN ('postpaid', 'prepaid');
UPDATE relay_users
SET customer_tier = 'standard'
WHERE customer_tier IS NULL OR customer_tier NOT IN ('standard', 'plus', 'business', 'enterprise', 'internal');
UPDATE relay_users
SET risk_status = 'normal'
WHERE risk_status IS NULL OR risk_status NOT IN ('normal', 'watch', 'restricted', 'blocked');
UPDATE relay_users
SET credit_limit_micros = 0
WHERE credit_limit_micros IS NULL OR credit_limit_micros < 0;
`

const CREATE_SESSION_ROUTES_SQL = `
CREATE TABLE IF NOT EXISTS session_routes (
  session_key TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  user_id TEXT,
  client_device_id TEXT,
  account_id TEXT NOT NULL,
  primary_account_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  upstream_session_id TEXT NOT NULL,
  pending_handoff_summary TEXT,
  last_handoff_reason TEXT,
  generation_burn_5h REAL NOT NULL DEFAULT 0,
  generation_burn_7d REAL NOT NULL DEFAULT 0,
  predicted_burn_5h REAL,
  predicted_burn_7d REAL,
  last_rate_limit_status TEXT,
  last_rate_limit_5h_utilization REAL,
  last_rate_limit_7d_utilization REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_routes_account_id ON session_routes (account_id);
CREATE INDEX IF NOT EXISTS idx_session_routes_user_id ON session_routes (user_id);
CREATE INDEX IF NOT EXISTS idx_session_routes_expires_at ON session_routes (expires_at);
`

const ALTER_SESSION_ROUTES_SQL = `
ALTER TABLE session_routes ADD COLUMN IF NOT EXISTS client_device_id TEXT;
ALTER TABLE session_routes ADD COLUMN IF NOT EXISTS primary_account_id TEXT;
UPDATE session_routes SET primary_account_id = account_id WHERE primary_account_id IS NULL;
ALTER TABLE session_routes ALTER COLUMN primary_account_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_routes_user_device_expires_at ON session_routes (user_id, client_device_id, expires_at);
ALTER TABLE session_routes ADD COLUMN IF NOT EXISTS last_soft_migration_at BIGINT;
`

const CREATE_SESSION_HANDOFFS_SQL = `
CREATE TABLE IF NOT EXISTS session_handoffs (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  from_account_id TEXT,
  to_account_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_handoffs_session_key ON session_handoffs (session_key, created_at DESC);
`

function generateApiKey(): string {
  return `rk_${crypto.randomBytes(32).toString('hex')}`
}

function hashSessionKey(sessionKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`claude-oauth-relay:${sessionKey}`)
    .digest('hex')
}

function sessionRouteTtlMs(): number {
  return Math.max(1, Math.floor(appConfig.stickySessionTtlHours * 60 * 60 * 1000))
}

const DEVICE_AFFINITY_LOOKBACK_MS = Math.max(
  1,
  Math.floor(appConfig.deviceAffinityLookbackHours * 60 * 60 * 1000),
)
const DEVICE_AFFINITY_MIN_SUCCESSES = Math.max(1, appConfig.deviceAffinityMinSuccesses)
const DEVICE_AFFINITY_FAILURE_PENALTY_MS = Math.max(1, appConfig.deviceAffinityFailurePenaltyMs)
const ROUTING_BUDGET_WINDOW_MS = Math.max(1, appConfig.routingBudgetWindowMs)
const STRUCTURED_HANDOFF_USER_LIMIT = 3
const STRUCTURED_HANDOFF_ASSISTANT_LIMIT = 2
const STRUCTURED_HANDOFF_SYSTEM_LIMIT = 2
const STRUCTURED_HANDOFF_ROW_LIMIT = 6
const RELAY_KEY_SOURCE_SUMMARY_RECENT_WINDOW = 100
const RELAY_KEY_SOURCE_SUMMARY_MAX_WINDOW = 500
const HANDOFF_SYSTEM_TITLES = [
  '继续当前工作。以下是可用的压缩背景，不是完整 transcript。',
  '继续时优先以当前请求里的 messages 为准；如果历史细节不足，不要假装看过完整旧会话。',
]

type PreviewMessage = {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

type PreviewPayload = {
  messages?: PreviewMessage[]
  system?: string | Array<{ type?: string; text?: string }>
}

type StructuredHandoffState = {
  recentUserGoals: string[]
  recentAssistantContext: string[]
  persistentInstructions: string[]
}

function rowToUser(row: Record<string, unknown>): RelayUser {
  const routingMode = normalizeRoutingMode(
    row.routing_mode as string | null,
    (row.account_id as string) ?? null,
  )
  const routingGroupId = normalizeRoutingGroupId(
    row.routing_group_id as string | null,
    row.preferred_group as string | null,
  )
  return {
    id: row.id as string,
    apiKey: (row.api_key as string | null) ?? null,
    name: row.name as string,
    externalUserId: (row.external_user_id as string) ?? null,
    orgId: (row.org_id as string) ?? null,
    accountId: (row.account_id as string) ?? null,
    routingMode,
    routingGroupId,
    preferredGroup: routingGroupId,
    billingMode: normalizeBillingMode(row.billing_mode as string | null),
    billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
    customerTier: normalizeCustomerTier(row.customer_tier),
    creditLimitMicros: normalizeCreditLimitMicros(row.credit_limit_micros),
    salesOwner: (row.sales_owner as string | null) ?? null,
    riskStatus: normalizeRiskStatus(row.risk_status),
    balanceMicros: String(row.balance_micros ?? '0'),
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }
}

function normalizeRelayKeySourceSummaryWindow(value: number): number {
  return Number.isFinite(value)
    ? Math.min(RELAY_KEY_SOURCE_SUMMARY_MAX_WINDOW, Math.max(1, Math.floor(value)))
    : RELAY_KEY_SOURCE_SUMMARY_RECENT_WINDOW
}

function rowToSessionRoute(row: Record<string, unknown>): SessionRoute {
  return {
    sessionKey: row.session_key as string,
    sessionHash: row.session_hash as string,
    userId: (row.user_id as string) ?? null,
    clientDeviceId: (row.client_device_id as string) ?? null,
    accountId: row.account_id as string,
    primaryAccountId: (row.primary_account_id as string) ?? (row.account_id as string),
    generation: Number(row.generation),
    upstreamSessionId: row.upstream_session_id as string,
    pendingHandoffSummary: (row.pending_handoff_summary as string) ?? null,
    lastHandoffReason: (row.last_handoff_reason as string) ?? null,
    generationBurn5h: Number(row.generation_burn_5h ?? 0),
    generationBurn7d: Number(row.generation_burn_7d ?? 0),
    predictedBurn5h: row.predicted_burn_5h == null ? null : Number(row.predicted_burn_5h),
    predictedBurn7d: row.predicted_burn_7d == null ? null : Number(row.predicted_burn_7d),
    lastRateLimitStatus: (row.last_rate_limit_status as string) ?? null,
    lastRateLimit5hUtilization:
      row.last_rate_limit_5h_utilization == null
        ? null
        : Number(row.last_rate_limit_5h_utilization),
    lastRateLimit7dUtilization:
      row.last_rate_limit_7d_utilization == null
        ? null
        : Number(row.last_rate_limit_7d_utilization),
    lastSoftMigrationAt:
      row.last_soft_migration_at == null ? null : Number(row.last_soft_migration_at),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    expiresAt: Number(row.expires_at),
  }
}

function rowToSessionHandoff(row: Record<string, unknown>): SessionHandoff {
  return {
    id: row.id as string,
    sessionKey: row.session_key as string,
    sessionHash: row.session_hash as string,
    generation: Number(row.generation),
    fromAccountId: (row.from_account_id as string) ?? null,
    toAccountId: row.to_account_id as string,
    reason: row.reason as string,
    summary: row.summary as string,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

function normalizeRoutingMode(
  routingMode: string | null,
  accountId: string | null,
): RelayUserRoutingMode {
  if (routingMode === 'auto' || routingMode === 'pinned_account' || routingMode === 'preferred_group') {
    return routingMode
  }
  return accountId ? 'pinned_account' : 'auto'
}

function normalizeRoutingGroupId(
  routingGroupId: string | null,
  preferredGroup: string | null,
): string | null {
  const normalizedRoutingGroupId = routingGroupId?.trim()
  if (normalizedRoutingGroupId) {
    return normalizedRoutingGroupId
  }
  const normalizedPreferredGroup = preferredGroup?.trim()
  return normalizedPreferredGroup || null
}

function normalizeBillingMode(
  billingMode: string | null,
): RelayUserBillingMode {
  return billingMode === 'prepaid' ? 'prepaid' : 'postpaid'
}

function normalizeCustomerTier(value: unknown): RelayUserCustomerTier {
  return value === 'plus' || value === 'business' || value === 'enterprise' || value === 'internal'
    ? value
    : 'standard'
}

function normalizeRiskStatus(value: unknown): RelayUserRiskStatus {
  return value === 'watch' || value === 'restricted' || value === 'blocked'
    ? value
    : 'normal'
}

function normalizeCreditLimitMicros(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.max(0, Math.trunc(value)))
  }
  if (typeof value === 'bigint') {
    return String(value < 0n ? 0n : value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return value.trim()
  }
  return '0'
}

function normalizeStoredBillingCurrency(value: unknown): BillingCurrency {
  return normalizeBillingCurrency(value, {
    field: 'billingCurrency',
    fallback: DEFAULT_BILLING_CURRENCY,
  })
}

function normalizeRoutingModeInput(value: RelayUserRoutingMode): RelayUserRoutingMode {
  if (value === 'auto' || value === 'pinned_account' || value === 'preferred_group') {
    return value
  }
  throw new InputValidationError('routingMode is invalid')
}

export class UserStore {
  private pool: pg.Pool
  private cache = new Map<string, RelayUser>() // apiKey → user
  private lastSessionRoutePruneAt = 0

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 })
  }

  async ensureTable(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(CREATE_TABLE_SQL)
      await client.query(ALTER_USERS_SQL)
      await client.query(
        `UPDATE relay_users
         SET billing_currency = $1
         WHERE billing_currency IS NULL OR billing_currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      )
      await client.query(ALTER_USAGE_SQL)
      await client.query(CREATE_SESSION_ROUTES_SQL)
      await client.query(ALTER_SESSION_ROUTES_SQL)
      await client.query(CREATE_SESSION_HANDOFFS_SQL)
    } finally {
      client.release()
    }
    await this.reloadCache()
  }

  private async reloadCache(): Promise<void> {
    const { rows } = await this.pool.query('SELECT * FROM relay_users')
    this.cache.clear()
    for (const row of rows) {
      const user = rowToUser(row)
      if (user.apiKey) this.cache.set(user.apiKey, user)
    }
  }

  getUserByApiKey(apiKey: string): RelayUser | null {
    return this.cache.get(apiKey) ?? null
  }

  async getUserById(id: string): Promise<RelayUser | null> {
    const { rows } = await this.pool.query('SELECT * FROM relay_users WHERE id = $1', [id])
    return rows.length ? rowToUser(rows[0]) : null
  }

  async listUsers(): Promise<RelayUser[]> {
    const { rows } = await this.pool.query('SELECT * FROM relay_users ORDER BY created_at')
    return rows.map(rowToUser)
  }

  async updateUsersOrg(oldOrgId: unknown, newOrgId: unknown): Promise<number> {
    const normalizedOldOrgId = normalizeRequiredText(oldOrgId, {
      field: 'oldOrgId',
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    })
    const normalizedNewOrgId = normalizeOptionalText(newOrgId, {
      field: 'newOrgId',
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    })
    const { rowCount } = await this.pool.query(
      'UPDATE relay_users SET org_id = $1, updated_at = NOW() WHERE org_id = $2',
      [normalizedNewOrgId, normalizedOldOrgId],
    )
    await this.reloadCache()
    return rowCount ?? 0
  }

  async createUser(
    name: unknown,
    billingCurrency: unknown = DEFAULT_BILLING_CURRENCY,
    orgId?: unknown,
  ): Promise<RelayUser> {
    const normalizedName = normalizeRequiredText(name, {
      field: 'name',
      maxLength: MAX_USER_NAME_LENGTH,
    })
    const normalizedBillingCurrency = normalizeBillingCurrency(billingCurrency, {
      field: 'billingCurrency',
      fallback: DEFAULT_BILLING_CURRENCY,
    })
    const normalizedOrgId = normalizeOptionalText(orgId, {
      field: 'orgId',
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    })
    const id = crypto.randomUUID()
    const apiKey = generateApiKey()
    const { rows } = await this.pool.query(
      `INSERT INTO relay_users (id, api_key, name, org_id, routing_mode, billing_mode, billing_currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, apiKey, normalizedName, normalizedOrgId, 'auto', 'prepaid', normalizedBillingCurrency],
    )
    const user = rowToUser(rows[0])
    if (user.apiKey) this.cache.set(user.apiKey, user)
    return user
  }

  async getUserByExternalId(externalUserId: string): Promise<RelayUser | null> {
    const trimmed = externalUserId.trim()
    if (!trimmed) return null
    const { rows } = await this.pool.query(
      'SELECT * FROM relay_users WHERE external_user_id = $1',
      [trimmed],
    )
    return rows.length ? rowToUser(rows[0]) : null
  }

  async setExternalUserId(id: string, externalUserId: unknown): Promise<RelayUser | null> {
    const normalizedExternalUserId = normalizeOptionalText(externalUserId, {
      field: 'externalUserId',
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    })
    const { rows } = await this.pool.query(
      'UPDATE relay_users SET external_user_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [normalizedExternalUserId, id],
    )
    if (!rows.length) return null
    const user = rowToUser(rows[0])
    for (const [key, cached] of this.cache) {
      if (cached.id === id) {
        this.cache.delete(key)
        break
      }
    }
    if (user.apiKey) this.cache.set(user.apiKey, user)
    return user
  }

  async findOrCreateByExternalId(input: {
    externalUserId: unknown
    name?: unknown
    billingCurrency?: unknown
    orgId?: unknown
  }): Promise<{ user: RelayUser; created: boolean }> {
    const externalUserId = normalizeRequiredText(input.externalUserId, {
      field: 'externalUserId',
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    })
    const existing = await this.getUserByExternalId(externalUserId)
    if (existing) {
      return { user: existing, created: false }
    }
    const normalizedName = normalizeRequiredText(input.name ?? externalUserId, {
      field: 'name',
      maxLength: MAX_USER_NAME_LENGTH,
    })
    const normalizedBillingCurrency = normalizeBillingCurrency(
      input.billingCurrency ?? DEFAULT_BILLING_CURRENCY,
      { field: 'billingCurrency', fallback: DEFAULT_BILLING_CURRENCY },
    )
    const normalizedOrgId = normalizeOptionalText(input.orgId, {
      field: 'orgId',
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    })
    const id = crypto.randomUUID()
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO relay_users (id, api_key, name, external_user_id, org_id, routing_mode, billing_mode, billing_currency)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [id, normalizedName, externalUserId, normalizedOrgId, 'auto', 'prepaid', normalizedBillingCurrency],
      )
      const user = rowToUser(rows[0])
      return { user, created: true }
    } catch (error) {
      const raced = await this.getUserByExternalId(externalUserId)
      if (raced) {
        return { user: raced, created: false }
      }
      throw error
    }
  }

  /** Legacy helper: only auto-bind users that are explicitly pinned. */
  async bindAccountIfNeeded(userId: string, accountId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE relay_users
       SET account_id = $1, updated_at = NOW()
       WHERE id = $2 AND account_id IS NULL AND COALESCE(routing_mode, 'auto') = 'pinned_account'`,
      [accountId, userId],
    )
    if (rowCount && rowCount > 0) {
      await this.reloadCache()
    }
  }

  async updateUser(
    id: string,
    updates: {
      name?: unknown
      orgId?: unknown
      accountId?: unknown
      routingMode?: RelayUserRoutingMode
      routingGroupId?: unknown
      preferredGroup?: unknown
      billingMode?: RelayUserBillingMode
      billingCurrency?: unknown
      customerTier?: unknown
      creditLimitMicros?: unknown
      salesOwner?: unknown
      riskStatus?: unknown
      isActive?: boolean
    },
  ): Promise<RelayUser | null> {
    const sets: string[] = []
    const values: unknown[] = []
    let idx = 1

    if (updates.name !== undefined) {
      sets.push(`name = $${idx++}`)
      values.push(
        normalizeRequiredText(updates.name, {
          field: 'name',
          maxLength: MAX_USER_NAME_LENGTH,
        }),
      )
    }
    if (updates.accountId !== undefined) {
      sets.push(`account_id = $${idx++}`)
      values.push(
        normalizeOptionalText(updates.accountId, {
          field: 'accountId',
          maxLength: MAX_SCOPE_FIELD_LENGTH,
        }),
      )
    }
    if (updates.orgId !== undefined) {
      sets.push(`org_id = $${idx++}`)
      values.push(
        normalizeOptionalText(updates.orgId, {
          field: 'orgId',
          maxLength: MAX_SCOPE_FIELD_LENGTH,
        }),
      )
    }
    if (updates.routingMode !== undefined) {
      sets.push(`routing_mode = $${idx++}`)
      values.push(normalizeRoutingModeInput(updates.routingMode))
    }
    const nextRoutingGroupId =
      updates.routingGroupId !== undefined
        ? updates.routingGroupId
        : updates.preferredGroup
    if (nextRoutingGroupId !== undefined) {
      const normalizedRoutingGroupId = normalizeOptionalText(nextRoutingGroupId, {
        field: 'routingGroupId',
        maxLength: MAX_ROUTING_GROUP_ID_LENGTH,
      })
      sets.push(`routing_group_id = $${idx++}`)
      values.push(normalizedRoutingGroupId)
      sets.push(`preferred_group = $${idx++}`)
      values.push(normalizedRoutingGroupId)
    }
    if (updates.billingMode !== undefined) {
      sets.push(`billing_mode = $${idx++}`)
      values.push(updates.billingMode === 'prepaid' ? 'prepaid' : 'postpaid')
    }
    if (updates.billingCurrency !== undefined) {
      sets.push(`billing_currency = $${idx++}`)
      values.push(
        normalizeBillingCurrency(updates.billingCurrency, {
          field: 'billingCurrency',
          fallback: DEFAULT_BILLING_CURRENCY,
        }),
      )
    }
    if (updates.customerTier !== undefined) {
      sets.push(`customer_tier = $${idx++}`)
      values.push(normalizeCustomerTier(updates.customerTier))
    }
    if (updates.creditLimitMicros !== undefined) {
      sets.push(`credit_limit_micros = $${idx++}`)
      values.push(normalizeCreditLimitMicros(updates.creditLimitMicros))
    }
    if (updates.salesOwner !== undefined) {
      sets.push(`sales_owner = $${idx++}`)
      values.push(
        normalizeOptionalText(updates.salesOwner, {
          field: 'salesOwner',
          maxLength: MAX_SCOPE_FIELD_LENGTH,
        }),
      )
    }
    if (updates.riskStatus !== undefined) {
      sets.push(`risk_status = $${idx++}`)
      values.push(normalizeRiskStatus(updates.riskStatus))
    }
    if (updates.isActive !== undefined) {
      sets.push(`is_active = $${idx++}`)
      values.push(updates.isActive)
    }
    if (sets.length === 0) return this.getUserById(id)

    sets.push(`updated_at = NOW()`)
    values.push(id)

    const { rows } = await this.pool.query(
      `UPDATE relay_users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    )
    if (!rows.length) return null
    const user = rowToUser(rows[0])
    // Update cache: remove old key, add new
    for (const [key, cached] of this.cache) {
      if (cached.id === id) {
        this.cache.delete(key)
        break
      }
    }
    if (user.apiKey) this.cache.set(user.apiKey, user)
    return user
  }

  async deleteUser(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM relay_users WHERE id = $1', [id])
    if (rowCount && rowCount > 0) {
      for (const [key, cached] of this.cache) {
        if (cached.id === id) {
          this.cache.delete(key)
          break
        }
      }
      return true
    }
    return false
  }

  async regenerateApiKey(id: string): Promise<RelayUser | null> {
    const newKey = generateApiKey()
    const { rows } = await this.pool.query(
      'UPDATE relay_users SET api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newKey, id],
    )
    if (!rows.length) return null
    const user = rowToUser(rows[0])
    // Remove old cache entry
    for (const [key, cached] of this.cache) {
      if (cached.id === id) {
        this.cache.delete(key)
        break
      }
    }
    if (user.apiKey) this.cache.set(user.apiKey, user)
    return user
  }

  async getSessionRoute(sessionKey: string): Promise<SessionRoute | null> {
    await this.pruneExpiredSessionRoutes()
    const { rows } = await this.pool.query(
      'SELECT * FROM session_routes WHERE session_key = $1 AND expires_at > $2',
      [sessionKey, Date.now()],
    )
    return rows.length ? rowToSessionRoute(rows[0]) : null
  }

  async listSessionRoutes(): Promise<SessionRoute[]> {
    await this.pruneExpiredSessionRoutes()
    const { rows } = await this.pool.query(
      'SELECT * FROM session_routes WHERE expires_at > $1 ORDER BY updated_at DESC',
      [Date.now()],
    )
    return rows.map(rowToSessionRoute)
  }

  async clearSessionRoutes(): Promise<void> {
    await this.pool.query('DELETE FROM session_routes')
  }

  async listSessionHandoffs(limit = 200): Promise<SessionHandoff[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM session_handoffs ORDER BY created_at DESC LIMIT $1',
      [limit],
    )
    return rows.map(rowToSessionHandoff)
  }

  async getActiveSessionCounts(): Promise<Map<string, number>> {
    await this.pruneExpiredSessionRoutes()
    const { rows } = await this.pool.query(
      `SELECT account_id, COUNT(*)::int AS count
       FROM session_routes
       WHERE expires_at > $1
       GROUP BY account_id`,
      [Date.now()],
    )
    const counts = new Map<string, number>()
    for (const row of rows) {
      counts.set(row.account_id as string, Number(row.count))
    }
    return counts
  }

  async getRoutingGuardSnapshot(input: {
    userId?: string | null
    clientDeviceId?: string | null
  }): Promise<{
    userActiveSessions: number
    clientDeviceActiveSessions: number
    userRecentRequests: number
    clientDeviceRecentRequests: number
    userRecentTokens: number
    clientDeviceRecentTokens: number
  }> {
    const userId = input.userId?.trim() ?? ''
    const clientDeviceId = input.clientDeviceId?.trim() ?? ''
    if (!userId) {
      return {
        userActiveSessions: 0,
        clientDeviceActiveSessions: 0,
        userRecentRequests: 0,
        clientDeviceRecentRequests: 0,
        userRecentTokens: 0,
        clientDeviceRecentTokens: 0,
      }
    }

    await this.pruneExpiredSessionRoutes()
    const now = Date.now()
    const [sessionResult, budgetResult] = await Promise.all([
      this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE user_id = $1)::int AS user_active_sessions,
           COUNT(*) FILTER (WHERE user_id = $1 AND client_device_id = $2)::int AS client_device_active_sessions
         FROM session_routes
         WHERE expires_at > $3`,
        [userId, clientDeviceId || null, now],
      ),
      this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE user_id = $1)::int AS user_recent_requests,
           COUNT(*) FILTER (WHERE user_id = $1 AND client_device_id = $2)::int AS client_device_recent_requests,
           COALESCE(SUM(
             input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens
           ) FILTER (WHERE user_id = $1), 0)::bigint AS user_recent_tokens,
           COALESCE(SUM(
             input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens
           ) FILTER (WHERE user_id = $1 AND client_device_id = $2), 0)::bigint AS client_device_recent_tokens
         FROM usage_records
         WHERE created_at >= $3
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
           AND COALESCE(attempt_kind, 'final') = 'final'`,
        [userId, clientDeviceId || null, new Date(now - ROUTING_BUDGET_WINDOW_MS).toISOString()],
      ),
    ])
    const row = sessionResult.rows[0] ?? {}
    const budgetRow = budgetResult.rows[0] ?? {}
    return {
      userActiveSessions: Number(row.user_active_sessions ?? 0),
      clientDeviceActiveSessions: clientDeviceId
        ? Number(row.client_device_active_sessions ?? 0)
        : 0,
      userRecentRequests: Number(budgetRow.user_recent_requests ?? 0),
      clientDeviceRecentRequests: clientDeviceId
        ? Number(budgetRow.client_device_recent_requests ?? 0)
        : 0,
      userRecentTokens: Number(budgetRow.user_recent_tokens ?? 0),
      clientDeviceRecentTokens: clientDeviceId
        ? Number(budgetRow.client_device_recent_tokens ?? 0)
        : 0,
    }
  }

  async getRiskWindowSnapshot(input: {
    userId: string
    clientDeviceId?: string | null
    sessionKey?: string | null
    sinceMs?: number
  }): Promise<{
    userRecentRequests: number
    clientDeviceRecentRequests: number
    userRecentTokens: number
    clientDeviceRecentTokens: number
    userDistinctAccounts: number
    clientDeviceDistinctAccounts: number
    sessionDistinctAccounts: number
    sessionAccountSwitches: number
    distinctSessions: number
  }> {
    const userId = input.userId.trim()
    const clientDeviceId = input.clientDeviceId?.trim() ?? ''
    const sessionKey = input.sessionKey?.trim() ?? ''
    if (!userId) {
      return {
        userRecentRequests: 0,
        clientDeviceRecentRequests: 0,
        userRecentTokens: 0,
        clientDeviceRecentTokens: 0,
        userDistinctAccounts: 0,
        clientDeviceDistinctAccounts: 0,
        sessionDistinctAccounts: 0,
        sessionAccountSwitches: 0,
        distinctSessions: 0,
      }
    }

    const sinceMs = input.sinceMs ?? ROUTING_BUDGET_WINDOW_MS
    const since = new Date(Date.now() - sinceMs).toISOString()
    const { rows } = await this.pool.query(
      `WITH base AS (
         SELECT
           user_id,
           client_device_id,
           session_key,
           account_id,
           created_at,
           input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens AS tokens,
           LAG(account_id) OVER (PARTITION BY session_key ORDER BY created_at) AS previous_account_id
         FROM usage_records
         WHERE created_at >= $4
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND user_id = $1
       )
       SELECT
         COUNT(*)::int AS user_recent_requests,
         COUNT(*) FILTER (WHERE client_device_id = $2)::int AS client_device_recent_requests,
         COALESCE(SUM(tokens), 0)::bigint AS user_recent_tokens,
         COALESCE(SUM(tokens) FILTER (WHERE client_device_id = $2), 0)::bigint AS client_device_recent_tokens,
         COUNT(DISTINCT account_id)::int AS user_distinct_accounts,
         COUNT(DISTINCT account_id) FILTER (WHERE client_device_id = $2)::int AS client_device_distinct_accounts,
         COUNT(DISTINCT account_id) FILTER (WHERE session_key = $3)::int AS session_distinct_accounts,
         COUNT(*) FILTER (
           WHERE session_key = $3
             AND previous_account_id IS NOT NULL
             AND previous_account_id <> account_id
         )::int AS session_account_switches,
         COUNT(DISTINCT session_key)::int AS distinct_sessions
       FROM base`,
      [userId, clientDeviceId || null, sessionKey || null, since],
    )
    const row = rows[0] ?? {}
    return {
      userRecentRequests: Number(row.user_recent_requests ?? 0),
      clientDeviceRecentRequests: Number(row.client_device_recent_requests ?? 0),
      userRecentTokens: Number(row.user_recent_tokens ?? 0),
      clientDeviceRecentTokens: Number(row.client_device_recent_tokens ?? 0),
      userDistinctAccounts: Number(row.user_distinct_accounts ?? 0),
      clientDeviceDistinctAccounts: Number(row.client_device_distinct_accounts ?? 0),
      sessionDistinctAccounts: Number(row.session_distinct_accounts ?? 0),
      sessionAccountSwitches: Number(row.session_account_switches ?? 0),
      distinctSessions: Number(row.distinct_sessions ?? 0),
    }
  }


  async getClaudeOfficialAccountsUsedByClient(input: {
    userId?: string | null
    clientDeviceId?: string | null
    sinceMs?: number
  }): Promise<string[]> {
    const userId = input.userId?.trim() ?? ''
    if (!userId) return []
    const clientDeviceId = input.clientDeviceId?.trim() || null
    const since = new Date(Date.now() - (input.sinceMs ?? 24 * 60 * 60 * 1000)).toISOString()
    const { rows } = await this.pool.query(
      `SELECT account_id, MAX(created_at) AS last_seen_at
       FROM usage_records
       WHERE user_id = $1
         AND ($2::text IS NULL OR client_device_id = $2)
         AND account_id LIKE 'claude-official:%'
         AND created_at >= $3
         AND COALESCE(attempt_kind, 'final') = 'final'
         AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
       GROUP BY account_id
       ORDER BY last_seen_at DESC`,
      [userId, clientDeviceId, since],
    )
    return rows.map((row) => row.account_id as string).filter(Boolean)
  }


  async getNewClaudeAccountRiskSnapshot(input: {
    accountId: string
    userId?: string | null
    clientDeviceId?: string | null
    sinceMs?: number
  }): Promise<{
    accountRequestCount1m: number
    accountTokens1m: number
    accountCacheRead1m: number
    accountMaxTokens1m: number
    userDistinctClaudeOfficialAccounts24h: number
    clientDeviceDistinctClaudeOfficialAccounts24h: number
    accountFirstSeenAt: string | null
    accountLastSeenAt: string | null
    accountAgeMs: number | null
  }> {
    const accountId = input.accountId.trim()
    if (!accountId || !accountId.startsWith('claude-official:')) {
      return {
        accountRequestCount1m: 0,
        accountTokens1m: 0,
        accountCacheRead1m: 0,
        accountMaxTokens1m: 0,
        userDistinctClaudeOfficialAccounts24h: 0,
        clientDeviceDistinctClaudeOfficialAccounts24h: 0,
        accountFirstSeenAt: null,
        accountLastSeenAt: null,
        accountAgeMs: null,
      }
    }

    const now = Date.now()
    const since1m = new Date(now - 60_000).toISOString()
    const since24h = new Date(now - (input.sinceMs ?? 24 * 60 * 60 * 1000)).toISOString()
    const { rows } = await this.pool.query(
      `WITH account_usage AS (
         SELECT
           created_at,
           input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens AS tokens,
           cache_read_input_tokens
         FROM usage_records
         WHERE account_id = $1
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
       ), recent_account AS (
         SELECT
           COUNT(*)::int AS request_count_1m,
           COALESCE(SUM(tokens), 0)::bigint AS tokens_1m,
           COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_1m,
           COALESCE(MAX(tokens), 0)::bigint AS max_tokens_1m
         FROM account_usage
         WHERE created_at >= $2
       ), account_seen AS (
         SELECT MIN(created_at) AS first_seen_at, MAX(created_at) AS last_seen_at
         FROM account_usage
       ), user_accounts AS (
         SELECT COUNT(DISTINCT account_id)::int AS distinct_accounts
         FROM usage_records
         WHERE user_id = $3
           AND account_id LIKE 'claude-official:%'
           AND created_at >= $4
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
       ), device_accounts AS (
         SELECT COUNT(DISTINCT account_id)::int AS distinct_accounts
         FROM usage_records
         WHERE user_id = $3
           AND client_device_id = $5
           AND account_id LIKE 'claude-official:%'
           AND created_at >= $4
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
       )
       SELECT
         recent_account.request_count_1m,
         recent_account.tokens_1m,
         recent_account.cache_read_1m,
         recent_account.max_tokens_1m,
         account_seen.first_seen_at,
         account_seen.last_seen_at,
         COALESCE(user_accounts.distinct_accounts, 0)::int AS user_distinct_accounts_24h,
         COALESCE(device_accounts.distinct_accounts, 0)::int AS device_distinct_accounts_24h
       FROM recent_account, account_seen, user_accounts, device_accounts`,
      [accountId, since1m, input.userId ?? null, since24h, input.clientDeviceId ?? null],
    )
    const row = rows[0] ?? {}
    const firstSeenAt = row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : null
    return {
      accountRequestCount1m: Number(row.request_count_1m ?? 0),
      accountTokens1m: Number(row.tokens_1m ?? 0),
      accountCacheRead1m: Number(row.cache_read_1m ?? 0),
      accountMaxTokens1m: Number(row.max_tokens_1m ?? 0),
      userDistinctClaudeOfficialAccounts24h: Number(row.user_distinct_accounts_24h ?? 0),
      clientDeviceDistinctClaudeOfficialAccounts24h: Number(row.device_distinct_accounts_24h ?? 0),
      accountFirstSeenAt: firstSeenAt,
      accountLastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : null,
      accountAgeMs: firstSeenAt ? Math.max(0, now - new Date(firstSeenAt).getTime()) : null,
    }
  }

  async getClaudeAccountRecentLoad(accountIds: string[], sinceMs: number = 60_000): Promise<Map<string, {
    requests: number
    tokens: number
    cacheReadTokens: number
    lastSeenAt: string | null
    firstSeenAt: string | null
  }>> {
    const ids = accountIds.map((id) => id.trim()).filter((id) => id.startsWith('claude-official:'))
    if (ids.length === 0) return new Map()
    const now = Date.now()
    const since = new Date(now - Math.max(1, sinceMs)).toISOString()
    const { rows } = await this.pool.query(
      `WITH all_usage AS (
         SELECT account_id, MIN(created_at) AS first_seen_at, MAX(created_at) AS last_seen_at
         FROM usage_records
         WHERE account_id = ANY($1::text[])
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
         GROUP BY account_id
       ), recent AS (
         SELECT account_id,
                COUNT(*)::int AS requests,
                COALESCE(SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_tokens
         FROM usage_records
         WHERE account_id = ANY($1::text[])
           AND created_at >= $2
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
         GROUP BY account_id
       )
       SELECT all_usage.account_id,
              COALESCE(recent.requests, 0)::int AS requests,
              COALESCE(recent.tokens, 0)::bigint AS tokens,
              COALESCE(recent.cache_read_tokens, 0)::bigint AS cache_read_tokens,
              all_usage.first_seen_at,
              all_usage.last_seen_at
       FROM all_usage
       LEFT JOIN recent ON recent.account_id = all_usage.account_id`,
      [ids, since],
    )
    const result = new Map<string, {
      requests: number
      tokens: number
      cacheReadTokens: number
      lastSeenAt: string | null
      firstSeenAt: string | null
    }>()
    for (const row of rows) {
      result.set(String(row.account_id), {
        requests: Number(row.requests ?? 0),
        tokens: Number(row.tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
        firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : null,
        lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : null,
      })
    }
    return result
  }

  async getAccountHealthDistribution(input: { since?: string | null } = {}): Promise<{ accounts: Array<Record<string, unknown>> }> {
    const since = input.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { rows } = await this.pool.query(
      `WITH hourly AS (
         SELECT account_id,
                date_trunc('hour', created_at) AS hour,
                COUNT(*)::int AS requests,
                COALESCE(SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_tokens,
                COUNT(*) FILTER (WHERE status_code >= 400)::int AS errors
         FROM usage_records
         WHERE created_at >= $1
           AND account_id LIKE 'claude-official:%'
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
         GROUP BY account_id, date_trunc('hour', created_at)
       ), rollup AS (
         SELECT account_id,
                COUNT(*)::int AS active_hours,
                COALESCE(MAX(requests), 0)::int AS peak_requests_hour,
                COALESCE(MAX(tokens), 0)::bigint AS peak_tokens_hour,
                COALESCE(MAX(cache_read_tokens), 0)::bigint AS peak_cache_read_hour,
                COALESCE(SUM(requests), 0)::int AS total_requests,
                COALESCE(SUM(tokens), 0)::bigint AS total_tokens,
                COALESCE(SUM(cache_read_tokens), 0)::bigint AS total_cache_read_tokens,
                COALESCE(SUM(errors), 0)::int AS errors,
                MIN(hour) AS first_hour,
                MAX(hour) AS last_hour
         FROM hourly
         GROUP BY account_id
       )
       SELECT rollup.*, accounts.data->>'label' AS label, accounts.data->>'emailAddress' AS email_address
       FROM rollup
       LEFT JOIN accounts ON accounts.id = rollup.account_id
       ORDER BY peak_cache_read_hour DESC, total_cache_read_tokens DESC
       LIMIT 200`,
      [since],
    )
    return {
      accounts: rows.map((row) => ({
        accountId: row.account_id,
        label: row.label ?? null,
        emailAddress: row.email_address ?? null,
        activeHours: Number(row.active_hours ?? 0),
        quietHours: Math.max(0, 24 - Number(row.active_hours ?? 0)),
        peakRequestsHour: Number(row.peak_requests_hour ?? 0),
        peakTokensHour: Number(row.peak_tokens_hour ?? 0),
        peakCacheReadHour: Number(row.peak_cache_read_hour ?? 0),
        totalRequests: Number(row.total_requests ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
        totalCacheReadTokens: Number(row.total_cache_read_tokens ?? 0),
        errors: Number(row.errors ?? 0),
        firstHour: row.first_hour instanceof Date ? row.first_hour.toISOString() : null,
        lastHour: row.last_hour instanceof Date ? row.last_hour.toISOString() : null,
      })),
    }
  }

  async getEgressRiskSummary(): Promise<{ egress: Array<Record<string, unknown>> }> {
    const { rows } = await this.pool.query(
      `WITH account_proxy AS (
         SELECT id AS account_id,
                data->>'label' AS label,
                data->>'emailAddress' AS email_address,
                NULLIF(data->>'proxyUrl', '') AS proxy_url,
                data->>'status' AS account_status,
                data->>'autoBlockedReason' AS auto_blocked_reason
         FROM accounts
         WHERE data->>'provider' = 'claude-official'
       ), usage_30d AS (
         SELECT account_id,
                COUNT(*)::int AS requests_30d,
                COUNT(*) FILTER (WHERE status_code IN (401,403,429))::int AS risk_errors_30d,
                COUNT(*) FILTER (WHERE response_headers->>'anthropic-ratelimit-unified-overage-disabled-reason' IS NOT NULL AND response_headers->>'anthropic-ratelimit-unified-overage-disabled-reason' <> '')::int AS overage_disabled_30d,
                MAX(created_at) AS last_used_at
         FROM usage_records
         WHERE created_at >= NOW() - INTERVAL '30 days'
           AND account_id LIKE 'claude-official:%'
           AND COALESCE(attempt_kind, 'final') = 'final'
         GROUP BY account_id
       ), grouped AS (
         SELECT COALESCE(account_proxy.proxy_url, 'direct') AS egress_key,
                COUNT(*)::int AS account_count,
                COUNT(*) FILTER (WHERE account_proxy.account_status IN ('revoked','banned') OR lower(coalesce(account_proxy.auto_blocked_reason, '')) LIKE '%disabled%')::int AS disabled_accounts,
                COALESCE(SUM(usage_30d.requests_30d), 0)::int AS requests_30d,
                COALESCE(SUM(usage_30d.risk_errors_30d), 0)::int AS risk_errors_30d,
                COALESCE(SUM(usage_30d.overage_disabled_30d), 0)::int AS overage_disabled_30d,
                MAX(usage_30d.last_used_at) AS last_used_at,
                JSONB_AGG(JSONB_BUILD_OBJECT(
                  'accountId', account_proxy.account_id,
                  'label', account_proxy.label,
                  'emailAddress', account_proxy.email_address,
                  'requests30d', COALESCE(usage_30d.requests_30d, 0),
                  'riskErrors30d', COALESCE(usage_30d.risk_errors_30d, 0),
                  'overageDisabled30d', COALESCE(usage_30d.overage_disabled_30d, 0),
                  'accountStatus', account_proxy.account_status,
                  'autoBlockedReason', account_proxy.auto_blocked_reason
                ) ORDER BY COALESCE(usage_30d.risk_errors_30d, 0) DESC) AS accounts
         FROM account_proxy
         LEFT JOIN usage_30d ON usage_30d.account_id = account_proxy.account_id
         GROUP BY COALESCE(account_proxy.proxy_url, 'direct')
       )
       SELECT * FROM grouped
       ORDER BY disabled_accounts DESC, risk_errors_30d DESC, account_count DESC`,
    )
    return {
      egress: rows.map((row) => ({
        egressKey: row.egress_key,
        accountCount: Number(row.account_count ?? 0),
        disabledAccounts: Number(row.disabled_accounts ?? 0),
        requests30d: Number(row.requests_30d ?? 0),
        riskErrors30d: Number(row.risk_errors_30d ?? 0),
        overageDisabled30d: Number(row.overage_disabled_30d ?? 0),
        lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : null,
        accounts: Array.isArray(row.accounts) ? row.accounts : [],
      })),
    }
  }


  async getPreferredAccountIdsForClientDevice(input: {
    userId: string
    clientDeviceId: string
    limit?: number
  }): Promise<string[]> {
    const userId = input.userId.trim()
    const clientDeviceId = input.clientDeviceId.trim()
    if (!userId || !clientDeviceId) {
      return []
    }
    const limit = Math.max(1, Math.min(input.limit ?? 3, 10))
    const since = new Date(Date.now() - DEVICE_AFFINITY_LOOKBACK_MS).toISOString()
    const penaltySince = new Date(Date.now() - DEVICE_AFFINITY_FAILURE_PENALTY_MS).toISOString()
    const { rows } = await this.pool.query(
      `WITH successful_accounts AS (
         SELECT
           account_id,
           COUNT(*)::int AS success_count,
           MAX(created_at) AS last_seen_at
         FROM usage_records
         WHERE user_id = $1
           AND client_device_id = $2
          AND split_part(target, '?', 1) = '/v1/messages'
           AND account_id IS NOT NULL
           AND status_code >= 200
           AND status_code < 300
           AND created_at >= $3
         GROUP BY account_id
         HAVING COUNT(*) >= $4
       )
       SELECT successful_accounts.account_id
       FROM successful_accounts
       WHERE NOT EXISTS (
         SELECT 1
         FROM usage_records penalty
         WHERE penalty.user_id = $1
           AND penalty.client_device_id = $2
           AND penalty.account_id = successful_accounts.account_id
          AND split_part(penalty.target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws')
           AND penalty.created_at >= $5
           AND (
             penalty.status_code IN (401, 403, 429)
             OR penalty.status_code >= 500
             OR LOWER(COALESCE(penalty.rate_limit_status, '')) IN ('rejected', 'throttled', 'blocked')
           )
       )
       ORDER BY successful_accounts.success_count DESC, successful_accounts.last_seen_at DESC
       LIMIT $6`,
      [userId, clientDeviceId, since, DEVICE_AFFINITY_MIN_SUCCESSES, penaltySince, limit],
    )
    return rows.map((row) => row.account_id as string)
  }

  async ensureSessionRoute(input: {
    sessionKey: string
    userId?: string | null
    clientDeviceId?: string | null
    accountId: string
    primaryAccountId?: string | null
  }): Promise<SessionRoute> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const now = Date.now()
      const expiresAt = now + sessionRouteTtlMs()
      const nowIso = new Date(now).toISOString()
      const { rows: existingRows } = await client.query(
        'SELECT * FROM session_routes WHERE session_key = $1 AND expires_at > $2 FOR UPDATE',
        [input.sessionKey, now],
      )
      const existing = existingRows.length ? rowToSessionRoute(existingRows[0]) : null
      if (existing && existing.accountId === input.accountId) {
        const { rows } = await client.query(
          `UPDATE session_routes
           SET user_id = COALESCE($2, user_id),
               client_device_id = COALESCE($3, client_device_id),
               expires_at = $4,
               updated_at = $5
           WHERE session_key = $1
           RETURNING *`,
          [input.sessionKey, input.userId ?? null, input.clientDeviceId ?? null, expiresAt, nowIso],
        )
        await client.query('COMMIT')
        return rowToSessionRoute(rows[0])
      }

      const sessionHash = hashSessionKey(input.sessionKey)
      const upstreamSessionId = crypto.randomUUID()
      const primaryAccountId =
        input.primaryAccountId ?? existing?.primaryAccountId ?? input.accountId
      const { rows } = await client.query(
        `INSERT INTO session_routes (
          session_key, session_hash, user_id, client_device_id, account_id, primary_account_id, generation,
          upstream_session_id, pending_handoff_summary, last_handoff_reason,
          generation_burn_5h, generation_burn_7d, predicted_burn_5h, predicted_burn_7d,
          last_rate_limit_status, last_rate_limit_5h_utilization, last_rate_limit_7d_utilization,
          created_at, updated_at, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,0,0,NULL,NULL,NULL,NULL,NULL,$9,$9,$10)
        ON CONFLICT (session_key) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          client_device_id = COALESCE(EXCLUDED.client_device_id, session_routes.client_device_id),
          account_id = EXCLUDED.account_id,
          primary_account_id = EXCLUDED.primary_account_id,
          generation = EXCLUDED.generation,
          upstream_session_id = EXCLUDED.upstream_session_id,
          pending_handoff_summary = EXCLUDED.pending_handoff_summary,
          last_handoff_reason = EXCLUDED.last_handoff_reason,
          generation_burn_5h = EXCLUDED.generation_burn_5h,
          generation_burn_7d = EXCLUDED.generation_burn_7d,
          predicted_burn_5h = EXCLUDED.predicted_burn_5h,
          predicted_burn_7d = EXCLUDED.predicted_burn_7d,
          last_rate_limit_status = EXCLUDED.last_rate_limit_status,
          last_rate_limit_5h_utilization = EXCLUDED.last_rate_limit_5h_utilization,
          last_rate_limit_7d_utilization = EXCLUDED.last_rate_limit_7d_utilization,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at
        RETURNING *`,
        [
          input.sessionKey,
          sessionHash,
          input.userId ?? null,
          input.clientDeviceId ?? null,
          input.accountId,
          primaryAccountId,
          existing ? existing.generation + 1 : 1,
          upstreamSessionId,
          nowIso,
          expiresAt,
        ],
      )
      await client.query('COMMIT')
      return rowToSessionRoute(rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async migrateSessionRoute(input: {
    sessionKey: string
    userId?: string | null
    clientDeviceId?: string | null
    fromAccountId: string | null
    toAccountId: string
    reason: string
    summary: string
    primaryAccountId?: string | null
  }): Promise<SessionRoute> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const now = Date.now()
      const expiresAt = now + sessionRouteTtlMs()
      const nowIso = new Date(now).toISOString()
      const { rows: existingRows } = await client.query(
        'SELECT * FROM session_routes WHERE session_key = $1 AND expires_at > $2 FOR UPDATE',
        [input.sessionKey, now],
      )
      const existing = existingRows.length ? rowToSessionRoute(existingRows[0]) : null
      const generation = (existing?.generation ?? 0) + 1
      const sessionHash = hashSessionKey(input.sessionKey)
      const handoffId = crypto.randomUUID()
      const primaryAccountId =
        input.primaryAccountId ?? existing?.primaryAccountId ?? input.toAccountId
      const next = await client.query(
        `INSERT INTO session_routes (
          session_key, session_hash, user_id, client_device_id, account_id, primary_account_id, generation,
          upstream_session_id, pending_handoff_summary, last_handoff_reason,
          generation_burn_5h, generation_burn_7d, predicted_burn_5h, predicted_burn_7d,
          last_rate_limit_status, last_rate_limit_5h_utilization, last_rate_limit_7d_utilization,
          created_at, updated_at, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,NULL,NULL,NULL,NULL,NULL,$11,$11,$12)
        ON CONFLICT (session_key) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          client_device_id = COALESCE(EXCLUDED.client_device_id, session_routes.client_device_id),
          account_id = EXCLUDED.account_id,
          primary_account_id = EXCLUDED.primary_account_id,
          generation = EXCLUDED.generation,
          upstream_session_id = EXCLUDED.upstream_session_id,
          pending_handoff_summary = EXCLUDED.pending_handoff_summary,
          last_handoff_reason = EXCLUDED.last_handoff_reason,
          generation_burn_5h = 0,
          generation_burn_7d = 0,
          predicted_burn_5h = NULL,
          predicted_burn_7d = NULL,
          last_rate_limit_status = NULL,
          last_rate_limit_5h_utilization = NULL,
          last_rate_limit_7d_utilization = NULL,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at
        RETURNING *`,
        [
          input.sessionKey,
          sessionHash,
          input.userId ?? null,
          input.clientDeviceId ?? existing?.clientDeviceId ?? null,
          input.toAccountId,
          primaryAccountId,
          generation,
          crypto.randomUUID(),
          input.summary,
          input.reason,
          nowIso,
          expiresAt,
        ],
      )
      await client.query(
        `INSERT INTO session_handoffs (
          id, session_key, session_hash, generation, from_account_id, to_account_id, reason, summary, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          handoffId,
          input.sessionKey,
          sessionHash,
          generation,
          input.fromAccountId,
          input.toAccountId,
          input.reason,
          input.summary,
          nowIso,
        ],
      )
      await client.query('COMMIT')
      return rowToSessionRoute(next.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async updateSessionRouteSoftMigrationAt(sessionKey: string, now: number): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(
        'UPDATE session_routes SET last_soft_migration_at = $2 WHERE session_key = $1',
        [sessionKey, now],
      )
    } finally {
      client.release()
    }
  }

  async noteSessionRouteUsage(input: {
    sessionKey: string
    userId?: string | null
    clientDeviceId?: string | null
    accountId: string
    rateLimitStatus?: string | null
    rateLimit5hUtilization?: number | null
    rateLimit7dUtilization?: number | null
  }): Promise<SessionRoute | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: lockedRows } = await client.query(
        'SELECT * FROM session_routes WHERE session_key = $1 AND expires_at > $2 FOR UPDATE',
        [input.sessionKey, Date.now()],
      )
      if (!lockedRows.length || (lockedRows[0] as Record<string, unknown>).account_id !== input.accountId) {
        await client.query('ROLLBACK')
        return null
      }
      const route = rowToSessionRoute(lockedRows[0])
      const delta5h = computeUsageDelta(
        route.lastRateLimit5hUtilization,
        input.rateLimit5hUtilization ?? null,
      )
      const delta7d = computeUsageDelta(
        route.lastRateLimit7dUtilization,
        input.rateLimit7dUtilization ?? null,
      )
      const nextBurn5h = route.generationBurn5h + delta5h
      const nextBurn7d = route.generationBurn7d + delta7d
      const nextPredicted5h = updateEma(route.predictedBurn5h, delta5h)
      const nextPredicted7d = updateEma(route.predictedBurn7d, delta7d)
      const now = Date.now()
      const { rows } = await client.query(
        `UPDATE session_routes
         SET user_id = COALESCE($2, user_id),
             client_device_id = COALESCE($3, client_device_id),
             generation_burn_5h = $4,
             generation_burn_7d = $5,
             predicted_burn_5h = $6,
             predicted_burn_7d = $7,
             last_rate_limit_status = $8,
             last_rate_limit_5h_utilization = $9,
             last_rate_limit_7d_utilization = $10,
             expires_at = $11,
             updated_at = $12
         WHERE session_key = $1
         RETURNING *`,
        [
          input.sessionKey,
          input.userId ?? null,
          input.clientDeviceId ?? null,
          nextBurn5h,
          nextBurn7d,
          nextPredicted5h,
          nextPredicted7d,
          input.rateLimitStatus ?? null,
          input.rateLimit5hUtilization ?? null,
          input.rateLimit7dUtilization ?? null,
          now + sessionRouteTtlMs(),
          new Date(now).toISOString(),
        ],
      )
      await client.query('COMMIT')
      return rows.length ? rowToSessionRoute(rows[0]) : null
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async clearPendingHandoffSummary(sessionKey: string): Promise<void> {
    await this.pool.query(
      `UPDATE session_routes
       SET pending_handoff_summary = NULL, updated_at = NOW()
       WHERE session_key = $1`,
      [sessionKey],
    )
  }

  async prepareSessionRoutesForAccountHandoff(input: {
    accountId: string
    reason: string
  }): Promise<number> {
    await this.pruneExpiredSessionRoutes()
    const now = Date.now()
    const { rows } = await this.pool.query(
      `SELECT session_key, pending_handoff_summary
       FROM session_routes
       WHERE account_id = $1
         AND expires_at > $2`,
      [input.accountId, now],
    )

    let updatedCount = 0
    for (const row of rows) {
      const sessionKey = row.session_key as string
      const existingSummary =
        typeof row.pending_handoff_summary === 'string' && row.pending_handoff_summary.trim()
          ? (row.pending_handoff_summary as string).trim()
          : null
      const summary =
        existingSummary ??
        await this.buildSessionHandoffSummary({
          sessionKey,
          fromAccountId: input.accountId,
        })
      const result = await this.pool.query(
        `UPDATE session_routes
         SET pending_handoff_summary = $2,
             last_handoff_reason = $3,
             updated_at = NOW()
         WHERE session_key = $1
           AND account_id = $4
           AND expires_at > $5`,
        [sessionKey, summary, input.reason, input.accountId, now],
      )
      updatedCount += result.rowCount ?? 0
    }

    return updatedCount
  }

  async buildSessionHandoffSummary(input: {
    sessionKey: string
    fromAccountId?: string | null
    currentRequestBodyPreview?: string | null
  }): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT target, model, account_id, status_code, created_at, request_body_preview
       FROM usage_records
       WHERE session_key = $1
         AND COALESCE(attempt_kind, 'final') = 'final'
       ORDER BY created_at DESC
       LIMIT $2`,
      [input.sessionKey, STRUCTURED_HANDOFF_ROW_LIMIT],
    )
    const state = buildStructuredHandoffState(
      rows.map((row) => (row.request_body_preview as string) ?? null),
    )
    const hasCurrentRequest = extractLatestUserSnippet(input.currentRequestBodyPreview ?? null) !== null
    return renderStructuredHandoffState(state, hasCurrentRequest)
  }

  async listRoutingGuardUserStats(limit = 10): Promise<Array<{
    userId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }>> {
    await this.pruneExpiredSessionRoutes()
    const now = Date.now()
    const since = new Date(now - ROUTING_BUDGET_WINDOW_MS).toISOString()
    const { rows } = await this.pool.query(
      `WITH active_sessions AS (
         SELECT user_id, COUNT(*)::int AS active_sessions
         FROM session_routes
         WHERE user_id IS NOT NULL
           AND expires_at > $1
         GROUP BY user_id
       ),
       recent_usage AS (
         SELECT
           user_id,
           COUNT(*)::int AS recent_requests,
           COALESCE(SUM(
             input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens
           ), 0)::bigint AS recent_tokens
         FROM usage_records
         WHERE user_id IS NOT NULL
           AND created_at >= $2
          AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
           AND COALESCE(attempt_kind, 'final') = 'final'
         GROUP BY user_id
       )
       SELECT
         COALESCE(active_sessions.user_id, recent_usage.user_id) AS user_id,
         COALESCE(active_sessions.active_sessions, 0)::int AS active_sessions,
         COALESCE(recent_usage.recent_requests, 0)::int AS recent_requests,
         COALESCE(recent_usage.recent_tokens, 0)::bigint AS recent_tokens
       FROM active_sessions
       FULL OUTER JOIN recent_usage
         ON recent_usage.user_id = active_sessions.user_id
       ORDER BY recent_tokens DESC, recent_requests DESC, active_sessions DESC, user_id ASC
       LIMIT $3`,
      [now, since, Math.max(1, Math.min(limit, 50))],
    )
    return rows.map((row) => ({
      userId: row.user_id as string,
      activeSessions: Number(row.active_sessions ?? 0),
      recentRequests: Number(row.recent_requests ?? 0),
      recentTokens: Number(row.recent_tokens ?? 0),
    }))
  }

  async listRoutingGuardDeviceStats(limit = 10): Promise<Array<{
    userId: string
    clientDeviceId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }>> {
    await this.pruneExpiredSessionRoutes()
    const now = Date.now()
    const since = new Date(now - ROUTING_BUDGET_WINDOW_MS).toISOString()
    const { rows } = await this.pool.query(
      `WITH active_sessions AS (
         SELECT user_id, client_device_id, COUNT(*)::int AS active_sessions
         FROM session_routes
         WHERE user_id IS NOT NULL
           AND client_device_id IS NOT NULL
           AND expires_at > $1
         GROUP BY user_id, client_device_id
       ),
       recent_usage AS (
         SELECT
           user_id,
           client_device_id,
           COUNT(*)::int AS recent_requests,
           COALESCE(SUM(
             input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens
           ), 0)::bigint AS recent_tokens
         FROM usage_records
         WHERE user_id IS NOT NULL
           AND client_device_id IS NOT NULL
           AND created_at >= $2
          AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
           AND COALESCE(attempt_kind, 'final') = 'final'
         GROUP BY user_id, client_device_id
       )
       SELECT
         COALESCE(active_sessions.user_id, recent_usage.user_id) AS user_id,
         COALESCE(active_sessions.client_device_id, recent_usage.client_device_id) AS client_device_id,
         COALESCE(active_sessions.active_sessions, 0)::int AS active_sessions,
         COALESCE(recent_usage.recent_requests, 0)::int AS recent_requests,
         COALESCE(recent_usage.recent_tokens, 0)::bigint AS recent_tokens
       FROM active_sessions
       FULL OUTER JOIN recent_usage
         ON recent_usage.user_id = active_sessions.user_id
        AND recent_usage.client_device_id = active_sessions.client_device_id
       ORDER BY recent_tokens DESC, recent_requests DESC, active_sessions DESC, user_id ASC, client_device_id ASC
       LIMIT $3`,
      [now, since, Math.max(1, Math.min(limit, 50))],
    )
    return rows.map((row) => ({
      userId: row.user_id as string,
      clientDeviceId: row.client_device_id as string,
      activeSessions: Number(row.active_sessions ?? 0),
      recentRequests: Number(row.recent_requests ?? 0),
      recentTokens: Number(row.recent_tokens ?? 0),
    }))
  }

  private async pruneExpiredSessionRoutes(): Promise<void> {
    const now = Date.now()
    if (now - this.lastSessionRoutePruneAt < 60_000) {
      return
    }
    this.lastSessionRoutePruneAt = now
    try {
      await this.pool.query('DELETE FROM session_routes WHERE expires_at <= $1', [now])
    } catch (error) {
      this.lastSessionRoutePruneAt = 0
      throw error
    }
  }

  // ── Query methods for user usage ──

  async listUsersWithUsage(): Promise<Array<RelayUser & {
    sessionCount: number
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    lastActiveAt: string | null
    relayKeySourceSummary: {
      recentWindowLimit: number
      countedRequests: number
      relayApiKeysCount: number
      legacyFallbackCount: number
    }
  }>> {
    const users = await this.listUsers()
    if (!users.length) return []
    const recentWindowLimit = RELAY_KEY_SOURCE_SUMMARY_RECENT_WINDOW
    const userIds = users.map((user) => user.id)

    const [{ rows }, summaryResult] = await Promise.all([
      this.pool.query(`
        SELECT
          user_id,
          COUNT(DISTINCT session_key) AS session_count,
          COUNT(*) AS total_requests,
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          MAX(created_at) AS last_active_at
        FROM usage_records
        WHERE user_id IS NOT NULL
          AND COALESCE(attempt_kind, 'final') = 'final'
        GROUP BY user_id
      `),
      this.pool.query(`
        WITH ranked_requests AS (
          SELECT
            user_id,
            relay_key_source,
            ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS row_number
          FROM usage_records
          WHERE user_id = ANY($1::text[])
            AND COALESCE(attempt_kind, 'final') = 'final'
        )
        SELECT
          user_id,
          COUNT(*)::int AS counted_requests,
          COUNT(*) FILTER (WHERE relay_key_source = 'relay_api_keys')::int AS relay_api_keys_count,
          COUNT(*) FILTER (WHERE relay_key_source = 'relay_users_legacy')::int AS legacy_fallback_count
        FROM ranked_requests
        WHERE row_number <= $2
        GROUP BY user_id
      `, [userIds, recentWindowLimit]),
    ])

    const usageMap = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      usageMap.set(row.user_id as string, row)
    }

    const relayKeySourceSummaryMap = new Map<string, {
      recentWindowLimit: number
      countedRequests: number
      relayApiKeysCount: number
      legacyFallbackCount: number
    }>()
    for (const row of summaryResult.rows) {
      relayKeySourceSummaryMap.set(row.user_id as string, {
        recentWindowLimit,
        countedRequests: Number(row.counted_requests ?? 0),
        relayApiKeysCount: Number(row.relay_api_keys_count ?? 0),
        legacyFallbackCount: Number(row.legacy_fallback_count ?? 0),
      })
    }

    return users.map((user) => {
      const usage = usageMap.get(user.id)
      const relayKeySourceSummary = relayKeySourceSummaryMap.get(user.id) ?? {
        recentWindowLimit,
        countedRequests: 0,
        relayApiKeysCount: 0,
        legacyFallbackCount: 0,
      }
      return {
        ...user,
        sessionCount: usage ? Number(usage.session_count) : 0,
        totalRequests: usage ? Number(usage.total_requests) : 0,
        totalInputTokens: usage ? Number(usage.total_input_tokens) : 0,
        totalOutputTokens: usage ? Number(usage.total_output_tokens) : 0,
        lastActiveAt: usage?.last_active_at ? (usage.last_active_at as Date).toISOString() : null,
        relayKeySourceSummary,
      }
    })
  }

  async getUserRelayKeySourceSummary(
    userId: string,
    recentWindowLimit = 100,
  ): Promise<{
    recentWindowLimit: number
    countedRequests: number
    relayApiKeysCount: number
    legacyFallbackCount: number
  }> {
    const normalizedWindowLimit = normalizeRelayKeySourceSummaryWindow(recentWindowLimit)
    const { rows } = await this.pool.query(`
      WITH recent_requests AS (
        SELECT relay_key_source
        FROM usage_records
        WHERE user_id = $1
          AND COALESCE(attempt_kind, 'final') = 'final'
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      )
      SELECT
        COUNT(*)::int AS counted_requests,
        COUNT(*) FILTER (WHERE relay_key_source = 'relay_api_keys')::int AS relay_api_keys_count,
        COUNT(*) FILTER (WHERE relay_key_source = 'relay_users_legacy')::int AS legacy_fallback_count
      FROM recent_requests
    `, [userId, normalizedWindowLimit])

    const summary = rows[0] ?? {}
    return {
      recentWindowLimit: normalizedWindowLimit,
      countedRequests: Number(summary.counted_requests ?? 0),
      relayApiKeysCount: Number(summary.relay_api_keys_count ?? 0),
      legacyFallbackCount: Number(summary.legacy_fallback_count ?? 0),
    }
  }

  async getUserSessions(userId: string): Promise<Array<{
    sessionKey: string
    requestCount: number
    totalInputTokens: number
    totalOutputTokens: number
    firstSeenAt: string
    lastActiveAt: string
    accountId: string | null
    clientDeviceId: string | null
  }>> {
    const { rows } = await this.pool.query(`
      SELECT
        usage_records.session_key,
        COUNT(*) AS request_count,
        COALESCE(SUM(usage_records.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(usage_records.output_tokens), 0) AS total_output_tokens,
        MIN(usage_records.created_at) AS first_seen_at,
        MAX(usage_records.created_at) AS last_active_at,
        (ARRAY_AGG(usage_records.account_id ORDER BY usage_records.created_at DESC))[1] AS account_id,
        COALESCE(
          (ARRAY_REMOVE(ARRAY_AGG(usage_records.client_device_id ORDER BY usage_records.created_at DESC), NULL))[1],
          MAX(session_routes.client_device_id)
        ) AS client_device_id
      FROM usage_records
      LEFT JOIN session_routes
        ON session_routes.session_key = usage_records.session_key
      WHERE usage_records.user_id = $1
        AND usage_records.session_key IS NOT NULL
        AND COALESCE(usage_records.attempt_kind, 'final') = 'final'
      GROUP BY usage_records.session_key
      ORDER BY MAX(usage_records.created_at) DESC
    `, [userId])

    return rows.map((row) => ({
      sessionKey: row.session_key as string,
      requestCount: Number(row.request_count),
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      firstSeenAt: (row.first_seen_at as Date).toISOString(),
      lastActiveAt: (row.last_active_at as Date).toISOString(),
      accountId: (row.account_id as string) ?? null,
      clientDeviceId: (row.client_device_id as string) ?? null,
    }))
  }

  async getUserRequests(
    userId: string,
    limit = 50,
    offset = 0,
    relayKeySource: RelayKeySource | null = null,
  ): Promise<{ requests: Array<Record<string, unknown>>; total: number }> {
    const filterParams: unknown[] = [userId]
    const relayKeySourceClause = relayKeySource
      ? `AND relay_key_source = $${filterParams.push(relayKeySource)}`
      : ''
    const listParams = [...filterParams, limit, offset]
    const [{ rows }, countResult] = await Promise.all([
      this.pool.query(`
        SELECT id AS usage_record_id, request_id, account_id, session_key, client_device_id, model,
               input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
               status_code, duration_ms, target, relay_key_source, created_at
        FROM usage_records
        WHERE user_id = $1
          AND COALESCE(attempt_kind, 'final') = 'final'
          ${relayKeySourceClause}
        ORDER BY created_at DESC
        LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}
      `, listParams),
      this.pool.query(
        `SELECT COUNT(*) AS total
         FROM usage_records
         WHERE user_id = $1
           AND COALESCE(attempt_kind, 'final') = 'final'
           ${relayKeySourceClause}`,
        filterParams,
      ),
    ])

    return {
      requests: rows.map((r) => ({
        usageRecordId: Number(r.usage_record_id),
        requestId: r.request_id,
        accountId: r.account_id,
        sessionKey: r.session_key,
        clientDeviceId: r.client_device_id ?? null,
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_input_tokens ?? 0),
        cacheCreationTokens: Number(r.cache_creation_input_tokens ?? 0),
        statusCode: r.status_code,
        durationMs: r.duration_ms,
        target: r.target,
        relayKeySource: r.relay_key_source ?? null,
        createdAt: (r.created_at as Date).toISOString(),
      })),
      total: Number(countResult.rows[0].total),
    }
  }

  async getSessionRequests(
    userId: string,
    sessionKey: string,
    limit = 100,
    offset = 0,
    relayKeySource: RelayKeySource | null = null,
  ): Promise<{ requests: Array<Record<string, unknown>>; total: number }> {
    const filterParams: unknown[] = [userId, sessionKey]
    const relayKeySourceClause = relayKeySource
      ? `AND relay_key_source = $${filterParams.push(relayKeySource)}`
      : ''
    const listParams = [...filterParams, limit, offset]
    const [{ rows }, countResult] = await Promise.all([
      this.pool.query(`
        SELECT id AS usage_record_id, request_id, account_id, session_key, client_device_id, model,
               input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
               status_code, duration_ms, target, relay_key_source, created_at
        FROM usage_records
        WHERE user_id = $1
          AND session_key = $2
          AND COALESCE(attempt_kind, 'final') = 'final'
          ${relayKeySourceClause}
        ORDER BY created_at DESC
        LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}
      `, listParams),
      this.pool.query(
        `SELECT COUNT(*) AS total
         FROM usage_records
         WHERE user_id = $1
           AND session_key = $2
           AND COALESCE(attempt_kind, 'final') = 'final'
           ${relayKeySourceClause}`,
        filterParams,
      ),
    ])

    return {
      requests: rows.map((r) => ({
        usageRecordId: Number(r.usage_record_id),
        requestId: r.request_id,
        accountId: r.account_id,
        sessionKey: r.session_key,
        clientDeviceId: r.client_device_id ?? null,
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_input_tokens ?? 0),
        cacheCreationTokens: Number(r.cache_creation_input_tokens ?? 0),
        statusCode: r.status_code,
        durationMs: r.duration_ms,
        target: r.target,
        relayKeySource: r.relay_key_source ?? null,
        createdAt: (r.created_at as Date).toISOString(),
      })),
      total: Number(countResult.rows[0].total),
    }
  }

  async getRiskDashboardSummary(input: {
    since?: string | null
  } = {}): Promise<Record<string, unknown>> {
    const since = input.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { rows } = await this.pool.query(`
      WITH base AS (
        SELECT
          id,
          user_id,
          account_id,
          session_key,
          client_device_id,
          target,
          split_part(target, '?', 1) AS path,
          status_code,
          input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens AS tokens,
          created_at,
          request_headers,
          response_body_preview,
          LAG(account_id) OVER (PARTITION BY session_key ORDER BY created_at) AS previous_account_id
        FROM usage_records
        WHERE created_at >= $1
          AND COALESCE(attempt_kind, 'final') = 'final'
          AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
      ), session_rollup AS (
        SELECT
          session_key,
          COUNT(DISTINCT account_id)::int AS distinct_accounts
        FROM base
        WHERE session_key IS NOT NULL
        GROUP BY session_key
      ), user_rollup AS (
        SELECT
          user_id,
          COUNT(*)::int AS request_count,
          COALESCE(SUM(tokens), 0)::bigint AS token_count,
          COUNT(DISTINCT account_id)::int AS distinct_accounts,
          COUNT(DISTINCT client_device_id)::int AS distinct_devices,
          COUNT(DISTINCT request_headers->>'cf-connecting-ip')::int AS distinct_ips
        FROM base
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      )
      SELECT
        COUNT(*)::int AS total_events,
        COUNT(DISTINCT user_id)::int AS distinct_users,
        COUNT(DISTINCT account_id)::int AS distinct_accounts,
        COUNT(*) FILTER (WHERE status_code IN (401, 403))::int AS auth_failures,
        COUNT(*) FILTER (WHERE status_code = 403 AND lower(coalesce(response_body_preview, '')) LIKE '%access to claude%')::int AS revoked_403,
        COUNT(*) FILTER (WHERE previous_account_id IS NOT NULL AND previous_account_id <> account_id)::int AS account_switches,
        COUNT(*) FILTER (WHERE status_code = 429 OR lower(coalesce(request_headers->>'anthropic-ratelimit-unified-status', '')) IN ('rejected', 'throttled', 'blocked'))::int AS rate_limited,
        COALESCE(MAX(tokens), 0)::bigint AS max_tokens_per_request,
        COALESCE((SELECT MAX(token_count) FROM user_rollup), 0)::bigint AS max_tokens_per_user,
        COALESCE((SELECT MAX(request_count) FROM user_rollup), 0)::int AS max_requests_per_user,
        COALESCE((SELECT COUNT(*) FROM user_rollup WHERE distinct_accounts >= 3), 0)::int AS multi_account_users,
        COALESCE((SELECT COUNT(*) FROM session_rollup WHERE distinct_accounts >= 2), 0)::int AS multi_account_sessions
      FROM base
    `, [since])
    const row = rows[0] ?? {}
    return {
      since,
      totalEvents: Number(row.total_events ?? 0),
      distinctUsers: Number(row.distinct_users ?? 0),
      distinctAccounts: Number(row.distinct_accounts ?? 0),
      authFailures: Number(row.auth_failures ?? 0),
      revoked403: Number(row.revoked_403 ?? 0),
      accountSwitches: Number(row.account_switches ?? 0),
      rateLimited: Number(row.rate_limited ?? 0),
      maxTokensPerRequest: Number(row.max_tokens_per_request ?? 0),
      maxTokensPerUser: Number(row.max_tokens_per_user ?? 0),
      maxRequestsPerUser: Number(row.max_requests_per_user ?? 0),
      multiAccountUsers: Number(row.multi_account_users ?? 0),
      multiAccountSessions: Number(row.multi_account_sessions ?? 0),
    }
  }

  async getRiskDashboardEvents(input: {
    since?: string | null
    limit?: number
    offset?: number
    userId?: string | null
    accountId?: string | null
    sessionKey?: string | null
    clientDeviceId?: string | null
    ip?: string | null
    path?: string | null
    statusCode?: number | null
    minTokens?: number | null
    riskOnly?: boolean
    multiAccountOnly?: boolean
    revokedOnly?: boolean
  } = {}): Promise<{ events: Array<Record<string, unknown>>; total: number }> {
    const params: unknown[] = [input.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    const whereClauses = [
      `created_at >= $1`,
      `COALESCE(attempt_kind, 'final') = 'final'`,
      `split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')`,
    ]
    const addParam = (value: unknown) => `$${params.push(value)}`
    if (input.userId) whereClauses.push(`user_id = ${addParam(input.userId)}`)
    if (input.accountId) whereClauses.push(`account_id = ${addParam(input.accountId)}`)
    if (input.sessionKey) whereClauses.push(`session_key = ${addParam(input.sessionKey)}`)
    if (input.clientDeviceId) whereClauses.push(`client_device_id = ${addParam(input.clientDeviceId)}`)
    if (input.ip) whereClauses.push(`request_headers->>'cf-connecting-ip' = ${addParam(input.ip)}`)
    if (input.path) whereClauses.push(`split_part(target, '?', 1) = ${addParam(input.path)}`)
    if (Number.isFinite(input.statusCode)) whereClauses.push(`status_code = ${addParam(Math.floor(Number(input.statusCode)))}`)
    if (Number.isFinite(input.minTokens)) {
      whereClauses.push(`input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens >= ${addParam(Math.floor(Number(input.minTokens)))}`)
    }
    if (input.revokedOnly) {
      whereClauses.push(`status_code IN (401, 403) AND (lower(coalesce(response_body_preview, '')) LIKE '%access to claude%' OR lower(coalesce(response_body_preview, '')) LIKE '%disabled organization%' OR lower(coalesce(response_body_preview, '')) LIKE '%organization is disabled%' OR lower(coalesce(response_body_preview, '')) LIKE '%authentication_failed%' OR lower(coalesce(response_body_preview, '')) LIKE '%oauth token has been revoked%')`)
    }
    const baseWhere = whereClauses.join('\n          AND ')
    const riskClause = input.riskOnly
      ? `WHERE risk_score > 0`
      : ''
    const multiAccountClause = input.multiAccountOnly
      ? `${riskClause ? 'AND' : 'WHERE'} session_distinct_accounts >= 2`
      : ''
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
    const offset = Math.max(0, input.offset ?? 0)
    const listParams = [...params, limit, offset]
    const query = `
      WITH base AS (
        SELECT
          id AS usage_record_id,
          request_id,
          user_id,
          account_id,
          session_key,
          client_device_id,
          model,
          target,
          split_part(target, '?', 1) AS path,
          status_code,
          duration_ms,
          input_tokens,
          output_tokens,
          cache_creation_input_tokens,
          cache_read_input_tokens,
          input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens AS total_tokens,
          created_at,
          request_headers,
          request_body_preview,
          response_headers,
          response_body_preview,
          upstream_request_headers,
          LAG(account_id) OVER (PARTITION BY session_key ORDER BY created_at) AS previous_account_id
        FROM usage_records
        WHERE ${baseWhere}
      ), session_counts AS (
        SELECT session_key, COUNT(DISTINCT account_id)::int AS session_distinct_accounts
        FROM base
        WHERE session_key IS NOT NULL
        GROUP BY session_key
      ), user_counts AS (
        SELECT user_id, COUNT(DISTINCT account_id)::int AS user_distinct_accounts
        FROM base
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      ), device_counts AS (
        SELECT user_id, client_device_id, COUNT(DISTINCT account_id)::int AS device_distinct_accounts
        FROM base
        WHERE user_id IS NOT NULL AND client_device_id IS NOT NULL
        GROUP BY user_id, client_device_id
      ), scored AS (
        SELECT
          base.*,
          COALESCE(session_counts.session_distinct_accounts, 0) AS session_distinct_accounts,
          COALESCE(user_counts.user_distinct_accounts, 0) AS user_distinct_accounts,
          COALESCE(device_counts.device_distinct_accounts, 0) AS device_distinct_accounts,
          (
            CASE WHEN status_code IN (401, 403) THEN 40 ELSE 0 END +
            CASE WHEN status_code IN (401, 403) AND (lower(coalesce(response_body_preview, '')) LIKE '%access to claude%' OR lower(coalesce(response_body_preview, '')) LIKE '%disabled organization%' OR lower(coalesce(response_body_preview, '')) LIKE '%organization is disabled%' OR lower(coalesce(response_body_preview, '')) LIKE '%authentication_failed%' OR lower(coalesce(response_body_preview, '')) LIKE '%oauth token has been revoked%') THEN 80 ELSE 0 END +
            CASE WHEN status_code = 429 THEN 25 ELSE 0 END +
            CASE WHEN lower(coalesce(response_body_preview, '')) LIKE '%unsupported_client%' OR lower(coalesce(response_body_preview, '')) LIKE '%cli_validation_failed%' THEN 20 ELSE 0 END +
            CASE WHEN lower(coalesce(response_body_preview, '')) LIKE '%session account pinning blocked migration%' OR lower(coalesce(response_body_preview, '')) LIKE '%pinning blocked migration%' OR lower(coalesce(response_body_preview, '')) LIKE '%predicted_7d_exhaustion%' THEN 70 ELSE 0 END +
            CASE WHEN total_tokens >= 400000 THEN 25 ELSE 0 END +
            CASE WHEN COALESCE(session_counts.session_distinct_accounts, 0) >= 2 THEN 35 ELSE 0 END +
            CASE WHEN COALESCE(user_counts.user_distinct_accounts, 0) >= 2 THEN 35 ELSE 0 END +
            CASE WHEN COALESCE(device_counts.device_distinct_accounts, 0) >= 2 THEN 35 ELSE 0 END +
            CASE WHEN previous_account_id IS NOT NULL AND previous_account_id <> account_id THEN 45 ELSE 0 END
          )::int AS risk_score
        FROM base
        LEFT JOIN session_counts ON session_counts.session_key = base.session_key
        LEFT JOIN user_counts ON user_counts.user_id = base.user_id
        LEFT JOIN device_counts ON device_counts.user_id = base.user_id AND device_counts.client_device_id = base.client_device_id
      ), filtered AS (
        SELECT * FROM scored
        ${riskClause}
        ${multiAccountClause}
      )
      SELECT *, COUNT(*) OVER() AS total_count
      FROM filtered
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `
    const { rows } = await this.pool.query(query, listParams)
    return {
      events: rows.map((r) => ({
        usageRecordId: Number(r.usage_record_id),
        requestId: r.request_id,
        userId: r.user_id ?? null,
        accountId: r.account_id ?? null,
        sessionKey: r.session_key ?? null,
        clientDeviceId: r.client_device_id ?? null,
        model: r.model ?? null,
        target: r.target,
        path: r.path,
        statusCode: r.status_code,
        durationMs: r.duration_ms,
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        cacheCreationTokens: Number(r.cache_creation_input_tokens ?? 0),
        cacheReadTokens: Number(r.cache_read_input_tokens ?? 0),
        totalTokens: Number(r.total_tokens ?? 0),
        createdAt: (r.created_at as Date).toISOString(),
        ip: r.request_headers?.['cf-connecting-ip'] ?? null,
        userAgent: r.request_headers?.['user-agent'] ?? null,
        xApp: r.request_headers?.['x-app'] ?? null,
        anthropicBeta: r.request_headers?.['anthropic-beta'] ?? null,
        anthropicVersion: r.request_headers?.['anthropic-version'] ?? null,
        claudeCodeSessionId: r.request_headers?.['x-claude-code-session-id'] ?? null,
        directBrowserAccess: r.request_headers?.['anthropic-dangerous-direct-browser-access'] ?? null,
        upstreamAnthropicBeta: r.upstream_request_headers?.['anthropic-beta'] ?? null,
        requestPreview: r.request_body_preview ?? null,
        responsePreview: r.response_body_preview ?? null,
        responseHeaders: r.response_headers ?? null,
        previousAccountId: r.previous_account_id ?? null,
        sessionDistinctAccounts: Number(r.session_distinct_accounts ?? 0),
        userDistinctAccounts: Number(r.user_distinct_accounts ?? 0),
        deviceDistinctAccounts: Number(r.device_distinct_accounts ?? 0),
        riskScore: Number(r.risk_score ?? 0),
      })),
      total: rows.length ? Number(rows[0].total_count ?? 0) : 0,
    }
  }


  async getRiskDashboardTrends(input: {
    since?: string | null
    accountId?: string | null
  } = {}): Promise<{ points: Array<Record<string, unknown>> }> {
    const since = input.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const params: unknown[] = [since]
    const accountFilter = input.accountId ? `AND account_id = $${params.push(input.accountId)}` : ''
    const { rows } = await this.pool.query(
      `WITH base AS (
         SELECT
           date_trunc('minute', created_at) AS minute,
           account_id,
           user_id,
           client_device_id,
           input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens AS tokens,
           cache_read_input_tokens,
           status_code,
           COALESCE(organization_id, response_headers->>'anthropic-organization-id') AS organization_id,
           response_headers->>'anthropic-ratelimit-unified-overage-disabled-reason' AS overage_disabled_reason
         FROM usage_records
         WHERE created_at >= $1
           ${accountFilter}
           AND COALESCE(attempt_kind, 'final') = 'final'
           AND split_part(target, '?', 1) IN ('/v1/messages', '/v1/sessions/ws', '/v1/chat/completions')
       )
       SELECT
         minute,
         COUNT(*)::int AS requests,
         COALESCE(SUM(tokens), 0)::bigint AS tokens,
         COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_tokens,
         COUNT(DISTINCT account_id)::int AS distinct_accounts,
         COUNT(DISTINCT user_id)::int AS distinct_users,
         COUNT(DISTINCT client_device_id)::int AS distinct_devices,
         COUNT(*) FILTER (WHERE status_code >= 400)::int AS errors,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT organization_id), NULL) AS organization_ids,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT overage_disabled_reason), NULL) AS overage_disabled_reasons
       FROM base
       GROUP BY minute
       ORDER BY minute ASC`,
      params,
    )
    return {
      points: rows.map((row) => ({
        minute: (row.minute as Date).toISOString(),
        requests: Number(row.requests ?? 0),
        tokens: Number(row.tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
        distinctAccounts: Number(row.distinct_accounts ?? 0),
        distinctUsers: Number(row.distinct_users ?? 0),
        distinctDevices: Number(row.distinct_devices ?? 0),
        errors: Number(row.errors ?? 0),
        organizationIds: Array.isArray(row.organization_ids) ? row.organization_ids : [],
        overageDisabledReasons: Array.isArray(row.overage_disabled_reasons) ? row.overage_disabled_reasons : [],
      })),
    }
  }

  async getRequestDetail(
    userId: string,
    requestId: string,
    usageRecordId?: number | null,
  ): Promise<Record<string, unknown> | null> {
    const hasUsageRecordId = Number.isFinite(usageRecordId)
    const params: unknown[] = hasUsageRecordId
      ? [userId, requestId, Math.floor(Number(usageRecordId))]
      : [userId, requestId]
    const usageRecordFilter = hasUsageRecordId ? 'AND id = $3' : ''

    const { rows } = await this.pool.query(`
      SELECT id AS usage_record_id, request_id, account_id, session_key, client_device_id, model,
             input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
             status_code, duration_ms, target, relay_key_source, created_at,
             request_headers, request_body_preview, response_headers, response_body_preview, upstream_request_headers
      FROM usage_records
      WHERE user_id = $1
        AND request_id = $2
        ${usageRecordFilter}
        AND COALESCE(attempt_kind, 'final') = 'final'
      ORDER BY created_at DESC
      LIMIT 1
    `, params)

    if (!rows.length) return null
    const r = rows[0]
    return mapUsageRecordRowToDetail(r)
  }

  async getOrganizationRequestDetail(
    organizationId: string,
    requestId: string,
    usageRecordId?: number | null,
    legacyUserId?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const hasUsageRecordId = Number.isFinite(usageRecordId)
    const params: unknown[] = [organizationId, requestId]
    let ownerFilter = 'organization_id = $1'
    if (legacyUserId) {
      params.push(legacyUserId)
      ownerFilter = `(organization_id = $1 OR user_id = $${params.length})`
    }
    let usageRecordFilter = ''
    if (hasUsageRecordId) {
      params.push(Math.floor(Number(usageRecordId)))
      usageRecordFilter = `AND id = $${params.length}`
    }

    const { rows } = await this.pool.query(`
      SELECT id AS usage_record_id, request_id, account_id, session_key, client_device_id, model,
             input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
             status_code, duration_ms, target, relay_key_source, created_at,
             request_headers, request_body_preview, response_headers, response_body_preview, upstream_request_headers
      FROM usage_records
      WHERE ${ownerFilter}
        AND request_id = $2
        ${usageRecordFilter}
        AND COALESCE(attempt_kind, 'final') = 'final'
      ORDER BY created_at DESC
      LIMIT 1
    `, params)

    if (!rows.length) return null
    return mapUsageRecordRowToDetail(rows[0])
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function mapUsageRecordRowToDetail(r: Record<string, unknown>): Record<string, unknown> {
  return {
    usageRecordId: Number(r.usage_record_id),
    requestId: r.request_id,
    accountId: r.account_id,
    sessionKey: r.session_key,
    clientDeviceId: r.client_device_id ?? null,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_input_tokens ?? 0),
    cacheCreationTokens: Number(r.cache_creation_input_tokens ?? 0),
    statusCode: r.status_code,
    durationMs: r.duration_ms,
    target: r.target,
    relayKeySource: r.relay_key_source ?? null,
    createdAt: (r.created_at as Date).toISOString(),
    requestHeaders: r.request_headers ?? null,
    requestBodyPreview: r.request_body_preview ?? null,
    responseHeaders: r.response_headers ?? null,
    responseBodyPreview: r.response_body_preview ?? null,
    upstreamRequestHeaders: r.upstream_request_headers ?? null,
  }
}

function computeUsageDelta(previous: number | null, current: number | null): number {
  if (previous == null || current == null) {
    return 0
  }
  if (current >= previous) {
    return Math.max(0, current - previous)
  }
  // Large drop indicates a quota window reset; current is consumption since reset
  if (previous - current > 0.05) {
    return current
  }
  return 0
}

function updateEma(previous: number | null, sample: number): number | null {
  if (!Number.isFinite(sample) || sample <= 0) {
    return previous
  }
  if (previous == null || !Number.isFinite(previous)) {
    return sample
  }
  const alpha = 0.4
  return previous * (1 - alpha) + sample * alpha
}

function buildStructuredHandoffState(
  previews: Array<string | null>,
): StructuredHandoffState {
  const state: StructuredHandoffState = {
    recentUserGoals: [],
    recentAssistantContext: [],
    persistentInstructions: [],
  }
  const seenUserGoals = new Set<string>()
  const seenAssistantContext = new Set<string>()
  const seenInstructions = new Set<string>()

  for (const preview of previews) {
    const parsed = parseRequestPreview(preview)
    if (!parsed) {
      const fallbackUserSnippet = extractLatestUserSnippet(preview)
      if (fallbackUserSnippet) {
        pushUniqueSnippet(
          state.recentUserGoals,
          seenUserGoals,
          fallbackUserSnippet,
          STRUCTURED_HANDOFF_USER_LIMIT,
        )
      }
      continue
    }

    const messages = Array.isArray(parsed.messages) ? [...parsed.messages].reverse() : []
    for (const message of messages) {
      const snippet = extractMessageTextSnippet(message)
      if (!snippet) {
        continue
      }
      if (message.role === 'user') {
        pushUniqueSnippet(
          state.recentUserGoals,
          seenUserGoals,
          snippet,
          STRUCTURED_HANDOFF_USER_LIMIT,
        )
        continue
      }
      if (message.role === 'assistant') {
        pushUniqueSnippet(
          state.recentAssistantContext,
          seenAssistantContext,
          snippet,
          STRUCTURED_HANDOFF_ASSISTANT_LIMIT,
        )
      }
    }

    for (const snippet of extractSystemTextSnippets(parsed.system)) {
      pushUniqueSnippet(
        state.persistentInstructions,
        seenInstructions,
        snippet,
        STRUCTURED_HANDOFF_SYSTEM_LIMIT,
      )
    }

    if (
      state.recentUserGoals.length >= STRUCTURED_HANDOFF_USER_LIMIT &&
      state.recentAssistantContext.length >= STRUCTURED_HANDOFF_ASSISTANT_LIMIT &&
      state.persistentInstructions.length >= STRUCTURED_HANDOFF_SYSTEM_LIMIT
    ) {
      break
    }
  }

  return state
}

function renderStructuredHandoffState(
  state: StructuredHandoffState,
  hasCurrentRequest: boolean,
): string {
  const lines = [HANDOFF_SYSTEM_TITLES[0]]
  if (state.recentUserGoals.length > 0) {
    lines.push('最近用户目标：')
    lines.push(...state.recentUserGoals.map((item, index) => `${index + 1}. ${item}`))
  }
  if (state.recentAssistantContext.length > 0) {
    lines.push('最近已给出的结论或动作：')
    lines.push(...state.recentAssistantContext.map((item, index) => `${index + 1}. ${item}`))
  }
  if (state.persistentInstructions.length > 0) {
    lines.push('持续约束：')
    lines.push(...state.persistentInstructions.map((item, index) => `${index + 1}. ${item}`))
  }
  if (
    state.recentUserGoals.length === 0 &&
    state.recentAssistantContext.length === 0 &&
    state.persistentInstructions.length === 0
  ) {
    lines.push('没有可复用的历史摘要时，直接根据当前请求继续。')
  } else if (hasCurrentRequest) {
    lines.push('当前这轮请求已经包含在 messages 中，不要重复复述。')
  }
  lines.push(HANDOFF_SYSTEM_TITLES[1])
  return lines.join('\n')
}

function parseRequestPreview(preview: string | null): PreviewPayload | null {
  if (!preview) {
    return null
  }
  try {
    return JSON.parse(preview) as PreviewPayload
  } catch {
    return null
  }
  return null
}

function extractLatestUserSnippet(preview: string | null): string | null {
  const parsed = parseRequestPreview(preview)
  if (parsed && Array.isArray(parsed.messages)) {
    const messages = [...parsed.messages].reverse()
    for (const message of messages) {
      if (message?.role !== 'user') {
        continue
      }
      const snippet = extractMessageTextSnippet(message)
      if (snippet) {
        return snippet
      }
    }
  }
  return preview ? compactSnippet(preview) : null
}

function extractMessageTextSnippet(message: PreviewMessage | null | undefined): string | null {
  if (!message) {
    return null
  }
  return compactSnippet(extractContentText(message.content))
}

function extractContentText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join(' ')
  }
  return ''
}

function extractSystemTextSnippets(
  system: string | Array<{ type?: string; text?: string }> | undefined,
): string[] {
  const texts = typeof system === 'string'
    ? [system]
    : Array.isArray(system)
      ? system
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text ?? '')
      : []

  return texts
    .filter((text) => !isRelayGeneratedSystemText(text))
    .map((text) => compactSnippet(text))
    .filter((text): text is string => Boolean(text))
}

function isRelayGeneratedSystemText(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) {
    return false
  }
  return normalized.includes('relay_handoff_summary=true') ||
    normalized.includes('这是 relay 在本地生成的会话交接摘要。') ||
    normalized.includes('请把本次请求视为一个新的上游会话') ||
    normalized.startsWith(HANDOFF_SYSTEM_TITLES[0])
}

function pushUniqueSnippet(
  target: string[],
  seen: Set<string>,
  value: string,
  limit: number,
): void {
  if (target.length >= limit || seen.has(value)) {
    return
  }
  seen.add(value)
  target.push(value)
}

function compactSnippet(text: string): string | null {
  const compacted = text.replace(/\s+/g, ' ').trim()
  if (!compacted) {
    return null
  }
  return compacted.length <= 220 ? compacted : `${compacted.slice(0, 217)}...`
}
