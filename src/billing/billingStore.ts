import crypto from "node:crypto";

import pg from "pg";

import { appConfig } from "../config.js";
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
} from "../security/inputValidation.js";
import type { BillingCurrency } from "../types.js";
import {
  BILLABLE_USAGE_TARGETS,
  applyMultiplier,
  type BillingBaseSku,
  type BillingChannelMultiplier,
  type BillingModelProvider,
  type BillingModelProtocol,
  type BillingModelVendor,
  type BillingResolvedSku,
  type BillingUsageCandidate,
  isBillableUsageTarget,
  resolveBillingLineItem,
} from "./engine.js";
import { officialModelSkuInputs } from "./officialModelSkus.js";

const DEFAULT_BILLING_CURRENCY = normalizeBillingCurrency(
  appConfig.billingCurrency,
  {
    field: "BILLING_CURRENCY",
  },
);

const ONE_MILLION_MICROS = "1000000";

export interface BillingBaseSkuInput {
  provider: BillingModelProvider;
  modelVendor?: BillingModelVendor | null;
  protocol?: BillingModelProtocol | null;
  model: string;
  currency: BillingCurrency;
  displayName?: string | null;
  isActive?: boolean;
  supportsPromptCaching?: boolean;
  inputPriceMicrosPerMillion?: string | number | bigint;
  outputPriceMicrosPerMillion?: string | number | bigint;
  cacheCreationPriceMicrosPerMillion?: string | number | bigint;
  cacheReadPriceMicrosPerMillion?: string | number | bigint;
  topupCurrency?: BillingCurrency;
  topupAmountMicros?: string | number | bigint;
  creditAmountMicros?: string | number | bigint;
}

export interface BillingChannelMultiplierInput {
  routingGroupId: string;
  provider: BillingModelProvider;
  modelVendor?: BillingModelVendor | null;
  protocol?: BillingModelProtocol | null;
  model: string;
  multiplierMicros?: string | number | bigint;
  isActive?: boolean;
  showInFrontend?: boolean;
  allowCalls?: boolean;
}

export interface BillingSummary {
  currency: BillingCurrency;
  totalRequests: number;
  billedRequests: number;
  missingSkuRequests: number;
  invalidUsageRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalAmountMicros: string;
  uniqueUsers: number;
  activeSkus: number;
  period: { from: string; to: string };
}

export interface BillingUserRow {
  userId: string;
  userName: string | null;
  currency: BillingCurrency;
  totalRequests: number;
  billedRequests: number;
  missingSkuRequests: number;
  invalidUsageRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalAmountMicros: string;
  lastActiveAt: string | null;
}

export interface BillingUserPeriodRow {
  periodStart: string;
  totalRequests: number;
  billedRequests: number;
  missingSkuRequests: number;
  invalidUsageRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalAmountMicros: string;
}

export interface BillingUserModelRow {
  model: string;
  totalRequests: number;
  billedRequests: number;
  missingSkuRequests: number;
  invalidUsageRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalAmountMicros: string;
}

export interface BillingUserDetail {
  userId: string;
  userName: string | null;
  currency: BillingCurrency;
  totalRequests: number;
  billedRequests: number;
  missingSkuRequests: number;
  invalidUsageRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalAmountMicros: string;
  lastActiveAt: string | null;
  byPeriod: BillingUserPeriodRow[];
  byModel: BillingUserModelRow[];
}

export interface BillingLineItemRow {
  usageRecordId: number;
  requestId: string;
  currency: BillingCurrency;
  status: "billed" | "missing_sku" | "invalid_usage";
  accountId: string | null;
  provider: string | null;
  model: string | null;
  routingGroupId: string | null;
  target: string;
  sessionKey: string | null;
  clientDeviceId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  amountMicros: string;
  usageCreatedAt: string;
}

export interface BillingUserDayRow {
  date: string;
  totalRequests: number;
  billedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalAmountMicros: string;
}

export interface BillingUserUsageSnapshot {
  userId: string | null;
  organizationId?: string | null;
  currency: BillingCurrency | null;
  totalRequests: number;
  billedRequests: number;
  missingSkuRequests: number;
  invalidUsageRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalAmountMicros: string;
  lastActiveAt: string | null;
  byDay: BillingUserDayRow[];
  byModel: BillingUserModelRow[];
  items: BillingLineItemRow[];
  itemsTotal: number;
  itemsLimit: number;
  itemsOffset: number;
}

export type BillingLedgerKind = "topup" | "manual_adjustment" | "usage_debit";

export interface BillingBalanceSummary {
  userId: string | null;
  organizationId?: string | null;
  userName: string | null;
  billingMode: "postpaid" | "prepaid";
  billingCurrency: BillingCurrency;
  balanceMicros: string;
  totalCreditedMicros: string;
  totalDebitedMicros: string;
  currency: BillingCurrency;
  lastLedgerAt: string | null;
}

