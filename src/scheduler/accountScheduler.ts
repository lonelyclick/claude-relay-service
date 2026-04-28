import type {
  AccountProvider,
  SchedulerAccountStats,
  StickySessionBinding,
  StoredAccount,
} from '../types.js'
import type { AccountHealthTracker } from './healthTracker.js'
import { appConfig } from '../config.js'
import {
  buildProviderScopedAccountId,
  parseProviderScopedAccountRef,
} from '../providers/accountRef.js'
import { OPENAI_CODEX_PROVIDER, providerRequiresProxy } from '../providers/catalog.js'
import { getDefaultPlanMultiplier, getSubscriptionHeuristics } from '../providers/subscription.js'

export interface SchedulerConfig {
  defaultMaxSessions: number
  maxSessionOverflow: number
}

export interface SchedulerCapacityDiagnostics {
  totalScoped: number
  quotaExhausted: number
  autoBlocked: number
  capacityFull: number
  healthRateLimited: number
  cooldown: number
  otherBlocked: number
}

export class SchedulerCapacityError extends Error {
  constructor(
    public readonly group: string | null,
    public readonly totalAccounts: number,
    public readonly totalCapacity: number,
    public readonly diagnostics: SchedulerCapacityDiagnostics | null = null,
  ) {
    super('All accounts are at capacity')
    this.name = 'SchedulerCapacityError'
  }
}

export function formatSchedulerCapacityError(error: SchedulerCapacityError): string {
  const base = `scheduler_capacity: group=${error.group ?? 'all'} accounts=${error.totalAccounts} capacity=${error.totalCapacity}`
  const d = error.diagnostics
  if (!d) return base
  return `${base} total=${d.totalScoped} quota=${d.quotaExhausted} auto_blocked=${d.autoBlocked} capacity_full=${d.capacityFull} health=${d.healthRateLimited} cooldown=${d.cooldown} other=${d.otherBlocked}`
}

export class ForcedAccountNotFoundError extends Error {
  constructor(public readonly accountId: string) {
    super(`Account not found: ${accountId}`)
    this.name = 'ForcedAccountNotFoundError'
  }
}

export class ForcedAccountUnavailableError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly reason: string,
  ) {
    super(`Account currently unavailable: ${accountId}`)
    this.name = 'ForcedAccountUnavailableError'
  }
}

type SelectionMode = 'new' | 'existing'

type ScoreBreakdown = {
  quotaScore: number
  sessionAffinityScore: number
  healthScore: number
  capacityScore: number
  proxyScore: number
  manualWeightScore: number
  planMultiplierScore: number
  totalScore: number
}

export class AccountScheduler {
  constructor(
    private readonly healthTracker: AccountHealthTracker,
    private readonly config: SchedulerConfig,
  ) {
    if (config.maxSessionOverflow < 0) {
      throw new Error('maxSessionOverflow must be >= 0')
    }
  }

