import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

import { loadBodyTemplate, type BodyTemplate } from './proxy/bodyRewriter.js'
import {
  normalizeVmFingerprintTemplateHeaders,
  type VmFingerprintTemplateHeader,
} from './proxy/fingerprintTemplate.js'
import { projectRoot } from './projectRoot.js'

const isNodeTest = Boolean(
  process.env.TOKENQIAO_TEST_CONTEXT ||
    process.env.NODE_TEST_CONTEXT ||
    process.env.NODE_TEST_WORKER_ID,
)

if (!isNodeTest) {
  dotenv.config({ path: path.join(projectRoot, '.env') })
}

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3560),
  RELAY_CONTROL_URL: z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .url()
      .optional()
      .transform((value) => {
        const trimmed = value?.trim()
        return trimmed ? trimmed : null
      }),
  ),
  DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DRAIN_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  DRAIN_DETACH_GRACE_MS: z.coerce.number().int().min(0).default(5_000),
  ADMIN_TOKEN: z.string().min(16),
  INTERNAL_TOKEN: z.preprocess(emptyStringToUndefined, z.string().min(16).optional()),
  CCWEBAPP_NOTIFY_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
  STICKY_SESSION_TTL_HOURS: z.coerce.number().positive().default(1),
  ACCOUNT_ERROR_COOLDOWN_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  API_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  UPSTREAM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  UPSTREAM_PROXY_URL: z
    .string()
    .default('http://127.0.0.1:10808')
    .transform((value) => {
      const trimmed = value.trim()
      if (!trimmed || trimmed.toLowerCase() === 'direct') {
        return null
      }
      return trimmed
    }),
  ANTHROPIC_API_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  OAUTH_AUTHORIZE_URL: z.string().url().default('https://claude.com/cai/oauth/authorize'),
  OAUTH_TOKEN_URL: z.string().url().default('https://platform.claude.com/v1/oauth/token'),
  OAUTH_MANUAL_REDIRECT_URL: z
    .string()
    .url()
    .default('https://platform.claude.com/oauth/code/callback'),
  OAUTH_CLIENT_ID: z.string().default('9d1c250a-e61b-44d9-88ed-5944d1962f5e'),
  OPENAI_CODEX_OAUTH_ISSUER: z.string().url().default('https://auth.openai.com'),
  OPENAI_CODEX_OAUTH_CLIENT_ID: z.string().default('app_EMoamEEZ73f0CkXaXp7hrann'),
  OPENAI_CODEX_OAUTH_REDIRECT_URL: z
    .string()
    .url()
    .default('http://localhost:1455/auth/callback'),
  OPENAI_CODEX_API_BASE_URL: z
    .string()
    .url()
    .default('https://chatgpt.com/backend-api/codex'),
  OPENAI_CODEX_MODEL: z.string().default('gpt-5-codex'),
  GEMINI_OAUTH_CLIENT_ID: z
    .string()
    .default('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'),
  GEMINI_OAUTH_CLIENT_SECRET: z.string().default('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'),
  GEMINI_OAUTH_AUTHORIZE_URL: z
    .string()
    .url()
    .default('https://accounts.google.com/o/oauth2/v2/auth'),
  GEMINI_OAUTH_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  GEMINI_OAUTH_LOOPBACK_PORT: z.coerce.number().int().min(0).max(65535).default(8085),
  GEMINI_OAUTH_LOOPBACK_HOST: z.string().default('127.0.0.1'),
  GEMINI_OAUTH_LOOPBACK_REDIRECT_PATH: z.string().default('/oauth/callback'),
  GEMINI_OAUTH_USERINFO_URL: z
    .string()
    .url()
    .default('https://openidconnect.googleapis.com/v1/userinfo'),
  GEMINI_CODE_ASSIST_ENDPOINT: z
    .string()
    .url()
    .default('https://cloudcode-pa.googleapis.com'),
  GEMINI_CODE_ASSIST_API_VERSION: z.string().default('v1internal'),
  GEMINI_DEFAULT_MODEL: z.string().default('gemini-3.1-pro'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  BUFFERED_REQUEST_BODY_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  NON_STREAM_RESPONSE_CAPTURE_MAX_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  NON_STREAM_USAGE_CAPTURE_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  ADMIN_UI_KEYCLOAK_URL: z.string().url().default('https://auth.yohomobile.dev'),
  ADMIN_UI_KEYCLOAK_REALM: z.string().default('yoho'),
  ADMIN_UI_KEYCLOAK_CLIENT_ID: z.string().default('ccdash'),
  ADMIN_UI_ALLOWED_EMAILS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ADMIN_UI_ALLOWED_EMAIL_DOMAINS: z
    .string()
    .default('yohomobile.com')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ADMIN_UI_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ADMIN_UI_SESSION_TTL_MS: z.coerce.number().int().positive().default(8 * 60 * 60 * 1000),
  ADMIN_UI_SESSION_COOKIE_NAME: z.string().default('ccdash_admin_session'),
  ADMIN_UI_SESSION_SECRET: z.string().min(16),
  RELAY_LOG_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  RELAY_CAPTURE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RELAY_CAPTURE_BODY_MAX_BYTES: z.coerce.number().int().min(0).default(512),
  BODY_REWRITE_SKIP_LOG_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CLI_VALIDATOR_MODE: z
    .enum(['disabled', 'shadow', 'enforce'])
    .default('disabled'),
  VM_FINGERPRINT_TEMPLATE_PATH: z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .optional()
      .transform((value) => {
        const trimmed = value?.trim()
        return trimmed ? trimmed : null
      }),
  ),
  BODY_TEMPLATE_PATH: z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .optional()
      .transform((value) => {
        const trimmed = value?.trim()
        return trimmed ? trimmed : null
      }),
  ),
  BODY_TEMPLATE_NEW_PATH: z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .optional()
      .transform((value) => {
        const trimmed = value?.trim()
        return trimmed ? trimmed : null
      }),
  ),
  MIN_CLAUDE_VERSION: z
    .string()
    .default('2.1.90')
    .transform((value) => {
      const parts = value.trim().split('.').map(Number)
      if (parts.length !== 3 || parts.some(isNaN))
        throw new Error(`MIN_CLAUDE_VERSION must be in x.y.z format, got: ${value}`)
      return parts as [number, number, number]
    }),
  MAX_CLAUDE_VERSION: z
    .string()
    .default('2.1.131')
    .transform((value) => {
      const parts = value.trim().split('.').map(Number)
      if (parts.length !== 3 || parts.some(isNaN))
        throw new Error(`MAX_CLAUDE_VERSION must be in x.y.z format, got: ${value}`)
      return parts as [number, number, number]
    }),
  DEFAULT_MAX_SESSIONS_PER_ACCOUNT: z.coerce.number().int().positive().default(1000),
  ACCOUNT_MAX_SESSION_OVERFLOW: z.coerce.number().int().min(0).default(1),
  ROUTING_USER_MAX_ACTIVE_SESSIONS: z.coerce.number().int().positive().default(12),
  ROUTING_DEVICE_MAX_ACTIVE_SESSIONS: z.coerce.number().int().positive().default(4),
  ROUTING_BUDGET_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  ROUTING_USER_MAX_REQUESTS_PER_WINDOW: z.coerce.number().int().positive().default(300),
  ROUTING_DEVICE_MAX_REQUESTS_PER_WINDOW: z.coerce.number().int().positive().default(300),
  ROUTING_USER_MAX_TOKENS_PER_WINDOW: z.coerce.number().int().positive().default(100_000_000),
  ROUTING_DEVICE_MAX_TOKENS_PER_WINDOW: z.coerce.number().int().positive().default(100_000_000),
  CLAUDE_OFFICIAL_NATURAL_CAPACITY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  CLAUDE_OFFICIAL_USER_DEVICE_MAX_ACCOUNTS_24H: z.coerce.number().int().positive().default(3),
  CLAUDE_OFFICIAL_NEW_ACCOUNT_NEW_SESSION_ONLY_HOURS: z.coerce.number().int().nonnegative().default(72),
  CLAUDE_OFFICIAL_HEAVY_SESSION_ACCOUNT_MIN_AGE_HOURS: z.coerce.number().int().nonnegative().default(72),
  CLAUDE_OFFICIAL_HEAVY_SESSION_TOKENS: z.coerce.number().int().positive().default(400_000),
  CLAUDE_OFFICIAL_HEAVY_SESSION_CACHE_READ_TOKENS: z.coerce.number().int().positive().default(300_000),
  RISK_ALERT_FEISHU_WEBHOOK_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
  RISK_ALERT_DEDUP_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  RISK_ALERT_USER_TOKENS_PER_WINDOW: z.coerce.number().int().positive().default(1_200_000),
  RISK_ALERT_DEVICE_TOKENS_PER_WINDOW: z.coerce.number().int().positive().default(400_000),
  RISK_ALERT_USER_REQUESTS_PER_WINDOW: z.coerce.number().int().positive().default(60),
  RISK_ALERT_DEVICE_REQUESTS_PER_WINDOW: z.coerce.number().int().positive().default(20),
  RISK_ALERT_SESSION_ACCOUNT_SWITCHES_PER_WINDOW: z.coerce.number().int().positive().default(2),
  RISK_ALERT_USER_ACCOUNTS_PER_WINDOW: z.coerce.number().int().positive().default(2),
  CLAUDE_NEW_ACCOUNT_GUARD_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  CLAUDE_NEW_ACCOUNT_GUARD_WINDOW_MS: z.coerce.number().int().positive().default(3 * 60 * 60 * 1000),
  CLAUDE_NEW_ACCOUNT_GUARD_WARN_ACCOUNTS_24H: z.coerce.number().int().positive().default(2),
  CLAUDE_NEW_ACCOUNT_GUARD_BLOCK_ACCOUNTS_24H: z.coerce.number().int().positive().default(3),
  CLAUDE_NEW_ACCOUNT_GUARD_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(8),
  CLAUDE_NEW_ACCOUNT_GUARD_MAX_TOKENS_PER_MINUTE: z.coerce.number().int().positive().default(1_500_000),
  CLAUDE_NEW_ACCOUNT_GUARD_MAX_CACHE_READ_PER_MINUTE: z.coerce.number().int().positive().default(1_200_000),
  CLAUDE_NEW_ACCOUNT_GUARD_MAX_TOKENS_PER_REQUEST: z.coerce.number().int().positive().default(250_000),
  CLAUDE_NEW_ACCOUNT_GUARD_COOLDOWN_MS: z.coerce.number().int().positive().default(20 * 60 * 1000),
  ANTHROPIC_OVERAGE_DISABLED_GUARD_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ANTHROPIC_OVERAGE_DISABLED_COOLDOWN_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  ANTHROPIC_OVERAGE_ALLOWED_WARNING_COOLDOWN_MS: z.coerce.number().int().positive().default(45 * 60 * 1000),
  ANTHROPIC_OVERAGE_REJECTED_COOLDOWN_MS: z.coerce.number().int().positive().default(4 * 60 * 60 * 1000),
  ANTHROPIC_OVERAGE_POLICY_DISABLED_COOLDOWN_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  ACCOUNT_RISK_SCORE_REFRESH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ACCOUNT_RISK_SCORE_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  ACCOUNT_RISK_DEPRIORITIZE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ACCOUNT_RISK_DEPRIORITIZE_BANDS: z
    .string()
    .default('critical')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  CLAUDE_OFFICIAL_SESSION_ACCOUNT_PINNING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  HEALTH_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  HEALTH_ERROR_DECAY_THRESHOLD: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTO_BLOCK_COOLDOWN_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  UPSTREAM_5XX_COOLDOWN_THRESHOLD: z.coerce.number().int().positive().default(3),
  UPSTREAM_5XX_COOLDOWN_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
  GLOBAL_UPSTREAM_INCIDENT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  GLOBAL_UPSTREAM_INCIDENT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  GLOBAL_UPSTREAM_INCIDENT_ACCOUNT_THRESHOLD: z.coerce.number().int().positive().default(2),
  GLOBAL_UPSTREAM_INCIDENT_COOLDOWN_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
  SAME_REQUEST_SESSION_MIGRATION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  RATE_LIMIT_COOLDOWN_FALLBACK_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_COOLDOWN_MAX_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  SAME_REQUEST_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  SAME_REQUEST_RETRY_BACKOFF_MIN_MS: z.coerce.number().int().nonnegative().default(100),
  SAME_REQUEST_RETRY_BACKOFF_MAX_MS: z.coerce.number().int().nonnegative().default(500),
  DEVICE_AFFINITY_LOOKBACK_HOURS: z.coerce.number().int().positive().default(48),
  DEVICE_AFFINITY_MIN_SUCCESSES: z.coerce.number().int().positive().default(2),
  DEVICE_AFFINITY_FAILURE_PENALTY_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  DEFAULT_ACCOUNT_GROUP: z.string().default('default'),
  ACCOUNT_KEEPALIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ACCOUNT_KEEPALIVE_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  ACCOUNT_KEEPALIVE_REFRESH_BEFORE_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  ACCOUNT_KEEPALIVE_FORCE_REFRESH_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  ACCOUNT_WARMUP_TASK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ACCOUNT_WARMUP_TASK_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  ACCOUNT_WARMUP_TASK_DAILY_MIN: z.coerce.number().int().positive().default(3),
  ACCOUNT_WARMUP_TASK_DAILY_MAX: z.coerce.number().int().positive().default(6),
  ACCOUNT_WARMUP_TASK_MIN_GAP_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  ACCOUNT_WARMUP_TASK_MAX_ACCOUNTS_PER_TICK: z.coerce.number().int().positive().default(2),
  ACCOUNT_WARMUP_TASK_MAX_RISK_SCORE: z.coerce.number().int().min(0).max(100).default(55),
  ACCOUNT_WARMUP_TASK_MAX_CONNECTED_AGE_HOURS: z.coerce.number().int().nonnegative().default(168),
  ACCOUNT_WARMUP_TASK_MAX_UTILIZATION: z.coerce.number().min(0).max(1).default(0.65),
  ACCOUNT_WARMUP_TASK_MAX_TOKENS: z.coerce.number().int().positive().max(512).default(128),
  ACCOUNT_WARMUP_TASK_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  ACCOUNT_WARMUP_TASK_ROUTING_GROUP_IDS: z
    .string()
    .default('claude-official')
    .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)),
  ACCOUNT_WARMUP_TASK_EMAIL_DOMAINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)),
  CLAUDE_NEW_ACCOUNT_CACHE_GUARD_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  CLAUDE_NEW_ACCOUNT_CACHE_GUARD_AGE_HOURS: z.coerce.number().int().positive().default(72),
  CLAUDE_NEW_ACCOUNT_CACHE_GUARD_WATCH_CACHE_READ_1M: z.coerce.number().int().positive().default(300_000),
  CLAUDE_NEW_ACCOUNT_CACHE_GUARD_CAUTION_CACHE_READ_1M: z.coerce.number().int().positive().default(800_000),
  CLAUDE_NEW_ACCOUNT_CACHE_GUARD_CRITICAL_CACHE_READ_1M: z.coerce.number().int().positive().default(1_500_000),
  CLAUDE_NEW_ACCOUNT_CACHE_GUARD_COOLDOWN_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  CLAUDE_SESSION_ACCOUNT_AFFINITY_STRICT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  QUOTA_DATA_FRESHNESS_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  RATE_LIMIT_PROBE_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  STICKY_MIGRATION_5H_UTIL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  STICKY_MIGRATION_HYSTERESIS: z.coerce.number().min(0).max(1).default(0.05),
  STICKY_MIGRATION_COOLDOWN_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  BILLING_CURRENCY: z
    .string()
    .default('USD')
    .transform((value) => value.trim().toUpperCase() || 'USD'),
  BILLING_FALLBACK_INPUT_PRICE_MICROS_PER_MILLION: z.coerce.number().int().nonnegative().default(90000000),
  BILLING_FALLBACK_OUTPUT_PRICE_MICROS_PER_MILLION: z.coerce.number().int().nonnegative().default(450000000),
  BILLING_FALLBACK_CACHE_CREATION_PRICE_MICROS_PER_MILLION: z.coerce.number().int().nonnegative().default(112500000),
  BILLING_FALLBACK_CACHE_READ_PRICE_MICROS_PER_MILLION: z.coerce.number().int().nonnegative().default(9000000),
  EMAIL_PROVIDER: z.enum(['disabled', 'ses', 'smtp']).default('disabled'),
  EMAIL_FROM: z.string().default('TokenQiao <noreply@tokenqiao.com>'),
  EMAIL_REPLY_TO: z.preprocess(emptyStringToUndefined, z.string().email().optional()),
  AWS_SES_REGION: z.string().default('ap-southeast-1'),
  AWS_SES_ACCESS_KEY_ID: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  AWS_SES_SECRET_ACCESS_KEY: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  AWS_SES_CONFIGURATION_SET: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  SMTP_HOST: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SMTP_USER: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  SMTP_PASS: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  EMAIL_TRACKING_BASE_URL: z
    .string()
    .url()
    .default('https://track.yohomobile.com'),
  EMAIL_TRACKING_CAMPAIGN_PREFIX: z.string().default('tokenqiao'),
  EMAIL_PUBLIC_BASE_URL: z.string().url().default('https://tokenqiao.com'),
  BALANCE_ALERT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BALANCE_ALERT_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  BALANCE_ALERT_COOLDOWN_HOURS: z.coerce.number().positive().default(24),
  BALANCE_ALERT_LOW_THRESHOLD_USD_MICROS: z.coerce.number().int().nonnegative().default(1_000_000),
  BALANCE_ALERT_LOW_THRESHOLD_CNY_MICROS: z.coerce.number().int().nonnegative().default(7_000_000),
  DATABASE_URL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
  BETTER_AUTH_API_URL: z.string().url().default("https://tokenqiao.com/api/auth"),
  BETTER_AUTH_ADMIN_EMAIL: z.preprocess(emptyStringToUndefined, z.string().email().optional()),
  BETTER_AUTH_DATABASE_URL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
})

