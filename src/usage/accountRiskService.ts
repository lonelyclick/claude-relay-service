import crypto from 'node:crypto'
import pg from 'pg'

import { resolveClaudeWarmupStage } from './claudeWarmupPolicy.js'
import type {
  AccountRiskBand,
  AccountRiskFactor,
  AccountRiskRecommendedAction,
  AccountRiskSnapshot,
  AccountRiskStore,
} from './accountRiskStore.js'
import type { StoredAccount } from '../types.js'

type RawUsageSignal = {
  accountId: string
  firstUseAt: string | null
  lastUseAt: string | null
  requestCount24h: number
  requestCount1h: number
  tokenCount1h: number
  cacheRead1h: number
  rpmPeak1h: number
  tokenPeak1h: number
  cacheReadPeak1h: number
  distinctUsers24h: number
  distinctDevices24h: number
  sessionSwitches24h: number
  multiAccountSessions24h: number
  bodyP90Bytes: number
  toolCountP90: number
  externalSdkRatio24h: number
  directBrowserAccessRatio24h: number
  sleepingGapHours24h: number
  orgLevelAllowedEvents24h: number
  allowedWarningEvents24h: number
  rejectedEvents24h: number
  policyDisabledEvents24h: number
  fallbackBelowOneEvents24h: number
  sevenDayClaimEvents24h: number
  highUtilizationEvents24h: number
  revokedEvents24h: number
  localGuardrailEvents24h: number
  cooldownEvents7d: number
  successCount1h: number
  errorCount1h: number
  lastCriticalAt: string | null
}

type OrgSiblingSignal = {
  organizationUuid: string
  criticalSiblingCount: number
  orgLevelSiblingCount: number
}

export type AccountRiskScoreOptions = {
  persist?: boolean
  now?: Date
  limit?: number
}

const HALF_LIFE_MS = 24 * 60 * 60 * 1000

export class AccountRiskService {
  private readonly pool: pg.Pool

  constructor(
    connectionString: string,
    private readonly riskStore: AccountRiskStore,
  ) {
    this.pool = new pg.Pool({ connectionString, max: 3 })
  }

  async scoreAccounts(accounts: StoredAccount[], options: AccountRiskScoreOptions = {}): Promise<AccountRiskSnapshot[]> {
    const now = options.now ?? new Date()
    const claudeAccounts = accounts.filter((account) => account.provider === 'claude-official')
    if (claudeAccounts.length === 0) return []

    const accountIds = claudeAccounts.map((account) => account.id)
    const usageSignals = await this.loadUsageSignals(accountIds, now)
    const siblingSignals = await this.loadOrgSiblingSignals(now)
    const snapshots = claudeAccounts.map((account) => this.scoreAccount({
      account,
      usage: usageSignals.get(account.id) ?? null,
      sibling: account.organizationUuid ? siblingSignals.get(account.organizationUuid) ?? null : null,
      now,
    }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(options.limit ?? claudeAccounts.length, claudeAccounts.length)))

    if (options.persist) {
      for (const snapshot of snapshots) {
        await this.riskStore.insertSnapshot(snapshot)
      }
      await this.cacheSnapshots(snapshots)
    }
    return snapshots
  }

  async scoreAccountNow(account: StoredAccount, options: { now?: Date; persist?: boolean } = {}): Promise<AccountRiskSnapshot> {
    const now = options.now ?? new Date()
    const usage = (await this.loadUsageSignals([account.id], now)).get(account.id) ?? null
    const siblings = await this.loadOrgSiblingSignals(now)
    const snapshot = this.scoreAccount({
      account,
      usage,
      sibling: account.organizationUuid ? siblings.get(account.organizationUuid) ?? null : null,
      now,
    })
    if (options.persist) {
      await this.riskStore.insertSnapshot(snapshot)
      await this.cacheSnapshots([snapshot])
    }
    return snapshot
  }