  selectAccount(
    accounts: StoredAccount[],
    stickySessions: StickySessionBinding[],
    options: {
      sessionHash: string | null
      forceAccountId: string | null
      provider?: AccountProvider | null
      group: string | null
      activeSessionCounts?: Map<string, number>
      disallowedAccountIds?: string[]
      preferredAccountIds?: string[]
      primaryAccountId?: string | null
      allowCooldownFallback?: boolean
      allowCapacityOverflowFallback?: boolean
    },
    now: number = Date.now(),
  ): StoredAccount {
    const sessionCounts = options.activeSessionCounts ?? this.countSessionsPerAccount(stickySessions)
    const disallowed = new Set(options.disallowedAccountIds ?? [])

    if (options.forceAccountId) {
      const forced = accounts.find((account) =>
        this.matchesAccountReference(account, options.forceAccountId as string),
      )
      if (!forced) {
        throw new ForcedAccountNotFoundError(options.forceAccountId)
      }
      const forcedActiveSessions = sessionCounts.get(forced.id) ?? 0
      if (!this.isAccountAvailableForExistingSession(forced, now, forcedActiveSessions, false)) {
        throw new ForcedAccountUnavailableError(
          options.forceAccountId,
          this.getBlockedReason(forced, now, 'existing') ?? 'capacity_exhausted',
        )
      }
      return forced
    }

    const primary =
      options.primaryAccountId && !disallowed.has(options.primaryAccountId)
        ? accounts.find((a) => a.id === options.primaryAccountId) ?? null
        : null
    if (primary) {
      const primaryActive = sessionCounts.get(primary.id) ?? 0
      if (this.isAccountAvailableForExistingSession(primary, now, primaryActive, true)) {
        return primary
      }
    }

    if (options.sessionHash) {
      const binding = stickySessions.find((s) => s.sessionHash === options.sessionHash)
      if (binding && !disallowed.has(binding.accountId)) {
        const mapped = accounts.find((a) => a.id === binding.accountId)
        const activeSessions = mapped ? (sessionCounts.get(mapped.id) ?? 0) : 0
        if (mapped && this.isAccountAvailableForExistingSession(mapped, now, activeSessions, true)) {
          return mapped
        }
      }
    }

    try {
      return this.assignNewSession(accounts, sessionCounts, {
        provider: options.provider ?? null,
        group: options.group,
        now,
        disallowedAccountIds: disallowed,
        preferredAccountIds: new Set(options.preferredAccountIds ?? []),
        allowCapacityOverflowFallback: options.allowCapacityOverflowFallback ?? false,
      })
    } catch (error) {
      if (options.allowCooldownFallback) {
        const fallbackEligibleCandidates = this.getCooldownFallbackEligibleCandidates(accounts, {
          provider: options.provider ?? null,
          group: options.group,
          disallowedAccountIds: disallowed,
        })
        const onlyCooldownBlocked = fallbackEligibleCandidates.length > 0 && fallbackEligibleCandidates.every((account) => {
          const reason = this.getBlockedReason(account, now, 'new')
          return reason === 'cooldown' || reason === 'health_rate_limited'
        })
        const fallback = this.selectEarliestCooldownCandidate(accounts, {
          provider: options.provider ?? null,
          group: options.group,
          disallowedAccountIds: disallowed,
        })
        // Only use cooldown fallback when the best candidate is actually cooldown-blocked,
        // not when normal selection failed due to capacity overflow.
        if (
          fallback &&
          onlyCooldownBlocked &&
          Math.max(
            fallback.cooldownUntil ?? 0,
            this.healthTracker.getRateLimitedUntil(fallback.id) ?? 0,
          ) > now
        ) {
          return fallback
        }
      }
      throw error
    }
  }

  getStats(
    accounts: StoredAccount[],
    stickySessions: StickySessionBinding[],
    now: number = Date.now(),
    activeSessionCounts?: Map<string, number>,
    preferredAccountIds?: Set<string>,
  ): SchedulerAccountStats[] {
    const sessionCounts = activeSessionCounts ?? this.countSessionsPerAccount(stickySessions)

    return accounts.map((account) => {
      const maxSessions = account.maxSessions ?? this.config.defaultMaxSessions
      const activeSessions = sessionCounts.get(account.id) ?? 0
      const blockedReason = this.getBlockedReason(account, now, 'new')
      const score = this.scoreAccount(account, activeSessions, maxSessions, preferredAccountIds?.has(account.id) ?? false, now)
      return {
        accountId: account.id,
        emailAddress: account.emailAddress,
        subscriptionType: account.subscriptionType,
        group: account.group,
        label: account.label,
        activeSessions,
        maxSessions,
        healthScore: score.healthScore,
        effectiveWeight: score.totalScore,
        rateLimitedUntil: this.healthTracker.getRateLimitedUntil(account.id),
        cooldownUntil: account.cooldownUntil,
        status: account.status,
        isSelectable: blockedReason === null && (activeSessions < maxSessions || this.canUseOpenAISoftCapacityOverflow(account)),
        schedulerEnabled: account.schedulerEnabled,
        schedulerState: account.schedulerState,
        autoBlockedReason: account.autoBlockedReason,
        latestRateLimitStatus: account.lastRateLimitStatus,
        latestRateLimit5hUtilization: account.lastRateLimit5hUtilization,
        latestRateLimit7dUtilization: account.lastRateLimit7dUtilization,
        quotaScore: score.quotaScore,
        sessionAffinityScore: score.sessionAffinityScore,
        capacityScore: score.capacityScore,
        proxyScore: score.proxyScore,
        manualWeightScore: score.manualWeightScore,
        planMultiplierScore: score.planMultiplierScore,
        totalScore: score.totalScore,
        blockedReason:
          blockedReason ?? (activeSessions >= maxSessions && !this.canUseOpenAISoftCapacityOverflow(account)
            ? 'capacity_exhausted'
            : null),
      }
    })
  }

