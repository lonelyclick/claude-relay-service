import type { Agent as HttpAgent } from 'node:http'
import type { Agent as HttpsAgent } from 'node:https'

import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { Dispatcher } from 'undici'
import { ProxyAgent } from 'undici'

// Debug logger that respects RELAY_LOG_ENABLED
function logProxy(message: string): void {
  if (process.env.RELAY_LOG_ENABLED !== 'false') {
    process.stdout.write(`[ProxyPool] ${message}\n`)
  }
}

/**
 * Lazily creates and caches proxy agent instances per unique proxy URL.
 */
export class ProxyPool {
  private readonly httpDispatchers = new Map<string, ProxyAgent>()
  private readonly wsAgents = new Map<string, HttpProxyAgent<string>>()
  private readonly wssAgents = new Map<string, HttpsProxyAgent<string>>()

  /**
   * Get an undici ProxyAgent (for HTTP forwarding via `request()`).
   */
  getHttpDispatcher(proxyUrl: string): Dispatcher {
    let agent = this.httpDispatchers.get(proxyUrl)
    if (!agent) {
      logProxy(`Creating new ProxyAgent for ${proxyUrl}`)
      agent = new ProxyAgent(proxyUrl)
      this.httpDispatchers.set(proxyUrl, agent)
    } else {
      logProxy(`Reusing cached ProxyAgent for ${proxyUrl}`)
    }
    return agent
  }

  /**
   * Get an HttpProxyAgent (for ws:// WebSocket connections).
   */
  getWsAgent(proxyUrl: string): HttpAgent {
    let agent = this.wsAgents.get(proxyUrl)
    if (!agent) {
      agent = new HttpProxyAgent(proxyUrl)
      this.wsAgents.set(proxyUrl, agent)
    }
    return agent
  }

  /**
   * Get an HttpsProxyAgent (for wss:// WebSocket connections).
   */
  getWssAgent(proxyUrl: string): HttpsAgent {
    let agent = this.wssAgents.get(proxyUrl)
    if (!agent) {
      agent = new HttpsProxyAgent(proxyUrl)
      this.wssAgents.set(proxyUrl, agent)
    }
    return agent
  }

  /**
   * Remove cached agents for a proxy URL (e.g. when an account's proxy changes).
   */
  evict(proxyUrl: string): void {
    const httpDispatcher = this.httpDispatchers.get(proxyUrl)
    if (httpDispatcher) {
      httpDispatcher.close().catch(() => {})
      this.httpDispatchers.delete(proxyUrl)
    }
    const wsAgent = this.wsAgents.get(proxyUrl)
    if (wsAgent) {
      wsAgent.destroy()
      this.wsAgents.delete(proxyUrl)
    }
    const wssAgent = this.wssAgents.get(proxyUrl)
    if (wssAgent) {
      wssAgent.destroy()
      this.wssAgents.delete(proxyUrl)
    }
  }

  async close(): Promise<void> {
    const closeTasks: Promise<unknown>[] = []
    for (const [proxyUrl, dispatcher] of this.httpDispatchers) {
      closeTasks.push(
        dispatcher.close().catch((error) => {
          logProxy(`Failed to close ProxyAgent for ${proxyUrl}: ${error instanceof Error ? error.message : String(error)}`)
        }),
      )
    }
    this.httpDispatchers.clear()

    for (const agent of this.wsAgents.values()) {
      agent.destroy()
    }
    this.wsAgents.clear()

    for (const agent of this.wssAgents.values()) {
      agent.destroy()
    }
    this.wssAgents.clear()

    await Promise.all(closeTasks)
  }
}
