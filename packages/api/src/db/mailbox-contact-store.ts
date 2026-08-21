/**
 * Preview candidates for the explicit mailbox-archive to CRM import.
 * Envelope-only, owner-scoped, access-aware, and independent of embeddings.
 *
 * [COMP:api/mailbox-contact-import-store]
 */

import { isMachineSenderAddress, type AccessContext } from '@use-brian/core'
import { buildAccessPredicate } from './access-predicate.js'
import { queryGated, queryWithRLS } from './client.js'
import { bareEmailAddress } from '../mailbox/send-as.js'

export type MailboxContactCandidate = {
  name: string
  email: string
  messageCount: number
  lastSentAt: string | null
}

type SenderRow = { from_addr: string; message_count: string; last_sent_at: Date | string | null }

function displayName(from: string, email: string): string {
  const angle = from.lastIndexOf('<')
  const raw = angle > 0 ? from.slice(0, angle).trim().replace(/^['"]|['"]$/g, '') : ''
  if (raw) return raw.slice(0, 256)
  const local = email.slice(0, email.indexOf('@')).replace(/[._-]+/g, ' ').trim()
  return (local || email).slice(0, 256)
}

export async function listMailboxContactImportCandidates(input: {
  ownerUserId: string
  instanceId: string
  accountEmail: string
  access: AccessContext
  scanLimit?: number
}): Promise<{ candidates: MailboxContactCandidate[]; scanCapped: boolean }> {
  const scanLimit = Math.min(Math.max(input.scanLimit ?? 2_000, 1), 5_000)
  const senders = await queryWithRLS<SenderRow>(
    input.ownerUserId,
    `SELECT from_addr, count(*)::text AS message_count, max(sent_at) AS last_sent_at
       FROM email_archive_messages
      WHERE owner_user_id = $1 AND instance_id = $2 AND from_addr <> ''
      GROUP BY from_addr
      ORDER BY max(sent_at) DESC NULLS LAST
      LIMIT $3`,
    [input.ownerUserId, input.instanceId, scanLimit + 1],
  )
  const byEmail = new Map<string, MailboxContactCandidate>()
  const own = bareEmailAddress(input.accountEmail)
  for (const row of senders.rows.slice(0, scanLimit)) {
    const email = bareEmailAddress(row.from_addr)
    if (!email || email === own || isMachineSenderAddress(email)) continue
    const existing = byEmail.get(email)
    const candidate = {
      name: displayName(row.from_addr, email),
      email,
      messageCount: Number(row.message_count),
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
    }
    if (!existing || (candidate.lastSentAt ?? '') > (existing.lastSentAt ?? '')) {
      byEmail.set(email, candidate)
    }
  }
  const candidates = [...byEmail.values()]
  if (candidates.length === 0) {
    return { candidates: [], scanCapped: senders.rows.length > scanLimit }
  }

  const ap = buildAccessPredicate(input.access, { alias: 'e', startIdx: 1 })
  const emails = candidates.map((candidate) => candidate.email)
  const existing = await queryGated<{ email: string }>(
    input.access,
    `SELECT lower(COALESCE(e.attributes->>'email', e.canonical_id)) AS email
       FROM entities e
      WHERE ${ap.sql}
        AND e.kind = 'person'
        AND e.valid_to IS NULL
        AND e.retracted_at IS NULL
        AND lower(COALESCE(e.attributes->>'email', e.canonical_id)) = ANY($${ap.nextIdx}::text[])`,
    [...ap.params, emails],
  )
  const existingEmails = new Set(existing.rows.map((row) => row.email))
  return {
    candidates: candidates.filter((candidate) => !existingEmails.has(candidate.email)),
    scanCapped: senders.rows.length > scanLimit,
  }
}
