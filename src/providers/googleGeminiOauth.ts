import crypto from 'node:crypto'

import type { Dispatcher } from 'undici'
import { request } from 'undici'

import { appConfig } from '../config.js'
import type { StoredAccount, SubscriptionType } from '../types.js'
import type { RateLimitProbeResult } from '../usage/rateLimitProbe.js'

export const GEMINI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const

export type GeminiUserTier = 'free-tier' | 'standard-tier' | 'legacy-tier'

export type GeminiAccountMetadata = {
  cloudaicompanionProject: string | null
  userTier: GeminiUserTier | null
  emailAddress: string | null
  displayName: string | null
  pictureUrl: string | null
  sub: string | null
}

export function isGeminiOauthAccount(account: StoredAccount): boolean {
  return account.provider === 'google-gemini-oauth'
}

export function deriveGeminiSubscriptionType(
  tier: GeminiUserTier | null | undefined,
): SubscriptionType {
  switch (tier) {
    case 'standard-tier':
    case 'legacy-tier':
      return 'gemini-pro'
    case 'free-tier':
      return 'gemini-free'
    default:
      return 'gemini-free'
  }
}

export function buildGeminiAuthorizeUrl(input: {
  codeChallenge: string
  state: string
  redirectUri: string
}): string {
  const params = new URLSearchParams({
    client_id: appConfig.geminiOauthClientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GEMINI_OAUTH_SCOPES.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  })
  return `${appConfig.geminiOauthAuthorizeUrl}?${params.toString()}`
}

export function parseGeminiCallback(rawUrlOrQuery: string): {
  code: string
  state: string | null
  error: string | null
} {
  const trimmed = rawUrlOrQuery.trim()
  if (!trimmed) {
    throw new Error('callback url is empty')
  }
  let queryString = trimmed
  if (trimmed.startsWith('http')) {
    const url = new URL(trimmed)
    queryString = url.search.slice(1)
  } else if (trimmed.startsWith('?')) {
    queryString = trimmed.slice(1)
  }
  const params = new URLSearchParams(queryString)
  const error = params.get('error')
  const code = params.get('code')
  const state = params.get('state')
  if (!code) {
    throw new Error(error ? `OAuth error: ${error}` : 'callback missing code')
  }
  return { code, state, error }
}

export function getGeminiLoopbackRedirectUri(): string {
  const host = appConfig.geminiOauthLoopbackHost
  const port = appConfig.geminiOauthLoopbackPort
  const path = appConfig.geminiOauthLoopbackRedirectPath.startsWith('/')
    ? appConfig.geminiOauthLoopbackRedirectPath
    : `/${appConfig.geminiOauthLoopbackRedirectPath}`
  return `http://${host}:${port}${path}`
}

export function buildGeminiCodeAssistUrl(method: string): URL {
  const base = appConfig.geminiCodeAssistEndpoint
  const version = appConfig.geminiCodeAssistApiVersion
  return new URL(`/${version}:${method}`, `${base}/`)
}

export function buildGeminiCodeAssistStreamUrl(method: string): URL {
  const url = buildGeminiCodeAssistUrl(method)
  url.searchParams.set('alt', 'sse')
  return url
}

// ──────────────────────────────────────────────────────────────────────────
// Gemini native protocol → Code Assist dispatch
// ──────────────────────────────────────────────────────────────────────────

export type NativeRouteDispatch = {
  upstreamUrl: URL
  upstreamMethod: 'GET' | 'POST'
  upstreamBody: Buffer | null
  isStream: boolean
  untestedAgainstCodeAssist: boolean
}

const KNOWN_GENERATE_METHODS = new Set(['generateContent', 'streamGenerateContent'])
const ENVELOPE_METHODS_WITH_PROMPT_ID = new Set(['generateContent', 'streamGenerateContent'])
const UNTESTED_METHODS = new Set(['countTokens', 'embedContent', 'batchEmbedContents'])

