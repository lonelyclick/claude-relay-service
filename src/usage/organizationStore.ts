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
