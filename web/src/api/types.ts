export type BillingCurrency = 'USD' | 'CNY'

export interface Account {
  id: string
  emailAddress: string
  displayName?: string
  label?: string
  provider: string
  protocol: string
  authMode: string
  hasAccessToken: boolean
  hasRefreshToken: boolean
  isActive: boolean
  status?: string
  autoBlockedReason?: string
  autoBlockedUntil?: number | null
  subscriptionType?: string | null
  providerPlanTypeRaw?: string | null
  rateLimitTier?: string | null
  billingType?: string | null
  organizationUuid?: string | null
  lastRateLimitStatus?: string | null
  lastRateLimit5hUtilization?: number | null
  lastRateLimit7dUtilization?: number | null
  lastRateLimitAt?: string | null
  lastRateLimitReset?: number | null
  lastProbeAttemptAt?: number | null
  proxyUrl?: string
  modelName?: string
  modelTierMap?: {
    opus?: string | null
    sonnet?: string | null
    haiku?: string | null
  } | null
  apiBaseUrl?: string
  loginPassword?: string
  lastError?: string
  routingGroupId?: string
  maxSessions?: number | null
  weight?: number | null
  planType?: string | null
  planMultiplier?: number | null
  schedulerState?: string
  healthScore?: number
}

export interface RoutingGroup {
  id: string
  name: string
  description?: string
  isActive: boolean
  createdAt?: string
}

export interface User {
  id: string
  name: string
  isActive: boolean
  apiKeyPreview?: string
  routingMode?: string
  accountId?: string
  routingGroupId?: string
  billingMode?: 'postpaid' | 'prepaid'
  billingCurrency?: BillingCurrency
  balanceMicros?: string
  sessionCount?: number
  totalRequests?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  relayKeySourceSummary?: RelayKeySourceSummary
}

export interface RelayApiKey {
  id: string
  userId: string
  name: string
  keyPreview: string
  lastUsedAt?: string | null
  revokedAt?: string | null
  createdAt: string
}

export interface CreatedRelayApiKey extends RelayApiKey {
  apiKey: string
}

export interface UserApiKeyRead {
  userId: string
  apiKeySource: 'relay_api_keys' | 'relay_users_legacy'
  primaryApiKey: RelayApiKey | null
  activeApiKeyCount: number
  currentApiKeyPlaintextAvailable: boolean
  apiKey: string | null
  apiKeyFieldMode: 'compatibility_legacy_plaintext' | 'legacy_primary_plaintext' | 'absent'
  legacyApiKey: string | null
  legacyApiKeySource: 'relay_users_legacy' | null
  legacyApiKeyRetained: boolean
  legacyApiKeyDeprecated: boolean
}

export interface UserSession {
  sessionKey: string
  clientDeviceId?: string | null
  accountId?: string | null
  firstSeenAt: string
  lastActiveAt: string
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
}

export type RelayKeySource = 'relay_api_keys' | 'relay_users_legacy'

export interface RelayKeySourceSummary {
  recentWindowLimit: number
  countedRequests: number
  relayApiKeysCount: number
  legacyFallbackCount: number
}

export interface UserRequest {
  usageRecordId?: number
  requestId: string
  sessionKey?: string
  clientDeviceId?: string | null
  accountId?: string | null
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  statusCode?: number
  durationMs?: number
  target?: string
  relayKeySource?: RelayKeySource | null
  createdAt: string
}

export interface RequestDetail extends UserRequest {
  usageRecordId?: number
  requestHeaders?: unknown
  requestBodyPreview?: string | null
  responseHeaders?: unknown
  responseBodyPreview?: string | null
  upstreamRequestHeaders?: unknown
}

export interface Proxy {
  id: string
  label: string
  url: string
  localUrl?: string
  accounts?: { id: string; emailAddress: string; label?: string }[]
  createdAt?: string | number
}

export interface ProxyDiagnostics {
  proxyId?: string
  status: 'healthy' | 'degraded' | 'error' | 'unsupported'
  latencyMs: number | null
  httpStatus: number | null
  egressIp: string | null
  egressFamily: 'ipv4' | 'ipv6' | 'unknown' | null
  ipLookupStatus: number | null
  via: 'localUrl' | 'url' | null
  checkedAt: string
  error: string | null
}

export interface RateLimitProbe {
  kind?: string
  status?: string
  representativeClaim?: string
  requestLimit?: number
  requestRemaining?: number
  requestUtilization?: number
  requestReset?: string
  tokenLimit?: number
  tokenRemaining?: number
  tokenUtilization?: number
  tokenReset?: string
  reset?: string
  fiveHourStatus?: string
  fiveHourUtilization?: number
  fiveHourReset?: string
  sevenDayStatus?: string
  sevenDayUtilization?: number
  sevenDayReset?: string
  sevenDaySurpassedThreshold?: boolean
  overageStatus?: string
  overageDisabledReason?: string
  overageReset?: string
  fallbackPercentage?: number
  httpStatus?: number
  tokenStatus?: string
  refreshAttempted?: boolean
  refreshSucceeded?: boolean
  refreshError?: string
  probedAt?: string
  [key: string]: unknown
}

