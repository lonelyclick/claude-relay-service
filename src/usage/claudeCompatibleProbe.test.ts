import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Agent,
  MockAgent,
  setGlobalDispatcher,
} from 'undici'

import type { StoredAccount } from '../types.js'
import { probeClaudeCompatibleConnectivity } from './claudeCompatibleProbe.js'

function buildAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  const nowIso = '2026-04-28T00:00:00.000Z'
  return {
    id: 'claude-compatible:test-1',
    provider: 'claude-compatible',
    protocol: 'claude',
    authMode: 'api_key',
    label: 'test',
    isActive: true,
    status: 'active',
    lastSelectedAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    lastFailureAt: null,
    cooldownUntil: null,
    lastError: null,
    accessToken: 'sk-test-key',
    refreshToken: null,
    expiresAt: null,
    scopes: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    subscriptionType: null,
    rateLimitTier: null,
    accountUuid: 'test-1',
    organizationUuid: 'org-test-1',
    emailAddress: 'test@example.com',
    displayName: 'test',
    hasExtraUsageEnabled: null,
    billingType: null,
    accountCreatedAt: null,
    subscriptionCreatedAt: null,
    rawProfile: null,
    roles: null,
    routingGroupId: null,
    group: null,
    maxSessions: 5,
    weight: 1,
    planType: null,
    planMultiplier: null,
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
    deviceId: 'device',
    apiBaseUrl: 'https://api.example.test',
    modelName: 'claude-haiku-4-5',
    modelTierMap: null,
    loginPassword: null,
    ...overrides,
  } as StoredAccount
}

test('claude-compatible probe returns ok on 200', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://api.example.test')
  pool.intercept({ path: '/v1/messages', method: 'POST' }).reply(
    200,
    { id: 'msg_1', model: 'claude-haiku-4-5', content: [] },
    { headers: { 'content-type': 'application/json' } },
  )

  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount(),
    anthropicVersion: '2023-06-01',
  })

  assert.equal(result.kind, 'claude-compatible-connectivity')
  assert.equal(result.status, 'ok')
  assert.equal(result.httpStatus, 200)
  assert.equal(result.upstreamModel, 'claude-haiku-4-5')
  assert.equal(result.errorMessage, null)
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('claude-compatible probe maps 401 to auth_failed', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://api.example.test')
  pool.intercept({ path: '/v1/messages', method: 'POST' }).reply(
    401,
    { error: { message: 'invalid api key' } },
    { headers: { 'content-type': 'application/json' } },
  )

  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount(),
    anthropicVersion: '2023-06-01',
  })

  assert.equal(result.status, 'auth_failed')
  assert.equal(result.httpStatus, 401)
  assert.equal(result.errorMessage, 'invalid api key')
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('claude-compatible probe maps 4xx (model-not-found) to reachable', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://api.example.test')
  pool.intercept({ path: '/v1/messages', method: 'POST' }).reply(
    404,
    { error: { message: 'model not found' } },
    { headers: { 'content-type': 'application/json' } },
  )

  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount(),
    anthropicVersion: '2023-06-01',
  })

  assert.equal(result.status, 'reachable')
  assert.equal(result.httpStatus, 404)
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('claude-compatible probe returns misconfigured when apiBaseUrl missing', async () => {
  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount({ apiBaseUrl: null as unknown as string }),
    anthropicVersion: '2023-06-01',
  })

  assert.equal(result.status, 'misconfigured')
  assert.equal(result.httpStatus, null)
  assert.match(result.errorMessage ?? '', /apiBaseUrl/)
})

