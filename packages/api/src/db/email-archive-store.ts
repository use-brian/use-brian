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

import { getPool, query, queryWithRLS } from './client.js'
import {
  COVERAGE_PROBE_LIMIT,
  FULL_COVERAGE,
  buildSegmentCoverage,
  type SegmentCoverage,
} from './segment-coverage.js'
import { buildLexicalMatch, fuseByReciprocalRank, tokenizeSearchTerms } from './segment-lexical.js'
import { MAX_CHARS, splitLongText } from './text-chunking.js'
import type { MailboxSearchHit, MailboxSearchParams } from '@use-brian/core'

export type EmailArchiveMessageInput = {
  instanceId: string
  workspaceId: string
  ownerUserId: string
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
): Promise<{ total: number; byFolder: Record<string, number> }> {
  const res = await query<{ folder: string; n: string }>(
    `SELECT folder, COUNT(*)::text AS n
       FROM email_archive_messages
      WHERE instance_id = $1
      GROUP BY folder`,
    [instanceId],
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

type ExactArchiveMessageRow = {
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
}

/**
 * Exact metadata/body fallback for a live provider search that is known to
 * return false-empty results. This is intentionally not semantic search: it
 * needs no embedding and preserves the caller's structured predicates.
 */
export async function searchExactEmailArchiveMessages(input: {
  ownerUserId: string
  instanceId: string
  params: MailboxSearchParams
}): Promise<MailboxSearchHit[]> {
  const values: unknown[] = [input.ownerUserId, input.instanceId]
  const clauses = ['owner_user_id = $1', 'instance_id = $2']
  const addLike = (column: string, value: string | undefined) => {
    if (!value?.trim()) return
    values.push(`%${value.trim()}%`)
    clauses.push(`${column} ILIKE $${values.length}`)
  }
  addLike('from_addr', input.params.from)
  addLike('subject', input.params.subject)
  if (input.params.folder) {
    values.push(input.params.folder)
    clauses.push(`folder = $${values.length}`)
  }
  if (input.params.since) {
    values.push(input.params.since)
    clauses.push(`sent_at >= $${values.length}::timestamptz`)
  }
  if (input.params.before) {
    values.push(input.params.before)
    clauses.push(`sent_at < $${values.length}::timestamptz`)
  }
  const keywords = (input.params.keywords ?? []).map((term) => term.trim()).filter(Boolean)
  if (keywords.length > 0) {
    const matches: string[] = []
    for (const keyword of keywords) {
      values.push(`%${keyword}%`)
      const p = `$${values.length}`
      matches.push(`(body_text ILIKE ${p} OR subject ILIKE ${p} OR from_addr ILIKE ${p})`)
    }
    clauses.push(`(${matches.join(' OR ')})`)
  }
  values.push(input.params.limit)
  const limitIdx = values.length
  const res = await queryWithRLS<ExactArchiveMessageRow>(
    input.ownerUserId,
    `SELECT provider_message_id, folder, from_addr, to_addrs, sent_at,
            subject, body_text, rfc_message_id, in_reply_to, references_ids
       FROM email_archive_messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY sent_at DESC NULLS LAST
      LIMIT $${limitIdx}`,
    values,
  )
  return res.rows.map((row) => ({
    id: row.provider_message_id,
    folder: row.folder,
    from: row.from_addr,
    to: row.to_addrs ?? [],
    date: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    subject: row.subject,
    snippet: normalizeText(row.body_text).slice(0, 200) || undefined,
    messageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    references: row.references_ids ?? [],
  }))
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
): Promise<Set<number>> {
  if (uids.length === 0) return new Set()
  const refs = uids.map((uid) => `${folder}:${uid}`)
  const res = await query<{ provider_message_id: string }>(
    `SELECT provider_message_id
       FROM email_archive_messages
      WHERE instance_id = $1
        AND folder = $2
        AND provider_message_id = ANY($3::text[])`,
    [instanceId, folder, refs],
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
): Promise<number> {
  const res = await query(
    `DELETE FROM email_archive_messages WHERE instance_id = $1 AND folder = $2`,
    [instanceId, folder],
  )
  return res.rowCount ?? 0
}

// ── searchEmailArchive ─────────────────────────────────────────
//
// Hybrid recall over the archive: a vector arm that soft-fails, a TOKENIZED
// lexical arm over the existing trgm GIN (`segment-lexical.ts`), fused by
// reciprocal rank, plus a coverage verdict (`segment-coverage.ts`) saying
// whether the vector arm actually saw the whole filter scope. Both helpers are
// shared across the segment corpora rather than living here — transcripts and
// files are the same shape, and an external-archive move must not take them
// with it. OWNER-gated, not workspace-gated. A mailbox is a person's (D7): the
// authority is
// `user_id = owner` on the segments (belt) plus the owner-scoped RLS policy
// via queryWithRLS (braces) — another member's search returns zero rows
// regardless of workspace. No sensitivity ceiling: like the live imapSearch*
// tools, the assistant is acting as the owner on the owner's own mail.

const EMAIL_ARCHIVE_TOPK_DEFAULT = 8
const EMAIL_ARCHIVE_TOPK_MAX = 20

export type EmailArchiveHit = {
  /** Provider message ref (`folder:uid`) — pass to imapGetMessage for the full message. */
  provider_message_id: string
  folder: string
  subject: string
  from_addr: string
  sent_at: string | Date | null
  segment_index: number
  segment_text: string
}

type EmailArchiveRow = EmailArchiveHit & { distance?: number | string | null }

export type SearchEmailArchiveInput = {
  ownerUserId: string
  instanceId: string
  query: string
  topK?: number
  from?: string
  since?: string
  before?: string
}

export type SearchEmailArchiveResult = {
  hits: EmailArchiveHit[]
  /**
   * Whether the vector arm saw the whole filter scope. Non-null `note` when it
   * did not — the model must be able to tell "nothing matched" from "not
   * everything has been indexed yet" (D9), which matters permanently now that
   * the embed budget makes partial embedding a designed state rather than a
   * transient one.
   */
  coverage: SegmentCoverage
}

export async function searchEmailArchive(
  input: SearchEmailArchiveInput,
  deps?: { embedder?: { embed(texts: string[]): Promise<number[][]> } },
): Promise<SearchEmailArchiveResult> {
  const topK = Math.min(Math.max(input.topK ?? EMAIL_ARCHIVE_TOPK_DEFAULT, 1), EMAIL_ARCHIVE_TOPK_MAX)
  const text = input.query.trim()

  const baseSql = (values: unknown[]): string => {
    values.push(input.ownerUserId)
    const ownerIdx = values.length
    values.push(input.instanceId)
    const instIdx = values.length
    const clauses = [
      `es.user_id = $${ownerIdx}`,
      `es.instance_id = $${instIdx}`,
      'es.retracted_at IS NULL',
    ]
    if (input.from?.trim()) {
      values.push(`%${input.from.trim()}%`)
      clauses.push(`m.from_addr ILIKE $${values.length}`)
    }
    if (input.since) {
      values.push(input.since)
      clauses.push(`m.sent_at >= $${values.length}::timestamptz`)
    }
    if (input.before) {
      values.push(input.before)
      clauses.push(`m.sent_at < $${values.length}::timestamptz`)
    }
    return clauses.join(' AND ')
  }

  const selectCols =
    'm.provider_message_id, m.folder, m.subject, m.from_addr, m.sent_at, es.segment_index, es.segment_text'

  // Vector arm — soft-fails to [] (no embedder, empty query, embed error).
  // Ordered by distance, so its array position IS its rank for the fusion.
  const vectorHits: EmailArchiveHit[] = []
  if (deps?.embedder && text.length > 0) {
    try {
      const [embedding] = await deps.embedder.embed([text])
      if (embedding && embedding.length > 0) {
        const values: unknown[] = []
        const where = baseSql(values)
        values.push(`[${embedding.join(',')}]`)
        const vecIdx = values.length
        values.push(topK)
        const limIdx = values.length
        const res = await queryWithRLS<EmailArchiveRow>(
          input.ownerUserId,
          `SELECT ${selectCols}, es.embedding <=> $${vecIdx}::vector AS distance
             FROM email_archive_segments es
             JOIN email_archive_messages m ON m.id = es.message_id
            WHERE ${where}
              AND es.embedding IS NOT NULL
            ORDER BY es.embedding <=> $${vecIdx}::vector
            LIMIT $${limIdx}`,
          values,
        )
        for (const r of res.rows) vectorHits.push(toEmailArchiveHit(r))
      }
    } catch (err) {
      console.warn(
        '[searchEmailArchive] vector arm failed; lexical-only:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Lexical arm — the query TOKENIZED, not matched as one substring (B6). The
  // old `segment_text ILIKE '%<whole query>%'` fired only when the entire
  // natural-language question appeared verbatim, which left the vector arm
  // doing all the work — untenable once the embed budget makes partial
  // embedding a designed steady state.
  const terms = tokenizeSearchTerms(text)
  const lexicalHits: EmailArchiveHit[] = []
  if (terms.length > 0) {
    const values: unknown[] = []
    const where = baseSql(values)
    const match = buildLexicalMatch({
      terms,
      columns: ['es.segment_text', 'm.subject', 'm.from_addr'],
      values,
    })!
    values.push(topK)
    const limIdx = values.length
    const res = await queryWithRLS<EmailArchiveRow>(
      input.ownerUserId,
      `SELECT ${selectCols}, (${match.hits}) AS term_hits
         FROM email_archive_segments es
         JOIN email_archive_messages m ON m.id = es.message_id
        WHERE ${where}
          AND ${match.where}
        ORDER BY term_hits DESC, m.sent_at DESC NULLS LAST, es.segment_index
        LIMIT $${limIdx}`,
      values,
    )
    for (const r of res.rows) lexicalHits.push(toEmailArchiveHit(r))
  }

  // Reciprocal-rank fusion (B6): a passage both arms found outranks one either
  // arm found strongly, and the two orderings become comparable without
  // normalizing a cosine distance against a term count.
  const hits = fuseByReciprocalRank(
    [vectorHits, lexicalHits],
    (h) => `${h.provider_message_id}#${h.segment_index}`,
  ).slice(0, topK)

  return { hits, coverage: await probeCoverage(input, baseSql) }
}

/**
 * Count unembedded rows inside the query's OWN filter scope (B7).
 *
 * Scope matters: a corpus-wide backlog says nothing about whether *this*
 * search was degraded, while "unembedded rows matching this owner, this
 * mailbox, this date range" does. Bounded by `COVERAGE_PROBE_LIMIT` so the
 * probe cannot become the expensive part of a cheap search — the note only
 * needs "some" versus "a lot".
 *
 * Best-effort: a failed probe reports full coverage rather than failing the
 * search. Claiming complete coverage we cannot verify is the lesser evil only
 * because the alternative is returning nothing at all; it is logged.
 */
async function probeCoverage(
  input: SearchEmailArchiveInput,
  baseSql: (values: unknown[]) => string,
): Promise<SegmentCoverage> {
  try {
    const values: unknown[] = []
    const where = baseSql(values)
    values.push(COVERAGE_PROBE_LIMIT)
    const limIdx = values.length
    const res = await queryWithRLS<{ n: string }>(
      input.ownerUserId,
      `SELECT count(*)::text AS n FROM (
         SELECT 1
           FROM email_archive_segments es
           JOIN email_archive_messages m ON m.id = es.message_id
          WHERE ${where}
            AND es.embedding IS NULL
            AND es.embedding_failed_at IS NULL
          LIMIT $${limIdx}
       ) s`,
      values,
    )
    return buildSegmentCoverage(Number(res.rows[0]?.n ?? 0), 'mailbox archive')
  } catch (err) {
    console.warn(
      '[searchEmailArchive] coverage probe failed; reporting full coverage:',
      err instanceof Error ? err.message : String(err),
    )
    return FULL_COVERAGE
  }
}

function toEmailArchiveHit(r: EmailArchiveRow): EmailArchiveHit {
  return {
    provider_message_id: r.provider_message_id,
    folder: r.folder,
    subject: r.subject,
    from_addr: r.from_addr,
    sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    segment_index: Number(r.segment_index),
    segment_text: r.segment_text,
  }
}
