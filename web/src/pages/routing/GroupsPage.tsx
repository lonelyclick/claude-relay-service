import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listRoutingGroups, createRoutingGroup, updateRoutingGroup, getSchedulerStats } from '~/api/routing'
import { listAccounts, updateAccountSettings } from '~/api/accounts'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import type { RoutingGroup, Account, SchedulerStats } from '~/api/types'

export function GroupsPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const groups = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const stats = useQuery({ queryKey: ['scheduler-stats'], queryFn: getSchedulerStats, staleTime: 15_000 })

  if (groups.isLoading) return <PageSkeleton />

  const groupList = groups.data?.routingGroups ?? []
  const accountList = accounts.data?.accounts ?? []
  const groupStats = stats.data?.groups ?? {}
  const accountStats = stats.data?.accounts ?? []

  return (
    <div className="space-y-5">
      <CreateForm toast={toast} qc={qc} />
      <GroupTable groups={groupList} accounts={accountList} groupStats={groupStats} />
      <AccountCapacityTable accounts={accountStats} toast={toast} qc={qc} />
    </div>
  )
}

function CreateForm({ toast, qc }: { toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [creating, setCreating] = useState(false)

  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500"
      >
        Create Routing Group
      </button>
      {creating ? (
        <GroupDialog
          mode="create"
          onClose={() => setCreating(false)}
          toast={toast}
          qc={qc}
        />
      ) : null}
    </div>
  )
}

function groupTypeLabel(type: RoutingGroup['type']): string {
  if (type === 'anthropic') return 'Anthropic'
  if (type === 'openai') return 'Openai'
  return 'Google'
}

