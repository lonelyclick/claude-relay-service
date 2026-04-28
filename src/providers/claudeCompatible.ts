import type { ClaudeModelTier, StoredAccount } from '../types.js'

export function isClaudeCompatibleAccount(account: StoredAccount): boolean {
  return account.provider === 'claude-compatible'
}

export function classifyClaudeModelTier(model: string | undefined | null): ClaudeModelTier | null {
  if (typeof model !== 'string') return null
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  return null
}

export interface ClaudeCompatibleRouteInfo {
  sourceModel: string | null
  targetModel: string
  tierHit: ClaudeModelTier | null
}

export function planClaudeCompatibleModelRouting(
  sourceModel: unknown,
  account: StoredAccount,
): ClaudeCompatibleRouteInfo {
  const source = typeof sourceModel === 'string' ? sourceModel : null
  const tier = classifyClaudeModelTier(source)
  const tierTarget = tier ? account.modelTierMap?.[tier]?.trim() || '' : ''
  if (tierTarget) {
    return { sourceModel: source, targetModel: tierTarget, tierHit: tier }
  }
  const fallback = account.modelName?.trim() || ''
  if (!fallback) {
    throw new Error(`Account ${account.id} is missing modelName`)
  }
  return { sourceModel: source, targetModel: fallback, tierHit: null }
}

export function resolveClaudeCompatibleTargetModel(
  sourceModel: unknown,
  account: StoredAccount,
): string {
  return planClaudeCompatibleModelRouting(sourceModel, account).targetModel
}

export function buildClaudeCompatibleUpstreamUrl(
  account: StoredAccount,
  pathname: string,
  search: string,
): URL {
  const baseUrl = account.apiBaseUrl?.trim()
  if (!baseUrl) {
    throw new Error(`Account ${account.id} is missing apiBaseUrl`)
  }
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const url = new URL(`${normalizedBase}${normalizedPath}`)
  if (search) {
    url.search = search.startsWith('?') ? search.slice(1) : search
  }
  return url
}

export interface ClaudeCompatibleRewriteResult {
  body: Buffer
  routing: ClaudeCompatibleRouteInfo
}

export function rewriteClaudeCompatibleRequestBody(
  body: Buffer | undefined,
  account: StoredAccount,
): ClaudeCompatibleRewriteResult {
  if (!body || body.length === 0) {
    throw new Error('Request body is required')
  }
  let parsed: Record<string, unknown>
  try {
    const decoded = JSON.parse(body.toString('utf8')) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Request body must be a JSON object')
    }
    parsed = decoded as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message === 'Request body must be a JSON object') {
      throw error
    }
    throw new Error('Request body must be valid JSON')
  }
  const routing = planClaudeCompatibleModelRouting(parsed.model, account)
  parsed.model = routing.targetModel
  return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), routing }
}

export function extractClaudeCompatibleErrorMessage(body: Buffer): string {
  if (!body || body.length === 0) {
    return 'Upstream request failed'
  }
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      error?: {
        message?: unknown
      } | null
      message?: unknown
    }
    if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message.trim()
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim()
    }
  } catch {
    // fall through
  }
  const text = body.toString('utf8').trim()
  return text || 'Upstream request failed'
}
