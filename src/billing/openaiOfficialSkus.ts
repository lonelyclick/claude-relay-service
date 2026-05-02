import type { BillingBaseSkuInput } from './billingStore.js'
import type { BillingCurrency } from '../types.js'

type OfficialOpenAISku = {
  model: string
  input: string
  cachedInput: string
  output: string
}

const TEXT_TOKEN_SKUS: OfficialOpenAISku[] = [
  { model: 'gpt-5.5', input: '5', cachedInput: '0.5', output: '30' },
  { model: 'gpt-5.5-pro', input: '30', cachedInput: '0', output: '180' },
  { model: 'gpt-5.4', input: '2.5', cachedInput: '0.25', output: '15' },
  { model: 'gpt-5.4-mini', input: '0.75', cachedInput: '0.075', output: '4.5' },
  { model: 'gpt-5.4-nano', input: '0.2', cachedInput: '0.02', output: '1.25' },
  { model: 'gpt-5.4-pro', input: '30', cachedInput: '0', output: '180' },
  { model: 'gpt-5.2', input: '1.75', cachedInput: '0.175', output: '14' },
  { model: 'gpt-5.2-pro', input: '21', cachedInput: '0', output: '168' },
  { model: 'gpt-5.1', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'gpt-5', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'gpt-5-mini', input: '0.25', cachedInput: '0.025', output: '2' },
  { model: 'gpt-5-nano', input: '0.05', cachedInput: '0.005', output: '0.4' },
  { model: 'gpt-5-pro', input: '15', cachedInput: '0', output: '120' },
  { model: 'gpt-4.1', input: '2', cachedInput: '0.5', output: '8' },
  { model: 'gpt-4.1-2025-04-14', input: '3', cachedInput: '0.75', output: '12' },
  { model: 'gpt-4.1-mini', input: '0.4', cachedInput: '0.1', output: '1.6' },
  { model: 'gpt-4.1-mini-2025-04-14', input: '0.8', cachedInput: '0.2', output: '3.2' },
  { model: 'gpt-4.1-nano', input: '0.1', cachedInput: '0.025', output: '0.4' },
  { model: 'gpt-4.1-nano-2025-04-14', input: '0.2', cachedInput: '0.05', output: '0.8' },
  { model: 'gpt-4o', input: '2.5', cachedInput: '1.25', output: '10' },
  { model: 'gpt-4o-2024-05-13', input: '5', cachedInput: '0', output: '15' },
  { model: 'gpt-4o-2024-08-06', input: '3.75', cachedInput: '1.875', output: '15' },
  { model: 'gpt-4o-mini', input: '0.15', cachedInput: '0.075', output: '0.6' },
  { model: 'gpt-4o-mini-2024-07-18', input: '0.3', cachedInput: '0.15', output: '1.2' },
  { model: 'o1', input: '15', cachedInput: '7.5', output: '60' },
  { model: 'o1-pro', input: '150', cachedInput: '0', output: '600' },
  { model: 'o3-pro', input: '20', cachedInput: '0', output: '80' },
  { model: 'o3', input: '2', cachedInput: '0.5', output: '8' },
  { model: 'o4-mini', input: '1.1', cachedInput: '0.275', output: '4.4' },
  { model: 'o4-mini-2025-04-16', input: '4', cachedInput: '1', output: '16' },
  { model: 'o3-mini', input: '1.1', cachedInput: '0.55', output: '4.4' },
  { model: 'o1-mini', input: '1.1', cachedInput: '0.55', output: '4.4' },
  { model: 'gpt-4-turbo-2024-04-09', input: '10', cachedInput: '0', output: '30' },
  { model: 'gpt-4-0125-preview', input: '10', cachedInput: '0', output: '30' },
  { model: 'gpt-4-1106-preview', input: '10', cachedInput: '0', output: '30' },
  { model: 'gpt-4-1106-vision-preview', input: '10', cachedInput: '0', output: '30' },
  { model: 'gpt-4-0613', input: '30', cachedInput: '0', output: '60' },
  { model: 'gpt-4-0314', input: '30', cachedInput: '0', output: '60' },
  { model: 'gpt-4-32k', input: '60', cachedInput: '0', output: '120' },
  { model: 'gpt-3.5-turbo', input: '0.5', cachedInput: '0', output: '1.5' },
  { model: 'gpt-3.5-turbo-0125', input: '0.5', cachedInput: '0', output: '1.5' },
  { model: 'gpt-3.5-turbo-1106', input: '1', cachedInput: '0', output: '2' },
  { model: 'gpt-3.5-turbo-0613', input: '1.5', cachedInput: '0', output: '2' },
  { model: 'gpt-3.5-0301', input: '1.5', cachedInput: '0', output: '2' },
  { model: 'gpt-3.5-turbo-instruct', input: '1.5', cachedInput: '0', output: '2' },
  { model: 'gpt-3.5-turbo-16k-0613', input: '3', cachedInput: '0', output: '4' },
  { model: 'davinci-002', input: '2', cachedInput: '0', output: '2' },
  { model: 'babbage-002', input: '0.4', cachedInput: '0', output: '0.4' },
]

const CHATGPT_SKUS: OfficialOpenAISku[] = [
  { model: 'gpt-5.3-chat-latest', input: '1.75', cachedInput: '0.175', output: '14' },
  { model: 'gpt-5.2-chat-latest', input: '1.75', cachedInput: '0.175', output: '14' },
  { model: 'gpt-5.1-chat-latest', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'gpt-5-chat-latest', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'chatgpt-4o-latest', input: '5', cachedInput: '0', output: '15' },
]

