const runtimeConfig = window.__CCDASH_RUNTIME__ || {}
const KC_URL = (runtimeConfig.keycloakUrl || 'https://auth.yohomobile.dev').replace(/\/+$/, '')
const KC_REALM = runtimeConfig.keycloakRealm || 'yoho'
const KC_CLIENT_ID = runtimeConfig.keycloakClientId || 'ccdash'
const KC_REDIRECT_URI = location.origin + '/auth/callback'
const STORAGE_KEY_KC = 'ccdash-kc-tokens'
const STORAGE_KEY_KC_VERIFIER = 'ccdash-kc-verifier'
const STORAGE_KEY_KC_STATE = 'ccdash-kc-state'
const STORAGE_KEY_KC_REDIRECT_HASH = 'ccdash-kc-redirect-hash'

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
  return atob(normalized + padding)
}

async function generatePkce() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64UrlEncode(digest)
  return { verifier, challenge }
}

function writeTokens(data) {
  sessionStorage.setItem(
    STORAGE_KEY_KC,
    JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    }),
  )
}

function clearPkceState() {
  sessionStorage.removeItem(STORAGE_KEY_KC_VERIFIER)
  sessionStorage.removeItem(STORAGE_KEY_KC_STATE)
  sessionStorage.removeItem(STORAGE_KEY_KC_REDIRECT_HASH)
}

function decodeJwtPayload(token) {
  return JSON.parse(base64UrlDecode(token.split('.')[1] || ''))
}

export function getStoredTokens() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_KC)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearStoredTokens() {
  sessionStorage.removeItem(STORAGE_KEY_KC)
  clearPkceState()
}

export function hasStoredTokens() {
  return Boolean(getStoredTokens()?.access_token)
}

export function getAccessToken() {
  return getStoredTokens()?.access_token || null
}

export function isLoggedIn() {
  const tokens = getStoredTokens()
  return Boolean(tokens?.access_token && (!tokens.expires_at || Date.now() < tokens.expires_at - 60000))
}

export async function startLogin() {
  const { verifier, challenge } = await generatePkce()
  const state = crypto.randomUUID()
  sessionStorage.setItem(STORAGE_KEY_KC_VERIFIER, verifier)
  sessionStorage.setItem(STORAGE_KEY_KC_STATE, state)
  sessionStorage.setItem(STORAGE_KEY_KC_REDIRECT_HASH, location.hash || '#dashboard')

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: KC_CLIENT_ID,
    redirect_uri: KC_REDIRECT_URI,
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })

  location.href = `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/auth?${params}`
}

export async function handleCallback() {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  const state = params.get('state')
  const providerError = params.get('error_description') || params.get('error')

  if (providerError) {
    clearPkceState()
    throw new Error(`登录失败: ${providerError}`)
  }
  if (!code) return false

  const verifier = sessionStorage.getItem(STORAGE_KEY_KC_VERIFIER)
  const expectedState = sessionStorage.getItem(STORAGE_KEY_KC_STATE)
  if (!verifier || !expectedState) {
    clearPkceState()
    throw new Error('登录流程已失效，请重新发起登录')
  }
  if (!state || state !== expectedState) {
    clearPkceState()
    throw new Error('登录状态校验失败，请重新登录')
  }

  const res = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KC_CLIENT_ID,
      redirect_uri: KC_REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  })

  if (!res.ok) {
    clearPkceState()
    throw new Error(`登录换取 token 失败: HTTP ${res.status}`)
  }

  const data = await res.json()
  writeTokens(data)
  const hash = sessionStorage.getItem(STORAGE_KEY_KC_REDIRECT_HASH) || '#dashboard'
  clearPkceState()
  history.replaceState(null, '', '/' + hash)
  return true
}

export async function refreshToken() {
  const tokens = getStoredTokens()
  if (!tokens?.refresh_token) return false

  const res = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: KC_CLIENT_ID,
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

export async function ensureFreshToken() {
  const tokens = getStoredTokens()
  if (!tokens?.access_token) return false
  if (!tokens.expires_at || Date.now() < tokens.expires_at - 60000) return true
  return refreshToken()
}

export function kcLogout() {
  clearStoredTokens()
  const params = new URLSearchParams({
    client_id: KC_CLIENT_ID,
    post_logout_redirect_uri: location.origin,
  })
  location.href = `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/logout?${params}`
}

export function getUserInfo() {
  const accessToken = getAccessToken()
  if (!accessToken) return null
  try {
    const payload = decodeJwtPayload(accessToken)
    return {
      name: payload.name || payload.preferred_username || payload.email,
      email: payload.email || null,
    }
  } catch {
    return null
  }
}
