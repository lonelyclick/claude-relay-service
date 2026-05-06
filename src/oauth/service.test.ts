import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
    lastSelectedAt: input.lastSelectedAt ?? null,
    lastUsedAt: input.lastUsedAt ?? null,
    lastRefreshAt: input.lastRefreshAt ?? null,
    lastFailureAt: input.lastFailureAt ?? null,
    cooldownUntil: input.cooldownUntil ?? null,
    lastError: input.lastError ?? null,
    accessToken: input.accessToken === undefined ? 'access-token' : input.accessToken,
    refreshToken: input.refreshToken === undefined ? 'refresh-token' : input.refreshToken,
    expiresAt: input.expiresAt ?? null,
    scopes: input.scopes ?? ['user:inference'],
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
    warmupEnabled: input.warmupEnabled,
    warmupPolicyId: input.warmupPolicyId,
    accountCreatedAt: input.accountCreatedAt ?? null,
    subscriptionCreatedAt: input.subscriptionCreatedAt ?? null,
    rawProfile: input.rawProfile ?? null,
    roles: input.roles ?? null,
    routingGroupId: input.routingGroupId ?? input.group ?? null,
    group: input.group ?? input.routingGroupId ?? null,
    maxSessions: input.maxSessions ?? 5,
    weight: input.weight ?? 1,
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
    proxyUrl: input.proxyUrl !== undefined ? input.proxyUrl : 'http://127.0.0.1:10810',
    bodyTemplatePath: input.bodyTemplatePath ?? null,
    vmFingerprintTemplatePath: input.vmFingerprintTemplatePath ?? null,
    deviceId: input.deviceId ?? 'device-id',
    apiBaseUrl: input.apiBaseUrl ?? null,
    modelName: input.modelName ?? null,
    modelTierMap: null,
    modelMap: null,
    loginPassword: input.loginPassword ?? null,
  }
}

function createService(
  accounts: StoredAccount[],
  userStore: MemoryUserStore | null = null,
): {
  oauthService: OAuthService
  store: MemoryTokenStore
  userStore: MemoryUserStore | null
} {
  const storeData: TokenStoreData = {
    version: 3,
    accounts,
    stickySessions: [],
    proxies: [],
    routingGroups: [],
  }
  const store = new MemoryTokenStore(storeData)
  const scheduler = new AccountScheduler(
    new AccountHealthTracker({
      windowMs: 5 * 60 * 1000,
      errorThreshold: 10,
    }),
    { defaultMaxSessions: 5, maxSessionOverflow: 1 },
  )
  return {
    oauthService: new OAuthService(
      store,
      scheduler,
      new FingerprintCache(),
      (userStore ?? null) as never,
    ),
    store,
    userStore,
  }
}

function hashSessionKey(sessionKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`claude-oauth-relay:${sessionKey}`)
    .digest('hex')
}

test('OAuthService.markAccountTerminalFailure marks account as banned for retained analysis', async () => {
  const { oauthService } = createService([buildAccount({ id: 'account-banned' })])

  await oauthService.markAccountTerminalFailure('account-banned', 'account_disabled_organization')

  const stored = await oauthService.getAccount('account-banned')
  assert.ok(stored)
  assert.equal(stored?.isActive, false)
  assert.equal(stored?.status, 'banned')
  assert.equal(stored?.schedulerState, 'paused')
  assert.equal(stored?.autoBlockedReason, 'account_disabled_organization')
  assert.equal(stored?.lastError, 'account_disabled_organization')
})

test('OAuthService.createOpenAICompatibleAccount stores the requested group', async () => {
  const { oauthService } = createService([])

  const created = await oauthService.createOpenAICompatibleAccount({
    apiKey: 'sk-test-openai-compatible',
    apiBaseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4.1',
    label: 'grouped-openai',
    group: 'team-a',
  })

  assert.equal(created.routingGroupId, 'team-a')
  assert.equal(created.group, 'team-a')

  const stored = await oauthService.getAccount(created.id)
  assert.ok(stored)
  assert.equal(stored.routingGroupId, 'team-a')
  assert.equal(stored.group, 'team-a')

  const routingGroups = await oauthService.listRoutingGroups()
  assert.deepEqual(
    routingGroups.map((group) => group.id),
    ['team-a'],
  )
})

test('OAuthService.createSimpleAccount updates group for an existing email account', async () => {
  const { oauthService } = createService([])

  await oauthService.createSimpleAccount({
    email: 'grouped@example.com',
    label: 'first',
    group: 'team-a',
  })
  const updated = await oauthService.createSimpleAccount({
    email: 'grouped@example.com',
    label: 'second',
    group: 'team-b',
  })

  assert.equal(updated.routingGroupId, 'team-b')
  assert.equal(updated.group, 'team-b')

  const stored = await oauthService.getAccount('claude-official:email:grouped@example.com')
  assert.ok(stored)
  assert.equal(stored.routingGroupId, 'team-b')
  assert.equal(stored.group, 'team-b')
  assert.equal(stored.label, 'second')
})

