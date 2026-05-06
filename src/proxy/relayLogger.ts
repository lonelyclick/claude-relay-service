import { appConfig } from '../config.js'

export type RelayLogEvent = {
  event:
    | 'body_rewrite_metrics'
    | 'billing_sku_preflight_soft_missing'
    | 'billing_reservation_release_failed'
    | 'claude_compatible_model_routed'
    | 'http_completed'
    | 'http_client_disconnected'
    | 'http_rejected'
    | 'http_failed'
    | 'http_request_timeout'
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
    | 'risk_observation'
    | 'risk_alert_failed'
    | 'claude_new_account_guardrail_applied'
    | 'anthropic_overage_disabled_guardrail'
    | 'lifecycle_first_real_request_failed'
  requestId: string
  method: string
  target: string
  authMode?: 'oauth' | 'api_key' | 'preserve_incoming_auth' | 'none'
  routeAuthStrategy?: 'prefer_incoming_auth' | 'preserve_incoming_auth' | 'none'
  accountId?: string | null
  reservationId?: string | null
  forceAccountId?: string | null
  hasStickySessionKey?: boolean
  durationMs: number
  timeoutMs?: number
  phase?: string
  phaseDurationMs?: number
  statusCode?: number
  statusText?: string
  upstreamRequestId?: string | null
  upstreamRay?: string | null
  stage?: 'body_template' | 'session_route'
  clientVersion?: string | null
  templateVersion?: string | null
  originalBodyBytes?: number
  rewrittenBodyBytes?: number
  originalBodySha256?: string
  rewrittenBodySha256?: string
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
  reason?: string
  sourceModel?: string | null
  targetModel?: string | null
  tierHit?: 'opus' | 'sonnet' | 'haiku' | null
  validatorMode?: 'shadow' | 'enforce'
  validationLayer?: 'L2' | 'L3' | 'L4'
  validationField?: string
  validationReason?: string
  normalizedTarget?: string
  usageRecordId?: number
  userId?: string | null
  organizationId?: string | null
  relayKeySource?: string | null
  attemptKind?: string | null
  model?: string | null
  sessionKeyPresent?: boolean
  sessionKeyHash?: string | null
  clientDeviceId?: string | null
  clientIp?: string | null
  userAgent?: string | null
  xApp?: string | null
  claudeCodeSessionId?: string | null
  anthropicBeta?: string | null
  anthropicVersion?: string | null
  directBrowserAccess?: string | null
  rateLimit5hUtilization?: number | null
  rateLimit7dUtilization?: number | null
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  totalTokens?: number
  riskKeywords?: string[]
  requestBodyPreviewBytes?: number
  requestBodyPreviewSha256?: string | null
  responseBodyPreviewBytes?: number
  responseBodyPreviewSha256?: string | null
  upstreamOrganizationId?: string | null
  unifiedOverageStatus?: string | null
  unifiedOverageDisabledReason?: string | null
  unifiedRepresentativeClaim?: string | null
  unifiedFiveHourStatus?: string | null
  unifiedSevenDayStatus?: string | null
  unifiedFallbackPercentage?: string | null
  overageDisabledReason?: string | null
  overageStatus?: string | null
  unifiedStatus?: string | null
  severity?: 'observe' | 'warn' | 'block'
  representativeClaim?: string | null
  fiveHourStatus?: string | null
  sevenDayStatus?: string | null
  fallbackPercentage?: string | null
  severityNotes?: string[]
  appliedAccountCount?: number
  appliedAccountIds?: string[] | null

  warmupStage?: string
  warmupStageLabel?: string
  warmupPolicyId?: string
  accountSwitchLimit24h?: number
  triggers?: Array<{ code: string; current: number; limit: number; label: string }>
  accountAgeMs?: number | null
  accountRequestCount1m?: number
  accountTokens1m?: number
  accountCacheRead1m?: number
  userDistinctClaudeOfficialAccounts24h?: number
  clientDeviceDistinctClaudeOfficialAccounts24h?: number
  cooldownMs?: number
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
