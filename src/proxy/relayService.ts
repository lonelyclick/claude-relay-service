import crypto from 'node:crypto'
import { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import type { Duplex } from 'node:stream'
import { PassThrough, Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
} from 'node:zlib'

import type { Request, Response } from 'express'
import type { Dispatcher } from 'undici'
import { request } from 'undici'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

import { appConfig } from '../config.js'
import type { BodyTemplate } from './bodyRewriter.js'
import { rewriteMessageBody, rewriteEventLoggingBody } from './bodyRewriter.js'
import type { VmFingerprintTemplateHeader } from './fingerprintTemplate.js'
import {
  createUsageTransform,
  extractRateLimitInfo,
  extractRateLimitInfoFromErrorResponse,
  extractUsageFromJsonBody,
  type ExtractedUsage,
} from '../usage/usageExtractor.js'
import type { ApiKeyStore } from '../usage/apiKeyStore.js'
import type { UsageRecord, UsageStore } from '../usage/usageStore.js'
import type { UserStore } from '../usage/userStore.js'
import {
  deriveOpenAIRateLimitStatus,
  parseOpenAIRateLimitHeaders,
} from '../usage/openaiRateLimitProbe.js'
import { OAuthService, RoutingGuardError } from '../oauth/service.js'
import type { BillingStore } from '../billing/billingStore.js'
import { SYSTEM_FALLBACK_RULE_ID_PREFIX } from '../billing/billingStore.js'
import type { BillingRule } from '../billing/engine.js'
import type { AccountProvider, BillingCurrency, RelayKeySource, RelayUser, ResolvedAccount, StoredAccount } from '../types.js'
import { SchedulerCapacityError, formatSchedulerCapacityError } from '../scheduler/accountScheduler.js'
import { AccountHealthTracker } from '../scheduler/healthTracker.js'
import { ProxyPool } from '../scheduler/proxyPool.js'
import {
  ConsoleRelayLogger,
  type RelayCaptureEvent,
  type RelayLogger,
} from './relayLogger.js'
import {
  buildProviderScopedAccountId,
  parseProviderScopedAccountRef,
} from '../providers/accountRef.js'
import {
  CLAUDE_COMPATIBLE_PROVIDER,
  CLAUDE_OFFICIAL_PROVIDER,
  OPENAI_CODEX_PROVIDER,
} from '../providers/catalog.js'
import {
  buildOpenAICodexResponsesUrl,
  extractOpenAICodexErrorMessage,
  isOpenAICodexAccount,
} from '../providers/openaiCodex.js'
import {
  buildOpenAICompatibleChatCompletionsUrl,
  isOpenAICompatibleAccount,
} from '../providers/openaiCompatible.js'
import {
  buildClaudeCompatibleUpstreamUrl,
  isClaudeCompatibleAccount,
  rewriteClaudeCompatibleRequestBody,
} from '../providers/claudeCompatible.js'
import {
  RELAY_ERROR_CODES,
  type RelayErrorCode,
  classifyClientFacingRelayError,
  fallbackRelayErrorCode,
  RoutingGroupAccessError,
} from './clientFacingErrors.js'
import {
  type UpstreamAuthMode,
  buildUpstreamHeaders,
  buildWebSocketUpstreamHeaders,
  shouldForwardHttpResponseHeader,
  shouldForwardWebSocketFailureResponseHeader,
  shouldForwardWebSocketUpgradeResponseHeader,
} from './headerPolicy.js'

type RouteAuthStrategy =
  | 'prefer_incoming_auth'
  | 'preserve_incoming_auth'
  | 'none'

type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

type HttpTraceContext = {
  method: string
  requestId: string
  startedAt: number
  target: string
}

type RequestCaptureContext = {
  trace: HttpTraceContext
  routeAuthStrategy: RouteAuthStrategy
}

type PipelineObservation = {
  rateLimitStatus: string | null
  responseBodyPreview: string | null
  responseContentType: string | null
}

type RelayRequestBody = Buffer | Readable | undefined

type PreparedRequestBody = {
  body: RelayRequestBody
  bufferedBody: Buffer | undefined
}

type ResolvedRelayUserContext = {
  userId: string | null
  userAccountId: string | null
  routingMode: 'auto' | 'pinned_account' | 'preferred_group'
  routingGroupId: string | null
  preferredGroup: string | null
  billingMode: 'postpaid' | 'prepaid'
  billingCurrency: BillingCurrency
  relayKeySource: RelayKeySource | null
  stripped: boolean
  rejected: string | null
}

type ResolvedRelayUserLookup = {
  user: RelayUser | null
  resolvedKeyId: string | null
  relayKeySource: RelayKeySource | null
}

type UpstreamFailureRecord = {
  accountId: string
  timestamp: number
}

type HeaderPair = [string, string]

type HeaderDiff = {
  added: RelayCaptureEvent['addedHeaders']
  changed: RelayCaptureEvent['changedHeaders']
  removed: RelayCaptureEvent['removedHeaders']
}

class BufferedRequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds buffered limit of ${maxBytes} bytes`)
    this.name = 'BufferedRequestBodyTooLargeError'
  }
}

/**
 * Build an error response body that matches the Anthropic API format so
 * relay-generated rejections are indistinguishable from upstream errors.
 */
function anthropicErrorBody(
  statusCode: number,
  message: string,
  internalCode: RelayErrorCode = fallbackRelayErrorCode(statusCode),
): Record<string, unknown> {
  const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    402: 'invalid_request_error',
    403: 'permission_error',
    404: 'not_found_error',
    405: 'invalid_request_error',
    413: 'invalid_request_error',
    429: 'rate_limit_error',
    500: 'api_error',
    501: 'api_error',
    503: 'api_error',
    529: 'overloaded_error',
  }
  return {
    type: 'error',
    error: {
      type: ANTHROPIC_ERROR_TYPES[statusCode] ?? 'api_error',
      message,
      internal_code: internalCode,
    },
  }
}

function openAIErrorBody(
  statusCode: number,
  message: string,
  internalCode: RelayErrorCode = fallbackRelayErrorCode(statusCode),
): Record<string, unknown> {
  const OPENAI_ERROR_TYPES: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    402: 'invalid_request_error',
    403: 'permission_error',
    404: 'invalid_request_error',
    405: 'invalid_request_error',
    409: 'invalid_request_error',
    413: 'invalid_request_error',
    422: 'invalid_request_error',
    429: 'rate_limit_error',
    500: 'server_error',
    501: 'server_error',
    502: 'server_error',
    503: 'server_error',
    529: 'server_error',
  }
  return {
    error: {
      message,
      type: OPENAI_ERROR_TYPES[statusCode] ?? 'api_error',
      code: internalCode,
    },
  }
}

function isOpenAIStyleHttpPath(pathname: string): boolean {
  return pathname === '/v1/chat/completions' || pathname === '/v1/models'
}

function localHttpErrorBody(
  pathname: string,
  statusCode: number,
  message: string,
  internalCode: RelayErrorCode = fallbackRelayErrorCode(statusCode),
): Record<string, unknown> {
  return isOpenAIStyleHttpPath(pathname)
    ? openAIErrorBody(statusCode, message, internalCode)
    : anthropicErrorBody(statusCode, message, internalCode)
}

function findSseBlockBoundary(buffer: string): { index: number; length: number } | null {
  const lfBoundary = buffer.indexOf('\n\n')
  const crlfBoundary = buffer.indexOf('\r\n\r\n')

  if (lfBoundary === -1 && crlfBoundary === -1) {
    return null
  }
  if (lfBoundary === -1) {
    return { index: crlfBoundary, length: 4 }
  }
  if (crlfBoundary === -1) {
    return { index: lfBoundary, length: 2 }
  }
  return lfBoundary < crlfBoundary
    ? { index: lfBoundary, length: 2 }
    : { index: crlfBoundary, length: 4 }
}

function extractSseErrorPreview(block: string): string | null {
  const normalized = block.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return null
  }
  if (/^event:\s*error$/m.test(normalized)) {
    return normalized.slice(0, 1024)
  }

  const dataPayload = normalized
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')

  if (!dataPayload || dataPayload === '[DONE]') {
    return null
  }

  return /"type"\s*:\s*"error"|"error"\s*:\s*\{/.test(dataPayload)
    ? dataPayload.slice(0, 1024)
    : null
}

class SseErrorInspectTransform extends Transform {
  private buffer = ''
  public errorEventPreview: string | null = null

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.errorEventPreview === null) {
      this.buffer += chunk.toString('utf8')
      this.consumeBlocks(false)
      if (this.buffer.length > 8192) {
        this.buffer = this.buffer.slice(-4096)
      }
    }
    cb(null, chunk)
  }

  override _flush(cb: TransformCallback): void {
    if (this.errorEventPreview === null) {
      this.consumeBlocks(true)
    }
    cb()
  }

  private consumeBlocks(flushRemainder: boolean): void {
    while (this.errorEventPreview === null) {
      const boundary = findSseBlockBoundary(this.buffer)
      if (!boundary) {
        break
      }
      const block = this.buffer.slice(0, boundary.index)
      this.buffer = this.buffer.slice(boundary.index + boundary.length)
      this.errorEventPreview = extractSseErrorPreview(block)
    }

    if (flushRemainder && this.errorEventPreview === null && this.buffer) {
      this.errorEventPreview = extractSseErrorPreview(this.buffer)
      this.buffer = ''
    }
  }
}

const CLAUDE_CLI_UA_REGEX = /^claude-cli\/(\d+)\.(\d+)\.(\d+)\b/
const MIN_CLAUDE_CLI_VERSION: readonly [number, number, number] = appConfig.minClaudeCliVersion

function parseClaudeCliVersion(
  userAgent: string | undefined,
): [number, number, number] | null {
  if (!userAgent) return null
  const match = userAgent.match(CLAUDE_CLI_UA_REGEX)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isVersionAtLeast(
  version: [number, number, number],
  min: readonly [number, number, number],
): boolean {
  const encode = (v: readonly [number, number, number]) =>
    v[0] * 1_000_000 + v[1] * 1_000 + v[2]
  return encode(version) >= encode(min)
}

function parseTemplateCcVersion(
  ccVersion: string | undefined,
): [number, number, number] | null {
  if (!ccVersion) return null
  const parts = ccVersion.split('.').slice(0, 3).map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  return parts as [number, number, number]
}

/**
 * Client beta tokens (e.g. fast-mode-2026-02-01) may be appended after the
 * template beta tokens only when the client version is <= the template
 * version. A client newer than the template would expose the fake fingerprint
 * by emitting beta tokens that a real client-at-template-version could not
 * know about, so we silently drop them in that case.
 */
function canPassthroughClientBetas(
  clientVersion: [number, number, number],
  template: BodyTemplate | null | undefined,
): boolean {
  if (!template) return false
  const templateVersion = parseTemplateCcVersion(template.ccVersion)
  if (!templateVersion) return false
  return isVersionAtLeast(templateVersion, clientVersion)
}

const EMPTY_BODY = Buffer.alloc(0)

const SENSITIVE_CAPTURE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
])

const HTTP_ROUTES = [
  {
    pattern: /^\/api\/hello$/,
    authStrategy: 'none',
    methods: ['GET'],
  },
  {
    pattern: /^\/v1\/oauth\/hello$/,
    authStrategy: 'none',
    methods: ['GET'],
  },
  {
    pattern: /^\/v1\/code\/upstreamproxy\/ca-cert$/,
    authStrategy: 'none',
    methods: ['GET'],
  },
  {
    pattern: /^\/v1\/code\/sessions\/[^/]+\/worker(?:\/.*)?$/,
    authStrategy: 'preserve_incoming_auth',
    methods: ['GET', 'POST', 'PUT'],
  },
  {
    pattern: /^\/v1\/environments\/[^/]+\/work\/poll$/,
    authStrategy: 'preserve_incoming_auth',
    methods: ['GET'],
  },
  {
    pattern: /^\/v1\/environments\/[^/]+\/work\/[^/]+\/ack$/,
    authStrategy: 'preserve_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/v1\/environments\/[^/]+\/work\/[^/]+\/heartbeat$/,
    authStrategy: 'preserve_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/v1\/sessions\/[^/]+\/events$/,
    authStrategy: 'preserve_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/v1\/session_ingress(?:\/.+)?$/,
    authStrategy: 'preserve_incoming_auth',
    methods: ['GET', 'POST'],
  },
  {
    pattern: /^\/v1\/messages(?:\/count_tokens)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/v1\/responses(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['DELETE', 'GET', 'POST'],
  },
  {
    pattern: /^\/v1\/chat\/completions$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/v1\/models$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET'],
  },
  {
    pattern: /^\/v1\/files(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET', 'POST'],
  },
  {
    pattern: /^\/v1\/mcp_servers(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET'],
  },
  {
    pattern: /^\/v1\/ultrareview(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET'],
  },
  {
    pattern: /^\/v1\/environment_providers(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET', 'POST'],
  },
  {
    pattern: /^\/v1\/environments(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['DELETE', 'GET', 'POST'],
  },
  {
    pattern: /^\/v1\/sessions(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET', 'PATCH', 'POST'],
  },
  {
    pattern: /^\/v1\/code(?:\/.+)?$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET', 'PATCH', 'POST', 'PUT'],
  },
  {
    pattern: /^\/api\/oauth\/.+$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET', 'POST'],
  },
  {
    pattern: /^\/api\/claude_cli\/.+$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET', 'POST'],
  },
  {
    pattern: /^\/api\/claude_cli_profile$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET'],
  },
  {
    pattern: /^\/api\/claude_cli_feedback$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/api\/claude_code\/.+$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET', 'POST', 'PUT'],
  },
  {
    pattern: /^\/api\/claude_code_grove$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET'],
  },
  {
    pattern: /^\/api\/claude_code_penguin_mode$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET'],
  },
  {
    pattern: /^\/api\/claude_code_shared_session_transcripts$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/api\/event_logging\/.+$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['POST'],
  },
  {
    pattern: /^\/api\/organization\/claude_code_first_token_date$/,
    authStrategy: 'prefer_incoming_auth',
    methods: ['GET'],
  },
] as const

type HttpRoute = (typeof HTTP_ROUTES)[number]

const WEBSOCKET_ROUTES = [
  {
    pattern: /^\/v1\/sessions\/ws\/[^/]+\/subscribe$/,
    authStrategy: 'prefer_incoming_auth',
    stickyKeyMode: 'session_id_path',
  },
  {
    pattern: /^\/v1\/session_ingress\/ws\/[^/]+$/,
    authStrategy: 'preserve_incoming_auth',
    stickyKeyMode: 'none',
  },
  {
    pattern: /^\/v1\/code\/upstreamproxy\/ws$/,
    authStrategy: 'preserve_incoming_auth',
    stickyKeyMode: 'none',
  },
  {
    pattern: /^\/api\/ws\/speech_to_text\/voice_stream$/,
    authStrategy: 'prefer_incoming_auth',
    stickyKeyMode: 'headers_only',
  },
] as const

type WebSocketRoute = (typeof WEBSOCKET_ROUTES)[number]

type ConnectedUpstreamSocket = {
  ws: WebSocket
  accountId: string | null
  retryCount: number
  earlyCapture: EarlyUpstreamCapture
  upgradeHeaders: IncomingHttpHeaders
  upgradeRawHeaders: string[] | undefined
  upstreamRequestHeaders?: Record<string, string | string[] | undefined> | null
}

type ForwardedHttpResponse = {
  statusCode: number
  statusText: string
  headers: IncomingHttpHeaders
  rawHeaders: string[] | undefined
  body: Awaited<ReturnType<typeof request>>['body']
  upstreamRequestHeaders?: string[]
}

type WebSocketUsageContext = {
  requestId: string
  requestHeaders: Record<string, string | string[] | undefined> | null
  target: string
  userId: string | null
  relayKeySource: RelayKeySource | null
  sessionKey: string | null
  clientDeviceId: string | null
  startedAt: number
}

type EarlyUpstreamCapture = {
  close: { code: number; reason: Buffer } | null
  messages: Array<{ data: string | Buffer; isBinary: boolean }>
  release: () => void
}

class UpstreamWebSocketError extends Error {
  readonly responseText: string

  constructor(
    message: string,
    readonly statusCode: number = 502,
    readonly responseBody: Buffer = Buffer.alloc(0),
    readonly responseHeaders: IncomingHttpHeaders = {},
    readonly responseRawHeaders: string[] | undefined = undefined,
    readonly responseStatusMessage: string | undefined = undefined,
    readonly retryCount: number = 0,
  ) {
    super(message)
    this.name = 'UpstreamWebSocketError'
    this.responseText = responseBody.toString('utf8')
  }
}

export class RelayService {
  private readonly recentServerFailures: UpstreamFailureRecord[] = []
  private upstreamIncidentActiveUntil = 0

  constructor(
    private readonly oauthService: OAuthService,
    private readonly proxyPool: ProxyPool,
    private readonly healthTracker: AccountHealthTracker,
    private readonly logger: RelayLogger = new ConsoleRelayLogger(),
    private readonly usageStore: UsageStore | null = null,
    private readonly userStore: UserStore | null = null,
    private readonly billingStore: BillingStore | null = null,
    private readonly apiKeyStore: ApiKeyStore | null = null,
  ) {}

  private async lookupRelayUserByToken(token: string): Promise<ResolvedRelayUserLookup> {
    // relay_users.api_key and relay_api_keys currently share the same rk_* wire format.
    // Prefer relay_api_keys as the runtime source of truth and only fall back to legacy
    // relay_users.api_key when the hashed multi-key store does not recognize the token.
    if (this.apiKeyStore) {
      const hit = await this.apiKeyStore.lookupByKey(token)
      if (hit) {
        const user = await this.userStore?.getUserById(hit.userId)
        if (user) {
          return {
            user,
            resolvedKeyId: hit.keyId,
            relayKeySource: 'relay_api_keys',
          }
        }
      }
    }

    const legacyUser = this.userStore?.getUserByApiKey(token) ?? null
    return {
      user: legacyUser,
      resolvedKeyId: null,
      relayKeySource: legacyUser ? 'relay_users_legacy' : null,
    }
  }

  private async resolveRelayUser(headers: IncomingHttpHeaders): Promise<ResolvedRelayUserContext> {
    if (!this.userStore) {
      return {
        userId: null,
        userAccountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: appConfig.billingCurrency as BillingCurrency,
        relayKeySource: null,
        stripped: false,
        rejected: null,
      }
    }
    const authHeader = typeof headers.authorization === 'string' ? headers.authorization : ''
    const xApiKey = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : xApiKey.trim()
    if (!token.startsWith('rk_')) {
      return {
        userId: null,
        userAccountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: appConfig.billingCurrency as BillingCurrency,
        relayKeySource: null,
        stripped: false,
        rejected: null,
      }
    }

    const { user, resolvedKeyId, relayKeySource } = await this.lookupRelayUserByToken(token)
    if (user && resolvedKeyId) {
      this.apiKeyStore?.touchLastUsed(resolvedKeyId)
    }
    if (!user) {
      return {
        userId: null,
        userAccountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: appConfig.billingCurrency as BillingCurrency,
        relayKeySource: null,
        stripped: false,
        rejected: 'Invalid relay API key',
      }
    }
    if (!user.isActive) {
      return {
        userId: null,
        userAccountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: user.billingMode,
        billingCurrency: user.billingCurrency,
        relayKeySource,
        stripped: false,
        rejected: 'User is disabled',
      }
    }
    // Strip the relay key so downstream treats this as no-auth → oauth mode
    headers.authorization = ''
    delete headers['x-api-key']
    return {
      userId: user.id,
      userAccountId: user.accountId,
      routingMode: user.routingMode,
      routingGroupId: user.routingGroupId ?? user.preferredGroup,
      preferredGroup: user.preferredGroup,
      billingMode: user.billingMode,
      billingCurrency: user.billingCurrency,
      relayKeySource,
      stripped: true,
      rejected: null,
    }
  }

  private isBillableUsageRequest(method: string, path: string): boolean {
    if (method !== 'POST') {
      return false
    }
    return (
      path === '/v1/messages' ||
      path === '/v1/chat/completions' ||
      path === '/v1/responses' ||
      path.startsWith('/v1/responses/')
    )
  }

  private async assertRelayUserCanConsume(input: {
    userId: string | null
    billingMode: 'postpaid' | 'prepaid'
    method: string
    path: string
  }): Promise<void> {
    if (!this.billingStore || !input.userId || input.billingMode !== 'prepaid') {
      return
    }
    if (!this.isBillableUsageRequest(input.method, input.path)) {
      return
    }
    await this.billingStore.assertUserCanConsume(input.userId)
  }

  private extractRequestedModel(body: RelayRequestBody): string | null {
    if (!Buffer.isBuffer(body)) {
      return null
    }
    try {
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      const model = parsed.model
      return typeof model === 'string' && model.trim() ? model.trim() : null
    } catch {
      return null
    }
  }

  private async rejectIfMissingBillingRule(input: {
    res: Response
    trace: HttpTraceContext
    routeAuthStrategy: RouteAuthStrategy
    forceAccountId: string | null
    relayUser: ResolvedRelayUserContext
    method: string
    path: string
    target: string
    accountId: string | null
    provider: AccountProvider | null
    body: RelayRequestBody
  }): Promise<boolean> {
    if (!this.billingStore || !input.relayUser.userId || !this.isBillableUsageRequest(input.method, input.path)) {
      return false
    }
    const model = this.extractRequestedModel(input.body)
    const result = await this.billingStore.preflightBillableRequest({
      userId: input.relayUser.userId,
      billingCurrency: input.relayUser.billingCurrency,
      accountId: input.accountId,
      provider: input.provider,
      model,
      target: input.target,
    })
    if (result.ok) {
      return false
    }
    const message = `Billing rule missing or zero-priced for model ${model ?? '(unknown)'}. Request blocked before upstream forwarding.`
    input.res.status(402).json(
      localHttpErrorBody(input.path, 402, message, RELAY_ERROR_CODES.BILLING_RULE_MISSING),
    )
    this.logHttpRejection(input.trace, {
      error: `billing_rule_preflight_failed:${result.status}: model=${model ?? '(unknown)'} rule=${result.matchedRuleId ?? '(none)'}`,
      forceAccountId: input.forceAccountId,
      internalCode: RELAY_ERROR_CODES.BILLING_RULE_MISSING,
      routeAuthStrategy: input.routeAuthStrategy,
      statusCode: 402,
      statusText: STATUS_CODES[402] ?? 'Payment Required',
    })
    return true
  }

  private async serveModelsCatalog(input: {
    res: Response
    trace: HttpTraceContext
    route: { authStrategy: RouteAuthStrategy }
    forceAccountId: string | null
    relayUser: ResolvedRelayUserContext
  }): Promise<void> {
    if (!input.relayUser.userId) {
      input.res.status(401).json(
        localHttpErrorBody(
          '/v1/models',
          401,
          'Relay API key required',
          RELAY_ERROR_CODES.RELAY_USER_REJECTED,
        ),
      )
      this.logHttpRejection(input.trace, {
        error: 'models_catalog_no_relay_user',
        forceAccountId: input.forceAccountId,
        internalCode: RELAY_ERROR_CODES.RELAY_USER_REJECTED,
        routeAuthStrategy: input.route.authStrategy,
        statusCode: 401,
        statusText: STATUS_CODES[401] ?? 'Unauthorized',
      })
      return
    }

    if (!this.billingStore) {
      input.res.status(503).json(
        localHttpErrorBody(
          '/v1/models',
          503,
          'Service is temporarily unavailable. Please try again later.',
          RELAY_ERROR_CODES.SERVICE_UNAVAILABLE,
        ),
      )
      this.logHttpRejection(input.trace, {
        error: 'models_catalog_billing_store_missing',
        forceAccountId: input.forceAccountId,
        internalCode: RELAY_ERROR_CODES.SERVICE_UNAVAILABLE,
        routeAuthStrategy: input.route.authStrategy,
        statusCode: 503,
        statusText: STATUS_CODES[503] ?? 'Service Unavailable',
      })
      return
    }

    const rules = await this.billingStore.listRules(input.relayUser.billingCurrency)
    const now = Date.now()
    const eligible: BillingRule[] = []
    for (const rule of rules) {
      if (!rule.isActive) continue
      if (rule.id.startsWith(SYSTEM_FALLBACK_RULE_ID_PREFIX)) continue
      const model = rule.model?.trim()
      if (!model) continue
      const effectiveFrom = Date.parse(rule.effectiveFrom)
      if (Number.isFinite(effectiveFrom) && now < effectiveFrom) continue
      if (rule.effectiveTo) {
        const effectiveTo = Date.parse(rule.effectiveTo)
        if (Number.isFinite(effectiveTo) && now >= effectiveTo) continue
      }
      eligible.push(rule)
    }

    const byModel = new Map<string, BillingRule>()
    for (const rule of eligible) {
      const model = (rule.model ?? '').trim()
      const existing = byModel.get(model)
      if (!existing) {
        byModel.set(model, rule)
        continue
      }
      const existingFrom = Date.parse(existing.effectiveFrom)
      const ruleFrom = Date.parse(rule.effectiveFrom)
      if (Number.isFinite(ruleFrom) && (!Number.isFinite(existingFrom) || ruleFrom < existingFrom)) {
        byModel.set(model, rule)
      }
    }

    const data = [...byModel.entries()]
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
      .map(([model, rule]) => {
        const effectiveFromMs = Date.parse(rule.effectiveFrom)
        const created = Number.isFinite(effectiveFromMs)
          ? Math.max(0, Math.floor(effectiveFromMs / 1000))
          : 0
        return {
          id: model,
          object: 'model',
          created,
          owned_by: 'reseller',
        }
      })

    input.res.status(200).json({
      object: 'list',
      data,
    })

    this.safeLog({
      event: 'http_completed',
      requestId: input.trace.requestId,
      method: input.trace.method,
      target: input.trace.target,
      durationMs: Date.now() - input.trace.startedAt,
      routeAuthStrategy: input.route.authStrategy,
      forceAccountId: input.forceAccountId,
      statusCode: 200,
      statusText: STATUS_CODES[200] ?? 'OK',
    })
  }

  async handle(req: Request, res: Response): Promise<void> {
    const trace = this.createTraceContext(req.method, req.originalUrl, req.headers)
    const requestUrl = this.buildUpstreamUrlFromRawUrl(req.originalUrl)

    try {
      const route = this.matchHttpRoute(req.path)
      if (!route) {
        res.status(404).json(localHttpErrorBody(req.path, 404, `Not Found`, RELAY_ERROR_CODES.ROUTE_NOT_FOUND))
        this.logHttpRejection(trace, {
          error: 'unsupported_path',
          internalCode: RELAY_ERROR_CODES.ROUTE_NOT_FOUND,
          routeAuthStrategy: null,
          statusCode: 404,
          statusText: STATUS_CODES[404] ?? 'Not Found',
        })
        return
      }

      if (!this.isMethodAllowed(route.methods, req.method)) {
        res.setHeader('Allow', this.buildAllowHeader(route.methods))
        res.status(405).json(
          localHttpErrorBody(
            req.path,
            405,
            `Method ${req.method} is not allowed for ${req.path}`,
            RELAY_ERROR_CODES.METHOD_NOT_ALLOWED,
          ),
        )
        this.logHttpRejection(trace, {
          error: 'unsupported_method',
          internalCode: RELAY_ERROR_CODES.METHOD_NOT_ALLOWED,
          routeAuthStrategy: route.authStrategy,
          statusCode: 405,
          statusText: STATUS_CODES[405] ?? 'Method Not Allowed',
        })
        return
      }

      let forceAccountId: string | null = null
      try {
        forceAccountId = this.parseForceAccountIdFromIncoming(
          req.headers,
          requestUrl.searchParams,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.status(400).json(
          localHttpErrorBody(req.path, 400, message, RELAY_ERROR_CODES.INVALID_FORCE_ACCOUNT),
        )
        this.logHttpRejection(trace, {
          error: message,
          forceAccountId: null,
          internalCode: RELAY_ERROR_CODES.INVALID_FORCE_ACCOUNT,
          routeAuthStrategy: route.authStrategy,
          statusCode: 400,
          statusText: STATUS_CODES[400] ?? 'Bad Request',
        })
        return
      }
      const explicitForceAccountId = forceAccountId

      // ── Relay user resolution ──
      const relayUser = await this.resolveRelayUser(req.headers)
      if (relayUser.rejected) {
        res.status(401).json(
          localHttpErrorBody(
            req.path,
            401,
            relayUser.rejected,
            RELAY_ERROR_CODES.RELAY_USER_REJECTED,
          ),
        )
        this.logHttpRejection(trace, {
          error: `relay_user_rejected: ${relayUser.rejected}`,
          forceAccountId: null,
          internalCode: RELAY_ERROR_CODES.RELAY_USER_REJECTED,
          routeAuthStrategy: route.authStrategy,
          statusCode: 401,
          statusText: STATUS_CODES[401] ?? 'Unauthorized',
        })
        return
      }
      if (relayUser.routingMode === 'pinned_account' && relayUser.userAccountId && !forceAccountId) {
        forceAccountId = relayUser.userAccountId
      }
      try {
        await this.assertRelayUserCanConsume({
          userId: relayUser.userId,
          billingMode: relayUser.billingMode,
          method: req.method,
          path: req.path,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.status(402).json(
          localHttpErrorBody(
            req.path,
            402,
            message,
            RELAY_ERROR_CODES.BILLING_INSUFFICIENT_BALANCE,
          ),
        )
        this.logHttpRejection(trace, {
          error: `insufficient_balance: ${message}`,
          forceAccountId,
          internalCode: RELAY_ERROR_CODES.BILLING_INSUFFICIENT_BALANCE,
          routeAuthStrategy: route.authStrategy,
          statusCode: 402,
          statusText: STATUS_CODES[402] ?? 'Payment Required',
        })
        return
      }

      if (req.method === 'GET' && req.path === '/v1/models') {
        await this.serveModelsCatalog({
          res,
          trace,
          route,
          forceAccountId,
          relayUser,
        })
        return
      }

      const sessionKey = this.extractStickySessionKeyFromHeaders(req.headers)
      let preparedRequestBody: PreparedRequestBody
      try {
        preparedRequestBody = await this.prepareRequestBody(req)
      } catch (error) {
        if (error instanceof BufferedRequestBodyTooLargeError) {
          res.status(413).json(
            localHttpErrorBody(req.path, 413, error.message, RELAY_ERROR_CODES.BODY_TOO_LARGE),
          )
          this.logHttpRejection(trace, {
            error: error.message,
            forceAccountId,
            internalCode: RELAY_ERROR_CODES.BODY_TOO_LARGE,
            routeAuthStrategy: route.authStrategy,
            statusCode: 413,
            statusText: STATUS_CODES[413] ?? 'Payload Too Large',
          })
          return
        }
        throw error
      }
      const rawRequestBody = preparedRequestBody.bufferedBody
      const requestBody = preparedRequestBody.body
      const clientDeviceId = this.resolveClientDeviceId(
        rawRequestBody,
        req.headers,
        requestUrl.searchParams,
      )
      const routingGroupId = this.extractAccountGroup(req.headers) ?? (
        relayUser.routingMode === 'preferred_group'
          ? (relayUser.routingGroupId ?? relayUser.preferredGroup)
          : null
      )
      try {
        await this.assertRoutingGroupEnabled(routingGroupId)
      } catch (error) {
        if (error instanceof RoutingGroupAccessError) {
          const clientError = classifyClientFacingRelayError(error)
          const statusCode = clientError?.statusCode ?? 403
          const message = clientError?.message ?? 'Requested routing group is unavailable.'
          const internalCode = clientError?.code ?? RELAY_ERROR_CODES.ROUTING_GROUP_UNAVAILABLE
          res.status(statusCode).json(localHttpErrorBody(req.path, statusCode, message, internalCode))
          this.logHttpRejection(trace, {
            error: error.message,
            forceAccountId,
            internalCode,
            routeAuthStrategy: route.authStrategy,
            statusCode,
            statusText: STATUS_CODES[statusCode] ?? 'Forbidden',
          })
          return
        }
        throw error
      }
      const requestedProvider = await this.resolveRequestedProvider(
        forceAccountId,
        req.path,
        routingGroupId,
      )

      if (requestedProvider === 'openai-codex') {
        await this.handleOpenAICodexHttp({
          req,
          res,
          trace,
          route,
          requestBody,
          rawRequestBody,
          forceAccountId,
          explicitForceAccountId,
          sessionKey,
          routingGroupId,
          relayUser,
          clientDeviceId,
        })
        return
      }

      if (requestedProvider === 'openai-compatible') {
        await this.handleOpenAICompatibleHttp({
          req,
          res,
          trace,
          route,
          requestBody,
          rawRequestBody,
          forceAccountId,
          sessionKey,
          routingGroupId,
          relayUser,
          clientDeviceId,
        })
        return
      }

      if (requestedProvider === 'claude-compatible') {
        await this.handleClaudeCompatibleHttp({
          req,
          res,
          trace,
          route,
          requestBody,
          rawRequestBody,
          forceAccountId,
          sessionKey,
          routingGroupId,
          relayUser,
          clientDeviceId,
        })
        return
      }

      const clientVersion = parseClaudeCliVersion(req.headers['user-agent'])
      const normalizedClientVersion: [number, number, number] = clientVersion ?? [
        MIN_CLAUDE_CLI_VERSION[0],
        MIN_CLAUDE_CLI_VERSION[1],
        MIN_CLAUDE_CLI_VERSION[2],
      ]
      if (this.requiresClaudeCliVersionCheck(req.path)) {
        if (!clientVersion) {
          res.status(400).json(anthropicErrorBody(400, `Unsupported client. Please use Claude Code ${MIN_CLAUDE_CLI_VERSION.join('.')} or later.`, RELAY_ERROR_CODES.UNSUPPORTED_CLIENT))
          this.logHttpRejection(trace, {
            error: `unsupported_client: ${req.headers['user-agent'] ?? '(none)'}`,
            internalCode: RELAY_ERROR_CODES.UNSUPPORTED_CLIENT,
            routeAuthStrategy: route.authStrategy,
            statusCode: 400,
            statusText: STATUS_CODES[400] ?? 'Bad Request',
          })
          return
        }
        if (!isVersionAtLeast(clientVersion, MIN_CLAUDE_CLI_VERSION)) {
          const versionStr = clientVersion.join('.')
          res.status(400).json(anthropicErrorBody(400, `Claude Code version ${versionStr} is not supported. Please use ${MIN_CLAUDE_CLI_VERSION.join('.')} or later.`, RELAY_ERROR_CODES.UNSUPPORTED_CLIENT_VERSION))
          this.logHttpRejection(trace, {
            error: `unsupported_client_version: ${versionStr}`,
            internalCode: RELAY_ERROR_CODES.UNSUPPORTED_CLIENT_VERSION,
            routeAuthStrategy: route.authStrategy,
            statusCode: 400,
            statusText: STATUS_CODES[400] ?? 'Bad Request',
          })
          return
        }
      }

      const authMode = this.resolveUpstreamAuthMode(
        route.authStrategy,
        req.headers,
        forceAccountId,
      )

      if (authMode === 'oauth' && this.maybeRejectRequestForUpstreamIncident(trace, res, route.authStrategy, forceAccountId)) {
        return
      }

      if (authMode !== 'oauth') {
        let resolvedForProxy: ResolvedAccount
        try {
          resolvedForProxy = await this.oauthService.selectAccount({
            provider: CLAUDE_OFFICIAL_PROVIDER.id,
            forceAccountId,
            routingGroupId,
            userId: relayUser.userId,
            clientDeviceId,
          })
        } catch (error) {
          if (error instanceof SchedulerCapacityError) {
            res.status(529).json(anthropicErrorBody(529, 'Service is at capacity. Please try again later.', RELAY_ERROR_CODES.SCHEDULER_CAPACITY))
            this.logHttpRejection(trace, {
              error: formatSchedulerCapacityError(error),
              forceAccountId,
              internalCode: RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
              routeAuthStrategy: route.authStrategy,
              statusCode: 529,
              statusText: 'Overloaded',
            })
            return
          }
          if (error instanceof RoutingGuardError) {
            res.status(429).json(anthropicErrorBody(429, error.message, RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT))
            this.logHttpRejection(trace, {
              error: `routing_guard:${error.code}: current=${error.current} limit=${error.limit}`,
              forceAccountId,
              internalCode: RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT,
              routeAuthStrategy: route.authStrategy,
              statusCode: 429,
              statusText: STATUS_CODES[429] ?? 'Too Many Requests',
            })
            return
          }
          const clientError = classifyClientFacingRelayError(error)
          if (clientError) {
            res.status(clientError.statusCode).json(
              anthropicErrorBody(clientError.statusCode, clientError.message, clientError.code),
            )
            this.logHttpRejection(trace, {
              error: error instanceof Error ? error.message : String(error),
              forceAccountId,
              internalCode: clientError.code,
              routeAuthStrategy: route.authStrategy,
              statusCode: clientError.statusCode,
              statusText: STATUS_CODES[clientError.statusCode] ?? 'Error',
            })
            return
          }
          throw error
        }
        const accountProxyUrl = this.requireProxyUrl(
          resolvedForProxy.proxyUrl,
          `Account ${resolvedForProxy.account.id} has no proxy configured`,
        )
        const effectiveTemplate = this.applyAccountOverrides(
          this.selectBodyTemplate(normalizedClientVersion, resolvedForProxy.bodyTemplate),
          resolvedForProxy.account,
        )
        const forwardedBody = this.maybeRewriteBufferedRequestBody(
          requestBody,
          req.method,
          req.path,
          normalizedClientVersion,
          effectiveTemplate,
        )
        this.logBodyRewriteMetrics({
          trace,
          stage: 'body_template',
          accountId: resolvedForProxy.account.id,
          clientVersion: normalizedClientVersion,
          template: effectiveTemplate,
          originalBody: requestBody,
          rewrittenBody: forwardedBody,
        })
        if (await this.rejectIfMissingBillingRule({
          res,
          trace,
          routeAuthStrategy: route.authStrategy,
          forceAccountId,
          relayUser,
          method: req.method,
          path: req.path,
          target: trace.target,
          accountId: resolvedForProxy.account.id,
          provider: CLAUDE_OFFICIAL_PROVIDER.id,
          body: forwardedBody,
        })) {
          return
        }
        const upstream = await this.forward(req, null, forwardedBody, authMode, {
          routeAuthStrategy: route.authStrategy,
          trace,
          dispatcher: this.proxyPool.getHttpDispatcher(accountProxyUrl),
          vmFingerprintHeaders: resolvedForProxy.vmFingerprintHeaders,
          anthropicBeta: effectiveTemplate?.anthropicBeta,
          allowClientBetaPassthrough: canPassthroughClientBetas(
            normalizedClientVersion,
            effectiveTemplate,
          ),
        })
        this.writeResponseHead(
          res,
          upstream.statusCode,
          upstream.statusText,
          upstream.headers,
          upstream.rawHeaders,
        )
        const observation = await this.pipelineWithUsageTracking(upstream, res, {
          requestId: trace.requestId,
          accountId: resolvedForProxy.account.id,
          userId: relayUser.userId,
          relayKeySource: relayUser.relayKeySource,
          sessionKey,
          clientDeviceId,
          durationMs: Date.now() - trace.startedAt,
          target: trace.target,
          path: req.path,
          method: req.method,
          requestHeaders: RelayService.sanitizeHeaders(req.headers),
          requestBodyPreview: RelayService.truncateBody(rawRequestBody),
          upstreamRequestHeaders: upstream.upstreamRequestHeaders ? RelayService.rawHeadersToObject(upstream.upstreamRequestHeaders) : null,
        })
        if (upstream.statusCode >= 500) {
          this.trackUpstreamServerFailure(resolvedForProxy.account.id, trace)
        }
        await this.oauthService.markAccountUsed(resolvedForProxy.account.id)
        this.logHttpCompleted(trace, {
          accountId: resolvedForProxy.account.id,
          authMode,
          forceAccountId,
          hasStickySessionKey: Boolean(sessionKey),
          retryCount: 0,
          routeAuthStrategy: route.authStrategy,
          upstreamHeaders: upstream.headers,
          rateLimitStatus: observation.rateLimitStatus,
          responseBodyPreview: observation.responseBodyPreview,
          responseContentType: observation.responseContentType,
          statusCode: upstream.statusCode,
          statusText: upstream.statusText,
        })
        return
      }

      let retryCount = 0
      const sameRequestDisallowed: string[] = []
      let resolved: ResolvedAccount
      try {
        resolved = await this.oauthService.selectAccount({
          provider: CLAUDE_OFFICIAL_PROVIDER.id,
          sessionKey,
          forceAccountId,
          routingGroupId,
          userId: relayUser.userId,
          clientDeviceId,
          currentRequestBodyPreview: RelayService.truncateBody(rawRequestBody),
      })
      } catch (error) {
        if (error instanceof SchedulerCapacityError) {
          res.status(529).json(anthropicErrorBody(529, 'Service is at capacity. Please try again later.', RELAY_ERROR_CODES.SCHEDULER_CAPACITY))
          this.logHttpRejection(trace, {
            error: formatSchedulerCapacityError(error),
            forceAccountId,
            internalCode: RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
            routeAuthStrategy: route.authStrategy,
            statusCode: 529,
            statusText: 'Overloaded',
          })
          return
        }
        if (error instanceof RoutingGuardError) {
          res.status(429).json(anthropicErrorBody(429, error.message, RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT))
          this.logHttpRejection(trace, {
            error: `routing_guard:${error.code}: current=${error.current} limit=${error.limit}`,
            forceAccountId,
            internalCode: RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT,
            routeAuthStrategy: route.authStrategy,
            statusCode: 429,
            statusText: STATUS_CODES[429] ?? 'Too Many Requests',
          })
          return
        }
        const clientError = classifyClientFacingRelayError(error)
        if (clientError) {
          res.status(clientError.statusCode).json(
            anthropicErrorBody(clientError.statusCode, clientError.message, clientError.code),
          )
          this.logHttpRejection(trace, {
            error: error instanceof Error ? error.message : String(error),
            forceAccountId,
            internalCode: clientError.code,
            routeAuthStrategy: route.authStrategy,
            statusCode: clientError.statusCode,
            statusText: STATUS_CODES[clientError.statusCode] ?? 'Error',
          })
          return
        }
        throw error
      }

      if (resolved.isCooldownFallback) {
        const now = Date.now()
        const cooldownUntil = resolved.account.cooldownUntil ?? 0
        const retryAfterSec = cooldownUntil > now
          ? Math.ceil((cooldownUntil - now) / 1000)
          : Math.ceil(appConfig.rateLimitCooldownFallbackMs / 1000)
        res.status(503)
          .set('Retry-After', String(retryAfterSec))
          .json(anthropicErrorBody(503, `All accounts are rate-limited. Retry after ${retryAfterSec}s.`, RELAY_ERROR_CODES.ACCOUNT_POOL_RATE_LIMITED))
        this.logHttpRejection(trace, {
          error: 'pool_exhausted: all accounts in cooldown',
          forceAccountId,
          internalCode: RELAY_ERROR_CODES.ACCOUNT_POOL_RATE_LIMITED,
          routeAuthStrategy: route.authStrategy,
          statusCode: 503,
          statusText: 'Service Unavailable',
        })
        return
      }

      const effectiveTemplate = this.applyAccountOverrides(this.selectBodyTemplate(normalizedClientVersion, resolved.bodyTemplate), resolved.account)
      const baseRequestBody = this.maybeRewriteBufferedRequestBody(
        requestBody,
        req.method,
        req.path,
        normalizedClientVersion,
        effectiveTemplate,
      )
      this.logBodyRewriteMetrics({
        trace,
        stage: 'body_template',
        accountId: resolved.account.id,
        clientVersion: normalizedClientVersion,
        template: effectiveTemplate,
        originalBody: requestBody,
        rewrittenBody: baseRequestBody,
      })
      const canReplayRequestBody = this.canReplayRequestBody(baseRequestBody)

      let accountProxyUrl = this.requireProxyUrl(
        resolved.proxyUrl,
        `Account ${resolved.account.id} has no proxy configured`,
      )

      while (true) {
        let requestBody = baseRequestBody
        const routedRequest = this.applySessionRouteToHttpRequest(req, requestBody, resolved)
        requestBody = routedRequest.body
        this.logBodyRewriteMetrics({
          trace,
          stage: 'session_route',
          accountId: resolved.account.id,
          clientVersion: normalizedClientVersion,
          template: effectiveTemplate,
          originalBody: baseRequestBody,
          rewrittenBody: requestBody,
          handoffInjected: routedRequest.handoffInjected,
        })
        if (await this.rejectIfMissingBillingRule({
          res,
          trace,
          routeAuthStrategy: route.authStrategy,
          forceAccountId,
          relayUser,
          method: req.method,
          path: req.path,
          target: trace.target,
          accountId: resolved.account.id,
          provider: CLAUDE_OFFICIAL_PROVIDER.id,
          body: requestBody,
        })) {
          return
        }
        let upstream: Awaited<ReturnType<typeof this.forward>>
        try {
          upstream = await this.forward(req, resolved.account.accessToken, requestBody, 'oauth', {
            routeAuthStrategy: route.authStrategy,
            trace,
            dispatcher: this.proxyPool.getHttpDispatcher(accountProxyUrl),
            vmFingerprintHeaders: resolved.vmFingerprintHeaders,
            anthropicBeta: effectiveTemplate?.anthropicBeta,
            headerOverrides: routedRequest.headerOverrides,
            upstreamUrlOverride: routedRequest.upstreamUrlOverride,
            allowClientBetaPassthrough: canPassthroughClientBetas(
              normalizedClientVersion,
              effectiveTemplate,
            ),
          })
        } catch (networkError) {
          this.healthTracker.recordError(resolved.account.id)
          throw networkError
        }

        const retryAfterSec = this.parseRetryAfterSeconds(upstream.headers)
        this.healthTracker.recordResponse(
          resolved.account.id,
          upstream.statusCode,
          retryAfterSec,
        )
        if (upstream.statusCode >= 500) {
          this.trackUpstreamServerFailure(resolved.account.id, trace)
        }

        let bufferedFailureBody: Buffer | null = null
        let bufferedFailureText: string | null = null
        if (
          upstream.statusCode === 400 ||
          upstream.statusCode === 401 ||
          upstream.statusCode === 403 ||
          upstream.statusCode === 429
        ) {
          bufferedFailureBody = Buffer.from(
            await upstream.body.arrayBuffer().catch(() => new ArrayBuffer(0)),
          )
          bufferedFailureText = bufferedFailureBody.toString('utf8')
        }

        const rl = bufferedFailureBody
          ? extractRateLimitInfoFromErrorResponse({
              statusCode: upstream.statusCode,
              headers: upstream.headers,
              body: bufferedFailureBody,
            })
          : extractRateLimitInfo(upstream.headers)
        await this.oauthService.recordRateLimitSnapshot({
          accountId: resolved.account.id,
          status: rl.status,
          fiveHourUtilization: rl.fiveHourUtilization,
          sevenDayUtilization: rl.sevenDayUtilization,
          resetTimestamp: rl.resetTimestamp,
          observedAt: Date.now(),
        })
        if (upstream.statusCode === 429) {
          const longBan = this.isLongBanCooldown(retryAfterSec, rl.resetTimestamp)
          if (longBan.isLong) {
            void this.oauthService.markAccountLongTermBlock(resolved.account.id, longBan.blockUntilMs)
            this.safeLog({
              event: 'long_term_block_detected',
              requestId: trace.requestId,
              method: trace.method,
              target: trace.target,
              durationMs: Date.now() - trace.startedAt,
              accountId: resolved.account.id,
            })
          } else {
            this.scheduleAccountCooldown(
              resolved.account.id,
              this.computeRateLimitCooldownMs(retryAfterSec, rl.resetTimestamp),
              trace,
              req.method,
              trace.target,
            )
          }
        }

        const terminalAccountFailureReason =
          bufferedFailureText
            ? this.classifyTerminalAccountFailureReason(
                upstream.statusCode,
                bufferedFailureText,
              )
            : null
        if (terminalAccountFailureReason) {
          await this.oauthService.markAccountTerminalFailure(
            resolved.account.id,
            terminalAccountFailureReason,
          )
        }

        const hardFailureMigrationReason =
          terminalAccountFailureReason ??
          (bufferedFailureText
            ? this.classifyHardFailureMigrationReason(
                upstream.statusCode,
                bufferedFailureText,
              )
            : null)
        const canRetrySameRequestWithAlternateAccount =
          (
            req.path === '/v1/messages' ||
            req.path === '/v1/messages/count_tokens'
          ) &&
          retryCount < appConfig.sameRequestMaxRetries &&
          canReplayRequestBody
        const accountFailureMigrationReason =
          hardFailureMigrationReason && !explicitForceAccountId
            ? hardFailureMigrationReason
            : null
        const sessionRateLimitMigrationReason =
          Boolean(sessionKey) &&
          this.shouldRetryWithSessionMigration(
            upstream.statusCode,
            rl.status,
            retryAfterSec,
          )
            ? (rl.status ? `rate_limit:${rl.status}` : `status_${upstream.statusCode}`)
            : null
        const sameRequestMigrationReason =
          canRetrySameRequestWithAlternateAccount
            ? (accountFailureMigrationReason ?? sessionRateLimitMigrationReason)
            : null
        const sameRequestMigrationEligible = sameRequestMigrationReason !== null

        if (sameRequestMigrationEligible) {
          const retryFailureBody =
            bufferedFailureBody ??
            Buffer.from(await upstream.body.arrayBuffer().catch(() => new ArrayBuffer(0)))
          this.recordImmediateFailureUsage({
            requestId: trace.requestId,
            accountId: resolved.account.id,
            userId: relayUser.userId,
            relayKeySource: relayUser.relayKeySource,
            sessionKey,
            clientDeviceId,
            durationMs: Date.now() - trace.startedAt,
            target: trace.target,
            statusCode: upstream.statusCode,
            rateLimitStatus: rl.status,
            rateLimit5hUtilization: rl.fiveHourUtilization,
            rateLimit7dUtilization: rl.sevenDayUtilization,
            rateLimitReset: rl.resetTimestamp,
            requestHeaders: RelayService.sanitizeHeaders(req.headers),
            requestBodyPreview: RelayService.truncateBody(rawRequestBody),
            responseHeaders: RelayService.sanitizeHeaders(upstream.headers),
            responseBodyPreview: RelayService.truncateBody(retryFailureBody),
            upstreamRequestHeaders: upstream.upstreamRequestHeaders ? RelayService.rawHeadersToObject(upstream.upstreamRequestHeaders) : null,
          })
          try {
            sameRequestDisallowed.push(resolved.account.id)
            const backoffMs = Math.random() * (appConfig.sameRequestRetryBackoffMaxMs - appConfig.sameRequestRetryBackoffMinMs) + appConfig.sameRequestRetryBackoffMinMs
            this.safeLog({
              event: 'retry_attempt',
              requestId: trace.requestId,
              method: trace.method,
              target: trace.target,
              durationMs: Date.now() - trace.startedAt,
              retryAttempt: retryCount + 1,
              retryDelayMs: Math.round(backoffMs),
              retryDisallowedCount: sameRequestDisallowed.length,
              retryMigrationReason: sameRequestMigrationReason,
            })
            await this.sleepMs(backoffMs)
            resolved = await this.oauthService.selectAccount({
              provider: CLAUDE_OFFICIAL_PROVIDER.id,
              sessionKey,
              forceAccountId,
              routingGroupId,
              userId: relayUser.userId,
              clientDeviceId,
              disallowedAccountIds: [...sameRequestDisallowed],
              handoffReason: sameRequestMigrationReason,
              currentRequestBodyPreview: RelayService.truncateBody(rawRequestBody),
            })
            accountProxyUrl = this.requireProxyUrl(
              resolved.proxyUrl,
              `Account ${resolved.account.id} has no proxy configured`,
            )
            retryCount += 1
            continue
          } catch (error) {
            const clientError = terminalAccountFailureReason
              ? classifyClientFacingRelayError(error)
              : null
            if (clientError) {
              res.status(clientError.statusCode).json(
                anthropicErrorBody(clientError.statusCode, clientError.message, clientError.code),
              )
              this.logHttpRejection(trace, {
                error: error instanceof Error ? error.message : String(error),
                forceAccountId,
                internalCode: clientError.code,
                routeAuthStrategy: route.authStrategy,
                statusCode: clientError.statusCode,
                statusText: STATUS_CODES[clientError.statusCode] ?? 'Error',
              })
              return
            }
            upstream = {
              ...upstream,
              body: Readable.from(retryFailureBody) as ForwardedHttpResponse['body'],
            }
            // fall through and return the original upstream failure response
          }
        }

        if (!this.isAuthenticationFailure(upstream.statusCode)) {
          if (bufferedFailureBody) {
            this.writeResponseHead(
              res,
              upstream.statusCode,
              upstream.statusText,
              upstream.headers,
              upstream.rawHeaders,
            )
            res.end(bufferedFailureBody)
            const errorPreview = RelayService.decodeResponseBodyPreview(
              bufferedFailureBody,
              typeof upstream.headers['content-encoding'] === 'string'
                ? upstream.headers['content-encoding'].trim().toLowerCase()
                : null,
            )
            this.logHttpCompleted(trace, {
              accountId: resolved.account.id,
              authMode: 'oauth',
              forceAccountId,
              hasStickySessionKey: Boolean(sessionKey),
              retryAfterSeconds: retryAfterSec ?? null,
              sameRequestMigrationEligible,
              retryCount,
              routeAuthStrategy: route.authStrategy,
              upstreamHeaders: upstream.headers,
              rateLimitStatus: rl.status,
              responseBodyPreview: errorPreview,
              responseContentType:
                typeof upstream.headers['content-type'] === 'string'
                  ? upstream.headers['content-type']
                  : null,
              statusCode: upstream.statusCode,
              statusText: upstream.statusText,
            })
            return
          }
          this.writeResponseHead(
            res,
            upstream.statusCode,
            upstream.statusText,
            upstream.headers,
            upstream.rawHeaders,
          )
          await this.oauthService.markAccountUsed(resolved.account.id)
          // Auto-bind user to account on first successful request
          if (relayUser.userId && !relayUser.userAccountId && this.userStore) {
            this.userStore.bindAccountIfNeeded(relayUser.userId, resolved.account.id).catch(() => {})
          }
          const observation = await this.pipelineWithUsageTracking(upstream, res, {
            requestId: trace.requestId,
            accountId: resolved.account.id,
            userId: relayUser.userId,
            relayKeySource: relayUser.relayKeySource,
            sessionKey,
            clientDeviceId,
            durationMs: Date.now() - trace.startedAt,
            target: trace.target,
            path: req.path,
            method: req.method,
            requestHeaders: RelayService.sanitizeHeaders(req.headers),
            requestBodyPreview: RelayService.truncateBody(rawRequestBody),
            upstreamRequestHeaders: upstream.upstreamRequestHeaders ? RelayService.rawHeadersToObject(upstream.upstreamRequestHeaders) : null,
          })
          if (sessionKey && this.userStore) {
            await this.userStore.noteSessionRouteUsage({
              sessionKey,
              userId: relayUser.userId,
              clientDeviceId,
              accountId: resolved.account.id,
              rateLimitStatus: rl.status,
              rateLimit5hUtilization: rl.fiveHourUtilization,
              rateLimit7dUtilization: rl.sevenDayUtilization,
            })
            if (routedRequest.handoffInjected) {
              await this.userStore.clearPendingHandoffSummary(sessionKey)
            }
          }
          this.logHttpCompleted(trace, {
            accountId: resolved.account.id,
            authMode: 'oauth',
            forceAccountId,
            hasStickySessionKey: Boolean(sessionKey),
            retryAfterSeconds: retryAfterSec ?? null,
            sameRequestMigrationEligible,
            retryCount,
            routeAuthStrategy: route.authStrategy,
            upstreamHeaders: upstream.headers,
            rateLimitStatus: observation.rateLimitStatus,
            responseBodyPreview: observation.responseBodyPreview,
            responseContentType: observation.responseContentType,
            statusCode: upstream.statusCode,
            statusText: upstream.statusText,
          })
          return
        }

        const errorBody = bufferedFailureBody ?? Buffer.from(await upstream.body.arrayBuffer())
        const errorText = bufferedFailureText ?? errorBody.toString('utf8')
        if (
          terminalAccountFailureReason ||
          retryCount >= 5 ||
          !canReplayRequestBody ||
          !this.shouldRetryWithFreshToken(
            upstream.statusCode,
            errorText,
            resolved.account.accessToken,
          )
        ) {
          this.writeResponseHead(
            res,
            upstream.statusCode,
            upstream.statusText,
            upstream.headers,
            upstream.rawHeaders,
          )
          res.end(errorBody)
          const errorPreview = RelayService.decodeResponseBodyPreview(
            errorBody,
            typeof upstream.headers['content-encoding'] === 'string'
              ? upstream.headers['content-encoding'].trim().toLowerCase()
              : null,
          )
          this.logHttpCompleted(trace, {
            accountId: resolved.account.id,
            authMode: 'oauth',
            forceAccountId,
            hasStickySessionKey: Boolean(sessionKey),
            retryAfterSeconds: retryAfterSec ?? null,
            sameRequestMigrationEligible,
            retryCount,
            routeAuthStrategy: route.authStrategy,
            upstreamHeaders: upstream.headers,
            rateLimitStatus: rl.status,
            responseBodyPreview: errorPreview,
            responseContentType:
              typeof upstream.headers['content-type'] === 'string'
                ? upstream.headers['content-type']
                : null,
            statusCode: upstream.statusCode,
            statusText: upstream.statusText,
          })
          return
        }

        try {
          const recovery = await this.oauthService.recoverAccountAfterAuthFailure({
            failedAccountId: resolved.account.id,
            failedAccessToken: resolved.account.accessToken,
            sessionKey,
            forceAccountId,
            routingGroupId,
          })

          retryCount += 1
          resolved = recovery.resolved
          accountProxyUrl = this.requireProxyUrl(
            resolved.proxyUrl,
            `Account ${resolved.account.id} has no proxy configured`,
          )
        } catch {
          this.writeResponseHead(
            res,
            upstream.statusCode,
            upstream.statusText,
            upstream.headers,
            upstream.rawHeaders,
          )
          res.end(errorBody)
          const errorPreview = RelayService.decodeResponseBodyPreview(
            errorBody,
            typeof upstream.headers['content-encoding'] === 'string'
              ? upstream.headers['content-encoding'].trim().toLowerCase()
              : null,
          )
          this.logHttpCompleted(trace, {
            accountId: resolved.account.id,
            authMode: 'oauth',
            forceAccountId,
            hasStickySessionKey: Boolean(sessionKey),
            retryAfterSeconds: retryAfterSec ?? null,
            sameRequestMigrationEligible,
            retryCount,
            routeAuthStrategy: route.authStrategy,
            upstreamHeaders: upstream.headers,
            rateLimitStatus: rl.status,
            responseBodyPreview: errorPreview,
            responseContentType:
              typeof upstream.headers['content-type'] === 'string'
                ? upstream.headers['content-type']
                : null,
            statusCode: upstream.statusCode,
            statusText: upstream.statusText,
          })
          return
        }
      }
    } catch (error) {
      this.logHttpFailure(trace, error)
      throw error
    }
  }

  async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const requestUrl = this.buildUpstreamUrlFromRawUrl(req.url)
    const trace = this.createTraceContext(req.method ?? 'GET', req.url, req.headers)

    try {
      const route = this.matchWebSocketRoute(requestUrl.pathname)

      if (!route) {
        this.rejectUpgrade(socket, 404, anthropicErrorBody(404, `Not Found`, RELAY_ERROR_CODES.ROUTE_NOT_FOUND))
        this.logWsRejected(trace, {
          error: 'unsupported_path',
          internalCode: RELAY_ERROR_CODES.ROUTE_NOT_FOUND,
          routeAuthStrategy: null,
          statusCode: 404,
          statusText: STATUS_CODES[404] ?? 'Not Found',
        })
        return
      }

      if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
        this.rejectUpgrade(socket, 405, anthropicErrorBody(405, `Method ${req.method ?? 'UNKNOWN'} is not allowed for ${requestUrl.pathname}`, RELAY_ERROR_CODES.METHOD_NOT_ALLOWED))
        this.logWsRejected(trace, {
          error: 'unsupported_method',
          internalCode: RELAY_ERROR_CODES.METHOD_NOT_ALLOWED,
          routeAuthStrategy: route.authStrategy,
          statusCode: 405,
          statusText: STATUS_CODES[405] ?? 'Method Not Allowed',
        })
        return
      }

      const clientVersion = parseClaudeCliVersion(req.headers['user-agent'])
      if (!clientVersion) {
        this.rejectUpgrade(socket, 400, anthropicErrorBody(400, `Unsupported client. Please use Claude Code ${MIN_CLAUDE_CLI_VERSION.join('.')} or later.`, RELAY_ERROR_CODES.UNSUPPORTED_CLIENT))
        this.logWsRejected(trace, {
          error: `unsupported_client: ${req.headers['user-agent'] ?? '(none)'}`,
          internalCode: RELAY_ERROR_CODES.UNSUPPORTED_CLIENT,
          routeAuthStrategy: route.authStrategy,
          statusCode: 400,
          statusText: STATUS_CODES[400] ?? 'Bad Request',
        })
        return
      }
      if (!isVersionAtLeast(clientVersion, MIN_CLAUDE_CLI_VERSION)) {
        const versionStr = clientVersion.join('.')
        this.rejectUpgrade(socket, 400, anthropicErrorBody(400, `Claude Code version ${versionStr} is not supported. Please use ${MIN_CLAUDE_CLI_VERSION.join('.')} or later.`, RELAY_ERROR_CODES.UNSUPPORTED_CLIENT_VERSION))
        this.logWsRejected(trace, {
          error: `unsupported_client_version: ${versionStr}`,
          internalCode: RELAY_ERROR_CODES.UNSUPPORTED_CLIENT_VERSION,
          routeAuthStrategy: route.authStrategy,
          statusCode: 400,
          statusText: STATUS_CODES[400] ?? 'Bad Request',
        })
        return
      }

      let forceAccountId: string | null = null
      try {
        forceAccountId = this.parseForceAccountIdFromIncoming(
          req.headers,
          requestUrl.searchParams,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.rejectUpgrade(socket, 400, anthropicErrorBody(400, message, RELAY_ERROR_CODES.INVALID_FORCE_ACCOUNT))
        this.logWsRejected(trace, {
          error: message,
          internalCode: RELAY_ERROR_CODES.INVALID_FORCE_ACCOUNT,
          routeAuthStrategy: route.authStrategy,
          statusCode: 400,
          statusText: STATUS_CODES[400] ?? 'Bad Request',
        })
        return
      }

      // ── Relay user resolution (WebSocket) ──
      const relayUser = await this.resolveRelayUser(req.headers)
      if (relayUser.rejected) {
        this.rejectUpgrade(socket, 401, anthropicErrorBody(401, relayUser.rejected, RELAY_ERROR_CODES.RELAY_USER_REJECTED))
        return
      }
      if (relayUser.routingMode === 'pinned_account' && relayUser.userAccountId && !forceAccountId) {
        forceAccountId = relayUser.userAccountId
      }

      const routingGroupId = this.extractAccountGroup(req.headers) ?? (
        relayUser.routingMode === 'preferred_group'
          ? (relayUser.routingGroupId ?? relayUser.preferredGroup)
          : null
      )
      try {
        await this.assertRoutingGroupEnabled(routingGroupId)
      } catch (error) {
        if (error instanceof RoutingGroupAccessError) {
          const clientError = classifyClientFacingRelayError(error)
          const statusCode = clientError?.statusCode ?? 403
          const message = clientError?.message ?? 'Requested routing group is unavailable.'
          const internalCode = clientError?.code ?? RELAY_ERROR_CODES.ROUTING_GROUP_UNAVAILABLE
          this.rejectUpgrade(socket, statusCode, anthropicErrorBody(statusCode, message, internalCode))
          this.logWsRejected(trace, {
            error: error.message,
            forceAccountId,
            internalCode,
            routeAuthStrategy: route.authStrategy,
            statusCode,
            statusText: STATUS_CODES[statusCode] ?? 'Forbidden',
          })
          return
        }
        throw error
      }
      const requestedProvider = await this.resolveRequestedProvider(
        forceAccountId,
        requestUrl.pathname,
        routingGroupId,
      )
      if (requestedProvider === 'openai-codex') {
        this.rejectUpgrade(socket, 501, anthropicErrorBody(
          501,
          'openai-codex does not support Claude WebSocket upstream routes yet.',
          RELAY_ERROR_CODES.PROVIDER_WS_UNSUPPORTED,
        ))
        this.logWsRejected(trace, {
          error: 'openai_codex_ws_not_supported',
          forceAccountId,
          internalCode: RELAY_ERROR_CODES.PROVIDER_WS_UNSUPPORTED,
          routeAuthStrategy: route.authStrategy,
          statusCode: 501,
          statusText: STATUS_CODES[501] ?? 'Not Implemented',
        })
        return
      }
      if (requestedProvider === 'openai-compatible') {
        this.rejectUpgrade(socket, 501, anthropicErrorBody(
          501,
          'openai-compatible does not support Claude WebSocket upstream routes yet.',
          RELAY_ERROR_CODES.PROVIDER_WS_UNSUPPORTED,
        ))
        this.logWsRejected(trace, {
          error: 'openai_compatible_ws_not_supported',
          forceAccountId,
          internalCode: RELAY_ERROR_CODES.PROVIDER_WS_UNSUPPORTED,
          routeAuthStrategy: route.authStrategy,
          statusCode: 501,
          statusText: STATUS_CODES[501] ?? 'Not Implemented',
        })
        return
      }
      if (requestedProvider === 'claude-compatible') {
        this.rejectUpgrade(socket, 501, anthropicErrorBody(
          501,
          'claude-compatible does not support WebSocket upstream routes yet.',
          RELAY_ERROR_CODES.PROVIDER_WS_UNSUPPORTED,
        ))
        this.logWsRejected(trace, {
          error: 'claude_compatible_ws_not_supported',
          forceAccountId,
          internalCode: RELAY_ERROR_CODES.PROVIDER_WS_UNSUPPORTED,
          routeAuthStrategy: route.authStrategy,
          statusCode: 501,
          statusText: STATUS_CODES[501] ?? 'Not Implemented',
        })
        return
      }

      const authMode = this.resolveUpstreamAuthMode(
        route.authStrategy,
        req.headers,
        forceAccountId,
      )
      const sessionKey = this.extractStickySessionKey(req.headers, requestUrl.pathname, route)
      const clientDeviceId = this.resolveClientDeviceId(undefined, req.headers, requestUrl.searchParams)
      const wsUsageContext: WebSocketUsageContext = {
        requestId: trace.requestId,
        requestHeaders: RelayService.sanitizeHeaders(req.headers),
        target: RelayService.normalizeUsageTarget(requestUrl.pathname),
        userId: relayUser.userId,
        relayKeySource: relayUser.relayKeySource,
        sessionKey,
        clientDeviceId,
        startedAt: trace.startedAt,
      }
      let retryCount = 0
      let upstream: ConnectedUpstreamSocket
      try {
        upstream = await this.connectUpstreamWebSocket({
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          enablePerMessageDeflate: Boolean(req.headers['sec-websocket-extensions']),
          forceAccountId,
          routingGroupId,
          clientDeviceId,
          userId: relayUser.userId,
          pathname: requestUrl.pathname,
          route,
          sessionKey,
          upstreamUrl: requestUrl,
          usage: wsUsageContext,
          websocketProtocols: this.parseWebSocketProtocols(
            req.headers['sec-websocket-protocol'],
          ),
        })
        retryCount = upstream.retryCount
      } catch (error) {
        const failure = toUpstreamWebSocketError(error)
        retryCount = failure.retryCount
        this.rejectUpgrade(
          socket,
          failure.statusCode,
          failure.responseBody.length > 0
            ? failure.responseBody
            : anthropicErrorBody(failure.statusCode, failure.message),
          {
            upstreamHeaders: failure.responseHeaders,
            upstreamRawHeaders: failure.responseRawHeaders,
            statusMessage: failure.responseStatusMessage,
          },
        )
        this.logWsRejected(trace, {
          accountId: null,
          authMode,
          forceAccountId,
          hasStickySessionKey: Boolean(sessionKey),
          responseBody: failure.responseBody,
          retryCount,
          routeAuthStrategy: route.authStrategy,
          statusCode: failure.statusCode,
          statusText: failure.responseStatusMessage ?? STATUS_CODES[failure.statusCode] ?? 'Error',
          upstreamHeaders: failure.responseHeaders,
          error: failure.message,
        })
        return
      }

      if (socket.destroyed) {
        upstream.earlyCapture.release()
        this.terminateWebSocket(upstream.ws)
        this.logWsRejected(trace, {
          accountId: upstream.accountId,
          authMode,
          forceAccountId,
          hasStickySessionKey: Boolean(sessionKey),
          retryCount,
          routeAuthStrategy: route.authStrategy,
          statusCode: 499,
          statusText: 'Client Closed Request',
          upstreamHeaders: upstream.upgradeHeaders,
          error: 'client_socket_destroyed_before_upgrade',
        })
        return
      }

      const clientWsServer = this.createClientWebSocketServer(upstream.ws)
      const onHeaders = (headers: string[], request: IncomingMessage) => {
        if (request !== req) {
          return
        }
        this.appendWebSocketUpgradeResponseHeaders(
          headers,
          upstream.upgradeHeaders,
          upstream.upgradeRawHeaders,
        )
        clientWsServer.off('headers', onHeaders)
      }

      clientWsServer.on('headers', onHeaders)

      try {
        clientWsServer.handleUpgrade(req, socket, head, (clientWs) => {
          clientWsServer.off('headers', onHeaders)
          if (upstream.accountId) {
            void this.oauthService.markAccountUsed(upstream.accountId).catch(() => undefined)
            // Auto-bind user to account on first successful WebSocket connection
            if (relayUser.userId && !relayUser.userAccountId && this.userStore) {
              this.userStore.bindAccountIfNeeded(relayUser.userId, upstream.accountId).catch(() => {})
            }
          }
          this.logWsOpened(trace, {
            accountId: upstream.accountId,
            authMode,
            forceAccountId,
            hasStickySessionKey: Boolean(sessionKey),
            retryCount,
            routeAuthStrategy: route.authStrategy,
            upstreamHeaders: upstream.upgradeHeaders,
          })
          this.bridgeWebSockets(clientWs, upstream, {
            onClose: (code, error) => {
              this.logWsClosed(trace, {
                accountId: upstream.accountId,
                authMode,
                closeCode: code,
                error,
                forceAccountId,
                hasStickySessionKey: Boolean(sessionKey),
                retryCount,
                routeAuthStrategy: route.authStrategy,
                upstreamHeaders: upstream.upgradeHeaders,
              })
            },
          })
        })
      } catch (error) {
        clientWsServer.off('headers', onHeaders)
        upstream.earlyCapture.release()
        this.terminateWebSocket(upstream.ws)
        throw error
      }
    } catch (error) {
      const clientError = classifyClientFacingRelayError(error)
      const statusCode = clientError?.statusCode ?? 500
      const internalCode = clientError?.code ?? RELAY_ERROR_CODES.INTERNAL_ERROR
      this.logWsRejected(trace, {
        error: error instanceof Error ? error.message : String(error),
        internalCode,
        routeAuthStrategy: null,
        statusCode,
        statusText: STATUS_CODES[statusCode] ?? 'Internal Server Error',
      })
      const message = clientError?.message ?? 'Internal server error.'
      this.rejectUpgrade(socket, statusCode, anthropicErrorBody(statusCode, message, internalCode))
    }
  }

  private async resolveRequestedProvider(
    forceAccountId: string | null,
    pathname: string,
    routingGroupId: string | null,
  ): Promise<AccountProvider> {
    const parsed = forceAccountId
      ? parseProviderScopedAccountRef(forceAccountId)
      : null
    if (parsed?.provider) {
      return parsed.provider
    }

    if (this.isOpenAICodexResponsesPath(pathname)) {
      return OPENAI_CODEX_PROVIDER.id
    }
    if (this.isOpenAICompatibleChatCompletionsPath(pathname)) {
      return 'openai-compatible'
    }

    const accounts = await this.oauthService.listAccounts()
    const visibleAccounts = routingGroupId
      ? accounts.filter((account) => (account.routingGroupId ?? account.group) === routingGroupId)
      : accounts.filter((account) => !(account.routingGroupId ?? account.group))
    const hasClaudeOfficial = visibleAccounts.some(
      (account) => account.provider === CLAUDE_OFFICIAL_PROVIDER.id,
    )
    if (!hasClaudeOfficial && visibleAccounts.some(isOpenAICodexAccount)) {
      return OPENAI_CODEX_PROVIDER.id
    }
    if (!hasClaudeOfficial && visibleAccounts.some(isOpenAICompatibleAccount)) {
      return 'openai-compatible'
    }
    if (!hasClaudeOfficial && visibleAccounts.some(isClaudeCompatibleAccount)) {
      return CLAUDE_COMPATIBLE_PROVIDER.id
    }

    return CLAUDE_OFFICIAL_PROVIDER.id
  }

  private async assertRoutingGroupEnabled(routingGroupId: string | null): Promise<void> {
    if (!routingGroupId) {
      return
    }
    const routingGroup = await this.oauthService.getRoutingGroup(routingGroupId)
    if (routingGroup && !routingGroup.isActive) {
      throw new RoutingGroupAccessError(routingGroupId)
    }
  }

  private supportsOpenAICodexHttpPath(pathname: string): boolean {
    return pathname === '/v1/responses' || pathname.startsWith('/v1/responses/')
  }

  private requiresClaudeCliVersionCheck(pathname: string): boolean {
    return !(
      pathname === '/v1/responses' ||
      pathname.startsWith('/v1/responses/') ||
      this.isOpenAICompatibleChatCompletionsPath(pathname)
    )
  }

  private isOpenAICompatibleChatCompletionsPath(pathname: string): boolean {
    return pathname === '/v1/chat/completions'
  }

  private async handleOpenAICodexHttp(input: {
    req: Request
    res: Response
    trace: HttpTraceContext
    route: HttpRoute
    requestBody: RelayRequestBody
    rawRequestBody: Buffer | undefined
    forceAccountId: string | null
    explicitForceAccountId: string | null
    sessionKey: string | null
    routingGroupId: string | null
    relayUser: ResolvedRelayUserContext
    clientDeviceId: string | null
  }): Promise<void> {
    if (!this.supportsOpenAICodexHttpPath(input.req.path)) {
      input.res.status(501).json(localHttpErrorBody(
        input.req.path,
        501,
        'openai-codex currently only supports /v1/responses.',
        RELAY_ERROR_CODES.PROVIDER_ROUTE_UNSUPPORTED,
      ))
      this.logHttpRejection(input.trace, {
        error: 'openai_codex_path_not_supported',
        forceAccountId: input.forceAccountId,
        internalCode: RELAY_ERROR_CODES.PROVIDER_ROUTE_UNSUPPORTED,
        routeAuthStrategy: input.route.authStrategy,
        statusCode: 501,
        statusText: STATUS_CODES[501] ?? 'Not Implemented',
      })
      return
    }

    let resolved: ResolvedAccount
    try {
      resolved = await this.oauthService.selectAccount({
        provider: OPENAI_CODEX_PROVIDER.id,
        sessionKey: this.isOpenAICodexResponsesPath(input.req.path) ? input.sessionKey : null,
        forceAccountId: input.forceAccountId,
        routingGroupId: input.routingGroupId,
        userId: input.relayUser.userId,
        clientDeviceId: input.clientDeviceId,
        currentRequestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
      })
    } catch (error) {
      if (error instanceof SchedulerCapacityError) {
        input.res.status(529).json(anthropicErrorBody(529, 'Service is at capacity. Please try again later.', RELAY_ERROR_CODES.SCHEDULER_CAPACITY))
        this.logHttpRejection(input.trace, {
          error: formatSchedulerCapacityError(error),
          forceAccountId: input.forceAccountId,
          internalCode: RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: 529,
          statusText: 'Overloaded',
        })
        return
      }
      if (error instanceof RoutingGuardError) {
        input.res.status(429).json(anthropicErrorBody(429, error.message, RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT))
        this.logHttpRejection(input.trace, {
          error: `routing_guard:${error.code}: current=${error.current} limit=${error.limit}`,
          forceAccountId: input.forceAccountId,
          internalCode: RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: 429,
          statusText: STATUS_CODES[429] ?? 'Too Many Requests',
        })
        return
      }
      const clientError = classifyClientFacingRelayError(error)
      if (clientError) {
        input.res.status(clientError.statusCode).json(
          anthropicErrorBody(clientError.statusCode, clientError.message, clientError.code),
        )
        this.logHttpRejection(input.trace, {
          error: error instanceof Error ? error.message : String(error),
          forceAccountId: input.forceAccountId,
          internalCode: clientError.code,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: clientError.statusCode,
          statusText: STATUS_CODES[clientError.statusCode] ?? 'Error',
        })
        return
      }
      throw error
    }

    await this.handleOpenAICodexResponsesHttp(input, resolved)
  }

  private isOpenAICodexResponsesPath(pathname: string): boolean {
    return pathname === '/v1/responses' || pathname.startsWith('/v1/responses/')
  }

  private buildOpenAICodexResponsesProxyUrl(
    account: StoredAccount,
    originalUrl: string,
  ): URL {
    const incomingUrl = this.buildUpstreamUrlFromRawUrl(originalUrl)
    const suffix = incomingUrl.pathname.replace(/^\/v1\/responses/, '')
    const upstreamUrl = buildOpenAICodexResponsesUrl(account)
    upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/, '')}${suffix}`
    upstreamUrl.search = incomingUrl.search
    return upstreamUrl
  }

  private async handleOpenAICodexResponsesHttp(
    input: {
      req: Request
      res: Response
      trace: HttpTraceContext
      route: HttpRoute
      requestBody: RelayRequestBody
      rawRequestBody: Buffer | undefined
      forceAccountId: string | null
      explicitForceAccountId: string | null
      sessionKey: string | null
      routingGroupId: string | null
      relayUser: ResolvedRelayUserContext
      clientDeviceId: string | null
    },
    resolved: ResolvedAccount,
  ): Promise<void> {
    if (!isOpenAICodexAccount(resolved.account)) {
      throw new Error(`Account ${resolved.account.id} is not openai-codex`)
    }
    if (!resolved.account.organizationUuid) {
      throw new Error(`Account ${resolved.account.id} is missing chatgpt workspace id`)
    }

    let currentResolved = resolved
    let retryCount = 0
    const codexDisallowed: string[] = []
    const canReplayRequestBody = this.canReplayRequestBody(input.requestBody)

    while (true) {
      const routedRequest = this.rewriteOpenAICodexHandoffBody(
        input.requestBody,
        currentResolved.handoffSummary,
      )
      if (await this.rejectIfMissingBillingRule({
        res: input.res,
        trace: input.trace,
        routeAuthStrategy: input.route.authStrategy,
        forceAccountId: input.forceAccountId,
        relayUser: input.relayUser,
        method: input.req.method,
        path: input.req.path,
        target: input.trace.target,
        accountId: currentResolved.account.id,
        provider: OPENAI_CODEX_PROVIDER.id,
        body: routedRequest.body,
      })) {
        return
      }
      const upstreamUrl = this.buildOpenAICodexResponsesProxyUrl(
        currentResolved.account,
        input.req.originalUrl,
      )
      const originator =
        this.normalizeHeaderValue(input.req.headers.originator) ?? 'codex_cli_rs'
      const upstreamRequestHeaders: Record<string, string> = {
        authorization: `Bearer ${currentResolved.account.accessToken}`,
        'chatgpt-account-id': currentResolved.account.organizationUuid ?? '',
        accept: this.normalizeHeaderValue(input.req.headers.accept) ?? 'text/event-stream',
        'content-type':
          this.normalizeHeaderValue(input.req.headers['content-type']) ?? 'application/json',
        'openai-beta': 'responses=experimental',
        originator,
        'x-request-id': input.trace.requestId,
      }
      for (const headerName of [
        'user-agent',
        'x-client-request-id',
        'x-codex-turn-metadata',
        'x-codex-window-id',
        'session_id',
      ] as const) {
        const value = this.normalizeHeaderValue(input.req.headers[headerName])
        if (value) {
          upstreamRequestHeaders[headerName] = value
        }
      }

      const upstream = await request(upstreamUrl, {
        method: input.req.method,
        dispatcher: this.getOptionalHttpDispatcher(currentResolved.proxyUrl),
        headers: upstreamRequestHeaders,
        body: routedRequest.body,
        headersTimeout: appConfig.upstreamRequestTimeoutMs,
        bodyTimeout: appConfig.upstreamRequestTimeoutMs,
        responseHeaders: 'raw',
      })

      const upstreamRawHeaders = Array.isArray(upstream.headers)
        ? upstream.headers
        : undefined
      const upstreamHeaders = upstreamRawHeaders
        ? collapseIncomingHeaders(upstreamRawHeaders)
        : upstream.headers
      const openAIRateLimitHeaders = parseOpenAIRateLimitHeaders(upstreamHeaders)
      let responseBody: ForwardedHttpResponse['body'] = upstream.body
      let bufferedFailureBody: Buffer | null = null
      let bufferedFailureText: string | null = null
      const retryAfterSec = this.parseRetryAfterSeconds(upstreamHeaders)
      this.healthTracker.recordResponse(
        currentResolved.account.id,
        upstream.statusCode,
        retryAfterSec,
      )
      if (upstream.statusCode === 429) {
        this.scheduleAccountCooldown(
          currentResolved.account.id,
          this.computeRateLimitCooldownMs(retryAfterSec, null),
          input.trace,
          input.req.method,
          input.trace.target,
        )
      }

      if (
        canReplayRequestBody &&
        (
          this.isAuthenticationFailure(upstream.statusCode) ||
          upstream.statusCode === 429
        )
      ) {
        bufferedFailureBody = await this.readBodyBuffer(
          upstream.body,
          appConfig.nonStreamResponseCaptureMaxBytes,
        )
        bufferedFailureText = bufferedFailureBody.toString('utf8')
        responseBody = Readable.from([bufferedFailureBody]) as ForwardedHttpResponse['body']
      }

      if (canReplayRequestBody && this.isAuthenticationFailure(upstream.statusCode)) {
        if (this.shouldRetryWithFreshToken(
          upstream.statusCode,
          bufferedFailureText ?? '',
          currentResolved.account.accessToken,
        )) {
        try {
          const recovery = await this.oauthService.recoverAccountAfterAuthFailure({
            failedAccountId: currentResolved.account.id,
            failedAccessToken: currentResolved.account.accessToken,
            sessionKey: input.sessionKey,
            forceAccountId: input.forceAccountId,
            routingGroupId: input.routingGroupId,
          })
          currentResolved = recovery.resolved
          retryCount += 1
          continue
        } catch {
          // fall through and return original upstream error body
        }
        }
      }

      const openAIRateLimitStatus = deriveOpenAIRateLimitStatus({
        httpStatus: upstream.statusCode,
        requestUtilization: openAIRateLimitHeaders.requestUtilization,
        tokenUtilization: openAIRateLimitHeaders.tokenUtilization,
        fiveHourUtilization: currentResolved.account.lastRateLimit5hUtilization,
        sevenDayUtilization: currentResolved.account.lastRateLimit7dUtilization,
      })
      const accountMigrationReason = this.getOpenAICodexAccountMigrationReason({
        statusCode: upstream.statusCode,
        rateLimitStatus: openAIRateLimitStatus,
        responseText: bufferedFailureText,
      })
      const effectiveOpenAIRateLimitStatus = openAIRateLimitStatus ?? (
        accountMigrationReason ? 'rejected' : null
      )
      if (
        effectiveOpenAIRateLimitStatus ||
        currentResolved.account.lastRateLimit5hUtilization != null ||
        currentResolved.account.lastRateLimit7dUtilization != null
      ) {
        await this.oauthService.recordRateLimitSnapshot({
          accountId: currentResolved.account.id,
          status: effectiveOpenAIRateLimitStatus,
          fiveHourUtilization: currentResolved.account.lastRateLimit5hUtilization,
          sevenDayUtilization: currentResolved.account.lastRateLimit7dUtilization,
          resetTimestamp: resolveOpenAIRateLimitResetTimestamp(
            openAIRateLimitHeaders,
            currentResolved.account.lastRateLimitReset,
          ),
          observedAt: Date.now(),
        })
      }

      if (
        accountMigrationReason &&
        canReplayRequestBody &&
        retryCount < appConfig.sameRequestMaxRetries &&
        !input.explicitForceAccountId
      ) {
        const retryFailureBody = bufferedFailureBody ?? await this.readBodyBuffer(
          upstream.body,
          appConfig.nonStreamResponseCaptureMaxBytes,
        )
        this.recordImmediateFailureUsage({
          requestId: input.trace.requestId,
          accountId: currentResolved.account.id,
          userId: input.relayUser.userId,
          relayKeySource: input.relayUser.relayKeySource,
          sessionKey: input.sessionKey,
          clientDeviceId: input.clientDeviceId,
          durationMs: Date.now() - input.trace.startedAt,
          target: input.trace.target,
          statusCode: upstream.statusCode,
          rateLimitStatus: effectiveOpenAIRateLimitStatus,
          rateLimit5hUtilization: currentResolved.account.lastRateLimit5hUtilization,
          rateLimit7dUtilization: currentResolved.account.lastRateLimit7dUtilization,
          rateLimitReset: resolveOpenAIRateLimitResetTimestamp(
            openAIRateLimitHeaders,
            currentResolved.account.lastRateLimitReset,
          ),
          requestHeaders: RelayService.sanitizeHeaders(input.req.headers),
          requestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
          responseHeaders: RelayService.sanitizeHeaders(upstreamHeaders),
          responseBodyPreview: RelayService.truncateBody(retryFailureBody),
          upstreamRequestHeaders,
        })
        try {
          codexDisallowed.push(currentResolved.account.id)
          const backoffMs = Math.random() * (appConfig.sameRequestRetryBackoffMaxMs - appConfig.sameRequestRetryBackoffMinMs) + appConfig.sameRequestRetryBackoffMinMs
          this.safeLog({
            event: 'retry_attempt',
            requestId: input.trace.requestId,
            method: input.trace.method,
            target: input.trace.target,
            durationMs: Date.now() - input.trace.startedAt,
            retryAttempt: retryCount + 1,
            retryDelayMs: Math.round(backoffMs),
            retryDisallowedCount: codexDisallowed.length,
            retryMigrationReason: accountMigrationReason,
          })
          await this.sleepMs(backoffMs)
          currentResolved = await this.oauthService.selectAccount({
            provider: OPENAI_CODEX_PROVIDER.id,
            sessionKey: input.sessionKey,
            forceAccountId: null,
            routingGroupId: input.routingGroupId,
            userId: input.relayUser.userId,
            clientDeviceId: input.clientDeviceId,
            disallowedAccountIds: [...codexDisallowed],
            handoffReason: accountMigrationReason,
            currentRequestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
          })
          retryCount += 1
          continue
        } catch {
          responseBody = Readable.from([retryFailureBody]) as ForwardedHttpResponse['body']
        }
      }

      this.writeResponseHead(
        input.res,
        upstream.statusCode,
        upstream.statusText,
        upstreamHeaders,
        upstreamRawHeaders,
      )
      const observation = await this.pipelineWithUsageTracking(
        {
          statusCode: upstream.statusCode,
          statusText: upstream.statusText,
          headers: upstreamHeaders,
          rawHeaders: upstreamRawHeaders,
          body: responseBody,
          upstreamRequestHeaders: undefined,
        },
        input.res,
        {
          requestId: input.trace.requestId,
          accountId: currentResolved.account.id,
          userId: input.relayUser.userId,
          relayKeySource: input.relayUser.relayKeySource,
          sessionKey: input.sessionKey,
          clientDeviceId: input.clientDeviceId,
          durationMs: Date.now() - input.trace.startedAt,
          target: input.trace.target,
          path: input.req.path,
          method: input.req.method,
          requestHeaders: RelayService.sanitizeHeaders(input.req.headers),
          requestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
          upstreamRequestHeaders,
        },
      )

      if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
        await this.oauthService.markAccountUsed(currentResolved.account.id)
        if (input.relayUser.userId && !input.relayUser.userAccountId && this.userStore) {
          void this.userStore.bindAccountIfNeeded(
            input.relayUser.userId,
            currentResolved.account.id,
          ).catch(() => {})
        }
        if (input.sessionKey && this.userStore) {
          await this.userStore.noteSessionRouteUsage({
            sessionKey: input.sessionKey,
            userId: input.relayUser.userId,
            clientDeviceId: input.clientDeviceId,
            accountId: currentResolved.account.id,
            rateLimitStatus: openAIRateLimitStatus,
            rateLimit5hUtilization: currentResolved.account.lastRateLimit5hUtilization,
            rateLimit7dUtilization: currentResolved.account.lastRateLimit7dUtilization,
          })
          if (routedRequest.handoffInjected) {
            await this.userStore.clearPendingHandoffSummary(input.sessionKey)
          }
        }
      }

      this.logHttpCompleted(input.trace, {
        accountId: currentResolved.account.id,
        authMode: 'oauth',
        forceAccountId: input.forceAccountId,
        hasStickySessionKey: Boolean(input.sessionKey),
        retryCount,
        routeAuthStrategy: input.route.authStrategy,
        upstreamHeaders,
        rateLimitStatus: observation.rateLimitStatus,
        responseBodyPreview: observation.responseBodyPreview,
        responseContentType: observation.responseContentType,
        statusCode: upstream.statusCode,
        statusText: upstream.statusText,
      })
      return
    }
  }

  private supportsOpenAICompatibleHttpPath(pathname: string): boolean {
    return this.isOpenAICompatibleChatCompletionsPath(pathname)
  }

  private async handleOpenAICompatibleHttp(input: {
    req: Request
    res: Response
    trace: HttpTraceContext
    route: HttpRoute
    requestBody: RelayRequestBody
    rawRequestBody: Buffer | undefined
    forceAccountId: string | null
    sessionKey: string | null
    routingGroupId: string | null
    relayUser: ResolvedRelayUserContext
    clientDeviceId: string | null
  }): Promise<void> {
    if (!this.supportsOpenAICompatibleHttpPath(input.req.path)) {
      input.res.status(501).json(anthropicErrorBody(
        501,
        'openai-compatible currently only supports /v1/chat/completions.',
        RELAY_ERROR_CODES.PROVIDER_ROUTE_UNSUPPORTED,
      ))
      this.logHttpRejection(input.trace, {
        error: 'openai_compatible_path_not_supported',
        forceAccountId: input.forceAccountId,
        internalCode: RELAY_ERROR_CODES.PROVIDER_ROUTE_UNSUPPORTED,
        routeAuthStrategy: input.route.authStrategy,
        statusCode: 501,
        statusText: STATUS_CODES[501] ?? 'Not Implemented',
      })
      return
    }

    let resolved: ResolvedAccount
    try {
      resolved = await this.oauthService.selectAccount({
        provider: 'openai-compatible',
        sessionKey: null,
        forceAccountId: input.forceAccountId,
        routingGroupId: input.routingGroupId,
        userId: input.relayUser.userId,
        clientDeviceId: input.clientDeviceId,
        currentRequestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
      })
    } catch (error) {
      if (error instanceof SchedulerCapacityError) {
        input.res.status(529).json(
          localHttpErrorBody(
            input.req.path,
            529,
            'Service is at capacity. Please try again later.',
            RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
          ),
        )
        this.logHttpRejection(input.trace, {
          error: formatSchedulerCapacityError(error),
          forceAccountId: input.forceAccountId,
          internalCode: RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: 529,
          statusText: 'Overloaded',
        })
        return
      }
      if (error instanceof RoutingGuardError) {
        input.res.status(429).json(
          localHttpErrorBody(
            input.req.path,
            429,
            error.message,
            RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT,
          ),
        )
        this.logHttpRejection(input.trace, {
          error: `routing_guard:${error.code}: current=${error.current} limit=${error.limit}`,
          forceAccountId: input.forceAccountId,
          internalCode: RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: 429,
          statusText: STATUS_CODES[429] ?? 'Too Many Requests',
        })
        return
      }
      const clientError = classifyClientFacingRelayError(error)
      if (clientError) {
        input.res.status(clientError.statusCode).json(
          localHttpErrorBody(
            input.req.path,
            clientError.statusCode,
            clientError.message,
            clientError.code,
          ),
        )
        this.logHttpRejection(input.trace, {
          error: error instanceof Error ? error.message : String(error),
          forceAccountId: input.forceAccountId,
          internalCode: clientError.code,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: clientError.statusCode,
          statusText: STATUS_CODES[clientError.statusCode] ?? 'Error',
        })
        return
      }
      throw error
    }

    if (!isOpenAICompatibleAccount(resolved.account)) {
      throw new Error(`Account ${resolved.account.id} is not openai-compatible`)
    }
    const upstreamUrl = this.buildOpenAICompatibleProxyUrl(
      resolved.account,
      input.req.originalUrl,
    )
    const upstreamRequestHeaders: Record<string, string> = {
      authorization: `Bearer ${resolved.account.accessToken}`,
      'content-type':
        this.normalizeHeaderValue(input.req.headers['content-type']) ?? 'application/json',
      accept: this.normalizeHeaderValue(input.req.headers.accept) ?? 'application/json',
      'x-request-id': input.trace.requestId,
    }
    for (const headerName of [
      'user-agent',
      'openai-organization',
      'openai-project',
      'openai-beta',
    ] as const) {
      const value = this.normalizeHeaderValue(input.req.headers[headerName])
      if (value) {
        upstreamRequestHeaders[headerName] = value
      }
    }

    if (await this.rejectIfMissingBillingRule({
      res: input.res,
      trace: input.trace,
      routeAuthStrategy: input.route.authStrategy,
      forceAccountId: input.forceAccountId,
      relayUser: input.relayUser,
      method: input.req.method,
      path: input.req.path,
      target: input.trace.target,
      accountId: resolved.account.id,
      provider: 'openai-compatible',
      body: input.requestBody,
    })) {
      return
    }

    const upstream = await request(upstreamUrl, {
      method: input.req.method,
      dispatcher: this.getOptionalHttpDispatcher(resolved.proxyUrl),
      headers: upstreamRequestHeaders,
      body: input.requestBody,
      headersTimeout: appConfig.upstreamRequestTimeoutMs,
      bodyTimeout: appConfig.upstreamRequestTimeoutMs,
      responseHeaders: 'raw',
    })

    const upstreamRawHeaders = Array.isArray(upstream.headers)
      ? upstream.headers
      : undefined
    const upstreamHeaders = upstreamRawHeaders
      ? collapseIncomingHeaders(upstreamRawHeaders)
      : upstream.headers
    const retryAfterSec3 = this.parseRetryAfterSeconds(upstreamHeaders)
    this.healthTracker.recordResponse(
      resolved.account.id,
      upstream.statusCode,
      retryAfterSec3,
    )
    if (upstream.statusCode === 429) {
      this.scheduleAccountCooldown(
        resolved.account.id,
        this.computeRateLimitCooldownMs(retryAfterSec3, null),
        input.trace,
        input.req.method,
        input.trace.target,
      )
    }

    this.writeResponseHead(
      input.res,
      upstream.statusCode,
      upstream.statusText,
      upstreamHeaders,
      upstreamRawHeaders,
    )
    const observation = await this.pipelineWithUsageTracking(
      {
        statusCode: upstream.statusCode,
        statusText: upstream.statusText,
        headers: upstreamHeaders,
        rawHeaders: upstreamRawHeaders,
        body: upstream.body,
        upstreamRequestHeaders: undefined,
      },
      input.res,
      {
        requestId: input.trace.requestId,
        accountId: resolved.account.id,
        userId: input.relayUser.userId,
        relayKeySource: input.relayUser.relayKeySource,
        sessionKey: null,
        clientDeviceId: input.clientDeviceId,
        durationMs: Date.now() - input.trace.startedAt,
        target: input.trace.target,
        path: input.req.path,
        method: input.req.method,
        requestHeaders: RelayService.sanitizeHeaders(input.req.headers),
        requestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
        upstreamRequestHeaders,
      },
    )

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      await this.oauthService.markAccountUsed(resolved.account.id)
      if (input.relayUser.userId && !input.relayUser.userAccountId && this.userStore) {
        void this.userStore.bindAccountIfNeeded(
          input.relayUser.userId,
          resolved.account.id,
        ).catch(() => {})
      }
    }

    this.logHttpCompleted(input.trace, {
      accountId: resolved.account.id,
      authMode: 'api_key',
      forceAccountId: input.forceAccountId,
      hasStickySessionKey: false,
      retryCount: 0,
      routeAuthStrategy: input.route.authStrategy,
      upstreamHeaders,
      rateLimitStatus: observation.rateLimitStatus,
      responseBodyPreview: observation.responseBodyPreview,
      responseContentType: observation.responseContentType,
      statusCode: upstream.statusCode,
      statusText: upstream.statusText,
    })
  }

  private buildOpenAICompatibleProxyUrl(
    account: StoredAccount,
    originalUrl: string,
  ): URL {
    const incomingUrl = this.buildUpstreamUrlFromRawUrl(originalUrl)
    const upstreamUrl = buildOpenAICompatibleChatCompletionsUrl(account)
    upstreamUrl.search = incomingUrl.search
    return upstreamUrl
  }

  private supportsClaudeCompatibleHttpPath(pathname: string): boolean {
    return (
      pathname === '/v1/messages' ||
      pathname === '/v1/messages/count_tokens'
    )
  }

  private async handleClaudeCompatibleHttp(input: {
    req: Request
    res: Response
    trace: HttpTraceContext
    route: HttpRoute
    requestBody: RelayRequestBody
    rawRequestBody: Buffer | undefined
    forceAccountId: string | null
    sessionKey: string | null
    routingGroupId: string | null
    relayUser: ResolvedRelayUserContext
    clientDeviceId: string | null
  }): Promise<void> {
    if (!this.supportsClaudeCompatibleHttpPath(input.req.path)) {
      input.res.status(501).json(localHttpErrorBody(
        input.req.path,
        501,
        'claude-compatible currently only supports /v1/messages and /v1/messages/count_tokens.',
        RELAY_ERROR_CODES.PROVIDER_ROUTE_UNSUPPORTED,
      ))
      this.logHttpRejection(input.trace, {
        error: 'claude_compatible_path_not_supported',
        forceAccountId: input.forceAccountId,
        internalCode: RELAY_ERROR_CODES.PROVIDER_ROUTE_UNSUPPORTED,
        routeAuthStrategy: input.route.authStrategy,
        statusCode: 501,
        statusText: STATUS_CODES[501] ?? 'Not Implemented',
      })
      return
    }

    let resolved: ResolvedAccount
    try {
      resolved = await this.oauthService.selectAccount({
        provider: CLAUDE_COMPATIBLE_PROVIDER.id,
        sessionKey: null,
        forceAccountId: input.forceAccountId,
        routingGroupId: input.routingGroupId,
        userId: input.relayUser.userId,
        clientDeviceId: input.clientDeviceId,
        currentRequestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
      })
    } catch (error) {
      if (error instanceof SchedulerCapacityError) {
        input.res.status(529).json(anthropicErrorBody(529, 'Service is at capacity. Please try again later.', RELAY_ERROR_CODES.SCHEDULER_CAPACITY))
        this.logHttpRejection(input.trace, {
          error: formatSchedulerCapacityError(error),
          forceAccountId: input.forceAccountId,
          internalCode: RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: 529,
          statusText: 'Overloaded',
        })
        return
      }
      if (error instanceof RoutingGuardError) {
        input.res.status(429).json(anthropicErrorBody(429, error.message, RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT))
        this.logHttpRejection(input.trace, {
          error: `routing_guard:${error.code}: current=${error.current} limit=${error.limit}`,
          forceAccountId: input.forceAccountId,
          internalCode: RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: 429,
          statusText: STATUS_CODES[429] ?? 'Too Many Requests',
        })
        return
      }
      const clientError = classifyClientFacingRelayError(error)
      if (clientError) {
        input.res.status(clientError.statusCode).json(
          anthropicErrorBody(clientError.statusCode, clientError.message, clientError.code),
        )
        this.logHttpRejection(input.trace, {
          error: error instanceof Error ? error.message : String(error),
          forceAccountId: input.forceAccountId,
          internalCode: clientError.code,
          routeAuthStrategy: input.route.authStrategy,
          statusCode: clientError.statusCode,
          statusText: STATUS_CODES[clientError.statusCode] ?? 'Error',
        })
        return
      }
      throw error
    }

    let currentResolved = resolved
    let retryCount = 0
    const compatDisallowed: string[] = []

    while (true) {
      if (!isClaudeCompatibleAccount(currentResolved.account)) {
        throw new Error(`Account ${currentResolved.account.id} is not claude-compatible`)
      }

      let rewrittenBody: Buffer
      try {
        const rewriteResult = rewriteClaudeCompatibleRequestBody(
          input.rawRequestBody,
          currentResolved.account,
        )
        rewrittenBody = rewriteResult.body
        this.safeLog({
          event: 'claude_compatible_model_routed',
          requestId: input.trace.requestId,
          method: input.trace.method,
          target: input.trace.target,
          accountId: currentResolved.account.id,
          durationMs: Date.now() - input.trace.startedAt,
          sourceModel: rewriteResult.routing.sourceModel,
          targetModel: rewriteResult.routing.targetModel,
          tierHit: rewriteResult.routing.tierHit,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const clientError = classifyClientFacingRelayError(error)
        const statusCode = clientError?.statusCode ?? 400
        const internalCode = clientError?.code ?? RELAY_ERROR_CODES.UPSTREAM_CONFIG_UNAVAILABLE
        input.res.status(statusCode).json(
          anthropicErrorBody(statusCode, clientError?.message ?? message, internalCode),
        )
        this.logHttpRejection(input.trace, {
          error: message,
          forceAccountId: input.forceAccountId,
          internalCode,
          routeAuthStrategy: input.route.authStrategy,
          statusCode,
          statusText: STATUS_CODES[statusCode] ?? 'Error',
        })
        return
      }

      const incomingUrl = this.buildUpstreamUrlFromRawUrl(input.req.originalUrl)
      const upstreamUrl = buildClaudeCompatibleUpstreamUrl(
        currentResolved.account,
        input.req.path,
        incomingUrl.search,
      )
      const upstreamRequestHeaders: Record<string, string> = {
        'x-api-key': currentResolved.account.accessToken,
        'content-type':
          this.normalizeHeaderValue(input.req.headers['content-type']) ?? 'application/json',
        accept: this.normalizeHeaderValue(input.req.headers.accept) ?? 'application/json',
        'x-request-id': input.trace.requestId,
      }
      for (const headerName of [
        'user-agent',
        'anthropic-version',
        'anthropic-beta',
      ] as const) {
        const value = this.normalizeHeaderValue(input.req.headers[headerName])
        if (value) {
          upstreamRequestHeaders[headerName] = value
        }
      }

      if (await this.rejectIfMissingBillingRule({
        res: input.res,
        trace: input.trace,
        routeAuthStrategy: input.route.authStrategy,
        forceAccountId: input.forceAccountId,
        relayUser: input.relayUser,
        method: input.req.method,
        path: input.req.path,
        target: input.trace.target,
        accountId: currentResolved.account.id,
        provider: CLAUDE_COMPATIBLE_PROVIDER.id,
        body: rewrittenBody,
      })) {
        return
      }

      const upstream = await request(upstreamUrl, {
        method: input.req.method,
        dispatcher: this.getOptionalHttpDispatcher(currentResolved.proxyUrl),
        headers: upstreamRequestHeaders,
        body: rewrittenBody,
        headersTimeout: appConfig.upstreamRequestTimeoutMs,
        bodyTimeout: appConfig.upstreamRequestTimeoutMs,
        responseHeaders: 'raw',
      })

      const upstreamRawHeaders = Array.isArray(upstream.headers)
        ? upstream.headers
        : undefined
      const upstreamHeaders = upstreamRawHeaders
        ? collapseIncomingHeaders(upstreamRawHeaders)
        : upstream.headers
      const retryAfterSec = this.parseRetryAfterSeconds(upstreamHeaders)
      this.healthTracker.recordResponse(
        currentResolved.account.id,
        upstream.statusCode,
        retryAfterSec,
      )
      if (upstream.statusCode === 429) {
        this.scheduleAccountCooldown(
          currentResolved.account.id,
          this.computeRateLimitCooldownMs(retryAfterSec, null),
          input.trace,
          input.req.method,
          input.trace.target,
        )
      }

      let responseBody: ForwardedHttpResponse['body'] = upstream.body
      let bufferedFailureBody: Buffer | null = null
      let bufferedFailureText: string | null = null
      if (
        upstream.statusCode === 400 ||
        this.isAuthenticationFailure(upstream.statusCode)
      ) {
        bufferedFailureBody = await this.readBodyBuffer(
          upstream.body,
          appConfig.nonStreamResponseCaptureMaxBytes,
        )
        bufferedFailureText = bufferedFailureBody.toString('utf8')
        responseBody = Readable.from([bufferedFailureBody]) as ForwardedHttpResponse['body']
      }

      const terminalAccountFailureReason =
        bufferedFailureText
          ? this.classifyTerminalAccountFailureReason(
              upstream.statusCode,
              bufferedFailureText,
            )
          : null
      if (terminalAccountFailureReason) {
        await this.oauthService.markAccountTerminalFailure(
          currentResolved.account.id,
          terminalAccountFailureReason,
        )
      }

      if (
        terminalAccountFailureReason &&
        retryCount < appConfig.sameRequestMaxRetries &&
        !input.forceAccountId &&
        (
          input.req.path === '/v1/messages' ||
          input.req.path === '/v1/messages/count_tokens'
        )
      ) {
        const retryFailureBody = bufferedFailureBody ?? Buffer.alloc(0)
        this.recordImmediateFailureUsage({
          requestId: input.trace.requestId,
          accountId: currentResolved.account.id,
          userId: input.relayUser.userId,
          relayKeySource: input.relayUser.relayKeySource,
          sessionKey: null,
          clientDeviceId: input.clientDeviceId,
          durationMs: Date.now() - input.trace.startedAt,
          target: input.trace.target,
          statusCode: upstream.statusCode,
          rateLimitStatus: null,
          rateLimit5hUtilization: currentResolved.account.lastRateLimit5hUtilization,
          rateLimit7dUtilization: currentResolved.account.lastRateLimit7dUtilization,
          rateLimitReset: currentResolved.account.lastRateLimitReset,
          requestHeaders: RelayService.sanitizeHeaders(input.req.headers),
          requestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
          responseHeaders: RelayService.sanitizeHeaders(upstreamHeaders),
          responseBodyPreview: RelayService.truncateBody(retryFailureBody),
          upstreamRequestHeaders,
        })
        try {
          compatDisallowed.push(currentResolved.account.id)
          const backoffMs = Math.random() * (appConfig.sameRequestRetryBackoffMaxMs - appConfig.sameRequestRetryBackoffMinMs) + appConfig.sameRequestRetryBackoffMinMs
          this.safeLog({
            event: 'retry_attempt',
            requestId: input.trace.requestId,
            method: input.trace.method,
            target: input.trace.target,
            durationMs: Date.now() - input.trace.startedAt,
            retryAttempt: retryCount + 1,
            retryDelayMs: Math.round(backoffMs),
            retryDisallowedCount: compatDisallowed.length,
            retryMigrationReason: terminalAccountFailureReason,
          })
          await this.sleepMs(backoffMs)
          currentResolved = await this.oauthService.selectAccount({
            provider: CLAUDE_COMPATIBLE_PROVIDER.id,
            sessionKey: null,
            forceAccountId: null,
            routingGroupId: input.routingGroupId,
            userId: input.relayUser.userId,
            clientDeviceId: input.clientDeviceId,
            disallowedAccountIds: [...compatDisallowed],
            handoffReason: terminalAccountFailureReason,
            currentRequestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
          })
          retryCount += 1
          continue
        } catch (error) {
          const clientError = classifyClientFacingRelayError(error)
          if (clientError) {
            input.res.status(clientError.statusCode).json(
              anthropicErrorBody(clientError.statusCode, clientError.message, clientError.code),
            )
            this.logHttpRejection(input.trace, {
              error: error instanceof Error ? error.message : String(error),
              forceAccountId: input.forceAccountId,
              internalCode: clientError.code,
              routeAuthStrategy: input.route.authStrategy,
              statusCode: clientError.statusCode,
              statusText: STATUS_CODES[clientError.statusCode] ?? 'Error',
            })
            return
          }
          responseBody = Readable.from([retryFailureBody]) as ForwardedHttpResponse['body']
        }
      }

      this.writeResponseHead(
        input.res,
        upstream.statusCode,
        upstream.statusText,
        upstreamHeaders,
        upstreamRawHeaders,
      )
      const observation = await this.pipelineWithUsageTracking(
        {
          statusCode: upstream.statusCode,
          statusText: upstream.statusText,
          headers: upstreamHeaders,
          rawHeaders: upstreamRawHeaders,
          body: responseBody,
          upstreamRequestHeaders: undefined,
        },
        input.res,
        {
          requestId: input.trace.requestId,
          accountId: currentResolved.account.id,
          userId: input.relayUser.userId,
          relayKeySource: input.relayUser.relayKeySource,
          sessionKey: null,
          clientDeviceId: input.clientDeviceId,
          durationMs: Date.now() - input.trace.startedAt,
          target: input.trace.target,
          path: input.req.path,
          method: input.req.method,
          requestHeaders: RelayService.sanitizeHeaders(input.req.headers),
          requestBodyPreview: RelayService.truncateBody(input.rawRequestBody),
          upstreamRequestHeaders,
        },
      )

      if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
        await this.oauthService.markAccountUsed(currentResolved.account.id)
        if (input.relayUser.userId && !input.relayUser.userAccountId && this.userStore) {
          void this.userStore.bindAccountIfNeeded(
            input.relayUser.userId,
            currentResolved.account.id,
          ).catch(() => {})
        }
      }

      this.logHttpCompleted(input.trace, {
        accountId: currentResolved.account.id,
        authMode: 'api_key',
        forceAccountId: input.forceAccountId,
        hasStickySessionKey: false,
        retryCount,
        routeAuthStrategy: input.route.authStrategy,
        upstreamHeaders,
        rateLimitStatus: observation.rateLimitStatus,
        responseBodyPreview: observation.responseBodyPreview,
        responseContentType: observation.responseContentType,
        statusCode: upstream.statusCode,
        statusText: upstream.statusText,
      })
      return
    }
  }

  private async connectUpstreamWebSocket(input: {
    headers: IncomingHttpHeaders
    rawHeaders: string[] | undefined
    enablePerMessageDeflate: boolean
    forceAccountId: string | null
    routingGroupId: string | null
    clientDeviceId: string | null
    userId: string | null
    pathname: string
    route: WebSocketRoute
    sessionKey: string | null
    upstreamUrl: URL
    usage: WebSocketUsageContext
    websocketProtocols: string[]
  }): Promise<ConnectedUpstreamSocket> {
    const authMode = this.resolveUpstreamAuthMode(
      input.route.authStrategy,
      input.headers,
      input.forceAccountId,
    )

    if (authMode !== 'oauth') {
      const resolvedForProxy = await this.oauthService.selectAccount({
        provider: CLAUDE_OFFICIAL_PROVIDER.id,
        forceAccountId: input.forceAccountId,
        routingGroupId: input.routingGroupId,
        userId: input.userId,
        clientDeviceId: input.clientDeviceId,
      })
      const accountProxyUrl = this.requireProxyUrl(
        resolvedForProxy.proxyUrl,
        `Account ${resolvedForProxy.account.id} has no proxy configured`,
      )
      const upstreamRequestHeaders = buildWebSocketUpstreamHeaders(
        input.rawHeaders,
        input.headers,
        null,
        authMode,
        resolvedForProxy.vmFingerprintHeaders,
        resolvedForProxy.bodyTemplate?.anthropicBeta,
      )
      try {
        const upstream = await this.openUpstreamWebSocket(
          input.upstreamUrl,
          upstreamRequestHeaders,
          input.websocketProtocols,
          input.enablePerMessageDeflate,
          resolvedForProxy.account.id,
          0,
          accountProxyUrl,
        )
        this.recordWebSocketUsage({
          usage: input.usage,
          accountId: resolvedForProxy.account.id,
          statusCode: 101,
          responseHeaders: RelayService.sanitizeHeaders(upstream.upgradeHeaders),
          upstreamRequestHeaders,
        })
        return upstream
      } catch (error) {
        const failure = toUpstreamWebSocketError(error)
        this.recordWebSocketUsage({
          usage: input.usage,
          accountId: resolvedForProxy.account.id,
          statusCode: failure.statusCode,
          responseHeaders: RelayService.sanitizeHeaders(failure.responseHeaders),
          responseBodyPreview: RelayService.truncateBody(failure.responseBody),
          upstreamRequestHeaders,
        })
        throw failure
      }
    }

    let resolved = await this.oauthService.selectAccount({
      provider: CLAUDE_OFFICIAL_PROVIDER.id,
      sessionKey: input.sessionKey,
      forceAccountId: input.forceAccountId,
      routingGroupId: input.routingGroupId,
      clientDeviceId: input.clientDeviceId,
      userId: input.userId,
    })
    let accountProxyUrl = this.requireProxyUrl(
      resolved.proxyUrl,
      `Account ${resolved.account.id} has no proxy configured`,
    )

    let retryCount = 0

    while (true) {
      try {
        const upstreamUrl =
          resolved.sessionRoute
            ? this.rewriteSessionUrl(input.upstreamUrl, resolved.sessionRoute.upstreamSessionId) ?? input.upstreamUrl
            : input.upstreamUrl
        const headerOverrides: Record<string, string | null> = resolved.sessionRoute
          ? {
              'x-claude-code-session-id': resolved.sessionRoute.upstreamSessionId,
              'x-claude-remote-session-id': resolved.sessionRoute.upstreamSessionId,
            }
          : {}
        const upstreamRequestHeaders = buildWebSocketUpstreamHeaders(
          input.rawHeaders,
          input.headers,
          resolved.account.accessToken,
          'oauth',
          resolved.vmFingerprintHeaders,
          resolved.bodyTemplate?.anthropicBeta,
          headerOverrides,
        )
        const upstream = await this.openUpstreamWebSocket(
          upstreamUrl,
          upstreamRequestHeaders,
          input.websocketProtocols,
          input.enablePerMessageDeflate,
          resolved.account.id,
          retryCount,
          accountProxyUrl,
        )
        this.recordWebSocketUsage({
          usage: input.usage,
          accountId: resolved.account.id,
          statusCode: 101,
          responseHeaders: RelayService.sanitizeHeaders(upstream.upgradeHeaders),
          upstreamRequestHeaders,
        })
        return upstream
      } catch (error) {
        const failure = toUpstreamWebSocketError(error)
        const rl = extractRateLimitInfoFromErrorResponse({
          statusCode: failure.statusCode,
          headers: failure.responseHeaders,
          body: failure.responseBody,
        })
        const retryAfterSec4 = this.parseRetryAfterSeconds(failure.responseHeaders)
        this.healthTracker.recordResponse(
          resolved.account.id,
          failure.statusCode,
          retryAfterSec4,
        )
        if (failure.statusCode === 429) {
          const longBan4 = this.isLongBanCooldown(retryAfterSec4, rl.resetTimestamp)
          if (longBan4.isLong) {
            void this.oauthService.markAccountLongTermBlock(resolved.account.id, longBan4.blockUntilMs)
            this.safeLog({
              event: 'long_term_block_detected',
              requestId: input.usage.requestId,
              method: 'GET',
              target: input.usage.target,
              durationMs: Date.now() - input.usage.startedAt,
              accountId: resolved.account.id,
            })
          } else {
            this.scheduleAccountCooldown(
              resolved.account.id,
              this.computeRateLimitCooldownMs(retryAfterSec4, rl.resetTimestamp),
              {
                requestId: input.usage.requestId,
                method: 'GET',
                startedAt: input.usage.startedAt,
                target: input.usage.target,
              },
              'GET',
              input.usage.target,
            )
          }
        }
        await this.oauthService.recordRateLimitSnapshot({
          accountId: resolved.account.id,
          status: rl.status,
          fiveHourUtilization: rl.fiveHourUtilization,
          sevenDayUtilization: rl.sevenDayUtilization,
          resetTimestamp: rl.resetTimestamp,
          observedAt: Date.now(),
        })

        const terminalAccountFailureReason = this.classifyTerminalAccountFailureReason(
          failure.statusCode,
          failure.responseText,
        )
        if (terminalAccountFailureReason) {
          await this.oauthService.markAccountTerminalFailure(
            resolved.account.id,
            terminalAccountFailureReason,
          )
        }

        const websocketAccountFailureMigrationReason =
          terminalAccountFailureReason && !input.forceAccountId
            ? terminalAccountFailureReason
            : null
        const websocketSessionMigrationReason =
          input.sessionKey &&
          this.shouldRetryWithSessionMigration(failure.statusCode, rl.status, retryAfterSec4)
            ? (rl.status ? `rate_limit:${rl.status}` : `status_${failure.statusCode}`)
            : null
        const websocketMigrationReason =
          websocketAccountFailureMigrationReason ?? websocketSessionMigrationReason

        if (websocketMigrationReason && retryCount < appConfig.sameRequestMaxRetries) {
          this.recordWebSocketUsage({
            usage: input.usage,
            accountId: resolved.account.id,
            attemptKind: 'retry_failure',
            statusCode: failure.statusCode,
            rateLimitStatus: rl.status,
            rateLimit5hUtilization: rl.fiveHourUtilization,
            rateLimit7dUtilization: rl.sevenDayUtilization,
            rateLimitReset: rl.resetTimestamp,
            responseHeaders: RelayService.sanitizeHeaders(failure.responseHeaders),
            responseBodyPreview: RelayService.truncateBody(failure.responseBody),
          })
          try {
            resolved = await this.oauthService.selectAccount({
              provider: CLAUDE_OFFICIAL_PROVIDER.id,
              sessionKey: input.sessionKey,
              forceAccountId: input.forceAccountId,
              routingGroupId: input.routingGroupId,
              clientDeviceId: input.clientDeviceId,
              userId: input.userId,
              disallowedAccountId: resolved.account.id,
              handoffReason: websocketMigrationReason,
            })
            accountProxyUrl = this.requireProxyUrl(
              resolved.proxyUrl,
              `Account ${resolved.account.id} has no proxy configured`,
            )
            retryCount += 1
            continue
          } catch {
            // fall through and return the original upstream failure
          }
        }

        if (
          terminalAccountFailureReason ||
          !this.isAuthenticationFailure(failure.statusCode) ||
          !this.shouldRetryWithFreshToken(
            failure.statusCode,
            failure.responseText,
            resolved.account.accessToken,
          )
        ) {
          this.recordWebSocketUsage({
            usage: input.usage,
            accountId: resolved.account.id,
            statusCode: failure.statusCode,
            rateLimitStatus: rl.status,
            rateLimit5hUtilization: rl.fiveHourUtilization,
            rateLimit7dUtilization: rl.sevenDayUtilization,
            rateLimitReset: rl.resetTimestamp,
            responseHeaders: RelayService.sanitizeHeaders(failure.responseHeaders),
            responseBodyPreview: RelayService.truncateBody(failure.responseBody),
          })
          if (failure.retryCount === retryCount) {
            throw failure
          }
          throw new UpstreamWebSocketError(
            failure.message,
            failure.statusCode,
            failure.responseBody,
            failure.responseHeaders,
            failure.responseRawHeaders,
            failure.responseStatusMessage,
            retryCount,
          )
        }

        try {
          const recovery = await this.oauthService.recoverAccountAfterAuthFailure({
            failedAccountId: resolved.account.id,
            failedAccessToken: resolved.account.accessToken,
            sessionKey: input.sessionKey,
            forceAccountId: input.forceAccountId,
            routingGroupId: input.routingGroupId,
          })

          retryCount += 1
          resolved = recovery.resolved
          accountProxyUrl = this.requireProxyUrl(
            resolved.proxyUrl,
            `Account ${resolved.account.id} has no proxy configured`,
          )
        } catch {
          this.recordWebSocketUsage({
            usage: input.usage,
            accountId: resolved.account.id,
            statusCode: failure.statusCode,
            rateLimitStatus: rl.status,
            rateLimit5hUtilization: rl.fiveHourUtilization,
            rateLimit7dUtilization: rl.sevenDayUtilization,
            rateLimitReset: rl.resetTimestamp,
            responseHeaders: RelayService.sanitizeHeaders(failure.responseHeaders),
            responseBodyPreview: RelayService.truncateBody(failure.responseBody),
          })
          throw new UpstreamWebSocketError(
            failure.message,
            failure.statusCode,
            failure.responseBody,
            failure.responseHeaders,
            failure.responseRawHeaders,
            failure.responseStatusMessage,
            retryCount,
          )
        }
      }
    }
  }

  private async openUpstreamWebSocket(
    upstreamUrl: URL,
    headers: Record<string, string>,
    websocketProtocols: string[],
    enablePerMessageDeflate: boolean,
    accountId: string | null,
    retryCount: number,
    proxyUrl: string,
  ): Promise<ConnectedUpstreamSocket> {
    const ws = this.createUpstreamWebSocket(
      upstreamUrl,
      headers,
      websocketProtocols,
      enablePerMessageDeflate,
      proxyUrl,
    )
    const earlyCapture = this.captureEarlyUpstreamTraffic(ws)
    let upgradeHeaders: IncomingHttpHeaders = {}
    let upgradeRawHeaders: string[] | undefined

    try {
      await new Promise<void>((resolve, reject) => {
        const onUpgrade = (response: IncomingMessage) => {
          upgradeHeaders = response.headers
          upgradeRawHeaders = response.rawHeaders
        }
        const onOpen = () => {
          cleanup()
          resolve()
        }
        const onError = (error: Error) => {
          cleanup()
          reject(
            new UpstreamWebSocketError(
              `WebSocket connection failed: ${error.message}`,
              502,
              Buffer.alloc(0),
              {},
              undefined,
              undefined,
              retryCount,
            ),
          )
        }
        const onUnexpectedResponse = (
          _request: IncomingMessage,
          response: IncomingMessage,
        ) => {
          void this.readUpgradeFailureResponse(response).then((body) => {
            cleanup()
            reject(
              new UpstreamWebSocketError(
                `WebSocket upgrade rejected with status ${response.statusCode ?? 502}`,
                response.statusCode ?? 502,
                body,
                response.headers,
                response.rawHeaders,
                response.statusMessage,
                retryCount,
              ),
            )
          }).catch(() => {
            cleanup()
            reject(
              new UpstreamWebSocketError(
                `WebSocket upgrade rejected with status ${response.statusCode ?? 502}`,
                response.statusCode ?? 502,
                Buffer.alloc(0),
                response.headers,
                response.rawHeaders,
                response.statusMessage,
                retryCount,
              ),
            )
          })
        }
        const cleanup = () => {
          ws.off('upgrade', onUpgrade)
          ws.off('open', onOpen)
          ws.off('error', onError)
          ws.off('unexpected-response', onUnexpectedResponse)
        }

        ws.once('upgrade', onUpgrade)
        ws.once('open', onOpen)
        ws.once('error', onError)
        ws.once('unexpected-response', onUnexpectedResponse)
      })
    } catch (error) {
      earlyCapture.release()
      this.terminateWebSocket(ws)
      throw error
    }

    return {
      ws,
      accountId,
      retryCount,
      earlyCapture,
      upgradeHeaders,
      upgradeRawHeaders,
      upstreamRequestHeaders: RelayService.sanitizeHeaders(headers),
    }
  }

  private createUpstreamWebSocket(
    upstreamUrl: URL,
    headers: Record<string, string>,
    websocketProtocols: string[],
    enablePerMessageDeflate: boolean,
    proxyUrl: string,
  ): WebSocket {
    const urlString = this.toWebSocketUrl(upstreamUrl).toString()
    const agent = this.createWebSocketProxyAgent(upstreamUrl, proxyUrl)
    if (websocketProtocols.length > 0) {
      return new WebSocket(urlString, websocketProtocols, {
        agent,
        handshakeTimeout: appConfig.requestTimeoutMs,
        headers,
        perMessageDeflate: enablePerMessageDeflate,
      })
    }
    return new WebSocket(urlString, {
      agent,
      handshakeTimeout: appConfig.requestTimeoutMs,
      headers,
      perMessageDeflate: enablePerMessageDeflate,
    })
  }

  private createWebSocketProxyAgent(url: URL, proxyUrl: string): HttpAgent | HttpsAgent {
    return url.protocol === 'wss:'
      ? this.proxyPool.getWssAgent(proxyUrl)
      : this.proxyPool.getWsAgent(proxyUrl)
  }

  private createClientWebSocketServer(upstreamWs: WebSocket): WebSocketServer {
    const selectedProtocol = upstreamWs.protocol.trim()

    return new WebSocketServer({
      noServer: true,
      clientTracking: false,
      handleProtocols: selectedProtocol
        ? (protocols) => protocols.has(selectedProtocol) ? selectedProtocol : false
        : undefined,
      perMessageDeflate: hasPerMessageDeflateExtension(upstreamWs.extensions),
    })
  }

  private captureEarlyUpstreamTraffic(ws: WebSocket): EarlyUpstreamCapture {
    const messages: Array<{ data: string | Buffer; isBinary: boolean }> = []
    let close: { code: number; reason: Buffer } | null = null

    const onMessage = (data: RawData, isBinary: boolean) => {
      messages.push({
        data: this.normalizeWebSocketMessage(data, isBinary),
        isBinary,
      })
    }
    const onClose = (code: number, reason: Buffer) => {
      close = {
        code,
        reason: Buffer.from(reason),
      }
    }

    ws.on('message', onMessage)
    ws.on('close', onClose)

    return {
      get close() {
        return close
      },
      messages,
      release: () => {
        ws.off('message', onMessage)
        ws.off('close', onClose)
      },
    }
  }

  private bridgeWebSockets(
    clientWs: WebSocket,
    upstream: ConnectedUpstreamSocket,
    options: {
      onClose?: (code: number, error?: string) => void
    } = {},
  ): void {
    const { earlyCapture, ws: upstreamWs } = upstream
    earlyCapture.release()
    let closeLogged = false

    const emitClose = (code: number, error?: string) => {
      if (closeLogged) {
        return
      }
      closeLogged = true
      options.onClose?.(code, error)
    }

    clientWs.on('message', (data, isBinary) => {
      this.forwardWebSocketMessage(upstreamWs, data, isBinary)
    })
    upstreamWs.on('message', (data, isBinary) => {
      this.forwardWebSocketMessage(clientWs, data, isBinary)
    })

    clientWs.on('close', (code, reason) => {
      emitClose(code)
      this.closeWebSocket(upstreamWs, code, reason)
    })
    upstreamWs.on('close', (code, reason) => {
      emitClose(code)
      this.closeWebSocket(clientWs, code, reason)
    })

    clientWs.on('error', () => {
      emitClose(1011, 'client_websocket_error')
      this.terminateWebSocket(upstreamWs)
    })
    upstreamWs.on('error', () => {
      emitClose(1011, 'upstream_websocket_error')
      this.terminateWebSocket(clientWs)
    })

    for (const message of earlyCapture.messages) {
      this.sendWebSocketMessage(clientWs, message.data, message.isBinary)
    }

    if (earlyCapture.close) {
      emitClose(earlyCapture.close.code)
      this.closeWebSocket(clientWs, earlyCapture.close.code, earlyCapture.close.reason)
    }
  }

  private forwardWebSocketMessage(
    target: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): void {
    this.sendWebSocketMessage(target, this.normalizeWebSocketMessage(data, isBinary), isBinary)
  }

  private sendWebSocketMessage(
    target: WebSocket,
    data: string | Buffer,
    isBinary: boolean,
  ): void {
    if (target.readyState !== WebSocket.OPEN) {
      return
    }

    try {
      if (typeof data === 'string') {
        target.send(data)
        return
      }
      target.send(data, { binary: isBinary })
    } catch {
      this.terminateWebSocket(target)
    }
  }

  private closeWebSocket(
    target: WebSocket,
    code?: number,
    reason?: string | Buffer,
  ): void {
    if (
      target.readyState === WebSocket.CLOSING ||
      target.readyState === WebSocket.CLOSED
    ) {
      return
    }

    const normalizedReason = normalizeWebSocketCloseReason(reason)
    if (this.isValidCloseCode(code)) {
      try {
        target.close(code, normalizedReason)
        return
      } catch {
        this.terminateWebSocket(target)
        return
      }
    }

    try {
      target.close()
    } catch {
      this.terminateWebSocket(target)
    }
  }

  private terminateWebSocket(target: WebSocket): void {
    if (target.readyState === WebSocket.CLOSED) {
      return
    }
    try {
      if (target.readyState === WebSocket.CONNECTING) {
        target.on('error', () => {})
      }
      target.terminate()
    } catch {
      // no-op
    }
  }

  private isValidCloseCode(code: number | undefined): code is number {
    if (typeof code !== 'number' || !Number.isInteger(code)) {
      return false
    }
    if (code === 1000) {
      return true
    }
    if (code >= 3000 && code <= 4999) {
      return true
    }
    return code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)
  }

  private rejectUpgrade(
    socket: Duplex,
    statusCode: number,
    payload: Buffer | Record<string, unknown>,
    options: {
      upstreamHeaders?: IncomingHttpHeaders
      upstreamRawHeaders?: string[]
      statusMessage?: string
    } = {},
  ): void {
    if (socket.destroyed) {
      return
    }

    const isBufferedPayload = Buffer.isBuffer(payload)
    const body = isBufferedPayload
      ? payload
      : Buffer.from(JSON.stringify(payload), 'utf8')
    const statusText = options.statusMessage ?? STATUS_CODES[statusCode] ?? 'Error'
    const headerLines = [
      `HTTP/1.1 ${statusCode} ${statusText}`,
    ]

    let sawContentType = false
    let sawContentLength = false

    for (const [rawName, rawValue] of getHeaderPairs(
      options.upstreamRawHeaders,
      options.upstreamHeaders ?? {},
    )) {
      const name = rawName.toLowerCase()
      if (!shouldForwardWebSocketFailureResponseHeader(name)) {
        continue
      }
      if (name === 'content-length') {
        if (rawValue.trim() === String(body.length)) {
          headerLines.push(`${rawName}: ${rawValue}`)
          sawContentLength = true
        }
        continue
      }
      if (name === 'content-type') {
        sawContentType = true
      }
      headerLines.push(`${rawName}: ${rawValue}`)
    }

    headerLines.push('Connection: close')
    if (!sawContentType && !isBufferedPayload) {
      headerLines.push('Content-Type: application/json; charset=utf-8')
    }
    if (!sawContentLength) {
      headerLines.push(`Content-Length: ${body.length}`)
    }
    headerLines.push('', '')
    socket.end(Buffer.concat([Buffer.from(headerLines.join('\r\n'), 'utf8'), body]))
  }

  private appendWebSocketUpgradeResponseHeaders(
    targetHeaders: string[],
    upstreamHeaders: IncomingHttpHeaders,
    upstreamRawHeaders?: string[],
  ): void {
    for (const [rawName, rawValue] of getHeaderPairs(
      upstreamRawHeaders,
      upstreamHeaders,
    )) {
      const name = rawName.toLowerCase()
      if (!shouldForwardWebSocketUpgradeResponseHeader(name)) {
        continue
      }
      targetHeaders.push(`${rawName}: ${rawValue}`)
    }
  }

  private parseWebSocketProtocols(
    value: string | string[] | undefined,
  ): string[] {
    const raw =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value.join(',')
          : ''

    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  private normalizeWebSocketMessage(
    data: RawData,
    isBinary: boolean,
  ): string | Buffer {
    if (typeof data === 'string') {
      return data
    }

    const buffer = Array.isArray(data)
      ? Buffer.concat(data.map((item) => Buffer.from(item)))
      : Buffer.isBuffer(data)
        ? Buffer.from(data)
        : Buffer.from(new Uint8Array(data))

    return isBinary ? buffer : buffer.toString('utf8')
  }

  private async readUpgradeFailureResponse(response: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []

    return new Promise((resolve) => {
      response.on('data', (chunk: string | Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
      response.on('error', () => {
        resolve(Buffer.concat(chunks))
      })
    })
  }

  private createTraceContext(
    method: string,
    rawUrl: string | undefined,
    headers: IncomingHttpHeaders,
  ): HttpTraceContext {
    return {
      method: method.toUpperCase(),
      requestId:
        this.normalizeHeaderValue(headers['x-request-id']) ??
        this.normalizeHeaderValue(headers['request-id']) ??
        crypto.randomUUID(),
      startedAt: Date.now(),
      target: rawUrl ?? '/',
    }
  }

  private isMethodAllowed(methods: readonly HttpMethod[], method: string): boolean {
    const normalizedMethod = method.toUpperCase()
    if (normalizedMethod === 'HEAD' && methods.includes('GET')) {
      return true
    }
    return methods.includes(normalizedMethod as HttpMethod)
  }

  private buildAllowHeader(methods: readonly HttpMethod[]): string {
    const allow = [...methods] as string[]
    if (allow.includes('GET')) {
      allow.push('HEAD')
    }
    return allow.join(', ')
  }

  private matchHttpRoute(pathname: string): HttpRoute | null {
    return HTTP_ROUTES.find((route) => route.pattern.test(pathname)) ?? null
  }

  private matchWebSocketRoute(pathname: string): WebSocketRoute | null {
    return WEBSOCKET_ROUTES.find((route) => route.pattern.test(pathname)) ?? null
  }

  private resolveUpstreamAuthMode(
    authStrategy: RouteAuthStrategy,
    headers: IncomingHttpHeaders,
    forceAccountId: string | null,
  ): UpstreamAuthMode {
    if (authStrategy === 'prefer_incoming_auth') {
      if (!forceAccountId && this.hasIncomingAuthorization(headers) && !this.hasIncomingApiKey(headers)) {
        return 'preserve_incoming_auth'
      }
      return 'oauth'
    }

    return authStrategy
  }

  private hasIncomingAuthorization(headers: IncomingHttpHeaders): boolean {
    const value = this.normalizeHeaderValue(headers.authorization)
    return Boolean(value?.trim())
  }

  private hasIncomingApiKey(headers: IncomingHttpHeaders): boolean {
    const value = this.normalizeHeaderValue(headers['x-api-key'])
    return Boolean(value?.trim())
  }

  private requireProxyUrl(proxyUrl: string | null, errorMessage: string): string {
    if (!proxyUrl) {
      throw new Error(errorMessage)
    }
    return proxyUrl
  }

  private getOptionalHttpDispatcher(proxyUrl: string | null): Dispatcher | undefined {
    return proxyUrl ? this.proxyPool.getHttpDispatcher(proxyUrl) : undefined
  }

  private logHttpRequestCapture(
    req: Request,
    body: RelayRequestBody,
    upstreamUrl: URL,
    upstreamRequestHeaders: string[],
    authMode: UpstreamAuthMode,
    captureContext: RequestCaptureContext | undefined,
  ): void {
    if (!captureContext || !appConfig.relayCaptureEnabled || !this.logger.logCapture) {
      return
    }

    const incomingPairs = getHeaderPairs(req.rawHeaders, req.headers)
    const upstreamPairs = this.flattenRawHeaders(upstreamRequestHeaders)
    const diff = this.diffHeaderPairs(incomingPairs, upstreamPairs)

    this.safeLogCapture({
      event: 'http_request_capture',
      requestId: captureContext.trace.requestId,
      method: captureContext.trace.method,
      target: captureContext.trace.target,
      upstreamUrl: upstreamUrl.toString(),
      authMode,
      routeAuthStrategy: captureContext.routeAuthStrategy,
      incomingRawHeaders: this.serializeHeaderPairs(incomingPairs),
      upstreamRequestHeaders: this.serializeHeaderPairs(upstreamPairs),
      removedHeaders: diff.removed,
      addedHeaders: diff.added,
      changedHeaders: diff.changed,
      incomingBody: this.createBodyCapture(body),
      upstreamBody: this.createBodyCapture(body),
    })
  }

  private async prepareRequestBody(req: Request): Promise<PreparedRequestBody> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return { body: undefined, bufferedBody: undefined }
    }

    if (Buffer.isBuffer(req.body)) {
      const bufferedBody = req.body.length > 0 ? req.body : undefined
      return {
        body: bufferedBody,
        bufferedBody,
      }
    }
    if (typeof req.body === 'string') {
      const bufferedBody = req.body.length > 0 ? Buffer.from(req.body) : undefined
      return {
        body: bufferedBody,
        bufferedBody,
      }
    }

    if (!this.shouldBufferRequestBody(req.method, req.path)) {
      return {
        body: req,
        bufferedBody: undefined,
      }
    }

    const bufferedBody = await this.readBufferedRequestBody(req, appConfig.bufferedRequestBodyMaxBytes)
    return {
      body: bufferedBody,
      bufferedBody,
    }
  }

  private shouldBufferRequestBody(method: string, path: string): boolean {
    if (method === 'GET' || method === 'HEAD') {
      return false
    }
    return (
      path === '/v1/messages' ||
      path === '/v1/messages/count_tokens' ||
      path === '/v1/chat/completions' ||
      path === '/v1/responses' ||
      path.startsWith('/v1/responses/')
    )
  }

  private async readBufferedRequestBody(req: Request, maxBytes: number): Promise<Buffer | undefined> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) {
        throw new BufferedRequestBodyTooLargeError(maxBytes)
      }
      chunks.push(buffer)
    }
    if (chunks.length === 0) {
      return undefined
    }
    return Buffer.concat(chunks)
  }

  private maybeRewriteBufferedRequestBody(
    body: RelayRequestBody,
    method: string,
    path: string,
    clientVersion: [number, number, number],
    template: BodyTemplate | null,
  ): RelayRequestBody {
    if (!Buffer.isBuffer(body)) {
      return body
    }
    return this.maybeRewriteBody(method, path, body, clientVersion, template)
  }

  private canReplayRequestBody(body: RelayRequestBody): boolean {
    return body == null || Buffer.isBuffer(body)
  }

  private async forward(
    req: Request,
    accessToken: string | null,
    body: RelayRequestBody,
    authMode: UpstreamAuthMode,
    options?: RequestCaptureContext & {
      dispatcher?: Dispatcher
      vmFingerprintHeaders?: VmFingerprintTemplateHeader[]
      anthropicBeta?: string
      headerOverrides?: Record<string, string | null>
      upstreamUrlOverride?: URL
      allowClientBetaPassthrough?: boolean
    },
  ): Promise<ForwardedHttpResponse> {
    const upstreamUrl = options?.upstreamUrlOverride ?? this.buildUpstreamUrlFromRawUrl(req.originalUrl)
    const stripLongContextBeta = this.shouldStripLongContextBeta(body)
    const upstreamRequestHeaders = buildUpstreamHeaders(
      req.rawHeaders,
      req.headers,
      accessToken,
      authMode,
      options?.vmFingerprintHeaders ?? appConfig.vmFingerprintTemplateHeaders,
      options?.anthropicBeta,
      options?.headerOverrides,
      options?.allowClientBetaPassthrough ?? false,
      stripLongContextBeta,
    )
    if (Buffer.isBuffer(body)) {
      this.syncContentLength(upstreamRequestHeaders, body.length)
    }
    this.logHttpRequestCapture(
      req,
      body,
      upstreamUrl,
      upstreamRequestHeaders,
      authMode,
      options,
    )
    const upstream = await request(upstreamUrl, {
      method: req.method,
      dispatcher: options?.dispatcher,
      headers: upstreamRequestHeaders,
      body,
      headersTimeout: appConfig.upstreamRequestTimeoutMs,
      bodyTimeout: appConfig.upstreamRequestTimeoutMs,
      responseHeaders: 'raw',
    })

    const rawHeaders = Array.isArray(upstream.headers)
      ? upstream.headers
      : undefined

    return {
      body: upstream.body,
      headers: rawHeaders
        ? collapseIncomingHeaders(rawHeaders)
        : upstream.headers,
      rawHeaders,
      statusCode: upstream.statusCode,
      statusText: upstream.statusText,
      upstreamRequestHeaders,
    }
  }

  private buildUpstreamUrlFromRawUrl(rawUrl: string | undefined): URL {
    const upstreamUrl = new URL(rawUrl ?? '/', appConfig.anthropicApiBaseUrl)
    upstreamUrl.searchParams.delete('force_account')
    return upstreamUrl
  }

  private applySessionRouteToHttpRequest(
    req: Request,
    body: RelayRequestBody,
    resolved: ResolvedAccount,
  ): {
    body: RelayRequestBody
    headerOverrides: Record<string, string | null>
    upstreamUrlOverride: URL | undefined
    handoffInjected: boolean
  } {
    if (!resolved.sessionRoute) {
      return {
        body,
        headerOverrides: {},
        upstreamUrlOverride: undefined,
        handoffInjected: false,
      }
    }

    if (!Buffer.isBuffer(body)) {
      return {
        body,
        headerOverrides: {},
        upstreamUrlOverride: undefined,
        handoffInjected: false,
      }
    }

    const headerOverrides = {
      'x-claude-code-session-id': resolved.sessionRoute.upstreamSessionId,
      'x-claude-remote-session-id': resolved.sessionRoute.upstreamSessionId,
    }
    const upstreamUrlOverride = this.rewriteSessionUrl(
      this.buildUpstreamUrlFromRawUrl(req.originalUrl),
      resolved.sessionRoute.upstreamSessionId,
    )
    const rewrittenBody = this.rewriteBodyForSessionRoute(
      req.path,
      body,
      resolved.sessionRoute.upstreamSessionId,
      resolved.handoffSummary,
    )

    return {
      body: rewrittenBody.body,
      headerOverrides,
      upstreamUrlOverride,
      handoffInjected: rewrittenBody.handoffInjected,
    }
  }

  private rewriteSessionUrl(url: URL, upstreamSessionId: string): URL | undefined {
    const rewritten = new URL(url.toString())
    let changed = false

    if (/^\/v1\/sessions\/ws\/[^/]+\/subscribe$/.test(rewritten.pathname)) {
      rewritten.pathname = rewritten.pathname.replace(
        /^\/v1\/sessions\/ws\/[^/]+\/subscribe$/,
        `/v1/sessions/ws/${encodeURIComponent(upstreamSessionId)}/subscribe`,
      )
      changed = true
    } else if (/^\/v1\/sessions\/[^/]+(\/.+)?$/.test(rewritten.pathname)) {
      rewritten.pathname = rewritten.pathname.replace(
        /^\/v1\/sessions\/[^/]+(\/.+)?$/,
        (_match, suffix: string | undefined) => {
          changed = true
          return `/v1/sessions/${encodeURIComponent(upstreamSessionId)}${suffix ?? ''}`
        },
      )
    } else if (/^\/v1\/session_ingress\/session\/[^/]+$/.test(rewritten.pathname)) {
      rewritten.pathname = rewritten.pathname.replace(
        /^\/v1\/session_ingress\/session\/[^/]+$/,
        `/v1/session_ingress/session/${encodeURIComponent(upstreamSessionId)}`,
      )
      changed = true
    } else if (/^\/v1\/session_ingress\/ws\/[^/]+$/.test(rewritten.pathname)) {
      rewritten.pathname = rewritten.pathname.replace(
        /^\/v1\/session_ingress\/ws\/[^/]+$/,
        `/v1/session_ingress/ws/${encodeURIComponent(upstreamSessionId)}`,
      )
      changed = true
    } else if (/^\/v1\/sessions\/[^/]+\/events$/.test(rewritten.pathname)) {
      rewritten.pathname = rewritten.pathname.replace(
        /^\/v1\/sessions\/[^/]+\/events$/,
        `/v1/sessions/${encodeURIComponent(upstreamSessionId)}/events`,
      )
      changed = true
    } else if (/^\/v1\/session_ingress\/.+/.test(rewritten.pathname)) {
      rewritten.pathname = rewritten.pathname.replace(
        /^\/v1\/session_ingress\/[^/]+/,
        (_match) => {
          changed = true
          return `/v1/session_ingress/${encodeURIComponent(upstreamSessionId)}`
        },
      )
    }

    return changed ? rewritten : undefined
  }

  private rewriteBodyForSessionRoute(
    path: string,
    body: Buffer | undefined,
    upstreamSessionId: string,
    handoffSummary: string | null,
  ): { body: Buffer | undefined; handoffInjected: boolean } {
    if (!body || body.length === 0) {
      return { body, handoffInjected: false }
    }
    if (path !== '/v1/messages' && path !== '/v1/messages/count_tokens') {
      return { body, handoffInjected: false }
    }
    try {
      const parsed = JSON.parse(body.toString('utf8')) as {
        system?: unknown
        metadata?: { user_id?: string }
      }
      if (parsed.metadata && typeof parsed.metadata.user_id === 'string') {
        try {
          const userId = JSON.parse(parsed.metadata.user_id) as Record<string, unknown>
          userId.session_id = upstreamSessionId
          parsed.metadata.user_id = JSON.stringify(userId)
        } catch {
          // ignore malformed metadata.user_id
        }
      }

      let handoffInjected = false
      if (handoffSummary) {
        const handoffBlock = {
          type: 'text',
          text: handoffSummary,
        }
        if (Array.isArray(parsed.system)) {
          parsed.system = [...parsed.system, handoffBlock]
          handoffInjected = true
        } else if (typeof parsed.system === 'string') {
          parsed.system = [
            { type: 'text', text: parsed.system },
            handoffBlock,
          ]
          handoffInjected = true
        } else {
          parsed.system = [handoffBlock]
          handoffInjected = true
        }
      }

      return {
        body: Buffer.from(JSON.stringify(parsed), 'utf8'),
        handoffInjected,
      }
    } catch {
      return { body, handoffInjected: false }
    }
  }

  private rewriteOpenAICodexHandoffBody(
    body: RelayRequestBody,
    handoffSummary: string | null,
  ): { body: RelayRequestBody; handoffInjected: boolean } {
    if (!handoffSummary?.trim() || !Buffer.isBuffer(body) || body.length === 0) {
      return { body, handoffInjected: false }
    }

    try {
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      const existingInstructions = typeof parsed.instructions === 'string'
        ? parsed.instructions.trim()
        : ''
      parsed.instructions = existingInstructions
        ? `${existingInstructions}\n\n${handoffSummary.trim()}`
        : handoffSummary.trim()
      return {
        body: Buffer.from(JSON.stringify(parsed), 'utf8'),
        handoffInjected: true,
      }
    } catch {
      return { body, handoffInjected: false }
    }
  }

  // Select the appropriate body template based on client version.
  // Per-account template (if set) always wins. Otherwise pick between
  // the "new" sdk-cli era template (≥2.1.100) and the legacy one.
  private selectBodyTemplate(
    clientVersion: [number, number, number],
    accountTemplate: BodyTemplate | null,
  ): BodyTemplate | null {
    if (accountTemplate !== null) return accountTemplate
    const encode = (v: readonly [number, number, number]) =>
      v[0] * 1_000_000 + v[1] * 1_000 + v[2]
    const isNewEra = encode(clientVersion) >= encode([2, 1, 100])
    if (isNewEra && appConfig.bodyTemplateNew) {
      return appConfig.bodyTemplateNew
    }
    return appConfig.bodyTemplate
  }

  private applyAccountOverrides(
    template: BodyTemplate | null,
    account: StoredAccount,
  ): BodyTemplate | null {
    if (!template) return null
    const deviceId = account.deviceId ?? template.deviceId
    const accountUuid = account.accountUuid ?? template.accountUuid
    if (deviceId === template.deviceId && accountUuid === template.accountUuid) {
      return template
    }
    return { ...template, deviceId, accountUuid }
  }

  private static sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
    const STRIP = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization'])
    const out: Record<string, string | string[] | undefined> = {}
    for (const [k, v] of Object.entries(headers)) {
      if (!STRIP.has(k.toLowerCase())) out[k] = v
    }
    return out
  }

  private static rawHeadersToObject(rawHeaders: string[]): Record<string, string | string[] | undefined> {
    const STRIP = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization'])
    const out: Record<string, string | string[] | undefined> = {}
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i].toLowerCase()
      const val = rawHeaders[i + 1]
      if (STRIP.has(key)) continue
      if (out[key]) {
        const existing = out[key]
        out[key] = Array.isArray(existing) ? [...existing, val] : [existing as string, val]
      } else {
        out[key] = val
      }
    }
    return out
  }

  private static truncateBody(body: Buffer | undefined, maxBytes = 2048): string | null {
    if (!body || body.length === 0) return null
    return body.subarray(0, maxBytes).toString('utf8')
  }

  private static decodeResponseBodyPreview(
    body: Buffer | undefined,
    contentEncoding: string | null,
    maxBytes = 2048,
  ): string | null {
    if (!body || body.length === 0) {
      return null
    }

    let decoded = body
    try {
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
    } catch {
      decoded = body
    }

    return RelayService.truncateBody(decoded, maxBytes)
  }

  private static normalizeUsageTarget(pathname: string): string {
    if (/^\/v1\/sessions\/ws\/[^/]+\/subscribe$/.test(pathname)) {
      return '/v1/sessions/ws'
    }
    return pathname
  }

  private recordUsageRecord(record: UsageRecord, method: string = 'POST'): void {
    if (!this.usageStore) {
      return
    }
    const usageStore = this.usageStore
    void (async () => {
      try {
        const usageRecordId = await usageStore.insertRecord(record)
        const billingStore = this.billingStore
        if (billingStore && usageRecordId > 0) {
          await billingStore.syncUsageRecordById(usageRecordId)
        }
      } catch (error) {
        this.safeLog({
          event: 'usage_record_failed',
          requestId: record.requestId,
          method,
          target: record.target,
          accountId: record.accountId,
          durationMs: record.durationMs,
          statusCode: record.statusCode,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  private pruneRecentServerFailures(now: number = Date.now()): void {
    const cutoff = now - appConfig.globalUpstreamIncidentWindowMs
    while (
      this.recentServerFailures.length > 0 &&
      this.recentServerFailures[0]!.timestamp <= cutoff
    ) {
      this.recentServerFailures.shift()
    }
  }

  private isGlobalUpstreamIncidentActive(now: number = Date.now()): boolean {
    if (!appConfig.globalUpstreamIncidentEnabled) {
      return false
    }
    return this.upstreamIncidentActiveUntil > now
  }

  private trackUpstreamServerFailure(accountId: string, trace: HttpTraceContext): void {
    const now = Date.now()
    this.recentServerFailures.push({ accountId, timestamp: now })
    this.pruneRecentServerFailures(now)

    const sameAccountFailures = this.recentServerFailures.filter((entry) => entry.accountId === accountId).length
    if (sameAccountFailures >= appConfig.upstream5xxCooldownThreshold) {
      this.scheduleAccountCooldown(
        accountId,
        appConfig.upstream5xxCooldownMs,
        trace,
        trace.method,
        trace.target,
      )
    }

    if (!appConfig.globalUpstreamIncidentEnabled) {
      return
    }

    const affectedAccountCount = new Set(
      this.recentServerFailures.map((entry) => entry.accountId),
    ).size
    if (affectedAccountCount < appConfig.globalUpstreamIncidentAccountThreshold) {
      return
    }

    const wasActive = this.isGlobalUpstreamIncidentActive(now)
    this.upstreamIncidentActiveUntil = Math.max(
      this.upstreamIncidentActiveUntil,
      now + appConfig.globalUpstreamIncidentCooldownMs,
    )
    if (!wasActive) {
      this.safeLog({
        event: 'upstream_incident_changed',
        requestId: trace.requestId,
        method: trace.method,
        target: trace.target,
        durationMs: Date.now() - trace.startedAt,
        statusCode: 503,
        statusText: STATUS_CODES[503] ?? 'Service Unavailable',
        affectedAccountCount,
        incidentActiveUntil: new Date(this.upstreamIncidentActiveUntil).toISOString(),
        internalCode: RELAY_ERROR_CODES.UPSTREAM_INCIDENT_ACTIVE,
        error: 'upstream_incident_activated',
      })
    }
  }

  private maybeRejectRequestForUpstreamIncident(
    trace: HttpTraceContext,
    res: Response,
    routeAuthStrategy: RouteAuthStrategy,
    forceAccountId: string | null,
  ): boolean {
    if (forceAccountId || !this.isGlobalUpstreamIncidentActive()) {
      return false
    }
    res.status(503).json(
      anthropicErrorBody(503, 'Claude upstream incident detected. Please retry later.', RELAY_ERROR_CODES.UPSTREAM_INCIDENT_ACTIVE),
    )
    this.logHttpRejection(trace, {
      error: 'upstream_incident_active',
      forceAccountId,
      internalCode: RELAY_ERROR_CODES.UPSTREAM_INCIDENT_ACTIVE,
      routeAuthStrategy,
      statusCode: 503,
      statusText: STATUS_CODES[503] ?? 'Service Unavailable',
    })
    return true
  }

  private recordWebSocketUsage(input: {
    usage: WebSocketUsageContext
    accountId: string | null
    attemptKind?: 'final' | 'retry_failure'
    statusCode: number
    rateLimitStatus?: string | null
    rateLimit5hUtilization?: number | null
    rateLimit7dUtilization?: number | null
    rateLimitReset?: number | null
    responseHeaders?: Record<string, string | string[] | undefined> | null
    responseBodyPreview?: string | null
    upstreamRequestHeaders?: Record<string, string | string[] | undefined> | null
  }): void {
    this.recordUsageRecord({
      requestId: input.usage.requestId,
      accountId: input.accountId,
      userId: input.usage.userId,
      relayKeySource: input.usage.relayKeySource,
      sessionKey: input.usage.sessionKey,
      clientDeviceId: input.usage.clientDeviceId,
      attemptKind: input.attemptKind ?? 'final',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: input.statusCode,
      durationMs: Date.now() - input.usage.startedAt,
      target: input.usage.target,
      rateLimitStatus: input.rateLimitStatus ?? null,
      rateLimit5hUtilization: input.rateLimit5hUtilization ?? null,
      rateLimit7dUtilization: input.rateLimit7dUtilization ?? null,
      rateLimitReset: input.rateLimitReset ?? null,
      requestHeaders: input.usage.requestHeaders,
      requestBodyPreview: null,
      responseHeaders: input.responseHeaders ?? null,
      responseBodyPreview: input.responseBodyPreview ?? null,
      upstreamRequestHeaders: input.upstreamRequestHeaders ?? null,
    }, 'GET')
  }

  private async pipelineWithUsageTracking(
    upstream: ForwardedHttpResponse,
    res: Response,
    context: {
      requestId: string
      accountId: string | null
      userId: string | null
      relayKeySource: RelayKeySource | null
      sessionKey: string | null
      clientDeviceId: string | null
      durationMs: number
      target: string
      path: string
      method: string
      requestHeaders?: Record<string, string | string[] | undefined> | null
      requestBodyPreview?: string | null
      upstreamRequestHeaders?: Record<string, string | string[] | undefined> | null
    },
  ): Promise<PipelineObservation> {
    const shouldTrack =
      this.usageStore &&
      context.method === 'POST' &&
      (
        context.path === '/v1/messages' ||
        context.path === '/v1/chat/completions' ||
        context.path === '/v1/responses' ||
        context.path.startsWith('/v1/responses/')
      )

    const contentType =
      typeof upstream.headers['content-type'] === 'string'
        ? upstream.headers['content-type']
        : null
    const rl = extractRateLimitInfo(upstream.headers)

    if (!shouldTrack) {
      await pipeline(upstream.body, res)
      return {
        rateLimitStatus: rl.status,
        responseBodyPreview: null,
        responseContentType: contentType,
      }
    }

    const isStreaming = (contentType ?? '').includes('text/event-stream')

    if (isStreaming) {
      const contentEncoding =
        typeof upstream.headers['content-encoding'] === 'string'
          ? upstream.headers['content-encoding'].trim().toLowerCase()
          : ''

      const { transform: usageTransform, usagePromise } = createUsageTransform()
      const sseErrorTransform = new SseErrorInspectTransform()

      // Collect first 2KB of response for preview
      const respPreviewChunks: Buffer[] = []
      let respPreviewLen = 0
      const RESP_PREVIEW_MAX = 2048

      if (contentEncoding) {
        // Compressed: forward raw data to client, decompress a branch for usage extraction
        const decompressor =
          contentEncoding === 'gzip' || contentEncoding === 'x-gzip' ? createGunzip()
            : contentEncoding === 'deflate' ? createInflate()
              : contentEncoding === 'br' ? createBrotliDecompress()
                : null

        if (decompressor) {
          decompressor.on('error', () => {})
          decompressor.on('data', (chunk: Buffer) => {
            if (respPreviewLen < RESP_PREVIEW_MAX) {
              const take = chunk.subarray(0, RESP_PREVIEW_MAX - respPreviewLen)
              respPreviewChunks.push(take)
              respPreviewLen += take.length
            }
          })
          decompressor.pipe(sseErrorTransform).pipe(usageTransform).resume()
        } else {
          sseErrorTransform.pipe(usageTransform).resume()
        }

        // Forward raw data to client untouched, tee to decompressor for usage
        try {
          await pipeline(upstream.body, new Transform({
            transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
              if (decompressor) {
                decompressor.write(chunk)
              }
              cb(null, chunk)
            },
            flush(cb: TransformCallback) {
              if (decompressor) {
                decompressor.end()
              } else {
                usageTransform.end()
              }
              cb()
            },
          }), res)
        } catch (err) {
          if (decompressor && !decompressor.destroyed) {
            decompressor.destroy()
          }
          if (!sseErrorTransform.destroyed) {
            sseErrorTransform.destroy()
          }
          if (!usageTransform.destroyed) {
            usageTransform.destroy()
          }
          if (context.accountId) {
            this.healthTracker.recordError(context.accountId)
          }
          if (res.headersSent && !res.writableEnded) {
            try {
              res.write('\nevent: error\ndata: {"type":"stream_error","message":"stream_interrupted"}\n\n')
              res.end()
            } catch {
              // best-effort
            }
            this.safeLog({
              event: 'http_stream_error_appended',
              requestId: context.requestId,
              method: context.method,
              target: context.target,
              durationMs: context.durationMs,
            })
          }
          this.logHttpStreamError(context, {
            error: err instanceof Error ? err.message : String(err),
            responseContentType: contentType,
            responseBodyPreview: sseErrorTransform.errorEventPreview,
            statusCode: upstream.statusCode,
            statusText: upstream.statusText,
            upstreamHeaders: upstream.headers,
          })
          throw err
        }
      } else {
        // No compression: pass through usage transform, collect preview
        const previewCollector = new Transform({
          transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
            if (respPreviewLen < RESP_PREVIEW_MAX) {
              const take = chunk.subarray(0, RESP_PREVIEW_MAX - respPreviewLen)
              respPreviewChunks.push(take)
              respPreviewLen += take.length
            }
            cb(null, chunk)
          },
        })
        try {
          await pipeline(upstream.body, previewCollector, sseErrorTransform, usageTransform, res)
        } catch (err) {
          if (!sseErrorTransform.destroyed) {
            sseErrorTransform.destroy()
          }
          if (!usageTransform.destroyed) {
            usageTransform.destroy()
          }
          if (context.accountId) {
            this.healthTracker.recordError(context.accountId)
          }
          if (res.headersSent && !res.writableEnded) {
            try {
              res.write('\nevent: error\ndata: {"type":"stream_error","message":"stream_interrupted"}\n\n')
              res.end()
            } catch {
              // best-effort
            }
            this.safeLog({
              event: 'http_stream_error_appended',
              requestId: context.requestId,
              method: context.method,
              target: context.target,
              durationMs: context.durationMs,
            })
          }
          this.logHttpStreamError(context, {
            error: err instanceof Error ? err.message : String(err),
            responseContentType: contentType,
            responseBodyPreview: sseErrorTransform.errorEventPreview,
            statusCode: upstream.statusCode,
            statusText: upstream.statusText,
            upstreamHeaders: upstream.headers,
          })
          throw err
        }
      }
      const respBodyPreview = respPreviewChunks.length > 0 ? Buffer.concat(respPreviewChunks).toString('utf8') : null
      if (sseErrorTransform.errorEventPreview) {
        this.logHttpStreamError(context, {
          error: 'sse_error_event',
          responseContentType: contentType,
          responseBodyPreview: sseErrorTransform.errorEventPreview,
          statusCode: upstream.statusCode,
          statusText: upstream.statusText,
          upstreamHeaders: upstream.headers,
        })
      }
      this.fireAndForgetUsage(
        usagePromise,
        upstream.headers,
        { ...context, responseBodyPreview: respBodyPreview },
        upstream.statusCode,
      )
      return {
        rateLimitStatus: rl.status,
        responseBodyPreview: upstream.statusCode >= 400 ? respBodyPreview : null,
        responseContentType: contentType,
      }
    } else {
      // Non-streaming: capture only a bounded sample to avoid buffering whole bodies in memory.
      const captureChunks: Buffer[] = []
      let capturedLen = 0
      let captureTruncated = false
      const captureMax = appConfig.nonStreamResponseCaptureMaxBytes
      const collector = new Transform({
        transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
          if (!captureTruncated && capturedLen < captureMax) {
            const take = chunk.subarray(0, captureMax - capturedLen)
            captureChunks.push(take)
            capturedLen += take.length
            if (take.length < chunk.length) {
              captureTruncated = true
            }
          } else if (chunk.length > 0) {
            captureTruncated = true
          }
          cb(null, chunk)
        },
      })
      await pipeline(upstream.body, collector, res)
      const capturedBody = Buffer.concat(captureChunks)
      const contentEncoding =
        typeof upstream.headers['content-encoding'] === 'string'
          ? upstream.headers['content-encoding'].trim().toLowerCase()
          : null
      const usage = captureTruncated ? null : extractUsageFromJsonBody(capturedBody, contentEncoding)
      const responseBodyPreview = RelayService.decodeResponseBodyPreview(capturedBody, contentEncoding)
      if (this.usageStore) {
        this.recordUsageRecord({
          requestId: context.requestId,
          accountId: context.accountId,
          userId: context.userId ?? null,
          relayKeySource: context.relayKeySource,
          sessionKey: context.sessionKey ?? null,
          clientDeviceId: context.clientDeviceId ?? null,
          model: usage?.model ?? null,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
          statusCode: upstream.statusCode,
          durationMs: context.durationMs,
          target: context.target,
          rateLimitStatus: rl.status,
          rateLimit5hUtilization: rl.fiveHourUtilization,
          rateLimit7dUtilization: rl.sevenDayUtilization,
          rateLimitReset: rl.resetTimestamp,
          requestHeaders: context.requestHeaders ?? null,
          requestBodyPreview: context.requestBodyPreview ?? null,
          responseHeaders: RelayService.sanitizeHeaders(upstream.headers),
          responseBodyPreview,
          upstreamRequestHeaders: context.upstreamRequestHeaders ?? null,
        }, context.method)
      }
      return {
        rateLimitStatus: rl.status,
        responseBodyPreview: upstream.statusCode >= 400 ? responseBodyPreview : null,
        responseContentType: contentType,
      }
    }
  }

  private fireAndForgetUsage(
    usagePromise: Promise<ExtractedUsage | null>,
    headers: IncomingHttpHeaders,
    context: {
      requestId: string
      accountId: string | null
      userId: string | null
      relayKeySource: RelayKeySource | null
      sessionKey: string | null
      clientDeviceId: string | null
      durationMs: number
      target: string
      requestHeaders?: Record<string, string | string[] | undefined> | null
      requestBodyPreview?: string | null
      responseBodyPreview?: string | null
      upstreamRequestHeaders?: Record<string, string | string[] | undefined> | null
    },
    statusCode: number,
  ): void {
    void usagePromise
      .then((usage) => {
        if (!this.usageStore) return
        const rl = extractRateLimitInfo(headers)
        return this.recordUsageRecord({
          requestId: context.requestId,
          accountId: context.accountId,
          userId: context.userId ?? null,
          relayKeySource: context.relayKeySource,
          sessionKey: context.sessionKey ?? null,
          clientDeviceId: context.clientDeviceId ?? null,
          model: usage?.model ?? null,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
          statusCode,
          durationMs: context.durationMs,
          target: context.target,
          rateLimitStatus: rl.status,
          rateLimit5hUtilization: rl.fiveHourUtilization,
          rateLimit7dUtilization: rl.sevenDayUtilization,
          rateLimitReset: rl.resetTimestamp,
          requestHeaders: context.requestHeaders ?? null,
          requestBodyPreview: context.requestBodyPreview ?? null,
          responseHeaders: RelayService.sanitizeHeaders(headers),
          responseBodyPreview: context.responseBodyPreview ?? null,
          upstreamRequestHeaders: context.upstreamRequestHeaders ?? null,
        })
      })
      .catch(() => {
        // usage tracking must never affect relay behavior
      })
  }

  private recordImmediateFailureUsage(context: {
    requestId: string
    accountId: string | null
    userId: string | null
    relayKeySource: RelayKeySource | null
    sessionKey: string | null
    clientDeviceId: string | null
    durationMs: number
    target: string
    statusCode: number
    rateLimitStatus: string | null
    rateLimit5hUtilization: number | null
    rateLimit7dUtilization: number | null
    rateLimitReset: number | null
    attemptKind?: 'final' | 'retry_failure'
    requestHeaders?: Record<string, string | string[] | undefined> | null
    requestBodyPreview?: string | null
    responseHeaders?: Record<string, string | string[] | undefined> | null
    responseBodyPreview?: string | null
    upstreamRequestHeaders?: Record<string, string | string[] | undefined> | null
  }): void {
    this.recordUsageRecord({
      requestId: context.requestId,
      accountId: context.accountId,
      userId: context.userId ?? null,
      relayKeySource: context.relayKeySource,
      sessionKey: context.sessionKey ?? null,
      clientDeviceId: context.clientDeviceId ?? null,
      attemptKind: context.attemptKind ?? 'retry_failure',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: context.statusCode,
      durationMs: context.durationMs,
      target: context.target,
      rateLimitStatus: context.rateLimitStatus,
      rateLimit5hUtilization: context.rateLimit5hUtilization,
      rateLimit7dUtilization: context.rateLimit7dUtilization,
      rateLimitReset: context.rateLimitReset,
      requestHeaders: context.requestHeaders ?? null,
      requestBodyPreview: context.requestBodyPreview ?? null,
      responseHeaders: context.responseHeaders ?? null,
      responseBodyPreview: context.responseBodyPreview ?? null,
      upstreamRequestHeaders: context.upstreamRequestHeaders ?? null,
    })
  }

  private maybeRewriteBody(
    method: string,
    path: string,
    body: Buffer | undefined,
    clientVersion: [number, number, number],
    template: BodyTemplate | null,
  ): Buffer | undefined {
    if (!body || method !== 'POST') {
      return body
    }
    if (!template) {
      return body
    }

    // /v1/messages and /v1/messages/count_tokens: full structured rewrite
    if (path === '/v1/messages' || path === '/v1/messages/count_tokens') {
      const rewritten = rewriteMessageBody(body, template)
      if (!rewritten) {
        if (appConfig.bodyRewriteSkipLogEnabled) {
          console.warn('[body-rewrite] skipped: rewriteMessageBody returned null for %s', path)
        }
        return body
      }
      return rewritten
    }

    // /api/event_logging/*: replace client version string with template version
    if (path.startsWith('/api/event_logging/')) {
      const versionStr = clientVersion.join('.')
      const rewritten = rewriteEventLoggingBody(body, template, versionStr)
      return rewritten ?? body
    }

    return body
  }

  private syncContentLength(headers: string[], bodyLength: number): void {
    for (let i = 0; i < headers.length - 1; i += 2) {
      if (headers[i].toLowerCase() === 'content-length') {
        headers[i + 1] = String(bodyLength)
        return
      }
    }
  }

  private toWebSocketUrl(url: URL): URL {
    const wsUrl = new URL(url.toString())
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    return wsUrl
  }

  private extractStickySessionKey(
    headers: IncomingHttpHeaders,
    pathname: string,
    route: WebSocketRoute,
  ): string | null {
    const headerValue = this.extractStickySessionKeyFromHeaders(headers)
    if (headerValue) {
      return headerValue
    }

    if (route.stickyKeyMode === 'session_id_path') {
      const match = pathname.match(/^\/v1\/sessions\/ws\/([^/]+)\/subscribe$/)
      return match?.[1] ?? null
    }

    return null
  }

  private extractAccountGroup(headers: IncomingHttpHeaders): string | null {
    const value = this.normalizeHeaderValue(headers['x-account-group'])?.trim()
    return value || null
  }

  private resolveClientDeviceId(
    body: Buffer | undefined,
    headers: IncomingHttpHeaders,
    searchParams: URLSearchParams,
  ): string | null {
    return (
      this.extractClientDeviceId(body) ??
      this.normalizeClientDeviceId(
        this.normalizeHeaderValue(headers['x-client-device-id']) ??
          this.normalizeHeaderValue(headers['x-relay-client-device-id']) ??
          searchParams.get('client_device_id'),
      )
    )
  }

  private sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private computeRateLimitCooldownMs(
    retryAfterSec: number | null | undefined,
    resetTimestamp: number | null,
    now: number = Date.now(),
  ): number {
    if (retryAfterSec != null && retryAfterSec > 0) {
      return Math.min(retryAfterSec * 1000, appConfig.rateLimitCooldownMaxMs)
    }
    if (resetTimestamp != null && resetTimestamp > 0) {
      const epoch = resetTimestamp < 1_000_000_000_000 ? resetTimestamp * 1000 : resetTimestamp
      const deltaMs = Math.max(0, epoch - now)
      if (deltaMs > 0) {
        return Math.min(deltaMs, appConfig.rateLimitCooldownMaxMs)
      }
    }
    return appConfig.rateLimitCooldownFallbackMs
  }

  private isLongBanCooldown(
    retryAfterSec: number | null | undefined,
    resetTimestamp: number | null,
    now: number = Date.now(),
  ): { isLong: boolean; blockUntilMs: number } {
    if (retryAfterSec != null && retryAfterSec > 0 && retryAfterSec * 1000 > appConfig.rateLimitCooldownMaxMs) {
      return { isLong: true, blockUntilMs: now + retryAfterSec * 1000 }
    }
    if (resetTimestamp != null && resetTimestamp > 0) {
      const epoch = resetTimestamp < 1_000_000_000_000 ? resetTimestamp * 1000 : resetTimestamp
      const deltaMs = epoch - now
      if (deltaMs > appConfig.rateLimitCooldownMaxMs) {
        return { isLong: true, blockUntilMs: epoch }
      }
    }
    return { isLong: false, blockUntilMs: 0 }
  }

  private parseRetryAfterSeconds(headers: IncomingHttpHeaders): number | undefined {
    const value = headers['retry-after']
    if (typeof value !== 'string') {
      return undefined
    }
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds
    }
    const dateMs = Date.parse(value)
    if (Number.isFinite(dateMs)) {
      const delta = Math.ceil((dateMs - Date.now()) / 1000)
      return delta >= 0 ? delta : undefined
    }
    return undefined
  }

  private scheduleAccountCooldown(
    accountId: string,
    cooldownMs: number,
    trace: HttpTraceContext,
    method: string,
    target: string,
  ): void {
    const until = Date.now() + cooldownMs
    void this.oauthService.setAccountCooldown(accountId, cooldownMs).catch((error) => {
      this.safeLog({
        event: 'http_failed',
        requestId: trace.requestId,
        method,
        target,
        accountId,
        durationMs: Date.now() - trace.startedAt,
        error: `set_account_cooldown_failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
    void this.oauthService.persistRateLimitedUntil(accountId, until).catch((error) => {
      process.stderr.write(
        `[relay] persist_rate_limited_until_failed accountId=${accountId} error=${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }

  private async readBodyBuffer(
    body: ForwardedHttpResponse['body'],
    maxBytes: number,
  ): Promise<Buffer> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (total < maxBytes) {
        const take = buffer.subarray(0, maxBytes - total)
        chunks.push(take)
        total += take.length
      }
    }
    return Buffer.concat(chunks)
  }

  private extractStickySessionKeyFromHeaders(
    headers: IncomingHttpHeaders,
  ): string | null {
    const candidates = [
      this.normalizeHeaderValue(headers['x-claude-code-session-id']),
      this.normalizeHeaderValue(headers['x-claude-remote-session-id']),
      this.normalizeHeaderValue(headers.session_id),
      this.normalizeHeaderValue(headers['x-codex-window-id']),
    ]

    for (const candidate of candidates) {
      const value = candidate?.trim()
      if (value) {
        return value
      }
    }

    return null
  }

  private extractClientDeviceId(body: Buffer | undefined): string | null {
    if (!body || body.length === 0) {
      return null
    }

    try {
      const parsed = JSON.parse(body.toString('utf8')) as {
        metadata?: { user_id?: unknown }
      }
      if (!parsed.metadata || typeof parsed.metadata.user_id !== 'string') {
        return null
      }
      const userId = JSON.parse(parsed.metadata.user_id) as { device_id?: unknown }
      const deviceId = typeof userId.device_id === 'string' ? userId.device_id.trim() : ''
      return deviceId || null
    } catch {
      return null
    }
  }

  private shouldStripLongContextBeta(body: RelayRequestBody): boolean {
    const model = this.extractRequestModel(body)
    if (!model) {
      return false
    }
    const normalized = model.toLowerCase()
    return normalized.includes('haiku') || normalized.includes('sonnet')
  }

  private extractRequestModel(body: RelayRequestBody): string | null {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return null
    }

    try {
      const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown }
      const model = typeof parsed.model === 'string' ? parsed.model.trim() : ''
      return model || null
    } catch {
      return null
    }
  }

  private normalizeClientDeviceId(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }
    const normalized = value.trim()
    return normalized || null
  }

  private parseForceAccountIdFromIncoming(
    headers: IncomingHttpHeaders,
    searchParams: URLSearchParams,
  ): string | null {
    const rawValue = this.readForceAccountValue(headers, searchParams)
    if (!rawValue) {
      return null
    }

    const trimmed = rawValue.trim()
    if (!trimmed) {
      return null
    }

    const providerAccountRef = parseProviderScopedAccountRef(trimmed)
    if (providerAccountRef) {
      const accountId = providerAccountRef.accountId
      if (!accountId) {
        throw new Error('x-force-account is missing accountId')
      }
      return buildProviderScopedAccountId(providerAccountRef.provider, accountId)
    }

    const unsupportedProvider = [
      'claude-console:',
      'bedrock:',
      'ccr:',
      'gemini-api:',
      'openai-responses:',
    ].find((prefix) => trimmed.startsWith(prefix))
    if (unsupportedProvider) {
      throw new Error(
        `Unsupported provider: ${unsupportedProvider.slice(0, -1)}`,
      )
    }

    return trimmed
  }

  private readForceAccountValue(
    headers: IncomingHttpHeaders,
    searchParams: URLSearchParams,
  ): string | null {
    const headerValue = this.normalizeHeaderValue(headers['x-force-account'])
    if (headerValue) {
      return headerValue
    }

    const queryValue = searchParams.getAll('force_account')
    return queryValue[0] ?? null
  }

  private normalizeHeaderValue(value: string | string[] | undefined): string | null {
    if (typeof value === 'string') {
      return value
    }
    if (Array.isArray(value)) {
      const normalized = value.map((item) => item.trim()).filter(Boolean).join(', ')
      return normalized || null
    }
    return null
  }

  private shouldRetryWithFreshToken(
    statusCode: number,
    responseText: string,
    failedAccessToken: string,
  ): boolean {
    if (statusCode !== 401 && statusCode !== 403) {
      return false
    }
    if (statusCode === 401) {
      return true
    }
    return /oauth token has been revoked/i.test(responseText) && Boolean(failedAccessToken)
  }

  private shouldRetryWithSessionMigration(
    statusCode: number,
    rateLimitStatus: string | null,
    retryAfterSec?: number,
  ): boolean {
    const normalized = rateLimitStatus?.toLowerCase() ?? null
    if (normalized === 'blocked') {
      return true
    }
    if (
      retryAfterSec === 0 &&
      (statusCode === 429 || normalized === 'rejected' || normalized === 'throttled')
    ) {
      return true
    }
    if (!appConfig.sameRequestSessionMigrationEnabled) {
      return false
    }
    if (statusCode === 429) {
      return true
    }
    if (!normalized) {
      return false
    }
    return normalized === 'rejected' || normalized === 'throttled'
  }

  private getOpenAICodexAccountMigrationReason(input: {
    statusCode: number
    rateLimitStatus: string | null
    responseText: string | null
  }): string | null {
    if (input.statusCode >= 500) {
      return null
    }

    const normalizedStatus = input.rateLimitStatus?.toLowerCase() ?? null
    if (normalizedStatus === 'blocked' || normalizedStatus === 'rejected' || normalizedStatus === 'throttled') {
      return `rate_limit:${normalizedStatus}`
    }

    if (input.statusCode === 429) {
      return 'rate_limit:rejected'
    }

    if (input.statusCode !== 403) {
      return null
    }

    const normalizedBody = input.responseText?.toLowerCase() ?? ''
    if (!normalizedBody) {
      return null
    }
    if (/quota|rate[_ -]?limit|usage limit|exceeded|insufficient_quota|too many requests/.test(normalizedBody)) {
      return 'rate_limit:rejected'
    }
    return null
  }

  private classifyHardFailureMigrationReason(
    statusCode: number,
    responseText: string,
  ): string | null {
    const normalized = responseText.toLowerCase()
    if (normalized.includes('this authentication style is incompatible with the long context beta header')) {
      return 'long_context_incompatible'
    }
    if (normalized.includes('extra usage is required for long context requests')) {
      return 'long_context_extra_usage_required'
    }
    if (normalized.includes('the long context beta is not yet available for this subscription')) {
      return 'long_context_unavailable'
    }
    return null
  }

  private classifyTerminalAccountFailureReason(
    statusCode: number,
    responseText: string,
  ): string | null {
    if (statusCode !== 400 && statusCode !== 401 && statusCode !== 403) {
      return null
    }

    const normalized = responseText.toLowerCase()
    if (
      normalized.includes('disabled organization') ||
      normalized.includes('organization is disabled') ||
      normalized.includes('organization has been disabled') ||
      normalized.includes('belongs to a disabled organization')
    ) {
      return 'account_disabled_organization'
    }
    if (
      normalized.includes('anthropic_api_key') &&
      normalized.includes('update or unset') &&
      normalized.includes('environment variable')
    ) {
      return 'account_disabled_organization'
    }
    return null
  }

  private isAuthenticationFailure(statusCode: number): boolean {
    return statusCode === 401 || statusCode === 403
  }

  private writeResponseHead(
    res: Response,
    statusCode: number,
    statusText: string,
    headers: Record<string, string | string[] | undefined>,
    rawHeaders?: string[],
  ): void {
    const forwardedRawHeaders = rawHeaders
      ? getHeaderPairs(rawHeaders, headers).flatMap(([rawName, rawValue]) => {
          const name = rawName.toLowerCase()
          if (!shouldForwardHttpResponseHeader(name)) {
            return []
          }
          return [rawName, rawValue]
        })
      : undefined

    if (forwardedRawHeaders && forwardedRawHeaders.length > 0) {
      res.writeHead(statusCode, statusText, forwardedRawHeaders)
      return
    }

    res.statusCode = statusCode
    res.statusMessage = statusText
    for (const [rawName, rawValue] of Object.entries(headers)) {
      if (rawValue === undefined) {
        continue
      }
      if (!shouldForwardHttpResponseHeader(rawName.toLowerCase())) {
        continue
      }
      res.setHeader(rawName, rawValue)
    }
  }

  private logHttpCompleted(
    trace: HttpTraceContext,
    input: {
      accountId: string | null
      authMode: UpstreamAuthMode
      forceAccountId: string | null
      hasStickySessionKey: boolean
      rateLimitStatus?: string | null
      retryAfterSeconds?: number | null
      responseBodyPreview?: string | null
      responseContentType?: string | null
      sameRequestMigrationEligible?: boolean | null
      retryCount: number
      routeAuthStrategy: RouteAuthStrategy
      statusCode: number
      statusText: string
      upstreamHeaders: IncomingHttpHeaders
    },
  ): void {
    this.safeLog({
      event: 'http_completed',
      requestId: trace.requestId,
      method: trace.method,
      target: trace.target,
      accountId: input.accountId,
      authMode: input.authMode,
      durationMs: Date.now() - trace.startedAt,
      forceAccountId: input.forceAccountId,
      hasStickySessionKey: input.hasStickySessionKey,
      retryAfterSeconds: input.retryAfterSeconds ?? null,
      sameRequestMigrationEligible: input.sameRequestMigrationEligible ?? null,
      retryCount: input.retryCount,
      routeAuthStrategy: input.routeAuthStrategy,
      rateLimitStatus: input.rateLimitStatus ?? null,
      responseContentType: input.responseContentType ?? null,
      responseBodyPreview:
        input.statusCode >= 400 ? (input.responseBodyPreview ?? null) : undefined,
      statusCode: input.statusCode,
      statusText: input.statusText,
      upstreamRequestId: this.extractUpstreamRequestId(input.upstreamHeaders),
      upstreamRay: this.normalizeHeaderValue(input.upstreamHeaders['cf-ray']),
    })
  }

  private logHttpRejection(
    trace: HttpTraceContext,
    input: {
      error: string
      forceAccountId?: string | null
      internalCode?: RelayErrorCode
      routeAuthStrategy: RouteAuthStrategy | null
      statusCode: number
      statusText: string
    },
  ): void {
    this.safeLog({
      event: 'http_rejected',
      requestId: trace.requestId,
      method: trace.method,
      target: trace.target,
      durationMs: Date.now() - trace.startedAt,
      error: input.error,
      forceAccountId: input.forceAccountId ?? null,
      internalCode: input.internalCode ?? fallbackRelayErrorCode(input.statusCode),
      routeAuthStrategy: input.routeAuthStrategy ?? undefined,
      statusCode: input.statusCode,
      statusText: input.statusText,
    })
  }

  private logHttpFailure(trace: HttpTraceContext, error: unknown): void {
    const clientError = classifyClientFacingRelayError(error)
    const statusCode = clientError?.statusCode ?? 500
    this.safeLog({
      event: 'http_failed',
      requestId: trace.requestId,
      method: trace.method,
      target: trace.target,
      durationMs: Date.now() - trace.startedAt,
      error: error instanceof Error ? error.message : String(error),
      internalCode: clientError?.code ?? RELAY_ERROR_CODES.INTERNAL_ERROR,
      statusCode,
      statusText: STATUS_CODES[statusCode] ?? 'Internal Server Error',
    })
  }

  private logHttpStreamError(
    context: {
      requestId: string
      method: string
      target: string
      accountId: string | null
      durationMs: number
    },
    input: {
      error: string
      responseContentType: string | null
      responseBodyPreview: string | null
      statusCode: number
      statusText: string
      upstreamHeaders: IncomingHttpHeaders
    },
  ): void {
    this.safeLog({
      event: 'http_stream_error',
      requestId: context.requestId,
      method: context.method,
      target: context.target,
      accountId: context.accountId,
      durationMs: context.durationMs,
      error: input.error,
      responseContentType: input.responseContentType,
      responseBodyPreview: input.responseBodyPreview,
      statusCode: input.statusCode,
      statusText: input.statusText,
      upstreamRequestId: this.extractUpstreamRequestId(input.upstreamHeaders),
      upstreamRay: this.normalizeHeaderValue(input.upstreamHeaders['cf-ray']),
    })
  }

  private logWsOpened(
    trace: HttpTraceContext,
    input: {
      accountId: string | null
      authMode: UpstreamAuthMode
      forceAccountId: string | null
      hasStickySessionKey: boolean
      retryCount: number
      routeAuthStrategy: RouteAuthStrategy
      upstreamHeaders: IncomingHttpHeaders
    },
  ): void {
    this.safeLog({
      event: 'ws_opened',
      requestId: trace.requestId,
      method: trace.method,
      target: trace.target,
      accountId: input.accountId,
      authMode: input.authMode,
      durationMs: Date.now() - trace.startedAt,
      forceAccountId: input.forceAccountId,
      hasStickySessionKey: input.hasStickySessionKey,
      retryCount: input.retryCount,
      routeAuthStrategy: input.routeAuthStrategy,
      statusCode: 101,
      statusText: STATUS_CODES[101] ?? 'Switching Protocols',
      upstreamRequestId: this.extractUpstreamRequestId(input.upstreamHeaders),
      upstreamRay: this.normalizeHeaderValue(input.upstreamHeaders['cf-ray']),
    })
  }

  private logWsRejected(
    trace: HttpTraceContext,
    input: {
      accountId?: string | null
      authMode?: UpstreamAuthMode
      forceAccountId?: string | null
      hasStickySessionKey?: boolean
      responseBody?: Buffer
      retryCount?: number
      internalCode?: RelayErrorCode
      routeAuthStrategy: RouteAuthStrategy | null
      statusCode: number
      statusText: string
      upstreamHeaders?: IncomingHttpHeaders
      error: string
    },
  ): void {
    const retryAfterSeconds = input.upstreamHeaders
      ? this.parseRetryAfterSeconds(input.upstreamHeaders)
      : undefined
    const rateLimitStatus = input.upstreamHeaders
      ? extractRateLimitInfoFromErrorResponse({
          statusCode: input.statusCode,
          headers: input.upstreamHeaders,
          body: input.responseBody,
        }).status
      : null
    const sameRequestMigrationEligible =
      Boolean(input.hasStickySessionKey) &&
      (input.retryCount ?? 0) < 2 &&
      this.shouldRetryWithSessionMigration(
        input.statusCode,
        rateLimitStatus,
        retryAfterSeconds,
      )

    this.safeLog({
      event: 'ws_rejected',
      requestId: trace.requestId,
      method: trace.method,
      target: trace.target,
      accountId: input.accountId ?? null,
      authMode: input.authMode,
      durationMs: Date.now() - trace.startedAt,
      error: input.error,
      forceAccountId: input.forceAccountId ?? null,
      hasStickySessionKey: input.hasStickySessionKey,
      internalCode: input.internalCode ?? fallbackRelayErrorCode(input.statusCode),
      rateLimitStatus,
      retryAfterSeconds: retryAfterSeconds ?? null,
      sameRequestMigrationEligible,
      retryCount: input.retryCount ?? 0,
      routeAuthStrategy: input.routeAuthStrategy ?? undefined,
      statusCode: input.statusCode,
      statusText: input.statusText,
      upstreamRequestId: input.upstreamHeaders
        ? this.extractUpstreamRequestId(input.upstreamHeaders)
        : null,
      upstreamRay: input.upstreamHeaders
        ? this.normalizeHeaderValue(input.upstreamHeaders['cf-ray'])
        : null,
    })
  }

  private logWsClosed(
    trace: HttpTraceContext,
    input: {
      accountId: string | null
      authMode: UpstreamAuthMode
      closeCode: number
      error?: string
      forceAccountId: string | null
      hasStickySessionKey: boolean
      retryCount: number
      routeAuthStrategy: RouteAuthStrategy
      upstreamHeaders: IncomingHttpHeaders
    },
  ): void {
    this.safeLog({
      event: 'ws_closed',
      requestId: trace.requestId,
      method: trace.method,
      target: trace.target,
      accountId: input.accountId,
      authMode: input.authMode,
      closeCode: input.closeCode,
      durationMs: Date.now() - trace.startedAt,
      error: input.error,
      forceAccountId: input.forceAccountId,
      hasStickySessionKey: input.hasStickySessionKey,
      retryCount: input.retryCount,
      routeAuthStrategy: input.routeAuthStrategy,
      statusCode: 101,
      statusText: STATUS_CODES[101] ?? 'Switching Protocols',
      upstreamRequestId: this.extractUpstreamRequestId(input.upstreamHeaders),
      upstreamRay: this.normalizeHeaderValue(input.upstreamHeaders['cf-ray']),
    })
  }

  private extractUpstreamRequestId(headers: IncomingHttpHeaders): string | null {
    return (
      this.normalizeHeaderValue(headers['x-last-request-id']) ??
      this.normalizeHeaderValue(headers['request-id']) ??
      this.normalizeHeaderValue(headers['x-request-id'])
    )
  }

  private createBodyCapture(body: RelayRequestBody): RelayCaptureEvent['incomingBody'] {
    const payload = Buffer.isBuffer(body) ? body : EMPTY_BODY
    const previewBuffer = payload.subarray(0, appConfig.relayCaptureBodyMaxBytes)

    return {
      length: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      utf8Preview: payload.length > 0 ? previewBuffer.toString('utf8') : null,
      truncated: previewBuffer.length < payload.length,
    }
  }

  private logBodyRewriteMetrics(input: {
    trace: HttpTraceContext
    stage: 'body_template' | 'session_route'
    accountId: string | null
    clientVersion: [number, number, number]
    template: BodyTemplate | null
    originalBody: RelayRequestBody
    rewrittenBody: RelayRequestBody
    handoffInjected?: boolean
  }): void {
    if (!Buffer.isBuffer(input.originalBody) || !Buffer.isBuffer(input.rewrittenBody)) {
      return
    }

    const originalBytes = input.originalBody.length
    const rewrittenBytes = input.rewrittenBody.length
    const bodyChanged =
      originalBytes !== rewrittenBytes || !input.originalBody.equals(input.rewrittenBody)
    if (input.stage === 'session_route' && !bodyChanged && !input.handoffInjected) {
      return
    }

    const metrics = this.extractStructuredBodyMetrics(input.rewrittenBody)
    this.safeLog({
      event: 'body_rewrite_metrics',
      requestId: input.trace.requestId,
      method: input.trace.method,
      target: input.trace.target,
      accountId: input.accountId,
      durationMs: Date.now() - input.trace.startedAt,
      stage: input.stage,
      clientVersion: input.clientVersion.join('.'),
      templateVersion: input.template?.ccVersion ?? null,
      originalBodyBytes: originalBytes,
      rewrittenBodyBytes: rewrittenBytes,
      deltaBodyBytes: rewrittenBytes - originalBytes,
      systemBlockCount: metrics.systemBlockCount,
      messageCount: metrics.messageCount,
      toolCount: metrics.toolCount,
      systemBytes: metrics.systemBytes,
      messagesBytes: metrics.messagesBytes,
      toolsBytes: metrics.toolsBytes,
      handoffInjected: input.handoffInjected ?? null,
    })
  }

  private extractStructuredBodyMetrics(body: Buffer): {
    systemBlockCount: number | null
    messageCount: number | null
    toolCount: number | null
    systemBytes: number | null
    messagesBytes: number | null
    toolsBytes: number | null
  } {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as {
        system?: unknown
        messages?: unknown
        tools?: unknown
      }
      return {
        systemBlockCount: Array.isArray(parsed.system) ? parsed.system.length : null,
        messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : null,
        toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : null,
        systemBytes: parsed.system === undefined ? null : Buffer.byteLength(JSON.stringify(parsed.system), 'utf8'),
        messagesBytes: parsed.messages === undefined ? null : Buffer.byteLength(JSON.stringify(parsed.messages), 'utf8'),
        toolsBytes: parsed.tools === undefined ? null : Buffer.byteLength(JSON.stringify(parsed.tools), 'utf8'),
      }
    } catch {
      return {
        systemBlockCount: null,
        messageCount: null,
        toolCount: null,
        systemBytes: null,
        messagesBytes: null,
        toolsBytes: null,
      }
    }
  }

  private serializeHeaderPairs(pairs: HeaderPair[]): string[] {
    return pairs.flatMap(([name, value]) => [name, this.sanitizeHeaderValue(name, value)])
  }

  private diffHeaderPairs(
    incomingPairs: HeaderPair[],
    upstreamPairs: HeaderPair[],
  ): HeaderDiff {
    const incomingMap = this.groupHeaderPairs(incomingPairs)
    const upstreamMap = this.groupHeaderPairs(upstreamPairs)
    const names = new Set([...incomingMap.keys(), ...upstreamMap.keys()])
    const added: RelayCaptureEvent['addedHeaders'] = []
    const changed: RelayCaptureEvent['changedHeaders'] = []
    const removed: RelayCaptureEvent['removedHeaders'] = []

    for (const name of [...names].sort()) {
      const incomingValues = incomingMap.get(name)
      const upstreamValues = upstreamMap.get(name)

      if (!incomingValues && upstreamValues) {
        added.push({
          name,
          values: upstreamValues.map((value) => this.sanitizeHeaderValue(name, value)),
        })
        continue
      }

      if (incomingValues && !upstreamValues) {
        removed.push({
          name,
          values: incomingValues.map((value) => this.sanitizeHeaderValue(name, value)),
        })
        continue
      }

      if (
        incomingValues &&
        upstreamValues &&
        !this.areStringArraysEqual(incomingValues, upstreamValues)
      ) {
        changed.push({
          name,
          incomingValues: incomingValues.map((value) => this.sanitizeHeaderValue(name, value)),
          upstreamValues: upstreamValues.map((value) => this.sanitizeHeaderValue(name, value)),
        })
      }
    }

    return {
      added,
      changed,
      removed,
    }
  }

  private groupHeaderPairs(pairs: HeaderPair[]): Map<string, string[]> {
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

  private flattenRawHeaders(rawHeaders: string[]): HeaderPair[] {
    return getHeaderPairs(rawHeaders, {})
  }

  private sanitizeHeaderValue(name: string, value: string): string {
    const normalized = name.toLowerCase()
    if (!SENSITIVE_CAPTURE_HEADERS.has(normalized)) {
      return value
    }

    const trimmed = value.trim()
    const schemeMatch = trimmed.match(/^([A-Za-z]+)\s+/)
    const schemePrefix = schemeMatch ? `${schemeMatch[1]} ` : ''
    const digest = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16)
    return `${schemePrefix}<redacted sha256=${digest} len=${trimmed.length}>`
  }

  private areStringArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false
    }

    return left.every((value, index) => value === right[index])
  }

  private safeLog(event: Parameters<RelayLogger['log']>[0]): void {
    try {
      this.logger.log(event)
    } catch {
      // logging must never affect relay behavior
    }
  }

  private safeLogCapture(event: RelayCaptureEvent): void {
    if (!this.logger.logCapture) {
      return
    }

    try {
      this.logger.logCapture(event)
    } catch {
      // logging must never affect relay behavior
    }
  }
}