test('OAuthService create/update/delete routing groups through the registry', async () => {
  const { oauthService } = createService([])

  const created = await oauthService.createRoutingGroup({
    id: 'team-a',
    name: 'Team A',
    description: 'primary pool',
  })
  assert.equal(created.id, 'team-a')
  assert.equal(created.name, 'Team A')
  assert.equal(created.description, 'primary pool')
  assert.equal(created.isActive, true)

  const updated = await oauthService.updateRoutingGroup('team-a', {
    name: 'Team Alpha',
    description: 'updated pool',
    isActive: false,
  })
  assert.ok(updated)
  assert.equal(updated?.name, 'Team Alpha')
  assert.equal(updated?.description, 'updated pool')
  assert.equal(updated?.isActive, false)

  const deleted = await oauthService.deleteRoutingGroup('team-a')
  assert.ok(deleted)
  assert.equal(deleted?.id, 'team-a')
  assert.equal(await oauthService.getRoutingGroup('team-a'), null)
})

test('OAuthService.selectAccount rejects disabled routing groups', async () => {
  const { oauthService } = createService([
    buildAccount({
      id: 'grouped-account',
      group: 'team-a',
    }),
  ])

  await oauthService.ensureRoutingGroupExists('team-a')
  await oauthService.updateRoutingGroup('team-a', { isActive: false })

  await assert.rejects(
    oauthService.selectAccount({ routingGroupId: 'team-a' }),
    /Routing group is disabled: team-a/,
  )
})

test('OAuthService.selectAccount includes blocked-reason summary when no accounts are available', async () => {
  const originalDateNow = Date.now
  const now = Date.parse('2026-04-15T16:00:00.000Z')
  Date.now = () => now

  try {
    const { oauthService } = createService([
      buildAccount({ id: 'inactive-account', isActive: false }),
      buildAccount({ id: 'cooldown-a', cooldownUntil: now + 60_000 }),
      buildAccount({ id: 'cooldown-b', cooldownUntil: now + 120_000 }),
    ])

    await assert.rejects(
      oauthService.selectAccount({ provider: 'claude-official' }),
      /No available OAuth accounts .*blocked=cooldown=2,inactive=1.*inactive-account=inactive.*cooldown-a=cooldown/,
    )
  } finally {
    Date.now = originalDateNow
  }
})

test('OAuthService.recordRateLimitSnapshot auto-blocks and restores scheduler state', async () => {
  const originalDateNow = Date.now
  const now = Date.parse('2026-04-13T00:00:00.000Z')
  Date.now = () => now

  try {
  const { oauthService } = createService([
    buildAccount({ id: 'account-1' }),
  ])

  await oauthService.recordRateLimitSnapshot({
    accountId: 'account-1',
    status: 'rejected',
    fiveHourUtilization: 1,
    sevenDayUtilization: 1,
    resetTimestamp: 1776074400,
  })

  let account = await oauthService.getAccount('account-1')
  assert.ok(account)
  assert.equal(account.schedulerState, 'auto_blocked')
  assert.equal(account.autoBlockedReason, 'rate_limit:rejected')
  const blockedUntil = account.autoBlockedUntil ?? 0
  assert.ok(blockedUntil >= now + 15 * 60 * 1000)

  await oauthService.recordRateLimitSnapshot({
    accountId: 'account-1',
    status: 'allowed',
    fiveHourUtilization: 0.1,
    sevenDayUtilization: 0.2,
    resetTimestamp: 1776078000,
  })

  account = await oauthService.getAccount('account-1')
  assert.ok(account)
  assert.equal(account.schedulerState, 'auto_blocked')
  assert.equal(account.autoBlockedReason, 'rate_limit:rejected')

  Date.now = () => blockedUntil + 1
  account = await oauthService.getAccount('account-1')
  assert.ok(account)
  assert.equal(account.schedulerState, 'enabled')
  assert.equal(account.autoBlockedReason, null)
  assert.equal(account.lastRateLimitStatus, 'allowed')

  const resolved = await oauthService.selectAccount({})
  assert.equal(resolved.account.id, 'account-1')
  } finally {
    Date.now = originalDateNow
  }
})

test('OAuthService releases legacy rate-limit auto-blocks without a stored deadline', async () => {
  const originalDateNow = Date.now
  const now = Date.parse('2026-04-13T00:00:00.000Z')
  Date.now = () => now

  try {
    const { oauthService } = createService([
      buildAccount({
        id: 'legacy-blocked',
        schedulerState: 'auto_blocked',
        autoBlockedReason: 'rate_limit:rejected',
        autoBlockedUntil: null,
        lastRateLimitStatus: 'rejected',
        lastRateLimitReset: null,
        lastRateLimitAt: null,
    lastProbeAttemptAt: null,
      }),
    ])

    const account = await oauthService.getAccount('legacy-blocked')
    assert.ok(account)
    assert.equal(account.schedulerState, 'enabled')
    assert.equal(account.autoBlockedReason, null)

    const resolved = await oauthService.selectAccount({})
    assert.equal(resolved.account.id, 'legacy-blocked')
  } finally {
    Date.now = originalDateNow
  }
})

test('OAuthService.recordRateLimitSnapshot keeps disabled accounts paused', async () => {
  const { oauthService } = createService([
    buildAccount({
      id: 'account-1',
      schedulerEnabled: false,
      schedulerState: 'paused',
    }),
  ])

  await oauthService.recordRateLimitSnapshot({
    accountId: 'account-1',
    status: 'rejected',
    fiveHourUtilization: 0.6,
    sevenDayUtilization: 0.9,
    resetTimestamp: 1776074400,
  })

  const account = await oauthService.getAccount('account-1')
  assert.ok(account)
  assert.equal(account.schedulerState, 'paused')
  assert.equal(account.autoBlockedReason, 'rate_limit:rejected')
})

