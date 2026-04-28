import crypto from 'node:crypto'

import { appConfig } from '../config.js'
import type { StoredAccount } from '../types.js'

type AnthropicMessageRequest = {
  model?: unknown
  system?: unknown
  messages?: unknown
  tools?: unknown
  max_tokens?: unknown
  temperature?: unknown
  top_p?: unknown
  stop_sequences?: unknown
  stream?: unknown
  tool_choice?: unknown
}

type AnthropicMessage = {
  role?: unknown
  content?: unknown
}

type AnthropicContentBlock = {
  type?: unknown
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
}

type AnthropicTool = {
  name?: unknown
  description?: unknown
  input_schema?: unknown
}

type OpenAIResponsesResponse = {
  id?: unknown
  model?: unknown
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
  } | null
  output?: unknown
}

type OpenAIResponsesOutputMessage = {
  type?: unknown
  role?: unknown
  content?: unknown
}

type OpenAIResponsesOutputFunctionCall = {
  type?: unknown
  call_id?: unknown
  name?: unknown
  arguments?: unknown
}

type AnthropicTextContentBlock = {
  type: 'text'
  text: string
}

type AnthropicToolUseContentBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

type AnthropicResponseContentBlock =
  | AnthropicTextContentBlock
  | AnthropicToolUseContentBlock

type AnthropicMessageResponse = {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicResponseContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | null
  stop_sequence: string | null
  stop_details: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

export type OpenAICodexTokenClaims = {
  emailAddress: string | null
  chatgptPlanType: string | null
  chatgptUserId: string | null
  chatgptAccountId: string | null
}

export type OpenAICodexRequestBuildResult = {
  upstreamBody: Buffer
  stream: boolean
  model: string
}

export const OPENAI_CODEX_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke',
] as const

const OPENAI_CODEX_ORIGINATOR = 'codex_cli_rs'
const DEFAULT_OPENAI_CODEX_INSTRUCTIONS = 'You are Codex. Follow the user request exactly.'

export function isOpenAICodexAccount(account: StoredAccount): boolean {
  return account.provider === 'openai-codex'
}

