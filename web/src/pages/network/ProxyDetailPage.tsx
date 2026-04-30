import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listProxies, probeProxy, updateProxy, deleteProxy } from '~/api/proxies'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge, type BadgeTone } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import { timeAgo } from '~/lib/format'
import type { ProxyDiagnostics } from '~/api/types'

export function ProxyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const proxyId = id ?? ''
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()

  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })
  const proxy = proxies.data?.proxies.find((p) => p.id === id)

  const [diag, setDiag] = useState<ProxyDiagnostics | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [label, setLabel] = useState('')
  const [localUrl, setLocalUrl] = useState('')

  useEffect(() => {
    if (!proxy) {
      return
    }
    setLabel(proxy.label)
    setLocalUrl(proxy.localUrl ?? '')
  }, [proxy])

  const handleProbe = async () => {
    if (!proxyId) {
      toast.error('Proxy id is missing')
      return
    }
    setIsProbing(true)
    try {
      const result = await probeProxy(proxyId)
      setDiag(result)
    } catch (e) {
      toast.error(`Probe failed: ${(e as Error).message}`)
    }
    setIsProbing(false)
  }

  const updateMut = useMutation({
    mutationFn: () => {
      if (!proxyId) {
        throw new Error('Proxy id is missing')
      }
      return updateProxy(proxyId, { label, localUrl: localUrl || null })
    },
    onSuccess: () => {
      toast.success('Proxy updated')
      qc.invalidateQueries({ queryKey: ['proxies'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const deleteMut = useMutation({
    mutationFn: () => {
      if (!proxyId) {
        throw new Error('Proxy id is missing')
      }
      return deleteProxy(proxyId)
    },
    onSuccess: () => {
      toast.success('Proxy deleted')
      qc.invalidateQueries({ queryKey: ['proxies'] })
      navigate('/network')
    },
    onError: (e) => toast.error(e.message),
  })

  const statusTone: BadgeTone = diag?.status === 'healthy' ? 'green' : diag?.status === 'degraded' ? 'yellow' : diag?.status === 'error' ? 'red' : 'gray'

  if (proxies.isLoading) return <PageSkeleton />
  if (!proxy) return <div className="text-red-400 text-sm">Proxy not found</div>

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/network')} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Network</button>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-100">{proxy.label}</h2>
            <div className="text-xs text-slate-500 font-mono">{proxy.id}</div>
          </div>
          {diag && <Badge tone={statusTone}>{diag.status}</Badge>}
        </div>
        <div className="space-y-1 text-xs text-slate-400">
          <div>Remote: <span className="font-mono text-slate-300 break-all">{proxy.url}</span></div>
          <div>Local: <span className="font-mono text-slate-300 break-all">{proxy.localUrl ?? '—'}</span></div>
          {proxy.createdAt && <div>Created: {new Date(proxy.createdAt).toLocaleString()}</div>}
        </div>
      </section>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Diagnostics</div>
        <button onClick={handleProbe} disabled={isProbing} className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 mb-3">
          {isProbing ? 'Probing...' : diag ? 'Re-probe' : 'Run Probe'}
        </button>
        {diag && (
          <div className="grid grid-cols-2 gap-2 text-xs max-md:grid-cols-1">
            <div className="text-slate-400">Status: <span className="text-slate-200">{diag.status}</span></div>
            <div className="text-slate-400">Latency: <span className="text-slate-200">{diag.latencyMs ? `${diag.latencyMs}ms` : '—'}</span></div>
            <div className="text-slate-400">IP: <span className="text-slate-200">{diag.egressIp ?? '—'}{diag.egressFamily ? ` (${diag.egressFamily})` : ''}</span></div>
            <div className="text-slate-400">Via: <span className="text-slate-200">{diag.via ?? 'N/A'}</span></div>
            <div className="text-slate-400">HTTP: <span className="text-slate-200">{diag.httpStatus ?? '—'}</span></div>
            {diag.error && <div className="text-red-400 col-span-2">Error: {diag.error}</div>}
            <div className="text-slate-500">Probed: {timeAgo(diag.checkedAt)}</div>
          </div>
        )}
      </section>

      {proxy.accounts && proxy.accounts.length > 0 && (
        <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Linked Accounts ({proxy.accounts.length})</div>
          <div className="space-y-1">
            {proxy.accounts.map((a) => (
              <Link key={a.id} to={`/accounts/${encodeURIComponent(a.id)}`} className="block text-xs text-indigo-400 hover:underline">
                {a.label || a.emailAddress}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Edit Proxy</div>
        <div className="space-y-3 max-w-md">
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Local URL</span>
            <input value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" placeholder="http://..." />
          </label>
          <button onClick={() => updateMut.mutate()} disabled={updateMut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50">
            Save Changes
          </button>
        </div>
      </section>

      <section className="bg-bg-card border border-red-500/20 rounded-xl p-5">
        <button
          onClick={() => { if (confirm(`Delete proxy "${proxy.label}"?`)) deleteMut.mutate() }}
          disabled={deleteMut.isPending}
          className="px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
        >
          Delete Proxy
        </button>
      </section>
    </div>
  )
}