function normalizeWebSocketCloseReason(reason: string | Buffer | undefined): string | undefined {
  if (!reason) {
    return undefined
  }

  let text = Buffer.isBuffer(reason) ? reason.toString('utf8') : reason
  if (!text) {
    return undefined
  }

  while (Buffer.byteLength(text, 'utf8') > 123) {
    text = text.slice(0, -1)
  }

  return text || undefined
}

function resolveOpenAIRateLimitResetTimestamp(
  rateLimitHeaders: {
    requestResetSeconds: number | null
    tokenResetSeconds: number | null
  },
  fallback: number | null,
): number | null {
  const resetSeconds = [rateLimitHeaders.requestResetSeconds, rateLimitHeaders.tokenResetSeconds]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  if (resetSeconds.length === 0) {
    return fallback ?? null
  }
  return Date.now() + Math.min(...resetSeconds) * 1000
}

function toUpstreamWebSocketError(error: unknown): UpstreamWebSocketError {
  if (error instanceof UpstreamWebSocketError) {
    return error
  }

  if (error instanceof SchedulerCapacityError) {
    return new UpstreamWebSocketError(
      'Service is at capacity. Please try again later.',
      529,
    )
  }

  if (error instanceof RoutingGuardError) {
    return new UpstreamWebSocketError(error.message, 429)
  }

  const clientError = classifyClientFacingRelayError(error)
  if (clientError) {
    return new UpstreamWebSocketError(clientError.message, clientError.statusCode)
  }

  return new UpstreamWebSocketError('Upstream request failed.', 502)
}

function getHeaderPairs(
  rawHeaders: string[] | undefined,
  headers: IncomingHttpHeaders,
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
  for (const [rawName, rawValue] of Object.entries(headers)) {
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

function collapseIncomingHeaders(rawHeaders: string[]): IncomingHttpHeaders {
  const collapsed: IncomingHttpHeaders = {}

  for (let index = 0; index < rawHeaders.length - 1; index += 2) {
    const rawName = rawHeaders[index]
    const rawValue = rawHeaders[index + 1]
    if (typeof rawName !== 'string' || typeof rawValue !== 'string') {
      continue
    }

    const name = rawName.toLowerCase()
    const existing = collapsed[name]
    if (existing === undefined) {
      collapsed[name] = name === 'set-cookie'
        ? [rawValue]
        : rawValue
      continue
    }

    if (Array.isArray(existing)) {
      existing.push(rawValue)
      continue
    }

    collapsed[name] = name === 'cookie'
      ? `${existing}; ${rawValue}`
      : `${existing}, ${rawValue}`
  }

  return collapsed
}

function hasPerMessageDeflateExtension(extensions: string): boolean {
  return /(?:^|,)\s*permessage-deflate(?:\s*;|$)/i.test(extensions)
}
