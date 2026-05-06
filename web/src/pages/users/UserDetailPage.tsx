import { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createUserApiKey,
  getUser,
  getUserSessions,
  getUserRequests,
  getSessionRequests,
  listUserApiKeys,
  revokeUserApiKey,
  updateUserApiKeyGroups,
  updateUser,
  deleteUser,
  getUserApiKeyPlaintext,
} from '~/api/users'
import {
  getBillingUserBalance,
  getBillingUserLedger,
  getBillingOrganizationBalance,
  getBillingOrganizationLedger,
  createBillingOrganizationLedgerEntry,
} from '~/api/billing'
import type { BillingBalanceSummary, BillingCurrency, BillingLedgerEntry, RelayApiKey, RelayKeySource, RoutingGroup } from '~/api/types'
import { banBetterAuthUser, deleteBetterAuthUser, listBetterAuthSyncedUsers, unbanBetterAuthUser, updateBetterAuthUser, type BetterAuthManagedUser } from '~/api/betterAuth'
import { listRoutingGroups } from '~/api/routing'
import { Badge } from '~/components/Badge'
import { cn } from '~/lib/cn'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, fmtTokens, fmtNum, timeAgo, truncateMiddle } from '~/lib/format'
import {
  buildSessionAnchorId,
  buildSessionRequestAnchorId,
  buildRequestDetailHref,
  buildUserDetailHref,
  buildUsersHref,
  isRestoredSessionRequestHighlighted,
  normalizeUserDetailRelayKeySource,
  readUserDetailPageState,
  RESTORED_SESSION_REQUEST_HIGHLIGHT_MS,
  resolveExpandedSessionKey,
  resolveRestoredSessionRequestId,
  type UserDetailReturnState,
} from './userDetailLinks'
import {
  getUserDetailLedgerKindLabel,
  getUserDetailLedgerKindTone,
  getUserDetailRelayKeySourceLabel,
  getUserDetailRelayKeySourceTone,
  userDetailRelayKeySourceOptions,
} from './userDetailPresentation'
import {
  findOrganizationByRelayOrgId,
  formatOrganizationLabel,
  isPersonalOrganization,
  type DisplayOrganization,
} from './orgDisplay'

function moneyInputToMicros(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const sign = trimmed.startsWith('-') ? -1n : 1n
  const normalized = trimmed.replace(/^[+-]/, '')
  if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) {
    return null
  }

  const [wholePart, fractionPart = ''] = normalized.split('.')
  const whole = BigInt(wholePart || '0')
  const fraction = BigInt((fractionPart + '000000').slice(0, 6) || '0')
  return (sign * (whole * 1_000_000n + fraction)).toString()
}

const billingCurrencies: BillingCurrency[] = ['CNY', 'USD']
const customerTiers = ['standard', 'plus', 'business', 'enterprise', 'internal'] as const
const riskStatuses = ['normal', 'watch', 'restricted', 'blocked'] as const

function microsToMoneyInput(value?: string | null): string {
  const micros = BigInt(value && /^\d+$/.test(value) ? value : '0')
  const whole = micros / 1_000_000n
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const pageState = readUserDetailPageState(searchParams)
  const deviceFilter = pageState.device ?? ''
  const relayKeySourceFilter = pageState.relayKeySource
  const restoredSessionKey = pageState.sessionKey ?? null
  const restoredSessionRequestId = pageState.sessionRequestId ?? null
  const requestDetailReturnState: UserDetailReturnState = {
    device: deviceFilter || null,
    relayKeySource: relayKeySourceFilter,
  }

  const user = useQuery({ queryKey: ['user', id], queryFn: () => getUser(id!) })
  const sessions = useQuery({ queryKey: ['user-sessions', id], queryFn: () => getUserSessions(id!) })
  const requests = useQuery({
    queryKey: ['user-requests', id, relayKeySourceFilter],
    queryFn: () => getUserRequests(id!, 100, 0, relayKeySourceFilter),
  })
  const balance = useQuery({ queryKey: ['billing-balance', id], queryFn: () => getBillingUserBalance(id!), retry: false })
  const ledger = useQuery({ queryKey: ['billing-ledger', id], queryFn: () => getBillingUserLedger(id!, 20, 0), retry: false })
  const betterAuthUsers = useQuery({ queryKey: ['better-auth-users'], queryFn: listBetterAuthSyncedUsers, retry: false })

  const sessionList = sessions.data?.sessions ?? []
  const requestList = requests.data?.requests ?? []
  const requestTotal = requests.data?.total ?? requestList.length

  const devices = useMemo(() => {
    const devs = new Set<string>()
    sessionList.forEach((s) => { if (s.clientDeviceId) devs.add(s.clientDeviceId) })
    requestList.forEach((r) => { if (r.clientDeviceId) devs.add(r.clientDeviceId) })
    return [...devs].sort()
  }, [sessionList, requestList])

  const filteredSessions = deviceFilter ? sessionList.filter((s) => s.clientDeviceId === deviceFilter) : sessionList
  const filteredRequests = deviceFilter ? requestList.filter((r) => r.clientDeviceId === deviceFilter) : requestList

  useEffect(() => {
    const targetId = location.hash.startsWith('#session-')
      ? location.hash.slice(1)
      : location.hash === '#requests'
        ? 'requests'
        : null
    if (!targetId) {
      return
    }

    const target = document.getElementById(targetId)
    if (!target) {
      return
    }

    window.requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start' })
    })
  }, [location.hash, requestTotal, relayKeySourceFilter, deviceFilter, restoredSessionKey, sessionList.length])

  if (user.isLoading) return <PageSkeleton />
  if (user.error) return <div className="text-red-400 text-sm">Failed to load user: {(user.error as Error).message}</div>
  if (!user.data) return <div className="text-slate-400 text-sm">User not found</div>

  const u = user.data
  const betterAuthUser = betterAuthUsers.data?.users.find((item) => item.relay?.id === u.id) ?? null
  const betterAuthOrganizations = betterAuthUsers.data?.organizations ?? []
  const userBillingOrganizations = betterAuthUser?.organizations ?? []
  const currentOrganization = findOrganizationByRelayOrgId(betterAuthOrganizations, u.orgId)

  return (
    <div className="space-y-5">
      <button
        onClick={() => navigate(buildUsersHref())}
        className="text-sm text-slate-400 hover:text-slate-200"
      >
        &larr; Back to Users
      </button>

      <UserHeader user={u} organization={currentOrganization} />
      <UserManagementSection relayUser={u} betterAuthUser={betterAuthUser} />
      <OrgSection user={u} organizations={betterAuthOrganizations} />
      <ApiKeySection userId={u.id} />
      <BillingSection
        user={u}
        organizations={userBillingOrganizations}
        balance={balance.data ?? null}
        ledgerEntries={ledger.data?.entries ?? []}
        ledgerTotal={ledger.data?.total ?? 0}
        requestDetailReturnState={requestDetailReturnState}
      />
      <InventoryFilters
        devices={devices}
        currentDevice={deviceFilter}
        currentRelayKeySource={relayKeySourceFilter}
        userId={u.id}
      />
      <SessionsSection
        sessions={filteredSessions}
        userId={u.id}
        relayKeySourceFilter={relayKeySourceFilter}
        requestDetailReturnState={requestDetailReturnState}
        restoredSessionKey={restoredSessionKey}
        restoredSessionRequestId={restoredSessionRequestId}
      />
      <RequestsSection
        requests={filteredRequests}
        total={requestTotal}
        userId={u.id}
        relayKeySourceFilter={relayKeySourceFilter}
        requestDetailReturnState={requestDetailReturnState}
      />
      <DangerZone user={u} />
    </div>
  )
}

