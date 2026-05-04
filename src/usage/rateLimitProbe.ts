import type { Dispatcher } from 'undici'
import { request } from 'undici'

export interface RateLimitProbeResult {
  // Overall
  status: string | null
  reset: number | null
  representativeClaim: string | null
  fallbackPercentage: number | null

  // 5-hour window
  fiveHourStatus: string | null
  fiveHourUtilization: number | null
  fiveHourReset: number | null

  // 7-day window
  sevenDayStatus: string | null
  sevenDayUtilization: number | null
  sevenDayReset: number | null
  sevenDaySurpassedThreshold: number | null

  // Overage
  overageStatus: string | null
  overageDisabledReason: string | null
  overageReset: number | null

  // Probe metadata
  httpStatus: number
  probedAt: string
  error: string | null
  tokenStatus: string | null
  refreshAttempted: boolean
  refreshSucceeded: boolean
  refreshError: string | null
  modelUsage?: Array<{
    label: string
    modelIds: string[]
    utilization: number | null
    remainingFraction: number | null
    reset: number | null
  }>
  anthropicHeaders?: Record<string, string> | null
}

const HEADER_MAP: ReadonlyArray<[keyof RateLimitProbeResult, string, 'string' | 'number']> = [
  ['status', 'anthropic-ratelimit-unified-status', 'string'],
  ['reset', 'anthropic-ratelimit-unified-reset', 'number'],
  ['representativeClaim', 'anthropic-ratelimit-unified-representative-claim', 'string'],
  ['fallbackPercentage', 'anthropic-ratelimit-unified-fallback-percentage', 'number'],
  ['fiveHourStatus', 'anthropic-ratelimit-unified-5h-status', 'string'],
  ['fiveHourUtilization', 'anthropic-ratelimit-unified-5h-utilization', 'number'],
  ['fiveHourReset', 'anthropic-ratelimit-unified-5h-reset', 'number'],
  ['sevenDayStatus', 'anthropic-ratelimit-unified-7d-status', 'string'],
  ['sevenDayUtilization', 'anthropic-ratelimit-unified-7d-utilization', 'number'],
  ['sevenDayReset', 'anthropic-ratelimit-unified-7d-reset', 'number'],
  ['sevenDaySurpassedThreshold', 'anthropic-ratelimit-unified-7d-surpassed-threshold', 'number'],
  ['overageStatus', 'anthropic-ratelimit-unified-overage-status', 'string'],
  ['overageDisabledReason', 'anthropic-ratelimit-unified-overage-disabled-reason', 'string'],
  ['overageReset', 'anthropic-ratelimit-unified-overage-reset', 'number'],
]

export async function probeRateLimits(options: {
  accessToken: string
  proxyDispatcher: Dispatcher | undefined
  apiBaseUrl: string
  anthropicVersion: string
  anthropicBeta: string
}): Promise<RateLimitProbeResult> {
  const base: RateLimitProbeResult = {
    status: null,
    reset: null,
    representativeClaim: null,
    fallbackPercentage: null,
    fiveHourStatus: null,
    fiveHourUtilization: null,
    fiveHourReset: null,
    sevenDayStatus: null,
    sevenDayUtilization: null,
    sevenDayReset: null,
    sevenDaySurpassedThreshold: null,
    overageStatus: null,
    overageDisabledReason: null,
    overageReset: null,
    httpStatus: 0,
    probedAt: new Date().toISOString(),
    error: null,
    tokenStatus: null,
    refreshAttempted: false,
    refreshSucceeded: false,
    refreshError: null,
  }

  if (!options.accessToken) {
    return { ...base, error: 'no_access_token' }
  }

  let response: Dispatcher.ResponseData
  try {
    response = await request(`${options.apiBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${options.accessToken}`,
        'anthropic-version': options.anthropicVersion,
        'anthropic-beta': options.anthropicBeta,
        'user-agent': 'claude-cli/2.1.112 (external, sdk-cli)',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      dispatcher: options.proxyDispatcher,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ...base, error: `connection_error: ${message}` }
  }

  base.httpStatus = response.statusCode

  const bodyText = await response.body.text().catch(() => '')

  // Parse rate limit headers
  const headers = response.headers as Record<string, string | string[] | undefined>
  base.anthropicHeaders = collectAnthropicForensicHeaders(headers)
  for (const [key, headerName, type] of HEADER_MAP) {
    const raw = headers[headerName]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value === undefined || value === null) continue

    if (type === 'number') {
      const num = Number(value)
      if (Number.isFinite(num)) {
        ;(base as unknown as Record<string, unknown>)[key] = num
      }
    } else {
      ;(base as unknown as Record<string, unknown>)[key] = value
    }
  }

  // Set error for non-200 responses, attaching upstream message when available
  if (response.statusCode === 401 || response.statusCode === 403) {
    base.error = appendUpstreamDetail('token_expired_or_revoked', bodyText)
  } else if (response.statusCode === 429) {
    base.error = appendUpstreamDetail('rate_limited', bodyText)
  } else if (response.statusCode >= 400) {
    base.error = appendUpstreamDetail(`http_${response.statusCode}`, bodyText)
  }

  return base
}

const FORENSIC_HEADER_KEYS = [
  'anthropic-organization-id',
  'anthropic-account-id',
  'anthropic-ratelimit-tier',
  'anthropic-ratelimit-organization-id',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-version',
  'request-id',
  'x-request-id',
  'x-served-by',
  'cf-ray',
  'cf-cache-status',
  'server',
  'x-anthropic-organization-uuid',
]

function collectAnthropicForensicHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const key of FORENSIC_HEADER_KEYS) {
    const raw = headers[key] ?? headers[key.toLowerCase()]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value.slice(0, 256)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function appendUpstreamDetail(prefix: string, bodyText: string): string {
  const detail = extractUpstreamMessage(bodyText)
  return detail ? `${prefix}: ${detail}` : prefix
}

function extractUpstreamMessage(bodyText: string): string | null {
  const trimmed = bodyText?.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      const errorObj = obj.error
      const candidates: unknown[] = [
        typeof errorObj === 'object' && errorObj !== null ? (errorObj as Record<string, unknown>).message : undefined,
        typeof errorObj === 'string' ? errorObj : undefined,
        typeof errorObj === 'object' && errorObj !== null ? (errorObj as Record<string, unknown>).type : undefined,
        obj.message,
        obj.detail,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim().slice(0, 200)
        }
      }
    }
  } catch {
    // Fallthrough to raw body excerpt
  }
  return trimmed.slice(0, 200)
}
