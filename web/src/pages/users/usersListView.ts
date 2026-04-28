import type { User } from '~/api/types'

export type UsersLegacyViewMode = 'all' | 'legacy-only'
export type UsersLegacyOrderMode = 'default' | 'legacy-first'

export function normalizeUsersLegacyViewMode(value: string | null | undefined): UsersLegacyViewMode {
  return value === 'legacy-only' ? 'legacy-only' : 'all'
}

export function normalizeUsersLegacyOrderMode(value: string | null | undefined): UsersLegacyOrderMode {
  return value === 'legacy-first' ? 'legacy-first' : 'default'
}

export function getLegacyFallbackCount(user: Pick<User, 'relayKeySourceSummary'>): number {
  return user.relayKeySourceSummary?.legacyFallbackCount ?? 0
}

function getRecentRequestCount(user: Pick<User, 'relayKeySourceSummary'>): number {
  return user.relayKeySourceSummary?.countedRequests ?? 0
}

function compareByLegacySignal(
  left: User,
  right: User,
  leftIndex: number,
  rightIndex: number,
): number {
  const legacyDelta = getLegacyFallbackCount(right) - getLegacyFallbackCount(left)
  if (legacyDelta !== 0) {
    return legacyDelta
  }

  const requestDelta = getRecentRequestCount(right) - getRecentRequestCount(left)
  if (requestDelta !== 0) {
    return requestDelta
  }

  return leftIndex - rightIndex
}

export function buildUsersListView(
  users: User[],
  viewMode: UsersLegacyViewMode,
  orderMode: UsersLegacyOrderMode,
): User[] {
  if (viewMode === 'legacy-only') {
    return users
      .map((user, index) => ({ user, index }))
      .filter(({ user }) => getLegacyFallbackCount(user) > 0)
      .sort((left, right) => compareByLegacySignal(left.user, right.user, left.index, right.index))
      .map(({ user }) => user)
  }

  if (orderMode !== 'legacy-first') {
    return users
  }

  return users
    .map((user, index) => ({ user, index }))
    .sort((left, right) => compareByLegacySignal(left.user, right.user, left.index, right.index))
    .map(({ user }) => user)
}
