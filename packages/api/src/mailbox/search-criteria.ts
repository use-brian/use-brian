/**
 * IMAP search-criteria compilation (pure — no network).
 *
 * D12 #2: `keywords: string[]` compiles into ONE nested IMAP `OR` tree so a
 * synonym set costs a single round trip. IMAP's `OR` takes exactly two
 * operands, so N terms become a right-nested pair chain; imapflow's
 * `SearchObject.or` mirrors that shape.
 *
 * [COMP:api/mailbox-imap-client]
 */

import type { MailboxSearchParams } from '@use-brian/core'

/** The subset of imapflow's SearchObject this module emits. */
export type ImapSearchQuery = {
  since?: Date
  before?: Date
  from?: string
  subject?: string
  /** TEXT <keyword> — matches headers + body server-side. */
  text?: string
  or?: ImapSearchQuery[]
}

/** Right-nested OR pair chain over TEXT terms: [a,b,c] → OR a (OR b c). */
export function compileKeywordOrTree(keywords: string[]): ImapSearchQuery | null {
  const terms = keywords.map((k) => k.trim()).filter(Boolean)
  if (terms.length === 0) return null
  if (terms.length === 1) return { text: terms[0] }
  const last = terms[terms.length - 1]
  let tree: ImapSearchQuery = { text: last }
  for (let i = terms.length - 2; i >= 0; i--) {
    tree = { or: [{ text: terms[i] }, tree] }
  }
  return tree
}

function parseDay(day: string | undefined): Date | undefined {
  if (!day) return undefined
  const d = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** Whether any term needs a non-ASCII charset (the BADCHARSET-fallback trigger). */
export function hasNonAsciiTerm(params: Pick<MailboxSearchParams, 'keywords' | 'from' | 'subject'>): boolean {
  const terms = [...(params.keywords ?? []), params.from ?? '', params.subject ?? '']
  // eslint-disable-next-line no-control-regex
  return terms.some((t) => /[^\x00-\x7F]/.test(t))
}

/** Compile the seam's search params into one imapflow search query. */
export function buildImapSearchQuery(params: MailboxSearchParams): ImapSearchQuery {
  const query: ImapSearchQuery = {}
  const since = parseDay(params.since)
  const before = parseDay(params.before)
  if (since) query.since = since
  if (before) query.before = before
  if (params.from?.trim()) query.from = params.from.trim()
  if (params.subject?.trim()) query.subject = params.subject.trim()
  const orTree = params.keywords ? compileKeywordOrTree(params.keywords) : null
  if (orTree) {
    if (orTree.or) query.or = orTree.or
    else if (orTree.text) query.text = orTree.text
  }
  return query
}
