import assert from 'node:assert/strict'
import test from 'node:test'

import { Agent, MockAgent, setGlobalDispatcher } from 'undici'

import type { StoredAccount } from '../types.js'
import {
  buildGeminiAuthorizeUrl,
  buildGeminiChatCompletionsRequest,
  buildGeminiCodeAssistStreamUrl,
  buildGeminiCodeAssistUrl,
  buildGeminiNativeDispatch,
  chatCompletionsSseTerminator,
  deriveGeminiSubscriptionType,
  geminiSseToChatCompletionsChunks,
  getGeminiLoopbackRedirectUri,
  parseGeminiCallback,
  retrieveGeminiUserQuota,
  transformGeminiNonStreamingResponseToChat,
} from './googleGeminiOauth.js'

function buildGeminiAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: overrides.id ?? 'google-gemini-oauth:test',
    provider: overrides.provider ?? 'google-gemini-oauth',
    protocol: overrides.protocol ?? 'openai',
    authMode: overrides.authMode ?? 'oauth',
    label: overrides.label ?? 'test-gemini',
    isActive: overrides.isActive ?? true,
    status: overrides.status ?? 'active',
    lastSelectedAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    lastFailureAt: null,
    cooldownUntil: null,
    lastError: null,
    accessToken: overrides.accessToken ?? 'gemini-test-access-token',
    refreshToken: overrides.refreshToken ?? 'gemini-test-refresh-token',
    expiresAt: overrides.expiresAt ?? null,
    scopes: overrides.scopes ?? [],
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
    subscriptionType: overrides.subscriptionType ?? 'gemini-free',
    providerPlanTypeRaw: null,
    rateLimitTier: null,
    accountUuid: overrides.accountUuid ?? '12345',
    organizationUuid: overrides.organizationUuid ?? 'gemini-project-id-123',
    emailAddress: overrides.emailAddress ?? 'tester@example.com',
    displayName: overrides.displayName ?? 'Tester',
    hasExtraUsageEnabled: null,
    billingType: null,
    accountCreatedAt: null,
    subscriptionCreatedAt: null,
    rawProfile: (overrides.rawProfile as never) ?? ({
      cloudaicompanionProject: 'gemini-project-id-123',
      userTier: 'free-tier',
      emailAddress: 'tester@example.com',
      displayName: 'Tester',
      pictureUrl: null,
      sub: '12345',
    } as never),
    roles: null,
    routingGroupId: null,
    group: null,
    maxSessions: null,
    weight: null,
    schedulerEnabled: true,
    schedulerState: 'enabled',
    autoBlockedReason: null,
    autoBlockedUntil: null,
    lastRateLimitStatus: null,
    lastRateLimit5hUtilization: null,
    lastRateLimit7dUtilization: null,
    lastRateLimitReset: null,
    lastRateLimitAt: null,
    lastProbeAttemptAt: null,
    proxyUrl: null,
    bodyTemplatePath: null,
    vmFingerprintTemplatePath: null,
    deviceId: 'device-1',
    apiBaseUrl: null,
    modelName: overrides.modelName ?? 'gemini-2.5-pro',
    modelTierMap: null,
    modelMap: null,
    loginPassword: null,
  }
}

test('buildGeminiAuthorizeUrl includes PKCE / scope / loopback redirect', () => {
  const url = new URL(
    buildGeminiAuthorizeUrl({
      codeChallenge: 'challenge-abc',
      state: 'state-xyz',
      redirectUri: 'http://127.0.0.1:8085/oauth/callback',
    }),
  )
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-abc')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'state-xyz')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  const scope = url.searchParams.get('scope') ?? ''
  assert.ok(scope.includes('cloud-platform'))
  assert.ok(scope.includes('userinfo.email'))
})

test('buildGeminiCodeAssistUrl produces the v1internal:method form', () => {
  const url = buildGeminiCodeAssistUrl('generateContent')
  assert.equal(url.toString(), 'https://cloudcode-pa.googleapis.com/v1internal:generateContent')
})

test('buildGeminiCodeAssistStreamUrl appends alt=sse', () => {
  const url = buildGeminiCodeAssistStreamUrl('streamGenerateContent')
  assert.equal(url.searchParams.get('alt'), 'sse')
  assert.ok(url.toString().includes('v1internal:streamGenerateContent?alt=sse'))
})

