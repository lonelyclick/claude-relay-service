import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { getAccountHealthDistribution, getAccountRiskScores, getEgressRiskSummary, getLifecycleEvents, getLifecycleSummary, getNaturalCapacityConfig, getRiskEvents, getRiskSummary, getRiskTrends, refreshAccountRiskScores } from '~/api/risk'
import type { AccountHealthDistributionRow, AccountLifecycleEvent, AccountRiskScore, EgressRiskSummaryRow, RiskDashboardEvent, RiskDashboardTrendPoint } from '~/api/types'
import { Badge, type BadgeTone } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { cn } from '~/lib/cn'
import { fmtNum, fmtShanghaiDateTime, fmtTokens, isoDaysAgo, timeAgo, truncateMiddle } from '~/lib/format'

type RiskTab = 'scores' | 'events' | 'lifecycle' | 'distribution' | 'egress'

type Period = '1h' | '6h' | '24h' | '7d'

const periods: Array<{ id: Period; label: string; since: () => string }> = [
  { id: '1h', label: '1 Hour', since: () => new Date(Date.now() - 60 * 60 * 1000).toISOString() },
  { id: '6h', label: '6 Hours', since: () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() },
  { id: '24h', label: '24 Hours', since: () => isoDaysAgo(1) },
  { id: '7d', label: '7 Days', since: () => isoDaysAgo(7) },
]

const riskPaths = [
  { value: '', label: 'All paths' },
  { value: '/v1/messages', label: '/v1/messages' },
  { value: '/v1/sessions/ws', label: '/v1/sessions/ws' },
  { value: '/v1/chat/completions', label: '/v1/chat/completions' },
]

function riskTone(score: number): BadgeTone {
  if (score >= 100) return 'red'
  if (score >= 60) return 'orange'
  if (score > 0) return 'yellow'
  return 'gray'
}

function riskBandTone(band?: string | null): BadgeTone {
  if (band === 'critical') return 'red'
  if (band === 'cautious') return 'orange'
  if (band === 'watch') return 'yellow'
  if (band === 'safe') return 'green'
  return 'gray'
}

function statusTone(status?: number | null): BadgeTone {
  if (status == null) return 'gray'
  if (status < 300) return 'green'
  if (status === 429) return 'orange'
  if (status >= 400) return 'red'
  return 'yellow'
}

function compact(value?: string | null, length = 34): string {
  if (!value) return '—'
  return truncateMiddle(value, length)
}

