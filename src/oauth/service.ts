import crypto from 'node:crypto'
import { ProxyAgent, type Dispatcher } from 'undici'

import { appConfig } from '../config.js'
import type {
  AccountProvider,
  ClaudeCompatibleTierMap,
  ITokenStore,
  OAuthProfile,
  OAuthRoles,
  OAuthSession,
  OAuthTokenResponse,
  ProxyEntry,
  ResolvedAccount,
  RoutingGroup,
  SchedulerAccountStats,
  SessionHandoff,
  SessionRoute,
  StickySessionBinding,
  StoredAccount,
  TokenStoreData,
} from '../types.js'
import { AccountScheduler } from '../scheduler/accountScheduler.js'
import { FingerprintCache } from '../scheduler/fingerprintCache.js'
import type { UserStore } from '../usage/userStore.js'
import { InputValidationError } from '../security/inputValidation.js'
import {
  buildAuthorizeUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  parseAuthorizationInput,
} from './pkce.js'
import { getKeepAliveRefreshReason, type KeepAliveRefreshReason } from './keepAlive.js'
import { buildProviderScopedAccountId } from '../providers/accountRef.js'
import {
  CLAUDE_COMPATIBLE_PROVIDER,
  CLAUDE_OFFICIAL_PROVIDER,
  GOOGLE_GEMINI_OAUTH_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER,
  providerRequiresProxy,
} from '../providers/catalog.js'
import {
  buildOpenAICodexAuthorizeUrl,
  isOpenAICodexAccount,
  normalizeOpenAICodexApiBaseUrl,
  OPENAI_CODEX_OAUTH_SCOPES,
  parseOpenAICodexTokenClaims,
} from '../providers/openaiCodex.js'
import {
  buildGeminiAuthorizeUrl,
  deriveGeminiSubscriptionType,
  GEMINI_OAUTH_SCOPES,
  getGeminiLoopbackRedirectUri,
  isGeminiOauthAccount,
  readGeminiProjectId as readGeminiProjectFromAccount,
  readGeminiUserTier as readGeminiTierFromAccount,
  type GeminiAccountMetadata,
  type GeminiUserTier,
} from '../providers/googleGeminiOauth.js'
import {
  deriveClaudeSubscriptionType,
  deriveOpenAICodexSubscriptionType,
  getSubscriptionHeuristics,
} from '../providers/subscription.js'

const SESSION_TTL_MS = 10 * 60 * 1000
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeClaudeCompatibleTierMap(
  input: Partial<ClaudeCompatibleTierMap> | ClaudeCompatibleTierMap | null | undefined,
): ClaudeCompatibleTierMap | null {
  if (!input) return null
  const next: ClaudeCompatibleTierMap = {
    opus: trimToNull(input.opus ?? null),
    sonnet: trimToNull(input.sonnet ?? null),
    haiku: trimToNull(input.haiku ?? null),
  }
  return next.opus || next.sonnet || next.haiku ? next : null
}

const OPENAI_COMPATIBLE_MODEL_MAP_MAX_ENTRIES = 64

function normalizeOpenAICompatibleModelMapInput(
  input: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!input || typeof input !== 'object') return null
  const next: Record<string, string> = {}
  let count = 0
  for (const rawKey of Object.keys(input)) {
    if (count >= OPENAI_COMPATIBLE_MODEL_MAP_MAX_ENTRIES) break
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) continue
    const rawValue = input[rawKey]
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!value) continue
    next[key] = value
    count += 1
  }
  return count > 0 ? next : null
}

function normalizeMaxSessions(value: number | null): number | null {
  if (value == null) {
    return null
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('maxSessions must be a positive integer or null')
  }
  return value
}

function normalizePositiveNumber(value: number | null): number | null {
  if (value == null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('planMultiplier must be a positive number or null')
  }
  return value
}

const SUPPORTED_LOCAL_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:'])

function normalizeProxyUrl(value: string | null | undefined): string | null {
  const normalized = trimToNull(value)
  if (!normalized) {
    return null
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error(`Invalid proxy URL: ${normalized}`)
  }

  if (!SUPPORTED_LOCAL_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Proxy URL must use http://, https://, or socks5://. Received ${url.protocol} — configure the proxy localUrl as a locally reachable proxy address.`,
    )
  }

  return normalized
}

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function resolveRoutingGroupId(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const normalized = trimToNull(value)
    if (normalized) {
      return normalized
    }
  }
  return null
}

function sortRoutingGroups(groups: RoutingGroup[]): RoutingGroup[] {
  return [...groups].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function normalizeRoutingGroupType(value: string | null | undefined): RoutingGroup['type'] {
  const normalized = trimToNull(value)?.toLowerCase()
  if (normalized === 'openai' || normalized === 'google' || normalized === 'anthropic') {
    return normalized
  }
  return 'anthropic'
}

function routingGroupTypeForProvider(provider: AccountProvider): RoutingGroup['type'] {
  if (provider === 'openai-codex' || provider === 'openai-compatible') {
    return 'openai'
  }
  if (provider === 'google-gemini-oauth') {
    return 'google'
  }
  return 'anthropic'
}

function requireRoutingGroupForProvider(
  routingGroups: RoutingGroup[],
  routingGroupId: string | null,
  provider: AccountProvider,
): RoutingGroup {
  if (!routingGroupId) {
    throw new InputValidationError('routingGroupId is required')
  }
  const group = routingGroups.find((item) => item.id === routingGroupId) ?? null
  if (!group) {
    throw new InputValidationError(`Routing group not found: ${routingGroupId}`)
  }
  const expectedType = routingGroupTypeForProvider(provider)
  if (group.type !== expectedType) {
    throw new InputValidationError(`Routing group ${routingGroupId} type must be ${expectedType} for provider ${provider}`)
  }
  if (!group.isActive) {
    throw new InputValidationError(`Routing group is disabled: ${routingGroupId}`)
  }
  return group
}

function ensureRoutingGroupStub(
  routingGroups: RoutingGroup[],
  routingGroupId: string | null,
  provider: AccountProvider,
  nowIso: string,
): RoutingGroup[] {
  if (!routingGroupId || routingGroups.some((group) => group.id === routingGroupId)) {
    return routingGroups
  }
  return sortRoutingGroups(routingGroups.concat({
    id: routingGroupId,
    name: routingGroupId,
    type: routingGroupTypeForProvider(provider),
    description: null,
    descriptionZh: null,
    isActive: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  }))
}

function resolveAccountRoutingGroupId(
  account: Pick<StoredAccount, 'routingGroupId' | 'group'>,
): string | null {
  return resolveRoutingGroupId(account.routingGroupId, account.group)
}

function buildRoutingGroupMap(routingGroups: RoutingGroup[]): Map<string, RoutingGroup> {
  return new Map(routingGroups.map((group) => [group.id, group]))
}

function isRoutingGroupEnabled(
  routingGroups: Map<string, RoutingGroup>,
  routingGroupId: string | null,
): boolean {
  if (!routingGroupId) {
    return true
  }
  return routingGroups.get(routingGroupId)?.isActive ?? true
}

function isNoAvailableAccountsError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === 'No available OAuth accounts' ||
      error.message.startsWith('No available accounts in group '))
  )
}

function buildAccountSelectionFailureDetail(
  baseMessage: string,
  stats: SchedulerAccountStats[],
  context: {
    provider?: AccountProvider | null
    routingGroupId?: string | null
  },
): string {
  const detailParts: string[] = []
  if (context.provider) {
    detailParts.push(`provider=${context.provider}`)
  }
  if (context.routingGroupId) {
    detailParts.push(`group=${context.routingGroupId}`)
  }

  detailParts.push(`candidates=${stats.length}`)
  detailParts.push(`selectable=${stats.filter((item) => item.isSelectable).length}`)

  const blockedCounts = new Map<string, number>()
  for (const stat of stats) {
    if (!stat.blockedReason) {
      continue
    }
    blockedCounts.set(stat.blockedReason, (blockedCounts.get(stat.blockedReason) ?? 0) + 1)
  }
  if (blockedCounts.size > 0) {
    const blockedSummary = [...blockedCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(',')
    detailParts.push(`blocked=${blockedSummary}`)
  }

  const blockedExamples = stats
    .filter((item) => item.blockedReason)
    .slice(0, 5)
    .map((item) => `${item.accountId}=${item.blockedReason}`)
  if (blockedExamples.length > 0) {
    detailParts.push(`accounts=${blockedExamples.join(',')}`)
  }

  return `${baseMessage} (${detailParts.join('; ')})`
}

type ClaudeAiOrganization = {
  uuid?: string
  capabilities?: string[]
}

type SelectAccountOptions = {
  provider?: AccountProvider | null
  sessionKey?: string | null
  forceAccountId?: string | null
  routingGroupId?: string | null
  group?: string | null
  userId?: string | null
  clientDeviceId?: string | null
  disallowedAccountId?: string | null
  disallowedAccountIds?: string[] | null
  handoffReason?: string | null
  currentRequestBodyPreview?: string | null
}

type RecoverAfterAuthFailureOptions = {
  failedAccountId: string
  failedAccessToken: string
  sessionKey?: string | null
  forceAccountId?: string | null
  routingGroupId?: string | null
  group?: string | null
}

type PersistTokenOptions = {
  existingAccountId?: string
  label?: string | null
  source: 'login' | 'refresh'
  modelName?: string | null
  proxyUrl?: string | null
  apiBaseUrl?: string | null
  routingGroupId?: string | null
  group?: string | null
}

type StoredSelectionResult = {
  account: StoredAccount
  sessionRoute: SessionRoute | null
  handoffSummary: string | null
  handoffReason: string | null
  isCooldownFallback: boolean
}

export type KeepAliveRefreshOutcome = {
  accountId: string
  emailAddress: string | null
  reason: KeepAliveRefreshReason
  ok: boolean
  error?: string
}

class OAuthTokenRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly responseBody: string,
    readonly grantType: 'authorization_code' | 'refresh_token',
  ) {
    super(message)
    this.name = 'OAuthTokenRequestError'
  }
}

export class RoutingGuardError extends Error {
  constructor(
    readonly code:
      | 'user_active_session_limit'
      | 'client_device_active_session_limit'
      | 'user_request_budget_exceeded'
      | 'client_device_request_budget_exceeded'
      | 'user_token_budget_exceeded'
      | 'client_device_token_budget_exceeded',
    readonly limit: number,
    readonly current: number,
  ) {
    super(
      code === 'user_active_session_limit'
        ? `Relay user already has ${current} active sessions (limit ${limit})`
        : code === 'client_device_active_session_limit'
          ? `Client device already has ${current} active sessions (limit ${limit})`
          : code === 'user_request_budget_exceeded'
            ? `Relay user exceeded recent request budget: ${current}/${limit}`
            : code === 'client_device_request_budget_exceeded'
              ? `Client device exceeded recent request budget: ${current}/${limit}`
              : code === 'user_token_budget_exceeded'
                ? `Relay user exceeded recent token budget: ${current}/${limit}`
                : `Client device exceeded recent token budget: ${current}/${limit}`,
    )
    this.name = 'RoutingGuardError'
  }
}

export class OAuthService {
  private readonly sessions = new Map<string, OAuthSession>()

  constructor(
    private readonly store: ITokenStore,
    private readonly scheduler: AccountScheduler,
    private readonly fingerprintCache: FingerprintCache,
    private readonly userStore: UserStore | null = null,
  ) {}

  createAuthSession(
    input?:
      | number
      | {
          provider?: AccountProvider | null
          expiresIn?: number
        },
  ): {
    sessionId: string
    provider: AccountProvider
    authUrl: string
    redirectUri: string
    scopes: string[]
    expiresAt: string
  } {
    const provider =
      typeof input === 'number'
        ? CLAUDE_OFFICIAL_PROVIDER.id
        : input?.provider ?? CLAUDE_OFFICIAL_PROVIDER.id
    const expiresIn = typeof input === 'number' ? input : input?.expiresIn
    const sessionId = crypto.randomUUID()
    const codeVerifier = generateCodeVerifier()
    const state = generateState()
    const session: OAuthSession = {
      sessionId,
      provider,
      codeVerifier,
      state,
      expiresAt: Date.now() + SESSION_TTL_MS,
      expiresIn,
    }

    this.sessions.set(sessionId, session)

    if (provider === OPENAI_CODEX_PROVIDER.id) {
      return {
        sessionId,
        provider,
        authUrl: buildOpenAICodexAuthorizeUrl({
          codeChallenge: generateCodeChallenge(codeVerifier),
          state,
        }),
        redirectUri: appConfig.openAICodexOauthRedirectUrl,
        scopes: [...OPENAI_CODEX_OAUTH_SCOPES],
        expiresAt: new Date(session.expiresAt).toISOString(),
      }
    }

    if (provider === GOOGLE_GEMINI_OAUTH_PROVIDER.id) {
      const redirectUri = getGeminiLoopbackRedirectUri()
      return {
        sessionId,
        provider,
        authUrl: buildGeminiAuthorizeUrl({
          codeChallenge: generateCodeChallenge(codeVerifier),
          state,
          redirectUri,
        }),
        redirectUri,
        scopes: [...GEMINI_OAUTH_SCOPES],
        expiresAt: new Date(session.expiresAt).toISOString(),
      }
    }

    return {
      sessionId,
      provider,
      authUrl: buildAuthorizeUrl({
        codeChallenge: generateCodeChallenge(codeVerifier),
        state,
        expiresIn,
      }),
      redirectUri: appConfig.oauthManualRedirectUrl,
      scopes: [...appConfig.oauthScopes],
      expiresAt: new Date(session.expiresAt).toISOString(),
    }
  }

  async exchangeCode(input: {
    sessionId: string
    authorizationInput: string
    label?: string
    accountId?: string
    modelName?: string | null
    proxyUrl?: string | null
    apiBaseUrl?: string | null
    routingGroupId?: string | null
    group?: string | null
  }): Promise<StoredAccount> {
    const session = this.peekSession(input.sessionId)
    const { code, state } = parseAuthorizationInput(input.authorizationInput)
    if (state && state !== session.state) {
      throw new Error('OAuth state verification failed')
    }

    const existingAccount = input.accountId ? await this.getAccount(input.accountId) : null
    const proxyUrl = await this.resolveConfiguredProxyUrl(
      trimToNull(input.proxyUrl) ?? existingAccount?.proxyUrl ?? null,
    )
    this.consumeSession(input.sessionId)

    if (session.provider === OPENAI_CODEX_PROVIDER.id) {
      const tokenResponse = await this.requestOpenAICodexTokenGrant(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: appConfig.openAICodexOauthRedirectUrl,
          client_id: appConfig.openAICodexOauthClientId,
          code_verifier: session.codeVerifier,
        },
        'authorization_code',
      )

      return this.persistOpenAICodexTokenResponse(tokenResponse, {
        existingAccountId: input.accountId,
        label: input.label,
        source: 'login',
        modelName: input.modelName,
        proxyUrl,
        apiBaseUrl: input.apiBaseUrl,
        routingGroupId: input.routingGroupId,
        group: input.group,
      })
    }

    if (session.provider === GOOGLE_GEMINI_OAUTH_PROVIDER.id) {
      const redirectUri = getGeminiLoopbackRedirectUri()
      const tokenResponse = await this.requestGeminiTokenGrant(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: appConfig.geminiOauthClientId,
          client_secret: appConfig.geminiOauthClientSecret,
          code_verifier: session.codeVerifier,
        },
        'authorization_code',
      )

      const metadata = await this.fetchGeminiAccountMetadata(tokenResponse.access_token).catch(
        () => null,
      )

