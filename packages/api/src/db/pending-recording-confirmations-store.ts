/**
 * `pending-recording-confirmations-store.ts` — the channel pre-flight-confirm
 * lookaside (channel-recording-preflight-confirm §5, migration 292).
 *
 * When a BIG (surcharge-incurring) recording lands in a chat channel, the
 * detached fire-and-forget intake (`channel-media-intake`) does a cheap ffprobe
 * (no transcription), inserts a pending row here, and sends a templated ask. The
 * user's reply arrives as a normal channel turn where the assistant — seeing the
 * pending row injected as context — calls `confirmRecordingProcessing`, which
 * enqueues (or drops) the recording job via the existing `enqueueRecordingJob`
 * seam, then deletes the pending row.
 *
 * System-only: all access is via the owner pool (`query()`, RLS-open) — the
 * intake is a detached background task with NO request/user context, exactly
 * like `recording-jobs-store`. The confirm tool does its OWN actor check before
 * acting: it validates the row's `channel_session_key` matches the calling
 * turn's `{channel}:{channel_id}:{user_id}` so one workspace's actor can never
 * confirm another's pending recording.
 *
 * [COMP:recordings/pending-recording-confirmations-store]
 */

import { query } from './client.js'

/** Default time-to-live for an unanswered confirmation (decision D4: expiry = cancel). */
export const PENDING_RECORDING_CONFIRMATION_TTL_HOURS = 24

export type PendingRecordingConfirmation = {
  recordingId: string
  channelSessionKey: string
  durationSeconds: number
  surchargeCredits: number
  defaultBlueprintSlug: string | null
  fileLabel: string | null
  createdAt: Date
  expiresAt: Date
}

/**
 * Build the correlation key for a channel turn. Both the intake (insert) and the
 * chat-turn context lookup must derive this identically — `{channel}:{chat/conversation
 * id}:{acting user id}`. The acting user id is the DB user (the channel/workspace
 * owner), not the channel-native sender, so a reply on the same conversation
 * resolves the pending row regardless of which member dropped the file.
 */
export function buildChannelSessionKey(input: {
  channel: string
  channelId: string
  userId: string
}): string {
  return `${input.channel}:${input.channelId}:${input.userId}`
}

const COLS = `
  recording_id           AS "recordingId",
  channel_session_key    AS "channelSessionKey",
  duration_seconds       AS "durationSeconds",
  surcharge_credits      AS "surchargeCredits",
  default_blueprint_slug AS "defaultBlueprintSlug",
  file_label             AS "fileLabel",
  created_at             AS "createdAt",
  expires_at             AS "expiresAt"
`

/**
 * Insert a pending confirmation. Idempotent on `recording_id` (PK) — a second
 * insert for the same Episode is a no-op (`inserted: false`), so a redelivered
 * webhook cannot double-ask.
 */
export async function insertPendingRecordingConfirmation(input: {
  recordingId: string
  channelSessionKey: string
  durationSeconds: number
  surchargeCredits: number
  defaultBlueprintSlug?: string | null
  fileLabel?: string | null
  ttlHours?: number
}): Promise<{ inserted: boolean }> {
  const ttlHours = input.ttlHours ?? PENDING_RECORDING_CONFIRMATION_TTL_HOURS
  const { rows } = await query<{ recordingId: string }>(
    `INSERT INTO pending_recording_confirmations
       (recording_id, channel_session_key, duration_seconds, surcharge_credits,
        default_blueprint_slug, file_label, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval)
     ON CONFLICT (recording_id) DO NOTHING
     RETURNING recording_id AS "recordingId"`,
    [
      input.recordingId,
      input.channelSessionKey,
      input.durationSeconds,
      input.surchargeCredits,
      input.defaultBlueprintSlug ?? null,
      input.fileLabel ?? null,
      String(ttlHours),
    ],
  )
  return { inserted: rows.length > 0 }
}

/** Fetch a single pending confirmation by recording (Episode) id, or null. */
export async function getPendingRecordingConfirmation(
  recordingId: string,
): Promise<PendingRecordingConfirmation | null> {
  const { rows } = await query<PendingRecordingConfirmation>(
    `SELECT ${COLS} FROM pending_recording_confirmations WHERE recording_id = $1`,
    [recordingId],
  )
  return rows[0] ?? null
}

/**
 * List the un-expired pending confirmations for a channel turn (the chat-turn
 * context lookup). Expired rows are filtered out — they are conceptually
 * cancelled (D4) even before the sweep runs.
 */
export async function listPendingRecordingConfirmationsForSession(
  channelSessionKey: string,
): Promise<PendingRecordingConfirmation[]> {
  const { rows } = await query<PendingRecordingConfirmation>(
    `SELECT ${COLS}
       FROM pending_recording_confirmations
      WHERE channel_session_key = $1 AND expires_at > now()
      ORDER BY created_at`,
    [channelSessionKey],
  )
  return rows
}

/** Drop a pending confirmation by recording id (after enqueue or on cancel). */
export async function deletePendingRecordingConfirmation(recordingId: string): Promise<void> {
  await query(`DELETE FROM pending_recording_confirmations WHERE recording_id = $1`, [recordingId])
}

/** Sweep expired (never-answered) confirmations. Returns the number deleted. */
export async function deleteExpiredPendingRecordingConfirmations(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM pending_recording_confirmations WHERE expires_at <= now()`,
  )
  return rowCount ?? 0
}

/** The store surface the confirm tool depends on (factory injection). */
export type PendingRecordingConfirmationStore = {
  insert: typeof insertPendingRecordingConfirmation
  getByRecordingId: typeof getPendingRecordingConfirmation
  listForSession: typeof listPendingRecordingConfirmationsForSession
  delete: typeof deletePendingRecordingConfirmation
  deleteExpired: typeof deleteExpiredPendingRecordingConfirmations
}

/** Assemble the default store backed by the system pool. */
export function createPendingRecordingConfirmationStore(): PendingRecordingConfirmationStore {
  return {
    insert: insertPendingRecordingConfirmation,
    getByRecordingId: getPendingRecordingConfirmation,
    listForSession: listPendingRecordingConfirmationsForSession,
    delete: deletePendingRecordingConfirmation,
    deleteExpired: deleteExpiredPendingRecordingConfirmations,
  }
}
