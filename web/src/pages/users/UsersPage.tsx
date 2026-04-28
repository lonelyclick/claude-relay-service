import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listUsers, createUser } from '~/api/users'
import type { BillingCurrency } from '~/api/types'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge } from '~/components/Badge'
import { useToast } from '~/components/Toast'
import { fmtMoneyMicros, fmtTokens, fmtNum } from '~/lib/format'
import {
  buildUsersListView,
  normalizeUsersLegacyOrderMode,
  normalizeUsersLegacyViewMode,
} from './usersListView'
import { buildLegacyRequestsHref, buildUserDetailHref } from './userDetailLinks'

const billingCurrencies: BillingCurrency[] = ['CNY', 'USD']

export function UsersPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const users = useQuery({ queryKey: ['users'], queryFn: listUsers })
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [billingCurrency, setBillingCurrency] = useState<BillingCurrency>('CNY')
  const legacyViewMode = normalizeUsersLegacyViewMode(searchParams.get('legacyView'))
  const legacyOrderMode = normalizeUsersLegacyOrderMode(searchParams.get('legacyOrder'))

  const createMut = useMutation({
    mutationFn: () => createUser(name, billingCurrency),
    onSuccess: (data) => {
      const label = data.apiKeySource === 'relay_api_keys' ? 'Default relay API key' : 'Legacy API key'
      toast.success(`User created. ${label}: ${data.apiKey ?? '(check detail page)'}`)
      qc.invalidateQueries({ queryKey: ['users'] })
      setName('')
      setShowCreate(false)
    },
    onError: (e) => toast.error(e.message),
  })

  if (users.isLoading) return <PageSkeleton />

  const userList = users.data?.users ?? []
  const visibleUsers = buildUsersListView(userList, legacyViewMode, legacyOrderMode)
  const legacySignalUserCount = userList.filter((user) => (user.relayKeySourceSummary?.legacyFallbackCount ?? 0) > 0).length
  const usersListReturnState = {
    legacyView: legacyViewMode,
    legacyOrder: legacyOrderMode,
  } as const

  const setLegacyViewMode = (nextMode: 'all' | 'legacy-only') => {
    const nextParams = new URLSearchParams(searchParams)
    if (nextMode === 'legacy-only') {
      nextParams.set('legacyView', nextMode)
    } else {
      nextParams.delete('legacyView')
    }
    setSearchParams(nextParams, { replace: true })
  }

  const setLegacyOrderMode = (nextMode: 'default' | 'legacy-first') => {
    const nextParams = new URLSearchParams(searchParams)
    if (nextMode === 'legacy-first') {
      nextParams.set('legacyOrder', nextMode)
    } else {
      nextParams.delete('legacyOrder')
    }
    setSearchParams(nextParams, { replace: true })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-400">
          Users ({fmtNum(visibleUsers.length)}{legacyViewMode === 'legacy-only' ? ` of ${fmtNum(userList.length)}` : ''})
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500"
        >
          {showCreate ? 'Cancel' : 'New User'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) createMut.mutate() }} className="bg-ccdash-card border border-ccdash-border rounded-xl p-4 flex gap-2 items-end max-md:flex-col max-md:items-stretch">
          <label className="space-y-1 flex-1">
            <span className="text-xs text-slate-400">User Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Currency</span>
            <select
              value={billingCurrency}
              onChange={(e) => setBillingCurrency(e.target.value as BillingCurrency)}
              className="block w-full bg-ccdash-input border border-ccdash-border rounded-lg px-3 py-1.5 text-sm text-slate-200"
            >
              {billingCurrencies.map((currency) => (
                <option key={currency} value={currency}>
                  {currency === 'CNY' ? 'RMB (CNY)' : 'USD'}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={createMut.isPending} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
            Create
          </button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setLegacyViewMode('all')}
          className={`px-3 py-1.5 rounded-lg text-sm border ${legacyViewMode === 'all' ? 'bg-ccdash-card-strong border-slate-500 text-slate-100' : 'border-ccdash-border text-slate-400 hover:text-slate-200 hover:border-slate-600'}`}
        >
          All Users
        </button>
        <button
          type="button"
          onClick={() => setLegacyViewMode('legacy-only')}
          className={`px-3 py-1.5 rounded-lg text-sm border ${legacyViewMode === 'legacy-only' ? 'bg-yellow-500/10 border-yellow-500/50 text-yellow-200' : 'border-ccdash-border text-slate-400 hover:text-slate-200 hover:border-yellow-500/40'}`}
        >
          Recent Legacy Fallback Only
        </button>
        <div className="text-xs text-slate-500">
          Recent-window signal based on each user&apos;s last 100 final requests.
        </div>
        <Badge tone={legacySignalUserCount > 0 ? 'yellow' : 'green'}>
          {fmtNum(legacySignalUserCount)} users with recent legacy fallback
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setLegacyOrderMode('default')}
          className={`px-3 py-1.5 rounded-lg text-sm border ${legacyOrderMode === 'default' ? 'bg-ccdash-card-strong border-slate-500 text-slate-100' : 'border-ccdash-border text-slate-400 hover:text-slate-200 hover:border-slate-600'}`}
        >
          Default Order
        </button>
        <button
          type="button"
          onClick={() => setLegacyOrderMode('legacy-first')}
          className={`px-3 py-1.5 rounded-lg text-sm border ${legacyOrderMode === 'legacy-first' ? 'bg-yellow-500/10 border-yellow-500/50 text-yellow-200' : 'border-ccdash-border text-slate-400 hover:text-slate-200 hover:border-yellow-500/40'}`}
        >
          Legacy Fallback First
        </button>
        <div className="text-xs text-slate-500">
          {legacyViewMode === 'legacy-only'
            ? 'Legacy-only view already orders users by recent legacy fallback signal.'
            : 'All view ordering uses recent-window legacy fallback count, then recent request count.'}
        </div>
      </div>

      {visibleUsers.length === 0 ? (
        <div className="text-center text-slate-500 py-8">
          {userList.length === 0
            ? 'No users yet.'
            : 'No users match the current recent-window legacy fallback view.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-ccdash-border">
                <th className="text-left py-2 px-3">Name</th>
                <th className="text-left py-2 px-3">Legacy Key Preview</th>
                <th className="text-left py-2 px-3">Legacy Fallback</th>
                <th className="text-center py-2 px-3">Routing</th>
                <th className="text-center py-2 px-3">Billing</th>
                <th className="text-right py-2 px-3">Balance</th>
                <th className="text-right py-2 px-3">Sessions</th>
                <th className="text-right py-2 px-3">Requests</th>
                <th className="text-right py-2 px-3">Tokens</th>
                <th className="text-center py-2 px-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => (
                <tr key={u.id} className="border-b border-ccdash-border/50 hover:bg-ccdash-card-strong/30">
                  <td className="py-2 px-3">
                    <Link
                      to={buildUserDetailHref(u.id, {}, undefined, usersListReturnState)}
                      className="text-blue-400 hover:underline font-medium"
                    >
                      {u.name}
                    </Link>
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-slate-500">{u.apiKeyPreview ?? '—'}</td>
                  <td className="py-2 px-3">
                    {u.relayKeySourceSummary ? (
                      <div className="space-y-1">
                        <Badge tone={u.relayKeySourceSummary.legacyFallbackCount > 0 ? 'yellow' : u.relayKeySourceSummary.countedRequests > 0 ? 'green' : 'gray'}>
                          {u.relayKeySourceSummary.legacyFallbackCount > 0
                            ? `${fmtNum(u.relayKeySourceSummary.legacyFallbackCount)} legacy fallback`
                            : u.relayKeySourceSummary.countedRequests > 0
                              ? '0 legacy fallback'
                              : 'No recent usage'}
                        </Badge>
                        <div className="text-xs text-slate-500">
                          {u.relayKeySourceSummary.countedRequests > 0
                            ? `${fmtNum(u.relayKeySourceSummary.countedRequests)} recent final requests`
                            : `window ${fmtNum(u.relayKeySourceSummary.recentWindowLimit)} final requests`}
                        </div>
                        {u.relayKeySourceSummary.legacyFallbackCount > 0 ? (
                          <Link
                            to={buildLegacyRequestsHref(u.id, usersListReturnState)}
                            className="inline-flex text-xs text-yellow-300 hover:text-yellow-200 hover:underline"
                          >
                            View legacy requests
                          </Link>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center">
                    <Badge tone={u.routingMode === 'auto' ? 'green' : u.routingMode === 'pinned_account' ? 'blue' : 'cyan'}>
                      {u.routingMode ?? 'auto'}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-center">
                    <Badge tone={u.billingMode === 'prepaid' ? 'yellow' : 'gray'}>
                      {u.billingMode ?? 'postpaid'}
                    </Badge>
                    <div className="mt-1">
                      <Badge tone="blue">{u.billingCurrency ?? 'USD'}</Badge>
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtMoneyMicros(u.balanceMicros ?? '0', u.billingCurrency ?? 'USD')}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtNum(u.sessionCount ?? 0)}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtNum(u.totalRequests ?? 0)}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{fmtTokens((u.totalInputTokens ?? 0) + (u.totalOutputTokens ?? 0))}</td>
                  <td className="py-2 px-3 text-center">
                    <Badge tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'Active' : 'Disabled'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
