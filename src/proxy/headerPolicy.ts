import type { IncomingHttpHeaders } from 'node:http'

import {
  resolveVmFingerprintTemplateValue,
  type VmFingerprintTemplateHeader,
} from './fingerprintTemplate.js'

export type UpstreamAuthMode = 'oauth' | 'api_key' | 'preserve_incoming_auth' | 'none'

const HARDCODED_ANTHROPIC_BETA = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,effort-2025-11-24'
const REQUIRED_OAUTH_ANTHROPIC_BETA = 'oauth-2025-04-20'
const LONG_CONTEXT_BETA = 'context-1m-2025-08-07'

/**
 * These headers were previously hardcoded here.  They are now part of
 * the VM fingerprint template so their **position** in the outgoing
 * header list matches a real Claude Code client.
 *
 * X-Stainless-Retry-Count and X-Stainless-Timeout use $passthrough
 * in the template so the client's real per-request value is preserved.
 */

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const INTERNAL_ONLY_HEADERS = new Set([
  'x-force-account',
])

/**
 * Headers allowed to pass through to upstream (beyond fingerprint template
 * headers which are always injected from the template).  Everything else is
 * silently dropped so that client-specific or proxy-revealing headers never
 * reach Anthropic.
 */
const PASSTHROUGH_ALLOWED_HEADERS = new Set([
  // request semantics
  'content-type',
  'content-length',
  'accept',
  // Claude Code session / request identity
  'x-claude-code-session-id',
  'x-claude-remote-session-id',
  'x-request-id',
  'idempotency-key',
  // authorization is handled separately in buildForwardHeaders
])

const WEBSOCKET_HANDSHAKE_HEADERS = new Set([
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
])

const MANAGED_WEBSOCKET_RESPONSE_HEADERS = new Set([
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
])

export function shouldForwardHttpResponseHeader(name: string): boolean {
  return !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
}

export function shouldForwardWebSocketUpgradeResponseHeader(
  name: string,
): boolean {
  const normalized = name.toLowerCase()
  return (
    shouldForwardHttpResponseHeader(normalized) &&
    !MANAGED_WEBSOCKET_RESPONSE_HEADERS.has(normalized)
  )
}

export function shouldForwardWebSocketFailureResponseHeader(
  name: string,
): boolean {
  const normalized = name.toLowerCase()
  return (
    shouldForwardHttpResponseHeader(normalized) &&
    normalized !== 'content-length'
  )
}

export function buildUpstreamHeaders(
  rawHeaders: string[] | undefined,
  incoming: IncomingHttpHeaders,
  accessToken: string | null,
  authMode: UpstreamAuthMode,
  vmFingerprintTemplateHeaders: readonly VmFingerprintTemplateHeader[] = [],
  anthropicBeta?: string,
  headerOverrides: Record<string, string | null> = {},
  allowClientBetaPassthrough: boolean = false,
  stripLongContextBeta: boolean = false,
): string[] {
  return flattenHeaderPairs(
    buildForwardHeaders(rawHeaders, incoming, {
      authMode,
      replacementAuthorization: authMode === 'oauth' && accessToken
        ? `Bearer ${accessToken}`
        : null,
      transport: 'http',
      vmFingerprintTemplateHeaders,
      anthropicBeta,
      headerOverrides,
      allowClientBetaPassthrough,
      stripLongContextBeta,
    }),
  )
}

export function buildWebSocketUpstreamHeaders(
  rawHeaders: string[] | undefined,
  incoming: IncomingHttpHeaders,
  accessToken: string | null,
  authMode: UpstreamAuthMode,
  vmFingerprintTemplateHeaders: readonly VmFingerprintTemplateHeader[] = [],
  anthropicBeta?: string,
  headerOverrides: Record<string, string | null> = {},
  allowClientBetaPassthrough: boolean = false,
  stripLongContextBeta: boolean = false,
): Record<string, string> {
  return collapseHeaderPairs(
    buildForwardHeaders(rawHeaders, incoming, {
      authMode,
      replacementAuthorization: authMode === 'oauth' && accessToken
        ? `Bearer ${accessToken}`
        : null,
      transport: 'websocket',
      vmFingerprintTemplateHeaders,
      anthropicBeta,
      headerOverrides,
      allowClientBetaPassthrough,
      stripLongContextBeta,
    }),
  )
}

