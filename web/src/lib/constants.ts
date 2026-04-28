type RuntimeConfig = {
  apiBaseUrl?: string
  keycloakUrl?: string
  keycloakRealm?: string
  keycloakClientId?: string
}

declare global {
  interface Window {
    __CCDASH_RUNTIME__?: RuntimeConfig
  }
}

function readRuntimeConfig(): RuntimeConfig {
  return window.__CCDASH_RUNTIME__ ?? {}
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.replace(/\/+$/, '')
}

export function resolveApiUrl(): string {
  const runtime = readRuntimeConfig()
  const env = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL)
  const meta = document.querySelector('meta[name="cc-api-base-url"]')
  const value = normalizeBaseUrl(meta?.getAttribute('content') ?? undefined)
  return normalizeBaseUrl(runtime.apiBaseUrl) || env || value || location.origin
}

export const API_URL = resolveApiUrl()
export const BUILD_VERSION = __CCDASH_BUILD_VERSION__
export const BUILD_TIME = __CCDASH_BUILD_TIME__

export const STORAGE_KEYS = {
  KC_TOKENS: 'ccdash-kc-tokens',
  KC_VERIFIER: 'ccdash-kc-verifier',
  KC_STATE: 'ccdash-kc-state',
  KC_REDIRECT: 'ccdash-kc-redirect',
  ADMIN_SESSION: 'ccdash-admin-session',
} as const

export const KC_CONFIG = {
  URL:
    normalizeBaseUrl(readRuntimeConfig().keycloakUrl) ||
    normalizeBaseUrl(import.meta.env.VITE_KEYCLOAK_URL) ||
    'https://auth.yohomobile.dev',
  REALM: readRuntimeConfig().keycloakRealm?.trim() || import.meta.env.VITE_KEYCLOAK_REALM || 'yoho',
  CLIENT_ID:
    readRuntimeConfig().keycloakClientId?.trim() ||
    import.meta.env.VITE_KEYCLOAK_CLIENT_ID ||
    'ccdash',
} as const
