import type { RelayKeySource } from '~/api/types'
import {
  normalizeUsersLegacyOrderMode,
  normalizeUsersLegacyViewMode,
  type UsersLegacyOrderMode,
  type UsersLegacyViewMode,
} from './usersListView'

/**
 * These query params only restore the recent-window admin drill-down flow between
 * Users, User Detail, and Request Detail. They are not durable audit identifiers
 * or full-history navigation state.
 */

type UserDetailFilters = {
  device?: string | null
  relayKeySource?: RelayKeySource | null
}

export function normalizeUserDetailRelayKeySource(value: string | null): RelayKeySource | null {
  return value === 'relay_api_keys' || value === 'relay_users_legacy' ? value : null
}

export type UsersListReturnState = {
  legacyView: UsersLegacyViewMode
  legacyOrder: UsersLegacyOrderMode
}

export type UserDetailPageState = {
  device: string | null
  relayKeySource: RelayKeySource | null
  sessionKey: string | null
  sessionRequestId: string | null
  usersListReturnState: UsersListReturnState
}

export type UserDetailReturnState = UserDetailFilters & {
  sessionKey?: string | null
  usersListReturnState?: UsersListReturnState | null
}

const USERS_LIST_QUERY_PARAM = {
  legacyView: 'legacyView',
  legacyOrder: 'legacyOrder',
} as const

const USERS_LIST_RETURN_QUERY_PARAM = {
  legacyView: 'returnLegacyView',
  legacyOrder: 'returnLegacyOrder',
} as const

const USER_DETAIL_QUERY_PARAM = {
  device: 'device',
  relayKeySource: 'relayKeySource',
  sessionKey: 'sessionKey',
  sessionRequestId: 'sessionRequestId',
} as const

const USER_DETAIL_RETURN_QUERY_PARAM = {
  device: 'returnDevice',
  relayKeySource: 'returnRelayKeySource',
  sessionKey: 'returnSessionKey',
} as const

function normalizeSessionKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeSessionRequestId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function buildSessionAnchorId(sessionKey: string): string {
  return `session-${encodeURIComponent(sessionKey)}`
}

export function buildSessionRequestAnchorId(sessionKey: string, requestId: string): string {
  return `session-request-${encodeURIComponent(sessionKey)}--${encodeURIComponent(requestId)}`
}

export function resolveExpandedSessionKey(
  requestedSessionKey: string | null | undefined,
  sessions: ReadonlyArray<{ sessionKey: string }>,
): string | null {
  const sessionKey = normalizeSessionKey(requestedSessionKey)
  if (!sessionKey) {
    return null
  }
  return sessions.some((session) => session.sessionKey === sessionKey) ? sessionKey : null
}

export function resolveRestoredSessionRequestId(
  requestedRequestId: string | null | undefined,
  requests: ReadonlyArray<{ requestId: string }>,
): string | null {
  const requestId = normalizeSessionRequestId(requestedRequestId)
  if (!requestId) {
    return null
  }
  return requests.some((request) => request.requestId === requestId) ? requestId : null
}

export const RESTORED_SESSION_REQUEST_HIGHLIGHT_MS = 1800

export function isRestoredSessionRequestHighlighted(
  requestId: string,
  highlightedRequestId: string | null | undefined,
): boolean {
  return highlightedRequestId != null && highlightedRequestId === requestId
}

function readSearchParam(searchParams: URLSearchParams, key: string): string | null {
  return searchParams.get(key)
}

function appendUserDetailFilters(
  params: URLSearchParams,
  filters: UserDetailFilters,
  names: {
    device: string
    relayKeySource: string
  } = {
    device: USER_DETAIL_QUERY_PARAM.device,
    relayKeySource: USER_DETAIL_QUERY_PARAM.relayKeySource,
  },
): void {
  if (filters.device) {
    params.set(names.device, filters.device)
  }
  if (filters.relayKeySource) {
    params.set(names.relayKeySource, filters.relayKeySource)
  }
}

function appendUsersListReturnState(
  params: URLSearchParams,
  returnState: UsersListReturnState | null | undefined,
): void {
  if (!returnState) {
    return
  }
  if (returnState.legacyView !== 'all') {
    params.set(USERS_LIST_RETURN_QUERY_PARAM.legacyView, returnState.legacyView)
  }
  if (returnState.legacyOrder !== 'default') {
    params.set(USERS_LIST_RETURN_QUERY_PARAM.legacyOrder, returnState.legacyOrder)
  }
}

function appendUserDetailReturnState(
  params: URLSearchParams,
  returnState: UserDetailReturnState | null | undefined,
): void {
  if (!returnState) {
    return
  }
  appendUserDetailFilters(params, returnState, {
    device: USER_DETAIL_RETURN_QUERY_PARAM.device,
    relayKeySource: USER_DETAIL_RETURN_QUERY_PARAM.relayKeySource,
  })
  const sessionKey = normalizeSessionKey(returnState.sessionKey)
  if (sessionKey) {
    params.set(USER_DETAIL_RETURN_QUERY_PARAM.sessionKey, sessionKey)
  }
  appendUsersListReturnState(params, returnState.usersListReturnState)
}

