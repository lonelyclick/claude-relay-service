import { get, post } from './client'
import type { Proxy, ProxyDiagnostics, HealthCheck } from './types'

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
export const addProxy = (label: string, url: string) => post<Proxy>('/admin/proxies', { label, url })
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
