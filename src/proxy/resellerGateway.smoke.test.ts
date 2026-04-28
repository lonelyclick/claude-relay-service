import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import test from 'node:test'

import {
  resolveBillingLineItem,
  type BillingRule,
} from '../billing/engine.js'
import { MemoryTokenStore, MemoryUserStore } from '../testHelpers/fakes.js'
import type {
  BillingCurrency,
  RelayUser,
  StoredAccount,
} from '../types.js'
import type { UsageRecord } from '../usage/usageStore.js'

const ADMIN_TOKEN = '1234567890abcdef'

type StoredRelayApiKey = {
  id: string
  userId: string
  name: string
  keyPreview: string
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
  apiKey: string
}

type BalanceState = {
  balanceMicros: bigint
  totalCreditedMicros: bigint
  totalDebitedMicros: bigint
  currency: BillingCurrency
}

type BillingLedgerEntry = {
  id: string
  userId: string
  userName: string
  kind: 'topup' | 'manual_adjustment' | 'usage_debit'
  amountMicros: string
  currency: BillingCurrency
  note: string | null
  usageRecordId: number | null
  requestId: string | null
  createdAt: string
  updatedAt: string
}

type BillingLineItem = {
  usageRecordId: number
  requestId: string
  userId: string
  userName: string | null
  accountId: string | null
  provider: string | null
  model: string | null
  target: string
  currency: BillingCurrency
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
}

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

function maskApiKey(apiKey: string): string {
  return apiKey.length <= 14
    ? apiKey
    : `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`
}

function buildStoredAccount(input: {
  id: string
  accessToken: string
  refreshToken: string | null
  createdAt: string
  provider?: StoredAccount['provider']
  protocol?: StoredAccount['protocol']
  authMode?: StoredAccount['authMode']
  apiBaseUrl?: string | null
  modelName?: string | null
  proxyUrl?: string | null
}): StoredAccount {
  return {
    id: input.id,
    provider: input.provider ?? 'claude-official',
    protocol: input.protocol ?? 'claude',
    authMode: input.authMode ?? 'oauth',
    label: input.id,
    isActive: true,
    status: 'active',
    lastSelectedAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    lastFailureAt: null,
    cooldownUntil: null,
    lastError: null,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:inference'],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    subscriptionType: 'max',
    rateLimitTier: null,
    accountUuid: input.id,
    organizationUuid: `org-${input.id}`,
    emailAddress: `${input.id}@example.com`,
    displayName: input.id,
    hasExtraUsageEnabled: null,
    billingType: null,
    accountCreatedAt: null,
    subscriptionCreatedAt: null,
    rawProfile: null,
    roles: null,
    routingGroupId: null,
    group: null,
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
    proxyUrl: input.proxyUrl ?? null,
    bodyTemplatePath: null,
    vmFingerprintTemplatePath: null,
    deviceId: null,
    apiBaseUrl: input.apiBaseUrl ?? null,
    modelName: input.modelName ?? null,
    modelTierMap: null,
    loginPassword: null,
  }
}

