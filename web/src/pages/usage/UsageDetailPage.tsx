import { useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { getUsageAccountDetail } from '~/api/usage'
import { probeRateLimit } from '~/api/accounts'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { Badge } from '~/components/Badge'
import { fmtTokens, fmtNum, timeAgo, isoDaysAgo } from '~/lib/format'
import { cn } from '~/lib/cn'

type Period = '7d' | '30d' | '90d' | 'all'

export function UsageDetailPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const navigate = useNavigate()
  const [period, setPeriod] = useState<Period>('7d')
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : null
  const since = days ? isoDaysAgo(days) : undefined

  const detail = useQuery({
    queryKey: ['usage-detail', accountId, period],
    queryFn: () => getUsageAccountDetail(accountId!, since),
  })

  const rateLimit = useQuery({
    queryKey: ['ratelimit', accountId],
    queryFn: () => probeRateLimit(accountId!),
    staleTime: 2 * 60 * 1000,
    enabled: false,
  })

  if (detail.isLoading) return <PageSkeleton />
  if (detail.error) return <div className="text-red-400 text-sm">Failed to load usage detail: {(detail.error as Error).message}</div>

  const d = detail.data!
  const history = d.rateLimits
  const modelBreakdown = d.byModel ?? []
  const hasHistoricalRateLimits = Boolean(
    history?.latestStatus ||
    history?.latest5hUtilization != null ||
    history?.latest7dUtilization != null,
  )

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/usage')} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Usage</button>

      <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
        <h2 className="text-lg font-bold text-slate-100 mb-1">{d.emailAddress ?? d.label ?? d.accountId}</h2>
        <div className="flex gap-2 text-xs text-slate-400">
          <Badge tone="blue">{fmtNum(d.totalRequests)} requests</Badge>
          <Badge tone="cyan">{fmtTokens(d.totalInputTokens + d.totalOutputTokens)} total tokens</Badge>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {(['7d', '30d', '90d', 'all'] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={cn(
              'px-3 py-1 rounded-lg text-xs font-medium',
              period === p ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40' : 'text-slate-400 border border-ccdash-border',
            )}
          >
            {p === 'all' ? 'All' : p}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        <StatCard value={fmtNum(d.totalRequests)} label="Requests" />
        <StatCard value={fmtTokens(d.totalInputTokens)} label="Input Tokens" />
        <StatCard value={fmtTokens(d.totalOutputTokens)} label="Output Tokens" />
      </div>

      <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Rate Limit Snapshot</div>
          <button
            onClick={() => rateLimit.refetch()}
            disabled={rateLimit.isFetching}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
          >
            {rateLimit.isFetching ? 'Probing...' : rateLimit.data ? 'Refresh' : 'Probe'}
          </button>
        </div>
        {rateLimit.data ? (
          <div className="space-y-2">
            <StatusLine label="Live Probe" status={rateLimit.data.status ?? rateLimit.data.kind ?? null} />
            {rateLimit.data.fiveHourUtilization != null && (
              <UtilBar label="5h" pct={rateLimit.data.fiveHourUtilization} reset={rateLimit.data.fiveHourReset} />
            )}
            {rateLimit.data.sevenDayUtilization != null && (
              <UtilBar label="7d" pct={rateLimit.data.sevenDayUtilization} reset={rateLimit.data.sevenDayReset} />
            )}
            {rateLimit.data.probedAt && <div className="text-[10px] text-slate-500">Probed {timeAgo(rateLimit.data.probedAt)}</div>}
          </div>
        ) : hasHistoricalRateLimits ? (
          <div className="space-y-2">
            <StatusLine label="Latest Seen" status={history?.latestStatus ?? null} />
            {history?.latest5hUtilization != null && <UtilBar label="5h" pct={history.latest5hUtilization} />}
            {history?.latest7dUtilization != null && <UtilBar label="7d" pct={history.latest7dUtilization} />}
            <div className="text-[10px] text-slate-500">Historical snapshot from usage records.</div>
          </div>
        ) : (
          <div className="text-sm text-slate-500">Click "Probe" to check rate limits.</div>
        )}
      </section>

      {modelBreakdown.length > 0 && (
        <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Model Breakdown</div>
          <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            {modelBreakdown.map((m) => (
              <div key={m.model} className="bg-ccdash-card-strong rounded-lg p-3">
                <div className="text-sm font-medium text-slate-200 mb-1">{m.model}</div>
                <div className="text-xs text-slate-400 space-x-3">
                  <span>{fmtNum(m.totalRequests)} req</span>
                  <span>{fmtTokens(m.totalInputTokens)} in</span>
                  <span>{fmtTokens(m.totalOutputTokens)} out</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function StatusLine({ label, status }: { label: string; status: string | null }) {
  if (!status) {
    return null
  }

  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-500">{label}</span>
      <Badge tone={statusTone(status)}>{status}</Badge>
    </div>
  )
}

function UtilBar({ label, pct, reset }: { label: string; pct: number; reset?: string }) {
  const color = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>{label} — {Math.round(pct)}%</span>
        {reset && <span>Reset: {timeAgo(reset)}</span>}
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

function statusTone(status: string): 'green' | 'yellow' | 'red' | 'gray' {
  const normalized = status.toLowerCase()
  if (normalized.includes('ok') || normalized.includes('healthy') || normalized.includes('safe')) {
    return 'green'
  }
  if (normalized.includes('warn') || normalized.includes('near') || normalized.includes('limit')) {
    return 'yellow'
  }
  if (normalized.includes('exceed') || normalized.includes('block') || normalized.includes('error')) {
    return 'red'
  }
  return 'gray'
}