function GroupTable({ groups, accounts, groupStats }: {
  groups: RoutingGroup[]
  accounts: Account[]
  groupStats: Record<string, { totalActiveSessions?: number; totalCapacity?: number }>
}) {
  if (groups.length === 0) {
    return <div className="text-center text-slate-500 py-8">No routing groups yet.</div>
  }

  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
            <th className="text-left py-2 px-3">ID</th>
            <th className="text-left py-2 px-3">Type</th>
            <th className="text-left py-2 px-3">Description</th>
            <th className="text-left py-2 px-3">中文描述</th>
            <th className="text-center py-2 px-3">Status</th>
            <th className="text-center py-2 px-3">Accounts</th>
            <th className="text-center py-2 px-3">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRow key={g.id} group={g} accounts={accounts} stats={groupStats[g.id]} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GroupRow({ group: g, accounts, stats }: {
  group: RoutingGroup
  accounts: Account[]
  stats?: { totalActiveSessions?: number; totalCapacity?: number }
}) {
  const linkedAccounts = accounts.filter((a) => a.routingGroupId === g.id).length

  return (
    <tr className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
      <td className="py-2 px-3 font-mono text-xs"><Link to={`/routing/groups/${encodeURIComponent(g.id)}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 -ml-2 text-indigo-300 bg-accent-muted border border-blue-500/20 hover:bg-accent-muted hover:text-indigo-200">{g.id}<span className="text-[10px] opacity-80">↗</span></Link></td>
      <td className="py-2 px-3"><Badge tone={g.type === 'anthropic' ? 'blue' : g.type === 'openai' ? 'green' : 'cyan'}>{groupTypeLabel(g.type)}</Badge></td>
      <td className="py-2 px-3 text-slate-300">{g.description || '—'}</td>
      <td className="py-2 px-3 text-slate-300">{g.descriptionZh || '—'}</td>
      <td className="py-2 px-3 text-center"><Badge tone={g.isActive ? 'green' : 'red'}>{g.isActive ? 'Active' : 'Disabled'}</Badge></td>
      <td className="py-2 px-3 text-center text-slate-300">{linkedAccounts}</td>
      <td className="py-2 px-3 text-center text-slate-300">
        {stats ? `${stats.totalActiveSessions ?? 0} / ${stats.totalCapacity ?? 0}` : '—'}
      </td>
    </tr>
  )
}

function GroupDialog({ mode, group: g, onClose, toast, qc }: {
  mode: 'create' | 'edit'
  group?: RoutingGroup
  onClose: () => void
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
}) {
  const [id, setId] = useState(g?.id ?? '')
  const [type, setType] = useState<RoutingGroup['type']>(g?.type ?? 'anthropic')
  const [desc, setDesc] = useState(g?.description ?? '')
  const [descZh, setDescZh] = useState(g?.descriptionZh ?? '')
  const [active, setActive] = useState(g?.isActive ?? true)

  useEffect(() => {
    setId(g?.id ?? '')
    setType(g?.type ?? 'anthropic')
    setDesc(g?.description ?? '')
    setDescZh(g?.descriptionZh ?? '')
    setActive(g?.isActive ?? true)
  }, [g?.id, g?.type, g?.description, g?.descriptionZh, g?.isActive])

  const normalizedId = id.trim()
  const isEdit = mode === 'edit' && g != null
  const dirty = !isEdit || normalizedId !== g.id || type !== g.type || desc !== (g.description ?? '') || descZh !== (g.descriptionZh ?? '') || active !== g.isActive

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        id: normalizedId,
        name: normalizedId,
        type,
        description: desc || undefined,
        descriptionZh: descZh || undefined,
        isActive: active,
      }
      return isEdit ? updateRoutingGroup(g.id, payload) : createRoutingGroup(payload)
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Group updated' : 'Group created')
      qc.invalidateQueries({ queryKey: ['routing-groups'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['scheduler-stats'] })
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })

  const title = isEdit ? 'Edit Routing Group' : 'Create Routing Group'
  const titleId = isEdit ? 'edit-routing-group-title' : 'create-routing-group-title'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="w-full max-w-2xl rounded-xl border border-border-default bg-bg-card p-5 shadow-modal">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-slate-100">{title}</h2>
            {isEdit ? <div className="mt-1 text-xs text-slate-500 font-mono">{g.id}</div> : null}
          </div>
          <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">Close</button>
        </div>
        <form
          className="mt-4 grid grid-cols-2 gap-3 max-md:grid-cols-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (dirty && normalizedId) saveMut.mutate()
          }}
        >
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Group ID*</span>
            <input value={id} onChange={(e) => setId(e.target.value)} required className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Type*</span>
            <select value={type} onChange={(e) => setType(e.target.value as RoutingGroup['type'])} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
              <option value="anthropic">Anthropic</option>
              <option value="openai">Openai</option>
              <option value="google">Google</option>
            </select>
          </label>
          <label className="flex items-end gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="mb-2 accent-indigo-500" />
            <span className="pb-1.5">Active</span>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Description</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">中文描述</span>
            <input value={descZh} onChange={(e) => setDescZh(e.target.value)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
          </label>
          <div className="col-span-2 flex justify-end gap-2 pt-2 max-md:col-span-1">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-border-default text-slate-300 hover:text-slate-100 hover:border-slate-500">
              Cancel
            </button>
            <button type="submit" disabled={!dirty || !normalizedId || saveMut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50">
              {isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

type SchedulerAccount = SchedulerStats['accounts'][number]

function AccountCapacityTable({ accounts, toast, qc }: {
  accounts: SchedulerAccount[]
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
}) {
  if (accounts.length === 0) {
    return (
      <div className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs text-sm text-slate-500">
        No scheduler accounts yet.
      </div>
    )
  }

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Account Capacity</div>
          <div className="text-xs text-slate-500 mt-1">Edit maxSessions directly from Scheduler. OpenAI Codex treats it as a soft cap while quota remains.</div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
              <th className="text-left py-2 px-3">Account</th>
              <th className="text-left py-2 px-3">Group</th>
              <th className="text-center py-2 px-3">Status</th>
              <th className="text-center py-2 px-3">Selectable</th>
              <th className="text-center py-2 px-3">Sessions</th>
              <th className="text-left py-2 px-3">Max Sessions</th>
              <th className="text-left py-2 px-3">Blocked</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <AccountCapacityRow key={account.accountId} account={account} toast={toast} qc={qc} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AccountCapacityRow({ account, toast, qc }: {
  account: SchedulerAccount
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
}) {
  const [maxSessionsInput, setMaxSessionsInput] = useState(String(account.maxSessions))

  useEffect(() => {
    setMaxSessionsInput(String(account.maxSessions))
  }, [account.accountId, account.maxSessions])

  const normalized = maxSessionsInput.trim()
  const parsed = normalized ? Number(normalized) : null
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1)
  const changed = normalized !== String(account.maxSessions)

  const mut = useMutation({
    mutationFn: () => updateAccountSettings(account.accountId, { maxSessions: parsed }),
    onSuccess: () => {
      toast.success('Max sessions updated')
      qc.invalidateQueries({ queryKey: ['scheduler-stats'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <tr className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
      <td className="py-2 px-3">
        <div className="text-slate-200">{account.label || account.emailAddress || account.accountId}</div>
        <div className="text-[11px] text-slate-500 font-mono">{account.accountId}</div>
        {account.provider === 'openai-codex' && <div className="text-[11px] text-green-400">OpenAI soft cap</div>}
      </td>
      <td className="py-2 px-3 text-slate-300">{account.group ?? '—'}</td>
      <td className="py-2 px-3 text-center"><Badge tone={account.status === 'active' ? 'green' : 'yellow'}>{account.schedulerState ?? account.status}</Badge></td>
      <td className="py-2 px-3 text-center"><Badge tone={account.isSelectable ? 'green' : 'red'}>{account.isSelectable ? 'Yes' : 'No'}</Badge></td>
      <td className="py-2 px-3 text-center text-slate-300">{account.activeSessions} / {account.maxSessions}</td>
      <td className="py-2 px-3">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={maxSessionsInput}
            onChange={(event) => setMaxSessionsInput(event.target.value)}
            className="bg-bg-input border border-border-default rounded-lg px-2 py-1 text-xs text-slate-200 w-24"
          />
          <button
            onClick={() => mut.mutate()}
            disabled={!valid || !changed || mut.isPending}
            className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
          >
            Save
          </button>
        </div>
        {!valid && <div className="mt-1 text-[11px] text-red-400">Use a positive integer.</div>}
      </td>
      <td className="py-2 px-3 text-xs text-slate-400">{account.blockedReason ?? '—'}</td>
    </tr>
  )
}
