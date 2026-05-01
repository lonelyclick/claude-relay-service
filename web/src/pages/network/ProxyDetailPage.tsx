import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listAccounts } from '~/api/accounts'
import { listProxies, probeProxy, updateProxy, deleteProxy, linkAccountsToProxy, unlinkAccountFromProxy, syncXrayConfig } from '~/api/proxies'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge, type BadgeTone } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import { timeAgo, truncateMiddle } from '~/lib/format'
import type { Account, Proxy, ProxyDiagnostics, XraySyncResult } from '~/api/types'

type ProxyKind = NonNullable<Proxy['kind']>
type InboundProtocol = NonNullable<Proxy['inboundProtocol']>

export function ProxyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const proxyId = id ?? ''
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()

  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const proxy = proxies.data?.proxies.find((p) => p.id === id)

  if (proxies.isLoading || accounts.isLoading) return <PageSkeleton />
  if (!proxy) return <div className="text-red-400 text-sm">Network not found</div>

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/network')} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Network</button>

      <HeaderSection proxy={proxy} />
      <NameSection proxy={proxy} toast={toast} qc={qc} />
      <DiagnosticsSection proxy={proxy} toast={toast} qc={qc} />
      <LinkedAccountsSection proxy={proxy} accounts={accounts.data?.accounts ?? []} toast={toast} qc={qc} />
      <ManagedSettingsSection proxy={proxy} toast={toast} qc={qc} />
      <RawConfigSection proxy={proxy} />
      <ActionsSection proxy={proxy} proxyId={proxyId} toast={toast} qc={qc} navigate={navigate} />
    </div>
  )
}

function HeaderSection({ proxy }: { proxy: Proxy }) {
  const status = proxy.lastProbeStatus ?? 'idle'
  const tone: BadgeTone = status === 'healthy' ? 'green' : status === 'degraded' ? 'yellow' : status === 'error' ? 'red' : 'gray'

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-100">{proxy.label}</h2>
          <div className="text-xs text-slate-500 font-mono">{proxy.id}</div>
        </div>
        <Badge tone={tone}>{status}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400 max-md:grid-cols-1">
        <div>Kind: <span className="text-slate-200">{proxy.kind ?? 'local-http'}</span></div>
        <div>Linked Accounts: <span className="text-slate-200">{proxy.accounts?.length ?? 0}</span></div>
        <div>Local: <span className="font-mono text-slate-200 break-all">{proxy.localUrl ?? '—'}</span></div>
        <div>Port: <span className="font-mono text-slate-200">{proxy.inboundPort ?? 'Auto'}</span></div>
        <div>Exit IP: <span className="text-slate-200">{proxy.egressIp ?? '—'}</span></div>
        <div>Last Probe: <span className="text-slate-200">{proxy.lastProbeAt ? timeAgo(proxy.lastProbeAt) : '—'}</span></div>
      </div>
    </section>
  )
}