  private scoreAccount(input: {
    account: StoredAccount
    usage: RawUsageSignal | null
    sibling: OrgSiblingSignal | null
    now: Date
  }): AccountRiskSnapshot {
    const { account, usage, sibling, now } = input
    const factors: AccountRiskFactor[] = []
    const scoredAt = now.toISOString()
    const stageFactor = this.resolveStageFactor(account, now)
    const decay = usage?.lastUseAt ? decayMultiplier(Date.parse(usage.lastUseAt), now.getTime()) : 0.6

    this.addUpstreamFactors(factors, usage, decay)
    this.addBehaviorFactors(factors, usage, stageFactor, decay)
    this.addIdentityFactors(factors, account, usage, now)
    this.addSiblingFactors(factors, sibling)
    this.addLocalErrorFactors(factors, usage, decay)
    const floorScore = this.resolveFloorScore(account, usage, sibling)
    if (floorScore > 0) {
      factors.push({
        code: 'floor_score_anchor',
        category: 'floor',
        weight: floorScore,
        rawValue: floorScore,
        contribution: floorScore,
        description: '历史 critical / high 信号形成最低风险锚点，recovery 不会洗到 0。',
      })
    }
    this.addRecoveryFactors(factors, account, usage, now)

    const rawScore = factors.reduce((sum, factor) => sum + factor.contribution, 0)
    const score = clampScore(Math.max(floorScore, rawScore))
    const band = bandForScore(score)
    const recommendedActions = recommendedActionsFor(score, factors)
    const shadow = {
      wouldAvoidNewSessions: score >= 55,
      wouldDeprioritize: score >= 30,
      reason: score >= 55
        ? 'shadow: high score account would not receive new sessions'
        : score >= 30
          ? 'shadow: watch score account would be deprioritized'
          : null,
    }
    if (shadow.wouldAvoidNewSessions || shadow.wouldDeprioritize) {
      factors.push({
        code: 'shadow_scheduler_action',
        category: 'shadow',
        weight: 0,
        rawValue: shadow,
        contribution: 0,
        description: 'P1-shadow only：仅记录如果启用调度降权会发生什么，不改变真实调度。',
      })
    }

    return {
      accountId: account.id,
      scoredAt,
      score,
      band,
      floorScore,
      factors: factors
        .filter((factor) => Math.abs(factor.contribution) > 0 || factor.category === 'shadow')
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
      recommendedActions,
      shadow,
    }
  }

  private addUpstreamFactors(factors: AccountRiskFactor[], usage: RawUsageSignal | null, decay: number): void {
    if (!usage) return
    addEventFactor(factors, 'upstream_org_level_allowed', 'upstream', usage.orgLevelAllowedEvents24h, 3, decay, 'org_level_disabled + allowed：仅记录的 Anthropic 侧信息信号。')
    addEventFactor(factors, 'upstream_allowed_warning', 'upstream', usage.allowedWarningEvents24h, 20, decay, 'Anthropic unified-status=allowed_warning。')
    addEventFactor(factors, 'upstream_rejected', 'upstream', usage.rejectedEvents24h, 35, decay, 'Anthropic unified-status=rejected 或 HTTP 429。')
    addEventFactor(factors, 'upstream_policy_disabled', 'upstream', usage.policyDisabledEvents24h, 60, decay, 'Anthropic policy_disabled，高危信号。')
    addEventFactor(factors, 'upstream_seven_day_claim', 'upstream', usage.sevenDayClaimEvents24h, 10, decay, 'representative-claim=seven_day，比 five_hour 更严重。')
    addEventFactor(factors, 'upstream_fallback_below_one', 'upstream', usage.fallbackBelowOneEvents24h, 10, decay, 'fallback-percentage < 1.0。')
    addEventFactor(factors, 'upstream_high_utilization', 'upstream', usage.highUtilizationEvents24h, 15, decay, '5h/7d utilization 峰值持续高于 0.8。')
    addEventFactor(factors, 'upstream_revoked_or_disabled', 'upstream', usage.revokedEvents24h, 80, decay, 'disabled organization / oauth revoked / access revoked。')
  }

