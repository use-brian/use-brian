/**
 * Mailbox (imap connector) ingest filters — composed with `universalFilters`
 * by the sync worker's brain router. The archive gets EVERY message (D5);
 * these filters only decide what additionally flows to the brain:
 *
 *   - `is_noreply` — machine senders (no-reply / mailer-daemon / postmaster /
 *     bounces / notifications local-parts, and unparseable senders). The
 *     seeded default DROPS these — notification noise never reaches the
 *     brain. Pattern list mirrors `isNoReplyAddress` in
 *     `packages/channels/src/email/address.ts` (core cannot import channels).
 *   - `is_bulk` — newsletter/bulk markers (a List-Unsubscribe header or
 *     `Precedence: bulk/list`). The seeded default routes these to the
 *     weekday digest.
 *
 * Real correspondence (neither) falls through to the `always → realtime`
 * catchall. See docs/architecture/integrations/mailbox-imap.md → "Brain
 * routing".
 *
 * [COMP:brain/source-adapters/mailbox]
 */

import type { FilterRegistry, IngestEvent } from '../../filters.js'

const MACHINE_LOCAL_PARTS =
  /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce(s)?([-+].*)?|notification(s)?|alert(s)?|newsletter|marketing|listserv|list-request)([-+@.].*)?$/i

/** Exported for the sync worker's tests. */
export function isMachineSenderAddress(address: string): boolean {
  const at = address.lastIndexOf('@')
  if (at <= 0) return true // unparseable sender counts as machine (fail toward drop)
  const local = address.slice(0, at).trim()
  return MACHINE_LOCAL_PARTS.test(local)
}

function normalizedString(event: IngestEvent, key: string): string | null {
  const v = event.normalized[key]
  return typeof v === 'string' ? v : null
}

export const mailboxFilterImplementations: FilterRegistry = Object.freeze({
  is_noreply: (event) => {
    const sender = normalizedString(event, 'sender')
    return sender === null || isMachineSenderAddress(sender)
  },
  is_bulk: (event) => {
    return event.normalized.is_bulk === true
  },
})
