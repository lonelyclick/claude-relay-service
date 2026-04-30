import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoredAccount, StickySessionBinding } from '../types.js'
import {
  AccountScheduler,
  ForcedAccountUnavailableError,
  SchedulerCapacityError,
  formatSchedulerCapacityError,
} from './accountScheduler.js'
import { AccountHealthTracker } from './healthTracker.js'

function buildAccount(input: Partial<StoredAccount> & { id: string }): StoredAccount {
  const nowIso = '2026-04-13T00:00:00.000Z'
  return {
    id: input.id,
    provider: input.provider ?? 'claude-official',
    protocol: input.protocol ?? 'claude',
    authMode: input.authMode ?? 'oauth',
    label: input.label ?? input.id,
    isActive: input.isActive ?? true,
    status: input.status ?? 'active',
    lastSelectedAt: input.lastSelectedAt ?? null,
    lastUsedAt: input.lastUsedAt ?? null,
    lastRefreshAt: input.lastRefreshAt ?? null,
    lastFailureAt: input.lastFailureAt ?? null,
    cooldownUntil: input.cooldownUntil ?? null,
    lastError: input.lastError ?? null,
    accessToken: input.accessToken ?? 'access',
    refreshToken: input.refreshToken ?? 'refresh',
    expiresAt: input.expiresAt ?? null,
    scopes: input.scopes ?? [],
    createdAt: input.createdAt ?? nowIso,
    updatedAt: input.updatedAt ?? nowIso,
    subscriptionType: input.subscriptionType ?? 'max',
    rateLimitTier: input.rateLimitTier ?? null,
    accountUuid: input.accountUuid ?? input.id,
    organizationUuid: input.organizationUuid ?? `org-${input.id}`,
    emailAddress: input.emailAddress ?? `${input.id}@example.com`,
    displayName: input.displayName ?? input.id,
    hasExtraUsageEnabled: input.hasExtraUsageEnabled ?? null,
    billingType: input.billingType ?? null,
    accountCreatedAt: input.accountCreatedAt ?? null,
    subscriptionCreatedAt: input.subscriptionCreatedAt ?? null,
    rawProfile: input.rawProfile ?? null,
    roles: input.roles ?? null,
    routingGroupId: input.routingGroupId ?? input.group ?? null,
    group: input.group ?? input.routingGroupId ?? null,
    maxSessions: input.maxSessions ?? 5,
    weight: input.weight ?? 1,
    planType: input.planType ?? null,
    planMultiplier: input.planMultiplier ?? null,
    schedulerEnabled: input.schedulerEnabled ?? true,
    schedulerState: input.schedulerState ?? 'enabled',
    autoBlockedReason: input.autoBlockedReason ?? null,
    autoBlockedUntil: input.autoBlockedUntil ?? null,
    lastRateLimitStatus: input.lastRateLimitStatus ?? null,
    lastRateLimit5hUtilization: input.lastRateLimit5hUtilization ?? null,
    lastRateLimit7dUtilization: input.lastRateLimit7dUtilization ?? null,
    lastRateLimitReset: input.lastRateLimitReset ?? null,
    lastRateLimitAt: input.lastRateLimitAt ?? null,
    lastProbeAttemptAt: null,
    proxyUrl: input.proxyUrl ?? 'http://127.0.0.1:10810',
    bodyTemplatePath: input.bodyTemplatePath ?? null,
    vmFingerprintTemplatePath: input.vmFingerprintTemplatePath ?? null,
    deviceId: input.deviceId ?? 'device',
    apiBaseUrl: input.apiBaseUrl ?? null,
    modelName: input.modelName ?? null,
    modelTierMap: null,
    modelMap: null,
    loginPassword: input.loginPassword ?? null,
  }
}

test('AccountScheduler prefers accounts with more quota headroom', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  const accounts = [
    buildAccount({
      id: 'low-headroom',
      lastRateLimit5hUtilization: 0.92,
      lastRateLimit7dUtilization: 0.84,
    }),
    buildAccount({
      id: 'healthy-headroom',
      lastRateLimit5hUtilization: 0.2,
      lastRateLimit7dUtilization: 0.15,
    }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'healthy-headroom')
})

