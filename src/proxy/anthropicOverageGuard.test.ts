import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAnthropicOverageDisabledAction } from './relayService.js'

const baseInput = {
  reasonRaw: 'org_level_disabled',
  overageStatus: 'rejected',
  unifiedStatus: 'allowed',
  statusCode: 200,
  allowedWarningCooldownMs: 45 * 60 * 1000,
  rejectedCooldownMs: 4 * 60 * 60 * 1000,
  policyDisabledCooldownMs: 24 * 60 * 60 * 1000,
}

test('Anthropic overage guard observes org_level_disabled while unified status is allowed', () => {
  const action = resolveAnthropicOverageDisabledAction(baseInput)

  assert.equal(action?.severity, 'observe')
  assert.equal(action?.cooldownMs, null)
  assert.equal(action?.reason, 'org_level_disabled')
  assert.equal(action?.unifiedStatus, 'allowed')
  assert.ok(Array.isArray(action?.notes))
})

test('representative_claim=seven_day doubles cooldown', () => {
  const action = resolveAnthropicOverageDisabledAction({
    ...baseInput,
    unifiedStatus: 'allowed_warning',
    representativeClaim: 'seven_day',
  })

  assert.equal(action?.severity, 'warn')
  assert.equal(action?.cooldownMs, baseInput.allowedWarningCooldownMs * 2)
  assert.ok(action?.notes.includes('seven_day_amplified'))
})

test('fallback_percentage<1 amplifies cooldown 1.5x', () => {
  const action = resolveAnthropicOverageDisabledAction({
    ...baseInput,
    unifiedStatus: 'allowed_warning',
    fallbackPercentage: 0.5,
  })

  assert.equal(action?.severity, 'warn')
  assert.equal(action?.cooldownMs, Math.round(baseInput.allowedWarningCooldownMs * 1.5))
  assert.ok(action?.notes.some((note) => note.startsWith('fallback_')))
})

test('account_level_disabled treated as policy family red', () => {
  const action = resolveAnthropicOverageDisabledAction({
    ...baseInput,
    reasonRaw: 'account_level_disabled',
    unifiedStatus: 'allowed',
  })

  assert.equal(action?.severity, 'block')
  assert.equal(action?.cooldownMs, baseInput.policyDisabledCooldownMs)
  assert.ok(action?.notes.includes('policy_family_red'))
})

test('cooldown clamps to 5min floor and 24h ceiling', () => {
  const tinyInput = {
    ...baseInput,
    unifiedStatus: 'allowed_warning',
    allowedWarningCooldownMs: 60_000,
  }
  const tiny = resolveAnthropicOverageDisabledAction(tinyInput)
  assert.equal(tiny?.cooldownMs, 5 * 60 * 1000)

  const huge = resolveAnthropicOverageDisabledAction({
    ...baseInput,
    reasonRaw: 'policy_disabled',
    representativeClaim: 'seven_day',
    fallbackPercentage: 0.1,
    policyDisabledCooldownMs: 30 * 60 * 60 * 1000,
  })
  assert.equal(huge?.cooldownMs, 24 * 60 * 60 * 1000)
})

test('Anthropic overage guard applies short cooldown for allowed_warning', () => {
  const action = resolveAnthropicOverageDisabledAction({
    ...baseInput,
    unifiedStatus: 'allowed_warning',
  })

  assert.equal(action?.severity, 'warn')
  assert.equal(action?.cooldownMs, baseInput.allowedWarningCooldownMs)
})

test('Anthropic overage guard blocks rejected requests', () => {
  const action = resolveAnthropicOverageDisabledAction({
    ...baseInput,
    unifiedStatus: 'rejected',
    statusCode: 429,
  })

  assert.equal(action?.severity, 'block')
  assert.equal(action?.cooldownMs, baseInput.rejectedCooldownMs)
})

test('Anthropic overage guard treats policy_disabled as hard block', () => {
  const action = resolveAnthropicOverageDisabledAction({
    ...baseInput,
    reasonRaw: 'policy_disabled',
    unifiedStatus: 'allowed',
  })

  assert.equal(action?.severity, 'block')
  assert.equal(action?.cooldownMs, baseInput.policyDisabledCooldownMs)
})

test('Anthropic overage guard ignores blank and no_overage_purchased reasons', () => {
  assert.equal(resolveAnthropicOverageDisabledAction({ ...baseInput, reasonRaw: '' }), null)
  assert.equal(resolveAnthropicOverageDisabledAction({ ...baseInput, reasonRaw: 'no_overage_purchased' }), null)
})
