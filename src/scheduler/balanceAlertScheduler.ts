import pg from 'pg'

import { appConfig } from '../config.js'
import type { MailerService } from '../mailer/mailerService.js'
import type { RecipientResolver, ResolvedRecipient } from '../mailer/recipientResolver.js'
import type { AlertKind } from '../mailer/types.js'

interface UserRow {
  id: string
  external_user_id: string | null
  org_id: string | null
  name: string | null
  billing_mode: 'prepaid' | 'postpaid'
  billing_currency: 'USD' | 'CNY'
  balance_micros: string
  credit_limit_micros: string
}

interface OrgRow {
  id: string
  external_organization_id: string
  name: string
  billing_mode: 'prepaid' | 'postpaid'
  billing_currency: 'USD' | 'CNY'
  balance_micros: string
  credit_limit_micros: string
}

export interface BalanceAlertSchedulerDeps {
  /** Postgres pool over the relay database (relay_users / relay_organizations / billing_line_items). */
  pool: pg.Pool
  mailer: MailerService
  resolver: RecipientResolver
}

/** Convenience factory: build a scheduler from a database URL string. */
export function createBalanceAlertScheduler(args: {
  databaseUrl: string
  mailer: MailerService
  resolver: RecipientResolver
}): { scheduler: BalanceAlertScheduler; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: args.databaseUrl, max: 1, idleTimeoutMillis: 60_000 })
  const scheduler = new BalanceAlertScheduler({ pool, mailer: args.mailer, resolver: args.resolver })
  return { scheduler, pool }
}

export interface BalanceAlertRunResult {
  scannedUsers: number
  scannedOrgs: number
  sent: number
  skippedCooldown: number
  skippedNoRecipient: number
  errors: number
}

/**
 * Periodic scanner that emits `balance_low` / `balance_exhausted` alerts when
 * a relay user or organization's available spend drops below the configured
 * thresholds. Idempotency is enforced by `MailerService` via `mailer_send_log`
 * so manual runs and the timer cannot double-send.
 */
export class BalanceAlertScheduler {
  private readonly deps: BalanceAlertSchedulerDeps
  private timer: NodeJS.Timeout | null = null
  private inFlight = false

  constructor(deps: BalanceAlertSchedulerDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.timer) return
    if (!appConfig.balanceAlertEnabled) return
    if (!this.deps.mailer.isEnabled()) return
    const interval = appConfig.balanceAlertIntervalMs
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        process.stderr.write(`[balanceAlert] tick failed: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    }, interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async runOnce(): Promise<BalanceAlertRunResult> {
    if (this.inFlight) {
      return { scannedUsers: 0, scannedOrgs: 0, sent: 0, skippedCooldown: 0, skippedNoRecipient: 0, errors: 0 }
    }
    this.inFlight = true
    try {
      const users = await this.scanUsers()
      const orgs = await this.scanOrganizations()
      const result: BalanceAlertRunResult = {
        scannedUsers: users.length,
        scannedOrgs: orgs.length,
        sent: 0,
        skippedCooldown: 0,
        skippedNoRecipient: 0,
        errors: 0,
      }
      for (const user of users) {
        await this.dispatchUser(user, result)
      }
      for (const org of orgs) {
        await this.dispatchOrganization(org, result)
      }
      return result
    } finally {
      this.inFlight = false
    }
  }

  private async scanUsers(): Promise<UserRow[]> {
    const result = await this.deps.pool.query<UserRow>(
      `SELECT id, external_user_id, org_id, name, billing_mode, billing_currency,
              balance_micros, credit_limit_micros
       FROM relay_users
       WHERE is_active = true AND org_id IS NULL`,
    )
    return result.rows
  }

  private async scanOrganizations(): Promise<OrgRow[]> {
    const result = await this.deps.pool.query<OrgRow>(
      `SELECT id, external_organization_id, name, billing_mode, billing_currency,
              balance_micros, credit_limit_micros
       FROM relay_organizations
       WHERE is_active = true`,
    )
    return result.rows
  }

  private resolveAlertKind(
    available: bigint,
    threshold: bigint,
  ): AlertKind | null {
    if (available <= 0n) return 'balance_exhausted'
    if (available < threshold) return 'balance_low'
    return null
  }

  private async dispatchUser(row: UserRow, result: BalanceAlertRunResult): Promise<void> {
    const balance = BigInt(row.balance_micros)
    const credit = BigInt(row.credit_limit_micros)
    const available = row.billing_mode === 'postpaid' ? balance + credit : balance
    const threshold = thresholdFor(row.billing_currency)
    const kind = this.resolveAlertKind(available, threshold)
    if (!kind) return
    if (!row.external_user_id) {
      result.skippedNoRecipient++
      return
    }
    let recipient: ResolvedRecipient | null = null
    try {
      recipient = await this.deps.resolver.resolveByUserId(row.external_user_id)
    } catch (err) {
      process.stderr.write(`[balanceAlert] resolveByUserId(${row.external_user_id}) failed: ${err instanceof Error ? err.message : String(err)}\n`)
      result.errors++
      return
    }
    if (!recipient || !recipient.email) {
      result.skippedNoRecipient++
      return
    }
    const avgDaily = await this.fetchAvgDailyDebit({ userId: row.id })
    try {
      const dispatch = await this.deps.mailer.dispatchBalanceAlert({
        kind,
        referenceId: `user:${row.id}`,
        recipient: { email: recipient.email, name: recipient.name },
        organizationName: null,
        currency: row.billing_currency,
        availableMicros: available,
        thresholdMicros: kind === 'balance_low' ? threshold : null,
        avgDailyDebitMicros: avgDaily,
      })
      tallyDispatch(dispatch.status, result)
    } catch (err) {
      process.stderr.write(`[balanceAlert] user ${row.id} dispatch failed: ${err instanceof Error ? err.message : String(err)}\n`)
      result.errors++
    }
  }

  private async dispatchOrganization(row: OrgRow, result: BalanceAlertRunResult): Promise<void> {
    const balance = BigInt(row.balance_micros)
    const credit = BigInt(row.credit_limit_micros)
    const available = row.billing_mode === 'postpaid' ? balance + credit : balance
    const threshold = thresholdFor(row.billing_currency)
    const kind = this.resolveAlertKind(available, threshold)
    if (!kind) return
    let admins: ResolvedRecipient[] = []
    try {
      admins = await this.deps.resolver.resolveOrganizationAdmins(row.external_organization_id)
    } catch (err) {
      process.stderr.write(`[balanceAlert] resolveOrganizationAdmins(${row.external_organization_id}) failed: ${err instanceof Error ? err.message : String(err)}\n`)
      result.errors++
      return
    }
    if (admins.length === 0) {
      result.skippedNoRecipient++
      return
    }
    const avgDaily = await this.fetchAvgDailyDebit({ organizationId: row.id })
    for (const admin of admins) {
      try {
        const dispatch = await this.deps.mailer.dispatchBalanceAlert({
          kind,
          referenceId: `org:${row.id}:user:${admin.email}`,
          recipient: { email: admin.email, name: admin.name },
          organizationName: row.name,
          currency: row.billing_currency,
          availableMicros: available,
          thresholdMicros: kind === 'balance_low' ? threshold : null,
          avgDailyDebitMicros: avgDaily,
        })
        tallyDispatch(dispatch.status, result)
      } catch (err) {
        process.stderr.write(`[balanceAlert] org ${row.id} → ${admin.email} dispatch failed: ${err instanceof Error ? err.message : String(err)}\n`)
        result.errors++
      }
    }
  }

  private async fetchAvgDailyDebit(scope: { userId?: string; organizationId?: string }): Promise<bigint | null> {
    try {
      const where = scope.organizationId
        ? { sql: 'organization_id = $1', params: [scope.organizationId] }
        : { sql: 'user_id = $1', params: [scope.userId] }
      const result = await this.deps.pool.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(amount_micros), 0)::text AS total
         FROM billing_line_items
         WHERE ${where.sql}
           AND status = 'billed'
           AND created_at > NOW() - INTERVAL '7 days'`,
        where.params as unknown[],
      )
      const total = BigInt(result.rows[0]?.total ?? '0')
      if (total <= 0n) return null
      return total / 7n
    } catch {
      return null
    }
  }
}

function thresholdFor(currency: 'USD' | 'CNY'): bigint {
  if (currency === 'CNY') return BigInt(appConfig.balanceAlertLowThresholdCnyMicros)
  return BigInt(appConfig.balanceAlertLowThresholdUsdMicros)
}

function tallyDispatch(
  status: 'sent' | 'skipped_cooldown' | 'skipped_disabled' | 'skipped_no_recipient',
  result: BalanceAlertRunResult,
): void {
  if (status === 'sent') result.sent++
  else if (status === 'skipped_cooldown') result.skippedCooldown++
  else if (status === 'skipped_no_recipient') result.skippedNoRecipient++
}
