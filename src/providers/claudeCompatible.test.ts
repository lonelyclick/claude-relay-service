import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoredAccount } from '../types.js'
import {
  buildClaudeCompatibleUpstreamUrl,
  classifyClaudeModelTier,
  extractClaudeCompatibleErrorMessage,
  isClaudeCompatibleAccount,
  resolveClaudeCompatibleTargetModel,
  rewriteClaudeCompatibleRequestBody,
} from './claudeCompatible.js'

function buildAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: overrides.id ?? 'claude-compatible:test-account',
    provider: overrides.provider ?? 'claude-compatible',
    protocol: overrides.protocol ?? 'claude',
    authMode: overrides.authMode ?? 'api_key',
    label: overrides.label ?? 'test-claude-compatible',
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
    displayName: overrides.displayName ?? 'deepseek-chat',
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
    proxyUrl: overrides.proxyUrl ?? null,
    bodyTemplatePath: overrides.bodyTemplatePath ?? null,
    vmFingerprintTemplatePath: overrides.vmFingerprintTemplatePath ?? null,
    deviceId: overrides.deviceId ?? 'device-1',
    apiBaseUrl: 'apiBaseUrl' in overrides ? overrides.apiBaseUrl ?? null : 'https://api.deepseek.com/anthropic',
    modelName: 'modelName' in overrides ? overrides.modelName ?? null : 'deepseek-chat',
    modelTierMap: 'modelTierMap' in overrides ? overrides.modelTierMap ?? null : null,
    modelMap: 'modelMap' in overrides ? overrides.modelMap ?? null : null,
    loginPassword: overrides.loginPassword ?? null,
  }
}

test('isClaudeCompatibleAccount detects provider', () => {
  assert.equal(isClaudeCompatibleAccount(buildAccount()), true)
  assert.equal(
    isClaudeCompatibleAccount(buildAccount({ provider: 'claude-official' })),
    false,
  )
})

test('buildClaudeCompatibleUpstreamUrl joins apiBaseUrl and pathname', () => {
  const url = buildClaudeCompatibleUpstreamUrl(buildAccount(), '/v1/messages', '')
  assert.equal(url.toString(), 'https://api.deepseek.com/anthropic/v1/messages')
})

test('buildClaudeCompatibleUpstreamUrl preserves query string', () => {
  const url = buildClaudeCompatibleUpstreamUrl(
    buildAccount(),
    '/v1/messages',
    '?beta=true',
  )
  assert.equal(
    url.toString(),
    'https://api.deepseek.com/anthropic/v1/messages?beta=true',
  )
})

test('buildClaudeCompatibleUpstreamUrl trims trailing slash from baseUrl', () => {
  const url = buildClaudeCompatibleUpstreamUrl(
    buildAccount({ apiBaseUrl: 'https://api.deepseek.com/anthropic/' }),
    '/v1/messages',
    '',
  )
  assert.equal(url.toString(), 'https://api.deepseek.com/anthropic/v1/messages')
})

test('buildClaudeCompatibleUpstreamUrl throws when apiBaseUrl is empty', () => {
  assert.throws(
    () => buildClaudeCompatibleUpstreamUrl(buildAccount({ apiBaseUrl: null }), '/v1/messages', ''),
    /missing apiBaseUrl/,
  )
})

test('rewriteClaudeCompatibleRequestBody overrides body.model with account.modelName', () => {
  const body = Buffer.from(
    JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 100 }),
    'utf8',
  )
  const result = rewriteClaudeCompatibleRequestBody(body, buildAccount())
  const parsed = JSON.parse(result.body.toString('utf8')) as Record<string, unknown>
  assert.equal(parsed.model, 'deepseek-chat')
  assert.equal(parsed.max_tokens, 100)
  assert.equal(result.routing.sourceModel, 'claude-sonnet-4.5')
  assert.equal(result.routing.targetModel, 'deepseek-chat')
  assert.equal(result.routing.tierHit, null)
})

test('rewriteClaudeCompatibleRequestBody preserves other fields unchanged', () => {
  const originalBody = {
    model: 'claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    system: 'you are helpful',
  }
  const body = Buffer.from(JSON.stringify(originalBody), 'utf8')
  const result = rewriteClaudeCompatibleRequestBody(
    body,
    buildAccount({ modelName: 'glm-4.6' }),
  )
  const parsed = JSON.parse(result.body.toString('utf8')) as Record<string, unknown>
  assert.equal(parsed.model, 'glm-4.6')
  assert.deepEqual(parsed.messages, originalBody.messages)
  assert.equal(parsed.stream, true)
  assert.equal(parsed.system, 'you are helpful')
})

test('rewriteClaudeCompatibleRequestBody throws when modelName is missing', () => {
  const body = Buffer.from(JSON.stringify({ model: 'anything' }), 'utf8')
  assert.throws(
    () => rewriteClaudeCompatibleRequestBody(body, buildAccount({ modelName: null })),
    /missing modelName/,
  )
})

