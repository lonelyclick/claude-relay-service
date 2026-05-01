import { get, post } from './client'

export type SupportTicketCategory = 'billing' | 'account' | 'integration' | 'bug' | 'other'
export type SupportTicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed'
export type SupportMessageAuthorKind = 'user' | 'agent' | 'system'

export interface SupportTicket {
  id: string
  userId: string | null
  organizationId: string | null
  organizationName: string | null
  organizationKind: 'personal' | 'team' | null
  userName: string | null
  userEmail: string | null
  category: SupportTicketCategory
  title: string
  status: SupportTicketStatus
  relatedApiKeyId: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  messageCount: number
}

export interface SupportTicketMessage {
  id: string
  ticketId: string
  authorKind: SupportMessageAuthorKind
  authorId: string | null
  authorName: string | null
  body: string
  createdAt: string
}

const enc = (v: string) => encodeURIComponent(v)

export const listSupportTickets = (params: { status?: SupportTicketStatus; search?: string } = {}) => {
  const search = new URLSearchParams()
  if (params.status) search.set('status', params.status)
  if (params.search) search.set('search', params.search)
  const qs = search.toString()
  return get<{ tickets: SupportTicket[] }>(`/admin/support/tickets${qs ? `?${qs}` : ''}`)
}

export const getSupportTicket = (ticketId: string) =>
  get<{ ticket: SupportTicket; messages: SupportTicketMessage[] }>(
    `/admin/support/tickets/${enc(ticketId)}`,
  )

export const replySupportTicket = (
  ticketId: string,
  body: { body: string; authorName?: string; authorId?: string },
) =>
  post<{ ok: true; message: SupportTicketMessage; ticket: SupportTicket }>(
    `/admin/support/tickets/${enc(ticketId)}/messages`,
    body,
  )

export const updateSupportTicketStatus = (
  ticketId: string,
  status: SupportTicketStatus,
) =>
  post<{ ok: true; ticket: SupportTicket }>(
    `/admin/support/tickets/${enc(ticketId)}/status`,
    { status },
  )
