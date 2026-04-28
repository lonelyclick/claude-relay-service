import { useQuery } from '@tanstack/react-query'
import { listAccounts } from '~/api/accounts'
import { listProxies } from '~/api/proxies'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { needsProxyWarning } from '~/lib/account'
import { AccountCard } from './AccountCard'
import type { Account } from '~/api/types'

function needsRecovery(a: Account): boolean {
  return (
    a.schedulerState === 'auto_blocked' ||
    !a.isActive ||
    !a.hasAccessToken ||
    needsProxyWarning(a) ||
    (a.authMode === 'oauth' && !a.hasRefreshToken) ||
    !!a.lastError
  )
}

export function RecoveryPage() {
  const { data, isLoading } = useQuery({ queryKey: ['accounts'], queryFn: listAccounts })
  const proxies = useQuery({ queryKey: ['proxies'], queryFn: listProxies })

  if (isLoading) return <PageSkeleton />

  const recovery = (data?.accounts ?? []).filter(needsRecovery)
  const proxyList = proxies.data?.proxies ?? []

  if (recovery.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="text-2xl text-slate-300 mb-2">All Clear</div>
        <div className="text-sm text-slate-500">No accounts need attention right now.</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-400">{recovery.length} account{recovery.length > 1 ? 's' : ''} need attention</div>
      <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
        {recovery.map((a) => (
          <AccountCard key={a.id} account={a} proxies={proxyList} />
        ))}
      </div>
    </div>
  )
}
