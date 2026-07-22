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
import { verifySmtpLogin } from './smtp.js'
import type { MailboxAccountSettings, MailboxVerifyResult } from './types.js'

const DISABLED_MARKERS = /disabled|not enabled|unavailable|suspend|forbidden|denied|拒绝|禁用|未开启|未启用/i
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EDNS',
  'ESOCKET',
  'ECONNECTION',
])

function errText(err: unknown): string {
  if (err instanceof Error) {
    const withResponse = err as Error & { response?: string; responseText?: string }
    return [err.message, withResponse.response, withResponse.responseText].filter(Boolean).join(' ')
  }
  return String(err)
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code
}

function classifyAuthFailure(err: unknown): 'auth_failed' | 'access_disabled' {
  return DISABLED_MARKERS.test(errText(err)) ? 'access_disabled' : 'auth_failed'
}

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
