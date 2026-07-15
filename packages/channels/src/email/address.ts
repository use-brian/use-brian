/**
 * Email address helpers — pure, dependency-free (like the rest of
 * packages/channels). Used by the email adapter and the webhook route's
 * sender gate + loop caps.
 *
 * See docs/architecture/integrations/agentmail.md → "Email as a channel".
 * Component tag: [COMP:channels/email]
 */

/**
 * Extract the bare lowercase address from an RFC-5322-ish mailbox string:
 * `"Ada Lovelace <ada@acme.com>"` → `ada@acme.com`; a bare address passes
 * through lowercased/trimmed. Returns null when nothing address-shaped is
 * present.
 */
export function parseEmailAddress(mailbox: string | null | undefined): string | null {
  if (!mailbox) return null
  const angled = mailbox.match(/<([^<>\s]+@[^<>\s]+)>/)
  const candidate = (angled ? angled[1] : mailbox).trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null
}

/** The display-name half of a mailbox string, when present. */
export function parseEmailDisplayName(mailbox: string | null | undefined): string | null {
  if (!mailbox) return null
  const m = mailbox.match(/^\s*"?([^"<>]+?)"?\s*<[^<>]+>\s*$/)
  const name = m?.[1]?.trim()
  return name && name.length > 0 ? name : null
}

/**
 * Machine-sender patterns the assistant must NEVER reply to (mail-storm loop
 * cap, plan §6): no-reply variants, bounce handlers, mailer daemons, and
 * list-server addresses.
 */
const NO_REPLY_LOCAL_PATTERNS = [
  /^no-?reply/i,
  /^do-?not-?reply/i,
  /^mailer-daemon/i,
  /^postmaster/i,
  /^bounces?([-+.]|$)/i,
  /^notifications?([-+.]|$)/i,
  /^listserv/i,
]

export function isNoReplyAddress(address: string | null | undefined): boolean {
  const parsed = parseEmailAddress(address)
  if (!parsed) return true // unparseable sender: fail closed, never reply
  const local = parsed.split('@')[0]
  return NO_REPLY_LOCAL_PATTERNS.some((p) => p.test(local))
}