export function buildOpenAICodexAuthorizeUrl(input: {
  codeChallenge: string
  state: string
}): string {
  const url = new URL('/oauth/authorize', `${appConfig.openAICodexOauthIssuer}/`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', appConfig.openAICodexOauthClientId)
  url.searchParams.set('redirect_uri', appConfig.openAICodexOauthRedirectUrl)
  url.searchParams.set('scope', OPENAI_CODEX_OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('state', input.state)
  url.searchParams.set('originator', OPENAI_CODEX_ORIGINATOR)
  return url.toString()
}

export function parseOpenAICodexTokenClaims(
  jwt: string | null | undefined,
): OpenAICodexTokenClaims {
  const payload = decodeJwtPayload(jwt)
  const auth =
    payload && typeof payload['https://api.openai.com/auth'] === 'object'
      ? (payload['https://api.openai.com/auth'] as Record<string, unknown>)
      : null
  const profile =
    payload && typeof payload['https://api.openai.com/profile'] === 'object'
      ? (payload['https://api.openai.com/profile'] as Record<string, unknown>)
      : null

  return {
    emailAddress: normalizeString(payload?.email) ?? normalizeString(profile?.email) ?? null,
    chatgptPlanType: normalizeString(auth?.chatgpt_plan_type) ?? null,
    chatgptUserId:
      normalizeString(auth?.chatgpt_user_id) ??
      normalizeString(auth?.user_id) ??
      null,
    chatgptAccountId: normalizeString(auth?.chatgpt_account_id) ?? null,
  }
}

export function buildOpenAICodexRequest(
  body: Buffer | undefined,
  account: StoredAccount,
  options?: {
    handoffSummary?: string | null
  },
): OpenAICodexRequestBuildResult {
  // Legacy compatibility helper retained for future Claude-style
  // request translation experiments. The active relay path currently proxies
  // native `/v1/responses` traffic in RelayService.
  if (!body || body.length === 0) {
    throw new Error('Request body is required')
  }

  const parsed = parseJson(body) as AnthropicMessageRequest
  const messages = Array.isArray(parsed.messages) ? (parsed.messages as AnthropicMessage[]) : null
  if (!messages || messages.length === 0) {
    throw new Error('messages must be a non-empty array')
  }

  const model =
    account.modelName?.trim() ||
    (typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : '') ||
    appConfig.openAICodexModel

  const instructions =
    serializeSystemText(parsed.system, options?.handoffSummary ?? null)
    ?? DEFAULT_OPENAI_CODEX_INSTRUCTIONS
  const inputItems: Array<Record<string, unknown>> = []

  for (const message of messages) {
    inputItems.push(...convertAnthropicMessage(message))
  }

  const upstreamBody: Record<string, unknown> = {
    model,
    input: inputItems,
    instructions,
    store: false,
    stream: true,
  }

  // ChatGPT Codex currently rejects `max_output_tokens`; omit Anthropic
  // `max_tokens` until upstream documents a supported equivalent.
  if (typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)) {
    upstreamBody.temperature = parsed.temperature
  }
  if (typeof parsed.top_p === 'number' && Number.isFinite(parsed.top_p)) {
    upstreamBody.top_p = parsed.top_p
  }

  const tools = convertAnthropicTools(parsed.tools)
  if (tools.length > 0) {
    upstreamBody.tools = tools
    const toolChoice = convertToolChoice(parsed.tool_choice)
    if (toolChoice !== undefined) {
      upstreamBody.tool_choice = toolChoice
    }
  }

  return {
    upstreamBody: Buffer.from(JSON.stringify(upstreamBody), 'utf8'),
    stream: parsed.stream !== false,
    model,
  }
}

export function estimateOpenAICodexInputTokens(
  body: Buffer | undefined,
  account: StoredAccount,
): number {
  const request = buildOpenAICodexRequest(body, account)
  return Math.max(1, Math.ceil(request.upstreamBody.byteLength / 4))
}

export function buildOpenAICodexResponsesUrl(account: StoredAccount): URL {
  const baseUrl = normalizeOpenAICodexApiBaseUrl(
    account.apiBaseUrl?.trim() || appConfig.openAICodexApiBaseUrl,
  )
  return new URL('responses', `${baseUrl.replace(/\/+$/, '')}/`)
}

export function transformOpenAICodexResponse(
  body: Buffer,
  stream: boolean,
  account: StoredAccount,
): {
  body: Buffer
  contentType: string
  message: AnthropicMessageResponse
} {
  const response = parseOpenAICodexResponsePayload(body)
  const anthropic = buildAnthropicMessageResponse(response, account)
  if (!stream) {
    return {
      body: Buffer.from(JSON.stringify(anthropic), 'utf8'),
      contentType: 'application/json; charset=utf-8',
      message: anthropic,
    }
  }
  return {
    body: buildAnthropicMessageSse(anthropic),
    contentType: 'text/event-stream; charset=utf-8',
    message: anthropic,
  }
}

export function extractOpenAICodexErrorMessage(body: Buffer): string {
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
    if (typeof (parsed as { detail?: unknown }).detail === 'string' && (parsed as { detail?: string }).detail?.trim()) {
      return (parsed as { detail: string }).detail.trim()
    }
  } catch {
    // fall through
  }
  const text = body.toString('utf8').trim()
  return text || 'Upstream request failed'
}

function decodeJwtPayload(jwt: string | null | undefined): Record<string, unknown> | null {
  if (!jwt) {
    return null
  }
  const parts = jwt.split('.')
  if (parts.length < 2 || !parts[1]) {
    return null
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON')
  }
}

