export class RelayControlConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayControlConfigError'
  }
}

export type RelayControlRequest = {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'
  path: string
  body?: unknown
  query?: Record<string, string | null | undefined>
  headers?: Record<string, string | null | undefined>
}

export type RelayControlResponse = {
  status: number
  data: unknown
}

function normalizeBaseUrl(baseUrl: string | null): string {
  if (!baseUrl) {
    throw new RelayControlConfigError('RELAY_CONTROL_URL is not configured')
  }
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

export function createRelayControlClient(
  baseUrl: string | null,
  token: string | null,
  timeoutMs = 30_000,
) {
  return {
    async request(input: RelayControlRequest): Promise<RelayControlResponse> {
      if (!token) {
        throw new RelayControlConfigError('INTERNAL_TOKEN is not configured')
      }

      const url = new URL(input.path.replace(/^\//, ''), normalizeBaseUrl(baseUrl))
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value)
        }
      }

      const extraHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(input.headers ?? {})) {
        if (value === undefined || value === null) continue
        extraHeaders[key.toLowerCase()] = String(value).slice(0, 1024)
      }
      const response = await fetch(url, {
        method: input.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(timeoutMs),
      })

      const text = await response.text()
      let data: unknown = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = { message: text }
        }
      }

      return {
        status: response.status,
        data,
      }
    },
  }
}
