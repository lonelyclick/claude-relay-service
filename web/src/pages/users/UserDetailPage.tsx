import { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createUserApiKey,
  getUser,
  getUserSessions,
  getUserRequests,
  getSessionRequests,
  listUserApiKeys,
  revokeUserApiKey,
  updateUser,
  deleteUser,
} from '~/api/users'
import { getBillingUserBalance, getBillingUserLedger, createBillingLedgerEntry } from '~/api/billing'
import type { BillingCurrency, RelayApiKey, RelayKeySource, RelayKeySourceSummary } from '~/api/types'
import { listAccounts } from '~/api/accounts'
import { listRoutingGroups } from '~/api/routing'
import { Badge } from '~/components/Badge'
import { cn } from '~/lib/cn'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, fmtTokens, fmtNum, timeAgo, truncateMiddle } from '~/lib/format'
import {
  buildSessionAnchorId,
  buildSessionRequestAnchorId,
  buildRequestDetailHref,
  buildUserDetailHref,
  buildUsersHref,
  isRestoredSessionRequestHighlighted,
  normalizeUserDetailRelayKeySource,
  readUserDetailPageState,
  RESTORED_SESSION_REQUEST_HIGHLIGHT_MS,
  resolveExpandedSessionKey,
  resolveRestoredSessionRequestId,
  type UserDetailReturnState,
  type UsersListReturnState,
} from './userDetailLinks'
import {
  getUserDetailLedgerKindLabel,
  getUserDetailLedgerKindTone,
  getUserDetailRelayKeySourceLabel,
  getUserDetailRelayKeySourceTone,
  userDetailRelayKeySourceOptions,
} from './userDetailPresentation'

function moneyInputToMicros(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const sign = trimmed.startsWith('-') ? -1n : 1n
  const normalized = trimmed.replace(/^[+-]/, '')
  if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) {
    return null
  }

  const [wholePart, fractionPart = ''] = normalized.split('.')
  const whole = BigInt(wholePart || '0')
  const fraction = BigInt((fractionPart + '000000').slice(0, 6) || '0')
  return (sign * (whole * 1_000_000n + fraction)).toString()
}

const billingCurrencies: BillingCurrency[] = ['CNY', 'USD']

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const pageState = readUserDetailPageState(searchParams)
  const deviceFilter = pageState.device ?? ''
  const relayKeySourceFilter = pageState.relayKeySource
  const restoredSessionKey = pageState.sessionKey ?? null
  const restoredSessionRequestId = pageState.sessionRequestId ?? null
  const usersListReturnState = pageState.usersListReturnState
  const requestDetailReturnState: UserDetailReturnState = {
    device: deviceFilter || null,
    relayKeySource: relayKeySourceFilter,
    usersListReturnState,
  }

  const user = useQuery({ queryKey: ['user', id], queryFn: () => getUser(id!) })
  const sessions = useQuery({ queryKey: ['user-sessions', id], queryFn: () => getUserSessions(id!) })
  const requests = useQuery({
    queryKey: ['user-requests', id, relayKeySourceFilter],
    queryFn: () => getUserRequests(id!, 100, 0, relayKeySourceFilter),
  })
  const balance = useQuery({ queryKey: ['billing-balance', id], queryFn: () => getBillingUserBalance(id!), retry: false })
  const ledger = useQuery({ queryKey: ['billing-ledger', id], queryFn: () => getBillingUserLedger(id!, 20, 0), retry: false })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const groups = useQuery({ queryKey: ['routing-groups'], queryFn: listRoutingGroups })

  const sessionList = sessions.data?.sessions ?? []
  const requestList = requests.data?.requests ?? []
  const requestTotal = requests.data?.total ?? requestList.length
  const accountList = accounts.data?.accounts ?? []
  const groupList = groups.data?.routingGroups ?? []

  const devices = useMemo(() => {
    const devs = new Set<string>()
    sessionList.forEach((s) => { if (s.clientDeviceId) devs.add(s.clientDeviceId) })
    requestList.forEach((r) => { if (r.clientDeviceId) devs.add(r.clientDeviceId) })
    return [...devs].sort()
  }, [sessionList, requestList])

  const filteredSessions = deviceFilter ? sessionList.filter((s) => s.clientDeviceId === deviceFilter) : sessionList
  const filteredRequests = deviceFilter ? requestList.filter((r) => r.clientDeviceId === deviceFilter) : requestList

  useEffect(() => {
    const targetId = location.hash.startsWith('#session-')
      ? location.hash.slice(1)
      : location.hash === '#requests'
        ? 'requests'
        : null
    if (!targetId) {
      return
    }

    const target = document.getElementById(targetId)
    if (!target) {
      return
    }

    window.requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start' })
    })
  }, [location.hash, requestTotal, relayKeySourceFilter, deviceFilter, restoredSessionKey, sessionList.length])

  if (user.isLoading) return <PageSkeleton />
  if (user.error) return <div className="text-red-400 text-sm">Failed to load user: {(user.error as Error).message}</div>
  if (!user.data) return <div className="text-slate-400 text-sm">User not found</div>

  const u = user.data

  return (
    <div className="space-y-5">
      <button
        onClick={() => navigate(buildUsersHref(usersListReturnState))}
        className="text-sm text-slate-400 hover:text-slate-200"
      >
        &larr; Back to Users
      </button>

      <UserHeader user={u} balance={balance.data ?? null} />
      <ApiKeySection userId={u.id} legacyKeyPreview={u.apiKeyPreview} />
      <RoutingSection user={u} accounts={accountList} groups={groupList} />
      <BillingSection
        user={u}
        balance={balance.data ?? null}
        ledgerEntries={ledger.data?.entries ?? []}
        ledgerTotal={ledger.data?.total ?? 0}
        requestDetailReturnState={requestDetailReturnState}
      />
      <InventoryFilters
        devices={devices}
        currentDevice={deviceFilter}
        currentRelayKeySource={relayKeySourceFilter}
        userId={u.id}
        usersListReturnState={usersListReturnState}
      />
      <SessionsSection
        sessions={filteredSessions}
        userId={u.id}
        relayKeySourceFilter={relayKeySourceFilter}
        requestDetailReturnState={requestDetailReturnState}
        restoredSessionKey={restoredSessionKey}
        restoredSessionRequestId={restoredSessionRequestId}
      />
      <RequestsSection
        requests={filteredRequests}
        total={requestTotal}
        userId={u.id}
        relayKeySourceFilter={relayKeySourceFilter}
        requestDetailReturnState={requestDetailReturnState}
      />
      <DangerZone user={u} />
    </div>
  )
}

