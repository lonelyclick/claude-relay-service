import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { listAccounts } from '~/api/accounts'
import { deleteRoutingGroup, getSchedulerStats, listRoutingGroups, updateRoutingGroup } from '~/api/routing'
import type { Account, RoutingGroup } from '~/api/types'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { useToast } from '~/components/Toast'
import { cn } from '~/lib/cn'

function groupTypeLabel(type: RoutingGroup['type']): string {
  if (type === 'anthropic') return 'Anthropic'
  if (type === 'openai') return 'Openai'
  return 'Google'
}

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>()
  const groupId = id ? decodeURIComponent(id) : ''
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const groups = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const stats = useQuery({ queryKey: ['scheduler-stats'], queryFn: getSchedulerStats, staleTime: 15_000 })

  if (groups.isLoading || accounts.isLoading) return <PageSkeleton />
  if (groups.error) return <div className="text-red-400 text-sm">Failed to load group: {(groups.error as Error).message}</div>

  const group = (groups.data?.routingGroups ?? []).find((entry) => entry.id === groupId) ?? null
  if (!group) {
    return (
      <div className="space-y-4">
        <button onClick={() => navigate('/routing')} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Routing Groups</button>
        <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs text-sm text-slate-500">Routing group not found.</div>
      </div>
    )
  }

  const linkedAccounts = (accounts.data?.accounts ?? []).filter((account) => account.routingGroupId === group.id)
  const groupStats = stats.data?.groups?.[group.id]

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/routing')} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Routing Groups</button>
      <GroupHeader group={group} linkedAccounts={linkedAccounts} stats={groupStats} />
      <GroupEditor group={group} linkedAccounts={linkedAccounts} toast={toast} qc={qc} navigate={navigate} />
      <LinkedAccounts accounts={linkedAccounts} />
    </div>
  )
}

function GroupHeader({ group, linkedAccounts, stats }: { group: RoutingGroup; linkedAccounts: Account[]; stats?: { totalActiveSessions?: number; totalCapacity?: number } }) {
  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Routing Group Detail</div>
          <h2 className="mt-1 text-xl font-bold text-slate-100 font-mono">{group.id}</h2>
          <div className="mt-2 text-sm text-slate-400">{group.description || 'No description'}</div>
          <div className="mt-1 text-sm text-slate-500">{group.descriptionZh || '无中文描述'}</div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Badge tone={group.type === 'anthropic' ? 'blue' : group.type === 'openai' ? 'green' : 'cyan'}>{groupTypeLabel(group.type)}</Badge>
          <Badge tone={group.isActive ? 'green' : 'red'}>{group.isActive ? 'Active' : 'Disabled'}</Badge>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 max-md:grid-cols-1 text-sm">
        <div className="bg-bg-card-raised/40 rounded-lg p-3"><div className="text-xs text-slate-500">Accounts</div><div className="text-slate-200 mt-1">{linkedAccounts.length}</div></div>
        <div className="bg-bg-card-raised/40 rounded-lg p-3"><div className="text-xs text-slate-500">Sessions</div><div className="text-slate-200 mt-1">{stats ? `${stats.totalActiveSessions ?? 0} / ${stats.totalCapacity ?? 0}` : '—'}</div></div>
        <div className="bg-bg-card-raised/40 rounded-lg p-3"><div className="text-xs text-slate-500">Group ID</div><div className="text-slate-200 mt-1 font-mono text-xs break-all">{group.id}</div></div>
      </div>
    </section>
  )
}

function GroupEditor({ group, linkedAccounts, toast, qc, navigate }: {
  group: RoutingGroup
  linkedAccounts: Account[]
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
  navigate: ReturnType<typeof useNavigate>
}) {
  const [id, setId] = useState(group.id)
  const [type, setType] = useState<RoutingGroup['type']>(group.type)
  const [desc, setDesc] = useState(group.description ?? '')
  const [descZh, setDescZh] = useState(group.descriptionZh ?? '')
  const [active, setActive] = useState(group.isActive)

  useEffect(() => {
    setId(group.id)
    setType(group.type)
    setDesc(group.description ?? '')
    setDescZh(group.descriptionZh ?? '')
    setActive(group.isActive)
  }, [group.id, group.type, group.description, group.descriptionZh, group.isActive])

  const normalizedId = id.trim()
  const dirty = normalizedId !== group.id || type !== group.type || desc !== (group.description ?? '') || descZh !== (group.descriptionZh ?? '') || active !== group.isActive

  const saveMut = useMutation({
    mutationFn: () => updateRoutingGroup(group.id, {
      id: normalizedId,
      name: normalizedId,
      type,
      description: desc || undefined,
      descriptionZh: descZh || undefined,
      isActive: active,
    }),
    onSuccess: () => {
      toast.success('Group updated')
      qc.invalidateQueries({ queryKey: ['routing-groups'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['scheduler-stats'] })
      if (normalizedId !== group.id) {
        navigate(`/routing/groups/${encodeURIComponent(normalizedId)}`, { replace: true })
      }
    },
    onError: (error) => toast.error(error.message),
  })

  const delMut = useMutation({
    mutationFn: () => deleteRoutingGroup(group.id),
    onSuccess: () => {
      toast.success('Group deleted')
      qc.invalidateQueries({ queryKey: ['routing-groups'] })
      navigate('/routing')
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-4">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Edit Routing Group</div>
        <div className="text-sm text-slate-500 mt-1">Changing the group ID updates account and API key references.</div>
      </div>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Group ID</span>
          <input value={id} onChange={(event) => setId(event.target.value)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Type</span>
          <select value={type} onChange={(event) => setType(event.target.value as RoutingGroup['type'])} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200">
            <option value="anthropic">Anthropic</option>
            <option value="openai">Openai</option>
            <option value="google">Google</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Description</span>
          <input value={desc} onChange={(event) => setDesc(event.target.value)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">中文描述</span>
          <input value={descZh} onChange={(event) => setDescZh(event.target.value)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200" />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
        Group is active
      </label>
      <div className="flex justify-between gap-3 max-sm:flex-col">
        <button
          onClick={() => { if (confirm(`Delete group "${group.id}"?`)) delMut.mutate() }}
          disabled={linkedAccounts.length > 0 || delMut.isPending}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600/20 text-red-300 border border-red-500/30 hover:bg-red-600/30 disabled:opacity-40"
          title={linkedAccounts.length > 0 ? `${linkedAccounts.length} accounts linked` : 'Delete'}
        >
          Delete Group
        </button>
        <button onClick={() => saveMut.mutate()} disabled={!dirty || !normalizedId || saveMut.isPending} className={cn('px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500', (!dirty || !normalizedId || saveMut.isPending) && 'opacity-50')}>
          Save Group
        </button>
      </div>
    </section>
  )
}

function LinkedAccounts({ accounts }: { accounts: Account[] }) {
  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Linked Accounts</div>
        <div className="text-xs text-slate-500">{accounts.length} accounts</div>
      </div>
      {accounts.length === 0 ? (
        <div className="text-sm text-slate-500">No accounts are linked to this group.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-b border-border-default/50">
                  <td className="py-2 pr-3 text-slate-200">{account.label || account.emailAddress || account.id}</td>
                  <td className="py-2 px-3 text-slate-500 font-mono text-xs">{account.id}</td>
                  <td className="py-2 pl-3 text-right"><Badge tone={account.isActive ? 'green' : 'red'}>{account.isActive ? 'Active' : 'Disabled'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
