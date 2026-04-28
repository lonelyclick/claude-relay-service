import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { loadBodyTemplate, type BodyTemplate } from '../proxy/bodyRewriter.js'
import {
  normalizeVmFingerprintTemplateHeaders,
  type VmFingerprintTemplateHeader,
} from '../proxy/fingerprintTemplate.js'

const vmFingerprintTemplateSchema = z.object({
  headers: z.record(z.union([z.string(), z.array(z.string())])),
})

/**
 * Lazily loads and caches body templates and VM fingerprint headers by file path.
 * null path → null (body) / [] (headers).
 */
export class FingerprintCache {
  private readonly bodyTemplates = new Map<string, { value: BodyTemplate | null; mtimeMs: number | null }>()
  private readonly vmHeaders = new Map<string, { value: VmFingerprintTemplateHeader[]; mtimeMs: number | null }>()

  getBodyTemplate(templatePath: string | null): BodyTemplate | null {
    if (!templatePath) {
      return null
    }
    const resolved = path.resolve(process.cwd(), templatePath)
    const mtimeMs = this.getMtimeMs(resolved)
    const cached = this.bodyTemplates.get(resolved)
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.value
    }
    const loaded = loadBodyTemplate(templatePath)
    this.bodyTemplates.set(resolved, { value: loaded, mtimeMs })
    return loaded
  }

  getVmFingerprintHeaders(templatePath: string | null): VmFingerprintTemplateHeader[] {
    if (!templatePath) {
      return []
    }
    const resolved = path.resolve(process.cwd(), templatePath)
    const mtimeMs = this.getMtimeMs(resolved)
    const cached = this.vmHeaders.get(resolved)
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.value
    }
    const headers = this.loadVmHeaders(resolved)
    this.vmHeaders.set(resolved, { value: headers, mtimeMs })
    return headers
  }

  invalidate(templatePath: string): void {
    const resolved = path.resolve(process.cwd(), templatePath)
    this.bodyTemplates.delete(resolved)
    this.vmHeaders.delete(resolved)
  }

  private loadVmHeaders(resolvedPath: string): VmFingerprintTemplateHeader[] {
    if (!fs.existsSync(resolvedPath)) {
      return []
    }
    const parsed = vmFingerprintTemplateSchema.parse(
      JSON.parse(fs.readFileSync(resolvedPath, 'utf8')),
    )
    return normalizeVmFingerprintTemplateHeaders(parsed.headers)
  }

  private getMtimeMs(resolvedPath: string): number | null {
    try {
      return fs.statSync(resolvedPath).mtimeMs
    } catch {
      return null
    }
  }
}
