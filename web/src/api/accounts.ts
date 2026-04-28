import { get, post } from './client'
import type { Account, RateLimitProbe } from './types'

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value
  return new Date(timestamp).toISOString()
}

function toPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return value * 100
}

function normalizeRateLimitProbe(probe: RateLimitProbe): RateLimitProbe {
  return {
    ...probe,
    requestUtilization: toPercent(probe.requestUtilization) ?? probe.requestUtilization,
    tokenUtilization: toPercent(probe.tokenUtilization) ?? probe.tokenUtilization,
    fallbackPercentage: toPercent(probe.fallbackPercentage) ?? probe.fallbackPercentage,
    fiveHourUtilization: toPercent(probe.fiveHourUtilization) ?? probe.fiveHourUtilization,
    sevenDayUtilization: toPercent(probe.sevenDayUtilization) ?? probe.sevenDayUtilization,
    reset: toIsoTimestamp(probe.reset) ?? probe.reset,
    fiveHourReset: toIsoTimestamp(probe.fiveHourReset) ?? probe.fiveHourReset,
    sevenDayReset: toIsoTimestamp(probe.sevenDayReset) ?? probe.sevenDayReset,
    overageReset: toIsoTimestamp(probe.overageReset) ?? probe.overageReset,
  }
}

export const listAccounts = () => get<{ accounts: Account[] }>('/admin/accounts')
export const getAccount = async (id: string) => {
  const res = await get<{ account: Account }>(`/admin/accounts/${enc(id)}`)
  return res.account
}
export const deleteAccount = (id: string) => post(`/admin/accounts/${enc(id)}/delete`)
export const refreshAccount = (id: string) => post(`/admin/accounts/${enc(id)}/refresh`)
export const updateAccountSettings = (id: string, settings: Record<string, unknown>) =>
  post(`/admin/accounts/${enc(id)}/settings`, settings)
export const clearAccounts = () => post('/admin/account/clear')
export const createAccount = (email: string, password: string, label: string, routingGroupId?: string) =>
  post('/admin/accounts/create', { email, password, label, routingGroupId })
export const createOpenAICompatibleAccount = (payload: Record<string, unknown>) =>
  post('/admin/accounts/create', { provider: 'openai-compatible', ...payload })
export const createClaudeCompatibleAccount = (payload: Record<string, unknown>) =>
  post('/admin/accounts/create', { provider: 'claude-compatible', ...payload })
export const probeRateLimit = async (id: string) => {
  const res = await get<RateLimitProbe>(`/admin/accounts/${enc(id)}/ratelimit`)
  return normalizeRateLimitProbe(res)
}

export const generateAuthUrl = async (expiresIn?: number, provider?: string) => {
  const res = await post<{
    session: {
      sessionId: string
      authUrl: string
    }
    instructions?: string[]
  }>('/admin/oauth/generate-auth-url', {
    ...(expiresIn ? { expiresIn } : {}),
    ...(provider ? { provider } : {}),
  })
  return {
    sessionId: res.session.sessionId,
    authUrl: res.session.authUrl,
    instructions: res.instructions ?? [],
  }
}
export const exchangeCode = (sessionId: string, authorizationInput: string, label: string, accountId?: string, options?: Record<string, unknown>) =>
  post('/admin/oauth/exchange-code', { sessionId, authorizationInput, label, accountId, ...options })
export const loginWithSessionKey = (sessionKey: string, label: string, options?: Record<string, unknown>) =>
  post('/admin/oauth/login-with-session-key', { sessionKey, label, ...options })
export const importTokens = (accessToken: string, refreshToken: string | undefined, label: string, options?: Record<string, unknown>) =>
  post('/admin/oauth/import-tokens', { accessToken, refreshToken: refreshToken || undefined, label, ...options })
export const refreshAll = () => post('/admin/oauth/refresh')

function enc(v: string) { return encodeURIComponent(v) }
