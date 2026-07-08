/**
 * `transcript-segments-store.ts` — long-recording transcript segmentation +
 * persistence (recording-to-brain Phase 3).
 *
 * Two pieces:
 *   - `segmentTranscript`: a PURE function that packs diarized utterances into
 *     embedding/retrieval-sized segments (the rules from
 *     docs/architecture/media/transcription.md §"Segment granularity").
 *   - `insertTranscriptSegments`: writes segments into `transcript_segments`
 *     (migration 280), stamping every universal column so the dedicated
 *     `searchRecording` access predicate can read them back, leaving
 *     `embedding` NULL so the async embedding worker claims them. Idempotent on
 *     `(recording_id, segment_index)`.
 *
 * The store runs on the system pool (background transcription job, no per-user
 * RLS context) — same pattern as the embedding worker.
 *
 * [COMP:brain/transcript-segments-store]
 */

import { getPool } from './client.js'

/** One diarized speaker-turn from the transcription step. */
export type Utterance = {
  startMs: number
  endMs: number
  /** Diarized speaker label, or null when diarization is absent. */
  speaker: string | null
  text: string
}

/** A packed segment — the embedding/retrieval unit. */
export type TranscriptSegment = {
  segmentIndex: number
  startMs: number
  endMs: number
  speaker: string | null
  speakerIds: string[]
  text: string
  utteranceRefs: Array<{ start_ms: number; end_ms: number; speaker: string | null }>
}

// Packing bounds — see plan §"Segment granularity + timestamp model".
const TARGET_CHARS = 1200
const MAX_CHARS = 1500
const MIN_CHARS = 200
const SENTENCE_SPLIT_AT = 900
const TARGET_MS = 90_000 // ~90s of speech

/** Collapse runs of whitespace and trim. Returns '' for whitespace-only input. */
function normalizeText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Reject text that carries no readable content (whitespace / control only). */
function hasReadableContent(text: string): boolean {
  return normalizeText(text).length > 0
}

/**
 * Split a single over-long utterance on sentence boundaries near
 * SENTENCE_SPLIT_AT, hard-splitting at MAX_CHARS. Keeps sentences intact when
 * it can; never emits an empty piece.
 */
function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text]
  const pieces: string[] = []
  let rest = text
  while (rest.length > MAX_CHARS) {
    // Prefer a sentence end (. ! ?) at/after SENTENCE_SPLIT_AT, before MAX_CHARS.
    const window = rest.slice(SENTENCE_SPLIT_AT, MAX_CHARS)
    const m = window.search(/[.!?]\s/)
    const cut = m >= 0 ? SENTENCE_SPLIT_AT + m + 1 : MAX_CHARS
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) pieces.push(rest)
  return pieces.filter((p) => p.length > 0)
}

/**
 * Pack consecutive utterances into segments. Rules (plan §"Segment
 * granularity"), in priority order:
 *   1. Break on speaker change — never merge two speakers.
 *   2. Break when the buffer reaches ~TARGET_CHARS or ~TARGET_MS (hard cap
 *      MAX_CHARS); a single utterance over MAX_CHARS is sentence-split.
 *   3. Merge a trailing sub-MIN_CHARS fragment back into the previous segment
 *      (same speaker only) so no segment is a tiny scrap.
 *
 * When `speaker` is null throughout (no diarization) rule 1 no-ops and the
 * stream segments purely by size/time — it never produces one giant segment.
 */
