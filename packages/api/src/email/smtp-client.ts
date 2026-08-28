/**
 * SMTP client for auth and workspace invitation emails.
 *
 * See docs/architecture/platform/auth.md → "Email magic-link flow".
 * Component tag: [COMP:api/smtp-client].
 */

import { createTransport, type Transporter } from 'nodemailer'
import type { MagicLinkLocale } from '../db/magic-link-store.js'
import { renderMagicLinkEmail } from './magic-link-template.js'
import {
  renderWorkspaceInviteEmail,
  type WorkspaceInviteLocale,
  type WorkspaceInviteRole,
} from './workspace-invite-template.js'

// ── Types ──────────────────────────────────────────────────────

/**
 * Minimal transport surface so tests can substitute a mock without
 * carrying the full nodemailer API.
 *
 * `from` accepts nodemailer's object form so callers can attach a display
 * name — nodemailer handles RFC 5322 quoting and RFC 2047 encoding of
 * non-ASCII names (ja/zh workspace names), which a hand-built
 * `"name" <addr>` string would get wrong.
 */
export interface SmtpTransport {
  sendMail(opts: {
    from: string | { name: string; address: string }
    to: string
    subject: string
    html: string
    text: string
  }): Promise<unknown>
}

export type SmtpClient = {
  sendMagicLink(to: string, link: string, locale?: MagicLinkLocale, code?: string): Promise<void>
  /**
   * Send a workspace-invitation email. Rejects on transport failure; the
   * invitation row already exists, so callers fire-and-forget and log.
   */
  sendWorkspaceInvitation(
    to: string,
    opts: {
      link: string
      workspaceName: string
      inviterName: string | null
      role: WorkspaceInviteRole
      message: string | null
      locale?: WorkspaceInviteLocale
    },
  ): Promise<void>
}

// ── Transport construction ─────────────────────────────────────

/**
 * Resolve provider-neutral SMTP settings. The defaults retain the original
 * Gmail STARTTLS behavior for existing deployments.
 */
export function resolveSmtpTransportOptions(opts: {
  host?: string
  port?: string | number
  secure?: boolean
  user: string
  password: string
}) {
  const rawPort = opts.port ?? 587
  const port = typeof rawPort === 'number' ? rawPort : Number(rawPort.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535')
  }
  return {
    host: opts.host?.trim() || 'smtp.gmail.com',
    port,
    secure: opts.secure ?? false,
    auth: { user: opts.user, pass: opts.password },
  }
}

export function createSmtpTransport(opts: Parameters<typeof resolveSmtpTransportOptions>[0]): SmtpTransport {
  const transporter: Transporter = createTransport(resolveSmtpTransportOptions(opts))
  return {
    async sendMail(o) {
      const result = (await transporter.sendMail(o)) as {
        messageId?: string
        response?: string
        accepted?: unknown[]
        rejected?: unknown[]
        envelope?: { from?: string; to?: string[] }
      }
      if (result.rejected && result.rejected.length > 0) {
        console.warn(`[smtp-client] SMTP server reported rejected recipients: ${JSON.stringify(result.rejected)}`)
      }
      return result
    },
  }
}

// ── Client factory ─────────────────────────────────────────────

export function createSmtpClient(opts: {
  transport: SmtpTransport
  /** The `From:` header. Should be an alias registered with the auth user. */
  fromAddress: string
}): SmtpClient {
  return {
    async sendMagicLink(to, link, locale = 'en', code) {
      const { subject, html, text } = renderMagicLinkEmail(link, locale, code)
      await opts.transport.sendMail({
        from: opts.fromAddress,
        to,
        subject,
        html,
        text,
      })
    },
    async sendWorkspaceInvitation(to, inviteOpts) {
      const { subject, html, text } = renderWorkspaceInviteEmail({
        link: inviteOpts.link,
        workspaceName: inviteOpts.workspaceName,
        inviterName: inviteOpts.inviterName,
        role: inviteOpts.role,
        message: inviteOpts.message,
        locale: inviteOpts.locale ?? 'en',
      })
      await opts.transport.sendMail({
        // Display name carries the workspace so the inbox row reads
        // "Use Brian - <workspace>" instead of the bare alias local-part.
        from: {
          name: `Use Brian - ${inviteOpts.workspaceName}`,
          address: opts.fromAddress,
        },
        to,
        subject,
        html,
        text,
      })
    },
  }
}
