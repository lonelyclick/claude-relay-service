import { Outlet } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { getSchedulerStats } from '~/api/routing'
import { TabNav } from '~/components/TabNav'
import { StatCard } from '~/components/StatCard'
import { fmtNum } from '~/lib/format'

const tabs = [
  { to: '/routing', label: 'Groups', end: true },
  { to: '/routing/live', label: 'Live Routes' },
  { to: '/routing/guard', label: 'Guard' },
  { to: '/routing/handoffs', label: 'Handoffs' },
]

export function RoutingLayout() {
  const stats = useQuery({ queryKey: ['scheduler-stats'], queryFn: getSchedulerStats, staleTime: 15_000 })
  const g = stats.data?.global

  return (
    <>
      {g && (
        <div className="grid grid-cols-4 gap-3 mb-4 max-md:grid-cols-2">
          <StatCard value={fmtNum(g.activeAccounts)} label="Active Accounts" />
          <StatCard value={fmtNum(g.totalActiveSessions)} label="Active Sessions" />
          <StatCard value={fmtNum(g.totalCapacity)} label="Capacity" />
          <StatCard value={`${Math.round(g.utilizationPercent)}%`} label="Utilization" />
        </div>
      )}
      <TabNav items={tabs} />
      <Outlet />
    </>
  )
}
