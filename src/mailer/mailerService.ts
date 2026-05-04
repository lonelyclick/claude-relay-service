import { appConfig } from '../config.js'
import { sendEmail, type SendEmailResult } from '../emailService.js'
import { renderBalanceAlertEmail } from './templates/balanceAlert.js'
import { buildCampaignId } from './tracking.js'
import type { MailerSendLogStore } from './sendLogStore.js'
import type {
  AlertKind,
  BalanceAlertContext,
  DispatchResult,
} from './types.js'
import type { BillingCurrency } from '../billing/engine.js'

export interface MailerDeps {
  sendLog: MailerSendLogStore
}

export interface DispatchBalanceAlertInput {
  kind: AlertKind
  referenceId: string
  recipient: { email: string; name: string }
  organizationName: string | null
  currency: BillingCurrency
  availableMicros: bigint
  thresholdMicros: bigint | null
  avgDailyDebitMicros: bigint | null
  /** Override default cooldown. Falls back to `BALANCE_ALERT_COOLDOWN_HOURS`. */
  cooldownHoursOverride?: number
}

export class MailerService {
  private readonly deps: MailerDeps

  constructor(deps: MailerDeps) {
    this.deps = deps
  }

  isEnabled(): boolean {
    return appConfig.emailProvider !== 'disabled'
  }

  async dispatchBalanceAlert(input: DispatchBalanceAlertInput): Promise<DispatchResult> {
    if (!this.isEnabled()) {
      return { status: 'skipped_disabled', recipient: null, campaign: null, messageId: null }
    }
    if (!input.recipient.email) {
      return { status: 'skipped_no_recipient', recipient: null, campaign: null, messageId: null }
    }
    const cooldown =
      input.cooldownHoursOverride ?? appConfig.balanceAlertCooldownHours
    const within = await this.deps.sendLog.isWithinCooldown({
      kind: input.kind,
      referenceId: input.referenceId,
      recipient: input.recipient.email,
      cooldownHours: cooldown,
    })
    if (within) {
      return {
        status: 'skipped_cooldown',
        recipient: input.recipient.email,
        campaign: buildCampaignId(input.kind, input.referenceId),
        messageId: null,
      }
    }
    const ctx: BalanceAlertContext = {
      kind: input.kind,
      recipientName: input.recipient.name,
      organizationName: input.organizationName,
      currency: input.currency,
      availableMicros: input.availableMicros,
      thresholdMicros: input.thresholdMicros,
      avgDailyDebitMicros: input.avgDailyDebitMicros,
      rechargeUrl: `${appConfig.emailPublicBaseUrl}/billing`,
    }
    const rendered = renderBalanceAlertEmail(ctx, input.recipient.email, input.referenceId)
    const campaign = buildCampaignId(input.kind, input.referenceId)
    const result: SendEmailResult = await sendEmail({
      to: input.recipient.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      tags: { app: 'tokenqiao', kind: input.kind, ref: input.referenceId.slice(0, 64) },
    })
    await this.deps.sendLog.record({
      recipient: input.recipient.email,
      kind: input.kind,
      referenceId: input.referenceId,
      campaign,
      messageId: result.messageId,
      metadata: {
        provider: result.provider,
        currency: input.currency,
        availableMicros: input.availableMicros.toString(),
        thresholdMicros: input.thresholdMicros?.toString() ?? null,
        organizationName: input.organizationName,
      },
    })
    return {
      status: 'sent',
      recipient: input.recipient.email,
      campaign,
      messageId: result.messageId,
    }
  }
}
