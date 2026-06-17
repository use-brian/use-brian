import type {
  SessionStateSource,
  SessionStateStatus,
} from '@sidanclaw/core'
import { query } from './client.js'

export type SessionStateRow = {
  id: string
  sessionId: string
  userId: string
  assistantId: string
  key: string
  status: SessionStateStatus
  summary: string
  detail: string | null
  source: SessionStateSource
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
}

const SELECT = `
  id,
  session_id   as "sessionId",
  user_id      as "userId",
  assistant_id as "assistantId",
  key,
  status,
  summary,
  detail,
  source,
  created_at  as "createdAt",
  updated_at  as "updatedAt",
  resolved_at as "resolvedAt"
`

export async function upsertSessionState(params: {
  sessionId: string
  userId: string
  assistantId: string
  key: string
  summary: string
  detail: string | null
  source: SessionStateSource
}): Promise<SessionStateRow> {
  // ON CONFLICT (session_id, key): reopen any resolved row (status='open',
  // resolved_at=NULL), bump updated_at, and apply the provenance rule for
  // summary/detail — see docs/architecture/context-engine/session-state.md
  // "Provenance rule on conflicting writes".
  //
  // Rule: when the incoming write is `source='diff-pass'` but the existing
  // row was last written by `source='tool'`, preserve the existing
  // summary + detail. The tool path is authoritative; a background Flash
  // inference cannot destroy what the model explicitly committed. Any
  // other combination (tool over anything, diff-pass over diff-pass,
  // fresh insert) writes normally.
  const result = await query<SessionStateRow>(
    `INSERT INTO session_state
       (session_id, user_id, assistant_id, key, status, summary, detail, source)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)
     ON CONFLICT (session_id, key) DO UPDATE SET
       status      = 'open',
       summary     = CASE
                       WHEN EXCLUDED.source = 'diff-pass' AND session_state.source = 'tool'
                         THEN session_state.summary
                       ELSE EXCLUDED.summary
                     END,
       detail      = CASE
                       WHEN EXCLUDED.source = 'diff-pass' AND session_state.source = 'tool'
                         THEN session_state.detail
                       ELSE EXCLUDED.detail
                     END,
       source      = EXCLUDED.source,
       updated_at  = now(),
       resolved_at = NULL
     RETURNING ${SELECT}`,
    [
      params.sessionId,
      params.userId,
      params.assistantId,
      params.key,
      params.summary,
      params.detail,
      params.source,
    ],
  )
  return result.rows[0]
}

export async function resolveSessionState(params: {
  sessionId: string
  key: string
  source: SessionStateSource
}): Promise<SessionStateRow | null> {
  const result = await query<SessionStateRow>(
    `UPDATE session_state
        SET status      = 'resolved',
            source      = $3,
            updated_at  = now(),
            resolved_at = now()
      WHERE session_id = $1
        AND key = $2
        AND status = 'open'
     RETURNING ${SELECT}`,
    [params.sessionId, params.key, params.source],
  )
  return result.rows[0] ?? null
}

export async function listOpenSessionState(
  sessionId: string,
): Promise<SessionStateRow[]> {
  const result = await query<SessionStateRow>(
    `SELECT ${SELECT}
       FROM session_state
      WHERE session_id = $1
        AND status = 'open'
      ORDER BY updated_at DESC`,
    [sessionId],
  )
  return result.rows
}

export async function listRecentSessionState(
  sessionId: string,
  limit = 50,
): Promise<SessionStateRow[]> {
  const result = await query<SessionStateRow>(
    `SELECT ${SELECT}
       FROM session_state
      WHERE session_id = $1
      ORDER BY
        CASE WHEN status = 'open' THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT $2`,
    [sessionId, limit],
  )
  return result.rows
}

export async function purgeResolvedSessionState(
  sessionId: string,
  olderThan: Date,
): Promise<number> {
  const result = await query<{ id: string }>(
    `DELETE FROM session_state
      WHERE session_id = $1
        AND status <> 'open'
        AND resolved_at IS NOT NULL
        AND resolved_at < $2
     RETURNING id`,
    [sessionId, olderThan],
  )
  return result.rowCount ?? result.rows.length
}
