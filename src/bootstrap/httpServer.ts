import { createServer as createHttpServer } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import type { ConnectionTracker } from '../runtime/connectionTracker.js'
import type { RuntimeState } from '../runtime/instanceState.js'

type HttpServer = ReturnType<typeof createHttpServer>

export async function listen(server: HttpServer, port: number, host: string): Promise<void> {
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
    server.listen(port, host)
  })
}

export function trackServerSockets(server: HttpServer): Set<Socket> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })
  return sockets
}

export function rejectRelayUpgradeWhileDraining(socket: Duplex): void {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Relay instance is draining. Please retry on another instance.',
      internal_code: 'COR_SERVICE_UNAVAILABLE',
    },
  })
  socket.end(
    [
      'HTTP/1.1 503 Service Unavailable',
      'Connection: close',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'),
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function drainHttpServer(input: {
  server: HttpServer
  runtimeState: RuntimeState
  connectionTracker: ConnectionTracker
  sockets: Set<Socket>
  drainTimeoutMs: number
  drainPollIntervalMs: number
  detachGraceMs: number
  signal: string
  log: (message: string) => void
}): Promise<number> {
  input.runtimeState.enterDraining()
  if (input.detachGraceMs > 0) {
    input.log(`[shutdown] signal=${input.signal} detach_grace_ms=${input.detachGraceMs}`)
    await sleep(input.detachGraceMs)
  }

  const closePromise = new Promise<void>((resolve) => {
    input.server.close(() => resolve())
  })
  const drainDeadline = Date.now() + input.drainTimeoutMs
  let forcedSocketCount = 0

  while (Date.now() < drainDeadline) {
    const connectionSnapshot = input.connectionTracker.snapshot()
    if (
      connectionSnapshot.activeHttpRequests === 0 &&
      connectionSnapshot.activeStreams === 0 &&
      connectionSnapshot.activeWebSockets === 0 &&
      input.sockets.size === 0
    ) {
      break
    }
    await sleep(input.drainPollIntervalMs)
  }

  if (input.sockets.size > 0) {
    forcedSocketCount = input.sockets.size
    input.log(
      `[shutdown] signal=${input.signal} drain_timeout_ms=${input.drainTimeoutMs} force_destroy_sockets=${forcedSocketCount}`,
    )
    for (const socket of input.sockets) {
      socket.destroy()
    }
  }

  await closePromise
  input.runtimeState.markStopped()
  return forcedSocketCount
}
