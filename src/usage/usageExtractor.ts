import { Transform, type TransformCallback } from 'node:stream'
import type { IncomingHttpHeaders } from 'node:http'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

export interface ExtractedUsage {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export interface RateLimitInfo {
  status: string | null
  fiveHourUtilization: number | null
  sevenDayUtilization: number | null
  resetTimestamp: number | null
}

export function extractRateLimitInfo(headers: IncomingHttpHeaders): RateLimitInfo {
  const getHeader = (name: string): string | null => {
    const value = headers[name]
    return typeof value === 'string' ? value : null
  }

  const parseFloat = (value: string | null): number | null => {
    if (value === null) return null
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }

  return {
    status: getHeader('anthropic-ratelimit-unified-status'),
    fiveHourUtilization: parseFloat(getHeader('anthropic-ratelimit-unified-5h-utilization')),
    sevenDayUtilization: parseFloat(getHeader('anthropic-ratelimit-unified-7d-utilization')),
    resetTimestamp: parseFloat(getHeader('anthropic-ratelimit-unified-reset')),
  }
}

export function extractRateLimitInfoFromErrorResponse(input: {
  statusCode: number
  headers: IncomingHttpHeaders
  body?: Buffer | string | null
}): RateLimitInfo {
  const fromHeaders = extractRateLimitInfo(input.headers)
  if (fromHeaders.status) {
    return fromHeaders
  }

  const bodyText =
    typeof input.body === 'string'
      ? input.body
      : Buffer.isBuffer(input.body)
        ? input.body.toString('utf8')
        : ''
  const inferredStatus = inferRateLimitStatusFromErrorBody(input.statusCode, bodyText)
  if (!inferredStatus) {
    return fromHeaders
  }

  return {
    ...fromHeaders,
    status: inferredStatus,
  }
}

function inferRateLimitStatusFromErrorBody(statusCode: number, bodyText: string): string | null {
  const trimmed = bodyText.trim()
  if (!trimmed) {
    return null
  }

  const normalized = trimmed.toLowerCase()
  if (/\bE014\b/i.test(trimmed) || normalized.includes('quota exceeded')) {
    return 'blocked'
  }
  if (matchesSoftLimitLanguage(normalized)) {
    return 'throttled'
  }

  const parsed = safeParseJson(trimmed)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const record = parsed as Record<string, unknown>
  const error =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : null
  const wrappedStatus = typeof record.status === 'number' ? record.status : null
  const errorCode = readString(error?.code) ?? readString(record.code)
  const errorMessage = readString(error?.message) ?? readString(record.message)
  const combined = `${errorCode ?? ''} ${errorMessage ?? ''}`.trim().toLowerCase()

  if (/\bE014\b/i.test(errorCode ?? '') || combined.includes('quota exceeded')) {
    return 'blocked'
  }
  if (
    wrappedStatus === 429 &&
    (statusCode === 403 || statusCode === 401 || matchesSoftLimitLanguage(combined))
  ) {
    return 'throttled'
  }
  if (matchesSoftLimitLanguage(combined)) {
    return 'throttled'
  }
  return null
}

function matchesSoftLimitLanguage(text: string): boolean {
  return (
    text.includes('rate limited') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('hit your limit') ||
    text.includes('throttled')
  )
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Create a pass-through Transform stream that extracts usage data from
 * SSE streaming responses without modifying the data.
 *
 * Returns the transform stream and a promise that resolves with the
 * extracted usage when the stream ends.
 */
export function createUsageTransform(): {
  transform: Transform
  usagePromise: Promise<ExtractedUsage | null>
} {
  let model: string | null = null
  let usage: ExtractedUsage | null = null
  let buffer = ''
  let currentEvent = ''

  let resolved = false
  let resolveUsage: (value: ExtractedUsage | null) => void
  const usagePromise = new Promise<ExtractedUsage | null>((resolve) => {
    resolveUsage = resolve
  })
  const safeResolve = (value: ExtractedUsage | null): void => {
    if (!resolved) {
      resolved = true
      resolveUsage(value)
    }
  }

  const processLine = (line: string): void => {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
      return
    }
    if (!line.startsWith('data: ') || !currentEvent) {
      return
    }

    const jsonStr = line.slice(6)
    if (currentEvent === 'message_start') {
      try {
        const data = JSON.parse(jsonStr)
        model = data?.message?.model ?? null
        const u = data?.message?.usage
        if (u) {
          usage = {
            model,
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          }
        }
      } catch {
        // ignore parse errors
      }
    } else if (currentEvent === 'response.completed' || currentEvent === 'response.done') {
      try {
        const data = JSON.parse(jsonStr)
        const response = data?.response ?? data
        const u = response?.usage
        if (u) {
          usage = {
            model: response?.model ?? model ?? null,
            inputTokens:
              typeof u.input_tokens === 'number'
                ? u.input_tokens
                : typeof u.prompt_tokens === 'number'
                  ? u.prompt_tokens
                  : usage?.inputTokens ?? 0,
            outputTokens:
              typeof u.output_tokens === 'number'
                ? u.output_tokens
                : typeof u.completion_tokens === 'number'
                  ? u.completion_tokens
                  : usage?.outputTokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens:
              u.cache_read_input_tokens ??
              u.input_tokens_details?.cached_tokens ??
              usage?.cacheReadInputTokens ??
              0,
          }
          model = response?.model ?? model
        }
      } catch {
        // ignore parse errors
      }
    } else if (currentEvent === 'message_delta') {
      try {
        const data = JSON.parse(jsonStr)
        const u = data?.usage
        if (u) {
          usage = {
            model,
            inputTokens: u.input_tokens ?? usage?.inputTokens ?? 0,
            outputTokens: u.output_tokens ?? usage?.outputTokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: u.cache_read_input_tokens ?? usage?.cacheReadInputTokens ?? 0,
          }
        }
      } catch {
        // ignore parse errors
      }
    }
    currentEvent = ''
  }

  const processBuffer = (): void => {
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trimEnd()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) {
        processLine(line)
      }
    }
  }

  const transform = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      try {
        buffer += chunk.toString('utf8')
        processBuffer()
      } catch {
        // usage extraction must never affect relay behavior
      }
      callback(null, chunk)
    },
    flush(callback: TransformCallback) {
      try {
        if (buffer.trim()) {
          processLine(buffer.trim())
        }
      } catch {
        // ignore
      }
      safeResolve(usage)
      callback()
    },
    destroy(err, callback) {
      safeResolve(usage)
      callback(err)
    },
  })

  return { transform, usagePromise }
}

/**
 * Extract usage from a non-streaming JSON response body.
 */
export function extractUsageFromJsonBody(
  body: Buffer,
  contentEncoding: string | null = null,
): ExtractedUsage | null {
  try {
    let decoded = body
    switch (contentEncoding) {
      case 'br':
        decoded = brotliDecompressSync(body)
        break
      case 'deflate':
        decoded = inflateSync(body)
        break
      case 'gzip':
      case 'x-gzip':
        decoded = gunzipSync(body)
        break
    }
    const data = JSON.parse(decoded.toString('utf8'))
    const usageHolder = data?.response ?? data
    const u = usageHolder?.usage
    if (!u) return null
    const inputTokens =
      typeof u.input_tokens === 'number'
        ? u.input_tokens
        : typeof u.prompt_tokens === 'number'
          ? u.prompt_tokens
          : 0
    const outputTokens =
      typeof u.output_tokens === 'number'
        ? u.output_tokens
        : typeof u.completion_tokens === 'number'
          ? u.completion_tokens
          : 0
    return {
      model: usageHolder?.model ?? data?.model ?? null,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    }
  } catch {
    return null
  }
}
