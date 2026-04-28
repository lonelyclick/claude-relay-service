import { get, post } from './client'
import type {
  BillingCurrency,
  BillingBalanceSummary,
  BillingLineItem,
  BillingLedgerEntry,
  BillingRule,
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

export const getBillingUserLedger = (userId: string, limit = 100, offset = 0) => {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
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

export const listBillingRules = (currency?: BillingCurrency) => {
  const suffix = currency ? `?currency=${encodeURIComponent(currency)}` : ''
  return get<{ rules: BillingRule[]; currency: BillingCurrency }>(`/admin/billing/rules${suffix}`)
}

export const createBillingRule = (payload: Record<string, unknown>) =>
  post<{ ok: true; rule: BillingRule; result: BillingSyncResult; currency: BillingCurrency }>('/admin/billing/rules', payload)

export const updateBillingRule = (ruleId: string, payload: Record<string, unknown>) =>
  post<{ ok: true; rule: BillingRule; currency: BillingCurrency }>(`/admin/billing/rules/${enc(ruleId)}/update`, payload)

export const deleteBillingRule = (ruleId: string) =>
  post<{ ok: true }>(`/admin/billing/rules/${enc(ruleId)}/delete`)

export const syncBilling = (reconcileMissing = false) =>
  post<{ ok: true; result: BillingSyncResult }>('/admin/billing/sync', { reconcileMissing })

export const rebuildBilling = () =>
  post<{ ok: true; result: BillingSyncResult }>('/admin/billing/rebuild')
