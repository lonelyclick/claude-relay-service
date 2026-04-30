import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getUserDetailLedgerKindLabel,
  getUserDetailLedgerKindTone,
  getUserDetailRelayKeySourceLabel,
  getUserDetailRelayKeySourceTone,
  userDetailRelayKeySourceOptions,
} from './userDetailPresentation.js'

test('userDetailRelayKeySourceOptions preserves the existing selectable relay key source filters', () => {
  assert.deepEqual(userDetailRelayKeySourceOptions, [
    { value: 'relay_api_keys', label: 'relay_api_keys' },
    { value: 'relay_users_legacy', label: 'legacy key' },
  ])
})

test('getUserDetailRelayKeySourceLabel preserves the current badge and filter labels', () => {
  assert.equal(getUserDetailRelayKeySourceLabel('relay_api_keys'), 'relay_api_keys')
  assert.equal(getUserDetailRelayKeySourceLabel('relay_users_legacy'), 'legacy key')
  assert.equal(getUserDetailRelayKeySourceLabel(null), 'All key sources')
})

test('getUserDetailRelayKeySourceTone preserves the current badge color mapping', () => {
  assert.equal(getUserDetailRelayKeySourceTone('relay_api_keys'), 'cyan')
  assert.equal(getUserDetailRelayKeySourceTone('relay_users_legacy'), 'yellow')
  assert.equal(getUserDetailRelayKeySourceTone(undefined), 'gray')
})

test('getUserDetailLedgerKindLabel preserves the current ledger badge labels', () => {
  assert.equal(getUserDetailLedgerKindLabel('topup'), 'Top-up')
  assert.equal(getUserDetailLedgerKindLabel('manual_adjustment'), 'Adjustment')
  assert.equal(getUserDetailLedgerKindLabel('usage_debit'), 'Usage')
})

test('getUserDetailLedgerKindTone preserves the current ledger badge colors', () => {
  assert.equal(getUserDetailLedgerKindTone('topup'), 'green')
  assert.equal(getUserDetailLedgerKindTone('manual_adjustment'), 'yellow')
  assert.equal(getUserDetailLedgerKindTone('usage_debit'), 'red')
})