function buildCodeAssistRestUrl(suffix: string): URL {
  const base = appConfig.geminiCodeAssistEndpoint
  const version = appConfig.geminiCodeAssistApiVersion
  return new URL(`/${version}/${suffix.replace(/^\//, '')}`, `${base}/`)
}

export function buildGeminiNativeDispatch(input: {
  pathname: string
  method: string
  rawBody: Buffer | undefined
  account: StoredAccount
  promptId: string
}): NativeRouteDispatch {
  const upperMethod = input.method.toUpperCase()

  if (input.pathname === '/v1beta/models') {
    if (upperMethod !== 'GET') {
      throw new Error(`unsupported method ${input.method} for ${input.pathname}`)
    }
    return {
      upstreamUrl: buildCodeAssistRestUrl('models'),
      upstreamMethod: 'GET',
      upstreamBody: null,
      isStream: false,
      untestedAgainstCodeAssist: true,
    }
  }

  const segMatch = input.pathname.match(/^\/v1beta\/models\/([A-Za-z0-9._\-]+)(?::([A-Za-z]+))?$/)
  if (!segMatch) {
    throw new Error(`unsupported gemini native path: ${input.pathname}`)
  }
  const modelName = segMatch[1]!
  const methodName = segMatch[2] ?? null

  if (!methodName) {
    if (upperMethod !== 'GET') {
      throw new Error(`unsupported method ${input.method} for ${input.pathname}`)
    }
    return {
      upstreamUrl: buildCodeAssistRestUrl(`models/${modelName}`),
      upstreamMethod: 'GET',
      upstreamBody: null,
      isStream: false,
      untestedAgainstCodeAssist: true,
    }
  }

  if (upperMethod !== 'POST') {
    throw new Error(`unsupported method ${input.method} for ${input.pathname}`)
  }

  const isStream = methodName === 'streamGenerateContent'
  const upstreamUrl = isStream
    ? buildGeminiCodeAssistStreamUrl(methodName)
    : buildGeminiCodeAssistUrl(methodName)

  const requestPayload = parseRequestPayload(input.rawBody)
  const envelope: Record<string, unknown> = {
    model: modelName,
    request: requestPayload,
  }
  const projectId = readGeminiProjectId(input.account)
  if (projectId) envelope.project = projectId
  if (ENVELOPE_METHODS_WITH_PROMPT_ID.has(methodName) && input.promptId) {
    envelope.user_prompt_id = input.promptId
  }

  const upstreamBody = Buffer.from(JSON.stringify(envelope), 'utf8')
  return {
    upstreamUrl,
    upstreamMethod: 'POST',
    upstreamBody,
    isStream,
    untestedAgainstCodeAssist:
      !KNOWN_GENERATE_METHODS.has(methodName) || UNTESTED_METHODS.has(methodName),
  }
}

function parseRequestPayload(rawBody: Buffer | undefined): Record<string, unknown> {
  if (!rawBody || rawBody.length === 0) return {}
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  throw new Error('request body must be a JSON object')
}

type GeminiQuotaBucket = {
  remainingFraction?: unknown
  resetTime?: unknown
  tokenType?: unknown
  modelId?: unknown
}

type GeminiQuotaResponse = {
  buckets?: GeminiQuotaBucket[]
}

type GeminiModelUsage = {
  label: string
  modelIds: string[]
  utilization: number | null
  remainingFraction: number | null
  reset: number | null
}