test('deriveGeminiSubscriptionType maps standard tier as Gemini Pro capacity', () => {
  assert.equal(deriveGeminiSubscriptionType('standard-tier'), 'gemini-pro')
  assert.equal(deriveGeminiSubscriptionType('legacy-tier'), 'gemini-pro')
  assert.equal(deriveGeminiSubscriptionType('free-tier'), 'gemini-free')
})

test('retrieveGeminiUserQuota maps request quota bucket to rate limit snapshot', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://cloudcode-pa.googleapis.com')
  pool.intercept({ path: '/v1internal:retrieveUserQuota', method: 'POST' }).reply(
    200,
    {
      buckets: [
        {
          modelId: 'gemini-2.5-flash',
          tokenType: 'REQUESTS',
          remainingFraction: 0.99,
          resetTime: '2026-04-28T10:00:00Z',
        },
        {
          modelId: 'gemini-2.5-flash-lite',
          tokenType: 'REQUESTS',
          remainingFraction: 1,
          resetTime: '2026-04-28T10:00:00Z',
        },
        {
          modelId: 'gemini-2.5-pro',
          tokenType: 'REQUESTS',
          remainingFraction: 0.75,
          resetTime: '2026-04-28T12:00:00Z',
        },
      ],
    },
    { headers: { 'content-type': 'application/json' } },
  )

  const result = await retrieveGeminiUserQuota({
    accessToken: 'gemini-token',
    account: buildGeminiAccount({ modelName: 'gemini-2.5-pro' }),
    proxyDispatcher: undefined,
  })

  assert.equal(result.error, null)
  assert.equal(result.httpStatus, 200)
  assert.equal(result.status, 'allowed')
  assert.equal(result.fiveHourUtilization, 0.25)
  assert.equal(result.fiveHourReset, Date.parse('2026-04-28T12:00:00Z'))
  assert.equal(result.representativeClaim, 'gemini-2.5-pro')
  assert.deepEqual(result.modelUsage, [
    {
      label: 'Flash',
      modelIds: ['gemini-2.5-flash'],
      utilization: 0.010000000000000009,
      remainingFraction: 0.99,
      reset: Date.parse('2026-04-28T10:00:00Z'),
    },
    {
      label: 'Flash Lite',
      modelIds: ['gemini-2.5-flash-lite'],
      utilization: 0,
      remainingFraction: 1,
      reset: Date.parse('2026-04-28T10:00:00Z'),
    },
    {
      label: 'Pro',
      modelIds: ['gemini-2.5-pro'],
      utilization: 0.25,
      remainingFraction: 0.75,
      reset: Date.parse('2026-04-28T12:00:00Z'),
    },
  ])
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('parseGeminiCallback handles full url', () => {
  const parsed = parseGeminiCallback('http://127.0.0.1:8085/oauth/callback?code=abc&state=xyz&scope=foo')
  assert.equal(parsed.code, 'abc')
  assert.equal(parsed.state, 'xyz')
})

test('parseGeminiCallback throws on error', () => {
  assert.throws(
    () => parseGeminiCallback('http://127.0.0.1:8085/oauth/callback?error=access_denied'),
    /access_denied/,
  )
})

test('getGeminiLoopbackRedirectUri uses configured host/port/path', () => {
  const uri = getGeminiLoopbackRedirectUri()
  assert.match(uri, /^http:\/\/127\.0\.0\.1:8085\/oauth\/callback$/)
})

test('buildGeminiChatCompletionsRequest converts OpenAI chat to Vertex envelope', async () => {
  const account = buildGeminiAccount()
  const body = Buffer.from(
    JSON.stringify({
      model: 'gemini-2.5-pro',
      stream: true,
      temperature: 0.5,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello there' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"weather"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny.' },
      ],
    }),
    'utf8',
  )
  const result = await buildGeminiChatCompletionsRequest({ rawBody: body, account, promptId: 'req-123' })
  assert.equal(result.stream, true)
  assert.equal(result.model, 'gemini-2.5-pro')
  const parsed = JSON.parse(result.upstreamBody.toString('utf8')) as {
    model: string
    project: string
    user_prompt_id: string
    request: {
      systemInstruction?: { role: string; parts: Array<{ text: string }> }
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
      generationConfig?: { temperature?: number }
    }
  }
  assert.equal(parsed.model, 'gemini-2.5-pro')
  assert.equal(parsed.project, 'gemini-project-id-123')
  assert.equal(parsed.user_prompt_id, 'req-123')
  assert.deepEqual(parsed.request.systemInstruction?.parts[0], { text: 'You are helpful.' })
  assert.equal(parsed.request.generationConfig?.temperature, 0.5)
  assert.equal(parsed.request.contents.length, 3)
  assert.equal(parsed.request.contents[0]!.role, 'user')
  assert.equal((parsed.request.contents[0]!.parts[0] as { text: string }).text, 'Hello there')
  assert.equal(parsed.request.contents[1]!.role, 'model')
  assert.equal(parsed.request.contents[2]!.role, 'function')
  const fnResp = parsed.request.contents[2]!.parts[0] as {
    functionResponse: { name: string; response: { content: string } }
  }
  assert.equal(fnResp.functionResponse.name, 'lookup')
  assert.equal(fnResp.functionResponse.response.content, 'Sunny.')
})

