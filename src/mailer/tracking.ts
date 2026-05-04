import { appConfig } from '../config.js'

/**
 * Build a 1x1 tracking pixel `<img>` tag pointing at the shared
 * `email-tracking` Cloudflare Worker (track.yohomobile.com by default).
 *
 * The worker stores `{campaign}:{email}` keys in KV with first/last open
 * timestamps. The pixel itself MUST stay below the visible area; we use
 * inline styles so most rendering clients still load it without surfacing
 * a broken-image placeholder.
 */
export function renderTrackingPixel(campaign: string, recipient: string): string {
  const base = appConfig.emailTrackingBaseUrl
  const url = `${base}/open?c=${encodeURIComponent(campaign)}&e=${encodeBase64Email(recipient)}`
  return `<img src="${escapeHtml(url)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`
}

export function buildCampaignId(kind: string, referenceId: string | null | undefined): string {
  const prefix = appConfig.emailTrackingCampaignPrefix
  const ref = referenceId?.slice(0, 32) ?? 'unknown'
  return `${prefix}.${kind}.${ref}`
}

function encodeBase64Email(email: string): string {
  return Buffer.from(email, 'utf8').toString('base64url')
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
