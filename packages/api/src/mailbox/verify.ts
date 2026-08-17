/**
 * Connect-time verification: live IMAP login + SMTP verify BEFORE the
 * credential is stored (plan §4 — green check or a NAMED error, never a
 * stored-but-dead credential). Two failure classes are product copy in the
 * connect dialog: wrong-password (`auth_failed`) and admin-gated third-party
 * access (`access_disabled`); classification is heuristic over the server's
 * response text, defaulting to `auth_failed`.
 *
 * [COMP:api/mailbox-connect-routes]
 */

import { ImapFlow } from 'imapflow'
import {
  MAILBOX_UNREACHABLE_CODES,
  classifyMailboxAuthFailure,
  mailboxErrorCode,
  mailboxErrorText,
} from '@use-brian/core'
import { attachSessionErrorSink, type ImapClientLike } from './imap-session.js'
import { verifySmtpLogin } from './smtp.js'
import type { MailboxAccountSettings, MailboxVerifyResult } from './types.js'

// The classifier (disabled-account markers, unreachable-host codes, server
// text extraction) is shared with the runtime tools' failure copy — one
// vocabulary for the connect dialog and for what the model reads. It lives in
// core (`tools/base/_mailbox-error.ts`) so both sides can import it.
const UNREACHABLE_CODES = MAILBOX_UNREACHABLE_CODES
const errText = mailboxErrorText
const errCode = mailboxErrorCode
const classifyAuthFailure = classifyMailboxAuthFailure

export type VerifyMailboxDeps = {
  /** Injectable legs for unit tests. Defaults hit the network. */
  verifyImap?: (settings: MailboxAccountSettings) => Promise<void>
  verifySmtp?: (settings: MailboxAccountSettings) => Promise<void>
}

async function defaultVerifyImap(settings: MailboxAccountSettings): Promise<void> {
  const client = new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: true,
    auth: { user: settings.email, pass: settings.appPassword },
    logger: false,
    verifyOnly: true,
  })
  // While `connect()` is pending imapflow's own `initialReject` owns the error
  // path, so a failed login rejects here and is classified below. The moment it
  // resolves that ownership ends and any later failure becomes a bare `'error'`
  // EVENT — which Node rethrows as an uncaughtException when unlistened, taking
  // the process down. This route runs on the user-traffic service, so the sink
  // goes on before `connect()`, not after. See `attachSessionErrorSink`.
  attachSessionErrorSink(client as unknown as ImapClientLike, settings.email)
  await client.connect()
  try {
    await client.logout()
  } catch {
    client.close()
  }
}

export async function verifyMailboxConnection(
  settings: MailboxAccountSettings,
  deps?: VerifyMailboxDeps,
): Promise<MailboxVerifyResult> {
  const verifyImap = deps?.verifyImap ?? defaultVerifyImap
  const verifySmtp = deps?.verifySmtp ?? verifySmtpLogin

  try {
    await verifyImap(settings)
  } catch (err) {
    const code = errCode(err)
    if (code && UNREACHABLE_CODES.has(code)) {
      return { ok: false, code: 'unreachable', message: errText(err) }
    }
    if ((err as { authenticationFailed?: boolean })?.authenticationFailed) {
      return { ok: false, code: classifyAuthFailure(err), message: errText(err) }
    }
    return { ok: false, code: 'imap_failed', message: errText(err) }
  }

  try {
    await verifySmtp(settings)
  } catch (err) {
    const code = errCode(err)
    if (code === 'EAUTH') {
      return { ok: false, code: classifyAuthFailure(err), message: errText(err) }
    }
    if (code && UNREACHABLE_CODES.has(code)) {
      return { ok: false, code: 'unreachable', message: errText(err) }
    }
    return { ok: false, code: 'smtp_failed', message: errText(err) }
  }

  return { ok: true }
}
