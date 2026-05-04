import type { StoredAccount } from '../types.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type ClaudeWarmupStageId =
  | 'new_0_2h'
  | 'new_2_12h'
  | 'new_12_24h'
  | 'new_24_72h'
  | 'new_3_7d'
  | 'new_7_14d'
  | 'new_14_21d'
  | 'new_21_30d'
  | 'month_1_2'
  | 'month_2_3'
  | 'normal_3m_plus'

export type ClaudeWarmupPolicyId = 'a' | 'b' | 'c' | 'd' | 'e'

export interface ClaudeWarmupStage {
  id: ClaudeWarmupStageId
  label: string
  minAgeMs: number
  maxAgeMs: number | null
  rpm: number
  tokensPerMinute: number
  cacheReadPerMinute: number
  singleRequestTokens: number
  cooldownMs: number
  description: string
}

export type ClaudeWarmupDisabledReason = 'manual_disabled' | 'not_claude_official'

export interface ClaudeWarmupStatus {
  enabled: boolean
  disabledReason: ClaudeWarmupDisabledReason | null
  policyId: ClaudeWarmupPolicyId
  policyLabel: string
  stage: ClaudeWarmupStage
  effectiveAgeMs: number | null
  accountAgeMs: number | null
  connectedAgeMs: number | null
  firstSeenAgeMs: number | null
  accountCreatedAt: string | null
  connectedAt: string | null
  firstSeenAt: string | null
  graduated: boolean
}

export const CLAUDE_WARMUP_POLICY_LABELS: Record<ClaudeWarmupPolicyId, string> = {
  a: 'A 默认均衡',
  b: 'B 宽松',
  c: 'C 最宽松',
  d: 'D 超宽松',
  e: 'E 灾难保护',
}

