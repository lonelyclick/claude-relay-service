import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createBetterAuthOrganization,
  createBetterAuthUser,
  listBetterAuthSyncedUsers,
  updateBetterAuthUser,
  banBetterAuthUser,
  unbanBetterAuthUser,
  type BetterAuthManagedUser,
} from '~/api/betterAuth'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge } from '~/components/Badge'
import { fmtMoneyMicros, fmtTokens, fmtNum } from '~/lib/format'
import { cn } from '~/lib/cn'
import { buildOrganizationDetailHref, buildUserDetailHref } from './userDetailLinks'
import {
  findOrganizationByRelayOrgId,
  getOrganizationPrimaryLabel,
  getOrganizationSecondaryLabel,
  formatOrganizationLabel,
  type DisplayOrganization,
} from './orgDisplay'

type CreateUserForm = {
  email: string
  name: string
  password: string
  role: string
  organizationId: string
}

const emptyCreateUserForm: CreateUserForm = {
  email: '',
  name: '',
  password: '',
  role: 'user',
  organizationId: '',
}

export function UsersPage() {
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState<'users' | 'organizations'>(
    searchParams.get('tab') === 'organizations' ? 'organizations' : 'users',
  )
  const [isCreateOrgOpen, setIsCreateOrgOpen] = useState(false)
  const [createOrgForm, setCreateOrgForm] = useState({ name: '', slug: '' })
  const [isCreateUserOpen, setIsCreateUserOpen] = useState(false)
  const [createUserForm, setCreateUserForm] = useState<CreateUserForm>(emptyCreateUserForm)
  const [editingUser, setEditingUser] = useState<BetterAuthManagedUser | null>(null)
  const users = useQuery({ queryKey: ['better-auth-users'], queryFn: listBetterAuthSyncedUsers, retry: false })
  const refresh = () => qc.invalidateQueries({ queryKey: ['better-auth-users'] })

  useEffect(() => {
    setActiveTab(searchParams.get('tab') === 'organizations' ? 'organizations' : 'users')
  }, [searchParams])

  const selectTab = (tab: 'users' | 'organizations') => {
    setActiveTab(tab)
    setSearchParams(tab === 'organizations' ? { tab: 'organizations' } : {}, { replace: true })
  }

  const createUserMut = useMutation({
    mutationFn: createBetterAuthUser,
    onSuccess: () => {
      setIsCreateUserOpen(false)
      setCreateUserForm(emptyCreateUserForm)
      refresh()
    },
  })
  const createOrgMut = useMutation({
    mutationFn: createBetterAuthOrganization,
    onSuccess: () => {
      setIsCreateOrgOpen(false)
      setCreateOrgForm({ name: '', slug: '' })
      refresh()
    },
  })

  if (users.isLoading) return <PageSkeleton />

  if (users.error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        Users unavailable: {(users.error as Error).message}
      </div>
    )
  }

  const userList = users.data?.users ?? []
  const orgList = users.data?.organizations ?? []
  const orgAccessCounts = new Map(orgList.map((org) => [org.id, 0]))
  for (const user of userList) {
    if (user.relay?.orgId) {
      const org = findOrganizationByRelayOrgId(orgList, user.relay.orgId)
      if (org?.id) orgAccessCounts.set(org.id, (orgAccessCounts.get(org.id) ?? 0) + 1)
      continue
    }
    for (const membership of user.organizations) {
      const org = findOrganizationByRelayOrgId(orgList, membership.relayOrgId || membership.slug || membership.name)
      if (org?.id) orgAccessCounts.set(org.id, (orgAccessCounts.get(org.id) ?? 0) + 1)
    }
  }
  const isMutating = createUserMut.isPending || createOrgMut.isPending
  const mutationError = firstError(createUserMut.error, createOrgMut.error)

  const onOpenCreateUser = () => {
    createUserMut.reset()
    setCreateUserForm(emptyCreateUserForm)
    setIsCreateUserOpen(true)
  }

  const onSubmitCreateUser = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = createUserForm.email.trim()
    const name = createUserForm.name.trim() || email.split('@')[0]
    if (!email || !name) return
    createUserMut.mutate({
      email,
      name,
      password: createUserForm.password.trim() || undefined,
      role: createUserForm.role.trim() || 'user',
      organizationId: createUserForm.organizationId.trim() || undefined,
    })
  }

  const onOpenCreateOrg = () => {
    createOrgMut.reset()
    setCreateOrgForm({ name: '', slug: '' })
    setIsCreateOrgOpen(true)
  }

  const onSubmitCreateOrg = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = createOrgForm.name.trim()
    const slug = (createOrgForm.slug.trim() || slugify(name)).trim()
    if (!name || !slug) return
    createOrgMut.mutate({ name, slug, metadata: { relayOrgId: slug } })
  }

  return (
    <div className="space-y-5">
      {mutationError ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {mutationError}
        </div>
      ) : null}

      <section className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <SummaryCard label="Users" value={fmtNum(userList.length)} />
        <SummaryCard label="Organizations" value={fmtNum(orgList.length)} />
      </section>

      <div className="flex border-b border-border-default">
        <button
          className={cn(
            'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            activeTab === 'users'
              ? 'text-indigo-400 border-blue-400'
              : 'text-slate-400 border-transparent hover:text-slate-200',
          )}
          onClick={() => selectTab('users')}
        >
          Users
        </button>
        <button
          className={cn(
            'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            activeTab === 'organizations'
              ? 'text-indigo-400 border-blue-400'
              : 'text-slate-400 border-transparent hover:text-slate-200',
          )}
          onClick={() => selectTab('organizations')}
        >
          Organizations
        </button>
      </div>

      {activeTab === 'users' ? (
      <section className="bg-bg-card border border-border-default rounded-xl shadow-xs">
        <div className="flex items-center justify-between gap-3 p-4 border-b border-border-default">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Users</h2>
            <p className="text-xs text-slate-500 mt-1">Better Auth users are the source of truth; usage and routing are shown on the same row.</p>
          </div>
          <button className="rounded-lg bg-accent-muted border border-blue-500/30 px-3 py-1.5 text-xs font-medium text-indigo-200 disabled:opacity-50" disabled={isMutating} onClick={onOpenCreateUser}>New User</button>
        </div>
        {userList.length === 0 ? (
          <div className="text-center text-slate-500 py-8">No users yet.</div>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                  <th className="text-left py-2 px-3">User</th>
                  <th className="text-left py-2 px-3">Org</th>
                  <th className="text-center py-2 px-3">Role</th>
                  <th className="text-center py-2 px-3">Tier</th>
                  <th className="text-center py-2 px-3">Routing</th>
                  <th className="text-center py-2 px-3">Billing</th>
                  <th className="text-right py-2 px-3">Balance</th>
                  <th className="text-right py-2 px-3">Sessions</th>
                  <th className="text-right py-2 px-3">Requests</th>
                  <th className="text-right py-2 px-3">Tokens</th>
                  <th className="text-center py-2 px-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {userList.map((user) => {
                  const relay = user.relay
                  return (
                    <tr key={user.id} className="border-b border-border-default/50 last:border-b-0 hover:bg-bg-card-raised/30">
                      <td className="py-2 px-3">
                        <div className="font-medium text-slate-100">
                          {relay ? (
                            <Link to={buildUserDetailHref(relay.id, {})} className="text-indigo-300 hover:text-indigo-200">{user.name || relay.name || '—'} ↗</Link>
                          ) : (
                            <button type="button" className="text-left text-indigo-300 hover:text-indigo-200" onClick={() => setEditingUser(user)}>{user.name || '—'} ✎</button>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{user.email}</div>
                        {relay?.id ? <div className="font-mono text-[11px] text-slate-600">{relay.id}</div> : null}
                      </td>
                      <td className="py-2 px-3">
                        <UserOrganizationList
                          organizations={user.organizations}
                          fallbackOrganization={relay?.orgId ? findOrganizationByRelayOrgId(orgList, relay.orgId) : null}
                          fallbackOrgId={relay?.orgId ?? null}
                        />
                      </td>
                      <td className="py-2 px-3 text-center"><Badge tone={user.role === 'admin' ? 'yellow' : 'gray'}>{user.role ?? 'user'}</Badge></td>
                      <td className="py-2 px-3 text-center">
                        <Badge tone={relay?.customerTier === 'enterprise'  ? 'blue' : relay?.customerTier === 'business' ? 'blue' : relay?.customerTier === 'plus' ? 'cyan' : relay?.customerTier === 'internal' ? 'yellow' : 'gray'}>{relay?.customerTier ?? 'standard'}</Badge>
                        {relay?.riskStatus && relay.riskStatus !== 'normal' ? <div className="mt-1"><Badge tone="red">{relay.riskStatus}</Badge></div> : null}
                      </td>
                      <td className="py-2 px-3 text-center"><Badge tone={relay?.routingMode === 'auto' ? 'green' : relay?.routingMode === 'pinned_account' ? 'blue' : 'cyan'}>{relay?.routingMode ?? 'auto'}</Badge></td>
                      <td className="py-2 px-3 text-center">
                        <Badge tone={relay?.billingMode === 'prepaid' ? 'yellow' : 'gray'}>{relay?.billingMode ?? 'postpaid'}</Badge>
                        <div className="mt-1"><Badge tone="blue">{relay?.billingCurrency ?? 'USD'}</Badge></div>
                      </td>
                      <td className="py-2 px-3 text-right text-slate-300">
                        <div>{fmtMoneyMicros(relay?.balanceMicros ?? '0', relay?.billingCurrency ?? 'USD')}</div>
                        <div className="text-[10px] text-slate-600">legacy user</div>
                      </td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtNum(relay?.sessionCount ?? 0)}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtNum(relay?.totalRequests ?? 0)}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtTokens((relay?.totalInputTokens ?? 0) + (relay?.totalOutputTokens ?? 0))}</td>
                      <td className="py-2 px-3 text-center"><Badge tone={!user.banned && (relay?.isActive ?? true) ? 'green' : 'red'}>{!user.banned && (relay?.isActive ?? true) ? 'Active' : 'Disabled'}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      {activeTab === 'organizations' ? (
      <section className="bg-bg-card border border-border-default rounded-xl shadow-xs">
        <div className="flex items-center justify-between gap-3 p-4 border-b border-border-default">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Organizations</h2>
            <p className="text-xs text-slate-500 mt-1">Create and review Better Auth organizations here; edit membership from user detail pages.</p>
          </div>
          <button className="rounded-lg bg-accent-muted border border-blue-500/30 px-3 py-1.5 text-xs font-medium text-indigo-200 disabled:opacity-50" disabled={isMutating} onClick={onOpenCreateOrg}>New Org</button>
        </div>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                <th className="text-left py-2 px-3">Org</th>
                <th className="text-left py-2 px-3">Slug</th>
                <th className="text-right py-2 px-3">Users</th>
              </tr>
            </thead>
            <tbody>
              {orgList.map((org) => (
                <tr key={org.id} className="border-b border-border-default/50 last:border-b-0 hover:bg-bg-card-raised/30">
                  <td className="py-2 px-3">
                    <OrganizationLink org={org} />
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-slate-500">{org.slug}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtNum(orgAccessCounts.get(org.id) ?? org.memberCount ?? 0)}</td>
                </tr>
              ))}
              {orgList.length === 0 ? <tr><td className="py-6 text-center text-slate-500" colSpan={3}>No organizations yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
      ) : null}

      {isCreateUserOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <form className="w-full max-w-md rounded-xl border border-border-default bg-bg-card p-5 shadow-modal" onSubmit={onSubmitCreateUser}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">New User</h3>
                <p className="mt-1 text-xs text-slate-500">在 Better Auth 创建用户。Display Name 留空将默认取 email 前缀。</p>
              </div>
              <button type="button" className="text-slate-500 hover:text-slate-300" onClick={() => setIsCreateUserOpen(false)}>✕</button>
            </div>
            {createUserMut.error ? (
              <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {(createUserMut.error as Error).message}
              </div>
            ) : null}
            <label className="mt-4 block text-xs font-medium text-slate-400">
              Email *
              <input
                type="email"
                autoFocus
                required
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
                value={createUserForm.email}
                onChange={(event) => setCreateUserForm((form) => ({
                  ...form,
                  email: event.target.value,
                  name: form.name || event.target.value.split('@')[0] || '',
                }))}
                placeholder="user@example.com"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-400">
              Display Name
              <input
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
                value={createUserForm.name}
                onChange={(event) => setCreateUserForm((form) => ({ ...form, name: event.target.value }))}
                placeholder="留空取 email 前缀"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-400">
              Initial Password <span className="text-slate-600">(留空表示不设密码)</span>
              <input
                type="password"
                autoComplete="new-password"
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
                value={createUserForm.password}
                onChange={(event) => setCreateUserForm((form) => ({ ...form, password: event.target.value }))}
              />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <label className="block text-xs font-medium text-slate-400">
                Role
                <select
                  className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
                  value={createUserForm.role}
                  onChange={(event) => setCreateUserForm((form) => ({ ...form, role: event.target.value }))}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-slate-400">
                Organization
                <select
                  className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
                  value={createUserForm.organizationId}
                  onChange={(event) => setCreateUserForm((form) => ({ ...form, organizationId: event.target.value }))}
                  disabled={orgList.length === 0}
                >
                  <option value="">{orgList.length === 0 ? '— 无可选 org —' : '— 不绑定 —'}</option>
                  {orgList.map((org) => (
                    <option key={org.id} value={org.id}>{formatOrganizationLabel(org)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-border-default px-3 py-2 text-sm text-slate-300 hover:bg-bg-card-raised" onClick={() => setIsCreateUserOpen(false)}>Cancel</button>
              <button type="submit" className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={createUserMut.isPending || !createUserForm.email.trim()}>
                {createUserMut.isPending ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {isCreateOrgOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <form className="w-full max-w-md rounded-xl border border-border-default bg-bg-card p-5 shadow-modal" onSubmit={onSubmitCreateOrg}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">New Organization</h3>
                <p className="mt-1 text-xs text-slate-500">Create an organization in Better Auth.</p>
              </div>
              <button type="button" className="text-slate-500 hover:text-slate-300" onClick={() => setIsCreateOrgOpen(false)}>✕</button>
            </div>
            {createOrgMut.error ? (
              <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {(createOrgMut.error as Error).message}
              </div>
            ) : null}
            <label className="mt-4 block text-xs font-medium text-slate-400">
              Name
              <input
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
                autoFocus
                value={createOrgForm.name}
                onChange={(event) => setCreateOrgForm((form) => ({ ...form, name: event.target.value, slug: form.slug || slugify(event.target.value) }))}
                placeholder="Acme Team"
              />
            </label>
            <label className="mt-4 block text-xs font-medium text-slate-400">
              Slug
              <input
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-accent"
                value={createOrgForm.slug}
                onChange={(event) => setCreateOrgForm((form) => ({ ...form, slug: slugify(event.target.value) }))}
                placeholder="acme-team"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-border-default px-3 py-2 text-sm text-slate-300 hover:bg-bg-card-raised" onClick={() => setIsCreateOrgOpen(false)}>Cancel</button>
              <button type="submit" className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={createOrgMut.isPending || !createOrgForm.name.trim()}>
                {createOrgMut.isPending ? 'Creating…' : 'Create Org'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {editingUser ? (
        <BetterAuthUserEditor
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onUpdated={() => {
            setEditingUser(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function BetterAuthUserEditor({
  user,
  onClose,
  onUpdated,
}: {
  user: BetterAuthManagedUser
  onClose: () => void
  onUpdated: () => void
}) {
  const [form, setForm] = useState({
    name: user.name ?? '',
    email: user.email ?? '',
    role: user.role ?? 'user',
  })
  const updateMut = useMutation({
    mutationFn: () => updateBetterAuthUser(user.id, {
      name: form.name.trim(),
      email: form.email.trim(),
      role: form.role.trim() || 'user',
    }),
    onSuccess: onUpdated,
  })
  const banMut = useMutation({
    mutationFn: () => banBetterAuthUser(user.id),
    onSuccess: onUpdated,
  })
  const unbanMut = useMutation({
    mutationFn: () => unbanBetterAuthUser(user.id),
    onSuccess: onUpdated,
  })
  const isPending = updateMut.isPending || banMut.isPending || unbanMut.isPending
  const dirty = form.name.trim() !== (user.name ?? '') || form.email.trim() !== (user.email ?? '') || form.role.trim() !== (user.role ?? 'user')
  const error = firstError(updateMut.error, banMut.error, unbanMut.error)

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.name.trim() || !form.email.trim()) return
    updateMut.mutate()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <form className="w-full max-w-lg rounded-xl border border-border-default bg-bg-card p-5 shadow-modal" onSubmit={onSubmit}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">Edit User</h3>
            <p className="mt-1 text-xs text-slate-500">This Better Auth user is not attached to a relay usage record yet.</p>
            <div className="mt-2 font-mono text-[11px] text-slate-600">{user.id}</div>
          </div>
          <button type="button" className="text-slate-500 hover:text-slate-300" onClick={onClose}>✕</button>
        </div>
        {error ? (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <label className="text-xs font-medium text-slate-400">
            Name
            <input className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="text-xs font-medium text-slate-400">
            Email
            <input className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
          </label>
          <label className="text-xs font-medium text-slate-400">
            Role
            <select className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent" value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <div className="flex items-end gap-2">
            <Badge tone={user.banned ? 'red' : 'green'}>{user.banned ? 'Disabled' : 'Active'}</Badge>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="rounded-lg border border-border-default px-3 py-2 text-sm text-slate-300 hover:bg-bg-card-raised" onClick={onClose}>Cancel</button>
          {user.banned ? (
            <button type="button" className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300 disabled:opacity-50" disabled={isPending} onClick={() => unbanMut.mutate()}>Unban</button>
          ) : (
            <button type="button" className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-300 disabled:opacity-50" disabled={isPending} onClick={() => banMut.mutate()}>Ban</button>
          )}
          <button type="submit" className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={isPending || !dirty || !form.name.trim() || !form.email.trim()}>{updateMut.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  )
}

function UserOrganizationList({
  organizations,
  fallbackOrganization,
  fallbackOrgId,
}: {
  organizations: Array<DisplayOrganization & { role?: string | null; memberId?: string | null }>
  fallbackOrganization?: DisplayOrganization | null
  fallbackOrgId?: string | null
}) {
  if (fallbackOrgId) {
    return <OrganizationName org={fallbackOrganization} fallback={fallbackOrgId} />
  }

  if (organizations.length > 0) {
    return (
      <>
        {organizations.map((org) => (
          <div key={org.memberId ?? org.id ?? formatOrganizationLabel(org)} className="mb-1 last:mb-0">
            <OrganizationName org={org} />
            {org.role ? <span className="ml-2 text-[11px] text-slate-500">{org.role}</span> : null}
          </div>
        ))}
      </>
    )
  }

  return <span className="text-slate-500">—</span>
}

function OrganizationName({
  org,
  fallback,
  strong = false,
}: {
  org?: DisplayOrganization | null
  fallback?: string | null
  strong?: boolean
}) {
  const secondary = getOrganizationSecondaryLabel(org)
  return (
    <>
      <span className={strong ? 'font-medium text-slate-100' : 'text-slate-300'}>
        {getOrganizationPrimaryLabel(org, fallback)}
      </span>
      {secondary ? <span className="ml-2 font-mono text-[11px] text-slate-500">{secondary}</span> : null}
    </>
  )
}

function OrganizationLink({ org }: { org: DisplayOrganization & { id?: string } }) {
  const secondary = getOrganizationSecondaryLabel(org)
  return (
    <>
      <Link to={buildOrganizationDetailHref(org.id ?? '')} className="font-medium text-indigo-300 hover:text-indigo-200">
        {getOrganizationPrimaryLabel(org)}
      </Link>
      {secondary ? <span className="ml-2 font-mono text-[11px] text-slate-500">{secondary}</span> : null}
    </>
  )
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'org'
}

function firstError(...errors: Array<Error | null>) {
  return errors.find(Boolean)?.message ?? null
}

function SummaryCard({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs">
      <div className="text-base font-semibold text-slate-100 break-all">{value}</div>
      <div className="text-xs text-slate-400 mt-1">{label}</div>
    </div>
  )
}