test('AccountScheduler excludes paused, draining, auto-blocked and health-rate-limited accounts from new selection', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  const accounts = [
    buildAccount({ id: 'paused', schedulerEnabled: false, schedulerState: 'paused' }),
    buildAccount({ id: 'draining', schedulerState: 'draining' }),
    buildAccount({ id: 'blocked', schedulerState: 'auto_blocked', autoBlockedReason: 'rate_limit:rejected' }),
    buildAccount({
      id: 'historical-limited',
      lastRateLimitStatus: 'rejected',
      lastRateLimit5hUtilization: 1,
      lastRateLimit7dUtilization: 1,
    }),
    buildAccount({ id: 'healthy' }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'healthy')

  const stats = scheduler.getStats(accounts, [])
  const statMap = new Map(stats.map((item) => [item.accountId, item]))
  assert.equal(statMap.get('paused')?.isSelectable, false)
  assert.equal(statMap.get('draining')?.isSelectable, false)
  assert.equal(statMap.get('blocked')?.isSelectable, false)
  assert.equal(statMap.get('historical-limited')?.isSelectable, false)
  assert.equal(statMap.get('historical-limited')?.blockedReason, 'quota_exhausted')
  assert.equal(statMap.get('healthy')?.isSelectable, true)
})


test('AccountScheduler uses plan multiplier while quota decay still protects exhausted accounts', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  const accounts = [
    buildAccount({
      id: 'low-plan',
      planMultiplier: 1,
      lastRateLimit5hUtilization: 0.05,
      lastRateLimit7dUtilization: 0.05,
      lastRateLimitAt: '2026-04-13T00:00:00.000Z',
    }),
    buildAccount({
      id: 'high-plan',
      planMultiplier: 10,
      lastRateLimit5hUtilization: 0.05,
      lastRateLimit7dUtilization: 0.05,
      lastRateLimitAt: '2026-04-13T00:00:00.000Z',
    }),
    buildAccount({
      id: 'exhausted-high-plan',
      planMultiplier: 10,
      lastRateLimitStatus: 'rejected',
      lastRateLimit5hUtilization: 0,
      lastRateLimit7dUtilization: 1,
      lastRateLimitAt: '2026-04-13T00:00:00.000Z',
    }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  }, Date.parse('2026-04-13T00:01:00.000Z'))

  assert.equal(selected.id, 'high-plan')
  const stats = scheduler.getStats(accounts, [], Date.parse('2026-04-13T00:01:00.000Z'))
  const statMap = new Map(stats.map((item) => [item.accountId, item]))
  assert.equal(statMap.get('exhausted-high-plan')?.isSelectable, false)
  assert.equal(statMap.get('exhausted-high-plan')?.blockedReason, 'quota_exhausted')
  assert.ok((statMap.get('high-plan')?.effectiveWeight ?? 0) > (statMap.get('low-plan')?.effectiveWeight ?? 0))
})

test('AccountScheduler filters candidates by provider when requested', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  const accounts = [
    buildAccount({ id: 'claude-official:claude-1' }),
    buildAccount({
      id: 'openai-compatible:model-1',
      provider: 'openai-compatible',
      protocol: 'openai',
      authMode: 'api_key',
    }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    provider: 'openai-compatible',
    group: null,
  })

  assert.equal(selected.id, 'openai-compatible:model-1')
})

test('AccountScheduler resolves provider-scoped forced account ids against legacy and scoped ids', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  const legacyAccount = buildAccount({
    id: 'legacy-claude-account',
  })
  const scopedAccount = buildAccount({
    id: 'claude-official:scoped-claude-account',
  })

  assert.equal(
    scheduler.selectAccount([legacyAccount, scopedAccount], [], {
      sessionHash: null,
      forceAccountId: 'claude-official:legacy-claude-account',
      group: null,
    }).id,
    legacyAccount.id,
  )

  assert.equal(
    scheduler.selectAccount([legacyAccount, scopedAccount], [], {
      sessionHash: null,
      forceAccountId: 'scoped-claude-account',
      group: null,
    }).id,
    scopedAccount.id,
  )
})

