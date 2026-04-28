import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { normalizeVmFingerprintTemplateHeaders } from '../proxy/fingerprintTemplate.js'

type CaptureEvent = {
  event?: string
  incomingRawHeaders?: string[]
  upstreamRequestHeaders?: string[]
}

function main(): void {
  const inputPath = process.argv[2]
  if (!inputPath) {
    process.stderr.write(
      '用法: node --import tsx src/tools/extractVmFingerprintTemplate.ts <relay-log-path>\n',
    )
    process.exitCode = 1
    return
  }

  const resolvedPath = path.resolve(process.cwd(), inputPath)
  const lines = fs.readFileSync(resolvedPath, 'utf8').split(/\r?\n/)
  const captureEvent = findLatestCaptureEvent(lines)
  if (!captureEvent) {
    throw new Error(`在 ${resolvedPath} 里没有找到 http_request_capture 事件`)
  }

  const rawHeaders = captureEvent.incomingRawHeaders ?? captureEvent.upstreamRequestHeaders ?? []
  const templateHeaders = normalizeVmFingerprintTemplateHeaders(
    Object.fromEntries(parseHeaderPairs(rawHeaders)),
  )

  if (templateHeaders.length === 0) {
    throw new Error(`在 ${resolvedPath} 里没有找到可用于 VM 模板的 header`)
  }

  process.stdout.write(
    `${JSON.stringify({
      headers: Object.fromEntries(
        templateHeaders.map((header) => [header.name, header.value] as const),
      ),
    }, null, 2)}\n`,
  )
}

function findLatestCaptureEvent(lines: string[]): CaptureEvent | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) {
      continue
    }

    try {
      const parsed = JSON.parse(line) as CaptureEvent
      if (parsed.event === 'http_request_capture') {
        return parsed
      }
    } catch {
      continue
    }
  }

  return null
}

function parseHeaderPairs(rawHeaders: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []

  for (let index = 0; index < rawHeaders.length - 1; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (typeof name === 'string' && typeof value === 'string') {
      pairs.push([name, value])
    }
  }

  return pairs
}

main()