function NameSection({ proxy, toast, qc }: { proxy: Proxy; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [label, setLabel] = useState(proxy.label)

  useEffect(() => {
    setLabel(proxy.label)
  }, [proxy.id, proxy.label])

  const normalizedLabel = label.trim()
  const changed = normalizedLabel !== proxy.label

  const mut = useMutation({
    mutationFn: () => updateProxy(proxy.id, { label: normalizedLabel || proxy.label }),
    onSuccess: () => {
      toast.success('Network name updated')
      qc.invalidateQueries({ queryKey: ['proxies'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Network Name</div>
      <div className="flex gap-2 items-center max-sm:flex-col max-sm:items-stretch">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 flex-1"
        />
        <button
          onClick={() => mut.mutate()}
          disabled={!changed || mut.isPending}
          className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-500 transition-colors"
        >
          Save Name
        </button>
      </div>
      <div className="mt-2 text-xs text-slate-500">This name is shown in Network cards and account proxy references.</div>
    </section>
  )
}

function DiagnosticsSection({ proxy, toast, qc }: { proxy: Proxy; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [diag, setDiag] = useState<ProxyDiagnostics | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [syncResult, setSyncResult] = useState<XraySyncResult | null>(null)

  const handleProbe = async () => {
    setIsProbing(true)
    try {
      const result = await probeProxy(proxy.id)
      setDiag(result)
      toast.success(`Probe ${result.status}`)
      qc.invalidateQueries({ queryKey: ['proxies'] })
    } catch (e) {
      toast.error(`Probe failed: ${(e as Error).message}`)
    } finally {
      setIsProbing(false)
    }
  }

  const handleSync = async () => {
    setIsProbing(true)
    try {
      const result = await syncXrayConfig({ validate: true, restart: true })
      setSyncResult(result)
      toast.success(`Generated ${result.assignments.length} managed exits${result.restart?.ok ? ', restarted' : ''}`)
      qc.invalidateQueries({ queryKey: ['proxies'] })
    } catch (e) {
      toast.error(`Generate failed: ${(e as Error).message}`)
    } finally {
      setIsProbing(false)
    }
  }

  const shownStatus = diag?.status ?? proxy.lastProbeStatus ?? 'idle'
  const tone: BadgeTone = shownStatus === 'healthy' ? 'green' : shownStatus === 'degraded' ? 'yellow' : shownStatus === 'error' ? 'red' : 'gray'

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Diagnostics</div>
        <Badge tone={tone}>{shownStatus}</Badge>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        <button onClick={handleProbe} disabled={isProbing} className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50">
          {isProbing ? 'Working...' : 'Probe'}
        </button>
        <button onClick={handleSync} disabled={isProbing} className="px-3 py-1.5 rounded-lg text-sm bg-slate-700 text-slate-100 hover:bg-slate-600 disabled:opacity-50">
          Generate Xray Config
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs max-md:grid-cols-1">
        <div className="text-slate-400">Latency: <span className="text-slate-200">{diag?.latencyMs ? `${diag.latencyMs}ms` : '—'}</span></div>
        <div className="text-slate-400">IP: <span className="text-slate-200">{diag?.egressIp ?? proxy.egressIp ?? '—'}{diag?.egressFamily ? ` (${diag.egressFamily})` : ''}</span></div>
        <div className="text-slate-400">Via: <span className="text-slate-200">{diag?.via ?? '—'}</span></div>
        <div className="text-slate-400">HTTP: <span className="text-slate-200">{diag?.httpStatus ?? '—'}</span></div>
        <div className="text-slate-500">Probed: {diag?.checkedAt ? timeAgo(diag.checkedAt) : proxy.lastProbeAt ? timeAgo(proxy.lastProbeAt) : '—'}</div>
        {diag?.error && <div className="text-red-400 col-span-2">Error: {diag.error}</div>}
      </div>
      {syncResult && (
        <div className="mt-3 text-xs text-slate-400 space-y-1">
          <div>Generated: <span className="text-slate-200">{syncResult.assignments.length}</span> exits</div>
          <div>Config: <span className="font-mono text-slate-300 break-all">{syncResult.path}</span></div>
          {syncResult.restart && <div>Restart: <span className={syncResult.restart.ok ? 'text-emerald-300' : 'text-red-400'}>{syncResult.restart.ok ? 'ok' : syncResult.restart.error}</span></div>}
          {syncResult.validation && <div>Validation: <span className={syncResult.validation.ok ? 'text-emerald-300' : 'text-red-400'}>{syncResult.validation.skipped ? 'skipped' : syncResult.validation.ok ? 'ok' : syncResult.validation.error}</span></div>}
        </div>
      )}
    </section>
  )
}

function LinkedAccountsSection({ proxy, accounts, toast, qc }: {
  proxy: Proxy
  accounts: Account[]
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
}) {
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [saving, setSaving] = useState(false)
  const linkedIds = new Set((proxy.accounts ?? []).map((account) => account.id))
  const availableAccounts = accounts.filter((account) => !linkedIds.has(account.id))

  const linkSelected = async () => {
    if (!selectedAccountId) return
    setSaving(true)
    try {
      await linkAccountsToProxy(proxy.id, [selectedAccountId])
      setSelectedAccountId('')
      toast.success('Account linked')
      qc.invalidateQueries({ queryKey: ['proxies'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    } catch (e) {
      toast.error(`Link failed: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const unlink = async (accountId: string) => {
    setSaving(true)
    try {
      await unlinkAccountFromProxy(proxy.id, accountId)
      toast.success('Account unlinked')
      qc.invalidateQueries({ queryKey: ['proxies'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    } catch (e) {
      toast.error(`Unlink failed: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Linked Accounts ({proxy.accounts?.length ?? 0})</div>
      <div className="flex gap-2 items-center mb-4 max-sm:flex-col max-sm:items-stretch">
        <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} className="min-w-0 flex-1 bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
          <option value="">Link account...</option>
          {availableAccounts.map((account) => (
            <option key={account.id} value={account.id}>{account.label || account.emailAddress || account.id}</option>
          ))}
        </select>
        <button onClick={linkSelected} disabled={!selectedAccountId || saving} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
          Link Account
        </button>
      </div>
      {proxy.accounts && proxy.accounts.length > 0 ? (
        <div className="space-y-2">
          {proxy.accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-default/60 px-3 py-2 text-xs">
              <Link to={`/accounts/${encodeURIComponent(account.id)}`} className="text-indigo-400 hover:underline truncate">
                {account.label || account.emailAddress || account.id}
              </Link>
              <button onClick={() => unlink(account.id)} disabled={saving} className="text-red-400 hover:text-red-300 disabled:opacity-50">Unlink</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-slate-500">No accounts linked.</div>
      )}
    </section>
  )
}

function ManagedSettingsSection({ proxy, toast, qc }: { proxy: Proxy; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [kind, setKind] = useState(proxy.kind ?? 'local-http')
  const [enabled, setEnabled] = useState(proxy.enabled !== false)
  const [inboundProtocol, setInboundProtocol] = useState(proxy.inboundProtocol ?? 'http')

  useEffect(() => {
    setKind(proxy.kind ?? 'local-http')
    setEnabled(proxy.enabled !== false)
    setInboundProtocol(proxy.inboundProtocol ?? 'http')
  }, [proxy.id, proxy.kind, proxy.enabled, proxy.inboundProtocol])

  const mut = useMutation({
    mutationFn: () => updateProxy(proxy.id, { kind, enabled, inboundProtocol }),
    onSuccess: () => {
      toast.success('Managed settings updated')
      qc.invalidateQueries({ queryKey: ['proxies'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Managed Xray Settings</div>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <label className="block space-y-1">
          <span className="text-xs text-slate-400">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ProxyKind)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
            <option value="vless-upstream">VLESS upstream</option>
            <option value="local-http">Local HTTP</option>
            <option value="local-socks">Local SOCKS</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-slate-400">Inbound Protocol</span>
          <select value={inboundProtocol} onChange={(e) => setInboundProtocol(e.target.value as InboundProtocol)} className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200">
            <option value="http">HTTP</option>
            <option value="socks">SOCKS</option>
          </select>
        </label>
        <div className="space-y-1">
          <span className="text-xs text-slate-400">Inbound Port</span>
          <div className="rounded-lg border border-border-default bg-bg-input px-3 py-1.5 text-sm text-slate-400">
            {proxy.inboundPort ?? 'Auto assigned after Probe / Generate'}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300 self-end py-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Include in COR managed Xray config
        </label>
      </div>
      <button onClick={() => mut.mutate()} disabled={mut.isPending} className="mt-4 px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50">
        Save Settings
      </button>
    </section>
  )
}

function RawConfigSection({ proxy }: { proxy: Proxy }) {
  const toast = useToast()
  const copy = async (value: string | undefined | null, label: string) => {
    if (!value) return
    await navigator.clipboard.writeText(value)
    toast.success(`${label} copied`)
  }

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Raw Config</div>
      <div className="space-y-2 text-xs text-slate-400">
        <div>Remote: <span className="font-mono text-slate-300 break-all">{proxy.url}</span></div>
        <div>Local: <span className="font-mono text-slate-300 break-all">{proxy.localUrl ?? '—'}</span></div>
        <div>Xray Config: <span className="font-mono text-slate-300 break-all">{proxy.xrayConfigPath ?? '—'}</span></div>
        <div>Outbound: <span className="font-mono text-slate-300 break-all">{proxy.outboundTag ?? '—'}</span></div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <button onClick={() => copy(proxy.url, 'Remote URL')} className="text-xs text-slate-400 hover:text-slate-200">Copy Remote</button>
        {proxy.localUrl && <button onClick={() => copy(proxy.localUrl, 'Local URL')} className="text-xs text-slate-400 hover:text-slate-200">Copy Local</button>}
      </div>
      <div className="mt-3 text-[11px] text-slate-500">Remote preview: {truncateMiddle(proxy.url, 96)}</div>
    </section>
  )
}

function ActionsSection({ proxy, proxyId, toast, qc, navigate }: {
  proxy: Proxy
  proxyId: string
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
  navigate: ReturnType<typeof useNavigate>
}) {
  const deleteMut = useMutation({
    mutationFn: () => deleteProxy(proxyId),
    onSuccess: () => {
      toast.success('Network deleted')
      qc.invalidateQueries({ queryKey: ['proxies'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
      navigate('/network')
    },
    onError: (e) => toast.error(e.message),
  })

  const linkedCount = proxy.accounts?.length ?? 0

  return (
    <section className="bg-bg-card border border-red-500/20 rounded-xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-red-300 mb-3">Danger Zone</div>
      <button
        onClick={() => {
          const message = linkedCount > 0 ? `Delete "${proxy.label}" and unlink ${linkedCount} account(s)?` : `Delete "${proxy.label}"?`
          if (confirm(message)) deleteMut.mutate()
        }}
        disabled={deleteMut.isPending}
        className="px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
      >
        Delete Network
      </button>
      <div className="mt-2 text-xs text-slate-500">Deleting removes the COR network record and unlinks accounts. Generate Xray Config afterward to clean managed Xray entries.</div>
    </section>
  )
}