test('rewriteClaudeCompatibleRequestBody throws on empty body', () => {
  assert.throws(
    () => rewriteClaudeCompatibleRequestBody(undefined, buildAccount()),
    /Request body is required/,
  )
})

test('rewriteClaudeCompatibleRequestBody throws on invalid JSON', () => {
  const body = Buffer.from('not json', 'utf8')
  assert.throws(
    () => rewriteClaudeCompatibleRequestBody(body, buildAccount()),
    /Request body must be valid JSON/,
  )
})

test('extractClaudeCompatibleErrorMessage reads error.message', () => {
  const body = Buffer.from(
    JSON.stringify({ error: { message: 'invalid api key' } }),
    'utf8',
  )
  assert.equal(extractClaudeCompatibleErrorMessage(body), 'invalid api key')
})

test('extractClaudeCompatibleErrorMessage falls back to text', () => {
  const body = Buffer.from('upstream down', 'utf8')
  assert.equal(extractClaudeCompatibleErrorMessage(body), 'upstream down')
})

test('classifyClaudeModelTier picks family by substring regardless of version', () => {
  assert.equal(classifyClaudeModelTier('claude-opus-4-7'), 'opus')
  assert.equal(classifyClaudeModelTier('claude-opus-4-5-20250929'), 'opus')
  assert.equal(classifyClaudeModelTier('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(classifyClaudeModelTier('claude-sonnet-4.5'), 'sonnet')
  assert.equal(classifyClaudeModelTier('CLAUDE-OPUS-4.6'), 'opus')
  assert.equal(classifyClaudeModelTier('gpt-5.4'), null)
  assert.equal(classifyClaudeModelTier(null), null)
  assert.equal(classifyClaudeModelTier(undefined), null)
  assert.equal(classifyClaudeModelTier(''), null)
})

test('resolveClaudeCompatibleTargetModel uses tier map over modelName', () => {
  const account = buildAccount({
    modelName: 'deepseek-fallback',
    modelTierMap: {
      opus: 'deepseek-v4-pro',
      sonnet: null,
      haiku: 'deepseek-v4-flash',
    },
  })
  assert.equal(resolveClaudeCompatibleTargetModel('claude-opus-4-7', account), 'deepseek-v4-pro')
  assert.equal(resolveClaudeCompatibleTargetModel('claude-haiku-4-5-20251001', account), 'deepseek-v4-flash')
})

test('resolveClaudeCompatibleTargetModel falls back to modelName when tier missing', () => {
  const account = buildAccount({
    modelName: 'deepseek-fallback',
    modelTierMap: {
      opus: 'deepseek-v4-pro',
      sonnet: null,
      haiku: null,
    },
  })
  assert.equal(resolveClaudeCompatibleTargetModel('claude-sonnet-4.5', account), 'deepseek-fallback')
  assert.equal(resolveClaudeCompatibleTargetModel('claude-haiku-4-5', account), 'deepseek-fallback')
})

test('resolveClaudeCompatibleTargetModel falls back to modelName when no tier map', () => {
  const account = buildAccount({ modelName: 'deepseek-chat', modelTierMap: null })
  assert.equal(resolveClaudeCompatibleTargetModel('claude-opus-4-7', account), 'deepseek-chat')
  assert.equal(resolveClaudeCompatibleTargetModel('unknown-model', account), 'deepseek-chat')
})

test('resolveClaudeCompatibleTargetModel throws when nothing matches and no fallback', () => {
  const account = buildAccount({
    modelName: null,
    modelTierMap: { opus: 'deepseek-v4-pro', sonnet: null, haiku: null },
  })
  assert.throws(
    () => resolveClaudeCompatibleTargetModel('claude-sonnet-4.5', account),
    /missing modelName/,
  )
})

test('rewriteClaudeCompatibleRequestBody honors tier map for opus/haiku', () => {
  const account = buildAccount({
    modelName: 'deepseek-chat',
    modelTierMap: {
      opus: 'deepseek-v4-pro',
      sonnet: null,
      haiku: 'deepseek-v4-flash',
    },
  })
  const opus = rewriteClaudeCompatibleRequestBody(
    Buffer.from(JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 50 })),
    account,
  )
  assert.equal((JSON.parse(opus.body.toString('utf8')) as { model: string }).model, 'deepseek-v4-pro')
  assert.equal(opus.routing.tierHit, 'opus')

  const haiku = rewriteClaudeCompatibleRequestBody(
    Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 50 })),
    account,
  )
  assert.equal((JSON.parse(haiku.body.toString('utf8')) as { model: string }).model, 'deepseek-v4-flash')
  assert.equal(haiku.routing.tierHit, 'haiku')

  const sonnet = rewriteClaudeCompatibleRequestBody(
    Buffer.from(JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 50 })),
    account,
  )
  assert.equal((JSON.parse(sonnet.body.toString('utf8')) as { model: string }).model, 'deepseek-chat')
  assert.equal(sonnet.routing.tierHit, null)
})
