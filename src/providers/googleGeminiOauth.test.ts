import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoredAccount } from '../types.js'
import {
  buildGeminiAuthorizeUrl,
  buildGeminiChatCompletionsRequest,
  buildGeminiCodeAssistStreamUrl,
  buildGeminiCodeAssistUrl,
  chatCompletionsSseTerminator,
  geminiSseToChatCompletionsChunks,
  getGeminiLoopbackRedirectUri,
  parseGeminiCallback,
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

test('buildGeminiChatCompletionsRequest converts OpenAI chat to Vertex envelope', () => {
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
  const result = buildGeminiChatCompletionsRequest({ rawBody: body, account, promptId: 'req-123' })
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

test('buildGeminiChatCompletionsRequest falls back to default model when missing', () => {
  const account = buildGeminiAccount({ modelName: '' })
  const body = Buffer.from(
    JSON.stringify({ messages: [{ role: 'user', content: 'hey' }] }),
    'utf8',
  )
  const result = buildGeminiChatCompletionsRequest({ rawBody: body, account })
  assert.equal(result.model, 'gemini-2.5-pro')
})
