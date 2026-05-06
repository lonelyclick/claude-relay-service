import type { IncomingHttpHeaders } from 'node:http'

// Layered validation that the request looks like a real Claude Code CLI:
//   L2: header fingerprint (presence + literal values)
//   L3: body shape (system block, metadata.user_id, tools, messages)
//   L4: cross-field consistency (UA version <-> body cc_version,
//       UA platform <-> x-stainless-os)
//
// Aligned with the 2.1.131 client fingerprint captured in
// vm-fingerprint.template.json + data/v2.1.112-body-template.json.
// When that fingerprint is rotated to a newer CLI, revisit the
// constants in this file.

const X_STAINLESS_OS_ALLOWED = new Set(['Linux', 'Darwin', 'MacOS', 'Windows'])
const X_STAINLESS_ARCH_ALLOWED = new Set(['x64', 'arm64'])
const RUNTIME_VERSION_REGEX = /^v\d+\.\d+\.\d+/
const HEX_64_REGEX = /^[0-9a-f]{64}$/i
const NUMERIC_REGEX = /^\d+$/
const CC_VERSION_BODY_REGEX = /cc_version=(\d+)\.(\d+)\.(\d+)\.\w+/
const CC_ENTRYPOINT_BODY_REGEX = /cc_entrypoint=\S+/
const UA_PLATFORM_REGEX = /\b(Darwin|Linux|Windows)\b/i

function normalizePlatformName(value: string): string {
  const lower = value.toLowerCase()
  if (lower === 'darwin' || lower === 'macos') {
    return 'macos'
  }
  return lower
}

export type CliValidationFailure = {
  layer: 'L2' | 'L3' | 'L4'
  field: string
  reason: string
}

export class CliValidationError extends Error {
  constructor(readonly failure: CliValidationFailure) {
    super(`cli_validation_failed:${failure.layer}:${failure.field}:${failure.reason}`)
    this.name = 'CliValidationError'
  }
}

function getHeaderValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (Array.isArray(value)) {
    const joined = value.join(',').trim()
    return joined.length > 0 ? joined : null
  }
  return null
}

function failL2(field: string, reason: string): CliValidationFailure {
  return { layer: 'L2', field, reason }
}

function failL3(field: string, reason: string): CliValidationFailure {
  return { layer: 'L3', field, reason }
}

function failL4(field: string, reason: string): CliValidationFailure {
  return { layer: 'L4', field, reason }
}

export function validateCliRequestHeaders(
  headers: IncomingHttpHeaders,
): CliValidationFailure | null {
  const xApp = getHeaderValue(headers, 'x-app')
  if (xApp !== 'cli') {
    return failL2('x-app', `expected 'cli' got ${xApp ?? '(missing)'}`)
  }

  const lang = getHeaderValue(headers, 'x-stainless-lang')
  if (lang !== 'js') {
    return failL2('x-stainless-lang', `expected 'js' got ${lang ?? '(missing)'}`)
  }

  const runtime = getHeaderValue(headers, 'x-stainless-runtime')
  if (runtime !== 'node') {
    return failL2('x-stainless-runtime', `expected 'node' got ${runtime ?? '(missing)'}`)
  }

  const os = getHeaderValue(headers, 'x-stainless-os')
  if (!os || !X_STAINLESS_OS_ALLOWED.has(os)) {
    return failL2('x-stainless-os', `unexpected ${os ?? '(missing)'}`)
  }

  const arch = getHeaderValue(headers, 'x-stainless-arch')
  if (!arch || !X_STAINLESS_ARCH_ALLOWED.has(arch)) {
    return failL2('x-stainless-arch', `unexpected ${arch ?? '(missing)'}`)
  }

  const directBrowser = getHeaderValue(headers, 'anthropic-dangerous-direct-browser-access')
  if (directBrowser !== 'true') {
    return failL2(
      'anthropic-dangerous-direct-browser-access',
      `expected 'true' got ${directBrowser ?? '(missing)'}`,
    )
  }

  const anthropicVersion = getHeaderValue(headers, 'anthropic-version')
  if (anthropicVersion !== '2023-06-01') {
    return failL2(
      'anthropic-version',
      `expected '2023-06-01' got ${anthropicVersion ?? '(missing)'}`,
    )
  }

  const fetchMode = getHeaderValue(headers, 'sec-fetch-mode')
  if (fetchMode !== null && fetchMode !== 'cors') {
    return failL2('sec-fetch-mode', `expected 'cors' got ${fetchMode}`)
  }

  const packageVersion = getHeaderValue(headers, 'x-stainless-package-version')
  if (!packageVersion) {
    return failL2('x-stainless-package-version', 'missing')
  }

  const runtimeVersion = getHeaderValue(headers, 'x-stainless-runtime-version')
  if (!runtimeVersion || !RUNTIME_VERSION_REGEX.test(runtimeVersion)) {
    return failL2(
      'x-stainless-runtime-version',
      `unexpected ${runtimeVersion ?? '(missing)'}`,
    )
  }

  const acceptLanguage = getHeaderValue(headers, 'accept-language')
  if (acceptLanguage !== null && acceptLanguage.length < 1) {
    return failL2('accept-language', 'empty')
  }

  const acceptEncoding = getHeaderValue(headers, 'accept-encoding')
  if (acceptEncoding !== null && !/gzip/i.test(acceptEncoding)) {
    return failL2(
      'accept-encoding',
      `expected to include gzip got ${acceptEncoding}`,
    )
  }

  const retryCount = getHeaderValue(headers, 'x-stainless-retry-count')
  if (retryCount !== null && !NUMERIC_REGEX.test(retryCount)) {
    return failL2('x-stainless-retry-count', `non-numeric ${retryCount}`)
  }

  const timeout = getHeaderValue(headers, 'x-stainless-timeout')
  if (timeout !== null && !NUMERIC_REGEX.test(timeout)) {
    return failL2('x-stainless-timeout', `non-numeric ${timeout}`)
  }

  return null
}

