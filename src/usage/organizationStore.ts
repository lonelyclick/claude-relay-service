import crypto from 'node:crypto'

import pg from 'pg'

import { appConfig } from '../config.js'
import {
  MAX_USER_NAME_LENGTH,
  normalizeBillingCurrency,
  normalizeOptionalText,
  normalizeRequiredText,
} from '../security/inputValidation.js'
import type { BillingCurrency, RelayUserBillingMode } from '../types.js'

const DEFAULT_BILLING_CURRENCY = normalizeBillingCurrency(appConfig.billingCurrency, {
  field: 'BILLING_CURRENCY',
})

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS relay_organizations (
  id          TEXT PRIMARY KEY,
  external_organization_id TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'team',
  billing_mode TEXT NOT NULL DEFAULT 'prepaid',
  billing_currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}',
  credit_limit_micros BIGINT NOT NULL DEFAULT 0,
  balance_micros BIGINT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_relay_organizations_external_id ON relay_organizations (external_organization_id);
`

const CREATE_QUOTA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS relay_organization_quota (
  organization_id TEXT PRIMARY KEY REFERENCES relay_organizations(id) ON DELETE CASCADE,
  daily_limit_micros BIGINT,
  monthly_limit_micros BIGINT,
  alert_threshold_pct INTEGER NOT NULL DEFAULT 80 CHECK (alert_threshold_pct BETWEEN 1 AND 100),
  last_alert_sent_at TIMESTAMPTZ,
  alert_scope TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

export interface RelayOrganizationQuota {
  organizationId: string
  dailyLimitMicros: string | null
  monthlyLimitMicros: string | null
  alertThresholdPct: number
  lastAlertSentAt: string | null
  alertScope: 'daily' | 'monthly' | null
  updatedBy: string | null
  updatedAt: string | null
}

export interface RelayOrganizationCurrentSpend {
  todayMicros: string
  thisMonthMicros: string
}

function normalizeQuotaLimit(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('quota limit must be non-negative')
    return value.toString()
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('quota limit must be a finite number')
    if (value < 0) throw new Error('quota limit must be non-negative')
    return String(Math.floor(value))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    if (!/^\d+$/.test(trimmed)) throw new Error('quota limit must be an integer string')
    return trimmed
  }
  throw new Error('quota limit type invalid')
}

function normalizeAlertThreshold(value: unknown): number {
  if (value === null || value === undefined) return 80
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value)
  if (!Number.isFinite(n)) return 80
  if (n < 1) return 1
  if (n > 100) return 100
  return Math.floor(n)
}

function rowToQuota(row: Record<string, unknown> | null | undefined, organizationId: string): RelayOrganizationQuota {
  if (!row) {
    return {
      organizationId,
      dailyLimitMicros: null,
      monthlyLimitMicros: null,
      alertThresholdPct: 80,
      lastAlertSentAt: null,
      alertScope: null,
      updatedBy: null,
      updatedAt: null,
    }
  }
  const scope = row.alert_scope === 'daily' || row.alert_scope === 'monthly' ? row.alert_scope : null
  return {
    organizationId: row.organization_id as string,
    dailyLimitMicros: row.daily_limit_micros == null ? null : String(row.daily_limit_micros),
    monthlyLimitMicros: row.monthly_limit_micros == null ? null : String(row.monthly_limit_micros),
    alertThresholdPct: Number(row.alert_threshold_pct ?? 80),
    lastAlertSentAt: row.last_alert_sent_at ? (row.last_alert_sent_at as Date).toISOString() : null,
    alertScope: scope,
    updatedBy: row.updated_by ? (row.updated_by as string) : null,
    updatedAt: row.updated_at ? (row.updated_at as Date).toISOString() : null,
  }
}

export type RelayOrganizationKind = 'personal' | 'team'

export interface RelayOrganization {
  id: string
  externalOrganizationId: string
  slug: string
  name: string
  kind: RelayOrganizationKind
  billingMode: RelayUserBillingMode
  billingCurrency: BillingCurrency
  creditLimitMicros: string
  balanceMicros: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

function normalizeKind(value: unknown): RelayOrganizationKind {
  return value === 'personal' ? 'personal' : 'team'
}

function normalizeBillingMode(value: unknown): RelayUserBillingMode {
  return value === 'postpaid' ? 'postpaid' : 'prepaid'
}

function normalizeCreditLimitMicros(value: unknown): string {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : '0'
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.max(0, Math.floor(value)))
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim()
  return '0'
}

function rowToOrganization(row: Record<string, unknown>): RelayOrganization {
  return {
    id: row.id as string,
    externalOrganizationId: row.external_organization_id as string,
    slug: row.slug as string,
    name: row.name as string,
    kind: normalizeKind(row.kind),
    billingMode: normalizeBillingMode(row.billing_mode),
    billingCurrency: normalizeBillingCurrency(row.billing_currency, {
      field: 'billingCurrency',
      fallback: DEFAULT_BILLING_CURRENCY,
    }),
    creditLimitMicros: String(row.credit_limit_micros ?? '0'),
    balanceMicros: String(row.balance_micros ?? '0'),
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }
}

export class OrganizationStore {
  private readonly pool: pg.Pool

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl })
  }

  async ensureTable(): Promise<void> {
    await this.pool.query(CREATE_TABLE_SQL)
    await this.pool.query('ALTER TABLE relay_organizations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT \'team\'')
    await this.pool.query('ALTER TABLE relay_organizations ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT \'prepaid\'')
    await this.pool.query(`ALTER TABLE relay_organizations ADD COLUMN IF NOT EXISTS billing_currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}'`)
    await this.pool.query('ALTER TABLE relay_organizations ADD COLUMN IF NOT EXISTS credit_limit_micros BIGINT NOT NULL DEFAULT 0')
    await this.pool.query('ALTER TABLE relay_organizations ADD COLUMN IF NOT EXISTS balance_micros BIGINT NOT NULL DEFAULT 0')
    await this.pool.query('ALTER TABLE relay_organizations ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true')
    await this.pool.query(`UPDATE relay_organizations SET kind = 'team' WHERE kind NOT IN ('personal', 'team') OR kind IS NULL`)
    await this.pool.query(`UPDATE relay_organizations SET billing_mode = 'prepaid' WHERE billing_mode NOT IN ('postpaid', 'prepaid') OR billing_mode IS NULL`)
    await this.pool.query(CREATE_QUOTA_TABLE_SQL)
  }

  async getOrganizationQuota(organizationId: string): Promise<RelayOrganizationQuota> {
    const result = await this.pool.query(
      'SELECT * FROM relay_organization_quota WHERE organization_id = $1',
      [organizationId],
    )
    return rowToQuota(result.rows[0] ?? null, organizationId)
  }

  async setOrganizationQuota(
    organizationId: string,
    input: {
      dailyLimitMicros?: string | number | null
      monthlyLimitMicros?: string | number | null
      alertThresholdPct?: number | null
      updatedBy?: string | null
    },
  ): Promise<RelayOrganizationQuota> {
    const dailyValue = normalizeQuotaLimit(input.dailyLimitMicros)
    const monthlyValue = normalizeQuotaLimit(input.monthlyLimitMicros)
    const alertPct = normalizeAlertThreshold(input.alertThresholdPct)
    const updatedBy = typeof input.updatedBy === 'string' && input.updatedBy.trim()
      ? input.updatedBy.trim().slice(0, 200)
      : null

    const result = await this.pool.query(
      `INSERT INTO relay_organization_quota (
         organization_id, daily_limit_micros, monthly_limit_micros,
         alert_threshold_pct, updated_by
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id) DO UPDATE SET
         daily_limit_micros = EXCLUDED.daily_limit_micros,
         monthly_limit_micros = EXCLUDED.monthly_limit_micros,
         alert_threshold_pct = EXCLUDED.alert_threshold_pct,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [organizationId, dailyValue, monthlyValue, alertPct, updatedBy],
    )
    return rowToQuota(result.rows[0], organizationId)
  }

  async markQuotaAlertSent(
    organizationId: string,
    scope: 'daily' | 'monthly',
    sentAt: Date = new Date(),
  ): Promise<void> {
    await this.pool.query(
      `UPDATE relay_organization_quota
          SET last_alert_sent_at = $2,
              alert_scope = $3,
              updated_at = NOW()
        WHERE organization_id = $1`,
      [organizationId, sentAt, scope],
    )
  }

  async getOrganizationCurrentSpend(
    organizationId: string,
  ): Promise<RelayOrganizationCurrentSpend> {
    const result = await this.pool.query<{
      today_micros: string | number | bigint | null
      month_micros: string | number | bigint | null
    }>(
      `SELECT
         COALESCE(SUM(amount_micros) FILTER (
           WHERE usage_created_at >= date_trunc('day', NOW())
         ), 0)::bigint AS today_micros,
         COALESCE(SUM(amount_micros) FILTER (
           WHERE usage_created_at >= date_trunc('month', NOW())
         ), 0)::bigint AS month_micros
       FROM billing_line_items
       WHERE organization_id = $1
         AND usage_created_at >= date_trunc('month', NOW())`,
      [organizationId],
    )
    const row = result.rows[0]
    return {
      todayMicros: String(row?.today_micros ?? '0'),
      thisMonthMicros: String(row?.month_micros ?? '0'),
    }
  }

  async syncOrganization(input: {
    externalOrganizationId: unknown
    slug: unknown
    name: unknown
    kind?: unknown
    billingMode?: unknown
    billingCurrency?: unknown
    creditLimitMicros?: unknown
    isActive?: unknown
  }): Promise<RelayOrganization> {
    const externalOrganizationId = normalizeRequiredText(input.externalOrganizationId, {
      field: 'externalOrganizationId',
      maxLength: 160,
    })
    const slug = normalizeRequiredText(input.slug, { field: 'slug', maxLength: 160 })
    const name = normalizeRequiredText(input.name, { field: 'name', maxLength: MAX_USER_NAME_LENGTH })
    const kind = normalizeKind(input.kind)
    const billingMode = normalizeBillingMode(input.billingMode)
    const billingCurrency = normalizeBillingCurrency(input.billingCurrency, {
      field: 'billingCurrency',
      fallback: DEFAULT_BILLING_CURRENCY,
    })
    const creditLimitMicros = normalizeCreditLimitMicros(input.creditLimitMicros)
    const isActive = typeof input.isActive === 'boolean' ? input.isActive : true

    const result = await this.pool.query(
      `INSERT INTO relay_organizations (
         id, external_organization_id, slug, name, kind, billing_mode,
         billing_currency, credit_limit_micros, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (external_organization_id) DO UPDATE SET
         slug = EXCLUDED.slug,
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         billing_mode = EXCLUDED.billing_mode,
         billing_currency = EXCLUDED.billing_currency,
         credit_limit_micros = EXCLUDED.credit_limit_micros,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()
       RETURNING *`,
      [
        crypto.randomUUID(),
        externalOrganizationId,
        slug,
        name,
        kind,
        billingMode,
        billingCurrency,
        creditLimitMicros,
        isActive,
      ],
    )
    return rowToOrganization(result.rows[0])
  }

  async getOrganizationById(id: string): Promise<RelayOrganization | null> {
    const result = await this.pool.query('SELECT * FROM relay_organizations WHERE id = $1', [id])
    return result.rows[0] ? rowToOrganization(result.rows[0]) : null
  }

  async getOrganizationByExternalId(externalOrganizationId: string): Promise<RelayOrganization | null> {
    const result = await this.pool.query('SELECT * FROM relay_organizations WHERE external_organization_id = $1', [externalOrganizationId])
    return result.rows[0] ? rowToOrganization(result.rows[0]) : null
  }

  async getOrganizationByIdOrExternalIdOrSlug(identifier: string): Promise<RelayOrganization | null> {
    const result = await this.pool.query(
      'SELECT * FROM relay_organizations WHERE id = $1 OR external_organization_id = $1 OR slug = $1 LIMIT 1',
      [identifier],
    )
    return result.rows[0] ? rowToOrganization(result.rows[0]) : null
  }

  async updateOrganization(
    id: string,
    input: { billingMode?: RelayUserBillingMode; billingCurrency?: BillingCurrency },
  ): Promise<RelayOrganization | null> {
    const sets: string[] = []
    const values: unknown[] = []
    if (input.billingMode) {
      values.push(normalizeBillingMode(input.billingMode))
      sets.push(`billing_mode = $${values.length}`)
    }
    if (input.billingCurrency) {
      values.push(normalizeBillingCurrency(input.billingCurrency, { field: 'billingCurrency' }))
      sets.push(`billing_currency = $${values.length}`)
    }
    if (!sets.length) {
      return this.getOrganizationById(id)
    }
    values.push(id)
    const result = await this.pool.query(
      `UPDATE relay_organizations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values,
    )
    return result.rows[0] ? rowToOrganization(result.rows[0]) : null
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