export function buildUsersHref(returnState: UsersListReturnState | null | undefined): string {
  const params = new URLSearchParams()
  if (returnState?.legacyView && returnState.legacyView !== 'all') {
    params.set(USERS_LIST_QUERY_PARAM.legacyView, returnState.legacyView)
  }
  if (returnState?.legacyOrder && returnState.legacyOrder !== 'default') {
    params.set(USERS_LIST_QUERY_PARAM.legacyOrder, returnState.legacyOrder)
  }
  const query = params.toString()
  return `/users${query ? `?${query}` : ''}`
}

export function readUsersListReturnState(searchParams: URLSearchParams): UsersListReturnState {
  return {
    legacyView: normalizeUsersLegacyViewMode(readSearchParam(searchParams, USERS_LIST_RETURN_QUERY_PARAM.legacyView)),
    legacyOrder: normalizeUsersLegacyOrderMode(readSearchParam(searchParams, USERS_LIST_RETURN_QUERY_PARAM.legacyOrder)),
  }
}

export function readUserDetailPageState(searchParams: URLSearchParams): UserDetailPageState {
  return {
    device: readSearchParam(searchParams, USER_DETAIL_QUERY_PARAM.device) || null,
    relayKeySource: normalizeUserDetailRelayKeySource(readSearchParam(searchParams, USER_DETAIL_QUERY_PARAM.relayKeySource)),
    sessionKey: normalizeSessionKey(readSearchParam(searchParams, USER_DETAIL_QUERY_PARAM.sessionKey)),
    sessionRequestId: normalizeSessionRequestId(readSearchParam(searchParams, USER_DETAIL_QUERY_PARAM.sessionRequestId)),
    usersListReturnState: readUsersListReturnState(searchParams),
  }
}

export function buildUserDetailHref(
  userId: string,
  filters: UserDetailFilters,
  hash?: string,
  returnState?: UsersListReturnState,
): string {
  const params = new URLSearchParams()
  appendUserDetailFilters(params, filters)
  appendUsersListReturnState(params, returnState)
  const query = params.toString()
  const fragment = hash ? `#${hash}` : ''
  return `/users/${encodeURIComponent(userId)}${query ? `?${query}` : ''}${fragment}`
}

export function buildLegacyRequestsHref(
  userId: string,
  returnState?: UsersListReturnState,
): string {
  return buildUserDetailHref(userId, { relayKeySource: 'relay_users_legacy' }, 'requests', returnState)
}

export function buildRequestDetailHref(
  userId: string,
  requestId: string,
  options?: {
    usageRecordId?: number | null
    returnState?: UserDetailReturnState | null
  },
): string {
  const params = new URLSearchParams()
  if (options?.usageRecordId != null) {
    params.set('usageRecordId', String(options.usageRecordId))
  }
  appendUserDetailReturnState(params, options?.returnState)
  const query = params.toString()
  return `/users/${encodeURIComponent(userId)}/requests/${encodeURIComponent(requestId)}${query ? `?${query}` : ''}`
}

export function readUserDetailReturnState(searchParams: URLSearchParams): UserDetailReturnState {
  return {
    device: readSearchParam(searchParams, USER_DETAIL_RETURN_QUERY_PARAM.device) || null,
    relayKeySource: normalizeUserDetailRelayKeySource(readSearchParam(searchParams, USER_DETAIL_RETURN_QUERY_PARAM.relayKeySource)),
    sessionKey: normalizeSessionKey(readSearchParam(searchParams, USER_DETAIL_RETURN_QUERY_PARAM.sessionKey)),
    usersListReturnState: readUsersListReturnState(searchParams),
  }
}

export function buildUserDetailReturnHref(
  userId: string,
  returnState: UserDetailReturnState | null | undefined,
  options?: {
    sessionRequestId?: string | null
  },
): string {
  const params = new URLSearchParams()
  appendUserDetailFilters(params, {
    device: returnState?.device,
    relayKeySource: returnState?.relayKeySource,
  })
  const sessionKey = normalizeSessionKey(returnState?.sessionKey)
  const sessionRequestId = sessionKey ? normalizeSessionRequestId(options?.sessionRequestId) : null
  if (sessionKey) {
    params.set(USER_DETAIL_QUERY_PARAM.sessionKey, sessionKey)
  }
  if (sessionRequestId) {
    params.set(USER_DETAIL_QUERY_PARAM.sessionRequestId, sessionRequestId)
  }
  appendUsersListReturnState(params, returnState?.usersListReturnState)
  const query = params.toString()
  const hash = sessionKey ? buildSessionAnchorId(sessionKey) : 'requests'
  return `/users/${encodeURIComponent(userId)}${query ? `?${query}` : ''}#${hash}`
}
