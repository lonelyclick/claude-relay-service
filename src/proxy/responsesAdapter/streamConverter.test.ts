import assert from 'node:assert/strict'
import test from 'node:test'

import { streamChatToResponses, convertChatToResponse, buildFailureEvent } from './streamConverter.js'

function* upstreamFromLines(lines: string[]): Generator<Uint8Array> {
  const enc = new TextEncoder()
  for (const line of lines) yield enc.encode(line)
}

async function collectEvents(upstream: Iterable<Uint8Array>, model = 'mimo-v2.5-pro') {
  const events: Array<Record<string, unknown>> = []
  let sawDone = false
  // wrap the sync iterator into an async one
  const asyncUpstream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      const it = (upstream as Iterable<Uint8Array>)[Symbol.iterator]()
      return {
        async next() {
          const { value, done } = it.next()
          return { value: value as Uint8Array, done: !!done }
        },
      }
    },
  }
  for await (const sse of streamChatToResponses(asyncUpstream, { model })) {
    const lines = sse.split('\n').filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('event:')) continue
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          sawDone = true
          continue
        }
        events.push(JSON.parse(data))
      }
    }
  }
  return { events, sawDone }
}

test('plain text stream emits canonical Responses event sequence', async () => {
  const upstream = upstreamFromLines([
    'data: {"choices":[{"delta":{"content":"he"}}]}\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n',
    'data: [DONE]\n',
  ])
  const { events, sawDone } = await collectEvents(upstream)
  const types = events.map((e) => e.type)
  assert.deepEqual(types, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ])
  const completed = events.find((e) => e.type === 'response.completed') as { response: { usage: { input_tokens: number; output_tokens: number } } }
  assert.equal(completed.response.usage.input_tokens, 12)
  assert.equal(completed.response.usage.output_tokens, 3)
  const textDone = events.find((e) => e.type === 'response.output_text.done') as { text: string }
  assert.equal(textDone.text, 'hello')
  assert.equal(sawDone, true)
})

test('reasoning_content goes through dedicated reasoning events, not output_text', async () => {
  const upstream = upstreamFromLines([
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":"ing"}}]}\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
    'data: [DONE]\n',
  ])
  const { events } = await collectEvents(upstream)
  const types = events.map((e) => e.type)
  // reasoning open
  assert.ok(types.includes('response.output_item.added'))
  assert.ok(types.includes('response.reasoning_summary_part.added'))
  // reasoning deltas use dedicated event
  const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_content.delta')
  assert.equal(reasoningDeltas.length, 2)
  // text uses output_text.delta
  const textDeltas = events.filter((e) => e.type === 'response.output_text.delta')
  assert.equal(textDeltas.length, 1)
})

test('tool_calls produce function_call_arguments.delta + done', async () => {
  const upstream = upstreamFromLines([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"shell"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n',
  ])
  const { events } = await collectEvents(upstream)
  const argDeltas = events.filter((e) => e.type === 'response.function_call_arguments.delta') as Array<{ delta: string }>
  const argDone = events.find((e) => e.type === 'response.function_call_arguments.done') as { arguments: string }
  assert.equal(argDeltas.length, 2)
  assert.equal(argDone.arguments, '{"cmd":"ls"}')
})

test('flattened MCP tool calls restore Responses namespace in stream', async () => {
  const upstream = upstreamFromLines([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_env","type":"function","function":{"name":"mcp__yoho_remote__environment_info"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n',
  ])
  const { events } = await collectEvents(upstream)
  const added = events.find((e) => e.type === 'response.output_item.added') as { item: { name: string; namespace?: string } }
  const done = events.find((e) => e.type === 'response.output_item.done') as { item: { name: string; namespace?: string } }

  assert.equal(added.item.name, 'environment_info')
  assert.equal(added.item.namespace, 'mcp__yoho_remote__')
  assert.equal(done.item.name, 'environment_info')
  assert.equal(done.item.namespace, 'mcp__yoho_remote__')
})

test('uses prompt_tokens / completion_tokens (not input_tokens)', async () => {
  const upstream = upstreamFromLines([
    'data: {"choices":[{"delta":{"content":"x"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n',
    'data: [DONE]\n',
  ])
  const { events } = await collectEvents(upstream)
  const completed = events.find((e) => e.type === 'response.completed') as { response: { usage: { input_tokens: number; output_tokens: number; total_tokens: number } } }
  assert.equal(completed.response.usage.input_tokens, 5)
  assert.equal(completed.response.usage.output_tokens, 1)
  assert.equal(completed.response.usage.total_tokens, 6)
})

test('finish_reason=length yields response.completed with status=incomplete', async () => {
  const upstream = upstreamFromLines([
    'data: {"choices":[{"delta":{"content":"a"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
    'data: [DONE]\n',
  ])
  const { events } = await collectEvents(upstream)
  const completed = events.find((e) => e.type === 'response.completed') as { response: { status: string } }
  assert.equal(completed.response.status, 'incomplete')
})

test('non-stream chat → Responses object', () => {
  const obj = convertChatToResponse({
    id: 'chatcmpl-x',
    choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  }, 'mimo-v2.5-pro')
  assert.equal(obj.status, 'completed')
  assert.equal(obj.model, 'mimo-v2.5-pro')
  assert.equal(obj.usage?.input_tokens, 4)
  assert.equal(obj.usage?.output_tokens, 1)
  const msg = obj.output[0]
  assert.equal(msg.type, 'message')
  if (msg.type === 'message') {
    assert.equal((msg.content[0] as { text: string }).text, 'ok')
  }
})

test('non-stream flattened MCP tool call restores Responses namespace', () => {
  const obj = convertChatToResponse({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call_env',
          type: 'function',
          function: { name: 'mcp__yoho_remote__environment_info', arguments: '{}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }, 'mimo-v2.5-pro')

  const call = obj.output[0]
  assert.equal(call.type, 'function_call')
  if (call.type === 'function_call') {
    assert.equal(call.name, 'environment_info')
    assert.equal(call.namespace, 'mcp__yoho_remote__')
  }
})

test('buildFailureEvent emits response.failed + [DONE]', () => {
  const out = buildFailureEvent('m', 'upstream_402', 'no SKU')
  assert.match(out, /event: response\.failed/)
  assert.match(out, /"status":"failed"/)
  assert.match(out, /data: \[DONE\]/)
})
