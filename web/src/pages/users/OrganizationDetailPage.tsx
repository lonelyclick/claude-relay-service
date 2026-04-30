import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteBetterAuthOrganization,
  listBetterAuthSyncedUsers,
  updateBetterAuthOrganization,
  type BetterAuthManagedUser,
  type BetterAuthOrganization,
} from '~/api/betterAuth'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, fmtNum, fmtTokens } from '~/lib/format'
import {
  findOrganizationByRelayOrgId,
  formatOrganizationLabel,
  getOrganizationPrimaryLabel,
  getOrganizationRelayId,
  getOrganizationSecondaryLabel,
} from './orgDisplay'
import { buildOrganizationsHref, buildUserDetailHref } from './userDetailLinks'

export function OrganizationDetailPage() {
  const { organizationId } = useParams<{ organizationId: string }>()
  const users = useQuery({ queryKey: ['better-auth-users'], queryFn: listBetterAuthSyncedUsers, retry: false })

  if (users.isLoading) return <PageSkeleton />
  if (users.error) return <div className="text-red-400 text-sm">Failed to load organization: {(users.error as Error).message}</div>

  const data = users.data
  const org = data?.organizations.find((item) => item.id === organizationId) ?? null
  if (!org) {
    return (
      <div className="space-y-4">
        <Link to={buildOrganizationsHref()} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Organizations</Link>
        <div className="rounded-xl border border-border-default bg-bg-card p-5 text-sm text-slate-400">Organization not found.</div>
      </div>
    )
  }

  const accessUsers = (data?.users ?? []).filter((user) => userBelongsToOrganization(user, org))

  return (
    <div className="space-y-5">
      <Link to={buildOrganizationsHref()} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Organizations</Link>
      <OrganizationHeader org={org} accessUserCount={accessUsers.length} />
      <OrganizationManagementSection org={org} />
      <OrganizationUsersSection org={org} users={accessUsers} />
    </div>
  )
}

function OrganizationHeader({
  org,
  accessUserCount,
}: {
  org: BetterAuthOrganization
  accessUserCount: number
}) {
  const secondary = getOrganizationSecondaryLabel(org)
  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-2">Organization</div>
          <h2 className="text-lg font-bold text-slate-100">{getOrganizationPrimaryLabel(org)}</h2>
          {secondary ? <div className="mt-1 font-mono text-xs text-slate-500">{secondary}</div> : null}
          <div className="mt-1 font-mono text-xs text-slate-600">{org.id}</div>
        </div>
        <Badge tone="blue">{fmtNum(accessUserCount)} users</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <Badge tone="gray">slug: {org.slug}</Badge>
        <Badge tone="cyan">relay: {getOrganizationRelayId(org) || '—'}</Badge>
        <Badge tone="gray">Better Auth members: {fmtNum(org.memberCount ?? 0)}</Badge>
      </div>
    </section>
  )
}