test('AccountScheduler enforces hard overflow limit for forced and overloaded existing sessions', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  const account = buildAccount({ id: 'account-1', maxSessions: 5 })
  const stickySessions = Array.from({ length: 7 }, (_, index) => ({
    sessionHash: `sticky-${index}`,
    accountId: account.id,
    primaryAccountId: account.id,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
    expiresAt: Date.now() + 60_000,
  }))

  assert.equal(
    scheduler.isAccountAvailableForExistingSession(account, Date.now(), 6, true),
    true,
  )
  assert.equal(
    scheduler.isAccountAvailableForExistingSession(account, Date.now(), 7, true),
    false,
  )
  assert.throws(() => scheduler.selectAccount([account], stickySessions, {
    sessionHash: null,
    forceAccountId: 'account-1',
    group: null,
  }))
})

test('AccountScheduler exposes forced-account blocked reason without leaking selection details into callers', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  const blockedAccount = buildAccount({
    id: 'email:limited@example.com',
    schedulerState: 'auto_blocked',
    autoBlockedReason: 'rate_limit:rejected',
  })

  let caught: unknown = null
  try {
    scheduler.selectAccount([blockedAccount], [], {
      sessionHash: null,
      forceAccountId: 'email:limited@example.com',
      group: null,
    })
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof ForcedAccountUnavailableError)
  assert.equal(caught.reason, 'rate_limit:rejected')
})

// ─── Sticky session affinity with disallowedAccountIds ────────────────────────

function makeBinding(sessionHash: string, accountId: string, primaryAccountId: string = accountId): StickySessionBinding {
  return {
    sessionHash,
    accountId,
    primaryAccountId,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
    expiresAt: Date.now() + 60_000,
  }
}

function makeScheduler() {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })
  const scheduler = new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  return { healthTracker, scheduler }
}

test('sticky session is preserved when disallowedAccountIds contains a different account', () => {
  const { scheduler } = makeScheduler()
  const accountA = buildAccount({ id: 'account-a' })
  const accountB = buildAccount({ id: 'account-b' })
  const stickySessions = [makeBinding('session-1', 'account-a')]

  const selected = scheduler.selectAccount([accountA, accountB], stickySessions, {
    sessionHash: 'session-1',
    forceAccountId: null,
    group: null,
    disallowedAccountIds: ['account-b'],
  })

  assert.equal(selected.id, 'account-a')
})

test('sticky session is skipped when its bound account is in disallowedAccountIds', () => {
  const { scheduler } = makeScheduler()
  const accountA = buildAccount({ id: 'account-a' })
  const accountB = buildAccount({ id: 'account-b' })
  const stickySessions = [makeBinding('session-1', 'account-a')]

  const selected = scheduler.selectAccount([accountA, accountB], stickySessions, {
    sessionHash: 'session-1',
    forceAccountId: null,
    group: null,
    disallowedAccountIds: ['account-a'],
  })

  assert.equal(selected.id, 'account-b')
})

test('sticky session works normally when disallowedAccountIds is empty', () => {
  const { scheduler } = makeScheduler()
  const accountA = buildAccount({ id: 'account-a' })
  const accountB = buildAccount({ id: 'account-b' })
  const stickySessions = [makeBinding('session-1', 'account-a')]

  const selected = scheduler.selectAccount([accountA, accountB], stickySessions, {
    sessionHash: 'session-1',
    forceAccountId: null,
    group: null,
    disallowedAccountIds: [],
  })

  assert.equal(selected.id, 'account-a')
})

test('sticky session falls through when bound account becomes unavailable', () => {
  const { scheduler } = makeScheduler()
  const accountA = buildAccount({ id: 'account-a', status: 'revoked' })
  const accountB = buildAccount({ id: 'account-b' })
  const stickySessions = [makeBinding('session-1', 'account-a')]

  const selected = scheduler.selectAccount([accountA, accountB], stickySessions, {
    sessionHash: 'session-1',
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'account-b')
})

// ─── Draining state behavior ─────────────────────────────────────────────────

test('draining account is excluded from new session selection', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'draining-acct', schedulerState: 'draining' }),
    buildAccount({ id: 'healthy-acct' }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'healthy-acct')
})