  isAccountAvailableForExistingSession(
    account: StoredAccount,
    now: number = Date.now(),
    activeSessions?: number,
    currentSessionCountsTowardLimit: boolean = false,
  ): boolean {
    if (this.getBlockedReason(account, now, 'existing') !== null) {
      return false
    }
    if (activeSessions == null) {
      return true
    }
    if (this.canUseOpenAISoftCapacityOverflow(account)) {
      return true
    }

    const hardMaxSessions = this.getHardMaxSessions(account)
    return currentSessionCountsTowardLimit
      ? activeSessions <= hardMaxSessions
      : activeSessions < hardMaxSessions
  }

  private assignNewSession(
    accounts: StoredAccount[],
    sessionCounts: Map<string, number>,
    options: {
      provider: AccountProvider | null
      group: string | null
      now: number
      disallowedAccountIds: Set<string>
      preferredAccountIds: Set<string>
      allowCapacityOverflowFallback: boolean
    },
  ): StoredAccount {
    let candidates = accounts.filter((account) => !options.disallowedAccountIds.has(account.id))

    if (options.provider) {
      candidates = candidates.filter((account) => account.provider === options.provider)
    }

    if (options.group) {
      candidates = candidates.filter((account) => account.group === options.group)
    } else {
      candidates = candidates.filter((account) => !account.group)
    }

    const scopedCandidates = candidates
    const blockedReasons = new Map<string, string | null>(
      scopedCandidates.map((account) => [account.id, this.getBlockedReason(account, options.now, 'new')] as const),
    )
    candidates = scopedCandidates.filter((account) => blockedReasons.get(account.id) === null)

    const quotaBlockedCandidates = scopedCandidates.filter(
      (account) => blockedReasons.get(account.id) === 'quota_exhausted',
    )

    const buildDiagnostics = (extraCapacityFull: number = 0): SchedulerCapacityDiagnostics => {
      const diagnostics: SchedulerCapacityDiagnostics = {
        totalScoped: scopedCandidates.length,
        quotaExhausted: 0,
        autoBlocked: 0,
        capacityFull: extraCapacityFull,
        healthRateLimited: 0,
        cooldown: 0,
        otherBlocked: 0,
      }
      for (const account of scopedCandidates) {
        const reason = blockedReasons.get(account.id) ?? null
        if (reason === null) continue
        if (reason === 'quota_exhausted') diagnostics.quotaExhausted += 1
        else if (reason === 'health_rate_limited') diagnostics.healthRateLimited += 1
        else if (reason === 'cooldown') diagnostics.cooldown += 1
        else if (reason.startsWith('rate_limit:') || reason === 'auto_blocked') diagnostics.autoBlocked += 1
        else diagnostics.otherBlocked += 1
      }
      return diagnostics
    }

    if (candidates.length === 0) {
      if (quotaBlockedCandidates.length > 0) {
        const totalCapacity = quotaBlockedCandidates.reduce(
          (sum, account) => sum + (account.maxSessions ?? this.config.defaultMaxSessions),
          0,
        )
        throw new SchedulerCapacityError(options.group, quotaBlockedCandidates.length, totalCapacity, buildDiagnostics())
      }
      throw new Error(
        options.group
          ? `No available accounts in group "${options.group}"`
          : 'No available OAuth accounts',
      )
    }

    const withCapacity = candidates.filter((account) => {
      const maxSessions = account.maxSessions ?? this.config.defaultMaxSessions
      const activeSessions = sessionCounts.get(account.id) ?? 0
      return activeSessions < maxSessions
    })
    const capacityFullCandidates = candidates.length - withCapacity.length

    const selectable = withCapacity.length > 0
      ? withCapacity
      : options.allowCapacityOverflowFallback
        ? candidates.filter((account) => this.hasQuotaHeadroom(account))
        : []

    if (selectable.length === 0 && quotaBlockedCandidates.length > 0) {
      const totalCapacity = quotaBlockedCandidates.reduce(
        (sum, account) => sum + (account.maxSessions ?? this.config.defaultMaxSessions),
        0,
      )
      throw new SchedulerCapacityError(
        options.group,
        quotaBlockedCandidates.length,
        totalCapacity,
        buildDiagnostics(capacityFullCandidates),
      )
    }

    if (selectable.length === 0) {
      const totalCapacity = candidates.reduce(
        (sum, account) => sum + (account.maxSessions ?? this.config.defaultMaxSessions),
        0,
      )
      throw new SchedulerCapacityError(
        options.group,
        candidates.length,
        totalCapacity,
        buildDiagnostics(capacityFullCandidates),
      )
    }

    const scored = selectable.map((account) => {
      const maxSessions = account.maxSessions ?? this.config.defaultMaxSessions
      const activeSessions = sessionCounts.get(account.id) ?? 0
      return {
        account,
        score: this.scoreAccount(
          account,
          activeSessions,
          maxSessions,
          options.preferredAccountIds.has(account.id),
          options.now,
        ),
      }
    })

    scored.sort((left, right) => {
      if (right.score.totalScore !== left.score.totalScore) {
        return right.score.totalScore - left.score.totalScore
      }
      const leftSelectedAt = left.account.lastSelectedAt
        ? new Date(left.account.lastSelectedAt).getTime()
        : 0
      const rightSelectedAt = right.account.lastSelectedAt
        ? new Date(right.account.lastSelectedAt).getTime()
        : 0
      if (leftSelectedAt !== rightSelectedAt) {
        return leftSelectedAt - rightSelectedAt
      }
      return (
        (left.account.createdAt ?? '').localeCompare(right.account.createdAt ?? '') ||
        left.account.id.localeCompare(right.account.id)
      )
    })

    return scored[0].account
  }

