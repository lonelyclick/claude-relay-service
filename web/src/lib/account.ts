export function isClaudeProvider(provider: string | null | undefined): boolean {
  return provider === 'claude-official' || provider === 'anthropic'
}

export function needsProxyWarning(input: {
  provider: string | null | undefined
  proxyUrl?: string | null
}): boolean {
  return isClaudeProvider(input.provider) && !input.proxyUrl
}

export function accountPlanLabel(input: {
  providerPlanTypeRaw?: string | null
  subscriptionType?: string | null
}): string | null {
  const raw = input.providerPlanTypeRaw?.trim()
  if (raw) {
    return raw
  }
  const normalized = input.subscriptionType?.trim()
  return normalized || null
}
