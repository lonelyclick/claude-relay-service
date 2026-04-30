import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listAccounts } from '~/api/accounts'
import { listProxies } from '~/api/proxies'
import { listRoutingGroups } from '~/api/routing'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { cn } from '~/lib/cn'
import { fmtNum } from '~/lib/format'
import { needsProxyWarning } from '~/lib/account'
import {
  fleetAvgUtil,
  formatResetCountdown,
  formatUtilPct,
  getSeverityClasses,
  getUtilSeverity,
  isAtRisk,
  pickEarliestReset,
  pickEarliestUnblock,
} from '~/lib/rateLimit'
import { AccountCard } from './AccountCard'
import { InventoryTable } from './InventoryTable'
import type { Account } from '~/api/types'

type HealthLevel = 'all' | 'critical' | 'warning' | 'healthy'
type ViewMode = 'cards' | 'table'

const FILTER_KEYS = {
  search: 'accounts.search',
  provider: 'accounts.provider',
  scheduler: 'accounts.scheduler',
  group: 'accounts.group',
  health: 'accounts.health',
  stressedOnly: 'accounts.stressedOnly',
  viewMode: 'accounts.viewMode',
} as const

function useLocalStorageString<T extends string>(
  key: string,
  defaultValue: T,
  isValid?: (raw: string) => raw is T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue
    try {
      const raw = window.localStorage.getItem(key)
      if (raw == null) return defaultValue
      if (isValid && !isValid(raw)) return defaultValue
      return raw as T
    } catch {
      return defaultValue
    }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem(key, value) } catch { /* quota or disabled */ }
  }, [key, value])
  return [value, setValue]
}

function useLocalStorageBoolean(key: string, defaultValue: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultValue
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === '1') return true
      if (raw === '0') return false
      return defaultValue
    } catch {
      return defaultValue
    }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem(key, value ? '1' : '0') } catch { /* quota or disabled */ }
  }, [key, value])
  return [value, setValue]
}

const isHealthLevel = (raw: string): raw is HealthLevel =>
  raw === 'all' || raw === 'critical' || raw === 'warning' || raw === 'healthy'
const isViewMode = (raw: string): raw is ViewMode => raw === 'cards' || raw === 'table'

function getHealthLevel(a: Account): 'critical' | 'warning' | 'healthy' {
  if (a.schedulerState === 'auto_blocked' || !a.isActive || !a.hasAccessToken) return 'critical'
  if (needsProxyWarning(a)) return 'warning'
  if (!a.hasRefreshToken && a.authMode === 'oauth') return 'warning'
  if (a.lastError) return 'warning'
  return 'healthy'
}

function matchesSearch(a: Account, q: string): boolean {
  const lower = q.toLowerCase()
  return [a.emailAddress, a.label, a.id, a.provider, a.routingGroupId, a.schedulerState]
    .filter(Boolean)
    .some((v) => v!.toLowerCase().includes(lower))
}

