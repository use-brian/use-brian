/**
 * Local types for the Fathom source adapter (WU-7.5).
 *
 * Fathom is meeting-recording / transcription. Today the integration is
 * pull-only — see `packages/api/src/fathom/client.ts` (`listFathomMeetings`,
 * `getFathomMeeting`, `getFathomTranscript`, `getFathomSummary`) and the
 * agent tools at `packages/core/src/tools/base/fathom.ts`. This adapter
 * is the conversion seam from a Fathom meeting record into the universal
 * `EpisodeEnvelope` (`source_kind: 'meeting'`) consumed by Pipeline B.
 *
 * The shared `ConnectorAdapter` interface lands with the ingest engine
 * (WU-3.7); to keep this WU independent the module declares its own
 * surface, matching the pattern in `adapters/slack/types.ts`.
 *
 * [COMP:brain/source-adapters/fathom]
 */

import type { EpisodeEnvelope } from '../../types.js'

// ── Raw Fathom API shape (loose, tolerant of API drift) ────────────────

/**
 * A meeting participant as returned by the Fathom external API. Keys are
 * optional because Fathom's payload varies by endpoint (`listMeetings`
 * includes a thin participant list; `getMeeting` includes more detail).
 * The normalizer reads only what's present.
 */
export type FathomRawParticipant = {
  id?: string | number
  email?: string | null
  name?: string | null
  is_host?: boolean
}

/**
 * Loose mirror of a Fathom meeting record. Use the response shape from
 * the read tools in `packages/core/src/tools/base/fathom.ts` and the API
 * wrappers in `packages/api/src/fathom/client.ts` as the source of truth
 * for field names. Unknown extras are ignored by the normalizer.
 */
export type FathomRawMeeting = {
  recording_id: string
  title?: string | null
  /** ISO-8601 timestamp; required for the envelope's `occurred_at`. */
  recorded_at?: string
  duration_secs?: number | null
  /** Fathom's public recording page URL. */
  recording_url?: string | null
  default_summary?: string | null
  /** Present when fetched via `getFathomTranscript`. */
  transcript?: { text?: string | null } | null
  participants?: FathomRawParticipant[]
}

// ── Normalized event (filterable, pre-Episode) ─────────────────────────

export type FathomNormalizedParticipant = {
  /** Stable identifier — email when present, else `fathom:participant:{id}`. */
  external_id: string
  email: string | null
  name: string | null
  role: 'host' | 'attendee'
}

/**
 * Adapter output, ready for envelope conversion. Mirrors the per-adapter
 * pattern: filter-relevant metadata up front, large payloads (transcript
 * text) tagged null when not yet fetched so the to-episode helper can
 * decide inline-vs-ref deterministically.
 */
export type FathomNormalizedMeeting = {
  recording_id: string
  title: string | null
  recorded_at: Date
  duration_secs: number | null
  recording_url: string | null
  /** Full transcript text when available, else null. */
  transcript_text: string | null
  summary_text: string | null
  participants: FathomNormalizedParticipant[]
}

// ── Envelope context ──────────────────────────────────────────────────

/**
 * Envelope context that turns a normalized meeting into an
 * `EpisodeEnvelope`. Resolved by the caller before invoking
 * `fathomMeetingToEpisode`: which workspace/user/assistant owns the
 * Fathom connection; what sensitivity the adapter should stamp; who
 * is the authorship-of-record. Mirrors the other adapters' `*EpisodeContext`.
 *
 * Visibility invariant: at least one of `user_id` / `assistant_id`
 * must be non-null — `episodeEnvelopeSchema` enforces this.
 */
export type FathomEpisodeContext = {
  workspace_id: string
  user_id: string | null
  assistant_id: string | null
  created_by_user_id: string
  created_by_assistant_id: string | null
  /** Adapter-stamped sensitivity. Defaults to 'internal' (data-model.md:264). */
  sensitivity?: import('../../../security/sensitivity.js').Sensitivity
}

// ── Re-exports for callers that compose adapter + envelope helpers ────

export type { EpisodeEnvelope }