  private matchesAccountReference(account: StoredAccount, accountRef: string): boolean {
    if (account.id === accountRef) {
      return true
    }

    const requested = parseProviderScopedAccountRef(accountRef)
    if (requested) {
      return (
        account.provider === requested.provider &&
        (account.id === requested.accountId ||
          account.id === buildProviderScopedAccountId(requested.provider, requested.accountId))
      )
    }

    const stored = parseProviderScopedAccountRef(account.id)
    if (stored) {
      return stored.accountId === accountRef
    }

    return false
  }

  private getBlockedReason(
    account: StoredAccount,
    now: number,
    mode: SelectionMode,
  ): string | null {
    if (!account.isActive) {
      return 'inactive'
    }
    if (account.status === 'revoked') {
      return 'revoked'
    }
    if (account.cooldownUntil !== null && account.cooldownUntil > now) {
      return 'cooldown'
    }
    if (providerRequiresProxy(account.provider) && !account.proxyUrl) {
      return 'no_proxy'
    }
    if (!account.schedulerEnabled) {
      return 'scheduler_disabled'
    }
    if (account.schedulerState === 'auto_blocked') {
      const blockUntil = account.autoBlockedUntil
      const expired = blockUntil !== null && blockUntil <= now
      if (!expired) {
        return account.autoBlockedReason ?? 'auto_blocked'
      }
      // autoBlockedUntil window expired — soft-release: allow scheduler to retry.
      // DB schedulerState will be reconciled on the next rate-limit snapshot.
    }
    if (account.schedulerState === 'draining') {
      return 'draining'
    }
    if (account.schedulerState === 'paused' && mode === 'new') {
      return 'paused'
    }
    if (mode === 'new' && this.hasHardQuotaExhaustion(account)) {
      return 'quota_exhausted'
    }
    if (this.healthTracker.isRateLimited(account.id)) {
      return 'health_rate_limited'
    }
    return null
  }