export async function retrieveGeminiUserQuota(options: {
  accessToken: string
  account: StoredAccount
  proxyDispatcher: Dispatcher | undefined
}): Promise<RateLimitProbeResult> {
  const base = buildEmptyGeminiQuotaResult()
  if (!options.accessToken) {
    return { ...base, error: 'no_access_token' }
  }
  const project = readGeminiProjectId(options.account)
  if (!project) {
    return { ...base, error: 'missing_gemini_project' }
  }

  let response: Dispatcher.ResponseData
  try {
    response = await request(buildGeminiCodeAssistUrl('retrieveUserQuota'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        'content-type': 'application/json',
        'user-agent': 'gemini-cli/0.0.0 (claude-oauth-relay)',
      },
      body: JSON.stringify({
        project,
      }),
      dispatcher: options.proxyDispatcher,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ...base, error: `connection_error: ${message}` }
  }

  base.httpStatus = response.statusCode
  const bodyText = await response.body.text().catch(() => '')
  if (response.statusCode === 401 || response.statusCode === 403) {
    base.error = 'token_expired_or_revoked'
    return base
  }
  if (response.statusCode === 429) {
    base.error = 'rate_limited'
    return base
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    base.error = `http_${response.statusCode}`
    return base
  }

  let parsed: GeminiQuotaResponse
  try {
    parsed = JSON.parse(bodyText) as GeminiQuotaResponse
  } catch {
    return { ...base, error: 'invalid_quota_response' }
  }

  const buckets = Array.isArray(parsed.buckets) ? parsed.buckets : []
  const requestBuckets = buckets.filter((bucket) => bucket.tokenType === 'REQUESTS')
  const model = options.account.modelName?.trim() || appConfig.geminiDefaultModel
  const preferredBucket = requestBuckets.find((bucket) => bucket.modelId === model) ?? requestBuckets[0]
  const remainingFraction = readFraction(preferredBucket?.remainingFraction)
  const resetMs = readResetMs(preferredBucket?.resetTime)
  const utilization = remainingFraction == null ? null : clamp01(1 - remainingFraction)
  const status = utilization == null || remainingFraction == null
    ? 'allowed'
    : remainingFraction <= 0
      ? 'throttled'
      : utilization >= 0.8
        ? 'allowed_warning'
        : 'allowed'

  return {
    ...base,
    status,
    reset: resetMs,
    representativeClaim: typeof preferredBucket?.modelId === 'string' ? preferredBucket.modelId : model,
    fallbackPercentage: remainingFraction == null ? null : Math.round(remainingFraction * 100),
    fiveHourStatus: status,
    fiveHourUtilization: utilization,
    fiveHourReset: resetMs,
    modelUsage: buildGeminiModelUsage(requestBuckets),
  }
}

function buildGeminiModelUsage(buckets: GeminiQuotaBucket[]): GeminiModelUsage[] {
  return [
    buildGeminiModelUsageItem('Flash', buckets, (modelId) => /(^|-)flash($|-)/.test(modelId) && !modelId.includes('flash-lite')),
    buildGeminiModelUsageItem('Flash Lite', buckets, (modelId) => modelId.includes('flash-lite')),
    buildGeminiModelUsageItem('Pro', buckets, (modelId) => /(^|-)pro($|-)/.test(modelId)),
  ].filter((item) => item.modelIds.length > 0)
}

function buildGeminiModelUsageItem(
  label: string,
  buckets: GeminiQuotaBucket[],
  predicate: (modelId: string) => boolean,
): GeminiModelUsage {
  const matches = buckets.filter((bucket) => typeof bucket.modelId === 'string' && predicate(bucket.modelId))
  const usageValues = matches.map((bucket) => {
    const remainingFraction = readFraction(bucket.remainingFraction)
    return remainingFraction == null ? null : clamp01(1 - remainingFraction)
  }).filter((value): value is number => value != null)
  const remainingValues = matches.map((bucket) => readFraction(bucket.remainingFraction)).filter((value): value is number => value != null)
  const resetValues = matches.map((bucket) => readResetMs(bucket.resetTime)).filter((value): value is number => value != null)
  return {
    label,
    modelIds: matches.map((bucket) => String(bucket.modelId)),
    utilization: usageValues.length > 0 ? Math.max(...usageValues) : null,
    remainingFraction: remainingValues.length > 0 ? Math.min(...remainingValues) : null,
    reset: resetValues.length > 0 ? Math.max(...resetValues) : null,
  }
}

