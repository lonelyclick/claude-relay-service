import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge } from '~/components/Badge'
import { useQuery } from '@tanstack/react-query'
import { healthz } from '~/api/proxies'
import { listAccounts } from '~/api/accounts'
import { listRoutingGroups } from '~/api/routing'
import { fmtNum } from '~/lib/format'
import type { Account, RoutingGroup } from '~/api/types'

type OverviewGroup = {
  id: string
  name: string
  accounts: Account[]
}

function buildOverviewGroups(accounts: Account[], groups: RoutingGroup[]): OverviewGroup[] {
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const accountGroups = new Map<string, Account[]>()

  for (const account of accounts) {
    const groupId = account.routingGroupId ?? 'ungrouped'
    accountGroups.set(groupId, [...(accountGroups.get(groupId) ?? []), account])
  }

  return Array.from(accountGroups.entries())
    .map(([id, groupedAccounts]) => ({
      id,
      name: id === 'ungrouped' ? 'Ungrouped' : groupById.get(id)?.name || id,
      accounts: groupedAccounts,
    }))
    .sort((a, b) => {
      if (a.id === 'ungrouped') return 1
      if (b.id === 'ungrouped') return -1
      return a.name.localeCompare(b.name)
    })
}

function pickNextAccount(accounts: Account[], globalNextEmail?: string): string {
  if (globalNextEmail && accounts.some((account) => account.emailAddress === globalNextEmail)) {
    return globalNextEmail
  }

  return '—'
}

export function DashboardPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: healthz })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const groups = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })

  if (health.isLoading || accounts.isLoading || groups.isLoading) return <PageSkeleton />

  const accountList = accounts.data?.accounts ?? []
  const groupList = groups.data?.routingGroups ?? []
  const overviewGroups = buildOverviewGroups(accountList, groupList)

  return (
    <div className="space-y-5">
      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-1">Overview</div>
            <h2 className="text-xl font-bold text-slate-100">Relay Status</h2>
          </div>
          <Badge tone={health.data?.ok ? 'green' : 'red'}>
            {health.data?.ok ? 'Healthy' : 'Degraded'}
          </Badge>
        </div>
      </section>

      {overviewGroups.length > 0 ? (
        <div className="overflow-x-auto bg-bg-card border border-border-default rounded-xl shadow-xs">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                <th className="text-left py-2 px-3">Group</th>
                <th className="text-right py-2 px-3">Total Accounts</th>
                <th className="text-right py-2 px-3">Active Accounts</th>
                <th className="text-left py-2 px-3">Next Account</th>
              </tr>
            </thead>
            <tbody>
              {overviewGroups.map((group) => {
                const activeCount = group.accounts.filter((account) => account.isActive).length

                return (
                  <tr key={group.id} className="border-b border-border-default/50 last:border-b-0 hover:bg-bg-card-raised/30">
                    <td className="py-2.5 px-3">
                      <div className="font-medium text-slate-100">{group.name}</div>
                      <div className="text-xs text-slate-500 font-mono">{group.id}</div>
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-slate-300">{fmtNum(group.accounts.length)}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-slate-300">{fmtNum(activeCount)}</td>
                    <td className="py-2.5 px-3 text-xs text-slate-300 font-mono break-all">
                      {pickNextAccount(group.accounts, health.data?.nextAccountEmail)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center text-slate-500 py-12">No accounts loaded.</div>
      )}

      {health.error && (
        <p className="text-sm text-red-400">Failed to load health: {(health.error as Error).message}</p>
      )}
    </div>
  )
}