test('transformGeminiNonStreamingResponseToChat maps Vertex candidates to chat completion', () => {
  const account = buildGeminiAccount()
  const upstream = {
    response: {
      candidates: [
        {
          content: { parts: [{ text: 'hi there' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      modelVersion: 'gemini-2.5-pro-001',
    },
  }
  const result = transformGeminiNonStreamingResponseToChat({
    body: Buffer.from(JSON.stringify(upstream), 'utf8'),
    account,
    model: 'gemini-2.5-pro',
  })
  const parsed = JSON.parse(result.body.toString('utf8')) as {
    object: string
    choices: Array<{ message: { content: string }; finish_reason: string }>
    usage: { total_tokens: number }
  }
  assert.equal(parsed.object, 'chat.completion')
  assert.equal(parsed.choices[0]!.message.content, 'hi there')
  assert.equal(parsed.choices[0]!.finish_reason, 'stop')
  assert.equal(parsed.usage.total_tokens, 15)
})

test('geminiSseToChatCompletionsChunks emits delta + finish events', () => {
  const sse = JSON.stringify({
    response: {
      candidates: [
        {
          content: { parts: [{ text: 'hello' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      modelVersion: 'gemini-2.5-pro-001',
    },
  })
  const events = geminiSseToChatCompletionsChunks({
    ssePayload: sse,
    model: 'gemini-2.5-pro',
    completionId: 'chatcmpl-test',
  })
  assert.equal(events.length, 2)
  assert.match(events[0]!, /"delta":\{"role":"assistant","content":"hello"\}/)
  assert.match(events[1]!, /"finish_reason":"stop"/)
  assert.equal(chatCompletionsSseTerminator(), 'data: [DONE]\n\n')
})

test('buildGeminiChatCompletionsRequest falls back to default model when missing', async () => {
  const account = buildGeminiAccount({ modelName: '' })
  const body = Buffer.from(
    JSON.stringify({ messages: [{ role: 'user', content: 'hey' }] }),
    'utf8',
  )
  const result = await buildGeminiChatCompletionsRequest({ rawBody: body, account })
  assert.equal(result.model, 'gemini-3.1-pro')
})

// ──────────────────────────────────────────────────────────────────────────
// Stage A: OpenAI compat coverage
// ──────────────────────────────────────────────────────────────────────────

type ParsedEnvelope = {
  model: string
  request: {
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
    systemInstruction?: { role: string; parts: Array<{ text: string }> }
    generationConfig?: Record<string, unknown>
    tools?: Array<{ functionDeclarations: Array<{ name: string }> }>
    toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } }
    safetySettings?: unknown[]
  }
}

function buildBasicChatBody(extra: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'lookup', parameters: { type: 'object' } },
        },
      ],
      ...extra,
    }),
    'utf8',
  )
}

async function buildEnvelope(extra: Record<string, unknown>): Promise<ParsedEnvelope> {
  const account = buildGeminiAccount()
  const body = buildBasicChatBody(extra)
  const result = await buildGeminiChatCompletionsRequest({ rawBody: body, account })
  return JSON.parse(result.upstreamBody.toString('utf8')) as ParsedEnvelope
}

test('openai compat: tool_choice "auto" maps to AUTO mode', async () => {
  const env = await buildEnvelope({ tool_choice: 'auto' })
  assert.equal(env.request.toolConfig?.functionCallingConfig.mode, 'AUTO')
  assert.equal(env.request.tools?.[0]!.functionDeclarations.length, 1)
})

test('openai compat: tool_choice "none" maps to NONE and tools still sent', async () => {
  const env = await buildEnvelope({ tool_choice: 'none' })
  assert.equal(env.request.toolConfig?.functionCallingConfig.mode, 'NONE')
  assert.equal(env.request.tools?.[0]!.functionDeclarations[0]!.name, 'lookup')
})

test('openai compat: tool_choice "required" maps to ANY', async () => {
  const env = await buildEnvelope({ tool_choice: 'required' })
  assert.equal(env.request.toolConfig?.functionCallingConfig.mode, 'ANY')
})

test('openai compat: tool_choice {type:function, function:{name}} sets allowedFunctionNames', async () => {
  const env = await buildEnvelope({
    tool_choice: { type: 'function', function: { name: 'lookup' } },
  })
  assert.equal(env.request.toolConfig?.functionCallingConfig.mode, 'ANY')
  assert.deepEqual(env.request.toolConfig?.functionCallingConfig.allowedFunctionNames, ['lookup'])
})

test('openai compat: streaming tool_calls emits two-stage delta (declaration then full args)', () => {
  const sse = JSON.stringify({
    response: {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'lookup', args: { q: 'weather' } } },
            ],
            role: 'model',
          },
          finishReason: 'TOOL_USE',
        },
      ],
      modelVersion: 'gemini-2.5-pro-001',
    },
  })
  const events = geminiSseToChatCompletionsChunks({
    ssePayload: sse,
    model: 'gemini-2.5-pro',
    completionId: 'chatcmpl-toolcall',
  })
  assert.equal(events.length, 3)
  // First: declaration with empty arguments
  assert.match(events[0]!, /"function":\{"name":"lookup","arguments":""\}/)
  assert.match(events[0]!, /"role":"assistant"/)
  // Second: arguments-only delta with full JSON
  assert.match(events[1]!, /"arguments":"\{\\"q\\":\\"weather\\"\}"/)
  assert.ok(!events[1]!.includes('"name":"lookup"'), 'second chunk must not repeat name')
  // Third: finish reason chunk
  assert.match(events[2]!, /"finish_reason":"tool_calls"/)
})

