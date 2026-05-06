import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadBodyTemplate, rewriteCountTokensBody, rewriteMessageBody, rewriteEventLoggingBody, type BodyTemplate } from './bodyRewriter.js'

const TEMPLATE: BodyTemplate = {
  ccVersion: '2.1.98.e54',
  ccEntrypoint: 'sdk-cli',
  systemBlocks: [
    {
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '1h' },
      text: 'block-1-template-text',
    },
    {
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '1h' },
      text: 'block-2-template-text-long-content',
    },
  ],
  tools: [
    { name: 'Bash', description: 'v98 Bash' },
    { name: 'Monitor', description: 'v98 Monitor' },
  ],
  deviceId: 'template-device-id-hex',
  accountUuid: 'template-account-uuid',
}

const NEW_ERA_TEMPLATE: BodyTemplate = {
  ...TEMPLATE,
  ccVersion: '2.1.112.e61',
  cacheControl: { type: 'ephemeral' },
}

function makeBody(overrides: Record<string, unknown> = {}): Buffer {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 64000,
    system: [
      { type: 'text', text: 'polling-header: cc_version=2.1.90.232; cc_entrypoint=sdk-ts; cch=00000;' },
      { type: 'text', text: 'block-1-original' },
      { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' }, text: 'block-2-original' },
      { type: 'text', text: 'block-3-session-guidance' },
    ],
    tools: [
      { name: 'Bash', description: 'v90 Bash' },
    ],
    messages: [{ role: 'user', content: 'say ok' }],
    metadata: { user_id: JSON.stringify({ device_id: 'client-device-id-hex', account_uuid: 'client-account-uuid' }) },
    ...overrides,
  }
  return Buffer.from(JSON.stringify(body), 'utf8')
}

