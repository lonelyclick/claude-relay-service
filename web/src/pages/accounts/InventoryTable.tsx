import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Badge, type BadgeTone } from '~/components/Badge'
import { cn } from '~/lib/cn'
import { timeAgo } from '~/lib/format'
import {
  formatResetCountdown,
  formatUtilPct,
  getAccountSeverity,
  getSeverityClasses,
  getUtilSeverity,
  normalizeReset,
  type Severity,
  SEVERITY_RANK,
} from '~/lib/rateLimit'
import { accountPlanLabel } from '~/lib/account'
import type { Account } from '~/api/types'

type SortKey = 'severity' | 'account' | 'provider' | 'state' | '5h' | '7d' | 'reset' | 'probed'
type SortDir = 'asc' | 'desc'

const STALE_PROBE_MS = 30 * 60 * 1000

function schedulerTone(state?: string): BadgeTone {
  if (state === 'enabled') return 'green'
  if (state === 'paused') return 'yellow'
  if (state === 'draining') return 'blue'
  if (state === 'auto_blocked') return 'red'
  return 'gray'
}

function compare(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
  dirMul: 1 | -1,
): number {
  const aNull = a == null
  const bNull = b == null
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dirMul
  return String(a).localeCompare(String(b)) * dirMul
}

function sortKeyValue(a: Account, key: SortKey): number | string | null {
  switch (key) {
    case 'severity':
      return SEVERITY_RANK[getAccountSeverity(a)]
    case 'account':
      return (a.label ?? a.emailAddress ?? a.id).toLowerCase()
    case 'provider':
      return a.provider
    case 'state':
      return a.schedulerState ?? ''
    case '5h':
      return a.lastRateLimit5hUtilization ?? null
    case '7d':
      return a.lastRateLimit7dUtilization ?? null
    case 'reset':
      return normalizeReset(a.lastRateLimitReset)
    case 'probed':
      return a.lastRateLimitAt ? new Date(a.lastRateLimitAt).getTime() : null
  }
}