      return this.persistGeminiTokenResponse(tokenResponse, {
        existingAccountId: input.accountId,
        label: input.label,
        source: 'login',
        modelName: input.modelName,
        proxyUrl,
        routingGroupId: input.routingGroupId,
        group: input.group,
        metadata,
      })
    }

    const tokenResponse = await this.requestTokenGrant(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: appConfig.oauthManualRedirectUrl,
        client_id: appConfig.oauthClientId,
        code_verifier: session.codeVerifier,
        state: session.state,
        ...(typeof session.expiresIn === 'number' &&
        Number.isFinite(session.expiresIn) &&
        session.expiresIn > 0
          ? { expires_in: session.expiresIn }
          : {}),
      },
      'authorization_code',
      proxyUrl,
    )

    const stored = await this.persistTokenResponse(tokenResponse, {
      existingAccountId: input.accountId,
      label: input.label,
      source: 'login',
      proxyUrl,
      routingGroupId: input.routingGroupId,
      group: input.group,
    })
    this.scheduler.clearAccountHealth(stored.id)
    void this.store.updateAccountRateLimitedUntil?.(stored.id, 0)
    return stored
  }

  async loginWithSessionKey(
    sessionKey: string,
    label?: string,
    routingGroupId?: string | null,
    group?: string | null,
  ): Promise<StoredAccount> {
    const trimmed = sessionKey.trim()
    if (!trimmed) {
      throw new Error('sessionKey must not be empty')
    }

    const organizationUuid = await this.resolveBestOrganizationUuid(trimmed)
    const codeVerifier = generateCodeVerifier()
    const state = generateState()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const authorizeUrl = appConfig.claudeAiCookieAuthorizeTemplate.replace(
      '{organization_uuid}',
      organizationUuid,
    )

    const authorizeResponse = await fetch(authorizeUrl, {
      method: 'POST',
      headers: {
        ...this.buildCookieHeaders(trimmed),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        response_type: 'code',
        client_id: appConfig.oauthClientId,
        organization_uuid: organizationUuid,
        redirect_uri: appConfig.oauthManualRedirectUrl,
        scope: appConfig.oauthScopes.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
      signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
    })

    if (!authorizeResponse.ok) {
      const body = await authorizeResponse.text()
      throw new Error(`Cookie authorize failed: ${authorizeResponse.status} ${body.slice(0, 500)}`)
    }

    const authorizeData = (await authorizeResponse.json()) as { redirect_uri?: string }
    const redirectUri = authorizeData.redirect_uri
    if (!redirectUri) {
      throw new Error('Cookie authorize response missing redirect_uri')
    }

    const { code, state: returnedState } = parseAuthorizationInput(redirectUri)
    if (returnedState && returnedState !== state) {
      throw new Error('Cookie authorize state verification failed')
    }

    const tokenResponse = await this.requestTokenGrant(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: appConfig.oauthManualRedirectUrl,
        client_id: appConfig.oauthClientId,
        code_verifier: codeVerifier,
        state,
      },
      'authorization_code',
    )

    const stored = await this.persistTokenResponse(tokenResponse, {
      label,
      source: 'login',
      routingGroupId,
      group,
    })
    this.scheduler.clearAccountHealth(stored.id)
    void this.store.updateAccountRateLimitedUntil?.(stored.id, 0)
    return stored
  }

  async listAccounts(): Promise<StoredAccount[]> {
    const now = Date.now()
    const accounts = this.store.getAccounts
      ? await this.store.getAccounts()
      : (await this.pruneExpiredStickySessions(await this.store.getData(), now)).accounts
    return accounts
      .map((account) => this.releaseExpiredRateLimitBlock(account, now))
      .sort(compareAccountsForDisplay)
  }

  async listStickySessions(): Promise<
    Array<
      StickySessionBinding & {
        account: Pick<
          StoredAccount,
          'id' | 'label' | 'emailAddress' | 'displayName' | 'status' | 'isActive'
        > | null
      }
    >
  > {
    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      return {
        data,
        result: [...data.stickySessions]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map((binding) => {
            const account = data.accounts.find((item) => item.id === binding.accountId)
            return {
              ...binding,
              account: account
                ? {
                    id: account.id,
                    label: account.label,
                    emailAddress: account.emailAddress,
                    displayName: account.displayName,
                    status: account.status,
                    isActive: account.isActive,
                  }
                : null,
            }
          }),
      }
    })
  }

  async getAccount(accountId: string): Promise<StoredAccount | null> {
    const now = Date.now()
    const accounts = this.store.getAccounts
      ? await this.store.getAccounts()
      : (await this.pruneExpiredStickySessions(await this.store.getData(), now)).accounts
    const account = accounts.find((item) => item.id === accountId) ?? null
    return account ? this.releaseExpiredRateLimitBlock(account, now) : null
  }

  async listRoutingGroups(): Promise<RoutingGroup[]> {
    const groups = this.store.getRoutingGroups
      ? await this.store.getRoutingGroups()
      : (await this.pruneExpiredStickySessions(await this.store.getData())).routingGroups ?? []
    return sortRoutingGroups(groups)
  }

  async getRoutingGroup(id: string): Promise<RoutingGroup | null> {
    const routingGroupId = trimToNull(id)
    if (!routingGroupId) {
      return null
    }
    const groups = this.store.getRoutingGroups
      ? await this.store.getRoutingGroups()
      : (await this.pruneExpiredStickySessions(await this.store.getData())).routingGroups ?? []
    return groups.find((group) => group.id === routingGroupId) ?? null
  }

  async ensureRoutingGroupExists(routingGroupId: string | null | undefined): Promise<RoutingGroup | null> {
    const normalizedRoutingGroupId = trimToNull(routingGroupId)
    if (!normalizedRoutingGroupId) {
      return null
    }
    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const nowIso = new Date().toISOString()
      const existing = (data.routingGroups ?? []).find((group) => group.id === normalizedRoutingGroupId)
      if (existing) {
        return { data, result: existing }
      }
      const created: RoutingGroup = {
        id: normalizedRoutingGroupId,
        name: normalizedRoutingGroupId,
        type: 'anthropic',
        description: null,
        descriptionZh: null,
        isActive: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      return {
        data: {
          ...data,
          routingGroups: sortRoutingGroups((data.routingGroups ?? []).concat(created)),
        },
        result: created,
      }
    })
  }

  async createRoutingGroup(input: {
    id: string
    name?: string | null
    type?: string | null
    description?: string | null
    descriptionZh?: string | null
    isActive?: boolean
  }): Promise<RoutingGroup> {
    const routingGroupId = trimToNull(input.id)
    if (!routingGroupId) {
      throw new Error('routingGroupId is required')
    }
    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      if ((data.routingGroups ?? []).some((group) => group.id === routingGroupId)) {
        throw new Error(`Routing group already exists: ${routingGroupId}`)
      }
      const nowIso = new Date().toISOString()
      const created: RoutingGroup = {
        id: routingGroupId,
        name: trimToNull(input.name) ?? routingGroupId,
        type: normalizeRoutingGroupType(input.type),
        description: trimToNull(input.description),
        descriptionZh: trimToNull(input.descriptionZh),
        isActive: input.isActive ?? true,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      return {
        data: {
          ...data,
          routingGroups: sortRoutingGroups((data.routingGroups ?? []).concat(created)),
        },
        result: created,
      }
    })
  }

  async updateRoutingGroup(
    id: string,
    updates: {
      name?: string | null
      type?: string | null
      description?: string | null
      descriptionZh?: string | null
      isActive?: boolean
    },
  ): Promise<RoutingGroup | null> {
    const routingGroupId = trimToNull(id)
    if (!routingGroupId) {
      return null
    }
    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const existing = (data.routingGroups ?? []).find((group) => group.id === routingGroupId) ?? null
      if (!existing) {
        return { data, result: null }
      }
      const updated: RoutingGroup = {
        ...existing,
        name: updates.name !== undefined ? trimToNull(updates.name) ?? routingGroupId : existing.name,
        type: updates.type !== undefined ? normalizeRoutingGroupType(updates.type) : existing.type,
        description:
          updates.description !== undefined
            ? trimToNull(updates.description)
            : existing.description,
        descriptionZh:
          updates.descriptionZh !== undefined
            ? trimToNull(updates.descriptionZh)
            : existing.descriptionZh,
        isActive: updates.isActive ?? existing.isActive,
        updatedAt: new Date().toISOString(),
      }
      return {
        data: {
          ...data,
          routingGroups: sortRoutingGroups(
            (data.routingGroups ?? []).map((group) =>
              group.id === routingGroupId ? updated : group,
            ),
          ),
        },
        result: updated,
      }
    })
  }

  async renameRoutingGroup(id: string, newId: string): Promise<RoutingGroup | null> {
    const oldGroupId = trimToNull(id)
    const nextGroupId = trimToNull(newId)
    if (!oldGroupId || !nextGroupId) {
      throw new InputValidationError('group id is required')
    }
    if (oldGroupId === nextGroupId) {
      return this.getRoutingGroup(oldGroupId)
    }
    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const existing = (data.routingGroups ?? []).find((group) => group.id === oldGroupId) ?? null
      if (!existing) {
        return { data, result: null }
      }
      if ((data.routingGroups ?? []).some((group) => group.id === nextGroupId)) {
        throw new InputValidationError(`Routing group already exists: ${nextGroupId}`)
      }
      const updated: RoutingGroup = {
        ...existing,
        id: nextGroupId,
        name: existing.name === oldGroupId ? nextGroupId : existing.name,
        updatedAt: new Date().toISOString(),
      }
      const accounts = data.accounts.map((account) => {
        const routingGroupId = account.routingGroupId === oldGroupId ? nextGroupId : account.routingGroupId
        const group = account.group === oldGroupId ? nextGroupId : account.group
        return routingGroupId === account.routingGroupId && group === account.group
          ? account
          : { ...account, routingGroupId, group, updatedAt: updated.updatedAt }
      })
      return {
        data: {
          ...data,
          accounts,
          routingGroups: sortRoutingGroups((data.routingGroups ?? []).map((group) => group.id === oldGroupId ? updated : group)),
        },
        result: updated,
      }
    })
  }

  async deleteRoutingGroup(id: string): Promise<RoutingGroup | null> {
    const routingGroupId = trimToNull(id)
    if (!routingGroupId) {
      return null
    }
    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const existing = (data.routingGroups ?? []).find((group) => group.id === routingGroupId) ?? null
      if (!existing) {
        return { data, result: null }
      }
      return {
        data: {
          ...data,
          routingGroups: (data.routingGroups ?? []).filter((group) => group.id !== routingGroupId),
        },
        result: existing,
      }
    })
  }

  async createSimpleAccount(input: {
    email: string
    password?: string
    label?: string
    routingGroupId?: string | null
    group?: string | null
  }): Promise<StoredAccount> {
    const now = new Date().toISOString()
    const routingGroupId = resolveRoutingGroupId(input.routingGroupId, input.group)
    const account: StoredAccount = {
      id: buildProviderScopedAccountId(
        CLAUDE_OFFICIAL_PROVIDER.id,
        `email:${input.email.toLowerCase()}`,
      ),
      provider: CLAUDE_OFFICIAL_PROVIDER.id,
      protocol: CLAUDE_OFFICIAL_PROVIDER.protocol,
      authMode: CLAUDE_OFFICIAL_PROVIDER.authMode,
      label: input.label?.trim() || null,
      isActive: false,
      status: 'active',
      lastSelectedAt: null,
      lastUsedAt: null,
      lastRefreshAt: null,
      lastFailureAt: null,
      cooldownUntil: null,
      lastError: null,
      accessToken: '',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      createdAt: now,
      updatedAt: now,
      subscriptionType: null,
      rateLimitTier: null,
      accountUuid: null,
      organizationUuid: null,
      emailAddress: input.email.toLowerCase(),
      displayName: null,
      hasExtraUsageEnabled: null,
      billingType: null,
      accountCreatedAt: null,
      subscriptionCreatedAt: null,
      rawProfile: null,
      roles: null,
      routingGroupId,
      group: routingGroupId,
      maxSessions: null,
      weight: null,
      schedulerEnabled: true,
      schedulerState: 'enabled',
      autoBlockedReason: null,
      autoBlockedUntil: null,
      lastRateLimitStatus: null,
      lastRateLimit5hUtilization: null,
      lastRateLimit7dUtilization: null,
      lastRateLimitReset: null,
      lastRateLimitAt: null,
      lastProbeAttemptAt: null,
      proxyUrl: null,
      bodyTemplatePath: null,
      vmFingerprintTemplatePath: null,
      deviceId: crypto.randomBytes(32).toString('hex'),
      apiBaseUrl: null,
      modelName: null,
      modelTierMap: null,
      modelMap: null,
      loginPassword: input.password?.trim() || null,
    }
    await this.store.updateData((current) => {
      const existing = current.accounts.findIndex((item) =>
        item.id === account.id ||
        item.id === `email:${account.emailAddress}` ||
        item.emailAddress === account.emailAddress,
      )
      const data = this.pruneExpiredStickySessions(current)
      const routingGroups = ensureRoutingGroupStub(data.routingGroups ?? [], routingGroupId, CLAUDE_OFFICIAL_PROVIDER.id, now)
      requireRoutingGroupForProvider(routingGroups, routingGroupId, CLAUDE_OFFICIAL_PROVIDER.id)
      const accounts = [...current.accounts]
      if (existing >= 0) {
        accounts[existing] = {
          ...accounts[existing],
          emailAddress: account.emailAddress,
          loginPassword: account.loginPassword,
          label: account.label,
          routingGroupId: account.routingGroupId,
          group: account.group,
          updatedAt: now,
        }
      } else {
        accounts.push(account)
      }
      return {
        data: {
          ...data,
          routingGroups,
          accounts,
        },
        result: account,
      }
    })
    return account
  }

  async getDefaultAccountPreview(): Promise<StoredAccount | null> {
    const data = this.pruneExpiredStickySessions(await this.store.getData())
    return [...data.accounts].sort(compareAccountsForConsistency)[0] ?? null
  }

  async clearStoredAccounts(): Promise<void> {
    await this.store.clear()
  }

  async clearStickySessions(): Promise<void> {
    await this.store.updateData((current) => ({
      data: {
        ...current,
        stickySessions: [],
      },
      result: undefined,
    }))
  }

  async deleteAccount(accountId: string): Promise<StoredAccount | null> {
    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const account = data.accounts.find((item) => item.id === accountId) ?? null
      if (!account) {
        return { data, result: null }
      }
      return {
        data: {
          ...data,
          accounts: data.accounts.filter((item) => item.id !== accountId),
          stickySessions: data.stickySessions.filter((item) => item.accountId !== accountId),
        },
        result: account,
      }
    })
  }

  async createOpenAICompatibleAccount(input: {
    apiKey: string
    apiBaseUrl: string
    modelName?: string | null
    modelMap?: Record<string, string> | null
    label?: string
    proxyUrl?: string | null
    routingGroupId?: string | null
    group?: string | null
  }): Promise<StoredAccount> {
    const apiKey = input.apiKey.trim()
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl)
    const modelName = input.modelName?.trim() || null
    const modelMap = normalizeOpenAICompatibleModelMapInput(input.modelMap)
    const routingGroupId = resolveRoutingGroupId(input.routingGroupId, input.group)

    if (!apiKey) {
      throw new Error('apiKey is required')
    }
    if (!apiBaseUrl) {
      throw new Error('apiBaseUrl is required')
    }

    const now = new Date().toISOString()
    const account: StoredAccount = {
      id: buildProviderScopedAccountId(
        OPENAI_COMPATIBLE_PROVIDER.id,
        crypto.randomUUID(),
      ),
      provider: OPENAI_COMPATIBLE_PROVIDER.id,
      protocol: OPENAI_COMPATIBLE_PROVIDER.protocol,
      authMode: OPENAI_COMPATIBLE_PROVIDER.authMode,
      label: trimToNull(input.label),
      isActive: true,
      status: 'active',
      lastSelectedAt: null,
      lastUsedAt: null,
      lastRefreshAt: null,
      lastFailureAt: null,
      cooldownUntil: null,
      lastError: null,
      accessToken: apiKey,
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      createdAt: now,
      updatedAt: now,
      subscriptionType: null,
      rateLimitTier: null,
      accountUuid: null,
      organizationUuid: null,
      emailAddress: null,
      displayName: modelName,
      hasExtraUsageEnabled: null,
      billingType: null,
      accountCreatedAt: null,
      subscriptionCreatedAt: null,
      rawProfile: null,
      roles: null,
      routingGroupId,
      group: routingGroupId,
      maxSessions: null,
      weight: null,
      schedulerEnabled: true,
      schedulerState: 'enabled',
      autoBlockedReason: null,
      autoBlockedUntil: null,
      lastRateLimitStatus: null,
      lastRateLimit5hUtilization: null,
      lastRateLimit7dUtilization: null,
      lastRateLimitReset: null,
      lastRateLimitAt: null,
      lastProbeAttemptAt: null,
      proxyUrl: trimToNull(input.proxyUrl),
      bodyTemplatePath: null,
      vmFingerprintTemplatePath: null,
      deviceId: crypto.randomBytes(32).toString('hex'),
      apiBaseUrl,
      modelName,
      modelTierMap: null,
      modelMap,
      loginPassword: null,
    }

    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const routingGroups = ensureRoutingGroupStub(data.routingGroups ?? [], routingGroupId, OPENAI_COMPATIBLE_PROVIDER.id, now)
      requireRoutingGroupForProvider(routingGroups, routingGroupId, OPENAI_COMPATIBLE_PROVIDER.id)
      return {
        data: {
          ...data,
          routingGroups,
          accounts: [account, ...data.accounts],
        },
        result: account,
      }
    })
  }

  async createClaudeCompatibleAccount(input: {
    apiKey: string
    apiBaseUrl: string
    modelName: string
    modelTierMap?: Partial<ClaudeCompatibleTierMap> | null
    label?: string
    proxyUrl?: string | null
    routingGroupId?: string | null
    group?: string | null
  }): Promise<StoredAccount> {
    const apiKey = input.apiKey.trim()
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl)
    const modelName = input.modelName?.trim() || ''
    const modelTierMap = normalizeClaudeCompatibleTierMap(input.modelTierMap)
    const routingGroupId = resolveRoutingGroupId(input.routingGroupId, input.group)

    if (!apiKey) {
      throw new Error('apiKey is required')
    }
    if (!apiBaseUrl) {
      throw new Error('apiBaseUrl is required')
    }
    if (!modelName) {
      throw new Error('modelName is required')
    }

    const now = new Date().toISOString()
    const account: StoredAccount = {
      id: buildProviderScopedAccountId(
        CLAUDE_COMPATIBLE_PROVIDER.id,
        crypto.randomUUID(),
      ),
      provider: CLAUDE_COMPATIBLE_PROVIDER.id,
      protocol: CLAUDE_COMPATIBLE_PROVIDER.protocol,
      authMode: CLAUDE_COMPATIBLE_PROVIDER.authMode,
      label: trimToNull(input.label),
      isActive: true,
      status: 'active',
      lastSelectedAt: null,
      lastUsedAt: null,
      lastRefreshAt: null,
      lastFailureAt: null,
      cooldownUntil: null,
      lastError: null,
      accessToken: apiKey,
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      createdAt: now,
      updatedAt: now,
      subscriptionType: null,
      rateLimitTier: null,
      accountUuid: null,
      organizationUuid: null,
      emailAddress: null,
      displayName: modelName,
      hasExtraUsageEnabled: null,
      billingType: null,
      accountCreatedAt: null,
      subscriptionCreatedAt: null,
      rawProfile: null,
      roles: null,
      routingGroupId,
      group: routingGroupId,
      maxSessions: null,
      weight: null,
      schedulerEnabled: true,
      schedulerState: 'enabled',
      autoBlockedReason: null,
      autoBlockedUntil: null,
      lastRateLimitStatus: null,
      lastRateLimit5hUtilization: null,
      lastRateLimit7dUtilization: null,
      lastRateLimitReset: null,
      lastRateLimitAt: null,
      lastProbeAttemptAt: null,
      proxyUrl: trimToNull(input.proxyUrl),
      bodyTemplatePath: null,
      vmFingerprintTemplatePath: null,
      deviceId: crypto.randomBytes(32).toString('hex'),
      apiBaseUrl,
      modelName,
      modelTierMap,
      modelMap: null,
      loginPassword: null,
    }

    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const routingGroups = ensureRoutingGroupStub(data.routingGroups ?? [], routingGroupId, CLAUDE_COMPATIBLE_PROVIDER.id, now)
      requireRoutingGroupForProvider(routingGroups, routingGroupId, CLAUDE_COMPATIBLE_PROVIDER.id)
      return {
        data: {
          ...data,
          routingGroups,
          accounts: [account, ...data.accounts],
        },
        result: account,
      }
    })
  }

  async refreshAccount(accountId: string): Promise<StoredAccount> {
    const account = await this.requireAccount(accountId)
    if (account.authMode !== 'oauth' || !account.refreshToken) {
      throw new Error('Account does not support token refresh')
    }

    const proxyUrl = await this.resolveConfiguredProxyUrl(account.proxyUrl)

    try {
      if (account.provider === OPENAI_CODEX_PROVIDER.id) {
        const tokenResponse = await this.requestOpenAICodexTokenGrant(
          {
            grant_type: 'refresh_token',
            refresh_token: account.refreshToken,
            client_id: appConfig.openAICodexOauthClientId,
          },
          'refresh_token',
        )

        return this.persistOpenAICodexTokenResponse(tokenResponse, {
          existingAccountId: accountId,
          label: account.label,
          source: 'refresh',
        })
      }

      if (account.provider === GOOGLE_GEMINI_OAUTH_PROVIDER.id) {
        const tokenResponse = await this.requestGeminiTokenGrant(
          {
            grant_type: 'refresh_token',
            refresh_token: account.refreshToken,
            client_id: appConfig.geminiOauthClientId,
            client_secret: appConfig.geminiOauthClientSecret,
          },
          'refresh_token',
        )

        return this.persistGeminiTokenResponse(tokenResponse, {
          existingAccountId: accountId,
          label: account.label,
          source: 'refresh',
        })
      }

      const tokenResponse = await this.requestTokenGrant(
        {
          grant_type: 'refresh_token',
          refresh_token: account.refreshToken,
          client_id: appConfig.oauthClientId,
          scope: appConfig.oauthScopes.join(' '),
        },
        'refresh_token',
        proxyUrl,
      )

      return this.persistTokenResponse(tokenResponse, {
        existingAccountId: accountId,
        label: account.label,
        source: 'refresh',
        proxyUrl,
      })
    } catch (error) {
      await this.markAccountFailure(accountId, error, this.isPermanentRefreshFailure(error))
      throw error
    }
  }

  async refreshAllAccounts(): Promise<
    Array<
      | { accountId: string; ok: true; account: StoredAccount }
      | { accountId: string; ok: false; error: string }
    >
  > {
    const accounts = await this.listAccounts()
    const results: Array<
      | { accountId: string; ok: true; account: StoredAccount }
      | { accountId: string; ok: false; error: string }
    > = []

    for (const account of accounts.filter((item) =>
      item.isActive &&
      item.authMode === 'oauth' &&
      Boolean(item.refreshToken),
    )) {
      try {
        const refreshed = await this.refreshAccount(account.id)
        results.push({
          accountId: account.id,
          ok: true,
          account: refreshed,
        })
      } catch (error) {
        results.push({
          accountId: account.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return results
  }

  async getAccountsForRateLimitProbe(now: number = Date.now()): Promise<StoredAccount[]> {
    const accounts = this.store.getAccounts
      ? await this.store.getAccounts()
      : (await this.pruneExpiredStickySessions(await this.store.getData(), now)).accounts
    const probeIntervalMs = appConfig.rateLimitProbeIntervalMs
    const eligible = accounts.filter((account) => {
      if (!account.isActive || account.status === 'revoked') return false
      if (!account.accessToken) return false
      if (account.authMode !== 'oauth') return false
      const lastRateLimitMs = account.lastRateLimitAt
        ? new Date(account.lastRateLimitAt).getTime()
        : 0
      // Use the later of rate-limit snapshot or last probe attempt to determine staleness
      const lastInteractionMs = Math.max(lastRateLimitMs, account.lastProbeAttemptAt ?? 0)
      return now - lastInteractionMs > probeIntervalMs
    })
    eligible.sort((a, b) => {
      const aAt = Math.max(
        a.lastRateLimitAt ? new Date(a.lastRateLimitAt).getTime() : 0,
        a.lastProbeAttemptAt ?? 0,
      )
      const bAt = Math.max(
        b.lastRateLimitAt ? new Date(b.lastRateLimitAt).getTime() : 0,
        b.lastProbeAttemptAt ?? 0,
      )
      return aAt - bAt
    })
    return eligible.slice(0, 5)
  }

  async refreshDueAccountsForKeepAlive(
    now: number = Date.now(),
  ): Promise<KeepAliveRefreshOutcome[]> {
    const accounts = await this.listAccounts()
    const results: KeepAliveRefreshOutcome[] = []

    for (const account of accounts) {
      if (account.authMode !== 'oauth' || !account.refreshToken) {
        continue
      }
      const reason = getKeepAliveRefreshReason(account, now, {
        refreshBeforeMs: appConfig.accountKeepAliveRefreshBeforeMs,
        forceRefreshMs: appConfig.accountKeepAliveForceRefreshMs,
      })
      if (!reason) {
        continue
      }

      try {
        const refreshed = await this.refreshAccount(account.id)
        results.push({
          accountId: refreshed.id,
          emailAddress: refreshed.emailAddress,
          reason,
          ok: true,
        })
      } catch (error) {
        results.push({
          accountId: account.id,
          emailAddress: account.emailAddress,
          reason,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return results
  }

  async selectAccount(options: SelectAccountOptions = {}): Promise<ResolvedAccount> {
    const candidate = await this.selectStoredAccountCandidate(options)
    const account = await this.ensureFreshAccount(candidate.account)
    return await this.resolveAccount(
      account,
      candidate.sessionRoute,
      candidate.handoffSummary,
      candidate.handoffReason,
      candidate.isCooldownFallback,
    )
  }

  async recoverAccountAfterAuthFailure(input: RecoverAfterAuthFailureOptions): Promise<{
    resolved: ResolvedAccount
    mode: 'refresh'
  }> {
    const current = await this.getAccount(input.failedAccountId)

    if (current && current.accessToken !== input.failedAccessToken) {
      const account = await this.ensureFreshAccount(current)
      return {
        resolved: await this.resolveAccount(account, null, null, null),
        mode: 'refresh',
      }
    }

    try {
      const account = await this.refreshAccount(input.failedAccountId)
      return {
        resolved: await this.resolveAccount(account, null, null, null),
        mode: 'refresh',
      }
    } catch (error) {
      throw error
    }
  }

  async importTokens(input: {
    accessToken: string
    refreshToken: string | null
    label?: string | null
    routingGroupId?: string | null
    group?: string | null
  }): Promise<StoredAccount> {
    const fakeTokenResponse: OAuthTokenResponse = {
      access_token: input.accessToken,
      refresh_token: input.refreshToken ?? undefined,
      expires_in: 0,
    }
    return this.persistTokenResponse(fakeTokenResponse, {
      label: input.label ?? null,
      source: 'login',
      routingGroupId: input.routingGroupId ?? null,
      group: input.group ?? null,
    })
  }

  async getSchedulerStats(): Promise<{
    global: {
      totalAccounts: number
      activeAccounts: number
      totalActiveSessions: number
      totalCapacity: number
      utilizationPercent: number
    }
    groups: Record<string, {
      accounts: number
      activeSessions: number
      capacity: number
      utilizationPercent: number
    }>
    routingGuard: {
      windowMs: number
      limits: {
        userActiveSessions: number
        clientDeviceActiveSessions: number
        userRecentRequests: number
        clientDeviceRecentRequests: number
        userRecentTokens: number
        clientDeviceRecentTokens: number
      }
      users: Array<{
        userId: string
        activeSessions: number
        recentRequests: number
        recentTokens: number
        activeSessionUtilizationPercent: number
        requestUtilizationPercent: number
        tokenUtilizationPercent: number
      }>
      devices: Array<{
        userId: string
        clientDeviceId: string
        activeSessions: number
        recentRequests: number
        recentTokens: number
        activeSessionUtilizationPercent: number
        requestUtilizationPercent: number
        tokenUtilizationPercent: number
      }>
    }
    accounts: SchedulerAccountStats[]
    sessionRoutes: SessionRoute[]
    recentHandoffs: SessionHandoff[]
  }> {
    const data = await this.store.getData()
    const pruned = this.pruneExpiredStickySessions(data)
    const activeSessionCounts = await this.userStore?.getActiveSessionCounts()
    const stats = this.scheduler.getStats(
      pruned.accounts,
      pruned.stickySessions,
      Date.now(),
      activeSessionCounts ?? undefined,
    )
    const sessionRoutes = (await this.userStore?.listSessionRoutes()) ?? []
    const recentHandoffs = (await this.userStore?.listSessionHandoffs(50)) ?? []
    const routingGuardUsers = (await this.userStore?.listRoutingGuardUserStats(10)) ?? []
    const routingGuardDevices = (await this.userStore?.listRoutingGuardDeviceStats(10)) ?? []

    const activeAccounts = stats.filter((s) => s.isSelectable).length
    const totalActiveSessions = stats.reduce((sum, s) => sum + s.activeSessions, 0)
    const totalCapacity = stats.reduce((sum, s) => sum + s.maxSessions, 0)

    const groups: Record<string, { accounts: number; activeSessions: number; capacity: number; utilizationPercent: number }> = {}
    for (const stat of stats) {
      const groupKey = stat.group ?? appConfig.defaultAccountGroup
      if (!groups[groupKey]) {
        groups[groupKey] = { accounts: 0, activeSessions: 0, capacity: 0, utilizationPercent: 0 }
      }
      groups[groupKey].accounts += 1
      groups[groupKey].activeSessions += stat.activeSessions
      groups[groupKey].capacity += stat.maxSessions
    }
    for (const group of Object.values(groups)) {
      group.utilizationPercent = group.capacity > 0
        ? Math.round((group.activeSessions / group.capacity) * 100)
        : 0
    }

    return {
      global: {
        totalAccounts: stats.length,
        activeAccounts,
        totalActiveSessions,
        totalCapacity,
        utilizationPercent: totalCapacity > 0
          ? Math.round((totalActiveSessions / totalCapacity) * 100)
          : 0,
      },
      groups,
      routingGuard: {
        windowMs: appConfig.routingBudgetWindowMs,
        limits: {
          userActiveSessions: appConfig.routingUserMaxActiveSessions,
          clientDeviceActiveSessions: appConfig.routingDeviceMaxActiveSessions,
          userRecentRequests: appConfig.routingUserMaxRequestsPerWindow,
          clientDeviceRecentRequests: appConfig.routingDeviceMaxRequestsPerWindow,
          userRecentTokens: appConfig.routingUserMaxTokensPerWindow,
          clientDeviceRecentTokens: appConfig.routingDeviceMaxTokensPerWindow,
        },
        users: routingGuardUsers.map((item) => ({
          ...item,
          activeSessionUtilizationPercent: Math.min(
            100,
            Math.round((item.activeSessions / appConfig.routingUserMaxActiveSessions) * 100),
          ),
          requestUtilizationPercent: Math.min(
            100,
            Math.round((item.recentRequests / appConfig.routingUserMaxRequestsPerWindow) * 100),
          ),
          tokenUtilizationPercent: Math.min(
            100,
            Math.round((item.recentTokens / appConfig.routingUserMaxTokensPerWindow) * 100),
          ),
        })),
        devices: routingGuardDevices.map((item) => ({
          ...item,
          activeSessionUtilizationPercent: Math.min(
            100,
            Math.round((item.activeSessions / appConfig.routingDeviceMaxActiveSessions) * 100),
          ),
          requestUtilizationPercent: Math.min(
            100,
            Math.round((item.recentRequests / appConfig.routingDeviceMaxRequestsPerWindow) * 100),
          ),
          tokenUtilizationPercent: Math.min(
            100,
            Math.round((item.recentTokens / appConfig.routingDeviceMaxTokensPerWindow) * 100),
          ),
        })),
      },
      accounts: stats,
      sessionRoutes,
      recentHandoffs,
    }
  }

  async updateAccountSettings(
    accountId: string,
    settings: {
      routingGroupId?: string | null
      group?: string | null
      maxSessions?: number | null
      weight?: number | null
      planType?: string | null
      planMultiplier?: number | null
      schedulerEnabled?: boolean
      schedulerState?: StoredAccount['schedulerState']
      proxyUrl?: string | null
      bodyTemplatePath?: string | null
      vmFingerprintTemplatePath?: string | null
      label?: string | null
      apiBaseUrl?: string | null
      modelName?: string | null
      modelTierMap?: Partial<ClaudeCompatibleTierMap> | ClaudeCompatibleTierMap | null
      modelMap?: Record<string, string> | null
    },
  ): Promise<StoredAccount> {
    const enabledTransition = settings.schedulerState === 'enabled'
    const result = await this.store.updateData((current) => {
      const pruned = this.pruneExpiredStickySessions(current)
      const data = {
        ...pruned,
        accounts: current.accounts,
      }
      const account = data.accounts.find((a) => a.id === accountId)
      if (!account) {
        throw new Error(`Account not found: ${accountId}`)
      }

      const nowIso = new Date().toISOString()
      const updated: StoredAccount = {
        ...account,
        updatedAt: nowIso,
      }

      const nextRoutingGroupId =
        settings.routingGroupId !== undefined
          ? resolveRoutingGroupId(settings.routingGroupId)
          : settings.group !== undefined
            ? resolveRoutingGroupId(settings.group)
            : undefined
      if (nextRoutingGroupId !== undefined) {
        data.routingGroups = ensureRoutingGroupStub(data.routingGroups ?? [], nextRoutingGroupId, account.provider, nowIso)
        requireRoutingGroupForProvider(data.routingGroups, nextRoutingGroupId, account.provider)
        updated.routingGroupId = nextRoutingGroupId
        updated.group = nextRoutingGroupId
      }
      if (settings.maxSessions !== undefined) updated.maxSessions = normalizeMaxSessions(settings.maxSessions)
      if (settings.weight !== undefined) updated.weight = settings.weight
      if (settings.planType !== undefined) updated.planType = trimToNull(settings.planType)
      if (settings.planMultiplier !== undefined) updated.planMultiplier = normalizePositiveNumber(settings.planMultiplier)
      if (settings.schedulerEnabled !== undefined) updated.schedulerEnabled = settings.schedulerEnabled
      if (settings.schedulerState !== undefined) {
        updated.schedulerState = settings.schedulerState
        updated.autoBlockedReason =
          settings.schedulerState === 'auto_blocked'
            ? updated.autoBlockedReason
            : null
        updated.autoBlockedUntil =
          settings.schedulerState === 'auto_blocked'
            ? updated.autoBlockedUntil
            : null
        if (settings.schedulerState === 'enabled') {
          updated.cooldownUntil = null
          // Null lastProbeAttemptAt signals KeepAliveRefresher to reset in-memory probe backoff
          updated.lastProbeAttemptAt = null
        }
      }
      if (settings.proxyUrl !== undefined) updated.proxyUrl = settings.proxyUrl
      if (settings.bodyTemplatePath !== undefined) updated.bodyTemplatePath = settings.bodyTemplatePath
      if (settings.vmFingerprintTemplatePath !== undefined) updated.vmFingerprintTemplatePath = settings.vmFingerprintTemplatePath
      if (settings.label !== undefined) updated.label = settings.label
      if (settings.apiBaseUrl !== undefined) {
        updated.apiBaseUrl =
          settings.apiBaseUrl === null ? null : normalizeApiBaseUrl(settings.apiBaseUrl)
      }
      if (settings.modelName !== undefined) {
        updated.modelName = trimToNull(settings.modelName)
      }
      if (settings.modelTierMap !== undefined) {
        updated.modelTierMap = normalizeClaudeCompatibleTierMap(settings.modelTierMap)
      }
      if (settings.modelMap !== undefined) {
        updated.modelMap = normalizeOpenAICompatibleModelMapInput(settings.modelMap)
      }

      if (updated.routingGroupId) {
        requireRoutingGroupForProvider(data.routingGroups ?? [], updated.routingGroupId, updated.provider)
      }
      if (account.bodyTemplatePath && account.bodyTemplatePath !== updated.bodyTemplatePath) {
        this.fingerprintCache.invalidate(account.bodyTemplatePath)
      }
      if (account.vmFingerprintTemplatePath && account.vmFingerprintTemplatePath !== updated.vmFingerprintTemplatePath) {
        this.fingerprintCache.invalidate(account.vmFingerprintTemplatePath)
      }
      if (updated.bodyTemplatePath) {
        this.fingerprintCache.invalidate(updated.bodyTemplatePath)
      }
      if (updated.vmFingerprintTemplatePath) {
        this.fingerprintCache.invalidate(updated.vmFingerprintTemplatePath)
      }
      return {
        data: {
          ...data,
          accounts: data.accounts.map((a) => (a.id === accountId ? updated : a)),
        },
        result: updated,
      }
    })
    if (enabledTransition) {
      this.scheduler.clearAccountHealth(accountId)
      void this.store.updateAccountRateLimitedUntil?.(accountId, 0)
    }
    return result
  }

  async recordRateLimitSnapshot(input: {
    accountId: string
    status: string | null
    fiveHourUtilization: number | null
    sevenDayUtilization: number | null
    resetTimestamp: number | null
    observedAt?: number
  }): Promise<void> {
    let newlyBlockedReason: string | null = null
    await this.updateAccountRecord(input.accountId, (account, now) => {
      // Reject stale snapshots to prevent slow probes from overwriting fresher data
      if (input.observedAt != null && account.lastRateLimitAt) {
        const existingAt = Date.parse(account.lastRateLimitAt)
        if (!isNaN(existingAt) && input.observedAt < existingAt) {
          process.stdout.write(
            `[relay] snapshot_skipped_stale accountId=${input.accountId} observedAt=${input.observedAt} existingAt=${existingAt}\n`,
          )
          return account
        }
      }
      const nowIso = new Date(now).toISOString()
      const hardBlocked = isHardRateLimitStatus(input.status)
      const currentRateLimitBlockDeadline = resolveRateLimitBlockDeadline(account)
      const nextAutoBlockedUntil = hardBlocked
        ? computeRateLimitAutoBlockedUntil(now, input.resetTimestamp)
        : currentRateLimitBlockDeadline
      const shouldReleaseRateLimitBlock =
        account.schedulerState === 'auto_blocked' &&
        account.autoBlockedReason?.startsWith('rate_limit:') &&
        (nextAutoBlockedUntil === null || nextAutoBlockedUntil <= now) &&
        !hardBlocked
      const nextSchedulerState =
        hardBlocked
          ? 'auto_blocked'
          : shouldReleaseRateLimitBlock
            ? 'enabled'
            : account.schedulerState
      const nextAutoBlockedReason =
        hardBlocked
          ? `rate_limit:${input.status}`
          : shouldReleaseRateLimitBlock
            ? null
            : account.autoBlockedReason
      const nextStoredAutoBlockedUntil =
        hardBlocked
          ? nextAutoBlockedUntil
          : shouldReleaseRateLimitBlock
            ? null
            : account.autoBlockedUntil
      const nextStoredSchedulerState = account.schedulerEnabled ? nextSchedulerState : 'paused'
      const nextBlockedReason = hardBlocked ? `rate_limit:${input.status}` : null
      const wasHardBlocked =
        account.schedulerState === 'auto_blocked' &&
        account.autoBlockedReason?.startsWith('rate_limit:') === true
      if (nextBlockedReason && (!wasHardBlocked || account.autoBlockedReason !== nextBlockedReason)) {
        newlyBlockedReason = nextBlockedReason
      }

      if (
        account.schedulerState === nextStoredSchedulerState &&
        account.autoBlockedReason === nextAutoBlockedReason &&
        account.autoBlockedUntil === nextStoredAutoBlockedUntil &&
        account.lastRateLimitStatus === input.status &&
        account.lastRateLimit5hUtilization === input.fiveHourUtilization &&
        account.lastRateLimit7dUtilization === input.sevenDayUtilization &&
        account.lastRateLimitReset === input.resetTimestamp
      ) {
        // All quota state unchanged. Still touch lastRateLimitAt if the snapshot is stale enough
        // to prevent freshness decay from treating this account as unchecked.
        const lastAt = account.lastRateLimitAt ? new Date(account.lastRateLimitAt).getTime() : 0
        if (now - lastAt < appConfig.quotaDataFreshnessMs / 2) {
          return account
        }
        return { ...account, lastRateLimitAt: nowIso, updatedAt: nowIso }
      }

      return {
        ...account,
        schedulerState: nextStoredSchedulerState,
        autoBlockedReason: nextAutoBlockedReason,
        autoBlockedUntil: nextStoredAutoBlockedUntil,
        lastRateLimitStatus: input.status,
        lastRateLimit5hUtilization: input.fiveHourUtilization,
        lastRateLimit7dUtilization: input.sevenDayUtilization,
        lastRateLimitReset: input.resetTimestamp,
        lastRateLimitAt: nowIso,
        updatedAt: nowIso,
      }
    })

    if (newlyBlockedReason) {
      await Promise.all([
        this.prepareSessionRoutesForBlockedAccount(input.accountId, newlyBlockedReason),
        this.clearStickySessionsForBlockedAccount(input.accountId),
      ])
    }
  }

  async listSessionRoutes(): Promise<SessionRoute[]> {
    return (await this.userStore?.listSessionRoutes()) ?? []
  }

  async clearSessionRoutes(): Promise<void> {
    await this.userStore?.clearSessionRoutes()
  }

  async listSessionHandoffs(limit = 200): Promise<SessionHandoff[]> {
    return (await this.userStore?.listSessionHandoffs(limit)) ?? []
  }

  // ── Proxy CRUD ──

  async listProxies(): Promise<ProxyEntry[]> {
    const data = await this.store.getData()
    return data.proxies
  }

  async resolveProxyUrl(proxyUrl: string | null | undefined): Promise<string | null> {
    return this.resolveConfiguredProxyUrl(proxyUrl)
  }

  async addProxy(label: string, url: string): Promise<ProxyEntry> {
    const id = crypto.randomUUID()
    const entry: ProxyEntry = { id, label: label.trim(), url: url.trim(), localUrl: null, createdAt: Date.now() }
    await this.store.updateData((current) => ({
      data: { ...current, proxies: [...current.proxies, entry] },
      result: entry,
    }))
    return entry
  }

  async updateProxy(id: string, updates: { label?: string; url?: string; localUrl?: string | null }): Promise<ProxyEntry> {
    return this.store.updateData((current) => {
      const proxy = current.proxies.find((p) => p.id === id)
      if (!proxy) throw new Error(`Proxy not found: ${id}`)
      const oldUrl = proxy.url
      const updated = { ...proxy }
      if (updates.label !== undefined) updated.label = updates.label.trim()
      if (updates.url !== undefined) updated.url = updates.url.trim()
      if (updates.localUrl !== undefined) updated.localUrl = updates.localUrl?.trim() || null

      // Update accounts that reference the old URL
      const accounts = updates.url !== undefined && updates.url.trim() !== oldUrl
        ? current.accounts.map((a) => a.proxyUrl === oldUrl ? { ...a, proxyUrl: updated.url } : a)
        : current.accounts

      return {
        data: { ...current, proxies: current.proxies.map((p) => (p.id === id ? updated : p)), accounts },
        result: updated,
      }
    })
  }

  async deleteProxy(id: string): Promise<ProxyEntry> {
    return this.store.updateData((current) => {
      const proxy = current.proxies.find((p) => p.id === id)
      if (!proxy) throw new Error(`Proxy not found: ${id}`)
      // Unlink accounts that use this proxy
      const accounts = current.accounts.map((a) =>
        a.proxyUrl === proxy.url ? { ...a, proxyUrl: null } : a,
      )
      return {
        data: { ...current, proxies: current.proxies.filter((p) => p.id !== id), accounts },
        result: proxy,
      }
    })
  }

  async linkAccountsToProxy(proxyId: string, accountIds: string[]): Promise<void> {
    await this.store.updateData((current) => {
      const proxy = current.proxies.find((p) => p.id === proxyId)
      if (!proxy) throw new Error(`Proxy not found: ${proxyId}`)
      const idSet = new Set(accountIds)
      return {
        data: {
          ...current,
          accounts: current.accounts.map((a) =>
            idSet.has(a.id) ? { ...a, proxyUrl: proxy.url } : a,
          ),
        },
        result: undefined,
      }
    })
  }

  async unlinkAccountFromProxy(accountId: string): Promise<void> {
    await this.store.updateData((current) => ({
      data: {
        ...current,
        accounts: current.accounts.map((a) =>
          a.id === accountId ? { ...a, proxyUrl: null } : a,
        ),
      },
      result: undefined,
    }))
  }

  async markAccountUsed(accountId: string): Promise<void> {
    await this.updateAccountRecord(accountId, (account, now) => {
      const lastUsedAt = account.lastUsedAt ? Date.parse(account.lastUsedAt) : NaN
      if (
        account.status === 'active' &&
        account.lastError === null &&
        Number.isFinite(lastUsedAt) &&
        now - lastUsedAt < 30_000
      ) {
        return account
      }

      const nowIso = new Date(now).toISOString()
      return {
        ...account,
        status: 'active',
        lastError: null,
        lastUsedAt: nowIso,
        updatedAt: nowIso,
      }
    })
  }

  async persistRateLimitedUntil(accountId: string, until: number): Promise<void> {
    await this.store.updateAccountRateLimitedUntil?.(accountId, until)
  }

  async persistLastProbeAttemptAt(accountId: string, at: number): Promise<void> {
    await this.store.updateAccountLastProbeAttemptAt?.(accountId, at)
  }

  async setAccountCooldown(accountId: string, cooldownMs: number): Promise<void> {
    await this.updateAccountRecord(accountId, (account, now) => {
      const nextCooldownUntil = Math.max(account.cooldownUntil ?? 0, now + cooldownMs)
      if (nextCooldownUntil === account.cooldownUntil) {
        return account
      }
      return {
        ...account,
        cooldownUntil: nextCooldownUntil,
        updatedAt: new Date(now).toISOString(),
      }
    })
  }

  async markAccountLongTermBlock(accountId: string, blockUntilMs: number): Promise<void> {
    await this.updateAccountRecord(accountId, (account, now) => {
      if (
        account.schedulerState === 'auto_blocked' &&
        account.autoBlockedReason === 'rate_limit:long_ban'
      ) {
        return account
      }
      const nowIso = new Date(now).toISOString()
      return {
        ...account,
        schedulerState: account.schedulerEnabled ? 'auto_blocked' : account.schedulerState,
        autoBlockedReason: 'rate_limit:long_ban',
        autoBlockedUntil: blockUntilMs,
        lastFailureAt: nowIso,
        updatedAt: nowIso,
      }
    })
  }

  async markAccountTerminalFailure(accountId: string, reason: string): Promise<void> {
    const normalizedReason = reason.trim() || 'terminal_account_failure'
    await this.updateAccountRecord(accountId, (account, now) => {
      const nowIso = new Date(now).toISOString()
      const lastError = normalizedReason.slice(0, 500)
      if (
        !account.isActive &&
        account.status === 'revoked' &&
        account.schedulerState === 'paused' &&
        account.lastError === lastError
      ) {
        return account
      }

      return {
        ...account,
        isActive: false,
        status: 'revoked',
        cooldownUntil: null,
        schedulerState: 'paused',
        autoBlockedReason: normalizedReason,
        autoBlockedUntil: null,
        lastFailureAt: nowIso,
        lastError,
        updatedAt: nowIso,
      }
    })

    await Promise.all([
      this.prepareSessionRoutesForBlockedAccount(accountId, normalizedReason),
      this.clearStickySessionsForBlockedAccount(accountId),
    ])
  }

  private getSessionMigrationReason(
    account: StoredAccount,
    route: SessionRoute,
    now: number,
    activeSessions: number = 0,
  ): string | null {
    if (!this.scheduler.isAccountAvailableForExistingSession(account, now, activeSessions, true)) {
      return account.schedulerState === 'draining'
        ? 'scheduler_draining'
        : account.schedulerState === 'auto_blocked'
          ? account.autoBlockedReason ?? 'auto_blocked'
          : 'account_unavailable'
    }

    const remaining5h = account.lastRateLimit5hUtilization == null
      ? 1
      : Math.max(0, 1 - account.lastRateLimit5hUtilization)
    const remaining7d = account.lastRateLimit7dUtilization == null
      ? 1
      : Math.max(0, 1 - account.lastRateLimit7dUtilization)
    const heuristics = getSubscriptionHeuristics(account.provider, account.subscriptionType)
    const predicted5h = route.predictedBurn5h ?? heuristics.predictedBurn5h
    const predicted7d = route.predictedBurn7d ?? heuristics.predictedBurn7d
    const maxGenerationBurn7d = heuristics.sessionBudgetCap

    if (route.generationBurn7d >= maxGenerationBurn7d) {
      return 'generation_budget_exhausted'
    }
    if (remaining5h <= predicted5h * 1.2) {
      return 'predicted_5h_exhaustion'
    }
    if (remaining7d <= predicted7d * 1.2) {
      return 'predicted_7d_exhaustion'
    }
    if (account.lastRateLimitStatus?.toLowerCase() === 'allowed_warning' && remaining7d <= 0.2) {
      return 'seven_day_warning_guardrail'
    }
    if (account.lastRateLimit5hUtilization != null &&
      account.lastRateLimit5hUtilization >= appConfig.stickyMigration5hUtilThreshold) {
      // Only trigger when the snapshot is fresh; stale data may no longer reflect reality
      const snapshotAge = account.lastRateLimitAt
        ? now - new Date(account.lastRateLimitAt).getTime()
        : Infinity
      if (snapshotAge < appConfig.quotaDataFreshnessMs) {
        // Per-session cooldown: suppress if we migrated away recently
        if (route.lastSoftMigrationAt != null &&
          now - route.lastSoftMigrationAt < appConfig.stickyMigrationCooldownMs) {
          return null
        }
        return 'soft_quota_pressure'
      }
    }
    return null
  }

  private isSoftSessionMigrationReason(reason: string | null): boolean {
    return reason === 'predicted_5h_exhaustion'
      || reason === 'predicted_7d_exhaustion'
      || reason === 'seven_day_warning_guardrail'
      || reason === 'primary_recovered'
      || reason === 'soft_quota_pressure'
  }

  private findMissingProxyCandidate(
    accounts: StoredAccount[],
    group: string | null,
    forceAccountId: string | null,
    now: number,
    disallowedAccountIds: Set<string>,
  ): StoredAccount | null {
    let candidates = accounts.filter((account) => !disallowedAccountIds.has(account.id))
    if (forceAccountId) {
      candidates = candidates.filter((account) => account.id === forceAccountId)
    }
    if (group) {
      candidates = candidates.filter((account) => resolveAccountRoutingGroupId(account) === group)
    }
    return candidates.find((account) =>
      account.isActive &&
      account.status !== 'revoked' &&
      (account.cooldownUntil === null || account.cooldownUntil <= now) &&
      providerRequiresProxy(account.provider) &&
      !account.proxyUrl,
    ) ?? null
  }

  private consumeSession(sessionId: string): OAuthSession {
    const session = this.peekSession(sessionId)
    this.sessions.delete(sessionId)
    return session
  }

  private peekSession(sessionId: string): OAuthSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('OAuth session not found or expired')
    }
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId)
      throw new Error('OAuth session expired')
    }
    return session
  }

  private async resolveConfiguredProxyUrl(proxyUrl: string | null | undefined): Promise<string | null> {
    const normalizedProxyUrl = trimToNull(proxyUrl)
    if (!normalizedProxyUrl) {
      return null
    }

    let normalizedInput: string | null = null
    let normalizedInputError: unknown = null
    try {
      normalizedInput = normalizeProxyUrl(normalizedProxyUrl)
    } catch (error) {
      normalizedInputError = error
    }

    const data = await this.store.getData()
    const matchedProxy = data.proxies.find((proxy) =>
      proxy.id === normalizedProxyUrl ||
      proxy.url === normalizedProxyUrl ||
      proxy.localUrl === normalizedProxyUrl,
    )

    if (matchedProxy?.localUrl) {
      return normalizeProxyUrl(matchedProxy.localUrl)
    }

    if (normalizedInput) {
      return normalizedInput
    }

    if (matchedProxy) {
      throw new Error(
        `Proxy ${matchedProxy.label || matchedProxy.id} has no usable localUrl — configure a local http://, https://, or socks5:// proxy entry first.`,
      )
    }

    throw normalizedInputError
  }

  private async requestTokenGrant(
    body: Record<string, string | number>,
    grantType: 'authorization_code' | 'refresh_token',
    proxyUrl?: string | null,
  ): Promise<OAuthTokenResponse> {
    return this.withOptionalProxyDispatcher(proxyUrl, async (dispatcher) => {
      const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
        dispatcher,
      }
      const response = await fetch(appConfig.oauthTokenUrl, requestInit as RequestInit)

      if (!response.ok) {
        const responseBody = await response.text()
        throw new OAuthTokenRequestError(
          `OAuth ${grantType} failed: ${response.status} ${responseBody.slice(0, 500)}`,
          response.status,
          responseBody,
          grantType,
        )
      }

      return (await response.json()) as OAuthTokenResponse
    })
  }

  private async requestOpenAICodexTokenGrant(
    body: Record<string, string | number>,
    grantType: 'authorization_code' | 'refresh_token',
  ): Promise<OAuthTokenResponse> {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
      form.set(key, String(value))
    }

    const response = await fetch(`${appConfig.openAICodexOauthIssuer}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
    })

    if (!response.ok) {
      const responseBody = await response.text()
      throw new OAuthTokenRequestError(
        `OpenAI Codex OAuth ${grantType} failed: ${response.status} ${responseBody.slice(0, 500)}`,
        response.status,
        responseBody,
        grantType,
      )
    }

    return (await response.json()) as OAuthTokenResponse
  }

  private async persistTokenResponse(
    tokenResponse: OAuthTokenResponse,
    options: PersistTokenOptions,
  ): Promise<StoredAccount> {
    const accessToken = tokenResponse.access_token
    const profile = await this.fetchProfile(accessToken, options.proxyUrl).catch(() => null)
    const scopes = tokenResponse.scope?.split(/\s+/).filter(Boolean) ?? [...appConfig.oauthScopes]
    const roles = scopes.includes('user:profile')
      ? await this.fetchRoles(accessToken, options.proxyUrl).catch(() => null)
      : null

    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const existing = this.findMatchingAccount(data.accounts, tokenResponse, profile, options)
      const nowIso = new Date().toISOString()
      const refreshToken = tokenResponse.refresh_token ?? existing?.refreshToken ?? null
      const expiresInSeconds =
        typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in)
          ? tokenResponse.expires_in
          : null
      const expiresAt = expiresInSeconds !== null ? Date.now() + expiresInSeconds * 1000 : null
      const accountUuid =
        profile?.account?.uuid ?? tokenResponse.account?.uuid ?? existing?.accountUuid ?? null
      const emailAddress =
        profile?.account?.email?.trim().toLowerCase() ??
        tokenResponse.account?.email_address?.trim().toLowerCase() ??
        existing?.emailAddress ??
        null
      const routingGroupId = resolveRoutingGroupId(
        options.routingGroupId,
        options.group,
        existing?.routingGroupId,
        existing?.group,
      )

      const stored: StoredAccount = {
        id:
          existing?.id ??
          buildProviderScopedAccountId(
            CLAUDE_OFFICIAL_PROVIDER.id,
            this.deriveAccountLocalId({ accountUuid, emailAddress }),
          ),
        provider: CLAUDE_OFFICIAL_PROVIDER.id,
        protocol: existing?.protocol ?? CLAUDE_OFFICIAL_PROVIDER.protocol,
        authMode: existing?.authMode ?? CLAUDE_OFFICIAL_PROVIDER.authMode,
        label: this.deriveAccountLabel({
          explicitLabel: options.label,
          existing,
          profile,
          tokenResponse,
        }),
        isActive: true,
        status: 'active',
        lastSelectedAt: existing?.lastSelectedAt ?? null,
        lastUsedAt: existing?.lastUsedAt ?? null,
        lastRefreshAt:
          options.source === 'refresh' ? nowIso : existing?.lastRefreshAt ?? null,
        lastFailureAt: existing?.lastFailureAt ?? null,
        cooldownUntil: options.source === 'login' ? null : existing?.cooldownUntil ?? null,
        lastError: null,
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
        subscriptionType: deriveClaudeSubscriptionType(profile?.organization?.organization_type),
        providerPlanTypeRaw:
          profile?.organization?.organization_type ?? existing?.providerPlanTypeRaw ?? null,
        rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
        accountUuid,
        organizationUuid:
          profile?.organization?.uuid ?? tokenResponse.organization?.uuid ?? existing?.organizationUuid ?? null,
        emailAddress,
        displayName: profile?.account?.display_name ?? existing?.displayName ?? null,
        hasExtraUsageEnabled:
          profile?.organization?.has_extra_usage_enabled ?? existing?.hasExtraUsageEnabled ?? null,
        billingType: profile?.organization?.billing_type ?? existing?.billingType ?? null,
        accountCreatedAt: profile?.account?.created_at ?? existing?.accountCreatedAt ?? null,
        subscriptionCreatedAt:
          profile?.organization?.subscription_created_at ??
          existing?.subscriptionCreatedAt ??
          null,
        rawProfile: profile,
        roles,

        // Preserve scheduling & isolation settings from existing account
        routingGroupId,
        group: routingGroupId,
        maxSessions: existing?.maxSessions ?? null,
        weight: existing?.weight ?? null,
        planType: existing?.planType ?? null,
        planMultiplier: existing?.planMultiplier ?? null,
        schedulerEnabled: existing?.schedulerEnabled ?? true,
        schedulerState:
          options.source === 'login' && existing?.schedulerState === 'auto_blocked'
            ? 'enabled'
            : existing?.schedulerState ?? 'enabled',
        autoBlockedReason: options.source === 'login' ? null : existing?.autoBlockedReason ?? null,
        autoBlockedUntil: options.source === 'login' ? null : existing?.autoBlockedUntil ?? null,
        lastRateLimitStatus: options.source === 'login' ? null : existing?.lastRateLimitStatus ?? null,
        lastRateLimit5hUtilization: options.source === 'login' ? null : existing?.lastRateLimit5hUtilization ?? null,
        lastRateLimit7dUtilization: options.source === 'login' ? null : existing?.lastRateLimit7dUtilization ?? null,
        lastRateLimitReset: options.source === 'login' ? null : existing?.lastRateLimitReset ?? null,
        lastRateLimitAt: options.source === 'login' ? null : existing?.lastRateLimitAt ?? null,
        lastProbeAttemptAt: options.source === 'login' ? null : existing?.lastProbeAttemptAt ?? null,
        proxyUrl: trimToNull(options.proxyUrl) ?? existing?.proxyUrl ?? null,
        bodyTemplatePath: existing?.bodyTemplatePath ?? null,
        vmFingerprintTemplatePath: existing?.vmFingerprintTemplatePath ?? null,
        deviceId: existing?.deviceId ?? crypto.randomBytes(32).toString('hex'),
        apiBaseUrl: existing?.apiBaseUrl ?? null,
        modelName: existing?.modelName ?? null,
        modelTierMap: existing?.modelTierMap ?? null,
        modelMap: existing?.modelMap ?? null,
        loginPassword: existing?.loginPassword ?? null,
      }

      const routingGroups = routingGroupId
        ? ensureRoutingGroupStub(data.routingGroups ?? [], routingGroupId, CLAUDE_OFFICIAL_PROVIDER.id, nowIso)
        : (data.routingGroups ?? [])
      if (routingGroupId) {
        requireRoutingGroupForProvider(routingGroups, routingGroupId, CLAUDE_OFFICIAL_PROVIDER.id)
      }
      return {
        data: {
          ...data,
          routingGroups,
          accounts: sortAccountsForDisplay(
            data.accounts
              .filter((account) => account.id !== stored.id)
              .concat(stored),
          ),
        },
        result: stored,
      }
    })
  }

  private async persistOpenAICodexTokenResponse(
    tokenResponse: OAuthTokenResponse,
    options: PersistTokenOptions,
  ): Promise<StoredAccount> {
    const accessToken = tokenResponse.access_token?.trim()
    if (!accessToken) {
      throw new Error('OpenAI Codex OAuth response is missing access_token')
    }

    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const claims = parseOpenAICodexTokenClaims(tokenResponse.id_token ?? accessToken)
      const existing = this.findMatchingOpenAICodexAccount(data.accounts, claims, options)
      const nowIso = new Date().toISOString()
      const refreshToken = tokenResponse.refresh_token ?? existing?.refreshToken ?? null
      const expiresAt =
        typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in)
          ? Date.now() + tokenResponse.expires_in * 1000
          : existing?.expiresAt ?? null
      const routingGroupId = resolveRoutingGroupId(
        options.routingGroupId,
        options.group,
        existing?.routingGroupId,
        existing?.group,
      )
      const stored: StoredAccount = {
        id:
          existing?.id ??
          buildProviderScopedAccountId(
            OPENAI_CODEX_PROVIDER.id,
            this.deriveOpenAICodexLocalId(claims),
          ),
        provider: OPENAI_CODEX_PROVIDER.id,
        protocol: existing?.protocol ?? OPENAI_CODEX_PROVIDER.protocol,
        authMode: existing?.authMode ?? OPENAI_CODEX_PROVIDER.authMode,
        label:
          trimToNull(options.label) ??
          existing?.label ??
          claims.emailAddress ??
          null,
        isActive: true,
        status: 'active',
        lastSelectedAt: existing?.lastSelectedAt ?? null,
        lastUsedAt: existing?.lastUsedAt ?? null,
        lastRefreshAt:
          options.source === 'refresh' ? nowIso : existing?.lastRefreshAt ?? null,
        lastFailureAt: existing?.lastFailureAt ?? null,
        cooldownUntil: options.source === 'login' ? null : existing?.cooldownUntil ?? null,
        lastError: null,
        accessToken,
        refreshToken,
        expiresAt,
        scopes:
          tokenResponse.scope?.split(/\s+/).filter(Boolean) ??
          existing?.scopes ??
          [...OPENAI_CODEX_OAUTH_SCOPES],
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
        subscriptionType: deriveOpenAICodexSubscriptionType(
          claims.chatgptPlanType,
          existing?.subscriptionType ?? null,
        ),
        providerPlanTypeRaw: claims.chatgptPlanType ?? existing?.providerPlanTypeRaw ?? null,
        rateLimitTier: existing?.rateLimitTier ?? null,
        accountUuid: claims.chatgptUserId ?? existing?.accountUuid ?? null,
        organizationUuid: claims.chatgptAccountId ?? existing?.organizationUuid ?? null,
        emailAddress: claims.emailAddress ?? existing?.emailAddress ?? null,
        displayName: existing?.displayName ?? claims.emailAddress ?? 'OpenAI Codex',
        hasExtraUsageEnabled: existing?.hasExtraUsageEnabled ?? null,
        billingType: existing?.billingType ?? null,
        accountCreatedAt: existing?.accountCreatedAt ?? null,
        subscriptionCreatedAt: existing?.subscriptionCreatedAt ?? null,
        rawProfile: null,
        roles: existing?.roles ?? null,
        routingGroupId,
        group: routingGroupId,
        maxSessions: existing?.maxSessions ?? null,
        weight: existing?.weight ?? null,
        planType: existing?.planType ?? null,
        planMultiplier: existing?.planMultiplier ?? null,
        schedulerEnabled: existing?.schedulerEnabled ?? true,
        schedulerState:
          options.source === 'login' && existing?.schedulerState === 'auto_blocked'
            ? 'enabled'
            : existing?.schedulerState ?? 'enabled',
        autoBlockedReason: options.source === 'login' ? null : existing?.autoBlockedReason ?? null,
        autoBlockedUntil: options.source === 'login' ? null : existing?.autoBlockedUntil ?? null,
        lastRateLimitStatus: options.source === 'login' ? null : existing?.lastRateLimitStatus ?? null,
        lastRateLimit5hUtilization: options.source === 'login' ? null : existing?.lastRateLimit5hUtilization ?? null,
        lastRateLimit7dUtilization: options.source === 'login' ? null : existing?.lastRateLimit7dUtilization ?? null,
        lastRateLimitReset: options.source === 'login' ? null : existing?.lastRateLimitReset ?? null,
        lastRateLimitAt: options.source === 'login' ? null : existing?.lastRateLimitAt ?? null,
        lastProbeAttemptAt: options.source === 'login' ? null : existing?.lastProbeAttemptAt ?? null,
        proxyUrl: trimToNull(options.proxyUrl) ?? existing?.proxyUrl ?? null,
        bodyTemplatePath: existing?.bodyTemplatePath ?? null,
        vmFingerprintTemplatePath: existing?.vmFingerprintTemplatePath ?? null,
        deviceId: existing?.deviceId ?? crypto.randomBytes(32).toString('hex'),
        apiBaseUrl: normalizeOpenAICodexApiBaseUrl(
          trimToNull(options.apiBaseUrl) ??
          existing?.apiBaseUrl ??
          appConfig.openAICodexApiBaseUrl,
        ),
        modelName:
          trimToNull(options.modelName) ??
          existing?.modelName ??
          appConfig.openAICodexModel,
        modelTierMap: existing?.modelTierMap ?? null,
        modelMap: existing?.modelMap ?? null,
        loginPassword: existing?.loginPassword ?? null,
      }

      const routingGroups = routingGroupId
        ? ensureRoutingGroupStub(data.routingGroups ?? [], routingGroupId, OPENAI_CODEX_PROVIDER.id, nowIso)
        : (data.routingGroups ?? [])
      if (routingGroupId) {
        requireRoutingGroupForProvider(routingGroups, routingGroupId, OPENAI_CODEX_PROVIDER.id)
      }
      return {
        data: {
          ...data,
          routingGroups,
          accounts: sortAccountsForDisplay(
            data.accounts
              .filter((account) => account.id !== stored.id)
              .concat(stored),
          ),
        },
        result: stored,
      }
    })
  }

  private async requestGeminiTokenGrant(
    body: Record<string, string | number>,
    grantType: 'authorization_code' | 'refresh_token',
  ): Promise<OAuthTokenResponse> {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
      form.set(key, String(value))
    }
    const response = await fetch(appConfig.geminiOauthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
    })
    if (!response.ok) {
      const responseBody = await response.text()
      throw new OAuthTokenRequestError(
        `Gemini OAuth ${grantType} failed: ${response.status} ${responseBody.slice(0, 500)}`,
        response.status,
        responseBody,
        grantType,
      )
    }
    return (await response.json()) as OAuthTokenResponse
  }

  private async fetchGeminiAccountMetadata(
    accessToken: string,
  ): Promise<GeminiAccountMetadata | null> {
    if (!accessToken) return null
    type GeminiUserInfo = {
      sub?: string
      email?: string
      name?: string
      picture?: string
    }
    let userInfo: GeminiUserInfo | null = null
    try {
      const res = await fetch(appConfig.geminiOauthUserInfoUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
      })
      if (res.ok) {
        userInfo = (await res.json()) as GeminiUserInfo
      }
    } catch {
      // best-effort
    }

    let cloudaicompanionProject: string | null = null
    let userTier: GeminiUserTier | null = null
    try {
      const loadUrl = `${appConfig.geminiCodeAssistEndpoint}/${appConfig.geminiCodeAssistApiVersion}:loadCodeAssist`
      const res = await fetch(loadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
        signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
      })
      if (res.ok) {
        const data = (await res.json()) as {
          cloudaicompanionProject?: { id?: string; name?: string } | string
          currentTier?: { id?: string }
        }
        if (typeof data.cloudaicompanionProject === 'string') {
          cloudaicompanionProject = data.cloudaicompanionProject
        } else if (data.cloudaicompanionProject?.id) {
          cloudaicompanionProject = data.cloudaicompanionProject.id
        }
        if (data.currentTier?.id) {
          userTier = data.currentTier.id as GeminiUserTier
        }
      }
    } catch {
      // best-effort
    }

    return {
      cloudaicompanionProject,
      userTier,
      emailAddress: userInfo?.email ?? null,
      displayName: userInfo?.name ?? null,
      pictureUrl: userInfo?.picture ?? null,
      sub: userInfo?.sub ?? null,
    }
  }

  private async persistGeminiTokenResponse(
    tokenResponse: OAuthTokenResponse,
    options: PersistTokenOptions & { metadata?: GeminiAccountMetadata | null },
  ): Promise<StoredAccount> {
    const accessToken = tokenResponse.access_token?.trim()
    if (!accessToken) {
      throw new Error('Gemini OAuth response is missing access_token')
    }

    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const metadata = options.metadata ?? null
      const existing = this.findMatchingGeminiAccount(data.accounts, metadata, options)
      const nowIso = new Date().toISOString()
      const refreshToken = tokenResponse.refresh_token ?? existing?.refreshToken ?? null
      const expiresAt =
        typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in)
          ? Date.now() + tokenResponse.expires_in * 1000
          : existing?.expiresAt ?? null
      const routingGroupId = resolveRoutingGroupId(
        options.routingGroupId,
        options.group,
        existing?.routingGroupId,
        existing?.group,
      )
      const emailAddress = metadata?.emailAddress?.trim().toLowerCase() ?? existing?.emailAddress ?? null
      const subscriptionType = deriveGeminiSubscriptionType(metadata?.userTier ?? null)
      const rawProfile = {
        cloudaicompanionProject:
          metadata?.cloudaicompanionProject ?? (existing ? readGeminiProjectFromAccount(existing) : null),
        userTier: metadata?.userTier ?? (existing ? readGeminiTierFromAccount(existing) : null),
        emailAddress,
        displayName: metadata?.displayName ?? existing?.displayName ?? null,
        pictureUrl: metadata?.pictureUrl ?? null,
        sub: metadata?.sub ?? existing?.accountUuid ?? null,
      }

      const stored: StoredAccount = {
        id:
          existing?.id ??
          buildProviderScopedAccountId(
            GOOGLE_GEMINI_OAUTH_PROVIDER.id,
            this.deriveGeminiLocalId({ sub: metadata?.sub ?? null, emailAddress }),
          ),
        provider: GOOGLE_GEMINI_OAUTH_PROVIDER.id,
        protocol: existing?.protocol ?? GOOGLE_GEMINI_OAUTH_PROVIDER.protocol,
        authMode: existing?.authMode ?? GOOGLE_GEMINI_OAUTH_PROVIDER.authMode,
        label:
          trimToNull(options.label) ??
          existing?.label ??
          metadata?.displayName ??
          emailAddress ??
          'Google Gemini',
        isActive: true,
        status: 'active',
        lastSelectedAt: existing?.lastSelectedAt ?? null,
        lastUsedAt: existing?.lastUsedAt ?? null,
        lastRefreshAt:
          options.source === 'refresh' ? nowIso : existing?.lastRefreshAt ?? null,
        lastFailureAt: existing?.lastFailureAt ?? null,
        cooldownUntil: options.source === 'login' ? null : existing?.cooldownUntil ?? null,
        lastError: null,
        accessToken,
        refreshToken,
        expiresAt,
        scopes: tokenResponse.scope?.split(/\s+/).filter(Boolean) ?? [...GEMINI_OAUTH_SCOPES],
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
        subscriptionType,
        providerPlanTypeRaw: metadata?.userTier ?? existing?.providerPlanTypeRaw ?? null,
        rateLimitTier: existing?.rateLimitTier ?? null,
        accountUuid: metadata?.sub ?? existing?.accountUuid ?? null,
        organizationUuid: metadata?.cloudaicompanionProject ?? existing?.organizationUuid ?? null,
        emailAddress,
        displayName: metadata?.displayName ?? existing?.displayName ?? null,
        hasExtraUsageEnabled: existing?.hasExtraUsageEnabled ?? null,
        billingType: existing?.billingType ?? null,
        accountCreatedAt: existing?.accountCreatedAt ?? null,
        subscriptionCreatedAt: existing?.subscriptionCreatedAt ?? null,
        rawProfile: rawProfile as unknown as OAuthProfile,
        roles: existing?.roles ?? null,
        routingGroupId,
        group: routingGroupId,
        maxSessions: existing?.maxSessions ?? null,
        weight: existing?.weight ?? null,
        planType: existing?.planType ?? null,
        planMultiplier: existing?.planMultiplier ?? null,
        schedulerEnabled: existing?.schedulerEnabled ?? true,
        schedulerState:
          options.source === 'login' && existing?.schedulerState === 'auto_blocked'
            ? 'enabled'
            : existing?.schedulerState ?? 'enabled',
        autoBlockedReason: options.source === 'login' ? null : existing?.autoBlockedReason ?? null,
        autoBlockedUntil: options.source === 'login' ? null : existing?.autoBlockedUntil ?? null,
        lastRateLimitStatus: options.source === 'login' ? null : existing?.lastRateLimitStatus ?? null,
        lastRateLimit5hUtilization: options.source === 'login' ? null : existing?.lastRateLimit5hUtilization ?? null,
        lastRateLimit7dUtilization: options.source === 'login' ? null : existing?.lastRateLimit7dUtilization ?? null,
        lastRateLimitReset: options.source === 'login' ? null : existing?.lastRateLimitReset ?? null,
        lastRateLimitAt: options.source === 'login' ? null : existing?.lastRateLimitAt ?? null,
        lastProbeAttemptAt: options.source === 'login' ? null : existing?.lastProbeAttemptAt ?? null,
        proxyUrl: trimToNull(options.proxyUrl) ?? existing?.proxyUrl ?? null,
        bodyTemplatePath: existing?.bodyTemplatePath ?? null,
        vmFingerprintTemplatePath: existing?.vmFingerprintTemplatePath ?? null,
        deviceId: existing?.deviceId ?? crypto.randomBytes(32).toString('hex'),
        apiBaseUrl: existing?.apiBaseUrl ?? null,
        modelName: trimToNull(options.modelName) ?? existing?.modelName ?? appConfig.geminiDefaultModel,
        modelTierMap: existing?.modelTierMap ?? null,
        modelMap: existing?.modelMap ?? null,
        loginPassword: existing?.loginPassword ?? null,
      }

      const routingGroups = routingGroupId
        ? ensureRoutingGroupStub(data.routingGroups ?? [], routingGroupId, GOOGLE_GEMINI_OAUTH_PROVIDER.id, nowIso)
        : (data.routingGroups ?? [])
      if (routingGroupId) {
        requireRoutingGroupForProvider(routingGroups, routingGroupId, GOOGLE_GEMINI_OAUTH_PROVIDER.id)
      }
      return {
        data: {
          ...data,
          routingGroups,
          accounts: sortAccountsForDisplay(
            data.accounts
              .filter((account) => account.id !== stored.id)
              .concat(stored),
          ),
        },
        result: stored,
      }
    })
  }

  private findMatchingGeminiAccount(
    accounts: StoredAccount[],
    metadata: GeminiAccountMetadata | null,
    options: PersistTokenOptions,
  ): StoredAccount | null {
    if (options.existingAccountId) {
      return accounts.find((account) => account.id === options.existingAccountId) ?? null
    }
    if (metadata?.sub) {
      const bySub = accounts.find(
        (account) => account.provider === GOOGLE_GEMINI_OAUTH_PROVIDER.id && account.accountUuid === metadata.sub,
      )
      if (bySub) return bySub
    }
    if (metadata?.emailAddress) {
      const byEmail = accounts.find(
        (account) =>
          account.provider === GOOGLE_GEMINI_OAUTH_PROVIDER.id &&
          (account.emailAddress ?? '').toLowerCase() === metadata.emailAddress!.toLowerCase(),
      )
      if (byEmail) return byEmail
    }
    return null
  }

  private deriveGeminiLocalId(input: { sub: string | null; emailAddress: string | null }): string {
    if (input.sub) return input.sub
    if (input.emailAddress) return input.emailAddress.toLowerCase()
    return crypto.randomBytes(8).toString('hex')
  }

  private async ensureFreshAccount(account: StoredAccount): Promise<StoredAccount> {
    if (account.authMode !== 'oauth') {
      return account
    }
    const fresh = await this.getAccount(account.id)
    if (fresh && !this.isExpired(fresh.expiresAt)) {
      return fresh
    }
    return this.refreshAccount(account.id)
  }

  private async selectStoredAccountCandidate(options: SelectAccountOptions): Promise<StoredSelectionResult> {
    const sessionHash = options.sessionKey ? this.hashSessionKey(options.sessionKey) : null
    const routingGroupId = resolveRoutingGroupId(options.routingGroupId, options.group)

    return this.store.updateData(async (current) => {
      const currentRoute =
        options.sessionKey && this.userStore
          ? await this.userStore.getSessionRoute(options.sessionKey)
          : null
      const activeSessionCounts = await this.userStore?.getActiveSessionCounts()
      const routingGuard =
        options.userId && this.userStore
          ? await this.userStore.getRoutingGuardSnapshot({
              userId: options.userId,
              clientDeviceId: options.clientDeviceId ?? null,
            })
          : {
              userActiveSessions: 0,
              clientDeviceActiveSessions: 0,
              userRecentRequests: 0,
              clientDeviceRecentRequests: 0,
              userRecentTokens: 0,
              clientDeviceRecentTokens: 0,
            }
      const preferredAccountIds =
        options.userId && options.clientDeviceId && this.userStore
          ? await this.userStore.getPreferredAccountIdsForClientDevice({
              userId: options.userId,
              clientDeviceId: options.clientDeviceId,
            })
          : []
      const explicitlyDisallowedAccountIds = new Set<string>()
      if (options.disallowedAccountId) {
        explicitlyDisallowedAccountIds.add(options.disallowedAccountId)
      }
      if (options.disallowedAccountIds) {
        for (const id of options.disallowedAccountIds) {
          explicitlyDisallowedAccountIds.add(id)
        }
      }

      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const data = this.pruneExpiredStickySessions(current, now)
      const routingGroupMap = buildRoutingGroupMap(data.routingGroups ?? [])
      const requestedRoutingGroup = routingGroupId ? routingGroupMap.get(routingGroupId) ?? null : null
      if (requestedRoutingGroup && !requestedRoutingGroup.isActive) {
        throw new Error(`Routing group is disabled: ${routingGroupId}`)
      }
      const availableAccounts = data.accounts.filter((account) =>
        isRoutingGroupEnabled(routingGroupMap, resolveAccountRoutingGroupId(account)),
      )
      if (options.forceAccountId) {
        const forcedAccount = data.accounts.find((account) => account.id === options.forceAccountId) ?? null
        if (
          forcedAccount &&
          !isRoutingGroupEnabled(routingGroupMap, resolveAccountRoutingGroupId(forcedAccount))
        ) {
          throw new Error(
            `Routing group is disabled: ${resolveAccountRoutingGroupId(forcedAccount) ?? 'unknown'}`,
          )
        }
      }
      const currentRouteAccount = currentRoute
        ? availableAccounts.find((account) => account.id === currentRoute.accountId) ?? null
        : null
      const currentRouteAccountActiveSessions = currentRouteAccount
        ? activeSessionCounts?.get(currentRouteAccount.id) ?? 0
        : 0
      const primaryAccountIdForRoute =
        currentRoute?.primaryAccountId ?? currentRoute?.accountId ?? null
      const primaryAccount =
        primaryAccountIdForRoute && primaryAccountIdForRoute !== currentRoute?.accountId
          ? availableAccounts.find((account) => account.id === primaryAccountIdForRoute) ?? null
          : null
      const primaryAccountActiveSessions = primaryAccount
        ? activeSessionCounts?.get(primaryAccount.id) ?? 0
        : 0
      const canRecoverToPrimary = Boolean(
        primaryAccount &&
        currentRoute &&
        primaryAccount.id !== currentRoute.accountId &&
        !(currentRoute.lastSoftMigrationAt != null &&
          now - currentRoute.lastSoftMigrationAt < appConfig.stickyMigrationCooldownMs) &&
          (!options.forceAccountId || options.forceAccountId === primaryAccount.id) &&
        !explicitlyDisallowedAccountIds.has(primaryAccount.id) &&
        this.scheduler.isAccountAvailableForExistingSession(
          primaryAccount,
          now,
          primaryAccountActiveSessions,
          true,
        ),
      )
      const baseMigrationReason =
        currentRouteAccount && currentRoute
          ? this.getSessionMigrationReason(
              currentRouteAccount,
              currentRoute,
              now,
              currentRouteAccountActiveSessions,
            )
          : currentRoute
            ? 'route_account_missing'
            : null
      const migrationReason =
        canRecoverToPrimary && !baseMigrationReason ? 'primary_recovered' : baseMigrationReason

      const canReuseCurrentRoute =
        Boolean(
          currentRoute &&
          currentRouteAccount &&
          (!options.forceAccountId || options.forceAccountId === currentRoute.accountId) &&
          !explicitlyDisallowedAccountIds.has(currentRoute.accountId) &&
          !migrationReason &&
          this.scheduler.isAccountAvailableForExistingSession(
            currentRouteAccount,
            now,
            currentRouteAccountActiveSessions,
            true,
          ),
        )

      const canFallbackToCurrentRoute =
        Boolean(
          currentRoute &&
          currentRouteAccount &&
          migrationReason &&
          this.isSoftSessionMigrationReason(migrationReason) &&
          (!options.forceAccountId || options.forceAccountId === currentRoute.accountId) &&
          !explicitlyDisallowedAccountIds.has(currentRoute.accountId) &&
          this.scheduler.isAccountAvailableForExistingSession(
            currentRouteAccount,
            now,
            currentRouteAccountActiveSessions,
            true,
          ),
        )

      if (!canReuseCurrentRoute && !canFallbackToCurrentRoute) {
        this.assertRoutingGuards(options, routingGuard)
      }

      let selectedAccount: StoredAccount
      let selectedCurrentRoute = false
      if (canReuseCurrentRoute && currentRouteAccount) {
        selectedAccount = currentRouteAccount
        selectedCurrentRoute = true
      } else if (canRecoverToPrimary && primaryAccount && migrationReason === 'primary_recovered') {
        selectedAccount = primaryAccount
      } else {
        const disallowedAccountIds = new Set(explicitlyDisallowedAccountIds)
        if (currentRoute && migrationReason) {
          disallowedAccountIds.add(currentRoute.accountId)
        }

        // For soft_quota_pressure migrations without a forced account, filter candidates
        // to those clearly below the threshold (hysteresis margin) to avoid ping-pong.
        const candidateAccounts =
          migrationReason === 'soft_quota_pressure' && !options.forceAccountId
            ? availableAccounts.filter(
                (a) =>
                  a.lastRateLimit5hUtilization == null ||
                  a.lastRateLimit5hUtilization <
                    appConfig.stickyMigration5hUtilThreshold - appConfig.stickyMigrationHysteresis,
              )
            : availableAccounts
        const scopedCandidateStats = this.scheduler.getStats(
          candidateAccounts
            .filter((account) => !disallowedAccountIds.has(account.id))
            .filter((account) =>
              options.provider ? account.provider === options.provider : true,
            )
            .filter((account) =>
              routingGroupId
                ? resolveAccountRoutingGroupId(account) === routingGroupId
                : true,
            ),
          data.stickySessions,
          now,
          activeSessionCounts,
          new Set(preferredAccountIds),
        )
        const allowCooldownFallback = scopedCandidateStats.length > 0 && scopedCandidateStats.every(
          (stat) => stat.blockedReason === 'cooldown' || stat.blockedReason === 'health_rate_limited',
        )

        try {
          selectedAccount = this.scheduler.selectAccount(
            candidateAccounts,
            data.stickySessions,
            {
              sessionHash: currentRoute ? null : sessionHash,
              forceAccountId: options.forceAccountId ?? null,
              provider: options.provider ?? null,
              group: routingGroupId,
              activeSessionCounts,
              disallowedAccountIds: [...disallowedAccountIds],
              preferredAccountIds,
              primaryAccountId: primaryAccountIdForRoute,
              allowCooldownFallback,
              allowCapacityOverflowFallback: options.provider === OPENAI_CODEX_PROVIDER.id,
            },
            now,
          )
          if (canFallbackToCurrentRoute) {
            this.assertRoutingGuards(options, routingGuard)
          }
        } catch (error) {
          if (canFallbackToCurrentRoute && currentRouteAccount) {
            selectedAccount = currentRouteAccount
            selectedCurrentRoute = true
          } else {
            const missingProxyAccount = this.findMissingProxyCandidate(
              availableAccounts,
              routingGroupId,
              options.forceAccountId ?? null,
              now,
              disallowedAccountIds,
            )
            if (missingProxyAccount) {
              throw new Error(`Account ${missingProxyAccount.id} has no proxy configured`)
            }
            if (isNoAvailableAccountsError(error)) {
              const scopedAccounts = availableAccounts
                .filter((account) => !disallowedAccountIds.has(account.id))
                .filter((account) =>
                  options.provider ? account.provider === options.provider : true,
                )
                .filter((account) =>
                  routingGroupId
                    ? resolveAccountRoutingGroupId(account) === routingGroupId
                    : true,
                )
              const scopedStats = this.scheduler.getStats(
                scopedAccounts,
                data.stickySessions,
                now,
                activeSessionCounts,
                new Set(preferredAccountIds),
              )
              throw new Error(buildAccountSelectionFailureDetail(error.message, scopedStats, {
                provider: options.provider ?? null,
                routingGroupId,
              }))
            }
            throw error
          }
        }
      }

      const isCooldownFallback = !selectedCurrentRoute &&
        this.scheduler.getEffectiveCooldownUntil(selectedAccount.id, selectedAccount.cooldownUntil, now) > now

      let stickySessions = data.stickySessions
      if (sessionHash) {
        const existingBinding = stickySessions.find((b) => b.sessionHash === sessionHash)
        if (existingBinding && existingBinding.accountId !== selectedAccount.id) {
          stickySessions = stickySessions.filter((b) => b.sessionHash !== sessionHash)
        }
      }

      const updatedSelection: StoredAccount = {
        ...selectedAccount,
        lastSelectedAt: nowIso,
        updatedAt: nowIso,
      }

      // Attempt session route update; on failure revert to original data
      let sessionRoute: SessionRoute | null = null
      let handoffSummary: string | null = null
      let handoffReason: string | null = null

      if (options.sessionKey && this.userStore) {
        try {
          if (currentRoute && updatedSelection.id === currentRoute.accountId && selectedCurrentRoute) {
            sessionRoute = await this.userStore.ensureSessionRoute({
              sessionKey: options.sessionKey,
              userId: options.userId ?? null,
              clientDeviceId: options.clientDeviceId ?? null,
              accountId: updatedSelection.id,
              primaryAccountId: currentRoute.primaryAccountId ?? updatedSelection.id,
            })
          } else if (currentRoute && updatedSelection.id !== currentRoute.accountId) {
            const currentRouteAccountForHandoff = data.accounts.find((a) => a.id === currentRoute.accountId) ?? null
            handoffReason =
              options.handoffReason ??
              migrationReason ??
              (currentRouteAccountForHandoff
                ? this.getSessionMigrationReason(currentRouteAccountForHandoff, currentRoute, now)
                : null) ??
              'session_route_migration'
            handoffSummary =
              currentRoute.pendingHandoffSummary?.trim()
                ? currentRoute.pendingHandoffSummary
                : await this.userStore.buildSessionHandoffSummary({
                    sessionKey: options.sessionKey,
                    fromAccountId: currentRoute.accountId,
                    currentRequestBodyPreview: options.currentRequestBodyPreview ?? null,
                  })
            const preservedPrimary =
              currentRoute.primaryAccountId ?? currentRoute.accountId
            sessionRoute = await this.userStore.migrateSessionRoute({
              sessionKey: options.sessionKey,
              userId: options.userId ?? null,
              clientDeviceId: options.clientDeviceId ?? null,
              fromAccountId: currentRoute.accountId,
              toAccountId: updatedSelection.id,
              reason: handoffReason,
              summary: handoffSummary,
              primaryAccountId: preservedPrimary,
            })
            if (this.isSoftSessionMigrationReason(handoffReason)) {
              void this.userStore.updateSessionRouteSoftMigrationAt(options.sessionKey, now)
            }
          } else {
            sessionRoute = await this.userStore.ensureSessionRoute({
              sessionKey: options.sessionKey,
              userId: options.userId ?? null,
              clientDeviceId: options.clientDeviceId ?? null,
              accountId: updatedSelection.id,
              primaryAccountId: currentRoute?.primaryAccountId ?? updatedSelection.id,
            })
          }
        } catch {
          // Session route update failed; revert token store changes for consistency
          return {
            data: current,
            result: {
              account: selectedAccount,
              sessionRoute: currentRoute,
              handoffSummary: null,
              handoffReason: null,
              isCooldownFallback,
            },
          }
        }
      }

      const nextData: TokenStoreData = {
        ...data,
        accounts: data.accounts.map((account) =>
          account.id === updatedSelection.id ? updatedSelection : account,
        ),
        stickySessions: sessionHash
          ? this.upsertStickySession(stickySessions, sessionHash, updatedSelection.id, now, nowIso)
          : stickySessions,
      }

      return {
        data: nextData,
        result: {
          account: updatedSelection,
          sessionRoute,
          handoffSummary,
          handoffReason,
          isCooldownFallback,
        },
      }
    })
  }

  private pruneExpiredStickySessions(
    data: TokenStoreData,
    now: number = Date.now(),
  ): TokenStoreData {
    return {
      ...data,
      accounts: data.accounts.map((account) => this.releaseExpiredRateLimitBlock(account, now)),
      stickySessions: data.stickySessions.filter((binding) => binding.expiresAt > now),
    }
  }

  private releaseExpiredRateLimitBlock(account: StoredAccount, now: number): StoredAccount {
    const rateLimitBlockDeadline = resolveRateLimitBlockDeadline(account)
    if (
      account.schedulerState !== 'auto_blocked' ||
      !account.autoBlockedReason?.startsWith('rate_limit:') ||
      rateLimitBlockDeadline == null ||
      rateLimitBlockDeadline > now
    ) {
      return account
    }

    const shouldClearStaleRateLimitSnapshot = !account.lastRateLimitAt

    return {
      ...account,
      schedulerState: account.schedulerEnabled ? 'enabled' : 'paused',
      autoBlockedReason: null,
      autoBlockedUntil: null,
      lastRateLimitStatus: shouldClearStaleRateLimitSnapshot ? null : account.lastRateLimitStatus,
      lastRateLimit5hUtilization: shouldClearStaleRateLimitSnapshot ? null : account.lastRateLimit5hUtilization,
      lastRateLimit7dUtilization: shouldClearStaleRateLimitSnapshot ? null : account.lastRateLimit7dUtilization,
      lastRateLimitReset: shouldClearStaleRateLimitSnapshot ? null : account.lastRateLimitReset,
      updatedAt: new Date(now).toISOString(),
    }
  }

  private async updateAccountRecord(
    accountId: string,
    updater: (account: StoredAccount, now: number) => StoredAccount,
  ): Promise<StoredAccount | null> {
    const now = Date.now()
    if (this.store.updateAccount) {
      return this.store.updateAccount(accountId, (account) =>
        updater(this.releaseExpiredRateLimitBlock(account, now), now),
      )
    }

    return this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current, now)
      let updatedAccount: StoredAccount | null = null
      let changed = false
      const accounts = data.accounts.map((account) => {
        if (account.id !== accountId) {
          return account
        }
        const next = updater(account, now)
        updatedAccount = next
        changed = next !== account
        return next
      })

      return {
        data: changed ? { ...data, accounts } : data,
        result: updatedAccount,
      }
    })
  }

  private async prepareSessionRoutesForBlockedAccount(
    accountId: string,
    reason: string,
  ): Promise<void> {
    if (!this.userStore) {
      return
    }
    await this.userStore.prepareSessionRoutesForAccountHandoff({
      accountId,
      reason,
    })
  }

  private async clearStickySessionsForBlockedAccount(accountId: string): Promise<void> {
    await this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const stickySessions = data.stickySessions.filter((binding) => binding.accountId !== accountId)
      if (stickySessions.length === data.stickySessions.length) {
        return {
          data,
          result: undefined,
        }
      }
      return {
        data: {
          ...data,
          stickySessions,
        },
        result: undefined,
      }
    })
  }

  private assertRoutingGuards(
    options: SelectAccountOptions,
    snapshot: {
      userActiveSessions: number
      clientDeviceActiveSessions: number
      userRecentRequests: number
      clientDeviceRecentRequests: number
      userRecentTokens: number
      clientDeviceRecentTokens: number
    },
  ): void {
    if (
      options.userId &&
      snapshot.userActiveSessions >= appConfig.routingUserMaxActiveSessions
    ) {
      throw new RoutingGuardError(
        'user_active_session_limit',
        appConfig.routingUserMaxActiveSessions,
        snapshot.userActiveSessions,
      )
    }

    if (
      options.userId &&
      options.clientDeviceId &&
      snapshot.clientDeviceActiveSessions >= appConfig.routingDeviceMaxActiveSessions
    ) {
      throw new RoutingGuardError(
        'client_device_active_session_limit',
        appConfig.routingDeviceMaxActiveSessions,
        snapshot.clientDeviceActiveSessions,
      )
    }

    if (
      options.userId &&
      snapshot.userRecentRequests >= appConfig.routingUserMaxRequestsPerWindow
    ) {
      throw new RoutingGuardError(
        'user_request_budget_exceeded',
        appConfig.routingUserMaxRequestsPerWindow,
        snapshot.userRecentRequests,
      )
    }

    if (
      options.userId &&
      options.clientDeviceId &&
      snapshot.clientDeviceRecentRequests >= appConfig.routingDeviceMaxRequestsPerWindow
    ) {
      throw new RoutingGuardError(
        'client_device_request_budget_exceeded',
        appConfig.routingDeviceMaxRequestsPerWindow,
        snapshot.clientDeviceRecentRequests,
      )
    }

    if (
      options.userId &&
      snapshot.userRecentTokens >= appConfig.routingUserMaxTokensPerWindow
    ) {
      throw new RoutingGuardError(
        'user_token_budget_exceeded',
        appConfig.routingUserMaxTokensPerWindow,
        snapshot.userRecentTokens,
      )
    }

    if (
      options.userId &&
      options.clientDeviceId &&
      snapshot.clientDeviceRecentTokens >= appConfig.routingDeviceMaxTokensPerWindow
    ) {
      throw new RoutingGuardError(
        'client_device_token_budget_exceeded',
        appConfig.routingDeviceMaxTokensPerWindow,
        snapshot.clientDeviceRecentTokens,
      )
    }
  }

  private upsertStickySession(
    stickySessions: StickySessionBinding[],
    sessionHash: string,
    accountId: string,
    now: number,
    nowIso: string,
  ): StickySessionBinding[] {
    const ttlMs = Math.max(1, Math.floor(appConfig.stickySessionTtlHours * 60 * 60 * 1000))
    const existing = stickySessions.find((binding) => binding.sessionHash === sessionHash)
    const binding: StickySessionBinding = {
      sessionHash,
      accountId,
      primaryAccountId: existing?.primaryAccountId ?? accountId,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      expiresAt: now + ttlMs,
    }

    return stickySessions
      .filter((item) => item.sessionHash !== sessionHash)
      .concat(binding)
  }

  private async markAccountFailure(
    accountId: string,
    error: unknown,
    permanent: boolean,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const nextStatus: StoredAccount['status'] = permanent ? 'revoked' : 'temp_error'

    await this.store.updateData((current) => {
      const data = this.pruneExpiredStickySessions(current)
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const accounts = data.accounts.map((account) => {
        if (account.id !== accountId) {
          return account
        }
        return {
          ...account,
          isActive: permanent ? false : account.isActive,
          status: nextStatus,
          cooldownUntil: permanent ? null : now + appConfig.accountErrorCooldownMs,
          lastFailureAt: nowIso,
          lastError: message.slice(0, 500),
          updatedAt: nowIso,
        }
      })

      return {
        data: {
          ...data,
          accounts,
          stickySessions: data.stickySessions.filter((binding) => binding.accountId !== accountId),
        },
        result: undefined,
      }
    })
  }

  private async requireAccount(accountId: string): Promise<StoredAccount> {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error(`Account not found: ${accountId}`)
    }
    return account
  }

  private isExpired(expiresAt: number | null): boolean {
    if (expiresAt === null) {
      return false
    }
    return Date.now() + EXPIRY_BUFFER_MS >= expiresAt
  }

  private async resolveAccount(
    account: StoredAccount,
    sessionRoute: SessionRoute | null,
    handoffSummary: string | null,
    handoffReason: string | null,
    isCooldownFallback: boolean = false,
  ): Promise<ResolvedAccount> {
    if (providerRequiresProxy(account.provider) && !account.proxyUrl) {
      throw new Error(`Account ${account.label ?? account.id} has no proxy configured — refusing to connect`)
    }

    if (!account.deviceId) {
      const deviceId = crypto.randomBytes(32).toString('hex')
      account = await this.store.updateData((data) => {
        const target = data.accounts.find((a) => a.id === account.id)
        const resolvedDeviceId = target?.deviceId || deviceId
        const accounts = data.accounts.map((a) =>
          a.id === account.id ? { ...a, deviceId: resolvedDeviceId } : a,
        )
        return {
          data: { ...data, accounts },
          result: { ...account, deviceId: resolvedDeviceId },
        }
      })
    }

    const bodyTemplatePath = account.bodyTemplatePath
    const vmFingerprintTemplatePath = account.vmFingerprintTemplatePath ?? appConfig.vmFingerprintTemplatePath

    const proxyUrl = await this.resolveConfiguredProxyUrl(account.proxyUrl)

    return {
      account,
      proxyUrl,
      bodyTemplate: bodyTemplatePath
        ? this.fingerprintCache.getBodyTemplate(bodyTemplatePath)
        : null,
      vmFingerprintHeaders: vmFingerprintTemplatePath
        ? this.fingerprintCache.getVmFingerprintHeaders(vmFingerprintTemplatePath)
        : appConfig.vmFingerprintTemplateHeaders,
      sessionRoute,
      handoffSummary,
      handoffReason,
      isCooldownFallback,
    }
  }

  private isPermanentRefreshFailure(error: unknown): boolean {
    if (!(error instanceof OAuthTokenRequestError) || error.grantType !== 'refresh_token') {
      return false
    }

    if (error.statusCode === 401 || error.statusCode === 403) {
      return true
    }

    if (error.statusCode === 400) {
      return /(invalid_grant|revoked|expired|unauthorized|invalid refresh token)/i.test(
        error.responseBody,
      )
    }

    return false
  }

  private async fetchProfile(
    accessToken: string,
    proxyUrl?: string | null,
  ): Promise<OAuthProfile | null> {
    return this.withOptionalProxyDispatcher(proxyUrl, async (dispatcher) => {
      const url = new URL(appConfig.profileEndpoint, appConfig.anthropicApiBaseUrl)
      const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
        dispatcher,
      }
      const response = await fetch(url, requestInit as RequestInit)
      if (!response.ok) {
        return null
      }
      return (await response.json()) as OAuthProfile
    })
  }

  private async fetchRoles(
    accessToken: string,
    proxyUrl?: string | null,
  ): Promise<OAuthRoles | null> {
    return this.withOptionalProxyDispatcher(proxyUrl, async (dispatcher) => {
      const url = new URL(appConfig.rolesEndpoint, appConfig.anthropicApiBaseUrl)
      const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
        dispatcher,
      }
      const response = await fetch(url, requestInit as RequestInit)
      if (!response.ok) {
        return null
      }
      return (await response.json()) as OAuthRoles
    })
  }

  private deriveAccountLocalId(input: {
    accountUuid: string | null
    emailAddress: string | null
  }): string {
    if (input.accountUuid) {
      return input.accountUuid
    }
    if (input.emailAddress) {
      return `email:${input.emailAddress}`
    }
    return crypto.randomUUID()
  }

  private deriveAccountLabel(input: {
    explicitLabel?: string | null
    existing?: StoredAccount
    profile: OAuthProfile | null
    tokenResponse: OAuthTokenResponse
  }): string | null {
    const explicit = input.explicitLabel?.trim()
    if (explicit) {
      return explicit
    }
    return (
      input.existing?.label ??
      input.profile?.account?.display_name ??
      input.profile?.account?.email ??
      input.tokenResponse.account?.email_address ??
      null
    )
  }

  private deriveOpenAICodexLocalId(claims: ReturnType<typeof parseOpenAICodexTokenClaims>): string {
    return (
      claims.chatgptAccountId ??
      claims.chatgptUserId ??
      (claims.emailAddress ? `email:${claims.emailAddress}` : null) ??
      crypto.randomUUID()
    )
  }

  private findMatchingAccount(
    accounts: StoredAccount[],
    tokenResponse: OAuthTokenResponse,
    profile: OAuthProfile | null,
    options: PersistTokenOptions,
  ): StoredAccount | undefined {
    const explicit = options.existingAccountId
      ? accounts.find((account) => account.id === options.existingAccountId)
      : undefined

    const matches = this.findIdentityMatches(accounts, tokenResponse, profile)
    if (matches.length > 0) {
      return [...matches].sort(compareAccountsForIdentityMerge)[0]
    }

    return explicit
  }

  private findMatchingOpenAICodexAccount(
    accounts: StoredAccount[],
    claims: ReturnType<typeof parseOpenAICodexTokenClaims>,
    options: PersistTokenOptions,
  ): StoredAccount | undefined {
    const providerAccounts = accounts.filter(isOpenAICodexAccount)
    const explicit = options.existingAccountId
      ? providerAccounts.find((account) => account.id === options.existingAccountId)
      : undefined
    if (explicit) {
      return explicit
    }

    if (claims.chatgptAccountId) {
      const matched = providerAccounts.filter(
        (account) => account.organizationUuid === claims.chatgptAccountId,
      )
      if (matched.length > 0) {
        return [...matched].sort(compareAccountsForIdentityMerge)[0]
      }
    }

    if (claims.chatgptUserId) {
      const matched = providerAccounts.filter(
        (account) => account.accountUuid === claims.chatgptUserId,
      )
      if (matched.length > 0) {
        return [...matched].sort(compareAccountsForIdentityMerge)[0]
      }
    }

    if (claims.emailAddress) {
      const matched = providerAccounts.filter(
        (account) => account.emailAddress === claims.emailAddress,
      )
      if (matched.length > 0) {
        return [...matched].sort(compareAccountsForIdentityMerge)[0]
      }
    }

    return undefined
  }

  private findIdentityMatches(
    accounts: StoredAccount[],
    tokenResponse: OAuthTokenResponse,
    profile: OAuthProfile | null,
  ): StoredAccount[] {
    const accountUuid = profile?.account?.uuid ?? tokenResponse.account?.uuid ?? null
    if (accountUuid) {
      const matchedByUuid = accounts.filter((account) => account.accountUuid === accountUuid)
      if (matchedByUuid.length > 0) {
        return matchedByUuid
      }
    }

    const emailAddress =
      profile?.account?.email?.trim().toLowerCase() ??
      tokenResponse.account?.email_address?.trim().toLowerCase() ??
      null
    if (emailAddress) {
      return accounts.filter((account) => account.emailAddress === emailAddress)
    }

    return []
  }

  private buildCookieHeaders(sessionKey: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Cookie: `sessionKey=${sessionKey}`,
      Origin: appConfig.claudeAiOrigin,
      Referer: `${appConfig.claudeAiOrigin}/new`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    }
  }

  private async resolveBestOrganizationUuid(sessionKey: string): Promise<string> {
    const response = await fetch(appConfig.claudeAiOrganizationsUrl, {
      headers: this.buildCookieHeaders(sessionKey),
      signal: AbortSignal.timeout(appConfig.requestTimeoutMs),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to fetch claude.ai organizations: ${response.status} ${body.slice(0, 500)}`)
    }

    const organizations = (await response.json()) as ClaudeAiOrganization[]
    let selected: ClaudeAiOrganization | null = null
    for (const organization of organizations) {
      const capabilities = organization.capabilities ?? []
      if (!capabilities.includes('chat')) {
        continue
      }
      if (!selected || capabilities.length > (selected.capabilities?.length ?? 0)) {
        selected = organization
      }
    }

    if (!selected?.uuid) {
      throw new Error('No organization with chat capability found')
    }

    return selected.uuid
  }

  private async withOptionalProxyDispatcher<T>(
    proxyUrl: string | null | undefined,
    run: (dispatcher?: Dispatcher) => Promise<T>,
  ): Promise<T> {
    const normalizedProxyUrl = normalizeProxyUrl(proxyUrl)
    if (!normalizedProxyUrl) {
      return run(undefined)
    }

    const dispatcher = new ProxyAgent(normalizedProxyUrl)
    try {
      return await run(dispatcher)
    } finally {
      await dispatcher.close().catch(() => {})
    }
  }

  private hashSessionKey(sessionKey: string): string {
    return crypto
      .createHash('sha256')
      .update(`claude-oauth-relay:${sessionKey}`)
      .digest('hex')
  }
}

