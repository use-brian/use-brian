import { getPool, query } from '../db/client.js'
import {
  SUPPORT_DIAGNOSTIC_EVENT_LIMIT,
  type PendingSupportDiagnosticEvent,
  type SupportDiagnosticCapture,
  type SupportDiagnosticEvent,
  type SupportDiagnosticsStore,
} from './types.js'

type CaptureRow = {
  id: string
  userId: string
  workspaceId: string
  includeContent: boolean
  pseudonymSalt: Buffer
  startedAt: Date
  expiresAt: Date
  eventCount: string
}

const CAPTURE_SELECT = `
  SELECT s.id,
         s.user_id AS "userId",
         s.workspace_id AS "workspaceId",
         s.include_content AS "includeContent",
         s.pseudonym_salt AS "pseudonymSalt",
         s.started_at AS "startedAt",
         s.expires_at AS "expiresAt",
         count(e.id)::text AS "eventCount"
  FROM support_diagnostic_sessions s
  LEFT JOIN support_diagnostic_events e ON e.support_session_id = s.id
`

function toCapture(row: CaptureRow): SupportDiagnosticCapture {
  return {
    ...row,
    startedAt: new Date(row.startedAt),
    expiresAt: new Date(row.expiresAt),
    eventCount: Number.parseInt(row.eventCount, 10) || 0,
  }
}

export class SupportDiagnosticConflictError extends Error {
  constructor() {
    super('A support capture is already active on this installation')
    this.name = 'SupportDiagnosticConflictError'
  }
}

export function createSupportDiagnosticsStore(): SupportDiagnosticsStore {
  return {
    async start(params) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`DELETE FROM support_diagnostic_sessions WHERE expires_at <= now()`)
        try {
          await client.query(
            `INSERT INTO support_diagnostic_sessions
               (id, user_id, workspace_id, include_content, pseudonym_salt, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              params.id,
              params.userId,
              params.workspaceId,
              params.includeContent,
              params.pseudonymSalt,
              params.expiresAt,
            ],
          )
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new SupportDiagnosticConflictError()
          }
          throw error
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      const capture = await this.getOwnedActive(params.userId, params.workspaceId)
      if (!capture) throw new Error('Support capture was not persisted')
      return capture
    },

    async getAnyActive() {
      await query(`DELETE FROM support_diagnostic_sessions WHERE expires_at <= now()`)
      const result = await query<CaptureRow>(
        `${CAPTURE_SELECT}
         WHERE s.expires_at > now()
         GROUP BY s.id
         LIMIT 1`,
      )
      return result.rows[0] ? toCapture(result.rows[0]) : null
    },

    async getOwnedActive(userId, workspaceId) {
      await query(`DELETE FROM support_diagnostic_sessions WHERE expires_at <= now()`)
      const result = await query<CaptureRow>(
        `${CAPTURE_SELECT}
         WHERE s.user_id = $1
           AND s.workspace_id = $2
           AND s.expires_at > now()
         GROUP BY s.id
         LIMIT 1`,
        [userId, workspaceId],
      )
      return result.rows[0] ? toCapture(result.rows[0]) : null
    },

    async appendEvents(captureId, events) {
      if (events.length === 0) return
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const values: unknown[] = []
        const tuples = events.map((event, index) => {
          const offset = index * 5
          values.push(
            captureId,
            event.level,
            event.message,
            event.fingerprint,
            event.createdAt ?? new Date(),
          )
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
        })
        await client.query(
          `INSERT INTO support_diagnostic_events
             (support_session_id, level, message, fingerprint, created_at)
           VALUES ${tuples.join(', ')}`,
          values,
        )
        await client.query(
          `DELETE FROM support_diagnostic_events
           WHERE id IN (
             SELECT id
             FROM support_diagnostic_events
             WHERE support_session_id = $1
             ORDER BY created_at DESC, id DESC
             OFFSET $2
           )`,
          [captureId, SUPPORT_DIAGNOSTIC_EVENT_LIMIT],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    async listEvents(captureId) {
      const result = await query<SupportDiagnosticEvent>(
        `SELECT id,
                support_session_id AS "supportSessionId",
                level,
                message,
                fingerprint,
                created_at AS "createdAt"
         FROM support_diagnostic_events
         WHERE support_session_id = $1
         ORDER BY created_at, id
         LIMIT $2`,
        [captureId, SUPPORT_DIAGNOSTIC_EVENT_LIMIT],
      )
      return result.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }))
    },

    async deleteCapture(captureId) {
      await query(`DELETE FROM support_diagnostic_sessions WHERE id = $1`, [captureId])
    },

    async deleteOwnedCapture(userId, workspaceId) {
      const result = await query<{ id: string }>(
        `DELETE FROM support_diagnostic_sessions
         WHERE user_id = $1 AND workspace_id = $2
         RETURNING id`,
        [userId, workspaceId],
      )
      return result.rows[0]?.id ?? null
    },

    async deleteExpired() {
      const result = await query<{ id: string }>(
        `DELETE FROM support_diagnostic_sessions
         WHERE expires_at <= now()
         RETURNING id`,
      )
      return result.rows.map((row) => row.id)
    },
  }
}
