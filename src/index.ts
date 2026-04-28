import { createServer as createHttpServer } from 'node:http'

import { appConfig } from './config.js'
import { OAuthService } from './oauth/service.js'
import { KeepAliveRefresher } from './oauth/keepAliveRefresher.js'
import { PgTokenStore } from './oauth/pgTokenStore.js'
import { RelayService } from './proxy/relayService.js'
import { AccountScheduler } from './scheduler/accountScheduler.js'
import { FingerprintCache } from './scheduler/fingerprintCache.js'
import { AccountHealthTracker } from './scheduler/healthTracker.js'
import { ProxyPool } from './scheduler/proxyPool.js'
import { createServer } from './server.js'
import { BillingStore } from './billing/billingStore.js'
import { UsageStore } from './usage/usageStore.js'
import { ApiKeyStore } from './usage/apiKeyStore.js'
import { UserStore } from './usage/userStore.js'

async function listen(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(appConfig.port, appConfig.host)
  })
}

async function main(): Promise<void> {
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
  const proxyPool = new ProxyPool()
  const fingerprintCache = new FingerprintCache()
  const usageStore = new UsageStore(appConfig.databaseUrl)
  await usageStore.ensureTable()
  const userStore = new UserStore(appConfig.databaseUrl)
  await userStore.ensureTable()
  const apiKeyStore = new ApiKeyStore(appConfig.databaseUrl)
  await apiKeyStore.ensureTable()
  const billingStore = new BillingStore(appConfig.databaseUrl)
  await billingStore.ensureTables()
  await billingStore.syncLineItems()

  const rateLimitedUntilMap = await tokenStore.getActiveRateLimitedUntilMap?.(Date.now()) ?? new Map<string, number>()
  for (const [accountId, until] of rateLimitedUntilMap) {
    healthTracker.restoreRateLimitedUntil(accountId, until)
  }

  const oauthService = new OAuthService(tokenStore, scheduler, fingerprintCache, userStore)
  const keepAliveRefresher = new KeepAliveRefresher(oauthService, proxyPool, healthTracker)
  const relayService = new RelayService(
    oauthService,
    proxyPool,
    healthTracker,
    undefined,
    usageStore,
    userStore,
    billingStore,
    apiKeyStore,
  )
  const app = createServer({ oauthService, relayService, usageStore, proxyPool, userStore, billingStore, apiKeyStore })
  const server = createHttpServer(app)

  server.on('upgrade', (req, socket, head) => {
    void relayService.handleUpgrade(req, socket, head)
  })

  await listen(server)
  keepAliveRefresher.start()
  process.stdout.write(
    `Claude OAuth Relay listening on http://${appConfig.host}:${appConfig.port}\n`,
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    process.stdout.write(`[shutdown] signal=${signal} begin\n`)
    keepAliveRefresher.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.allSettled([
      tokenStore.close?.() ?? Promise.resolve(),
      usageStore?.close?.() ?? Promise.resolve(),
      userStore?.close?.() ?? Promise.resolve(),
      billingStore?.close?.() ?? Promise.resolve(),
      proxyPool.close(),
    ])
    process.stdout.write(`[shutdown] signal=${signal} complete\n`)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal).finally(() => {
        process.exit(0)
      })
    })
  }
}

void main().catch((error) => {
  process.stderr.write(
    `[startup] error=${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  )
  process.exit(1)
})
