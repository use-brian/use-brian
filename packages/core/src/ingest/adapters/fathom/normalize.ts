/**
 * Pure-function normalization: Fathom API meeting → `FathomNormalizedMeeting`.
 *
 * The raw shape comes from the Fathom external API wrappers in
 * `packages/api/src/fathom/client.ts` (`listFathomMeetings`,
 * `getFathomMeeting`, `getFathomTranscript`). Keys are tolerant of API
 * drift (see `FathomRawMeeting`); this function reads only what it needs
 * and rejects payloads that are missing the two non-negotiable fields:
 * `recording_id` and `recorded_at`.
 *
 * No network. The Fathom HTTP client is owned by the caller (the future
 * receive worker), keeping `packages/core` free of network I/O.
 *
 * [COMP:brain/source-adapters/fathom]
 */

import type {
  FathomNormalizedMeeting,
  FathomNormalizedParticipant,
  FathomRawMeeting,
  FathomRawParticipant,
} from './types.js'

export type NormalizeFathomOptions = {
  /**
   * Reserved for parity with the Gmail adapter. The normalizer already
   * raises on missing required fields; downstream callers should still
   * run the resulting envelope through `episodeEnvelopeSchema` at trust
   * boundaries.
   */
  validate?: boolean
}

export function normalizeFathomMeeting(
  raw: FathomRawMeeting,
  _opts: NormalizeFathomOptions = {},
): FathomNormalizedMeeting {
  if (!raw.recording_id || typeof raw.recording_id !== 'string') {
    throw new TypeError(
      'normalizeFathomMeeting: missing required field `recording_id`',
    )
  }

  const recordedAt = parseRecordedAt(raw.recorded_at)
  if (!recordedAt) {
    throw new TypeError(
      `normalizeFathomMeeting: missing or invalid \`recorded_at\` for recording_id=${raw.recording_id}`,
    )
  }

  const participants = (raw.participants ?? [])
    .map(normalizeParticipant)
    .filter((p): p is FathomNormalizedParticipant => p !== null)

  const transcriptText = readTextField(raw.transcript?.text)

  return {
    recording_id: raw.recording_id,
    title: readTextField(raw.title),
    recorded_at: recordedAt,
    duration_secs: typeof raw.duration_secs === 'number' ? raw.duration_secs : null,
    recording_url: readTextField(raw.recording_url),
    transcript_text: transcriptText,
    summary_text: readTextField(raw.default_summary),
    participants,
  }
}

function parseRecordedAt(value: string | undefined): Date | null {
  if (!value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}

function normalizeParticipant(p: FathomRawParticipant): FathomNormalizedParticipant | null {
  const email = readTextField(p.email)
  const idPart = p.id !== undefined && p.id !== null ? String(p.id) : ''
  const externalId = email ? email : (idPart ? `fathom:participant:${idPart}` : '')
  if (!externalId) return null
  return {
    external_id: externalId,
    email,
    name: readTextField(p.name),
    role: p.is_host === true ? 'host' : 'attendee',
  }
}

function readTextField(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
