import type { BillingCurrency } from '../../billing/engine.js'
import type { BalanceAlertContext, RenderedEmail } from '../types.js'
import { buildCampaignId, renderTrackingPixel } from '../tracking.js'

export function renderBalanceAlertEmail(
  ctx: BalanceAlertContext,
  recipientEmail: string,
  referenceId: string,
): RenderedEmail {
  const campaign = buildCampaignId(ctx.kind, referenceId)
  const balance = formatMicrosForCurrency(ctx.availableMicros, ctx.currency)
  const subjectPrefix = ctx.organizationName ? `[${ctx.organizationName}] ` : ''
  if (ctx.kind === 'balance_exhausted') {
    return renderExhausted(ctx, recipientEmail, balance, subjectPrefix, campaign)
  }
  return renderLow(ctx, recipientEmail, balance, subjectPrefix, campaign)
}

function renderLow(
  ctx: BalanceAlertContext,
  recipientEmail: string,
  balance: string,
  subjectPrefix: string,
  campaign: string,
): RenderedEmail {
  const subject = `${subjectPrefix}TokenQiao 余额预警：剩余 ${balance}`
  const threshold = ctx.thresholdMicros
    ? formatMicrosForCurrency(ctx.thresholdMicros, ctx.currency)
    : null
  const runwayLine = ctx.avgDailyDebitMicros && ctx.avgDailyDebitMicros > 0n
    ? `按过去 7 天日均消耗 ${formatMicrosForCurrency(ctx.avgDailyDebitMicros, ctx.currency)} 估算，约 ${estimateDays(ctx.availableMicros, ctx.avgDailyDebitMicros)} 天后将耗尽。`
    : null
  const text = [
    `${ctx.recipientName} 您好，`,
    '',
    `${ctx.organizationName ? `工作区「${ctx.organizationName}」的` : '您的'}TokenQiao 余额已低于预警阈值。`,
    `当前可用余额：${balance}` + (threshold ? `（阈值 ${threshold}）` : ''),
    runwayLine,
    '',
    `请尽快前往充值页面以避免服务中断：${ctx.rechargeUrl}`,
    '',
    '— TokenQiao',
  ].filter(Boolean).join('\n')
  const html = wrapHtml(`
    <p>${escapeHtml(ctx.recipientName)} 您好，</p>
    <p>${ctx.organizationName ? `工作区「${escapeHtml(ctx.organizationName)}」的` : '您的'}TokenQiao 余额已低于预警阈值。</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:12px 0">
      <tr><td style="color:#666">当前可用余额</td><td><strong>${escapeHtml(balance)}</strong></td></tr>
      ${threshold ? `<tr><td style="color:#666">预警阈值</td><td>${escapeHtml(threshold)}</td></tr>` : ''}
      ${runwayLine ? `<tr><td style="color:#666">预计剩余</td><td>${escapeHtml(runwayLine)}</td></tr>` : ''}
    </table>
    <p>
      <a href="${escapeHtml(ctx.rechargeUrl)}"
         style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">前往充值</a>
    </p>
    <p style="color:#999;font-size:12px;margin-top:32px">— TokenQiao</p>
    ${renderTrackingPixel(campaign, recipientEmail)}
  `)
  return { subject, text, html }
}

function renderExhausted(
  ctx: BalanceAlertContext,
  recipientEmail: string,
  balance: string,
  subjectPrefix: string,
  campaign: string,
): RenderedEmail {
  const subject = `${subjectPrefix}TokenQiao 服务已暂停：余额耗尽`
  const text = [
    `${ctx.recipientName} 您好，`,
    '',
    `${ctx.organizationName ? `工作区「${ctx.organizationName}」` : '您'}的 TokenQiao 余额已耗尽，所有 API 请求将返回 402 Payment Required，直到完成充值。`,
    `当前可用余额：${balance}`,
    '',
    `充值后服务自动恢复：${ctx.rechargeUrl}`,
    '',
    '— TokenQiao',
  ].join('\n')
  const html = wrapHtml(`
    <p>${escapeHtml(ctx.recipientName)} 您好，</p>
    <p style="background:#fff5f5;border-left:3px solid #d33;padding:8px 12px">
      ${ctx.organizationName ? `工作区「${escapeHtml(ctx.organizationName)}」` : '您'}的 TokenQiao 余额已耗尽，所有 API 请求将返回 <code>402 Payment Required</code>，直到完成充值。
    </p>
    <p>当前可用余额：<strong>${escapeHtml(balance)}</strong></p>
    <p>
      <a href="${escapeHtml(ctx.rechargeUrl)}"
         style="display:inline-block;background:#d33;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">立即充值</a>
    </p>
    <p style="color:#999;font-size:12px;margin-top:32px">— TokenQiao</p>
    ${renderTrackingPixel(campaign, recipientEmail)}
  `)
  return { subject, text, html }
}

function wrapHtml(inner: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;font-size:14px;line-height:1.6;max-width:560px;margin:0 auto;padding:24px">${inner}</body></html>`
}

function formatMicrosForCurrency(micros: bigint, currency: BillingCurrency): string {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  const major = abs / 1_000_000n
  const minorRaw = (abs % 1_000_000n).toString().padStart(6, '0')
  const trimmed = minorRaw.replace(/0+$/, '')
  const minor = trimmed.length < 2 ? minorRaw.slice(0, 2) : trimmed
  const sign = negative ? '-' : ''
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
  return `${sign}${symbol}${major}.${minor}`
}

function estimateDays(availableMicros: bigint, dailyDebitMicros: bigint): string {
  if (availableMicros <= 0n) return '0'
  const days = availableMicros / dailyDebitMicros
  if (days < 1n) return '<1'
  if (days > 60n) return '60+'
  return days.toString()
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
