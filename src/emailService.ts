import { appConfig } from './config.js'

export type SendEmailInput = {
  to: string
  subject: string
  text?: string
  html?: string
  replyTo?: string | null
  /** Forwarded as SES EmailTags / SMTP X-Tag-* headers for delivery analytics. */
  tags?: Record<string, string>
  /**
   * Optional override of the auto-generated `Message-ID` header. When omitted,
   * a UUID-based id under the From-domain is generated so receivers can
   * correlate webhook events back to our send log.
   */
  messageId?: string | null
}

export type SendEmailResult = {
  provider: 'ses' | 'smtp'
  messageId: string | null
}

function requireBody(input: SendEmailInput): void {
  if (!input.text && !input.html) {
    throw new Error('email text or html body is required')
  }
}

async function sendWithSes(input: SendEmailInput): Promise<SendEmailResult> {
  if (!appConfig.awsSesAccessKeyId || !appConfig.awsSesSecretAccessKey) {
    throw new Error('SES email provider is missing AWS_SES_ACCESS_KEY_ID or AWS_SES_SECRET_ACCESS_KEY')
  }

  const endpoint = `https://email.${appConfig.awsSesRegion}.amazonaws.com/v2/email/outbound-emails`
  const replyTo = input.replyTo ?? appConfig.emailReplyTo
  const body = {
    FromEmailAddress: appConfig.emailFrom,
    Destination: { ToAddresses: [input.to] },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    ConfigurationSetName: appConfig.awsSesConfigurationSet ?? undefined,
    EmailTags: Object.entries(input.tags ?? {}).map(([Name, Value]) => ({ Name, Value })),
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Text: input.text ? { Data: input.text, Charset: 'UTF-8' } : undefined,
          Html: input.html ? { Data: input.html, Charset: 'UTF-8' } : undefined,
        },
      },
    },
  }

  const payload = JSON.stringify(body)
  const { AwsClient } = await import('aws4fetch')
  const aws = new AwsClient({
    accessKeyId: appConfig.awsSesAccessKeyId,
    secretAccessKey: appConfig.awsSesSecretAccessKey,
    region: appConfig.awsSesRegion,
    service: 'ses',
  })
  const response = await aws.fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`SES send failed: ${response.status} ${responseText}`)
  }
  const data = responseText ? JSON.parse(responseText) as { MessageId?: string } : {}
  return { provider: 'ses', messageId: data.MessageId ?? null }
}

async function sendWithSmtp(input: SendEmailInput): Promise<SendEmailResult> {
  if (!appConfig.smtpHost || !appConfig.smtpUser || !appConfig.smtpPass) {
    throw new Error('SMTP email provider is missing SMTP_HOST, SMTP_USER, or SMTP_PASS')
  }
  const { default: nodemailer } = await import('nodemailer')
  const transport = nodemailer.createTransport({
    host: appConfig.smtpHost,
    port: appConfig.smtpPort,
    secure: appConfig.smtpSecure,
    auth: { user: appConfig.smtpUser, pass: appConfig.smtpPass },
    connectionTimeout: 20_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  })
  const replyTo = input.replyTo ?? appConfig.emailReplyTo ?? undefined
  const messageId = input.messageId ?? generateMessageId(appConfig.emailFrom)
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.tags ?? {})) {
    if (!value) continue
    headers[`X-Tag-${key}`] = value
  }
  try {
    const result = await transport.sendMail({
      from: appConfig.emailFrom,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo,
      messageId,
      headers,
    })
    return { provider: 'smtp', messageId: result.messageId ?? messageId }
  } finally {
    transport.close()
  }
}

function generateMessageId(fromAddress: string): string {
  const match = fromAddress.match(/<([^>]+)>/)
  const addr = match?.[1] ?? fromAddress
  const domain = addr.split('@')[1]?.trim() || 'tokenqiao.com'
  const rand = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`
  return `<${rand}@${domain}>`
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  requireBody(input)
  if (appConfig.emailProvider === 'disabled') {
    throw new Error('email provider is disabled')
  }
  if (appConfig.emailProvider === 'ses') {
    return await sendWithSes(input)
  }
  return await sendWithSmtp(input)
}
