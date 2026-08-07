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
 * attributed via `added_by_user_id`, or `added_by_assistant_id` when the
 * room's assistant pinned it through the room pin tools — migration 421).
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
  addedByAssistantId: string | null
  createdAt: Date
}

const COLUMNS = `id, session_id AS "sessionId", kind, ref_id AS "refId", url,
                 text, "position", added_by_user_id AS "addedByUserId",
                 added_by_assistant_id AS "addedByAssistantId",
                 created_at AS "createdAt"`

/**
 * Per-kind payload validation, shared by the pins route and the room pin
 * tools so the two write paths cannot drift: ref kinds need a UUID, `url`
 * needs a well-formed http(s) URL ≤2048 chars, `instruction` text is trimmed
 * and capped at PIN_INSTRUCTION_MAX_CHARS.
 */
export function validateSessionPinPayload(body: {
  kind?: string
  refId?: unknown
  url?: unknown
  text?: unknown
}):
  | { ok: true; kind: PinKind; refId: string | null; url: string | null; text: string | null }
  | { ok: false; error: string } {
  const kind = body.kind as PinKind
  if (!kind || !(PIN_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: 'Unknown pin kind' }
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (kind === 'url') {
    const raw = typeof body.url === 'string' ? body.url.trim() : ''
    let parsed: URL | null = null
    try { parsed = new URL(raw) } catch { parsed = null }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || raw.length > 2048) {
      return { ok: false, error: 'Invalid URL' }
    }
    return { ok: true, kind, refId: null, url: raw, text: null }
  }
  if (kind === 'instruction') {
    const raw = typeof body.text === 'string' ? body.text.trim() : ''
    if (!raw) return { ok: false, error: 'Missing instruction text' }
    return { ok: true, kind, refId: null, url: null, text: raw.slice(0, PIN_INSTRUCTION_MAX_CHARS) }
  }
  const raw = typeof body.refId === 'string' ? body.refId.trim() : ''
  if (!UUID_RE.test(raw)) return { ok: false, error: 'Missing or invalid refId' }
  return { ok: true, kind, refId: raw, url: null, text: null }
}

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
  /** Exactly one of the two attribution ids: the member who pinned … */
  addedByUserId?: string | null
  /** … or the assistant that pinned through the room pin tools. */
  addedByAssistantId?: string | null
}): Promise<SessionPin> {
  const result = await query<SessionPin>(
    `INSERT INTO session_pins (session_id, kind, ref_id, url, text, "position", added_by_user_id, added_by_assistant_id)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE((SELECT MAX("position") FROM session_pins WHERE session_id = $1), 0) + 1,
             $6, $7)
     RETURNING ${COLUMNS}`,
    [
      params.sessionId,
      params.kind,
      params.refId ?? null,
      params.url ?? null,
      params.text ?? null,
      params.addedByUserId ?? null,
      params.addedByAssistantId ?? null,
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
