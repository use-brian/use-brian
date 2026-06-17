/**
 * Skill curator digest store — weekly aggregation of S10 curator actions.
 *
 * Backs `docs/architecture/context-engine/memory-consolidation.md` §S10 "Transparency
 * surface" — one row per workspace per week, holding a JSONB `actions`
 * payload that the workspace owner sees in their digest email + dashboard
 * "This week the curator…" surface. Action shape lives in the curator
 * worker; the schema is intentionally permissive so the worker can evolve
 * the explanation format without migrations.
 *
 * [COMP:api/skill-curator-digest-store]
 */

import { query, queryWithRLS } from './client.js'

export type SkillCuratorDigestRow = {
  id: string
  workspaceId: string
  weekOf: Date
  actions: unknown
  createdAt: Date
}

export type SkillCuratorDigestStore = {
  /**
   * Append a new digest row for the given workspace and week. Multiple
   * rows per (workspace, week) are allowed — the curator can re-emit in
   * the same week if a second pass completes, and the dashboard sums them.
   */
  append(workspaceId: string, weekOf: Date, actions: unknown): Promise<SkillCuratorDigestRow>

  /** Recent digests for a workspace, newest first. Caps via the `limit` arg. */
  listForWorkspace(
    workspaceId: string,
    limit?: number,
    opts?: { actingUserId?: string },
  ): Promise<SkillCuratorDigestRow[]>

  /** The most recent digest, or null if none has ever been emitted. */
  getLatest(
    workspaceId: string,
    opts?: { actingUserId?: string },
  ): Promise<SkillCuratorDigestRow | null>
}

const COLS_PUBLIC = `
  id,
  workspace_id AS "workspaceId",
  week_of      AS "weekOf",
  actions,
  created_at   AS "createdAt"
`

export function createDbSkillCuratorDigestStore(): SkillCuratorDigestStore {
  return {
    async append(workspaceId, weekOf, actions) {
      // System-level write — the curator worker has no user context. RLS on
      // the table still permits this via the system_bypass posture (mig 015
      // pattern; the workspace policy applies only when a user context is set).
      const r = await query<SkillCuratorDigestRow>(
        `INSERT INTO skill_curator_digest (workspace_id, week_of, actions)
         VALUES ($1, $2, $3::jsonb)
         RETURNING ${COLS_PUBLIC}`,
        [workspaceId, weekOf, JSON.stringify(actions)],
      )
      return r.rows[0]
    },

    async listForWorkspace(workspaceId, limit = 12, opts) {
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM skill_curator_digest
        WHERE workspace_id = $1
        ORDER BY week_of DESC, created_at DESC
        LIMIT $2
      `
      const params = [workspaceId, limit]
      if (opts?.actingUserId) {
        const r = await queryWithRLS<SkillCuratorDigestRow>(opts.actingUserId, sql, params)
        return r.rows
      }
      const r = await query<SkillCuratorDigestRow>(sql, params)
      return r.rows
    },

    async getLatest(workspaceId, opts) {
      const rows = await this.listForWorkspace(workspaceId, 1, opts)
      return rows[0] ?? null
    },
  }
}
