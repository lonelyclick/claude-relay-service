import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAccount, deleteAccount, refreshAccount, updateAccountSettings, probeRateLimit, generateAuthUrl, exchangeCode } from '~/api/accounts'
import { getLifecycleEvents } from '~/api/risk'
import { listRoutingGroups } from '~/api/routing'
import { listProxies } from '~/api/proxies'
import { ProxySelect } from './OnboardPage'
import { Badge, type BadgeTone } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { useToast } from '~/components/Toast'
import { accountPlanLabel, isClaudeProvider, needsProxyWarning } from '~/lib/account'
import { cn } from '~/lib/cn'
import { fmtShanghaiDateTime, timeAgo } from '~/lib/format'
import type { Account, AccountLifecycleEvent, ClaudeWarmupPolicyId, RateLimitProbe, RoutingGroup } from '~/api/types'

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()

  const account = useQuery({ queryKey: ['account', id], queryFn: () => getAccount(id!) })
  const groups = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })
  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })

  if (account.isLoading) return <PageSkeleton />
  if (account.error) return <div className="text-red-400 text-sm">Failed to load account: {(account.error as Error).message}</div>
  if (!account.data) return <div className="text-slate-400 text-sm">Account not found</div>

  const a = account.data

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/accounts')} className="text-sm text-slate-400 hover:text-slate-200">&larr; Back to Accounts</button>

      <HeaderSection account={a} />
      <AccountLabelSection account={a} toast={toast} qc={qc} />
      <SchedulerSection account={a} toast={toast} qc={qc} />
      {a.provider === 'claude-official' && (
        <WarmupSection account={a} toast={toast} qc={qc} />
      )}
      <NetworkSection account={a} proxies={proxies.data?.proxies ?? []} toast={toast} qc={qc} />
      <RoutingGroupSection account={a} groups={groups.data?.routingGroups ?? []} toast={toast} qc={qc} />
      {a.provider === 'claude-compatible' && (
        <ClaudeCompatibleModelSection account={a} toast={toast} qc={qc} />
      )}
      {a.provider === 'openai-compatible' && (
        <OpenAICompatibleModelSection account={a} toast={toast} qc={qc} />
      )}
      <RateLimitSection accountId={a.id} protocol={a.protocol} />
      {a.provider === 'claude-official' && <WarmupHistorySection accountId={a.id} />}
      <OAuthLoginSection account={a} toast={toast} qc={qc} />
      <ActionsSection account={a} toast={toast} qc={qc} navigate={navigate} />
      <AdvancedSection account={a} />
    </div>
  )
}

function NetworkSection({ account: a, proxies, toast, qc }: {
  account: Account
  proxies: import('~/api/types').Proxy[]
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
}) {
  const network = proxies.find((proxy) => a.proxyUrl && (proxy.localUrl === a.proxyUrl || proxy.url === a.proxyUrl))
  const directEnabled = a.directEgressEnabled === true
  const canDirect = a.provider === 'claude-official'
  const effectiveEgress = a.proxyUrl
    ? `Proxy · ${network?.label ?? 'Unknown network'}`
    : directEnabled
      ? 'Direct server egress'
      : 'None'

  const mut = useMutation({
    mutationFn: () => updateAccountSettings(a.id, { directEgressEnabled: !directEnabled }),
    onSuccess: () => {
      toast.success(!directEnabled ? 'Direct egress enabled' : 'Direct egress disabled')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-start justify-between gap-3 max-md:flex-col">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Network</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400 max-md:grid-cols-1">
            <div>Effective Egress: <span className="text-slate-200">{effectiveEgress}</span></div>
            <div>Bound Network: <span className="text-slate-200">{network?.label ?? (a.proxyUrl ? 'Unknown network' : 'None')}</span></div>
            <div>Proxy URL: <span className="text-slate-200 font-mono break-all">{a.proxyUrl ?? '—'}</span></div>
            <div>Direct Whitelist: <span className={directEnabled ? 'text-amber-300' : 'text-slate-300'}>{directEnabled ? 'Enabled' : 'Disabled'}</span></div>
          </div>
        </div>
        {canDirect && (
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 shrink-0',
              directEnabled
                ? 'bg-amber-500/15 text-amber-100 border-amber-500/30 hover:bg-amber-500/25'
                : 'bg-bg-card-raised border-border-default text-slate-200 hover:text-white',
            )}
          >
            {mut.isPending ? 'Saving…' : directEnabled ? '关闭直连白名单' : '允许无代理直连'}
          </button>
        )}
      </div>
      {canDirect && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-100/80">
          开启后，该 Claude Official 账号在未绑定 proxy 时可从服务器出口直连；如绑定了 proxy，仍优先使用 proxy。
        </div>
      )}
    </section>
  )
}

