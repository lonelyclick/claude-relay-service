import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveOpenAIRateLimitStatus,
  parseOpenAIRateLimitHeaders,
  parseWhamUsage,
  parseResetDurationSeconds,
} from './openaiRateLimitProbe.js'

test('parseResetDurationSeconds supports composite OpenAI reset values', () => {
  assert.equal(parseResetDurationSeconds('1s'), 1)
  assert.equal(parseResetDurationSeconds('6m0s'), 360)
  assert.equal(parseResetDurationSeconds('1h2m3s'), 3723)
  assert.equal(parseResetDurationSeconds('250ms'), 1)
  assert.equal(parseResetDurationSeconds(null), null)
  assert.equal(parseResetDurationSeconds(''), null)
})

test('parseOpenAIRateLimitHeaders derives utilization percentages from limit and remaining', () => {
  const parsed = parseOpenAIRateLimitHeaders({
    'x-ratelimit-limit-requests': '60',
    'x-ratelimit-remaining-requests': '15',
    'x-ratelimit-reset-requests': '8m0s',
    'x-ratelimit-limit-tokens': '120000',
    'x-ratelimit-remaining-tokens': '30000',
    'x-ratelimit-reset-tokens': '45s',
  })

  assert.equal(parsed.requestLimit, 60)
  assert.equal(parsed.requestRemaining, 15)
  assert.equal(parsed.requestUtilization, 0.75)
  assert.equal(parsed.requestReset, '8m0s')
  assert.equal(parsed.requestResetSeconds, 480)
  assert.equal(parsed.tokenLimit, 120000)
  assert.equal(parsed.tokenRemaining, 30000)
  assert.equal(parsed.tokenUtilization, 0.75)
  assert.equal(parsed.tokenReset, '45s')
  assert.equal(parsed.tokenResetSeconds, 45)
})

test('parseWhamUsage normalizes percent fields to fractions', () => {
  const parsed = parseWhamUsage(JSON.stringify({
    rate_limits: {
      primary_window: {
        used_percent: 75,
        reset_at: 1_776_074_400,
      },
      secondary_window: {
        percent_left: 40,
        reset_at_ms: 1_776_160_800_000,
      },
    },
  }))

  assert.equal(parsed.fiveHourUtilization, 0.75)
  assert.equal(parsed.fiveHourReset, '2026-04-13T10:00:00.000Z')
  assert.equal(parsed.sevenDayUtilization, 0.6)
  assert.equal(parsed.sevenDayReset, '2026-04-14T10:00:00.000Z')
})

test('parseWhamUsage supports current primary/secondary resets_at fields', () => {
  const parsed = parseWhamUsage(JSON.stringify({
    rate_limits: {
      primary: {
        used_percent: 26,
        window_minutes: 300,
        resets_at: 1_776_953_962,
      },
      secondary: {
        used_percent: 33,
        window_minutes: 10_080,
        resets_at: 1_777_436_556,
      },
    },
  }))

  assert.equal(parsed.fiveHourUtilization, 0.26)
  assert.equal(parsed.fiveHourReset, '2026-04-23T14:19:22.000Z')
  assert.equal(parsed.sevenDayUtilization, 0.33)
  assert.equal(parsed.sevenDayReset, '2026-04-29T04:22:36.000Z')
})

test('deriveOpenAIRateLimitStatus marks near-exhausted windows as warnings', () => {
  assert.equal(
    deriveOpenAIRateLimitStatus({
      requestUtilization: 0.4,
      tokenUtilization: 0.45,
      fiveHourUtilization: 0.92,
    }),
    'allowed_warning',
  )
  assert.equal(
    deriveOpenAIRateLimitStatus({
      httpStatus: 429,
      requestUtilization: 0.2,
    }),
    'rejected',
  )
})
