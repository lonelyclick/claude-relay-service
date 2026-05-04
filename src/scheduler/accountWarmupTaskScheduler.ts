import { request, type Dispatcher } from 'undici'

import { appConfig } from '../config.js'
import type { OAuthService } from '../oauth/service.js'
import type { ProxyPool } from './proxyPool.js'
import type { AccountLifecycleStore } from '../usage/accountLifecycleStore.js'
import type { StoredAccount } from '../types.js'

const DAY_MS = 24 * 60 * 60 * 1000

interface WarmupPromptSpec {
  prompt: string
  fingerprint: string
  language: string
  theme: string
  format: string
  persona: string
}

const WARMUP_LANGUAGES = [
  { id: 'zh-cn', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'mixed', label: '中英混合' },
  { id: 'zh-tw', label: '繁體中文' },
]

const WARMUP_THEMES = [
  'API health check',
  'support handoff',
  'incident triage',
  'account onboarding',
  'quota review',
  'latency note',
  'customer reply draft',
  'release checklist',
  'proxy diagnostics',
  'billing sanity check',
  'documentation note',
  'operator shift note',
  'risk observation',
  'network checklist',
  'token usage summary',
  'QA smoke test',
  'routing group review',
  'uptime note',
  'SRE runbook snippet',
  'admin dashboard copy',
  'email support summary',
  'access token rotation',
  'rate-limit interpretation',
  'safe rollout reminder',
  'session continuity note',
  'cache usage explanation',
  'team onboarding memo',
  'customer success follow-up',
  'log review checklist',
  'post-deploy observation',
  'service desk tag suggestion',
  'internal changelog blurb',
]

const WARMUP_FORMATS = [
  { id: 'bullets2', instruction: '输出 2 条 bullet，每条不超过 16 个字或 12 个英文词。' },
  { id: 'bullets3', instruction: '输出 3 条很短的 checklist，不要解释。' },
  { id: 'json', instruction: '只返回 compact JSON，字段为 status、note、next。' },
  { id: 'one_sentence', instruction: '只写一句自然的内部备注，不超过 28 个字或 22 个英文词。' },
  { id: 'title_body', instruction: '输出一行标题和一行备注，保持简短。' },
  { id: 'do_dont', instruction: '输出 Do / Do not 各一条，简洁。' },
  { id: 'micro_email', instruction: '写一段 2 句以内的客服内部邮件草稿。' },
  { id: 'table', instruction: '输出两列表格：check 和 result；只要 2 行。' },
  { id: 'yaml', instruction: '只返回短 YAML，字段 check、risk、next。' },
  { id: 'summary', instruction: '写一个超短摘要和一个 next step。' },
]

const WARMUP_PERSONAS = [
  'support operator',
  'SRE on-call',
  'admin dashboard PM',
  'billing analyst',
  'QA engineer',
  'customer success manager',
  'platform engineer',
  'release coordinator',
  'risk observer',
  'technical writer',
  'ops lead',
  'API integration engineer',
]

const WARMUP_TONES = [
  'neutral',
  'calm',
  'concise',
  'friendly',
  'matter-of-fact',
  'slightly formal',
  'internal note style',
  'operator log style',
]

const WARMUP_CONTEXTS = [
  'morning shift',
  'post deploy',
  'pre-flight check',
  'low traffic period',
  'new account observation',
  'routine review',
  'handoff before lunch',
  'end-of-day note',
  'dashboard cleanup',
  'ticket grooming',
  'weekly ops sample',
  'quiet window',
  'canary observation',
  'support queue review',
  'network sanity pass',
  'billing spot check',
]

const WARMUP_OBJECTS = [
  'Claude API account',
  'relay routing group',
  'support ticket',
  'admin dashboard row',
  'rate limit snapshot',
  'warmup observation',
  'proxy route',
  'customer workspace',
  'usage graph',
  'token report',
  'operator checklist',
  'OAuth connection',
  'team account',
  'health endpoint',
  'deployment note',
  'risk score card',
]

const WARMUP_TIME_HINTS = [
  'today',
  'this hour',
  'before the next shift',
  'after a quiet probe',
  'for a new teammate',
  'without using sensitive data',
  'as an internal note',
  'for a dashboard tooltip',
  'for a runbook margin note',
  'for a low-priority ticket',
]

