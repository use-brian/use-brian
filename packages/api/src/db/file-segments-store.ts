/**
 * `file-segments-store.ts` — workspace-file text segmentation + persistence
 * (large-content-artifacts §Phase 1.1).
 *
 * Two pieces, mirroring `transcript-segments-store.ts`:
 *   - `chunkFileText`: a PURE function that packs a file's parsed text
 *     (Markdown for office formats, plain text otherwise) into
 *     embedding/retrieval-sized segments. Heading-aware: ATX headings build a
 *     `headingPath` breadcrumb and act as soft segment boundaries; fenced code
 *     blocks are atomic (never sentence-split).
 *   - `insertFileSegments`: writes segments into `file_segments` (migration
 *     297), stamping every universal column VERBATIM from the workspace_files
 *     parent so both the dedicated searchFileContent predicate and the general
 *     search() scope read them back correctly, leaving `embedding` NULL for the
 *     async embedding worker. Idempotent on `(file_id, segment_index)`.
 *
 * EXACT-SLICE INVARIANT: for every segment,
 * `content === normalizedText.slice(charStart, charEnd)` where normalizedText
 * is the input after `\r\n → \n` (the ONLY normalization — Markdown structure
 * such as fences and tables is meaningful, unlike transcript whitespace).
 * Re-chunking is verifiable and verbatim quoting always possible.
 *
 * The store runs on the system pool (background ingest job / in-request
 * indexing, no per-user RLS context) — same pattern as the embedding worker.
 *
 * [COMP:brain/file-segments-store]
 */

import { getPool } from './client.js'

/** A packed file segment — the embedding/retrieval unit. */
export type FileChunk = {
  segmentIndex: number
  /** Exact slice of the normalized text: `normalized.slice(charStart, charEnd)`. */
  content: string
  charStart: number
  charEnd: number
  /** Markdown heading breadcrumb at this segment's start, outermost first. */
  headingPath: string[]
}

export type ChunkFileTextResult = {
  segments: FileChunk[]
  /** Set when MAX_SEGMENTS_PER_FILE stopped chunking: the offset the tail begins at. */
  truncatedAtChar: number | null
}

// Packing bounds — same granularity as transcript segments (same embedder,
// same retrieval unit). 1500 chars ≈ ≤1500 CJK tokens, under the embedder cap.
const TARGET_CHARS = 1200
const MAX_CHARS = 1500
const MIN_CHARS = 200
const SENTENCE_SPLIT_AT = 900
/** Hard ceiling per artifact (~2.4-3 MB of text). The tail is not chunked. */
export const MAX_SEGMENTS_PER_FILE = 2000

/**
 * Sentence boundary for splitting an over-long block. CJK-aware: fullwidth
 * terminators (。！？；) rarely carry a following space, so `\s?` — the
 * transcript store's `/[.!?]\s/` misses them entirely.
 */
const SENTENCE_BOUNDARY = /[.!?。！？；]\s?/g

type Block = {
  charStart: number
  charEnd: number
  headingPath: string[]
  /** Fenced code block — atomic: line-split at MAX, never sentence-split. */
  fence: boolean
}

/** ATX heading outside a fence: captures level + title. */
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

/**
 * Pass 1 — scan the normalized text into blocks: runs of non-blank lines,
 * broken by blank lines and headings, with fenced code kept together (blank
 * lines inside a fence do not break the block). Each block snapshots the
 * heading stack at its position; a heading line starts a new block that
 * carries its OWN path (so packing's heading-change soft break puts the
 * heading at the head of the next segment).
 */
