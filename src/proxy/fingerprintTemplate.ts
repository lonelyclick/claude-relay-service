export type VmFingerprintTemplateHeader = {
  name: string
  value: string
}

const VM_FINGERPRINT_TEMPLATE_HEADER_NAMES = [
  'user-agent',
  'x-app',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-retry-count',
  'x-stainless-timeout',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'accept-language',
  'accept-encoding',
  'sec-fetch-mode',
] as const

/**
 * Special template value: use the client's original header value instead of
 * replacing it with a fixed string.  This lets the template control the
 * **position** of a header without overriding its per-request value.
 */
export const PASSTHROUGH_MARKER = '$passthrough'

const VM_FINGERPRINT_TEMPLATE_HEADER_NAME_SET: ReadonlySet<string> = new Set(
  VM_FINGERPRINT_TEMPLATE_HEADER_NAMES,
)

export function isVmFingerprintTemplateHeader(name: string): boolean {
  return VM_FINGERPRINT_TEMPLATE_HEADER_NAME_SET.has(name.toLowerCase())
}

export function normalizeVmFingerprintTemplateHeaders(
  headers: Record<string, string | readonly string[]>,
): VmFingerprintTemplateHeader[] {
  const normalized: VmFingerprintTemplateHeader[] = []

  for (const [name, rawValue] of Object.entries(headers)) {
    if (!isVmFingerprintTemplateHeader(name)) {
      continue
    }

    const value = normalizeTemplateValue(rawValue)
    if (!value) {
      continue
    }

    normalized.push({
      name,
      value,
    })
  }

  return normalized
}

export function resolveVmFingerprintTemplateValue(
  _name: string,
  templateValue: string,
  incomingValues: readonly string[],
): string {
  if (templateValue === PASSTHROUGH_MARKER) {
    return incomingValues[0] ?? ''
  }
  return templateValue
}

function normalizeTemplateValue(rawValue: string | readonly string[]): string | null {
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim()
    return trimmed || null
  }

  const values = rawValue
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (values.length === 0) {
    return null
  }

  return values.join(',')
}

