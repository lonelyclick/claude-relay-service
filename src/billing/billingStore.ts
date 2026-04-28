import crypto from 'node:crypto'

import pg from 'pg'

import { appConfig } from '../config.js'
import {
  InputValidationError,
  MAX_BILLING_NOTE_LENGTH,
  MAX_BILLING_RULE_NAME_LENGTH,
  MAX_SCOPE_FIELD_LENGTH,
  normalizeBillingCurrency,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeSignedBigIntString,
  normalizeUnsignedBigIntString,
  sanitizeErrorMessage,
} from '../security/inputValidation.js'
import type { BillingCurrency } from '../types.js'
import {
  BILLABLE_USAGE_TARGETS,
  type BillingRule,
  type BillingUsageCandidate,
  isBillableUsageTarget,
  resolveBillingLineItem,
} from './engine.js'

const DEFAULT_BILLING_CURRENCY = normalizeBillingCurrency(appConfig.billingCurrency, {
  field: 'BILLING_CURRENCY',
})
export const SYSTEM_FALLBACK_RULE_ID_PREFIX = 'system-default-all-models'

export interface BillingRuleInput {
  name: string
  currency?: BillingCurrency
  isActive?: boolean
  priority?: number
  provider?: string | null
  accountId?: string | null
  userId?: string | null
  model?: string | null
  effectiveFrom?: string | null
  effectiveTo?: string | null
  inputPriceMicrosPerMillion?: string | number | bigint
  outputPriceMicrosPerMillion?: string | number | bigint
  cacheCreationPriceMicrosPerMillion?: string | number | bigint
  cacheReadPriceMicrosPerMillion?: string | number | bigint
}

export interface BillingSummary {
  currency: BillingCurrency
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalAmountMicros: string
  uniqueUsers: number
  activeRules: number
  period: { from: string; to: string }
}

export interface BillingUserRow {
  userId: string
  userName: string | null
  currency: BillingCurrency
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalAmountMicros: string
  lastActiveAt: string | null
}

export interface BillingUserPeriodRow {
  periodStart: string
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalAmountMicros: string
}

export interface BillingUserModelRow {
  model: string
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalAmountMicros: string
}

export interface BillingUserDetail {
  userId: string
  userName: string | null
  currency: BillingCurrency
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalAmountMicros: string
  lastActiveAt: string | null
  byPeriod: BillingUserPeriodRow[]
  byModel: BillingUserModelRow[]
}

export interface BillingLineItemRow {
  usageRecordId: number
  requestId: string
  currency: BillingCurrency
  status: 'billed' | 'missing_rule' | 'invalid_usage'
  matchedRuleId: string | null
  matchedRuleName: string | null
  accountId: string | null
  provider: string | null
  model: string | null
  target: string
  sessionKey: string | null
  clientDeviceId: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  amountMicros: string
  usageCreatedAt: string
}

export interface BillingUserDayRow {
  date: string
  totalRequests: number
  billedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalAmountMicros: string
}

export interface BillingUserUsageSnapshot {
  userId: string
  currency: BillingCurrency | null
  totalRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalAmountMicros: string
  lastActiveAt: string | null
  byDay: BillingUserDayRow[]
  byModel: BillingUserModelRow[]
  items: BillingLineItemRow[]
  itemsTotal: number
  itemsLimit: number
  itemsOffset: number
}

export type BillingLedgerKind = 'topup' | 'manual_adjustment' | 'usage_debit'

export interface BillingBalanceSummary {
  userId: string
  userName: string | null
  billingMode: 'postpaid' | 'prepaid'
  billingCurrency: BillingCurrency
  balanceMicros: string
  totalCreditedMicros: string
  totalDebitedMicros: string
  currency: BillingCurrency
  lastLedgerAt: string | null
}

export interface BillingLedgerEntry {
  id: string
  userId: string
  userName: string | null
  kind: BillingLedgerKind
  amountMicros: string
  currency: BillingCurrency
  note: string | null
  usageRecordId: number | null
  requestId: string | null
  createdAt: string
  updatedAt: string
}

export interface BillingSyncResult {
  processedRequests: number
  billedRequests: number
  missingRuleRequests: number
  invalidUsageRequests: number
}

export interface BillingPreflightInput {
  userId: string
  billingCurrency: BillingCurrency
  accountId: string | null
  provider: string | null
  model: string | null
  target: string
}

export interface BillingPreflightResult {
  ok: boolean
  status: 'billed' | 'missing_rule' | 'zero_price'
  matchedRuleId: string | null
  matchedRuleName: string | null
}

const CREATE_RULES_SQL = `
CREATE TABLE IF NOT EXISTS billing_price_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}',
  provider TEXT,
  account_id TEXT,
  user_id TEXT,
  model TEXT,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  input_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  output_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  cache_creation_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  cache_read_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_price_rules_active ON billing_price_rules (is_active, priority DESC, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_billing_price_rules_scope ON billing_price_rules (provider, account_id, user_id, model);
`

