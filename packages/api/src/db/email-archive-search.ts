/** Owner-scoped hybrid mailbox recall, loaded on tool execution. [COMP:api/email-archive-store] */
import { queryWithRLS } from './client.js'
import {
  COVERAGE_PROBE_LIMIT,
  FULL_COVERAGE,
  buildSegmentCoverage,
  type SegmentCoverage,
} from './segment-coverage.js'
import { buildLexicalMatch, fuseByReciprocalRank, tokenizeSearchTerms } from './segment-lexical.js'

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