  private addBehaviorFactors(factors: AccountRiskFactor[], usage: RawUsageSignal | null, stageFactor: number, decay: number): void {
    if (!usage) return
    if (usage.orgLevelAllowedEvents24h > 0 && usage.cacheReadPeak1h >= 1_000_000) {
      factors.push({
        code: 'combo_org_level_heavy_cache_read',
        category: 'behavior',
        weight: 18,
        rawValue: { orgLevelEvents24h: usage.orgLevelAllowedEvents24h, cacheReadPeak1h: usage.cacheReadPeak1h },
        contribution: round(18 * stageFactor * decay),
        description: 'org_level_disabled 单独不拦；叠加分钟级 heavy cache_read 才提高风险。',
      })
    }
    if (usage.orgLevelAllowedEvents24h > 0 && usage.tokenPeak1h >= 1_500_000) {
      factors.push({
        code: 'combo_org_level_heavy_tokens',
        category: 'behavior',
        weight: 12,
        rawValue: { orgLevelEvents24h: usage.orgLevelAllowedEvents24h, tokenPeak1h: usage.tokenPeak1h },
        contribution: round(12 * stageFactor * decay),
        description: 'org_level_disabled 叠加短窗口 token 尖峰，作为组合风险而非单独红牌。',
      })
    }
    addThresholdFactor(factors, 'behavior_distinct_users_24h', 'behavior', usage.distinctUsers24h, 1, 15, decay, '24h 内多个 user 使用同一 Claude 官方账号，池化信号。')
    addThresholdFactor(factors, 'behavior_session_cross_account', 'behavior', usage.multiAccountSessions24h, 1, 20, decay, '同一 session 跨多个 Claude 官方账号。')
    addThresholdFactor(factors, 'behavior_session_switches', 'behavior', usage.sessionSwitches24h, 1, 15, decay, '同一 session 发生账号切换。')
    addThresholdFactor(factors, 'behavior_first_hour_cache_read', 'behavior', usage.cacheRead1h, 300_000, 18 * stageFactor, decay, '近 1h cache_read 高，按 warmup 阶段放大/缩小。')
    addThresholdFactor(factors, 'behavior_rpm_peak', 'warmup', usage.rpmPeak1h, 8, 12 * stageFactor, decay, '峰值分钟 RPM 超 warmup 阈值。')
    addThresholdFactor(factors, 'behavior_token_peak', 'warmup', usage.tokenPeak1h, 1_500_000, 15 * stageFactor, decay, '峰值分钟 tokens 超 warmup 阈值。')
    addThresholdFactor(factors, 'behavior_cache_read_peak', 'warmup', usage.cacheReadPeak1h, 1_200_000, 15 * stageFactor, decay, '峰值分钟 cache_read 超 warmup 阈值。')
    addThresholdFactor(factors, 'behavior_body_p90_large', 'behavior', usage.bodyP90Bytes, 80_000, 8, decay, '单请求 body p90 偏大。')
    addThresholdFactor(factors, 'behavior_tool_count_p90', 'behavior', usage.toolCountP90, 20, 6, decay, 'toolCount p90 偏高。')
    addRatioFactor(factors, 'behavior_external_sdk_ratio', 'behavior', usage.externalSdkRatio24h, 0.8, 8, decay, 'UA 中 external/sdk-ts 占比偏高。')
    addRatioFactor(factors, 'behavior_direct_browser_access_ratio', 'behavior', usage.directBrowserAccessRatio24h, 0.9, 5, decay, 'dangerous-direct-browser-access=true 占比高，低权重观察。')
    if (usage.requestCount24h >= 10 && usage.sleepingGapHours24h < 4) {
      factors.push({
        code: 'behavior_no_sleep_gap',
        category: 'behavior',
        weight: 6,
        rawValue: usage.sleepingGapHours24h,
        contribution: round(6 * decay),
        description: '24h 流量缺少明显睡眠间隔，低权重人味信号。',
      })
    }
  }

  private addIdentityFactors(factors: AccountRiskFactor[], account: StoredAccount, usage: RawUsageSignal | null, now: Date): void {
    const accountAgeMs = ageMs(account.accountCreatedAt ?? account.createdAt, now)
    if (accountAgeMs != null) {
      const hours = accountAgeMs / 3_600_000
      if (hours < 24) addStatic(factors, 'identity_account_age_lt_24h', 12, `${round(hours)}h`, '账号年龄 <24h。')
      else if (hours < 72) addStatic(factors, 'identity_account_age_lt_72h', 7, `${round(hours)}h`, '账号年龄 <72h。')
    }
    const subscriptionGapMs = gapMs(account.accountCreatedAt, account.subscriptionCreatedAt)
    if (subscriptionGapMs != null && subscriptionGapMs >= 0 && subscriptionGapMs < 10 * 60 * 1000) {
      addStatic(factors, 'identity_subscription_gap_short', 8, `${Math.round(subscriptionGapMs / 60_000)}m`, '订阅创建距账号创建很近，自动化注册先验。')
    }
    const firstUseGapMs = gapMs(account.createdAt, usage?.firstUseAt ?? null)
    if (firstUseGapMs != null && firstUseGapMs >= 0 && firstUseGapMs < 5 * 60 * 1000) {
      addStatic(factors, 'identity_fast_first_use', 8, `${Math.round(firstUseGapMs / 1000)}s`, '接入后 <5min 即首请求。')
    }
    const emailDomain = emailDomainType(account.emailAddress)
    if (emailDomain === 'disposable') addStatic(factors, 'identity_email_disposable', 12, hashValue(account.emailAddress), '临时邮箱域，高风险静态先验。')
    else if (emailDomain === 'gmail') addStatic(factors, 'identity_email_gmail', 3, 'gmail', 'Gmail 账号，低权重静态先验。')
    if (account.hasExtraUsageEnabled === false) addStatic(factors, 'identity_no_extra_usage', 5, false, 'has_extra_usage_enabled=false。')
    if (account.billingType === 'stripe_subscription') addStatic(factors, 'identity_stripe_subscription', 3, 'stripe_subscription', 'billing_type=stripe_subscription，低权重观察。')
    if (String(account.providerPlanTypeRaw ?? account.subscriptionType ?? '').toLowerCase().includes('team')) {
      addStatic(factors, 'identity_team_plan', 4, account.providerPlanTypeRaw ?? account.subscriptionType, 'team 计划静态观察信号。')
    }
  }

