import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLAUDE_OFFICIAL_PROVIDER,
  getProviderProfile,
  resolveProviderProfile,
} from './catalog.js'

test('getProviderProfile returns known provider profile', () => {
  assert.equal(getProviderProfile('claude-official'), CLAUDE_OFFICIAL_PROVIDER)
})

test('resolveProviderProfile rejects missing provider', () => {
  assert.throws(() => resolveProviderProfile(null), /Provider is required/)
  assert.throws(() => resolveProviderProfile(undefined), /Provider is required/)
  assert.throws(() => resolveProviderProfile(''), /Provider is required/)
})

test('resolveProviderProfile rejects unknown provider without defaulting', () => {
  assert.throws(() => resolveProviderProfile('unknown-provider'), /Unknown provider: unknown-provider/)
})
