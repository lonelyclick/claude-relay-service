import assert from 'node:assert/strict'
import test from 'node:test'

import { appConfig } from '../config.js'
import { AccountScheduler } from '../scheduler/accountScheduler.js'
import { FingerprintCache } from '../scheduler/fingerprintCache.js'
import { AccountHealthTracker } from '../scheduler/healthTracker.js'
import { MemoryTokenStore, MemoryUserStore } from '../testHelpers/fakes.js'
import type { StoredAccount, TokenStoreData } from '../types.js'
import { OAuthService } from './service.js'

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
): { oauthService: OAuthService; store: MemoryTokenStore } {
  const storeData: TokenStoreData = {
    version: 3,
    accounts,
    stickySessions: [],
    proxies: [],
    routingGroups: [],
  }
  const store = new MemoryTokenStore(storeData)
  const scheduler = new AccountScheduler(
    new AccountHealthTracker({ windowMs: 5 * 60 * 1000, errorThreshold: 10 }),
    { defaultMaxSessions: 5, maxSessionOverflow: 1 },
  )
  return {
    oauthService: new OAuthService(store, scheduler, new FingerprintCache(), (userStore ?? null) as never),
    store,
  }
}

// ── Fix 1 (A1): recordRateLimitSnapshot observedAt ordering ──────────────────

test('recordRateLimitSnapshot: stale observedAt does not overwrite fresher data', async () => {
  const t = Date.parse('2026-04-13T00:00:00.000Z')
  const { oauthService } = createService([
    buildAccount({
      id: 'acc',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.3,
      lastRateLimitAt: new Date(t).toISOString(),
    }),
  ])

  await oauthService.recordRateLimitSnapshot({
    accountId: 'acc',
    status: 'rate_limited',
    fiveHourUtilization: 0.99,
    sevenDayUtilization: 0.5,
    resetTimestamp: null,
    observedAt: t - 1000, // older than existing lastRateLimitAt → should be skipped
  })

  const account = await oauthService.getAccount('acc')
  assert.ok(account)
  assert.equal(account.lastRateLimitStatus, 'allowed')
  assert.equal(account.lastRateLimit5hUtilization, 0.3)
})

test('recordRateLimitSnapshot: newer observedAt overwrites existing data', async () => {
  const t = Date.parse('2026-04-13T00:00:00.000Z')
  const { oauthService } = createService([
    buildAccount({
      id: 'acc',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.3,
      lastRateLimitAt: new Date(t - 5000).toISOString(),
    }),
  ])

  await oauthService.recordRateLimitSnapshot({
    accountId: 'acc',
    status: 'allowed_warning',
    fiveHourUtilization: 0.8,
    sevenDayUtilization: 0.5,
    resetTimestamp: null,
    observedAt: t, // newer than existing → should apply
  })

  const account = await oauthService.getAccount('acc')
  assert.ok(account)
  assert.equal(account.lastRateLimitStatus, 'allowed_warning')
  assert.equal(account.lastRateLimit5hUtilization, 0.8)
})

test('recordRateLimitSnapshot: null observedAt always applies (no ordering guard)', async () => {
  const t = Date.parse('2026-04-13T00:00:00.000Z')
  const { oauthService } = createService([
    buildAccount({
      id: 'acc',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.3,
      lastRateLimitAt: new Date(t).toISOString(),
    }),
  ])

  await oauthService.recordRateLimitSnapshot({
    accountId: 'acc',
    status: 'rate_limited',
    fiveHourUtilization: 0.99,
    sevenDayUtilization: 0.5,
    resetTimestamp: null,
    // no observedAt → skip ordering check → always writes
  })

  const account = await oauthService.getAccount('acc')
  assert.ok(account)
  assert.equal(account.lastRateLimitStatus, 'rate_limited')
  assert.equal(account.lastRateLimit5hUtilization, 0.99)
})

// ── Fix 3 (B1): updateAccountSettings re-enable clears fault state ───────────

test('updateAccountSettings: re-enabling auto_blocked clears cooldownUntil and autoBlockedReason', async () => {
  const now = Date.now()
  const { oauthService } = createService([
    buildAccount({
      id: 'acc',
      schedulerState: 'auto_blocked',
      autoBlockedReason: 'rate_limit:rejected',
      cooldownUntil: now + 60_000,
    }),
  ])

  const updated = await oauthService.updateAccountSettings('acc', { schedulerState: 'enabled' })
  assert.ok(updated)
  assert.equal(updated.schedulerState, 'enabled')
  assert.equal(updated.cooldownUntil, null)
  assert.equal(updated.autoBlockedReason, null)
})