test('bodyRewriter', async (t) => {

  await t.test('loadBodyTemplate rejects invalid template shape', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenqiao-template-'))
    const templatePath = path.join(tempDir, 'bad-template.json')
    fs.writeFileSync(templatePath, JSON.stringify({ ccVersion: '2.1.131.880', tools: [] }))

    assert.throws(
      () => loadBodyTemplate(templatePath),
      /template systemBlocks must be a non-empty array/,
    )
  })

  await t.test('loadBodyTemplate rejects duplicate tool names', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenqiao-template-'))
    const templatePath = path.join(tempDir, 'bad-template.json')
    fs.writeFileSync(templatePath, JSON.stringify({
      ccVersion: '2.1.131.880',
      systemBlocks: [{ type: 'text', text: 'template' }],
      tools: [{ name: 'Bash' }, { name: 'Bash' }],
      deviceId: 'device',
      accountUuid: '',
    }))

    assert.throws(
      () => loadBodyTemplate(templatePath),
      /template tools duplicate name Bash/,
    )
  })


  await t.test('rewrites cc_version in system[0]', () => {
    const result = rewriteMessageBody(makeBody(), TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.match(parsed.system[0].text, /cc_version=2\.1\.98\.e54/)
    assert.doesNotMatch(parsed.system[0].text, /cc_version=2\.1\.90\.232/)
  })

  await t.test('converts 4-block system to 3 blocks with template content', () => {
    const result = rewriteMessageBody(makeBody(), TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.system.length, 3)
    assert.equal(parsed.system[1].text, 'block-1-template-text')
    assert.deepEqual(parsed.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(parsed.system[2].text, 'block-2-template-text-long-content')
    assert.deepEqual(parsed.system[2].cache_control, { type: 'ephemeral', ttl: '1h' })
  })

  await t.test('handles 3-block system (v97 style)', () => {
    const body = makeBody({
      system: [
        { type: 'text', text: 'polling-header: cc_version=2.1.97.2b9; cc_entrypoint=sdk-ts; cch=00000;' },
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: 'old-block-1' },
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: 'old-block-2' },
      ],
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.system.length, 3)
    assert.match(parsed.system[0].text, /cc_version=2\.1\.98\.e54/)
    assert.equal(parsed.system[1].text, 'block-1-template-text')
    assert.equal(parsed.system[2].text, 'block-2-template-text-long-content')
  })

  await t.test('keeps template tool definitions for same-name tools', () => {
    const result = rewriteMessageBody(makeBody(), TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.tools.length, 2)
    assert.equal(parsed.tools[0].name, 'Bash')
    assert.equal(parsed.tools[0].description, 'v98 Bash')
    assert.equal(parsed.tools[1].name, 'Monitor')
  })

  await t.test('keeps runtime MCP tools while template overrides built-ins', () => {
    const body = makeBody({
      tools: [
        { name: 'Bash', description: 'client Bash' },
        { name: 'mcp__skill__search', description: 'runtime MCP tool' },
      ],
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.deepEqual(
      parsed.tools.map((tool: { name: string }) => tool.name),
      ['Bash', 'Monitor', 'mcp__skill__search'],
    )
    assert.equal(parsed.tools[0].description, 'v98 Bash')
    assert.equal(parsed.tools[2].description, 'runtime MCP tool')
  })

  await t.test('preserves other fields unchanged', () => {
    const result = rewriteMessageBody(makeBody(), TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.model, 'claude-opus-4-6')
    assert.equal(parsed.max_tokens, 64000)
    assert.deepEqual(parsed.messages, [{ role: 'user', content: 'say ok' }])
    assert.deepEqual(parsed.metadata, { user_id: JSON.stringify({ device_id: 'template-device-id-hex', account_uuid: 'template-account-uuid' }) })
  })

  await t.test('preserves stream flag from newer Claude Code requests', () => {
    const result = rewriteMessageBody(makeBody({ stream: true }), TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.stream, true)
  })

  await t.test('returns null for invalid JSON', () => {
    const result = rewriteMessageBody(Buffer.from('not json'), TEMPLATE)
    assert.equal(result, null)
  })

  await t.test('returns null for unknown top-level fields', () => {
    const body = makeBody({ rogue_field: { should_not: 'reach upstream' } })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.equal(result, null)
  })

  await t.test('returns null for missing system array', () => {
    const body = Buffer.from(JSON.stringify({ model: 'test', tools: [] }))
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.equal(result, null)
  })

  await t.test('fills missing tools from template', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'test',
      system: [{ type: 'text', text: 'cc_version=2.1.90.232' }],
    }))
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.deepEqual(parsed.tools.map((tool: { name: string }) => tool.name), ['Bash', 'Monitor'])
  })

  await t.test('drops malformed runtime tools instead of forwarding them', () => {
    const body = makeBody({
      tools: [
        { name: 'Bash', description: 'client Bash' },
        { description: 'missing name' },
        null,
        { name: 'mcp__skill__search', description: 'runtime MCP tool' },
        { name: 'mcp__skill__search', description: 'duplicate runtime MCP tool' },
      ],
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.deepEqual(
      parsed.tools.map((tool: { name: string }) => tool.name),
      ['Bash', 'Monitor', 'mcp__skill__search'],
    )
  })

  await t.test('handles single-block system by appending template blocks', () => {
    const body = makeBody({
      system: [
        { type: 'text', text: 'cc_version=2.1.90.232; only-one-block' },
      ],
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.system.length, 3)
    assert.match(parsed.system[0].text, /cc_version=2\.1\.98\.e54/)
    assert.equal(parsed.system[1].text, 'block-1-template-text')
    assert.equal(parsed.system[2].text, 'block-2-template-text-long-content')
  })

  await t.test('returns null if system[0] has no cc_version', () => {
    const body = makeBody({
      system: [
        { type: 'text', text: 'no version here' },
        { type: 'text', text: 'b1' },
        { type: 'text', text: 'b2' },
      ],
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.equal(result, null)
  })

  await t.test('rewrites metadata.user_id device_id and account_uuid', () => {
    const body = makeBody({
      metadata: {
        user_id: JSON.stringify({
          device_id: 'client-device-aaa',
          account_uuid: 'client-account-bbb',
          session_id: 'session-ccc',
        }),
      },
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const userId = JSON.parse(parsed.metadata.user_id)
    assert.equal(userId.device_id, 'template-device-id-hex')
    assert.equal(userId.account_uuid, 'template-account-uuid')
    assert.equal(userId.session_id, 'session-ccc')
  })

  await t.test('preserves metadata when user_id is missing', () => {
    const body = makeBody({ metadata: { other: 'value' } })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.deepEqual(parsed.metadata, { other: 'value' })
  })

  await t.test('replaces malformed metadata.user_id instead of forwarding it', () => {
    const body = makeBody({ metadata: { user_id: 'not-json' } })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const userId = JSON.parse(parsed.metadata.user_id)
    assert.equal(userId.device_id, 'template-device-id-hex')
    assert.equal(userId.account_uuid, 'template-account-uuid')
  })

  await t.test('replaces non-object metadata.user_id JSON instead of forwarding it', () => {
    const body = makeBody({ metadata: { user_id: JSON.stringify(['not-object']) } })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const userId = JSON.parse(parsed.metadata.user_id)
    assert.equal(userId.device_id, 'template-device-id-hex')
    assert.equal(userId.account_uuid, 'template-account-uuid')
  })

  await t.test('replaces non-string metadata.user_id instead of rejecting normal requests', () => {
    const body = makeBody({ metadata: { user_id: null } })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const userId = JSON.parse(parsed.metadata.user_id)
    assert.equal(userId.device_id, 'template-device-id-hex')
    assert.equal(userId.account_uuid, 'template-account-uuid')
  })

  await t.test('normalizes cache_control in system[1..] when template provides cacheControl', () => {
    const body = makeBody({
      system: [
        { type: 'text', text: 'cc_version=2.1.90.232; cc_entrypoint=sdk-ts; cch=00000;' },
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: 'existing-1' },
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' }, text: 'existing-2' },
      ],
    })
    const result = rewriteMessageBody(body, NEW_ERA_TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.deepEqual(parsed.system[1].cache_control, { type: 'ephemeral' })
    assert.deepEqual(parsed.system[2].cache_control, { type: 'ephemeral' })
    assert.equal(parsed.system[0].cache_control, undefined)
  })

  await t.test('normalizes cache_control in messages[].content[] when template provides cacheControl', () => {
    const body = makeBody({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'no cc' },
          { type: 'text', text: 'legacy-ttl', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'scope', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
        ],
      }],
    })
    const result = rewriteMessageBody(body, NEW_ERA_TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const content = parsed.messages[0].content
    assert.equal(content[0].cache_control, undefined)
    assert.deepEqual(content[1].cache_control, { type: 'ephemeral' })
    assert.deepEqual(content[2].cache_control, { type: 'ephemeral' })
  })

  await t.test('leaves cache_control untouched when template lacks cacheControl', () => {
    const body = makeBody({
      system: [
        { type: 'text', text: 'cc_version=2.1.90.232; cc_entrypoint=sdk-ts; cch=00000;' },
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' }, text: 'keep-me' },
      ],
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.deepEqual(parsed.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.deepEqual(parsed.system[2].cache_control, { type: 'ephemeral', ttl: '1h' })
  })

  await t.test('restores client env section when both template and request have one', () => {
    const templateWithEnv: BodyTemplate = {
      ...TEMPLATE,
      systemBlocks: [
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: 'block-1-template-text' },
        {
          type: 'text',
          cache_control: { type: 'ephemeral', ttl: '1h' },
          text: 'instructions-prelude\n# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /capture/dir\n - Platform: linux\n',
        },
      ],
    }
    const body = makeBody({
      system: [
        { type: 'text', text: 'cc_version=2.1.90.232; cc_entrypoint=sdk-ts; cch=00000;' },
        { type: 'text', text: 'client-block-1' },
        {
          type: 'text',
          text: 'client-instructions\n# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /real/client/cwd\n - Platform: darwin\n',
        },
      ],
    })
    const result = rewriteMessageBody(body, templateWithEnv)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const lastBlockText: string = parsed.system[parsed.system.length - 1].text
    assert.ok(lastBlockText.startsWith('instructions-prelude'), 'keeps template prelude')
    assert.ok(lastBlockText.includes('/real/client/cwd'), 'injects real client cwd')
    assert.ok(lastBlockText.includes('Platform: darwin'), 'injects real client platform')
    assert.ok(!lastBlockText.includes('/capture/dir'), 'drops capture-time cwd')
    assert.ok(!lastBlockText.includes('Platform: linux'), 'drops capture-time platform')
  })

  await t.test('keeps template env section when request has none', () => {
    const templateWithEnv: BodyTemplate = {
      ...TEMPLATE,
      systemBlocks: [
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: 'block-1-template-text' },
        {
          type: 'text',
          cache_control: { type: 'ephemeral', ttl: '1h' },
          text: 'instructions-prelude\n# Environment\n - Primary working directory: /capture/dir\n',
        },
      ],
    }
    const body = makeBody({
      system: [
        { type: 'text', text: 'cc_version=2.1.90.232; cc_entrypoint=sdk-ts; cch=00000;' },
        { type: 'text', text: 'client-block-1' },
        { type: 'text', text: 'client-block-2-without-env' },
      ],
    })
    const result = rewriteMessageBody(body, templateWithEnv)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const lastBlockText: string = parsed.system[parsed.system.length - 1].text
    assert.ok(lastBlockText.includes('/capture/dir'), 'falls back to template env')
  })

  await t.test('leaves last block untouched when template has no env section', () => {
    // TEMPLATE itself has no '# Environment' marker; behavior must match pre-backfill
    const body = makeBody({
      system: [
        { type: 'text', text: 'cc_version=2.1.90.232; cc_entrypoint=sdk-ts; cch=00000;' },
        { type: 'text', text: 'client-block-1' },
        { type: 'text', text: 'client-last\n# Environment\n - Primary working directory: /real/cwd\n' },
      ],
    })
    const result = rewriteMessageBody(body, TEMPLATE)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.system[parsed.system.length - 1].text, 'block-2-template-text-long-content')
  })
})


test('rewriteCountTokensBody', async (t) => {
  await t.test('accepts real count_tokens shape without system or metadata', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'deepseek',
      messages: [{ role: 'user', content: 'foo' }],
      tools: [{ name: 'Skill', description: 'runtime skill tool' }],
    }))
    const result = rewriteCountTokensBody(body)
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.deepEqual(Object.keys(parsed).sort(), ['messages', 'model', 'tools'])
    assert.equal(parsed.messages[0].content, 'foo')
    assert.equal(parsed.tools[0].name, 'Skill')
  })

  await t.test('rejects unknown count_tokens top-level fields', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'deepseek',
      messages: [{ role: 'user', content: 'foo' }],
      rogue_field: true,
    }))
    assert.equal(rewriteCountTokensBody(body), null)
  })
})

