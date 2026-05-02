import assert from 'node:assert/strict'
import test from 'node:test'

import {
  tryParseMessageBody,
  validateCliRequest,
  validateCliRequestBody,
  validateCliRequestConsistency,
  validateCliRequestHeaders,
  type ParsedMessageBody,
} from './cliValidator.js'

const VALID_DEVICE_ID = 'a'.repeat(64)
const VALID_ACCOUNT_UUID = '11111111-2222-3333-4444-555555555555'

function makeHeaders(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    'user-agent': 'claude-cli/2.1.112 (external, sdk-cli) Linux',
    'x-app': 'cli',
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.81.0',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v24.12.0',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'accept-encoding': 'gzip, deflate',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[key]
    } else {
      base[key] = value
    }
  }
  return base
}

function makeBody(overrides: Partial<ParsedMessageBody> = {}): ParsedMessageBody {
  return {
    system: [
      {
        type: 'text',
        text: 'polling-header: cc_version=2.1.112.e61; cc_entrypoint=sdk-cli; cch=00000;',
      },
      { type: 'text', text: 'block 1' },
      { type: 'text', text: 'block 2' },
    ],
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hi' }],
    metadata: {
      user_id: JSON.stringify({
        device_id: VALID_DEVICE_ID,
        account_uuid: VALID_ACCOUNT_UUID,
      }),
    },
    ...overrides,
  }
}