test('updateAccountSettings: paused state is not disturbed by unrelated setting changes', async () => {
  const { oauthService } = createService([
    buildAccount({ id: 'acc', schedulerState: 'paused' }),
  ])

  const updated = await oauthService.updateAccountSettings('acc', { label: 'new-label' })
  assert.ok(updated)
  assert.equal(updated.schedulerState, 'paused')
  assert.equal(updated.label, 'new-label')
})

// ── Fix 5 (C1): per-session cooldown + hysteresis for soft_quota_pressure ────

test('selectAccount: per-session cooldown suppresses soft_quota_pressure migration', async () => {
  const now = Date.parse('2026-04-13T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-cooldown',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })
    // Simulate a migration 1 min ago (well within 5-min cooldown)
    await userStore.updateSessionRouteSoftMigrationAt('sess-cooldown', now - 60_000)

    const { oauthService } = createService([
      buildAccount({
        id: 'acc-a',
        // 5h util above 0.75 threshold + fresh snapshot → would normally trigger soft_quota_pressure
        lastRateLimit5hUtilization: 0.80,
        lastRateLimitAt: new Date(now - 60_000).toISOString(),
      }),
      buildAccount({ id: 'acc-b', lastRateLimit5hUtilization: 0.10 }),
    ], userStore)

    Date.now = () => now
    const resolved = await oauthService.selectAccount({
      sessionKey: 'sess-cooldown',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })

    assert.equal(resolved.account.id, 'acc-a', 'should stay on acc-a due to per-session cooldown')
  } finally {
    Date.now = origDateNow
  }
})

test('selectAccount: soft_quota_pressure migration resumes after cooldown expires', async () => {
  const now = Date.parse('2026-04-13T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-expired',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })
    // 10 min ago → beyond 5-min cooldown window
    await userStore.updateSessionRouteSoftMigrationAt('sess-expired', now - 10 * 60_000)

    const { oauthService } = createService([
      buildAccount({
        id: 'acc-a',
        lastRateLimit5hUtilization: 0.80,
        lastRateLimitAt: new Date(now - 60_000).toISOString(),
      }),
      buildAccount({ id: 'acc-b', lastRateLimit5hUtilization: 0.10 }),
    ], userStore)

    Date.now = () => now
    const resolved = await oauthService.selectAccount({
      sessionKey: 'sess-expired',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })

    assert.equal(resolved.account.id, 'acc-b', 'should migrate to acc-b after cooldown expires')
  } finally {
    Date.now = origDateNow
  }
})

test('selectAccount: hysteresis filter blocks candidate above threshold-minus-hysteresis, falls back', async () => {
  const now = Date.parse('2026-04-13T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-hysteresis',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })

    const { oauthService } = createService([
      buildAccount({
        id: 'acc-a',
        // above 0.75 threshold with fresh snapshot → triggers soft_quota_pressure migration
        lastRateLimit5hUtilization: 0.80,
        lastRateLimitAt: new Date(now - 60_000).toISOString(),
      }),
      buildAccount({
        id: 'acc-b',
        // 0.72 < 0.75 threshold but 0.72 > 0.70 (= threshold 0.75 - hysteresis 0.05)
        // → filtered out by hysteresis, no eligible target → fallback to acc-a
        lastRateLimit5hUtilization: 0.72,
      }),
    ], userStore)

    Date.now = () => now
    const resolved = await oauthService.selectAccount({
      sessionKey: 'sess-hysteresis',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })

    assert.equal(resolved.account.id, 'acc-a', 'should fall back to acc-a when all targets fail hysteresis')
  } finally {
    Date.now = origDateNow
  }
})

// ── Fix 6 (C2): getAccountsForRateLimitProbe uses lastProbeAttemptAt ─────────

test('getAccountsForRateLimitProbe: excludes account with recent lastProbeAttemptAt', async () => {
  const now = Date.now()
  const { oauthService } = createService([
    buildAccount({
      id: 'acc-fresh-probe',
      lastProbeAttemptAt: now - 60_000, // 1 min ago, within 5-min interval
    }),
    buildAccount({
      id: 'acc-no-probe',
      lastProbeAttemptAt: null,
      lastRateLimitAt: null,
    }),
  ])

  const targets = await oauthService.getAccountsForRateLimitProbe(now)
  const ids = targets.map((a) => a.id)
  assert.ok(!ids.includes('acc-fresh-probe'), 'recently probed account should be excluded')
  assert.ok(ids.includes('acc-no-probe'), 'never-probed account should be included')
})

