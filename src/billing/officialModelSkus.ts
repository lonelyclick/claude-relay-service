import type { BillingBaseSkuInput } from './billingStore.js'
import type { BillingCurrency } from '../types.js'

type OfficialModelSku = {
  provider: BillingBaseSkuInput['provider']
  modelVendor: NonNullable<BillingBaseSkuInput['modelVendor']>
  protocol: NonNullable<BillingBaseSkuInput['protocol']>
  model: string
  input: string
  cachedInput: string
  cacheCreation?: string
  output: string
}

const ANTHROPIC_SKUS: OfficialModelSku[] = [
  { provider: 'anthropic', modelVendor: 'anthropic', protocol: 'anthropic_messages', model: 'claude-opus-4-7', input: '5', cachedInput: '0.5', cacheCreation: '6.25', output: '25' },
  { provider: 'anthropic', modelVendor: 'anthropic', protocol: 'anthropic_messages', model: 'claude-opus-4-6', input: '5', cachedInput: '0.5', cacheCreation: '6.25', output: '25' },
  { provider: 'anthropic', modelVendor: 'anthropic', protocol: 'anthropic_messages', model: 'claude-opus-4-20250514', input: '15', cachedInput: '1.5', cacheCreation: '18.75', output: '75' },
  { provider: 'anthropic', modelVendor: 'anthropic', protocol: 'anthropic_messages', model: 'claude-sonnet-4-5', input: '3', cachedInput: '0.3', cacheCreation: '3.75', output: '15' },
  { provider: 'anthropic', modelVendor: 'anthropic', protocol: 'anthropic_messages', model: 'claude-sonnet-4', input: '3', cachedInput: '0.3', cacheCreation: '3.75', output: '15' },
  { provider: 'anthropic', modelVendor: 'anthropic', protocol: 'anthropic_messages', model: 'claude-haiku-4-5', input: '1', cachedInput: '0.1', cacheCreation: '1.25', output: '5' },
]

const GEMINI_SKUS: OfficialModelSku[] = [
  { provider: 'google', modelVendor: 'google', protocol: 'gemini', model: 'gemini-3.1-pro', input: '2', cachedInput: '0.2', output: '12' },
  { provider: 'google', modelVendor: 'google', protocol: 'gemini', model: 'gemini-3-flash', input: '0.5', cachedInput: '0.05', output: '3' },
  { provider: 'google', modelVendor: 'google', protocol: 'gemini', model: 'gemini-2.5-pro', input: '1.25', cachedInput: '0.125', output: '10' },
  { provider: 'google', modelVendor: 'google', protocol: 'gemini', model: 'gemini-2.5-flash', input: '0.3', cachedInput: '0.03', output: '2.5' },
]

export const OFFICIAL_MODEL_SKUS = [
  ...ANTHROPIC_SKUS,
  ...GEMINI_SKUS,
] as const

function dollarsPerMillionToMicros(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Official model price is empty')
  const [wholePart, fractionalPart = ''] = trimmed.split('.', 2)
  if (!/^\d+$/.test(wholePart) || !/^\d*$/.test(fractionalPart)) {
    throw new Error(`Official model price is invalid: ${value}`)
  }
  const micros = BigInt(wholePart) * 1_000_000n + BigInt((fractionalPart + '000000').slice(0, 6))
  return micros.toString()
}

const OFFICIAL_MODEL_SKU_CURRENCIES: BillingCurrency[] = ['USD', 'CNY']

export function officialModelSkuInputs(): BillingBaseSkuInput[] {
  const inputs: BillingBaseSkuInput[] = []
  for (const sku of OFFICIAL_MODEL_SKUS) {
    for (const currency of OFFICIAL_MODEL_SKU_CURRENCIES) {
      inputs.push({
        provider: sku.provider,
        modelVendor: sku.modelVendor,
        protocol: sku.protocol,
        model: sku.model,
        currency,
        displayName: sku.model,
        isActive: true,
        supportsPromptCaching: sku.cachedInput !== '0' || (sku.cacheCreation ?? '0') !== '0',
        inputPriceMicrosPerMillion: dollarsPerMillionToMicros(sku.input),
        outputPriceMicrosPerMillion: dollarsPerMillionToMicros(sku.output),
        cacheReadPriceMicrosPerMillion: dollarsPerMillionToMicros(sku.cachedInput),
        cacheCreationPriceMicrosPerMillion: dollarsPerMillionToMicros(sku.cacheCreation ?? '0'),
      })
    }
  }
  return inputs
}
