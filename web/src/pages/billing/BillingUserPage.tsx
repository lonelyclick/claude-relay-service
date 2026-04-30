import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  createBillingLedgerEntry,
  getBillingUserBalance,
  getBillingUserDetail,
  getBillingUserItems,
  getBillingUserLedger,
} from '~/api/billing'
import type { BillingCurrency, BillingLedgerEntry, BillingLineItem } from '~/api/types'
import { Badge } from '~/components/Badge'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { StatCard } from '~/components/StatCard'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, fmtNum, fmtTokens, isoDaysAgo, timeAgo, truncateMiddle } from '~/lib/format'
import { getUserDetailLedgerKindLabel, getUserDetailLedgerKindTone } from '~/pages/users/userDetailPresentation'

type Period = '7d' | '30d' | '90d' | 'all'
type LedgerKindFilter = BillingLedgerEntry['kind'] | 'all'
type UnifiedKindFilter = 'all' | 'ledger' | 'usage'
type LedgerFormKind = 'topup' | 'manual_adjustment'

const periods: { id: Period; label: string; days: number | null }[] = [
  { id: '7d', label: '7 Days', days: 7 },
  { id: '30d', label: '30 Days', days: 30 },
  { id: '90d', label: '90 Days', days: 90 },
  { id: 'all', label: 'All Time', days: null },
]

const ledgerKindOptions: Array<{ id: LedgerKindFilter; label: string }> = [
  { id: 'all', label: 'All Ledger' },
  { id: 'topup', label: 'Top-ups' },
  { id: 'manual_adjustment', label: 'Adjustments' },
  { id: 'usage_debit', label: 'Usage Debits' },
]

const unifiedKindOptions: Array<{ id: UnifiedKindFilter; label: string }> = [
  { id: 'all', label: 'All Activity' },
  { id: 'ledger', label: 'Ledger Only' },
  { id: 'usage', label: 'Usage Only' },
]

function itemTone(status: BillingLineItem['status']) {
  if (status === 'billed') return 'green' as const
  if (status === 'missing_sku') return 'yellow' as const
  return 'red' as const
}