export interface BillingLedgerEntry {
  id: string;
  userId: string | null;
  organizationId?: string | null;
  userName: string | null;
  kind: BillingLedgerKind;
  amountMicros: string;
  currency: BillingCurrency;
  note: string | null;
  usageRecordId: number | null;
  requestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingLedgerExternalRefEntry {
  id: string;
  userId: string | null;
  organizationId?: string | null;
  kind: BillingLedgerKind;
  amountMicros: string;
  currency: BillingCurrency;
  note: string | null;
  externalRef: string;
  createdAt: string;
}

export type BillingTopupOrderStatus = "pending" | "confirmed" | "cancelled";

export interface BillingTopupOrder {
  id: string;
  userId: string | null;
  organizationId: string | null;
  amountMicros: string;
  currency: BillingCurrency;
  creditAmountMicros: string;
  status: BillingTopupOrderStatus;
  paymentProvider: string;
  externalRef: string | null;
  note: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface BillingSyncResult {
  processedRequests: number;
  billedRequests: number;
  missingSkuRequests: number;
  invalidUsageRequests: number;
}

export interface BillingPreflightInput {
  userId: string | null;
  organizationId?: string | null;
  billingCurrency: BillingCurrency;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  routingGroupId: string | null;
  target: string;
  /** Override the protocol inferred from `target` (e.g. when an adapter rewrites the upstream wire format). */
  protocolOverride?: BillingModelProtocol | null;
  /** Lower-bound estimate of input tokens for this request. Defaults to 1 if omitted. */
  estimatedInputTokens?: number;
  /** Lower-bound estimate of output tokens for this request. Defaults to 0 if omitted. */
  estimatedOutputTokens?: number;
}

export interface BillingPreflightResult {
  ok: boolean;
  status:
    | "billed"
    | "missing_sku"
    | "zero_price"
    | "insufficient_balance";
  /** Estimated minimum charge for the request, in micros of `currency`. Only set when status is `billed` or `insufficient_balance`. */
  estimatedAmountMicros?: string;
  /** Currently available balance (prepaid balance, or postpaid balance + credit limit), in micros. */
  availableMicros?: string;
  /** Currency the amounts are denominated in (matches the resolved SKU). */
  currency?: BillingCurrency;
}

export interface ChannelUsageWindowSnapshot {
  totalRequests: number;
  successRequests: number;
  successRate: number | null;
  p50Ms: number | null;
  p99Ms: number | null;
}

export interface ChannelUsageWindowStats {
  last5m: ChannelUsageWindowSnapshot;
  last1h: ChannelUsageWindowSnapshot;
  last24h: ChannelUsageWindowSnapshot;
}

export interface ChannelUsageHistoryBucket {
  bucketStart: string;
  totalRequests: number;
  successRequests: number;
  successRate: number | null;
}

export interface ChannelLastVerified {
  durationMs: number;
  atIso: string;
}

function emptyWindowSnapshot(): ChannelUsageWindowSnapshot {
  return {
    totalRequests: 0,
    successRequests: 0,
    successRate: null,
    p50Ms: null,
    p99Ms: null,
  };
}

const CREATE_BASE_SKUS_SQL = `
CREATE TABLE IF NOT EXISTS billing_base_skus (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  model_vendor TEXT NOT NULL DEFAULT 'custom' CHECK (model_vendor IN ('anthropic', 'openai', 'google', 'deepseek', 'zhipu', 'mimo', 'custom')),
  protocol TEXT NOT NULL DEFAULT 'anthropic_messages' CHECK (protocol IN ('anthropic_messages', 'openai_chat', 'openai_responses', 'gemini')),
  model TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'CNY')),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  supports_prompt_caching BOOLEAN NOT NULL DEFAULT false,
  input_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  output_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  cache_creation_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  cache_read_price_micros_per_million BIGINT NOT NULL DEFAULT 0,
  topup_currency TEXT NOT NULL DEFAULT 'CNY',
  topup_amount_micros BIGINT NOT NULL DEFAULT 1000000,
  credit_amount_micros BIGINT NOT NULL DEFAULT 1000000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_base_skus_provider_model_currency
  ON billing_base_skus (provider, model, currency);
`;

const CREATE_CHANNEL_MULTIPLIERS_SQL = `
CREATE TABLE IF NOT EXISTS billing_channel_multipliers (
  id TEXT PRIMARY KEY,
  routing_group_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  model_vendor TEXT NOT NULL DEFAULT 'custom' CHECK (model_vendor IN ('anthropic', 'openai', 'google', 'deepseek', 'zhipu', 'mimo', 'custom')),
  protocol TEXT NOT NULL DEFAULT 'anthropic_messages' CHECK (protocol IN ('anthropic_messages', 'openai_chat', 'openai_responses', 'gemini')),
  model TEXT NOT NULL,
  multiplier_micros BIGINT NOT NULL DEFAULT 1000000,
  is_active BOOLEAN NOT NULL DEFAULT true,
  show_in_frontend BOOLEAN NOT NULL DEFAULT true,
  allow_calls BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_channel_multipliers_group_provider_model
  ON billing_channel_multipliers (routing_group_id, provider, model);
CREATE INDEX IF NOT EXISTS idx_billing_channel_multipliers_group
  ON billing_channel_multipliers (routing_group_id);
ALTER TABLE billing_channel_multipliers ADD COLUMN IF NOT EXISTS show_in_frontend BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE billing_channel_multipliers ADD COLUMN IF NOT EXISTS allow_calls BOOLEAN NOT NULL DEFAULT true;
`;

const CREATE_LINE_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS billing_line_items (
  id BIGSERIAL PRIMARY KEY,
  usage_record_id BIGINT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  user_id TEXT,
  organization_id TEXT,
  user_name TEXT,
  account_id TEXT,
  provider TEXT,
  model TEXT,
  routing_group_id TEXT,
  session_key TEXT,
  client_device_id TEXT,
  target TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}',
  status TEXT NOT NULL CHECK (status IN ('billed', 'missing_sku', 'invalid_usage')),
  matched_base_sku_id TEXT,
  matched_multiplier_micros BIGINT,
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
CREATE INDEX IF NOT EXISTS idx_billing_line_items_routing_group_created ON billing_line_items (routing_group_id, usage_created_at DESC);
`;

const CREATE_META_SQL = `
CREATE TABLE IF NOT EXISTS billing_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const CREATE_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS billing_balance_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  organization_id TEXT,
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
ALTER TABLE billing_balance_ledger ADD COLUMN IF NOT EXISTS organization_id TEXT;
CREATE INDEX IF NOT EXISTS idx_billing_balance_ledger_user_created_at
  ON billing_balance_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_balance_ledger_kind_created_at
  ON billing_balance_ledger (kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_balance_ledger_external_ref
  ON billing_balance_ledger (external_ref) WHERE external_ref IS NOT NULL;
`;

const CREATE_TOPUP_ORDERS_SQL = `
CREATE TABLE IF NOT EXISTS billing_topup_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  organization_id TEXT,
  amount_micros BIGINT NOT NULL CHECK (amount_micros > 0),
  currency TEXT NOT NULL,
  credit_amount_micros BIGINT NOT NULL CHECK (credit_amount_micros > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  payment_provider TEXT NOT NULL,
  external_ref TEXT,
  note TEXT,
  ledger_entry_id TEXT REFERENCES billing_balance_ledger(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);
ALTER TABLE billing_topup_orders ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE billing_topup_orders ADD COLUMN IF NOT EXISTS ledger_entry_id TEXT;
CREATE INDEX IF NOT EXISTS idx_billing_topup_orders_user_created_at
  ON billing_topup_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_topup_orders_org_created_at
  ON billing_topup_orders (organization_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_topup_orders_external_ref
  ON billing_topup_orders (external_ref) WHERE external_ref IS NOT NULL;
`;

const USER_BILLING_MIGRATIONS_SQL = `
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'prepaid';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS billing_currency TEXT NOT NULL DEFAULT '${DEFAULT_BILLING_CURRENCY}';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS customer_tier TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS credit_limit_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS sales_owner TEXT;
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS risk_status TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE relay_users ADD COLUMN IF NOT EXISTS balance_micros BIGINT NOT NULL DEFAULT 0;
UPDATE relay_users
SET billing_mode = 'prepaid'
WHERE billing_mode IS NULL OR billing_mode NOT IN ('postpaid', 'prepaid');
UPDATE relay_users
SET customer_tier = 'standard'
WHERE customer_tier IS NULL OR customer_tier NOT IN ('standard', 'plus', 'business', 'enterprise', 'internal');
UPDATE relay_users
SET risk_status = 'normal'
WHERE risk_status IS NULL OR risk_status NOT IN ('normal', 'watch', 'restricted', 'blocked');
UPDATE relay_users
SET credit_limit_micros = 0
WHERE credit_limit_micros IS NULL OR credit_limit_micros < 0;
`;

type BillingBaseSkuRow = {
  id: string;
  provider: string;
  model_vendor: string;
  protocol: string;
  model: string;
  currency: string;
  display_name: string;
  is_active: boolean;
  supports_prompt_caching: boolean;
  input_price_micros_per_million: string | number | bigint;
  output_price_micros_per_million: string | number | bigint;
  cache_creation_price_micros_per_million: string | number | bigint;
  cache_read_price_micros_per_million: string | number | bigint;
  topup_currency: string;
  topup_amount_micros: string | number | bigint;
  credit_amount_micros: string | number | bigint;
  created_at: Date;
  updated_at: Date;
};

type BillingChannelMultiplierRow = {
  id: string;
  routing_group_id: string;
  provider: string;
  model_vendor: string;
  protocol: string;
  model: string;
  multiplier_micros: string | number | bigint;
  is_active: boolean;
  show_in_frontend: boolean;
  allow_calls: boolean;
  created_at: Date;
  updated_at: Date;
};

type BillingResolvedSkuRow = BillingBaseSkuRow & {
  multiplier_id: string;
  routing_group_id: string;
  multiplier_micros: string | number | bigint;
  multiplier_active: boolean;
};

type BillingLedgerRow = {
  id: string;
  user_id: string | null;
  organization_id?: string | null;
  user_name: string | null;
  kind: BillingLedgerKind;
  amount_micros: string | number | bigint;
  currency: string;
  note: string | null;
  usage_record_id: number | null;
  request_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type BillingTopupOrderRow = {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  amount_micros: string | number | bigint;
  currency: string;
  credit_amount_micros: string | number | bigint;
  status: BillingTopupOrderStatus;
  payment_provider: string;
  external_ref: string | null;
  note: string | null;
  ledger_entry_id: string | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
};

type AggregateRow = {
  total_requests: number;
  billed_requests: number;
  missing_sku_requests: number;
  invalid_usage_requests: number;
  total_input_tokens: string | number | bigint;
  total_output_tokens: string | number | bigint;
  total_cache_creation_tokens: string | number | bigint;
  total_cache_read_tokens: string | number | bigint;
  total_amount_micros: string | number | bigint;
  unique_users?: number;
  last_active_at?: Date | null;
};

function normalizeStoredBillingCurrency(value: unknown): BillingCurrency {
  return normalizeBillingCurrency(value, {
    field: "billingCurrency",
    fallback: DEFAULT_BILLING_CURRENCY,
  });
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeScopeField(value: unknown, field: string): string | null {
  return normalizeOptionalText(value, {
    field,
    maxLength: MAX_SCOPE_FIELD_LENGTH,
  });
}

function normalizeRuleMicros(value: unknown, field: string): string {
  if (value == null || value === "") {
    return "0";
  }
  return normalizeUnsignedBigIntString(value, { field, allowZero: true });
}

function normalizeBillingModelProvider(value: unknown): BillingModelProvider {
  if (value === "anthropic" || value === "openai" || value === "google") {
    return value;
  }
  throw new InputValidationError(
    "provider must be one of: anthropic, openai, google",
  );
}

function defaultProtocolForProvider(
  provider: BillingModelProvider,
): BillingModelProtocol {
  if (provider === "openai") return "openai_chat";
  if (provider === "google") return "gemini";
  return "anthropic_messages";
}

function normalizeBillingModelProtocol(
  value: unknown,
  provider: BillingModelProvider,
): BillingModelProtocol {
  if (
    value === "anthropic_messages" ||
    value === "openai_chat" ||
    value === "openai_responses" ||
    value === "gemini"
  ) {
    return value;
  }
  if (value == null || value === "") {
    return defaultProtocolForProvider(provider);
  }
  throw new InputValidationError(
    "protocol must be one of: anthropic_messages, openai_chat, openai_responses, gemini",
  );
}

function inferModelVendorFromModel(
  model: string,
  provider: BillingModelProvider,
): BillingModelVendor {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) return "anthropic";
  if (
    normalized.startsWith("gpt") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  )
    return "openai";
  if (normalized.startsWith("gemini")) return "google";
  if (normalized.startsWith("deepseek")) return "deepseek";
  if (normalized.startsWith("glm")) return "zhipu";
  if (normalized.startsWith("mimo")) return "mimo";
  if (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "google"
  )
    return provider;
  return "custom";
}

function normalizeUsageModelForBilling(
  model: string | null,
  provider: BillingModelProvider | null,
): string | null {
  if (!model) return null;
  const normalized = model.trim();
  if (!normalized) return null;
  if (provider !== "openai") return normalized;
  return normalized.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function normalizeBillingModelVendor(
  value: unknown,
  model: string,
  provider: BillingModelProvider,
): BillingModelVendor {
  if (
    value === "anthropic" ||
    value === "openai" ||
    value === "google" ||
    value === "deepseek" ||
    value === "zhipu" ||
    value === "mimo" ||
    value === "custom"
  ) {
    return value;
  }
  if (value == null || value === "") {
    return inferModelVendorFromModel(model, provider);
  }
  throw new InputValidationError(
    "modelVendor must be one of: anthropic, openai, google, deepseek, zhipu, mimo, custom",
  );
}

function normalizeUsageProvider(
  value: string | null | undefined,
): BillingModelProvider | null {
  if (
    value === "anthropic" ||
    value === "claude-official" ||
    value === "claude-compatible"
  ) {
    return "anthropic";
  }
  if (
    value === "openai" ||
    value === "openai-codex" ||
    value === "openai-compatible"
  ) {
    return "openai";
  }
  if (value === "google" || value === "google-gemini-oauth") {
    return "google";
  }
  return null;
}

function protocolForUsageTarget(target: string): BillingModelProtocol | null {
  const normalizedTarget = target.split("?", 1)[0] ?? target;
  if (normalizedTarget === "/v1/messages") return "anthropic_messages";
  if (normalizedTarget === "/v1/chat/completions") return "openai_chat";
  if (
    normalizedTarget === "/v1/responses" ||
    normalizedTarget.startsWith("/v1/responses/")
  )
    return "openai_responses";
  return null;
}

function baseSkuId(
  protocol: BillingModelProtocol,
  modelVendor: BillingModelVendor,
  model: string,
  currency: BillingCurrency,
): string {
  return (
    protocol + ":" + modelVendor + ":" + model + ":" + currency.toLowerCase()
  );
}

function channelMultiplierId(
  routingGroupId: string,
  protocol: BillingModelProtocol,
  modelVendor: BillingModelVendor,
  model: string,
): string {
  return routingGroupId + ":" + protocol + ":" + modelVendor + ":" + model;
}

function displayNameFromModel(model: string): string {
  return model;
}

function toBillingBaseSku(row: BillingBaseSkuRow): BillingBaseSku {
  return {
    id: row.id,
    provider: normalizeBillingModelProvider(row.provider),
    modelVendor: normalizeBillingModelVendor(
      row.model_vendor,
      row.model,
      normalizeBillingModelProvider(row.provider),
    ),
    protocol: normalizeBillingModelProtocol(
      row.protocol,
      normalizeBillingModelProvider(row.provider),
    ),
    model: row.model,
    currency: normalizeStoredBillingCurrency(row.currency),
    displayName: row.display_name,
    isActive: row.is_active,
    supportsPromptCaching: row.supports_prompt_caching,
    inputPriceMicrosPerMillion: readBigIntString(
      row.input_price_micros_per_million,
    ),
    outputPriceMicrosPerMillion: readBigIntString(
      row.output_price_micros_per_million,
    ),
    cacheCreationPriceMicrosPerMillion: readBigIntString(
      row.cache_creation_price_micros_per_million,
    ),
    cacheReadPriceMicrosPerMillion: readBigIntString(
      row.cache_read_price_micros_per_million,
    ),
    topupCurrency: normalizeStoredBillingCurrency(row.topup_currency),
    topupAmountMicros: readBigIntString(row.topup_amount_micros),
    creditAmountMicros: readBigIntString(row.credit_amount_micros),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toBillingChannelMultiplier(
  row: BillingChannelMultiplierRow,
): BillingChannelMultiplier {
  return {
    id: row.id,
    routingGroupId: row.routing_group_id,
    provider: normalizeBillingModelProvider(row.provider),
    modelVendor: normalizeBillingModelVendor(
      row.model_vendor,
      row.model,
      normalizeBillingModelProvider(row.provider),
    ),
    protocol: normalizeBillingModelProtocol(
      row.protocol,
      normalizeBillingModelProvider(row.provider),
    ),
    model: row.model,
    multiplierMicros: readBigIntString(row.multiplier_micros),
    isActive: row.is_active,
    showInFrontend: row.show_in_frontend,
    allowCalls: row.allow_calls,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toResolvedSku(row: BillingResolvedSkuRow): BillingResolvedSku {
  const base = toBillingBaseSku(row);
  const multiplierMicros = readBigIntString(row.multiplier_micros);
  return {
    baseSkuId: base.id,
    multiplierId: row.multiplier_id,
    multiplierMicros,
    routingGroupId: row.routing_group_id,
    provider: base.provider,
    modelVendor: base.modelVendor,
    protocol: base.protocol,
    model: base.model,
    currency: base.currency,
    displayName: base.displayName,
    finalInputPriceMicrosPerMillion: applyMultiplier(
      base.inputPriceMicrosPerMillion,
      multiplierMicros,
    ),
    finalOutputPriceMicrosPerMillion: applyMultiplier(
      base.outputPriceMicrosPerMillion,
      multiplierMicros,
    ),
    finalCacheCreationPriceMicrosPerMillion: applyMultiplier(
      base.cacheCreationPriceMicrosPerMillion,
      multiplierMicros,
    ),
    finalCacheReadPriceMicrosPerMillion: applyMultiplier(
      base.cacheReadPriceMicrosPerMillion,
      multiplierMicros,
    ),
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function readBigIntString(
  value: string | number | bigint | null | undefined,
): string {
  if (value == null) {
    return "0";
  }
  return typeof value === "bigint" ? value.toString() : String(value);
}

function readInt(value: string | number | bigint | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return Number(value);
}

function normalizeSignedMicros(
  value: unknown,
  options?: { allowZero?: boolean },
): string {
  return normalizeSignedBigIntString(value, {
    field: "amountMicros",
    allowZero: options?.allowZero ?? false,
  });
}

function normalizeSince(since: Date | null): Date {
  return since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}


function assertLedgerIdempotencyMatch(
  row: BillingLedgerRow,
  expected: {
    userId?: string | null;
    organizationId?: string | null;
    kind: BillingLedgerKind;
    amountMicros: string;
  },
): void {
  const rowAmountMicros = readBigIntString(row.amount_micros);
  const rowUserId = row.user_id ?? null;
  const rowOrganizationId = row.organization_id ?? null;
  const expectedUserId = expected.userId ?? null;
  const expectedOrganizationId = expected.organizationId ?? null;

  if (
    row.kind !== expected.kind ||
    rowAmountMicros !== expected.amountMicros ||
    rowUserId !== expectedUserId ||
    rowOrganizationId !== expectedOrganizationId
  ) {
    throw new InputValidationError(
      "Idempotency key conflicts with an existing ledger entry",
    );
  }
}

function toBillingLedgerEntry(row: BillingLedgerRow): BillingLedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id ?? null,
    userName: row.user_name,
    kind: row.kind,
    amountMicros: readBigIntString(row.amount_micros),
    currency: normalizeStoredBillingCurrency(row.currency),
    note: row.note,
    usageRecordId:
      row.usage_record_id == null ? null : Number(row.usage_record_id),
    requestId: row.request_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toBillingTopupOrder(row: BillingTopupOrderRow): BillingTopupOrder {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    amountMicros: readBigIntString(row.amount_micros),
    currency: normalizeStoredBillingCurrency(row.currency),
    creditAmountMicros: readBigIntString(row.credit_amount_micros),
    status: row.status,
    paymentProvider: row.payment_provider,
    externalRef: row.external_ref,
    note: row.note,
    ledgerEntryId: row.ledger_entry_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
  };
}

export class BillingStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
  }

  async ensureTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(USER_BILLING_MIGRATIONS_SQL);
      await client.query(CREATE_BASE_SKUS_SQL);
      await client.query(CREATE_CHANNEL_MULTIPLIERS_SQL);
      await client.query(CREATE_LINE_ITEMS_SQL);
      await client.query(CREATE_LEDGER_SQL);
      await client.query(CREATE_TOPUP_ORDERS_SQL);
      await client.query(CREATE_META_SQL);
      await client.query(
        "ALTER TABLE billing_line_items ADD COLUMN IF NOT EXISTS organization_id TEXT",
      );
      await client.query(
        "ALTER TABLE billing_line_items ALTER COLUMN user_id DROP NOT NULL",
      );
      await client.query(
        `DELETE FROM billing_line_items WHERE user_id IS NULL AND organization_id IS NULL`,
      );
      await client.query(
        `ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_exactly_one_owner`,
      );
      await client.query(
        `ALTER TABLE billing_line_items ADD CONSTRAINT billing_line_items_exactly_one_owner CHECK ((user_id IS NULL) <> (organization_id IS NULL)) NOT VALID`,
      );
      await client.query(
        "ALTER TABLE billing_balance_ledger ADD COLUMN IF NOT EXISTS organization_id TEXT",
      );
      await client.query(
        "ALTER TABLE billing_balance_ledger ALTER COLUMN user_id DROP NOT NULL",
      );
      await client.query(
        `DELETE FROM billing_balance_ledger WHERE user_id IS NULL AND organization_id IS NULL`,
      );
      await client.query(
        `ALTER TABLE billing_balance_ledger DROP CONSTRAINT IF EXISTS billing_balance_ledger_exactly_one_owner`,
      );
      await client.query(
        `ALTER TABLE billing_balance_ledger ADD CONSTRAINT billing_balance_ledger_exactly_one_owner CHECK ((user_id IS NULL) <> (organization_id IS NULL)) NOT VALID`,
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_billing_line_items_org_created_at ON billing_line_items (organization_id, usage_created_at DESC)",
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_billing_balance_ledger_org_created_at ON billing_balance_ledger (organization_id, created_at DESC)",
      );
      await client.query(
        `ALTER TABLE billing_base_skus ADD COLUMN IF NOT EXISTS model_vendor TEXT NOT NULL DEFAULT 'custom'`,
      );
      await client.query(
        `ALTER TABLE billing_base_skus ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'anthropic_messages'`,
      );
      await client.query(
        `ALTER TABLE billing_channel_multipliers ADD COLUMN IF NOT EXISTS model_vendor TEXT NOT NULL DEFAULT 'custom'`,
      );
      await client.query(
        `ALTER TABLE billing_channel_multipliers ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'anthropic_messages'`,
      );
      await client.query(
        `UPDATE billing_base_skus
         SET protocol = CASE provider
           WHEN 'openai' THEN 'openai_chat'
           WHEN 'google' THEN 'gemini'
           ELSE 'anthropic_messages'
         END
         WHERE protocol IS NULL OR protocol = '' OR (protocol = 'anthropic_messages' AND split_part(id, ':', 1) = provider)`,
      );
      await client.query(
        `UPDATE billing_channel_multipliers
         SET protocol = CASE provider
           WHEN 'openai' THEN 'openai_chat'
           WHEN 'google' THEN 'gemini'
           ELSE 'anthropic_messages'
         END
         WHERE protocol IS NULL OR protocol = '' OR (protocol = 'anthropic_messages' AND split_part(id, ':', 2) = provider)`,
      );
      await client.query(
        `UPDATE billing_base_skus
         SET model_vendor = CASE
           WHEN lower(model) LIKE 'claude%' THEN 'anthropic'
           WHEN lower(model) LIKE 'gpt%' OR lower(model) LIKE 'o1%' OR lower(model) LIKE 'o3%' OR lower(model) LIKE 'o4%' THEN 'openai'
           WHEN lower(model) LIKE 'gemini%' THEN 'google'
           WHEN lower(model) LIKE 'deepseek%' THEN 'deepseek'
           WHEN lower(model) LIKE 'glm%' THEN 'zhipu'
           WHEN lower(model) LIKE 'mimo%' THEN 'mimo'
           ELSE provider
         END
         WHERE model_vendor IS NULL OR model_vendor = '' OR (model_vendor = 'custom' AND split_part(id, ':', 1) = provider)`,
      );
      await client.query(
        `UPDATE billing_channel_multipliers
         SET model_vendor = CASE
           WHEN lower(model) LIKE 'claude%' THEN 'anthropic'
           WHEN lower(model) LIKE 'gpt%' OR lower(model) LIKE 'o1%' OR lower(model) LIKE 'o3%' OR lower(model) LIKE 'o4%' THEN 'openai'
           WHEN lower(model) LIKE 'gemini%' THEN 'google'
           WHEN lower(model) LIKE 'deepseek%' THEN 'deepseek'
           WHEN lower(model) LIKE 'glm%' THEN 'zhipu'
           WHEN lower(model) LIKE 'mimo%' THEN 'mimo'
           ELSE provider
         END
         WHERE model_vendor IS NULL OR model_vendor = '' OR (model_vendor = 'custom' AND split_part(id, ':', 2) = provider)`,
      );
      await client.query(
        "DROP INDEX IF EXISTS uq_billing_base_skus_provider_model_currency",
      );
      await client.query(
        "DROP INDEX IF EXISTS uq_billing_channel_multipliers_group_provider_model",
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_billing_base_skus_provider_model_currency
         ON billing_base_skus (provider, model, currency)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_billing_channel_multipliers_group_provider_model
         ON billing_channel_multipliers (routing_group_id, provider, model)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_base_skus_protocol_vendor_model_currency
         ON billing_base_skus (protocol, model_vendor, model, currency)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_channel_multipliers_group_protocol_vendor_model
         ON billing_channel_multipliers (routing_group_id, protocol, model_vendor, model)`,
      );
      await client.query(
        `INSERT INTO billing_base_skus (
           id, provider, model_vendor, protocol, model, currency, display_name, is_active, supports_prompt_caching,
           input_price_micros_per_million, output_price_micros_per_million,
           cache_creation_price_micros_per_million, cache_read_price_micros_per_million,
           topup_currency, topup_amount_micros, credit_amount_micros, created_at, updated_at
         )
         SELECT
           'openai_responses:' || model_vendor || ':' || model || ':' || lower(currency),
           provider, model_vendor, 'openai_responses', model, currency, display_name, is_active, supports_prompt_caching,
           input_price_micros_per_million, output_price_micros_per_million,
           cache_creation_price_micros_per_million, cache_read_price_micros_per_million,
           topup_currency, topup_amount_micros, credit_amount_micros, created_at, NOW()
         FROM billing_base_skus
         WHERE provider = 'openai'
           AND protocol = 'openai_chat'
         ON CONFLICT (protocol, model_vendor, model, currency) DO NOTHING`,
      );
      await client.query(
        `INSERT INTO billing_channel_multipliers (
           id, routing_group_id, provider, model_vendor, protocol, model, multiplier_micros, is_active, created_at, updated_at
         )
         SELECT
           routing_group_id || ':openai_responses:' || model_vendor || ':' || model,
           routing_group_id, provider, model_vendor, 'openai_responses', model, multiplier_micros, is_active, created_at, NOW()
         FROM billing_channel_multipliers
         WHERE provider = 'openai'
           AND protocol = 'openai_chat'
         ON CONFLICT (routing_group_id, protocol, model_vendor, model) DO NOTHING`,
      );
      await client.query(
        `UPDATE relay_users
         SET billing_currency = $1
         WHERE billing_currency IS NULL OR billing_currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      );
      await client.query(
        `UPDATE billing_line_items
         SET currency = $1
         WHERE currency IS NULL OR currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      );
      await client.query(
        `UPDATE billing_balance_ledger
         SET currency = $1
         WHERE currency IS NULL OR currency NOT IN ('USD', 'CNY')`,
        [DEFAULT_BILLING_CURRENCY],
      );
      await client.query(
        `INSERT INTO billing_meta (key, value)
         VALUES ('last_usage_record_id', '0')
         ON CONFLICT (key) DO NOTHING`,
      );
      await this.seedOfficialModelSkus(client);
      await this.seedOfficialModelChannelMultipliers(client);
    } finally {
      client.release();
    }
  }

