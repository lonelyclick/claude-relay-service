/**
 * Tests for the zero-429 reactive layer (R1–R9):
 *  R1: sameRequestSessionMigrationEnabled defaults to true
 *  R2/R3: computeRateLimitCooldownMs — always cooldown on 429, smart duration
 *  R5: canRecoverToPrimary respects lastSoftMigrationAt cooldown
 *  R6: allowCooldownFallback:true — new sessions can be served from cooldown account
 *  R9: sameRequestMaxRetries is configurable
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { appConfig } from '../config.js'
import { AccountScheduler } from '../scheduler/accountScheduler.js'
import { FingerprintCache } from '../scheduler/fingerprintCache.js'
import { AccountHealthTracker } from '../scheduler/healthTracker.js'
import { MemoryTokenStore, MemoryUserStore } from '../testHelpers/fakes.js'
import type { StoredAccount, TokenStoreData } from '../types.js'
import { OAuthService } from '../oauth/service.js'

function buildAccount(input: Partial<StoredAccount> & { id: string }): StoredAccount {
  const nowIso = '2026-04-25T00:00:00.000Z'
  return {
    id: input.id,
    provider: input.provider ?? 'claude-official',
    protocol: input.protocol ?? 'claude',
    authMode: input.authMode ?? 'oauth',
    label: input.label ?? input.id,
    isActive: input.isActive ?? true,
    status: input.status ?? 'active',
    lastSelectedAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    lastFailureAt: null,
    cooldownUntil: input.cooldownUntil ?? null,
    lastError: null,
    accessToken: input.accessToken === undefined ? 'access-token' : input.accessToken,
    refreshToken: input.refreshToken === undefined ? 'refresh-token' : input.refreshToken,
    expiresAt: input.expiresAt ?? null,
    scopes: ['user:inference'],
    createdAt: nowIso,
    updatedAt: nowIso,
    subscriptionType: input.subscriptionType ?? 'max',
    rateLimitTier: null,
    accountUuid: input.id,
    organizationUuid: `org-${input.id}`,
    emailAddress: `${input.id}@example.com`,
    displayName: input.id,
    hasExtraUsageEnabled: null,
    billingType: null,
    accountCreatedAt: null,
    subscriptionCreatedAt: null,
    rawProfile: null,
    roles: null,
    routingGroupId: input.routingGroupId ?? null,
    group: input.group ?? null,
    maxSessions: input.maxSessions ?? 5,
    weight: 1,
    schedulerEnabled: input.schedulerEnabled ?? true,
    schedulerState: input.schedulerState ?? 'enabled',
    autoBlockedReason: input.autoBlockedReason ?? null,
    autoBlockedUntil: null,
    lastRateLimitStatus: input.lastRateLimitStatus ?? null,
    lastRateLimit5hUtilization: input.lastRateLimit5hUtilization ?? null,
    lastRateLimit7dUtilization: input.lastRateLimit7dUtilization ?? null,
    lastRateLimitReset: null,
    lastRateLimitAt: input.lastRateLimitAt ?? null,
    lastProbeAttemptAt: input.lastProbeAttemptAt ?? null,
    proxyUrl: input.proxyUrl !== undefined ? input.proxyUrl : 'http://127.0.0.1:10810',
    bodyTemplatePath: null,
    vmFingerprintTemplatePath: null,
    deviceId: 'device-id',
    apiBaseUrl: null,
    modelName: null,
    modelTierMap: null,
    modelMap: null,
    loginPassword: null,
  }
}

function createService(
  accounts: StoredAccount[],
  userStore: MemoryUserStore | null = null,
  healthTracker?: AccountHealthTracker,
): { oauthService: OAuthService; store: MemoryTokenStore } {
  const storeData: TokenStoreData = {
    version: 3,
    accounts,
    stickySessions: [],
    proxies: [],
    routingGroups: [],
  }
  const store = new MemoryTokenStore(storeData)
  const tracker = healthTracker ?? new AccountHealthTracker({ windowMs: 5 * 60 * 1000, errorThreshold: 10 })
  const scheduler = new AccountScheduler(tracker, { defaultMaxSessions: 5, maxSessionOverflow: 1 })
  return {
    oauthService: new OAuthService(store, scheduler, new FingerprintCache(), (userStore ?? null) as never),
    store,
  }
}

// ── R1: feature flag default ─────────────────────────────────────────────────

test('R1: sameRequestSessionMigrationEnabled defaults to true', () => {
  assert.equal(appConfig.sameRequestSessionMigrationEnabled, true)
})

// ── R2/R3: computeRateLimitCooldownMs logic ──────────────────────────────────
// Tests via the exported config values and behavior expectations on the scheduler.

test('R2/R3: rateLimitCooldownFallbackMs and rateLimitCooldownMaxMs are configured', () => {
  assert.ok(appConfig.rateLimitCooldownFallbackMs > 0, 'fallback must be positive')
  assert.ok(appConfig.rateLimitCooldownMaxMs > 0, 'max must be positive')
  assert.ok(
    appConfig.rateLimitCooldownFallbackMs <= appConfig.rateLimitCooldownMaxMs,
    'fallback must not exceed max',
  )
})

test('R2/R3: rateLimitCooldownFallbackMs is 60s and rateLimitCooldownMaxMs is 5min', () => {
  assert.equal(appConfig.rateLimitCooldownFallbackMs, 60_000)
  assert.equal(appConfig.rateLimitCooldownMaxMs, 5 * 60 * 1000)
})

// ── R5: canRecoverToPrimary cooldown guard ────────────────────────────────────

test('R5: primary_recovered is suppressed within stickyMigrationCooldownMs', async () => {
  const now = Date.parse('2026-04-25T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-r5',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })
    // Set lastSoftMigrationAt to 30s ago (within the 5-min cooldown)
    await userStore.updateSessionRouteSoftMigrationAt('sess-r5', now - 30_000)

    const { oauthService } = createService([
      buildAccount({ id: 'acc-a' }),  // primary — available and healthy
      buildAccount({ id: 'acc-b' }),  // current — also available
    ], userStore)

    // Route: acc-b is current, acc-a is primary (simulate post-migration state)
    await userStore.migrateSessionRoute({
      sessionKey: 'sess-r5',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      fromAccountId: 'acc-a',
      toAccountId: 'acc-b',
      reason: 'soft_quota_pressure',
      summary: '',
      // primaryAccountId defaults to existing.primaryAccountId = 'acc-a'
    })
    await userStore.updateSessionRouteSoftMigrationAt('sess-r5', now - 30_000)

    Date.now = () => now

    const resolved = await oauthService.selectAccount({
      sessionKey: 'sess-r5',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })

    // Within cooldown: primary_recovered must NOT fire — stays on acc-b
    assert.equal(resolved.account.id, 'acc-b', 'should stay on acc-b (primary_recovered suppressed by cooldown guard)')
    assert.equal(resolved.handoffReason, null)
  } finally {
    Date.now = origDateNow
  }
})

test('R5: primary_recovered fires after stickyMigrationCooldownMs expires', async () => {
  const now = Date.parse('2026-04-25T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-r5-expired',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })
    // Set lastSoftMigrationAt to 10 min ago (beyond the 5-min cooldown)
    await userStore.updateSessionRouteSoftMigrationAt('sess-r5-expired', now - 10 * 60_000)

    const { oauthService } = createService([
      buildAccount({ id: 'acc-a' }),
      buildAccount({ id: 'acc-b' }),
    ], userStore)

    await userStore.migrateSessionRoute({
      sessionKey: 'sess-r5-expired',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      fromAccountId: 'acc-a',
      toAccountId: 'acc-b',
      reason: 'soft_quota_pressure',
      summary: '',
    })
    await userStore.updateSessionRouteSoftMigrationAt('sess-r5-expired', now - 10 * 60_000)

    Date.now = () => now

    const resolved = await oauthService.selectAccount({
      sessionKey: 'sess-r5-expired',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })

    // After cooldown: primary_recovered fires, session returns to acc-a
    assert.equal(resolved.account.id, 'acc-a', 'primary_recovered should fire after cooldown expires')
    assert.equal(resolved.handoffReason, 'primary_recovered')
  } finally {
    Date.now = origDateNow
  }
})

// ── R6: allowCooldownFallback:true for new sessions ──────────────────────────

test('R6: new session gets served from cooldown account when all accounts are rate-limited', async () => {
  const now = Date.now()
  const cooldownUntil = now + 60_000  // 1 min from now

  // Both accounts in DB cooldown — normally would throw SchedulerCapacityError
  const { oauthService } = createService([
    buildAccount({ id: 'acc-a', cooldownUntil }),
    buildAccount({ id: 'acc-b', cooldownUntil: now + 120_000 }),  // longer cooldown
  ])

  // With allowCooldownFallback:true, acc-a (shortest cooldown) should be returned
  const resolved = await oauthService.selectAccount({})
  assert.equal(resolved.account.id, 'acc-a', 'should pick acc-a (shortest cooldown) via cooldown fallback')
})

test('R6: existing session gets cooldown fallback too (no regression)', async () => {
  const now = Date.now()
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'sess-r6',
    userId: 'user-1',
    clientDeviceId: 'dev-1',
    accountId: 'acc-a',
  })

  const cooldownUntil = now + 60_000
  const { oauthService } = createService([
    buildAccount({ id: 'acc-a', cooldownUntil }),
    buildAccount({ id: 'acc-b', cooldownUntil: now + 120_000 }),
  ], userStore)

  const resolved = await oauthService.selectAccount({
    sessionKey: 'sess-r6',
    userId: 'user-1',
    clientDeviceId: 'dev-1',
  })
  // acc-a is the current route — canFallbackToCurrentRoute would kick in if scheduler fails
  // either way, we get an account, not a throw
  assert.ok(resolved.account, 'should resolve to an account, not throw')
})

// ── R9: sameRequestMaxRetries is configurable ────────────────────────────────

test('R9: sameRequestMaxRetries defaults to 2', () => {
  assert.equal(appConfig.sameRequestMaxRetries, 2)
})
