import { useState, useMemo, useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listProxies, probeProxy } from '~/api/proxies'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { Badge, type BadgeTone } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import { fmtNum, truncateMiddle, timeAgo } from '~/lib/format'
import type { Proxy, ProxyDiagnostics } from '~/api/types'

export function NetworkPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })
  const [search, setSearch] = useState('')
  const [diagnostics, setDiagnostics] = useState<Record<string, ProxyDiagnostics>>({})
  const [probing, setProbing] = useState<Set<string>>(new Set())

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
  const healthyCount = Object.values(diagnostics).filter((d) => d.status === 'healthy').length

  const probe = async (proxyId: string) => {
    setProbing((s) => new Set(s).add(proxyId))
    try {
      const result = await probeProxy(proxyId)
      setDiagnostics((d) => ({ ...d, [proxyId]: result }))
    } catch (e) {
      toast.error(`Probe failed: ${(e as Error).message}`)
    } finally {
      setProbing((s) => { const n = new Set(s); n.delete(proxyId); return n })
    }
  }

  const probeAll = async () => {
    let count = 0
    for (const p of filtered) {
      setProbing((s) => new Set(s).add(p.id))
      try {
        const result = await probeProxy(p.id)
        setDiagnostics((d) => ({ ...d, [p.id]: result }))
        count++
      } catch { /* skip */ }
      setProbing((s) => { const n = new Set(s); n.delete(p.id); return n })
    }
    toast.success(`Probed ${count} nodes`)
  }

  const autoProbed = useRef(false)
  useEffect(() => {
    if (proxyList.length > 0 && !autoProbed.current) {
      autoProbed.current = true
      ;(async () => {
        for (const p of proxyList) {
          try {
            const result = await probeProxy(p.id)
            setDiagnostics((d) => ({ ...d, [p.id]: result }))
          } catch { /* skip */ }
        }
      })()
    }
  }, [proxyList])

  if (proxies.isLoading) return <PageSkeleton />

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <StatCard value={fmtNum(proxyList.length)} label="Total Exits" />
        <StatCard value={fmtNum(localReady)} label="Local Ready" />
        <StatCard value={fmtNum(linkedAccounts)} label="Linked Accounts" />
        <StatCard value={fmtNum(healthyCount)} label="Healthy Probes" />
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
        <button
          onClick={probeAll}
          disabled={probing.size > 0}
          className="text-xs text-indigo-300 hover:text-indigo-300 disabled:opacity-50"
        >
          Probe All ({filtered.length})
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center text-slate-500 py-8">No matching exits.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
          {filtered.map((p) => (
            <ProxyCard key={p.id} proxy={p} diag={diagnostics[p.id]} isProbing={probing.has(p.id)} onProbe={() => probe(p.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProxyCard({ proxy: p, diag, isProbing, onProbe }: {
  proxy: Proxy
  diag?: ProxyDiagnostics
  isProbing: boolean
  onProbe: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const toast = useToast()

  const statusTone: BadgeTone = diag?.status === 'healthy' ? 'green' : diag?.status === 'degraded' ? 'yellow' : diag?.status === 'error' ? 'red' : 'gray'
  const statusLabel = isProbing ? 'Probing...' : diag?.status ?? 'Idle'

  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs">
      <div className="flex items-start justify-between mb-3">
        <div>
          <Link to={`/network/${encodeURIComponent(p.id)}`} className="text-sm font-medium text-slate-100 hover:text-indigo-400">
            {p.label}
          </Link>
          <div className="text-[10px] text-slate-500">{p.accounts?.length ?? 0} accounts linked</div>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 mb-3">
        <div>Local: <span className="text-slate-300">{p.localUrl ? 'Ready' : 'Missing'}</span></div>
        <div>Latency: <span className="text-slate-300">{diag?.latencyMs ? `${diag.latencyMs}ms` : '—'}</span></div>
        <div>IP: <span className="text-slate-300">{diag?.egressIp ?? '—'}{diag?.egressFamily ? ` (${diag.egressFamily})` : ''}</span></div>
        <div>Checked: <span className="text-slate-300">{diag?.checkedAt ? timeAgo(diag.checkedAt) : '—'}</span></div>
      </div>

      <div className="text-[10px] text-slate-500 space-y-0.5 mb-3">
        <div>Remote: <span className="text-slate-400 font-mono">{truncateMiddle(p.url, 60)}</span></div>
        <div>Local: <span className="text-slate-400 font-mono">{p.localUrl ? truncateMiddle(p.localUrl, 60) : '—'}</span></div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => { navigator.clipboard.writeText(p.url); toast.success('Copied remote URL') }} className="text-[10px] text-slate-400 hover:text-slate-200">Copy Remote</button>
        {p.localUrl && (
          <button onClick={() => { navigator.clipboard.writeText(p.localUrl!); toast.success('Copied local URL') }} className="text-[10px] text-slate-400 hover:text-slate-200">Copy Local</button>
        )}
        <button onClick={onProbe} disabled={isProbing} className="text-[10px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
          {isProbing ? 'Probing...' : 'Probe'}
        </button>
        <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-slate-500 hover:text-slate-300 ml-auto">
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border-default/50 space-y-2">
          <div className="text-[10px] text-slate-400 break-all">
            <div>Full Remote: <span className="font-mono text-slate-300">{p.url}</span></div>
            <div>Full Local: <span className="font-mono text-slate-300">{p.localUrl ?? '—'}</span></div>
          </div>
          {p.accounts && p.accounts.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">Linked Accounts:</div>
              <div className="flex flex-wrap gap-1">
                {p.accounts.map((a) => (
                  <Link key={a.id} to={`/accounts/${encodeURIComponent(a.id)}`} className="text-[10px] text-indigo-400 hover:underline">
                    {a.label || a.emailAddress}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {diag && (
            <div className="text-[10px] text-slate-400">
              <div>Status: {diag.status} | Via: {diag.via ?? 'N/A'} | HTTP: {diag.httpStatus ?? '—'}{diag.error ? ` | Error: ${diag.error}` : ''}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