export const CLAUDE_WARMUP_STAGES: ClaudeWarmupStage[] = [
  {
    id: 'new_0_2h',
    label: '0-2h 极敏感冷启动',
    minAgeMs: 0,
    maxAgeMs: 2 * HOUR_MS,
    rpm: 6,
    tokensPerMinute: 1_800_000,
    cacheReadPerMinute: 1_500_000,
    singleRequestTokens: 450_000,
    cooldownMs: 45 * 60 * 1000,
    description: '刚接入/刚创建账号，只允许小上下文低频探活，禁止承接老 session 巨型缓存。',
  },
  {
    id: 'new_2_12h',
    label: '2-12h 早期冷启动',
    minAgeMs: 2 * HOUR_MS,
    maxAgeMs: 12 * HOUR_MS,
    rpm: 8,
    tokensPerMinute: 2_400_000,
    cacheReadPerMinute: 2_000_000,
    singleRequestTokens: 500_000,
    cooldownMs: 40 * 60 * 1000,
    description: '允许少量真实交互，仍避免长上下文连续 cache read。',
  },
  {
    id: 'new_12_24h',
    label: '12-24h 冷启动观察',
    minAgeMs: 12 * HOUR_MS,
    maxAgeMs: 24 * HOUR_MS,
    rpm: 10,
    tokensPerMinute: 3_000_000,
    cacheReadPerMinute: 2_500_000,
    singleRequestTokens: 600_000,
    cooldownMs: 35 * 60 * 1000,
    description: '开始承接中等上下文，但仍对突发分钟桶敏感。',
  },
  {
    id: 'new_24_72h',
    label: '24-72h 敏感观察',
    minAgeMs: 24 * HOUR_MS,
    maxAgeMs: 72 * HOUR_MS,
    rpm: 14,
    tokensPerMinute: 4_000_000,
    cacheReadPerMinute: 3_300_000,
    singleRequestTokens: 750_000,
    cooldownMs: 30 * 60 * 1000,
    description: '72 小时内仍是最高风险窗口，逐步放开但不允许密集大缓存。',
  },
  {
    id: 'new_3_7d',
    label: '3-7d 新号稳定期',
    minAgeMs: 3 * DAY_MS,
    maxAgeMs: 7 * DAY_MS,
    rpm: 18,
    tokensPerMinute: 5_000_000,
    cacheReadPerMinute: 4_200_000,
    singleRequestTokens: 900_000,
    cooldownMs: 25 * 60 * 1000,
    description: '通过前三天后放开常规中长上下文，继续抑制尖峰。',
  },
  {
    id: 'new_7_14d',
    label: '1-2周 新号放量期',
    minAgeMs: 7 * DAY_MS,
    maxAgeMs: 14 * DAY_MS,
    rpm: 24,
    tokensPerMinute: 6_500_000,
    cacheReadPerMinute: 5_500_000,
    singleRequestTokens: 1_100_000,
    cooldownMs: 20 * 60 * 1000,
    description: '允许较长上下文和正常工作流，但高 cache read 仍需刹车。',
  },
  {
    id: 'new_14_21d',
    label: '2-3周 新号扩容期',
    minAgeMs: 14 * DAY_MS,
    maxAgeMs: 21 * DAY_MS,
    rpm: 32,
    tokensPerMinute: 8_000_000,
    cacheReadPerMinute: 6_800_000,
    singleRequestTokens: 1_300_000,
    cooldownMs: 15 * 60 * 1000,
    description: '接近正常使用，但仍保留对异常尖峰的自动降速。',
  },
  {
    id: 'new_21_30d',
    label: '3-4周 新号毕业前',
    minAgeMs: 21 * DAY_MS,
    maxAgeMs: 30 * DAY_MS,
    rpm: 42,
    tokensPerMinute: 10_000_000,
    cacheReadPerMinute: 8_500_000,
    singleRequestTokens: 1_600_000,
    cooldownMs: 12 * 60 * 1000,
    description: '新号最后观察阶段，限制基本只针对明显异常。',
  },
  {
    id: 'month_1_2',
    label: '1-2个月 满月号',
    minAgeMs: 30 * DAY_MS,
    maxAgeMs: 60 * DAY_MS,
    rpm: 60,
    tokensPerMinute: 14_000_000,
    cacheReadPerMinute: 12_000_000,
    singleRequestTokens: 2_000_000,
    cooldownMs: 8 * 60 * 1000,
    description: '满月号基本可承接常规流量，仅限制极端分钟尖峰。',
  },
  {
    id: 'month_2_3',
    label: '2-3个月 成熟观察',
    minAgeMs: 60 * DAY_MS,
    maxAgeMs: 90 * DAY_MS,
    rpm: 90,
    tokensPerMinute: 20_000_000,
    cacheReadPerMinute: 18_000_000,
    singleRequestTokens: 3_000_000,
    cooldownMs: 5 * 60 * 1000,
    description: '接近正常账号，仅保留灾难级保护阈值。',
  },
  {
    id: 'normal_3m_plus',
    label: '3个月+ 正常账号',
    minAgeMs: 90 * DAY_MS,
    maxAgeMs: null,
    rpm: Number.MAX_SAFE_INTEGER,
    tokensPerMinute: Number.MAX_SAFE_INTEGER,
    cacheReadPerMinute: Number.MAX_SAFE_INTEGER,
    singleRequestTokens: Number.MAX_SAFE_INTEGER,
    cooldownMs: 0,
    description: '对标正常账号，warmup 限制完全放开，仅保留其他全局风控。',
  },
]


function scaleWarmupStage(stage: ClaudeWarmupStage, policyId: ClaudeWarmupPolicyId): ClaudeWarmupStage {
  if (stage.id === 'normal_3m_plus' || policyId === 'a') return stage
  const factor = policyId === 'b'
    ? { rpm: 1.5, tokens: 1.6, cache: 1.6, single: 1.5, cooldown: 0.75 }
    : policyId === 'c'
      ? { rpm: 2, tokens: 2.5, cache: 2.5, single: 2, cooldown: 0.5 }
      : policyId === 'd'
        ? { rpm: 3, tokens: 4, cache: 4, single: 3, cooldown: 0.33 }
        : { rpm: 5, tokens: 8, cache: 8, single: 5, cooldown: 0.2 }
  const scaleLimit = (value: number, multiplier: number): number => {
    if (!Number.isFinite(value) || value >= Number.MAX_SAFE_INTEGER) return value
    return Math.ceil((value * multiplier) / 100_000) * 100_000
  }
  const scaleRpm = (value: number): number => {
    if (!Number.isFinite(value) || value >= Number.MAX_SAFE_INTEGER) return value
    return Math.ceil(value * factor.rpm)
  }
  return {
    ...stage,
    rpm: scaleRpm(stage.rpm),
    tokensPerMinute: scaleLimit(stage.tokensPerMinute, factor.tokens),
    cacheReadPerMinute: scaleLimit(stage.cacheReadPerMinute, factor.cache),
    singleRequestTokens: scaleLimit(stage.singleRequestTokens, factor.single),
    cooldownMs: Math.max(60_000, Math.round(stage.cooldownMs * factor.cooldown)),
    description: `${stage.description}（${CLAUDE_WARMUP_POLICY_LABELS[policyId]}）`,
  }
}

