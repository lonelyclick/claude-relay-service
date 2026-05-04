import type { BillingCurrency } from '../billing/engine.js'

export type AlertKind = 'balance_low' | 'balance_exhausted'

export interface BalanceAlertContext {
  kind: AlertKind
  recipientName: string
  organizationName: string | null
  currency: BillingCurrency
  /** Spendable balance in micros at the time of detection. Negative if overdrawn. */
  availableMicros: bigint
  /** Threshold that was crossed (only set for `balance_low`). */
  thresholdMicros: bigint | null
  /** Average daily debit in micros over the past 7 days, or null if unknown. */
  avgDailyDebitMicros: bigint | null
  /** Recharge / billing landing page link (already absolute). */
  rechargeUrl: string
}

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

export interface DispatchResult {
  status: 'sent' | 'skipped_cooldown' | 'skipped_disabled' | 'skipped_no_recipient'
  recipient: string | null
  campaign: string | null
  messageId: string | null
}
