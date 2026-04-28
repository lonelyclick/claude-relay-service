import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'

import { getBillingUserBalance, getBillingUserDetail, getBillingUserItems } from '~/api/billing'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { fmtMoneyMicros, fmtNum, fmtTokens, isoDaysAgo, timeAgo, truncateMiddle } from '~/lib/format'

type Period = '7d' | '30d' | '90d' | 'all'

const periods: { id: Period; label: string; days: number | null }[] = [
  { id: '7d', label: '7 Days', days: 7 },
  { id: '30d', label: '30 Days', days: 30 },
  { id: '90d', label: '90 Days', days: 90 },
  { id: 'all', label: 'All Time', days: null },
]

function itemTone(status: 'billed' | 'missing_rule' | 'invalid_usage') {
  if (status === 'billed') return 'green' as const
  if (status === 'missing_rule') return 'yellow' as const
  return 'red' as const
}

export function BillingUserPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [period, setPeriod] = useState<Period>('30d')
  const days = periods.find((entry) => entry.id === period)?.days ?? 30
  const since = days ? isoDaysAgo(days) : undefined

  const detail = useQuery({
    queryKey: ['billing-user-detail', id, period],
    queryFn: () => getBillingUserDetail(id!, since),
  })
  const balance = useQuery({
    queryKey: ['billing-balance', id],
    queryFn: () => getBillingUserBalance(id!),
    retry: false,
  })
  const items = useQuery({
    queryKey: ['billing-user-items', id, period],
    queryFn: () => getBillingUserItems(id!, 100, 0, since),
  })

  if (detail.isLoading || items.isLoading || balance.isLoading) {
    return <PageSkeleton />
  }
  if (detail.error) {
    return <div className="text-sm text-red-400">Failed to load billing detail: {(detail.error as Error).message}</div>
  }
  if (!detail.data) {
    return <div className="text-sm text-slate-400">Billing user not found.</div>
  }

  const data = detail.data
  const lineItems = items.data?.items ?? []
  const currency = data.currency

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <button onClick={() => navigate('/billing')} className="text-sm text-slate-400 hover:text-slate-200">
            &larr; Back to Billing
          </button>
          <h2 className="text-xl font-bold text-slate-100 mt-2">{data.userName || data.userId}</h2>
          <div className="text-xs font-mono text-slate-500 mt-1">{data.userId}</div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link to={`/users/${encodeURIComponent(data.userId)}`} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-ccdash-card border border-ccdash-border text-slate-300 hover:text-slate-100">
            Open User
          </Link>
          {periods.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setPeriod(entry.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                period === entry.id
                  ? 'bg-blue-500/20 text-blue-400 border-blue-500/40'
                  : 'bg-ccdash-card border-ccdash-border text-slate-400 hover:text-slate-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
        <StatCard value={fmtMoneyMicros(data.totalAmountMicros, currency)} label="Billed Amount" />
        <StatCard value={fmtMoneyMicros(balance.data?.balanceMicros ?? '0', currency)} label="Current Balance" />
        <StatCard value={fmtNum(data.billedRequests)} label="Billed Requests" />
        <StatCard value={fmtNum(data.missingRuleRequests)} label="Missing Rule" />
        <StatCard value={fmtNum(data.invalidUsageRequests)} label="Invalid Usage" />
        <StatCard value={fmtNum(data.totalRequests)} label="Tracked Requests" />
        <StatCard value={fmtTokens(data.totalInputTokens + data.totalOutputTokens)} label="Total Tokens" />
        <StatCard value={fmtMoneyMicros(balance.data?.totalCreditedMicros ?? '0', currency)} label="Credited" />
        <StatCard value={fmtMoneyMicros(balance.data?.totalDebitedMicros ?? '0', currency)} label="Debited" />
      </div>

      <section className="grid grid-cols-2 gap-4 max-xl:grid-cols-1">
        <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Monthly Periods</div>
          {data.byPeriod.length === 0 ? (
            <div className="text-sm text-slate-500">No billing periods yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                    <th className="text-left py-2 px-2">Period</th>
                    <th className="text-right py-2 px-2">Amount</th>
                    <th className="text-right py-2 px-2">Requests</th>
                    <th className="text-right py-2 px-2">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPeriod.map((row) => (
                    <tr key={row.periodStart} className="border-b border-ccdash-border/50">
                      <td className="py-2 px-2 text-slate-200">{row.periodStart}</td>
                      <td className="py-2 px-2 text-right text-slate-200">{fmtMoneyMicros(row.totalAmountMicros, currency)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtNum(row.totalRequests)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtTokens(row.totalInputTokens + row.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Model Mix</div>
          {data.byModel.length === 0 ? (
            <div className="text-sm text-slate-500">No model activity yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                    <th className="text-left py-2 px-2">Model</th>
                    <th className="text-right py-2 px-2">Amount</th>
                    <th className="text-right py-2 px-2">Requests</th>
                    <th className="text-right py-2 px-2">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((row) => (
                    <tr key={row.model} className="border-b border-ccdash-border/50">
                      <td className="py-2 px-2 text-slate-200">{row.model}</td>
                      <td className="py-2 px-2 text-right text-slate-200">{fmtMoneyMicros(row.totalAmountMicros, currency)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtNum(row.totalRequests)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtTokens(row.totalInputTokens + row.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Recent Line Items</div>
          <div className="text-xs text-slate-500">{items.data?.total ?? 0} items</div>
        </div>
        {lineItems.length === 0 ? (
          <div className="text-sm text-slate-500 mt-3">No line items in this period.</div>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                  <th className="text-left py-2 px-2">Request</th>
                  <th className="text-center py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Rule</th>
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-right py-2 px-2">Amount</th>
                  <th className="text-right py-2 px-2">Tokens</th>
                  <th className="text-right py-2 px-2">When</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item) => (
                  <tr key={item.usageRecordId} className="border-b border-ccdash-border/50 hover:bg-ccdash-card-strong/30">
                    <td className="py-2 px-2">
                      <Link
                        to={`/users/${encodeURIComponent(data.userId)}/requests/${encodeURIComponent(item.requestId)}?usageRecordId=${encodeURIComponent(String(item.usageRecordId))}`}
                        className="text-blue-400 hover:underline font-mono text-xs"
                      >
                        {truncateMiddle(item.requestId, 24)}
                      </Link>
                      <div className="text-[11px] text-slate-500 mt-1">{item.target}</div>
                    </td>
                    <td className="py-2 px-2 text-center">
                      <Badge tone={itemTone(item.status)}>{item.status}</Badge>
                    </td>
                    <td className="py-2 px-2 text-slate-300">
                      {item.matchedRuleName || '—'}
                      {item.matchedRuleId && <div className="text-[11px] text-slate-500 font-mono mt-1">{truncateMiddle(item.matchedRuleId, 18)}</div>}
                    </td>
                    <td className="py-2 px-2 text-slate-300">
                      <div>{item.model || '—'}</div>
                      <div className="text-[11px] text-slate-500 mt-1">{item.provider || 'unknown provider'}</div>
                    </td>
                    <td className="py-2 px-2 text-right text-slate-200">{fmtMoneyMicros(item.amountMicros, currency)}</td>
                    <td className="py-2 px-2 text-right text-slate-300">
                      {fmtTokens(item.inputTokens + item.outputTokens + item.cacheCreationTokens + item.cacheReadTokens)}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-500">{timeAgo(item.usageCreatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
