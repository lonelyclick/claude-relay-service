import { Navigate, Outlet } from 'react-router'
import { useAuth } from './AuthProvider'

export function RequireAuth() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-ccdash-bg">
        <div className="text-slate-400 text-sm">Connecting...</div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}
