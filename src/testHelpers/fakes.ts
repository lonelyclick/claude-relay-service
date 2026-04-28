import crypto from 'node:crypto'

import type {
  ITokenStore,
  RelayUser,
  SessionHandoff,
  SessionRoute,
  TokenStoreData,
} from '../types.js'

export class MemoryTokenStore implements ITokenStore {
  constructor(private data: TokenStoreData) {}

  async getData(): Promise<TokenStoreData> {
    return structuredClone(this.data)
  }

  async updateData<T>(
    updater: (
      data: TokenStoreData,
    ) => Promise<{ data: TokenStoreData; result: T }> | { data: TokenStoreData; result: T },
  ): Promise<T> {
    const current = structuredClone(this.data)
    const next = await updater(current)
    this.data = structuredClone(next.data)
    return next.result
  }

  async updateAccount(
    accountId: string,
    updater: (account: import('../types.js').StoredAccount) => import('../types.js').StoredAccount,
  ): Promise<import('../types.js').StoredAccount | null> {
    const account = this.data.accounts.find((a) => a.id === accountId)
    if (!account) return null
    const updated = updater(structuredClone(account))
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((a) => (a.id === accountId ? updated : a)),
    }
    return structuredClone(updated)
  }

  async updateAccountRateLimitedUntil(accountId: string, until: number): Promise<void> {
    await this.updateAccount(accountId, (a) => ({ ...a, rateLimitedUntil: until }))
  }

  async updateAccountLastProbeAttemptAt(accountId: string, at: number): Promise<void> {
    await this.updateAccount(accountId, (a) => ({ ...a, lastProbeAttemptAt: at }))
  }

  async getActiveRateLimitedUntilMap(_now: number): Promise<Map<string, number>> {
    return new Map()
  }

  async clear(): Promise<void> {
    this.data = {
      version: 3,
      accounts: [],
      stickySessions: [],
      proxies: [],
      routingGroups: [],
    }
  }
}

export class MemoryUserStore {
  private readonly routes = new Map<string, SessionRoute>()
  private readonly handoffs: SessionHandoff[] = []
  private readonly usersByApiKey = new Map<string, RelayUser>()
  private readonly deviceAffinities: Array<{
    userId: string
    clientDeviceId: string
    accountId: string
    createdAt: string
  }> = []
  private routingGuardSnapshotOverride: {
    userActiveSessions?: number
    clientDeviceActiveSessions?: number
    userRecentRequests?: number
    clientDeviceRecentRequests?: number
    userRecentTokens?: number
    clientDeviceRecentTokens?: number
  } | null = null
  private routingGuardUsersOverride: Array<{
    userId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }> = []
  private routingGuardDevicesOverride: Array<{
    userId: string
    clientDeviceId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }> = []

  addUser(user: RelayUser): void {
    if (user.apiKey) this.usersByApiKey.set(user.apiKey, user)
  }

  getUserByApiKey(apiKey: string): RelayUser | null {
    return this.usersByApiKey.get(apiKey) ?? null
  }

  async bindAccountIfNeeded(_userId: string, _accountId: string): Promise<void> {}

  async getSessionRoute(sessionKey: string): Promise<SessionRoute | null> {
    return clone(this.routes.get(sessionKey) ?? null)
  }

