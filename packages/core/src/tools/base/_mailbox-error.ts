/**
 * IMAP / SMTP failures classified once, rendered as model-actionable text.
 *
 * The connect-time verifier (`packages/api/src/mailbox/verify.ts`) already
 * knew how to read a mail server's answer — `authenticationFailed` from
 * imapflow, `EAUTH` from nodemailer, the admin-gated "IMAP disabled" wording,
 * the unreachable-host socket codes — but the runtime tools threw that
 * knowledge away and returned `Email account error: <raw server text>`
 * (`Invalid credentials (Failure)`, `[AUTHENTICATIONFAILED] …`, `ETIMEDOUT`).
 * The model then guessed between a wrong password, a blocked account and a
 * network blip, and could not tell whether a send had gone out.
 *
 * This module is the one classifier both sides consume: `verify.ts` for its
 * connect-dialog codes, and `tools/base/mailbox.ts` (+ the archive-search /
 * sync tools in the api package) for their failure copy. It lives in core
 * because the tools are in core and core cannot import api. Standard:
 * docs/architecture/engine/tool-executor.md → "Failure copy".
 *
 * Health-classifier markers: an `auth_failed` rendering carries `invalid or
 * expired` (and the server's own `AUTHENTICATIONFAILED` when present) so the
 * connector-health probe flips a dead app password to `auth_failed` from the
 * flattened tool result; `access_disabled` deliberately does NOT — an admin
 * gate is not a dead credential, and reconnecting cannot fix it.
 *
 * Component tag: [COMP:tools/mailbox-error].
 */

/** Wording servers use when the ACCOUNT is gated, not the password wrong. */
export const MAILBOX_DISABLED_MARKERS = /disabled|not enabled|unavailable|suspend|forbidden|denied|拒绝|禁用|未开启|未启用/i

/** Socket / DNS codes that mean the host was never reached. */
export const MAILBOX_UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EDNS',
  'ESOCKET',
  'ECONNECTION',
  'EAI_AGAIN',
])

export type MailboxFailureKind =
  | 'auth_failed'
  | 'access_disabled'
  | 'unreachable'
  | 'transient'
  | 'not_found'
  | 'rejected'
  | 'unknown'

