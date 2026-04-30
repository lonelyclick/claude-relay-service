import { Link } from 'react-router'
import { Badge, type BadgeTone } from '~/components/Badge'
import type { Account, Proxy } from '~/api/types'
import { accountPlanLabel, isClaudeProvider, needsProxyWarning } from '~/lib/account'
import { fmtShanghaiDateTime } from '~/lib/format'

type Signal = { label: string; tone: BadgeTone }

function getAutoBlockedUntilLabel(a: Account): string | null {
  if (a.schedulerState !== 'auto_blocked' || a.autoBlockedUntil == null) {
    return null
  }
  return fmtShanghaiDateTime(a.autoBlockedUntil)
}

function getSignals(a: Account): Signal[] {
  const signals: Signal[] = []
  const autoBlockedUntil = getAutoBlockedUntilLabel(a)
  if (a.schedulerState === 'auto_blocked') {
    const unblockText = autoBlockedUntil ? ` - 解封时间 ${autoBlockedUntil}` : ''
    signals.push({ label: `Auto-blocked: ${a.autoBlockedReason ?? 'unknown'}${unblockText}`, tone: 'red' })
  }
  if (!a.isActive) signals.push({ label: 'Inactive', tone: 'red' })
  if (needsProxyWarning(a)) signals.push({ label: 'No proxy', tone: 'yellow' })
  if (!a.hasAccessToken) signals.push({ label: 'No access token', tone: 'red' })
  if (!a.hasRefreshToken && a.authMode === 'oauth') signals.push({ label: 'No refresh token', tone: 'yellow' })
  if (a.lastError) signals.push({ label: 'Has errors', tone: 'yellow' })
  return signals
}

function healthTone(a: Account): BadgeTone {
  const signals = getSignals(a)
  if (signals.some((s) => s.tone === 'red')) return 'red'
  if (signals.some((s) => s.tone === 'yellow')) return 'yellow'
  return 'green'
}

function providerTone(provider: string): BadgeTone {
  if (isClaudeProvider(provider)) return 'orange'
  if (provider.includes('openai')) return 'green'
  return 'gray'
}

function schedulerTone(state?: string): BadgeTone {
  if (state === 'enabled') return 'green'
  if (state === 'paused') return 'yellow'
  if (state === 'draining') return 'blue'
  if (state === 'auto_blocked') return 'red'
  return 'gray'
}

function resolveProxyLabel(account: Account, proxies: Proxy[]): string {
  if (!account.proxyUrl) return 'None'
  const proxy = proxies.find((p) => p.localUrl === account.proxyUrl || p.url === account.proxyUrl)
  return proxy?.label ?? 'Unknown network'
}

export function AccountCard({ account, proxies = [] }: { account: Account; proxies?: Proxy[] }) {
  const signals = getSignals(account)
  const ht = healthTone(account)
  const plan = accountPlanLabel(account)
  const autoBlockedUntil = getAutoBlockedUntilLabel(account)
  const proxyLabel = resolveProxyLabel(account, proxies)

  return (
    <Link
      to={`/accounts/${encodeURIComponent(account.id)}`}
      className="block bg-bg-card border border-border-default rounded-xl p-4 shadow-xs hover:border-border-hover hover:shadow-card transition-all duration-150"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-100 truncate">
            {account.label || account.emailAddress || account.id}
          </div>
          {account.label && (
            <div className="text-xs text-slate-500 truncate">{account.emailAddress || account.id}</div>
          )}
        </div>
        <Badge tone={ht}>{ht === 'green' ? 'Healthy' : ht === 'yellow' ? 'Warning' : 'Critical'}</Badge>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <Badge tone={providerTone(account.provider)}>{account.provider}</Badge>
        <Badge tone="blue">{account.protocol}</Badge>
        <Badge tone="gray">{account.authMode}</Badge>
        {account.schedulerState && (
          <Badge tone={schedulerTone(account.schedulerState)}>{account.schedulerState}</Badge>
        )}
      </div>

      {signals.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {signals.map((s, i) => (
            <span key={i} className="text-[10px] text-slate-400 bg-bg-card-raised/30 rounded px-1.5 py-0.5">{s.label}</span>
          ))}
        </div>
      )}

      {autoBlockedUntil && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-200">
          解封时间：<span className="font-semibold text-red-100">{autoBlockedUntil}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <div>Plan: <span className="text-slate-300">{plan ?? '—'}</span></div>
        <div>Workspace: <span className="text-slate-300">{account.organizationUuid ?? '—'}</span></div>
        <div>Group: <span className="text-slate-300">{account.routingGroupId ?? '—'}</span></div>
        <div>Max Sessions: <span className="text-slate-300">{account.maxSessions ?? 'Default'}</span></div>
        <div>Proxy: <span className="text-slate-300">{proxyLabel}</span></div>
        <div>Access: <span className="text-slate-300">{account.hasAccessToken ? 'Yes' : 'No'}</span></div>
        <div>Refresh: <span className="text-slate-300">{account.hasRefreshToken ? 'Yes' : 'No'}</span></div>
      </div>
    </Link>
  )
}
