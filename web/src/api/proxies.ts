import { get, post } from './client'
import type { Proxy, ProxyDiagnostics, HealthCheck, XraySyncResult } from './types'

const enc = (v: string) => encodeURIComponent(v)

export const healthz = () => get<HealthCheck>('/healthz')
export const listProxies = async () => {
  const res = await get<{ proxies: Proxy[] }>('/admin/proxies')
  return {
    proxies: res.proxies.map((proxy) => ({
      ...proxy,
      createdAt:
        typeof proxy.createdAt === 'number'
          ? new Date(proxy.createdAt).toISOString()
          : proxy.createdAt,
    })),
  }
}
export const addProxy = (input: { label: string; url: string; kind?: string; localUrl?: string | null; inboundPort?: number | null; inboundProtocol?: string; enabled?: boolean }) =>
  post<Proxy>('/admin/proxies', input)
export const importProxies = (input: { text: string; portBase?: number | null }) =>
  post<{ ok: boolean; proxies: Proxy[]; errors: Array<{ line: string; error: string }> }>('/admin/proxies/import', input)
export const updateProxy = (id: string, updates: Record<string, unknown>) => post(`/admin/proxies/${enc(id)}/update`, updates)
export const deleteProxy = (id: string) => post(`/admin/proxies/${enc(id)}/delete`)
export const linkAccountsToProxy = (proxyId: string, accountIds: string[]) =>
  post(`/admin/proxies/${enc(proxyId)}/link`, { accountIds })
export const unlinkAccountFromProxy = (proxyId: string, accountId: string) =>
  post(`/admin/proxies/${enc(proxyId)}/unlink`, { accountId })
export const probeProxy = async (proxyId: string) => {
  const res = await post<{ ok: boolean; diagnostics: ProxyDiagnostics }>(`/admin/proxies/${enc(proxyId)}/probe`)
  return res.diagnostics
}
export const syncXrayConfig = async (options: { dryRun?: boolean; validate?: boolean; restart?: boolean } = {}) => {
  const res = await post<{ ok: boolean; result: XraySyncResult }>('/admin/xray/sync', options)
  return res.result
}
