import { createServer } from '../server.js'
import type { RelayRuntime } from '../bootstrap/relayRuntime.js'

export function createRelayApp(runtime: RelayRuntime) {
  return createServer({
    serviceMode: 'relay',
    oauthService: runtime.oauthService,
    relayService: runtime.relayService,
    usageStore: runtime.usageStore,
    proxyPool: runtime.proxyPool,
    userStore: runtime.userStore,
    organizationStore: runtime.organizationStore,
    billingStore: runtime.billingStore,
    apiKeyStore: runtime.apiKeyStore,
    supportStore: runtime.supportStore,
    accountLifecycleStore: runtime.accountLifecycleStore,
    accountRiskStore: runtime.accountRiskStore,
    accountRiskService: runtime.accountRiskService,
    geminiLoopback: runtime.geminiLoopback,
    runtimeState: runtime.runtimeState,
    connectionTracker: runtime.connectionTracker,
  })
}
