import pg from 'pg'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mailer_send_log (
  id           BIGSERIAL PRIMARY KEY,
  recipient    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  reference_id TEXT,
  campaign     TEXT,
  message_id   TEXT,
  metadata     JSONB,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mailer_send_log_kind_ref_sent
  ON mailer_send_log (kind, reference_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailer_send_log_recipient_kind_sent
  ON mailer_send_log (recipient, kind, sent_at DESC);
`

export interface MailerSendLogEntry {
  recipient: string
  kind: string
  referenceId: string | null
  campaign: string | null
  messageId: string | null
  metadata: Record<string, unknown> | null
}

export class MailerSendLogStore {
  private readonly pool: pg.Pool
  private ensured = false

  constructor(pool: pg.Pool | string) {
    this.pool = typeof pool === 'string' ? new pg.Pool({ connectionString: pool }) : pool
  }

  async ensureTable(): Promise<void> {
    if (this.ensured) return
    await this.pool.query(CREATE_TABLE_SQL)
    this.ensured = true
  }

  /**
   * Whether a previous send for the same `(kind, referenceId)` pair lands
   * within the cooldown window. Falls back to the recipient address when
   * referenceId is missing — keeps user-anonymous channels (e.g. test sends)
   * de-duplicated too.
   */
  async isWithinCooldown(args: {
    kind: string
    referenceId: string | null
    recipient: string
    cooldownHours: number
  }): Promise<boolean> {
    await this.ensureTable()
    if (args.cooldownHours <= 0) return false
    const where = args.referenceId
      ? { sql: 'kind = $1 AND reference_id = $2', params: [args.kind, args.referenceId] }
      : { sql: 'kind = $1 AND recipient = $2', params: [args.kind, args.recipient] }
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM mailer_send_log
         WHERE ${where.sql}
           AND sent_at > NOW() - ($${where.params.length + 1}::numeric * INTERVAL '1 hour')
       ) AS exists`,
      [...where.params, args.cooldownHours],
    )
    return result.rows[0]?.exists === true
  }

  async record(entry: MailerSendLogEntry): Promise<number> {
    await this.ensureTable()
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO mailer_send_log (recipient, kind, reference_id, campaign, message_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        entry.recipient,
        entry.kind,
        entry.referenceId,
        entry.campaign,
        entry.messageId,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    )
    return Number(result.rows[0]?.id ?? 0)
  }
}
