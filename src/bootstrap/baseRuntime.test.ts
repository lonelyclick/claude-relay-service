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
  })

  assert.deepEqual(
    closed.sort(),
    ['apiKeyStore', 'billingStore', 'supportStore', 'tokenStore', 'usageStore', 'userStore'].sort(),
  )
})