function amountToMicros(amount: string): string {
  const trimmed = amount.trim()
  if (!/^[-+]?\d+(\.\d{0,6})?$/.test(trimmed)) return ''
  const negative = trimmed.startsWith('-')
  const unsigned = trimmed.replace(/^[-+]/, '')
  const [whole, fraction = ''] = unsigned.split('.')
  const micros = `${whole || '0'}${fraction.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '') || '0'
  return negative ? `-${micros}` : micros
}

function signedMoney(value: string, currency: BillingCurrency): string {
  const numeric = BigInt(value || '0')
  if (numeric > 0n) return `+${fmtMoneyMicros(value, currency)}`
  return fmtMoneyMicros(value, currency)
}

interface UnifiedEntry {
  id: string
  kind: 'ledger' | 'usage'
  at: string
  title: string
  detail: string
  amountMicros: string
  currency: BillingCurrency
  status: string
  requestPath?: string
  badgeTone: 'green' | 'red' | 'yellow' | 'blue' | 'gray' | 'orange' | 'cyan'
}

export function BillingUserPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const [period, setPeriod] = useState<Period>('30d')
  const [ledgerKind, setLedgerKind] = useState<LedgerKindFilter>('all')
  const [unifiedKind, setUnifiedKind] = useState<UnifiedKindFilter>('all')
  const [formKind, setFormKind] = useState<LedgerFormKind>('topup')
  const [formAmount, setFormAmount] = useState('')
  const [formNote, setFormNote] = useState('')
  const days = periods.find((entry) => entry.id === period)?.days ?? 30
  const since = days ? isoDaysAgo(days) : undefined

  const detail = useQuery({
    queryKey: ['billing-user-detail', id, period],
    queryFn: () => getBillingUserDetail(id!, since),
  })
  const balance = useQuery({
    queryKey: ['billing-balance', id],
    queryFn: () => getBillingUserBalance(id!),
    retry: false,
  })
  const items = useQuery({
    queryKey: ['billing-user-items', id, period],
    queryFn: () => getBillingUserItems(id!, 100, 0, since),
  })
  const ledger = useQuery({
    queryKey: ['billing-user-ledger', id, ledgerKind],
    queryFn: () => getBillingUserLedger(id!, 100, 0, ledgerKind),
  })

  const ledgerMut = useMutation({
    mutationFn: () => {
      const amountMicros = amountToMicros(formAmount)
      if (!amountMicros || amountMicros === '0') {
        throw new Error('Enter a non-zero amount with up to 6 decimals.')
      }
      return createBillingLedgerEntry(id!, {
        kind: formKind,
        amountMicros,
        note: formNote.trim() || undefined,
      })
    },
    onSuccess: () => {
      toast.success(formKind === 'topup' ? 'Top-up recorded' : 'Adjustment recorded')
      setFormAmount('')
      setFormNote('')
      qc.invalidateQueries({ queryKey: ['billing-balance', id] })
      qc.invalidateQueries({ queryKey: ['billing-user-ledger', id] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail', id] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
    },
    onError: (error) => toast.error(error.message),
  })

  const unifiedRows = useMemo<UnifiedEntry[]>(() => {
    const ledgerRows: UnifiedEntry[] = (ledger.data?.entries ?? []).map((entry) => ({
      id: `ledger:${entry.id}`,
      kind: 'ledger',
      at: entry.createdAt,
      title: getUserDetailLedgerKindLabel(entry.kind),
      detail: entry.note || entry.requestId || entry.id,
      amountMicros: entry.amountMicros,
      currency: entry.currency,
      status: entry.kind,
      requestPath: entry.requestId ? `/users/${encodeURIComponent(entry.userId)}/requests/${encodeURIComponent(entry.requestId)}` : undefined,
      badgeTone: getUserDetailLedgerKindTone(entry.kind),
    }))
    const usageRows: UnifiedEntry[] = (items.data?.items ?? []).map((item) => ({
      id: `usage:${item.usageRecordId}`,
      kind: 'usage',
      at: item.usageCreatedAt,
      title: item.model || item.target || 'Usage',
      detail: item.requestId,
      amountMicros: item.amountMicros.startsWith('-') ? item.amountMicros : `-${item.amountMicros}`,
      currency: item.currency,
      status: item.status,
      requestPath: `/users/${encodeURIComponent(id!)}/requests/${encodeURIComponent(item.requestId)}?usageRecordId=${encodeURIComponent(String(item.usageRecordId))}`,
      badgeTone: itemTone(item.status),
    }))
    return [...ledgerRows, ...usageRows]
      .filter((entry) => unifiedKind === 'all' || entry.kind === unifiedKind)
      .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
      .slice(0, 100)
  }, [id, items.data?.items, ledger.data?.entries, unifiedKind])

  if (detail.isLoading || items.isLoading || balance.isLoading || ledger.isLoading) {
    return <PageSkeleton />
  }
  if (detail.error) {
    return <div className="text-sm text-red-400">Failed to load billing detail: {(detail.error as Error).message}</div>
  }
  if (!detail.data) {
    return <div className="text-sm text-slate-400">Billing user not found.</div>
  }

  const data = detail.data
  const lineItems = items.data?.items ?? []
  const ledgerRows = ledger.data?.entries ?? []
  const currency = data.currency
  const balanceCurrency = balance.data?.currency ?? currency

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <button onClick={() => navigate('/billing')} className="text-sm text-slate-400 hover:text-slate-200">
            &larr; Back to Billing Center
          </button>
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mt-3">Billing Account</div>
          <h2 className="text-xl font-bold text-slate-100 mt-1">{data.userName || data.userId}</h2>
          <div className="text-xs font-mono text-slate-500 mt-1">{data.userId}</div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link to={`/users/${encodeURIComponent(data.userId)}`} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-bg-card border border-border-default text-slate-300 hover:text-slate-100">
            Open User
          </Link>
          {periods.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setPeriod(entry.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                period === entry.id
                  ? 'bg-accent-muted text-indigo-400 border-accent'
                  : 'bg-bg-card border-border-default text-slate-400 hover:text-slate-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
        <StatCard value={fmtMoneyMicros(data.totalAmountMicros, currency)} label="Billed Amount" />
        <StatCard value={fmtMoneyMicros(balance.data?.balanceMicros ?? '0', balanceCurrency)} label="Current Balance" />
        <StatCard value={fmtNum(data.billedRequests)} label="Billed Requests" />
        <StatCard value={fmtNum(data.missingSkuRequests)} label="Missing SKU" />
        <StatCard value={fmtNum(data.invalidUsageRequests)} label="Invalid Usage" />
        <StatCard value={fmtNum(data.totalRequests)} label="Tracked Requests" />
        <StatCard value={fmtTokens(data.totalInputTokens + data.totalOutputTokens)} label="Total Tokens" />
        <StatCard value={fmtMoneyMicros(balance.data?.totalCreditedMicros ?? '0', balanceCurrency)} label="Credited" />
        <StatCard value={fmtMoneyMicros(balance.data?.totalDebitedMicros ?? '0', balanceCurrency)} label="Debited" />
      </div>

      <section className="grid grid-cols-[1.2fr_0.8fr] gap-4 max-xl:grid-cols-1">
        <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Balance Operations</div>
            <div className="text-sm text-slate-500 mt-1">Record top-ups and manual adjustments directly into the ledger.</div>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-3 max-md:grid-cols-1">
            <select value={formKind} onChange={(event) => setFormKind(event.target.value as LedgerFormKind)} className="bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200">
              <option value="topup">Top-up</option>
              <option value="manual_adjustment">Manual Adjustment</option>
            </select>
            <input
              value={formAmount}
              onChange={(event) => setFormAmount(event.target.value)}
              placeholder={`Amount in ${balanceCurrency}, e.g. 100 or -20`}
              className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
            />
          </div>
          <textarea
            value={formNote}
            onChange={(event) => setFormNote(event.target.value)}
            placeholder="Internal note, payment channel, refund reason, or support ticket id"
            rows={3}
            className="block w-full bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
          />
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-slate-500">Refunds can be recorded as a negative adjustment until a dedicated refund workflow exists.</div>
            <button
              onClick={() => ledgerMut.mutate()}
              disabled={ledgerMut.isPending}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Save Ledger Entry
            </button>
          </div>
        </div>

        <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Missing Workflows</div>
          <div className="space-y-2 text-sm text-slate-400">
            <div className="rounded-lg bg-bg-card-raised/40 p-3">
              <div className="text-slate-200 font-medium">Invoice request</div>
              <div className="text-xs text-slate-500 mt-1">No backend endpoint yet. Capture customer info and invoice type before wiring this action.</div>
            </div>
            <div className="rounded-lg bg-bg-card-raised/40 p-3">
              <div className="text-slate-200 font-medium">Failed order handling</div>
              <div className="text-xs text-slate-500 mt-1">Current data model has ledger entries, but no separate payment order lifecycle.</div>
            </div>
            <div className="rounded-lg bg-bg-card-raised/40 p-3">
              <div className="text-slate-200 font-medium">Refund workflow</div>
              <div className="text-xs text-slate-500 mt-1">Use manual adjustments now; add payment-provider refund state when orders are introduced.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 max-xl:grid-cols-1">
        <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Monthly Periods</div>
          {data.byPeriod.length === 0 ? (
            <div className="text-sm text-slate-500">No billing periods yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                    <th className="text-left py-2 px-2">Period</th>
                    <th className="text-right py-2 px-2">Amount</th>
                    <th className="text-right py-2 px-2">Requests</th>
                    <th className="text-right py-2 px-2">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPeriod.map((row) => (
                    <tr key={row.periodStart} className="border-b border-border-default/50">
                      <td className="py-2 px-2 text-slate-200">{row.periodStart}</td>
                      <td className="py-2 px-2 text-right text-slate-200">{fmtMoneyMicros(row.totalAmountMicros, currency)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtNum(row.totalRequests)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtTokens(row.totalInputTokens + row.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-3">Model Mix</div>
          {data.byModel.length === 0 ? (
            <div className="text-sm text-slate-500">No model activity yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                    <th className="text-left py-2 px-2">Model</th>
                    <th className="text-right py-2 px-2">Amount</th>
                    <th className="text-right py-2 px-2">Requests</th>
                    <th className="text-right py-2 px-2">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((row) => (
                    <tr key={row.model} className="border-b border-border-default/50">
                      <td className="py-2 px-2 text-slate-200">{row.model}</td>
                      <td className="py-2 px-2 text-right text-slate-200">{fmtMoneyMicros(row.totalAmountMicros, currency)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtNum(row.totalRequests)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtTokens(row.totalInputTokens + row.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Unified Billing Activity</div>
            <div className="text-xs text-slate-500 mt-1">Recharge ledger, adjustments, debits, and priced usage in one timeline.</div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {unifiedKindOptions.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setUnifiedKind(entry.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
                  unifiedKind === entry.id
                    ? 'bg-cyan-500/20 text-indigo-300 border-cyan-500/40'
                    : 'bg-bg-card border-border-default text-slate-400 hover:text-slate-200'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        {unifiedRows.length === 0 ? (
          <div className="text-sm text-slate-500 mt-3">No billing activity for the current filters.</div>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                  <th className="text-left py-2 px-2">Activity</th>
                  <th className="text-center py-2 px-2">Status</th>
                  <th className="text-right py-2 px-2">Amount</th>
                  <th className="text-right py-2 px-2">When</th>
                </tr>
              </thead>
              <tbody>
                {unifiedRows.map((entry) => (
                  <tr key={entry.id} className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
                    <td className="py-2 px-2">
                      <div className="text-slate-200">{entry.title}</div>
                      {entry.requestPath ? (
                        <Link to={entry.requestPath} className="text-[11px] text-indigo-400 hover:underline font-mono mt-1 inline-block">
                          {truncateMiddle(entry.detail, 36)}
                        </Link>
                      ) : (
                        <div className="text-[11px] text-slate-500 mt-1">{truncateMiddle(entry.detail, 60)}</div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-center"><Badge tone={entry.badgeTone}>{entry.status}</Badge></td>
                    <td className="py-2 px-2 text-right text-slate-200">{signedMoney(entry.amountMicros, entry.currency)}</td>
                    <td className="py-2 px-2 text-right text-slate-500 whitespace-nowrap">{timeAgo(entry.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Ledger Entries</div>
            <div className="text-xs text-slate-500 mt-1">{ledger.data?.total ?? 0} entries</div>
          </div>
          <select value={ledgerKind} onChange={(event) => setLedgerKind(event.target.value as LedgerKindFilter)} className="bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-slate-200">
            {ledgerKindOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </div>
        {ledgerRows.length === 0 ? (
          <div className="text-sm text-slate-500 mt-3">No ledger entries match the current filters.</div>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                  <th className="text-left py-2 px-2">Kind</th>
                  <th className="text-left py-2 px-2">Note</th>
                  <th className="text-right py-2 px-2">Amount</th>
                  <th className="text-right py-2 px-2">When</th>
                </tr>
              </thead>
              <tbody>
                {ledgerRows.map((entry) => (
                  <tr key={entry.id} className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
                    <td className="py-2 px-2"><Badge tone={getUserDetailLedgerKindTone(entry.kind)}>{getUserDetailLedgerKindLabel(entry.kind)}</Badge></td>
                    <td className="py-2 px-2 text-slate-300">
                      <div>{entry.note || '—'}</div>
                      {entry.requestId && <div className="text-[11px] text-slate-500 font-mono mt-1">{truncateMiddle(entry.requestId, 28)}</div>}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-200">{signedMoney(entry.amountMicros, entry.currency)}</td>
                    <td className="py-2 px-2 text-right text-slate-500 whitespace-nowrap">{timeAgo(entry.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Recent Usage Line Items</div>
          <div className="text-xs text-slate-500">{items.data?.total ?? 0} items</div>
        </div>
        {lineItems.length === 0 ? (
          <div className="text-sm text-slate-500 mt-3">No line items in this period.</div>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border-default">
                  <th className="text-left py-2 px-2">Request</th>
                  <th className="text-center py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Rule</th>
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-right py-2 px-2">Amount</th>
                  <th className="text-right py-2 px-2">Tokens</th>
                  <th className="text-right py-2 px-2">When</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item) => (
                  <tr key={item.usageRecordId} className="border-b border-border-default/50 hover:bg-bg-card-raised/30">
                    <td className="py-2 px-2">
                      <Link
                        to={`/users/${encodeURIComponent(data.userId)}/requests/${encodeURIComponent(item.requestId)}?usageRecordId=${encodeURIComponent(String(item.usageRecordId))}`}
                        className="text-indigo-400 hover:underline font-mono text-xs"
                      >
                        {truncateMiddle(item.requestId, 24)}
                      </Link>
                      <div className="text-[11px] text-slate-500 mt-1">{item.target}</div>
                    </td>
                    <td className="py-2 px-2 text-center">
                      <Badge tone={itemTone(item.status)}>{item.status}</Badge>
                    </td>
                    <td className="py-2 px-2 text-slate-300">
                      —
                    </td>
                    <td className="py-2 px-2 text-slate-300">
                      <div>{item.model || '—'}</div>
                      <div className="text-[11px] text-slate-500 mt-1">{item.provider || 'unknown provider'}</div>
                    </td>
                    <td className="py-2 px-2 text-right text-slate-200">{fmtMoneyMicros(item.amountMicros, currency)}</td>
                    <td className="py-2 px-2 text-right text-slate-300">
                      {fmtTokens(item.inputTokens + item.outputTokens + item.cacheCreationTokens + item.cacheReadTokens)}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-500">{timeAgo(item.usageCreatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
