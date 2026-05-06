import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { projectRoot } from '../projectRoot.js'
import { loadBodyTemplate, rewriteCountTokensBody, rewriteMessageBody } from './bodyRewriter.js'
import { normalizeVmFingerprintTemplateHeaders } from './fingerprintTemplate.js'
import { buildUpstreamHeaders } from './headerPolicy.js'

const CAPTURE_DIR = path.join(projectRoot, 'scripts/captured-bodies')
const BODY_TEMPLATE_PATH = path.join(projectRoot, 'data/v2.1.112-body-template.json')
const VM_TEMPLATE_PATH = path.join(projectRoot, 'vm-fingerprint.template.json')

const EXPECTED_BODY_KEYS = new Set([
  'context_management',
  'max_tokens',
  'messages',
  'metadata',
  'model',
  'output_config',
  'system',
  'thinking',
  'tools',
])

const EXPECTED_UPSTREAM_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'authorization',
  'content-length',
  'content-type',
  'idempotency-key',
  'user-agent',
  'x-app',
  'x-claude-code-session-id',
  'x-claude-remote-session-id',
  'x-request-id',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
])

const EXPECTED_OAUTH_BETA = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,effort-2025-11-24,oauth-2025-04-20'
const EXPECTED_COUNT_TOKENS_OAUTH_BETA = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01,oauth-2025-04-20'

const FORBIDDEN_UPSTREAM_HEADERS = new Set([
  'accept-language',
  'connection',
  'host',
  'sec-fetch-mode',
  'transfer-encoding',
  'x-api-key',
])

type HeaderFixture = {
  headers?: unknown
}

function capturedBodyFiles(): string[] {
  return fs.readdirSync(CAPTURE_DIR)
    .filter((name) => /^v2\.1\.\d+__POST_v1_messages_beta_true\.json$/.test(name))
    .sort(compareCaptureVersions)
}

function compareCaptureVersions(left: string, right: string): number {
  return capturePatchVersion(left) - capturePatchVersion(right)
}

function capturePatchVersion(fileName: string): number {
  const match = fileName.match(/^v2\.1\.(\d+)__POST_v1_messages_beta_true\.json$/)
  if (!match) {
    throw new Error(`Unexpected capture file name: ${fileName}`)
  }
  return Number(match[1])
}

function readCapturedHeaders(fileName: string): { rawHeaders: string[]; incoming: Record<string, string> } {
  const headerPath = path.join(CAPTURE_DIR, fileName.replace(/\.json$/, '.headers.json'))
  const fixture = JSON.parse(fs.readFileSync(headerPath, 'utf8')) as HeaderFixture
  if (!Array.isArray(fixture.headers)) {
    throw new Error(`Header fixture missing raw headers array: ${headerPath}`)
  }

  const rawHeaders: string[] = []
  const incoming: Record<string, string> = {}
  for (let index = 0; index < fixture.headers.length - 1; index += 2) {
    const name = fixture.headers[index]
    const value = fixture.headers[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new Error(`Header fixture contains non-string pair: ${headerPath}`)
    }
    rawHeaders.push(name, value)
    incoming[name.toLowerCase()] = value
  }

  return { rawHeaders, incoming }
}

function headerObject(headerPairs: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (let index = 0; index < headerPairs.length - 1; index += 2) {
    const name = headerPairs[index]
    const value = headerPairs[index + 1]
    if (name === undefined || value === undefined) {
      throw new Error('Malformed upstream header pairs')
    }
    headers[name.toLowerCase()] = value
  }
  return headers
}

