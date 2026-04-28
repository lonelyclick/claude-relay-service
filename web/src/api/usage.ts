import { get } from './client'
import type { UsageSummary, UsageAccount, UsageAccountDetail, UsageTrendDay } from './types'

function toPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return value * 100
}

export const getUsageSummary = (since?: string) =>
  get<UsageSummary>(`/admin/usage/summary${since ? '?since=' + encodeURIComponent(since) : ''}`)
export const getUsageAccounts = (since?: string) =>
  get<{ accounts: UsageAccount[] }>(`/admin/usage/accounts${since ? '?since=' + encodeURIComponent(since) : ''}`)
export const getUsageAccountDetail = async (id: string, since?: string) => {
  const detail = await get<UsageAccountDetail>(`/admin/usage/accounts/${encodeURIComponent(id)}${since ? '?since=' + encodeURIComponent(since) : ''}`)
  return {
    ...detail,
    rateLimits: detail.rateLimits
      ? {
          ...detail.rateLimits,
          latest5hUtilization: toPercent(detail.rateLimits.latest5hUtilization) ?? detail.rateLimits.latest5hUtilization,
          latest7dUtilization: toPercent(detail.rateLimits.latest7dUtilization) ?? detail.rateLimits.latest7dUtilization,
        }
      : detail.rateLimits,
  }
}
export const getUsageTrend = (days: number) =>
  get<{ trend: UsageTrendDay[] }>(`/admin/usage/trend?days=${days}`)
