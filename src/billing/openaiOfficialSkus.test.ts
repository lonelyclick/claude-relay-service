import assert from 'node:assert/strict'
import test from 'node:test'

import { openAIOfficialSkuInputs } from './openaiOfficialSkus.js'

test('OpenAI official SKU seed includes gpt-5.4-mini for chat and responses', () => {
  const skus = openAIOfficialSkuInputs().filter((sku) => sku.model === 'gpt-5.4-mini')

  assert.equal(skus.length, 2)
  assert.deepEqual(
    skus.map((sku) => sku.protocol).sort(),
    ['openai_chat', 'openai_responses'],
  )
  for (const sku of skus) {
    assert.equal(sku.provider, 'openai')
    assert.equal(sku.modelVendor, 'openai')
    assert.equal(sku.currency, 'USD')
    assert.equal(sku.inputPriceMicrosPerMillion, '750000')
    assert.equal(sku.cacheReadPriceMicrosPerMillion, '75000')
    assert.equal(sku.outputPriceMicrosPerMillion, '4500000')
    assert.equal(sku.supportsPromptCaching, true)
  }
})

test('OpenAI official SKU seed includes codex and latest GPT families', () => {
  const keyed = new Set(
    openAIOfficialSkuInputs().map((sku) => `${sku.protocol}:${sku.model}`),
  )

  for (const model of [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-nano',
    'gpt-5.3-codex',
    'gpt-5-codex',
    'gpt-5.1-codex-mini',
  ]) {
    assert.equal(keyed.has(`openai_chat:${model}`), true)
    assert.equal(keyed.has(`openai_responses:${model}`), true)
  }
})
