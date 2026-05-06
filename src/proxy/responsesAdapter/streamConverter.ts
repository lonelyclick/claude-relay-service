/* Adapted from wang-h/chat2response (MIT). https://github.com/wang-h/chat2response */

import type {
  ChatCompletionChunk,
  ResponseObject,
  ResponsesOutputItem,
  ResponsesRequest,
  ResponsesUsage,
  StreamEvent,
} from './types.js'
import { splitFlattenedNamespaceToolName } from './toolNameMapper.js'

export type StreamChatToResponsesHooks = {
  onUsage?: (usage: ResponsesUsage) => void
}

interface ToolCallState {
  index: number
  outputIndex: number
  itemId: string
  call_id: string
  name: string
  namespace?: string
  arguments: string
  itemAdded: boolean
}

interface StreamState {
  responseId: string
  reasoningItemId: string
  messageItemId: string
  reasoningOutputIndex: number | null
  messageOutputIndex: number | null
  nextOutputIndex: number
  reasoningSummaryStarted: boolean
  reasoningText: string
  isOutputItemAdded: boolean
  isContentPartAdded: boolean
  fullText: string
  toolCalls: Map<number, ToolCallState>
  // Map index from upstream tool_calls[].index → our internal record (index field is provided by OpenAI chat protocol).
  finished: boolean
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

function createInitialState(): StreamState {
  return {
    responseId: newId('resp'),
    reasoningItemId: newId('rs'),
    messageItemId: newId('msg'),
    reasoningOutputIndex: null,
    messageOutputIndex: null,
    nextOutputIndex: 0,
    reasoningSummaryStarted: false,
    reasoningText: '',
    isOutputItemAdded: false,
    isContentPartAdded: false,
    fullText: '',
    toolCalls: new Map(),
    finished: false,
  }
}

function buildResponseObject(state: StreamState, model: string, status: ResponseObject['status'], usage?: ResponsesUsage): ResponseObject {
  const output: ResponsesOutputItem[] = []
  if (state.reasoningOutputIndex !== null) {
    output.push({
      id: state.reasoningItemId,
      type: 'reasoning',
      summary: state.reasoningText
        ? [{ type: 'summary_text', text: state.reasoningText }]
        : [],
    })
  }
  if (state.messageOutputIndex !== null) {
    output.push({
      id: state.messageItemId,
      type: 'message',
      role: 'assistant',
      content: state.fullText ? [{ type: 'output_text', text: state.fullText }] : [],
    })
  }
  // Sort tool calls by their assigned outputIndex
  const toolList = [...state.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)
  for (const tc of toolList) {
    output.push({
      id: tc.itemId,
      type: 'function_call',
      name: tc.name,
      namespace: tc.namespace,
      arguments: tc.arguments,
      call_id: tc.call_id,
    })
  }
  return {
    id: state.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output,
    usage,
  }
}

function formatSSE(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export interface ConvertStreamContext {
  model: string
  /** Echo back to client. */
  request?: ResponsesRequest
}

/**
 * Build a synthetic terminal failure event for upstream errors received before/in the middle of the stream.
 */
export function buildFailureEvent(model: string, code: string, message: string): string {
  const responseId = newId('resp')
  const failed: ResponseObject = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'failed',
    output: [],
    error: { code, message },
  }
  return (
    formatSSE({ type: 'response.failed', response: failed }) +
    'data: [DONE]\n\n'
  )
}

/**
 * Async generator that consumes upstream Chat Completions SSE bytes and yields Responses-API SSE strings.
 * Caller should pipe yielded strings to the client. On error or close, caller should drop the iterator.
 */
export async function* streamChatToResponses(
  upstream: AsyncIterable<Uint8Array>,
  ctx: ConvertStreamContext,
  hooks: StreamChatToResponsesHooks = {},
): AsyncGenerator<string, void, void> {
  const state = createInitialState()
  const decoder = new TextDecoder()
  let buffer = ''
  let initialEmitted = false
  let usage: ResponsesUsage | undefined
  let finishReason: string | null = null

  const emitInitialIfNeeded = function* (): Generator<string> {
    if (initialEmitted) return
    initialEmitted = true
    const initialResponse: ResponseObject = {
      id: state.responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: ctx.model,
      status: 'in_progress',
      output: [],
    }
    yield formatSSE({ type: 'response.created', response: initialResponse })
    yield formatSSE({ type: 'response.in_progress', response: initialResponse })
  }

  const ensureMessageOpened = function* (): Generator<string> {
    if (state.isOutputItemAdded) return
    state.isOutputItemAdded = true
    state.messageOutputIndex = state.nextOutputIndex++
    yield formatSSE({
      type: 'response.output_item.added',
      output_index: state.messageOutputIndex,
      item: { id: state.messageItemId, type: 'message', role: 'assistant', content: [] },
    })
    state.isContentPartAdded = true
    yield formatSSE({
      type: 'response.content_part.added',
      item_id: state.messageItemId,
      output_index: state.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    })
  }

  const ensureReasoningOpened = function* (): Generator<string> {
    if (state.reasoningOutputIndex !== null) return
    state.reasoningOutputIndex = state.nextOutputIndex++
    yield formatSSE({
      type: 'response.output_item.added',
      output_index: state.reasoningOutputIndex,
      item: { id: state.reasoningItemId, type: 'reasoning', summary: [] },
    })
  }

  const handleChunk = function* (chunk: ChatCompletionChunk): Generator<string> {
    const choice = chunk.choices?.[0]
    if (chunk.usage) {
      const inT = chunk.usage.prompt_tokens ?? 0
      const outT = chunk.usage.completion_tokens ?? 0
      usage = {
        input_tokens: inT,
        output_tokens: outT,
        total_tokens: chunk.usage.total_tokens ?? inT + outT,
      }
      hooks.onUsage?.(usage)
    }
    if (!choice) return
    const delta = choice.delta ?? {}
    const reasoningDelta =
      typeof (delta as { reasoning_content?: string | null }).reasoning_content === 'string'
        ? (delta as { reasoning_content: string }).reasoning_content
        : ''

    if (reasoningDelta) {
      yield* ensureReasoningOpened()
      if (!state.reasoningSummaryStarted) {
        state.reasoningSummaryStarted = true
        yield formatSSE({
          type: 'response.reasoning_summary_part.added',
          output_index: state.reasoningOutputIndex!,
          item_id: state.reasoningItemId,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        })
      }
      state.reasoningText += reasoningDelta
      yield formatSSE({
        type: 'response.reasoning_content.delta',
        output_index: state.reasoningOutputIndex!,
        item_id: state.reasoningItemId,
        content_index: 0,
        delta: reasoningDelta,
      })
    }

    const textDelta = typeof delta.content === 'string' ? delta.content : ''
    if (textDelta) {
      yield* ensureMessageOpened()
      state.fullText += textDelta
      yield formatSSE({
        type: 'response.output_text.delta',
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex!,
        content_index: 0,
        delta: textDelta,
      })
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : state.toolCalls.size
        let st = state.toolCalls.get(idx)
        if (!st) {
          st = {
            index: idx,
            outputIndex: state.nextOutputIndex++,
            itemId: tc.id || newId('tc'),
            call_id: tc.id || newId('call'),
            name: tc.function?.name || '',
            arguments: '',
            itemAdded: false,
          }
          state.toolCalls.set(idx, st)
        } else if (tc.id) {
          // Late id arrival.
          st.call_id = tc.id
          st.itemId = tc.id
        }
        if (!st.itemAdded && (st.name || tc.function?.name)) {
          if (tc.function?.name && !st.name) st.name = tc.function.name
          if (st.name) {
            const splitName = splitFlattenedNamespaceToolName(st.name)
            if (splitName) {
              st.namespace = splitName.namespace
              st.name = splitName.name
            }
            st.itemAdded = true
            yield formatSSE({
              type: 'response.output_item.added',
              output_index: st.outputIndex,
              item: {
                id: st.itemId,
                type: 'function_call',
                name: st.name,
                namespace: st.namespace,
                arguments: '',
                call_id: st.call_id,
              },
            })
          }
        }
        const argDelta = tc.function?.arguments
        if (argDelta) {
          st.arguments += argDelta
          if (st.itemAdded) {
            yield formatSSE({
              type: 'response.function_call_arguments.delta',
              output_index: st.outputIndex,
              item_id: st.itemId,
              delta: argDelta,
            })
          }
        }
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason
    }
  }

  const finalize = function* (): Generator<string> {
    if (state.finished) return
    state.finished = true

    if (state.reasoningOutputIndex !== null) {
      yield formatSSE({
        type: 'response.output_item.done',
        output_index: state.reasoningOutputIndex,
        item: {
          id: state.reasoningItemId,
          type: 'reasoning',
          summary: state.reasoningText
            ? [{ type: 'summary_text', text: state.reasoningText }]
            : [],
        },
      })
    }

    if (state.isOutputItemAdded) {
      yield formatSSE({
        type: 'response.output_text.done',
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex!,
        content_index: 0,
        text: state.fullText,
      })
      yield formatSSE({
        type: 'response.content_part.done',
        item_id: state.messageItemId,
        output_index: state.messageOutputIndex!,
        content_index: 0,
        part: { type: 'output_text', text: state.fullText },
      })
      yield formatSSE({
        type: 'response.output_item.done',
        output_index: state.messageOutputIndex!,
        item: {
          id: state.messageItemId,
          type: 'message',
          role: 'assistant',
          content: state.fullText ? [{ type: 'output_text', text: state.fullText }] : [],
        },
      })
    }

    for (const tc of [...state.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (!tc.itemAdded) continue
      yield formatSSE({
        type: 'response.function_call_arguments.done',
        output_index: tc.outputIndex,
        item_id: tc.itemId,
        arguments: tc.arguments,
      })
      yield formatSSE({
        type: 'response.output_item.done',
        output_index: tc.outputIndex,
        item: {
          id: tc.itemId,
          type: 'function_call',
          name: tc.name,
          namespace: tc.namespace,
          arguments: tc.arguments,
          call_id: tc.call_id,
        },
      })
    }

    const status: ResponseObject['status'] = finishReason === 'length' ? 'incomplete' : 'completed'
    const finalResponse = buildResponseObject(state, ctx.model, status, usage)
    yield formatSSE({ type: 'response.completed', response: finalResponse })
    yield 'data: [DONE]\n\n'
  }

  try {
    for await (const value of upstream) {
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || !line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          yield* emitInitialIfNeeded()
          yield* finalize()
          return
        }
        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk
          yield* emitInitialIfNeeded()
          yield* handleChunk(chunk)
        } catch {
          // Skip malformed line; keep stream alive.
        }
      }
    }
    // flush trailing buffer
    if (buffer.trim().startsWith('data:')) {
      const tail = buffer.trim().slice(5).trim()
      if (tail && tail !== '[DONE]') {
        try {
          const chunk = JSON.parse(tail) as ChatCompletionChunk
          yield* emitInitialIfNeeded()
          yield* handleChunk(chunk)
        } catch {
          // ignore
        }
      }
    }
    yield* emitInitialIfNeeded()
    yield* finalize()
  } catch (err) {
    if (!initialEmitted) {
      yield* emitInitialIfNeeded()
    }
    const message = err instanceof Error ? err.message : String(err)
    yield formatSSE({
      type: 'response.failed',
      response: buildResponseObject(state, ctx.model, 'failed'),
    })
    yield 'data: [DONE]\n\n'
    void message
  }
}

