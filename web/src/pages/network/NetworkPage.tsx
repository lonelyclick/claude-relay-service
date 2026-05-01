import { useState, useMemo, useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAccounts } from '~/api/accounts'
import { addProxy, importProxies, linkAccountsToProxy, listProxies, probeProxy, syncXrayConfig, unlinkAccountFromProxy } from '~/api/proxies'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { Badge, type BadgeTone } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import { fmtNum, truncateMiddle } from '~/lib/format'
import type { Proxy, ProxyDiagnostics, XraySyncResult } from '~/api/types'

export function NetworkPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const [search, setSearch] = useState('')
  const [diagnostics, setDiagnostics] = useState<Record<string, ProxyDiagnostics>>({})
  const [probing, setProbing] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)
  const [preview, setPreview] = useState<XraySyncResult | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newPort, setNewPort] = useState('')
  const [bulkText, setBulkText] = useState('')
  const [bulkPortBase, setBulkPortBase] = useState('')

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

  const previewXray = async () => {
    setSyncing(true)
    try {
      const result = await syncXrayConfig({ dryRun: true })
      setPreview(result)
      toast.success(`Xray preview: ${result.assignments.length} managed exits`)
    } catch (e) {
      toast.error(`Xray preview failed: ${(e as Error).message}`)
    } finally {
      setSyncing(false)
    }
  }

  const syncXray = async () => {
    if (!confirm('Generate COR managed Xray config and update local proxy URLs?')) return
    setSyncing(true)
    try {
      const result = await syncXrayConfig({ validate: true, restart: false })
      setPreview(result)
      if (result.validation && !result.validation.ok) {
        toast.error(`Xray validation failed${result.rolledBack ? ', rolled back' : ''}`)
      } else {
        toast.success(`Generated ${result.assignments.length} Xray exits`)
      }
      qc.invalidateQueries({ queryKey: ['proxies'] })
    } catch (e) {
      toast.error(`Xray sync failed: ${(e as Error).message}`)
    } finally {
      setSyncing(false)
    }
  }

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
        inboundPort: newPort ? Number(newPort) : null,
      })
      setNewLabel('')
      setNewUrl('')
      setNewPort('')
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
      const result = await importProxies({ text: bulkText, portBase: bulkPortBase ? Number(bulkPortBase) : null })
      setBulkText('')
      toast.success(`Imported ${result.proxies.length} upstreams${result.errors.length ? `, ${result.errors.length} failed` : ''}`)
      qc.invalidateQueries({ queryKey: ['proxies'] })
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`)
    }
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
        <button
          onClick={probeAll}
          disabled={probing.size > 0}
          className="text-xs text-indigo-300 hover:text-indigo-300 disabled:opacity-50"
        >
          Probe All ({filtered.length})
        </button>
        <button onClick={previewXray} disabled={syncing} className="text-xs text-cyan-300 hover:text-cyan-200 disabled:opacity-50">
          Preview Xray
        </button>
        <button onClick={syncXray} disabled={syncing} className="text-xs text-emerald-300 hover:text-emerald-200 disabled:opacity-50">
          Generate Xray Config
        </button>
      </div>

      {showAdd && (
        <section className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Add VLESS Upstream</div>
          <div className="grid grid-cols-[220px_1fr_120px_auto] gap-2 max-lg:grid-cols-1">
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="备注名，例如 新加坡家庭2" className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
            <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="vless://..." className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 font-mono" />
            <input value={newPort} onChange={(e) => setNewPort(e.target.value)} placeholder="10880" className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200" />
            <button onClick={createVlessProxy} className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500">Add</button>
          </div>
          <p className="text-[11px] text-slate-500">添加后先 Preview，再 Generate。生成器只监听 127.0.0.1，不暴露公网。</p>
          <div className="border-t border-border-default/60 pt-3 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Bulk Import</div>
            <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={4} placeholder={'每行一个 vless://...，或 “备注<TAB>vless://...”'} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-xs text-slate-200 font-mono" />
            <div className="flex gap-2 items-center">
              <input value={bulkPortBase} onChange={(e) => setBulkPortBase(e.target.value)} placeholder="起始端口，例如 10880" className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 w-48" />
              <button onClick={importVlessProxies} className="px-3 py-1.5 rounded-lg text-sm bg-slate-700 text-slate-100 hover:bg-slate-600">Import</button>
            </div>
          </div>
        </section>
      )}

      {preview && (
        <section className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-cyan-300">Xray Plan</div>
            <div className="text-[11px] text-slate-500">{preview.dryRun ? 'Preview only' : `Written to ${preview.path}`}</div>
          </div>
          {preview.assignments.length === 0 ? (
            <div className="text-xs text-slate-500">No enabled VLESS upstreams.</div>
          ) : (
            <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
              {preview.assignments.map((item) => {
                const proxy = proxyList.find((p) => p.id === item.proxyId)
                return (
                  <div key={item.proxyId} className="rounded-lg border border-border-default/60 p-2 text-[11px] text-slate-400">
                    <div className="text-slate-200">{proxy?.label ?? item.proxyId}</div>
                    <div>Local: <span className="font-mono text-slate-300">{item.localUrl}</span></div>
                    <div>Outbound: <span className="font-mono text-slate-300">{item.outboundTag}</span></div>
                  </div>
                )
              })}
            </div>
          )}
          {preview.restart && !preview.restart.ok && <div className="text-xs text-red-400">Restart failed: {preview.restart.error}</div>}
          {preview.validation && (
            <div className={preview.validation.ok ? 'text-xs text-emerald-300' : 'text-xs text-red-400'}>
              Xray validation: {preview.validation.ok ? 'passed' : preview.validation.error ?? 'failed'}{preview.rolledBack ? ' · rolled back' : ''}
            </div>
          )}
          {preview.backupPath && <div className="text-[11px] text-slate-500">Backup: <span className="font-mono">{preview.backupPath}</span></div>}
        </section>
      )}

      {filtered.length === 0 ? (
        <div className="text-center text-slate-500 py-8">No matching exits.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
          {filtered.map((p) => (
            <ProxyCard key={p.id} proxy={p} accounts={accounts.data?.accounts ?? []} diag={diagnostics[p.id]} isProbing={probing.has(p.id)} onProbe={() => probe(p.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProxyCard({ proxy: p, accounts, diag, isProbing, onProbe }: {
  proxy: Proxy
  accounts: Awaited<ReturnType<typeof listAccounts>>['accounts']
  diag?: ProxyDiagnostics
  isProbing: boolean
  onProbe: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [savingLink, setSavingLink] = useState(false)
  const toast = useToast()
  const qc = useQueryClient()

  const persistedStatus = p.lastProbeStatus ?? undefined
  const status = diag?.status ?? persistedStatus
  const statusTone: BadgeTone = status === 'healthy' ? 'green' : status === 'degraded' ? 'yellow' : status === 'error' ? 'red' : 'gray'
  const statusLabel = isProbing ? 'Probing...' : status ?? 'Idle'
  const linkedIds = new Set((p.accounts ?? []).map((account) => account.id))
  const availableAccounts = accounts.filter((account) => !linkedIds.has(account.id))

  const linkSelectedAccount = async () => {
    if (!selectedAccountId) return
    setSavingLink(true)
    try {
      await linkAccountsToProxy(p.id, [selectedAccountId])
      setSelectedAccountId('')
      toast.success('Account linked')
      qc.invalidateQueries({ queryKey: ['proxies'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    } catch (e) {
      toast.error(`Link failed: ${(e as Error).message}`)
    } finally {
      setSavingLink(false)
    }
  }

  const unlinkAccount = async (accountId: string) => {
    setSavingLink(true)
    try {
      await unlinkAccountFromProxy(p.id, accountId)
      toast.success('Account unlinked')
      qc.invalidateQueries({ queryKey: ['proxies'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    } catch (e) {
      toast.error(`Unlink failed: ${(e as Error).message}`)
    } finally {
      setSavingLink(false)
    }
  }

  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-4 shadow-xs">
      <div className="flex items-start justify-between mb-3">
        <div>
          <Link to={`/network/${encodeURIComponent(p.id)}`} className="text-sm font-medium text-slate-100 hover:text-indigo-400">
            {p.label}
          </Link>
          <div className="text-[10px] text-slate-500">{p.accounts?.length ?? 0} accounts linked · {p.kind ?? 'local-http'}</div>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 mb-3">
        <div>Local: <span className="text-slate-300">{p.localUrl ? 'Ready' : 'Missing'}</span></div>
        <div>Port: <span className="text-slate-300">{p.inboundPort ?? '—'}</span></div>
        <div>Latency: <span className="text-slate-300">{diag?.latencyMs ? `${diag.latencyMs}ms` : '—'}</span></div>
        <div>IP: <span className="text-slate-300">{diag?.egressIp ?? p.egressIp ?? '—'}{diag?.egressFamily ? ` (${diag.egressFamily})` : ''}</span></div>
        <div>Checked: <span className="text-slate-300">{diag?.checkedAt ?? p.lastProbeAt ? new Date(diag?.checkedAt ?? p.lastProbeAt!).toLocaleString() : '—'}</span></div>
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
            <div>Xray: <span className="font-mono text-slate-300">{p.xrayConfigPath ?? '—'}</span></div>
            <div>Outbound: <span className="font-mono text-slate-300">{p.outboundTag ?? '—'}</span></div>
          </div>
          {p.accounts && p.accounts.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">Linked Accounts:</div>
              <div className="flex flex-wrap gap-1">
                {p.accounts.map((a) => (
                  <span key={a.id} className="inline-flex items-center gap-1">
                    <Link to={`/accounts/${encodeURIComponent(a.id)}`} className="text-[10px] text-indigo-400 hover:underline">
                      {a.label || a.emailAddress}
                    </Link>
                    <button onClick={() => unlinkAccount(a.id)} disabled={savingLink} className="text-[10px] text-red-400 hover:text-red-300 disabled:opacity-50">×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2 items-center">
            <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} className="min-w-0 flex-1 bg-bg-input border border-border-default rounded px-2 py-1 text-[11px] text-slate-200">
              <option value="">Link account...</option>
              {availableAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.label || account.emailAddress || account.id}</option>
              ))}
            </select>
            <button onClick={linkSelectedAccount} disabled={!selectedAccountId || savingLink} className="text-[10px] text-emerald-300 hover:text-emerald-200 disabled:opacity-50">Link</button>
          </div>
          {diag && (
            <div className="text-[10px] text-slate-400">
              <div>Status: {diag.status} | Via: {diag.via ?? 'N/A'} | HTTP: {diag.httpStatus ?? '—'}{diag.error ? ` | Error: ${diag.error}` : ''}</div>
            </div>
          )}
          {!diag && p.lastProbeStatus && (
            <div className="text-[10px] text-slate-400">Last probe: {p.lastProbeStatus} · {p.lastProbeAt ? new Date(p.lastProbeAt).toLocaleString() : '—'}</div>
          )}
        </div>
      )}
    </div>
  )
}