const CREATE_LINE_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS billing_line_items (
  id BIGSERIAL PRIMARY KEY,
  usage_record_id BIGINT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  account_id TEXT,
  provider TEXT,
  model TEXT,
  session_key TEXT,
  client_device_id TEXT,
  target TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}',
  status TEXT NOT NULL CHECK (status IN ('billed', 'missing_rule', 'invalid_usage')),
  matched_rule_id TEXT,
  matched_rule_name TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  input_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  output_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  cache_creation_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  cache_read_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  amount_micros BIGINT NOT NULL DEFAULT 0,
  usage_created_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_line_items_user_created_at ON billing_line_items (user_id, usage_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_line_items_status_created_at ON billing_line_items (status, usage_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_line_items_provider_created_at ON billing_line_items (provider, usage_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_line_items_request_id ON billing_line_items (request_id);
`

const CREATE_META_SQL = `
CREATE TABLE IF NOT EXISTS billing_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

const CREATE_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS billing_balance_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup', 'manual_adjustment', 'usage_debit')),
  amount_micros BIGINT NOT NULL,
  currency TEXT NOT NULL,
  note TEXT,
  external_ref TEXT,
  usage_record_id BIGINT UNIQUE,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE billing_balance_ledger ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_billing_balance_ledger_user_created_at
  ON billing_balance_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_balance_ledger_kind_created_at
  ON billing_balance_ledger (kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_balance_ledger_external_ref
  ON billing_balance_ledger (external_ref) WHERE external_ref IS NOT NULL;
`

const LINE_ITEM_MIGRATIONS_SQL = `
ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_request_id_key;
CREATE INDEX IF NOT EXISTS idx_billing_line_items_request_id ON billing_line_items (request_id);
`

const USER_BILLING_MIGRATIONS_SQL = `
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'postpaid';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS billing_currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS balance_micros BIGINT NOT NULL DEFAULT 0;
UPDATE relay_users
SET billing_mode = 'postpaid'
WHERE billing_mode IS NULL OR billing_mode NOT IN ('postpaid', 'prepaid');
`

const BILLING_MIGRATIONS_SQL = `
ALTER TABLE billing_price_rules ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}';
ALTER TABLE billing_line_items ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}';
CREATE INDEX IF NOT EXISTS idx_billing_price_rules_currency_scope ON billing_price_rules (currency, provider, account_id, user_id, model);
CREATE INDEX IF NOT EXISTS idx_billing_line_items_currency_created_at ON billing_line_items (currency, usage_created_at DESC);
`

type BillingRuleRow = {
  id: string
  name: string
  is_active: boolean
  priority: number
  currency: string
  provider: string | null
  account_id: string | null
  user_id: string | null
  model: string | null
  effective_from: Date
  effective_to: Date | null
  input_price_micros_per_million: string | number | bigint
  output_price_micros_per_million: string | number | bigint
  cache_creation_price_micros_per_million: string | number | bigint
  cache_read_price_micros_per_million: string | number | bigint
  created_at: Date
  updated_at: Date
}

type BillingLedgerRow = {
  id: string
  user_id: string
  user_name: string | null
  kind: BillingLedgerKind
  amount_micros: string | number | bigint
  currency: string
  note: string | null
  usage_record_id: number | null
  request_id: string | null
  created_at: Date
  updated_at: Date
}

type AggregateRow = {
  total_requests: number
  billed_requests: number
  missing_rule_requests: number
  invalid_usage_requests: number
  total_input_tokens: string | number | bigint
  total_output_tokens: string | number | bigint
  total_cache_creation_tokens: string | number | bigint
  total_cache_read_tokens: string | number | bigint
  total_amount_micros: string | number | bigint
  unique_users?: number
  last_active_at?: Date | null
}

function normalizeStoredBillingCurrency(value: unknown): BillingCurrency {
  return normalizeBillingCurrency(value, {
    field: 'billingCurrency',
    fallback: DEFAULT_BILLING_CURRENCY,
  })
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeScopeField(value: unknown, field: string): string | null {
  return normalizeOptionalText(value, { field, maxLength: MAX_SCOPE_FIELD_LENGTH })
}

function normalizeRuleMicros(value: unknown, field: string): string {
  if (value == null || value === '') {
    return '0'
  }
  return normalizeUnsignedBigIntString(value, { field, allowZero: true })
}

function normalizeRuleDate(
  value: unknown,
  fallback: string,
  field: 'effectiveFrom' | 'effectiveTo',
): string {
  if (value == null || value === '') {
    return fallback
  }
  if (typeof value !== 'string') {
    throw new InputValidationError(`${field} must be a string`)
  }
  const trimmed = normalizeNullable(value)
  if (!trimmed) {
    return fallback
  }
  const timestamp = Date.parse(trimmed)
  if (!Number.isFinite(timestamp)) {
    throw new InputValidationError(`${field} must be a valid date`)
  }
  return new Date(timestamp).toISOString()
}

function normalizeOptionalRuleDate(
  value: unknown,
  field: 'effectiveFrom' | 'effectiveTo',
): string | null {
  if (value == null || value === '') {
    return null
  }
  if (typeof value !== 'string') {
    throw new InputValidationError(`${field} must be a string`)
  }
  const trimmed = normalizeNullable(value)
  if (!trimmed) {
    return null
  }
  const timestamp = Date.parse(trimmed)
  if (!Number.isFinite(timestamp)) {
    throw new InputValidationError(`${field} must be a valid date`)
  }
  return new Date(timestamp).toISOString()
}

function toBillingRule(row: BillingRuleRow): BillingRule {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    priority: Number(row.priority ?? 0),
    currency: normalizeStoredBillingCurrency(row.currency),
    provider: row.provider,
    accountId: row.account_id,
    userId: row.user_id,
    model: row.model,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to ? row.effective_to.toISOString() : null,
    inputPriceMicrosPerMillion: String(row.input_price_micros_per_million ?? '0'),
    outputPriceMicrosPerMillion: String(row.output_price_micros_per_million ?? '0'),
    cacheCreationPriceMicrosPerMillion: String(row.cache_creation_price_micros_per_million ?? '0'),
    cacheReadPriceMicrosPerMillion: String(row.cache_read_price_micros_per_million ?? '0'),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function readBigIntString(value: string | number | bigint | null | undefined): string {
  if (value == null) {
    return '0'
  }
  return typeof value === 'bigint' ? value.toString() : String(value)
}

function readInt(value: string | number | bigint | null | undefined): number {
  if (value == null) {
    return 0
  }
  return Number(value)
}

function normalizeSignedMicros(
  value: unknown,
  options?: { allowZero?: boolean },
): string {
  return normalizeSignedBigIntString(value, {
    field: 'amountMicros',
    allowZero: options?.allowZero ?? false,
  })
}

function normalizeSince(since: Date | null): Date {
  return since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
}

function toBillingLedgerEntry(row: BillingLedgerRow): BillingLedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    kind: row.kind,
    amountMicros: readBigIntString(row.amount_micros),
    currency: normalizeStoredBillingCurrency(row.currency),
    note: row.note,
    usageRecordId: row.usage_record_id == null ? null : Number(row.usage_record_id),
    requestId: row.request_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export class BillingStore {
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 })
  }

  async ensureTables(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(USER_BILLING_MIGRATIONS_SQL)
      await client.query(CREATE_RULES_SQL)
      await client.query(CREATE_LINE_ITEMS_SQL)
      await client.query(BILLING_MIGRATIONS_SQL)
      await client.query(LINE_ITEM_MIGRATIONS_SQL)
      await client.query(CREATE_LEDGER_SQL)
      await client.query(CREATE_META_SQL)
      await client.query(
        `UPDATE relay_users
         SET billing_currency = $1
         WHERE billing_currency IS NULL OR billing_currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      )
      await client.query(
        `UPDATE billing_price_rules
         SET currency = $1
         WHERE currency IS NULL OR currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      )
      await client.query(
        `UPDATE billing_line_items
         SET currency = $1
         WHERE currency IS NULL OR currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      )
      await client.query(
        `UPDATE billing_balance_ledger
         SET currency = $1
         WHERE currency IS NULL OR currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      )
      await client.query(
        `INSERT INTO billing_meta (key, value)
         VALUES ('last_usage_record_id', '0')
         ON CONFLICT (key) DO NOTHING`,
      )
      await this.ensureSystemFallbackRule(client)
    } finally {
      client.release()
    }
  }

  private async ensureSystemFallbackRule(client: pg.PoolClient): Promise<void> {
    for (const currency of ['USD', 'CNY'] satisfies BillingCurrency[]) {
      await client.query(
        `INSERT INTO billing_price_rules (
           id, name, is_active, priority, currency, provider, account_id, user_id, model,
           effective_from, effective_to,
           input_price_micros_per_million, output_price_micros_per_million,
           cache_creation_price_micros_per_million, cache_read_price_micros_per_million
         ) VALUES ($1,$2,true,$3,$4,NULL,NULL,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           is_active = true,
           priority = LEAST(billing_price_rules.priority, EXCLUDED.priority),
           currency = EXCLUDED.currency,
           input_price_micros_per_million = EXCLUDED.input_price_micros_per_million,
           output_price_micros_per_million = EXCLUDED.output_price_micros_per_million,
           cache_creation_price_micros_per_million = EXCLUDED.cache_creation_price_micros_per_million,
           cache_read_price_micros_per_million = EXCLUDED.cache_read_price_micros_per_million,
           updated_at = NOW()`,
        [
          `${SYSTEM_FALLBACK_RULE_ID_PREFIX}-${currency.toLowerCase()}`,
          `System default fallback (${currency}, all Claude Code / ChatGPT models)`,
          -1_000_000,
          currency,
          appConfig.billingFallbackInputPriceMicrosPerMillion,
          appConfig.billingFallbackOutputPriceMicrosPerMillion,
          appConfig.billingFallbackCacheCreationPriceMicrosPerMillion,
          appConfig.billingFallbackCacheReadPriceMicrosPerMillion,
        ],
      )
    }
  }

  async listRules(currency?: BillingCurrency | null): Promise<BillingRule[]> {
    const normalizedCurrency = currency
      ? normalizeBillingCurrency(currency, { field: 'currency', fallback: DEFAULT_BILLING_CURRENCY })
      : null
    const result = await this.pool.query<BillingRuleRow>(
      `SELECT *
       FROM billing_price_rules
       WHERE ($1::text IS NULL OR currency = $1)
       ORDER BY is_active DESC, priority DESC, effective_from DESC, created_at DESC`,
      [normalizedCurrency],
    )
    return result.rows.map(toBillingRule)
  }

  async getUserBalanceSummary(userId: string): Promise<BillingBalanceSummary | null> {
    const result = await this.pool.query<{
      user_id: string
      user_name: string | null
      billing_mode: string
      billing_currency: string
      balance_micros: string | number | bigint
      total_credited_micros: string | number | bigint
      total_debited_micros: string | number | bigint
      last_ledger_at: Date | null
    }>(
      `SELECT
         u.id AS user_id,
         u.name AS user_name,
         u.billing_mode,
         u.billing_currency,
         u.balance_micros,
         COALESCE(SUM(CASE WHEN l.amount_micros > 0 THEN l.amount_micros ELSE 0 END), 0)::bigint AS total_credited_micros,
         COALESCE(SUM(CASE WHEN l.amount_micros < 0 THEN -l.amount_micros ELSE 0 END), 0)::bigint AS total_debited_micros,
         MAX(l.created_at) AS last_ledger_at
       FROM relay_users u
       LEFT JOIN billing_balance_ledger l
         ON l.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id, u.name, u.billing_mode, u.billing_currency, u.balance_micros`,
      [userId],
    )

    const row = result.rows[0]
    if (!row) {
      return null
    }

    return {
      userId: row.user_id,
      userName: row.user_name,
      billingMode: row.billing_mode === 'prepaid' ? 'prepaid' : 'postpaid',
      billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
      balanceMicros: readBigIntString(row.balance_micros),
      totalCreditedMicros: readBigIntString(row.total_credited_micros),
      totalDebitedMicros: readBigIntString(row.total_debited_micros),
      currency: normalizeStoredBillingCurrency(row.billing_currency),
      lastLedgerAt: toIso(row.last_ledger_at),
    }
  }

  async listUserLedger(
    userId: string,
    limit = 100,
    offset = 0,
  ): Promise<{ entries: BillingLedgerEntry[]; total: number }> {
    const [{ rows }, countResult] = await Promise.all([
      this.pool.query<BillingLedgerRow>(
        `SELECT
           l.id,
           l.user_id,
           u.name AS user_name,
           l.kind,
           l.amount_micros,
           l.currency,
           l.note,
           l.usage_record_id,
           l.request_id,
           l.created_at,
           l.updated_at
         FROM billing_balance_ledger l
         LEFT JOIN relay_users u ON u.id = l.user_id
         WHERE l.user_id = $1
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $2 OFFSET $3`,
        [userId, Math.max(1, Math.min(limit, 500)), Math.max(0, offset)],
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::int AS total
         FROM billing_balance_ledger
         WHERE user_id = $1`,
        [userId],
      ),
    ])

    return {
      entries: rows.map(toBillingLedgerEntry),
      total: Number(countResult.rows[0]?.total ?? 0),
    }
  }

  async createLedgerEntry(input: {
    userId: string
    kind: Extract<BillingLedgerKind, 'topup' | 'manual_adjustment'>
    amountMicros: unknown
    note?: unknown
    externalRef?: string | null
  }): Promise<{ entry: BillingLedgerEntry; balance: BillingBalanceSummary; idempotent?: boolean }> {
    const amountMicros = normalizeSignedMicros(input.amountMicros)
    if (input.kind === 'topup' && BigInt(amountMicros) <= 0n) {
      throw new InputValidationError('Top-up amount must be positive')
    }
    const note = normalizeOptionalText(input.note, {
      field: 'note',
      maxLength: MAX_BILLING_NOTE_LENGTH,
    })
    const externalRef = normalizeOptionalText(input.externalRef ?? null, {
      field: 'externalRef',
      maxLength: 200,
    })

    if (externalRef) {
      const existing = await this.pool.query<BillingLedgerRow>(
        `SELECT
           l.id,
           l.user_id,
           u.name AS user_name,
           l.kind,
           l.amount_micros,
           l.currency,
           l.note,
           l.usage_record_id,
           l.request_id,
           l.created_at,
           l.updated_at
         FROM billing_balance_ledger l
         LEFT JOIN relay_users u ON u.id = l.user_id
         WHERE l.external_ref = $1`,
        [externalRef],
      )
      if (existing.rows.length) {
        const balance = await this.getUserBalanceSummary(existing.rows[0].user_id)
        if (!balance) {
          throw new Error('User balance not found for existing ledger entry')
        }
        return {
          entry: toBillingLedgerEntry(existing.rows[0]),
          balance,
          idempotent: true,
        }
      }
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const userResult = await client.query<{
        id: string
        name: string
        billing_currency: string
      }>(
        `SELECT id, name, billing_currency
         FROM relay_users
         WHERE id = $1
         FOR UPDATE`,
        [input.userId],
      )
      const userRow = userResult.rows[0]
      if (!userRow) {
        throw new Error('User not found')
      }
      const billingCurrency = normalizeStoredBillingCurrency(userRow.billing_currency)

      const entryId = crypto.randomUUID()
      await client.query(
        `INSERT INTO billing_balance_ledger (
          id, user_id, kind, amount_micros, currency, note, external_ref
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entryId,
          input.userId,
          input.kind,
          amountMicros,
          billingCurrency,
          note,
          externalRef,
        ],
      )
      await client.query(
        `UPDATE relay_users
         SET balance_micros = balance_micros + $1::bigint,
             updated_at = NOW()
         WHERE id = $2`,
        [amountMicros, input.userId],
      )

      await client.query('COMMIT')

      const [balance, ledger] = await Promise.all([
        this.getUserBalanceSummary(input.userId),
        this.pool.query<BillingLedgerRow>(
          `SELECT
             l.id,
             l.user_id,
             u.name AS user_name,
             l.kind,
             l.amount_micros,
             l.currency,
             l.note,
             l.usage_record_id,
             l.request_id,
             l.created_at,
             l.updated_at
           FROM billing_balance_ledger l
           LEFT JOIN relay_users u ON u.id = l.user_id
           WHERE l.id = $1`,
          [entryId],
        ),
      ])

      if (!balance) {
        throw new Error('User balance not found after ledger insert')
      }

      return {
        entry: toBillingLedgerEntry(ledger.rows[0]!),
        balance,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async assertUserCanConsume(userId: string): Promise<void> {
    const result = await this.pool.query<{
      billing_mode: string
      balance_micros: string | number | bigint
      name: string | null
    }>(
      `SELECT billing_mode, balance_micros, name
       FROM relay_users
       WHERE id = $1`,
      [userId],
    )
    const row = result.rows[0]
    if (!row) {
      return
    }

    if (row.billing_mode !== 'prepaid') {
      return
    }

    const balanceMicros = BigInt(readBigIntString(row.balance_micros))
    if (balanceMicros > 0n) {
      return
    }

    const displayName = sanitizeErrorMessage(normalizeNullable(row.name) ?? userId, userId)
    throw new Error(`Prepaid balance exhausted for ${displayName}. Please top up and retry.`)
  }

  async assertUserCurrencyChangeAllowed(
    userId: string,
    nextCurrency: BillingCurrency,
  ): Promise<void> {
    const normalizedCurrency = normalizeBillingCurrency(nextCurrency, {
      field: 'billingCurrency',
      fallback: DEFAULT_BILLING_CURRENCY,
    })
    const result = await this.pool.query<{
      billing_currency: string
      balance_micros: string | number | bigint
      ledger_count: string
      billed_count: string
    }>(
      `SELECT
         u.billing_currency,
         u.balance_micros,
         (
           SELECT COUNT(*)::int
           FROM billing_balance_ledger l
           WHERE l.user_id = u.id
         ) AS ledger_count,
         (
           SELECT COUNT(*)::int
           FROM billing_line_items b
           WHERE b.user_id = u.id
             AND b.status = 'billed'
         ) AS billed_count
       FROM relay_users u
       WHERE u.id = $1`,
      [userId],
    )
    const row = result.rows[0]
    if (!row) {
      return
    }

    const currentCurrency = normalizeStoredBillingCurrency(row.billing_currency)
    if (currentCurrency === normalizedCurrency) {
      return
    }

    if (BigInt(readBigIntString(row.balance_micros)) !== 0n) {
      throw new InputValidationError('Cannot change billingCurrency while balance is non-zero')
    }
    if (Number(row.ledger_count ?? 0) > 0 || Number(row.billed_count ?? 0) > 0) {
      throw new InputValidationError('Cannot change billingCurrency after billing history exists')
    }
  }

  async createRule(input: BillingRuleInput): Promise<BillingRule> {
    const name = normalizeRequiredText(input.name, {
      field: 'name',
      maxLength: MAX_BILLING_RULE_NAME_LENGTH,
    })
    const currency = normalizeBillingCurrency(input.currency ?? DEFAULT_BILLING_CURRENCY, {
      field: 'currency',
      fallback: DEFAULT_BILLING_CURRENCY,
    })

    const effectiveFrom = normalizeRuleDate(
      input.effectiveFrom ?? null,
      new Date().toISOString(),
      'effectiveFrom',
    )
    const effectiveTo = normalizeOptionalRuleDate(input.effectiveTo ?? null, 'effectiveTo')
    if (effectiveTo && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
      throw new InputValidationError('effectiveTo must be after effectiveFrom')
    }

    const id = crypto.randomUUID()
    const result = await this.pool.query<BillingRuleRow>(
      `INSERT INTO billing_price_rules (
        id, name, is_active, priority, currency, provider, account_id, user_id, model,
        effective_from, effective_to,
        input_price_micros_per_million, output_price_micros_per_million,
        cache_creation_price_micros_per_million, cache_read_price_micros_per_million
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
      [
        id,
        name,
        input.isActive ?? true,
        Number.isFinite(Number(input.priority)) ? Math.floor(Number(input.priority)) : 0,
        currency,
        normalizeScopeField(input.provider, 'provider'),
        normalizeScopeField(input.accountId, 'accountId'),
        normalizeScopeField(input.userId, 'userId'),
        normalizeScopeField(input.model, 'model'),
        effectiveFrom,
        effectiveTo,
        normalizeRuleMicros(input.inputPriceMicrosPerMillion, 'inputPriceMicrosPerMillion'),
        normalizeRuleMicros(input.outputPriceMicrosPerMillion, 'outputPriceMicrosPerMillion'),
        normalizeRuleMicros(input.cacheCreationPriceMicrosPerMillion, 'cacheCreationPriceMicrosPerMillion'),
        normalizeRuleMicros(input.cacheReadPriceMicrosPerMillion, 'cacheReadPriceMicrosPerMillion'),
      ],
    )
    return toBillingRule(result.rows[0]!)
  }

  async updateRule(ruleId: string, input: Partial<BillingRuleInput>): Promise<BillingRule | null> {
    const { rows } = await this.pool.query<BillingRuleRow>(
      'SELECT * FROM billing_price_rules WHERE id = $1',
      [ruleId],
    )
    if (!rows.length) {
      return null
    }

    const current = toBillingRule(rows[0]!)
    const currency = input.currency === undefined
      ? current.currency
      : normalizeBillingCurrency(input.currency, {
        field: 'currency',
        fallback: DEFAULT_BILLING_CURRENCY,
      })
    const name = input.name === undefined
      ? current.name
      : normalizeRequiredText(input.name, {
        field: 'name',
        maxLength: MAX_BILLING_RULE_NAME_LENGTH,
      })

    const effectiveFrom = input.effectiveFrom === undefined
      ? current.effectiveFrom
      : normalizeRuleDate(input.effectiveFrom ?? null, current.effectiveFrom, 'effectiveFrom')
    const effectiveTo = input.effectiveTo === undefined
      ? current.effectiveTo
      : normalizeOptionalRuleDate(input.effectiveTo ?? null, 'effectiveTo')
    if (effectiveTo && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
      throw new InputValidationError('effectiveTo must be after effectiveFrom')
    }

    const result = await this.pool.query<BillingRuleRow>(
      `UPDATE billing_price_rules
       SET name = $2,
           is_active = $3,
           priority = $4,
           currency = $5,
           provider = $6,
           account_id = $7,
           user_id = $8,
           model = $9,
           effective_from = $10,
           effective_to = $11,
           input_price_micros_per_million = $12,
           output_price_micros_per_million = $13,
           cache_creation_price_micros_per_million = $14,
           cache_read_price_micros_per_million = $15,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        ruleId,
        name,
        input.isActive ?? current.isActive,
        input.priority === undefined ? current.priority : (
          Number.isFinite(Number(input.priority))
            ? Math.floor(Number(input.priority))
            : current.priority
        ),
        currency,
        input.provider === undefined ? current.provider : normalizeScopeField(input.provider, 'provider'),
        input.accountId === undefined ? current.accountId : normalizeScopeField(input.accountId, 'accountId'),
        input.userId === undefined ? current.userId : normalizeScopeField(input.userId, 'userId'),
        input.model === undefined ? current.model : normalizeScopeField(input.model, 'model'),
        effectiveFrom,
        effectiveTo,
        input.inputPriceMicrosPerMillion === undefined
          ? current.inputPriceMicrosPerMillion
          : normalizeRuleMicros(input.inputPriceMicrosPerMillion, 'inputPriceMicrosPerMillion'),
        input.outputPriceMicrosPerMillion === undefined
          ? current.outputPriceMicrosPerMillion
          : normalizeRuleMicros(input.outputPriceMicrosPerMillion, 'outputPriceMicrosPerMillion'),
        input.cacheCreationPriceMicrosPerMillion === undefined
          ? current.cacheCreationPriceMicrosPerMillion
          : normalizeRuleMicros(input.cacheCreationPriceMicrosPerMillion, 'cacheCreationPriceMicrosPerMillion'),
        input.cacheReadPriceMicrosPerMillion === undefined
          ? current.cacheReadPriceMicrosPerMillion
          : normalizeRuleMicros(input.cacheReadPriceMicrosPerMillion, 'cacheReadPriceMicrosPerMillion'),
      ],
    )
    return toBillingRule(result.rows[0]!)
  }

  async deleteRule(ruleId: string): Promise<boolean> {
    if (ruleId.startsWith(`${SYSTEM_FALLBACK_RULE_ID_PREFIX}-`)) {
      throw new InputValidationError('System fallback billing rules cannot be deleted')
    }
    const result = await this.pool.query('DELETE FROM billing_price_rules WHERE id = $1', [ruleId])
    return Boolean(result.rowCount)
  }

  async preflightBillableRequest(input: BillingPreflightInput): Promise<BillingPreflightResult> {
    const rules = await this.listRules(input.billingCurrency)
    const resolved = resolveBillingLineItem({
      usageRecordId: 0,
      requestId: 'preflight',
      userId: input.userId,
      userName: null,
      billingCurrency: input.billingCurrency,
      accountId: input.accountId,
      provider: input.provider,
      model: input.model,
      sessionKey: null,
      clientDeviceId: null,
      target: input.target,
      inputTokens: 1,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      createdAt: new Date().toISOString(),
    }, rules)
    if (resolved.status !== 'billed') {
      return {
        ok: false,
        status: 'missing_rule',
        matchedRuleId: resolved.matchedRuleId,
        matchedRuleName: resolved.matchedRuleName,
      }
    }
    if (BigInt(resolved.amountMicros) <= 0n) {
      return {
        ok: false,
        status: 'zero_price',
        matchedRuleId: resolved.matchedRuleId,
        matchedRuleName: resolved.matchedRuleName,
      }
    }
    return {
      ok: true,
      status: 'billed',
      matchedRuleId: resolved.matchedRuleId,
      matchedRuleName: resolved.matchedRuleName,
    }
  }

  async syncLineItems(options?: { reconcileMissing?: boolean }): Promise<BillingSyncResult> {
    const rules = await this.listRules()
    const result: BillingSyncResult = {
      processedRequests: 0,
      billedRequests: 0,
      missingRuleRequests: 0,
      invalidUsageRequests: 0,
    }

    let lastUsageId = await this.getLastUsageRecordId()
    while (true) {
      const batch = await this.loadUsageCandidatesAfterId(lastUsageId, 250)
      if (!batch.length) {
        break
      }

      await this.upsertCandidates(batch, rules, result)
      lastUsageId = batch[batch.length - 1]!.usageRecordId
      await this.setLastUsageRecordId(lastUsageId)
    }

    if (options?.reconcileMissing) {
      let lastMissingUsageId = 0
      while (true) {
        const pending = await this.loadCandidatesForStatus('missing_rule', lastMissingUsageId, 500)
        if (!pending.length) {
          break
        }

        await this.upsertCandidates(pending, rules, result)
        lastMissingUsageId = pending[pending.length - 1]!.usageRecordId
      }
    }

    return result
  }

  async syncUsageRecordById(usageRecordId: number): Promise<void> {
    const normalizedUsageRecordId = Math.max(0, Math.floor(usageRecordId))
    if (!normalizedUsageRecordId) {
      return
    }

    const rules = await this.listRules()
    const candidate = await this.loadUsageCandidateById(normalizedUsageRecordId)
    if (!candidate) {
      return
    }

    const result: BillingSyncResult = {
      processedRequests: 0,
      billedRequests: 0,
      missingRuleRequests: 0,
      invalidUsageRequests: 0,
    }
    await this.upsertCandidates([candidate], rules, result)
  }

  async rebuildLineItems(): Promise<BillingSyncResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.revertUsageDebitLedgerEntries(client)
      await client.query('DELETE FROM billing_line_items')
      await client.query(
        `INSERT INTO billing_meta (key, value, updated_at)
         VALUES ('last_usage_record_id', '0', NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    return this.syncLineItems()
  }

  async getSummary(since: Date | null, currency?: BillingCurrency | null): Promise<BillingSummary> {
    const sinceDate = normalizeSince(since)
    const normalizedCurrency = normalizeBillingCurrency(
      currency ?? DEFAULT_BILLING_CURRENCY,
      { field: 'currency', fallback: DEFAULT_BILLING_CURRENCY },
    )
    await this.syncLineItems()
    const [aggregateResult, activeRulesResult] = await Promise.all([
      this.pool.query<AggregateRow>(
        `SELECT
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_rule')::int AS missing_rule_requests,
           COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
           COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation_tokens,
           COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read_tokens,
           COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros,
           COUNT(DISTINCT user_id)::int AS unique_users,
           MAX(usage_created_at) AS last_active_at
         FROM billing_line_items
         WHERE usage_created_at >= $1
           AND currency = $2`,
        [sinceDate, normalizedCurrency],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count
         FROM billing_price_rules
         WHERE is_active = true
           AND currency = $1`,
        [normalizedCurrency],
      ),
    ])

    const row = aggregateResult.rows[0] ?? {
      total_requests: 0,
      billed_requests: 0,
      missing_rule_requests: 0,
      invalid_usage_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_amount_micros: 0,
      unique_users: 0,
      last_active_at: null,
    }

    return {
      currency: normalizedCurrency,
      totalRequests: Number(row.total_requests ?? 0),
      billedRequests: Number(row.billed_requests ?? 0),
      missingRuleRequests: Number(row.missing_rule_requests ?? 0),
      invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
      totalInputTokens: readInt(row.total_input_tokens),
      totalOutputTokens: readInt(row.total_output_tokens),
      totalCacheCreationTokens: readInt(row.total_cache_creation_tokens),
      totalCacheReadTokens: readInt(row.total_cache_read_tokens),
      totalAmountMicros: readBigIntString(row.total_amount_micros),
      uniqueUsers: Number(row.unique_users ?? 0),
      activeRules: Number(activeRulesResult.rows[0]?.count ?? 0),
      period: {
        from: sinceDate.toISOString(),
        to: row.last_active_at ? new Date(row.last_active_at).toISOString() : new Date().toISOString(),
      },
    }
  }

  async getUserBilling(since: Date | null, currency?: BillingCurrency | null): Promise<BillingUserRow[]> {
    const sinceDate = normalizeSince(since)
    const normalizedCurrency = normalizeBillingCurrency(
      currency ?? DEFAULT_BILLING_CURRENCY,
      { field: 'currency', fallback: DEFAULT_BILLING_CURRENCY },
    )
    await this.syncLineItems()
    const result = await this.pool.query<{
      user_id: string
      user_name: string | null
      currency: string
      total_requests: number
      billed_requests: number
      missing_rule_requests: number
      invalid_usage_requests: number
      total_input_tokens: string | number | bigint
      total_output_tokens: string | number | bigint
      total_cache_creation_tokens: string | number | bigint
      total_cache_read_tokens: string | number | bigint
      total_amount_micros: string | number | bigint
      last_active_at: Date | null
    }>(
      `SELECT
         user_id,
         MAX(user_name) AS user_name,
         MAX(currency) AS currency,
         COUNT(*)::int AS total_requests,
         COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
         COUNT(*) FILTER (WHERE status = 'missing_rule')::int AS missing_rule_requests,
         COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
         COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
         COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read_tokens,
         COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros,
         MAX(usage_created_at) AS last_active_at
       FROM billing_line_items
       WHERE usage_created_at >= $1
         AND currency = $2
       GROUP BY user_id
       ORDER BY total_amount_micros DESC, total_input_tokens DESC, user_id ASC`,
      [sinceDate, normalizedCurrency],
    )

    return result.rows.map((row) => ({
      userId: row.user_id,
      userName: row.user_name,
      currency: normalizeStoredBillingCurrency(row.currency),
      totalRequests: Number(row.total_requests ?? 0),
      billedRequests: Number(row.billed_requests ?? 0),
      missingRuleRequests: Number(row.missing_rule_requests ?? 0),
      invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
      totalInputTokens: readInt(row.total_input_tokens),
      totalOutputTokens: readInt(row.total_output_tokens),
      totalCacheCreationTokens: readInt(row.total_cache_creation_tokens),
      totalCacheReadTokens: readInt(row.total_cache_read_tokens),
      totalAmountMicros: readBigIntString(row.total_amount_micros),
      lastActiveAt: toIso(row.last_active_at),
    }))
  }

  async getUserDetail(userId: string, since: Date | null): Promise<BillingUserDetail | null> {
    const sinceDate = normalizeSince(since)
    await this.syncLineItems()

    const [totalResult, byPeriodResult, byModelResult] = await Promise.all([
      this.pool.query<AggregateRow>(
        `SELECT
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_rule')::int AS missing_rule_requests,
           COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
           COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation_tokens,
           COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read_tokens,
           COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros,
           MAX(user_name) AS user_name,
           MAX(currency) AS currency,
           MAX(usage_created_at) AS last_active_at
         FROM billing_line_items
         WHERE user_id = $1
           AND usage_created_at >= $2`,
        [userId, sinceDate],
      ),
      this.pool.query<{
        period_start: Date
        total_requests: number
        billed_requests: number
        missing_rule_requests: number
        invalid_usage_requests: number
        total_input_tokens: string | number | bigint
        total_output_tokens: string | number | bigint
        total_amount_micros: string | number | bigint
      }>(
        `SELECT
           date_trunc('month', usage_created_at) AS period_start,
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_rule')::int AS missing_rule_requests,
           COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
           COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros
         FROM billing_line_items
         WHERE user_id = $1
           AND usage_created_at >= $2
         GROUP BY date_trunc('month', usage_created_at)
         ORDER BY period_start DESC`,
        [userId, sinceDate],
      ),
      this.pool.query<{
        model: string | null
        total_requests: number
        billed_requests: number
        missing_rule_requests: number
        invalid_usage_requests: number
        total_input_tokens: string | number | bigint
        total_output_tokens: string | number | bigint
        total_amount_micros: string | number | bigint
      }>(
        `SELECT
           model,
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_rule')::int AS missing_rule_requests,
           COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
           COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros
         FROM billing_line_items
         WHERE user_id = $1
           AND usage_created_at >= $2
         GROUP BY model
         ORDER BY total_amount_micros DESC, total_input_tokens DESC, model ASC NULLS LAST`,
        [userId, sinceDate],
      ),
    ])

    const total = totalResult.rows[0]
    if (!total || Number(total.total_requests ?? 0) === 0) {
      return null
    }

    return {
      userId,
      userName: (total as AggregateRow & { user_name?: string | null }).user_name ?? null,
      currency: normalizeStoredBillingCurrency((total as AggregateRow & { currency?: string | null }).currency),
      totalRequests: Number(total.total_requests ?? 0),
      billedRequests: Number(total.billed_requests ?? 0),
      missingRuleRequests: Number(total.missing_rule_requests ?? 0),
      invalidUsageRequests: Number(total.invalid_usage_requests ?? 0),
      totalInputTokens: readInt(total.total_input_tokens),
      totalOutputTokens: readInt(total.total_output_tokens),
      totalCacheCreationTokens: readInt(total.total_cache_creation_tokens),
      totalCacheReadTokens: readInt(total.total_cache_read_tokens),
      totalAmountMicros: readBigIntString(total.total_amount_micros),
      lastActiveAt: toIso(total.last_active_at),
      byPeriod: byPeriodResult.rows.map((row) => ({
        periodStart: row.period_start.toISOString().slice(0, 7),
        totalRequests: Number(row.total_requests ?? 0),
        billedRequests: Number(row.billed_requests ?? 0),
        missingRuleRequests: Number(row.missing_rule_requests ?? 0),
        invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
        totalInputTokens: readInt(row.total_input_tokens),
        totalOutputTokens: readInt(row.total_output_tokens),
        totalAmountMicros: readBigIntString(row.total_amount_micros),
      })),
      byModel: byModelResult.rows.map((row) => ({
        model: normalizeNullable(row.model) ?? '(unknown)',
        totalRequests: Number(row.total_requests ?? 0),
        billedRequests: Number(row.billed_requests ?? 0),
        missingRuleRequests: Number(row.missing_rule_requests ?? 0),
        invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
        totalInputTokens: readInt(row.total_input_tokens),
        totalOutputTokens: readInt(row.total_output_tokens),
        totalAmountMicros: readBigIntString(row.total_amount_micros),
      })),
    }
  }

  async getUserLineItems(
    userId: string,
    since: Date | null,
    limit = 100,
    offset = 0,
  ): Promise<{ items: BillingLineItemRow[]; total: number }> {
    const sinceDate = normalizeSince(since)
    await this.syncLineItems()
    const [{ rows }, countResult] = await Promise.all([
      this.pool.query<{
        usage_record_id: number
        request_id: string
        currency: string
        status: 'billed' | 'missing_rule' | 'invalid_usage'
        matched_rule_id: string | null
        matched_rule_name: string | null
        account_id: string | null
        provider: string | null
        model: string | null
        target: string
        session_key: string | null
        client_device_id: string | null
        input_tokens: number
        output_tokens: number
        cache_creation_input_tokens: number
        cache_read_input_tokens: number
        amount_micros: string | number | bigint
        usage_created_at: Date
      }>(
        `SELECT
           usage_record_id, request_id, currency, status, matched_rule_id, matched_rule_name,
           account_id, provider, model, target, session_key, client_device_id,
           input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
           amount_micros, usage_created_at
         FROM billing_line_items
         WHERE user_id = $1
           AND usage_created_at >= $2
         ORDER BY usage_created_at DESC
         LIMIT $3 OFFSET $4`,
        [userId, sinceDate, Math.max(1, Math.min(limit, 500)), Math.max(0, offset)],
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::int AS total
         FROM billing_line_items
         WHERE user_id = $1
           AND usage_created_at >= $2`,
        [userId, sinceDate],
      ),
    ])

    return {
      items: rows.map((row) => ({
        usageRecordId: Number(row.usage_record_id),
        requestId: row.request_id,
        currency: normalizeStoredBillingCurrency(row.currency),
        status: row.status,
        matchedRuleId: row.matched_rule_id,
        matchedRuleName: row.matched_rule_name,
        accountId: row.account_id,
        provider: row.provider,
        model: row.model,
        target: row.target,
        sessionKey: row.session_key,
        clientDeviceId: row.client_device_id,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheCreationTokens: Number(row.cache_creation_input_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_input_tokens ?? 0),
        amountMicros: readBigIntString(row.amount_micros),
        usageCreatedAt: row.usage_created_at.toISOString(),
      })),
      total: Number(countResult.rows[0]?.total ?? 0),
    }
  }

  async getUserUsageSnapshot(
    userId: string,
    since: Date | null,
    limit = 50,
    offset = 0,
  ): Promise<BillingUserUsageSnapshot> {
    const sinceDate = normalizeSince(since)
    const cappedLimit = Math.max(1, Math.min(limit, 200))
    const cappedOffset = Math.max(0, offset)
    await this.syncLineItems()

    const [totalResult, byDayResult, byModelResult, itemsResult, countResult] =
      await Promise.all([
        this.pool.query<AggregateRow & { user_name?: string | null; currency?: string | null }>(
          `SELECT
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
             COUNT(*) FILTER (WHERE status = 'missing_rule')::int AS missing_rule_requests,
             COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
             COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read_tokens,
             COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros,
             MAX(user_name) AS user_name,
             MAX(currency) AS currency,
             MAX(usage_created_at) AS last_active_at
           FROM billing_line_items
           WHERE user_id = $1
             AND usage_created_at >= $2`,
          [userId, sinceDate],
        ),
        this.pool.query<{
          period_start: Date
          total_requests: number
          billed_requests: number
          total_input_tokens: string | number | bigint
          total_output_tokens: string | number | bigint
          total_cache_creation_tokens: string | number | bigint
          total_cache_read_tokens: string | number | bigint
          total_amount_micros: string | number | bigint
        }>(
          `SELECT
             date_trunc('day', usage_created_at) AS period_start,
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
             COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_creation_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read_tokens,
             COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros
           FROM billing_line_items
           WHERE user_id = $1
             AND usage_created_at >= $2
           GROUP BY date_trunc('day', usage_created_at)
           ORDER BY period_start DESC
           LIMIT 90`,
          [userId, sinceDate],
        ),
        this.pool.query<{
          model: string | null
          total_requests: number
          billed_requests: number
          missing_rule_requests: number
          invalid_usage_requests: number
          total_input_tokens: string | number | bigint
          total_output_tokens: string | number | bigint
          total_amount_micros: string | number | bigint
        }>(
          `SELECT
             model,
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
             COUNT(*) FILTER (WHERE status = 'missing_rule')::int AS missing_rule_requests,
             COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
             COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
             COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros
           FROM billing_line_items
           WHERE user_id = $1
             AND usage_created_at >= $2
           GROUP BY model
           ORDER BY total_amount_micros DESC, total_input_tokens DESC, model ASC NULLS LAST`,
          [userId, sinceDate],
        ),
        this.pool.query<{
          usage_record_id: number
          request_id: string
          currency: string
          status: 'billed' | 'missing_rule' | 'invalid_usage'
          matched_rule_id: string | null
          matched_rule_name: string | null
          account_id: string | null
          provider: string | null
          model: string | null
          target: string
          session_key: string | null
          client_device_id: string | null
          input_tokens: number
          output_tokens: number
          cache_creation_input_tokens: number
          cache_read_input_tokens: number
          amount_micros: string | number | bigint
          usage_created_at: Date
        }>(
          `SELECT
             usage_record_id, request_id, currency, status, matched_rule_id, matched_rule_name,
             account_id, provider, model, target, session_key, client_device_id,
             input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
             amount_micros, usage_created_at
           FROM billing_line_items
           WHERE user_id = $1
             AND usage_created_at >= $2
           ORDER BY usage_created_at DESC
           LIMIT $3 OFFSET $4`,
          [userId, sinceDate, cappedLimit, cappedOffset],
        ),
        this.pool.query<{ total: string }>(
          `SELECT COUNT(*)::int AS total
           FROM billing_line_items
           WHERE user_id = $1
             AND usage_created_at >= $2`,
          [userId, sinceDate],
        ),
      ])

    const total = totalResult.rows[0]
    const totalRequests = Number(total?.total_requests ?? 0)

    return {
      userId,
      currency: total?.currency
        ? normalizeStoredBillingCurrency(total.currency)
        : null,
      totalRequests,
      billedRequests: Number(total?.billed_requests ?? 0),
      missingRuleRequests: Number(total?.missing_rule_requests ?? 0),
      invalidUsageRequests: Number(total?.invalid_usage_requests ?? 0),
      totalInputTokens: total ? readInt(total.total_input_tokens) : 0,
      totalOutputTokens: total ? readInt(total.total_output_tokens) : 0,
      totalCacheCreationTokens: total ? readInt(total.total_cache_creation_tokens) : 0,
      totalCacheReadTokens: total ? readInt(total.total_cache_read_tokens) : 0,
      totalAmountMicros: total ? readBigIntString(total.total_amount_micros) : '0',
      lastActiveAt: total?.last_active_at ? toIso(total.last_active_at) : null,
      byDay: byDayResult.rows.map((row) => ({
        date: row.period_start.toISOString().slice(0, 10),
        totalRequests: Number(row.total_requests ?? 0),
        billedRequests: Number(row.billed_requests ?? 0),
        totalInputTokens: readInt(row.total_input_tokens),
        totalOutputTokens: readInt(row.total_output_tokens),
        totalCacheCreationTokens: readInt(row.total_cache_creation_tokens),
        totalCacheReadTokens: readInt(row.total_cache_read_tokens),
        totalAmountMicros: readBigIntString(row.total_amount_micros),
      })),
      byModel: byModelResult.rows.map((row) => ({
        model: normalizeNullable(row.model) ?? '(unknown)',
        totalRequests: Number(row.total_requests ?? 0),
        billedRequests: Number(row.billed_requests ?? 0),
        missingRuleRequests: Number(row.missing_rule_requests ?? 0),
        invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
        totalInputTokens: readInt(row.total_input_tokens),
        totalOutputTokens: readInt(row.total_output_tokens),
        totalAmountMicros: readBigIntString(row.total_amount_micros),
      })),
      items: itemsResult.rows.map((row) => ({
        usageRecordId: Number(row.usage_record_id),
        requestId: row.request_id,
        currency: normalizeStoredBillingCurrency(row.currency),
        status: row.status,
        matchedRuleId: row.matched_rule_id,
        matchedRuleName: row.matched_rule_name,
        accountId: row.account_id,
        provider: row.provider,
        model: row.model,
        target: row.target,
        sessionKey: row.session_key,
        clientDeviceId: row.client_device_id,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheCreationTokens: Number(row.cache_creation_input_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_input_tokens ?? 0),
        amountMicros: readBigIntString(row.amount_micros),
        usageCreatedAt: row.usage_created_at.toISOString(),
      })),
      itemsTotal: Number(countResult.rows[0]?.total ?? 0),
      itemsLimit: cappedLimit,
      itemsOffset: cappedOffset,
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async upsertCandidates(
    candidates: BillingUsageCandidate[],
    rules: BillingRule[],
    result: BillingSyncResult,
  ): Promise<void> {
    if (!candidates.length) {
      return
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const candidate of candidates) {
        const resolved = resolveBillingLineItem(candidate, rules)
        await client.query(
          `INSERT INTO billing_line_items (
            usage_record_id, request_id, user_id, user_name, account_id, provider, model,
            session_key, client_device_id, target, currency, status, matched_rule_id, matched_rule_name,
            input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
            input_price_micros_per_million, output_price_micros_per_million,
            cache_creation_price_micros_per_million, cache_read_price_micros_per_million,
            amount_micros, usage_created_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,
            $8,$9,$10,$11,$12,$13,$14,
            $15,$16,$17,$18,
            $19,$20,$21,$22,
            $23,$24,NOW()
          )
          ON CONFLICT (usage_record_id) DO UPDATE SET
            request_id = EXCLUDED.request_id,
            user_id = EXCLUDED.user_id,
            user_name = EXCLUDED.user_name,
            account_id = EXCLUDED.account_id,
            provider = EXCLUDED.provider,
            model = EXCLUDED.model,
            session_key = EXCLUDED.session_key,
            client_device_id = EXCLUDED.client_device_id,
            target = EXCLUDED.target,
            currency = EXCLUDED.currency,
            status = EXCLUDED.status,
            matched_rule_id = EXCLUDED.matched_rule_id,
            matched_rule_name = EXCLUDED.matched_rule_name,
            input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens,
            cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
            cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
            input_price_micros_per_million = EXCLUDED.input_price_micros_per_million,
            output_price_micros_per_million = EXCLUDED.output_price_micros_per_million,
            cache_creation_price_micros_per_million = EXCLUDED.cache_creation_price_micros_per_million,
            cache_read_price_micros_per_million = EXCLUDED.cache_read_price_micros_per_million,
            amount_micros = EXCLUDED.amount_micros,
            usage_created_at = EXCLUDED.usage_created_at,
            updated_at = NOW()`,
          [
            candidate.usageRecordId,
            candidate.requestId,
            candidate.userId,
            candidate.userName,
            candidate.accountId,
            candidate.provider,
            candidate.model,
            candidate.sessionKey,
            candidate.clientDeviceId,
            candidate.target,
            resolved.currency,
            resolved.status,
            resolved.matchedRuleId,
            resolved.matchedRuleName,
            candidate.inputTokens,
            candidate.outputTokens,
            candidate.cacheCreationInputTokens,
            candidate.cacheReadInputTokens,
            resolved.inputPriceMicrosPerMillion,
            resolved.outputPriceMicrosPerMillion,
            resolved.cacheCreationPriceMicrosPerMillion,
            resolved.cacheReadPriceMicrosPerMillion,
            resolved.amountMicros,
            candidate.createdAt,
          ],
        )
        await this.syncUsageDebitLedgerEntry(client, candidate, resolved)

        result.processedRequests += 1
        if (resolved.status === 'billed') {
          result.billedRequests += 1
        } else if (resolved.status === 'missing_rule') {
          result.missingRuleRequests += 1
        } else {
          result.invalidUsageRequests += 1
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  private async getLastUsageRecordId(): Promise<number> {
    const result = await this.pool.query<{ value: string }>(
      `SELECT value FROM billing_meta WHERE key = 'last_usage_record_id'`,
    )
    const raw = result.rows[0]?.value ?? '0'
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : 0
  }

  private async setLastUsageRecordId(value: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_meta (key, value, updated_at)
       VALUES ('last_usage_record_id', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(Math.max(0, Math.floor(value)))],
    )
  }

  private async loadUsageCandidatesAfterId(
    afterId: number,
    limit: number,
  ): Promise<BillingUsageCandidate[]> {
    const result = await this.pool.query<{
      usage_record_id: number
      request_id: string
      user_id: string
      user_name: string | null
      billing_currency: string
      account_id: string | null
      provider: string | null
      model: string | null
      session_key: string | null
      client_device_id: string | null
      target: string
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
      status_code: number
      created_at: Date
    }>(
      `SELECT
         u.id AS usage_record_id,
         u.request_id,
         u.user_id,
         ru.name AS user_name,
         ru.billing_currency,
         u.account_id,
         a.data->>'provider' AS provider,
         u.model,
         u.session_key,
         u.client_device_id,
         u.target,
         u.input_tokens,
         u.output_tokens,
         u.cache_creation_input_tokens,
         u.cache_read_input_tokens,
         u.status_code,
         u.created_at
       FROM usage_records u
       LEFT JOIN billing_line_items b ON b.usage_record_id = u.id
       LEFT JOIN relay_users ru ON ru.id = u.user_id
       LEFT JOIN accounts a ON a.id = u.account_id
       WHERE u.id > $1
         AND b.usage_record_id IS NULL
         AND u.user_id IS NOT NULL
         AND u.status_code >= 200
         AND u.status_code < 300
         AND COALESCE(u.attempt_kind, 'final') = 'final'
         AND (split_part(u.target, '?', 1) = ANY($2) OR split_part(u.target, '?', 1) LIKE '/v1/responses/%')
       ORDER BY u.id ASC
       LIMIT $3`,
      [afterId, [...BILLABLE_USAGE_TARGETS], limit],
    )

    return result.rows
      .filter((row) => isBillableUsageTarget(row.target))
      .map((row) => ({
        usageRecordId: Number(row.usage_record_id),
        requestId: row.request_id,
        userId: row.user_id,
        userName: row.user_name,
        billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
        accountId: row.account_id,
        provider: row.provider,
        model: row.model,
        sessionKey: row.session_key,
        clientDeviceId: row.client_device_id,
        target: row.target,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheCreationInputTokens: Number(row.cache_creation_input_tokens ?? 0),
        cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
        statusCode: Number(row.status_code ?? 0),
        createdAt: row.created_at.toISOString(),
      }))
  }

  private async loadUsageCandidateById(
    usageRecordId: number,
  ): Promise<BillingUsageCandidate | null> {
    const result = await this.pool.query<{
      usage_record_id: number
      request_id: string
      user_id: string
      user_name: string | null
      billing_currency: string
      account_id: string | null
      provider: string | null
      model: string | null
      session_key: string | null
      client_device_id: string | null
      target: string
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
      status_code: number
      created_at: Date
    }>(
      `SELECT
         u.id AS usage_record_id,
         u.request_id,
         u.user_id,
         ru.name AS user_name,
         ru.billing_currency,
         u.account_id,
         a.data->>'provider' AS provider,
         u.model,
         u.session_key,
         u.client_device_id,
         u.target,
         u.input_tokens,
         u.output_tokens,
         u.cache_creation_input_tokens,
         u.cache_read_input_tokens,
         u.status_code,
         u.created_at
       FROM usage_records u
       LEFT JOIN relay_users ru ON ru.id = u.user_id
       LEFT JOIN accounts a ON a.id = u.account_id
       WHERE u.id = $1
         AND u.user_id IS NOT NULL
         AND u.status_code >= 200
         AND u.status_code < 300
         AND COALESCE(u.attempt_kind, 'final') = 'final'
         AND (split_part(u.target, '?', 1) = ANY($2) OR split_part(u.target, '?', 1) LIKE '/v1/responses/%')
       LIMIT 1`,
      [usageRecordId, [...BILLABLE_USAGE_TARGETS]],
    )

    const row = result.rows[0]
    if (!row || !isBillableUsageTarget(row.target)) {
      return null
    }

    return {
      usageRecordId: Number(row.usage_record_id),
      requestId: row.request_id,
      userId: row.user_id,
      userName: row.user_name,
      billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
      accountId: row.account_id,
      provider: row.provider,
      model: row.model,
      sessionKey: row.session_key,
      clientDeviceId: row.client_device_id,
      target: row.target,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
      statusCode: Number(row.status_code ?? 0),
      createdAt: row.created_at.toISOString(),
    }
  }

  private async loadCandidatesForStatus(
    status: 'missing_rule',
    afterUsageRecordId: number,
    limit: number,
  ): Promise<BillingUsageCandidate[]> {
    const result = await this.pool.query<{
      usage_record_id: number
      request_id: string
      user_id: string
      user_name: string | null
      billing_currency: string
      account_id: string | null
      provider: string | null
      model: string | null
      session_key: string | null
      client_device_id: string | null
      target: string
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
      status_code: number
      created_at: Date
    }>(
      `SELECT
         u.id AS usage_record_id,
         u.request_id,
         u.user_id,
         ru.name AS user_name,
         ru.billing_currency,
         u.account_id,
         a.data->>'provider' AS provider,
         u.model,
         u.session_key,
         u.client_device_id,
         u.target,
         u.input_tokens,
         u.output_tokens,
         u.cache_creation_input_tokens,
         u.cache_read_input_tokens,
         u.status_code,
         u.created_at
       FROM billing_line_items b
       INNER JOIN usage_records u ON u.id = b.usage_record_id
       LEFT JOIN relay_users ru ON ru.id = u.user_id
       LEFT JOIN accounts a ON a.id = u.account_id
       WHERE b.status = $1
         AND b.usage_record_id > $2
       ORDER BY u.id ASC
       LIMIT $3`,
      [status, afterUsageRecordId, limit],
    )

    return result.rows.map((row) => ({
      usageRecordId: Number(row.usage_record_id),
      requestId: row.request_id,
      userId: row.user_id,
      userName: row.user_name,
      billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
      accountId: row.account_id,
      provider: row.provider,
      model: row.model,
      sessionKey: row.session_key,
      clientDeviceId: row.client_device_id,
      target: row.target,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
      statusCode: Number(row.status_code ?? 0),
      createdAt: row.created_at.toISOString(),
    }))
  }

  private async syncUsageDebitLedgerEntry(
    client: pg.PoolClient,
    candidate: BillingUsageCandidate,
    resolved: ReturnType<typeof resolveBillingLineItem>,
  ): Promise<void> {
    const targetAmountMicros =
      resolved.status === 'billed'
        ? (-BigInt(resolved.amountMicros)).toString()
        : '0'

    const existingResult = await client.query<{
      id: string
      currency: string
      amount_micros: string | number | bigint
    }>(
      `SELECT id, currency, amount_micros
       FROM billing_balance_ledger
       WHERE usage_record_id = $1
       FOR UPDATE`,
      [candidate.usageRecordId],
    )
    const existing = existingResult.rows[0]
    const existingAmountMicros = existing ? BigInt(readBigIntString(existing.amount_micros)) : 0n
    const existingCurrency = existing ? normalizeStoredBillingCurrency(existing.currency) : null
    const nextAmountMicros = BigInt(targetAmountMicros)

    if (!existing && nextAmountMicros === 0n) {
      return
    }

    const delta = nextAmountMicros - existingAmountMicros
    if (delta !== 0n) {
      await client.query(
        `UPDATE relay_users
         SET balance_micros = balance_micros + $1::bigint,
             updated_at = NOW()
         WHERE id = $2`,
        [delta.toString(), candidate.userId],
      )
    }

    if (!existing) {
      await client.query(
        `INSERT INTO billing_balance_ledger (
          id, user_id, kind, amount_micros, currency, note, usage_record_id, request_id
        ) VALUES ($1, $2, 'usage_debit', $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          candidate.userId,
          targetAmountMicros,
          resolved.currency,
          resolved.matchedRuleName
            ? `Usage charge via ${resolved.matchedRuleName}`
            : 'Usage charge',
          candidate.usageRecordId,
          candidate.requestId,
        ],
      )
      return
    }

    if (nextAmountMicros === 0n) {
      await client.query(
        `DELETE FROM billing_balance_ledger
         WHERE id = $1`,
        [existing.id],
      )
      return
    }

    if (delta !== 0n || existingCurrency !== resolved.currency) {
      await client.query(
        `UPDATE billing_balance_ledger
         SET amount_micros = $2::bigint,
             currency = $3,
             note = $4,
             request_id = $5,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.id,
          targetAmountMicros,
          resolved.currency,
          resolved.matchedRuleName
            ? `Usage charge via ${resolved.matchedRuleName}`
            : 'Usage charge',
          candidate.requestId,
        ],
      )
    }
  }

  private async revertUsageDebitLedgerEntries(client: pg.PoolClient): Promise<void> {
    const aggregates = await client.query<{
      user_id: string
      amount_micros: string | number | bigint
    }>(
      `SELECT user_id, COALESCE(SUM(amount_micros), 0)::bigint AS amount_micros
       FROM billing_balance_ledger
       WHERE usage_record_id IS NOT NULL
       GROUP BY user_id`,
    )

    for (const row of aggregates.rows) {
      const amountMicros = BigInt(readBigIntString(row.amount_micros))
      if (amountMicros === 0n) {
        continue
      }
      await client.query(
        `UPDATE relay_users
         SET balance_micros = balance_micros - $1::bigint,
             updated_at = NOW()
         WHERE id = $2`,
        [amountMicros.toString(), row.user_id],
      )
    }

    await client.query(
      `DELETE FROM billing_balance_ledger
       WHERE usage_record_id IS NOT NULL`,
    )
  }
}
