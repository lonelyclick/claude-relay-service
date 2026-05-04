import assert from 'node:assert/strict'
import test from 'node:test'

import { closeBaseRuntime } from './baseRuntime.js'

test('closeBaseRuntime closes all DB-backed stores', async () => {
  const closed: string[] = []

  await closeBaseRuntime({
    tokenStore: { close: async () => { closed.push('tokenStore') } } as never,
    healthTracker: {} as never,
    scheduler: {} as never,
    fingerprintCache: {} as never,
    usageStore: { close: async () => { closed.push('usageStore') } } as never,
    userStore: { close: async () => { closed.push('userStore') } } as never,
    organizationStore: { close: async () => { closed.push('organizationStore') } } as never,
    apiKeyStore: { close: async () => { closed.push('apiKeyStore') } } as never,
    billingStore: { close: async () => { closed.push('billingStore') } } as never,
    supportStore: { close: async () => { closed.push('supportStore') } } as never,
    oauthService: {} as never,
    accountLifecycleStore: {} as never,
    accountRiskStore: { close: async () => { closed.push('accountRiskStore') } } as never,
    accountRiskService: { close: async () => { closed.push('accountRiskService') } } as never,
    mailerSendLogStore: {} as never,
    mailerService: {} as never,
    recipientResolver: { close: async () => { closed.push('recipientResolver') } } as never,
    balanceAlertScheduler: { stop: () => undefined } as never,
    balanceAlertPool: { end: async () => { closed.push('balanceAlertPool') } } as never,
  })

  assert.deepEqual(
    closed.sort(),
    [
      'apiKeyStore',
      'accountRiskService',
      'accountRiskStore',
      'balanceAlertPool',
      'billingStore',
      'organizationStore',
      'recipientResolver',
      'supportStore',
      'tokenStore',
      'usageStore',
      'userStore',
    ].sort(),
  )
})
