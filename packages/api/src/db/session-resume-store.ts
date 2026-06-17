/**
 * Session resume points store — Path B durable chat resume (Q22 RESOLVED).
 *
 * A row is INSERTed by the tool executor when a `describeConfirmation` tool
 * suspends a turn, alongside the `pending_approvals` row. It captures the
 * minimum state needed to re-enter the query loop after a Cloud Run
 * restart: the suspended tool name, the model-proposed input (frozen at
 * suspension), and the loop step index.
 *
 * Lifecycle:
 *   - INSERT at suspension time (tool executor, WU-6.3 territory).
 *   - DELETE on turn completion (live Path A or restart-path resume).
 *   - CASCADE delete on `pending_approvals` expiry or session deletion.
 *
 * RLS posture: system-bypass only — `app.system_bypass='true'` is the pool
 * default, so the bare `query()` helper is the right entry point. Migration
 * 124 enforces this; workspace-member direct reads are not needed.
 *
 * See migration 124 + docs/plans/company-brain/approvals.md → "Chat resume
 * — Path B (lightweight checkpoint) — Q22 RESOLVED".
 *
 * [COMP:api/session-resume-store]
 */

import { query } from './client.js'

export type SessionResumePoint = {
  sessionId: string
  approvalId: string
  suspendedToolName: string
  suspendedToolInput: unknown
  loopStepIndex: number
  createdAt: Date
}

export type CreateSessionResumePointParams = {
  sessionId: string
  approvalId: string
  suspendedToolName: string
  suspendedToolInput: unknown
  loopStepIndex: number
}

const COLS = `
  session_id            AS "sessionId",
  approval_id           AS "approvalId",
  suspended_tool_name   AS "suspendedToolName",
  suspended_tool_input  AS "suspendedToolInput",
  loop_step_index       AS "loopStepIndex",
  created_at            AS "createdAt"
`

export type SessionResumeStore = {
  /** Insert a resume point. Idempotent on (session_id) — a re-insert for an
   * already-suspended session returns the existing row instead of erroring,
   * so a retried suspension path is safe. */
  create(params: CreateSessionResumePointParams): Promise<SessionResumePoint>

  /** Lookup by session — used by the chat-route post-turn cleanup to spot a
   * lingering resume point that needs sweeping. */
  getBySessionId(sessionId: string): Promise<SessionResumePoint | null>

  /** Lookup by approval — used by the resume worker dispatch on
   * `trigger_kind='session_resume'` jobs to fetch the suspended state. */
  getByApprovalId(approvalId: string): Promise<SessionResumePoint | null>

  /** Delete by session id. Returns true if a row was removed. Called by the
   * resume worker on successful turn completion and by the live Path A
   * resume on normal turn end. */
  deleteBySessionId(sessionId: string): Promise<boolean>

  /** Delete by approval id. Returns true if a row was removed. Useful in
   * tests and any path that has the approval id but not the session id. */
  deleteByApprovalId(approvalId: string): Promise<boolean>
}

function rowToPoint(row: Record<string, unknown>): SessionResumePoint {
  return {
    sessionId: row.sessionId as string,
    approvalId: row.approvalId as string,
    suspendedToolName: row.suspendedToolName as string,
    suspendedToolInput: row.suspendedToolInput,
    loopStepIndex: row.loopStepIndex as number,
    createdAt: row.createdAt as Date,
  }
}

export function createDbSessionResumeStore(): SessionResumeStore {
  return {
    async create(params) {
      // ON CONFLICT (session_id) DO NOTHING then re-read on conflict — a
      // session has at most one active suspension at a time (PRIMARY KEY on
      // session_id enforces this), so a duplicate insert is a no-op rather
      // than an error. RETURNING is empty on conflict, hence the re-read.
      const inserted = await query(
        `INSERT INTO session_resume_points (
           session_id, approval_id, suspended_tool_name, suspended_tool_input, loop_step_index
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id) DO NOTHING
         RETURNING ${COLS}`,
        [
          params.sessionId,
          params.approvalId,
          params.suspendedToolName,
          JSON.stringify(params.suspendedToolInput),
          params.loopStepIndex,
        ],
      )
      if (inserted.rows[0]) {
        return rowToPoint(inserted.rows[0] as Record<string, unknown>)
      }
      const existing = await query(
        `SELECT ${COLS} FROM session_resume_points WHERE session_id = $1`,
        [params.sessionId],
      )
      return rowToPoint(existing.rows[0] as Record<string, unknown>)
    },

    async getBySessionId(sessionId) {
      const result = await query(
        `SELECT ${COLS} FROM session_resume_points WHERE session_id = $1`,
        [sessionId],
      )
      return result.rows[0]
        ? rowToPoint(result.rows[0] as Record<string, unknown>)
        : null
    },

    async getByApprovalId(approvalId) {
      const result = await query(
        `SELECT ${COLS} FROM session_resume_points WHERE approval_id = $1`,
        [approvalId],
      )
      return result.rows[0]
        ? rowToPoint(result.rows[0] as Record<string, unknown>)
        : null
    },

    async deleteBySessionId(sessionId) {
      const result = await query(
        `DELETE FROM session_resume_points WHERE session_id = $1`,
        [sessionId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async deleteByApprovalId(approvalId) {
      const result = await query(
        `DELETE FROM session_resume_points WHERE approval_id = $1`,
        [approvalId],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
