import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  createUsageTransform,
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


test('createUsageTransform extracts OpenAI Responses response.done usage', async () => {
  const { transform, usagePromise } = createUsageTransform()
  transform.end(Buffer.from([
    'event: response.created',
    'data: {"response":{"model":"gpt-5.4-mini","usage":null}}',
    '',
    'event: response.done',
    'data: {"response":{"model":"gpt-5.4-mini","usage":{"input_tokens":12,"output_tokens":5,"input_tokens_details":{"cached_tokens":3}}}}',
    '',
  ].join('\n')))

  const usage = await usagePromise

  assert.deepEqual(usage, {
    model: 'gpt-5.4-mini',
    inputTokens: 12,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 3,
  })
})


test('createUsageTransform extracts usage from any OpenAI Responses SSE event payload', async () => {
  const { transform, usagePromise } = createUsageTransform()
  transform.end(Buffer.from([
    'event: response.in_progress',
    'data: {"type":"response.in_progress","response":{"model":"gpt-5.4-mini-2026-03-17","usage":null}}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"model":"gpt-5.4-mini-2026-03-17","usage":{"input_tokens":509,"output_tokens":191,"input_tokens_details":{"cached_tokens":17}}}}',
    '',
  ].join('\n')))

  const usage = await usagePromise

  assert.deepEqual(usage, {
    model: 'gpt-5.4-mini-2026-03-17',
    inputTokens: 509,
    outputTokens: 191,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 17,
  })
})