function buildEmptyGeminiQuotaResult(): RateLimitProbeResult {
  return {
    status: null,
    reset: null,
    representativeClaim: null,
    fallbackPercentage: null,
    fiveHourStatus: null,
    fiveHourUtilization: null,
    fiveHourReset: null,
    sevenDayStatus: null,
    sevenDayUtilization: null,
    sevenDayReset: null,
    sevenDaySurpassedThreshold: null,
    overageStatus: null,
    overageDisabledReason: null,
    overageReset: null,
    httpStatus: 0,
    probedAt: new Date().toISOString(),
    error: null,
    tokenStatus: null,
    refreshAttempted: false,
    refreshSucceeded: false,
    refreshError: null,
  }
}

function readFraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clamp01(value)
}

function readResetMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

// ──────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions → Code Assist Vertex-style request
// Reference: gemini-cli/packages/core/src/code_assist/{server,converter}.ts
// ──────────────────────────────────────────────────────────────────────────

type OpenAIChatMessage = {
  role?: unknown
  content?: unknown
  name?: unknown
  tool_call_id?: unknown
  tool_calls?: unknown
}

type OpenAIChatRequest = {
  model?: unknown
  messages?: unknown
  stream?: unknown
  temperature?: unknown
  top_p?: unknown
  top_k?: unknown
  max_tokens?: unknown
  stop?: unknown
  n?: unknown
  tools?: unknown
  tool_choice?: unknown
  response_format?: unknown
  extra_body?: unknown
  presence_penalty?: unknown
  frequency_penalty?: unknown
  seed?: unknown
  logit_bias?: unknown
  logprobs?: unknown
  top_logprobs?: unknown
}

const UNSUPPORTED_OPENAI_PARAMS = [
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'logit_bias',
  'logprobs',
  'top_logprobs',
] as const

const REMOTE_IMAGE_FETCH_TIMEOUT_MS = 5000
const REMOTE_IMAGE_MAX_BYTES = 4 * 1024 * 1024

type GeminiPart = {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
}

type GeminiContent = {
  role: 'user' | 'model' | 'function'
  parts: GeminiPart[]
}

export type GeminiRequestBuildResult = {
  upstreamBody: Buffer
  stream: boolean
  model: string
}

export async function buildGeminiChatCompletionsRequest(input: {
  rawBody: Buffer
  account: StoredAccount
  promptId?: string
  sessionId?: string
}): Promise<GeminiRequestBuildResult> {
  if (!input.rawBody || input.rawBody.length === 0) {
    throw new Error('Request body is required')
  }
  const parsed = parseJson(input.rawBody) as OpenAIChatRequest
  const messages = Array.isArray(parsed.messages) ? (parsed.messages as OpenAIChatMessage[]) : []
  if (messages.length === 0) {
    throw new Error('messages must be a non-empty array')
  }

  const offending = UNSUPPORTED_OPENAI_PARAMS.filter(
    (k) => (parsed as Record<string, unknown>)[k] !== undefined,
  )
  if (offending.length > 0) {
    throw new Error(`unsupported_parameters: ${offending.join(', ')}`)
  }

  const model = pickModelName(parsed.model, input.account)
  const stream = parsed.stream !== false

  const { systemInstruction, contents } = await convertChatMessages(messages)

  const generationConfig: Record<string, unknown> = {}
  if (typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)) {
    generationConfig.temperature = parsed.temperature
  }
  if (typeof parsed.top_p === 'number' && Number.isFinite(parsed.top_p)) {
    generationConfig.topP = parsed.top_p
  }
  if (typeof parsed.top_k === 'number' && Number.isFinite(parsed.top_k)) {
    generationConfig.topK = parsed.top_k
  }
  if (typeof parsed.max_tokens === 'number' && Number.isFinite(parsed.max_tokens)) {
    generationConfig.maxOutputTokens = parsed.max_tokens
  }
  if (Array.isArray(parsed.stop)) {
    const stops = parsed.stop.filter((s): s is string => typeof s === 'string' && s.length > 0)
    if (stops.length > 0) generationConfig.stopSequences = stops
  } else if (typeof parsed.stop === 'string' && parsed.stop.length > 0) {
    generationConfig.stopSequences = [parsed.stop]
  }
  if (typeof parsed.n === 'number' && parsed.n > 1) {
    generationConfig.candidateCount = Math.floor(parsed.n)
  }
  if (parsed.response_format && typeof parsed.response_format === 'object') {
    const fmt = parsed.response_format as { type?: unknown; json_schema?: unknown }
    if (fmt.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json'
    } else if (fmt.type === 'json_schema' && fmt.json_schema && typeof fmt.json_schema === 'object') {
      const schema = (fmt.json_schema as { schema?: unknown }).schema
      if (schema && typeof schema === 'object') {
        generationConfig.responseMimeType = 'application/json'
        generationConfig.responseSchema = schema
      }
    }
  }

  const requestPayload: Record<string, unknown> = {
    contents,
  }
  if (systemInstruction) {
    requestPayload.systemInstruction = systemInstruction
  }
  if (Object.keys(generationConfig).length > 0) {
    requestPayload.generationConfig = generationConfig
  }
  const { tools, toolConfig } = convertOpenAIToolsAndChoice(parsed.tools, parsed.tool_choice)
  if (tools.length > 0) {
    requestPayload.tools = tools
  }
  if (toolConfig) {
    requestPayload.toolConfig = toolConfig
  }
  const safetySettings = readSafetySettings(parsed.extra_body)
  if (safetySettings) {
    requestPayload.safetySettings = safetySettings
  }

  const envelope: Record<string, unknown> = {
    model,
    request: requestPayload,
  }
  const projectId = readGeminiProjectId(input.account)
  if (projectId) {
    envelope.project = projectId
  }
  if (input.sessionId) {
    ;(requestPayload as Record<string, unknown>).session_id = input.sessionId
  }
  if (input.promptId) {
    envelope.user_prompt_id = input.promptId
  }

  return {
    upstreamBody: Buffer.from(JSON.stringify(envelope), 'utf8'),
    stream,
    model,
  }
}

