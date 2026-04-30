import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoredAccount } from '../types.js'
import {
  buildOpenAICodexResponsesUrl,
  normalizeOpenAICodexApiBaseUrl,
  parseOpenAICodexTokenClaims,
} from './openaiCodex.js'

function buildAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: overrides.id ?? 'openai-codex:test-account',
    provider: overrides.provider ?? 'openai-codex',
    protocol: overrides.protocol ?? 'openai',
    authMode: overrides.authMode ?? 'oauth',
    label: overrides.label ?? 'test-codex',
    isActive: overrides.isActive ?? true,
    status: overrides.status ?? 'active',
    lastSelectedAt: overrides.lastSelectedAt ?? null,
    lastUsedAt: overrides.lastUsedAt ?? null,
    lastRefreshAt: overrides.lastRefreshAt ?? null,
    lastFailureAt: overrides.lastFailureAt ?? null,
    cooldownUntil: overrides.cooldownUntil ?? null,
    lastError: overrides.lastError ?? null,
    accessToken: overrides.accessToken ?? 'access-token',
    refreshToken: overrides.refreshToken ?? 'refresh-token',
    expiresAt: overrides.expiresAt ?? null,
    scopes: overrides.scopes ?? [],
    createdAt: overrides.createdAt ?? '2026-04-14T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-14T00:00:00.000Z',
    subscriptionType: overrides.subscriptionType ?? null,
    rateLimitTier: overrides.rateLimitTier ?? null,
    accountUuid: overrides.accountUuid ?? 'user-1',
    organizationUuid: overrides.organizationUuid ?? 'workspace-1',
    emailAddress: overrides.emailAddress ?? 'codex@example.com',
    displayName: overrides.displayName ?? 'codex@example.com',
    hasExtraUsageEnabled: overrides.hasExtraUsageEnabled ?? null,
    billingType: overrides.billingType ?? null,
    accountCreatedAt: overrides.accountCreatedAt ?? null,
    subscriptionCreatedAt: overrides.subscriptionCreatedAt ?? null,
    rawProfile: overrides.rawProfile ?? null,
    roles: overrides.roles ?? null,
    routingGroupId: overrides.routingGroupId ?? overrides.group ?? null,
    group: overrides.group ?? overrides.routingGroupId ?? null,
    maxSessions: overrides.maxSessions ?? null,
    weight: overrides.weight ?? null,
    schedulerEnabled: overrides.schedulerEnabled ?? true,
    schedulerState: overrides.schedulerState ?? 'enabled',
    autoBlockedReason: overrides.autoBlockedReason ?? null,
    autoBlockedUntil: overrides.autoBlockedUntil ?? null,
    lastRateLimitStatus: overrides.lastRateLimitStatus ?? null,
    lastRateLimit5hUtilization: overrides.lastRateLimit5hUtilization ?? null,
    lastRateLimit7dUtilization: overrides.lastRateLimit7dUtilization ?? null,
    lastRateLimitReset: overrides.lastRateLimitReset ?? null,
    lastRateLimitAt: overrides.lastRateLimitAt ?? null,
    lastProbeAttemptAt: null,
    proxyUrl: overrides.proxyUrl ?? 'http://127.0.0.1:10810',
    bodyTemplatePath: overrides.bodyTemplatePath ?? null,
    vmFingerprintTemplatePath: overrides.vmFingerprintTemplatePath ?? null,
    deviceId: overrides.deviceId ?? 'device-1',
    apiBaseUrl: overrides.apiBaseUrl ?? 'https://chatgpt.com/backend-api/codex',
    modelName: overrides.modelName ?? 'gpt-5-codex',
    modelTierMap: null,
    modelMap: null,
    loginPassword: overrides.loginPassword ?? null,
  }
}

test('buildOpenAICodexResponsesUrl normalizes legacy /v1 base URLs', () => {
  const account = buildAccount({
    apiBaseUrl: 'https://chatgpt.com/backend-api/codex/v1',
  })

  const url = buildOpenAICodexResponsesUrl(account)

  assert.equal(url.toString(), 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(
    normalizeOpenAICodexApiBaseUrl('https://chatgpt.com/backend-api/codex/v1'),
    'https://chatgpt.com/backend-api/codex',
  )
})

test('parseOpenAICodexTokenClaims reads ChatGPT auth claims from JWT payload', () => {
  const payload = Buffer.from(JSON.stringify({
    email: 'codex@example.com',
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'business',
      chatgpt_user_id: 'user-123',
      chatgpt_account_id: 'workspace-456',
    },
  })).toString('base64url')
  const token = `header.${payload}.signature`

  const claims = parseOpenAICodexTokenClaims(token)
  assert.equal(claims.emailAddress, 'codex@example.com')
  assert.equal(claims.chatgptPlanType, 'business')
  assert.equal(claims.chatgptUserId, 'user-123')
  assert.equal(claims.chatgptAccountId, 'workspace-456')
})
