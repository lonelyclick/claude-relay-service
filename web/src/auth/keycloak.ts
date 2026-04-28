import { KC_CONFIG, STORAGE_KEYS } from '~/lib/constants'

function base64UrlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
  return atob(normalized + padding)
}

async function generatePkce() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64UrlEncode(digest)
  return { verifier, challenge }
}

interface StoredTokens {
  access_token: string
  refresh_token?: string
  expires_at: number
}

function writeTokens(data: { access_token: string; refresh_token?: string; expires_in: number }) {
  sessionStorage.setItem(STORAGE_KEYS.KC_TOKENS, JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }))
}

export function getStoredTokens(): StoredTokens | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.KC_TOKENS)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearStoredTokens() {
  sessionStorage.removeItem(STORAGE_KEYS.KC_TOKENS)
  sessionStorage.removeItem(STORAGE_KEYS.KC_VERIFIER)
  sessionStorage.removeItem(STORAGE_KEYS.KC_STATE)
  sessionStorage.removeItem(STORAGE_KEYS.KC_REDIRECT)
}

export function hasStoredTokens(): boolean {
  return Boolean(getStoredTokens()?.access_token)
}

export function getAccessToken(): string | null {
  return getStoredTokens()?.access_token || null
}

export function isTokenFresh(): boolean {
  const tokens = getStoredTokens()
  return Boolean(tokens?.access_token && (!tokens.expires_at || Date.now() < tokens.expires_at - 60000))
}

export async function startLogin() {
  const { verifier, challenge } = await generatePkce()
  const state = crypto.randomUUID()
  sessionStorage.setItem(STORAGE_KEYS.KC_VERIFIER, verifier)
  sessionStorage.setItem(STORAGE_KEYS.KC_STATE, state)
  sessionStorage.setItem(STORAGE_KEYS.KC_REDIRECT, location.pathname + location.search)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: KC_CONFIG.CLIENT_ID,
    redirect_uri: location.origin + '/auth/callback',
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })

  location.href = `${KC_CONFIG.URL}/realms/${KC_CONFIG.REALM}/protocol/openid-connect/auth?${params}`
}

export async function handleCallback(): Promise<string | null> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  const state = params.get('state')
  const providerError = params.get('error_description') || params.get('error')

  if (providerError) {
    clearStoredTokens()
    throw new Error(`登录失败: ${providerError}`)
  }
  if (!code) return null

  const verifier = sessionStorage.getItem(STORAGE_KEYS.KC_VERIFIER)
  const expectedState = sessionStorage.getItem(STORAGE_KEYS.KC_STATE)
  if (!verifier || !expectedState) {
    clearStoredTokens()
    throw new Error('登录流程已失效，请重新发起登录')
  }
  if (!state || state !== expectedState) {
    clearStoredTokens()
    throw new Error('登录状态校验失败，请重新登录')
  }

  const res = await fetch(`${KC_CONFIG.URL}/realms/${KC_CONFIG.REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KC_CONFIG.CLIENT_ID,
      redirect_uri: location.origin + '/auth/callback',
      code,
      code_verifier: verifier,
    }),
  })

  if (!res.ok) {
    clearStoredTokens()
    throw new Error(`登录换取 token 失败: HTTP ${res.status}`)
  }

  const data = await res.json()
  writeTokens(data)

  const redirect = sessionStorage.getItem(STORAGE_KEYS.KC_REDIRECT) || '/dashboard'
  sessionStorage.removeItem(STORAGE_KEYS.KC_VERIFIER)
  sessionStorage.removeItem(STORAGE_KEYS.KC_STATE)
  sessionStorage.removeItem(STORAGE_KEYS.KC_REDIRECT)

  return redirect
}

export async function refreshToken(): Promise<boolean> {
  const tokens = getStoredTokens()
  if (!tokens?.refresh_token) return false

  const res = await fetch(`${KC_CONFIG.URL}/realms/${KC_CONFIG.REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: KC_CONFIG.CLIENT_ID,
      refresh_token: tokens.refresh_token,
    }),
  })

  if (!res.ok) {
    clearStoredTokens()
    return false
  }

  const data = await res.json()
  writeTokens(data)
  return true
}

export async function ensureFreshToken(): Promise<boolean> {
  const tokens = getStoredTokens()
  if (!tokens?.access_token) return false
  if (!tokens.expires_at || Date.now() < tokens.expires_at - 60000) return true
  return refreshToken()
}

export function kcLogout() {
  clearStoredTokens()
  const params = new URLSearchParams({
    client_id: KC_CONFIG.CLIENT_ID,
    post_logout_redirect_uri: location.origin + '/login',
  })
  location.href = `${KC_CONFIG.URL}/realms/${KC_CONFIG.REALM}/protocol/openid-connect/logout?${params}`
}

export function getUserInfo(): { name: string; email: string | null } | null {
  const token = getAccessToken()
  if (!token) return null
  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1] || ''))
    return {
      name: payload.name || payload.preferred_username || payload.email || '',
      email: payload.email || null,
    }
  } catch {
    return null
  }
}