const vmFingerprintTemplateSchema = z.object({
  headers: z.record(z.union([z.string(), z.array(z.string())])),
})

const rawEnv = isNodeTest
  ? {
      ADMIN_TOKEN: 'test-admin-token-1234567890',
      ADMIN_UI_SESSION_SECRET: 'test-admin-session-secret-1234567890',
      ...process.env,
    }
  : process.env

const env = envSchema.parse(rawEnv)
const vmFingerprintTemplatePath = env.VM_FINGERPRINT_TEMPLATE_PATH
  ? path.resolve(projectRoot, env.VM_FINGERPRINT_TEMPLATE_PATH)
  : null
const vmFingerprintTemplateHeaders = loadVmFingerprintTemplateHeaders(
  vmFingerprintTemplatePath,
)
const bodyTemplatePath = env.BODY_TEMPLATE_PATH
  ? path.resolve(projectRoot, env.BODY_TEMPLATE_PATH)
  : null
const bodyTemplate = loadBodyTemplate(bodyTemplatePath)
const bodyTemplateNewPath = env.BODY_TEMPLATE_NEW_PATH
  ? path.resolve(projectRoot, env.BODY_TEMPLATE_NEW_PATH)
  : null
const bodyTemplateNew = loadBodyTemplate(bodyTemplateNewPath)