  private canUseOpenAISoftCapacityOverflow(account: StoredAccount): boolean {
    return account.provider === OPENAI_CODEX_PROVIDER.id && this.hasQuotaHeadroom(account)
  }

  private hasQuotaHeadroom(account: StoredAccount): boolean {
    if (this.hasHardQuotaExhaustion(account)) {
      return false
    }
    const remaining5h = account.lastRateLimit5hUtilization == null
      ? 1
      : 1 - clamp01(account.lastRateLimit5hUtilization)
    const remaining7d = account.lastRateLimit7dUtilization == null
      ? 1
      : 1 - clamp01(account.lastRateLimit7dUtilization)
    const heuristics = getSubscriptionHeuristics(account.provider, account.subscriptionType)
    return Math.min(
      remaining5h - heuristics.predictedBurn5h * 1.2,
      remaining7d - heuristics.predictedBurn7d * 1.2,
    ) > 0
  }

  private hasHardQuotaExhaustion(account: StoredAccount): boolean {
    // Real exhaustion: usage at or above limit.
    if (
      account.lastRateLimit5hUtilization != null &&
      clamp01(account.lastRateLimit5hUtilization) >= 1
    ) {
      return true
    }
    if (
      account.lastRateLimit7dUtilization != null &&
      clamp01(account.lastRateLimit7dUtilization) >= 1
    ) {
      return true
    }

    const status = account.lastRateLimitStatus?.toLowerCase() ?? null
    const isStatusHardBlocked =
      status === 'rejected' || status === 'throttled' || status === 'blocked'
    if (!isStatusHardBlocked) {
      return false
    }

    // Status flags hard-block but full usage data is available and below limit:
    // trust the data — status may be stale. autoBlockedUntil window controls retry.
    if (
      account.lastRateLimit5hUtilization != null &&
      account.lastRateLimit7dUtilization != null
    ) {
      return false
    }

    // Status hard-blocked without complete usage data → conservative: treat as exhausted.
    return true
  }

  private scoreAccount(
    account: StoredAccount,
    activeSessions: number,
    maxSessions: number,
    preferredForSession: boolean,
    now: number = Date.now(),
  ): ScoreBreakdown {
    const heuristics = getSubscriptionHeuristics(account.provider, account.subscriptionType)
    const predictedBurn5h = heuristics.predictedBurn5h
    const predictedBurn7d = heuristics.predictedBurn7d

    let quotaScore: number
    if (account.lastRateLimit5hUtilization == null && account.lastRateLimit7dUtilization == null) {
      // No quota data at all: neutral score to avoid over-preferring cold-start accounts
      quotaScore = 0.5
    } else if (this.hasHardQuotaExhaustion(account)) {
      quotaScore = 0
    } else {
      const remaining5h = 1 - clamp01(account.lastRateLimit5hUtilization ?? 0)
      const remaining7d = 1 - clamp01(account.lastRateLimit7dUtilization ?? 0)
      const decay5h = Math.pow(clamp01(remaining5h - predictedBurn5h * 1.2), 1.5)
      const decay7d = Math.pow(clamp01(remaining7d - predictedBurn7d * 1.2), 2.5)
      const raw = Math.min(decay5h, decay7d)
      // Freshness decay: blend toward 0.5 as quota data ages past QUOTA_DATA_FRESHNESS_MS
      const lastAt = account.lastRateLimitAt ? new Date(account.lastRateLimitAt).getTime() : null
      const age = lastAt != null ? Math.max(0, now - lastAt) : appConfig.quotaDataFreshnessMs
      const freshness = clamp01(1 - age / appConfig.quotaDataFreshnessMs)
      quotaScore = raw * freshness + 0.5 * (1 - freshness)
    }
    const sessionAffinityScore = preferredForSession ? 1 : 0
    const healthScore = clamp01(this.healthTracker.getHealthScore(account.id))
    const capacityScore = maxSessions > 0 ? clamp01(1 - activeSessions / maxSessions) : 0
    const proxyScore = providerRequiresProxy(account.provider)
      ? (account.proxyUrl ? 1 : 0)
      : 1
    const manualWeightScore = normalizeWeight(account.weight)
    const planMultiplierScore = normalizeWeight(
      account.planMultiplier ?? getDefaultPlanMultiplier(account.provider, account.planType, account.subscriptionType),
    )
    const totalScore =
      0.45 * quotaScore +
      0.15 * sessionAffinityScore +
      0.15 * healthScore +
      0.1 * capacityScore +
      0.05 * proxyScore +
      0.05 * manualWeightScore +
      0.05 * planMultiplierScore
    return {
      quotaScore,
      sessionAffinityScore,
      healthScore,
      capacityScore,
      proxyScore,
      manualWeightScore,
      planMultiplierScore,
      totalScore,
    }
  }

