import type { Dispatcher } from 'undici'
import { request } from 'undici'

import { appConfig } from '../config.js'
import { normalizeOpenAICodexApiBaseUrl } from '../providers/openaiCodex.js'

export interface OpenAIRateLimitProbeResult {
  kind: 'openai'
  status: string | null
  requestLimit: number | null
  requestRemaining: number | null
  requestUtilization: number | null
  requestReset: string | null
  requestResetSeconds: number | null
  tokenLimit: number | null
  tokenRemaining: number | null
  tokenUtilization: number | null
  tokenReset: string | null
  tokenResetSeconds: number | null
  fiveHourUtilization: number | null
  fiveHourReset: string | null
  sevenDayUtilization: number | null
  sevenDayReset: string | null
  httpStatus: number
  probedAt: string
  error: string | null
}

const OPENAI_RATE_LIMIT_HEADERS = {
  requestLimit: 'x-ratelimit-limit-requests',
  requestRemaining: 'x-ratelimit-remaining-requests',
  requestReset: 'x-ratelimit-reset-requests',
  tokenLimit: 'x-ratelimit-limit-tokens',
  tokenRemaining: 'x-ratelimit-remaining-tokens',
  tokenReset: 'x-ratelimit-reset-tokens',
} as const

export function parseOpenAIRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
): Pick<
  OpenAIRateLimitProbeResult,
  | 'requestLimit'
  | 'requestRemaining'
  | 'requestUtilization'
  | 'requestReset'
  | 'requestResetSeconds'
  | 'tokenLimit'
  | 'tokenRemaining'
  | 'tokenUtilization'
  | 'tokenReset'
  | 'tokenResetSeconds'
  | 'fiveHourUtilization'
  | 'fiveHourReset'
  | 'sevenDayUtilization'
  | 'sevenDayReset'
> {
  const requestLimit = parseNumericHeader(headers[OPENAI_RATE_LIMIT_HEADERS.requestLimit])
  const requestRemaining = parseNumericHeader(headers[OPENAI_RATE_LIMIT_HEADERS.requestRemaining])
  const requestReset = readHeader(headers[OPENAI_RATE_LIMIT_HEADERS.requestReset])
  const tokenLimit = parseNumericHeader(headers[OPENAI_RATE_LIMIT_HEADERS.tokenLimit])
  const tokenRemaining = parseNumericHeader(headers[OPENAI_RATE_LIMIT_HEADERS.tokenRemaining])
  const tokenReset = readHeader(headers[OPENAI_RATE_LIMIT_HEADERS.tokenReset])

  return {
    requestLimit,
    requestRemaining,
    requestUtilization: calculateUtilization(requestLimit, requestRemaining),
    requestReset,
    requestResetSeconds: parseResetDurationSeconds(requestReset),
    tokenLimit,
    tokenRemaining,
    tokenUtilization: calculateUtilization(tokenLimit, tokenRemaining),
    tokenReset,
    tokenResetSeconds: parseResetDurationSeconds(tokenReset),
    fiveHourUtilization: null,
    fiveHourReset: null,
    sevenDayUtilization: null,
    sevenDayReset: null,
  }
}

export async function probeOpenAICodexRateLimits(options: {
  accessToken: string
  organizationUuid: string | null
  apiBaseUrl: string
  model: string
  proxyDispatcher?: Dispatcher
}): Promise<OpenAIRateLimitProbeResult> {
  const base: OpenAIRateLimitProbeResult = {
    kind: 'openai',
    status: null,
    requestLimit: null,
    requestRemaining: null,
    requestUtilization: null,
    requestReset: null,
    requestResetSeconds: null,
    tokenLimit: null,
    tokenRemaining: null,
    tokenUtilization: null,
    tokenReset: null,
    tokenResetSeconds: null,
    fiveHourUtilization: null,
    fiveHourReset: null,
    sevenDayUtilization: null,
    sevenDayReset: null,
    httpStatus: 0,
    probedAt: new Date().toISOString(),
    error: null,
  }

  if (!options.accessToken) {
    return { ...base, error: 'no_access_token' }
  }
  if (!options.organizationUuid) {
    return { ...base, error: 'missing_chatgpt_account_id' }
  }

  let response: Dispatcher.ResponseData
  try {
    response = await request('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        'chatgpt-account-id': options.organizationUuid,
        accept: 'application/json',
        origin: 'https://chatgpt.com',
        referer: 'https://chatgpt.com/',
        'user-agent': 'Mozilla/5.0',
      },
      dispatcher: options.proxyDispatcher,
      headersTimeout: appConfig.requestTimeoutMs,
      bodyTimeout: appConfig.requestTimeoutMs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, error: `connection_error: ${message}` }
  }

  const responseBody = await response.body.text().catch(() => '')

  if (response.statusCode === 401 || response.statusCode === 403) {
    return { ...base, httpStatus: response.statusCode, error: 'token_expired_or_revoked' }
  }
  if (response.statusCode >= 400) {
    let detail = `http_${response.statusCode}`
    try {
      const body = JSON.parse(responseBody)
      const msg = body?.error?.message || body?.detail || body?.message
      if (msg) detail += `: ${String(msg).slice(0, 200)}`
    } catch {}
    return { ...base, httpStatus: response.statusCode, error: detail }
  }

  const headerSnapshot = parseOpenAIRateLimitHeaders(
    response.headers as Record<string, string | string[] | undefined>,
  )
  const wham = parseWhamUsage(responseBody)
  return {
    ...base,
    ...headerSnapshot,
    ...wham,
    status: deriveOpenAIRateLimitStatus({
      httpStatus: response.statusCode,
      requestUtilization: headerSnapshot.requestUtilization,
      tokenUtilization: headerSnapshot.tokenUtilization,
      fiveHourUtilization: wham.fiveHourUtilization,
      sevenDayUtilization: wham.sevenDayUtilization,
    }),
    httpStatus: response.statusCode,
  }
}