test('draining account forces migration of existing sticky sessions', () => {
  const { scheduler } = makeScheduler()
  const drainingAcct = buildAccount({ id: 'draining-acct', schedulerState: 'draining' })
  const healthyAcct = buildAccount({ id: 'healthy-acct' })
  const stickySessions = [makeBinding('session-1', 'draining-acct')]

  const selected = scheduler.selectAccount([drainingAcct, healthyAcct], stickySessions, {
    sessionHash: 'session-1',
    forceAccountId: null,
    group: null,
  })

  // draining blocks both new and existing sessions, forcing migration to another account
  assert.equal(selected.id, 'healthy-acct')
})

test('draining account shows correct blocked status in stats', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'draining-acct', schedulerState: 'draining' }),
  ]

  const stats = scheduler.getStats(accounts, [])
  assert.equal(stats[0].isSelectable, false)
  assert.equal(stats[0].blockedReason, 'draining')
})

// ─── getStats preferredAccountIds ────────────────────────────────────────────

test('getStats reflects sessionAffinityScore when preferredAccountIds is provided', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'preferred-acct' }),
    buildAccount({ id: 'normal-acct' }),
  ]

  const stats = scheduler.getStats(accounts, [], Date.now(), undefined, new Set(['preferred-acct']))
  const preferred = stats.find((s) => s.accountId === 'preferred-acct')!
  const normal = stats.find((s) => s.accountId === 'normal-acct')!

  assert.equal(preferred.sessionAffinityScore, 1)
  assert.equal(normal.sessionAffinityScore, 0)
  assert.ok(preferred.totalScore > normal.totalScore)
})

// ─── maxSessionOverflow validation ──────────────────────────────────────────

test('constructor throws on negative maxSessionOverflow', () => {
  const healthTracker = new AccountHealthTracker({
    windowMs: 5 * 60 * 1000,
    errorThreshold: 10,
  })

  assert.throws(
    () => new AccountScheduler(healthTracker, { defaultMaxSessions: 5, maxSessionOverflow: -1 }),
    /maxSessionOverflow must be >= 0/,
  )
})

// ─── Health tracker integration ─────────────────────────────────────────────

test('health-rate-limited account is excluded from selection', () => {
  const { healthTracker, scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'limited-acct' }),
    buildAccount({ id: 'healthy-acct' }),
  ]

  healthTracker.recordResponse('limited-acct', 429, 300)

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'healthy-acct')
})

test('account with low health score is deprioritized but not blocked', () => {
  const { healthTracker, scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'degraded-acct' }),
    buildAccount({ id: 'healthy-acct' }),
  ]

  // Add several 5xx errors to degrade health but not block
  for (let i = 0; i < 3; i++) {
    healthTracker.recordResponse('degraded-acct', 500)
  }

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'healthy-acct')

  // degraded account is still selectable (not blocked), just lower scored
  const stats = scheduler.getStats(accounts, [])
  const degraded = stats.find((s) => s.accountId === 'degraded-acct')!
  assert.equal(degraded.isSelectable, true)
  assert.ok(degraded.healthScore < 1)
})

// ─── Cooldown and inactive states ───────────────────────────────────────────

test('account in cooldown is excluded from selection', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'cooled', cooldownUntil: Date.now() + 60_000 }),
    buildAccount({ id: 'available' }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'available')
})

test('inactive account is excluded from selection', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'inactive-acct', isActive: false }),
    buildAccount({ id: 'active-acct' }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'active-acct')
})

test('account without proxy is excluded from selection', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'no-proxy', proxyUrl: '' }),
    buildAccount({ id: 'with-proxy' }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'with-proxy')
})

// ─── Capacity exhaustion ────────────────────────────────────────────────────

