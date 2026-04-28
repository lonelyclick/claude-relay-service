import { get, post, writeAdminSession } from './client'
import type { AdminSessionResponse } from './types'

export async function getAdminSession() {
  const data = await get<AdminSessionResponse>('/admin/session/me')
  if (data?.csrfToken) writeAdminSession({ csrfToken: data.csrfToken, user: data.user })
  return data
}

export async function exchangeAdminSession(accessToken: string) {
  const data = await post<AdminSessionResponse>('/admin/session/exchange', undefined, { bearerToken: accessToken })
  if (data?.csrfToken) writeAdminSession({ csrfToken: data.csrfToken, user: data.user })
  return data
}

export async function logoutAdminSession() {
  try {
    return await post('/admin/session/logout')
  } finally {
    const { clearAdminSession } = await import('./client')
    clearAdminSession()
  }
}