test('cliValidator', async (t) => {
  await t.test('L2: passes a clean header set', () => {
    assert.equal(validateCliRequestHeaders(makeHeaders()), null)
  })

  await t.test('L2: rejects missing x-app', () => {
    const failure = validateCliRequestHeaders(makeHeaders({ 'x-app': undefined }))
    assert.equal(failure?.layer, 'L2')
    assert.equal(failure?.field, 'x-app')
  })

  await t.test('L2: rejects wrong x-stainless-lang', () => {
    const failure = validateCliRequestHeaders(makeHeaders({ 'x-stainless-lang': 'python' }))
    assert.equal(failure?.layer, 'L2')
    assert.equal(failure?.field, 'x-stainless-lang')
  })

  await t.test('L2: rejects unknown x-stainless-os', () => {
    const failure = validateCliRequestHeaders(makeHeaders({ 'x-stainless-os': 'FreeBSD' }))
    assert.equal(failure?.field, 'x-stainless-os')
  })

  await t.test('L2: rejects unknown x-stainless-arch', () => {
    const failure = validateCliRequestHeaders(makeHeaders({ 'x-stainless-arch': 'mips' }))
    assert.equal(failure?.field, 'x-stainless-arch')
  })

  await t.test('L2: rejects bad anthropic-dangerous-direct-browser-access', () => {
    const failure = validateCliRequestHeaders(
      makeHeaders({ 'anthropic-dangerous-direct-browser-access': 'false' }),
    )
    assert.equal(failure?.field, 'anthropic-dangerous-direct-browser-access')
  })

  await t.test('L2: rejects bad anthropic-version', () => {
    const failure = validateCliRequestHeaders(
      makeHeaders({ 'anthropic-version': '2024-01-01' }),
    )
    assert.equal(failure?.field, 'anthropic-version')
  })

  await t.test('L2: rejects sec-fetch-mode != cors', () => {
    const failure = validateCliRequestHeaders(makeHeaders({ 'sec-fetch-mode': 'no-cors' }))
    assert.equal(failure?.field, 'sec-fetch-mode')
  })

  await t.test('L2: tolerates missing browser/proxy-dependent headers', () => {
    assert.equal(
      validateCliRequestHeaders(
        makeHeaders({
          'accept-encoding': undefined,
          'accept-language': undefined,
          'sec-fetch-mode': undefined,
        }),
      ),
      null,
    )
  })

  await t.test('L2: rejects bad runtime-version format', () => {
    const failure = validateCliRequestHeaders(
      makeHeaders({ 'x-stainless-runtime-version': '24.12.0' }),
    )
    assert.equal(failure?.field, 'x-stainless-runtime-version')
  })

  await t.test('L2: rejects accept-encoding without gzip', () => {
    const failure = validateCliRequestHeaders(makeHeaders({ 'accept-encoding': 'br' }))
    assert.equal(failure?.field, 'accept-encoding')
  })

  await t.test('L2: tolerates missing optional retry-count and timeout', () => {
    assert.equal(
      validateCliRequestHeaders(
        makeHeaders({
          'x-stainless-retry-count': undefined,
          'x-stainless-timeout': undefined,
        }),
      ),
      null,
    )
  })

  await t.test('L2: rejects non-numeric retry-count', () => {
    const failure = validateCliRequestHeaders(
      makeHeaders({ 'x-stainless-retry-count': 'abc' }),
    )
    assert.equal(failure?.field, 'x-stainless-retry-count')
  })

  await t.test('L3: passes a clean body', () => {
    assert.equal(validateCliRequestBody(makeBody()), null)
  })

  await t.test('L3: rejects empty system array', () => {
    const failure = validateCliRequestBody(makeBody({ system: [] }))
    assert.equal(failure?.layer, 'L3')
    assert.equal(failure?.field, 'system')
  })

  await t.test('L3: rejects system[0] without cc_version', () => {
    const failure = validateCliRequestBody(
      makeBody({
        system: [
          { type: 'text', text: 'no marker; cc_entrypoint=sdk-cli' },
          { type: 'text', text: 'b' },
        ],
      }),
    )
    assert.equal(failure?.field, 'system[0].cc_version')
  })

  await t.test('L3: rejects system[0] without cc_entrypoint', () => {
    const failure = validateCliRequestBody(
      makeBody({
        system: [{ type: 'text', text: 'cc_version=2.1.112.e61; cch=00000;' }],
      }),
    )
    assert.equal(failure?.field, 'system[0].cc_entrypoint')
  })

  await t.test('L3: accepts cc_entrypoint=sdk-ts (real-world variant)', () => {
    const failure = validateCliRequestBody(
      makeBody({
        system: [
          {
            type: 'text',
            text: 'cc_version=2.1.112.e61; cc_entrypoint=sdk-ts; cch=00000;',
          },
        ],
      }),
    )
    assert.equal(failure, null)
  })

  await t.test('L3: rejects empty messages', () => {
    const failure = validateCliRequestBody(makeBody({ messages: [] }))
    assert.equal(failure?.field, 'messages')
  })

  await t.test('L3: rejects missing metadata', () => {
    const failure = validateCliRequestBody(makeBody({ metadata: undefined }))
    assert.equal(failure?.field, 'metadata')
  })

  await t.test('L3: rejects metadata.user_id non-JSON', () => {
    const failure = validateCliRequestBody(
      makeBody({ metadata: { user_id: 'not-json' } }),
    )
    assert.equal(failure?.field, 'metadata.user_id')
  })

  await t.test('L3: rejects metadata.user_id missing device_id', () => {
    const failure = validateCliRequestBody(
      makeBody({
        metadata: {
          user_id: JSON.stringify({ account_uuid: VALID_ACCOUNT_UUID }),
        },
      }),
    )
    assert.equal(failure?.field, 'metadata.user_id.device_id')
  })

  await t.test('L3: rejects metadata.user_id with short device_id', () => {
    const failure = validateCliRequestBody(
      makeBody({
        metadata: {
          user_id: JSON.stringify({
            device_id: 'short',
            account_uuid: VALID_ACCOUNT_UUID,
          }),
        },
      }),
    )
    assert.equal(failure?.field, 'metadata.user_id.device_id')
  })

  await t.test('L3: accepts email-prefixed account_uuid', () => {
    const failure = validateCliRequestBody(
      makeBody({
        metadata: {
          user_id: JSON.stringify({
            device_id: VALID_DEVICE_ID,
            account_uuid: 'email:guang@example.com',
          }),
        },
      }),
    )
    assert.equal(failure, null)
  })

  await t.test('L3: accepts opaque account_uuid from real clients', () => {
    const failure = validateCliRequestBody(
      makeBody({
        metadata: {
          user_id: JSON.stringify({
            device_id: VALID_DEVICE_ID,
            account_uuid: 'user_01HXREALCLIENTOPAQUEID',
          }),
        },
      }),
    )
    assert.equal(failure, null)
  })

  await t.test('L4: passes when UA version matches body cc_version', () => {
    assert.equal(
      validateCliRequestConsistency(makeHeaders(), makeBody(), [2, 1, 112]),
      null,
    )
  })

  await t.test('L4: rejects when UA version != body cc_version', () => {
    const failure = validateCliRequestConsistency(
      makeHeaders(),
      makeBody({
        system: [
          {
            type: 'text',
            text: 'cc_version=2.1.98.e54; cc_entrypoint=sdk-cli; cch=00000;',
          },
        ],
      }),
      [2, 1, 112],
    )
    assert.equal(failure?.layer, 'L4')
    assert.equal(failure?.field, 'cc_version_vs_ua')
  })

  await t.test('L4: rejects when UA platform != x-stainless-os', () => {
    const failure = validateCliRequestConsistency(
      makeHeaders({ 'user-agent': 'claude-cli/2.1.112 (external, sdk-cli) Darwin' }),
      makeBody(),
      [2, 1, 112],
    )
    assert.equal(failure?.field, 'platform')
  })

  await t.test('L4: skips platform check when UA has no platform token', () => {
    const failure = validateCliRequestConsistency(
      makeHeaders({ 'user-agent': 'claude-cli/2.1.112 (external, sdk-cli)' }),
      makeBody(),
      [2, 1, 112],
    )
    assert.equal(failure, null)
  })

  await t.test('combined: passes a fully-valid request', () => {
    assert.equal(
      validateCliRequest({
        headers: makeHeaders(),
        parsedBody: makeBody(),
        parsedClientVersion: [2, 1, 112],
        checkBody: true,
      }),
      null,
    )
  })

  await t.test('combined: stops at first failure (L2 before L3)', () => {
    const failure = validateCliRequest({
      headers: makeHeaders({ 'x-app': 'sdk' }),
      parsedBody: makeBody({ system: [] }),
      parsedClientVersion: [2, 1, 112],
      checkBody: true,
    })
    assert.equal(failure?.layer, 'L2')
    assert.equal(failure?.field, 'x-app')
  })

  await t.test('combined: skips L3 when checkBody=false', () => {
    assert.equal(
      validateCliRequest({
        headers: makeHeaders(),
        parsedBody: null,
        parsedClientVersion: [2, 1, 112],
        checkBody: false,
      }),
      null,
    )
  })

  await t.test('combined: skips count_tokens-style body when checkBody=false', () => {
    assert.equal(
      validateCliRequest({
        headers: makeHeaders(),
        parsedBody: makeBody({ system: undefined }),
        parsedClientVersion: [2, 1, 112],
        checkBody: false,
      }),
      null,
    )
  })

  await t.test('tryParseMessageBody returns null on invalid JSON', () => {
    assert.equal(tryParseMessageBody(Buffer.from('not-json', 'utf8')), null)
  })

  await t.test('tryParseMessageBody returns null on array root', () => {
    assert.equal(tryParseMessageBody(Buffer.from('[]', 'utf8')), null)
  })

  await t.test('tryParseMessageBody returns parsed shape on valid object', () => {
    const parsed = tryParseMessageBody(
      Buffer.from(JSON.stringify({ system: [], tools: [], messages: [], metadata: {} })),
    )
    assert.deepEqual(parsed, { system: [], tools: [], messages: [], metadata: {} })
  })
})
