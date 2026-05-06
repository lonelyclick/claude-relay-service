import fs from 'node:fs'
import path from 'node:path'

export type BodyRewriteResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: string }

export type BodyTemplate = {
  ccVersion: string
  ccEntrypoint?: string
  anthropicBeta?: string
  systemBlocks: ReadonlyArray<{
    type: string
    cache_control?: { type: string; ttl?: string }
    text: string
  }>
  tools: readonly unknown[]
  deviceId: string
  accountUuid: string
  cacheControl?: { type: string; ttl?: string }
}

type SystemBlock = {
  type: string
  cache_control?: unknown
  text: string
}

const CC_VERSION_REGEX = /cc_version=\d+\.\d+\.\d+\.\w+/
const CC_ENTRYPOINT_REGEX = /cc_entrypoint=\S+?(?=;|$)/
const CC_VERSION_FULL_REGEX = /\b\d+\.\d+\.\d+\.[a-z0-9]+\b/gi
const TEMPLATE_CC_VERSION_REGEX = /^\d+\.\d+\.\d+\.[a-z0-9]+$/i
const ENV_SECTION_MARKER = '\n# Environment\n'
const MESSAGE_BODY_ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
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

const EVENT_LOGGING_KEYS_TO_REWRITE: ReadonlySet<string> = new Set([
  'device_id',
  'account_uuid',
  'cc_entrypoint',
])

export function loadBodyTemplate(templatePath: string | null): BodyTemplate | null {
  if (!templatePath) {
    return null
  }

  if (!path.isAbsolute(templatePath)) {
    throw new Error(`[bodyRewriter] templatePath must be absolute, got: ${templatePath}`)
  }
  if (!fs.existsSync(templatePath)) {
    throw new Error(`[bodyRewriter] template not found: ${templatePath}`)
  }

  const raw = JSON.parse(fs.readFileSync(templatePath, 'utf8'))
  assertBodyTemplate(raw, templatePath)
  return raw as BodyTemplate
}

