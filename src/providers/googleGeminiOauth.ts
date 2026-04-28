import crypto from 'node:crypto'

import { appConfig } from '../config.js'
import type { StoredAccount, SubscriptionType } from '../types.js'

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
      return 'gemini-standard'
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
}

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

export function buildGeminiChatCompletionsRequest(input: {
  rawBody: Buffer
  account: StoredAccount
  promptId?: string
  sessionId?: string
}): GeminiRequestBuildResult {
  if (!input.rawBody || input.rawBody.length === 0) {
    throw new Error('Request body is required')
  }
  const parsed = parseJson(input.rawBody) as OpenAIChatRequest
  const messages = Array.isArray(parsed.messages) ? (parsed.messages as OpenAIChatMessage[]) : []
  if (messages.length === 0) {
    throw new Error('messages must be a non-empty array')
  }

  const model = pickModelName(parsed.model, input.account)
  const stream = parsed.stream !== false

  const { systemInstruction, contents } = convertChatMessages(messages)

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
    const fmt = parsed.response_format as { type?: unknown }
    if (fmt.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json'
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
  const tools = convertOpenAITools(parsed.tools)
  if (tools.length > 0) {
    requestPayload.tools = tools
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

function pickModelName(rawModel: unknown, account: StoredAccount): string {
  const fromBody = typeof rawModel === 'string' ? rawModel.trim() : ''
  const fromAccount = account.modelName?.trim() ?? ''
  return fromBody || fromAccount || appConfig.geminiDefaultModel
}

function convertChatMessages(messages: OpenAIChatMessage[]): {
  systemInstruction: GeminiContent | null
  contents: GeminiContent[]
} {
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
      const parts = collectUserParts(message.content)
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

function collectUserParts(rawContent: unknown): GeminiPart[] {
  if (typeof rawContent === 'string') {
    return rawContent ? [{ text: rawContent }] : []
  }
  if (!Array.isArray(rawContent)) return []
  const parts: GeminiPart[] = []
  for (const item of rawContent as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === 'text' && typeof item.text === 'string') {
      parts.push({ text: item.text })
      continue
    }
    if (type === 'image_url') {
      const imageUrl = item.image_url as { url?: unknown } | undefined
      const url = imageUrl && typeof imageUrl.url === 'string' ? imageUrl.url : ''
      const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/i)
      if (dataUrlMatch) {
        parts.push({ inlineData: { mimeType: dataUrlMatch[1]!, data: dataUrlMatch[2]! } })
      }
      continue
    }
  }
  return parts
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
  const candidate = inner?.candidates?.[0] ?? null
  const message = mergePartsToChatMessage(candidate?.content?.parts ?? [])
  const finishReason = mapFinishReason(candidate?.finishReason ?? null)
  const usage = inner?.usageMetadata ?? null

  const completion = {
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: inner?.modelVersion ?? input.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
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
  const candidate = inner?.candidates?.[0] ?? null
  const parts = candidate?.content?.parts ?? []
  const finishReason = candidate?.finishReason ? mapFinishReason(candidate.finishReason) : null
  const created = Math.floor(Date.now() / 1000)
  const events: string[] = []
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
        model: inner?.modelVersion ?? input.model,
        created,
        delta: { role: 'assistant', content: textBuffer },
      }),
    )
  }
  for (const tc of toolCallEvents) {
    events.push(
      formatChatChunk({
        id: input.completionId,
        model: inner?.modelVersion ?? input.model,
        created,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: tc.index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.args },
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
        model: inner?.modelVersion ?? input.model,
        created,
        delta: {},
        finishReason,
      }),
    )
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
}): string {
  const chunk = {
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
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
  if (upper === 'SAFETY' || upper === 'RECITATION' || upper === 'BLOCKLIST' || upper === 'PROHIBITED_CONTENT' || upper === 'SPII') return 'content_filter'
  if (upper === 'TOOL_USE' || upper === 'FUNCTION_CALL') return 'tool_calls'
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
