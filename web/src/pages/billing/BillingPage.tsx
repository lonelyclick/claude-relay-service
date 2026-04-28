import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  createBillingRule,
  deleteBillingRule,
  getBillingSummary,
  getBillingUsers,
  listBillingRules,
  rebuildBilling,
  syncBilling,
  updateBillingRule,
} from '~/api/billing'
import type { BillingCurrency, BillingRule } from '~/api/types'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, fmtNum, fmtTokens, isoDaysAgo, timeAgo } from '~/lib/format'

type Period = '7d' | '30d' | '90d' | 'all'

type RuleFormState = {
  name: string
  currency: BillingCurrency
  provider: string
  accountId: string
  userId: string
  model: string
  priority: string
  effectiveFrom: string
  effectiveTo: string
  inputPriceMicrosPerMillion: string
  outputPriceMicrosPerMillion: string
  cacheCreationPriceMicrosPerMillion: string
  cacheReadPriceMicrosPerMillion: string
  isActive: boolean
}

const periods: { id: Period; label: string; days: number | null }[] = [
  { id: '7d', label: '7 Days', days: 7 },
  { id: '30d', label: '30 Days', days: 30 },
  { id: '90d', label: '90 Days', days: 90 },
  { id: 'all', label: 'All Time', days: null },
]

const billingCurrencies: BillingCurrency[] = ['CNY', 'USD']

function toLocalInputValue(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return ''
  }
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function fromLocalInputValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  const date = new Date(trimmed)
  if (!Number.isFinite(date.getTime())) {
    return undefined
  }
  return date.toISOString()
}

function buildEmptyRuleForm(currency: BillingCurrency): RuleFormState {
  return {
    name: '',
    currency,
    provider: '',
    accountId: '',
    userId: '',
    model: '',
    priority: '0',
    effectiveFrom: toLocalInputValue(new Date().toISOString()),
    effectiveTo: '',
    inputPriceMicrosPerMillion: '0',
    outputPriceMicrosPerMillion: '0',
    cacheCreationPriceMicrosPerMillion: '0',
    cacheReadPriceMicrosPerMillion: '0',
    isActive: true,
  }
}

function buildRuleForm(rule: BillingRule): RuleFormState {
  return {
    name: rule.name,
    currency: rule.currency,
    provider: rule.provider ?? '',
    accountId: rule.accountId ?? '',
    userId: rule.userId ?? '',
    model: rule.model ?? '',
    priority: String(rule.priority ?? 0),
    effectiveFrom: toLocalInputValue(rule.effectiveFrom),
    effectiveTo: rule.effectiveTo ? toLocalInputValue(rule.effectiveTo) : '',
    inputPriceMicrosPerMillion: rule.inputPriceMicrosPerMillion,
    outputPriceMicrosPerMillion: rule.outputPriceMicrosPerMillion,
    cacheCreationPriceMicrosPerMillion: rule.cacheCreationPriceMicrosPerMillion,
    cacheReadPriceMicrosPerMillion: rule.cacheReadPriceMicrosPerMillion,
    isActive: rule.isActive,
  }
}

function buildRulePayload(state: RuleFormState) {
  return {
    name: state.name,
    currency: state.currency,
    provider: state.provider.trim() || undefined,
    accountId: state.accountId.trim() || undefined,
    userId: state.userId.trim() || undefined,
    model: state.model.trim() || undefined,
    priority: Number(state.priority || 0),
    effectiveFrom: fromLocalInputValue(state.effectiveFrom),
    effectiveTo: fromLocalInputValue(state.effectiveTo) ?? null,
    inputPriceMicrosPerMillion: state.inputPriceMicrosPerMillion.trim() || '0',
    outputPriceMicrosPerMillion: state.outputPriceMicrosPerMillion.trim() || '0',
    cacheCreationPriceMicrosPerMillion: state.cacheCreationPriceMicrosPerMillion.trim() || '0',
    cacheReadPriceMicrosPerMillion: state.cacheReadPriceMicrosPerMillion.trim() || '0',
    isActive: state.isActive,
  }
}