  private selectEarliestCooldownCandidate(
    accounts: StoredAccount[],
    options: {
      provider: AccountProvider | null
      group: string | null
      disallowedAccountIds: Set<string>
    },
  ): StoredAccount | null {
    const candidates = this.getCooldownFallbackEligibleCandidates(accounts, options)

    if (candidates.length === 0) {
      return null
    }

    return candidates.slice().sort((left, right) => {
      const leftCooldown = Math.max(
        left.cooldownUntil ?? 0,
        this.healthTracker.getRateLimitedUntil(left.id) ?? 0,
      )
      const rightCooldown = Math.max(
        right.cooldownUntil ?? 0,
        this.healthTracker.getRateLimitedUntil(right.id) ?? 0,
      )
      if (leftCooldown !== rightCooldown) {
        return leftCooldown - rightCooldown
      }
      return (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id)
    })[0]
  }

  private getCooldownFallbackEligibleCandidates(
    accounts: StoredAccount[],
    options: {
      provider: AccountProvider | null
      group: string | null
      disallowedAccountIds: Set<string>
    },
  ): StoredAccount[] {
    return accounts.filter((account) => {
      if (options.disallowedAccountIds.has(account.id)) {
        return false
      }
      if (options.provider && account.provider !== options.provider) {
        return false
      }
      if (options.group) {
        if (account.group !== options.group) return false
      } else if (account.group) {
        return false
      }
      if (!account.isActive) {
        return false
      }
      if (account.status === 'revoked') {
        return false
      }
      if (providerRequiresProxy(account.provider) && !account.proxyUrl) {
        return false
      }
      if (!account.schedulerEnabled) {
        return false
      }
      if (account.schedulerState === 'auto_blocked') {
        return false
      }
      if (account.schedulerState === 'draining') {
        return false
      }
      if (account.schedulerState === 'paused') {
        return false
      }
      if (this.hasHardQuotaExhaustion(account)) {
        return false
      }
      return true
    })
  }

  getEffectiveCooldownUntil(accountId: string, dbCooldownUntil: number | null, now: number = Date.now()): number {
    return Math.max(dbCooldownUntil ?? 0, this.healthTracker.getRateLimitedUntil(accountId) ?? 0)
  }

  private countSessionsPerAccount(stickySessions: StickySessionBinding[]): Map<string, number> {
    const counts = new Map<string, number>()
    for (const binding of stickySessions) {
      counts.set(binding.accountId, (counts.get(binding.accountId) ?? 0) + 1)
    }
    return counts
  }

  clearAccountHealth(accountId: string): void {
    this.healthTracker.clearAccountHealth(accountId)
  }

  private getHardMaxSessions(account: StoredAccount): number {
    const maxSessions = account.maxSessions ?? this.config.defaultMaxSessions
    return maxSessions + this.config.maxSessionOverflow
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, value))
}

function normalizeWeight(weight: number | null): number {
  if (weight == null || !Number.isFinite(weight)) {
    return 0.5
  }
  return clamp01(weight / 2)
}
