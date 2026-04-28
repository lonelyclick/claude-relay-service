import crypto from 'node:crypto'

import pg from 'pg'

import type {
  ITokenStore,
  ProxyEntry,
  RoutingGroup,
  StickySessionBinding,
  StoredAccount,
  TokenStoreData,
} from '../types.js'
import { buildProviderScopedAccountId } from '../providers/accountRef.js'
import { resolveProviderProfile } from '../providers/catalog.js'

function normalizeStatus(status: StoredAccount['status'] | undefined): StoredAccount['status'] {
  if (status === 'active' || status === 'temp_error' || status === 'revoked') {
    return status
  }
  return 'active'
}

function normalizeClaudeCompatibleTierMap(input: unknown): StoredAccount['modelTierMap'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const src = input as Record<string, unknown>
  const pick = (key: 'opus' | 'sonnet' | 'haiku') => {
    const v = src[key]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const next = { opus: pick('opus'), sonnet: pick('sonnet'), haiku: pick('haiku') }
  return next.opus || next.sonnet || next.haiku ? next : null
}

function deriveAccountLocalId(input: {
  accountUuid: string | null
  emailAddress: string | null
  createdAt: string | undefined
}): string {
  if (input.accountUuid) {
    return input.accountUuid
  }
  if (input.emailAddress) {
    return `email:${input.emailAddress}`
  }
  return crypto
    .createHash('sha256')
    .update(`legacy:${input.createdAt ?? 'unknown'}`)
    .digest('hex')
    .slice(0, 24)
}

export function normalizeStoredAccount(account: StoredAccount): StoredAccount {
  const profile = resolveProviderProfile(account.provider)
  const accountUuid = account.accountUuid?.trim() || null
  const emailAddress = account.emailAddress?.trim().toLowerCase() || null
  const label = typeof account.label === 'string' && account.label.trim()
    ? account.label.trim()
    : null
  const routingGroupId =
    typeof account.routingGroupId === 'string' && account.routingGroupId.trim()
      ? account.routingGroupId.trim()
      : typeof account.group === 'string' && account.group.trim()
        ? account.group.trim()
        : null

  return {
    id:
      account.id?.trim() ||
      buildProviderScopedAccountId(
        profile.id,
        deriveAccountLocalId({ accountUuid, emailAddress, createdAt: account.createdAt }),
      ),
    provider: profile.id,
    protocol: account.protocol ?? profile.protocol,
    authMode: account.authMode ?? profile.authMode,
    label,
    isActive: account.isActive ?? true,
    status: normalizeStatus(account.status),
    lastSelectedAt: account.lastSelectedAt ?? null,
    lastUsedAt: account.lastUsedAt ?? null,
    lastRefreshAt: account.lastRefreshAt ?? null,
    lastFailureAt: account.lastFailureAt ?? null,
    cooldownUntil:
      typeof account.cooldownUntil === 'number' && Number.isFinite(account.cooldownUntil)
        ? account.cooldownUntil
        : null,
    lastError: account.lastError ?? null,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken ?? null,
    expiresAt:
      typeof account.expiresAt === 'number' && Number.isFinite(account.expiresAt)
        ? account.expiresAt
        : null,
    scopes: Array.isArray(account.scopes) ? account.scopes.filter(Boolean) : [],
    createdAt: account.createdAt ?? new Date().toISOString(),
    updatedAt: account.updatedAt ?? new Date().toISOString(),
    subscriptionType: account.subscriptionType ?? null,
    providerPlanTypeRaw: account.providerPlanTypeRaw ?? null,
    rateLimitTier: account.rateLimitTier ?? null,
    accountUuid,
    organizationUuid: account.organizationUuid?.trim() || null,
    emailAddress,
    displayName: account.displayName?.trim() || null,
    hasExtraUsageEnabled: account.hasExtraUsageEnabled ?? null,
    billingType: account.billingType ?? null,
    accountCreatedAt: account.accountCreatedAt ?? null,
    subscriptionCreatedAt: account.subscriptionCreatedAt ?? null,
    rawProfile: account.rawProfile ?? null,
    roles: account.roles ?? null,

    routingGroupId,
    group: routingGroupId,
    maxSessions:
      typeof account.maxSessions === 'number' && Number.isFinite(account.maxSessions) && account.maxSessions > 0
        ? account.maxSessions
        : null,
    weight:
      typeof account.weight === 'number' && Number.isFinite(account.weight) && account.weight > 0
        ? account.weight
        : null,
    planType:
      typeof account.planType === 'string' && account.planType.trim()
        ? account.planType.trim()
        : null,
    planMultiplier:
      typeof account.planMultiplier === 'number' && Number.isFinite(account.planMultiplier) && account.planMultiplier > 0
        ? account.planMultiplier
        : null,
    schedulerEnabled: account.schedulerEnabled ?? true,
    schedulerState:
      account.schedulerState === 'enabled' ||
      account.schedulerState === 'paused' ||
      account.schedulerState === 'draining' ||
      account.schedulerState === 'auto_blocked'
        ? account.schedulerState
        : 'enabled',
    autoBlockedReason: account.autoBlockedReason ?? null,
    autoBlockedUntil:
      typeof account.autoBlockedUntil === 'number' && Number.isFinite(account.autoBlockedUntil)
        ? account.autoBlockedUntil
        : null,
    lastRateLimitStatus: account.lastRateLimitStatus ?? null,
    lastRateLimit5hUtilization:
      typeof account.lastRateLimit5hUtilization === 'number' && Number.isFinite(account.lastRateLimit5hUtilization)
        ? account.lastRateLimit5hUtilization
        : null,
    lastRateLimit7dUtilization:
      typeof account.lastRateLimit7dUtilization === 'number' && Number.isFinite(account.lastRateLimit7dUtilization)
        ? account.lastRateLimit7dUtilization
        : null,
    lastRateLimitReset:
      typeof account.lastRateLimitReset === 'number' && Number.isFinite(account.lastRateLimitReset)
        ? account.lastRateLimitReset
        : null,
    lastRateLimitAt: account.lastRateLimitAt ?? null,
    lastProbeAttemptAt:
      typeof account.lastProbeAttemptAt === 'number' && Number.isFinite(account.lastProbeAttemptAt)
        ? account.lastProbeAttemptAt
        : null,
    proxyUrl: typeof account.proxyUrl === 'string' && account.proxyUrl.trim() ? account.proxyUrl.trim() : null,
    bodyTemplatePath:
      typeof account.bodyTemplatePath === 'string' && account.bodyTemplatePath.trim()
        ? account.bodyTemplatePath.trim()
        : null,
    vmFingerprintTemplatePath:
      typeof account.vmFingerprintTemplatePath === 'string' && account.vmFingerprintTemplatePath.trim()
        ? account.vmFingerprintTemplatePath.trim()
        : null,
    deviceId:
      typeof account.deviceId === 'string' && account.deviceId.trim()
        ? account.deviceId.trim()
        : null,
    apiBaseUrl:
      typeof account.apiBaseUrl === 'string' && account.apiBaseUrl.trim()
        ? account.apiBaseUrl.trim()
        : null,
    modelName:
      typeof account.modelName === 'string' && account.modelName.trim()
        ? account.modelName.trim()
        : null,
    modelTierMap: normalizeClaudeCompatibleTierMap(account.modelTierMap),
    loginPassword:
      typeof account.loginPassword === 'string' && account.loginPassword.trim()
        ? account.loginPassword.trim()
        : null,
  }
}

const EMPTY_STORE_DATA: TokenStoreData = {
  version: 3,
  accounts: [],
  stickySessions: [],
  proxies: [],
  routingGroups: [],
}

type AccountStateLogField =
  | 'isActive'
  | 'status'
  | 'schedulerEnabled'
  | 'schedulerState'
  | 'cooldownUntil'
  | 'autoBlockedUntil'
  | 'autoBlockedReason'
  | 'lastError'
  | 'lastRateLimitStatus'
  | 'lastRateLimitReset'

const ACCOUNT_STATE_LOG_FIELDS: readonly AccountStateLogField[] = [
  'isActive',
  'status',
  'schedulerEnabled',
  'schedulerState',
  'cooldownUntil',
  'autoBlockedUntil',
  'autoBlockedReason',
  'lastError',
  'lastRateLimitStatus',
  'lastRateLimitReset',
]

function logAccountStateTransition(previous: StoredAccount, next: StoredAccount): void {
  const changes: Partial<Record<AccountStateLogField, { from: unknown; to: unknown }>> = {}
  for (const field of ACCOUNT_STATE_LOG_FIELDS) {
    if (previous[field] === next[field]) {
      continue
    }
    changes[field] = {
      from: previous[field],
      to: next[field],
    }
  }

  if (Object.keys(changes).length === 0) {
    return
  }

  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      service: 'claude-oauth-relay',
      timestamp: new Date().toISOString(),
      event: 'account_state_changed',
      accountId: next.id,
      provider: next.provider,
      changes,
    })}\n`,
  )
}

export class PgTokenStore implements ITokenStore {
  private readonly pool: pg.Pool
  private updateChain: Promise<void> = Promise.resolve()
  private tablesEnsured = false

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 })
  }

  async getData(): Promise<TokenStoreData> {
    return this.readData()
  }

  async getAccounts(): Promise<StoredAccount[]> {
    const client = await this.pool.connect()
    try {
      await this.ensureTablesWithClient(client)
      const result = await client.query('SELECT data FROM accounts')
      return result.rows.map((row: { data: StoredAccount }) => normalizeStoredAccount(row.data))
    } finally {
      client.release()
    }
  }

  async getRoutingGroups(): Promise<RoutingGroup[]> {
    const client = await this.pool.connect()
    try {
      await this.ensureTablesWithClient(client)
      const result = await client.query(
        'SELECT id, name, description, is_active, created_at, updated_at FROM routing_groups',
      )
      return result.rows.map((row: {
        id: string
        name: string
        description: string | null
        is_active: boolean
        created_at: Date
        updated_at: Date
      }) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }))
    } finally {
      client.release()
    }
  }

  async updateData<T>(
    updater: (
      data: TokenStoreData,
    ) => Promise<{ data: TokenStoreData; result: T }> | { data: TokenStoreData; result: T },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const client = await this.pool.connect()
      let began = false
      try {
        await client.query('BEGIN')
        began = true
        const current = await this.readDataWithClient(client)
        const { data, result } = await updater(current)
        await this.writeDataWithClient(client, current, data)
        await client.query('COMMIT')
        return result
      } catch (error) {
        if (began) {
          await client.query('ROLLBACK').catch(() => {})
        }
        throw error
      } finally {
        client.release()
      }
    }

    const task = this.updateChain.then(run, run)
    this.updateChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async clear(): Promise<void> {
    const run = async (): Promise<void> => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM accounts')
        await client.query('DELETE FROM sticky_sessions')
        await client.query('DELETE FROM proxies')
        await client.query('DELETE FROM routing_groups')
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }

    const task = this.updateChain.then(run, run)
    this.updateChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async updateAccount(
    accountId: string,
    updater: (account: StoredAccount) => StoredAccount,
  ): Promise<StoredAccount | null> {
    const run = async (): Promise<StoredAccount | null> => {
      const client = await this.pool.connect()
      let began = false
      try {
        await this.ensureTablesWithClient(client)
        await client.query('BEGIN')
        began = true
        const result = await client.query('SELECT data FROM accounts WHERE id = $1 FOR UPDATE', [accountId])
        if (!result.rows.length) {
          await client.query('COMMIT')
          return null
        }

        const current = normalizeStoredAccount(result.rows[0].data as StoredAccount)
        const next = updater(current)
        if (next === current) {
          await client.query('COMMIT')
          return current
        }

        logAccountStateTransition(current, next)
        await client.query(
          `UPDATE accounts
           SET data = $2, updated_at = NOW()
           WHERE id = $1`,
          [accountId, JSON.stringify(next)],
        )
        await client.query('COMMIT')
        return next
      } catch (error) {
        if (began) {
          await client.query('ROLLBACK').catch(() => {})
        }
        throw error
      } finally {
        client.release()
      }
    }

    const task = this.updateChain.then(run, run)
    this.updateChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async readData(): Promise<TokenStoreData> {
    const client = await this.pool.connect()
    try {
      return await this.readDataWithClient(client)
    } finally {
      client.release()
    }
  }

  private async readDataWithClient(client: pg.PoolClient): Promise<TokenStoreData> {
    await this.ensureTablesWithClient(client)
    // Run queries sequentially to avoid pg client concurrent query deprecation warning
    const accountsResult = await client.query('SELECT data FROM accounts')
    const sessionsResult = await client.query(
      'SELECT session_hash, account_id, primary_account_id, created_at, updated_at, expires_at FROM sticky_sessions',
    )
    const proxiesResult = await client.query(
      'SELECT id, label, url, local_url, created_at FROM proxies',
    )
    const routingGroupsResult = await client.query(
      'SELECT id, name, description, is_active, created_at, updated_at FROM routing_groups',
    )

    const accounts: StoredAccount[] = accountsResult.rows.map(
      (row: { data: StoredAccount }) => normalizeStoredAccount(row.data),
    )

    const stickySessions: StickySessionBinding[] = sessionsResult.rows.map(
      (row: { session_hash: string; account_id: string; primary_account_id: string | null; created_at: string; updated_at: string; expires_at: string }) => ({
        sessionHash: row.session_hash,
        accountId: row.account_id,
        primaryAccountId: row.primary_account_id ?? row.account_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: Number(row.expires_at),
      }),
    )

    const proxies: ProxyEntry[] = proxiesResult.rows.map(
      (row: { id: string; label: string; url: string; local_url: string | null; created_at: string }) => ({
        id: row.id,
        label: row.label,
        url: row.url,
        localUrl: row.local_url,
        createdAt: Number(row.created_at),
      }),
    )
    const routingGroups: RoutingGroup[] = routingGroupsResult.rows.map(
      (row: {
        id: string
        name: string
        description: string | null
        is_active: boolean
        created_at: Date
        updated_at: Date
      }) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }),
    )

    if (
      accounts.length === 0 &&
      stickySessions.length === 0 &&
      proxies.length === 0 &&
      routingGroups.length === 0
    ) {
      return structuredClone(EMPTY_STORE_DATA)
    }

    return { version: 3, accounts, stickySessions, proxies, routingGroups }
  }

  private async writeDataWithClient(
    client: pg.PoolClient,
    oldData: TokenStoreData,
    newData: TokenStoreData,
  ): Promise<void> {
    await this.ensureTablesWithClient(client)
    await this.syncAccounts(client, oldData.accounts, newData.accounts)
    await this.syncStickySessions(client, oldData.stickySessions, newData.stickySessions)
    await this.syncProxies(client, oldData.proxies, newData.proxies)
    await this.syncRoutingGroups(client, oldData.routingGroups ?? [], newData.routingGroups ?? [])
  }

  private async ensureTablesWithClient(client: pg.PoolClient): Promise<void> {
    if (this.tablesEnsured) {
      return
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sticky_sessions (
        session_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        primary_account_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `)
    await client.query(
      'ALTER TABLE sticky_sessions ADD COLUMN IF NOT EXISTS primary_account_id TEXT',
    )
    await client.query(
      'UPDATE sticky_sessions SET primary_account_id = account_id WHERE primary_account_id IS NULL',
    )
    await client.query(`
      CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        local_url TEXT,
        created_at BIGINT NOT NULL
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS routing_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(
      'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS rate_limited_until BIGINT',
    )
    this.tablesEnsured = true
  }

  async updateAccountRateLimitedUntil(accountId: string, until: number): Promise<void> {
    const client = await this.pool.connect()
    try {
      await this.ensureTablesWithClient(client)
      await client.query(
        'UPDATE accounts SET rate_limited_until = GREATEST(COALESCE(rate_limited_until, 0), $2) WHERE id = $1',
        [accountId, until],
      )
    } finally {
      client.release()
    }
  }

  async updateAccountLastProbeAttemptAt(accountId: string, at: number): Promise<void> {
    await this.updateAccount(accountId, (account) => ({ ...account, lastProbeAttemptAt: at }))
  }

  async getActiveRateLimitedUntilMap(now: number): Promise<Map<string, number>> {
    const client = await this.pool.connect()
    try {
      await this.ensureTablesWithClient(client)
      const result = await client.query<{ id: string; rate_limited_until: string }>(
        'SELECT id, rate_limited_until FROM accounts WHERE rate_limited_until IS NOT NULL AND rate_limited_until > $1',
        [now],
      )
      const map = new Map<string, number>()
      for (const row of result.rows) {
        map.set(row.id, Number(row.rate_limited_until))
      }
      return map
    } finally {
      client.release()
    }
  }

  private async syncAccounts(
    client: pg.PoolClient,
    oldAccounts: StoredAccount[],
    newAccounts: StoredAccount[],
  ): Promise<void> {
    const newIds = new Set(newAccounts.map((a) => a.id))
    const oldAccountById = new Map(oldAccounts.map((account) => [account.id, account]))

    // Delete removed
    for (const old of oldAccounts) {
      if (!newIds.has(old.id)) {
        await client.query('DELETE FROM accounts WHERE id = $1', [old.id])
      }
    }

    // Upsert all current accounts
    for (const account of newAccounts) {
      const previous = oldAccountById.get(account.id)
      if (previous) {
        logAccountStateTransition(previous, account)
      }
      await client.query(
        `INSERT INTO accounts (id, data, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
        [account.id, JSON.stringify(account)],
      )
    }
  }

  private async syncStickySessions(
    client: pg.PoolClient,
    oldSessions: StickySessionBinding[],
    newSessions: StickySessionBinding[],
  ): Promise<void> {
    const newHashes = new Set(newSessions.map((s) => s.sessionHash))

    for (const old of oldSessions) {
      if (!newHashes.has(old.sessionHash)) {
        await client.query('DELETE FROM sticky_sessions WHERE session_hash = $1', [old.sessionHash])
      }
    }

    for (const session of newSessions) {
      await client.query(
        `INSERT INTO sticky_sessions (session_hash, account_id, primary_account_id, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_hash) DO UPDATE SET account_id = $2, primary_account_id = $3, created_at = $4, updated_at = $5, expires_at = $6`,
        [
          session.sessionHash,
          session.accountId,
          session.primaryAccountId ?? session.accountId,
          session.createdAt,
          session.updatedAt,
          session.expiresAt,
        ],
      )
    }
  }

  private async syncProxies(
    client: pg.PoolClient,
    oldProxies: ProxyEntry[],
    newProxies: ProxyEntry[],
  ): Promise<void> {
    const newIds = new Set(newProxies.map((p) => p.id))

    for (const old of oldProxies) {
      if (!newIds.has(old.id)) {
        await client.query('DELETE FROM proxies WHERE id = $1', [old.id])
      }
    }

    for (const proxy of newProxies) {
      await client.query(
        `INSERT INTO proxies (id, label, url, local_url, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET label = $2, url = $3, local_url = $4, created_at = $5`,
        [proxy.id, proxy.label, proxy.url, proxy.localUrl, proxy.createdAt],
      )
    }
  }

  private async syncRoutingGroups(
    client: pg.PoolClient,
    oldRoutingGroups: RoutingGroup[],
    newRoutingGroups: RoutingGroup[],
  ): Promise<void> {
    const newIds = new Set(newRoutingGroups.map((group) => group.id))

    for (const old of oldRoutingGroups) {
      if (!newIds.has(old.id)) {
        await client.query('DELETE FROM routing_groups WHERE id = $1', [old.id])
      }
    }

    for (const group of newRoutingGroups) {
      await client.query(
        `INSERT INTO routing_groups (id, name, description, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = $2,
           description = $3,
           is_active = $4,
           created_at = $5,
           updated_at = $6`,
        [
          group.id,
          group.name,
          group.description,
          group.isActive,
          group.createdAt,
          group.updatedAt,
        ],
      )
    }
  }
}
