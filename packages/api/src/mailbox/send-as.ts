/**
 * Send-as aliases for a connected company mailbox (mailbox-imap.md →
 * "Send-as aliases").
 *
 * A Google Workspace / corporate mailbox often carries aliases
 * (`bd@` delivered into `contact@`). The bound account may reply AS one of
 * those aliases, but only from an explicit allowlist the mailbox owner wrote
 * on the connected card - the model can never invent a sender. The list
 * lives on `connector_instance.config.sendAsAliases` (JSONB, no migration):
 * bare lowercased addresses, deduped, capped, the account address itself
 * implicit and never listed.
 *
 * Two consumers read it: `mailbox-api.ts::sendMessage` (resolving `From`)
 * and the sync worker's brain router (the `is_bot` self-loop guard - a reply
 * sent as an alias and APPENDed to Sent must never re-fire an event
 * workflow). One reader, so the two can never disagree about what an alias is.
 *
 * [COMP:api/mailbox-connect-routes]
 */

export const MAX_SEND_AS_ALIASES = 16

/** Config key on `connector_instance.config`. */
export const SEND_AS_ALIASES_CONFIG_KEY = 'sendAsAliases'

const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

/** `Name <addr>` / `<addr>` / `addr` → bare lowercased `addr`. */
export function bareEmailAddress(mailbox: string): string {
  const angled = mailbox.match(/<([^<>\s]+@[^<>\s]+)>/)
  return (angled ? angled[1] : mailbox).trim().toLowerCase()
}

/** Read the configured aliases (already normalized at write time; re-normalized defensively). */
export function readSendAsAliases(config: Record<string, unknown> | null | undefined): string[] {
  const raw = config?.[SEND_AS_ALIASES_CONFIG_KEY]
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const bare = bareEmailAddress(v)
    if (bare && !out.includes(bare)) out.push(bare)
  }
  return out
}

export type NormalizeSendAsResult =
  | { ok: true; aliases: string[] }
  | { ok: false; error: string; invalid?: string[] }

/**
 * Validate + normalize a user-submitted alias list. Bare lowercased addresses,
 * deduped, the account address dropped (implicit), max `MAX_SEND_AS_ALIASES`.
 * Rejects the whole write when any entry is not an address so a typo cannot
 * silently vanish from the list the user thinks they saved.
 */
export function normalizeSendAsAliases(input: unknown, accountEmail: string): NormalizeSendAsResult {
  if (!Array.isArray(input)) return { ok: false, error: 'sendAsAliases must be an array of email addresses' }
  const account = bareEmailAddress(accountEmail)
  const aliases: string[] = []
  const invalid: string[] = []
  for (const v of input) {
    if (typeof v !== 'string') { invalid.push(String(v)); continue }
    const bare = bareEmailAddress(v)
    if (!bare) continue // blank rows are ignored, not errors
    if (!ADDRESS_RE.test(bare)) { invalid.push(v); continue }
    if (bare === account) continue
    if (!aliases.includes(bare)) aliases.push(bare)
  }
  if (invalid.length > 0) {
    return { ok: false, error: `Not an email address: ${invalid.join(', ')}`, invalid }
  }
  if (aliases.length > MAX_SEND_AS_ALIASES) {
    return { ok: false, error: `At most ${MAX_SEND_AS_ALIASES} send-as aliases` }
  }
  return { ok: true, aliases }
}

/**
 * The full set of addresses this mailbox may send as, account first. Case-
 * insensitive membership is what `sendMessage` checks an explicit `from`
 * against and what the reply-from-origin lookup scans the envelope for.
 */
export function senderIdentities(accountEmail: string, aliases: ReadonlyArray<string>): string[] {
  const out = [bareEmailAddress(accountEmail)]
  for (const a of aliases) {
    const bare = bareEmailAddress(a)
    if (bare && !out.includes(bare)) out.push(bare)
  }
  return out
}