function rateLabel(value: string, currency: string): string {
  return `${fmtMoneyMicros(value, currency)} / 1M`
}

function statusTone(count: number) {
  if (count <= 0) return 'green' as const
  return 'yellow' as const
}

export function BillingPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const [period, setPeriod] = useState<Period>('30d')
  const [currency, setCurrency] = useState<BillingCurrency>('CNY')
  const days = periods.find((entry) => entry.id === period)?.days ?? 30
  const since = days ? isoDaysAgo(days) : undefined

  const summary = useQuery({ queryKey: ['billing-summary', period, currency], queryFn: () => getBillingSummary(since, currency) })
  const users = useQuery({ queryKey: ['billing-users', period, currency], queryFn: () => getBillingUsers(since, currency) })
  const rules = useQuery({ queryKey: ['billing-rules', currency], queryFn: () => listBillingRules(currency) })

  const syncMut = useMutation({
    mutationFn: () => syncBilling(true),
    onSuccess: () => {
      toast.success('Billing sync completed')
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
      qc.invalidateQueries({ queryKey: ['billing-user-items'] })
    },
    onError: (error) => toast.error(error.message),
  })

  const rebuildMut = useMutation({
    mutationFn: rebuildBilling,
    onSuccess: () => {
      toast.success('Billing line items rebuilt')
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
      qc.invalidateQueries({ queryKey: ['billing-user-items'] })
    },
    onError: (error) => toast.error(error.message),
  })

  if (summary.isLoading || users.isLoading || rules.isLoading) {
    return <PageSkeleton />
  }

  const summaryData = summary.data
  const userRows = users.data?.users ?? []
  const ruleRows = rules.data?.rules ?? []
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Billing Control</div>
          <h2 className="text-xl font-bold text-slate-100">Token pricing, user charges, and unresolved usage</h2>
        </div>
        <div className="flex gap-2 flex-wrap">
          {billingCurrencies.map((entry) => (
            <button
              key={entry}
              onClick={() => setCurrency(entry)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                currency === entry
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-ccdash-card border-ccdash-border text-slate-400 hover:text-slate-200'
              }`}
            >
              {entry === 'CNY' ? 'RMB (CNY)' : 'USD'}
            </button>
          ))}
          {periods.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setPeriod(entry.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                period === entry.id
                  ? 'bg-blue-500/20 text-blue-400 border-blue-500/40'
                  : 'bg-ccdash-card border-ccdash-border text-slate-400 hover:text-slate-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
          <button
            onClick={() => syncMut.mutate()}
            disabled={syncMut.isPending}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Sync
          </button>
          <button
            onClick={() => {
              if (confirm('Rebuild all billing line items from usage_records?')) {
                rebuildMut.mutate()
              }
            }}
            disabled={rebuildMut.isPending}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50"
          >
            Rebuild
          </button>
        </div>
      </div>

      {summaryData && (
        <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
          <StatCard value={fmtMoneyMicros(summaryData.totalAmountMicros, currency)} label="Billed Amount" />
          <StatCard value={fmtNum(summaryData.billedRequests)} label="Billed Requests" />
          <StatCard value={fmtNum(summaryData.uniqueUsers)} label="Active Users" />
          <StatCard value={fmtNum(summaryData.activeRules)} label="Active Rules" />
          <StatCard value={fmtTokens(summaryData.totalInputTokens + summaryData.totalOutputTokens)} label="Total Tokens" />
          <StatCard value={fmtNum(summaryData.totalRequests)} label="Tracked Requests" />
          <StatCard value={fmtNum(summaryData.missingRuleRequests)} label="Missing Rule" caption="Successful requests that could not be priced." />
          <StatCard value={fmtNum(summaryData.invalidUsageRequests)} label="Invalid Usage" caption="Successful requests with zero extracted token counts." />
        </div>
      )}

      <CreateRuleCard currency={currency} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Pricing Rules</div>
          <div className="text-xs text-slate-500">{ruleRows.length} rules</div>
        </div>
        {ruleRows.length === 0 ? (
          <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 text-sm text-slate-500">
            No pricing rules yet. Create at least one default provider or model rule before using billing totals externally.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-xl:grid-cols-1">
            {ruleRows.map((rule) => (
              <RuleCard key={`${rule.id}:${rule.updatedAt}`} rule={rule} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">User Charges</div>
          <div className="text-xs text-slate-500">{userRows.length} users in window</div>
        </div>
        {userRows.length === 0 ? (
          <div className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 text-sm text-slate-500">
            No billable user activity in this period.
          </div>
        ) : (
          <div className="overflow-x-auto bg-ccdash-card border border-ccdash-border rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                  <th className="text-left py-3 px-3">User</th>
                  <th className="text-right py-3 px-3">Amount</th>
                  <th className="text-right py-3 px-3">Requests</th>
                  <th className="text-right py-3 px-3">Tokens</th>
                  <th className="text-center py-3 px-3">Issues</th>
                  <th className="text-right py-3 px-3">Last Active</th>
                </tr>
              </thead>
              <tbody>
                {userRows.map((user) => {
                    const issueCount = user.missingRuleRequests + user.invalidUsageRequests
                    return (
                      <tr key={user.userId} className="border-b border-ccdash-border/50 hover:bg-ccdash-card-strong/30">
                        <td className="py-3 px-3">
                          <Link to={`/billing/users/${encodeURIComponent(user.userId)}`} className="text-blue-400 hover:underline font-medium">
                            {user.userName || user.userId}
                          </Link>
                          <div className="text-[11px] text-slate-500 font-mono mt-1">{user.userId}</div>
                        </td>
                        <td className="py-3 px-3 text-right text-slate-200">{fmtMoneyMicros(user.totalAmountMicros, currency)}</td>
                        <td className="py-3 px-3 text-right text-slate-300">{fmtNum(user.totalRequests)}</td>
                        <td className="py-3 px-3 text-right text-slate-300">{fmtTokens(user.totalInputTokens + user.totalOutputTokens)}</td>
                        <td className="py-3 px-3 text-center">
                          <Badge tone={statusTone(issueCount)}>{issueCount === 0 ? 'Clean' : `${issueCount} open`}</Badge>
                        </td>
                        <td className="py-3 px-3 text-right text-slate-500">{user.lastActiveAt ? timeAgo(user.lastActiveAt) : '—'}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function CreateRuleCard({ currency }: { currency: BillingCurrency }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [form, setForm] = useState<RuleFormState>(buildEmptyRuleForm(currency))

  useEffect(() => {
    setForm(buildEmptyRuleForm(currency))
  }, [currency])

  const createMut = useMutation({
    mutationFn: () => createBillingRule(buildRulePayload(form)),
    onSuccess: () => {
      toast.success('Pricing rule created')
      setForm(buildEmptyRuleForm(currency))
      qc.invalidateQueries({ queryKey: ['billing-rules'] })
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
      qc.invalidateQueries({ queryKey: ['billing-user-items'] })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">New Rule</div>
          <div className="text-sm text-slate-500 mt-1">Prices are stored in micros per one million tokens and applied to successful request snapshots.</div>
        </div>
        <Badge tone="gray">{form.currency}</Badge>
      </div>
      <RuleFields state={form} onChange={setForm} />
      <div className="flex justify-end">
        <button
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending || !form.name.trim()}
          className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
        >
          Create Rule
        </button>
      </div>
    </section>
  )
}

function RuleCard({ rule }: { rule: BillingRule }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [form, setForm] = useState<RuleFormState>(() => buildRuleForm(rule))

  const saveMut = useMutation({
    mutationFn: () => updateBillingRule(rule.id, buildRulePayload(form)),
    onSuccess: () => {
      toast.success('Pricing rule updated. Rebuild billing if historical charges should be recalculated.')
      qc.invalidateQueries({ queryKey: ['billing-rules'] })
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
    },
    onError: (error) => toast.error(error.message),
  })

  const deleteMut = useMutation({
    mutationFn: () => deleteBillingRule(rule.id),
    onSuccess: () => {
      toast.success('Pricing rule deleted')
      qc.invalidateQueries({ queryKey: ['billing-rules'] })
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
      qc.invalidateQueries({ queryKey: ['billing-user-items'] })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-100">{rule.name}</div>
          <div className="text-xs text-slate-500 mt-1">
            {rule.currency} · {rule.provider || 'any provider'} · {rule.model || 'any model'} · {rule.accountId || 'any account'}
          </div>
        </div>
        <Badge tone={rule.isActive ? 'green' : 'gray'}>{rule.isActive ? 'Active' : 'Disabled'}</Badge>
      </div>
      <RuleFields state={form} onChange={setForm} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2 flex-wrap text-[11px] text-slate-500">
          <span>Input {rateLabel(form.inputPriceMicrosPerMillion, form.currency)}</span>
          <span>Output {rateLabel(form.outputPriceMicrosPerMillion, form.currency)}</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !form.name.trim()}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete billing rule "${rule.name}"?`)) {
                deleteMut.mutate()
              }
            }}
            disabled={deleteMut.isPending}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    </section>
  )
}

