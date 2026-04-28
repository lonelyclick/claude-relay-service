import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoredAccount } from '../types.js'
import { getKeepAliveRefreshReason } from './keepAlive.js'

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
    proxyUrl: input.proxyUrl ?? 'http://127.0.0.1:10810',
    bodyTemplatePath: input.bodyTemplatePath ?? null,
    vmFingerprintTemplatePath: input.vmFingerprintTemplatePath ?? null,
    deviceId: input.deviceId ?? 'device-id',
    apiBaseUrl: input.apiBaseUrl ?? null,
    modelName: input.modelName ?? null,
    modelTierMap: null,
    loginPassword: input.loginPassword ?? null,
  }
}

test('getKeepAliveRefreshReason returns expiring_soon before token expiry', () => {
  const now = Date.parse('2026-04-13T00:00:00.000Z')
  const account = buildAccount({
    id: 'expiring',
    expiresAt: now + 5 * 60 * 1000,
  })

  assert.equal(
    getKeepAliveRefreshReason(account, now, {
      refreshBeforeMs: 15 * 60 * 1000,
      forceRefreshMs: 6 * 60 * 60 * 1000,
    }),
    'expiring_soon',
  )
})

test('getKeepAliveRefreshReason returns stale for long-idle paused account', () => {
  const now = Date.parse('2026-04-13T18:00:00.000Z')
  const account = buildAccount({
    id: 'paused',
    schedulerEnabled: false,
    schedulerState: 'paused',
    expiresAt: null,
    lastRefreshAt: '2026-04-13T08:00:00.000Z',
  })

  assert.equal(
    getKeepAliveRefreshReason(account, now, {
      refreshBeforeMs: 15 * 60 * 1000,
      forceRefreshMs: 6 * 60 * 60 * 1000,
    }),
    'stale',
  )
})

test('getKeepAliveRefreshReason skips revoked accounts and accounts without refresh token', () => {
  const now = Date.parse('2026-04-13T00:00:00.000Z')
  assert.equal(
    getKeepAliveRefreshReason(
      buildAccount({
        id: 'revoked',
        isActive: false,
        status: 'revoked',
        expiresAt: now + 1_000,
      }),
      now,
      {
        refreshBeforeMs: 15 * 60 * 1000,
        forceRefreshMs: 6 * 60 * 60 * 1000,
      },
    ),
    null,
  )
  assert.equal(
    getKeepAliveRefreshReason(
      buildAccount({
        id: 'no-refresh',
        refreshToken: null,
        expiresAt: now + 1_000,
      }),
      now,
      {
        refreshBeforeMs: 15 * 60 * 1000,
        forceRefreshMs: 6 * 60 * 60 * 1000,
      },
    ),
    null,
  )
})
