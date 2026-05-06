import { get, post } from './client'
import type {
  BillingCurrency,
  BillingBalanceSummary,
  BillingBaseSku,
  BillingChannelMultiplier,
  BillingLineItem,
  BillingLedgerEntry,
  BillingSummary,
  BillingSyncResult,
  BillingUser,
  BillingUserDetail,
} from './types'

const enc = (v: string) => encodeURIComponent(v)

export const getBillingSummary = (since?: string, currency?: BillingCurrency) => {
  const params = new URLSearchParams()
  if (since) params.set('since', since)
  if (currency) params.set('currency', currency)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return get<BillingSummary>(`/admin/billing/summary${suffix}`)
}

export const getBillingUsers = (since?: string, currency?: BillingCurrency) => {
  const params = new URLSearchParams()
  if (since) params.set('since', since)
  if (currency) params.set('currency', currency)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return get<{ users: BillingUser[]; currency: BillingCurrency }>(`/admin/billing/users${suffix}`)
}

export const getBillingUserDetail = (userId: string, since?: string) =>
  get<BillingUserDetail>(`/admin/billing/users/${enc(userId)}${since ? '?since=' + encodeURIComponent(since) : ''}`)

export const getBillingUserItems = (userId: string, limit = 100, offset = 0, since?: string) => {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (since) params.set('since', since)
  return get<{ items: BillingLineItem[]; total: number }>(`/admin/billing/users/${enc(userId)}/items?${params.toString()}`)
}

export const getBillingUserBalance = (userId: string) =>
  get<BillingBalanceSummary>(`/admin/billing/users/${enc(userId)}/balance`)

export const getBillingUserLedger = (userId: string, limit = 100, offset = 0, kind?: BillingLedgerEntry['kind'] | 'all') => {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (kind && kind !== 'all') params.set('kind', kind)
  return get<{ entries: BillingLedgerEntry[]; total: number }>(`/admin/billing/users/${enc(userId)}/ledger?${params.toString()}`)
}

export const createBillingLedgerEntry = (
  userId: string,
  payload: { kind: 'topup' | 'manual_adjustment'; amountMicros: string; note?: string },
) =>
  post<{ ok: true; entry: BillingLedgerEntry; balance: BillingBalanceSummary }>(
    `/admin/billing/users/${enc(userId)}/ledger`,
    payload,
  )

export const getBillingOrganizationBalance = (organizationId: string) =>
  get<BillingBalanceSummary>(`/admin/billing/organizations/${enc(organizationId)}/balance`)

export const getBillingOrganizationLedger = (organizationId: string, limit = 100, offset = 0) => {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return get<{ entries: BillingLedgerEntry[]; total: number }>(`/admin/billing/organizations/${enc(organizationId)}/ledger?${params.toString()}`)
}

export const createBillingOrganizationLedgerEntry = (
  organizationId: string,
  payload: { kind: 'topup' | 'manual_adjustment'; amountMicros: string; note?: string },
) =>
  post<{ ok: true; entry: BillingLedgerEntry; balance: BillingBalanceSummary }>(
    `/admin/billing/organizations/${enc(organizationId)}/ledger`,
    payload,
  )

export const listBaseSkus = () =>
  get<{ skus: BillingBaseSku[] }>('/admin/billing/base-skus')

export const upsertBaseSku = (payload: Partial<BillingBaseSku> & {
  provider: BillingBaseSku['provider']
  modelVendor?: BillingBaseSku['modelVendor']
  protocol?: BillingBaseSku['protocol']
  model: string
  currency: BillingCurrency
}) =>
  post<{ ok: true; sku: BillingBaseSku; result: BillingSyncResult }>('/admin/billing/base-skus', payload)

export const deleteBaseSku = (skuId: string) =>
  post<{ ok: true }>(`/admin/billing/base-skus/${enc(skuId)}/delete`)

export const listChannelMultipliers = (routingGroupId?: string) => {
  const suffix = routingGroupId ? `?routingGroupId=${encodeURIComponent(routingGroupId)}` : ''
  return get<{ multipliers: BillingChannelMultiplier[] }>(`/admin/billing/channel-multipliers${suffix}`)
}

export const upsertChannelMultiplier = (payload: {
  routingGroupId: string
  provider: BillingChannelMultiplier['provider']
  modelVendor?: BillingChannelMultiplier['modelVendor']
  protocol?: BillingChannelMultiplier['protocol']
  model: string
  multiplierMicros?: string | number
  isActive?: boolean
  showInFrontend?: boolean
  allowCalls?: boolean
}) =>
  post<{ ok: true; multiplier: BillingChannelMultiplier; result: BillingSyncResult }>(
    '/admin/billing/channel-multipliers',
    payload,
  )

export const deleteChannelMultiplier = (multiplierId: string) =>
  post<{ ok: true }>(`/admin/billing/channel-multipliers/${enc(multiplierId)}/delete`)

export const copyChannelMultipliers = (payload: {
  fromRoutingGroupId: string
  toRoutingGroupId: string
  overwrite?: boolean
}) =>
  post<{ ok: true; copied: number; skipped: number }>('/admin/billing/channel-multipliers/copy', payload)

export const bulkAdjustChannelMultipliers = (payload: {
  routingGroupId: string
  multiplierIds?: string[]
  scale?: number
  setMultiplierMicros?: string
}) =>
  post<{ ok: true; updated: number }>('/admin/billing/channel-multipliers/bulk-adjust', payload)

export const syncBilling = (reconcileMissing = false) =>
  post<{ ok: true; result: BillingSyncResult }>('/admin/billing/sync', { reconcileMissing })

export const rebuildBilling = () =>
  post<{ ok: true; result: BillingSyncResult }>('/admin/billing/rebuild')