test('throws SchedulerCapacityError when all accounts are at capacity', () => {
  const { scheduler } = makeScheduler()
  const account = buildAccount({ id: 'full-acct', maxSessions: 2 })
  const stickySessions = [
    makeBinding('s1', 'full-acct'),
    makeBinding('s2', 'full-acct'),
  ]

  assert.throws(
    () => scheduler.selectAccount([account], stickySessions, {
      sessionHash: null,
      forceAccountId: null,
      group: null,
    }),
    /at capacity/i,
  )
})

test('allows OpenAI Codex soft capacity overflow when quota headroom remains', () => {
  const { scheduler } = makeScheduler()
  const account = buildAccount({
    id: 'openai-full',
    provider: 'openai-codex',
    protocol: 'openai',
    maxSessions: 1,
    lastRateLimit5hUtilization: 0.2,
    lastRateLimit7dUtilization: 0.2,
  })
  const stickySessions = [makeBinding('s1', 'openai-full')]

  assert.throws(
    () => scheduler.selectAccount([account], stickySessions, {
      sessionHash: null,
      forceAccountId: null,
      provider: 'openai-codex',
      group: null,
    }),
    /at capacity/i,
  )

  const selected = scheduler.selectAccount([account], stickySessions, {
    sessionHash: null,
    forceAccountId: null,
    provider: 'openai-codex',
    group: null,
    allowCapacityOverflowFallback: true,
  })
  const [stat] = scheduler.getStats([account], stickySessions)

  assert.equal(selected.id, 'openai-full')
  assert.equal(stat.isSelectable, true)
  assert.equal(stat.blockedReason, null)
})

test('capacity overflow fallback still rejects accounts without quota headroom', () => {
  const { scheduler } = makeScheduler()
  const account = buildAccount({
    id: 'openai-spent',
    provider: 'openai-codex',
    protocol: 'openai',
    maxSessions: 1,
    lastRateLimit5hUtilization: 1,
    lastRateLimit7dUtilization: 1,
  })
  const stickySessions = [makeBinding('s1', 'openai-spent')]

  assert.throws(
    () => scheduler.selectAccount([account], stickySessions, {
      sessionHash: null,
      forceAccountId: null,
      provider: 'openai-codex',
      group: null,
      allowCapacityOverflowFallback: true,
    }),
    /at capacity/i,
  )
})

test('throws when no accounts available in requested group', () => {
  const { scheduler } = makeScheduler()
  const account = buildAccount({ id: 'group-a-acct', group: 'group-a' })

  assert.throws(
    () => scheduler.selectAccount([account], [], {
      sessionHash: null,
      forceAccountId: null,
      group: 'group-b',
    }),
    /No available accounts in group "group-b"/,
  )
})

test('selects grouped accounts when no group is requested', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'blocked-ungrouped', schedulerState: 'auto_blocked', autoBlockedReason: 'rate_limit:rejected' }),
    buildAccount({ id: 'healthy-grouped', group: 'claude-official', routingGroupId: 'claude-official' }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  })

  assert.equal(selected.id, 'healthy-grouped')
})

// ─── preferredAccountIds scoring ────────────────────────────────────────────

test('preferredAccountIds boosts account score in selection', () => {
  const { scheduler } = makeScheduler()
  const accounts = [
    buildAccount({ id: 'normal' }),
    buildAccount({ id: 'preferred' }),
  ]

  const selected = scheduler.selectAccount(accounts, [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
    preferredAccountIds: ['preferred'],
  })

  assert.equal(selected.id, 'preferred')
})

// ─── Primary-account recovery & cooldown fallback ───────────────────────────

test('primary account is returned when available even if sticky binding points to fallback', () => {
  const { scheduler } = makeScheduler()
  const accountA = buildAccount({ id: 'account-a' })
  const accountB = buildAccount({ id: 'account-b' })
  const stickySessions = [makeBinding('session-1', 'account-b', 'account-a')]

  const selected = scheduler.selectAccount([accountA, accountB], stickySessions, {
    sessionHash: 'session-1',
    forceAccountId: null,
    group: null,
    primaryAccountId: 'account-a',
  })

  assert.equal(selected.id, 'account-a')
})

