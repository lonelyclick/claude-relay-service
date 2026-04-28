export type ProtocolKind = 'claude' | 'openai'
export type AuthMode = 'oauth' | 'api_key' | 'passthrough'
export type AccountProvider =
  | 'claude-official'
  | 'openai-codex'
  | 'openai-compatible'
  | 'claude-compatible'
  | 'google-gemini-oauth'
export type SubscriptionType =
  | 'free'
  | 'go'
  | 'plus'
  | 'max'
  | 'max100'
  | 'max200'
  | 'pro'
  | 'pro100'
  | 'pro200'
  | 'team'
  | 'business'
  | 'enterprise'
  | 'edu'
  | 'gemini-free'
  | 'gemini-standard'
  | 'gemini-pro'
  | null
export type StoredAccountStatus = 'active' | 'temp_error' | 'revoked'
export type ClaudeModelTier = 'opus' | 'sonnet' | 'haiku'
export interface ClaudeCompatibleTierMap {
  opus: string | null
  sonnet: string | null
  haiku: string | null
}
export type SchedulerState = 'enabled' | 'paused' | 'draining' | 'auto_blocked'
export type RelayUserRoutingMode = 'auto' | 'pinned_account' | 'preferred_group'
export type RelayUserBillingMode = 'postpaid' | 'prepaid'
export type BillingCurrency = 'USD' | 'CNY'
export type RelayKeySource = 'relay_api_keys' | 'relay_users_legacy'

export interface RoutingGroup {
  id: string
  name: string
  description: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface OAuthProfile {
  account?: {
    uuid?: string
    email?: string
    display_name?: string
    created_at?: string
  }
  organization?: {
    uuid?: string
    organization_type?: string
    rate_limit_tier?: string | null
    has_extra_usage_enabled?: boolean | null
    billing_type?: string | null
    subscription_created_at?: string
  }
}

export interface OAuthRoles {
  organization_role?: string | null
  workspace_role?: string | null
  organization_name?: string | null
}

export interface StoredAccount {
  id: string
  provider: AccountProvider
  protocol: ProtocolKind
  authMode: AuthMode
  label: string | null
  isActive: boolean
  status: StoredAccountStatus
  lastSelectedAt: string | null
  lastUsedAt: string | null
  lastRefreshAt: string | null
  lastFailureAt: string | null
  cooldownUntil: number | null
  lastError: string | null
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  createdAt: string
  updatedAt: string
  subscriptionType: SubscriptionType
  providerPlanTypeRaw?: string | null
  rateLimitTier: string | null
  accountUuid: string | null
  organizationUuid: string | null
  emailAddress: string | null
  displayName: string | null
  hasExtraUsageEnabled: boolean | null
  billingType: string | null
  accountCreatedAt: string | null
  subscriptionCreatedAt: string | null
  rawProfile: OAuthProfile | null
  roles: OAuthRoles | null

  // ── Scheduling ──
  routingGroupId: string | null
  group: string | null
  maxSessions: number | null
  weight: number | null
  planType?: string | null
  planMultiplier?: number | null
  schedulerEnabled: boolean
  schedulerState: SchedulerState
  autoBlockedReason: string | null
  autoBlockedUntil: number | null
  lastRateLimitStatus: string | null
  lastRateLimit5hUtilization: number | null
  lastRateLimit7dUtilization: number | null
  lastRateLimitReset: number | null
  lastRateLimitAt: string | null
  lastProbeAttemptAt: number | null

  // ── Per-account isolation ──
  proxyUrl: string | null
  bodyTemplatePath: string | null
  vmFingerprintTemplatePath: string | null
  deviceId: string | null
  apiBaseUrl: string | null
  modelName: string | null
  modelTierMap: ClaudeCompatibleTierMap | null

