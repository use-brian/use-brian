import { query } from './client.js'

/**
 * Pinned room context (multiplayer chat P1b, T14/D10) — `session_pins`,
 * migration 389.
 *
 * A pin is a REFERENCE to the room's working set: a brain primitive by id
 * (page / task / contact / company / deal / file), a URL, or a freeform
 * background instruction. Resolution to content happens at assembly time
 * (`resolveSessionPins`), fresh each turn, under the session's clearance —
 * this store is deliberately dumb: rows in, rows out, position append-only.
 *
 * Session-generic on purpose (personal chats can adopt later); write access
 * is the caller's job (`gateSessionRead` — whoever can post can pin,
 * attributed via `added_by_user_id`).
 */

export const PIN_KINDS = [
  'page',
  'task',
  'contact',
  'company',
  'deal',
  'file',
  'url',
  'instruction',
] as const
export type PinKind = (typeof PIN_KINDS)[number]

/** Instruction pins cap at ~2k chars (T15 — they ride the turn verbatim). */
export const PIN_INSTRUCTION_MAX_CHARS = 2_000

export type SessionPin = {
  id: string
  sessionId: string
  kind: PinKind
  refId: string | null
  url: string | null
  text: string | null
  position: number
  addedByUserId: string | null
  createdAt: Date
}

const COLUMNS = `id, session_id AS "sessionId", kind, ref_id AS "refId", url,
                 text, "position", added_by_user_id AS "addedByUserId",
                 created_at AS "createdAt"`

export async function listSessionPins(sessionId: string): Promise<SessionPin[]> {
  const result = await query<SessionPin>(
    `SELECT ${COLUMNS} FROM session_pins
      WHERE session_id = $1
      ORDER BY "position" ASC, created_at ASC`,
    [sessionId],
  )
  return result.rows
}

export async function addSessionPin(params: {
  sessionId: string
  kind: PinKind
  refId?: string | null
  url?: string | null
  text?: string | null
  addedByUserId: string
}): Promise<SessionPin> {
  const result = await query<SessionPin>(
    `INSERT INTO session_pins (session_id, kind, ref_id, url, text, "position", added_by_user_id)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE((SELECT MAX("position") FROM session_pins WHERE session_id = $1), 0) + 1,
             $6)
     RETURNING ${COLUMNS}`,
    [
      params.sessionId,
      params.kind,
      params.refId ?? null,
      params.url ?? null,
      params.text ?? null,
      params.addedByUserId,
    ],
  )
  return result.rows[0]
}

/** Returns true when a row was removed (scoped to the session — a leaked pin
 *  id from another session deletes nothing). */
export async function removeSessionPin(
  sessionId: string,
  pinId: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM session_pins WHERE id = $1 AND session_id = $2`,
    [pinId, sessionId],
  )
  return (result.rowCount ?? 0) > 0
}
