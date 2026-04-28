import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import test from 'node:test'

import WebSocket, { WebSocketServer, type RawData } from 'ws'

import {
  resolveBillingLineItem,
  type BillingRule,
} from '../billing/engine.js'
import { MemoryUserStore } from '../testHelpers/fakes.js'
import type { RelayUser, StoredAccount } from '../types.js'
import type { UsageRecord } from '../usage/usageStore.js'
import type { BodyTemplate } from './bodyRewriter.js'
import type { RelayCaptureEvent, RelayLogEvent } from './relayLogger.js'

type RequestRecord = {
  headers: IncomingMessage['headers']
  path: string
  rawHeaders?: string[]
  body?: Buffer
}

type BufferedRequestContext = {
  body: Buffer
  req: IncomingMessage
  res: ServerResponse
  url: URL
}

function assertOpenAIErrorBody(
  body: string,
  expected: {
    code: string
    messagePattern?: RegExp
    type?: string
  },
): void {
  const parsed = JSON.parse(body) as {
    type?: unknown
    error?: {
      message?: unknown
      type?: unknown
      code?: unknown
      internal_code?: unknown
    }
  }
  assert.equal(parsed.type, undefined)
  assert.equal(typeof parsed.error?.message, 'string')
  assert.equal(typeof parsed.error?.type, 'string')
  assert.equal(parsed.error?.code, expected.code)
  assert.equal(parsed.error?.internal_code, undefined)
  if (expected.type) {
    assert.equal(parsed.error?.type, expected.type)
  }
  if (expected.messagePattern) {
    assert.match(String(parsed.error?.message), expected.messagePattern)
  }
}

// Set by test setup, used by buildStoredAccount to assign per-account proxies
const testProxyUrls: Record<string, string> = {}

