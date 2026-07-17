/**
 * worker_runs store — Phase 3 of askQuestion suspend-resume.
 *
 * Persists per-worker state so a Cloud Run rotation between a session
 * suspend (kind='question') and the user's answer doesn't lose the
 * research findings. See migration 190 + the spec at
 * docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * Component tag: [COMP:api/worker-runs-store].
 *
 * All writes are system-bypass (the WorkerManager runs without an RLS
 * userId context). Reads happen in the chat-route resume path which also
 * runs with system_bypass.
 */

import type { Message } from '@use-brian/core'
import type { WorkerRunsStore } from '@use-brian/core'
import { query } from './client.js'

export function createDbWorkerRunsStore(): WorkerRunsStore {
  return {
    async recordSpawn(params) {
      // Each spawn gets a fresh row keyed by `runId` (the caller mints
      // a UUID and threads it through recordTurn / recordCompletion).
      // Migration 194 dropped the old UNIQUE(session_id, worker_id) so
      // two requests writing the same in-process worker_id no longer
      // collapse into one Frankenstein row.
      await query(
        `INSERT INTO worker_runs (
           id, session_id, workspace_id, worker_id, status, description,
           prompt, research_mode, model, turn_count, history_json,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8, 0, '[]'::jsonb, now(), now())`,
        [
          params.runId,
          params.sessionId,
          params.workspaceId,
          params.workerId,
          params.description,
          params.prompt,
          params.researchMode,
          params.model,
        ],
      )
    },

    async recordTurn(params) {
      // Persist the turn boundary snapshot. The history is the worker's
      // queryLoop statelessHistory; we stringify once at the SQL boundary.
      // WHERE id = $1 to target the exact row that recordSpawn inserted.
      await query(
        `UPDATE worker_runs
         SET turn_count   = $2,
             history_json = $3,
             updated_at   = now()
         WHERE id = $1`,
        [
          params.runId,
          params.turnCount,
          JSON.stringify(params.history),
        ],
      )
    },

    async recordCompletion(params) {
      await query(
        `UPDATE worker_runs
         SET status     = $2,
             result     = $3,
             turn_count = $4,
             updated_at = now()
         WHERE id = $1`,
        [
          params.runId,
          params.status,
          params.result,
          params.turnCount,
        ],
      )
    },

    async deleteTerminalOlderThan(cutoff) {
      const result = await query(
        `DELETE FROM worker_runs
         WHERE status IN ('completed', 'failed', 'stopped')
           AND updated_at < $1`,
        [cutoff],
      )
      return result.rowCount ?? 0
    },

    async loadForSession(sessionId) {
      const result = await query<{
        runId: string
        workerId: string
        status: 'running' | 'completed' | 'failed' | 'stopped'
        description: string
        prompt: string
        researchMode: boolean
        model: string
        turnCount: number
        result: string | null
        historyJson: unknown
      }>(
        `SELECT id             AS "runId",
                worker_id      AS "workerId",
                status,
                description,
                prompt,
                research_mode  AS "researchMode",
                model,
                turn_count     AS "turnCount",
                result,
                history_json   AS "historyJson"
         FROM worker_runs
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [sessionId],
      )
      return result.rows.map((r) => ({
        runId: r.runId,
        workerId: r.workerId,
        status: r.status,
        description: r.description,
        prompt: r.prompt,
        researchMode: r.researchMode,
        model: r.model,
        turnCount: r.turnCount,
        result: r.result,
        history: Array.isArray(r.historyJson) ? (r.historyJson as Message[]) : [],
      }))
    },

    async listRecentForWorkspace(workspaceId, limit) {
      // Backs the read-only `listResearchRuns` introspection tool. System
      // read — `worker_runs` has no user column, so visibility is bounded by
      // the workspace the tool passes from `ToolContext.workspaceId` (the
      // caller already established workspace membership). Newest-first;
      // `limit` is clamped in the tool layer (max 50) and defensively
      // clamped here too so a bad caller can't over-fetch. We deliberately
      // do NOT select `history_json` / `result` — the tool only needs the
      // summary fields, and the JSONB history can be large.
      const clamped = Math.max(1, Math.min(limit, 50))
      const result = await query<{
        id: string
        status: 'running' | 'completed' | 'failed' | 'stopped'
        description: string
        prompt: string
        sessionId: string
        createdAt: Date
        updatedAt: Date
      }>(
        `SELECT id,
                status,
                description,
                prompt,
                session_id  AS "sessionId",
                created_at  AS "createdAt",
                updated_at  AS "updatedAt"
         FROM worker_runs
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [workspaceId, clamped],
      )
      return result.rows.map((r) => ({
        id: r.id,
        status: r.status,
        description: r.description,
        prompt: r.prompt,
        sessionId: r.sessionId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
    },
  }
}