  // ── Credential info (display only) ──
  loginPassword: string | null
}

export interface StickySessionBinding {
  sessionHash: string
  accountId: string
  primaryAccountId: string
  createdAt: string
  updatedAt: string
  expiresAt: number
}

export interface ProxyEntry {
  id: string
  label: string
  url: string
  localUrl: string | null
  createdAt: number
}

export interface TokenStoreData {
  version: 2 | 3
  accounts: StoredAccount[]
  stickySessions: StickySessionBinding[]
  proxies: ProxyEntry[]
  routingGroups: RoutingGroup[]
}

export interface ITokenStore {
  getData(): Promise<TokenStoreData>
  getAccounts?(): Promise<StoredAccount[]>
  getRoutingGroups?(): Promise<RoutingGroup[]>
  updateData<T>(
    updater: (
      data: TokenStoreData,
    ) => Promise<{ data: TokenStoreData; result: T }> | { data: TokenStoreData; result: T },
  ): Promise<T>
  updateAccount?(
    accountId: string,
    updater: (account: StoredAccount) => StoredAccount,
  ): Promise<StoredAccount | null>
  updateAccountRateLimitedUntil?(accountId: string, until: number): Promise<void>
  getActiveRateLimitedUntilMap?(now: number): Promise<Map<string, number>>
  updateAccountLastProbeAttemptAt?(accountId: string, at: number): Promise<void>
  clear(): Promise<void>
  close?(): Promise<void>
}

export interface OAuthSession {
  sessionId: string
  provider: AccountProvider
  codeVerifier: string
  state: string
  expiresAt: number
  expiresIn: number | undefined
}

export interface OAuthTokenResponse {
  access_token: string
  id_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  account?: {
    uuid?: string
    email_address?: string
  }
  organization?: {
    uuid?: string
  }
}

// ── Scheduler types ──

import type { BodyTemplate } from './proxy/bodyRewriter.js'
import type { VmFingerprintTemplateHeader } from './proxy/fingerprintTemplate.js'

export interface ResolvedAccount {
  account: StoredAccount
  proxyUrl: string | null
  bodyTemplate: BodyTemplate | null
  vmFingerprintHeaders: VmFingerprintTemplateHeader[]
  sessionRoute: SessionRoute | null
  handoffSummary: string | null
  handoffReason: string | null
  isCooldownFallback: boolean
}

// ── Relay User (API key based) ──

export interface RelayUser {
  id: string
  apiKey: string | null
  name: string
  externalUserId?: string | null
  accountId: string | null
  routingMode: RelayUserRoutingMode
  routingGroupId: string | null
  preferredGroup: string | null
  billingMode: RelayUserBillingMode
  billingCurrency: BillingCurrency
  balanceMicros: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface SessionRoute {
  sessionKey: string
  sessionHash: string
  userId: string | null
  clientDeviceId: string | null
  accountId: string
  primaryAccountId: string
  generation: number
  upstreamSessionId: string
  pendingHandoffSummary: string | null
  lastHandoffReason: string | null
  generationBurn5h: number
  generationBurn7d: number
  predictedBurn5h: number | null
  predictedBurn7d: number | null
  lastRateLimitStatus: string | null
  lastRateLimit5hUtilization: number | null
  lastRateLimit7dUtilization: number | null
  lastSoftMigrationAt: number | null
  createdAt: string
  updatedAt: string
  expiresAt: number
}

export interface SessionHandoff {
  id: string
  sessionKey: string
  sessionHash: string
  generation: number
  fromAccountId: string | null
  toAccountId: string
  reason: string
  summary: string
  createdAt: string
}

export interface SchedulerAccountStats {
  accountId: string
  emailAddress: string | null
  subscriptionType: SubscriptionType
  group: string | null
  label: string | null
  activeSessions: number
  maxSessions: number
  healthScore: number
  effectiveWeight: number
  rateLimitedUntil: number | null
  cooldownUntil: number | null
  status: StoredAccountStatus
  isSelectable: boolean
  schedulerEnabled: boolean
  schedulerState: SchedulerState
  autoBlockedReason: string | null
  latestRateLimitStatus: string | null
  latestRateLimit5hUtilization: number | null
  latestRateLimit7dUtilization: number | null
  quotaScore: number
  sessionAffinityScore: number
  capacityScore: number
  proxyScore: number
  manualWeightScore: number
  totalScore: number
  blockedReason: string | null
}
