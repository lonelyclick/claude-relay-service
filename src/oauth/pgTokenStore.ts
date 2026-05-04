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

function inferProxyKind(url: string | null | undefined, localUrl: string | null | undefined): ProxyEntry['kind'] {
  const source = `${url ?? ''} ${localUrl ?? ''}`.toLowerCase()
  if (source.includes('vless://')) return 'vless-upstream'
  if (source.includes('socks://') || source.includes('socks5://')) return 'local-socks'
  return 'local-http'
}

function normalizeStatus(status: StoredAccount['status'] | undefined): StoredAccount['status'] {
  if (status === 'active' || status === 'temp_error' || status === 'revoked' || status === 'banned') {
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

const MODEL_MAP_MAX_ENTRIES = 64

function normalizeOpenAICompatibleModelMap(input: unknown): StoredAccount['modelMap'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const src = input as Record<string, unknown>
  const next: Record<string, string> = {}
  let count = 0
  for (const rawKey of Object.keys(src)) {
    if (count >= MODEL_MAP_MAX_ENTRIES) break
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) continue
    const rawValue = src[rawKey]
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!value) continue
    next[key] = value
    count += 1
  }
  return count > 0 ? next : null
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
    warmupEnabled: account.warmupEnabled ?? true,
    warmupPolicyId: account.warmupPolicyId === 'b' || account.warmupPolicyId === 'c' || account.warmupPolicyId === 'd' || account.warmupPolicyId === 'e' ? account.warmupPolicyId : 'a',
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
    directEgressEnabled: account.directEgressEnabled === true,
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
    modelMap: normalizeOpenAICompatibleModelMap(account.modelMap),
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
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    })
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
        'SELECT id, name, type, description, description_zh, is_active, created_at, updated_at FROM routing_groups',
      )
      return result.rows.map((row: {
        id: string
        name: string
        type: RoutingGroup['type']
        description: string | null
        description_zh: string | null
        is_active: boolean
        created_at: Date
        updated_at: Date
      }) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        description: row.description,
        descriptionZh: row.description_zh,
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
      `SELECT id, label, url, local_url, kind, enabled, source, listen,
              inbound_port, inbound_protocol, outbound_tag, xray_config_path,
              last_probe_status, last_probe_at, egress_ip, created_at
       FROM proxies`,
    )
    const routingGroupsResult = await client.query(
      'SELECT id, name, type, description, description_zh, is_active, created_at, updated_at FROM routing_groups',
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
      (row: {
        id: string
        label: string
        url: string
        local_url: string | null
        kind: ProxyEntry['kind'] | null
        enabled: boolean | null
        source: ProxyEntry['source'] | null
        listen: string | null
        inbound_port: number | string | null
        inbound_protocol: ProxyEntry['inboundProtocol'] | null
        outbound_tag: string | null
        xray_config_path: string | null
        last_probe_status: string | null
        last_probe_at: Date | string | null
        egress_ip: string | null
        created_at: string
      }) => ({
        id: row.id,
        label: row.label,
        url: row.url,
        localUrl: row.local_url,
        kind: row.kind ?? inferProxyKind(row.url, row.local_url),
        enabled: row.enabled ?? true,
        source: row.source ?? 'manual',
        listen: row.listen,
        inboundPort: row.inbound_port === null ? null : Number(row.inbound_port),
        inboundProtocol: row.inbound_protocol,
        outboundTag: row.outbound_tag,
        xrayConfigPath: row.xray_config_path,
        lastProbeStatus: row.last_probe_status,
        lastProbeAt: row.last_probe_at instanceof Date ? row.last_probe_at.toISOString() : row.last_probe_at,
        egressIp: row.egress_ip,
        createdAt: Number(row.created_at),
      }),
    )
    const routingGroups: RoutingGroup[] = routingGroupsResult.rows.map(
      (row: {
        id: string
        name: string
        type: RoutingGroup['type']
        description: string | null
        description_zh: string | null
        is_active: boolean
        created_at: Date
        updated_at: Date
      }) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        description: row.description,
        descriptionZh: row.description_zh,
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
        kind TEXT NOT NULL DEFAULT 'local-http',
        enabled BOOLEAN NOT NULL DEFAULT true,
        source TEXT NOT NULL DEFAULT 'manual',
        listen TEXT,
        inbound_port INTEGER,
        inbound_protocol TEXT,
        outbound_tag TEXT,
        xray_config_path TEXT,
        last_probe_status TEXT,
        last_probe_at TIMESTAMPTZ,
        egress_ip TEXT,
        created_at BIGINT NOT NULL
      )
    `)
    await client.query("ALTER TABLE proxies ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'local-http'")
    await client.query("ALTER TABLE proxies ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true")
    await client.query("ALTER TABLE proxies ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'")
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS listen TEXT')
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS inbound_port INTEGER')
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS inbound_protocol TEXT')
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS outbound_tag TEXT')
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS xray_config_path TEXT')
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS last_probe_status TEXT')
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ')
    await client.query('ALTER TABLE proxies ADD COLUMN IF NOT EXISTS egress_ip TEXT')
    await client.query(`
      CREATE TABLE IF NOT EXISTS routing_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'anthropic',
        description TEXT,
        description_zh TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(
      "ALTER TABLE routing_groups ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'anthropic'",
    )
    await client.query(
      'ALTER TABLE routing_groups ADD COLUMN IF NOT EXISTS description_zh TEXT',
    )
    await client.query(
      `UPDATE routing_groups
       SET type = CASE type
         WHEN 'claude' THEN 'anthropic'
         WHEN 'gemini' THEN 'google'
         ELSE type
       END
       WHERE type IN ('claude', 'gemini')`,
    )
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
        `INSERT INTO proxies (
           id, label, url, local_url, kind, enabled, source, listen, inbound_port,
           inbound_protocol, outbound_tag, xray_config_path, last_probe_status,
           last_probe_at, egress_ip, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           label = $2, url = $3, local_url = $4, kind = $5, enabled = $6,
           source = $7, listen = $8, inbound_port = $9, inbound_protocol = $10,
           outbound_tag = $11, xray_config_path = $12, last_probe_status = $13,
           last_probe_at = $14, egress_ip = $15, created_at = $16`,
        [
          proxy.id,
          proxy.label,
          proxy.url,
          proxy.localUrl,
          proxy.kind ?? inferProxyKind(proxy.url, proxy.localUrl),
          proxy.enabled ?? true,
          proxy.source ?? 'manual',
          proxy.listen ?? null,
          proxy.inboundPort ?? null,
          proxy.inboundProtocol ?? null,
          proxy.outboundTag ?? null,
          proxy.xrayConfigPath ?? null,
          proxy.lastProbeStatus ?? null,
          proxy.lastProbeAt ?? null,
          proxy.egressIp ?? null,
          proxy.createdAt,
        ],
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
        `INSERT INTO routing_groups (id, name, type, description, description_zh, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           name = $2,
           type = $3,
           description = $4,
           description_zh = $5,
           is_active = $6,
           created_at = $7,
           updated_at = $8`,
        [
          group.id,
          group.name,
          group.type,
          group.description,
          group.descriptionZh,
          group.isActive,
          group.createdAt,
          group.updatedAt,
        ],
      )
    }
  }
}
