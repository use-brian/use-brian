/**
 * Page actions store, backed by PostgreSQL (migration 321).
 *
 * A row is one button binding — blueprint-scoped (shows on every page the
 * blueprint projects, via `blueprint_records.page_id`) or page-scoped. The
 * `action` jsonb is the closed `PageActionSpec` union, Zod-parsed at the
 * REST boundary before it ever reaches this store.
 *
 * `resolveForPage` is the forward read the page header renders from:
 * page-scoped rows ∪ blueprint-scoped rows joined through the page's record
 * projection. RLS (`page_actions_workspace_member`) scopes everything to
 * workspace membership; all access goes through `queryWithRLS(userId, ...)`.
 *
 * Spec: docs/architecture/features/page-actions.md.
 *
 * [COMP:api/page-actions-store]
 */

import type { PageAction, PageActionSpec } from '@sidanclaw/core'

import { queryWithRLS } from './client.js'

export type PageActionsStore = {
  create(
    userId: string,
    input: {
      workspaceId: string
      blueprintId?: string | null
      pageId?: string | null
      label: string
      icon?: string | null
      confirmCopy?: string | null
      action: PageActionSpec
      position?: number
    },
  ): Promise<PageAction>
  getById(userId: string, id: string): Promise<PageAction | null>
  /** Blueprint-scoped bindings, for the blueprint editor's Actions section. */
  listForBlueprint(userId: string, workspaceId: string, blueprintId: string): Promise<PageAction[]>
  /**
   * Every ENABLED binding that applies to this page: page-scoped rows plus
   * blueprint-scoped rows whose blueprint projects this page. The page-header
   * button strip renders exactly this.
   */
  resolveForPage(userId: string, workspaceId: string, pageId: string): Promise<PageAction[]>
  /** Bindings whose action starts the given workflow — the PA-11 honesty read. */
  listForWorkflow(userId: string, workspaceId: string, workflowId: string): Promise<PageAction[]>
  update(
    userId: string,
    id: string,
    patch: {
      label?: string
      icon?: string | null
      confirmCopy?: string | null
      action?: PageActionSpec
      enabled?: boolean
      position?: number
    },
  ): Promise<PageAction | null>
  delete(userId: string, id: string): Promise<boolean>
}

type Row = {
  id: string
  workspace_id: string
  blueprint_id: string | null
  page_id: string | null
  label: string
  icon: string | null
  confirm_copy: string | null
  action: PageActionSpec
  enabled: boolean
  position: number
  created_by: string
  created_at: Date
  updated_at: Date
}

const SELECT =
  'id, workspace_id, blueprint_id, page_id, label, icon, confirm_copy, action, enabled, position, created_by, created_at, updated_at'

function rowToAction(row: Row): PageAction {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blueprintId: row.blueprint_id,
    pageId: row.page_id,
    label: row.label,
    icon: row.icon,
    confirmCopy: row.confirm_copy,
    action: row.action,
    enabled: row.enabled,
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function createDbPageActionsStore(): PageActionsStore {
  return {
    async create(userId, input) {
      const result = await queryWithRLS<Row>(
        userId,
        `INSERT INTO page_actions
           (workspace_id, blueprint_id, page_id, label, icon, confirm_copy, action, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${SELECT}`,
        [
          input.workspaceId,
          input.blueprintId ?? null,
          input.pageId ?? null,
          input.label,
          input.icon ?? null,
          input.confirmCopy ?? null,
          JSON.stringify(input.action),
          input.position ?? 0,
          userId,
        ],
      )
      return rowToAction(result.rows[0])
    },

    async getById(userId, id) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM page_actions WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToAction(result.rows[0]) : null
    },

    async listForBlueprint(userId, workspaceId, blueprintId) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM page_actions
         WHERE workspace_id = $1 AND blueprint_id = $2
         ORDER BY position ASC, created_at ASC`,
        [workspaceId, blueprintId],
      )
      return result.rows.map(rowToAction)
    },

    async resolveForPage(userId, workspaceId, pageId) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT * FROM (
           SELECT ${SELECT} FROM page_actions
            WHERE workspace_id = $1 AND page_id = $2 AND enabled
           UNION ALL
           SELECT pa.id, pa.workspace_id, pa.blueprint_id, pa.page_id, pa.label, pa.icon,
                  pa.confirm_copy, pa.action, pa.enabled, pa.position, pa.created_by,
                  pa.created_at, pa.updated_at
             FROM page_actions pa
             JOIN blueprint_records br
               ON br.blueprint_id = pa.blueprint_id AND br.workspace_id = pa.workspace_id
            WHERE pa.workspace_id = $1 AND br.page_id = $2 AND pa.enabled
         ) actions
         ORDER BY position ASC, created_at ASC`,
        [workspaceId, pageId],
      )
      return result.rows.map(rowToAction)
    },

    async listForWorkflow(userId, workspaceId, workflowId) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM page_actions
         WHERE workspace_id = $1
           AND action->>'kind' = 'workflow'
           AND action->>'workflowId' = $2
         ORDER BY position ASC, created_at ASC`,
        [workspaceId, workflowId],
      )
      return result.rows.map(rowToAction)
    },

    async update(userId, id, patch) {
      const result = await queryWithRLS<Row>(
        userId,
        `UPDATE page_actions SET
           label = COALESCE($2, label),
           icon = CASE WHEN $3 THEN $4 ELSE icon END,
           confirm_copy = CASE WHEN $5 THEN $6 ELSE confirm_copy END,
           action = COALESCE($7::jsonb, action),
           enabled = COALESCE($8, enabled),
           position = COALESCE($9, position)
         WHERE id = $1
         RETURNING ${SELECT}`,
        [
          id,
          patch.label ?? null,
          patch.icon !== undefined,
          patch.icon ?? null,
          patch.confirmCopy !== undefined,
          patch.confirmCopy ?? null,
          patch.action ? JSON.stringify(patch.action) : null,
          patch.enabled ?? null,
          patch.position ?? null,
        ],
      )
      return result.rows[0] ? rowToAction(result.rows[0]) : null
    },

    async delete(userId, id) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `DELETE FROM page_actions WHERE id = $1 RETURNING id`,
        [id],
      )
      return result.rows.length > 0
    },
  }
}