  private addSiblingFactors(factors: AccountRiskFactor[], sibling: OrgSiblingSignal | null): void {
    if (!sibling) return
    if (sibling.criticalSiblingCount > 0) {
      factors.push({
        code: 'sibling_org_critical_history',
        category: 'sibling',
        weight: 45,
        rawValue: { organizationUuid: sibling.organizationUuid, criticalSiblingCount: sibling.criticalSiblingCount },
        contribution: 45,
        description: '同 organizationUuid 下出现过 revoked / policy_disabled / disabled organization。',
      })
    } else if (sibling.orgLevelSiblingCount > 0) {
      factors.push({
        code: 'sibling_org_level_disabled_history',
        category: 'sibling',
        weight: 8,
        rawValue: { organizationUuid: sibling.organizationUuid, orgLevelSiblingCount: sibling.orgLevelSiblingCount },
        contribution: 8,
        description: '同 organizationUuid 下出现过 org_level_disabled，但仅轻度连坐。',
      })
    }
  }

  private addLocalErrorFactors(factors: AccountRiskFactor[], usage: RawUsageSignal | null, decay: number): void {
    if (!usage) return
    addEventFactor(factors, 'local_guardrail_hits', 'local_error', usage.localGuardrailEvents24h, 15, decay, '本地 risk_guardrail 命中。')
    addEventFactor(factors, 'local_cooldown_frequency', 'local_error', usage.cooldownEvents7d, 10, decay, '账号近期进入 cooldown / auto_blocked 频率。')
  }

  private addRecoveryFactors(factors: AccountRiskFactor[], account: StoredAccount, usage: RawUsageSignal | null, now: Date): void {
    if (usage && usage.successCount1h > 0 && usage.errorCount1h === 0) {
      factors.push({ code: 'recovery_recent_success_1h', category: 'recovery', weight: -10, rawValue: usage.successCount1h, contribution: -10, description: '最近 1h 全成功，动态降分。' })
    }
    const accountAge = ageMs(account.accountCreatedAt ?? account.createdAt, now)
    if (accountAge != null && accountAge > 7 * 24 * 60 * 60 * 1000 && (!usage || usage.rejectedEvents24h === 0)) {
      factors.push({ code: 'recovery_mature_no_rejected', category: 'recovery', weight: -10, rawValue: `${Math.floor(accountAge / 86_400_000)}d`, contribution: -10, description: '成熟账号且 24h 无 rejected。' })
    }
    if (!usage || (usage.revokedEvents24h === 0 && usage.policyDisabledEvents24h === 0 && usage.rejectedEvents24h === 0)) {
      factors.push({ code: 'recovery_no_high_risk_24h', category: 'recovery', weight: -15, rawValue: true, contribution: -15, description: '最近 24h 无高危上游事件。' })
    }
  }

  private resolveFloorScore(account: StoredAccount, usage: RawUsageSignal | null, sibling: OrgSiblingSignal | null): number {
    if (account.status === 'revoked' || account.status === 'banned' || usage?.revokedEvents24h || usage?.policyDisabledEvents24h || sibling?.criticalSiblingCount) return 20
    if (usage?.rejectedEvents24h || account.autoBlockedReason?.startsWith('risk_guardrail:')) return 10
    return 0
  }

  private resolveStageFactor(account: StoredAccount, now: Date): number {
    const age = ageMs(account.accountCreatedAt ?? account.createdAt, now)
    if (age == null) return 1
    const hours = age / 3_600_000
    if (hours < 2) return 1.5
    if (hours < 24) return 1.3
    if (hours < 72) return 1.15
    if (hours > 24 * 7) return 0.7
    return 1
  }