function OrganizationManagementSection({ org }: { org: BetterAuthOrganization }) {
  const toast = useToast()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState({ name: org.name ?? '', slug: org.slug ?? '' })

  useEffect(() => {
    setForm({ name: org.name ?? '', slug: org.slug ?? '' })
  }, [org.id, org.name, org.slug])

  const updateMut = useMutation({
    mutationFn: () => {
      const slug = form.slug.trim() || slugify(form.name)
      return updateBetterAuthOrganization(org.id, {
        name: form.name.trim(),
        slug,
        metadata: { ...safeMetadata(org.metadata), relayOrgId: slug },
      })
    },
    onSuccess: () => {
      toast.success('Organization updated')
      qc.invalidateQueries({ queryKey: ['better-auth-users'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const deleteMut = useMutation({
    mutationFn: () => deleteBetterAuthOrganization(org.id),
    onSuccess: () => {
      toast.success('Organization deleted')
      qc.invalidateQueries({ queryKey: ['better-auth-users'] })
      navigate(buildOrganizationsHref())
    },
    onError: (e) => toast.error(e.message),
  })

  const dirty = form.name.trim() !== org.name || form.slug.trim() !== org.slug
  const isPending = updateMut.isPending || deleteMut.isPending

  const onSave = () => {
    if (!form.name.trim()) {
      toast.error('Name is required')
      return
    }
    updateMut.mutate()
  }

  const onDelete = () => {
    if (confirm(`Delete organization "${org.name}"? Members will be detached from this org.`)) {
      deleteMut.mutate()
    }
  }

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Organization Management</div>
      <div className="grid grid-cols-[1fr_auto] gap-4 max-lg:grid-cols-1">
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <label className="text-xs font-medium text-slate-400">
            Name
            <input
              className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-accent"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value, slug: current.slug || slugify(event.target.value) }))}
            />
          </label>
          <label className="text-xs font-medium text-slate-400">
            Slug / Relay Org
            <input
              className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-accent"
              value={form.slug}
              onChange={(event) => setForm((current) => ({ ...current, slug: slugify(event.target.value) }))}
            />
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-2 self-end">
          <button onClick={onDelete} disabled={isPending} className="px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 disabled:opacity-50">Delete</button>
          <button onClick={onSave} disabled={isPending || !dirty || !form.name.trim()} className="px-3 py-1.5 rounded-lg text-sm bg-accent-muted border border-blue-500/30 text-indigo-300 hover:bg-accent-muted disabled:opacity-50">Save</button>
        </div>
      </div>
    </section>
  )
}

function OrganizationUsersSection({
  org,
  users,
}: {
  org: BetterAuthOrganization
  users: BetterAuthManagedUser[]
}) {
  return (
    <section className="bg-bg-card border border-border-default rounded-xl shadow-xs">
      <div className="flex items-center justify-between gap-3 p-4 border-b border-border-default">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Access Users</h2>
          <p className="text-xs text-slate-500 mt-1">Users whose relay org or Better Auth membership maps to {formatOrganizationLabel(org)}.</p>
        </div>
      </div>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
              <th className="text-left py-2 px-3">User</th>
              <th className="text-left py-2 px-3">Org</th>
              <th className="text-center py-2 px-3">Role</th>
              <th className="text-center py-2 px-3">Status</th>
              <th className="text-right py-2 px-3">Requests</th>
              <th className="text-right py-2 px-3">Tokens</th>
              <th className="text-right py-2 px-3">Balance</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const relay = user.relay
              const role = getOrganizationRole(user, org)
              return (
                <tr key={user.id} className="border-b border-border-default/50 last:border-b-0 hover:bg-bg-card-raised/30">
                  <td className="py-2 px-3">
                    <div className="font-medium text-slate-100">
                      {relay ? (
                        <Link to={buildUserDetailHref(relay.id, {})} className="text-indigo-300 hover:text-indigo-200">{user.name || relay.name || '—'} ↗</Link>
                      ) : (
                        <span>{user.name || '—'}</span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">{user.email}</div>
                    {relay?.id ? <div className="font-mono text-[11px] text-slate-600">{relay.id}</div> : null}
                  </td>
                  <td className="py-2 px-3 text-slate-300">{formatOrganizationLabel(org)}</td>
                  <td className="py-2 px-3 text-center"><Badge tone={role === 'owner' ? 'yellow' : role === 'admin' ? 'blue' : 'gray'}>{role}</Badge></td>
                  <td className="py-2 px-3 text-center"><Badge tone={!user.banned && (relay?.isActive ?? true) ? 'green' : 'red'}>{!user.banned && (relay?.isActive ?? true) ? 'Active' : 'Disabled'}</Badge></td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtNum(relay?.totalRequests ?? 0)}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtTokens((relay?.totalInputTokens ?? 0) + (relay?.totalOutputTokens ?? 0))}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtMoneyMicros(relay?.balanceMicros ?? '0', relay?.billingCurrency ?? 'USD')}</td>
                </tr>
              )
            })}
            {users.length === 0 ? <tr><td className="py-6 text-center text-slate-500" colSpan={7}>No users in this organization.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function userBelongsToOrganization(user: BetterAuthManagedUser, org: BetterAuthOrganization) {
  if (user.relay?.orgId) {
    return Boolean(findOrganizationByRelayOrgId([org], user.relay.orgId))
  }
  return user.organizations.some((membership) => (
    membership.id === org.id ||
    Boolean(findOrganizationByRelayOrgId([org], membership.relayOrgId || membership.slug || membership.name))
  ))
}

function getOrganizationRole(user: BetterAuthManagedUser, org: BetterAuthOrganization) {
  const membership = user.organizations.find((item) => (
    item.id === org.id ||
    Boolean(findOrganizationByRelayOrgId([org], item.relayOrgId || item.slug || item.name))
  ))
  return membership?.role ?? 'access'
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'org'
}

function safeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
