import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSessionAnchorId,
  buildSessionRequestAnchorId,
  buildLegacyRequestsHref,
  buildRequestDetailHref,
  buildUserDetailReturnHref,
  buildUsersHref,
  buildUserDetailHref,
  isRestoredSessionRequestHighlighted,
  normalizeUserDetailRelayKeySource,
  readUserDetailPageState,
  readUserDetailReturnState,
  readUsersListReturnState,
  RESTORED_SESSION_REQUEST_HIGHLIGHT_MS,
  resolveExpandedSessionKey,
  resolveRestoredSessionRequestId,
} from './userDetailLinks.js'

test('buildUserDetailHref preserves existing URL filter semantics', () => {
  assert.equal(
    buildUserDetailHref('user-a', {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
    }),
    '/users/user-a?device=device-1&relayKeySource=relay_users_legacy',
  )
})

test('buildUserDetailHref can carry users list return state', () => {
  assert.equal(
    buildUserDetailHref(
      'user-a',
      {
        relayKeySource: 'relay_users_legacy',
      },
      undefined,
      {
        legacyView: 'legacy-only',
        legacyOrder: 'legacy-first',
      },
    ),
    '/users/user-a?relayKeySource=relay_users_legacy&returnLegacyView=legacy-only&returnLegacyOrder=legacy-first',
  )
})

test('buildUserDetailHref can append requests hash for deep links', () => {
  assert.equal(
    buildUserDetailHref('user-a', {
      relayKeySource: 'relay_api_keys',
    }, 'requests'),
    '/users/user-a?relayKeySource=relay_api_keys#requests',
  )
})

test('buildLegacyRequestsHref targets the legacy-only requests view and preserves return state', () => {
  assert.equal(
    buildLegacyRequestsHref('relay user/1', {
      legacyView: 'legacy-only',
      legacyOrder: 'legacy-first',
    }),
    '/users/relay%20user%2F1?relayKeySource=relay_users_legacy&returnLegacyView=legacy-only&returnLegacyOrder=legacy-first#requests',
  )
})

test('buildRequestDetailHref preserves usageRecordId and user detail return state', () => {
  assert.equal(
    buildRequestDetailHref('relay user/1', 'req/2', {
      usageRecordId: 17,
      returnState: {
        device: 'device-1',
        relayKeySource: 'relay_users_legacy',
        sessionKey: 'session-1',
        usersListReturnState: {
          legacyView: 'legacy-only',
          legacyOrder: 'legacy-first',
        },
      },
    }),
    '/users/relay%20user%2F1/requests/req%2F2?usageRecordId=17&returnDevice=device-1&returnRelayKeySource=relay_users_legacy&returnSessionKey=session-1&returnLegacyView=legacy-only&returnLegacyOrder=legacy-first',
  )
})

test('buildUsersHref restores the users list state while omitting defaults', () => {
  assert.equal(
    buildUsersHref({
      legacyView: 'legacy-only',
      legacyOrder: 'legacy-first',
    }),
    '/users?legacyView=legacy-only&legacyOrder=legacy-first',
  )
  assert.equal(
    buildUsersHref({
      legacyView: 'all',
      legacyOrder: 'default',
    }),
    '/users',
  )
})

test('normalizeUserDetailRelayKeySource preserves the existing accepted values and rejects everything else', () => {
  assert.equal(normalizeUserDetailRelayKeySource('relay_api_keys'), 'relay_api_keys')
  assert.equal(normalizeUserDetailRelayKeySource('relay_users_legacy'), 'relay_users_legacy')
  assert.equal(normalizeUserDetailRelayKeySource('bad'), null)
  assert.equal(normalizeUserDetailRelayKeySource(null), null)
})

test('readUsersListReturnState normalizes missing or invalid return state params', () => {
  assert.deepEqual(
    readUsersListReturnState(new URLSearchParams('returnLegacyView=legacy-only&returnLegacyOrder=legacy-first')),
    {
      legacyView: 'legacy-only',
      legacyOrder: 'legacy-first',
    },
  )
  assert.deepEqual(
    readUsersListReturnState(new URLSearchParams('returnLegacyView=invalid&returnLegacyOrder=bad')),
    {
      legacyView: 'all',
      legacyOrder: 'default',
    },
  )
})

