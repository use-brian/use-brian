/**
 * SMTP send for the mailbox connector (per-call transport, plan §3).
 *
 * The model composes `body` in markdown; it is rendered at this boundary via
 * `renderEmailBody` (`[COMP:channels/email-markdown]`, shared with the Gmail
 * and AgentMail lanes) into a `multipart/alternative` message. The message is
 * composed ONCE (MailComposer) so the exact bytes that went out can also be
 * appended to the IMAP Sent folder — SMTP submission does not save a sent
 * copy on most corporate servers, and the search default scope (INBOX + Sent)
 * depends on one existing.
 *
 * Raw SMTP has the same CR/LF header-injection surface the Gmail client
 * hardened: `sanitizeHeaderValue` strips embedded newlines from to/subject
 * (and the reply headers) before they reach the composer — belt over
 * nodemailer's own encoding.
 *
 * [COMP:api/mailbox-imap-client]
 */

import { createTransport } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { renderEmailBody } from '@use-brian/channels'
import type { MailboxAccountSettings } from './types.js'

/** Strip CR/LF so a crafted value can never inject an extra header line. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export type ComposedMailboxMessage = {
  /** The exact RFC 822 bytes sent — reusable for the IMAP Sent APPEND. */
  raw: Buffer
  messageId: string | null
  envelope: { from: string; to: string[] }
}

/**
 * Compose the outgoing message once. Exported for tests (multipart assembly,
 * reply headers, header hardening) — no network.
 */
export async function composeMailboxMessage(params: {
  from: string
  to: string[]
  /** Visible carbon-copy recipients — rendered as a real `Cc:` header. */
  cc?: string[]
  /** Blind carbon-copy — added to the SMTP envelope only, never a header (see below). */
  bcc?: string[]
  subject: string
  /** Markdown source. */
  body: string
  inReplyTo?: string
  references?: string[]
}): Promise<ComposedMailboxMessage> {
  const to = params.to.map(sanitizeHeaderValue).filter(Boolean)
  const cc = (params.cc ?? []).map(sanitizeHeaderValue).filter(Boolean)
  const bcc = (params.bcc ?? []).map(sanitizeHeaderValue).filter(Boolean)
  const subject = sanitizeHeaderValue(params.subject)
  const rendered = renderEmailBody(params.body)
  const composer = new MailComposer({
    from: params.from,
    to,
    // Cc is a visible header. Bcc is deliberately NOT handed to MailComposer:
    // the composed raw bytes are also APPENDed to the IMAP Sent folder, so a
    // `Bcc:` header here would leak the blind recipients to anyone reading the
    // Sent copy. Instead bcc addresses are added to the SMTP envelope only
    // (below) — they receive the message, no other recipient sees them.
    ...(cc.length ? { cc } : {}),
    subject,
    text: rendered.text,
    html: rendered.html,
    ...(params.inReplyTo ? { inReplyTo: sanitizeHeaderValue(params.inReplyTo) } : {}),
    ...(params.references?.length
      ? { references: params.references.map((r) => sanitizeHeaderValue(r)) }
      : {}),
  })
  const compiled = composer.compile()
  const raw = await compiled.build()
  const messageId = compiled.messageId() ?? null
  // Envelope RCPT TO must list every delivery recipient — to + cc + bcc — or
  // the copied/blind addresses would never actually receive the message.
  return { raw, messageId, envelope: { from: params.from, to: [...to, ...cc, ...bcc] } }
}

/**
 * Send a composed message over the account's SMTP endpoint (implicit TLS on
 * 465, STARTTLS otherwise). One transport per call — no pooling (plan §3).
 */
export async function sendComposedMessage(
  settings: MailboxAccountSettings,
  composed: ComposedMailboxMessage,
): Promise<void> {
  const transport = createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    auth: { user: settings.email, pass: settings.appPassword },
  })
  try {
    await transport.sendMail({ envelope: composed.envelope, raw: composed.raw })
  } finally {
    transport.close()
  }
}

/** Connect-time SMTP verification (login + EHLO), used by the connect route. */
export async function verifySmtpLogin(settings: MailboxAccountSettings): Promise<void> {
  const transport = createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    auth: { user: settings.email, pass: settings.appPassword },
  })
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}
