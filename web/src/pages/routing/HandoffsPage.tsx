import { useQuery } from '@tanstack/react-query'
import { getSchedulerStats } from '~/api/routing'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge } from '~/components/Badge'
import { truncateMiddle } from '~/lib/format'

export function HandoffsPage() {
  const stats = useQuery({ queryKey: ['scheduler-stats'], queryFn: getSchedulerStats, staleTime: 15_000 })

  if (stats.isLoading) return <PageSkeleton />

  const handoffs = stats.data?.recentHandoffs ?? []

  return (
    <div className="space-y-4">
      <Badge tone="blue">{handoffs.length} recent events</Badge>

      {handoffs.length === 0 ? (
        <div className="text-center text-slate-500 py-8">No recent handoffs.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                <th className="text-left py-2 px-3">Time</th>
                <th className="text-left py-2 px-3">User</th>
                <th className="text-left py-2 px-3">Device</th>
                <th className="text-left py-2 px-3">From</th>
                <th className="text-left py-2 px-3">To</th>
                <th className="text-left py-2 px-3">Reason</th>
              </tr>
            </thead>
            <tbody>
              {handoffs.map((h, i) => (
                <tr key={i} className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
                  <td className="py-2 px-3 text-xs text-slate-500 whitespace-nowrap">{new Date(h.timestamp).toLocaleString()}</td>
                  <td className="py-2 px-3 text-xs text-slate-300">{h.userName ?? h.userId ?? '—'}</td>
                  <td className="py-2 px-3 text-xs text-slate-400">{h.clientDeviceId ? truncateMiddle(h.clientDeviceId, 16) : '—'}</td>
                  <td className="py-2 px-3 font-mono text-xs text-slate-400">{h.fromAccountEmail ?? (h.fromAccountId ? truncateMiddle(h.fromAccountId, 16) : '—')}</td>
                  <td className="py-2 px-3 font-mono text-xs text-slate-300">{h.toAccountEmail ?? (h.toAccountId ? truncateMiddle(h.toAccountId, 16) : '—')}</td>
                  <td className="py-2 px-3 text-xs text-slate-400">{h.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