test('readUserDetailPageState centralizes current user detail filters and return-state recovery params', () => {
  assert.deepEqual(
    readUserDetailPageState(new URLSearchParams('device=device-1&relayKeySource=relay_users_legacy&sessionKey=session-1&sessionRequestId=req-2&returnLegacyView=legacy-only&returnLegacyOrder=legacy-first')),
    {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
      sessionKey: 'session-1',
      sessionRequestId: 'req-2',
      usersListReturnState: {
        legacyView: 'legacy-only',
        legacyOrder: 'legacy-first',
      },
    },
  )
  assert.deepEqual(
    readUserDetailPageState(new URLSearchParams('relayKeySource=bad&sessionKey=&sessionRequestId=')),
    {
      device: null,
      relayKeySource: null,
      sessionKey: null,
      sessionRequestId: null,
      usersListReturnState: {
        legacyView: 'all',
        legacyOrder: 'default',
      },
    },
  )
})

test('readUserDetailReturnState normalizes missing or invalid request detail return params', () => {
  assert.deepEqual(
    readUserDetailReturnState(new URLSearchParams('returnDevice=device-1&returnRelayKeySource=relay_users_legacy&returnSessionKey=session-1&returnLegacyView=legacy-only&returnLegacyOrder=legacy-first')),
    {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
      sessionKey: 'session-1',
      usersListReturnState: {
        legacyView: 'legacy-only',
        legacyOrder: 'legacy-first',
      },
    },
  )
  assert.deepEqual(
    readUserDetailReturnState(new URLSearchParams('returnDevice=&returnRelayKeySource=bad&returnLegacyView=invalid&returnLegacyOrder=nope')),
    {
      device: null,
      relayKeySource: null,
      sessionKey: null,
      usersListReturnState: {
        legacyView: 'all',
        legacyOrder: 'default',
      },
    },
  )
})

test('buildUserDetailReturnHref restores user detail filters and requests anchor', () => {
  assert.equal(
    buildUserDetailReturnHref('user-a', {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
      usersListReturnState: {
        legacyView: 'legacy-only',
        legacyOrder: 'legacy-first',
      },
    }),
    '/users/user-a?device=device-1&relayKeySource=relay_users_legacy&returnLegacyView=legacy-only&returnLegacyOrder=legacy-first#requests',
  )
  assert.equal(
    buildUserDetailReturnHref('user-a', {
      device: 'device-1',
      relayKeySource: 'relay_users_legacy',
      sessionKey: 'session/1',
      usersListReturnState: {
        legacyView: 'legacy-only',
        legacyOrder: 'legacy-first',
      },
    }, {
      sessionRequestId: 'req/2',
    }),
    '/users/user-a?device=device-1&relayKeySource=relay_users_legacy&sessionKey=session%2F1&sessionRequestId=req%2F2&returnLegacyView=legacy-only&returnLegacyOrder=legacy-first#session-session%2F1',
  )
  assert.equal(
    buildUserDetailReturnHref('user-a', null),
    '/users/user-a#requests',
  )
})

test('buildSessionAnchorId percent-encodes session keys for stable hash ids', () => {
  assert.equal(
    buildSessionAnchorId('session/1'),
    'session-session%2F1',
  )
})

test('buildSessionRequestAnchorId encodes session and request ids for stable row anchors', () => {
  assert.equal(
    buildSessionRequestAnchorId('session/1', 'req/2'),
    'session-request-session%2F1--req%2F2',
  )
})

test('resolveExpandedSessionKey only restores session keys that are present in the rendered list', () => {
  const sessions = [
    { sessionKey: 'session-1' },
    { sessionKey: 'session-2' },
  ]
  assert.equal(resolveExpandedSessionKey('session-2', sessions), 'session-2')
  assert.equal(resolveExpandedSessionKey(' missing ', sessions), null)
  assert.equal(resolveExpandedSessionKey('', sessions), null)
})

test('resolveRestoredSessionRequestId only restores request ids present in the rendered session table', () => {
  const requests = [
    { requestId: 'req-1' },
    { requestId: 'req-2' },
  ]
  assert.equal(resolveRestoredSessionRequestId('req-2', requests), 'req-2')
  assert.equal(resolveRestoredSessionRequestId(' missing ', requests), null)
  assert.equal(resolveRestoredSessionRequestId('', requests), null)
})

test('isRestoredSessionRequestHighlighted only marks the active restored row during the temporary highlight window', () => {
  assert.equal(RESTORED_SESSION_REQUEST_HIGHLIGHT_MS > 0, true)
  assert.equal(isRestoredSessionRequestHighlighted('req-2', 'req-2'), true)
  assert.equal(isRestoredSessionRequestHighlighted('req-1', 'req-2'), false)
  assert.equal(isRestoredSessionRequestHighlighted('req-2', null), false)
})
