import { appConfig } from '../config.js'
import { resolveClaudeWarmupStage } from './claudeWarmupPolicy.js'
import type { UsageRecord } from './usageStore.js'
import type { UserStore } from './userStore.js'

type RiskAlertReason = {
  code: string
  current: number
  limit: number
}

type RiskAlertSnapshot = Awaited<ReturnType<UserStore['getRiskWindowSnapshot']>>
type NewClaudeAccountRiskSnapshot = Awaited<ReturnType<UserStore['getNewClaudeAccountRiskSnapshot']>>

type RiskAlertInput = {
  usageRecordId: number
  record: UsageRecord
  method: string
  normalizedPath: string
}

const ALERTABLE_PATHS = new Set(['/v1/messages', '/v1/sessions/ws', '/v1/chat/completions'])
const MAX_PREVIEW_CHARS = 900
const FEISHU_TEXT_CHUNK_CHARS = 2800
const FEISHU_MAX_MESSAGES_PER_ALERT = 4

export class RiskAlertService {
  private readonly recentAlerts = new Map<string, number>()

  constructor(private readonly userStore: UserStore | null) {}

  async evaluate(input: RiskAlertInput): Promise<void> {
    if (!appConfig.riskAlertFeishuWebhookUrl) return
    if (input.record.attemptKind === 'retry_failure') return
    if (!ALERTABLE_PATHS.has(input.normalizedPath)) return

    const reasons = this.collectImmediateReasons(input.record)
    if (reasons.length === 0) return

    const snapshot = this.userStore && input.record.userId
      ? await this.userStore.getRiskWindowSnapshot({
          userId: input.record.userId,
          clientDeviceId: input.record.clientDeviceId ?? null,
          sessionKey: input.record.sessionKey ?? null,
        })
      : this.emptySnapshot()
    const newAccountSnapshot = await this.loadNewClaudeAccountSnapshot(input.record)

    const dedupKey = this.buildDedupKey(input, reasons)
    const now = Date.now()
    const lastSentAt = this.recentAlerts.get(dedupKey) ?? 0
    if (now - lastSentAt < appConfig.riskAlertDedupMs) return
    this.recentAlerts.set(dedupKey, now)
    this.pruneDedup(now)

    await this.sendFeishuAlert(input, snapshot, reasons, newAccountSnapshot)
  }


  private emptySnapshot(): RiskAlertSnapshot {
    return {
      userRecentRequests: 0,
      clientDeviceRecentRequests: 0,
      userRecentTokens: 0,
      clientDeviceRecentTokens: 0,
      userDistinctAccounts: 0,
      clientDeviceDistinctAccounts: 0,
      sessionDistinctAccounts: 0,
      sessionAccountSwitches: 0,
      distinctSessions: 0,
    }
  }

  private async loadNewClaudeAccountSnapshot(record: UsageRecord): Promise<NewClaudeAccountRiskSnapshot | null> {
    if (!this.userStore || !record.accountId?.startsWith('claude-official:') || !record.userId) return null
    return this.userStore.getNewClaudeAccountRiskSnapshot({
      accountId: record.accountId,
      userId: record.userId,
      clientDeviceId: record.clientDeviceId ?? null,
    })
  }

  private collectImmediateReasons(record: UsageRecord): RiskAlertReason[] {
    const response = (record.responseBodyPreview ?? '').toLowerCase()
    const isClaudeAccessRevoked =
      (record.statusCode === 401 || record.statusCode === 403) &&
      (response.includes('does not have access to claude') ||
        response.includes('access to claude') ||
        response.includes('disabled organization') ||
        response.includes('organization is disabled') ||
        response.includes('oauth token has been revoked') ||
        response.includes('authentication_failed'))
    const isLocalRiskRejection =
      record.statusCode >= 400 &&
      (response.includes('routing_guard') ||
        response.includes('unsupported_client') ||
        response.includes('cli_validation_failed') ||
        response.includes('upstream_incident_active') ||
        response.includes('session account pinning blocked migration') ||
        response.includes('pinning blocked migration') ||
        response.includes('predicted_7d_exhaustion'))
    const reasons: RiskAlertReason[] = []
    if (isClaudeAccessRevoked) reasons.push({ code: 'claude_access_revoked_403', current: 1, limit: 1 })
    if (isLocalRiskRejection) reasons.push({ code: 'local_risk_rejection', current: 1, limit: 1 })
    return reasons
  }

  private buildDedupKey(input: RiskAlertInput, reasons: RiskAlertReason[]): string {
    const reasonCodes = reasons.map((reason) => reason.code).sort().join(',')
    return [
      input.record.userId ?? '',
      input.record.clientDeviceId ?? '',
      input.record.sessionKey ?? '',
      input.normalizedPath,
      reasonCodes,
    ].join('|')
  }

  private pruneDedup(now: number): void {
    const cutoff = now - appConfig.riskAlertDedupMs * 4
    for (const [key, timestamp] of this.recentAlerts) {
      if (timestamp < cutoff) {
        this.recentAlerts.delete(key)
      }
    }
  }

