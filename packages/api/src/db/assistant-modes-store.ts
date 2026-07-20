/**
 * Assistant modes store — CRUD for `assistant_modes` rows.
 *
 * Modes are owner-curated bundles of (exposed_tools, freshness, data scopes,
 * policy) that a destination assistant offers to inbound callers. See
 * docs/architecture/integrations/a2a.md and
 * docs/architecture/integrations/a2a.md.
 *
 * Auth is enforced at the route layer (workspace membership for the
 * assistant). The store uses bare `query()` because lookups by mode_id from
 * cross-workspace consult resolution must succeed regardless of the caller's
 * RLS scope.
 *
 * [COMP:api/assistant-modes-store]
 */

import type { AssistantMode } from '@use-brian/core'
import { query } from './client.js'

const MODE_COLS = `
  id,
  assistant_id              AS "assistantId",
  name,
  description,
  exposed_tools             AS "exposedTools",
  freshness,
  require_approval          AS "requireApproval",
  allow_onward_consults     AS "allowOnwardConsults",
  knowledge_max_sensitivity AS "knowledgeMaxSensitivity",
  memory_categories         AS "memoryCategories",
  created_at                AS "createdAt",
  updated_at                AS "updatedAt"
` as const

export type CreateModeInput = {
  assistantId: string
  name: string
  description?: string | null
  exposedTools?: string[]
  freshness?: 'live' | 'snapshot'
  requireApproval?: boolean
  allowOnwardConsults?: boolean
  knowledgeMaxSensitivity?: string | null
  memoryCategories?: string[] | null
}

export type UpdateModePatch = Partial<Omit<CreateModeInput, 'assistantId'>>

export type AssistantModesStore = {
  list(assistantId: string): Promise<AssistantMode[]>
  get(modeId: string): Promise<AssistantMode | null>
  create(input: CreateModeInput): Promise<AssistantMode>
  update(modeId: string, patch: UpdateModePatch): Promise<AssistantMode | null>
  delete(modeId: string): Promise<boolean>
}

export function createAssistantModesStore(): AssistantModesStore {
  return {
    async list(assistantId) {
      const result = await query<AssistantMode>(
        `SELECT ${MODE_COLS} FROM assistant_modes
         WHERE assistant_id = $1
         ORDER BY name ASC`,
        [assistantId],
      )
      return result.rows
    },

    async get(modeId) {
      const result = await query<AssistantMode>(
        `SELECT ${MODE_COLS} FROM assistant_modes WHERE id = $1`,
        [modeId],
      )
      return result.rows[0] ?? null
    },

    async create(input) {
      const result = await query<AssistantMode>(
        `INSERT INTO assistant_modes (
           assistant_id, name, description, exposed_tools, freshness,
           require_approval, allow_onward_consults,
           knowledge_max_sensitivity, memory_categories
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${MODE_COLS}`,
        [
          input.assistantId,
          input.name,
          input.description ?? null,
          input.exposedTools ?? [],
          input.freshness ?? 'live',
          input.requireApproval ?? false,
          input.allowOnwardConsults ?? false,
          input.knowledgeMaxSensitivity ?? null,
          input.memoryCategories ?? null,
        ],
      )
      return result.rows[0]
    },

    async update(modeId, patch) {
      // Build dynamic SET clause from supplied fields.
      const sets: string[] = []
      const values: unknown[] = [modeId]

      if (patch.name !== undefined) {
        sets.push(`name = $${values.length + 1}`)
        values.push(patch.name)
      }
      if (patch.description !== undefined) {
        sets.push(`description = $${values.length + 1}`)
        values.push(patch.description)
      }
      if (patch.exposedTools !== undefined) {
        sets.push(`exposed_tools = $${values.length + 1}`)
        values.push(patch.exposedTools)
      }
      if (patch.freshness !== undefined) {
        sets.push(`freshness = $${values.length + 1}`)
        values.push(patch.freshness)
      }
      if (patch.requireApproval !== undefined) {
        sets.push(`require_approval = $${values.length + 1}`)
        values.push(patch.requireApproval)
      }
      if (patch.allowOnwardConsults !== undefined) {
        sets.push(`allow_onward_consults = $${values.length + 1}`)
        values.push(patch.allowOnwardConsults)
      }
      if (patch.knowledgeMaxSensitivity !== undefined) {
        sets.push(`knowledge_max_sensitivity = $${values.length + 1}`)
        values.push(patch.knowledgeMaxSensitivity)
      }
      if (patch.memoryCategories !== undefined) {
        sets.push(`memory_categories = $${values.length + 1}`)
        values.push(patch.memoryCategories)
      }

      if (sets.length === 0) {
        // No changes — return the current row.
        const result = await query<AssistantMode>(
          `SELECT ${MODE_COLS} FROM assistant_modes WHERE id = $1`,
          [modeId],
        )
        return result.rows[0] ?? null
      }

      sets.push('updated_at = now()')
      const result = await query<AssistantMode>(
        `UPDATE assistant_modes SET ${sets.join(', ')}
         WHERE id = $1
         RETURNING ${MODE_COLS}`,
        values,
      )
      return result.rows[0] ?? null
    },

    async delete(modeId) {
      const result = await query(
        `DELETE FROM assistant_modes WHERE id = $1`,
        [modeId],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