export function parseWhamUsage(body: string): Pick<
  OpenAIRateLimitProbeResult,
  'fiveHourUtilization' | 'fiveHourReset' | 'sevenDayUtilization' | 'sevenDayReset'
> {
  const result: Pick<
    OpenAIRateLimitProbeResult,
    'fiveHourUtilization' | 'fiveHourReset' | 'sevenDayUtilization' | 'sevenDayReset'
  > = {
    fiveHourUtilization: null,
    fiveHourReset: null,
    sevenDayUtilization: null,
    sevenDayReset: null,
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(body)
  } catch {
    return result
  }

  const rateLimits = (data.rate_limits ?? data.rate_limit ?? data) as Record<string, unknown>

  const fiveHour = findWindow(rateLimits, ['primary', 'primary_window', 'five_hour', '5h', 'five_hour_window'])
  if (fiveHour) {
    const usedPercent = extractNumber(fiveHour, ['used_percent', 'percent_used'])
    const percentLeft = extractNumber(fiveHour, ['percent_left', 'remaining_percent'])
    if (usedPercent != null) {
      result.fiveHourUtilization = normalizeUtilizationFraction(usedPercent)
    } else if (percentLeft != null) {
      const remaining = normalizeUtilizationFraction(percentLeft)
      result.fiveHourUtilization = remaining == null ? null : clamp01(1 - remaining)
    }
    const resetAt = extractNumber(fiveHour, ['resets_at', 'reset_at', 'reset_time', 'reset_time_ms', 'reset_at_ms', 'resets_at_ms'])
    if (resetAt != null) {
      result.fiveHourReset = new Date(resetAt < 1e12 ? resetAt * 1000 : resetAt).toISOString()
    }
  }

  const sevenDay = findWindow(rateLimits, ['secondary', 'secondary_window', 'weekly', '7d', 'weekly_window', 'seven_day'])
  if (sevenDay) {
    const usedPercent = extractNumber(sevenDay, ['used_percent', 'percent_used'])
    const percentLeft = extractNumber(sevenDay, ['percent_left', 'remaining_percent'])
    if (usedPercent != null) {
      result.sevenDayUtilization = normalizeUtilizationFraction(usedPercent)
    } else if (percentLeft != null) {
      const remaining = normalizeUtilizationFraction(percentLeft)
      result.sevenDayUtilization = remaining == null ? null : clamp01(1 - remaining)
    }
    const resetAt = extractNumber(sevenDay, ['resets_at', 'reset_at', 'reset_time', 'reset_time_ms', 'reset_at_ms', 'resets_at_ms'])
    if (resetAt != null) {
      result.sevenDayReset = new Date(resetAt < 1e12 ? resetAt * 1000 : resetAt).toISOString()
    }
  }

  return result
}

function findWindow(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = obj[key]
    if (value && typeof value === 'object') {
      return value as Record<string, unknown>
    }
  }
  return null
}

function extractNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return null
}

function buildCodexResponsesProbeUrl(apiBaseUrl: string): string {
  const baseUrl = normalizeOpenAICodexApiBaseUrl(apiBaseUrl.trim() || appConfig.openAICodexApiBaseUrl)
  return new URL('responses', `${baseUrl.replace(/\/+$/, '')}/`).toString()
}

function readHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : null
  }
  return null
}

function parseNumericHeader(value: string | string[] | undefined): number | null {
  const raw = readHeader(value)
  if (!raw) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function calculateUtilization(limit: number | null, remaining: number | null): number | null {
  if (limit == null || remaining == null || limit <= 0) {
    return null
  }
  const ratio = 1 - (remaining / limit)
  return clamp01(ratio)
}

function normalizeUtilizationFraction(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null
  }
  return value > 1 ? clamp01(value / 100) : clamp01(value)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function deriveOpenAIRateLimitStatus(input: {
  httpStatus?: number | null
  requestUtilization?: number | null
  tokenUtilization?: number | null
  fiveHourUtilization?: number | null
  sevenDayUtilization?: number | null
  error?: string | null
}): string | null {
  if (input.error === 'token_expired_or_revoked') {
    return null
  }
  if ((input.httpStatus ?? 0) >= 429) {
    return 'rejected'
  }

  const values = [
    input.requestUtilization,
    input.tokenUtilization,
    input.fiveHourUtilization,
    input.sevenDayUtilization,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  if (values.length === 0) {
    return null
  }

  const highest = Math.max(...values)
  if (highest >= 1) {
    return 'rejected'
  }
  if (highest >= 0.85) {
    return 'allowed_warning'
  }
  return 'allowed'
}

export function parseResetDurationSeconds(value: string | null): number | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const matcher = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
  let totalMs = 0
  let matched = false
  for (const match of trimmed.matchAll(matcher)) {
    matched = true
    const amount = Number(match[1])
    const unit = match[2]
    if (!Number.isFinite(amount)) {
      continue
    }
    if (unit === 'ms') {
      totalMs += amount
    } else if (unit === 's') {
      totalMs += amount * 1000
    } else if (unit === 'm') {
      totalMs += amount * 60_000
    } else if (unit === 'h') {
      totalMs += amount * 3_600_000
    } else if (unit === 'd') {
      totalMs += amount * 86_400_000
    }
  }

  if (!matched) {
    return null
  }
  return Math.max(0, Math.ceil(totalMs / 1000))
}
