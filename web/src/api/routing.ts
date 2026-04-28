import { get, post } from './client'
import type { RoutingGroup, SchedulerStats } from './types'

type SchedulerStatsResponse = {
  global: SchedulerStats['global'] & {
    totalAccounts?: number
  }
  accounts: SchedulerStats['accounts']
  groups?: Record<
    string,
    {
      activeSessions?: number
      capacity?: number
      totalActiveSessions?: number
      totalCapacity?: number
    }
  >
  routingGuard?: SchedulerStats['routingGuard']
  sessionRoutes?: Array<
    SchedulerStats['sessionRoutes'][number] & {
      createdAt?: string
      updatedAt?: string
    }
  >
  recentHandoffs?: Array<
    SchedulerStats['recentHandoffs'][number] & {
      createdAt?: string
    }
  >
}

function normalizeSchedulerStats(data: SchedulerStatsResponse): SchedulerStats {
  const accountEmailById = new Map(
    (data.accounts ?? []).map((account) => [account.accountId, account.emailAddress ?? undefined]),
  )

  return {
    global: data.global,
    accounts: data.accounts ?? [],
    groups: Object.fromEntries(
      Object.entries(data.groups ?? {}).map(([groupId, group]) => [
        groupId,
        {
          totalActiveSessions: group.totalActiveSessions ?? group.activeSessions ?? 0,
          totalCapacity: group.totalCapacity ?? group.capacity ?? 0,
        },
      ]),
    ),
    routingGuard: data.routingGuard,
    sessionRoutes: (data.sessionRoutes ?? []).map((route) => ({
      ...route,
      accountEmail: route.accountEmail ?? accountEmailById.get(route.accountId),
      since: route.since ?? route.createdAt,
      lastActivity: route.lastActivity ?? route.updatedAt,
    })),
    recentHandoffs: (data.recentHandoffs ?? []).map((handoff) => ({
      ...handoff,
      timestamp: handoff.timestamp ?? handoff.createdAt ?? '',
      fromAccountEmail:
        handoff.fromAccountEmail ??
        (handoff.fromAccountId ? accountEmailById.get(handoff.fromAccountId) : undefined),
      toAccountEmail:
        handoff.toAccountEmail ??
        (handoff.toAccountId ? accountEmailById.get(handoff.toAccountId) : undefined),
    })),
  }
}

export const listRoutingGroups = () => get<{ routingGroups: RoutingGroup[] }>('/admin/routing-groups')
export const createRoutingGroup = (payload: { id: string; name: string; description?: string; isActive?: boolean }) =>
  post<RoutingGroup>('/admin/routing-groups', payload)
export const updateRoutingGroup = (id: string, payload: Record<string, unknown>) =>
  post(`/admin/routing-groups/${encodeURIComponent(id)}/update`, payload)
export const deleteRoutingGroup = (id: string) =>
  post(`/admin/routing-groups/${encodeURIComponent(id)}/delete`)

export const getSchedulerStats = async () => {
  const res = await get<SchedulerStatsResponse>('/admin/scheduler/stats')
  return normalizeSchedulerStats(res)
}
export const listSessionRoutes = () => get<{ sessionRoutes: unknown[] }>('/admin/session-routes')
export const clearSessionRoutes = () => post('/admin/session-routes/clear')
export const listStickySessions = () => get<{ stickySessions: unknown[] }>('/admin/sticky-sessions')
export const clearStickySessions = () => post('/admin/sticky-sessions/clear')
