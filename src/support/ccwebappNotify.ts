import { appConfig } from '../config.js'
import type { SupportTicket } from './supportStore.js'

const NOTIFY_TIMEOUT_MS = 5000

export interface AgentReplyNotification {
  ticket: SupportTicket
  agentReplyBody: string
  agentName: string
}

export async function notifyCcwebappAgentReply(input: AgentReplyNotification): Promise<void> {
  const baseUrl = appConfig.ccwebappNotifyUrl
  const token = appConfig.internalToken
  if (!baseUrl || !token) {
    return
  }
  const url = baseUrl.replace(/\/+$/, '') + '/api/internal/support/notify-reply'
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })
    if (!response.ok) {
      process.stderr.write(`[supportNotify] ccwebapp notify returned ${response.status}\n`)
    }
  } catch (error) {
    process.stderr.write(`[supportNotify] ccwebapp notify failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
