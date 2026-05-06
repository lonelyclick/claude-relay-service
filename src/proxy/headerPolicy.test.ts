import assert from 'node:assert/strict'
import test from 'node:test'

import { buildUpstreamHeaders, buildWebSocketUpstreamHeaders } from './headerPolicy.js'

test('buildUpstreamHeaders', async (t) => {
  await t.test('omits fingerprint passthrough header when client did not send it', () => {
    const headers = buildUpstreamHeaders(
      [
        'User-Agent', 'claude-cli/2.1.131 (external, sdk-cli)',
        'Authorization', 'Bearer client-token',
      ],
      {
        'user-agent': 'claude-cli/2.1.131 (external, sdk-cli)',
        authorization: 'Bearer client-token',
      },
      'upstream-token',
      'oauth',
      [{ name: 'X-Stainless-Retry-Count', value: '$passthrough' }],
    )

    assert.equal(headers.includes('X-Stainless-Retry-Count'), false)
  })

  await t.test('preserves fingerprint passthrough value when present', () => {
    const headers = buildUpstreamHeaders(
      [
        'User-Agent', 'claude-cli/2.1.131 (external, sdk-cli)',
        'Authorization', 'Bearer client-token',
        'X-Stainless-Retry-Count', '1',
      ],
      {
        'user-agent': 'claude-cli/2.1.131 (external, sdk-cli)',
        authorization: 'Bearer client-token',
        'x-stainless-retry-count': '1',
      },
      'upstream-token',
      'oauth',
      [{ name: 'X-Stainless-Retry-Count', value: '$passthrough' }],
    )

    assert.deepEqual(
      headers.slice(headers.indexOf('X-Stainless-Retry-Count'), headers.indexOf('X-Stainless-Retry-Count') + 2),
      ['X-Stainless-Retry-Count', '1'],
    )
  })
  await t.test('drops spoofed and proxy-only headers from upstream request', () => {
    const headers = buildUpstreamHeaders(
      [
        'User-Agent', 'evil-client/9.9.9',
        'Authorization', 'Bearer client-token',
        'X-Api-Key', 'client-api-key',
        'Host', 'attacker.example',
        'Connection', 'upgrade',
        'Accept-Language', '*',
        'Sec-Fetch-Mode', 'cors',
        'X-Force-Account', 'official-account',
        'X-Stainless-Runtime-Version', 'v0.0.0',
        'X-Stainless-Retry-Count', '2',
        'Content-Type', 'application/json',
        'Content-Length', '123',
        'X-Unknown-Client-Header', 'must-not-leak',
      ],
      {
        'user-agent': 'evil-client/9.9.9',
        authorization: 'Bearer client-token',
        'x-api-key': 'client-api-key',
        host: 'attacker.example',
        connection: 'upgrade',
        'accept-language': '*',
        'sec-fetch-mode': 'cors',
        'x-force-account': 'official-account',
        'x-stainless-runtime-version': 'v0.0.0',
        'x-stainless-retry-count': '2',
        'content-type': 'application/json',
        'content-length': '123',
        'x-unknown-client-header': 'must-not-leak',
      },
      'upstream-token',
      'oauth',
      [
        { name: 'User-Agent', value: 'claude-cli/2.1.131 (external, sdk-cli)' },
        { name: 'X-Stainless-Runtime-Version', value: 'v24.3.0' },
        { name: 'X-Stainless-Retry-Count', value: '$passthrough' },
      ],
      'claude-code-20250219,effort-2025-11-24',
    )
    const byName = Object.fromEntries(
      Array.from({ length: headers.length / 2 }, (_, index) => [
        headers[index * 2].toLowerCase(),
        headers[index * 2 + 1],
      ]),
    )

    assert.equal(byName.authorization, 'Bearer upstream-token')
    assert.equal(byName['user-agent'], 'claude-cli/2.1.131 (external, sdk-cli)')
    assert.equal(byName['x-stainless-runtime-version'], 'v24.3.0')
    assert.equal(byName['x-stainless-retry-count'], '2')
    assert.equal(byName['content-type'], 'application/json')
    assert.equal(byName['content-length'], '123')
    assert.equal(byName['x-api-key'], undefined)
    assert.equal(byName.host, undefined)
    assert.equal(byName.connection, undefined)
    assert.equal(byName['accept-language'], undefined)
    assert.equal(byName['sec-fetch-mode'], undefined)
    assert.equal(byName['x-force-account'], undefined)
    assert.equal(byName['x-unknown-client-header'], undefined)
  })

  await t.test('websocket upstream headers drop managed handshake and internal fields', () => {
    const headers = buildWebSocketUpstreamHeaders(
      [
        'User-Agent', 'evil-client/9.9.9',
        'Authorization', 'Bearer client-token',
        'Sec-WebSocket-Key', 'client-key',
        'Sec-WebSocket-Version', '13',
        'Sec-WebSocket-Extensions', 'permessage-deflate',
        'Sec-WebSocket-Protocol', 'claude',
        'Connection', 'Upgrade',
        'Upgrade', 'websocket',
        'Host', 'attacker.example',
        'X-Force-Account', 'account-1',
        'X-Claude-Code-Session-Id', 'client-session',
        'X-Stainless-Runtime-Version', 'v0.0.0',
      ],
      {
        'user-agent': 'evil-client/9.9.9',
        authorization: 'Bearer client-token',
        'sec-websocket-key': 'client-key',
        'sec-websocket-version': '13',
        'sec-websocket-extensions': 'permessage-deflate',
        'sec-websocket-protocol': 'claude',
        connection: 'Upgrade',
        upgrade: 'websocket',
        host: 'attacker.example',
        'x-force-account': 'account-1',
        'x-claude-code-session-id': 'client-session',
        'x-stainless-runtime-version': 'v0.0.0',
      },
      'upstream-token',
      'oauth',
      [
        { name: 'User-Agent', value: 'claude-cli/2.1.131 (external, sdk-cli)' },
        { name: 'X-Stainless-Runtime-Version', value: 'v24.3.0' },
      ],
      'claude-code-20250219,effort-2025-11-24',
      { 'x-claude-code-session-id': 'upstream-session', 'x-force-account': 'must-not-override' },
    )
    const byName = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    )

    assert.equal(byName.authorization, 'Bearer upstream-token')
    assert.equal(byName['user-agent'], 'claude-cli/2.1.131 (external, sdk-cli)')
    assert.equal(byName['x-stainless-runtime-version'], 'v24.3.0')
    assert.equal(byName['x-claude-code-session-id'], 'upstream-session')
    assert.equal(byName['sec-websocket-key'], undefined)
    assert.equal(byName['sec-websocket-version'], undefined)
    assert.equal(byName['sec-websocket-extensions'], undefined)
    assert.equal(byName['sec-websocket-protocol'], undefined)
    assert.equal(byName.connection, undefined)
    assert.equal(byName.upgrade, undefined)
    assert.equal(byName.host, undefined)
    assert.equal(byName['x-force-account'], undefined)
  })

})