function UserHeader({
  user: u,
  balance,
}: {
  user: { id: string; name: string; isActive: boolean; routingMode?: string; accountId?: string; routingGroupId?: string; totalRequests?: number; totalInputTokens?: number; totalOutputTokens?: number; billingMode?: 'postpaid' | 'prepaid'; billingCurrency?: BillingCurrency; balanceMicros?: string; relayKeySourceSummary?: RelayKeySourceSummary }
  balance: { balanceMicros: string; billingMode: 'postpaid' | 'prepaid'; billingCurrency?: BillingCurrency; currency?: BillingCurrency } | null
}) {
  const balanceMicros = balance?.balanceMicros ?? u.balanceMicros ?? '0'
  const billingMode = balance?.billingMode ?? u.billingMode ?? 'postpaid'
  const billingCurrency = balance?.billingCurrency ?? balance?.currency ?? u.billingCurrency ?? 'USD'
  const relayKeySourceSummary = u.relayKeySourceSummary
  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-100">{u.name}</h2>
          <div className="text-xs text-slate-500 font-mono">{u.id}</div>
        </div>
        <Badge tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'Active' : 'Disabled'}</Badge>
      </div>
      <div className="flex gap-2 mt-2 text-xs">
        <Badge tone="blue">{fmtNum(u.totalRequests ?? 0)} requests</Badge>
        <Badge tone="cyan">{fmtTokens((u.totalInputTokens ?? 0) + (u.totalOutputTokens ?? 0))} tokens</Badge>
        <Badge tone={billingMode === 'prepaid' ? 'yellow' : 'gray'}>{billingMode}</Badge>
        <Badge tone="blue">{billingCurrency}</Badge>
        <Badge tone={balanceMicros.startsWith('-') ? 'red' : 'green'}>{fmtMoneyMicros(balanceMicros, billingCurrency)} balance</Badge>
      </div>
      {relayKeySourceSummary ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>Migration signal:</span>
          <Badge tone={relayKeySourceSummary.legacyFallbackCount > 0 ? 'yellow' : 'green'}>
            {fmtNum(relayKeySourceSummary.legacyFallbackCount)} legacy fallback
          </Badge>
          <Badge tone="cyan">{fmtNum(relayKeySourceSummary.relayApiKeysCount)} relay_api_keys</Badge>
          <span>
            from {fmtNum(relayKeySourceSummary.countedRequests)} of up to {fmtNum(relayKeySourceSummary.recentWindowLimit)} recent final requests
          </span>
        </div>
      ) : null}
    </section>
  )
}

