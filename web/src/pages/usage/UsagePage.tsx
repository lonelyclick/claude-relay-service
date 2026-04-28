import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { getUsageSummary, getUsageAccounts, getUsageTrend } from '~/api/usage'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { fmtTokens, fmtNum, timeAgo, isoDaysAgo } from '~/lib/format'
import { cn } from '~/lib/cn'
import type { UsageTrendDay } from '~/api/types'

type Period = '7d' | '30d' | '90d' | 'all'
const periods: { id: Period; label: string; days: number | null }[] = [
  { id: '7d', label: '7 Days', days: 7 },
  { id: '30d', label: '30 Days', days: 30 },
  { id: '90d', label: '90 Days', days: 90 },
  { id: 'all', label: 'All Time', days: null },
]

export function UsagePage() {
  const [period, setPeriod] = useState<Period>('7d')
  const days = periods.find((p) => p.id === period)!.days
  const since = days ? isoDaysAgo(days) : undefined

  const summary = useQuery({ queryKey: ['usage-summary', period], queryFn: () => getUsageSummary(since) })
  const accounts = useQuery({ queryKey: ['usage-accounts', period], queryFn: () => getUsageAccounts(since) })
  const trend = useQuery({ queryKey: ['usage-trend', period], queryFn: () => getUsageTrend(days ?? 365) })

  if (summary.isLoading) return <PageSkeleton />

  const s = summary.data
  const accts = accounts.data?.accounts ?? []
  const trendDays = trend.data?.trend ?? []

  return (
    <div className="space-y-5">
      <div className="flex gap-2 flex-wrap">
        {periods.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              period === p.id
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                : 'bg-ccdash-card border border-ccdash-border text-slate-400 hover:text-slate-200',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {s && (
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          <StatCard value={fmtNum(s.totalRequests)} label="Total Requests" />
          <StatCard value={fmtTokens(s.totalInputTokens)} label="Input Tokens" />
          <StatCard value={fmtTokens(s.totalOutputTokens)} label="Output Tokens" />
        </div>
      )}

      {trendDays.length > 0 && <TrendChart days={trendDays} />}

      <section>
        <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Account Activity</div>
        {accts.length === 0 ? (
          <div className="text-sm text-slate-500">No usage data for this period.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                  <th className="text-left py-2 px-3">Account</th>
                  <th className="text-right py-2 px-3">Requests</th>
                  <th className="text-right py-2 px-3">Input</th>
                  <th className="text-right py-2 px-3">Output</th>
                  <th className="text-right py-2 px-3">Last Used</th>
                </tr>
              </thead>
              <tbody>
                {[...accts]
                  .sort((a, b) => b.totalInputTokens - a.totalInputTokens)
                  .map((a) => (
                    <tr key={a.accountId} className="border-b border-ccdash-border/50 hover:bg-ccdash-card-strong/30">
                      <td className="py-2 px-3">
                        <Link to={`/usage/${encodeURIComponent(a.accountId)}`} className="text-blue-400 hover:underline text-xs">
                          {a.emailAddress ?? a.label ?? a.accountId}
                        </Link>
                      </td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtNum(a.totalRequests)}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtTokens(a.totalInputTokens)}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtTokens(a.totalOutputTokens)}</td>
                      <td className="py-2 px-3 text-right text-slate-500 text-xs">{a.lastUsedAt ? timeAgo(a.lastUsedAt) : '—'}</td>
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

function TrendChart({ days }: { days: UsageTrendDay[] }) {
  const maxTokens = Math.max(...days.map((d) => d.totalInputTokens + d.totalOutputTokens), 1)
  const maxReq = Math.max(...days.map((d) => d.totalRequests), 1)
  const w = 600
  const h = 120
  const barW = Math.max(2, Math.floor((w - 40) / days.length) - 1)

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-4 overflow-x-auto">
      <div className="text-xs text-slate-400 mb-2">Daily Trend</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-[600px]" preserveAspectRatio="none">
        {days.map((d, i) => {
          const x = 20 + i * (barW + 1)
          const barH = ((d.totalInputTokens + d.totalOutputTokens) / maxTokens) * (h - 20)
          return <rect key={i} x={x} y={h - 10 - barH} width={barW} height={barH} fill="rgba(59,130,246,0.5)" rx={1} />
        })}
        <polyline
          fill="none"
          stroke="#f59e0b"
          strokeWidth={1.5}
          points={days.map((d, i) => {
            const x = 20 + i * (barW + 1) + barW / 2
            const y = h - 10 - (d.totalRequests / maxReq) * (h - 20)
            return `${x},${y}`
          }).join(' ')}
        />
      </svg>
      <div className="flex gap-4 mt-1 text-[10px] text-slate-500">
        <span><span className="inline-block w-2 h-2 bg-blue-500/50 rounded mr-1" />Tokens</span>
        <span><span className="inline-block w-2 h-2 bg-amber-500 rounded mr-1" />Requests</span>
      </div>
    </div>
  )
}