test('RelayService WebSocket integration', async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'claude-oauth-relay-test-'))
  const upstreamRecords: {
    http: RequestRecord[]
    sessionIngress: RequestRecord[]
    environmentPoll: RequestRecord[]
    caCert: RequestRecord[]
    sessions: RequestRecord[]
    voiceStream: RequestRecord[]
    upstreamproxy: RequestRecord[]
    oauthTokenGrants: string[]
  } = {
    http: [],
    sessionIngress: [],
    environmentPoll: [],
    caCert: [],
    sessions: [],
    voiceStream: [],
    upstreamproxy: [],
    oauthTokenGrants: [],
  }
  const proxyRecords: {
    http: RequestRecord[]
    ws: RequestRecord[]
  } = {
    http: [],
    ws: [],
  }
  const relayLogs: RelayLogEvent[] = []
  const relayCaptures: RelayCaptureEvent[] = []
  const usageRecords: UsageRecord[] = []
  const usageRecordsById = new Map<number, UsageRecord>()
  const resellerUsersById = new Map<string, RelayUser>()
  const resellerLegacyApiKeys = new Map<string, string>()
  const relayUserLookupTrace: Array<{
    source: 'relay_api_keys' | 'relay_users_legacy'
    token: string
  }> = []
  const resellerApiKeysById = new Map<string, {
    id: string
    userId: string
    name: string
    keyPreview: string
    lastUsedAt: string | null
    revokedAt: string | null
    createdAt: string
    apiKey: string
  }>()
  const resellerApiKeyIdByValue = new Map<string, string>()
  const resellerBillingRules: BillingRule[] = []
  const resellerBillingBalances = new Map<string, {
    balanceMicros: bigint
    totalCreditedMicros: bigint
    totalDebitedMicros: bigint
    currency: 'USD' | 'CNY'
  }>()
  const resellerBillingLedger: Array<{
    id: string
    userId: string
    userName: string
    kind: string
    amountMicros: string
    currency: 'USD' | 'CNY'
    note: string | null
    usageRecordId: number | null
    requestId: string | null
    createdAt: string
    updatedAt: string
  }> = []
  const resellerBillingLineItems = new Map<number, {
    usageRecordId: number
    requestId: string
    userId: string
    userName: string | null
    accountId: string | null
    provider: string | null
    model: string | null
    target: string
    currency: 'USD' | 'CNY'
    status: string
    matchedRuleId: string | null
    matchedRuleName: string | null
    amountMicros: string
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    usageCreatedAt: string
    updatedAt: string
  }>()
  let nextUsageRecordId = 1
  let nextResellerUserId = 1
  let nextResellerLegacyKeyId = 1
  let nextResellerApiKeyId = 1
  let nextResellerBillingRuleId = 1
  let nextResellerLedgerEntryId = 1
  let usageInsertError: Error | null = null
  let relayService: any = null
  let handleMessageRequest = ({ res }: BufferedRequestContext): void => {
    res.setHeader('request-id', 'http-upstream-1')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  }
  let handleOAuthTokenRequest = ({ res }: BufferedRequestContext): void => {
    res.statusCode = 404
    res.end('not found')
  }
  let handleSessionIngressRequest = ({ res }: BufferedRequestContext): void => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  }
  let handleEnvironmentPollRequest = ({ res }: BufferedRequestContext): void => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'work-1', data: { type: 'noop' } }))
  }
  let handleCaCertRequest = ({ res }: BufferedRequestContext): void => {
    res.setHeader('content-type', 'application/x-pem-file')
    res.end('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n')
  }
  let handleSessionWebSocketUpgrade = (_input: {
    req: IncomingMessage
    socket: Duplex
    head: Buffer
    url: URL
  }): boolean => false

  const sessionWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true,
    handleProtocols(protocols) {
      return protocols.has('proto-b') ? 'proto-b' : false
    },
  })
  const upstreamProxyWss = new WebSocketServer({ noServer: true })

  const upstreamServer = createHttpServer((_req, res) => {
    const url = new URL(_req.url ?? '/', 'http://127.0.0.1')
    if (
      url.pathname === '/v1/messages' ||
      url.pathname === '/v1/messages/count_tokens' ||
      url.pathname === '/chat/completions' ||
      url.pathname.endsWith('/responses')
    ) {
      const chunks: Buffer[] = []
      _req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      _req.on('end', () => {
        const body = Buffer.concat(chunks)
        upstreamRecords.http.push({
          headers: _req.headers,
          rawHeaders: _req.rawHeaders,
          path: url.pathname + url.search,
          body,
        })
        handleMessageRequest({
          body,
          req: _req,
          res,
          url,
        })
      })
      return
    }
    if (url.pathname === '/v1/oauth/token') {
      const chunks: Buffer[] = []
      _req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      _req.on('end', () => {
        const body = Buffer.concat(chunks)
        upstreamRecords.oauthTokenGrants.push(body.toString('utf8'))
        handleOAuthTokenRequest({
          body,
          req: _req,
          res,
          url,
        })
      })
      return
    }
    if (url.pathname === '/v1/session_ingress/session/test-session') {
      const chunks: Buffer[] = []
      _req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      _req.on('end', () => {
        const body = Buffer.concat(chunks)
        upstreamRecords.sessionIngress.push({
          headers: _req.headers,
          rawHeaders: _req.rawHeaders,
          path: url.pathname + url.search,
          body,
        })
        handleSessionIngressRequest({
          body,
          req: _req,
          res,
          url,
        })
      })
      return
    }
    if (url.pathname === '/v1/environments/env-1/work/poll') {
      const chunks: Buffer[] = []
      _req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      _req.on('end', () => {
        const body = Buffer.concat(chunks)
        upstreamRecords.environmentPoll.push({
          headers: _req.headers,
          rawHeaders: _req.rawHeaders,
          path: url.pathname + url.search,
          body,
        })
        handleEnvironmentPollRequest({
          body,
          req: _req,
          res,
          url,
        })
      })
      return
    }
    if (url.pathname === '/v1/code/upstreamproxy/ca-cert') {
      const chunks: Buffer[] = []
      _req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      _req.on('end', () => {
        const body = Buffer.concat(chunks)
        upstreamRecords.caCert.push({
          headers: _req.headers,
          rawHeaders: _req.rawHeaders,
          path: url.pathname + url.search,
          body,
        })
        handleCaCertRequest({
          body,
          req: _req,
          res,
          url,
        })
      })
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  upstreamServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (/^\/v1\/sessions\/ws\/[^/]+\/subscribe$/.test(url.pathname)) {
      if (handleSessionWebSocketUpgrade({ req, socket, head, url })) {
        return
      }
      upstreamRecords.sessions.push({
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        path: url.pathname + url.search,
      })
      const onHeaders = (headers: string[], request: IncomingMessage) => {
        if (request !== req) {
          return
        }
        headers.push('cf-ray: upstream-ray-1')
        headers.push('cf-mitigated: challenge')
        headers.push('x-last-request-id: upstream-last-1')
        sessionWss.off('headers', onHeaders)
      }
      sessionWss.on('headers', onHeaders)
      sessionWss.handleUpgrade(req, socket, head, (ws) => {
        sessionWss.off('headers', onHeaders)
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('session-hello')
          }
        }, 5)
      })
      return
    }

    if (url.pathname === '/v1/code/upstreamproxy/ws') {
      upstreamRecords.upstreamproxy.push({ headers: req.headers, path: url.pathname })
      upstreamProxyWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data, isBinary) => {
          ws.send(normalizeRawData(data, isBinary))
        })
      })
      return
    }

    if (url.pathname === '/api/ws/speech_to_text/voice_stream') {
      upstreamRecords.voiceStream.push({ headers: req.headers, path: url.pathname + url.search })
      const body = Buffer.from(JSON.stringify({
        error: 'cf_challenge',
        message: 'cloudflare challenge',
      }))
      socket.write(
        Buffer.from(
          [
            'HTTP/1.1 403 Forbidden',
            'Connection: close',
            'Content-Type: application/json; charset=utf-8',
            'cf-ray: voice-ray-1',
            'cf-mitigated: challenge',
            'x-last-request-id: upstream-last-voice-1',
            `Content-Length: ${body.length}`,
            '',
            '',
          ].join('\r\n'),
          'utf8',
        ),
      )
      socket.write(body)
      socket.destroy()
      return
    }

    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })

  let relayHttpServer:
    | ReturnType<typeof createHttpServer>
    | null = null
  let proxy1: ReturnType<typeof createHttpServer> | null = null
  let proxy2: ReturnType<typeof createHttpServer> | null = null

  try {
    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => resolve())
    })

    const upstreamAddress = upstreamServer.address()
    assert.ok(upstreamAddress && typeof upstreamAddress !== 'string')
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`
    const upstreamBaseWsUrl = upstreamBaseUrl.replace(/^http/, 'ws')

    // Create per-account forward HTTP proxies
    const { request: undiciRequest } = await import('undici')
    function createForwardProxy(): ReturnType<typeof createHttpServer> {
      const proxyWss = new WebSocketServer({ noServer: true })
      const server = createHttpServer(async (req, res) => {
        // HTTP proxy: req.url is absolute (e.g. http://127.0.0.1:PORT/v1/messages)
        const targetUrl = req.url!.startsWith('http') ? req.url! : `${upstreamBaseUrl}${req.url}`
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)
        proxyRecords.http.push({
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          path: targetUrl,
          body: body.length > 0 ? body : undefined,
        })
        try {
          const upstream = await undiciRequest(targetUrl, {
            method: req.method,
            headers: Object.fromEntries(
              Object.entries(req.headers).filter(([k]) => k !== 'host' && k !== 'proxy-connection'),
            ),
            body: body.length > 0 ? body : undefined,
          })
          res.writeHead(upstream.statusCode, upstream.headers as Record<string, string>)
          for await (const chunk of upstream.body) res.write(chunk)
          res.end()
        } catch (err) {
          res.writeHead(502)
          res.end(String(err))
        }
      })

      server.on('connect', (req, clientSocket, head) => {
        proxyRecords.http.push({
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          path: req.url ?? '',
        })

        const [targetHost = '', targetPortRaw] = (req.url ?? '').split(':')
        const upstreamSocket = net.createConnection({
          host: targetHost,
          port: targetPortRaw ? Number(targetPortRaw) : 80,
        })

        const destroyBoth = () => {
          if (!clientSocket.destroyed) clientSocket.destroy()
          if (!upstreamSocket.destroyed) upstreamSocket.destroy()
        }

        upstreamSocket.once('connect', () => {
          clientSocket.write(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n', 'utf8'))
          if (head.length > 0) {
            upstreamSocket.write(head)
          }
          clientSocket.pipe(upstreamSocket)
          upstreamSocket.pipe(clientSocket)
        })
        upstreamSocket.once('error', destroyBoth)
        clientSocket.once('error', destroyBoth)
      })

      server.on('upgrade', (req, socket, head) => {
        const rawUrl = req.url ?? '/'
        const targetUrl = rawUrl.startsWith('ws://') || rawUrl.startsWith('wss://')
          ? rawUrl
          : rawUrl.startsWith('http://')
            ? rawUrl.replace(/^http:/, 'ws:')
            : rawUrl.startsWith('https://')
              ? rawUrl.replace(/^https:/, 'wss:')
              : `${upstreamBaseWsUrl}${rawUrl}`

        proxyRecords.ws.push({
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          path: targetUrl,
        })

        const upstreamTarget = new URL(targetUrl)
        const targetPort = upstreamTarget.port
          ? Number(upstreamTarget.port)
          : upstreamTarget.protocol === 'wss:'
            ? 443
            : 80
        const requestLines = [
          `GET ${upstreamTarget.pathname}${upstreamTarget.search} HTTP/1.1`,
          ...toForwardProxyUpgradeHeaders(req.rawHeaders, upstreamTarget.host),
          '',
          '',
        ]
        const upstreamSocket = net.createConnection({
          host: upstreamTarget.hostname,
          port: targetPort,
        })

        const destroyBoth = () => {
          if (!socket.destroyed) socket.destroy()
          if (!upstreamSocket.destroyed) upstreamSocket.destroy()
        }

        upstreamSocket.once('connect', () => {
          upstreamSocket.write(Buffer.from(requestLines.join('\r\n'), 'utf8'))
          if (head.length > 0) {
            upstreamSocket.write(head)
          }
          socket.pipe(upstreamSocket)
          upstreamSocket.pipe(socket)
        })
        upstreamSocket.once('error', destroyBoth)
        socket.once('error', destroyBoth)
      })

      return server
    }

    proxy1 = createForwardProxy()
    proxy2 = createForwardProxy()
    await Promise.all([
      new Promise<void>((resolve) => proxy1!.listen(0, '127.0.0.1', () => resolve())),
      new Promise<void>((resolve) => proxy2!.listen(0, '127.0.0.1', () => resolve())),
    ])
    const proxy1Url = `http://127.0.0.1:${(proxy1!.address() as net.AddressInfo).port}`
    const proxy2Url = `http://127.0.0.1:${(proxy2!.address() as net.AddressInfo).port}`
    testProxyUrls['account-1'] = proxy1Url
    testProxyUrls['account-2'] = proxy2Url

    process.env.ADMIN_TOKEN = '1234567890abcdef'
    process.env.ADMIN_UI_SESSION_SECRET = '1234567890abcdef1234567890abcdef'
    process.env.DATABASE_URL = 'postgresql://unused@127.0.0.1:0/unused'
    process.env.ANTHROPIC_API_BASE_URL = upstreamBaseUrl
    process.env.OAUTH_TOKEN_URL = `${upstreamBaseUrl}/v1/oauth/token`
    process.env.UPSTREAM_PROXY_URL = proxy1Url
    process.env.HOST = '127.0.0.1'
    process.env.PORT = '3569'
    process.env.RELAY_LOG_ENABLED = 'false'
    process.env.BODY_TEMPLATE_PATH = './data/v2.1.98-body-template.json'
    process.env.BODY_TEMPLATE_NEW_PATH = './data/v2.1.112-body-template.json'
    process.env.VM_FINGERPRINT_TEMPLATE_PATH = './vm-fingerprint.template.json'

    const { appConfig } = await import('../config.js')
    const { MemoryTokenStore } = await import('../testHelpers/fakes.js')
    const { AccountScheduler } = await import('../scheduler/accountScheduler.js')
    const { FingerprintCache } = await import('../scheduler/fingerprintCache.js')
    const { AccountHealthTracker } = await import('../scheduler/healthTracker.js')
    const { ProxyPool } = await import('../scheduler/proxyPool.js')
    const { OAuthService } = await import('../oauth/service.js')
    const { RelayService } = await import('./relayService.js')
    const { createServer } = await import('../server.js')

    const tokenStore = new MemoryTokenStore({
      version: 3,
      accounts: [],
      stickySessions: [],
      proxies: [],
      routingGroups: [],
    })
    const seedAccounts = async (accounts: StoredAccount[]): Promise<void> => {
      await tokenStore.updateData(() => ({
        data: {
          version: 3,
          accounts,
          stickySessions: [],
          proxies: [],
          routingGroups: [],
        },
        result: undefined,
      }))
    }
    const primaryCreatedAt = '2024-01-01T00:00:00.000Z'
    const secondaryCreatedAt = '2024-02-01T00:00:00.000Z'

    const healthTracker = new AccountHealthTracker({
      windowMs: 5 * 60 * 1000,
      errorThreshold: 10,
    })
    const scheduler = new AccountScheduler(healthTracker, {
      defaultMaxSessions: 5,
      maxSessionOverflow: 1,
    })
    const fingerprintCache = new FingerprintCache()
    const proxyPool = new ProxyPool()
    const memoryUserStore = new MemoryUserStore() as MemoryUserStore & {
      getUserById(userId: string): Promise<RelayUser | null>
    }
    const baseAddUser = memoryUserStore.addUser.bind(memoryUserStore)
    memoryUserStore.addUser = (user: RelayUser): void => {
      const cloned = structuredClone(user)
      resellerUsersById.set(cloned.id, cloned)
      if (cloned.apiKey) {
        resellerLegacyApiKeys.set(cloned.id, cloned.apiKey)
      }
      baseAddUser(cloned)
    }
    const baseGetUserByApiKey = memoryUserStore.getUserByApiKey.bind(memoryUserStore)
    memoryUserStore.getUserByApiKey = (apiKey: string): RelayUser | null => {
      relayUserLookupTrace.push({ source: 'relay_users_legacy', token: apiKey })
      return baseGetUserByApiKey(apiKey)
    }
    memoryUserStore.getUserById = async (userId: string): Promise<RelayUser | null> => (
      structuredClone(resellerUsersById.get(userId) ?? null)
    )
    const maskResellerApiKey = (apiKey: string): string => (
      apiKey.length <= 14
        ? apiKey
        : `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`
    )
    const resellerApiKeyStore = {
      async lookupByKey(apiKey: string): Promise<{ keyId: string; userId: string } | null> {
        relayUserLookupTrace.push({ source: 'relay_api_keys', token: apiKey })
        const keyId = resellerApiKeyIdByValue.get(apiKey)
        const stored = keyId ? resellerApiKeysById.get(keyId) : null
        if (!stored || stored.revokedAt) {
          return null
        }
        return { keyId: stored.id, userId: stored.userId }
      },
      touchLastUsed(keyId: string): void {
        const stored = resellerApiKeysById.get(keyId)
        if (!stored || stored.revokedAt) {
          return
        }
        stored.lastUsedAt = new Date().toISOString()
      },
      async listForUser(userId: string) {
        return [...resellerApiKeysById.values()]
          .filter((item) => item.userId === userId && item.revokedAt === null)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(({ apiKey: _apiKey, ...rest }) => structuredClone(rest))
      },
      async create(userId: string, options: { name?: string } = {}) {
        const createdAt = new Date().toISOString()
        const keyIndex = nextResellerApiKeyId++
        const id = `relay-api-key-${keyIndex}`
        const apiKey = `rk_test_hashed_${String(keyIndex).padStart(4, '0')}`
        const record = {
          id,
          userId,
          name: options.name?.trim() || `Key ${createdAt.slice(0, 10)}`,
          keyPreview: maskResellerApiKey(apiKey),
          lastUsedAt: null,
          revokedAt: null,
          createdAt,
          apiKey,
        }
        resellerApiKeysById.set(id, record)
        resellerApiKeyIdByValue.set(apiKey, id)
        return structuredClone(record)
      },
    }
    const buildResellerBalanceSummary = (userId: string) => {
      const user = resellerUsersById.get(userId)
      if (!user) {
        return null
      }
      const existing = resellerBillingBalances.get(userId) ?? {
        balanceMicros: 0n,
        totalCreditedMicros: 0n,
        totalDebitedMicros: 0n,
        currency: user.billingCurrency,
      }
      resellerBillingBalances.set(userId, existing)
      return {
        userId,
        userName: user.name,
        balanceMicros: existing.balanceMicros.toString(),
        totalCreditedMicros: existing.totalCreditedMicros.toString(),
        totalDebitedMicros: existing.totalDebitedMicros.toString(),
        currency: existing.currency,
        billingCurrency: user.billingCurrency,
      }
    }
    const resellerBillingStore = {
      async assertUserCanConsume(userId: string): Promise<void> {
        const user = resellerUsersById.get(userId)
        if (!user || user.billingMode !== 'prepaid') {
          return
        }
        const balance = buildResellerBalanceSummary(userId)
        if (balance && BigInt(balance.balanceMicros) > 0n) {
          return
        }
        throw new Error(`Prepaid balance exhausted for ${user.name}. Please top up and retry.`)
      },
      async assertUserCurrencyChangeAllowed(userId: string, nextCurrency: 'USD' | 'CNY'): Promise<void> {
        const current = buildResellerBalanceSummary(userId)
        if (!current) {
          return
        }
        if (current.billingCurrency === nextCurrency) {
          return
        }
        if (BigInt(current.balanceMicros) !== 0n) {
          throw new Error('Cannot change billingCurrency while balance is non-zero')
        }
        if (BigInt(current.totalDebitedMicros) !== 0n) {
          throw new Error('Cannot change billingCurrency after billing history exists')
        }
      },
      async getUserBalanceSummary(userId: string) {
        return buildResellerBalanceSummary(userId)
      },
      async createLedgerEntry(input: {
        userId: string
        kind: 'topup' | 'manual_adjustment' | 'usage_debit'
        amountMicros: string
        note?: string | null
      }) {
        const summary = buildResellerBalanceSummary(input.userId)
        if (!summary) {
          throw new Error('User not found')
        }
        const state = resellerBillingBalances.get(input.userId)!
        const amountMicros = BigInt(String(input.amountMicros))
        state.balanceMicros += amountMicros
        if (amountMicros >= 0n) {
          state.totalCreditedMicros += amountMicros
        } else {
          state.totalDebitedMicros += -amountMicros
        }
        const nowIso = new Date().toISOString()
        const entry = {
          id: `billing-ledger-${nextResellerLedgerEntryId++}`,
          userId: input.userId,
          userName: summary.userName,
          kind: input.kind,
          amountMicros: amountMicros.toString(),
          currency: summary.currency,
          note: input.note ?? null,
          usageRecordId: null,
          requestId: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        resellerBillingLedger.unshift(entry)
        return {
          entry: structuredClone(entry),
          balance: buildResellerBalanceSummary(input.userId),
        }
      },
      async listRules(currency?: 'USD' | 'CNY' | null) {
        return resellerBillingRules
          .filter((rule) => !currency || rule.currency === currency)
          .map((rule) => structuredClone(rule))
      },
      async createRule(input: {
        name?: string | null
        currency?: 'USD' | 'CNY'
        isActive?: boolean
        priority?: number
        provider?: string | null
        accountId?: string | null
        userId?: string | null
        model?: string | null
        effectiveFrom?: string | null
        effectiveTo?: string | null
        inputPriceMicrosPerMillion?: string
        outputPriceMicrosPerMillion?: string
        cacheCreationPriceMicrosPerMillion?: string
        cacheReadPriceMicrosPerMillion?: string
      }): Promise<BillingRule> {
        const nowIso = new Date().toISOString()
        const rule: BillingRule = {
          id: `billing-rule-${nextResellerBillingRuleId++}`,
          name: input.name ?? `rule-${nextResellerBillingRuleId}`,
          isActive: input.isActive ?? true,
          priority: Number(input.priority ?? 0),
          currency: input.currency ?? 'CNY',
          provider: input.provider ?? null,
          accountId: input.accountId ?? null,
          userId: input.userId ?? null,
          model: input.model ?? null,
          effectiveFrom: input.effectiveFrom ?? '2026-01-01T00:00:00.000Z',
          effectiveTo: input.effectiveTo ?? null,
          inputPriceMicrosPerMillion: String(input.inputPriceMicrosPerMillion ?? '0'),
          outputPriceMicrosPerMillion: String(input.outputPriceMicrosPerMillion ?? '0'),
          cacheCreationPriceMicrosPerMillion: String(input.cacheCreationPriceMicrosPerMillion ?? '0'),
          cacheReadPriceMicrosPerMillion: String(input.cacheReadPriceMicrosPerMillion ?? '0'),
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        resellerBillingRules.push(rule)
        return structuredClone(rule)
      },
      async preflightBillableRequest(input: {
        userId: string
        billingCurrency: 'USD' | 'CNY'
        accountId: string | null
        provider: string | null
        model: string | null
        target: string
      }) {
        if (resellerBillingRules.length === 0) {
          return { ok: true, status: 'billed' as const }
        }
        const resolved = resolveBillingLineItem({
          usageRecordId: 0,
          requestId: 'preflight',
          userId: input.userId,
          userName: null,
          billingCurrency: input.billingCurrency,
          accountId: input.accountId,
          provider: input.provider,
          model: input.model,
          sessionKey: null,
          clientDeviceId: null,
          target: input.target,
          inputTokens: 1,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          statusCode: 200,
          createdAt: new Date().toISOString(),
        }, resellerBillingRules)
        if (resolved.status !== 'billed') {
          return {
            ok: false,
            status: 'missing_rule' as const,
            matchedRuleId: resolved.matchedRuleId,
            matchedRuleName: resolved.matchedRuleName,
          }
        }
        if (BigInt(resolved.amountMicros) <= 0n) {
          return {
            ok: false,
            status: 'zero_price' as const,
            matchedRuleId: resolved.matchedRuleId,
            matchedRuleName: resolved.matchedRuleName,
          }
        }
        return {
          ok: true,
          status: 'billed' as const,
          matchedRuleId: resolved.matchedRuleId,
          matchedRuleName: resolved.matchedRuleName,
        }
      },
      async syncUsageRecordById(usageRecordId: number) {
        const record = usageRecordsById.get(usageRecordId)
        if (!record || !record.userId) {
          return { processed: 0, billed: 0, missingRule: 0, invalidUsage: 0, debitsCreated: 0 }
        }
        const user = resellerUsersById.get(record.userId)
        if (!user) {
          return { processed: 0, billed: 0, missingRule: 0, invalidUsage: 0, debitsCreated: 0 }
        }
        const resolved = resolveBillingLineItem({
          usageRecordId,
          requestId: record.requestId,
          userId: record.userId,
          userName: user.name,
          billingCurrency: user.billingCurrency,
          accountId: record.accountId,
          provider: null,
          model: record.model,
          sessionKey: record.sessionKey ?? null,
          clientDeviceId: record.clientDeviceId ?? null,
          target: record.target,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheCreationInputTokens: record.cacheCreationInputTokens,
          cacheReadInputTokens: record.cacheReadInputTokens,
          statusCode: record.statusCode,
          createdAt: new Date().toISOString(),
        }, resellerBillingRules)
        const previous = resellerBillingLineItems.get(usageRecordId)
        const nowIso = new Date().toISOString()
        resellerBillingLineItems.set(usageRecordId, {
          usageRecordId,
          requestId: record.requestId,
          userId: record.userId,
          userName: user.name,
          accountId: record.accountId,
          provider: null,
          model: record.model,
          target: record.target,
          currency: resolved.currency,
          status: resolved.status,
          matchedRuleId: resolved.matchedRuleId,
          matchedRuleName: resolved.matchedRuleName,
          amountMicros: resolved.amountMicros,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheCreationInputTokens: record.cacheCreationInputTokens,
          cacheReadInputTokens: record.cacheReadInputTokens,
          usageCreatedAt: nowIso,
          updatedAt: nowIso,
        })
        if (resolved.status !== 'billed') {
          return {
            processed: 1,
            billed: 0,
            missingRule: resolved.status === 'missing_rule' ? 1 : 0,
            invalidUsage: resolved.status === 'invalid_usage' ? 1 : 0,
            debitsCreated: 0,
          }
        }
        const nextAmount = BigInt(resolved.amountMicros)
        const previousAmount = previous?.status === 'billed' ? BigInt(previous.amountMicros) : 0n
        const delta = nextAmount - previousAmount
        if (delta !== 0n) {
          const state = resellerBillingBalances.get(record.userId) ?? {
            balanceMicros: 0n,
            totalCreditedMicros: 0n,
            totalDebitedMicros: 0n,
            currency: user.billingCurrency,
          }
          state.balanceMicros -= delta
          state.totalDebitedMicros += delta
          resellerBillingBalances.set(record.userId, state)
          resellerBillingLedger.unshift({
            id: `billing-ledger-${nextResellerLedgerEntryId++}`,
            userId: record.userId,
            userName: user.name,
            kind: 'usage_debit',
            amountMicros: (-delta).toString(),
            currency: user.billingCurrency,
            note: null,
            usageRecordId,
            requestId: record.requestId,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
        }
        return { processed: 1, billed: 1, missingRule: 0, invalidUsage: 0, debitsCreated: delta !== 0n ? 1 : 0 }
      },
      async syncLineItems() {
        let processed = 0
        let billed = 0
        let missingRule = 0
        let invalidUsage = 0
        let debitsCreated = 0
        for (const usageRecordId of [...usageRecordsById.keys()].sort((left, right) => left - right)) {
          const result = await this.syncUsageRecordById(usageRecordId)
          processed += result.processed
          billed += result.billed
          missingRule += result.missingRule
          invalidUsage += result.invalidUsage
          debitsCreated += result.debitsCreated
        }
        return { processed, billed, missingRule, invalidUsage, debitsCreated }
      },
      async getUserLineItems(
        userId: string,
        _since: Date | null,
        limit = 100,
        offset = 0,
      ) {
        const items = [...resellerBillingLineItems.values()]
          .filter((item) => item.userId === userId)
          .sort((left, right) => right.usageRecordId - left.usageRecordId)
        return {
          items: items.slice(offset, offset + limit).map((item) => structuredClone(item)),
          total: items.length,
        }
      },
    }
    const oauthService = new OAuthService(
      tokenStore,
      scheduler,
      fingerprintCache,
      memoryUserStore as never,
    )
    const usageStore = {
      insertRecord(record: UsageRecord) {
        if (usageInsertError) {
          return Promise.reject(usageInsertError)
        }
        const usageRecordId = nextUsageRecordId++
        const cloned = structuredClone(record)
        usageRecords.push(cloned)
        usageRecordsById.set(usageRecordId, cloned)
        return Promise.resolve(usageRecordId)
      },
    }
    const resetUpstreamState = (): void => {
      upstreamRecords.http.length = 0
      upstreamRecords.sessionIngress.length = 0
      upstreamRecords.environmentPoll.length = 0
      upstreamRecords.caCert.length = 0
      upstreamRecords.sessions.length = 0
      upstreamRecords.voiceStream.length = 0
      upstreamRecords.upstreamproxy.length = 0
      upstreamRecords.oauthTokenGrants.length = 0
      proxyRecords.http.length = 0
      proxyRecords.ws.length = 0
      proxyPool.evict(proxy1Url)
      proxyPool.evict(proxy2Url)
      healthTracker.clear()
      void memoryUserStore.clearSessionRoutes()
      relayHttpServer?.closeAllConnections()
      upstreamServer.closeAllConnections()
      proxy1?.closeAllConnections()
      proxy2?.closeAllConnections()
      relayLogs.length = 0
      relayCaptures.length = 0
      usageRecords.length = 0
      usageRecordsById.clear()
      resellerUsersById.clear()
      resellerLegacyApiKeys.clear()
      relayUserLookupTrace.length = 0
      resellerApiKeysById.clear()
      resellerApiKeyIdByValue.clear()
      resellerBillingRules.length = 0
      resellerBillingBalances.clear()
      resellerBillingLedger.length = 0
      resellerBillingLineItems.clear()
      nextUsageRecordId = 1
      nextResellerUserId = 1
      nextResellerLegacyKeyId = 1
      nextResellerApiKeyId = 1
      nextResellerBillingRuleId = 1
      nextResellerLedgerEntryId = 1
      usageInsertError = null
      if (relayService) {
        relayService.recentServerFailures.length = 0
        relayService.upstreamIncidentActiveUntil = 0
      }
      handleMessageRequest = ({ res }) => {
        res.setHeader('request-id', 'http-upstream-1')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      }
      handleOAuthTokenRequest = ({ res }) => {
        res.statusCode = 404
        res.end('not found')
      }
      handleSessionIngressRequest = ({ res }) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      }
      handleEnvironmentPollRequest = ({ res }) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'work-1', data: { type: 'noop' } }))
      }
      handleCaCertRequest = ({ res }) => {
        res.setHeader('content-type', 'application/x-pem-file')
        res.end('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n')
      }
      handleSessionWebSocketUpgrade = () => false
    }
    relayService = new RelayService(oauthService, proxyPool, healthTracker, {
      log(event) {
        relayLogs.push(event)
      },
      logCapture(event) {
        relayCaptures.push(event)
      },
    }, usageStore as never, memoryUserStore as never, resellerBillingStore as never, resellerApiKeyStore as never)
    const app = createServer({
      oauthService,
      relayService,
      userStore: memoryUserStore,
      apiKeyStore: resellerApiKeyStore,
      billingStore: resellerBillingStore,
      usageStore,
    })
    relayHttpServer = createHttpServer(app)
    relayHttpServer.on('upgrade', (req, socket, head) => {
      void relayService.handleUpgrade(req, socket, head)
    })

    await new Promise<void>((resolve) => {
      relayHttpServer!.listen(0, '127.0.0.1', () => resolve())
    })

    const relayAddress = relayHttpServer.address()
    assert.ok(relayAddress && typeof relayAddress !== 'string')
    const relayBaseWsUrl = `ws://127.0.0.1:${relayAddress.port}`

    await t.test('sessions ws injects account OAuth and forwards upgrade headers', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])
      const { queuedMessages, responseHeaders, ws } = await connectWebSocket(
        `${relayBaseWsUrl}/v1/sessions/ws/test-session/subscribe?organization_uuid=org-1`,
        {},
      )

      assert.equal(responseHeaders['x-last-request-id'], 'upstream-last-1')
      assert.equal(responseHeaders['cf-ray'], 'upstream-ray-1')
      assert.equal(responseHeaders['cf-mitigated'], 'challenge')
      const message = await waitForMessage(ws, queuedMessages)
      assert.equal(message, 'session-hello')

      const upstreamRequest = upstreamRecords.sessions.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(
        upstreamRequest.headers.authorization,
        'Bearer oauth-access-token',
      )
      const upstreamSessionMatch = upstreamRequest.path.match(
        /^\/v1\/sessions\/ws\/([^/]+)\/subscribe\?organization_uuid=org-1$/,
      )
      assert.ok(upstreamSessionMatch)
      assert.equal(
        upstreamRequest.headers['x-claude-code-session-id'],
        upstreamSessionMatch[1],
      )
      assert.equal(
        upstreamRequest.headers['x-claude-remote-session-id'],
        upstreamSessionMatch[1],
      )
      const proxiedRequest = proxyRecords.ws.at(-1)
      assert.ok(proxiedRequest)
      assert.equal(
        proxiedRequest.path,
        `${upstreamBaseWsUrl}${upstreamRequest.path}`,
      )

      ws.close(1000, 'done')
      await waitForClose(ws)
    })

    await t.test('sessions ws preserves incoming auth when client already sent it', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const { queuedMessages, ws } = await connectWebSocket(
        `${relayBaseWsUrl}/v1/sessions/ws/test-session/subscribe?organization_uuid=org-1`,
        {
          headers: {
            Authorization: 'Bearer incoming-session-ws-token',
          },
        },
      )

      const message = await waitForMessage(ws, queuedMessages)
      assert.equal(message, 'session-hello')

      const upstreamRequest = upstreamRecords.sessions.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(
        upstreamRequest.headers.authorization,
        'Bearer incoming-session-ws-token',
      )

      ws.close(1000, 'done')
      await waitForClose(ws)
    })

    await t.test('sessions ws preserves negotiated subprotocol and permessage-deflate', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const { queuedMessages, responseHeaders, ws } = await connectWebSocket(
        `${relayBaseWsUrl}/v1/sessions/ws/test-session/subscribe?organization_uuid=org-1`,
        {
          headers: {
            Authorization: 'Bearer incoming-session-ws-token',
          },
          perMessageDeflate: true,
          protocols: ['proto-a', 'proto-b'],
        },
      )

      assert.equal(ws.protocol, 'proto-b')
      assert.equal(ws.extensions, 'permessage-deflate')
      assert.equal(responseHeaders['sec-websocket-protocol'], 'proto-b')
      assert.equal(responseHeaders['sec-websocket-extensions'], 'permessage-deflate')

      const message = await waitForMessage(ws, queuedMessages)
      assert.equal(message, 'session-hello')

      ws.close(1000, 'done')
      await waitForClose(ws)
    })

    await t.test('sessions ws returns the original rate limit failure, then migrates on the next connection', async () => {
      const config = appConfig as { sameRequestSessionMigrationEnabled: boolean }
      const originalSameRequestMigrationEnabled = config.sameRequestSessionMigrationEnabled
      config.sameRequestSessionMigrationEnabled = false
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])
      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'ws-session-migrate-1',
        accountId: 'account-1',
      })

      const authAttempts: string[] = []
      handleSessionWebSocketUpgrade = ({ req, socket }) => {
        authAttempts.push(String(req.headers.authorization ?? ''))
        if (req.headers.authorization !== 'Bearer oauth-access-token-1') {
          return false
        }
        const body = Buffer.from(JSON.stringify({ error: { message: 'rate limited' } }))
        socket.write(
          Buffer.from(
            [
              'HTTP/1.1 429 Too Many Requests',
              'Connection: close',
              'Content-Type: application/json; charset=utf-8',
              'anthropic-ratelimit-unified-status: rejected',
              'anthropic-ratelimit-unified-5h-utilization: 1',
              'anthropic-ratelimit-unified-7d-utilization: 1',
              'anthropic-ratelimit-unified-reset: 1234567890',
              `Content-Length: ${body.length}`,
              '',
              '',
            ].join('\r\n'),
            'utf8',
          ),
        )
        socket.write(body)
        socket.destroy()
        return true
      }

      const failure = await connectWebSocketExpectFailure(
        `${relayBaseWsUrl}/v1/sessions/ws/test-session/subscribe?organization_uuid=org-1`,
        {
          'X-Claude-Code-Session-Id': 'ws-session-migrate-1',
        },
      )

      assert.equal(failure.statusCode, 429)
      assert.match(failure.body, /rate limited/i)
      assert.equal(upstreamRecords.sessions.length, 0)
      assert.deepEqual(authAttempts, ['Bearer oauth-access-token-1'])

      let route = await memoryUserStore.getSessionRoute('ws-session-migrate-1')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-1')
      assert.equal(route?.generation, 1)
      assert.match(route?.pendingHandoffSummary ?? '', /压缩背景/)
      assert.equal(route?.lastHandoffReason, 'rate_limit:rejected')

      const handoffs = await memoryUserStore.listSessionHandoffs()
      assert.equal(handoffs.length, 0)

      const retryFailureUsage = usageRecords.find((record) => record.attemptKind === 'retry_failure')
      assert.equal(retryFailureUsage, undefined)

      const finalUsage = usageRecords.find((record) => (record.attemptKind ?? 'final') === 'final')
      assert.ok(finalUsage)
      assert.equal(finalUsage?.accountId, 'account-1')
      assert.equal(finalUsage?.statusCode, 429)
      assert.equal(finalUsage?.target, '/v1/sessions/ws')

      const { queuedMessages, ws } = await connectWebSocket(
        `${relayBaseWsUrl}/v1/sessions/ws/test-session/subscribe?organization_uuid=org-1`,
        {
          headers: {
            'X-Claude-Code-Session-Id': 'ws-session-migrate-1',
          },
        },
      )

      try {
        const message = await waitForMessage(ws, queuedMessages)
        assert.equal(message, 'session-hello')
        assert.deepEqual(authAttempts, [
          'Bearer oauth-access-token-1',
          'Bearer oauth-access-token-2',
        ])

        route = await memoryUserStore.getSessionRoute('ws-session-migrate-1')
        assert.ok(route)
        assert.equal(route?.accountId, 'account-2')
        assert.equal(route?.generation, 2)
        assert.match(route?.pendingHandoffSummary ?? '', /压缩背景/)
        assert.equal(route?.lastHandoffReason, 'rate_limit:rejected')

        const [handoff] = await memoryUserStore.listSessionHandoffs()
        assert.ok(handoff)
        assert.equal(handoff.fromAccountId, 'account-1')
        assert.equal(handoff.toAccountId, 'account-2')
        assert.equal(handoff.reason, 'rate_limit:rejected')
      } finally {
        config.sameRequestSessionMigrationEnabled = originalSameRequestMigrationEnabled
        ws.close(1000, 'done')
        await waitForClose(ws)
      }
    })

    await t.test('sessions ws throttled failures with retry-after=0 migrate within the same connection', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])
      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'ws-session-retry-after-zero-1',
        accountId: 'account-1',
      })

      const authAttempts: string[] = []
      handleSessionWebSocketUpgrade = ({ req, socket }) => {
        authAttempts.push(String(req.headers.authorization ?? ''))
        if (req.headers.authorization !== 'Bearer oauth-access-token-1') {
          return false
        }
        const body = Buffer.from(JSON.stringify({ error: { message: 'rate limited' } }))
        socket.write(
          Buffer.from(
            [
              'HTTP/1.1 429 Too Many Requests',
              'Connection: close',
              'Content-Type: application/json; charset=utf-8',
              'Retry-After: 0',
              'anthropic-ratelimit-unified-status: throttled',
              `Content-Length: ${body.length}`,
              '',
              '',
            ].join('\r\n'),
            'utf8',
          ),
        )
        socket.write(body)
        socket.destroy()
        return true
      }

      const { queuedMessages, ws } = await connectWebSocket(
        `${relayBaseWsUrl}/v1/sessions/ws/test-session/subscribe?organization_uuid=org-1`,
        {
          headers: {
            'X-Claude-Code-Session-Id': 'ws-session-retry-after-zero-1',
          },
        },
      )

      try {
        const message = await waitForMessage(ws, queuedMessages)
        assert.equal(message, 'session-hello')
        assert.equal(authAttempts[0], 'Bearer oauth-access-token-1')
        assert.equal(authAttempts[1], 'Bearer oauth-access-token-2')

        const route = await memoryUserStore.getSessionRoute('ws-session-retry-after-zero-1')
        assert.ok(route)
        assert.equal(route?.accountId, 'account-2')
        assert.equal(route?.generation, 2)

        const [handoff] = await memoryUserStore.listSessionHandoffs()
        assert.ok(handoff)
        assert.equal(handoff.fromAccountId, 'account-1')
        assert.equal(handoff.toAccountId, 'account-2')
        assert.equal(handoff.reason, 'rate_limit:throttled')
      } finally {
        ws.close(1000, 'done')
        await waitForClose(ws)
      }
    })

    await t.test('sessions ws uses client device id header as affinity hint for new sessions', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      memoryUserStore.addUser({
        id: 'relay-user-ws-affinity',
        apiKey: 'rk_ws_affinity_test_key',
        name: 'ws-affinity-user',
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-13T00:00:00.000Z',
        updatedAt: '2026-04-13T00:00:00.000Z',
      })
      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'seed-session',
        userId: 'relay-user-ws-affinity',
        clientDeviceId: 'ws-device-1',
        accountId: 'account-2',
      })
      await memoryUserStore.noteSessionRouteUsage({
        sessionKey: 'seed-session',
        userId: 'relay-user-ws-affinity',
        clientDeviceId: 'ws-device-1',
        accountId: 'account-2',
      })

      const { queuedMessages, ws } = await connectWebSocket(
        `${relayBaseWsUrl}/v1/sessions/ws/ws-affinity-session/subscribe?organization_uuid=org-1`,
        {
          headers: {
            Authorization: 'Bearer rk_ws_affinity_test_key',
            'X-Client-Device-Id': 'ws-device-1',
          },
        },
      )

      const message = await waitForMessage(ws, queuedMessages)
      assert.equal(message, 'session-hello')
      assert.equal(
        upstreamRecords.sessions.at(-1)?.headers.authorization,
        'Bearer oauth-access-token-2',
      )

      const route = await memoryUserStore.getSessionRoute('ws-affinity-session')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-2')
      assert.equal(route?.clientDeviceId, 'ws-device-1')

      assert.equal(usageRecords.length, 1)
      assert.equal(usageRecords[0]?.target, '/v1/sessions/ws')
      assert.equal(usageRecords[0]?.statusCode, 101)
      assert.equal(usageRecords[0]?.userId, 'relay-user-ws-affinity')
      assert.equal(usageRecords[0]?.clientDeviceId, 'ws-device-1')

      ws.close(1000, 'done')
      await waitForClose(ws)
    })

    await t.test('http relay preserves body and allowed headers, drops non-allowlisted headers', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages?hello=world',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Custom-Trace: trace-1',
          'X-Custom-Trace: trace-2',
          'X-Another-Header: another',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(
        upstreamRequest.path,
        '/v1/messages?hello=world',
      )
      const proxiedRequest = proxyRecords.http.at(-1)
      assert.ok(proxiedRequest)
      assert.equal(proxiedRequest.path, new URL(upstreamBaseUrl).host)
      assert.deepEqual(upstreamRequest.body, body)
      assert.equal(
        getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'Authorization'),
        'Bearer incoming-client-token',
      )
      assert.deepEqual(
        getAllHeaderValues(upstreamRequest.rawHeaders ?? [], 'X-Custom-Trace'),
        [],
        'non-allowlisted header X-Custom-Trace should be dropped',
      )
      assert.equal(
        getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'X-Another-Header'),
        null,
        'non-allowlisted header X-Another-Header should be dropped',
      )
      assert.equal(
        getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'Content-Length'),
        String(body.length),
      )
    })

    await t.test('http relay can route /v1/chat/completions through openai-compatible accounts', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])

      handleMessageRequest = ({ body, req, res, url }) => {
        assert.equal(url.pathname, '/chat/completions')
        assert.equal(req.headers.authorization, 'Bearer openai-api-key')
        const parsed = JSON.parse(body.toString('utf8')) as {
          model: string
          stream: boolean
          messages: Array<{ role: string; content: string }>
        }
        assert.equal(parsed.model, 'gpt-4.1')
        assert.equal(parsed.stream, false)
        assert.equal(parsed.messages.at(-1)?.role, 'user')
        assert.equal(parsed.messages.at(-1)?.content, 'hi from openai client')

        res.setHeader('content-type', 'application/json')
        res.setHeader('x-request-id', 'openai-upstream-1')
        res.end(JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-4.1',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: 'hello from openai-compatible',
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
          },
        }))
      }

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [
          {
            role: 'user',
            content: 'hi from openai client',
          },
        ],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.match(response.headers['content-type'] ?? '', /^application\/json/)

      const parsed = JSON.parse(response.body) as {
        model: string
        choices: Array<{ message?: { content?: string } }>
        usage: { prompt_tokens: number; completion_tokens: number }
      }
      assert.equal(parsed.model, 'gpt-4.1')
      assert.equal(parsed.choices[0]?.message?.content, 'hello from openai-compatible')
      assert.equal(parsed.usage.prompt_tokens, 12)
      assert.equal(parsed.usage.completion_tokens, 4)

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(upstreamRequest.path, '/chat/completions')
      assert.equal(proxyRecords.http.length, 0)
    })

    await t.test('http relay returns OpenAI-style 405 errors for /v1/chat/completions', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
        ],
      })

      assert.equal(response.statusCode, 405, response.body)
      assert.equal(response.headers.allow, 'POST')
      assertOpenAIErrorBody(response.body, {
        code: 'COR_METHOD_NOT_ALLOWED',
        messagePattern: /Method GET is not allowed/,
        type: 'invalid_request_error',
      })
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('http relay returns OpenAI-style relay auth errors for /v1/chat/completions', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'hi' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Authorization: Bearer rk_invalid_openai_user_key',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 401, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_RELAY_USER_REJECTED',
        messagePattern: /Invalid relay API key/,
        type: 'authentication_error',
      })
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('runtime prefers relay_api_keys over legacy lookup when the same token exists in both stores', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])

      const sharedToken = 'rk_shared_runtime_lookup_priority'
      memoryUserStore.addUser({
        id: 'relay-user-legacy-shared',
        apiKey: sharedToken,
        name: 'legacy-shared-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })
      memoryUserStore.addUser({
        id: 'relay-user-primary-shared',
        apiKey: 'rk_primary_shared_legacy_placeholder',
        name: 'primary-shared-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: false,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })
      resellerApiKeysById.set('relay-api-key-shared', {
        id: 'relay-api-key-shared',
        userId: 'relay-user-primary-shared',
        name: 'Shared Primary Key',
        keyPreview: 'rk_shar...rity',
        lastUsedAt: null,
        revokedAt: null,
        createdAt: '2026-04-27T00:00:00.000Z',
        apiKey: sharedToken,
      })
      resellerApiKeyIdByValue.set(sharedToken, 'relay-api-key-shared')

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'shared token should hit apiKeyStore first' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Authorization: Bearer ${sharedToken}`,
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 401, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_RELAY_USER_REJECTED',
        messagePattern: /User is disabled/,
        type: 'authentication_error',
      })
      assert.deepEqual(
        relayUserLookupTrace.map((entry) => entry.source),
        ['relay_api_keys'],
      )
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('usage records expose relay_api_keys as the runtime key source on successful requests', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])

      const primaryToken = 'rk_test_runtime_primary_usage_source'
      memoryUserStore.addUser({
        id: 'relay-user-primary-usage-source',
        apiKey: 'rk_primary_usage_source_legacy_placeholder',
        name: 'primary-usage-source-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })
      resellerApiKeysById.set('relay-api-key-primary-usage-source', {
        id: 'relay-api-key-primary-usage-source',
        userId: 'relay-user-primary-usage-source',
        name: 'Primary Usage Source Key',
        keyPreview: 'rk_test...urce',
        lastUsedAt: null,
        revokedAt: null,
        createdAt: '2026-04-27T00:00:00.000Z',
        apiKey: primaryToken,
      })
      resellerApiKeyIdByValue.set(primaryToken, 'relay-api-key-primary-usage-source')
      await resellerBillingStore.createRule({
        name: 'primary-usage-source-rule',
        currency: 'CNY',
        model: 'gpt-4.1',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '1000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'apiKeyStore source should be recorded' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Authorization: Bearer ${primaryToken}`,
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(
        relayUserLookupTrace.map((entry) => entry.source),
        ['relay_api_keys'],
      )
      await waitForCondition(() => usageRecords.length === 1)
      assert.equal(usageRecords[0]?.userId, 'relay-user-primary-usage-source')
      assert.equal(usageRecords[0]?.relayKeySource, 'relay_api_keys')
      assert.equal(upstreamRecords.http.length, 1)
    })

    await t.test('runtime falls back to legacy relay_users api_key when relay_api_keys misses', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])

      const legacyOnlyToken = 'rk_test_runtime_legacy_fallback'
      memoryUserStore.addUser({
        id: 'relay-user-legacy-fallback',
        apiKey: legacyOnlyToken,
        name: 'legacy-fallback-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })
      await resellerBillingStore.createRule({
        name: 'legacy-fallback-rule',
        currency: 'CNY',
        model: 'gpt-4.1',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '1000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'legacy fallback should still work' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Authorization: Bearer ${legacyOnlyToken}`,
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(
        relayUserLookupTrace.map((entry) => entry.source),
        ['relay_api_keys', 'relay_users_legacy'],
      )
      await waitForCondition(() => usageRecords.length === 1)
      assert.equal(usageRecords[0]?.relayKeySource, 'relay_users_legacy')
      assert.equal(upstreamRecords.http.length, 1)
    })

    await t.test('openai-compatible selection failures return OpenAI-style local errors', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'force a missing account' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'X-Force-Account: missing-account',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 404, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_ACCOUNT_NOT_FOUND',
        messagePattern: /Requested account was not found/,
        type: 'invalid_request_error',
      })
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('http relay returns OpenAI-style billing preflight 402 errors for /v1/chat/completions', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])
      memoryUserStore.addUser({
        id: 'relay-user-billing-preflight',
        apiKey: 'rk_test_billing_preflight',
        name: 'billing-preflight-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })
      await resellerBillingStore.createRule({
        name: 'different-model-only',
        currency: 'CNY',
        model: 'gpt-4.1-mini',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '1000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'hit billing preflight' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Authorization: Bearer rk_test_billing_preflight',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 402, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_BILLING_RULE_MISSING',
        messagePattern: /Billing rule missing or zero-priced/,
        type: 'invalid_request_error',
      })
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('http relay returns OpenAI-style 402 when prepaid balance exhausted on /v1/chat/completions', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])
      memoryUserStore.addUser({
        id: 'relay-user-balance-exhausted',
        apiKey: 'rk_test_balance_exhausted',
        name: 'balance-exhausted-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'prepaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })
      await resellerBillingStore.createRule({
        name: 'gpt-4.1 reseller price for exhausted-balance test',
        currency: 'CNY',
        model: 'gpt-4.1',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '2000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'no balance' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Authorization: Bearer rk_test_balance_exhausted',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 402, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_BILLING_INSUFFICIENT_BALANCE',
        messagePattern: /Prepaid balance exhausted/,
        type: 'invalid_request_error',
      })
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('openai-compatible scheduler capacity failures return OpenAI-style 529 errors', async () => {
      resetUpstreamState()
      const saturatedAccount = buildStoredAccount({
        id: 'openai-compatible:account-1',
        provider: 'openai-compatible',
        protocol: 'openai',
        authMode: 'api_key',
        accessToken: 'openai-api-key',
        refreshToken: null,
        createdAt: primaryCreatedAt,
        apiBaseUrl: upstreamBaseUrl,
        modelName: 'gpt-4.1',
        proxyUrl: null,
      })
      saturatedAccount.maxSessions = 1
      await seedAccounts([saturatedAccount])
      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'openai-capacity-saturated',
        accountId: 'openai-compatible:account-1',
      })

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'capacity test' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/chat/completions',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 529, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_SCHEDULER_CAPACITY',
        messagePattern: /Service is at capacity/,
        type: 'server_error',
      })
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('GET /v1/models returns OpenAI-style 401 when relay key is missing', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/models',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
        ],
      })

      assert.equal(response.statusCode, 401, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_RELAY_USER_REJECTED',
        messagePattern: /Relay API key required/,
        type: 'authentication_error',
      })
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('GET /v1/models returns OpenAI-style 401 when relay key is invalid', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/models',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer rk_invalid_models_key',
        ],
      })

      assert.equal(response.statusCode, 401, response.body)
      assertOpenAIErrorBody(response.body, {
        code: 'COR_RELAY_USER_REJECTED',
        messagePattern: /Invalid relay API key/,
        type: 'authentication_error',
      })
    })

    await t.test('GET /v1/models returns OpenAI-style list filtered by currency, active flag, fallback prefix and effective window', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const userToken = 'rk_test_models_catalog'
      memoryUserStore.addUser({
        id: 'relay-user-models',
        apiKey: userToken,
        name: 'models-catalog-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })

      // CNY active eligible
      await resellerBillingStore.createRule({
        name: 'gpt-4o eligible',
        currency: 'CNY',
        model: 'gpt-4o',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '2000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })
      // CNY active eligible - second one for sort assertion
      await resellerBillingStore.createRule({
        name: 'gpt-4.1 eligible',
        currency: 'CNY',
        model: 'gpt-4.1',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '4000000',
        effectiveFrom: '2026-02-01T00:00:00.000Z',
      })
      // USD - wrong currency, should be filtered out
      await resellerBillingStore.createRule({
        name: 'gpt-4.1-mini USD',
        currency: 'USD',
        model: 'gpt-4.1-mini',
        inputPriceMicrosPerMillion: '500000',
        outputPriceMicrosPerMillion: '1500000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })
      // CNY but inactive
      await resellerBillingStore.createRule({
        name: 'legacy-pro inactive',
        currency: 'CNY',
        model: 'legacy-pro',
        isActive: false,
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '1000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })
      // CNY but model is null (no point even if not the system fallback)
      await resellerBillingStore.createRule({
        name: 'no model field',
        currency: 'CNY',
        model: null,
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '1000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })
      // CNY active but effective_from is in the future
      await resellerBillingStore.createRule({
        name: 'future-model',
        currency: 'CNY',
        model: 'future-model',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '1000000',
        effectiveFrom: '2099-01-01T00:00:00.000Z',
      })
      // CNY active but effective_to has expired
      await resellerBillingStore.createRule({
        name: 'expired-model',
        currency: 'CNY',
        model: 'expired-model',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '1000000',
        effectiveFrom: '2024-01-01T00:00:00.000Z',
        effectiveTo: '2024-12-31T00:00:00.000Z',
      })
      // System fallback rule must be excluded even when otherwise eligible
      resellerBillingRules.push({
        id: 'system-default-all-models-cny',
        name: 'system fallback',
        isActive: true,
        priority: -1_000_000,
        currency: 'CNY',
        provider: null,
        accountId: null,
        userId: null,
        model: 'fallback-model',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        inputPriceMicrosPerMillion: '1000',
        outputPriceMicrosPerMillion: '1000',
        cacheCreationPriceMicrosPerMillion: '0',
        cacheReadPriceMicrosPerMillion: '0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
      // Duplicate of gpt-4o with later effective_from -> the earlier one wins; created should not change
      await resellerBillingStore.createRule({
        name: 'gpt-4o later override',
        currency: 'CNY',
        model: 'gpt-4o',
        inputPriceMicrosPerMillion: '2000000',
        outputPriceMicrosPerMillion: '5000000',
        effectiveFrom: '2026-03-01T00:00:00.000Z',
      })

      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/models',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          `Authorization: Bearer ${userToken}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.match(response.headers['content-type'] ?? '', /^application\/json/)
      const parsed = JSON.parse(response.body) as {
        object: string
        data: Array<{ id: string; object: string; created: number; owned_by: string }>
      }
      assert.equal(parsed.object, 'list')
      assert.deepEqual(
        parsed.data.map((entry) => entry.id),
        ['gpt-4.1', 'gpt-4o'],
      )
      assert.ok(parsed.data.every((entry) => entry.object === 'model'))
      assert.ok(parsed.data.every((entry) => entry.owned_by === 'reseller'))
      const gpt4o = parsed.data.find((entry) => entry.id === 'gpt-4o')
      assert.ok(gpt4o)
      assert.equal(
        gpt4o.created,
        Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
        'gpt-4o created should reflect the earliest effective_from, not the override',
      )
      const gpt41 = parsed.data.find((entry) => entry.id === 'gpt-4.1')
      assert.ok(gpt41)
      assert.equal(
        gpt41.created,
        Math.floor(Date.parse('2026-02-01T00:00:00.000Z') / 1000),
      )
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('GET /v1/models honors per-user billing currency for catalog filtering', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const usdToken = 'rk_test_models_usd_user'
      memoryUserStore.addUser({
        id: 'relay-user-models-usd',
        apiKey: usdToken,
        name: 'models-catalog-usd-user',
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'USD',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      })

      await resellerBillingStore.createRule({
        name: 'gpt-4.1 CNY',
        currency: 'CNY',
        model: 'gpt-4.1',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '4000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })
      await resellerBillingStore.createRule({
        name: 'gpt-4.1-mini USD',
        currency: 'USD',
        model: 'gpt-4.1-mini',
        inputPriceMicrosPerMillion: '500000',
        outputPriceMicrosPerMillion: '1500000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      })

      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/models',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          `Authorization: Bearer ${usdToken}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      const parsed = JSON.parse(response.body) as {
        object: string
        data: Array<{ id: string }>
      }
      assert.deepEqual(parsed.data.map((entry) => entry.id), ['gpt-4.1-mini'])
    })

    await t.test('http relay returns OpenAI-style unsupported-provider-path errors for /v1/chat/completions', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'provider does not support chat completions' }],
      }))

      for (const testCase of [
        {
          forceAccount: 'openai-codex:account-1',
          messagePattern: /openai-codex currently only supports \/v1\/responses/,
        },
        {
          forceAccount: 'claude-compatible:account-1',
          messagePattern: /claude-compatible currently only supports \/v1\/messages and \/v1\/messages\/count_tokens/,
        },
      ]) {
        const response = await sendRawHttpRequest({
          body,
          port: relayAddress.port,
          path: '/v1/chat/completions',
          rawRequestHeaders: [
            `Host: 127.0.0.1:${relayAddress.port}`,
            'Connection: close',
            'Content-Type: application/json',
            `X-Force-Account: ${testCase.forceAccount}`,
            `Content-Length: ${body.length}`,
          ],
        })

        assert.equal(response.statusCode, 501, response.body)
        assertOpenAIErrorBody(response.body, {
          code: 'COR_PROVIDER_ROUTE_UNSUPPORTED',
          messagePattern: testCase.messagePattern,
          type: 'server_error',
        })
      }

      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('http relay rejects /v1/messages for openai-compatible accounts', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-1',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hi from anthropic client' }],
          },
        ],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'User-Agent: claude-cli/2.1.95 (external, sdk-ts)',
          'X-App: cli',
          'anthropic-version: 2023-06-01',
          `Content-Length: ${body.length}`,
          'X-Force-Account: openai-compatible:account-1',
        ],
      })

      assert.equal(response.statusCode, 501, response.body)
      assert.match(response.body, /openai-compatible currently only supports \/v1\/chat\/completions/)
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('preferred group keeps provider fallback scoped to that group', async () => {
      resetUpstreamState()
      memoryUserStore.addUser({
        id: 'relay-user-group-openai',
        apiKey: 'rk_group_scope_test_key',
        name: 'group-scope-user',
        accountId: null,
        routingMode: 'preferred_group',
        routingGroupId: 'group-a',
        preferredGroup: 'group-a',
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-13T00:00:00.000Z',
        updatedAt: '2026-04-13T00:00:00.000Z',
      })
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-compatible:account-a',
          provider: 'openai-compatible',
          protocol: 'openai',
          authMode: 'api_key',
          accessToken: 'openai-api-key-a',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'gpt-4.1',
          proxyUrl: null,
          group: 'group-a',
        }),
        buildStoredAccount({
          id: 'openai-codex:account-b',
          provider: 'openai-codex',
          protocol: 'openai',
          authMode: 'oauth',
          accessToken: 'codex-access-token-b',
          refreshToken: 'codex-refresh-token-b',
          createdAt: secondaryCreatedAt,
          apiBaseUrl: `${upstreamBaseUrl}/backend-api/codex`,
          modelName: 'gpt-5.4',
          proxyUrl: null,
          group: 'group-b',
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'route inside my own group only' }],
          },
        ],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Authorization: Bearer rk_group_scope_test_key',
          'User-Agent: claude-cli/2.1.95 (external, sdk-ts)',
          'X-App: cli',
          'anthropic-version: 2023-06-01',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 501, response.body)
      assert.match(response.body, /openai-compatible currently only supports \/v1\/chat\/completions/)
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('disabled routing group is rejected before upstream selection', async () => {
      resetUpstreamState()
      memoryUserStore.addUser({
        id: 'relay-user-disabled-group',
        apiKey: 'rk_disabled_group_test_key',
        name: 'disabled-group-user',
        accountId: null,
        routingMode: 'preferred_group',
        routingGroupId: 'group-a',
        preferredGroup: 'group-a',
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-13T00:00:00.000Z',
        updatedAt: '2026-04-13T00:00:00.000Z',
      })
      await seedAccounts([
        buildStoredAccount({
          id: 'claude-official:group-a-account',
          accessToken: 'oauth-access-token-group-a',
          refreshToken: 'oauth-refresh-token-group-a',
          createdAt: primaryCreatedAt,
          group: 'group-a',
        }),
      ])
      await oauthService.ensureRoutingGroupExists('group-a')
      await oauthService.updateRoutingGroup('group-a', { isActive: false })

      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'should fail because routing group is disabled' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Authorization: Bearer rk_disabled_group_test_key',
          'User-Agent: claude-cli/2.1.95 (external, sdk-ts)',
          'X-App: cli',
          'anthropic-version: 2023-06-01',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 403, response.body)
      assert.match(response.body, /Requested routing group is unavailable/)
      assert.doesNotMatch(response.body, /group-a/)
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('pinned rate-limited accounts return a sanitized 429 without leaking account ids', async () => {
      resetUpstreamState()
      memoryUserStore.addUser({
        id: 'relay-user-pinned-limited',
        apiKey: 'rk_pinned_limited_test_key',
        name: 'pinned-limited-user',
        accountId: 'email:hillaryalexanderlrm@moscowmail.com',
        routingMode: 'pinned_account',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: '2026-04-13T00:00:00.000Z',
        updatedAt: '2026-04-13T00:00:00.000Z',
      })
      await seedAccounts([
        buildStoredAccount({
          id: 'email:hillaryalexanderlrm@moscowmail.com',
          accessToken: 'oauth-access-token-limited',
          refreshToken: 'oauth-refresh-token-limited',
          createdAt: primaryCreatedAt,
          emailAddress: 'hillaryalexanderlrm@moscowmail.com',
          proxyUrl: 'http://127.0.0.1:10810',
          schedulerState: 'auto_blocked',
          autoBlockedReason: 'rate_limit:rejected',
          autoBlockedUntil: Date.now() + 60_000,
          lastRateLimitStatus: 'rejected',
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'should fail with sanitized 429' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Authorization: Bearer rk_pinned_limited_test_key',
          'User-Agent: claude-cli/2.1.95 (external, sdk-ts)',
          'X-App: cli',
          'anthropic-version: 2023-06-01',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 429, response.body)
      assert.match(response.body, /Requested account is temporarily rate limited/)
      assert.doesNotMatch(response.body, /hillaryalexanderlrm@moscowmail\.com/)
      assert.doesNotMatch(response.body, /email:/)
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('missing forced accounts return a sanitized 404 without leaking account ids', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'force a missing account' }],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'User-Agent: claude-cli/2.1.95 (external, sdk-ts)',
          'X-App: cli',
          'anthropic-version: 2023-06-01',
          'X-Force-Account: missing-account',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 404, response.body)
      assert.match(response.body, /Requested account was not found/)
      assert.doesNotMatch(response.body, /missing-account/)
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('http relay rejects /v1/messages for openai-codex accounts', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-codex:account-1',
          provider: 'openai-codex',
          protocol: 'openai',
          authMode: 'oauth',
          accessToken: 'codex-access-token',
          refreshToken: 'codex-refresh-token',
          createdAt: primaryCreatedAt,
          apiBaseUrl: `${upstreamBaseUrl}/backend-api/codex/v1`,
          modelName: 'gpt-5-codex',
          proxyUrl: null,
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-5',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hi from codex oauth' }],
          },
        ],
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Force-Account: openai-codex:account-1',
        ],
      })

      assert.equal(response.statusCode, 501, response.body)
      assert.match(response.headers['content-type'] ?? '', /^application\/json/)
      assert.match(response.body, /openai-codex currently only supports \/v1\/responses/)
      assert.equal(proxyRecords.http.length, 0)
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('http relay routes /v1/responses to openai-codex even when claude accounts also exist', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'claude-official:account-1',
          provider: 'claude-official',
          protocol: 'claude',
          authMode: 'oauth',
          accessToken: 'claude-access-token',
          refreshToken: 'claude-refresh-token',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'openai-codex:account-1',
          provider: 'openai-codex',
          protocol: 'openai',
          authMode: 'oauth',
          accessToken: 'codex-access-token',
          refreshToken: 'codex-refresh-token',
          createdAt: primaryCreatedAt,
          apiBaseUrl: `${upstreamBaseUrl}/backend-api/codex`,
          modelName: 'gpt-5.4',
          proxyUrl: null,
        }),
      ])

      const upstreamSse = [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"pong"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","output":[],"usage":{"input_tokens":25,"output_tokens":5}}}',
        '',
      ].join('\n')

      handleMessageRequest = ({ body, req, res, url }) => {
        assert.equal(url.pathname, '/backend-api/codex/responses')
        assert.equal(req.headers.authorization, 'Bearer codex-access-token')
        assert.equal(req.headers['chatgpt-account-id'], 'org-openai-codex:account-1')
        assert.equal(req.headers.originator, 'codex_exec')
        assert.equal(req.headers['x-codex-window-id'], 'codex-session-1:0')
        assert.equal(req.headers.session_id, 'codex-session-1')
        assert.equal(req.headers['x-client-request-id'], 'codex-request-1')
        assert.equal(req.headers['openai-beta'], 'responses=experimental')

        const parsed = JSON.parse(body.toString('utf8')) as {
          model: string
          store: boolean
          stream: boolean
          input: Array<{ type: string; role?: string }>
        }
        assert.equal(parsed.model, 'gpt-5.4')
        assert.equal(parsed.store, false)
        assert.equal(parsed.stream, true)
        assert.equal(parsed.input.at(0)?.type, 'message')
        assert.equal(parsed.input.at(0)?.role, 'user')

        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache')
        res.setHeader('x-request-id', 'codex-upstream-direct-1')
        res.end(upstreamSse)
      }

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-5.4',
        instructions: 'You are Codex. Run pwd and stop.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Run pwd and stop.',
              },
            ],
          },
        ],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: 'medium' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        text: { verbosity: 'low' },
      }))

      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/responses',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Accept: text/event-stream',
          'User-Agent: codex_exec/0.120.0 (Ubuntu 24.4.0; x86_64) dumb (codex_exec; 0.120.0)',
          'Originator: codex_exec',
          'X-Codex-Window-Id: codex-session-1:0',
          'X-Client-Request-Id: codex-request-1',
          'session_id: codex-session-1',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.match(response.headers['content-type'] ?? '', /^text\/event-stream/)
      assert.equal(response.headers['x-request-id'], 'codex-upstream-direct-1')
      assert.equal(response.body, upstreamSse)
      await new Promise<void>((resolve) => setImmediate(resolve))

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(upstreamRequest.path, '/backend-api/codex/responses')
      assert.equal(proxyRecords.http.length, 0)
      assert.equal(usageRecords.length, 1)
      assert.equal(usageRecords[0]?.target, '/v1/responses')
      assert.equal(usageRecords[0]?.statusCode, 200)
      assert.equal(usageRecords[0]?.inputTokens, 25)
      assert.equal(usageRecords[0]?.outputTokens, 5)
    })

    await t.test('openai-codex quota failures retry on another account while preserving session headers', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-codex:account-1',
          provider: 'openai-codex',
          protocol: 'openai',
          authMode: 'oauth',
          accessToken: 'codex-access-token-1',
          refreshToken: 'codex-refresh-token-1',
          createdAt: primaryCreatedAt,
          apiBaseUrl: `${upstreamBaseUrl}/backend-api/codex`,
          modelName: 'gpt-5.4',
          proxyUrl: null,
        }),
        buildStoredAccount({
          id: 'openai-codex:account-2',
          provider: 'openai-codex',
          protocol: 'openai',
          authMode: 'oauth',
          accessToken: 'codex-access-token-2',
          refreshToken: 'codex-refresh-token-2',
          createdAt: secondaryCreatedAt,
          apiBaseUrl: `${upstreamBaseUrl}/backend-api/codex`,
          modelName: 'gpt-5.4',
          proxyUrl: null,
        }),
      ])
      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'codex-remote-session-1',
        accountId: 'openai-codex:account-1',
      })

      let attempt = 0
      handleMessageRequest = ({ body, req, res }) => {
        attempt += 1
        assert.equal(req.headers.session_id, 'codex-remote-session-1')
        assert.equal(req.headers['x-codex-window-id'], 'codex-remote-session-1:0')
        const parsed = JSON.parse(body.toString('utf8')) as { instructions?: string }
        if (attempt === 1) {
          assert.equal(req.headers.authorization, 'Bearer codex-access-token-1')
          assert.equal(req.headers['chatgpt-account-id'], 'org-openai-codex:account-1')
          assert.equal(parsed.instructions, 'existing instructions')
          res.statusCode = 429
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'quota exceeded' } }))
          return
        }

        assert.equal(req.headers.authorization, 'Bearer codex-access-token-2')
        assert.equal(req.headers['chatgpt-account-id'], 'org-openai-codex:account-2')
        assert.match(parsed.instructions ?? '', /existing instructions/)
        assert.match(parsed.instructions ?? '', /压缩背景/)
        assert.match(parsed.instructions ?? '', /codex-remote-session-1/)
        res.setHeader('content-type', 'text/event-stream')
        res.end([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_rotated","model":"gpt-5.4","output":[],"usage":{"input_tokens":10,"output_tokens":2}}}',
          '',
        ].join('\n'))
      }

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-5.4',
        instructions: 'existing instructions',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }],
        stream: true,
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/responses',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Accept: text/event-stream',
          'Originator: codex_exec',
          'X-Codex-Window-Id: codex-remote-session-1:0',
          'session_id: codex-remote-session-1',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.equal(attempt, 2)
      assert.equal(upstreamRecords.http.length, 2)
      const route = await memoryUserStore.getSessionRoute('codex-remote-session-1')
      assert.ok(route)
      assert.equal(route.accountId, 'openai-codex:account-2')
      assert.equal(route.generation, 2)
      assert.equal(route.pendingHandoffSummary, null)
      const [handoff] = await memoryUserStore.listSessionHandoffs()
      assert.ok(handoff)
      assert.equal(handoff.fromAccountId, 'openai-codex:account-1')
      assert.equal(handoff.toAccountId, 'openai-codex:account-2')
      assert.equal(handoff.reason, 'rate_limit:rejected')
    })

    await t.test('openai-codex 529 overloaded responses do not retry on another account', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'openai-codex:account-1',
          provider: 'openai-codex',
          protocol: 'openai',
          authMode: 'oauth',
          accessToken: 'codex-access-token-1',
          refreshToken: 'codex-refresh-token-1',
          createdAt: primaryCreatedAt,
          apiBaseUrl: `${upstreamBaseUrl}/backend-api/codex`,
          modelName: 'gpt-5.4',
          proxyUrl: null,
        }),
        buildStoredAccount({
          id: 'openai-codex:account-2',
          provider: 'openai-codex',
          protocol: 'openai',
          authMode: 'oauth',
          accessToken: 'codex-access-token-2',
          refreshToken: 'codex-refresh-token-2',
          createdAt: secondaryCreatedAt,
          apiBaseUrl: `${upstreamBaseUrl}/backend-api/codex`,
          modelName: 'gpt-5.4',
          proxyUrl: null,
        }),
      ])

      let attempt = 0
      handleMessageRequest = ({ req, res }) => {
        attempt += 1
        assert.equal(req.headers.authorization, 'Bearer codex-access-token-1')
        assert.equal(req.headers['chatgpt-account-id'], 'org-openai-codex:account-1')
        res.statusCode = 529
        res.statusMessage = 'Overloaded'
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'overloaded' } }))
      }

      const body = Buffer.from(JSON.stringify({
        model: 'gpt-5.4',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }],
        stream: true,
      }))
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/responses',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'Accept: text/event-stream',
          'session_id: codex-remote-session-529',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 529, response.body)
      assert.equal(attempt, 1)
      assert.equal(upstreamRecords.http.length, 1)
      assert.equal((await memoryUserStore.listSessionHandoffs()).length, 0)
    })

    await t.test('http relay can normalize VM fingerprint headers while preserving auth and session ids', async () => {
      const config = appConfig as {
        vmFingerprintTemplatePath: string | null
        vmFingerprintTemplateHeaders: Array<{ name: string, value: string }>
      }
      const originalVmFingerprintTemplatePath = config.vmFingerprintTemplatePath
      const originalVmFingerprintTemplateHeaders = config.vmFingerprintTemplateHeaders
      config.vmFingerprintTemplatePath = null
      config.vmFingerprintTemplateHeaders = [
        { name: 'User-Agent', value: 'claude-cli/2.1.92 (external, sdk-cli)' },
        { name: 'X-App', value: 'cli' },
        { name: 'X-Stainless-Lang', value: 'js' },
        { name: 'X-Stainless-Package-Version', value: '0.9.0' },
      ]

      try {
        resetUpstreamState()
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            createdAt: primaryCreatedAt,
          }),
        ])
        const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
        const response = await sendRawHttpRequest({
          body,
          port: relayAddress.port,
          path: '/v1/messages',
          rawRequestHeaders: [
            `Host: 127.0.0.1:${relayAddress.port}`,
            'Connection: close',
            'Authorization: Bearer incoming-client-token',
            'Content-Type: application/json',
            `Content-Length: ${body.length}`,
            'User-Agent: claude-cli/2.1.95 (external, sdk-ts)',
            'X-App: custom-app',
            'X-Stainless-Lang: python',
            'X-Stainless-Package-Version: 9.9.9',
            'anthropic-beta: route-beta-1,route-beta-2',
            'X-Claude-Code-Session-Id: sticky-session-1',
          ],
        })

        assert.equal(response.statusCode, 200, response.body)

        const upstreamRequest = upstreamRecords.http.at(-1)
        assert.ok(upstreamRequest)
        assert.equal(
          getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'Authorization'),
          'Bearer incoming-client-token',
        )
        assert.equal(
          getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'User-Agent'),
          'claude-cli/2.1.92 (external, sdk-cli)',
        )
        assert.equal(
          getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'X-App'),
          'cli',
        )
        assert.equal(
          getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'X-Stainless-Lang'),
          'js',
        )
        assert.equal(
          getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'X-Stainless-Package-Version'),
          '0.9.0',
        )
        const incomingBeta = getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'anthropic-beta')
        assert.notEqual(incomingBeta, 'route-beta-1,route-beta-2')
        assert.equal(
          incomingBeta,
          expectedAnthropicBeta(appConfig.bodyTemplate?.anthropicBeta, 'api_key', ['route-beta-1,route-beta-2']),
        )
        assert.equal(
          getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'X-Claude-Code-Session-Id'),
          'sticky-session-1',
        )
      } finally {
        config.vmFingerprintTemplatePath = originalVmFingerprintTemplatePath
        config.vmFingerprintTemplateHeaders = originalVmFingerprintTemplateHeaders
      }
    })

    await t.test('http relay appends client-only beta tokens for clients at or below the template version', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'User-Agent: claude-cli/2.1.112 (external, sdk-cli)',
          'anthropic-beta: fast-mode-2026-02-01',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest)
      const beta = getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'anthropic-beta')
      assert.ok(beta?.includes('fast-mode-2026-02-01'))
      assert.equal(
        beta,
        expectedAnthropicBeta(appConfig.bodyTemplateNew?.anthropicBeta, 'api_key', ['fast-mode-2026-02-01']),
      )
    })

    await t.test('http relay strips long context beta for haiku models', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const body = Buffer.from('{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'X-API-Key: incoming-api-key',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'User-Agent: claude-cli/2.1.112 (external, sdk-cli)',
          'anthropic-beta: fast-mode-2026-02-01,context-1m-2025-08-07',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest)
      const beta = getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'anthropic-beta')
      assert.ok(beta)
      assert.ok(!beta.includes('context-1m-2025-08-07'))
      assert.equal(
        beta,
        expectedAnthropicBeta(
          appConfig.bodyTemplateNew?.anthropicBeta,
          'oauth',
          ['fast-mode-2026-02-01,context-1m-2025-08-07'],
          ['context-1m-2025-08-07'],
        ),
      )
    })

    await t.test('http relay strips long context beta for sonnet models', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const body = Buffer.from('{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'X-API-Key: incoming-api-key',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'User-Agent: claude-cli/2.1.112 (external, sdk-cli)',
          'anthropic-beta: fast-mode-2026-02-01,context-1m-2025-08-07',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest)
      const beta = getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'anthropic-beta')
      assert.ok(beta)
      assert.ok(!beta.includes('context-1m-2025-08-07'))
      assert.equal(
        beta,
        expectedAnthropicBeta(
          appConfig.bodyTemplateNew?.anthropicBeta,
          'oauth',
          ['fast-mode-2026-02-01,context-1m-2025-08-07'],
          ['context-1m-2025-08-07'],
        ),
      )
    })

    await t.test('http relay drops client-only beta tokens when the client version exceeds the template version', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'User-Agent: claude-cli/2.1.200 (external, sdk-cli)',
          'anthropic-beta: future-only-2099-01-01',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest)
      const beta = getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'anthropic-beta')
      assert.ok(beta && !beta.includes('future-only-2099-01-01'))
      assert.equal(beta, expectedAnthropicBeta(appConfig.bodyTemplateNew?.anthropicBeta, 'api_key'))
    })

    await t.test('http relay uses the new-era body template for >=2.1.100 clients even when a legacy global template is configured', async () => {
      const config = appConfig as {
        bodyTemplatePath: string | null
        bodyTemplate: BodyTemplate | null
        bodyTemplateNewPath: string | null
        bodyTemplateNew: BodyTemplate | null
      }
      const originalBodyTemplatePath = config.bodyTemplatePath
      const originalBodyTemplate = config.bodyTemplate
      const originalBodyTemplateNewPath = config.bodyTemplateNewPath
      const originalBodyTemplateNew = config.bodyTemplateNew

      const legacyTemplatePath = path.resolve(process.cwd(), 'data/v2.1.98-body-template.json')
      const newEraTemplatePath = path.resolve(process.cwd(), 'data/v2.1.112-body-template.json')
      const legacyTemplate = JSON.parse(await readFile(legacyTemplatePath, 'utf8')) as BodyTemplate
      const newEraTemplate = JSON.parse(await readFile(newEraTemplatePath, 'utf8')) as BodyTemplate

      config.bodyTemplatePath = legacyTemplatePath
      config.bodyTemplate = legacyTemplate
      config.bodyTemplateNewPath = newEraTemplatePath
      config.bodyTemplateNew = newEraTemplate

      try {
        resetUpstreamState()
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            createdAt: primaryCreatedAt,
          }),
        ])

        const body = Buffer.from(JSON.stringify({
          model: 'claude-opus-4-6',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'say ok' }] }],
          system: [{
            type: 'text',
            text: 'x-anthropic-billing-header: cc_version=2.1.101.a50; cc_entrypoint=sdk-ts; cch=00000;',
          }],
          tools: [],
          metadata: {
            user_id: JSON.stringify({
              device_id: 'client-device-id',
              account_uuid: 'client-account-uuid',
              session_id: 'session-1',
            }),
          },
          max_tokens: 64,
          stream: false,
        }))

        const response = await sendRawHttpRequest({
          body,
          port: relayAddress.port,
          path: '/v1/messages',
          rawRequestHeaders: [
            `Host: 127.0.0.1:${relayAddress.port}`,
            'Connection: close',
            'Content-Type: application/json',
            `Content-Length: ${body.length}`,
            'User-Agent: claude-cli/2.1.101 (external, sdk-ts)',
          ],
        })

        assert.equal(response.statusCode, 200, response.body)

        const upstreamRequest = upstreamRecords.http.at(-1)
        assert.ok(upstreamRequest?.body)
        const proxiedRequest = proxyRecords.http.at(-1)
        assert.ok(proxiedRequest)
        assert.equal(proxiedRequest.path, new URL(upstreamBaseUrl).host)

        const upstreamBody = JSON.parse(upstreamRequest.body.toString('utf8')) as {
          metadata?: { user_id?: string }
          system: Array<{ text: string }>
          tools: unknown[]
        }
        assert.match(
          upstreamBody.system[0]?.text ?? '',
          new RegExp(`cc_version=${newEraTemplate.ccVersion.replaceAll('.', '\\.')}`),
        )
        assert.match(upstreamBody.system[0]?.text ?? '', /cc_entrypoint=sdk-cli/)
        assert.equal(upstreamBody.tools.length, newEraTemplate.tools.length)
        assert.equal(
          getFirstHeaderValue(upstreamRequest.rawHeaders ?? [], 'anthropic-beta'),
          expectedAnthropicBeta(newEraTemplate.anthropicBeta),
        )

        const metadataUserId = JSON.parse(upstreamBody.metadata?.user_id ?? '{}') as {
          device_id?: string
          account_uuid?: string
        }
        assert.ok(metadataUserId.device_id)
        assert.notEqual(metadataUserId.device_id, 'client-device-id')
        assert.equal(metadataUserId.account_uuid, 'account-1')
      } finally {
        config.bodyTemplatePath = originalBodyTemplatePath
        config.bodyTemplate = originalBodyTemplate
        config.bodyTemplateNewPath = originalBodyTemplateNewPath
        config.bodyTemplateNew = originalBodyTemplateNew
      }
    })

    await t.test('http relay stores the original client device id on the session route while rewriting the upstream device id', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])

      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'say ok' }] }],
        system: [{
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.101.a50; cc_entrypoint=sdk-ts; cch=00000;',
        }],
        tools: [],
        metadata: {
          user_id: JSON.stringify({
            device_id: 'client-device-id',
            account_uuid: 'client-account-uuid',
            session_id: 'session-1',
          }),
        },
        max_tokens: 64,
        stream: false,
      }))

      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'User-Agent: claude-cli/2.1.101 (external, sdk-ts)',
          'X-Claude-Code-Session-Id: client-device-session-1',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)

      const upstreamRequest = upstreamRecords.http.at(-1)
      assert.ok(upstreamRequest?.body)
      const upstreamBody = JSON.parse(upstreamRequest.body.toString('utf8')) as {
        metadata?: { user_id?: string }
      }
      const metadataUserId = JSON.parse(upstreamBody.metadata?.user_id ?? '{}') as {
        device_id?: string
      }
      assert.ok(metadataUserId.device_id)
      assert.notEqual(metadataUserId.device_id, 'client-device-id')

      const route = await memoryUserStore.getSessionRoute('client-device-session-1')
      assert.ok(route)
      assert.equal(route?.clientDeviceId, 'client-device-id')
    })

    await t.test('http capture logs summarize inbound versus upstream request differences', async () => {
      const config = appConfig as {
        relayCaptureBodyMaxBytes: number
        relayCaptureEnabled: boolean
        vmFingerprintTemplatePath: string | null
        vmFingerprintTemplateHeaders: Array<{ name: string, value: string }>
      }
      const originalCaptureEnabled = config.relayCaptureEnabled
      const originalCaptureBodyMaxBytes = config.relayCaptureBodyMaxBytes
      const originalVmFingerprintTemplatePath = config.vmFingerprintTemplatePath
      const originalVmFingerprintTemplateHeaders = config.vmFingerprintTemplateHeaders
      config.relayCaptureEnabled = true
      config.relayCaptureBodyMaxBytes = 24
      config.vmFingerprintTemplatePath = null
      config.vmFingerprintTemplateHeaders = []

      try {
        resetUpstreamState()
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            createdAt: primaryCreatedAt,
          }),
        ])

        const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
        const response = await sendRawHttpRequest({
          body,
          port: relayAddress.port,
          path: '/v1/messages?hello=world',
          rawRequestHeaders: [
            `Host: 127.0.0.1:${relayAddress.port}`,
            'Connection: close',
            'Authorization: Bearer incoming-client-token',
            'Content-Type: application/json',
            `Content-Length: ${body.length}`,
            'X-Custom-Trace: trace-1',
            'X-Custom-Trace: trace-2',
            'X-Another-Header: another',
          ],
        })

        assert.equal(response.statusCode, 200, response.body)

        const capture = relayCaptures.find((event) => event.event === 'http_request_capture')
        assert.ok(capture)
        assert.equal(capture.method, 'POST')
        assert.equal(capture.target, '/v1/messages?hello=world')
        assert.equal(capture.upstreamUrl, `${upstreamBaseUrl}/v1/messages?hello=world`)
        assert.equal(capture.authMode, 'preserve_incoming_auth')
        assert.equal(capture.routeAuthStrategy, 'prefer_incoming_auth')
        assert.deepEqual(
          capture.removedHeaders.map((entry) => entry.name),
          ['connection', 'host', 'user-agent', 'x-another-header', 'x-custom-trace'],
        )
        assert.deepEqual(
          capture.addedHeaders.map((entry: { name: string }) => entry.name),
          ['anthropic-beta'],
        )
        assert.deepEqual(capture.changedHeaders, [])
        assert.equal(capture.incomingBody.length, body.length)
        assert.equal(capture.upstreamBody.length, body.length)
        assert.equal(capture.incomingBody.sha256, capture.upstreamBody.sha256)
        assert.equal(capture.incomingBody.truncated, true)
        assert.match(JSON.stringify(capture.incomingRawHeaders), /Bearer <redacted sha256=/)
        assert.deepEqual(
          getAllHeaderValues(capture.upstreamRequestHeaders, 'X-Custom-Trace'),
          [],
        )
      } finally {
        config.relayCaptureEnabled = originalCaptureEnabled
        config.relayCaptureBodyMaxBytes = originalCaptureBodyMaxBytes
        config.vmFingerprintTemplatePath = originalVmFingerprintTemplatePath
        config.vmFingerprintTemplateHeaders = originalVmFingerprintTemplateHeaders
      }
    })

    await t.test('http relay rejects unsupported method before hitting upstream', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
        ],
      })

      assert.equal(response.statusCode, 405, response.body)
      assert.equal(response.headers.allow, 'POST')
      const errorBody = JSON.parse(response.body) as { error: { internal_code?: string } }
      assert.equal(errorBody.error.internal_code, 'COR_METHOD_NOT_ALLOWED')
      assert.equal(upstreamRecords.http.length, 0)
      assert.equal(proxyRecords.http.length, 0)
      const rejectionLog = relayLogs.at(-1)
      assert.ok(rejectionLog)
      assert.equal(rejectionLog.event, 'http_rejected')
      assert.equal(rejectionLog.statusCode, 405)
      assert.equal(rejectionLog.error, 'unsupported_method')
      assert.equal(rejectionLog.internalCode, 'COR_METHOD_NOT_ALLOWED')
    })

    await t.test('http relay returns internal code when no account is selectable', async () => {
      resetUpstreamState()
      await seedAccounts([])

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        method: 'POST',
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'User-Agent: claude-cli/2.1.112 (external, cli)',
        ],
      })

      assert.equal(response.statusCode, 503, response.body)
      const errorBody = JSON.parse(response.body) as { error: { internal_code?: string } }
      assert.equal(errorBody.error.internal_code, 'COR_ACCOUNT_POOL_UNAVAILABLE')
      const failureLog = relayLogs.at(-1)
      assert.ok(failureLog)
      assert.equal(failureLog.event, 'http_rejected')
      assert.equal(failureLog.statusCode, 503)
      assert.equal(failureLog.internalCode, 'COR_ACCOUNT_POOL_UNAVAILABLE')
    })

    await t.test('http relay emits structured completion log', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')

      const response = await sendRawHttpRequest({
        method: 'POST',
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Request-Id: relay-log-1',
          'X-Claude-Code-Session-Id: sticky-log-1',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      const completionLog = relayLogs.find((event) => event.event === 'http_completed')
      assert.ok(completionLog)
      assert.equal(completionLog.requestId, 'relay-log-1')
      assert.equal(completionLog.accountId, 'account-1')
      assert.equal(completionLog.authMode, 'oauth')
      assert.equal(completionLog.routeAuthStrategy, 'prefer_incoming_auth')
      assert.equal(completionLog.upstreamRequestId, 'http-upstream-1')
      assert.equal(completionLog.hasStickySessionKey, true)
      assert.equal(completionLog.retryCount, 0)
    })

    await t.test('http relay logs error response preview and rate-limit status', async () => {
      const config = appConfig as { sameRequestSessionMigrationEnabled: boolean }
      const originalSameRequestMigrationEnabled = config.sameRequestSessionMigrationEnabled
      config.sameRequestSessionMigrationEnabled = false
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      handleMessageRequest = ({ res }) => {
        res.statusCode = 429
        res.statusMessage = 'Too Many Requests'
        res.setHeader('request-id', 'http-upstream-rate-limit-1')
        res.setHeader('content-type', 'application/json')
        res.setHeader('retry-after', '17')
        res.setHeader('anthropic-ratelimit-unified-status', 'throttled')
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'slow down',
          },
        }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        method: 'POST',
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Request-Id: relay-log-rate-limit-1',
          'X-Claude-Code-Session-Id: sticky-log-rate-limit-1',
        ],
      })

      assert.equal(response.statusCode, 429, response.body)
      const completionLog = relayLogs.find(
        (event) =>
          event.event === 'http_completed' &&
          event.requestId === 'relay-log-rate-limit-1',
      )
      assert.ok(completionLog)
      assert.equal(completionLog.rateLimitStatus, 'throttled')
      assert.equal(completionLog.retryAfterSeconds, 17)
      assert.equal(completionLog.sameRequestMigrationEligible, false)
      assert.equal(completionLog.responseContentType, 'application/json')
      assert.match(completionLog.responseBodyPreview ?? '', /rate_limit_error/)
      config.sameRequestSessionMigrationEnabled = originalSameRequestMigrationEnabled
    })

    await t.test('http relay logs usage insert failures without breaking response', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      usageInsertError = new Error('usage store unavailable')

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        method: 'POST',
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Request-Id: relay-usage-log-failure-1',
          'X-Claude-Code-Session-Id: sticky-usage-log-failure-1',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      await new Promise<void>((resolve) => setImmediate(resolve))
      const failureLog = relayLogs.find(
        (event) =>
          event.event === 'usage_record_failed' &&
          event.requestId === 'relay-usage-log-failure-1',
      )
      assert.ok(failureLog)
      assert.equal(failureLog.statusCode, 200)
      assert.equal(failureLog.error, 'usage store unavailable')
    })

    await t.test('http relay cools down accounts after repeated upstream 5xx', async () => {
      resetUpstreamState()
      const config = appConfig as {
        globalUpstreamIncidentEnabled: boolean
        upstream5xxCooldownMs: number
        upstream5xxCooldownThreshold: number
      }
      const originalIncidentEnabled = config.globalUpstreamIncidentEnabled
      const originalCooldownMs = config.upstream5xxCooldownMs
      const originalCooldownThreshold = config.upstream5xxCooldownThreshold
      config.globalUpstreamIncidentEnabled = false
      config.upstream5xxCooldownMs = 60_000
      config.upstream5xxCooldownThreshold = 2

      try {
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token-1',
            refreshToken: 'oauth-refresh-token-1',
            createdAt: primaryCreatedAt,
          }),
          buildStoredAccount({
            id: 'account-2',
            accessToken: 'oauth-access-token-2',
            refreshToken: 'oauth-refresh-token-2',
            createdAt: secondaryCreatedAt,
          }),
        ])

        handleMessageRequest = ({ req, res }) => {
          if (req.headers.authorization === 'Bearer oauth-access-token-2') {
            res.setHeader('request-id', 'http-upstream-healthy-2')
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
            return
          }
          res.statusCode = 500
          res.statusMessage = 'Internal Server Error'
          res.setHeader('request-id', 'http-upstream-5xx-1')
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'upstream failure' } }))
        }

        const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
        for (const requestId of ['cooldown-a', 'cooldown-b']) {
          const response = await sendRawHttpRequest({
            method: 'POST',
            body,
            port: relayAddress.port,
            path: '/v1/messages',
            rawRequestHeaders: [
              `Host: 127.0.0.1:${relayAddress.port}`,
              'Connection: close',
              'Content-Type: application/json',
              `Content-Length: ${body.length}`,
              `X-Request-Id: ${requestId}`,
              `X-Claude-Code-Session-Id: ${requestId}`,
              'X-Force-Account: account-1',
            ],
          })
          assert.equal(response.statusCode, 500, response.body)
        }

        const response = await sendRawHttpRequest({
          method: 'POST',
          body,
          port: relayAddress.port,
          path: '/v1/messages',
          rawRequestHeaders: [
            `Host: 127.0.0.1:${relayAddress.port}`,
            'Connection: close',
            'Content-Type: application/json',
            `Content-Length: ${body.length}`,
            'X-Request-Id: cooldown-auto',
            'X-Claude-Code-Session-Id: cooldown-auto-session',
          ],
        })

        assert.equal(response.statusCode, 200, response.body)
        const upstreamRequest = upstreamRecords.http.at(-1)
        assert.ok(upstreamRequest)
        assert.equal(upstreamRequest.headers.authorization, 'Bearer oauth-access-token-2')
      } finally {
        config.globalUpstreamIncidentEnabled = originalIncidentEnabled
        config.upstream5xxCooldownMs = originalCooldownMs
        config.upstream5xxCooldownThreshold = originalCooldownThreshold
      }
    })

    await t.test('http relay enters upstream incident mode after multi-account 5xx burst', async () => {
      resetUpstreamState()
      const config = appConfig as {
        globalUpstreamIncidentAccountThreshold: number
        globalUpstreamIncidentCooldownMs: number
        globalUpstreamIncidentEnabled: boolean
        globalUpstreamIncidentWindowMs: number
      }
      const originalIncidentEnabled = config.globalUpstreamIncidentEnabled
      const originalIncidentThreshold = config.globalUpstreamIncidentAccountThreshold
      const originalIncidentCooldownMs = config.globalUpstreamIncidentCooldownMs
      const originalIncidentWindowMs = config.globalUpstreamIncidentWindowMs
      config.globalUpstreamIncidentEnabled = true
      config.globalUpstreamIncidentAccountThreshold = 2
      config.globalUpstreamIncidentCooldownMs = 60_000
      config.globalUpstreamIncidentWindowMs = 60_000

      try {
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token-1',
            refreshToken: 'oauth-refresh-token-1',
            createdAt: primaryCreatedAt,
          }),
          buildStoredAccount({
            id: 'account-2',
            accessToken: 'oauth-access-token-2',
            refreshToken: 'oauth-refresh-token-2',
            createdAt: secondaryCreatedAt,
          }),
        ])

        handleMessageRequest = ({ res }) => {
          res.statusCode = 500
          res.statusMessage = 'Internal Server Error'
          res.setHeader('request-id', 'http-upstream-incident-1')
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'incident' } }))
        }

        const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
        for (const accountId of ['account-1', 'account-2']) {
          const response = await sendRawHttpRequest({
            method: 'POST',
            body,
            port: relayAddress.port,
            path: '/v1/messages',
            rawRequestHeaders: [
              `Host: 127.0.0.1:${relayAddress.port}`,
              'Connection: close',
              'Content-Type: application/json',
              `Content-Length: ${body.length}`,
              `X-Request-Id: ${accountId}-incident`,
              `X-Claude-Code-Session-Id: ${accountId}-incident`,
              `X-Force-Account: ${accountId}`,
            ],
          })
          assert.equal(response.statusCode, 500, response.body)
        }

        const upstreamCountBeforeReject = upstreamRecords.http.length
        const response = await sendRawHttpRequest({
          method: 'POST',
          body,
          port: relayAddress.port,
          path: '/v1/messages',
          rawRequestHeaders: [
            `Host: 127.0.0.1:${relayAddress.port}`,
            'Connection: close',
            'Content-Type: application/json',
            `Content-Length: ${body.length}`,
            'X-Request-Id: incident-mode-auto',
            'X-Claude-Code-Session-Id: incident-mode-auto',
          ],
        })

        assert.equal(response.statusCode, 503, response.body)
        assert.match(response.body, /upstream incident/i)
        assert.equal(upstreamRecords.http.length, upstreamCountBeforeReject)
        const incidentLog = relayLogs.find((event) => event.event === 'upstream_incident_changed')
        assert.ok(incidentLog)
        assert.equal(incidentLog.affectedAccountCount, 2)
      } finally {
        config.globalUpstreamIncidentEnabled = originalIncidentEnabled
        config.globalUpstreamIncidentAccountThreshold = originalIncidentThreshold
        config.globalUpstreamIncidentCooldownMs = originalIncidentCooldownMs
        config.globalUpstreamIncidentWindowMs = originalIncidentWindowMs
      }
    })

    await t.test('session_ingress http preserves incoming auth and forwards x-last-uuid', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      handleSessionIngressRequest = ({ res }) => {
        res.statusCode = 409
        res.setHeader('content-type', 'application/json')
        res.setHeader('x-last-uuid', 'server-last-uuid-1')
        res.end(JSON.stringify({ error: { message: 'conflict' } }))
      }

      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/session_ingress/session/test-session',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer session-token-abc',
        ],
      })

      assert.equal(response.statusCode, 409, response.body)
      assert.equal(response.headers['x-last-uuid'], 'server-last-uuid-1')
      const upstreamRequest = upstreamRecords.sessionIngress.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(upstreamRequest.headers.authorization, 'Bearer session-token-abc')
    })

    await t.test('environments work poll preserves incoming auth', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/environments/env-1/work/poll',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer environment-secret-123',
          'anthropic-beta: environments-2025-11-01',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      const upstreamRequest = upstreamRecords.environmentPoll.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(
        upstreamRequest.headers.authorization,
        'Bearer environment-secret-123',
      )
    })

    await t.test('upstreamproxy ca-cert strips incoming auth and uses the selected account proxy', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      const response = await sendRawHttpRequest({
        method: 'GET',
        body: Buffer.alloc(0),
        port: relayAddress.port,
        path: '/v1/code/upstreamproxy/ca-cert',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer should-not-forward',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.match(response.body, /BEGIN CERTIFICATE/)
      const upstreamRequest = upstreamRecords.caCert.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(upstreamRequest.headers.authorization, undefined)
    })

    await t.test('upstreamproxy ws preserves incoming session token auth', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])
      const { queuedMessages, ws } = await connectWebSocket(
        `${relayBaseWsUrl}/v1/code/upstreamproxy/ws`,
        {
          headers: {
            Authorization: 'Bearer session-token-123',
            'Content-Type': 'application/proto',
          },
        },
      )

      ws.send(Buffer.from('proxy-payload'))
      const message = await waitForMessage(ws, queuedMessages)
      assert.equal(message, 'proxy-payload')

      const upstreamRequest = upstreamRecords.upstreamproxy.at(-1)
      assert.ok(upstreamRequest)
      assert.equal(upstreamRequest.headers.authorization, 'Bearer session-token-123')
      assert.equal(upstreamRequest.headers['content-type'], 'application/proto')
      const proxiedRequest = proxyRecords.ws.at(-1)
      assert.ok(proxiedRequest)
      assert.equal(proxiedRequest.path, `${upstreamBaseWsUrl}/v1/code/upstreamproxy/ws`)

      ws.close(1000, 'done')
      await waitForClose(ws)
    })

    await t.test('upstreamproxy ws can normalize VM fingerprint headers while preserving auth', async () => {
      const config = appConfig as {
        vmFingerprintTemplatePath: string | null
        vmFingerprintTemplateHeaders: Array<{ name: string, value: string }>
      }
      const originalVmFingerprintTemplatePath = config.vmFingerprintTemplatePath
      const originalVmFingerprintTemplateHeaders = config.vmFingerprintTemplateHeaders
      config.vmFingerprintTemplatePath = null
      config.vmFingerprintTemplateHeaders = [
        { name: 'User-Agent', value: 'claude-cli/2.1.92 (external, sdk-cli)' },
        { name: 'X-Stainless-Lang', value: 'js' },
      ]

      try {
        resetUpstreamState()
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            createdAt: primaryCreatedAt,
          }),
        ])
        const { queuedMessages, ws } = await connectWebSocket(
          `${relayBaseWsUrl}/v1/code/upstreamproxy/ws`,
          {
            headers: {
              Authorization: 'Bearer session-token-123',
              'User-Agent': 'claude-cli/2.1.95 (external, sdk-ts)',
              'X-Stainless-Lang': 'python',
              'anthropic-beta': 'route-beta-1',
            },
          },
        )

        ws.send(Buffer.from('proxy-payload'))
        const message = await waitForMessage(ws, queuedMessages)
        assert.equal(message, 'proxy-payload')

        const upstreamRequest = upstreamRecords.upstreamproxy.at(-1)
        assert.ok(upstreamRequest)
        assert.equal(upstreamRequest.headers.authorization, 'Bearer session-token-123')
        assert.equal(
          upstreamRequest.headers['user-agent'],
          'claude-cli/2.1.92 (external, sdk-cli)',
        )
        assert.equal(upstreamRequest.headers['x-stainless-lang'], 'js')
        assert.equal(
          upstreamRequest.headers['anthropic-beta'],
          'route-beta-1',
        )

        ws.close(1000, 'done')
        await waitForClose(ws)
      } finally {
        config.vmFingerprintTemplatePath = originalVmFingerprintTemplatePath
        config.vmFingerprintTemplateHeaders = originalVmFingerprintTemplateHeaders
      }
    })

    await t.test('voice stream ws rejection preserves upstream status headers and body', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])

      const response = await connectWebSocketExpectFailure(
        `${relayBaseWsUrl}/api/ws/speech_to_text/voice_stream`,
        {
          Authorization: 'Bearer incoming-voice-token',
        },
      )

      assert.equal(response.statusCode, 403)
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
      assert.equal(response.headers['cf-ray'], 'voice-ray-1')
      assert.equal(response.headers['cf-mitigated'], 'challenge')
      assert.equal(response.headers['x-last-request-id'], 'upstream-last-voice-1')
      assert.equal(
        response.body,
        JSON.stringify({
          error: 'cf_challenge',
          message: 'cloudflare challenge',
        }),
      )

      const rejectionLog = relayLogs.find((event) => event.event === 'ws_rejected')
      assert.ok(rejectionLog)
      assert.equal(rejectionLog.statusCode, 403)
      assert.equal(rejectionLog.upstreamRay, 'voice-ray-1')
      assert.equal(rejectionLog.upstreamRequestId, 'upstream-last-voice-1')
      const proxiedRequest = proxyRecords.ws.at(-1)
      assert.ok(proxiedRequest)
      assert.equal(
        proxiedRequest.path,
        `${upstreamBaseWsUrl}/api/ws/speech_to_text/voice_stream`,
      )
    })

    await t.test('http non-oauth routes use the selected account proxy instead of a global proxy', async () => {
      const config = appConfig as {
        upstreamProxyUrl: string | null
      }
      const originalUpstreamProxyUrl = config.upstreamProxyUrl
      config.upstreamProxyUrl = null

      try {
        resetUpstreamState()
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            createdAt: primaryCreatedAt,
          }),
        ])
        const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
        const response = await sendRawHttpRequest({
          body,
          port: relayAddress.port,
          path: '/v1/messages',
          rawRequestHeaders: [
            `Host: 127.0.0.1:${relayAddress.port}`,
            'Connection: close',
            'Authorization: Bearer incoming-client-token',
            'Content-Type: application/json',
            `Content-Length: ${body.length}`,
          ],
        })

        assert.equal(response.statusCode, 200, response.body)
        assert.equal(proxyRecords.http.length, 1)
        assert.equal(upstreamRecords.http.length, 1)
        assert.equal(upstreamRecords.http[0]?.headers.authorization, 'Bearer incoming-client-token')
      } finally {
        config.upstreamProxyUrl = originalUpstreamProxyUrl
      }
    })

    await t.test('http relay fails closed when oauth account proxy is missing', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
          proxyUrl: null,
        }),
      ])
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 503, response.body)
      assert.match(response.body, /Service is temporarily unavailable\. Please try again later\./)
      assert.doesNotMatch(response.body, /account-1/)
      assert.doesNotMatch(response.body, /proxy configured/)
      assert.equal(proxyRecords.http.length, 0)
      assert.equal(upstreamRecords.http.length, 0)
    })

    await t.test('websocket non-oauth routes use the selected account proxy instead of a global proxy', async () => {
      const config = appConfig as {
        upstreamProxyUrl: string | null
      }
      const originalUpstreamProxyUrl = config.upstreamProxyUrl
      config.upstreamProxyUrl = null

      try {
        resetUpstreamState()
        await seedAccounts([
          buildStoredAccount({
            id: 'account-1',
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            createdAt: primaryCreatedAt,
          }),
        ])
        const { ws } = await connectWebSocket(
          `${relayBaseWsUrl}/v1/code/upstreamproxy/ws`,
          {
            headers: {
              Authorization: 'Bearer session-token-123',
            },
          },
        )
        ws.close()

        assert.equal(proxyRecords.ws.length, 1)
        assert.equal(upstreamRecords.upstreamproxy.length, 1)
      } finally {
        config.upstreamProxyUrl = originalUpstreamProxyUrl
      }
    })

    await t.test('websocket relay fails closed when oauth account proxy is missing', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
          proxyUrl: null,
        }),
      ])

      const response = await connectWebSocketExpectFailure(
        `${relayBaseWsUrl}/v1/sessions/ws/test-session/subscribe?organization_uuid=org-1`,
      )

      assert.equal(response.statusCode, 503)
      assert.match(response.body, /Service is temporarily unavailable\. Please try again later\./)
      assert.doesNotMatch(response.body, /account-1/)
      assert.doesNotMatch(response.body, /proxy configured/)
      assert.equal(proxyRecords.ws.length, 0)
      assert.equal(upstreamRecords.sessions.length, 0)
    })

    await t.test('default selection round-robins across accounts without sticky session', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const rawRequestHeaders = [
        `Host: 127.0.0.1:${relayAddress.port}`,
        'Connection: close',
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
      ]

      const first = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages?request=1',
        rawRequestHeaders,
      })
      const second = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages?request=2',
        rawRequestHeaders,
      })

      assert.equal(first.statusCode, 200, first.body)
      assert.equal(second.statusCode, 200, second.body)
      // Scheduler uses least-recently-selected: first request picks account-1 (older createdAt),
      // second request picks account-2 (its lastSelectedAt is still null).
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token', 'Bearer oauth-access-token-2'],
      )
    })

    await t.test('401 recovery refreshes the same account instead of rotating', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-stale',
          refreshToken: 'oauth-refresh-token-stale',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      handleMessageRequest = ({ req, res }) => {
        if (req.headers.authorization === 'Bearer oauth-access-token-stale') {
          res.statusCode = 401
          res.end('OAuth token has been revoked')
          return
        }
        if (req.headers.authorization === 'Bearer oauth-access-token-refreshed') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, refreshed: true }))
          return
        }
        res.statusCode = 500
        res.end(`unexpected auth: ${req.headers.authorization ?? 'none'}`)
      }
      handleOAuthTokenRequest = ({ body, res }) => {
        const payload = JSON.parse(body.toString('utf8')) as {
          grant_type?: string
          refresh_token?: string
        }
        assert.equal(payload.grant_type, 'refresh_token')
        assert.equal(payload.refresh_token, 'oauth-refresh-token-stale')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          access_token: 'oauth-access-token-refreshed',
          refresh_token: 'oauth-refresh-token-fresh',
          expires_in: 3600,
          scope: 'user:inference',
        }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.equal(upstreamRecords.oauthTokenGrants.length, 1)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-stale', 'Bearer oauth-access-token-refreshed'],
      )
    })

    await t.test('401 recovery failure does not rotate to another account', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-stale',
          refreshToken: 'oauth-refresh-token-stale',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      handleMessageRequest = ({ req, res }) => {
        if (req.headers.authorization === 'Bearer oauth-access-token-stale') {
          res.statusCode = 401
          res.end('OAuth token has been revoked')
          return
        }
        res.statusCode = 500
        res.end(`unexpected auth: ${req.headers.authorization ?? 'none'}`)
      }
      handleOAuthTokenRequest = ({ body, res }) => {
        const payload = JSON.parse(body.toString('utf8')) as {
          grant_type?: string
          refresh_token?: string
        }
        assert.equal(payload.grant_type, 'refresh_token')
        assert.equal(payload.refresh_token, 'oauth-refresh-token-stale')
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'revoked',
        }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 401, response.body)
      assert.match(response.body, /revoked/i)
      assert.equal(upstreamRecords.oauthTokenGrants.length, 1)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-stale'],
      )
    })

    await t.test('disabled organization auth failures revoke the account and migrate the session', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-disabled-org',
          refreshToken: 'oauth-refresh-token-disabled-org',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])
      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'disabled-org-session',
        accountId: 'account-1',
      })

      handleMessageRequest = ({ req, res }) => {
        if (req.headers.authorization === 'Bearer oauth-access-token-disabled-org') {
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            error: {
              type: 'authentication_error',
              message:
                'Your ANTHROPIC_API_KEY belongs to a disabled organization. Update or unset the environment variable.',
            },
          }))
          return
        }
        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          'X-Claude-Code-Session-Id: disabled-org-session',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-disabled-org', 'Bearer oauth-access-token-2'],
      )
      assert.equal(upstreamRecords.oauthTokenGrants.length, 0)

      const data = await tokenStore.getData()
      const disabledAccount = data.accounts.find((account) => account.id === 'account-1')
      assert.ok(disabledAccount)
      assert.equal(disabledAccount.isActive, false)
      assert.equal(disabledAccount.status, 'revoked')
      assert.equal(disabledAccount.schedulerState, 'paused')
      assert.equal(disabledAccount.autoBlockedReason, 'account_disabled_organization')
      assert.match(disabledAccount.lastError ?? '', /account_disabled_organization/)

      const route = await memoryUserStore.getSessionRoute('disabled-org-session')
      assert.ok(route)
      assert.equal(route.accountId, 'account-2')
      assert.equal(route.lastHandoffReason, 'account_disabled_organization')
      const [handoff] = await memoryUserStore.listSessionHandoffs()
      assert.ok(handoff)
      assert.equal(handoff.fromAccountId, 'account-1')
      assert.equal(handoff.toAccountId, 'account-2')
      assert.equal(handoff.reason, 'account_disabled_organization')
    })

    await t.test('disabled organization 400 failures rotate account pools without sticky session', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-disabled-org',
          refreshToken: 'oauth-refresh-token-disabled-org',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      handleMessageRequest = ({ req, res }) => {
        if (req.headers.authorization === 'Bearer oauth-access-token-disabled-org') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message:
                'Your ANTHROPIC_API_KEY belongs to a disabled organization. Update or unset the environment variable.',
            },
          }))
          return
        }
        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-disabled-org', 'Bearer oauth-access-token-2'],
      )
      assert.equal(upstreamRecords.oauthTokenGrants.length, 0)

      const data = await tokenStore.getData()
      const disabledAccount = data.accounts.find((account) => account.id === 'account-1')
      assert.ok(disabledAccount)
      assert.equal(disabledAccount.isActive, false)
      assert.equal(disabledAccount.status, 'revoked')
      assert.equal(disabledAccount.schedulerState, 'paused')
      assert.equal(disabledAccount.autoBlockedReason, 'account_disabled_organization')
      assert.match(disabledAccount.lastError ?? '', /account_disabled_organization/)
      assert.equal((await memoryUserStore.listSessionHandoffs()).length, 0)
    })

    await t.test('disabled organization wording rotates official accounts for count tokens', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-disabled-org',
          refreshToken: 'oauth-refresh-token-disabled-org',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      handleMessageRequest = ({ req, res }) => {
        if (req.headers.authorization === 'Bearer oauth-access-token-disabled-org') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'This organization has been disabled.',
            },
          }))
          return
        }
        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ input_tokens: 1 }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages/count_tokens',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-disabled-org', 'Bearer oauth-access-token-2'],
      )

      const data = await tokenStore.getData()
      const disabledAccount = data.accounts.find((account) => account.id === 'account-1')
      assert.ok(disabledAccount)
      assert.equal(disabledAccount.isActive, false)
      assert.equal(disabledAccount.status, 'revoked')
      assert.equal(disabledAccount.schedulerState, 'paused')
      assert.equal(disabledAccount.autoBlockedReason, 'account_disabled_organization')
    })

    await t.test('disabled organization failures rotate claude-compatible api key accounts', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'claude-compatible:account-1',
          provider: 'claude-compatible',
          protocol: 'claude',
          authMode: 'api_key',
          accessToken: 'claude-compatible-key-disabled',
          refreshToken: null,
          createdAt: primaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'claude-sonnet-4-5',
          proxyUrl: null,
        }),
        buildStoredAccount({
          id: 'claude-compatible:account-2',
          provider: 'claude-compatible',
          protocol: 'claude',
          authMode: 'api_key',
          accessToken: 'claude-compatible-key-2',
          refreshToken: null,
          createdAt: secondaryCreatedAt,
          apiBaseUrl: upstreamBaseUrl,
          modelName: 'claude-sonnet-4-5',
          proxyUrl: null,
        }),
      ])

      handleMessageRequest = ({ req, res }) => {
        if (req.headers['x-api-key'] === 'claude-compatible-key-disabled') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message:
                'Your ANTHROPIC_API_KEY belongs to a disabled organization. Update or unset the environment variable.',
            },
          }))
          return
        }
        assert.equal(req.headers['x-api-key'], 'claude-compatible-key-2')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'x-api-key'),
        ),
        ['claude-compatible-key-disabled', 'claude-compatible-key-2'],
      )

      const data = await tokenStore.getData()
      const disabledAccount = data.accounts.find((account) =>
        account.id === 'claude-compatible:account-1'
      )
      assert.ok(disabledAccount)
      assert.equal(disabledAccount.isActive, false)
      assert.equal(disabledAccount.status, 'revoked')
      assert.equal(disabledAccount.schedulerState, 'paused')
      assert.equal(disabledAccount.autoBlockedReason, 'account_disabled_organization')
      assert.match(disabledAccount.lastError ?? '', /account_disabled_organization/)
    })

    await t.test('429 rate limits return the original failure, then the next request migrates with compressed context', async () => {
      const config = appConfig as { sameRequestSessionMigrationEnabled: boolean }
      const originalSameRequestMigrationEnabled = config.sameRequestSessionMigrationEnabled
      config.sameRequestSessionMigrationEnabled = false
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'session-migrate-1',
        accountId: 'account-1',
      })

      let attempt = 0
      handleMessageRequest = ({ body, req, res }) => {
        const parsed = JSON.parse(body.toString('utf8')) as {
          system?: Array<{ type?: string; text?: string }>
        }

        if (attempt === 0) {
          attempt += 1
          assert.equal(req.headers.authorization, 'Bearer oauth-access-token-1')
          res.statusCode = 429
          res.setHeader('content-type', 'application/json')
          res.setHeader('anthropic-ratelimit-unified-status', 'rejected')
          res.setHeader('anthropic-ratelimit-unified-5h-utilization', '1')
          res.setHeader('anthropic-ratelimit-unified-7d-utilization', '1')
          res.setHeader('anthropic-ratelimit-unified-reset', '1234567890')
          res.end(JSON.stringify({ error: { message: 'rate limited' } }))
          return
        }

        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        assert.notEqual(req.headers['x-claude-code-session-id'], 'session-migrate-1')
        assert.equal(
          req.headers['x-claude-remote-session-id'],
          req.headers['x-claude-code-session-id'],
        )
        assert.ok(Array.isArray(parsed.system))
        assert.match(parsed.system?.at(-1)?.text ?? '', /压缩背景/)
        assert.doesNotMatch(parsed.system?.at(-1)?.text ?? '', /relay_handoff_summary=true/)
        assert.doesNotMatch(parsed.system?.at(-1)?.text ?? '', /account-1/)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, migrated: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const firstResponse = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Claude-Code-Session-Id: session-migrate-1',
        ],
      })

      assert.equal(firstResponse.statusCode, 429, firstResponse.body)
      assert.equal(upstreamRecords.http.length, 1)

      let route = await memoryUserStore.getSessionRoute('session-migrate-1')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-1')
      assert.equal(route?.generation, 1)

      const secondResponse = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Claude-Code-Session-Id: session-migrate-1',
        ],
      })

      assert.equal(secondResponse.statusCode, 200, secondResponse.body)
      assert.equal(upstreamRecords.http.length, 2)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-1', 'Bearer oauth-access-token-2'],
      )

      route = await memoryUserStore.getSessionRoute('session-migrate-1')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-2')
      assert.equal(route?.generation, 2)
      assert.equal(route?.pendingHandoffSummary, null)

      const [handoff] = await memoryUserStore.listSessionHandoffs()
      assert.ok(handoff)
      assert.equal(handoff.fromAccountId, 'account-1')
      assert.equal(handoff.toAccountId, 'account-2')
      assert.equal(handoff.reason, 'rate_limit:rejected')
      config.sameRequestSessionMigrationEnabled = originalSameRequestMigrationEnabled
    })

    await t.test('wrapped 403 quota failures migrate within the same request', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'session-migrate-wrapped-1',
        accountId: 'account-1',
      })

      let attempt = 0
      handleMessageRequest = ({ body, req, res }) => {
        const parsed = JSON.parse(body.toString('utf8')) as {
          system?: Array<{ type?: string; text?: string }>
        }

        if (attempt === 0) {
          attempt += 1
          assert.equal(req.headers.authorization, 'Bearer oauth-access-token-1')
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            error: { code: 'E014', message: 'Quota exceeded' },
            status: 429,
          }))
          return
        }

        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        assert.notEqual(req.headers['x-claude-code-session-id'], 'session-migrate-wrapped-1')
        assert.equal(
          req.headers['x-claude-remote-session-id'],
          req.headers['x-claude-code-session-id'],
        )
        assert.ok(Array.isArray(parsed.system))
        assert.match(parsed.system?.at(-1)?.text ?? '', /压缩背景/)
        assert.doesNotMatch(parsed.system?.at(-1)?.text ?? '', /account-1/)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, migrated: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Claude-Code-Session-Id: session-migrate-wrapped-1',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.equal(upstreamRecords.http.length, 2)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-1', 'Bearer oauth-access-token-2'],
      )

      let route = await memoryUserStore.getSessionRoute('session-migrate-wrapped-1')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-2')
      assert.equal(route?.generation, 2)
      assert.equal(route?.pendingHandoffSummary, null)

      const [handoff] = await memoryUserStore.listSessionHandoffs()
      assert.ok(handoff)
      assert.equal(handoff.fromAccountId, 'account-1')
      assert.equal(handoff.toAccountId, 'account-2')
      assert.equal(handoff.reason, 'rate_limit:blocked')
    })

    await t.test('long context incompatible 400 failures migrate within the same request', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'session-migrate-long-context-400',
        accountId: 'account-1',
      })

      let attempt = 0
      handleMessageRequest = ({ req, res }) => {
        if (attempt === 0) {
          attempt += 1
          assert.equal(req.headers.authorization, 'Bearer oauth-access-token-1')
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'This authentication style is incompatible with the long context beta header.',
            },
          }))
          return
        }

        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        assert.notEqual(req.headers['x-claude-code-session-id'], 'session-migrate-long-context-400')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, migrated: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Claude-Code-Session-Id: session-migrate-long-context-400',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.equal(upstreamRecords.http.length, 2)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-1', 'Bearer oauth-access-token-2'],
      )

      const route = await memoryUserStore.getSessionRoute('session-migrate-long-context-400')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-2')
      assert.equal(route?.generation, 2)

      const [handoff] = await memoryUserStore.listSessionHandoffs()
      assert.ok(handoff)
      assert.equal(handoff.reason, 'long_context_incompatible')
    })

    await t.test('long context extra usage 429 failures migrate within the same request', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'session-migrate-long-context-429',
        accountId: 'account-1',
      })

      let attempt = 0
      handleMessageRequest = ({ req, res }) => {
        if (attempt === 0) {
          attempt += 1
          assert.equal(req.headers.authorization, 'Bearer oauth-access-token-1')
          res.statusCode = 429
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            error: {
              type: 'rate_limit_error',
              message: 'Extra usage is required for long context requests.',
            },
          }))
          return
        }

        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        assert.notEqual(req.headers['x-claude-code-session-id'], 'session-migrate-long-context-429')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, migrated: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Claude-Code-Session-Id: session-migrate-long-context-429',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.equal(upstreamRecords.http.length, 2)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-1', 'Bearer oauth-access-token-2'],
      )

      const route = await memoryUserStore.getSessionRoute('session-migrate-long-context-429')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-2')
      assert.equal(route?.generation, 2)

      const [handoff] = await memoryUserStore.listSessionHandoffs()
      assert.ok(handoff)
      assert.equal(handoff.reason, 'long_context_extra_usage_required')
    })

    await t.test('429 throttled failures with retry-after=0 migrate within the same request', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
        buildStoredAccount({
          id: 'account-2',
          accessToken: 'oauth-access-token-2',
          refreshToken: 'oauth-refresh-token-2',
          createdAt: secondaryCreatedAt,
        }),
      ])

      await memoryUserStore.ensureSessionRoute({
        sessionKey: 'session-migrate-retry-after-zero-1',
        accountId: 'account-1',
      })

      let attempt = 0
      handleMessageRequest = ({ body, req, res }) => {
        const parsed = JSON.parse(body.toString('utf8')) as {
          system?: Array<{ type?: string; text?: string }>
        }

        if (attempt === 0) {
          attempt += 1
          assert.equal(req.headers.authorization, 'Bearer oauth-access-token-1')
          res.statusCode = 429
          res.setHeader('content-type', 'application/json')
          res.setHeader('retry-after', '0')
          res.setHeader('anthropic-ratelimit-unified-status', 'throttled')
          res.end(JSON.stringify({ error: { message: 'rate limited' } }))
          return
        }

        assert.equal(req.headers.authorization, 'Bearer oauth-access-token-2')
        assert.notEqual(req.headers['x-claude-code-session-id'], 'session-migrate-retry-after-zero-1')
        assert.equal(
          req.headers['x-claude-remote-session-id'],
          req.headers['x-claude-code-session-id'],
        )
        assert.ok(Array.isArray(parsed.system))
        assert.match(parsed.system?.at(-1)?.text ?? '', /压缩背景/)
        assert.doesNotMatch(parsed.system?.at(-1)?.text ?? '', /account-1/)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, migrated: true }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Claude-Code-Session-Id: session-migrate-retry-after-zero-1',
        ],
      })

      assert.equal(response.statusCode, 200, response.body)
      assert.equal(upstreamRecords.http.length, 2)
      assert.deepEqual(
        upstreamRecords.http.map((request) =>
          getFirstHeaderValue(request.rawHeaders ?? [], 'Authorization'),
        ),
        ['Bearer oauth-access-token-1', 'Bearer oauth-access-token-2'],
      )

      const route = await memoryUserStore.getSessionRoute('session-migrate-retry-after-zero-1')
      assert.ok(route)
      assert.equal(route?.accountId, 'account-2')
      assert.equal(route?.generation, 2)
      assert.equal(route?.pendingHandoffSummary, null)

      const [handoff] = await memoryUserStore.listSessionHandoffs()
      assert.ok(handoff)
      assert.equal(handoff.fromAccountId, 'account-1')
      assert.equal(handoff.toAccountId, 'account-2')
      assert.equal(handoff.reason, 'rate_limit:throttled')
    })

    await t.test('429 migration fallback preserves the original upstream response body', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token-1',
          refreshToken: 'oauth-refresh-token-1',
          createdAt: primaryCreatedAt,
        }),
      ])

      handleMessageRequest = ({ res }) => {
        res.statusCode = 429
        res.setHeader('content-type', 'application/json')
        res.setHeader('anthropic-ratelimit-unified-status', 'rejected')
        res.setHeader('anthropic-ratelimit-unified-5h-utilization', '1')
        res.setHeader('anthropic-ratelimit-unified-7d-utilization', '1')
        res.setHeader('anthropic-ratelimit-unified-reset', '1234567890')
        res.end(JSON.stringify({ error: { message: 'blocked after failed migration' } }))
      }

      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')
      const response = await sendRawHttpRequest({
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          'X-Claude-Code-Session-Id: no-fallback-account',
        ],
      })

      assert.equal(response.statusCode, 429, response.body)
      assert.match(response.body, /blocked after failed migration/)
      assert.equal(upstreamRecords.http.length, 1)
    })

    await t.test('unified rate-limit headers are forwarded to the client', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      handleMessageRequest = ({ res }) => {
        res.statusCode = 429
        res.setHeader('content-type', 'application/json')
        res.setHeader('retry-after', '17')
        res.setHeader('anthropic-ratelimit-unified-status', 'rejected')
        res.setHeader('anthropic-ratelimit-unified-reset', '1234567890')
        res.setHeader('anthropic-ratelimit-unified-overage-status', 'allowed')
        res.setHeader('anthropic-ratelimit-unified-overage-reset', '1234567900')
        res.setHeader('anthropic-ratelimit-unified-representative-claim', 'five_hour')
        res.setHeader('anthropic-ratelimit-unified-fallback', 'available')
        res.end(JSON.stringify({ error: { message: 'rate limited' } }))
      }
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')

      const response = await sendRawHttpRequest({
        method: 'POST',
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 429, response.body)
      assert.equal(response.headers['retry-after'], '17')
      assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected')
      assert.equal(response.headers['anthropic-ratelimit-unified-reset'], '1234567890')
      assert.equal(response.headers['anthropic-ratelimit-unified-overage-status'], 'allowed')
      assert.equal(
        response.headers['anthropic-ratelimit-unified-representative-claim'],
        'five_hour',
      )
      assert.equal(response.headers['anthropic-ratelimit-unified-fallback'], 'available')
    })

    await t.test('http relay forwards non-allowlisted upstream response headers', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      handleMessageRequest = ({ res }) => {
        res.statusCode = 429
        res.setHeader('content-type', 'application/json')
        res.setHeader('cf-ray', 'http-ray-1')
        res.setHeader('cf-mitigated', 'challenge')
        res.setHeader('x-upstream-extra', 'extra-value')
        res.end(JSON.stringify({ error: { message: 'blocked' } }))
      }
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')

      const response = await sendRawHttpRequest({
        method: 'POST',
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 429, response.body)
      assert.equal(response.headers['cf-ray'], 'http-ray-1')
      assert.equal(response.headers['cf-mitigated'], 'challenge')
      assert.equal(response.headers['x-upstream-extra'], 'extra-value')
    })

    await t.test('http relay preserves upstream status text and duplicate response headers', async () => {
      resetUpstreamState()
      await seedAccounts([
        buildStoredAccount({
          id: 'account-1',
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          createdAt: primaryCreatedAt,
        }),
      ])
      handleMessageRequest = ({ res }) => {
        res.statusCode = 429
        res.statusMessage = 'Anthropic Custom Block'
        res.setHeader('content-type', 'application/json')
        res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/'])
        res.setHeader('x-trace-hop', ['hop-1', 'hop-2'])
        res.end(JSON.stringify({ error: { message: 'blocked twice' } }))
      }
      const body = Buffer.from('{"model":"claude","messages":[{"role":"user","content":"hi"}]}')

      const response = await sendRawHttpRequest({
        method: 'POST',
        body,
        port: relayAddress.port,
        path: '/v1/messages',
        rawRequestHeaders: [
          `Host: 127.0.0.1:${relayAddress.port}`,
          'Connection: close',
          'Authorization: Bearer incoming-client-token',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
        ],
      })

      assert.equal(response.statusCode, 429, response.body)
      assert.equal(response.statusMessage, 'Anthropic Custom Block')
      assert.deepEqual(
        getAllHeaderValues(response.rawHeaders, 'set-cookie'),
        ['a=1; Path=/', 'b=2; Path=/'],
      )
      assert.deepEqual(
        getAllHeaderValues(response.rawHeaders, 'x-trace-hop'),
        ['hop-1', 'hop-2'],
      )
    })
  } finally {
    if (relayHttpServer) {
      await new Promise<void>((resolve) => relayHttpServer!.close(() => resolve()))
    }
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()))
    if (proxy1) await new Promise<void>((resolve) => proxy1!.close(() => resolve()))
    if (proxy2) await new Promise<void>((resolve) => proxy2!.close(() => resolve()))
    sessionWss.close()
    upstreamProxyWss.close()
    await rm(tempDir, { force: true, recursive: true })
  }
})

