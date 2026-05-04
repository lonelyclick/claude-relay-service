import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTerminalAccountFailureReason } from './relayService.js'

test('classifies Claude organization no-access as terminal account failure', () => {
  assert.equal(
    classifyTerminalAccountFailureReason(
      403,
      'Your organization does not have access to Claude. Please login again or contact your administrator.',
    ),
    'account_disabled_organization',
  )
})

test('does not classify Claude organization no-access on retryable status', () => {
  assert.equal(
    classifyTerminalAccountFailureReason(
      429,
      'Your organization does not have access to Claude. Please login again or contact your administrator.',
    ),
    null,
  )
})

test('classifies organization oauth-disabled as terminal account failure', () => {
  assert.equal(
    classifyTerminalAccountFailureReason(
      403,
      'OAuth authentication is currently not allowed for this organization.',
    ),
    'account_disabled_organization',
  )
})
