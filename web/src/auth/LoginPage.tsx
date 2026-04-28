import { useState } from 'react'
import { Navigate } from 'react-router'
import { useAuth } from './AuthProvider'
import { BUILD_TIME, BUILD_VERSION } from '~/lib/constants'

export function LoginPage() {
  const { isAuthenticated, isLoading, login, error: authError } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const relayRows = [
    { label: 'Claude Code', value: 'Claude OAuth / Claude-compatible', tone: 'text-amber-300' },
    { label: 'OpenAI', value: 'Codex OAuth / OpenAI-compatible', tone: 'text-emerald-300' },
    { label: 'Routing', value: 'Account pools, sticky sessions, guard rails', tone: 'text-cyan-300' },
  ]
  const stats = [
    ['Providers', '4'],
    ['Protocols', 'Claude + OpenAI'],
    ['Console', 'Billing + Usage'],
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-ccdash-bg">
        <div className="text-slate-400 text-sm">Connecting...</div>
      </div>
    )
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />
  }

  const handleLogin = async () => {
    setError(null)
    try {
      await login()
    } catch (err) {
      setError((err as Error)?.message || '无法发起登录')
    }
  }

  return (
    <div className="min-h-screen bg-ccdash-bg text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center gap-10 px-6 py-10 max-lg:flex-col max-lg:items-stretch max-lg:justify-center">
        <section className="flex-1">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
            Yoho AI Relay
          </div>
          <h1 className="max-w-3xl text-5xl font-semibold leading-tight text-white max-md:text-3xl">
            Claude Code 与 OpenAI 的统一中转控制台
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-400">
            管理 Claude 官方 OAuth、Claude-compatible、OpenAI Codex 和 OpenAI-compatible 上游账号，统一处理路由、用量、计费与健康状态。
          </p>

          <div className="mt-8 grid max-w-2xl grid-cols-3 gap-3 max-sm:grid-cols-1">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-ccdash-border bg-white/[0.03] px-4 py-3">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
                <div className="mt-1 text-sm font-medium text-slate-100">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-8 max-w-2xl rounded-lg border border-ccdash-border bg-ccdash-card/70 p-2 shadow-2xl shadow-black/20">
            {relayRows.map((row) => (
              <div key={row.label} className="grid grid-cols-[8rem_1fr] items-center gap-3 rounded-md px-4 py-3 text-sm max-sm:grid-cols-1 max-sm:gap-1">
                <div className={`font-semibold ${row.tone}`}>{row.label}</div>
                <div className="text-slate-400">{row.value}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="w-full max-w-sm rounded-xl border border-ccdash-border bg-ccdash-card p-7 shadow-xl">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
            Relay Admin
          </div>
          <h2 className="mb-2 text-2xl font-bold text-slate-100">Yoho Relay Admin</h2>
          <p className="mb-6 text-sm text-slate-400">
            使用公司 SSO 登录后进入账号池、路由与用量管理。
          </p>

          <div className="mb-6 space-y-3">
            {['Claude Code / OpenAI 中转管理', '用量、模型分布与限额压力分析', 'Yoho SSO 保护'].map((text) => (
              <div key={text} className="flex items-center gap-2 text-xs text-slate-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
                <span>{text}</span>
              </div>
            ))}
          </div>

          {(error || authError) && (
            <p className="mb-4 text-sm text-red-400">{error || authError}</p>
          )}

          <button
            onClick={handleLogin}
            className="w-full cursor-pointer rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-100"
          >
            使用 Yoho SSO 登录
          </button>

          <div className="mt-4 text-[11px] text-slate-500" title={`Build ${BUILD_TIME}`}>
            Build <span className="font-mono text-slate-400">{BUILD_VERSION}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
