import { useAuth } from '~/auth/AuthProvider'
import { BUILD_TIME, BUILD_VERSION } from '~/lib/constants'

export function Topbar() {
  const { user, isAuthenticated, logout } = useAuth()

  return (
    <header className="sticky top-0 z-40 h-11 border-b border-border-default bg-bg-primary/90 backdrop-blur-md shadow-xs">
      <div className="flex items-center justify-between h-full px-5 max-w-[1280px] mx-auto w-full">
        <div className="flex items-center gap-3">
          <h1 className="text-[13px] font-semibold tracking-tight text-slate-100">
            CC Relay
          </h1>
          {isAuthenticated && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium ring-1 ring-emerald-500/20">
              Connected
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {user && (
            <span className="text-[11px] text-slate-500">{user.name || user.email}</span>
          )}
          <span
            className="text-[10px] px-2 py-0.5 rounded-full bg-accent-muted text-indigo-300 font-mono font-medium"
            title={`Build ${BUILD_TIME}`}
          >
            {BUILD_VERSION}
          </span>
          <button
            onClick={logout}
            className="btn btn-sm text-xs text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-md"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  )
}