function compareAccountsForConsistency(left: StoredAccount, right: StoredAccount): number {
  return (
    compareNullableIsoDate(left.createdAt, right.createdAt) ||
    left.id.localeCompare(right.id)
  )
}

function compareAccountsForDisplay(left: StoredAccount, right: StoredAccount): number {
  return (
    Number(right.isActive) - Number(left.isActive) ||
    compareStatus(left.status, right.status) ||
    (left.label ?? left.emailAddress ?? left.id).localeCompare(
      right.label ?? right.emailAddress ?? right.id,
    )
  )
}

function sortAccountsForDisplay(accounts: StoredAccount[]): StoredAccount[] {
  return [...accounts].sort(compareAccountsForDisplay)
}

function compareAccountsForIdentityMerge(left: StoredAccount, right: StoredAccount): number {
  return (
    Number(right.isActive) - Number(left.isActive) ||
    Number(Boolean(right.refreshToken)) - Number(Boolean(left.refreshToken)) ||
    Number(Boolean(right.accessToken)) - Number(Boolean(left.accessToken)) ||
    compareStatus(left.status, right.status) ||
    compareNullableIsoDate(right.lastRefreshAt, left.lastRefreshAt) ||
    compareNullableIsoDate(left.createdAt, right.createdAt) ||
    left.id.localeCompare(right.id)
  )
}

