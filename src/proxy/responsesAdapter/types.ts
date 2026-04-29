/* Adapted from wang-h/chat2response (MIT). https://github.com/wang-h/chat2response */

// ============================================
// OpenAI Responses API — incoming from codex client
// ============================================

export interface ResponsesRequest {
  model: string
  input: string | ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: ResponsesToolChoice
  stream?: boolean
  temperature?: number
  max_tokens?: number
  max_output_tokens?: number
  top_p?: number
  store?: boolean
  user?: string
  parallel_tool_calls?: boolean
  reasoning?: { effort?: string; summary?: string }
  service_tier?: string
  prompt_cache_key?: string
  text?: unknown
  include?: string[]
  client_metadata?: Record<string, string>
  [key: string]: unknown
}

export interface ResponsesInputItem {
  type: 'message' | 'function_call' | 'function_call_output' | 'reasoning'
  role?: 'user' | 'assistant' | 'system' | 'developer'
  content?: string | ResponsesContentPart[]
  name?: string
  namespace?: string
  arguments?: string
  call_id?: string
  output?: string
  summary?: { type: 'summary_text'; text: string }[]
  encrypted_content?: string
}

export interface ResponsesContentPart {
  type: 'input_text' | 'input_image' | 'input_file' | 'output_text' | 'refusal'
  text?: string
  image_url?: string
  file_url?: string
  detail?: 'auto' | 'low' | 'high'
}

export interface ResponsesTool {
  type: 'function' | 'namespace'
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  tools?: ResponsesTool[]
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export type ResponsesToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

// ============================================
// OpenAI Chat Completions — outgoing to upstream
// ============================================

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  tool_choice?: ResponsesToolChoice
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  user?: string
  parallel_tool_calls?: boolean
  [key: string]: unknown
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[] | null
  name?: string
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}

export interface ChatContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface ChatTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// ============================================
// Chat Completions stream chunk (upstream → us)
// ============================================

export interface ChatCompletionChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
}

// ============================================
// Responses SSE events (us → codex client)
// ============================================

export interface ResponseObject {
  id: string
  object: 'response'
  created_at: number
  model: string
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'incomplete'
  output: ResponsesOutputItem[]
  usage?: ResponsesUsage
  error?: { code: string; message: string } | null
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export type ResponsesOutputItem =
  | {
      id: string
      type: 'message'
      role: 'assistant'
      content: ResponsesContentPart[]
    }
  | {
      id: string
      type: 'reasoning'
      summary?: { type: 'summary_text'; text: string }[]
      content?: ResponsesContentPart[]
    }
  | {
      id: string
      type: 'function_call'
      name: string
      namespace?: string
      arguments: string
      call_id: string
    }

export type StreamEvent =
  | { type: 'response.created'; response: ResponseObject }
  | { type: 'response.in_progress'; response: ResponseObject }
  | { type: 'response.output_item.added'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: ResponsesOutputItem }
  | {
      type: 'response.content_part.added'
      item_id: string
      output_index: number
      content_index: number
      part: { type: 'output_text'; text: string }
    }
  | {
      type: 'response.content_part.done'
      item_id: string
      output_index: number
      content_index: number
      part: { type: 'output_text'; text: string }
    }
  | {
      type: 'response.output_text.delta'
      item_id: string
      output_index: number
      content_index: number
      delta: string
    }
  | {
      type: 'response.output_text.done'
      item_id: string
      output_index: number
      content_index: number
      text: string
    }
  | {
      type: 'response.function_call_arguments.delta'
      output_index: number
      item_id: string
      delta: string
    }
  | {
      type: 'response.function_call_arguments.done'
      output_index: number
      item_id: string
      arguments: string
    }
  | {
      type: 'response.reasoning_summary_part.added'
      output_index: number
      item_id: string
      summary_index: number
      part: { type: 'summary_text'; text: string }
    }
  | {
      type: 'response.reasoning_content.delta'
      output_index: number
      item_id: string
      content_index: number
      delta: string
    }
  | { type: 'response.completed'; response: ResponseObject }
  | { type: 'response.failed'; response: ResponseObject }
