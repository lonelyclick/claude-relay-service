import http from 'node:http'

import { appConfig } from '../config.js'
import type { StoredAccount } from '../types.js'
import {
  getGeminiLoopbackRedirectUri,
  parseGeminiCallback,
} from '../providers/googleGeminiOauth.js'
import type { OAuthService } from './service.js'

const LOGIN_TTL_MS = 10 * 60 * 1000

type PendingLogin = {
  sessionId: string
  state: string
  status: 'pending' | 'completed' | 'failed'
  account?: StoredAccount
  error?: string
  createdAt: number
  options: GeminiLoginStartOptions
  resolve?: (value: void) => void
}

export type GeminiLoginStartOptions = {
  label?: string | null
  proxyUrl?: string | null
  modelName?: string | null
  routingGroupId?: string | null
  group?: string | null
  accountId?: string | null
}

export class GeminiLoopbackController {
  private server: http.Server | null = null
  private listening: Promise<void> | null = null
  private readonly pending = new Map<string, PendingLogin>()
  private readonly stateToSession = new Map<string, string>()

  constructor(private readonly oauthService: OAuthService) {}

  private isEnabled(): boolean {
    return appConfig.geminiOauthLoopbackPort > 0
  }

  async ensureListening(): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('Gemini loopback OAuth is disabled (GEMINI_OAUTH_LOOPBACK_PORT=0)')
    }
    if (this.server && this.server.listening) {
      return
    }
    if (this.listening) {
      await this.listening
      return
    }
    this.listening = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      server.once('error', (error) => {
        this.server = null
        this.listening = null
        reject(error)
      })
      server.listen(
        appConfig.geminiOauthLoopbackPort,
        appConfig.geminiOauthLoopbackHost,
        () => {
          this.server = server
          resolve()
        },
      )
    })
    await this.listening
  }

  async startLogin(options: GeminiLoginStartOptions): Promise<{
    sessionId: string
    authUrl: string
    redirectUri: string
    expiresAt: string
  }> {
    if (!this.isEnabled()) {
      throw new Error('Gemini loopback OAuth is disabled')
    }
    await this.ensureListening()
    this.evictExpired()
    const session = this.oauthService.createAuthSession({ provider: 'google-gemini-oauth' })
    const stateMatch = new URL(session.authUrl).searchParams.get('state')
    if (!stateMatch) {
      throw new Error('startLogin: state missing from generated authUrl')
    }
    const pending: PendingLogin = {
      sessionId: session.sessionId,
      state: stateMatch,
      status: 'pending',
      createdAt: Date.now(),
      options,
    }
    this.pending.set(session.sessionId, pending)
    this.stateToSession.set(stateMatch, session.sessionId)
    return {
      sessionId: session.sessionId,
      authUrl: session.authUrl,
      redirectUri: session.redirectUri,
      expiresAt: session.expiresAt,
    }
  }

  getStatus(sessionId: string): {
    sessionId: string
    status: 'pending' | 'completed' | 'failed' | 'unknown'
    account?: StoredAccount
    error?: string
  } {
    this.evictExpired()
    const pending = this.pending.get(sessionId)
    if (!pending) {
      return { sessionId, status: 'unknown' }
    }
    return {
      sessionId,
      status: pending.status,
      account: pending.account,
      error: pending.error,
    }
  }

  async manualExchange(input: {
    callbackUrl: string
    sessionId?: string
    label?: string | null
    proxyUrl?: string | null
    modelName?: string | null
    routingGroupId?: string | null
    group?: string | null
    accountId?: string | null
  }): Promise<{ sessionId: string; account: StoredAccount }> {
    this.evictExpired()
    const trimmed = input.callbackUrl.trim()
    if (!trimmed) {
      throw new Error('callbackUrl is required')
    }
    let stateFromUrl: string | null = null
    try {
      let queryString = trimmed
      if (trimmed.startsWith('http')) {
        queryString = new URL(trimmed).search.slice(1)
      } else if (trimmed.startsWith('?')) {
        queryString = trimmed.slice(1)
      }
      stateFromUrl = new URLSearchParams(queryString).get('state')
    } catch (error) {
      throw new Error(`callbackUrl parse failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    let sessionId = input.sessionId?.trim() || ''
    let pending = sessionId ? this.pending.get(sessionId) : null
    if (!pending && stateFromUrl) {
      const found = this.stateToSession.get(stateFromUrl)
      if (found) {
        sessionId = found
        pending = this.pending.get(found) ?? null
      }
    }
    if (!pending) {
      throw new Error(
        'No matching pending Gemini login session found. Click "Start Google OAuth Login" first; the callback URL must be used within 10 minutes of the same start request.',
      )
    }
    if (pending.status === 'completed' && pending.account) {
      return { sessionId: pending.sessionId, account: pending.account }
    }
    if (pending.status === 'failed') {
      throw new Error(`Login session is already in failed state: ${pending.error ?? 'unknown error'}`)
    }

    const options = pending.options
    const account = await this.oauthService.exchangeCode({
      sessionId: pending.sessionId,
      authorizationInput: trimmed,
      label: input.label ?? options.label ?? undefined,
      accountId: input.accountId ?? options.accountId ?? undefined,
      modelName: input.modelName ?? options.modelName ?? undefined,
      proxyUrl: input.proxyUrl ?? options.proxyUrl ?? undefined,
      routingGroupId: input.routingGroupId ?? options.routingGroupId ?? undefined,
      group: input.group ?? options.group ?? undefined,
    })
    pending.status = 'completed'
    pending.account = account
    return { sessionId: pending.sessionId, account }
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [sessionId, pending] of this.pending) {
      if (now - pending.createdAt > LOGIN_TTL_MS) {
        this.pending.delete(sessionId)
        this.stateToSession.delete(pending.state)
      }
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (!req.url) {
        res.writeHead(400).end('bad request')
        return
      }
      const requestUrl = new URL(req.url, `http://${appConfig.geminiOauthLoopbackHost}:${appConfig.geminiOauthLoopbackPort}`)
      if (requestUrl.pathname !== appConfig.geminiOauthLoopbackRedirectPath) {
        res.writeHead(404).end('not found')
        return
      }
      const queryParams = new URLSearchParams(requestUrl.search.slice(1))
      const state = queryParams.get('state') ?? ''
      const error = queryParams.get('error')
      const sessionId = this.stateToSession.get(state) ?? ''
      const pending = sessionId ? this.pending.get(sessionId) : null
      if (!pending) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(
          '<h1>Unknown OAuth state</h1><p>This callback does not match any pending Gemini login.</p>',
        )
        return
      }
      if (error) {
        pending.status = 'failed'
        pending.error = `OAuth error: ${error}`
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<h1>Login failed</h1><p>${escapeHtml(pending.error)}</p>`,
        )
        return
      }
      const authorizationInput = `${getGeminiLoopbackRedirectUri()}?${requestUrl.search.slice(1)}`
      try {
        // Validate
        parseGeminiCallback(authorizationInput)
      } catch (parseError) {
        pending.status = 'failed'
        pending.error = parseError instanceof Error ? parseError.message : String(parseError)
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<h1>Login failed</h1><p>${escapeHtml(pending.error)}</p>`,
        )
        return
      }

      try {
        const account = await this.oauthService.exchangeCode({
          sessionId: pending.sessionId,
          authorizationInput,
          label: pending.options.label ?? undefined,
          accountId: pending.options.accountId ?? undefined,
          modelName: pending.options.modelName ?? undefined,
          proxyUrl: pending.options.proxyUrl ?? undefined,
          routingGroupId: pending.options.routingGroupId ?? undefined,
          group: pending.options.group ?? undefined,
        })
        pending.status = 'completed'
        pending.account = account
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`
<!doctype html><html><head><meta charset="utf-8"><title>Gemini OAuth</title></head>
<body style="font-family:system-ui;margin:40px;color:#222"><h1>登录成功</h1>
<p>账户已保存：<code>${escapeHtml(account.id)}</code></p>
<p>${escapeHtml(account.emailAddress ?? account.label ?? '')}</p>
<p>关闭此窗口即可。</p></body></html>`)
      } catch (exchangeError) {
        pending.status = 'failed'
        pending.error = exchangeError instanceof Error ? exchangeError.message : String(exchangeError)
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<h1>Login failed</h1><pre>${escapeHtml(pending.error)}</pre>`,
        )
      }
    } catch (handlerError) {
      try {
        res.writeHead(500).end('internal error')
      } catch {
        // ignore
      }
      throw handlerError
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    this.listening = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