  private async seedOfficialModelSkus(client: pg.PoolClient): Promise<void> {
    // OpenAI 官方价目目录由人工维护，不再 seed。仅 anthropic / google 的官方 SKU 仍由代码注入。
    for (const sku of officialModelSkuInputs()) {
      await this.upsertBaseSkuWithClient(client, sku);
    }
  }

  private async seedOfficialModelChannelMultipliers(
    client: pg.PoolClient,
  ): Promise<void> {
    await client.query(
      `WITH existing_group_protocols AS (
         SELECT DISTINCT routing_group_id, provider, model_vendor, protocol
         FROM billing_channel_multipliers
       )
       INSERT INTO billing_channel_multipliers (
         id, routing_group_id, provider, model_vendor, protocol, model,
         multiplier_micros, is_active, show_in_frontend, allow_calls
       )
       SELECT
         concat_ws($2, g.routing_group_id, g.protocol, b.model_vendor, b.model),
         g.routing_group_id, g.provider, g.model_vendor, g.protocol, b.model,
         $1, true, true, true
       FROM existing_group_protocols g
       JOIN billing_base_skus b
         ON b.provider = g.provider
        AND b.model_vendor = g.model_vendor
        AND b.protocol = g.protocol
        AND b.currency = $3
        AND b.is_active = true
       ON CONFLICT (routing_group_id, protocol, model_vendor, model) DO NOTHING`,
      [ONE_MILLION_MICROS, ":", "USD"],
    );
  }

  private normalizeBaseSkuInput(
    input: BillingBaseSkuInput,
  ): Omit<BillingBaseSku, "createdAt" | "updatedAt"> {
    const provider = normalizeBillingModelProvider(input.provider);
    const model = normalizeRequiredText(input.model, {
      field: "model",
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    });
    const modelVendor = normalizeBillingModelVendor(
      input.modelVendor,
      model,
      provider,
    );
    const protocol = normalizeBillingModelProtocol(input.protocol, provider);
    const currency = normalizeBillingCurrency(input.currency, {
      field: "currency",
      fallback: "USD",
    });
    const topupCurrency = normalizeBillingCurrency(
      input.topupCurrency ?? "CNY",
      { field: "topupCurrency", fallback: "CNY" },
    );
    return {
      id: baseSkuId(protocol, modelVendor, model, currency),
      provider,
      modelVendor,
      protocol,
      model,
      currency,
      displayName:
        normalizeOptionalText(input.displayName, {
          field: "displayName",
          maxLength: MAX_BILLING_RULE_NAME_LENGTH,
        }) ?? displayNameFromModel(model),
      isActive: input.isActive ?? true,
      supportsPromptCaching: input.supportsPromptCaching ?? false,
      inputPriceMicrosPerMillion: normalizeRuleMicros(
        input.inputPriceMicrosPerMillion,
        "inputPriceMicrosPerMillion",
      ),
      outputPriceMicrosPerMillion: normalizeRuleMicros(
        input.outputPriceMicrosPerMillion,
        "outputPriceMicrosPerMillion",
      ),
      cacheCreationPriceMicrosPerMillion: normalizeRuleMicros(
        input.cacheCreationPriceMicrosPerMillion,
        "cacheCreationPriceMicrosPerMillion",
      ),
      cacheReadPriceMicrosPerMillion: normalizeRuleMicros(
        input.cacheReadPriceMicrosPerMillion,
        "cacheReadPriceMicrosPerMillion",
      ),
      topupCurrency,
      topupAmountMicros: normalizeRuleMicros(
        input.topupAmountMicros ?? "1000000",
        "topupAmountMicros",
      ),
      creditAmountMicros: normalizeRuleMicros(
        input.creditAmountMicros ?? "1000000",
        "creditAmountMicros",
      ),
    };
  }

  private async upsertBaseSkuWithClient(
    client: pg.PoolClient,
    input: BillingBaseSkuInput,
  ): Promise<BillingBaseSku> {
    const sku = this.normalizeBaseSkuInput(input);
    const result = await client.query<BillingBaseSkuRow>(
      `INSERT INTO billing_base_skus (
         id, provider, model_vendor, protocol, model, currency, display_name, is_active, supports_prompt_caching,
         input_price_micros_per_million, output_price_micros_per_million,
         cache_creation_price_micros_per_million, cache_read_price_micros_per_million,
         topup_currency, topup_amount_micros, credit_amount_micros
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (protocol, model_vendor, model, currency) DO UPDATE SET
         provider = EXCLUDED.provider,
         display_name = EXCLUDED.display_name,
         is_active = EXCLUDED.is_active,
         supports_prompt_caching = EXCLUDED.supports_prompt_caching,
         input_price_micros_per_million = EXCLUDED.input_price_micros_per_million,
         output_price_micros_per_million = EXCLUDED.output_price_micros_per_million,
         cache_creation_price_micros_per_million = EXCLUDED.cache_creation_price_micros_per_million,
         cache_read_price_micros_per_million = EXCLUDED.cache_read_price_micros_per_million,
         topup_currency = EXCLUDED.topup_currency,
         topup_amount_micros = EXCLUDED.topup_amount_micros,
         credit_amount_micros = EXCLUDED.credit_amount_micros,
         updated_at = NOW()
       RETURNING *`,
      [
        sku.id,
        sku.provider,
        sku.modelVendor,
        sku.protocol,
        sku.model,
        sku.currency,
        sku.displayName,
        sku.isActive,
        sku.supportsPromptCaching,
        sku.inputPriceMicrosPerMillion,
        sku.outputPriceMicrosPerMillion,
        sku.cacheCreationPriceMicrosPerMillion,
        sku.cacheReadPriceMicrosPerMillion,
        sku.topupCurrency,
        sku.topupAmountMicros,
        sku.creditAmountMicros,
      ],
    );
    return toBillingBaseSku(result.rows[0]!);
  }

  async listBaseSkus(): Promise<BillingBaseSku[]> {
    const result = await this.pool.query<BillingBaseSkuRow>(
      `SELECT *
       FROM billing_base_skus
       ORDER BY protocol ASC, model_vendor ASC, model ASC, currency ASC`,
    );
    return result.rows.map(toBillingBaseSku);
  }

  async upsertBaseSku(input: BillingBaseSkuInput): Promise<BillingBaseSku> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sku = await this.upsertBaseSkuWithClient(client, input);
      await client.query("COMMIT");
      return sku;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteBaseSku(skuId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM billing_base_skus WHERE id = $1",
      [skuId],
    );
    return Boolean(result.rowCount);
  }

  private normalizeChannelMultiplierInput(
    input: BillingChannelMultiplierInput,
  ): Omit<BillingChannelMultiplier, "createdAt" | "updatedAt"> {
    const routingGroupId = normalizeRequiredText(input.routingGroupId, {
      field: "routingGroupId",
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    });
    const provider = normalizeBillingModelProvider(input.provider);
    const model = normalizeRequiredText(input.model, {
      field: "model",
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    });
    const modelVendor = normalizeBillingModelVendor(
      input.modelVendor,
      model,
      provider,
    );
    const protocol = normalizeBillingModelProtocol(input.protocol, provider);
    const multiplierMicros = normalizeRuleMicros(
      input.multiplierMicros ?? ONE_MILLION_MICROS,
      "multiplierMicros",
    );
    if (BigInt(multiplierMicros) === 0n) {
      throw new InputValidationError(
        "multiplierMicros must be > 0 (use isActive=false to disable instead)",
      );
    }
    return {
      id: channelMultiplierId(routingGroupId, protocol, modelVendor, model),
      routingGroupId,
      provider,
      modelVendor,
      protocol,
      model,
      multiplierMicros,
      isActive: input.isActive ?? true,
      showInFrontend: input.showInFrontend ?? true,
      allowCalls: input.allowCalls ?? true,
    };
  }

