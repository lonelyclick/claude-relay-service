import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import * as kc from './keycloak'
import * as authApi from '~/api/auth'
import { clearAdminSession } from '~/api/client'

interface AuthUser {
  name: string
  email: string | null
}

interface AuthState {
  isAuthenticated: boolean
  isLoading: boolean
  user: AuthUser | null
  error: string | null
}

interface AuthContextValue extends AuthState {
  login: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    user: null,
    error: null,
  })

  useEffect(() => {
    void boot()
  }, [])

  async function boot() {
    try {
      try {
        const session = await authApi.getAdminSession()
        const sessionUser = (session?.user as AuthUser) || null
        setState({
          isAuthenticated: true,
          isLoading: false,
          user: sessionUser,
          error: null,
        })
        return
      } catch (err) {
        if ((err as { status?: number })?.status !== 401) {
          throw err
        }
      }

      if (!kc.hasStoredTokens()) {
        setState({ isAuthenticated: false, isLoading: false, user: null, error: null })
        return
      }

      const refreshed = await kc.ensureFreshToken()
      if (!refreshed) {
        setState({ isAuthenticated: false, isLoading: false, user: null, error: null })
        return
      }

      const session = await ensureAdminSession()
      const user = (session?.user as AuthUser) || kc.getUserInfo()
      setState({ isAuthenticated: true, isLoading: false, user, error: null })
    } catch (err) {
      clearAdminSession()
      setState({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        error: (err as Error)?.message || '管理台启动失败',
      })
    }
  }

  async function ensureAdminSession() {
    try {
      return await authApi.getAdminSession()
    } catch (err) {
      if ((err as { status?: number })?.status !== 401) throw err
    }
    const accessToken = kc.getAccessToken()
    if (!accessToken) throw new Error('当前登录态缺少 access token，请重新登录')
    return authApi.exchangeAdminSession(accessToken)
  }

  const login = useCallback(async () => {
    await kc.startLogin()
  }, [])

  const logout = useCallback(async () => {
    try {
      await authApi.logoutAdminSession()
    } catch {
      clearAdminSession()
    } finally {
      kc.kcLogout()
    }
  }, [])

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
