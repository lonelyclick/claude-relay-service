export const BILLABLE_USAGE_TARGETS = [
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/responses',
] as const

export const BILLING_LINE_ITEM_STATUSES = [
  'billed',
  'missing_sku',
  'invalid_usage',
] as const

export type BillingLineItemStatus = (typeof BILLING_LINE_ITEM_STATUSES)[number]

export type BillingModelProvider = 'anthropic' | 'openai' | 'google'
export type BillingModelVendor = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'zhipu' | 'mimo' | 'custom'
export type BillingModelProtocol = 'anthropic_messages' | 'openai_chat' | 'openai_responses' | 'gemini'

export type BillingCurrency = 'USD' | 'CNY'

export interface BillingBaseSku {
  id: string
  provider: BillingModelProvider
  modelVendor: BillingModelVendor
  protocol: BillingModelProtocol
  model: string
  currency: BillingCurrency
  displayName: string
  isActive: boolean
  supportsPromptCaching: boolean
  inputPriceMicrosPerMillion: string
  outputPriceMicrosPerMillion: string
  cacheCreationPriceMicrosPerMillion: string
  cacheReadPriceMicrosPerMillion: string
  topupCurrency: BillingCurrency
  topupAmountMicros: string
  creditAmountMicros: string
  createdAt: string
  updatedAt: string
}

export interface BillingChannelMultiplier {
  id: string
  routingGroupId: string
  provider: BillingModelProvider
  modelVendor: BillingModelVendor
  protocol: BillingModelProtocol
  model: string
  multiplierMicros: string
  isActive: boolean
  showInFrontend: boolean
  allowCalls: boolean
  createdAt: string
  updatedAt: string
}

export interface BillingResolvedSku {
  baseSkuId: string
  multiplierId: string
  multiplierMicros: string
  routingGroupId: string
  provider: BillingModelProvider
  modelVendor: BillingModelVendor
  protocol: BillingModelProtocol
  model: string
  currency: BillingCurrency
  displayName: string
  finalInputPriceMicrosPerMillion: string
  finalOutputPriceMicrosPerMillion: string
  finalCacheCreationPriceMicrosPerMillion: string
  finalCacheReadPriceMicrosPerMillion: string
}

export interface BillingUsageCandidate {
  usageRecordId: number
  requestId: string
  userId: string | null
  organizationId?: string | null
  userName: string | null
  billingCurrency: BillingCurrency
  accountId: string | null
  provider: string | null
  model: string | null
  routingGroupId: string | null
  sessionKey: string | null
  clientDeviceId: string | null
  target: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  statusCode: number
  createdAt: string
  billingReservationId?: string | null
}

export interface BillingLineItemResolution {
  status: BillingLineItemStatus
  currency: BillingCurrency
  routingGroupId: string | null
  inputPriceMicrosPerMillion: string
  outputPriceMicrosPerMillion: string
  cacheCreationPriceMicrosPerMillion: string
  cacheReadPriceMicrosPerMillion: string
  amountMicros: string
}

const ONE_MILLION = 1_000_000n

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

export function isBillableUsageTarget(target: string): boolean {
  const normalizedTarget = target.split('?', 1)[0] ?? target
  return (
    normalizedTarget === '/v1/messages' ||
    normalizedTarget === '/v1/chat/completions' ||
    normalizedTarget === '/v1/responses' ||
    normalizedTarget.startsWith('/v1/responses/')
  )
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

export function applyMultiplier(basePriceMicros: string, multiplierMicros: string): string {
  const base = parseMicros(basePriceMicros)
  const mul = parseMicros(multiplierMicros)
  // (base * mul + half) / 1_000_000 to round to nearest
  const product = base * mul
  return roundMicros(product).toString()
}

export function calculateBillingAmountMicros(
  usage: BillingUsageCandidate,
  resolved: BillingResolvedSku,
): bigint {
  const total =
    BigInt(usage.inputTokens) * parseMicros(resolved.finalInputPriceMicrosPerMillion) +
    BigInt(usage.outputTokens) * parseMicros(resolved.finalOutputPriceMicrosPerMillion) +
    BigInt(usage.cacheCreationInputTokens) * parseMicros(resolved.finalCacheCreationPriceMicrosPerMillion) +
    BigInt(usage.cacheReadInputTokens) * parseMicros(resolved.finalCacheReadPriceMicrosPerMillion)

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
  resolved: BillingResolvedSku | null,
): BillingLineItemResolution {
  if (!hasValidUsage(usage)) {
    return {
      status: 'invalid_usage',
      currency: usage.billingCurrency,
      routingGroupId: usage.routingGroupId,
      inputPriceMicrosPerMillion: '0',
      outputPriceMicrosPerMillion: '0',
      cacheCreationPriceMicrosPerMillion: '0',
      cacheReadPriceMicrosPerMillion: '0',
      amountMicros: '0',
    }
  }

  if (!resolved) {
    return {
      status: 'missing_sku',
      currency: usage.billingCurrency,
      routingGroupId: usage.routingGroupId,
      inputPriceMicrosPerMillion: '0',
      outputPriceMicrosPerMillion: '0',
      cacheCreationPriceMicrosPerMillion: '0',
      cacheReadPriceMicrosPerMillion: '0',
      amountMicros: '0',
    }
  }

  return {
    status: 'billed',
    currency: resolved.currency,
    routingGroupId: usage.routingGroupId,
    inputPriceMicrosPerMillion: resolved.finalInputPriceMicrosPerMillion,
    outputPriceMicrosPerMillion: resolved.finalOutputPriceMicrosPerMillion,
    cacheCreationPriceMicrosPerMillion: resolved.finalCacheCreationPriceMicrosPerMillion,
    cacheReadPriceMicrosPerMillion: resolved.finalCacheReadPriceMicrosPerMillion,
    amountMicros: calculateBillingAmountMicros(usage, resolved).toString(),
  }
}
