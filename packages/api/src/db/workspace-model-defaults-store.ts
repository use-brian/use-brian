/**
 * Workspace per-class model defaults (migration 345).
 *
 * One row per (workspace, curated class) naming EITHER a curated same-class
 * registry alias (a billing-neutral pin) OR a saved metered profile (§4.4
 * "profiles pickable as overrides"). No row = follow the registry default.
 * Validation is loud: a curated pin must be an active, menu-flagged registry
 * row of exactly that class (the L7 gate in code — a metered or cross-class
 * alias can never become a curated default), and a profile must belong to
 * the workspace. Spec: docs/architecture/platform/model-registry.md.
 */
import { registryRow } from '@use-brian/shared/model-registry'
import { query } from './client.js'

export const DEFAULTABLE_CLASSES = ['standard-pro', 'max', 'research'] as const
export type DefaultableClass = (typeof DEFAULTABLE_CLASSES)[number]

export function isDefaultableClass(value: string): value is DefaultableClass {
  return (DEFAULTABLE_CLASSES as readonly string[]).includes(value)
}

export type WorkspaceModelDefault = {
  workspaceId: string
  modelClass: DefaultableClass
  modelAlias: string | null
  meteredProfileId: string | null
  updatedAt: string
}

type DefaultRow = {
  workspace_id: string
  model_class: DefaultableClass
  model_alias: string | null
  metered_profile_id: string | null
  updated_at: string
}

function toDefault(r: DefaultRow): WorkspaceModelDefault {
  return {
    workspaceId: r.workspace_id,
    modelClass: r.model_class,
    modelAlias: r.model_alias,
    meteredProfileId: r.metered_profile_id,
    updatedAt: r.updated_at,
  }
}

export function createWorkspaceModelDefaultsStore() {
  return {
    async list(workspaceId: string): Promise<WorkspaceModelDefault[]> {
      const res = await query<DefaultRow>(
        `SELECT * FROM workspace_model_defaults WHERE workspace_id = $1 ORDER BY model_class`,
        [workspaceId],
      )
      return res.rows.map(toDefault)
    },

    /** Set a class default to a curated same-class pin. Rejects loud when
     * the alias is not an active, menu-flagged row of exactly this class. */
    async setCurated(params: {
      workspaceId: string
      modelClass: DefaultableClass
      modelAlias: string
      updatedByUserId?: string | null
    }): Promise<WorkspaceModelDefault> {
      const row = registryRow(params.modelAlias)
      if (!row || row.status !== 'active' || !row.menu || row.class !== params.modelClass) {
        throw new Error(
          `model-default: '${params.modelAlias}' is not an active curated menu model of class '${params.modelClass}'`,
        )
      }
      const res = await query<DefaultRow>(
        `INSERT INTO workspace_model_defaults (workspace_id, model_class, model_alias, metered_profile_id, updated_by_user_id)
         VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (workspace_id, model_class)
         DO UPDATE SET model_alias = EXCLUDED.model_alias,
                       metered_profile_id = NULL,
                       updated_by_user_id = EXCLUDED.updated_by_user_id,
                       updated_at = now()
         RETURNING *`,
        [params.workspaceId, params.modelClass, row.alias, params.updatedByUserId ?? null],
      )
      return toDefault(res.rows[0]!)
    },

    /** Set a class default to a workspace metered profile. Rejects loud
     * when the profile does not belong to the workspace. */
    async setProfile(params: {
      workspaceId: string
      modelClass: DefaultableClass
      meteredProfileId: string
      updatedByUserId?: string | null
    }): Promise<WorkspaceModelDefault> {
      const profile = await query<{ id: string }>(
        `SELECT id FROM metered_model_profiles WHERE id = $1 AND workspace_id = $2`,
        [params.meteredProfileId, params.workspaceId],
      )
      if (!profile.rows[0]) {
        throw new Error(`model-default: profile '${params.meteredProfileId}' not found in workspace`)
      }
      const res = await query<DefaultRow>(
        `INSERT INTO workspace_model_defaults (workspace_id, model_class, model_alias, metered_profile_id, updated_by_user_id)
         VALUES ($1, $2, NULL, $3, $4)
         ON CONFLICT (workspace_id, model_class)
         DO UPDATE SET model_alias = NULL,
                       metered_profile_id = EXCLUDED.metered_profile_id,
                       updated_by_user_id = EXCLUDED.updated_by_user_id,
                       updated_at = now()
         RETURNING *`,
        [params.workspaceId, params.modelClass, params.meteredProfileId, params.updatedByUserId ?? null],
      )
      return toDefault(res.rows[0]!)
    },

    /** Clear a class default (back to the registry default). */
    async clear(workspaceId: string, modelClass: DefaultableClass): Promise<boolean> {
      const res = await query(
        `DELETE FROM workspace_model_defaults WHERE workspace_id = $1 AND model_class = $2`,
        [workspaceId, modelClass],
      )
      return (res.rowCount ?? 0) > 0
    },
  }
}

export type WorkspaceModelDefaultsStore = ReturnType<typeof createWorkspaceModelDefaultsStore>