test('openai compat: response_format json_schema sets responseSchema and responseMimeType', async () => {
  const env = await buildEnvelope({
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'Weather',
        schema: {
          type: 'object',
          properties: { city: { type: 'string' }, temp: { type: 'number' } },
        },
      },
    },
  })
  assert.equal(env.request.generationConfig?.responseMimeType, 'application/json')
  const schema = env.request.generationConfig?.responseSchema as { type?: string } | undefined
  assert.equal(schema?.type, 'object')
})

test('openai compat: n=2 produces choices[0] and choices[1] with separate finish_reason', () => {
  const account = buildGeminiAccount()
  const upstream = {
    response: {
      candidates: [
        {
          content: { parts: [{ text: 'A' }], role: 'model' },
          finishReason: 'STOP',
        },
        {
          content: { parts: [{ text: 'B' }], role: 'model' },
          finishReason: 'MAX_TOKENS',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      modelVersion: 'gemini-2.5-pro-001',
    },
  }
  const result = transformGeminiNonStreamingResponseToChat({
    body: Buffer.from(JSON.stringify(upstream), 'utf8'),
    account,
    model: 'gemini-2.5-pro',
  })
  const parsed = JSON.parse(result.body.toString('utf8')) as {
    choices: Array<{ index: number; message: { content: string }; finish_reason: string }>
  }
  assert.equal(parsed.choices.length, 2)
  assert.equal(parsed.choices[0]!.index, 0)
  assert.equal(parsed.choices[0]!.message.content, 'A')
  assert.equal(parsed.choices[0]!.finish_reason, 'stop')
  assert.equal(parsed.choices[1]!.index, 1)
  assert.equal(parsed.choices[1]!.message.content, 'B')
  assert.equal(parsed.choices[1]!.finish_reason, 'length')
})

test('openai compat: extra_body.safetySettings forwarded into requestPayload.safetySettings', async () => {
  const env = await buildEnvelope({
    extra_body: {
      safetySettings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      ],
    },
  })
  assert.deepEqual(env.request.safetySettings, [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  ])
})

test('openai compat: image_url with remote https URL fetched and inlined as base64', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  agent.get('https://images.example.com')
    .intercept({ path: '/foo.png', method: 'GET' })
    .reply(200, pngBytes, { headers: { 'content-type': 'image/png' } })

  const account = buildGeminiAccount()
  const body = Buffer.from(
    JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'see this:' },
          { type: 'image_url', image_url: { url: 'https://images.example.com/foo.png' } },
        ],
      }],
    }),
    'utf8',
  )
  const result = await buildGeminiChatCompletionsRequest({ rawBody: body, account })
  const env = JSON.parse(result.upstreamBody.toString('utf8')) as ParsedEnvelope
  const parts = env.request.contents[0]!.parts as Array<Record<string, unknown>>
  assert.equal(parts.length, 2)
  const inlineData = parts[1] as { inlineData: { mimeType: string; data: string } }
  assert.equal(inlineData.inlineData.mimeType, 'image/png')
  assert.equal(inlineData.inlineData.data, pngBytes.toString('base64'))
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('openai compat: image_url with oversized remote body replaced by text fallback', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const oversize = Buffer.alloc(5 * 1024 * 1024, 0x77)
  agent.get('https://images.example.com')
    .intercept({ path: '/big.png', method: 'GET' })
    .reply(200, oversize, { headers: { 'content-type': 'image/png' } })

  const account = buildGeminiAccount()
  const body = Buffer.from(
    JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://images.example.com/big.png' } },
        ],
      }],
    }),
    'utf8',
  )
  const result = await buildGeminiChatCompletionsRequest({ rawBody: body, account })
  const env = JSON.parse(result.upstreamBody.toString('utf8')) as ParsedEnvelope
  const parts = env.request.contents[0]!.parts as Array<{ text?: string }>
  assert.equal(parts.length, 1)
  assert.match(parts[0]!.text ?? '', /could not be loaded:.*exceeds 4194304 bytes/)
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('openai compat: finishReason MALFORMED_FUNCTION_CALL maps to tool_calls', () => {
  const upstream = {
    response: {
      candidates: [
        {
          content: { parts: [{ text: 'oops' }], role: 'model' },
          finishReason: 'MALFORMED_FUNCTION_CALL',
        },
      ],
      modelVersion: 'gemini-2.5-pro-001',
    },
  }
  const result = transformGeminiNonStreamingResponseToChat({
    body: Buffer.from(JSON.stringify(upstream), 'utf8'),
    account: buildGeminiAccount(),
    model: 'gemini-2.5-pro',
  })
  const parsed = JSON.parse(result.body.toString('utf8')) as {
    choices: Array<{ finish_reason: string }>
  }
  assert.equal(parsed.choices[0]!.finish_reason, 'tool_calls')
})

