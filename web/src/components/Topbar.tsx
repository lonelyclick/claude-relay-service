import { useAuth } from '~/auth/AuthProvider'
import { useQueryClient } from '@tanstack/react-query'
import { API_URL, BUILD_TIME, BUILD_VERSION } from '~/lib/constants'

export function Topbar() {
  const { user, isAuthenticated, logout } = useAuth()
  const queryClient = useQueryClient()

  return (
    <header className="sticky top-0 z-40 h-11 border-b border-ccdash-border bg-ccdash-bg/95 backdrop-blur-sm">
      <div className="flex items-center justify-between h-full px-5 max-w-[1200px] mx-auto w-full">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold text-slate-100">CC Dash</h1>
          {isAuthenticated && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 font-medium">
              Connected
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {user && (
            <span className="text-xs text-slate-400">{user.name || user.email}</span>
          )}
          <span
            className="text-[11px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 font-mono"
            title={`Build ${BUILD_TIME}`}
          >
            {BUILD_VERSION}
          </span>
          <span className="text-xs text-slate-500 hidden sm:inline">{API_URL}</span>
          <button
            onClick={() => queryClient.invalidateQueries()}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 rounded-md hover:bg-ccdash-card transition-colors cursor-pointer"
            title="Refresh"
          >
            &#x21bb;
          </button>
          <button
            onClick={logout}
            className="px-2 py-1 text-xs text-red-400 hover:text-red-300 rounded-md hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  )
}
