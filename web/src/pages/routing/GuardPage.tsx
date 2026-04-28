import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { getSchedulerStats } from '~/api/routing'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge, type BadgeTone } from '~/components/Badge'
import { fmtTokens } from '~/lib/format'

function heatLevel(pct: number): { label: string; tone: BadgeTone } {
  if (pct >= 90) return { label: 'Critical', tone: 'red' }
  if (pct >= 75) return { label: 'Hot', tone: 'yellow' }
  if (pct >= 55) return { label: 'Warming', tone: 'blue' }
  return { label: 'Stable', tone: 'green' }
}

function maxUtil(row: { activeSessionUtilizationPercent?: number; requestUtilizationPercent?: number; tokenUtilizationPercent?: number }) {
  return Math.max(row.activeSessionUtilizationPercent ?? 0, row.requestUtilizationPercent ?? 0, row.tokenUtilizationPercent ?? 0)
}

export function GuardPage() {
  const [filterHot, setFilterHot] = useState(false)
  const stats = useQuery({ queryKey: ['scheduler-stats'], queryFn: getSchedulerStats, staleTime: 15_000 })

  if (stats.isLoading) return <PageSkeleton />

  const guard = stats.data?.routingGuard
  if (!guard) return <div className="text-center text-slate-500 py-8">Routing guard data not available.</div>

  const users = (guard.users ?? []) as GuardRow[]
  const devices = (guard.devices ?? []) as (GuardRow & { clientDeviceId?: string })[]

  const filteredUsers = filterHot ? users.filter((u) => maxUtil(u) >= 75) : users
  const filteredDevices = filterHot ? devices.filter((d) => maxUtil(d) >= 75) : devices

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setFilterHot(false)}
          className={`px-3 py-1 rounded-lg text-xs font-medium ${!filterHot ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40' : 'text-slate-400 border border-ccdash-border'}`}
        >
          All
        </button>
        <button
          onClick={() => setFilterHot(true)}
          className={`px-3 py-1 rounded-lg text-xs font-medium ${filterHot ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'text-slate-400 border border-ccdash-border'}`}
        >
          Hot / Critical
        </button>
      </div>

      <section>
        <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Users ({filteredUsers.length})</div>
        {filteredUsers.length === 0 ? (
          <div className="text-sm text-slate-500">{filterHot ? 'No hot users.' : 'No user pressure data.'}</div>
        ) : (
          <GuardTable rows={filteredUsers} showDevice={false} />
        )}
      </section>

      <section>
        <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Devices ({filteredDevices.length})</div>
        {filteredDevices.length === 0 ? (
          <div className="text-sm text-slate-500">{filterHot ? 'No hot devices.' : 'No device pressure data.'}</div>
        ) : (
          <GuardTable rows={filteredDevices} showDevice />
        )}
      </section>
    </div>
  )
}

interface GuardRow {
  userId?: string
  id?: string
  clientDeviceId?: string
  activeSessions?: number
  activeSessionUtilizationPercent?: number
  recentRequests?: number
  requestUtilizationPercent?: number
  recentTokens?: number
  tokenUtilizationPercent?: number
}

function GuardTable({ rows, showDevice }: { rows: GuardRow[]; showDevice: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
            <th className="text-left py-2 px-3">User</th>
            {showDevice && <th className="text-left py-2 px-3">Device</th>}
            <th className="text-center py-2 px-3">Sessions</th>
            <th className="text-center py-2 px-3">Requests</th>
            <th className="text-center py-2 px-3">Tokens</th>
            <th className="text-center py-2 px-3">Heat</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const heat = heatLevel(maxUtil(r))
            const userId = r.userId ?? r.id ?? '—'
            const deviceParam = r.clientDeviceId ? `?device=${encodeURIComponent(r.clientDeviceId)}` : ''
            return (
              <tr key={i} className="border-b border-ccdash-border/50 hover:bg-ccdash-card-strong/30">
                <td className="py-2 px-3">
                  <Link to={`/users/${encodeURIComponent(userId)}${deviceParam}`} className="font-mono text-xs text-blue-400 hover:underline">
                    {userId}
                  </Link>
                </td>
                {showDevice && (
                  <td className="py-2 px-3">
                    {r.clientDeviceId ? <Badge tone="blue">{r.clientDeviceId.slice(0, 12)}</Badge> : '—'}
                  </td>
                )}
                <td className="py-2 px-3">
                  <MeterCell value={r.activeSessions ?? 0} pct={r.activeSessionUtilizationPercent ?? 0} />
                </td>
                <td className="py-2 px-3">
                  <MeterCell value={r.recentRequests ?? 0} pct={r.requestUtilizationPercent ?? 0} />
                </td>
                <td className="py-2 px-3">
                  <MeterCell value={r.recentTokens ?? 0} pct={r.tokenUtilizationPercent ?? 0} fmt={fmtTokens} />
                </td>
                <td className="py-2 px-3 text-center">
                  <Badge tone={heat.tone}>{heat.label}</Badge>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MeterCell({ value, pct, fmt }: { value: number; pct: number; fmt?: (n: number) => string }) {
  const color = pct >= 85 ? 'bg-red-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div className="text-center">
      <div className="text-xs text-slate-300">{fmt ? fmt(value) : value} ({Math.round(pct)}%)</div>
      <div className="h-1 bg-slate-700 rounded-full mt-0.5 mx-auto w-16">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}
