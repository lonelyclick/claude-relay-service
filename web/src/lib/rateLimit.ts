import type { Account } from '~/api/types'

export type Severity = 'ok' | 'watch' | 'near' | 'critical'

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  near: 2,
  watch: 1,
  ok: 0,
}

export function getUtilSeverity(util: number | null | undefined): Severity {
  if (util == null || !Number.isFinite(util)) return 'ok'
  if (util >= 1) return 'critical'
  if (util >= 0.8) return 'near'
  if (util >= 0.5) return 'watch'
  return 'ok'
}

export function getAccountSeverity(a: Account): Severity {
  if (a.schedulerState === 'auto_blocked') return 'critical'
  if (a.lastRateLimitStatus === 'overage_disabled') return 'critical'
  const five = getUtilSeverity(a.lastRateLimit5hUtilization)
  const seven = getUtilSeverity(a.lastRateLimit7dUtilization)
  return SEVERITY_RANK[five] >= SEVERITY_RANK[seven] ? five : seven
}

export interface SeverityClasses {
  bg: string
  fg: string
  ring: string
  bar: string
  rowTint: string
}

export function getSeverityClasses(sev: Severity): SeverityClasses {
  switch (sev) {
    case 'critical':
      return {
        bg: 'bg-red-500/15',
        fg: 'text-red-400',
        ring: 'ring-red-500/40',
        bar: 'bg-red-500',
        rowTint: 'bg-red-500/[0.08]',
      }
    case 'near':
      return {
        bg: 'bg-orange-500/15',
        fg: 'text-orange-400',
        ring: 'ring-orange-500/40',
        bar: 'bg-orange-500',
        rowTint: 'bg-orange-500/[0.08]',
      }
    case 'watch':
      return {
        bg: 'bg-yellow-500/15',
        fg: 'text-yellow-400',
        ring: 'ring-yellow-500/40',
        bar: 'bg-yellow-500',
        rowTint: 'bg-yellow-500/[0.08]',
      }
    case 'ok':
    default:
      return {
        bg: 'bg-green-500/15',
        fg: 'text-green-400',
        ring: 'ring-green-500/40',
        bar: 'bg-green-500',
        rowTint: '',
      }
  }
}

export function formatUtilPct(util: number | null | undefined): string {
  if (util == null || !Number.isFinite(util)) return '—'
  return `${Math.round(util * 100)}%`
}

export function normalizeReset(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return value < 1_000_000_000_000 ? value * 1000 : value
}

export function formatResetCountdown(value: number | null | undefined, now = Date.now()): {
  label: string
  urgent: boolean
  hasValue: boolean
} {
  const ts = normalizeReset(value)
  if (ts == null) return { label: '—', urgent: false, hasValue: false }
  const diffMs = ts - now
  if (diffMs <= 0) return { label: 'now', urgent: true, hasValue: true }
  const totalMin = Math.floor(diffMs / 60000)
  if (totalMin < 60) {
    return { label: `${totalMin}m`, urgent: totalMin <= 10, hasValue: true }
  }
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours < 24) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ts))
    const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]))
    const abs = `${partMap.hour}:${partMap.minute}`
    const rel = mins === 0 ? `${hours}h` : `${hours}h${mins}m`
    return { label: `${rel} · ${abs}`, urgent: false, hasValue: true }
  }
  const days = Math.floor(hours / 24)
  return { label: `${days}d`, urgent: false, hasValue: true }
}

export function pickEarliestReset(accounts: Account[], now = Date.now()): {
  account: Account | null
  ts: number | null
} {
  let best: { account: Account; ts: number } | null = null
  for (const a of accounts) {
    const ts = normalizeReset(a.lastRateLimitReset)
    if (ts == null || ts <= now) continue
    if (!best || ts < best.ts) best = { account: a, ts }
  }
  return best ? { account: best.account, ts: best.ts } : { account: null, ts: null }
}

export function pickEarliestUnblock(accounts: Account[], now = Date.now()): {
  account: Account | null
  ts: number | null
} {
  let best: { account: Account; ts: number } | null = null
  for (const a of accounts) {
    if (a.schedulerState !== 'auto_blocked') continue
    const ts = normalizeReset(a.autoBlockedUntil)
    if (ts == null || ts <= now) continue
    if (!best || ts < best.ts) best = { account: a, ts }
  }
  return best ? { account: best.account, ts: best.ts } : { account: null, ts: null }
}

export function fleetAvgUtil(accounts: Account[], pick: (a: Account) => number | null | undefined): number | null {
  let sum = 0
  let count = 0
  for (const a of accounts) {
    const v = pick(a)
    if (v != null && Number.isFinite(v)) {
      sum += v
      count += 1
    }
  }
  return count > 0 ? sum / count : null
}

export function isAtRisk(a: Account): boolean {
  const f = a.lastRateLimit5hUtilization
  const s = a.lastRateLimit7dUtilization
  return (f != null && f >= 0.8) || (s != null && s >= 0.8) || a.schedulerState === 'auto_blocked'
}

export function maxUtil(a: Account): number {
  const f = a.lastRateLimit5hUtilization ?? 0
  const s = a.lastRateLimit7dUtilization ?? 0
  return Math.max(f, s)
}
