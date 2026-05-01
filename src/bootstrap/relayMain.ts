import { createServer as createHttpServer } from 'node:http'

import { appConfig } from '../config.js'
import { createRelayApp } from '../apps/createRelayApp.js'
import {
  drainHttpServer,
  listen,
  rejectRelayUpgradeWhileDraining,
  trackServerSockets,
} from './httpServer.js'
import { buildRelayRuntime, closeRelayRuntime } from './relayRuntime.js'

export async function main(): Promise<void> {
  const runtime = await buildRelayRuntime()
  const app = createRelayApp(runtime)
  const server = createHttpServer(app)
  const sockets = trackServerSockets(server)

  server.on('upgrade', (req, socket, head) => {
    if (!runtime.runtimeState.acceptsNewRelayTraffic()) {
      rejectRelayUpgradeWhileDraining(socket)
      return
    }
    void runtime.relayService.handleUpgrade(req, socket, head)
  })

  await listen(server, appConfig.port, appConfig.host)
  runtime.runtimeState.markReady()
  runtime.keepAliveRefresher.start()
  process.stdout.write(
    `Claude OAuth Relay (relay) listening on http://${appConfig.host}:${appConfig.port}\n`,
  )

  let shuttingDown = false
  let signalCount = 0
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    process.stdout.write(`[shutdown] signal=${signal} begin\n`)
    runtime.keepAliveRefresher.stop()
    const forcedSocketCount = await drainHttpServer({
      server,
      runtimeState: runtime.runtimeState,
      connectionTracker: runtime.connectionTracker,
      sockets,
      drainTimeoutMs: appConfig.drainTimeoutMs,
      drainPollIntervalMs: appConfig.drainPollIntervalMs,
      detachGraceMs: appConfig.drainDetachGraceMs,
      signal,
      log: (message) => process.stdout.write(`${message}\n`),
    })
    await closeRelayRuntime(runtime)
    process.stdout.write(
      `[shutdown] signal=${signal} complete forced_socket_count=${forcedSocketCount}\n`,
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      signalCount += 1
      if (signalCount === 1) {
        void shutdown(signal).then(
          () => process.exit(0),
          (error) => {
            process.stderr.write(
              `[shutdown] signal=${signal} error=${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
            )
            process.exit(1)
          },
        )
        return
      }
      process.stderr.write(
        `[shutdown] signal=${signal} received_again count=${signalCount} force_exit=true\n`,
      )
      process.exit(1)
    })
  }
}
