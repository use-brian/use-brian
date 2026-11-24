/**
 * `email-archive-store.ts` — the email archive corpus writer (mailbox-imap
 * connector, migration 359).
 *
 * Every synced message lands here (D5 — the archive gets ALL mail; the brain
 * only the rule-filtered flow). Two pieces:
 *   - `segmentEmailBody`: PURE packing of a message body into embedding-sized
 *     segments (shared `text-chunking` bounds; segment 0 carries a
 *     `Subject:`/`From:` header line so envelope context rides the vector).
 *   - `insertEmailArchiveMessage`: message row + segments in one transaction,
 *     idempotent on `(instance_id, provider_message_id)` (a re-synced UID is a
 *     no-op). Segments stamp `user_id = owner` / `assistant_id = NULL` — the
 *     person compartment (D7) enforced by the retrieval visibility double and
 *     the owner-scoped RLS policy.
 *
 * Runs on the system pool (the sync worker holds no per-user RLS context) —
 * the transcript-segments-store pattern.
 *
 * [COMP:api/email-archive-store]
 */

import { commitTransaction, getPool, query, queryWithRLS, rollbackAndRelease } from './client.js'
import { MAX_CHARS, splitLongText } from './text-chunking.js'
import type { MailboxSearchHit, MailboxSearchParams } from '@use-brian/core/tools/base/mailbox.js'
import { selectMailboxSearchCoverage } from '../mailbox/search-coverage.js'

export type EmailArchiveMessageInput = {
  instanceId: string
  workspaceId: string
  ownerUserId: string
  /** The worker pins its UID generation before inserting provider IDs. */
  archiveResetToken?: string | null
  /** A new bound account may replace only the stale ref it just fetched. */
  archiveReplaceBefore?: string
  folder: string
  /** Provider message id — IMAP: `<folder>:<uid>` (D13). */
  providerMessageId: string
  rfcMessageId?: string | null
  subject: string
  from: string
  to: string[]
  cc?: string[]
  sentAt?: Date | null
  bodyText: string
  inReplyTo?: string | null
  references?: string[]
  /** Metadata only — never content (D10). */
  attachments?: Array<{ filename: string; mime: string; size: number }>
  sensitivity?: string
}

function normalizeText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Pack a message body into segments. Segment 0 is prefixed with the envelope
 * header line (`Subject: … / From: …`) so a short or empty body still embeds
 * something searchable and every vector carries sender/subject context.
 */
export function segmentEmailBody(input: {
  subject: string
  from: string
  bodyText: string
}): string[] {
  const subject = normalizeText(input.subject)
  const from = normalizeText(input.from)
  const headerParts = [
    ...(subject ? [`Subject: ${subject}`] : []),
    ...(from ? [`From: ${from}`] : []),
  ]
  const header = headerParts.join(' / ')
  const body = normalizeText(input.bodyText)
  if (!body) return header ? [header] : []
  const withHeader = header ? `${header}\n${body}` : body
  if (withHeader.length <= MAX_CHARS) return [withHeader]
  const pieces = splitLongText(body)
  if (!header) return pieces
  return pieces.map((piece, i) => (i === 0 ? `${header}\n${piece}` : piece))
}

/**
 * Insert a synced message + its segments. Idempotent: an existing
 * `(instance_id, provider_message_id)` row short-circuits (returns false, no
 * segment writes). Segments leave `embedding` NULL for the async worker.
 */