export function normalizeClaudeWarmupPolicyId(value: unknown): ClaudeWarmupPolicyId {
  return value === 'b' || value === 'c' || value === 'd' || value === 'e' ? value : 'a'
}

export function resolveClaudeWarmupAccountSwitchLimit(baseLimit: number, policyId: ClaudeWarmupPolicyId): number {
  const safeBase = Number.isFinite(baseLimit) && baseLimit > 0 ? Math.ceil(baseLimit) : 3
  const multiplier = policyId === 'a' ? 1 : policyId === 'b' ? 2 : policyId === 'c' ? 3 : policyId === 'd' ? 4 : 5
  return Math.max(safeBase, safeBase * multiplier)
}

export function resolveClaudeWarmupStage(ageMs: number | null, policyId: ClaudeWarmupPolicyId = 'a'): ClaudeWarmupStage {
  const baseStage = ageMs == null || !Number.isFinite(ageMs) || ageMs < 0
    ? CLAUDE_WARMUP_STAGES[0]
    : CLAUDE_WARMUP_STAGES.find((stage) => ageMs >= stage.minAgeMs && (stage.maxAgeMs == null || ageMs < stage.maxAgeMs)) ?? CLAUDE_WARMUP_STAGES[CLAUDE_WARMUP_STAGES.length - 1]
  return scaleWarmupStage(baseStage, policyId)
}

export function resolveClaudeWarmupStatus(input: {
  account: Pick<StoredAccount, 'createdAt' | 'accountCreatedAt' | 'provider' | 'warmupEnabled' | 'warmupPolicyId'>
  firstSeenAt?: string | null
  now?: number
}): ClaudeWarmupStatus {
  const now = input.now ?? Date.now()
  const parseAge = (value: string | null | undefined): number | null => {
    if (!value) return null
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > now) return null
    return now - parsed
  }
  const accountAgeMs = parseAge(input.account.accountCreatedAt)
  const connectedAgeMs = parseAge(input.account.createdAt)
  const firstSeenAgeMs = parseAge(input.firstSeenAt)
  const candidates = [accountAgeMs, connectedAgeMs, firstSeenAgeMs].filter((value): value is number => value != null)
  const effectiveAgeMs = candidates.length > 0 ? Math.min(...candidates) : null
  const policyId = normalizeClaudeWarmupPolicyId(input.account.warmupPolicyId)
  const stage = resolveClaudeWarmupStage(effectiveAgeMs, policyId)
  const isClaudeOfficial = input.account.provider === 'claude-official'
  const manuallyDisabled = input.account.warmupEnabled === false
  return {
    enabled: isClaudeOfficial && !manuallyDisabled && stage.id !== 'normal_3m_plus',
    disabledReason: !isClaudeOfficial ? 'not_claude_official' : manuallyDisabled ? 'manual_disabled' : null,
    policyId,
    policyLabel: CLAUDE_WARMUP_POLICY_LABELS[policyId],
    stage,
    effectiveAgeMs,
    accountAgeMs,
    connectedAgeMs,
    firstSeenAgeMs,
    accountCreatedAt: input.account.accountCreatedAt ?? null,
    connectedAt: input.account.createdAt ?? null,
    firstSeenAt: input.firstSeenAt ?? null,
    graduated: stage.id === 'normal_3m_plus',
  }
}
