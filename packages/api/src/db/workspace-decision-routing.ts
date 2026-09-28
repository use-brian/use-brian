/**
 * Workspace decision-classifier preference (migration 604).
 *
 * A hybrid workspace preference is only a request: runtime authority still
 * requires a non-revoked exact-version profile for each operation.
 *
 * [COMP:decisions/workspace-routing]
 */
import { isDecisionModelRow, registryRow } from '@use-brian/shared/model-registry'
import { query, queryWithRLS } from './client.js'

export type WorkspaceDecisionRoutingMode = 'llm_only' | 'shadow' | 'hybrid'

export type WorkspaceDecisionRouting = {
  workspaceId: string
  mode: WorkspaceDecisionRoutingMode
  modelAlias: string | null
  updatedAt: string
}

type DecisionRoutingRow = {
  workspace_id: string
  mode: WorkspaceDecisionRoutingMode
  model_alias: string | null
  updated_at: string
}

function toSetting(row: DecisionRoutingRow): WorkspaceDecisionRouting {
  return {
    workspaceId: row.workspace_id,
    mode: row.mode,
    modelAlias: row.model_alias,
    updatedAt: row.updated_at,
  }
}

function validateSelection(mode: WorkspaceDecisionRoutingMode, modelAlias: string | null): void {
  if (mode === 'llm_only') {
    if (modelAlias !== null) throw new Error('decision-routing: LLM-only mode cannot name a classifier')
    return
  }
  const row = modelAlias ? registryRow(modelAlias) : undefined
  if (!row || row.status !== 'active' || !isDecisionModelRow(row)) {
    throw new Error(`decision-routing: '${modelAlias ?? ''}' is not an active decision model`)
  }
}

export function createWorkspaceDecisionRoutingStore() {
  return {
    async get(params: {
      actingUserId: string
      workspaceId: string
    }): Promise<WorkspaceDecisionRouting | null> {
      const result = await queryWithRLS<DecisionRoutingRow>(
        params.actingUserId,
        `SELECT workspace_id, mode, model_alias, updated_at
           FROM workspace_decision_routing
          WHERE workspace_id = $1`,
        [params.workspaceId],
      )
      return result.rows[0] ? toSetting(result.rows[0]) : null
    },

    async getSystem(workspaceId: string): Promise<WorkspaceDecisionRouting | null> {
      const result = await query<DecisionRoutingRow>(
        `SELECT workspace_id, mode, model_alias, updated_at
           FROM workspace_decision_routing
          WHERE workspace_id = $1`,
        [workspaceId],
      )
      return result.rows[0] ? toSetting(result.rows[0]) : null
    },

    async set(params: {
      actingUserId: string
      workspaceId: string
      mode: WorkspaceDecisionRoutingMode
      modelAlias: string | null
    }): Promise<WorkspaceDecisionRouting> {
      validateSelection(params.mode, params.modelAlias)
      const result = await queryWithRLS<DecisionRoutingRow>(
        params.actingUserId,
        `INSERT INTO workspace_decision_routing
           (workspace_id, mode, model_alias, updated_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id)
         DO UPDATE SET mode = EXCLUDED.mode,
                       model_alias = EXCLUDED.model_alias,
                       updated_by_user_id = EXCLUDED.updated_by_user_id,
                       updated_at = now()
         RETURNING workspace_id, mode, model_alias, updated_at`,
        [params.workspaceId, params.mode, params.modelAlias, params.actingUserId],
      )
      const row = result.rows[0]
      if (!row) throw new Error('decision-routing: setting was not written')
      return toSetting(row)
    },
  }
}

export type WorkspaceDecisionRoutingStore = ReturnType<typeof createWorkspaceDecisionRoutingStore>