async function connectWebSocket(
  url: string,
  options: {
    headers?: Record<string, string>
    perMessageDeflate?: boolean
    protocols?: string[]
  } = {},
): Promise<{
  queuedMessages: Array<string | Buffer>
  responseHeaders: IncomingMessage['headers']
  ws: WebSocket
}> {
  const mergedHeaders = { 'User-Agent': TEST_CLAUDE_CODE_UA, ...options.headers }
  return new Promise((resolve, reject) => {
    const ws = options.protocols && options.protocols.length > 0
      ? new WebSocket(url, options.protocols, {
          headers: mergedHeaders,
          perMessageDeflate: options.perMessageDeflate,
        })
      : new WebSocket(url, {
          headers: mergedHeaders,
          perMessageDeflate: options.perMessageDeflate,
        })
    const queuedMessages: Array<string | Buffer> = []
    let responseHeaders: IncomingMessage['headers'] = {}

    const timer = setTimeout(() => {
      reject(new Error(`WebSocket 连接超时: ${url}`))
      ws.terminate()
    }, 5000)

    ws.on('upgrade', (response) => {
      responseHeaders = response.headers
    })
    ws.on('message', (data, isBinary) => {
      queuedMessages.push(normalizeRawData(data, isBinary))
    })
    ws.once('open', () => {
      clearTimeout(timer)
      resolve({ queuedMessages, responseHeaders, ws })
    })
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      response.resume()
      reject(new Error(`Unexpected response: ${response.statusCode ?? 0}`))
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function connectWebSocketExpectFailure(
  url: string,
  headers?: Record<string, string>,
): Promise<{
  body: string
  headers: IncomingMessage['headers']
  statusCode: number
}> {
  const mergedHeaders = { 'User-Agent': TEST_CLAUDE_CODE_UA, ...headers }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: mergedHeaders,
    })

    const timer = setTimeout(() => {
      reject(new Error(`WebSocket 连接超时: ${url}`))
      ws.terminate()
    }, 5000)

    ws.once('open', () => {
      clearTimeout(timer)
      ws.terminate()
      reject(new Error(`Expected WebSocket failure: ${url}`))
    })
    ws.once('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        clearTimeout(timer)
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
          statusCode: response.statusCode ?? 0,
        })
      })
      response.on('error', reject)
      response.resume()
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

