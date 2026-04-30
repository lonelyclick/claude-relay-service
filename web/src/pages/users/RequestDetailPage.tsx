import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { getRequestDetail } from '~/api/users'
import { PageSkeleton } from '~/components/LoadingSkeleton'
import { Badge } from '~/components/Badge'
import { fmtNum, fmtTokens } from '~/lib/format'
import { buildUserDetailReturnHref, readUserDetailReturnState } from './userDetailLinks'

function relayKeySourceLabel(source: 'relay_api_keys' | 'relay_users_legacy' | null | undefined): string {
  if (source === 'relay_api_keys') return 'relay_api_keys'
  if (source === 'relay_users_legacy') return 'legacy key'
  return 'unknown'
}

function relayKeySourceTone(source: 'relay_api_keys' | 'relay_users_legacy' | null | undefined) {
  if (source === 'relay_api_keys') return 'cyan' as const
  if (source === 'relay_users_legacy') return 'yellow' as const
  return 'gray' as const
}

export function RequestDetailPage() {
  const { id: userId, requestId } = useParams<{ id: string; requestId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const usageRecordIdParam = searchParams.get('usageRecordId')
  const usageRecordId = usageRecordIdParam != null ? Number(usageRecordIdParam) : undefined
  const backToUserHref = buildUserDetailReturnHref(
    userId!,
    readUserDetailReturnState(searchParams),
    { sessionRequestId: requestId ?? null },
  )

  const detail = useQuery({
    queryKey: ['request-detail', userId, requestId, usageRecordId],
    queryFn: () => getRequestDetail(
      userId!,
      requestId!,
      Number.isFinite(usageRecordId) ? usageRecordId : undefined,
    ),
  })

  if (detail.isLoading) return <PageSkeleton />
  if (detail.error) return <div className="text-red-400 text-sm">Failed to load request: {(detail.error as Error).message}</div>

  const r = detail.data!

  return (
    <div className="space-y-5">
      <button onClick={() => navigate(backToUserHref)} className="text-sm text-slate-400 hover:text-slate-200">
        &larr; Back to User
      </button>

      <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-100">Request Detail</h2>
            <div className="text-xs text-slate-500 font-mono">{r.requestId}</div>
            {r.usageRecordId != null && <div className="text-[11px] text-slate-600 font-mono mt-1">usage #{r.usageRecordId}</div>}
          </div>
          <Badge tone={r.statusCode != null && r.statusCode < 400 ? 'green' : r.statusCode != null && r.statusCode >= 400 ? 'red' : 'gray'}>
            {r.statusCode != null ? String(r.statusCode) : '—'}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs max-md:grid-cols-1">
          <div className="text-slate-400">Model: <span className="text-slate-200">{r.model ?? '—'}</span></div>
          <div className="text-slate-400">Time: <span className="text-slate-200">{new Date(r.createdAt).toLocaleString()}</span></div>
          <div className="text-slate-400">Input Tokens: <span className="text-slate-200">{fmtTokens(r.inputTokens)}</span></div>
          <div className="text-slate-400">Output Tokens: <span className="text-slate-200">{fmtTokens(r.outputTokens)}</span></div>
          {r.cacheReadTokens != null && <div className="text-slate-400">Cache Read: <span className="text-slate-200">{fmtTokens(r.cacheReadTokens)}</span></div>}
          {r.cacheCreationTokens != null && <div className="text-slate-400">Cache Creation: <span className="text-slate-200">{fmtTokens(r.cacheCreationTokens)}</span></div>}
          <div className="text-slate-400">Duration: <span className="text-slate-200">{r.durationMs ? `${fmtNum(r.durationMs)}ms` : '—'}</span></div>
          <div className="text-slate-400">Account: <span className="text-slate-200">{r.accountId ?? '—'}</span></div>
          <div className="text-slate-400">Key Source: <Badge tone={relayKeySourceTone(r.relayKeySource)}>{relayKeySourceLabel(r.relayKeySource)}</Badge></div>
          {r.target && <div className="text-slate-400">Target: <span className="text-slate-200">{r.target}</span></div>}
          {r.clientDeviceId && <div className="text-slate-400">Device: <span className="text-slate-200">{r.clientDeviceId}</span></div>}
          {r.sessionKey && <div className="text-slate-400">Session: <span className="text-slate-200 font-mono">{r.sessionKey}</span></div>}
        </div>
      </section>

      {r.requestHeaders != null && (
        <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-2">Request Headers</div>
          <pre className="text-xs text-slate-300 whitespace-pre-wrap break-words max-h-64 overflow-y-auto bg-bg-input rounded-lg p-3">{JSON.stringify(r.requestHeaders, null, 2)}</pre>
        </section>
      )}

      {r.requestBodyPreview && (
        <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-2">Request Body Preview</div>
          <pre className="text-xs text-slate-300 whitespace-pre-wrap break-words max-h-96 overflow-y-auto bg-bg-input rounded-lg p-3">{r.requestBodyPreview}</pre>
        </section>
      )}

      {r.responseHeaders != null && (
        <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-2">Response Headers</div>
          <pre className="text-xs text-slate-300 whitespace-pre-wrap break-words max-h-64 overflow-y-auto bg-bg-input rounded-lg p-3">{JSON.stringify(r.responseHeaders, null, 2)}</pre>
        </section>
      )}

      {r.responseBodyPreview && (
        <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-2">Response Body Preview</div>
          <pre className="text-xs text-slate-300 whitespace-pre-wrap break-words max-h-96 overflow-y-auto bg-bg-input rounded-lg p-3">{r.responseBodyPreview}</pre>
        </section>
      )}

      {r.upstreamRequestHeaders != null && (
        <section className="bg-bg-card border border-border-default rounded-xl p-5 shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-2">Upstream Request Headers</div>
          <pre className="text-xs text-slate-300 whitespace-pre-wrap break-words max-h-64 overflow-y-auto bg-bg-input rounded-lg p-3">{JSON.stringify(r.upstreamRequestHeaders, null, 2)}</pre>
        </section>
      )}
    </div>
  )
}