export function InventoryPage() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const groups = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })
  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })

  const [search, setSearch] = useLocalStorageString<string>(FILTER_KEYS.search, '')
  const [provider, setProvider] = useLocalStorageString<string>(FILTER_KEYS.provider, 'all')
  const [scheduler, setScheduler] = useLocalStorageString<string>(FILTER_KEYS.scheduler, 'all')
  const [group, setGroup] = useLocalStorageString<string>(FILTER_KEYS.group, 'all')
  const [health, setHealth] = useLocalStorageString<HealthLevel>(FILTER_KEYS.health, 'all', isHealthLevel)
  const [stressedOnly, setStressedOnly] = useLocalStorageBoolean(FILTER_KEYS.stressedOnly, false)
  const [viewMode, setViewMode] = useLocalStorageString<ViewMode>(FILTER_KEYS.viewMode, 'table', isViewMode)

  const accountList = accounts.data?.accounts ?? []
  const groupList = groups.data?.routingGroups ?? []
  const proxyList = proxies.data?.proxies ?? []

  const providers = useMemo(
    () => [...new Set(accountList.map((a) => a.provider))].sort(),
    [accountList],
  )
  const schedulerStates = useMemo(
    () => [...new Set(accountList.map((a) => a.schedulerState).filter(Boolean))].sort(),
    [accountList],
  )

  const filtered = useMemo(() => {
    return accountList.filter((a) => {
      if (search && !matchesSearch(a, search)) return false
      if (provider !== 'all' && a.provider !== provider) return false
      if (scheduler !== 'all' && a.schedulerState !== scheduler) return false
      if (group !== 'all' && a.routingGroupId !== group) return false
      if (health !== 'all' && getHealthLevel(a) !== health) return false
      if (viewMode === 'table' && stressedOnly) {
        const f = a.lastRateLimit5hUtilization
        const s = a.lastRateLimit7dUtilization
        const stressed = (f != null && f >= 0.7) || (s != null && s >= 0.7)
        if (!stressed) return false
      }
      return true
    })
  }, [accountList, search, provider, scheduler, group, health, stressedOnly, viewMode])

  const sortedForCards = useMemo(() => {
    const order: Record<string, number> = { critical: 0, warning: 1, healthy: 2 }
    const sOrder: Record<string, number> = { auto_blocked: 0, paused: 1, draining: 2, enabled: 3 }
    return [...filtered].sort((a, b) => {
      const ha = order[getHealthLevel(a)] ?? 2
      const hb = order[getHealthLevel(b)] ?? 2
      if (ha !== hb) return ha - hb
      const sa = sOrder[a.schedulerState ?? ''] ?? 4
      const sb = sOrder[b.schedulerState ?? ''] ?? 4
      if (sa !== sb) return sa - sb
      return (a.emailAddress ?? a.id).localeCompare(b.emailAddress ?? b.id)
    })
  }, [filtered])

  if (accounts.isLoading) return <PageSkeleton />

  return (
    <div className="space-y-4">
      <KpiBar accounts={accountList} />

      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Search accounts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-accent w-56"
        />
        <Select value={provider} onChange={setProvider} options={[['all', 'All Providers'], ...providers.map((p) => [p, p])]} />
        <Select value={scheduler} onChange={setScheduler} options={[['all', 'All States'], ...schedulerStates.map((s) => [s!, s!])]} />
        <Select value={group} onChange={setGroup} options={[['all', 'All Groups'], ...groupList.map((g) => [g.id, g.name || g.id])]} />
        <Select value={health} onChange={(v) => setHealth(v as HealthLevel)} options={[['all', 'All Health'], ['critical', 'Critical'], ['warning', 'Warning'], ['healthy', 'Healthy']]} />

        {viewMode === 'table' && (
          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none px-2 py-1.5 rounded-lg border border-border-default hover:border-border-hover transition-all duration-150">
            <input
              type="checkbox"
              checked={stressedOnly}
              onChange={(e) => setStressedOnly(e.target.checked)}
              className="accent-orange-500"
            />
            仅显示 ≥70%
          </label>
        )}

        <div className="ml-auto">
          <ViewToggle value={viewMode} onChange={setViewMode} />
        </div>
      </div>

      {viewMode === 'cards' ? (
        sortedForCards.length === 0 ? (
          <div className="text-center text-slate-500 py-12">No accounts match your filters.</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
            {sortedForCards.map((a) => (
              <AccountCard key={a.id} account={a} proxies={proxyList} />
            ))}
          </div>
        )
      ) : (
        <InventoryTable accounts={filtered} />
      )}
    </div>
  )
}

