import crypto from 'node:crypto'
import type { Request } from 'express'

import { appConfig } from './config.js'

export class AdminSessionAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'AdminSessionAuthError'
  }
}

type KeycloakUserInfo = {
  sub?: string
  email?: string
  name?: string
  preferred_username?: string
}

type AdminSessionClaims = {
  sub: string
  email: string
  name: string | null
  csrfToken: string
  expiresAt: number
}

export type AdminSessionUser = {
  sub: string
  email: string
  name: string | null
  expiresAt: string
}

export type AdminSession = {
  user: AdminSessionUser
  csrfToken: string
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - (normalized.length % 4 || 4)) % 4
  return Buffer.from(normalized + '='.repeat(padding), 'base64')
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.header('cookie')
  if (!raw) {
    return {}
  }

  const cookies: Record<string, string> = {}
  for (const chunk of raw.split(';')) {
    const separatorIndex = chunk.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    const name = chunk.slice(0, separatorIndex).trim()
    const value = chunk.slice(separatorIndex + 1).trim()
    if (!name) {
      continue
    }
    cookies[name] = decodeURIComponent(value)
  }
  return cookies
}

function signSessionPayload(payload: string): string {
  return base64UrlEncode(
    crypto.createHmac('sha256', appConfig.adminUiSessionSecret).update(payload).digest(),
  )
}

function isSecureRequest(req: Request): boolean {
  if (req.secure) {
    return true
  }
  const forwardedProto = req.header('x-forwarded-proto')
  return typeof forwardedProto === 'string'
    ? forwardedProto.split(',').some((value) => value.trim() === 'https')
    : false
}

function buildCookieAttributes(req: Request, maxAgeSeconds: number): string[] {
  const secure = isSecureRequest(req)
  const sameSite = secure ? 'None' : 'Lax'
  const attributes = [
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`
  ]
  if (maxAgeSeconds <= 0) {
    attributes.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT')
  } else {
    attributes.push(`Max-Age=${maxAgeSeconds}`)
  }
  if (secure) {
    attributes.push('Secure')
  }
  return attributes
}

function toAdminSessionUser(claims: AdminSessionClaims): AdminSessionUser {
  return {
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    expiresAt: new Date(claims.expiresAt).toISOString(),
  }
}

function isAllowedAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  if (appConfig.adminUiAllowedEmails.includes(normalized)) {
    return true
  }
  if (appConfig.adminUiAllowedEmailDomains.length === 0) {
    return appConfig.adminUiAllowedEmails.length === 0
  }
  const domain = normalized.split('@')[1] ?? ''
  return appConfig.adminUiAllowedEmailDomains.includes(domain)
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.header('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }
  const token = authHeader.slice(7).trim()
  return token || null
}

function parseSessionClaims(req: Request): AdminSessionClaims | null {
  const raw = parseCookies(req)[appConfig.adminUiSessionCookieName]
  if (!raw) {
    return null
  }

  const [payload, signature] = raw.split('.')
  if (!payload || !signature) {
    return null
  }

  const expected = signSessionPayload(payload)
  const signatureBuffer = Buffer.from(signature, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null
  }

  try {
    const claims = JSON.parse(base64UrlDecode(payload).toString('utf8')) as AdminSessionClaims
    if (!claims.email || !claims.sub || !claims.csrfToken || !claims.expiresAt) {
      return null
    }
    if (Date.now() >= claims.expiresAt) {
      return null
    }
    return claims
  } catch {
    return null
  }
}

export function getAdminSession(req: Request): AdminSession | null {
  const claims = parseSessionClaims(req)
  if (!claims) {
    return null
  }

  return {
    user: toAdminSessionUser(claims),
    csrfToken: claims.csrfToken,
  }
}

export function getAdminSessionUser(req: Request): AdminSessionUser | null {
  return getAdminSession(req)?.user ?? null
}

export async function exchangeAdminSession(
  req: Request,
  keycloakAccessToken: string,
): Promise<{ cookie: string; user: AdminSessionUser; csrfToken: string }> {
  const response = await fetch(appConfig.adminUiKeycloakUserInfoUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${keycloakAccessToken}`,
    },
    signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
  })

  if (response.status === 401 || response.status === 403) {
    throw new AdminSessionAuthError('登录态已失效，请重新登录', 401)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new AdminSessionAuthError(
      `验证管理台登录失败: ${response.status} ${body.slice(0, 200)}`,
      502,
    )
  }

  const profile = await response.json() as KeycloakUserInfo
  const email = profile.email?.trim().toLowerCase() ?? ''
  if (!email) {
    throw new AdminSessionAuthError('当前登录账号缺少 email，无法授予管理台权限', 403)
  }
  if (!isAllowedAdminEmail(email)) {
    throw new AdminSessionAuthError(`账号 ${email} 没有管理台访问权限`, 403)
  }

  const claims: AdminSessionClaims = {
    sub: profile.sub ?? email,
    email,
    name: profile.name?.trim() || profile.preferred_username?.trim() || email,
    csrfToken: crypto.randomUUID(),
    expiresAt: Date.now() + appConfig.adminUiSessionTtlMs,
  }
  const payload = base64UrlEncode(JSON.stringify(claims))
  const token = `${payload}.${signSessionPayload(payload)}`
  const cookie = [
    `${appConfig.adminUiSessionCookieName}=${encodeURIComponent(token)}`,
    ...buildCookieAttributes(req, Math.floor(appConfig.adminUiSessionTtlMs / 1000)),
  ].join('; ')

  return {
    cookie,
    user: toAdminSessionUser(claims),
    csrfToken: claims.csrfToken,
  }
}

export function buildAdminSessionLogoutCookie(req: Request): string {
  return [
    `${appConfig.adminUiSessionCookieName}=`,
    ...buildCookieAttributes(req, 0),
  ].join('; ')
}
