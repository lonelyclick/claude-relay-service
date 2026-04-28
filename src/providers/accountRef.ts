import type { AccountProvider } from '../types.js'
import { isKnownProviderId } from './catalog.js'

export type ParsedProviderAccountRef = {
  provider: AccountProvider
  accountId: string
}

export function buildProviderScopedAccountId(
  provider: AccountProvider,
  accountId: string,
): string {
  const normalized = accountId.trim()
  if (!normalized) {
    throw new Error('accountId must not be empty')
  }
  return normalized.startsWith(`${provider}:`) ? normalized : `${provider}:${normalized}`
}

export function parseProviderScopedAccountRef(
  rawValue: string,
): ParsedProviderAccountRef | null {
  const normalized = rawValue.trim()
  if (!normalized) {
    return null
  }

  const separatorIndex = normalized.indexOf(':')
  if (separatorIndex <= 0) {
    return null
  }

  const provider = normalized.slice(0, separatorIndex)
  if (!isKnownProviderId(provider)) {
    return null
  }

  return {
    provider,
    accountId: normalized.slice(separatorIndex + 1).trim(),
  }
}
