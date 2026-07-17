// [COMP:media/transcript-citations] — prose citations → typed pointers.
//
// The synthesis prompt asks the model to cite the moment for every claim, and it
// does: `[0:47:21]` lands as literal characters inside a field's markdown. That
// text is readable and (since the render-time decoration) clickable, but it is
// not QUERYABLE: you cannot count the citations on a brief, ask which ones the
// model invented, or join a decision back to the segment it came from.
//
// This module turns each cited moment into a typed pointer, validated against
// the transcript it claims to quote:
//
//   - a moment past the end of the recording is DROPPED. The prompt already
//     warns the model that `[00:85]` means it invented the citation; `parseStamp`
//     rejects that shape, and this rejects the other shape of the same lie — a
//     well-formed stamp for a moment that never happened.
//   - a surviving moment is SNAPPED to the real `transcript_segments` row that
//     covers it, so the pointer refers to something that exists rather than to a
//     number the model chose.
//
// Kept pure and DB-free (like `transcript-format`, whose scanner it shares) so
// the write path, the API, and the browser all agree on what a citation is.

import { scanStamps } from './transcript-format.js'

/** A transcript segment, as far as citation resolution cares. */
export type CitationSegment = {
  segmentIndex: number
  startMs: number
  endMs: number
  speaker?: string | null
}

/**
 * A resolved citation: the moment, plus the segment that actually covers it.
 *
 * `confidence: 'parsed'` records HOW this pointer was obtained — read verbatim
 * from text the model wrote. It is deliberately the only value today: a future
 * inferred/embedding-matched citation must be distinguishable from one the model
 * stated outright, and a field that only ever holds one value is cheaper to add
 * now than a migration to tell them apart later.
 */
export type FieldCitation = {
  startMs: number
  /** The covering segment; null when the recording has no segments indexed. */
  segmentIndex: number | null
  speaker: string | null
  confidence: 'parsed'
}

/** The transcript a set of citations is validated against. */
export type CitationIndex = {
  /** Segments sorted by `startMs`. Empty ⇒ moments are range-checked but not snapped. */
  segments: readonly CitationSegment[]
  /** The recording's length. 0 / unknown ⇒ no range check (nothing to check against). */
  durationMs: number
}

/**
 * Build the index once per fill. Sorts defensively — the snap is a binary search
 * and silently returns the wrong segment for unsorted input, which would be a
 * plausible-looking wrong answer rather than a visible failure.
 */
export function buildCitationIndex(
  segments: readonly CitationSegment[],
  durationMs: number,
): CitationIndex {
  return {
    segments: [...segments].sort((a, b) => a.startMs - b.startMs),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
  }
}

/** The last segment starting at or before `ms` — the one that covers it. */
function snapToSegment(index: CitationIndex, ms: number): CitationSegment | null {
  const segs = index.segments
  if (segs.length === 0) return null
  // Before the first segment: snap forward rather than report nothing. A stamp
  // slightly ahead of the opening line is a rounding artifact, not a lie.
  if (ms < segs[0].startMs) return segs[0]
  let lo = 0
  let hi = segs.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].startMs <= ms) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return segs[best]
}

/**
 * Extract every citation in `text`, validated and snapped.
 *
 * Deduplicated by moment: a brief that cites `[0:47:21]` in two sentences of the
 * same field carries one pointer, not two — the citation list answers "what
 * moments ground this field", and a repeat is the same answer twice.
 */
export function extractCitations(text: string, index: CitationIndex): FieldCitation[] {
  const seen = new Set<number>()
  const out: FieldCitation[] = []
  for (const hit of scanStamps(text)) {
    // Past the end of the recording: the model invented it. `formatStamp` floors
    // to the second, so a real moment can never exceed the duration.
    if (index.durationMs > 0 && hit.ms > index.durationMs) continue
    if (seen.has(hit.ms)) continue
    seen.add(hit.ms)
    const seg = snapToSegment(index, hit.ms)
    out.push({
      startMs: hit.ms,
      segmentIndex: seg ? seg.segmentIndex : null,
      speaker: seg?.speaker ?? null,
      confidence: 'parsed',
    })
  }
  return out
}
