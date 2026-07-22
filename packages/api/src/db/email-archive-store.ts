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
import { MAX_CHARS, splitLongText } from './text-chunking.js'

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
    for (let i = 0; i < segments.length; i++) {
      await client.query(
        `INSERT INTO email_archive_segments (
           workspace_id, message_id, instance_id, segment_index, segment_text,
           user_id, assistant_id, sensitivity, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8)
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
// Hybrid recall over the archive (the searchFileSegments arm-fusion shape:
// vector soft-fails + ILIKE, deduped, MMR disabled) — but OWNER-gated, not
// workspace-gated. A mailbox is a person's (D7): the authority is
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

export async function searchEmailArchive(
  input: SearchEmailArchiveInput,
  deps?: { embedder?: { embed(texts: string[]): Promise<number[][]> } },
): Promise<EmailArchiveHit[]> {
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
  const vectorHits: Array<EmailArchiveHit & { rank: number }> = []
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
        for (const r of res.rows) {
          vectorHits.push({ ...toEmailArchiveHit(r), rank: Number(r.distance ?? Infinity) })
        }
      }
    } catch (err) {
      console.warn(
        '[searchEmailArchive] vector arm failed; ILIKE-only:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ILIKE arm — immediate; newest mail first (recency is the natural order
  // for a mailbox, unlike a document's segment order).
  const likeValues: unknown[] = []
  const likeWhere = baseSql(likeValues)
  likeValues.push(`%${text}%`)
  const likeIdx = likeValues.length
  likeValues.push(topK)
  const likeLimIdx = likeValues.length
  const likeRes = await queryWithRLS<EmailArchiveRow>(
    input.ownerUserId,
    `SELECT ${selectCols}
       FROM email_archive_segments es
       JOIN email_archive_messages m ON m.id = es.message_id
      WHERE ${likeWhere}
        AND (es.segment_text ILIKE $${likeIdx} OR m.subject ILIKE $${likeIdx})
      ORDER BY m.sent_at DESC NULLS LAST, es.segment_index
      LIMIT $${likeLimIdx}`,
    likeValues,
  )

  const key = (h: EmailArchiveHit) => `${h.provider_message_id}#${h.segment_index}`
  const fused = new Map<string, EmailArchiveHit & { rank: number }>()
  for (const v of vectorHits) fused.set(key(v), v)
  for (const r of likeRes.rows) {
    const hit = toEmailArchiveHit(r)
    if (!fused.has(key(hit))) fused.set(key(hit), { ...hit, rank: Infinity })
  }
  return [...fused.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, topK)
    .map(({ rank: _rank, ...hit }) => hit)
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