function readSafetySettings(extraBody: unknown): unknown[] | null {
  if (!extraBody || typeof extraBody !== 'object') return null
  const settings = (extraBody as { safetySettings?: unknown }).safetySettings
  if (!Array.isArray(settings)) return null
  return settings
}

function pickModelName(rawModel: unknown, account: StoredAccount): string {
  const fromBody = typeof rawModel === 'string' ? rawModel.trim() : ''
  const fromAccount = account.modelName?.trim() ?? ''
  return fromBody || fromAccount || appConfig.geminiDefaultModel
}

async function convertChatMessages(messages: OpenAIChatMessage[]): Promise<{
  systemInstruction: GeminiContent | null
  contents: GeminiContent[]
}> {
  const contents: GeminiContent[] = []
  const systemTexts: string[] = []
  const toolCallIdToName = new Map<string, string>()
  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : ''
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
        const id = typeof tc.id === 'string' ? tc.id : null
        const fn = (tc as { function?: { name?: unknown } }).function
        const name = fn && typeof fn.name === 'string' ? fn.name : null
        if (id && name) toolCallIdToName.set(id, name)
      }
    }
  }

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : ''
    if (role === 'system' || role === 'developer') {
      const text = stringifyContent(message.content)
      if (text) systemTexts.push(text)
      continue
    }
    if (role === 'user') {
      const parts = await collectUserParts(message.content)
      if (parts.length > 0) {
        contents.push({ role: 'user', parts })
      }
      continue
    }
    if (role === 'assistant') {
      const parts: GeminiPart[] = []
      const text = stringifyContent(message.content)
      if (text) parts.push({ text })
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
          const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function
          if (fn && typeof fn.name === 'string') {
            const args = parseJsonMaybe(fn.arguments)
            parts.push({
              functionCall: { name: fn.name, args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {} },
            })
          }
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    if (role === 'tool') {
      const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      const fnName = toolCallIdToName.get(toolCallId) ?? (typeof message.name === 'string' ? message.name : 'tool')
      const text = stringifyContent(message.content)
      const responseObj: Record<string, unknown> = { content: text }
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name: fnName, response: responseObj } }],
      })
      continue
    }
  }

  const systemInstruction: GeminiContent | null = systemTexts.length > 0
    ? { role: 'user', parts: [{ text: systemTexts.join('\n\n') }] }
    : null
  return { systemInstruction, contents }
}

