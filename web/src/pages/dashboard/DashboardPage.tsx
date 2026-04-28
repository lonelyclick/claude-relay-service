import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { Badge } from '~/components/Badge'
import { useQuery } from '@tanstack/react-query'
import { healthz } from '~/api/proxies'
import { listAccounts } from '~/api/accounts'
import { fmtNum } from '~/lib/format'

export function DashboardPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: healthz })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })

  if (health.isLoading || accounts.isLoading) return <PageSkeleton />

  const accountList = accounts.data?.accounts ?? []
  const activeCount = accountList.filter((a) => a.isActive).length

  return (
    <div className="space-y-6">
      <section className="bg-ccdash-card border border-ccdash-border rounded-2xl p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-1">Overview</div>
            <h2 className="text-xl font-bold text-slate-100">Relay Status</h2>
          </div>
          <Badge tone={health.data?.ok ? 'green' : 'red'}>
            {health.data?.ok ? 'Healthy' : 'Degraded'}
          </Badge>
        </div>
      </section>

      <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
        <StatCard value={fmtNum(accountList.length)} label="Total Accounts" />
        <StatCard value={fmtNum(activeCount)} label="Active Accounts" />
        <StatCard value={health.data?.nextAccountEmail ?? '—'} label="Next Account" />
      </div>

      {health.error && (
        <p className="text-sm text-red-400">Failed to load health: {(health.error as Error).message}</p>
      )}
    </div>
  )
}