export function RiskPage() {
  const [tab, setTab] = useState<RiskTab>('scores')
  const [period, setPeriod] = useState<Period>('24h')
  const [riskOnly, setRiskOnly] = useState(true)
  const [multiAccountOnly, setMultiAccountOnly] = useState(false)
  const [revokedOnly, setRevokedOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [path, setPath] = useState('')
  const [statusCode, setStatusCode] = useState('')
  const [minTokens, setMinTokens] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const since = useMemo(() => periods.find((item) => item.id === period)!.since(), [period])
  const statusNumber = statusCode.trim() ? Number(statusCode) : undefined
  const minTokensNumber = minTokens.trim() ? Number(minTokens) : undefined
  const queryValue = query.trim()

  const summary = useQuery({ queryKey: ['risk-summary', since], queryFn: () => getRiskSummary(since), refetchInterval: 30_000 })
  const naturalCapacityConfig = useQuery({ queryKey: ['natural-capacity-config'], queryFn: getNaturalCapacityConfig, refetchInterval: 60_000 })
  const trends = useQuery({
    queryKey: ['risk-trends', since, queryValue],
    queryFn: () => getRiskTrends({
      since,
      accountId: queryValue.startsWith('acct:') ? queryValue.slice(5).trim() : undefined,
    }),
    refetchInterval: 30_000,
  })

  const events = useQuery({
    queryKey: ['risk-events', since, riskOnly, multiAccountOnly, revokedOnly, queryValue, path, statusNumber, minTokensNumber],
    queryFn: () => getRiskEvents({
      since,
      limit: 120,
      riskOnly,
      multiAccountOnly,
      revokedOnly,
      path: path || undefined,
      statusCode: Number.isFinite(statusNumber) ? statusNumber : undefined,
      minTokens: Number.isFinite(minTokensNumber) ? minTokensNumber : undefined,
      userId: queryValue.startsWith('user:') ? queryValue.slice(5).trim() : undefined,
      accountId: queryValue.startsWith('acct:') ? queryValue.slice(5).trim() : undefined,
      sessionKey: queryValue.startsWith('session:') ? queryValue.slice(8).trim() : undefined,
      clientDeviceId: queryValue.startsWith('device:') ? queryValue.slice(7).trim() : undefined,
      ip: queryValue.startsWith('ip:') ? queryValue.slice(3).trim() : undefined,
    }),
    refetchInterval: 30_000,
  })

  if (summary.isLoading && tab === 'events') return <PageSkeleton />

  const s = summary.data
  const rows = events.data?.events ?? []
  const selected = rows.find((event) => event.usageRecordId === selectedId) ?? rows[0] ?? null

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4 max-lg:flex-col">
        <div>
          <div className="section-header mb-1">Risk Intelligence</div>
          <h1 className="text-xl font-semibold text-slate-100">Claude 风控分析台</h1>
          <p className="mt-1 text-sm text-slate-500">按账号、用户、设备、IP、session 和请求指纹筛选，重点追踪封禁前后的高风险模式。</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <div className="flex rounded-lg border border-border-default bg-bg-input p-0.5">
            <button
              onClick={() => setTab('scores')}
              className={cn('btn btn-sm border-0', tab === 'scores' ? 'btn-accent' : 'btn-secondary')}
            >
              Account Scores
            </button>
            <button
              onClick={() => setTab('events')}
              className={cn('btn btn-sm border-0', tab === 'events' ? 'btn-accent' : 'btn-secondary')}
            >
              Risk Events
            </button>
            <button
              onClick={() => setTab('lifecycle')}
              className={cn('btn btn-sm border-0', tab === 'lifecycle' ? 'btn-accent' : 'btn-secondary')}
            >
              Account Lifecycle
            </button>
            <button
              onClick={() => setTab('distribution')}
              className={cn('btn btn-sm border-0', tab === 'distribution' ? 'btn-accent' : 'btn-secondary')}
            >
              Health Distribution
            </button>
            <button
              onClick={() => setTab('egress')}
              className={cn('btn btn-sm border-0', tab === 'egress' ? 'btn-accent' : 'btn-secondary')}
            >
              Egress Risk
            </button>
          </div>
          {tab === 'events' &&
            periods.map((item) => (
              <button
                key={item.id}
                onClick={() => setPeriod(item.id)}
                className={cn('btn btn-sm', period === item.id ? 'btn-accent' : 'btn-secondary')}
              >
                {item.label}
              </button>
            ))}
        </div>
      </header>

      {tab === 'scores' && <AccountScoresPanel />}
      {tab === 'lifecycle' && <LifecyclePanel />}
      {tab === 'distribution' && <HealthDistributionPanel since={since} />}
      {tab === 'egress' && <EgressRiskPanel />}
      {tab === 'events' && (
      <>
      {summary.isError && <ErrorBanner title="风险摘要加载失败" error={summary.error} />}
      {events.isError && <ErrorBanner title="风险事件加载失败" error={events.error} />}
      {trends.isError && <ErrorBanner title="分钟趋势加载失败" error={trends.error} />}

      {s && (
        <div className="grid grid-cols-5 gap-3 max-xl:grid-cols-3 max-md:grid-cols-1">
          <StatCard value={fmtNum(s.totalEvents)} label="Claude Events" />
          <StatCard value={fmtNum(s.revoked403)} label="Revoked 403" />
          <StatCard value={fmtNum(s.multiAccountSessions)} label="Multi-account Sessions" />
          <StatCard value={fmtTokens(s.maxTokensPerUser)} label="Peak User Tokens" />
          <StatCard value={fmtNum(s.accountSwitches)} label="Session Switches" />
        </div>
      )}

      <NaturalCapacityCard config={naturalCapacityConfig.data ?? null} loading={naturalCapacityConfig.isFetching} />

      <RiskTrendPanel points={trends.data?.points ?? []} loading={trends.isFetching} />

      <section className="card space-y-3">
        <div className="grid grid-cols-[1.5fr_1fr_0.7fr_0.8fr] gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="user: / acct: / session: / device: / ip:"
          />
          <select className="input" value={path} onChange={(event) => setPath(event.target.value)}>
            {riskPaths.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <input className="input" value={statusCode} onChange={(event) => setStatusCode(event.target.value)} placeholder="Status" />
          <input className="input" value={minTokens} onChange={(event) => setMinTokens(event.target.value)} placeholder="Min tokens" />
        </div>
        <div className="flex gap-2 flex-wrap">
          <ToggleButton active={riskOnly} onClick={() => setRiskOnly(!riskOnly)}>只看风险</ToggleButton>
          <ToggleButton active={multiAccountOnly} onClick={() => setMultiAccountOnly(!multiAccountOnly)}>同 session 多账号</ToggleButton>
          <ToggleButton active={revokedOnly} onClick={() => setRevokedOnly(!revokedOnly)}>Claude revoked 403</ToggleButton>
          <button className="btn btn-sm btn-secondary" onClick={() => { setQuery(''); setPath(''); setStatusCode(''); setMinTokens(''); setRiskOnly(true); setMultiAccountOnly(false); setRevokedOnly(false) }}>Reset</button>
        </div>
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-4 max-xl:grid-cols-1">
        <section className="card p-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Events</div>
            <div className="text-xs text-slate-500">{events.isFetching ? 'Refreshing…' : `${fmtNum(events.data?.total ?? 0)} matched`}</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[980px]">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default bg-bg-card-raised/30">
                  <th className="text-left py-2 px-3">Risk</th>
                  <th className="text-left py-2 px-3">Time</th>
                  <th className="text-left py-2 px-3">User / Device</th>
                  <th className="text-left py-2 px-3">Session</th>
                  <th className="text-left py-2 px-3">Account</th>
                  <th className="text-right py-2 px-3">Tokens</th>
                  <th className="text-left py-2 px-3">HTTP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <tr
                    key={event.usageRecordId}
                    onClick={() => setSelectedId(event.usageRecordId)}
                    className={cn('border-b border-border-default/50 cursor-pointer hover:bg-bg-card-raised/50', selected?.usageRecordId === event.usageRecordId && 'bg-accent-muted/40')}
                  >
                    <td className="py-2 px-3"><Badge tone={riskTone(event.riskScore)}>{event.riskScore}</Badge></td>
                    <td className="py-2 px-3 text-slate-400"><div>{timeAgo(event.createdAt)}</div><div className="text-[10px] text-slate-600">{fmtShanghaiDateTime(event.createdAt)}</div></td>
                    <td className="py-2 px-3"><Mono>{compact(event.userId, 24)}</Mono><div className="text-[10px] text-slate-500">{compact(event.clientDeviceId, 28)}</div></td>
                    <td className="py-2 px-3"><Mono>{compact(event.sessionKey, 30)}</Mono>{event.sessionDistinctAccounts >= 2 && <div className="mt-1"><Badge tone="orange">{event.sessionDistinctAccounts} accounts</Badge></div>}</td>
                    <td className="py-2 px-3"><Mono>{compact(event.accountId, 28)}</Mono>{event.previousAccountId && event.previousAccountId !== event.accountId && <div className="text-[10px] text-amber-400">switched</div>}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{fmtTokens(event.totalTokens)}</td>
                    <td className="py-2 px-3"><Badge tone={statusTone(event.statusCode)}>{event.statusCode ?? '—'}</Badge><div className="text-[10px] text-slate-500">{event.path}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <div className="p-8 text-sm text-slate-500">没有匹配事件。可以放宽筛选或切到 7 Days。</div>}
        </section>

        <RiskDetail event={selected} />
      </div>
      </>
      )}
    </div>
  )
}

