import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  extractUsageFromJsonBody,
  extractRateLimitInfo,
  extractRateLimitInfoFromErrorResponse,
} from './usageExtractor.js'

test('extractRateLimitInfo reads Anthropic rate-limit headers', () => {
  const info = extractRateLimitInfo({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-7d-utilization': '0.5',
    'anthropic-ratelimit-unified-reset': '1234567890',
  })

  assert.deepEqual(info, {
    status: 'rejected',
    fiveHourUtilization: 1,
    sevenDayUtilization: 0.5,
    resetTimestamp: 1234567890,
  })
})

test('extractRateLimitInfoFromErrorResponse preserves header-derived status', () => {
  const info = extractRateLimitInfoFromErrorResponse({
    statusCode: 403,
    headers: {
      'anthropic-ratelimit-unified-status': 'blocked',
    },
    body: Buffer.from('{"error":{"code":"E014","message":"Quota exceeded"},"status":429}'),
  })

  assert.equal(info.status, 'blocked')
})

test('extractRateLimitInfoFromErrorResponse maps wrapped quota errors to blocked', () => {
  const info = extractRateLimitInfoFromErrorResponse({
    statusCode: 403,
    headers: {},
    body: Buffer.from('{"error":{"code":"E014","message":"Quota exceeded"},"status":429}'),
  })

  assert.equal(info.status, 'blocked')
})

test('extractRateLimitInfoFromErrorResponse maps wrapped rate-limit errors to throttled', () => {
  const info = extractRateLimitInfoFromErrorResponse({
    statusCode: 403,
    headers: {},
    body: Buffer.from('{"error":{"message":"rate limited"},"status":429}'),
  })

  assert.equal(info.status, 'throttled')
})

test('extractUsageFromJsonBody decodes gzip responses before parsing usage', () => {
  const body = gzipSync(
    Buffer.from(
      JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 9,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    ),
  )

  const usage = extractUsageFromJsonBody(body, 'gzip')

  assert.deepEqual(usage, {
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 9,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
})