function RuleFields({
  state,
  onChange,
}: {
  state: RuleFormState
  onChange: Dispatch<SetStateAction<RuleFormState>>
}) {
  const setField = (key: keyof RuleFormState, value: string | boolean) => {
    onChange((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Rule Name</span>
        <input
          value={state.name}
          onChange={(e) => setField('name', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Currency</span>
        <select
          value={state.currency}
          onChange={(e) => setField('currency', e.target.value as BillingCurrency)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        >
          {billingCurrencies.map((currency) => (
            <option key={currency} value={currency}>
              {currency === 'CNY' ? 'RMB (CNY)' : 'USD'}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Priority</span>
        <input
          value={state.priority}
          onChange={(e) => setField('priority', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Provider</span>
        <input
          value={state.provider}
          onChange={(e) => setField('provider', e.target.value)}
          placeholder="claude-official"
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Model</span>
        <input
          value={state.model}
          onChange={(e) => setField('model', e.target.value)}
          placeholder="claude-sonnet-4-5"
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Account Id</span>
        <input
          value={state.accountId}
          onChange={(e) => setField('accountId', e.target.value)}
          placeholder="Optional exact account override"
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">User Id</span>
        <input
          value={state.userId}
          onChange={(e) => setField('userId', e.target.value)}
          placeholder="Optional exact user override"
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Effective From</span>
        <input
          type="datetime-local"
          value={state.effectiveFrom}
          onChange={(e) => setField('effectiveFrom', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Effective To</span>
        <input
          type="datetime-local"
          value={state.effectiveTo}
          onChange={(e) => setField('effectiveTo', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Input Price ({state.currency} micros / 1M)</span>
        <input
          value={state.inputPriceMicrosPerMillion}
          onChange={(e) => setField('inputPriceMicrosPerMillion', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Output Price ({state.currency} micros / 1M)</span>
        <input
          value={state.outputPriceMicrosPerMillion}
          onChange={(e) => setField('outputPriceMicrosPerMillion', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Cache Write ({state.currency} micros / 1M)</span>
        <input
          value={state.cacheCreationPriceMicrosPerMillion}
          onChange={(e) => setField('cacheCreationPriceMicrosPerMillion', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-slate-400">Cache Read ({state.currency} micros / 1M)</span>
        <input
          value={state.cacheReadPriceMicrosPerMillion}
          onChange={(e) => setField('cacheReadPriceMicrosPerMillion', e.target.value)}
          className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={state.isActive}
          onChange={(e) => setField('isActive', e.target.checked)}
        />
        Rule is active
      </label>
    </div>
  )
}