test('OAuthService.recordRateLimitSnapshot precomputes handoff state for blocked session routes', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'blocked-session',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    accountId: 'account-a',
  })

  const { oauthService, store } = createService([
    buildAccount({ id: 'account-a' }),
    buildAccount({ id: 'account-b' }),
  ], userStore)

  await store.updateData((current) => ({
    data: {
      ...current,
      stickySessions: [
        {
          sessionHash: hashSessionKey('blocked-session'),
          accountId: 'account-a',
          primaryAccountId: 'account-a',
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
      ],
    },
    result: undefined,
  }))

  await oauthService.recordRateLimitSnapshot({
    accountId: 'account-a',
    status: 'rejected',
    fiveHourUtilization: 1,
    sevenDayUtilization: 1,
    resetTimestamp: 1776074400,
  })

  const preparedRoute = await userStore.getSessionRoute('blocked-session')
  assert.ok(preparedRoute)
  assert.equal(preparedRoute?.lastHandoffReason, 'rate_limit:rejected')
  assert.match(preparedRoute?.pendingHandoffSummary ?? '', /压缩背景/)

  const storeData = await store.getData()
  assert.equal(storeData.stickySessions.length, 0)

  const resolved = await oauthService.selectAccount({
    sessionKey: 'blocked-session',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    currentRequestBodyPreview: '{"messages":[{"role":"user","content":"continue"}]}',
  })

  assert.equal(resolved.account.id, 'account-b')
  assert.equal(
    resolved.handoffSummary,
    preparedRoute?.pendingHandoffSummary ?? null,
  )

  const [handoff] = await userStore.listSessionHandoffs()
  assert.ok(handoff)
  assert.equal(handoff.fromAccountId, 'account-a')
  assert.equal(handoff.toAccountId, 'account-b')
  assert.equal(handoff.summary, preparedRoute?.pendingHandoffSummary)
})

test('OAuthService.selectAccount migrates an unavailable session route and returns handoff metadata', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'session-1',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    accountId: 'account-a',
  })

  const { oauthService } = createService([
    buildAccount({
      id: 'account-a',
      schedulerState: 'auto_blocked',
      autoBlockedReason: 'rate_limit:rejected',
      autoBlockedUntil: Date.now() + 60_000,
      lastRateLimitStatus: 'rejected',
    }),
    buildAccount({
      id: 'account-b',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.1,
      lastRateLimit7dUtilization: 0.1,
    }),
  ], userStore)

  const resolved = await oauthService.selectAccount({
    sessionKey: 'session-1',
    userId: 'user-1',
    currentRequestBodyPreview: '{"messages":[{"role":"user","content":"continue"}]}',
  })

  assert.equal(resolved.account.id, 'account-b')
  assert.ok(resolved.sessionRoute)
  assert.equal(resolved.sessionRoute?.generation, 2)
  assert.equal(resolved.sessionRoute?.accountId, 'account-b')
  assert.match(resolved.handoffSummary ?? '', /压缩背景/)
  assert.doesNotMatch(resolved.handoffSummary ?? '', /account-a/)
  assert.equal(resolved.handoffReason, 'rate_limit:rejected')

  const handoffs = await userStore.listSessionHandoffs()
  assert.equal(handoffs.length, 1)
  assert.equal(handoffs[0].fromAccountId, 'account-a')
  assert.equal(handoffs[0].toAccountId, 'account-b')
  assert.equal(handoffs[0].reason, 'rate_limit:rejected')
})

test('OAuthService.selectAccount reuses current route when soft migration has no replacement account', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'session-soft-fallback',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    accountId: 'account-a',
  })

  const { oauthService } = createService([
    buildAccount({
      id: 'account-a',
      subscriptionType: 'pro',
      lastRateLimitStatus: 'allowed_warning',
      lastRateLimit5hUtilization: 0.9,
      lastRateLimit7dUtilization: 0.2,
    }),
    buildAccount({
      id: 'account-b',
      schedulerState: 'paused',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.1,
      lastRateLimit7dUtilization: 0.1,
    }),
  ], userStore)

  const resolved = await oauthService.selectAccount({
    sessionKey: 'session-soft-fallback',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    currentRequestBodyPreview: '{"messages":[{"role":"user","content":"continue"}]}',
  })

  assert.equal(resolved.account.id, 'account-a')
  assert.ok(resolved.sessionRoute)
  assert.equal(resolved.sessionRoute?.accountId, 'account-a')
  assert.equal(resolved.sessionRoute?.generation, 1)
  assert.equal(resolved.handoffSummary, null)
  assert.equal(resolved.handoffReason, null)

  const handoffs = await userStore.listSessionHandoffs()
  assert.equal(handoffs.length, 0)
})

test('OAuthService.selectAccount migrates a soft-guarded session route when a replacement account exists', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'session-soft-migrate',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    accountId: 'account-a',
  })

  const { oauthService } = createService([
    buildAccount({
      id: 'account-a',
      subscriptionType: 'pro',
      lastRateLimitStatus: 'allowed_warning',
      lastRateLimit5hUtilization: 0.9,
      lastRateLimit7dUtilization: 0.2,
    }),
    buildAccount({
      id: 'account-b',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.1,
      lastRateLimit7dUtilization: 0.1,
    }),
  ], userStore)

  const resolved = await oauthService.selectAccount({
    sessionKey: 'session-soft-migrate',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    currentRequestBodyPreview: '{"messages":[{"role":"user","content":"continue"}]}',
  })

  assert.equal(resolved.account.id, 'account-b')
  assert.ok(resolved.sessionRoute)
  assert.equal(resolved.sessionRoute?.accountId, 'account-b')
  assert.equal(resolved.sessionRoute?.generation, 2)
  assert.match(resolved.handoffSummary ?? '', /压缩背景/)
  assert.equal(resolved.handoffReason, 'predicted_5h_exhaustion')

  const [handoff] = await userStore.listSessionHandoffs()
  assert.ok(handoff)
  assert.equal(handoff.fromAccountId, 'account-a')
  assert.equal(handoff.toAccountId, 'account-b')
  assert.equal(handoff.reason, 'predicted_5h_exhaustion')
})

