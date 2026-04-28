import crypto from 'node:crypto'

import { appConfig } from '../config.js'

export function generateState(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function generateCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url')
}

export function parseAuthorizationInput(input: string): {
  code: string
  state: string | null
} {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Authorization code must not be empty')
  }

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code) {
      throw new Error('No code found in callback URL')
    }
    return { code, state }
  } catch {
    const [code] = trimmed.split('#')
    if (!/^[A-Za-z0-9._~-]+$/.test(code)) {
      throw new Error('Invalid authorization code format')
    }
    return { code, state: null }
  }
}

export function buildAuthorizeUrl({
  codeChallenge,
  state,
  expiresIn,
}: {
  codeChallenge: string
  state: string
  expiresIn?: number
}): string {
  const url = new URL(appConfig.oauthAuthorizeUrl)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', appConfig.oauthClientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', appConfig.oauthManualRedirectUrl)
  url.searchParams.set('scope', appConfig.oauthScopes.join(' '))
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    url.searchParams.set('expires_in', String(expiresIn))
  }
  return url.toString()
}

