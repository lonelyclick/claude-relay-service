import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoredAccount } from '../types.js'
import type { AccountRiskSnapshot } from './accountRiskStore.js'

function band(score: number): AccountRiskSnapshot['band'] {
  if (score >= 75) return 'critical'
  if (score >= 55) return 'cautious'
  if (score >= 30) return 'watch'
  return 'safe'
}

test('risk bands stay aligned with P0/P1 thresholds', () => {
  assert.equal(band(0), 'safe')
  assert.equal(band(30), 'watch')
  assert.equal(band(55), 'cautious')
  assert.equal(band(75), 'critical')
})

test('StoredAccount can carry cached risk score fields without token exposure', () => {
  const account = {
    id: 'claude-official:test',
    provider: 'claude-official',
    protocol: 'claude',
    authMode: 'oauth',
    label: 'test',
    isActive: true,
    status: 'active',
    lastSelectedAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    lastFailureAt: null,
    cooldownUntil: null,
    lastError: null,
    accessToken: 'secret',
    refreshToken: 'refresh',
    expiresAt: null,
    scopes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subscriptionType: 'max',
    rateLimitTier: null,
    accountUuid: 'acct',
    organizationUuid: 'org',
    emailAddress: 'user@example.com',
    displayName: 'User',
    hasExtraUsageEnabled: null,
    billingType: null,
    accountCreatedAt: null,
    subscriptionCreatedAt: null,
    rawProfile: null,
    roles: null,
    routingGroupId: null,
    group: null,
    maxSessions: null,
    weight: null,
    schedulerEnabled: true,
    schedulerState: 'enabled',
    autoBlockedReason: null,
    autoBlockedUntil: null,
    lastRateLimitStatus: null,
    lastRateLimit5hUtilization: null,
    lastRateLimit7dUtilization: null,
    lastRateLimitReset: null,
    lastRateLimitAt: null,
    lastProbeAttemptAt: null,
    proxyUrl: null,
    bodyTemplatePath: null,
    vmFingerprintTemplatePath: null,
    deviceId: null,
    apiBaseUrl: null,
    modelName: null,
    modelTierMap: null,
    modelMap: null,
    loginPassword: null,
  } satisfies StoredAccount

  assert.equal(account.provider, 'claude-official')
  assert.equal(account.accessToken, 'secret')
})