export type ParsedMessageBody = {
  system: unknown
  tools: unknown
  messages: unknown
  metadata: unknown
}

export function validateCliRequestBody(
  parsed: ParsedMessageBody,
): CliValidationFailure | null {
  if (!Array.isArray(parsed.system) || parsed.system.length < 1) {
    return failL3('system', 'not an array or empty')
  }

  const block0 = parsed.system[0] as { text?: unknown } | null | undefined
  if (!block0 || typeof block0.text !== 'string') {
    return failL3('system[0].text', 'missing or not a string')
  }
  if (!CC_VERSION_BODY_REGEX.test(block0.text)) {
    return failL3('system[0].cc_version', 'cc_version marker missing')
  }
  if (!CC_ENTRYPOINT_BODY_REGEX.test(block0.text)) {
    return failL3('system[0].cc_entrypoint', 'cc_entrypoint marker missing')
  }

  if (!Array.isArray(parsed.tools)) {
    return failL3('tools', 'not an array')
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length < 1) {
    return failL3('messages', 'not an array or empty')
  }

  if (!parsed.metadata || typeof parsed.metadata !== 'object') {
    return failL3('metadata', 'missing or not an object')
  }
  const metaUserId = (parsed.metadata as Record<string, unknown>).user_id
  if (typeof metaUserId !== 'string') {
    return failL3('metadata.user_id', 'missing or not a string')
  }

  let userId: Record<string, unknown>
  try {
    const decoded = JSON.parse(metaUserId)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return failL3('metadata.user_id', 'not a JSON object')
    }
    userId = decoded as Record<string, unknown>
  } catch {
    return failL3('metadata.user_id', 'invalid JSON')
  }

  const deviceId = userId.device_id
  if (typeof deviceId !== 'string' || !HEX_64_REGEX.test(deviceId)) {
    return failL3('metadata.user_id.device_id', 'not 64-char hex')
  }

  return null
}

const CLAUDE_CLI_UA_FULL_REGEX = /^claude-cli\/(\d+)\.(\d+)\.(\d+)\b/

export function validateCliRequestConsistency(
  headers: IncomingHttpHeaders,
  parsed: ParsedMessageBody | null,
  parsedClientVersion: readonly [number, number, number],
): CliValidationFailure | null {
  if (parsed) {
    const block0 = parsed.system as Array<{ text?: unknown }> | undefined
    const text = block0 && block0.length > 0 ? block0[0]?.text : undefined
    if (typeof text === 'string') {
      const match = text.match(CC_VERSION_BODY_REGEX)
      if (match) {
        const bodyVersion: [number, number, number] = [
          Number(match[1]),
          Number(match[2]),
          Number(match[3]),
        ]
        const [a, b, c] = parsedClientVersion
        if (
          bodyVersion[0] !== a ||
          bodyVersion[1] !== b ||
          bodyVersion[2] !== c
        ) {
          return failL4(
            'cc_version_vs_ua',
            `ua=${a}.${b}.${c} body=${bodyVersion.join('.')}`,
          )
        }
      }
    }
  }

  const ua = getHeaderValue(headers, 'user-agent') ?? ''
  if (!CLAUDE_CLI_UA_FULL_REGEX.test(ua)) {
    return failL4('user-agent', 'not claude-cli')
  }
  const uaPlatformMatch = ua.match(UA_PLATFORM_REGEX)
  if (uaPlatformMatch) {
    const uaPlatform = normalizePlatformName(uaPlatformMatch[1])
    const xOsHeader = getHeaderValue(headers, 'x-stainless-os') ?? ''
    const xOs = normalizePlatformName(xOsHeader)
    if (xOs && uaPlatform !== xOs) {
      return failL4('platform', `ua=${uaPlatform} x-stainless-os=${xOs}`)
    }
  }

  return null
}

export type CliValidatorMode = 'disabled' | 'shadow' | 'enforce'

export type CliValidationContext = {
  headers: IncomingHttpHeaders
  parsedBody: ParsedMessageBody | null
  parsedClientVersion: readonly [number, number, number]
  // Whether L3 should run (e.g. only on /v1/messages POST with a parsed body).
  checkBody: boolean
}

export function validateCliRequest(
  ctx: CliValidationContext,
): CliValidationFailure | null {
  const headerFailure = validateCliRequestHeaders(ctx.headers)
  if (headerFailure) return headerFailure

  if (ctx.checkBody && ctx.parsedBody) {
    const bodyFailure = validateCliRequestBody(ctx.parsedBody)
    if (bodyFailure) return bodyFailure
  }

  const consistencyFailure = validateCliRequestConsistency(
    ctx.headers,
    ctx.checkBody ? ctx.parsedBody : null,
    ctx.parsedClientVersion,
  )
  if (consistencyFailure) return consistencyFailure

  return null
}

export function tryParseMessageBody(buffer: Buffer): ParsedMessageBody | null {
  try {
    const decoded = JSON.parse(buffer.toString('utf8'))
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return null
    }
    const obj = decoded as Record<string, unknown>
    return {
      system: obj.system,
      tools: obj.tools,
      messages: obj.messages,
      metadata: obj.metadata,
    }
  } catch {
    return null
  }
}
