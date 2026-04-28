import crypto from 'node:crypto'

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

type OpenAIChatCompletionResponse = {
  id?: unknown
  model?: unknown
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
  } | null
  choices?: Array<{
    finish_reason?: unknown
    message?: {
      content?: unknown
      tool_calls?: Array<{
        id?: unknown
        function?: {
          name?: unknown
          arguments?: unknown
        } | null
      }> | null
    } | null
  }> | null
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

export type OpenAICompatibleRequestBuildResult = {
  upstreamBody: Buffer
  stream: boolean
  model: string
}

export function isOpenAICompatibleAccount(account: StoredAccount): boolean {
  return account.provider === 'openai-compatible'
}

export function buildOpenAICompatibleRequest(
  body: Buffer | undefined,
  account: StoredAccount,
  options?: {
    handoffSummary?: string | null
  },
): OpenAICompatibleRequestBuildResult {
  if (!body || body.length === 0) {
    throw new Error('Request body is required')
  }

  const parsed = parseJson(body) as AnthropicMessageRequest
  const messages = Array.isArray(parsed.messages) ? parsed.messages as AnthropicMessage[] : null
  if (!messages || messages.length === 0) {
    throw new Error('messages must be a non-empty array')
  }

  const model =
    account.modelName?.trim() ||
    (typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : '')
  if (!model) {
    throw new Error('OpenAI compatible account is missing modelName')
  }

  const upstreamMessages: Array<Record<string, unknown>> = []
  const systemText = serializeSystemText(parsed.system, options?.handoffSummary ?? null)
  if (systemText) {
    upstreamMessages.push({
      role: 'system',
      content: systemText,
    })
  }

  for (const message of messages) {
    upstreamMessages.push(...convertAnthropicMessage(message))
  }

  const upstreamBody: Record<string, unknown> = {
    model,
    messages: upstreamMessages,
    stream: false,
  }

  if (typeof parsed.max_tokens === 'number' && Number.isFinite(parsed.max_tokens)) {
    upstreamBody.max_tokens = parsed.max_tokens
  }
  if (typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)) {
    upstreamBody.temperature = parsed.temperature
  }
  if (typeof parsed.top_p === 'number' && Number.isFinite(parsed.top_p)) {
    upstreamBody.top_p = parsed.top_p
  }
  if (Array.isArray(parsed.stop_sequences) && parsed.stop_sequences.length > 0) {
    upstreamBody.stop = parsed.stop_sequences.filter((item): item is string =>
      typeof item === 'string' && item.length > 0,
    )
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

export function estimateOpenAICompatibleInputTokens(
  body: Buffer | undefined,
  account: StoredAccount,
): number {
  const request = buildOpenAICompatibleRequest(body, account)
  return Math.max(1, Math.ceil(request.upstreamBody.byteLength / 4))
}

export function buildOpenAICompatibleChatCompletionsUrl(account: StoredAccount): URL {
  const baseUrl = account.apiBaseUrl?.trim()
  if (!baseUrl) {
    throw new Error(`Account ${account.id} is missing apiBaseUrl`)
  }
  return new URL('chat/completions', `${baseUrl}/`)
}

export function transformOpenAICompatibleResponse(
  body: Buffer,
  stream: boolean,
  account: StoredAccount,
): {
  body: Buffer
  contentType: string
  message: AnthropicMessageResponse
} {
  const response = parseJson(body) as OpenAIChatCompletionResponse
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

export function extractOpenAICompatibleErrorMessage(body: Buffer): string {
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

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON')
  }
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
  return typeof block.text === 'string' && block.text.trim()
    ? block.text
    : null
}

function convertAnthropicMessage(message: AnthropicMessage): Array<Record<string, unknown>> {
  const role = typeof message.role === 'string' ? message.role : null
  if (role !== 'user' && role !== 'assistant') {
    throw new Error(`Unsupported message role: ${String(message.role ?? 'unknown')}`)
  }

  if (typeof message.content === 'string') {
    return [{
      role,
      content: message.content,
    }]
  }

  const contentBlocks = Array.isArray(message.content)
    ? message.content as AnthropicContentBlock[]
    : null
  if (!contentBlocks) {
    throw new Error(`Unsupported message content for role ${role}`)
  }

  if (role === 'assistant') {
    return [convertAssistantMessage(contentBlocks)]
  }
  return convertUserMessage(contentBlocks)
}

function convertAssistantMessage(
  blocks: AnthropicContentBlock[],
): Record<string, unknown> {
  const textParts: string[] = []
  const toolCalls: Array<Record<string, unknown>> = []

  for (const block of blocks) {
    const type = typeof block.type === 'string' ? block.type : null
    if (type === 'text') {
      if (typeof block.text === 'string') {
        textParts.push(block.text)
      }
      continue
    }
    if (type === 'tool_use') {
      const name = typeof block.name === 'string' && block.name.trim()
        ? block.name.trim()
        : null
      if (!name) {
        throw new Error('tool_use block is missing name')
      }
      const toolCallId = typeof block.id === 'string' && block.id.trim()
        ? block.id.trim()
        : generateToolUseId()
      toolCalls.push({
        id: toolCallId,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(normalizeToolInput(block.input)),
        },
      })
      continue
    }
    throw new Error(`Unsupported assistant content block type: ${type ?? 'unknown'}`)
  }

  const converted: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.join('\n\n'),
  }
  if (toolCalls.length > 0) {
    converted.tool_calls = toolCalls
  }
  return converted
}

