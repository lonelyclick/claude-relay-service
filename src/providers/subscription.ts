import type { AccountProvider, SubscriptionType } from '../types.js'

type SubscriptionHeuristics = {
  predictedBurn5h: number
  predictedBurn7d: number
  sessionBudgetCap: number
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

export function deriveClaudeSubscriptionType(
  organizationType: string | null | undefined,
): SubscriptionType {
  switch (normalize(organizationType)) {
    case 'claude_max':
      return 'max'
    case 'claude_max_100':
    case 'max100':
      return 'max100'
    case 'claude_max_200':
    case 'max200':
      return 'max200'
    case 'claude_pro':
      return 'pro'
    case 'claude_team':
      return 'team'
    case 'claude_enterprise':
      return 'enterprise'
    default:
      return null
  }
}

export function deriveOpenAICodexSubscriptionType(
  planType: string | null | undefined,
  fallback: SubscriptionType,
): SubscriptionType {
  switch (normalize(planType)) {
    case 'free':
      return 'free'
    case 'go':
      return 'go'
    case 'plus':
      return 'plus'
    case 'pro':
      return 'pro'
    case 'pro100':
      return 'pro100'
    case 'pro200':
      return 'pro200'
    case 'team':
      return 'team'
    case 'business':
      return 'business'
    case 'enterprise':
      return 'enterprise'
    case 'edu':
      return 'edu'
    default:
      return fallback
  }
}

export function getSubscriptionHeuristics(
  provider: AccountProvider,
  subscriptionType: SubscriptionType,
): SubscriptionHeuristics {
  if (provider === 'openai-codex') {
    return getOpenAICodexSubscriptionHeuristics(subscriptionType)
  }
  return getClaudeCompatibleSubscriptionHeuristics(subscriptionType)
}

export function getDefaultPlanMultiplier(
  provider: AccountProvider,
  planType: string | null | undefined,
  subscriptionType: SubscriptionType,
): number {
  const normalized = normalize(planType ?? subscriptionType)
  if (provider === 'openai-codex') {
    switch (normalized) {
      case 'free':
      case 'go':
        return 0.5
      case 'plus':
        return 1
      case 'pro':
      case 'pro100':
        return 3
      case 'pro200':
        return 6
      case 'team':
      case 'business':
        return 5
      case 'enterprise':
      case 'edu':
        return 8
      default:
        return 1
    }
  }
  switch (normalized) {
    case 'pro':
    case 'claude_pro':
      return 1
    case 'max100':
    case 'claude_max_100':
      return 5
    case 'max200':
    case 'claude_max_200':
      return 10
    case 'max':
    case 'claude_max':
      return 5
    case 'team':
      return 3
    case 'enterprise':
      return 8
    default:
      return 1
  }
}

function getClaudeCompatibleSubscriptionHeuristics(
  subscriptionType: SubscriptionType,
): SubscriptionHeuristics {
  switch (subscriptionType) {
    case 'pro':
      return { predictedBurn5h: 0.12, predictedBurn7d: 0.08, sessionBudgetCap: 0.25 }
    case 'max100':
      return { predictedBurn5h: 0.06, predictedBurn7d: 0.035, sessionBudgetCap: 0.4 }
    case 'max200':
      return { predictedBurn5h: 0.04, predictedBurn7d: 0.025, sessionBudgetCap: 0.55 }
    case 'team':
      return { predictedBurn5h: 0.05, predictedBurn7d: 0.03, sessionBudgetCap: 0.45 }
    case 'enterprise':
      return { predictedBurn5h: 0.04, predictedBurn7d: 0.02, sessionBudgetCap: 0.55 }
    case 'max':
    default:
      return { predictedBurn5h: 0.06, predictedBurn7d: 0.035, sessionBudgetCap: 0.4 }
  }
}

// Fallback-only heuristics for Codex accounts when no fresher live usage
// snapshot is available. Lower tiers stay intentionally conservative.
function getOpenAICodexSubscriptionHeuristics(
  subscriptionType: SubscriptionType,
): SubscriptionHeuristics {
  switch (subscriptionType) {
    case 'free':
      return { predictedBurn5h: 0.2, predictedBurn7d: 0.14, sessionBudgetCap: 0.12 }
    case 'go':
      return { predictedBurn5h: 0.18, predictedBurn7d: 0.12, sessionBudgetCap: 0.14 }
    case 'plus':
      return { predictedBurn5h: 0.14, predictedBurn7d: 0.1, sessionBudgetCap: 0.18 }
    case 'pro':
    case 'pro100':
      return { predictedBurn5h: 0.1, predictedBurn7d: 0.07, sessionBudgetCap: 0.24 }
    case 'pro200':
      return { predictedBurn5h: 0.07, predictedBurn7d: 0.045, sessionBudgetCap: 0.34 }
    case 'team':
      return { predictedBurn5h: 0.07, predictedBurn7d: 0.05, sessionBudgetCap: 0.32 }
    case 'business':
      return { predictedBurn5h: 0.05, predictedBurn7d: 0.035, sessionBudgetCap: 0.42 }
    case 'edu':
      return { predictedBurn5h: 0.045, predictedBurn7d: 0.03, sessionBudgetCap: 0.48 }
    case 'enterprise':
      return { predictedBurn5h: 0.04, predictedBurn7d: 0.025, sessionBudgetCap: 0.52 }
    default:
      return { predictedBurn5h: 0.12, predictedBurn7d: 0.08, sessionBudgetCap: 0.22 }
  }
}
