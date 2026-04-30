import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getBillingSummary,
  getBillingUsers,
  rebuildBilling,
  syncBilling,
} from '~/api/billing'
import type { BillingCurrency } from '~/api/types'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, fmtNum, fmtTokens, isoDaysAgo, timeAgo } from '~/lib/format'

type Period = '7d' | '30d' | '90d' | 'all'

const periods: { id: Period; label: string; days: number | null }[] = [
  { id: '7d', label: '7 Days', days: 7 },
  { id: '30d', label: '30 Days', days: 30 },
  { id: '90d', label: '90 Days', days: 90 },
  { id: 'all', label: 'All Time', days: null },
]

const billingCurrencies: BillingCurrency[] = ['CNY', 'USD']

function statusTone(count: number) {
  if (count <= 0) return 'green' as const
  return 'yellow' as const
}

export function BillingPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const [period, setPeriod] = useState<Period>('30d')
  const [currency, setCurrency] = useState<BillingCurrency>('CNY')
  const days = periods.find((entry) => entry.id === period)?.days ?? 30
  const since = days ? isoDaysAgo(days) : undefined

  const summary = useQuery({ queryKey: ['billing-summary', period, currency], queryFn: () => getBillingSummary(since, currency) })
  const users = useQuery({ queryKey: ['billing-users', period, currency], queryFn: () => getBillingUsers(since, currency) })

  const syncMut = useMutation({
    mutationFn: () => syncBilling(true),
    onSuccess: () => {
      toast.success('Billing sync completed')
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
      qc.invalidateQueries({ queryKey: ['billing-user-items'] })
    },
    onError: (error) => toast.error(error.message),
  })

  const rebuildMut = useMutation({
    mutationFn: rebuildBilling,
    onSuccess: () => {
      toast.success('Billing line items rebuilt')
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
      qc.invalidateQueries({ queryKey: ['billing-user-items'] })
    },
    onError: (error) => toast.error(error.message),
  })

  if (summary.isLoading || users.isLoading) {
    return <PageSkeleton />
  }

  const summaryData = summary.data
  const userRows = users.data?.users ?? []

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Billing Center</div>
          <h2 className="text-xl font-bold text-slate-100">用量与账单（定价请到「模型与定价」页编辑）</h2>
          <p className="text-xs text-slate-500 mt-1">
            价格直接来自模型 SKU，路径为 渠道 → 模型 → 价格。<Link to="/models" className="ml-1 text-indigo-400 hover:underline">前往模型与定价 →</Link>
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {billingCurrencies.map((entry) => (
            <button
              key={entry}
              onClick={() => setCurrency(entry)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                currency === entry
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-bg-card border-border-default text-slate-400 hover:text-slate-200'
              }`}
            >
              {entry === 'CNY' ? 'RMB (CNY)' : 'USD'}
            </button>
          ))}
          {periods.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setPeriod(entry.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                period === entry.id
                  ? 'bg-accent-muted text-indigo-400 border-accent'
                  : 'bg-bg-card border-border-default text-slate-400 hover:text-slate-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
          <button
            onClick={() => syncMut.mutate()}
            disabled={syncMut.isPending}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50"
          >
            Sync
          </button>
          <button
            onClick={() => {
              if (confirm('Rebuild all billing line items from usage_records?')) {
                rebuildMut.mutate()
              }
            }}
            disabled={rebuildMut.isPending}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50"
          >
            Rebuild
          </button>
        </div>
      </div>

      {summaryData && (
        <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
          <StatCard value={fmtMoneyMicros(summaryData.totalAmountMicros, currency)} label="Billed Amount" />
          <StatCard value={fmtNum(summaryData.billedRequests)} label="Billed Requests" />
          <StatCard value={fmtNum(summaryData.uniqueUsers)} label="Active Users" />
          <StatCard value={fmtNum(summaryData.activeSkus)} label="Active SKUs" />
          <StatCard value={fmtTokens(summaryData.totalInputTokens + summaryData.totalOutputTokens)} label="Total Tokens" />
          <StatCard value={fmtNum(summaryData.totalRequests)} label="Tracked Requests" />
          <StatCard
            value={fmtNum(summaryData.missingSkuRequests)}
            label="Missing SKU"
            caption="请求落在没有 SKU 配置的（渠道 × 模型 × 币种）组合上。去模型与定价页补齐对应 SKU 即可。"
          />
          <StatCard value={fmtNum(summaryData.invalidUsageRequests)} label="Invalid Usage" caption="Successful requests with zero extracted token counts." />
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">User Charges</div>
          <div className="text-xs text-slate-500">{userRows.length} users in window</div>
        </div>
        {userRows.length === 0 ? (
          <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs text-sm text-slate-500">
            No billable user activity in this period.
          </div>
        ) : (
          <div className="max-w-full overflow-x-auto bg-bg-card border border-border-default rounded-xl shadow-xs">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                  <th className="text-left py-3 px-3">User</th>
                  <th className="text-right py-3 px-3">Amount</th>
                  <th className="text-right py-3 px-3">Requests</th>
                  <th className="text-right py-3 px-3">Tokens</th>
                  <th className="text-center py-3 px-3">Issues</th>
                  <th className="text-right py-3 px-3">Last Active</th>
                </tr>
              </thead>
              <tbody>
                {userRows.map((user) => {
                    const issueCount = user.missingSkuRequests + user.invalidUsageRequests
                    return (
                      <tr key={user.userId} className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
                        <td className="py-3 px-3">
                          <Link to={`/billing/users/${encodeURIComponent(user.userId)}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 -ml-2 font-medium text-indigo-300 bg-accent-muted border border-blue-500/20 hover:bg-accent-muted hover:text-indigo-200">
                            {user.userName || user.userId}<span className="text-[10px] opacity-80">↗</span>
                          </Link>
                          <div className="text-[11px] text-slate-500 font-mono mt-1">{user.userId}</div>
                        </td>
                        <td className="py-3 px-3 text-right text-slate-200">{fmtMoneyMicros(user.totalAmountMicros, currency)}</td>
                        <td className="py-3 px-3 text-right text-slate-300">{fmtNum(user.totalRequests)}</td>
                        <td className="py-3 px-3 text-right text-slate-300">{fmtTokens(user.totalInputTokens + user.totalOutputTokens)}</td>
                        <td className="py-3 px-3 text-center">
                          <Badge tone={statusTone(issueCount)}>{issueCount === 0 ? 'Clean' : `${issueCount} open`}</Badge>
                        </td>
                        <td className="py-3 px-3 text-right text-slate-500">{user.lastActiveAt ? timeAgo(user.lastActiveAt) : '—'}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
