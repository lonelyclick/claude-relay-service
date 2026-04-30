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

  // Drain the response body
  await response.body.text().catch(() => {})

  // Parse rate limit headers
  const headers = response.headers as Record<string, string | string[] | undefined>
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

  // Set error for non-200 responses
  if (response.statusCode === 401 || response.statusCode === 403) {
    base.error = 'token_expired_or_revoked'
  } else if (response.statusCode === 429) {
    base.error = 'rate_limited'
  } else if (response.statusCode >= 400) {
    base.error = `http_${response.statusCode}`
  }

  return base
}
