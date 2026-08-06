/**
 * Provider-neutral chat archive reads (WhatsApp / WeChat, migration 395).
 *
 * Every public read is owner-bound twice: an explicit owner predicate and the
 * owner-scoped RLS policy through queryWithRLS. Search combines the platform's
 * existing segment-corpus primitives: tokenized trigram recall, pgvector,
 * reciprocal-rank fusion, a candidate-only recency arm, and MMR diversity.
 *
 * [COMP:api/chat-archive-store]
 */

import {
  DEFAULT_MMR_LAMBDA,
  RRF_METHOD,
  mmrRerank,
  rrfFuse,
} from '@use-brian/core'
import { queryWithRLS } from './client.js'
import {
  COVERAGE_PROBE_LIMIT,
  FULL_COVERAGE,
  buildSegmentCoverage,
  type SegmentCoverage,
} from './segment-coverage.js'
import { buildLexicalMatch, tokenizeSearchTerms } from './segment-lexical.js'

const TOP_K_DEFAULT = 8
const TOP_K_MAX = 20
const CANDIDATE_MAX = 80

export type ChatDirection = 'inbound' | 'outbound'
export type ChatKind = 'text' | 'image' | 'video' | 'voice' | 'file' | 'link'

export type ChatArchiveMediaCoverage = {
  total: number
  ready: number
  pending: number
  missing: number
  failed: number
  unsupported: number
}

export type ChatArchiveHit = {
  segment_id: string
  message_id: string
  instance_id: string
  source: string
  provider_message_id: string
  conversation_id: string
  sender_id: string
  sender_display: string | null
  sent_at: string
  direction: ChatDirection
  kind: string
  body_text: string | null
  media_ref: unknown | null
  reply_to_provider_id: string | null
  segment_index: number
  segment_text: string
  segment_metadata: Record<string, unknown>
  media_asset: {
    asset_id: string
    upload_status: string
    extraction_status: string
    last_error: string | null
  } | null
}

type ChatArchiveRow = Omit<ChatArchiveHit, 'sent_at' | 'segment_index'> & {
  sent_at: string | Date
  segment_index: number | string
  distance?: number | string | null
}

export type SearchChatArchiveInput = {
  ownerUserId: string
  query: string
  topK?: number
  source?: string
  instanceId?: string
  conversationId?: string
  sender?: string
  direction?: ChatDirection
  kind?: ChatKind
  since?: string
  before?: string
}

export type SearchChatArchiveResult = {
  hits: ChatArchiveHit[]
  embeddingCoverage: SegmentCoverage
  mediaCoverage: ChatArchiveMediaCoverage
}

type ChatEmbedder = { embed(texts: string[]): Promise<number[][]> }