const TEST_CLAUDE_CODE_UA = 'claude-cli/2.1.95 (external, sdk-ts)'

async function waitForCondition(
  check: () => boolean,
  timeoutMs: number = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (!check()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function sendRawHttpRequest(input: {
  body: Buffer
  method?: 'GET' | 'POST'
  path: string
  port: number
  rawRequestHeaders: string[]
}): Promise<{
  body: string
  headers: Record<string, string>
  rawHeaders: string[]
  statusCode: number
  statusMessage: string
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port: input.port,
    })

    const responseChunks: Buffer[] = []
    const hasUserAgent = input.rawRequestHeaders.some(
      (h) => h.toLowerCase().startsWith('user-agent:'),
    )
    const headers = hasUserAgent
      ? input.rawRequestHeaders
      : [`User-Agent: ${TEST_CLAUDE_CODE_UA}`, ...input.rawRequestHeaders]

    socket.on('connect', () => {
      const requestHead = [
        `${input.method ?? 'POST'} ${input.path} HTTP/1.1`,
        ...headers,
        '',
        '',
      ].join('\r\n')
      socket.write(Buffer.concat([Buffer.from(requestHead, 'utf8'), input.body]))
    })
    socket.on('data', (chunk) => {
      responseChunks.push(Buffer.from(chunk))
    })
    socket.on('error', reject)
    socket.on('end', () => {
      const responseBuffer = Buffer.concat(responseChunks)
      const separatorIndex = responseBuffer.indexOf('\r\n\r\n')
      const head = responseBuffer.subarray(0, separatorIndex).toString('utf8')
      const body = responseBuffer.subarray(separatorIndex + 4).toString('utf8')
      const headerLines = head.split('\r\n')
      const statusLine = headerLines[0] ?? ''
      const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/)
      const headers: Record<string, string> = {}
      const rawHeaders: string[] = []
      for (const line of headerLines.slice(1)) {
        const separator = line.indexOf(':')
        if (separator <= 0) {
          continue
        }
        const rawName = line.slice(0, separator).trim()
        const value = line.slice(separator + 1).trim()
        const name = rawName.toLowerCase()
        rawHeaders.push(rawName, value)
        headers[name] = value
      }
      resolve({
        body,
        headers,
        rawHeaders,
        statusCode: match ? Number(match[1]) : 0,
        statusMessage: match?.[2] ?? '',
      })
    })
  })
}

