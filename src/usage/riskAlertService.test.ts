import assert from 'node:assert/strict'
import test from 'node:test'

import { appConfig } from '../config.js'
import { RiskAlertService } from './riskAlertService.js'
import type { UsageRecord } from './usageStore.js'

function buildRecord(input: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: 'req-test',
    accountId: 'claude-official:test',
    userId: 'user-test',
    sessionKey: 'session-test',
    clientDeviceId: 'device-test',
    model: 'claude-opus-4-7',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    statusCode: 200,
    durationMs: 100,
    target: '/v1/messages',
    rateLimitStatus: 'allowed',
    rateLimit5hUtilization: null,
    rateLimit7dUtilization: null,
    rateLimitReset: null,
    requestHeaders: null,
    requestBodyPreview: null,
    responseHeaders: null,
    responseBodyPreview: null,
    upstreamRequestHeaders: null,
    ...input,
  }
}

test('RiskAlertService does not create immediate Feishu reason for org_level_disabled alone', () => {
  const service = new RiskAlertService(null)
  const collectImmediateReasons = (service as unknown as {
    collectImmediateReasons(record: UsageRecord): Array<{ code: string }>
  }).collectImmediateReasons.bind(service)

  const reasons = collectImmediateReasons(buildRecord({
    responseHeaders: {
      'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
    },
  }))

  assert.deepEqual(reasons, [])
})

test('RiskAlertService still alerts local risk rejections', () => {
  const service = new RiskAlertService(null)
  const collectImmediateReasons = (service as unknown as {
    collectImmediateReasons(record: UsageRecord): Array<{ code: string }>
  }).collectImmediateReasons.bind(service)

  const reasons = collectImmediateReasons(buildRecord({
    statusCode: 403,
    responseBodyPreview: 'routing_guard blocked this request',
  }))

  assert.deepEqual(reasons.map((reason) => reason.code), ['local_risk_rejection'])
})

test('RiskAlertService does not send Feishu for ordinary threshold-only risk', async () => {
  const originalWebhook = appConfig.riskAlertFeishuWebhookUrl
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  ;(appConfig as { riskAlertFeishuWebhookUrl: string | null }).riskAlertFeishuWebhookUrl = 'https://example.invalid/webhook'
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response('ok')
  }) as typeof fetch

  const userStore = {
    async getRiskWindowSnapshot() {
      return {
        userRecentRequests: appConfig.riskAlertUserRequestsPerWindow,
        clientDeviceRecentRequests: appConfig.riskAlertDeviceRequestsPerWindow,
        userRecentTokens: appConfig.riskAlertUserTokensPerWindow,
        clientDeviceRecentTokens: appConfig.riskAlertDeviceTokensPerWindow,
        userDistinctAccounts: appConfig.riskAlertUserAccountsPerWindow,
        clientDeviceDistinctAccounts: appConfig.riskAlertUserAccountsPerWindow,
        sessionDistinctAccounts: appConfig.riskAlertUserAccountsPerWindow,
        sessionAccountSwitches: appConfig.riskAlertSessionAccountSwitchesPerWindow,
        distinctSessions: 1,
      }
    },
    async getNewClaudeAccountRiskSnapshot() {
      return null
    },
  }

  try {
    const service = new RiskAlertService(userStore as never)
    await service.evaluate({
      usageRecordId: 1,
      record: buildRecord(),
      method: 'POST',
      normalizedPath: '/v1/messages',
    })

    assert.equal(fetchCalls, 0)
  } finally {
    ;(appConfig as { riskAlertFeishuWebhookUrl: string | null }).riskAlertFeishuWebhookUrl = originalWebhook
    globalThis.fetch = originalFetch
  }
})

test('RiskAlertService sends Feishu for high-risk local rejection', async () => {
  const originalWebhook = appConfig.riskAlertFeishuWebhookUrl
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  ;(appConfig as { riskAlertFeishuWebhookUrl: string | null }).riskAlertFeishuWebhookUrl = 'https://example.invalid/webhook'
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response('ok')
  }) as typeof fetch

  try {
    const service = new RiskAlertService(null)
    await service.evaluate({
      usageRecordId: 1,
      record: buildRecord({
        statusCode: 403,
        responseBodyPreview: 'routing_guard blocked this request',
      }),
      method: 'POST',
      normalizedPath: '/v1/messages',
    })

    assert.ok(fetchCalls >= 1)
  } finally {
    ;(appConfig as { riskAlertFeishuWebhookUrl: string | null }).riskAlertFeishuWebhookUrl = originalWebhook
    globalThis.fetch = originalFetch
  }
})
