import { get, post } from './client'
import type { User } from './types'

const BETTER_AUTH_API_URL = (
  import.meta.env.VITE_BETTER_AUTH_API_URL?.trim() ||
  '/admin/better-auth'
).replace(/\/+$/, '')

async function betterAuthGet<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value))
  }
  const queryString = params.toString()
  return get<T>(`${BETTER_AUTH_API_URL}${path}${queryString ? `?${queryString}` : ""}`)
}

async function betterAuthPost<T>(path: string, body?: unknown): Promise<T> {
  return post<T>(`${BETTER_AUTH_API_URL}${path}`, body)
}

export type BetterAuthSessionResponse = {
  session?: {
    id?: string
    userId?: string
    activeOrganizationId?: string | null
    expiresAt?: string
  } | null
  user?: BetterAuthUser | null
}

export type BetterAuthUser = {
  id: string
  name?: string | null
  email?: string | null
  emailVerified?: boolean
  image?: string | null
  role?: string | null
  banned?: boolean | null
  banReason?: string | null
  createdAt?: string | Date | null
  updatedAt?: string | Date | null
}

export type BetterAuthManagedUser = BetterAuthUser & {
  relay: User | null
  organizations: Array<{
    id: string
    name: string
    slug: string
    relayOrgId?: string | null
    metadata?: unknown
    role: string
    memberId: string
  }>
}

export type BetterAuthListUsersResponse = {
  users: BetterAuthUser[]
  total: number
  limit?: number
  offset?: number
}

export type BetterAuthOrganization = {
  id: string
  name: string
  slug: string
  logo?: string | null
  createdAt?: string | Date | null
  updatedAt?: string | Date | null
  metadata?: unknown
  memberCount?: number
  relayOrgId?: string | null
}

export type BetterAuthMember = {
  id: string
  organizationId: string
  userId: string
  role: string
  createdAt?: string | Date | null
  user?: {
    id: string
    name?: string | null
    email?: string | null
    image?: string | null
  }
}

export type BetterAuthListMembersResponse = {
  members: BetterAuthMember[]
  total: number
}

export type BetterAuthOrganizationWithMembers = BetterAuthOrganization & {
  members: BetterAuthMember[]
  memberTotal: number
}

export const getBetterAuthSession = () => betterAuthGet<BetterAuthSessionResponse>('/get-session')

export const listBetterAuthUsers = () => betterAuthGet<BetterAuthListUsersResponse>('/admin/list-users', {
  limit: 100,
  sortBy: 'createdAt',
  sortDirection: 'desc',
})

export const listBetterAuthOrganizations = () => betterAuthGet<BetterAuthOrganization[]>('/organization/list')

export async function listBetterAuthOrganizationsWithMembers(): Promise<BetterAuthOrganizationWithMembers[]> {
  const organizations = await listBetterAuthOrganizations()
  const withMembers = await Promise.all(
    organizations.map(async (organization) => {
      const response = await betterAuthGet<BetterAuthListMembersResponse>('/organization/list-members', {
        organizationId: organization.id,
        limit: 100,
      })
      return {
        ...organization,
        members: response.members,
        memberTotal: response.total,
      }
    })
  )
  return withMembers
}

export type BetterAuthUsersResponse = {
  ok: boolean
  users: BetterAuthManagedUser[]
  organizations: BetterAuthOrganization[]
}

export const listBetterAuthSyncedUsers = () => betterAuthGet<BetterAuthUsersResponse>('/users')

export const createBetterAuthUser = (body: {
  email: string
  name: string
  password?: string
  role?: string
  organizationId?: string
  memberRole?: string
}) => betterAuthPost<{ ok: boolean; user: BetterAuthUser }>('/users', body)

export const updateBetterAuthUser = (userId: string, body: {
  email?: string
  name?: string
  role?: string
  banned?: boolean
  banReason?: string | null
}) => betterAuthPost<BetterAuthUser>(`/users/${encodeURIComponent(userId)}/update`, body)

export const deleteBetterAuthUser = (userId: string) => betterAuthPost<{ success: boolean }>(`/users/${encodeURIComponent(userId)}/delete`)

export const banBetterAuthUser = (userId: string, banReason?: string) => betterAuthPost<unknown>(`/users/${encodeURIComponent(userId)}/ban`, { banReason })

export const unbanBetterAuthUser = (userId: string) => betterAuthPost<unknown>(`/users/${encodeURIComponent(userId)}/unban`)

export const createBetterAuthOrganization = (body: { name: string; slug?: string; metadata?: Record<string, unknown> }) => betterAuthPost<BetterAuthOrganization>('/organizations', body)

export const updateBetterAuthOrganization = (organizationId: string, body: { name?: string; slug?: string; metadata?: Record<string, unknown> }) => betterAuthPost<BetterAuthOrganization>(`/organizations/${encodeURIComponent(organizationId)}/update`, body)

export const deleteBetterAuthOrganization = (organizationId: string) => betterAuthPost<BetterAuthOrganization>(`/organizations/${encodeURIComponent(organizationId)}/delete`)

export const addBetterAuthOrganizationMember = (organizationId: string, body: { userId: string; role?: string }) => betterAuthPost<unknown>(`/organizations/${encodeURIComponent(organizationId)}/members`, body)

export const updateBetterAuthOrganizationMember = (organizationId: string, memberId: string, body: { role: string }) => betterAuthPost<unknown>(`/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}/update`, body)

export const deleteBetterAuthOrganizationMember = (organizationId: string, memberId: string) => betterAuthPost<unknown>(`/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}/delete`)