function scanBlocks(normalized: string): Block[] {
  const blocks: Block[] = []
  const headingStack: Array<{ level: number; title: string }> = []
  let inFence = false
  let cur: Block | null = null

  const flush = (end: number) => {
    if (cur && end > cur.charStart) {
      cur.charEnd = end
      blocks.push(cur)
    }
    cur = null
  }

  let offset = 0
  while (offset <= normalized.length) {
    const nl = normalized.indexOf('\n', offset)
    const lineEnd = nl === -1 ? normalized.length : nl
    const line = normalized.slice(offset, lineEnd)
    const isBlank = line.trim().length === 0
    const isFenceMarker = /^(```|~~~)/.test(line)

    if (inFence) {
      // Everything inside a fence rides the current block, blanks included.
      if (isFenceMarker) inFence = false
    } else if (isFenceMarker) {
      inFence = true
      if (!cur) cur = { charStart: offset, charEnd: offset, headingPath: headingStack.map((h) => h.title), fence: true }
      else cur.fence = true
    } else if (isBlank) {
      flush(offset > 0 ? offset - 1 : 0)
    } else {
      const h = ATX_HEADING.exec(line)
      if (h) {
        flush(offset > 0 ? offset - 1 : 0)
        const level = h[1].length
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop()
        }
        headingStack.push({ level, title: h[2] })
        cur = { charStart: offset, charEnd: offset, headingPath: headingStack.map((x) => x.title), fence: false }
      } else if (!cur) {
        cur = { charStart: offset, charEnd: offset, headingPath: headingStack.map((x) => x.title), fence: false }
      }
    }

    if (nl === -1) break
    offset = nl + 1
  }
  flush(normalized.length)
  return blocks
}

/**
 * Split one over-MAX block into exact-offset sub-blocks: sentence boundaries
 * near SENTENCE_SPLIT_AT for prose; nearest newline for fences (atomic lines).
 * Hard cut at MAX_CHARS when no boundary exists.
 */
function splitOverlongBlock(normalized: string, block: Block): Block[] {
  const out: Block[] = []
  let start = block.charStart
  while (block.charEnd - start > MAX_CHARS) {
    const windowStart = start + SENTENCE_SPLIT_AT
    const window = normalized.slice(windowStart, start + MAX_CHARS)
    let cut = -1
    if (block.fence) {
      cut = window.lastIndexOf('\n')
      if (cut >= 0) cut = windowStart + cut + 1
    } else {
      SENTENCE_BOUNDARY.lastIndex = 0
      const m = SENTENCE_BOUNDARY.exec(window)
      if (m) cut = windowStart + m.index + m[0].length
    }
    if (cut < 0 || cut <= start) cut = start + MAX_CHARS
    out.push({ ...block, charStart: start, charEnd: cut })
    start = cut
  }
  if (block.charEnd > start) out.push({ ...block, charStart: start, charEnd: block.charEnd })
  return out
}

/**
 * Pack a file's parsed text into segments. Rules, in priority order:
 *   1. Heading change is a SOFT break — break when the buffer already holds
 *      ≥ MIN_CHARS (the file analog of the transcript's speaker-change rule).
 *   2. Break when the buffer reaches ~TARGET_CHARS (hard cap MAX_CHARS); a
 *      single over-MAX block is pre-split (sentence-aware; fences line-split).
 *   3. Merge a trailing sub-MIN_CHARS segment back into its predecessor so no
 *      segment is a tiny scrap.
 * Stops at MAX_SEGMENTS_PER_FILE and reports where the tail begins.
 */
export function chunkFileText(text: string): ChunkFileTextResult {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.trim().length === 0) return { segments: [], truncatedAtChar: null }

  const blocks = scanBlocks(normalized).flatMap((b) =>
    b.charEnd - b.charStart > MAX_CHARS ? splitOverlongBlock(normalized, b) : [b],
  )

  type Buf = { charStart: number; charEnd: number; headingPath: string[] }
  const out: FileChunk[] = []
  let buf: Buf | null = null
  let truncatedAtChar: number | null = null

  const slice = (s: number, e: number) => normalized.slice(s, e)
  const flush = () => {
    if (!buf) return
    const content = slice(buf.charStart, buf.charEnd)
    if (content.trim().length > 0) {
      out.push({
        segmentIndex: out.length,
        content,
        charStart: buf.charStart,
        charEnd: buf.charEnd,
        headingPath: buf.headingPath,
      })
    }
    buf = null
  }

  for (const block of blocks) {
    if (out.length >= MAX_SEGMENTS_PER_FILE) {
      truncatedAtChar = block.charStart
      buf = null
      break
    }
    if (buf) {
      const bufLen = buf.charEnd - buf.charStart
      const mergedLen = block.charEnd - buf.charStart
      const headingChanged = block.headingPath.join(' ') !== buf.headingPath.join(' ')
      if ((headingChanged && bufLen >= MIN_CHARS) || bufLen >= TARGET_CHARS || mergedLen > MAX_CHARS) {
        flush()
      }
    }
    if (!buf) {
      buf = { charStart: block.charStart, charEnd: block.charEnd, headingPath: block.headingPath }
    } else {
      buf.charEnd = block.charEnd
    }
  }
  if (truncatedAtChar === null) flush()

  // Merge a trailing too-small segment back into its predecessor (re-slice so
  // the exact-slice invariant holds across the merge).
  if (out.length >= 2) {
    const last = out[out.length - 1]
    const prev = out[out.length - 2]
    if (last.content.length < MIN_CHARS) {
      prev.charEnd = last.charEnd
      prev.content = slice(prev.charStart, prev.charEnd)
      out.pop()
    }
  }
  out.forEach((s, i) => {
    s.segmentIndex = i
  })
  return { segments: out, truncatedAtChar }
}

export type InsertFileSegmentsParams = {
  fileId: string
  workspaceId: string
  createdByUserId: string
  /**
   * Visibility double, inherited VERBATIM from the workspace_files parent.
   * BOTH may be null — that is the workspace-shared shape filesApi writes
   * (file_segments deliberately carries NO visibility CHECK; see migration 297).
   */
  visibility: { userId: string | null; assistantId: string | null }
  /** Inherited from the parent row. */
  sensitivity: string
  compartments: string[]
  tags: string[] | null
  source: string
  segments: FileChunk[]
}

const INSERT_BATCH = 100

/**
 * Insert packed segments, batched. Idempotent on `(file_id, segment_index)` so
 * a retried ingest job re-inserts without duplicating. Leaves `embedding` NULL
 * for the async embedding worker. Runs on the system pool.
 *
 * @returns the number of rows actually inserted (excludes idempotent skips).
 */
export async function insertFileSegments(params: InsertFileSegmentsParams): Promise<number> {
  const { fileId, workspaceId, createdByUserId, visibility, sensitivity, compartments, tags, source, segments } = params
  const valid = segments.filter((s) => s.content.trim().length > 0)
  if (valid.length === 0) return 0

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    let inserted = 0
    for (let i = 0; i < valid.length; i += INSERT_BATCH) {
      const batch = valid.slice(i, i + INSERT_BATCH)
      const values: unknown[] = []
      const rows = batch.map((s, j) => {
        const b = j * 14
        values.push(
          workspaceId, fileId, s.segmentIndex, s.charStart, s.charEnd,
          s.headingPath, s.content, visibility.userId, visibility.assistantId,
          source, sensitivity, compartments, tags, createdByUserId,
        )
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::text[],$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12}::text[],$${b + 13}::text[],$${b + 14})`
      })
      const res = await client.query(
        `INSERT INTO file_segments (
           workspace_id, file_id, segment_index, char_start, char_end,
           heading_path, content, user_id, assistant_id,
           source, sensitivity, compartments, tags, created_by_user_id
         ) VALUES ${rows.join(',')}
         ON CONFLICT (file_id, segment_index) DO NOTHING`,
        values,
      )
      inserted += res.rowCount ?? 0
    }
    await client.query('COMMIT')
    return inserted
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Remove every segment for an artifact (re-index path; delete itself CASCADEs). */
export async function deleteFileSegmentsByFileId(fileId: string): Promise<number> {
  const res = await getPool().query(`DELETE FROM file_segments WHERE file_id = $1`, [fileId])
  return res.rowCount ?? 0
}
