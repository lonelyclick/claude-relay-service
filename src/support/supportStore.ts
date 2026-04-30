import crypto from 'node:crypto'

import pg from 'pg'

const { Pool } = pg

export const SUPPORT_TICKET_CATEGORIES = ['billing', 'account', 'integration', 'bug', 'other'] as const
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number]

export const SUPPORT_TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number]

export const SUPPORT_MESSAGE_AUTHOR_KINDS = ['user', 'agent', 'system'] as const
export type SupportMessageAuthorKind = (typeof SUPPORT_MESSAGE_AUTHOR_KINDS)[number]

export interface SupportTicket {
  id: string
  userId: string
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

export interface CreateTicketInput {
  userId: string
  userName: string | null
  userEmail: string | null
  category: SupportTicketCategory
  title: string
  description: string
  relatedApiKeyId?: string | null
}

export interface AppendMessageInput {
  ticketId: string
  authorKind: SupportMessageAuthorKind
  authorId: string | null
  authorName: string | null
  body: string
}

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT,
  user_email TEXT,
  category TEXT NOT NULL CHECK (category IN ('billing','account','integration','bug','other')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','resolved','closed')) DEFAULT 'open',
  related_api_key_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_created
  ON support_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
  ON support_tickets (status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_id TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_created
  ON support_ticket_messages (ticket_id, created_at ASC);
`

type TicketRow = {
  id: string
  user_id: string
  user_name: string | null
  user_email: string | null
  category: string
  title: string
  status: string
  related_api_key_id: string | null
  created_at: Date
  updated_at: Date
  closed_at: Date | null
  message_count: string | number | bigint
}

type MessageRow = {
  id: string
  ticket_id: string
  author_kind: string
  author_id: string | null
  author_name: string | null
  body: string
  created_at: Date
}

function newTicketId(): string {
  return `ticket-${crypto.randomUUID()}`
}

function newMessageId(): string {
  return `msg-${crypto.randomUUID()}`
}

function trim(value: string | null | undefined, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function rowToTicket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    category: row.category as SupportTicketCategory,
    title: row.title,
    status: row.status as SupportTicketStatus,
    relatedApiKeyId: row.related_api_key_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    messageCount: Number(row.message_count ?? 0),
  }
}

function rowToMessage(row: MessageRow): SupportTicketMessage {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorKind: row.author_kind as SupportMessageAuthorKind,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  }
}

const TICKET_SELECT = `
  SELECT t.*, COALESCE(c.message_count, 0) AS message_count
  FROM support_tickets t
  LEFT JOIN (
    SELECT ticket_id, COUNT(*)::bigint AS message_count
    FROM support_ticket_messages
    GROUP BY ticket_id
  ) c ON c.ticket_id = t.id
`

export class SupportStore {
  private readonly pool: pg.Pool

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl })
  }

  async ensureTable(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(CREATE_TABLES_SQL)
    } finally {
      client.release()
    }
  }

  async createTicket(input: CreateTicketInput): Promise<{ ticket: SupportTicket; firstMessage: SupportTicketMessage }> {
    const id = newTicketId()
    const messageId = newMessageId()
    const title = trim(input.title, 200)
    const description = trim(input.description, 8000)
    if (!title) throw new Error('title is required')
    if (!description) throw new Error('description is required')
    if (!SUPPORT_TICKET_CATEGORIES.includes(input.category)) {
      throw new Error(`invalid category: ${input.category}`)
    }
    const userName = input.userName ? trim(input.userName, 200) || null : null
    const userEmail = input.userEmail ? trim(input.userEmail, 320) || null : null
    const relatedApiKeyId = input.relatedApiKeyId ? trim(input.relatedApiKeyId, 100) || null : null

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO support_tickets (id, user_id, user_name, user_email, category, title, status, related_api_key_id)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7)`,
        [id, input.userId, userName, userEmail, input.category, title, relatedApiKeyId],
      )
      await client.query(
        `INSERT INTO support_ticket_messages (id, ticket_id, author_kind, author_id, author_name, body)
         VALUES ($1,$2,'user',$3,$4,$5)`,
        [messageId, id, input.userId, userName, description],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const ticket = await this.getTicket(id)
    if (!ticket) throw new Error('failed to load created ticket')
    const firstMessage = await this.getMessageById(messageId)
    if (!firstMessage) throw new Error('failed to load created message')
    return { ticket, firstMessage }
  }

  async listTicketsForUser(userId: string, limit = 100): Promise<SupportTicket[]> {
    const result = await this.pool.query<TicketRow>(
      `${TICKET_SELECT} WHERE t.user_id = $1 ORDER BY t.updated_at DESC LIMIT $2`,
      [userId, Math.max(1, Math.min(500, limit))],
    )
    return result.rows.map(rowToTicket)
  }

  async listAllTickets(options: {
    status?: SupportTicketStatus
    limit?: number
    search?: string
  } = {}): Promise<SupportTicket[]> {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100))
    const conditions: string[] = []
    const params: unknown[] = []
    if (options.status) {
      params.push(options.status)
      conditions.push(`t.status = $${params.length}`)
    }
    if (options.search) {
      const needle = `%${options.search.toLowerCase()}%`
      params.push(needle, needle, needle)
      conditions.push(`(LOWER(t.title) LIKE $${params.length - 2} OR LOWER(COALESCE(t.user_email, '')) LIKE $${params.length - 1} OR LOWER(COALESCE(t.user_name, '')) LIKE $${params.length})`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit)
    const result = await this.pool.query<TicketRow>(
      `${TICKET_SELECT} ${where} ORDER BY t.updated_at DESC LIMIT $${params.length}`,
      params,
    )
    return result.rows.map(rowToTicket)
  }

