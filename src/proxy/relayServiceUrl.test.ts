import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSanitizedUpstreamUrl } from './relayService.js'

test('buildSanitizedUpstreamUrl strips relay-only query parameters', () => {
  const url = buildSanitizedUpstreamUrl(
    '/v1/messages?beta=true&force_account=a&force_account=b&x-force-account=c&account_group=vip&x-account-group=ops',
    'https://api.anthropic.com',
  )

  assert.equal(url.origin, 'https://api.anthropic.com')
  assert.equal(url.pathname, '/v1/messages')
  assert.equal(url.searchParams.get('beta'), 'true')
  assert.equal(url.searchParams.has('force_account'), false)
  assert.equal(url.searchParams.has('x-force-account'), false)
  assert.equal(url.searchParams.has('account_group'), false)
  assert.equal(url.searchParams.has('x-account-group'), false)
})
