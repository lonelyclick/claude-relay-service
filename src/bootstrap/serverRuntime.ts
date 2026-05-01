import { appConfig } from '../config.js'
import { ConnectionTracker } from '../runtime/connectionTracker.js'
import { RuntimeState } from '../runtime/instanceState.js'
import { buildBaseRuntime, closeBaseRuntime, type BaseRuntime } from './baseRuntime.js'

export type ServerRuntime = BaseRuntime & {
  serviceMode: 'server'
  runtimeState: RuntimeState
  connectionTracker: ConnectionTracker
  proxyPool: null
  geminiLoopback: null
}

export async function buildServerRuntime(): Promise<ServerRuntime> {
  if (!appConfig.relayControlUrl) {
    throw new Error(
      '[serverRuntime] RELAY_CONTROL_URL is required for the server (control plane) process',
    )
  }
  if (!appConfig.internalToken) {
    throw new Error(
      '[serverRuntime] INTERNAL_TOKEN is required for the server (control plane) process',
    )
  }

  const baseRuntime = await buildBaseRuntime()

  return {
    ...baseRuntime,
    serviceMode: 'server',
    runtimeState: new RuntimeState('server', 0),
    connectionTracker: new ConnectionTracker(),
    proxyPool: null,
    geminiLoopback: null,
  }
}

export async function closeServerRuntime(runtime: ServerRuntime): Promise<void> {
  await closeBaseRuntime(runtime)
}