test('isolated reseller smoke: compat regenerate-key rotates relay_api_keys through prepaid /v1/chat/completions billing loop', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN
  process.env.ADMIN_UI_SESSION_SECRET = '1234567890abcdef1234567890abcdef'
  process.env.DATABASE_URL = 'postgresql://unused@127.0.0.1:0/unused'
  process.env.HOST = '127.0.0.1'
  process.env.PORT = '3570'
  process.env.RELAY_LOG_ENABLED = 'false'

  const usageRecords: UsageRecord[] = []
  const usageRecordsById = new Map<number, UsageRecord>()
  const resellerUsersById = new Map<string, RelayUser>()
  const resellerApiKeysById = new Map<string, StoredRelayApiKey>()
  const resellerApiKeyIdByValue = new Map<string, string>()
  const resellerBillingRules: BillingRule[] = []
  const resellerBillingBalances = new Map<string, BalanceState>()
  const resellerBillingLedger: BillingLedgerEntry[] = []
  const resellerBillingLineItems = new Map<number, BillingLineItem>()
  const upstreamRequests: Array<{
    path: string
    authorization: string | undefined
    body: string
  }> = []

  let nextUsageRecordId = 1
  let nextUserId = 1
  let nextLegacyKeyId = 1
  let nextRelayApiKeyId = 1
  let nextBillingRuleId = 1
  let nextLedgerEntryId = 1

  class ResellerMemoryUserStore extends MemoryUserStore {
    addUser(user: RelayUser): void {
      const cloned = structuredClone(user)
      resellerUsersById.set(cloned.id, cloned)
      super.addUser(cloned)
    }

    async getUserById(id: string): Promise<RelayUser | null> {
      return structuredClone(resellerUsersById.get(id) ?? null)
    }

    async getUserRelayKeySourceSummary(userId: string, recentWindowLimit = 100): Promise<{
      recentWindowLimit: number
      countedRequests: number
      relayApiKeysCount: number
      legacyFallbackCount: number
    }> {
      const normalizedWindowLimit = Number.isFinite(recentWindowLimit)
        ? Math.min(500, Math.max(1, Math.floor(recentWindowLimit)))
        : 100
      const requests = [...usageRecordsById.entries()]
        .map(([usageRecordId, record]) => ({ usageRecordId, record }))
        .filter(({ record }) => (
          record.userId === userId &&
          (record.attemptKind ?? 'final') === 'final'
        ))
        .sort((left, right) => right.usageRecordId - left.usageRecordId)
        .slice(0, normalizedWindowLimit)
        .map(({ record }) => record)

      return {
        recentWindowLimit: normalizedWindowLimit,
        countedRequests: requests.length,
        relayApiKeysCount: requests.filter((record) => record.relayKeySource === 'relay_api_keys').length,
        legacyFallbackCount: requests.filter((record) => record.relayKeySource === 'relay_users_legacy').length,
      }
    }

    async listUsersWithUsage(): Promise<Array<RelayUser & {
      sessionCount: number
      totalRequests: number
      totalInputTokens: number
      totalOutputTokens: number
      lastActiveAt: string | null
      relayKeySourceSummary: {
        recentWindowLimit: number
        countedRequests: number
        relayApiKeysCount: number
        legacyFallbackCount: number
      }
    }>> {
      return [...resellerUsersById.values()].map((user) => {
        const usageEntries = [...usageRecordsById.entries()]
          .map(([usageRecordId, record]) => ({ usageRecordId, record }))
          .filter(({ record }) => (
            record.userId === user.id &&
            (record.attemptKind ?? 'final') === 'final'
          ))
        const sessionKeys = new Set(
          usageEntries
            .map(({ record }) => record)
            .map((record) => record.sessionKey)
            .filter((sessionKey): sessionKey is string => Boolean(sessionKey)),
        )
        const requests = usageEntries.map(({ record }) => record)
        const relayKeySourceSummary = {
          recentWindowLimit: 100,
          countedRequests: requests.length,
          relayApiKeysCount: requests.filter((record) => record.relayKeySource === 'relay_api_keys').length,
          legacyFallbackCount: requests.filter((record) => record.relayKeySource === 'relay_users_legacy').length,
        }
        const sortedEntries = [...usageEntries].sort((left, right) => right.usageRecordId - left.usageRecordId)

        return {
          ...structuredClone(user),
          sessionCount: sessionKeys.size,
          totalRequests: requests.length,
          totalInputTokens: requests.reduce((sum, record) => sum + record.inputTokens, 0),
          totalOutputTokens: requests.reduce((sum, record) => sum + record.outputTokens, 0),
          lastActiveAt: sortedEntries.length > 0 ? new Date().toISOString() : null,
          relayKeySourceSummary,
        }
      })
    }

    async createUser(
      name: unknown,
      billingCurrency: unknown = 'CNY',
    ): Promise<RelayUser> {
      const nowIso = new Date().toISOString()
      const user: RelayUser = {
        id: `relay-user-${nextUserId++}`,
        apiKey: `rk_test_legacy_${nextLegacyKeyId++}`,
        name: String(name),
        externalUserId: null,
        accountId: null,
        routingMode: 'auto',
        routingGroupId: null,
        preferredGroup: null,
        billingMode: 'postpaid',
        billingCurrency: billingCurrency === 'USD' ? 'USD' : 'CNY',
        balanceMicros: '0',
        isActive: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      this.addUser(user)
      return structuredClone(user)
    }

    async updateUser(
      id: string,
      updates: {
        name?: unknown
        accountId?: unknown
        routingMode?: RelayUser['routingMode']
        routingGroupId?: unknown
        preferredGroup?: unknown
        billingMode?: RelayUser['billingMode']
        billingCurrency?: unknown
        isActive?: boolean
      },
    ): Promise<RelayUser | null> {
      const existing = resellerUsersById.get(id)
      if (!existing) {
        return null
      }
      const nextRoutingGroupId =
        updates.routingGroupId !== undefined
          ? (updates.routingGroupId ? String(updates.routingGroupId) : null)
          : updates.preferredGroup !== undefined
            ? (updates.preferredGroup ? String(updates.preferredGroup) : null)
            : existing.routingGroupId
      const updated: RelayUser = {
        ...existing,
        name: updates.name !== undefined ? String(updates.name) : existing.name,
        accountId:
          updates.accountId !== undefined
            ? (updates.accountId ? String(updates.accountId) : null)
            : existing.accountId,
        routingMode: updates.routingMode ?? existing.routingMode,
        routingGroupId: nextRoutingGroupId,
        preferredGroup: nextRoutingGroupId,
        billingMode: updates.billingMode ?? existing.billingMode,
        billingCurrency:
          updates.billingCurrency === 'USD' || updates.billingCurrency === 'CNY'
            ? updates.billingCurrency
            : existing.billingCurrency,
        isActive: updates.isActive ?? existing.isActive,
        updatedAt: new Date().toISOString(),
      }
      this.addUser(updated)
      return structuredClone(updated)
    }

    async getUserRequests(
      userId: string,
      limit = 50,
      offset = 0,
      relayKeySource: 'relay_api_keys' | 'relay_users_legacy' | null = null,
    ): Promise<{ requests: Array<Record<string, unknown>>; total: number }> {
      const requests = [...usageRecordsById.entries()]
        .map(([usageRecordId, record]) => ({ usageRecordId, record }))
        .filter(({ record }) => (
          record.userId === userId &&
          (record.attemptKind ?? 'final') === 'final' &&
          (!relayKeySource || (record.relayKeySource ?? null) === relayKeySource)
        ))
        .sort((left, right) => right.usageRecordId - left.usageRecordId)

      return {
        requests: requests.slice(offset, offset + limit).map(({ usageRecordId, record }) => ({
          usageRecordId,
          requestId: record.requestId,
          accountId: record.accountId,
          sessionKey: record.sessionKey,
          clientDeviceId: record.clientDeviceId ?? null,
          model: record.model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadInputTokens ?? 0,
          cacheCreationTokens: record.cacheCreationInputTokens ?? 0,
          statusCode: record.statusCode,
          durationMs: record.durationMs,
          target: record.target,
          relayKeySource: record.relayKeySource ?? null,
          createdAt: new Date().toISOString(),
        })),
        total: requests.length,
      }
    }
  }

  const userStore = new ResellerMemoryUserStore()
  const apiKeyStore = {
    async lookupByKey(apiKey: string): Promise<{ keyId: string; userId: string } | null> {
      const keyId = resellerApiKeyIdByValue.get(apiKey)
      const stored = keyId ? resellerApiKeysById.get(keyId) : null
      if (!stored || stored.revokedAt) {
        return null
      }
      return { keyId: stored.id, userId: stored.userId }
    },
    touchLastUsed(keyId: string): void {
      const stored = resellerApiKeysById.get(keyId)
      if (stored && !stored.revokedAt) {
        stored.lastUsedAt = new Date().toISOString()
      }
    },
    async listForUser(userId: string) {
      return [...resellerApiKeysById.values()]
        .filter((item) => item.userId === userId && item.revokedAt === null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(({ apiKey: _apiKey, ...rest }) => structuredClone(rest))
    },
    async create(userId: string, options: { name?: string } = {}) {
      const createdAt = new Date().toISOString()
      const keyIndex = nextRelayApiKeyId++
      const id = `relay-api-key-${keyIndex}`
      const apiKey = `rk_test_hashed_${String(keyIndex).padStart(4, '0')}`
      const record: StoredRelayApiKey = {
        id,
        userId,
        name: options.name?.trim() || `Key ${createdAt.slice(0, 10)}`,
        keyPreview: maskApiKey(apiKey),
        lastUsedAt: null,
        revokedAt: null,
        createdAt,
        apiKey,
      }
      resellerApiKeysById.set(id, record)
      resellerApiKeyIdByValue.set(apiKey, id)
      return structuredClone(record)
    },
    async rotateLatestForUser(userId: string, options: { name?: string } = {}) {
      const activeKeys = [...resellerApiKeysById.values()]
        .filter((item) => item.userId === userId && item.revokedAt === null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      const previousPrimary = activeKeys[0] ?? null
      const previousActiveCount = activeKeys.length
      let revoked: Omit<StoredRelayApiKey, 'apiKey'> | null = null
      if (previousPrimary) {
        previousPrimary.revokedAt = new Date().toISOString()
        revoked = structuredClone({
          id: previousPrimary.id,
          userId: previousPrimary.userId,
          name: previousPrimary.name,
          keyPreview: previousPrimary.keyPreview,
          lastUsedAt: previousPrimary.lastUsedAt,
          revokedAt: previousPrimary.revokedAt,
          createdAt: previousPrimary.createdAt,
        })
      }
      const created = await this.create(userId, options)
      return {
        created,
        revoked,
        previousActiveCount,
      }
    },
    async revoke(userId: string, keyId: string) {
      const stored = resellerApiKeysById.get(keyId)
      if (!stored || stored.userId !== userId || stored.revokedAt) {
        return null
      }
      stored.revokedAt = new Date().toISOString()
      return structuredClone({
        id: stored.id,
        userId: stored.userId,
        name: stored.name,
        keyPreview: stored.keyPreview,
        lastUsedAt: stored.lastUsedAt,
        revokedAt: stored.revokedAt,
        createdAt: stored.createdAt,
      })
    },
  }

  const buildBalanceSummary = (userId: string) => {
    const user = resellerUsersById.get(userId)
    if (!user) {
      return null
    }
    const state = resellerBillingBalances.get(userId) ?? {
      balanceMicros: 0n,
      totalCreditedMicros: 0n,
      totalDebitedMicros: 0n,
      currency: user.billingCurrency,
    }
    resellerBillingBalances.set(userId, state)
    const lastLedgerAt = resellerBillingLedger.find((entry) => entry.userId === userId)?.createdAt ?? null
    return {
      userId,
      userName: user.name,
      billingMode: user.billingMode,
      billingCurrency: user.billingCurrency,
      balanceMicros: state.balanceMicros.toString(),
      totalCreditedMicros: state.totalCreditedMicros.toString(),
      totalDebitedMicros: state.totalDebitedMicros.toString(),
      currency: state.currency,
      lastLedgerAt,
    }
  }

  const billingStore = {
    async assertUserCanConsume(userId: string): Promise<void> {
      const user = resellerUsersById.get(userId)
      if (!user || user.billingMode !== 'prepaid') {
        return
      }
      const balance = buildBalanceSummary(userId)
      if (balance && BigInt(balance.balanceMicros) > 0n) {
        return
      }
      throw new Error(`Prepaid balance exhausted for ${user.name}. Please top up and retry.`)
    },
    async assertUserCurrencyChangeAllowed(userId: string, nextCurrency: BillingCurrency): Promise<void> {
      const current = buildBalanceSummary(userId)
      if (!current || current.billingCurrency === nextCurrency) {
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
      return buildBalanceSummary(userId)
    },
    async createLedgerEntry(input: {
      userId: string
      kind: 'topup' | 'manual_adjustment' | 'usage_debit'
      amountMicros: string
      note?: string | null
    }) {
      const summary = buildBalanceSummary(input.userId)
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
      const entry: BillingLedgerEntry = {
        id: `billing-ledger-${nextLedgerEntryId++}`,
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
        balance: buildBalanceSummary(input.userId),
      }
    },
    async listRules(currency?: BillingCurrency | null) {
      return resellerBillingRules
        .filter((rule) => !currency || rule.currency === currency)
        .map((rule) => structuredClone(rule))
    },
    async createRule(input: {
      name?: string | null
      currency?: BillingCurrency
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
        id: `billing-rule-${nextBillingRuleId++}`,
        name: input.name ?? `rule-${nextBillingRuleId}`,
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
      billingCurrency: BillingCurrency
      accountId: string | null
      provider: string | null
      model: string | null
      target: string
    }) {
      if (resellerBillingRules.length === 0) {
        return { ok: true, status: 'billed' as const, matchedRuleId: null, matchedRuleName: null }
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
      const nowIso = new Date().toISOString()
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
        createdAt: nowIso,
      }, resellerBillingRules)
      const previous = resellerBillingLineItems.get(usageRecordId)
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
          id: `billing-ledger-${nextLedgerEntryId++}`,
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
    async getUserLineItems(userId: string, _since: Date | null, limit = 100, offset = 0) {
      const items = [...resellerBillingLineItems.values()]
        .filter((item) => item.userId === userId)
        .sort((left, right) => right.usageRecordId - left.usageRecordId)
      return {
        items: items.slice(offset, offset + limit).map((item) => structuredClone(item)),
        total: items.length,
      }
    },
    async listUserLedger(userId: string, limit = 100, offset = 0) {
      const items = resellerBillingLedger.filter((entry) => entry.userId === userId)
      return {
        items: items.slice(offset, offset + limit).map((entry) => structuredClone(entry)),
        total: items.length,
      }
    },
  }

  const usageStore = {
    async insertRecord(record: UsageRecord) {
      const usageRecordId = nextUsageRecordId++
      const cloned = structuredClone(record)
      usageRecords.push(cloned)
      usageRecordsById.set(usageRecordId, cloned)
      return usageRecordId
    },
  }

  const upstreamServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/chat/completions') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      upstreamRequests.push({
        path: url.pathname + url.search,
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        body,
      })
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-request-id', 'openai-upstream-reseller-1')
      res.end(JSON.stringify({
        id: 'chatcmpl-reseller-1',
        model: 'gpt-4.1',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: 'reseller hello',
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
        },
      }))
    })
  })

  let relayHttpServer: ReturnType<typeof createHttpServer> | null = null

  try {
    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => resolve())
    })
    const upstreamAddress = upstreamServer.address()
    assert.ok(upstreamAddress && typeof upstreamAddress !== 'string')
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`

    process.env.ANTHROPIC_API_BASE_URL = upstreamBaseUrl
    process.env.OAUTH_TOKEN_URL = `${upstreamBaseUrl}/v1/oauth/token`

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
    const oauthService = new OAuthService(
      tokenStore,
      scheduler,
      fingerprintCache,
      userStore as never,
    )
    await tokenStore.updateData(() => ({
      data: {
        version: 3,
        accounts: [
          buildStoredAccount({
            id: 'openai-compatible:account-1',
            provider: 'openai-compatible',
            protocol: 'openai',
            authMode: 'api_key',
            accessToken: 'openai-api-key',
            refreshToken: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            apiBaseUrl: upstreamBaseUrl,
            modelName: 'gpt-4.1',
            proxyUrl: null,
          }),
        ],
        stickySessions: [],
        proxies: [],
        routingGroups: [],
      },
      result: undefined,
    }))

    const relayService = new RelayService(
      oauthService,
      proxyPool,
      healthTracker,
      undefined,
      usageStore as never,
      userStore as never,
      billingStore as never,
      apiKeyStore as never,
    )
    const app = createServer({
      oauthService,
      relayService,
      userStore: userStore as never,
      apiKeyStore: apiKeyStore as never,
      billingStore: billingStore as never,
      usageStore: usageStore as never,
    })

    relayHttpServer = createHttpServer(app)
    await new Promise<void>((resolve) => {
      relayHttpServer!.listen(0, '127.0.0.1', () => resolve())
    })
    const relayAddress = relayHttpServer.address()
    assert.ok(relayAddress && typeof relayAddress !== 'string')
    const relayBaseUrl = `http://127.0.0.1:${relayAddress.port}`

    const sendRequest = async (input: {
      method: 'GET' | 'POST'
      path: string
      bearerToken: string
      body?: Record<string, unknown>
    }) => {
      const response = await fetch(`${relayBaseUrl}${input.path}`, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${input.bearerToken}`,
          ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
      })
      const text = await response.text()
      return { status: response.status, text }
    }

    const createUserResponse = await sendRequest({
      method: 'POST',
      path: '/admin/users',
      bearerToken: ADMIN_TOKEN,
      body: {
        name: 'reseller-mainline-user',
        billingCurrency: 'CNY',
      },
    })
    assert.equal(createUserResponse.status, 200, createUserResponse.text)
    const createdUser = JSON.parse(createUserResponse.text) as {
      ok: boolean
      user: { id: string; billingMode: string }
      apiKey: string
      apiKeySource: string
      primaryApiKey: { id: string; name: string; apiKey: string } | null
    }
    assert.equal(createdUser.ok, true)
    assert.equal(createdUser.user.billingMode, 'postpaid')
    assert.equal(createdUser.apiKeySource, 'relay_api_keys')
    assert.ok(createdUser.primaryApiKey)
    assert.equal(createdUser.primaryApiKey?.name, 'Default Key')
    assert.equal(createdUser.apiKey, createdUser.primaryApiKey?.apiKey)
    const resellerUserId = createdUser.user.id
    const originalPrimaryApiKey = createdUser.primaryApiKey

    const updateUserResponse = await sendRequest({
      method: 'POST',
      path: `/admin/users/${resellerUserId}/update`,
      bearerToken: ADMIN_TOKEN,
      body: { billingMode: 'prepaid' },
    })
    assert.equal(updateUserResponse.status, 200, updateUserResponse.text)
    const updatedUser = JSON.parse(updateUserResponse.text) as {
      ok: boolean
      user: { billingMode: string }
    }
    assert.equal(updatedUser.ok, true)
    assert.equal(updatedUser.user.billingMode, 'prepaid')

    const initialKeysResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}/api-keys`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(initialKeysResponse.status, 200, initialKeysResponse.text)
    const initialKeys = JSON.parse(initialKeysResponse.text) as {
      apiKeys: Array<{ id: string }>
      max: number
    }
    assert.equal(initialKeys.apiKeys.length, 1)
    assert.equal(initialKeys.max, 100)

    const regenerateKeyResponse = await sendRequest({
      method: 'POST',
      path: `/admin/users/${resellerUserId}/regenerate-key`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(regenerateKeyResponse.status, 200, regenerateKeyResponse.text)
    const regeneratedKey = JSON.parse(regenerateKeyResponse.text) as {
      ok: boolean
      apiKey: string
      apiKeySource: string
      primaryApiKey: { id: string; name: string; keyPreview: string; apiKey: string } | null
      revokedApiKey: { id: string; revokedAt: string | null } | null
      legacyApiKeyRetained: boolean
      rotationMode: string
    }
    assert.equal(regeneratedKey.ok, true)
    assert.equal(regeneratedKey.apiKeySource, 'relay_api_keys')
    assert.ok(regeneratedKey.primaryApiKey)
    assert.equal(regeneratedKey.primaryApiKey?.name, 'Rotated Key')
    assert.equal(regeneratedKey.apiKey, regeneratedKey.primaryApiKey?.apiKey)
    assert.match(regeneratedKey.apiKey, /^rk_/)
    assert.notEqual(regeneratedKey.primaryApiKey?.id, originalPrimaryApiKey?.id)
    assert.equal(regeneratedKey.revokedApiKey?.id, originalPrimaryApiKey?.id)
    assert.ok(regeneratedKey.revokedApiKey?.revokedAt)
    assert.equal(regeneratedKey.legacyApiKeyRetained, true)
    assert.equal(regeneratedKey.rotationMode, 'rotated_latest_active_relay_key')

    const readApiKeyResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}/api-key`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(readApiKeyResponse.status, 200, readApiKeyResponse.text)
    const readApiKey = JSON.parse(readApiKeyResponse.text) as {
      userId: string
      apiKeySource: string
      primaryApiKey: { id: string; keyPreview: string } | null
      activeApiKeyCount: number
      currentApiKeyPlaintextAvailable: boolean
      apiKey: string | null
      apiKeyFieldMode: string
      legacyApiKey: string | null
      legacyApiKeyRetained: boolean
      legacyApiKeyDeprecated: boolean
    }
    assert.equal(readApiKey.userId, resellerUserId)
    assert.equal(readApiKey.apiKeySource, 'relay_api_keys')
    assert.equal(readApiKey.primaryApiKey?.id, regeneratedKey.primaryApiKey?.id)
    assert.equal(readApiKey.primaryApiKey?.keyPreview, regeneratedKey.primaryApiKey?.keyPreview)
    assert.equal(readApiKey.activeApiKeyCount, 1)
    assert.equal(readApiKey.currentApiKeyPlaintextAvailable, false)
    assert.equal(readApiKey.apiKeyFieldMode, 'compatibility_legacy_plaintext')
    assert.equal(readApiKey.legacyApiKeyRetained, true)
    assert.equal(readApiKey.legacyApiKeyDeprecated, true)
    assert.equal(readApiKey.apiKey, readApiKey.legacyApiKey)
    assert.match(String(readApiKey.apiKey), /^rk_test_legacy_/)
    assert.notEqual(readApiKey.apiKey, regeneratedKey.apiKey)

    const listKeysResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}/api-keys`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(listKeysResponse.status, 200, listKeysResponse.text)
    const listedKeys = JSON.parse(listKeysResponse.text) as {
      apiKeys: Array<{ id: string; name: string; keyPreview: string }>
    }
    assert.equal(listedKeys.apiKeys.length, 1)
    assert.equal(listedKeys.apiKeys[0]?.id, regeneratedKey.primaryApiKey?.id)
    assert.equal(listedKeys.apiKeys[0]?.name, 'Rotated Key')
    assert.equal(listedKeys.apiKeys[0]?.keyPreview, regeneratedKey.primaryApiKey?.keyPreview)

    const revokedRelayResponse = await fetch(`${relayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${originalPrimaryApiKey?.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'revoked rotated key should fail' }],
      }),
    })
    const revokedRelayBody = await revokedRelayResponse.text()
    assert.equal(revokedRelayResponse.status, 401, revokedRelayBody)
    const revokedRelayError = JSON.parse(revokedRelayBody) as {
      error?: { message?: string; code?: string }
    }
    assert.equal(revokedRelayError.error?.code, 'COR_RELAY_USER_REJECTED')
    assert.match(String(revokedRelayError.error?.message), /Invalid relay API key/)
    assert.equal(upstreamRequests.length, 0)

    const createRuleResponse = await sendRequest({
      method: 'POST',
      path: '/admin/billing/rules',
      bearerToken: ADMIN_TOKEN,
      body: {
        name: 'gpt-4.1 reseller price',
        currency: 'CNY',
        model: 'gpt-4.1',
        inputPriceMicrosPerMillion: '1000000',
        outputPriceMicrosPerMillion: '2000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      },
    })
    assert.equal(createRuleResponse.status, 200, createRuleResponse.text)

    const topupResponse = await sendRequest({
      method: 'POST',
      path: `/admin/billing/users/${resellerUserId}/ledger`,
      bearerToken: ADMIN_TOKEN,
      body: {
        kind: 'topup',
        amountMicros: '1000000',
        note: 'initial reseller topup',
      },
    })
    assert.equal(topupResponse.status, 200, topupResponse.text)
    const toppedUp = JSON.parse(topupResponse.text) as {
      ok: boolean
      balance: { balanceMicros: string }
    }
    assert.equal(toppedUp.ok, true)
    assert.equal(toppedUp.balance.balanceMicros, '1000000')

    const relayResponse = await fetch(`${relayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${regeneratedKey.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'reseller billed request' }],
      }),
    })
    const relayBody = await relayResponse.text()
    assert.equal(relayResponse.status, 200, relayBody)
    await waitForCondition(() => usageRecords.length === 1 && resellerBillingLineItems.size === 1)

    const legacyRelayResponse = await fetch(`${relayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(readApiKey.apiKey)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'legacy fallback billed request' }],
      }),
    })
    const legacyRelayBody = await legacyRelayResponse.text()
    assert.equal(legacyRelayResponse.status, 200, legacyRelayBody)
    await waitForCondition(() => usageRecords.length === 2 && resellerBillingLineItems.size === 2)

    const revokeApiKeyResponse = await fetch(`${relayBaseUrl}/admin/users/${encodeURIComponent(resellerUserId)}/api-keys/${encodeURIComponent(regeneratedKey.primaryApiKey?.id ?? '')}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    })
    const revokeApiKeyBody = await revokeApiKeyResponse.text()
    assert.equal(revokeApiKeyResponse.status, 200, revokeApiKeyBody)
    const revokedApiKey = JSON.parse(revokeApiKeyBody) as {
      revoked: boolean
      apiKey: { id: string; revokedAt: string | null }
    }
    assert.equal(revokedApiKey.revoked, true)
    assert.equal(revokedApiKey.apiKey.id, regeneratedKey.primaryApiKey?.id)
    assert.ok(revokedApiKey.apiKey.revokedAt)

    const activeKeysAfterRevokeResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}/api-keys`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(activeKeysAfterRevokeResponse.status, 200, activeKeysAfterRevokeResponse.text)
    const activeKeysAfterRevoke = JSON.parse(activeKeysAfterRevokeResponse.text) as {
      apiKeys: Array<{ id: string }>
    }
    assert.equal(activeKeysAfterRevoke.apiKeys.length, 0)

    const revokedRotatedRelayResponse = await fetch(`${relayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${regeneratedKey.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        stream: false,
        messages: [{ role: 'user', content: 'revoked key should fail' }],
      }),
    })
    const revokedRotatedRelayBody = await revokedRotatedRelayResponse.text()
    assert.equal(revokedRotatedRelayResponse.status, 401, revokedRotatedRelayBody)
    const revokedRotatedRelayError = JSON.parse(revokedRotatedRelayBody) as {
      error?: { message?: string; code?: string }
    }
    assert.equal(revokedRotatedRelayError.error?.code, 'COR_RELAY_USER_REJECTED')
    assert.match(String(revokedRotatedRelayError.error?.message), /Invalid relay API key/)
    assert.equal(upstreamRequests.length, 2)

    const usageRequestsResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}/requests`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(usageRequestsResponse.status, 200, usageRequestsResponse.text)
    const usageRequestList = JSON.parse(usageRequestsResponse.text) as {
      total: number
      requests: Array<{
        target: string
        model: string
        inputTokens: number
        outputTokens: number
        relayKeySource: string | null
      }>
    }
    assert.equal(usageRequestList.total, 2)
    assert.deepEqual(
      usageRequestList.requests.map((request) => request.relayKeySource),
      ['relay_users_legacy', 'relay_api_keys'],
    )
    assert.equal(usageRequestList.requests[0]?.target, '/v1/chat/completions')
    assert.equal(usageRequestList.requests[0]?.model, 'gpt-4.1')
    assert.equal(usageRequestList.requests[0]?.inputTokens, 12)
    assert.equal(usageRequestList.requests[0]?.outputTokens, 4)
    assert.equal(usageRequestList.requests[1]?.target, '/v1/chat/completions')
    assert.equal(usageRequestList.requests[1]?.model, 'gpt-4.1')
    assert.equal(usageRequestList.requests[1]?.inputTokens, 12)
    assert.equal(usageRequestList.requests[1]?.outputTokens, 4)

    const legacyOnlyRequestsResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}/requests?relayKeySource=relay_users_legacy`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(legacyOnlyRequestsResponse.status, 200, legacyOnlyRequestsResponse.text)
    const legacyOnlyRequests = JSON.parse(legacyOnlyRequestsResponse.text) as {
      total: number
      requests: Array<{ relayKeySource: string | null }>
    }
    assert.equal(legacyOnlyRequests.total, 1)
    assert.deepEqual(
      legacyOnlyRequests.requests.map((request) => request.relayKeySource),
      ['relay_users_legacy'],
    )

    const primaryOnlyRequestsResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}/requests?relayKeySource=relay_api_keys`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(primaryOnlyRequestsResponse.status, 200, primaryOnlyRequestsResponse.text)
    const primaryOnlyRequests = JSON.parse(primaryOnlyRequestsResponse.text) as {
      total: number
      requests: Array<{ relayKeySource: string | null }>
    }
    assert.equal(primaryOnlyRequests.total, 1)
    assert.deepEqual(
      primaryOnlyRequests.requests.map((request) => request.relayKeySource),
      ['relay_api_keys'],
    )

    const userDetailResponse = await sendRequest({
      method: 'GET',
      path: `/admin/users/${resellerUserId}`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(userDetailResponse.status, 200, userDetailResponse.text)
    const userDetail = JSON.parse(userDetailResponse.text) as {
      user: {
        relayKeySourceSummary?: {
          recentWindowLimit: number
          countedRequests: number
          relayApiKeysCount: number
          legacyFallbackCount: number
        }
      }
    }
    assert.deepEqual(userDetail.user.relayKeySourceSummary, {
      recentWindowLimit: 100,
      countedRequests: 2,
      relayApiKeysCount: 1,
      legacyFallbackCount: 1,
    })

    const usersListResponse = await sendRequest({
      method: 'GET',
      path: '/admin/users',
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(usersListResponse.status, 200, usersListResponse.text)
    const usersList = JSON.parse(usersListResponse.text) as {
      users: Array<{
        id: string
        relayKeySourceSummary?: {
          recentWindowLimit: number
          countedRequests: number
          relayApiKeysCount: number
          legacyFallbackCount: number
        }
      }>
    }
    const listedResellerUser = usersList.users.find((user) => user.id === resellerUserId)
    assert.ok(listedResellerUser)
    assert.deepEqual(listedResellerUser?.relayKeySourceSummary, {
      recentWindowLimit: 100,
      countedRequests: 2,
      relayApiKeysCount: 1,
      legacyFallbackCount: 1,
    })

    const balanceResponse = await sendRequest({
      method: 'GET',
      path: `/admin/billing/users/${resellerUserId}/balance`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(balanceResponse.status, 200, balanceResponse.text)
    const balance = JSON.parse(balanceResponse.text) as {
      totalCreditedMicros: string
      totalDebitedMicros: string
      balanceMicros: string
      currency: string
    }
    assert.equal(balance.totalCreditedMicros, '1000000')
    assert.equal(balance.totalDebitedMicros, '40')
    assert.equal(balance.balanceMicros, '999960')
    assert.equal(balance.currency, 'CNY')

    const billingItemsResponse = await sendRequest({
      method: 'GET',
      path: `/admin/billing/users/${resellerUserId}/items`,
      bearerToken: ADMIN_TOKEN,
    })
    assert.equal(billingItemsResponse.status, 200, billingItemsResponse.text)
    const billingItems = JSON.parse(billingItemsResponse.text) as {
      total: number
      items: Array<{
        status: string
        amountMicros: string
        target: string
        model: string
      }>
    }
    assert.equal(billingItems.total, 2)
    assert.equal(billingItems.items[0]?.status, 'billed')
    assert.equal(billingItems.items[0]?.amountMicros, '20')
    assert.equal(billingItems.items[0]?.target, '/v1/chat/completions')
    assert.equal(billingItems.items[0]?.model, 'gpt-4.1')
    assert.equal(billingItems.items[1]?.status, 'billed')
    assert.equal(billingItems.items[1]?.amountMicros, '20')
    assert.equal(billingItems.items[1]?.target, '/v1/chat/completions')
    assert.equal(billingItems.items[1]?.model, 'gpt-4.1')

    assert.equal(upstreamRequests.length, 2)
    assert.equal(upstreamRequests[0]?.path, '/chat/completions')
    assert.equal(upstreamRequests[0]?.authorization, 'Bearer openai-api-key')
  } finally {
    relayHttpServer?.closeAllConnections()
    upstreamServer.closeAllConnections()
    await Promise.all([
      relayHttpServer
        ? new Promise<void>((resolve) => relayHttpServer!.close(() => resolve()))
        : Promise.resolve(),
      new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
    ])
  }
})