test('falls back to sticky binding when primary is cooling down', () => {
  const { scheduler } = makeScheduler()
  const now = Date.now()
  const accountA = buildAccount({ id: 'account-a', cooldownUntil: now + 60_000 })
  const accountB = buildAccount({ id: 'account-b' })
  const stickySessions = [makeBinding('session-1', 'account-b', 'account-a')]

  const selected = scheduler.selectAccount([accountA, accountB], stickySessions, {
    sessionHash: 'session-1',
    forceAccountId: null,
    group: null,
    primaryAccountId: 'account-a',
  }, now)

  assert.equal(selected.id, 'account-b')
})

test('selectEarliestCooldownCandidate picks the account whose cooldown ends soonest when allowCooldownFallback is on', () => {
  const { scheduler } = makeScheduler()
  const now = Date.now()
  const accountA = buildAccount({ id: 'account-a', cooldownUntil: now + 10 * 60_000 })
  const accountB = buildAccount({ id: 'account-b', cooldownUntil: now + 1 * 60_000 })
  const accountC = buildAccount({ id: 'account-c', cooldownUntil: now + 5 * 60_000 })

  const selected = scheduler.selectAccount([accountA, accountB, accountC], [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
    allowCooldownFallback: true,
  }, now)

  assert.equal(selected.id, 'account-b')
})

test('selectEarliestCooldownCandidate is not used when allowCooldownFallback is false', () => {
  const { scheduler } = makeScheduler()
  const now = Date.now()
  const accountA = buildAccount({ id: 'account-a', cooldownUntil: now + 10 * 60_000 })
  const accountB = buildAccount({ id: 'account-b', cooldownUntil: now + 1 * 60_000 })

  assert.throws(() => scheduler.selectAccount([accountA, accountB], [], {
    sessionHash: null,
    forceAccountId: null,
    group: null,
  }, now))
})

test('selectEarliestCooldownCandidate skips revoked / inactive / draining accounts', () => {
  const { scheduler } = makeScheduler()
  const now = Date.now()
  const revoked = buildAccount({
    id: 'revoked',
    cooldownUntil: now + 30_000,
    status: 'revoked',
  })
  const inactive = buildAccount({
    id: 'inactive',
    cooldownUntil: now + 60_000,
    isActive: false,
  })
  const draining = buildAccount({
    id: 'draining',
    cooldownUntil: now + 90_000,
    schedulerState: 'draining',
  })
  const cooling = buildAccount({ id: 'cooling', cooldownUntil: now + 120_000 })

  const selected = scheduler.selectAccount(
    [revoked, inactive, draining, cooling],
    [],
    {
      sessionHash: null,
      forceAccountId: null,
      group: null,
      allowCooldownFallback: true,
    },
    now,
  )

  assert.equal(selected.id, 'cooling')
})

test('auto_blocked account is soft-released after autoBlockedUntil expires', () => {
  const { scheduler } = makeScheduler()
  const now = Date.now()
  const expired = buildAccount({
    id: 'expired-block',
    schedulerState: 'auto_blocked',
    autoBlockedReason: 'rate_limit:rejected',
    autoBlockedUntil: now - 60_000,
    lastRateLimitStatus: 'allowed',
    lastRateLimit5hUtilization: 0.1,
    lastRateLimit7dUtilization: 0.2,
  })

  const selected = scheduler.selectAccount(
    [expired],
    [],
    { sessionHash: null, forceAccountId: null, group: null },
    now,
  )

  assert.equal(selected.id, 'expired-block')
})

test('auto_blocked account stays blocked while autoBlockedUntil is in the future', () => {
  const { scheduler } = makeScheduler()
  const now = Date.now()
  const blocked = buildAccount({
    id: 'still-blocked',
    schedulerState: 'auto_blocked',
    autoBlockedReason: 'rate_limit:rejected',
    autoBlockedUntil: now + 60_000,
    lastRateLimit5hUtilization: 0.1,
    lastRateLimit7dUtilization: 0.2,
  })
  const fallback = buildAccount({ id: 'healthy' })

  const selected = scheduler.selectAccount(
    [blocked, fallback],
    [],
    { sessionHash: null, forceAccountId: null, group: null },
    now,
  )
  assert.equal(selected.id, 'healthy')

  assert.throws(
    () => scheduler.selectAccount(
      [blocked],
      [],
      { sessionHash: null, forceAccountId: null, group: null },
      now,
    ),
    /No available OAuth accounts|at capacity/i,
  )
})