function parseOpenAICodexResponsePayload(body: Buffer): OpenAIResponsesResponse {
  const text = body.toString('utf8').trim()
  if (!text) {
    return {}
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return parseJson(body) as OpenAIResponsesResponse
  }
  return parseOpenAICodexSseResponse(text)
}

function parseOpenAICodexSseResponse(raw: string): OpenAIResponsesResponse {
  let completed: OpenAIResponsesResponse | null = null
  const outputItems: Array<OpenAIResponsesOutputMessage | OpenAIResponsesOutputFunctionCall> = []
  const textOutputs = new Map<string, string>()

  for (const chunk of raw.split(/\n\n+/)) {
    const trimmed = chunk.trim()
    if (!trimmed) {
      continue
    }

    const eventName = extractSseField(trimmed, 'event')
    const data = extractSseField(trimmed, 'data')
    if (!data) {
      continue
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }

    if (eventName === 'response.completed' || eventName === 'response.done') {
      const response = parsed.response
      if (response && typeof response === 'object') {
        completed = response as OpenAIResponsesResponse
      }
      continue
    }

    if (eventName === 'response.output_item.done') {
      const item = parsed.item
      if (item && typeof item === 'object') {
        outputItems.push(item as OpenAIResponsesOutputMessage | OpenAIResponsesOutputFunctionCall)
      }
      continue
    }

    if (eventName === 'response.output_text.done') {
      const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : null
      const textValue = typeof parsed.text === 'string' ? parsed.text : null
      if (itemId && textValue !== null) {
        textOutputs.set(itemId, textValue)
      }
    }
  }

  if (outputItems.length === 0 && textOutputs.size > 0) {
    for (const [itemId, text] of textOutputs.entries()) {
      outputItems.push({
        type: 'message',
        role: 'assistant',
        id: itemId,
        content: [{ type: 'output_text', text }],
      } as OpenAIResponsesOutputMessage)
    }
  }

  return {
    ...(completed ?? {}),
    output: outputItems,
  }
}

function extractSseField(chunk: string, field: string): string | null {
  const prefix = `${field}:`
  const value = chunk
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .join('\n')
    .trim()
  return value || null
}

export function normalizeOpenAICodexApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/v1$/i, '')
}

