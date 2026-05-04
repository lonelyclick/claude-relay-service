import { createServer as createHttpServer } from 'node:http'

import { appConfig } from '../config.js'
import { createServerApp } from '../apps/createServerApp.js'
import { closeCorPgPool } from '../server.js'
import { drainHttpServer, listen, trackServerSockets } from './httpServer.js'
import { buildServerRuntime, closeServerRuntime } from './serverRuntime.js'

export async function main(): Promise<void> {
  const runtime = await buildServerRuntime()
  const app = createServerApp(runtime)
  const server = createHttpServer(app)
  const sockets = trackServerSockets(server)

  await listen(server, appConfig.port, appConfig.host)
  runtime.runtimeState.markReady()
  runtime.balanceAlertScheduler.start()
  runtime.accountRiskScoreScheduler.start()
  process.stdout.write(
    `Claude OAuth Relay (server) listening on http://${appConfig.host}:${appConfig.port}\n`,
  )

  let shuttingDown = false
  let signalCount = 0
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    process.stdout.write(`[shutdown] signal=${signal} begin\n`)
    const forcedSocketCount = await drainHttpServer({
      server,
      runtimeState: runtime.runtimeState,
      connectionTracker: runtime.connectionTracker,
      sockets,
      drainTimeoutMs: appConfig.drainTimeoutMs,
      drainPollIntervalMs: appConfig.drainPollIntervalMs,
      detachGraceMs: 0,
      signal,
      log: (message) => process.stdout.write(`${message}\n`),
    })
    try {
      await closeServerRuntime(runtime)
    } finally {
      await closeCorPgPool()
    }
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
