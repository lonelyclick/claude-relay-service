import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getSchedulerStats, clearSessionRoutes } from '~/api/routing'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import { truncateMiddle } from '~/lib/format'

export function LiveRoutesPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const stats = useQuery({ queryKey: ['scheduler-stats'], queryFn: getSchedulerStats, staleTime: 15_000 })

  const clearMut = useMutation({
    mutationFn: clearSessionRoutes,
    onSuccess: () => {
      toast.success('Session routes cleared')
      qc.invalidateQueries({ queryKey: ['scheduler-stats'] })
    },
    onError: (e) => toast.error(e.message),
  })

  if (stats.isLoading) return <PageSkeleton />

  const routes = stats.data?.sessionRoutes ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge tone="blue">{routes.length} active routes</Badge>
        </div>
        <button
          onClick={() => { if (confirm('Clear all session routes?')) clearMut.mutate() }}
          disabled={routes.length === 0 || clearMut.isPending}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
        >
          Clear All
        </button>
      </div>

      {routes.length === 0 ? (
        <div className="text-center text-slate-500 py-8">No active session routes.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                <th className="text-left py-2 px-3">Session</th>
                <th className="text-left py-2 px-3">Account</th>
                <th className="text-center py-2 px-3">User</th>
                <th className="text-center py-2 px-3">Device</th>
                <th className="text-right py-2 px-3">Since</th>
                <th className="text-right py-2 px-3">Last Activity</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r, i) => (
                <tr key={i} className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
                  <td className="py-2 px-3 font-mono text-xs text-slate-300">{truncateMiddle(r.sessionKey, 24)}</td>
                  <td className="py-2 px-3 font-mono text-xs text-slate-300">{r.accountEmail ?? truncateMiddle(r.accountId, 24)}</td>
                  <td className="py-2 px-3 text-center text-xs text-slate-400">{r.userName ?? r.userId ?? '—'}</td>
                  <td className="py-2 px-3 text-center text-xs text-slate-400">{r.clientDeviceId ? truncateMiddle(r.clientDeviceId, 16) : '—'}</td>
                  <td className="py-2 px-3 text-right text-xs text-slate-500">{r.since ? new Date(r.since).toLocaleString() : '—'}</td>
                  <td className="py-2 px-3 text-right text-xs text-slate-500">{r.lastActivity ? new Date(r.lastActivity).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