function collapseHeaderPairs(
  pairs: Array<[string, string]>,
): Record<string, string> {
  const collapsed: Record<string, string> = {}

  for (const [rawName, rawValue] of pairs) {
    const name = rawName.toLowerCase()
    const existingKey = Object.keys(collapsed).find(
      (key) => key.toLowerCase() === name,
    )
    if (!existingKey) {
      collapsed[rawName] = rawValue
      continue
    }

    const separator = name === 'cookie' ? '; ' : ', '
    collapsed[existingKey] = `${collapsed[existingKey]}${separator}${rawValue}`
  }

  return collapsed
}

function flattenHeaderPairs(pairs: Array<[string, string]>): string[] {
  return pairs.flatMap(([name, value]) => [name, value])
}

function buildForwardHeaders(
  rawHeaders: string[] | undefined,
  incoming: IncomingHttpHeaders,
  options: {
    authMode: UpstreamAuthMode
    replacementAuthorization: string | null
    transport: 'http' | 'websocket'
    vmFingerprintTemplateHeaders: readonly VmFingerprintTemplateHeader[]
    anthropicBeta?: string
    headerOverrides: Record<string, string | null>
    allowClientBetaPassthrough: boolean
    stripLongContextBeta: boolean
  },
): Array<[string, string]> {
  const pairs = getHeaderPairs(rawHeaders, incoming)
  const incomingValuesByName = groupHeaderValues(pairs)
  const templateHeaders = buildTemplateHeaderMap(options.vmFingerprintTemplateHeaders)
  const overrideMap = new Map(
    Object.entries(options.headerOverrides).map(([name, value]) => [name.toLowerCase(), value] as const),
  )
  const preserveIncomingAuth = options.authMode === 'preserve_incoming_auth'
  // When the caller supplies anthropicBeta (a body template is active),
  // we claim a specific client-version fingerprint. Preserving the
  // client's incoming beta header would produce an inconsistent header
  // set (e.g. fake UA + stale beta tokens), so force the template value.
  const enforceTemplateBeta = typeof options.anthropicBeta === 'string' && options.anthropicBeta.length > 0
  const outgoing: Array<[string, string]> = []
  const appliedTemplateHeaders = new Set<string>()
  const appliedOverrides = new Set<string>()
  let sawAuthorization = false
  let sawAnthropicBeta = false

  for (const [rawName, rawValue] of pairs) {
    const name = rawName.toLowerCase()
    if (overrideMap.has(name)) {
      const overrideValue = overrideMap.get(name) ?? null
      appliedOverrides.add(name)
      if (overrideValue) {
        outgoing.push([rawName, overrideValue])
      }
      continue
    }
    const value = rawValue.trim()
    if (!value) {
      continue
    }

    const templateHeader = templateHeaders.get(name)
    if (templateHeader) {
      if (!appliedTemplateHeaders.has(name)) {
        outgoing.push([
          templateHeader.name,
          resolveVmFingerprintTemplateValue(
            name,
            templateHeader.value,
            incomingValuesByName.get(name) ?? [],
          ),
        ])
        appliedTemplateHeaders.add(name)
      }
      continue
    }

    if (name === 'authorization') {
      sawAuthorization = true
      if (preserveIncomingAuth) {
        outgoing.push([rawName, rawValue])
        continue
      }
      if (options.replacementAuthorization) {
        outgoing.push([rawName, options.replacementAuthorization])
      }
      continue
    }

    if (name === 'anthropic-beta') {
      if (!sawAnthropicBeta && preserveIncomingAuth && !enforceTemplateBeta) {
        outgoing.push([rawName, rawValue])
      }
      sawAnthropicBeta = true
      continue
    }

    if (!PASSTHROUGH_ALLOWED_HEADERS.has(name)) {
      continue
    }
    if (
      options.transport === 'websocket' &&
      WEBSOCKET_HANDSHAKE_HEADERS.has(name)
    ) {
      continue
    }

    outgoing.push([rawName, rawValue])
  }

  for (const [name, templateHeader] of templateHeaders) {
    if (appliedTemplateHeaders.has(name)) {
      continue
    }

    outgoing.push([
      templateHeader.name,
      resolveVmFingerprintTemplateValue(name, templateHeader.value, []),
    ])
  }

  for (const [name, value] of overrideMap.entries()) {
    if (appliedOverrides.has(name) || !value) {
      continue
    }
    outgoing.push([name, value])
  }

  const shouldEmitTemplateBeta =
    enforceTemplateBeta || !(preserveIncomingAuth && sawAnthropicBeta)
  if (shouldEmitTemplateBeta) {
    const incomingBetaValues = options.allowClientBetaPassthrough
      ? incomingValuesByName.get('anthropic-beta') ?? []
      : []
    outgoing.push([
      'anthropic-beta',
      buildAnthropicBetaHeader(
        options.anthropicBeta ?? HARDCODED_ANTHROPIC_BETA,
        options.authMode,
        incomingBetaValues,
        options.stripLongContextBeta,
      ),
    ])
  }

  if (!preserveIncomingAuth && options.replacementAuthorization && !sawAuthorization) {
    outgoing.unshift(['Authorization', options.replacementAuthorization])
  }

  return outgoing
}

