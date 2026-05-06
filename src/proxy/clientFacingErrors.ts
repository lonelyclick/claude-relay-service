import { RoutingGuardError } from '../oauth/service.js'
import {
  ForcedAccountNotFoundError,
  ForcedAccountUnavailableError,
  SchedulerCapacityError,
} from '../scheduler/accountScheduler.js'
import { CliValidationError } from './cliValidator.js'

export class RoutingGroupAccessError extends Error {
  constructor(readonly routingGroupId: string) {
    super(`Routing group is disabled: ${routingGroupId}`)
    this.name = 'RoutingGroupAccessError'
  }
}

export const RELAY_ERROR_CODES = {
  BAD_REQUEST: 'TQ_BAD_REQUEST',
  UNAUTHORIZED: 'TQ_UNAUTHORIZED',
  PAYMENT_REQUIRED: 'TQ_PAYMENT_REQUIRED',
  FORBIDDEN: 'TQ_FORBIDDEN',
  ROUTE_NOT_FOUND: 'TQ_ROUTE_NOT_FOUND',
  METHOD_NOT_ALLOWED: 'TQ_METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'TQ_PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'TQ_RATE_LIMITED',
  INTERNAL_ERROR: 'TQ_INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'TQ_SERVICE_UNAVAILABLE',
  PROVIDER_ROUTE_UNSUPPORTED: 'TQ_PROVIDER_ROUTE_UNSUPPORTED',
  PROVIDER_WS_UNSUPPORTED: 'TQ_PROVIDER_WS_UNSUPPORTED',
  OVERLOADED: 'TQ_OVERLOADED',
  UNSUPPORTED_CLIENT: 'TQ_UNSUPPORTED_CLIENT',
  UNSUPPORTED_CLIENT_VERSION: 'TQ_UNSUPPORTED_CLIENT_VERSION',
  INVALID_FORCE_ACCOUNT: 'TQ_INVALID_FORCE_ACCOUNT',
  RELAY_USER_REJECTED: 'TQ_RELAY_USER_REJECTED',
  RELAY_KEY_PREFIX_TYPO: 'TQ_RELAY_KEY_PREFIX_TYPO',
  RELAY_KEY_LOOKS_LIKE_VENDOR: 'TQ_RELAY_KEY_LOOKS_LIKE_VENDOR',
  BILLING_INSUFFICIENT_BALANCE: 'TQ_BILLING_INSUFFICIENT_BALANCE',
  BILLING_RULE_MISSING: 'TQ_BILLING_RULE_MISSING',
  BODY_TOO_LARGE: 'TQ_BODY_TOO_LARGE',
  ROUTING_GROUP_UNAVAILABLE: 'TQ_ROUTING_GROUP_UNAVAILABLE',
  ROUTING_GUARD_LIMIT: 'TQ_ROUTING_GUARD_LIMIT',
  SCHEDULER_CAPACITY: 'TQ_SCHEDULER_CAPACITY',
  ACCOUNT_NOT_FOUND: 'TQ_ACCOUNT_NOT_FOUND',
  ACCOUNT_UNAVAILABLE: 'TQ_ACCOUNT_UNAVAILABLE',
  ACCOUNT_RATE_LIMITED: 'TQ_ACCOUNT_RATE_LIMITED',
  ACCOUNT_POOL_UNAVAILABLE: 'TQ_ACCOUNT_POOL_UNAVAILABLE',
  ACCOUNT_POOL_RATE_LIMITED: 'TQ_ACCOUNT_POOL_RATE_LIMITED',
  UPSTREAM_CONFIG_UNAVAILABLE: 'TQ_UPSTREAM_CONFIG_UNAVAILABLE',
  UPSTREAM_INCIDENT_ACTIVE: 'TQ_UPSTREAM_INCIDENT_ACTIVE',
} as const

export type RelayErrorCode = typeof RELAY_ERROR_CODES[keyof typeof RELAY_ERROR_CODES]

export type ClientFacingRelayError = {
  statusCode: number
  message: string
  code: RelayErrorCode
}

const GENERIC_UNAVAILABLE_MESSAGE = 'Service is temporarily unavailable. Please try again later.'