test('Claude Code compatibility matrix', async (t) => {
  const bodyTemplate = loadBodyTemplate(BODY_TEMPLATE_PATH)
  assert.ok(bodyTemplate)
  const vmTemplate = JSON.parse(fs.readFileSync(VM_TEMPLATE_PATH, 'utf8')) as {
    headers: Record<string, string | readonly string[]>
  }
  const vmHeaders = normalizeVmFingerprintTemplateHeaders(vmTemplate.headers)
  const files = capturedBodyFiles()
  assert.equal(files.length, 30)

  await t.test('rewrites all captured versions to the 2.1.131 request shape', () => {
    for (const fileName of files) {
      const originalBuffer = fs.readFileSync(path.join(CAPTURE_DIR, fileName))
      const original = JSON.parse(originalBuffer.toString('utf8')) as Record<string, unknown>
      const rewritten = rewriteMessageBody(originalBuffer, bodyTemplate)
      assert.ok(rewritten, `${fileName}: body rewrite must succeed`)
      const parsed = JSON.parse(rewritten.toString('utf8')) as Record<string, unknown>

      assert.deepEqual(
        Object.keys(parsed).sort(),
        Object.keys(original).sort(),
        `${fileName}: top-level request keys must not be invented or dropped`,
      )
      assert.deepEqual(
        Object.keys(parsed).filter((key) => !EXPECTED_BODY_KEYS.has(key)),
        [],
        `${fileName}: unexpected top-level body key`,
      )

      const system = parsed.system as Array<{ text?: string }>
      assert.equal(system.length, 3, `${fileName}: system must match 2.1.131 block count`)
      assert.match(system[0].text ?? '', /cc_version=2\.1\.131\.880/, `${fileName}: cc_version`)
      assert.match(system[0].text ?? '', /cc_entrypoint=sdk-cli/, `${fileName}: cc_entrypoint`)

      const tools = parsed.tools as Array<{ name?: string }>
      assert.equal(tools.length, 26, `${fileName}: tools must match 2.1.131 count`)
      assert.ok(tools.some((tool) => tool.name === 'PushNotification'), `${fileName}: PushNotification tool`)

      const metadata = parsed.metadata as { user_id?: unknown }
      assert.equal(typeof metadata.user_id, 'string', `${fileName}: metadata.user_id`)
      const metadataUserId = metadata.user_id
      if (typeof metadataUserId !== 'string') {
        throw new Error(`${fileName}: metadata.user_id must be a string`)
      }
      const userId = JSON.parse(metadataUserId) as Record<string, unknown>
      assert.equal(userId.device_id, bodyTemplate.deviceId, `${fileName}: device_id`)
      assert.equal(userId.account_uuid, bodyTemplate.accountUuid, `${fileName}: account_uuid`)
    }
  })

  await t.test('builds only known upstream headers for all captured versions', () => {
    for (const fileName of files) {
      const { rawHeaders, incoming } = readCapturedHeaders(fileName)
      const upstreamHeaders = buildUpstreamHeaders(
        rawHeaders,
        incoming,
        'upstream-token',
        'oauth',
        vmHeaders,
        bodyTemplate.anthropicBeta,
      )
      const headers = headerObject(upstreamHeaders)
      const headerNames = Object.keys(headers).sort()

      assert.deepEqual(
        headerNames.filter((name) => !EXPECTED_UPSTREAM_HEADERS.has(name)),
        [],
        `${fileName}: unexpected upstream header`,
      )
      for (const forbidden of FORBIDDEN_UPSTREAM_HEADERS) {
        assert.equal(headers[forbidden], undefined, `${fileName}: forbidden header leaked: ${forbidden}`)
      }

      assert.equal(headers.authorization, 'Bearer upstream-token', `${fileName}: upstream auth replacement`)
      assert.equal(headers['user-agent'], 'claude-cli/2.1.131 (external, sdk-cli)', `${fileName}: user-agent`)
      assert.equal(headers['x-stainless-runtime-version'], 'v24.3.0', `${fileName}: runtime version`)
      assert.equal(headers['x-stainless-package-version'], '0.81.0', `${fileName}: package version`)
      assert.equal(headers['accept-encoding'], 'gzip, deflate, br, zstd', `${fileName}: accept-encoding`)
      assert.equal(headers['x-app'], 'cli', `${fileName}: x-app`)
      assert.equal(headers['anthropic-version'], '2023-06-01', `${fileName}: anthropic-version`)
      assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true', `${fileName}: direct browser access`)
      assert.equal(headers['anthropic-beta'], EXPECTED_OAUTH_BETA, `${fileName}: anthropic-beta`)
    }
  })

  await t.test('keeps real count_tokens body shape and sanitizes headers', () => {
    const fileName = 'v2.1.131__POST_v1_messages_count_tokens_beta_true.json'
    const originalBuffer = fs.readFileSync(path.join(CAPTURE_DIR, fileName))
    const original = JSON.parse(originalBuffer.toString('utf8')) as Record<string, unknown>
    const rewritten = rewriteCountTokensBody(originalBuffer)
    assert.ok(rewritten, `${fileName}: count_tokens rewrite must succeed`)
    const parsed = JSON.parse(rewritten.toString('utf8')) as Record<string, unknown>

    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(original).sort())
    assert.deepEqual(Object.keys(parsed).filter((key) => !EXPECTED_BODY_KEYS.has(key)), [])
    assert.equal(parsed.system, undefined)
    assert.equal(parsed.metadata, undefined)
    assert.equal(Array.isArray(parsed.messages), true)
    assert.equal(Array.isArray(parsed.tools), true)

    const { rawHeaders, incoming } = readCapturedHeaders(fileName)
    const upstreamHeaders = buildUpstreamHeaders(
      rawHeaders,
      incoming,
      'upstream-token',
      'oauth',
      vmHeaders,
      incoming['anthropic-beta'],
    )
    const headers = headerObject(upstreamHeaders)
    assert.equal(headers.authorization, 'Bearer upstream-token')
    assert.equal(headers['user-agent'], 'claude-cli/2.1.131 (external, sdk-cli)')
    assert.equal(headers['anthropic-beta'], EXPECTED_COUNT_TOKENS_OAUTH_BETA)
    for (const forbidden of FORBIDDEN_UPSTREAM_HEADERS) {
      assert.equal(headers[forbidden], undefined, `${fileName}: forbidden header leaked: ${forbidden}`)
    }
  })

})