  private async upsertChannelMultiplierWithClient(
    client: pg.PoolClient,
    input: BillingChannelMultiplierInput,
  ): Promise<BillingChannelMultiplier> {
    const m = this.normalizeChannelMultiplierInput(input);
    const result = await client.query<BillingChannelMultiplierRow>(
      `INSERT INTO billing_channel_multipliers (
         id, routing_group_id, provider, model_vendor, protocol, model, multiplier_micros, is_active, show_in_frontend, allow_calls
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         provider = EXCLUDED.provider,
         model_vendor = EXCLUDED.model_vendor,
         protocol = EXCLUDED.protocol,
         model = EXCLUDED.model,
         multiplier_micros = EXCLUDED.multiplier_micros,
         is_active = EXCLUDED.is_active,
         show_in_frontend = EXCLUDED.show_in_frontend,
         allow_calls = EXCLUDED.allow_calls,
         updated_at = NOW()
       RETURNING *`,
      [
        m.id,
        m.routingGroupId,
        m.provider,
        m.modelVendor,
        m.protocol,
        m.model,
        m.multiplierMicros,
        m.isActive,
        m.showInFrontend,
        m.allowCalls,
      ],
    );
    return toBillingChannelMultiplier(result.rows[0]!);
  }

  async listChannelMultipliers(
    routingGroupId?: string | null,
  ): Promise<BillingChannelMultiplier[]> {
    const filter = routingGroupId
      ? normalizeRequiredText(routingGroupId, {
          field: "routingGroupId",
          maxLength: MAX_SCOPE_FIELD_LENGTH,
        })
      : null;
    const result = await this.pool.query<BillingChannelMultiplierRow>(
      `SELECT *
       FROM billing_channel_multipliers
       WHERE ($1::text IS NULL OR routing_group_id = $1)
       ORDER BY routing_group_id ASC, protocol ASC, model_vendor ASC, model ASC`,
      [filter],
    );
    return result.rows.map(toBillingChannelMultiplier);
  }

