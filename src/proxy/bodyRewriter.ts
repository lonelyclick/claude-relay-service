import fs from 'node:fs'
import path from 'node:path'

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

type NamedTool = {
  name: string
}

const CC_VERSION_REGEX = /cc_version=\d+\.\d+\.\d+\.\w+/
const CC_ENTRYPOINT_REGEX = /cc_entrypoint=\S+?(?=;|$)/
const CC_VERSION_FULL_REGEX = /\b\d+\.\d+\.\d+\.[a-z0-9]+\b/gi
const ENV_SECTION_MARKER = '\n# Environment\n'
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
  return raw as BodyTemplate
}

export function rewriteMessageBody(
  body: Buffer,
  template: BodyTemplate,
): Buffer | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }

  const system = parsed.system
  if (!Array.isArray(system) || system.length < 1) {
    return null
  }

  const tools = parsed.tools
  if (!Array.isArray(tools)) {
    return null
  }

  // 1. Rewrite cc_version in system[0]
  const block0 = system[0] as SystemBlock
  if (typeof block0?.text !== 'string' || !CC_VERSION_REGEX.test(block0.text)) {
    return null
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

  // 2. Restructure system blocks to match v2.1.98 (3 blocks)
  //    - block[0]: cc_version header (rewritten above)
  //    - block[1..]: replaced with template systemBlocks
  parsed.system = [newBlock0, ...clonedTemplateSystemBlocks]

  // 2a. Restore the client's real # Environment section.
  // Env is per-machine (cwd, platform, model id) and therefore cannot be a
  // fingerprint check target — every real Claude Code user sends a different
  // env. Keeping the template's frozen env would misleadingly expose the
  // capture-time cwd to downstream viewers (relay session UIs, logs, etc.).
  backfillEnvSection(parsed.system as SystemBlock[], system as SystemBlock[])

  // 3. Keep template tool definitions, but preserve request-only tools such as MCP tools.
  parsed.tools = mergeTools(template.tools, tools)

  // 4. Normalize metadata.user_id so device_id and account_uuid
  //    match the relay account, not the individual client
  rewriteMetadataUserId(parsed, template)

  // 5. Normalize cache_control shape across system[1..] and messages[].content[]
  //    to match the template era (e.g. drop ttl/scope for v2.1.112).
  if (template.cacheControl) {
    normalizeCacheControl(parsed.system, template.cacheControl, 1)
    normalizeMessagesCacheControl(parsed.messages, template.cacheControl)
  }

  return Buffer.from(JSON.stringify(parsed), 'utf8')
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
): void {
  const metadata = parsed.metadata
  if (!metadata || typeof metadata !== 'object') {
    return
  }

  const meta = metadata as Record<string, unknown>
  const raw = meta.user_id
  if (typeof raw !== 'string') {
    return
  }

  try {
    const userId = JSON.parse(raw) as Record<string, unknown>
    userId.device_id = template.deviceId
    userId.account_uuid = template.accountUuid
    meta.user_id = JSON.stringify(userId)
  } catch {
    // malformed user_id JSON — leave as-is
  }
}

function mergeTools(
  templateTools: readonly unknown[],
  requestTools: readonly unknown[],
): unknown[] {
  const merged = [...templateTools]
  const seenNames = new Set<string>()

  for (const tool of templateTools) {
    const name = getToolName(tool)
    if (name) {
      seenNames.add(name)
    }
  }

  for (const tool of requestTools) {
    const name = getToolName(tool)
    if (!name) {
      merged.push(tool)
      continue
    }
    if (!seenNames.has(name)) {
      merged.push(tool)
      seenNames.add(name)
    }
  }

  return merged
}

function getToolName(tool: unknown): string | null {
  if (!tool || typeof tool !== 'object') {
    return null
  }
  const name = (tool as Partial<NamedTool>).name
  return typeof name === 'string' && name.length > 0 ? name : null
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
