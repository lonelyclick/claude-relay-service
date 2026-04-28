import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InputValidationError,
  normalizeBillingCurrency,
  normalizeOptionalText,
  normalizeSignedBigIntString,
  normalizeUnsignedBigIntString,
  sanitizeErrorMessage,
} from './inputValidation.js'

test('normalizeOptionalText rejects control characters', () => {
  assert.throws(
    () => normalizeOptionalText('safe\r\nvalue', { field: 'note', maxLength: 32 }),
    (error: unknown) => error instanceof InputValidationError &&
      error.message === 'note contains unsupported control characters',
  )
})

test('normalizeUnsignedBigIntString rejects bigint overflow', () => {
  assert.throws(
    () => normalizeUnsignedBigIntString('9223372036854775808', { field: 'amountMicros' }),
    (error: unknown) => error instanceof InputValidationError &&
      error.message === 'amountMicros is out of range',
  )
})

test('normalizeSignedBigIntString keeps valid signed values normalized', () => {
  assert.equal(
    normalizeSignedBigIntString('  -42  ', { field: 'amountMicros' }),
    '-42',
  )
})

test('sanitizeErrorMessage strips control characters and truncates long messages', () => {
  const cleaned = sanitizeErrorMessage(new Error(`bad\r\n${'x'.repeat(260)}`))
  assert.ok(!cleaned.includes('\r'))
  assert.ok(!cleaned.includes('\n'))
  assert.ok(cleaned.startsWith('bad '))
  assert.ok(cleaned.endsWith('...'))
  assert.ok(cleaned.length <= 240)
})

test('normalizeBillingCurrency accepts RMB alias and rejects unsupported currency codes', () => {
  assert.equal(normalizeBillingCurrency('rmb'), 'CNY')
  assert.throws(
    () => normalizeBillingCurrency('EUR'),
    (error: unknown) => error instanceof InputValidationError &&
      error.message === 'billingCurrency must be one of: USD, CNY',
  )
})
