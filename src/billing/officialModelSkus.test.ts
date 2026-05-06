import assert from 'node:assert/strict'
import test from 'node:test'

import { officialModelSkuInputs } from './officialModelSkus.js'

test('official model SKU seed includes Claude Opus and Gemini families', () => {
  const keyed = new Set(
    officialModelSkuInputs().map((sku) => `${sku.currency}:${sku.protocol}:${sku.modelVendor}:${sku.model}`),
  )
  for (const model of [
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
  ]) {
    assert.equal(keyed.has(`USD:anthropic_messages:anthropic:${model}`), true)
    assert.equal(keyed.has(`CNY:anthropic_messages:anthropic:${model}`), true)
  }
  for (const model of ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']) {
    assert.equal(keyed.has(`USD:gemini:google:${model}`), true)
    assert.equal(keyed.has(`CNY:gemini:google:${model}`), true)
  }
})

test('official model SKU seed keeps CNY prices 1:1 with USD', () => {
  const byKey = new Map(officialModelSkuInputs().map((sku) => [`${sku.model}:${sku.protocol}:${sku.currency}`, sku]))
  for (const usd of officialModelSkuInputs().filter((sku) => sku.currency === 'USD')) {
    const cny = byKey.get(`${usd.model}:${usd.protocol}:CNY`)
    assert.ok(cny)
    assert.equal(cny.inputPriceMicrosPerMillion, usd.inputPriceMicrosPerMillion)
    assert.equal(cny.outputPriceMicrosPerMillion, usd.outputPriceMicrosPerMillion)
    assert.equal(cny.cacheReadPriceMicrosPerMillion, usd.cacheReadPriceMicrosPerMillion)
    assert.equal(cny.cacheCreationPriceMicrosPerMillion, usd.cacheCreationPriceMicrosPerMillion)
  }
})
