import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRequestDetailHref,
  buildSessionAnchorId,
  buildSessionRequestAnchorId,
  buildUserDetailHref,
  buildUserDetailReturnHref,
  buildUsersHref,
  isRestoredSessionRequestHighlighted,
  normalizeUserDetailRelayKeySource,
  readUserDetailPageState,
  readUserDetailReturnState,
  resolveExpandedSessionKey,
  resolveRestoredSessionRequestId,
} from './userDetailLinks.js'

test('normalizeUserDetailRelayKeySource accepts only known key source values', () => {
  assert.equal(normalizeUserDetailRelayKeySource('relay_api_keys'), 'relay_api_keys')
  assert.equal(normalizeUserDetailRelayKeySource('relay_users_legacy'), 'relay_users_legacy')
  assert.equal(normalizeUserDetailRelayKeySource('bad'), null)
  assert.equal(normalizeUserDetailRelayKeySource(null), null)
})

test('buildUsersHref returns the plain users list', () => {
  assert.equal(buildUsersHref(), '/users')
})

test('buildUserDetailHref includes filters and optional hash', () => {
  assert.equal(
    buildUserDetailHref('user-a', {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
    }),
    '/users/user-a?device=device-1&relayKeySource=relay_users_legacy',
  )
  assert.equal(
    buildUserDetailHref('relay user/1', { relayKeySource: 'relay_api_keys' }, 'requests'),
    '/users/relay%20user%2F1?relayKeySource=relay_api_keys#requests',
  )
})

test('buildRequestDetailHref preserves user detail return filters', () => {
  assert.equal(
    buildRequestDetailHref('relay user/1', 'req/2', {
      usageRecordId: 17,
      returnState: {
        device: 'device-1',
        relayKeySource: 'relay_users_legacy',
        sessionKey: 'session-1',
      },
    }),
    '/users/relay%20user%2F1/requests/req%2F2?usageRecordId=17&returnDevice=device-1&returnRelayKeySource=relay_users_legacy&returnSessionKey=session-1',
  )
})

test('readUserDetailPageState normalizes page filters and restored session params', () => {
  assert.deepEqual(
    readUserDetailPageState(new URLSearchParams('device=device-1&relayKeySource=relay_users_legacy&sessionKey=session-1&sessionRequestId=req-2')),
    {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
      sessionKey: 'session-1',
      sessionRequestId: 'req-2',
    },
  )
  assert.deepEqual(
    readUserDetailPageState(new URLSearchParams('relayKeySource=bad&sessionKey=&sessionRequestId=')),
    {
      device: null,
      relayKeySource: null,
      sessionKey: null,
      sessionRequestId: null,
    },
  )
})

test('readUserDetailReturnState normalizes return filters', () => {
  assert.deepEqual(
    readUserDetailReturnState(new URLSearchParams('returnDevice=device-1&returnRelayKeySource=relay_users_legacy&returnSessionKey=session-1')),
    {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
      sessionKey: 'session-1',
    },
  )
  assert.deepEqual(
    readUserDetailReturnState(new URLSearchParams('returnDevice=&returnRelayKeySource=bad')),
    {
      device: null,
      relayKeySource: null,
      sessionKey: null,
    },
  )
})

test('buildUserDetailReturnHref restores filters and session anchor', () => {
  assert.equal(
    buildUserDetailReturnHref('user-a', {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
    }),
    '/users/user-a?device=device-1&relayKeySource=relay_users_legacy#requests',
  )
  assert.equal(
    buildUserDetailReturnHref('user-a', {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
      sessionKey: 'session/1',
    }, {
      sessionRequestId: 'req/2',
    }),
    '/users/user-a?device=device-1&relayKeySource=relay_users_legacy&sessionKey=session%2F1&sessionRequestId=req%2F2#session-session%2F1',
  )
})

test('session anchor helpers encode stable DOM ids', () => {
  assert.equal(buildSessionAnchorId('session/1'), 'session-session%2F1')
  assert.equal(buildSessionRequestAnchorId('session/1', 'req/2'), 'session-request-session%2F1--req%2F2')
})

test('resolveExpandedSessionKey only restores existing sessions', () => {
  const sessions = [{ sessionKey: 'session-1' }, { sessionKey: 'session-2' }]
  assert.equal(resolveExpandedSessionKey('session-2', sessions), 'session-2')
  assert.equal(resolveExpandedSessionKey('missing', sessions), null)
  assert.equal(resolveExpandedSessionKey('', sessions), null)
})

test('resolveRestoredSessionRequestId only restores existing requests', () => {
  const requests = [{ requestId: 'req-1' }, { requestId: 'req-2' }]
  assert.equal(resolveRestoredSessionRequestId('req-2', requests), 'req-2')
  assert.equal(resolveRestoredSessionRequestId('missing', requests), null)
  assert.equal(resolveRestoredSessionRequestId('', requests), null)
})

test('isRestoredSessionRequestHighlighted compares exact request ids', () => {
  assert.equal(isRestoredSessionRequestHighlighted('req-1', 'req-1'), true)
  assert.equal(isRestoredSessionRequestHighlighted('req-1', 'req-2'), false)
  assert.equal(isRestoredSessionRequestHighlighted('req-1', null), false)
})
