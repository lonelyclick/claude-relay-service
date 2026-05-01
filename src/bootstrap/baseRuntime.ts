import { appConfig } from '../config.js'
import { BillingStore } from '../billing/billingStore.js'
import { OAuthService } from '../oauth/service.js'
import { PgTokenStore } from '../oauth/pgTokenStore.js'
import { AccountScheduler } from '../scheduler/accountScheduler.js'
import { AccountHealthTracker } from '../scheduler/healthTracker.js'
import { FingerprintCache } from '../scheduler/fingerprintCache.js'
import { SupportStore } from '../support/supportStore.js'
import { ApiKeyStore } from '../usage/apiKeyStore.js'
import { OrganizationStore } from '../usage/organizationStore.js'
import { UsageStore } from '../usage/usageStore.js'
import { UserStore } from '../usage/userStore.js'

export type BaseRuntime = {
  tokenStore: PgTokenStore
  healthTracker: AccountHealthTracker
  scheduler: AccountScheduler
  fingerprintCache: FingerprintCache
  usageStore: UsageStore
  userStore: UserStore
  organizationStore: OrganizationStore
  apiKeyStore: ApiKeyStore
  billingStore: BillingStore
  supportStore: SupportStore
  oauthService: OAuthService
}

export async function buildBaseRuntime(): Promise<BaseRuntime> {
  if (!appConfig.databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const tokenStore = new PgTokenStore(appConfig.databaseUrl)
  const healthTracker = new AccountHealthTracker({
    windowMs: appConfig.healthWindowMs,
    errorThreshold: appConfig.healthErrorDecayThreshold,
  })
  const scheduler = new AccountScheduler(healthTracker, {
    defaultMaxSessions: appConfig.defaultMaxSessionsPerAccount,
    maxSessionOverflow: appConfig.accountMaxSessionOverflow,
  })
  const fingerprintCache = new FingerprintCache()
  const usageStore = new UsageStore(appConfig.databaseUrl)
  await usageStore.ensureTable()
  const userStore = new UserStore(appConfig.databaseUrl)
  await userStore.ensureTable()
  const organizationStore = new OrganizationStore(appConfig.databaseUrl)
  await organizationStore.ensureTable()
  const apiKeyStore = new ApiKeyStore(appConfig.databaseUrl)
  await apiKeyStore.ensureTable()
  const billingStore = new BillingStore(appConfig.databaseUrl)
  await billingStore.ensureTables()
  await billingStore.syncLineItems()
  const supportStore = new SupportStore(appConfig.databaseUrl)
  await supportStore.ensureTable()

  const rateLimitedUntilMap =
    (await tokenStore.getActiveRateLimitedUntilMap?.(Date.now())) ?? new Map<string, number>()
  for (const [accountId, until] of rateLimitedUntilMap) {
    healthTracker.restoreRateLimitedUntil(accountId, until)
  }

  const oauthService = new OAuthService(tokenStore, scheduler, fingerprintCache, userStore)

  return {
    tokenStore,
    healthTracker,
    scheduler,
    fingerprintCache,
    usageStore,
    userStore,
    organizationStore,
    apiKeyStore,
    billingStore,
    supportStore,
    oauthService,
  }
}

export async function closeBaseRuntime(runtime: BaseRuntime): Promise<void> {
  await Promise.allSettled([
    runtime.tokenStore.close?.() ?? Promise.resolve(),
    runtime.usageStore.close?.() ?? Promise.resolve(),
    runtime.userStore.close?.() ?? Promise.resolve(),
    runtime.organizationStore.close?.() ?? Promise.resolve(),
    runtime.apiKeyStore.close?.() ?? Promise.resolve(),
    runtime.billingStore.close?.() ?? Promise.resolve(),
    runtime.supportStore.close?.() ?? Promise.resolve(),
  ])
}