/** The server's own words: message + imapflow `responseText` / nodemailer `response`. */
export function mailboxErrorText(err: unknown): string {
  if (err instanceof Error) {
    const withResponse = err as Error & { response?: unknown; responseText?: unknown }
    return [err.message, withResponse.response, withResponse.responseText]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return String(err)
}

export function mailboxErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Wrong password vs admin-gated access, over the server text. Used by the
 * connect-time verifier for its two product-copy codes and by the runtime
 * renderer below.
 */
export function classifyMailboxAuthFailure(err: unknown): 'auth_failed' | 'access_disabled' {
  return MAILBOX_DISABLED_MARKERS.test(mailboxErrorText(err)) ? 'access_disabled' : 'auth_failed'
}

/** True when the server refused the LOGIN / AUTH itself (imapflow or nodemailer). */
export function isMailboxAuthError(err: unknown): boolean {
  const flagged = err as { authenticationFailed?: unknown; code?: unknown } | null
  if (flagged?.authenticationFailed === true) return true
  if (flagged?.code === 'EAUTH') return true
  return /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|535[- ]/i.test(mailboxErrorText(err))
}

export function classifyMailboxFailure(err: unknown): MailboxFailureKind {
  const code = mailboxErrorCode(err)
  if (isMailboxAuthError(err)) return classifyMailboxAuthFailure(err)
  if (code && MAILBOX_UNREACHABLE_CODES.has(code)) return 'unreachable'
  const text = mailboxErrorText(err)
  if (/\b(NONEXISTENT|TRYCREATE|Mailbox doesn't exist|does not exist|No such (mailbox|folder)|not found)\b/i.test(text)) return 'not_found'
  if (/\b(5\d\d[- ]|Message rejected|Recipient address rejected|User unknown|Relay access denied|Sender address rejected|blocked using|spam)\b/i.test(text)) return 'rejected'
  if (/\b(4\d\d[- ]|timeout|timed out|Too many|throttl|rate limit|temporar|try again later|UNAVAILABLE|SERVERBUG|Connection closed|Connection not available|ECONNRESET|socket)\b/i.test(text)) return 'transient'
  return 'unknown'
}

export type MailboxFailureContext = {
  /** The tool that was running. */
  tool: string
  /** The mailbox address the call ran against. */
  email?: string
  /** What the call was about: `message <id>`, `folder "Sent"`, `the message to a@b.c`. */
  target?: string
  /** The tool sends mail — the copy must say outright that nothing went out. */
  send?: boolean
}

/**
 * Render an IMAP / SMTP failure as the three-part copy + verdict. `send`
 * prefixes "The email was NOT sent." on every kind except the ambiguous
 * ones (unreachable / transient after the DATA phase), which say so.
 */
export function describeMailboxError(err: unknown, ctx: MailboxFailureContext): string {
  const account = ctx.email ? `mailbox ${ctx.email}` : 'the connected mailbox'
  const doing = ctx.target ? `\`${ctx.tool}\` on ${ctx.target}` : `\`${ctx.tool}\``
  const text = mailboxErrorText(err)
  const code = mailboxErrorCode(err)
  const said = text ? ` The server said: "${text.length > 300 ? `${text.slice(0, 299)}…` : text}".` : ''
  const notSent = ctx.send ? 'The email was NOT sent. ' : ''

  switch (classifyMailboxFailure(err)) {
    case 'auth_failed':
      return `${notSent}${account} rejected the stored login while running ${doing} (${code ?? 'AUTHENTICATIONFAILED'}): the app password is invalid or expired, or was revoked.${said} Reconnect the mailbox with a fresh app password (Studio → Connectors) — retrying will not help until then; tell the user.`
    case 'access_disabled':
      return `${notSent}${account} refused the login for ${doing} because the account is gated, not because the password is wrong (${code ?? 'access_disabled'}): IMAP / SMTP or third-party app access is disabled for it by the provider or an admin.${said} Retrying will not help — the user (or their admin) must enable IMAP / SMTP or third-party access in the mail provider's settings, then reconnect; tell the user which.`
    case 'unreachable':
      return `${notSent ? 'The email was almost certainly NOT sent: ' : ''}${account} could not be reached for ${doing} (${code}): the mail server host did not answer.${said} Nothing about the arguments is wrong — this is a network / DNS / host problem. Retry once after a short wait; if it persists, tell the user the mail server is unreachable.`
    case 'not_found':
      return `${notSent}${account} has no ${ctx.target ?? 'such message or folder'} (${code ?? 'not found'}).${said} Either the id / folder name is wrong or the message was moved or deleted. Search again (\`imapSearchMessages\`, or the folder list) for a current id / name; retrying this exact one will keep failing.`
    case 'rejected':
      return `${notSent}${account} — the server rejected ${doing} (${code ?? 'rejected'}).${said} This is a policy rejection (recipient unknown, relay refused, content blocked), not a transient failure: fix the recipient / content the server named, or ask the user; the same message will be rejected the same way.`
    case 'transient':
      return `${ctx.send ? 'The email may or may not have been sent — check the Sent folder (or ask the recipient) before resending. ' : ''}${account} failed ${doing} with a temporary server error (${code ?? 'transient'}).${said} Nothing about the arguments is wrong. Retry once after a short wait; if it persists, tell the user.`
    default:
      return `${notSent}${account} failed ${doing}${code ? ` (${code})` : ''}: ${text || 'unknown error'}. Check the arguments against that message before retrying; if it names nothing to fix, tell the user rather than looping.`
  }
}

/** `{ data, isError: true }` frame around `describeMailboxError`. */
export function mailboxFailure(err: unknown, ctx: MailboxFailureContext): { data: string; isError: true } {
  return { data: describeMailboxError(err, ctx), isError: true }
}