test('OAuthService.selectAccount blocks session migration when routing guard budget is exceeded', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'session-guarded',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    accountId: 'account-a',
  })
  userStore.setRoutingGuardSnapshotOverride({
    userRecentRequests: appConfig.routingUserMaxRequestsPerWindow,
  })

  const { oauthService } = createService([
    buildAccount({
      id: 'account-a',
      schedulerState: 'auto_blocked',
      autoBlockedReason: 'rate_limit:rejected',
      autoBlockedUntil: Date.now() + 60_000,
      lastRateLimitStatus: 'rejected',
    }),
    buildAccount({
      id: 'account-b',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.1,
      lastRateLimit7dUtilization: 0.1,
    }),
  ], userStore)

  await assert.rejects(
    oauthService.selectAccount({
      sessionKey: 'session-guarded',
      userId: 'user-1',
      clientDeviceId: 'device-1',
      currentRequestBodyPreview: '{"messages":[{"role":"user","content":"continue"}]}',
    }),
    /request budget/i,
  )

  const route = await userStore.getSessionRoute('session-guarded')
  assert.ok(route)
  assert.equal(route?.accountId, 'account-a')
  assert.equal(route?.generation, 1)
})

test('OAuthService.selectAccount uses client device affinity as a scheduler hint for new sessions', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'existing-session',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    accountId: 'account-a',
  })
  await userStore.noteSessionRouteUsage({
    sessionKey: 'existing-session',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    accountId: 'account-a',
  })

  const { oauthService } = createService([
    buildAccount({
      id: 'account-a',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.2,
      lastRateLimit7dUtilization: 0.2,
    }),
    buildAccount({
      id: 'account-b',
      lastRateLimitStatus: 'allowed',
      lastRateLimit5hUtilization: 0.2,
      lastRateLimit7dUtilization: 0.2,
    }),
  ], userStore)

  const resolved = await oauthService.selectAccount({
    sessionKey: 'new-session',
    userId: 'user-1',
    clientDeviceId: 'device-1',
    currentRequestBodyPreview: '{"messages":[{"role":"user","content":"hello"}]}',
  })

  assert.equal(resolved.account.id, 'account-a')
  assert.equal(resolved.sessionRoute?.accountId, 'account-a')
  assert.equal(resolved.sessionRoute?.clientDeviceId, 'device-1')
})

test('OAuthService.selectAccount blocks new sessions when relay user exceeds active session limit', async () => {
  const userStore = new MemoryUserStore()
  for (let index = 0; index < appConfig.routingUserMaxActiveSessions; index += 1) {
    await userStore.ensureSessionRoute({
      sessionKey: `session-${index}`,
      userId: 'user-1',
      clientDeviceId: `device-${index}`,
      accountId: 'account-a',
    })
  }

  const { oauthService } = createService([
    buildAccount({
      id: 'account-a',
      maxSessions: appConfig.routingUserMaxActiveSessions + 1,
    }),
  ], userStore)

  await assert.rejects(
    oauthService.selectAccount({
      sessionKey: 'new-session',
      userId: 'user-1',
      clientDeviceId: 'device-fresh',
    }),
    /active sessions/,
  )
})

test('OAuthService.selectAccount blocks new sessions when client device exceeds active session limit', async () => {
  const userStore = new MemoryUserStore()
  for (let index = 0; index < appConfig.routingDeviceMaxActiveSessions; index += 1) {
    await userStore.ensureSessionRoute({
      sessionKey: `session-${index}`,
      userId: 'user-1',
      clientDeviceId: 'device-1',
      accountId: 'account-a',
    })
  }

  const { oauthService } = createService([
    buildAccount({
      id: 'account-a',
      maxSessions: appConfig.routingDeviceMaxActiveSessions + 1,
    }),
  ], userStore)

  await assert.rejects(
    oauthService.selectAccount({
      sessionKey: 'new-session',
      userId: 'user-1',
      clientDeviceId: 'device-1',
    }),
    new RegExp(
      `Client device already has ${appConfig.routingDeviceMaxActiveSessions} active sessions`,
    ),
  )
})

test('OAuthService.selectAccount blocks new sessions when relay user exceeds recent request budget', async () => {
  const userStore = new MemoryUserStore()
  userStore.setRoutingGuardSnapshotOverride({
    userRecentRequests: appConfig.routingUserMaxRequestsPerWindow,
  })

  const { oauthService } = createService([buildAccount({ id: 'account-a' })], userStore)

  await assert.rejects(
    oauthService.selectAccount({
      sessionKey: 'new-session',
      userId: 'user-1',
    }),
    /recent request budget/,
  )
})

test('OAuthService.selectAccount blocks new sessions when client device exceeds recent token budget', async () => {
  const userStore = new MemoryUserStore()
  userStore.setRoutingGuardSnapshotOverride({
    clientDeviceRecentTokens: appConfig.routingDeviceMaxTokensPerWindow,
  })

  const { oauthService } = createService([buildAccount({ id: 'account-a' })], userStore)

  await assert.rejects(
    oauthService.selectAccount({
      sessionKey: 'new-session',
      userId: 'user-1',
      clientDeviceId: 'device-1',
    }),
    /recent token budget/,
  )
})

