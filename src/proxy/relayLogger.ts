import { appConfig } from '../config.js'

export type RelayLogEvent = {
  event:
    | 'body_rewrite_metrics'
    | 'billing_sku_preflight_soft_missing'
    | 'claude_compatible_model_routed'
    | 'http_completed'
    | 'http_rejected'
    | 'http_failed'
    | 'http_stream_error'
    | 'usage_record_failed'
    | 'upstream_incident_changed'
    | 'ws_opened'
    | 'ws_rejected'
    | 'ws_closed'
    | 'retry_attempt'
    | 'http_stream_error_appended'
    | 'long_term_block_detected'
    | 'cli_validation_failed'
  requestId: string
  method: string
  target: string
  authMode?: 'oauth' | 'api_key' | 'preserve_incoming_auth' | 'none'
  routeAuthStrategy?: 'prefer_incoming_auth' | 'preserve_incoming_auth' | 'none'
  accountId?: string | null
  forceAccountId?: string | null
  hasStickySessionKey?: boolean
  durationMs: number
  statusCode?: number
  statusText?: string
  upstreamRequestId?: string | null
  upstreamRay?: string | null
  stage?: 'body_template' | 'session_route'
  clientVersion?: string | null
  templateVersion?: string | null
  originalBodyBytes?: number
  rewrittenBodyBytes?: number
  deltaBodyBytes?: number
  systemBlockCount?: number | null
  messageCount?: number | null
  toolCount?: number | null
  systemBytes?: number | null
  messagesBytes?: number | null
  toolsBytes?: number | null
  handoffInjected?: boolean | null
  rateLimitStatus?: string | null
  retryAfterSeconds?: number | null
  sameRequestMigrationEligible?: boolean | null
  internalCode?: string
  responseContentType?: string | null
  responseBodyPreview?: string | null
  retryCount?: number
  retryAttempt?: number
  retryDelayMs?: number
  retryDisallowedCount?: number
  retryMigrationReason?: string | null
  closeCode?: number
  affectedAccountCount?: number
  incidentActiveUntil?: string | null
  error?: string
  sourceModel?: string | null
  targetModel?: string | null
  tierHit?: 'opus' | 'sonnet' | 'haiku' | null
  validatorMode?: 'shadow' | 'enforce'
  validationLayer?: 'L2' | 'L3' | 'L4'
  validationField?: string
  validationReason?: string
}

export type RelayBodyCapture = {
  length: number
  sha256: string
  utf8Preview: string | null
  truncated: boolean
}

export type RelayHeaderCapture = {
  name: string
  values: string[]
}

export type RelayHeaderChangeCapture = {
  name: string
  incomingValues: string[]
  upstreamValues: string[]
}

export type RelayCaptureEvent = {
  event: 'http_request_capture'
  requestId: string
  method: string
  target: string
  upstreamUrl: string
  authMode: 'oauth' | 'api_key' | 'preserve_incoming_auth' | 'none'
  routeAuthStrategy: 'prefer_incoming_auth' | 'preserve_incoming_auth' | 'none'
  incomingRawHeaders: string[]
  upstreamRequestHeaders: string[]
  removedHeaders: RelayHeaderCapture[]
  addedHeaders: RelayHeaderCapture[]
  changedHeaders: RelayHeaderChangeCapture[]
  incomingBody: RelayBodyCapture
  upstreamBody: RelayBodyCapture
}

export interface RelayLogger {
  log(event: RelayLogEvent): void
  logCapture?(event: RelayCaptureEvent): void
}

export class ConsoleRelayLogger implements RelayLogger {
  log(event: RelayLogEvent): void {
    if (!appConfig.relayLogEnabled) {
      return
    }

    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        service: 'claude-oauth-relay',
        timestamp: new Date().toISOString(),
        ...event,
      })}\n`,
    )
  }

  logCapture(event: RelayCaptureEvent): void {
    if (!appConfig.relayLogEnabled || !appConfig.relayCaptureEnabled) {
      return
    }

    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        service: 'claude-oauth-relay',
        timestamp: new Date().toISOString(),
        ...event,
      })}\n`,
    )
  }
}