function getHeaderPairs(
  rawHeaders: string[] | undefined,
  incoming: IncomingHttpHeaders,
): Array<[string, string]> {
  if (Array.isArray(rawHeaders) && rawHeaders.length >= 2) {
    const pairs: Array<[string, string]> = []
    for (let index = 0; index < rawHeaders.length - 1; index += 2) {
      const name = rawHeaders[index]
      const value = rawHeaders[index + 1]
      if (typeof name === 'string' && typeof value === 'string') {
        pairs.push([name, value])
      }
    }
    return pairs
  }

  const pairs: Array<[string, string]> = []
  for (const [rawName, rawValue] of Object.entries(incoming)) {
    if (typeof rawValue === 'string') {
      pairs.push([rawName, rawValue])
      continue
    }
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        pairs.push([rawName, value])
      }
    }
  }
  return pairs
}

function buildTemplateHeaderMap(
  headers: readonly VmFingerprintTemplateHeader[],
): Map<string, VmFingerprintTemplateHeader> {
  return new Map(
    headers.map((header) => [header.name.toLowerCase(), header] as const),
  )
}

function buildAnthropicBetaHeader(
  betaHeader: string,
  authMode: UpstreamAuthMode,
  incomingBetaValues: readonly string[] = [],
  stripLongContextBeta: boolean = false,
): string {
  const tokens: string[] = []
  const seen = new Set<string>()

  const push = (raw: string): void => {
    const trimmed = raw.trim()
    if (
      !trimmed ||
      seen.has(trimmed) ||
      (stripLongContextBeta && trimmed === LONG_CONTEXT_BETA)
    ) {
      return
    }
    seen.add(trimmed)
    tokens.push(trimmed)
  }

  // Template beta tokens come first to preserve the client-version
  // fingerprint ordering a real 2.1.112 client would emit.
  for (const token of betaHeader.split(',')) {
    push(token)
  }
  // Then append any client-only beta tokens that the template does not
  // already cover (e.g. fast-mode-2026-02-01, afk-mode-2026-01-31,
  // redact-thinking-2026-02-12). Without this, /fast and similar
  // dynamic-beta features silently degrade under the relay.
  for (const raw of incomingBetaValues) {
    for (const token of raw.split(',')) {
      push(token)
    }
  }
  if (authMode === 'oauth') {
    push(REQUIRED_OAUTH_ANTHROPIC_BETA)
  }

  return tokens.join(',')
}

function groupHeaderValues(
  pairs: Array<[string, string]>,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>()

  for (const [rawName, rawValue] of pairs) {
    const name = rawName.toLowerCase()
    const values = grouped.get(name)
    if (values) {
      values.push(rawValue)
      continue
    }
    grouped.set(name, [rawValue])
  }

  return grouped
}