test('OAuthService.selectAccount lets OpenAI Codex exceed local maxSessions when quota remains', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'existing-openai-session',
    accountId: 'openai-full',
  })
  const { oauthService } = createService([
    buildAccount({
      id: 'openai-full',
      provider: 'openai-codex',
      protocol: 'openai',
      maxSessions: 1,
      lastRateLimit5hUtilization: 0.2,
      lastRateLimit7dUtilization: 0.2,
    }),
  ], userStore)

  const resolved = await oauthService.selectAccount({
    provider: 'openai-codex',
    sessionKey: 'new-openai-session',
  })

  assert.equal(resolved.account.id, 'openai-full')
})

test('OAuthService.selectAccount keeps Claude maxSessions as a hard new-session cap', async () => {
  const userStore = new MemoryUserStore()
  await userStore.ensureSessionRoute({
    sessionKey: 'existing-claude-session',
    accountId: 'claude-full',
  })
  const { oauthService } = createService([
    buildAccount({
      id: 'claude-full',
      provider: 'claude-official',
      protocol: 'claude',
      maxSessions: 1,
    }),
  ], userStore)

  await assert.rejects(
    oauthService.selectAccount({
      provider: 'claude-official',
      sessionKey: 'new-claude-session',
    }),
    /at capacity/i,
  )
})

test('OAuthService.getSchedulerStats exposes routing guard limits and hot users/devices', async () => {
  const userStore = new MemoryUserStore()
  userStore.setRoutingGuardUserStats([
    {
      userId: 'user-1',
      activeSessions: 6,
      recentRequests: 30,
      recentTokens: 600_000,
    },
  ])
  userStore.setRoutingGuardDeviceStats([
    {
      userId: 'user-1',
      clientDeviceId: 'device-1',
      activeSessions: 2,
      recentRequests: 10,
      recentTokens: 200_000,
    },
  ])

  const { oauthService } = createService([buildAccount({ id: 'account-a' })], userStore)
  const stats = await oauthService.getSchedulerStats()

  assert.equal(stats.routingGuard.windowMs, appConfig.routingBudgetWindowMs)
  assert.equal(stats.routingGuard.limits.userRecentRequests, appConfig.routingUserMaxRequestsPerWindow)
  assert.equal(stats.routingGuard.users[0]?.userId, 'user-1')
  assert.equal(stats.routingGuard.users[0]?.requestUtilizationPercent, Math.round((30 / appConfig.routingUserMaxRequestsPerWindow) * 100))
  assert.equal(stats.routingGuard.devices[0]?.clientDeviceId, 'device-1')
  assert.equal(
    stats.routingGuard.devices[0]?.tokenUtilizationPercent,
    Math.min(
      100,
      Math.round((200_000 / appConfig.routingDeviceMaxTokensPerWindow) * 100),
    ),
  )
})

