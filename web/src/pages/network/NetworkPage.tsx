import { useState, useMemo } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { addProxy, importProxies, listProxies } from '~/api/proxies'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { Badge, type BadgeTone } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import { fmtNum, truncateMiddle } from '~/lib/format'
import type { Proxy } from '~/api/types'

export function NetworkPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [bulkText, setBulkText] = useState('')

  const proxyList = proxies.data?.proxies ?? []

  const filtered = useMemo(() => {
    if (!search) return proxyList
    const q = search.toLowerCase()
    return proxyList.filter((p) =>
      [p.label, p.url, p.localUrl, ...(p.accounts?.map((a) => a.emailAddress) ?? [])]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    )
  }, [proxyList, search])

  const localReady = proxyList.filter((p) => p.localUrl).length
  const linkedAccounts = proxyList.reduce((sum, p) => sum + (p.accounts?.length ?? 0), 0)
  const managedCount = proxyList.filter((p) => p.kind === 'vless-upstream' && p.enabled !== false).length

  const createVlessProxy = async () => {
    const label = newLabel.trim()
    const url = newUrl.trim()
    if (!label || !url) {
      toast.error('Label and VLESS URL are required')
      return
    }
    try {
      await addProxy({
        label,
        url,
        kind: 'vless-upstream',
        enabled: true,
        inboundProtocol: 'http',
      })
      setNewLabel('')
      setNewUrl('')
      setShowAdd(false)
      toast.success('VLESS upstream added')
      qc.invalidateQueries({ queryKey: ['proxies'] })
    } catch (e) {
      toast.error(`Add proxy failed: ${(e as Error).message}`)
    }
  }

  const importVlessProxies = async () => {
    if (!bulkText.trim()) {
      toast.error('Paste at least one vless:// URL')
      return
    }
    try {
      const result = await importProxies({ text: bulkText })
      setBulkText('')
      toast.success(`Imported ${result.proxies.length} upstreams${result.errors.length ? `, ${result.errors.length} failed` : ''}`)
      qc.invalidateQueries({ queryKey: ['proxies'] })
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`)
    }
  }

  if (proxies.isLoading) return <PageSkeleton />

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <StatCard value={fmtNum(proxyList.length)} label="Total Exits" />
        <StatCard value={fmtNum(managedCount)} label="Managed VLESS" />
        <StatCard value={fmtNum(localReady)} label="Local Ready" />
        <StatCard value={fmtNum(linkedAccounts)} label="Linked Accounts" />
      </div>

      <div className="flex gap-2 items-center">
        <input
          type="text"
          placeholder="Search proxies..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 w-64 focus:outline-none focus:border-accent"
        />
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['proxies'] })}
          className="text-xs text-indigo-400 hover:text-indigo-300"
        >
          Refresh
        </button>
        <button onClick={() => setShowAdd((v) => !v)} className="text-xs text-slate-300 hover:text-slate-100">
          {showAdd ? 'Hide Add' : 'Add VLESS'}
        </button>
      </div>

      {showAdd && (
        <section className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Add VLESS Upstream</div>
          <div className="grid grid-cols-[220px_1fr_auto] gap-2 max-lg:grid-cols-1">
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="备注名，例如 新加坡家庭2" className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
            <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="vless://..." className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 font-mono" />
            <button onClick={createVlessProxy} className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500">Add</button>
          </div>
          <p className="text-[11px] text-slate-500">端口由后端自动分配；添加后进入详情页点击 Probe，系统会生成本地出口并重启 xray-cor。</p>
          <div className="border-t border-border-default/60 pt-3 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Bulk Import</div>
            <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={4} placeholder={'每行一个 vless://...，或 “备注<TAB>vless://...”'} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-xs text-slate-200 font-mono" />
            <div className="flex gap-2 items-center">
              <button onClick={importVlessProxies} className="px-3 py-1.5 rounded-lg text-sm bg-slate-700 text-slate-100 hover:bg-slate-600">Import</button>
              <span className="text-[11px] text-slate-500">端口自动分配</span>
            </div>
          </div>
        </section>
      )}

      {filtered.length === 0 ? (
        <div className="text-center text-slate-500 py-8">No matching exits.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
          {filtered.map((p) => (
            <ProxyCard key={p.id} proxy={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProxyCard({ proxy: p }: { proxy: Proxy }) {
  const status = p.lastProbeStatus ?? undefined
  const statusTone: BadgeTone = status === 'healthy' ? 'green' : status === 'degraded' ? 'yellow' : status === 'error' ? 'red' : 'gray'
  const statusLabel = status ?? 'Idle'
  const checkedAt = p.lastProbeAt ? new Date(p.lastProbeAt).toLocaleString() : '—'

  return (
    <Link to={`/network/${encodeURIComponent(p.id)}`} className="block bg-bg-card border border-border-default rounded-xl p-4 shadow-xs hover:border-indigo-500/40 hover:bg-white/[0.02] transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-100 truncate">{p.label}</div>
          <div className="text-[10px] text-slate-500">{p.accounts?.length ?? 0} accounts linked · {p.kind ?? 'local-http'}</div>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 mb-3">
        <div>Local: <span className="text-slate-300">{p.localUrl ? 'Ready' : 'Missing'}</span></div>
        <div>Port: <span className="text-slate-300">{p.inboundPort ?? 'Auto'}</span></div>
        <div>IP: <span className="text-slate-300">{p.egressIp ?? '—'}</span></div>
        <div>Checked: <span className="text-slate-300">{checkedAt}</span></div>
      </div>

      <div className="text-[10px] text-slate-500 space-y-0.5">
        <div>Remote: <span className="text-slate-400 font-mono">{truncateMiddle(p.url, 60)}</span></div>
        <div>Local: <span className="text-slate-400 font-mono">{p.localUrl ? truncateMiddle(p.localUrl, 60) : '—'}</span></div>
      </div>

      {p.accounts && p.accounts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {p.accounts.slice(0, 4).map((account) => (
            <span key={account.id} className="rounded-full bg-slate-800/80 px-2 py-0.5 text-[10px] text-slate-400">
              {account.label || account.emailAddress}
            </span>
          ))}
          {p.accounts.length > 4 && <span className="text-[10px] text-slate-500">+{p.accounts.length - 4}</span>}
        </div>
      )}
    </Link>
  )
}