function compareNullableIsoDate(left: string | null, right: string | null): number {
  if (!left && !right) {
    return 0
  }
  if (!left) {
    return -1
  }
  if (!right) {
    return 1
  }
  return left.localeCompare(right)
}

function compareStatus(left: StoredAccount['status'], right: StoredAccount['status']): number {
  const rank: Record<StoredAccount['status'], number> = {
    active: 0,
    temp_error: 1,
    revoked: 2,
  }
  return rank[left] - rank[right]
}

function isHardRateLimitStatus(status: string | null): boolean {
  if (!status) {
    return false
  }
  const normalized = status.toLowerCase()
  return normalized === 'rejected' || normalized === 'throttled' || normalized === 'blocked'
}

function computeRateLimitAutoBlockedUntil(now: number, resetTimestamp: number | null): number {
  const cooldownUntil = now + appConfig.rateLimitAutoBlockCooldownMs
  const resetMs =
    typeof resetTimestamp === 'number' && Number.isFinite(resetTimestamp)
      ? (resetTimestamp < 1_000_000_000_000 ? resetTimestamp * 1000 : resetTimestamp)
      : null
  return Math.max(cooldownUntil, resetMs ?? 0)
}

function resolveRateLimitBlockDeadline(account: StoredAccount): number | null {
  if (typeof account.autoBlockedUntil === 'number' && Number.isFinite(account.autoBlockedUntil)) {
    return account.autoBlockedUntil
  }
  if (typeof account.lastRateLimitReset === 'number' && Number.isFinite(account.lastRateLimitReset)) {
    return account.lastRateLimitReset < 1_000_000_000_000
      ? account.lastRateLimitReset * 1000
      : account.lastRateLimitReset
  }
  if (account.lastRateLimitAt) {
    const lastRateLimitAtMs = Date.parse(account.lastRateLimitAt)
    if (Number.isFinite(lastRateLimitAtMs)) {
      return lastRateLimitAtMs + appConfig.rateLimitAutoBlockCooldownMs
    }
  }
  return 0
}
