export const BILLABLE_USAGE_TARGETS = [
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/responses',
] as const

export const BILLING_LINE_ITEM_STATUSES = [
  'billed',
  'missing_rule',
  'invalid_usage',
] as const

export type BillingLineItemStatus = (typeof BILLING_LINE_ITEM_STATUSES)[number]

export interface BillingRule {
  id: string
  name: string
  isActive: boolean
  priority: number
  currency: 'USD' | 'CNY'
  provider: string | null
  accountId: string | null
  userId: string | null
  model: string | null
  effectiveFrom: string
  effectiveTo: string | null
  inputPriceMicrosPerMillion: string
  outputPriceMicrosPerMillion: string
  cacheCreationPriceMicrosPerMillion: string
  cacheReadPriceMicrosPerMillion: string
  createdAt: string
  updatedAt: string
}

export interface BillingUsageCandidate {
  usageRecordId: number
  requestId: string
  userId: string
  userName: string | null
  billingCurrency: 'USD' | 'CNY'
  accountId: string | null
  provider: string | null
  model: string | null
  sessionKey: string | null
  clientDeviceId: string | null
  target: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  statusCode: number
  createdAt: string
}

export interface BillingLineItemResolution {
  status: BillingLineItemStatus
  matchedRuleId: string | null
  matchedRuleName: string | null
  currency: 'USD' | 'CNY'
  inputPriceMicrosPerMillion: string
  outputPriceMicrosPerMillion: string
  cacheCreationPriceMicrosPerMillion: string
  cacheReadPriceMicrosPerMillion: string
  amountMicros: string
}

const ONE_MILLION = 1_000_000n

function normalizeNullable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN
  }
  return Date.parse(value)
}

function parseMicros(value: string): bigint {
  const trimmed = value.trim()
  if (!trimmed) {
    return 0n
  }
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid micros value: ${value}`)
  }
  return BigInt(trimmed)
}

function countSpecificity(rule: BillingRule): number {
  return [
    rule.provider,
    rule.accountId,
    rule.userId,
    rule.model,
  ].filter(Boolean).length
}

function matchesRule(rule: BillingRule, usage: BillingUsageCandidate): boolean {
  if (!rule.isActive) {
    return false
  }

  if (rule.currency !== usage.billingCurrency) {
    return false
  }

  const usageCreatedAt = parseTimestamp(usage.createdAt)
  const effectiveFrom = parseTimestamp(rule.effectiveFrom)
  const effectiveTo = parseTimestamp(rule.effectiveTo)
  if (Number.isFinite(effectiveFrom) && usageCreatedAt < effectiveFrom) {
    return false
  }
  if (Number.isFinite(effectiveTo) && usageCreatedAt >= effectiveTo) {
    return false
  }

  const provider = normalizeNullable(rule.provider)
  if (provider && provider !== normalizeNullable(usage.provider)) {
    return false
  }

  const accountId = normalizeNullable(rule.accountId)
  if (accountId && accountId !== normalizeNullable(usage.accountId)) {
    return false
  }

  const userId = normalizeNullable(rule.userId)
  if (userId && userId !== normalizeNullable(usage.userId)) {
    return false
  }

  const model = normalizeNullable(rule.model)
  if (model && model !== normalizeNullable(usage.model)) {
    return false
  }

  return true
}

export function isBillableUsageTarget(target: string): boolean {
  const normalizedTarget = target.split('?', 1)[0] ?? target
  return (
    normalizedTarget === '/v1/messages' ||
    normalizedTarget === '/v1/chat/completions' ||
    normalizedTarget === '/v1/responses' ||
    normalizedTarget.startsWith('/v1/responses/')
  )
}

export function matchBillingRule(
  usage: BillingUsageCandidate,
  rules: BillingRule[],
): BillingRule | null {
  const matches = rules.filter((rule) => matchesRule(rule, usage))
  if (!matches.length) {
    return null
  }

  matches.sort((left, right) => {
    const specificityDelta = countSpecificity(right) - countSpecificity(left)
    if (specificityDelta !== 0) {
      return specificityDelta
    }

    const priorityDelta = right.priority - left.priority
    if (priorityDelta !== 0) {
      return priorityDelta
    }

    const effectiveDelta = parseTimestamp(right.effectiveFrom) - parseTimestamp(left.effectiveFrom)
    if (effectiveDelta !== 0) {
      return effectiveDelta
    }

    const updatedDelta = parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt)
    if (updatedDelta !== 0) {
      return updatedDelta
    }

    return left.id.localeCompare(right.id)
  })

  return matches[0] ?? null
}

function roundMicros(numerator: bigint): bigint {
  if (numerator === 0n) {
    return 0n
  }
  const half = ONE_MILLION / 2n
  if (numerator > 0n) {
    return (numerator + half) / ONE_MILLION
  }
  return (numerator - half) / ONE_MILLION
}

export function calculateBillingAmountMicros(
  usage: BillingUsageCandidate,
  rule: BillingRule,
): bigint {
  const total =
    BigInt(usage.inputTokens) * parseMicros(rule.inputPriceMicrosPerMillion) +
    BigInt(usage.outputTokens) * parseMicros(rule.outputPriceMicrosPerMillion) +
    BigInt(usage.cacheCreationInputTokens) * parseMicros(rule.cacheCreationPriceMicrosPerMillion) +
    BigInt(usage.cacheReadInputTokens) * parseMicros(rule.cacheReadPriceMicrosPerMillion)

  return roundMicros(total)
}

function hasValidUsage(usage: BillingUsageCandidate): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheCreationInputTokens > 0 ||
    usage.cacheReadInputTokens > 0
  )
}

export function resolveBillingLineItem(
  usage: BillingUsageCandidate,
  rules: BillingRule[],
): BillingLineItemResolution {
  if (!hasValidUsage(usage)) {
    return {
      status: 'invalid_usage',
      matchedRuleId: null,
      matchedRuleName: null,
      currency: usage.billingCurrency,
      inputPriceMicrosPerMillion: '0',
      outputPriceMicrosPerMillion: '0',
      cacheCreationPriceMicrosPerMillion: '0',
      cacheReadPriceMicrosPerMillion: '0',
      amountMicros: '0',
    }
  }

  const matchedRule = matchBillingRule(usage, rules)
  if (!matchedRule) {
    return {
      status: 'missing_rule',
      matchedRuleId: null,
      matchedRuleName: null,
      currency: usage.billingCurrency,
      inputPriceMicrosPerMillion: '0',
      outputPriceMicrosPerMillion: '0',
      cacheCreationPriceMicrosPerMillion: '0',
      cacheReadPriceMicrosPerMillion: '0',
      amountMicros: '0',
    }
  }

  return {
    status: 'billed',
    matchedRuleId: matchedRule.id,
    matchedRuleName: matchedRule.name,
    currency: matchedRule.currency,
    inputPriceMicrosPerMillion: matchedRule.inputPriceMicrosPerMillion,
    outputPriceMicrosPerMillion: matchedRule.outputPriceMicrosPerMillion,
    cacheCreationPriceMicrosPerMillion: matchedRule.cacheCreationPriceMicrosPerMillion,
    cacheReadPriceMicrosPerMillion: matchedRule.cacheReadPriceMicrosPerMillion,
    amountMicros: calculateBillingAmountMicros(usage, matchedRule).toString(),
  }
}