function KpiBar({ accounts }: { accounts: Account[] }) {
  const total = accounts.length
  const atRiskList = accounts.filter(isAtRisk)
  const blockedList = accounts.filter((a) => a.schedulerState === 'auto_blocked')
  const fleet5hAvg = fleetAvgUtil(accounts, (a) => a.lastRateLimit5hUtilization)
  const fleet7dAvg = fleetAvgUtil(accounts, (a) => a.lastRateLimit7dUtilization)
  const earliestReset = pickEarliestReset(accounts)
  const earliestUnblock = pickEarliestUnblock(accounts)

  const atRiskPct = total > 0 ? (atRiskList.length / total) * 100 : 0
  const fleetSev = getUtilSeverity(fleet5hAvg)
  const fleetCls = getSeverityClasses(fleetSev)

  const unblockCountdown = earliestUnblock.ts
    ? formatResetCountdown(earliestUnblock.ts)
    : null
  const resetCountdown = earliestReset.ts
    ? formatResetCountdown(earliestReset.ts)
    : null

  const atRiskTone = atRiskList.length === 0 ? 'ok' : atRiskList.length <= 2 ? 'watch' : 'critical'
  const atRiskCls = getSeverityClasses(atRiskTone)
  const blockedTone = blockedList.length === 0 ? 'ok' : 'critical'
  const blockedCls = getSeverityClasses(blockedTone)

  return (
    <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
      <KpiTile
        icon="🔴"
        title="At Risk"
        value={total > 0 ? `${atRiskList.length} / ${total}` : '—'}
        valueClassName={atRiskCls.fg}
        caption={total > 0 ? `${atRiskPct.toFixed(0)}% of fleet ≥80%` : 'No accounts loaded'}
        accent={atRiskTone === 'ok' ? undefined : atRiskCls.bar}
      />
      <KpiTile
        icon="⛔"
        title="Blocked"
        value={fmtNum(blockedList.length)}
        valueClassName={blockedCls.fg}
        caption={
          unblockCountdown && earliestUnblock.account
            ? `next unblock in ${unblockCountdown.label} · ${shortLabel(earliestUnblock.account)}`
            : blockedList.length === 0
              ? 'No accounts blocked'
              : 'No unblock ETA'
        }
        accent={blockedTone === 'ok' ? undefined : blockedCls.bar}
      />
      <KpiTile
        icon="📊"
        title="Fleet 5h avg"
        value={fleet5hAvg != null ? formatUtilPct(fleet5hAvg) : '—'}
        valueClassName={fleetCls.fg}
        caption={fleet7dAvg != null ? `7d avg ${formatUtilPct(fleet7dAvg)}` : '—'}
        sparkline={fleet5hAvg != null ? <FleetBar pct={fleet5hAvg * 100} severity={fleetSev} /> : null}
      />
      <KpiTile
        icon="⏰"
        title="Next Reset"
        value={resetCountdown ? resetCountdown.label : '—'}
        valueClassName={resetCountdown?.urgent ? 'text-red-400' : 'text-slate-100'}
        caption={
          resetCountdown && earliestReset.account
            ? shortLabel(earliestReset.account)
            : 'No upcoming reset'
        }
      />
    </div>
  )
}

function KpiTile({
  icon,
  title,
  value,
  caption,
  valueClassName,
  accent,
  sparkline,
}: {
  icon: string
  title: string
  value: string
  caption?: string
  valueClassName?: string
  accent?: string
  sparkline?: React.ReactNode
}) {
  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs relative overflow-hidden">
      {accent && <div className={cn('absolute left-0 top-0 bottom-0 w-1', accent)} />}
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-400">
        <span aria-hidden>{icon}</span>
        <span>{title}</span>
      </div>
      <div className={cn('mt-1 text-2xl font-bold tabular-nums', valueClassName ?? 'text-slate-100')}>
        {value}
      </div>
      {sparkline && <div className="mt-2">{sparkline}</div>}
      {caption && <div className="text-[11px] text-slate-500 mt-1 truncate">{caption}</div>}
    </div>
  )
}

function FleetBar({ pct, severity }: { pct: number; severity: ReturnType<typeof getUtilSeverity> }) {
  const cls = getSeverityClasses(severity)
  return (
    <div className="h-1.5 bg-bg-card-raised/60 rounded-full overflow-hidden">
      <div className={cn('h-full rounded-full transition-all', cls.bar)} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}

function shortLabel(a: Account): string {
  return a.label || a.emailAddress || a.id.slice(0, 8)
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex border border-border-default rounded-lg overflow-hidden bg-bg-input">
      {(['table', 'cards'] as const).map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors',
            value === mode
              ? 'bg-indigo-600/30 text-indigo-200'
              : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {mode === 'table' ? 'Table' : 'Cards'}
        </button>
      ))}
    </div>
  )
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: string[][]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-accent"
    >
      {options.map(([val, label]) => (
        <option key={val} value={val}>
          {label}
        </option>
      ))}
    </select>
  )
}