function UserHeader({
  user: u,
  organization,
}: {
  user: { id: string; name: string; isActive: boolean; orgId?: string | null; routingMode?: string; accountId?: string; routingGroupId?: string; totalRequests?: number; totalInputTokens?: number; totalOutputTokens?: number; billingMode?: 'postpaid' | 'prepaid'; billingCurrency?: BillingCurrency; customerTier?: string; creditLimitMicros?: string; salesOwner?: string | null; riskStatus?: string; balanceMicros?: string }
  organization?: DisplayOrganization | null
}) {
  const billingMode = u.billingMode ?? 'postpaid'
  const billingCurrency = u.billingCurrency ?? 'USD'
  const organizationLabel = organization ? formatOrganizationLabel(organization, u.orgId) : (u.orgId ?? '—')
  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-100">{u.name}</h2>
          <div className="text-xs text-slate-500 font-mono">{u.id}</div>
          <div className="text-xs text-slate-500">Org: {organizationLabel}</div>
        </div>
        <Badge tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'Active' : 'Disabled'}</Badge>
      </div>
      <div className="flex gap-2 mt-2 text-xs">
        <Badge tone="blue">{fmtNum(u.totalRequests ?? 0)} requests</Badge>
        <Badge tone="cyan">{fmtTokens((u.totalInputTokens ?? 0) + (u.totalOutputTokens ?? 0))} tokens</Badge>
        <Badge tone={billingMode === 'prepaid' ? 'yellow' : 'gray'}>{billingMode}</Badge>
        <Badge tone={u.customerTier === 'enterprise'  ? 'blue' : u.customerTier === 'business' ? 'blue' : u.customerTier === 'plus' ? 'cyan' : 'gray'}>{u.customerTier ?? 'standard'}</Badge>
        <Badge tone="blue">{billingCurrency}</Badge>
        <Badge tone="gray">workspace balance in Billing section</Badge>
      </div>
    </section>
  )
}