function convertUserMessage(
  blocks: AnthropicContentBlock[],
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = []
  const textParts: string[] = []

  const flushText = (): void => {
    if (textParts.length === 0) {
      return
    }
    converted.push({
      role: 'user',
      content: textParts.join('\n\n'),
    })
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
    if (type === 'tool_result') {
      flushText()
      const toolUseId = typeof block.tool_use_id === 'string' && block.tool_use_id.trim()
        ? block.tool_use_id.trim()
        : generateToolUseId()
      converted.push({
        role: 'tool',
        tool_call_id: toolUseId,
        content: serializeToolResultContent(block.content),
      })
      continue
    }
    throw new Error(`Unsupported user content block type: ${type ?? 'unknown'}`)
  }

  flushText()
  if (converted.length === 0) {
    converted.push({
      role: 'user',
      content: '',
    })
  }
  return converted
}

function convertAnthropicTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    return []
  }

  return tools.map((tool) => {
    const value = tool as AnthropicTool
    const name = typeof value.name === 'string' && value.name.trim()
      ? value.name.trim()
      : null
    if (!name) {
      throw new Error('Tool definition is missing name')
    }
    return {
      type: 'function',
      function: {
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
    const name = typeof toolChoice.name === 'string' && toolChoice.name.trim()
      ? toolChoice.name.trim()
      : null
    if (!name) {
      return undefined
    }
    return {
      type: 'function',
      function: {
        name,
      },
    }
  }
  return undefined
}

function serializeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        const text = extractTextBlock(item)
        if (text !== null) {
          return text
        }
        return JSON.stringify(item)
      })
      .filter((item) => typeof item === 'string' && item.length > 0)
    return parts.join('\n\n')
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
  response: OpenAIChatCompletionResponse,
  account: StoredAccount,
): AnthropicMessageResponse {
  const choice = Array.isArray(response.choices) ? response.choices[0] : null
  const message = choice?.message ?? null
  const text = extractOpenAIContentText(message?.content)
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

  const content: AnthropicResponseContentBlock[] = []
  if (text) {
    content.push({
      type: 'text',
      text,
    })
  }
  for (const toolCall of toolCalls) {
    const functionName = typeof toolCall.function?.name === 'string' && toolCall.function.name.trim()
      ? toolCall.function.name.trim()
      : 'tool'
    const toolUseId = typeof toolCall.id === 'string' && toolCall.id.trim()
      ? toolCall.id.trim()
      : generateToolUseId()
    content.push({
      type: 'tool_use',
      id: toolUseId,
      name: functionName,
      input: parseToolArguments(toolCall.function?.arguments),
    })
  }

  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '',
    })
  }

  const promptTokens = coerceNumber(response.usage?.prompt_tokens)
  const completionTokens = coerceNumber(response.usage?.completion_tokens)
  const model =
    (typeof response.model === 'string' && response.model.trim())
      ? response.model.trim()
      : account.modelName?.trim() || 'openai-compatible'

  return {
    id: buildAnthropicMessageId(response.id),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: mapStopReason(choice?.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

function extractOpenAIContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return ''
      }
      const value = part as { text?: unknown }
      return typeof value.text === 'string' ? value.text : ''
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

function mapStopReason(
  finishReason: unknown,
  hasToolCalls: boolean,
): 'end_turn' | 'max_tokens' | 'tool_use' | null {
  if (hasToolCalls || finishReason === 'tool_calls') {
    return 'tool_use'
  }
  if (finishReason === 'length') {
    return 'max_tokens'
  }
  if (finishReason === 'stop' || finishReason == null) {
    return 'end_turn'
  }
  return 'end_turn'
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
    const partialJson = JSON.stringify(block.input ?? {})
    if (partialJson !== '{}') {
      pushSse(chunks, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: partialJson,
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
  pushSse(chunks, 'message_stop', {
    type: 'message_stop',
  })

  return Buffer.from(chunks.join(''), 'utf8')
}

function pushSse(chunks: string[], event: string, data: Record<string, unknown>): void {
  chunks.push(`event: ${event}\n`)
  chunks.push(`data: ${JSON.stringify(data)}\n\n`)
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return 0
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

function generateToolUseId(): string {
  return `toolu_${crypto.randomUUID().replace(/-/g, '')}`
}