function serializeSystemText(system: unknown, handoffSummary: string | null): string | null {
  const parts: string[] = []

  if (typeof system === 'string' && system.trim()) {
    parts.push(system.trim())
  } else if (Array.isArray(system)) {
    for (const block of system) {
      const text = extractTextBlock(block)
      if (text) {
        parts.push(text)
      }
    }
  }

  if (handoffSummary?.trim()) {
    parts.push(handoffSummary.trim())
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

function extractTextBlock(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const block = value as AnthropicContentBlock
  if (block.type !== 'text') {
    return null
  }
  return typeof block.text === 'string' && block.text.trim() ? block.text : null
}

function convertAnthropicMessage(message: AnthropicMessage): Array<Record<string, unknown>> {
  const role = typeof message.role === 'string' ? message.role : null
  if (role !== 'user' && role !== 'assistant') {
    throw new Error(`Unsupported message role: ${String(message.role ?? 'unknown')}`)
  }

  if (typeof message.content === 'string') {
    return [buildMessageItem(role, [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: message.content }])]
  }

  const contentBlocks = Array.isArray(message.content)
    ? (message.content as AnthropicContentBlock[])
    : null
  if (!contentBlocks) {
    throw new Error(`Unsupported message content for role ${role}`)
  }

  if (role === 'assistant') {
    return convertAssistantMessage(contentBlocks)
  }
  return convertUserMessage(contentBlocks)
}

function convertAssistantMessage(blocks: AnthropicContentBlock[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = []
  const textParts: string[] = []

  const flushText = (): void => {
    if (textParts.length === 0) {
      return
    }
    converted.push(
      buildMessageItem('assistant', [
        {
          type: 'output_text',
          text: textParts.join('\n\n'),
        },
      ]),
    )
    textParts.length = 0
  }

  for (const block of blocks) {
    const type = typeof block.type === 'string' ? block.type : null
    if (type === 'text') {
      if (typeof block.text === 'string') {
        textParts.push(block.text)
      }
      continue
    }
    if (type === 'tool_use') {
      flushText()
      const name =
        typeof block.name === 'string' && block.name.trim() ? block.name.trim() : null
      if (!name) {
        throw new Error('tool_use block is missing name')
      }
      const callId =
        typeof block.id === 'string' && block.id.trim() ? block.id.trim() : generateToolUseId()
      converted.push({
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(normalizeToolInput(block.input)),
      })
      continue
    }
    throw new Error(`Unsupported assistant content block type: ${type ?? 'unknown'}`)
  }

  flushText()
  return converted
}

function convertUserMessage(blocks: AnthropicContentBlock[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = []
  const textItems: Array<Record<string, unknown>> = []

  const flushText = (): void => {
    if (textItems.length === 0) {
      return
    }
    converted.push(buildMessageItem('user', [...textItems]))
    textItems.length = 0
  }

  for (const block of blocks) {
    const type = typeof block.type === 'string' ? block.type : null
    if (type === 'text') {
      if (typeof block.text === 'string') {
        textItems.push({
          type: 'input_text',
          text: block.text,
        })
      }
      continue
    }
    if (type === 'tool_result') {
      flushText()
      const callId =
        typeof block.tool_use_id === 'string' && block.tool_use_id.trim()
          ? block.tool_use_id.trim()
          : generateToolUseId()
      converted.push({
        type: 'function_call_output',
        call_id: callId,
        output: serializeToolResultContent(block.content),
      })
      continue
    }
    throw new Error(`Unsupported user content block type: ${type ?? 'unknown'}`)
  }

  flushText()
  if (converted.length === 0) {
    converted.push(
      buildMessageItem('user', [
        {
          type: 'input_text',
          text: '',
        },
      ]),
    )
  }
  return converted
}

function buildMessageItem(
  role: 'user' | 'assistant',
  content: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: 'message',
    role,
    content,
  }
}

function convertAnthropicTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    return []
  }

  return tools.map((tool) => {
    const value = tool as AnthropicTool
    const name =
      typeof value.name === 'string' && value.name.trim() ? value.name.trim() : null
    if (!name) {
      throw new Error('Tool definition is missing name')
    }
    return {
      type: 'function',
      name,
      description:
        typeof value.description === 'string' && value.description.trim()
          ? value.description.trim()
          : '',
      parameters:
        value.input_schema && typeof value.input_schema === 'object'
          ? value.input_schema
          : {
              type: 'object',
              properties: {},
            },
    }
  })
}

function convertToolChoice(value: unknown): Record<string, unknown> | string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const toolChoice = value as {
    type?: unknown
    name?: unknown
  }
  if (toolChoice.type === 'auto') {
    return 'auto'
  }
  if (toolChoice.type === 'any') {
    return 'required'
  }
  if (toolChoice.type === 'none') {
    return 'none'
  }
  if (toolChoice.type === 'tool') {
    const name =
      typeof toolChoice.name === 'string' && toolChoice.name.trim()
        ? toolChoice.name.trim()
        : null
    if (!name) {
      return undefined
    }
    return {
      type: 'function',
      name,
    }
  }
  return undefined
}

function serializeToolResultContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [
      {
        type: 'input_text',
        text: content,
      },
    ]
  }
  if (Array.isArray(content)) {
    const items: Array<Record<string, unknown>> = []
    for (const item of content) {
      const text = extractTextBlock(item)
      if (text !== null) {
        items.push({
          type: 'input_text',
          text,
        })
        continue
      }
      const serialized = JSON.stringify(item)
      if (!serialized) {
        continue
      }
      items.push({
        type: 'input_text',
        text: serialized,
      })
    }
    return items.length > 0 ? items : ''
  }
  if (content == null) {
    return ''
  }
  return JSON.stringify(content)
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (Array.isArray(value)) {
    return { items: value }
  }
  if (value == null) {
    return {}
  }
  return { value }
}