const WARMUP_DIRECTIVES = [
  '不要提到你是 AI。',
  '不要编造具体用户、IP、金额或故障。',
  '避免长篇解释。',
  '保持低信息量、低风险、自然。',
  '不要要求执行真实操作。',
  '不要包含密钥、邮箱或个人信息。',
  '不要输出代码块。',
  '不要使用夸张语气。',
]


export class AccountWarmupTaskScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly dailyTargets = new Map<string, { day: string; target: number }>()
  private readonly lastAttemptAt = new Map<string, number>()

  constructor(
    private readonly oauthService: OAuthService,
    private readonly proxyPool: ProxyPool,
    private readonly lifecycleStore: AccountLifecycleStore,
  ) {}

  start(): void {
    if (this.timer || !appConfig.accountWarmupTaskEnabled) return
    const run = () => {
      void this.tick().catch((error) => {
        process.stderr.write(`[account-warmup-task] tick_failed error=${error instanceof Error ? error.message : String(error)}\n`)
      })
    }
    this.timer = setInterval(run, appConfig.accountWarmupTaskIntervalMs)
    this.timer.unref?.()
    setTimeout(run, randomInt(15_000, 90_000)).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running || !appConfig.accountWarmupTaskEnabled) return
    this.running = true
    try {
      const now = Date.now()
      const candidates = (await this.oauthService.listAccounts()).filter((account) => this.isEligible(account, now))
      if (candidates.length === 0) return

      let attempted = 0
      let skippedQuota = 0
      let skippedSpacing = 0
      for (const account of shuffle(candidates)) {
        if (attempted >= appConfig.accountWarmupTaskMaxAccountsPerTick) break
        const events24h = await this.lifecycleStore.listEvents({
          accountId: account.id,
          eventTypes: ['warmup_task'],
          since: new Date(now - DAY_MS),
          limit: 200,
        })
        const ok24h = events24h.filter((event) => event.outcome === 'ok').length
        const target = this.dailyTargetFor(account.id, now)
        if (ok24h >= target) {
          skippedQuota++
          continue
        }
        const latest = events24h[0]?.occurredAt ? Date.parse(events24h[0].occurredAt) : 0
        const minGapMs = this.minGapMsFor(target)
        const lastAttempt = Math.max(latest, this.lastAttemptAt.get(account.id) ?? 0)
        if (lastAttempt > 0 && now - lastAttempt < minGapMs) {
          skippedSpacing++
          continue
        }
        this.lastAttemptAt.set(account.id, now)
        attempted++
        await this.runWarmup(account, { ok24h, target, minGapMs })
        await sleep(randomInt(1_500, 6_000))
      }
      if (attempted > 0 || skippedQuota > 0 || skippedSpacing > 0) {
        process.stdout.write(
          `[account-warmup-task] candidates=${candidates.length} attempted=${attempted} skipped_quota=${skippedQuota} skipped_spacing=${skippedSpacing}\n`,
        )
      }
    } finally {
      this.running = false
    }
  }

  private isEligible(account: StoredAccount, now: number): boolean {
    if (account.provider !== 'claude-official') return false
    if (!account.isActive || account.status === 'revoked' || account.status === 'banned') return false
    if (!account.accessToken) return false
    if (account.schedulerEnabled === false) return false
    if (account.schedulerState === 'paused' || account.schedulerState === 'draining' || account.schedulerState === 'auto_blocked') return false
    if ((account.cooldownUntil ?? 0) > now || (account.autoBlockedUntil ?? 0) > now) return false
    if (account.lastRateLimitStatus && account.lastRateLimitStatus !== 'allowed') return false
    if ((account.lastRateLimit5hUtilization ?? 0) >= appConfig.accountWarmupTaskMaxUtilization) return false
    if ((account.lastRateLimit7dUtilization ?? 0) >= appConfig.accountWarmupTaskMaxUtilization) return false
    const riskScore = readRiskScore(account)
    if (riskScore !== null && riskScore > appConfig.accountWarmupTaskMaxRiskScore) return false
    if (appConfig.accountWarmupTaskRoutingGroupIds.length > 0) {
      const groupId = account.routingGroupId ?? account.group ?? ''
      if (!appConfig.accountWarmupTaskRoutingGroupIds.includes(groupId)) return false
    }
    if (appConfig.accountWarmupTaskEmailDomains.length > 0) {
      const email = account.emailAddress?.toLowerCase() ?? ''
      if (!appConfig.accountWarmupTaskEmailDomains.some((domain) => email.endsWith(`@${domain}`))) return false
    }
    if (appConfig.accountWarmupTaskMaxConnectedAgeHours > 0) {
      const connectedAt = Date.parse(account.createdAt)
      if (Number.isFinite(connectedAt) && now - connectedAt > appConfig.accountWarmupTaskMaxConnectedAgeHours * 60 * 60 * 1000) {
        return false
      }
    }
    return true
  }

  private async runWarmup(account: StoredAccount, context: { ok24h: number; target: number; minGapMs: number }): Promise<void> {
    const startedAt = Date.now()
    let proxyUrl: string | null = null
    let dispatcher: Dispatcher | undefined
    try {
      proxyUrl = await this.oauthService.resolveProxyUrl(account.proxyUrl)
      dispatcher = proxyUrl ? this.proxyPool.getHttpDispatcher(proxyUrl) : undefined
      const promptSpec = buildWarmupPrompt(account, startedAt)
      const response = await request(`${appConfig.anthropicApiBaseUrl}/v1/messages`, {
        method: 'POST',
        dispatcher,
        headers: {
          authorization: `Bearer ${account.accessToken}`,
          'content-type': 'application/json',
          'anthropic-version': appConfig.anthropicVersion,
          'anthropic-beta': appConfig.oauthBetaHeader,
          'user-agent': 'claude-cli/1.0.103 (external, cli)',
        },
        body: JSON.stringify({
          model: appConfig.accountWarmupTaskModel,
          max_tokens: appConfig.accountWarmupTaskMaxTokens,
          messages: [{ role: 'user', content: promptSpec.prompt }],
        }),
      })
      const bodyText = await response.body.text().catch(() => '')
      const headers = response.headers as Record<string, string | string[] | undefined>
      const unifiedStatus = firstHeader(headers, 'anthropic-ratelimit-unified-status')
      const outcome = response.statusCode >= 200 && response.statusCode < 300 && (!unifiedStatus || unifiedStatus === 'allowed')
        ? 'ok'
        : response.statusCode >= 400 || unifiedStatus === 'rejected' || unifiedStatus === 'allowed_warning'
          ? 'failure'
          : 'info'
      await this.lifecycleStore.recordEvent({
        accountId: account.id,
        eventType: 'warmup_task',
        outcome,
        egressProxyUrl: proxyUrl,
        egressProvider: account.provider,
        upstreamStatus: response.statusCode,
        upstreamRequestId: firstHeader(headers, 'request-id') ?? firstHeader(headers, 'x-request-id'),
        upstreamOrganizationId: firstHeader(headers, 'anthropic-ratelimit-organization-id') ?? firstHeader(headers, 'x-anthropic-organization-uuid'),
        upstreamRateLimitTier: firstHeader(headers, 'anthropic-ratelimit-tier'),
        anthropicHeaders: pickAnthropicHeaders(headers),
        notes: {
          model: appConfig.accountWarmupTaskModel,
          maxTokens: appConfig.accountWarmupTaskMaxTokens,
          ok24h: context.ok24h,
          target24h: context.target,
          minGapMs: context.minGapMs,
          promptFingerprint: promptSpec.fingerprint,
          promptLanguage: promptSpec.language,
          promptTheme: promptSpec.theme,
          promptFormat: promptSpec.format,
          promptPersona: promptSpec.persona,
          unifiedStatus,
          fiveHourStatus: firstHeader(headers, 'anthropic-ratelimit-five-hour-status'),
          sevenDayStatus: firstHeader(headers, 'anthropic-ratelimit-seven-day-status'),
          overageStatus: firstHeader(headers, 'anthropic-ratelimit-unified-overage-status'),
          overageDisabledReason: firstHeader(headers, 'anthropic-ratelimit-unified-overage-disabled-reason'),
          bodyPreview: bodyText.slice(0, 200),
        },
        durationMs: Date.now() - startedAt,
      })
      process.stdout.write(
        `[account-warmup-task] account=${account.id} status=${response.statusCode} unified=${unifiedStatus ?? '-'} outcome=${outcome}\n`,
      )
    } catch (error) {
      await this.lifecycleStore.recordEvent({
        accountId: account.id,
        eventType: 'warmup_task',
        outcome: 'failure',
        egressProxyUrl: proxyUrl,
        egressProvider: account.provider,
        notes: { error: error instanceof Error ? error.message : String(error) },
        durationMs: Date.now() - startedAt,
      })
      process.stderr.write(
        `[account-warmup-task] account=${account.id} failed error=${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }

  private dailyTargetFor(accountId: string, now: number): number {
    const day = new Date(now).toISOString().slice(0, 10)
    const existing = this.dailyTargets.get(accountId)
    if (existing?.day === day) return existing.target
    const target = randomInt(appConfig.accountWarmupTaskDailyMin, appConfig.accountWarmupTaskDailyMax)
    this.dailyTargets.set(accountId, { day, target })
    return target
  }

  private minGapMsFor(target: number): number {
    const base = DAY_MS / Math.max(1, target)
    return Math.max(appConfig.accountWarmupTaskMinGapMs, Math.floor(base * 0.6))
  }
}


function buildWarmupPrompt(account: StoredAccount, now: number): WarmupPromptSpec {
  const language = pick(WARMUP_LANGUAGES)
  const theme = pick(WARMUP_THEMES)
  const format = pick(WARMUP_FORMATS)
  const persona = pick(WARMUP_PERSONAS)
  const tone = pick(WARMUP_TONES)
  const context = pick(WARMUP_CONTEXTS)
  const object = pick(WARMUP_OBJECTS)
  const timeHint = pick(WARMUP_TIME_HINTS)
  const directives = shuffle(WARMUP_DIRECTIVES).slice(0, randomInt(2, 4))
  const accountHint = safeAccountHint(account)
  const nonce = `${new Date(now).toISOString().slice(0, 10)}-${randomInt(1000, 9999)}`
  const languageLine = language.id === 'mixed'
    ? 'Use concise mixed Chinese and English if natural.'
    : `Use ${language.label}.`
  const prompt = [
    `Role: ${persona}.`,
    `Task: Create a small, realistic internal warmup note about ${object}.`,
    `Scenario: ${context}; theme=${theme}; time=${timeHint}.`,
    accountHint ? `Account context: ${accountHint}.` : null,
    `Style: ${tone}; ${languageLine}`,
    `Format: ${format.instruction}`,
    `Constraints: ${directives.join(' ')}`,
    `Trace nonce: ${nonce}. Do not explain the nonce.`,
  ].filter(Boolean).join('\n')

  return {
    prompt,
    fingerprint: [language.id, theme, format.id, persona, context, object, timeHint, tone].join('|'),
    language: language.id,
    theme,
    format: format.id,
    persona,
  }
}

function safeAccountHint(account: StoredAccount): string | null {
  const parts: string[] = []
  if (account.rateLimitTier) parts.push(`tier=${account.rateLimitTier}`)
  if (account.warmupPolicyId) parts.push(`warmupPolicy=${account.warmupPolicyId}`)
  if (account.routingGroupId ?? account.group) parts.push(`routingGroup=${account.routingGroupId ?? account.group}`)
  return parts.length > 0 ? parts.join(', ') : null
}

function pick<T>(items: readonly T[]): T {
  const item = items[randomInt(0, items.length - 1)]
  if (item === undefined) throw new Error('warmup prompt pool is empty')
  return item
}

function readRiskScore(account: StoredAccount): number | null {
  const value = (account as unknown as { riskScore?: unknown }).riskScore
  const score = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(score) ? score : null
}

function pickAnthropicHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const keys = [
    'anthropic-ratelimit-unified-status',
    'anthropic-ratelimit-five-hour-status',
    'anthropic-ratelimit-seven-day-status',
    'anthropic-ratelimit-unified-overage-status',
    'anthropic-ratelimit-unified-overage-disabled-reason',
    'anthropic-ratelimit-unified-representative-claim',
    'anthropic-ratelimit-unified-fallback-percentage',
    'anthropic-ratelimit-five-hour-limit',
    'anthropic-ratelimit-five-hour-remaining',
    'anthropic-ratelimit-seven-day-limit',
    'anthropic-ratelimit-seven-day-remaining',
    'anthropic-ratelimit-tier',
    'anthropic-ratelimit-organization-id',
    'request-id',
    'x-request-id',
    'x-anthropic-organization-uuid',
  ]
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = firstHeader(headers, key)
    if (value) out[key] = value.slice(0, 256)
  }
  return out
}

function firstHeader(headers: Record<string, string | string[] | undefined>, key: string): string | null {
  const raw = headers[key] ?? headers[key.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function shuffle<T>(items: T[]): T[] {
  const next = [...items]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i)
    ;[next[i], next[j]] = [next[j], next[i]]
  }
  return next
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(Math.min(min, max))
  const high = Math.floor(Math.max(min, max))
  return Math.floor(Math.random() * (high - low + 1)) + low
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