async function collectUserParts(rawContent: unknown): Promise<GeminiPart[]> {
  if (typeof rawContent === 'string') {
    return rawContent ? [{ text: rawContent }] : []
  }
  if (!Array.isArray(rawContent)) return []
  const items = rawContent as Array<Record<string, unknown>>
  const fetchPromises: Array<Promise<GeminiPart>> = []
  const ordered: Array<GeminiPart | { __pendingIndex: number }> = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === 'text' && typeof item.text === 'string') {
      ordered.push({ text: item.text })
      continue
    }
    if (type === 'image_url') {
      const imageUrl = item.image_url as { url?: unknown } | undefined
      const url = imageUrl && typeof imageUrl.url === 'string' ? imageUrl.url : ''
      const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/i)
      if (dataUrlMatch) {
        ordered.push({ inlineData: { mimeType: dataUrlMatch[1]!, data: dataUrlMatch[2]! } })
        continue
      }
      if (/^https?:\/\//i.test(url)) {
        const idx = fetchPromises.length
        fetchPromises.push(fetchRemoteImageAsPart(url))
        ordered.push({ __pendingIndex: idx })
        continue
      }
    }
  }
  const fetched = fetchPromises.length > 0 ? await Promise.all(fetchPromises) : []
  const parts: GeminiPart[] = []
  for (const slot of ordered) {
    if ('__pendingIndex' in slot) {
      parts.push(fetched[slot.__pendingIndex]!)
    } else {
      parts.push(slot)
    }
  }
  return parts
}

async function fetchRemoteImageAsPart(url: string): Promise<GeminiPart> {
  const fail = (reason: string): GeminiPart => ({
    text: `[image at ${url} could not be loaded: ${reason}]`,
  })
  try {
    const response = await request(url, {
      method: 'GET',
      headersTimeout: REMOTE_IMAGE_FETCH_TIMEOUT_MS,
      bodyTimeout: REMOTE_IMAGE_FETCH_TIMEOUT_MS,
    })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy?.()
      return fail(`upstream status ${response.statusCode}`)
    }
    const headers = response.headers as Record<string, string | string[] | undefined>
    const rawType = headers['content-type']
    const contentType = (Array.isArray(rawType) ? rawType[0] : rawType) ?? ''
    const mimeType = contentType.split(';')[0]?.trim() ?? ''
    if (!mimeType.startsWith('image/')) {
      response.body.destroy?.()
      return fail(`unexpected content-type ${mimeType || 'unknown'}`)
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body as AsyncIterable<Buffer | Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > REMOTE_IMAGE_MAX_BYTES) {
        response.body.destroy?.()
        return fail(`exceeds ${REMOTE_IMAGE_MAX_BYTES} bytes`)
      }
      chunks.push(buf)
    }
    const data = Buffer.concat(chunks).toString('base64')
    return { inlineData: { mimeType, data } }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'fetch failed')
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const item of content as Array<Record<string, unknown>>) {
    if (item && typeof item === 'object' && typeof item.text === 'string') {
      out.push(item.text)
    }
  }
  return out.join('\n')
}

function convertOpenAIToolsAndChoice(
  rawTools: unknown,
  rawChoice: unknown,
): {
  tools: Array<Record<string, unknown>>
  toolConfig: Record<string, unknown> | null
} {
  const tools = convertOpenAITools(rawTools)
  const toolConfig = convertToolChoice(rawChoice, tools.length > 0)
  return { tools, toolConfig }
}

function convertOpenAITools(rawTools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rawTools)) return []
  const declarations: Array<Record<string, unknown>> = []
  for (const tool of rawTools as Array<Record<string, unknown>>) {
    if (!tool || typeof tool !== 'object') continue
    const fn = (tool as { function?: { name?: unknown; description?: unknown; parameters?: unknown } }).function
    if (!fn || typeof fn.name !== 'string') continue
    const declaration: Record<string, unknown> = { name: fn.name }
    if (typeof fn.description === 'string') declaration.description = fn.description
    if (fn.parameters && typeof fn.parameters === 'object') {
      declaration.parameters = fn.parameters
    }
    declarations.push(declaration)
  }
  if (declarations.length === 0) return []
  return [{ functionDeclarations: declarations }]
}