test('rewriteEventLoggingBody', async (t) => {
  await t.test('replaces client version with template version', () => {
    const payload = JSON.stringify({
      events: [
        { event_type: 'ClaudeCodeInternalEvent', version: '2.1.90' },
      ],
    })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.90')
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.events[0].version, '2.1.98')
  })

  await t.test('returns null when version already matches', () => {
    const payload = JSON.stringify({ events: [{ version: '2.1.98' }] })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.98')
    assert.equal(result, null)
  })

  await t.test('returns null for non-JSON body', () => {
    const result = rewriteEventLoggingBody(Buffer.from('not json'), TEMPLATE, '2.1.90')
    assert.equal(result, null)
  })

  await t.test('returns null when version string not found in body', () => {
    const payload = JSON.stringify({ events: [{ data: 'no version here' }] })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.90')
    assert.equal(result, null)
  })

  await t.test('replaces multiple occurrences', () => {
    const payload = JSON.stringify({
      service_version: '2.1.90',
      events: [{ app_version: '2.1.90', nested: { v: '2.1.90' } }],
    })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.90')
    assert.ok(result)
    const text = result.toString('utf8')
    assert.equal(text.includes('2.1.90'), false)
    assert.equal(text.includes('2.1.98'), true)
  })

  await t.test('rewrites nested device_id and account_uuid to template values', () => {
    const payload = JSON.stringify({
      events: [{
        version: '2.1.90',
        payload: {
          user_id: {
            device_id: 'client-device-aaa',
            account_uuid: 'client-account-bbb',
            session_id: 'keep-me',
          },
        },
      }],
    })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.90')
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    const userId = parsed.events[0].payload.user_id
    assert.equal(userId.device_id, 'template-device-id-hex')
    assert.equal(userId.account_uuid, 'template-account-uuid')
    assert.equal(userId.session_id, 'keep-me')
  })

  await t.test('rewrites cc_entrypoint to template value when set', () => {
    const payload = JSON.stringify({
      meta: { cc_entrypoint: 'sdk-ts' },
      events: [{ version: '2.1.90' }],
    })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.90')
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.meta.cc_entrypoint, 'sdk-cli')
  })

  await t.test('replaces full ccVersion strings (semver.hash) with template ccVersion', () => {
    const payload = JSON.stringify({
      meta: { cc_version_full: '2.1.90.abc123' },
      events: [{ tag: 'cc_version=2.1.90.abc123 inside text' }],
    })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.90')
    assert.ok(result)
    const text = result.toString('utf8')
    assert.equal(text.includes('2.1.90.abc123'), false)
    assert.equal(text.includes('2.1.98.e54'), true)
  })

  await t.test('rewrites device/account fields even when version already matches', () => {
    const payload = JSON.stringify({
      events: [{
        version: '2.1.98',
        user_id: { device_id: 'client-device-xxx', account_uuid: 'client-account-yyy' },
      }],
    })
    const result = rewriteEventLoggingBody(Buffer.from(payload), TEMPLATE, '2.1.98')
    assert.ok(result)
    const parsed = JSON.parse(result.toString('utf8'))
    assert.equal(parsed.events[0].user_id.device_id, 'template-device-id-hex')
    assert.equal(parsed.events[0].user_id.account_uuid, 'template-account-uuid')
  })
})