function AccountScoresPanel() {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const scores = useQuery({
    queryKey: ['account-risk-scores'],
    queryFn: () => getAccountRiskScores(false),
    refetchInterval: 60_000,
  })
  const accounts = scores.data?.accounts ?? []
  const selected = accounts.find((account) => account.accountId === selectedAccountId) ?? accounts[0] ?? null
  const stats = useMemo(() => {
    const initial = { safe: 0, watch: 0, cautious: 0, critical: 0 }
    for (const account of accounts) initial[account.band] += 1
    return initial
  }, [accounts])

  async function refreshScores() {
    setRefreshing(true)
    try {
      await refreshAccountRiskScores()
      await scores.refetch()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="card space-y-3">
        <div className="flex items-start justify-between gap-3 max-md:flex-col">
          <div>
            <div className="section-header mb-1">Account Risk Score</div>
            <h2 className="text-base font-semibold text-slate-100">账号风控信号集中度</h2>
            <p className="mt-1 text-xs text-slate-500">0-100 分，不是封禁概率；P0/P1/P2 当前只展示、记录趋势和 shadow 推荐，不改变真实调度。</p>
          </div>
          <button className="btn btn-sm btn-accent" disabled={refreshing || scores.isFetching} onClick={refreshScores}>
            {refreshing ? 'Scoring…' : 'Refresh scores'}
          </button>
        </div>
        <div className="grid grid-cols-5 gap-2 text-xs max-xl:grid-cols-3 max-md:grid-cols-1">
          <StatCard value={fmtNum(accounts.length)} label="Scored accounts" />
          <StatCard value={fmtNum(stats.safe)} label="Safe" />
          <StatCard value={fmtNum(stats.watch)} label="Watch" />
          <StatCard value={fmtNum(stats.cautious)} label="Cautious" />
          <StatCard value={fmtNum(stats.critical)} label="Critical" />
        </div>
      </section>

      {scores.isError && <ErrorBanner title="账号风控分加载失败" error={scores.error} />}

      <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-4 max-xl:grid-cols-1">
        <section className="card p-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Scores</div>
            <div className="text-xs text-slate-500">{scores.isFetching ? 'Refreshing…' : `${fmtNum(accounts.length)} accounts`}</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[920px]">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default bg-bg-card-raised/30">
                  <th className="text-left py-2 px-3">Score</th>
                  <th className="text-left py-2 px-3">Account</th>
                  <th className="text-left py-2 px-3">Shadow</th>
                  <th className="text-left py-2 px-3">Top factors</th>
                  <th className="text-left py-2 px-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr
                    key={account.accountId}
                    onClick={() => setSelectedAccountId(account.accountId)}
                    className={cn('border-b border-border-default/50 cursor-pointer hover:bg-bg-card-raised/50', selected?.accountId === account.accountId && 'bg-accent-muted/40')}
                  >
                    <td className="py-2 px-3"><Badge tone={riskBandTone(account.band)}>{account.score} · {account.band}</Badge><div className="text-[10px] text-slate-500">floor {account.floorScore}</div></td>
                    <td className="py-2 px-3">
                      <div className="text-slate-200">{account.label || account.emailAddress || '—'}</div>
                      <Mono>{compact(account.accountId, 42)}</Mono>
                    </td>
                    <td className="py-2 px-3">
                      {account.shadow.wouldAvoidNewSessions ? <Badge tone="orange">no new session</Badge> : account.shadow.wouldDeprioritize ? <Badge tone="yellow">deprioritize</Badge> : <Badge tone="green">none</Badge>}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex gap-1 flex-wrap">
                        {account.factors.slice(0, 3).map((factor) => <Badge key={factor.code} tone={factor.contribution >= 20 ? 'red' : factor.contribution >= 10 ? 'orange' : factor.contribution > 0 ? 'yellow' : 'green'}>{factor.code}: {factor.contribution > 0 ? '+' : ''}{factor.contribution}</Badge>)}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-slate-400"><div>{timeAgo(account.scoredAt)}</div><div className="text-[10px] text-slate-600">{fmtShanghaiDateTime(account.scoredAt)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {accounts.length === 0 && <div className="p-8 text-sm text-slate-500">暂无账号分数。点击 Refresh scores 生成第一批快照。</div>}
        </section>
        <AccountRiskDetail account={selected} />
      </div>
    </div>
  )
}

function AccountRiskDetail({ account }: { account: AccountRiskScore | null }) {
  if (!account) return <section className="card text-sm text-slate-500">选择一个账号查看扣分因子。</section>
  return (
    <section className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="section-header mb-1">Score Detail</div>
          <h3 className="text-base font-semibold text-slate-100">{account.score} / 100</h3>
          <div className="mt-1 text-sm text-slate-300">{account.label || account.emailAddress || '—'}</div>
          <div className="mt-1 text-xs text-slate-500"><Mono>{compact(account.accountId, 44)}</Mono></div>
        </div>
        <Badge tone={riskBandTone(account.band)}>{account.band}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Field label="Floor score" value={String(account.floorScore)} />
        <Field label="Last snapshot" value={fmtShanghaiDateTime(account.scoredAt)} />
      </div>
      {account.recommendedActions.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-300">Recommended actions (shadow)</div>
          {account.recommendedActions.map((action) => (
            <div key={action.code} className="rounded-lg border border-border-default bg-bg-input p-2 text-xs">
              <div className="font-semibold text-slate-200">{action.label}</div>
              <div className="mt-1 text-slate-500">{action.description}</div>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2 max-h-[560px] overflow-auto pr-1">
        {account.factors.map((factor) => (
          <div key={factor.code} className="rounded-lg border border-border-default bg-bg-input p-2 text-xs space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-slate-200">{factor.code}</span>
              <Badge tone={factor.contribution >= 20 ? 'red' : factor.contribution >= 10 ? 'orange' : factor.contribution > 0 ? 'yellow' : 'green'}>{factor.contribution > 0 ? '+' : ''}{factor.contribution}</Badge>
            </div>
            <div className="text-slate-500">{factor.description}</div>
            <div className="text-slate-600">category={factor.category} weight={factor.weight}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function HealthDistributionPanel({ since }: { since: string }) {
  const query = useQuery({
    queryKey: ['account-health-distribution', since],
    queryFn: () => getAccountHealthDistribution(since),
    refetchInterval: 60_000,
  })
  const rows = query.data?.accounts ?? []
  return (
    <section className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Account Health Distribution</div>
          <div className="text-xs text-slate-500 mt-1">按小时看活跃/静默分布，避免 24h 机器式持续流量。</div>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-bg-input text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Active/Quiet h</th>
              <th className="px-3 py-2 font-medium">Peak req/h</th>
              <th className="px-3 py-2 font-medium">Peak tokens/h</th>
              <th className="px-3 py-2 font-medium">Peak cache/h</th>
              <th className="px-3 py-2 font-medium">Total cache</th>
              <th className="px-3 py-2 font-medium">Errors</th>
              <th className="px-3 py-2 font-medium">Last</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {rows.map((row) => <HealthDistributionRow key={row.accountId} row={row} />)}
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No account usage in selected period.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function HealthDistributionRow({ row }: { row: AccountHealthDistributionRow }) {
  const quietTone: BadgeTone = row.quietHours >= 6 ? 'green' : row.quietHours >= 3 ? 'yellow' : 'orange'
  return (
    <tr className="hover:bg-bg-input/40">
      <td className="px-3 py-2">
        <Link to={`/accounts/${encodeURIComponent(row.accountId)}`} className="text-slate-200 hover:text-white">{row.label || row.emailAddress || compact(row.accountId)}</Link>
        <div className="font-mono text-[10px] text-slate-500">{compact(row.accountId, 28)}</div>
      </td>
      <td className="px-3 py-2"><Badge tone={quietTone}>{row.activeHours}/{row.quietHours}</Badge></td>
      <td className="px-3 py-2 text-slate-300">{fmtNum(row.peakRequestsHour)}</td>
      <td className="px-3 py-2 text-slate-300">{fmtTokens(row.peakTokensHour)}</td>
      <td className="px-3 py-2 text-slate-300">{fmtTokens(row.peakCacheReadHour)}</td>
      <td className="px-3 py-2 text-slate-300">{fmtTokens(row.totalCacheReadTokens)}</td>
      <td className="px-3 py-2"><Badge tone={row.errors > 0 ? 'orange' : 'gray'}>{row.errors}</Badge></td>
      <td className="px-3 py-2 text-slate-500">{row.lastHour ? timeAgo(row.lastHour) : '—'}</td>
    </tr>
  )
}

function EgressRiskPanel() {
  const query = useQuery({
    queryKey: ['egress-risk-summary'],
    queryFn: getEgressRiskSummary,
    refetchInterval: 60_000,
  })
  const rows = query.data?.egress ?? []
  return (
    <section className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-orange-300">Egress Risk</div>
          <div className="text-xs text-slate-500 mt-1">按出口/proxy 聚合账号数、30d 风险错误和封禁痕迹；当前只观察不自动动作。</div>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <div className="grid gap-3 p-4">
        {rows.map((row) => <EgressRiskCard key={row.egressKey} row={row} />)}
        {rows.length === 0 && <div className="text-sm text-slate-500">No egress data.</div>}
      </div>
    </section>
  )
}

function EgressRiskCard({ row }: { row: EgressRiskSummaryRow }) {
  const tone: BadgeTone = row.disabledAccounts > 0 ? 'red' : row.riskErrors30d > 0 ? 'orange' : 'green'
  return (
    <div className="rounded-xl border border-border-default bg-bg-input p-3">
      <div className="flex items-start justify-between gap-3 max-md:flex-col">
        <div className="min-w-0">
          <div className="font-mono text-xs text-slate-200 break-all">{row.egressKey}</div>
          <div className="mt-1 text-[11px] text-slate-500">last used {row.lastUsedAt ? timeAgo(row.lastUsedAt) : '—'}</div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Badge tone="gray">accounts {row.accountCount}</Badge>
          <Badge tone={tone}>disabled {row.disabledAccounts}</Badge>
          <Badge tone={row.riskErrors30d > 0 ? 'orange' : 'gray'}>risk errors {row.riskErrors30d}</Badge>
          <Badge tone={row.overageDisabled30d > 0 ? 'yellow' : 'gray'}>overage {row.overageDisabled30d}</Badge>
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-slate-400">Accounts</summary>
        <div className="mt-2 grid gap-1.5">
          {row.accounts.slice(0, 12).map((account) => (
            <div key={account.accountId} className="flex items-center justify-between gap-3 rounded bg-bg-card/60 px-2 py-1 text-xs">
              <Link to={`/accounts/${encodeURIComponent(account.accountId)}`} className="text-slate-300 hover:text-white truncate">{account.label || account.emailAddress || compact(account.accountId)}</Link>
              <div className="flex gap-2 shrink-0 text-slate-500">
                <span>req {account.requests30d}</span>
                <span>err {account.riskErrors30d}</span>
                <span>{account.accountStatus ?? '—'}</span>
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}


function LifecyclePanel() {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('')

  const summary = useQuery({
    queryKey: ['lifecycle-summary'],
    queryFn: () => getLifecycleSummary(150),
    refetchInterval: 30_000,
  })

  const events = useQuery({
    queryKey: ['lifecycle-events', selectedAccountId, eventTypeFilter],
    queryFn: () =>
      getLifecycleEvents({
        accountId: selectedAccountId ?? undefined,
        eventTypes: eventTypeFilter ? [eventTypeFilter] : undefined,
        limit: 200,
      }),
    refetchInterval: 30_000,
  })

  const accounts = summary.data?.accounts ?? []
  const rows = events.data?.events ?? []
  const selectedAccount =
    accounts.find((account) => account.accountId === selectedAccountId) ?? accounts[0] ?? null

  const stats = useMemo(() => {
    if (accounts.length === 0) return null
    let added = 0
    let firstReq = 0
    let revoked = 0
    let withinHour = 0
    let withinDay = 0
    for (const account of accounts) {
      if (account.addedAt) added += 1
      if (account.firstRealRequestAt) firstReq += 1
      if (account.revokedAt) {
        revoked += 1
        if (account.addedAt) {
          const delta = new Date(account.revokedAt).getTime() - new Date(account.addedAt).getTime()
          if (delta <= 60 * 60 * 1000) withinHour += 1
          if (delta <= 24 * 60 * 60 * 1000) withinDay += 1
        }
      }
    }
    return { added, firstReq, revoked, withinHour, withinDay }
  }, [accounts])

  return (
    <div className="space-y-5">
      {stats && (
        <div className="grid grid-cols-5 gap-3 max-xl:grid-cols-3 max-md:grid-cols-1">
          <StatCard value={fmtNum(stats.added)} label="Tracked accounts" />
          <StatCard value={fmtNum(stats.firstReq)} label="With first request" />
          <StatCard value={fmtNum(stats.revoked)} label="Revoked / disabled" />
          <StatCard value={fmtNum(stats.withinHour)} label="Banned ≤ 1h" />
          <StatCard value={fmtNum(stats.withinDay)} label="Banned ≤ 24h" />
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 max-xl:grid-cols-1">
        <section className="card p-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Accounts</div>
            <div className="text-xs text-slate-500">
              {summary.isFetching ? 'Refreshing…' : `${fmtNum(accounts.length)} accounts`}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default bg-bg-card-raised/30">
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Account</th>
                  <th className="text-left py-2 px-3">Warmup</th>
                  <th className="text-left py-2 px-3">Added</th>
                  <th className="text-left py-2 px-3">First request</th>
                  <th className="text-left py-2 px-3">Revoked / Failure</th>
                  <th className="text-right py-2 px-3">Probes</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const tone: BadgeTone = account.revokedAt
                    ? 'red'
                    : account.terminalAt
                      ? 'orange'
                      : account.firstRealRequestAt
                        ? 'green'
                        : 'gray'
                  const label = account.revokedAt
                    ? 'revoked'
                    : account.terminalAt
                      ? 'terminal'
                      : account.firstRealRequestAt
                        ? 'active'
                        : 'pending'
                  const isSelected = (selectedAccount?.accountId ?? null) === account.accountId
                  return (
                    <tr
                      key={account.accountId}
                      onClick={() => setSelectedAccountId(account.accountId)}
                      className={cn(
                        'border-b border-border-default/50 cursor-pointer hover:bg-bg-card-raised/50',
                        isSelected && 'bg-accent-muted/40',
                      )}
                    >
                      <td className="py-2 px-3"><Badge tone={tone}>{label}</Badge></td>
                      <td className="py-2 px-3"><Mono>{compact(account.emailAddress ?? account.accountId, 32)}</Mono><div className="text-[10px] text-slate-600">{compact(account.accountId, 32)}</div></td>
                      <td className="py-2 px-3 text-xs"><WarmupBadge warmup={account.warmup} /></td>
                      <td className="py-2 px-3 text-slate-400 text-xs">
                        {account.addedAt ? <div>{timeAgo(account.addedAt)}</div> : '—'}
                        {account.addedAt && (
                          <div className="text-[10px] text-slate-600">{fmtShanghaiDateTime(account.addedAt)}</div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-slate-400 text-xs">
                        {account.firstRealRequestAt ? (
                          <>
                            <div>{timeAgo(account.firstRealRequestAt)}</div>
                            {account.addedAt && (
                              <div className="text-[10px] text-slate-600">
                                +{fmtRelativeDuration(account.addedAt, account.firstRealRequestAt)}
                              </div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        {account.revokedAt || account.terminalAt ? (
                          <>
                            <div className="text-slate-400">
                              {timeAgo((account.revokedAt ?? account.terminalAt) as string)}
                            </div>
                            {account.addedAt && (
                              <div className="text-[10px] text-amber-400">
                                +{fmtRelativeDuration(account.addedAt, (account.revokedAt ?? account.terminalAt) as string)}
                              </div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-300">{fmtNum(account.probeCount)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {accounts.length === 0 && (
            <div className="p-8 text-sm text-slate-500">还没有账号生命周期事件。新增账号后会自动出现。</div>
          )}
        </section>

        <section className="card space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="section-header mb-1">Selected account events</div>
              <Mono>{compact(selectedAccount?.accountId ?? null, 48)}</Mono>
            </div>
            <select
              className="input max-w-[200px]"
              value={eventTypeFilter}
              onChange={(event) => setEventTypeFilter(event.target.value)}
            >
              <option value="">All event types</option>
              <option value="account_added">account_added</option>
              <option value="oauth_exchanged">oauth_exchanged</option>
              <option value="session_key_login">session_key_login</option>
              <option value="token_imported">token_imported</option>
              <option value="compatible_account_added">compatible_account_added</option>
              <option value="onboarding_probe_started">onboarding_probe_started</option>
              <option value="onboarding_probe_completed">onboarding_probe_completed</option>
              <option value="rate_limit_probe">rate_limit_probe</option>
              <option value="first_real_request">first_real_request</option>
              <option value="terminal_failure">terminal_failure</option>
              <option value="claude_org_revoked">claude_org_revoked</option>
            </select>
          </div>

          {selectedAccount && (
            <div className="space-y-3">
              <WarmupDetail account={selectedAccount} />
              <div className="grid grid-cols-3 gap-2 text-xs max-md:grid-cols-1">
                <Field label="Added" value={selectedAccount.addedAt ? fmtShanghaiDateTime(selectedAccount.addedAt) : '—'} />
                <Field
                  label="First request"
                  value={selectedAccount.firstRealRequestAt ? fmtShanghaiDateTime(selectedAccount.firstRealRequestAt) : '—'}
                />
                <Field
                  label="Revoked"
                  value={selectedAccount.revokedAt ? fmtShanghaiDateTime(selectedAccount.revokedAt) : '—'}
                />
              </div>
            </div>
          )}

          <div className="space-y-2 max-h-[640px] overflow-auto">
            {rows.map((row) => (
              <LifecycleEventCard key={row.id} event={row} />
            ))}
            {rows.length === 0 && (
              <div className="p-6 text-sm text-slate-500 text-center">没有匹配事件。</div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}


function NaturalCapacityCard({
  config,
  loading,
}: {
  config: import('~/api/risk').NaturalCapacityConfig | null
  loading: boolean
}) {
  return (
    <section className="card space-y-3">
      <div className="flex items-start justify-between gap-3 max-md:flex-col">
        <div>
          <div className="section-header mb-1">Natural Capacity</div>
          <h2 className="text-base font-semibold text-slate-100">Claude 官方账号自然化容量管理</h2>
          <p className="mt-1 text-xs text-slate-500">新号只接新 session，成熟号承接重任务；用户/设备默认固定账号池位，避免短时间跨太多官方账号。</p>
        </div>
        <Badge tone={config?.enabled ? 'green' : 'gray'}>{loading ? 'loading' : config?.enabled ? 'enabled' : 'disabled'}</Badge>
      </div>
      <div className="grid grid-cols-5 gap-2 text-xs max-xl:grid-cols-3 max-md:grid-cols-1">
        <Field label="24h 跨账号上限" value={config ? `${config.userDeviceMaxAccounts24h} official accounts` : '—'} />
        <Field label="新号只接新 session" value={config ? `${config.newAccountNewSessionOnlyHours}h` : '—'} />
        <Field label="重任务成熟号年龄" value={config ? `${config.heavySessionAccountMinAgeHours}h` : '—'} />
        <Field label="重任务 tokens" value={config ? fmtTokens(config.heavySessionTokens) : '—'} />
        <Field label="重 cache read" value={config ? fmtTokens(config.heavySessionCacheReadTokens) : '—'} />
      </div>
      <div className="text-xs text-slate-500">
        调控入口：服务端环境变量 <span className="font-mono text-slate-400">CLAUDE_OFFICIAL_USER_DEVICE_MAX_ACCOUNTS_24H</span>，默认 3；需要即时调整时改 env 后重启 relay/server。
      </div>
    </section>
  )
}


function WarmupBadge({ warmup }: { warmup?: import('~/api/types').ClaudeWarmupStatus | null }) {
  if (!warmup) return <Badge tone="gray">unknown</Badge>
  if (warmup.disabledReason === 'manual_disabled') return <Badge tone="gray">Warmup off</Badge>
  if (!warmup.enabled && !warmup.graduated) return <Badge tone="gray">N/A</Badge>
  const tone: BadgeTone = warmup.graduated ? 'green' : warmup.stage.id.startsWith('new_0') || warmup.stage.id.startsWith('new_2') || warmup.stage.id.startsWith('new_12') ? 'red' : warmup.stage.id.startsWith('new_') ? 'orange' : 'yellow'
  return (
    <div className="space-y-1">
      <Badge tone={tone}>{warmup.policyLabel ? `${warmup.policyLabel} · ${warmup.stage.label}` : warmup.stage.label}</Badge>
      <div className="text-[10px] text-slate-500">age {formatMs(warmup.effectiveAgeMs)}</div>
    </div>
  )
}

function WarmupDetail({ account }: { account: import('~/api/types').AccountLifecycleSummary }) {
  const warmup = account.warmup
  if (!warmup) return null
  if (warmup.disabledReason === 'manual_disabled') {
    return (
      <div className="rounded-xl border border-border-default bg-bg-input p-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-slate-300">Warmup policy</div>
            <div className="mt-1 text-sm text-slate-100">Warmup manually disabled</div>
            <div className="mt-1 text-xs text-slate-500">该账号 onboarding 时关闭了新号防风控限速；仍会保留全局风控与生命周期日志。</div>
          </div>
          <Badge tone="gray">off</Badge>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs max-md:grid-cols-1">
          <Field label="Effective age" value={formatMs(warmup.effectiveAgeMs)} />
          <Field label="Claude account age" value={formatMs(warmup.accountAgeMs)} />
          <Field label="Connected age" value={formatMs(warmup.connectedAgeMs)} />
        </div>
      </div>
    )
  }
  if (!warmup.enabled && !warmup.graduated) return null
  const limits = warmup.stage
  return (
    <div className="rounded-xl border border-border-default bg-bg-input p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-slate-300">Warmup policy</div>
          <div className="mt-1 text-sm text-slate-100">{warmup.policyLabel ? `${warmup.policyLabel} · ${limits.label}` : limits.label}</div>
          <div className="mt-1 text-xs text-slate-500">{limits.description}</div>
        </div>
        <Badge tone={warmup.graduated ? 'green' : 'orange'}>{warmup.graduated ? 'graduated' : 'limited'}</Badge>
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs max-md:grid-cols-2">
        <Field label="RPM" value={formatLimit(limits.rpm)} />
        <Field label="Tokens/min" value={formatLimit(limits.tokensPerMinute)} />
        <Field label="CacheRead/min" value={formatLimit(limits.cacheReadPerMinute)} />
        <Field label="Single request" value={formatLimit(limits.singleRequestTokens)} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs max-md:grid-cols-1">
        <Field label="Effective age" value={formatMs(warmup.effectiveAgeMs)} />
        <Field label="Claude account age" value={formatMs(warmup.accountAgeMs)} />
        <Field label="Connected age" value={formatMs(warmup.connectedAgeMs)} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs max-md:grid-cols-1">
        <DetailLine label="Email" value={account.emailAddress} />
        <DetailLine label="Org" value={account.organizationUuid} />
        <DetailLine label="Plan" value={account.subscriptionType} />
        <DetailLine label="Tier" value={account.rateLimitTier} />
        <DetailLine label="Scheduler" value={account.schedulerState} />
        <DetailLine label="Blocked" value={formatBlockedReason(account.autoBlockedReason)} />
      </div>
    </div>
  )
}


function formatBlockedReason(reason?: string | null): string {
  if (!reason) return '—'
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
    .map((item) => item.replace('=', ' '))
    .join(', ')
  return `Warmup auto-block: ${fields.get('stageLabel') ?? fields.get('stage') ?? 'unknown'}; ${triggered ?? 'unknown trigger'}`
}

function formatMs(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ${min % 60}m`
  const day = Math.floor(hr / 24)
  if (day < 90) return `${day}d ${hr % 24}h`
  return `${Math.floor(day / 30)}mo ${day % 30}d`
}

function formatLimit(value: number): string {
  if (value >= Number.MAX_SAFE_INTEGER / 2) return 'unlimited'
  return fmtTokens(value)
}

function LifecycleEventCard({ event }: { event: AccountLifecycleEvent }) {
  const tone: BadgeTone =
    event.outcome === 'failure'
      ? 'red'
      : event.outcome === 'ok'
        ? 'green'
        : 'gray'
  return (
    <div className="rounded-lg border border-border-default bg-bg-input p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={tone}>{event.eventType}</Badge>
          {event.upstreamStatus && (
            <Badge tone={event.upstreamStatus >= 400 ? 'red' : 'gray'}>{event.upstreamStatus}</Badge>
          )}
        </div>
        <div className="text-slate-500">{fmtShanghaiDateTime(event.occurredAt)}</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <DetailLine label="Ingress" value={event.ingressIp} />
        <DetailLine label="UA" value={event.ingressUserAgent} />
        <DetailLine label="X-Forwarded" value={event.ingressForwardedFor} />
        <DetailLine label="Egress" value={event.egressProxyUrl} />
        <DetailLine label="Provider" value={event.egressProvider} />
        <DetailLine label="Anthropic org" value={event.upstreamOrganizationId} />
        <DetailLine label="Tier" value={event.upstreamRateLimitTier} />
        <DetailLine label="Request id" value={event.upstreamRequestId} />
      </div>
      {event.anthropicHeaders && Object.keys(event.anthropicHeaders).length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-slate-500">Anthropic headers</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg-card-raised/30 p-2 text-[11px] text-slate-400 whitespace-pre-wrap break-words">
            {JSON.stringify(event.anthropicHeaders, null, 2)}
          </pre>
        </details>
      )}
      {event.notes && Object.keys(event.notes).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-slate-500">Notes</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg-card-raised/30 p-2 text-[11px] text-slate-400 whitespace-pre-wrap break-words">
            {JSON.stringify(event.notes, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}

function fmtRelativeDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ${min % 60}m`
  const day = Math.floor(hr / 24)
  return `${day}d ${hr % 24}h`
}

function ErrorBanner({ title, error }: { title: string; error: unknown }) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      <div className="font-semibold">{title}</div>
      <div className="mt-1 text-xs text-red-200/80">{message}</div>
    </div>
  )
}

function RiskTrendPanel({ points, loading }: { points: RiskDashboardTrendPoint[]; loading: boolean }) {
  const maxRequests = Math.max(1, ...points.map((point) => point.requests))
  const maxTokens = Math.max(1, ...points.map((point) => point.tokens))
  const latest = points[points.length - 1] ?? null
  const peak = points.reduce<RiskDashboardTrendPoint | null>((current, point) => {
    if (!current || point.tokens > current.tokens) return point
    return current
  }, null)
  const sampled = points.length > 90
    ? points.filter((_, index) => index % Math.ceil(points.length / 90) === 0)
    : points

  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="section-header mb-1">Minute Buckets</div>
          <h2 className="text-base font-semibold text-slate-100">分钟级风险曲线</h2>
          <p className="text-xs text-slate-500">RPM、tokens/min、cacheRead/min、distinct accounts、org id 和 overage disabled reason。</p>
        </div>
        <div className="text-xs text-slate-500">{loading ? 'Refreshing…' : `${fmtNum(points.length)} buckets`}</div>
      </div>
      <div className="grid grid-cols-5 gap-2 max-xl:grid-cols-3 max-md:grid-cols-1">
        <MiniMetric label="Latest RPM" value={latest ? fmtNum(latest.requests) : '—'} />
        <MiniMetric label="Latest tokens/min" value={latest ? fmtTokens(latest.tokens) : '—'} />
        <MiniMetric label="Latest cacheRead/min" value={latest ? fmtTokens(latest.cacheReadTokens) : '—'} />
        <MiniMetric label="Peak tokens/min" value={peak ? fmtTokens(peak.tokens) : '—'} />
        <MiniMetric label="Distinct accounts" value={latest ? fmtNum(latest.distinctAccounts) : '—'} />
      </div>
      <div className="h-28 flex items-end gap-1 rounded-xl border border-border-default bg-bg-input p-3 overflow-hidden">
        {sampled.length === 0 ? (
          <div className="text-xs text-slate-500 self-center mx-auto">暂无分钟趋势数据</div>
        ) : sampled.map((point) => {
          const requestHeight = Math.max(4, Math.round((point.requests / maxRequests) * 92))
          const tokenHeight = Math.max(4, Math.round((point.tokens / maxTokens) * 92))
          return (
            <div key={point.minute} className="flex-1 min-w-[3px] flex items-end gap-[1px]" title={`${fmtShanghaiDateTime(point.minute)} RPM=${point.requests} tokens=${point.tokens} cacheRead=${point.cacheReadTokens} accounts=${point.distinctAccounts}`}>
              <div className="w-1/2 rounded-t bg-indigo-400/70" style={{ height: `${requestHeight}px` }} />
              <div className="w-1/2 rounded-t bg-amber-400/70" style={{ height: `${tokenHeight}px` }} />
            </div>
          )
        })}
      </div>
      {latest && (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-xs">
          <div className="text-slate-600">Latest org ids</div>
          <div className="font-mono text-slate-300 break-all">{latest.organizationIds.length ? latest.organizationIds.join(', ') : '—'}</div>
          <div className="text-slate-600">Overage disabled</div>
          <div className="font-mono text-slate-300 break-all">{latest.overageDisabledReasons.length ? latest.overageDisabledReasons.join(', ') : '—'}</div>
        </div>
      )}
    </section>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-input p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-600">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-100">{value}</div>
    </div>
  )
}

function ToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={cn('btn btn-sm', active ? 'btn-accent' : 'btn-secondary')} onClick={onClick}>{children}</button>
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11px] text-slate-300">{children}</span>
}

function RiskDetail({ event }: { event: RiskDashboardEvent | null }) {
  if (!event) {
    return <aside className="card text-sm text-slate-500">选择一条事件查看完整指纹。</aside>
  }

  const requestHref = event.userId
    ? `/users/${encodeURIComponent(event.userId)}/requests/${encodeURIComponent(event.requestId)}?usageRecordId=${event.usageRecordId}`
    : null

  return (
    <aside className="card space-y-4 xl:sticky xl:top-16 xl:self-start">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="section-header mb-1">Selected Event</div>
          <div className="font-mono text-xs text-slate-300 break-all">{event.requestId}</div>
          <div className="text-[11px] text-slate-600 mt-1">usage #{event.usageRecordId}</div>
        </div>
        <Badge tone={riskTone(event.riskScore)}>risk {event.riskScore}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Field label="Status" value={String(event.statusCode ?? '—')} />
        <Field label="Path" value={event.path} />
        <Field label="Tokens" value={fmtTokens(event.totalTokens)} />
        <Field label="Duration" value={event.durationMs != null ? `${event.durationMs}ms` : '—'} />
        <Field label="IP" value={event.ip ?? '—'} />
        <Field label="x-app" value={event.xApp ?? '—'} />
      </div>

      <div className="space-y-2">
        <DetailLine label="User" value={event.userId} />
        <DetailLine label="Device" value={event.clientDeviceId} />
        <DetailLine label="Session" value={event.sessionKey} />
        <DetailLine label="Account" value={event.accountId} />
        <DetailLine label="Previous" value={event.previousAccountId} />
        <DetailLine label="User accts" value={String(event.userDistinctAccounts ?? 0)} />
        <DetailLine label="Device accts" value={String(event.deviceDistinctAccounts ?? 0)} />
        <DetailLine label="Session accts" value={String(event.sessionDistinctAccounts ?? 0)} />
        <DetailLine label="Model" value={event.model} />
      </div>

      <section className="space-y-2">
        <div className="text-xs font-semibold text-slate-400">Claude fingerprint</div>
        <div className="rounded-lg bg-bg-input border border-border-default p-3 space-y-2 text-xs">
          <DetailLine label="anthropic-beta" value={event.anthropicBeta} />
          <DetailLine label="anthropic-ver" value={event.anthropicVersion} />
          <DetailLine label="cc-session" value={event.claudeCodeSessionId} />
          <DetailLine label="direct-browser" value={event.directBrowserAccess} />
          <DetailLine label="upstream-beta" value={event.upstreamAnthropicBeta} />
          <DetailLine label="UA" value={event.userAgent} />
        </div>
      </section>

      {event.requestPreview && (
        <section className="space-y-2">
          <div className="text-xs font-semibold text-slate-400">Request preview</div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-bg-input border border-border-default p-3 text-[11px] text-slate-400 whitespace-pre-wrap break-words">{event.requestPreview}</pre>
        </section>
      )}

      {event.responsePreview && (
        <section className="space-y-2">
          <div className="text-xs font-semibold text-slate-400">Response preview</div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-bg-input border border-border-default p-3 text-[11px] text-slate-400 whitespace-pre-wrap break-words">{event.responsePreview}</pre>
        </section>
      )}

      {event.responseHeaders != null && (
        <section className="space-y-2">
          <div className="text-xs font-semibold text-slate-400">Response headers</div>
          <pre className="max-h-32 overflow-auto rounded-lg bg-bg-input border border-border-default p-3 text-[11px] text-slate-500 whitespace-pre-wrap break-words">{JSON.stringify(event.responseHeaders, null, 2)}</pre>
        </section>
      )}

      <div className="flex gap-2 flex-wrap">
        {event.userId && <Link className="btn btn-sm btn-secondary" to={`/users/${encodeURIComponent(event.userId)}`}>Open user</Link>}
        {requestHref && <Link className="btn btn-sm btn-accent" to={requestHref}>Request detail</Link>}
      </div>
    </aside>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-bg-input border border-border-default p-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-600">{label}</div>
      <div className="mt-0.5 text-slate-300 break-all">{value}</div>
    </div>
  )
}

function DetailLine({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 text-xs">
      <div className="text-slate-600">{label}</div>
      <div className="font-mono text-[11px] text-slate-300 break-all">{value || '—'}</div>
    </div>
  )
}
