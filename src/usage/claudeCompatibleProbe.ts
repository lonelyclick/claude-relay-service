import { randomUUID } from 'node:crypto'
import type { Dispatcher } from 'undici'
import { request } from 'undici'

import { buildClaudeCompatibleUpstreamUrl } from '../providers/claudeCompatible.js'
import type { BodyTemplate } from '../proxy/bodyRewriter.js'
import type { StoredAccount } from '../types.js'

export type ClaudeCompatibleConnectivityStatus =
  | 'ok'
  | 'auth_failed'
  | 'reachable'
  | 'upstream_error'
  | 'connection_failed'
  | 'misconfigured'

export interface ClaudeCompatibleConnectivityResult {
  kind: 'claude-compatible-connectivity'
  status: ClaudeCompatibleConnectivityStatus
  httpStatus: number | null
  durationMs: number
  upstreamModel: string | null
  probedModel: string | null
  errorMessage: string | null
  probedAt: string
}

const PROBE_TIMEOUT_MS = 30_000
const DEFAULT_PROBE_MODEL = 'claude-haiku-4-5'

export async function probeClaudeCompatibleConnectivity(options: {
  account: StoredAccount
  anthropicVersion: string
  proxyDispatcher?: Dispatcher
  bodyTemplate?: BodyTemplate | null
}): Promise<ClaudeCompatibleConnectivityResult> {
  const { account, anthropicVersion, proxyDispatcher, bodyTemplate } = options
  const probedAt = new Date().toISOString()

  const apiBaseUrl = account.apiBaseUrl?.trim()
  if (!apiBaseUrl) {
    return {
      kind: 'claude-compatible-connectivity',
      status: 'misconfigured',
      httpStatus: null,
      durationMs: 0,
      upstreamModel: null,
      probedModel: null,
      errorMessage: 'Account is missing apiBaseUrl',
      probedAt,
    }
  }
  const apiKey = account.accessToken?.trim()
  if (!apiKey) {
    return {
      kind: 'claude-compatible-connectivity',
      status: 'misconfigured',
      httpStatus: null,
      durationMs: 0,
      upstreamModel: null,
      probedModel: null,
      errorMessage: 'Account is missing accessToken/apiKey',
      probedAt,
    }
  }

  // Pick the cheapest model the account is known to support.
  // Priority: explicit haiku tier mapping → account.modelName → DEFAULT_PROBE_MODEL.
  // Falling through to DEFAULT alone produces false negatives when the upstream channel only
  // exposes opus/sonnet (e.g. purecc group with no haiku channel) — see openclaudecode.cn.
  // Normalize dotted model names (e.g. claude-opus-4.7) to dash form (claude-opus-4-7) which
  // is the canonical Anthropic spelling and what most upstreams accept.
  const rawModel =
    account.modelTierMap?.haiku?.trim() ||
    account.modelName?.trim() ||
    DEFAULT_PROBE_MODEL
  const probedModel = normalizeAnthropicModelName(rawModel)

  // Some upstreams (e.g. openclaudecode.cn) strictly validate "real Claude Code" requests:
  // they reject simple bodies with a generic "请使用正确的 Claude Code 客户端" 4xx.
  // When a BODY_TEMPLATE is configured, reuse it to construct a body that matches the shape
  // a real Claude Code CLI sends — same systemBlocks, tools, metadata.user_id, and headers.
  // The template's cache_control: ephemeral keeps repeat probes within a 5-minute window cheap.
  const useTemplate = bodyTemplate != null
  let url: URL
  try {
    url = buildClaudeCompatibleUpstreamUrl(
      account,
      '/v1/messages',
      useTemplate ? '?beta=true' : '',
    )
  } catch (error) {
    return {
      kind: 'claude-compatible-connectivity',
      status: 'misconfigured',
      httpStatus: null,
      durationMs: 0,
      upstreamModel: null,
      probedModel,
      errorMessage: error instanceof Error ? error.message : String(error),
      probedAt,
    }
  }

  const body = useTemplate
    ? buildClaudeCodeProbeBody(bodyTemplate, probedModel)
    : JSON.stringify({
        model: probedModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      })

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': anthropicVersion,
  }
  if (useTemplate) {
    if (bodyTemplate.anthropicBeta) {
      headers['anthropic-beta'] = bodyTemplate.anthropicBeta
    }
    headers['user-agent'] = `claude-cli/${parseCcMajorMinorPatch(bodyTemplate.ccVersion)} (external, ${bodyTemplate.ccEntrypoint ?? 'sdk-cli'})`
    headers['x-app'] = 'cli'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
    headers['accept-language'] = '*'
  }

  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await request(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      dispatcher: proxyDispatcher,
    })
    const durationMs = Date.now() - startedAt
    const httpStatus = response.statusCode

    let raw: string | null = null
    try {
      raw = await response.body.text()
    } catch {
      raw = null
    }

    let upstreamModel: string | null = null
    let errorMessage: string | null = null
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (typeof parsed.model === 'string') upstreamModel = parsed.model
        const errField = parsed.error
        if (errField && typeof errField === 'object' && 'message' in errField) {
          const msg = (errField as { message?: unknown }).message
          if (typeof msg === 'string' && msg.trim()) {
            errorMessage = msg.trim()
          }
        } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
          errorMessage = parsed.message.trim()
        }
      } catch {
        const trimmed = raw.trim()
        if (trimmed) errorMessage = trimmed.slice(0, 500)
      }
    }

    let status: ClaudeCompatibleConnectivityStatus
    if (httpStatus >= 200 && httpStatus < 300) status = 'ok'
    else if (httpStatus === 401 || httpStatus === 403) status = 'auth_failed'
    else if (httpStatus >= 400 && httpStatus < 500) status = 'reachable'
    else status = 'upstream_error'

    return {
      kind: 'claude-compatible-connectivity',
      status,
      httpStatus,
      durationMs,
      upstreamModel,
      probedModel,
      errorMessage,
      probedAt,
    }
  } catch (error) {
    return {
      kind: 'claude-compatible-connectivity',
      status: 'connection_failed',
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      upstreamModel: null,
      probedModel,
      errorMessage: error instanceof Error ? error.message : String(error),
      probedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeAnthropicModelName(name: string): string {
  // claude-opus-4.7 -> claude-opus-4-7. Anthropic publishes dash form; many compatible upstreams
  // (openclaudecode.cn, etc.) reject the dotted form with model_not_found.
  return name.replace(/(\d)\.(\d)/g, '$1-$2')
}

function parseCcMajorMinorPatch(ccVersion: string): string {
  // ccVersion looks like "2.1.112.e61"; the user-agent expects only "2.1.112".
  const match = ccVersion.match(/^\d+\.\d+\.\d+/)
  return match ? match[0] : ccVersion
}

function buildClaudeCodeProbeBody(template: BodyTemplate, model: string): string {
  // system[0] is the billing-header block. Captured form has no cache_control and uses
  // `cch=00000;` (with trailing semicolon). Mirror it exactly — strict upstreams compare
  // byte-for-byte against this signature when validating "is this real Claude Code".
  const headerBlock = {
    type: 'text',
    text: `x-anthropic-billing-header: cc_version=${template.ccVersion}; cc_entrypoint=${template.ccEntrypoint ?? 'sdk-cli'}; cch=00000;`,
  }
  // The last user content block carries cache_control: ephemeral in real CC traffic.
  const lastUserBlock = {
    type: 'text',
    text: 'Hi',
    cache_control: { type: 'ephemeral' as const },
  }
  return JSON.stringify({
    model,
    max_tokens: 1,
    system: [headerBlock, ...template.systemBlocks],
    tools: template.tools,
    metadata: {
      user_id: JSON.stringify({
        device_id: template.deviceId,
        account_uuid: template.accountUuid,
        // session_id is required by strict upstreams (e.g. openclaudecode.cn) — without it
        // they reject the request as "non-Claude Code client". Generated per-probe; does not
        // affect prompt cache hits because cache is keyed on system + tools.
        session_id: randomUUID(),
      }),
    },
    messages: [{ role: 'user', content: [lastUserBlock] }],
    thinking: { type: 'adaptive' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    output_config: { effort: 'xhigh' },
  })
}