function convertToolChoice(rawChoice: unknown, hasTools: boolean): Record<string, unknown> | null {
  if (!hasTools) return null
  if (rawChoice === undefined || rawChoice === null || rawChoice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } }
  }
  if (rawChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } }
  }
  if (rawChoice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } }
  }
  if (typeof rawChoice === 'object') {
    const obj = rawChoice as { type?: unknown; function?: { name?: unknown } }
    if (obj.type === 'function' && obj.function && typeof obj.function.name === 'string') {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [obj.function.name],
        },
      }
    }
  }
  return { functionCallingConfig: { mode: 'AUTO' } }
}

// ──────────────────────────────────────────────────────────────────────────
// Code Assist response → OpenAI Chat Completions
// ──────────────────────────────────────────────────────────────────────────

type CaGenerateContentResponse = {
  response?: VertexGenerateContentResponse | null
  traceId?: string | null
}

type VertexGenerateContentResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] | null; role?: string } | null
    finishReason?: string | null
  }> | null
  usageMetadata?: {
    promptTokenCount?: number | null
    candidatesTokenCount?: number | null
    totalTokenCount?: number | null
    cachedContentTokenCount?: number | null
  } | null
  modelVersion?: string | null
}

export type GeminiCompletionMessage = {
  role: 'assistant'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export function transformGeminiNonStreamingResponseToChat(input: {
  body: Buffer
  account: StoredAccount
  model: string
}): { body: Buffer; contentType: string } {
  const parsed = parseJson(input.body) as CaGenerateContentResponse
  const inner = parsed?.response ?? null
  const candidates = inner?.candidates ?? []
  const usage = inner?.usageMetadata ?? null
  const choices = candidates.length > 0
    ? candidates.map((candidate, index) => ({
        index,
        message: mergePartsToChatMessage(candidate?.content?.parts ?? []),
        finish_reason: mapFinishReason(candidate?.finishReason ?? null),
      }))
    : [
        {
          index: 0,
          message: mergePartsToChatMessage([]),
          finish_reason: mapFinishReason(null),
        },
      ]

  const completion = {
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: inner?.modelVersion ?? input.model,
    choices,
    usage: {
      prompt_tokens: usage?.promptTokenCount ?? 0,
      completion_tokens: usage?.candidatesTokenCount ?? 0,
      total_tokens: usage?.totalTokenCount ?? 0,
    },
  }
  return {
    body: Buffer.from(JSON.stringify(completion), 'utf8'),
    contentType: 'application/json; charset=utf-8',
  }
}

export function geminiSseToChatCompletionsChunks(input: {
  ssePayload: string
  model: string
  completionId: string
}): string[] {
  const parsed = (() => {
    try {
      return JSON.parse(input.ssePayload) as CaGenerateContentResponse
    } catch {
      return null
    }
  })()
  if (!parsed) return []
  const inner = parsed.response ?? null
  const candidates = inner?.candidates ?? []
  if (candidates.length === 0) return []
  const created = Math.floor(Date.now() / 1000)
  const model = inner?.modelVersion ?? input.model
  const events: string[] = []

  for (let candIdx = 0; candIdx < candidates.length; candIdx += 1) {
    const candidate = candidates[candIdx] ?? null
    const parts = candidate?.content?.parts ?? []
    const finishReason = candidate?.finishReason
      ? mapFinishReason(candidate.finishReason)
      : null

    let textBuffer = ''
    const toolCallEvents: Array<{ index: number; id: string; name: string; args: string }> = []
    let toolIndex = 0
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        textBuffer += part.text
        continue
      }
      if (part.functionCall && part.functionCall.name) {
        toolCallEvents.push({
          index: toolIndex++,
          id: `call_${crypto.randomBytes(6).toString('hex')}`,
          name: part.functionCall.name,
          args: JSON.stringify(part.functionCall.args ?? {}),
        })
      }
    }

    if (textBuffer.length > 0) {
      events.push(
        formatChatChunk({
          id: input.completionId,
          model,
          created,
          choiceIndex: candIdx,
          delta: { role: 'assistant', content: textBuffer },
        }),
      )
    }
    for (const tc of toolCallEvents) {
      events.push(
        formatChatChunk({
          id: input.completionId,
          model,
          created,
          choiceIndex: candIdx,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: tc.index,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: '' },
              },
            ],
          },
        }),
      )
      events.push(
        formatChatChunk({
          id: input.completionId,
          model,
          created,
          choiceIndex: candIdx,
          delta: {
            tool_calls: [
              {
                index: tc.index,
                function: { arguments: tc.args },
              },
            ],
          },
        }),
      )
    }
    if (finishReason) {
      events.push(
        formatChatChunk({
          id: input.completionId,
          model,
          created,
          choiceIndex: candIdx,
          delta: {},
          finishReason,
        }),
      )
    }
  }
  return events
}

