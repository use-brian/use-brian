/**
 * Build an `EpisodeEnvelope` from a normalized Fathom meeting (WU-7.5).
 *
 * `source_kind` is `meeting`; `source_ref` carries the canonical
 * `MeetingContentRef` shape from `packages/core/src/ingest/types.ts:65-70`
 * — `transcript_file_id`, optional `recording_url`, and
 * `attendee_external_ids` — alongside the Fathom `recording_id` as a
 * carrier field. The Episode's `actors` are populated from Fathom
 * participants as `external_id` entries (email when present); entity
 * resolution in Pipeline B maps these to `user_id`s downstream.
 *
 * Transcript text is inlined when it fits under `MANUAL_PASTE_INLINE_MAX_BYTES`
 * (16 KB, matching the Gmail adapter's cap). Larger transcripts are
 * stored by reference, and Pipeline B re-fetches via the Fathom API.
 * When no transcript is fetched yet, `content.raw` points at the meeting
 * itself.
 *
 * [COMP:brain/source-adapters/fathom]
 */

import type { Sensitivity } from '../../../security/sensitivity.js'
import { MANUAL_PASTE_INLINE_MAX_BYTES } from '../../schemas.js'
import type { EpisodeActor, EpisodeEnvelope } from '../../types.js'

import type {
  FathomEpisodeContext,
  FathomNormalizedMeeting,
  FathomNormalizedParticipant,
} from './types.js'

/** Default per `data-model.md:264` — Episodes default to `'internal'`. */
const DEFAULT_SENSITIVITY: Sensitivity = 'internal'

export function fathomMeetingToEpisode(
  meeting: FathomNormalizedMeeting,
  ctx: FathomEpisodeContext,
): EpisodeEnvelope {
  const transcriptRef = `fathom:transcript:${meeting.recording_id}`
  const meetingRef = `fathom:meeting:${meeting.recording_id}`

  const attendeeExternalIds = meeting.participants.map((p) => p.external_id)

  const actors: EpisodeActor[] = meeting.participants.map(toActor)

  const sourceRef: Record<string, unknown> = {
    source_kind: 'meeting',
    transcript_file_id: transcriptRef,
    attendee_external_ids: attendeeExternalIds,
    recording_id: meeting.recording_id,
  }
  if (meeting.recording_url) {
    sourceRef.recording_url = meeting.recording_url
  }

  return {
    source_kind: 'meeting',
    source_ref: sourceRef,
    occurred_at: meeting.recorded_at,
    actors,
    content: {
      raw: buildInlineOrRef(meeting.transcript_text, transcriptRef, meetingRef),
      attachments: [],
    },
    sensitivity: ctx.sensitivity ?? DEFAULT_SENSITIVITY,
    user_id: ctx.user_id,
    assistant_id: ctx.assistant_id,
    workspace_id: ctx.workspace_id,
    created_by_user_id: ctx.created_by_user_id,
    created_by_assistant_id: ctx.created_by_assistant_id,
  }
}

function toActor(p: FathomNormalizedParticipant): EpisodeActor {
  return { role: p.role, external_id: p.external_id }
}

/**
 * Inline the transcript when it fits comfortably in the Episode row;
 * otherwise point at the transcript file. With no transcript fetched
 * yet, point at the meeting record so Pipeline B knows what to fetch.
 */
function buildInlineOrRef(
  text: string | null,
  transcriptRef: string,
  meetingRef: string,
): EpisodeEnvelope['content']['raw'] {
  if (text === null) return { ref: meetingRef }
  if (Buffer.byteLength(text, 'utf8') <= MANUAL_PASTE_INLINE_MAX_BYTES) return text
  return { ref: transcriptRef }
}
