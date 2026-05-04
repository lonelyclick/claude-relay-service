import { appConfig } from '../config.js'
import { BillingStore } from '../billing/billingStore.js'
import { MailerSendLogStore } from '../mailer/sendLogStore.js'
import { MailerService } from '../mailer/mailerService.js'
import { RecipientResolver } from '../mailer/recipientResolver.js'
import { OAuthService } from '../oauth/service.js'
import { PgTokenStore } from '../oauth/pgTokenStore.js'
import { AccountScheduler } from '../scheduler/accountScheduler.js'
import { AccountHealthTracker } from '../scheduler/healthTracker.js'
import { BalanceAlertScheduler, createBalanceAlertScheduler } from '../scheduler/balanceAlertScheduler.js'
import type pg from 'pg'
import { FingerprintCache } from '../scheduler/fingerprintCache.js'
import { SupportStore } from '../support/supportStore.js'
import { AccountLifecycleStore } from '../usage/accountLifecycleStore.js'
import { AccountRiskStore } from '../usage/accountRiskStore.js'
import { AccountRiskService } from '../usage/accountRiskService.js'
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
  accountLifecycleStore: AccountLifecycleStore
  accountRiskStore: AccountRiskStore
  accountRiskService: AccountRiskService
  mailerSendLogStore: MailerSendLogStore
  mailerService: MailerService
  recipientResolver: RecipientResolver
  balanceAlertScheduler: BalanceAlertScheduler
  /** Pool owned by the balance-alert scheduler; closed during shutdown. */
  balanceAlertPool: pg.Pool
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

  const mailerSendLogStore = new MailerSendLogStore(appConfig.databaseUrl)
  await mailerSendLogStore.ensureTable()
  const recipientResolver = new RecipientResolver(appConfig.betterAuthDatabaseUrl)
  const mailerService = new MailerService({ sendLog: mailerSendLogStore })
  const { scheduler: balanceAlertScheduler, pool: balanceAlertPool } = createBalanceAlertScheduler({
    databaseUrl: appConfig.databaseUrl,
    mailer: mailerService,
    resolver: recipientResolver,
  })

  const rateLimitedUntilMap =
    (await tokenStore.getActiveRateLimitedUntilMap?.(Date.now())) ?? new Map<string, number>()
  for (const [accountId, until] of rateLimitedUntilMap) {
    healthTracker.restoreRateLimitedUntil(accountId, until)
  }

  const accountLifecycleStore = new AccountLifecycleStore(appConfig.databaseUrl)
  await accountLifecycleStore.ensureTable()
  const accountRiskStore = new AccountRiskStore(appConfig.databaseUrl)
  await accountRiskStore.ensureTable()
  const accountRiskService = new AccountRiskService(appConfig.databaseUrl, accountRiskStore)

  const oauthService = new OAuthService(tokenStore, scheduler, fingerprintCache, userStore)
  oauthService.setLifecycleStore(accountLifecycleStore)

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
    accountLifecycleStore,
    accountRiskStore,
    accountRiskService,
    mailerSendLogStore,
    mailerService,
    recipientResolver,
    balanceAlertScheduler,
    balanceAlertPool,
  }
}

export async function closeBaseRuntime(runtime: BaseRuntime): Promise<void> {
  runtime.balanceAlertScheduler.stop()
  await Promise.allSettled([
    runtime.tokenStore.close?.() ?? Promise.resolve(),
    runtime.usageStore.close?.() ?? Promise.resolve(),
    runtime.userStore.close?.() ?? Promise.resolve(),
    runtime.organizationStore.close?.() ?? Promise.resolve(),
    runtime.apiKeyStore.close?.() ?? Promise.resolve(),
    runtime.billingStore.close?.() ?? Promise.resolve(),
    runtime.supportStore.close?.() ?? Promise.resolve(),
    runtime.accountRiskStore.close?.() ?? Promise.resolve(),
    runtime.accountRiskService.close?.() ?? Promise.resolve(),
    runtime.recipientResolver.close(),
    runtime.balanceAlertPool.end(),
  ])
}