function buildAnthropicMessageResponse(
  response: OpenAIResponsesResponse,
  account: StoredAccount,
): AnthropicMessageResponse {
  const output = Array.isArray(response.output) ? response.output : []
  const content: AnthropicResponseContentBlock[] = []
  let sawToolUse = false

  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const outputMessage = item as OpenAIResponsesOutputMessage
    if (outputMessage.type === 'message' && outputMessage.role === 'assistant') {
      const text = extractResponseMessageText(outputMessage.content)
      if (text) {
        content.push({
          type: 'text',
          text,
        })
      }
      continue
    }

    const functionCall = item as OpenAIResponsesOutputFunctionCall
    if (functionCall.type === 'function_call') {
      sawToolUse = true
      content.push({
        type: 'tool_use',
        id:
          typeof functionCall.call_id === 'string' && functionCall.call_id.trim()
            ? functionCall.call_id.trim()
            : generateToolUseId(),
        name:
          typeof functionCall.name === 'string' && functionCall.name.trim()
            ? functionCall.name.trim()
            : 'tool',
        input: parseToolArguments(functionCall.arguments),
      })
    }
  }

  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '',
    })
  }

  const model =
    (typeof response.model === 'string' && response.model.trim())
      ? response.model.trim()
      : account.modelName?.trim() || appConfig.openAICodexModel

  return {
    id: buildAnthropicMessageId(response.id),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: sawToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: coerceNumber(response.usage?.input_tokens),
      output_tokens: coerceNumber(response.usage?.output_tokens),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

function extractResponseMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return ''
      }
      const type = (item as { type?: unknown }).type
      if (type !== 'output_text') {
        return ''
      }
      const text = (item as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) {
    return {}
  }
  try {
    const parsed = JSON.parse(value)
    return normalizeToolInput(parsed)
  } catch {
    return {
      raw_arguments: value,
    }
  }
}

function buildAnthropicMessageId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized.startsWith('msg_')) {
    return normalized
  }
  if (normalized) {
    return `msg_${normalized.replace(/[^a-zA-Z0-9_]/g, '')}`
  }
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function coerceNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function buildAnthropicMessageSse(message: AnthropicMessageResponse): Buffer {
  const chunks: string[] = []
  const startMessage = {
    ...message,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      ...message.usage,
      output_tokens: 0,
    },
  }

  pushSse(chunks, 'message_start', {
    type: 'message_start',
    message: startMessage,
  })

  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      pushSse(chunks, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: '',
        },
      })
      if (block.text) {
        pushSse(chunks, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'text_delta',
            text: block.text,
          },
        })
      }
      pushSse(chunks, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
      return
    }

    pushSse(chunks, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: {},
      },
    })
    const serializedInput = JSON.stringify(block.input)
    if (serializedInput && serializedInput !== '{}') {
      pushSse(chunks, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: serializedInput,
        },
      })
    }
    pushSse(chunks, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    })
  })

  pushSse(chunks, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence,
      stop_details: message.stop_details,
    },
    usage: message.usage,
    context_management: {
      applied_edits: [],
    },
  })
  pushSse(chunks, 'message_stop', { type: 'message_stop' })

  return Buffer.from(chunks.join(''), 'utf8')
}

function generateToolUseId(): string {
  return `toolu_${crypto.randomUUID().replace(/-/g, '')}`
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function pushSse(chunks: string[], event: string, data: Record<string, unknown>): void {
  chunks.push(`event: ${event}\n`)
  chunks.push(`data: ${JSON.stringify(data)}\n\n`)
}
