import { appConfig } from '../config.js'
import { GeminiLoopbackController } from '../oauth/geminiLoopback.js'
import { KeepAliveRefresher } from '../oauth/keepAliveRefresher.js'
import { RelayService } from '../proxy/relayService.js'
import { ConnectionTracker } from '../runtime/connectionTracker.js'
import { RuntimeState } from '../runtime/instanceState.js'
import { AccountWarmupTaskScheduler } from '../scheduler/accountWarmupTaskScheduler.js'
import { ProxyPool } from '../scheduler/proxyPool.js'
import { buildBaseRuntime, closeBaseRuntime, type BaseRuntime } from './baseRuntime.js'

export type RelayRuntime = BaseRuntime & {
  serviceMode: 'relay'
  runtimeState: RuntimeState
  connectionTracker: ConnectionTracker
  proxyPool: ProxyPool
  geminiLoopback: GeminiLoopbackController
  keepAliveRefresher: KeepAliveRefresher
  accountWarmupTaskScheduler: AccountWarmupTaskScheduler
  relayService: RelayService
}

export async function buildRelayRuntime(): Promise<RelayRuntime> {
  const baseRuntime = await buildBaseRuntime()
  const runtimeState = new RuntimeState('relay', appConfig.drainDetachGraceMs)
  const connectionTracker = new ConnectionTracker()
  const proxyPool = new ProxyPool()
  const geminiLoopback = new GeminiLoopbackController(baseRuntime.oauthService)
  const keepAliveRefresher = new KeepAliveRefresher(
    baseRuntime.oauthService,
    proxyPool,
    baseRuntime.healthTracker,
  )
  const accountWarmupTaskScheduler = new AccountWarmupTaskScheduler(
    baseRuntime.oauthService,
    proxyPool,
    baseRuntime.accountLifecycleStore,
  )
  const relayService = new RelayService(
    baseRuntime.oauthService,
    proxyPool,
    baseRuntime.healthTracker,
    undefined,
    baseRuntime.usageStore,
    baseRuntime.userStore,
    baseRuntime.organizationStore,
    baseRuntime.billingStore,
    baseRuntime.apiKeyStore,
    connectionTracker,
    baseRuntime.accountLifecycleStore,
  )

  return {
    ...baseRuntime,
    serviceMode: 'relay',
    runtimeState,
    connectionTracker,
    proxyPool,
    geminiLoopback,
    keepAliveRefresher,
    accountWarmupTaskScheduler,
    relayService,
  }
}

export async function closeRelayRuntime(runtime: RelayRuntime): Promise<void> {
  runtime.keepAliveRefresher.stop()
  runtime.accountWarmupTaskScheduler.stop()
  await Promise.allSettled([
    runtime.proxyPool.close(),
    runtime.geminiLoopback.stop(),
  ])
  await closeBaseRuntime(runtime)
}