test('openai compat: presence_penalty in body throws unsupported_parameters', async () => {
  const account = buildGeminiAccount()
  const body = Buffer.from(
    JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      presence_penalty: 0.5,
    }),
    'utf8',
  )
  await assert.rejects(
    () => buildGeminiChatCompletionsRequest({ rawBody: body, account }),
    /unsupported_parameters: presence_penalty/,
  )
})

test('openai compat: multiple unsupported params listed together', async () => {
  const account = buildGeminiAccount()
  const body = Buffer.from(
    JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      seed: 1,
      logit_bias: { 1: 0.5 },
    }),
    'utf8',
  )
  await assert.rejects(
    () => buildGeminiChatCompletionsRequest({ rawBody: body, account }),
    /unsupported_parameters: seed, logit_bias/,
  )
})

// ──────────────────────────────────────────────────────────────────────────
// Stage B: Gemini native protocol dispatch
// ──────────────────────────────────────────────────────────────────────────

test('native: GET /v1beta/models maps to /v1internal/models with no body, untested=true', () => {
  const account = buildGeminiAccount()
  const dispatch = buildGeminiNativeDispatch({
    pathname: '/v1beta/models',
    method: 'GET',
    rawBody: undefined,
    account,
    promptId: 'req-list-1',
  })
  assert.equal(dispatch.upstreamMethod, 'GET')
  assert.equal(dispatch.upstreamBody, null)
  assert.equal(dispatch.isStream, false)
  assert.equal(dispatch.untestedAgainstCodeAssist, true)
  assert.equal(
    dispatch.upstreamUrl.toString(),
    'https://cloudcode-pa.googleapis.com/v1internal/models',
  )
})

