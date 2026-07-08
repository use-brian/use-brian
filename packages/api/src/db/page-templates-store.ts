/**
 * Custom page templates store, backed by PostgreSQL (migration 281).
 *
 * Workspace-shared, user-authored doc-page templates. A row is a reusable page
 * skeleton: name + icon + category + a `blocks` snapshot. The built-in catalog
 * (`PAGE_TEMPLATES` in `@sidanclaw/core`) is code; this store is the custom
 * half, merged with the catalog by the gallery + the brain-MCP template tools.
 *
 * RLS via the `workspace_page_templates_workspace_member` policy — every
 * workspace member can read / write their workspaces' templates (workspace-
 * shared visibility). All access goes through `queryWithRLS(userId, ...)`.
 *
 * [COMP:api/page-templates-store]
 */

import type {
  Block,
  CustomPageTemplate,
  CustomPageTemplateSummary,
  ExtractionSpec,
  PageTemplateCategory,
} from '@sidanclaw/core'
import { normalizeExtractionSpec } from '@sidanclaw/core'

import { queryWithRLS } from './client.js'

/** Create input — `blocks` is pre-validated at the route boundary. */
export type CreatePageTemplateInput = {
  workspaceId: string
  name: string
  description?: string | null
  icon?: string | null
  category: PageTemplateCategory
  blocks: Block[]
  /** Present → the saved template is a blueprint the synthesis engine can fill. */
  extraction?: ExtractionSpec | null
}

/** Partial update — only present keys are written. `undefined` = leave as-is;
 *  `null` clears the nullable columns (description / icon / extraction). */
export type UpdatePageTemplateInput = {
  name?: string
  description?: string | null
  icon?: string | null
  category?: PageTemplateCategory
  blocks?: Block[]
  extraction?: ExtractionSpec | null
}

export type PageTemplateStore = {
  /** Workspace's custom templates, newest first, without the heavy `blocks`. */
  list(userId: string, workspaceId: string): Promise<CustomPageTemplateSummary[]>
  /** One template with its `blocks` (for instantiation). Null = not found / no access. */
  getById(userId: string, id: string): Promise<CustomPageTemplate | null>
  /** Persist a new custom template; returns the full row. */
  create(userId: string, input: CreatePageTemplateInput): Promise<CustomPageTemplate>
  /** Patch a template in place; returns the updated row, null = not found / no access. */
  update(userId: string, id: string, patch: UpdatePageTemplateInput): Promise<CustomPageTemplate | null>
  /** Hard delete; true when a row was removed (RLS-scoped). */
  remove(userId: string, id: string): Promise<boolean>
}

type SummaryRow = {
  id: string
  workspace_id: string
  created_by: string
  name: string
  description: string | null
  icon: string | null
  category: string
  /** Raw JSONB — may be the v1 `sections` shape; normalized on read. */
  extraction: unknown
  created_at: Date
  updated_at: Date
}

type FullRow = SummaryRow & { blocks: Block[] }

const SUMMARY_SELECT =
  'id, workspace_id, created_by, name, description, icon, category, extraction, created_at, updated_at'
const FULL_SELECT = `${SUMMARY_SELECT}, blocks`

function rowToSummary(row: SummaryRow): CustomPageTemplateSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: row.category as PageTemplateCategory,
    // Old rows persist the v1 `sections` shape; every consumer downstream of
    // the store sees the typed v2 contract (or null for a plain skeleton).
    extraction: normalizeExtractionSpec(row.extraction),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function rowToFull(row: FullRow): CustomPageTemplate {
  return { ...rowToSummary(row), blocks: row.blocks }
}

export function createDbPageTemplateStore(): PageTemplateStore {
  return {
    async list(userId, workspaceId) {
      const result = await queryWithRLS<SummaryRow>(
        userId,
        `SELECT ${SUMMARY_SELECT} FROM workspace_page_templates
         WHERE workspace_id = $1
         ORDER BY updated_at DESC
         LIMIT 500`,
        [workspaceId],
      )
      return result.rows.map(rowToSummary)
    },

    async getById(userId, id) {
      const result = await queryWithRLS<FullRow>(
        userId,
        `SELECT ${FULL_SELECT} FROM workspace_page_templates WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToFull(result.rows[0]) : null
    },

    async create(userId, { workspaceId, name, description, icon, category, blocks, extraction }) {
      const result = await queryWithRLS<FullRow>(
        userId,
        `INSERT INTO workspace_page_templates
           (workspace_id, created_by, name, description, icon, category, blocks, extraction)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${FULL_SELECT}`,
        [
          workspaceId,
          userId,
          name,
          description ?? null,
          icon ?? null,
          category,
          JSON.stringify(blocks),
          extraction ? JSON.stringify(extraction) : null,
        ],
      )
      return rowToFull(result.rows[0])
    },

    async update(userId, id, patch) {
      const sets: string[] = []
      const params: unknown[] = [id]
      const push = (column: string, value: unknown) => {
        params.push(value)
        sets.push(`${column} = $${params.length}`)
      }
      if (patch.name !== undefined) push('name', patch.name)
      if (patch.description !== undefined) push('description', patch.description)
      if (patch.icon !== undefined) push('icon', patch.icon)
      if (patch.category !== undefined) push('category', patch.category)
      if (patch.blocks !== undefined) push('blocks', JSON.stringify(patch.blocks))
      if (patch.extraction !== undefined)
        push('extraction', patch.extraction ? JSON.stringify(patch.extraction) : null)
      if (sets.length === 0) return this.getById(userId, id)
      const result = await queryWithRLS<FullRow>(
        userId,
        `UPDATE workspace_page_templates
         SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $1
         RETURNING ${FULL_SELECT}`,
        params,
      )
      return result.rows[0] ? rowToFull(result.rows[0]) : null
    },

    async remove(userId, id) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `DELETE FROM workspace_page_templates WHERE id = $1 RETURNING id`,
        [id],
      )
      return result.rows.length > 0
    },
  }
}
