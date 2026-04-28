import { API_URL, STORAGE_KEYS } from '~/lib/constants'

export class ApiError extends Error {
  status: number
  payload: unknown
  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

interface AdminSession {
  csrfToken: string
  user?: unknown
}

function readAdminSession(): AdminSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.ADMIN_SESSION)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeAdminSession(state: AdminSession) {
  sessionStorage.setItem(STORAGE_KEYS.ADMIN_SESSION, JSON.stringify(state))
}

export function clearAdminSession() {
  sessionStorage.removeItem(STORAGE_KEYS.ADMIN_SESSION)
}

interface RequestOptions {
  bearerToken?: string
  headers?: Record<string, string>
}

async function request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const url = `${API_URL}${path}`
  const headers = new Headers(options.headers)
  const session = readAdminSession()

  if (body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (options.bearerToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${options.bearerToken}`)
  }

  if (path.startsWith('/admin') && !path.startsWith('/admin/session/') && session?.csrfToken && !headers.has('X-Admin-CSRF')) {
    headers.set('X-Admin-CSRF', session.csrfToken)
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })

  const rawText = await res.text()
  let data: unknown = null
  if (rawText) {
    try {
      data = JSON.parse(rawText)
    } catch {
      data = rawText
    }
  }

  if (!res.ok) {
    const obj = data as Record<string, unknown> | null
    const message =
      (obj?.message as string) ??
      ((obj?.error as Record<string, unknown>)?.message as string) ??
      (obj?.error as string) ??
      (typeof data === 'string' ? data : `HTTP ${res.status}`)
    throw new ApiError(message, res.status, data)
  }

  return data as T
}

export function get<T>(path: string, options?: RequestOptions) {
  return request<T>('GET', path, undefined, options)
}

export function post<T>(path: string, body?: unknown, options?: RequestOptions) {
  return request<T>('POST', path, body, options)
}

export function del<T>(path: string, options?: RequestOptions) {
  return request<T>('DELETE', path, undefined, options)
}