function assertBodyTemplate(raw: unknown, templatePath: string): asserts raw is BodyTemplate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[bodyRewriter] template must be a JSON object: ${templatePath}`)
  }

  const template = raw as Record<string, unknown>
  if (typeof template.ccVersion !== 'string' || !TEMPLATE_CC_VERSION_REGEX.test(template.ccVersion)) {
    throw new Error(`[bodyRewriter] template ccVersion must be a Claude Code full version: ${templatePath}`)
  }
  if (template.ccEntrypoint !== undefined && typeof template.ccEntrypoint !== 'string') {
    throw new Error(`[bodyRewriter] template ccEntrypoint must be a string: ${templatePath}`)
  }
  if (template.anthropicBeta !== undefined && typeof template.anthropicBeta !== 'string') {
    throw new Error(`[bodyRewriter] template anthropicBeta must be a string: ${templatePath}`)
  }
  if (!Array.isArray(template.systemBlocks) || template.systemBlocks.length === 0) {
    throw new Error(`[bodyRewriter] template systemBlocks must be a non-empty array: ${templatePath}`)
  }
  for (const [index, block] of template.systemBlocks.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`[bodyRewriter] template systemBlocks[${index}] must be an object: ${templatePath}`)
    }
    const record = block as Record<string, unknown>
    if (typeof record.type !== 'string' || typeof record.text !== 'string') {
      throw new Error(`[bodyRewriter] template systemBlocks[${index}] must include string type/text: ${templatePath}`)
    }
  }
  if (!Array.isArray(template.tools) || template.tools.length === 0) {
    throw new Error(`[bodyRewriter] template tools must be a non-empty array: ${templatePath}`)
  }
  const toolNames = new Set<string>()
  for (const [index, tool] of template.tools.entries()) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      throw new Error(`[bodyRewriter] template tools[${index}] must be an object: ${templatePath}`)
    }
    const name = (tool as Record<string, unknown>).name
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`[bodyRewriter] template tools[${index}].name must be a non-empty string: ${templatePath}`)
    }
    if (toolNames.has(name)) {
      throw new Error(`[bodyRewriter] template tools duplicate name ${name}: ${templatePath}`)
    }
    toolNames.add(name)
  }
  if (typeof template.deviceId !== 'string' || template.deviceId.trim().length === 0) {
    throw new Error(`[bodyRewriter] template deviceId must be a non-empty string: ${templatePath}`)
  }
  if (typeof template.accountUuid !== 'string') {
    throw new Error(`[bodyRewriter] template accountUuid must be a string: ${templatePath}`)
  }
  if (template.cacheControl !== undefined) {
    const cacheControl = template.cacheControl
    if (!cacheControl || typeof cacheControl !== 'object' || Array.isArray(cacheControl)) {
      throw new Error(`[bodyRewriter] template cacheControl must be an object: ${templatePath}`)
    }
    const record = cacheControl as Record<string, unknown>
    if (typeof record.type !== 'string' || (record.ttl !== undefined && typeof record.ttl !== 'string')) {
      throw new Error(`[bodyRewriter] template cacheControl must include string type/ttl: ${templatePath}`)
    }
  }
}


export function rewriteCountTokensBody(
  body: Buffer,
): Buffer | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }

  if (!hasOnlyAllowedMessageBodyKeys(parsed)) {
    return null
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length < 1) {
    return null
  }
  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    return null
  }
  return Buffer.from(JSON.stringify(parsed), 'utf8')
}

export function rewriteMessageBody(
  body: Buffer,
  template: BodyTemplate,
): Buffer | null {
  const result = rewriteMessageBodyDetailed(body, template)
  return result.ok ? result.body : null
}

export function rewriteMessageBodyDetailed(
  body: Buffer,
  template: BodyTemplate,
): BodyRewriteResult {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }

  const unknownKeys = Object.keys(parsed).filter((key) => !MESSAGE_BODY_ALLOWED_TOP_LEVEL_KEYS.has(key))
  if (unknownKeys.length > 0) {
    return { ok: false, reason: `unknown_top_level_keys:${unknownKeys.join(',')}` }
  }

  const system = parsed.system
  if (!Array.isArray(system) || system.length < 1) {
    return { ok: false, reason: 'system_missing_or_empty' }
  }

  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    return { ok: false, reason: 'tools_not_array' }
  }

  // 1. Rewrite cc_version in system[0]
  const block0 = system[0] as SystemBlock
  if (typeof block0?.text !== 'string') {
    return { ok: false, reason: 'system0_text_missing' }
  }
  if (!CC_VERSION_REGEX.test(block0.text)) {
    return { ok: false, reason: 'system0_cc_version_missing' }
  }

  let block0Text = block0.text.replace(CC_VERSION_REGEX, `cc_version=${template.ccVersion}`)
  if (template.ccEntrypoint) {
    block0Text = block0Text.replace(CC_ENTRYPOINT_REGEX, `cc_entrypoint=${template.ccEntrypoint}`)
  }
  const newBlock0: SystemBlock = {
    type: block0.type,
    text: block0Text,
  }
  if (block0.cache_control !== undefined && block0.cache_control !== null) {
    newBlock0.cache_control = block0.cache_control
  }

  const clonedTemplateSystemBlocks = template.systemBlocks.map((block) => ({
    type: block.type,
    text: block.text,
    ...(block.cache_control ? { cache_control: { ...block.cache_control } } : {}),
  }))

  // 2. Restructure system blocks to match v2.1.131 (3 blocks)
  //    - block[0]: cc_version header (rewritten above)
  //    - block[1..]: replaced with template systemBlocks
  parsed.system = [newBlock0, ...clonedTemplateSystemBlocks]

  // 2a. Restore the client's real # Environment section.
  // Env is per-machine (cwd, platform, model id) and therefore cannot be a
  // fingerprint check target — every real Claude Code user sends a different
  // env. Keeping the template's frozen env would misleadingly expose the
  // capture-time cwd to downstream viewers (relay session UIs, logs, etc.).
  backfillEnvSection(parsed.system as SystemBlock[], system as SystemBlock[])

  // 3. Keep only captured template tool definitions. Unknown client-supplied tools
  //    must not be forwarded to the official Claude upstream.
  parsed.tools = cloneJsonArray(template.tools)

  // 4. Normalize metadata.user_id so device_id and account_uuid
  //    match the relay account, not the individual client
  if (!rewriteMetadataUserId(parsed, template)) {
    return { ok: false, reason: 'metadata_user_id_not_string' }
  }

  // 5. Normalize cache_control shape across system[1..] and messages[].content[]
  //    to match the template era (e.g. drop ttl/scope for v2.1.112).
  if (template.cacheControl) {
    normalizeCacheControl(parsed.system, template.cacheControl, 1)
    normalizeMessagesCacheControl(parsed.messages, template.cacheControl)
  }

  return { ok: true, body: Buffer.from(JSON.stringify(parsed), 'utf8') }
}

function normalizeCacheControl(
  blocks: unknown,
  shape: { type: string; ttl?: string },
  startIndex: number,
): void {
  if (!Array.isArray(blocks)) {
    return
  }
  for (let i = startIndex; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (!block || typeof block !== 'object') {
      continue
    }
    const record = block as Record<string, unknown>
    if (record.cache_control !== undefined && record.cache_control !== null) {
      record.cache_control = { ...shape }
    }
  }
}

function normalizeMessagesCacheControl(
  messages: unknown,
  shape: { type: string; ttl?: string },
): void {
  if (!Array.isArray(messages)) {
    return
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      continue
    }
    const content = (msg as Record<string, unknown>).content
    if (!Array.isArray(content)) {
      continue
    }
    normalizeCacheControl(content, shape, 0)
  }
}

function backfillEnvSection(
  rewrittenSystem: SystemBlock[],
  originalSystem: SystemBlock[],
): void {
  const original = originalSystem[originalSystem.length - 1]
  const rewritten = rewrittenSystem[rewrittenSystem.length - 1]
  if (!original || typeof original.text !== 'string') {
    return
  }
  if (!rewritten || typeof rewritten.text !== 'string') {
    return
  }

  const originalEnvIdx = original.text.indexOf(ENV_SECTION_MARKER)
  const rewrittenEnvIdx = rewritten.text.indexOf(ENV_SECTION_MARKER)
  if (originalEnvIdx === -1 || rewrittenEnvIdx === -1) {
    return
  }

  const preservedEnv = original.text.slice(originalEnvIdx)
  rewritten.text = rewritten.text.slice(0, rewrittenEnvIdx) + preservedEnv
}

function rewriteMetadataUserId(
  parsed: Record<string, unknown>,
  template: BodyTemplate,
): boolean {
  const metadata = parsed.metadata
  if (!metadata || typeof metadata !== 'object') {
    return true
  }

  const meta = metadata as Record<string, unknown>
  const raw = meta.user_id
  if (raw === undefined) {
    return true
  }

  let record: Record<string, unknown>
  if (typeof raw !== 'string') {
    record = {}
  } else {
    try {
      const userId = JSON.parse(raw) as unknown
      if (!userId || typeof userId !== 'object' || Array.isArray(userId)) {
        record = {}
      } else {
        record = userId as Record<string, unknown>
      }
    } catch {
      record = {}
    }
  }

  record.device_id = template.deviceId
  record.account_uuid = template.accountUuid
  meta.user_id = JSON.stringify(record)
  return true
}
function hasOnlyAllowedMessageBodyKeys(parsed: Record<string, unknown>): boolean {
  return Object.keys(parsed).every((key) => MESSAGE_BODY_ALLOWED_TOP_LEVEL_KEYS.has(key))
}

function cloneJsonArray(items: readonly unknown[]): unknown[] {
  return items.map((item) => JSON.parse(JSON.stringify(item)) as unknown)
}

export function rewriteEventLoggingBody(
  body: Buffer,
  template: BodyTemplate,
  clientVersion: string,
): Buffer | null {
  const text = body.toString('utf8')
  if (!text.startsWith('{')) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  walkJsonReplace(parsed, template)

  let rewritten = JSON.stringify(parsed)
  const targetSemver = template.ccVersion.split('.').slice(0, 3).join('.')
  if (clientVersion && clientVersion !== targetSemver) {
    rewritten = rewritten.replaceAll(clientVersion, targetSemver)
  }
  rewritten = rewritten.replace(CC_VERSION_FULL_REGEX, (match) => {
    if (match === template.ccVersion) {
      return match
    }
    if (/^\d+\.\d+\.\d+\.[a-z0-9]+$/i.test(match)) {
      return template.ccVersion
    }
    return match
  })

  if (rewritten === text) {
    return null
  }
  return Buffer.from(rewritten, 'utf8')
}

function walkJsonReplace(node: unknown, template: BodyTemplate): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkJsonReplace(item, template)
    }
    return
  }
  if (!node || typeof node !== 'object') {
    return
  }
  const record = node as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && EVENT_LOGGING_KEYS_TO_REWRITE.has(key)) {
      if (key === 'device_id') {
        record[key] = template.deviceId
      } else if (key === 'account_uuid') {
        record[key] = template.accountUuid
      } else if (key === 'cc_entrypoint' && template.ccEntrypoint) {
        record[key] = template.ccEntrypoint
      }
      continue
    }
    walkJsonReplace(value, template)
  }
}