test('getAccountsForRateLimitProbe: recent lastProbeAttemptAt blocks eligibility even if lastRateLimitAt is stale', async () => {
  const now = Date.now()
  const intervalMs = appConfig.rateLimitProbeIntervalMs

  const { oauthService } = createService([
    buildAccount({
      id: 'acc',
      lastRateLimitAt: new Date(now - intervalMs * 3).toISOString(), // old rate-limit data
      lastProbeAttemptAt: now - 60_000, // but probed recently → not eligible
    }),
  ])

  const targets = await oauthService.getAccountsForRateLimitProbe(now)
  assert.ok(!targets.find((a) => a.id === 'acc'), 'recent probe should block eligibility despite old lastRateLimitAt')
})

test('getAccountsForRateLimitProbe: stale lastProbeAttemptAt makes account eligible', async () => {
  const now = Date.now()
  const intervalMs = appConfig.rateLimitProbeIntervalMs

  const { oauthService } = createService([
    buildAccount({
      id: 'acc',
      lastProbeAttemptAt: now - intervalMs * 2, // probe was long ago → eligible
      lastRateLimitAt: null,
    }),
  ])

  const targets = await oauthService.getAccountsForRateLimitProbe(now)
  assert.ok(targets.find((a) => a.id === 'acc'), 'account with stale probe should be eligible')
})

// ── Boundary / integration scenarios ─────────────────────────────────────────

// Scenario A: 3 accounts all util > threshold, hysteresis filters all → fallback, no throw
test('scenario A: all 3 accounts fail hysteresis filter → falls back to current, no throw', async () => {
  const now = Date.parse('2026-04-13T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-a',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })

    const freshIso = new Date(now - 60_000).toISOString()

    const { oauthService } = createService([
      buildAccount({
        id: 'acc-a',
        lastRateLimit5hUtilization: 0.80, // above 0.75 threshold, triggers migration
        lastRateLimitAt: freshIso,
      }),
      buildAccount({
        id: 'acc-b',
        lastRateLimit5hUtilization: 0.72, // above hysteresis line (0.70) → filtered out
      }),
      buildAccount({
        id: 'acc-c',
        lastRateLimit5hUtilization: 0.71, // also above hysteresis line → filtered out
      }),
    ], userStore)

    Date.now = () => now
    const resolved = await oauthService.selectAccount({
      sessionKey: 'sess-a',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })

    // All candidates fail hysteresis → must fall back to current (acc-a), no throw
    assert.equal(resolved.account.id, 'acc-a')
    assert.equal(resolved.handoffReason, null, 'no migration should occur')
  } finally {
    Date.now = origDateNow
  }
})

// Scenario B: after migration to acc-b, acc-b also goes high within the cooldown window.
// R5 guard: canRecoverToPrimary now checks lastSoftMigrationAt. If within cooldown,
// primary_recovered is suppressed → session stays on acc-b (no ping-pong).
test('scenario B: primary_recovered is suppressed by cooldown guard when acc-b also spikes', async () => {
  const now = Date.parse('2026-04-13T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    // Start on acc-a (acc-a becomes primaryAccountId in the migrated route)
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-b',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })

    const freshIso = new Date(now - 60_000).toISOString()

    const { oauthService } = createService([
      buildAccount({
        id: 'acc-a',
        lastRateLimit5hUtilization: 0.80,
        lastRateLimitAt: freshIso,
      }),
      buildAccount({
        id: 'acc-b',
        lastRateLimit5hUtilization: 0.10,
      }),
    ], userStore)

    Date.now = () => now

    // First request: migrates to acc-b (acc-a is soft_quota_pressure, acc-b is eligible)
    const first = await oauthService.selectAccount({
      sessionKey: 'sess-b',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })
    assert.equal(first.account.id, 'acc-b', 'should migrate to acc-b')
    assert.equal(first.handoffReason, 'soft_quota_pressure')

    // acc-b also spikes — cooldown would suppress soft_quota_pressure (lastSoftMigrationAt = now)
    await oauthService.recordRateLimitSnapshot({
      accountId: 'acc-b',
      status: 'allowed',
      fiveHourUtilization: 0.85,
      sevenDayUtilization: 0.1,
      resetTimestamp: null,
    })

    // Second request: cooldown suppresses soft_quota_pressure on acc-b (baseMigrationReason = null),
    // and R5 guard also suppresses primary_recovered (lastSoftMigrationAt within cooldown).
    // Result: stays on acc-b — no ping-pong back to acc-a during cooldown window.
    const second = await oauthService.selectAccount({
      sessionKey: 'sess-b',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
    })
    assert.equal(second.account.id, 'acc-b', 'stays on acc-b — primary_recovered suppressed by cooldown guard')
    assert.equal(second.handoffReason, null)
  } finally {
    Date.now = origDateNow
  }
})