  private async loadUsageSignals(accountIds: string[], now: Date): Promise<Map<string, RawUsageSignal>> {
    const { rows } = await this.pool.query(
      `WITH scoped AS (
         SELECT
           *,
           split_part(target, '?', 1) AS path,
           input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens AS total_tokens,
           COALESCE(response_headers->>'anthropic-ratelimit-unified-status', '') AS unified_status,
           COALESCE(response_headers->>'anthropic-ratelimit-unified-overage-status', '') AS overage_status,
           COALESCE(response_headers->>'anthropic-ratelimit-unified-overage-disabled-reason', '') AS overage_reason,
           COALESCE(response_headers->>'anthropic-ratelimit-unified-representative-claim', '') AS representative_claim,
           NULLIF(response_headers->>'anthropic-ratelimit-unified-fallback-percentage', '')::real AS fallback_percentage,
           GREATEST(
             COALESCE(rate_limit_5h_utilization, 0),
             COALESCE(rate_limit_7d_utilization, 0)
           ) AS utilization,
           lower(coalesce(response_body_preview, '')) AS response_text,
           lower(coalesce(request_headers->>'user-agent', '')) AS user_agent,
           COALESCE(request_headers->>'anthropic-dangerous-direct-browser-access', '') AS direct_browser_access
         FROM usage_records
         WHERE account_id = ANY($1::text[])
           AND created_at >= $2::timestamptz - interval '7 days'
           AND COALESCE(attempt_kind, 'final') = 'final'
       ), recent AS (
         SELECT * FROM scoped WHERE created_at >= $2::timestamptz - interval '24 hours'
       ), minute_rollup AS (
         SELECT account_id, date_trunc('minute', created_at) AS minute,
           COUNT(*)::int AS requests,
           COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
           COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read
         FROM scoped
         WHERE created_at >= $2::timestamptz - interval '1 hour'
         GROUP BY account_id, date_trunc('minute', created_at)
       ), session_rollup AS (
         SELECT session_key, COUNT(DISTINCT account_id)::int AS distinct_accounts
         FROM recent
         WHERE session_key IS NOT NULL
         GROUP BY session_key
       ), account_sessions AS (
         SELECT recent.account_id,
           COUNT(DISTINCT recent.session_key) FILTER (WHERE session_rollup.distinct_accounts >= 2)::int AS multi_account_sessions
         FROM recent
         JOIN session_rollup ON session_rollup.session_key = recent.session_key
         GROUP BY recent.account_id
       ), switch_rows AS (
         SELECT account_id,
           LAG(account_id) OVER (PARTITION BY session_key ORDER BY created_at) AS previous_account_id
         FROM recent
         WHERE session_key IS NOT NULL
       ), five_min_events AS (
         SELECT DISTINCT account_id,
           date_trunc('hour', created_at) + floor(date_part('minute', created_at) / 5) * interval '5 minutes' AS bucket,
           CASE
             WHEN overage_reason = 'policy_disabled' THEN 'policy_disabled'
             WHEN unified_status = 'rejected' OR status_code = 429 THEN 'rejected'
             WHEN unified_status = 'allowed_warning' THEN 'allowed_warning'
             WHEN overage_reason = 'org_level_disabled' AND unified_status = 'allowed' THEN 'org_level_allowed'
             WHEN fallback_percentage IS NOT NULL AND fallback_percentage < 1 THEN 'fallback_below_one'
             WHEN representative_claim = 'seven_day' THEN 'seven_day_claim'
             WHEN utilization >= 0.8 THEN 'high_utilization'
             WHEN status_code IN (401, 403) AND (response_text LIKE '%access to claude%' OR response_text LIKE '%disabled organization%' OR response_text LIKE '%organization is disabled%' OR response_text LIKE '%authentication_failed%' OR response_text LIKE '%oauth token has been revoked%') THEN 'revoked'
             WHEN response_text LIKE '%risk_guardrail%' THEN 'local_guardrail'
             ELSE NULL
           END AS event_type
         FROM recent
       )
       SELECT
         scoped.account_id,
         MIN(scoped.created_at) AS first_use_at,
         MAX(scoped.created_at) AS last_use_at,
         COUNT(*) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '24 hours')::int AS request_count_24h,
         COUNT(*) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '1 hour')::int AS request_count_1h,
         COALESCE(SUM(scoped.total_tokens) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '1 hour'), 0)::bigint AS token_count_1h,
         COALESCE(SUM(scoped.cache_read_input_tokens) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '1 hour'), 0)::bigint AS cache_read_1h,
         COALESCE((SELECT MAX(requests) FROM minute_rollup m WHERE m.account_id = scoped.account_id), 0)::int AS rpm_peak_1h,
         COALESCE((SELECT MAX(tokens) FROM minute_rollup m WHERE m.account_id = scoped.account_id), 0)::bigint AS token_peak_1h,
         COALESCE((SELECT MAX(cache_read) FROM minute_rollup m WHERE m.account_id = scoped.account_id), 0)::bigint AS cache_read_peak_1h,
         COUNT(DISTINCT scoped.user_id) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '24 hours')::int AS distinct_users_24h,
         COUNT(DISTINCT scoped.client_device_id) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '24 hours')::int AS distinct_devices_24h,
         COALESCE((SELECT COUNT(*) FROM switch_rows s WHERE s.account_id = scoped.account_id AND s.previous_account_id IS NOT NULL AND s.previous_account_id <> s.account_id), 0)::int AS session_switches_24h,
         COALESCE((SELECT multi_account_sessions FROM account_sessions a WHERE a.account_id = scoped.account_id), 0)::int AS multi_account_sessions_24h,
         COALESCE(percentile_disc(0.9) WITHIN GROUP (ORDER BY octet_length(coalesce(scoped.request_body_preview, ''))) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '24 hours'), 0)::int AS body_p90_bytes,
         0::int AS tool_count_p90,
         COALESCE(AVG(CASE WHEN scoped.user_agent LIKE '%external%' OR scoped.user_agent LIKE '%sdk-ts%' THEN 1 ELSE 0 END) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '24 hours'), 0)::real AS external_sdk_ratio_24h,
         COALESCE(AVG(CASE WHEN lower(scoped.direct_browser_access) = 'true' THEN 1 ELSE 0 END) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '24 hours'), 0)::real AS direct_browser_access_ratio_24h,
         COALESCE(MAX(EXTRACT(EPOCH FROM (scoped.created_at - prev_created_at)) / 3600) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '24 hours'), 0)::real AS sleeping_gap_hours_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'org_level_allowed'), 0)::int AS org_level_allowed_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'allowed_warning'), 0)::int AS allowed_warning_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'rejected'), 0)::int AS rejected_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'policy_disabled'), 0)::int AS policy_disabled_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'fallback_below_one'), 0)::int AS fallback_below_one_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'seven_day_claim'), 0)::int AS seven_day_claim_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'high_utilization'), 0)::int AS high_utilization_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'revoked'), 0)::int AS revoked_events_24h,
         COALESCE((SELECT COUNT(*) FROM five_min_events e WHERE e.account_id = scoped.account_id AND e.event_type = 'local_guardrail'), 0)::int AS local_guardrail_events_24h,
         COUNT(*) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '7 days' AND (scoped.response_text LIKE '%risk_guardrail%' OR scoped.response_text LIKE '%auto_blocked%'))::int AS cooldown_events_7d,
         COUNT(*) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '1 hour' AND scoped.status_code BETWEEN 200 AND 299)::int AS success_count_1h,
         COUNT(*) FILTER (WHERE scoped.created_at >= $2::timestamptz - interval '1 hour' AND scoped.status_code >= 400)::int AS error_count_1h,
         MAX(scoped.created_at) FILTER (WHERE scoped.status_code = 429 OR scoped.unified_status = 'rejected' OR scoped.overage_reason = 'policy_disabled' OR (scoped.status_code IN (401, 403) AND (scoped.response_text LIKE '%access to claude%' OR scoped.response_text LIKE '%disabled organization%' OR scoped.response_text LIKE '%organization is disabled%' OR scoped.response_text LIKE '%authentication_failed%' OR scoped.response_text LIKE '%oauth token has been revoked%'))) AS last_critical_at
       FROM (
         SELECT scoped.*, LAG(created_at) OVER (PARTITION BY account_id ORDER BY created_at) AS prev_created_at
         FROM scoped
       ) scoped
       GROUP BY scoped.account_id`,
      [accountIds, now.toISOString()],
    )
    return new Map(rows.map((row) => [String(row.account_id), mapUsageSignal(row)]))
  }