test('OAuthService.refreshDueAccountsForKeepAlive refreshes expiring paused accounts', async () => {
  const now = Date.parse('2026-04-13T00:00:00.000Z')
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/v1/oauth/token')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { grant_type?: string; refresh_token?: string }
      assert.equal(payload.grant_type, 'refresh_token')
      assert.equal(payload.refresh_token, 'refresh-token-paused')
      return new Response(
        JSON.stringify({
          access_token: 'access-token-refreshed',
          refresh_token: 'refresh-token-rotated',
          expires_in: 3600,
          scope: 'user:inference',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/api/oauth/profile')) {
      return new Response(
        JSON.stringify({
          account: {
            uuid: 'account-paused',
            email: 'paused@example.com',
            display_name: 'Paused Account',
          },
          organization: {
            uuid: 'org-account-paused',
            rate_limit_tier: 'default_claude_max_5x',
            organization_type: 'claude_max',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch url: ${url}`)
  }) as typeof globalThis.fetch

  try {
    const { oauthService } = createService([
      buildAccount({
        id: 'account-paused',
        schedulerEnabled: false,
        schedulerState: 'paused',
        accessToken: 'access-token-old',
        refreshToken: 'refresh-token-paused',
        expiresAt: now + 60_000,
        lastRefreshAt: '2026-04-12T12:00:00.000Z',
      }),
      buildAccount({
        id: 'account-revoked',
        isActive: false,
        status: 'revoked',
        refreshToken: 'refresh-token-revoked',
        expiresAt: now + 60_000,
      }),
    ])

    const results = await oauthService.refreshDueAccountsForKeepAlive(now)
    assert.equal(results.length, 1)
    assert.equal(results[0].accountId, 'account-paused')
    assert.equal(results[0].reason, 'expiring_soon')
    assert.equal(results[0].ok, true)

    const refreshed = await oauthService.getAccount('account-paused')
    assert.ok(refreshed)
    assert.equal(refreshed?.accessToken, 'access-token-refreshed')
    assert.equal(refreshed?.refreshToken, 'refresh-token-rotated')
    assert.equal(refreshed?.schedulerState, 'paused')
    assert.equal(refreshed?.schedulerEnabled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OAuthService.createAuthSession can generate an OpenAI Codex OAuth session', () => {
  const { oauthService } = createService([])

  const session = oauthService.createAuthSession({
    provider: 'openai-codex',
  })

  assert.equal(session.provider, 'openai-codex')
  assert.match(session.authUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
  assert.equal(session.redirectUri, appConfig.openAICodexOauthRedirectUrl)
  assert.ok(session.scopes.includes('offline_access'))
  assert.ok(session.scopes.includes('api.connectors.read'))
})

test('OAuthService.exchangeCode routes claude-official token exchange and profile fetch through the provided proxy', async () => {
  const originalFetch = globalThis.fetch
  const proxyUrl = 'http://127.0.0.1:10812'
  const profileUrl = new URL(appConfig.profileEndpoint, appConfig.anthropicApiBaseUrl).toString()
  const rolesUrl = new URL(appConfig.rolesEndpoint, appConfig.anthropicApiBaseUrl).toString()

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const dispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher

    if (url === appConfig.oauthTokenUrl) {
      assert.ok(dispatcher, 'expected authorization_code exchange to use proxy dispatcher')
      const payload = JSON.parse(String(init?.body ?? '{}')) as { grant_type?: string; code?: string }
      assert.equal(payload.grant_type, 'authorization_code')
      assert.equal(payload.code, 'fresh-code')
      return new Response(
        JSON.stringify({
          access_token: 'access-token-proxied',
          refresh_token: 'refresh-token-proxied',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === profileUrl) {
      assert.ok(dispatcher, 'expected profile fetch to use proxy dispatcher')
      return new Response(
        JSON.stringify({
          account: {
            uuid: 'account-proxied',
            email: 'proxied@example.com',
            display_name: 'Proxy User',
          },
          organization: {
            uuid: 'org-proxied',
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === rolesUrl) {
      assert.ok(dispatcher, 'expected roles fetch to use proxy dispatcher')
      return new Response(
        JSON.stringify({
          organization_name: 'Proxy Org',
          organization_role: 'admin',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    throw new Error(`unexpected fetch url: ${url}`)
  }) as typeof globalThis.fetch

  try {
    const { oauthService } = createService([])
    const session = oauthService.createAuthSession()
    const state = new URL(session.authUrl).searchParams.get('state')
    assert.ok(state)

    const created = await oauthService.exchangeCode({
      sessionId: session.sessionId,
      authorizationInput: `${appConfig.oauthManualRedirectUrl}?code=fresh-code&state=${state}`,
      label: 'Proxy OAuth',
      proxyUrl,
    })

    assert.equal(created.proxyUrl, proxyUrl)
    assert.equal(created.emailAddress, 'proxied@example.com')
    assert.equal(created.label, 'Proxy OAuth')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OAuthService.exchangeCode resolves a registered remote proxy URL to its localUrl', async () => {
  const originalFetch = globalThis.fetch
  const remoteProxyUrl = 'vless://proxy-node'
  const localProxyUrl = 'http://127.0.0.1:10812'
  const profileUrl = new URL(appConfig.profileEndpoint, appConfig.anthropicApiBaseUrl).toString()
  const rolesUrl = new URL(appConfig.rolesEndpoint, appConfig.anthropicApiBaseUrl).toString()

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const dispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher

    if (url === appConfig.oauthTokenUrl) {
      assert.ok(dispatcher, 'expected mapped local proxy dispatcher to be used')
      return new Response(
        JSON.stringify({
          access_token: 'access-token-mapped',
          refresh_token: 'refresh-token-mapped',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === profileUrl) {
      return new Response(
        JSON.stringify({
          account: {
            uuid: 'account-mapped',
            email: 'mapped@example.com',
            display_name: 'Mapped Proxy User',
          },
          organization: {
            uuid: 'org-mapped',
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === rolesUrl) {
      return new Response(
        JSON.stringify({
          organization_name: 'Mapped Proxy Org',
          organization_role: 'admin',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    throw new Error(`unexpected fetch url: ${url}`)
  }) as typeof globalThis.fetch

  try {
    const { oauthService, store } = createService([])
    await store.updateData((current) => ({
      data: {
        ...current,
        proxies: [
          ...current.proxies,
          {
            id: 'proxy-1',
            label: 'Mapped proxy',
            url: remoteProxyUrl,
            localUrl: localProxyUrl,
            createdAt: Date.now(),
          },
        ],
      },
      result: null,
    }))

    const session = oauthService.createAuthSession()
    const state = new URL(session.authUrl).searchParams.get('state')
    assert.ok(state)

    const created = await oauthService.exchangeCode({
      sessionId: session.sessionId,
      authorizationInput: `${appConfig.oauthManualRedirectUrl}?code=fresh-code&state=${state}`,
      proxyUrl: remoteProxyUrl,
    })

    assert.equal(created.proxyUrl, localProxyUrl)
    assert.equal(created.emailAddress, 'mapped@example.com')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OAuthService.selectAccount resolves a registered remote proxy URL to its localUrl', async () => {
  const remoteProxyUrl = 'socks5://remote-node.example:1080'
  const localProxyUrl = 'http://127.0.0.1:10812'
  const { oauthService, store } = createService([
    buildAccount({
      id: 'acct-remote-proxy',
      proxyUrl: remoteProxyUrl,
    }),
  ])

  await store.updateData((current) => ({
    data: {
      ...current,
      proxies: [
        ...current.proxies,
        {
          id: 'proxy-remote',
          label: 'Remote proxy',
          url: remoteProxyUrl,
          localUrl: localProxyUrl,
          createdAt: Date.now(),
        },
      ],
    },
    result: null,
  }))

  assert.equal(await oauthService.resolveProxyUrl(remoteProxyUrl), localProxyUrl)

  const resolved = await oauthService.selectAccount({
    forceAccountId: 'acct-remote-proxy',
  })

  assert.equal(resolved.account.proxyUrl, remoteProxyUrl)
  assert.equal(resolved.proxyUrl, localProxyUrl)
})

test('OAuthService.resolveProxyUrl accepts socks5 local proxy URLs', async () => {
  const { oauthService } = createService([])

  assert.equal(
    await oauthService.resolveProxyUrl('socks5://127.0.0.1:10810'),
    'socks5://127.0.0.1:10810',
  )
})

test('OAuthService.exchangeCode rejects unsupported proxy URLs with a clear error', async () => {
  const { oauthService } = createService([])
  const session = oauthService.createAuthSession()
  const state = new URL(session.authUrl).searchParams.get('state')
  assert.ok(state)

  await assert.rejects(
    () =>
      oauthService.exchangeCode({
        sessionId: session.sessionId,
        authorizationInput: `${appConfig.oauthManualRedirectUrl}?code=fresh-code&state=${state}`,
        proxyUrl: 'vless://127.0.0.1:10812',
      }),
    /Proxy URL must use http:\/\/, https:\/\/, or socks5:\/\//,
  )
})

test('OAuthService.exchangeCode keeps the OAuth session when proxy validation fails before exchange', async () => {
  const originalFetch = globalThis.fetch
  const profileUrl = new URL(appConfig.profileEndpoint, appConfig.anthropicApiBaseUrl).toString()
  const rolesUrl = new URL(appConfig.rolesEndpoint, appConfig.anthropicApiBaseUrl).toString()

  globalThis.fetch = (async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    if (url === appConfig.oauthTokenUrl) {
      return new Response(
        JSON.stringify({
          access_token: 'access-token-after-retry',
          refresh_token: 'refresh-token-after-retry',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === profileUrl) {
      return new Response(
        JSON.stringify({
          account: {
            uuid: 'account-retry',
            email: 'retry@example.com',
            display_name: 'Retry User',
          },
          organization: {
            uuid: 'org-retry',
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === rolesUrl) {
      return new Response(
        JSON.stringify({
          organization_name: 'Retry Org',
          organization_role: 'admin',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    throw new Error(`unexpected fetch url: ${url}`)
  }) as typeof globalThis.fetch

  try {
    const { oauthService } = createService([])
    const session = oauthService.createAuthSession()
    const state = new URL(session.authUrl).searchParams.get('state')
    assert.ok(state)

    await assert.rejects(
      () =>
        oauthService.exchangeCode({
          sessionId: session.sessionId,
          authorizationInput: `${appConfig.oauthManualRedirectUrl}?code=fresh-code&state=${state}`,
          proxyUrl: 'vless://unregistered-proxy',
        }),
      /Proxy URL must use http:\/\/, https:\/\/, or socks5:\/\//,
    )

    const created = await oauthService.exchangeCode({
      sessionId: session.sessionId,
      authorizationInput: `${appConfig.oauthManualRedirectUrl}?code=fresh-code&state=${state}`,
    })

    assert.equal(created.emailAddress, 'retry@example.com')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OAuthService.refreshAccount routes claude-official refresh through the stored proxy', async () => {
  const originalFetch = globalThis.fetch
  const proxyUrl = 'http://127.0.0.1:10812'
  const profileUrl = new URL(appConfig.profileEndpoint, appConfig.anthropicApiBaseUrl).toString()
  const rolesUrl = new URL(appConfig.rolesEndpoint, appConfig.anthropicApiBaseUrl).toString()

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const dispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher

    if (url === appConfig.oauthTokenUrl) {
      assert.ok(dispatcher, 'expected refresh_token exchange to use proxy dispatcher')
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        grant_type?: string
        refresh_token?: string
      }
      assert.equal(payload.grant_type, 'refresh_token')
      assert.equal(payload.refresh_token, 'refresh-token-old')
      return new Response(
        JSON.stringify({
          access_token: 'access-token-refreshed',
          refresh_token: 'refresh-token-rotated',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === profileUrl) {
      assert.ok(dispatcher, 'expected profile refresh fetch to use proxy dispatcher')
      return new Response(
        JSON.stringify({
          account: {
            uuid: 'account-refresh',
            email: 'refresh@example.com',
            display_name: 'Refresh User',
          },
          organization: {
            uuid: 'org-refresh',
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url === rolesUrl) {
      assert.ok(dispatcher, 'expected roles refresh fetch to use proxy dispatcher')
      return new Response(
        JSON.stringify({
          organization_name: 'Refresh Org',
          organization_role: 'admin',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    throw new Error(`unexpected fetch url: ${url}`)
  }) as typeof globalThis.fetch

  try {
    const { oauthService } = createService([
      buildAccount({
        id: 'account-proxy-refresh',
        accessToken: 'access-token-old',
        refreshToken: 'refresh-token-old',
        proxyUrl,
      }),
    ])

    const refreshed = await oauthService.refreshAccount('account-proxy-refresh')
    assert.equal(refreshed.accessToken, 'access-token-refreshed')
    assert.equal(refreshed.refreshToken, 'refresh-token-rotated')
    assert.equal(refreshed.proxyUrl, proxyUrl)
    assert.equal(refreshed.emailAddress, 'refresh@example.com')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OAuthService.refreshAccount refreshes openai-codex accounts via auth.openai.com token endpoint', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === `${appConfig.openAICodexOauthIssuer}/oauth/token`) {
      const body = String(init?.body ?? '')
      const params = new URLSearchParams(body)
      assert.equal(params.get('grant_type'), 'refresh_token')
      assert.equal(params.get('refresh_token'), 'codex-refresh-token')
      assert.equal(params.get('client_id'), appConfig.openAICodexOauthClientId)
      return new Response(
        JSON.stringify({
          access_token: 'codex-access-token-refreshed',
          refresh_token: 'codex-refresh-token-rotated',
          expires_in: 7200,
          id_token: `header.${Buffer.from(JSON.stringify({
            email: 'codex@example.com',
            'https://api.openai.com/auth': {
              chatgpt_plan_type: 'business',
              chatgpt_user_id: 'user-123',
              chatgpt_account_id: 'workspace-456',
            },
          })).toString('base64url')}.signature`,
          scope: 'openid profile email offline_access',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch url: ${url}`)
  }) as typeof globalThis.fetch

  try {
    const { oauthService } = createService([
      buildAccount({
        id: 'openai-codex:account-a',
        provider: 'openai-codex',
        protocol: 'openai',
        authMode: 'oauth',
        accessToken: 'codex-access-token-old',
        refreshToken: 'codex-refresh-token',
        emailAddress: 'old@example.com',
        organizationUuid: 'workspace-old',
        accountUuid: 'user-old',
        modelName: 'gpt-5-codex',
        apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
      }),
    ])

    const refreshed = await oauthService.refreshAccount('openai-codex:account-a')
    assert.equal(refreshed.provider, 'openai-codex')
    assert.equal(refreshed.protocol, 'openai')
    assert.equal(refreshed.accessToken, 'codex-access-token-refreshed')
    assert.equal(refreshed.refreshToken, 'codex-refresh-token-rotated')
    assert.equal(refreshed.emailAddress, 'codex@example.com')
    assert.equal(refreshed.organizationUuid, 'workspace-456')
    assert.equal(refreshed.accountUuid, 'user-123')
    assert.equal(refreshed.subscriptionType, 'business')
    assert.equal(refreshed.providerPlanTypeRaw, 'business')
    assert.equal(refreshed.modelName, 'gpt-5-codex')
    assert.equal(refreshed.apiBaseUrl, 'https://chatgpt.com/backend-api/codex')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OAuthService.selectAccount allows openai-codex accounts without proxy', async () => {
  const { oauthService } = createService([
    buildAccount({
      id: 'openai-codex:account-no-proxy',
      provider: 'openai-codex',
      protocol: 'openai',
      authMode: 'oauth',
      proxyUrl: null,
      apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
      modelName: 'gpt-5.4',
    }),
  ])

  const resolved = await oauthService.selectAccount({
    provider: 'openai-codex',
    forceAccountId: 'openai-codex:account-no-proxy',
    group: null,
  })

  assert.equal(resolved.account.id, 'openai-codex:account-no-proxy')
  assert.equal(resolved.proxyUrl, null)
})

test('OAuthService.selectAccount blocks heavy requests for explicit warmup-policy Claude accounts', async () => {
  const { oauthService } = createService([
    buildAccount({
      id: 'claude-warmup-heavy',
      provider: 'claude-official',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      accountCreatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      warmupEnabled: true,
      warmupPolicyId: 'a',
    }),
  ])

  await assert.rejects(
    oauthService.selectAccount({
      provider: 'claude-official',
      forceAccountId: 'claude-warmup-heavy',
      currentRequestBodyPreview: '{"cache_read_input_tokens":300000}',
    }),
    /warmup_preflight_block.*heavy_request=cache_read_preview_300000/,
  )

  const account = await oauthService.getAccount('claude-warmup-heavy')
  assert.ok(account)
  assert.equal(account.schedulerState, 'auto_blocked')
  assert.match(account.autoBlockedReason ?? '', /warmup_preflight_block/)
})

test('OAuthService.selectAccount applies default warmup limits to Claude accounts without explicit policy', async () => {
  const { oauthService } = createService([
    buildAccount({
      id: 'claude-default-warmup-heavy',
      provider: 'claude-official',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      accountCreatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      warmupPolicyId: undefined,
    }),
  ])

  await assert.rejects(
    oauthService.selectAccount({
      provider: 'claude-official',
      forceAccountId: 'claude-default-warmup-heavy',
      currentRequestBodyPreview: '{"cache_read_input_tokens":300000}',
    }),
    /warmup_preflight_block.*policy=a.*heavy_request=cache_read_preview_300000/,
  )

  const account = await oauthService.getAccount('claude-default-warmup-heavy')
  assert.ok(account)
  assert.equal(account.schedulerState, 'auto_blocked')
  assert.match(account.autoBlockedReason ?? '', /warmup_preflight_block/)
})

test('OAuthService.selectAccount allows Claude accounts with warmup explicitly disabled', async () => {
  const { oauthService } = createService([
    buildAccount({
      id: 'claude-warmup-disabled-heavy',
      provider: 'claude-official',
      warmupEnabled: false,
      warmupPolicyId: undefined,
    }),
  ])

  const resolved = await oauthService.selectAccount({
    provider: 'claude-official',
    forceAccountId: 'claude-warmup-disabled-heavy',
    currentRequestBodyPreview: '{"cache_read_input_tokens":300000}',
  })

  assert.equal(resolved.account.id, 'claude-warmup-disabled-heavy')
})