export interface UsageSummary {
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  uniqueAccounts?: number
  uniqueModels?: number
  period?: { from: string; to: string }
}

export interface UsageAccount {
  accountId: string
  emailAddress?: string
  label?: string
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  lastUsedAt?: string
}

export interface UsageAccountDetail {
  accountId: string
  emailAddress?: string
  label?: string
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  byModel?: {
    model: string
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens?: number
    totalCacheCreationTokens?: number
  }[]
  rateLimits?: {
    latestStatus?: string | null
    latest5hUtilization?: number | null
    latest7dUtilization?: number | null
  }
}

export interface UsageTrendDay {
  date: string
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens?: number
  totalCacheReadTokens?: number
}

export interface BillingSummary {
  currency: BillingCurrency
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalAmountMicros: string
  uniqueUsers: number
  activeRules: number
  period: { from: string; to: string }
}

export interface BillingUser {
  userId: string
  userName?: string | null
  currency: BillingCurrency
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalAmountMicros: string
  lastActiveAt?: string | null
}

export interface BillingUserPeriod {
  periodStart: string
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalAmountMicros: string
}

export interface BillingUserModel {
  model: string
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalAmountMicros: string
}

export interface BillingUserDetail extends BillingUser {
  byPeriod: BillingUserPeriod[]
  byModel: BillingUserModel[]
}

export interface BillingLineItem {
  usageRecordId: number
  requestId: string
  currency: BillingCurrency
  status: 'billed' | 'missing_rule' | 'invalid_usage'
  matchedRuleId?: string | null
  matchedRuleName?: string | null
  accountId?: string | null
  provider?: string | null
  model?: string | null
  target: string
  sessionKey?: string | null
  clientDeviceId?: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  amountMicros: string
  usageCreatedAt: string
}

export interface BillingRule {
  id: string
  name: string
  isActive: boolean
  priority: number
  currency: BillingCurrency
  provider?: string | null
  accountId?: string | null
  userId?: string | null
  model?: string | null
  effectiveFrom: string
  effectiveTo?: string | null
  inputPriceMicrosPerMillion: string
  outputPriceMicrosPerMillion: string
  cacheCreationPriceMicrosPerMillion: string
  cacheReadPriceMicrosPerMillion: string
  createdAt: string
  updatedAt: string
}

export interface BillingSyncResult {
  processedRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
}

export interface BillingBalanceSummary {
  userId: string
  userName?: string | null
  billingMode: 'postpaid' | 'prepaid'
  billingCurrency: BillingCurrency
  balanceMicros: string
  totalCreditedMicros: string
  totalDebitedMicros: string
  currency: BillingCurrency
  lastLedgerAt?: string | null
}

export interface BillingLedgerEntry {
  id: string
  userId: string
  userName?: string | null
  kind: 'topup' | 'manual_adjustment' | 'usage_debit'
  amountMicros: string
  currency: BillingCurrency
  note?: string | null
  usageRecordId?: number | null
  requestId?: string | null
  createdAt: string
  updatedAt: string
}

export interface SchedulerStats {
  global: {
    activeAccounts: number
    totalActiveSessions: number
    totalCapacity: number
    utilizationPercent: number
  }
  accounts: {
    accountId: string
    emailAddress?: string | null
    label?: string | null
    group?: string | null
    provider?: string
    subscriptionType?: string | null
    activeSessions: number
    maxSessions: number
    isSelectable: boolean
    status: string
    schedulerState?: string
    blockedReason?: string | null
    quotaScore?: number
    healthScore: number
    totalScore?: number
  }[]
  groups: Record<string, { totalActiveSessions: number; totalCapacity: number }>
  routingGuard?: {
    users: RoutingGuardEntry[]
    devices: RoutingGuardEntry[]
  }
  sessionRoutes: SessionRoute[]
  recentHandoffs: Handoff[]
}

export interface RoutingGuardEntry {
  id: string
  label?: string
  level: 'critical' | 'warning'
  requestRate?: number
  tokenRate?: number
  recentRequests?: unknown[]
}

export interface SessionRoute {
  userId?: string
  userName?: string
  clientDeviceId?: string
  sessionKey: string
  accountId: string
  accountEmail?: string
  since?: string
  lastActivity?: string
}

export interface Handoff {
  timestamp: string
  userId?: string
  userName?: string
  clientDeviceId?: string
  fromAccountId?: string
  fromAccountEmail?: string
  toAccountId?: string
  toAccountEmail?: string
  reason?: string
}

export interface HealthCheck {
  ok: boolean
  accountCount: number
  activeAccountCount: number
  nextAccountId?: string
  nextAccountEmail?: string
}

export interface AdminSessionResponse {
  csrfToken: string
  user?: { name?: string; email?: string }
}