test('auto_blocked account with null autoBlockedUntil stays blocked indefinitely', () => {
  const { scheduler } = makeScheduler()
  const blocked = buildAccount({
    id: 'manual-block',
    schedulerState: 'auto_blocked',
    autoBlockedReason: 'manual',
    autoBlockedUntil: null,
  })

  assert.throws(
    () => scheduler.selectAccount(
      [blocked],
      [],
      { sessionHash: null, forceAccountId: null, group: null },
    ),
    /No available OAuth accounts|at capacity/i,
  )
})

test('hasHardQuotaExhaustion: rejected status with full usage data and headroom is selectable', () => {
  const { scheduler } = makeScheduler()
  // Mirrors the it@yohomobile.com case: status=rejected but utilizations are well below 1
  const account = buildAccount({
    id: 'stale-rejected',
    lastRateLimitStatus: 'rejected',
    lastRateLimit5hUtilization: 0.24,
    lastRateLimit7dUtilization: 0.17,
  })

  const selected = scheduler.selectAccount(
    [account],
    [],
    { sessionHash: null, forceAccountId: null, group: null },
  )
  assert.equal(selected.id, 'stale-rejected')
})

test('hasHardQuotaExhaustion: rejected status with 7d utilization at 1.0 stays blocked', () => {
  const { scheduler } = makeScheduler()
  const account = buildAccount({
    id: 'true-exhausted',
    lastRateLimitStatus: 'rejected',
    lastRateLimit5hUtilization: 0,
    lastRateLimit7dUtilization: 1,
  })

  assert.throws(
    () => scheduler.selectAccount(
      [account],
      [],
      { sessionHash: null, forceAccountId: null, group: null },
    ),
    /No available OAuth accounts|at capacity/i,
  )
})

test('hasHardQuotaExhaustion: rejected status with missing 7d data stays blocked (conservative)', () => {
  const { scheduler } = makeScheduler()
  const account = buildAccount({
    id: 'partial-data',
    lastRateLimitStatus: 'rejected',
    lastRateLimit5hUtilization: 0.5,
    lastRateLimit7dUtilization: null,
  })

  assert.throws(
    () => scheduler.selectAccount(
      [account],
      [],
      { sessionHash: null, forceAccountId: null, group: null },
    ),
    /No available OAuth accounts|at capacity/i,
  )
})

test('SchedulerCapacityError carries diagnostic buckets with each blocked reason counted', () => {
  const { scheduler } = makeScheduler()
  const now = Date.now()
  const accounts = [
    buildAccount({
      id: 'quota',
      group: 'codex',
      lastRateLimit7dUtilization: 1,
    }),
    buildAccount({
      id: 'auto',
      group: 'codex',
      schedulerState: 'auto_blocked',
      autoBlockedReason: 'rate_limit:rejected',
      autoBlockedUntil: now + 60_000,
    }),
  ]

  let captured: SchedulerCapacityError | null = null
  try {
    scheduler.selectAccount(
      accounts,
      [],
      { sessionHash: null, forceAccountId: null, group: 'codex' },
      now,
    )
  } catch (error) {
    if (error instanceof SchedulerCapacityError) captured = error
    else throw error
  }

  assert.ok(captured, 'expected SchedulerCapacityError')
  assert.ok(captured!.diagnostics, 'expected diagnostics on error')
  assert.equal(captured!.diagnostics!.totalScoped, 2)
  assert.equal(captured!.diagnostics!.quotaExhausted, 1)
  assert.equal(captured!.diagnostics!.autoBlocked, 1)
  assert.equal(captured!.diagnostics!.capacityFull, 0)
  assert.equal(captured!.diagnostics!.healthRateLimited, 0)
  const message = formatSchedulerCapacityError(captured!)
  assert.match(message, /total=2 quota=1 auto_blocked=1/)
})