  async listSessionRoutes(): Promise<SessionRoute[]> {
    return [...this.routes.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((route) => clone(route))
  }

  async clearSessionRoutes(): Promise<void> {
    this.routes.clear()
    this.handoffs.length = 0
  }

  async listSessionHandoffs(limit = 200): Promise<SessionHandoff[]> {
    return [...this.handoffs]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((handoff) => clone(handoff))
  }

  async getActiveSessionCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    for (const route of this.routes.values()) {
      counts.set(route.accountId, (counts.get(route.accountId) ?? 0) + 1)
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
    if (this.routingGuardSnapshotOverride) {
      return {
        userActiveSessions: this.routingGuardSnapshotOverride.userActiveSessions ?? 0,
        clientDeviceActiveSessions: this.routingGuardSnapshotOverride.clientDeviceActiveSessions ?? 0,
        userRecentRequests: this.routingGuardSnapshotOverride.userRecentRequests ?? 0,
        clientDeviceRecentRequests: this.routingGuardSnapshotOverride.clientDeviceRecentRequests ?? 0,
        userRecentTokens: this.routingGuardSnapshotOverride.userRecentTokens ?? 0,
        clientDeviceRecentTokens: this.routingGuardSnapshotOverride.clientDeviceRecentTokens ?? 0,
      }
    }

    const userId = input.userId?.trim() ?? ''
    const clientDeviceId = input.clientDeviceId?.trim() ?? ''
    let userActiveSessions = 0
    let clientDeviceActiveSessions = 0

    for (const route of this.routes.values()) {
      if (route.userId !== userId) {
        continue
      }
      userActiveSessions += 1
      if (clientDeviceId && route.clientDeviceId === clientDeviceId) {
        clientDeviceActiveSessions += 1
      }
    }

    return {
      userActiveSessions,
      clientDeviceActiveSessions,
      userRecentRequests: 0,
      clientDeviceRecentRequests: 0,
      userRecentTokens: 0,
      clientDeviceRecentTokens: 0,
    }
  }

  setRoutingGuardSnapshotOverride(input: {
    userActiveSessions?: number
    clientDeviceActiveSessions?: number
    userRecentRequests?: number
    clientDeviceRecentRequests?: number
    userRecentTokens?: number
    clientDeviceRecentTokens?: number
  } | null): void {
    this.routingGuardSnapshotOverride = input
  }

  async listRoutingGuardUserStats(limit = 10): Promise<Array<{
    userId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }>> {
    return this.routingGuardUsersOverride.slice(0, limit).map((item) => clone(item))
  }

  async listRoutingGuardDeviceStats(limit = 10): Promise<Array<{
    userId: string
    clientDeviceId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }>> {
    return this.routingGuardDevicesOverride.slice(0, limit).map((item) => clone(item))
  }

  setRoutingGuardUserStats(input: Array<{
    userId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }>): void {
    this.routingGuardUsersOverride = input.map((item) => clone(item))
  }

  setRoutingGuardDeviceStats(input: Array<{
    userId: string
    clientDeviceId: string
    activeSessions: number
    recentRequests: number
    recentTokens: number
  }>): void {
    this.routingGuardDevicesOverride = input.map((item) => clone(item))
  }

  async ensureSessionRoute(input: {
    sessionKey: string
    userId?: string | null
    clientDeviceId?: string | null
    accountId: string
    primaryAccountId?: string | null
  }): Promise<SessionRoute> {
    const existing = this.routes.get(input.sessionKey)
    const nowIso = new Date().toISOString()
    const route: SessionRoute = {
      sessionKey: input.sessionKey,
      sessionHash: hashSessionKey(input.sessionKey),
      userId: input.userId ?? existing?.userId ?? null,
      clientDeviceId: input.clientDeviceId ?? existing?.clientDeviceId ?? null,
      accountId: input.accountId,
      primaryAccountId:
        input.primaryAccountId ?? existing?.primaryAccountId ?? input.accountId,
      generation: existing?.generation ?? 1,
      upstreamSessionId: existing?.upstreamSessionId ?? crypto.randomUUID(),
      pendingHandoffSummary: existing?.pendingHandoffSummary ?? null,
      lastHandoffReason: existing?.lastHandoffReason ?? null,
      generationBurn5h: existing?.generationBurn5h ?? 0,
      generationBurn7d: existing?.generationBurn7d ?? 0,
      predictedBurn5h: existing?.predictedBurn5h ?? null,
      predictedBurn7d: existing?.predictedBurn7d ?? null,
      lastRateLimitStatus: existing?.lastRateLimitStatus ?? null,
      lastRateLimit5hUtilization: existing?.lastRateLimit5hUtilization ?? null,
      lastRateLimit7dUtilization: existing?.lastRateLimit7dUtilization ?? null,
      lastSoftMigrationAt: existing?.lastSoftMigrationAt ?? null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      expiresAt: Date.now() + 60 * 60 * 1000,
    }
    this.routes.set(input.sessionKey, route)
    this.recordDeviceAffinity(route)
    return clone(route)
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
    const existing = this.routes.get(input.sessionKey)
    const nowIso = new Date().toISOString()
    const route: SessionRoute = {
      sessionKey: input.sessionKey,
      sessionHash: hashSessionKey(input.sessionKey),
      userId: input.userId ?? existing?.userId ?? null,
      clientDeviceId: input.clientDeviceId ?? existing?.clientDeviceId ?? null,
      accountId: input.toAccountId,
      primaryAccountId:
        input.primaryAccountId ?? existing?.primaryAccountId ?? input.toAccountId,
      generation: (existing?.generation ?? 0) + 1,
      upstreamSessionId: crypto.randomUUID(),
      pendingHandoffSummary: input.summary,
      lastHandoffReason: input.reason,
      generationBurn5h: 0,
      generationBurn7d: 0,
      predictedBurn5h: null,
      predictedBurn7d: null,
      lastRateLimitStatus: null,
      lastRateLimit5hUtilization: null,
      lastRateLimit7dUtilization: null,
      lastSoftMigrationAt: null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      expiresAt: Date.now() + 60 * 60 * 1000,
    }
    const handoff: SessionHandoff = {
      id: crypto.randomUUID(),
      sessionKey: input.sessionKey,
      sessionHash: route.sessionHash,
      generation: route.generation,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      reason: input.reason,
      summary: input.summary,
      createdAt: nowIso,
    }
    this.routes.set(input.sessionKey, route)
    this.handoffs.unshift(handoff)
    this.recordDeviceAffinity(route)
    return clone(route)
  }

  async updateSessionRouteSoftMigrationAt(sessionKey: string, at: number): Promise<void> {
    const existing = this.routes.get(sessionKey)
    if (existing) {
      this.routes.set(sessionKey, { ...existing, lastSoftMigrationAt: at })
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
    const existing = this.routes.get(input.sessionKey)
    if (!existing || existing.accountId !== input.accountId) {
      return null
    }

    const delta5h = usageDelta(existing.lastRateLimit5hUtilization, input.rateLimit5hUtilization ?? null)
    const delta7d = usageDelta(existing.lastRateLimit7dUtilization, input.rateLimit7dUtilization ?? null)
    const route: SessionRoute = {
      ...existing,
      userId: input.userId ?? existing.userId,
      clientDeviceId: input.clientDeviceId ?? existing.clientDeviceId,
      generationBurn5h: existing.generationBurn5h + delta5h,
      generationBurn7d: existing.generationBurn7d + delta7d,
      predictedBurn5h: updateEma(existing.predictedBurn5h, delta5h),
      predictedBurn7d: updateEma(existing.predictedBurn7d, delta7d),
      lastRateLimitStatus: input.rateLimitStatus ?? null,
      lastRateLimit5hUtilization: input.rateLimit5hUtilization ?? null,
      lastRateLimit7dUtilization: input.rateLimit7dUtilization ?? null,
      updatedAt: new Date().toISOString(),
      expiresAt: Date.now() + 60 * 60 * 1000,
    }
    this.routes.set(input.sessionKey, route)
    this.recordDeviceAffinity(route)
    return clone(route)
  }

  async clearPendingHandoffSummary(sessionKey: string): Promise<void> {
    const existing = this.routes.get(sessionKey)
    if (!existing) {
      return
    }
    this.routes.set(sessionKey, {
      ...existing,
      pendingHandoffSummary: null,
      updatedAt: new Date().toISOString(),
    })
  }

  async prepareSessionRoutesForAccountHandoff(input: {
    accountId: string
    reason: string
  }): Promise<number> {
    let updatedCount = 0
    for (const [sessionKey, route] of this.routes.entries()) {
      if (route.accountId !== input.accountId) {
        continue
      }
      const summary =
        route.pendingHandoffSummary ??
        await this.buildSessionHandoffSummary({
          sessionKey,
          fromAccountId: input.accountId,
        })
      this.routes.set(sessionKey, {
        ...route,
        pendingHandoffSummary: summary,
        lastHandoffReason: input.reason,
        updatedAt: new Date().toISOString(),
      })
      updatedCount += 1
    }
    return updatedCount
  }

  async buildSessionHandoffSummary(input: {
    sessionKey: string
    fromAccountId?: string | null
    currentRequestBodyPreview?: string | null
  }): Promise<string> {
    const hasCurrentRequest = typeof input.currentRequestBodyPreview === 'string' &&
      input.currentRequestBodyPreview.trim().length > 0
    return [
      '继续当前工作。以下是可用的压缩背景，不是完整 transcript。',
      `虚拟会话：${input.sessionKey}`,
      hasCurrentRequest
        ? '当前这轮请求已经包含在 messages 中，不要重复复述。'
        : '如果没有额外历史摘要，直接根据当前请求继续。',
      '继续时优先以当前请求里的 messages 为准；如果历史细节不足，不要假装看过完整旧会话。',
    ].join('\n')
  }

  async getPreferredAccountIdsForClientDevice(input: {
    userId: string
    clientDeviceId: string
    limit?: number
  }): Promise<string[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 3, 10))
    const stats = new Map<string, { count: number; lastSeenAt: string }>()
    const affinities = [...this.deviceAffinities]
      .filter((entry) =>
        entry.userId === input.userId &&
        entry.clientDeviceId === input.clientDeviceId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    for (const entry of affinities) {
      const current = stats.get(entry.accountId)
      if (!current) {
        stats.set(entry.accountId, { count: 1, lastSeenAt: entry.createdAt })
        continue
      }
      current.count += 1
      if (entry.createdAt > current.lastSeenAt) {
        current.lastSeenAt = entry.createdAt
      }
    }
    return [...stats.entries()]
      .filter(([, value]) => value.count >= memoryDeviceAffinityMinSuccesses())
      .sort((left, right) =>
        right[1].count - left[1].count ||
        right[1].lastSeenAt.localeCompare(left[1].lastSeenAt) ||
        left[0].localeCompare(right[0]),
      )
      .slice(0, limit)
      .map(([accountId]) => accountId)
  }

  private recordDeviceAffinity(route: SessionRoute): void {
    if (!route.userId || !route.clientDeviceId) {
      return
    }
    this.deviceAffinities.push({
      userId: route.userId,
      clientDeviceId: route.clientDeviceId,
      accountId: route.accountId,
      createdAt: route.updatedAt,
    })
  }
}

function hashSessionKey(sessionKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`claude-oauth-relay:${sessionKey}`)
    .digest('hex')
}

function usageDelta(previous: number | null, current: number | null): number {
  if (previous == null || current == null || current < previous) {
    return 0
  }
  return Math.max(0, current - previous)
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

function clone<T>(value: T): T {
  return structuredClone(value)
}

function memoryDeviceAffinityMinSuccesses(): number {
  const parsed = Number(process.env.DEVICE_AFFINITY_MIN_SUCCESSES ?? '2')
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2
}