export function segmentTranscript(utterances: Utterance[]): TranscriptSegment[] {
  type Buf = {
    startMs: number
    endMs: number
    speaker: string | null
    speakers: Set<string>
    text: string
    refs: Array<{ start_ms: number; end_ms: number; speaker: string | null }>
  }
  const out: TranscriptSegment[] = []
  let buf: Buf | null = null

  const flush = () => {
    if (!buf) return
    const text = normalizeText(buf.text)
    if (hasReadableContent(text)) {
      out.push({
        segmentIndex: out.length,
        startMs: buf.startMs,
        endMs: buf.endMs,
        speaker: buf.speaker,
        speakerIds: [...buf.speakers],
        text,
        utteranceRefs: buf.refs,
      })
    }
    buf = null
  }

  for (const u of utterances) {
    const utext = normalizeText(u.text)
    if (!hasReadableContent(utext)) continue

    // A single utterance over the hard cap: flush, then emit its sentence-split
    // pieces as their own segments (each still attributed to this speaker).
    if (utext.length > MAX_CHARS) {
      flush()
      const pieces = splitLongText(utext)
      const span = u.endMs - u.startMs
      pieces.forEach((piece, i) => {
        const pStart = u.startMs + Math.round((span * i) / pieces.length)
        const pEnd = u.startMs + Math.round((span * (i + 1)) / pieces.length)
        out.push({
          segmentIndex: out.length,
          startMs: pStart,
          endMs: pEnd,
          speaker: u.speaker,
          speakerIds: u.speaker ? [u.speaker] : [],
          text: piece,
          utteranceRefs: [{ start_ms: pStart, end_ms: pEnd, speaker: u.speaker }],
        })
      })
      continue
    }

    const speakerChange = buf !== null && u.speaker !== buf.speaker
    const wouldOverflow =
      buf !== null &&
      (buf.text.length + 1 + utext.length > MAX_CHARS ||
        (buf.text.length >= TARGET_CHARS) ||
        (u.endMs - buf.startMs > TARGET_MS && buf.text.length >= MIN_CHARS))

    if (buf && (speakerChange || wouldOverflow)) flush()

    if (!buf) {
      buf = {
        startMs: u.startMs,
        endMs: u.endMs,
        speaker: u.speaker,
        speakers: new Set(u.speaker ? [u.speaker] : []),
        text: utext,
        refs: [{ start_ms: u.startMs, end_ms: u.endMs, speaker: u.speaker }],
      }
    } else {
      buf.text += ' ' + utext
      buf.endMs = u.endMs
      if (u.speaker) buf.speakers.add(u.speaker)
      buf.refs.push({ start_ms: u.startMs, end_ms: u.endMs, speaker: u.speaker })
    }
  }
  flush()

  // Merge a trailing too-small segment back into its predecessor when they
  // share a speaker (avoids a tiny scrap segment at a speaker's tail).
  for (let i = out.length - 1; i >= 1; i--) {
    const cur = out[i]
    const prev = out[i - 1]
    if (cur.text.length < MIN_CHARS && cur.speaker === prev.speaker) {
      prev.text = normalizeText(prev.text + ' ' + cur.text)
      prev.endMs = cur.endMs
      prev.utteranceRefs = [...prev.utteranceRefs, ...cur.utteranceRefs]
      prev.speakerIds = [...new Set([...prev.speakerIds, ...cur.speakerIds])]
      out.splice(i, 1)
    }
  }
  // Re-number after merges so segment_index stays dense + monotonic.
  out.forEach((s, i) => {
    s.segmentIndex = i
  })
  return out
}

export type InsertTranscriptSegmentsParams = {
  recordingId: string
  workspaceId: string
  createdByUserId: string
  /** Visibility double — at least one must be non-null (DB CHECK). A
   *  workspace-shared recording sets `assistantId` (any user via that
   *  assistant); a private one sets `userId`. */
  visibility: { userId: string | null; assistantId: string | null }
  /** Inherited from the recording's Episode (a confidential call -> confidential segments). */
  sensitivity: string
  /** The raw transcript bytes file, when persisted, for UI deep-link. */
  transcriptFileId?: string | null
  segments: TranscriptSegment[]
}

/**
 * Insert packed segments. Idempotent on `(recording_id, segment_index)` so a
 * retried transcription job re-inserts the same segments without duplicating.
 * Leaves `embedding` NULL — the async embedding worker claims and vectorizes
 * the rows. Runs on the system pool (background job, no per-user RLS context).
 *
 * @returns the number of rows actually inserted (excludes idempotent skips).
 */
export async function insertTranscriptSegments(
  params: InsertTranscriptSegmentsParams,
): Promise<number> {
  const { recordingId, workspaceId, createdByUserId, visibility, sensitivity, segments } = params
  if (visibility.userId === null && visibility.assistantId === null) {
    throw new Error('insertTranscriptSegments: visibility requires userId or assistantId (DB CHECK)')
  }
  const valid = segments.filter((s) => hasReadableContent(s.text))
  if (valid.length === 0) return 0

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    let inserted = 0
    for (const s of valid) {
      const res = await client.query(
        `INSERT INTO transcript_segments (
           workspace_id, recording_id, transcript_file_id, segment_index,
           start_ms, end_ms, speaker, speaker_ids, segment_text, utterance_refs,
           user_id, assistant_id, source, sensitivity, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,'recording',$13,$14)
         ON CONFLICT (recording_id, segment_index) DO NOTHING`,
        [
          workspaceId,
          recordingId,
          params.transcriptFileId ?? null,
          s.segmentIndex,
          s.startMs,
          s.endMs,
          s.speaker,
          s.speakerIds.length > 0 ? s.speakerIds : null,
          s.text,
          JSON.stringify(s.utteranceRefs),
          visibility.userId,
          visibility.assistantId,
          sensitivity,
          createdByUserId,
        ],
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