test('claude-compatible probe prefers modelTierMap.haiku, ignores opus modelName', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://api.example.test')
  let receivedBody: string | null = null
  pool.intercept({ path: '/v1/messages', method: 'POST' }).reply((opts) => {
    receivedBody = typeof opts.body === 'string' ? opts.body : null
    return {
      statusCode: 200,
      data: { id: 'm', model: 'tier-haiku', content: [] },
      responseOptions: { headers: { 'content-type': 'application/json' } },
    }
  })

  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount({
      modelName: 'claude-opus-4.7',
      modelTierMap: { haiku: 'tier-haiku', sonnet: null, opus: null },
    } as unknown as Partial<StoredAccount>),
    anthropicVersion: '2023-06-01',
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.probedModel, 'tier-haiku')
  assert.ok(receivedBody && JSON.parse(receivedBody).model === 'tier-haiku')
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('claude-compatible probe falls back to modelName when no haiku mapping, normalizing dotted form', async () => {
  // Some upstream channels (e.g. purecc on openclaudecode.cn) only expose the operator's
  // configured model, not the haiku default. Falling back to modelName makes the probe
  // reflect the account's actual reachable model instead of producing a false negative.
  // Dotted forms (claude-opus-4.7) are normalized to dash (claude-opus-4-7) — Anthropic's
  // canonical spelling and what most compatible upstreams accept.
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://api.example.test')
  let receivedBody: string | null = null
  pool.intercept({ path: '/v1/messages', method: 'POST' }).reply((opts) => {
    receivedBody = typeof opts.body === 'string' ? opts.body : null
    return {
      statusCode: 200,
      data: { id: 'm', model: 'claude-opus-4-7', content: [] },
      responseOptions: { headers: { 'content-type': 'application/json' } },
    }
  })

  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount({
      modelName: 'claude-opus-4.7',
      modelTierMap: null,
    } as unknown as Partial<StoredAccount>),
    anthropicVersion: '2023-06-01',
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.probedModel, 'claude-opus-4-7')
  assert.ok(receivedBody && JSON.parse(receivedBody).model === 'claude-opus-4-7')
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('claude-compatible probe wraps body with BODY_TEMPLATE when supplied', async () => {
  // Strict-validation upstreams (openclaudecode.cn) reject simple ping bodies. When a
  // BODY_TEMPLATE is configured, probe must mirror a real Claude Code request so the
  // upstream's "is this the real CLI" check passes.
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://api.example.test')
  const captured: { body: string | null; path: string | null; headers: Record<string, string | string[] | undefined> | null } = {
    body: null,
    path: null,
    headers: null,
  }
  pool.intercept({ path: /\/v1\/messages/, method: 'POST' }).reply((opts) => {
    captured.body = typeof opts.body === 'string' ? opts.body : null
    captured.path = typeof opts.path === 'string' ? opts.path : null
    captured.headers = opts.headers as Record<string, string | string[] | undefined>
    return {
      statusCode: 200,
      data: { id: 'm', model: 'claude-opus-4-7', content: [] },
      responseOptions: { headers: { 'content-type': 'application/json' } },
    }
  })

  const template = {
    ccVersion: '2.1.112.e61',
    ccEntrypoint: 'sdk-cli',
    anthropicBeta: 'claude-code-20250219,context-1m-2025-08-07',
    systemBlocks: [{ type: 'text', text: 'You are a Claude agent.', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Bash' }],
    deviceId: 'tpl-device',
    accountUuid: 'tpl-account',
    cacheControl: { type: 'ephemeral' as const },
  }

  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount({ modelName: 'claude-opus-4.7' } as unknown as Partial<StoredAccount>),
    anthropicVersion: '2023-06-01',
    bodyTemplate: template,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.probedModel, 'claude-opus-4-7')
  assert.ok(captured.path?.includes('?beta=true'), `expected path to include ?beta=true, got ${captured.path}`)
  const parsedBody = JSON.parse(captured.body!) as Record<string, unknown>
  assert.equal(parsedBody.model, 'claude-opus-4-7')
  assert.equal(parsedBody.max_tokens, 1)
  assert.deepEqual(parsedBody.thinking, { type: 'adaptive' })
  assert.ok(parsedBody.context_management, 'context_management should be present')
  assert.ok(parsedBody.output_config, 'output_config should be present')
  const system = parsedBody.system as Array<{ text: string }>
  assert.match(system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.112\.e61.*cch=00000;$/)
  assert.equal((system[0] as { cache_control?: unknown }).cache_control, undefined, 'system[0] must not carry cache_control')
  assert.equal(system[1].text, 'You are a Claude agent.')
  assert.deepEqual(parsedBody.tools, [{ name: 'Bash' }])
  const meta = parsedBody.metadata as { user_id: string }
  const userId = JSON.parse(meta.user_id) as Record<string, unknown>
  assert.equal(userId.device_id, 'tpl-device')
  assert.equal(userId.account_uuid, 'tpl-account')
  assert.match(String(userId.session_id), /^[0-9a-f-]{36}$/, 'session_id must be a UUID')
  // Required Claude Code-style headers
  const headers = captured.headers!
  assert.equal(headers['anthropic-beta'], 'claude-code-20250219,context-1m-2025-08-07')
  assert.match(String(headers['user-agent']), /^claude-cli\/2\.1\.112 /)
  assert.equal(headers['x-app'], 'cli')
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true')
  await agent.close()
  setGlobalDispatcher(new Agent())
})

test('claude-compatible probe uses default haiku when no haiku mapping and no modelName', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  const pool = agent.get('https://api.example.test')
  let receivedBody: string | null = null
  pool.intercept({ path: '/v1/messages', method: 'POST' }).reply((opts) => {
    receivedBody = typeof opts.body === 'string' ? opts.body : null
    return {
      statusCode: 200,
      data: { id: 'm', model: 'claude-haiku-4-5', content: [] },
      responseOptions: { headers: { 'content-type': 'application/json' } },
    }
  })

  const result = await probeClaudeCompatibleConnectivity({
    account: buildAccount({
      modelName: null,
      modelTierMap: null,
    } as unknown as Partial<StoredAccount>),
    anthropicVersion: '2023-06-01',
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.probedModel, 'claude-haiku-4-5')
  assert.ok(receivedBody && JSON.parse(receivedBody).model === 'claude-haiku-4-5')
  await agent.close()
  setGlobalDispatcher(new Agent())
})