export const appConfig = {
  host: env.HOST,
  port: env.PORT,
  relayControlUrl: env.RELAY_CONTROL_URL,
  drainTimeoutMs: env.DRAIN_TIMEOUT_MS,
  drainPollIntervalMs: env.DRAIN_POLL_INTERVAL_MS,
  drainDetachGraceMs: env.DRAIN_DETACH_GRACE_MS,
  adminToken: env.ADMIN_TOKEN,
  internalToken: env.INTERNAL_TOKEN ?? null,
  ccwebappNotifyUrl: env.CCWEBAPP_NOTIFY_URL ?? null,
  stickySessionTtlHours: env.STICKY_SESSION_TTL_HOURS,
  accountErrorCooldownMs: env.ACCOUNT_ERROR_COOLDOWN_MS,
  requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
  bufferedRequestBodyMaxBytes: env.BUFFERED_REQUEST_BODY_MAX_BYTES,
  nonStreamResponseCaptureMaxBytes: env.NON_STREAM_RESPONSE_CAPTURE_MAX_BYTES,
  nonStreamUsageCaptureMaxBytes: env.NON_STREAM_USAGE_CAPTURE_MAX_BYTES,
  upstreamRequestTimeoutMs:
    env.API_TIMEOUT_MS ?? env.UPSTREAM_REQUEST_TIMEOUT_MS ?? 10 * 60 * 1000,
  upstreamProxyUrl: env.UPSTREAM_PROXY_URL,
  anthropicApiBaseUrl: env.ANTHROPIC_API_BASE_URL.replace(/\/$/, ''),
  oauthAuthorizeUrl: env.OAUTH_AUTHORIZE_URL,
  oauthTokenUrl: env.OAUTH_TOKEN_URL,
  oauthManualRedirectUrl: env.OAUTH_MANUAL_REDIRECT_URL,
  oauthClientId: env.OAUTH_CLIENT_ID,
  openAICodexOauthIssuer: env.OPENAI_CODEX_OAUTH_ISSUER.replace(/\/+$/, ''),
  openAICodexOauthClientId: env.OPENAI_CODEX_OAUTH_CLIENT_ID,
  openAICodexOauthRedirectUrl: env.OPENAI_CODEX_OAUTH_REDIRECT_URL,
  openAICodexApiBaseUrl: env.OPENAI_CODEX_API_BASE_URL.replace(/\/+$/, ''),
  openAICodexModel: env.OPENAI_CODEX_MODEL.trim() || 'gpt-5-codex',
  geminiOauthClientId: env.GEMINI_OAUTH_CLIENT_ID,
  geminiOauthClientSecret: env.GEMINI_OAUTH_CLIENT_SECRET,
  geminiOauthAuthorizeUrl: env.GEMINI_OAUTH_AUTHORIZE_URL,
  geminiOauthTokenUrl: env.GEMINI_OAUTH_TOKEN_URL,
  geminiOauthLoopbackPort: env.GEMINI_OAUTH_LOOPBACK_PORT,
  geminiOauthLoopbackHost: env.GEMINI_OAUTH_LOOPBACK_HOST,
  geminiOauthLoopbackRedirectPath: env.GEMINI_OAUTH_LOOPBACK_REDIRECT_PATH,
  geminiOauthUserInfoUrl: env.GEMINI_OAUTH_USERINFO_URL,
  geminiOauthScopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ] as const,
  geminiCodeAssistEndpoint: env.GEMINI_CODE_ASSIST_ENDPOINT.replace(/\/+$/, ''),
  geminiCodeAssistApiVersion: env.GEMINI_CODE_ASSIST_API_VERSION,
  geminiDefaultModel: env.GEMINI_DEFAULT_MODEL,
  adminUiKeycloakUserInfoUrl: `${env.ADMIN_UI_KEYCLOAK_URL.replace(/\/$/, '')}/realms/${encodeURIComponent(env.ADMIN_UI_KEYCLOAK_REALM)}/protocol/openid-connect/userinfo`,
  adminUiKeycloakUrl: env.ADMIN_UI_KEYCLOAK_URL.replace(/\/$/, ''),
  adminUiKeycloakRealm: env.ADMIN_UI_KEYCLOAK_REALM,
  adminUiKeycloakClientId: env.ADMIN_UI_KEYCLOAK_CLIENT_ID.trim() || 'ccdash',
  adminUiAllowedEmails: env.ADMIN_UI_ALLOWED_EMAILS,
  adminUiAllowedEmailDomains: env.ADMIN_UI_ALLOWED_EMAIL_DOMAINS,
  adminUiAllowedOrigins: env.ADMIN_UI_ALLOWED_ORIGINS,
  adminUiSessionTtlMs: env.ADMIN_UI_SESSION_TTL_MS,
  adminUiSessionCookieName: env.ADMIN_UI_SESSION_COOKIE_NAME,
  adminUiSessionSecret: env.ADMIN_UI_SESSION_SECRET,
  relayLogEnabled: env.RELAY_LOG_ENABLED,
  relayCaptureEnabled: env.RELAY_CAPTURE_ENABLED,
  relayCaptureBodyMaxBytes: env.RELAY_CAPTURE_BODY_MAX_BYTES,
  bodyRewriteSkipLogEnabled: env.BODY_REWRITE_SKIP_LOG_ENABLED,
  cliValidatorMode: env.CLI_VALIDATOR_MODE,
  vmFingerprintTemplatePath,
  vmFingerprintTemplateHeaders,
  bodyTemplatePath,
  bodyTemplate,
  bodyTemplateNewPath,
  bodyTemplateNew,
  minClaudeCliVersion: env.MIN_CLAUDE_VERSION,
  maxClaudeCliVersion: env.MAX_CLAUDE_VERSION,
  defaultMaxSessionsPerAccount: env.DEFAULT_MAX_SESSIONS_PER_ACCOUNT,
  accountMaxSessionOverflow: env.ACCOUNT_MAX_SESSION_OVERFLOW,
  routingUserMaxActiveSessions: env.ROUTING_USER_MAX_ACTIVE_SESSIONS,
  routingDeviceMaxActiveSessions: env.ROUTING_DEVICE_MAX_ACTIVE_SESSIONS,
  routingBudgetWindowMs: env.ROUTING_BUDGET_WINDOW_MS,
  routingUserMaxRequestsPerWindow: env.ROUTING_USER_MAX_REQUESTS_PER_WINDOW,
  routingDeviceMaxRequestsPerWindow: env.ROUTING_DEVICE_MAX_REQUESTS_PER_WINDOW,
  routingUserMaxTokensPerWindow: env.ROUTING_USER_MAX_TOKENS_PER_WINDOW,
  routingDeviceMaxTokensPerWindow: env.ROUTING_DEVICE_MAX_TOKENS_PER_WINDOW,
  claudeOfficialNaturalCapacityEnabled: env.CLAUDE_OFFICIAL_NATURAL_CAPACITY_ENABLED,
  claudeOfficialUserDeviceMaxAccounts24h: env.CLAUDE_OFFICIAL_USER_DEVICE_MAX_ACCOUNTS_24H,
  claudeOfficialNewAccountNewSessionOnlyHours: env.CLAUDE_OFFICIAL_NEW_ACCOUNT_NEW_SESSION_ONLY_HOURS,
  claudeOfficialHeavySessionAccountMinAgeHours: env.CLAUDE_OFFICIAL_HEAVY_SESSION_ACCOUNT_MIN_AGE_HOURS,
  claudeOfficialHeavySessionTokens: env.CLAUDE_OFFICIAL_HEAVY_SESSION_TOKENS,
  claudeOfficialHeavySessionCacheReadTokens: env.CLAUDE_OFFICIAL_HEAVY_SESSION_CACHE_READ_TOKENS,
  riskAlertFeishuWebhookUrl: env.RISK_ALERT_FEISHU_WEBHOOK_URL ?? null,
  riskAlertDedupMs: env.RISK_ALERT_DEDUP_MS,
  riskAlertUserTokensPerWindow: env.RISK_ALERT_USER_TOKENS_PER_WINDOW,
  riskAlertDeviceTokensPerWindow: env.RISK_ALERT_DEVICE_TOKENS_PER_WINDOW,
  riskAlertUserRequestsPerWindow: env.RISK_ALERT_USER_REQUESTS_PER_WINDOW,
  riskAlertDeviceRequestsPerWindow: env.RISK_ALERT_DEVICE_REQUESTS_PER_WINDOW,
  riskAlertSessionAccountSwitchesPerWindow: env.RISK_ALERT_SESSION_ACCOUNT_SWITCHES_PER_WINDOW,
  riskAlertUserAccountsPerWindow: env.RISK_ALERT_USER_ACCOUNTS_PER_WINDOW,
  claudeNewAccountGuardEnabled: env.CLAUDE_NEW_ACCOUNT_GUARD_ENABLED,
  claudeNewAccountGuardWindowMs: env.CLAUDE_NEW_ACCOUNT_GUARD_WINDOW_MS,
  claudeNewAccountGuardWarnAccounts24h: env.CLAUDE_NEW_ACCOUNT_GUARD_WARN_ACCOUNTS_24H,
  claudeNewAccountGuardBlockAccounts24h: env.CLAUDE_NEW_ACCOUNT_GUARD_BLOCK_ACCOUNTS_24H,
  claudeNewAccountGuardMaxRequestsPerMinute: env.CLAUDE_NEW_ACCOUNT_GUARD_MAX_REQUESTS_PER_MINUTE,
  claudeNewAccountGuardMaxTokensPerMinute: env.CLAUDE_NEW_ACCOUNT_GUARD_MAX_TOKENS_PER_MINUTE,
  claudeNewAccountGuardMaxCacheReadPerMinute: env.CLAUDE_NEW_ACCOUNT_GUARD_MAX_CACHE_READ_PER_MINUTE,
  claudeNewAccountGuardMaxTokensPerRequest: env.CLAUDE_NEW_ACCOUNT_GUARD_MAX_TOKENS_PER_REQUEST,
  claudeNewAccountGuardCooldownMs: env.CLAUDE_NEW_ACCOUNT_GUARD_COOLDOWN_MS,
  anthropicOverageDisabledGuardEnabled: env.ANTHROPIC_OVERAGE_DISABLED_GUARD_ENABLED,
  anthropicOverageDisabledCooldownMs: env.ANTHROPIC_OVERAGE_DISABLED_COOLDOWN_MS,
  anthropicOverageAllowedWarningCooldownMs: env.ANTHROPIC_OVERAGE_ALLOWED_WARNING_COOLDOWN_MS,
  anthropicOverageRejectedCooldownMs: env.ANTHROPIC_OVERAGE_REJECTED_COOLDOWN_MS,
  anthropicOveragePolicyDisabledCooldownMs: env.ANTHROPIC_OVERAGE_POLICY_DISABLED_COOLDOWN_MS,
  accountRiskScoreRefreshEnabled: env.ACCOUNT_RISK_SCORE_REFRESH_ENABLED,
  accountRiskScoreRefreshIntervalMs: env.ACCOUNT_RISK_SCORE_REFRESH_INTERVAL_MS,
  accountRiskDeprioritizeEnabled: env.ACCOUNT_RISK_DEPRIORITIZE_ENABLED,
  accountRiskDeprioritizeBands: env.ACCOUNT_RISK_DEPRIORITIZE_BANDS,
  claudeOfficialSessionAccountPinning: env.CLAUDE_OFFICIAL_SESSION_ACCOUNT_PINNING,
  healthWindowMs: env.HEALTH_WINDOW_MS,
  healthErrorDecayThreshold: env.HEALTH_ERROR_DECAY_THRESHOLD,
  rateLimitAutoBlockCooldownMs: env.RATE_LIMIT_AUTO_BLOCK_COOLDOWN_MS,
  upstream5xxCooldownThreshold: env.UPSTREAM_5XX_COOLDOWN_THRESHOLD,
  upstream5xxCooldownMs: env.UPSTREAM_5XX_COOLDOWN_MS,
  globalUpstreamIncidentEnabled: env.GLOBAL_UPSTREAM_INCIDENT_ENABLED,
  globalUpstreamIncidentWindowMs: env.GLOBAL_UPSTREAM_INCIDENT_WINDOW_MS,
  globalUpstreamIncidentAccountThreshold: env.GLOBAL_UPSTREAM_INCIDENT_ACCOUNT_THRESHOLD,
  globalUpstreamIncidentCooldownMs: env.GLOBAL_UPSTREAM_INCIDENT_COOLDOWN_MS,
  sameRequestSessionMigrationEnabled: env.SAME_REQUEST_SESSION_MIGRATION_ENABLED,
  rateLimitCooldownFallbackMs: env.RATE_LIMIT_COOLDOWN_FALLBACK_MS,
  rateLimitCooldownMaxMs: env.RATE_LIMIT_COOLDOWN_MAX_MS,
  sameRequestMaxRetries: env.SAME_REQUEST_MAX_RETRIES,
  sameRequestRetryBackoffMinMs: env.SAME_REQUEST_RETRY_BACKOFF_MIN_MS,
  sameRequestRetryBackoffMaxMs: env.SAME_REQUEST_RETRY_BACKOFF_MAX_MS,
  deviceAffinityLookbackHours: env.DEVICE_AFFINITY_LOOKBACK_HOURS,
  deviceAffinityMinSuccesses: env.DEVICE_AFFINITY_MIN_SUCCESSES,
  deviceAffinityFailurePenaltyMs: env.DEVICE_AFFINITY_FAILURE_PENALTY_MS,
  defaultAccountGroup: env.DEFAULT_ACCOUNT_GROUP,
  accountKeepAliveEnabled: env.ACCOUNT_KEEPALIVE_ENABLED,
  accountKeepAliveIntervalMs: env.ACCOUNT_KEEPALIVE_INTERVAL_MS,
  accountKeepAliveRefreshBeforeMs: env.ACCOUNT_KEEPALIVE_REFRESH_BEFORE_MS,
  accountKeepAliveForceRefreshMs: env.ACCOUNT_KEEPALIVE_FORCE_REFRESH_MS,
  accountWarmupTaskEnabled: env.ACCOUNT_WARMUP_TASK_ENABLED,
  accountWarmupTaskIntervalMs: env.ACCOUNT_WARMUP_TASK_INTERVAL_MS,
  accountWarmupTaskDailyMin: Math.min(env.ACCOUNT_WARMUP_TASK_DAILY_MIN, env.ACCOUNT_WARMUP_TASK_DAILY_MAX),
  accountWarmupTaskDailyMax: Math.max(env.ACCOUNT_WARMUP_TASK_DAILY_MIN, env.ACCOUNT_WARMUP_TASK_DAILY_MAX),
  accountWarmupTaskMinGapMs: env.ACCOUNT_WARMUP_TASK_MIN_GAP_MS,
  accountWarmupTaskMaxAccountsPerTick: env.ACCOUNT_WARMUP_TASK_MAX_ACCOUNTS_PER_TICK,
  accountWarmupTaskMaxRiskScore: env.ACCOUNT_WARMUP_TASK_MAX_RISK_SCORE,
  accountWarmupTaskMaxConnectedAgeHours: env.ACCOUNT_WARMUP_TASK_MAX_CONNECTED_AGE_HOURS,
  accountWarmupTaskMaxUtilization: env.ACCOUNT_WARMUP_TASK_MAX_UTILIZATION,
  accountWarmupTaskMaxTokens: env.ACCOUNT_WARMUP_TASK_MAX_TOKENS,
  accountWarmupTaskModel: env.ACCOUNT_WARMUP_TASK_MODEL.trim() || 'claude-haiku-4-5-20251001',
  accountWarmupTaskRoutingGroupIds: env.ACCOUNT_WARMUP_TASK_ROUTING_GROUP_IDS,
  accountWarmupTaskEmailDomains: env.ACCOUNT_WARMUP_TASK_EMAIL_DOMAINS,
  claudeNewAccountCacheGuardEnabled: env.CLAUDE_NEW_ACCOUNT_CACHE_GUARD_ENABLED,
  claudeNewAccountCacheGuardAgeHours: env.CLAUDE_NEW_ACCOUNT_CACHE_GUARD_AGE_HOURS,
  claudeNewAccountCacheGuardWatchCacheRead1m: env.CLAUDE_NEW_ACCOUNT_CACHE_GUARD_WATCH_CACHE_READ_1M,
  claudeNewAccountCacheGuardCautionCacheRead1m: env.CLAUDE_NEW_ACCOUNT_CACHE_GUARD_CAUTION_CACHE_READ_1M,
  claudeNewAccountCacheGuardCriticalCacheRead1m: env.CLAUDE_NEW_ACCOUNT_CACHE_GUARD_CRITICAL_CACHE_READ_1M,
  claudeNewAccountCacheGuardCooldownMs: env.CLAUDE_NEW_ACCOUNT_CACHE_GUARD_COOLDOWN_MS,
  claudeSessionAccountAffinityStrict: env.CLAUDE_SESSION_ACCOUNT_AFFINITY_STRICT,
  quotaDataFreshnessMs: env.QUOTA_DATA_FRESHNESS_MS,
  rateLimitProbeIntervalMs: env.RATE_LIMIT_PROBE_INTERVAL_MS,
  stickyMigration5hUtilThreshold: env.STICKY_MIGRATION_5H_UTIL_THRESHOLD,
  stickyMigrationHysteresis: env.STICKY_MIGRATION_HYSTERESIS,
  stickyMigrationCooldownMs: env.STICKY_MIGRATION_COOLDOWN_MS,
  billingCurrency: env.BILLING_CURRENCY,
  billingFallbackInputPriceMicrosPerMillion: env.BILLING_FALLBACK_INPUT_PRICE_MICROS_PER_MILLION,
  billingFallbackOutputPriceMicrosPerMillion: env.BILLING_FALLBACK_OUTPUT_PRICE_MICROS_PER_MILLION,
  billingFallbackCacheCreationPriceMicrosPerMillion: env.BILLING_FALLBACK_CACHE_CREATION_PRICE_MICROS_PER_MILLION,
  billingFallbackCacheReadPriceMicrosPerMillion: env.BILLING_FALLBACK_CACHE_READ_PRICE_MICROS_PER_MILLION,
  emailProvider: env.EMAIL_PROVIDER,
  emailFrom: env.EMAIL_FROM,
  emailReplyTo: env.EMAIL_REPLY_TO ?? null,
  awsSesRegion: env.AWS_SES_REGION,
  awsSesAccessKeyId: env.AWS_SES_ACCESS_KEY_ID ?? null,
  awsSesSecretAccessKey: env.AWS_SES_SECRET_ACCESS_KEY ?? null,
  awsSesConfigurationSet: env.AWS_SES_CONFIGURATION_SET ?? null,
  smtpHost: env.SMTP_HOST ?? null,
  smtpPort: env.SMTP_PORT,
  smtpSecure: env.SMTP_SECURE,
  smtpUser: env.SMTP_USER ?? null,
  smtpPass: env.SMTP_PASS ?? null,
  emailTrackingBaseUrl: env.EMAIL_TRACKING_BASE_URL.replace(/\/+$/, ''),
  emailTrackingCampaignPrefix: env.EMAIL_TRACKING_CAMPAIGN_PREFIX.trim() || 'tokenqiao',
  emailPublicBaseUrl: env.EMAIL_PUBLIC_BASE_URL.replace(/\/+$/, ''),
  balanceAlertEnabled: env.BALANCE_ALERT_ENABLED,
  balanceAlertIntervalMs: env.BALANCE_ALERT_INTERVAL_MS,
  balanceAlertCooldownHours: env.BALANCE_ALERT_COOLDOWN_HOURS,
  balanceAlertLowThresholdUsdMicros: env.BALANCE_ALERT_LOW_THRESHOLD_USD_MICROS,
  balanceAlertLowThresholdCnyMicros: env.BALANCE_ALERT_LOW_THRESHOLD_CNY_MICROS,
  databaseUrl: env.DATABASE_URL ?? null,
  betterAuthApiUrl: env.BETTER_AUTH_API_URL.replace(/\/+$/, ""),
  betterAuthAdminEmail: env.BETTER_AUTH_ADMIN_EMAIL ?? null,
  betterAuthDatabaseUrl: env.BETTER_AUTH_DATABASE_URL ?? null,
  claudeAiOrigin: 'https://claude.ai',
  claudeAiOrganizationsUrl: 'https://claude.ai/api/organizations',
  claudeAiCookieAuthorizeTemplate: 'https://claude.ai/v1/oauth/{organization_uuid}/authorize',
  oauthBetaHeader: 'oauth-2025-04-20',
  filesApiBetaHeader: 'files-api-2025-04-14,oauth-2025-04-20',
  ccrByocBetaHeader: 'ccr-byoc-2025-07-29',
  mcpServersBetaHeader: 'mcp-servers-2025-12-04',
  triggersBetaHeader: 'ccr-triggers-2026-01-30',
  anthropicVersion: '2023-06-01',
  oauthScopes: [
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
  ],
  profileEndpoint: '/api/oauth/profile',
  rolesEndpoint: '/api/oauth/claude_cli/roles',
} as const

function loadVmFingerprintTemplateHeaders(
  templatePath: string | null,
): VmFingerprintTemplateHeader[] {
  if (!templatePath) {
    return []
  }

  const parsed = vmFingerprintTemplateSchema.parse(
    JSON.parse(fs.readFileSync(templatePath, 'utf8')),
  )
  const headers = normalizeVmFingerprintTemplateHeaders(parsed.headers)

  if (headers.length === 0) {
    throw new Error(
      `VM_FINGERPRINT_TEMPLATE_PATH=${templatePath} contains no supported headers`,
    )
  }

  return headers
}