function AccountLabelSection({ account: a, toast, qc }: { account: Account; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [label, setLabel] = useState(a.label ?? '')

  useEffect(() => {
    setLabel(a.label ?? '')
  }, [a.id, a.label])

  const normalizedLabel = label.trim()
  const changed = normalizedLabel !== (a.label ?? '')

  const mut = useMutation({
    mutationFn: () => updateAccountSettings(a.id, { label: normalizedLabel || null }),
    onSuccess: () => {
      toast.success('Account label updated')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Account Label</div>
      <div className="flex gap-2 items-center max-sm:flex-col max-sm:items-stretch">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={a.emailAddress || a.id}
          className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 flex-1"
        />
        <button
          onClick={() => mut.mutate()}
          disabled={!changed || mut.isPending}
          className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-500 transition-colors"
        >
          Save Label
        </button>
      </div>
      <div className="mt-2 text-xs text-slate-500">Leave empty to fall back to the account email.</div>
    </section>
  )
}


function formatAutoBlockedReason(reason?: string | null): string {
  if (!reason) return 'unknown'
  const normalized = reason.startsWith('risk_guardrail:') ? reason.slice('risk_guardrail:'.length) : reason
  if (!normalized.startsWith('warmup_auto_block|')) return reason
  const fields = new Map<string, string>()
  for (const part of normalized.split('|').slice(1)) {
    const idx = part.indexOf('=')
    if (idx > 0) fields.set(part.slice(0, idx), part.slice(idx + 1))
  }
  const triggered = fields.get('triggered')
    ?.split(';')
    .filter(Boolean)
    .map((item) => {
      const [code, value] = item.split('=')
      return value ? `${code} ${value}` : item
    })
    .join(', ')
  const stage = fields.get('stage') ?? 'unknown_stage'
  const stageLabel = fields.get('stageLabel')
  const cooldownMs = Number(fields.get('cooldownMs'))
  const cooldownText = Number.isFinite(cooldownMs) && cooldownMs > 0 ? `, cooldown ${Math.round(cooldownMs / 60000)}m` : ''
  return `Warmup auto-block: ${stageLabel ? `${stageLabel} (${stage})` : stage}; triggered ${triggered ?? 'unknown'}${cooldownText}`
}

function HeaderSection({ account: a }: { account: Account }) {
  const signals: { label: string; tone: BadgeTone }[] = []
  const autoBlockedUntil =
    a.schedulerState === 'auto_blocked' && a.autoBlockedUntil != null
      ? fmtShanghaiDateTime(a.autoBlockedUntil)
      : null
  if (a.status === 'banned') signals.push({ label: '被封禁 / Banned', tone: 'red' })
  if (a.schedulerState === 'auto_blocked') {
    const unblockText = autoBlockedUntil ? ` - 解封时间 ${autoBlockedUntil}` : ''
    signals.push({ label: `Auto-blocked: ${formatAutoBlockedReason(a.autoBlockedReason)}${unblockText}`, tone: 'red' })
  }
  if (!a.isActive) signals.push({ label: 'Inactive', tone: 'red' })
  if (needsProxyWarning(a)) signals.push({ label: 'No proxy', tone: 'yellow' })
  if (!a.hasAccessToken) signals.push({ label: 'No access token', tone: 'red' })
  if (!a.hasRefreshToken && a.authMode === 'oauth') signals.push({ label: 'No refresh token', tone: 'yellow' })
  if (a.lastError) signals.push({ label: 'Has errors', tone: 'yellow' })

  const healthTone: BadgeTone = signals.some((s) => s.tone === 'red') ? 'red' : signals.some((s) => s.tone === 'yellow') ? 'yellow' : 'green'
  const plan = accountPlanLabel(a)

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-bold text-slate-100">{a.label || a.emailAddress || a.id}</h2>
          {a.label && <div className="text-sm text-slate-400">{a.emailAddress || a.id}</div>}
        </div>
        <Badge tone={healthTone}>{healthTone === 'green' ? 'Healthy' : healthTone === 'yellow' ? 'Warning' : 'Critical'}</Badge>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        <Badge tone={isClaudeProvider(a.provider) ? 'orange' : 'green'}>{a.provider}</Badge>
        <Badge tone="blue">{a.protocol}</Badge>
        <Badge tone="gray">{a.authMode}</Badge>
        {a.status === 'banned' && <Badge tone="red">banned</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400 mb-3 max-md:grid-cols-1">
        <div>Plan: <span className="text-slate-200">{plan ?? '—'}</span></div>
        <div>Workspace: <span className="text-slate-200">{a.organizationUuid ?? '—'}</span></div>
        <div>Model: <span className="text-slate-200">{a.modelName ?? '—'}</span></div>
        <div>Status: <span className={a.status === 'banned' ? 'text-red-300' : 'text-slate-200'}>{a.status ?? '—'}</span></div>
        <div>Rate Limit: <span className="text-slate-200">{a.lastRateLimitStatus ?? '—'}</span></div>
        <div>5h Seen: <span className="text-slate-200">{a.lastRateLimit5hUtilization != null ? `${Math.round(a.lastRateLimit5hUtilization * 100)}%` : '—'}</span></div>
        <div>7d Seen: <span className="text-slate-200">{a.lastRateLimit7dUtilization != null ? `${Math.round(a.lastRateLimit7dUtilization * 100)}%` : '—'}</span></div>
      </div>
      {autoBlockedUntil && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          解封时间：<span className="font-semibold text-red-100">{autoBlockedUntil}</span>
        </div>
      )}
      {signals.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {signals.map((s, i) => (
            <Badge key={i} tone={s.tone}>{s.label}</Badge>
          ))}
        </div>
      )}
    </section>
  )
}


function WarmupSection({ account: a, toast, qc }: { account: Account; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const enabled = a.warmupEnabled !== false
  const policyId = a.warmupPolicyId ?? 'a'
  const saveMut = useMutation({
    mutationFn: async (settings: { warmupEnabled?: boolean; warmupPolicyId?: ClaudeWarmupPolicyId }) => (await updateAccountSettings(a.id, settings)) as Account,
    onSuccess: (updated: Account) => {
      toast.success(updated.warmupEnabled === false ? 'Warmup disabled' : `Warmup ${updated.warmupPolicyId ?? 'a'} saved`)
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['risk-lifecycle-summary'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-start justify-between gap-4 max-lg:flex-col">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wider text-amber-300 mb-2">Warmup 防风控</div>
          <div className="text-sm text-slate-200">{enabled ? `已启用策略 ${policyId.toUpperCase()}` : '已关闭新号 warmup 限速'}</div>
          <div className="mt-1 text-xs leading-5 text-slate-500">
            A 是默认均衡；B 更宽松；C 最宽松。关闭后不执行新号阶段 RPM / tokens / cacheRead 限速，但生命周期和全局风控日志仍会记录。
          </div>
        </div>
        <div className="flex items-center gap-2 max-sm:w-full max-sm:flex-col">
          <select
            value={policyId}
            onChange={(event) => saveMut.mutate({ warmupEnabled: true, warmupPolicyId: event.target.value as ClaudeWarmupPolicyId })}
            disabled={!enabled || saveMut.isPending}
            className="bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200 disabled:opacity-50 max-sm:w-full"
          >
            <option value="a">A 默认均衡</option>
            <option value="b">B 宽松</option>
            <option value="c">C 最宽松</option>
            <option value="d">D 超宽松</option>
            <option value="e">E 灾难保护</option>
          </select>
          <button
            type="button"
            onClick={() => saveMut.mutate({ warmupEnabled: !enabled, warmupPolicyId: policyId })}
            disabled={saveMut.isPending}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 shrink-0 max-sm:w-full',
              enabled
                ? 'bg-amber-500/15 text-amber-100 border border-amber-500/30 hover:bg-amber-500/25'
                : 'bg-indigo-600 text-white hover:bg-indigo-500',
            )}
          >
            {saveMut.isPending ? 'Saving...' : enabled ? '关闭 warmup' : '重新启用 warmup'}
          </button>
        </div>
      </div>
    </section>
  )
}


function WarmupHistorySection({ accountId }: { accountId: string }) {
  const warmupEvents = useQuery({
    queryKey: ['account-warmup-history', accountId],
    queryFn: () => getLifecycleEvents({ accountId, eventTypes: ['warmup_task'], limit: 20 }),
    refetchInterval: 60_000,
  })
  const rows = warmupEvents.data?.events ?? []
  const lastOk = rows.find((event) => event.outcome === 'ok') ?? null

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-start justify-between gap-3 max-md:flex-col">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-emerald-300 mb-2">Warmup History</div>
          <div className="text-sm text-slate-200">
            {lastOk ? `最近成功：${fmtShanghaiDateTime(lastOk.occurredAt)}` : '还没有成功 warmup 记录'}
          </div>
          <div className="mt-1 text-xs text-slate-500">自动低频 /v1/messages 健康 warmup，展示最近 20 条生命周期事件。</div>
        </div>
        <button
          type="button"
          onClick={() => warmupEvents.refetch()}
          disabled={warmupEvents.isFetching}
          className="px-3 py-1.5 rounded-lg text-sm bg-bg-card-raised border border-border-default text-slate-200 hover:text-white disabled:opacity-50"
        >
          {warmupEvents.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {warmupEvents.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          加载 warmup 历史失败：{(warmupEvents.error as Error).message}
        </div>
      )}

      {rows.length === 0 && !warmupEvents.isLoading ? (
        <div className="rounded-lg border border-border-default bg-bg-input px-3 py-4 text-sm text-slate-500">
          暂无 warmup_task 记录。若刚开启，最多等待一个调度周期后刷新。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-default">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-bg-input text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">结果</th>
                <th className="px-3 py-2 font-medium">HTTP</th>
                <th className="px-3 py-2 font-medium">Unified</th>
                <th className="px-3 py-2 font-medium">Overage</th>
                <th className="px-3 py-2 font-medium">耗时</th>
                <th className="px-3 py-2 font-medium">Request</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {rows.map((event) => (
                <WarmupHistoryRow key={event.id} event={event} />
              ))}
              {warmupEvents.isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-slate-500">Loading…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function WarmupHistoryRow({ event }: { event: AccountLifecycleEvent }) {
  const notes = event.notes ?? {}
  const unifiedStatus = stringNote(notes, 'unifiedStatus') ?? '—'
  const overageStatus = stringNote(notes, 'overageStatus') ?? '—'
  const overageReason = stringNote(notes, 'overageDisabledReason')
  const tone: BadgeTone = event.outcome === 'ok' ? 'green' : event.outcome === 'failure' ? 'red' : 'gray'
  return (
    <tr className="hover:bg-bg-input/50 align-top">
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="text-slate-200">{fmtShanghaiDateTime(event.occurredAt)}</div>
        <div className="text-[10px] text-slate-500">{timeAgo(event.occurredAt)}</div>
      </td>
      <td className="px-3 py-2"><Badge tone={tone}>{event.outcome ?? 'info'}</Badge></td>
      <td className="px-3 py-2 text-slate-300">{event.upstreamStatus ?? '—'}</td>
      <td className="px-3 py-2 text-slate-300">{unifiedStatus}</td>
      <td className="px-3 py-2 text-slate-300">
        <div>{overageStatus}</div>
        {overageReason && <div className="text-[10px] text-amber-300">{overageReason}</div>}
      </td>
      <td className="px-3 py-2 text-slate-400">{event.durationMs != null ? `${event.durationMs}ms` : '—'}</td>
      <td className="px-3 py-2 font-mono text-[11px] text-slate-500 break-all">{event.upstreamRequestId ?? '—'}</td>
    </tr>
  )
}

function stringNote(notes: Record<string, unknown>, key: string): string | null {
  const value = notes[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function SchedulerSection({ account: a, toast, qc }: { account: Account; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [maxSessionsInput, setMaxSessionsInput] = useState(a.maxSessions == null ? '' : String(a.maxSessions))
  const [planTypeInput, setPlanTypeInput] = useState(a.planType ?? '')
  const [planMultiplierInput, setPlanMultiplierInput] = useState(a.planMultiplier == null ? '' : String(a.planMultiplier))
  const autoBlockedUntil =
    a.schedulerState === 'auto_blocked' && a.autoBlockedUntil != null
      ? fmtShanghaiDateTime(a.autoBlockedUntil)
      : null

  useEffect(() => {
    setMaxSessionsInput(a.maxSessions == null ? '' : String(a.maxSessions))
    setPlanTypeInput(a.planType ?? '')
    setPlanMultiplierInput(a.planMultiplier == null ? '' : String(a.planMultiplier))
  }, [a.id, a.maxSessions, a.planType, a.planMultiplier])

  const stateMut = useMutation({
    mutationFn: (state: string) => updateAccountSettings(a.id, { schedulerState: state }),
    onSuccess: () => {
      toast.success('Scheduler state updated')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const normalizedMaxSessions = maxSessionsInput.trim()
  const parsedMaxSessions = normalizedMaxSessions ? Number(normalizedMaxSessions) : null
  const maxSessionsValid = parsedMaxSessions === null || (Number.isInteger(parsedMaxSessions) && parsedMaxSessions >= 1)
  const maxSessionsChanged = normalizedMaxSessions !== (a.maxSessions == null ? '' : String(a.maxSessions))

  const maxSessionsMut = useMutation({
    mutationFn: () => updateAccountSettings(a.id, { maxSessions: parsedMaxSessions }),
    onSuccess: () => {
      toast.success('Max sessions updated')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const normalizedPlanType = planTypeInput.trim()
  const normalizedPlanMultiplier = planMultiplierInput.trim()
  const parsedPlanMultiplier = normalizedPlanMultiplier ? Number(normalizedPlanMultiplier) : null
  const planMultiplierValid = parsedPlanMultiplier === null || (Number.isFinite(parsedPlanMultiplier) && parsedPlanMultiplier > 0)
  const planSettingsChanged =
    normalizedPlanType !== (a.planType ?? '') ||
    normalizedPlanMultiplier !== (a.planMultiplier == null ? '' : String(a.planMultiplier))

  const planMut = useMutation({
    mutationFn: () => updateAccountSettings(a.id, {
      planType: normalizedPlanType || null,
      planMultiplier: parsedPlanMultiplier,
    }),
    onSuccess: () => {
      toast.success('Plan weight updated')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const states = ['enabled', 'paused', 'draining'] as const
  const activeStateClasses: Record<(typeof states)[number], string> = {
    enabled: 'bg-green-500/20 text-green-400 border-green-500/40',
    paused: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
    draining: 'bg-accent-muted text-indigo-400 border-accent',
  }
  const maxSessionsHint = a.provider === 'openai-codex'
    ? 'OpenAI Codex treats this as a soft cap while quota headroom remains.'
    : 'Claude and other providers use this as the new-session capacity cap.'

  const planTypeOptions = a.provider === 'claude-official'
    ? [
        ['', 'Auto'],
        ['pro', 'Claude Pro'],
        ['max100', 'Claude Max 100'],
        ['max200', 'Claude Max 200'],
      ]
    : a.provider === 'openai-codex'
      ? [
          ['', 'Auto'],
          ['plus', 'OpenAI Plus'],
          ['pro100', 'OpenAI Pro 100'],
          ['pro200', 'OpenAI Pro 200'],
          ['team', 'OpenAI Team'],
          ['business', 'OpenAI Business'],
          ['enterprise', 'OpenAI Enterprise'],
          ['edu', 'OpenAI Edu'],
        ]
      : [
          ['', 'Auto'],
          ['pro', 'Pro'],
          ['team', 'Team'],
          ['enterprise', 'Enterprise'],
        ]

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Scheduler</div>
      <div className="flex items-center gap-2 flex-wrap">
        {states.map((s) => (
          <button
            key={s}
            onClick={() => stateMut.mutate(s)}
            disabled={stateMut.isPending}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              a.schedulerState === s
                ? activeStateClasses[s]
                : 'bg-bg-card border-border-default text-slate-400 hover:text-slate-200'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        {a.schedulerState === 'auto_blocked' && (
          <Badge tone="red">Auto-blocked: {formatAutoBlockedReason(a.autoBlockedReason)}</Badge>
        )}
      </div>
      {autoBlockedUntil && (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          解封时间：<span className="font-semibold text-red-100">{autoBlockedUntil}</span>
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-border-default">
        <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2" htmlFor="max-sessions-input">
          Max Sessions
        </label>
        <div className="flex gap-2 items-center max-sm:flex-col max-sm:items-stretch">
          <input
            id="max-sessions-input"
            type="number"
            min={1}
            step={1}
            value={maxSessionsInput}
            onChange={(event) => setMaxSessionsInput(event.target.value)}
            placeholder="Default"
            className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 w-40 max-sm:w-full"
          />
          <button
            onClick={() => maxSessionsMut.mutate()}
            disabled={!maxSessionsValid || !maxSessionsChanged || maxSessionsMut.isPending}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-500 transition-colors"
          >
            Save
          </button>
          <span className="text-xs text-slate-500">Current: {a.maxSessions ?? 'Default'}</span>
        </div>
        {!maxSessionsValid && <div className="mt-2 text-xs text-red-400">Use a positive integer, or leave empty for the default.</div>}
        <div className="mt-2 text-xs text-slate-500">{maxSessionsHint} Empty uses the server default.</div>
      </div>

      <div className="mt-4 pt-4 border-t border-border-default">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Plan Weight</div>
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <label className="text-xs text-slate-400">
            Plan Type
            <select
              value={planTypeInput}
              onChange={(event) => setPlanTypeInput(event.target.value)}
              className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200"
            >
              {planTypeOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Plan Multiplier
            <input
              type="number"
              min={0.01}
              step={0.1}
              value={planMultiplierInput}
              onChange={(event) => setPlanMultiplierInput(event.target.value)}
              placeholder="Auto"
              className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200"
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => planMut.mutate()}
            disabled={!planMultiplierValid || !planSettingsChanged || planMut.isPending}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-500 transition-colors"
          >
            Save Plan Weight
          </button>
          <span className="text-xs text-slate-500">Current: {a.planType ?? a.subscriptionType ?? 'auto'} / {a.planMultiplier ?? 'auto'}</span>
        </div>
        {!planMultiplierValid && <div className="mt-2 text-xs text-red-400">Use a positive number, or leave empty for automatic multiplier.</div>}
        <div className="mt-2 text-xs text-slate-500">Claude Code: pro, max100, max200. OpenAI: plus, pro100, pro200, team/business/enterprise. Higher multiplier receives proportionally more traffic before quota decay.</div>
      </div>
    </section>
  )
}

function RoutingGroupSection({ account: a, groups, toast, qc }: { account: Account; groups: RoutingGroup[]; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [selected, setSelected] = useState(a.routingGroupId ?? '')
  const changed = selected !== (a.routingGroupId ?? '')
  const groupType: 'anthropic' | 'openai' | 'google' =
    a.provider === 'openai-codex' || a.provider === 'openai-compatible'
      ? 'openai'
      : a.provider === 'google-gemini-oauth'
        ? 'google'
        : 'anthropic'
  const availableGroups = groups.filter((group) => group.type === groupType)

  const mut = useMutation({
    mutationFn: () => updateAccountSettings(a.id, { routingGroupId: selected }),
    onSuccess: () => {
      toast.success('Routing group updated')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Routing Group</div>
      <div className="flex gap-2 items-center">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 flex-1"
        >
          <option value="">Select {groupType} group</option>
          {availableGroups.map((g) => (
            <option key={g.id} value={g.id}>{g.name || g.id}{g.descriptionZh ? ` — ${g.descriptionZh}` : ''}</option>
          ))}
        </select>
        <button
          onClick={() => mut.mutate()}
          disabled={!changed || !selected || mut.isPending}
          className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-500 transition-colors"
        >
          Save
        </button>
      </div>
    </section>
  )
}

function ClaudeCompatibleModelSection({ account: a, toast, qc }: { account: Account; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [apiBaseUrl, setApiBaseUrl] = useState(a.apiBaseUrl ?? '')
  const [modelName, setModelName] = useState(a.modelName ?? '')
  const [opus, setOpus] = useState(a.modelTierMap?.opus ?? '')
  const [sonnet, setSonnet] = useState(a.modelTierMap?.sonnet ?? '')
  const [haiku, setHaiku] = useState(a.modelTierMap?.haiku ?? '')

  useEffect(() => {
    setApiBaseUrl(a.apiBaseUrl ?? '')
    setModelName(a.modelName ?? '')
    setOpus(a.modelTierMap?.opus ?? '')
    setSonnet(a.modelTierMap?.sonnet ?? '')
    setHaiku(a.modelTierMap?.haiku ?? '')
  }, [a.id, a.apiBaseUrl, a.modelName, a.modelTierMap?.opus, a.modelTierMap?.sonnet, a.modelTierMap?.haiku])

  const buildTierMap = () => {
    const o = opus.trim()
    const s = sonnet.trim()
    const h = haiku.trim()
    if (!o && !s && !h) return null
    return { opus: o || null, sonnet: s || null, haiku: h || null }
  }

  const trimmedBase = apiBaseUrl.trim()
  const trimmedModel = modelName.trim()
  const nextTierMap = buildTierMap()

  const baseChanged = trimmedBase !== (a.apiBaseUrl ?? '')
  const modelChanged = trimmedModel !== (a.modelName ?? '')
  const tierChanged =
    (nextTierMap?.opus ?? null) !== (a.modelTierMap?.opus ?? null) ||
    (nextTierMap?.sonnet ?? null) !== (a.modelTierMap?.sonnet ?? null) ||
    (nextTierMap?.haiku ?? null) !== (a.modelTierMap?.haiku ?? null)
  const changed = baseChanged || modelChanged || tierChanged
  const canSave = changed && trimmedModel.length > 0 && trimmedBase.length > 0

  const mut = useMutation({
    mutationFn: () => updateAccountSettings(a.id, {
      apiBaseUrl: trimmedBase,
      modelName: trimmedModel,
      modelTierMap: nextTierMap,
    }),
    onSuccess: () => {
      toast.success('Claude-compatible settings updated')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Claude-Compatible 模型映射</div>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-[11px] text-slate-400">API Base URL</span>
          <input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
            placeholder="https://api.deepseek.com/anthropic"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-400">默认上游模型（fallback）</span>
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
            placeholder="deepseek-chat"
          />
        </label>
        <div className="rounded-lg border border-border-default bg-bg-primary/40 p-3 space-y-2">
          <div className="text-[11px] text-slate-400">
            按 Claude 家族映射上游模型（可选）。客户端发 claude-opus-* 命中 Opus，claude-sonnet-* 命中 Sonnet，claude-haiku-* 命中 Haiku；留空走默认。
          </div>
          <label className="block">
            <span className="text-[11px] text-slate-400">Opus → 上游模型</span>
            <input
              value={opus}
              onChange={(e) => setOpus(e.target.value)}
              className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
              placeholder="deepseek-v4-pro"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Sonnet → 上游模型</span>
            <input
              value={sonnet}
              onChange={(e) => setSonnet(e.target.value)}
              className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
              placeholder="留空则用默认"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Haiku → 上游模型</span>
            <input
              value={haiku}
              onChange={(e) => setHaiku(e.target.value)}
              className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
              placeholder="deepseek-v4-flash"
            />
          </label>
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => mut.mutate()}
            disabled={!canSave || mut.isPending}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-500 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </section>
  )
}

type ModelMapEntry = { id: string; key: string; value: string }

function newEntryId() {
  return Math.random().toString(36).slice(2, 10)
}

function entriesFromMap(map: Record<string, string> | null | undefined): ModelMapEntry[] {
  if (!map) return []
  return Object.entries(map).map(([key, value]) => ({ id: newEntryId(), key, value }))
}

function entriesToMap(entries: ModelMapEntry[]): Record<string, string> | null {
  const map: Record<string, string> = {}
  for (const e of entries) {
    const k = e.key.trim()
    const v = e.value.trim()
    if (!k || !v) continue
    map[k] = v
  }
  return Object.keys(map).length > 0 ? map : null
}

function modelMapEqual(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

function OpenAICompatibleModelSection({ account: a, toast, qc }: { account: Account; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [apiBaseUrl, setApiBaseUrl] = useState(a.apiBaseUrl ?? '')
  const [modelName, setModelName] = useState(a.modelName ?? '')
  const [entries, setEntries] = useState<ModelMapEntry[]>(() => entriesFromMap(a.modelMap))

  const mapKey = a.modelMap ? Object.entries(a.modelMap).map(([k, v]) => `${k}=${v}`).sort().join(',') : ''

  useEffect(() => {
    setApiBaseUrl(a.apiBaseUrl ?? '')
    setModelName(a.modelName ?? '')
    setEntries(entriesFromMap(a.modelMap))
  }, [a.id, a.apiBaseUrl, a.modelName, mapKey])

  const trimmedBase = apiBaseUrl.trim()
  const trimmedModel = modelName.trim()
  const nextMap = entriesToMap(entries)

  const baseChanged = trimmedBase !== (a.apiBaseUrl ?? '')
  const modelChanged = trimmedModel !== (a.modelName ?? '')
  const mapChanged = !modelMapEqual(nextMap, a.modelMap ?? null)
  const changed = baseChanged || modelChanged || mapChanged
  const canSave = changed && trimmedBase.length > 0

  const mut = useMutation({
    mutationFn: () => updateAccountSettings(a.id, {
      apiBaseUrl: trimmedBase,
      modelName: trimmedModel || null,
      modelMap: nextMap,
    }),
    onSuccess: () => {
      toast.success('OpenAI-compatible settings updated')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">OpenAI-Compatible 模型映射</div>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-[11px] text-slate-400">API Base URL</span>
          <input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
            placeholder="https://token-plan-cn.xiaomimimo.com/v1"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-400">默认上游模型（fallback，可选）</span>
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            className="mt-1 w-full bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
            placeholder="mimo-v2.5-pro"
          />
        </label>
        <div className="rounded-lg border border-border-default bg-bg-primary/40 p-3 space-y-2">
          <div className="text-[11px] text-slate-400">
            客户端 model 别名 → 上游模型。客户端发什么 model 就精确匹配（如 codex CLI 发 gpt-5 → mimo-v2.5-pro）；未命中走默认 fallback。最多 64 条。
          </div>
          {entries.length === 0 && (
            <div className="text-[11px] text-slate-500 italic">尚无映射，点击下方添加。</div>
          )}
          {entries.map((entry, idx) => (
            <div key={entry.id} className="flex items-center gap-2">
              <input
                value={entry.key}
                onChange={(e) => setEntries((prev) => prev.map((p, i) => i === idx ? { ...p, key: e.target.value } : p))}
                className="flex-1 bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
                placeholder="客户端 model（如 gpt-5）"
              />
              <span className="text-slate-500">→</span>
              <input
                value={entry.value}
                onChange={(e) => setEntries((prev) => prev.map((p, i) => i === idx ? { ...p, value: e.target.value } : p))}
                className="flex-1 bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-slate-200"
                placeholder="上游 model（如 mimo-v2.5-pro）"
              />
              <button
                onClick={() => setEntries((prev) => prev.filter((_, i) => i !== idx))}
                className="px-2 py-1.5 text-xs text-red-400 hover:text-red-300 border border-border-default rounded-lg"
                title="删除该映射"
              >
                删
              </button>
            </div>
          ))}
          <button
            onClick={() => setEntries((prev) => [...prev, { id: newEntryId(), key: '', value: '' }])}
            disabled={entries.length >= 64}
            className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
          >
            + 添加映射
          </button>
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => mut.mutate()}
            disabled={!canSave || mut.isPending}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white disabled:opacity-50 hover:bg-indigo-500 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </section>
  )
}

function RateLimitSection({ accountId, protocol }: { accountId: string; protocol: string }) {
  const probe = useQuery({
    queryKey: ['ratelimit', accountId],
    queryFn: () => probeRateLimit(accountId),
    staleTime: 2 * 60 * 1000,
    enabled: false,
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Rate Limits</div>
        <button
          onClick={() => probe.refetch()}
          disabled={probe.isFetching}
          className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
        >
          {probe.isFetching ? 'Probing...' : probe.data ? 'Refresh' : 'Probe'}
        </button>
      </div>

      {!probe.data && !probe.isFetching && (
        <div className="text-sm text-slate-500">Click "Probe" to check rate limits.</div>
      )}
      {probe.error && (
        <div className="text-sm text-red-400">{(probe.error as Error).message}</div>
      )}
      {probe.data && <RateLimitDisplay data={probe.data} protocol={protocol} />}
    </section>
  )
}

function RateLimitDisplay({ data, protocol }: { data: RateLimitProbe; protocol: string }) {
  if (data.kind === 'claude-compatible-connectivity') {
    return <ClaudeCompatibleProbeDisplay data={data} />
  }

  if (Array.isArray(data.modelUsage) && data.modelUsage.length > 0) {
    return (
      <div className="space-y-3">
        {data.tokenStatus && !['ok', 'valid'].includes(data.tokenStatus) && (
          <Badge tone="red">Token: {data.tokenStatus}{data.refreshAttempted ? (data.refreshSucceeded ? ' (refreshed)' : ` (refresh failed: ${data.refreshError})`) : ''}</Badge>
        )}
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Model Usage</div>
        <div className="space-y-2">
          {data.modelUsage.map((item) => (
            <UtilBar
              key={item.label}
              label={item.label}
              pct={typeof item.utilization === 'number' ? item.utilization : 0}
              reset={typeof item.reset === 'string' ? item.reset : undefined}
            />
          ))}
        </div>
        {data.representativeClaim && (
          <div className="text-[10px] text-slate-500">Selected bucket: <span className="font-mono">{data.representativeClaim}</span></div>
        )}
        {typeof data.error === 'string' && <div className="text-xs text-red-400">{data.error}</div>}
        {data.probedAt && <div className="text-[10px] text-slate-500">Probed {timeAgo(data.probedAt)}</div>}
      </div>
    )
  }

  if (protocol === 'claude') {
    return (
      <div className="space-y-3">
        {data.tokenStatus && !['ok', 'valid'].includes(data.tokenStatus) && (
          <Badge tone="red">Token: {data.tokenStatus}{data.refreshAttempted ? (data.refreshSucceeded ? ' (refreshed)' : ` (refresh failed: ${data.refreshError})`) : ''}</Badge>
        )}
        {data.representativeClaim && (
          <div className="text-xs text-slate-400">Plan: <span className="text-slate-200">{data.representativeClaim}</span></div>
        )}
        {data.fiveHourUtilization != null && (
          <UtilBar label="5h" pct={data.fiveHourUtilization} status={data.fiveHourStatus} reset={data.fiveHourReset} />
        )}
        {data.sevenDayUtilization != null && (
          <UtilBar label="7d" pct={data.sevenDayUtilization} status={data.sevenDayStatus} reset={data.sevenDayReset} />
        )}
        {data.overageStatus && (
          <div className="text-xs text-slate-400">Overage: <span className="text-slate-200">{data.overageStatus}</span></div>
        )}
        {data.probedAt && <div className="text-[10px] text-slate-500">Probed {timeAgo(data.probedAt)}</div>}
      </div>
    )
  }

  const hasBars = data.fiveHourUtilization != null || data.sevenDayUtilization != null
  if (hasBars) {
    return (
      <div className="space-y-3">
        {data.fiveHourUtilization != null && (
          <UtilBar label="5h" pct={data.fiveHourUtilization} reset={data.fiveHourReset} />
        )}
        {data.sevenDayUtilization != null && (
          <UtilBar label="7d" pct={data.sevenDayUtilization} reset={data.sevenDayReset} />
        )}
        {typeof data.error === 'string' && <div className="text-xs text-red-400">{data.error}</div>}
        {data.probedAt && <div className="text-[10px] text-slate-500">Probed {timeAgo(data.probedAt)}</div>}
      </div>
    )
  }

  return (
    <div className="space-y-1 text-xs text-slate-400">
      {data.httpStatus && <div>HTTP Status: <span className="text-slate-200">{data.httpStatus}</span></div>}
      {Object.entries(data)
        .filter(([k]) => !['kind', 'httpStatus', 'probedAt', 'status'].includes(k))
        .map(([k, v]) => (
          <div key={k}>{k}: <span className="text-slate-200">{String(v)}</span></div>
        ))}
      {data.probedAt && <div className="text-[10px] text-slate-500 mt-2">Probed {timeAgo(data.probedAt)}</div>}
    </div>
  )
}

function ClaudeCompatibleProbeDisplay({ data }: { data: RateLimitProbe }) {
  const status = typeof data.status === 'string' ? data.status : 'unknown'
  const tone = claudeCompatibleStatusTone(status)
  const label = claudeCompatibleStatusLabel(status)
  const probedModel = typeof data.probedModel === 'string' ? data.probedModel : null
  const upstreamModel = typeof data.upstreamModel === 'string' ? data.upstreamModel : null
  const errorMessage = typeof data.errorMessage === 'string' ? data.errorMessage : null
  const durationMs = typeof data.durationMs === 'number' ? data.durationMs : null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">Connectivity</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400 max-md:grid-cols-1">
        {data.httpStatus != null && <div>HTTP Status: <span className="text-slate-200">{data.httpStatus}</span></div>}
        {durationMs != null && <div>Duration: <span className="text-slate-200">{durationMs} ms</span></div>}
        {probedModel && <div>Probed Model: <span className="text-slate-200 font-mono break-all">{probedModel}</span></div>}
        {upstreamModel && <div>Upstream Model: <span className="text-slate-200 font-mono break-all">{upstreamModel}</span></div>}
      </div>
      {errorMessage && <div className="text-xs text-red-400 break-all">{errorMessage}</div>}
      {data.probedAt && <div className="text-[10px] text-slate-500">Probed {timeAgo(data.probedAt)}</div>}
    </div>
  )
}

function claudeCompatibleStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'ok':
      return 'green'
    case 'reachable':
      return 'yellow'
    case 'auth_failed':
    case 'upstream_error':
    case 'connection_failed':
    case 'misconfigured':
      return 'red'
    default:
      return 'gray'
  }
}

function claudeCompatibleStatusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return '正常'
    case 'reachable':
      return '连通（请求被拒）'
    case 'auth_failed':
      return '鉴权失败'
    case 'upstream_error':
      return '上游错误'
    case 'connection_failed':
      return '连接失败'
    case 'misconfigured':
      return '配置错误'
    default:
      return status
  }
}

function UtilBar({ label, pct, status, reset }: { label: string; pct: number; status?: string; reset?: string }) {
  const color = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>{label} — {Math.round(pct)}%{status ? ` (${status})` : ''}</span>
        {reset && <span>Reset: {timeAgo(reset)}</span>}
      </div>
      <div className="h-2 bg-bg-card-raised rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

function OAuthLoginSection({ account: a, toast, qc }: { account: Account; toast: ReturnType<typeof useToast>; qc: ReturnType<typeof useQueryClient> }) {
  const [sessionId, setSessionId] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [code, setCode] = useState('')
  const [proxyUrl, setProxyUrl] = useState(a.proxyUrl ?? '')

  useEffect(() => {
    setProxyUrl(a.proxyUrl ?? '')
  }, [a.id, a.proxyUrl])

  const genMut = useMutation({
    mutationFn: () => generateAuthUrl(undefined, a.provider === 'openai-codex' ? 'openai-codex' : undefined),
    onSuccess: (data) => {
      setSessionId(data.sessionId)
      setAuthUrl(data.authUrl)
    },
    onError: (e) => toast.error(e.message),
  })

  const exMut = useMutation({
    mutationFn: () => exchangeCode(sessionId, code, '', a.id, { proxyUrl: proxyUrl || null }),
    onSuccess: () => {
      toast.success('OAuth tokens refreshed')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
      setAuthUrl('')
      setCode('')
    },
    onError: (e) => toast.error(e.message),
  })

  if (a.authMode !== 'oauth') return null

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">OAuth Re-Login</div>
      {!authUrl ? (
        <button
          onClick={() => genMut.mutate()}
          disabled={genMut.isPending}
          className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50"
        >
          {genMut.isPending ? 'Generating...' : 'Generate Auth URL'}
        </button>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Proxy for token exchange</span>
            <ProxySelect value={proxyUrl} onChange={setProxyUrl} />
          </label>
          <div className="flex gap-2 items-center">
            <a href={authUrl} target="_blank" rel="noopener" className="text-xs text-indigo-400 hover:underline truncate">{authUrl}</a>
            <button onClick={() => navigator.clipboard.writeText(authUrl)} className="text-xs text-slate-400 hover:text-slate-200 shrink-0">Copy</button>
          </div>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste callback URL or code"
              className="bg-bg-input border border-border-default rounded-lg px-3 py-1.5 text-sm text-slate-200 flex-1"
            />
            <button
              onClick={() => exMut.mutate()}
              disabled={!code || exMut.isPending}
              className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500 transition-colors duration-150 disabled:opacity-50"
            >
              Exchange
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function ActionsSection({ account: a, toast, qc, navigate }: {
  account: Account
  toast: ReturnType<typeof useToast>
  qc: ReturnType<typeof useQueryClient>
  navigate: ReturnType<typeof useNavigate>
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  const refreshMut = useMutation({
    mutationFn: () => refreshAccount(a.id),
    onSuccess: () => {
      toast.success('Account refreshed')
      qc.invalidateQueries({ queryKey: ['account', a.id] })
    },
    onError: (e) => toast.error(e.message),
  })

  const deleteMut = useMutation({
    mutationFn: () => deleteAccount(a.id),
    onSuccess: () => {
      toast.success('Account deleted')
      qc.invalidateQueries({ queryKey: ['accounts'] })
      navigate('/accounts')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Actions</div>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => refreshMut.mutate()}
          disabled={refreshMut.isPending}
          className="px-3 py-1.5 rounded-lg text-sm bg-bg-card-raised border border-border-default text-slate-200 hover:text-white"
        >
          Refresh Token
        </button>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
          >
            Delete Account
          </button>
        ) : (
          <div className="flex gap-2 items-center">
            <span className="text-xs text-red-400">Are you sure?</span>
            <button
              onClick={() => deleteMut.mutate()}
              disabled={deleteMut.isPending}
              className="px-3 py-1.5 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500"
            >
              Confirm Delete
            </button>
            <button onClick={() => setConfirmDelete(false)} className="text-xs text-slate-400 hover:text-slate-200">Cancel</button>
          </div>
        )}
      </div>
    </section>
  )
}

function AdvancedSection({ account: a }: { account: Account }) {
  const [open, setOpen] = useState(false)

  const fields = [
    ['ID', a.id],
    ['Provider', a.provider],
    ['Protocol', a.protocol],
    ['Auth Mode', a.authMode],
    ['Status', a.status ?? '—'],
    ['Proxy URL', a.proxyUrl ?? '—'],
    ['Direct Egress', a.directEgressEnabled ? 'Enabled' : 'Disabled'],
    ['Model', a.modelName ?? '—'],
    ['Opus → ', a.modelTierMap?.opus ?? '—'],
    ['Sonnet → ', a.modelTierMap?.sonnet ?? '—'],
    ['Haiku → ', a.modelTierMap?.haiku ?? '—'],
    ['API Base URL', a.apiBaseUrl ?? '—'],
    ['Login Password', a.loginPassword ? '***' : '—'],
    ['Last Error', a.lastError ?? '—'],
  ]

  return (
    <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
      <button onClick={() => setOpen(!open)} className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
        Advanced Details {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <div className="text-slate-500">{k}</div>
              <div className="text-slate-300 break-all">{v}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
