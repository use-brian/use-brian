/**
 * Mailbox (IMAP/SMTP) connector — shared types for the API-side seam
 * implementation. The core tool surface consumes `MailboxApi` from
 * `@use-brian/core`; everything in this directory implements that seam with
 * imapflow (IMAP) + nodemailer (SMTP) + mailparser (MIME/charset decode).
 *
 * Spec: docs/architecture/integrations/mailbox-imap.md.
 */

/** One connected mailbox account — decrypted `type:'imap'` connector credentials. */
export type MailboxAccountSettings = {
  email: string
  appPassword: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
}

/** A connect-time preset resolved from the address domain's MX records (D1). */
export type MailboxPreset = {
  /** Stable preset id — drives the per-preset app-password recipe in the UI. */
  presetId: 'alimail'
  label: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
}

export type MailboxVerifyResult =
  | { ok: true }
  | {
      ok: false
      /**
       * Named failure classes — the connect dialog renders product copy per
       * code, never the raw failure (plan §4):
       * - auth_failed: wrong password (use the generated client security
       *   password, not the login password)
       * - access_disabled: the tenant admin has not enabled third-party
       *   client access / IMAP service
       * - unreachable: DNS/TCP/TLS failure reaching the host
       * - imap_failed / smtp_failed: verified halfway — the named leg failed
       */
      code: 'auth_failed' | 'access_disabled' | 'unreachable' | 'imap_failed' | 'smtp_failed'
      message: string
    }
