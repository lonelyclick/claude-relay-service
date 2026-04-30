import type { BillingLedgerEntry, RelayKeySource } from '~/api/types'
import type { BadgeTone } from '~/components/Badge'

export const userDetailRelayKeySourceOptions: Array<{ value: RelayKeySource; label: string }> = [
  { value: 'relay_api_keys', label: 'relay_api_keys' },
  { value: 'relay_users_legacy', label: 'legacy key' },
]

export function getUserDetailRelayKeySourceLabel(source: RelayKeySource | null | undefined): string {
  if (source === 'relay_api_keys') return 'relay_api_keys'
  if (source === 'relay_users_legacy') return 'legacy key'
  return 'All key sources'
}

export function getUserDetailRelayKeySourceTone(source: RelayKeySource | null | undefined): BadgeTone {
  if (source === 'relay_api_keys') return 'cyan'
  if (source === 'relay_users_legacy') return 'yellow'
  return 'gray'
}

export function getUserDetailLedgerKindLabel(kind: BillingLedgerEntry['kind']): string {
  if (kind === 'topup') return 'Top-up'
  if (kind === 'usage_debit') return 'Usage'
  return 'Adjustment'
}

export function getUserDetailLedgerKindTone(kind: BillingLedgerEntry['kind']): BadgeTone {
  if (kind === 'topup') return 'green'
  if (kind === 'usage_debit') return 'red'
  return 'yellow'
}
