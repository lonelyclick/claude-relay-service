import { del, get, post } from './client'
import type {
  BillingCurrency,
  CreatedRelayApiKey,
  RelayKeySource,
  RelayApiKey,
  RequestDetail,
  User,
  UserApiKeyRead,
  UserRequest,
  UserSession,
} from './types'

const enc = (v: string) => encodeURIComponent(v)

export const listUsers = () => get<{ users: User[] }>('/admin/users')
export const createUser = (name: string, billingCurrency?: BillingCurrency) =>
  post<{
    user: User
    apiKey: string
    apiKeySource?: 'relay_api_keys' | 'relay_users_legacy'
    primaryApiKey?: CreatedRelayApiKey | null
  }>('/admin/users', { name, billingCurrency })
export const getUser = async (id: string) => {
  const res = await get<{ user: User }>(`/admin/users/${enc(id)}`)
  return res.user
}
export const getUserApiKey = (id: string) =>
  get<UserApiKeyRead>(`/admin/users/${enc(id)}/api-key`)
export const listUserApiKeys = (id: string) =>
  get<{ apiKeys: RelayApiKey[]; max: number }>(`/admin/users/${enc(id)}/api-keys`)
export const createUserApiKey = (id: string, name?: string) =>
  post<CreatedRelayApiKey & { created: boolean }>(`/admin/users/${enc(id)}/api-keys`, { name })
export const revokeUserApiKey = (id: string, keyId: string) =>
  del<{ revoked: boolean; apiKey: RelayApiKey }>(`/admin/users/${enc(id)}/api-keys/${enc(keyId)}`)
export const updateUser = (id: string, updates: Record<string, unknown>) => post(`/admin/users/${enc(id)}/update`, updates)
export const deleteUser = (id: string) => post(`/admin/users/${enc(id)}/delete`)
export const regenerateUserKey = (id: string) =>
  post<{
    apiKey: string
    apiKeySource?: 'relay_api_keys' | 'relay_users_legacy'
    primaryApiKey?: CreatedRelayApiKey | null
    revokedApiKey?: RelayApiKey | null
    legacyApiKeyRetained?: boolean
    rotationMode?: string
  }>(`/admin/users/${enc(id)}/regenerate-key`)
export const getUserSessions = (id: string) => get<{ sessions: UserSession[] }>(`/admin/users/${enc(id)}/sessions`)
export const getUserRequests = (id: string, limit = 50, offset = 0, relayKeySource?: RelayKeySource | null) => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  })
  if (relayKeySource) {
    params.set('relayKeySource', relayKeySource)
  }
  return get<{ requests: UserRequest[]; total: number }>(`/admin/users/${enc(id)}/requests?${params.toString()}`)
}
export const getSessionRequests = (
  userId: string,
  sessionKey: string,
  limit = 100,
  offset = 0,
  relayKeySource?: RelayKeySource | null,
) => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  })
  if (relayKeySource) {
    params.set('relayKeySource', relayKeySource)
  }
  return get<{ requests: UserRequest[]; total: number }>(`/admin/users/${enc(userId)}/sessions/${enc(sessionKey)}/requests?${params.toString()}`)
}
export const getRequestDetail = async (userId: string, requestId: string, usageRecordId?: number) => {
  const params = new URLSearchParams()
  if (usageRecordId != null) {
    params.set('usageRecordId', String(usageRecordId))
  }
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const res = await get<{ request: RequestDetail }>(`/admin/users/${enc(userId)}/requests/${enc(requestId)}${suffix}`)
  return res.request
}
