import * as api from './api.js'
import * as auth from './auth.js'
import { renderDashboard } from './pages/dashboard.js'
import { renderAccounts } from './pages/accounts.js'
import { renderScheduler } from './pages/scheduler.js'
import { renderUsage } from './pages/usage.js'
import { renderVpn } from './pages/vpn.js'
import { renderUsers } from './pages/users.js'

const API_URL = resolveApiUrl()
let pollTimer = null

const toastContainer = document.createElement('div')
toastContainer.className = 'toast-container'
document.body.appendChild(toastContainer)

export function toast(message, type = 'success') {
  const el = document.createElement('div')
  el.className = 'toast toast-' + type
  el.textContent = message
  toastContainer.appendChild(el)
  setTimeout(() => el.remove(), 3500)
}

const pages = {
  dashboard: { el: () => document.getElementById('page-dashboard'), render: renderDashboard },
  accounts: { el: () => document.getElementById('page-accounts'), render: renderAccounts },
  scheduler: { el: () => document.getElementById('page-scheduler'), render: renderScheduler },
  usage: { el: () => document.getElementById('page-usage'), render: renderUsage },
  network: { el: () => document.getElementById('page-network'), render: renderVpn },
  users: { el: () => document.getElementById('page-users'), render: renderUsers },
}

let currentPage = 'dashboard'

function resolveApiUrl() {
  const meta = document.querySelector('meta[name="cc-api-base-url"]')
  const value = meta?.getAttribute('content')?.trim()
  return value || location.origin
}

function parseHashRoute(hashValue = location.hash) {
  const raw = String(hashValue || '').replace(/^#/, '')
  const [pagePart, query = ''] = raw.split('?')
  return {
    page: pagePart || 'dashboard',
    params: new URLSearchParams(query),
  }
}

function buildHashRoute(page, params = null) {
  const searchParams = params instanceof URLSearchParams
    ? new URLSearchParams(params)
    : new URLSearchParams(params || undefined)
  const query = searchParams.toString()
  return query ? `#${page}?${query}` : `#${page}`
}

function normalizeRoute(route) {
  const params = route?.params instanceof URLSearchParams
    ? new URLSearchParams(route.params)
    : new URLSearchParams(route?.params || undefined)
  let page = route?.page || 'dashboard'

  if (page === 'add-account') {
    page = 'accounts'
    if (!params.has('tab')) {
      params.set('tab', 'onboard')
    }
  } else if (page === 'sessions') {
    page = 'scheduler'
    if (!params.has('tab')) {
      params.set('tab', 'live-routes')
    }
  } else if (page === 'vpn') {
    page = 'network'
  }

  return { page, params }
}

function setConnectionStatus(text, tone = 'gray') {
  const el = document.getElementById('connection-status')
  el.className = 'badge badge-' + tone
  el.textContent = text
}

function setLoginError(message = '') {
  const el = document.getElementById('login-error')
  if (!el) return
  el.textContent = message
  el.hidden = !message
}

function showLoginOverlay(message = '') {
  stopPolling()
  document.getElementById('app').hidden = true
  document.getElementById('login-overlay').hidden = false
  document.getElementById('user-display').textContent = ''
  document.getElementById('api-url-display').textContent = API_URL
  setConnectionStatus('Signed Out', 'gray')
  setLoginError(message)
}

function navigate(page, options = {}) {
  const normalized = normalizeRoute({
    page,
    params: options.params,
  })
  const nextPage = normalized.page
  if (!pages[nextPage]) return
  currentPage = nextPage
  const params = normalized.params
  const nextHash = buildHashRoute(nextPage, params)
  if (location.hash !== nextHash) {
    if (options.replace) {
      history.replaceState(null, '', nextHash)
    } else {
      location.hash = nextHash
    }
  }
  for (const [key, { el }] of Object.entries(pages)) {
    const node = el()
    if (node) node.hidden = key !== nextPage
  }
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === nextPage)
  })
  pages[nextPage].render(undefined, params)
}

export function refreshCurrentPage() {
  if (pages[currentPage]) {
    const route = parseHashRoute(location.hash)
    const normalized = normalizeRoute(route)
    const params = normalized.page === currentPage ? normalized.params : undefined
    pages[currentPage].render(undefined, params)
  }
}

function showApp(adminUser) {
  document.getElementById('login-overlay').hidden = true
  document.getElementById('app').hidden = false
  const user = adminUser || api.getAdminSessionState()?.user || auth.getUserInfo()
  document.getElementById('user-display').textContent = user?.name || user?.email || ''
  document.getElementById('api-url-display').textContent = API_URL
  setConnectionStatus('Connected', 'green')
  const route = parseHashRoute(location.hash)
  const normalized = normalizeRoute(route)
  navigate(normalized.page || 'dashboard', { params: normalized.params, replace: true })
  startPolling()
}

function startPolling() {
  stopPolling()
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function ensureAdminSession() {
  try {
    return await api.getAdminSession()
  } catch (error) {
    if (error?.status !== 401) {
      throw error
    }
  }

  const accessToken = auth.getAccessToken()
  if (!accessToken) {
    throw new Error('当前登录态缺少 access token，请重新登录')
  }
  return api.exchangeAdminSession(accessToken)
}

document.getElementById('kc-login-btn').addEventListener('click', () => {
  setLoginError('')
  auth.startLogin().catch((error) => {
    setLoginError(error?.message || '无法发起登录')
  })
})

document.getElementById('logout-btn').addEventListener('click', async () => {
  stopPolling()
  setConnectionStatus('Signing Out', 'yellow')
  try {
    await api.logoutAdminSession()
  } catch {
    api.clearAdminSession()
  }
  api.clearConfig()
  auth.kcLogout()
})

document.getElementById('refresh-btn').addEventListener('click', () => refreshCurrentPage())

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault()
    navigate(item.dataset.page)
  })
})

window.addEventListener('hashchange', () => {
  const route = parseHashRoute(location.hash)
  const normalized = normalizeRoute(route)
  if (normalized.page && pages[normalized.page]) {
    navigate(normalized.page, { params: normalized.params, replace: true })
  }
})

async function boot() {
  api.configure(API_URL)
  document.getElementById('api-url-display').textContent = API_URL
  setConnectionStatus('Connecting', 'yellow')
  setLoginError('')

  try {
    if (location.pathname === '/auth/callback' || location.search.includes('code=')) {
      await auth.handleCallback()
    }

    if (!auth.hasStoredTokens()) {
      showLoginOverlay('请先登录 CC桥 管理台账号')
      return
    }

    const refreshed = await auth.ensureFreshToken()
    if (!refreshed) {
      showLoginOverlay('登录已过期，请重新登录')
      return
    }

    const session = await ensureAdminSession()
    showApp(session?.user)
  } catch (error) {
    console.error('[boot] failed:', error)
    api.clearAdminSession()
    setConnectionStatus('Auth Error', 'red')
    showLoginOverlay(error?.message || '管理台启动失败')
  }
}

boot()