export function InventoryTable({ accounts }: { accounts: Account[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('7d')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = useMemo(() => {
    const dirMul: 1 | -1 = sortDir === 'asc' ? 1 : -1
    const tieBreaker = (a: Account, b: Account) =>
      (a.label ?? a.emailAddress ?? a.id).localeCompare(b.label ?? b.emailAddress ?? b.id)
    return [...accounts].sort((a, b) => {
      const cmp = compare(sortKeyValue(a, sortKey), sortKeyValue(b, sortKey), dirMul)
      if (cmp !== 0) return cmp
      return tieBreaker(a, b)
    })
  }, [accounts, sortKey, sortDir])

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'account' || key === 'provider' || key === 'state' ? 'asc' : 'desc')
    }
  }

  if (accounts.length === 0) {
    return <div className="text-center text-slate-500 py-12">No accounts match your filters.</div>
  }

  return (
    <div className="border border-ccdash-border rounded-xl overflow-hidden bg-ccdash-card">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-ccdash-card-strong">
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <SortableHeader label="" sortKey="severity" current={sortKey} dir={sortDir} onClick={onHeaderClick} className="w-8" />
              <SortableHeader label="Account" sortKey="account" current={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableHeader label="Provider · Plan" sortKey="provider" current={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableHeader label="State" sortKey="state" current={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableHeader label="5h" sortKey="5h" current={sortKey} dir={sortDir} onClick={onHeaderClick} className="w-32" />
              <SortableHeader label="7d" sortKey="7d" current={sortKey} dir={sortDir} onClick={onHeaderClick} className="w-32" />
              <SortableHeader label="Reset" sortKey="reset" current={sortKey} dir={sortDir} onClick={onHeaderClick} className="w-28" />
              <SortableHeader label="Probed" sortKey="probed" current={sortKey} dir={sortDir} onClick={onHeaderClick} className="w-24" />
              <th className="px-3 py-2 font-semibold w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <Row key={a.id} account={a} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortableHeader({
  label,
  sortKey,
  current,
  dir,
  onClick,
  className,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onClick: (k: SortKey) => void
  className?: string
}) {
  const active = current === sortKey
  return (
    <th
      onClick={() => onClick(sortKey)}
      className={cn(
        'px-3 py-2 font-semibold cursor-pointer select-none hover:text-slate-200 whitespace-nowrap',
        active && 'text-slate-100',
        className,
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <span className="text-slate-400">{dir === 'asc' ? '▲' : '▼'}</span>}
      </span>
    </th>
  )
}

function Row({ account }: { account: Account }) {
  const sev = getAccountSeverity(account)
  const sevCls = getSeverityClasses(sev)
  const plan = accountPlanLabel(account)
  const reset = formatResetCountdown(account.lastRateLimitReset)
  const probedAtMs = account.lastRateLimitAt ? new Date(account.lastRateLimitAt).getTime() : null
  const stale = probedAtMs != null && Date.now() - probedAtMs > STALE_PROBE_MS

  return (
    <tr className={cn('border-t border-ccdash-border/60 hover:bg-slate-500/5 transition-colors', sevCls.rowTint)}>
      <td className="px-3 py-2 align-middle">
        <span
          aria-label={`severity-${sev}`}
          title={sev}
          className={cn('inline-block w-2.5 h-6 rounded-sm', sevCls.bar)}
        />
      </td>
      <td className="px-3 py-2 align-middle min-w-[200px]">
        <Link to={`/accounts/${encodeURIComponent(account.id)}`} className="block group">
          <div className="text-slate-100 font-medium truncate group-hover:text-blue-300">
            {account.label || account.emailAddress || account.id}
          </div>
          {account.label && account.emailAddress && (
            <div className="text-[11px] text-slate-500 truncate">{account.emailAddress}</div>
          )}
          <div className="text-[10px] text-slate-600 truncate">{account.id}</div>
        </Link>
      </td>
      <td className="px-3 py-2 align-middle whitespace-nowrap">
        <div className="text-slate-200 text-xs">{account.provider}</div>
        <div className="text-[11px] text-slate-500 truncate max-w-[160px]">{plan ?? '—'}</div>
      </td>
      <td className="px-3 py-2 align-middle">
        {account.schedulerState ? (
          <Badge tone={schedulerTone(account.schedulerState)}>{account.schedulerState}</Badge>
        ) : (
          <span className="text-slate-500 text-xs">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-middle">
        <UtilCell util={account.lastRateLimit5hUtilization} status={account.lastRateLimitStatus} window="5h" />
      </td>
      <td className="px-3 py-2 align-middle">
        <UtilCell util={account.lastRateLimit7dUtilization} status={account.lastRateLimitStatus} window="7d" />
      </td>
      <td className="px-3 py-2 align-middle">
        <ResetCell reset={reset} />
      </td>
      <td className="px-3 py-2 align-middle">
        <span
          className={cn('text-xs', stale ? 'text-slate-500' : 'text-slate-300')}
          title={stale ? 'Probe data may be stale (>30m)' : undefined}
        >
          {account.lastRateLimitAt ? timeAgo(account.lastRateLimitAt) : '—'}
        </span>
      </td>
      <td className="px-3 py-2 align-middle">
        <Link
          to={`/accounts/${encodeURIComponent(account.id)}`}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          Detail →
        </Link>
      </td>
    </tr>
  )
}

function UtilCell({
  util,
  status,
  window,
}: {
  util: number | null | undefined
  status: string | null | undefined
  window: '5h' | '7d'
}) {
  if (util == null) {
    return <span className="text-slate-500 text-xs">—</span>
  }
  const sev: Severity = getUtilSeverity(util)
  const cls = getSeverityClasses(sev)
  const pct = Math.min(util * 100, 100)
  const tooltip = `${window} util ${formatUtilPct(util)}${status ? ` · ${status}` : ''}`
  return (
    <div className="flex items-center gap-2 min-w-[110px]" title={tooltip}>
      <div className="flex-1 h-1.5 bg-slate-700/60 rounded-full overflow-hidden min-w-[50px]">
        <div className={cn('h-full rounded-full transition-all', cls.bar)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('text-xs tabular-nums w-9 text-right', cls.fg)}>{formatUtilPct(util)}</span>
    </div>
  )
}

function ResetCell({ reset }: { reset: ReturnType<typeof formatResetCountdown> }) {
  if (!reset.hasValue) return <span className="text-slate-500 text-xs">—</span>
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        reset.urgent ? 'text-red-400 font-semibold' : 'text-slate-300',
      )}
    >
      {reset.label}
    </span>
  )
}