// Scenario C: forceAccountId bypasses hysteresis filter
test('scenario C: forceAccountId bypasses soft_quota_pressure hysteresis filter', async () => {
  const now = Date.parse('2026-04-13T12:00:00.000Z')
  const origDateNow = Date.now
  try {
    const userStore = new MemoryUserStore()
    await userStore.ensureSessionRoute({
      sessionKey: 'sess-c',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      accountId: 'acc-a',
    })

    const freshIso = new Date(now - 60_000).toISOString()

    const { oauthService } = createService([
      buildAccount({
        id: 'acc-a',
        lastRateLimit5hUtilization: 0.80,
        lastRateLimitAt: freshIso,
      }),
      buildAccount({
        id: 'acc-b',
        // 0.95 util — above hysteresis line, would normally be filtered
        lastRateLimit5hUtilization: 0.95,
      }),
    ], userStore)

    Date.now = () => now
    const resolved = await oauthService.selectAccount({
      sessionKey: 'sess-c',
      userId: 'user-1',
      clientDeviceId: 'dev-1',
      forceAccountId: 'acc-b', // explicit force bypasses hysteresis
    })

    assert.equal(resolved.account.id, 'acc-b', 'forceAccountId should bypass hysteresis filter')
  } finally {
    Date.now = origDateNow
  }
})

// Scenario D: probe failure backoff — in-memory consecutiveProbeFailures grows, skips in next tick
test('scenario D: account with 4 probe failures is skipped due to exponential backoff', async () => {
  const now = Date.now()
  const intervalMs = appConfig.rateLimitProbeIntervalMs

  // acc-a: stale probe (2x interval ago) → eligible by staleness check
  // but will have consecutiveProbeFailures=4 set manually
  // backoffMs = min(intervalMs * 2^4, 3600000) = min(intervalMs*16, 3600000)
  // now - lastProbeAttemptAt = intervalMs*2 < backoffMs → should be skipped
  const probeAt = now - intervalMs * 2

  const { oauthService, store } = createService([
    buildAccount({
      id: 'acc-a',
      lastProbeAttemptAt: probeAt,
      lastRateLimitAt: null,
    }),
    buildAccount({
      id: 'acc-b',
      lastProbeAttemptAt: now - 60_000, // recently probed → NOT eligible
      lastRateLimitAt: null,
    }),
  ])

  // Verify acc-a is eligible by staleness check (would normally be probed)
  const targets = await oauthService.getAccountsForRateLimitProbe(now)
  assert.ok(targets.find((a) => a.id === 'acc-a'), 'acc-a must be eligible by staleness')

  // Simulate 4 accumulated probe failures in the refresher's in-memory map
  const { KeepAliveRefresher } = await import('./keepAliveRefresher.js')
  const refresher = new KeepAliveRefresher(oauthService)
  ;(refresher as unknown as { consecutiveProbeFailures: Map<string, number> })
    .consecutiveProbeFailures.set('acc-a', 4)

  // Run one tick (probeRateLimits won't be called for acc-a because it's in backoff)
  // acc-b is not eligible by staleness, so no probes happen at all → no network calls
  await (refresher as unknown as { tick(): Promise<void> }).tick()

  // acc-a's lastProbeAttemptAt in store must remain unchanged (it was skipped)
  const accA = (await store.getData()).accounts.find((a) => a.id === 'acc-a')
  assert.ok(accA)
  assert.equal(
    accA.lastProbeAttemptAt,
    probeAt,
    'lastProbeAttemptAt must not change when account is in backoff',
  )
})