export function chatCompletionsSseTerminator(): string {
  return 'data: [DONE]\n\n'
}

function formatChatChunk(input: {
  id: string
  model: string
  created: number
  delta: Record<string, unknown>
  finishReason?: string | null
  choiceIndex?: number
}): string {
  const chunk = {
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: input.choiceIndex ?? 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function mergePartsToChatMessage(parts: GeminiPart[]): GeminiCompletionMessage {
  let text = ''
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  for (const part of parts) {
    if (typeof part.text === 'string') text += part.text
    if (part.functionCall && part.functionCall.name) {
      toolCalls.push({
        id: `call_${crypto.randomBytes(6).toString('hex')}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      })
    }
  }
  const message: GeminiCompletionMessage = {
    role: 'assistant',
    content: text.length > 0 ? text : null,
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return message
}

function mapFinishReason(reason: string | null): string {
  if (!reason) return 'stop'
  const upper = reason.toUpperCase()
  if (upper === 'STOP') return 'stop'
  if (upper === 'MAX_TOKENS') return 'length'
  if (
    upper === 'SAFETY' ||
    upper === 'RECITATION' ||
    upper === 'BLOCKLIST' ||
    upper === 'PROHIBITED_CONTENT' ||
    upper === 'SPII' ||
    upper === 'LANGUAGE' ||
    upper === 'IMAGE_SAFETY'
  ) {
    return 'content_filter'
  }
  if (upper === 'TOOL_USE' || upper === 'FUNCTION_CALL' || upper === 'MALFORMED_FUNCTION_CALL') {
    return 'tool_calls'
  }
  if (upper === 'OTHER') return 'stop'
  return 'stop'
}

export function extractGeminiErrorMessage(body: Buffer): string {
  if (!body || body.length === 0) return 'Upstream Gemini request failed'
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      error?: { message?: unknown; status?: unknown } | null
    }
    if (parsed?.error?.message && typeof parsed.error.message === 'string') {
      return parsed.error.message
    }
  } catch {
    // ignore
  }
  return body.toString('utf8').slice(0, 500)
}

export function readGeminiProjectId(account: StoredAccount): string | null {
  const fromRaw = (account.rawProfile as unknown as { cloudaicompanionProject?: unknown } | null)?.cloudaicompanionProject
  if (typeof fromRaw === 'string' && fromRaw.trim()) return fromRaw.trim()
  if (account.apiBaseUrl?.trim()) return account.apiBaseUrl.trim()
  return null
}

export function readGeminiUserTier(account: StoredAccount): GeminiUserTier | null {
  const fromRaw = (account.rawProfile as unknown as { userTier?: unknown } | null)?.userTier
  if (typeof fromRaw === 'string' && fromRaw.trim()) return fromRaw.trim() as GeminiUserTier
  return null
}

function parseJson(buffer: Buffer): unknown {
  if (!buffer || buffer.length === 0) return {}
  return JSON.parse(buffer.toString('utf8'))
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