  async upsertChannelMultiplier(
    input: BillingChannelMultiplierInput,
  ): Promise<BillingChannelMultiplier> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const m = await this.upsertChannelMultiplierWithClient(client, input);
      await client.query("COMMIT");
      return m;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteChannelMultiplier(multiplierId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM billing_channel_multipliers WHERE id = $1",
      [multiplierId],
    );
    return Boolean(result.rowCount);
  }

  async copyMultipliersBetweenGroups(input: {
    fromRoutingGroupId: string;
    toRoutingGroupId: string;
    overwrite?: boolean;
  }): Promise<{ copied: number; skipped: number }> {
    const fromGroup = normalizeRequiredText(input.fromRoutingGroupId, {
      field: "fromRoutingGroupId",
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    });
    const toGroup = normalizeRequiredText(input.toRoutingGroupId, {
      field: "toRoutingGroupId",
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    });
    if (fromGroup === toGroup) {
      throw new InputValidationError(
        "Source and destination routing groups must differ",
      );
    }
    const overwrite = input.overwrite ?? false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sources = await client.query<BillingChannelMultiplierRow>(
        `SELECT * FROM billing_channel_multipliers WHERE routing_group_id = $1`,
        [fromGroup],
      );
      let copied = 0;
      let skipped = 0;
      for (const row of sources.rows) {
        const m = toBillingChannelMultiplier(row);
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM billing_channel_multipliers WHERE routing_group_id = $1 AND protocol = $2 AND model_vendor = $3 AND model = $4`,
          [toGroup, m.protocol, m.modelVendor, m.model],
        );
        if ((existing.rowCount ?? 0) > 0 && !overwrite) {
          skipped += 1;
          continue;
        }
        await this.upsertChannelMultiplierWithClient(client, {
          routingGroupId: toGroup,
          provider: m.provider,
          modelVendor: m.modelVendor,
          protocol: m.protocol,
          model: m.model,
          multiplierMicros: m.multiplierMicros,
          isActive: m.isActive,
          showInFrontend: m.showInFrontend,
          allowCalls: m.allowCalls,
        });
        copied += 1;
      }
      await client.query("COMMIT");
      return { copied, skipped };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async bulkAdjustChannelMultipliers(input: {
    routingGroupId: string;
    multiplierIds?: string[];
    scale?: number;
    setMultiplierMicros?: string | number | bigint;
  }): Promise<{ updated: number }> {
    const groupId = normalizeRequiredText(input.routingGroupId, {
      field: "routingGroupId",
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    });
    const filterIds = (input.multiplierIds ?? []).filter(
      (id) => typeof id === "string" && id.length,
    );
    const setMultiplier =
      input.setMultiplierMicros != null
        ? normalizeRuleMicros(input.setMultiplierMicros, "setMultiplierMicros")
        : null;
    const scale =
      typeof input.scale === "number" && Number.isFinite(input.scale)
        ? input.scale
        : null;
    if (setMultiplier == null && scale == null) {
      throw new InputValidationError(
        "Provide either scale or setMultiplierMicros",
      );
    }
    if (scale != null && scale <= 0) {
      throw new InputValidationError("scale must be > 0");
    }
    if (setMultiplier != null && BigInt(setMultiplier) === 0n) {
      throw new InputValidationError("setMultiplierMicros must be > 0");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const targets = filterIds.length
        ? await client.query<BillingChannelMultiplierRow>(
            `SELECT * FROM billing_channel_multipliers
           WHERE routing_group_id = $1 AND id = ANY($2::text[])`,
            [groupId, filterIds],
          )
        : await client.query<BillingChannelMultiplierRow>(
            `SELECT * FROM billing_channel_multipliers WHERE routing_group_id = $1`,
            [groupId],
          );
      let updated = 0;
      for (const row of targets.rows) {
        const current = toBillingChannelMultiplier(row);
        let nextMicros: string;
        if (setMultiplier != null) {
          nextMicros = setMultiplier;
        } else {
          const cur = BigInt(current.multiplierMicros);
          nextMicros = (
            (cur * BigInt(Math.round(scale! * 1_000_000))) /
            1_000_000n
          ).toString();
          if (BigInt(nextMicros) === 0n) {
            throw new InputValidationError("Resulting multiplier rounds to 0");
          }
        }
        await client.query(
          `UPDATE billing_channel_multipliers
           SET multiplier_micros = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [current.id, nextMicros],
        );
        updated += 1;
      }
      await client.query("COMMIT");
      return { updated };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async findResolvedSkuForUsage(
    candidate: BillingUsageCandidate,
    protocolOverride: BillingModelProtocol | null = null,
  ): Promise<BillingResolvedSku | null> {
    if (!candidate.routingGroupId || !candidate.provider || !candidate.model) {
      return null;
    }
    const protocol =
      protocolOverride ?? protocolForUsageTarget(candidate.target);
    if (!protocol) {
      return null;
    }
    const provider = normalizeUsageProvider(candidate.provider);
    const billingModel = normalizeUsageModelForBilling(
      candidate.model,
      provider,
    );
    if (!billingModel) {
      return null;
    }
    const result = await this.pool.query<BillingResolvedSkuRow>(
      `SELECT
         b.id, b.provider, b.model_vendor, b.protocol, b.model, b.currency, b.display_name, b.is_active, b.supports_prompt_caching,
         b.input_price_micros_per_million, b.output_price_micros_per_million,
         b.cache_creation_price_micros_per_million, b.cache_read_price_micros_per_million,
         b.topup_currency, b.topup_amount_micros, b.credit_amount_micros,
         b.created_at, b.updated_at,
         m.id AS multiplier_id,
         m.routing_group_id,
         m.multiplier_micros,
         m.is_active AS multiplier_active
       FROM billing_channel_multipliers m
       INNER JOIN billing_base_skus b
         ON b.protocol = m.protocol AND b.model_vendor = m.model_vendor AND b.model = m.model AND b.currency = $4
       WHERE m.routing_group_id = $1
         AND m.provider = $2
         AND m.model = $3
         AND m.protocol = $5
         AND m.is_active = true
         AND m.allow_calls = true
         AND b.is_active = true
       LIMIT 1`,
      [
        candidate.routingGroupId,
        provider,
        billingModel,
        candidate.billingCurrency,
        protocol,
      ],
    );
    const row = result.rows[0];
    return row ? toResolvedSku(row) : null;
  }

  async getChannelUsageStats(): Promise<{
    windows: Map<string, ChannelUsageWindowStats>;
    history: Map<string, ChannelUsageHistoryBucket[]>;
    lastVerified: Map<string, ChannelLastVerified>;
  }> {
    const windowQuery = `
      WITH base AS (
        SELECT
          COALESCE(routing_group_id, '') AS routing_group_id,
          status_code,
          duration_ms,
          created_at
        FROM usage_records
        WHERE created_at > NOW() - INTERVAL '24 hours'
          AND attempt_kind = 'final'
          AND (
            split_part(target, '?', 1) IN ('/v1/messages', '/v1/chat/completions', '/v1/responses')
            OR split_part(target, '?', 1) LIKE '/v1/responses/%'
          )
      )
      SELECT
        routing_group_id,
        window_label,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 299)::bigint AS success,
        PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY duration_ms)
          FILTER (WHERE duration_ms IS NOT NULL) AS p50_ms,
        PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY duration_ms)
          FILTER (WHERE duration_ms IS NOT NULL) AS p99_ms
      FROM base
      CROSS JOIN LATERAL (VALUES
        ('5m', NOW() - INTERVAL '5 minutes'),
        ('1h', NOW() - INTERVAL '1 hour'),
        ('24h', NOW() - INTERVAL '24 hours')
      ) AS w(window_label, since)
      WHERE base.created_at > w.since
      GROUP BY routing_group_id, window_label
    `;
    const historyQuery = `
      SELECT
        COALESCE(routing_group_id, '') AS routing_group_id,
        date_trunc('hour', created_at)
          + (date_part('minute', created_at)::int / 5) * INTERVAL '5 minutes' AS bucket_start,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 299)::bigint AS success
      FROM usage_records
      WHERE created_at > NOW() - INTERVAL '5 hours'
        AND attempt_kind = 'final'
        AND (
          split_part(target, '?', 1) IN ('/v1/messages', '/v1/chat/completions', '/v1/responses')
          OR split_part(target, '?', 1) LIKE '/v1/responses/%'
        )
      GROUP BY routing_group_id, bucket_start
      ORDER BY routing_group_id, bucket_start
    `;

    const lastVerifiedQuery = `
      SELECT DISTINCT ON (COALESCE(routing_group_id, ''))
        COALESCE(routing_group_id, '') AS routing_group_id,
        duration_ms,
        created_at
      FROM usage_records
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND attempt_kind = 'final'
        AND status_code BETWEEN 200 AND 299
        AND duration_ms IS NOT NULL
        AND (
          split_part(target, '?', 1) IN ('/v1/messages', '/v1/chat/completions', '/v1/responses')
          OR split_part(target, '?', 1) LIKE '/v1/responses/%'
        )
      ORDER BY COALESCE(routing_group_id, ''), created_at DESC
    `;

    const [windowResult, historyResult, lastVerifiedResult] = await Promise.all(
      [
        this.pool.query<{
          routing_group_id: string;
          window_label: "5m" | "1h" | "24h";
          total: string | number | bigint;
          success: string | number | bigint;
          p50_ms: string | number | null;
          p99_ms: string | number | null;
        }>(windowQuery),
        this.pool.query<{
          routing_group_id: string;
          bucket_start: Date;
          total: string | number | bigint;
          success: string | number | bigint;
        }>(historyQuery),
        this.pool.query<{
          routing_group_id: string;
          duration_ms: number;
          created_at: Date;
        }>(lastVerifiedQuery),
      ],
    );

    const windows = new Map<string, ChannelUsageWindowStats>();
    for (const row of windowResult.rows) {
      const key = row.routing_group_id;
      const entry = windows.get(key) ?? {
        last5m: emptyWindowSnapshot(),
        last1h: emptyWindowSnapshot(),
        last24h: emptyWindowSnapshot(),
      };
      const bucket =
        row.window_label === "5m"
          ? entry.last5m
          : row.window_label === "1h"
            ? entry.last1h
            : entry.last24h;
      bucket.totalRequests = Number(row.total);
      bucket.successRequests = Number(row.success);
      bucket.successRate =
        bucket.totalRequests > 0
          ? bucket.successRequests / bucket.totalRequests
          : null;
      bucket.p50Ms = row.p50_ms == null ? null : Number(row.p50_ms);
      bucket.p99Ms = row.p99_ms == null ? null : Number(row.p99_ms);
      windows.set(key, entry);
    }

    const history = new Map<string, ChannelUsageHistoryBucket[]>();
    for (const row of historyResult.rows) {
      const key = row.routing_group_id;
      const list = history.get(key) ?? [];
      const total = Number(row.total);
      const success = Number(row.success);
      list.push({
        bucketStart: row.bucket_start.toISOString(),
        totalRequests: total,
        successRequests: success,
        successRate: total > 0 ? success / total : null,
      });
      history.set(key, list);
    }

    const lastVerified = new Map<string, ChannelLastVerified>();
    for (const row of lastVerifiedResult.rows) {
      lastVerified.set(row.routing_group_id, {
        durationMs: Number(row.duration_ms),
        atIso: row.created_at.toISOString(),
      });
    }

    return { windows, history, lastVerified };
  }

  async getUserBalanceSummary(
    userId: string,
  ): Promise<BillingBalanceSummary | null> {
    const result = await this.pool.query<{
      user_id: string;
      user_name: string | null;
      billing_mode: string;
      billing_currency: string;
      balance_micros: string | number | bigint;
      total_credited_micros: string | number | bigint;
      total_debited_micros: string | number | bigint;
      last_ledger_at: Date | null;
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
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      userName: row.user_name,
      billingMode: row.billing_mode === "prepaid" ? "prepaid" : "postpaid",
      billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
      balanceMicros: readBigIntString(row.balance_micros),
      totalCreditedMicros: readBigIntString(row.total_credited_micros),
      totalDebitedMicros: readBigIntString(row.total_debited_micros),
      currency: normalizeStoredBillingCurrency(row.billing_currency),
      lastLedgerAt: toIso(row.last_ledger_at),
    };
  }

  async getOrganizationBalanceSummary(
    organizationId: string,
  ): Promise<BillingBalanceSummary | null> {
    const result = await this.pool.query<{
      organization_id: string;
      organization_name: string | null;
      billing_mode: string;
      billing_currency: string;
      balance_micros: string | number | bigint;
      total_credited_micros: string | number | bigint;
      total_debited_micros: string | number | bigint;
      last_ledger_at: Date | null;
    }>(
      `SELECT
         o.id AS organization_id,
         o.name AS organization_name,
         o.billing_mode,
         o.billing_currency,
         o.balance_micros,
         COALESCE(SUM(CASE WHEN l.amount_micros > 0 THEN l.amount_micros ELSE 0 END), 0)::bigint AS total_credited_micros,
         COALESCE(SUM(CASE WHEN l.amount_micros < 0 THEN -l.amount_micros ELSE 0 END), 0)::bigint AS total_debited_micros,
         MAX(l.created_at) AS last_ledger_at
       FROM relay_organizations o
       LEFT JOIN billing_balance_ledger l
         ON l.organization_id = o.id
       WHERE o.id = $1
       GROUP BY o.id, o.name, o.billing_mode, o.billing_currency, o.balance_micros`,
      [organizationId],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: null,
      organizationId: row.organization_id,
      userName: row.organization_name,
      billingMode: row.billing_mode === "prepaid" ? "prepaid" : "postpaid",
      billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
      balanceMicros: readBigIntString(row.balance_micros),
      totalCreditedMicros: readBigIntString(row.total_credited_micros),
      totalDebitedMicros: readBigIntString(row.total_debited_micros),
      currency: normalizeStoredBillingCurrency(row.billing_currency),
      lastLedgerAt: toIso(row.last_ledger_at),
    };
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
    ]);

    return {
      entries: rows.map(toBillingLedgerEntry),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async listOrganizationLedger(
    organizationId: string,
    limit = 100,
    offset = 0,
  ): Promise<{ entries: BillingLedgerEntry[]; total: number }> {
    const cappedLimit = Math.max(1, Math.min(limit, 500));
    const cappedOffset = Math.max(0, offset);
    const [{ rows }, countResult] = await Promise.all([
      this.pool.query<BillingLedgerRow>(
        `SELECT
           l.id,
           l.user_id,
           l.organization_id,
           o.name AS user_name,
           l.kind,
           l.amount_micros,
           l.currency,
           l.note,
           l.usage_record_id,
           l.request_id,
           l.created_at,
           l.updated_at
         FROM billing_balance_ledger l
         LEFT JOIN relay_organizations o ON o.id = l.organization_id
         WHERE l.organization_id = $1
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $2 OFFSET $3`,
        [organizationId, cappedLimit, cappedOffset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::int AS total
         FROM billing_balance_ledger
         WHERE organization_id = $1`,
        [organizationId],
      ),
    ]);

    return {
      entries: rows.map(toBillingLedgerEntry),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async createLedgerEntry(input: {
    userId: string;
    kind: Extract<BillingLedgerKind, "topup" | "manual_adjustment">;
    amountMicros: unknown;
    note?: unknown;
    externalRef?: string | null;
  }): Promise<{
    entry: BillingLedgerEntry;
    balance: BillingBalanceSummary;
    idempotent?: boolean;
  }> {
    const amountMicros = normalizeSignedMicros(input.amountMicros);
    if (input.kind === "topup" && BigInt(amountMicros) <= 0n) {
      throw new InputValidationError("Top-up amount must be positive");
    }
    const note = normalizeOptionalText(input.note, {
      field: "note",
      maxLength: MAX_BILLING_NOTE_LENGTH,
    });
    const externalRef = normalizeOptionalText(input.externalRef ?? null, {
      field: "externalRef",
      maxLength: 200,
    });

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
      );
      if (existing.rows.length) {
        assertLedgerIdempotencyMatch(existing.rows[0], {
          userId: input.userId,
          organizationId: null,
          kind: input.kind,
          amountMicros,
        });
        const existingOwnerId = existing.rows[0].user_id;
        if (!existingOwnerId) {
          throw new Error("Existing ledger entry has no user owner");
        }
        const balance = await this.getUserBalanceSummary(existingOwnerId);
        if (!balance) {
          throw new Error("User balance not found for existing ledger entry");
        }
        return {
          entry: toBillingLedgerEntry(existing.rows[0]),
          balance,
          idempotent: true,
        };
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const userResult = await client.query<{
        id: string;
        name: string;
        billing_currency: string;
      }>(
        `SELECT id, name, billing_currency
         FROM relay_users
         WHERE id = $1
         FOR UPDATE`,
        [input.userId],
      );
      const userRow = userResult.rows[0];
      if (!userRow) {
        throw new Error("User not found");
      }
      const billingCurrency = normalizeStoredBillingCurrency(
        userRow.billing_currency,
      );

      const entryId = crypto.randomUUID();
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
      );
      await client.query(
        `UPDATE relay_users
         SET balance_micros = balance_micros + $1::bigint,
             updated_at = NOW()
         WHERE id = $2`,
        [amountMicros, input.userId],
      );

      await client.query("COMMIT");

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
      ]);

      if (!balance) {
        throw new Error("User balance not found after ledger insert");
      }

      return {
        entry: toBillingLedgerEntry(ledger.rows[0]!),
        balance,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createOrganizationLedgerEntry(input: {
    organizationId: string;
    kind: Extract<BillingLedgerKind, "topup" | "manual_adjustment">;
    amountMicros: unknown;
    note?: unknown;
    externalRef?: string | null;
  }): Promise<{
    entry: BillingLedgerEntry;
    balance: BillingBalanceSummary;
    idempotent?: boolean;
  }> {
    const amountMicros = normalizeSignedMicros(input.amountMicros);
    if (input.kind === "topup" && BigInt(amountMicros) <= 0n) {
      throw new InputValidationError("Top-up amount must be positive");
    }
    const note = normalizeOptionalText(input.note, {
      field: "note",
      maxLength: MAX_BILLING_NOTE_LENGTH,
    });
    const externalRef = normalizeOptionalText(input.externalRef ?? null, {
      field: "externalRef",
      maxLength: 200,
    });

    if (externalRef) {
      const existing = await this.pool.query<BillingLedgerRow>(
        `SELECT l.*, o.name AS user_name
         FROM billing_balance_ledger l
         LEFT JOIN relay_organizations o ON o.id = l.organization_id
         WHERE l.external_ref = $1`,
        [externalRef],
      );
      if (existing.rows.length) {
        assertLedgerIdempotencyMatch(existing.rows[0], {
          userId: null,
          organizationId: input.organizationId,
          kind: input.kind,
          amountMicros,
        });
        const existingOrganizationId = existing.rows[0].organization_id;
        const existingUserId = existing.rows[0].user_id;
        const balance = existingOrganizationId
          ? await this.getOrganizationBalanceSummary(existingOrganizationId)
          : existingUserId
            ? await this.getUserBalanceSummary(existingUserId)
            : null;
        if (!balance)
          throw new Error("Balance not found for existing ledger entry");
        return {
          entry: toBillingLedgerEntry(existing.rows[0]),
          balance,
          idempotent: true,
        };
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orgResult = await client.query<{
        id: string;
        name: string;
        billing_currency: string;
      }>(
        `SELECT id, name, billing_currency FROM relay_organizations WHERE id = $1 FOR UPDATE`,
        [input.organizationId],
      );
      const orgRow = orgResult.rows[0];
      if (!orgRow) throw new Error("Organization not found");
      const billingCurrency = normalizeStoredBillingCurrency(
        orgRow.billing_currency,
      );
      const entryId = crypto.randomUUID();
      await client.query(
        `INSERT INTO billing_balance_ledger (
          id, user_id, organization_id, kind, amount_micros, currency, note, external_ref
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entryId,
          null,
          input.organizationId,
          input.kind,
          amountMicros,
          billingCurrency,
          note,
          externalRef,
        ],
      );
      await client.query(
        `UPDATE relay_organizations SET balance_micros = balance_micros + $1::bigint, updated_at = NOW() WHERE id = $2`,
        [amountMicros, input.organizationId],
      );
      await client.query("COMMIT");

      const [balance, ledger] = await Promise.all([
        this.getOrganizationBalanceSummary(input.organizationId),
        this.pool.query<BillingLedgerRow>(
          `SELECT l.*, o.name AS user_name
           FROM billing_balance_ledger l
           LEFT JOIN relay_organizations o ON o.id = l.organization_id
           WHERE l.id = $1`,
          [entryId],
        ),
      ]);
      if (!balance || !ledger.rows[0])
        throw new Error("Failed to load created organization ledger entry");
      return { entry: toBillingLedgerEntry(ledger.rows[0]), balance };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async findLedgerByExternalRef(externalRef: string): Promise<{
    entry: BillingLedgerExternalRefEntry | null;
    multipleMatches: boolean;
  }> {
    const result = await this.pool.query<{
      id: string;
      user_id: string | null;
      organization_id: string | null;
      kind: BillingLedgerKind;
      amount_micros: string | number | bigint;
      currency: string;
      note: string | null;
      external_ref: string;
      created_at: Date;
    }>(
      `SELECT id, user_id, organization_id, kind, amount_micros, currency, note, external_ref, created_at
       FROM billing_balance_ledger
       WHERE external_ref = $1
       ORDER BY created_at DESC
       LIMIT 2`,
      [externalRef],
    );
    if (result.rows.length === 0) {
      return { entry: null, multipleMatches: false };
    }
    const row = result.rows[0]!;
    return {
      entry: {
        id: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        kind: row.kind,
        amountMicros: readBigIntString(row.amount_micros),
        currency: normalizeStoredBillingCurrency(row.currency),
        note: row.note,
        externalRef: row.external_ref,
        createdAt: row.created_at.toISOString(),
      },
      multipleMatches: result.rows.length > 1,
    };
  }

  async createTopupOrder(input: {
    userId?: string | null;
    organizationId?: string | null;
    amountMicros: unknown;
    currency: unknown;
    creditAmountMicros?: unknown;
    paymentProvider: unknown;
    externalRef?: unknown;
    note?: unknown;
  }): Promise<BillingTopupOrder> {
    const userId = input.userId ?? null;
    const organizationId = input.organizationId ?? null;
    if ((userId === null) === (organizationId === null)) {
      throw new InputValidationError("Exactly one top-up order owner is required");
    }
    const amountMicros = normalizeUnsignedBigIntString(input.amountMicros, {
      field: "amountMicros",
      allowZero: false,
    });
    const creditAmountMicros = normalizeUnsignedBigIntString(
      input.creditAmountMicros ?? input.amountMicros,
      { field: "creditAmountMicros", allowZero: false },
    );
    const currency = normalizeBillingCurrency(input.currency, {
      field: "currency",
    });
    const paymentProvider = normalizeRequiredText(input.paymentProvider, {
      field: "paymentProvider",
      maxLength: MAX_SCOPE_FIELD_LENGTH,
    });
    const externalRef = normalizeOptionalText(input.externalRef ?? null, {
      field: "externalRef",
      maxLength: 200,
    });
    const note = normalizeOptionalText(input.note ?? null, {
      field: "note",
      maxLength: MAX_BILLING_NOTE_LENGTH,
    });

    const id = crypto.randomUUID();
    const result = await this.pool.query<BillingTopupOrderRow>(
      `INSERT INTO billing_topup_orders (
        id, user_id, organization_id, amount_micros, currency, credit_amount_micros,
        status, payment_provider, external_ref, note
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
      RETURNING *`,
      [
        id,
        userId,
        organizationId,
        amountMicros,
        currency,
        creditAmountMicros,
        paymentProvider,
        externalRef,
        note,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create top-up order");
    }
    return toBillingTopupOrder(row);
  }

  async confirmTopupOrder(orderId: string): Promise<{
    order: BillingTopupOrder;
    ledger: BillingLedgerEntry;
    balance: BillingBalanceSummary;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<BillingTopupOrderRow>(
        `SELECT * FROM billing_topup_orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = orderResult.rows[0];
      if (!order) {
        throw new Error("Top-up order not found");
      }
      if (order.status !== "pending") {
        throw new Error(`Top-up order is not pending: ${order.status}`);
      }

      const ledgerId = crypto.randomUUID();
      await client.query(
        `INSERT INTO billing_balance_ledger (
          id, user_id, organization_id, kind, amount_micros, currency, note, external_ref
        ) VALUES ($1, $2, $3, 'topup', $4, $5, $6, $7)`,
        [
          ledgerId,
          order.user_id,
          order.organization_id,
          readBigIntString(order.credit_amount_micros),
          normalizeStoredBillingCurrency(order.currency),
          order.note,
          `topup_order:${order.id}`,
        ],
      );
      if (order.user_id) {
        await client.query(
          `UPDATE relay_users
           SET balance_micros = balance_micros + $1::bigint,
               billing_mode = 'prepaid',
               billing_currency = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [readBigIntString(order.credit_amount_micros), normalizeStoredBillingCurrency(order.currency), order.user_id],
        );
      } else if (order.organization_id) {
        await client.query(
          `UPDATE relay_organizations
           SET balance_micros = balance_micros + $1::bigint,
               billing_mode = 'prepaid',
               billing_currency = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [readBigIntString(order.credit_amount_micros), normalizeStoredBillingCurrency(order.currency), order.organization_id],
        );
      } else {
        throw new Error("Top-up order has no owner");
      }
      await client.query(
        `UPDATE billing_topup_orders
         SET status = 'confirmed', ledger_entry_id = $2, confirmed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [order.id, ledgerId],
      );
      await client.query("COMMIT");

      const [confirmedOrder, ledgerResult, balance] = await Promise.all([
        this.pool.query<BillingTopupOrderRow>(`SELECT * FROM billing_topup_orders WHERE id = $1`, [order.id]),
        this.pool.query<BillingLedgerRow>(
          `SELECT l.*, COALESCE(u.name, o.name) AS user_name
           FROM billing_balance_ledger l
           LEFT JOIN relay_users u ON u.id = l.user_id
           LEFT JOIN relay_organizations o ON o.id = l.organization_id
           WHERE l.id = $1`,
          [ledgerId],
        ),
        order.user_id
          ? this.getUserBalanceSummary(order.user_id)
          : this.getOrganizationBalanceSummary(order.organization_id!),
      ]);
      if (!confirmedOrder.rows[0] || !ledgerResult.rows[0] || !balance) {
        throw new Error("Failed to load confirmed top-up order result");
      }
      return {
        order: toBillingTopupOrder(confirmedOrder.rows[0]),
        ledger: toBillingLedgerEntry(ledgerResult.rows[0]),
        balance,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async assertUserCanConsume(userId: string): Promise<void> {
    const result = await this.pool.query<{
      billing_mode: string;
      balance_micros: string | number | bigint;
      credit_limit_micros: string | number | bigint;
      name: string | null;
    }>(
      `SELECT billing_mode, balance_micros, credit_limit_micros, name
       FROM relay_users
       WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      return;
    }

    const balanceMicros = BigInt(readBigIntString(row.balance_micros));
    if (row.billing_mode === "postpaid") {
      const creditLimitMicros = BigInt(
        readBigIntString(row.credit_limit_micros),
      );
      if (balanceMicros > -creditLimitMicros) {
        return;
      }
      const displayName = sanitizeErrorMessage(
        normalizeNullable(row.name) ?? userId,
        userId,
      );
      throw new Error(
        `Postpaid credit limit exhausted for ${displayName}. Please increase credit limit or top up.`,
      );
    }

    if (balanceMicros > 0n) {
      return;
    }

    const displayName = sanitizeErrorMessage(
      normalizeNullable(row.name) ?? userId,
      userId,
    );
    throw new Error(
      `Prepaid balance exhausted for ${displayName}. Please top up and retry.`,
    );
  }

  async assertOrganizationCanConsume(organizationId: string): Promise<void> {
    const result = await this.pool.query<{
      billing_mode: string;
      balance_micros: string | number | bigint;
      credit_limit_micros: string | number | bigint;
      name: string | null;
    }>(
      `SELECT billing_mode, balance_micros, credit_limit_micros, name
       FROM relay_organizations
       WHERE id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) return;
    const balanceMicros = BigInt(readBigIntString(row.balance_micros));
    if (row.billing_mode === "postpaid") {
      const creditLimitMicros = BigInt(
        readBigIntString(row.credit_limit_micros),
      );
      if (balanceMicros > -creditLimitMicros) return;
      const displayName = sanitizeErrorMessage(
        normalizeNullable(row.name) ?? organizationId,
        organizationId,
      );
      throw new Error(
        `Postpaid credit limit exhausted for ${displayName}. Please increase credit limit or top up.`,
      );
    }
    if (balanceMicros > 0n) return;
    const displayName = sanitizeErrorMessage(
      normalizeNullable(row.name) ?? organizationId,
      organizationId,
    );
    throw new Error(
      `Prepaid balance exhausted for ${displayName}. Please top up and retry.`,
    );
  }

  /**
   * Atomically validate and apply a `billing_currency` change for a relay user.
   *
   * Wraps SELECT … FOR UPDATE + UPDATE in a single transaction so the balance
   * and ledger/billed-history checks cannot race against ledger writes.
   *
   * Returns whether the row was actually updated. A no-op (currency unchanged
   * or row missing) returns `{ updated: false }` and does not raise.
   */
  async changeUserBillingCurrency(
    userId: string,
    nextCurrency: BillingCurrency,
  ): Promise<{ updated: boolean }> {
    return this.changeBillingCurrencyInTx({
      table: "relay_users",
      ownerColumn: "user_id",
      ownerId: userId,
      nextCurrency,
    });
  }

  /**
   * Atomically validate and apply a `billing_currency` change for a relay
   * organization. See {@link changeUserBillingCurrency}.
   */
  async changeOrganizationBillingCurrency(
    organizationId: string,
    nextCurrency: BillingCurrency,
  ): Promise<{ updated: boolean }> {
    return this.changeBillingCurrencyInTx({
      table: "relay_organizations",
      ownerColumn: "organization_id",
      ownerId: organizationId,
      nextCurrency,
    });
  }

  private async changeBillingCurrencyInTx(args: {
    table: "relay_users" | "relay_organizations";
    ownerColumn: "user_id" | "organization_id";
    ownerId: string;
    nextCurrency: BillingCurrency;
  }): Promise<{ updated: boolean }> {
    const normalizedCurrency = normalizeBillingCurrency(args.nextCurrency, {
      field: "billingCurrency",
      fallback: DEFAULT_BILLING_CURRENCY,
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        billing_currency: string;
        balance_micros: string | number | bigint;
      }>(
        `SELECT billing_currency, balance_micros
         FROM ${args.table}
         WHERE id = $1
         FOR UPDATE`,
        [args.ownerId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { updated: false };
      }
      const currentCurrency = normalizeStoredBillingCurrency(
        row.billing_currency,
      );
      if (currentCurrency === normalizedCurrency) {
        await client.query("ROLLBACK");
        return { updated: false };
      }
      if (BigInt(readBigIntString(row.balance_micros)) !== 0n) {
        throw new InputValidationError(
          "Cannot change billingCurrency while balance is non-zero",
        );
      }
      const ledgerProbe = await client.query(
        `SELECT 1
         FROM billing_balance_ledger
         WHERE ${args.ownerColumn} = $1
         LIMIT 1`,
        [args.ownerId],
      );
      if (ledgerProbe.rows.length > 0) {
        throw new InputValidationError(
          "Cannot change billingCurrency after billing history exists",
        );
      }
      const billedProbe = await client.query(
        `SELECT 1
         FROM billing_line_items
         WHERE ${args.ownerColumn} = $1
           AND status = 'billed'
         LIMIT 1`,
        [args.ownerId],
      );
      if (billedProbe.rows.length > 0) {
        throw new InputValidationError(
          "Cannot change billingCurrency after billing history exists",
        );
      }
      await client.query(
        `UPDATE ${args.table}
         SET billing_currency = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [args.ownerId, normalizedCurrency],
      );
      await client.query("COMMIT");
      return { updated: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async preflightBillableRequest(
    input: BillingPreflightInput,
  ): Promise<BillingPreflightResult> {
    const inputTokens = Math.max(
      1,
      Math.floor(input.estimatedInputTokens ?? 1),
    );
    const outputTokens = Math.max(
      0,
      Math.floor(input.estimatedOutputTokens ?? 0),
    );
    const candidate: BillingUsageCandidate = {
      usageRecordId: 0,
      requestId: "preflight",
      userId: input.userId,
      organizationId: input.organizationId ?? null,
      userName: null,
      billingCurrency: input.billingCurrency,
      accountId: input.accountId,
      provider: normalizeUsageProvider(input.provider),
      model: input.model,
      routingGroupId: input.routingGroupId,
      sessionKey: null,
      clientDeviceId: null,
      target: input.target,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      statusCode: 200,
      createdAt: new Date().toISOString(),
    };
    const resolvedSku = await this.findResolvedSkuForUsage(
      candidate,
      input.protocolOverride ?? null,
    );
    const resolved = resolveBillingLineItem(candidate, resolvedSku);
    if (resolved.status !== "billed") {
      return { ok: false, status: "missing_sku" };
    }
    if (BigInt(resolved.amountMicros) <= 0n) {
      return { ok: false, status: "zero_price" };
    }
    if (!input.organizationId && !input.userId) {
      // No owner to charge against. Higher layers should never reach here for
      // billable paths, but be permissive to avoid blocking unrelated routes.
      return {
        ok: true,
        status: "billed",
        estimatedAmountMicros: resolved.amountMicros,
        currency: resolved.currency,
      };
    }
    const availableMicros = input.organizationId
      ? await this.getOrganizationAvailableMicros(input.organizationId)
      : await this.getUserAvailableMicros(input.userId as string);
    if (availableMicros < BigInt(resolved.amountMicros)) {
      return {
        ok: false,
        status: "insufficient_balance",
        estimatedAmountMicros: resolved.amountMicros,
        availableMicros: availableMicros.toString(),
        currency: resolved.currency,
      };
    }
    return {
      ok: true,
      status: "billed",
      estimatedAmountMicros: resolved.amountMicros,
      availableMicros: availableMicros.toString(),
      currency: resolved.currency,
    };
  }

  /**
   * Compute available spend for a relay user, in micros.
   *
   * Returns 0 (fail-closed) when the row is missing — at this point the API
   * key has already been resolved to a userId, so a missing row indicates a
   * deleted user and the request must be rejected, not silently allowed.
   */
  private async getUserAvailableMicros(userId: string): Promise<bigint> {
    const result = await this.pool.query<{
      billing_mode: string;
      balance_micros: string | number | bigint;
      credit_limit_micros: string | number | bigint;
    }>(
      `SELECT billing_mode, balance_micros, credit_limit_micros
       FROM relay_users
       WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return 0n;
    const balanceMicros = BigInt(readBigIntString(row.balance_micros));
    if (row.billing_mode === "postpaid") {
      return balanceMicros + BigInt(readBigIntString(row.credit_limit_micros));
    }
    return balanceMicros;
  }

  /** Same as {@link getUserAvailableMicros}, scoped to an organization. */
  private async getOrganizationAvailableMicros(
    organizationId: string,
  ): Promise<bigint> {
    const result = await this.pool.query<{
      billing_mode: string;
      balance_micros: string | number | bigint;
      credit_limit_micros: string | number | bigint;
    }>(
      `SELECT billing_mode, balance_micros, credit_limit_micros
       FROM relay_organizations
       WHERE id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) return 0n;
    const balanceMicros = BigInt(readBigIntString(row.balance_micros));
    if (row.billing_mode === "postpaid") {
      return balanceMicros + BigInt(readBigIntString(row.credit_limit_micros));
    }
    return balanceMicros;
  }

  async syncLineItems(options?: {
    reconcileMissing?: boolean;
  }): Promise<BillingSyncResult> {
    const result: BillingSyncResult = {
      processedRequests: 0,
      billedRequests: 0,
      missingSkuRequests: 0,
      invalidUsageRequests: 0,
    };

    let lastUsageId = await this.getLastUsageRecordId();
    while (true) {
      const batch = await this.loadUsageCandidatesAfterId(lastUsageId, 250);
      if (!batch.length) {
        break;
      }

      await this.upsertCandidates(batch, result);
      lastUsageId = batch[batch.length - 1]!.usageRecordId;
      await this.setLastUsageRecordId(lastUsageId);
    }

    if (options?.reconcileMissing) {
      let lastMissingUsageId = 0;
      while (true) {
        const pending = await this.loadCandidatesForStatus(
          "missing_sku",
          lastMissingUsageId,
          500,
        );
        if (!pending.length) {
          break;
        }

        await this.upsertCandidates(pending, result);
        lastMissingUsageId = pending[pending.length - 1]!.usageRecordId;
      }
    }

    return result;
  }

  async syncUsageRecordById(usageRecordId: number): Promise<void> {
    const normalizedUsageRecordId = Math.max(0, Math.floor(usageRecordId));
    if (!normalizedUsageRecordId) {
      return;
    }

    const candidate = await this.loadUsageCandidateById(
      normalizedUsageRecordId,
    );
    if (!candidate) {
      return;
    }

    const result: BillingSyncResult = {
      processedRequests: 0,
      billedRequests: 0,
      missingSkuRequests: 0,
      invalidUsageRequests: 0,
    };
    await this.upsertCandidates([candidate], result);
  }

  async rebuildLineItems(): Promise<BillingSyncResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.revertUsageDebitLedgerEntries(client);
      await client.query("DELETE FROM billing_line_items");
      await client.query(
        `INSERT INTO billing_meta (key, value, updated_at)
         VALUES ('last_usage_record_id', '0', NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return this.syncLineItems();
  }

  async getSummary(
    since: Date | null,
    currency?: BillingCurrency | null,
  ): Promise<BillingSummary> {
    const sinceDate = normalizeSince(since);
    const normalizedCurrency = normalizeBillingCurrency(
      currency ?? DEFAULT_BILLING_CURRENCY,
      { field: "currency", fallback: DEFAULT_BILLING_CURRENCY },
    );
    await this.syncLineItems();
    const [aggregateResult, activeSkusResult] = await Promise.all([
      this.pool.query<AggregateRow>(
        `SELECT
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
         FROM billing_base_skus
         WHERE is_active = true
           AND currency = $1`,
        [normalizedCurrency],
      ),
    ]);

    const row = aggregateResult.rows[0] ?? {
      total_requests: 0,
      billed_requests: 0,
      missing_sku_requests: 0,
      invalid_usage_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_amount_micros: 0,
      unique_users: 0,
      last_active_at: null,
    };

    return {
      currency: normalizedCurrency,
      totalRequests: Number(row.total_requests ?? 0),
      billedRequests: Number(row.billed_requests ?? 0),
      missingSkuRequests: Number(row.missing_sku_requests ?? 0),
      invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
      totalInputTokens: readInt(row.total_input_tokens),
      totalOutputTokens: readInt(row.total_output_tokens),
      totalCacheCreationTokens: readInt(row.total_cache_creation_tokens),
      totalCacheReadTokens: readInt(row.total_cache_read_tokens),
      totalAmountMicros: readBigIntString(row.total_amount_micros),
      uniqueUsers: Number(row.unique_users ?? 0),
      activeSkus: Number(activeSkusResult.rows[0]?.count ?? 0),
      period: {
        from: sinceDate.toISOString(),
        to: row.last_active_at
          ? new Date(row.last_active_at).toISOString()
          : new Date().toISOString(),
      },
    };
  }

  async getUserBilling(
    since: Date | null,
    currency?: BillingCurrency | null,
  ): Promise<BillingUserRow[]> {
    const sinceDate = normalizeSince(since);
    const normalizedCurrency = normalizeBillingCurrency(
      currency ?? DEFAULT_BILLING_CURRENCY,
      { field: "currency", fallback: DEFAULT_BILLING_CURRENCY },
    );
    await this.syncLineItems();
    const result = await this.pool.query<{
      user_id: string;
      user_name: string | null;
      currency: string;
      total_requests: number;
      billed_requests: number;
      missing_sku_requests: number;
      invalid_usage_requests: number;
      total_input_tokens: string | number | bigint;
      total_output_tokens: string | number | bigint;
      total_cache_creation_tokens: string | number | bigint;
      total_cache_read_tokens: string | number | bigint;
      total_amount_micros: string | number | bigint;
      last_active_at: Date | null;
    }>(
      `SELECT
         user_id,
         MAX(user_name) AS user_name,
         MAX(currency) AS currency,
         COUNT(*)::int AS total_requests,
         COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
         COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
    );

    return result.rows.map((row) => ({
      userId: row.user_id,
      userName: row.user_name,
      currency: normalizeStoredBillingCurrency(row.currency),
      totalRequests: Number(row.total_requests ?? 0),
      billedRequests: Number(row.billed_requests ?? 0),
      missingSkuRequests: Number(row.missing_sku_requests ?? 0),
      invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
      totalInputTokens: readInt(row.total_input_tokens),
      totalOutputTokens: readInt(row.total_output_tokens),
      totalCacheCreationTokens: readInt(row.total_cache_creation_tokens),
      totalCacheReadTokens: readInt(row.total_cache_read_tokens),
      totalAmountMicros: readBigIntString(row.total_amount_micros),
      lastActiveAt: toIso(row.last_active_at),
    }));
  }

  async getUserDetail(
    userId: string,
    since: Date | null,
  ): Promise<BillingUserDetail | null> {
    const sinceDate = normalizeSince(since);
    await this.syncLineItems();

    const [totalResult, byPeriodResult, byModelResult] = await Promise.all([
      this.pool.query<AggregateRow>(
        `SELECT
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
        period_start: Date;
        total_requests: number;
        billed_requests: number;
        missing_sku_requests: number;
        invalid_usage_requests: number;
        total_input_tokens: string | number | bigint;
        total_output_tokens: string | number | bigint;
        total_amount_micros: string | number | bigint;
      }>(
        `SELECT
           date_trunc('month', usage_created_at) AS period_start,
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
        model: string | null;
        total_requests: number;
        billed_requests: number;
        missing_sku_requests: number;
        invalid_usage_requests: number;
        total_input_tokens: string | number | bigint;
        total_output_tokens: string | number | bigint;
        total_amount_micros: string | number | bigint;
      }>(
        `SELECT
           model,
           COUNT(*)::int AS total_requests,
           COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
           COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
    ]);

    const total = totalResult.rows[0];
    if (!total || Number(total.total_requests ?? 0) === 0) {
      return null;
    }

    return {
      userId,
      userName:
        (total as AggregateRow & { user_name?: string | null }).user_name ??
        null,
      currency: normalizeStoredBillingCurrency(
        (total as AggregateRow & { currency?: string | null }).currency,
      ),
      totalRequests: Number(total.total_requests ?? 0),
      billedRequests: Number(total.billed_requests ?? 0),
      missingSkuRequests: Number(total.missing_sku_requests ?? 0),
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
        missingSkuRequests: Number(row.missing_sku_requests ?? 0),
        invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
        totalInputTokens: readInt(row.total_input_tokens),
        totalOutputTokens: readInt(row.total_output_tokens),
        totalAmountMicros: readBigIntString(row.total_amount_micros),
      })),
      byModel: byModelResult.rows.map((row) => ({
        model: normalizeNullable(row.model) ?? "(unknown)",
        totalRequests: Number(row.total_requests ?? 0),
        billedRequests: Number(row.billed_requests ?? 0),
        missingSkuRequests: Number(row.missing_sku_requests ?? 0),
        invalidUsageRequests: Number(row.invalid_usage_requests ?? 0),
        totalInputTokens: readInt(row.total_input_tokens),
        totalOutputTokens: readInt(row.total_output_tokens),
        totalAmountMicros: readBigIntString(row.total_amount_micros),
      })),
    };
  }

  async getUserLineItems(
    userId: string,
    since: Date | null,
    limit = 100,
    offset = 0,
  ): Promise<{ items: BillingLineItemRow[]; total: number }> {
    const sinceDate = normalizeSince(since);
    await this.syncLineItems();
    const [{ rows }, countResult] = await Promise.all([
      this.pool.query<{
        usage_record_id: number;
        request_id: string;
        currency: string;
        status: "billed" | "missing_sku" | "invalid_usage";
        account_id: string | null;
        provider: string | null;
        model: string | null;
        routing_group_id: string | null;
        target: string;
        session_key: string | null;
        client_device_id: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        amount_micros: string | number | bigint;
        usage_created_at: Date;
      }>(
        `SELECT
           usage_record_id, request_id, currency, status,
           account_id, provider, model, routing_group_id, target, session_key, client_device_id,
           input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
           amount_micros, usage_created_at
         FROM billing_line_items
         WHERE user_id = $1
           AND usage_created_at >= $2
         ORDER BY usage_created_at DESC
         LIMIT $3 OFFSET $4`,
        [
          userId,
          sinceDate,
          Math.max(1, Math.min(limit, 500)),
          Math.max(0, offset),
        ],
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::int AS total
         FROM billing_line_items
         WHERE user_id = $1
           AND usage_created_at >= $2`,
        [userId, sinceDate],
      ),
    ]);

    return {
      items: rows.map((row) => ({
        usageRecordId: Number(row.usage_record_id),
        requestId: row.request_id,
        currency: normalizeStoredBillingCurrency(row.currency),
        status: row.status,
        accountId: row.account_id,
        provider: normalizeUsageProvider(row.provider),
        model: row.model,
        routingGroupId: row.routing_group_id ?? null,
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
    };
  }

  async getUserUsageSnapshot(
    userId: string,
    since: Date | null,
    limit = 50,
    offset = 0,
  ): Promise<BillingUserUsageSnapshot> {
    const sinceDate = normalizeSince(since);
    const cappedLimit = Math.max(1, Math.min(limit, 200));
    const cappedOffset = Math.max(0, offset);
    await this.syncLineItems();

    const [totalResult, byDayResult, byModelResult, itemsResult, countResult] =
      await Promise.all([
        this.pool.query<
          AggregateRow & { user_name?: string | null; currency?: string | null }
        >(
          `SELECT
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
             COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
          period_start: Date;
          total_requests: number;
          billed_requests: number;
          total_input_tokens: string | number | bigint;
          total_output_tokens: string | number | bigint;
          total_cache_creation_tokens: string | number | bigint;
          total_cache_read_tokens: string | number | bigint;
          total_amount_micros: string | number | bigint;
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
          model: string | null;
          total_requests: number;
          billed_requests: number;
          missing_sku_requests: number;
          invalid_usage_requests: number;
          total_input_tokens: string | number | bigint;
          total_output_tokens: string | number | bigint;
          total_amount_micros: string | number | bigint;
        }>(
          `SELECT
             model,
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
             COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
          usage_record_id: number;
          request_id: string;
          currency: string;
          status: "billed" | "missing_sku" | "invalid_usage";
          account_id: string | null;
          provider: string | null;
          model: string | null;
          routing_group_id: string | null;
          target: string;
          session_key: string | null;
          client_device_id: string | null;
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          amount_micros: string | number | bigint;
          usage_created_at: Date;
        }>(
          `SELECT
             usage_record_id, request_id, currency, status,
             account_id, provider, model, routing_group_id, target, session_key, client_device_id,
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
      ]);

    const total = totalResult.rows[0];
    const totalRequests = Number(total?.total_requests ?? 0);

    return {
      userId,
      currency: total?.currency
        ? normalizeStoredBillingCurrency(total.currency)
        : null,
      totalRequests,
      billedRequests: Number(total?.billed_requests ?? 0),
      missingSkuRequests: Number(total?.missing_sku_requests ?? 0),
      invalidUsageRequests: Number(total?.invalid_usage_requests ?? 0),
      totalInputTokens: total ? readInt(total.total_input_tokens) : 0,
      totalOutputTokens: total ? readInt(total.total_output_tokens) : 0,
      totalCacheCreationTokens: total
        ? readInt(total.total_cache_creation_tokens)
        : 0,
      totalCacheReadTokens: total ? readInt(total.total_cache_read_tokens) : 0,
      totalAmountMicros: total
        ? readBigIntString(total.total_amount_micros)
        : "0",
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
        model: normalizeNullable(row.model) ?? "(unknown)",
        totalRequests: Number(row.total_requests ?? 0),
        billedRequests: Number(row.billed_requests ?? 0),
        missingSkuRequests: Number(row.missing_sku_requests ?? 0),
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
        accountId: row.account_id,
        provider: row.provider,
        model: row.model,
        routingGroupId: row.routing_group_id ?? null,
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
    };
  }

  async getOrganizationUsageSnapshot(
    organizationId: string,
    since: Date | null,
    limit = 50,
    offset = 0,
  ): Promise<BillingUserUsageSnapshot> {
    return this.getWorkspaceUsageSnapshot({ organizationId, legacyUserId: null }, since, limit, offset);
  }

  async getPersonalWorkspaceUsageSnapshot(
    organizationId: string,
    legacyUserId: string | null,
    since: Date | null,
    limit = 50,
    offset = 0,
  ): Promise<BillingUserUsageSnapshot> {
    return this.getWorkspaceUsageSnapshot({ organizationId, legacyUserId }, since, limit, offset);
  }

  private async getWorkspaceUsageSnapshot(
    owner: { organizationId: string; legacyUserId: string | null },
    since: Date | null,
    limit = 50,
    offset = 0,
  ): Promise<BillingUserUsageSnapshot> {
    const sinceDate = normalizeSince(since);
    const cappedLimit = Math.max(1, Math.min(limit, 200));
    const cappedOffset = Math.max(0, offset);
    await this.syncLineItems();
    const ownerFilter = owner.legacyUserId
      ? `((organization_id = $1) OR (user_id = $2))`
      : `organization_id = $1`;
    const sinceParamIndex = owner.legacyUserId ? 3 : 2;
    const baseParams = owner.legacyUserId
      ? [owner.organizationId, owner.legacyUserId, sinceDate]
      : [owner.organizationId, sinceDate];
    const limitParamIndex = sinceParamIndex + 1;
    const offsetParamIndex = sinceParamIndex + 2;

    const [totalResult, byDayResult, byModelResult, itemsResult, countResult] =
      await Promise.all([
        this.pool.query<
          AggregateRow & { user_name?: string | null; currency?: string | null }
        >(
          `SELECT
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
             COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
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
           WHERE ${ownerFilter}
             AND usage_created_at >= $${sinceParamIndex}`,
          baseParams,
        ),
        this.pool.query<{
          period_start: Date;
          total_requests: number;
          billed_requests: number;
          total_input_tokens: string | number | bigint;
          total_output_tokens: string | number | bigint;
          total_cache_creation_tokens: string | number | bigint;
          total_cache_read_tokens: string | number | bigint;
          total_amount_micros: string | number | bigint;
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
           WHERE ${ownerFilter}
             AND usage_created_at >= $${sinceParamIndex}
           GROUP BY date_trunc('day', usage_created_at)
           ORDER BY period_start DESC
           LIMIT 90`,
          baseParams,
        ),
        this.pool.query<{
          model: string | null;
          total_requests: number;
          billed_requests: number;
          missing_sku_requests: number;
          invalid_usage_requests: number;
          total_input_tokens: string | number | bigint;
          total_output_tokens: string | number | bigint;
          total_amount_micros: string | number | bigint;
        }>(
          `SELECT
             model,
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE status = 'billed')::int AS billed_requests,
             COUNT(*) FILTER (WHERE status = 'missing_sku')::int AS missing_sku_requests,
             COUNT(*) FILTER (WHERE status = 'invalid_usage')::int AS invalid_usage_requests,
             COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens,
             COALESCE(SUM(amount_micros), 0)::bigint AS total_amount_micros
           FROM billing_line_items
           WHERE ${ownerFilter}
             AND usage_created_at >= $${sinceParamIndex}
           GROUP BY model
           ORDER BY total_amount_micros DESC, total_input_tokens DESC, model ASC NULLS LAST`,
          baseParams,
        ),
        this.pool.query<{
          usage_record_id: number;
          request_id: string;
          currency: string;
          status: "billed" | "missing_sku" | "invalid_usage";
          account_id: string | null;
          provider: string | null;
          model: string | null;
          routing_group_id: string | null;
          target: string;
          session_key: string | null;
          client_device_id: string | null;
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          amount_micros: string | number | bigint;
          usage_created_at: Date;
        }>(
          `SELECT
             usage_record_id, request_id, currency, status,
             account_id, provider, model, routing_group_id, target, session_key, client_device_id,
             input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
             amount_micros, usage_created_at
           FROM billing_line_items
           WHERE ${ownerFilter}
             AND usage_created_at >= $${sinceParamIndex}
           ORDER BY usage_created_at DESC
           LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
          [...baseParams, cappedLimit, cappedOffset],
        ),
        this.pool.query<{ total: string }>(
          `SELECT COUNT(*)::int AS total
           FROM billing_line_items
           WHERE ${ownerFilter}
             AND usage_created_at >= $${sinceParamIndex}`,
          baseParams,
        ),
      ]);

    const total = totalResult.rows[0];
    const totalRequests = Number(total?.total_requests ?? 0);

    return {
      userId: null,
      organizationId: owner.organizationId,
      currency: total?.currency
        ? normalizeStoredBillingCurrency(total.currency)
        : null,
      totalRequests,
      billedRequests: Number(total?.billed_requests ?? 0),
      missingSkuRequests: Number(total?.missing_sku_requests ?? 0),
      invalidUsageRequests: Number(total?.invalid_usage_requests ?? 0),
      totalInputTokens: total ? readInt(total.total_input_tokens) : 0,
      totalOutputTokens: total ? readInt(total.total_output_tokens) : 0,
      totalCacheCreationTokens: total
        ? readInt(total.total_cache_creation_tokens)
        : 0,
      totalCacheReadTokens: total ? readInt(total.total_cache_read_tokens) : 0,
      totalAmountMicros: total
        ? readBigIntString(total.total_amount_micros)
        : "0",
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
        model: normalizeNullable(row.model) ?? "(unknown)",
        totalRequests: Number(row.total_requests ?? 0),
        billedRequests: Number(row.billed_requests ?? 0),
        missingSkuRequests: Number(row.missing_sku_requests ?? 0),
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
        accountId: row.account_id,
        provider: row.provider,
        model: row.model,
        routingGroupId: row.routing_group_id ?? null,
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
    };
  }



  async close(): Promise<void> {
    await this.pool.end();
  }

  private async upsertCandidates(
    candidates: BillingUsageCandidate[],
    result: BillingSyncResult,
  ): Promise<void> {
    if (!candidates.length) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const candidate of candidates) {
        const resolvedSku = await this.findResolvedSkuForUsage(candidate);
        const resolved = resolveBillingLineItem(candidate, resolvedSku);
        await client.query(
          `INSERT INTO billing_line_items (
            usage_record_id, request_id, user_id, user_name, account_id, provider, model, routing_group_id,
            organization_id, session_key, client_device_id, target, currency, status, matched_base_sku_id, matched_multiplier_micros,
            input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
            input_price_micros_per_million, output_price_micros_per_million,
            cache_creation_price_micros_per_million, cache_read_price_micros_per_million,
            amount_micros, usage_created_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,
            $9,$10,$11,$12,$13,$14,$15,$16,
            $17,$18,$19,$20,
            $21,$22,$23,$24,
            $25,$26,NOW()
          )
          ON CONFLICT (usage_record_id) DO UPDATE SET
            request_id = EXCLUDED.request_id,
            user_id = EXCLUDED.user_id,
            user_name = EXCLUDED.user_name,
            organization_id = EXCLUDED.organization_id,
            account_id = EXCLUDED.account_id,
            provider = EXCLUDED.provider,
            model = EXCLUDED.model,
            routing_group_id = EXCLUDED.routing_group_id,
            session_key = EXCLUDED.session_key,
            client_device_id = EXCLUDED.client_device_id,
            target = EXCLUDED.target,
            currency = EXCLUDED.currency,
            status = EXCLUDED.status,
            matched_base_sku_id = EXCLUDED.matched_base_sku_id,
            matched_multiplier_micros = EXCLUDED.matched_multiplier_micros,
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
            candidate.routingGroupId,
            candidate.organizationId ?? null,
            candidate.sessionKey,
            candidate.clientDeviceId,
            candidate.target,
            resolved.currency,
            resolved.status,
            resolvedSku?.baseSkuId ?? null,
            resolvedSku?.multiplierMicros ?? null,
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
        );
        await this.syncUsageDebitLedgerEntry(
          client,
          candidate,
          resolved,
          resolvedSku,
        );

        result.processedRequests += 1;
        if (resolved.status === "billed") {
          result.billedRequests += 1;
        } else if (resolved.status === "missing_sku") {
          result.missingSkuRequests += 1;
        } else {
          result.invalidUsageRequests += 1;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async getLastUsageRecordId(): Promise<number> {
    const result = await this.pool.query<{ value: string }>(
      `SELECT value FROM billing_meta WHERE key = 'last_usage_record_id'`,
    );
    const raw = result.rows[0]?.value ?? "0";
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async setLastUsageRecordId(value: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_meta (key, value, updated_at)
       VALUES ('last_usage_record_id', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(Math.max(0, Math.floor(value)))],
    );
  }

  private async loadUsageCandidatesAfterId(
    afterId: number,
    limit: number,
  ): Promise<BillingUsageCandidate[]> {
    const result = await this.pool.query<{
      usage_record_id: number;
      request_id: string;
      user_id: string | null;
      organization_id: string | null;
      user_name: string | null;
      billing_currency: string;
      account_id: string | null;
      provider: string | null;
      model: string | null;
      routing_group_id: string | null;
      session_key: string | null;
      client_device_id: string | null;
      target: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      status_code: number;
      created_at: Date;
    }>(
      `SELECT
         u.id AS usage_record_id,
         u.request_id,
         u.user_id,
         u.organization_id,
         COALESCE(ro.name, ru.name) AS user_name,
         COALESCE(ro.billing_currency, ru.billing_currency) AS billing_currency,
         u.account_id,
         a.data->>'provider' AS provider,
         u.model,
         u.routing_group_id,
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
       LEFT JOIN relay_organizations ro ON ro.id = u.organization_id
       LEFT JOIN accounts a ON a.id = u.account_id
       WHERE u.id > $1
         AND b.usage_record_id IS NULL
         AND (u.user_id IS NOT NULL OR u.organization_id IS NOT NULL)
         AND u.status_code >= 200
         AND u.status_code < 300
         AND COALESCE(u.attempt_kind, 'final') = 'final'
         AND (split_part(u.target, '?', 1) = ANY($2) OR split_part(u.target, '?', 1) LIKE '/v1/responses/%')
       ORDER BY u.id ASC
       LIMIT $3`,
      [afterId, [...BILLABLE_USAGE_TARGETS], limit],
    );

    return result.rows
      .filter((row) => isBillableUsageTarget(row.target))
      .map((row) => ({
        usageRecordId: Number(row.usage_record_id),
        requestId: row.request_id,
        userId: row.user_id,
        organizationId: row.organization_id,
        userName: row.user_name,
        billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
        accountId: row.account_id,
        provider: row.provider,
        model: row.model,
        routingGroupId: row.routing_group_id,
        sessionKey: row.session_key,
        clientDeviceId: row.client_device_id,
        target: row.target,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheCreationInputTokens: Number(row.cache_creation_input_tokens ?? 0),
        cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
        statusCode: Number(row.status_code ?? 0),
        createdAt: row.created_at.toISOString(),
      }));
  }

  private async loadUsageCandidateById(
    usageRecordId: number,
  ): Promise<BillingUsageCandidate | null> {
    const result = await this.pool.query<{
      usage_record_id: number;
      request_id: string;
      user_id: string | null;
      organization_id: string | null;
      user_name: string | null;
      billing_currency: string;
      account_id: string | null;
      provider: string | null;
      model: string | null;
      routing_group_id: string | null;
      session_key: string | null;
      client_device_id: string | null;
      target: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      status_code: number;
      created_at: Date;
    }>(
      `SELECT
         u.id AS usage_record_id,
         u.request_id,
         u.user_id,
         u.organization_id,
         COALESCE(ro.name, ru.name) AS user_name,
         COALESCE(ro.billing_currency, ru.billing_currency) AS billing_currency,
         u.account_id,
         a.data->>'provider' AS provider,
         u.model,
         u.routing_group_id,
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
       LEFT JOIN relay_organizations ro ON ro.id = u.organization_id
       LEFT JOIN accounts a ON a.id = u.account_id
       WHERE u.id = $1
         AND (u.user_id IS NOT NULL OR u.organization_id IS NOT NULL)
         AND u.status_code >= 200
         AND u.status_code < 300
         AND COALESCE(u.attempt_kind, 'final') = 'final'
         AND (split_part(u.target, '?', 1) = ANY($2) OR split_part(u.target, '?', 1) LIKE '/v1/responses/%')
       LIMIT 1`,
      [usageRecordId, [...BILLABLE_USAGE_TARGETS]],
    );

    const row = result.rows[0];
    if (!row || !isBillableUsageTarget(row.target)) {
      return null;
    }

    return {
      usageRecordId: Number(row.usage_record_id),
      requestId: row.request_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      userName: row.user_name,
      billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
      accountId: row.account_id,
      provider: normalizeUsageProvider(row.provider),
      model: row.model,
      routingGroupId: row.routing_group_id,
      sessionKey: row.session_key,
      clientDeviceId: row.client_device_id,
      target: row.target,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
      statusCode: Number(row.status_code ?? 0),
      createdAt: row.created_at.toISOString(),
    };
  }

  private async loadCandidatesForStatus(
    status: "missing_sku",
    afterUsageRecordId: number,
    limit: number,
  ): Promise<BillingUsageCandidate[]> {
    const result = await this.pool.query<{
      usage_record_id: number;
      request_id: string;
      user_id: string | null;
      organization_id: string | null;
      user_name: string | null;
      billing_currency: string;
      account_id: string | null;
      provider: string | null;
      model: string | null;
      routing_group_id: string | null;
      session_key: string | null;
      client_device_id: string | null;
      target: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      status_code: number;
      created_at: Date;
    }>(
      `SELECT
         u.id AS usage_record_id,
         u.request_id,
         u.user_id,
         u.organization_id,
         COALESCE(ro.name, ru.name) AS user_name,
         COALESCE(ro.billing_currency, ru.billing_currency) AS billing_currency,
         u.account_id,
         a.data->>'provider' AS provider,
         u.model,
         u.routing_group_id,
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
       LEFT JOIN relay_organizations ro ON ro.id = u.organization_id
       LEFT JOIN accounts a ON a.id = u.account_id
       WHERE b.status = $1
         AND b.usage_record_id > $2
       ORDER BY u.id ASC
       LIMIT $3`,
      [status, afterUsageRecordId, limit],
    );

    return result.rows.map((row) => ({
      usageRecordId: Number(row.usage_record_id),
      requestId: row.request_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      userName: row.user_name,
      billingCurrency: normalizeStoredBillingCurrency(row.billing_currency),
      accountId: row.account_id,
      provider: normalizeUsageProvider(row.provider),
      model: row.model,
      routingGroupId: row.routing_group_id,
      sessionKey: row.session_key,
      clientDeviceId: row.client_device_id,
      target: row.target,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0),
      statusCode: Number(row.status_code ?? 0),
      createdAt: row.created_at.toISOString(),
    }));
  }

  private async syncUsageDebitLedgerEntry(
    client: pg.PoolClient,
    candidate: BillingUsageCandidate,
    resolved: ReturnType<typeof resolveBillingLineItem>,
    resolvedSku: BillingResolvedSku | null,
  ): Promise<void> {
    const targetAmountMicros =
      resolved.status === "billed"
        ? (-BigInt(resolved.amountMicros)).toString()
        : "0";

    const note = resolvedSku
      ? `Usage charge via ${resolvedSku.displayName}`
      : "Usage charge";

    const existingResult = await client.query<{
      id: string;
      currency: string;
      amount_micros: string | number | bigint;
    }>(
      `SELECT id, currency, amount_micros
       FROM billing_balance_ledger
       WHERE usage_record_id = $1
       FOR UPDATE`,
      [candidate.usageRecordId],
    );
    const existing = existingResult.rows[0];
    const existingAmountMicros = existing
      ? BigInt(readBigIntString(existing.amount_micros))
      : 0n;
    const existingCurrency = existing
      ? normalizeStoredBillingCurrency(existing.currency)
      : null;
    const nextAmountMicros = BigInt(targetAmountMicros);

    if (!existing && nextAmountMicros === 0n) {
      return;
    }

    const delta = nextAmountMicros - existingAmountMicros;
    if (delta !== 0n) {
      if (candidate.organizationId) {
        await client.query(
          `UPDATE relay_organizations
           SET balance_micros = balance_micros + $1::bigint,
               updated_at = NOW()
           WHERE id = $2`,
          [delta.toString(), candidate.organizationId],
        );
      } else {
        await client.query(
          `UPDATE relay_users
           SET balance_micros = balance_micros + $1::bigint,
               updated_at = NOW()
           WHERE id = $2`,
          [delta.toString(), candidate.userId],
        );
      }
    }

    if (!existing) {
      await client.query(
        `INSERT INTO billing_balance_ledger (
          id, user_id, organization_id, kind, amount_micros, currency, note, usage_record_id, request_id
        ) VALUES ($1, $2, $3, 'usage_debit', $4, $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          candidate.organizationId ? null : candidate.userId,
          candidate.organizationId ?? null,
          targetAmountMicros,
          resolved.currency,
          note,
          candidate.usageRecordId,
          candidate.requestId,
        ],
      );
      return;
    }

    if (nextAmountMicros === 0n) {
      await client.query(
        `DELETE FROM billing_balance_ledger
         WHERE id = $1`,
        [existing.id],
      );
      return;
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
          note,
          candidate.requestId,
        ],
      );
    }
  }

  private async revertUsageDebitLedgerEntries(
    client: pg.PoolClient,
  ): Promise<void> {
    const aggregates = await client.query<{
      user_id: string | null;
      organization_id: string | null;
      amount_micros: string | number | bigint;
    }>(
      `SELECT user_id, organization_id, COALESCE(SUM(amount_micros), 0)::bigint AS amount_micros
       FROM billing_balance_ledger
       WHERE usage_record_id IS NOT NULL
       GROUP BY user_id, organization_id`,
    );

    for (const row of aggregates.rows) {
      const amountMicros = BigInt(readBigIntString(row.amount_micros));
      if (amountMicros === 0n) {
        continue;
      }
      if (row.organization_id) {
        await client.query(
          `UPDATE relay_organizations
           SET balance_micros = balance_micros - $1::bigint,
               updated_at = NOW()
           WHERE id = $2`,
          [amountMicros.toString(), row.organization_id],
        );
        continue;
      }
      if (!row.user_id) {
        continue;
      }
      await client.query(
        `UPDATE relay_users
         SET balance_micros = balance_micros - $1::bigint,
             updated_at = NOW()
         WHERE id = $2`,
        [amountMicros.toString(), row.user_id],
      );
    }

    await client.query(
      `DELETE FROM billing_balance_ledger
       WHERE usage_record_id IS NOT NULL`,
    );
  }
}
