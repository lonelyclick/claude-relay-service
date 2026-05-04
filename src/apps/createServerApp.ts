import { createServer } from '../server.js'
import type { ServerRuntime } from '../bootstrap/serverRuntime.js'

export function createServerApp(runtime: ServerRuntime) {
  return createServer({
    serviceMode: 'server',
    oauthService: runtime.oauthService,
    usageStore: runtime.usageStore,
    proxyPool: null,
    userStore: runtime.userStore,
    organizationStore: runtime.organizationStore,
    billingStore: runtime.billingStore,
    apiKeyStore: runtime.apiKeyStore,
    supportStore: runtime.supportStore,
    accountLifecycleStore: runtime.accountLifecycleStore,
    accountRiskStore: runtime.accountRiskStore,
    accountRiskService: runtime.accountRiskService,
    geminiLoopback: null,
    runtimeState: runtime.runtimeState,
    connectionTracker: runtime.connectionTracker,
    mailerService: runtime.mailerService,
    balanceAlertScheduler: runtime.balanceAlertScheduler,
  })
}