test('native: GET /v1beta/models/{model} maps to /v1internal/models/{model}', () => {
  const dispatch = buildGeminiNativeDispatch({
    pathname: '/v1beta/models/gemini-2.5-pro',
    method: 'GET',
    rawBody: undefined,
    account: buildGeminiAccount(),
    promptId: 'req-models-2',
  })
  assert.equal(dispatch.upstreamMethod, 'GET')
  assert.equal(
    dispatch.upstreamUrl.toString(),
    'https://cloudcode-pa.googleapis.com/v1internal/models/gemini-2.5-pro',
  )
  assert.equal(dispatch.untestedAgainstCodeAssist, true)
})

test('native: POST .../{model}:generateContent wraps body into envelope with project+user_prompt_id', () => {
  const account = buildGeminiAccount()
  const clientBody = Buffer.from(
    JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { temperature: 0.4 },
    }),
    'utf8',
  )
  const dispatch = buildGeminiNativeDispatch({
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent',
    method: 'POST',
    rawBody: clientBody,
    account,
    promptId: 'req-gen-3',
  })
  assert.equal(dispatch.upstreamMethod, 'POST')
  assert.equal(dispatch.isStream, false)
  assert.equal(dispatch.untestedAgainstCodeAssist, false)
  assert.equal(
    dispatch.upstreamUrl.toString(),
    'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
  )
  const envelope = JSON.parse(dispatch.upstreamBody!.toString('utf8')) as {
    model: string
    project: string
    user_prompt_id: string
    request: { contents: unknown[]; generationConfig: { temperature: number } }
  }
  assert.equal(envelope.model, 'gemini-2.5-pro')
  assert.equal(envelope.project, 'gemini-project-id-123')
  assert.equal(envelope.user_prompt_id, 'req-gen-3')
  assert.equal(envelope.request.generationConfig.temperature, 0.4)
})

test('native: POST .../{model}:streamGenerateContent uses alt=sse and isStream=true', () => {
  const dispatch = buildGeminiNativeDispatch({
    pathname: '/v1beta/models/gemini-2.5-pro:streamGenerateContent',
    method: 'POST',
    rawBody: Buffer.from(JSON.stringify({ contents: [] }), 'utf8'),
    account: buildGeminiAccount(),
    promptId: 'req-stream-4',
  })
  assert.equal(dispatch.isStream, true)
  assert.equal(dispatch.upstreamUrl.searchParams.get('alt'), 'sse')
  assert.ok(dispatch.upstreamUrl.toString().includes(':streamGenerateContent'))
  assert.equal(dispatch.untestedAgainstCodeAssist, false)
})

test('native: POST .../{model}:countTokens forwards minimal envelope and is marked untested', () => {
  const clientBody = Buffer.from(
    JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    'utf8',
  )
  const dispatch = buildGeminiNativeDispatch({
    pathname: '/v1beta/models/gemini-2.5-pro:countTokens',
    method: 'POST',
    rawBody: clientBody,
    account: buildGeminiAccount(),
    promptId: 'req-count-5',
  })
  assert.equal(dispatch.untestedAgainstCodeAssist, true)
  assert.equal(
    dispatch.upstreamUrl.toString(),
    'https://cloudcode-pa.googleapis.com/v1internal:countTokens',
  )
  const envelope = JSON.parse(dispatch.upstreamBody!.toString('utf8')) as Record<string, unknown>
  assert.equal(envelope.model, 'gemini-2.5-pro')
  assert.equal(typeof envelope.request, 'object')
  // user_prompt_id should not be set for non-generate methods
  assert.equal(envelope.user_prompt_id, undefined)
})

test('native: invalid path or unsupported method throws', () => {
  const account = buildGeminiAccount()
  // Wrong method on models list
  assert.throws(
    () =>
      buildGeminiNativeDispatch({
        pathname: '/v1beta/models',
        method: 'POST',
        rawBody: Buffer.from('{}', 'utf8'),
        account,
        promptId: 'r',
      }),
    /unsupported method/,
  )
  // Non-matching path
  assert.throws(
    () =>
      buildGeminiNativeDispatch({
        pathname: '/v1beta/whatever',
        method: 'GET',
        rawBody: undefined,
        account,
        promptId: 'r',
      }),
    /unsupported gemini native path/,
  )
  // GET on a method-style endpoint
  assert.throws(
    () =>
      buildGeminiNativeDispatch({
        pathname: '/v1beta/models/foo:generateContent',
        method: 'GET',
        rawBody: undefined,
        account,
        promptId: 'r',
      }),
    /unsupported method/,
  )
})