/** Hybrid owner-scoped recall across chat archive segments. */
export async function searchChatArchive(
  input: SearchChatArchiveInput,
  deps?: { embedder?: ChatEmbedder },
): Promise<SearchChatArchiveResult> {
  const topK = Math.min(Math.max(input.topK ?? TOP_K_DEFAULT, 1), TOP_K_MAX)
  const candidateLimit = Math.min(topK * 4, CANDIDATE_MAX)
  const text = input.query.trim()
  const baseWhere = buildSearchWhere(input)
  const selectCols = `
    s.id::text AS segment_id,
    m.id::text AS message_id,
    m.instance_id::text AS instance_id,
    m.source,
    m.provider_message_id,
    m.conversation_id,
    m.sender_id,
    m.sender_display,
    m.sent_at,
    m.direction,
    m.kind,
    m.body_text,
    m.media_ref,
    m.reply_to_provider_id,
    s.segment_index,
    s.segment_text,
    s.metadata AS segment_metadata,
    CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
      'asset_id', a.id,
      'upload_status', a.upload_status,
      'extraction_status', a.extraction_status,
      'last_error', a.last_error
    ) END AS media_asset`

  const vectorRows: ChatArchiveRow[] = []
  if (deps?.embedder && text) {
    try {
      const [embedding] = await deps.embedder.embed([text])
      if (embedding?.length) {
        const values: unknown[] = []
        const where = baseWhere(values)
        values.push(`[${embedding.join(',')}]`)
        const vectorIdx = values.length
        values.push(candidateLimit)
        const limitIdx = values.length
        const res = await queryWithRLS<ChatArchiveRow>(
          input.ownerUserId,
          `SELECT ${selectCols}, s.embedding <=> $${vectorIdx}::vector AS distance
             FROM chat_archive_segments s
             JOIN chat_archive_messages m ON m.id = s.message_id
             LEFT JOIN chat_archive_media_assets a ON a.message_id = m.id
            WHERE ${where}
              AND s.embedding IS NOT NULL
            ORDER BY s.embedding <=> $${vectorIdx}::vector
            LIMIT $${limitIdx}`,
          values,
        )
        vectorRows.push(...res.rows)
      }
    } catch (err) {
      console.warn(
        '[searchChatArchive] vector arm failed; lexical-only:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  const lexicalRows: ChatArchiveRow[] = []
  const terms = tokenizeSearchTerms(text)
  if (terms.length > 0) {
    const values: unknown[] = []
    const where = baseWhere(values)
    const match = buildLexicalMatch({
      terms,
      columns: ['s.segment_text', 'm.sender_display', 'm.sender_id'],
      values,
    })!
    values.push(candidateLimit)
    const limitIdx = values.length
    const res = await queryWithRLS<ChatArchiveRow>(
      input.ownerUserId,
      `SELECT ${selectCols}, (${match.hits}) AS term_hits
         FROM chat_archive_segments s
         JOIN chat_archive_messages m ON m.id = s.message_id
         LEFT JOIN chat_archive_media_assets a ON a.message_id = m.id
        WHERE ${where}
          AND ${match.where}
        ORDER BY term_hits DESC, m.sent_at DESC, s.segment_index
        LIMIT $${limitIdx}`,
      values,
    )
    lexicalRows.push(...res.rows)
  }

  // An exact sender-name/id query is an identity lookup, not a broad semantic
  // discovery request. Keep the candidate set focused on that person so MMR
  // does not replace their conversation with superficially similar messages
  // from unrelated chats (the common "Who is X?" path).
  const normalizedQuery = normalizeIdentity(text)
  const exactSenderRows = normalizedQuery
    ? lexicalRows.filter((row) =>
        [row.sender_display, row.sender_id].some(
          (value) => normalizeIdentity(value ?? '') === normalizedQuery,
        ),
      )
    : []
  const focusedSender = exactSenderRows.length > 0
  const rankedVectorRows = focusedSender ? [] : vectorRows
  const rankedLexicalRows = focusedSender ? exactSenderRows : lexicalRows

  const candidates = new Map<string, ChatArchiveRow>()
  for (const row of [...rankedVectorRows, ...rankedLexicalRows]) candidates.set(row.segment_id, row)
  const recentIds = [...candidates.values()]
    .sort((a, b) => toMillis(b.sent_at) - toMillis(a.sent_at))
    .map((row) => row.segment_id)

  const fused = rrfFuse([
    {
      method: RRF_METHOD.vector,
      ranked: rankedVectorRows.map((row) => row.segment_id),
    },
    {
      method: RRF_METHOD.fts,
      ranked: rankedLexicalRows.map((row) => row.segment_id),
    },
    {
      method: RRF_METHOD.recency,
      // Candidate-only: recency may reorder retrieved evidence, never create a
      // match for an unrelated recent message.
      ranked: recentIds,
    },
  ])

  const maxScore = fused[0]?.score ?? 1
  const diversified = mmrRerank(
    fused.flatMap((item) => {
      const row = candidates.get(item.id)
      return row ? [{ ...row, id: item.id, relevance: item.score / maxScore }] : []
    }),
    {
      k: topK,
      // Exact identity lookup wants several pieces of evidence from the same
      // conversation; general discovery still benefits from diversity.
      lambda: focusedSender ? 1 : Math.max(DEFAULT_MMR_LAMBDA, 0.75),
      sim: chatCandidateSimilarity,
    },
  )

  return {
    hits: diversified.map(toChatArchiveHit),
    embeddingCoverage: await probeEmbeddingCoverage(input, baseWhere),
    mediaCoverage: await probeMediaCoverage(input, baseWhere),
  }
}

async function probeMediaCoverage(
  input: SearchChatArchiveInput,
  baseWhere: (values: unknown[]) => string,
): Promise<ChatArchiveMediaCoverage> {
  const empty = { total: 0, ready: 0, pending: 0, missing: 0, failed: 0, unsupported: 0 }
  try {
    const values: unknown[] = []
    const where = baseWhere(values)
    const result = await queryWithRLS<Record<keyof ChatArchiveMediaCoverage, string>>(
      input.ownerUserId,
      `SELECT
         (count(DISTINCT m.id) FILTER (WHERE m.media_ref IS NOT NULL))::text AS total,
         (count(DISTINCT m.id) FILTER (WHERE a.extraction_status = 'ready'))::text AS ready,
         (count(DISTINCT m.id) FILTER (
           WHERE a.id IS NOT NULL
             AND (a.upload_status IN ('uploading','uploaded') OR a.extraction_status IN ('pending','processing'))
         ))::text AS pending,
         (count(DISTINCT m.id) FILTER (
           WHERE m.media_ref->>'availability' = 'missing'
              OR (a.id IS NULL AND NOT (m.media_ref ? 'availability'))
         ))::text AS missing,
         (count(DISTINCT m.id) FILTER (
           WHERE m.media_ref->>'availability' = 'failed'
              OR a.upload_status = 'failed' OR a.extraction_status = 'failed'
         ))::text AS failed,
         (count(DISTINCT m.id) FILTER (WHERE a.extraction_status = 'unsupported'))::text AS unsupported
       FROM chat_archive_segments s
       JOIN chat_archive_messages m ON m.id = s.message_id
       LEFT JOIN chat_archive_media_assets a ON a.message_id = m.id
       WHERE ${where}`,
      values,
    )
    const row = result.rows[0]
    if (!row) return empty
    return Object.fromEntries(
      Object.keys(empty).map((key) => [key, Number(row[key as keyof ChatArchiveMediaCoverage] ?? 0)]),
    ) as ChatArchiveMediaCoverage
  } catch (err) {
    console.warn('[searchChatArchive] media coverage probe failed:', err instanceof Error ? err.message : String(err))
    return empty
  }
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

function buildSearchWhere(
  input: SearchChatArchiveInput,
): (values: unknown[]) => string {
  return (values: unknown[]): string => {
    values.push(input.ownerUserId)
    const ownerIdx = values.length
    const clauses = [
      `s.user_id = $${ownerIdx}::uuid`,
      `m.owner_user_id = $${ownerIdx}::uuid`,
      's.retracted_at IS NULL',
    ]
    if (input.source?.trim()) {
      values.push(input.source.trim().toLowerCase())
      clauses.push(`lower(m.source) = $${values.length}`)
    }
    if (input.instanceId) {
      values.push(input.instanceId)
      clauses.push(`m.instance_id = $${values.length}::uuid`)
    }
    if (input.conversationId?.trim()) {
      values.push(input.conversationId.trim())
      clauses.push(`m.conversation_id = $${values.length}`)
    }
    if (input.sender?.trim()) {
      values.push(`%${input.sender.trim()}%`)
      clauses.push(`(m.sender_id ILIKE $${values.length} OR m.sender_display ILIKE $${values.length})`)
    }
    if (input.direction) {
      values.push(input.direction)
      clauses.push(`m.direction = $${values.length}`)
    }
    if (input.kind) {
      values.push(input.kind)
      clauses.push(`m.kind = $${values.length}`)
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
}

async function probeEmbeddingCoverage(
  input: SearchChatArchiveInput,
  baseWhere: (values: unknown[]) => string,
): Promise<SegmentCoverage> {
  try {
    const values: unknown[] = []
    const where = baseWhere(values)
    values.push(COVERAGE_PROBE_LIMIT)
    const limitIdx = values.length
    const res = await queryWithRLS<{ n: string }>(
      input.ownerUserId,
      `SELECT count(*)::text AS n FROM (
         SELECT 1
           FROM chat_archive_segments s
           JOIN chat_archive_messages m ON m.id = s.message_id
          WHERE ${where}
            AND s.embedding IS NULL
            AND s.embedding_failed_at IS NULL
          LIMIT $${limitIdx}
       ) pending`,
      values,
    )
    return buildSegmentCoverage(Number(res.rows[0]?.n ?? 0), 'chat archive')
  } catch (err) {
    console.warn(
      '[searchChatArchive] coverage probe failed; reporting full coverage:',
      err instanceof Error ? err.message : String(err),
    )
    return FULL_COVERAGE
  }
}

function chatCandidateSimilarity(a: ChatArchiveRow, b: ChatArchiveRow): number {
  if (a.segment_id === b.segment_id) return 1
  let similarity = 0
  if (a.instance_id === b.instance_id && a.conversation_id === b.conversation_id) similarity += 0.65
  if (a.sender_id && a.sender_id === b.sender_id) similarity += 0.15
  if (a.source === b.source) similarity += 0.05
  return Math.min(similarity, 1)
}

function toChatArchiveHit(row: ChatArchiveRow): ChatArchiveHit {
  return {
    segment_id: row.segment_id,
    message_id: row.message_id,
    instance_id: row.instance_id,
    source: row.source,
    provider_message_id: row.provider_message_id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    sender_display: row.sender_display,
    sent_at: new Date(row.sent_at).toISOString(),
    direction: row.direction,
    kind: row.kind,
    body_text: row.body_text,
    media_ref: row.media_ref,
    reply_to_provider_id: row.reply_to_provider_id,
    segment_index: Number(row.segment_index),
    segment_text: row.segment_text,
    segment_metadata: row.segment_metadata ?? {},
    media_asset: row.media_asset ?? null,
  }
}

function toMillis(value: string | Date): number {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

// ── Contextual get ─────────────────────────────────────────────

export type ChatArchiveMessage = Omit<ChatArchiveHit,
  'segment_id' | 'segment_index' | 'segment_text' | 'segment_metadata' | 'media_asset'>

type ChatArchiveMessageRow = Omit<ChatArchiveMessage, 'sent_at'> & { sent_at: string | Date }

const MESSAGE_COLS = `
  m.id::text AS message_id,
  m.instance_id::text AS instance_id,
  m.source,
  m.provider_message_id,
  m.conversation_id,
  m.sender_id,
  m.sender_display,
  m.sent_at,
  m.direction,
  m.kind,
  m.body_text,
  m.media_ref,
  m.reply_to_provider_id`

export type GetChatMessageResult = {
  target: ChatArchiveMessage
  messages: ChatArchiveMessage[]
  targetIndex: number
}

/** Return one archive message plus bounded chronological neighbors. */
export async function getChatMessageWithContext(input: {
  ownerUserId: string
  messageId: string
  before?: number
  after?: number
}): Promise<GetChatMessageResult | null> {
  const before = Math.min(Math.max(input.before ?? 5, 0), 20)
  const after = Math.min(Math.max(input.after ?? 5, 0), 20)
  const targetRes = await queryWithRLS<ChatArchiveMessageRow>(
    input.ownerUserId,
    `SELECT ${MESSAGE_COLS}
       FROM chat_archive_messages m
      WHERE m.id = $2::uuid AND m.owner_user_id = $1::uuid`,
    [input.ownerUserId, input.messageId],
  )
  const targetRow = targetRes.rows[0]
  if (!targetRow) return null

  const commonValues = [
    input.ownerUserId,
    targetRow.instance_id,
    targetRow.conversation_id,
    targetRow.sent_at,
    targetRow.message_id,
  ]
  const beforeRes = before > 0
    ? await queryWithRLS<ChatArchiveMessageRow>(
        input.ownerUserId,
        `SELECT ${MESSAGE_COLS}
           FROM chat_archive_messages m
          WHERE m.owner_user_id = $1::uuid
            AND m.instance_id = $2::uuid
            AND m.conversation_id = $3
            AND (m.sent_at < $4::timestamptz OR (m.sent_at = $4::timestamptz AND m.id::text < $5))
          ORDER BY m.sent_at DESC, m.id DESC
          LIMIT $6`,
        [...commonValues, before],
      )
    : { rows: [] as ChatArchiveMessageRow[] }
  const afterRes = after > 0
    ? await queryWithRLS<ChatArchiveMessageRow>(
        input.ownerUserId,
        `SELECT ${MESSAGE_COLS}
           FROM chat_archive_messages m
          WHERE m.owner_user_id = $1::uuid
            AND m.instance_id = $2::uuid
            AND m.conversation_id = $3
            AND (m.sent_at > $4::timestamptz OR (m.sent_at = $4::timestamptz AND m.id::text > $5))
          ORDER BY m.sent_at ASC, m.id ASC
          LIMIT $6`,
        [...commonValues, after],
      )
    : { rows: [] as ChatArchiveMessageRow[] }

  const previous = [...beforeRes.rows].reverse().map(toChatArchiveMessage)
  const target = toChatArchiveMessage(targetRow)
  const following = afterRes.rows.map(toChatArchiveMessage)
  return {
    target,
    messages: [...previous, target, ...following],
    targetIndex: previous.length,
  }
}

function toChatArchiveMessage(row: ChatArchiveMessageRow): ChatArchiveMessage {
  return { ...row, sent_at: new Date(row.sent_at).toISOString() }
}

// ── Conversation listing ───────────────────────────────────────

export type ChatConversation = {
  instance_id: string
  source: string
  conversation_id: string
  message_count: number
  first_sent_at: string
  last_sent_at: string
  last_message_preview: string
  last_sender_id: string
  last_sender_display: string | null
  last_direction: ChatDirection
}

type ChatConversationRow = Omit<ChatConversation, 'message_count' | 'first_sent_at' | 'last_sent_at'> & {
  message_count: string | number
  first_sent_at: string | Date
  last_sent_at: string | Date
}

export async function listChatConversations(input: {
  ownerUserId: string
  source?: string
  instanceId?: string
  since?: string
  before?: string
  limit?: number
}): Promise<ChatConversation[]> {
  const values: unknown[] = [input.ownerUserId]
  const clauses = ['m.owner_user_id = $1::uuid']
  if (input.source?.trim()) {
    values.push(input.source.trim().toLowerCase())
    clauses.push(`lower(m.source) = $${values.length}`)
  }
  if (input.instanceId) {
    values.push(input.instanceId)
    clauses.push(`m.instance_id = $${values.length}::uuid`)
  }
  if (input.since) {
    values.push(input.since)
    clauses.push(`m.sent_at >= $${values.length}::timestamptz`)
  }
  if (input.before) {
    values.push(input.before)
    clauses.push(`m.sent_at < $${values.length}::timestamptz`)
  }
  values.push(Math.min(Math.max(input.limit ?? 20, 1), 50))
  const limitIdx = values.length
  const res = await queryWithRLS<ChatConversationRow>(
    input.ownerUserId,
    `WITH ranked AS (
       SELECT m.instance_id::text AS instance_id,
              m.source,
              m.conversation_id,
              count(*) OVER (PARTITION BY m.instance_id, m.conversation_id) AS message_count,
              min(m.sent_at) OVER (PARTITION BY m.instance_id, m.conversation_id) AS first_sent_at,
              max(m.sent_at) OVER (PARTITION BY m.instance_id, m.conversation_id) AS last_sent_at,
              left(coalesce(nullif(m.body_text, ''), m.kind), 240) AS last_message_preview,
              m.sender_id AS last_sender_id,
              m.sender_display AS last_sender_display,
              m.direction AS last_direction,
              row_number() OVER (
                PARTITION BY m.instance_id, m.conversation_id
                ORDER BY m.sent_at DESC, m.id DESC
              ) AS row_rank
         FROM chat_archive_messages m
        WHERE ${clauses.join(' AND ')}
     )
     SELECT instance_id, source, conversation_id, message_count,
            first_sent_at, last_sent_at, last_message_preview,
            last_sender_id, last_sender_display, last_direction
       FROM ranked
      WHERE row_rank = 1
      ORDER BY last_sent_at DESC
      LIMIT $${limitIdx}`,
    values,
  )
  return res.rows.map((row) => ({
    ...row,
    message_count: Number(row.message_count),
    first_sent_at: new Date(row.first_sent_at).toISOString(),
    last_sent_at: new Date(row.last_sent_at).toISOString(),
  }))
}

// ── Acquisition coverage ───────────────────────────────────────

export type ChatCoverageWindow = {
  from: string
  to: string
  firstProviderMessageId: string
  lastProviderMessageId: string
}

export type ChatCoverageGap = {
  from: string
  to: string
  evidence: 'between_acquired_windows'
}

export type ChatConversationCoverage = {
  instanceId: string
  conversationId: string
  windows: ChatCoverageWindow[]
  gaps: ChatCoverageGap[]
}

type CoverageRow = {
  instance_id: string
  conversation_id: string
  window_start: string | Date
  window_end: string | Date
  first_provider_message_id: string
  last_provider_message_id: string
}

/**
 * Return only evidence-backed acquisition windows. Time before the first and
 * after the last window is an unknown horizon, not asserted as a gap.
 */
export async function getChatCoverage(input: {
  ownerUserId: string
  instanceId?: string
  conversationId?: string
  limit?: number
}): Promise<ChatConversationCoverage[]> {
  const values: unknown[] = [input.ownerUserId]
  const clauses = ['owner_user_id = $1::uuid']
  if (input.instanceId) {
    values.push(input.instanceId)
    clauses.push(`instance_id = $${values.length}::uuid`)
  }
  if (input.conversationId?.trim()) {
    values.push(input.conversationId.trim())
    clauses.push(`conversation_id = $${values.length}`)
  }
  values.push(Math.min(Math.max(input.limit ?? 200, 1), 1000))
  const limitIdx = values.length
  const res = await queryWithRLS<CoverageRow>(
    input.ownerUserId,
    `SELECT instance_id::text, conversation_id, window_start, window_end,
            first_provider_message_id, last_provider_message_id
       FROM chat_archive_coverage_windows
      WHERE ${clauses.join(' AND ')}
      ORDER BY instance_id, conversation_id, window_start
      LIMIT $${limitIdx}`,
    values,
  )

  const grouped = new Map<string, { instanceId: string; conversationId: string; windows: ChatCoverageWindow[] }>()
  for (const row of res.rows) {
    const key = `${row.instance_id}\u0000${row.conversation_id}`
    let group = grouped.get(key)
    if (!group) {
      group = { instanceId: row.instance_id, conversationId: row.conversation_id, windows: [] }
      grouped.set(key, group)
    }
    group.windows.push({
      from: new Date(row.window_start).toISOString(),
      to: new Date(row.window_end).toISOString(),
      firstProviderMessageId: row.first_provider_message_id,
      lastProviderMessageId: row.last_provider_message_id,
    })
  }

  return [...grouped.values()].map((group) => {
    const gaps: ChatCoverageGap[] = []
    for (let index = 1; index < group.windows.length; index++) {
      const previous = group.windows[index - 1]!
      const next = group.windows[index]!
      if (new Date(previous.to).getTime() < new Date(next.from).getTime()) {
        gaps.push({
          from: previous.to,
          to: next.from,
          evidence: 'between_acquired_windows',
        })
      }
    }
    return { ...group, gaps }
  })
}
