import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateBillingAmountMicros,
  isBillableUsageTarget,
  matchBillingRule,
  resolveBillingLineItem,
  type BillingRule,
  type BillingUsageCandidate,
} from './engine.js'

function buildRule(overrides: Partial<BillingRule> = {}): BillingRule {
  return {
    id: overrides.id ?? 'rule-default',
    name: overrides.name ?? 'Default',
    isActive: overrides.isActive ?? true,
    priority: overrides.priority ?? 0,
    currency: overrides.currency ?? 'CNY',
    provider: Object.hasOwn(overrides, 'provider') ? overrides.provider! : 'claude-official',
    accountId: Object.hasOwn(overrides, 'accountId') ? overrides.accountId! : null,
    userId: Object.hasOwn(overrides, 'userId') ? overrides.userId! : null,
    model: Object.hasOwn(overrides, 'model') ? overrides.model! : null,
    effectiveFrom: overrides.effectiveFrom ?? '2026-01-01T00:00:00.000Z',
    effectiveTo: overrides.effectiveTo ?? null,
    inputPriceMicrosPerMillion: overrides.inputPriceMicrosPerMillion ?? '3000000',
    outputPriceMicrosPerMillion: overrides.outputPriceMicrosPerMillion ?? '15000000',
    cacheCreationPriceMicrosPerMillion: overrides.cacheCreationPriceMicrosPerMillion ?? '500000',
    cacheReadPriceMicrosPerMillion: overrides.cacheReadPriceMicrosPerMillion ?? '100000',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  }
}

function buildUsage(overrides: Partial<BillingUsageCandidate> = {}): BillingUsageCandidate {
  return {
    usageRecordId: overrides.usageRecordId ?? 1,
    requestId: overrides.requestId ?? 'req-1',
    userId: overrides.userId ?? 'user-1',
    userName: overrides.userName ?? 'User One',
    billingCurrency: overrides.billingCurrency ?? 'CNY',
    accountId: overrides.accountId ?? 'claude-official:acc-1',
    provider: overrides.provider ?? 'claude-official',
    model: overrides.model ?? 'claude-sonnet-4-5',
    sessionKey: overrides.sessionKey ?? 'session-1',
    clientDeviceId: overrides.clientDeviceId ?? 'device-1',
    target: overrides.target ?? '/v1/messages',
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 500,
    cacheCreationInputTokens: overrides.cacheCreationInputTokens ?? 100,
    cacheReadInputTokens: overrides.cacheReadInputTokens ?? 50,
    statusCode: overrides.statusCode ?? 200,
    createdAt: overrides.createdAt ?? '2026-02-01T00:00:00.000Z',
  }
}

test('matchBillingRule prefers higher specificity over priority', () => {
  const usage = buildUsage()
  const rules = [
    buildRule({ id: 'provider-only', priority: 99 }),
    buildRule({ id: 'provider-and-model', priority: 1, model: 'claude-sonnet-4-5' }),
  ]

  const matched = matchBillingRule(usage, rules)
  assert.equal(matched?.id, 'provider-and-model')
})

test('matchBillingRule respects effective window', () => {
  const usage = buildUsage({ createdAt: '2026-03-01T00:00:00.000Z' })
  const rules = [
    buildRule({
      id: 'expired',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2026-02-01T00:00:00.000Z',
    }),
    buildRule({
      id: 'active',
      effectiveFrom: '2026-02-15T00:00:00.000Z',
    }),
  ]

  const matched = matchBillingRule(usage, rules)
  assert.equal(matched?.id, 'active')
})

test('calculateBillingAmountMicros rounds once after summing components', () => {
  const usage = buildUsage({
    inputTokens: 1_500_000,
    outputTokens: 400_000,
    cacheCreationInputTokens: 100_000,
    cacheReadInputTokens: 50_000,
  })
  const rule = buildRule({
    inputPriceMicrosPerMillion: '2000000',
    outputPriceMicrosPerMillion: '8000000',
    cacheCreationPriceMicrosPerMillion: '500000',
    cacheReadPriceMicrosPerMillion: '250000',
  })

  const amount = calculateBillingAmountMicros(usage, rule)
  assert.equal(amount.toString(), '6262500')
})

test('resolveBillingLineItem bills unknown models through a global fallback rule', () => {
  const usage = buildUsage({ provider: 'openai-codex', model: 'gpt-next-unlisted' })
  const resolved = resolveBillingLineItem(usage, [
    buildRule({
      id: 'global-fallback',
      name: 'Global Fallback',
      provider: null,
      model: null,
      inputPriceMicrosPerMillion: '90000000',
      outputPriceMicrosPerMillion: '450000000',
      cacheCreationPriceMicrosPerMillion: '112500000',
      cacheReadPriceMicrosPerMillion: '9000000',
    }),
  ])
  assert.equal(resolved.status, 'billed')
  assert.equal(resolved.matchedRuleId, 'global-fallback')
  assert.notEqual(resolved.amountMicros, '0')
})

test('resolveBillingLineItem flags invalid usage when all token counters are zero', () => {
  const usage = buildUsage({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
  const resolved = resolveBillingLineItem(usage, [buildRule()])
  assert.equal(resolved.status, 'invalid_usage')
  assert.equal(resolved.matchedRuleId, null)
})

test('isBillableUsageTarget accepts billable paths with query strings', () => {
  assert.equal(isBillableUsageTarget('/v1/messages?beta=true'), true)
  assert.equal(isBillableUsageTarget('/v1/chat/completions?foo=bar'), true)
  assert.equal(isBillableUsageTarget('/v1/responses?stream=true'), true)
})

test('matchBillingRule requires currency to match the usage billing currency', () => {
  const usage = buildUsage({ billingCurrency: 'CNY' })
  const rules = [
    buildRule({ id: 'usd-default', currency: 'USD' }),
    buildRule({ id: 'cny-default', currency: 'CNY' }),
  ]

  const matched = matchBillingRule(usage, rules)
  assert.equal(matched?.id, 'cny-default')
})
