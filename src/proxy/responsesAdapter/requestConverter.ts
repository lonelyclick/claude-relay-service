/* Adapted from wang-h/chat2response (MIT). https://github.com/wang-h/chat2response */

import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesContentPart,
  ResponsesTool,
  ChatCompletionRequest,
  ChatMessage,
  ChatContentPart,
  ChatTool,
  ChatToolCall,
} from './types.js'
import { flattenNamespaceToolName } from './toolNameMapper.js'

function genCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, '')}`
}

function extractTextContent(content: string | ResponsesContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'input_text' || p.type === 'output_text')
    .map((p) => p.text || '')
    .join('')
}

function extractMixedContent(content: string | ResponsesContentPart[] | undefined): string | ChatContentPart[] {
  if (!content) return ''
  if (typeof content === 'string') return content
  // If image present, return mixed content array; otherwise return joined text.
  const hasImage = content.some((p) => p.type === 'input_image')
  if (!hasImage) return extractTextContent(content)
  const parts: ChatContentPart[] = []
  for (const p of content) {
    if (p.type === 'input_text' || p.type === 'output_text') {
      if (p.text) parts.push({ type: 'text', text: p.text })
    } else if (p.type === 'input_image' && p.image_url) {
      parts.push({ type: 'image_url', image_url: { url: p.image_url, detail: p.detail } })
    }
  }
  return parts
}

function convertTool(tool: ResponsesTool): ChatTool | null {
  if (tool.function && tool.function.name) {
    return {
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }
  }
  // Top-level form: { type: 'function', name, description, parameters }
  if (tool.type === 'function' && tool.name) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }
  }
  return null
}

function convertTools(tools: ResponsesTool[] | undefined): ChatTool[] | undefined {
  if (!tools) return undefined
  const converted: ChatTool[] = []
  for (const tool of tools) {
    if (tool.type === 'namespace' && tool.name && Array.isArray(tool.tools)) {
      for (const childTool of tool.tools) {
        const child = convertTool(childTool)
        if (!child) continue
        converted.push({
          ...child,
          function: {
            ...child.function,
            name: flattenNamespaceToolName(tool.name, child.function.name),
            description: child.function.description || tool.description || '',
          },
        })
      }
      continue
    }
    const convertedTool = convertTool(tool)
    if (convertedTool) converted.push(convertedTool)
  }
  return converted.length > 0 ? converted : undefined
}

export function convertResponsesToChat(body: ResponsesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = []

  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions })
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input })
  } else if (Array.isArray(body.input)) {
    let lastAssistantMsg: ChatMessage | null = null
    for (const item of body.input) {
      if (item.type === 'message') {
        const role: ChatMessage['role'] = item.role === 'developer' ? 'system' : (item.role as ChatMessage['role']) ?? 'user'
        const msg: ChatMessage = {
          role,
          content: extractMixedContent(item.content),
        }
        messages.push(msg)
        lastAssistantMsg = role === 'assistant' ? msg : null
      } else if (item.type === 'function_call') {
        const tc: ChatToolCall = {
          id: item.call_id || genCallId(),
          type: 'function',
          function: {
            name: item.namespace && item.name ? flattenNamespaceToolName(item.namespace, item.name) : item.name || '',
            arguments: item.arguments || '{}',
          },
        }
        if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
          if (!lastAssistantMsg.tool_calls) lastAssistantMsg.tool_calls = []
          lastAssistantMsg.tool_calls.push(tc)
        } else {
          const msg: ChatMessage = { role: 'assistant', content: '', tool_calls: [tc] }
          messages.push(msg)
          lastAssistantMsg = msg
        }
      } else if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          content: item.output ?? '',
          tool_call_id: item.call_id || '',
        })
        lastAssistantMsg = null
      } else if (item.type === 'reasoning') {
        // Reasoning items from prior turns can't be replayed to chat-only upstreams.
        // Skip — chat models will infer from context.
        continue
      }
    }
  }

  const chatTools = convertTools(body.tools)

  const out: ChatCompletionRequest = {
    model: body.model,
    messages,
    stream: body.stream ?? true,
  }
  if (chatTools && chatTools.length > 0) out.tools = chatTools
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice
  if (body.temperature !== undefined) out.temperature = body.temperature
  if (body.top_p !== undefined) out.top_p = body.top_p
  if (body.user !== undefined) out.user = body.user
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls
  // max_output_tokens (Responses) → max_tokens (Chat). Don't forward Responses-only fields.
  const maxTokens = body.max_tokens ?? body.max_output_tokens
  if (typeof maxTokens === 'number' && maxTokens > 0) out.max_tokens = maxTokens

  return out
}