  private async loadOrgSiblingSignals(now: Date): Promise<Map<string, OrgSiblingSignal>> {
    const { rows } = await this.pool.query(
      `WITH account_org AS (
         SELECT id AS account_id, data->>'organizationUuid' AS organization_uuid
         FROM accounts
         WHERE data->>'provider' = 'claude-official'
           AND NULLIF(data->>'organizationUuid', '') IS NOT NULL
       ), signals AS (
         SELECT
           account_org.organization_uuid,
           usage_records.account_id,
           COUNT(*) FILTER (
             WHERE usage_records.created_at >= $1::timestamptz - interval '30 days'
               AND (
                 usage_records.response_headers->>'anthropic-ratelimit-unified-overage-disabled-reason' = 'policy_disabled'
                 OR usage_records.status_code IN (401, 403)
                 OR lower(coalesce(usage_records.response_body_preview, '')) LIKE '%disabled organization%'
                 OR lower(coalesce(usage_records.response_body_preview, '')) LIKE '%oauth token has been revoked%'
               )
           )::int AS critical_count,
           COUNT(*) FILTER (
             WHERE usage_records.created_at >= $1::timestamptz - interval '30 days'
               AND usage_records.response_headers->>'anthropic-ratelimit-unified-overage-disabled-reason' = 'org_level_disabled'
           )::int AS org_level_count
         FROM account_org
         LEFT JOIN usage_records ON usage_records.account_id = account_org.account_id
         GROUP BY account_org.organization_uuid, usage_records.account_id
       )
       SELECT organization_uuid,
         COUNT(*) FILTER (WHERE critical_count > 0)::int AS critical_sibling_count,
         COUNT(*) FILTER (WHERE critical_count = 0 AND org_level_count > 0)::int AS org_level_sibling_count
       FROM signals
       GROUP BY organization_uuid`,
      [now.toISOString()],
    )
    return new Map(rows.map((row) => [String(row.organization_uuid), {
      organizationUuid: String(row.organization_uuid),
      criticalSiblingCount: Number(row.critical_sibling_count ?? 0),
      orgLevelSiblingCount: Number(row.org_level_sibling_count ?? 0),
    }]))
  }

