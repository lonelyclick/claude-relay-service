import pg from 'pg'

export interface ResolvedRecipient {
  email: string
  name: string
  emailVerified: boolean
}

/**
 * Reads `(email, name, emailVerified)` from the BetterAuth `user` table by
 * external user id. Lives in its own pool because BetterAuth typically points
 * at a separate database from the relay store.
 *
 * If the BetterAuth database URL is not configured, all lookups return null —
 * lets ops disable mail features without crashing the runtime.
 */
export class RecipientResolver {
  private readonly pool: pg.Pool | null

  constructor(databaseUrl: string | null) {
    this.pool = databaseUrl
      ? new pg.Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 60_000 })
      : null
  }

  isAvailable(): boolean {
    return this.pool !== null
  }

  async resolveByUserId(userId: string): Promise<ResolvedRecipient | null> {
    if (!this.pool) return null
    const result = await this.pool.query<{
      email: string | null
      name: string | null
      emailVerified: boolean | null
    }>(
      `SELECT email, name, "emailVerified" FROM "user" WHERE id = $1 LIMIT 1`,
      [userId],
    )
    const row = result.rows[0]
    if (!row || !row.email) return null
    return {
      email: row.email,
      name: row.name?.trim() || row.email,
      emailVerified: row.emailVerified === true,
    }
  }

  /**
   * Resolve all owners/admins of a BetterAuth organization. Used when an
   * alert targets an organization rather than a specific user.
   */
  async resolveOrganizationAdmins(organizationId: string): Promise<ResolvedRecipient[]> {
    if (!this.pool) return []
    const result = await this.pool.query<{
      email: string | null
      name: string | null
      emailVerified: boolean | null
      role: string | null
    }>(
      `SELECT u.email, u.name, u."emailVerified", m.role
       FROM member m
       JOIN "user" u ON u.id = m."userId"
       WHERE m."organizationId" = $1
         AND m.role IN ('owner', 'admin')
         AND u.email IS NOT NULL`,
      [organizationId],
    )
    return result.rows
      .filter((row) => row.email)
      .map((row) => ({
        email: row.email as string,
        name: row.name?.trim() || (row.email as string),
        emailVerified: row.emailVerified === true,
      }))
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end()
  }
}