async function waitForMessage(
  ws: WebSocket,
  queuedMessages: Array<string | Buffer>,
): Promise<string> {
  const queued = queuedMessages.shift()
  if (queued !== undefined) {
    return typeof queued === 'string' ? queued : queued.toString('utf8')
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('等待 WebSocket 消息超时'))
    }, 5000)

    ws.once('message', (data, isBinary) => {
      clearTimeout(timer)
      const normalized = normalizeRawData(data, isBinary)
      resolve(typeof normalized === 'string' ? normalized : normalized.toString('utf8'))
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    ws.once('close', () => resolve())
  })
}

function normalizeRawData(data: RawData, isBinary: boolean): string | Buffer {
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

function buildStoredAccount(input: {
  id: string
  accessToken: string
  refreshToken: string | null
  createdAt: string
  label?: string
  emailAddress?: string
  expiresAt?: number | null
  isActive?: boolean
  status?: StoredAccount['status']
  proxyUrl?: string | null
  provider?: StoredAccount['provider']
  protocol?: StoredAccount['protocol']
  authMode?: StoredAccount['authMode']
  apiBaseUrl?: string | null
  modelName?: string | null
  routingGroupId?: string | null
  group?: string | null
  schedulerEnabled?: boolean
  schedulerState?: StoredAccount['schedulerState']
  autoBlockedReason?: string | null
  autoBlockedUntil?: number | null
  lastRateLimitStatus?: string | null
}): StoredAccount {
  const nowIso = input.createdAt
  return {
    id: input.id,
    provider: input.provider ?? 'claude-official',
    protocol: input.protocol ?? 'claude',
    authMode: input.authMode ?? 'oauth',
    label: input.label ?? input.id,
    isActive: input.isActive ?? true,
    status: input.status ?? 'active',
    lastSelectedAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    lastFailureAt: null,
    cooldownUntil: null,
    lastError: null,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt ?? Date.now() + 60 * 60 * 1000,
    scopes: ['user:inference'],
    createdAt: nowIso,
    updatedAt: nowIso,
    subscriptionType: 'max',
    rateLimitTier: null,
    accountUuid: input.id,
    organizationUuid: `org-${input.id}`,
    emailAddress: input.emailAddress ?? `${input.id}@example.com`,
    displayName: input.id,
    hasExtraUsageEnabled: null,
    billingType: null,
    accountCreatedAt: null,
    subscriptionCreatedAt: null,
    rawProfile: null,
    roles: null,
    routingGroupId: input.routingGroupId ?? input.group ?? null,
    group: input.group ?? input.routingGroupId ?? null,
    maxSessions: null,
    weight: null,
    schedulerEnabled: input.schedulerEnabled ?? true,
    schedulerState: input.schedulerState ?? 'enabled',
    autoBlockedReason: input.autoBlockedReason ?? null,
    autoBlockedUntil: input.autoBlockedUntil ?? null,
    lastRateLimitStatus: input.lastRateLimitStatus ?? null,
    lastRateLimit5hUtilization: null,
    lastRateLimit7dUtilization: null,
    lastRateLimitReset: null,
    lastRateLimitAt: null,
    lastProbeAttemptAt: null,
    proxyUrl: input.proxyUrl !== undefined ? input.proxyUrl : (testProxyUrls[input.id] ?? null),
    bodyTemplatePath: null,
    vmFingerprintTemplatePath: null,
    deviceId: null,
    apiBaseUrl: input.apiBaseUrl ?? null,
    modelName: input.modelName ?? null,
    modelTierMap: null,
    loginPassword: null,
  }
}

function toForwardProxyUpgradeHeaders(rawHeaders: string[], targetHost: string): string[] {
  const forwarded: string[] = []

  for (let index = 0; index < rawHeaders.length - 1; index += 2) {
    const name = rawHeaders[index] ?? ''
    const value = rawHeaders[index + 1] ?? ''
    const lowerName = name.toLowerCase()

    if (lowerName === 'proxy-connection') {
      continue
    }
    if (lowerName === 'host') {
      continue
    }

    forwarded.push(`${name}: ${value}`)
  }

  forwarded.push(`Host: ${targetHost}`)
  return forwarded
}

function getAllHeaderValues(rawHeaders: string[], targetName: string): string[] {
  const normalizedTarget = targetName.toLowerCase()
  const values: string[] = []

  for (let index = 0; index < rawHeaders.length - 1; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === normalizedTarget) {
      values.push(rawHeaders[index + 1] ?? '')
    }
  }

  return values
}

function getFirstHeaderValue(rawHeaders: string[], targetName: string): string | null {
  return getAllHeaderValues(rawHeaders, targetName)[0] ?? null
}

function expectedAnthropicBeta(
  betaHeader: string | undefined,
  authMode: 'oauth' | 'api_key' = 'oauth',
  incomingBetaValues: readonly string[] = [],
  strippedTokens: readonly string[] = [],
): string {
  const betas: string[] = []
  const seen = new Set<string>()
  const stripped = new Set(strippedTokens.map((token) => token.trim()).filter(Boolean))

  const push = (raw: string): void => {
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed) || stripped.has(trimmed)) return
    seen.add(trimmed)
    betas.push(trimmed)
  }

  for (const token of (betaHeader ?? '').split(',')) push(token)
  for (const raw of incomingBetaValues) {
    for (const token of raw.split(',')) push(token)
  }
  if (authMode === 'oauth') push('oauth-2025-04-20')

  return betas.join(',')
}