  private async sendFeishuAlert(
    input: RiskAlertInput,
    snapshot: RiskAlertSnapshot,
    reasons: RiskAlertReason[],
    newAccountSnapshot: NewClaudeAccountRiskSnapshot | null,
  ): Promise<void> {
    const webhookUrl = appConfig.riskAlertFeishuWebhookUrl
    if (!webhookUrl) return

    const record = input.record
    const summaryLines = [
      'TokenQiao 风控高警报',
      `原因: ${reasons.map((reason) => `${reason.code}=${reason.current}/${reason.limit}`).join(', ')}`,
      `路径: ${input.normalizedPath} (${record.target})`,
      `用户: ${record.userId ?? '-'} 设备: ${record.clientDeviceId ?? '-'}`,
      `Session: ${record.sessionKey ?? '-'} 账号: ${record.accountId ?? '-'}`,
      `状态: ${record.statusCode} rateLimit=${record.rateLimitStatus ?? '-'}`,
      `本次 tokens: in=${record.inputTokens} out=${record.outputTokens} cacheCreate=${record.cacheCreationInputTokens} cacheRead=${record.cacheReadInputTokens}`,
      `窗口统计: userReq=${snapshot.userRecentRequests}, deviceReq=${snapshot.clientDeviceRecentRequests}, userTokens=${snapshot.userRecentTokens}, deviceTokens=${snapshot.clientDeviceRecentTokens}`,
      `账号统计: userAccounts=${snapshot.userDistinctAccounts}, deviceAccounts=${snapshot.clientDeviceDistinctAccounts}, sessionAccounts=${snapshot.sessionDistinctAccounts}, sessionSwitches=${snapshot.sessionAccountSwitches}, sessions=${snapshot.distinctSessions}`,
      `新号统计: stage=${newAccountSnapshot ? resolveClaudeWarmupStage(newAccountSnapshot.accountAgeMs).label : '-'}, age=${this.formatDuration(newAccountSnapshot?.accountAgeMs ?? null)}, firstSeen=${newAccountSnapshot?.accountFirstSeenAt ?? '-'}, userClaude24h=${newAccountSnapshot?.userDistinctClaudeOfficialAccounts24h ?? '-'}, deviceClaude24h=${newAccountSnapshot?.clientDeviceDistinctClaudeOfficialAccounts24h ?? '-'}, rpm1m=${newAccountSnapshot?.accountRequestCount1m ?? '-'}, tokens1m=${newAccountSnapshot?.accountTokens1m ?? '-'}, cacheRead1m=${newAccountSnapshot?.accountCacheRead1m ?? '-'}`,
      `上游组织: org=${record.organizationId ?? this.extractResponseHeader(record.responseHeaders, 'anthropic-organization-id') ?? '-'} overageDisabled=${this.extractResponseHeader(record.responseHeaders, 'anthropic-ratelimit-unified-overage-disabled-reason') ?? '-'}`,
      `请求: id=${record.requestId} usageRecordId=${input.usageRecordId} method=${input.method}`,
      `头部: ${this.summarizeHeaders(record.requestHeaders)}`,
    ]
    const messageParts = [summaryLines.join('\n')]
    const requestPreview = record.requestBodyPreview?.trim()
    if (requestPreview) {
      messageParts.push(`请求预览:\n${requestPreview}`)
    }
    const responsePreview = record.responseBodyPreview?.trim()
    if (responsePreview) {
      messageParts.push(`响应预览:\n${responsePreview}`)
    }
    const chunks = this.chunkMessages(messageParts, FEISHU_TEXT_CHUNK_CHARS, FEISHU_MAX_MESSAGES_PER_ALERT)
    for (const [index, chunk] of chunks.entries()) {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'text',
          content: { text: chunks.length > 1 ? `[${index + 1}/${chunks.length}] ${chunk}` : chunk },
        }),
      })
      if (!response.ok) {
        throw new Error(`Feishu webhook returned ${response.status}`)
      }
    }
  }


  private chunkMessages(parts: string[], chunkSize: number, maxChunks: number): string[] {
    const chunks: string[] = []
    for (const part of parts) {
      let remaining = part
      while (remaining.length > 0 && chunks.length < maxChunks) {
        chunks.push(remaining.slice(0, chunkSize))
        remaining = remaining.slice(chunkSize)
      }
      if (chunks.length >= maxChunks) break
    }
    if (parts.join('\n').length > chunks.join('\n').length && chunks.length > 0) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n...[truncated: open Risk panel for full captured preview]`
    }
    return chunks.length > 0 ? chunks : ['TokenQiao 风控高警报']
  }

  private formatDuration(ms: number | null): string {
    if (ms == null || !Number.isFinite(ms)) return '-'
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h${minutes % 60}m`
    return `${Math.floor(hours / 24)}d${hours % 24}h`
  }

  private extractResponseHeader(headers: UsageRecord['responseHeaders'], name: string): string | null {
    if (!headers) return null
    const value = headers[name] ?? headers[name.toLowerCase()]
    if (Array.isArray(value)) return value.join(',').slice(0, 160)
    if (value == null) return null
    return String(value).slice(0, 160)
  }

  private summarizeHeaders(headers: UsageRecord['requestHeaders']): string {
    if (!headers) return '-'
    const get = (name: string): string => {
      const value = headers[name] ?? headers[name.toLowerCase()]
      if (Array.isArray(value)) return value.join(',').slice(0, 160)
      return String(value ?? '').slice(0, 160)
    }
    return [
      `ip=${get('cf-connecting-ip') || get('x-real-ip') || '-'}`,
      `ua=${get('user-agent') || '-'}`,
      `x-app=${get('x-app') || '-'}`,
      `cc-session=${get('x-claude-code-session-id') || '-'}`,
      `beta=${get('anthropic-beta') || '-'}`,
      `direct-browser=${get('anthropic-dangerous-direct-browser-access') || '-'}`,
    ].join('; ')
  }

  private truncate(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`
  }
}
