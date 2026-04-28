/** @typedef {{ apiUrl: string }} ApiConfig */
/** @typedef {{ csrfToken: string, user?: unknown }} AdminSessionState */

const ADMIN_SESSION_STORAGE_KEY = 'ccdash-admin-session'

let _config = /** @type {ApiConfig | null} */ (null)

function readAdminSession() {
  try {
    const raw = sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeAdminSession(state) {
  sessionStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(state))
}

export function setAdminSession(csrfToken, user) {
  if (!csrfToken) return
  writeAdminSession({ csrfToken, user })
}

export function getAdminSessionState() {
  return readAdminSession()
}

export function clearAdminSession() {
  sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY)
}

export function configure(apiUrl) {
  _config = { apiUrl: apiUrl.replace(/\/$/, '') }
}

export function isConfigured() {
  return _config !== null
}

export function getConfig() {
  return _config
}

export function clearConfig() {
  _config = null
  clearAdminSession()
}

async function request(method, path, body, options = {}) {
  if (!_config) throw new Error('API not configured')
  const url = `${_config.apiUrl}${path}`
  const headers = new Headers(options.headers || {})
  const adminSession = readAdminSession()

  if (body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (options.bearerToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${options.bearerToken}`)
  }

  if (path.startsWith('/admin') && !path.startsWith('/admin/session/') && adminSession?.csrfToken && !headers.has('X-Admin-CSRF')) {
    headers.set('X-Admin-CSRF', adminSession.csrfToken)
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })

  const rawText = await res.text()
  let data = null
  if (rawText) {
    try {
      data = JSON.parse(rawText)
    } catch {
      data = rawText
    }
  }

  if (!res.ok) {
    const message =
      data?.message || data?.error?.message || data?.error || (typeof data === 'string' ? data : `HTTP ${res.status}`)
    const error = new Error(message)
    error.status = res.status
    error.payload = data
    throw error
  }

  return data
}

export async function getAdminSession() {
  const data = await request('GET', '/admin/session/me')
  if (data?.csrfToken) {
    setAdminSession(data.csrfToken, data.user)
  }
  return data
}

export async function exchangeAdminSession(accessToken) {
  const data = await request('POST', '/admin/session/exchange', undefined, { bearerToken: accessToken })
  if (data?.csrfToken) {
    setAdminSession(data.csrfToken, data.user)
  }
  return data
}

export async function logoutAdminSession() {
  try {
    return await request('POST', '/admin/session/logout')
  } finally {
    clearAdminSession()
  }
}

// Health
export const healthz = () => request('GET', '/healthz')

// Accounts
export const listAccounts = () => request('GET', '/admin/accounts')
export const getAccount = (id) => request('GET', `/admin/accounts/${encodeURIComponent(id)}`)
export const deleteAccount = (id) => request('POST', `/admin/accounts/${encodeURIComponent(id)}/delete`)
export const refreshAccount = (id) => request('POST', `/admin/accounts/${encodeURIComponent(id)}/refresh`)
export const updateAccountSettings = (id, settings) => request('POST', `/admin/accounts/${encodeURIComponent(id)}/settings`, settings)
export const clearAccounts = () => request('POST', '/admin/account/clear')
export const createAccount = (email, password, label, routingGroupId) =>
  request('POST', '/admin/accounts/create', { email, password, label, routingGroupId })
export const createOpenAICompatibleAccount = (payload) => request('POST', '/admin/accounts/create', {
  provider: 'openai-compatible',
  ...payload,
})

// Routing Groups
export const listRoutingGroups = () => request('GET', '/admin/routing-groups')
export const createRoutingGroup = (payload) => request('POST', '/admin/routing-groups', payload)
export const updateRoutingGroup = (id, payload) =>
  request('POST', `/admin/routing-groups/${encodeURIComponent(id)}/update`, payload)
export const deleteRoutingGroup = (id) =>
  request('POST', `/admin/routing-groups/${encodeURIComponent(id)}/delete`)

// OAuth
export const generateAuthUrl = (expiresIn, provider) => request(
  'POST',
  '/admin/oauth/generate-auth-url',
  {
    ...(expiresIn ? { expiresIn } : {}),
    ...(provider ? { provider } : {}),
  },
)
export const exchangeCode = (sessionId, authorizationInput, label, accountId, options = {}) =>
  request('POST', '/admin/oauth/exchange-code', {
    sessionId,
    authorizationInput,
    label,
    accountId,
    ...options,
  })
export const loginWithSessionKey = (sessionKey, label, options = {}) =>
  request('POST', '/admin/oauth/login-with-session-key', { sessionKey, label, ...options })
export const importTokens = (accessToken, refreshToken, label, options = {}) =>
  request('POST', '/admin/oauth/import-tokens', {
    accessToken,
    refreshToken: refreshToken || undefined,
    label,
    ...options,
  })
export const refreshAll = () => request('POST', '/admin/oauth/refresh')
export const probeRateLimit = (id) => request('GET', `/admin/accounts/${encodeURIComponent(id)}/ratelimit`)

// Sessions
export const listStickySessions = () => request('GET', '/admin/sticky-sessions')
export const clearStickySessions = () => request('POST', '/admin/sticky-sessions/clear')
export const listSessionRoutes = () => request('GET', '/admin/session-routes')
export const clearSessionRoutes = () => request('POST', '/admin/session-routes/clear')

// Scheduler
export const getSchedulerStats = () => request('GET', '/admin/scheduler/stats')

// Usage
export const getUsageSummary = (since) => request('GET', `/admin/usage/summary${since ? '?since=' + encodeURIComponent(since) : ''}`)
export const getUsageAccounts = (since) => request('GET', `/admin/usage/accounts${since ? '?since=' + encodeURIComponent(since) : ''}`)
export const getUsageAccountDetail = (id, since) => request('GET', `/admin/usage/accounts/${encodeURIComponent(id)}${since ? '?since=' + encodeURIComponent(since) : ''}`)
export const getUsageTrend = (days) => request('GET', `/admin/usage/trend?days=${days}`)

// Users
export const listUsers = () => request('GET', '/admin/users')
export const createUser = (name) => request('POST', '/admin/users', { name })
export const getUser = (id) => request('GET', `/admin/users/${encodeURIComponent(id)}`)
export const getUserApiKey = (id) => request('GET', `/admin/users/${encodeURIComponent(id)}/api-key`)
export const updateUser = (id, updates) => request('POST', `/admin/users/${encodeURIComponent(id)}/update`, updates)
export const deleteUser = (id) => request('POST', `/admin/users/${encodeURIComponent(id)}/delete`)
export const regenerateUserKey = (id) => request('POST', `/admin/users/${encodeURIComponent(id)}/regenerate-key`)
export const getUserSessions = (id) => request('GET', `/admin/users/${encodeURIComponent(id)}/sessions`)
export const getUserRequests = (id, limit = 50, offset = 0) => request('GET', `/admin/users/${encodeURIComponent(id)}/requests?limit=${limit}&offset=${offset}`)
export const getSessionRequests = (userId, sessionKey, limit = 100, offset = 0) => request('GET', `/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionKey)}/requests?limit=${limit}&offset=${offset}`)
export const getRequestDetail = (userId, requestId) => request('GET', `/admin/users/${encodeURIComponent(userId)}/requests/${encodeURIComponent(requestId)}`)

// Proxies / VPN
export const listProxies = () => request('GET', '/admin/proxies')
export const addProxy = (label, url) => request('POST', '/admin/proxies', { label, url })
export const updateProxy = (id, updates) => request('POST', `/admin/proxies/${encodeURIComponent(id)}/update`, updates)
export const deleteProxy = (id) => request('POST', `/admin/proxies/${encodeURIComponent(id)}/delete`)
export const linkAccountsToProxy = (proxyId, accountIds) => request('POST', `/admin/proxies/${encodeURIComponent(proxyId)}/link`, { accountIds })
export const unlinkAccountFromProxy = (proxyId, accountId) => request('POST', `/admin/proxies/${encodeURIComponent(proxyId)}/unlink`, { accountId })
export const probeProxy = (proxyId) => request('POST', `/admin/proxies/${encodeURIComponent(proxyId)}/probe`)