function UserManagementSection({
  relayUser,
  betterAuthUser,
}: {
  relayUser: { id: string; name: string; isActive: boolean }
  betterAuthUser: BetterAuthManagedUser | null
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', role: 'user' })

  useEffect(() => {
    setForm({
      name: betterAuthUser?.name || relayUser.name || '',
      email: betterAuthUser?.email || '',
      role: betterAuthUser?.role || 'user',
    })
  }, [betterAuthUser?.id, betterAuthUser?.name, betterAuthUser?.email, betterAuthUser?.role, relayUser.name])

  const updateAuthMut = useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: Parameters<typeof updateBetterAuthUser>[1] }) => updateBetterAuthUser(userId, body),
    onSuccess: (_data, variables) => {
      const nextName = variables.body.name?.trim()
      if (nextName) {
        qc.setQueryData(['user', relayUser.id], (old: unknown) =>
          old && typeof old === 'object' ? { ...old, name: nextName } : old,
        )
      }
      toast.success('User updated')
      qc.invalidateQueries({ queryKey: ['better-auth-users'] })
      qc.invalidateQueries({ queryKey: ['user', relayUser.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => toast.error(e.message),
  })
  const banMut = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason?: string }) => banBetterAuthUser(userId, reason),
    onSuccess: () => {
      qc.setQueryData(['user', relayUser.id], (old: unknown) =>
        old && typeof old === 'object' ? { ...old, isActive: false } : old,
      )
      toast.success('User disabled')
      qc.invalidateQueries({ queryKey: ['better-auth-users'] })
      qc.invalidateQueries({ queryKey: ['user', relayUser.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => toast.error(e.message),
  })
  const unbanMut = useMutation({
    mutationFn: unbanBetterAuthUser,
    onSuccess: () => {
      qc.setQueryData(['user', relayUser.id], (old: unknown) =>
        old && typeof old === 'object' ? { ...old, isActive: true } : old,
      )
      toast.success('User enabled')
      qc.invalidateQueries({ queryKey: ['better-auth-users'] })
      qc.invalidateQueries({ queryKey: ['user', relayUser.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => toast.error(e.message),
  })
  const deleteAuthMut = useMutation({
    mutationFn: deleteBetterAuthUser,
    onSuccess: () => {
      toast.success('User deleted')
      qc.invalidateQueries({ queryKey: ['better-auth-users'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      navigate('/users')
    },
    onError: (e) => toast.error(e.message),
  })

  const onSave = () => {
    if (!betterAuthUser) return
    const name = form.name.trim()
    const email = form.email.trim()
    const role = form.role.trim() || 'user'
    if (!name || !email) {
      toast.error('Name and email are required')
      return
    }
    updateAuthMut.mutate({ userId: betterAuthUser.id, body: { name, email, role } })
  }

  const isPending = updateAuthMut.isPending || banMut.isPending || unbanMut.isPending || deleteAuthMut.isPending
  const dirty = Boolean(betterAuthUser) && (
    form.name.trim() !== (betterAuthUser?.name || relayUser.name || '') ||
    form.email.trim() !== (betterAuthUser?.email || '') ||
    form.role.trim() !== (betterAuthUser?.role || 'user')
  )

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">User Management</div>
      {betterAuthUser ? (
        <div className="grid grid-cols-[1fr_auto] gap-4 max-lg:grid-cols-1">
          <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
            <label className="text-xs font-medium text-slate-400">
              Name
              <input
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-accent"
                value={form.name}
                onChange={(event) => setForm((next) => ({ ...next, name: event.target.value }))}
              />
            </label>
            <label className="text-xs font-medium text-slate-400">
              Email
              <input
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-accent"
                value={form.email}
                onChange={(event) => setForm((next) => ({ ...next, email: event.target.value }))}
              />
            </label>
            <label className="text-xs font-medium text-slate-400">
              Role
              <select
                className="mt-1 w-full rounded-lg border border-border-default bg-bg-input px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-accent"
                value={form.role}
                onChange={(event) => setForm((next) => ({ ...next, role: event.target.value }))}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <div className="flex gap-2 md:col-span-3">
              <Badge tone={betterAuthUser.banned || !relayUser.isActive ? 'red' : 'green'}>{betterAuthUser.banned || !relayUser.isActive ? 'Disabled' : 'Active'}</Badge>
              <span className="font-mono text-[11px] text-slate-600">{betterAuthUser.id}</span>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap justify-end self-end">
            <button onClick={onSave} disabled={isPending || !dirty} className="px-3 py-1.5 rounded-lg text-sm bg-accent-muted border border-blue-500/30 text-indigo-300 hover:bg-accent-muted disabled:opacity-50">Save</button>
            {betterAuthUser.banned ? (
              <button onClick={() => unbanMut.mutate(betterAuthUser.id)} disabled={isPending} className="px-3 py-1.5 rounded-lg text-sm bg-green-500/10 border border-green-500/30 text-green-300 hover:bg-green-500/20 disabled:opacity-50">Unban</button>
            ) : (
              <button onClick={() => banMut.mutate({ userId: betterAuthUser.id })} disabled={isPending} className="px-3 py-1.5 rounded-lg text-sm bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-50">Ban</button>
            )}
            <button onClick={() => { if (confirm(`Delete user "${betterAuthUser.email}"? This cannot be undone.`)) deleteAuthMut.mutate(betterAuthUser.id) }} disabled={isPending} className="px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 disabled:opacity-50">Delete</button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-500">This usage record has not been attached to a Better Auth user yet.</div>
      )}
    </section>
  )
}

function OrgSection({
  user: u,
  organizations,
}: {
  user: { id: string; orgId?: string | null }
  organizations: DisplayOrganization[]
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const [orgId, setOrgId] = useState(u.orgId ?? '')

  useEffect(() => {
    setOrgId(u.orgId ?? '')
  }, [u.id, u.orgId])

  const dirty = orgId !== (u.orgId ?? '')
  const selectedOrganization = findOrganizationByRelayOrgId(organizations, orgId)

  const mut = useMutation({
    mutationFn: () => updateUser(u.id, { orgId: orgId.trim() || null }),
    onSuccess: () => {
      const nextOrgId = orgId.trim() || null
      qc.setQueryData(['user', u.id], (old: unknown) =>
        old && typeof old === 'object' ? { ...old, orgId: nextOrgId } : old,
      )
      toast.success('Org updated')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['better-auth-users'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Organization</div>
      <div className="flex gap-3 max-md:flex-col">
        <select
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="flex-1 bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 font-mono"
        >
          <option value="">No organization</option>
          {orgId && !selectedOrganization ? <option value={orgId}>{orgId}</option> : null}
          {organizations.map((org) => (
            <option key={org.id} value={org.relayOrgId || org.slug || org.name || ''}>{formatOrganizationLabel(org)}</option>
          ))}
        </select>
        <button onClick={() => mut.mutate()} disabled={!dirty || mut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50">
          Save Organization
        </button>
      </div>
      <div className="text-xs text-slate-500 mt-2">选择这个用户所属的 Better Auth 组织；后台会用同一个组织关系承载访问和用量归属。</div>
    </section>
  )
}

function ApiKeySection({ userId }: { userId: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [revealed, setRevealed] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [newGroups, setNewGroups] = useState<RelayApiKey['groupAssignments']>({ anthropic: '', openai: '', google: '' })
  const apiKeys = useQuery({
    queryKey: ['user-api-keys', userId],
    queryFn: () => listUserApiKeys(userId),
  })
  const groups = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })

  const createMut = useMutation({
    mutationFn: () => createUserApiKey(userId, { name: newKeyName || undefined, groupAssignments: normalizeKeyGroups(newGroups) }),
    onSuccess: (data) => {
      setRevealed(data.apiKey)
      setNewKeyName('')
      setNewGroups({ anthropic: '', openai: '', google: '' })
      toast.success('Relay API key created')
      qc.invalidateQueries({ queryKey: ['user-api-keys', userId] })
    },
    onError: (e) => toast.error(e.message),
  })

  const revokeMut = useMutation({
    mutationFn: ({ keyId }: { keyId: string }) => revokeUserApiKey(userId, keyId),
    onSuccess: () => {
      setRevealed(null)
      toast.success('Relay API key revoked')
      qc.invalidateQueries({ queryKey: ['user-api-keys', userId] })
    },
    onError: (e) => toast.error(e.message),
  })

  const activeKeys = apiKeys.data?.apiKeys ?? []
  const routingGroups = groups.data?.routingGroups ?? []
  const canCreate = hasAtLeastOneGroup(newGroups)

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Relay API Keys</div>
      {revealed ? (
        <div className="flex items-center gap-2">
          <code className="text-xs text-slate-200 bg-bg-input px-2 py-1 rounded font-mono break-all">{revealed}</code>
          <button onClick={() => { navigator.clipboard.writeText(revealed); toast.success('Copied') }} className="text-xs text-indigo-400 hover:text-indigo-300 shrink-0">Copy</button>
        </div>
      ) : (
        <div className="text-xs text-slate-500">Create a relay API key to disclose a fresh reseller credential.</div>
      )}
      <div className="mt-3 space-y-3 rounded-lg border border-border-default bg-bg-input/30 p-3">
        <input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="Key name (optional)" className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
        <KeyGroupSelects groups={routingGroups} value={newGroups} onChange={setNewGroups} />
        <button
          onClick={() => createMut.mutate()}
          disabled={!canCreate || createMut.isPending}
          className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
        >
          Create Key
        </button>
      </div>
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-slate-500">
          <span>Active Keys ({activeKeys.length})</span>
        </div>
        {apiKeys.isLoading ? (
          <div className="text-xs text-slate-500">Loading relay API keys...</div>
        ) : activeKeys.length === 0 ? (
          <div className="text-xs text-slate-500">No active relay API keys.</div>
        ) : (
          <div className="space-y-2">
            {activeKeys.map((apiKey) => (
              <ApiKeyRow
                key={apiKey.id}
                apiKey={apiKey}
                groups={routingGroups}
                userId={userId}
                onRevoke={() => {
                  if (confirm(`Revoke relay API key "${apiKey.name}"? This key will stop working immediately.`)) {
                    revokeMut.mutate({ keyId: apiKey.id })
                  }
                }}
                pending={revokeMut.isPending}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ApiKeyRow({
  apiKey,
  groups,
  userId,
  onRevoke,
  pending,
}: {
  apiKey: RelayApiKey
  groups: RoutingGroup[]
  userId: string
  onRevoke: () => void
  pending: boolean
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const [groupAssignments, setGroupAssignments] = useState<RelayApiKey['groupAssignments']>(apiKey.groupAssignments)

  useEffect(() => {
    setGroupAssignments(apiKey.groupAssignments)
  }, [apiKey.id, apiKey.groupAssignments])

  const dirty = JSON.stringify(normalizeKeyGroups(groupAssignments)) !== JSON.stringify(normalizeKeyGroups(apiKey.groupAssignments))
  const canSave = dirty && hasAtLeastOneGroup(groupAssignments)
  const saveMut = useMutation({
    mutationFn: () => updateUserApiKeyGroups(userId, apiKey.id, normalizeKeyGroups(groupAssignments)),
    onSuccess: () => {
      toast.success('API key groups updated')
      qc.invalidateQueries({ queryKey: ['user-api-keys', userId] })
    },
    onError: (e) => toast.error(e.message),
  })
  const copyMut = useMutation({
    mutationFn: async () => {
      const data = await getUserApiKeyPlaintext(userId, apiKey.id)
      await navigator.clipboard.writeText(data.apiKey)
    },
    onSuccess: () => toast.success('Copied'),
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-bg-input/40 px-3 py-2 max-md:flex-col max-md:items-start">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-200">{apiKey.name}</span>
          <Badge tone="cyan">{truncateMiddle(apiKey.id, 18)}</Badge>
        </div>
        <div className="font-mono text-xs text-slate-400">{apiKey.keyPreview}</div>
        <div className="text-[11px] text-slate-500">
          Created {timeAgo(apiKey.createdAt)}
          {apiKey.lastUsedAt ? ` · Last used ${timeAgo(apiKey.lastUsedAt)}` : ' · Never used'}
        </div>
        <KeyGroupSelects groups={groups} value={groupAssignments} onChange={setGroupAssignments} compact />
      </div>
      <div className="flex gap-2">
        <button onClick={() => copyMut.mutate()} disabled={copyMut.isPending} className="text-xs text-indigo-300 hover:text-indigo-300 disabled:opacity-50">Copy</button>
        <button onClick={() => saveMut.mutate()} disabled={!canSave || saveMut.isPending} className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50">Save</button>
        <button
          onClick={onRevoke}
          disabled={pending}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
        >
          Revoke
        </button>
      </div>
    </div>
  )
}

function normalizeKeyGroups(value: RelayApiKey['groupAssignments']): RelayApiKey['groupAssignments'] {
  return {
    anthropic: value.anthropic || null,
    openai: value.openai || null,
    google: value.google || null,
  }
}

function hasAtLeastOneGroup(value: RelayApiKey['groupAssignments']): boolean {
  return Boolean(value.anthropic || value.openai || value.google)
}

function KeyGroupSelects({ groups, value, onChange, compact = false }: {
  groups: RoutingGroup[]
  value: RelayApiKey['groupAssignments']
  onChange: (value: RelayApiKey['groupAssignments']) => void
  compact?: boolean
}) {
  const renderSelect = (type: keyof RelayApiKey['groupAssignments'], label: string) => {
    const options = groups.filter((group) => group.type === type)
    return (
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
        <select value={value[type] ?? ''} onChange={(e) => onChange({ ...value, [type]: e.target.value || null })} className="block bg-bg-input border border-border-default rounded-lg px-2 py-1 text-xs text-slate-200 w-full">
          <option value="">—</option>
          {options.map((group) => (
            <option key={group.id} value={group.id}>{group.name || group.id}</option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-3 max-md:grid-cols-1' : 'grid-cols-3 max-md:grid-cols-1')}>
      {renderSelect('anthropic', 'Anthropic')}
      {renderSelect('openai', 'Openai')}
      {renderSelect('google', 'Google')}
    </div>
  )
}

function BillingSection({
  user: u,
  organizations,
  balance,
  ledgerEntries,
  ledgerTotal,
  requestDetailReturnState,
}: {
  user: { id: string; orgId?: string | null; billingMode?: 'postpaid' | 'prepaid'; billingCurrency?: BillingCurrency; customerTier?: string; creditLimitMicros?: string; salesOwner?: string | null; riskStatus?: string }
  organizations: DisplayOrganization[]
  balance: BillingBalanceSummary | null
  ledgerEntries: BillingLedgerEntry[]
  ledgerTotal: number
  requestDetailReturnState: UserDetailReturnState
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const userOrgId = u.orgId?.trim() || null
  const workspaceTargets = useMemo(() => {
    const targets = organizations
      .map((organization) => {
        const relayOrgId = organization.relayOrgId?.trim()
        if (!relayOrgId) return null
        return { relayOrgId, organization }
      })
      .filter((target): target is { relayOrgId: string; organization: DisplayOrganization } => target !== null)
    const seen = new Set<string>()
    return targets.filter((target) => {
      const key = target.relayOrgId.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [organizations])
  const defaultWorkspaceTarget = (() => {
    const currentWorkspace = userOrgId
      ? workspaceTargets.find((target) => target.relayOrgId.toLowerCase() === userOrgId.toLowerCase())
      : null
    if (currentWorkspace) return `org:${currentWorkspace.relayOrgId}`
    const personalWorkspace = workspaceTargets.find((target) => isPersonalOrganization(target.organization) || target.organization.slug?.startsWith('personal-'))
    if (personalWorkspace) return `org:${personalWorkspace.relayOrgId}`
    return workspaceTargets[0] ? `org:${workspaceTargets[0].relayOrgId}` : `user:${u.id}`
  })()
  const [billingTarget, setBillingTarget] = useState(defaultWorkspaceTarget)
  const [billingMode, setBillingMode] = useState<'postpaid' | 'prepaid'>(u.billingMode ?? 'postpaid')
  const [billingCurrency, setBillingCurrency] = useState<BillingCurrency>(u.billingCurrency ?? balance?.billingCurrency ?? balance?.currency ?? 'CNY')
  const [customerTier, setCustomerTier] = useState(u.customerTier ?? 'standard')
  const [creditLimit, setCreditLimit] = useState(microsToMoneyInput(u.creditLimitMicros))
  const [salesOwner, setSalesOwner] = useState(u.salesOwner ?? '')
  const [riskStatus, setRiskStatus] = useState(u.riskStatus ?? 'normal')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    setBillingTarget((current) => {
      if (current && workspaceTargets.some((target) => current === `org:${target.relayOrgId}`)) {
        return current
      }
      return defaultWorkspaceTarget
    })
  }, [defaultWorkspaceTarget, workspaceTargets])

  const target = parseBillingTarget(billingTarget)
  const orgBalance = useQuery({
    queryKey: ['billing-organization-balance', target.id],
    queryFn: () => getBillingOrganizationBalance(target.id),
    enabled: target.kind === 'organization',
    retry: false,
  })
  const orgLedger = useQuery({
    queryKey: ['billing-organization-ledger', target.id],
    queryFn: () => getBillingOrganizationLedger(target.id, 20, 0),
    enabled: target.kind === 'organization',
    retry: false,
  })

  const activeBalance = target.kind === 'organization' ? orgBalance.data ?? null : balance
  const activeLedgerEntries = target.kind === 'organization' ? orgLedger.data?.entries ?? [] : ledgerEntries
  const activeLedgerTotal = target.kind === 'organization' ? orgLedger.data?.total ?? 0 : ledgerTotal
  const activeCurrency = activeBalance?.currency ?? activeBalance?.billingCurrency ?? billingCurrency
  const targetOrganization = target.kind === 'organization' ? findOrganizationByRelayOrgId(organizations, target.id) : null
  const organizationTargetLabel = target.kind === 'organization'
    ? targetOrganization
      ? formatOrganizationLabel(targetOrganization, target.id)
      : target.id
    : null
  const targetLabel = target.kind === 'organization'
    ? organizationTargetLabel ?? target.id
    : 'Legacy relay user balance'

  const updateModeMut = useMutation({
    mutationFn: () => {
      const creditLimitMicros = moneyInputToMicros(creditLimit)
      if (creditLimitMicros == null || creditLimitMicros.startsWith('-')) {
        throw new Error('Enter a valid non-negative credit limit')
      }
      return updateUser(u.id, {
        billingMode,
        billingCurrency,
        customerTier,
        creditLimitMicros,
        salesOwner: salesOwner.trim() || null,
        riskStatus,
      })
    },
    onSuccess: () => {
      toast.success('Billing settings updated')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['billing-balance', u.id] })
    },
    onError: (e) => toast.error(e.message),
  })

  const ledgerMut = useMutation({
    mutationFn: async (kind: 'topup' | 'manual_adjustment') => {
      const amountMicros = moneyInputToMicros(amount)
      if (!amountMicros) {
        throw new Error('Enter a valid amount with up to 6 decimals')
      }
      const payload = {
        kind,
        amountMicros,
        note: note.trim() || undefined,
      }
      if (target.kind !== 'organization') {
        throw new Error('Select a linked workspace before creating a ledger entry')
      }
      return createBillingOrganizationLedgerEntry(target.id, payload)
    },
    onSuccess: () => {
      toast.success(`Ledger entry created for ${targetLabel}`)
      setAmount('')
      setNote('')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['billing-balance', u.id] })
      qc.invalidateQueries({ queryKey: ['billing-ledger', u.id] })
      qc.invalidateQueries({ queryKey: ['billing-organization-balance', target.id] })
      qc.invalidateQueries({ queryKey: ['billing-organization-ledger', target.id] })
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Billing & Recharge</div>
          <div className="text-xs text-slate-500 mt-1">后台充值与前台 /profile 统一使用工作区余额；个人工作区也是 Better Auth organization 对应的 relay organization。</div>
        </div>
        {activeBalance?.lastLedgerAt ? <div className="text-xs text-slate-500">Last change {timeAgo(activeBalance.lastLedgerAt)}</div> : null}
      </div>

      <div className="rounded-lg border border-slate-700/70 bg-bg-card-raised p-3 text-xs text-slate-400">
        Legacy relay user balance（只读）：{fmtMoneyMicros(balance?.balanceMicros ?? '0', balance?.billingCurrency ?? balance?.currency ?? billingCurrency)}。前台个人/组织工作区不读取这套余额；请在下方选择工作区充值。
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
        <label className="space-y-1 block">
          <span className="text-xs text-amber-200">Recharge Workspace</span>
          <select
            value={billingTarget}
            onChange={(e) => setBillingTarget(e.target.value)}
            className="w-full bg-bg-input border border-amber-500/30 rounded-lg px-3 py-1.5 text-sm text-slate-200"
          >
            {workspaceTargets.length === 0 ? <option value={`user:${u.id}`}>No linked workspace</option> : null}
            {workspaceTargets.map(({ relayOrgId, organization }) => (
              <option key={relayOrgId} value={`org:${relayOrgId}`}>
                Workspace balance · {formatOrganizationLabel(organization, relayOrgId)}
              </option>
            ))}
          </select>
        </label>
        <div className="text-xs text-amber-100/80">
          当前选择：工作区余额。用户在前台切到同一个个人/组织工作区时，会看到同一笔余额。
        </div>
        {workspaceTargets.length === 0 ? (
          <div className="text-xs text-red-300">This Better Auth user has no linked relay workspace; create/sync the workspace before recharge.</div>
        ) : null}
        {target.kind === 'organization' && orgBalance.error ? (
          <div className="text-xs text-red-300">Organization balance failed: {(orgBalance.error as Error).message}</div>
        ) : null}
      </div>

      <div className="grid grid-cols-4 gap-3 max-xl:grid-cols-2 max-md:grid-cols-1">
        <div className="rounded-lg border border-border-default bg-bg-card-raised p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Current Balance</div>
          <div className={`mt-2 text-lg font-semibold ${(activeBalance?.balanceMicros ?? '0').startsWith('-') ? 'text-red-400' : 'text-slate-100'}`}>
            {fmtMoneyMicros(activeBalance?.balanceMicros ?? '0', activeCurrency)}
          </div>
        </div>
        <div className="rounded-lg border border-border-default bg-bg-card-raised p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Credited</div>
          <div className="mt-2 text-lg font-semibold text-slate-100">
            {fmtMoneyMicros(activeBalance?.totalCreditedMicros ?? '0', activeCurrency)}
          </div>
        </div>
        <div className="rounded-lg border border-border-default bg-bg-card-raised p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Debited</div>
          <div className="mt-2 text-lg font-semibold text-slate-100">
            {fmtMoneyMicros(activeBalance?.totalDebitedMicros ?? '0', activeCurrency)}
          </div>
        </div>
        <div className="rounded-lg border border-border-default bg-bg-card-raised p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Mode</div>
          <div className="mt-2 flex items-center gap-2">
            <Badge tone={(activeBalance?.billingMode ?? billingMode) === 'prepaid' ? 'yellow' : 'gray'}>
              {activeBalance?.billingMode ?? billingMode}
            </Badge>
            <Badge tone="gray">{activeCurrency}</Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1.1fr_0.9fr] gap-4 max-lg:grid-cols-1">
        <div className="rounded-lg border border-border-default bg-bg-card-raised p-4 space-y-3">
          <div className="text-sm font-medium text-slate-100">Billing Controls</div>
          <div className="text-xs text-slate-500">New users stay `standard + prepaid`; only admins should manually switch approved business/enterprise users to `postpaid`. 欠款额度=允许余额透支到负数的上限；正余额充值不需要额度。</div>
          <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
            <label className="space-y-1">
              <span className="text-xs text-slate-400">客户等级</span>
              <select value={customerTier} onChange={(e) => setCustomerTier(e.target.value)} className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
                {customerTiers.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">计费模式</span>
              <select value={billingMode} onChange={(e) => setBillingMode(e.target.value as 'postpaid' | 'prepaid')} className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
                <option value="postpaid">postpaid</option>
                <option value="prepaid">prepaid</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">币种</span>
              <select value={billingCurrency} onChange={(e) => setBillingCurrency(e.target.value as BillingCurrency)} className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
                {billingCurrencies.map((currency) => (
                  <option key={currency} value={currency}>{currency === 'CNY' ? 'RMB (CNY)' : 'USD'}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">欠款额度 / Credit Limit（{billingCurrency}）</span>
              <input value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} placeholder="0 = 不允许欠款" className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">风控状态</span>
              <select value={riskStatus} onChange={(e) => setRiskStatus(e.target.value)} className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
                {riskStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">客户负责人</span>
              <input value={salesOwner} onChange={(e) => setSalesOwner(e.target.value)} placeholder="Sales owner" className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
            </label>
          </div>
          <div className="flex gap-2 items-center">
            <button onClick={() => updateModeMut.mutate()} disabled={updateModeMut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50">
              Save
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-border-default bg-bg-card-raised p-4 space-y-3">
          <div className="text-sm font-medium text-slate-100">Recharge / Adjustment</div>
          <div className="text-xs text-slate-500">Enter a currency amount for {targetLabel}, for example `10`, `5.25`, or `-2`.</div>
          <label className="space-y-1 block">
            <span className="text-xs text-slate-400">Amount ({activeCurrency})</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10.00"
              className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200"
            />
          </label>
          <label className="space-y-1 block">
            <span className="text-xs text-slate-400">Note</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="manual top-up / correction"
              className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200"
            />
          </label>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => ledgerMut.mutate('topup')}
              disabled={ledgerMut.isPending || target.kind !== 'organization'}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
            >
              Top Up Workspace
            </button>
            <button
              onClick={() => ledgerMut.mutate('manual_adjustment')}
              disabled={ledgerMut.isPending || target.kind !== 'organization'}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50"
            >
              Apply Adjustment
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-slate-100">Recent Ledger · {targetLabel}</div>
          <div className="text-xs text-slate-500">{activeLedgerTotal} entries</div>
        </div>
        {activeLedgerEntries.length === 0 ? (
          <div className="text-sm text-slate-500">No ledger entries yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 uppercase tracking-wider border-b border-border-default">
                  <th className="text-left py-1.5 px-2">Time</th>
                  <th className="text-center py-1.5 px-2">Kind</th>
                  <th className="text-right py-1.5 px-2">Amount</th>
                  <th className="text-left py-1.5 px-2">Note</th>
                  <th className="text-right py-1.5 px-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {activeLedgerEntries.map((entry) => (
                  <tr key={entry.id} className="border-b border-border-default/30 hover:bg-bg-card-raised/30">
                    <td className="py-1.5 px-2 text-slate-500 whitespace-nowrap">{timeAgo(entry.createdAt)}</td>
                    <td className="py-1.5 px-2 text-center">
                      <Badge tone={getUserDetailLedgerKindTone(entry.kind)}>{getUserDetailLedgerKindLabel(entry.kind)}</Badge>
                    </td>
                    <td className={`py-1.5 px-2 text-right ${entry.amountMicros.startsWith('-') ? 'text-red-400' : 'text-green-400'}`}>
                      {fmtMoneyMicros(entry.amountMicros, activeCurrency)}
                    </td>
                    <td className="py-1.5 px-2 text-slate-300">{entry.note || '—'}</td>
                    <td className="py-1.5 px-2 text-right">
                      {entry.requestId ? (
                        <Link
                          to={buildRequestDetailHref(u.id, entry.requestId, {
                            usageRecordId: entry.usageRecordId,
                            returnState: requestDetailReturnState,
                          })}
                          className="text-indigo-400 hover:underline"
                        >
                          View
                        </Link>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

type BillingTarget = { kind: 'user'; id: string } | { kind: 'organization'; id: string }

function parseBillingTarget(value: string): BillingTarget {
  if (value.startsWith('org:')) {
    const id = value.slice(4).trim()
    if (!id) throw new Error('Billing organization target is empty')
    return { kind: 'organization', id }
  }
  if (value.startsWith('user:')) {
    const id = value.slice(5).trim()
    if (!id) throw new Error('Billing user target is empty')
    return { kind: 'user', id }
  }
  throw new Error(`Unknown billing target: ${value}`)
}


function InventoryFilters({
  devices,
  currentDevice,
  currentRelayKeySource,
  userId,
}: {
  devices: string[]
  currentDevice: string
  currentRelayKeySource: RelayKeySource | null
  userId: string
}) {
  const navigate = useNavigate()

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500">Request inventory filters</span>
          {currentRelayKeySource ? <Badge tone={getUserDetailRelayKeySourceTone(currentRelayKeySource)}>{getUserDetailRelayKeySourceLabel(currentRelayKeySource)}</Badge> : null}
          {currentDevice ? <Badge tone="blue">{truncateMiddle(currentDevice, 18)}</Badge> : null}
        </div>
        {(currentDevice || currentRelayKeySource) ? (
          <button
            onClick={() => navigate(buildUserDetailHref(userId, {}))}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <label className="space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Client Device</span>
          <select
            value={currentDevice}
            onChange={(event) => navigate(buildUserDetailHref(userId, {
              device: event.target.value || null,
              relayKeySource: currentRelayKeySource,
            }))}
            className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200"
          >
            <option value="">All devices</option>
            {devices.map((device) => (
              <option key={device} value={device}>
                {device}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">API Key Source</span>
          <select
            value={currentRelayKeySource ?? ''}
            onChange={(event) => navigate(buildUserDetailHref(userId, {
              device: currentDevice || null,
              relayKeySource: normalizeUserDetailRelayKeySource(event.target.value || null),
            }))}
            className="w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200"
          >
            <option value="">All key sources</option>
            {userDetailRelayKeySourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}

function SessionsSection({
  sessions,
  userId,
  relayKeySourceFilter,
  requestDetailReturnState,
  restoredSessionKey,
  restoredSessionRequestId,
}: {
  sessions: { sessionKey: string; clientDeviceId?: string | null; accountId?: string | null; firstSeenAt: string; lastActiveAt: string; requestCount: number }[]
  userId: string
  relayKeySourceFilter: RelayKeySource | null
  requestDetailReturnState: UserDetailReturnState
  restoredSessionKey: string | null
  restoredSessionRequestId: string | null
}) {
  const restoredExpandedSessionKey = useMemo(
    () => resolveExpandedSessionKey(restoredSessionKey, sessions),
    [restoredSessionKey, sessions],
  )
  const [expanded, setExpanded] = useState<string | null>(restoredExpandedSessionKey)

  useEffect(() => {
    if (!restoredSessionKey) {
      return
    }
    setExpanded(restoredExpandedSessionKey)
  }, [restoredExpandedSessionKey, restoredSessionKey])

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Sessions ({sessions.length})</div>
        {relayKeySourceFilter ? <Badge tone={getUserDetailRelayKeySourceTone(relayKeySourceFilter)}>{getUserDetailRelayKeySourceLabel(relayKeySourceFilter)}</Badge> : null}
      </div>
      {sessions.length === 0 ? (
        <div className="text-sm text-slate-500">No sessions.</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.sessionKey}
              id={buildSessionAnchorId(s.sessionKey)}
              className="bg-bg-card-raised rounded-lg text-xs"
            >
              <button
                onClick={() => setExpanded(expanded === s.sessionKey ? null : s.sessionKey)}
                className="w-full p-3 text-left hover:bg-bg-card-raised/80 rounded-lg transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-slate-300">{truncateMiddle(s.sessionKey, 28)}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500">{timeAgo(s.lastActiveAt)}</span>
                    <span className="text-slate-500">{expanded === s.sessionKey ? '\u25B2' : '\u25BC'}</span>
                  </div>
                </div>
                <div className="flex gap-3 text-slate-400">
                  {s.clientDeviceId && <span>Device: <Badge tone="blue">{truncateMiddle(s.clientDeviceId, 12)}</Badge></span>}
                  {s.accountId && (
                    <span>Account: <Link to={`/accounts/${encodeURIComponent(s.accountId)}`} className="text-indigo-400 hover:underline" onClick={(e) => e.stopPropagation()}>{truncateMiddle(s.accountId, 12)}</Link></span>
                  )}
                  <span>{fmtNum(s.requestCount)} requests</span>
                </div>
              </button>
              {expanded === s.sessionKey && (
                <SessionRequestsPanel
                  userId={userId}
                  sessionKey={s.sessionKey}
                  relayKeySourceFilter={relayKeySourceFilter}
                  requestDetailReturnState={requestDetailReturnState}
                  restoredSessionRequestId={restoredExpandedSessionKey === s.sessionKey ? restoredSessionRequestId : null}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SessionRequestsPanel({
  userId,
  sessionKey,
  relayKeySourceFilter,
  requestDetailReturnState,
  restoredSessionRequestId,
}: {
  userId: string
  sessionKey: string
  relayKeySourceFilter: RelayKeySource | null
  requestDetailReturnState: UserDetailReturnState
  restoredSessionRequestId: string | null
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['session-requests', userId, sessionKey, relayKeySourceFilter],
    queryFn: () => getSessionRequests(userId, sessionKey, 100, 0, relayKeySourceFilter),
  })

  if (isLoading) return <div className="px-3 pb-3 text-xs text-slate-500">Loading requests...</div>
  if (error) return <div className="px-3 pb-3 text-xs text-red-400">Failed to load: {(error as Error).message}</div>

  const reqs = data?.requests ?? []
  const restoredVisibleRequestId = useMemo(
    () => resolveRestoredSessionRequestId(restoredSessionRequestId, reqs),
    [restoredSessionRequestId, reqs],
  )
  const [highlightedRequestId, setHighlightedRequestId] = useState<string | null>(restoredVisibleRequestId)

  useEffect(() => {
    if (!restoredVisibleRequestId) {
      return
    }
    const target = document.getElementById(buildSessionRequestAnchorId(sessionKey, restoredVisibleRequestId))
    if (!target) {
      return
    }
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center' })
    })
  }, [restoredVisibleRequestId, sessionKey])

  useEffect(() => {
    if (!restoredVisibleRequestId) {
      return
    }
    setHighlightedRequestId(restoredVisibleRequestId)
    const timeoutId = window.setTimeout(() => {
      setHighlightedRequestId((current) => (current === restoredVisibleRequestId ? null : current))
    }, RESTORED_SESSION_REQUEST_HIGHLIGHT_MS)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [restoredVisibleRequestId])

  if (reqs.length === 0) return <div className="px-3 pb-3 text-xs text-slate-500">No requests in this session.</div>

  return (
    <div className="px-3 pb-3 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500 uppercase tracking-wider border-b border-border-default">
            <th className="text-left py-1 px-2">Time</th>
            <th className="text-left py-1 px-2">Model</th>
            <th className="text-right py-1 px-2">Input</th>
            <th className="text-right py-1 px-2">Output</th>
            <th className="text-center py-1 px-2">Status</th>
            <th className="text-center py-1 px-2">Key Source</th>
            <th className="text-right py-1 px-2">Detail</th>
          </tr>
        </thead>
          <tbody>
            {reqs.map((r) => {
              const isRestored = isRestoredSessionRequestHighlighted(r.requestId, highlightedRequestId)
              return (
                <tr
                  key={r.usageRecordId ?? r.requestId}
                  id={buildSessionRequestAnchorId(sessionKey, r.requestId)}
                  className={cn(
                    'border-b border-border-default/30 transition-colors duration-700 hover:bg-bg-card/30',
                    isRestored && 'bg-amber-500/10 animate-pulse',
                  )}
                >
                  <td className="py-1 px-2 text-slate-500 whitespace-nowrap">{timeAgo(r.createdAt)}</td>
                  <td className="py-1 px-2 text-slate-300">{r.model ?? '\u2014'}</td>
                  <td className="py-1 px-2 text-right text-slate-300">{fmtTokens(r.inputTokens)}</td>
                  <td className="py-1 px-2 text-right text-slate-300">{fmtTokens(r.outputTokens)}</td>
                  <td className="py-1 px-2 text-center">
                    <Badge tone={r.statusCode != null && r.statusCode < 400 ? 'green' : r.statusCode != null && r.statusCode >= 400 ? 'red' : 'gray'}>{r.statusCode != null ? String(r.statusCode) : '\u2014'}</Badge>
                  </td>
                  <td className="py-1 px-2 text-center">
                    <Badge tone={getUserDetailRelayKeySourceTone(r.relayKeySource)}>{getUserDetailRelayKeySourceLabel(r.relayKeySource)}</Badge>
                  </td>
                  <td className="py-1 px-2 text-right whitespace-nowrap">
                    {isRestored ? <span className="inline-block align-middle mr-2"><Badge tone="yellow">Restored</Badge></span> : null}
                    <Link
                      to={buildRequestDetailHref(userId, r.requestId, {
                        usageRecordId: r.usageRecordId,
                        returnState: {
                          ...requestDetailReturnState,
                          sessionKey,
                        },
                      })}
                      className="text-indigo-400 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              )
            })}
        </tbody>
      </table>
    </div>
  )
}

function RequestsSection({
  requests,
  total,
  userId,
  relayKeySourceFilter,
  requestDetailReturnState,
}: {
  requests: { usageRecordId?: number; requestId: string; createdAt: string; model?: string; inputTokens: number; outputTokens: number; statusCode?: number; clientDeviceId?: string | null; relayKeySource?: RelayKeySource | null }[]
  total: number
  userId: string
  relayKeySourceFilter: RelayKeySource | null
  requestDetailReturnState: UserDetailReturnState
}) {
  return (
    <section id="requests" className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Recent Requests ({fmtNum(total)})</div>
        {relayKeySourceFilter ? <Badge tone={getUserDetailRelayKeySourceTone(relayKeySourceFilter)}>{getUserDetailRelayKeySourceLabel(relayKeySourceFilter)}</Badge> : null}
      </div>
      {requests.length === 0 ? (
        <div className="text-sm text-slate-500">No requests.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 uppercase tracking-wider border-b border-border-default">
                <th className="text-left py-1.5 px-2">Time</th>
                <th className="text-left py-1.5 px-2">Model</th>
                <th className="text-right py-1.5 px-2">Input</th>
                <th className="text-right py-1.5 px-2">Output</th>
                <th className="text-center py-1.5 px-2">Status</th>
                <th className="text-center py-1.5 px-2">Key Source</th>
                <th className="text-right py-1.5 px-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.usageRecordId ?? r.requestId} className="border-b border-border-default/30 hover:bg-bg-card-raised/30">
                  <td className="py-1.5 px-2 text-slate-500 whitespace-nowrap">{timeAgo(r.createdAt)}</td>
                  <td className="py-1.5 px-2 text-slate-300">{r.model ?? '—'}</td>
                  <td className="py-1.5 px-2 text-right text-slate-300">{fmtTokens(r.inputTokens)}</td>
                  <td className="py-1.5 px-2 text-right text-slate-300">{fmtTokens(r.outputTokens)}</td>
                  <td className="py-1.5 px-2 text-center">
                    <Badge tone={r.statusCode != null && r.statusCode < 400 ? 'green' : r.statusCode != null && r.statusCode >= 400 ? 'red' : 'gray'}>{r.statusCode != null ? String(r.statusCode) : '—'}</Badge>
                  </td>
                  <td className="py-1.5 px-2 text-center">
                    <Badge tone={getUserDetailRelayKeySourceTone(r.relayKeySource)}>{getUserDetailRelayKeySourceLabel(r.relayKeySource)}</Badge>
                  </td>
                  <td className="py-1.5 px-2 text-right">
                    <Link
                      to={buildRequestDetailHref(userId, r.requestId, {
                        usageRecordId: r.usageRecordId,
                        returnState: requestDetailReturnState,
                      })}
                      className="text-indigo-400 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DangerZone({ user: u }: { user: { id: string; name: string; isActive: boolean } }) {
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const toggleMut = useMutation({
    mutationFn: () => updateUser(u.id, { isActive: !u.isActive }),
    onSuccess: () => {
      toast.success(u.isActive ? 'User disabled' : 'User enabled')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const delMut = useMutation({
    mutationFn: () => deleteUser(u.id),
    onSuccess: () => {
      toast.success('User deleted')
      qc.invalidateQueries({ queryKey: ['users'] })
      navigate('/users')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-red-500/20 rounded-xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-3">Danger Zone</div>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => toggleMut.mutate()}
          disabled={toggleMut.isPending}
          className="px-3 py-1.5 rounded-lg text-sm bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20"
        >
          {u.isActive ? 'Disable User' : 'Enable User'}
        </button>
        <button
          onClick={() => { if (confirm(`Delete user "${u.name}"? This cannot be undone.`)) delMut.mutate() }}
          disabled={delMut.isPending}
          className="px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
        >
          Delete User
        </button>
      </div>
    </section>
  )
}
