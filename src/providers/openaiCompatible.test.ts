import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoredAccount } from '../types.js'
import {
  buildOpenAICompatibleChatCompletionsUrl,
  buildOpenAICompatibleEndpointUrl,
  planOpenAICompatibleModelRouting,
  resolveOpenAICompatibleTargetModel,
} from './openaiCompatible.js'

function buildAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: overrides.id ?? 'openai-compatible:test-account',
    provider: overrides.provider ?? 'openai-compatible',
    protocol: overrides.protocol ?? 'openai',
    authMode: overrides.authMode ?? 'api_key',
    label: overrides.label ?? 'test-openai',
    isActive: overrides.isActive ?? true,
    status: overrides.status ?? 'active',
    lastSelectedAt: overrides.lastSelectedAt ?? null,
    lastUsedAt: overrides.lastUsedAt ?? null,
    lastRefreshAt: overrides.lastRefreshAt ?? null,
    lastFailureAt: overrides.lastFailureAt ?? null,
    cooldownUntil: overrides.cooldownUntil ?? null,
    lastError: overrides.lastError ?? null,
    accessToken: overrides.accessToken ?? 'sk-test',
    refreshToken: overrides.refreshToken ?? null,
    expiresAt: overrides.expiresAt ?? null,
    scopes: overrides.scopes ?? [],
    createdAt: overrides.createdAt ?? '2026-04-14T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-14T00:00:00.000Z',
    subscriptionType: overrides.subscriptionType ?? null,
    rateLimitTier: overrides.rateLimitTier ?? null,
    accountUuid: overrides.accountUuid ?? null,
    organizationUuid: overrides.organizationUuid ?? null,
    emailAddress: overrides.emailAddress ?? null,
    displayName: overrides.displayName ?? 'gpt-4.1',
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
    apiBaseUrl: overrides.apiBaseUrl ?? 'https://api.openai.com/v1',
    modelName: 'modelName' in overrides ? overrides.modelName ?? null : 'gpt-4.1',
    modelTierMap: null,
    modelMap: 'modelMap' in overrides ? overrides.modelMap ?? null : null,
    loginPassword: overrides.loginPassword ?? null,
  }
}

test('buildOpenAICompatibleChatCompletionsUrl targets the native chat completions endpoint', () => {
  const account = buildAccount({
    apiBaseUrl: 'https://api.openai.com/v1',
  })

  const url = buildOpenAICompatibleChatCompletionsUrl(account)

  assert.equal(url.toString(), 'https://api.openai.com/v1/chat/completions')
})

test('buildOpenAICompatibleEndpointUrl forwards commercial gateway v1 endpoints', () => {
  const account = buildAccount({
    apiBaseUrl: 'https://api.openai.com/v1',
  })

  assert.equal(
    buildOpenAICompatibleEndpointUrl(account, '/v1/embeddings', '?trace=1').toString(),
    'https://api.openai.com/v1/embeddings?trace=1',
  )
  assert.equal(
    buildOpenAICompatibleEndpointUrl(account, '/v1/images/generations').toString(),
    'https://api.openai.com/v1/images/generations',
  )
  assert.equal(
    buildOpenAICompatibleEndpointUrl(account, '/v1/audio/transcriptions').toString(),
    'https://api.openai.com/v1/audio/transcriptions',
  )
  assert.equal(
    buildOpenAICompatibleEndpointUrl(account, '/v1/models/gpt-5').toString(),
    'https://api.openai.com/v1/models/gpt-5',
  )
})

test('buildOpenAICompatibleEndpointUrl rejects non-v1 endpoint', () => {
  const account = buildAccount()

  assert.throws(
    () => buildOpenAICompatibleEndpointUrl(account, '/admin/users'),
    /must start with \/v1\//,
  )
})

test('planOpenAICompatibleModelRouting honors modelMap exact match', () => {
  const account = buildAccount({
    modelName: 'mimo-v2.5-pro',
    modelMap: { 'gpt-5': 'mimo-v2.5-pro', 'gpt-4o-mini': 'mimo-v2.5' },
  })

  const route = planOpenAICompatibleModelRouting('gpt-4o-mini', account)
  assert.equal(route.targetModel, 'mimo-v2.5')
  assert.equal(route.mapHit, true)
  assert.equal(route.sourceModel, 'gpt-4o-mini')
})

test('planOpenAICompatibleModelRouting falls back to modelName when no map hit', () => {
  const account = buildAccount({
    modelName: 'mimo-v2.5-pro',
    modelMap: { 'gpt-5': 'mimo-v2.5-pro' },
  })

  const route = planOpenAICompatibleModelRouting('unknown-xyz', account)
  assert.equal(route.targetModel, 'mimo-v2.5-pro')
  assert.equal(route.mapHit, false)
})

test('planOpenAICompatibleModelRouting falls back to source when no map and no modelName', () => {
  const account = buildAccount({ modelName: null, modelMap: null })

  const route = planOpenAICompatibleModelRouting('gpt-5', account)
  assert.equal(route.targetModel, 'gpt-5')
  assert.equal(route.mapHit, false)
})

test('planOpenAICompatibleModelRouting handles null source model', () => {
  const account = buildAccount({ modelName: 'mimo-v2.5-pro', modelMap: { 'gpt-5': 'mimo-v2.5-pro' } })

  const route = planOpenAICompatibleModelRouting(null, account)
  assert.equal(route.targetModel, 'mimo-v2.5-pro')
  assert.equal(route.mapHit, false)
  assert.equal(route.sourceModel, null)
})

test('resolveOpenAICompatibleTargetModel returns mapped target', () => {
  const account = buildAccount({ modelMap: { 'gpt-5': 'mimo-v2.5-pro' } })
  assert.equal(resolveOpenAICompatibleTargetModel('gpt-5', account), 'mimo-v2.5-pro')
})

test('buildOpenAICompatibleChatCompletionsUrl requires apiBaseUrl', () => {
  const account = buildAccount({
    apiBaseUrl: '',
  })

  assert.throws(() => buildOpenAICompatibleChatCompletionsUrl(account), /missing apiBaseUrl/)
})