/**
 * Convert a non-streaming chat completion JSON response to a Responses API JSON object.
 */
export function convertChatToResponse(
  chatJson: unknown,
  model: string,
): ResponseObject {
  const chat = chatJson as {
    id?: string
    choices?: Array<{
      message?: {
        content?: string | null
        reasoning_content?: string | null
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
      }
      finish_reason?: string
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const message = chat.choices?.[0]?.message
  const text = (message?.content ?? '') || ''
  const reasoning = (message?.reasoning_content ?? '') || ''
  const output: ResponsesOutputItem[] = []
  if (reasoning) {
    output.push({
      id: newId('rs'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    })
  }
  if (text) {
    output.push({
      id: newId('msg'),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    })
  }
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      const splitName = splitFlattenedNamespaceToolName(tc.function.name)
      output.push({
        id: tc.id,
        type: 'function_call',
        name: splitName?.name ?? tc.function.name,
        namespace: splitName?.namespace,
        arguments: tc.function.arguments,
        call_id: tc.id,
      })
    }
  }
  const inT = chat.usage?.prompt_tokens ?? 0
  const outT = chat.usage?.completion_tokens ?? 0
  return {
    id: newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output,
    usage: {
      input_tokens: inT,
      output_tokens: outT,
      total_tokens: chat.usage?.total_tokens ?? inT + outT,
    },
  }
}