export async function insertEmailArchiveMessage(
  input: EmailArchiveMessageInput,
): Promise<{ inserted: boolean; messageId: string | null; segmentCount: number }> {
  const segments = segmentEmailBody({ subject: input.subject, from: input.from, bodyText: input.bodyText })
  const sensitivity = input.sensitivity ?? 'internal'
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    if (input.archiveResetToken !== undefined) {
      const generation = await client.query(
        `SELECT id FROM connector_instance WHERE id = $1
           AND (config #>> '{mailboxSync,archiveResetToken}') IS NOT DISTINCT FROM $2::text
         FOR SHARE`, [input.instanceId, input.archiveResetToken],
      )
      if (generation.rowCount !== 1) throw new Error('Mailbox archive generation changed during insert')
    }
    if (input.archiveReplaceBefore) {
      await client.query(
        `DELETE FROM email_archive_messages WHERE instance_id = $1 AND owner_user_id = $2
           AND folder = $3 AND provider_message_id = $4 AND created_at < $5::timestamptz`,
        [input.instanceId, input.ownerUserId, input.folder, input.providerMessageId, input.archiveReplaceBefore],
      )
    }
    const res = await client.query<{ id: string }>(
      `INSERT INTO email_archive_messages (
         workspace_id, instance_id, owner_user_id, folder, provider_message_id,
         rfc_message_id, subject, from_addr, to_addrs, cc_addrs, sent_at,
         body_text, in_reply_to, references_ids, has_attachments, attachments
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       ON CONFLICT (instance_id, provider_message_id) DO NOTHING
       RETURNING id`,
      [
        input.workspaceId,
        input.instanceId,
        input.ownerUserId,
        input.folder,
        input.providerMessageId,
        input.rfcMessageId ?? null,
        input.subject,
        input.from,
        input.to,
        input.cc ?? [],
        input.sentAt ?? null,
        input.bodyText,
        input.inReplyTo ?? null,
        input.references ?? [],
        (input.attachments?.length ?? 0) > 0,
        JSON.stringify(input.attachments ?? []),
      ],
    )
    const messageId = res.rows[0]?.id ?? null
    if (!messageId) {
      await client.query('COMMIT')
      return { inserted: false, messageId: null, segmentCount: 0 }
    }
    // `valid_from` is the bi-temporal "when this became true", which for a mail
    // segment is when the message was SENT — not when we synced it. The
    // embedding drain keys its priority tier and its 12-month embed window on
    // this column for `email_segment` (D6): `created_at` is the sync clock, so
    // a backfill would stamp a decade of history with `now()` and drop the
    // whole archive into the "new writes first" tier at once. Clamped to the
    // present, because a future-dated `Date:` header (clock skew, or a forged
    // one) would otherwise hide the row from any as-of read.
    const validFrom =
      input.sentAt && input.sentAt.getTime() < Date.now() ? input.sentAt : new Date()
    for (let i = 0; i < segments.length; i++) {
      await client.query(
        `INSERT INTO email_archive_segments (
           workspace_id, message_id, instance_id, segment_index, segment_text,
           user_id, assistant_id, sensitivity, created_by_user_id, valid_from
         ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)
         ON CONFLICT (message_id, segment_index) DO NOTHING`,
        [
          input.workspaceId,
          messageId,
          input.instanceId,
          i,
          segments[i],
          input.ownerUserId,
          sensitivity,
          input.ownerUserId,
          validFrom,
        ],
      )
    }
    await client.query('COMMIT')
    return { inserted: true, messageId, segmentCount: segments.length }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Per-folder archive counts — completeness reconciliation vs server STATUS. */
export async function countEmailArchiveMessages(
  instanceId: string,
  archivedAfter?: string,
): Promise<{ total: number; byFolder: Record<string, number> }> {
  const res = await query<{ folder: string; n: string }>(
    `SELECT folder, COUNT(*)::text AS n
       FROM email_archive_messages
      WHERE instance_id = $1 ${archivedAfter ? 'AND created_at >= $2::timestamptz' : ''}
      GROUP BY folder`,
    archivedAfter ? [instanceId, archivedAfter] : [instanceId],
  )
  const byFolder: Record<string, number> = {}
  let total = 0
  for (const row of res.rows) {
    const n = Number(row.n)
    byFolder[row.folder] = n
    total += n
  }
  return { total, byFolder }
}

/** Bounded folder discovery with one composite-index seek per distinct path. */
export async function listEmailArchiveFolderPaths(instanceId: string, limit: number, archivedAfter?: string): Promise<string[] | null> {
  const current = archivedAfter ? 'AND created_at >= $3::timestamptz' : ''
  const result = await query<{ folder: string }>(`
    WITH RECURSIVE paths(folder, depth) AS (
      (SELECT folder, 1 FROM email_archive_messages
        WHERE instance_id = $1 ${current} ORDER BY folder LIMIT 1)
      UNION ALL
      SELECT following.folder, paths.depth + 1 FROM paths CROSS JOIN LATERAL (
        SELECT folder FROM email_archive_messages
         WHERE instance_id = $1 AND folder > paths.folder ${current} ORDER BY folder LIMIT 1
      ) following WHERE paths.depth <= $2
    ) SELECT folder FROM paths`, archivedAfter ? [instanceId, limit, archivedAfter] : [instanceId, limit])
  return result.rows.length > limit ? null : result.rows.map((row) => row.folder)
}

type LiteralArchiveMessageRow = {
  provider_message_id: string
  folder: string
  from_addr: string
  to_addrs: string[] | null
  sent_at: string | Date | null
  subject: string
  body_text: string
  rfc_message_id: string | null
  in_reply_to: string | null
  references_ids: string[] | null
  matched_segment: string | null
}

function literalArchiveHit(row: LiteralArchiveMessageRow): MailboxSearchHit {
  return {
    id: row.provider_message_id,
    folder: row.folder,
    from: row.from_addr,
    to: row.to_addrs ?? [],
    date: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    subject: row.subject,
    snippet: normalizeText(row.matched_segment ?? row.body_text).slice(0, 200) || undefined,
    messageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    references: row.references_ids ?? [],
  }
}

/** Read exactly the IMAP arrival-day UID set if its receipt and every row still exist. */
export async function searchCoveredEmailArchiveMessages(input: {
  ownerUserId: string
  instanceId: string
  accountKey: string
  rawCoverage: unknown
  seal: string
  params: MailboxSearchParams
  now?: Date
}): Promise<{ hits: MailboxSearchHit[]; verifiedAt: string } | null> {
  const proof = selectMailboxSearchCoverage({
    raw: input.rawCoverage, ownerUserId: input.ownerUserId, accountKey: input.accountKey,
    params: input.params, now: input.now ?? new Date(),
  })
  if (!proof) return null
  const result = await queryWithRLS<LiteralArchiveMessageRow>(input.ownerUserId, `
    WITH admitted AS MATERIALIZED (
      SELECT ci.id FROM connector_instance ci
       WHERE ci.id = $2 AND ci.user_id = $1 AND ci.connected AND ci.provider = 'imap'
         AND ci.config #> '{mailboxSync,searchCoverage}' = $3::jsonb
         AND ci.config #>> '{mailboxSync,searchCoverageSeal}' = $8
    ), matches AS MATERIALIZED (
      SELECT em.id, em.sent_at, em.provider_message_id, em.rfc_message_id
        FROM admitted CROSS JOIN unnest($4::text[], $5::text[]) AS wanted(folder, reference)
        CROSS JOIN LATERAL (
          SELECT message.id, message.sent_at, message.provider_message_id, message.rfc_message_id
            FROM email_archive_messages message
           WHERE message.instance_id = admitted.id AND message.owner_user_id = $1
             AND message.created_at >= $7::timestamptz
             AND message.provider_message_id = wanted.reference AND message.folder = wanted.folder
           LIMIT 1
        ) em
    )
    SELECT em.provider_message_id, em.folder, em.from_addr, em.to_addrs, em.sent_at,
           em.subject, LEFT(em.body_text, 1200) AS body_text, em.rfc_message_id, em.in_reply_to,
           em.references_ids, NULL::text AS matched_segment
      FROM admitted
      LEFT JOIN LATERAL (
        SELECT unique_mail.id, unique_mail.sent_at, unique_mail.provider_message_id
          FROM (
            SELECT DISTINCT ON (COALESCE('rfc:' || NULLIF(lower(btrim(matches.rfc_message_id)), ''), 'provider:' || matches.provider_message_id))
                   matches.id, matches.sent_at, matches.provider_message_id
              FROM matches
             ORDER BY COALESCE('rfc:' || NULLIF(lower(btrim(matches.rfc_message_id)), ''), 'provider:' || matches.provider_message_id),
                      matches.sent_at DESC NULLS LAST, matches.provider_message_id ASC
          ) unique_mail
         ORDER BY unique_mail.sent_at DESC NULLS LAST, unique_mail.provider_message_id ASC LIMIT $6
      ) chosen ON true
      LEFT JOIN email_archive_messages em ON em.id = chosen.id
     WHERE (SELECT COUNT(*) FROM matches) = cardinality($4::text[])
     ORDER BY chosen.sent_at DESC NULLS LAST, chosen.provider_message_id ASC`, [
    input.ownerUserId, input.instanceId, JSON.stringify(proof.coverage),
    proof.refs.map((ref) => ref.folder), proof.refs.map((ref) => ref.id), input.params.limit,
    proof.coverage.archivedAfter, input.seal,
  ])
  if (result.rows.length === 0) return null
  return { hits: result.rows.filter((row) => row.provider_message_id).map(literalArchiveHit), verifiedAt: proof.verifiedAt }
}

/**
 * Deterministic metadata/body search for the unified literal mailbox lane.
 * This intentionally needs no embedding. Keyword body predicates run against
 * the already-trigram-indexed segment corpus, while sender/subject predicates
 * stay on the message envelope so exact lookup cannot be ranked away.
 */
export async function searchLiteralEmailArchiveMessages(input: {
  ownerUserId: string
  instanceId: string
  archivedAfter?: string
  params: MailboxSearchParams
}): Promise<MailboxSearchHit[]> {
  const values: unknown[] = [input.ownerUserId, input.instanceId]
  const clauses = ['em.owner_user_id = $1', 'em.instance_id = $2']
  if (input.archivedAfter) {
    values.push(input.archivedAfter)
    clauses.push(`em.created_at >= $${values.length}::timestamptz`)
  }
  const containsPattern = (value: string) =>
    `%${value.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`
  const addLike = (column: string, value: string | undefined) => {
    if (!value?.trim()) return
    values.push(containsPattern(value))
    clauses.push(`${column} ILIKE $${values.length} ESCAPE E'\\\\'`)
  }
  addLike('em.from_addr', input.params.from)
  addLike('em.subject', input.params.subject)
  if (input.params.folder) {
    values.push(input.params.folder)
    clauses.push(`em.folder = $${values.length}`)
  }
  if (input.params.since) {
    values.push(input.params.since)
    clauses.push(`em.sent_at >= $${values.length}::timestamptz`)
  }
  if (input.params.before) {
    values.push(input.params.before)
    clauses.push(`em.sent_at < $${values.length}::timestamptz`)
  }
  const keywords = (input.params.keywords ?? []).map((term) => term.trim()).filter(Boolean)
  let literalRank = '0'
  let matchedSegment = 'NULL::text'
  if (keywords.length > 0) {
    const fromMatches: string[] = []
    const subjectMatches: string[] = []
    const segmentMatches: string[] = []
    const snippetMatches: string[] = []
    for (const keyword of keywords) {
      values.push(containsPattern(keyword))
      const p = `$${values.length}`
      fromMatches.push(`em.from_addr ILIKE ${p} ESCAPE E'\\\\'`)
      subjectMatches.push(`em.subject ILIKE ${p} ESCAPE E'\\\\'`)
      segmentMatches.push(`es.segment_text ILIKE ${p} ESCAPE E'\\\\'`)
      snippetMatches.push(`es_snippet.segment_text ILIKE ${p} ESCAPE E'\\\\'`)
    }
    const fromPredicate = `(${fromMatches.join(' OR ')})`
    const subjectPredicate = `(${subjectMatches.join(' OR ')})`
    const segmentPredicate = `EXISTS (
      SELECT 1
        FROM email_archive_segments es
       WHERE es.message_id = em.id
         AND es.retracted_at IS NULL
         AND (${segmentMatches.join(' OR ')})
    )`
    clauses.push(`(${fromPredicate} OR ${subjectPredicate} OR ${segmentPredicate})`)
    literalRank = `CASE
      WHEN ${fromPredicate} THEN 0
      WHEN ${subjectPredicate} THEN 1
      ELSE 2
    END`
    matchedSegment = `(
      SELECT es_snippet.segment_text
        FROM email_archive_segments es_snippet
       WHERE es_snippet.message_id = em.id
         AND es_snippet.retracted_at IS NULL
         AND (${snippetMatches.join(' OR ')})
       ORDER BY es_snippet.segment_index ASC
       LIMIT 1
    )`
  }
  values.push(input.params.limit)
  const limitIdx = values.length
  const res = await queryWithRLS<LiteralArchiveMessageRow>(
    input.ownerUserId,
    `SELECT em.provider_message_id, em.folder, em.from_addr, em.to_addrs, em.sent_at,
            em.subject, em.body_text, em.rfc_message_id, em.in_reply_to, em.references_ids,
            ${literalRank} AS literal_rank, ${matchedSegment} AS matched_segment
       FROM email_archive_messages em
      WHERE ${clauses.join(' AND ')}
      ORDER BY literal_rank ASC, em.sent_at DESC NULLS LAST
      LIMIT $${limitIdx}`,
    values,
  )
  return res.rows.map(literalArchiveHit)
}

/**
 * Return the subset of a bounded IMAP UID window that is already archived.
 *
 * Backfill uses this lightweight reconciliation before requesting message
 * bodies. The unique constraint remains the final race/crash belt, but a
 * routine resync should not spend bandwidth downloading 100k messages merely
 * to discover that every insert is a no-op.
 */
export async function findArchivedEmailUids(
  instanceId: string,
  folder: string,
  uids: number[],
  archivedAfter?: string,
): Promise<Set<number>> {
  if (uids.length === 0) return new Set()
  const refs = uids.map((uid) => `${folder}:${uid}`)
  const res = await query<{ provider_message_id: string }>(
    `SELECT provider_message_id
       FROM email_archive_messages
      WHERE instance_id = $1
        AND folder = $2
        AND provider_message_id = ANY($3::text[]) ${archivedAfter ? 'AND created_at >= $4::timestamptz' : ''}`,
    archivedAfter ? [instanceId, folder, refs, archivedAfter] : [instanceId, folder, refs],
  )
  const found = new Set<number>()
  for (const row of res.rows) {
    const i = row.provider_message_id.lastIndexOf(':')
    const uid = Number(row.provider_message_id.slice(i + 1))
    if (Number.isSafeInteger(uid) && uid > 0) found.add(uid)
  }
  return found
}

/**
 * Drop a folder's rows (segments cascade). The UIDVALIDITY-change recovery:
 * the folder's UIDs were reassigned server-side, so its archive is rebuilt
 * from scratch — other folders untouched, never corrupted (§5).
 */
export async function deleteEmailArchiveFolder(
  instanceId: string,
  folder: string,
  reset?: { previous: string | null; next: string; lastSyncAt: string | null },
): Promise<number | null> {
  if (reset) {
    const client = await getPool().connect()
    let committed = false
    try {
      await client.query('BEGIN')
      const current = await client.query(
        `SELECT id FROM connector_instance
          WHERE id = $1
            AND (config #>> '{mailboxSync,archiveResetToken}') IS NOT DISTINCT FROM $2::text
            AND (config #>> '{mailboxSync,lastSyncAt}') IS NOT DISTINCT FROM $3::text
          FOR UPDATE`, [instanceId, reset.previous, reset.lastSyncAt],
      )
      if (current.rowCount !== 1) {
        await commitTransaction(client)
        committed = true
        return null
      }
      // Run DELETE after acquiring the generation lock so the statement's
      // snapshot includes old-generation inserts that committed while waiting.
      const removed = await client.query(
        'DELETE FROM email_archive_messages WHERE instance_id = $1 AND folder = $2', [instanceId, folder],
      )
      await client.query(
        `UPDATE connector_instance
            SET config = jsonb_set(config, '{mailboxSync}', (config->'mailboxSync' - 'searchCoverage' - 'searchCoverageSeal')
              || jsonb_build_object('archiveResetToken', $2::text))
          WHERE id = $1`, [instanceId, reset.next],
      )
      await commitTransaction(client)
      committed = true
      return removed.rowCount ?? 0
    } finally {
      if (committed) client.release()
      else await rollbackAndRelease(client)
    }
  }
  const res = await query(
    `DELETE FROM email_archive_messages WHERE instance_id = $1 AND folder = $2`,
    [instanceId, folder],
  )
  return res.rowCount ?? 0
}