function ApiKeySection({ userId, legacyKeyPreview }: { userId: string; legacyKeyPreview?: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [revealed, setRevealed] = useState<string | null>(null)
  const apiKeys = useQuery({
    queryKey: ['user-api-keys', userId],
    queryFn: () => listUserApiKeys(userId),
  })

  const createMut = useMutation({
    mutationFn: () => createUserApiKey(userId),
    onSuccess: (data) => {
      setRevealed(data.apiKey)
      toast.success('Relay API key created')
      qc.invalidateQueries({ queryKey: ['user-api-keys', userId] })
    },
    onError: (e) => toast.error(e.message),
  })

  const revokeMut = useMutation({
    mutationFn: ({ keyId }: { keyId: string }) => revokeUserApiKey(userId, keyId),
    onSuccess: () => {
      setRevealed(null)
      toast.success('Relay API key revoked')
      qc.invalidateQueries({ queryKey: ['user-api-keys', userId] })
    },
    onError: (e) => toast.error(e.message),
  })

  const activeKeys = apiKeys.data?.apiKeys ?? []

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Relay API Keys</div>
      {revealed ? (
        <div className="flex items-center gap-2">
          <code className="text-xs text-slate-200 bg-ccdash-input px-2 py-1 rounded font-mono break-all">{revealed}</code>
          <button onClick={() => { navigator.clipboard.writeText(revealed); toast.success('Copied') }} className="text-xs text-blue-400 hover:text-blue-300 shrink-0">Copy</button>
        </div>
      ) : (
        <div className="text-xs text-slate-500">Create a relay API key to disclose a fresh reseller credential.</div>
      )}
      <div className="flex gap-2 mt-3">
        <button
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
        >
          Create Key
        </button>
      </div>
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-slate-500">
          <span>Active Keys ({activeKeys.length})</span>
          <span>Legacy preview: <span className="font-mono text-slate-400">{legacyKeyPreview ?? '—'}</span></span>
        </div>
        {apiKeys.isLoading ? (
          <div className="text-xs text-slate-500">Loading relay API keys...</div>
        ) : activeKeys.length === 0 ? (
          <div className="text-xs text-slate-500">No active relay API keys.</div>
        ) : (
          <div className="space-y-2">
            {activeKeys.map((apiKey) => (
              <ApiKeyRow
                key={apiKey.id}
                apiKey={apiKey}
                onRevoke={() => {
                  if (confirm(`Revoke relay API key "${apiKey.name}"? This key will stop working immediately.`)) {
                    revokeMut.mutate({ keyId: apiKey.id })
                  }
                }}
                pending={revokeMut.isPending}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ApiKeyRow({
  apiKey,
  onRevoke,
  pending,
}: {
  apiKey: RelayApiKey
  onRevoke: () => void
  pending: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-ccdash-border bg-ccdash-input/40 px-3 py-2 max-md:flex-col max-md:items-start">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-200">{apiKey.name}</span>
          <Badge tone="cyan">{truncateMiddle(apiKey.id, 18)}</Badge>
        </div>
        <div className="font-mono text-xs text-slate-400">{apiKey.keyPreview}</div>
        <div className="text-[11px] text-slate-500">
          Created {timeAgo(apiKey.createdAt)}
          {apiKey.lastUsedAt ? ` · Last used ${timeAgo(apiKey.lastUsedAt)}` : ' · Never used'}
        </div>
      </div>
      <button
        onClick={onRevoke}
        disabled={pending}
        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
      >
        Revoke
      </button>
    </div>
  )
}

function RoutingSection({ user: u, accounts, groups }: {
  user: { id: string; routingMode?: string; accountId?: string; routingGroupId?: string }
  accounts: { id: string; emailAddress: string; label?: string; routingGroupId?: string }[]
  groups: { id: string; name: string }[]
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const [mode, setMode] = useState(u.routingMode ?? 'auto')
  const [accountId, setAccountId] = useState(u.accountId ?? '')
  const [groupId, setGroupId] = useState(u.routingGroupId ?? '')

  const mut = useMutation({
    mutationFn: () => {
      const updates: Record<string, unknown> = { routingMode: mode }
      if (mode === 'pinned_account') updates.accountId = accountId || null
      if (mode === 'preferred_group') updates.routingGroupId = groupId || null
      return updateUser(u.id, updates)
    },
    onSuccess: () => {
      toast.success('Routing updated')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-3">Routing Configuration</div>
      <div className="space-y-3">
        <div className="flex gap-2 items-center">
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200">
            <option value="auto">Auto</option>
            <option value="pinned_account">Pinned Account</option>
            <option value="preferred_group">Group Only</option>
          </select>
        </div>
        {mode === 'pinned_account' && (
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 w-full">
            <option value="">Select account...</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label || a.emailAddress}</option>)}
          </select>
        )}
        {mode === 'preferred_group' && (
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200 w-full">
            <option value="">Select group...</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name || g.id}</option>)}
          </select>
        )}
        <button onClick={() => mut.mutate()} disabled={mut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
          Apply Routing
        </button>
      </div>
    </section>
  )
}

function BillingSection({
  user: u,
  balance,
  ledgerEntries,
  ledgerTotal,
  requestDetailReturnState,
}: {
  user: { id: string; billingMode?: 'postpaid' | 'prepaid'; billingCurrency?: BillingCurrency }
  balance: {
    balanceMicros: string
    billingMode: 'postpaid' | 'prepaid'
    billingCurrency: BillingCurrency
    totalCreditedMicros: string
    totalDebitedMicros: string
    currency: BillingCurrency
    lastLedgerAt?: string | null
  } | null
  ledgerEntries: Array<{
    id: string
    kind: 'topup' | 'manual_adjustment' | 'usage_debit'
    amountMicros: string
    note?: string | null
    requestId?: string | null
    usageRecordId?: number | null
    createdAt: string
  }>
  ledgerTotal: number
  requestDetailReturnState: UserDetailReturnState
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const [billingMode, setBillingMode] = useState<'postpaid' | 'prepaid'>(u.billingMode ?? 'postpaid')
  const [billingCurrency, setBillingCurrency] = useState<BillingCurrency>(u.billingCurrency ?? balance?.billingCurrency ?? balance?.currency ?? 'CNY')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  const updateModeMut = useMutation({
    mutationFn: () => updateUser(u.id, { billingMode, billingCurrency }),
    onSuccess: () => {
      toast.success('Billing settings updated')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['billing-balance', u.id] })
    },
    onError: (e) => toast.error(e.message),
  })

  const ledgerMut = useMutation({
    mutationFn: async (kind: 'topup' | 'manual_adjustment') => {
      const amountMicros = moneyInputToMicros(amount)
      if (!amountMicros) {
        throw new Error('Enter a valid amount with up to 6 decimals')
      }
      return createBillingLedgerEntry(u.id, {
        kind,
        amountMicros,
        note: note.trim() || undefined,
      })
    },
    onSuccess: () => {
      toast.success('Ledger entry created')
      setAmount('')
      setNote('')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['billing-balance', u.id] })
      qc.invalidateQueries({ queryKey: ['billing-ledger', u.id] })
      qc.invalidateQueries({ queryKey: ['billing-summary'] })
      qc.invalidateQueries({ queryKey: ['billing-users'] })
      qc.invalidateQueries({ queryKey: ['billing-user-detail'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Billing & Recharge</div>
        {balance?.lastLedgerAt ? <div className="text-xs text-slate-500">Last change {timeAgo(balance.lastLedgerAt)}</div> : null}
      </div>

      <div className="grid grid-cols-4 gap-3 max-xl:grid-cols-2 max-md:grid-cols-1">
        <div className="rounded-lg border border-ccdash-border bg-ccdash-card-strong p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Current Balance</div>
          <div className={`mt-2 text-lg font-semibold ${(balance?.balanceMicros ?? '0').startsWith('-') ? 'text-red-400' : 'text-slate-100'}`}>
            {fmtMoneyMicros(balance?.balanceMicros ?? '0', balance?.currency ?? 'USD')}
          </div>
        </div>
        <div className="rounded-lg border border-ccdash-border bg-ccdash-card-strong p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Credited</div>
          <div className="mt-2 text-lg font-semibold text-slate-100">
            {fmtMoneyMicros(balance?.totalCreditedMicros ?? '0', balance?.currency ?? 'USD')}
          </div>
        </div>
        <div className="rounded-lg border border-ccdash-border bg-ccdash-card-strong p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Debited</div>
          <div className="mt-2 text-lg font-semibold text-slate-100">
            {fmtMoneyMicros(balance?.totalDebitedMicros ?? '0', balance?.currency ?? 'USD')}
          </div>
        </div>
        <div className="rounded-lg border border-ccdash-border bg-ccdash-card-strong p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Mode</div>
          <div className="mt-2">
            <Badge tone={(balance?.billingMode ?? billingMode) === 'prepaid' ? 'yellow' : 'gray'}>
              {balance?.billingMode ?? billingMode}
            </Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 max-xl:grid-cols-1">
        <div className="rounded-lg border border-ccdash-border bg-ccdash-card-strong p-4 space-y-3">
          <div className="text-sm font-medium text-slate-100">Billing Settings</div>
          <div className="text-xs text-slate-500">`prepaid` users are blocked when balance is zero or below. Currency can only be changed before any balance or billed history exists.</div>
          <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
            <select value={billingMode} onChange={(e) => setBillingMode(e.target.value as 'postpaid' | 'prepaid')} className="bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200">
              <option value="postpaid">postpaid</option>
              <option value="prepaid">prepaid</option>
            </select>
            <select value={billingCurrency} onChange={(e) => setBillingCurrency(e.target.value as BillingCurrency)} className="bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200">
              {billingCurrencies.map((currency) => (
                <option key={currency} value={currency}>
                  {currency === 'CNY' ? 'RMB (CNY)' : 'USD'}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            <button onClick={() => updateModeMut.mutate()} disabled={updateModeMut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
              Save
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-ccdash-border bg-ccdash-card-strong p-4 space-y-3">
          <div className="text-sm font-medium text-slate-100">Recharge / Adjustment</div>
          <div className="text-xs text-slate-500">Enter a currency amount, for example `10`, `5.25`, or `-2`.</div>
          <label className="space-y-1 block">
            <span className="text-xs text-slate-400">Amount ({balance?.currency ?? 'USD'})</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10.00"
              className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
            />
          </label>
          <label className="space-y-1 block">
            <span className="text-xs text-slate-400">Note</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="manual top-up / correction"
              className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
            />
          </label>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => ledgerMut.mutate('topup')}
              disabled={ledgerMut.isPending}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
            >
              Top Up
            </button>
            <button
              onClick={() => ledgerMut.mutate('manual_adjustment')}
              disabled={ledgerMut.isPending}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50"
            >
              Apply Adjustment
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-slate-100">Recent Ledger</div>
          <div className="text-xs text-slate-500">{ledgerTotal} entries</div>
        </div>
        {ledgerEntries.length === 0 ? (
          <div className="text-sm text-slate-500">No ledger entries yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                  <th className="text-left py-1.5 px-2">Time</th>
                  <th className="text-center py-1.5 px-2">Kind</th>
                  <th className="text-right py-1.5 px-2">Amount</th>
                  <th className="text-left py-1.5 px-2">Note</th>
                  <th className="text-right py-1.5 px-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {ledgerEntries.map((entry) => (
                  <tr key={entry.id} className="border-b border-ccdash-border/30 hover:bg-ccdash-card-strong/30">
                    <td className="py-1.5 px-2 text-slate-500 whitespace-nowrap">{timeAgo(entry.createdAt)}</td>
                    <td className="py-1.5 px-2 text-center">
                      <Badge tone={getUserDetailLedgerKindTone(entry.kind)}>{getUserDetailLedgerKindLabel(entry.kind)}</Badge>
                    </td>
                    <td className={`py-1.5 px-2 text-right ${entry.amountMicros.startsWith('-') ? 'text-red-400' : 'text-green-400'}`}>
                      {fmtMoneyMicros(entry.amountMicros, balance?.currency ?? 'USD')}
                    </td>
                    <td className="py-1.5 px-2 text-slate-300">{entry.note || '—'}</td>
                    <td className="py-1.5 px-2 text-right">
                      {entry.requestId ? (
                        <Link
                          to={buildRequestDetailHref(u.id, entry.requestId, {
                            usageRecordId: entry.usageRecordId,
                            returnState: requestDetailReturnState,
                          })}
                          className="text-blue-400 hover:underline"
                        >
                          View
                        </Link>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

function InventoryFilters({
  devices,
  currentDevice,
  currentRelayKeySource,
  userId,
  usersListReturnState,
}: {
  devices: string[]
  currentDevice: string
  currentRelayKeySource: RelayKeySource | null
  userId: string
  usersListReturnState: UsersListReturnState
}) {
  const navigate = useNavigate()

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-4">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500">Request inventory filters</span>
          {currentRelayKeySource ? <Badge tone={getUserDetailRelayKeySourceTone(currentRelayKeySource)}>{getUserDetailRelayKeySourceLabel(currentRelayKeySource)}</Badge> : null}
          {currentDevice ? <Badge tone="blue">{truncateMiddle(currentDevice, 18)}</Badge> : null}
        </div>
        {(currentDevice || currentRelayKeySource) ? (
          <button
            onClick={() => navigate(buildUserDetailHref(userId, {}, undefined, usersListReturnState))}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <label className="space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Client Device</span>
          <select
            value={currentDevice}
            onChange={(event) => navigate(buildUserDetailHref(userId, {
              device: event.target.value || null,
              relayKeySource: currentRelayKeySource,
            }, undefined, usersListReturnState))}
            className="w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
          >
            <option value="">All devices</option>
            {devices.map((device) => (
              <option key={device} value={device}>
                {device}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Relay Key Source</span>
          <select
            value={currentRelayKeySource ?? ''}
            onChange={(event) => navigate(buildUserDetailHref(userId, {
              device: currentDevice || null,
              relayKeySource: normalizeUserDetailRelayKeySource(event.target.value || null),
            }, undefined, usersListReturnState))}
            className="w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
          >
            <option value="">All key sources</option>
            {userDetailRelayKeySourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}

function SessionsSection({
  sessions,
  userId,
  relayKeySourceFilter,
  requestDetailReturnState,
  restoredSessionKey,
  restoredSessionRequestId,
}: {
  sessions: { sessionKey: string; clientDeviceId?: string | null; accountId?: string | null; firstSeenAt: string; lastActiveAt: string; requestCount: number }[]
  userId: string
  relayKeySourceFilter: RelayKeySource | null
  requestDetailReturnState: UserDetailReturnState
  restoredSessionKey: string | null
  restoredSessionRequestId: string | null
}) {
  const restoredExpandedSessionKey = useMemo(
    () => resolveExpandedSessionKey(restoredSessionKey, sessions),
    [restoredSessionKey, sessions],
  )
  const [expanded, setExpanded] = useState<string | null>(restoredExpandedSessionKey)

  useEffect(() => {
    if (!restoredSessionKey) {
      return
    }
    setExpanded(restoredExpandedSessionKey)
  }, [restoredExpandedSessionKey, restoredSessionKey])

  return (
    <section className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Sessions ({sessions.length})</div>
        {relayKeySourceFilter ? <Badge tone={getUserDetailRelayKeySourceTone(relayKeySourceFilter)}>{getUserDetailRelayKeySourceLabel(relayKeySourceFilter)}</Badge> : null}
      </div>
      {sessions.length === 0 ? (
        <div className="text-sm text-slate-500">No sessions.</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.sessionKey}
              id={buildSessionAnchorId(s.sessionKey)}
              className="bg-ccdash-card-strong rounded-lg text-xs"
            >
              <button
                onClick={() => setExpanded(expanded === s.sessionKey ? null : s.sessionKey)}
                className="w-full p-3 text-left hover:bg-ccdash-card-strong/80 rounded-lg transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-slate-300">{truncateMiddle(s.sessionKey, 28)}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500">{timeAgo(s.lastActiveAt)}</span>
                    <span className="text-slate-500">{expanded === s.sessionKey ? '\u25B2' : '\u25BC'}</span>
                  </div>
                </div>
                <div className="flex gap-3 text-slate-400">
                  {s.clientDeviceId && <span>Device: <Badge tone="blue">{truncateMiddle(s.clientDeviceId, 12)}</Badge></span>}
                  {s.accountId && (
                    <span>Account: <Link to={`/accounts/${encodeURIComponent(s.accountId)}`} className="text-blue-400 hover:underline" onClick={(e) => e.stopPropagation()}>{truncateMiddle(s.accountId, 12)}</Link></span>
                  )}
                  <span>{fmtNum(s.requestCount)} requests</span>
                </div>
              </button>
              {expanded === s.sessionKey && (
                <SessionRequestsPanel
                  userId={userId}
                  sessionKey={s.sessionKey}
                  relayKeySourceFilter={relayKeySourceFilter}
                  requestDetailReturnState={requestDetailReturnState}
                  restoredSessionRequestId={restoredExpandedSessionKey === s.sessionKey ? restoredSessionRequestId : null}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SessionRequestsPanel({
  userId,
  sessionKey,
  relayKeySourceFilter,
  requestDetailReturnState,
  restoredSessionRequestId,
}: {
  userId: string
  sessionKey: string
  relayKeySourceFilter: RelayKeySource | null
  requestDetailReturnState: UserDetailReturnState
  restoredSessionRequestId: string | null
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['session-requests', userId, sessionKey, relayKeySourceFilter],
    queryFn: () => getSessionRequests(userId, sessionKey, 100, 0, relayKeySourceFilter),
  })

  if (isLoading) return <div className="px-3 pb-3 text-xs text-slate-500">Loading requests...</div>
  if (error) return <div className="px-3 pb-3 text-xs text-red-400">Failed to load: {(error as Error).message}</div>

  const reqs = data?.requests ?? []
  const restoredVisibleRequestId = useMemo(
    () => resolveRestoredSessionRequestId(restoredSessionRequestId, reqs),
    [restoredSessionRequestId, reqs],
  )
  const [highlightedRequestId, setHighlightedRequestId] = useState<string | null>(restoredVisibleRequestId)

  useEffect(() => {
    if (!restoredVisibleRequestId) {
      return
    }
    const target = document.getElementById(buildSessionRequestAnchorId(sessionKey, restoredVisibleRequestId))
    if (!target) {
      return
    }
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center' })
    })
  }, [restoredVisibleRequestId, sessionKey])

  useEffect(() => {
    if (!restoredVisibleRequestId) {
      return
    }
    setHighlightedRequestId(restoredVisibleRequestId)
    const timeoutId = window.setTimeout(() => {
      setHighlightedRequestId((current) => (current === restoredVisibleRequestId ? null : current))
    }, RESTORED_SESSION_REQUEST_HIGHLIGHT_MS)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [restoredVisibleRequestId])

  if (reqs.length === 0) return <div className="px-3 pb-3 text-xs text-slate-500">No requests in this session.</div>

  return (
    <div className="px-3 pb-3 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
            <th className="text-left py-1 px-2">Time</th>
            <th className="text-left py-1 px-2">Model</th>
            <th className="text-right py-1 px-2">Input</th>
            <th className="text-right py-1 px-2">Output</th>
            <th className="text-center py-1 px-2">Status</th>
            <th className="text-center py-1 px-2">Key Source</th>
            <th className="text-right py-1 px-2">Detail</th>
          </tr>
        </thead>
          <tbody>
            {reqs.map((r) => {
              const isRestored = isRestoredSessionRequestHighlighted(r.requestId, highlightedRequestId)
              return (
                <tr
                  key={r.usageRecordId ?? r.requestId}
                  id={buildSessionRequestAnchorId(sessionKey, r.requestId)}
                  className={cn(
                    'border-b border-ccdash-border/30 transition-colors duration-700 hover:bg-ccdash-card/30',
                    isRestored && 'bg-amber-500/10 animate-pulse',
                  )}
                >
                  <td className="py-1 px-2 text-slate-500 whitespace-nowrap">{timeAgo(r.createdAt)}</td>
                  <td className="py-1 px-2 text-slate-300">{r.model ?? '\u2014'}</td>
                  <td className="py-1 px-2 text-right text-slate-300">{fmtTokens(r.inputTokens)}</td>
                  <td className="py-1 px-2 text-right text-slate-300">{fmtTokens(r.outputTokens)}</td>
                  <td className="py-1 px-2 text-center">
                    <Badge tone={r.statusCode != null && r.statusCode < 400 ? 'green' : r.statusCode != null && r.statusCode >= 400 ? 'red' : 'gray'}>{r.statusCode != null ? String(r.statusCode) : '\u2014'}</Badge>
                  </td>
                  <td className="py-1 px-2 text-center">
                    <Badge tone={getUserDetailRelayKeySourceTone(r.relayKeySource)}>{getUserDetailRelayKeySourceLabel(r.relayKeySource)}</Badge>
                  </td>
                  <td className="py-1 px-2 text-right whitespace-nowrap">
                    {isRestored ? <span className="inline-block align-middle mr-2"><Badge tone="yellow">Restored</Badge></span> : null}
                    <Link
                      to={buildRequestDetailHref(userId, r.requestId, {
                        usageRecordId: r.usageRecordId,
                        returnState: {
                          ...requestDetailReturnState,
                          sessionKey,
                        },
                      })}
                      className="text-blue-400 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              )
            })}
        </tbody>
      </table>
    </div>
  )
}

function RequestsSection({
  requests,
  total,
  userId,
  relayKeySourceFilter,
  requestDetailReturnState,
}: {
  requests: { usageRecordId?: number; requestId: string; createdAt: string; model?: string; inputTokens: number; outputTokens: number; statusCode?: number; clientDeviceId?: string | null; relayKeySource?: RelayKeySource | null }[]
  total: number
  userId: string
  relayKeySourceFilter: RelayKeySource | null
  requestDetailReturnState: UserDetailReturnState
}) {
  return (
    <section id="requests" className="bg-ccdash-card border border-ccdash-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Recent Requests ({fmtNum(total)})</div>
        {relayKeySourceFilter ? <Badge tone={getUserDetailRelayKeySourceTone(relayKeySourceFilter)}>{getUserDetailRelayKeySourceLabel(relayKeySourceFilter)}</Badge> : null}
      </div>
      {requests.length === 0 ? (
        <div className="text-sm text-slate-500">No requests.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                <th className="text-left py-1.5 px-2">Time</th>
                <th className="text-left py-1.5 px-2">Model</th>
                <th className="text-right py-1.5 px-2">Input</th>
                <th className="text-right py-1.5 px-2">Output</th>
                <th className="text-center py-1.5 px-2">Status</th>
                <th className="text-center py-1.5 px-2">Key Source</th>
                <th className="text-right py-1.5 px-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.usageRecordId ?? r.requestId} className="border-b border-ccdash-border/30 hover:bg-ccdash-card-strong/30">
                  <td className="py-1.5 px-2 text-slate-500 whitespace-nowrap">{timeAgo(r.createdAt)}</td>
                  <td className="py-1.5 px-2 text-slate-300">{r.model ?? '—'}</td>
                  <td className="py-1.5 px-2 text-right text-slate-300">{fmtTokens(r.inputTokens)}</td>
                  <td className="py-1.5 px-2 text-right text-slate-300">{fmtTokens(r.outputTokens)}</td>
                  <td className="py-1.5 px-2 text-center">
                    <Badge tone={r.statusCode != null && r.statusCode < 400 ? 'green' : r.statusCode != null && r.statusCode >= 400 ? 'red' : 'gray'}>{r.statusCode != null ? String(r.statusCode) : '—'}</Badge>
                  </td>
                  <td className="py-1.5 px-2 text-center">
                    <Badge tone={getUserDetailRelayKeySourceTone(r.relayKeySource)}>{getUserDetailRelayKeySourceLabel(r.relayKeySource)}</Badge>
                  </td>
                  <td className="py-1.5 px-2 text-right">
                    <Link
                      to={buildRequestDetailHref(userId, r.requestId, {
                        usageRecordId: r.usageRecordId,
                        returnState: requestDetailReturnState,
                      })}
                      className="text-blue-400 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DangerZone({ user: u }: { user: { id: string; name: string; isActive: boolean } }) {
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const toggleMut = useMutation({
    mutationFn: () => updateUser(u.id, { isActive: !u.isActive }),
    onSuccess: () => {
      toast.success(u.isActive ? 'User disabled' : 'User enabled')
      qc.invalidateQueries({ queryKey: ['user', u.id] })
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const delMut = useMutation({
    mutationFn: () => deleteUser(u.id),
    onSuccess: () => {
      toast.success('User deleted')
      qc.invalidateQueries({ queryKey: ['users'] })
      navigate('/users')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="bg-ccdash-card border border-red-500/20 rounded-xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-3">Danger Zone</div>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => toggleMut.mutate()}
          disabled={toggleMut.isPending}
          className="px-3 py-1.5 rounded-lg text-sm bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20"
        >
          {u.isActive ? 'Disable User' : 'Enable User'}
        </button>
        <button
          onClick={() => { if (confirm(`Delete user "${u.name}"? This cannot be undone.`)) delMut.mutate() }}
          disabled={delMut.isPending}
          className="px-3 py-1.5 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
        >
          Delete User
        </button>
      </div>
    </section>
  )
}