export function fallbackRelayErrorCode(statusCode: number): RelayErrorCode {
  switch (statusCode) {
    case 400:
      return RELAY_ERROR_CODES.BAD_REQUEST
    case 401:
      return RELAY_ERROR_CODES.UNAUTHORIZED
    case 402:
      return RELAY_ERROR_CODES.PAYMENT_REQUIRED
    case 403:
      return RELAY_ERROR_CODES.FORBIDDEN
    case 404:
      return RELAY_ERROR_CODES.ROUTE_NOT_FOUND
    case 405:
      return RELAY_ERROR_CODES.METHOD_NOT_ALLOWED
    case 413:
      return RELAY_ERROR_CODES.PAYLOAD_TOO_LARGE
    case 429:
      return RELAY_ERROR_CODES.RATE_LIMITED
    case 501:
      return RELAY_ERROR_CODES.PROVIDER_ROUTE_UNSUPPORTED
    case 503:
      return RELAY_ERROR_CODES.SERVICE_UNAVAILABLE
    case 529:
      return RELAY_ERROR_CODES.OVERLOADED
    default:
      return statusCode >= 500
        ? RELAY_ERROR_CODES.INTERNAL_ERROR
        : RELAY_ERROR_CODES.BAD_REQUEST
  }
}

export function classifyClientFacingRelayError(error: unknown): ClientFacingRelayError | null {
  if (error instanceof CliValidationError) {
    return {
      statusCode: 400,
      message: 'Unsupported client.',
      code: RELAY_ERROR_CODES.UNSUPPORTED_CLIENT,
    }
  }

  if (error instanceof SchedulerCapacityError) {
    return {
      statusCode: 529,
      message: 'Service is at capacity. Please try again later.',
      code: RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
    }
  }

  if (error instanceof RoutingGuardError) {
    return {
      statusCode: 429,
      message: error.message,
      code: RELAY_ERROR_CODES.ROUTING_GUARD_LIMIT,
    }
  }

  if (error instanceof RoutingGroupAccessError) {
    return {
      statusCode: 403,
      message: 'Requested routing group is unavailable.',
      code: RELAY_ERROR_CODES.ROUTING_GROUP_UNAVAILABLE,
    }
  }

  if (error instanceof ForcedAccountNotFoundError) {
    return {
      statusCode: 404,
      message: 'Requested account was not found.',
      code: RELAY_ERROR_CODES.ACCOUNT_NOT_FOUND,
    }
  }

  if (error instanceof ForcedAccountUnavailableError) {
    return classifyForcedAccountUnavailable(error.reason)
  }

  const message = error instanceof Error ? error.message : String(error)

  if (/^No available OAuth accounts|^No available accounts in group /.test(message)) {
    const looksRateLimited =
      /blocked=[^)]*(?:rate_limit|cooldown)|rate_limit:|health_rate_limited/.test(message)
    return {
      statusCode: 503,
      message: GENERIC_UNAVAILABLE_MESSAGE,
      code: looksRateLimited
        ? RELAY_ERROR_CODES.ACCOUNT_POOL_RATE_LIMITED
        : RELAY_ERROR_CODES.ACCOUNT_POOL_UNAVAILABLE,
    }
  }

  if (/^Routing group is disabled:/.test(message)) {
    return {
      statusCode: 403,
      message: 'Requested routing group is unavailable.',
      code: RELAY_ERROR_CODES.ROUTING_GROUP_UNAVAILABLE,
    }
  }

  if (/^Account not found:/.test(message)) {
    return {
      statusCode: 404,
      message: 'Requested account was not found.',
      code: RELAY_ERROR_CODES.ACCOUNT_NOT_FOUND,
    }
  }

  if (/^Account currently unavailable:/.test(message)) {
    return {
      statusCode: 503,
      message: 'Requested account is unavailable. Please try again later.',
      code: RELAY_ERROR_CODES.ACCOUNT_UNAVAILABLE,
    }
  }

  if (
    /Global upstream proxy is required|has no proxy configured|missing apiBaseUrl|missing modelName|missing chatgpt workspace id|is not openai-codex|is not openai-compatible|is not claude-compatible/.test(message)
  ) {
    return {
      statusCode: 503,
      message: GENERIC_UNAVAILABLE_MESSAGE,
      code: RELAY_ERROR_CODES.UPSTREAM_CONFIG_UNAVAILABLE,
    }
  }

  return null
}

function classifyForcedAccountUnavailable(reason: string | null): ClientFacingRelayError {
  if (reason?.startsWith('rate_limit:') || reason === 'health_rate_limited') {
    return {
      statusCode: 429,
      message: 'Requested account is temporarily rate limited. Please try again later.',
      code: RELAY_ERROR_CODES.ACCOUNT_RATE_LIMITED,
    }
  }

  if (reason === 'capacity_exhausted') {
    return {
      statusCode: 529,
      message: 'Service is at capacity. Please try again later.',
      code: RELAY_ERROR_CODES.SCHEDULER_CAPACITY,
    }
  }

  return {
    statusCode: 503,
    message: 'Requested account is unavailable. Please try again later.',
    code: RELAY_ERROR_CODES.ACCOUNT_UNAVAILABLE,
  }
}
