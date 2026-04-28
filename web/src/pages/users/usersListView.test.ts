import assert from 'node:assert/strict'
import test from 'node:test'

import type { User } from '~/api/types'

import {
  buildUsersListView,
  getLegacyFallbackCount,
  normalizeUsersLegacyOrderMode,
  normalizeUsersLegacyViewMode,
} from './usersListView.js'

function makeUser(
  id: string,
  name: string,
  summary?: {
    recentWindowLimit: number
    countedRequests: number
    relayApiKeysCount: number
    legacyFallbackCount: number
  },
): User {
  return {
    id,
    name,
    isActive: true,
    relayKeySourceSummary: summary,
  }
}

test('normalizeUsersLegacyViewMode defaults invalid values to all', () => {
  assert.equal(normalizeUsersLegacyViewMode('legacy-only'), 'legacy-only')
  assert.equal(normalizeUsersLegacyViewMode('anything-else'), 'all')
  assert.equal(normalizeUsersLegacyViewMode(null), 'all')
})

test('normalizeUsersLegacyOrderMode defaults invalid values to default', () => {
  assert.equal(normalizeUsersLegacyOrderMode('legacy-first'), 'legacy-first')
  assert.equal(normalizeUsersLegacyOrderMode('anything-else'), 'default')
  assert.equal(normalizeUsersLegacyOrderMode(null), 'default')
})

test('getLegacyFallbackCount treats missing summary as zero', () => {
  assert.equal(getLegacyFallbackCount(makeUser('user-a', 'Alpha')), 0)
  assert.equal(
    getLegacyFallbackCount(
      makeUser('user-b', 'Beta', {
        recentWindowLimit: 100,
        countedRequests: 3,
        relayApiKeysCount: 1,
        legacyFallbackCount: 2,
      }),
    ),
    2,
  )
})

test('buildUsersListView preserves list order in all mode', () => {
  const users = [
    makeUser('user-a', 'Alpha', {
      recentWindowLimit: 100,
      countedRequests: 2,
      relayApiKeysCount: 1,
      legacyFallbackCount: 1,
    }),
    makeUser('user-b', 'Beta', {
      recentWindowLimit: 100,
      countedRequests: 4,
      relayApiKeysCount: 4,
      legacyFallbackCount: 0,
    }),
  ]

  const result = buildUsersListView(users, 'all', 'default')
  assert.deepEqual(
    result.map((user) => user.id),
    ['user-a', 'user-b'],
  )
  assert.equal(result, users)
})

test('buildUsersListView sorts all users with recent legacy fallback first when requested', () => {
  const users = [
    makeUser('user-a', 'Alpha', {
      recentWindowLimit: 100,
      countedRequests: 4,
      relayApiKeysCount: 2,
      legacyFallbackCount: 2,
    }),
    makeUser('user-b', 'Beta', {
      recentWindowLimit: 100,
      countedRequests: 7,
      relayApiKeysCount: 4,
      legacyFallbackCount: 3,
    }),
    makeUser('user-c', 'Gamma', {
      recentWindowLimit: 100,
      countedRequests: 6,
      relayApiKeysCount: 6,
      legacyFallbackCount: 0,
    }),
    makeUser('user-d', 'Delta'),
    makeUser('user-e', 'Epsilon', {
      recentWindowLimit: 100,
      countedRequests: 4,
      relayApiKeysCount: 3,
      legacyFallbackCount: 1,
    }),
  ]

  const result = buildUsersListView(users, 'all', 'legacy-first')
  assert.deepEqual(
    result.map((user) => user.id),
    ['user-b', 'user-a', 'user-e', 'user-c', 'user-d'],
  )
})

test('buildUsersListView keeps legacy-only view focused on recent legacy users regardless of order mode', () => {
  const users = [
    makeUser('user-a', 'Alpha', {
      recentWindowLimit: 100,
      countedRequests: 4,
      relayApiKeysCount: 2,
      legacyFallbackCount: 2,
    }),
    makeUser('user-b', 'Beta', {
      recentWindowLimit: 100,
      countedRequests: 7,
      relayApiKeysCount: 4,
      legacyFallbackCount: 3,
    }),
    makeUser('user-c', 'Gamma', {
      recentWindowLimit: 100,
      countedRequests: 6,
      relayApiKeysCount: 6,
      legacyFallbackCount: 0,
    }),
    makeUser('user-d', 'Delta'),
    makeUser('user-e', 'Epsilon', {
      recentWindowLimit: 100,
      countedRequests: 4,
      relayApiKeysCount: 3,
      legacyFallbackCount: 1,
    }),
  ]

  const defaultOrder = buildUsersListView(users, 'legacy-only', 'default')
  const legacyFirstOrder = buildUsersListView(users, 'legacy-only', 'legacy-first')

  assert.deepEqual(
    defaultOrder.map((user) => user.id),
    ['user-b', 'user-a', 'user-e'],
  )
  assert.deepEqual(
    legacyFirstOrder.map((user) => user.id),
    ['user-b', 'user-a', 'user-e'],
  )
})
