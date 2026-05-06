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

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readUsageObject(value: unknown): Record<string, unknown> | null {
  const object = readObject(value)
  if (!object) return null
  return object.usage ? readObject(object.usage) : null
}

function extractUsageFromObject(data: unknown, previous: ExtractedUsage | null): ExtractedUsage | null {
  const record = readObject(data)
  if (!record) return null

  const response = readObject(record.response) ?? record
  const usageObject = readUsageObject(record) ?? readUsageObject(response)
  if (!usageObject) return null

  const inputDetails = readObject(usageObject.input_tokens_details)
  const outputDetails = readObject(usageObject.output_tokens_details)
  const inputTokens =
    readNumber(usageObject.input_tokens) ??
    readNumber(usageObject.prompt_tokens) ??
    previous?.inputTokens ??
    0
  const outputTokens =
    readNumber(usageObject.output_tokens) ??
    readNumber(usageObject.completion_tokens) ??
    previous?.outputTokens ??
    0

  return {
    model: readString(response.model) ?? readString(record.model) ?? previous?.model ?? null,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens:
      readNumber(usageObject.cache_creation_input_tokens) ??
      readNumber(inputDetails?.cache_creation_tokens) ??
      previous?.cacheCreationInputTokens ??
      0,
    cacheReadInputTokens:
      readNumber(usageObject.cache_read_input_tokens) ??
      readNumber(inputDetails?.cached_tokens) ??
      readNumber(outputDetails?.cached_tokens) ??
      previous?.cacheReadInputTokens ??
      0,
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
    if (!line.startsWith('data: ')) {
      return
    }

    const jsonStr = line.slice(6)
    if (jsonStr === '[DONE]') {
      currentEvent = ''
      return
    }
    const parsed = safeParseJson(jsonStr)
    const extracted = extractUsageFromObject(parsed, usage)
    if (extracted) {
      usage = extracted
      model = extracted.model ?? model
      currentEvent = ''
      return
    }

    if (!currentEvent) {
      return
    }

    if (currentEvent === 'message_start') {
      try {
        const data = readObject(parsed)
        const message = readObject(data?.message)
        model = readString(message?.model) ?? null
        const u = readObject(message?.usage)
        if (u) {
          usage = {
            model,
            inputTokens: readNumber(u.input_tokens) ?? 0,
            outputTokens: readNumber(u.output_tokens) ?? 0,
            cacheCreationInputTokens: readNumber(u.cache_creation_input_tokens) ?? 0,
            cacheReadInputTokens: readNumber(u.cache_read_input_tokens) ?? 0,
          }
        }
      } catch {
        // ignore parse errors
      }
    } else if (currentEvent === 'message_delta') {
      try {
        const data = readObject(parsed)
        const u = readObject(data?.usage)
        if (u) {
          usage = {
            model,
            inputTokens: readNumber(u.input_tokens) ?? usage?.inputTokens ?? 0,
            outputTokens: readNumber(u.output_tokens) ?? usage?.outputTokens ?? 0,
            cacheCreationInputTokens: readNumber(u.cache_creation_input_tokens) ?? usage?.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: readNumber(u.cache_read_input_tokens) ?? usage?.cacheReadInputTokens ?? 0,
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
    return extractUsageFromObject(data, null)
  } catch {
    return null
  }
}