// Scenario E: bug fix — re-enabling account resets probe backoff via lastProbeAttemptAt=null signal
test('scenario E: updateAccountSettings re-enable clears lastProbeAttemptAt, refresher resets backoff', async () => {
  const now = Date.now()

  const { oauthService, store } = createService([
    buildAccount({
      id: 'acc',
      schedulerState: 'auto_blocked',
      autoBlockedReason: 'rate_limit:rejected',
      lastProbeAttemptAt: now - 60_000, // had a recent probe attempt
    }),
  ])

  // Re-enable via updateAccountSettings
  await oauthService.updateAccountSettings('acc', { schedulerState: 'enabled' })

  // lastProbeAttemptAt must be cleared to null (signals refresher to reset backoff)
  const acc = (await store.getData()).accounts.find((a) => a.id === 'acc')
  assert.ok(acc)
  assert.equal(acc.lastProbeAttemptAt, null, 'lastProbeAttemptAt must be null after re-enable')

  // Verify that refresher with failures=3 sees null and resets the count
  const { KeepAliveRefresher } = await import('./keepAliveRefresher.js')
  const refresher = new KeepAliveRefresher(oauthService)
  const failuresMap = (refresher as unknown as { consecutiveProbeFailures: Map<string, number> })
    .consecutiveProbeFailures
  failuresMap.set('acc', 3)

  // Account is stale by staleness check: lastProbeAttemptAt=null → max(0,0)=0 → now-0 > interval
  const targets = await oauthService.getAccountsForRateLimitProbe(now)
  assert.ok(targets.find((a) => a.id === 'acc'), 'acc must be eligible (null lastProbeAttemptAt)')

  // Running tick: backoff check sees lastProbeAttemptAt==null → resets failures, proceeds to probe
  // But probeRateLimits would make a real call — guard by setting expiresAt expired so auth fails
  // Instead, just verify the failures map is cleared during the tick flow by checking store state after
  // Since the account's auth token is fake, probeRateLimits will either throw or return an error,
  // which lands in the catch block → increments failures back to 1.
  // The key assertion is that the RESET happened (failures went 3→0→1, not stayed at 3).
  await (refresher as unknown as { tick(): Promise<void> }).tick()

  // After reset+probe attempt (which fails), failures should be 1, not 3
  const failuresAfter = failuresMap.get('acc') ?? 0
  assert.ok(failuresAfter < 3, `failures should have reset (was 3, got ${failuresAfter})`)
})

// Scenario F: all dirty state fields cleared on re-enable via updateAccountSettings
test('scenario F: all fault fields cleared when transitioning from auto_blocked to enabled', async () => {
  const now = Date.now()
  const { oauthService } = createService([
    buildAccount({
      id: 'acc',
      schedulerState: 'auto_blocked',
      autoBlockedReason: 'rate_limit:rejected',
      cooldownUntil: now + 60_000,
      lastRateLimitStatus: 'rate_limited',
      lastRateLimit5hUtilization: 0.95,
      lastProbeAttemptAt: now - 5000,
    }),
  ])

  const updated = await oauthService.updateAccountSettings('acc', { schedulerState: 'enabled' })
  assert.ok(updated)
  assert.equal(updated.schedulerState, 'enabled')
  assert.equal(updated.cooldownUntil, null, 'cooldownUntil must be cleared')
  assert.equal(updated.autoBlockedReason, null, 'autoBlockedReason must be cleared')
  assert.equal(updated.lastProbeAttemptAt, null, 'lastProbeAttemptAt must be cleared (probe backoff signal)')
  // lastRateLimitStatus and 5h util are preserved (they reflect real quota data, not fault state)
  assert.equal(updated.lastRateLimitStatus, 'rate_limited', 'quota data is preserved')
})

// Scenario G: concurrent: real request (T1) wins over stale probe (T0 < T1)
test('scenario G: real-traffic snapshot wins when concurrent probe arrives with older observedAt', async () => {
  const t = Date.parse('2026-04-13T00:00:00.000Z')

  const { oauthService } = createService([
    buildAccount({ id: 'acc', lastRateLimitStatus: null }),
  ])

  // Real-traffic data arrives first (T1 = t)
  await oauthService.recordRateLimitSnapshot({
    accountId: 'acc',
    status: 'allowed',
    fiveHourUtilization: 0.5,
    sevenDayUtilization: 0.2,
    resetTimestamp: null,
    observedAt: t,
  })

  // Slow probe completes later but has older observedAt (T0 = t - 2000)
  await oauthService.recordRateLimitSnapshot({
    accountId: 'acc',
    status: 'rate_limited',
    fiveHourUtilization: 0.99,
    sevenDayUtilization: 0.9,
    resetTimestamp: null,
    observedAt: t - 2000, // older than real-traffic snapshot → must be rejected
  })

  const account = await oauthService.getAccount('acc')
  assert.ok(account)
  assert.equal(account.lastRateLimitStatus, 'allowed', 'real-traffic data must win over stale probe')
  assert.equal(account.lastRateLimit5hUtilization, 0.5)
})
