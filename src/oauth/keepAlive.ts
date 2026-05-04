import type { StoredAccount } from '../types.js'

export type KeepAliveRefreshReason = 'expiring_soon' | 'stale'

export interface KeepAlivePolicy {
  refreshBeforeMs: number
  forceRefreshMs: number
}

export function getKeepAliveRefreshReason(
  account: StoredAccount,
  now: number,
  policy: KeepAlivePolicy,
): KeepAliveRefreshReason | null {
  if (!account.isActive || account.status === 'revoked' || account.status === 'banned' || !account.refreshToken) {
    return null
  }
  if (account.cooldownUntil !== null && account.cooldownUntil > now) {
    return null
  }

  if (account.expiresAt !== null && now + policy.refreshBeforeMs >= account.expiresAt) {
    return 'expiring_soon'
  }

  if (policy.forceRefreshMs <= 0) {
    return null
  }

  const lastTouchAt = getLastTouchAt(account)
  if (lastTouchAt === null || now - lastTouchAt >= policy.forceRefreshMs) {
    return 'stale'
  }

  return null
}

function getLastTouchAt(account: StoredAccount): number | null {
  const candidates = [
    parseIso(account.lastRefreshAt),
    parseIso(account.lastUsedAt),
    parseIso(account.updatedAt),
    parseIso(account.createdAt),
  ].filter((value): value is number => value !== null)

  if (candidates.length === 0) {
    return null
  }
  return Math.max(...candidates)
}

function parseIso(value: string | null): number | null {
  if (!value) {
    return null
  }
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}
