import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listRoutingGroups, createRoutingGroup, updateRoutingGroup, deleteRoutingGroup, getSchedulerStats } from '~/api/routing'
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
      <GroupTable groups={groupList} accounts={accountList} groupStats={groupStats} toast={toast} qc={qc} />
      <AccountCapacityTable accounts={accountStats} toast={toast} qc={qc} />
    </div>
  )
}

function CreateForm({ toast, qc }: { toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')

  const mut = useMutation({
    mutationFn: () => createRoutingGroup({ id, name: name || id, description: desc || undefined, isActive: true }),
    onSuccess: () => {
      toast.success('Group created')
      qc.invalidateQueries({ queryKey: ['routing-groups'] })
      setId('')
      setName('')
      setDesc('')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Create Routing Group</div>
      <form onSubmit={(e) => { e.preventDefault(); if (id.trim()) mut.mutate() }} className="flex gap-2 flex-wrap items-end">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Group ID*</span>
          <input value={id} onChange={(e) => setId(e.target.value)} required className="block bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 w-40" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="block bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 w-40" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Description</span>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} className="block bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 w-48" />
        </label>
        <button type="submit" disabled={mut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
          Create
        </button>
      </form>
    </div>
  )
}

function GroupTable({ groups, accounts, groupStats, toast, qc }: {
  groups: RoutingGroup[]
  accounts: Account[]
  groupStats: Record<string, { totalActiveSessions?: number; totalCapacity?: number }>
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
}) {
  if (groups.length === 0) {
    return <div className="text-center text-slate-500 py-8">No routing groups yet.</div>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
            <th className="text-left py-2 px-3">ID</th>
            <th className="text-left py-2 px-3">Name</th>
            <th className="text-left py-2 px-3">Description</th>
            <th className="text-center py-2 px-3">Status</th>
            <th className="text-center py-2 px-3">Accounts</th>
            <th className="text-center py-2 px-3">Sessions</th>
            <th className="text-right py-2 px-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRow key={g.id} group={g} accounts={accounts} stats={groupStats[g.id]} toast={toast} qc={qc} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GroupRow({ group: g, accounts, stats, toast, qc }: {
  group: RoutingGroup
  accounts: Account[]
  stats?: { totalActiveSessions?: number; totalCapacity?: number }
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
}) {
  const [name, setName] = useState(g.name)
  const [desc, setDesc] = useState(g.description ?? '')
  const [active, setActive] = useState(g.isActive)

  const linkedAccounts = accounts.filter((a) => a.routingGroupId === g.id).length
  const dirty = name !== g.name || desc !== (g.description ?? '') || active !== g.isActive

  const saveMut = useMutation({
    mutationFn: () => updateRoutingGroup(g.id, { name, description: desc || undefined, isActive: active }),
    onSuccess: () => {
      toast.success('Group updated')
      qc.invalidateQueries({ queryKey: ['routing-groups'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const delMut = useMutation({
    mutationFn: () => deleteRoutingGroup(g.id),
    onSuccess: () => {
      toast.success('Group deleted')
      qc.invalidateQueries({ queryKey: ['routing-groups'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <tr className="border-b border-ccdash-border/50 hover:bg-ccdash-card-strong/30">
      <td className="py-2 px-3 font-mono text-xs text-slate-300">{g.id}</td>
      <td className="py-2 px-3">
        <input value={name} onChange={(e) => setName(e.target.value)} className="bg-transparent border-b border-transparent hover:border-ccdash-border focus:border-blue-500/50 text-slate-200 text-sm outline-none w-28" />
      </td>
      <td className="py-2 px-3">
        <input value={desc} onChange={(e) => setDesc(e.target.value)} className="bg-transparent border-b border-transparent hover:border-ccdash-border focus:border-blue-500/50 text-slate-200 text-sm outline-none w-36" placeholder="—" />
      </td>
      <td className="py-2 px-3 text-center">
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-blue-500" />
          <Badge tone={active ? 'green' : 'red'}>{active ? 'Active' : 'Disabled'}</Badge>
        </label>
      </td>
      <td className="py-2 px-3 text-center text-slate-300">{linkedAccounts}</td>
      <td className="py-2 px-3 text-center text-slate-300">
        {stats ? `${stats.totalActiveSessions ?? 0} / ${stats.totalCapacity ?? 0}` : '—'}
      </td>
      <td className="py-2 px-3 text-right space-x-2">
        <button
          onClick={() => saveMut.mutate()}
          disabled={!dirty || saveMut.isPending}
          className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-30"
        >
          Save
        </button>
        <button
          onClick={() => { if (confirm(`Delete group "${g.id}"?`)) delMut.mutate() }}
          disabled={linkedAccounts > 0 || delMut.isPending}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-30"
          title={linkedAccounts > 0 ? `${linkedAccounts} accounts linked` : 'Delete'}
        >
          Delete
        </button>
      </td>
    </tr>
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
      <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-4 text-sm text-slate-500">
        No scheduler accounts yet.
      </div>
    )
  }

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Account Capacity</div>
          <div className="text-xs text-slate-500 mt-1">Edit maxSessions directly from Scheduler. OpenAI Codex treats it as a soft cap while quota remains.</div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
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
    <tr className="border-b border-ccdash-border/50 hover:bg-ccdash-card-strong/30">
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
            className="bg-ccdash-input border border-ccdash-border rounded-lg px-2 py-1 text-xs text-slate-200 w-24"
          />
          <button
            onClick={() => mut.mutate()}
            disabled={!valid || !changed || mut.isPending}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-30"
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