  private async cacheSnapshots(snapshots: AccountRiskSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      await this.pool.query(
        `UPDATE accounts
         SET data = jsonb_set(
           jsonb_set(
             jsonb_set(data, '{riskScore}', to_jsonb($2::int), true),
             '{riskBand}', to_jsonb($3::text), true
           ),
           '{riskScoreUpdatedAt}', to_jsonb($4::text), true
         ), updated_at = NOW()
         WHERE id = $1`,
        [snapshot.accountId, snapshot.score, snapshot.band, snapshot.scoredAt],
      )
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function addEventFactor(
  factors: AccountRiskFactor[],
  code: string,
  category: AccountRiskFactor['category'],
  count: number,
  weight: number,
  decay: number,
  description: string,
): void {
  if (count <= 0) return
  const contribution = round(weight * Math.min(1, Math.log2(count + 1) / 2) * decay)
  factors.push({ code, category, weight, rawValue: count, contribution, description })
}

function addThresholdFactor(
  factors: AccountRiskFactor[],
  code: string,
  category: AccountRiskFactor['category'],
  value: number,
  threshold: number,
  weight: number,
  decay: number,
  description: string,
): void {
  if (value < threshold) return
  const ratio = Math.min(2, value / threshold)
  factors.push({ code, category, weight: round(weight), rawValue: value, contribution: round(weight * Math.min(1, ratio / 2) * decay), description })
}

function addRatioFactor(
  factors: AccountRiskFactor[],
  code: string,
  category: AccountRiskFactor['category'],
  value: number,
  threshold: number,
  weight: number,
  decay: number,
  description: string,
): void {
  if (value < threshold) return
  factors.push({ code, category, weight, rawValue: round(value), contribution: round(weight * decay), description })
}

function addStatic(factors: AccountRiskFactor[], code: string, contribution: number, rawValue: unknown, description: string): void {
  factors.push({ code, category: 'identity', weight: contribution, rawValue, contribution, description })
}

function mapUsageSignal(row: Record<string, unknown>): RawUsageSignal {
  return {
    accountId: String(row.account_id ?? ''),
    firstUseAt: row.first_use_at instanceof Date ? row.first_use_at.toISOString() : row.first_use_at ? String(row.first_use_at) : null,
    lastUseAt: row.last_use_at instanceof Date ? row.last_use_at.toISOString() : row.last_use_at ? String(row.last_use_at) : null,
    requestCount24h: Number(row.request_count_24h ?? 0),
    requestCount1h: Number(row.request_count_1h ?? 0),
    tokenCount1h: Number(row.token_count_1h ?? 0),
    cacheRead1h: Number(row.cache_read_1h ?? 0),
    rpmPeak1h: Number(row.rpm_peak_1h ?? 0),
    tokenPeak1h: Number(row.token_peak_1h ?? 0),
    cacheReadPeak1h: Number(row.cache_read_peak_1h ?? 0),
    distinctUsers24h: Number(row.distinct_users_24h ?? 0),
    distinctDevices24h: Number(row.distinct_devices_24h ?? 0),
    sessionSwitches24h: Number(row.session_switches_24h ?? 0),
    multiAccountSessions24h: Number(row.multi_account_sessions_24h ?? 0),
    bodyP90Bytes: Number(row.body_p90_bytes ?? 0),
    toolCountP90: Number(row.tool_count_p90 ?? 0),
    externalSdkRatio24h: Number(row.external_sdk_ratio_24h ?? 0),
    directBrowserAccessRatio24h: Number(row.direct_browser_access_ratio_24h ?? 0),
    sleepingGapHours24h: Number(row.sleeping_gap_hours_24h ?? 0),
    orgLevelAllowedEvents24h: Number(row.org_level_allowed_events_24h ?? 0),
    allowedWarningEvents24h: Number(row.allowed_warning_events_24h ?? 0),
    rejectedEvents24h: Number(row.rejected_events_24h ?? 0),
    policyDisabledEvents24h: Number(row.policy_disabled_events_24h ?? 0),
    fallbackBelowOneEvents24h: Number(row.fallback_below_one_events_24h ?? 0),
    sevenDayClaimEvents24h: Number(row.seven_day_claim_events_24h ?? 0),
    highUtilizationEvents24h: Number(row.high_utilization_events_24h ?? 0),
    revokedEvents24h: Number(row.revoked_events_24h ?? 0),
    localGuardrailEvents24h: Number(row.local_guardrail_events_24h ?? 0),
    cooldownEvents7d: Number(row.cooldown_events_7d ?? 0),
    successCount1h: Number(row.success_count_1h ?? 0),
    errorCount1h: Number(row.error_count_1h ?? 0),
    lastCriticalAt: row.last_critical_at instanceof Date ? row.last_critical_at.toISOString() : row.last_critical_at ? String(row.last_critical_at) : null,
  }
}

function decayMultiplier(eventTimeMs: number, nowMs: number): number {
  if (!Number.isFinite(eventTimeMs)) return 1
  const ageMsValue = Math.max(0, nowMs - eventTimeMs)
  return Math.max(0.25, Math.pow(0.5, ageMsValue / HALF_LIFE_MS))
}

function bandForScore(score: number): AccountRiskBand {
  if (score >= 75) return 'critical'
  if (score >= 55) return 'cautious'
  if (score >= 30) return 'watch'
  return 'safe'
}

function recommendedActionsFor(score: number, factors: AccountRiskFactor[]): AccountRiskRecommendedAction[] {
  const actions: AccountRiskRecommendedAction[] = []
  if (score >= 30) actions.push({ code: 'shadow_deprioritize', label: 'Shadow 降权', description: '仅记录：如果启用调度降权，该账号会被降低优先级。', shadowOnly: true })
  if (score >= 55) actions.push({ code: 'shadow_no_new_sessions', label: 'Shadow 禁新 session', description: '仅记录：如果启用调度保护，该账号不会承接新 session。', shadowOnly: true })
  if (factors.some((factor) => factor.code.includes('token') || factor.code.includes('cache_read'))) {
    actions.push({ code: 'limit_large_requests', label: '限制大请求', description: '建议人工观察：减少大 token / cache-heavy 请求。', shadowOnly: true })
  }
  if (score >= 75) actions.push({ code: 'manual_review', label: '人工复核', description: 'critical 分档，仅建议人工复核；当前不自动 cooldown。', shadowOnly: true })
  return actions
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function ageMs(value: string | null | undefined, now: Date): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? now.getTime() - parsed : null
}

function gapMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  return Number.isFinite(fromMs) && Number.isFinite(toMs) ? toMs - fromMs : null
}

function emailDomainType(email: string | null): 'disposable' | 'gmail' | 'owned' | 'unknown' {
  const domain = email?.split('@')[1]?.toLowerCase() ?? ''
  if (!domain) return 'unknown'
  if (domain === 'gmail.com') return 'gmail'
  if (domain.endsWith('yohomobile.com') || domain.endsWith('bestesims.com')) return 'owned'
  const disposableHints = ['mail.com', 'moscowmail.com', 'swedenmail.com', 'hotmail.com', 'outlook.com']
  return disposableHints.some((hint) => domain === hint || domain.endsWith(`.${hint}`)) ? 'disposable' : 'unknown'
}

function hashValue(value: string | null): string | null {
  if (!value) return null
  return crypto.createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 12)
}
