/**
 * SMTP client — sends auth emails via Google Workspace SMTP.
 *
 * Authenticates as a primary Workspace user using an app password (2FA must
 * be enabled on that user; the password is provisioned at
 * https://myaccount.google.com/apppasswords). The `From:` header is the
 * aliased address (e.g. `auth@sidan.ai`) — Gmail honors it because the
 * alias is registered as a "Send mail as" identity on the authenticating
 * user. Deliverability depends on SPF/DKIM/DMARC for `sidan.ai` being set
 * up in Workspace admin.
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
 * Build a nodemailer transport for Gmail / Google Workspace SMTP.
 *
 * `smtp.gmail.com:587` with STARTTLS is the standard endpoint. App
 * password is the simplest auth — alternatives (OAuth2, IP-allowlisted
 * relay) require more setup and aren't worth it at current volume.
 */
export function createWorkspaceSmtpTransport(opts: {
  user: string
  appPassword: string
}): SmtpTransport {
  const transporter: Transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS upgrade — not implicit TLS
    auth: { user: opts.user, pass: opts.appPassword },
  })
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
        // "sidanclaw - <workspace>" instead of the bare alias local-part.
        from: {
          name: `sidanclaw - ${inviteOpts.workspaceName}`,
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
