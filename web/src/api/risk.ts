import { get, post } from './client'
import type {
  AccountLifecycleEvent,
  AccountHealthDistributionRow,
  AccountLifecycleSummary,
  AccountRiskScore,
  EgressRiskSummaryRow,
  RiskDashboardEvent,
  RiskDashboardSummary,
  RiskDashboardTrendPoint,
} from './types'

export interface RiskEventFilters {
  since?: string
  limit?: number
  offset?: number
  userId?: string
  accountId?: string
  sessionKey?: string
  clientDeviceId?: string
  ip?: string
  path?: string
  statusCode?: number
  minTokens?: number
  riskOnly?: boolean
  multiAccountOnly?: boolean
  revokedOnly?: boolean
}

function buildQuery(filters: RiskEventFilters): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'boolean') {
      if (value) params.set(key, '1')
      continue
    }
    params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const getRiskSummary = (since?: string) =>
  get<RiskDashboardSummary>(`/admin/risk/summary${since ? `?since=${encodeURIComponent(since)}` : ''}`)

export const getRiskEvents = (filters: RiskEventFilters) =>
  get<{ events: RiskDashboardEvent[]; total: number }>(`/admin/risk/events${buildQuery(filters)}`)

export const getRiskTrends = (filters: { since?: string; accountId?: string }) =>
  get<{ points: RiskDashboardTrendPoint[] }>(`/admin/risk/trends${buildQuery(filters)}`)

export interface LifecycleEventFilters {
  accountId?: string
  eventTypes?: string[]
  since?: string
  until?: string
  limit?: number
}

function buildLifecycleQuery(filters: LifecycleEventFilters): string {
  const params = new URLSearchParams()
  if (filters.accountId) params.set('accountId', filters.accountId)
  if (filters.eventTypes?.length) params.set('eventTypes', filters.eventTypes.join(','))
  if (filters.since) params.set('since', filters.since)
  if (filters.until) params.set('until', filters.until)
  if (filters.limit) params.set('limit', String(filters.limit))
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const getLifecycleSummary = (limit = 100) =>
  get<{ accounts: AccountLifecycleSummary[] }>(`/admin/risk/lifecycle/summary?limit=${limit}`)

export const getLifecycleEvents = (filters: LifecycleEventFilters) =>
  get<{ events: AccountLifecycleEvent[] }>(`/admin/risk/lifecycle/events${buildLifecycleQuery(filters)}`)


export interface NaturalCapacityConfig {
  enabled: boolean
  userDeviceMaxAccounts24h: number
  newAccountNewSessionOnlyHours: number
  heavySessionAccountMinAgeHours: number
  heavySessionTokens: number
  heavySessionCacheReadTokens: number
}

export const getNaturalCapacityConfig = () =>
  get<NaturalCapacityConfig>('/admin/risk/natural-capacity-config')

export const getAccountRiskScores = (refresh = false) =>
  get<{ accounts: AccountRiskScore[] }>(`/admin/risk/account-scores${refresh ? '?refresh=1' : ''}`)

export const refreshAccountRiskScores = () =>
  post<{ ok: true; accounts: AccountRiskScore[] }>('/admin/risk/account-scores/refresh')

export const getAccountRiskHistory = (accountId: string, limit = 96) =>
  get<{ points: AccountRiskScore[] }>(`/admin/risk/account-scores/${encodeURIComponent(accountId)}/history?limit=${limit}`)

export const getAccountHealthDistribution = (since?: string) =>
  get<{ accounts: AccountHealthDistributionRow[] }>(`/admin/risk/account-health-distribution${since ? `?since=${encodeURIComponent(since)}` : ''}`)

export const getEgressRiskSummary = () =>
  get<{ egress: EgressRiskSummaryRow[] }>('/admin/risk/egress-summary')