const CODEX_SKUS: OfficialOpenAISku[] = [
  { model: 'gpt-5.3-codex', input: '1.75', cachedInput: '0.175', output: '14' },
  { model: 'gpt-5.2-codex', input: '1.75', cachedInput: '0.175', output: '14' },
  { model: 'gpt-5.1-codex-max', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'gpt-5.1-codex', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'gpt-5-codex', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'gpt-5.1-codex-mini', input: '0.25', cachedInput: '0.025', output: '2' },
  { model: 'codex-mini-latest', input: '1.5', cachedInput: '0.375', output: '6' },
]

const SEARCH_SKUS: OfficialOpenAISku[] = [
  { model: 'gpt-5-search-api', input: '1.25', cachedInput: '0.125', output: '10' },
  { model: 'gpt-4o-search-preview', input: '2.5', cachedInput: '0', output: '10' },
  { model: 'gpt-4o-mini-search-preview', input: '0.15', cachedInput: '0', output: '0.6' },
]

const MULTIMODAL_TEXT_SKUS: OfficialOpenAISku[] = [
  { model: 'gpt-realtime-1.5', input: '4', cachedInput: '0.4', output: '16' },
  { model: 'gpt-realtime-mini', input: '0.6', cachedInput: '0.06', output: '2.4' },
  { model: 'gpt-realtime', input: '4', cachedInput: '0.4', output: '16' },
  { model: 'gpt-4o-realtime-preview', input: '5', cachedInput: '2.5', output: '20' },
  { model: 'gpt-4o-mini-realtime-preview', input: '0.6', cachedInput: '0.3', output: '2.4' },
  { model: 'gpt-audio-1.5', input: '2.5', cachedInput: '0', output: '10' },
  { model: 'gpt-audio-mini', input: '0.6', cachedInput: '0', output: '2.4' },
  { model: 'gpt-audio', input: '2.5', cachedInput: '0', output: '10' },
  { model: 'gpt-4o-audio-preview', input: '2.5', cachedInput: '0', output: '10' },
  { model: 'gpt-4o-mini-audio-preview', input: '0.15', cachedInput: '0', output: '0.6' },
  { model: 'gpt-4o-mini-tts', input: '0.6', cachedInput: '0', output: '12' },
  { model: 'gpt-4o-transcribe', input: '2.5', cachedInput: '0', output: '10' },
  { model: 'gpt-4o-mini-transcribe', input: '1.25', cachedInput: '0', output: '5' },
  { model: 'gpt-4o-transcribe-diarize', input: '2.5', cachedInput: '0', output: '10' },
  { model: 'gpt-image-2', input: '5', cachedInput: '1.25', output: '30' },
  { model: 'gpt-image-1.5', input: '5', cachedInput: '1.25', output: '32' },
  { model: 'gpt-image-1-mini', input: '2', cachedInput: '0.2', output: '8' },
  { model: 'gpt-image-1', input: '5', cachedInput: '1.25', output: '40' },
  { model: 'chatgpt-image-latest', input: '5', cachedInput: '1.25', output: '32' },
]

const SPECIALIZED_SKUS: OfficialOpenAISku[] = [
  { model: 'o3-deep-research', input: '10', cachedInput: '2.5', output: '40' },
  { model: 'o4-mini-deep-research', input: '2', cachedInput: '0.5', output: '8' },
  { model: 'computer-use-preview', input: '3', cachedInput: '0', output: '12' },
]

export const OPENAI_OFFICIAL_TEXT_TOKEN_SKUS = [
  ...TEXT_TOKEN_SKUS,
  ...CHATGPT_SKUS,
  ...CODEX_SKUS,
  ...SEARCH_SKUS,
  ...MULTIMODAL_TEXT_SKUS,
  ...SPECIALIZED_SKUS,
] as const

function dollarsPerMillionToMicros(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '-') return '0'
  const [wholePart, fractionalPart = ''] = trimmed.split('.', 2)
  const micros = BigInt(wholePart) * 1_000_000n + BigInt((fractionalPart + '000000').slice(0, 6))
  return micros.toString()
}

const OFFICIAL_OPENAI_SKU_CURRENCIES: BillingCurrency[] = ['USD', 'CNY']

export function openAIOfficialSkuInputs(): BillingBaseSkuInput[] {
  const inputs: BillingBaseSkuInput[] = []
  for (const sku of OPENAI_OFFICIAL_TEXT_TOKEN_SKUS) {
    for (const protocol of ['openai_chat', 'openai_responses'] as const) {
      for (const currency of OFFICIAL_OPENAI_SKU_CURRENCIES) {
        inputs.push({
          provider: 'openai',
          modelVendor: 'openai',
          protocol,
          model: sku.model,
          currency,
          displayName: sku.model,
          isActive: true,
          supportsPromptCaching: sku.cachedInput !== '0',
          inputPriceMicrosPerMillion: dollarsPerMillionToMicros(sku.input),
          outputPriceMicrosPerMillion: dollarsPerMillionToMicros(sku.output),
          cacheReadPriceMicrosPerMillion: dollarsPerMillionToMicros(sku.cachedInput),
          cacheCreationPriceMicrosPerMillion: '0',
        })
      }
    }
  }
  return inputs
}
