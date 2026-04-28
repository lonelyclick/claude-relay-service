const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u
const CONTROL_CHAR_GLOBAL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n
const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n

export const MAX_USER_NAME_LENGTH = 120
export const MAX_BILLING_RULE_NAME_LENGTH = 160
export const MAX_BILLING_NOTE_LENGTH = 280
export const MAX_SCOPE_FIELD_LENGTH = 200
export const MAX_ROUTING_GROUP_ID_LENGTH = 120
export const SUPPORTED_BILLING_CURRENCIES = ['USD', 'CNY'] as const

export class InputValidationError extends Error {
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'InputValidationError'
  }
}

type TextOptions = {
  field: string
  maxLength: number
}

export function normalizeOptionalText(
  value: unknown,
  options: TextOptions,
): string | null {
  if (value == null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new InputValidationError(`${options.field} must be a string`)
  }

  const normalized = value.trim()
  if (!normalized) {
    return null
  }
  if (normalized.length > options.maxLength) {
    throw new InputValidationError(`${options.field} is too long`)
  }
  if (CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new InputValidationError(`${options.field} contains unsupported control characters`)
  }
  return normalized
}

export function normalizeRequiredText(
  value: unknown,
  options: TextOptions,
): string {
  const normalized = normalizeOptionalText(value, options)
  if (!normalized) {
    throw new InputValidationError(`${options.field} is required`)
  }
  return normalized
}

type BigIntOptions = {
  field: string
  allowNegative: boolean
  allowZero: boolean
}

function normalizeBigIntString(value: unknown, options: BigIntOptions): string {
  if (value == null || value === '') {
    throw new InputValidationError(`${options.field} is required`)
  }

  let normalized: string
  if (typeof value === 'bigint') {
    normalized = value.toString()
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new InputValidationError(`${options.field} must be an integer`)
    }
    normalized = String(value)
  } else if (typeof value === 'string') {
    normalized = value.trim()
  } else {
    throw new InputValidationError(`${options.field} must be an integer`)
  }

  if (!normalized) {
    throw new InputValidationError(`${options.field} is required`)
  }
  if (!/^-?\d+$/.test(normalized)) {
    throw new InputValidationError(`${options.field} must be an integer`)
  }
  if (!options.allowNegative && normalized.startsWith('-')) {
    throw new InputValidationError(`${options.field} must not be negative`)
  }

  const parsed = BigInt(normalized)
  if (!options.allowZero && parsed === 0n) {
    throw new InputValidationError(`${options.field} must not be zero`)
  }
  if (parsed < POSTGRES_BIGINT_MIN || parsed > POSTGRES_BIGINT_MAX) {
    throw new InputValidationError(`${options.field} is out of range`)
  }
  return parsed.toString()
}

export function normalizeSignedBigIntString(
  value: unknown,
  options: { field: string; allowZero?: boolean },
): string {
  return normalizeBigIntString(value, {
    field: options.field,
    allowNegative: true,
    allowZero: options.allowZero ?? false,
  })
}

export function normalizeUnsignedBigIntString(
  value: unknown,
  options: { field: string; allowZero?: boolean },
): string {
  return normalizeBigIntString(value, {
    field: options.field,
    allowNegative: false,
    allowZero: options.allowZero ?? true,
  })
}

export function normalizeBillingCurrency(
  value: unknown,
  options?: {
    field?: string
    fallback?: (typeof SUPPORTED_BILLING_CURRENCIES)[number]
  },
): (typeof SUPPORTED_BILLING_CURRENCIES)[number] {
  const field = options?.field ?? 'billingCurrency'

  if (value == null || value === '') {
    if (options?.fallback) {
      return options.fallback
    }
    throw new InputValidationError(`${field} is required`)
  }

  if (typeof value !== 'string') {
    throw new InputValidationError(`${field} must be a string`)
  }

  const normalized = value.trim().toUpperCase()
  if (!normalized) {
    if (options?.fallback) {
      return options.fallback
    }
    throw new InputValidationError(`${field} is required`)
  }

  const canonical = normalized === 'RMB' ? 'CNY' : normalized
  if (canonical === 'USD' || canonical === 'CNY') {
    return canonical
  }

  throw new InputValidationError(`${field} must be one of: USD, CNY`)
}

export function sanitizeErrorMessage(error: unknown, fallback = 'Unexpected error'): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const normalized = message
    .replace(CONTROL_CHAR_GLOBAL_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return fallback
  }
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`
}