  async getTicket(ticketId: string): Promise<SupportTicket | null> {
    const result = await this.pool.query<TicketRow>(
      `${TICKET_SELECT} WHERE t.id = $1`,
      [ticketId],
    )
    const row = result.rows[0]
    return row ? rowToTicket(row) : null
  }

  async listMessagesForTicket(ticketId: string): Promise<SupportTicketMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [ticketId],
    )
    return result.rows.map(rowToMessage)
  }

  private async getMessageById(id: string): Promise<SupportTicketMessage | null> {
    const result = await this.pool.query<MessageRow>(
      `SELECT * FROM support_ticket_messages WHERE id = $1`,
      [id],
    )
    return result.rows[0] ? rowToMessage(result.rows[0]) : null
  }

  async appendMessage(input: AppendMessageInput): Promise<SupportTicketMessage> {
    const body = trim(input.body, 8000)
    if (!body) throw new Error('body is required')
    if (!SUPPORT_MESSAGE_AUTHOR_KINDS.includes(input.authorKind)) {
      throw new Error(`invalid author_kind: ${input.authorKind}`)
    }
    const messageId = newMessageId()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const ticketResult = await client.query<{ status: string }>(
        `SELECT status FROM support_tickets WHERE id = $1 FOR UPDATE`,
        [input.ticketId],
      )
      const ticket = ticketResult.rows[0]
      if (!ticket) throw new Error('ticket_not_found')
      if (ticket.status === 'closed') throw new Error('ticket_closed')

      await client.query(
        `INSERT INTO support_ticket_messages (id, ticket_id, author_kind, author_id, author_name, body)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [messageId, input.ticketId, input.authorKind, input.authorId, input.authorName, body],
      )

      let nextStatus: SupportTicketStatus | null = null
      if (input.authorKind === 'agent' && (ticket.status === 'open' || ticket.status === 'resolved')) {
        nextStatus = 'in_progress'
      } else if (input.authorKind === 'user' && ticket.status === 'resolved') {
        nextStatus = 'in_progress'
      }
      if (nextStatus) {
        await client.query(
          `UPDATE support_tickets SET status = $1, updated_at = NOW(), closed_at = NULL WHERE id = $2`,
          [nextStatus, input.ticketId],
        )
      } else {
        await client.query(
          `UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`,
          [input.ticketId],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    const created = await this.getMessageById(messageId)
    if (!created) throw new Error('failed to load created message')
    return created
  }

  async setTicketStatus(ticketId: string, status: SupportTicketStatus): Promise<SupportTicket | null> {
    if (!SUPPORT_TICKET_STATUSES.includes(status)) {
      throw new Error(`invalid status: ${status}`)
    }
    const closedAtClause = status === 'closed' ? 'NOW()' : 'NULL'
    await this.pool.query(
      `UPDATE support_tickets SET status = $1, updated_at = NOW(), closed_at = ${closedAtClause} WHERE id = $2`,
      [status, ticketId],
    )
    return this.getTicket(ticketId)
  }
}
