/**
 * Live transcript windows (migration 444) — the provisional per-window
 * transcript of a live meeting capture, keyed by the capture session and the
 * destination page. This is the data behind the live transcript pane
 * (docs/architecture/media/live-capture.md → "Live page streaming"): the
 * transcript renders in a purpose-built surface instead of raw doc blocks,
 * and the persisted window audio keys are what the finalize fallback
 * assembles when the lossless full upload fails.
 *
 * Reads/writes go through the owner pool: every route caller has already
 * proven workspace membership, and the finalize path runs partly system-side.
 * [COMP:recordings/live-transcript-store]
 */

import { query } from './client.js'

export type LiveTranscriptLine = {
  /** "Speaker 1" style per-window label, or null when unattributed. */
  speaker: string | null
  text: string
}

export type LiveTranscriptWindow = {
  chunkId: string
  sessionId: string
  workspaceId: string
  pageId: string | null
  offsetMs: number
  durationMs: number
  missedBefore: number
  lines: LiveTranscriptLine[]
  audioKey: string | null
  createdAt: Date
}

type WindowRow = {
  chunkId: string
  sessionId: string
  workspaceId: string
  pageId: string | null
  offsetMs: number
  durationMs: number
  missedBefore: number
  lines: unknown
  audioKey: string | null
  createdAt: Date
}

const PROJECTION = `
  chunk_id AS "chunkId",
  session_id AS "sessionId",
  workspace_id AS "workspaceId",
  page_id AS "pageId",
  offset_ms AS "offsetMs",
  duration_ms AS "durationMs",
  missed_before AS "missedBefore",
  lines,
  audio_key AS "audioKey",
  created_at AS "createdAt"
`

function toWindow(row: WindowRow): LiveTranscriptWindow {
  return {
    ...row,
    lines: Array.isArray(row.lines) ? (row.lines as LiveTranscriptLine[]) : [],
  }
}

/** Idempotent on chunkId — a client retry of the same window is a no-op. */
export async function insertLiveWindow(input: {
  chunkId: string
  sessionId: string
  workspaceId: string
  pageId: string | null
  offsetMs: number
  durationMs: number
  missedBefore: number
  lines: LiveTranscriptLine[]
  audioKey: string | null
}): Promise<boolean> {
  const result = await query(
    `INSERT INTO live_transcript_windows
       (chunk_id, session_id, workspace_id, page_id, offset_ms, duration_ms, missed_before, lines, audio_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (chunk_id) DO NOTHING`,
    [
      input.chunkId,
      input.sessionId,
      input.workspaceId,
      input.pageId,
      input.offsetMs,
      input.durationMs,
      input.missedBefore,
      JSON.stringify(input.lines),
      input.audioKey,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

export async function hasLiveWindow(chunkId: string): Promise<boolean> {
  const result = await query(`SELECT 1 FROM live_transcript_windows WHERE chunk_id = $1`, [chunkId])
  return (result.rowCount ?? 0) > 0
}

/** All of a page's windows, capture order. The pane's read. */
export async function listLiveWindowsByPage(
  workspaceId: string,
  pageId: string,
): Promise<LiveTranscriptWindow[]> {
  const result = await query<WindowRow>(
    `SELECT ${PROJECTION} FROM live_transcript_windows
     WHERE workspace_id = $1 AND page_id = $2
     ORDER BY offset_ms ASC`,
    [workspaceId, pageId],
  )
  return result.rows.map(toWindow)
}

/** One capture session's windows, capture order. The finalize read. */
export async function listLiveWindowsBySession(
  workspaceId: string,
  sessionId: string,
): Promise<LiveTranscriptWindow[]> {
  const result = await query<WindowRow>(
    `SELECT ${PROJECTION} FROM live_transcript_windows
     WHERE workspace_id = $1 AND session_id = $2
     ORDER BY offset_ms ASC`,
    [workspaceId, sessionId],
  )
  return result.rows.map(toWindow)
}

/**
 * Clear the audio keys after finalize deleted the objects — the transcript
 * lines stay (the pane still renders them until processing completes).
 */
export async function clearLiveWindowAudio(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  await query(
    `UPDATE live_transcript_windows SET audio_key = NULL
     WHERE workspace_id = $1 AND session_id = $2`,
    [workspaceId, sessionId],
  )
}
