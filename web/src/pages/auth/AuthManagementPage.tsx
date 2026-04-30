import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getBetterAuthSession, listBetterAuthOrganizationsWithMembers, listBetterAuthUsers } from '~/api/betterAuth'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { fmtNum, timeAgo } from '~/lib/format'


export function BetterAuthPanel() {
  const session = useQuery({ queryKey: ['better-auth-session'], queryFn: getBetterAuthSession, retry: false })
  const currentSession = session.data?.session ?? null
  const currentUser = session.data?.user ?? null

  const users = useQuery({
    queryKey: ['better-auth-users'],
    queryFn: listBetterAuthUsers,
    retry: false,
  })
  const organizations = useQuery({
    queryKey: ['better-auth-organizations-with-members'],
    queryFn: listBetterAuthOrganizationsWithMembers,
    retry: false,
  })

  const isLoading = session.isLoading || users.isLoading || organizations.isLoading
  const error = session.error ?? users.error ?? organizations.error

  const membershipsByUserId = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const org of organizations.data ?? []) {
      for (const member of org.members) {
        const entries = map.get(member.userId) ?? []
        entries.push(`${org.name} · ${member.role}`)
        map.set(member.userId, entries)
      }
    }
    return map
  }, [organizations.data])

  if (isLoading) return <PageSkeleton />

  if (error) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          Better Auth API is unavailable: {(error as Error).message}
        </div>
        <div className="text-xs text-slate-500">
          ccdash is calling Better Auth directly at <span className="font-mono">https://cc.yohomobile.dev/api/auth</span>.
        </div>
      </div>
    )
  }

  const userList = users.data?.users ?? []
  const organizationList = organizations.data ?? []

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-md:grid-cols-1">
        <SummaryCard label="Better Auth User" value={currentUser?.email || currentUser?.name || 'Internal admin'} />
        <SummaryCard label="Total Users" value={fmtNum(users.data?.total ?? userList.length)} />
        <SummaryCard label="Organizations" value={fmtNum(organizationList.length)} />
        <SummaryCard label="Active Org" value={currentSession?.activeOrganizationId ?? '—'} mono />
      </section>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Users</div>
          <Badge tone="gray">Better Auth /admin/list-users</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                <th className="text-left py-2 px-3">User</th>
                <th className="text-left py-2 px-3">Role</th>
                <th className="text-left py-2 px-3">Organizations</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-right py-2 px-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {userList.map((user) => {
                const memberships = membershipsByUserId.get(user.id) ?? []
                return (
                  <tr key={user.id} className="border-b border-border-default/50 last:border-b-0 hover:bg-bg-card-raised/30">
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-100">{user.email || user.name || '—'}</div>
                      <div className="font-mono text-[11px] text-slate-500">{user.id}</div>
                    </td>
                    <td className="py-2 px-3 text-slate-300">{user.role ?? 'user'}</td>
                    <td className="py-2 px-3 text-slate-300">{memberships.length ? memberships.join(', ') : '—'}</td>
                    <td className="py-2 px-3"><Badge tone={user.banned ? 'red' : user.emailVerified ? 'green' : 'yellow'}>{user.banned ? 'Banned' : user.emailVerified ? 'Verified' : 'Unverified'}</Badge></td>
                    <td className="py-2 px-3 text-right text-slate-400 text-xs">{user.createdAt ? timeAgo(String(user.createdAt)) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Organizations</div>
          <Badge tone="gray">Better Auth /organization/list</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                <th className="text-left py-2 px-3">Name</th>
                <th className="text-left py-2 px-3">Slug</th>
                <th className="text-left py-2 px-3">Members</th>
                <th className="text-left py-2 px-3">ID</th>
                <th className="text-right py-2 px-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {organizationList.map((org) => (
                <tr key={org.id} className="border-b border-border-default/50 last:border-b-0 hover:bg-bg-card-raised/30">
                  <td className="py-2 px-3 font-medium text-slate-100">{org.name}</td>
                  <td className="py-2 px-3 text-slate-300 font-mono text-xs">{org.slug}</td>
                  <td className="py-2 px-3 text-slate-300">{fmtNum(org.memberTotal)}</td>
                  <td className="py-2 px-3 text-slate-500 font-mono text-xs">{org.id}</td>
                  <td className="py-2 px-3 text-right text-slate-400 text-xs">{org.createdAt ? timeAgo(String(org.createdAt)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function SummaryCard({ value, label, mono = false }: { value: string | number; label: string; mono?: boolean }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs">
      <div className={`text-base font-semibold text-slate-100 break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
      <div className="text-xs text-slate-400 mt-1">{label}</div>
    </div>
  )
}

export function AuthManagementPage() {
  return <BetterAuthPanel />
}
