import assert from 'node:assert/strict'
import test from 'node:test'

import { convertResponsesToChat } from './requestConverter.js'

test('string input becomes single user message; instructions become system', () => {
  const chat = convertResponsesToChat({
    model: 'gpt-5.5',
    instructions: 'you are mimo',
    input: 'hi',
  })
  assert.equal(chat.model, 'gpt-5.5')
  assert.equal(chat.messages.length, 2)
  assert.deepEqual(chat.messages[0], { role: 'system', content: 'you are mimo' })
  assert.deepEqual(chat.messages[1], { role: 'user', content: 'hi' })
  assert.deepEqual(chat.stream_options, { include_usage: true })
})

test('input array with message + function_call attaches tool_calls to assistant', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: 'find files' },
      { type: 'message', role: 'assistant', content: 'sure' },
      { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_a' },
      { type: 'function_call_output', call_id: 'call_a', output: 'README.md\n' },
    ],
  })
  // user, assistant(with tool_call attached), tool — function_call attaches to last assistant
  assert.equal(chat.messages.length, 3)
  assert.equal(chat.messages[1].role, 'assistant')
  assert.equal(chat.messages[1].tool_calls?.[0]?.id, 'call_a')
  assert.equal(chat.messages[1].tool_calls?.[0]?.function.name, 'shell')
  assert.equal(chat.messages[2].role, 'tool')
  assert.equal(chat.messages[2].tool_call_id, 'call_a')
})

test('tool with top-level name is converted to chat function tool', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: 'x',
    tools: [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } }],
  })
  assert.equal(chat.tools?.[0]?.function.name, 'shell')
  assert.equal(chat.tools?.[0]?.function.description, 'run')
})

test('tool nested under .function is preserved', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: 'x',
    tools: [{ type: 'function', function: { name: 'fs.read', parameters: { type: 'object' } } }],
  })
  assert.equal(chat.tools?.[0]?.function.name, 'fs.read')
})

test('namespace tools are flattened to chat function tools', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: 'x',
    tools: [
      {
        type: 'namespace',
        name: 'mcp__yoho_remote__',
        description: 'Yoho Remote tools',
        tools: [
          {
            type: 'function',
            name: 'environment_info',
            description: 'Get environment info',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    ],
  })

  assert.equal(chat.tools?.[0]?.function.name, 'mcp__yoho_remote__environment_info')
  assert.equal(chat.tools?.[0]?.function.description, 'Get environment info')
})

test('namespaced function_call history is flattened for chat replay', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'assistant', content: '' },
      {
        type: 'function_call',
        namespace: 'mcp__yoho_remote__',
        name: 'environment_info',
        arguments: '{}',
        call_id: 'call_env',
      },
    ],
  })

  assert.equal(chat.messages[0]?.tool_calls?.[0]?.function.name, 'mcp__yoho_remote__environment_info')
})

test('reasoning input items are skipped (not replayed to chat-only upstreams)', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }] },
      { type: 'message', role: 'user', content: 'go' },
    ],
  })
  assert.equal(chat.messages.length, 1)
  assert.equal(chat.messages[0].role, 'user')
  assert.equal(chat.messages[0].content, 'go')
})

test('max_output_tokens maps to max_tokens', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: 'x',
    max_output_tokens: 256,
  })
  assert.equal(chat.max_tokens, 256)
})

test('Responses-only fields (store, reasoning, include) are dropped', () => {
  const chat = convertResponsesToChat({
    model: 'm',
    input: 'x',
    store: false,
    reasoning: { effort: 'low' },
    include: ['reasoning'],
  })
  assert.ok(!('store' in chat))
  assert.ok(!('reasoning' in chat))
  assert.ok(!('include' in chat))
})
