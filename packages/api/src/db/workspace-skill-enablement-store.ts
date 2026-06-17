/**
 * Workspace skill enablement store — per-assistant binding for workspace
 * skills (UUID FK).
 *
 * Backs the V2 S14 split between workspace-wide visibility and per-
 * assistant enablement (`docs/architecture/engine/skill-system.md` §S14
 * "Per-assistant enablement"). Auto-generated skills become visible
 * workspace-wide but enabled only on the originating assistant by
 * default; other assistants opt in via `enable`.
 *
 * Sibling to the legacy `assistant_skill_settings` table, which stays
 * keyed by TEXT slug for built-in skill toggles.
 *
 * RLS is delegated to the parent `workspace_skills` row's workspace_id
 * via the mig 169 policy.
 *
 * [COMP:api/workspace-skill-enablement-store]
 */

import { query, queryWithRLS } from './client.js'

export type WorkspaceSkillEnablement = {
  workspaceSkillId: string
  assistantId: string
  enabledAt: Date
  /** NULL = system-seeded (curator creation / mig 264 backfill); else the toggling user. */
  enabledByUserId: string | null
}

export type WorkspaceSkillEnablementStore = {
  /** Skills enabled for a specific assistant (workspace-scoped via parent row's RLS). */
  listForAssistant(
    assistantId: string,
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillEnablement[]>

  /** Whether a workspace skill is enabled for a specific assistant. */
  isEnabled(workspaceSkillId: string, assistantId: string): Promise<boolean>

  /** Idempotent enable — re-enable is a no-op (PRIMARY KEY conflict ignored). */
  enable(
    workspaceSkillId: string,
    assistantId: string,
    actingUserId: string,
  ): Promise<WorkspaceSkillEnablement>

  /**
   * Enablement rows for one skill — the skill-centric dual of
   * `listForAssistant` (brain-skill-management plan §4: the editor's Access
   * tab). Workspace-scoped via the parent row's RLS when `actingUserId` set.
   */
  listForSkill(
    workspaceSkillId: string,
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillEnablement[]>

  /**
   * Bulk variant for the workspace skill list projection — one query for the
   * whole library instead of N per-skill lookups.
   */
  listForSkillIds(
    workspaceSkillIds: string[],
    opts?: { actingUserId?: string },
  ): Promise<WorkspaceSkillEnablement[]>

  /** Remove the (skill, assistant) row. Returns true if a row was deleted. */
  disable(
    workspaceSkillId: string,
    assistantId: string,
    actingUserId: string,
  ): Promise<boolean>

  /**
   * Remove every enablement row for a skill. System-level — used by the
   * skill-management "disable everywhere" action and curator archival.
   */
  disableAll(workspaceSkillId: string): Promise<number>
}

const COLS_PUBLIC = `
  workspace_skill_id AS "workspaceSkillId",
  assistant_id       AS "assistantId",
  enabled_at         AS "enabledAt",
  enabled_by_user_id AS "enabledByUserId"
`

export function createDbWorkspaceSkillEnablementStore(): WorkspaceSkillEnablementStore {
  return {
    async listForAssistant(assistantId, opts) {
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_enablement
        WHERE assistant_id = $1
        ORDER BY enabled_at DESC
      `
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillEnablement>(opts.actingUserId, sql, [
          assistantId,
        ])
        return r.rows
      }
      const r = await query<WorkspaceSkillEnablement>(sql, [assistantId])
      return r.rows
    },

    async listForSkill(workspaceSkillId, opts) {
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_enablement
        WHERE workspace_skill_id = $1
        ORDER BY enabled_at DESC
      `
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillEnablement>(opts.actingUserId, sql, [
          workspaceSkillId,
        ])
        return r.rows
      }
      const r = await query<WorkspaceSkillEnablement>(sql, [workspaceSkillId])
      return r.rows
    },

    async listForSkillIds(workspaceSkillIds, opts) {
      if (workspaceSkillIds.length === 0) return []
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM workspace_skill_enablement
        WHERE workspace_skill_id = ANY($1)
        ORDER BY enabled_at DESC
      `
      if (opts?.actingUserId) {
        const r = await queryWithRLS<WorkspaceSkillEnablement>(opts.actingUserId, sql, [
          workspaceSkillIds,
        ])
        return r.rows
      }
      const r = await query<WorkspaceSkillEnablement>(sql, [workspaceSkillIds])
      return r.rows
    },

    async isEnabled(workspaceSkillId, assistantId) {
      const r = await query<{ '?column?': number }>(
        `SELECT 1 FROM workspace_skill_enablement
         WHERE workspace_skill_id = $1 AND assistant_id = $2
         LIMIT 1`,
        [workspaceSkillId, assistantId],
      )
      return r.rows.length > 0
    },

    async enable(workspaceSkillId, assistantId, actingUserId) {
      // ON CONFLICT (PK) DO UPDATE on enabled_at lets the call act as a
      // refresh too — the trade-off is that the audit doesn't preserve the
      // first-enabled time. The S14 spec frames enablement as a current-
      // state row, not a timeline, so the refresh shape is correct.
      const r = await queryWithRLS<WorkspaceSkillEnablement>(
        actingUserId,
        `INSERT INTO workspace_skill_enablement
           (workspace_skill_id, assistant_id, enabled_by_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_skill_id, assistant_id) DO UPDATE
           SET enabled_at = now(),
               enabled_by_user_id = EXCLUDED.enabled_by_user_id
         RETURNING ${COLS_PUBLIC}`,
        [workspaceSkillId, assistantId, actingUserId],
      )
      return r.rows[0]
    },

    async disable(workspaceSkillId, assistantId, actingUserId) {
      const r = await queryWithRLS(
        actingUserId,
        `DELETE FROM workspace_skill_enablement
         WHERE workspace_skill_id = $1 AND assistant_id = $2`,
        [workspaceSkillId, assistantId],
      )
      return (r.rowCount ?? 0) > 0
    },

    async disableAll(workspaceSkillId) {
      const r = await query(
        `DELETE FROM workspace_skill_enablement WHERE workspace_skill_id = $1`,
        [workspaceSkillId],
      )
      return r.rowCount ?? 0
    },
  }
}
